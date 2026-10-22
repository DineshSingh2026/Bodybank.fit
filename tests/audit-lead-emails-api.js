/**
 * API test: audit lead email sequence against a real PostgreSQL (DATABASE_URL).
 * Run: node tests/audit-lead-emails-api.js
 *
 * Mounts routes/auditLeadEmails.js in-process with the real auth middleware and DB.
 * Mail goes to a stub (nothing leaves the machine) and the clock is injected, so
 * "24 hours later" is one assignment. Every row it creates carries a random tag and
 * is deleted at the end. It refuses to run if the DB already has active sequences
 * that are not its own, so it can never send for real leads.
 *
 * Guards:
 *  - admin routes: 401 without a token, 403 for members and operators;
 *  - SMTP not configured → 503 and nothing queued;
 *  - dryRun writes nothing and returns the skip reasons and an Email 1 preview;
 *  - two leads with the same email in different case → one sequence; queueing again
 *    → "Already in sequence"; invalid, contacted, signed up and unsubscribed are skipped;
 *  - the job sends Email 1 once with the CC, reply-to and List-Unsubscribe headers;
 *    a second run sends nothing; +24h → Email 2; day 3 → Email 3 → completed;
 *  - a users row created mid-sequence stops it (stopped_signed_up, no Email 3);
 *  - moving the lead stage stops it (stopped_replied); "Mark replied" stops it;
 *  - GET / POST unsubscribe with a valid token stop it; a tampered token is 400;
 *  - one log row per email and step even when a sequence is rewound, and two
 *    instances running at the same moment never double send;
 *  - a failed send is retried once, then the sequence is failed;
 *  - quiet hours: queued at 22:00 IST → due 09:00 IST, and nothing sends at night;
 *  - daily cap and AUDIT_LEAD_EMAILS_ENABLED=false stop the job;
 *  - preview and test send work, and a test send to a non staff address is 403.
 */
'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const { verifyToken, requireAdminOrSuperadmin, signToken } = require('../middleware/auth');
const { ensureAuditLeadEmailSchema, createAuditLeadEmailSequence } = require('../services/auditLeadEmailSequence');
const { registerAuditLeadEmailRoutes } = require('../routes/auditLeadEmails');
const L = require('../services/auditLeadEmails');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const run = (sql, p = []) => pool.query(toPg(sql), p);
const queryAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
const queryOne = async (sql, p = []) => (await queryAll(sql, p))[0] || null;

const TAG = 'zzlead' + crypto.randomBytes(3).toString('hex');
const DOMAIN = '@test.bodybank.fit';
const mail = (k) => `${TAG}-${k}${DOMAIN}`;
const SECRET = 'api-test-unsub-secret';
const ENV = { SMTP_USER: 'team@test.bodybank.fit', EMAIL_UNSUB_SECRET: SECRET, LEAD_EMAIL_GAP_MS: '0', LEAD_EMAIL_BATCH_SIZE: '50', LEAD_EMAIL_DAILY_CAP: '400' };

// Clock: Monday 19 Oct 2026, 10:00 IST.
const IST = (d, h, m) => L.istDateAt(2026, 9, d, h, m || 0);
let clock = IST(19, 10);
const now = () => new Date(clock.getTime());
const HOUR = 3600000;

// Stub mailer: records every message; failNext(email, n) makes the next n sends to it fail.
const outbox = [];
const failPlan = new Map();
async function stubSend(msg) {
  const n = failPlan.get(msg.to) || 0;
  if (n > 0) { failPlan.set(msg.to, n - 1); return { ok: false, messageId: '', error: 'stub: 421 try again later' }; }
  outbox.push(msg);
  return { ok: true, messageId: '<' + crypto.randomUUID() + '@stub>', error: '' };
}
const sentTo = (email) => outbox.filter((m) => m.to === L.normEmail(email));

function makeEngine(env) {
  return createAuditLeadEmailSequence({
    queryAll, queryOne, run, sendMail: stubSend, isConfigured: () => true,
    env: Object.assign({}, ENV, env || {}), now, sleep: async () => {}, log: { log() {}, warn() {} }
  });
}

function makeApp(opts) {
  const o = opts || {};
  const engine = makeEngine(o.env);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerAuditLeadEmailRoutes(app, {
    verifyToken, requireAdminOrSuperadmin, rateLimiter: () => (req, res, next) => next(), queryAll,
    engine, isConfigured: () => o.configured !== false
  });
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, engine, base: 'http://127.0.0.1:' + s.address().port })); });
}

async function call(base, method, path, token, body, headers) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {}),
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: r.status, data, type: r.headers.get('content-type') || '' };
}

async function addLead(key, fields) {
  const id = TAG + '-' + key;
  const f = Object.assign({ first_name: 'test', email: mail(key), goals: '', stage: 'new_audit' }, fields || {});
  await run(`INSERT INTO audit_requests (id, first_name, last_name, email, goals, stage, created_at) VALUES (?,?,?,?,?,?,?)`,
    [id, f.first_name, 'Lead', f.email, f.goals, f.stage, f.created_at || new Date()]);
  return id;
}
const seqFor = (email) => queryOne('SELECT * FROM audit_lead_email_sequences WHERE email_norm = ?', [L.normEmail(email)]);
const logFor = (email) => queryAll('SELECT step, status, cc, attempts, error FROM audit_lead_email_log WHERE email_norm = ? ORDER BY step', [L.normEmail(email)]);

async function cleanup() {
  const like = TAG + '%';
  await run('DELETE FROM audit_lead_email_log WHERE email_norm LIKE ?', [like]);
  await run('DELETE FROM audit_lead_email_sequences WHERE email_norm LIKE ?', [like]);
  await run('DELETE FROM email_unsubscribes WHERE email_norm LIKE ?', [like]);
  await run('DELETE FROM audit_requests WHERE id LIKE ?', [like]);
  await run('DELETE FROM users WHERE id LIKE ?', [like]);
}

async function main() {
  await ensureAuditLeadEmailSchema(pool);
  const foreign = await queryOne("SELECT COUNT(*)::int AS n FROM audit_lead_email_sequences WHERE status = 'active' AND email_norm NOT LIKE 'zzlead%'");
  if (foreign && foreign.n > 0) {
    console.error(`audit-lead-emails-api: refusing to run, ${foreign.n} real active sequence(s) in this DB. Use a test DATABASE_URL.`);
    process.exit(2);
  }

  const tokAdmin = signToken({ id: TAG + '-admin', email: mail('admin'), role: 'admin' });
  const tokUser = signToken({ id: TAG + '-member', email: mail('member'), role: 'user' });
  const tokOp = signToken({ id: TAG + '-op', email: mail('op'), role: 'operator' });

  const A = await makeApp();
  const NOSMTP = await makeApp({ configured: false });
  const B = A.base;
  const servers = [A.server, NOSMTP.server];

  try {
    const idA1 = await addLead('a1', { first_name: 'priya sharma', email: mail('a'), goals: 'Fat loss & toning' });
    const idA2 = await addLead('a2', { first_name: 'Priya', email: '  ' + mail('a').toUpperCase() + ' ' });
    const idB = await addLead('b', { first_name: 'rahul', email: mail('b'), goals: 'Muscle gain' });
    const idBad = await addLead('bad', { email: 'not-an-email' });
    const idContacted = await addLead('contacted', { email: mail('contacted'), stage: 'contacted' });
    const idUser = await addLead('user', { email: mail('hasuser') });
    await run("INSERT INTO users (id, email, password, first_name, role, timezone) VALUES (?,?,?,?,?,'Asia/Kolkata')", [TAG + '-u1', mail('hasuser'), 'x', 'Has', 'user']);
    const idUnsub = await addLead('unsub', { email: mail('unsubbed') });
    await run('INSERT INTO email_unsubscribes (email_norm) VALUES (?)', [mail('unsubbed')]);

    // ── auth ────────────────────────────────────────────────────────────────
    let r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', null, { ids: [idA1] });
    eq(r.status, 401, 'queue: 401 without a token');
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokUser, { ids: [idA1] });
    eq(r.status, 403, 'queue: 403 for a member');
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokOp, { ids: [idA1] });
    eq(r.status, 403, 'queue: 403 for an operator');
    for (const [m, p] of [['GET', '/api/admin/audit-requests/email-sequence'], ['GET', '/api/admin/audit-requests/email-preview?id=' + idA1],
      ['POST', '/api/admin/audit-requests/email-test'], ['POST', '/api/admin/audit-requests/email-sequence/x/stop']]) {
      r = await call(B, m, p, tokUser, m === 'POST' ? {} : null);
      eq(r.status, 403, `${m} ${p}: 403 for a member`);
    }

    // ── SMTP not configured ─────────────────────────────────────────────────
    r = await call(NOSMTP.base, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [idA1] });
    eq(r.status, 503, 'no SMTP → 503');
    eq(r.data && r.data.error, 'Email is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)', 'no SMTP message');
    eq(await seqFor(mail('a')), null, 'no SMTP → nothing queued');

    // ── validation ──────────────────────────────────────────────────────────
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [] });
    eq(r.status, 400, 'empty ids → 400');
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: Array.from({ length: 201 }, (_, i) => 'x' + i) });
    eq(r.status, 400, '201 ids → 400');

    // ── dry run ─────────────────────────────────────────────────────────────
    const all = [idA1, idA2, idB, idBad, idContacted, idUser, idUnsub, TAG + '-missing'];
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: all, dryRun: true });
    eq(r.status, 200, 'dry run 200');
    eq(r.data.queued, 2, 'dry run would queue A and B');
    const reasons = Object.fromEntries((r.data.skipped || []).map((s) => [s.id, s.reason]));
    eq(reasons[idA2], 'Same email as another selected lead', 'same email, other case → skipped');
    eq(reasons[idBad], 'Invalid email', 'invalid email skipped');
    eq(reasons[idContacted], 'Already contacted (lead stage moved on)', 'contacted lead skipped');
    eq(reasons[idUser], 'Already signed up', 'signed up lead skipped');
    eq(reasons[idUnsub], 'Unsubscribed', 'unsubscribed lead skipped');
    eq(reasons[TAG + '-missing'], 'Lead not found', 'unknown id skipped');
    assert(r.data.preview && /Hi Priya, your audit is in\./.test(r.data.preview.html), 'dry run preview renders Email 1 for the first lead');
    eq(r.data.preview && r.data.preview.subject, 'Priya, your BodyBank audit is in. Here is what happens next', 'preview subject');
    eq(await seqFor(mail('a')), null, 'dry run wrote nothing');

    // ── queue for real ──────────────────────────────────────────────────────
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: all });
    eq(r.data.queued, 2, 'queued A and B');
    const seqCount = await queryOne('SELECT COUNT(*)::int AS n FROM audit_lead_email_sequences WHERE email_norm = ?', [mail('a')]);
    eq(seqCount.n, 1, 'one sequence for two rows with the same email');
    const sA = await seqFor(mail('a'));
    eq([sA.status, sA.next_step, sA.audit_request_id, sA.started_by], ['active', 1, idA1, mail('admin')], 'sequence row');
    eq(outbox.length, 0, 'the admin action itself sends nothing');
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [idA2, idB] });
    eq(r.data.queued, 0, 'second queue → nothing new');
    assert((r.data.skipped || []).every((s) => s.reason === 'Already in sequence'), 'second queue → Already in sequence');

    // ── job: Email 1 ────────────────────────────────────────────────────────
    let out = await A.engine.runDue();
    eq([out.ran, out.sent], [true, 2], 'run sends Email 1 to A and B');
    const a1 = sentTo(mail('a'));
    eq(a1.length, 1, 'A got exactly one email');
    const m1 = a1[0];
    eq(m1.subject, 'Priya, your BodyBank audit is in. Here is what happens next', 'Email 1 subject');
    eq(m1.cc, 'bodybank.fit369@gmail.com', 'Email 1 CC');
    eq(m1.replyTo, 'team@test.bodybank.fit', 'reply-to defaults to SMTP_USER');
    assert(/fat loss &amp; toning/.test(m1.html), 'Email 1 uses the goal');
    const unsubUrl = L.unsubUrl(mail('a'), L.configFromEnv(ENV));
    eq(m1.headers && m1.headers['List-Unsubscribe'], `<${unsubUrl}>, <mailto:team@test.bodybank.fit?subject=unsubscribe>`, 'List-Unsubscribe header');
    eq(m1.headers && m1.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', 'List-Unsubscribe-Post header');
    assert(m1.html.includes(unsubUrl) && m1.text.includes(unsubUrl), 'unsubscribe link in body');
    eq(await logFor(mail('a')), [{ step: 1, status: 'sent', cc: 'bodybank.fit369@gmail.com', attempts: 1, error: '' }], 'A log: Email 1 sent once with the CC');
    let sA1 = await seqFor(mail('a'));
    eq([sA1.next_step, new Date(sA1.next_send_at).toISOString()], [2, IST(20, 10).toISOString()], 'Email 2 due 24h later');

    out = await A.engine.runDue();
    eq(out.claimed, 0, 'second run at the same time sends nothing');
    clock = IST(20, 9, 59);
    out = await A.engine.runDue();
    eq(out.claimed, 0, 'one minute early → nothing');

    // ── rewind: the log still blocks a resend ───────────────────────────────
    await run('UPDATE audit_lead_email_sequences SET next_step = 1, next_send_at = ? WHERE email_norm = ?', [now(), mail('b')]);
    out = await A.engine.runDue();
    eq(sentTo(mail('b')).length, 1, 'rewound sequence: Email 1 not sent again');
    eq((await seqFor(mail('b'))).next_step, 2, 'rewound sequence moves on to step 2');

    // ── +24h: Email 2 ───────────────────────────────────────────────────────
    clock = IST(20, 10, 1);
    out = await A.engine.runDue();
    eq(out.sent, 2, 'Email 2 to A and B');
    eq(sentTo(mail('a'))[1].subject, 'Priya, a quick nudge on your audit', 'Email 2 subject');
    eq(new Date((await seqFor(mail('a'))).next_send_at).toISOString(), IST(22, 10).toISOString(), 'Email 3 due 72h after Email 1');

    // ── signed up mid-sequence → no Email 3 ─────────────────────────────────
    await run("INSERT INTO users (id, email, password, first_name, role, timezone) VALUES (?,?,?,?,?,'Asia/Kolkata')", [TAG + '-u2', mail('a').toUpperCase(), 'x', 'Priya', 'user']);
    clock = IST(22, 10, 5);
    out = await A.engine.runDue();
    eq(sentTo(mail('a')).length, 2, 'signed up → Email 3 not sent');
    eq((await seqFor(mail('a'))).status, 'stopped_signed_up', 'A stopped_signed_up');
    eq((await logFor(mail('a'))).map((x) => [x.step, x.status]), [[1, 'sent'], [2, 'sent'], [3, 'skipped']], 'A log: 1 and 2 sent, 3 skipped');
    eq(sentTo(mail('b')).length, 3, 'B got Email 3');
    eq(sentTo(mail('b'))[2].subject, 'Last note from me, Rahul', 'Email 3 subject');
    assert(sentTo(mail('b'))[2].html.includes('If muscle gain still matters to you'), 'Email 3 uses the goal');
    eq((await seqFor(mail('b'))).status, 'completed', 'B completed');

    // ── stage moved → stopped_replied ───────────────────────────────────────
    clock = IST(23, 10);
    const idC = await addLead('c', { first_name: 'Meera', email: mail('c') });
    const idD = await addLead('d', { first_name: 'Arjun', email: mail('d') });
    const idE = await addLead('e', { first_name: 'Kiran', email: mail('e') });
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [idC, idD, idE] });
    eq(r.data.queued, 3, 'queued C, D, E');
    out = await A.engine.runDue();
    eq(out.sent, 3, 'Email 1 to C, D, E');
    await run("UPDATE audit_requests SET stage = 'contacted' WHERE id = ?", [idC]);

    // ── Mark replied ────────────────────────────────────────────────────────
    const sD = await seqFor(mail('d'));
    r = await call(B, 'POST', `/api/admin/audit-requests/email-sequence/${sD.id}/stop`, tokAdmin, { reason: 'replied' });
    eq([r.status, r.data.sequence && r.data.sequence.status], [200, 'stopped_replied'], 'Mark replied');
    r = await call(B, 'POST', `/api/admin/audit-requests/email-sequence/${sD.id}/stop`, tokAdmin, { reason: 'bogus' });
    eq(r.status, 400, 'bad stop reason → 400');
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence/nope/stop', tokAdmin, { reason: 'manual' });
    eq(r.status, 404, 'unknown sequence → 404');

    // ── unsubscribe ─────────────────────────────────────────────────────────
    const tE = L.unsubToken(mail('e'), SECRET);
    r = await call(B, 'GET', '/api/email/unsubscribe?t=' + encodeURIComponent(tE));
    eq(r.status, 200, 'unsubscribe page 200');
    assert(/html/.test(r.type) && /Unsubscribing you/.test(r.data), 'unsubscribe page is HTML and confirms by POST');
    eq((await seqFor(mail('e'))).status, 'active', 'GET alone (a link scanner) does not unsubscribe');
    r = await call(B, 'GET', '/api/email/unsubscribe?t=' + encodeURIComponent(tE.slice(0, -3) + 'abc'));
    eq(r.status, 400, 'tampered token page → 400');
    r = await call(B, 'POST', '/api/email/unsubscribe?t=' + encodeURIComponent(tE.slice(0, -3) + 'abc'), null, 'List-Unsubscribe=One-Click', { 'Content-Type': 'application/x-www-form-urlencoded' });
    eq(r.status, 400, 'tampered one-click → 400');
    r = await call(B, 'POST', '/api/email/unsubscribe?t=' + encodeURIComponent(tE), null, 'List-Unsubscribe=One-Click', { 'Content-Type': 'application/x-www-form-urlencoded' });
    eq([r.status, r.data && r.data.ok], [200, true], 'one-click POST 200');
    eq((await seqFor(mail('e'))).status, 'stopped_unsubscribed', 'E stopped_unsubscribed');
    assert(!!(await queryOne('SELECT 1 FROM email_unsubscribes WHERE email_norm = ?', [mail('e')])), 'E in email_unsubscribes');
    r = await call(B, 'POST', '/api/email/unsubscribe?t=' + encodeURIComponent(tE), null, 'List-Unsubscribe=One-Click', { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' });
    assert(r.status === 200 && /You are unsubscribed/.test(r.data), 'repeat unsubscribe (no-JS form) shows the page');

    clock = IST(24, 10, 5);
    out = await A.engine.runDue();
    eq([sentTo(mail('c')).length, sentTo(mail('d')).length, sentTo(mail('e')).length], [1, 1, 1], 'C, D, E got no Email 2');
    eq((await seqFor(mail('c'))).status, 'stopped_replied', 'stage contacted → stopped_replied');

    // ── retry once, then fail ───────────────────────────────────────────────
    const idF = await addLead('f', { first_name: 'Farah', email: mail('f') });
    const idG = await addLead('g', { first_name: 'Gopal', email: mail('g') });
    await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [idF, idG] });
    failPlan.set(mail('f'), 1);
    failPlan.set(mail('g'), 5);
    out = await A.engine.runDue();
    eq(out.failed, 2, 'first attempt fails for F and G');
    eq((await logFor(mail('f')))[0].status, 'failed', 'F log failed');
    eq((await seqFor(mail('f'))).status, 'active', 'F still active after one failure');
    clock = new Date(clock.getTime() + 31 * 60000);
    out = await A.engine.runDue();
    eq(sentTo(mail('f')).length, 1, 'F retry sends');
    eq((await logFor(mail('f')))[0], { step: 1, status: 'sent', cc: 'bodybank.fit369@gmail.com', attempts: 2, error: '' }, 'F log: sent on attempt 2');
    eq((await seqFor(mail('g'))).status, 'failed', 'G failed after 2 attempts');
    eq((await logFor(mail('g')))[0].attempts, 2, 'G never more than 2 attempts');
    clock = new Date(clock.getTime() + 2 * HOUR);
    await A.engine.runDue();
    eq(sentTo(mail('g')).length, 0, 'G is never tried a third time');

    // ── two instances at once ───────────────────────────────────────────────
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await addLead('par' + i, { first_name: 'Par', email: mail('par' + i) }));
    await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids });
    const other = makeEngine();
    const before = outbox.length;
    await Promise.all([A.engine.runDue(), other.runDue(), makeEngine().runDue()]);
    eq(outbox.length - before, 6, 'three instances at once: each lead gets Email 1 exactly once');
    const dupes = await queryOne(`SELECT COUNT(*)::int AS n FROM audit_lead_email_log WHERE email_norm LIKE ? AND step = 1`, [TAG + '-par%']);
    eq(dupes.n, 6, 'one log row per lead');

    // ── quiet hours ─────────────────────────────────────────────────────────
    clock = IST(25, 22, 0);
    const idQ = await addLead('q', { first_name: 'Quinn', email: mail('q') });
    r = await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [idQ] });
    eq(r.data.next_send_at, IST(26, 9).toISOString(), 'queued at 22:00 IST → due 09:00 IST');
    out = await A.engine.runDue();
    eq([out.ran, out.reason], [false, 'quiet_hours'], 'nothing runs at 22:00 IST');
    await run('UPDATE audit_lead_email_sequences SET next_send_at = ? WHERE email_norm = ?', [IST(25, 12), mail('q')]);
    clock = IST(26, 7, 55);
    out = await A.engine.runDue();
    eq(out.reason, 'quiet_hours', 'overdue sequences still wait until 08:00 IST');
    clock = IST(26, 8, 0);
    out = await A.engine.runDue();
    eq(sentTo(mail('q')).length, 1, 'sent at 08:00 IST');

    // ── daily cap and the enabled flag ──────────────────────────────────────
    const idCap = await addLead('cap', { first_name: 'Cap', email: mail('cap') });
    await call(B, 'POST', '/api/admin/audit-requests/email-sequence', tokAdmin, { ids: [idCap] });
    const sentToday = await queryOne("SELECT COUNT(*)::int AS n FROM audit_lead_email_log WHERE status IN ('sent','sending') AND sent_at >= ?", [L.startOfIstDay(now())]);
    out = await makeEngine({ LEAD_EMAIL_DAILY_CAP: String(sentToday.n) }).runDue();
    eq([out.ran, out.reason], [false, 'daily_cap'], 'daily cap reached → nothing sent');
    out = await makeEngine({ AUDIT_LEAD_EMAILS_ENABLED: 'false' }).runDue();
    eq([out.ran, out.reason], [false, 'disabled'], 'AUDIT_LEAD_EMAILS_ENABLED=false → job does nothing');
    eq(sentTo(mail('cap')).length, 0, 'capped lead still waiting');
    eq((await seqFor(mail('cap'))).status, 'active', 'capped lead stays due');

    // ── list, preview, test send ────────────────────────────────────────────
    r = await call(B, 'GET', '/api/admin/audit-requests/email-sequence?status=completed', tokAdmin);
    assert(r.status === 200 && r.data.rows.some((x) => x.email_norm === mail('b') && Number(x.sent_step) === 3), 'list by status shows B completed at step 3');
    r = await call(B, 'GET', `/api/admin/audit-requests/email-preview?id=${idB}&step=2`, tokAdmin);
    assert(r.status === 200 && r.data.subject === 'Rahul, a quick nudge on your audit' && /Just checking in/.test(r.data.html), 'preview step 2');
    r = await call(B, 'GET', `/api/admin/audit-requests/email-preview?id=${idB}&step=9`, tokAdmin);
    eq(r.status, 400, 'preview bad step → 400');
    const logBefore = await queryOne('SELECT COUNT(*)::int AS n FROM audit_lead_email_log WHERE email_norm LIKE ?', [TAG + '%']);
    const testBefore = outbox.length;
    r = await call(B, 'POST', '/api/admin/audit-requests/email-test', tokAdmin, { step: 3, id: idB });
    eq([r.status, r.data.to], [200, mail('admin')], 'test send defaults to the admin');
    eq(outbox.length - testBefore, 1, 'test send sent one email');
    eq(outbox[outbox.length - 1].subject, 'Last note from me, Rahul', 'test send uses the lead name');
    eq(outbox[outbox.length - 1].cc, 'bodybank.fit369@gmail.com', 'test send carries the CC');
    r = await call(B, 'POST', '/api/admin/audit-requests/email-test', tokAdmin, { step: 1, to: 'stranger@example.com' });
    eq(r.status, 403, 'test send to a non staff address → 403');
    r = await call(NOSMTP.base, 'POST', '/api/admin/audit-requests/email-test', tokAdmin, { step: 1 });
    eq(r.status, 503, 'test send without SMTP → 503');
    const logAfter = await queryOne('SELECT COUNT(*)::int AS n FROM audit_lead_email_log WHERE email_norm LIKE ?', [TAG + '%']);
    eq(logAfter.n, logBefore.n, 'test sends write no log rows');
  } finally {
    servers.forEach((s) => s.close());
    await cleanup();
    await pool.end();
  }

  if (failures.length) {
    console.error(`audit-lead-emails-api: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log(`audit-lead-emails-api: all ${checks} checks passed`);
}

main().catch(async (e) => {
  console.error('audit-lead-emails-api crashed:', e);
  try { await cleanup(); await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
