'use strict';

/**
 * Gathers the deterministic, real-data facts about a user that ground every message
 * (so the LLM never has to invent a number). Produces a structured object + a compact
 * STATS string. Every query is defensive: a missing table/column degrades that field
 * to null rather than failing the whole build.
 */

const { tzNow, firstName } = require('./util');

async function safe(fn, fb) { try { return await fn(); } catch (_) { return fb; } }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function gatherFacts(ctx, userId, tz) {
  const ymd = tzNow(tz).ymd;
  const proteinTarget = Number(process.env.COACH_PROTEIN_TARGET || 150);

  const user = await safe(() => ctx.queryOne(
    'SELECT first_name, goal_type, timezone FROM users WHERE id = ?', [userId]
  ), null);

  const profile = await safe(() => ctx.queryOne(
    'SELECT health_score, weak_dimension, streak_days, longest_streak, last_active_at FROM coach_user_profile WHERE user_id = ?',
    [userId]
  ), null);

  const goal = await safe(() => ctx.queryOne(
    'SELECT target_weight, weekly_workout_target FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId]
  ), null);

  const todayCheckin = await safe(() => ctx.queryOne(
    'SELECT * FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date LIMIT 1',
    [userId, ymd]
  ), null);

  const mealsToday = await safe(async () => {
    const r = await ctx.queryOne(
      'SELECT COUNT(*)::int AS n FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date',
      [userId, ymd]
    );
    return r ? Number(r.n) : 0;
  }, 0);

  const proteinToday = await safe(async () => {
    const r = await ctx.queryOne(
      `SELECT COALESCE(SUM((ai_result->>'protein')::int), 0) AS p
       FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date`,
      [userId, ymd]
    );
    return r && r.p != null ? Number(r.p) : null;
  }, null);

  const workoutToday = await safe(async () => {
    const r = await ctx.queryOne(
      `SELECT 1 FROM workout_logs
       WHERE user_id = ? AND COALESCE(session_date, created_at::date) = ?::date LIMIT 1`,
      [userId, ymd]
    );
    return !!r;
  }, false);

  const week = await safe(async () => {
    const wk = await ctx.queryOne(
      `SELECT
         (SELECT COUNT(DISTINCT COALESCE(session_date, created_at::date))::int FROM workout_logs
            WHERE user_id = ? AND COALESCE(session_date, created_at::date) >= CURRENT_DATE - INTERVAL '6 days') AS workouts,
         (SELECT COUNT(*)::int FROM daily_checkins
            WHERE user_id = ? AND checkin_date >= CURRENT_DATE - INTERVAL '6 days') AS checkins,
         (SELECT COUNT(DISTINCT log_date)::int FROM nutrition_meal_logs
            WHERE user_id = ? AND log_date >= CURRENT_DATE - INTERVAL '6 days') AS mealdays`,
      [userId, userId, userId]
    );
    return wk || {};
  }, {});

  // daily_checkins columns: steps, water_ml, protein_g, sleep_hours.
  const cWater = todayCheckin ? (todayCheckin.water_ml != null ? todayCheckin.water_ml : todayCheckin.water) : null;
  const cProtein = todayCheckin ? (todayCheckin.protein_g != null ? todayCheckin.protein_g : todayCheckin.protein) : null;
  const cSleep = todayCheckin ? (todayCheckin.sleep_hours != null ? todayCheckin.sleep_hours : todayCheckin.sleep) : null;

  return {
    ymd,
    name: firstName(user),
    goalType: user && user.goal_type ? String(user.goal_type) : null,
    targetWeight: goal ? num(goal.target_weight) : null,
    weeklyWorkoutTarget: goal ? num(goal.weekly_workout_target) : null,
    healthScore: profile ? num(profile.health_score) : null,
    weakDimension: profile ? profile.weak_dimension : null,
    streak: profile ? num(profile.streak_days) : null,
    longestStreak: profile ? num(profile.longest_streak) : null,
    lastActiveAt: profile ? profile.last_active_at : null,
    today: {
      proteinFromMeals: proteinToday,
      proteinTarget,
      checkinProtein: num(cProtein),
      water: num(cWater),
      steps: todayCheckin ? num(todayCheckin.steps) : null,
      sleep: num(cSleep),
      mealsLogged: mealsToday,
      workoutDone: workoutToday
    },
    week: {
      workouts: num(week.workouts),
      checkins: num(week.checkins),
      mealDays: num(week.mealdays)
    }
  };
}

/** Compact, numeric-first STATS block for the generation prompt. Only real numbers. */
function buildStatsString(facts) {
  const L = [];
  L.push(`User: ${facts.name}${facts.goalType ? ` — goal: ${facts.goalType}` : ''}`);
  if (facts.targetWeight != null) L.push(`Target weight: ${facts.targetWeight}kg`);
  if (facts.healthScore != null) L.push(`Health score: ${facts.healthScore}/100${facts.weakDimension ? ` (weakest: ${facts.weakDimension})` : ''}`);
  if (facts.streak != null) L.push(`Current check-in streak: ${facts.streak} day(s)${facts.longestStreak ? `, best ${facts.longestStreak}` : ''}`);

  const t = facts.today;
  const todayBits = [];
  const proteinToday = t.proteinFromMeals != null ? t.proteinFromMeals : t.checkinProtein;
  if (proteinToday != null) todayBits.push(`protein ${proteinToday}g/${t.proteinTarget}g`);
  if (t.water != null) todayBits.push(`water ${t.water}`);
  if (t.steps != null) todayBits.push(`steps ${t.steps}`);
  if (t.sleep != null) todayBits.push(`sleep ${t.sleep}h`);
  todayBits.push(`meals logged ${t.mealsLogged}`);
  todayBits.push(`workout today: ${t.workoutDone ? 'yes' : 'not yet'}`);
  L.push(`Today: ${todayBits.join(', ')}`);

  const w = facts.week;
  const weekBits = [];
  if (w.workouts != null) weekBits.push(`${w.workouts} workout day(s)`);
  if (w.checkins != null) weekBits.push(`${w.checkins} check-in(s)`);
  if (w.mealDays != null) weekBits.push(`${w.mealDays} day(s) with meals logged`);
  if (weekBits.length) L.push(`Last 7 days: ${weekBits.join(', ')}`);

  return L.join('\n');
}

module.exports = { gatherFacts, buildStatsString };
