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

/**
 * Streak as of end of calendar day `asOfStr` (YYYY-MM-DD), using only check-ins on/before that day.
 * Mirrors the loop in getCurrentStreak with a fixed "today" = asOfStr.
 */
function streakAsOfEndOfDay(allDatesSet, asOfStr) {
  const dates = new Set([...allDatesSet].filter((x) => x <= asOfStr));
  const todaySaved = dates.has(asOfStr);
  let streak = 0;
  const d = new Date(asOfStr + 'T12:00:00');
  if (isNaN(d.getTime())) return 0;
  if (!todaySaved) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const ds = toDateStr(d);
    if (!ds || !dates.has(ds)) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function addDaysYmd(ymd, deltaDays) {
  const parts = String(ymd || '').split('-').map(Number);
  if (parts.length < 3) return null;
  const dt = new Date(parts[0], parts[1] - 1, parts[2] + deltaDays);
  return toDateStr(dt);
}

/**
 * Last 120 calendar days ending server "today" (same anchor as getCurrentStreak), one point per day.
 * @param {Array<{checkin_date?: string}>} rows - daily_checkins rows or plain date strings
 * @returns {Array<{ date: string, streak: number }>}
 */
function buildStreakHistoryFromCheckinRows(rows) {
  const all = new Set();
  (rows || []).forEach((r) => {
    const raw = typeof r === 'string' ? r : r && r.checkin_date;
    const s = toDateStr(raw);
    if (s) all.add(s);
  });
  const anchor = toDateStr(new Date());
  if (!anchor) return [];
  const out = [];
  for (let i = 119; i >= 0; i--) {
    const asOfStr = addDaysYmd(anchor, -i);
    if (!asOfStr) continue;
    out.push({ date: asOfStr, streak: streakAsOfEndOfDay(all, asOfStr) });
  }
  return out;
}

module.exports = {
  getCurrentStreak,
  toDateStr,
  buildStreakHistoryFromCheckinRows,
  streakAsOfEndOfDay
};
