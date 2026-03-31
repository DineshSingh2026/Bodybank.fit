const db = require('../config/db');

/**
 * Calculate current streak from engagement days:
 * - any daily_checkins submission OR
 * - any progress_logs entry with workout_completed = true
 * for consecutive days counting backward from latest active day.
 */
async function getCurrentStreak(userId) {
  const [dailyRows, workoutRows] = await Promise.all([
    db.queryAll(
      `SELECT checkin_date as d
       FROM daily_checkins
       WHERE user_id = ?
       ORDER BY checkin_date DESC`,
      [userId]
    ),
    db.queryAll(
      `SELECT date(created_at) as d
       FROM progress_logs
       WHERE user_id = ? AND workout_completed = true
       ORDER BY created_at DESC`,
      [userId]
    )
  ]);
  const activeDateSet = new Set();
  (dailyRows || []).forEach((r) => {
    const d = r && r.d ? String(r.d).slice(0, 10) : '';
    if (d) activeDateSet.add(d);
  });
  (workoutRows || []).forEach((r) => {
    const d = r && r.d ? String(r.d).slice(0, 10) : '';
    if (d) activeDateSet.add(d);
  });
  const sortedDates = Array.from(activeDateSet).sort().reverse();
  if (!sortedDates.length) return 0;

  let streak = 0;

  for (let i = 0; i < sortedDates.length; i++) {
    const d = sortedDates[i];
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
