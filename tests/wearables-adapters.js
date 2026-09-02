/**
 * Golden-file test for the structured-file wearable adapters.
 * Run: node tests/wearables-adapters.js      (no dependencies, no server, no DB)
 *
 * Covers services/wearables/adapters/{_shared,oura,fitbit,garmin,polar,amazfit,
 * genericCsv}.js against hand-authored fixtures in tests/fixtures/devices/.
 *
 * The fixtures deliberately contain the hard cases:
 *   - a UTF-8 BOM + CRLF line endings (oura/oura_trends.csv)
 *   - a UTF-8 BOM + two preamble lines before the header (generic/coach_sheet.csv)
 *   - midnight-crossing sleeps attributed to the WAKE date
 *   - nap rows that must NOT inflate nightly sleep
 *   - blank numerics that must stay null (never 0)
 *   - malformed dates that must be rejected, never guessed
 *   - quoted fields containing commas
 *   - unknown extra columns that must be reported, not fatal
 *   - a temperature DEVIATION that must never land in skinTempC
 *   - a temperature too large to be a deviation, which must be refused outright
 *   - two rows colliding on one calendar date
 *   - sleep written as HH:MM, as seconds and as minutes
 *   - percentages written as 0-1 fractions
 *
 * The backbone of the suite is that EVERY adapter's output passes
 * canonicalDay.validateParsedExport(). Nothing else matters if that fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const C = require('../services/wearables/canonicalDay');
const S = require('../services/wearables/adapters/_shared');
const oura = require('../services/wearables/adapters/oura');
const fitbit = require('../services/wearables/adapters/fitbit');
const garmin = require('../services/wearables/adapters/garmin');
const polar = require('../services/wearables/adapters/polar');
const amazfit = require('../services/wearables/adapters/amazfit');
const genericCsv = require('../services/wearables/adapters/genericCsv');

const FIXTURES = path.join(__dirname, 'fixtures', 'devices');
const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function eq(actual, expected, msg) {
  const ok = Object.is(actual, expected);
  return assert(ok, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return assert(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
}

function section(name) { console.log(`=== ${name} ===`); }
function done(before) { console.log(failures.length === before ? '  OK' : '  FAIL'); }

function readFixture(vendor, name) {
  return fs.readFileSync(path.join(FIXTURES, vendor, name), 'utf8');
}

function loadDir(vendor, prefixFor) {
  return fs.readdirSync(path.join(FIXTURES, vendor)).map((n) => ({
    name: (prefixFor ? prefixFor(n) : '') + n,
    text: fs.readFileSync(path.join(FIXTURES, vendor, n), 'utf8')
  }));
}

function dayOf(days, date) { return days.find((d) => d.date === date) || null; }

/** Assert an adapter result is contract-clean. This is the suite's backbone. */
function assertContract(parsed, label) {
  const res = C.validateParsedExport(parsed);
  assert(res.ok, `${label}: validateParsedExport failed — ${res.errors.slice(0, 8).join(' | ')}`);
  return res;
}

/* ================================================================== *
 * 1. _shared primitives
 * ================================================================== */

section('_shared: tolerant dates and timestamps');
{
  const before = failures.length;
  eq(S.TZ, 'Asia/Kolkata', 'canonical timezone is inherited from whoopParser');
  eq(S.ymdOf('2025-04-01T06:10:00.000+05:30'), '2025-04-01', 'ISO with offset');
  eq(S.ymdOf('2025-04-01T06:10:00.000'), '2025-04-01', 'ISO without a zone keeps its printed date');
  eq(S.ymdOf('2025-03-31T20:00:00.000Z'), '2025-04-01', 'UTC 20:00 -> next IST day');
  eq(S.ymdOf('04/01/25 00:00:00'), '2025-04-01', 'Google Takeout MM/DD/YY');
  eq(S.ymdOf('20250401'), '2025-04-01', 'compact YYYYMMDD');
  eq(S.ymdOf(1743469200), '2025-04-01', 'epoch seconds');
  eq(S.ymdOf(1743469200000), '2025-04-01', 'epoch milliseconds');
  eq(S.ymdOf('2 Apr 2025'), '2025-04-02', 'day month-name year');
  eq(S.ymdOf('Apr 2, 2025'), '2025-04-02', 'month-name day, year');
  eq(S.ymdOf('not-a-date'), null, 'garbage -> null (never guessed)');
  eq(S.ymdOf('2025-13-45'), null, 'impossible calendar date -> null');
  eq(S.ymdOf('2025-02-30'), null, 'impossible day of month -> null');
  eq(S.ymdOf(''), null, 'empty -> null');
  eq(S.ymdOf(12345), null, 'a number too small to be an epoch is refused, not scaled');
  eq(S.minutesBetween(1743443400, 1743469200), 430, 'minutesBetween on epoch seconds');
  eq(S.minutesBetween('2025-04-01T00:00:00', '2025-04-01T06:00:00'), null,
    'minutesBetween refuses zone-less timestamps rather than assuming one');
  done(before);
}

section('_shared: durations — header first, value as the check');
{
  const before = failures.length;
  eq(S.parseDurationMinutes('7:10', null, {}).minutes, 430, 'HH:MM');
  eq(S.parseDurationMinutes('7:10:30', null, {}).minutes, 430.5, 'HH:MM:SS');
  eq(S.parseDurationMinutes('402', 'Minutes asleep', {}).minutes, 402, 'header declares minutes');
  eq(S.parseDurationMinutes('23400', 'Total sleep (seconds)', {}).minutes, 390, 'header declares seconds');
  eq(S.parseDurationMinutes('27150000', 'duration (ms)', {}).minutes, 452.5, 'header declares milliseconds');
  eq(S.parseDurationMinutes('6.5', 'Sleep hours', {}).minutes, 390, 'header declares hours');
  eq(S.parseDurationMinutes('402', 'Total sleep', {}).minutes, null,
    'no unit anywhere and no permission to guess -> null, never a magnitude guess');
  eq(S.parseDurationMinutes('402', 'Total sleep', { inferByMagnitude: true }).minutes, 402,
    'magnitude inference only when the caller opts in');
  eq(S.parseDurationMinutes('', 'Total sleep (min)', {}).minutes, null, 'blank -> null, not 0');
  eq(S.parseDurationMinutes('23400', 'Total sleep (min)', { maxMinutes: 1440 }).minutes, 390,
    'a header unit that yields an impossible duration is re-read, not clamped');
  eq(S.parseDurationMinutes('23400', 'Total sleep (min)', { maxMinutes: 1440 }).reinterpreted, true,
    'and the re-read is reported');

  // Column-level unit detection: one row cannot tell 450 minutes from 450 seconds.
  eq(S.detectSeriesDurationUnit([27000, 25800, 29400], 'Total Sleep Duration',
    { assume: 's', minMinutes: 60, maxMinutes: 1440 }).unit, 's', 'seconds column stays seconds');
  eq(S.detectSeriesDurationUnit([450, 430, 490], 'Total Sleep Duration',
    { assume: 's', minMinutes: 60, maxMinutes: 1440 }).unit, 'min',
    'a "seconds" assumption is discarded when the column cannot be seconds');
  eq(S.detectSeriesDurationUnit([7.5, 7.2, 8.1], 'Sleep',
    { assume: 's', minMinutes: 60, maxMinutes: 1440 }).unit, 'h', 'decimal-hours column detected');
  eq(S.detectSeriesDurationUnit([], 'Sleep', { assume: 's' }).sampleCount, 0, 'empty column is not fatal');

  deepEq(S.percentFromMaybeFraction('0.93'), { value: 93, scaled: true }, '0-1 fraction -> percent');
  deepEq(S.percentFromMaybeFraction('93'), { value: 93, scaled: false }, 'a percent stays a percent');
  deepEq(S.percentFromMaybeFraction(''), { value: null, scaled: false }, 'blank percent -> null');
  done(before);
}

section('_shared: a deviation converts by ratio, never by the 32-degree offset');
{
  const before = failures.length;
  deepEq(S.canonicalizeTempDeviation('-0.25', 'Temperature Deviation (°C)'),
    { skinTempDeviationC: -0.25, skinTempRaw: -0.25, skinTempUnit: 'C' }, 'celsius deviation');
  deepEq(S.canonicalizeTempDeviation('-0.45', 'Temperature Deviation (°F)'),
    { skinTempDeviationC: -0.25, skinTempRaw: -0.45, skinTempUnit: 'F' },
    'Fahrenheit deviation scales by 5/9 only — subtracting 32 would give -17.9');
  deepEq(S.canonicalizeTempDeviation('', 'Temperature Deviation (°C)'),
    { skinTempDeviationC: null, skinTempRaw: null, skinTempUnit: null }, 'blank -> null, not 0');
  done(before);
}

section('_shared: the sanity filter nulls and reports, it never clamps');
{
  const before = failures.length;
  const day = C.emptyCanonicalDay('2025-04-01', 'generic_csv');
  day.sleepMinutes = 4500;   // a seconds-as-minutes bug
  day.restingHr = 54;
  day.spo2 = 250;
  const implausible = [];
  S.applySanity(day, implausible, { file: 'x.csv', rowNumber: 4 });
  eq(day.sleepMinutes, null, 'an impossible sleep total is nulled');
  eq(day.spo2, null, 'an impossible SpO2 is nulled');
  eq(day.restingHr, 54, 'the plausible sibling on the same row is untouched');
  eq(implausible.length, 2, 'both are reported');
  const slept = implausible.find((i) => i.field === 'sleepMinutes');
  eq(slept.value, 4500, 'the ORIGINAL value is preserved in the report');
  eq(slept.max, 1440, 'the bound it broke is reported');
  eq(slept.file, 'x.csv', 'the file is reported');
  eq(slept.rowNumber, 4, 'the row is reported');

  const day2 = C.emptyCanonicalDay('2025-04-02', 'generic_csv');
  day2.sleepMinutes = 400;
  day2.remMin = 300; day2.deepMin = 200; day2.lightMin = 250; // 750 > 400
  const imp2 = [];
  S.reconcileSleep(day2, imp2, {});
  eq(day2.sleepMinutes, 400, 'the night total survives');
  eq(day2.remMin, null, 'stages that cannot fit inside the night are dropped');
  eq(imp2.length, 1, 'and reported once');
  eq(day2.sleepHours, 6.67, 'sleepHours is derived from sleepMinutes so they always agree');
  done(before);
}

/* ================================================================== *
 * 2. Oura
 * ================================================================== */

section('Oura: BOM + CRLF dashboard CSV');
const ouraParsed = oura.parse([{ name: 'oura_trends.csv', text: readFixture('oura', 'oura_trends.csv') }]);
{
  const before = failures.length;
  assertContract(ouraParsed, 'oura');
  deepEq(ouraParsed.days.map((d) => d.date),
    ['2025-04-01', '2025-04-02', '2025-04-04', '2025-04-05'], 'exact day list, sorted ascending');
  eq(ouraParsed.days.every((d) => d.source === 'oura'), true, 'every day tagged source=oura');
  eq(ouraParsed.summary.provider, 'oura', 'summary names the provider');
  deepEq(ouraParsed.summary.dateRange, { from: '2025-04-01', to: '2025-04-05' }, 'date range');

  const d1 = dayOf(ouraParsed.days, '2025-04-01');
  eq(d1.sleepMinutes, 390, 'seconds column read as 390 minutes');
  eq(d1.sleepHours, 6.5, 'hours derived from minutes');
  eq(d1.remMin, 90, 'REM');
  eq(d1.deepMin, 80, 'deep');
  eq(d1.lightMin, 220, 'light');
  eq(d1.awakeMin, 40, 'awake');
  eq(d1.hrvMs, 62, 'HRV');
  eq(d1.hrvMethod, 'rmssd_sleep', 'Oura HRV is tagged as overnight RMSSD');
  eq(d1.restingHr, 54, 'average resting HR (not the "lowest" column)');
  eq(d1.respiratoryRate, 14.2, 'respiratory rate');
  eq(d1.spo2, 96, 'SpO2');
  eq(d1.steps, 8500, 'steps');
  eq(d1.energyKcal, 2450, 'total burn -> energyKcal');
  eq(d1.readinessScore, 74, 'readiness maps to the canonical 0-100 readiness field');
  eq(d1.recoveryScore, null, 'readiness is NOT smuggled into recoveryScore');
  eq(d1.strain, null, 'Oura has no Whoop-scale strain');
  deepEq(d1.providerScores, {
    'oura.sleep_score': 82,
    'oura.readiness_score': 74,
    'oura.activity_score': 88,
    'oura.lowest_resting_hr': 51,
    'oura.restlessness': 12,
    'oura.activity_burn_kcal': 520,
    'oura.time_in_bed_min': 430,
    'oura.sleep_latency_min': 15
  }, 'device-native composites are namespaced, never canonical');

  // Midnight crossing: bedtime 2025-03-31 23:40 -> wake 2025-04-01 06:10.
  eq(dayOf(ouraParsed.days, '2025-03-31'), null, 'no day created for the sleep-ONSET date');
  done(before);
}

section('Oura: temperature is a DEVIATION and must never be an absolute');
{
  const before = failures.length;
  const d1 = dayOf(ouraParsed.days, '2025-04-01');
  eq(d1.skinTempDeviationC, -0.25, 'deviation stored as a deviation');
  eq(d1.skinTempC, null, 'skinTempC stays null — -0.25 there would read as hypothermia');
  eq(d1.tempBasis, 'deviation_c', 'basis tagged');
  eq(d1.skinTempRaw, -0.25, 'raw value kept so a unit misfire stays recoverable');
  eq(d1.skinTempUnit, 'C', 'unit detected from the header');
  eq(dayOf(ouraParsed.days, '2025-04-05').skinTempDeviationC, 0.42, 'a positive deviation too');
  eq(dayOf(ouraParsed.days, '2025-04-05').skinTempC, null, '...and still not an absolute');
  eq(ouraParsed.days.every((d) => d.skinTempC === null), true, 'NO Oura day has an absolute temperature');
  done(before);
}

section('Oura: naps, blanks, unknown columns, rejections, collisions');
{
  const before = failures.length;
  const d2 = dayOf(ouraParsed.days, '2025-04-02');
  eq(d2.napMinutes, 45, 'the nap row accumulates into napMinutes');
  eq(d2.sleepMinutes, 370, 'and does NOT inflate nightly sleep');
  eq(d2.hrvMs, null, 'blank HRV -> null, never 0');
  eq(d2.spo2, null, 'blank SpO2 -> null');
  eq(d2.skinTempDeviationC, null, 'blank temperature -> null');
  eq(d2.tempBasis, null, 'no temperature means no basis');
  eq(d2.restingHr, 56, 'a sibling value on the same row still parsed');
  eq(dayOf(ouraParsed.days, '2025-04-01').napMinutes, 0,
    'a day with no naps records 0 — an observed count, not a missing metric');

  eq(ouraParsed.summary.unknownColumns.length, 1, 'exactly one unknown column');
  eq(ouraParsed.summary.unknownColumns[0].column, 'Notes', 'the unknown column is named');
  eq(dayOf(ouraParsed.days, '2025-04-01') != null, true,
    'the row carrying the unknown column still parsed — unknowns are never fatal');

  eq(ouraParsed.rejected.length, 1, 'one rejected row');
  eq(ouraParsed.rejected[0].rowNumber, 5, 'rejection carries the physical line number');
  eq(/unparseable date/.test(ouraParsed.rejected[0].reason), true, 'rejection reason');
  eq(Array.isArray(ouraParsed.rejected[0].raw), true, 'rejection carries the raw row');
  eq(ouraParsed.days.some((d) => d.sleepMinutes === 20000 / 60), false,
    'the rejected row contributed nothing to any day');

  eq(ouraParsed.summary.duplicates.length, 1, 'one same-date collision reported');
  const dup = ouraParsed.summary.duplicates[0];
  eq(dup.date, '2025-04-04', 'collision date');
  eq(dup.keptSleepMinutes, 420, 'kept the longer sleep');
  eq(dup.droppedSleepMinutes, 300, 'dropped the shorter one');
  const d4 = dayOf(ouraParsed.days, '2025-04-04');
  eq(d4.sleepMinutes, 420, 'the day carries the winning night');
  eq(d4.remMin, 100, 'and the winning night\'s stages, not a blend of both');
  eq(d4.providerScores['oura.sleep_score'], 85, 'and the winning row\'s scores');
  done(before);
}

/* ================================================================== *
 * 3. Fitbit
 * ================================================================== */

section('Fitbit: Google Takeout routing (JSON + CSV)');
const fitbitFiles = loadDir('fitbit', () => 'Takeout/Fitbit/Global Export Data/');
const fitbitParsed = fitbit.parse(fitbitFiles);
{
  const before = failures.length;
  eq(fitbit.classifyFile('Takeout/Fitbit/Global Export Data/sleep-2025-04-01.json'), 'sleep_json', 'sleep JSON');
  eq(fitbit.classifyFile('resting_heart_rate-2025-04-01.json'), 'resting_hr_json', 'resting HR JSON');
  eq(fitbit.classifyFile('heart_rate-2025-04-01.json'), 'intraday', 'minute-level HR is intraday');
  eq(fitbit.classifyFile('Daily Heart Rate Variability Summary - 2025-04-01.csv'), 'hrv_daily_csv', 'daily HRV CSV');
  eq(fitbit.classifyFile('Heart Rate Variability Details - 2025-04-01.csv'), 'intraday', 'HRV details is intraday');
  eq(fitbit.classifyFile('Computed Temperature - 2025-04-01.csv'), 'temp_computed_csv', 'computed temperature');
  eq(fitbit.classifyFile('Daily Readiness Score - 2025-04-01.csv'), 'readiness_csv', 'daily readiness');
  eq(fitbit.classifyFile('readme.txt'), null, 'a non-data file routes nowhere');

  assertContract(fitbitParsed, 'fitbit');
  deepEq(fitbitParsed.days.map((d) => d.date),
    ['2025-04-01', '2025-04-02', '2025-04-03'], 'exact day list, sorted ascending');
  eq(fitbitParsed.days.every((d) => d.source === 'fitbit'), true, 'every day tagged source=fitbit');
  done(before);
}

section('Fitbit: a night is attributed to its END date; naps stay out of it');
{
  const before = failures.length;
  const d1 = dayOf(fitbitParsed.days, '2025-04-01');
  // startTime 2025-03-31T23:12:30, endTime 2025-04-01T06:45:00.
  eq(d1.sleepMinutes, 402, 'minutesAsleep');
  eq(d1.sleepHours, 6.7, 'hours derived from minutes');
  eq(d1.deepMin, 70, 'stages summary deep');
  eq(d1.lightMin, 242, 'stages summary light');
  eq(d1.remMin, 90, 'stages summary rem');
  eq(d1.awakeMin, 33, 'minutesAwake');
  eq(d1.sleepEfficiencyPct, 95, 'efficiency');
  eq(dayOf(fitbitParsed.days, '2025-03-31'), null, 'no day created for the sleep-onset date');
  eq(d1.napMinutes, 38, 'mainSleep:false accumulates into napMinutes');
  eq(d1.sleepMinutes, 402, 'and the nap does not inflate the night');
  done(before);
}

section('Fitbit: HRV, SpO2, RHR, AZM and summed minute series');
{
  const before = failures.length;
  const d1 = dayOf(fitbitParsed.days, '2025-04-01');
  eq(d1.hrvMs, 58.3, 'nightly RMSSD');
  eq(d1.hrvMethod, 'rmssd_sleep', 'tagged as overnight RMSSD');
  eq(d1.restingHr, 54.2, 'the dedicated resting-HR file outranks the sleep-score copy');
  eq(d1.spo2, 95.8, 'daily SpO2 average');
  eq(d1.steps, 200, 'minute-level steps summed into a daily total');
  eq(d1.energyKcal, 2.5, 'minute-level calories summed');
  eq(d1.activeMinutes, 30, 'Active Zone Minutes summed across zones');
  eq(d1.providerScores['fitbit.nrem_hr'], 52.1,
    'nremhr is NOT a resting heart rate and stays namespaced');
  eq(d1.providerScores['fitbit.sleep_score'], 81, 'Fitbit sleep score is namespaced');
  eq(d1.sleepPerformancePct, null, '...and never written to sleepPerformancePct');
  eq(d1.providerScores['fitbit.readiness_score'], 72, 'Daily Readiness is namespaced');
  eq(d1.readinessScore, null, 'Fitbit readiness mixes in activity load, so not the canonical field');
  eq(d1.strain, null, 'Fitbit has no strain');
  eq(d1.recoveryScore, null, 'Fitbit has no Whoop-style recovery');

  const d3 = dayOf(fitbitParsed.days, '2025-04-03');
  eq(d3.restingHr, 56.8, 'a later day from the resting-HR file alone');
  eq(d3.sleepMinutes, null, 'a day with no sleep log has NULL sleep, not 0');
  eq(fitbitParsed.rejected.some((r) => /no resting heart rate value/.test(r.reason)), true,
    'a 0 resting HR is "no reading" and is rejected, not stored as 0');
  done(before);
}

section('Fitbit: temperature variation, and a value too large to be one');
{
  const before = failures.length;
  const d1 = dayOf(fitbitParsed.days, '2025-04-01');
  eq(d1.skinTempDeviationC, -0.4, 'nightly temperature stored as a deviation');
  eq(d1.skinTempC, null, 'and never as an absolute');
  eq(d1.tempBasis, 'deviation_c', 'basis tagged');
  eq(dayOf(fitbitParsed.days, '2025-04-02').skinTempDeviationC, 0.8, 'positive deviation');
  const d3 = dayOf(fitbitParsed.days, '2025-04-03');
  eq(d3.skinTempDeviationC, null, '33.6 is refused as a deviation');
  eq(d3.skinTempC, null, '...and is NOT reclassified as an absolute either');
  eq(d3.tempBasis, null, 'no temperature, no basis');
  eq(fitbitParsed.summary.notes.some((n) => /Refused a Fitbit temperature of 33\.6/.test(n)), true,
    'the refusal is reported, not silent');
  eq(fitbitParsed.days.every((d) => d.skinTempC === null), true, 'NO Fitbit day has an absolute temperature');
  done(before);
}

section('Fitbit: unknown keys, rejections and the same-date collision');
{
  const before = failures.length;
  eq(fitbitParsed.summary.unknownColumns.length, 1, 'exactly one unknown JSON key');
  eq(fitbitParsed.summary.unknownColumns[0].column, 'experimentalMetric', 'the unknown key is named');
  eq(fitbitParsed.rejected.length, 2, 'two rejected rows');
  eq(fitbitParsed.rejected.some((r) => /unparseable sleep end time/.test(r.reason)), true,
    'a malformed sleep log is rejected, never guessed');

  eq(fitbitParsed.summary.duplicates.length, 1, 'one collision');
  const dup = fitbitParsed.summary.duplicates[0];
  eq(dup.date, '2025-04-02', 'collision date');
  eq(dup.keptSleepMinutes, 365, 'longer sleep kept');
  eq(dup.droppedSleepMinutes, 180, 'shorter dropped');
  const d2 = dayOf(fitbitParsed.days, '2025-04-02');
  eq(d2.sleepMinutes, 365, 'the day carries the winner');
  eq(d2.deepMin, 60, 'and the winner\'s stages, not the loser\'s 30');
  done(before);
}

/* ================================================================== *
 * 4. Garmin
 * ================================================================== */

section('Garmin: GDPR export routing and sleep from measured stages');
const garminFiles = [
  { name: 'DI_CONNECT/DI-Connect-Wellness/987654_sleepData.json', text: readFixture('garmin', 'sleepData.json') },
  { name: 'DI_CONNECT/DI-Connect-Wellness/987654_hrvData.json', text: readFixture('garmin', 'hrvData.json') },
  { name: 'DI_CONNECT/DI-Connect-Aggregator/UDSFile_2025-04-01_2025-04-05.json', text: readFixture('garmin', 'UDSFile_2025-04-01_2025-04-05.json') }
];
const garminParsed = garmin.parse(garminFiles);
{
  const before = failures.length;
  eq(garmin.classifyFile('DI_CONNECT/DI-Connect-Wellness/987654_sleepData.json'), 'sleep_json', 'sleep');
  eq(garmin.classifyFile('DI_CONNECT/DI-Connect-Wellness/987654_hrvData.json'), 'hrv_json', 'hrv');
  eq(garmin.classifyFile('UDSFile_2025-04-01_2025-04-05.json'), 'daily_json', 'daily aggregate');
  eq(garmin.classifyFile('notes.txt'), null, 'non-JSON routes nowhere');

  assertContract(garminParsed, 'garmin');
  deepEq(garminParsed.days.map((d) => d.date), ['2025-04-01', '2025-04-02'], 'exact day list');
  const d1 = dayOf(garminParsed.days, '2025-04-01');
  // deep 4200s + light 14520s + rem 5400s = 402 min; the 7h33m window would be 453.
  eq(d1.sleepMinutes, 402, 'sleep is the measured stages, not the bed window');
  eq(d1.deepMin, 70, 'deep');
  eq(d1.lightMin, 242, 'light');
  eq(d1.remMin, 90, 'rem');
  eq(d1.awakeMin, 33, 'awake');
  eq(d1.napMinutes, 30, 'napList accumulates into napMinutes');
  eq(d1.respiratoryRate, 14.3, 'respiration');
  eq(d1.restingHr, 52, 'resting HR');
  eq(d1.spo2, 95, 'overnight SpO2');
  eq(d1.hrvMs, 61, 'lastNightAvg HRV');
  eq(d1.hrvMethod, 'rmssd_sleep', 'tagged as overnight RMSSD');
  eq(d1.steps, 9120, 'steps');
  eq(d1.energyKcal, 2510, 'total kilocalories');
  eq(d1.maxHr, 161, 'max HR');
  eq(d1.activeMinutes, 35, 'moderate + vigorous intensity minutes');
  done(before);
}

section('Garmin: Body Battery and stress are proprietary, never canonical');
{
  const before = failures.length;
  const d1 = dayOf(garminParsed.days, '2025-04-01');
  eq(d1.providerScores['garmin.body_battery'], 86, 'Body Battery is namespaced');
  eq(d1.providerScores['garmin.stress_avg'], 28, 'stress is namespaced');
  eq(d1.providerScores['garmin.sleep_score'], 78, 'sleep score is namespaced');
  eq(d1.recoveryScore, null, 'Body Battery is NOT a recovery percentage');
  eq(d1.readinessScore, null, 'nor a readiness score');
  eq(d1.strain, null, 'Garmin has no Whoop-scale strain');
  eq(d1.sleepPerformancePct, null, 'Garmin sleep score is not sleep performance');
  eq(garminParsed.days.every((d) => d.strain === null), true, 'no Garmin day carries strain');

  eq(garminParsed.summary.unknownColumns.length, 1, 'one unknown JSON key');
  eq(garminParsed.summary.unknownColumns[0].column, 'experimentalField', 'the unknown key is named');
  eq(garminParsed.rejected.length, 1, 'one rejected record');
  eq(/unparseable calendarDate/.test(garminParsed.rejected[0].reason), true, 'rejection reason');
  eq(garminParsed.summary.duplicates.length, 1, 'one collision');
  eq(garminParsed.summary.duplicates[0].keptSleepMinutes, 355, 'the longer night wins');
  eq(dayOf(garminParsed.days, '2025-04-02').sleepMinutes, 355, 'and lands on the day');
  eq(dayOf(garminParsed.days, '2025-04-02').hrvMs, null, 'a null lastNightAvg stays null, never 0');
  done(before);
}

section('Garmin: the same export delivered as a ZIP buffer');
{
  const before = failures.length;
  if (typeof zlib.crc32 !== 'function') {
    console.log('  (skipped: this Node build has no zlib.crc32)');
  } else {
    const zipped = garmin.parse([{ name: 'garmin_export.zip', buffer: makeStoredZip(garminFiles) }]);
    assertContract(zipped, 'garmin (zip)');
    deepEq(zipped.days.map((d) => d.date), garminParsed.days.map((d) => d.date),
      'a ZIP upload produces exactly the same days as the extracted files');
    eq(dayOf(zipped.days, '2025-04-01').sleepMinutes, 402, 'and the same numbers');
  }
  done(before);
}

/* ================================================================== *
 * 5. Polar
 * ================================================================== */

section('Polar: Flow export');
const polarParsed = polar.parse(loadDir('polar', () => 'polar-export/'));
{
  const before = failures.length;
  eq(polar.classifyFile('nightly-recharge-2025-04-01.json'), 'recharge_json', 'nightly recharge');
  eq(polar.classifyFile('sleep-2025-04-01.json'), 'sleep_json', 'sleep');
  eq(polar.classifyFile('247ohr-2025-04-01.json'), 'intraday', 'continuous HR is intraday');

  assertContract(polarParsed, 'polar');
  deepEq(polarParsed.days.map((d) => d.date), ['2025-04-01', '2025-04-02'], 'exact day list');
  const d1 = dayOf(polarParsed.days, '2025-04-01');
  eq(d1.sleepMinutes, 390, 'sleep is the measured stages, not the interrupted window');
  eq(d1.deepMin, 75, 'deep');
  eq(d1.lightMin, 230, 'light');
  eq(d1.remMin, 85, 'rem');
  eq(d1.awakeMin, 25, 'interruptions -> awake');
  eq(d1.sleepNeedMin, 480, 'sleep goal -> sleep need');
  eq(d1.hrvMs, 64, 'nightly recharge HRV');
  eq(d1.hrvMethod, 'rmssd_sleep', 'method tag');
  eq(d1.restingHr, 52, 'overnight heart rate average');
  eq(d1.respiratoryRate, 14.1, 'breathing rate');
  eq(d1.steps, 8800, 'steps');
  eq(d1.energyKcal, 2480, 'calories');
  eq(d1.activeMinutes, 150, 'active time seconds -> minutes');
  eq(d1.strain, null, 'Polar has no Whoop-scale strain');
  eq(d1.recoveryScore, null, 'Nightly Recharge status is not a recovery percentage');
  eq(d1.readinessScore, null, 'nor a readiness score');
  eq(d1.providerScores['polar.nightly_recharge_status'], 4, 'recharge status is namespaced');
  eq(d1.providerScores['polar.ans_charge'], 0.8, 'ANS charge is namespaced');
  eq(d1.providerScores['polar.sleep_score'], 81, 'sleep score is namespaced');

  eq(dayOf(polarParsed.days, '2025-04-02').hrvMs, null, 'an explicit null HRV stays null, never 0');
  eq(polarParsed.summary.unknownColumns.length, 1, 'one unknown key');
  eq(polarParsed.summary.unknownColumns[0].column, 'experimental_metric', 'the unknown key is named');
  eq(polarParsed.rejected.length, 1, 'one rejected record');
  eq(polarParsed.summary.notes.some((n) => /247ohr/.test(n)), true, 'the intraday file is noted, not silently dropped');
  done(before);
}

/* ================================================================== *
 * 6. Amazfit / Zepp
 * ================================================================== */

section('Amazfit: Zepp CSVs');
const amazfitPrefix = (n) => (/^SLEEP/.test(n) ? 'SLEEP/' : /^ACTIVITY/.test(n) ? 'ACTIVITY/' : 'HEARTRATE_AUTO/');
const amazfitParsed = amazfit.parse(loadDir('amazfit', amazfitPrefix));
{
  const before = failures.length;
  assertContract(amazfitParsed, 'amazfit');
  deepEq(amazfitParsed.days.map((d) => d.date),
    ['2025-04-01', '2025-04-02', '2025-04-03'], 'exact day list');

  const d1 = dayOf(amazfitParsed.days, '2025-04-01');
  // start/stop bound a 430-minute night; deep 72 + shallow 258 + REM 88 = 418 fits,
  // deep + shallow alone (330) does not, so REM is a separate stage here.
  eq(d1.sleepMinutes, 418, 'REM proved separate by the bed window and is counted');
  eq(d1.remMin, 88, 'REM is canonical when it is proved separate');
  eq(d1.deepMin, 72, 'deep');
  eq(d1.lightMin, 258, 'shallow -> light');
  eq(d1.awakeMin, 26, 'wakeTime read as minutes when its magnitude allows');
  eq(d1.napMinutes, 0, 'naps=0 is an observed zero');
  eq(d1.steps, 9200, 'steps from the activity file');
  eq(d1.energyKcal, 2380, 'calories');
  eq(d1.strain, null, 'Amazfit has no strain');
  eq(d1.hrvMs, null, 'no HRV column in this export');

  const d2 = dayOf(amazfitParsed.days, '2025-04-02');
  eq(d2.sleepMinutes, 300, 'no REM column -> deep + shallow');
  eq(d2.remMin, null, 'REM stays null rather than being invented');
  eq(d2.awakeMin, null, 'a wakeTime that is really a timestamp is refused, not read as minutes');
  eq(amazfitParsed.summary.notes.some((n) => /holds timestamps, not minutes awake/.test(n)), true,
    'and the refusal is explained');

  const d3 = dayOf(amazfitParsed.days, '2025-04-03');
  eq(d3.steps, null, 'blank steps -> null, never 0');
  eq(d3.energyKcal, null, 'blank calories -> null');

  eq(amazfitParsed.summary.unknownColumns.length, 1, 'one unknown column');
  eq(amazfitParsed.summary.unknownColumns[0].column, 'deviceNote', 'the quoted-comma column is reported');
  eq(amazfitParsed.rejected.length, 1, 'one rejected row');
  eq(amazfitParsed.summary.duplicates.length, 1, 'one collision');
  eq(amazfitParsed.summary.duplicates[0].keptSleepMinutes, 300, 'the longer night wins');
  eq(amazfitParsed.summary.notes.some((n) => /Minute-level file skipped/.test(n)), true,
    'the minute-level heart-rate file is skipped with an explanation');

  // resolveSleepTotals in isolation — the decision that keeps REM honest.
  eq(amazfit.resolveSleepTotals(72, 258, 88, 430).sleepMinutes, 418, 'window says REM is separate');
  eq(amazfit.resolveSleepTotals(72, 258, 88, 335).sleepMinutes, 330, 'window says REM is inside shallow');
  eq(amazfit.resolveSleepTotals(72, 258, 88, null).remIsSeparate, false,
    'with no window to check, the conservative reading wins');
  eq(amazfit.resolveSleepTotals(null, null, null, 430).sleepMinutes, null, 'no stages -> null');
  done(before);
}

/* ================================================================== *
 * 7. Generic CSV
 * ================================================================== */

section('Generic CSV: BOM, preamble lines, HH:MM, fractions, quoted commas');
const genericParsed = genericCsv.parse([
  { name: 'coach_sheet.csv', text: readFixture('generic', 'coach_sheet.csv') }
]);
{
  const before = failures.length;
  assertContract(genericParsed, 'generic_csv');
  deepEq(genericParsed.days.map((d) => d.date),
    ['2025-05-01', '2025-05-02', '2025-05-04'], 'exact day list — header found below two preamble lines');

  const d1 = dayOf(genericParsed.days, '2025-05-01');
  eq(d1.sleepMinutes, 430, '"7:10" read as 430 minutes');
  eq(d1.sleepHours, 7.17, 'hours derived');
  eq(d1.remMin, 92, '"1:32" REM');
  eq(d1.deepMin, 72, '"1:12" deep');
  eq(d1.lightMin, 266, '"4:26" light');
  eq(d1.awakeMin, 35, '"0:35" awake');
  eq(d1.sleepEfficiencyPct, 93, '0.93 read as 93%');
  eq(d1.spo2, 97, '0.97 read as 97%');
  eq(genericParsed.summary.notes.some((n) => /held 0-1 fractions/.test(n)), true,
    'the fraction-to-percent read is reported');
  eq(d1.restingHr, 53, 'resting HR');
  eq(d1.readinessScore, 72, 'readiness');
  eq(d1.steps, 9100, 'steps');
  eq(d1.energyKcal, 2450, 'calories');
  done(before);
}

section('Generic CSV: HRV method is never guessed, strain is never canonical');
{
  const before = failures.length;
  const d1 = dayOf(genericParsed.days, '2025-05-01');
  eq(d1.hrvMs, 64, 'HRV value is kept');
  eq(d1.hrvMethod, 'unknown', 'but the method is NEVER guessed as rmssd_sleep');
  eq(genericCsv.readHrvMethod('rmssd_sleep'), 'rmssd_sleep', 'an explicit method column is trusted');
  eq(genericCsv.readHrvMethod('SDNN spot'), 'sdnn_spot', 'and normalised');
  eq(genericCsv.readHrvMethod('something else'), 'unknown', 'anything unrecognised -> unknown');
  eq(genericCsv.readHrvMethod(''), 'unknown', 'blank -> unknown');

  eq(d1.strain, null, 'a "strain" column is NOT written to the canonical strain field');
  eq(d1.providerScores['generic_csv.strain'], 13.4, 'it is kept, namespaced, where it cannot be cross-compared');
  done(before);
}

section('Generic CSV: a small temperature is a deviation whatever the header says');
{
  const before = failures.length;
  const d1 = dayOf(genericParsed.days, '2025-05-01');
  eq(d1.skinTempDeviationC, 0.35, '0.35 under a "Skin Temperature" header is a deviation');
  eq(d1.skinTempC, null, 'and never an absolute');
  eq(d1.tempBasis, 'deviation_c', 'basis tagged');
  eq(genericParsed.summary.notes.some((n) => /far too small to be a skin temperature/.test(n)), true,
    'the reinterpretation is explained');
  eq(dayOf(genericParsed.days, '2025-05-04').skinTempDeviationC, -0.2, 'a negative one too');

  // ...and a real absolute still lands in skinTempC.
  const abs = genericCsv.parse([{
    name: 'abs.csv',
    text: 'Date,Wake Time,Sleep,Skin Temperature\n2025-06-01,2025-06-01T06:00:00,7:00,33.6\n'
  }]);
  assertContract(abs, 'generic_csv (absolute temp)');
  eq(abs.days[0].skinTempC, 33.6, 'a plausible absolute is stored as an absolute');
  eq(abs.days[0].skinTempDeviationC, null, 'and not as a deviation');
  eq(abs.days[0].tempBasis, 'absolute_c', 'basis tagged absolute');
  done(before);
}

section('Generic CSV: naps, blanks, rejections and collisions');
{
  const before = failures.length;
  const d2 = dayOf(genericParsed.days, '2025-05-02');
  eq(d2.napMinutes, 45, 'the Is Nap=Yes row accumulates into napMinutes');
  eq(d2.sleepMinutes, 400, 'and never inflates the night');
  eq(d2.remMin, null, 'blank stage -> null, never 0');
  eq(d2.hrvMs, null, 'blank HRV -> null');
  eq(d2.hrvMethod, null, 'no HRV means no method tag');

  eq(genericParsed.summary.unknownColumns.length, 1, 'one unknown column');
  eq(genericParsed.summary.unknownColumns[0].column, 'Coach Note', 'the quoted-comma column is reported');
  eq(genericParsed.rejected.length, 1, 'one rejected row');
  eq(genericParsed.rejected[0].rowNumber, 7, 'rejection carries the physical line number');
  eq(genericParsed.summary.duplicates.length, 1, 'one collision');
  eq(genericParsed.summary.duplicates[0].keptSleepMinutes, 470, 'the longer night wins');
  const d4 = dayOf(genericParsed.days, '2025-05-04');
  eq(d4.sleepMinutes, 470, 'the day carries the winner');
  eq(d4.respiratoryRate, 13.8, 'and the winner\'s sleep block, not the loser\'s 15.0');
  eq(d4.restingHr, 52, 'and the winner\'s scalars');
  done(before);
}

/* ================================================================== *
 * 8. Cross-adapter invariants
 * ================================================================== */

const ALL = [
  ['oura', ouraParsed],
  ['fitbit', fitbitParsed],
  ['garmin', garminParsed],
  ['polar', polarParsed],
  ['amazfit', amazfitParsed],
  ['generic_csv', genericParsed]
];

section('Every adapter satisfies the canonical contract');
{
  const before = failures.length;
  ALL.forEach(([name, parsed]) => {
    const res = C.validateParsedExport(parsed);
    assert(res.ok, `${name}: validateParsedExport — ${res.errors.slice(0, 6).join(' | ')}`);
    eq(parsed.summary.provider, name, `${name}: summary.provider`);
    eq(C.PROVIDERS.indexOf(name) !== -1, true, `${name}: is a known provider id`);
    eq(Array.isArray(parsed.workouts), true, `${name}: workouts is an array`);
    eq(Array.isArray(parsed.journal), true, `${name}: journal is an array`);
    eq(Array.isArray(parsed.summary.implausible), true, `${name}: summary.implausible is an array`);
    eq(parsed.days.every((d) => d.source === name), true, `${name}: every day carries its source`);
    eq(parsed.days.every((d) => d.measurementSource === 'device_export'), true,
      `${name}: every day records how it reached us`);
  });
  done(before);
}

section('No structured-file adapter ever emits strain');
{
  const before = failures.length;
  // Strain is Whoop's 0-21 scale. None of these vendors publish an equivalent, so
  // approximating one from an activity score would be an invention.
  ALL.forEach(([name, parsed]) => {
    eq(parsed.days.every((d) => d.strain === null), true, `${name}: strain is null on every day`);
  });
  done(before);
}

section('A deviation NEVER lands in skinTempC, and a temperature always has a basis');
{
  const before = failures.length;
  ALL.forEach(([name, parsed]) => {
    parsed.days.forEach((d) => {
      if (d.skinTempDeviationC !== null) {
        assert(d.skinTempC === null, `${name} ${d.date}: a deviation must not also set skinTempC`);
        assert(d.tempBasis === 'deviation_c', `${name} ${d.date}: a deviation must be tagged deviation_c`);
      }
      if (d.skinTempC !== null) {
        assert(d.tempBasis === 'absolute_c', `${name} ${d.date}: an absolute must be tagged absolute_c`);
      }
      if (d.hrvMs !== null) {
        assert(C.HRV_METHODS.indexOf(d.hrvMethod) !== -1,
          `${name} ${d.date}: HRV without a method tag is unusable`);
      }
    });
  });
  // Oura and Fitbit are the two vendors that publish a deviation; neither may ever
  // put a number in skinTempC.
  eq(ouraParsed.days.filter((d) => d.skinTempDeviationC !== null).length, 3, 'Oura deviations present');
  eq(fitbitParsed.days.filter((d) => d.skinTempDeviationC !== null).length, 2, 'Fitbit deviations present');
  eq(ouraParsed.days.concat(fitbitParsed.days).every((d) => d.skinTempC === null), true,
    'and not one absolute temperature between them');
  done(before);
}

section('Provider scores are namespaced and numeric');
{
  const before = failures.length;
  ALL.forEach(([name, parsed]) => {
    parsed.days.forEach((d) => {
      Object.keys(d.providerScores).forEach((k) => {
        assert(/^[a-z0-9_]+\.[a-z0-9_]+$/.test(k), `${name} ${d.date}: score key "${k}" is not namespaced`);
        assert(typeof d.providerScores[k] === 'number' && Number.isFinite(d.providerScores[k]),
          `${name} ${d.date}: score "${k}" is not a finite number`);
      });
    });
  });
  done(before);
}

/* ================================================================== *
 * 9. Graceful degradation — never a throw, never a silent empty success
 * ================================================================== */

const ADAPTERS = [
  ['oura', oura], ['fitbit', fitbit], ['garmin', garmin],
  ['polar', polar], ['amazfit', amazfit], ['generic_csv', genericCsv]
];

section('Every adapter degrades gracefully instead of throwing');
{
  const before = failures.length;
  const junk = [
    ['no files', []],
    ['an unrecognised file', [{ name: 'holiday-photo.jpg', text: 'not data at all' }]],
    ['a truncated JSON file', [{ name: 'sleep-2025-04-01.json', text: '{"dateOfSleep": "2025-04' }]],
    ['an empty CSV', [{ name: 'export.csv', text: '' }]],
    ['a header with no rows', [{ name: 'export.csv', text: 'date,Total Sleep Duration,HRV\n' }]],
    ['a CSV of pure nonsense', [{ name: 'export.csv', text: 'a,b,c\n1,2,3\n4,5,6\n' }]],
    ['a null in the file list', [null, { name: 'x.csv', text: '' }]],
    ['a file with neither text nor bytes', [{ name: 'x.csv' }]],
    ['a buffer that claims to be a ZIP', [{ name: 'x.zip', buffer: Buffer.from('PK truncated') }]]
  ];

  ADAPTERS.forEach(([name, adapter]) => {
    junk.forEach(([label, files]) => {
      let parsed = null;
      let threw = null;
      try {
        parsed = adapter.parse(files);
      } catch (err) {
        threw = (err && err.message) || String(err);
      }
      if (!assert(threw === null, `${name} threw on ${label}: ${threw}`)) return;
      const res = C.validateParsedExport(parsed);
      assert(res.ok, `${name} on ${label}: contract broken — ${res.errors.slice(0, 4).join(' | ')}`);
      assert(parsed.days.length === 0, `${name} on ${label}: invented ${parsed.days.length} day(s)`);
      // An empty result must always carry a visible reason — a note, or a
      // rejection naming the row that could not be read. Never a silent success.
      assert(parsed.summary.notes.length > 0 || parsed.rejected.length > 0,
        `${name} on ${label}: returned an empty result with NO explanation`);
    });
  });
  done(before);
}

section('An adapter handed another vendor\'s file says so rather than mis-reading it');
{
  const before = failures.length;
  const garminSleep = [{ name: 'sleepData.json', text: readFixture('garmin', 'sleepData.json') }];
  const viaOura = oura.parse(garminSleep);
  eq(viaOura.days.length, 0, 'Oura reads nothing out of a Garmin JSON file');
  eq(viaOura.summary.notes.length > 0, true, '...and explains why');
  assertContract(viaOura, 'oura (wrong vendor)');

  const ouraCsv = [{ name: 'oura_trends.csv', text: readFixture('oura', 'oura_trends.csv') }];
  const viaAmazfit = amazfit.parse(ouraCsv);
  assertContract(viaAmazfit, 'amazfit (wrong vendor)');
  eq(viaAmazfit.days.length, 0, 'Amazfit reads nothing out of an Oura CSV');
  done(before);
}

section('Files carried as Buffers rather than text');
{
  const before = failures.length;
  const asBuffer = oura.parse([{
    name: 'oura_trends.csv',
    buffer: fs.readFileSync(path.join(FIXTURES, 'oura', 'oura_trends.csv'))
  }]);
  assertContract(asBuffer, 'oura (buffer input)');
  deepEq(asBuffer.days.map((d) => d.date), ouraParsed.days.map((d) => d.date),
    'a Buffer upload produces exactly the same days as a text upload');
  done(before);
}

/* ------------------------------------------------------------------ *
 * A minimal STORED-method ZIP writer, so the ZIP path can be tested
 * without adding a dependency. Mirrors the layout zipReader.js expects.
 * ------------------------------------------------------------------ */
function makeStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.text, 'utf8');
    const crc = zlib.crc32(data) >>> 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8); // STORED
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10); // STORED
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(local), centralBuf, eocd]);
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.log('\n--- FAILURES ---');
  failures.forEach((f) => console.log(' ', f));
  console.log(`\n${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`\n--- All ${checks} wearable adapter checks passed ---`);
