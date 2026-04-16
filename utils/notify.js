'use strict';

// BodyBank — Centralized admin notification utility
// All sends are non-blocking. App never crashes if this fails.

const { sendWhatsApp } = require('../services/whatsapp');

// ── Dedup registry (in-memory, keyed by fingerprint) ───────────────
// Same event fingerprint suppressed for 5 minutes to avoid spam.
const DEDUP_TTL_MS = 5 * 60 * 1000;
const _dedupCache  = new Map();

function isDuplicate(fingerprint) {
  const last = _dedupCache.get(fingerprint);
  if (!last) return false;
  return (Date.now() - last) < DEDUP_TTL_MS;
}

function markSent(fingerprint) {
  _dedupCache.set(fingerprint, Date.now());
  // Cleanup old keys periodically (keep map lean)
  if (_dedupCache.size > 500) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, v] of _dedupCache) {
      if (v < cutoff) _dedupCache.delete(k);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
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

function fullName(first, last) {
  return ([first, last].filter(Boolean).join(' ').trim()) || '—';
}

// ── Message formatters (one per event type) ──────────────────────────
const FORMATTERS = {

  // ─ Auth ─────────────────────────────────────────────────────────
  USER_SIGNUP: (p) => [
    '🆕 *New Signup*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `📱 ${s(p.phone)}`,
    `🌍 ${s(p.country)}`,
    `⏰ ${ts()}`
  ],

  USER_SIGNUP_GOOGLE: (p) => [
    '🆕 *New Signup (Google)*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `📱 ${s(p.phone)}`,
    `⏰ ${ts()}`
  ],

  USER_LOGIN: (p) => [
    '🔐 *User Login*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `🎭 Role: ${s(p.role)}`,
    `⏰ ${ts()}`
  ],

  PASSWORD_RESET_REQUEST: (p) => [
    '🔑 *Password Reset Requested*',
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  PASSWORD_RESET_DONE: (p) => [
    '✅ *Password Reset Complete*',
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  // ─ Admin actions ────────────────────────────────────────────────
  USER_APPROVED: (p) => [
    '✅ *User Approved*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  USER_REJECTED: (p) => [
    '❌ *User Rejected*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  USER_SUSPENDED: (p) => [
    '🚫 *User Suspended*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  USER_REACTIVATED: (p) => [
    '♻️ *User Reactivated*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  USER_DELETED: (p) => [
    '🗑️ *User Deleted*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `⏰ ${ts()}`
  ],

  // ─ Daily activity ────────────────────────────────────────────────
  DAILY_CHECKIN: (p) => [
    '📋 *Daily Check-in*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `👣 Steps: ${s(p.steps)}`,
    `💧 Water: ${s(p.water)}`,
    `🥩 Protein: ${s(p.protein)}`,
    `😴 Sleep: ${s(p.sleep)}`,
    `⏰ ${ts()}`
  ],

  SUNDAY_CHECKIN: (p) => [
    '📝 *Sunday Check-in*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `🏋️ Training: ${s(p.training)}`,
    `🥗 Nutrition: ${s(p.nutrition)}`,
    `⏰ ${ts()}`
  ],

  WORKOUT_LOGGED: (p) => [
    '🏋️ *Workout Logged*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `🎯 Type: ${s(p.type)}`,
    `⏱ Duration: ${s(p.duration)}`,
    `⏰ ${ts()}`
  ],

  PART2_FORM: (p) => [
    '📋 *Part-2 Form Submitted*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `📱 ${s(p.mobile)}`,
    `🎯 Goals: ${s(p.goals)}`,
    `⏰ ${ts()}`
  ],

  MEETING_SCHEDULED: (p) => [
    '📅 *Call Scheduled*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `📆 Date: ${s(p.date)}`,
    `🕐 Slot: ${s(p.slot)}`,
    `⏰ ${ts()}`
  ],

  // ─ Nutrition ────────────────────────────────────────────────────
  NUTRITION_MEAL_LOGGED: (p) => [
    '🍽️ *Meal Logged*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `🥗 Meal: ${s(p.mealType)}`,
    `📅 Date: ${s(p.date)}`,
    `⭐ Score: ${s(p.score)}`,
    `🔥 Calories: ${s(p.calories)}`,
    `🥩 Protein: ${s(p.protein)}`,
    `⏰ ${ts()}`
  ],

  NUTRITION_DAY_COMPLETE: (p) => [
    '🌟 *Nutrition Day Complete*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `📅 Date: ${s(p.date)}`,
    `🍽️ Meals: ${s(p.meals)}/4`,
    `⏰ ${ts()}`
  ],

  // ─ Coins ────────────────────────────────────────────────────────
  COIN_EARNED: (p) => [
    '🪙 *Coins Earned*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `➕ +${s(p.delta)} coins — ${s(p.reason)}`,
    `💰 Balance: ${s(p.balance)}`,
    `⏰ ${ts()}`
  ],

  COIN_PENALTY: (p) => [
    '⚠️ *Coin Penalty*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `➖ ${s(p.delta)} coins — ${s(p.reason)}`,
    `💰 Balance: ${s(p.balance)}`,
    `⏰ ${ts()}`
  ],

  // ─ Contact/Chat ─────────────────────────────────────────────────
  CONTACT_MESSAGE: (p) => [
    '💬 *Contact Message*',
    `👤 ${s(p.name)}`,
    `📧 ${s(p.email)}`,
    `📱 ${s(p.phone)}`,
    `📝 ${String(p.message || '').slice(0, 200)}`,
    `⏰ ${ts()}`
  ],

  // ─ Errors ───────────────────────────────────────────────────────
  SERVER_ERROR: (p) => [
    '🔴 *Server Error*',
    `📌 ${s(p.action)}`,
    `💥 ${String(p.error || '').slice(0, 300)}`,
    `⏰ ${ts()}`
  ]
};

// ── Header for all messages ──────────────────────────────────────────
function buildMessage(eventType, lines) {
  return [
    `🚀 *BodyBank*`,
    '',
    ...lines
  ].join('\n');
}

// ── Public API ───────────────────────────────────────────────────────
/**
 * notify(eventType, payload)
 * Non-blocking. Deduplicates repeating events within 5 min.
 * Never throws.
 *
 * @param {string} eventType  – one of the keys in FORMATTERS
 * @param {object} payload    – event-specific data object
 * @param {object} [opts]
 * @param {boolean} [opts.noDedup]  – bypass dedup (default false)
 */
async function notify(eventType, payload = {}, opts = {}) {
  try {
    const formatter = FORMATTERS[eventType];
    if (!formatter) {
      console.warn(`[notify] Unknown eventType: "${eventType}"`);
      return;
    }

    // Build dedup fingerprint
    const fp = eventType + '::' + s(payload.email || payload.userId || payload.action || '');
    if (!opts.noDedup && isDuplicate(fp)) return;
    markSent(fp);

    const lines   = formatter(payload);
    const message = buildMessage(eventType, lines);
    await sendWhatsApp(message);
  } catch (err) {
    console.error('[notify] unexpected error:', err.message);
  }
}

/**
 * notifyAsync — fire-and-forget wrapper.
 * Use this inside route handlers to avoid awaiting WhatsApp.
 */
function notifyAsync(eventType, payload, opts) {
  notify(eventType, payload, opts).catch(() => {});
}

module.exports = { notify, notifyAsync, FORMATTERS };
