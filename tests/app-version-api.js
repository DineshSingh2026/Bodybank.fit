/**
 * API test: app update alert routes against a real PostgreSQL (DATABASE_URL).
 * Run: node tests/app-version-api.js
 *
 * Mounts routes/appVersion.js in-process with the real auth middleware and DB,
 * so the env flag can be switched per case. Saves and restores any existing
 * app_release_config rows, and uses a fake sendPushToUser (no real pushes).
 *
 * Guards:
 *  - public GET shape, Cache-Control, ?platform&version evaluation;
 *  - APP_UPDATE_ALERT_ENABLED=off → { enabled:false }; staff → only staff tokens;
 *  - admin GET/PUT are 401 without a token and 403 for members and operators;
 *  - PUT validates semver and rejects min > latest, stores updated_by, and the
 *    public endpoint then serves the DB value over env;
 *  - notify sends once per platform + version (409 on repeat) and only to that platform.
 */
'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const { createAppVersionRouter, createAppVersionAdminRouter } = require('../routes/appVersion');
const S = require('../services/appVersionService');
const { verifyToken, requireAdminOrSuperadmin, signToken } = require('../middleware/auth');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const run = (sql, p = []) => pool.query(toPg(sql), p);
const queryAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
const queryOne = async (sql, p = []) => (await queryAll(sql, p))[0] || null;

const TAG = 'zzappvtest' + crypto.randomBytes(3).toString('hex');
const pushed = [];
const fakePush = async (userId, payload, platform) => { pushed.push({ userId, payload, platform }); };

function makeApp(env) {
  const app = express();
  app.use(express.json());
  const deps = {
    verifyToken, requireAdminOrSuperadmin, rateLimiter: () => (req, res, next) => next(),
    queryAll, queryOne, run, sendAppPush: fakePush, pushReady: () => true, env
  };
  app.use('/api/app', createAppVersionRouter(deps));
  app.use('/api/admin/app-version', createAppVersionAdminRouter(deps));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

async function call(base, method, path, token, body) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, data, cache: r.headers.get('cache-control') };
}

let saved = [];
async function setup() {
  await S.ensureAppVersionTable(pool);
  saved = await queryAll('SELECT * FROM app_release_config');
  await run('DELETE FROM app_release_config');
  await run('INSERT INTO device_push_tokens (id, user_id, token, platform) VALUES (?,?,?,?), (?,?,?,?)', [
    TAG + '-t1', TAG + '-ios-user', TAG + '-tok-ios', 'ios',
    TAG + '-t2', TAG + '-android-user', TAG + '-tok-android', 'android'
  ]);
}

async function cleanup() {
  await run('DELETE FROM device_push_tokens WHERE id LIKE ?', [TAG + '%']);
  await run('DELETE FROM app_release_config');
  for (const r of saved) {
    await run(`INSERT INTO app_release_config (platform, latest_version, min_supported_version, force, release_notes, updated_by, updated_at, notified_version, notified_at)
               VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.platform, r.latest_version, r.min_supported_version, r.force, r.release_notes, r.updated_by, r.updated_at, r.notified_version, r.notified_at]);
  }
}

async function main() {
  await setup();
  const tokUser = signToken({ id: TAG + '-member', email: TAG + '@test.bodybank.fit', role: 'user' });
  const tokOp = signToken({ id: TAG + '-op', email: 'op@x', role: 'operator' });
  const tokAdmin = signToken({ id: TAG + '-admin', email: TAG + '-admin@test.bodybank.fit', role: 'admin' });

  const on = await makeApp({ APP_UPDATE_NOTES_IOS: 'Coach Mode is here.' });
  const off = await makeApp({ APP_UPDATE_ALERT_ENABLED: 'off' });
  const staff = await makeApp({ APP_UPDATE_ALERT_ENABLED: 'staff' });
  const B = 'http://127.0.0.1:' + on.address().port;
  const OFF = 'http://127.0.0.1:' + off.address().port;
  const ST = 'http://127.0.0.1:' + staff.address().port;

  try {
    // ── public GET ──────────────────────────────────────────────────────────
    let r = await call(B, 'GET', '/api/app/version');
    eq(r.status, 200, 'public GET 200 without auth');
    eq(r.data && r.data.enabled, true, 'enabled');
    eq(r.cache, 'public, max-age=300', 'cached 5 minutes');
    eq(r.data.ios, { latest_version: '1.0.10', min_supported_version: '1.0.6', force: false,
      store_url: 'https://apps.apple.com/app/id6808102656', app_store_id: '6808102656', release_notes: 'Coach Mode is here.' }, 'ios block');
    eq(r.data.android, { latest_version: '1.8.7', min_supported_version: '1.8.2', force: false,
      store_url: 'https://play.google.com/store/apps/details?id=com.bodybank.app', package: 'com.bodybank.app', release_notes: '' }, 'android block');
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.data.server_time || ''), 'server_time ISO');
    assert(!('evaluation' in r.data), 'no evaluation without query');

    r = await call(B, 'GET', '/api/app/version?platform=ios&version=1.0.8');
    eq(r.data.evaluation, { status: 'soft' }, 'ios 1.0.8 soft');
    r = await call(B, 'GET', '/api/app/version?platform=android&version=1.8.1');
    eq(r.data.evaluation, { status: 'force' }, 'android 1.8.1 force');
    r = await call(B, 'GET', '/api/app/version?platform=ios&version=garbage');
    eq(r.data.evaluation, { status: 'ok' }, 'garbage version fails open');
    r = await call(B, 'GET', '/api/app/version', 'not-a-token');
    eq(r.status, 200, 'bad token on public GET is ignored');

    // ── flag ────────────────────────────────────────────────────────────────
    r = await call(OFF, 'GET', '/api/app/version?platform=ios&version=1.0.1');
    eq(r.data, { enabled: false }, 'off → enabled:false only');
    r = await call(ST, 'GET', '/api/app/version');
    eq(r.data, { enabled: false }, 'staff mode: anonymous disabled');
    eq(r.cache, 'private, no-store', 'staff mode not publicly cached');
    r = await call(ST, 'GET', '/api/app/version', tokUser);
    eq(r.data, { enabled: false }, 'staff mode: member disabled');
    r = await call(ST, 'GET', '/api/app/version', tokOp);
    eq(r.data && r.data.enabled, true, 'staff mode: operator enabled');

    // ── admin auth ──────────────────────────────────────────────────────────
    r = await call(B, 'GET', '/api/admin/app-version');
    eq(r.status, 401, 'admin GET 401 without token');
    r = await call(B, 'GET', '/api/admin/app-version', tokUser);
    eq(r.status, 403, 'admin GET 403 for member');
    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokUser, { latest_version: '1.0.11' });
    eq(r.status, 403, 'admin PUT 403 for member');
    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokOp, { latest_version: '1.0.11' });
    eq(r.status, 403, 'admin PUT 403 for operator');
    r = await call(B, 'POST', '/api/admin/app-version/ios/notify', tokUser);
    eq(r.status, 403, 'notify 403 for member');
    eq((await queryAll('SELECT * FROM app_release_config')).length, 0, 'rejected calls wrote nothing');

    r = await call(B, 'GET', '/api/admin/app-version', tokAdmin);
    eq(r.status, 200, 'admin GET 200');
    eq(r.data.platforms.ios.effective.latest_version, '1.0.10', 'admin sees env value');
    eq(r.data.platforms.ios.override, null, 'no override yet');

    // ── admin PUT validation ────────────────────────────────────────────────
    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokAdmin, { latest_version: '1.0.10', min_supported_version: '1.0.11' });
    eq(r.status, 400, 'min > latest rejected');
    assert(r.data && r.data.fields && r.data.fields.min_supported_version, 'field error for min');
    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokAdmin, { latest_version: 'one.two' });
    eq(r.status, 400, 'bad semver rejected');
    r = await call(B, 'PUT', '/api/admin/app-version/windows', tokAdmin, { latest_version: '1.0.0' });
    eq(r.status, 400, 'unknown platform rejected');
    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokAdmin, { force: 'yes' });
    eq(r.status, 400, 'non boolean force rejected');
    eq((await queryAll('SELECT * FROM app_release_config')).length, 0, 'invalid PUTs wrote nothing');

    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokAdmin, { latest_version: 'v1.0.11', min_supported_version: '1.0.7', force: false, release_notes: 'New look.' });
    eq(r.status, 200, 'valid PUT 200');
    eq(r.data.platforms.ios.effective.latest_version, '1.0.11', 'PUT response has new latest');
    const row = await queryOne('SELECT * FROM app_release_config WHERE platform = ?', ['ios']);
    eq(row && row.latest_version, '1.0.11', 'stored normalised');
    eq(row && row.updated_by, TAG + '-admin@test.bodybank.fit', 'updated_by stored');

    r = await call(B, 'GET', '/api/app/version?platform=ios&version=1.0.10');
    eq(r.data.ios.latest_version, '1.0.11', 'DB wins over env on public GET');
    eq(r.data.ios.min_supported_version, '1.0.7', 'DB min on public GET');
    eq(r.data.ios.release_notes, 'New look.', 'DB notes on public GET');
    eq(r.data.evaluation, { status: 'soft' }, '1.0.10 now soft');
    eq(r.data.android.latest_version, '1.8.7', 'android untouched');

    // ── notify ──────────────────────────────────────────────────────────────
    pushed.length = 0;
    r = await call(B, 'POST', '/api/admin/app-version/ios/notify', tokAdmin);
    eq(r.status, 200, 'notify 200');
    eq(r.data && r.data.version, '1.0.11', 'notify version');
    const mine = pushed.filter((p) => String(p.userId).startsWith(TAG));
    eq(mine.map((p) => p.userId), [TAG + '-ios-user'], 'only ios users pushed');
    eq(mine[0] && mine[0].platform, 'ios', 'push scoped to the ios devices');
    eq(mine[0] && mine[0].payload.type, 'app_update', 'push type app_update');
    eq(mine[0] && mine[0].payload.url, 'https://apps.apple.com/app/id6808102656', 'push url = store url');
    eq(mine[0] && mine[0].payload.body, 'New look.', 'push body = release notes');
    r = await call(B, 'POST', '/api/admin/app-version/ios/notify', tokAdmin);
    eq(r.status, 409, 'second notify for the same version refused');
    r = await call(B, 'PUT', '/api/admin/app-version/ios', tokAdmin, { latest_version: '1.0.12' });
    pushed.length = 0;
    r = await call(B, 'POST', '/api/admin/app-version/ios/notify', tokAdmin);
    eq(r.status, 200, 'new version can notify again');

    // notify on a platform with no row yet creates a placeholder that does not override env force
    const forcedEnv = await makeApp({ APP_ANDROID_FORCE: 'true' });
    const FE = 'http://127.0.0.1:' + forcedEnv.address().port;
    pushed.length = 0;
    r = await call(FE, 'POST', '/api/admin/app-version/android/notify', tokAdmin);
    eq(r.status, 200, 'android notify without a row');
    eq(pushed.filter((p) => String(p.userId).startsWith(TAG)).map((p) => p.userId), [TAG + '-android-user'], 'only android users pushed');
    r = await call(FE, 'GET', '/api/app/version');
    eq(r.data.android.force, true, 'placeholder row keeps env force');
    forcedEnv.close();
  } finally {
    on.close(); off.close(); staff.close();
    await cleanup();
  }
}

main()
  .catch((e) => { failures.push('crashed: ' + (e && e.stack || e)); })
  .finally(async () => {
    await pool.end().catch(() => {});
    if (failures.length) {
      console.error(`\napp-version-api: ${failures.length} of ${checks} checks FAILED`);
      failures.forEach((f) => console.error('  ✗ ' + f));
      process.exit(1);
    }
    console.log(`app-version-api: ${checks} passed, 0 failed`);
  });
