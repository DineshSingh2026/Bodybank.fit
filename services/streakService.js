const db = require('../config/db');

/**
 * Normalize DB date / Date → YYYY-MM-DD (UTC calendar day), matching /api/daily-checkin/streak.
 */
function toDateStr(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Daily check-in streak — same algorithm as GET /api/daily-checkin/streak (user dashboard).
 */
async function getCurrentStreak(userId) {
  const rows = await db.queryAll(
    `SELECT checkin_date FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365`,
    [userId]
  );
  if (!rows || !rows.length) return 0;
  const today = toDateStr(new Date());
  const dates = new Set(rows.map((r) => toDateStr(r.checkin_date)).filter(Boolean));
  const todaySaved = dates.has(today);
  let streak = 0;
  const d = new Date();
  if (!todaySaved) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const ds = toDateStr(d);
    if (!ds || !dates.has(ds)) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

module.exports = { getCurrentStreak, toDateStr };
