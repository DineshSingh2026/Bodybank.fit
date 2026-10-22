/**
 * API test: change password + devices against a real PostgreSQL (DATABASE_URL).
 * Run: node tests/account-security-api.js
 *
 * Mounts routes/account.js with the real verifyToken wired to a real session service,
 * on an in-process server. Creates one tagged test member and deletes everything it
 * made at the end.
 *
 * Guards:
 *  - every route is 401 without a token;
 *  - logins on three devices + one pre-sessions (legacy) token all appear, labelled,
 *    with the calling device marked current;
 *  - logging one device out kills that token at once and drops its push token;
 *  - wrong current password → 400 on the field (never 401); reused password → 400;
 *  - a password change returns a fresh token for this device, ends every other
 *    session (including the legacy token) and the new password verifies;
 *  - "log out other devices" keeps this device with a new token, ends the rest;
 *  - "log out all" ends this device too; /api/auth/logout ends just the caller;
 *  - one member can never see or revoke another member's sessions.
 */
'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const { ensureSessionSchema, createSessionService } = require('../services/sessionService');
const { registerAccountRoutes } = require('../routes/account');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const run = (sql, p = []) => pool.query(toPg(sql), p);
const queryAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
const queryOne = async (sql, p = []) => (await queryAll(sql, p))[0] || null;

const TAG = 'zzsec' + crypto.randomBytes(3).toString('hex');
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
};
const fakeReq = (ua, ip) => ({ ip: ip || '49.37.12.200', get: (h) => (h.toLowerCase() === 'user-agent' ? ua : '') });

async function call(base, method, path, token, body, ua) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': ua || UA.windows }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, data };
}

async function cleanup() {
  await run('DELETE FROM user_sessions WHERE user_id LIKE ?', [TAG + '%']);
  await run('DELETE FROM device_push_tokens WHERE user_id LIKE ?', [TAG + '%']);
  await run('DELETE FROM users WHERE id LIKE ?', [TAG + '%']);
}

async function main() {
  await ensureSessionSchema(pool);
  const sessions = createSessionService({ queryAll, queryOne, run, signToken: auth.signToken });
  auth.setSessionStore(sessions);
  const changed = [];
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  registerAccountRoutes(app, {
    verifyToken: auth.verifyToken, rateLimiter: () => (req, res, next) => next(), queryOne, bcrypt, sessions,
    onPasswordChanged: (u) => changed.push(u.email)
  });
  app.get('/api/probe', auth.verifyToken, (req, res) => res.json({ ok: true, sid: req.sessionId || null }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const B = 'http://127.0.0.1:' + server.address().port;

  const user = { id: TAG + '-u', email: TAG + '@test.bodybank.fit', role: 'user', first_name: 'Sec' };
  const other = { id: TAG + '-o', email: TAG + '-o@test.bodybank.fit', role: 'user', first_name: 'Other' };
  const insertUser = async (u, pw) => run("INSERT INTO users (id, email, password, first_name, role, timezone) VALUES (?,?,?,?,?,'Asia/Kolkata')",
    [u.id, u.email, await bcrypt.hash(pw, 10), u.first_name, u.role]);
  await insertUser(user, 'oldpass123');
  await insertUser(other, 'otherpass1');

  try {
    // ── auth required ───────────────────────────────────────────────────────
    for (const [m, p] of [['POST', '/api/me/password'], ['GET', '/api/me/sessions'], ['DELETE', '/api/me/sessions/x'],
      ['POST', '/api/me/sessions/logout-others'], ['POST', '/api/me/sessions/logout-all'], ['POST', '/api/auth/logout']]) {
      eq((await call(B, m, p, null, m === 'GET' ? null : {})).status, 401, `${m} ${p} without a token → 401`);
    }

    // ── three logins + one legacy token ─────────────────────────────────────
    const phone = await sessions.issue(fakeReq(UA.iphone, '49.37.12.200'), user);
    const laptop = await sessions.issue(fakeReq(UA.windows, '103.21.4.9'), user);
    const android = await sessions.issue(fakeReq(UA.android, '::ffff:10.1.2.3'), user);
    assert(phone.sid && laptop.sid && android.sid, 'sessions issued with ids');
    const legacy = auth.signToken({ id: user.id, email: user.email, role: user.role });
    eq((await call(B, 'GET', '/api/probe', legacy, null, UA.mac)).status, 200, 'pre-sessions token still works (adopted)');
    await run('INSERT INTO device_push_tokens (id, user_id, token, platform, session_id) VALUES (?,?,?,?,?)',
      [TAG + '-pt', user.id, TAG + '-fcm', 'android', android.sid]);

    let r = await call(B, 'GET', '/api/me/sessions', phone.token, null, UA.iphone);
    eq(r.status, 200, 'list 200');
    const list = r.data.sessions;
    eq(list.length, 4, 'four devices listed');
    const byLabel = Object.fromEntries(list.map((s) => [s.label, s]));
    assert(byLabel['BodyBank app on iPhone'] && byLabel['BodyBank app on iPhone'].current, 'iPhone app listed and marked current');
    assert(byLabel['Chrome on Windows'] && !byLabel['Chrome on Windows'].current, 'Windows Chrome listed');
    assert(byLabel['BodyBank app on Pixel 8'], 'Android app listed with its model');
    assert(byLabel['Safari on Mac'], 'legacy Mac session listed');
    eq(byLabel['Chrome on Windows'].ip, '103.21.x.x', 'IP shown masked');
    eq(list.filter((s) => s.current).length, 1, 'exactly one current device');
    assert(list.every((s) => s.signed_in_at && s.last_active_at), 'timestamps present');

    // ── another member cannot touch these ───────────────────────────────────
    const otherTok = (await sessions.issue(fakeReq(UA.mac), other)).token;
    r = await call(B, 'GET', '/api/me/sessions', otherTok);
    eq(r.data.sessions.length, 1, 'the other member sees only their own device');
    r = await call(B, 'DELETE', '/api/me/sessions/' + laptop.sid, otherTok);
    eq(r.status, 404, "the other member cannot log out this member's device");
    eq((await call(B, 'GET', '/api/probe', laptop.token)).status, 200, 'laptop still signed in');

    // ── log one device out ──────────────────────────────────────────────────
    r = await call(B, 'DELETE', '/api/me/sessions/' + android.sid, phone.token);
    eq([r.status, r.data.ok, r.data.current], [200, true, false], 'Android logged out from the phone');
    eq((await call(B, 'GET', '/api/probe', android.token)).data, { error: 'Invalid or expired token' }, 'Android token dead at once, with the message the app recognises');
    eq(await queryOne('SELECT id FROM device_push_tokens WHERE id = ?', [TAG + '-pt']), null, "Android's push token removed with its session");
    r = await call(B, 'DELETE', '/api/me/sessions/' + android.sid, phone.token);
    eq(r.status, 404, 'logging out twice → 404');
    eq((await call(B, 'GET', '/api/me/sessions', phone.token)).data.sessions.length, 3, 'three devices left');

    // ── change password ─────────────────────────────────────────────────────
    r = await call(B, 'POST', '/api/me/password', phone.token, { current_password: 'wrongpass', new_password: 'newpass456' });
    eq([r.status, r.data.field], [400, 'current_password'], 'wrong current password → 400 on that field');
    eq((await call(B, 'GET', '/api/probe', phone.token)).status, 200, 'a wrong password never logs the member out');
    r = await call(B, 'POST', '/api/me/password', phone.token, { current_password: 'oldpass123', new_password: 'abc' });
    eq([r.status, r.data.field], [400, 'new_password'], 'too short → 400');
    r = await call(B, 'POST', '/api/me/password', phone.token, { current_password: 'oldpass123', new_password: ' oldpass123 ' });
    eq([r.status, r.data.field], [400, 'new_password'], 'same password → 400');
    r = await call(B, 'POST', '/api/me/password', phone.token, { current_password: 'oldpass123', new_password: 'Newpass456!' }, UA.iphone);
    eq([r.status, r.data.ok, r.data.logged_out], [200, true, 2], 'password changed, two other devices logged out');
    const phone2 = r.data.token;
    assert(phone2 && phone2 !== phone.token, 'a fresh token for this device');
    eq((await call(B, 'GET', '/api/probe', phone2)).status, 200, 'this device stays signed in with the new token');
    eq((await call(B, 'GET', '/api/probe', phone.token)).status, 401, 'the old token of this device stops');
    eq((await call(B, 'GET', '/api/probe', laptop.token)).status, 401, 'laptop logged out by the password change');
    eq((await call(B, 'GET', '/api/probe', legacy)).status, 401, 'legacy token logged out by the password change');
    await new Promise((res) => setTimeout(res, 1100));
    const stale = auth.signToken({ id: user.id, email: user.email, role: user.role });
    eq((await call(B, 'GET', '/api/probe', stale)).status, 200, 'a token signed after the change is accepted');
    const row = await queryOne('SELECT password FROM users WHERE id = ?', [user.id]);
    assert(await bcrypt.compare('Newpass456!', row.password), 'new password verifies');
    assert(!(await bcrypt.compare('oldpass123', row.password)), 'old password no longer verifies');
    eq(changed, [user.email], 'password changed email sent once');
    r = await call(B, 'GET', '/api/me/sessions', phone2, null, UA.iphone);
    eq(r.data.sessions.filter((s) => s.current).length, 1, 'new token is marked current');
    assert(!r.data.sessions.some((s) => s.id === laptop.sid || s.id === phone.sid), 'logged-out sessions gone from the list');

    // ── log out other devices ───────────────────────────────────────────────
    const tablet = await sessions.issue(fakeReq(UA.windows, '1.2.3.4'), user);
    r = await call(B, 'POST', '/api/me/sessions/logout-others', phone2, {}, UA.iphone);
    eq([r.status, r.data.ok], [200, true], 'log out other devices');
    assert(r.data.logged_out >= 1, 'at least the new laptop was logged out');
    const phone3 = r.data.token;
    eq((await call(B, 'GET', '/api/probe', phone3)).status, 200, 'this device stays in');
    eq((await call(B, 'GET', '/api/probe', tablet.token)).status, 401, 'other device logged out');
    eq((await call(B, 'GET', '/api/me/sessions', phone3)).data.sessions.length, 1, 'only this device left');

    // ── /api/auth/logout ends just the caller ───────────────────────────────
    const second = await sessions.issue(fakeReq(UA.mac), user);
    eq((await call(B, 'POST', '/api/auth/logout', second.token, {})).data, { ok: true }, 'logout ok');
    eq((await call(B, 'GET', '/api/probe', second.token)).status, 401, 'logged-out token dead');
    eq((await call(B, 'GET', '/api/probe', phone3)).status, 200, 'other session untouched by a logout');

    // ── log out all ─────────────────────────────────────────────────────────
    r = await call(B, 'POST', '/api/me/sessions/logout-all', phone3, {});
    eq([r.status, r.data.ok], [200, true], 'log out all');
    eq((await call(B, 'GET', '/api/probe', phone3)).status, 401, 'this device logged out too');
    eq((await call(B, 'GET', '/api/probe', otherTok)).status, 200, "the other member's session is untouched");
  } finally {
    server.close();
    auth.setSessionStore(null);
    await cleanup();
    await pool.end();
  }

  if (failures.length) {
    console.error(`account-security-api: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log(`account-security-api: all ${checks} checks passed`);
}

main().catch(async (e) => {
  console.error('account-security-api crashed:', e);
  try { auth.setSessionStore(null); await cleanup(); await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
