const db = require('../config/db');

/**
 * Calculate current streak: consecutive days where workout_completed = true.
 * If today and yesterday true → streak continues. If break → reset.
 */
async function getCurrentStreak(userId) {
  const rows = await db.queryAll(
    `SELECT date(created_at) as d, workout_completed FROM progress_logs 
     WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  if (!rows || rows.length === 0) return 0;

  const byDate = {};
  rows.forEach(r => {
    const d = r.d ? String(r.d).slice(0, 10) : null;
    if (!d) return;
    if (byDate[d] === undefined) byDate[d] = false;
    if (r.workout_completed) byDate[d] = true;
  });

  const sortedDates = Object.keys(byDate).sort().reverse();
  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
    if (!byDate[d]) break;
    const diff = i === 0
      ? Math.floor((new Date() - new Date(d + 'T12:00:00')) / (24 * 60 * 60 * 1000))
      : Math.floor((new Date(sortedDates[i - 1]) - new Date(d)) / (24 * 60 * 60 * 1000));
    if (i === 0 && diff > 1) break;
    if (i > 0 && diff > 1) break;
    streak++;
  }
  return streak;
}

module.exports = { getCurrentStreak };
