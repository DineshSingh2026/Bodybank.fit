'use strict';

/**
 * Personal baselines — the piece that makes cross-device comparison honest.
 *
 * An absolute threshold means nothing across devices or people. "HRV 45ms" is
 * excellent for one member and a warning sign for another, and the same wrist on
 * an Apple Watch would read 70 for no physiological reason at all. What IS
 * comparable is a member's deviation from their OWN recent history, measured in
 * their own units. That is all this module computes.
 *
 * Everything here is a pure function. No DB, no I/O, no clock — it receives an
 * array of canonical days (canonicalDay.emptyCanonicalDay shape) and returns
 * numbers. The orchestrator wires it to readiness_daily.
 *
 * ── The three rules ─────────────────────────────────────────────────────────
 *  1. NEVER mix method tags. An `hrvMs` series is segregated by `hrvMethod` and a
 *     temperature series by `tempBasis`. Apple's SDNN spot check and WHOOP's
 *     overnight RMSSD are different measurements of different things; averaging
 *     them produces a baseline that describes nobody, and a member who switches
 *     devices sees a cliff that never happened. When more than one tag is present
 *     we split, flag, and refuse to name a single baseline.
 *  2. ROBUST, not fragile. Center is the median and spread is 1.4826 x MAD, not
 *     mean and SD. One garbage night — a strap that fell off, a 4-minute "sleep",
 *     an OCR misread of 450 for 45 — moves a mean immediately and a median almost
 *     not at all (the MAD has a 50% breakdown point: up to half the window can be
 *     rubbish before the estimate moves). The plain mean/SD are still reported
 *     alongside, because a large gap between the two is itself a data-quality
 *     signal worth surfacing.
 *  3. NEVER invent a number. Below the sample floor there is no baseline, so we
 *     return null rather than a confident-looking figure computed from four days.
 *     A z-score against a fragile baseline is worse than no z-score, because it
 *     gets rendered as a coloured band and believed.
 *
 * @module services/wearables/baselineService
 */

const { METRIC_FIELDS, HRV_METHOD, TEMP_BASIS } = require('./canonicalDay');

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Trailing window, in days, when the caller does not say. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Fewer usable readings than this and we return null. Seven is not arbitrary: a
 * MAD needs enough points that a single value is not a large share of the sample,
 * and a week also spans the weekday/weekend rhythm that dominates sleep timing.
 */
const DEFAULT_MIN_SAMPLES = 7;

/**
 * MAD -> SD for Gaussian data. 1 / Phi^-1(0.75) = 1.4826. Applying it makes the
 * robust spread numerically comparable with a standard deviation, so a z-score
 * built on it keeps its familiar meaning (~68% within +/-1, ~95% within +/-2).
 */
const MAD_TO_SD = 1.4826;

/**
 * A spread at or below this is treated as no spread at all. Dividing by it would
 * turn a rounding difference into a z-score of 40.
 */
const MIN_SPREAD = 1e-9;

/**
 * Which canonical metrics carry a method tag, and which day field holds it.
 * Rule 1 is enforced from this table — adding a tagged metric means adding it
 * here, not scattering conditionals through the code.
 */
const METRIC_SERIES_TAG = {
  hrvMs: 'hrvMethod',
  skinTempC: 'tempBasis',
  skinTempDeviationC: 'tempBasis'
};

/** Tag used for an untagged metric, so every series is keyed the same way. */
const UNTAGGED = '*';

/**
 * Band cut points, in robust SDs from the member's own center. Under a roughly
 * normal spread these put ~68% of days in `normal`, ~27% in below/above and ~5%
 * in the two outer bands — so `well_below` genuinely means "this is unusual for
 * you", roughly one day a month, and keeps its weight when we say it.
 */
const BAND_CUTS = { wellBelow: -2, below: -1, above: 1, wellAbove: 2 };
const BANDS = ['well_below', 'below', 'normal', 'above', 'well_above'];

/* ------------------------------------------------------------------ *
 * Small helpers — every one null-safe
 * ------------------------------------------------------------------ */

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isYmd(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function round(n, dp) {
  if (!isFiniteNum(n)) return null;
  const f = Math.pow(10, dp == null ? 3 : dp);
  return Math.round(n * f) / f;
}

function clamp(n, lo, hi) {
  if (!isFiniteNum(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Shift a YYYY-MM-DD by whole days. Pure UTC arithmetic — no timezone, because
 * the dates arriving here were already attributed in the member's timezone by the
 * adapter (canonicalDay rule 2) and must not be re-interpreted.
 *
 * @param {string} ymd
 * @param {number} delta
 * @returns {string|null}
 */
function addDaysYmd(ymd, delta) {
  if (!isYmd(ymd) || !isFiniteNum(delta)) return null;
  const parts = ymd.split('-');
  const t = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + Math.round(delta) * 86400000);
  if (!Number.isFinite(d.getTime())) return null;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + mm + '-' + dd;
}

/** Median of a numeric array. Mutates nothing. @returns {number|null} */
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (n-1). @returns {number|null} */
function stdDev(values, mean) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const m = isFiniteNum(mean) ? mean : values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((a, v) => a + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

/** Median absolute deviation about the median. @returns {number|null} */
function mad(values, center) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const c = isFiniteNum(center) ? center : median(values);
  if (!isFiniteNum(c)) return null;
  return median(values.map((v) => Math.abs(v - c)));
}

/**
 * Read the method tag a day carries for a metric, defaulting to the contract's
 * explicit 'unknown' rather than to the tag we would like it to have. An untagged
 * HRV number lands in its own 'unknown' series and never contaminates a tagged
 * one — which is the entire point of rule 1.
 *
 * @param {Object} day
 * @param {string} metric
 * @returns {string} the tag, or UNTAGGED for a metric that carries none
 */
function seriesTagOf(day, metric) {
  const field = METRIC_SERIES_TAG[metric];
  if (!field) return UNTAGGED;
  const v = day && day[field];
  if (typeof v === 'string' && v) return v;
  return field === 'hrvMethod' ? HRV_METHOD.UNKNOWN : TEMP_BASIS.UNKNOWN;
}

/* ------------------------------------------------------------------ *
 * computeBaseline
 * ------------------------------------------------------------------ */

/**
 * Build one baseline object from an already-segregated set of samples.
 *
 * @param {{value:number, date:string}[]} samples
 * @param {string} metric
 * @param {string} tag
 * @param {{windowDays:number, minSamples:number, from:string|null, to:string|null}} win
 * @returns {Object|null}
 */
function buildBaseline(samples, metric, tag, win) {
  if (!samples || samples.length < win.minSamples) return null;

  const values = samples.map((s) => s.value);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = stdDev(values, mean);
  const med = median(values);
  const madv = mad(values, med);
  let robustSd = isFiniteNum(madv) ? madv * MAD_TO_SD : null;

  // A MAD of 0 means over half the window holds the identical value — common for
  // integer metrics like resting HR on a steady member. The MAD is then correct
  // but useless as a scale, so we fall back to the sample SD before giving up.
  let spreadFrom = 'mad';
  if (!isFiniteNum(robustSd) || robustSd <= MIN_SPREAD) {
    if (isFiniteNum(sd) && sd > MIN_SPREAD) { robustSd = sd; spreadFrom = 'sd_fallback'; }
    else { robustSd = 0; spreadFrom = 'degenerate'; }
  }

  const dates = samples.map((s) => s.date).filter(isYmd).sort();

  return {
    metric: metric,
    tag: tag,
    n: n,
    center: round(med, 4), // what zScore standardises against
    spread: round(robustSd, 4),
    spreadFrom: spreadFrom,
    median: round(med, 4),
    mad: round(madv, 4),
    robustSd: round(robustSd, 4),
    mean: round(mean, 4),
    sd: round(sd, 4),
    min: round(Math.min.apply(null, values), 4),
    max: round(Math.max.apply(null, values), 4),
    windowDays: win.windowDays,
    minSamples: win.minSamples,
    from: dates.length ? dates[0] : null,
    to: dates.length ? dates[dates.length - 1] : null,
    // True when the series has no usable scale: z-scores are refused, not faked.
    degenerate: spreadFrom === 'degenerate'
  };
}

/**
 * Rolling robust baseline for one canonical metric.
 *
 * ALWAYS returns a result object — never null, never throws, whatever it is fed.
 * `.baseline` is the single unambiguous baseline, and is null when there is not
 * enough data OR when the input mixes method tags (see rule 1). `.series` always
 * holds the per-tag baselines, so a caller that knows which series it wants can
 * take it from there. Use `baselineFor()` when you just want "the baseline or
 * null" for a single-device history.
 *
 * @param {Object[]} days canonical days, any order, may contain junk
 * @param {string} metric a canonicalDay.METRIC_FIELDS entry
 * @param {Object} [opts]
 * @param {number} [opts.windowDays=30] trailing window length, inclusive of asOf
 * @param {number} [opts.minSamples=7] floor below which no baseline is returned
 * @param {string} [opts.asOf] YYYY-MM-DD anchor; defaults to the latest date present
 * @param {string[]} [opts.excludeDates] dates to leave out — pass the day being
 *        scored so it is not compared against a baseline that contains it
 * @returns {{ok:boolean, metric:string, baseline:Object|null, series:Object,
 *            tags:string[], mixedMethods:boolean, segregatedBy:string|null,
 *            reason:string|null, window:Object, considered:number, used:number,
 *            notes:string[]}}
 */
function computeBaseline(days, metric, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const windowDays = (isFiniteNum(o.windowDays) && o.windowDays >= 1)
    ? Math.floor(o.windowDays) : DEFAULT_WINDOW_DAYS;
  const minSamples = (isFiniteNum(o.minSamples) && o.minSamples >= 1)
    ? Math.floor(o.minSamples) : DEFAULT_MIN_SAMPLES;

  const result = {
    ok: false,
    metric: typeof metric === 'string' ? metric : null,
    baseline: null,
    series: {},
    tags: [],
    mixedMethods: false,
    segregatedBy: METRIC_SERIES_TAG[metric] || null,
    reason: null,
    window: { windowDays: windowDays, minSamples: minSamples, asOf: null, from: null, to: null },
    considered: 0,
    used: 0,
    notes: []
  };

  if (typeof metric !== 'string' || METRIC_FIELDS.indexOf(metric) === -1) {
    result.reason = 'unknown_metric';
    result.notes.push('"' + String(metric) + '" is not a canonical metric field');
    return result;
  }
  if (!Array.isArray(days) || days.length === 0) {
    result.reason = 'no_days';
    return result;
  }

  const exclude = Array.isArray(o.excludeDates)
    ? new Set(o.excludeDates.filter(isYmd))
    : new Set();

  // Keep only rows that are usable for THIS metric: a real date and a finite
  // value. A null is missing data, not a zero, and never enters the sample.
  const usable = [];
  days.forEach((d) => {
    if (!d || typeof d !== 'object') return;
    if (!isYmd(d.date)) return;
    result.considered += 1;
    const v = d[metric];
    if (!isFiniteNum(v)) return;
    if (exclude.has(d.date)) return;
    usable.push({ date: d.date, value: v, tag: seriesTagOf(d, metric) });
  });

  if (usable.length === 0) {
    result.reason = 'no_values';
    return result;
  }

  // Anchor the window on the caller's asOf, else on the latest date we hold.
  const latest = usable.reduce((a, s) => (a === null || s.date > a ? s.date : a), null);
  const asOf = isYmd(o.asOf) ? o.asOf : latest;
  const from = addDaysYmd(asOf, -(windowDays - 1));
  result.window.asOf = asOf;
  result.window.from = from;
  result.window.to = asOf;
  if (!from) {
    result.reason = 'bad_window';
    return result;
  }

  const inWindow = usable.filter((s) => s.date >= from && s.date <= asOf);
  if (inWindow.length === 0) {
    result.reason = 'no_values_in_window';
    return result;
  }
  result.used = inWindow.length;

  // ── Rule 1: segregate before computing anything ──
  const byTag = new Map();
  inWindow.forEach((s) => {
    if (!byTag.has(s.tag)) byTag.set(s.tag, []);
    byTag.get(s.tag).push(s);
  });
  const tags = Array.from(byTag.keys()).sort();
  result.tags = tags;
  result.mixedMethods = result.segregatedBy !== null && tags.length > 1;

  const win = { windowDays: windowDays, minSamples: minSamples, from: from, to: asOf };
  tags.forEach((tag) => {
    const b = buildBaseline(byTag.get(tag), metric, tag, win);
    if (b) result.series[tag] = b;
  });

  if (result.mixedMethods) {
    // Deliberately no `baseline`. There is no single honest answer: the caller
    // must pick the series matching the day it is scoring, or tell the member the
    // history spans two different measurements.
    result.reason = 'mixed_' + result.segregatedBy;
    result.notes.push(
      'refusing to merge ' + tags.length + ' ' + result.segregatedBy + ' series (' + tags.join(', ')
      + ') into one ' + metric + ' baseline — they are not the same measurement'
    );
    result.ok = Object.keys(result.series).length > 0;
    return result;
  }

  const only = tags[0];
  const b = result.series[only] || null;
  if (!b) {
    result.reason = 'below_min_samples';
    result.notes.push(
      byTag.get(only).length + ' usable readings in the window, ' + minSamples + ' required'
    );
    return result;
  }

  result.baseline = b;
  result.ok = true;
  if (b.degenerate) {
    result.notes.push('every reading in the window is effectively identical — no spread to standardise against');
  }
  return result;
}

/**
 * Convenience wrapper: the baseline object, or null. Returns null for a mixed
 * series too — if you might be looking at two devices, call computeBaseline and
 * handle `.series` explicitly.
 *
 * @param {Object[]} days
 * @param {string} metric
 * @param {Object} [opts]
 * @returns {Object|null}
 */
function baselineFor(days, metric, opts) {
  const r = computeBaseline(days, metric, opts);
  return r && r.baseline ? r.baseline : null;
}

/**
 * Baselines for many metrics at once, keyed by metric. Values are computeBaseline
 * results, which normalizedReadiness accepts directly.
 *
 * @param {Object[]} days
 * @param {string[]} metrics
 * @param {Object} [opts]
 * @returns {Object<string,Object>}
 */
function computeBaselines(days, metrics, opts) {
  const out = {};
  if (!Array.isArray(metrics)) return out;
  metrics.forEach((m) => {
    if (typeof m === 'string') out[m] = computeBaseline(days, m, opts);
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * z-scores and bands
 * ------------------------------------------------------------------ */

/**
 * Accept either a baseline object or a computeBaseline result, optionally pinned
 * to a method tag. Returns null when the requested series does not exist — which
 * is what stops a Whoop day being scored against an Apple baseline.
 *
 * @param {Object} entry
 * @param {string} [tag]
 * @returns {Object|null}
 */
function resolveBaseline(entry, tag) {
  if (!entry || typeof entry !== 'object') return null;
  // A computeBaseline result.
  if (entry.series && typeof entry.series === 'object' && Object.prototype.hasOwnProperty.call(entry, 'baseline')) {
    if (typeof tag === 'string' && tag) {
      if (Object.prototype.hasOwnProperty.call(entry.series, tag)) return entry.series[tag];
      // The day's tag is not in this history at all — refuse, do not fall back.
      if (entry.mixedMethods) return null;
      const single = entry.baseline;
      if (single && single.tag === UNTAGGED) return single;
      if (single && single.tag === tag) return single;
      return null;
    }
    return entry.baseline;
  }
  // A bare baseline object.
  if (isFiniteNum(entry.center) && isFiniteNum(entry.spread)) {
    if (typeof tag === 'string' && tag && entry.tag && entry.tag !== UNTAGGED && entry.tag !== tag) return null;
    return entry;
  }
  return null;
}

/**
 * Standardised deviation from the member's own baseline, in robust SDs.
 *
 *   z = (value - center) / spread,   center = median, spread = 1.4826 x MAD
 *
 * Returns null — never 0, never a guess — when the value is missing, the baseline
 * is absent, or the series has no spread to standardise against. z is clamped to
 * +/-10 so a genuinely broken reading cannot produce an infinity that propagates
 * into a chart axis.
 *
 * @param {number} value
 * @param {Object} baseline a baseline object or a computeBaseline result
 * @param {string} [tag] the day's method tag, checked against the baseline's
 * @returns {number|null} rounded to 3 decimals
 */
function zScore(value, baseline, tag) {
  if (!isFiniteNum(value)) return null;
  const b = resolveBaseline(baseline, tag);
  if (!b) return null;
  if (!isFiniteNum(b.center) || !isFiniteNum(b.spread) || b.spread <= MIN_SPREAD) return null;
  const z = (value - b.center) / b.spread;
  if (!Number.isFinite(z)) return null;
  return round(clamp(z, -10, 10), 3);
}

/**
 * Map a z-score to the small vocabulary the member actually sees.
 *
 *   z <= -2      well_below
 *   -2 <  z <= -1  below
 *   -1 <  z <  1   normal
 *    1 <= z <  2   above
 *    z >= 2       well_above
 *
 * The cut points are deliberately at whole robust SDs so the words keep a stable
 * meaning as a member's variability changes: `well_above` is always "about a
 * one-in-twenty day for you", not "above some number we picked".
 *
 * Note this is direction-neutral: a `well_above` resting heart rate is bad news
 * and a `well_above` HRV is good news. Interpretation belongs to the caller, not
 * to the band.
 *
 * @param {number} z
 * @returns {string|null} a BANDS member, or null for a null/invalid z
 */
function bandFor(z) {
  if (!isFiniteNum(z)) return null;
  if (z <= BAND_CUTS.wellBelow) return 'well_below';
  if (z <= BAND_CUTS.below) return 'below';
  if (z >= BAND_CUTS.wellAbove) return 'well_above';
  if (z >= BAND_CUTS.above) return 'above';
  return 'normal';
}

/**
 * Value -> {z, band} in one step, tag-safe.
 *
 * @param {number} value
 * @param {Object} baseline
 * @param {string} [tag]
 * @returns {{z:number|null, band:string|null}}
 */
function deviation(value, baseline, tag) {
  const z = zScore(value, baseline, tag);
  return { z: z, band: bandFor(z) };
}

/* ------------------------------------------------------------------ *
 * BodyBank Readiness — normalised, device-agnostic
 * ------------------------------------------------------------------ */

/**
 * Components of the normalised score. Weights sum to 100.
 *
 * Every component is a DEVIATION, never an absolute, so the same formula works on
 * a WHOOP, an Apple Watch or a typed-in number: we ask "how is this member today
 * versus this member's own recent normal", which is the only question all devices
 * can answer on the same scale.
 *
 *   direction 'higher'  — more is better (HRV, sleep duration, sleep quality)
 *   direction 'lower'   — less is better (resting heart rate)
 *   direction 'stable'  — any movement in either direction is a warning
 *                          (respiratory rate, skin temperature)
 *
 * `metrics` is an ordered candidate list: the first canonical field with both a
 * value on the day and a usable baseline wins.
 */
const READINESS_COMPONENTS = [
  { key: 'hrv', label: 'HRV', weight: 30, direction: 'higher', metrics: ['hrvMs'] },
  { key: 'resting_hr', label: 'Resting heart rate', weight: 22, direction: 'lower', metrics: ['restingHr'] },
  {
    key: 'sleep_duration',
    label: 'Sleep duration',
    weight: 20,
    direction: 'higher',
    // Oversleeping is not proportionally better than sleeping well, so the upside
    // saturates at +1.5 SD instead of rewarding a 12-hour night as elite recovery.
    zCapHigh: 1.5,
    metrics: ['sleepMinutes']
  },
  { key: 'sleep_quality', label: 'Sleep quality', weight: 12, direction: 'higher', metrics: ['sleepEfficiencyPct', 'sleepPerformancePct'] },
  { key: 'respiratory_rate', label: 'Respiratory rate', weight: 8, direction: 'stable', metrics: ['respiratoryRate'] },
  { key: 'skin_temp', label: 'Skin temperature', weight: 8, direction: 'stable', metrics: ['skinTempDeviationC', 'skinTempC'] }
];

/**
 * A day sitting exactly on the member's baseline scores this, not 100. Baseline
 * is "your normal", which deserves a solid-but-not-perfect number: it leaves
 * headroom for a genuinely good day and keeps a bad day visibly low.
 */
const BASELINE_SCORE = 65;
/** Points per robust SD of deviation. +/-2 SD spans roughly 35..95. */
const POINTS_PER_SD = 15;
/** Beyond this many SDs the score stops moving — past here it is noise, not signal. */
const Z_CLAMP = 3;
/** A 'stable' component scores this when dead on baseline, losing POINTS_PER_SD per SD either way. */
const STABLE_PEAK_SCORE = 80;

/** Mirrors readinessService's DERIVED_MIN_* discipline: refuse a thin score. */
const MIN_AVAILABLE_WEIGHT = 40;
const MIN_COMPONENTS = 2;

/**
 * Turn a z-score into a 0..100 component score.
 *
 * @param {number} z
 * @param {string} direction 'higher' | 'lower' | 'stable'
 * @param {number} [zCapHigh] optional saturation point on the favourable side
 * @returns {number|null}
 */
function zToScore(z, direction, zCapHigh) {
  if (!isFiniteNum(z)) return null;
  let zz = clamp(z, -Z_CLAMP, Z_CLAMP);
  if (zz == null) return null;
  if (direction === 'stable') {
    return Math.round(clamp(STABLE_PEAK_SCORE - POINTS_PER_SD * Math.abs(zz), 0, 100));
  }
  if (direction === 'lower') zz = -zz;
  if (isFiniteNum(zCapHigh) && zz > zCapHigh) zz = zCapHigh;
  return Math.round(clamp(BASELINE_SCORE + POINTS_PER_SD * zz, 0, 100));
}

/**
 * Read a component's value off a canonical day, tolerating the sleepHours /
 * sleepMinutes duality that the contract allows.
 *
 * @param {Object} day
 * @param {string} metric
 * @returns {number|null}
 */
function valueOf(day, metric) {
  if (!day || typeof day !== 'object') return null;
  const v = day[metric];
  if (isFiniteNum(v)) return v;
  if (metric === 'sleepMinutes' && isFiniteNum(day.sleepHours)) return day.sleepHours * 60;
  if (metric === 'sleepHours' && isFiniteNum(day.sleepMinutes)) return day.sleepMinutes / 60;
  return null;
}

/**
 * BodyBank Readiness: one 0..100 number computed from whatever this member's
 * device actually gave us on this day, expressed entirely as deviation from their
 * own baselines.
 *
 * The score is the weighted mean of the components that had BOTH a value and a
 * usable, tag-matched baseline, rescaled to the weight that actually had
 * evidence. Below MIN_AVAILABLE_WEIGHT (40) or MIN_COMPONENTS (2) it returns
 * `score:null` — the same discipline as readinessService.computeDerivedReadiness.
 * A "readiness score" built from one weak input is a fabricated number wearing a
 * percentage sign, and it is worse than showing nothing.
 *
 * A component is silently DROPPED, never guessed, when:
 *   - the day has no value for it;
 *   - there is no baseline yet (a new member: correct answer is "not yet");
 *   - the baseline is degenerate (no spread to standardise against);
 *   - the day's method tag does not match the baseline's series. This is the
 *     switching-devices guard: an Apple SDNN day scored against a WHOOP RMSSD
 *     baseline would read as a catastrophic collapse, so we drop HRV entirely and
 *     let the remaining components carry the score.
 *
 * @param {Object} day a canonical day
 * @param {Object<string,Object>} baselines metric -> baseline object or
 *        computeBaseline result (as produced by computeBaselines)
 * @param {Object<string,string>|null} [deviceCaps] a deviceRegistry
 *        `capabilities` map. Used only to report how much of what this device
 *        COULD supply we actually got — it never suppresses a value that is
 *        present, because a real number always beats a table's expectation.
 * @returns {{score:number|null, components:Object[], availableWeight:number,
 *            expectedWeight:number|null, confidence:number, reason:string|null,
 *            notes:string[]}}
 */
function normalizedReadiness(day, baselines, deviceCaps) {
  const out = {
    score: null,
    components: [],
    availableWeight: 0,
    expectedWeight: null,
    confidence: 0,
    reason: null,
    notes: []
  };

  if (!day || typeof day !== 'object') {
    out.reason = 'no_day';
    return out;
  }
  const bl = baselines && typeof baselines === 'object' ? baselines : {};
  const capsMap = deviceCaps && typeof deviceCaps === 'object' ? deviceCaps : null;
  let expectedWeight = capsMap ? 0 : null;

  READINESS_COMPONENTS.forEach((spec) => {
    if (capsMap) {
      const capable = spec.metrics.some((m) => capsMap[m] && capsMap[m] !== 'none');
      if (capable) expectedWeight += spec.weight;
    }

    let chosen = null;
    for (let i = 0; i < spec.metrics.length && !chosen; i += 1) {
      const metric = spec.metrics[i];
      const value = valueOf(day, metric);
      if (value === null) continue;
      const tag = METRIC_SERIES_TAG[metric] ? seriesTagOf(day, metric) : undefined;
      const b = resolveBaseline(bl[metric], tag);
      if (!b) {
        // Distinguish "no history" from "wrong series" — the second is worth
        // saying out loud, because it is the device switch we exist to survive.
        if (bl[metric] && tag) {
          out.notes.push(spec.key + ': skipped — no ' + tag + ' baseline for ' + metric
            + ' (this reading is not comparable with the stored history)');
        }
        continue;
      }
      if (b.degenerate) continue;
      const z = zScore(value, b, tag);
      if (z === null) continue;
      chosen = {
        key: spec.key,
        label: spec.label,
        weight: spec.weight,
        metric: metric,
        value: round(value, 3),
        tag: tag || null,
        baselineCenter: b.center,
        baselineN: b.n,
        z: z,
        band: bandFor(z),
        direction: spec.direction,
        score: zToScore(z, spec.direction, spec.zCapHigh)
      };
      if (chosen.score === null) chosen = null;
    }

    if (chosen) {
      chosen.available = true;
      out.components.push(chosen);
      out.availableWeight += chosen.weight;
    } else {
      out.components.push({
        key: spec.key,
        label: spec.label,
        weight: spec.weight,
        metric: null,
        value: null,
        z: null,
        band: null,
        direction: spec.direction,
        score: null,
        available: false
      });
    }
  });

  out.expectedWeight = expectedWeight;

  const present = out.components.filter((c) => c.available);
  if (present.length < MIN_COMPONENTS || out.availableWeight < MIN_AVAILABLE_WEIGHT) {
    out.reason = 'insufficient_inputs';
    out.notes.push(present.length + ' component(s) / ' + out.availableWeight + ' weight available; '
      + MIN_COMPONENTS + ' components and ' + MIN_AVAILABLE_WEIGHT + ' weight required');
    return out;
  }

  const weighted = present.reduce((a, c) => a + c.score * c.weight, 0);
  out.score = Math.round(clamp(weighted / out.availableWeight, 0, 100));

  // Confidence rises with how much of the formula had evidence, and is then
  // discounted by the day's own provenance confidence when the adapter set one.
  // It never reaches 1: this is an inference about a person from a wrist sensor.
  let conf = 0.35 + 0.5 * (out.availableWeight / 100);
  if (isFiniteNum(day.confidence)) {
    const dayConf = clamp(day.confidence, 0, 1);
    conf *= 0.6 + 0.4 * (dayConf == null ? 0 : dayConf);
  }
  out.confidence = round(clamp(conf, 0, 0.95), 2);
  return out;
}

module.exports = {
  // constants
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MIN_SAMPLES,
  MAD_TO_SD,
  METRIC_SERIES_TAG,
  UNTAGGED,
  BANDS,
  BAND_CUTS,
  READINESS_COMPONENTS,
  BASELINE_SCORE,
  POINTS_PER_SD,
  MIN_AVAILABLE_WEIGHT,
  MIN_COMPONENTS,
  // baselines
  computeBaseline,
  computeBaselines,
  baselineFor,
  resolveBaseline,
  seriesTagOf,
  // deviation
  zScore,
  bandFor,
  deviation,
  // readiness
  zToScore,
  normalizedReadiness,
  // exposed for tests / reuse
  median,
  mad,
  stdDev,
  addDaysYmd
};

// INTEGRATION NOTE (for the orchestrator — I did not edit any file outside my slice):
//
// 1. computeBaseline() ALWAYS returns a result object, never null. The "returns
//    null below the sample floor" contract is honoured by `.baseline === null`,
//    and by the baselineFor() wrapper which returns the object or null directly.
//    Callers that want a single number should use baselineFor(); callers that may
//    be looking at a member who changed devices MUST use computeBaseline and read
//    `.mixedMethods` / `.series`.
//
// 2. This module is pure. To wire it up, the DB layer must hand it canonical days
//    that still carry `hrvMethod` and `tempBasis`. readinessService now maps
//    hrv_method / temp_basis / measurement_source out of readiness_daily, so
//    getReadinessRange() rows can be passed straight in. Any adapter that writes
//    an HRV value WITHOUT a method tag lands in the 'unknown' series and is
//    quarantined from every tagged history — that is deliberate, but it means a
//    missing tag looks to the member like a device change.
//
// 3. Suggested call shape for a route:
//        const bl = baselineService.computeBaselines(history, ['hrvMs','restingHr',
//          'sleepMinutes','sleepEfficiencyPct','respiratoryRate','skinTempDeviationC'],
//          { asOf: date, excludeDates: [date] });
//        const r = baselineService.normalizedReadiness(today, bl,
//          deviceRegistry.getDevice(today.source) && deviceRegistry.getDevice(today.source).capabilities);
//    Passing `excludeDates: [date]` matters: scoring a day against a baseline that
//    already contains it shrinks every z-score toward zero.
//
// 4. If normalizedReadiness's output is persisted, write it as source 'derived'
//    with its own formula version — it is NOT the same number as
//    readinessService.computeDerivedReadiness (that one scores adherence and
//    training load from BodyBank's own logs; this one scores physiology against a
//    personal baseline). They should not overwrite each other in readiness_daily.
