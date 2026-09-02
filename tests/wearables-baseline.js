/**
 * Contract test for the personal-baseline engine.
 * Run: node tests/wearables-baseline.js      (no dependencies, no server, no DB)
 *
 * The failures this file is written to catch are the expensive, invisible ones:
 *   - two different HRV measurements averaged into one baseline, so a member who
 *     swaps an Apple Watch for a WHOOP sees a recovery cliff that never happened
 *   - a baseline computed from four nights and rendered as a confident band
 *   - one garbage reading dragging a mean, and with it every z-score for a month
 *   - a "readiness score" fabricated from a single weak input
 */
'use strict';

const C = require('../services/wearables/canonicalDay');
const B = require('../services/wearables/baselineService');

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

function near(actual, expected, tol, msg) {
  const ok = typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  return assert(ok, `${msg} — expected ${expected} +/-${tol}, got ${JSON.stringify(actual)}`);
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return assert(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
}

function section(name) { console.log(`=== ${name} ===`); }
function done(before) { console.log(failures.length === before ? '  OK' : '  FAIL'); }

/* ------------------------------------------------------------------ *
 * Fixtures — built by hand so every expectation is arithmetic, not vibes.
 * ------------------------------------------------------------------ */

/** A canonical-shaped day with only the fields a test cares about. */
function mk(date, fields) {
  return Object.assign(C.emptyCanonicalDay(date, (fields && fields.source) || 'whoop'), fields || {});
}

/** '2025-01-01' + n days. */
function d(n) { return B.addDaysYmd('2025-01-01', n); }

/** A repeating, symmetric block so medians land on whole numbers. */
const HRV_BLOCK = [48, 52, 46, 54, 50, 49, 51, 47, 53, 50];
const RHR_BLOCK = [55, 57, 54, 58, 56, 55, 57, 54, 58, 56];
const SLEEP_BLOCK = [420, 450, 400, 470, 435, 425, 445, 405, 465, 430];
const EFF_BLOCK = [88, 92, 85, 94, 90, 89, 91, 86, 93, 90];

/** 20 consecutive WHOOP days: HRV tagged rmssd_sleep throughout. */
function whoopHistory() {
  const days = [];
  for (let i = 0; i < 20; i += 1) {
    days.push(mk(d(i), {
      source: 'whoop',
      hrvMs: HRV_BLOCK[i % 10],
      hrvMethod: C.HRV_METHOD.RMSSD_SLEEP,
      restingHr: RHR_BLOCK[i % 10],
      sleepMinutes: SLEEP_BLOCK[i % 10],
      sleepEfficiencyPct: EFF_BLOCK[i % 10]
    }));
  }
  return days;
}

/* ------------------------------------------------------------------ */

section('Statistics primitives');
{
  const before = failures.length;
  eq(B.median([3, 1, 2]), 2, 'median of an odd sample');
  eq(B.median([4, 1, 2, 3]), 2.5, 'median of an even sample');
  eq(B.median([]), null, 'median of nothing -> null');
  eq(B.median(null), null, 'median of null -> null (no throw)');
  eq(B.mad([1, 2, 3, 4, 5]), 1, 'MAD about the median');
  eq(B.mad([5, 5, 5, 5]), 0, 'MAD of a constant series is 0');
  eq(B.stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 'sample standard deviation (n-1)');
  eq(B.stdDev([7]), null, 'SD needs at least two points');
  eq(B.addDaysYmd('2025-01-31', 1), '2025-02-01', 'date arithmetic crosses a month');
  eq(B.addDaysYmd('2025-03-01', -1), '2025-02-28', 'date arithmetic crosses backwards');
  eq(B.addDaysYmd('2024-02-28', 1), '2024-02-29', 'leap day exists in 2024');
  eq(B.addDaysYmd('nope', 1), null, 'garbage date -> null (never guessed)');
  eq(B.MAD_TO_SD, 1.4826, 'MAD -> SD constant');
  done(before);
}

section('computeBaseline: shape, window and the sample floor');
{
  const before = failures.length;
  const hist = whoopHistory();

  const r = B.computeBaseline(hist, 'restingHr');
  eq(r.ok, true, 'a 20-day history yields a baseline');
  eq(r.metric, 'restingHr', 'metric echoed');
  eq(r.segregatedBy, null, 'resting HR carries no method tag');
  eq(r.mixedMethods, false, 'untagged metrics are never flagged as mixed');
  eq(r.used, 20, 'all 20 days fall inside the default 30-day window');
  eq(r.baseline.n, 20, 'sample size reported');
  eq(r.baseline.center, 56, 'center is the median resting HR');
  eq(r.baseline.median, 56, 'median reported alongside');
  eq(r.baseline.mad, 1, 'MAD reported');
  near(r.baseline.spread, 1.4826, 1e-4, 'spread is 1.4826 x MAD');
  eq(r.baseline.from, d(0), 'window start date');
  eq(r.baseline.to, d(19), 'window end date');
  eq(r.baseline.degenerate, false, 'a varying series is not degenerate');
  eq(r.window.windowDays, B.DEFAULT_WINDOW_DAYS, 'default window is 30 days');
  eq(r.window.minSamples, B.DEFAULT_MIN_SAMPLES, 'default floor is 7 samples');

  // The floor: five nights is not a baseline, and saying so is the whole point.
  const thin = B.computeBaseline(hist.slice(0, 5), 'restingHr');
  eq(thin.baseline, null, 'below the sample floor there is NO baseline');
  eq(thin.ok, false, 'and the result says so');
  eq(thin.reason, 'below_min_samples', 'with a reason the UI can render');
  eq(B.baselineFor(hist.slice(0, 5), 'restingHr'), null, 'baselineFor returns null below the floor');
  eq(B.baselineFor(hist.slice(0, 6), 'restingHr', { minSamples: 5 }) !== null, true,
    'the floor is configurable');
  eq(B.computeBaseline(hist.slice(0, 6), 'restingHr', { minSamples: 20 }).baseline, null,
    'a raised floor is respected');

  // The trailing window really trails.
  const long = [];
  for (let i = 0; i < 40; i += 1) long.push(mk(d(i), { restingHr: RHR_BLOCK[i % 10] }));
  const w = B.computeBaseline(long, 'restingHr');
  eq(w.used, 30, '40 days of history, 30 days of window');
  eq(w.window.from, d(10), 'window starts 29 days before the latest day');
  eq(w.window.to, d(39), 'window ends on the latest day');
  eq(B.computeBaseline(long, 'restingHr', { windowDays: 7 }).used, 7, 'window length is configurable');
  eq(B.computeBaseline(long, 'restingHr', { asOf: d(19) }).window.to, d(19), 'asOf anchors the window');

  // excludeDates — scoring a day against a baseline containing it shrinks its z.
  const ex = B.computeBaseline(hist, 'restingHr', { excludeDates: [d(19)] });
  eq(ex.used, 19, 'excludeDates removes the named day');

  // A constant series has no scale, and admits it rather than inventing one.
  const flat = [];
  for (let i = 0; i < 10; i += 1) flat.push(mk(d(i), { restingHr: 60 }));
  const fb = B.computeBaseline(flat, 'restingHr').baseline;
  eq(fb.center, 60, 'constant series centers correctly');
  eq(fb.spread, 0, 'constant series has no spread');
  eq(fb.degenerate, true, 'and is flagged degenerate');
  eq(B.zScore(70, fb), null, 'no spread -> no z-score, rather than a fake one');
  done(before);
}

section('Robustness: one garbage night must not move the baseline');
{
  const before = failures.length;
  const clean = whoopHistory();
  const dirty = whoopHistory();
  dirty[0].hrvMs = 380; // a strap artefact, still inside the sanity range

  const a = B.computeBaseline(clean, 'hrvMs').baseline;
  const b = B.computeBaseline(dirty, 'hrvMs').baseline;

  eq(a.center, 50, 'clean center');
  eq(b.center, 50, 'one absurd night does not move the robust center at all');
  eq(a.spread, b.spread, 'nor the robust spread');
  assert(Math.abs(b.mean - a.mean) > 10,
    `the plain mean moves ${Math.round(Math.abs(b.mean - a.mean))} points — which is exactly why we do not use it`);
  assert(Math.abs(b.center - a.center) <= 1, 'robust center moves by at most 1 unit');

  // A z-score built on the robust baseline still flags the bad night as extreme.
  const z = B.zScore(380, b);
  assert(z !== null && z >= 3, `the outlier itself still reads as extreme (z=${z})`);
  eq(B.bandFor(z), 'well_above', 'and lands in the outer band');
  done(before);
}

section('SERIES SEGREGATION: sdnn_spot must never mix with rmssd_sleep');
{
  const before = failures.length;

  // Ten WHOOP nights (~50ms overnight RMSSD) then ten Apple days (~95ms SDNN
  // spot checks). Same wrist, same person, two incomparable measurements.
  const days = [];
  for (let i = 0; i < 10; i += 1) {
    days.push(mk(d(i), {
      source: 'whoop', hrvMs: HRV_BLOCK[i], hrvMethod: C.HRV_METHOD.RMSSD_SLEEP
    }));
  }
  for (let i = 0; i < 10; i += 1) {
    days.push(mk(d(10 + i), {
      source: 'apple_health', hrvMs: HRV_BLOCK[i] + 45, hrvMethod: C.HRV_METHOD.SDNN_SPOT
    }));
  }

  const r = B.computeBaseline(days, 'hrvMs');
  eq(r.segregatedBy, 'hrvMethod', 'hrvMs is a tag-segregated metric');
  eq(r.mixedMethods, true, 'two HRV methods in one history are detected');
  eq(r.baseline, null, 'and REFUSED — there is no single honest baseline');
  eq(r.reason, 'mixed_hrvMethod', 'with a machine-readable reason');
  deepEq(r.tags, ['rmssd_sleep', 'sdnn_spot'], 'both series are named');
  assert(r.notes.some((n) => /refusing to merge/.test(n)), 'and the refusal is explained in words');

  // Per-method baselines are still produced, each on its own scale.
  eq(r.series.rmssd_sleep.center, 50, 'the WHOOP series centers on its own median');
  eq(r.series.sdnn_spot.center, 95, 'the Apple series centers on its own median');
  eq(r.series.rmssd_sleep.n, 10, 'WHOOP nights counted separately');
  eq(r.series.sdnn_spot.n, 10, 'Apple readings counted separately');
  // The number a naive implementation would have produced.
  const merged = B.median(days.map((x) => x.hrvMs));
  near(merged, 72.5, 0.001, 'the merged median describes nobody');
  Object.keys(r.series).forEach((tag) => {
    assert(Math.abs(r.series[tag].center - merged) > 15,
      `${tag} baseline is nowhere near the merged value — segregation actually happened`);
  });
  eq(B.baselineFor(days, 'hrvMs'), null, 'baselineFor refuses a mixed history too');

  // Scoring a WHOOP night against the Apple series must be impossible.
  eq(B.zScore(50, r, C.HRV_METHOD.SDNN_SPOT) === B.zScore(50, r, C.HRV_METHOD.RMSSD_SLEEP), false,
    'the two series give different answers for the same number');
  eq(B.bandFor(B.zScore(50, r, C.HRV_METHOD.RMSSD_SLEEP)), 'normal',
    '50ms is a normal WHOOP night for this member');
  eq(B.bandFor(B.zScore(50, r, C.HRV_METHOD.SDNN_SPOT)), 'well_below',
    'the same 50ms read as an Apple SDNN value would look like a collapse — hence the segregation');

  // An untagged reading is quarantined as 'unknown', never absorbed into a
  // tagged series just because it is the only other one present.
  const untagged = [];
  for (let i = 0; i < 10; i += 1) {
    untagged.push(mk(d(i), { hrvMs: HRV_BLOCK[i], hrvMethod: C.HRV_METHOD.RMSSD_SLEEP }));
  }
  for (let i = 0; i < 10; i += 1) {
    untagged.push(mk(d(10 + i), { source: 'generic_csv', hrvMs: HRV_BLOCK[i] })); // hrvMethod null
  }
  const u = B.computeBaseline(untagged, 'hrvMs');
  eq(u.mixedMethods, true, 'an untagged HRV series is not silently adopted');
  assert(u.tags.indexOf(C.HRV_METHOD.UNKNOWN) !== -1, 'untagged readings land in the "unknown" series');
  eq(B.seriesTagOf(mk(d(0), { hrvMs: 50 }), 'hrvMs'), C.HRV_METHOD.UNKNOWN,
    'seriesTagOf defaults to unknown, not to the tag we would prefer');
  done(before);
}

section('SERIES SEGREGATION: tempBasis is segregated the same way');
{
  const before = failures.length;
  const days = [];
  for (let i = 0; i < 10; i += 1) {
    days.push(mk(d(i), {
      source: 'fitbit', skinTempDeviationC: (i % 5) / 10 - 0.2, tempBasis: C.TEMP_BASIS.DEVIATION_C
    }));
  }
  for (let i = 0; i < 10; i += 1) {
    days.push(mk(d(10 + i), {
      source: 'generic_csv', skinTempDeviationC: (i % 5) / 10 - 0.2, tempBasis: C.TEMP_BASIS.UNKNOWN
    }));
  }
  const r = B.computeBaseline(days, 'skinTempDeviationC');
  eq(r.segregatedBy, 'tempBasis', 'temperature is segregated by basis');
  eq(r.mixedMethods, true, 'two temperature bases are detected');
  eq(r.baseline, null, 'and refused');
  eq(r.reason, 'mixed_tempBasis', 'with the matching reason');
  deepEq(r.tags.slice().sort(), ['deviation_c', 'unknown'], 'both bases named');

  eq(B.seriesTagOf(mk(d(0), { skinTempC: 33.4 }), 'skinTempC'), C.TEMP_BASIS.UNKNOWN,
    'an untagged temperature defaults to unknown');
  eq(B.computeBaseline(days.slice(0, 10), 'skinTempDeviationC').mixedMethods, false,
    'a single-basis history is not flagged');
  done(before);
}

section('zScore and bandFor at known inputs');
{
  const before = failures.length;
  const bl = { metric: 'hrvMs', tag: '*', center: 50, spread: 10, n: 30, degenerate: false };

  eq(B.zScore(50, bl), 0, 'value at the center -> z 0');
  eq(B.zScore(60, bl), 1, '+1 spread -> z 1');
  eq(B.zScore(30, bl), -2, '-2 spreads -> z -2');
  eq(B.zScore(75, bl), 2.5, '+2.5 spreads');
  eq(B.zScore(null, bl), null, 'no value -> no z');
  eq(B.zScore(NaN, bl), null, 'NaN -> no z');
  eq(B.zScore('60', bl), null, 'a string is not a measurement');
  eq(B.zScore(60, null), null, 'no baseline -> no z');
  eq(B.zScore(60, {}), null, 'a malformed baseline -> no z (no throw)');
  eq(B.zScore(1e9, bl), 10, 'z is clamped so a broken reading cannot blow up an axis');

  eq(B.bandFor(-3), 'well_below', 'z -3');
  eq(B.bandFor(-2), 'well_below', 'the -2 cut point belongs to well_below');
  eq(B.bandFor(-1.99), 'below', 'just inside -2');
  eq(B.bandFor(-1), 'below', 'the -1 cut point belongs to below');
  eq(B.bandFor(-0.999), 'normal', 'just inside -1');
  eq(B.bandFor(0), 'normal', 'dead on baseline');
  eq(B.bandFor(0.999), 'normal', 'just inside +1');
  eq(B.bandFor(1), 'above', 'the +1 cut point belongs to above');
  eq(B.bandFor(1.999), 'above', 'just inside +2');
  eq(B.bandFor(2), 'well_above', 'the +2 cut point belongs to well_above');
  eq(B.bandFor(null), null, 'no z -> no band');
  eq(B.bandFor(NaN), null, 'NaN -> no band');
  eq(B.bandFor('2'), null, 'a string is not a z-score');
  B.BANDS.forEach((b) => assert(typeof b === 'string', 'band vocabulary is strings'));

  deepEq(B.deviation(30, bl), { z: -2, band: 'well_below' }, 'deviation() combines both');
  deepEq(B.deviation(null, bl), { z: null, band: null }, 'deviation() is null-safe');

  // Tag matching: a baseline built for one method refuses another.
  const tagged = { metric: 'hrvMs', tag: 'rmssd_sleep', center: 50, spread: 10, n: 30, degenerate: false };
  eq(B.zScore(60, tagged, 'rmssd_sleep'), 1, 'matching tag scores');
  eq(B.zScore(60, tagged, 'sdnn_spot'), null, 'mismatched tag refuses to score');
  done(before);
}

section('normalizedReadiness');
{
  const before = failures.length;
  const hist = whoopHistory();
  const metrics = ['hrvMs', 'restingHr', 'sleepMinutes', 'sleepEfficiencyPct', 'respiratoryRate', 'skinTempDeviationC'];
  const bl = B.computeBaselines(hist, metrics, { asOf: d(19) });
  eq(Object.keys(bl).length, metrics.length, 'computeBaselines returns one result per metric');
  eq(bl.respiratoryRate.baseline, null, 'a metric absent from the history has no baseline');

  // A day sitting exactly on every baseline.
  const onBaseline = mk(d(20), {
    source: 'whoop',
    hrvMs: bl.hrvMs.baseline.center,
    hrvMethod: C.HRV_METHOD.RMSSD_SLEEP,
    restingHr: bl.restingHr.baseline.center,
    sleepMinutes: bl.sleepMinutes.baseline.center,
    sleepEfficiencyPct: bl.sleepEfficiencyPct.baseline.center
  });
  const r = B.normalizedReadiness(onBaseline, bl);
  eq(r.score, B.BASELINE_SCORE, 'a day exactly on baseline scores BASELINE_SCORE, not 100');
  eq(r.availableWeight, 84, 'four of six components had evidence (30+22+20+12)');
  eq(r.components.filter((c) => c.available).length, 4, 'four available components');
  eq(r.components.filter((c) => !c.available).length, 2, 'two components correctly reported as missing');
  assert(r.confidence > 0 && r.confidence <= 0.95, `confidence is 0..0.95 (got ${r.confidence})`);
  eq(r.reason, null, 'no failure reason on a good day');
  const hrvComp = r.components.find((c) => c.key === 'hrv');
  eq(hrvComp.z, 0, 'HRV z is 0 on baseline');
  eq(hrvComp.band, 'normal', 'and bands as normal');
  eq(hrvComp.tag, C.HRV_METHOD.RMSSD_SLEEP, 'the component records which series it used');

  // Direction: higher HRV is better, higher resting HR is worse.
  const goodHrv = Object.assign({}, onBaseline, { hrvMs: bl.hrvMs.baseline.center + 2 * bl.hrvMs.baseline.spread });
  assert(B.normalizedReadiness(goodHrv, bl).score > r.score, 'a high-HRV day scores better');
  const badRhr = Object.assign({}, onBaseline, { restingHr: bl.restingHr.baseline.center + 2 * bl.restingHr.baseline.spread });
  assert(B.normalizedReadiness(badRhr, bl).score < r.score, 'an elevated resting heart rate scores worse');
  const lowRhr = Object.assign({}, onBaseline, { restingHr: bl.restingHr.baseline.center - 2 * bl.restingHr.baseline.spread });
  assert(B.normalizedReadiness(lowRhr, bl).score > r.score, 'a low resting heart rate scores better');
  const shortSleep = Object.assign({}, onBaseline, { sleepMinutes: bl.sleepMinutes.baseline.center - 2 * bl.sleepMinutes.baseline.spread });
  assert(B.normalizedReadiness(shortSleep, bl).score < r.score, 'a short night scores worse');

  // zToScore directly — the shape of the curve is a documented promise.
  eq(B.zToScore(0, 'higher'), B.BASELINE_SCORE, 'z 0 -> baseline score');
  eq(B.zToScore(1, 'higher'), B.BASELINE_SCORE + B.POINTS_PER_SD, '+1 SD -> +15');
  eq(B.zToScore(-1, 'higher'), B.BASELINE_SCORE - B.POINTS_PER_SD, '-1 SD -> -15');
  eq(B.zToScore(1, 'lower'), B.BASELINE_SCORE - B.POINTS_PER_SD, 'inverted direction flips the sign');
  eq(B.zToScore(0, 'stable'), 80, 'a stable metric peaks on baseline');
  eq(B.zToScore(2, 'stable'), 50, 'a stable metric is penalised in either direction');
  eq(B.zToScore(-2, 'stable'), 50, 'symmetrically');
  eq(B.zToScore(9, 'higher'), B.zToScore(3, 'higher'), 'the score saturates past +/-3 SD');
  eq(B.zToScore(null, 'higher'), null, 'no z -> no component score');
  eq(B.zToScore(3, 'higher', 1.5), B.zToScore(1.5, 'higher'), 'a per-component cap saturates earlier');

  // Starvation: never a score from one weak input.
  const onlyHrv = mk(d(21), { hrvMs: 50, hrvMethod: C.HRV_METHOD.RMSSD_SLEEP });
  const starved = B.normalizedReadiness(onlyHrv, bl);
  eq(starved.score, null, 'one component (weight 30) is NOT enough for a readiness score');
  eq(starved.reason, 'insufficient_inputs', 'and the reason says so');
  eq(starved.confidence, 0, 'no score -> no confidence');
  eq(starved.availableWeight, 30, 'available weight reported for the UI');

  eq(B.normalizedReadiness(mk(d(21), {}), bl).score, null, 'an empty day scores nothing');
  eq(B.normalizedReadiness(null, bl).score, null, 'no day at all -> null (no throw)');
  eq(B.normalizedReadiness(null, bl).reason, 'no_day', 'with a reason');
  eq(B.normalizedReadiness(onBaseline, null).score, null, 'no baselines -> no score');
  eq(B.normalizedReadiness(onBaseline, {}).score, null, 'empty baselines -> no score');

  // Two components at exactly the 40-weight gate: hrv (30) + sleep_quality (12).
  const twoComp = mk(d(21), {
    hrvMs: bl.hrvMs.baseline.center,
    hrvMethod: C.HRV_METHOD.RMSSD_SLEEP,
    sleepEfficiencyPct: bl.sleepEfficiencyPct.baseline.center
  });
  const tc = B.normalizedReadiness(twoComp, bl);
  eq(tc.availableWeight, 42, 'weight 42 clears the 40 gate');
  eq(tc.score, B.BASELINE_SCORE, 'and produces a score');

  // deviceCaps: reports what the device COULD have supplied, never suppresses
  // a value that is actually present.
  const registry = require('../services/wearables/deviceRegistry');
  const caps = registry.getDevice('samsung_health').capabilities;
  const withCaps = B.normalizedReadiness(onBaseline, bl, caps);
  eq(withCaps.score, r.score, 'device capabilities never change a score built from real values');
  assert(withCaps.expectedWeight !== null && withCaps.expectedWeight < 100,
    `Samsung cannot supply the whole formula (expectedWeight ${withCaps.expectedWeight})`);
  assert(withCaps.expectedWeight < B.normalizedReadiness(onBaseline, bl, registry.getDevice('whoop').capabilities).expectedWeight,
    'a WHOOP could supply more of the formula than a Samsung band');
  done(before);
}

section('Device switch: an Apple day must not be scored against a WHOOP baseline');
{
  const before = failures.length;
  const hist = whoopHistory(); // all rmssd_sleep
  const bl = B.computeBaselines(hist,
    ['hrvMs', 'restingHr', 'sleepMinutes', 'sleepEfficiencyPct'], { asOf: d(19) });

  // The member sells the WHOOP and starts wearing an Apple Watch. Same body, but
  // SDNN spot checks read far higher than overnight RMSSD.
  const appleDay = mk(d(20), {
    source: 'apple_health',
    hrvMs: 95,
    hrvMethod: C.HRV_METHOD.SDNN_SPOT,
    restingHr: bl.restingHr.baseline.center,
    sleepMinutes: bl.sleepMinutes.baseline.center,
    sleepEfficiencyPct: bl.sleepEfficiencyPct.baseline.center
  });
  const r = B.normalizedReadiness(appleDay, bl);
  const hrv = r.components.find((c) => c.key === 'hrv');
  eq(hrv.available, false, 'the HRV component is DROPPED, not scored against the wrong series');
  eq(hrv.z, null, 'no z-score is produced for an incomparable reading');
  assert(r.notes.some((n) => /sdnn_spot/.test(n) && /not comparable/.test(n)),
    'and the member-facing reason is recorded');
  eq(r.availableWeight, 54, 'the remaining components carry the score (22+20+12)');
  eq(r.score, B.BASELINE_SCORE, 'the switch does not manufacture a cliff or a spike');

  // Sanity: had we merged the series, the same day would have been scored — badly.
  const naive = B.zScore(95, bl.hrvMs.baseline); // no tag passed = no guard
  assert(naive !== null && naive > 10 - 0.001, `an unguarded z would have been off the scale (${naive})`);
  done(before);
}

section('Never throws, never invents');
{
  const before = failures.length;
  const junk = [
    undefined, null, 42, 'days', {}, [],
    [null], [undefined], [{}], [{ date: 'nope', hrvMs: 50 }],
    [{ date: '2025-01-01', hrvMs: 'fifty' }],
    [{ date: '2025-01-01', hrvMs: NaN }],
    [{ date: '2025-01-01' }]
  ];
  junk.forEach((input, i) => {
    let r = null;
    let threw = null;
    try { r = B.computeBaseline(input, 'hrvMs'); } catch (e) { threw = e; }
    assert(threw === null, `computeBaseline does not throw on junk #${i}: ${threw && threw.message}`);
    assert(r && typeof r === 'object', `computeBaseline always returns a result object (#${i})`);
    assert(r && r.baseline === null, `and never invents a baseline from junk (#${i})`);
  });

  eq(B.computeBaseline(whoopHistory(), 'notAMetric').reason, 'unknown_metric', 'an unknown metric is named');
  eq(B.computeBaseline(whoopHistory(), null).reason, 'unknown_metric', 'a null metric is rejected');
  eq(B.computeBaseline([], 'hrvMs').reason, 'no_days', 'an empty history is reported as such');
  eq(B.computeBaseline(whoopHistory(), 'spo2').reason, 'no_values', 'a metric with no readings is reported as such');
  eq(B.computeBaseline(whoopHistory(), 'hrvMs', { asOf: '2030-01-01' }).reason, 'no_values_in_window',
    'a window containing nothing is reported as such');
  deepEq(B.computeBaselines(null, null), {}, 'computeBaselines is null-safe');

  // Zero is a legitimate reading and must survive; null must not become zero.
  const zeros = [];
  for (let i = 0; i < 10; i += 1) zeros.push(mk(d(i), { napMinutes: i < 5 ? 0 : 30 }));
  const nb = B.computeBaseline(zeros, 'napMinutes').baseline;
  eq(nb.n, 10, 'explicit zeros are counted, not skipped');
  eq(nb.min, 0, 'and kept as zeros');

  const nulls = [];
  for (let i = 0; i < 10; i += 1) nulls.push(mk(d(i), { hrvMs: i < 5 ? null : 50 }));
  eq(B.computeBaseline(nulls, 'hrvMs', { minSamples: 5 }).baseline.n, 5,
    'nulls are missing data, never zeros in the sample');
  done(before);
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.log('\n--- FAILURES ---');
  failures.forEach((f) => console.log(' ', f));
  console.log(`\n${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`\n--- All ${checks} baseline engine checks passed ---`);
