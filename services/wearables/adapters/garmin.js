'use strict';

/**
 * Garmin adapter — the Garmin Connect GDPR account export (a ZIP of JSON).
 *
 * The archive is a tree of per-domain JSON files rather than one table:
 *
 *   DI_CONNECT/DI-Connect-Wellness/<user>_sleepData.json
 *   DI_CONNECT/DI-Connect-Wellness/<user>_hrvData.json
 *   DI_CONNECT/DI-Connect-Aggregator/UDSFile_2024-01-01_2024-04-01.json
 *
 * `_shared.expandFiles` unpacks the ZIP, so the caller can hand this adapter the
 * raw archive buffer or a pre-extracted list of files; both work.
 *
 * ── What lands where, and why (rule 6) ──────────────────────────────────────
 *
 *  Body Battery and Stress are Garmin-proprietary composites with no equivalent
 *  anywhere else — Body Battery in particular fuses HRV, stress, sleep and
 *  activity through an undisclosed model. They go to `providerScores`
 *  (`garmin.body_battery`, `garmin.stress_avg`) and NEVER to `recoveryScore` or
 *  `readinessScore`: a Body Battery of 62 is not "62% recovered" in Whoop's sense
 *  and charting them on one axis would be a fiction.
 *
 *  Garmin's sleep score is likewise its own composite -> `garmin.sleep_score`.
 *
 *  Garmin has NO Whoop-scale strain, so `strain` stays null. Intensity minutes
 *  are an activity dose and go to the canonical `activeMinutes`, which means
 *  exactly that on every device.
 *
 *  Sleep DURATION is the sum of the measured stages, not the bed-window: Garmin's
 *  start-to-end window includes the awake time it measured separately, so using
 *  the window would overstate every night.
 *
 * @module services/wearables/adapters/garmin
 */

const C = require('../canonicalDay');
const S = require('./_shared');

const PROVIDER = 'garmin';
const GARMIN_EXPORT_CONFIDENCE = 0.95;

/* ------------------------------------------------------------------ *
 * File routing
 *
 * UNVERIFIED: the file names below are the Garmin Connect GDPR export as
 * understood without a sample archive. A real export confirms the exact
 * `DI-Connect-*` folder names and the `<user>_` prefixes. Anything unmatched is
 * noted and skipped, never guessed at.
 * ------------------------------------------------------------------ */

function classifyFile(name) {
  const base = S.lowerBase(name);
  if (!base || !/\.json$/.test(base)) return null;
  const stem = base.replace(/\.json$/, '');

  if (/hrv|heartratevariability|heart_rate_variability/.test(stem)) return 'hrv_json';
  if (/sleep/.test(stem)) return 'sleep_json';
  if (/udsfile|dailysummar|daily_summar|dailies|aggregator|userdailysummary/.test(stem)) return 'daily_json';
  if (/summarizedactivit|_activities|fitnessactivit/.test(stem)) return 'activities_json';
  if (/biometric|userbiometric/.test(stem)) return 'biometrics_json';
  return null;
}

/* ------------------------------------------------------------------ *
 * Alias tables (rule 1)
 * ------------------------------------------------------------------ */

const SLEEP_ALIASES = {
  calendarDate: ['calendardate', 'calendar date', 'date', 'sleepdate'],
  sleepStartGmt: ['sleepstarttimestampgmt', 'sleep start timestamp gmt', 'sleepstartgmt'],
  sleepEndGmt: ['sleependtimestampgmt', 'sleep end timestamp gmt', 'sleependgmt'],
  sleepStartLocal: ['sleepstarttimestamplocal', 'sleep start timestamp local'],
  sleepEndLocal: ['sleependtimestamplocal', 'sleep end timestamp local'],
  deepSeconds: ['deepsleepseconds', 'deep sleep seconds', 'deepsleepduration'],
  lightSeconds: ['lightsleepseconds', 'light sleep seconds', 'lightsleepduration'],
  remSeconds: ['remsleepseconds', 'rem sleep seconds', 'remsleepduration'],
  awakeSeconds: ['awakesleepseconds', 'awake sleep seconds', 'awakeduration', 'awakeseconds'],
  unmeasurableSeconds: ['unmeasurablesleepseconds', 'unmeasurableseconds'],
  respiration: ['averagerespirationvalue', 'average respiration value', 'averagerespiration', 'avgrespiration'],
  lowestRespiration: ['lowestrespirationvalue', 'lowest respiration value'],
  highestRespiration: ['highestrespirationvalue', 'highest respiration value'],
  restingHeartRate: ['restingheartrate', 'resting heart rate', 'sleeprestingheartrate'],
  avgSleepStress: ['avgsleepstress', 'average sleep stress', 'sleepstress'],
  sleepScore: ['overallsleepscore', 'sleepscores overall value', 'sleepscores overallscore', 'sleep score', 'sleepqualityscore'],
  spo2Average: ['spo2sleepsummary averagespo2', 'averagespo2', 'average spo2', 'averagespo2value', 'spo2 average'],
  spo2Lowest: ['spo2sleepsummary lowestspo2', 'lowestspo2', 'lowest spo2'],
  napSeconds: ['napseconds', 'nap seconds', 'totalnapseconds']
};
const SLEEP_INDEX = S.buildAliasIndex(SLEEP_ALIASES);

const SLEEP_IGNORE = S.buildAliasIndex({
  ignored: [
    'sleepwindowconfirmationtype', 'sleepwindowconfirmed', 'retro', 'autosleepstarttimestampgmt',
    'autosleependtimestampgmt', 'sleepversion', 'devicerememberedsleep', 'userprofilepk',
    'sleepresultttype', 'sleepresulttype', 'agerangebasedsleepneed', 'sleepneed baseline',
    'sleepscores overall qualifierkey', 'sleepscores totalduration qualifierkey',
    'sleepscores stress qualifierkey', 'sleepscores awakecount qualifierkey',
    'sleepscores rempercentage qualifierkey', 'sleepscores lightpercentage qualifierkey',
    'sleepscores deeppercentage qualifierkey', 'sleepscores restlessness qualifierkey',
    'sleepscores restfulness qualifierkey', 'awakecount', 'avgoverninghrv', 'hrvstatus'
  ]
});

const DAILY_ALIASES = {
  calendarDate: ['calendardate', 'calendar date', 'date', 'summarydate'],
  totalSteps: ['totalsteps', 'total steps', 'steps'],
  totalKilocalories: ['totalkilocalories', 'total kilocalories', 'totalcalories', 'calories'],
  activeKilocalories: ['activekilocalories', 'active kilocalories', 'activecalories'],
  restingHeartRate: ['restingheartrate', 'resting heart rate', 'restinghr'],
  minHeartRate: ['minheartrate', 'min heart rate', 'minimumheartrate'],
  maxHeartRate: ['maxheartrate', 'max heart rate', 'maximumheartrate'],
  averageHeartRate: ['averageheartrate', 'average heart rate', 'avgheartrate'],
  averageStressLevel: ['averagestresslevel', 'average stress level', 'avgstresslevel', 'overallstresslevel'],
  maxStressLevel: ['maxstresslevel', 'max stress level'],
  bodyBatteryHigh: ['bodybatteryhighestvalue', 'bodybatterymostchargedvalue', 'bodybatteryhigh', 'bodybatterychargedvalue'],
  bodyBatteryLow: ['bodybatterylowestvalue', 'bodybatterylow', 'bodybatterydrainedvalue'],
  moderateIntensityMinutes: ['moderateintensityminutes', 'moderate intensity minutes'],
  vigorousIntensityMinutes: ['vigorousintensityminutes', 'vigorous intensity minutes'],
  averageSpo2: ['averagespo2', 'average spo2', 'averagespo2value', 'avgspo2'],
  respiration: ['avgwakingrespirationvalue', 'averagerespirationvalue', 'avgrespirationvalue']
};
const DAILY_INDEX = S.buildAliasIndex(DAILY_ALIASES);

const DAILY_IGNORE = S.buildAliasIndex({
  ignored: [
    'userprofilepk', 'uuid', 'starttimestampgmt', 'endtimestampgmt', 'starttimestamplocal',
    'endtimestamplocal', 'wellnessstarttimegmt', 'wellnessendtimegmt', 'durationinmilliseconds',
    'includesactivitydata', 'includescalorieconsumeddata', 'includeswellnessdata',
    'privacyprotected', 'source', 'version', 'rule', 'floorsascended', 'floorsdescended',
    'totaldistancemeters', 'wellnessdistancemeters', 'highlyactiveseconds', 'activeseconds',
    'sedentaryseconds', 'sleepingseconds', 'measurableawakeduration', 'measurableasleepduration'
  ]
});

const HRV_ALIASES = {
  calendarDate: ['calendardate', 'calendar date', 'date'],
  lastNightAvg: ['lastnightavg', 'last night avg', 'lastnightaverage', 'overnightavg', 'avgovernighthrv'],
  lastNight5MinHigh: ['lastnight5minhigh', 'last night 5 min high'],
  weeklyAvg: ['weeklyavg', 'weekly avg', 'weeklyaverage'],
  status: ['status', 'hrvstatus', 'hrv status'],
  baselineBalancedLow: ['baseline balancedlow', 'balancedlow'],
  baselineBalancedUpper: ['baseline balancedupper', 'balancedupper']
};
const HRV_INDEX = S.buildAliasIndex(HRV_ALIASES);

const HRV_IGNORE = S.buildAliasIndex({
  ignored: ['userprofilepk', 'baseline lowupper', 'baseline markervalue', 'createtimestampgmt', 'createtimestamplocal', 'feedback']
});

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
    confidence: GARMIN_EXPORT_CONFIDENCE
  });

  const files = S.expandFiles(input, b);
  if (!files.length) return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);

  // Sleep first: it seeds the nightly record the other files fill in around.
  const ORDER = ['sleep_json', 'hrv_json', 'daily_json', 'activities_json', 'biometrics_json'];
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

    if (!kind) {
      b.file(name, null);
      b.note('Unrecognised file skipped: ' + name);
      return;
    }
    if (typeof f.text !== 'string' || f.text.trim() === '') {
      b.file(name, kind);
      b.note('Skipped "' + name + '": it carried no readable text.');
      return;
    }
    const fileRec = b.file(name, kind);
    try {
      if (kind === 'sleep_json') parseSleepJson(f.text, b, fileRec, options);
      else if (kind === 'daily_json') parseDailyJson(f.text, b, fileRec, options);
      else if (kind === 'hrv_json') parseHrvJson(f.text, b, fileRec, options);
      else {
        b.note('Recognised but not yet mapped, so nothing was imported from it: ' + name);
        return;
      }
      usable += 1;
    } catch (err) {
      b.note('Could not parse "' + name + '": ' + ((err && err.message) || String(err)));
    }
  });

  if (!usable) {
    return b.finish(['No file in this upload matched a known Garmin Connect export layout.']);
  }
  return b.finish();
}

/** Garmin wraps its arrays in several ways depending on the domain. */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const arrays = Object.keys(value).filter((k) => Array.isArray(value[k]));
    if (arrays.length === 1) return value[arrays[0]];
    return [value];
  }
  return [];
}

/** Seconds -> minutes, or null. Garmin's sleep durations are always seconds. */
function secToMin(v) {
  const n = S.numOr(v);
  if (n === null || n < 0) return null;
  return S.round(n / 60, 2);
}

/**
 * Sleep records.
 *
 * Attribution (rule 2): Garmin's own `calendarDate` for a sleep record is the
 * date the member WOKE on, which is exactly the contract's rule, so it is used
 * directly; the GMT end timestamp is the fallback.
 *
 * UNVERIFIED: that `calendarDate` is the wake date rather than the bedtime date.
 * A real export covering a night that crosses a month boundary settles it in one
 * glance — the record for a 31st->1st night carries one or the other.
 */
function parseSleepJson(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value);
  if (!rows.length) { b.note('No sleep records in "' + fileRec.name + '".'); return; }

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    if (!rawRow || typeof rawRow !== 'object') {
      b.reject(fileRec, rowNumber, 'sleep record is not an object', rawRow);
      return;
    }

    // Naps are handled before mapping so their array does not flood the unknown
    // column report, and so they can never reach the nightly fields (rule 3).
    const naps = Array.isArray(rawRow.napList) ? rawRow.napList : [];
    const forMapping = Object.assign({}, rawRow);
    delete forMapping.napList;
    delete forMapping.sleepLevels;
    delete forMapping.sleepMovement;
    delete forMapping.wellnessEpochRespirationDataDTOList;
    delete forMapping.sleepStress;

    const mapped = S.mapJsonRecord(forMapping, SLEEP_INDEX, { ignore: SLEEP_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'sleep_json', k));
    const v = mapped.values;

    let date = v.calendarDate !== undefined ? S.ymdOf(v.calendarDate, tz) : null;
    if (!date && v.sleepEndGmt !== undefined) date = S.ymdOf(v.sleepEndGmt, tz);
    if (!date) {
      const had = v.calendarDate !== undefined || v.sleepEndGmt !== undefined;
      b.reject(fileRec, rowNumber,
        had ? 'unparseable calendarDate / sleep end timestamp' : 'missing calendarDate (cannot attribute a calendar date)',
        rawRow);
      return;
    }

    const deep = secToMin(v.deepSeconds);
    const light = secToMin(v.lightSeconds);
    const rem = secToMin(v.remSeconds);
    const awake = secToMin(v.awakeSeconds);

    // The night's length is the measured stages, NOT the bed window — the window
    // includes the awake time Garmin reports separately.
    const stages = [deep, light, rem].filter((x) => x !== null);
    const sleepMinutes = stages.length ? S.round(stages.reduce((a, x) => a + x, 0), 2) : null;

    const patch = {
      sleepMinutes: sleepMinutes,
      deepMin: deep,
      lightMin: light,
      remMin: rem,
      awakeMin: awake,
      respiratoryRate: S.numOr(v.respiration),
      restingHr: S.numOr(v.restingHeartRate),
      spo2: S.numOr(v.spo2Average)
    };

    const scores = {};
    const sleepScore = S.numOr(v.sleepScore);
    if (sleepScore !== null) scores['garmin.sleep_score'] = sleepScore;
    const sleepStress = S.numOr(v.avgSleepStress);
    if (sleepStress !== null) scores['garmin.sleep_stress_avg'] = sleepStress;
    const lowestSpo2 = S.numOr(v.spo2Lowest);
    if (lowestSpo2 !== null) scores['garmin.lowest_spo2'] = lowestSpo2;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: rowNumber, kind: 'sleep_json', providerScores: scores
    });

    // Naps accumulate and never touch the night.
    naps.forEach((nap) => {
      if (!nap || typeof nap !== 'object') return;
      const napSec = S.numOr(nap.napDurationSeconds != null ? nap.napDurationSeconds
        : (nap.durationSeconds != null ? nap.durationSeconds : nap.napSeconds));
      const napDate = nap.calendarDate !== undefined ? (S.ymdOf(nap.calendarDate, tz) || date) : date;
      b.addNap(napDate, secToMin(napSec));
    });
    const flatNap = secToMin(v.napSeconds);
    if (!naps.length && flatNap !== null) b.addNap(date, flatNap);
  });
}

/** UDSFile / daily-summary records: steps, calories, stress, Body Battery. */
function parseDailyJson(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value);
  if (!rows.length) { b.note('No daily summaries in "' + fileRec.name + '".'); return; }

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    if (!rawRow || typeof rawRow !== 'object') {
      b.reject(fileRec, rowNumber, 'daily summary is not an object', rawRow);
      return;
    }
    const mapped = S.mapJsonRecord(rawRow, DAILY_INDEX, { ignore: DAILY_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'daily_json', k));
    const v = mapped.values;

    const date = v.calendarDate !== undefined ? S.ymdOf(v.calendarDate, tz) : null;
    if (!date) {
      b.reject(fileRec, rowNumber,
        v.calendarDate !== undefined ? 'unparseable calendarDate' : 'missing calendarDate', rawRow);
      return;
    }

    // Intensity minutes are minutes of activity — the same physical thing the
    // canonical `activeMinutes` means everywhere else. Moderate and vigorous are
    // summed as measured; Garmin's "vigorous counts double" is a goal-tracking
    // rule for its own UI, not a property of the measurement.
    const mod = S.numOr(v.moderateIntensityMinutes);
    const vig = S.numOr(v.vigorousIntensityMinutes);
    const active = (mod === null && vig === null) ? null : S.round((mod || 0) + (vig || 0), 1);

    const patch = {
      steps: S.numOr(v.totalSteps),
      energyKcal: S.numOr(v.totalKilocalories),
      restingHr: S.numOr(v.restingHeartRate),
      maxHr: S.numOr(v.maxHeartRate),
      avgHr: S.numOr(v.averageHeartRate),
      spo2: S.numOr(v.averageSpo2),
      respiratoryRate: S.numOr(v.respiration),
      activeMinutes: active
    };
    // strain / recoveryScore / readinessScore stay null: Garmin publishes no
    // equivalent, and Body Battery is not one (see the module comment).

    const scores = {};
    const bbHigh = S.numOr(v.bodyBatteryHigh);
    if (bbHigh !== null) scores['garmin.body_battery'] = bbHigh;
    const bbLow = S.numOr(v.bodyBatteryLow);
    if (bbLow !== null) scores['garmin.body_battery_low'] = bbLow;
    const stress = S.numOr(v.averageStressLevel);
    if (stress !== null) scores['garmin.stress_avg'] = stress;
    const maxStress = S.numOr(v.maxStressLevel);
    if (maxStress !== null) scores['garmin.stress_max'] = maxStress;
    const activeKcal = S.numOr(v.activeKilocalories);
    if (activeKcal !== null) scores['garmin.active_kcal'] = activeKcal;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: rowNumber, kind: 'daily_json', providerScores: scores
    });
  });
}

/**
 * HRV status records.
 *
 * `lastNightAvg` is Garmin's overnight HRV. Garmin documents HRV Status as RMSSD
 * measured during sleep, which is the same construct Whoop and Oura publish, so
 * it carries `hrvMethod: 'rmssd_sleep'`.
 *
 * UNVERIFIED: that `lastNightAvg` is RMSSD in milliseconds rather than a derived
 * index. A real export cross-checked against the Connect app's own "HRV status"
 * number for the same night confirms it. If it turned out to be an index, the fix
 * is a one-line change to `HRV_METHOD.UNKNOWN` here — the method tag exists
 * precisely so that a wrong guess stays quarantined instead of polluting the
 * cross-device HRV series.
 */
function parseHrvJson(text, b, fileRec, options) {
  const tz = options.timezone || S.TZ;
  const doc = S.readJson(text);
  if (doc.error) { b.reject(fileRec, null, 'unreadable JSON: ' + doc.error, null); return; }
  const rows = asArray(doc.value);
  if (!rows.length) { b.note('No HRV records in "' + fileRec.name + '".'); return; }

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    if (!rawRow || typeof rawRow !== 'object') {
      b.reject(fileRec, rowNumber, 'HRV record is not an object', rawRow);
      return;
    }
    const mapped = S.mapJsonRecord(rawRow, HRV_INDEX, { ignore: HRV_IGNORE });
    mapped.unknown.forEach((k) => b.unknownColumn(fileRec, 'hrv_json', k));
    const v = mapped.values;

    const date = v.calendarDate !== undefined ? S.ymdOf(v.calendarDate, tz) : null;
    if (!date) {
      b.reject(fileRec, rowNumber,
        v.calendarDate !== undefined ? 'unparseable calendarDate' : 'missing calendarDate', rawRow);
      return;
    }

    const hrv = S.numOr(v.lastNightAvg);
    const patch = {};
    if (hrv !== null) {
      patch.hrvMs = hrv;
      patch.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP;
    }

    const scores = {};
    const weekly = S.numOr(v.weeklyAvg);
    if (weekly !== null) scores['garmin.hrv_weekly_avg'] = weekly;
    const high5 = S.numOr(v.lastNight5MinHigh);
    if (high5 !== null) scores['garmin.hrv_5min_high'] = high5;

    b.mergeDay(date, patch, {
      file: fileRec, rowNumber: rowNumber, kind: 'hrv_json', providerScores: scores
    });
  });
}

module.exports = {
  parse,
  classifyFile,
  PROVIDER,
  GARMIN_EXPORT_CONFIDENCE,
  SLEEP_ALIASES,
  DAILY_ALIASES,
  HRV_ALIASES
};
