'use strict';

/**
 * Oura adapter — the CSV a member downloads from the Oura web dashboard.
 *
 * One physical row per calendar date, with sleep, readiness and activity columns
 * side by side. Column NAMES and units drift between dashboard versions and
 * between metric/imperial accounts, so nothing here is read by position and every
 * unit is confirmed against the values before it is believed.
 *
 * ── What lands where, and why (rule 6) ──────────────────────────────────────
 *
 *  Oura's "Sleep Score" is an Oura-specific composite of duration, efficiency,
 *  latency, timing and restfulness with Oura's own weights. It is NOT the same
 *  quantity as Whoop's sleep performance (achieved / needed) or Fitbit's sleep
 *  score, so it goes to `providerScores['oura.sleep_score']` and NEVER to
 *  `sleepPerformancePct`. Charting the two together would show a "change" that is
 *  only a change of vendor.
 *
 *  "Readiness Score" is treated differently, deliberately. It is an explicit,
 *  documented 0-100 readiness figure — exactly what the canonical `readinessScore`
 *  field exists to hold — so it is written to BOTH `readinessScore` and
 *  `providerScores['oura.readiness_score']`. The duplicate is intentional: the
 *  canonical copy lets readiness trend across devices, and the namespaced copy
 *  keeps the Oura-native number recoverable if we ever decide the cross-device
 *  comparison was too generous. It is NOT written to `recoveryScore`, which is
 *  Whoop's HRV-derived percentage and a different construct.
 *
 *  Temperature is a DEVIATION from the member's own baseline, not an absolute
 *  skin temperature. It goes to `skinTempDeviationC` with `tempBasis:
 *  'deviation_c'` and must never touch `skinTempC` — a -0.3 written there would
 *  read as hypothermia.
 *
 *  HRV is the overnight average of RMSSD, so `hrvMethod: 'rmssd_sleep'`, the same
 *  method tag Whoop carries. Apple's SDNN must never join that series.
 *
 *  Oura has no Whoop-scale strain, so `strain` stays null. An activity score is
 *  not a strain and is not converted into one.
 *
 * @module services/wearables/adapters/oura
 */

const C = require('../canonicalDay');
const S = require('./_shared');

const PROVIDER = 'oura';

/** A vendor's own structured export is the strongest evidence tier we get. */
const OURA_EXPORT_CONFIDENCE = 0.95;

/* ------------------------------------------------------------------ *
 * Alias table (rule 1) — broad on purpose.
 *
 * UNVERIFIED: this table is built from the Oura dashboard CSV as understood
 * without a sample file to hand. A real export confirms the exact spellings; any
 * spelling missing here surfaces in `summary.unknownColumns` rather than being
 * guessed into a canonical field.
 * ------------------------------------------------------------------ */

const OURA_ALIASES = {
  date: ['date', 'day', 'summary date', 'summary_date', 'calendar date', 'sleep date'],

  // Attribution inputs. `Bedtime End` is the WAKE time and is preferred over the
  // date column, because rule 2 attributes a night to the date it ended on.
  bedtimeStart: ['bedtime start', 'bedtime_start', 'sleep start', 'sleep_start', 'sleep onset', 'bedtime start time'],
  bedtimeEnd: ['bedtime end', 'bedtime_end', 'sleep end', 'sleep_end', 'wake up time', 'wake time', 'wakeup time', 'bedtime end time', 'wake onset'],

  // Oura-native composites -> providerScores only.
  sleepScore: ['sleep score', 'total sleep score', 'sleep_score', 'sleep quality score'],
  readinessScore: ['readiness score', 'total readiness score', 'readiness_score', 'readiness'],
  activityScore: ['activity score', 'total activity score', 'activity_score'],

  // Durations.
  totalSleep: ['total sleep duration', 'total sleep', 'total sleep time', 'sleep duration', 'total_sleep_duration', 'asleep time', 'time asleep', 'sleep total'],
  inBed: ['total bedtime', 'time in bed', 'in bed duration', 'total_bedtime', 'bedtime duration', 'time_in_bed'],
  remSleep: ['rem sleep duration', 'rem sleep', 'rem_sleep_duration', 'rem duration', 'rem'],
  deepSleep: ['deep sleep duration', 'deep sleep', 'deep_sleep_duration', 'deep duration', 'deep'],
  lightSleep: ['light sleep duration', 'light sleep', 'light_sleep_duration', 'light duration', 'light'],
  awakeTime: ['awake time', 'awake duration', 'time awake', 'total awake time', 'awake'],
  sleepLatency: ['sleep latency', 'sleep_latency', 'onset latency', 'sleep onset latency', 'minutes to fall asleep'],

  // Scalars.
  sleepEfficiency: ['sleep efficiency', 'sleep_efficiency', 'efficiency'],
  restingHr: ['average resting heart rate', 'resting heart rate', 'resting_heart_rate', 'avg resting heart rate', 'average resting hr', 'resting hr'],
  lowestHr: ['lowest resting heart rate', 'lowest heart rate', 'lowest hr', 'minimum heart rate', 'lowest resting hr'],
  avgHr: ['average heart rate', 'average hr', 'avg hr', 'mean heart rate'],
  hrv: ['average hrv', 'hrv', 'heart rate variability', 'average heart rate variability', 'hrv average', 'rmssd', 'average rmssd'],
  respiratoryRate: ['respiratory rate', 'respiration rate', 'breathing rate', 'average respiratory rate', 'resp rate'],
  tempDeviation: ['temperature deviation', 'temperature_deviation', 'skin temperature deviation', 'temperature delta', 'temp deviation'],
  tempTrendDeviation: ['temperature trend deviation', 'temperature_trend_deviation', 'temp trend deviation'],
  spo2: ['average spo2', 'spo2', 'spo2 average', 'average blood oxygen', 'blood oxygen', 'oxygen saturation', 'average oxygen saturation'],
  steps: ['steps', 'total steps', 'step count', 'daily steps'],
  totalBurn: ['total burn', 'cal total', 'total calories', 'calories total', 'cal_total', 'calories'],
  activityBurn: ['activity burn', 'cal active', 'active calories', 'activity calories', 'cal_active'],
  restlessness: ['restless sleep', 'restlessness', 'restless periods'],

  // Row typing.
  sleepType: ['type', 'sleep type', 'period type', 'sleep period type'],
  isNap: ['nap', 'is nap', 'naps', 'is_nap']
};

const OURA_INDEX = S.buildAliasIndex(OURA_ALIASES);

/** Header text that means "this is a deviation", used as a second confirmation. */
const DEVIATION_HINT = /deviation|delta|variation|trend/i;

/**
 * Does this file look like an Oura dashboard CSV?
 * A date column plus at least two Oura-ish metrics; deliberately loose, because a
 * member renaming the file must not break the import.
 */
function looksLikeOura(table) {
  if (!table || table.headerLine === -1) return false;
  const fields = new Set(table.fields.filter(Boolean));
  if (!fields.has('date') && !fields.has('bedtimeEnd')) return false;
  let hits = 0;
  ['sleepScore', 'readinessScore', 'activityScore', 'totalSleep', 'hrv', 'restingHr',
    'tempDeviation', 'tempTrendDeviation', 'respiratoryRate', 'remSleep', 'deepSleep']
    .forEach((f) => { if (fields.has(f)) hits += 1; });
  return hits >= 2;
}

/**
 * Parse an Oura export.
 *
 * @param {Array<{name:string, text?:string, buffer?:Buffer}>|{files:Array}} input
 * @param {{timezone?:string}} [opts]
 * @returns {{days:Object[], workouts:Object[], journal:Object[], summary:Object, rejected:Object[]}}
 */
function parse(input, opts) {
  const options = opts || {};
  const b = S.createBuilder(PROVIDER, {
    timezone: options.timezone || S.TZ,
    measurementSource: C.MEASUREMENT_SOURCE.DEVICE_EXPORT,
    confidence: OURA_EXPORT_CONFIDENCE
  });

  const files = S.expandFiles(input, b);
  if (!files.length) {
    return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);
  }

  let usable = 0;
  files.forEach((f) => {
    const name = f.name || 'unnamed';
    if (typeof f.text !== 'string' || f.text.trim() === '') {
      b.file(name, null);
      b.note('Skipped "' + name + '": it carried no readable text.');
      return;
    }
    if (!/\.csv$/i.test(S.lowerBase(name)) && !/,/.test(f.text.slice(0, 400))) {
      b.file(name, null);
      b.note('Skipped "' + name + '": not a CSV.');
      return;
    }
    const table = S.readCsvTable(f.text, OURA_INDEX, { maxHeaderScan: 8, minKnown: 2 });
    if (!looksLikeOura(table)) {
      b.file(name, null);
      b.note('Skipped "' + name + '": no Oura-shaped header row was found in the first lines.');
      return;
    }
    usable += 1;
    parseOuraTable(table, b, name, options);
  });

  if (!usable) {
    const empty = b.finish(['No file in this upload looked like an Oura dashboard CSV export.']);
    return empty;
  }
  return b.finish();
}

/** Parse one recognised Oura table into the builder. */
function parseOuraTable(table, b, name, options) {
  const fileRec = b.file(name, 'oura_daily');
  table.unknown.forEach((col) => b.unknownColumn(fileRec, 'oura_daily', col));

  const tz = options.timezone || S.TZ;

  // ── unit detection, once per file, across the whole column (rule 4) ──
  // UNVERIFIED: the Oura dashboard CSV is understood to write sleep durations in
  // SECONDS. That is only the starting assumption here — it is discarded if the
  // column's median does not land inside a plausible night, so an export in
  // minutes or in decimal hours is read correctly regardless.
  const totalSleepCells = table.rows.map((r) => r.raw.totalSleep);
  const detected = S.detectSeriesDurationUnit(totalSleepCells, table.headerByField.totalSleep, {
    assume: 's', minMinutes: 60, maxMinutes: 1440
  });
  if (detected.unit) {
    b.note('Oura durations in "' + name + '" read as ' + detected.unit
      + ' (detected from ' + detected.basis + ', median ' + detected.median + ').');
  } else if (totalSleepCells.some((v) => S.toNum(v) !== null)) {
    b.note('Could not establish the duration unit of "' + name + '"; sleep durations were left null.');
  }
  const durOpts = { assume: detected.unit, maxMinutes: 1440 };
  const dur = (raw, header) => S.parseDurationMinutes(raw, header, durOpts).minutes;

  table.rows.forEach((row) => {
    const raw = row.raw;

    // ── rule 2: a night belongs to the date it ENDED on ──
    // Bedtime End is the wake time and is authoritative. The date column is only
    // a fallback, and when it is used we say so, because we could not confirm
    // against a wake time that Oura attributed the row the same way we would.
    let date = raw.bedtimeEnd ? S.ymdOf(raw.bedtimeEnd, tz) : null;
    let attributedFrom = date ? 'bedtimeEnd' : null;
    if (!date && raw.date) {
      date = S.ymdOf(raw.date, tz);
      attributedFrom = date ? 'dateColumn' : null;
    }
    if (!date) {
      const had = S.toStr(raw.bedtimeEnd) || S.toStr(raw.date);
      b.reject(fileRec, row.rowNumber,
        had ? 'unparseable date (' + had + ')' : 'missing date (cannot attribute a calendar date)',
        row.cells);
      return;
    }
    if (attributedFrom === 'dateColumn') {
      b.note('Rows in "' + name + '" carry no bedtime-end column; dates come from Oura\'s own date column.');
    }

    const totalSleepMin = dur(raw.totalSleep, table.headerByField.totalSleep);

    // ── rule 3: naps accumulate, they never inflate the night ──
    const typeStr = (S.toStr(raw.sleepType) || '').toLowerCase();
    const napFlag = S.toBool(raw.isNap);
    const isNap = napFlag === true || /(^|[^a-z])nap([^a-z]|$)/.test(typeStr);
    if (isNap) {
      b.addNap(date, totalSleepMin);
      fileRec.rowsParsed += 1;
      return;
    }

    const patch = {
      sleepMinutes: totalSleepMin,
      remMin: dur(raw.remSleep, table.headerByField.remSleep),
      deepMin: dur(raw.deepSleep, table.headerByField.deepSleep),
      lightMin: dur(raw.lightSleep, table.headerByField.lightSleep),
      awakeMin: dur(raw.awakeTime, table.headerByField.awakeTime),
      sleepEfficiencyPct: S.toNum(raw.sleepEfficiency),
      respiratoryRate: S.toNum(raw.respiratoryRate),
      restingHr: S.toNum(raw.restingHr),
      avgHr: S.toNum(raw.avgHr),
      spo2: S.toNum(raw.spo2),
      steps: S.toNum(raw.steps)
    };

    // Oura's readiness IS a 0-100 readiness score — see the module comment.
    const readiness = S.toNum(raw.readinessScore);
    patch.readinessScore = readiness;

    // strain stays null: Oura has no Whoop-scale strain and an activity score is
    // not one. recoveryScore stays null for the same reason.

    // ── HRV: overnight RMSSD (rule 6) ──
    const hrv = S.toNum(raw.hrv);
    if (hrv !== null) {
      patch.hrvMs = hrv;
      // UNVERIFIED: Oura documents its nightly HRV as the average of RMSSD across
      // the sleep period. A real export plus the app's own definition confirms it.
      patch.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP;
    }

    // ── energy ──
    const energy = S.canonicalizeEnergy(raw.totalBurn, table.headerByField.totalBurn);
    if (energy.energyKcal !== null) patch.energyKcal = energy.energyKcal;

    // ── temperature: a DEVIATION, never an absolute (rule 6) ──
    let tempHeader = table.headerByField.tempDeviation;
    let tempCell = raw.tempDeviation;
    let tempSource = 'tempDeviation';
    if (S.toNum(tempCell) === null && S.toNum(raw.tempTrendDeviation) !== null) {
      tempHeader = table.headerByField.tempTrendDeviation;
      tempCell = raw.tempTrendDeviation;
      tempSource = 'tempTrendDeviation';
    }
    const temp = S.canonicalizeTempDeviation(tempCell, tempHeader);
    if (temp.skinTempDeviationC !== null) {
      // Second confirmation: the header must actually say "deviation"/"trend"/
      // "delta", or the magnitude must be small enough that it cannot be an
      // absolute skin temperature. Anything else is left unmapped rather than
      // risk a real temperature landing in the deviation field, or vice versa.
      const headerSaysDeviation = DEVIATION_HINT.test(String(tempHeader || ''));
      if (headerSaysDeviation || Math.abs(temp.skinTempDeviationC) <= 6) {
        patch.skinTempDeviationC = temp.skinTempDeviationC;
        patch.tempBasis = C.TEMP_BASIS.DEVIATION_C;
        patch.skinTempRaw = temp.skinTempRaw;
        patch.skinTempUnit = temp.skinTempUnit;
      } else {
        b.note('Ignored an Oura temperature of ' + temp.skinTempRaw + ' from "'
          + tempHeader + '": too large to be a baseline deviation and not labelled as an absolute.');
      }
      if (tempSource === 'tempTrendDeviation') {
        b.note('Oura temperature taken from the trend-deviation column in "' + name + '".');
      }
    }

    // ── device-native composites (rule 6) ──
    const scores = {};
    const sleepScore = S.toNum(raw.sleepScore);
    if (sleepScore !== null) scores['oura.sleep_score'] = sleepScore;
    if (readiness !== null) scores['oura.readiness_score'] = readiness;
    const activityScore = S.toNum(raw.activityScore);
    if (activityScore !== null) scores['oura.activity_score'] = activityScore;
    const lowestHr = S.toNum(raw.lowestHr);
    if (lowestHr !== null) scores['oura.lowest_resting_hr'] = lowestHr;
    const restless = S.toNum(raw.restlessness);
    if (restless !== null) scores['oura.restlessness'] = restless;
    const activityBurn = S.canonicalizeEnergy(raw.activityBurn, table.headerByField.activityBurn);
    if (activityBurn.energyKcal !== null) scores['oura.activity_burn_kcal'] = activityBurn.energyKcal;
    const inBedMin = dur(raw.inBed, table.headerByField.inBed);
    if (inBedMin !== null) scores['oura.time_in_bed_min'] = inBedMin;
    const latencyMin = S.parseDurationMinutes(raw.sleepLatency, table.headerByField.sleepLatency, {
      assume: detected.unit, maxMinutes: 600
    }).minutes;
    if (latencyMin !== null) scores['oura.sleep_latency_min'] = latencyMin;

    b.mergeDay(date, patch, {
      file: fileRec,
      rowNumber: row.rowNumber,
      kind: 'oura_daily',
      providerScores: scores
    });
  });
}

module.exports = {
  parse,
  PROVIDER,
  OURA_ALIASES,
  OURA_INDEX,
  OURA_EXPORT_CONFIDENCE
};
