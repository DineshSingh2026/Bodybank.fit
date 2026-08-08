'use strict';

/**
 * BodyBank — Whoop / readiness deterministic statistics engine.
 *
 * PURE MODULE: no database, no network, no clock reads, no randomness.
 * Every number a report (or PDF) could ever cite is computed HERE, rounded HERE,
 * exactly once. The narrative model receives only these finished numbers and is
 * forbidden from doing arithmetic; `flattenFactsToNumbers()` is what the report
 * validator uses to mechanically prove the prose invented nothing.
 *
 * Because the rounding happens once, `String(value)` of any fact is byte-identical
 * to what the model sees in the prompt JSON, what the validator checks, and what a
 * PDF prints. Do not re-round downstream.
 *
 * Input: array of readiness day rows (shape from services/wearables/readinessService.js).
 * Both camelCase and snake_case keys are tolerated by `normalizeDay()`.
 */

// ---------------------------------------------------------------------------
// Tunables — all thresholds are explicit and documented so the model never has
// to guess (and the numbers stay reproducible across runs).
// ---------------------------------------------------------------------------

/** Decimal places. Applied ONCE, here. */
const DP = {
  metric: 1, // mean/median/min/max/stdDev/latest and all weekly means
  delta: 1, // trend deltaAbs / deltaPct
  pct: 1, // completenessPct
  r: 2 // Pearson correlation coefficient
};

/** A half-over-half change smaller than this (in %) is reported as 'stable'. */
const TREND_STABLE_PCT = 5;
/** Fallback when a percentage change is undefined (firstHalfMean === 0). */
const TREND_STABLE_ABS = 0.05;
/** A metric needs at least this many non-null days before a trend is computed. */
const TREND_MIN_DAYS = 4;

/** Pearson needs at least this many aligned pairs (below it, r is null). */
const CORR_MIN_PAIRS = 3;
/** |r| cutoffs for the human-readable strength label. */
const CORR_STRENGTH = { strong: 0.7, moderate: 0.4, weak: 0.2 };

/** Whoop-style zones used for the strain/recovery balance read. */
const ZONE = {
  highStrain: 14, // strain >= 14 == hard day
  lowStrain: 8, // strain <= 8  == easy day
  lowRecovery: 34, // recovery < 34 == "red"
  highRecovery: 67 // recovery >= 67 == "green"
};
/** Balance needs at least this many days with BOTH strain and recovery present. */
const BALANCE_MIN_DAYS = 7;
/** Share of qualifying days that flips the interpretation key. */
const BALANCE_OVERREACH_SHARE = 0.2;
const BALANCE_UNDERTRAIN_SHARE = 0.4;

/** Sleep-debt flag thresholds, in minutes per night. */
const SLEEP_DEBT_WARN_MIN = 60;
const SLEEP_DEBT_CRITICAL_MIN = 120;

/** Short-sleep / long-sleep night counters. */
const SHORT_NIGHT_H = 6;
const LONG_NIGHT_H = 8;

/**
 * Metric registry.
 *
 * `polarity`:  1 = higher is better (recovery, HRV, sleep)
 *             -1 = lower is better  (resting HR, respiratory rate)
 *              0 = neutral / load metric (strain) — never labelled improving or
 *                  declining, only 'stable', with `changeDirection` carrying the
 *                  up/down information.
 */
const METRIC_DEFS = [
  { key: 'recovery', unit: '%', polarity: 1, fields: ['recoveryScore', 'recovery_score', 'recovery'] },
  { key: 'hrv', unit: 'ms', polarity: 1, fields: ['hrvMs', 'hrv_ms', 'hrv'] },
  {
    key: 'restingHr',
    unit: 'bpm',
    polarity: -1,
    fields: ['restingHr', 'resting_hr', 'restingHeartRate', 'resting_heart_rate', 'rhr']
  },
  { key: 'sleepHours', unit: 'h', polarity: 1, fields: ['sleepHours', 'sleep_hours'] },
  {
    key: 'sleepEfficiency',
    unit: '%',
    polarity: 1,
    fields: ['sleepEfficiencyPct', 'sleep_efficiency_pct', 'sleepEfficiency', 'sleep_efficiency']
  },
  { key: 'strain', unit: '', polarity: 0, fields: ['strain', 'dayStrain', 'day_strain'] },
  {
    key: 'respiratoryRate',
    unit: 'rpm',
    polarity: -1,
    fields: ['respiratoryRate', 'respiratory_rate', 'respRate', 'resp_rate']
  }
];

const METRIC_KEYS = METRIC_DEFS.map((d) => d.key);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function roundTo(value, dp) {
  if (!Number.isFinite(value)) return null;
  const out = Number(value.toFixed(dp));
  // -0 renders as "0" via String() but as "-0" via toFixed on some paths; normalise.
  return Object.is(out, -0) ? 0 : out;
}

function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toYmd(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function pick(row, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== undefined) return row[k];
  }
  return undefined;
}

function ymdToDate(ymd) {
  return new Date(String(ymd) + 'T00:00:00Z');
}

function addDaysYmd(ymd, days) {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(fromYmd, toYmd_) {
  const a = ymdToDate(fromYmd).getTime();
  const b = ymdToDate(toYmd_).getTime();
  return Math.round((b - a) / 86400000) + 1;
}

/** ISO-8601 week key, same algorithm as services/coinService.js `isoWeekKey`. */
function isoWeekKey(ymd) {
  const d = ymdToDate(ymd);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Population standard deviation (divide by n) — descriptive over the whole window. */
function stdDev(values) {
  if (!values.length) return null;
  const m = mean(values);
  let acc = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = values[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/** Pearson product-moment correlation. Returns null when n < 3 or either series is flat. */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < CORR_MIN_PAIRS) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null; // zero variance → correlation undefined
  return num / Math.sqrt(dx2 * dy2);
}

function correlationStrength(r) {
  if (r === null) return 'none';
  const a = Math.abs(r);
  if (a >= CORR_STRENGTH.strong) return 'strong';
  if (a >= CORR_STRENGTH.moderate) return 'moderate';
  if (a >= CORR_STRENGTH.weak) return 'weak';
  return 'none';
}

function correlationDirection(r) {
  if (r === null || r === 0) return 'none';
  return r > 0 ? 'positive' : 'negative';
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Accepts a raw readiness row in either camelCase or snake_case and returns a
 * canonical day object. Returns null when the row has no usable date.
 */
function normalizeDay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = toYmd(pick(raw, ['date', 'day', 'ymd', 'recordedOn', 'recorded_on', 'statDate', 'stat_date']));
  if (!date) return null;

  const out = { date };
  const source = pick(raw, ['source', 'provider']);
  out.source = source === undefined || source === null ? null : String(source);

  for (let i = 0; i < METRIC_DEFS.length; i += 1) {
    const def = METRIC_DEFS[i];
    out[def.key] = toNum(pick(raw, def.fields));
  }

  out.sleepDebtMin = toNum(pick(raw, ['sleepDebtMin', 'sleep_debt_min']));
  out.energyKcal = toNum(pick(raw, ['energyKcal', 'energy_kcal', 'calories']));
  out.remMin = toNum(pick(raw, ['remMin', 'rem_min']));
  out.deepMin = toNum(pick(raw, ['deepMin', 'deep_min']));
  out.napMin = toNum(pick(raw, ['napMin', 'nap_min']));
  return out;
}

/** Normalise + sort ascending by date + dedupe (last row for a date wins). */
function normalizeDays(days) {
  const list = Array.isArray(days) ? days : [];
  const byDate = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const d = normalizeDay(list[i]);
    if (d) byDate.set(d.date, d);
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function hasAnyMetric(day) {
  for (let i = 0; i < METRIC_KEYS.length; i += 1) {
    if (day[METRIC_KEYS[i]] !== null) return true;
  }
  return day.sleepDebtMin !== null || day.napMin !== null;
}

/** Non-null series for one metric, in date order: [{date, value}] */
function seriesFor(days, key) {
  const out = [];
  for (let i = 0; i < days.length; i += 1) {
    const v = days[i][key];
    if (v !== null) out.push({ date: days[i].date, value: v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metric block
// ---------------------------------------------------------------------------

function metricStats(days, def) {
  const series = seriesFor(days, def.key);
  if (!series.length) return null; // n === 0 → the whole metric is null
  const values = series.map((p) => p.value);
  return {
    mean: roundTo(mean(values), DP.metric),
    median: roundTo(median(values), DP.metric),
    min: roundTo(Math.min.apply(null, values), DP.metric),
    max: roundTo(Math.max.apply(null, values), DP.metric),
    stdDev: roundTo(stdDev(values), DP.metric),
    n: series.length,
    latest: roundTo(series[series.length - 1].value, DP.metric),
    latestDate: series[series.length - 1].date,
    unit: def.unit
  };
}

/**
 * First-half vs second-half comparison over the metric's own non-null series.
 * For an odd number of days the middle day is excluded from both halves so the
 * halves stay the same size.
 *
 * `direction` respects polarity: a FALLING resting HR is 'improving'; a falling
 * recovery is 'declining'. Neutral metrics (strain) are always 'stable' and carry
 * their up/down movement in `changeDirection`.
 */
function metricTrend(days, def) {
  const series = seriesFor(days, def.key);
  const n = series.length;
  if (n < TREND_MIN_DAYS) return null;

  const half = Math.floor(n / 2);
  const firstValues = series.slice(0, half).map((p) => p.value);
  const secondValues = series.slice(n - half).map((p) => p.value);

  // Round the halves FIRST, then derive the deltas from the rounded numbers, so
  // the printed delta is exactly the difference of the printed means.
  const firstHalfMean = roundTo(mean(firstValues), DP.metric);
  const secondHalfMean = roundTo(mean(secondValues), DP.metric);
  const deltaAbs = roundTo(secondHalfMean - firstHalfMean, DP.delta);
  const deltaPct = firstHalfMean === 0 ? null : roundTo((deltaAbs / Math.abs(firstHalfMean)) * 100, DP.delta);

  const changeDirection = deltaAbs > 0 ? 'up' : deltaAbs < 0 ? 'down' : 'flat';

  let direction;
  const stable =
    deltaPct === null ? Math.abs(deltaAbs) < TREND_STABLE_ABS : Math.abs(deltaPct) < TREND_STABLE_PCT;
  if (def.polarity === 0 || stable) {
    direction = 'stable';
  } else {
    direction = deltaAbs * def.polarity > 0 ? 'improving' : 'declining';
  }

  return {
    firstHalfMean,
    secondHalfMean,
    deltaAbs,
    deltaPct,
    direction,
    changeDirection,
    polarity: def.polarity,
    n,
    unit: def.unit
  };
}

// ---------------------------------------------------------------------------
// Weekly buckets
// ---------------------------------------------------------------------------

function weeklyBuckets(days) {
  const order = [];
  const buckets = new Map();
  for (let i = 0; i < days.length; i += 1) {
    const key = isoWeekKey(days[i].date);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key).push(days[i]);
  }
  return order.map((week) => {
    const rows = buckets.get(week);
    const bucket = {
      week,
      days: rows.length,
      dateFrom: rows[0].date,
      dateTo: rows[rows.length - 1].date
    };
    for (let i = 0; i < METRIC_DEFS.length; i += 1) {
      const def = METRIC_DEFS[i];
      const values = rows.map((r) => r[def.key]).filter((v) => v !== null);
      bucket[def.key] = values.length ? roundTo(mean(values), DP.metric) : null;
    }
    return bucket;
  });
}

// ---------------------------------------------------------------------------
// Sleep debt
// ---------------------------------------------------------------------------

function sleepDebtBlock(days) {
  const debts = [];
  let nightsUnder6h = 0;
  let nightsOver8h = 0;
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i];
    if (d.sleepDebtMin !== null) debts.push({ date: d.date, value: d.sleepDebtMin });
    if (d.sleepHours !== null) {
      if (d.sleepHours < SHORT_NIGHT_H) nightsUnder6h += 1;
      if (d.sleepHours > LONG_NIGHT_H) nightsOver8h += 1;
    }
  }
  if (!debts.length) {
    return {
      totalMin: null,
      avgPerNightMin: null,
      worstDate: null,
      worstMin: null,
      nights: 0,
      nightsUnder6h,
      nightsOver8h
    };
  }
  let worst = debts[0];
  let total = 0;
  for (let i = 0; i < debts.length; i += 1) {
    total += debts[i].value;
    if (debts[i].value > worst.value) worst = debts[i];
  }
  return {
    totalMin: roundTo(total, DP.metric),
    avgPerNightMin: roundTo(total / debts.length, DP.metric),
    worstDate: worst.date,
    worstMin: roundTo(worst.value, DP.metric),
    nights: debts.length,
    nightsUnder6h,
    nightsOver8h
  };
}

// ---------------------------------------------------------------------------
// Strain / recovery balance
// ---------------------------------------------------------------------------

function strainRecoveryBalance(days) {
  const pairs = days.filter((d) => d.strain !== null && d.recovery !== null);
  const strainsOnLowRecovery = [];
  let daysHighStrainLowRecovery = 0;
  let daysLowStrainHighRecovery = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    const d = pairs[i];
    if (d.recovery < ZONE.lowRecovery) strainsOnLowRecovery.push(d.strain);
    if (d.strain >= ZONE.highStrain && d.recovery < ZONE.lowRecovery) daysHighStrainLowRecovery += 1;
    if (d.strain <= ZONE.lowStrain && d.recovery >= ZONE.highRecovery) daysLowStrainHighRecovery += 1;
  }

  let interpretationKey = 'insufficient_data';
  if (pairs.length >= BALANCE_MIN_DAYS) {
    if (daysHighStrainLowRecovery >= Math.ceil(pairs.length * BALANCE_OVERREACH_SHARE)) {
      interpretationKey = 'overreaching';
    } else if (daysLowStrainHighRecovery >= Math.ceil(pairs.length * BALANCE_UNDERTRAIN_SHARE)) {
      interpretationKey = 'undertraining';
    } else {
      interpretationKey = 'balanced';
    }
  }

  return {
    daysConsidered: pairs.length,
    daysHighStrainLowRecovery,
    daysLowStrainHighRecovery,
    avgStrainOnLowRecoveryDays: strainsOnLowRecovery.length
      ? roundTo(mean(strainsOnLowRecovery), DP.metric)
      : null,
    highStrainThreshold: ZONE.highStrain,
    lowStrainThreshold: ZONE.lowStrain,
    lowRecoveryThreshold: ZONE.lowRecovery,
    highRecoveryThreshold: ZONE.highRecovery,
    interpretationKey
  };
}

// ---------------------------------------------------------------------------
// Correlations (next-day alignment is by CALENDAR DATE, never array index)
// ---------------------------------------------------------------------------

function alignedPairs(days, xKey, yKey, lagDays) {
  const byDate = new Map();
  for (let i = 0; i < days.length; i += 1) byDate.set(days[i].date, days[i]);
  const xs = [];
  const ys = [];
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i];
    const x = d[xKey];
    if (x === null) continue;
    const target = lagDays === 0 ? d : byDate.get(addDaysYmd(d.date, lagDays));
    if (!target) continue; // gap in the calendar → no pair, on purpose
    const y = target[yKey];
    if (y === null) continue;
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

function correlationFor(days, xKey, yKey, lagDays) {
  const { xs, ys } = alignedPairs(days, xKey, yKey, lagDays);
  const raw = pearson(xs, ys);
  const r = raw === null ? null : roundTo(raw, DP.r);
  return {
    r,
    n: xs.length,
    lagDays,
    strength: correlationStrength(r),
    direction: correlationDirection(r)
  };
}

function correlationsBlock(days) {
  return {
    sleepHoursToNextDayRecovery: correlationFor(days, 'sleepHours', 'recovery', 1),
    strainToNextDayRecovery: correlationFor(days, 'strain', 'recovery', 1),
    sleepEfficiencyToHrv: correlationFor(days, 'sleepEfficiency', 'hrv', 0),
    napMinToNextDayRecovery: correlationFor(days, 'napMin', 'recovery', 1)
  };
}

// ---------------------------------------------------------------------------
// Notable days
// ---------------------------------------------------------------------------

function extremeDay(days, key, mode) {
  const series = seriesFor(days, key);
  if (!series.length) return null;
  let best = series[0];
  for (let i = 1; i < series.length; i += 1) {
    if (mode === 'max' ? series[i].value > best.value : series[i].value < best.value) best = series[i];
  }
  return { date: best.date, value: roundTo(best.value, DP.metric) };
}

function notableDaysBlock(days) {
  return {
    bestRecovery: extremeDay(days, 'recovery', 'max'),
    worstRecovery: extremeDay(days, 'recovery', 'min'),
    longestSleep: extremeDay(days, 'sleepHours', 'max'),
    shortestSleep: extremeDay(days, 'sleepHours', 'min')
  };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function buildFlags({ metrics, trends, sleepDebt, balance }) {
  const flags = [];

  if (sleepDebt.avgPerNightMin !== null && sleepDebt.avgPerNightMin >= SLEEP_DEBT_WARN_MIN) {
    flags.push({
      key: 'chronic_sleep_debt',
      severity: sleepDebt.avgPerNightMin >= SLEEP_DEBT_CRITICAL_MIN ? 'critical' : 'warn',
      avgPerNightMin: sleepDebt.avgPerNightMin,
      totalMin: sleepDebt.totalMin,
      nights: sleepDebt.nights,
      thresholdMin: SLEEP_DEBT_WARN_MIN
    });
  }

  if (trends.hrv && trends.hrv.direction === 'declining') {
    flags.push({
      key: 'declining_hrv',
      severity: Math.abs(trends.hrv.deltaPct === null ? 0 : trends.hrv.deltaPct) >= 10 ? 'warn' : 'info',
      firstHalfMean: trends.hrv.firstHalfMean,
      secondHalfMean: trends.hrv.secondHalfMean,
      deltaAbs: trends.hrv.deltaAbs,
      deltaPct: trends.hrv.deltaPct
    });
  }

  if (trends.restingHr && trends.restingHr.direction === 'declining') {
    // polarity-aware: 'declining' on resting HR means the number went UP.
    flags.push({
      key: 'elevated_resting_hr',
      severity: Math.abs(trends.restingHr.deltaPct === null ? 0 : trends.restingHr.deltaPct) >= 10 ? 'warn' : 'info',
      firstHalfMean: trends.restingHr.firstHalfMean,
      secondHalfMean: trends.restingHr.secondHalfMean,
      deltaAbs: trends.restingHr.deltaAbs,
      deltaPct: trends.restingHr.deltaPct
    });
  }

  if (balance.interpretationKey === 'overreaching') {
    flags.push({
      key: 'overreaching',
      severity: 'warn',
      daysHighStrainLowRecovery: balance.daysHighStrainLowRecovery,
      daysConsidered: balance.daysConsidered,
      avgStrainOnLowRecoveryDays: balance.avgStrainOnLowRecoveryDays
    });
  }

  if (balance.interpretationKey === 'undertraining') {
    flags.push({
      key: 'undertraining',
      severity: 'info',
      daysLowStrainHighRecovery: balance.daysLowStrainHighRecovery,
      daysConsidered: balance.daysConsidered
    });
  }

  if (metrics.recovery && metrics.recovery.mean !== null && metrics.recovery.mean < ZONE.lowRecovery) {
    flags.push({
      key: 'low_average_recovery',
      severity: 'warn',
      mean: metrics.recovery.mean,
      thresholdPct: ZONE.lowRecovery,
      n: metrics.recovery.n
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} days  readiness rows (camelCase or snake_case)
 * @param {object} [opts]
 * @param {number} [opts.expectedDays]  override the coverage denominator (e.g. 30)
 * @param {string} [opts.memberLabel]   free-text label carried through for the prompt
 * @returns {object} fully-computed fact object — every citable number already rounded
 */
function computeWhoopStats(days, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const normalized = normalizeDays(days);
  const withData = normalized.filter(hasAnyMetric);

  const dateFrom = normalized.length ? normalized[0].date : null;
  const dateTo = normalized.length ? normalized[normalized.length - 1].date : null;
  const spanDays = dateFrom && dateTo ? daysBetweenInclusive(dateFrom, dateTo) : 0;
  const expected = Number.isFinite(Number(options.expectedDays))
    ? Math.max(1, Math.round(Number(options.expectedDays)))
    : spanDays;
  const daysWithData = withData.length;
  const completenessPct = expected > 0 ? roundTo((daysWithData / expected) * 100, DP.pct) : null;

  const metrics = {};
  const trends = {};
  for (let i = 0; i < METRIC_DEFS.length; i += 1) {
    const def = METRIC_DEFS[i];
    metrics[def.key] = metricStats(normalized, def);
    trends[def.key] = metricTrend(normalized, def);
  }

  const sleepDebt = sleepDebtBlock(normalized);
  const balance = strainRecoveryBalance(normalized);

  return {
    schemaVersion: 1,
    memberLabel: options.memberLabel ? String(options.memberLabel) : null,
    coverage: {
      daysTotal: expected,
      daysWithData,
      dateFrom,
      dateTo,
      completenessPct
    },
    metrics,
    trends,
    weekly: weeklyBuckets(normalized),
    sleepDebt,
    strainRecoveryBalance: balance,
    correlations: correlationsBlock(normalized),
    notableDays: notableDaysBlock(normalized),
    flags: buildFlags({ metrics, trends, sleepDebt, balance }),
    thresholds: {
      trendStablePct: TREND_STABLE_PCT,
      trendMinDays: TREND_MIN_DAYS,
      correlationMinPairs: CORR_MIN_PAIRS,
      correlationStrong: CORR_STRENGTH.strong,
      correlationModerate: CORR_STRENGTH.moderate,
      correlationWeak: CORR_STRENGTH.weak,
      shortNightHours: SHORT_NIGHT_H,
      longNightHours: LONG_NIGHT_H,
      sleepDebtWarnMin: SLEEP_DEBT_WARN_MIN,
      sleepDebtCriticalMin: SLEEP_DEBT_CRITICAL_MIN
    }
  };
}

/**
 * Every numeric string that appears anywhere in the fact object, formatted exactly
 * as it renders (`String(value)`), plus the safe variants a writer may legitimately
 * use for the SAME fact:
 *   - the unsigned form of a negative value ("-3.4" also admits "3.4", because prose
 *     says "fell by 3.4"),
 *   - the components of any ISO date ("2026-01-05" admits 2026, 01, 1, 05, 5).
 * No derived or re-rounded values are added — that would defeat the whole point.
 */
function flattenFactsToNumbers(stats) {
  const out = new Set();

  const addNumber = (n) => {
    if (!Number.isFinite(n)) return;
    const s = String(n);
    out.add(s);
    if (s.startsWith('-')) out.add(s.slice(1));
  };

  const addDateParts = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    out.add(s);
    out.add(m[1]);
    out.add(m[2]);
    out.add(String(Number(m[2])));
    out.add(m[3]);
    out.add(String(Number(m[3])));
    return true;
  };

  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') {
      addNumber(value);
      return;
    }
    if (typeof value === 'string') {
      if (addDateParts(value)) return;
      // Week keys ("2026-W03") and any other embedded numerals.
      const found = value.match(/\d+(?:\.\d+)?/g);
      if (found) {
        for (let i = 0; i < found.length; i += 1) {
          out.add(found[i]);
          const n = Number(found[i]);
          if (Number.isFinite(n)) out.add(String(n));
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i]);
      return;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i += 1) walk(value[keys[i]]);
    }
  };

  walk(stats);
  return out;
}

module.exports = {
  computeWhoopStats,
  flattenFactsToNumbers,
  // exported for tests / downstream reuse
  normalizeDay,
  normalizeDays,
  isoWeekKey,
  pearson,
  roundTo,
  METRIC_DEFS,
  METRIC_KEYS
};
