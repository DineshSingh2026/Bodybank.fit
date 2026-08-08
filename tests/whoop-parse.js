/**
 * Golden-file test for the Whoop export parser.
 * Run: node tests/whoop-parse.js      (no dependencies, no server, no DB)
 *
 * Fixtures in tests/fixtures/whoop/ deliberately contain the hard cases:
 *   - a UTF-8 BOM + CRLF line endings (physiological_cycles.csv)
 *   - a midnight-crossing sleep (23:40 -> 06:10) and a cross-timezone cycle
 *   - nap rows that must NOT inflate nightly sleep
 *   - a Fahrenheit reading inside a column labelled "(celsius)"
 *   - blank numerics that must stay null (never 0)
 *   - malformed dates that must be rejected, never guessed
 *   - quoted fields containing commas and escaped "" quotes
 *   - an unknown extra column that must be reported, not fatal
 *   - two cycles colliding on one calendar date
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('../services/wearables/whoopParser');

const FIXTURES = path.join(__dirname, 'fixtures', 'whoop');
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

function done(before) {
  console.log(failures.length === before ? '  OK' : '  FAIL');
}

function read(name) { return fs.readFileSync(path.join(FIXTURES, name), 'utf8'); }

function dayOf(days, date) { return days.find((d) => d.date === date) || null; }

/* ------------------------------------------------------------------ */

section('CSV: RFC4180 (quotes, embedded commas, "" escapes, CRLF/LF, BOM)');
{
  const before = failures.length;
  deepEq(W.parseCsv('a,b\r\nc,"d,e"\r\n'), [['a', 'b'], ['c', 'd,e']], 'CRLF + quoted comma');
  deepEq(W.parseCsv('a,b\nc,"say ""hi"", ok"'), [['a', 'b'], ['c', 'say "hi", ok']], 'LF + escaped quotes');
  deepEq(W.parseCsv('﻿h1,h2\nv1,v2'), [['h1', 'h2'], ['v1', 'v2']], 'UTF-8 BOM stripped');
  deepEq(W.parseCsv('a,"multi\nline",c'), [['a', 'multi\nline', 'c']], 'newline inside quotes');
  deepEq(W.parseCsv('a,,c'), [['a', '', 'c']], 'empty middle field');
  eq(W.normalizeHeaderKey('Deep (SWS) duration (min)'), 'deepduration', 'header normalisation strips units');
  eq(W.normalizeHeaderKey('  Recovery score %  '), 'recoveryscore', 'header normalisation strips % and space');
  done(before);
}

section('Timezone: ymdInTz + wake-date attribution');
{
  const before = failures.length;
  eq(W.WHOOP_TZ, 'Asia/Kolkata', 'canonical timezone');
  eq(W.ymdInTz('2025-03-14T23:40:12.000+05:30'), '2025-03-14', 'IST evening stays on its own day');
  eq(W.ymdInTz('2025-03-15T06:10:44.000+05:30'), '2025-03-15', 'IST morning wake');
  eq(W.ymdInTz('2025-03-09T20:00:00.000Z'), '2025-03-10', 'UTC 20:00 -> next IST day');
  eq(W.ymdInTz('2025-03-14T21:40:00.000-07:00'), '2025-03-15', 'UTC-07:00 wake -> next IST day');
  eq(W.ymdInTz('2025-03-18 06:20:00', 'Asia/Kolkata', 'UTC+05:30'), '2025-03-18', 'bare timestamp + declared tz');
  eq(W.ymdInTz('2025-03-18 06:20:00'), '2025-03-18', 'bare timestamp, no zone -> literal date');
  eq(W.ymdInTz('3/14/2025 11:40:12 PM', 'Asia/Kolkata', 'UTC+05:30'), '2025-03-14', 'US M/D/YYYY 12h form');
  eq(W.ymdInTz('not-a-date'), null, 'garbage -> null (never guessed)');
  eq(W.ymdInTz('2025-02-30T10:00:00.000+05:30'), null, 'impossible calendar date -> null');
  eq(W.ymdInTz('2025-13-45T99:99:99'), null, 'malformed date -> null');
  eq(W.ymdInTz(''), null, 'empty -> null');
  eq(W.parseOffsetMinutes('UTC+05:30'), 330, 'offset parse +05:30');
  eq(W.parseOffsetMinutes('UTC-07:00'), -420, 'offset parse -07:00');
  eq(W.parseOffsetMinutes('Z'), 0, 'offset parse Z');
  done(before);
}

section('Units: skin temp C/F and energy');
{
  const before = failures.length;
  deepEq(W.canonicalizeTemp('33.6', 'Skin temp (celsius)'),
    { skinTempC: 33.6, skinTempRaw: 33.6, skinTempUnit: 'C' }, 'celsius stays celsius');
  deepEq(W.canonicalizeTemp('95.4', 'Skin temp (celsius)'),
    { skinTempC: 35.22, skinTempRaw: 95.4, skinTempUnit: 'F' }, '95.4 in a "celsius" column is Fahrenheit');
  deepEq(W.canonicalizeTemp('93.9', 'Skin temp (fahrenheit)'),
    { skinTempC: 34.39, skinTempRaw: 93.9, skinTempUnit: 'F' }, 'declared Fahrenheit converts');
  deepEq(W.canonicalizeTemp('33.4', 'Skin temp (fahrenheit)'),
    { skinTempC: 33.4, skinTempRaw: 33.4, skinTempUnit: 'C' }, '33.4 in a "fahrenheit" column is really celsius');
  deepEq(W.canonicalizeTemp('', 'Skin temp (celsius)'),
    { skinTempC: null, skinTempRaw: null, skinTempUnit: null }, 'blank temp -> null, not 0');
  deepEq(W.canonicalizeEnergy('2450', 'Energy burned (cal)'),
    { energyKcal: 2450, energyRaw: 2450, energyUnit: 'cal' }, 'Whoop "(cal)" is kcal');
  deepEq(W.canonicalizeEnergy('2450000', 'Energy burned (cal)'),
    { energyKcal: 2450, energyRaw: 2450000, energyUnit: 'cal(small)' }, 'small-calorie magnitude detected');
  deepEq(W.canonicalizeEnergy('8500', 'Energy burned (kilojoule)'),
    { energyKcal: 2031.5, energyRaw: 8500, energyUnit: 'kJ' }, 'kilojoule -> kcal');
  eq(W.toNum(''), null, 'blank numeric -> null');
  eq(W.toNum('-'), null, 'dash -> null');
  eq(W.toNum('n/a'), null, 'n/a -> null');
  eq(W.toNum('0'), 0, 'explicit zero survives');
  done(before);
}

section('File routing tolerance');
{
  const before = failures.length;
  eq(W.classifyFile('my_whoop_data/2025-03-21_physiological_cycles.csv'), 'cycles', 'prefixed + foldered cycles');
  eq(W.classifyFile('MY_WHOOP_DATA/Sleeps.CSV'), 'sleeps', 'uppercase sleeps');
  eq(W.classifyFile('export\\workouts.csv'), 'workouts', 'backslash path');
  eq(W.classifyFile('journal_entries.csv'), 'journal', 'journal');
  eq(W.classifyFile('readme.txt'), null, 'non-csv is not routed');
  done(before);
}

/* ------------------------------------------------------------------ */

const parsed = W.parseWhoopExport({
  files: [
    { name: 'my_whoop_data/2025-03-21_physiological_cycles.csv', text: read('physiological_cycles.csv') },
    { name: 'MY_WHOOP_DATA/Sleeps.CSV', text: read('sleeps.csv') },
    { name: 'my_whoop_data/workouts.csv', text: read('workouts.csv') },
    { name: 'my_whoop_data/journal_entries.csv', text: read('journal_entries.csv') },
    { name: 'my_whoop_data/readme.txt', text: 'not a csv' }
  ]
});
const { days, workouts, journal, summary, rejected } = parsed;

section('Summary counts + date range');
{
  const before = failures.length;
  eq(summary.filesSeen.length, 5, 'filesSeen count');
  deepEq(summary.filesSeen.map((f) => f.kind), ['cycles', 'sleeps', 'workouts', 'journal', null], 'filesSeen kinds');
  eq(summary.rowsParsed, 35, 'rowsParsed');
  eq(summary.rowsRejected, 4, 'rowsRejected');
  deepEq(summary.dateRange, { from: '2025-03-10', to: '2025-03-20' }, 'dateRange');
  eq(summary.timezone, 'Asia/Kolkata', 'summary timezone');
  done(before);
}

section('Unknown columns are reported, never fatal');
{
  const before = failures.length;
  eq(summary.unknownColumns.length, 1, 'exactly one unknown column');
  deepEq(summary.unknownColumns[0], {
    file: 'my_whoop_data/2025-03-21_physiological_cycles.csv',
    kind: 'cycles',
    column: 'Experimental Metric'
  }, 'unknown column entry');
  // ...and the row carrying it still parsed fine.
  eq(dayOf(days, '2025-03-10') != null, true, 'row with unknown column still parsed');
  done(before);
}

section('days: one row per calendar date, sorted ascending');
{
  const before = failures.length;
  deepEq(days.map((d) => d.date), [
    '2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14',
    '2025-03-15', '2025-03-16', '2025-03-17', '2025-03-18', '2025-03-19', '2025-03-20'
  ], 'exact day list');
  eq(new Set(days.map((d) => d.date)).size, days.length, 'no duplicate dates');
  eq(days.every((d) => d.source === 'whoop'), true, 'every day tagged source=whoop');
  done(before);
}

section('Midnight-crossing sleep is attributed to the WAKE date');
{
  const before = failures.length;
  // Cycle starts 2025-03-09 22:10 IST, sleep 23:40 -> 06:10, wake 2025-03-10.
  deepEq(dayOf(days, '2025-03-10'), {
    date: '2025-03-10',
    source: 'whoop',
    recoveryScore: 62,
    hrvMs: 78.5,
    restingHr: 54,
    spo2: 96.1,
    skinTempC: 33.6,
    skinTempRaw: 33.6,
    skinTempUnit: 'C',
    strain: 12.4,
    energyKcal: 2450,
    maxHr: 168,
    avgHr: 78,
    sleepHours: 5.67,
    sleepMinutes: 340,
    sleepPerformancePct: 84,
    sleepNeedMin: 420,
    sleepDebtMin: 40,
    sleepEfficiencyPct: 87.2,
    sleepConsistencyPct: 71,
    remMin: 90,
    deepMin: 80,
    lightMin: 170,
    awakeMin: 50,
    napMinutes: 45,
    respiratoryRate: 15.2
  }, 'full golden day record for the wake date 2025-03-10');
  eq(dayOf(days, '2025-03-09'), null, 'no day created for the sleep-ONSET date 2025-03-09');
  // Cross-timezone: wake 2025-03-14 21:40 -07:00 == 2025-03-15 10:10 IST.
  eq(dayOf(days, '2025-03-15').sleepMinutes, 440, 'UTC-07:00 cycle lands on 2025-03-15 IST');
  eq(dayOf(days, '2025-03-14').sleepMinutes, 465, '2025-03-14 keeps its own cycle');
  // Bare local timestamps resolved via the Cycle timezone column.
  eq(dayOf(days, '2025-03-18').sleepMinutes, 345, 'bare timestamps + declared tz -> 2025-03-18');
  eq(dayOf(days, '2025-03-18').recoveryScore, 59, 'bare-timestamp row metrics');
  done(before);
}

section('Naps never inflate nightly sleep');
{
  const before = failures.length;
  eq(dayOf(days, '2025-03-10').napMinutes, 45, 'single nap accumulates');
  eq(dayOf(days, '2025-03-10').sleepMinutes, 340, 'nightly sleep unchanged by the nap');
  eq(dayOf(days, '2025-03-10').sleepHours, 5.67, 'sleepHours derived from nightly minutes only');
  eq(dayOf(days, '2025-03-12').napMinutes, 55, 'two naps on 2025-03-12 sum to 55');
  eq(dayOf(days, '2025-03-12').sleepMinutes, 355, 'nightly sleep on 2025-03-12 unchanged');
  eq(dayOf(days, '2025-03-16').napMinutes, 35, 'Nap="Yes" recognised');
  eq(dayOf(days, '2025-03-11').napMinutes, 0, 'no naps -> 0 (an observed count, not a metric)');
  // Nap-only day: nightly sleep must stay null, NOT the nap duration.
  const d20 = dayOf(days, '2025-03-20');
  eq(d20.napMinutes, 40, 'nap-only day records nap minutes');
  eq(d20.sleepMinutes, null, 'nap-only day has NULL nightly sleep');
  eq(d20.sleepHours, null, 'nap-only day has NULL sleep hours');
  eq(d20.recoveryScore, null, 'nap-only day has no recovery');
  // Nap="No" rows are nightly sleeps and fill gaps only.
  eq(dayOf(days, '2025-03-19').sleepMinutes, 405, 'sleeps.csv creates a day with no cycle');
  eq(dayOf(days, '2025-03-19').sleepHours, 6.75, 'sleeps-only day derives hours');
  eq(dayOf(days, '2025-03-19').strain, null, 'sleeps-only day has no cycle metrics');
  done(before);
}

section('Unit drift: Fahrenheit skin temp inside a "(celsius)" column');
{
  const before = failures.length;
  const d = dayOf(days, '2025-03-12');
  eq(d.skinTempRaw, 95.4, 'raw value preserved');
  eq(d.skinTempUnit, 'F', 'unit detected as Fahrenheit by sanity range');
  eq(d.skinTempC, 35.22, 'converted to canonical celsius');
  eq(dayOf(days, '2025-03-11').skinTempUnit, 'C', 'normal celsius row untouched');
  eq(dayOf(days, '2025-03-11').skinTempC, 33.4, 'celsius passthrough');
  done(before);
}

section('No invention: blanks stay null, never 0');
{
  const before = failures.length;
  const d = dayOf(days, '2025-03-13');
  eq(d.recoveryScore, null, 'blank recovery -> null');
  eq(d.hrvMs, null, 'blank HRV -> null');
  eq(d.spo2, null, 'blank SpO2 -> null');
  eq(d.restingHr, 56, 'sibling value on the same row still parsed');
  eq(d.sleepMinutes, 330, 'sleep on the blank-numerics row still parsed');
  const yoga = workouts.find((w) => w.activity === 'Yoga');
  eq(yoga.maxHr, null, 'blank workout max HR -> null');
  deepEq(yoga.zones, { z1: null, z2: null, z3: null, z4: null, z5: null }, 'blank zones -> null, not 0');
  done(before);
}

section('Rejections: malformed rows, never guessed');
{
  const before = failures.length;
  eq(rejected.length, 4, 'four rejected rows');
  const byFile = {};
  rejected.forEach((r) => { byFile[r.file.split('/').pop()] = r; });

  const cyc = byFile['2025-03-21_physiological_cycles.csv'];
  eq(cyc.rowNumber, 6, 'cycles rejection on physical line 6');
  eq(cyc.reason, 'unparseable wake/cycle-end timestamp', 'cycles rejection reason');
  eq(cyc.raw[0], '2025-13-45T99:99:99', 'cycles rejection carries the raw row');
  eq(Array.isArray(cyc.raw), true, 'raw is the original cell array');

  eq(byFile['Sleeps.CSV'].rowNumber, 11, 'sleeps rejection line');
  eq(byFile['Sleeps.CSV'].reason, 'missing wake onset (cannot attribute a calendar date)', 'sleeps rejection reason');
  eq(byFile['workouts.csv'].rowNumber, 8, 'workouts rejection line');
  eq(byFile['workouts.csv'].reason, 'missing workout start time', 'workouts rejection reason');
  eq(byFile['journal_entries.csv'].rowNumber, 10, 'journal rejection line');
  eq(byFile['journal_entries.csv'].reason, 'unparseable cycle start time', 'journal rejection reason');

  // The malformed cycle row's numbers must not have leaked into any day.
  eq(days.some((d) => d.recoveryScore === 60), false, 'rejected row contributed nothing to days');
  done(before);
}

section('Same-date collision: longer sleep wins and is reported');
{
  const before = failures.length;
  eq(summary.duplicates.length, 1, 'one collision reported');
  const dup = summary.duplicates[0];
  eq(dup.date, '2025-03-15', 'collision date');
  eq(dup.kind, 'cycles', 'collision kind');
  eq(dup.keptSleepMinutes, 440, 'kept the 440-minute sleep');
  eq(dup.droppedSleepMinutes, 200, 'dropped the 200-minute sleep');
  eq(dayOf(days, '2025-03-15').recoveryScore, 44, 'day carries the KEPT cycle metrics');
  eq(dayOf(days, '2025-03-15').sleepMinutes, 440, 'day carries the kept sleep');
  // cycles.csv is authoritative over sleeps.csv for a date both cover.
  eq(dayOf(days, '2025-03-14').sleepMinutes, 465, 'cycle (465) wins over sleeps.csv (470)');
  eq(dayOf(days, '2025-03-14').sleepEfficiencyPct, 98.9, 'cycle sleep block kept intact');
  done(before);
}

section('workouts');
{
  const before = failures.length;
  eq(workouts.length, 7, 'workout count');
  deepEq(workouts[0], {
    date: '2025-03-10',
    startedAt: '2025-03-10T02:00:00.000Z',
    endedAt: '2025-03-10T02:55:00.000Z',
    durationMin: 55,
    activity: 'Weightlifting, Upper Body',
    strain: 11.2,
    energyKcal: 420,
    maxHr: 158,
    avgHr: 121,
    zones: { z1: 12, z2: 18, z3: 15, z4: 8, z5: 2 }
  }, 'golden workout row (quoted field containing a comma)');
  eq(workouts[1].activity, 'Running ("tempo" run)', 'escaped "" quotes inside a quoted field');
  eq(workouts[5].activity, 'Weightlifting, Lower Body', 'second quoted-comma activity');
  deepEq(workouts.map((w) => w.date), [
    '2025-03-10', '2025-03-11', '2025-03-12', '2025-03-14',
    '2025-03-16', '2025-03-17', '2025-03-19'
  ], 'workouts sorted by start time');
  done(before);
}

section('journal');
{
  const before = failures.length;
  eq(journal.length, 9, 'journal count');
  // Journal rows carry the CYCLE start (2025-03-09 22:10) but belong to the
  // cycle's wake date, so they line up with `days`.
  deepEq(journal[0], {
    date: '2025-03-10',
    question: 'Have you consumed any alcohol?',
    answer: false,
    notes: null
  }, 'journal re-attributed to the cycle wake date; blank notes -> null');
  deepEq(journal[1], {
    date: '2025-03-10',
    question: 'Did you have any caffeine?',
    answer: true,
    notes: 'Two coffees, one before noon'
  }, 'quoted note containing a comma');
  eq(journal[7].notes, 'Melatonin 3mg, "just in case"', 'note with escaped "" quotes');
  eq(journal.find((j) => j.question === 'Did you travel by plane?').date, '2025-03-15',
    'journal on the UTC-07:00 cycle follows that cycle to 2025-03-15');
  eq(journal.find((j) => j.question === 'Did you meditate?').date, '2025-03-18',
    'journal with no matching cycle falls back to its own cycle-start date');
  eq(summary.notes.some((n) => /no matching cycle/.test(n)), true, 'unmatched journal row is noted');
  eq(summary.notes.some((n) => /readme\.txt/.test(n)), true, 'unrecognised file is noted');
  done(before);
}

section('parseWhoopCsv (single file) surface');
{
  const before = failures.length;
  const r = W.parseWhoopCsv(read('sleeps.csv'), 'sleeps', { file: 'sleeps.csv' });
  eq(r.kind, 'sleeps', 'kind echoed');
  eq(r.rowsParsed, 9, 'sleeps rows parsed');
  eq(r.rowsRejected, 1, 'sleeps rows rejected');
  deepEq(r.unknownColumns, [], 'sleeps has no unknown columns');
  eq(r.rows.filter((x) => x.isNap).length, 5, 'five nap rows detected (true/true/true/Yes/true)');
  eq(r.rows.filter((x) => !x.isNap).length, 4, 'four nightly rows (false/false/No/false)');
  eq(r.fields[r.headers.indexOf('Nap')], 'isNap', 'Nap header aliased to isNap');
  eq(r.fields[r.headers.indexOf('Deep (SWS) duration (min)')], 'deepMin', 'Deep (SWS) aliased to deepMin');

  // Column drift: same data, different header spellings + reordered columns.
  const drift = [
    'HRV (ms),Wake onset,RHR,Total sleep duration (min),Recovery,Sleep Score,Mystery Column',
    '71.3,2025-04-02T06:30:00.000+05:30,55,392,64,88,zzz'
  ].join('\n');
  const d = W.parseWhoopCsv(drift, 'cycles', { file: 'drift.csv' });
  eq(d.rowsParsed, 1, 'drifted header row parsed');
  eq(d.rows[0].date, '2025-04-02', 'drifted wake onset attributed');
  eq(d.rows[0].hrvMs, 71.3, '"HRV (ms)" aliased');
  eq(d.rows[0].restingHr, 55, '"RHR" aliased');
  eq(d.rows[0].sleepMinutes, 392, '"Total sleep duration (min)" aliased');
  eq(d.rows[0].recoveryScore, 64, '"Recovery" aliased');
  eq(d.rows[0].sleepPerformancePct, 88, '"Sleep Score" aliased');
  deepEq(d.unknownColumns, ['Mystery Column'], 'unknown column reported, not fatal');

  // Empty / header-only input must not throw.
  const empty = W.parseWhoopCsv('', 'cycles', { file: 'empty.csv' });
  eq(empty.rowsParsed, 0, 'empty file parses to zero rows');
  eq(empty.rowsRejected, 0, 'empty file rejects nothing');
  const none = W.parseWhoopExport({ files: [] });
  deepEq(none.days, [], 'empty export -> no days');
  deepEq(none.summary.dateRange, { from: null, to: null }, 'empty export -> null date range');
  done(before);
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.log('\n--- FAILURES ---');
  failures.forEach((f) => console.log(' ', f));
  console.log(`\n${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`\n--- All ${checks} Whoop parser checks passed ---`);
