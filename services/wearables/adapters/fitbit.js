'use strict';

/**
 * Fitbit adapter — the Google Takeout export.
 *
 * Unlike Whoop and Oura, Fitbit does not ship one tidy CSV. Takeout produces a
 * tree of per-metric files, mostly JSON, some CSV, split into monthly or daily
 * chunks, and the folder layout has changed more than once:
 *
 *   Takeout/Fitbit/Global Export Data/sleep-2024-01-01.json
 *   Takeout/Fitbit/Global Export Data/resting_heart_rate-2024-01-01.json
 *   Takeout/Fitbit/Global Export Data/steps-2024-01-01.json
 *   Takeout/Fitbit/Sleep Score/sleep_score.csv
 *   Takeout/Fitbit/Heart Rate Variability/Daily Heart Rate Variability Summary - 2024-01-01.csv
 *   Takeout/Fitbit/Temperature/Computed Temperature - 2024-01-01.csv
 *   Takeout/Fitbit/Oxygen Saturation (SpO2)/Daily SpO2 - 2024-01-01.csv
 *   Takeout/Fitbit/Active Zone Minutes/Active Zone Minutes - 2024-01-01.csv
 *   Takeout/Fitbit/Daily Readiness/Daily Readiness Score - 2024-01-01.csv
 *
 * So this adapter is routing-first: each file is classified by NAME into a kind,
 * each kind has its own alias table, and a file that matches no kind is noted and
 * skipped — never guessed at.
 *
 * ── What lands where, and why (rule 6) ──────────────────────────────────────
 *
 *  `fitbit.sleep_score` and `fitbit.readiness_score` are Fitbit composites with
 *  Fitbit's own weights and go to `providerScores`. Daily Readiness in particular
 *  is Premium-gated and has come and gone across app versions, so it is treated
 *  as strictly optional: absent is normal, never an error.
 *
 *  Skin temperature is a RELATIVE VARIATION from the member's own baseline, so it
 *  lands in `skinTempDeviationC` with `tempBasis: 'deviation_c'` and never in
 *  `skinTempC`. A magnitude guard backs that up: a reading big enough to be an
 *  absolute temperature is refused rather than written into either field.
 *
 *  HRV is nightly RMSSD, tagged `rmssd_sleep` — the same construct Whoop and Oura
 *  report, and comparable with them. `nremhr` is NOT resting heart rate (it is
 *  the mean rate during non-REM sleep) so it goes to `providerScores`.
 *
 *  Fitbit has NO Whoop-scale strain and no equivalent of Whoop's recovery
 *  percentage: `strain` and `recoveryScore` stay null. Active Zone Minutes is an
 *  activity dose, not a strain, and is never converted into one.
 *
 * @module services/wearables/adapters/fitbit
 */

const C = require('../canonicalDay');
const S = require('./_shared');

const PROVIDER = 'fitbit';
const FITBIT_EXPORT_CONFIDENCE = 0.95;

/* ------------------------------------------------------------------ *
 * File routing
 * ------------------------------------------------------------------ */

/**
 * Route a Takeout path to a kind.
 *
 * UNVERIFIED: these names come from Google Takeout's Fitbit export as understood
 * without a sample archive. A real Takeout ZIP confirms the folder names, the
 * hyphen-vs-underscore spellings and which metrics are CSV rather than JSON. A
 * file that matches nothing here is reported in `summary.notes`, so a renamed
 * export degrades to "nothing imported from this file", never to a wrong import.
 *
 * @returns {string|null}
 */
function classifyFile(name) {
  const base = S.lowerBase(name);
  if (!base) return null;
  const isJson = /\.json$/.test(base);
  const isCsv = /\.csv$/.test(base);
  if (!isJson && !isCsv) return null;

  if (isJson) {
    if (/resting[_\- ]?heart[_\- ]?rate/.test(base)) return 'resting_hr_json';
    if (/^sleep[-_. ]/.test(base) || /(^|[^a-z])sleep([-_. ]|$)/.test(base)) return 'sleep_json';
    if (/^steps[-_. ]/.test(base)) return 'steps_json';
    if (/^calories[-_. ]/.test(base)) return 'calories_json';
    // Everything else in Global Export Data is minute-level intraday data. It is
    // real data, but a per-minute series is not a daily summary and averaging it
    // here would invent a number Fitbit never published.
    if (/heart[_\- ]?rate|altitude|distance|sedentary|active[_\- ]?minutes|elevation|floors|swim|exercise|time[_\- ]?in[_\- ]?heart[_\- ]?rate/.test(base)) {
      return 'intraday';
    }
    return null;
  }

  if (/sleep[_\- ]?score/.test(base)) return 'sleep_score_csv';
  if (/daily[_\- ]?heart[_\- ]?rate[_\- ]?variability|heart[_\- ]?rate[_\- ]?variability[_\- ]?summary/.test(base)) return 'hrv_daily_csv';
  if (/heart[_\- ]?rate[_\- ]?variability/.test(base)) return 'intraday';
  if (/daily[_\- ]?spo2|daily[_\- ]?oxygen/.test(base)) return 'spo2_daily_csv';
  if (/minute[_\- ]?spo2/.test(base)) return 'intraday';
  if (/computed[_\- ]?temperature|nightly[_\- ]?temperature|wrist[_\- ]?temperature/.test(base)) return 'temp_computed_csv';
  if (/device[_\- ]?temperature/.test(base)) return 'temp_device_csv';
  if (/active[_\- ]?zone[_\- ]?minutes/.test(base)) return 'azm_csv';
  if (/readiness/.test(base)) return 'readiness_csv';
  return null;
}

/* ------------------------------------------------------------------ *
 * Alias tables (rule 1)
 * ------------------------------------------------------------------ */

/** Sleep logs. Keys are FULL dotted JSON paths as well as leaf names. */
const SLEEP_ALIASES = {
  dateOfSleep: ['dateofsleep', 'date of sleep', 'sleep date'],
  startTime: ['starttime', 'start time', 'startdatetime'],
  endTime: ['endtime', 'end time', 'enddatetime'],
  minutesAsleep: ['minutesasleep', 'minutes asleep'],
  minutesAwake: ['minutesawake', 'minutes awake'],
  timeInBed: ['timeinbed', 'time in bed'],
  efficiency: ['efficiency'],
  mainSleep: ['mainsleep', 'main sleep', 'ismainsleep'],
  sleepType: ['type', 'logtype', 'sleep type'],
  durationMs: ['duration'],
  minutesToFallAsleep: ['minutestofallasleep'],
  deepMin: ['levels summary deep minutes'],
  lightMin: ['levels summary light minutes'],
  remMin: ['levels summary rem minutes'],
  wakeMin: ['levels summary wake minutes'],
  logId: ['logid', 'log id']
};

/**
 * Keys we recognise and deliberately do NOT map. Listing them keeps
 * `summary.unknownColumns` a signal about Fitbit changing their format rather
 * than a wall of noise on every single import.
 */
const SLEEP_IGNORE = S.buildAliasIndex({
  ignored: [
    'infocode', 'logtype', 'restlesscount', 'restlessduration', 'awakecount', 'awakeduration',
    'awakeningscount', 'minutesafterwakeup', 'timezone',
    'levels summary deep count', 'levels summary deep thirtydayavgminutes',
    'levels summary light count', 'levels summary light thirtydayavgminutes',
    'levels summary rem count', 'levels summary rem thirtydayavgminutes',
    'levels summary wake count', 'levels summary wake thirtydayavgminutes',
    // "classic" (non-stages) logs summarise into these instead of deep/light/rem.
    'levels summary asleep count', 'levels summary asleep minutes',
    'levels summary restless count', 'levels summary restless minutes',
    'levels summary awake count', 'levels summary awake minutes'
  ]
});

const SLEEP_INDEX = S.buildAliasIndex(SLEEP_ALIASES);

/** `[{dateTime, value}]` series (resting HR, steps, calories). */
const SERIES_ALIASES = {
  dateTime: ['datetime', 'date time', 'date', 'timestamp', 'time'],
  value: ['value', 'value value', 'values'],
  error: ['value error', 'error']
};
const SERIES_INDEX = S.buildAliasIndex(SERIES_ALIASES);

const SLEEP_SCORE_ALIASES = {
  timestamp: ['timestamp', 'date', 'date time', 'datetime'],
  logId: ['sleep log entry id', 'sleep_log_entry_id', 'log id'],
  overallScore: ['overall score', 'overall_score', 'sleep score', 'score'],
  compositionScore: ['composition score', 'composition_score'],
  revitalizationScore: ['revitalization score', 'revitalization_score'],
  durationScore: ['duration score', 'duration_score'],
  deepSleepMinutes: ['deep sleep in minutes', 'deep_sleep_in_minutes'],
  restingHeartRate: ['resting heart rate', 'resting_heart_rate', 'rhr'],
  restlessness: ['restlessness']
};
const SLEEP_SCORE_INDEX = S.buildAliasIndex(SLEEP_SCORE_ALIASES);

const HRV_ALIASES = {
  timestamp: ['timestamp', 'date', 'datetime', 'date time'],
  rmssd: ['rmssd', 'daily rmssd', 'hrv', 'heart rate variability'],
  nremhr: ['nremhr', 'nrem hr', 'nrem heart rate'],
  entropy: ['entropy']
};
const HRV_INDEX = S.buildAliasIndex(HRV_ALIASES);

const SPO2_ALIASES = {
  timestamp: ['timestamp', 'date', 'datetime', 'date time'],
  average: ['average value', 'average_value', 'average', 'avg', 'value'],
  lower: ['lower bound', 'lower_bound', 'minimum value', 'min'],
  upper: ['upper bound', 'upper_bound', 'maximum value', 'max']
};
const SPO2_INDEX = S.buildAliasIndex(SPO2_ALIASES);

const TEMP_ALIASES = {
  recordedTime: ['recorded time', 'recorded_time', 'timestamp', 'date', 'datetime', 'sleep end', 'sleep_end'],
  nightlyTemperature: ['nightly temperature', 'nightly_temperature', 'temperature variation', 'temperature_variation', 'skin temperature variation', 'relative temperature', 'temperature'],
  sleepStart: ['sleep start', 'sleep_start'],
  type: ['type']
};
const TEMP_INDEX = S.buildAliasIndex(TEMP_ALIASES);

const AZM_ALIASES = {
  dateTime: ['date time', 'date_time', 'datetime', 'timestamp', 'date'],
  totalMinutes: ['total minutes', 'total_minutes', 'minutes', 'active zone minutes'],
  zoneId: ['heart zone id', 'heart_zone_id', 'zone id', 'zone']
};
const AZM_INDEX = S.buildAliasIndex(AZM_ALIASES);

const READINESS_ALIASES = {
  date: ['date', 'timestamp', 'datetime', 'date time'],
  score: ['readiness score value', 'readiness_score_value', 'readiness score', 'readiness_score', 'score', 'value'],
  state: ['readiness state', 'readiness_state', 'state']
};
const READINESS_INDEX = S.buildAliasIndex(READINESS_ALIASES);

/** Fitbit's temperature is a variation; anything this big cannot be one. */
const MAX_PLAUSIBLE_DEVIATION_C = 6;

/* ------------------------------------------------------------------ *
 * parse
 * ------------------------------------------------------------------ */

/**
 * Parse a Fitbit / Google Takeout export.
 *
 * @param {Array<{name:string, text?:string, buffer?:Buffer}>|{files:Array}} input
 * @param {{timezone?:string}} [opts]
 */
function parse(input, opts) {
  const options = opts || {};
  const b = S.createBuilder(PROVIDER, {
    timezone: options.timezone || S.TZ,
    measurementSource: C.MEASUREMENT_SOURCE.DEVICE_EXPORT,
    confidence: FITBIT_EXPORT_CONFIDENCE
  });

  const files = S.expandFiles(input, b);
  if (!files.length) return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);

  // Daily aggregates built from minute-level series, merged once at the end so a
  // date split across two monthly files is summed rather than overwritten.
  const agg = {
    steps: new Map(),
    energyKcal: new Map(),
    activeMinutes: new Map()
  };

  let usable = 0;

  // Deterministic order: sleep first, so the nightly record exists before the
  // per-metric files fill in around it and before any collision is judged.
  // The dedicated daily resting-heart-rate file outranks the copy embedded in the
  // sleep-score CSV, so it is read first and wins the first-writer merge.
  const ORDER = ['sleep_json', 'hrv_daily_csv', 'resting_hr_json', 'sleep_score_csv',
    'spo2_daily_csv', 'temp_computed_csv', 'temp_device_csv', 'readiness_csv',
    'azm_csv', 'steps_json', 'calories_json', 'intraday'];
  const ordered = [];
  ORDER.forEach((k) => {
    files.forEach((f) => { if (classifyFile(f.name) === k) ordered.push({ f: f, kind: k }); });
  });
  files.forEach((f) => { if (!classifyFile(f.name)) ordered.push({ f: f, kind: null }); });

  ordered.forEach((entry) => {
    const f = entry.f;
    const kind = entry.kind;
    const name = f.name || 'unnamed';

    if (!kind) {
      b.file(name, null);
      b.note('Unrecognised file skipped: ' + name);
      return;
    }
    if (kind === 'intraday') {
      b.file(name, 'intraday');
      b.note('Minute-level file skipped (not a daily summary, and averaging it '
        + 'would invent a number Fitbit never published): ' + name);
      return;
    }
    if (typeof f.text !== 'string' || f.text.trim() === '') {
      b.file(name, kind);
      b.note('Skipped "' + name + '": it carried no readable text.');
      return;
    }

    const fileRec = b.file(name, kind);
    try {
      switch (kind) {
        case 'sleep_json': parseSleepJson(f.text, b, fileRec, options); break;
        case 'resting_hr_json': parseRestingHrJson(f.text, b, fileRec, options); break;
        case 'steps_json': parseSeriesSum(f.text, b, fileRec, options, agg.steps, 'steps'); break;
        case 'calories_json': parseSeriesSum(f.text, b, fileRec, options, agg.energyKcal, 'calories'); break;
        case 'sleep_score_csv': parseSleepScoreCsv(f.text, b, fileRec, options); break;
        case 'hrv_daily_csv': parseHrvCsv(f.text, b, fileRec, options); break;
        case 'spo2_daily_csv': parseSpo2Csv(f.text, b, fileRec, options); break;
        case 'temp_computed_csv': parseTempCsv(f.text, b, fileRec, options); break;
        case 'temp_device_csv': parseDeviceTempCsv(f.text, b, fileRec, options); break;
        case 'azm_csv': parseAzmCsv(f.text, b, fileRec, options, agg.activeMinutes); break;
        case 'readiness_csv': parseReadinessCsv(f.text, b, fileRec, options); break;
        default: break;
      }
      usable += 1;
    } catch (err) {
      // A single unreadable file must never take the whole upload down.
      b.note('Could not parse "' + name + '": ' + ((err && err.message) || String(err)));
    }
  });

  // ── merge the accumulated daily totals ──
  mergeAggregate(b, agg.steps, 'steps');
  mergeAggregate(b, agg.energyKcal, 'energyKcal');
  mergeAggregate(b, agg.activeMinutes, 'activeMinutes');

  if (!usable) {
    return b.finish(['No file in this upload matched a known Fitbit / Google Takeout export layout.']);
  }
  return b.finish();
}

function mergeAggregate(b, map, field) {
  Array.from(map.keys()).sort().forEach((date) => {
    const patch = {};
    patch[field] = S.round(map.get(date), field === 'steps' ? 0 : 1);
    b.mergeDay(date, patch, { kind: field, countRow: false });
  });
}

/* ------------------------------------------------------------------ *
 * Per-kind readers
 * ------------------------------------------------------------------ */

/** Unwrap the several shapes a Takeout JSON file can take. */
function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (key && Array.isArray(value[key])) return value[key];
    const arrays = Object.keys(value).filter((k) => Array.isArray(value[k]));
    if (arrays.length === 1) return value[arrays[0]];
    return [value];
  }
  return [];
}

/** Drop the minute-by-minute arrays before flattening a sleep log. */
function withoutHeavyLevels(log) {
  if (!log || typeof log !== 'object' || !log.levels) return log;
  const copy = Object.assign({}, log);
  const levels = Object.assign({}, log.levels);
  delete levels.data;
  delete levels.shortData;
  copy.levels = levels;
  return copy;
}

/**
 * Sleep logs. Attribution follows rule 2: the night belongs to the calendar date
 * of its END time. Fitbit's own `dateOfSleep` is the same thing and is used as a
 * fallback when the end timestamp is unusable.
 *
 * `mainSleep: false` marks a nap, which accumulates into `napMinutes` and NEVER
 * into the night (rule 3).
 */
function parseSleepJson(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const logs = asArray(doc.value, 'sleep');
  if (!logs.length) { b.note('No sleep logs in "' + fileRec.name + '".'); return; }

  logs.forEach((rawLog, i) => {
    const rowNumber = i + 1; // JSON has no lines; the array index is the row id
    if (!rawLog || typeof rawLog !== 'object') {
      b.reject(fileRec, rowNumber, 'sleep log is not an object', rawLog);
      return;
    }
    const mapped = S.mapJsonRecord(withoutHeavyLevels(rawLog), SLEEP_INDEX, { ignore: SLEEP_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'sleep_json', k));
    const v = mapped.values;

    let date = v.endTime !== undefined ? S.ymdOf(v.endTime, tz) : null;
    let attributedFrom = date ? 'endTime' : null;
    if (!date && v.dateOfSleep !== undefined) {
      date = S.ymdOf(v.dateOfSleep, tz);
      attributedFrom = date ? 'dateOfSleep' : null;
    }
    if (!date) {
      const had = v.endTime !== undefined || v.dateOfSleep !== undefined;
      b.reject(fileRec, rowNumber,
        had ? 'unparseable sleep end time / dateOfSleep' : 'missing sleep end time (cannot attribute a calendar date)',
        rawLog);
      return;
    }

    // minutesAsleep is Fitbit's own asleep total and is already in minutes.
    let asleep = S.numOr(v.minutesAsleep);
    if (asleep === null && v.durationMs !== undefined) {
      // `duration` is the in-bed window in milliseconds, not asleep time. It is
      // only used when minutesAsleep is missing, and then it is time IN BED minus
      // measured awake time — never the raw window, which would overstate sleep.
      const inBedMin = S.parseDurationMinutes(v.durationMs, 'duration (ms)', { assume: 'ms', maxMinutes: 1440 }).minutes;
      const awake = S.numOr(v.minutesAwake);
      if (inBedMin !== null && awake !== null) {
        asleep = S.round(inBedMin - awake, 1);
        b.note('Derived asleep minutes for ' + date + ' from the in-bed window minus measured awake time.');
      }
    }

    const isNap = S.toBool(v.mainSleep) === false;
    if (isNap) {
      b.addNap(date, asleep);
      fileRec.rowsParsed += 1;
      return;
    }

    const patch = {
      sleepMinutes: asleep,
      awakeMin: S.numOr(v.minutesAwake),
      remMin: S.numOr(v.remMin),
      deepMin: S.numOr(v.deepMin),
      lightMin: S.numOr(v.lightMin),
      sleepEfficiencyPct: S.numOr(v.efficiency)
    };
    // strain / recoveryScore deliberately untouched: Fitbit has neither.

    b.mergeDay(date, patch, {
      file: fileRec,
      rowNumber: rowNumber,
      kind: 'sleep_json',
      deviceModel: null
    });
    if (attributedFrom === 'dateOfSleep') {
      b.note('Some sleep logs in "' + fileRec.name + '" had no usable end time; dated by Fitbit\'s dateOfSleep.');
    }
  });
}

/** `[{dateTime, value:{value, error}}]` — Fitbit's daily resting heart rate. */
function parseRestingHrJson(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value, 'restingHeartRate');

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    if (!row || typeof row !== 'object') {
      b.reject(fileRec, rowNumber, 'entry is not an object', row);
      return;
    }
    const mapped = S.mapJsonRecord(row, SERIES_INDEX, {});
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'resting_hr_json', k));
    const date = S.ymdOf(mapped.values.dateTime, tz);
    if (!date) {
      b.reject(fileRec, rowNumber, 'unparseable dateTime', row);
      return;
    }
    // A resting HR of exactly 0 is Fitbit's "no reading", not a measurement.
    const hr = S.numOr(mapped.values.value);
    if (hr === null || hr === 0) {
      b.reject(fileRec, rowNumber, 'no resting heart rate value', row);
      return;
    }
    b.mergeDay(date, { restingHr: hr }, { file: fileRec, rowNumber: rowNumber, kind: 'resting_hr_json' });
  });
}

/**
 * Minute-level `[{dateTime, value}]` series summed into a daily total.
 * Summing is the only honest reduction here: a daily step count IS the sum of
 * its minutes, and a daily calorie burn IS the sum of its minutes.
 */
function parseSeriesSum(text, b, fileRec, options, target, what) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value, what);

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    if (!row || typeof row !== 'object') {
      b.reject(fileRec, rowNumber, 'entry is not an object', row);
      return;
    }
    const mapped = S.mapJsonRecord(row, SERIES_INDEX, {});
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, what, k));
    const date = S.ymdOf(mapped.values.dateTime, tz);
    const value = S.numOr(mapped.values.value);
    if (!date) { b.reject(fileRec, rowNumber, 'unparseable dateTime', row); return; }
    if (value === null) { b.reject(fileRec, rowNumber, 'unparseable value', row); return; }
    target.set(date, (target.get(date) || 0) + value);
    fileRec.rowsParsed += 1;
  });
}

/** sleep_score.csv — Fitbit's own sleep composite plus a nightly resting HR. */
function parseSleepScoreCsv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, SLEEP_SCORE_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) { b.note('No recognisable header in "' + fileRec.name + '".'); return; }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'sleep_score_csv', col));

  table.rows.forEach((row) => {
    const date = S.ymdOf(row.raw.timestamp, tz);
    if (!date) {
      b.reject(fileRec, row.rowNumber, 'unparseable timestamp', row.cells);
      return;
    }
    const scores = {};
    const overall = S.toNum(row.raw.overallScore);
    if (overall !== null) scores['fitbit.sleep_score'] = overall;
    const comp = S.toNum(row.raw.compositionScore);
    if (comp !== null) scores['fitbit.sleep_composition_score'] = comp;
    const revit = S.toNum(row.raw.revitalizationScore);
    if (revit !== null) scores['fitbit.sleep_revitalization_score'] = revit;
    const durScore = S.toNum(row.raw.durationScore);
    if (durScore !== null) scores['fitbit.sleep_duration_score'] = durScore;
    const restless = S.toNum(row.raw.restlessness);
    if (restless !== null) scores['fitbit.restlessness'] = restless;

    const patch = {
      restingHr: S.toNum(row.raw.restingHeartRate),
      deepMin: S.toNum(row.raw.deepSleepMinutes)
    };
    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: row.rowNumber, kind: 'sleep_score_csv', providerScores: scores
    });
  });
}

/** Daily HRV summary — RMSSD averaged across the night. */
function parseHrvCsv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, HRV_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) { b.note('No recognisable header in "' + fileRec.name + '".'); return; }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'hrv_daily_csv', col));

  table.rows.forEach((row) => {
    const date = S.ymdOf(row.raw.timestamp, tz);
    if (!date) { b.reject(fileRec, row.rowNumber, 'unparseable timestamp', row.cells); return; }
    const rmssd = S.toNum(row.raw.rmssd);
    const patch = {};
    if (rmssd !== null) {
      patch.hrvMs = rmssd;
      patch.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP;
    }
    const scores = {};
    // NOT resting heart rate: this is the mean rate during non-REM sleep.
    const nrem = S.toNum(row.raw.nremhr);
    if (nrem !== null) scores['fitbit.nrem_hr'] = nrem;
    const entropy = S.toNum(row.raw.entropy);
    if (entropy !== null) scores['fitbit.hrv_entropy'] = entropy;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: row.rowNumber, kind: 'hrv_daily_csv', providerScores: scores
    });
  });
}

function parseSpo2Csv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, SPO2_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) { b.note('No recognisable header in "' + fileRec.name + '".'); return; }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'spo2_daily_csv', col));

  table.rows.forEach((row) => {
    const date = S.ymdOf(row.raw.timestamp, tz);
    if (!date) { b.reject(fileRec, row.rowNumber, 'unparseable timestamp', row.cells); return; }
    const avg = S.toNum(row.raw.average);
    b.mergeDay(date, { spo2: avg }, { file: fileRec, rowNumber: row.rowNumber, kind: 'spo2_daily_csv' });
  });
}

/**
 * Computed / nightly temperature — a RELATIVE VARIATION (rule 6).
 *
 * The magnitude guard is the safety net for the format uncertainty: if the value
 * is too big to be a deviation it is refused outright rather than written into
 * `skinTempDeviationC` (where it would be a nonsense delta) or into `skinTempC`
 * (where a deviation would read as hypothermia).
 */
function parseTempCsv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, TEMP_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) { b.note('No recognisable header in "' + fileRec.name + '".'); return; }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'temp_computed_csv', col));

  table.rows.forEach((row) => {
    // The night's temperature belongs to the date the member woke up on.
    const date = S.ymdOf(row.raw.recordedTime, tz);
    if (!date) { b.reject(fileRec, row.rowNumber, 'unparseable recorded time', row.cells); return; }

    const header = table.headerByField.nightlyTemperature;
    const temp = S.canonicalizeTempDeviation(row.raw.nightlyTemperature, header);
    if (temp.skinTempDeviationC === null) {
      b.mergeDay(date, {}, { file: fileRec, rowNumber: row.rowNumber, kind: 'temp_computed_csv' });
      return;
    }
    if (Math.abs(temp.skinTempDeviationC) > MAX_PLAUSIBLE_DEVIATION_C) {
      // UNVERIFIED: whether "Computed Temperature" ever contains an ABSOLUTE
      // reading rather than a variation. Until a real export settles it, a value
      // this large is reported and dropped rather than filed under either basis.
      b.note('Refused a Fitbit temperature of ' + temp.skinTempRaw + ' on ' + date
        + ': too large to be a baseline variation, and Fitbit\'s temperature column '
        + 'is documented as a variation, so it cannot be stored as an absolute either.');
      b.mergeDay(date, {}, { file: fileRec, rowNumber: row.rowNumber, kind: 'temp_computed_csv' });
      return;
    }
    b.mergeDay(date, {
      skinTempDeviationC: temp.skinTempDeviationC,
      tempBasis: C.TEMP_BASIS.DEVIATION_C,
      skinTempRaw: temp.skinTempRaw,
      skinTempUnit: temp.skinTempUnit
    }, { file: fileRec, rowNumber: row.rowNumber, kind: 'temp_computed_csv' });
  });
}

/**
 * "Device Temperature" is a different file from "Computed Temperature" and it is
 * NOT clear without a real export whether it holds an absolute skin temperature
 * or another variation, nor at what cadence. Rather than guess a physical meaning
 * — the exact thing rule 6 forbids — it is skipped with an explanation.
 */
function parseDeviceTempCsv(text, b, fileRec) {
  b.note('Skipped "' + fileRec.name + '": Fitbit\'s device-temperature file is not '
    + 'unambiguously an absolute reading or a baseline variation, and guessing '
    + 'would put a deviation into an absolute field. Use the Computed Temperature file.');
}

/** Active Zone Minutes — an activity dose. NEVER a strain. */
function parseAzmCsv(text, b, fileRec, options, target) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, AZM_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) { b.note('No recognisable header in "' + fileRec.name + '".'); return; }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'azm_csv', col));

  table.rows.forEach((row) => {
    const date = S.ymdOf(row.raw.dateTime, tz);
    const mins = S.toNum(row.raw.totalMinutes);
    if (!date) { b.reject(fileRec, row.rowNumber, 'unparseable date_time', row.cells); return; }
    if (mins === null) { b.reject(fileRec, row.rowNumber, 'unparseable total_minutes', row.cells); return; }
    target.set(date, (target.get(date) || 0) + mins);
    fileRec.rowsParsed += 1;
  });
}

/**
 * Daily Readiness — Premium-gated and historically on-again-off-again, so its
 * absence is normal and never an error. Fitbit's readiness is its own composite
 * and is NOT written to the canonical `readinessScore`: unlike Oura's, it mixes
 * in recent activity load, so it is not the same quantity across brands.
 */
function parseReadinessCsv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, READINESS_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) { b.note('No recognisable header in "' + fileRec.name + '".'); return; }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'readiness_csv', col));

  table.rows.forEach((row) => {
    const date = S.ymdOf(row.raw.date, tz);
    if (!date) { b.reject(fileRec, row.rowNumber, 'unparseable date', row.cells); return; }
    const score = S.toNum(row.raw.score);
    const scores = {};
    if (score !== null) scores['fitbit.readiness_score'] = score;
    b.mergeDay(date, {}, {
      file: fileRec, rowNumber: row.rowNumber, kind: 'readiness_csv', providerScores: scores
    });
  });
}

module.exports = {
  parse,
  classifyFile,
  PROVIDER,
  FITBIT_EXPORT_CONFIDENCE,
  SLEEP_ALIASES
};
