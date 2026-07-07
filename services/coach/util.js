'use strict';

/**
 * Small shared helpers for the coach module: timezone-aware "now", safe JSON, ids.
 * No DB / no LLM here.
 */

const DEFAULT_TZ = 'Asia/Kolkata';

/** Returns { ymd:'YYYY-MM-DD', hhmm:'HH:MM', hour:0-23, minute:0-59 } in the given tz. */
function tzNow(tz, date) {
  const zone = tz || DEFAULT_TZ;
  const d = date instanceof Date ? date : new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
  } catch (_) {
    // Bad tz string → fall back to IST so scheduling never crashes.
    return tzNow(DEFAULT_TZ, d);
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some engines emit '24' at midnight
  const minute = parseInt(get('minute'), 10) || 0;
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return { ymd, hhmm: `${hh}:${mm}`, hour, minute };
}

/** "HH:MM" → minutes since midnight, or null. */
function hhmmToMinutes(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `hhmm` inside the quiet window [start, end)? Handles overnight windows
 * (e.g. 21:30 → 07:30) where end < start.
 */
function inQuietHours(hhmm, quietStart, quietEnd) {
  const now = hhmmToMinutes(hhmm);
  const start = hhmmToMinutes(quietStart);
  const end = hhmmToMinutes(quietEnd);
  if (now == null || start == null || end == null) return false;
  if (start === end) return false;
  if (start < end) return now >= start && now < end;      // same-day window
  return now >= start || now < end;                        // overnight window
}

function safeJsonParse(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

function firstName(user) {
  const n = user && (user.first_name || user.name);
  const s = String(n || '').trim();
  return s ? s.split(/\s+/)[0] : 'there';
}

module.exports = { DEFAULT_TZ, tzNow, hhmmToMinutes, inQuietHours, safeJsonParse, firstName };
