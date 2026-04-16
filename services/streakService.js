const db = require('../config/db');

/** Bodybank product default: compare “today” to calendar check-in dates in IST. */
const STREAK_TZ = 'Asia/Kolkata';

/**
 * Normalize DB date / Date → YYYY-MM-DD (never String(date).slice — pg Date → "Wed Apr 01…").
 */
function toDateStr(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function todayYmdInTz(timeZone) {
  try {
    const s = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return s.length >= 10 ? s.slice(0, 10) : null;
  } catch {
    return toDateStr(new Date());
  }
}

function addCalendarDaysYmd(ymd, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Shared by GET /api/daily-checkin/streak and getCurrentStreak (no duplicate DB + logic drift).
 *  @param {string|null} userTimezone - IANA timezone string; falls back to STREAK_TZ (IST) if not provided.
 */
function computeStreakState(rows, todayOverrideYmd, userTimezone) {
  const tz = (userTimezone && typeof userTimezone === 'string' && userTimezone.trim()) ? userTimezone.trim() : STREAK_TZ;
  const today = todayOverrideYmd || todayYmdInTz(tz) || toDateStr(new Date());
  const dates = new Set((rows || []).map((r) => toDateStr(r.checkin_date)).filter(Boolean));
  const todaySaved = today ? dates.has(today) : false;
  let streak = 0;
  let cursor = todaySaved ? today : addCalendarDaysYmd(today, -1);
  for (let i = 0; i < 365; i++) {
    if (!cursor || !dates.has(cursor)) break;
    streak++;
    cursor = addCalendarDaysYmd(cursor, -1);
  }
  return { today, todaySaved, dates, streak };
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
  return computeStreakState(rows, null).streak;
}

/**
 * Streak as of end of calendar day `asOfStr` (YYYY-MM-DD), using only check-ins on/before that day.
 * Mirrors the loop in getCurrentStreak with a fixed "today" = asOfStr.
 */
function streakAsOfEndOfDay(allDatesSet, asOfStr) {
  if (!asOfStr || !/^(\d{4})-(\d{2})-(\d{2})$/.test(String(asOfStr).trim())) return 0;
  const dates = new Set([...allDatesSet].filter((x) => x <= asOfStr));
  const todaySaved = dates.has(asOfStr);
  let streak = 0;
  let cursor = todaySaved ? asOfStr : addCalendarDaysYmd(asOfStr, -1);
  for (let i = 0; i < 365; i++) {
    if (!cursor || !dates.has(cursor)) break;
    streak++;
    cursor = addCalendarDaysYmd(cursor, -1);
  }
  return streak;
}

/**
 * Last 120 calendar days ending user's "today" (per their timezone), one point per day.
 * @param {Array<{checkin_date?: string}>} rows - daily_checkins rows or plain date strings
 * @param {string|null} userTimezone - IANA timezone string; falls back to STREAK_TZ (IST) if not provided.
 * @returns {Array<{ date: string, streak: number }>}
 */
function buildStreakHistoryFromCheckinRows(rows, userTimezone) {
  const tz = (userTimezone && typeof userTimezone === 'string' && userTimezone.trim()) ? userTimezone.trim() : STREAK_TZ;
  const all = new Set();
  (rows || []).forEach((r) => {
    const raw = typeof r === 'string' ? r : r && r.checkin_date;
    const s = toDateStr(raw);
    if (s) all.add(s);
  });
  const anchor = todayYmdInTz(tz) || toDateStr(new Date());
  if (!anchor) return [];
  const out = [];
  for (let i = 119; i >= 0; i--) {
    const asOfStr = addCalendarDaysYmd(anchor, -i);
    if (!asOfStr) continue;
    out.push({ date: asOfStr, streak: streakAsOfEndOfDay(all, asOfStr) });
  }
  return out;
}

module.exports = {
  getCurrentStreak,
  toDateStr,
  buildStreakHistoryFromCheckinRows,
  streakAsOfEndOfDay,
  addCalendarDaysYmd,
  todayYmdInTz,
  computeStreakState,
  STREAK_TZ
};
