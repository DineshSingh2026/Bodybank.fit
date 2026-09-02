'use strict';

/**
 * Generic CSV adapter — the universal fallback.
 *
 * Anything with a date column and recognisable metric columns: a vendor we have
 * no dedicated adapter for, a third-party dashboard's export, a spreadsheet a
 * coach maintains by hand, or a member's own tracking sheet.
 *
 * It carries the BROADEST alias table in the family, extending the `RAW_ALIASES`
 * idea already used by `services/wearables/readinessService.js` (~lines 120-175)
 * with the spellings the other adapters in this directory taught us. It tolerates
 * a BOM, CRLF, quoted fields with embedded commas, a header row that is not the
 * first line, and sleep written as `HH:MM`, as decimal hours or as minutes.
 *
 * ── Where this adapter is deliberately MORE cautious than the vendor ones ────
 *
 *  `strain` is NEVER written. Strain is Whoop's 0-21 logarithmic cardiovascular
 *  load scale; it has no unit, no shared definition, and a column called "strain"
 *  in an unknown file could be on any scale at all. It goes to
 *  `providerScores['generic_csv.strain']`, visible but never charted against a
 *  Whoop day. Scores that ARE self-describing (a 0-100 recovery or readiness, an
 *  HRV in ms, a heart rate in bpm, a step count, minutes) are mapped normally —
 *  the column name plus the unit fully determines the meaning.
 *
 *  `hrvMethod` is always `'unknown'` unless the file states the method in its own
 *  column. An unknown file's HRV could be SDNN from a 60-second spot check, which
 *  runs materially higher than overnight RMSSD; guessing `rmssd_sleep` would
 *  silently merge two incompatible series and manufacture a trend. `'unknown'`
 *  keeps it segregated, which is the entire point of the method tag.
 *
 *  A temperature column is read as an ABSOLUTE only when its value could actually
 *  be one. A reading whose magnitude is far too small to be a skin temperature is
 *  a baseline deviation, and lands in `skinTempDeviationC` with
 *  `tempBasis: 'deviation_c'` — never in `skinTempC`, where -0.3 would read as
 *  hypothermia.
 *
 * @module services/wearables/adapters/genericCsv
 */

const C = require('../canonicalDay');
const S = require('./_shared');

const PROVIDER = 'generic_csv';

/** Lower than a vendor's own export: the schema is inferred, not documented. */
const GENERIC_CSV_CONFIDENCE = 0.7;

/* ------------------------------------------------------------------ *
 * The alias table (rule 1) — as broad as it can be without ambiguity.
 *
 * Every entry here is a spelling whose MEANING is unambiguous. Anything that
 * could mean two different physical things is left out on purpose, so it surfaces
 * in `summary.unknownColumns` instead of being guessed into a canonical field.
 * ------------------------------------------------------------------ */

const GENERIC_ALIASES = {
  // ── attribution ──
  date: ['date', 'day', 'ymd', 'calendar date', 'calendar_date', 'the date', 'log date',
    'entry date', 'record date', 'summary date', 'summary_date', 'checkin date', 'checkin_date',
    'sleep date', 'cycle start time', 'cycle_start_time'],
  wakeTime: ['wake onset', 'wake time', 'wake up time', 'wakeup time', 'wake_time', 'wake_onset',
    'sleep end', 'sleep end time', 'sleep_end', 'sleep_end_time', 'bedtime end', 'bedtime_end',
    'end time', 'awake onset', 'got up at', 'wake date'],
  bedTime: ['sleep onset', 'bedtime', 'bed time', 'sleep start', 'sleep start time', 'sleep_start',
    'sleep_start_time', 'bedtime start', 'bedtime_start', 'went to bed', 'lights out'],

  // ── nap handling (rule 3) ──
  napFlag: ['is nap', 'isnap', 'nap flag', 'nap?', 'is_nap', 'nap yn'],
  napMinutes: ['nap minutes', 'nap duration', 'nap min', 'nap time', 'nap length', 'naps',
    'nap_minutes', 'nap_min', 'napminutes', 'daytime sleep', 'nap'],

  // ── sleep ──
  totalSleep: ['total sleep duration', 'total sleep', 'total sleep time', 'sleep duration',
    'asleep duration', 'asleep time', 'time asleep', 'sleep', 'hours of sleep', 'sleep hours',
    'sleep_hours', 'sleep minutes', 'sleep_minutes', 'sleepminutes', 'total_sleep_duration',
    'minutes asleep', 'minutesasleep', 'sleep length', 'slept'],
  inBed: ['in bed duration', 'time in bed', 'total bedtime', 'in bed', 'timeinbed', 'in_bed_min',
    'bed time duration', 'total time in bed'],
  remMin: ['rem duration', 'rem sleep duration', 'rem sleep', 'rem minutes', 'rem_min', 'rem time', 'rem'],
  deepMin: ['deep duration', 'deep sleep duration', 'deep sws duration', 'sws duration',
    'slow wave sleep duration', 'deep sleep', 'deep minutes', 'deep_min', 'deep time', 'deep'],
  lightMin: ['light sleep duration', 'light duration', 'light sleep', 'shallow sleep',
    'shallow sleep time', 'light minutes', 'light_min', 'light time', 'light'],
  awakeMin: ['awake duration', 'awake time', 'time awake', 'minutes awake', 'minutesawake',
    'wake duration', 'awake minutes', 'awake_min', 'total interruption duration', 'awake'],
  sleepNeedMin: ['sleep need', 'sleep needed', 'sleep need duration', 'sleep goal', 'sleep_need_min'],
  sleepDebtMin: ['sleep debt', 'sleep debt duration', 'sleep_debt_min'],
  sleepEfficiencyPct: ['sleep efficiency', 'sleep efficiency score', 'efficiency', 'sleep_efficiency_pct'],
  sleepPerformancePct: ['sleep performance', 'sleep performance score', 'sleep_performance_pct'],
  sleepConsistencyPct: ['sleep consistency', 'sleep consistency score', 'sleep_consistency_pct',
    'sleep regularity'],

  // ── cardiovascular ──
  restingHr: ['resting heart rate', 'resting hr', 'rhr', 'resting_hr', 'restingheartrate',
    'resting pulse', 'lowest resting heart rate'],
  avgHr: ['average heart rate', 'average hr', 'avg hr', 'avg heart rate', 'mean heart rate', 'avg_hr'],
  maxHr: ['max hr', 'max heart rate', 'maximum heart rate', 'peak heart rate', 'max_hr'],
  hrvMs: ['heart rate variability', 'hrv', 'hrv ms', 'hrv_ms', 'rmssd', 'sdnn',
    'heart rate variability ms', 'average hrv', 'nightly hrv'],
  hrvMethod: ['hrv method', 'hrv_method', 'hrv type', 'hrv measurement'],
  respiratoryRate: ['respiratory rate', 'respiration rate', 'breathing rate', 'resp rate',
    'respiratory_rate', 'breaths per minute'],
  spo2: ['blood oxygen', 'spo2', 'sp o2', 'oxygen saturation', 'blood oxygen level',
    'average spo2', 'o2 saturation', 'spo2 pct'],

  // ── temperature (two distinct physical things — rule 6) ──
  tempDeviation: ['temperature deviation', 'temp deviation', 'skin temperature deviation',
    'skin temp deviation', 'temperature variation', 'skin temperature variation',
    'temperature delta', 'temp delta', 'temperature trend deviation', 'temp trend',
    'wrist temperature variation', 'relative temperature'],
  tempAbsolute: ['skin temp', 'skin temperature', 'wrist temperature', 'body temperature',
    'temperature', 'skin_temp_c', 'skin temp c'],

  // ── scores ──
  recoveryScore: ['recovery score', 'recovery', 'recovery_score', 'recovery pct', 'recovery %'],
  readinessScore: ['readiness score', 'readiness', 'readiness_score', 'daily readiness'],
  strain: ['day strain', 'strain', 'strain score', 'daily strain'],

  // ── activity ──
  steps: ['steps', 'step count', 'total steps', 'daily steps', 'step_count'],
  activeMinutes: ['active minutes', 'active time', 'activity minutes', 'exercise minutes',
    'active zone minutes', 'intensity minutes', 'active_minutes', 'minutes active'],
  energyKcal: ['energy burned', 'calories', 'calories burned', 'kcal', 'total calories',
    'energy expenditure', 'kilocalories', 'energy_kcal', 'total burn', 'kilojoules']
};

const GENERIC_INDEX = S.buildAliasIndex(GENERIC_ALIASES);

/**
 * Columns we recognise and deliberately do not map, so they do not clutter the
 * unknown-column report that exists to flag genuinely NEW columns.
 */
const GENERIC_IGNORE = S.buildAliasIndex({
  ignored: ['user id', 'userid', 'id', 'row', 'row number', 'source', 'provider', 'notes', 'note',
    'comment', 'comments', 'timezone', 'tz', 'cycle timezone', 'cycle end time', 'device',
    'device name', 'raw', 'raw json', 'last sync time', 'lastsynctime']
});

/**
 * Below this, a "temperature" cannot be an absolute skin temperature (the
 * canonical floor is 24 C / 75 F) and is therefore a baseline deviation.
 */
const MIN_ABSOLUTE_TEMP = 15;

/** Fields whose duration column gets its own unit detection, with its own floor. */
const DURATION_SPECS = {
  totalSleep: { minMinutes: 60, maxMinutes: 1440 },
  inBed: { minMinutes: 60, maxMinutes: 1440 },
  remMin: { minMinutes: 1, maxMinutes: 1440 },
  deepMin: { minMinutes: 1, maxMinutes: 1440 },
  lightMin: { minMinutes: 1, maxMinutes: 1440 },
  awakeMin: { minMinutes: 1, maxMinutes: 1440 },
  napMinutes: { minMinutes: 1, maxMinutes: 1440 },
  sleepNeedMin: { minMinutes: 60, maxMinutes: 1440 },
  sleepDebtMin: { minMinutes: 1, maxMinutes: 1440 },
  activeMinutes: { minMinutes: 1, maxMinutes: 1440 }
};

/* ------------------------------------------------------------------ *
 * parse
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{name:string, text?:string, buffer?:Buffer}>|{files:Array}} input
 * @param {{timezone?:string}} [opts]
 */
function parse(input, opts) {
  const options = opts || {};
  const b = S.createBuilder(PROVIDER, {
    timezone: options.timezone || S.TZ,
    measurementSource: C.MEASUREMENT_SOURCE.DEVICE_EXPORT,
    confidence: GENERIC_CSV_CONFIDENCE
  });

  const files = S.expandFiles(input, b);
  if (!files.length) return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);

  let usable = 0;
  files.forEach((f) => {
    const name = f.name || 'unnamed';
    if (typeof f.text !== 'string' || f.text.trim() === '') {
      b.file(name, null);
      b.note('Skipped "' + name + '": it carried no readable text.');
      return;
    }
    const head = f.text.slice(0, 2000);
    if (head.indexOf(',') === -1 && head.indexOf('\t') !== -1) {
      b.file(name, null);
      b.note('Skipped "' + name + '": it looks tab-separated. Re-export it as a '
        + 'comma-separated CSV — converting tabs here would split any field that '
        + 'legitimately contains a comma.');
      return;
    }

    const table = S.readCsvTable(f.text, GENERIC_INDEX, { maxHeaderScan: 8, minKnown: 2 });
    if (table.headerLine === -1) {
      b.file(name, null);
      b.note('Skipped "' + name + '": no header row with at least two recognisable '
        + 'metric columns was found in the first lines.');
      return;
    }
    const fields = new Set(table.fields.filter(Boolean));
    if (!fields.has('date') && !fields.has('wakeTime')) {
      b.file(name, null);
      b.note('Skipped "' + name + '": no date or wake-time column, so no row could '
        + 'be attributed to a calendar date.');
      return;
    }

    usable += 1;
    parseTable(table, b, name, options);
  });

  if (!usable) {
    return b.finish(['No file in this upload could be read as a dated CSV of wearable metrics.']);
  }
  return b.finish();
}

/** Detect each duration column's unit once, across the whole column (rule 4). */
function detectDurationUnits(table, b, name) {
  const units = Object.create(null);
  Object.keys(DURATION_SPECS).forEach((field) => {
    if (table.fields.indexOf(field) === -1) return;
    const spec = DURATION_SPECS[field];
    const cells = table.rows.map((r) => r.raw[field]);
    // `HH:MM` cells are self-describing and are excluded from the magnitude vote.
    const numericCells = cells.filter((v) => !/^\d{1,3}:\d{2}/.test(String(v == null ? '' : v).trim()));
    const det = S.detectSeriesDurationUnit(numericCells, table.headerByField[field], {
      minMinutes: spec.minMinutes, maxMinutes: spec.maxMinutes
    });
    units[field] = det;
    if (det.unit && det.basis === 'magnitude') {
      b.note('Column "' + (table.headerByField[field] || field) + '" in "' + name
        + '" declares no unit; read as ' + det.unit + ' from its own values (median '
        + det.median + ').');
    }
  });
  return units;
}

function parseTable(table, b, name, options) {
  const tz = options.timezone || S.TZ;
  const fileRec = b.file(name, 'generic_csv');
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'generic_csv', col));

  const units = detectDurationUnits(table, b, name);
  const scaledPercents = new Set();

  function dur(row, field) {
    const det = units[field];
    const spec = DURATION_SPECS[field] || { maxMinutes: 1440 };
    return S.parseDurationMinutes(row.raw[field], table.headerByField[field], {
      assume: det && det.unit ? det.unit : null,
      maxMinutes: spec.maxMinutes,
      inferByMagnitude: true
    }).minutes;
  }

  function pct(row, field) {
    const res = S.percentFromMaybeFraction(row.raw[field]);
    if (res.scaled) scaledPercents.add(table.headerByField[field] || field);
    return res.value;
  }

  table.rows.forEach((row) => {
    const raw = row.raw;

    // ── rule 2: attribute to the WAKE date whenever the file tells us one ──
    let date = raw.wakeTime ? S.ymdOf(raw.wakeTime, tz) : null;
    let attributedFrom = date ? 'wakeTime' : null;
    if (!date && raw.date) {
      date = S.ymdOf(raw.date, tz);
      attributedFrom = date ? 'dateColumn' : null;
    }
    if (!date) {
      const had = S.toStr(raw.wakeTime) || S.toStr(raw.date);
      b.reject(fileRec, row.rowNumber,
        had ? 'unparseable date (' + had + ')' : 'missing date (cannot attribute a calendar date)',
        row.cells);
      return;
    }
    if (attributedFrom === 'dateColumn' && table.fields.indexOf('wakeTime') === -1) {
      b.note('"' + name + '" has no wake-time column; rows are dated by their own '
        + 'date column, which we cannot confirm is the wake date.');
    }

    const totalSleep = dur(row, 'totalSleep');

    // ── rule 3: a nap never inflates the night ──
    if (S.toBool(raw.napFlag) === true) {
      b.addNap(date, totalSleep !== null ? totalSleep : dur(row, 'napMinutes'));
      fileRec.rowsParsed += 1;
      return;
    }
    const napOnly = dur(row, 'napMinutes');
    if (napOnly !== null) b.addNap(date, napOnly);

    const patch = {
      sleepMinutes: totalSleep,
      remMin: dur(row, 'remMin'),
      deepMin: dur(row, 'deepMin'),
      lightMin: dur(row, 'lightMin'),
      awakeMin: dur(row, 'awakeMin'),
      sleepNeedMin: dur(row, 'sleepNeedMin'),
      sleepDebtMin: dur(row, 'sleepDebtMin'),
      activeMinutes: dur(row, 'activeMinutes'),
      sleepEfficiencyPct: pct(row, 'sleepEfficiencyPct'),
      sleepPerformancePct: pct(row, 'sleepPerformancePct'),
      sleepConsistencyPct: pct(row, 'sleepConsistencyPct'),
      recoveryScore: pct(row, 'recoveryScore'),
      readinessScore: pct(row, 'readinessScore'),
      spo2: pct(row, 'spo2'),
      restingHr: S.toNum(raw.restingHr),
      avgHr: S.toNum(raw.avgHr),
      maxHr: S.toNum(raw.maxHr),
      respiratoryRate: S.toNum(raw.respiratoryRate),
      steps: S.toNum(raw.steps)
    };

    const energy = S.canonicalizeEnergy(raw.energyKcal, table.headerByField.energyKcal);
    if (energy.energyKcal !== null) patch.energyKcal = energy.energyKcal;

    // ── HRV: never guess the method (rule 6) ──
    const hrv = S.toNum(raw.hrvMs);
    if (hrv !== null) {
      patch.hrvMs = hrv;
      patch.hrvMethod = readHrvMethod(raw.hrvMethod);
    }

    // ── temperature: absolute vs deviation decided by header AND value ──
    Object.assign(patch, readTemperature(raw, table.headerByField, b, date));

    // ── strain is never canonical here — see the module comment ──
    const scores = {};
    const strain = S.toNum(raw.strain);
    if (strain !== null) scores['generic_csv.strain'] = strain;
    const inBed = dur(row, 'inBed');
    if (inBed !== null) scores['generic_csv.time_in_bed_min'] = inBed;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: row.rowNumber, kind: 'generic_csv', providerScores: scores
    });
  });

  scaledPercents.forEach((col) => {
    b.note('Column "' + col + '" in "' + name + '" held 0-1 fractions; read as percentages.');
  });
}

/**
 * The method tag is only trusted when the file states it. Anything unrecognised —
 * including a blank — becomes `'unknown'`, which keeps the reading out of the
 * RMSSD series rather than silently joining it.
 */
function readHrvMethod(raw) {
  const s = S.toStr(raw);
  if (!s) return C.HRV_METHOD.UNKNOWN;
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'rmssdsleep' || k === 'rmssdovernight' || k === 'rmssdnight') return C.HRV_METHOD.RMSSD_SLEEP;
  if (k === 'rmssdspot' || k === 'rmssdmanual') return C.HRV_METHOD.RMSSD_SPOT;
  if (k === 'sdnnspot' || k === 'sdnnmanual') return C.HRV_METHOD.SDNN_SPOT;
  if (k === 'sdnnsleep' || k === 'sdnnovernight') return C.HRV_METHOD.SDNN_SLEEP;
  return C.HRV_METHOD.UNKNOWN;
}

/**
 * Decide which temperature field a reading belongs in.
 *
 *  - an explicit deviation column is a deviation, full stop;
 *  - a column named as an absolute is only believed when its VALUE could be one.
 *    A "skin temperature" of -0.3 or 0.42 is a baseline delta whatever the header
 *    says, and writing it to `skinTempC` would report hypothermia.
 *
 * @returns {Object} the temperature fields of the patch (possibly empty)
 */
function readTemperature(raw, headerByField, b, date) {
  const devCell = raw.tempDeviation;
  if (S.toNum(devCell) !== null) {
    const dev = S.canonicalizeTempDeviation(devCell, headerByField.tempDeviation);
    return {
      skinTempDeviationC: dev.skinTempDeviationC,
      tempBasis: C.TEMP_BASIS.DEVIATION_C,
      skinTempRaw: dev.skinTempRaw,
      skinTempUnit: dev.skinTempUnit
    };
  }

  const absCell = raw.tempAbsolute;
  const absRaw = S.toNum(absCell);
  if (absRaw === null) return {};

  if (Math.abs(absRaw) < MIN_ABSOLUTE_TEMP) {
    const dev = S.canonicalizeTempDeviation(absCell, headerByField.tempAbsolute);
    b.note('Column "' + (headerByField.tempAbsolute || 'temperature') + '" held '
      + absRaw + ' on ' + date + ', which is far too small to be a skin temperature; '
      + 'read as a baseline deviation, not as an absolute.');
    return {
      skinTempDeviationC: dev.skinTempDeviationC,
      tempBasis: C.TEMP_BASIS.DEVIATION_C,
      skinTempRaw: dev.skinTempRaw,
      skinTempUnit: dev.skinTempUnit
    };
  }

  const abs = S.canonicalizeTemp(absCell, headerByField.tempAbsolute);
  if (abs.skinTempC === null) return {};
  return {
    skinTempC: abs.skinTempC,
    tempBasis: C.TEMP_BASIS.ABSOLUTE_C,
    skinTempRaw: abs.skinTempRaw,
    skinTempUnit: abs.skinTempUnit
  };
}

module.exports = {
  parse,
  readHrvMethod,
  PROVIDER,
  GENERIC_CSV_CONFIDENCE,
  GENERIC_ALIASES,
  GENERIC_INDEX
};
