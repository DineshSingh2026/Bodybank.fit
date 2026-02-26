const db = require('../config/db');
const { getCurrentStreak } = require('./streakService');
const { getGoalCompletionPercent } = require('./goalService');
const { getInsights } = require('./insightService');

async function insertProgress(userId, data) {
  const {
    log_date,
    weight, body_fat, calories_intake, protein_intake,
    workout_completed, workout_type, strength_bench, strength_squat, strength_deadlift,
    sleep_hours, water_intake
  } = data;
  // Use log_date for created_at if provided (YYYY-MM-DD or ISO string); otherwise server now
  let createdAt = null;
  if (log_date && String(log_date).trim()) {
    const d = new Date(String(log_date).trim());
    if (!isNaN(d.getTime())) createdAt = d.toISOString().slice(0, 19).replace('T', ' ');
  }
  await db.query(
    `INSERT INTO progress_logs (
      user_id, weight, body_fat, calories_intake, protein_intake,
      workout_completed, workout_type, strength_bench, strength_squat, strength_deadlift,
      sleep_hours, water_intake, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [
      userId,
      weight != null ? parseFloat(weight) : null,
      body_fat != null ? parseFloat(body_fat) : null,
      calories_intake != null ? parseInt(calories_intake, 10) : null,
      protein_intake != null ? parseInt(protein_intake, 10) : null,
      !!workout_completed,
      workout_type || null,
      strength_bench != null ? parseFloat(strength_bench) : null,
      strength_squat != null ? parseFloat(strength_squat) : null,
      strength_deadlift != null ? parseFloat(strength_deadlift) : null,
      sleep_hours != null ? parseFloat(sleep_hours) : null,
      water_intake != null ? parseFloat(water_intake) : null,
      createdAt
    ]
  );
}

async function getProgressForUser(userId, limit = 365) {
  const rows = await db.queryAll(
    'SELECT * FROM progress_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );
  return rows;
}

async function getProgressWithMeta(userId) {
  const logs = await getProgressForUser(userId);
  const streak = await getCurrentStreak(userId);
  const goalPct = await getGoalCompletionPercent(userId);
  const insights = await getInsights(userId);
  return { logs, streak, goalCompletionPercent: goalPct, insights };
}

async function getAdminUserProgress(userId) {
  const logs = await db.queryAll(
    'SELECT * FROM progress_logs WHERE user_id = ? ORDER BY created_at ASC',
    [userId]
  );
  const streak = await getCurrentStreak(userId);
  const goalPct = await getGoalCompletionPercent(userId);
  const insights = await getInsights(userId);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recent = logs.filter(l => new Date(l.created_at) >= thirtyDaysAgo);
  const withWeight = logs.filter(l => l.weight != null);
  const currentWeight = withWeight.length ? parseFloat(withWeight[withWeight.length - 1].weight) : null;
  const weight30Ago = recent.length ? (() => {
    const past = logs.filter(l => new Date(l.created_at) <= thirtyDaysAgo);
    const w = past.filter(l => l.weight != null);
    return w.length ? parseFloat(w[w.length - 1].weight) : null;
  })() : null;
  const weightChange = (currentWeight != null && weight30Ago != null && weight30Ago !== 0)
    ? (((currentWeight - weight30Ago) / weight30Ago) * 100).toFixed(1)
    : null;

  const withStrength = logs.filter(l => l.strength_bench != null || l.strength_squat != null || l.strength_deadlift != null);
  let strengthGrowth = null;
  if (withStrength.length >= 2) {
    const first = withStrength[0];
    const last = withStrength[withStrength.length - 1];
    const firstAvg = [first.strength_bench, first.strength_squat, first.strength_deadlift].filter(Boolean).reduce((a, b) => a + parseFloat(b), 0) / 3;
    const lastAvg = [last.strength_bench, last.strength_squat, last.strength_deadlift].filter(Boolean).reduce((a, b) => a + parseFloat(b), 0) / 3;
    if (firstAvg > 0) strengthGrowth = (((lastAvg - firstAvg) / firstAvg) * 100).toFixed(1);
  }

  const total = logs.length;
  const workoutCount = logs.filter(l => l.workout_completed).length;
  const consistency = total > 0 ? ((workoutCount / total) * 100).toFixed(1) : 0;
  const avgCalories = logs.filter(l => l.calories_intake != null).length
    ? (logs.reduce((s, l) => s + (parseInt(l.calories_intake, 10) || 0), 0) / logs.filter(l => l.calories_intake != null).length).toFixed(0)
    : null;
  const avgSleep = logs.filter(l => l.sleep_hours != null).length
    ? (logs.reduce((s, l) => s + (parseFloat(l.sleep_hours) || 0), 0) / logs.filter(l => l.sleep_hours != null).length).toFixed(1)
    : null;

  return {
    currentWeight,
    weightChangePercent: weightChange,
    strengthGrowthPercent: strengthGrowth,
    workoutConsistencyPercent: consistency,
    activeStreak: streak,
    goalCompletionPercent: goalPct,
    averageCalories: avgCalories,
    averageSleep: avgSleep,
    insights,
    logs
  };
}

module.exports = { insertProgress, getProgressForUser, getProgressWithMeta, getAdminUserProgress };
