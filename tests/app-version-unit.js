/**
 * Unit test: app update alert (services/appVersionService.js).
 * Run: node tests/app-version-unit.js
 *
 * NO NETWORK. NO DATABASE.
 *
 * What this guards:
 *  - parseSemver tolerates "1.0", "1.8.7 (117)", "v1.2.3", whitespace; garbage → null;
 *  - compareSemver is numeric per part (1.0.10 > 1.0.9, 1.10 > 1.9) and never throws;
 *  - evaluate: below min → force, below latest → soft, equal/above → ok, force flag,
 *    unknown or garbage version → ok (fail open);
 *  - configFromEnv defaults and APP_UPDATE_ALERT_ENABLED parsing (off / staff / all);
 *  - a DB row wins over env per field, empty fields fall back to env;
 *  - admin validation: bad semver and min > latest are rejected;
 *  - the public payload shape and store URLs;
 *  - the client copy in bodybank-app/src-web/bb-app-update.js agrees (when that repo is beside this one).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../services/appVersionService');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── parseSemver ─────────────────────────────────────────────────────────────
eq(S.parseSemver('1.8.7'), [1, 8, 7], 'plain x.y.z');
eq(S.parseSemver('1.0'), [1, 0, 0], 'x.y pads patch');
eq(S.parseSemver('2'), [2, 0, 0], 'x pads minor + patch');
eq(S.parseSemver('1.8.7 (117)'), [1, 8, 7], 'build in brackets ignored');
eq(S.parseSemver('v1.2.3'), [1, 2, 3], 'leading v');
eq(S.parseSemver('V1.2.3'), [1, 2, 3], 'leading V');
eq(S.parseSemver('  1.0.10  '), [1, 0, 10], 'whitespace trimmed');
eq(S.parseSemver('1.2.3-beta'), [1, 2, 3], 'prerelease suffix ignored');
for (const bad of ['', '   ', 'abc', 'x1.2.3', '1..2', '.1.2', null, undefined, {}, [], NaN, '1.2.3.4']) {
  eq(S.parseSemver(bad), null, 'garbage → null: ' + JSON.stringify(bad));
}

// ── compareSemver ───────────────────────────────────────────────────────────
eq(S.compareSemver('1.0.10', '1.0.9'), 1, '1.0.10 > 1.0.9');
eq(S.compareSemver('1.0.9', '1.0.10'), -1, '1.0.9 < 1.0.10');
eq(S.compareSemver('1.10', '1.9'), 1, '1.10 > 1.9');
eq(S.compareSemver('1.10.0', '1.9.9'), 1, '1.10.0 > 1.9.9');
eq(S.compareSemver('1.8.7', '1.8.7 (117)'), 0, 'equal with build suffix');
eq(S.compareSemver('1.0', '1.0.0'), 0, '1.0 == 1.0.0');
eq(S.compareSemver('2.0.0', '10.0.0'), -1, 'numeric, not string, compare');
let threw = false;
try { S.compareSemver('junk', null); S.compareSemver(undefined, {}); } catch (_) { threw = true; }
assert(!threw, 'compareSemver never throws on invalid input');
eq(S.compareSemver('junk', '1.0.0'), 0, 'invalid compares as 0');

// ── configFromEnv ───────────────────────────────────────────────────────────
{
  const c = S.configFromEnv({});
  eq(c.mode, 'all', 'default mode all');
  eq(c.ios.latest_version, '1.0.10', 'ios latest default');
  eq(c.ios.min_supported_version, '1.0.6', 'ios min default');
  eq(c.ios.force, false, 'ios force default');
  eq(c.ios.app_store_id, '6808102656', 'ios store id default');
  eq(c.android.latest_version, '1.8.7', 'android latest default');
  eq(c.android.min_supported_version, '1.8.2', 'android min default');
  eq(c.android.force, false, 'android force default');
  eq(c.android.package, 'com.bodybank.app', 'android package default');
  eq(c.ios.release_notes, '', 'notes empty by default');
}
{
  const c = S.configFromEnv({
    APP_UPDATE_ALERT_ENABLED: 'OFF', APP_IOS_LATEST_VERSION: '1.0.12', APP_IOS_FORCE: 'true',
    APP_ANDROID_MIN_VERSION: 'v1.8.5', APP_UPDATE_NOTES_ANDROID: '  Faster check ins  ',
    APP_IOS_STORE_ID: 'not-a-number', APP_ANDROID_PACKAGE: 'bad pkg'
  });
  eq(c.mode, 'off', 'APP_UPDATE_ALERT_ENABLED=off');
  eq(c.ios.latest_version, '1.0.12', 'env latest');
  eq(c.ios.force, true, 'env force true');
  eq(c.android.min_supported_version, '1.8.5', 'env min normalised');
  eq(c.android.release_notes, 'Faster check ins', 'notes trimmed');
  eq(c.ios.app_store_id, '6808102656', 'invalid store id falls back');
  eq(c.android.package, 'com.bodybank.app', 'invalid package falls back');
}
eq(S.configFromEnv({ APP_UPDATE_ALERT_ENABLED: 'staff' }).mode, 'staff', 'staff mode');
eq(S.configFromEnv({ APP_UPDATE_ALERT_ENABLED: 'true' }).mode, 'all', 'true → all');
eq(S.configFromEnv({ APP_UPDATE_ALERT_ENABLED: 'maybe' }).mode, 'off', 'unknown mode → off');
eq(S.configFromEnv({ APP_IOS_LATEST_VERSION: 'garbage' }).ios.latest_version, '1.0.10', 'invalid env version falls back');

// ── isEnabledFor ────────────────────────────────────────────────────────────
assert(S.isEnabledFor(null, 'all'), 'all: anonymous enabled');
assert(!S.isEnabledFor({ role: 'admin' }, 'off'), 'off: even admin disabled');
assert(!S.isEnabledFor(null, 'staff'), 'staff: anonymous disabled');
assert(!S.isEnabledFor({ role: 'user' }, 'staff'), 'staff: member disabled');
assert(S.isEnabledFor({ role: 'operator' }, 'staff'), 'staff: operator enabled');

// ── resolveConfig (DB wins per field) ───────────────────────────────────────
{
  const env = S.configFromEnv({ APP_IOS_FORCE: 'true', APP_UPDATE_NOTES_IOS: 'env notes' });
  const r = S.resolveConfig(env, [
    { platform: 'ios', latest_version: '1.0.11', min_supported_version: null, force: null, release_notes: '' },
    { platform: 'android', latest_version: '', min_supported_version: '1.8.6', force: true, release_notes: 'Coach Mode is here.' },
    { platform: 'windows', latest_version: '9.9.9' }
  ]);
  eq(r.ios.latest_version, '1.0.11', 'DB latest wins');
  eq(r.ios.min_supported_version, '1.0.6', 'null DB min → env');
  eq(r.ios.force, true, 'null DB force → env force');
  eq(r.ios.release_notes, 'env notes', 'empty DB notes → env notes');
  eq(r.android.latest_version, '1.8.7', 'empty DB latest → env');
  eq(r.android.min_supported_version, '1.8.6', 'DB min wins');
  eq(r.android.force, true, 'DB force wins');
  eq(r.android.release_notes, 'Coach Mode is here.', 'DB notes win');
  const r2 = S.resolveConfig(env, [{ platform: 'ios', force: false }]);
  eq(r2.ios.force, false, 'DB force=false overrides env force=true');
  eq(S.resolveConfig(env, []).ios, env.ios, 'empty table = env values');
  eq(S.resolveConfig(env, { ios: { latest_version: '1.0.13' } }).ios.latest_version, '1.0.13', 'object form accepted');
  eq(S.resolveConfig(env, [{ platform: 'ios', latest_version: 'nope' }]).ios.latest_version, '1.0.10', 'invalid DB version ignored');
}

// ── evaluate ────────────────────────────────────────────────────────────────
{
  const cfg = S.configFromEnv({}); // ios 1.0.6 .. 1.0.10, android 1.8.2 .. 1.8.7
  eq(S.evaluate('ios', '1.0.5', cfg).status, 'force', 'below min → force');
  eq(S.evaluate('ios', '1.0.6', cfg).status, 'soft', 'at min, below latest → soft');
  eq(S.evaluate('ios', '1.0.9', cfg).status, 'soft', 'below latest → soft');
  eq(S.evaluate('ios', '1.0.10', cfg).status, 'ok', 'equal → ok');
  eq(S.evaluate('ios', '1.0.11', cfg).status, 'ok', 'above latest → ok');
  eq(S.evaluate('android', '1.8.7 (117)', cfg).status, 'ok', 'android equal with build');
  eq(S.evaluate('android', '1.8.1', cfg).status, 'force', 'android below min');
  eq(S.evaluate('android', '1.8.2', cfg).status, 'soft', 'android 1.8.2 soft');
  eq(S.evaluate('ios', '', cfg).status, 'ok', 'empty version → ok');
  eq(S.evaluate('ios', 'garbage', cfg).status, 'ok', 'garbage version → ok');
  eq(S.evaluate('ios', null, cfg).status, 'ok', 'null version → ok');
  eq(S.evaluate('web', '1.0.0', cfg).status, 'ok', 'unknown platform → ok');
  eq(S.evaluate('ios', '1.0.0', null).status, 'ok', 'no config → ok');
  const forced = S.configFromEnv({ APP_IOS_FORCE: 'true' });
  eq(S.evaluate('ios', '1.0.9', forced).status, 'force', 'force flag + below latest → force');
  eq(S.evaluate('ios', '1.0.10', forced).status, 'ok', 'force flag + on latest → ok');
}

// ── validateUpdate ──────────────────────────────────────────────────────────
{
  const cur = S.configFromEnv({}).ios;
  const ok = S.validateUpdate({ latest_version: '1.0.11', min_supported_version: 'v1.0.7', force: true, release_notes: '  New look  ' }, cur);
  eq(ok.value, { latest_version: '1.0.11', min_supported_version: '1.0.7', force: true, release_notes: 'New look' }, 'valid update normalised');
  assert(S.validateUpdate({ latest_version: '1.0.5' }, cur).errors.min_supported_version, 'min > latest rejected (partial body)');
  assert(S.validateUpdate({ latest_version: '1.0.10', min_supported_version: '1.0.11' }, cur).errors.min_supported_version, 'min > latest rejected');
  assert(S.validateUpdate({ latest_version: 'abc' }, cur).errors.latest_version, 'bad latest rejected');
  assert(S.validateUpdate({ min_supported_version: '' }, cur).errors.min_supported_version, 'empty min rejected');
  assert(S.validateUpdate({ force: 'yes' }, cur).errors.force, 'non boolean force rejected');
  assert(S.validateUpdate({ release_notes: 'x'.repeat(S.MAX_NOTES + 1) }, cur).errors.release_notes, 'long notes rejected');
  eq(S.validateUpdate({}, cur).value, { latest_version: '1.0.10', min_supported_version: '1.0.6', force: false, release_notes: '' }, 'empty body keeps current');
  eq(S.validateUpdate({ latest_version: '1.0.6', min_supported_version: '1.0.6' }, cur).value.latest_version, '1.0.6', 'min == latest allowed');
}

// ── public payload ──────────────────────────────────────────────────────────
{
  const p = S.publicPayload(S.configFromEnv({ APP_UPDATE_NOTES_IOS: 'Coach Mode is here.' }), new Date('2026-10-16T05:30:00.123Z'));
  eq(p.enabled, true, 'enabled true');
  eq(Object.keys(p.ios), ['latest_version', 'min_supported_version', 'force', 'store_url', 'app_store_id', 'release_notes'], 'ios keys');
  eq(Object.keys(p.android), ['latest_version', 'min_supported_version', 'force', 'store_url', 'package', 'release_notes'], 'android keys');
  eq(p.ios.store_url, 'https://apps.apple.com/app/id6808102656', 'ios store url');
  eq(p.android.store_url, 'https://play.google.com/store/apps/details?id=com.bodybank.app', 'android store url');
  eq(p.ios.release_notes, 'Coach Mode is here.', 'notes passed through');
  eq(p.server_time, '2026-10-16T05:30:00Z', 'server_time without millis');
  assert(!('mode' in p), 'mode not leaked');
}

// ── boot DDL is additive ────────────────────────────────────────────────────
assert(S.DDL.every((s) => /^\s*(CREATE TABLE IF NOT EXISTS|ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS)/i.test(s)), 'DDL is additive only');

// ── client copy agrees (bodybank-app beside this repo) ──────────────────────
{
  const clientFile = path.join(__dirname, '..', '..', 'bodybank-app', 'src-web', 'bb-app-update.js');
  if (fs.existsSync(clientFile)) {
    const sandbox = { window: { IS_BODYBANK_APP: false }, module: { exports: {} } };
    sandbox.module.exports = {};
    vm.runInNewContext(fs.readFileSync(clientFile, 'utf8'), sandbox, { filename: clientFile });
    const C = sandbox.module.exports;
    assert(typeof C.compareSemver === 'function', 'client exports compareSemver for tests');
    if (typeof C.compareSemver === 'function') {
      const cases = [['1.0.10', '1.0.9'], ['1.10', '1.9'], ['1.8.7 (117)', '1.8.7'], ['v2', '1.99.99'], ['junk', '1.0.0'], ['1.0.0', '1.0.1']];
      cases.forEach(([a, b]) => eq(C.compareSemver(a, b), S.compareSemver(a, b), `client compareSemver(${a}, ${b}) matches server`));
      const cfg = S.publicPayload(S.configFromEnv({ APP_ANDROID_FORCE: 'true' }));
      [['ios', '1.0.5'], ['ios', '1.0.9'], ['ios', '1.0.10'], ['android', '1.8.6'], ['android', '1.8.1'], ['ios', 'x']].forEach(([pl, v]) => {
        eq(C.evaluate(pl, v, cfg).status, S.evaluate(pl, v, cfg).status, `client evaluate(${pl}, ${v}) matches server`);
      });
    }
  } else {
    console.log('  (bodybank-app not beside this repo; client parity check skipped)');
  }
}

if (failures.length) {
  console.error(`\napp-version-unit: ${failures.length} of ${checks} checks FAILED`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`app-version-unit: ${checks} passed, 0 failed`);
