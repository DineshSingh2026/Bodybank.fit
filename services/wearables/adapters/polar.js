'use strict';

/**
 * Polar adapter — the Polar Flow account export (JSON).
 *
 * The export is a folder of small per-day JSON documents:
 *
 *   nightly-recharge-2024-01-02.json
 *   sleep-2024-01-02.json
 *   daily-activity-2024-01-02.json
 *   training-session-2024-01-02-1234567.json
 *   247ohr_2024-01-02.json           (continuous HR — minute level)
 *
 * ── What lands where, and why (rule 6) ──────────────────────────────────────
 *
 *  Nightly Recharge status, ANS charge and Polar's sleep score are Polar
 *  composites on Polar's own 1-5 / arbitrary scales. They go to `providerScores`
 *  (`polar.nightly_recharge_status`, `polar.ans_charge`, `polar.sleep_score`) and
 *  never to `recoveryScore` or `readinessScore`. A "3" on Polar's five-point
 *  recharge scale is not 3% of anything.
 *
 *  Polar has no Whoop-scale strain: `strain` stays null.
 *
 *  Sleep DURATION is the sum of the measured stages, because Polar's start-to-end
 *  window includes the interruptions it reports separately.
 *
 * @module services/wearables/adapters/polar
 */

const C = require('../canonicalDay');
const S = require('./_shared');

const PROVIDER = 'polar';
const POLAR_EXPORT_CONFIDENCE = 0.9;

/* ------------------------------------------------------------------ *
 * File routing
 *
 * UNVERIFIED: the file naming below is Polar Flow's export as understood without
 * a sample archive. Anything unmatched is noted and skipped, never guessed at.
 * ------------------------------------------------------------------ */

function classifyFile(name) {
  const base = S.lowerBase(name);
  if (!base || !/\.json$/.test(base)) return null;
  const stem = base.replace(/\.json$/, '');

  if (/nightly[-_ ]?recharge|recharge/.test(stem)) return 'recharge_json';
  if (/sleep/.test(stem)) return 'sleep_json';
  if (/daily[-_ ]?activity|activity[-_ ]?summary/.test(stem)) return 'activity_json';
  if (/training[-_ ]?session|exercise/.test(stem)) return 'training_json';
  if (/247ohr|continuous[-_ ]?heart|ohr/.test(stem)) return 'intraday';
  return null;
}

/* ------------------------------------------------------------------ *
 * Alias tables (rule 1)
 * ------------------------------------------------------------------ */

const SLEEP_ALIASES = {
  date: ['date', 'day', 'calendar date', 'sleep date'],
  sleepStart: ['sleep start time', 'sleep_start_time', 'sleepstarttime', 'start time'],
  sleepEnd: ['sleep end time', 'sleep_end_time', 'sleependtime', 'end time'],
  lightSeconds: ['light sleep', 'light_sleep', 'lightsleep', 'light sleep seconds'],
  deepSeconds: ['deep sleep', 'deep_sleep', 'deepsleep', 'deep sleep seconds'],
  remSeconds: ['rem sleep', 'rem_sleep', 'remsleep', 'rem sleep seconds'],
  unrecognizedSeconds: ['unrecognized sleep stage', 'unrecognized_sleep_stage', 'unrecognisedsleepstage'],
  interruptionSeconds: ['total interruption duration', 'total_interruption_duration', 'totalinterruptionduration'],
  shortInterruptionSeconds: ['short interruption duration', 'short_interruption_duration'],
  longInterruptionSeconds: ['long interruption duration', 'long_interruption_duration'],
  sleepGoalSeconds: ['sleep goal', 'sleep_goal', 'sleepgoal'],
  sleepScore: ['sleep score', 'sleep_score', 'sleepscore'],
  continuity: ['continuity'],
  continuityClass: ['continuity class', 'continuity_class'],
  sleepCharge: ['sleep charge', 'sleep_charge'],
  sleepRating: ['sleep rating', 'sleep_rating'],
  sleepCycles: ['sleep cycles', 'sleep_cycles'],
  deviceId: ['device id', 'device_id', 'deviceid']
};
const SLEEP_INDEX = S.buildAliasIndex(SLEEP_ALIASES);
const SLEEP_IGNORE = S.buildAliasIndex({
  ignored: ['group duration score', 'group solidity score', 'group regeneration score',
    'sleep start offset', 'sleep end offset', 'sleep_start_offset', 'sleep_end_offset',
    'user id', 'user_id', 'sleep goal fulfillment']
});

const RECHARGE_ALIASES = {
  date: ['date', 'day', 'calendar date'],
  heartRateAvg: ['heart rate avg', 'heart_rate_avg', 'heartrateavg', 'heart rate average'],
  beatToBeatAvg: ['beat to beat avg', 'beat_to_beat_avg', 'beattobeatavg'],
  hrvAvg: ['heart rate variability avg', 'heart_rate_variability_avg', 'hrv avg', 'hrv_avg', 'heartratevariabilityavg'],
  breathingRateAvg: ['breathing rate avg', 'breathing_rate_avg', 'breathingrateavg', 'respiration rate avg'],
  rechargeStatus: ['nightly recharge status', 'nightly_recharge_status', 'nightlyrechargestatus'],
  ansCharge: ['ans charge', 'ans_charge', 'anscharge'],
  ansChargeStatus: ['ans charge status', 'ans_charge_status', 'anschargestatus']
};
const RECHARGE_INDEX = S.buildAliasIndex(RECHARGE_ALIASES);
const RECHARGE_IGNORE = S.buildAliasIndex({ ignored: ['user id', 'user_id', 'device id', 'device_id'] });

const ACTIVITY_ALIASES = {
  date: ['date', 'day', 'calendar date'],
  steps: ['steps', 'step count', 'total steps'],
  calories: ['calories', 'kilo calories', 'kilocalories', 'total calories', 'energy'],
  activeCalories: ['active calories', 'active_calories'],
  activeMinutes: ['active time', 'active_time', 'active minutes', 'daily activity minutes']
};
const ACTIVITY_INDEX = S.buildAliasIndex(ACTIVITY_ALIASES);
const ACTIVITY_IGNORE = S.buildAliasIndex({
  ignored: ['user id', 'user_id', 'distance', 'activity goal', 'activity_goal', 'inactivity stamps', 'sitting time']
});

/* ------------------------------------------------------------------ *
 * parse
 * ------------------------------------------------------------------ */

function parse(input, opts) {
  const options = opts || {};
  const b = S.createBuilder(PROVIDER, {
    timezone: options.timezone || S.TZ,
    measurementSource: C.MEASUREMENT_SOURCE.DEVICE_EXPORT,
    confidence: POLAR_EXPORT_CONFIDENCE
  });

  const files = S.expandFiles(input, b);
  if (!files.length) return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);

  const ORDER = ['sleep_json', 'recharge_json', 'activity_json', 'training_json', 'intraday'];
  const ordered = [];
  ORDER.forEach((k) => {
    files.forEach((f) => { if (classifyFile(f.name) === k) ordered.push({ f: f, kind: k }); });
  });
  files.forEach((f) => { if (!classifyFile(f.name)) ordered.push({ f: f, kind: null }); });

  let usable = 0;
  ordered.forEach((entry) => {
    const f = entry.f;
    const kind = entry.kind;
    const name = f.name || 'unnamed';

    if (!kind) { b.file(name, null); b.note('Unrecognised file skipped: ' + name); return; }
    if (kind === 'intraday') {
      b.file(name, 'intraday');
      b.note('Minute-level file skipped (not a daily summary): ' + name);
      return;
    }
    if (kind === 'training_json') {
      b.file(name, 'training_json');
      // Polar's training-session documents are not yet mapped. Saying so is the
      // honest outcome; inventing a workout shape from an unverified schema is not.
      b.note('Training-session file recognised but not yet mapped, so nothing was imported from it: ' + name);
      return;
    }
    if (typeof f.text !== 'string' || f.text.trim() === '') {
      b.file(name, kind);
      b.note('Skipped "' + name + '": it carried no readable text.');
      return;
    }

    const fileRec = b.file(name, kind);
    try {
      if (kind === 'sleep_json') parseSleep(f.text, b, fileRec, options);
      else if (kind === 'recharge_json') parseRecharge(f.text, b, fileRec, options);
      else if (kind === 'activity_json') parseActivity(f.text, b, fileRec, options);
      usable += 1;
    } catch (err) {
      b.note('Could not parse "' + name + '": ' + ((err && err.message) || String(err)));
    }
  });

  if (!usable) {
    return b.finish(['No file in this upload matched a known Polar Flow export layout.']);
  }
  return b.finish();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const arrays = Object.keys(value).filter((k) => Array.isArray(value[k]));
    if (arrays.length === 1) return value[arrays[0]];
    return [value];
  }
  return [];
}

/** Polar writes sleep durations in seconds. */
function secToMin(v) {
  const n = S.numOr(v);
  if (n === null || n < 0) return null;
  return S.round(n / 60, 2);
}

/**
 * Sleep documents.
 *
 * Attribution (rule 2): `sleep_end_time` is the wake instant and is preferred;
 * Polar's own `date` is the fallback.
 *
 * UNVERIFIED: that Polar's `date` on a sleep document is the wake date rather
 * than the bedtime date. Preferring the end timestamp makes the question moot
 * whenever it is present, which is the point of ordering it first.
 */
function parseSleep(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value);

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    if (!rawRow || typeof rawRow !== 'object') {
      b.reject(fileRec, rowNumber, 'sleep record is not an object', rawRow);
      return;
    }
    const mapped = S.mapJsonRecord(rawRow, SLEEP_INDEX, { ignore: SLEEP_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'sleep_json', k));
    const v = mapped.values;

    let date = v.sleepEnd !== undefined ? S.ymdOf(v.sleepEnd, tz) : null;
    if (!date && v.date !== undefined) date = S.ymdOf(v.date, tz);
    if (!date) {
      const had = v.sleepEnd !== undefined || v.date !== undefined;
      b.reject(fileRec, rowNumber,
        had ? 'unparseable sleep end time / date' : 'missing sleep end time and date', rawRow);
      return;
    }

    const deep = secToMin(v.deepSeconds);
    const light = secToMin(v.lightSeconds);
    const rem = secToMin(v.remSeconds);
    const stages = [deep, light, rem].filter((x) => x !== null);
    const sleepMinutes = stages.length ? S.round(stages.reduce((a, x) => a + x, 0), 2) : null;

    const patch = {
      sleepMinutes: sleepMinutes,
      deepMin: deep,
      lightMin: light,
      remMin: rem,
      awakeMin: secToMin(v.interruptionSeconds),
      sleepNeedMin: secToMin(v.sleepGoalSeconds)
    };

    const scores = {};
    const sleepScore = S.numOr(v.sleepScore);
    if (sleepScore !== null) scores['polar.sleep_score'] = sleepScore;
    const continuity = S.numOr(v.continuity);
    if (continuity !== null) scores['polar.sleep_continuity'] = continuity;
    const charge = S.numOr(v.sleepCharge);
    if (charge !== null) scores['polar.sleep_charge'] = charge;
    const rating = S.numOr(v.sleepRating);
    if (rating !== null) scores['polar.sleep_rating'] = rating;
    const cycles = S.numOr(v.sleepCycles);
    if (cycles !== null) scores['polar.sleep_cycles'] = cycles;
    const unrecognised = secToMin(v.unrecognizedSeconds);
    if (unrecognised !== null) scores['polar.unrecognised_sleep_min'] = unrecognised;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: rowNumber, kind: 'sleep_json', providerScores: scores
    });
  });
}

/**
 * Nightly Recharge documents.
 *
 * UNVERIFIED, and the most consequential uncertainty in this adapter:
 *  - `heart_rate_avg` is Polar's overnight average heart rate from the recharge
 *    measurement window. That is the same construct as Whoop's and Oura's
 *    nightly resting heart rate, so it is written to `restingHr`. If a real
 *    export shows it is a whole-night mean including movement, it belongs in
 *    `avgHr` instead — a one-line change.
 *  - `heart_rate_variability_avg` is taken to be RMSSD over the measurement
 *    window, hence `hrvMethod: 'rmssd_sleep'`. The method tag is what keeps a
 *    wrong reading quarantined rather than blended into the cross-device series.
 */
function parseRecharge(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value);

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    if (!rawRow || typeof rawRow !== 'object') {
      b.reject(fileRec, rowNumber, 'recharge record is not an object', rawRow);
      return;
    }
    const mapped = S.mapJsonRecord(rawRow, RECHARGE_INDEX, { ignore: RECHARGE_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'recharge_json', k));
    const v = mapped.values;

    const date = v.date !== undefined ? S.ymdOf(v.date, tz) : null;
    if (!date) {
      b.reject(fileRec, rowNumber, v.date !== undefined ? 'unparseable date' : 'missing date', rawRow);
      return;
    }

    const patch = {
      restingHr: S.numOr(v.heartRateAvg),
      respiratoryRate: S.numOr(v.breathingRateAvg)
    };
    const hrv = S.numOr(v.hrvAvg);
    if (hrv !== null) {
      patch.hrvMs = hrv;
      patch.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP;
    }

    const scores = {};
    const status = S.numOr(v.rechargeStatus);
    if (status !== null) scores['polar.nightly_recharge_status'] = status;
    const ans = S.numOr(v.ansCharge);
    if (ans !== null) scores['polar.ans_charge'] = ans;
    const ansStatus = S.numOr(v.ansChargeStatus);
    if (ansStatus !== null) scores['polar.ans_charge_status'] = ansStatus;
    const b2b = S.numOr(v.beatToBeatAvg);
    if (b2b !== null) scores['polar.beat_to_beat_avg_ms'] = b2b;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: rowNumber, kind: 'recharge_json', providerScores: scores
    });
  });
}

function parseActivity(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value);

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    if (!rawRow || typeof rawRow !== 'object') {
      b.reject(fileRec, rowNumber, 'activity record is not an object', rawRow);
      return;
    }
    const mapped = S.mapJsonRecord(rawRow, ACTIVITY_INDEX, { ignore: ACTIVITY_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'activity_json', k));
    const v = mapped.values;

    const date = v.date !== undefined ? S.ymdOf(v.date, tz) : null;
    if (!date) {
      b.reject(fileRec, rowNumber, v.date !== undefined ? 'unparseable date' : 'missing date', rawRow);
      return;
    }

    const activeMin = S.parseDurationMinutes(v.activeMinutes, 'active time', {
      assume: 's', maxMinutes: 1440
    }).minutes;

    const patch = {
      steps: S.numOr(v.steps),
      energyKcal: S.numOr(v.calories),
      activeMinutes: activeMin
    };
    const scores = {};
    const activeKcal = S.numOr(v.activeCalories);
    if (activeKcal !== null) scores['polar.active_kcal'] = activeKcal;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: rowNumber, kind: 'activity_json', providerScores: scores
    });
  });
}

module.exports = {
  parse,
  classifyFile,
  PROVIDER,
  POLAR_EXPORT_CONFIDENCE,
  SLEEP_ALIASES,
  RECHARGE_ALIASES
};
