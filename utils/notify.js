'use strict';

const { sendWhatsAppWithFallback } = require('../services/whatsapp');

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
  AUDIT_FORM: { priority: PRIORITY.IMPORTANT, dedup: 0 },
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
function titleFromKey(key) {
  return String(key || '')
    .replace(/\./g, ' → ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
function isSensitivePayloadKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.includes('password') ||
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('authorization') ||
    k.includes('auth') ||
    k.includes('cookie') ||
    k.includes('session') ||
    k.includes('base64') ||
    k === 'photo_data' ||
    k === 'image_data' ||
    k === 'imagedata'
  );
}
function flattenPayload(payload, prefix = '', out = []) {
  if (payload == null) return out;
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => flattenPayload(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof payload === 'object') {
    Object.keys(payload).forEach((k) => {
      const next = prefix ? `${prefix}.${k}` : k;
      const v = payload[k];
      if (v != null && typeof v === 'object') flattenPayload(v, next, out);
      else out.push([next, v]);
    });
    return out;
  }
  out.push([prefix || 'value', payload]);
  return out;
}
function payloadLines(payload = {}) {
  const pairs = flattenPayload(payload);
  const lines = [];
  for (const [key, value] of pairs) {
    if (isSensitivePayloadKey(key)) continue;
    if (value == null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`• ${titleFromKey(key)}: ${text}`);
  }
  return lines;
}
function chunkMessage(message, maxChars = 1500) {
  const rawLines = String(message || '').split('\n');
  const chunks = [];
  let current = '';
  rawLines.forEach((line) => {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxChars) {
      current = next;
      return;
    }
    if (current) chunks.push(current);
    if (line.length <= maxChars) {
      current = line;
      return;
    }
    let rest = line;
    while (rest.length > maxChars) {
      chunks.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  });
  if (current) chunks.push(current);
  if (chunks.length <= 1) return chunks;
  return chunks.map((c, i) => `[${i + 1}/${chunks.length}]\n${c}`);
}

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
  SUNDAY_CHECKIN: (p) => ['📝 Sunday Check-in', ...userLines(p), `🏋️ Training: ${s(p.training_go || p.training)}`, `🥗 Nutrition: ${s(p.nutrition_go || p.nutrition)}`, `⏰ ${ts()}`],
  WORKOUT_LOGGED: (p) => ['🏋️ Workout Logged', ...userLines(p), `🎯 Type: ${s(p.type)}`, `⏱ Duration: ${s(p.duration)}`, `⏰ ${ts()}`],
  AUDIT_FORM: (p) => ['📋 Audit Form Submitted', ...userLines(p), `🌍 ${s(p.city)}, ${s(p.country)}`, `🎂 Age: ${s(p.age)}  |  ${s(p.sex)}`, `💼 Occupation: ${s(p.occupation)}`, `🏃 Work Intensity: ${s(p.work_intensity)}`, `💪 Fitness Level: ${s(p.fitness_experience)}`, `⏰ ${ts()}`],
  PART2_FORM: (p) => ['📋 Part-2 Form Submitted', ...userLines(p), `🎯 Goals: ${s(p.goals)}`, `⏰ ${ts()}`],
  MEETING_SCHEDULED: (p) => ['📅 Call Scheduled', ...userLines(p), `📆 Date: ${s(p.date)}`, `🕐 Slot: ${s(p.slot)}`, `⏰ ${ts()}`],
  CONTACT_MESSAGE: (p) => ['💬 Contact Message', ...userLines(p), `📝 ${String(p.message || '').slice(0, 180)}`, `⏰ ${ts()}`],
  NUTRITION_MEAL_LOGGED: (p) => ['🍽️ Meal Logged', ...userLines(p), `🥗 Meal: ${s(p.mealType)}`, `📅 Date: ${s(p.date)}`, `⭐ Score: ${s(p.score)}`, `🔥 Calories: ${s(p.calories)}`, `🥩 Protein: ${s(p.protein)}`, `🍚 Carbs: ${s(p.carbs)}`, `🥑 Fats: ${s(p.fat)}`, `⏰ ${ts()}`],
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
const DETAILED_EVENTS = new Set(['SUNDAY_CHECKIN', 'PART2_FORM', 'NUTRITION_MEAL_LOGGED']);

function buildMessage(eventType, lines, priority) {
  return [`${tierIcon(priority)} BodyBank Admin Update`, `Event: ${eventType}`, ...lines].join('\n');
}

function formatEventMessage(eventType, payload = {}) {
  const formatter = FORMATTERS[eventType];
  if (!formatter) return null;
  const meta = EVENT_META[eventType] || { priority: PRIORITY.INFO, dedup: 5 * 60 * 1000 };
  const detailLines = DETAILED_EVENTS.has(eventType) ? payloadLines(payload) : [];
  return {
    meta,
    message: buildMessage(eventType, [...formatter(payload), ...detailLines], meta.priority)
  };
}

function templateSidForEvent(eventType) {
  const perEvent = process.env[`TWILIO_${String(eventType || '').trim()}_TEMPLATE_SID`] || '';
  if (perEvent) return perEvent;
  if (eventType === 'AUDIT_FORM' && process.env.TWILIO_AUDIT_TEMPLATE_SID) return process.env.TWILIO_AUDIT_TEMPLATE_SID;
  return process.env.TWILIO_WHATSAPP_TEMPLATE_SID || '';
}

async function notify(eventType, payload = {}, opts = {}) {
  try {
    const formatted = formatEventMessage(eventType, payload);
    if (!formatted) {
      console.warn('[notify] no formatter for event:', eventType);
      return { ok: false, reason: 'missing_formatter' };
    }
    const meta = formatted.meta;
    const ttl = opts.noDedup ? 0 : meta.dedup;
    const fp = `${eventType}::${s(payload.email || payload.userId || payload.username || payload.action || '')}`;
    if (isDup(fp, ttl)) {
      console.log('[notify] dedup skip:', fp);
      return { ok: false, reason: 'dedup_skipped' };
    }
    mark(fp);
    const media = payload && payload.mediaUrl ? payload.mediaUrl : null;
    const chunks = chunkMessage(formatted.message, 1500);
    let last = { ok: false, reason: 'not_sent' };
    for (let i = 0; i < chunks.length; i++) {
      const result = await sendWhatsAppWithFallback(chunks[i], {
        mediaUrl: i === 0 ? media : null,
        templateSid: templateSidForEvent(eventType),
        preferTemplate: true
      });
      last = result;
      if (!result.ok) {
        console.warn(`[notify] ${eventType} WhatsApp chunk ${i + 1}/${chunks.length} NOT sent — reason: ${result.reason}`, result.error || result.missing || '');
        return result;
      }
    }
    return last;
  } catch (err) {
    console.error('[notify] unexpected error for', eventType, ':', err.message);
    return { ok: false, reason: 'notify_exception', error: err.message };
  }
}

function notifyAsync(eventType, payload, opts) {
  notify(eventType, payload, opts).catch(err => console.error('[notifyAsync] uncaught:', eventType, err.message));
}

module.exports = { notify, notifyAsync, buildMessage, formatEventMessage, FORMATTERS, EVENT_META, PRIORITY };
