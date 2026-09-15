'use strict';

/**
 * BodyBank Score — the deterministic scorecard behind the admin Reports module.
 *
 *   computeBodyBankScore(userId, startDate, endDate, type)
 *     -> { total, grade, pillars: { workout, nutrition, checkin, consistency, yoga, health } }
 *
 * The scoring itself (scoreDataset) is a PURE function of a normalised dataset
 * (see services/reportData.js for the shape and the SQL that fills it). Same
 * input, same output, no clock, no randomness, no network — which is what lets
 * tests/report-score.js pin a perfect week, an empty week and a partial week.
 *
 * Every rule below is documented in docs/REPORTS.md. Change one here and the
 * README in the same commit.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_WEIGHTS = Object.freeze({ workout: 25, nutrition: 25, checkin: 15, consistency: 15, yoga: 10, health: 10 });
const PILLARS = Object.freeze(['workout', 'nutrition', 'checkin', 'consistency', 'yoga', 'health']);
const PILLAR_LABELS = Object.freeze({
  workout: 'Workout', nutrition: 'Nutrition', checkin: 'Check-in', consistency: 'Consistency', yoga: 'Yoga', health: 'Health'
});

const GRADE_BANDS = Object.freeze([[90, 'A+'], [80, 'A'], [70, 'B'], [60, 'C'], [50, 'D']]);

/** Defaults used only when the client has no target of their own. */
const DEFAULT_TARGETS = Object.freeze({
  mealsPerDay: 3,
  sleepH: 7,
  steps: 8000,
  waterL: 3,
  workoutsPerWeek: 3,
  yogaPerWeek: 3,
  proteinPerKg: 1.6
});

const TREND_CAP_PCT = 20;          // volume / mobility trend is capped at +-20%
const TREND_FLAT_POINTS = 2;       // |delta| below this many points reads as 'flat'
const RPE_BAND = [7, 9];
const CAL_TOLERANCE = 0.10;        // +-10% of the calorie target is a hit
const PROTEIN_HIT = 0.90;          // >= 90% of the protein target is a hit

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
/** Missing stays missing: null / '' / undefined are NOT zero (Number(null) === 0). */
function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round1(v) { return Math.round(v * 10) / 10; }
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function mean(arr) { return arr.length ? sum(arr) / arr.length : null; }

function gradeFor(score) {
  const s = Math.round(Number(score) || 0);
  for (const [min, g] of GRADE_BANDS) if (s >= min) return g;
  return 'E';
}

/** 'YYYY-MM-DD' -> UTC epoch day. Dates never touch the local timezone. */
function dayNum(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
function isoFromDay(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function addDays(iso, d) { return isoFromDay(dayNum(iso) + d); }
function daysBetween(start, end) { return dayNum(end) - dayNum(start) + 1; }
function datesInRange(start, end) {
  const out = [];
  for (let d = dayNum(start); d <= dayNum(end); d += 1) out.push(isoFromDay(d));
  return out;
}
function inRange(iso, start, end) {
  const d = dayNum(iso);
  return d >= dayNum(start) && d <= dayNum(end);
}

/** The period of equal length immediately before [start, end]. */
function previousPeriod(start, end) {
  const len = daysBetween(start, end);
  return { start: addDays(start, -len), end: addDays(start, -1) };
}

/**
 * Trend score 0..1 from a relative change, capped at +-20%:
 * +20% or better = 1, flat = 0.5, -20% or worse = 0.
 * No baseline (previous is 0/absent) is neutral: 0.5.
 */
function trendScore(cur, prev) {
  if (!(cur > 0)) return 0;
  if (!(prev > 0)) return 0.5;
  const pct = clamp(((cur - prev) / prev) * 100, -TREND_CAP_PCT, TREND_CAP_PCT);
  return (pct + TREND_CAP_PCT) / (2 * TREND_CAP_PCT);
}
function pctChange(cur, prev) {
  if (!(prev > 0) || cur == null) return null;
  return round1(((cur - prev) / prev) * 100);
}

// ---------------------------------------------------------------------------
// Dataset normalisation — tolerant of missing arrays so the scorer never throws
// ---------------------------------------------------------------------------

function normalise(ds) {
  const d = ds || {};
  const p = d.period || {};
  const start = p.start;
  const end = p.end;
  const within = (r) => r && r.date && inRange(r.date, start, end);
  const t = Object.assign({}, DEFAULT_TARGETS, d.targets || {});
  return {
    period: { start, end, days: Math.max(1, daysBetween(start, end)) },
    targets: t,
    goal: d.goal || {},
    workouts: (d.workouts || []).filter(within),
    plannedWorkouts: num(d.plannedWorkouts),
    meals: (d.meals || []).filter(within),
    checkins: (d.checkins || []).filter(within),
    yoga: (d.yoga || []).filter(within),
    plannedYoga: num(d.plannedYoga),
    weights: (d.weights || []).filter(within),
    baselineWeight: d.baselineWeight || null,
    measurements: (d.measurements || []).filter(within),
    baselineMeasurement: d.baselineMeasurement || null,
    blood: (d.blood || []).filter((r) => r && r.date && dayNum(r.date) <= dayNum(end)),
    bloodInPeriod: (d.blood || []).filter(within)
  };
}

function byDate(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r.date).slice(0, 10);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * Row sources that carry data for a day without being a check-in the member
 * submitted: wearable sync, values derived from other logs, and streak freezes.
 */
const NON_CHECKIN_SOURCES = new Set(['wearable', 'derived', 'freeze']);

/** One merged record per day for check-in style metrics. */
function dayCheckins(n) {
  const m = new Map();
  for (const c of n.checkins) {
    const k = String(c.date).slice(0, 10);
    const cur = m.get(k) || { date: k, checkin: false, freeze: false };
    const own = !NON_CHECKIN_SOURCES.has(c.source);
    if (own) cur.checkin = true;
    if (c.source === 'freeze') cur.freeze = true;
    // The member's own numbers win over a device's; a device fills the gaps.
    for (const f of ['sleepH', 'steps', 'waterL', 'mood', 'energy', 'stress', 'weightKg']) {
      const v = num(c[f]);
      if (v != null && (cur[f] == null || own)) cur[f] = v;
    }
    m.set(k, cur);
  }
  // Water logged against meals (nutrition) also counts toward the water target.
  for (const ml of n.meals) {
    const k = String(ml.date).slice(0, 10);
    const w = num(ml.waterL);
    if (w == null) continue;
    const cur = m.get(k) || { date: k, checkin: false, freeze: false };
    cur.waterL = Math.max(cur.waterL || 0, w);
    m.set(k, cur);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Pillars — each returns { score 0..100 | null, metrics, components }
// ---------------------------------------------------------------------------

function workoutPillar(n, prevN) {
  const days = n.period.days;
  const completed = n.workouts.filter((w) => w.completed);
  const plannedFromRows = n.workouts.filter((w) => w.planned).length;
  const planned = n.plannedWorkouts != null && n.plannedWorkouts > 0
    ? n.plannedWorkouts
    : (plannedFromRows > 0 ? plannedFromRows : Math.round((n.targets.workoutsPerWeek * days) / 7));
  const planSource = (n.plannedWorkouts > 0 || plannedFromRows > 0) ? 'plan' : 'default';
  const completion = planned > 0 ? clamp(completed.length / planned, 0, 1) : 0;

  const volume = sum(completed.map((w) => num(w.volumeKg) || 0));
  const prevVolume = prevN ? sum(prevN.workouts.filter((w) => w.completed).map((w) => num(w.volumeKg) || 0)) : 0;
  const volTrend = completed.length ? trendScore(volume, prevVolume) : 0;
  const volNeutral = completed.length > 0 && !(volume > 0 && prevVolume > 0);

  const rpes = completed.map((w) => num(w.rpe)).filter((v) => v != null && v > 0);
  const avgRpe = rpes.length ? mean(rpes) : null;
  let rpeScore = 0;
  if (completed.length) {
    if (avgRpe == null) rpeScore = 0.5;
    else if (avgRpe >= RPE_BAND[0] && avgRpe <= RPE_BAND[1]) rpeScore = 1;
    else {
      const dist = avgRpe < RPE_BAND[0] ? RPE_BAND[0] - avgRpe : avgRpe - RPE_BAND[1];
      rpeScore = 1 - clamp(dist / 3, 0, 1);
    }
  }

  const score = 100 * (0.60 * completion + 0.25 * volTrend + 0.15 * rpeScore);
  return {
    score,
    components: { completion, volumeTrend: volTrend, rpe: rpeScore },
    metrics: {
      planned, planSource, completed: completed.length,
      completionPct: Math.round(completion * 100),
      volumeKg: Math.round(volume), prevVolumeKg: Math.round(prevVolume),
      volumeDeltaPct: pctChange(volume, prevVolume), volumeNeutral: volNeutral,
      avgRpe: avgRpe == null ? null : round1(avgRpe),
      minutes: Math.round(sum(completed.map((w) => num(w.durationMin) || 0))),
      hasData: n.workouts.length > 0
    }
  };
}

function nutritionPillar(n) {
  const days = n.period.days;
  const t = n.targets;
  const perDay = Math.max(1, Math.round(t.mealsPerDay || DEFAULT_TARGETS.mealsPerDay));
  const map = byDate(n.meals);
  let mealsLogged = 0; let mealsCapped = 0; let calHits = 0; let protHits = 0; let daysLogged = 0;
  const calTarget = num(t.calories);
  let protTarget = num(t.protein);
  let proteinSource = protTarget ? 'target' : null;
  if (!protTarget) {
    const w = latestWeight(n);
    if (w) { protTarget = Math.round(w * DEFAULT_TARGETS.proteinPerKg); proteinSource = 'bodyweight'; }
  }
  const calDays = []; const protDays = [];
  for (const [date, rows] of map) {
    const meals = sum(rows.map((r) => num(r.meals) || 0));
    const cal = sum(rows.map((r) => num(r.calories) || 0));
    const prot = sum(rows.map((r) => num(r.protein) || 0));
    if (meals <= 0 && cal <= 0) continue;
    daysLogged += 1;
    mealsLogged += meals;
    mealsCapped += Math.min(meals, perDay);
    if (calTarget && Math.abs(cal - calTarget) <= calTarget * CAL_TOLERANCE) calHits += 1;
    if (protTarget && prot >= protTarget * PROTEIN_HIT) protHits += 1;
    calDays.push(cal); protDays.push(prot);
  }
  const adherence = clamp(mealsCapped / (perDay * days), 0, 1);
  // With no target to hit, the hit-rate component falls back to logging
  // adherence (documented) — the client is not penalised for a missing plan,
  // and the insight asks the coach to set one.
  const calRate = calTarget ? calHits / days : adherence;
  const protRate = protTarget ? protHits / days : adherence;
  const score = 100 * (0.50 * adherence + 0.30 * calRate + 0.20 * protRate);
  return {
    score,
    components: { adherence, calorieHitRate: calRate, proteinHitRate: protRate },
    metrics: {
      mealsLogged, mealsExpected: perDay * days, daysLogged,
      adherencePct: Math.round(adherence * 100),
      calorieTarget: calTarget, proteinTarget: protTarget, proteinSource,
      calorieHitDays: calTarget ? calHits : null, proteinHitDays: protTarget ? protHits : null,
      avgCalories: calDays.length ? Math.round(mean(calDays)) : null,
      avgProtein: protDays.length ? Math.round(mean(protDays)) : null,
      hasData: daysLogged > 0
    }
  };
}

function checkinPillar(n) {
  const days = n.period.days;
  const t = n.targets;
  const m = dayCheckins(n);
  let done = 0; let sleepOk = 0; let stepsOk = 0; let waterOk = 0;
  const sleeps = []; const steps = []; const moods = []; const energies = []; const stresses = []; const waters = [];
  for (const d of m.values()) {
    if (d.checkin) done += 1;
    if (d.sleepH != null) { sleeps.push(d.sleepH); if (d.sleepH >= (t.sleepH || 7)) sleepOk += 1; }
    if (d.steps != null) { steps.push(d.steps); if (d.steps >= t.steps) stepsOk += 1; }
    if (d.waterL != null) { waters.push(d.waterL); if (d.waterL >= t.waterL) waterOk += 1; }
    if (d.mood != null) moods.push(d.mood);
    if (d.energy != null) energies.push(d.energy);
    if (d.stress != null) stresses.push(d.stress);
  }
  const c = { completion: clamp(done / days, 0, 1), sleep: clamp(sleepOk / days, 0, 1), steps: clamp(stepsOk / days, 0, 1), water: clamp(waterOk / days, 0, 1) };
  const score = 100 * (0.50 * c.completion + 0.20 * c.sleep + 0.15 * c.steps + 0.15 * c.water);
  return {
    score,
    components: c,
    metrics: {
      checkinDays: done, days,
      completionPct: Math.round(c.completion * 100),
      sleepOkDays: sleepOk, stepsOkDays: stepsOk, waterOkDays: waterOk,
      avgSleepH: sleeps.length ? round1(mean(sleeps)) : null,
      avgSteps: steps.length ? Math.round(mean(steps)) : null,
      avgWaterL: waters.length ? round1(mean(waters)) : null,
      avgMood: moods.length ? round1(mean(moods)) : null,
      avgEnergy: energies.length ? round1(mean(energies)) : null,
      avgStress: stresses.length ? round1(mean(stresses)) : null,
      stepsTarget: t.steps, waterTargetL: t.waterL, sleepTargetH: t.sleepH || 7,
      hasData: m.size > 0
    }
  };
}

/** Days with any logged activity, plus the per-day facts consistency needs. */
function activityDays(n) {
  const t = n.targets;
  const perDay = Math.max(1, Math.round(t.mealsPerDay || DEFAULT_TARGETS.mealsPerDay));
  const checkins = dayCheckins(n);
  const meals = byDate(n.meals);
  const wk = byDate(n.workouts);
  const yoga = byDate(n.yoga);
  return datesInRange(n.period.start, n.period.end).map((date) => {
    const ci = checkins.get(date);
    const mealRows = meals.get(date) || [];
    const mealCount = sum(mealRows.map((r) => num(r.meals) || 0));
    const wRows = wk.get(date) || [];
    const plannedToday = wRows.some((w) => w.planned);
    const doneToday = wRows.some((w) => w.completed);
    const yogaToday = (yoga.get(date) || []).length > 0;
    const checkedIn = !!(ci && ci.checkin);
    const freeze = !!(ci && ci.freeze);
    const active = checkedIn || mealCount > 0 || doneToday || yogaToday;
    const perfect = checkedIn && mealCount >= perDay && (!plannedToday || doneToday);
    return { date, active, perfect, freeze, checkedIn, meals: mealCount, workout: doneToday, yoga: yogaToday, plannedWorkout: plannedToday };
  });
}

/**
 * Longest run of active days. A streak-freeze day does not count as a day of
 * the run, but it does not break it either — that is what a freeze is for.
 */
function longestRun(days) {
  let best = 0; let run = 0;
  for (const d of days) {
    if (d.active) run += 1;
    else if (!d.freeze) run = 0;
    if (run > best) best = run;
  }
  return best;
}

function consistencyPillar(n) {
  const days = n.period.days;
  const act = activityDays(n);
  const active = act.filter((d) => d.active).length;
  const streak = longestRun(act);
  const perfect = act.filter((d) => d.perfect).length;
  const c = { active: active / days, streak: streak / days, perfect: perfect / days };
  const score = 100 * (0.50 * c.active + 0.30 * c.streak + 0.20 * c.perfect);
  return {
    score,
    components: c,
    metrics: { activeDays: active, longestStreak: streak, perfectDays: perfect, days, hasData: active > 0 },
    days: act
  };
}

function yogaPillar(n, prevN) {
  const days = n.period.days;
  const sessions = n.yoga.length;
  const planned = n.plannedYoga != null && n.plannedYoga > 0
    ? n.plannedYoga
    : Math.max(1, Math.round((n.targets.yogaPerWeek * days) / 7));
  const rate = clamp(sessions / planned, 0, 1);
  const mob = n.yoga.map((y) => num(y.mobilityScore)).filter((v) => v != null && v > 0);
  const prevMob = prevN ? prevN.yoga.map((y) => num(y.mobilityScore)).filter((v) => v != null && v > 0) : [];
  const avgMob = mob.length ? mean(mob) : null;
  const prevAvgMob = prevMob.length ? mean(prevMob) : null;
  let mobTrend = 0;
  if (sessions > 0) mobTrend = avgMob == null ? 0.5 : trendScore(avgMob, prevAvgMob);
  const score = 100 * (0.70 * rate + 0.30 * mobTrend);
  return {
    score,
    components: { sessions: rate, mobilityTrend: mobTrend },
    metrics: {
      sessions, planned, planSource: n.plannedYoga > 0 ? 'plan' : 'default',
      minutes: Math.round(sum(n.yoga.map((y) => num(y.durationMin) || 0))),
      avgMobility: avgMob == null ? null : round1(avgMob),
      prevAvgMobility: prevAvgMob == null ? null : round1(prevAvgMob),
      mobilityDeltaPct: pctChange(avgMob, prevAvgMob),
      hasData: sessions > 0
    }
  };
}

function latestWeight(n) {
  const all = n.weights.slice().sort((a, b) => dayNum(a.date) - dayNum(b.date));
  if (all.length) return num(all[all.length - 1].weightKg);
  return n.baselineWeight ? num(n.baselineWeight.weightKg) : null;
}

/** 0..1 progress of body composition toward the goal over the period. */
function bodyCompScore(n) {
  const days = n.period.days;
  const weeks = Math.max(1, days / 7);
  const series = n.weights.map((w) => ({ date: w.date, v: num(w.weightKg) })).filter((w) => w.v != null)
    .sort((a, b) => dayNum(a.date) - dayNum(b.date));
  const base = n.baselineWeight && num(n.baselineWeight.weightKg) != null ? num(n.baselineWeight.weightKg) : null;
  const startW = base != null ? base : (series.length ? series[0].v : null);
  const endW = series.length ? series[series.length - 1].v : null;
  const readings = series.length + (base != null ? 1 : 0);
  if (startW == null || endW == null || readings < 2) return null;

  const target = num(n.goal.targetWeightKg);
  let dir = n.goal.direction || null;
  if (!dir && target != null) dir = target < startW - 0.5 ? 'lose' : (target > startW + 0.5 ? 'gain' : 'maintain');
  if (!dir) dir = 'maintain';
  if (target != null && Math.abs(target - startW) < 0.5) dir = 'maintain';
  const change = endW - startW;

  let weightScore;
  if (dir === 'lose') {
    const expected = Math.min(target != null ? startW - target : Infinity, 0.5 * weeks);
    weightScore = expected > 0 ? clamp(-change / expected, 0, 1) : 1;
  } else if (dir === 'gain') {
    const expected = Math.min(target != null ? target - startW : Infinity, 0.25 * weeks);
    weightScore = expected > 0 ? clamp(change / expected, 0, 1) : 1;
  } else {
    const tol = Math.max(0.5, 0.25 * weeks);
    weightScore = Math.abs(change) <= tol ? 1 : clamp(1 - (Math.abs(change) - tol) / tol, 0, 1);
  }

  // Waist, when measured twice, is averaged in: it separates fat from water.
  let waistScore = null; let waistChange = null;
  const ms = n.measurements.filter((x) => num(x.waistCm) != null).sort((a, b) => dayNum(a.date) - dayNum(b.date));
  const mBase = n.baselineMeasurement && num(n.baselineMeasurement.waistCm) != null ? num(n.baselineMeasurement.waistCm) : null;
  const w0 = mBase != null ? mBase : (ms.length ? num(ms[0].waistCm) : null);
  const w1 = ms.length ? num(ms[ms.length - 1].waistCm) : null;
  if (w0 != null && w1 != null && (ms.length + (mBase != null ? 1 : 0)) >= 2) {
    waistChange = w1 - w0;
    const exp = 0.5 * weeks;
    if (dir === 'lose') waistScore = clamp(-waistChange / exp, 0, 1);
    else if (dir === 'gain') waistScore = clamp(1 - Math.max(0, waistChange) / exp, 0, 1);
    else waistScore = clamp(1 - Math.max(0, Math.abs(waistChange) - 1) / exp, 0, 1);
  }
  const score = waistScore == null ? weightScore : (weightScore + waistScore) / 2;
  return { score, direction: dir, startKg: round1(startW), endKg: round1(endW), changeKg: round1(change), targetKg: target, waistChangeCm: waistChange == null ? null : round1(waistChange) };
}

/** Marker-level comparison over every blood report up to the period end. */
function bloodMarkerStatus(n) {
  const byKey = new Map();
  const reports = n.blood.slice().sort((a, b) => dayNum(a.date) - dayNum(b.date));
  for (const r of reports) {
    for (const mk of r.markers || []) {
      const key = String(mk.key || mk.name || '').toLowerCase().trim();
      const v = num(mk.value);
      if (!key || v == null) continue;
      if (!byKey.has(key)) byKey.set(key, { key, name: mk.name || key, unit: mk.unit || '', readings: [] });
      byKey.get(key).readings.push({ date: r.date, value: v, low: num(mk.low), high: num(mk.high), labStatus: mk.labStatus || '' });
    }
  }
  const out = [];
  for (const m of byKey.values()) {
    const last = m.readings[m.readings.length - 1];
    const prev = m.readings.length >= 2 ? m.readings[m.readings.length - 2] : null;
    const low = last.low; const high = last.high;
    const rangeKnown = low != null || high != null;
    // No parseable range: fall back to the lab's own printed flag.
    const lab = String(last.labStatus || '').toLowerCase();
    const labIn = /^(normal|optimal|within|in range|negative|non[- ]?reactive)/.test(lab);
    const labOut = /(high|low|critical|deficien|borderline|abnormal|elevated|insufficien)/.test(lab);
    const hasRange = rangeKnown || labIn || labOut;
    const within = rangeKnown
      ? (low == null || last.value >= low) && (high == null || last.value <= high)
      : (labIn && !labOut);
    const dist = (v) => {
      if (!rangeKnown) return null;
      if (low != null && v < low) return low - v;
      if (high != null && v > high) return v - high;
      return 0;
    };
    let movement = 'flat';
    if (prev) {
      const d0 = dist(prev.value); const d1 = dist(last.value);
      if (d0 != null && d1 != null && d1 < d0) movement = 'improved';
      else if (d0 != null && d1 != null && d1 > d0) movement = 'worsened';
      else movement = last.value === prev.value ? 'flat' : (last.value > prev.value ? 'rose' : 'fell');
    }
    out.push({
      key: m.key, name: m.name, unit: m.unit, value: last.value, date: last.date, low, high,
      previous: prev ? prev.value : null, previousDate: prev ? prev.date : null,
      readings: m.readings.length, hasRange, inRange: hasRange ? within : null,
      status: !hasRange ? 'unknown' : (within ? 'in'
        : (rangeKnown ? (low != null && last.value < low ? 'low' : 'high') : (/low|deficien|insufficien/.test(lab) ? 'low' : 'high'))),
      movement, series: m.readings.map((x) => ({ date: x.date, value: x.value }))
    });
  }
  return out;
}

function healthPillar(n) {
  const body = bodyCompScore(n);
  const markers = bloodMarkerStatus(n);
  const eligible = markers.filter((m) => m.readings >= 2 && m.hasRange);
  const good = eligible.filter((m) => m.inRange || m.movement === 'improved');
  const bloodScore = eligible.length ? good.length / eligible.length : null;
  let score = null;
  if (body && bloodScore != null) score = 100 * (0.5 * body.score + 0.5 * bloodScore);
  else if (body) score = 100 * body.score;
  else if (bloodScore != null) score = 100 * bloodScore;
  return {
    score,
    components: { bodyComp: body ? body.score : null, blood: bloodScore },
    metrics: {
      body,
      bloodEligible: eligible.length, bloodGood: good.length,
      outOfRange: markers.filter((m) => m.inRange === false).length,
      newBodyData: n.weights.length > 0 || n.measurements.length > 0,
      newBloodData: n.bloodInPeriod.length > 0,
      hasData: score != null
    },
    markers
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function computePillars(n, prevN) {
  return {
    workout: workoutPillar(n, prevN),
    nutrition: nutritionPillar(n),
    checkin: checkinPillar(n),
    consistency: consistencyPillar(n),
    yoga: yogaPillar(n, prevN),
    health: healthPillar(n)
  };
}

/**
 * Weekly reports with no new blood/body data move health's 10 points to
 * workout and nutrition (+5 each). A report where health cannot be scored at
 * all (no goal-comparable weights, no marker read twice) does the same, so a
 * missing lab test never costs the client ten points.
 */
function weightsFor(type, health) {
  const noNew = !health.metrics.newBodyData && !health.metrics.newBloodData;
  const redistribute = health.score == null || (type === 'weekly' && noNew);
  if (!redistribute) return { weights: Object.assign({}, BASE_WEIGHTS), redistributed: false, reason: null };
  return {
    weights: Object.assign({}, BASE_WEIGHTS, { workout: 30, nutrition: 30, health: 0 }),
    redistributed: true,
    reason: health.score == null ? 'no-health-data' : 'no-new-health-data'
  };
}

function totalFrom(pillars, weights) {
  let t = 0;
  for (const k of PILLARS) {
    const w = weights[k] || 0;
    if (!w) continue;
    t += (pillars[k].score || 0) * w;
  }
  return t / 100;
}

function hasAnyData(n) {
  return n.workouts.length + n.meals.length + n.checkins.length + n.yoga.length + n.weights.length + n.measurements.length > 0;
}

/**
 * @param {object} current  normalised-or-raw dataset for the period
 * @param {object} previous dataset for the previous period (same length)
 * @param {object} previous2 dataset for the period before that (trend baseline
 *                           for the previous period's volume/mobility), optional
 * @param {'weekly'|'monthly'} type
 */
function scoreDataset(current, previous, previous2, type) {
  const kind = type === 'monthly' ? 'monthly' : 'weekly';
  const n = normalise(current);
  const p = previous ? normalise(previous) : null;
  const p2 = previous2 ? normalise(previous2) : null;

  const cur = computePillars(n, p);
  const cw = weightsFor(kind, cur.health);
  const total = totalFrom(cur, cw.weights);

  let prev = null; let prevTotal = null; let prevHasData = false;
  if (p) {
    prev = computePillars(p, p2);
    const pw = weightsFor(kind, prev.health);
    prevTotal = totalFrom(prev, pw.weights);
    prevHasData = hasAnyData(p);
  }

  const pillars = {};
  for (const k of PILLARS) {
    const c = cur[k];
    const active = (cw.weights[k] || 0) > 0 && c.score != null;
    const score = c.score == null ? null : Math.round(c.score);
    const ps = prev && prev[k].score != null ? Math.round(prev[k].score) : null;
    let delta = null; let trend = 'flat';
    if (score != null && ps != null && prevHasData) {
      delta = score - ps;
      trend = delta >= TREND_FLAT_POINTS ? 'up' : (delta <= -TREND_FLAT_POINTS ? 'down' : 'flat');
    }
    pillars[k] = {
      key: k,
      label: PILLAR_LABELS[k],
      score,
      grade: score == null ? null : gradeFor(score),
      trend,
      deltaPct: delta,
      previousScore: prevHasData ? ps : null,
      weight: cw.weights[k] || 0,
      counted: active,
      components: roundComponents(c.components),
      metrics: c.metrics
    };
  }

  const totalR = Math.round(total);
  const prevR = prevTotal == null ? null : Math.round(prevTotal);
  return {
    type: kind,
    period: { start: n.period.start, end: n.period.end, days: n.period.days },
    previousPeriod: p ? { start: p.period.start, end: p.period.end } : null,
    total: totalR,
    grade: gradeFor(totalR),
    previous: prevHasData ? { total: prevR, grade: gradeFor(prevR) } : null,
    totalDelta: prevHasData ? totalR - prevR : null,
    weights: cw.weights,
    healthRedistributed: cw.redistributed,
    healthNote: cw.reason,
    pillars,
    // Detail the renderer and insight engine read; not part of the score contract.
    detail: {
      days: cur.consistency.days,
      markers: cur.health.markers,
      previousPillars: prev ? Object.fromEntries(PILLARS.map((k) => [k, { metrics: prev[k].metrics }])) : null
    }
  };
}

function roundComponents(c) {
  const out = {};
  for (const [k, v] of Object.entries(c || {})) out[k] = v == null ? null : Math.round(v * 1000) / 1000;
  return out;
}

/**
 * DB-backed entry point. Loads the period plus two previous periods of the same
 * length (trend baselines) and scores them.
 */
async function computeBodyBankScore(userId, startDate, endDate, type, opts) {
  const reportData = require('./reportData');
  const bundle = await reportData.loadReportBundle(userId, startDate, endDate, type, opts);
  return scoreDataset(bundle.current, bundle.previous, bundle.previous2, type);
}

module.exports = {
  computeBodyBankScore,
  scoreDataset,
  gradeFor,
  trendScore,
  previousPeriod,
  addDays,
  daysBetween,
  datesInRange,
  dayNum,
  isoFromDay,
  bloodMarkerStatus: (ds) => bloodMarkerStatus(normalise(ds)),
  BASE_WEIGHTS,
  PILLARS,
  PILLAR_LABELS,
  DEFAULT_TARGETS,
  GRADE_BANDS
};
