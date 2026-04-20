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

/** Short human-readable line under the machine event id. */
const EVENT_HEADLINE = {
  USER_SIGNUP: 'New signup',
  USER_SIGNUP_GOOGLE: 'New signup (Google)',
  USER_LOGIN: 'User login',
  PASSWORD_RESET_REQUEST: 'Password reset requested',
  PASSWORD_RESET_DONE: 'Password reset completed',
  USER_APPROVED: 'User approved',
  USER_REJECTED: 'User rejected',
  USER_SUSPENDED: 'User suspended',
  USER_REACTIVATED: 'User reactivated',
  USER_DELETED: 'User deleted',
  DAILY_CHECKIN: 'Daily check-in',
  SUNDAY_CHECKIN: 'Sunday check-in',
  WORKOUT_LOGGED: 'Workout logged',
  AUDIT_FORM: 'Body audit submitted',
  PART2_FORM: 'Part 2 form submitted',
  MEETING_SCHEDULED: 'Call scheduled',
  CONTACT_MESSAGE: 'Contact message',
  NUTRITION_MEAL_LOGGED: 'Meal logged',
  NUTRITION_DAY_COMPLETE: 'Nutrition day complete',
  BLOOD_REPORT_UPLOADED: 'Blood report uploaded',
  BLOOD_REPORT_SENT: 'Blood report sent to user',
  FEED_POST_UPLOADED: 'Feed post uploaded',
  COIN_EARNED: 'Coins earned',
  COIN_PENALTY: 'Coin penalty',
  DAILY_COMPLIANCE_SENT: 'Daily compliance report sent',
  DAILY_DIGEST: 'Daily executive digest',
  SERVER_ERROR: 'Server error'
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

const SKIP_TOP_LEVEL_KEYS = new Set(['raw']);

function labelFromKey(key) {
  const k0 = String(key || '').split('.').pop() || key;
  const k = String(k0 || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!k) return 'Field';
  return k.replace(/\b\w/g, (m) => m.toUpperCase());
}

function isSensitivePayloadKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    k.includes('password') ||
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('authorization') ||
    (k.includes('auth') && !k.includes('author')) ||
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
      if (!prefix && SKIP_TOP_LEVEL_KEYS.has(k)) return;
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

const KEY_LABEL_OVERRIDES = {
  mealType: 'Meal type',
  type: 'Workout type',
  mobile: 'Phone',
  phone: 'Phone',
  user_id: 'User ID',
  reply_email: 'Email',
  mediaUrl: 'Media URL'
};

function displayLabel(key) {
  const leaf = String(key || '').split('.').pop() || key;
  const o = KEY_LABEL_OVERRIDES[leaf];
  if (o) return o;
  return labelFromKey(leaf);
}

function formatValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value.trim() || null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const PREFERRED_KEYS_FIRST = [
  'name',
  'email',
  'mobile',
  'phone',
  'user_id',
  'username',
  'date',
  'mealType',
  'type',
  'duration',
  'steps',
  'water',
  'protein',
  'sleep',
  'goal',
  'action',
  'error'
];

function preferredIndex(leafKey) {
  const i = PREFERRED_KEYS_FIRST.indexOf(leafKey);
  return i === -1 ? 999 : i;
}

function payloadDetailLines(payload = {}) {
  const pairs = flattenPayload(payload);
  const byLeaf = new Map();
  for (const [fullKey, value] of pairs) {
    if (isSensitivePayloadKey(fullKey)) continue;
    const text = formatValue(value);
    if (text == null) continue;
    const leaf = String(fullKey || '').split('.').pop() || fullKey;
    if (leaf === 'phone' || leaf === 'mobile') {
      const prev = byLeaf.get('_phone_merge');
      if (!prev || prev === '—') byLeaf.set('_phone_merge', text);
      continue;
    }
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, text);
  }
  if (byLeaf.has('_phone_merge')) {
    byLeaf.set('phone', byLeaf.get('_phone_merge'));
    byLeaf.delete('_phone_merge');
  }
  const entries = [...byLeaf.entries()].filter(([k]) => k !== '_phone_merge');
  entries.sort((a, b) => {
    const pa = preferredIndex(a[0]);
    const pb = preferredIndex(b[0]);
    if (pa !== pb) return pa - pb;
    return displayLabel(a[0]).localeCompare(displayLabel(b[0]), 'en');
  });
  return entries.map(([k, v]) => `${displayLabel(k)}: ${v}`);
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

function buildAdminMessage(eventType, payload, priority) {
  const headline = EVENT_HEADLINE[eventType] || String(eventType || '').replace(/_/g, ' ').toLowerCase();
  const details = payloadDetailLines(payload);
  const lines = [
    `${tierIcon(priority)} BodyBank Admin Update`,
    `Event: ${eventType}`,
    headline,
    details.length ? '—' : '',
    ...details,
    '—',
    `Recorded: ${ts()}`
  ].filter((ln, i, arr) => !(ln === '' && (arr[i - 1] === '—' || arr[i + 1] === '—')));
  return lines.join('\n');
}

/** Plain text body only (same layout as WhatsApp); for tests or custom channels. */
function buildMessage(eventType, payload = {}) {
  const meta = EVENT_META[eventType] || { priority: PRIORITY.INFO, dedup: 5 * 60 * 1000 };
  return buildAdminMessage(eventType, payload, meta.priority);
}

function formatEventMessage(eventType, payload = {}) {
  const meta = EVENT_META[eventType] || { priority: PRIORITY.INFO, dedup: 5 * 60 * 1000 };
  return {
    meta,
    message: buildAdminMessage(eventType, payload, meta.priority)
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

module.exports = { notify, notifyAsync, buildMessage, formatEventMessage, EVENT_HEADLINE, EVENT_META, PRIORITY };
