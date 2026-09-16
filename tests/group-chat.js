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
const { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } = require('../routes/groupChat');

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

  const GROUP = { id: 'g1', client_id: 'clientA', name: 'A - 2.0', archived: false };

  // A member of the group.
  let db = fakeDb((sql) => {
    if (/FROM chat_groups/.test(sql)) return GROUP;
    if (/FROM chat_group_members/.test(sql)) return { id: 'm1', group_id: 'g1', user_id: 'clientA', group_role: 'client' };
    return null;
  });
  let a = await svc.resolveAccess(db, 'g1', { id: 'clientA', role: 'user' });
  assert(a.ok === true, 'the group\'s own client is admitted');
  assert(a.canPost === true, 'a member of a live group can post');
  assert(a.canManage === false, 'a client cannot manage the group');

  // A DIFFERENT client — no membership row. This is the boundary that matters.
  db = fakeDb((sql) => {
    if (/FROM chat_groups/.test(sql)) return GROUP;
    if (/FROM chat_group_members/.test(sql)) return null;
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
    if (/FROM chat_groups/.test(sql)) return ARCHIVED;
    if (/FROM chat_group_members/.test(sql)) return { id: 'm1', user_id: 'clientA', group_role: 'client' };
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
  assert(/router\.get\('\/attachments\/:attachmentId', verifyToken/.test(router),
    'the attachment download route is authenticated');
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

  // Attachment URLs handed to the client must be API routes, not /uploads paths.
  const service = read('services/groupChatService.js');
  assert(/url: '\/api\/groups\/attachments\/' \+ r\.id/.test(service),
    'serialised attachments point at the authenticated API route, not /uploads');
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
  routeLines.forEach(l => {
    assert(/verifyToken, withAccess/.test(l),
      'every /:id route is gated by verifyToken + withAccess — ' + l.trim().slice(0, 80));
  });

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
  assert(!/<nav[\s>]/.test(js), 'the client JS renders NO <nav> element (the global nav{} rule would hijack it)');
  assert(/role="navigation"/.test(js), 'the conversation rail is a div[role=navigation]');

  // Responsive contract.
  assert(/@media \(min-width:1024px\)/.test(css), 'a desktop three-panel breakpoint exists');
  assert(/grid-template-columns:300px minmax\(0,1fr\) 316px/.test(css),
    'the desktop layout is list | chat | details');
  assert(/@media \(max-width:420px\)/.test(css), 'a small-phone breakpoint exists');
  assert(/overflow-x:hidden/.test(css), 'the scroll containers suppress horizontal overflow');
  assert(/var\(--safe-bottom/.test(css), 'the composer respects the iOS home-indicator inset');

  // ── The unified inbox: ONE surface holding both kinds of conversation. ──
  assert(/id="bbGroupChatHost"/.test(html), 'the member inbox host exists');
  assert(/id="bbAdminInboxHost"/.test(html), 'the admin inbox host exists');
  assert(/bbMessagesEnter\(\)/.test(html), 'the member Messages tab mounts the inbox');
  assert(/mountAdminInbox\(\)/.test(html), 'the admin Messages tab mounts the inbox');
  assert(/function mountBbInbox\(hostId, mode\)/.test(html), 'both hosts mount through one helper');
  assert(/!host\.dataset\.mounted \|\| !host\.children\.length/.test(html),
    'an emptied host remounts rather than staying blank');

  // ── Regression: the 1-to-1 chat is still fully functional, now rendered by
  //    the shared engine against the SAME untouched /api/threads endpoints. ──
  assert(/\/api\/threads'\)/.test(js), 'the inbox lists 1-to-1 threads from /api/threads');
  assert(/'\/api\/threads\/' \+ encodeURIComponent\(row\.threadId\) \+ '\/messages'/.test(js),
    'the inbox reads 1-to-1 messages from /api/threads/:id/messages');
  assert(/api\('POST', '\/api\/threads', \{ first_message: body \}\)/.test(js),
    'a member with no thread yet still creates one on first send');
  assert(/'\/api\/threads\/' \+ encodeURIComponent\(S\.convId\) \+ '\/messages'/.test(js),
    'replies still POST to /api/threads/:id/messages');

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
  assert(/direct \? '' : '<button type="button" class="bbg-iconbtn" id="bbgAttachBtn"/.test(js),
    'the attachment button is absent in a direct chat (thread_messages has no attachments)');
  assert(/tickHtml\(isDirect\(\) \? false : readByAll\(m\)\)/.test(js),
    'a direct message shows delivered only — it has no read cursor to report');
  assert(/function directHasNew\(threadId, lastMessageAt\)/.test(js),
    'direct unread is a per-device dot, not an invented count');

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

  // Sending must be guarded by state, not by the disabled attribute — Enter on a
  // desktop keyboard bypasses the button entirely.
  assert(/async function doSend\(\)\s*\{\s*if \(S\.sending\) return;/.test(js),
    'doSend() guards on the sending flag, so Enter cannot double-post');

  if (failures.length === before) ok('escaping, the nav trap, responsiveness and the 1-to-1 chat all hold');
}

/* ------------------------------------------------------------------ *
 * 8. Schema + server wiring
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
(async function main() {
  console.log('BodyBank — care group messaging contract test');
  await testAccess();
  testAttachments();
  testDeleted();
  await testReadCursor();
  testNamingAndRoles();
  testRouterHardening();
  testFrontend();
  await testSchema();

  console.log('\n--------------------------------------------------------------');
  if (failures.length) {
    console.log(`FAILED — ${failures.length} of ${checks} checks\n`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`PASSED  ${checks} checks — care group messaging`);
})();
