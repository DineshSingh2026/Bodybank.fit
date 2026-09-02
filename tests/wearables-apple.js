/**
 * Golden-file test for the Apple Health / Health Connect / Samsung Health adapters.
 * Run: node tests/wearables-apple.js      (no dependencies, no server, no DB)
 *
 * The Apple fixture in tests/fixtures/devices/apple/export.xml deliberately
 * contains every case that breaks a naive implementation:
 *   - a DOCTYPE with an internal subset and an XML comment before any data
 *   - a sleep that crosses midnight and must be attributed to its WAKE date
 *   - a 45-minute afternoon nap that must NOT inflate the night
 *   - iOS 16+ staged sleep AND a pre-iOS-16 unstaged "Asleep" night
 *   - an HRV SDNN spot check that must be tagged sdnn_spot, never converted
 *   - the same record written by the Watch, the iPhone and a third-party app,
 *     which must de-duplicate or the step count doubles
 *   - an attribute value containing a literal '>' character
 *   - records with nested MetadataEntry / HeartRateVariabilityMetadataList children
 *   - malformed records that must be rejected with a reason, never guessed
 *
 * The single most important test in this file is the chunk-boundary one: it feeds
 * the same document through the scanner 7 bytes at a time, 1 byte at a time and
 * at random sizes, and asserts byte-identical output to a single-chunk parse.
 * That is what proves the streaming scanner is correct, and streaming is the only
 * way an Apple export (200MB-1.5GB) can ever be read at all.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const A = require('../services/wearables/adapters/appleHealth');
const HC = require('../services/wearables/adapters/healthConnect');
const SM = require('../services/wearables/adapters/samsungHealth');
const C = require('../services/wearables/canonicalDay');

const FIXTURES = path.join(__dirname, 'fixtures', 'devices');
const APPLE = path.join(FIXTURES, 'apple');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function eq(actual, expected, msg) {
  return assert(Object.is(actual, expected),
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return assert(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
}

function section(name) { console.log(`=== ${name} ===`); }
function done(before) { console.log(failures.length === before ? '  OK' : '  FAIL'); }

function read(p) { return fs.readFileSync(p, 'utf8'); }
function dayOf(days, date) { return days.find((d) => d.date === date) || null; }

function contractOk(parsed, label) {
  const r = C.validateParsedExport(parsed);
  return assert(r.ok, `${label} must satisfy canonicalDay.validateParsedExport — errors: ${r.errors.join(' | ')}`);
}

const APPLE_XML = read(path.join(APPLE, 'export.xml'));

/* ================================================================== *
 * 1. The XML scanner primitives
 * ================================================================== */

section('Scanner: quote-aware tag boundaries, attributes and entities');
{
  const before = failures.length;

  // A naive indexOf('>') stops at the '>' INSIDE the attribute value and loses
  // the record. Apple's own device="..." blob is full of them.
  const withGt = '<Record type="X" sourceName="Health Sync > BodyBank" value="7"/>';
  eq(A.findTagEnd(withGt, 0), withGt.length - 1, "'>' inside an attribute value does not end the tag");
  const sq = "<Record note='a > b' v='1'/>";
  eq(A.findTagEnd(sq, 0), sq.length - 1, "'>' inside a single-quoted value does not end the tag");
  eq(A.findTagEnd('<Record type="X"', 0), -1, 'a truncated tag reports -1 (wait for more input)');

  deepEq(A.parseAttrs(withGt), { type: 'X', sourceName: 'Health Sync > BodyBank', value: '7' },
    'attributes parse with a literal > in the value');
  deepEq(A.parseAttrs('<R a="1&amp;2" b="&lt;x&gt;" c="it&apos;s" d="&quot;q&quot;" e="&#65;"/>'),
    { a: '1&2', b: '<x>', c: "it's", d: '"q"', e: 'A' },
    'XML entities decode, including numeric references');

  eq(A.decodeEntities('no entities here'), 'no entities here', 'entity-free strings pass through untouched');
  eq(A.decodeEntities('&unknownentity;'), '&unknownentity;', 'an unknown entity is left alone, never guessed');

  // Apple's device blob: escaped angle brackets, a name, and a hardware id that
  // legitimately contains a comma ("Watch6,2").
  eq(A.deviceLabel('<<HKDevice: 0x1>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:10.1>', 'x'),
    'Apple Watch (Watch6,2)', 'device blob yields a human label with the full hardware id');
  eq(A.deviceLabel('', 'Dinesh&apos;s iPhone'), 'Dinesh&apos;s iPhone',
    'with no device blob the sourceName is used verbatim');

  eq(A.sourcePriority("Dinesh's Apple Watch", ''), 3, 'Apple Watch outranks everything');
  eq(A.sourcePriority("Dinesh's iPhone", ''), 2, 'iPhone outranks a third-party app');
  eq(A.sourcePriority('Strava', ''), 1, 'a third-party app is lowest priority');

  eq(A.shortType('HKQuantityTypeIdentifierStepCount'), 'StepCount', 'quantity prefix stripped');
  eq(A.shortType('HKCategoryTypeIdentifierSleepAnalysis'), 'SleepAnalysis', 'category prefix stripped');
  eq(A.shortType('SomethingElse'), 'SomethingElse', 'an unprefixed type is left alone');

  // Comments and CDATA must be skipped whole: a <Record> inside a comment is not
  // data, and treating it as data would invent readings out of documentation.
  const seen = [];
  const sc = A.createScanner(new Set(['Record']), (n, a) => seen.push(a.type));
  sc.write('<!-- <Record type="GHOST"/> --><Record type="REAL"/>');
  sc.write('<![CDATA[ <Record type="ALSO_GHOST"/> ]]><Record type="REAL2"/>');
  sc.end();
  deepEq(seen, ['REAL', 'REAL2'], 'records inside comments and CDATA are not read as data');

  eq(A.unionMinutes([{ startMs: 0, endMs: 3600000 }, { startMs: 1800000, endMs: 5400000 }]), 90,
    'overlapping intervals are unioned, not summed (60 + 60 overlapping = 90, not 120)');
  eq(A.unionMinutes([]), 0, 'no intervals is zero minutes');

  done(before);
}

/* ================================================================== *
 * 2. THE test: chunk-boundary equivalence
 * ================================================================== */

section('Streaming: identical output at any chunk size (the scanner correctness proof)');
{
  const before = failures.length;

  function slices(text, size) {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  const whole = A.parseChunks([APPLE_XML]);
  const wholeJson = JSON.stringify(whole);

  [7, 1, 2, 3, 13, 64, 997, 100000].forEach((size) => {
    const chunked = A.parseChunks(slices(APPLE_XML, size));
    eq(JSON.stringify(chunked), wholeJson,
      `feeding the document ${size} character(s) at a time gives byte-identical output`);
  });

  // Deliberately awkward, non-uniform slicing — the shape a real socket delivers.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const ragged = [];
  for (let i = 0; i < APPLE_XML.length;) {
    const n = 1 + (rnd() % 40);
    ragged.push(APPLE_XML.slice(i, i + n));
    i += n;
  }
  eq(JSON.stringify(A.parseChunks(ragged)), wholeJson,
    'ragged 1-40 character chunks give byte-identical output');

  // A chunk boundary landing INSIDE an attribute value that contains '>'.
  const gtIdx = APPLE_XML.indexOf('Health Sync > BodyBank');
  assert(gtIdx > 0, "fixture contains the '>'-bearing attribute value");
  const split = [APPLE_XML.slice(0, gtIdx + 13), APPLE_XML.slice(gtIdx + 13)];
  eq(JSON.stringify(A.parseChunks(split)), wholeJson,
    "a chunk boundary inside a '>'-bearing attribute value changes nothing");

  eq(whole.days.length, 2, 'the fixture yields two canonical days');
  contractOk(whole, 'streamed Apple parse');
  done(before);
}

section('Streaming: parseStream() over a real Readable');
{
  const before = failures.length;
  // Async, so results are checked in the tail of this file; here we only prove
  // the promise resolves to the same object shape.
  module.exports._streamPromise = (async () => {
    const rs = Readable.from([APPLE_XML]);
    const streamed = await A.parseStream(rs, {});
    const sync = A.parseChunks([APPLE_XML]);
    eq(JSON.stringify(streamed.days), JSON.stringify(sync.days),
      'parseStream(Readable) matches parseChunks day-for-day');
    contractOk(streamed, 'parseStream result');

    // Byte-level chunking through the stream, which is where a multi-byte UTF-8
    // character would be split if setEncoding were not applied.
    const bytes = Buffer.from(APPLE_XML, 'utf8');
    const pieces = [];
    for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.slice(i, i + 7));
    const byteStreamed = await A.parseStream(Readable.from(pieces), {});
    eq(JSON.stringify(byteStreamed.days), JSON.stringify(sync.days),
      'a Buffer stream chopped into 7-byte pieces matches the single-chunk parse');

    const nothing = await A.parseStream(null);
    eq(nothing.days.length, 0, 'parseStream(null) resolves to an empty contract-valid result');
    contractOk(nothing, 'parseStream(null) result');
  })();
  done(before);
}

/* ================================================================== *
 * 3. HRV — the single most important correctness requirement
 * ================================================================== */

section('Apple HRV is SDNN from a spot check and must NEVER be sold as RMSSD');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });

  const withHrv = out.days.filter((d) => d.hrvMs !== null);
  assert(withHrv.length > 0, 'the fixture produces at least one day carrying HRV');
  withHrv.forEach((d) => {
    eq(d.hrvMethod, 'sdnn_spot', `${d.date}: hrvMethod must be exactly 'sdnn_spot'`);
  });
  eq(C.HRV_METHOD.SDNN_SPOT, 'sdnn_spot', "canonicalDay's SDNN_SPOT constant is the string we assert");

  // The failure that would matter: an Apple day quietly labelled with the
  // overnight-RMSSD tag would be charted against Whoop/Oura numbers.
  out.days.forEach((d) => {
    assert(d.hrvMethod !== 'rmssd_sleep' && d.hrvMethod !== 'rmssd_spot' && d.hrvMethod !== 'sdnn_sleep',
      `${d.date}: an Apple day must never carry an RMSSD or sleep-SDNN method tag`);
  });

  // No conversion factor was applied: the value is the median of the raw
  // in-sleep SDNN samples (52.4, 58.6), untouched.
  const d1 = dayOf(out.days, '2026-08-01');
  eq(d1.hrvMs, 55.5, 'hrvMs is the raw median of the in-sleep SDNN samples (52.4, 58.6) — no conversion');
  eq(d1.providerScores['apple.hrv_window'], 'sleep_window_median',
    'the night reading is preferred over the 15:00 daytime spot check');
  eq(d1.providerScores['apple.hrv_sdnn_sample_count'], 3, 'all three SDNN samples are counted and disclosed');

  // Guard against a future "helpful" conversion: 55.5 SDNN would land near
  // 25-35 if anyone ever divided it toward RMSSD.
  assert(d1.hrvMs > 45, 'the SDNN value is not scaled down toward an RMSSD-looking number');

  done(before);
}

/* ================================================================== *
 * 4. Sleep: wake-date attribution, naps, stages
 * ================================================================== */

section('Sleep: rule 2 (wake date) and rule 3 (naps never inflate the night)');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });
  const d1 = dayOf(out.days, '2026-08-01');
  const d2 = dayOf(out.days, '2026-08-02');

  // The night ran 2026-07-31 23:40 -> 2026-08-01 06:10 IST. Rule 2 puts it on
  // the wake date, so there is no 2026-07-31 row at all.
  assert(dayOf(out.days, '2026-07-31') === null,
    'a midnight-crossing night creates no row on its onset date');
  eq(d1.sleepMinutes, 375, 'the night is 375 asleep minutes, attributed to the wake date');
  eq(d1.sleepHours, 6.25, 'sleepHours agrees with sleepMinutes');
  eq(d1.awakeMin, 15, 'the mid-night Awake block is counted as awake, not as sleep');

  // Rule 3. The 14:00-14:45 nap is 45 minutes; if it leaked into the night the
  // total would be 420.
  eq(d1.napMinutes, 45, 'the afternoon nap lands in napMinutes');
  assert(d1.sleepMinutes === 375, 'the nap adds ZERO minutes to nightly sleep');

  // iOS 16+ stages.
  eq(d1.lightMin, 165, 'AsleepCore maps to lightMin (70 + 95)');
  eq(d1.deepMin, 80, 'AsleepDeep maps to deepMin (50 + 30)');
  eq(d1.remMin, 130, 'AsleepREM maps to remMin (50 + 80)');
  eq(d1.lightMin + d1.deepMin + d1.remMin, d1.sleepMinutes, 'the stages account for the whole night');

  // A third-party app re-wrote the same REM block. If it were not de-duplicated
  // the REM total would be 210 and the day would fail the contract validator.
  assert(d1.remMin === 130, 'a duplicate REM block from a second source does not double the stage');

  // Pre-iOS-16 fallback: a flat "Asleep" block with no stages at all.
  eq(d2.sleepMinutes, 400, 'a pre-iOS-16 flat Asleep block yields the right duration');
  eq(d2.remMin, null, 'with no stage data remMin stays null, never apportioned by a formula');
  eq(d2.deepMin, null, 'with no stage data deepMin stays null');
  eq(d2.lightMin, null, 'with no stage data lightMin stays null');
  eq(d2.sleepEfficiencyPct, 96.4, 'efficiency is asleep/in-bed arithmetic (400/415), not an invented score');
  eq(d1.sleepEfficiencyPct, null, 'with no InBed record efficiency stays null rather than being guessed');

  done(before);
}

/* ================================================================== *
 * 5. De-duplication: the step/energy double-count bug
 * ================================================================== */

section('De-duplication by (type, startDate, endDate, value) with Apple Watch preferred');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });
  const d1 = dayOf(out.days, '2026-08-01');

  // Watch 1200 + iPhone 1200 (identical) + iPhone 700 (inside the Watch window)
  // + Watch 800. Naive summing gives 3900.
  eq(d1.steps, 2000, 'identical multi-source step records de-duplicate (2000, not 3900)');
  assert(d1.steps !== 3900, 'the double-count bug is not present');

  const exact = out.summary.duplicates.find((x) => x.kind === 'exact-key');
  const covered = out.summary.duplicates.find((x) => x.kind === 'covered-interval');
  eq(exact.dropped, 2, 'two exact-key duplicates were dropped (the iPhone steps and the AutoSleep REM block)');
  eq(covered.dropped, 1, 'one lower-priority sample fully covered by the Watch was dropped');
  assert(out.summary.notes.some((n) => /duplicate record/.test(n)),
    'de-duplication is disclosed in summary.notes, not done silently');

  // The Apple Watch is credited with the day even though a third-party app also
  // wrote to it.
  assert(/Apple Watch/.test(d1.deviceModel),
    `the day is credited to the Apple Watch (got ${JSON.stringify(d1.deviceModel)})`);

  // The '>'-bearing record survived the scanner and its value was used.
  eq(d1.restingHr, 54, "the record whose sourceName contains '>' was parsed, not lost");

  done(before);
}

/* ================================================================== *
 * 6. Quantity aggregation and units
 * ================================================================== */

section('Quantity aggregation: HR, energy, SpO2, temperature, exercise time');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });
  const d1 = dayOf(out.days, '2026-08-01');

  eq(d1.avgHr, 93.7, 'avgHr is the mean of the heart-rate samples (62, 78, 141)');
  eq(d1.maxHr, 141, 'maxHr is the largest heart-rate sample');
  eq(d1.energyKcal, 1710.5, 'energyKcal is active (120 + 90.5) plus basal (1500)');
  eq(d1.providerScores['apple.active_energy_kcal'], 210.5,
    'the active/basal split is preserved in providerScores, never mixed into a canonical field');
  eq(d1.spo2, 97, 'SpO2 arrives as the fraction 0.97 with unit "%" and is normalised to 97');
  eq(d1.respiratoryRate, 14.5, 'respiratory rate is read as-is');
  eq(d1.activeMinutes, 35, 'AppleExerciseTime sums to activeMinutes (20 + 15)');

  // Temperature: the DECIDED behaviour. The XML carries an absolute degC sample,
  // so it is stored as an absolute and tagged as one. We never derive a
  // deviation here — baselineService owns that.
  eq(d1.skinTempC, 33.42, 'an absolute degC wrist temperature is stored in skinTempC');
  eq(d1.tempBasis, 'absolute_c', 'and tagged absolute_c, describing what was actually written');
  eq(d1.skinTempDeviationC, null, 'the deviation field stays null — never both');
  eq(d1.skinTempRaw, 33.42, 'the pre-conversion value is retained');
  eq(d1.skinTempUnit, 'C', 'the detected unit is retained');

  done(before);
}

section('Temperature: a small magnitude can only be a deviation, and is tagged as one');
{
  const before = failures.length;
  // Defensive path. If any writer ever puts a delta in this field, it must land
  // in skinTempDeviationC with deviation_c — never in skinTempC, where -0.35
  // would read as hypothermia and be nulled as implausible.
  const xml = '<HealthData locale="en_IN">'
    + '<Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" sourceName="Apple Watch" unit="degC" startDate="2026-09-01 03:10:00 +0530" endDate="2026-09-01 03:11:00 +0530" value="-0.35"/>'
    + '</HealthData>';
  const out = A.parse(xml);
  const d = out.days[0];
  eq(d.skinTempDeviationC, -0.35, 'a small magnitude is stored as a deviation');
  eq(d.tempBasis, 'deviation_c', 'and tagged deviation_c');
  eq(d.skinTempC, null, 'the absolute field stays null — the two are never mixed');
  assert(out.summary.notes.some((n) => /baseline deviation/.test(n)),
    'the basis decision is disclosed in summary.notes');
  contractOk(out, 'deviation-temperature parse');

  // Fahrenheit tolerance: a 92F wrist reading is still an absolute.
  const f = A.parse('<HealthData><Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" sourceName="Apple Watch" unit="degF" startDate="2026-09-01 03:10:00 +0530" endDate="2026-09-01 03:11:00 +0530" value="92.4"/></HealthData>');
  eq(f.days[0].tempBasis, 'absolute_c', 'a Fahrenheit reading converts and stays an absolute');
  eq(f.days[0].skinTempC, 33.56, 'and converts to Celsius correctly');
  done(before);
}

/* ================================================================== *
 * 7. What Apple does not have — rule 5
 * ================================================================== */

section('Apple has no recovery score and no strain: they stay null, never synthesised');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });
  out.days.forEach((d) => {
    eq(d.recoveryScore, null, `${d.date}: recoveryScore stays null (Apple ships no such metric)`);
    eq(d.readinessScore, null, `${d.date}: readinessScore stays null`);
    eq(d.strain, null, `${d.date}: strain stays null (Whoop's scale is not Apple's)`);
    eq(d.source, 'apple_health', `${d.date}: source is the canonical provider id`);
    eq(d.measurementSource, 'device_export', `${d.date}: measurementSource records how the data reached us`);
  });
  out.workouts.forEach((w) => eq(w.strain, null, 'a workout carries no invented strain either'));
  done(before);
}

/* ================================================================== *
 * 8. Malformed input: rejected with a reason, never guessed
 * ================================================================== */

section('Malformed records are rejected, never guessed');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });

  eq(out.summary.rowsRejected, 3, 'three malformed records were rejected');
  eq(out.rejected.length, 3, 'each rejection is reported with its raw attributes');
  assert(out.rejected.some((r) => /unparseable startDate/.test(r.reason)),
    'an impossible timestamp (2026-13-45 99:99:99) is rejected, not coerced');
  assert(out.rejected.some((r) => /non-numeric value/.test(r.reason)),
    'a non-numeric step value is rejected, not read as 0');
  assert(out.rejected.some((r) => /unrecognised SleepAnalysis value/.test(r.reason)),
    'an unknown sleep stage is rejected, not folded into "asleep"');

  // The rejected step row must not have contributed anything.
  eq(dayOf(out.days, '2026-08-01').steps, 2000, 'a rejected step row adds nothing to the total');

  // Unknown record types are surfaced, not fatal and not guessed into a field.
  const dw = out.summary.unknownColumns.find((u) => u.column === 'DietaryWater');
  assert(dw, 'an unmapped record type is surfaced in summary.unknownColumns');
  eq(dw.count, 1, 'and counted');

  // A record type we do not map must never appear as a canonical value.
  contractOk(out, 'Apple parse with malformed records');
  done(before);
}

/* ================================================================== *
 * 9. Contract compliance and ordering
 * ================================================================== */

section('Contract: validateParsedExport, sorting, ranges, provenance');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });
  contractOk(out, 'Apple export');
  eq(out.summary.contractViolations, undefined, 'no contract violations were self-reported');

  deepEq(out.days.map((d) => d.date), ['2026-08-01', '2026-08-02'], 'days are sorted ascending');
  deepEq(out.summary.dateRange, { from: '2026-08-01', to: '2026-08-02' }, 'date range spans the export');
  eq(out.summary.provider, 'apple_health', 'summary names the provider');
  eq(out.summary.timezone, 'Asia/Kolkata', 'attribution uses the codebase-wide timezone by default');
  assert(Array.isArray(out.journal), 'journal is an array (Apple has no behaviour log)');
  eq(out.journal.length, 0, 'and it is empty');

  // Every metric field must be a finite number or null — never undefined, never 0
  // standing in for "missing".
  out.days.forEach((d) => {
    C.METRIC_FIELDS.forEach((f) => {
      assert(d[f] === null || (typeof d[f] === 'number' && Number.isFinite(d[f])),
        `${d.date}.${f} is a finite number or null, got ${JSON.stringify(d[f])}`);
    });
  });

  // A different member timezone must change attribution, not silently be ignored.
  const utc = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] }, { timezone: 'UTC' });
  eq(utc.summary.timezone, 'UTC', 'an explicit timezone is honoured');
  assert(utc.days.length >= 2, 'and still produces days');
  contractOk(utc, 'UTC-attributed Apple export');

  // A value outside its physiological range is nulled and reported, not clamped.
  const bad = A.parse('<HealthData><Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2026-09-01 07:00:00 +0530" endDate="2026-09-01 07:00:00 +0530" value="900"/></HealthData>');
  eq(bad.days[0].restingHr, null, 'an implausible resting heart rate is nulled, not clamped to 140');
  eq(bad.summary.implausible.length, 1, 'and is reported in summary.implausible');
  eq(bad.summary.implausible[0].field, 'restingHr', 'naming the field that was out of range');
  contractOk(bad, 'implausible-value parse');

  done(before);
}

section('Workouts');
{
  const before = failures.length;
  const out = A.parse({ files: [{ name: 'export.xml', text: APPLE_XML }] });
  eq(out.workouts.length, 1, 'the workout is read');
  const w = out.workouts[0];
  eq(w.date, '2026-08-01', 'attributed to its start date in the member timezone');
  eq(w.activity, 'FunctionalStrengthTraining', 'the HKWorkoutActivityType prefix is stripped');
  eq(w.durationMin, 47.5, 'duration is carried through in minutes');
  eq(w.energyKcal, 412, 'iOS 15+ WorkoutStatistics children supply the energy total');
  eq(w.avgHr, 128.4, 'and the average heart rate');
  eq(w.maxHr, 164, 'and the maximum heart rate');
  done(before);
}

/* ================================================================== *
 * 10. parse() guard rails — the size problem
 * ================================================================== */

section('parse(): refuses politely rather than exploding on a huge or wrong file');
{
  const before = failures.length;

  const none = A.parse({ files: [] });
  eq(none.days.length, 0, 'an empty upload produces no days');
  assert(none.summary.notes.some((n) => /export\.zip/.test(n)),
    'and explains that Apple exports as export.zip');
  contractOk(none, 'empty Apple upload');

  const wrong = A.parse({ files: [{ name: 'notes.xml', text: '<foo><bar/></foo>' }] });
  eq(wrong.days.length, 0, 'XML that is not an Apple export produces no days');
  assert(wrong.summary.notes.some((n) => /no Apple Health/.test(n)),
    'and says so rather than reporting the member has no data');
  contractOk(wrong, 'non-Apple XML');

  const cda = A.parse({ files: [{ name: 'export_cda.xml', text: '<ClinicalDocument/>' }] });
  assert(cda.summary.notes.some((n) => /clinical documents/.test(n)),
    'export_cda.xml is identified and skipped with an explanation');
  contractOk(cda, 'clinical document');

  const notXml = A.parse({ files: [{ name: 'photo.png', text: 'binary' }] });
  assert(notXml.summary.notes.some((n) => /Unrecognised file/.test(n)),
    'a non-XML file is skipped, not fatal');
  contractOk(notXml, 'non-XML file');

  // The size refusal. A real Apple export is 200MB-1.5GB; parse() must decline
  // rather than attempt it, and must say what to do instead.
  eq(typeof A.MAX_INLINE_CHARS, 'number', 'parse() publishes its in-memory ceiling');
  assert(A.MAX_INLINE_CHARS <= 64 * 1024 * 1024,
    'the in-memory ceiling is small enough to be safe on a modest dyno');
  const overCap = A.parse({ files: [{ name: 'export.xml', text: 'x'.repeat(A.MAX_INLINE_CHARS + 1) }] });
  eq(overCap.days.length, 0, 'an over-cap file is refused, not parsed');
  assert(overCap.summary.notes.some((n) => /parseStream/.test(n)),
    'and the refusal names parseStream as the route that does work');
  contractOk(overCap, 'over-cap refusal');

  // A truncated document (the network died mid-upload) must not throw.
  const truncated = A.parse(APPLE_XML.slice(0, Math.floor(APPLE_XML.length * 0.6)));
  assert(Array.isArray(truncated.days), 'a truncated export still returns the contract shape');
  contractOk(truncated, 'truncated Apple export');

  done(before);
}

/* ================================================================== *
 * 11. Health Connect
 * ================================================================== */

section('Health Connect: strict payload validation');
{
  const before = failures.length;
  const raw = read(path.join(FIXTURES, 'healthconnect', 'payload-v1.json'));
  const out = HC.parse(raw);
  contractOk(out, 'Health Connect payload');

  eq(out.days.length, 4, 'four dated days survive validation');
  const d1 = dayOf(out.days, '2026-08-01');
  eq(d1.source, 'health_connect', 'canonical provider id');
  eq(d1.measurementSource, 'native_sdk', 'an in-app read is tagged native_sdk, not device_export');
  eq(d1.hrvMs, 41.2, 'HRV value carried through');
  eq(d1.hrvMethod, 'rmssd_sleep', 'a stated sleep-window RMSSD maps to rmssd_sleep');
  eq(d1.sleepMinutes, 412, 'sleep total carried through');
  eq(d1.napMinutes, 35, 'naps stay in napMinutes, separate from the night');
  eq(d1.steps, 8123, 'steps carried through');
  eq(d1.energyKcal, 2210, 'total calories preferred when present');
  eq(d1.deviceModel, 'Samsung Galaxy Watch6 Classic', 'device metadata becomes deviceModel');
  eq(d1.providerScores['samsung.sleep_score'], 78, 'a namespaced device-native score is preserved');
  assert(!('notnamespaced' in d1.providerScores), 'a non-namespaced providerScores key is dropped');

  // The rule that matters: an unstated HRV window is 'unknown', never assumed.
  const d2 = dayOf(out.days, '2026-08-02');
  eq(d2.hrvMethod, 'unknown', 'HRV with no stated window is tagged unknown, never guessed as rmssd_sleep');
  assert(out.summary.notes.some((n) => /without a stated metric\/window/.test(n)),
    'and the client is told what to send');

  const d3 = dayOf(out.days, '2026-08-03');
  eq(d3.restingHr, null, 'a client-supplied restingHr of 900 is nulled, not clamped');
  eq(out.summary.implausible.length, 1, 'and reported in summary.implausible');
  eq(d3.skinTempC, null, 'a temperature with an unrecognised basis is refused');
  eq(d3.skinTempDeviationC, null, 'in both fields — an untagged temperature is unusable');
  eq(d3.hrvMethod, 'rmssd_spot', 'a stated spot-window RMSSD maps to rmssd_spot');

  assert(out.rejected.some((r) => /no valid `date`/.test(r.reason)), 'an undated day entry is rejected');
  assert(out.rejected.some((r) => /must be a JSON number/.test(r.reason)),
    'a numeric field arriving as a string is rejected, not coerced');
  assert(out.summary.unknownColumns.some((u) => u.column === 'somethingWeInventedLater'),
    'an unrecognised payload key is surfaced, not dropped silently');

  out.days.forEach((d) => {
    eq(d.recoveryScore, null, `${d.date}: Health Connect has no recovery score`);
    eq(d.strain, null, `${d.date}: Health Connect has no strain metric`);
  });

  eq(out.workouts.length, 1, 'workouts are carried through');
  eq(out.workouts[0].activity, 'STRENGTH_TRAINING', 'with their activity name');

  done(before);
}

section('Health Connect: an unknown schema version is refused, never improvised');
{
  const before = failures.length;
  const v2 = HC.parse({ schemaVersion: 2, days: [{ date: '2026-08-01', steps: 1 }] });
  eq(v2.days.length, 0, 'a v2 payload yields no days');
  assert(v2.summary.notes.some((n) => /Unsupported Health Connect payload schemaVersion 2/.test(n)),
    'and says exactly which version it refused');
  assert(v2.summary.notes.some((n) => /Refusing to guess/.test(n)),
    'and why it will not best-effort parse it');
  contractOk(v2, 'refused v2 payload');

  const noVersion = HC.parse({ days: [] });
  assert(noVersion.summary.notes.some((n) => /missing a numeric `schemaVersion`/.test(n)),
    'a payload with no schemaVersion is refused');
  contractOk(noVersion, 'version-less payload');

  const notJson = HC.parse('{ this is not json');
  assert(notJson.summary.notes.some((n) => /not valid JSON/.test(n)), 'invalid JSON is reported, not thrown');
  contractOk(notJson, 'invalid JSON payload');

  const noDays = HC.parse({ schemaVersion: 1 });
  assert(noDays.summary.notes.some((n) => /daily aggregates, not raw samples/.test(n)),
    'a payload with no days array says what the client should send');
  contractOk(noDays, 'day-less payload');

  // The method resolver in isolation.
  eq(HC.resolveHrvMethod({ metric: 'rmssd', window: 'sleep' }), 'rmssd_sleep', 'rmssd + sleep');
  eq(HC.resolveHrvMethod({ metric: 'rmssd', window: 'spot' }), 'rmssd_spot', 'rmssd + spot');
  eq(HC.resolveHrvMethod({ metric: 'sdnn', window: 'spot' }), 'sdnn_spot', 'sdnn + spot');
  eq(HC.resolveHrvMethod({ metric: 'rmssd' }), 'unknown', 'rmssd with no window is unknown');
  eq(HC.resolveHrvMethod({ metric: 'pnn50', window: 'sleep' }), 'unknown', 'an unrecognised metric is unknown');
  eq(HC.resolveHrvMethod(null), null, 'no HRV block at all yields no method');

  // Contract-clean even when a payload sends stages that exceed the night.
  const bad = HC.parse({
    schemaVersion: 1,
    days: [{ date: '2026-08-01', sleep: { totalMinutes: 300, remMinutes: 200, deepMinutes: 200, lightMinutes: 200 } }]
  });
  eq(bad.days[0].remMin, null, 'stages exceeding the night are dropped rather than shipped');
  assert(bad.summary.notes.some((n) => /stage breakdown \n?dropped|stage breakdown dropped/.test(n)),
    'and the client is told to check its nap handling');
  contractOk(bad, 'over-staged Health Connect payload');

  done(before);
}

/* ================================================================== *
 * 12. Samsung Health
 * ================================================================== */

section('Samsung Health: legacy CSV, and an honest steer when it cannot read');
{
  const before = failures.length;
  const dir = path.join(FIXTURES, 'samsung');
  const files = fs.readdirSync(dir).map((n) => ({ name: n, text: read(path.join(dir, n)) }));
  const out = SM.parse({ files });
  contractOk(out, 'Samsung legacy export');

  eq(out.days.length, 2, 'two days are produced');
  const d = dayOf(out.days, '2026-08-02');
  eq(d.source, 'samsung_health', 'canonical provider id');
  eq(d.sleepMinutes, 402, 'the night is attributed to its wake date (2026-08-01 23:30 -> 2026-08-02 06:12)');
  eq(d.napMinutes, 40, 'the 14:30 nap lands in napMinutes');
  assert(d.sleepMinutes === 402, 'and adds nothing to nightly sleep');
  eq(d.remMin, 95, 'REM minutes read through the alias table');
  eq(d.steps, 9214, 'step summary read');
  eq(d.activeMinutes, 45, 'an active_time of 2700000 ms is recognised as 45 minutes by magnitude');
  eq(d.avgHr, 82, 'avgHr is the mean of the heart-rate samples only (68, 96)');
  eq(d.maxHr, 141, 'maxHr comes from the max column, not from folding it into the mean');
  eq(d.providerScores['samsung.sleep_score'], 78,
    "Samsung's Sleep Score is device-native and stays out of every canonical field");
  assert(!('sleepPerformancePct' in d) || d.sleepPerformancePct === null,
    "and specifically does not become Whoop's sleepPerformancePct");

  // The legacy export has no HRV at all.
  eq(d.hrvMs, null, 'the legacy export carries no HRV');
  eq(d.hrvMethod, null, 'so there is no method to tag');
  eq(d.recoveryScore, null, 'and no recovery score');
  eq(d.strain, null, 'and no strain');

  assert(out.summary.unknownColumns.length >= 3,
    'unrecognised columns from every table are surfaced, not read by position');
  assert(out.summary.notes.some((n) => /Unrecognised file skipped: readme\.txt/.test(n)),
    'a non-CSV file in the ZIP is skipped with a note');
  assert(out.rejected.some((r) => /missing sleep end time/.test(r.reason)),
    'a sleep row with no wake time is rejected, not dated by guesswork');
  assert(out.summary.notes.some((n) => /Health Connect/.test(n)),
    'even a successful read steers the member toward Health Connect');

  done(before);
}

section('Samsung Health: unreadable input returns an empty result plus the Health Connect steer');
{
  const before = failures.length;

  const nothing = SM.parse({ files: [] });
  eq(nothing.days.length, 0, 'no files produces no days');
  assert(nothing.summary.notes.some((n) => /Health Connect/.test(n)),
    'and the member is told what to do instead');
  contractOk(nothing, 'empty Samsung upload');

  const garbage = SM.parse({ files: [{ name: 'com.samsung.shealth.sleep.1.csv', text: 'a,b,c\n1,2,3\n' }] });
  eq(garbage.days.length, 0, 'a CSV with no recognisable columns produces no days');
  assert(garbage.summary.notes.some((n) => /Health Connect/.test(n)), 'and steers to Health Connect');
  assert(garbage.summary.unknownColumns.length > 0,
    'while reporting the columns it could not understand rather than reading them by position');
  contractOk(garbage, 'unreadable Samsung CSV');

  const wrongVendor = SM.parse({ files: [{ name: 'physiological_cycles.csv', text: 'x\n1\n' }] });
  eq(wrongVendor.days.length, 0, 'a Whoop file uploaded here produces no days');
  contractOk(wrongVendor, 'wrong-vendor CSV');

  // Duration magnitude inference, in isolation.
  eq(SM.durationToMinutes('402'), 402, 'a value under 1440 is already minutes');
  eq(SM.durationToMinutes('24120'), 402, 'a value under 86400 is seconds');
  eq(SM.durationToMinutes('24120000'), 402, 'a value under 86400000 is milliseconds');
  eq(SM.durationToMinutes('999999999999'), null, 'an unplaceable magnitude is null, never scaled by hope');
  eq(SM.durationToMinutes(''), null, 'a blank duration is null, never 0');
  eq(SM.classifyFile('com.samsung.shealth.sleep.20240117093012.csv'), 'sleep', 'sleep file routed');
  eq(SM.classifyFile('com.samsung.shealth.tracker.pedometer_day_summary.1.csv'), 'steps', 'pedometer file routed');
  eq(SM.classifyFile('readme.txt'), null, 'a non-CSV is not routed');

  done(before);
}

/* ================================================================== *
 * Tail
 * ================================================================== */

(async () => {
  try {
    await module.exports._streamPromise;
  } catch (e) {
    failures.push('parseStream threw: ' + (e && e.stack ? e.stack : e));
  }

  if (failures.length > 0) {
    console.log('\n--- FAILURES ---');
    failures.forEach((f) => console.log(' ', f));
    console.log(`\n${failures.length} of ${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n--- All ${checks} native-health adapter checks passed ---`);
})();
