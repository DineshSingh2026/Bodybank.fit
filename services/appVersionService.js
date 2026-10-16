'use strict';

/**
 * App update alert: which store build is current, which is the oldest still
 * supported, and what an installed app should do about it. Pure functions only
 * (no DB, no network) so tests/app-version-unit.js can cover every branch.
 *
 * The client copy of parseSemver / compareSemver / evaluate lives in
 * bodybank-app/src-web/bb-app-update.js. Keep the two in step.
 *
 * Env (DB row in app_release_config wins per field when set):
 *   APP_UPDATE_ALERT_ENABLED   off | staff | all          [all]
 *   APP_IOS_LATEST_VERSION     [1.0.10]   APP_IOS_MIN_VERSION     [1.0.6]
 *   APP_IOS_FORCE              [false]    APP_IOS_STORE_ID        [6808102656]
 *   APP_ANDROID_LATEST_VERSION [1.8.7]    APP_ANDROID_MIN_VERSION [1.8.2]
 *   APP_ANDROID_FORCE          [false]    APP_ANDROID_PACKAGE     [com.bodybank.app]
 *   APP_UPDATE_NOTES_IOS, APP_UPDATE_NOTES_ANDROID           [empty]
 */

const PLATFORMS = ['ios', 'android'];
const STAFF_ROLES = ['admin', 'superadmin', 'operator'];
const MAX_NOTES = 500;

const DEFAULTS = {
  ios: { latest: '1.0.10', min: '1.0.6', storeId: '6808102656' },
  android: { latest: '1.8.7', min: '1.8.2', pkg: 'com.bodybank.app' }
};

/** "1.8.7 (117)", "v1.2.3", " 1.0 " → [major, minor, patch]; anything else → null. */
function parseSemver(str) {
  if (str == null) return null;
  const s = String(str).trim();
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?=$|[\s(+-])/i.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** -1 / 0 / 1, numeric per part (1.10.0 > 1.9.9). Invalid input never throws: it compares as 0. */
function compareSemver(a, b) {
  const pa = Array.isArray(a) ? a : parseSemver(a);
  const pb = Array.isArray(b) ? b : parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** Canonical "x.y.z" for a valid version, else null. */
function normalizeVersion(str) {
  const p = parseSemver(str);
  return p ? p.join('.') : null;
}

function bool(v, dflt) {
  if (v === true || v === false) return v;
  if (v == null || String(v).trim() === '') return dflt;
  return ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase());
}

function str(v) { return v == null ? '' : String(v).trim(); }

function flagMode(env) {
  let mode = str((env || {}).APP_UPDATE_ALERT_ENABLED || 'all').toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(mode)) mode = 'all';
  if (['0', 'false', 'no'].includes(mode)) mode = 'off';
  if (!['off', 'staff', 'all'].includes(mode)) mode = 'off';
  return mode;
}

function configFromEnv(env) {
  const e = env || process.env;
  return {
    mode: flagMode(e),
    ios: {
      latest_version: normalizeVersion(e.APP_IOS_LATEST_VERSION) || DEFAULTS.ios.latest,
      min_supported_version: normalizeVersion(e.APP_IOS_MIN_VERSION) || DEFAULTS.ios.min,
      force: bool(e.APP_IOS_FORCE, false),
      app_store_id: (str(e.APP_IOS_STORE_ID).match(/^\d{5,15}$/) || [DEFAULTS.ios.storeId])[0],
      release_notes: str(e.APP_UPDATE_NOTES_IOS).slice(0, MAX_NOTES)
    },
    android: {
      latest_version: normalizeVersion(e.APP_ANDROID_LATEST_VERSION) || DEFAULTS.android.latest,
      min_supported_version: normalizeVersion(e.APP_ANDROID_MIN_VERSION) || DEFAULTS.android.min,
      force: bool(e.APP_ANDROID_FORCE, false),
      package: (str(e.APP_ANDROID_PACKAGE).match(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/) || [DEFAULTS.android.pkg])[0],
      release_notes: str(e.APP_UPDATE_NOTES_ANDROID).slice(0, MAX_NOTES)
    }
  };
}

/** One platform: a DB row's non-empty fields override the env values. */
function resolvePlatform(envPlat, row) {
  const out = Object.assign({}, envPlat);
  if (!row) return out;
  const latest = normalizeVersion(row.latest_version);
  const min = normalizeVersion(row.min_supported_version);
  if (latest) out.latest_version = latest;
  if (min) out.min_supported_version = min;
  if (row.force === true || row.force === false) out.force = row.force;
  if (row.release_notes != null && str(row.release_notes) !== '') out.release_notes = str(row.release_notes).slice(0, MAX_NOTES);
  return out;
}

/** dbRows: { ios: row|null, android: row|null } or an array of rows with a platform field. */
function resolveConfig(envCfg, dbRows) {
  const byPlat = {};
  if (Array.isArray(dbRows)) dbRows.forEach((r) => { if (r && PLATFORMS.includes(r.platform)) byPlat[r.platform] = r; });
  else if (dbRows && typeof dbRows === 'object') PLATFORMS.forEach((p) => { if (dbRows[p]) byPlat[p] = dbRows[p]; });
  return {
    mode: envCfg.mode,
    ios: resolvePlatform(envCfg.ios, byPlat.ios),
    android: resolvePlatform(envCfg.android, byPlat.android)
  };
}

function storeUrl(platform, p) {
  if (platform === 'ios') return 'https://apps.apple.com/app/id' + p.app_store_id;
  return 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(p.package);
}

/**
 * force: current < min, or the force flag is on and current < latest.
 * soft:  current < latest.
 * Unknown platform or unparseable current version → ok (fail open).
 */
function evaluate(platform, currentVersion, cfg) {
  const p = cfg && cfg[platform];
  const cur = parseSemver(currentVersion);
  if (!p || !PLATFORMS.includes(platform) || !cur) return { status: 'ok' };
  const latest = parseSemver(p.latest_version);
  const min = parseSemver(p.min_supported_version);
  if (min && compareSemver(cur, min) < 0) return { status: 'force' };
  if (latest && compareSemver(cur, latest) < 0) return { status: p.force === true ? 'force' : 'soft' };
  return { status: 'ok' };
}

/** off → nobody; staff → staff roles only (needs a user); all → everyone. */
function isEnabledFor(user, mode) {
  if (mode === 'all') return true;
  if (mode === 'staff') return !!(user && STAFF_ROLES.includes(user.role));
  return false;
}

/** The public JSON (no internal fields). */
function publicPayload(cfg, now) {
  const plat = (name) => {
    const p = cfg[name];
    const o = {
      latest_version: p.latest_version,
      min_supported_version: p.min_supported_version,
      force: !!p.force,
      store_url: storeUrl(name, p)
    };
    if (name === 'ios') o.app_store_id = p.app_store_id;
    else o.package = p.package;
    o.release_notes = p.release_notes || '';
    return o;
  };
  return {
    enabled: true,
    ios: plat('ios'),
    android: plat('android'),
    server_time: (now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
}

/** Admin PUT body → { value } or { errors }. `current` is the resolved config for that platform. */
function validateUpdate(body, current) {
  const b = body || {};
  const errors = {};
  const pick = (k) => (Object.prototype.hasOwnProperty.call(b, k) ? b[k] : undefined);

  const latestIn = pick('latest_version');
  const minIn = pick('min_supported_version');
  const latest = latestIn === undefined ? current.latest_version : normalizeVersion(latestIn);
  const min = minIn === undefined ? current.min_supported_version : normalizeVersion(minIn);
  if (!latest) errors.latest_version = 'Use a version like 1.0.11';
  if (!min) errors.min_supported_version = 'Use a version like 1.0.6';
  if (latest && min && compareSemver(min, latest) > 0) errors.min_supported_version = 'Minimum cannot be above latest';

  let force = current.force;
  const forceIn = pick('force');
  if (forceIn !== undefined) {
    if (forceIn === true || forceIn === false) force = forceIn;
    else errors.force = 'Must be true or false';
  }

  let notes = current.release_notes || '';
  const notesIn = pick('release_notes');
  if (notesIn !== undefined) {
    if (notesIn !== null && typeof notesIn !== 'string') errors.release_notes = 'Must be text';
    else if (String(notesIn || '').trim().length > MAX_NOTES) errors.release_notes = 'Keep it under ' + MAX_NOTES + ' characters';
    else notes = String(notesIn || '').trim();
  }

  if (Object.keys(errors).length) return { errors };
  return { value: { latest_version: latest, min_supported_version: min, force, release_notes: notes } };
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS app_release_config (
    platform TEXT PRIMARY KEY CHECK (platform IN ('ios','android')),
    latest_version TEXT,
    min_supported_version TEXT,
    force BOOLEAN DEFAULT false,
    release_notes TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
  'ALTER TABLE app_release_config ADD COLUMN IF NOT EXISTS notified_version TEXT',
  'ALTER TABLE app_release_config ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ'
];

async function ensureAppVersionTable(pool) {
  for (const sql of DDL) await pool.query(sql);
}

module.exports = {
  PLATFORMS,
  DEFAULTS,
  MAX_NOTES,
  DDL,
  parseSemver,
  compareSemver,
  normalizeVersion,
  configFromEnv,
  resolveConfig,
  evaluate,
  isEnabledFor,
  storeUrl,
  publicPayload,
  validateUpdate,
  ensureAppVersionTable
};
