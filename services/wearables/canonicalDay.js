'use strict';

/**
 * The universal wearable contract.
 *
 * Every device adapter — Whoop, Oura, Fitbit, Garmin, Apple Health, Samsung /
 * Health Connect, a generic CSV, or an AI-read screenshot — MUST return the exact
 * shape validated here. That shape is byte-compatible with what
 * services/wearables/whoopParser.js#parseWhoopExport already emits, so an adapter
 * that satisfies this module drops straight into readinessService.previewUpload /
 * commitUpload and therefore into the stats engine, the report and the PDF, with
 * no change to any of them.
 *
 *   adapter(files) -> { days, workouts, journal, summary, rejected }
 *                            |
 *                            v
 *            readinessService.previewUpload / commitUpload
 *                            |
 *                            v
 *          readiness_daily  (UNIQUE user_id, date, source)
 *
 * ── The five non-negotiable rules (inherited from whoopParser) ───────────────
 *  1. Columns are NEVER read by position — only through an alias table.
 *     Unrecognised headers are collected, never dropped silently, never fatal.
 *  2. A night is attributed to the calendar date of its WAKE time.
 *  3. Naps never inflate nightly sleep; they accumulate into `napMinutes`.
 *  4. Units are detected from the header AND sanity-checked against the value.
 *  5. Nothing is ever invented. A missing or unparseable value is `null`
 *     (never 0), and an unusable row becomes a `rejected` entry.
 *
 * ── The sixth rule, added for multi-device ───────────────────────────────────
 *  6. A metric is only ever written into a canonical field when it means the
 *     SAME PHYSICAL THING as every other device writing that field. When it does
 *     not, it goes to `providerScores` (device-native, never cross-compared) or
 *     it carries a method tag that keeps it segregated (`hrvMethod`, `tempBasis`).
 *     Apple's SDNN must never silently land in the same series as Whoop's RMSSD.
 *
 * @module services/wearables/canonicalDay
 */

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/**
 * Canonical provider ids. MUST stay in sync with VALID_PROVIDERS in
 * services/wearables/readinessService.js — a value missing there is rejected at
 * persist time and the member's upload silently writes nothing.
 */
const PROVIDERS = [
  'whoop',
  'oura',
  'fitbit',
  'garmin',
  'apple_health',
  'samsung_health',
  'health_connect',
  'polar',
  'amazfit',
  'generic_csv',
  'screenshot',
  'manual',
  'derived'
];

/* ------------------------------------------------------------------ *
 * Method tags — rule 6
 * ------------------------------------------------------------------ */

/**
 * How the device derived its HRV number. These are NOT interchangeable:
 * SDNN over a 60-second spot check runs materially higher than RMSSD averaged
 * across a night, so a member switching Apple -> Whoop would show a fake cliff.
 * Trend and baseline code MUST segregate series by this tag.
 */
const HRV_METHOD = {
  RMSSD_SLEEP: 'rmssd_sleep', // Whoop, Oura, Fitbit — overnight average
  RMSSD_SPOT: 'rmssd_spot',
  SDNN_SPOT: 'sdnn_spot', // Apple Watch (HKQuantityTypeIdentifierHeartRateVariabilitySDNN)
  SDNN_SLEEP: 'sdnn_sleep',
  UNKNOWN: 'unknown'
};
const HRV_METHODS = Object.keys(HRV_METHOD).map((k) => HRV_METHOD[k]);

/**
 * Whether a temperature reading is an absolute skin temperature or a delta from
 * the member's own baseline. Fitbit and Apple report a deviation; Whoop reports
 * absolute. Writing a -0.3 deviation into `skinTempC` would read as hypothermia.
 */
const TEMP_BASIS = {
  ABSOLUTE_C: 'absolute_c',
  DEVIATION_C: 'deviation_c',
  UNKNOWN: 'unknown'
};
const TEMP_BASES = Object.keys(TEMP_BASIS).map((k) => TEMP_BASIS[k]);

/**
 * How a value reached us. Drives `confidence` and what the UI is allowed to claim.
 * A number an LLM read off a screenshot is not the same evidence as a number
 * parsed out of the vendor's own CSV, and must never be presented as if it were.
 */
const MEASUREMENT_SOURCE = {
  DEVICE_EXPORT: 'device_export', // vendor's own file — highest fidelity
  DEVICE_API: 'device_api', // OAuth / personal token
  NATIVE_SDK: 'native_sdk', // HealthKit / Health Connect in-app read
  VISION: 'vision', // AI read a PDF or screenshot
  MANUAL: 'manual', // member typed it
  DERIVED: 'derived' // BodyBank computed it
};
const MEASUREMENT_SOURCES = Object.keys(MEASUREMENT_SOURCE).map((k) => MEASUREMENT_SOURCE[k]);

/* ------------------------------------------------------------------ *
 * Canonical fields + sanity ranges  (rule 4 / rule 5)
 * ------------------------------------------------------------------ */

/**
 * Physiologically plausible bounds. A value outside its range is NOT clamped and
 * NOT silently dropped — it is nulled and reported in `summary.implausible`, so a
 * unit bug surfaces as a visible warning instead of being averaged into a PDF as
 * fact. `null` on either side means unbounded.
 */
const SANITY = {
  recoveryScore: [0, 100],
  readinessScore: [0, 100],
  hrvMs: [1, 400],
  restingHr: [25, 140],
  spo2: [50, 100],
  skinTempC: [24, 45], // absolute only
  skinTempDeviationC: [-6, 6], // deviation only
  respiratoryRate: [4, 45],
  strain: [0, 21], // Whoop's scale; other devices leave this null
  energyKcal: [0, 20000],
  maxHr: [50, 240],
  avgHr: [25, 220],
  sleepHours: [0, 24],
  sleepMinutes: [0, 1440],
  sleepPerformancePct: [0, 100],
  sleepEfficiencyPct: [0, 100],
  sleepConsistencyPct: [0, 100],
  sleepNeedMin: [0, 1440],
  sleepDebtMin: [0, 1440],
  remMin: [0, 1440],
  deepMin: [0, 1440],
  lightMin: [0, 1440],
  awakeMin: [0, 1440],
  napMinutes: [0, 1440],
  steps: [0, 200000],
  activeMinutes: [0, 1440],
  confidence: [0, 1]
};

/** Numeric metric fields of a canonical day, in a stable order. */
const METRIC_FIELDS = Object.keys(SANITY);

/**
 * An empty canonical day. EVERY metric starts as null — never 0 — because 0 is a
 * legitimate reading for several of these and "we have no data" must stay
 * distinguishable from "the member scored zero". `napMinutes` is the one
 * exception: it is an accumulator and starts at 0, matching whoopParser.
 *
 * @param {string} date   YYYY-MM-DD, already attributed in the member's timezone
 * @param {string} source a value from PROVIDERS
 * @returns {Object}
 */
function emptyCanonicalDay(date, source) {
  const day = { date: date, source: source || 'manual' };
  METRIC_FIELDS.forEach((f) => { day[f] = null; });
  day.napMinutes = 0;

  // ── provenance (rule 6) ──
  day.hrvMethod = null; // required whenever hrvMs is non-null
  day.tempBasis = null; // required whenever skinTempC/skinTempDeviationC is non-null
  day.skinTempRaw = null; // pre-conversion value, kept so a unit misfire is recoverable
  day.skinTempUnit = null; // 'C' | 'F' as detected
  day.measurementSource = null; // MEASUREMENT_SOURCE — how this day reached us
  day.deviceModel = null; // e.g. 'Apple Watch Series 9', free text, may be null

  /**
   * Device-native scores that are NOT comparable across brands and therefore must
   * never be written into a canonical field. Fitbit's "Sleep Score", Garmin's
   * "Body Battery", Samsung's "Sleep Score" all live here, keyed by a namespaced
   * id: { 'garmin.body_battery': 62, 'fitbit.sleep_score': 81 }. Persisted into
   * readiness_daily.raw_json. Safe to display next to their brand name; never
   * safe to chart against another device's number.
   */
  day.providerScores = {};

  return day;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function isYmd(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isNullableFiniteNumber(v) {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * Validate ONE canonical day. Returns `[]` when the day is contract-clean, or a
 * list of human-readable problems. Adapters should run this in their own tests;
 * the ingest route runs it on every upload before anything is persisted.
 *
 * @param {Object} day
 * @param {{index?:number}} [opts]
 * @returns {string[]}
 */
function validateCanonicalDay(day, opts) {
  const at = opts && opts.index != null ? 'days[' + opts.index + ']' : 'day';
  const errs = [];
  if (!day || typeof day !== 'object') return [at + ': not an object'];

  if (!isYmd(day.date)) errs.push(at + '.date: expected YYYY-MM-DD, got ' + JSON.stringify(day.date));
  if (PROVIDERS.indexOf(day.source) === -1) errs.push(at + '.source: unknown provider ' + JSON.stringify(day.source));

  METRIC_FIELDS.forEach((f) => {
    const v = day[f];
    if (!isNullableFiniteNumber(v)) {
      errs.push(at + '.' + f + ': expected a finite number or null, got ' + JSON.stringify(v));
      return;
    }
    if (v === null) return;
    const range = SANITY[f];
    if (range[0] !== null && v < range[0]) errs.push(at + '.' + f + ': ' + v + ' below plausible minimum ' + range[0]);
    if (range[1] !== null && v > range[1]) errs.push(at + '.' + f + ': ' + v + ' above plausible maximum ' + range[1]);
  });

  // Rule 6: an untagged HRV number is unusable — we would not know whether it may
  // be compared with the member's other days.
  if (day.hrvMs !== null && HRV_METHODS.indexOf(day.hrvMethod) === -1) {
    errs.push(at + '.hrvMethod: required when hrvMs is set (got ' + JSON.stringify(day.hrvMethod) + ')');
  }
  const hasTemp = day.skinTempC !== null || day.skinTempDeviationC !== null;
  if (hasTemp && TEMP_BASES.indexOf(day.tempBasis) === -1) {
    errs.push(at + '.tempBasis: required when a temperature is set (got ' + JSON.stringify(day.tempBasis) + ')');
  }
  if (day.tempBasis === TEMP_BASIS.ABSOLUTE_C && day.skinTempDeviationC !== null) {
    errs.push(at + ': tempBasis is absolute_c but skinTempDeviationC is set');
  }
  if (day.tempBasis === TEMP_BASIS.DEVIATION_C && day.skinTempC !== null) {
    errs.push(at + ': tempBasis is deviation_c but skinTempC is set — a deviation must never be stored as an absolute');
  }

  if (day.measurementSource !== null && day.measurementSource !== undefined
      && MEASUREMENT_SOURCES.indexOf(day.measurementSource) === -1) {
    errs.push(at + '.measurementSource: unknown value ' + JSON.stringify(day.measurementSource));
  }

  // Sleep stages may not exceed the night they belong to (a 3% rounding slack).
  const stages = ['remMin', 'deepMin', 'lightMin'].reduce(
    (acc, f) => (day[f] === null ? acc : acc + day[f]), 0
  );
  if (day.sleepMinutes !== null && stages > 0 && stages > day.sleepMinutes * 1.03 + 1) {
    errs.push(at + ': sleep stages total ' + Math.round(stages) + 'min exceed sleepMinutes ' + day.sleepMinutes);
  }

  // sleepHours and sleepMinutes must agree — they are the same measurement and
  // downstream code reads whichever it finds first.
  if (day.sleepHours !== null && day.sleepMinutes !== null
      && Math.abs(day.sleepHours * 60 - day.sleepMinutes) > 1.5) {
    errs.push(at + ': sleepHours (' + day.sleepHours + ') and sleepMinutes (' + day.sleepMinutes + ') disagree');
  }

  if (day.providerScores !== undefined && day.providerScores !== null) {
    if (typeof day.providerScores !== 'object' || Array.isArray(day.providerScores)) {
      errs.push(at + '.providerScores: expected a plain object');
    } else {
      Object.keys(day.providerScores).forEach((k) => {
        if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(k)) {
          errs.push(at + '.providerScores["' + k + '"]: key must be namespaced, e.g. "garmin.body_battery"');
        }
      });
    }
  }

  return errs;
}

/**
 * Validate a whole adapter result. This is the single gate every adapter must
 * pass before its output is allowed anywhere near the database.
 *
 * @param {Object} parsed  an adapter's `{days, workouts, journal, summary, rejected}`
 * @returns {{ok:boolean, errors:string[], dayCount:number}}
 */
function validateParsedExport(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: ['parsed: not an object'], dayCount: 0 };
  }

  ['days', 'workouts', 'journal', 'rejected'].forEach((k) => {
    if (!Array.isArray(parsed[k])) errors.push('parsed.' + k + ': expected an array');
  });
  if (!parsed.summary || typeof parsed.summary !== 'object') {
    errors.push('parsed.summary: expected an object');
  } else {
    ['filesSeen', 'unknownColumns', 'notes'].forEach((k) => {
      if (!Array.isArray(parsed.summary[k])) errors.push('parsed.summary.' + k + ': expected an array');
    });
    const dr = parsed.summary.dateRange;
    if (!dr || typeof dr !== 'object') errors.push('parsed.summary.dateRange: expected {from,to}');
    else {
      if (dr.from !== null && !isYmd(dr.from)) errors.push('parsed.summary.dateRange.from: expected YYYY-MM-DD or null');
      if (dr.to !== null && !isYmd(dr.to)) errors.push('parsed.summary.dateRange.to: expected YYYY-MM-DD or null');
    }
  }

  const days = Array.isArray(parsed.days) ? parsed.days : [];
  const seen = new Set();
  days.forEach((d, i) => {
    validateCanonicalDay(d, { index: i }).forEach((e) => errors.push(e));
    if (d && d.date) {
      // One row per date per source, or commitUpload's UNIQUE(user_id,date,source)
      // upsert would let a later duplicate silently overwrite an earlier one.
      const key = d.date + '|' + d.source;
      if (seen.has(key)) errors.push('days: duplicate date ' + d.date + ' for source ' + d.source);
      seen.add(key);
    }
  });

  // Days must be sorted ascending — the stats engine's trend and streak windows
  // assume it and produce a wrong slope on unsorted input.
  for (let i = 1; i < days.length; i += 1) {
    if (days[i - 1] && days[i] && days[i - 1].date > days[i].date) {
      errors.push('days: not sorted ascending by date');
      break;
    }
  }

  return { ok: errors.length === 0, errors: errors, dayCount: days.length };
}

/**
 * An empty, contract-valid result. Adapters return this (with notes explaining
 * why) rather than throwing when a file contained nothing they could read.
 *
 * @param {string} source
 * @param {string[]} [notes]
 */
function emptyParsedExport(source, notes) {
  return {
    days: [],
    workouts: [],
    journal: [],
    summary: {
      provider: source,
      filesSeen: [],
      rowsParsed: 0,
      rowsRejected: 0,
      dateRange: { from: null, to: null },
      unknownColumns: [],
      duplicates: [],
      implausible: [],
      notes: Array.isArray(notes) ? notes.slice() : [],
      timezone: 'Asia/Kolkata'
    },
    rejected: []
  };
}

module.exports = {
  PROVIDERS,
  HRV_METHOD,
  HRV_METHODS,
  TEMP_BASIS,
  TEMP_BASES,
  MEASUREMENT_SOURCE,
  MEASUREMENT_SOURCES,
  SANITY,
  METRIC_FIELDS,
  emptyCanonicalDay,
  emptyParsedExport,
  validateCanonicalDay,
  validateParsedExport
};
