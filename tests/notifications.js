/**
 * Notifications — every activity reaches the right people on web, Android and iOS.
 * Run: node tests/notifications.js
 *
 * No network, no Postgres. The hub runs against in-memory fakes; the WhatsApp
 * agent runs with a stub store; the server / front-end wiring is checked in
 * source, and the pieces that are pure functions are extracted and executed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let checks = 0;
const failures = [];
function assert(ok, msg) {
  checks += 1;
  if (ok) console.log('  ok    ' + msg);
  else { failures.push(msg); console.log('  FAIL  ' + msg); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

const hubMod = require('../services/notificationHub');

function fakeDeps(opts) {
  const o = opts || {};
  const inbox = [];
  const pushes = [];
  const queries = [];
  let n = 0;
  return {
    inbox, pushes, queries,
    deps: {
      uuidv4: () => 'id-' + (++n),
      run: async (sql, params) => {
        if (o.runFails) throw new Error('db down');
        inbox.push({ sql, params });
      },
      queryAll: async (sql, params) => {
        queries.push({ sql, params });
        if (o.queryFails) throw new Error('db down');
        return (o.staff || []).filter((u) => params.includes(u.role)).map((u) => ({ id: u.id }));
      },
      sendPushToUser: async (userId, payload) => {
        if (o.pushFails) throw new Error('push down');
        pushes.push({ userId, data: JSON.parse(payload) });
      }
    }
  };
}

async function testHub() {
  section('Hub: one call = bell entry + push to every device');
  {
    const f = fakeDeps();
    const hub = hubMod.createNotificationHub(f.deps);
    const r = await hub.toUser('u1', { title: 'Hello', body: 'World', type: 'x', link: 'wa' });
    assert(f.inbox.length === 1 && /INSERT INTO user_inbox/.test(f.inbox[0].sql), 'a notification is stored in the in-app bell');
    assert(f.inbox[0].params[5] === 'wa', 'the stored row keeps the screen link');
    assert(r.inboxId === 'id-1', 'the stored id is returned');
    const p = f.pushes[0];
    assert(p && p.userId === 'u1', 'the same notification is pushed to the person');
    assert(p.data.url === '/?open=wa' && p.data.link === 'wa', 'the push carries where tapping it should land');
    assert(p.data.id === 'inbox-id-1', 'the banner tag matches the bell id, so the bell and the banner are one item');
  }
  {
    const f = fakeDeps();
    const hub = hubMod.createNotificationHub(f.deps);
    await hub.toUser('u1', { title: 'Check-in', inbox: false, tag: 'daily-a@b.c', link: 'dailycheckin' });
    assert(f.inbox.length === 0, 'inbox:false pushes without storing (the bell already lists it)');
    assert(f.pushes[0].data.id === 'daily-a@b.c', 'a tag makes repeated banners replace each other');
  }
  {
    const f = fakeDeps();
    const hub = hubMod.createNotificationHub(f.deps);
    await hub.toUser('u1', { title: 'x', link: 'javascript:alert(1)' });
    assert(f.pushes[0].data.url === '/' && f.pushes[0].data.link === '', 'a malformed link is dropped, never forwarded');
    await hub.toUser('u1', { title: 'x', link: 'messages', url: '/?group=abc' });
    assert(f.pushes[1].data.url === '/?group=abc', 'an explicit in-app url (a group) wins over the link');
    await hub.toUser('u1', { title: 'x', url: 'https://evil.example/' });
    assert(f.pushes[2].data.url === '/', 'an off-site url is never used');
    await hub.toUser('', { title: 'nobody' });
    assert(f.pushes.length === 3, 'no user id → nothing is sent');
  }
  {
    const f = fakeDeps({ staff: [
      { id: 'a1', role: 'admin' }, { id: 's1', role: 'superadmin' }, { id: 'o1', role: 'operator' }, { id: 'o2', role: 'operator' }
    ] });
    const hub = hubMod.createNotificationHub(f.deps);
    const n = await hub.toStaff({ title: 'Staff' });
    assert(n === 4 && f.pushes.length === 4, 'staff = admins, superadmins AND operators by default');
    assert(/role IN \(\?, \?, \?\)/.test(f.queries[0].sql), 'the staff lookup is parameterised');
    f.pushes.length = 0;
    await hub.toStaff({ title: 'Admins' }, { roles: ['admin', 'superadmin'], exclude: 'a1' });
    assert(f.pushes.map((p) => p.userId).join() === 's1', 'roles narrow the audience and the actor is left out');
    f.pushes.length = 0;
    await hub.toStaff({ title: 'bad' }, { roles: ['user'] });
    assert(f.pushes.length === 0, 'a non-staff role can never be targeted through toStaff');
  }
  {
    const f = fakeDeps({ runFails: true, pushFails: true });
    const hub = hubMod.createNotificationHub(f.deps);
    let threw = false;
    try { await hub.toUser('u1', { title: 'x' }); } catch (_) { threw = true; }
    assert(!threw, 'a database or push outage never throws into the request');
    const g = fakeDeps({ queryFails: true });
    const hub2 = hubMod.createNotificationHub(g.deps);
    assert((await hub2.toStaff({ title: 'x' })) === 0, 'a failed staff lookup resolves to 0');
  }
}

function testEventMapping() {
  section('Staff alerts (admin WhatsApp) also reach staff devices');
  const m = hubMod.staffPushForEvent;
  const draft = m('WA_INBOUND_DRAFT', { name: 'Ada Member', phone: '+919876543210', inbound: 'Knee hurts', trigger: 'client_replied' });
  assert(draft && /WhatsApp from Ada Member/.test(draft.title) && /Knee hurts/.test(draft.body), 'a client WhatsApp reply notifies staff with the message');
  assert(draft.link === 'wa' && draft.inbox !== false, 'it opens WhatsApp drafts and stays in the bell');
  const pro = m('WA_INBOUND_DRAFT', { name: 'Ada', phone: '1', trigger: 'no_activity_3d', draft: 'Hey Ada' });
  assert(/Kling drafted a message to Ada/.test(pro.title) && /Hey Ada/.test(pro.body), 'a proactive Grok draft is announced with its text');
  const sent = m('WA_DRAFT_SENT', { name: 'Ada', phone: '1', body: 'Keep going!', draft_id: 'd1' });
  assert(/Kling messaged Ada on WhatsApp/.test(sent.title) && sent.body === 'Keep going!', 'every message the bot sends to a client is announced with its text');
  assert(/needs you/.test(m('WA_INBOUND_HANDOFF', { name: 'Ada', reason: 'medical' }).title), 'a handoff is announced');
  assert(/unknown number/.test(m('WA_UNMATCHED', { phone: '+1', inbound: 'hi' }).title), 'an unknown number is announced');
  assert(m('SUNDAY_CHECKIN', { name: 'Ada' }).link === 'sundaycheckin', 'Sunday check-ins notify staff');
  const daily = m('DAILY_CHECKIN', { name: 'Ada', email: 'a@x', steps: 9000, water: '', protein: 120, sleep: 7 });
  assert(daily.inbox === false && /Steps 9000/.test(daily.body) && !/Water/.test(daily.body), 'daily check-ins push (bell already lists them) and skip empty fields');
  assert(m('WORKOUT_LOGGED', { name: 'A' }).link === 'workouts', 'workouts notify staff');
  assert(m('NUTRITION_MEAL_LOGGED', { name: 'A' }).link === 'nutrition', 'meals notify staff');
  assert(m('REPORT_SENT', { name: 'A', type: 'weekly', channels: ['email'] }).link === 'reports', 'report deliveries notify staff');
  assert(m('USER_DELETED', { name: 'some-id', email: 'x' }) === null, 'an admin deleting an account is not re-announced');
  const self = m('USER_DELETED', { name: 'self-deleted', email: 'x@y' });
  assert(self && self.roles.join() === 'admin,superadmin', 'a member deleting their own account alerts admins');
  assert(m('USER_MEMBERSHIP_ACTIVATED', { name: 'A', plan: '12-week' }).body === '12-week plan is now active.', 'membership activations notify staff');
  ['TRIAL_STARTED', 'AUDIT_FORM', 'PART2_FORM', 'CONTACT_MESSAGE', 'BLOOD_REPORT_UPLOADED', 'SMART_SCALE_UPLOADED',
    'MEETING_SCHEDULED', 'MEMBERSHIP_DIGEST', 'USER_LOGIN', 'SERVER_ERROR', 'PASSWORD_RESET_REQUEST', 'REPORT_GENERATED']
    .forEach((ev) => assert(m(ev, { name: 'A' }) === null, ev + ' is not pushed twice (its route pushes, or it is not staff-facing)'));
  assert(m('NOT_AN_EVENT', {}) === null, 'unknown events push nothing');
}

async function testNotifySink() {
  section('utils/notify.js hands every staff event to the push sink');
  delete process.env.TWILIO_SID; delete process.env.TWILIO_AUTH;
  const n = require('../utils/notify');
  const seen = [];
  n.addEventSink((ev, p) => { seen.push({ ev, p }); });
  n.addEventSink(() => { throw new Error('sink boom'); });
  const r = await n.notify('WA_DRAFT_SENT', { name: 'Ada', phone: '1', body: 'hi' }, { noDedup: true });
  assert(seen.length === 1 && seen[0].ev === 'WA_DRAFT_SENT', 'the sink sees the event even though WhatsApp is not configured');
  assert(r && r.ok === false, 'the WhatsApp result is still returned unchanged');
  await n.notify('DAILY_CHECKIN', { email: 'dup@x' });
  await n.notify('DAILY_CHECKIN', { email: 'dup@x' });
  assert(seen.filter((s) => s.ev === 'DAILY_CHECKIN').length === 1, 'dedup applies to pushes too (no double banner)');
  const before = seen.length;
  const miss = await n.notify('SOME_UNFORMATTED_EVENT', { email: 'z' });
  assert(seen.length === before + 1 && miss.reason === 'missing_formatter', 'an event without a WhatsApp formatter still reaches the sink');
  assert(typeof n.FORMATTERS.USER_MEMBERSHIP_ACTIVATED === 'function', 'USER_MEMBERSHIP_ACTIVATED has a formatter (it was silently dropped)');
}

async function testWhatsAppAgent() {
  section('WhatsApp agent (Grok): sends are announced, a failed send does not crash');
  const wa = require('../services/waInbound');
  const client = { id: 'user-1', first_name: 'Ada', last_name: 'Member', email: 'ada@example.com', phone: '+919876543210', role: 'user' };
  function store(draft) {
    return {
      async getDraftById() { return draft; },
      async getDraftByToken() { return draft; },
      async updateDraft(id, f) { Object.assign(draft, f); },
      async insertMessage(r) { return r; },
      async findUsersByPhone() { return [client]; }
    };
  }
  const staff = [];
  const draft = { id: 'd1', client_id: 'user-1', phone: '+919876543210', draft_body: 'Easy walk today 🌿', status: 'pending', trigger: 'client_replied', send_at: null };
  const svc = wa.createWaInbound({
    store: store(draft),
    notify: async (event, payload) => { staff.push({ event, payload }); return { ok: true }; },
    sendWhatsApp: async () => ({ ok: true, sid: 'SM1' }),
    now: () => new Date('2026-09-03T06:00:00.000Z'),
    config: { inboundEnabled: true }
  });
  const res = await svc.approveDraft('d1', { reviewedBy: 'admin' });
  const ev = staff.find((s) => s.event === 'WA_DRAFT_SENT');
  assert(res.ok && res.sent, 'an approved draft is sent');
  assert(ev && ev.payload.name === 'Ada Member' && ev.payload.body === 'Easy walk today 🌿', 'the sent alert names the client and carries the text');

  const d2 = { id: 'd2', client_id: 'user-1', phone: '+919876543210', draft_body: 'x', status: 'pending', send_at: null };
  const svc2 = wa.createWaInbound({
    store: store(d2),
    notify: async () => ({ ok: true }),
    sendWhatsApp: async () => ({ ok: false, reason: 'twilio_down' }),
    now: () => new Date('2026-09-03T06:00:00.000Z'),
    config: { inboundEnabled: true }
  });
  let out; let threw = null;
  try { out = await svc2.approveDraft('d2', {}); } catch (e) { threw = e; }
  assert(!threw, 'a failed WhatsApp send returns instead of throwing (it referenced an undefined `send`) — ' + (threw && threw.message));
  assert(out && out.ok === false && out.reason === 'twilio_down', 'the failure reason is reported');
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function testServerWiring() {
  section('Server delivery');
  const s = read('server.js');
  const staffFn = extractFn(s, 'sendPushToAdmins');
  assert(staffFn && !/VAPID/.test(staffFn), 'staff push no longer stops when VAPID is missing (that silenced the apps too)');
  assert(/Promise\.all/.test(staffFn), 'staff are pushed in parallel, not one after another');

  const fcmSrc = extractFn(s, 'fcmMessage');
  const fcmMessage = new Function(fcmSrc + '; return fcmMessage;')();
  const msg = fcmMessage('tok', 'T', 'B', { id: 'chat-1', type: 'chat', url: '/?open=messages', link: 'messages' });
  assert(msg.apns && msg.apns.payload.aps.sound === 'default', 'iOS gets an APNs block with sound (it had none)');
  assert(msg.apns.headers['apns-priority'] === '10' && msg.apns.headers['apns-push-type'] === 'alert', 'iOS alerts are sent at high priority');
  assert(msg.apns.headers['apns-collapse-id'] === 'chat-1' && msg.android.notification.tag === 'chat-1', 'repeat banners collapse on both platforms');
  assert(msg.data.url === '/?open=messages' && msg.data.link === 'messages', 'the tap destination travels in the data payload');
  assert(msg.android.priority === 'high', 'Android stays high priority');
  const bare = fcmMessage('tok', 'T', 'B', {});
  assert(!('apns-collapse-id' in bare.apns.headers) && !bare.android.notification.tag, 'no tag → no collapse');
  const fcmSend = extractFn(s, 'sendFcmToUser');
  assert(!/'messaging\/invalid-argument'/.test(fcmSend), 'a payload error no longer deletes a good device token');

  const linkSrc = extractFn(s, 'withPushLink');
  const tableSrc = s.slice(s.indexOf('const PUSH_TYPE_LINK'), s.indexOf('};', s.indexOf('const PUSH_TYPE_LINK')) + 2);
  const withPushLink = new Function(tableSrc + linkSrc + '; return withPushLink;')();
  assert(JSON.parse(withPushLink(JSON.stringify({ type: 'coach_reply' }))).url === '/?open=messages', 'older pushes get a destination from their type');
  assert(JSON.parse(withPushLink({ type: 'program_assigned' })).link === 'programs', 'program pushes open Programs');
  assert(JSON.parse(withPushLink({ url: '/?group=g' })).url === '/?group=g', 'an explicit url is kept');
  assert(withPushLink('not json') === 'not json', 'a non-JSON payload passes through');
  assert(/async function sendPushToUser\(userId, rawPayload\) \{\s*const payload = withPushLink\(rawPayload\);/.test(s), 'every push goes through the destination fallback');
  assert(/urgency: 'high'/.test(s), 'web push is sent with high urgency');

  section('Server wiring');
  assert(/addEventSink\(\(eventType, payload\) => \{[\s\S]{0,200}staffPushForEvent/.test(s), 'staff WhatsApp alerts are mirrored to staff devices');
  assert(/ensureNotificationColumns\(pool\)/.test(s), 'user_inbox gains its link column at boot');
  assert(/app\.get\('\/api\/push\/status', verifyToken/.test(s) && /app\.post\('\/api\/push\/test', verifyToken, rateLimiter/.test(s), 'status and test endpoints exist, signed-in and rate limited');
  const bell = s.slice(s.indexOf("app.get('/api/notifications'"), s.indexOf("app.delete('/api/inbox/:id'"));
  const staffPart = bell.slice(0, bell.indexOf("const thread = await queryOne('SELECT id FROM message_threads WHERE user_id = ?"));
  assert(/FROM user_inbox/.test(staffPart), 'the staff bell lists stored staff notifications');
  assert((bell.match(/link: m\.link/g) || []).length === 2, 'both bells use the stored link');
  assert((s.match(/DELETE FROM device_push_tokens WHERE user_id = \?', \[id\]/g) || []).length === 2, 'deleted accounts lose their phone tokens (admin delete + self delete)');
  assert((s.match(/^\s*pushFirstMessage\(msgId\);/gm) || []).length === 2, "a client's first message now notifies staff (both paths)");
  assert(/title: '💬 ' \+ userName[\s\S]{0,200}roles: \['admin', 'superadmin'\]/.test(s), '1-to-1 client messages go to admins, who can open them');
  assert(/'🔔 Operator escalation: '[\s\S]{0,200}roles: \['admin', 'superadmin'\]/.test(s), 'escalations go to admins, not to every operator');
  assert(/notifyHub\.user\(esc\.operator_id/.test(s), "an admin's reply is stored in the operator's bell and pushed");
  assert(/Operator messaged/.test(s), "admins hear when an operator messages a client");
  assert(/Consultation booked/.test(s) && /cancelled a call/.test(s) && /Consultation rescheduled/.test(s), 'meeting bookings, moves and cancellations notify the other side');
  assert(/Your trial is active/.test(s) && /Your account is active again/.test(s), 'trial and reactivation reach the member');
  assert(/sendPushToAdmins\(JSON\.stringify\(\{ title: '🔥 New trial started', body: `\$\{first_name \|\| ''\} \$\{last_name \|\| ''\} \(\$\{emailNorm\}\) started a \$\{trialDaysR\}/.test(s), 're-sign-up of a rejected account pushes staff too');
  assert(/sendPushToAdmins,\s*notifyHub\s*\}\)\s*\);\s*\/\/ Unauthenticated by design: a client opening a WhatsApp link/.test(s), 'blood router gets the hub');
  assert(/waStore: createPgStore\(\{ queryAll, queryOne, run, uuidv4 \}\),\s*notifyHub/.test(s), 'reports router gets the hub');
  assert(/sendPushToUser,\s*notifyAgent,\s*notifyHub/.test(s), 'group chat router gets the hub');
  assert(/startEmailScheduler\(\{ queryAll, notifyHub \}\)/.test(s), 'the reminder scheduler gets the hub');
  assert(/setNutritionPush\(\(userId, n\) => notifyHub\.toUser\(userId, n\)\)/.test(s), 'nutrition reports get the hub');

  section('Routes and services');
  const blood = read('routes/blood.js');
  assert((blood.match(/triggerBloodAnalysis\(db, /g) || []).length === 1 && (blood.match(/[^ ]\s*analyse\(reportId, b64, mime, (userId|targetUserId)\)\s*\./g) || []).length === 3, 'every blood analysis run reports its outcome to staff');
  assert(/Blood analysis ready/.test(blood) && /Blood analysis failed/.test(blood), 'staff hear when an analysis is ready or failed');
  assert((blood.match(/tellMember\((report|row)\.user_id/g) || []).length === 2, 'members hear when a blood report is sent to them');
  const nut = read('routes/nutrition.js');
  assert((nut.match(/^\s*pushMember\(/gm) || []).length === 3, 'daily and weekly nutrition reports reach member devices');
  const rs = read('services/reportService.js');
  assert(/d\.notifyHub\.toUser\(row\.user_id/.test(rs), 'members hear when a progress report is sent');
  assert(/notifyHub: d\.notifyHub/.test(read('routes/reports.js')), 'the reports router forwards the hub');
  const gc = read('routes/groupChat.js');
  assert(/Message reported in/.test(gc) && /exclude: req\.user\.id/.test(gc), 'a reported group message alerts admins (not the reporter)');
  assert(/link: 'messages',\s*url: '\/\?group=' \+ group\.id/.test(gc), 'group banners open the conversation');
  const es = read('services/emailScheduler.js');
  assert(/function startEmailScheduler\(\{ queryAll, notifyHub \}\)/.test(es), 'scheduler accepts the hub');
  assert(/if \(_hub\) \{\s*\/\/ Phone reminders still run\./.test(es), 'phone reminders run even without SMTP');
  assert(/Daily check-in waiting/.test(es) && /Sunday check-in is open/.test(es), 'check-in reminders reach member devices');
  assert(/stopped checking in/.test(es) && /link: 'clientprogress'/.test(es), 'staff get ONE inactivity alert per run');
  assert(!/^\s*userEmail\.email(DailyCheckinReminder|SundayReminderToday|InactiveAttention)\(/m.test(es), 'reminder emails are only sent when SMTP is configured');
}

function fakeDom(opts) {
  const els = {};
  const listeners = {};
  function el(id, open) {
    const classes = new Set(open ? ['open'] : []);
    return {
      id, open: false, children: [],
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      scrollIntoView() {}, remove() {}, querySelector() { return null; }, insertBefore() {}, addEventListener() {},
      setAttribute() {}
    };
  }
  (opts.ids || []).forEach((id) => { els[id] = el(id, (opts.open || []).includes(id)); });
  const calls = [];
  const win = {
    currentUser: opts.user,
    location: { search: opts.search || '', pathname: '/', hash: '', origin: 'https://www.bodybank.fit' },
    history: { state: null, replaceState(s, t, u) { calls.push(['replace', u]); } },
    navigator: { userAgent: 'test', serviceWorker: { addEventListener(t, fn) { listeners[t] = fn; } } },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => el('x'),
      head: { appendChild() {} }, body: { appendChild() {} },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
    },
    switchUserTab: (t) => calls.push(['user', t]),
    switchTab: (t) => calls.push(['tab', t]),
    switchToSection: (t) => calls.push(['section', t]),
    opNav: (t) => calls.push(['op', t]),
    openOperatorAlerts: () => calls.push(['alerts']),
    openAdminEscalations: () => calls.push(['esc']),
    loadWaDrafts: () => calls.push(['wadrafts']),
    BBGroupChat: { open: (o) => calls.push(['chat', o.mode, o.groupId || '']), close: () => calls.push(['chatclose']) },
    URL, URLSearchParams,
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    setInterval: (fn) => { fn(); return 1; }, clearInterval() {},
    console
  };
  win.window = win;
  win.self = win;
  return { win, calls, els, listeners };
}

function runNotify(env) {
  const src = read('public/js/bb-notify.js');
  const ctx = vm.createContext(env.win);
  vm.runInContext(src, ctx);
  return env.win.BBNotify;
}

function testFrontEnd() {
  section('Tapping a notification opens its screen');
  {
    const env = fakeDom({ user: { role: 'user' }, ids: ['userPanel', 'usec-checkin'], open: ['userPanel'] });
    const N = runNotify(env);
    N.route('checkin');
    N.route('memberships');
    N.route(null, '/?open=messages');
    assert(JSON.stringify(env.calls) === JSON.stringify([['user', 'checkin'], ['user', 'home'], ['user', 'messages']]),
      'member: known tab opens, unknown falls back to Home, url form works — ' + JSON.stringify(env.calls));
    env.calls.length = 0;
    N.route('messages', '/?group=g-1');
    assert(JSON.stringify(env.calls) === JSON.stringify([['user', 'messages'], ['chat', 'member', 'g-1']]), 'member: a group banner opens that group');
  }
  {
    const env = fakeDom({ user: { role: 'admin' }, ids: ['adminPanel', 'tab-sundaycheckin', 'bbAdminWaDrawer'], open: ['adminPanel'] });
    const N = runNotify(env);
    N.route('sundaycheckin');
    N.route('escalations');
    N.route('wa');
    N.route('clients');
    const got = JSON.stringify(env.calls);
    assert(got === JSON.stringify([['tab', 'sundaycheckin'], ['esc'], ['tab', 'messages'], ['chatclose'], ['wadrafts'], ['section', 'clients']]),
      'admin: tab, escalations, WhatsApp drafts drawer (chat closed over it), section — ' + got);
    assert(env.els.bbAdminWaDrawer.open === true, 'admin: the WhatsApp drafts drawer is expanded');
  }
  {
    const env = fakeDom({ user: { role: 'operator' }, ids: ['operatorPanel'], open: ['operatorPanel'] });
    const N = runNotify(env);
    N.route('inbox'); N.route('blood'); N.route('clientprogress'); N.route('tribe'); N.route('wa');
    assert(JSON.stringify(env.calls) === JSON.stringify([['op', 'inbox'], ['op', 'blood'], ['op', 'clients'], ['op', 'clients'], ['op', 'home'], ['alerts']]),
      'operator: staff links map to operator screens; others open the alerts list — ' + JSON.stringify(env.calls));
  }
  {
    const env = fakeDom({ user: { role: 'user' }, ids: ['userPanel'], open: [] });
    const N = runNotify(env);
    N.route('home');
    assert(env.calls.length === 0, 'nothing happens before the dashboard is open (it waits)');
    env.els.userPanel.classList.add('open');
    N.route('home');
    assert(env.calls.some((c) => c[0] === 'user' && c[1] === 'home'), 'and routes once it is');
  }
  {
    const env = fakeDom({ user: { role: 'user' }, ids: ['userPanel', 'usec-programs'], open: ['userPanel'], search: '?open=programs&x=1' });
    runNotify(env);
    assert(env.calls[0][0] === 'replace' && env.calls[0][1] === '/?x=1', 'the ?open= parameter is removed from the address bar');
    assert(env.calls.some((c) => c[0] === 'user' && c[1] === 'programs'), 'a page opened from a banner lands on its screen');
  }
  {
    const env = fakeDom({ user: { role: 'user' }, ids: ['userPanel'], open: ['userPanel'] });
    runNotify(env);
    env.listeners.message({ data: { type: 'bb-open', link: 'messages' } });
    assert(env.calls.some((c) => c[0] === 'user' && c[1] === 'messages'), 'an already-open tab is routed by the service worker message');
    const n = env.calls.length;
    env.listeners.message({ data: { type: 'other' } });
    assert(env.calls.length === n, 'other service worker messages are ignored');
  }
  {
    const env = fakeDom({ user: { role: 'user' }, ids: ['userPanel', 'usec-x'], open: ['userPanel'] });
    const N = runNotify(env);
    N.route('"><img src=x>');
    assert(env.calls.length === 1 && env.calls[0][1] === 'home', 'a hostile link is sanitised before use');
  }

  section('Service worker and page wiring');
  const sw = read('public/sw.js');
  assert(/postMessage\(\{ type: 'bb-open', link: data\.link \|\| '', url: url \}\)/.test(sw), 'an open tab is told where to go instead of being reloaded');
  assert(/c\.url\.indexOf\(origin\) === 0/.test(sw), 'only BodyBank tabs are reused');
  assert(/renotify: !!data\.id/.test(sw), 'a replaced banner still alerts');
  assert(/const CACHE_NAME = 'bodybank-v84'/.test(sw), 'service worker cache bumped so browsers take the new one');
  const html = read('public/index.html');
  assert(/<script src="js\/bb-notify\.js\?v=\d+"><\/script>/.test(html), 'bb-notify.js is loaded');
  assert(html.indexOf('js/bb-notify.js') > html.indexOf('js/group-chat.js'), 'it loads after the chat it routes into');
  assert(/startUserNotificationPolling\(\);\s*if \(window\.BBNotify\) window\.BBNotify\.ensure\(\);/.test(html), 'member dashboard turns notifications on');
  assert(/startAdminNotificationPolling\(\);\s*if \(typeof registerNativePush === 'function'\) registerNativePush\(\);\s*if \(window\.BBNotify\) window\.BBNotify\.ensure\(\);/.test(html), 'admin dashboard registers the phone on a fresh login too');
  assert(/function loadSuperadminDashboard\(\) \{\s*if \(typeof registerNativePush === 'function'\) registerNativePush\(\);\s*if \(window\.BBNotify\) window\.BBNotify\.ensure\(\);/.test(html), 'superadmin registers too');
  assert(/if \(window\.BBNotify\) \{ toggleNotifyPanel\(ev\); window\.BBNotify\.route\(link\); return; \}/.test(html), 'bell items route through the same place');
  const op = read('public/js/operator-console.js');
  assert(/registerNativePush\(\);\s*if \(window\.BBNotify\) window\.BBNotify\.ensure\(\);/.test(op), 'operator console turns notifications on');
  assert(/#opNotifyList \.admin-notify-item\[data-link\]/.test(op), 'operator alerts are tappable');
  assert(/if \(!window\.BBNotify\.operatorScreen\(link\)\) return;/.test(op) && /\}, true\);/.test(op), 'only alerts with an operator screen navigate (capture phase)');
  const bn = read('public/js/bb-notify.js');
  assert(/addListener\('notificationActionPerformed'/.test(bn) && /addListener\('notificationReceived'/.test(bn), 'native taps route, and foreground pushes show in-app');
  assert(/Notification\.permission === 'granted'\) \{\s*\/\/ Heals/.test(bn), 'a granted browser re-subscribes silently on every dashboard open');
  assert(/Add to Home Screen/.test(bn), 'iPhone Safari users are told how to get notifications');
  assert(!/requestPermission\(\)[^;]*;\s*\}\s*\n\s*function ensure/.test(bn) && /function turnOn\(\)/.test(bn), 'permission is only requested from a tap (Safari requirement)');
}

(async function main() {
  await testHub();
  testEventMapping();
  await testNotifySink();
  await testWhatsAppAgent();
  testServerWiring();
  testFrontEnd();
  console.log('\n--------------------------------------------------------------');
  if (failures.length) {
    console.log('FAILED — ' + failures.length + ' of ' + checks + ' checks');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('PASSED  ' + checks + ' checks — notifications');
})().catch((e) => { console.error(e); process.exit(1); });
