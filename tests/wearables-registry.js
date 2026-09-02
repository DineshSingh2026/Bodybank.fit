/**
 * Contract test for the multi-device registry.
 * Run: node tests/wearables-registry.js      (no dependencies, no server, no DB)
 *
 * The registry is data, so these checks are mostly about the ways that data can
 * lie:
 *   - a device id that is not a canonical provider writes NOTHING at persist time
 *   - a capability map with a hole means a metric silently vanishes from the UI
 *   - an HRV capability with no method tag lets Apple's SDNN contaminate a WHOOP
 *     RMSSD series, which is the one failure this whole slice exists to prevent
 *   - a temperature capability whose basis disagrees with it writes a -0.3 delta
 *     into an absolute field and reads back as hypothermia
 */
'use strict';

const C = require('../services/wearables/canonicalDay');
const R = require('../services/wearables/deviceRegistry');

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

/* ------------------------------------------------------------------ */

section('Static self-check');
{
  const before = failures.length;
  deepEq(R.REGISTRY_DEFECTS, [], 'registry loads with no self-check defects');
  assert(R.DEVICE_LIST.length >= 12, `at least 12 devices registered (got ${R.DEVICE_LIST.length})`);
  done(before);
}

section('Every device id is a canonical provider');
{
  const before = failures.length;
  R.DEVICE_LIST.forEach((d) => {
    assert(C.PROVIDERS.indexOf(d.id) !== -1,
      `${d.id}: not a member of canonicalDay.PROVIDERS — its uploads would be silently dropped`);
  });
  const ids = R.DEVICE_LIST.map((d) => d.id);
  eq(new Set(ids).size, ids.length, 'device ids are unique');

  // Everything the brief promised members we would support.
  ['whoop', 'oura', 'fitbit', 'garmin', 'apple_health', 'samsung_health',
    'health_connect', 'polar', 'amazfit', 'generic_csv', 'screenshot', 'manual'
  ].forEach((id) => {
    assert(R.getDevice(id) !== null, `required device "${id}" is registered`);
  });
  done(before);
}

section('Capabilities cover every canonical metric with a legal value');
{
  const before = failures.length;
  R.DEVICE_LIST.forEach((d) => {
    const keys = Object.keys(d.capabilities);
    eq(keys.length, C.METRIC_FIELDS.length, `${d.id}: capability map has one entry per METRIC_FIELDS entry`);
    C.METRIC_FIELDS.forEach((m) => {
      const v = d.capabilities[m];
      assert(R.CAPABILITIES.indexOf(v) !== -1,
        `${d.id}.capabilities.${m}: expected native|derived|none, got ${JSON.stringify(v)}`);
    });
  });
  // `confidence` is computed by BodyBank, never reported by a device.
  R.DEVICE_LIST.forEach((d) => {
    eq(d.capabilities.confidence, 'derived', `${d.id}: confidence is BodyBank-derived, never native`);
  });
  done(before);
}

section('HRV method tags — the phantom-cliff guard');
{
  const before = failures.length;
  R.DEVICE_LIST.forEach((d) => {
    if (d.capabilities.hrvMs === 'native') {
      assert(typeof d.hrvMethod === 'string' && C.HRV_METHODS.indexOf(d.hrvMethod) !== -1,
        `${d.id}: claims native HRV but declares hrvMethod ${JSON.stringify(d.hrvMethod)}`);
    }
    if (d.hrvMethod !== null) {
      assert(C.HRV_METHODS.indexOf(d.hrvMethod) !== -1,
        `${d.id}.hrvMethod: ${JSON.stringify(d.hrvMethod)} is not a canonical HRV_METHOD`);
    }
  });

  // The specific values that matter. Getting any of these wrong corrupts every
  // trend for a member who changes device.
  eq(R.getDevice('apple_health').hrvMethod, C.HRV_METHOD.SDNN_SPOT,
    'Apple Watch HRV is SDNN from a spot check, NOT overnight RMSSD');
  eq(R.getDevice('whoop').hrvMethod, C.HRV_METHOD.RMSSD_SLEEP, 'WHOOP HRV is overnight RMSSD');
  eq(R.getDevice('oura').hrvMethod, C.HRV_METHOD.RMSSD_SLEEP, 'Oura HRV is overnight RMSSD');
  eq(R.getDevice('fitbit').hrvMethod, C.HRV_METHOD.RMSSD_SLEEP, 'Fitbit HRV is overnight RMSSD');
  eq(R.getDevice('garmin').hrvMethod, C.HRV_METHOD.RMSSD_SLEEP, 'Garmin HRV Status is overnight RMSSD');
  assert(R.getDevice('apple_health').hrvMethod !== R.getDevice('whoop').hrvMethod,
    'Apple and WHOOP HRV must never share a method tag');
  // A pipe, not a sensor: whatever app wrote the RMSSD chose its own window.
  eq(R.getDevice('health_connect').hrvMethod, C.HRV_METHOD.UNKNOWN,
    'Health Connect HRV provenance is unknown by construction');
  eq(R.getDevice('generic_csv').hrvMethod, C.HRV_METHOD.UNKNOWN, 'a generic CSV cannot vouch for its HRV method');
  eq(R.getDevice('screenshot').hrvMethod, C.HRV_METHOD.UNKNOWN, 'a screenshot cannot vouch for its HRV method');
  // Devices with no HRV must not invent a method.
  eq(R.getDevice('samsung_health').capabilities.hrvMs, 'none', 'Samsung Health export carries no HRV');
  eq(R.getDevice('samsung_health').hrvMethod, null, 'no HRV -> no method tag');
  eq(R.getDevice('amazfit').hrvMethod, null, 'no HRV -> no method tag (amazfit)');
  done(before);
}

section('Temperature basis — absolute vs deviation');
{
  const before = failures.length;
  R.DEVICE_LIST.forEach((d) => {
    const suppliesTemp = d.capabilities.skinTempC !== 'none' || d.capabilities.skinTempDeviationC !== 'none';
    if (suppliesTemp) {
      assert(typeof d.tempBasis === 'string' && C.TEMP_BASES.indexOf(d.tempBasis) !== -1,
        `${d.id}: supplies a temperature but tempBasis is ${JSON.stringify(d.tempBasis)}`);
    }
    if (d.capabilities.skinTempC === 'native') {
      assert(d.tempBasis !== C.TEMP_BASIS.DEVIATION_C,
        `${d.id}: an absolute skinTempC with a deviation basis would read as hypothermia`);
    }
    if (d.capabilities.skinTempDeviationC === 'native') {
      assert(d.tempBasis !== C.TEMP_BASIS.ABSOLUTE_C,
        `${d.id}: a deviation stored as an absolute is a unit bug waiting to happen`);
    }
  });
  eq(R.getDevice('whoop').tempBasis, C.TEMP_BASIS.ABSOLUTE_C, 'WHOOP reports absolute skin temperature');
  eq(R.getDevice('whoop').capabilities.skinTempDeviationC, 'none', 'WHOOP has no deviation field');
  eq(R.getDevice('fitbit').tempBasis, C.TEMP_BASIS.DEVIATION_C, 'Fitbit reports a temperature variation');
  eq(R.getDevice('fitbit').capabilities.skinTempC, 'none', 'Fitbit must not write into the absolute field');
  eq(R.getDevice('oura').tempBasis, C.TEMP_BASIS.DEVIATION_C, 'Oura reports a temperature deviation');
  // Apple was the one genuinely contested entry, and the export settled it: the raw
  // record is `unit="degC" value="33.42"` — an ABSOLUTE Celsius reading. The "+0.3"
  // the Health app shows is rendered against a baseline that is private to the
  // device and absent from the export, so it cannot be recovered from the file; it
  // is re-derived against the member's own history by baselineService instead.
  eq(R.getDevice('apple_health').tempBasis, C.TEMP_BASIS.ABSOLUTE_C,
    'Apple wrist temperature is an absolute degC sample, not the deviation the app displays');
  eq(R.getDevice('apple_health').capabilities.skinTempC, 'native',
    'Apple writes the absolute temperature field');
  eq(R.getDevice('apple_health').capabilities.skinTempDeviationC, 'derived',
    'and its deviation is something we derive, not something Apple gives us');
  done(before);
}

section('Ingest routes, tiers, confidence priors and member copy');
{
  const before = failures.length;
  R.DEVICE_LIST.forEach((d) => {
    assert(Array.isArray(d.ingest), `${d.id}.ingest is an array`);
    d.ingest.forEach((r) => {
      assert(R.INGEST_ROUTES.indexOf(r) !== -1, `${d.id}.ingest: unknown route ${JSON.stringify(r)}`);
    });
    assert(R.TIERS.indexOf(d.tier) !== -1, `${d.id}.tier: ${JSON.stringify(d.tier)} is not a legal tier`);
    assert(typeof d.baseConfidence === 'number' && d.baseConfidence >= 0 && d.baseConfidence <= 1,
      `${d.id}.baseConfidence is 0..1`);
    assert(typeof d.exportInstructions === 'string' && d.exportInstructions.length > 20,
      `${d.id}.exportInstructions is a real instruction, not a placeholder`);
    assert(Array.isArray(d.caveats) && d.caveats.length > 0, `${d.id}.caveats is non-empty`);
    d.caveats.forEach((c) => assert(typeof c === 'string' && c.length > 10, `${d.id}: caveat is a real sentence`));
    ['label', 'shortLabel', 'brand'].forEach((k) => {
      assert(typeof d[k] === 'string' && d[k].length > 0, `${d.id}.${k} is member-facing copy`);
    });
  });

  // manual is a form, not a file route — the upload UI must not offer it.
  deepEq(R.getDevice('manual').ingest, [], 'manual has no file ingest route');
  R.DEVICE_LIST.filter((d) => d.id !== 'manual').forEach((d) => {
    assert(d.ingest.length > 0, `${d.id} has at least one file ingest route`);
  });

  // Priors must be ordered by honest fidelity.
  assert(R.getDevice('whoop').baseConfidence > R.getDevice('screenshot').baseConfidence,
    'a vendor export outranks a screenshot');
  assert(R.getDevice('screenshot').baseConfidence < 0.5, 'screenshots carry a genuinely low prior');
  eq(R.getDevice('screenshot').tier, 'minimal', 'screenshot ingestion is a minimal-fidelity route');
  eq(R.getDevice('whoop').tier, 'full', 'WHOOP is a full-fidelity device');
  done(before);
}

section('Budget bands are represented honestly');
{
  const before = failures.length;
  const bands = R.listBudgetBands();
  assert(bands.length >= 3, `budget bands are listed (got ${bands.length})`);
  ['Noise', 'boAt', 'Fire-Boltt'].forEach((brand) => {
    assert(bands.some((b) => b.brand === brand), `${brand} is listed`);
  });
  bands.forEach((b) => {
    eq(b.deviceId, 'screenshot', `${b.brand} routes to the screenshot device`);
    eq(b.tier, 'minimal', `${b.brand} is minimal tier`);
    deepEq(b.ingest, ['screenshot'], `${b.brand} accepts screenshots only`);
    assert(typeof b.note === 'string' && /no data export/i.test(b.note), `${b.brand} says plainly that it has no export`);
    // They are brands, not providers — a band must never become a device id.
    assert(C.PROVIDERS.indexOf(b.brand.toLowerCase()) === -1, `${b.brand} is not masquerading as a provider id`);
    assert(R.getDevice(b.deviceId) !== null, `${b.brand} points at a real registry device`);
  });
  done(before);
}

section('Lookup helpers');
{
  const before = failures.length;
  eq(R.getDevice('whoop').id, 'whoop', 'getDevice by id');
  eq(R.getDevice('  WHOOP  ').id, 'whoop', 'getDevice trims and lowercases');
  eq(R.getDevice('nope'), null, 'unknown id -> null');
  eq(R.getDevice(null), null, 'null id -> null (no throw)');
  eq(R.getDevice(42), null, 'non-string id -> null (no throw)');

  eq(R.listDevices().length, R.DEVICE_LIST.length, 'listDevices returns everything by default');
  assert(R.listDevices({ tier: 'minimal' }).every((d) => d.tier === 'minimal'), 'listDevices filters by tier');
  assert(R.listDevices({ ingest: 'zip' }).every((d) => d.ingest.indexOf('zip') !== -1), 'listDevices filters by route');
  assert(R.listDevices({ ingest: 'zip' }).some((d) => d.id === 'whoop'), 'WHOOP is a zip route');

  eq(R.capabilityFor('whoop', 'hrvMs'), 'native', 'capabilityFor reads the map');
  eq(R.capabilityFor('whoop', 'steps'), 'none', 'WHOOP does not count steps');
  eq(R.capabilityFor('nope', 'hrvMs'), 'none', 'unknown device -> none');
  eq(R.capabilityFor('whoop', 'notAMetric'), 'none', 'unknown metric -> none');
  eq(R.supportsMetric('whoop', 'hrvMs'), true, 'supportsMetric true for native');
  eq(R.supportsMetric('apple_health', 'maxHr'), true, 'supportsMetric true for derived');
  eq(R.supportsMetric('whoop', 'steps'), false, 'supportsMetric false for none');
  eq(R.supportsMetric('nope', 'hrvMs'), false, 'supportsMetric false for unknown device');

  const m = R.capabilityMatrix();
  eq(m.metrics.length, C.METRIC_FIELDS.length, 'matrix covers every metric');
  eq(m.devices.length, R.DEVICE_LIST.length, 'matrix covers every device');
  C.METRIC_FIELDS.forEach((metric) => {
    assert(m.rows[metric] && Object.keys(m.rows[metric]).length === m.devices.length,
      `matrix row ${metric} has a cell for every device`);
  });
  eq(m.rows.hrvMs.samsung_health, 'none', 'matrix reports Samsung has no HRV');
  eq(m.rows.hrvMs.whoop, 'native', 'matrix reports WHOOP has native HRV');
  done(before);
}

section('confidenceFor');
{
  const before = failures.length;
  const S = C.MEASUREMENT_SOURCE;
  eq(R.confidenceFor('nope', { coverageDays: 30 }), 0, 'unknown device vouches for nothing');
  eq(R.confidenceFor(null), 0, 'null id -> 0 (no throw)');

  const full = R.confidenceFor('whoop', { coverageDays: 30, expectedDays: 30, measurementSource: S.DEVICE_EXPORT });
  eq(full, 0.95, 'full-coverage WHOOP export equals its base prior');

  const thin = R.confidenceFor('whoop', { coverageDays: 3, expectedDays: 30, measurementSource: S.DEVICE_EXPORT });
  assert(thin < full, 'thin coverage lowers confidence');
  assert(thin > 0.5, 'three days of WHOOP is still decent evidence, not worthless');

  const shot = R.confidenceFor('screenshot', { coverageDays: 30, expectedDays: 30, measurementSource: S.VISION });
  assert(shot < thin, 'a month of screenshots is weaker than three days of a real export');

  const manual = R.confidenceFor('manual', { coverageDays: 30, expectedDays: 30, measurementSource: S.MANUAL });
  assert(manual < R.confidenceFor('manual', { coverageDays: 30, expectedDays: 30, measurementSource: S.DEVICE_EXPORT }),
    'a typed value is discounted against a parsed one');

  // Monotone in coverage, and always inside 0..1.
  let prev = -1;
  [0, 1, 5, 10, 20, 30, 60].forEach((days) => {
    const v = R.confidenceFor('oura', { coverageDays: days, expectedDays: 30, measurementSource: S.DEVICE_EXPORT });
    assert(v >= prev, `confidence is non-decreasing in coverage (at ${days}d)`);
    assert(v >= 0 && v <= 1, `confidence stays in 0..1 (at ${days}d, got ${v})`);
    prev = v;
  });
  eq(R.confidenceFor('oura', { coverageDays: 999, expectedDays: 30, measurementSource: S.DEVICE_EXPORT }),
    R.confidenceFor('oura', { coverageDays: 30, expectedDays: 30, measurementSource: S.DEVICE_EXPORT }),
    'coverage beyond the expectation does not keep inflating confidence');

  // Garbage in, a number out — never a throw, never a NaN.
  [undefined, null, {}, { coverageDays: NaN }, { coverageDays: -5, expectedDays: 0 },
    { measurementSource: 'nonsense' }, { expectedDays: 'thirty' }].forEach((o, i) => {
    const v = R.confidenceFor('whoop', o);
    assert(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
      `malformed opts #${i} still yields a finite 0..1 confidence (got ${v})`);
  });
  done(before);
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.log('\n--- FAILURES ---');
  failures.forEach((f) => console.log(' ', f));
  console.log(`\n${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`\n--- All ${checks} device registry checks passed ---`);
