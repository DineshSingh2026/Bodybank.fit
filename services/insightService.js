const db = require('../config/db');

/**
 * Logic-based AI insights.
 */
async function getInsights(userId) {
  const insights = [];
  const logs = await db.queryAll(
    'SELECT * FROM progress_logs WHERE user_id = ? ORDER BY created_at ASC',
    [userId]
  );
  if (!logs || logs.length === 0) return insights;

  const total = logs.length;
  const withWorkout = logs.filter(l => l.workout_completed);
  const consistency = total > 0 ? (withWorkout.length / total) * 100 : 0;
  if (consistency < 60) {
    insights.push('Consistency Needs Improvement');
  }

  const weights = logs.filter(l => l.weight != null).map(l => parseFloat(l.weight));
  if (weights.length >= 14) {
    const last14 = weights.slice(-14);
    const avg = last14.reduce((a, b) => a + b, 0) / last14.length;
    const allSame = last14.every(w => Math.abs(w - avg) < 0.5);
    if (allSame) {
      insights.push('Weight Plateau Detected');
    }
  }

  const withStrength = logs.filter(l => l.strength_bench != null || l.strength_squat != null || l.strength_deadlift != null);
  if (withStrength.length >= 2) {
    const first = withStrength[0];
    const last = withStrength[withStrength.length - 1];
    const firstAvg = [first.strength_bench, first.strength_squat, first.strength_deadlift].filter(Boolean).reduce((a, b) => a + parseFloat(b), 0) / 3;
    const lastAvg = [last.strength_bench, last.strength_squat, last.strength_deadlift].filter(Boolean).reduce((a, b) => a + parseFloat(b), 0) / 3;
    if (firstAvg > 0 && lastAvg > 0) {
      const growth = ((lastAvg - firstAvg) / firstAvg) * 100;
      if (growth > 10) {
        insights.push('Strength Milestone Achieved');
      }
    }
  }

  return insights;
}

module.exports = { getInsights };
