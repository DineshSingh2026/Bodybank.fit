const db = require('../config/db');

/**
 * Goal Completion % = ((start_weight - current_weight) / (start_weight - target_weight)) * 100
 * Returns percentage 0-100+ or null if no goal/start/target.
 */
async function getGoalCompletionPercent(userId) {
  const goal = await db.queryOne(
    'SELECT target_weight FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  if (!goal || goal.target_weight == null) return null;

  const firstLog = await db.queryOne(
    'SELECT weight FROM progress_logs WHERE user_id = ? AND weight IS NOT NULL ORDER BY created_at ASC LIMIT 1',
    [userId]
  );
  const startWeight = firstLog?.weight != null ? parseFloat(firstLog.weight) : null;
  const targetWeight = parseFloat(goal.target_weight);

  const latestLog = await db.queryOne(
    'SELECT weight FROM progress_logs WHERE user_id = ? AND weight IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  const currentWeight = latestLog?.weight != null ? parseFloat(latestLog.weight) : null;

  if (startWeight == null || currentWeight == null) return null;
  const denom = startWeight - targetWeight;
  if (Math.abs(denom) < 0.01) return 100;
  const pct = ((startWeight - currentWeight) / denom) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

async function getOrCreateGoals(userId, defaults = {}) {
  let g = await db.queryOne('SELECT * FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  if (!g) {
    await db.query(
      `INSERT INTO user_goals (user_id, target_weight, target_body_fat, weekly_workout_target) VALUES (?, ?, ?, ?)`,
      [userId, defaults.target_weight ?? null, defaults.target_body_fat ?? null, defaults.weekly_workout_target ?? null]
    );
    g = await db.queryOne('SELECT * FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  }
  return g;
}

module.exports = { getGoalCompletionPercent, getOrCreateGoals };
