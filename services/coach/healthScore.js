'use strict';

/**
 * A 0..100 composite health score, recomputed nightly, that *drives coaching* rather
 * than being a vanity number. Reads existing BodyBank tables (daily_checkins,
 * workout_logs, nutrition_meal_logs). Every sub-metric is wrapped so a missing column
 * or table degrades that dimension gracefully instead of crashing the whole score.
 *
 * The biggest negative driver becomes `weak_dimension`, which the Decision Engine's
 * user_fit factor uses to focus the coach on the weakest lever.
 */

const DIMENSIONS = [
  { key: 'workouts',    weight: 25, target: 4 },  // sessions / 7d
  { key: 'nutrition',   weight: 20, target: 5 },  // days with a meal / 7d
  { key: 'consistency', weight: 20, target: 6 },  // daily check-ins / 7d
  { key: 'protein',     weight: 15 },             // avg protein vs target
  { key: 'sleep',       weight: 10, target: 7 },  // avg sleep hours
  { key: 'streak',      weight: 10, target: 7 }   // current streak days
];

async function safeVal(fn, fallback) {
  try {
    const v = await fn();
    return v;
  } catch (_) {
    return fallback;
  }
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * @param {object} ctx  { queryOne }
 * @param {string} userId
 * @returns {Promise<{ score:number, breakdown:object, weak_dimension:string }>}
 */
async function computeHealthScore(ctx, userId) {
  const proteinTarget = Number(process.env.COACH_PROTEIN_TARGET || 150);

  const workoutDays = await safeVal(async () => {
    const r = await ctx.queryOne(
      `SELECT COUNT(DISTINCT COALESCE(session_date, created_at::date))::int AS n
       FROM workout_logs
       WHERE user_id = ?
         AND COALESCE(session_date, created_at::date) >= CURRENT_DATE - INTERVAL '6 days'`,
      [userId]
    );
    return r ? Number(r.n) : null;
  }, null);

  const mealDays = await safeVal(async () => {
    const r = await ctx.queryOne(
      `SELECT COUNT(DISTINCT log_date)::int AS n
       FROM nutrition_meal_logs
       WHERE user_id = ? AND log_date >= CURRENT_DATE - INTERVAL '6 days'`,
      [userId]
    );
    return r ? Number(r.n) : null;
  }, null);

  const checkinDays = await safeVal(async () => {
    const r = await ctx.queryOne(
      `SELECT COUNT(*)::int AS n
       FROM daily_checkins
       WHERE user_id = ? AND checkin_date >= CURRENT_DATE - INTERVAL '6 days'`,
      [userId]
    );
    return r ? Number(r.n) : null;
  }, null);

  const avgProtein = await safeVal(async () => {
    const r = await ctx.queryOne(
      `SELECT AVG(NULLIF(protein_g, 0)) AS a
       FROM daily_checkins
       WHERE user_id = ? AND checkin_date >= CURRENT_DATE - INTERVAL '6 days'`,
      [userId]
    );
    return r && r.a != null ? Number(r.a) : null;
  }, null);

  const avgSleep = await safeVal(async () => {
    const r = await ctx.queryOne(
      `SELECT AVG(NULLIF(sleep_hours, 0)) AS a
       FROM daily_checkins
       WHERE user_id = ? AND checkin_date >= CURRENT_DATE - INTERVAL '6 days'`,
      [userId]
    );
    return r && r.a != null ? Number(r.a) : null;
  }, null);

  const streak = await safeVal(async () => {
    const r = await ctx.queryOne(
      `SELECT streak_days FROM coach_user_profile WHERE user_id = ?`,
      [userId]
    );
    return r && r.streak_days != null ? Number(r.streak_days) : null;
  }, null);

  const raw = {
    workouts: workoutDays == null ? null : clamp01(workoutDays / 4),
    nutrition: mealDays == null ? null : clamp01(mealDays / 5),
    consistency: checkinDays == null ? null : clamp01(checkinDays / 6),
    protein: avgProtein == null ? null : clamp01(avgProtein / proteinTarget),
    sleep: avgSleep == null ? null : clamp01(avgSleep / 7),
    streak: streak == null ? null : clamp01(streak / 7)
  };

  // Weighted average over only the dimensions we actually have data for.
  let weightSum = 0;
  let scoreSum = 0;
  const breakdown = {};
  let weakDim = null;
  let weakVal = Infinity;
  for (const d of DIMENSIONS) {
    const v = raw[d.key];
    if (v == null) { breakdown[d.key] = null; continue; }
    breakdown[d.key] = Math.round(v * 100);
    weightSum += d.weight;
    scoreSum += v * d.weight;
    if (v < weakVal) { weakVal = v; weakDim = d.key; }
  }

  const score = weightSum > 0 ? Math.round((scoreSum / weightSum) * 100) : null;
  return { score, breakdown, weak_dimension: weakDim, raw };
}

module.exports = { computeHealthScore, DIMENSIONS };
