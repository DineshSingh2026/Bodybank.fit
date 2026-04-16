'use strict';

// BodyBank — Centralized admin WhatsApp notification utility
// Phase 2: priority tiers, luxury formatting, noise control, dedup.
// All sends are non-blocking. App NEVER crashes if this fails.

const { sendWhatsApp } = require('../services/whatsapp');

// ── Priority tiers ───────────────────────────────────────────────────
// CRITICAL  → always send immediately
// IMPORTANT → send immediately; dedup 5 min
// INFO      → dedup 10 min (reduces noise for frequent actions)
const PRIORITY = {
  CRITICAL  : 'CRITICAL',
  IMPORTANT : 'IMPORTANT',
  INFO      : 'INFO'
};

const EVENT_META = {
  // Auth
  USER_SIGNUP              : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_SIGNUP_GOOGLE       : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_LOGIN               : { priority: PRIORITY.INFO,      dedup: 10 * 60 * 1000 },
  PASSWORD_RESET_REQUEST   : { priority: PRIORITY.IMPORTANT, dedup: 5  * 60 * 1000 },
  PASSWORD_RESET_DONE      : { priority: PRIORITY.IMPORTANT, dedup: 0 },

  // Admin actions
  USER_APPROVED            : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_REJECTED            : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_SUSPENDED           : { priority: PRIORITY.CRITICAL,  dedup: 0 },
  USER_REACTIVATED         : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  USER_DELETED             : { priority: PRIORITY.CRITICAL,  dedup: 0 },

  // Daily activity
  DAILY_CHECKIN            : { priority: PRIORITY.INFO,      dedup: 10 * 60 * 1000 },
  SUNDAY_CHECKIN           : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  WORKOUT_LOGGED           : { priority: PRIORITY.INFO,      dedup: 10 * 60 * 1000 },
  PART2_FORM               : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  MEETING_SCHEDULED        : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  CONTACT_MESSAGE          : { priority: PRIORITY.IMPORTANT, dedup: 0 },

  // Nutrition
  NUTRITION_MEAL_LOGGED    : { priority: PRIORITY.INFO,      dedup: 10 * 60 * 1000 },
  NUTRITION_DAY_COMPLETE   : { priority: PRIORITY.IMPORTANT, dedup: 5  * 60 * 1000 },

  // Blood reports
  BLOOD_REPORT_UPLOADED    : { priority: PRIORITY.IMPORTANT, dedup: 0 },
  BLOOD_REPORT_SENT        : { priority: PRIORITY.IMPORTANT, dedup: 0 },

  // Feed
  FEED_POST_UPLOADED       : { priority: PRIORITY.INFO,      dedup: 5  * 60 * 1000 },

  // Coins
  COIN_EARNED              : { priority: PRIORITY.INFO,      dedup: 10 * 60 * 1000 },
  COIN_PENALTY             : { priority: PRIORITY.INFO,      dedup: 10 * 60 * 1000 },

  // Reports
  DAILY_COMPLIANCE_SENT    : { priority: PRIORITY.IMPORTANT, dedup: 60 * 60 * 1000 },
  DAILY_DIGEST             : { priority: PRIORITY.IMPORTANT, dedup: 60 * 60 * 1000 },

  // Errors
  SERVER_ERROR             : { priority: PRIORITY.CRITICAL,  dedup: 3  * 60 * 1000 }
};

// ── Dedup registry ───────────────────────────────────────────────────
const _dedupCache = new Map();

function isDuplicate(fp, ttlMs) {
  if (!ttlMs) return false;
  const last = _dedupCache.get(fp);
  if (!last) return false;
  return (Date.now() - last) < ttlMs;
}

function markSent(fp) {
  _dedupCache.set(fp, Date.now());
  if (_dedupCache.size > 1000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of _dedupCache) {
      if (v < cutoff) _dedupCache.delete(k);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
function s(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).trim() || '—';
}

function ts() {
  return new Date().toLocaleString('en-IN', {
    timeZone : 'Asia/Kolkata',
    day      : '2-digit',
    month    : 'short',
    year     : 'numeric',
    hour     : '2-digit',
    minute   : '2-digit',
    hour12   : true
  });
}

function tierBadge(priority) {
  if (priority === PRIORITY.CRITICAL)  return '🔴';
  if (priority === PRIORITY.IMPORTANT) return '🟡';
  return '🟢';
}

// ── Luxury message formatters ─────────────────────────────────────────
// Each formatter returns an array of lines (no header — added in buildMessage)
const FORMATTERS = {

  // ─ Auth ──────────────────────────────────────────────────────────
  USER_SIGNUP: (p) => [
    '🆕  *New Signup*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `📱  ${s(p.phone)}`,
    `🌍  ${s(p.country)}`,
    `⏰  ${ts()}`
  ],

  USER_SIGNUP_GOOGLE: (p) => [
    '🆕  *New Signup  ·  Google*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `📱  ${s(p.phone)}`,
    `⏰  ${ts()}`
  ],

  USER_LOGIN: (p) => [
    '🔐  *User Login*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  PASSWORD_RESET_REQUEST: (p) => [
    '🔑  *Password Reset  ·  Requested*',
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  PASSWORD_RESET_DONE: (p) => [
    '✅  *Password Reset  ·  Complete*',
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  // ─ Admin actions ─────────────────────────────────────────────────
  USER_APPROVED: (p) => [
    '✅  *User Approved*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  USER_REJECTED: (p) => [
    '❌  *User Rejected*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  USER_SUSPENDED: (p) => [
    '🚫  *User Suspended*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  USER_REACTIVATED: (p) => [
    '♻️  *User Reactivated*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  USER_DELETED: (p) => [
    '🗑️  *User Deleted*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  // ─ Daily activity ─────────────────────────────────────────────────
  DAILY_CHECKIN: (p) => [
    '📋  *Daily Check-in*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `👣  Steps    ${s(p.steps)}`,
    `💧  Water    ${s(p.water)}`,
    `🥩  Protein  ${s(p.protein)}`,
    `😴  Sleep    ${s(p.sleep)}`,
    `⏰  ${ts()}`
  ],

  SUNDAY_CHECKIN: (p) => [
    '📝  *Sunday Check-in*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `🏋️  Training   ${s(p.training)}`,
    `🥗  Nutrition  ${s(p.nutrition)}`,
    `⏰  ${ts()}`
  ],

  WORKOUT_LOGGED: (p) => [
    '🏋️  *Workout Logged*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `🎯  Type      ${s(p.type)}`,
    `⏱  Duration  ${s(p.duration)}`,
    `⏰  ${ts()}`
  ],

  PART2_FORM: (p) => [
    '📋  *Part-2 Form  ·  Submitted*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `📱  ${s(p.mobile)}`,
    `🎯  Goals  ${s(p.goals)}`,
    `⏰  ${ts()}`
  ],

  MEETING_SCHEDULED: (p) => [
    '📅  *Call Scheduled*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `📆  Date  ${s(p.date)}`,
    `🕐  Slot  ${s(p.slot)}`,
    `⏰  ${ts()}`
  ],

  CONTACT_MESSAGE: (p) => [
    '💬  *Contact Message*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `📱  ${s(p.phone)}`,
    `📝  ${String(p.message || '').slice(0, 180)}`,
    `⏰  ${ts()}`
  ],

  // ─ Nutrition ──────────────────────────────────────────────────────
  NUTRITION_MEAL_LOGGED: (p) => [
    '🍽️  *Meal Logged*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `🥗  Meal      ${s(p.mealType)}`,
    `📅  Date      ${s(p.date)}`,
    `⭐  Score     ${s(p.score)}`,
    `🔥  Calories  ${s(p.calories)}`,
    `🥩  Protein   ${s(p.protein)}`,
    `⏰  ${ts()}`
  ],

  NUTRITION_DAY_COMPLETE: (p) => [
    '🌟  *Nutrition Day Complete*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `📅  Date   ${s(p.date)}`,
    `🍽️  Meals  ${s(p.meals)}/4`,
    `⏰  ${ts()}`
  ],

  // ─ Blood reports ──────────────────────────────────────────────────
  BLOOD_REPORT_UPLOADED: (p) => [
    '🩸  *Blood Report  ·  Uploaded*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `🎯  Goal  ${s(p.goal)}`,
    `⏰  ${ts()}`
  ],

  BLOOD_REPORT_SENT: (p) => [
    '📤  *Blood Report  ·  Sent to User*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `⏰  ${ts()}`
  ],

  // ─ Feed ───────────────────────────────────────────────────────────
  FEED_POST_UPLOADED: (p) => [
    '📸  *Feed Post  ·  Uploaded*',
    `👤  ${s(p.username)}`,
    `📝  ${String(p.caption || '').slice(0, 120)}`,
    `⏰  ${ts()}`
  ],

  // ─ Coins ──────────────────────────────────────────────────────────
  COIN_EARNED: (p) => [
    '🪙  *Coins Earned*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `➕  +${s(p.delta)} coins  ·  ${s(p.reason)}`,
    `💰  Balance  ${s(p.balance)}`,
    `⏰  ${ts()}`
  ],

  COIN_PENALTY: (p) => [
    '⚠️  *Coin Penalty*',
    `👤  ${s(p.name)}`,
    `📧  ${s(p.email)}`,
    `➖  ${s(p.delta)} coins  ·  ${s(p.reason)}`,
    `💰  Balance  ${s(p.balance)}`,
    `⏰  ${ts()}`
  ],

  // ─ Reports / Compliance ───────────────────────────────────────────
  DAILY_COMPLIANCE_SENT: (p) => [
    '📊  *Daily Compliance Report  ·  Sent*',
    `👥  Total Users   ${s(p.total)}`,
    `✅  Checked In    ${s(p.checkedIn)}`,
    `❌  Missed        ${s(p.missed)}`,
    `📈  Rate          ${s(p.rate)}`,
    `⏰  ${ts()}`
  ],

  DAILY_DIGEST: (p) => [
    '📋  *BodyBank  ·  Daily Digest*',
    `━━━━━━━━━━━━━━━━━━━━`,
    `👥  Active Users      ${s(p.totalUsers)}`,
    `🆕  New Signups       ${s(p.signups)}`,
    `🔐  Logins Today      ${s(p.logins)}`,
    `📋  Daily Check-ins   ${s(p.checkins)}`,
    `🏋️  Workouts          ${s(p.workouts)}`,
    `🍽️  Meals Logged      ${s(p.meals)}`,
    `🩸  Blood Reports     ${s(p.bloodReports)}`,
    `💬  Messages          ${s(p.messages)}`,
    `🪙  Coins Awarded     ${s(p.coinsAwarded)}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📅  ${s(p.date)}  ·  IST`
  ],

  // ─ Errors ─────────────────────────────────────────────────────────
  SERVER_ERROR: (p) => [
    '🔴  *Server Error*',
    `📌  ${s(p.action)}`,
    `💥  ${String(p.error || '').slice(0, 300)}`,
    `⏰  ${ts()}`
  ]
};

// ── Build final WhatsApp message string ───────────────────────────────
function buildMessage(eventType, lines, priority) {
  const badge = tierBadge(priority);
  return [
    `${badge}  *BodyBank*`,
    `─────────────────────`,
    '',
    ...lines
  ].join('\n');
}

// ── Public API ────────────────────────────────────────────────────────
/**
 * notify(eventType, payload, opts)
 * Non-blocking. Applies dedup per event tier. Never throws.
 *
 * @param {string} eventType
 * @param {object} payload
 * @param {object} [opts]
 * @param {boolean} [opts.noDedup] – bypass dedup
 */
async function notify(eventType, payload = {}, opts = {}) {
  try {
    const formatter = FORMATTERS[eventType];
    if (!formatter) {
      console.warn(`[notify] Unknown eventType: "${eventType}"`);
      return;
    }

    const meta     = EVENT_META[eventType] || { priority: PRIORITY.INFO, dedup: 5 * 60 * 1000 };
    const dedupTtl = opts.noDedup ? 0 : meta.dedup;
    const fp       = `${eventType}::${s(payload.email || payload.userId || payload.username || payload.action || '')}`;

    if (dedupTtl > 0 && isDuplicate(fp, dedupTtl)) return;
    markSent(fp);

    const lines   = formatter(payload);
    const message = buildMessage(eventType, lines, meta.priority);
    await sendWhatsApp(message);
  } catch (err) {
    console.error('[notify] unexpected error:', err.message);
  }
}

/**
 * notifyAsync — fire-and-forget wrapper.
 */
function notifyAsync(eventType, payload, opts) {
  notify(eventType, payload, opts).catch(() => {});
}

module.exports = { notify, notifyAsync, FORMATTERS, EVENT_META, PRIORITY };
