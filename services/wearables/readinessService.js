'use strict';

/**
 * Unified wearable "readiness" data layer.
 *
 * Design contract
 * ---------------
 * Some members own a Whoop; most do not. Rather than two code paths, every downstream
 * feature (coins, streaks, coach dashboard, monthly PDF, nutrition targets) reads ONE
 * table — `readiness_daily` — through `getReadiness()` / `getReadinessRange()` and never
 * asks where the number came from. Provenance is available (source / confidence) but is
 * never required to consume the value.
 *
 * Source precedence (strict): whoop > manual > derived.
 *
 * Every exported function is defensive: it validates its inputs, catches its own errors
 * (console.warn like coinService) and returns a result object — nothing here throws out
 * to the caller.
 *
 * `db` is always `{ run, queryOne, queryAll }`. SQL uses `?` placeholders which the
 * app-level helper rewrites to $1..$n — never write $1 here, and never use the jsonb `?`
 * existence operator in these statements (it would be eaten by the rewriter).
 */

const { v4: uuidv4 } = require('uuid');
const { toDateStr, todayYmdInTz, addCalendarDaysYmd, STREAK_TZ } = require('../streakService');

/* ────────────────────────────── constants ────────────────────────────── */

const DEFAULT_PROVIDER = 'whoop';
const VALID_PROVIDERS = ['whoop', 'manual', 'derived', 'oura', 'garmin', 'apple_health', 'fitbit'];

/** Strict resolution order used by getReadiness()/getReadinessRange(). Lower = wins. */
const SOURCE_PRECEDENCE = { whoop: 1, manual: 2, derived: 3 };
const SOURCE_PRECEDENCE_SQL = `CASE source
    WHEN 'whoop' THEN 1
    WHEN 'manual' THEN 2
    WHEN 'derived' THEN 3
    ELSE 9 END`;

/** Numeric metric columns of readiness_daily, in insert order. */
const METRIC_COLUMNS = [
  'confidence',
  'recovery_score',
  'readiness_score',
  'hrv_ms',
  'resting_hr',
  'spo2',
  'skin_temp_c',
  'respiratory_rate',
  // Kept alongside skin_temp_c so a future unit-detection misfire is recoverable
  // from stored data rather than silently baked in. See whoopParser's C/F logic.
  'skin_temp_raw',
  'sleep_hours',
  'sleep_performance_pct',
  'sleep_efficiency_pct',
  'sleep_consistency_pct',
  'sleep_debt_min',
  'sleep_need_min',
  'rem_min',
  'deep_min',
  'light_min',
  'awake_min',
  'nap_min',
  'strain',
  'energy_kcal',
  'max_hr',
  'avg_hr'
];

/**
 * Non-numeric readiness columns. These bypass the numeric coercion applied to
 * METRIC_COLUMNS — running num('C') would yield null and silently drop the unit,
 * which is exactly the provenance we are trying to preserve.
 */
const TEXT_COLUMNS = ['skin_temp_unit'];

/** camelCase names returned to callers, keyed by column. */
const COLUMN_TO_CAMEL = {
  confidence: 'confidence',
  recovery_score: 'recoveryScore',
  readiness_score: 'readinessScore',
  hrv_ms: 'hrvMs',
  resting_hr: 'restingHr',
  spo2: 'spo2',
  skin_temp_c: 'skinTempC',
  skin_temp_raw: 'skinTempRaw',
  skin_temp_unit: 'skinTempUnit',
  respiratory_rate: 'respiratoryRate',
  sleep_hours: 'sleepHours',
  sleep_performance_pct: 'sleepPerformancePct',
  sleep_efficiency_pct: 'sleepEfficiencyPct',
  sleep_consistency_pct: 'sleepConsistencyPct',
  sleep_debt_min: 'sleepDebtMin',
  sleep_need_min: 'sleepNeedMin',
  rem_min: 'remMin',
  deep_min: 'deepMin',
  light_min: 'lightMin',
  awake_min: 'awakeMin',
  nap_min: 'napMin',
  strain: 'strain',
  energy_kcal: 'energyKcal',
  max_hr: 'maxHr',
  avg_hr: 'avgHr'
};

/**
 * Loose header aliases. Keys are normalised (lowercased, non-alphanumerics stripped) so
 * "Recovery score %", "recovery_score" and "recoveryScore" all collapse to "recoveryscore".
 */
const RAW_ALIASES = {
  recovery_score: ['recovery score %', 'recovery_score', 'recoveryScore', 'recovery', 'recovery %'],
  readiness_score: ['readiness score', 'readiness_score', 'readinessScore', 'readiness'],
  hrv_ms: ['heart rate variability (ms)', 'hrv_ms', 'hrv', 'heart rate variability', 'hrvMs', 'rmssd'],
  resting_hr: ['resting heart rate (bpm)', 'resting_hr', 'resting heart rate', 'restingHr', 'rhr'],
  spo2: ['blood oxygen %', 'spo2', 'blood oxygen', 'oxygen saturation', 'sp o2'],
  skin_temp_c: ['skin temp (celsius)', 'skin_temp_c', 'skin temp', 'skin temperature', 'skinTempC'],
  skin_temp_raw: ['skin_temp_raw', 'skinTempRaw', 'skin temp raw'],
  skin_temp_unit: ['skin_temp_unit', 'skinTempUnit', 'skin temp unit'],
  sleep_consistency_pct: ['sleep consistency %', 'sleep_consistency_pct', 'sleep consistency', 'sleepConsistencyPct'],
  respiratory_rate: ['respiratory rate (rpm)', 'respiratory_rate', 'respiratory rate', 'respiratoryRate', 'resp rate'],
  sleep_hours: ['sleep_hours', 'sleep hours', 'sleepHours', 'hours of sleep', 'sleep duration (h)'],
  sleep_performance_pct: ['sleep performance %', 'sleep_performance_pct', 'sleep performance', 'sleepPerformancePct'],
  sleep_efficiency_pct: ['sleep efficiency %', 'sleep_efficiency_pct', 'sleep efficiency', 'sleepEfficiencyPct'],
  sleep_debt_min: ['sleep debt (min)', 'sleep_debt_min', 'sleep debt', 'sleepDebtMin'],
  sleep_need_min: ['sleep need (min)', 'sleep_need_min', 'sleep need', 'sleepNeedMin'],
  rem_min: ['rem duration (min)', 'rem_min', 'rem', 'rem sleep duration (min)', 'remMin'],
  deep_min: ['deep (sws) duration (min)', 'deep_min', 'deep', 'deep sleep duration (min)', 'slow wave sleep duration (min)', 'deepMin'],
  light_min: ['light sleep duration (min)', 'light_min', 'light', 'lightMin'],
  awake_min: ['awake duration (min)', 'awake_min', 'awake', 'awakeMin'],
  // 'napMinutes' is what whoopParser emits — without it every nap is silently
  // dropped, which is exactly the sleep-inflation bug the parser guards against.
  nap_min: ['nap duration (min)', 'nap_min', 'nap', 'napMin', 'napMinutes'],
  strain: ['day strain', 'strain', 'dayStrain'],
  energy_kcal: ['energy burned (cal)', 'energy_kcal', 'energy burned', 'calories', 'kcal', 'energyKcal'],
  max_hr: ['max hr (bpm)', 'max_hr', 'max hr', 'maxHr', 'max heart rate'],
  avg_hr: ['average hr (bpm)', 'avg_hr', 'average hr', 'avgHr', 'average heart rate'],
  confidence: ['confidence']
};

/** Non-column values we still understand (used for derivation or deliberately dropped). */
const RAW_EXTRA_ALIASES = {
  __date: ['date', 'day', 'ymd', 'calendar date', 'cycle start time', 'cycle_start_time', 'cycleStart', 'checkin_date'],
  __asleep_min: ['asleep duration (min)', 'asleep_min', 'asleep duration', 'time asleep (min)', 'total sleep (min)', 'sleep duration (min)'],
  __in_bed_min: ['in bed duration (min)', 'in_bed_min', 'in bed duration', 'time in bed (min)'],
  __ignored: [
    'cycle end time', 'cycle_end_time', 'cycle timezone', 'timezone', 'tz',
    'sleep onset', 'wake onset', 'sleep_onset', 'wake_onset',
    'user_id', 'userId', 'id', 'row', 'row_number', 'source', 'provider',
    'workout count', 'activity name', 'nap flag', 'is nap', 'raw', 'raw_json'
  ]
};

/** Weights of the derived (non-Whoop) readiness formula. Sum = 100. */
const DERIVED_WEIGHTS = {
  sleep: 35,
  consistency: 20,
  recovery_proxy: 30,
  adherence: 15
};
const DERIVED_FORMULA_VERSION = 1;
/** Below this much *available* weight we refuse to publish a score at all. */
const DERIVED_MIN_AVAILABLE_WEIGHT = 40;
const DERIVED_MIN_COMPONENTS = 2;

/* ────────────────────────────── small helpers ────────────────────────────── */

function normKey(k) {
  return String(k == null ? '' : k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** normalisedHeader -> readiness_daily column (or a `__pseudo` bucket). */
const ALIAS_LOOKUP = (() => {
  const map = new Map();
  const add = (target, list) => {
    (list || []).forEach((alias) => {
      const k = normKey(alias);
      if (k && !map.has(k)) map.set(k, target);
    });
  };
  Object.keys(RAW_ALIASES).forEach((col) => {
    add(col, RAW_ALIASES[col]);
    add(col, [col]);
  });
  Object.keys(RAW_EXTRA_ALIASES).forEach((pseudo) => add(pseudo, RAW_EXTRA_ALIASES[pseudo]));
  return map;
})();

/** '' / null / undefined / NaN / non-finite -> null. Never 0. */
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  const s = String(v).trim();
  if (!s) return null;
  // tolerate "72 bpm", "6.5h", "1,234", "85%"
  const cleaned = s.replace(/,/g, '').replace(/[^0-9.+-eE]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '+' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function round1(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function cleanStr(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeProvider(p) {
  const s = cleanStr(p, 40);
  if (!s) return DEFAULT_PROVIDER;
  const low = s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return VALID_PROVIDERS.includes(low) ? low : low.slice(0, 40);
}

function hasDb(db) {
  return !!(db && typeof db.run === 'function' && typeof db.queryOne === 'function' && typeof db.queryAll === 'function');
}

function safeJson(v) {
  try {
    return JSON.stringify(v === undefined ? {} : v) || '{}';
  } catch (_) {
    return '{}';
  }
}

function daysBetween(fromYmd, toYmd) {
  if (!isYmd(fromYmd) || !isYmd(toYmd)) return null;
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

async function resolveUserTz(db, userId) {
  try {
    const u = await db.queryOne(
      `SELECT COALESCE(NULLIF(TRIM(timezone), ''), ?) AS tz FROM users WHERE id = ?`,
      [STREAK_TZ, userId]
    );
    const tz = u && cleanStr(u.tz, 60);
    return tz || STREAK_TZ;
  } catch (_) {
    return STREAK_TZ;
  }
}

/* ────────────────────────────── schema ────────────────────────────── */

/**
 * Idempotent DDL. Mirrors server.js initDB style: CREATE TABLE IF NOT EXISTS plus
 * try/catch-wrapped ALTER TABLE ... ADD COLUMN IF NOT EXISTS so an older deployment
 * picks up new columns without a migration step.
 */
async function ensureReadinessTables(db) {
  if (!hasDb(db)) return { ok: false, reason: 'invalid_db' };
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS wearable_uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'whoop',
      file_name TEXT,
      file_sha256 TEXT NOT NULL,
      rows_parsed INTEGER,
      rows_rejected INTEGER,
      date_from DATE,
      date_to DATE,
      summary_json JSONB DEFAULT '{}'::jsonb,
      status TEXT DEFAULT 'committed',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, file_sha256)
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS readiness_daily (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      source TEXT NOT NULL,
      confidence REAL,
      recovery_score REAL,
      readiness_score REAL,
      hrv_ms REAL,
      resting_hr REAL,
      spo2 REAL,
      skin_temp_c REAL,
      respiratory_rate REAL,
      sleep_hours REAL,
      sleep_performance_pct REAL,
      sleep_efficiency_pct REAL,
      sleep_debt_min REAL,
      sleep_need_min REAL,
      rem_min REAL,
      deep_min REAL,
      light_min REAL,
      awake_min REAL,
      nap_min REAL,
      strain REAL,
      energy_kcal REAL,
      max_hr REAL,
      avg_hr REAL,
      source_upload_id TEXT,
      raw_json JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, date, source)
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS wearable_rows_rejected (
      id TEXT PRIMARY KEY,
      upload_id TEXT,
      user_id TEXT,
      file_name TEXT,
      row_number INTEGER,
      reason TEXT,
      raw_json JSONB,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS wearable_connections (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT DEFAULT 'connected',
      opted_in_at TIMESTAMPTZ,
      last_sync_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, provider)
    )`);

    // Deleting a member must delete their health data with them. Without these
    // the wearable tables have no FK at all, so a removed user leaves orphaned
    // recovery/HRV/sleep rows behind forever — a privacy problem, not just
    // untidiness. Guarded on pg_constraint so repeat runs never stack duplicates.
    const cascades = [
      ['wearable_uploads', 'fk_wearable_uploads_user', 'user_id'],
      ['readiness_daily', 'fk_readiness_daily_user', 'user_id'],
      ['wearable_rows_rejected', 'fk_wearable_rejected_user', 'user_id'],
      ['wearable_connections', 'fk_wearable_connections_user', 'user_id']
    ];
    for (const [table, name, col] of cascades) {
      try {
        const has = await db.queryOne(
          `SELECT 1 AS x
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
            WHERE t.relname = ? AND c.contype = 'f' AND a.attname = ?
            LIMIT 1`,
          [table, col]
        );
        if (has) continue;
        // Purge pre-existing orphans first, or ADD CONSTRAINT fails validation.
        await db.run(
          `DELETE FROM ${table} WHERE user_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ${table}.user_id)`
        ).catch(() => {});
        await db.run(
          `ALTER TABLE ${table} ADD CONSTRAINT ${name}
             FOREIGN KEY (${col}) REFERENCES users(id) ON DELETE CASCADE`
        );
      } catch (e) { /* ignore — never block boot on a constraint retrofit */ }
    }

    // Forward-compatible column adds (no-ops on a fresh install).
    const adds = [
      `ALTER TABLE wearable_uploads ADD COLUMN IF NOT EXISTS summary_json JSONB DEFAULT '{}'::jsonb`,
      `ALTER TABLE wearable_uploads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'committed'`,
      `ALTER TABLE wearable_uploads ADD COLUMN IF NOT EXISTS rows_parsed INTEGER`,
      `ALTER TABLE wearable_uploads ADD COLUMN IF NOT EXISTS rows_rejected INTEGER`,
      `ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS source_upload_id TEXT`,
      `ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS raw_json JSONB DEFAULT '{}'::jsonb`,
      `ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`,
      `ALTER TABLE wearable_connections ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ`,
      `ALTER TABLE wearable_connections ADD COLUMN IF NOT EXISTS opted_in_at TIMESTAMPTZ`
    ];
    METRIC_COLUMNS.forEach((c) => adds.push(`ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS ${c} REAL`));
    TEXT_COLUMNS.forEach((c) => adds.push(`ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS ${c} TEXT`));
    for (const sql of adds) {
      try { await db.run(sql); } catch (e) { /* column may already exist */ }
    }

    const idx = [
      `CREATE INDEX IF NOT EXISTS idx_readiness_daily_user_date ON readiness_daily(user_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_readiness_daily_user_source ON readiness_daily(user_id, source)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_uploads_user ON wearable_uploads(user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_rows_rejected_upload ON wearable_rows_rejected(upload_id)`
    ];
    for (const sql of idx) {
      try { await db.run(sql); } catch (e) { /* ignore */ }
    }

    // Safety net for a table that somehow predates the inline UNIQUE constraints.
    try {
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_readiness_daily_uds ON readiness_daily(user_id, date, source)`);
    } catch (e) { /* constraint already provides it */ }
    try {
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wearable_uploads_user_sha ON wearable_uploads(user_id, file_sha256)`);
    } catch (e) { /* constraint already provides it */ }

    return { ok: true };
  } catch (err) {
    console.warn('[readiness] ensureReadinessTables failed:', err && err.message);
    return { ok: false, reason: 'ddl_failed', error: err && err.message };
  }
}

/* ────────────────────────────── opt-in / connections ────────────────────────────── */

function mapConnection(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    provider: row.provider,
    status: row.status || null,
    optedInAt: row.opted_in_at || null,
    lastSyncAt: row.last_sync_at || null,
    connected: String(row.status || '') === 'connected'
  };
}

async function getConnection(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider(opts && opts.provider);
  if (!hasDb(db) || !userId) return { ok: false, reason: 'invalid_input', connection: null };
  try {
    const row = await db.queryOne(
      `SELECT user_id, provider, status, opted_in_at, last_sync_at
       FROM wearable_connections WHERE user_id = ? AND provider = ?`,
      [userId, provider]
    );
    return { ok: true, connection: mapConnection(row) };
  } catch (err) {
    console.warn('[readiness] getConnection failed:', err && err.message);
    return { ok: false, reason: 'query_failed', connection: null };
  }
}

/** Explicit member opt-in. Idempotent; keeps the original opted_in_at on re-opt-in. */
async function optIn(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider(opts && opts.provider);
  if (!hasDb(db) || !userId) return { ok: false, reason: 'invalid_input' };
  try {
    await db.run(
      `INSERT INTO wearable_connections (user_id, provider, status, opted_in_at)
       VALUES (?, ?, 'connected', CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         status = 'connected',
         opted_in_at = COALESCE(wearable_connections.opted_in_at, CURRENT_TIMESTAMP)`,
      [userId, provider]
    );
    const c = await getConnection(db, { userId, provider });
    return { ok: true, provider, connection: c.connection };
  } catch (err) {
    console.warn('[readiness] optIn failed:', err && err.message);
    return { ok: false, reason: 'write_failed', error: err && err.message };
  }
}

/**
 * Opt-out. Data is intentionally PRESERVED — status flips to 'disconnected' only.
 * Use purgeProviderData() for an explicit member-requested deletion.
 */
async function optOut(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider(opts && opts.provider);
  if (!hasDb(db) || !userId) return { ok: false, reason: 'invalid_input' };
  try {
    await db.run(
      `INSERT INTO wearable_connections (user_id, provider, status, opted_in_at)
       VALUES (?, ?, 'disconnected', NULL)
       ON CONFLICT (user_id, provider) DO UPDATE SET status = 'disconnected'`,
      [userId, provider]
    );
    const c = await getConnection(db, { userId, provider });
    return { ok: true, provider, dataPreserved: true, connection: c.connection };
  } catch (err) {
    console.warn('[readiness] optOut failed:', err && err.message);
    return { ok: false, reason: 'write_failed', error: err && err.message };
  }
}

/** Hard delete of a provider's data for one member (explicit user request / GDPR-style). */
async function purgeProviderData(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider(opts && opts.provider);
  if (!hasDb(db) || !userId) return { ok: false, reason: 'invalid_input' };
  try {
    const rejected = await db.run(
      `DELETE FROM wearable_rows_rejected
       WHERE user_id = ?
         AND upload_id IN (SELECT id FROM wearable_uploads WHERE user_id = ? AND provider = ?)`,
      [userId, userId, provider]
    );
    const daily = await db.run(
      `DELETE FROM readiness_daily WHERE user_id = ? AND source = ?`,
      [userId, provider]
    );
    const uploads = await db.run(
      `DELETE FROM wearable_uploads WHERE user_id = ? AND provider = ?`,
      [userId, provider]
    );
    await db.run(
      `UPDATE wearable_connections
       SET status = 'purged', last_sync_at = NULL, opted_in_at = NULL
       WHERE user_id = ? AND provider = ?`,
      [userId, provider]
    );
    return {
      ok: true,
      provider,
      readinessRowsDeleted: (daily && daily.rowCount) || 0,
      uploadsDeleted: (uploads && uploads.rowCount) || 0,
      rejectedRowsDeleted: (rejected && rejected.rowCount) || 0
    };
  } catch (err) {
    console.warn('[readiness] purgeProviderData failed:', err && err.message);
    return { ok: false, reason: 'delete_failed', error: err && err.message };
  }
}

/* ────────────────────────────── parsed-day normalisation ────────────────────────────── */

/**
 * Map one parser day object onto readiness_daily columns.
 * Tolerates snake_case, camelCase and raw Whoop CSV headers.
 * @returns {{date:string|null, values:Object, unknown:string[]}}
 */
function normalizeParsedDay(day) {
  const out = { date: null, values: {}, unknown: [] };
  if (!day || typeof day !== 'object') return out;

  let asleepMin = null;
  Object.keys(day).forEach((rawKey) => {
    const k = normKey(rawKey);
    if (!k) return;
    const target = ALIAS_LOOKUP.get(k);
    const v = day[rawKey];
    if (!target) {
      if (v !== null && v !== undefined && String(v).trim() !== '') out.unknown.push(String(rawKey));
      return;
    }
    if (target === '__ignored') return;
    if (target === '__date') {
      if (!out.date) out.date = toDateStr(v);
      return;
    }
    if (target === '__asleep_min') { asleepMin = num(v); return; }
    if (target === '__in_bed_min') { return; }
    if (TEXT_COLUMNS.indexOf(target) !== -1) {
      const s = String(v == null ? '' : v).trim();
      if (s) out.values[target] = s.slice(0, 16);
      return;
    }
    const n = num(v);
    if (n !== null) out.values[target] = n;
  });

  // Derived fills — only when the explicit field is absent.
  if (out.values.sleep_hours == null && asleepMin != null && asleepMin > 0) {
    out.values.sleep_hours = round1(asleepMin / 60);
  }
  if (out.values.sleep_hours == null) {
    const stages = ['rem_min', 'deep_min', 'light_min']
      .map((c) => out.values[c])
      .filter((x) => x != null);
    if (stages.length === 3) {
      const total = stages.reduce((a, b) => a + b, 0);
      if (total > 0) out.values.sleep_hours = round1(total / 60);
    }
  }
  // A day with no usable date is unusable downstream.
  if (out.date && !isYmd(out.date)) out.date = null;
  return out;
}

/** Normalise + de-duplicate a parsed payload's days (last occurrence of a date wins). */
function normalizeParsed(parsed) {
  const days = (parsed && Array.isArray(parsed.days)) ? parsed.days : [];
  const byDate = new Map();
  const unknown = new Set();
  let undated = 0;

  days.forEach((d) => {
    const n = normalizeParsedDay(d);
    n.unknown.forEach((u) => unknown.add(u));
    if (!n.date) { undated += 1; return; }
    const prev = byDate.get(n.date);
    if (prev) {
      // merge: newer non-null values win, older values survive where newer is null
      const merged = Object.assign({}, prev.values, n.values);
      byDate.set(n.date, { date: n.date, values: merged, raw: d });
    } else {
      byDate.set(n.date, { date: n.date, values: n.values, raw: d });
    }
  });

  // Parser-reported unknown headers, if it supplies them.
  const fromParser = []
    .concat((parsed && parsed.unknownColumns) || [])
    .concat((parsed && parsed.summary && parsed.summary.unknownColumns) || []);
  fromParser.forEach((u) => { const s = cleanStr(u, 120); if (s) unknown.add(s); });

  const rows = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dateRange = rows.length ? { from: rows[0].date, to: rows[rows.length - 1].date } : { from: null, to: null };

  const rejectedIn = (parsed && Array.isArray(parsed.rejected)) ? parsed.rejected : [];
  return {
    rows,
    dateRange,
    unknownColumns: Array.from(unknown).slice(0, 200),
    undated,
    rejected: rejectedIn
  };
}

/* ────────────────────────────── upsert SQL (built once) ────────────────────────────── */

const UPSERT_COLS = ['id', 'user_id', 'date', 'source'].concat(METRIC_COLUMNS, TEXT_COLUMNS, ['source_upload_id', 'raw_json']);
const UPSERT_PLACEHOLDERS = UPSERT_COLS.map((c) => {
  if (c === 'date') return '?::date';
  if (c === 'raw_json') return '?::jsonb';
  return '?';
}).join(', ');
const UPSERT_SET = METRIC_COLUMNS.concat(TEXT_COLUMNS)
  .map((c) => `${c} = COALESCE(EXCLUDED.${c}, readiness_daily.${c})`)
  .concat([
    'source_upload_id = COALESCE(EXCLUDED.source_upload_id, readiness_daily.source_upload_id)',
    'raw_json = COALESCE(EXCLUDED.raw_json, readiness_daily.raw_json)',
    'updated_at = CURRENT_TIMESTAMP'
  ])
  .join(',\n         ');
const UPSERT_SQL = `INSERT INTO readiness_daily (${UPSERT_COLS.join(', ')})
     VALUES (${UPSERT_PLACEHOLDERS})
     ON CONFLICT (user_id, date, source) DO UPDATE SET
         ${UPSERT_SET}`;

/**
 * Upsert one resolved day. Existing non-null values survive a null in the incoming row
 * (a partial re-export must never erase history); non-null incoming values always win.
 */
async function upsertReadinessDay(db, { userId, date, source, values, sourceUploadId, raw }) {
  const params = [uuidv4(), userId, date, source];
  METRIC_COLUMNS.forEach((c) => params.push(values && values[c] != null ? Number(values[c]) : null));
  // Text columns are pushed verbatim — Number() here would null them out.
  TEXT_COLUMNS.forEach((c) => params.push(values && values[c] != null ? String(values[c]) : null));
  params.push(sourceUploadId || null);
  params.push(safeJson(raw || {}));
  return db.run(UPSERT_SQL, params);
}

/* ────────────────────────────── upload preview / commit ────────────────────────────── */

/**
 * Dry run for the mandatory preview → confirm UX. Reads only; mutates nothing.
 * Pass `sha256` (optional) to also learn whether this exact file was already committed.
 */
async function previewUpload(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const parsed = opts && opts.parsed;
  const provider = normalizeProvider((opts && opts.provider) || DEFAULT_PROVIDER);
  const sha256 = cleanStr(opts && opts.sha256, 128);
  if (!hasDb(db) || !userId || !parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'invalid_input', totalDays: 0, newDays: 0, existingDays: 0, rowsRejected: 0, dateRange: { from: null, to: null }, unknownColumns: [] };
  }
  try {
    const n = normalizeParsed(parsed);
    let existingDays = 0;
    if (n.rows.length && n.dateRange.from && n.dateRange.to) {
      const have = await db.queryAll(
        `SELECT date FROM readiness_daily
         WHERE user_id = ? AND source = ? AND date BETWEEN ?::date AND ?::date`,
        [userId, provider, n.dateRange.from, n.dateRange.to]
      );
      const haveSet = new Set((have || []).map((r) => toDateStr(r.date)).filter(Boolean));
      existingDays = n.rows.reduce((acc, r) => acc + (haveSet.has(r.date) ? 1 : 0), 0);
    }

    let duplicate = null;
    if (sha256) {
      const dup = await db.queryOne(
        `SELECT id FROM wearable_uploads WHERE user_id = ? AND file_sha256 = ?`,
        [userId, sha256]
      );
      duplicate = !!dup;
    }

    return {
      ok: true,
      totalDays: n.rows.length,
      newDays: n.rows.length - existingDays,
      existingDays,
      rowsRejected: (n.rejected || []).length + n.undated,
      dateRange: n.dateRange,
      unknownColumns: n.unknownColumns,
      undatedRows: n.undated,
      duplicate
    };
  } catch (err) {
    console.warn('[readiness] previewUpload failed:', err && err.message);
    return { ok: false, reason: 'query_failed', error: err && err.message, totalDays: 0, newDays: 0, existingDays: 0, rowsRejected: 0, dateRange: { from: null, to: null }, unknownColumns: [] };
  }
}

/**
 * Commit a parsed wearable export.
 * Re-uploading a byte-identical file is a no-op: `{ duplicate:true, uploadId }`.
 */
async function commitUpload(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider((opts && opts.provider) || DEFAULT_PROVIDER);
  const fileName = cleanStr(opts && opts.fileName, 300);
  const sha256 = cleanStr(opts && opts.sha256, 128);
  const parsed = opts && opts.parsed;

  if (!hasDb(db) || !userId || !sha256 || !parsed || typeof parsed !== 'object') {
    return { ok: false, duplicate: false, reason: 'invalid_input' };
  }

  try {
    const existing = await db.queryOne(
      `SELECT id FROM wearable_uploads WHERE user_id = ? AND file_sha256 = ?`,
      [userId, sha256]
    );
    if (existing) {
      return { ok: true, duplicate: true, uploadId: existing.id };
    }

    const n = normalizeParsed(parsed);
    const uploadId = uuidv4();
    const rejected = n.rejected || [];
    const rowsRejected = rejected.length + n.undated;

    const summary = Object.assign(
      {},
      (parsed.summary && typeof parsed.summary === 'object') ? parsed.summary : {},
      {
        days: n.rows.length,
        undatedRows: n.undated,
        unknownColumns: n.unknownColumns,
        workouts: Array.isArray(parsed.workouts) ? parsed.workouts.length : 0,
        journal: Array.isArray(parsed.journal) ? parsed.journal.length : 0
      }
    );

    const ins = await db.run(
      `INSERT INTO wearable_uploads
         (id, user_id, provider, file_name, file_sha256, rows_parsed, rows_rejected,
          date_from, date_to, summary_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::date, ?::date, ?::jsonb, 'committed', CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, file_sha256) DO NOTHING`,
      [uploadId, userId, provider, fileName, sha256, n.rows.length, rowsRejected,
        n.dateRange.from, n.dateRange.to, safeJson(summary)]
    );
    if (!ins || !ins.rowCount) {
      // Lost a race with a concurrent identical upload — treat as duplicate, write nothing.
      const raced = await db.queryOne(
        `SELECT id FROM wearable_uploads WHERE user_id = ? AND file_sha256 = ?`,
        [userId, sha256]
      );
      return { ok: true, duplicate: true, uploadId: raced ? raced.id : null };
    }

    // Which dates already existed for this source (so we can report new vs updated)?
    let existingSet = new Set();
    if (n.dateRange.from && n.dateRange.to) {
      const have = await db.queryAll(
        `SELECT date FROM readiness_daily
         WHERE user_id = ? AND source = ? AND date BETWEEN ?::date AND ?::date`,
        [userId, provider, n.dateRange.from, n.dateRange.to]
      );
      existingSet = new Set((have || []).map((r) => toDateStr(r.date)).filter(Boolean));
    }

    let daysWritten = 0;
    let daysUpdated = 0;
    let daysFailed = 0;
    for (const row of n.rows) {
      try {
        await upsertReadinessDay(db, {
          userId,
          date: row.date,
          source: provider,
          values: row.values,
          sourceUploadId: uploadId,
          raw: row.raw
        });
        if (existingSet.has(row.date)) daysUpdated += 1; else daysWritten += 1;
      } catch (e) {
        daysFailed += 1;
        console.warn('[readiness] upsert day failed', row.date, e && e.message);
      }
    }

    // Persist rejected rows for operator triage.
    let rejectedStored = 0;
    for (let i = 0; i < rejected.length; i++) {
      const r = rejected[i] || {};
      const rowNumber = num(r.rowNumber != null ? r.rowNumber : (r.row_number != null ? r.row_number : r.line));
      try {
        await db.run(
          `INSERT INTO wearable_rows_rejected
             (id, upload_id, user_id, file_name, row_number, reason, raw_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP)`,
          [
            uuidv4(),
            uploadId,
            userId,
            cleanStr(r.fileName || r.file_name || fileName, 300),
            rowNumber != null ? Math.trunc(rowNumber) : null,
            cleanStr(r.reason || r.error || r.message, 500) || 'unspecified',
            safeJson(r.raw || r.row || r.data || r)
          ]
        );
        rejectedStored += 1;
      } catch (e) {
        console.warn('[readiness] rejected-row insert failed:', e && e.message);
      }
    }

    // Best-effort sync stamp; never auto-creates an opt-in record.
    try {
      await db.run(
        `UPDATE wearable_connections SET last_sync_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND provider = ?`,
        [userId, provider]
      );
    } catch (e) { /* ignore */ }

    return {
      ok: true,
      duplicate: false,
      uploadId,
      daysWritten,
      daysUpdated,
      daysFailed,
      rowsRejected,
      rejectedStored,
      dateRange: n.dateRange,
      unknownColumns: n.unknownColumns
    };
  } catch (err) {
    console.warn('[readiness] commitUpload failed:', err && err.message);
    return { ok: false, duplicate: false, reason: 'write_failed', error: err && err.message };
  }
}

/* ────────────────────────────── derived readiness (non-Whoop path) ────────────────────────────── */

/** 7–9h optimal; short sleep costs 25 pts/hour, long sleep 20 pts/hour with a 55 floor. */
function sleepComponentScore(h) {
  if (h == null || !Number.isFinite(h) || h <= 0 || h > 24) return null;
  if (h >= 7 && h <= 9) return 100;
  if (h < 7) return Math.round(clamp(100 - (7 - h) * 25, 0, 100));
  return Math.round(clamp(100 - (h - 9) * 20, 55, 100));
}

/**
 * Transparent 0–100 readiness for members with no wearable.
 *
 *   sleep          35  — daily_checkins.sleep_hours for the day (7–9h = 100)
 *   consistency    20  — real (non-freeze) check-in density over the trailing 7 days
 *   recovery_proxy 30  — training load in workout_logs (recent load without rest lowers it)
 *                        + mind_checkins presence
 *   adherence      15  — water_ml / protein_g vs the member's goals
 *
 * Score = weighted mean over components that had real data, rescaled to the available
 * weight. Confidence = 0.4 + 0.2 * (componentsWithData / 4)  →  0.45 … 0.60.
 * Returns null (never a fabricated number) when the evidence is too thin.
 */
async function computeDerivedReadiness(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  if (!hasDb(db) || !userId) return null;

  try {
    const tz = await resolveUserTz(db, userId);
    const date = isYmd(cleanStr(opts && opts.date, 10))
      ? cleanStr(opts.date, 10)
      : (toDateStr(opts && opts.date) || todayYmdInTz(tz) || toDateStr(new Date()));
    if (!isYmd(date)) return null;

    const from7 = addCalendarDaysYmd(date, -6);
    const from14 = addCalendarDaysYmd(date, -13);
    const from3 = addCalendarDaysYmd(date, -2);
    if (!from7 || !from14 || !from3) return null;

    const [checkins, goalsRow, workouts, minds] = await Promise.all([
      db.queryAll(
        `SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, COALESCE(is_freeze, FALSE) AS is_freeze
         FROM daily_checkins
         WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date
         ORDER BY checkin_date ASC`,
        [userId, from14, date]
      ).catch(() => []),
      db.queryOne(
        `SELECT COALESCE(goal_water_ml, 3000) AS goal_water_ml,
                COALESCE(goal_protein_g, 120) AS goal_protein_g
         FROM users WHERE id = ?`,
        [userId]
      ).catch(() => null),
      db.queryAll(
        `SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ?)::date AS d,
                COALESCE(duration_seconds, 0) AS duration_seconds,
                COALESCE(intensity, '') AS intensity
         FROM workout_logs
         WHERE user_id = ?
           AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date`,
        [tz, userId, tz, from14, date]
      ).catch(() => []),
      db.queryAll(
        `SELECT checkin_date FROM mind_checkins
         WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date`,
        [userId, from14, date]
      ).catch(() => [])
    ]);

    const byDate = new Map();
    (checkins || []).forEach((r) => {
      const d = toDateStr(r.checkin_date);
      if (d) byDate.set(d, r);
    });
    const today = byDate.get(date) || null;

    const components = [];
    const push = (key, weight, score, detail) => {
      const s = (score == null || !Number.isFinite(score)) ? null : Math.round(clamp(score, 0, 100));
      components.push({
        key,
        label: key.replace(/_/g, ' '),
        weight,
        score: s,
        available: s != null,
        detail: detail || null
      });
    };

    /* 1 — sleep (35) */
    const sleepH = today ? num(today.sleep_hours) : null;
    push('sleep', DERIVED_WEIGHTS.sleep, sleepComponentScore(sleepH),
      sleepH != null ? `${round1(sleepH)}h logged (7-9h optimal)` : 'no sleep logged for this day');

    /* 2 — consistency (20): non-freeze check-in density over the trailing 7 days */
    let realDays = 0;
    let freezeDays = 0;
    for (let i = 0; i < 7; i++) {
      const d = addCalendarDaysYmd(date, -i);
      const row = d ? byDate.get(d) : null;
      if (!row) continue;
      if (row.is_freeze === true) freezeDays += 1; else realDays += 1;
    }
    const hasHistory = byDate.size > 0;
    const consistencyScore = hasHistory
      ? Math.round(((realDays + freezeDays * 0.5) / 7) * 100)
      : null;
    push('consistency', DERIVED_WEIGHTS.consistency, consistencyScore,
      hasHistory ? `${realDays}/7 check-ins${freezeDays ? ` (+${freezeDays} freeze)` : ''}` : 'no check-in history');

    /* 3 — recovery proxy (30): training load vs rest, plus mind check-ins */
    const intensityFactor = (s) => {
      const v = String(s || '').toLowerCase();
      if (v.indexOf('high') >= 0 || v.indexOf('hard') >= 0) return 1.3;
      if (v.indexOf('low') >= 0 || v.indexOf('easy') >= 0) return 0.8;
      return 1;
    };
    const workoutMinutesByDate = new Map();
    let workouts14 = 0;
    (workouts || []).forEach((w) => {
      const d = toDateStr(w.d);
      if (!d) return;
      workouts14 += 1;
      const mins = (num(w.duration_seconds) || 0) / 60 * intensityFactor(w.intensity);
      workoutMinutesByDate.set(d, (workoutMinutesByDate.get(d) || 0) + mins);
    });
    const mindDates = new Set((minds || []).map((m) => toDateStr(m.checkin_date)).filter(Boolean));

    let load3 = 0;
    for (let i = 0; i < 3; i++) {
      const d = addCalendarDaysYmd(date, -i);
      if (d) load3 += workoutMinutesByDate.get(d) || 0;
    }
    let workoutDays7 = 0;
    for (let i = 0; i < 7; i++) {
      const d = addCalendarDaysYmd(date, -i);
      if (d && (workoutMinutesByDate.get(d) || 0) > 0) workoutDays7 += 1;
    }
    const mind14 = mindDates.size;
    const recoveryAvailable = workouts14 > 0 || mind14 > 0;

    let recoveryScoreProxy = null;
    let recoveryDetail = 'no training or mind data in the last 14 days';
    if (recoveryAvailable) {
      const base = 70;
      // 120 min of load in 3 days is free; every further 6 min costs a point, capped at 30.
      let penalty = clamp((load3 - 120) / 6, 0, 30) || 0;
      if (workoutDays7 >= 6) penalty += 8; // no rest day in the week
      const yesterday = addCalendarDaysYmd(date, -1);
      const restedToday = (workoutMinutesByDate.get(date) || 0) === 0;
      const restedYesterday = yesterday ? (workoutMinutesByDate.get(yesterday) || 0) === 0 : false;
      const restBonus = (restedToday && restedYesterday) ? 10 : (restedToday ? 5 : 0);
      let mindBonus = 0;
      if (mindDates.has(date)) mindBonus = 10;
      else if ([1, 2].some((i) => mindDates.has(addCalendarDaysYmd(date, -i)))) mindBonus = 5;
      recoveryScoreProxy = base - penalty + restBonus + mindBonus;
      recoveryDetail = `${Math.round(load3)} load-min over 3d, ${workoutDays7}/7 training days`
        + (mindBonus ? `, mind check-in bonus +${mindBonus}` : '');
    }
    push('recovery_proxy', DERIVED_WEIGHTS.recovery_proxy, recoveryScoreProxy, recoveryDetail);

    /* 4 — adherence (15): hydration + protein vs goals */
    const goalWater = (goalsRow && num(goalsRow.goal_water_ml)) || 3000;
    const goalProtein = (goalsRow && num(goalsRow.goal_protein_g)) || 120;
    const water = today ? num(today.water_ml) : null;
    const protein = today ? num(today.protein_g) : null;
    const ratios = [];
    if (water != null && goalWater > 0) ratios.push(clamp(water / goalWater, 0, 1));
    if (protein != null && goalProtein > 0) ratios.push(clamp(protein / goalProtein, 0, 1));
    const adherenceScore = ratios.length
      ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100)
      : null;
    push('adherence', DERIVED_WEIGHTS.adherence, adherenceScore,
      ratios.length
        ? `water ${water != null ? water : '-'}/${goalWater}ml, protein ${protein != null ? protein : '-'}/${goalProtein}g`
        : 'no hydration/protein logged');

    /* Aggregate — rescale to the weight that actually had evidence. */
    const present = components.filter((c) => c.available);
    const availableWeight = present.reduce((a, c) => a + c.weight, 0);
    if (present.length < DERIVED_MIN_COMPONENTS || availableWeight < DERIVED_MIN_AVAILABLE_WEIGHT) {
      return null; // insufficient data — refuse to fabricate a score
    }
    const weighted = present.reduce((a, c) => a + c.score * c.weight, 0);
    const readinessScore = Math.round(clamp(weighted / availableWeight, 0, 100));
    // LOW by design: 0.45 (2 of 4 components) … 0.60 (all four).
    const confidence = Math.round((0.4 + 0.2 * (present.length / components.length)) * 100) / 100;

    const values = {
      readiness_score: readinessScore,
      confidence,
      sleep_hours: sleepH != null ? sleepH : null
    };

    let written = false;
    try {
      await upsertReadinessDay(db, {
        userId,
        date,
        source: 'derived',
        values,
        sourceUploadId: null,
        raw: {
          formulaVersion: DERIVED_FORMULA_VERSION,
          weights: DERIVED_WEIGHTS,
          availableWeight,
          components
        }
      });
      written = true;
    } catch (e) {
      console.warn('[readiness] derived upsert failed:', e && e.message);
    }

    return {
      ok: true,
      userId,
      date,
      source: 'derived',
      readinessScore,
      confidence,
      availableWeight,
      componentsWithData: present.length,
      components,
      formulaVersion: DERIVED_FORMULA_VERSION,
      written
    };
  } catch (err) {
    console.warn('[readiness] computeDerivedReadiness failed:', err && err.message);
    return null;
  }
}

/* ────────────────────────────── resolved reads ────────────────────────────── */

function mapReadinessRow(row) {
  if (!row) return null;
  const out = {
    userId: row.user_id,
    date: toDateStr(row.date),
    source: row.source || null,
    sourcePriority: SOURCE_PRECEDENCE[row.source] || 9,
    sourceUploadId: row.source_upload_id || null,
    updatedAt: row.updated_at || null
  };
  METRIC_COLUMNS.forEach((c) => {
    const v = num(row[c]);
    out[COLUMN_TO_CAMEL[c] || c] = v;
  });
  // Text columns pass through unchanged — num() would erase them.
  TEXT_COLUMNS.forEach((c) => {
    const v = row[c] == null || row[c] === '' ? null : String(row[c]);
    out[COLUMN_TO_CAMEL[c] || c] = v;
  });
  // A whoop export gives recovery_score, the derived path gives readiness_score.
  // Downstream code should read `score` and stop caring which one it was.
  out.score = out.readinessScore != null ? out.readinessScore : out.recoveryScore;
  out.raw = row.raw_json || null;
  return out;
}

const SELECT_COLS = `user_id, date, source, source_upload_id, updated_at, raw_json, ${METRIC_COLUMNS.concat(TEXT_COLUMNS).join(', ')}`;

/**
 * The ONE function every downstream feature calls.
 * Resolves a single day using strict precedence whoop > manual > derived.
 * @returns {Promise<Object|null>} resolved row, or null when nothing exists for that date.
 */
async function getReadiness(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  if (!hasDb(db) || !userId) return null;
  try {
    let date = isYmd(cleanStr(opts && opts.date, 10)) ? cleanStr(opts.date, 10) : toDateStr(opts && opts.date);
    if (!date) date = todayYmdInTz(await resolveUserTz(db, userId)) || toDateStr(new Date());
    if (!isYmd(date)) return null;

    const row = await db.queryOne(
      `SELECT ${SELECT_COLS}
       FROM readiness_daily
       WHERE user_id = ? AND date = ?::date
       ORDER BY ${SOURCE_PRECEDENCE_SQL} ASC, updated_at DESC
       LIMIT 1`,
      [userId, date]
    );
    return mapReadinessRow(row);
  } catch (err) {
    console.warn('[readiness] getReadiness failed:', err && err.message);
    return null;
  }
}

/**
 * Resolved rows for a date window, ascending, one row per date, precedence applied per-date.
 * @returns {Promise<Array>} always an array (empty on error).
 */
async function getReadinessRange(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  if (!hasDb(db) || !userId) return [];
  try {
    let from = isYmd(cleanStr(opts && opts.from, 10)) ? cleanStr(opts.from, 10) : toDateStr(opts && opts.from);
    let to = isYmd(cleanStr(opts && opts.to, 10)) ? cleanStr(opts.to, 10) : toDateStr(opts && opts.to);
    if (!from && !to) return [];
    if (!from) from = to;
    if (!to) to = from;
    if (!isYmd(from) || !isYmd(to)) return [];
    if (from > to) { const t = from; from = to; to = t; }
    const span = daysBetween(from, to);
    if (span != null && span > 730) from = addCalendarDaysYmd(to, -730) || from; // hard cap

    const rows = await db.queryAll(
      `SELECT DISTINCT ON (date) ${SELECT_COLS}
       FROM readiness_daily
       WHERE user_id = ? AND date BETWEEN ?::date AND ?::date
       ORDER BY date ASC, ${SOURCE_PRECEDENCE_SQL} ASC, updated_at DESC`,
      [userId, from, to]
    );
    return (rows || []).map(mapReadinessRow).filter(Boolean);
  } catch (err) {
    console.warn('[readiness] getReadinessRange failed:', err && err.message);
    return [];
  }
}

/* ────────────────────────────── auto-populate check-in ────────────────────────────── */

/**
 * Fill daily_checkins.sleep_hours from the member's Whoop row.
 *
 * HARD RULE: never overwrite a value the member typed. The UPDATE is guarded by
 * `AND sleep_hours IS NULL`, so a member-entered value (or a previously auto-filled one)
 * always wins. Idempotent and non-throwing.
 *
 * @returns {Promise<{filled:boolean, field:string, value:number|null, reason?:string}>}
 */
async function autoPopulateCheckin(db, opts) {
  const field = 'sleep_hours';
  const userId = cleanStr(opts && opts.userId, 100);
  if (!hasDb(db) || !userId) return { filled: false, field, value: null, reason: 'invalid_input' };

  try {
    let date = isYmd(cleanStr(opts && opts.date, 10)) ? cleanStr(opts.date, 10) : toDateStr(opts && opts.date);
    if (!date) date = todayYmdInTz(await resolveUserTz(db, userId)) || toDateStr(new Date());
    if (!isYmd(date)) return { filled: false, field, value: null, reason: 'invalid_date' };

    const src = await db.queryOne(
      `SELECT sleep_hours FROM readiness_daily
       WHERE user_id = ? AND date = ?::date AND source = 'whoop'
       LIMIT 1`,
      [userId, date]
    );
    const value = src ? num(src.sleep_hours) : null;
    if (value == null || value <= 0 || value > 24) {
      return { filled: false, field, value: null, reason: 'no_wearable_value' };
    }
    const rounded = round1(value);

    // Create the day's row only when we actually have something to put in it.
    try {
      await db.run(
        `INSERT INTO daily_checkins (id, user_id, checkin_date, is_freeze)
         VALUES (?, ?, ?::date, FALSE)
         ON CONFLICT (user_id, checkin_date) DO NOTHING`,
        [uuidv4(), userId, date]
      );
    } catch (e) {
      // Unique index missing or a race — the guarded UPDATE below still behaves correctly.
      console.warn('[readiness] autoPopulateCheckin insert skipped:', e && e.message);
    }

    const upd = await db.run(
      `UPDATE daily_checkins
       SET ${field} = ?
       WHERE user_id = ? AND checkin_date = ?::date AND ${field} IS NULL`,
      [rounded, userId, date]
    );
    const filled = !!(upd && upd.rowCount);
    return {
      filled,
      field,
      value: filled ? rounded : null,
      date,
      reason: filled ? undefined : 'member_value_present'
    };
  } catch (err) {
    console.warn('[readiness] autoPopulateCheckin failed:', err && err.message);
    return { filled: false, field, value: null, reason: 'error' };
  }
}

/* ────────────────────────────── exports ────────────────────────────── */

module.exports = {
  // schema
  ensureReadinessTables,
  // opt-in / connections
  optIn,
  optOut,
  getConnection,
  purgeProviderData,
  // uploads
  previewUpload,
  commitUpload,
  // derived (non-wearable) path
  computeDerivedReadiness,
  // resolved reads — the only functions downstream features should need
  getReadiness,
  getReadinessRange,
  // check-in bridge
  autoPopulateCheckin,
  // constants (exported for tests / UI copy)
  DEFAULT_PROVIDER,
  SOURCE_PRECEDENCE,
  DERIVED_WEIGHTS,
  DERIVED_FORMULA_VERSION,
  METRIC_COLUMNS,
  // internals worth unit-testing
  normalizeParsedDay,
  normalizeParsed,
  sleepComponentScore
};
