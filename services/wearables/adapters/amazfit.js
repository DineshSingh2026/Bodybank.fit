'use strict';

/**
 * Amazfit / Zepp adapter — the CSV bundle the Zepp app exports.
 *
 * The export is a ZIP of folders, each holding one CSV per data type:
 *
 *   SLEEP/SLEEP_1700000000.csv         date,lastSyncTime,deepSleepTime,shallowSleepTime,wakeTime,start,stop,REMTime,naps
 *   ACTIVITY/ACTIVITY_1700000000.csv   date,lastSyncTime,steps,distance,runDistance,calories
 *   HEARTRATE_AUTO/...csv              date,time,heartRate            (minute level)
 *   SPO2/...csv                        date,time,spo2                 (spot readings)
 *
 * `_shared.expandFiles` unpacks the ZIP, so either the archive or a pre-extracted
 * file list works.
 *
 * ── Two deliberate refusals ─────────────────────────────────────────────────
 *
 *  1. Minute-level files (HEARTRATE_AUTO, SPO2 spot readings) are NOT reduced to
 *     a daily number. The minimum of a day's heart-rate samples is not a resting
 *     heart rate, and the mean of scattered SpO2 spot checks is not Fitbit's or
 *     Oura's overnight SpO2. Publishing either would put a number under a label
 *     that does not describe it. They are skipped with an explanation.
 *
 *  2. REM is only written to the canonical `remMin` when the file's own numbers
 *     prove it is a separate stage rather than a subset of "shallow" sleep — see
 *     `resolveSleepTotals`. Otherwise it goes to `providerScores` as
 *     `amazfit.rem_min`, where it is still visible but never double-counted.
 *
 *  Amazfit has no Whoop-scale strain and no cross-comparable recovery composite:
 *  `strain`, `recoveryScore` and `readinessScore` all stay null.
 *
 * @module services/wearables/adapters/amazfit
 */

const C = require('../canonicalDay');
const S = require('./_shared');

const PROVIDER = 'amazfit';
const AMAZFIT_EXPORT_CONFIDENCE = 0.85;

/* ------------------------------------------------------------------ *
 * File routing
 *
 * UNVERIFIED: the Zepp export's folder and file names as understood without a
 * sample archive. Routing is by path AND by the header row, so a renamed file is
 * still classified correctly when its columns are recognisable.
 * ------------------------------------------------------------------ */

function classifyFile(name) {
  const path = String(name || '').replace(/\\/g, '/').toLowerCase();
  const base = S.lowerBase(name);
  if (!base || !/\.csv$/.test(base)) return null;

  if (/sleep/.test(path)) return 'sleep_csv';
  if (/activity_minute|activity_stage|sport/.test(path)) return 'intraday';
  if (/activity/.test(path)) return 'activity_csv';
  if (/heartrate|heart_rate/.test(path)) return 'intraday';
  if (/spo2|blood_oxygen|bloodoxygen/.test(path)) return 'intraday';
  if (/stress|pai|body|weight/.test(path)) return 'intraday';
  return null;
}

/* ------------------------------------------------------------------ *
 * Alias tables (rule 1)
 * ------------------------------------------------------------------ */

const SLEEP_ALIASES = {
  date: ['date', 'day', 'calendar date'],
  lastSyncTime: ['lastsynctime', 'last sync time', 'sync time'],
  deepMin: ['deepsleeptime', 'deep sleep time', 'deep sleep', 'deepsleep', 'deep'],
  shallowMin: ['shallowsleeptime', 'shallow sleep time', 'shallow sleep', 'lightsleeptime', 'light sleep time', 'light sleep', 'shallow'],
  remMin: ['remtime', 'rem time', 'rem sleep time', 'rem sleep', 'rem'],
  wakeValue: ['waketime', 'wake time', 'awake time', 'awaketime'],
  start: ['start', 'start time', 'sleep start', 'starttime'],
  stop: ['stop', 'stop time', 'sleep end', 'stoptime', 'end', 'endtime'],
  naps: ['naps', 'nap', 'nap time', 'naptime'],
  restingHr: ['restingheartrate', 'resting heart rate', 'resting hr', 'rhr'],
  spo2: ['spo2', 'blood oxygen', 'average spo2', 'bloodoxygen'],
  hrv: ['hrv', 'heart rate variability', 'rmssd', 'average hrv']
};
const SLEEP_INDEX = S.buildAliasIndex(SLEEP_ALIASES);

const ACTIVITY_ALIASES = {
  date: ['date', 'day', 'calendar date'],
  lastSyncTime: ['lastsynctime', 'last sync time', 'sync time'],
  steps: ['steps', 'step', 'step count', 'total steps'],
  distance: ['distance', 'total distance'],
  runDistance: ['rundistance', 'run distance'],
  calories: ['calories', 'calorie', 'kcal', 'energy', 'total calories']
};
const ACTIVITY_INDEX = S.buildAliasIndex(ACTIVITY_ALIASES);

/** Anything above this is a unix timestamp, not a number of minutes. */
const EPOCH_THRESHOLD = 1e8;

/* ------------------------------------------------------------------ *
 * parse
 * ------------------------------------------------------------------ */

function parse(input, opts) {
  const options = opts || {};
  const b = S.createBuilder(PROVIDER, {
    timezone: options.timezone || S.TZ,
    measurementSource: C.MEASUREMENT_SOURCE.DEVICE_EXPORT,
    confidence: AMAZFIT_EXPORT_CONFIDENCE
  });

  const files = S.expandFiles(input, b);
  if (!files.length) return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);

  const ORDER = ['sleep_csv', 'activity_csv', 'intraday'];
  const ordered = [];
  ORDER.forEach((k) => {
    files.forEach((f) => { if (classifyFile(f.name) === k) ordered.push({ f: f, kind: k }); });
  });
  files.forEach((f) => { if (!classifyFile(f.name)) ordered.push({ f: f, kind: null }); });

  let usable = 0;
  ordered.forEach((entry) => {
    const f = entry.f;
    const name = f.name || 'unnamed';
    let kind = entry.kind;

    if (typeof f.text !== 'string' || f.text.trim() === '') {
      b.file(name, kind);
      b.note('Skipped "' + name + '": it carried no readable text.');
      return;
    }
    if (kind === 'intraday') {
      b.file(name, 'intraday');
      b.note('Minute-level file skipped: ' + name + '. Reducing spot readings to a '
        + 'daily figure would publish a number the device never reported.');
      return;
    }

    // A renamed file is still usable if its header is recognisable. The bar is
    // deliberately high — BOTH signature columns must be present — because a
    // loose match would let this adapter claim another vendor's export and read
    // its columns under Zepp's unit assumptions.
    if (!kind) {
      const asSleep = S.readCsvTable(f.text, SLEEP_INDEX, { minKnown: 3 });
      if (asSleep.headerLine !== -1 && hasAll(asSleep, ['deepMin', 'shallowMin'])) kind = 'sleep_csv';
      else {
        const asActivity = S.readCsvTable(f.text, ACTIVITY_INDEX, { minKnown: 3 });
        if (asActivity.headerLine !== -1 && hasAll(asActivity, ['steps', 'calories'])) kind = 'activity_csv';
      }
      if (!kind) {
        b.file(name, null);
        b.note('Unrecognised file skipped: ' + name);
        return;
      }
      b.note('"' + name + '" was routed by its header row rather than its name.');
    }

    const fileRec = b.file(name, kind);
    try {
      if (kind === 'sleep_csv') parseSleepCsv(f.text, b, fileRec, options);
      else parseActivityCsv(f.text, b, fileRec, options);
      usable += 1;
    } catch (err) {
      b.note('Could not parse "' + name + '": ' + ((err && err.message) || String(err)));
    }
  });

  if (!usable) {
    return b.finish(['No file in this upload matched a known Zepp / Amazfit CSV export layout.']);
  }
  return b.finish();
}

function hasAll(table, fields) {
  const set = new Set(table.fields.filter(Boolean));
  return fields.every((f) => set.has(f));
}

/**
 * Decide what the night's total actually is.
 *
 * Zepp reports `deepSleepTime` and `shallowSleepTime`, and newer firmware adds
 * `REMTime`. Whether REM is a THIRD stage or a subset already counted inside
 * "shallow" is not documented, and getting it wrong either overstates every night
 * by an hour or hides REM entirely.
 *
 * Rather than guess, the file's own numbers are asked: when `start` and `stop`
 * are present they bound the night, and whichever total sits closer to that
 * window without exceeding it is the right reading. With no window to check
 * against, the conservative answer wins — REM is treated as already inside
 * "shallow" and is reported separately under `providerScores` instead of being
 * added to a total it may already be part of.
 *
 * @returns {{sleepMinutes:number|null, remIsSeparate:boolean, basis:string}}
 */
function resolveSleepTotals(deep, shallow, rem, windowMin) {
  const base = [deep, shallow].filter((x) => x !== null);
  if (!base.length) return { sleepMinutes: null, remIsSeparate: false, basis: 'no stage data' };
  const withoutRem = S.round(base.reduce((a, x) => a + x, 0), 2);
  if (rem === null) return { sleepMinutes: withoutRem, remIsSeparate: false, basis: 'deep+shallow (no REM column)' };

  const withRem = S.round(withoutRem + rem, 2);
  if (windowMin === null || !(windowMin > 0)) {
    return { sleepMinutes: withoutRem, remIsSeparate: false, basis: 'deep+shallow (no bed window to check REM against)' };
  }
  const slack = windowMin * 1.05;
  const withRemFits = withRem <= slack;
  const dWith = Math.abs(windowMin - withRem);
  const dWithout = Math.abs(windowMin - withoutRem);
  if (withRemFits && dWith < dWithout) {
    return { sleepMinutes: withRem, remIsSeparate: true, basis: 'deep+shallow+REM (matches the bed window)' };
  }
  return { sleepMinutes: withoutRem, remIsSeparate: false, basis: 'deep+shallow (REM appears to be inside shallow)' };
}

/**
 * SLEEP CSV.
 *
 * Attribution (rule 2): the `stop` column is a unix timestamp of the wake
 * instant and is preferred; the `date` column is the fallback.
 *
 * UNVERIFIED: that Zepp's `date` on a sleep row is the wake date rather than the
 * bedtime date. Preferring `stop` makes that moot whenever it is present.
 */
function parseSleepCsv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, SLEEP_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) {
    b.note('No recognisable header in "' + fileRec.name + '".');
    return;
  }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'sleep_csv', col));

  // Zepp writes sleep stage durations in minutes; confirm against the column.
  const deepUnit = S.detectSeriesDurationUnit(
    table.rows.map((r) => r.raw.shallowMin), table.headerByField.shallowMin,
    { assume: 'min', minMinutes: 30, maxMinutes: 1440 }
  );
  const durOpts = { assume: deepUnit.unit || 'min', maxMinutes: 1440 };
  if (deepUnit.unit && deepUnit.basis !== 'assumed') {
    b.note('Zepp sleep durations in "' + fileRec.name + '" read as ' + deepUnit.unit
      + ' (detected from ' + deepUnit.basis + ').');
  }

  table.rows.forEach((row) => {
    const raw = row.raw;

    let date = raw.stop ? S.ymdOf(raw.stop, tz) : null;
    if (!date && raw.date) date = S.ymdOf(raw.date, tz);
    if (!date) {
      const had = S.toStr(raw.stop) || S.toStr(raw.date);
      b.reject(fileRec, row.rowNumber,
        had ? 'unparseable stop timestamp / date (' + had + ')' : 'missing date (cannot attribute a calendar date)',
        row.cells);
      return;
    }

    const deep = S.parseDurationMinutes(raw.deepMin, table.headerByField.deepMin, durOpts).minutes;
    const shallow = S.parseDurationMinutes(raw.shallowMin, table.headerByField.shallowMin, durOpts).minutes;
    const rem = S.parseDurationMinutes(raw.remMin, table.headerByField.remMin, durOpts).minutes;
    const windowMin = S.minutesBetween(raw.start, raw.stop);

    const totals = resolveSleepTotals(deep, shallow, rem, windowMin);

    // `wakeTime` is ambiguous in this export: in some versions it is minutes
    // awake, in others a wake timestamp. Its own magnitude decides — a value big
    // enough to be a unix epoch is a timestamp and is NOT minutes.
    let awakeMin = null;
    const wakeRaw = S.toNum(raw.wakeValue);
    if (wakeRaw !== null && wakeRaw < EPOCH_THRESHOLD) {
      awakeMin = S.parseDurationMinutes(raw.wakeValue, table.headerByField.wakeValue, durOpts).minutes;
    } else if (wakeRaw !== null) {
      b.note('The "' + (table.headerByField.wakeValue || 'wakeTime') + '" column in "'
        + fileRec.name + '" holds timestamps, not minutes awake; awake time was left null.');
    }

    const patch = {
      sleepMinutes: totals.sleepMinutes,
      deepMin: deep,
      lightMin: shallow,
      remMin: totals.remIsSeparate ? rem : null,
      awakeMin: awakeMin,
      restingHr: S.toNum(raw.restingHr),
      spo2: S.toNum(raw.spo2)
    };

    // HRV without a documented method must NOT be tagged rmssd_sleep. Zepp does
    // not say how it derives the number, so it is quarantined under 'unknown'
    // where trend code will keep it out of the RMSSD series.
    const hrv = S.toNum(raw.hrv);
    if (hrv !== null) {
      patch.hrvMs = hrv;
      patch.hrvMethod = C.HRV_METHOD.UNKNOWN;
    }

    const scores = {};
    if (!totals.remIsSeparate && rem !== null) scores['amazfit.rem_min'] = rem;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: row.rowNumber, kind: 'sleep_csv', providerScores: scores
    });

    // Naps accumulate and never inflate the night (rule 3).
    const napMin = readNapMinutes(raw.naps, table.headerByField.naps, durOpts);
    if (napMin !== null) b.addNap(date, napMin);
  });
}

/**
 * The `naps` column is either a plain duration or a JSON array of nap records,
 * depending on firmware. Both are read; anything else is left null rather than
 * coerced into a number.
 */
function readNapMinutes(rawValue, header, durOpts) {
  const s = S.toStr(rawValue);
  if (s === null) return null;
  if (/^[[{]/.test(s)) {
    const doc = S.readJson(s);
    if (doc.error || !doc.value) return null;
    const list = Array.isArray(doc.value) ? doc.value : [doc.value];
    let total = 0;
    let found = 0;
    list.forEach((n) => {
      if (!n || typeof n !== 'object') return;
      const secs = S.numOr(n.duration != null ? n.duration
        : (n.durationSeconds != null ? n.durationSeconds : n.total));
      if (secs === null) return;
      const mins = S.parseDurationMinutes(secs, 'duration', { assume: 's', maxMinutes: 1440 }).minutes;
      if (mins === null) return;
      total += mins;
      found += 1;
    });
    return found ? S.round(total, 2) : null;
  }
  return S.parseDurationMinutes(s, header, durOpts).minutes;
}

/** ACTIVITY CSV — one row per calendar date. */
function parseActivityCsv(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const table = S.readCsvTable(text, ACTIVITY_INDEX, { minKnown: 2 });
  if (table.headerLine === -1) {
    b.note('No recognisable header in "' + fileRec.name + '".');
    return;
  }
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'activity_csv', col));

  table.rows.forEach((row) => {
    const date = S.ymdOf(row.raw.date, tz);
    if (!date) {
      const had = S.toStr(row.raw.date);
      b.reject(fileRec, row.rowNumber,
        had ? 'unparseable date (' + had + ')' : 'missing date', row.cells);
      return;
    }
    const energy = S.canonicalizeEnergy(row.raw.calories, table.headerByField.calories);
    const patch = {
      steps: S.toNum(row.raw.steps),
      energyKcal: energy.energyKcal
    };
    const scores = {};
    const distance = S.toNum(row.raw.distance);
    if (distance !== null) scores['amazfit.distance_m'] = distance;
    const runDistance = S.toNum(row.raw.runDistance);
    if (runDistance !== null) scores['amazfit.run_distance_m'] = runDistance;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: row.rowNumber, kind: 'activity_csv', providerScores: scores
    });
  });
}

module.exports = {
  parse,
  classifyFile,
  resolveSleepTotals,
  PROVIDER,
  AMAZFIT_EXPORT_CONFIDENCE,
  SLEEP_ALIASES,
  ACTIVITY_ALIASES
};
