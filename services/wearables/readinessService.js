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
/**
 * Every provider we accept. MUST stay in sync with PROVIDERS in
 * services/wearables/canonicalDay.js — a value present there but missing here is
 * rejected by normalizeProvider() and the member's upload silently writes nothing.
 */
const VALID_PROVIDERS = [
  'whoop', 'oura', 'garmin', 'fitbit', 'polar',
  'apple_health', 'health_connect', 'samsung_health', 'amazfit',
  'generic_csv', 'screenshot', 'manual', 'derived'
];

/**
 * Strict resolution order used by getReadiness()/getReadinessRange(). Lower = wins.
 *
 * Ordered by strength of evidence, not by brand preference:
 *   1-5   vendor structured exports, richest first (recovery + HRV + staged sleep)
 *   6-9   platform aggregates — real measurements, but already re-aggregated by
 *         Apple/Google/Samsung before we see them, so one layer further from source
 *   10-11 a generic CSV or a number the member typed; both are honest but unverified
 *   12    a figure an LLM read off a screenshot — real data, weakest evidence
 *   13    a score BodyBank computed itself, which must never outrank a measurement
 *
 * `manual` deliberately outranks `screenshot`: a member reading their own app and
 * typing the number is better evidence than a model reading a photo of it. The
 * historic ranks of whoop/manual/derived (1/2/3) are preserved relative to each
 * other, so no existing member's resolved day changes meaning.
 */
const SOURCE_PRECEDENCE = {
  whoop: 1,
  oura: 2,
  garmin: 3,
  fitbit: 4,
  polar: 5,
  apple_health: 6,
  health_connect: 7,
  samsung_health: 8,
  amazfit: 9,
  generic_csv: 10,
  manual: 11,
  screenshot: 12,
  derived: 13
};
// Built from the map above so the two can never drift apart. An unranked source
// still lands in the ELSE 99 bucket where ties break on updated_at alone.
const SOURCE_PRECEDENCE_SQL = `CASE source\n    ${Object.keys(SOURCE_PRECEDENCE)
  .map((p) => `WHEN '${p}' THEN ${SOURCE_PRECEDENCE[p]}`)
  .join('\n    ')}\n    ELSE 99 END`;

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
  'avg_hr',
  // ── multi-device additions ──
  // A temperature DEVIATION from the member's own baseline, which is what Fitbit
  // and Apple report. It gets its own column rather than sharing skin_temp_c
  // because a -0.4 deviation stored as an absolute reads as hypothermia, and
  // because the two can never be averaged into one series. `temp_basis` below
  // says which of the two a row actually carries.
  'skin_temp_deviation_c',
  // Whoop has no step counter, so these are null for every Whoop day; most other
  // devices supply them and the derived readiness path can use them as an
  // activity signal where strain is unavailable.
  'steps',
  'active_minutes'
];

/**
 * Non-numeric readiness columns. These bypass the numeric coercion applied to
 * METRIC_COLUMNS — running num('C') would yield null and silently drop the unit,
 * which is exactly the provenance we are trying to preserve.
 *
 * The multi-device tags are the load-bearing part of rule 6 in canonicalDay.js:
 * without `hrv_method` we cannot know whether two HRV numbers may be compared
 * (Apple reports SDNN from a 60s spot check, Whoop reports overnight RMSSD, and
 * charting them as one series invents a cliff the member never experienced).
 */
const TEXT_COLUMNS = [
  'skin_temp_unit',
  'hrv_method', // canonicalDay.HRV_METHOD — required whenever hrv_ms is set
  'temp_basis', // canonicalDay.TEMP_BASIS — required whenever a temperature is set
  'measurement_source', // canonicalDay.MEASUREMENT_SOURCE — how this day reached us
  'device_model' // e.g. 'Apple Watch Series 9'; free text, frequently null
];

/**
 * Per-column length caps for TEXT_COLUMNS. The historic blanket cap was 16
 * characters, which is right for a unit tag and would truncate a device name
 * ('Apple Watch Series 9' is 20) into something the member would not recognise.
 */
const TEXT_COLUMN_MAX = { device_model: 80 };
const TEXT_COLUMN_DEFAULT_MAX = 24;

/** Numeric columns of wearable_workouts, in insert order. */
const WORKOUT_METRIC_COLUMNS = [
  'duration_min',
  'strain',
  'energy_kcal',
  'max_hr',
  'avg_hr',
  'zone1_min',
  'zone2_min',
  'zone3_min',
  'zone4_min',
  'zone5_min'
];

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
  avg_hr: 'avgHr',
  skin_temp_deviation_c: 'skinTempDeviationC',
  steps: 'steps',
  active_minutes: 'activeMinutes',
  hrv_method: 'hrvMethod',
  temp_basis: 'tempBasis',
  measurement_source: 'measurementSource',
  device_model: 'deviceModel'
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
  // ── multi-device provenance (canonicalDay.js rule 6) ──
  // Without these aliases an adapter's tags fall through to `unknown`, are reported
  // as unrecognised columns on EVERY import, and — far worse — are never persisted,
  // so an Apple SDNN row would land in the database indistinguishable from a Whoop
  // RMSSD row. These entries are what make the tags durable.
  skin_temp_deviation_c: ['skin_temp_deviation_c', 'skinTempDeviationC', 'skin temp deviation', 'temperature deviation', 'temp deviation (c)'],
  steps: ['steps', 'step count', 'step_count', 'stepCount', 'total steps'],
  active_minutes: ['active_minutes', 'activeMinutes', 'active minutes', 'active zone minutes', 'exercise minutes', 'move minutes'],
  hrv_method: ['hrv_method', 'hrvMethod', 'hrv method'],
  temp_basis: ['temp_basis', 'tempBasis', 'temp basis', 'temperature basis'],
  measurement_source: ['measurement_source', 'measurementSource', 'measurement source'],
  device_model: ['device_model', 'deviceModel', 'device model', 'device'],
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
    'workout count', 'activity name', 'nap flag', 'is nap', 'raw', 'raw_json',
    // whoopParser emits sleepMinutes alongside sleepHours. Without this entry it is
    // reported as an unrecognised column on EVERY import, which is noise on top of
    // the signal that actually matters (Whoop changing their export format).
    'sleepMinutes',
    // Device-native scores (canonicalDay rule 6) are deliberately NOT given a
    // column of their own: 'garmin.body_battery' and 'fitbit.sleep_score' are not
    // the same measurement and must never be charted against each other. They ride
    // along in raw_json, which upsertDayParams already persists verbatim, and are
    // surfaced on read as `providerScores`. Listing them here keeps them out of the
    // unknown-column warning without discarding them.
    'providerScores', 'provider_scores',
    // Adapter bookkeeping that is meaningful in the payload but is not a column.
    'attributedFrom', 'kind', 'isNap', 'cycleStart', 'cycleStartEpochMs'
  ]
};

/**
 * Anything above this is a unit error, not a night's sleep. Whoop's export units
 * drift with account settings; a seconds-as-minutes column yields 450 "hours",
 * which would then be averaged into the member's PDF as fact.
 */
const MAX_SLEEP_HOURS = 24;

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

/**
 * Unknown providers are rejected (null), not passed through. An unrecognised value
 * in `source` lands in the ELSE 9 bucket of SOURCE_PRECEDENCE_SQL where ties break on
 * updated_at alone, so one typo would quietly reorder every resolved read.
 */
function normalizeProvider(p) {
  const s = cleanStr(p, 40);
  if (!s) return DEFAULT_PROVIDER;
  const low = s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return VALID_PROVIDERS.includes(low) ? low : null;
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

/** Split rows into fixed-size batches so one statement never nears pg's 65535-param cap. */
function chunkRows(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Run a multi-row statement in batches. A failed batch is retried row-by-row so one
 * malformed record can never cost the other 99 in its chunk. `buildSql(n)` returns the
 * statement for n VALUES tuples, `buildParams(row)` the params for one tuple.
 * @returns {Promise<{written:number, failed:number, failedRows:Array}>}
 */
async function runChunked(db, { rows, size, buildSql, buildParams, label }) {
  const list = Array.isArray(rows) ? rows : [];
  let written = 0;
  const failedRows = [];
  for (const part of chunkRows(list, size)) {
    try {
      const params = [];
      part.forEach((r) => buildParams(r).forEach((p) => params.push(p)));
      await db.run(buildSql(part.length), params);
      written += part.length;
    } catch (e) {
      console.warn(`[readiness] ${label} batch failed, retrying row-by-row:`, e && e.message);
      for (const r of part) {
        try {
          await db.run(buildSql(1), buildParams(r));
          written += 1;
        } catch (e2) {
          failedRows.push(r);
          console.warn(`[readiness] ${label} row failed:`, e2 && e2.message);
        }
      }
    }
  }
  return { written, failed: failedRows.length, failedRows };
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

    // Workouts and journal answers are parsed on every import and were previously
    // counted and thrown away. `started_at` / `ended_at` are TEXT, not TIMESTAMPTZ:
    // whoopParser emits an ISO instant when the row declared a zone and a bare
    // YYYY-MM-DD when it did not, and casting the latter would invent a wall-clock
    // time. `workout_key` is the natural key (started_at + activity) computed on the
    // JS side because a NULL activity would defeat a plain UNIQUE constraint.
    await db.run(`CREATE TABLE IF NOT EXISTS wearable_workouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'whoop',
      date DATE NOT NULL,
      workout_key TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      duration_min REAL,
      activity TEXT,
      strain REAL,
      energy_kcal REAL,
      max_hr REAL,
      avg_hr REAL,
      zone1_min REAL,
      zone2_min REAL,
      zone3_min REAL,
      zone4_min REAL,
      zone5_min REAL,
      source_upload_id TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, provider, workout_key)
    )`);

    // `answer` keeps the verbatim text; `answer_bool` is set only when the parser
    // recognised a yes/no. A free-text answer therefore stays readable instead of
    // being coerced into a boolean it never was.
    await db.run(`CREATE TABLE IF NOT EXISTS wearable_journal (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'whoop',
      date DATE NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      answer_bool BOOLEAN,
      notes TEXT,
      source_upload_id TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, provider, date, question)
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
      ['wearable_connections', 'fk_wearable_connections_user', 'user_id'],
      ['wearable_workouts', 'fk_wearable_workouts_user', 'user_id'],
      ['wearable_journal', 'fk_wearable_journal_user', 'user_id']
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
      `ALTER TABLE wearable_connections ADD COLUMN IF NOT EXISTS opted_in_at TIMESTAMPTZ`,
      `ALTER TABLE wearable_workouts ADD COLUMN IF NOT EXISTS source_upload_id TEXT`,
      `ALTER TABLE wearable_workouts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`,
      `ALTER TABLE wearable_journal ADD COLUMN IF NOT EXISTS answer_bool BOOLEAN`,
      `ALTER TABLE wearable_journal ADD COLUMN IF NOT EXISTS source_upload_id TEXT`,
      `ALTER TABLE wearable_journal ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`
    ];
    WORKOUT_METRIC_COLUMNS.forEach((c) => adds.push(`ALTER TABLE wearable_workouts ADD COLUMN IF NOT EXISTS ${c} REAL`));
    METRIC_COLUMNS.forEach((c) => adds.push(`ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS ${c} REAL`));
    TEXT_COLUMNS.forEach((c) => adds.push(`ALTER TABLE readiness_daily ADD COLUMN IF NOT EXISTS ${c} TEXT`));
    for (const sql of adds) {
      try { await db.run(sql); } catch (e) { /* column may already exist */ }
    }

    const idx = [
      `CREATE INDEX IF NOT EXISTS idx_readiness_daily_user_date ON readiness_daily(user_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_readiness_daily_user_source ON readiness_daily(user_id, source)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_uploads_user ON wearable_uploads(user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_rows_rejected_upload ON wearable_rows_rejected(upload_id)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_workouts_user_date ON wearable_workouts(user_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_workouts_upload ON wearable_workouts(source_upload_id)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_journal_user_date ON wearable_journal(user_id, date DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_wearable_journal_upload ON wearable_journal(source_upload_id)`
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
    // These two are load-bearing, not tidiness: they are the ON CONFLICT targets that
    // make a re-uploaded overlapping export update rather than duplicate.
    try {
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wearable_workouts_upk ON wearable_workouts(user_id, provider, workout_key)`);
    } catch (e) { /* constraint already provides it */ }
    try {
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wearable_journal_updq ON wearable_journal(user_id, provider, date, question)`);
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
  if (!hasDb(db) || !userId || !provider) return { ok: false, reason: 'invalid_input', connection: null };
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
  if (!hasDb(db) || !userId || !provider) return { ok: false, reason: 'invalid_input' };
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
  if (!hasDb(db) || !userId || !provider) return { ok: false, reason: 'invalid_input' };
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
  if (!hasDb(db) || !userId || !provider) return { ok: false, reason: 'invalid_input' };
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
    const workouts = await db.run(
      `DELETE FROM wearable_workouts WHERE user_id = ? AND provider = ?`,
      [userId, provider]
    );
    const journal = await db.run(
      `DELETE FROM wearable_journal WHERE user_id = ? AND provider = ?`,
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
      workoutsDeleted: (workouts && workouts.rowCount) || 0,
      journalRowsDeleted: (journal && journal.rowCount) || 0,
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
 * @returns {{date:string|null, values:Object, unknown:string[], implausible:Object[]}}
 */
function normalizeParsedDay(day) {
  const out = { date: null, values: {}, unknown: [], implausible: [] };
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
      if (s) out.values[target] = s.slice(0, TEXT_COLUMN_MAX[target] || TEXT_COLUMN_DEFAULT_MAX);
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
  // A duration that cannot be a night's sleep is a unit error. Drop it rather than
  // store it: the value is used by the stats engine and printed in the member's PDF,
  // and "we don't know" is honest where "450 hours" is not.
  if (out.values.sleep_hours != null && (out.values.sleep_hours <= 0 || out.values.sleep_hours > MAX_SLEEP_HOURS)) {
    out.implausible.push({ field: 'sleep_hours', value: out.values.sleep_hours });
    delete out.values.sleep_hours;
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
  const implausible = [];

  // whoopParser seeds napMinutes at 0 rather than null, so a cycles-only export
  // reports "0 naps" for every day. Because the upsert only COALESCEs over NULL,
  // that 0 would overwrite a real nap stored by an earlier full import. When no
  // sleeps file contributed to this payload we cannot know the nap total, so the
  // 0 is dropped as the placeholder it is.
  const filesSeen = (parsed && parsed.summary && Array.isArray(parsed.summary.filesSeen)) ? parsed.summary.filesSeen : [];
  const hasSleepFile = filesSeen.some((f) => f && f.kind === 'sleeps' && (f.rowsParsed || 0) > 0);

  days.forEach((d) => {
    const n = normalizeParsedDay(d);
    n.unknown.forEach((u) => unknown.add(u));
    n.implausible.forEach((x) => implausible.push(Object.assign({ date: n.date }, x)));
    if (!hasSleepFile && n.values.nap_min === 0) delete n.values.nap_min;
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
  // whoopParser reports these as { file, kind, column } objects; older/looser callers
  // pass bare strings. Running cleanStr over an object yields the literal
  // "[object Object]", which is then persisted into wearable_uploads.summary_json and
  // destroys the only early warning we get that Whoop changed their export format.
  fromParser.forEach((u) => {
    const s = cleanStr((u && typeof u === 'object') ? u.column : u, 120);
    if (s) unknown.add(s);
  });

  const rows = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dateRange = rows.length ? { from: rows[0].date, to: rows[rows.length - 1].date } : { from: null, to: null };

  const rejectedIn = (parsed && Array.isArray(parsed.rejected)) ? parsed.rejected : [];
  return {
    rows,
    dateRange,
    unknownColumns: Array.from(unknown).slice(0, 200),
    undated,
    implausible: implausible.slice(0, 200),
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
/** The same statement for n VALUES tuples — one round-trip per batch instead of per day. */
function buildUpsertSql(n) {
  const tuples = new Array(n).fill(`(${UPSERT_PLACEHOLDERS})`).join(', ');
  return `INSERT INTO readiness_daily (${UPSERT_COLS.join(', ')})
     VALUES ${tuples}
     ON CONFLICT (user_id, date, source) DO UPDATE SET
         ${UPSERT_SET}`;
}
const UPSERT_SQL = buildUpsertSql(1);

/** Days per INSERT. 31 params each, so 100 stays far below pg's 65535 cap. */
const DAY_BATCH_SIZE = 100;

function upsertDayParams({ userId, date, source, values, sourceUploadId, raw }) {
  const params = [uuidv4(), userId, date, source];
  METRIC_COLUMNS.forEach((c) => params.push(values && values[c] != null ? Number(values[c]) : null));
  // Text columns are pushed verbatim — Number() here would null them out.
  TEXT_COLUMNS.forEach((c) => params.push(values && values[c] != null ? String(values[c]) : null));
  params.push(sourceUploadId || null);
  params.push(safeJson(raw || {}));
  return params;
}

/**
 * Upsert one resolved day. Existing non-null values survive a null in the incoming row
 * (a partial re-export must never erase history); non-null incoming values always win.
 */
async function upsertReadinessDay(db, opts) {
  return db.run(UPSERT_SQL, upsertDayParams(opts));
}

/* ────────────────────────────── workouts / journal ────────────────────────────── */

const WORKOUT_COLS = ['id', 'user_id', 'provider', 'date', 'workout_key', 'started_at', 'ended_at', 'activity']
  .concat(WORKOUT_METRIC_COLUMNS, ['source_upload_id']);
const WORKOUT_PLACEHOLDERS = WORKOUT_COLS.map((c) => (c === 'date' ? '?::date' : '?')).join(', ');
const WORKOUT_SET = ['started_at', 'ended_at', 'activity']
  .concat(WORKOUT_METRIC_COLUMNS, ['source_upload_id'])
  .map((c) => `${c} = COALESCE(EXCLUDED.${c}, wearable_workouts.${c})`)
  .concat(['updated_at = CURRENT_TIMESTAMP'])
  .join(',\n         ');

function buildWorkoutSql(n) {
  const tuples = new Array(n).fill(`(${WORKOUT_PLACEHOLDERS})`).join(', ');
  return `INSERT INTO wearable_workouts (${WORKOUT_COLS.join(', ')})
     VALUES ${tuples}
     ON CONFLICT (user_id, provider, workout_key) DO UPDATE SET
         ${WORKOUT_SET}`;
}

const JOURNAL_COLS = ['id', 'user_id', 'provider', 'date', 'question', 'answer', 'answer_bool', 'notes', 'source_upload_id'];
const JOURNAL_PLACEHOLDERS = JOURNAL_COLS.map((c) => (c === 'date' ? '?::date' : '?')).join(', ');
const JOURNAL_SET = ['answer', 'answer_bool', 'notes', 'source_upload_id']
  .map((c) => `${c} = COALESCE(EXCLUDED.${c}, wearable_journal.${c})`)
  .concat(['updated_at = CURRENT_TIMESTAMP'])
  .join(',\n         ');

function buildJournalSql(n) {
  const tuples = new Array(n).fill(`(${JOURNAL_PLACEHOLDERS})`).join(', ');
  return `INSERT INTO wearable_journal (${JOURNAL_COLS.join(', ')})
     VALUES ${tuples}
     ON CONFLICT (user_id, provider, date, question) DO UPDATE SET
         ${JOURNAL_SET}`;
}

/** 19 / 9 params per row — 100 and 200 both stay far below pg's 65535 cap. */
const WORKOUT_BATCH_SIZE = 100;
const JOURNAL_BATCH_SIZE = 200;

/** Does this start stamp carry a time of day, or only a calendar date? */
const HAS_CLOCK_TIME = /\d{1,2}:\d{2}/;

/**
 * The natural key written to workout_key.
 *
 * A start stamp with a time of day identifies the session on its own. Without one it
 * does not: the parser falls back to a bare YYYY-MM-DD whenever the export carries no
 * timezone (whoopParser drops the wall clock it cannot place), and every PDF row is
 * dated but untimed. Two runs on the same day then shared `date|Running`, the second
 * overwrote the first, and the member was never told. So an untimed key also carries
 * the row's own figures: two different sessions stay two rows, while the SAME session
 * re-uploaded still lands on the same key and updates in place.
 */
function workoutKey(date, startedAt, activity, values) {
  const stamp = startedAt || date;
  const base = `${stamp}|${activity || ''}`;
  if (HAS_CLOCK_TIME.test(stamp)) return base;
  const figures = WORKOUT_METRIC_COLUMNS
    .map((c) => (values[c] == null ? '' : String(values[c])))
    .join(',');
  return `${base}|${figures}`;
}

/**
 * One parsed workout -> a persistable row, or null when it carries no usable date.
 * `key` is the natural key written to workout_key: `activity` is often null and a NULL
 * inside a UNIQUE constraint never conflicts, so the key is materialised as text and
 * a re-uploaded overlapping export updates its rows instead of duplicating them.
 */
function normalizeWorkout(w) {
  if (!w || typeof w !== 'object') return null;
  const date = toDateStr(w.date);
  if (!isYmd(date)) return null;
  const startedAt = cleanStr(w.startedAt, 40);
  const activity = cleanStr(w.activity, 120);
  const zones = (w.zones && typeof w.zones === 'object') ? w.zones : {};
  const values = {
    duration_min: num(w.durationMin),
    strain: num(w.strain),
    energy_kcal: num(w.energyKcal),
    max_hr: num(w.maxHr),
    avg_hr: num(w.avgHr),
    zone1_min: num(zones.z1),
    zone2_min: num(zones.z2),
    zone3_min: num(zones.z3),
    zone4_min: num(zones.z4),
    zone5_min: num(zones.z5)
  };
  return {
    date,
    key: workoutKey(date, startedAt, activity, values),
    startedAt,
    endedAt: cleanStr(w.endedAt, 40),
    activity,
    values
  };
}

/**
 * One parsed journal row -> a persistable row, or null when it has no date or no
 * question (without both there is no natural key, so it could only ever duplicate).
 * The parser hands back a boolean when it recognised a yes/no and the raw string
 * otherwise; both are kept — the text verbatim, the boolean separately.
 */
function normalizeJournalEntry(j) {
  if (!j || typeof j !== 'object') return null;
  const date = toDateStr(j.date);
  const question = cleanStr(j.question, 300);
  if (!isYmd(date) || !question) return null;
  return {
    date,
    question,
    answer: cleanStr(j.answer, 500),
    answerBool: typeof j.answer === 'boolean' ? j.answer : null,
    notes: cleanStr(j.notes, 2000)
  };
}

/** Persist parsed workouts for one upload. De-duplicated by natural key before writing. */
async function persistWorkouts(db, { userId, provider, uploadId, workouts }) {
  const list = Array.isArray(workouts) ? workouts : [];
  const byKey = new Map();
  let skipped = 0;
  let collapsed = 0;
  list.forEach((w) => {
    const n = normalizeWorkout(w);
    if (!n) { skipped += 1; return; }
    // Two tuples with the same conflict key in ONE statement is a pg error, not a
    // merge — collapse them here, last occurrence wins. Counted, because a row that
    // silently stops existing between the preview count and the database is the one
    // loss the member can never see.
    if (byKey.has(n.key)) collapsed += 1;
    byKey.set(n.key, n);
  });
  const rows = Array.from(byKey.values());
  if (!rows.length) return { written: 0, failed: 0, skipped: skipped + collapsed, collapsed };

  const res = await runChunked(db, {
    rows,
    size: WORKOUT_BATCH_SIZE,
    label: 'workouts',
    buildSql: buildWorkoutSql,
    buildParams: (r) => {
      const params = [uuidv4(), userId, provider, r.date, r.key, r.startedAt, r.endedAt, r.activity];
      WORKOUT_METRIC_COLUMNS.forEach((c) => params.push(r.values[c] != null ? Number(r.values[c]) : null));
      params.push(uploadId || null);
      return params;
    }
  });
  return { written: res.written, failed: res.failed, skipped: skipped + collapsed, collapsed };
}

/** Persist parsed journal answers for one upload. De-duplicated by (date, question). */
async function persistJournal(db, { userId, provider, uploadId, journal }) {
  const list = Array.isArray(journal) ? journal : [];
  const byKey = new Map();
  let skipped = 0;
  list.forEach((j) => {
    const n = normalizeJournalEntry(j);
    if (!n) { skipped += 1; return; }
    byKey.set(`${n.date}|${n.question}`, n);
  });
  const rows = Array.from(byKey.values());
  if (!rows.length) return { written: 0, failed: 0, skipped };

  const res = await runChunked(db, {
    rows,
    size: JOURNAL_BATCH_SIZE,
    label: 'journal',
    buildSql: buildJournalSql,
    buildParams: (r) => [
      uuidv4(), userId, provider, r.date, r.question, r.answer, r.answerBool, r.notes, uploadId || null
    ]
  });
  return { written: res.written, failed: res.failed, skipped };
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
      // Only a fully committed upload counts as a duplicate — an interrupted one is
      // resumable, and telling the member "nothing changed" would strand their data.
      const dup = await db.queryOne(
        `SELECT id FROM wearable_uploads WHERE user_id = ? AND file_sha256 = ? AND status = 'committed'`,
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
      implausibleValues: n.implausible.length,
      workouts: Array.isArray(parsed.workouts) ? parsed.workouts.length : 0,
      journal: Array.isArray(parsed.journal) ? parsed.journal.length : 0,
      duplicate
    };
  } catch (err) {
    console.warn('[readiness] previewUpload failed:', err && err.message);
    return { ok: false, reason: 'query_failed', error: err && err.message, totalDays: 0, newDays: 0, existingDays: 0, rowsRejected: 0, dateRange: { from: null, to: null }, unknownColumns: [] };
  }
}

const REJECTED_COLS = ['id', 'upload_id', 'user_id', 'file_name', 'row_number', 'reason', 'raw_json'];
const REJECTED_PLACEHOLDERS = REJECTED_COLS.map((c) => (c === 'raw_json' ? '?::jsonb' : '?')).join(', ');
const REJECTED_BATCH_SIZE = 100;

function buildRejectedSql(n) {
  const tuples = new Array(n).fill(`(${REJECTED_PLACEHOLDERS}, CURRENT_TIMESTAMP)`).join(', ');
  return `INSERT INTO wearable_rows_rejected (${REJECTED_COLS.join(', ')}, created_at)
     VALUES ${tuples}`;
}

/**
 * Commit a parsed wearable export.
 * Re-uploading a byte-identical file is a no-op: `{ duplicate:true, uploadId }`.
 *
 * The upload row is written as `status:'pending'` and only promoted to `'committed'`
 * once every day, workout and journal row has landed. That ordering matters: the row
 * used to be inserted as committed BEFORE the writes, so an export that died halfway
 * (proxy timeout, deploy, OOM) left the file recorded as imported — and the member's
 * re-upload was then answered "you have already uploaded this export", stranding the
 * missing days for good. A pending row is instead resumed by the next upload of the
 * same file; every write below is an idempotent upsert, so resuming is safe.
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
      `SELECT id, status FROM wearable_uploads WHERE user_id = ? AND file_sha256 = ?`,
      [userId, sha256]
    );
    if (existing && String(existing.status || '') === 'committed') {
      return { ok: true, duplicate: true, uploadId: existing.id };
    }

    const n = normalizeParsed(parsed);
    const rejected = n.rejected || [];
    const rowsRejected = rejected.length + n.undated;

    const summary = Object.assign(
      {},
      (parsed.summary && typeof parsed.summary === 'object') ? parsed.summary : {},
      {
        days: n.rows.length,
        undatedRows: n.undated,
        unknownColumns: n.unknownColumns,
        implausibleValues: n.implausible,
        workouts: Array.isArray(parsed.workouts) ? parsed.workouts.length : 0,
        journal: Array.isArray(parsed.journal) ? parsed.journal.length : 0
      }
    );

    // Resuming an interrupted upload keeps its id so the rows it already wrote stay
    // attributed to it; a fresh one claims a new id.
    const uploadId = existing ? existing.id : uuidv4();
    const resumed = !!existing;
    if (!existing) {
      const ins = await db.run(
        `INSERT INTO wearable_uploads
           (id, user_id, provider, file_name, file_sha256, rows_parsed, rows_rejected,
            date_from, date_to, summary_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::date, ?::date, ?::jsonb, 'pending', CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, file_sha256) DO NOTHING`,
        [uploadId, userId, provider, fileName, sha256, n.rows.length, rowsRejected,
          n.dateRange.from, n.dateRange.to, safeJson(summary)]
      );
      if (!ins || !ins.rowCount) {
        // Lost a race with a concurrent identical upload.
        const raced = await db.queryOne(
          `SELECT id, status FROM wearable_uploads WHERE user_id = ? AND file_sha256 = ?`,
          [userId, sha256]
        );
        // A committed winner means the work is done; a still-pending one is a
        // concurrent import we must not double-write into.
        return { ok: true, duplicate: true, uploadId: raced ? raced.id : null };
      }
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

    // Batched: a 2-year export used to be one round-trip per day (~730 sequential
    // queries) and could outlive the proxy timeout. 100 days per statement.
    const dayRes = await runChunked(db, {
      rows: n.rows,
      size: DAY_BATCH_SIZE,
      label: 'readiness day',
      buildSql: buildUpsertSql,
      buildParams: (row) => upsertDayParams({
        userId,
        date: row.date,
        source: provider,
        values: row.values,
        sourceUploadId: uploadId,
        raw: row.raw
      })
    });
    const failedDates = new Set(dayRes.failedRows.map((r) => r.date));
    let daysWritten = 0;
    let daysUpdated = 0;
    n.rows.forEach((row) => {
      if (failedDates.has(row.date)) return;
      if (existingSet.has(row.date)) daysUpdated += 1; else daysWritten += 1;
    });
    const daysFailed = dayRes.failed;

    // Workouts and journal answers used to be parsed, counted in the preview and
    // then discarded. Both are upserts on a natural key, so a re-uploaded
    // overlapping export updates rather than duplicates.
    const workoutRes = await persistWorkouts(db, { userId, provider, uploadId, workouts: parsed.workouts });
    const journalRes = await persistJournal(db, { userId, provider, uploadId, journal: parsed.journal });

    // Persist rejected rows for operator triage.
    const rejectedRes = await runChunked(db, {
      rows: rejected,
      size: REJECTED_BATCH_SIZE,
      label: 'rejected row',
      buildSql: buildRejectedSql,
      buildParams: (raw) => {
        const r = raw || {};
        const rowNumber = num(r.rowNumber != null ? r.rowNumber : (r.row_number != null ? r.row_number : r.line));
        return [
          uuidv4(),
          uploadId,
          userId,
          cleanStr(r.fileName || r.file_name || fileName, 300),
          rowNumber != null ? Math.trunc(rowNumber) : null,
          cleanStr(r.reason || r.error || r.message, 500) || 'unspecified',
          safeJson(r.raw || r.row || r.data || r)
        ];
      }
    });

    // Only now is the file honestly "imported". A partial import stays pending so the
    // member's retry resumes it instead of being told nothing changed. Rejected rows
    // are triage data, not member data — they do not hold the commit back.
    const complete = daysFailed === 0 && workoutRes.failed === 0 && journalRes.failed === 0;
    if (complete) {
      await db.run(
        `UPDATE wearable_uploads SET status = 'committed' WHERE id = ?`,
        [uploadId]
      ).catch((e) => console.warn('[readiness] commit status update failed:', e && e.message));
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
      resumed,
      status: complete ? 'committed' : 'pending',
      uploadId,
      daysWritten,
      daysUpdated,
      daysFailed,
      workoutsWritten: workoutRes.written,
      workoutsFailed: workoutRes.failed,
      workoutsSkipped: workoutRes.skipped,
      // Of the skipped, how many were an exact duplicate of another row in the same
      // file rather than an unusable one — reported apart so the reason is visible.
      workoutsCollapsed: workoutRes.collapsed,
      journalWritten: journalRes.written,
      journalFailed: journalRes.failed,
      journalSkipped: journalRes.skipped,
      rowsRejected,
      rejectedStored: rejectedRes.written,
      dateRange: n.dateRange,
      unknownColumns: n.unknownColumns,
      implausibleValues: n.implausible
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
  out.scoreSource = out.score != null ? out.source : null;
  out.raw = row.raw_json || null;
  // Device-native scores travel inside raw_json (see the __ignored note above).
  // Surface them as a first-class field so the UI can render "Body Battery 62"
  // beside its brand without every caller having to know that storage detail.
  out.providerScores = (out.raw && typeof out.raw === 'object' && out.raw.providerScores
    && typeof out.raw.providerScores === 'object' && !Array.isArray(out.raw.providerScores))
    ? out.raw.providerScores
    : {};
  return out;
}

const SELECT_COLS = `user_id, date, source, source_upload_id, updated_at, raw_json, ${METRIC_COLUMNS.concat(TEXT_COLUMNS).join(', ')}`;

/** The precedence-resolved score per date, ignoring rows that carry no score at all. */
const SCORE_FALLBACK_SQL = `SELECT DISTINCT ON (date)
       date, source, COALESCE(readiness_score, recovery_score) AS score
     FROM readiness_daily
     WHERE user_id = ? AND date BETWEEN ?::date AND ?::date
       AND COALESCE(readiness_score, recovery_score) IS NOT NULL
     ORDER BY date ASC, ${SOURCE_PRECEDENCE_SQL} ASC, updated_at DESC`;

/**
 * Precedence picks a whole row, so a whoop row with a blank recovery score (the band
 * was off at wake) would mask a derived row that does have one — the member's Today
 * card shows "—" on exactly the days the derived engine did its job. The winning row
 * still wins for every metric; only `score` falls through to the next source that has
 * one, and `scoreSource` records where the number actually came from.
 */
async function applyScoreFallback(db, userId, rows, from, to) {
  const needy = rows.filter((r) => r && r.score == null && r.date);
  if (!needy.length) return rows;
  const alts = await db.queryAll(SCORE_FALLBACK_SQL, [userId, from, to]);
  const byDate = new Map();
  (alts || []).forEach((a) => {
    const d = toDateStr(a.date);
    if (d) byDate.set(d, a);
  });
  needy.forEach((r) => {
    const a = byDate.get(r.date);
    const v = a ? num(a.score) : null;
    if (v == null) return;
    r.score = v;
    r.scoreSource = a.source || null;
  });
  return rows;
}

/** Hard caps shared by every range reader. */
const MAX_RANGE_DAYS = 730;
const MAX_RANGE_ROWS = 5000;

/**
 * Validate + normalise a date window: either bound alone means a single day, reversed
 * bounds are swapped, and a window longer than MAX_RANGE_DAYS is truncated from the
 * start (reported back as `truncated` so a caller can say so rather than pretend).
 * @returns {{from:string, to:string, truncated:boolean}|null}
 */
function resolveRange(opts) {
  let from = isYmd(cleanStr(opts && opts.from, 10)) ? cleanStr(opts.from, 10) : toDateStr(opts && opts.from);
  let to = isYmd(cleanStr(opts && opts.to, 10)) ? cleanStr(opts.to, 10) : toDateStr(opts && opts.to);
  if (!from && !to) return null;
  if (!from) from = to;
  if (!to) to = from;
  if (!isYmd(from) || !isYmd(to)) return null;
  if (from > to) { const t = from; from = to; to = t; }
  const span = daysBetween(from, to);
  const truncated = span != null && span > MAX_RANGE_DAYS;
  if (truncated) from = addCalendarDaysYmd(to, -MAX_RANGE_DAYS) || from;
  return { from, to, truncated };
}

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
    const mapped = mapReadinessRow(row);
    if (!mapped) return null;
    // Second query only when the winning row has no score of its own.
    const resolved = await applyScoreFallback(db, userId, [mapped], date, date);
    return resolved[0];
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
    const range = resolveRange(opts);
    if (!range) return [];
    const from = range.from;
    const to = range.to;

    const rows = await db.queryAll(
      `SELECT DISTINCT ON (date) ${SELECT_COLS}
       FROM readiness_daily
       WHERE user_id = ? AND date BETWEEN ?::date AND ?::date
       ORDER BY date ASC, ${SOURCE_PRECEDENCE_SQL} ASC, updated_at DESC`,
      [userId, from, to]
    );
    const mapped = (rows || []).map(mapReadinessRow).filter(Boolean);
    return applyScoreFallback(db, userId, mapped, from, to);
  } catch (err) {
    console.warn('[readiness] getReadinessRange failed:', err && err.message);
    return [];
  }
}

function mapWorkoutRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    source: row.provider || null,
    date: toDateStr(row.date),
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
    activity: row.activity || null,
    durationMin: num(row.duration_min),
    strain: num(row.strain),
    energyKcal: num(row.energy_kcal),
    maxHr: num(row.max_hr),
    avgHr: num(row.avg_hr),
    zones: {
      z1: num(row.zone1_min),
      z2: num(row.zone2_min),
      z3: num(row.zone3_min),
      z4: num(row.zone4_min),
      z5: num(row.zone5_min)
    },
    sourceUploadId: row.source_upload_id || null
  };
}

function mapJournalRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    source: row.provider || null,
    date: toDateStr(row.date),
    question: row.question || null,
    // The verbatim answer, plus the boolean when Whoop's answer was a yes/no.
    answer: row.answer == null || row.answer === '' ? null : String(row.answer),
    answerBool: typeof row.answer_bool === 'boolean' ? row.answer_bool : null,
    notes: row.notes || null,
    sourceUploadId: row.source_upload_id || null
  };
}

const WORKOUT_SELECT_COLS = `user_id, provider, date, started_at, ended_at, activity, source_upload_id, ${WORKOUT_METRIC_COLUMNS.join(', ')}`;

/**
 * Workouts for a date window, ascending. Same shape the parser produced (zones nested),
 * so a consumer can treat a stored workout and a freshly parsed one identically.
 * @returns {Promise<Array>} always an array (empty on error).
 */
async function getWorkoutsRange(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider((opts && opts.provider) || DEFAULT_PROVIDER);
  if (!hasDb(db) || !userId || !provider) return [];
  try {
    const range = resolveRange(opts);
    if (!range) return [];
    const max = clamp(num(opts && opts.limit) || MAX_RANGE_ROWS, 1, MAX_RANGE_ROWS);
    const rows = await db.queryAll(
      `SELECT ${WORKOUT_SELECT_COLS}
       FROM wearable_workouts
       WHERE user_id = ? AND provider = ? AND date BETWEEN ?::date AND ?::date
       ORDER BY date ASC, started_at ASC
       LIMIT ?`,
      [userId, provider, range.from, range.to, Math.trunc(max)]
    );
    return (rows || []).map(mapWorkoutRow).filter(Boolean);
  } catch (err) {
    console.warn('[readiness] getWorkoutsRange failed:', err && err.message);
    return [];
  }
}

/**
 * Journal answers for a date window, ascending. One row per (date, question).
 * @returns {Promise<Array>} always an array (empty on error).
 */
async function getJournalRange(db, opts) {
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider((opts && opts.provider) || DEFAULT_PROVIDER);
  if (!hasDb(db) || !userId || !provider) return [];
  try {
    const range = resolveRange(opts);
    if (!range) return [];
    const max = clamp(num(opts && opts.limit) || MAX_RANGE_ROWS, 1, MAX_RANGE_ROWS);
    const rows = await db.queryAll(
      `SELECT user_id, provider, date, question, answer, answer_bool, notes, source_upload_id
       FROM wearable_journal
       WHERE user_id = ? AND provider = ? AND date BETWEEN ?::date AND ?::date
       ORDER BY date ASC, question ASC
       LIMIT ?`,
      [userId, provider, range.from, range.to, Math.trunc(max)]
    );
    return (rows || []).map(mapJournalRow).filter(Boolean);
  } catch (err) {
    console.warn('[readiness] getJournalRange failed:', err && err.message);
    return [];
  }
}

/* ────────────────────────────── auto-populate check-in ────────────────────────────── */

/** The one check-in field a wearable can honestly supply. See autoPopulateCheckinRange. */
const AUTOFILL_FIELD = 'sleep_hours';
const CHECKIN_BATCH_SIZE = 200;

/**
 * Fill daily_checkins.sleep_hours from the member's wearable rows for MANY dates at once.
 *
 * HARD RULE (unchanged): never overwrite a value the member typed. Every write is an
 * INSERT ... ON CONFLICT DO NOTHING (creates the day's row, sets nothing) followed by an
 * UPDATE guarded by `AND sleep_hours IS NULL`, so a member-entered value — or a previously
 * auto-filled one — always wins.
 *
 * Why batched: this used to be called once per day of the export, three queries each, so a
 * two-year import issued ~2,200 sequential round-trips inside one HTTP request and could
 * outlive the proxy timeout. Now the whole export costs one SELECT plus a handful of
 * 200-row statements, bounded by MAX_RANGE_DAYS / CHECKIN_BATCH_SIZE.
 *
 * ONLY sleep_hours is filled. daily_checkins also has steps, water_ml and protein_g;
 * a Whoop export contains no step count and nothing that could stand in for water or
 * protein, so those stay empty rather than be invented.
 *
 * @param {{userId:string, dates?:string[], from?:string, to?:string, provider?:string}} opts
 *        Pass `dates` (the export's days) or a `from`/`to` window; `dates` wins.
 * @returns {Promise<{ok:boolean, field:string, candidates:number, rowsCreated:number,
 *                    filled:number, filledDates:string[], values:Object, reason?:string}>}
 */
async function autoPopulateCheckinRange(db, opts) {
  const field = AUTOFILL_FIELD;
  const empty = { ok: false, field, candidates: 0, rowsCreated: 0, filled: 0, filledDates: [], values: {} };
  const userId = cleanStr(opts && opts.userId, 100);
  const provider = normalizeProvider((opts && opts.provider) || DEFAULT_PROVIDER);
  if (!hasDb(db) || !userId || !provider) return Object.assign({}, empty, { reason: 'invalid_input' });

  try {
    const wanted = Array.isArray(opts && opts.dates)
      ? Array.from(new Set(opts.dates.map((d) => (isYmd(cleanStr(d, 10)) ? cleanStr(d, 10) : toDateStr(d))).filter(isYmd)))
      : null;
    if (wanted && !wanted.length) return Object.assign({}, empty, { ok: true, reason: 'no_dates' });

    // One window covers the whole set; the exact dates are filtered back in JS. An
    // explicit date list is NOT put through resolveRange's 730-day cap — the list is
    // already bounded by the export, and truncating it would silently skip the
    // earliest days of a long backfill.
    const sorted = wanted ? wanted.slice().sort() : null;
    const range = sorted
      ? { from: sorted[0], to: sorted[sorted.length - 1], truncated: false }
      : resolveRange(opts);
    if (!range) return Object.assign({}, empty, { reason: 'invalid_range' });
    const wantedSet = sorted ? new Set(sorted) : null;

    const rows = await db.queryAll(
      `SELECT date, sleep_hours FROM readiness_daily
       WHERE user_id = ? AND source = ? AND date BETWEEN ?::date AND ?::date
         AND sleep_hours IS NOT NULL`,
      [userId, provider, range.from, range.to]
    );

    const candidates = [];
    (rows || []).forEach((r) => {
      const date = toDateStr(r.date);
      if (!isYmd(date)) return;
      if (wantedSet && !wantedSet.has(date)) return;
      const value = num(r.sleep_hours);
      // Same plausibility gate the single-date path always applied.
      if (value == null || value <= 0 || value > MAX_SLEEP_HOURS) return;
      candidates.push({ date, value: round1(value) });
    });
    if (!candidates.length) {
      return Object.assign({}, empty, { ok: true, reason: 'no_wearable_value' });
    }

    // Create the day's row only where we actually have something to put in it.
    let rowsCreated = 0;
    for (const part of chunkRows(candidates, CHECKIN_BATCH_SIZE)) {
      const tuples = new Array(part.length).fill('(?, ?, ?::date, FALSE)').join(', ');
      const params = [];
      part.forEach((c) => { params.push(uuidv4(), userId, c.date); });
      try {
        const res = await db.run(
          `INSERT INTO daily_checkins (id, user_id, checkin_date, is_freeze)
           VALUES ${tuples}
           ON CONFLICT (user_id, checkin_date) DO NOTHING`,
          params
        );
        rowsCreated += (res && res.rowCount) || 0;
      } catch (e) {
        // Unique index missing or a race — the guarded UPDATE below still behaves correctly.
        console.warn('[readiness] autoPopulateCheckinRange insert skipped:', e && e.message);
      }
    }

    // The IS NULL guard is what protects the member's own value; it is applied per row
    // by the join, so one member-entered day never blocks the rest of the batch.
    let filled = 0;
    const filledDates = [];
    const values = {};
    for (const part of chunkRows(candidates, CHECKIN_BATCH_SIZE)) {
      const tuples = new Array(part.length).fill('(?, ?::date, ?::real)').join(', ');
      const params = [];
      part.forEach((c) => { params.push(userId, c.date, c.value); });
      try {
        const res = await db.run(
          `UPDATE daily_checkins d
              SET ${field} = v.val
             FROM (VALUES ${tuples}) AS v(uid, d_date, val)
            WHERE d.user_id = v.uid AND d.checkin_date = v.d_date AND d.${field} IS NULL`,
          params
        );
        const n = (res && res.rowCount) || 0;
        filled += n;
        // rowCount tells us how many landed, not which — only claim the dates when the
        // whole batch landed, so `filledDates` is never a guess.
        if (n === part.length) {
          part.forEach((c) => { filledDates.push(c.date); values[c.date] = c.value; });
        }
      } catch (e) {
        console.warn('[readiness] autoPopulateCheckinRange update failed:', e && e.message);
      }
    }

    return { ok: true, field, candidates: candidates.length, rowsCreated, filled, filledDates, values };
  } catch (err) {
    console.warn('[readiness] autoPopulateCheckinRange failed:', err && err.message);
    return Object.assign({}, empty, { reason: 'error' });
  }
}

/**
 * Single-date wrapper, kept for existing callers. Same guarantees as the range form —
 * it IS the range form, over one date, so there is only ever one implementation of the
 * "never overwrite the member" rule.
 *
 * @returns {Promise<{filled:boolean, field:string, value:number|null, reason?:string}>}
 */
async function autoPopulateCheckin(db, opts) {
  const field = AUTOFILL_FIELD;
  const userId = cleanStr(opts && opts.userId, 100);
  if (!hasDb(db) || !userId) return { filled: false, field, value: null, reason: 'invalid_input' };

  try {
    let date = isYmd(cleanStr(opts && opts.date, 10)) ? cleanStr(opts.date, 10) : toDateStr(opts && opts.date);
    if (!date) date = todayYmdInTz(await resolveUserTz(db, userId)) || toDateStr(new Date());
    if (!isYmd(date)) return { filled: false, field, value: null, reason: 'invalid_date' };

    const res = await autoPopulateCheckinRange(db, {
      userId,
      dates: [date],
      provider: (opts && opts.provider) || DEFAULT_PROVIDER
    });
    if (!res.ok) return { filled: false, field, value: null, date, reason: res.reason || 'error' };
    if (!res.candidates) return { filled: false, field, value: null, date, reason: 'no_wearable_value' };

    const filled = res.filled > 0;
    return {
      filled,
      field,
      value: filled ? (res.values[date] != null ? res.values[date] : null) : null,
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
  // workouts / journal (persisted by commitUpload)
  getWorkoutsRange,
  getJournalRange,
  // check-in bridge
  autoPopulateCheckin,
  autoPopulateCheckinRange,
  // constants (exported for tests / UI copy)
  DEFAULT_PROVIDER,
  SOURCE_PRECEDENCE,
  DERIVED_WEIGHTS,
  DERIVED_FORMULA_VERSION,
  METRIC_COLUMNS,
  // Exported alongside METRIC_COLUMNS so the route and the tests can introspect
  // the provenance columns; without it there is no way to assert that an adapter's
  // hrv_method tag actually has a column to land in.
  TEXT_COLUMNS,
  VALID_PROVIDERS,
  WORKOUT_METRIC_COLUMNS,
  MAX_SLEEP_HOURS,
  MAX_RANGE_DAYS,
  // internals worth unit-testing
  normalizeParsedDay,
  normalizeParsed,
  normalizeWorkout,
  persistWorkouts,
  normalizeJournalEntry,
  sleepComponentScore
};
