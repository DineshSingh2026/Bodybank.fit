/**
 * Care group messaging — contract test.
 * Run: node tests/group-chat.js       (no dependencies, no server, no DB)
 *
 * The failures worth catching here are the ones that are silent in a demo and
 * expensive in production:
 *
 *   1. ACCESS. A client reaching another client's care group is the single worst
 *      outcome this feature can produce — it is other people's health data. Also
 *      covered: a removed member keeps reading, and an archived group still
 *      accepts writes.
 *   2. ATTACHMENTS. /uploads is a PUBLIC static mount. If the chat's directory is
 *      not 404'd off it, or the download route stops checking membership, every
 *      lab scan in every group becomes readable by URL.
 *   3. DELETED CONTENT. A soft-deleted message must never serialise its body
 *      again — including through the reply-quote of some other message.
 *   4. READ CURSORS. last_read_seq must be monotonic, or a late poll resurrects
 *      read messages as unread forever.
 *   5. NAMING. The spec fixes the group name as `Client Name - 2.0`.
 *   6. REGRESSION. The pre-existing 1-to-1 chat still works. Its UI moved into the
 *      shared inbox, so the test now asserts the /api/threads calls are intact AND
 *      that the superseded markup left no dead ids behind.
 *   7. CACHE-BUSTING. A changed JS/CSS asset must carry a bumped ?v= or returning
 *      users are served the 7-day-cached old file and see none of this.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc = require('../services/groupChatService');
const {
  ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_AUDIO_BYTES, isAudioMime, parseRange
} = require('../routes/groupChat');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}
function eq(actual, expected, msg) {
  return assert(Object.is(actual, expected), `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }
function ok(msg) { console.log('  ok    ' + msg); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Minimal stand-in for the db helper trio. `rows` is a function that answers a
 * query by inspecting the SQL, so each test states only what it cares about.
 */
function fakeDb(handler) {
  const calls = [];
  const answer = (sql, params) => {
    calls.push({ sql, params });
    return handler(sql, params);
  };
  return {
    calls,
    run: async (sql, params) => answer(sql, params),
    queryAll: async (sql, params) => { const r = answer(sql, params); return Array.isArray(r) ? r : []; },
    queryOne: async (sql, params) => { const r = answer(sql, params); return Array.isArray(r) ? (r[0] || null) : (r || null); }
  };
}

/* ------------------------------------------------------------------ *
 * 1. Access control
 * ------------------------------------------------------------------ */
async function testAccess() {
  section('Access control — the client-isolation boundary');
  const before = failures.length;

  const GROUP = { id: 'g1', client_id: 'clientA', name: 'A - 2.0', archived: false, rev: 3 };
  // resolveAccess is ONE joined query: the group row plus m_* (the caller's
  // live membership), c_* (the client) and s_* (the caller). A non-member simply
  // gets m_id = null from the LEFT JOIN.
  const joined = (group, membership) => Object.assign({}, group, membership
    ? { m_id: membership.id, m_group_role: membership.group_role, m_muted: false, m_last_read_seq: 0 }
    : { m_id: null });

  // A member of the group.
  let db = fakeDb((sql) => {
    if (/FROM chat_groups/.test(sql)) return joined(GROUP, { id: 'm1', group_role: 'client' });
    return null;
  });
  let a = await svc.resolveAccess(db, 'g1', { id: 'clientA', role: 'user' });
  eq(db.calls.length, 1, 'the access check is a single database round trip');
  assert(/LEFT JOIN chat_group_members m[\s\S]*m\.user_id = \?[\s\S]*m\.removed_at IS NULL/.test(db.calls[0].sql),
    'the membership join is scoped to the caller and to live memberships');
  eq(db.calls[0].params[0], 'clientA', 'the membership join is bound to the CALLER, not to anything in the request');
  eq(a.membership && a.membership.group_role, 'client', 'the caller\'s care role comes back from the join');
  assert(a.ok === true, 'the group\'s own client is admitted');
  assert(a.canPost === true, 'a member of a live group can post');
  assert(a.canManage === false, 'a client cannot manage the group');

  // A DIFFERENT client — no membership row. This is the boundary that matters.
  db = fakeDb((sql) => {
    if (/FROM chat_groups/.test(sql)) return joined(GROUP, null);
    return null;
  });
  a = await svc.resolveAccess(db, 'g1', { id: 'clientB', role: 'user' });
  eq(a.ok, false, 'another client is REFUSED access to this care group');
  eq(a.canPost, false, 'another client cannot post into this care group');

  // A removed member: the row exists but removed_at is set, so the membership
  // query (which filters removed_at IS NULL) returns nothing.
  a = await svc.resolveAccess(db, 'g1', { id: 'exDoctor', role: 'operator' });
  eq(a.ok, false, 'a removed member loses access');
  assert(
    db.calls.some(c => /removed_at IS NULL/.test(c.sql)),
    'the membership lookup filters on removed_at IS NULL'
  );

  // An operator who is NOT in the group gets nothing either — the read-only
  // monitoring role does not imply access to every private care conversation.
  eq(a.ok, false, 'a non-member operator is refused');

  // Admin reaches any group without a membership row (platform management).
  a = await svc.resolveAccess(db, 'g1', { id: 'adm', role: 'admin' });
  assert(a.ok && a.isAdmin && a.canManage, 'admin can open and manage any group');
  a = await svc.resolveAccess(db, 'g1', { id: 'sa', role: 'superadmin' });
  assert(a.ok && a.canManage, 'superadmin can open and manage any group');

  // Archived groups are read-only for EVERYONE, admin included.
  const ARCHIVED = Object.assign({}, GROUP, { archived: true });
  db = fakeDb((sql) => {
    if (/FROM chat_groups/.test(sql)) return joined(ARCHIVED, { id: 'm1', group_role: 'client' });
    return null;
  });
  a = await svc.resolveAccess(db, 'g1', { id: 'clientA', role: 'user' });
  eq(a.canPost, false, 'an archived group refuses new messages from a member');
  a = await svc.resolveAccess(db, 'g1', { id: 'adm', role: 'admin' });
  eq(a.canPost, false, 'an archived group refuses new messages from an admin too');

  // A missing group resolves to "not ok" rather than throwing.
  db = fakeDb(() => null);
  a = await svc.resolveAccess(db, 'nope', { id: 'x', role: 'admin' });
  assert(a.ok === false && a.group === null, 'a missing group is a clean miss, not a crash');

  // The live poll does its access check inside pollState, in the same query
  // that answers "has anything changed?".
  db = fakeDb((sql) => /FROM chat_groups/.test(sql)
    ? { id: 'g1', archived: false, rev: 7, is_member: false, max_seq: 40, readers: [] } : null);
  let st = await svc.pollState(db, 'g1', { id: 'clientB', role: 'user' });
  eq(st.ok, false, 'the poll REFUSES another client');
  eq(db.calls.length, 1, 'the poll decision is a single query');
  eq(db.calls[0].params[0], 'clientB', 'the poll membership join is bound to the caller');
  st = await svc.pollState(db, 'g1', { id: 'adm', role: 'admin' });
  eq(st.ok, true, 'the poll admits an admin');
  db = fakeDb((sql) => /FROM chat_groups/.test(sql)
    ? { id: 'g1', archived: false, rev: 7, is_member: true, max_seq: 40,
        readers: '[{"userId":"u1","lastReadSeq":38}]' } : null);
  st = await svc.pollState(db, 'g1', { id: 'u1', role: 'user' });
  assert(st.ok && st.rev === 7 && st.maxSeq === 40, 'the poll reports rev and maxSeq for a member');
  assert(st.readers.length === 1 && st.readers[0].lastReadSeq === 38, 'read cursors survive a json-as-text driver');
  db = fakeDb(() => null);
  st = await svc.pollState(db, 'nope', { id: 'x', role: 'admin' });
  eq(st.found, false, 'polling a missing group is a clean miss');

  if (failures.length === before) ok('client isolation, removal, archive and admin scope all hold');
}

/* ------------------------------------------------------------------ *
 * 2. Attachment safety
 * ------------------------------------------------------------------ */
function testAttachments() {
  section('Attachments — the public /uploads mount');
  const before = failures.length;

  const server = read('server.js');

  assert(
    /^app\.use\('\/uploads\/group-chat',.*404/m.test(server),
    'uploads/group-chat is 404\'d OFF the public static mount'
  );
  // It must be blocked BEFORE the catch-all static mount, or the block never runs.
  // Anchor both at line start: server.js also *mentions* the static mount inside a
  // comment, and an indexOf on the bare text finds the comment first.
  const lines = server.split('\n');
  const blockAt = lines.findIndex(l => l.startsWith("app.use('/uploads/group-chat',"));
  const staticAt = lines.findIndex(l => l.startsWith("app.use('/uploads', express.static"));
  assert(blockAt > -1, 'the group-chat block statement exists at top level');
  assert(staticAt > -1, 'the /uploads static mount exists at top level');
  assert(blockAt > -1 && staticAt > -1 && blockAt < staticAt,
    `the group-chat block (line ${blockAt + 1}) is declared BEFORE express.static(/uploads) (line ${staticAt + 1})`);

  const router = read('routes/groupChat.js');
  assert(/router\.get\('\/attachments\/:attachmentId', attachmentAuth/.test(router),
    'the attachment download route is authenticated');
  // attachmentAuth accepts a scoped, attachment-id-bound token (for the plain
  // <img>/<audio>/<a> tags that render it, which cannot send an Authorization
  // header) but falls back to the normal session-token check for anyone else.
  assert(/return verifyToken\(req, res, next\);/.test(router),
    'attachment auth still falls back to a real session token');
  assert(/String\(scoped\.attachmentId\) === String\(req\.params\.attachmentId\)/.test(router),
    'a scoped token only unlocks the ONE attachment it was minted for');
  assert(/resolveAccess\(db, att\.group_id, req\.user\)/.test(router),
    'the attachment download checks membership of the OWNING group');

  // Route ordering: a literal path declared after /:id would be shadowed.
  const attachAt = router.indexOf("router.get('/attachments/:attachmentId'");
  const idAt = router.indexOf("router.get('/:id'");
  assert(attachAt > -1 && idAt > -1 && attachAt < idAt,
    '/attachments/:id is declared before /:id so Express does not shadow it');

  // Containment check against traversal.
  assert(/abs\.startsWith\(ATTACH_DIR \+ path\.sep\)/.test(router),
    'the resolved attachment path is confined to the attachments directory');

  // The stored extension comes from the allowlist, never the client filename.
  assert(/const stored = uuidv4\(\) \+ ext;/.test(router),
    'the stored filename is server-generated (uuid + allowlisted extension)');
  assert(!ALLOWED_ATTACHMENT_TYPES['text/html'] && !ALLOWED_ATTACHMENT_TYPES['image/svg+xml'],
    'HTML and SVG are NOT accepted (both can carry script)');
  assert(!!ALLOWED_ATTACHMENT_TYPES['image/jpeg'] && !!ALLOWED_ATTACHMENT_TYPES['application/pdf'],
    'photos and PDFs are accepted');
  eq(MAX_ATTACHMENT_BYTES, 12 * 1024 * 1024, 'the attachment cap is 12 MB');

  // Attachment URLs handed to the client must be API routes, not /uploads paths,
  // and must carry the scoped token attachmentAuth() checks above — otherwise
  // the <img>/<audio> tag that loads them has no way to authenticate at all.
  const service = read('services/groupChatService.js');
  assert(/const base = '\/api\/groups\/attachments\/' \+ r\.id/.test(service),
    'serialised attachments point at the authenticated API route, not /uploads');
  assert(/url: token \? base \+ '\?token=' \+ encodeURIComponent\(token\) : base/.test(service),
    'a signed, attachment-scoped token rides along in the url so the tag that loads it can authenticate');
  assert(!/\/uploads\/group-chat/.test(service),
    'the service never hands a raw /uploads path to the client');

  if (failures.length === before) ok('attachments are closed off from the public mount and gated on membership');
}

/* ------------------------------------------------------------------ *
 * 3. Deleted content never leaks
 * ------------------------------------------------------------------ */
function testDeleted() {
  section('Deleted messages');
  const before = failures.length;

  const row = {
    id: 'm1', seq: 5, group_id: 'g1', sender_id: 'u1', sender_group_role: 'doctor',
    kind: 'text', body: 'confidential lab value', created_at: new Date().toISOString(),
    deleted_at: new Date().toISOString(), reply_to_id: null,
    first_name: 'Dr', last_name: 'Sharma'
  };
  const out = svc.serializeMessage(row, { viewerId: 'u2' });
  eq(out.body, '', 'a deleted message serialises an EMPTY body');
  eq(out.deleted, true, 'a deleted message is flagged deleted');
  eq(out.kind, 'deleted', 'a deleted message reports kind "deleted"');
  assert(JSON.stringify(out).indexOf('confidential') === -1,
    'the deleted body appears NOWHERE in the serialised payload');

  // ...and not through a reply quote either.
  const child = {
    id: 'm2', seq: 6, group_id: 'g1', sender_id: 'u2', sender_group_role: 'client',
    kind: 'text', body: 'ok', created_at: new Date().toISOString(),
    deleted_at: null, reply_to_id: 'm1'
  };
  const quoted = svc.serializeMessage(child, { viewerId: 'u2', replies: { m1: row } });
  assert(quoted.replyTo && quoted.replyTo.body === 'This message was deleted',
    'a reply quoting a deleted message shows the tombstone');
  assert(JSON.stringify(quoted).indexOf('confidential') === -1,
    'the deleted body does not leak through the reply quote');

  // A reply whose parent is gone entirely still renders.
  const orphan = svc.serializeMessage(child, { viewerId: 'u2', replies: {} });
  assert(orphan.replyTo && /unavailable/i.test(orphan.replyTo.body),
    'a reply to a vanished message degrades to "Message unavailable"');

  // `mine` must be false for a system message (sender_id null), not accidentally
  // true by both sides being undefined/null.
  const sys = svc.serializeMessage(
    { id: 's1', seq: 1, group_id: 'g1', sender_id: null, kind: 'system', body: 'created', created_at: new Date().toISOString() },
    { viewerId: null }
  );
  eq(sys.mine, false, 'a system message is never "mine", even for an anonymous viewer');

  if (failures.length === before) ok('deleted bodies never leave the server, by any path');
}

/* ------------------------------------------------------------------ *
 * 4. Read cursor is monotonic
 * ------------------------------------------------------------------ */
async function testReadCursor() {
  section('Read receipts / unread counts');
  const before = failures.length;

  let seen = null;
  const db = fakeDb((sql, params) => { seen = { sql, params }; return null; });

  await svc.markRead(db, 'g1', 'u1', 12);
  assert(/last_read_seq < \?/.test(seen.sql),
    'markRead only moves the cursor FORWARD (guarded by last_read_seq < ?)');
  assert(/removed_at IS NULL/.test(seen.sql),
    'markRead does not resurrect a removed member\'s cursor');

  seen = null;
  await svc.markRead(db, 'g1', 'u1', -5);
  eq(seen, null, 'a negative seq is ignored rather than written');
  await svc.markRead(db, 'g1', 'u1', 'nonsense');
  eq(seen, null, 'a non-numeric seq is ignored rather than written');

  // The unread count in the list query must exclude your own messages, or your
  // own sends make your own inbox look unread.
  const service = read('services/groupChatService.js');
  assert(/cm\.sender_id IS DISTINCT FROM \?/.test(service),
    'unread excludes messages you sent yourself');
  assert(/cm\.deleted_at IS NULL/.test(service),
    'unread excludes deleted messages');
  assert(/isMember \? Number\(r\.unread_count \|\| 0\) : 0/.test(service),
    'a non-member admin reports 0 unread rather than the whole transcript');

  if (failures.length === before) ok('cursors are monotonic and unread maths excludes self/deleted');
}

/* ------------------------------------------------------------------ *
 * 5. Naming + role model
 * ------------------------------------------------------------------ */
function testNamingAndRoles() {
  section('Group naming and the care-role model');
  const before = failures.length;

  eq(svc.buildGroupName({ first_name: 'Mitul', last_name: 'Nadendla' }), 'Mitul Nadendla - 2.0',
    'the spec\'s example name is produced exactly');
  eq(svc.GROUP_NAME_SUFFIX, ' - 2.0', 'the suffix is exactly " - 2.0"');
  eq(svc.buildGroupName({ first_name: 'Priya', last_name: '', email: 'p@x.com' }), 'Priya - 2.0',
    'a client with no surname still gets a clean name');
  eq(svc.buildGroupName({ email: 'rohit@bodybank.fit' }), 'rohit - 2.0',
    'a client with no name at all falls back to the email local part');

  eq(svc.normalizeGroupRole('Lifestyle Manager'), 'lifestyle_manager', 'a human-typed role label normalises');
  eq(svc.normalizeGroupRole('lifestyle-manager'), 'lifestyle_manager', 'a hyphenated role normalises');
  eq(svc.normalizeGroupRole('DOCTOR'), 'doctor', 'role matching is case-insensitive');
  eq(svc.normalizeGroupRole('superadmin'), null, 'an unknown role is rejected, not coerced');
  eq(svc.normalizeGroupRole(''), null, 'an empty role is rejected');

  ['client', 'doctor', 'lifestyle_manager', 'operator'].forEach(r => {
    assert(svc.GROUP_ROLES.includes(r), `the ${r} care role exists`);
    assert(!!svc.GROUP_ROLE_LABELS[r], `the ${r} care role has a display label`);
  });

  // The whole point of the membership-label model: users.role is never written.
  const service = read('services/groupChatService.js');
  const router = read('routes/groupChat.js');
  assert(!/UPDATE users SET role/i.test(service + router),
    'the feature NEVER writes users.role — global access control is untouched');

  // Only the group's own client may hold the client slot.
  assert(/role === 'client' && uid !== String\(client\.id\)/.test(router),
    'group creation refuses to give the Client role to anyone but the client');
  assert(/role === 'client' && userId !== String\(group\.client_id\)/.test(router),
    'add-member refuses to give the Client role to anyone but the client');
  assert(/target === String\(group\.client_id\)\) return fail\(res, 400/.test(router),
    'the client cannot be removed from their own care group');

  if (failures.length === before) ok('naming matches the spec and care roles stay group-scoped');
}

/* ------------------------------------------------------------------ *
 * 6. Injection + reply-scoping in the router
 * ------------------------------------------------------------------ */
function testRouterHardening() {
  section('Router hardening');
  const before = failures.length;

  const router = read('routes/groupChat.js');
  const service = read('services/groupChatService.js');

  // Search must parameterise the needle, wildcards included.
  assert(/const needle = '%' \+ q\.replace/.test(router),
    'the search needle is built as a PARAMETER, not concatenated into SQL');
  assert(/ILIKE \? ESCAPE/.test(router),
    'search uses a bound placeholder with an ESCAPE clause');
  assert(/replace\(\/\[\\\\%_\]\/g/.test(router),
    'user-supplied % and _ are escaped so they cannot act as wildcards');

  // A reply must be scoped to the same group, or it quotes across groups.
  const replyGuards = router.match(/FROM chat_messages WHERE id = \? AND group_id = \?/g) || [];
  assert(replyGuards.length >= 2,
    'reply targets are looked up WITH the group id (text and attachment sends)');

  // Reactions are an allowlist.
  assert(/svc\.ALLOWED_REACTIONS\.includes\(emoji\)/.test(router),
    'only allowlisted reaction emoji are accepted');

  // Every /:id route runs through the access gate.
  const routeLines = router.split('\n').filter(l => /^\s*router\.(get|post|patch|delete)\('\/:id/.test(l));
  assert(routeLines.length > 0, 'there are /:id routes to check');
  // Two routes skip the withAccess middleware for speed, and each must prove its
  // access control another way:
  //   /:id/updates — pollState() checks membership in the same query and the
  //                  route 403s on !st.ok before reading anything.
  //   /:id/read    — the UPDATE is scoped to the caller's own live membership
  //                  row, so a non-member changes nothing.
  const OWN_CHECK = {
    "router.get('/:id/updates'": () => {
      const body = router.slice(router.indexOf("router.get('/:id/updates'"));
      const head = body.slice(0, body.indexOf('svc.loadMessages'));
      return /svc\.pollState\(db, req\.params\.id, req\.user\)/.test(head)
        && /if \(!st\.ok\) return fail\(res, 403/.test(head);
    },
    "router.post('/:id/read'": () => {
      const body = router.slice(router.indexOf("router.post('/:id/read'"));
      const mark = service.slice(service.indexOf('async function markRead'));
      return /svc\.markRead\(db, String\(req\.params\.id\), req\.user\.id,/.test(body.slice(0, 600))
        && /WHERE group_id = \? AND user_id = \? AND removed_at IS NULL/.test(mark.slice(0, 700));
    }
  };
  routeLines.forEach(l => {
    const key = Object.keys(OWN_CHECK).find(k => l.indexOf(k) > -1);
    if (key) {
      assert(/verifyToken/.test(l) && OWN_CHECK[key](),
        'a route that skips withAccess still enforces membership itself — ' + l.trim().slice(0, 60));
      return;
    }
    assert(/verifyToken, withAccess/.test(l),
      'every /:id route is gated by verifyToken + withAccess — ' + l.trim().slice(0, 80));
  });
  assert(Object.keys(OWN_CHECK).every(k => router.indexOf(k) > -1),
    'both self-checking routes are still present (keep this list honest)');

  // Management actions need the admin gate on top of membership.
  ['patch', 'members'].forEach(() => {});
  assert(/router\.patch\('\/:id', verifyToken, withAccess, requireManage/.test(router),
    'editing group metadata requires admin');
  assert(/router\.post\('\/:id\/members', verifyToken, withAccess, requireManage/.test(router),
    'adding a member requires admin');
  assert(/router\.get\('\/:id\/audit', verifyToken, withAccess, requireManage/.test(router),
    'the audit log requires admin');
  assert(/router\.get\('\/candidates', verifyToken, requireAdminOrSuperadmin/.test(router),
    'the member-picker directory is admin-only (it lists every account)');

  // Rate limits on the write paths.
  ['/:id/messages', '/:id/attachments'].forEach(p => {
    const re = new RegExp("router\\.post\\('" + p.replace(/[/:]/g, '\\$&') + "'[^\\n]*rateLimiter");
    assert(re.test(router), `${p} is rate limited`);
  });

  if (failures.length === before) ok('SQL is parameterised, replies are group-scoped, gates are on every route');
}

/* ------------------------------------------------------------------ *
 * 7. Front-end: XSS, the nav trap, and the 1-to-1 regression
 * ------------------------------------------------------------------ */
function testFrontend() {
  section('Front end');
  const before = failures.length;

  const js = read('public/js/group-chat.js');
  const css = read('public/css/group-chat.css');
  const html = read('public/index.html');
  const router = read('routes/groupChat.js');
  const service = read('services/groupChatService.js');

  // Message bodies are user input rendered into innerHTML — escaping is the
  // whole defence. richText() must escape FIRST and linkify after.
  const rich = js.slice(js.indexOf('function richText'), js.indexOf('function richText') + 400);
  assert(/var safe = esc\(s\);/.test(rich), 'richText escapes before linkifying');
  assert(rich.indexOf('esc(') < rich.indexOf('replace(/(https?'),
    'escaping happens BEFORE the linkify replace, not after');
  assert(/rel="noopener noreferrer"/.test(rich), 'linkified URLs carry rel=noopener');
  // Search highlighting also escapes before inserting <mark>.
  assert(/var safe = esc\(body\);[\s\S]{0,200}new RegExp/.test(js),
    'search highlighting escapes the body before marking matches');

  // index.html carries a global bare `nav{position:fixed}` rule that hijacks any
  // <nav> rendered anywhere. The rail must be a div[role=navigation].
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/<nav[\s>]/.test(jsCode), 'the client JS renders NO <nav> element (the global nav{} rule would hijack it)');
  assert(/role="navigation"/.test(js), 'the conversation rail is a div[role=navigation]');

  // Responsive contract.
  assert(/@media \(min-width:900px\)/.test(css), 'a desktop side-by-side breakpoint exists');
  assert(/grid-template-columns:minmax\(320px,400px\) minmax\(0,1fr\)/.test(css),
    'the desktop layout is list | chat');
  assert(/\.bbg-app\.has-info \.bbg-grid\{grid-template-columns:minmax\(300px,380px\) minmax\(0,1fr\) 360px\}/.test(css),
    'desktop adds the info column beside the chat when it is open');
  assert(/\.bbg-app\[data-view="chat"\] \.bbg-col--chat\{transform:none/.test(css),
    'on a phone the chat slides in over the list');
  assert(/@media \(max-width:420px\)/.test(css), 'a small-phone breakpoint exists');
  assert(/overflow-x:hidden/.test(css), 'the scroll containers suppress horizontal overflow');
  assert(/padding:6px 8px calc\(8px \+ var\(--bbg-bottom\)\)/.test(css), 'the composer respects the iOS home-indicator inset');
  assert(/visualViewport/.test(js) && /var h = Math\.round\(vv\.height\)/.test(js) && /r\.style\.height = h \+ 'px'/.test(js),
    'the surface follows the visual viewport, so the composer stays above the keyboard');

  // ── Full screen ──
  const z = Number((css.match(/\.bbg-app\{[\s\S]*?z-index:(\d+)/) || [])[1]);
  assert(z > 10019 && z < 10040,
    'the surface sits above the app nav (10010) and AI button (10019) but below app popups (10040) — got ' + z);
  assert(/document\.body\.appendChild\(r\)/.test(js), 'the surface is its own element on <body>, not a card in the dashboard');
  assert(/html\.bbg-lock,html\.bbg-lock body\{overflow:hidden!important\}/.test(css), 'the page behind cannot scroll');
  assert(/history\.pushState\(\{ bbg: level \}/.test(js) && /window\.addEventListener\('popstate', onPopState\)/.test(js),
    'browser / Android back walks info → chat → list → dashboard');
  assert(/NAV\.skip\+\+/.test(js), 'closing messaging unwinds its own history entries without reacting to them');

  // ── The unified inbox: ONE surface holding both kinds of conversation. ──
  assert(!/id="bbGroupChatHost"/.test(html) && !/id="bbAdminInboxHost"/.test(html),
    'the old embedded inbox hosts are gone');
  assert(/window\.BBGroupChat\.open\(\{ mode: 'member' \}\)/.test(html), 'the member Messages tab opens messaging');
  assert(/window\.BBGroupChat\.open\(\{ mode: 'admin' \}\)/.test(html), 'the admin Messages tab opens messaging');
  ["function switchTab(tab) {", "function switchUserTab(tab) {", "function switchToSection(section) {"].forEach(fn => {
    const at = html.indexOf(fn);
    assert(at > -1 && /bbCloseMessages\(\)/.test(html.slice(at, at + 400)),
      fn.replace(' {', '') + ' closes messaging when the app moves elsewhere');
  });
  assert(/function ensureRoot\(\)[\s\S]{0,120}if \(r\) return r;/.test(js),
    'the surface is built once and reused (rebuilt only after logout)');
  assert(/function logoutSuperadmin\(\) \{[\s\S]{0,200}BBGroupChat\.forget\(\)/.test(html),
    'superadmin logout wipes messaging too');
  assert(/bbg-launch/.test(html), 'each page keeps a way back in if messaging is closed');

  // ── Speed: opening anything must cost at most ONE round trip. ──
  assert(/api\('GET', '\/api\/groups\/inbox'\)/.test(js),
    'the conversation list is one request to /api/groups/inbox');
  assert(!/api\('GET', '\/api\/groups'\)[\s\S]{0,200}api\('GET', '\/api\/threads'\)/.test(js),
    'the list no longer fans out to two endpoints and merges them client-side');
  // The group open must NOT fetch messages separately — detail carries them.
  const openGroupBody = js.slice(js.indexOf('BBG.openGroup = async function'),
                                js.indexOf('function applyGroup('));
  assert(openGroupBody.indexOf('/messages?limit=') === -1,
    'opening a group does not make a second request for its messages');
  assert(/messages: page\.messages,/.test(router) && /hasMore: page\.hasMore,/.test(router),
    'the group detail response carries the first page of messages');
  assert(/const maxSeq = messages\.length \? Number\(messages\[messages\.length - 1\]\.seq\) : 0;/.test(service),
    'maxSeq is derived from the page instead of costing its own SELECT MAX');
  assert(/\[groupId, limit \+ 1\]/.test(service),
    '"is there more?" is answered by fetching limit+1 rows, not by a second query');
  assert(/LEFT JOIN LATERAL \([\s\S]*?json_agg[\s\S]*?chat_message_reactions/.test(service),
    'reactions arrive inside the page query, not as a separate round trip');
  assert(/LEFT JOIN chat_messages p ON p\.id = m\.reply_to_id AND p\.group_id = m\.group_id/.test(service),
    'reply previews arrive inside the page query and can only quote the same group');
  assert(/WITH ins AS \([\s\S]*?INSERT INTO chat_messages[\s\S]*?RETURNING id, seq, created_at[\s\S]*?upd AS \([\s\S]*?rev = COALESCE\(rev, 0\) \+ 1/.test(service),
    'a send is ONE statement that inserts, moves the clock and bumps the revision');
  assert(/unchanged: true/.test(router) && /clientRev === st\.rev && Number\.isFinite\(since\) && since >= st\.maxSeq/.test(router),
    'an idle poll is answered from the single pollState query');
  assert(/ADD COLUMN IF NOT EXISTS rev BIGINT/.test(service), 'groups carry a revision counter');
  ['bumpRev(db, group.id)'].forEach(n => {
    assert((router.match(/svc\.bumpRev\(db, group\.id\)/g) || []).length >= 3,
      'edits, deletes and reactions all bump the revision');
  });
  assert(/rev = COALESCE\(rev, 0\) \+ 1'\)/.test(router),
    'a metadata change (e.g. the avatar) bumps the revision too');
  const sendRoute = router.slice(router.indexOf("router.post('/:id/messages', verifyToken"),
                                 router.indexOf("router.post('/:id/attachments'"));
  assert(sendRoute.indexOf('res.status(201)') < sendRoute.indexOf('setImmediate('),
    'the sender gets a response before read-marking and push fan-out run');
  assert(sendRoute.indexOf('svc.loadMessages') === -1 && sendRoute.indexOf('groupMaxSeq') === -1,
    'a send does not read its own message back');
  assert(/function prefetch\(row\)/.test(js), 'conversations are prefetched into a cache');
  assert(/addEventListener\('pointerenter', warm\)/.test(js),
    'hovering a conversation row starts fetching it');
  assert(/BBG\.warm = function/.test(js), 'the inbox is warmed before Messages is opened');
  assert(/window\.BBGroupChat\.warm\(\)/.test(html), 'the dashboard triggers the warm-up');
  assert(/if \(!S\.cache\[row\.id\]\)/.test(js),
    'a cached conversation paints immediately instead of showing a spinner');
  assert(/hasAttachments \? attachmentsForMessages/.test(service),
    'a text-only page skips the attachments query');
  assert(/idx_thread_messages_thread_created/.test(service),
    'the 1-to-1 lateral is backed by a (thread_id, created_at) index');

  // ── Only ACTIVE conversations are listed. ──
  assert(/JOIN LATERAL/.test(service) && /listDirectThreads/.test(service),
    'the inbox pulls 1-to-1 threads through a LATERAL');
  const direct = service.slice(service.indexOf('async function listDirectThreads'),
                               service.indexOf('async function insertMessage'));
  assert(direct.indexOf('LEFT JOIN LATERAL') === -1 && direct.indexOf('JOIN LATERAL') > -1,
    'an INNER lateral drops threads with no messages, so empty clients never list');
  assert(/router\.get\('\/directory', verifyToken, requireAdminOrSuperadmin/.test(router),
    'admin searches for a client rather than being handed every client');
  assert(/q \? \[needle, needle, needle, needle, limit\] : \[limit\]/.test(router),
    'the client search is capped and fully parameterised');
  assert(/router\.post\('\/direct', verifyToken, requireAdminOrSuperadmin/.test(router),
    'admin can open a 1-to-1 with a searched client');
  assert(/BBG\.openNewMessage = function/.test(js), 'the compose flow exists in the client');
  assert(/id="bbgNewDmBtn"/.test(js), 'the header carries a "message a client" action');

  // ── Regression: the 1-to-1 chat is still fully functional, now rendered by
  //    the shared engine against the SAME untouched /api/threads endpoints. ──
  assert(/api\('GET', '\/api\/groups\/dm\/' \+ enc\(row\.threadId\)\)/.test(js),
    'a 1-to-1 opens one PAGE through /api/groups/dm, not the whole transcript');
  assert(/'\/api\/groups\/dm\/' \+ enc\(tid\) \+ '\/updates\?after='/.test(js),
    'a 1-to-1 poll asks only for messages after the newest one it has');
  assert(js.indexOf("'/api/threads/' + enc(row.threadId) + '/messages'") === -1
    && !/api\('GET', '\/api\/threads\//.test(js),
    'the client never re-downloads a full legacy transcript');
  assert(/api\('POST', '\/api\/threads', \{ first_message: temp\.body \}\)/.test(js),
    'a member with no thread yet still creates one on first send');
  assert(/message_threads/.test(read('server.js')), 'the legacy thread tables are untouched');
  assert(/api\('POST', '\/api\/threads\/' \+ enc\(conv\.threadId\) \+ '\/messages'/.test(js),
    'replies still POST to /api/threads/:id/messages (it owns push + email)');

  // The superseded 1-to-1 UI is gone — no dead ids or half-wired handlers left.
  ['id="userThreadMessages"', 'id="adminThreadsList"', 'id="adminThreadModal"',
   'loadUserMessagesSection', 'userSendThreadMessage', 'adminSendThreadReply',
   'loadAdminThreads'].forEach(dead => {
    assert(html.indexOf(dead) === -1, `the superseded 1-to-1 UI leaves no dead reference: ${dead}`);
  });
  // escapeHtml lived in that block and is used app-wide — it must survive.
  assert(/function escapeHtml\(s\)/.test(html), 'escapeHtml() survived the 1-to-1 UI removal');

  // ── A direct thread must not be offered features its table cannot store. ──
  assert(/if \(isDirect\(\)\) return;/.test(js), 'reactions are refused on a direct thread');
  assert(/direct \? '' : '<button type="button" class="bbg-ib" id="bbgAttachBtn"/.test(js),
    'the attachment button is absent in a direct chat (thread_messages has no attachments)');
  assert(/tickHtml\(isDirect\(\) \? false : readByAll\(m\)\)/.test(js),
    'a direct message shows delivered only — it has no read cursor to report');
  assert(/function directDot\(row\)/.test(js),
    'direct unread is a per-device dot, not an invented count');
  assert(/if \(mineWasLast\) return false;/.test(js),
    'your own last message never re-flags the row as unread');

  // ── Meetings is out of Messages, but NOT deleted. ──
  assert(/meetings: 'clients'/.test(html), 'Meetings now belongs to the Clients section');
  assert(!/meetings: 'messages'/.test(html), 'Meetings no longer maps into the Messages section');
  assert(/id="tab-meetings"/.test(html), 'the Meetings tab content still exists');
  assert(/function loadAdminMeetings\(\)/.test(html), 'the Meetings loader still exists');
  assert(/function adminScheduleCall\(\)/.test(html), 'scheduling a call still works');
  assert(/switchTab\('meetings'\)/.test(html), 'Meetings is still reachable');
  assert(/section === 'messages'\) \{ switchTab\('messages'\); return; \}/.test(html),
    'the Messages sidebar entry opens the inbox directly, with no card menu in between');

  // Contact messages and the WhatsApp queue are kept, demoted to drawers.
  assert(/id="messagesBody"/.test(html), 'contact messages are still rendered');
  assert(/id="adminWaDraftsList"/.test(html), 'the WhatsApp draft queue is still rendered');
  assert(/loadAdminMessages\(\); loadWaDrafts\(\);/.test(html), 'both still load with the tab');

  // ── Cache busting: a changed asset MUST carry a ?v=. ──
  [['css/group-chat.css', /group-chat\.css\?v=(\d+)/], ['js/group-chat.js', /group-chat\.js\?v=(\d+)/]]
    .forEach(([asset, re]) => {
      const m = html.match(re);
      assert(!!m, `${asset} is included with a ?v= cache-buster`);
    });

  // ── Optimistic send ──
  // The bubble must be on screen before any network call, and the input must be
  // cleared synchronously: that is also what stops a repeated Enter from
  // posting the same text twice (the second press finds an empty box).
  const doSend = js.slice(js.indexOf('  function doSend() {'), js.indexOf('  function retrySend('));
  assert(doSend.length > 0 && !/async function doSend/.test(js),
    'doSend() is synchronous — nothing is awaited before the bubble appears');
  assert(doSend.indexOf("input.value = '';") > -1
    && doSend.indexOf("input.value = '';") < doSend.indexOf('queueDeliver(temp)'),
    'the input is cleared before delivery is queued (no double-post on repeated Enter)');
  assert(doSend.indexOf('S.messages.push(temp)') > -1
    && doSend.indexOf('S.messages.push(temp)') < doSend.indexOf('queueDeliver(temp)'),
    'the optimistic bubble is rendered before delivery starts');
  assert(/S\.sendChain = S\.sendChain\.then\(go, go\)/.test(js),
    'sends are delivered in order, and one failure does not block the next');
  assert(/if \(S\.inflight > 0 && !force\) return;/.test(js),
    'polls stand down while a send or reaction is in flight (no duplicate bubbles)');
  assert(/if \(Number\(res\.rev\) === Number\(S\.rev\) \+ 1\)/.test(js),
    'cursors fast-forward only when our send was the only change (no skipped messages)');
  assert(/temp\.failed = true;/.test(js) && /data-retry=/.test(js),
    'a failed send stays on screen with a retry, instead of vanishing');
  assert(/setPreviewState\(ctx\.conv, temp\.body, true\)/.test(js),
    'a failed send does not leave the list preview claiming it was sent');
  assert(/function withPending\(list\)/.test(js),
    'a background refresh cannot wipe a message that is still sending');
  assert(/function localToggle\(list, emoji\)/.test(js) && /m\.reactions = before;/.test(js),
    'reactions flip instantly and roll back if the server refuses');

  // ── On-device store ──
  assert(/var STORE_PREFIX = 'bbg_v2_';/.test(js) && /function storeKey\(\) \{ return STORE_PREFIX \+ myId\(\); \}/.test(js),
    'the device store is keyed per account');
  assert(/var STORE_OLD = \['bbg_v1_'\];/.test(js), 'the previous store format is cleaned up, not left behind');
  assert(/filter\(function \(m\) \{ return !m\.pending && !m\.failed; \}\)/.test(js),
    'unconfirmed messages are never written to the device');
  assert(/STORE_MAX_CONVS = 15/.test(js) && /STORE_MAX_MSGS = 40/.test(js),
    'the device store is bounded');
  assert(/BBG\.forget = function/.test(js) && /lsDel\(STORE_PREFIX \+ uid\)/.test(js),
    'logout can wipe the device store');
  assert(/BBG\.forget = function[\s\S]{0,1200}if \(r\) r\.remove\(\);/.test(js),
    'logout removes the surface itself, so the next account starts from nothing');
  assert(/S\.conversations = \[\]; S\.cache = \{\};/.test(js),
    'logout also clears the in-memory engine, so the next account sees nothing of the last');
  ['function logoutAdmin() {', 'function logoutUser() {'].forEach(fn => {
    const at = html.indexOf(fn);
    // Up to the function's own `window.currentUser = null`, however far down it is.
    const head = html.slice(at, html.indexOf('window.currentUser = null', at) + 30);
    assert(at > -1 && /BBGroupChat\.forget\(\)/.test(head)
      && head.indexOf('BBGroupChat.forget()') < head.indexOf('window.currentUser = null'),
      fn.replace('function ', '').replace(' {', '') + ' wipes messages BEFORE the user id is cleared');
  });
  assert(/requestIdleCallback\(warmNow/.test(html), 'the inbox warms as soon as the browser is idle');

  if (failures.length === before) ok('escaping, the nav trap, responsiveness and the 1-to-1 chat all hold');
}

/* ------------------------------------------------------------------ *
 * 8. Schema + server wiring
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * 9. Automated campaign messages + paged 1-to-1 reads
 * ------------------------------------------------------------------ */
async function testAutomatedAndDm() {
  section('Automated messages and the paged 1-to-1 endpoints');
  const before = failures.length;
  const service = read('services/groupChatService.js');
  const router = read('routes/groupChat.js');
  const scheduler = read('services/campaignScheduler.js');
  const js = read('public/js/group-chat.js');

  // The flag, its index and the one-time classification of existing rows.
  assert(/ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT FALSE/.test(service),
    'thread_messages gains is_automated (default FALSE: anything typed is personal)');
  assert(/idx_thread_messages_personal[\s\S]*?WHERE is_automated = FALSE/.test(service),
    'personal messages have their own partial index');
  assert(/col_description[\s\S]*?AUTOMATED_BACKFILL_MARK/.test(service) && /COMMENT ON COLUMN thread_messages\.is_automated/.test(service),
    'existing rows are classified ONCE (the column comment records it)');
  assert(/SELECT btrim\(message\) FROM campaign_messages/.test(service) && /SELECT btrim\(message\) FROM campaign_send_log/.test(service),
    'backfill recognises known campaign and broadcast texts');
  assert(/HAVING COUNT\(DISTINCT thread_id\) >= 5/.test(service),
    'backfill also recognises a broadcast by its shape (same text, same minute, 5+ threads)');
  assert(/sender_role IN \('admin', 'superadmin'\)[\s\S]{0,200}btrim\(m\.body\)/.test(service),
    'backfill never flags a message a CLIENT sent');
  assert(/INSERT INTO thread_messages \(id, thread_id, sender_id, sender_role, body, is_automated\) VALUES \(\?, \?, \?, \?, \?, TRUE\)/.test(scheduler),
    'the campaign scheduler marks what it sends as automated');

  // The inbox filter: staff see personal threads only; members see everything.
  const list = service.slice(service.indexOf('async function listDirectThreads'), service.indexOf('const DM_CURSOR_SQL'));
  assert(/\$\{admin \? 'AND m\.is_automated = FALSE' : ''\}/.test(list),
    'the admin inbox lists only clients with a PERSONAL message; members still see their coach thread');

  // `automated` is staff-only on the wire.
  assert(/if \(staff\) out\.automated = !!r\.is_automated;/.test(service),
    'the automated flag is only ever sent to staff');
  assert(/automated: staff && !!m\.automated/.test(js),
    'the member UI never treats a message as automated, even if a flag appeared');

  // Cursor validation: only the exact text the server produces is accepted.
  eq(svc.dmCursor('2026-09-17T10:00:00.123456', 'x') && svc.dmCursor('2026-09-17T10:00:00.123456', 'x').ts,
    '2026-09-17T10:00:00.123456', 'a well-formed cursor is accepted');
  eq(svc.dmCursor("2026-09-17'; DROP TABLE users; --", 'x'), null, 'an injection attempt is rejected as a cursor');
  eq(svc.dmCursor('2026-09-17T10:00:00Z', 'x'), null, 'an ISO date (lossy, zone-shifted) is rejected as a cursor');
  eq(svc.dmCursor(null, null), null, 'a missing cursor is rejected');

  // resolveThread: the legacy rule, exactly — staff read any thread, anyone else only their own.
  let db = fakeDb((sql) => /FROM message_threads t/.test(sql) ? { id: 't1', user_id: 'clientA', first_name: 'A' } : null);
  let acc = await svc.resolveThread(db, 't1', { id: 'clientA', role: 'user' });
  assert(acc.ok && !acc.staff, 'a client reads their own thread');
  acc = await svc.resolveThread(db, 't1', { id: 'clientB', role: 'user' });
  eq(acc.ok, false, 'another client is REFUSED this thread');
  acc = await svc.resolveThread(db, 't1', { id: 'op1', role: 'operator' });
  eq(acc.ok, false, 'an operator is refused (the legacy rule admits admins only)');
  acc = await svc.resolveThread(db, 't1', { id: 'adm', role: 'admin' });
  assert(acc.ok && acc.staff, 'an admin reads any thread');
  db = fakeDb(() => null);
  acc = await svc.resolveThread(db, 'nope', { id: 'adm', role: 'admin' });
  eq(acc.found, false, 'a missing thread is a clean miss');

  // loadDmSince: the access rule is IN the query, bound to the caller.
  db = fakeDb(() => []);
  let rows = await svc.loadDmSince(db, 't1', { id: 'clientB', role: 'user' }, { ts: '2026-09-17T10:00:00.000000', id: 'm1' });
  eq(rows.length, 0, 'a poll returns nothing when nothing matches');
  const c = db.calls[0];
  assert(/AND \(t\.user_id = \? OR \?::boolean\)/.test(c.sql), 'the poll query itself enforces ownership');
  eq(c.params[1], 'clientB', 'the ownership check is bound to the CALLER');
  eq(c.params[2], false, 'a client is not granted the staff bypass');
  eq(c.params[3], '2026-09-17T10:00:00.000000', 'the cursor is a bound parameter');
  db = fakeDb(() => []);
  rows = await svc.loadDmSince(db, 't1', { id: 'clientB', role: 'user' }, { ts: 'garbage', id: 'x' });
  eq(db.calls.length, 0, 'a bad cursor never reaches the database');
  db = fakeDb(() => []);
  await svc.loadDmSince(db, 't1', { id: 'adm', role: 'superadmin' }, { ts: '2026-09-17T10:00:00.000000', id: '' });
  eq(db.calls[0].params[2], true, 'staff get the bypass');

  // loadDmPage: limit+1 paging, oldest-first, staff-only flag.
  db = fakeDb(() => [
    { id: 'c', thread_id: 't1', sender_role: 'admin', body: 'n3', is_automated: true, cur: '3' },
    { id: 'b', thread_id: 't1', sender_role: 'user', body: 'n2', is_automated: false, cur: '2' },
    { id: 'a', thread_id: 't1', sender_role: 'admin', body: 'n1', is_automated: true, cur: '1' }
  ]);
  let page = await svc.loadDmPage(db, 't1', { limit: 2, staff: false });
  assert(page.hasMore === true && page.messages.length === 2, 'fetching limit+1 reports hasMore');
  eq(page.messages.map(m => m.id).join(','), 'b,c', 'the page is the newest messages, oldest-first');
  assert(page.messages.every(m => !('automated' in m)), 'a member page carries no automated flag');
  eq(db.calls[0].params[db.calls[0].params.length - 1], 3, 'the query asks for limit + 1');
  page = await svc.loadDmPage(db, 't1', { limit: 2, staff: true });
  eq(page.messages[1].automated, true, 'a staff page carries the automated flag');

  // Routes.
  assert(/router\.get\('\/dm\/:threadId', verifyToken, async/.test(router)
    && /if \(!acc\.ok\) return fail\(res, 403/.test(router), 'the page route checks access before reading');
  assert(/router\.get\('\/dm\/:threadId\/updates', verifyToken, async/.test(router), 'the poll route is authenticated');
  const dmAt = router.indexOf("router.get('/dm/:threadId'");
  const idAt = router.indexOf("router.get('/:id'");
  assert(dmAt > -1 && dmAt < idAt, 'the /dm routes are declared before any /:id route');

  if (failures.length === before) ok('nudges are tagged and hidden from the admin inbox; 1-to-1 reads are paged and access-checked');
}

async function testSchema() {
  section('Schema and server wiring');
  const before = failures.length;

  const statements = [];
  const db = { run: async (sql) => { statements.push(sql); }, queryOne: async () => null, queryAll: async () => [] };
  const res = await svc.ensureGroupChatTables(db);
  eq(res.ok, true, 'ensureGroupChatTables reports success');

  const all = statements.join('\n');
  ['chat_groups', 'chat_group_members', 'chat_messages', 'chat_message_reactions',
   'chat_message_attachments', 'chat_group_audit'].forEach(t => {
    assert(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(all), `${t} is created`);
  });
  statements.filter(s => /CREATE TABLE/.test(s)).forEach(s => {
    assert(/IF NOT EXISTS/.test(s), 'every CREATE TABLE is idempotent');
  });

  assert(/seq BIGSERIAL/.test(all), 'messages carry a BIGSERIAL seq (ordering + cursor)');
  assert(/uq_chat_group_members[\s\S]*?ON chat_group_members\(group_id, user_id\)/.test(all),
    'one membership row per (group, user) is enforced by a unique index');
  assert(/uq_chat_reaction[\s\S]*?\(message_id, user_id, emoji\)/.test(all),
    'one reaction per (message, user, emoji) is enforced');
  assert(/idx_chat_messages_group_seq/.test(all), 'the transcript read path is indexed on (group_id, seq)');

  // A failing db must not throw into initDB.
  const bad = { run: async () => { throw new Error('boom'); }, queryOne: async () => null, queryAll: async () => [] };
  const r2 = await svc.ensureGroupChatTables(bad);
  eq(r2.ok, false, 'a broken database degrades to {ok:false} instead of crashing boot');

  const server = read('server.js');
  assert(/ensureGroupChatTables\(\{ run, queryOne, queryAll \}\)/.test(server),
    'server.js bootstraps the tables in initDB');
  assert(/app\.use\(\s*'\/api\/groups',/.test(server), 'the router is mounted at /api/groups');
  assert(/createGroupChatRouter\(\{[\s\S]{0,400}?verifyToken,/.test(server),
    'the router receives verifyToken');
  // The existing 1-to-1 tables must still be created.
  assert(/CREATE TABLE IF NOT EXISTS message_threads/.test(server), 'message_threads is still created');
  assert(/CREATE TABLE IF NOT EXISTS thread_messages/.test(server), 'thread_messages is still created');
  assert(/app\.get\('\/api\/threads'/.test(server), 'the 1-to-1 threads API is still mounted');

  if (failures.length === before) ok('schema is idempotent, indexed, and wired without disturbing the old chat');
}

/**
 * VOICE NOTES. The failures that matter here are all silent in a desk demo:
 * a missing Range reply plays fine in desktop Chrome and never plays at all on
 * an iPhone; a DOM <audio> element plays fine until the first poll re-renders
 * the thread under it; and a missing staff gate only shows up when a client
 * uploads one.
 */
function testVoiceNotes() {
  section('Voice notes');
  const before = failures.length;
  const router = read('routes/groupChat.js');
  const js = read('public/js/group-chat.js');
  const css = read('public/css/group-chat.css');
  const service = read('services/groupChatService.js');

  // ── Upload ──
  for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav']) {
    assert(!!ALLOWED_ATTACHMENT_TYPES[mime], `${mime} is an accepted attachment type`);
  }
  eq(MAX_AUDIO_BYTES, 10 * 1024 * 1024, 'the voice-note cap is 10 MB');
  assert(MAX_AUDIO_BYTES < MAX_ATTACHMENT_BYTES, 'the voice-note cap is tighter than the general one');
  assert(isAudioMime('audio/mpeg') && isAudioMime('video/mp4'), 'mp3 and the .mp4-wrapped voice memo count as audio');
  assert(!isAudioMime('image/jpeg') && !isAudioMime('application/pdf'), 'images and PDFs are not audio');
  assert(/kind = mime\.startsWith\('image\/'\) \? 'image' : \(isAudio \? 'audio' : 'file'\)/.test(router),
    "an audio upload is stored with kind 'audio'");

  // Staff-only: a client must not be able to post a voice note.
  assert(/isAudio && !isStaff/.test(router), 'a non-staff sender is refused a voice note');
  assert(/senderRole !== 'client'/.test(router), 'staff is decided by GROUP role, so a doctor/operator qualifies');
  assert(/isAudio && req\.file\.buffer\.length > MAX_AUDIO_BYTES/.test(router), 'the 10 MB audio cap is enforced');

  // ── Loader ──
  assert(/r\.kind === 'audio'/.test(service), "the attachment loader includes kind 'audio'");
  eq((service.match(/hasAttachments = rows\.some/g) || []).length, 2,
    'both message-loading paths gate attachment loading the same way');

  // ── Serving: Range is what makes iOS Safari play at all ──
  assert(/Accept-Ranges/.test(router), 'the download route advertises Accept-Ranges');
  assert(/res\.status\(206\)/.test(router) && /Content-Range/.test(router),
    'a ranged request is answered 206 with a Content-Range');
  assert(/fs\.createReadStream\(abs, \{ start: range\.start, end: range\.end \}\)/.test(router),
    'a 206 streams only the requested byte window');
  assert(/res\.status\(416\)/.test(router), 'an unsatisfiable range is answered 416');
  assert(/inline = mt\.startsWith\('image\/'\) \|\| audio/.test(router),
    'audio is served inline, not as a download');

  // parseRange is the whole correctness surface of seeking — exercise it directly.
  const R = (h, size) => JSON.stringify(parseRange(h, size));
  eq(R('bytes=0-1', 100), JSON.stringify({ start: 0, end: 1 }), 'the iOS probe range bytes=0-1 resolves');
  eq(R('bytes=50-', 100), JSON.stringify({ start: 50, end: 99 }), 'an open-ended range runs to EOF');
  eq(R('bytes=90-500', 100), JSON.stringify({ start: 90, end: 99 }), 'an over-long end is clamped to EOF');
  eq(R('bytes=-10', 100), JSON.stringify({ start: 90, end: 99 }), 'a suffix range means the LAST n bytes');
  eq(R('bytes=200-300', 100), '"invalid"', 'a range past EOF is unsatisfiable');
  eq(R('bytes=0-1,5-6', 100), 'null', 'a multi-range header falls back to the whole file');
  eq(R('', 100), 'null', 'no Range header means a normal 200');

  // ── UI ──
  assert(/function voiceNoteHtml/.test(js), 'the bubble has a dedicated voice-note renderer');
  // Matches an <audio> tag being BUILT into markup (inside a string literal),
  // not the prose in the comment that explains why there isn't one.
  assert(!/['"`]\s*<audio/.test(js),
    'NO <audio> element is rendered into the transcript (renderTranscript rebuilds innerHTML and would kill playback)');
  assert(/VN = \{ audio: null/.test(js), 'playback lives in one shared, detached Audio object');
  assert(/VN\.audio\.pause\(\)/.test(js), 'starting a different note stops the one already playing');
  assert(/VN_RATES = \[1, 1\.5, 2\]/.test(js), 'the speed toggle cycles 1x / 1.5x / 2x');
  assert(/bindVoiceNotes\(t\)/.test(js), 'the rows are re-bound after every render');
  assert(/onpointerdown/.test(js) && /vnSeekTo/.test(js), 'the progress bar is draggable to seek');
  assert(/vnTime\(cur\) \+ ' \/ ' \+ vnTime\(dur\)/.test(js), 'elapsed and total time are both shown');
  assert(/is-loading/.test(js) && /is-error/.test(js), 'the bubble has loading and error states');
  assert(/canSendVoice\(\)/.test(js), "the file picker only offers audio to staff");
  assert(/touch-action:none/.test(css), 'the seek bar claims the gesture so dragging does not scroll the thread');
  assert(/\.bbg-m\.out \.bbg-vn/.test(css), 'the outgoing bubble restyles the player for contrast');
  assert(/@media \(max-width:420px\)[\s\S]{0,400}\.bbg-vn\{/.test(css), 'the player has a narrow-screen rule');

  // ── Previews ──
  assert(/kind === 'audio' \? \(caption \|\| '🎤 Voice note'\)/.test(router),
    'the push preview shows the caption when there is one');
  assert(/last_kind === 'audio'\) preview = String\(r\.last_body \|\| ''\) \|\| '🎤 Voice note'/.test(service),
    'the inbox preview shows the caption when there is one');

  if (failures.length === before) ok('voice notes upload staff-only, serve ranged, and play without a DOM <audio>');
}

/* ------------------------------------------------------------------ */
(async function main() {
  console.log('BodyBank — care group messaging contract test');
  await testAccess();
  testAttachments();
  testVoiceNotes();
  testDeleted();
  await testReadCursor();
  testNamingAndRoles();
  testRouterHardening();
  testFrontend();
  await testAutomatedAndDm();
  await testSchema();

  console.log('\n--------------------------------------------------------------');
  if (failures.length) {
    console.log(`FAILED — ${failures.length} of ${checks} checks\n`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`PASSED  ${checks} checks — care group messaging`);
})();
