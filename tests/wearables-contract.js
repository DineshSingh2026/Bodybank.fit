/**
 * Contract + integration test for the universal wearable pipeline.
 * Run: node tests/wearables-contract.js      (no dependencies, no server, no DB)
 *
 * This suite guards the seams that four separate adapters all depend on:
 *
 *   1. canonicalDay.js enforces its own rules — especially rule 6, the provenance
 *      tags that stop an Apple SDNN reading being averaged with a Whoop RMSSD one.
 *   2. The Whoop adapter still produces contract-valid days from the real fixture
 *      export, so generalising the pipeline did not regress the device that was
 *      already working.
 *   3. canonicalDay.PROVIDERS and readinessService's VALID_PROVIDERS /
 *      SOURCE_PRECEDENCE have not drifted apart. Drift here is silent and total:
 *      normalizeProvider() returns null for an unlisted provider and the member's
 *      entire upload writes nothing.
 *   4. A canonical day survives normalizeParsed() with its provenance intact —
 *      i.e. the tags actually reach database columns rather than being reported
 *      as unknown columns and dropped.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const C = require('../services/wearables/canonicalDay');
const whoopAdapter = require('../services/wearables/adapters/whoop');
const R = require('../services/wearables/readinessService');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function section(name) {
  console.log('\n=== ' + name + ' ===');
}

function ok(msg) {
  console.log('  OK   ' + msg);
}

function check(cond, msg) {
  if (assert(cond, msg)) ok(msg);
  else console.log('  FAIL ' + msg);
}

/* ------------------------------------------------------------------ *
 * 1. The contract enforces itself
 * ------------------------------------------------------------------ */

section('canonicalDay: an empty day is contract-valid and carries no zeros');
{
  const d = C.emptyCanonicalDay('2026-09-01', 'whoop');
  check(C.validateCanonicalDay(d).length === 0, 'a fresh empty day validates clean');

  const zeroed = C.METRIC_FIELDS.filter((f) => d[f] === 0);
  // napMinutes is the one deliberate accumulator; everything else must start null
  // so "no data" stays distinguishable from "the member scored zero".
  check(zeroed.length === 1 && zeroed[0] === 'napMinutes',
    'napMinutes is the only field seeded at 0; every other metric starts null');
}

section('canonicalDay: rule 6 — an untagged measurement is rejected');
{
  const d = C.emptyCanonicalDay('2026-09-01', 'apple_health');
  d.hrvMs = 62;
  check(C.validateCanonicalDay(d).some((e) => /hrvMethod/.test(e)),
    'HRV without an hrvMethod is rejected — we could not know if it is comparable');

  d.hrvMethod = C.HRV_METHOD.SDNN_SPOT;
  check(C.validateCanonicalDay(d).length === 0, 'tagging the HRV method clears it');

  const t = C.emptyCanonicalDay('2026-09-01', 'fitbit');
  t.skinTempDeviationC = -0.4;
  check(C.validateCanonicalDay(t).some((e) => /tempBasis/.test(e)),
    'a temperature without a tempBasis is rejected');

  t.tempBasis = C.TEMP_BASIS.DEVIATION_C;
  check(C.validateCanonicalDay(t).length === 0, 'tagging the basis clears it');

  // The specific bug this guards: a -0.4 baseline deviation written into an
  // absolute column reads as hypothermia in the member's report.
  t.skinTempC = 33.1;
  check(C.validateCanonicalDay(t).some((e) => /deviation must never be stored as an absolute/.test(e)),
    'a deviation and an absolute temperature can never coexist on one day');
}

section('canonicalDay: implausible values are caught, not clamped');
{
  const d = C.emptyCanonicalDay('2026-09-01', 'screenshot');
  d.spo2 = 140;
  check(C.validateCanonicalDay(d).some((e) => /spo2/.test(e)), 'SpO2 of 140% is rejected');

  const h = C.emptyCanonicalDay('2026-09-01', 'screenshot');
  h.hrvMs = 9000;
  h.hrvMethod = C.HRV_METHOD.UNKNOWN;
  check(C.validateCanonicalDay(h).some((e) => /hrvMs/.test(e)), 'an HRV of 9000ms is rejected');
}

section('canonicalDay: internally inconsistent sleep is caught');
{
  const d = C.emptyCanonicalDay('2026-09-01', 'garmin');
  d.sleepMinutes = 300;
  d.remMin = 200;
  d.deepMin = 200;
  d.lightMin = 200;
  check(C.validateCanonicalDay(d).some((e) => /stages total/.test(e)),
    'sleep stages that exceed the night itself are rejected');

  const s = C.emptyCanonicalDay('2026-09-01', 'garmin');
  s.sleepHours = 7;
  s.sleepMinutes = 300; // 5h — disagrees with sleepHours
  check(C.validateCanonicalDay(s).some((e) => /disagree/.test(e)),
    'sleepHours and sleepMinutes describing different nights are rejected');
}

section('canonicalDay: provider scores must stay namespaced');
{
  const d = C.emptyCanonicalDay('2026-09-01', 'garmin');
  d.providerScores = { body_battery: 62 };
  check(C.validateCanonicalDay(d).some((e) => /namespaced/.test(e)),
    'an un-namespaced provider score is rejected');

  d.providerScores = { 'garmin.body_battery': 62 };
  check(C.validateCanonicalDay(d).length === 0, 'a namespaced provider score is accepted');
}

section('canonicalDay: export-level structure');
{
  check(C.validateParsedExport(C.emptyParsedExport('whoop')).ok,
    'an empty parsed export is contract-valid');

  const a = C.emptyCanonicalDay('2026-09-02', 'whoop');
  const b = C.emptyCanonicalDay('2026-09-01', 'whoop');
  const unsorted = C.emptyParsedExport('whoop');
  unsorted.days = [a, b];
  check(C.validateParsedExport(unsorted).errors.some((e) => /sorted/.test(e)),
    'days out of ascending order are rejected — trend slopes depend on the order');

  const dup = C.emptyParsedExport('whoop');
  dup.days = [C.emptyCanonicalDay('2026-09-01', 'whoop'), C.emptyCanonicalDay('2026-09-01', 'whoop')];
  check(C.validateParsedExport(dup).errors.some((e) => /duplicate date/.test(e)),
    'two rows for one date+source are rejected — the upsert would silently drop one');
}

/* ------------------------------------------------------------------ *
 * 2. Whoop still works, and now carries provenance
 * ------------------------------------------------------------------ */

section('whoop adapter: the real fixture export is contract-valid');

const FIXTURES = path.join(__dirname, 'fixtures', 'whoop');
const files = fs.readdirSync(FIXTURES)
  .filter((n) => /\.csv$/i.test(n))
  .map((n) => ({ name: n, text: fs.readFileSync(path.join(FIXTURES, n), 'utf8') }));

const parsed = whoopAdapter.parse({ files: files });
const verdict = C.validateParsedExport(parsed);

check(verdict.ok, 'the Whoop fixture export passes validateParsedExport()'
  + (verdict.ok ? '' : ' — ' + verdict.errors.slice(0, 5).join('; ')));
check(parsed.days.length > 0, 'it produced days (' + parsed.days.length + ')');
check(parsed.workouts.length > 0, 'it produced workouts (' + parsed.workouts.length + ')');
check(parsed.rejected.length > 0,
  'the deliberately malformed fixture rows were rejected, not guessed (' + parsed.rejected.length + ')');

{
  const withHrv = parsed.days.filter((d) => d.hrvMs !== null);
  check(withHrv.length > 0, 'some days carry HRV');
  check(withHrv.every((d) => d.hrvMethod === C.HRV_METHOD.RMSSD_SLEEP),
    'every Whoop HRV is tagged rmssd_sleep — the reference method');

  const withTemp = parsed.days.filter((d) => d.skinTempC !== null);
  check(withTemp.every((d) => d.tempBasis === C.TEMP_BASIS.ABSOLUTE_C),
    'every Whoop temperature is tagged absolute_c');
  check(parsed.days.every((d) => d.skinTempDeviationC === null),
    'Whoop never populates the deviation field');

  check(parsed.days.every((d) => d.measurementSource === C.MEASUREMENT_SOURCE.DEVICE_EXPORT),
    'every day is marked as coming from a vendor export');
  check(parsed.days.every((d) => d.source === 'whoop'), 'every day is sourced to whoop');
  check(parsed.days.every((d) => d.steps === null && d.activeMinutes === null),
    'Whoop has no step counter, so steps/activeMinutes stay null rather than 0');
}

section('whoop adapter: it does not alter the numbers');
{
  // The shim must be transparent. Re-parse through the raw parser and compare.
  const { parseWhoopExport } = require('../services/wearables/whoopParser');
  const rawParsed = parseWhoopExport({ files: files });
  const rawByDate = new Map(rawParsed.days.map((d) => [d.date, d]));
  let drift = 0;
  parsed.days.forEach((d) => {
    const raw = rawByDate.get(d.date);
    if (!raw) { drift += 1; return; }
    ['recoveryScore', 'hrvMs', 'restingHr', 'strain', 'sleepHours', 'napMinutes'].forEach((f) => {
      const a = raw[f] === undefined ? null : raw[f];
      if (a !== d[f]) drift += 1;
    });
  });
  check(drift === 0, 'the shim changed no value the underlying parser produced');
}

/* ------------------------------------------------------------------ *
 * 3. Contract and persistence agree on providers
 * ------------------------------------------------------------------ */

section('providers: the contract and the database layer have not drifted');
{
  const unranked = C.PROVIDERS.filter(
    (p) => !Object.prototype.hasOwnProperty.call(R.SOURCE_PRECEDENCE, p)
  );
  check(unranked.length === 0,
    'every contract provider has a precedence rank' + (unranked.length ? ' — missing: ' + unranked.join(', ') : ''));

  const ranks = Object.keys(R.SOURCE_PRECEDENCE).map((k) => R.SOURCE_PRECEDENCE[k]);
  check(new Set(ranks).size === ranks.length, 'no two providers share a precedence rank');

  // The historic ordering must survive, or existing members' resolved days change
  // meaning under them.
  check(R.SOURCE_PRECEDENCE.whoop < R.SOURCE_PRECEDENCE.manual,
    'whoop still outranks manual, as it did before multi-device');
  check(R.SOURCE_PRECEDENCE.manual < R.SOURCE_PRECEDENCE.derived,
    'manual still outranks derived, as it did before multi-device');
  // A number the member read off their own app beats a model reading a photo of it.
  check(R.SOURCE_PRECEDENCE.manual < R.SOURCE_PRECEDENCE.screenshot,
    'a member-entered figure outranks an AI-read screenshot');
  // A measurement always beats something we computed ourselves.
  check(Math.max.apply(null, ['whoop', 'oura', 'fitbit', 'garmin', 'apple_health', 'screenshot']
    .map((p) => R.SOURCE_PRECEDENCE[p])) < R.SOURCE_PRECEDENCE.derived,
    'every real measurement outranks BodyBank\'s own derived score');
}

/* ------------------------------------------------------------------ *
 * 4. Provenance survives the trip to the database
 * ------------------------------------------------------------------ */

section('persistence: provenance tags reach real columns');
{
  const n = R.normalizeParsed(parsed);
  check(n.rows.length === parsed.days.length, 'every canonical day normalised to a row');
  check(n.undated === 0, 'no day lost its date on the way');

  const v = n.rows[0].values;
  check(v.hrv_method === 'rmssd_sleep', 'hrvMethod persisted to the hrv_method column');
  check(v.temp_basis === 'absolute_c', 'tempBasis persisted to the temp_basis column');
  check(v.measurement_source === 'device_export', 'measurementSource persisted to its column');
  check(v.skin_temp_unit === 'C', 'the original unit tag still survives');

  // The regression this guards: an unaliased field is reported as an unknown column
  // on every import AND never persisted, so the tag silently disappears.
  const tagNoise = n.unknownColumns.filter(
    (c) => /hrvMethod|tempBasis|measurementSource|deviceModel|providerScores|steps|activeMinutes|skinTempDeviationC/i.test(c)
  );
  check(tagNoise.length === 0,
    'no provenance field leaked into unknownColumns' + (tagNoise.length ? ' — ' + tagNoise.join(', ') : ''));

  // The fixture carries one deliberately unrecognised column; it must still be
  // reported, or we lose our early warning that a vendor changed their format.
  check(n.unknownColumns.length > 0,
    'a genuinely unknown vendor column is still reported (' + n.unknownColumns.join(', ') + ')');
}

section('persistence: every contract field has somewhere to land');
{
  const cols = R.METRIC_COLUMNS.concat(R.TEXT_COLUMNS);
  const needed = ['skin_temp_deviation_c', 'steps', 'active_minutes',
    'hrv_method', 'temp_basis', 'measurement_source', 'device_model'];
  needed.forEach((c) => {
    check(cols.indexOf(c) !== -1, 'readiness_daily has a ' + c + ' column');
  });
}

/* ------------------------------------------------------------------ *
 * 5. Cross-module wiring
 *
 * These modules are built by separate hands and can drift apart silently. Each
 * check below corresponds to a failure a member would actually experience.
 * ------------------------------------------------------------------ */

section('wiring: the device registry, the dispatcher and the contract agree');
{
  let registry = null;
  try { registry = require('../services/wearables/deviceRegistry'); } catch (e) { /* not deployed */ }

  if (!registry) {
    console.log('  SKIP deviceRegistry.js is not deployed in this build');
  } else {
    const AR = require('../services/wearables/adapterRegistry');
    const devices = registry.listDevices();

    check(devices.length > 0, 'the registry lists devices (' + devices.length + ')');

    // Every registry device must be a provider the database will actually accept,
    // or the member picks it, uploads, and every row is silently discarded.
    const unpersistable = devices.filter(
      (d) => !Object.prototype.hasOwnProperty.call(R.SOURCE_PRECEDENCE, d.id)
    );
    check(unpersistable.length === 0,
      'every listed device can be persisted'
      + (unpersistable.length ? ' — orphaned: ' + unpersistable.map((d) => d.id).join(', ') : ''));

    // A device the UI offers a FILE route for must have an adapter behind it, or
    // the member uploads and gets "not supported here" after doing the work.
    const FILE_ROUTES = ['zip', 'csv', 'json', 'xml'];
    const fileDevices = devices.filter(
      (d) => Array.isArray(d.ingest) && d.ingest.some((r) => FILE_ROUTES.indexOf(r) !== -1)
    );
    const orphaned = fileDevices.filter((d) => !AR.ADAPTER_PATHS[d.id]);
    check(orphaned.length === 0,
      'every device offering a file upload has an adapter path registered'
      + (orphaned.length ? ' — orphaned: ' + orphaned.map((d) => d.id).join(', ') : ''));

    // The registry's declared HRV method must be a value the contract validator
    // will accept, or every day that adapter writes is rejected at the seam.
    const badMethod = devices.filter(
      (d) => d.hrvMethod && C.HRV_METHODS.indexOf(d.hrvMethod) === -1
    );
    check(badMethod.length === 0, 'every declared hrvMethod is a legal contract value');

    const badBasis = devices.filter(
      (d) => d.tempBasis && C.TEMP_BASES.indexOf(d.tempBasis) === -1
    );
    check(badBasis.length === 0, 'every declared tempBasis is a legal contract value');

    // The trap this whole design exists to prevent.
    const apple = registry.getDevice('apple_health');
    const whoop = registry.getDevice('whoop');
    if (apple && whoop) {
      check(apple.hrvMethod !== whoop.hrvMethod,
        'Apple and Whoop are declared with DIFFERENT hrv methods ('
        + apple.hrvMethod + ' vs ' + whoop.hrvMethod + ') — they must never share a series');
    }

    // Devices with no export path at all must still be representable, honestly.
    if (typeof registry.listBudgetBands === 'function') {
      const bands = registry.listBudgetBands();
      check(bands.length > 0, 'budget bands with no export are listed (' + bands.length + ')');
      check(bands.every((b) => !Object.prototype.hasOwnProperty.call(AR.ADAPTER_PATHS, b.id || '')),
        'no budget band pretends to have a file adapter');
    }
  }
}

section('wiring: the baseline engine refuses to mix measurement methods');
{
  let B = null;
  try { B = require('../services/wearables/baselineService'); } catch (e) { /* not deployed */ }

  if (!B) {
    console.log('  SKIP baselineService.js is not deployed in this build');
  } else {
    // A member who switched from an Apple Watch to a Whoop. Their HRV numbers are
    // both real and completely incomparable; merging them would invent a cliff.
    const days = [];
    for (let i = 1; i <= 15; i += 1) {
      const d = C.emptyCanonicalDay('2026-08-' + String(i).padStart(2, '0'), 'apple_health');
      d.hrvMs = 95; d.hrvMethod = C.HRV_METHOD.SDNN_SPOT; days.push(d);
    }
    for (let i = 16; i <= 30; i += 1) {
      const d = C.emptyCanonicalDay('2026-08-' + String(i).padStart(2, '0'), 'whoop');
      d.hrvMs = 50; d.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP; days.push(d);
    }

    const r = B.computeBaseline(days, 'hrvMs', { windowDays: 30 });
    check(r && r.baseline === null,
      'a history mixing SDNN and RMSSD yields NO merged baseline');
    check(r && /mixed/i.test(String(r.reason || '')),
      'and says why (' + (r && r.reason) + ')');
    check(r && r.series && Object.keys(r.series).length === 2,
      'each method still gets its own baseline');

    // The number a naive implementation would have produced, for the record: the
    // midpoint of two populations, describing neither.
    if (r && r.series && r.series.rmssd_sleep && r.series.sdnn_spot) {
      check(r.series.rmssd_sleep.center !== r.series.sdnn_spot.center,
        'the two series centres differ ('
        + r.series.rmssd_sleep.center + ' vs ' + r.series.sdnn_spot.center + ')');
    }

    // One corrupt night must not move the member's baseline.
    const clean = [];
    for (let i = 1; i <= 30; i += 1) {
      const d = C.emptyCanonicalDay('2026-08-' + String(i).padStart(2, '0'), 'whoop');
      d.hrvMs = 50; d.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP; clean.push(d);
    }
    const before = B.computeBaseline(clean, 'hrvMs', { windowDays: 30 }).baseline;
    clean[10].hrvMs = 380;
    const after = B.computeBaseline(clean, 'hrvMs', { windowDays: 30 }).baseline;
    check(before && after && before.center === after.center,
      'a single 380ms garbage night moves the robust centre by 0 (mean moved by '
      + (after.mean - before.mean).toFixed(1) + ')');
  }
}

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log('\n' + '-'.repeat(60));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + checks + ' checks:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('--- All ' + checks + ' wearable-contract checks passed ---');
