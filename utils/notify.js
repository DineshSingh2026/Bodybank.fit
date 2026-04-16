'use strict';

const { sendWhatsApp } = require('../services/whatsapp');

const PRIORITY = { CRITICAL: 'CRITICAL', IMPORTANT: 'IMPORTANT', INFO: 'INFO' };
const EVENT_META = {
  USER_SIGNUP: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_SIGNUP_GOOGLE: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_LOGIN: { priority: PRIORITY.INFO, dedup: 10 * 60 * 1000 },
  PASSWORD_RESET_REQUEST: { priority: PRIORITY.IMPORTANT, dedup: 5 * 60 * 1000 },
  PASSWORD_RESET_DONE: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_APPROVED: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_REJECTED: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_SUSPENDED: { priority: PRIORITY.CRITICAL, dedup: 0 },
  USER_REACTIVATED: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_DELETED: { priority: PRIORITY.CRITICAL, dedup: 0 },
  DAILY_CHECKIN: { priority: PRIORITY.INFO, dedup: 10 * 60 * 1000 },
  SUNDAY_CHECKIN: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  WORKOUT_LOGGED: { priority: PRIORITY.INFO, dedup: 10 * 60 * 1000 },
  PART2_FORM: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  MEETING_SCHEDULED: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  CONTACT_MESSAGE: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  NUTRITION_MEAL_LOGGED: { priority: PRIORITY.INFO, dedup: 10 * 60 * 1000 },
  NUTRITION_DAY_COMPLETE: { priority: PRIORITY.IMPORTANT, dedup: 5 * 60 * 1000 },
  BLOOD_REPORT_UPLOADED: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  BLOOD_REPORT_SENT: { priority: PRIORITY.IMPORTANT, dedup: 0 },
  FEED_POST_UPLOADED: { priority: PRIORITY.INFO, dedup: 5 * 60 * 1000 },
  COIN_EARNED: { priority: PRIORITY.INFO, dedup: 10 * 60 * 1000 },
  COIN_PENALTY: { priority: PRIORITY.INFO, dedup: 10 * 60 * 1000 },
  DAILY_COMPLIANCE_SENT: { priority: PRIORITY.IMPORTANT, dedup: 60 * 60 * 1000 },
  DAILY_DIGEST: { priority: PRIORITY.IMPORTANT, dedup: 60 * 60 * 1000 },
  SERVER_ERROR: { priority: PRIORITY.CRITICAL, dedup: 3 * 60 * 1000 }
};

const _dedup = new Map();
function s(v) { return (v === null || v === undefined || v === '') ? '—' : String(v).trim() || '—'; }
function ts() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
  });
}
function tierIcon(t) { return t === PRIORITY.CRITICAL ? '🔴' : (t === PRIORITY.IMPORTANT ? '🟡' : '🟢'); }
function isDup(fp, ttl) { const t = _dedup.get(fp); return !!(ttl && t && (Date.now() - t < ttl)); }
function mark(fp) { _dedup.set(fp, Date.now()); }
function userLines(p) { return [`👤 ${s(p.name)}`, `📧 ${s(p.email)}`, `📱 ${s(p.mobile || p.phone)}`]; }

const FORMATTERS = {
  USER_SIGNUP: (p) => ['🆕 New Signup', ...userLines(p), `🌍 ${s(p.country)}`, `⏰ ${ts()}`],
  USER_SIGNUP_GOOGLE: (p) => ['🆕 New Signup (Google)', ...userLines(p), `⏰ ${ts()}`],
  USER_LOGIN: (p) => ['🔐 User Login', ...userLines(p), `⏰ ${ts()}`],
  PASSWORD_RESET_REQUEST: (p) => ['🔑 Password Reset Requested', `📧 ${s(p.email)}`, `⏰ ${ts()}`],
  PASSWORD_RESET_DONE: (p) => ['✅ Password Reset Complete', `📧 ${s(p.email)}`, `⏰ ${ts()}`],
  USER_APPROVED: (p) => ['✅ User Approved', ...userLines(p), `⏰ ${ts()}`],
  USER_REJECTED: (p) => ['❌ User Rejected', ...userLines(p), `⏰ ${ts()}`],
  USER_SUSPENDED: (p) => ['🚫 User Suspended', ...userLines(p), `⏰ ${ts()}`],
  USER_REACTIVATED: (p) => ['♻️ User Reactivated', ...userLines(p), `⏰ ${ts()}`],
  USER_DELETED: (p) => ['🗑️ User Deleted', ...userLines(p), `⏰ ${ts()}`],
  DAILY_CHECKIN: (p) => ['📋 Daily Check-in', ...userLines(p), `👣 Steps: ${s(p.steps)}`, `💧 Water: ${s(p.water)}`, `🥩 Protein: ${s(p.protein)}`, `😴 Sleep: ${s(p.sleep)}`, `⏰ ${ts()}`],
  SUNDAY_CHECKIN: (p) => ['📝 Sunday Check-in', ...userLines(p), `🏋️ Training: ${s(p.training)}`, `🥗 Nutrition: ${s(p.nutrition)}`, `⏰ ${ts()}`],
  WORKOUT_LOGGED: (p) => ['🏋️ Workout Logged', ...userLines(p), `🎯 Type: ${s(p.type)}`, `⏱ Duration: ${s(p.duration)}`, `⏰ ${ts()}`],
  PART2_FORM: (p) => ['📋 Part-2 Form Submitted', ...userLines(p), `🎯 Goals: ${s(p.goals)}`, `⏰ ${ts()}`],
  MEETING_SCHEDULED: (p) => ['📅 Call Scheduled', ...userLines(p), `📆 Date: ${s(p.date)}`, `🕐 Slot: ${s(p.slot)}`, `⏰ ${ts()}`],
  CONTACT_MESSAGE: (p) => ['💬 Contact Message', ...userLines(p), `📝 ${String(p.message || '').slice(0, 180)}`, `⏰ ${ts()}`],
  NUTRITION_MEAL_LOGGED: (p) => ['🍽️ Meal Logged', ...userLines(p), `🥗 Meal: ${s(p.mealType)}`, `📅 Date: ${s(p.date)}`, `⭐ Score: ${s(p.score)}`, `🔥 Calories: ${s(p.calories)}`, `🥩 Protein: ${s(p.protein)}`, `⏰ ${ts()}`],
  NUTRITION_DAY_COMPLETE: (p) => ['🌟 Nutrition Day Complete', ...userLines(p), `📅 Date: ${s(p.date)}`, `🍽️ Meals: ${s(p.meals)}/4`, `⏰ ${ts()}`],
  BLOOD_REPORT_UPLOADED: (p) => ['🩸 Blood Report Uploaded', ...userLines(p), `🎯 Goal: ${s(p.goal)}`, `⏰ ${ts()}`],
  BLOOD_REPORT_SENT: (p) => ['📤 Blood Report Sent to User', ...userLines(p), `⏰ ${ts()}`],
  FEED_POST_UPLOADED: (p) => ['📸 Feed Post Uploaded', `👤 ${s(p.username)}`, `📝 ${String(p.caption || '').slice(0, 120)}`, `⏰ ${ts()}`],
  COIN_EARNED: (p) => ['🪙 Coins Earned', ...userLines(p), `➕ +${s(p.delta)} (${s(p.reason)})`, `💰 Balance: ${s(p.balance)}`, `⏰ ${ts()}`],
  COIN_PENALTY: (p) => ['⚠️ Coin Penalty', ...userLines(p), `➖ ${s(p.delta)} (${s(p.reason)})`, `💰 Balance: ${s(p.balance)}`, `⏰ ${ts()}`],
  DAILY_COMPLIANCE_SENT: (p) => ['📊 Daily Compliance Report Sent', `👥 Total: ${s(p.total)}`, `✅ Check-ins: ${s(p.checkedIn)}`, `❌ Missed: ${s(p.missed)}`, `📈 Rate: ${s(p.rate)}`, `⏰ ${ts()}`],
  DAILY_DIGEST: (p) => ['📋 Daily Executive Digest', `📅 Date: ${s(p.date)}`, `👥 Active Users: ${s(p.totalUsers)}`, `🆕 Signups: ${s(p.signups)}`, `🔐 Logins: ${s(p.logins)}`, `📋 Check-ins: ${s(p.checkins)}`, `🏋️ Workouts: ${s(p.workouts)}`, `🍽️ Meals: ${s(p.meals)}`, `🩸 Blood Reports: ${s(p.bloodReports)}`, `💬 Messages: ${s(p.messages)}`, `🪙 Coins Awarded: ${s(p.coinsAwarded)}`],
  SERVER_ERROR: (p) => ['🔴 Server Error', `📌 ${s(p.action)}`, `💥 ${String(p.error || '').slice(0, 300)}`, `⏰ ${ts()}`]
};

function buildMessage(eventType, lines, priority) {
  return [`${tierIcon(priority)} BodyBank Admin Update`, `Event: ${eventType}`, ...lines].join('\n');
}

async function notify(eventType, payload = {}, opts = {}) {
  try {
    const formatter = FORMATTERS[eventType];
    if (!formatter) return;
    const meta = EVENT_META[eventType] || { priority: PRIORITY.INFO, dedup: 5 * 60 * 1000 };
    const ttl = opts.noDedup ? 0 : meta.dedup;
    const fp = `${eventType}::${s(payload.email || payload.userId || payload.username || payload.action || '')}`;
    if (isDup(fp, ttl)) return;
    mark(fp);
    await sendWhatsApp(buildMessage(eventType, formatter(payload), meta.priority));
  } catch (err) {
    console.error('[notify] unexpected error:', err.message);
  }
}

function notifyAsync(eventType, payload, opts) {
  notify(eventType, payload, opts).catch(() => {});
}

module.exports = { notify, notifyAsync, FORMATTERS, EVENT_META, PRIORITY };
