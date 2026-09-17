'use strict';

/**
 * One way to tell a person that something happened.
 *
 * A notification is two things at once:
 *   1. a row in `user_inbox` — the in-app bell, so it is there even when the
 *      device never showed a banner (push off, app uninstalled, iOS Safari tab);
 *   2. a push to every device the person has — web push (browsers, installed PWA)
 *      and FCM (the Android and iOS apps) — via the server's sendPushToUser.
 *
 * `inbox: false` skips (1) for activity the staff bell already derives from its
 * own table (check-ins, workouts, meals …) so it is not listed twice.
 *
 * `link` is a screen name the front end understands (admin tab / member tab, see
 * js/bb-notify.js). The push carries it as `/?open=<link>` so tapping the banner
 * lands on that screen on web, Android and iOS alike.
 *
 * Nothing here ever throws or rejects: a failed notification must never fail the
 * request that caused it.
 */

const STAFF_ROLES = ['admin', 'superadmin', 'operator'];
const LINK_RE = /^[a-z0-9_-]{1,40}$/i;

function clip(v, n) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function linkUrl(link, extra) {
  if (extra && /^\/[^/]/.test(String(extra))) return String(extra);
  if (link && LINK_RE.test(String(link))) return '/?open=' + encodeURIComponent(String(link));
  return '/';
}

function createNotificationHub({ queryAll, run, uuidv4, sendPushToUser }) {
  const newId = typeof uuidv4 === 'function' ? uuidv4 : () => require('crypto').randomUUID();

  function normalise(n) {
    const src = n || {};
    const link = src.link && LINK_RE.test(String(src.link)) ? String(src.link) : null;
    return {
      title: clip(src.title || 'BodyBank', 120),
      body: clip(src.body || '', 400),
      type: clip(src.type || 'activity', 40),
      link,
      url: linkUrl(link, src.url),
      tag: src.tag ? clip(src.tag, 120) : null,
      inbox: src.inbox !== false
    };
  }

  async function saveInbox(userId, n) {
    const id = newId();
    await run(
      'INSERT INTO user_inbox (id, user_id, title, body, type, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, FALSE, NOW())',
      [id, userId, n.title, n.body || n.title, n.type, n.link]
    );
    return id;
  }

  /** Notify one person. Resolves to { inboxId } (or {} when nothing was stored). */
  async function toUser(userId, input) {
    if (!userId) return {};
    const n = normalise(input);
    let inboxId = null;
    if (n.inbox) {
      try { inboxId = await saveInbox(String(userId), n); } catch (e) { console.warn('[notify-hub] inbox insert failed:', e.message); }
    }
    try {
      await sendPushToUser(String(userId), JSON.stringify({
        title: n.title,
        body: n.body,
        type: n.type,
        link: n.link || '',
        url: n.url,
        // The banner tag: repeated tags replace each other on the device, so a
        // noisy stream (one client's check-ins) collapses instead of piling up.
        id: n.tag || (inboxId ? 'inbox-' + inboxId : n.type + '-' + Date.now())
      }));
    } catch (e) {
      console.warn('[notify-hub] push failed:', e.message);
    }
    return { inboxId };
  }

  async function toUsers(ids, input) {
    const uniq = Array.from(new Set((ids || []).filter(Boolean).map(String)));
    await Promise.all(uniq.map((id) => toUser(id, input)));
    return uniq.length;
  }

  /**
   * Notify staff. `roles` narrows the audience (default: admin, superadmin and
   * operator); `exclude` leaves out the person who caused the event.
   */
  async function toStaff(input, opts) {
    const o = opts || {};
    const roles = (Array.isArray(o.roles) && o.roles.length ? o.roles : STAFF_ROLES)
      .filter((r) => STAFF_ROLES.includes(r));
    if (!roles.length) return 0;
    try {
      const marks = roles.map(() => '?').join(', ');
      const rows = await queryAll(`SELECT id FROM users WHERE role IN (${marks})`, roles);
      const skip = new Set([].concat(o.exclude || []).filter(Boolean).map(String));
      return await toUsers((rows || []).map((r) => r.id).filter((id) => !skip.has(String(id))), input);
    } catch (e) {
      console.warn('[notify-hub] staff lookup failed:', e.message);
      return 0;
    }
  }

  /** Fire-and-forget wrappers for call sites that must not wait. */
  function user(userId, input) { toUser(userId, input).catch(() => {}); }
  function staff(input, opts) { toStaff(input, opts).catch(() => {}); }

  return { toUser, toUsers, toStaff, user, staff, normalise };
}

async function ensureNotificationColumns(pool) {
  await pool.query('ALTER TABLE user_inbox ADD COLUMN IF NOT EXISTS link TEXT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_inbox_unread ON user_inbox(user_id, created_at DESC) WHERE is_read = FALSE');
}

// ── Staff alerts that already go to admin WhatsApp (utils/notify.js) ─────────
// Each mapped event is ALSO pushed to staff devices. Events whose route already
// pushes to staff itself (sign-ups, forms, contact, uploads …) are absent on
// purpose so nobody gets the same banner twice. `inbox: false` = the staff bell
// already lists it from its own table.
function who(p) {
  const name = clip(p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || p.phone || 'A client', 60);
  return name;
}

const STAFF_EVENT_PUSH = {
  WA_INBOUND_DRAFT: (p) => ({
    title: (p.trigger && p.trigger !== 'client_replied' ? '🤖 Kling drafted a message to ' : '💬 WhatsApp from ') + who(p),
    body: p.inbound ? clip(p.inbound, 140) + ' — reply drafted, approve to send' : 'Draft: ' + clip(p.draft, 160),
    link: 'wa', type: 'wa_draft', tag: 'wa-' + clip(p.phone, 20)
  }),
  WA_INBOUND_HANDOFF: (p) => ({
    title: '🖐️ ' + who(p) + ' needs you on WhatsApp',
    body: clip(p.reason || 'Handoff', 60) + (p.inbound ? ' — "' + clip(p.inbound, 120) + '"' : ''),
    link: 'wa', type: 'wa_handoff', tag: 'wa-' + clip(p.phone, 20)
  }),
  WA_UNMATCHED: (p) => ({
    title: '❓ WhatsApp from an unknown number',
    body: clip(p.phone, 20) + ': ' + clip(p.inbound, 140),
    link: 'wa', type: 'wa_unmatched', tag: 'wa-' + clip(p.phone, 20)
  }),
  WA_DRAFT_SENT: (p) => ({
    title: '🤖 Kling messaged ' + who(p) + ' on WhatsApp',
    body: p.body ? clip(p.body, 160) : 'Approved draft delivered',
    link: 'wa', type: 'wa_sent', tag: 'wa-sent-' + clip(p.draft_id || p.phone, 40)
  }),
  WA_DRAFT_REJECTED: (p) => ({
    title: '⛔ WhatsApp draft rejected — ' + who(p),
    body: 'Nothing was sent to the client.',
    link: 'wa', type: 'wa_rejected', inbox: false, tag: 'wa-' + clip(p.phone, 20)
  }),
  SUNDAY_CHECKIN: (p) => ({
    title: '📝 Sunday check-in — ' + who(p),
    body: 'Weekly check-in submitted. Tap to review.',
    link: 'sundaycheckin', type: 'sunday_checkin', inbox: false, tag: 'sunday-' + clip(p.email, 60)
  }),
  DAILY_CHECKIN: (p) => ({
    title: '📋 Daily check-in — ' + who(p),
    body: ['Steps ' + clip(p.steps, 10), 'Water ' + clip(p.water, 10), 'Protein ' + clip(p.protein, 10), 'Sleep ' + clip(p.sleep, 10)]
      .filter((x) => !/ $/.test(x)).join(' · '),
    link: 'dailycheckin', type: 'daily_checkin', inbox: false, tag: 'daily-' + clip(p.email, 60)
  }),
  WORKOUT_LOGGED: (p) => ({
    title: '🏋️ Workout logged — ' + who(p),
    body: [clip(p.type, 40), p.duration ? clip(p.duration, 20) : ''].filter(Boolean).join(' · ') || 'New workout',
    link: 'workouts', type: 'workout', inbox: false, tag: 'workout-' + clip(p.email, 60)
  }),
  NUTRITION_MEAL_LOGGED: (p) => ({
    title: '🍽️ Meal logged — ' + who(p),
    body: [clip(p.mealType, 20), p.calories != null ? clip(p.calories, 10) + ' kcal' : '', p.score != null ? 'score ' + clip(p.score, 6) : '']
      .filter(Boolean).join(' · ') || 'New meal',
    link: 'nutrition', type: 'meal', inbox: false, tag: 'meal-' + clip(p.email, 60)
  }),
  NUTRITION_DAY_COMPLETE: (p) => ({
    title: '🌟 Nutrition day complete — ' + who(p),
    body: 'All meals logged for ' + clip(p.date, 12) + '.',
    link: 'nutrition', type: 'nutrition_day', inbox: false, tag: 'meal-' + clip(p.email, 60)
  }),
  BLOOD_REPORT_SENT: (p) => ({
    title: '📤 Blood report sent — ' + who(p), body: 'The health report was delivered to the client.',
    link: 'blood', type: 'blood_sent'
  }),
  REPORT_SENT: (p) => ({
    title: '📤 Progress report sent — ' + who(p),
    body: clip(p.type, 12) + ' report' + (p.channels && p.channels.length ? ' via ' + p.channels.join(', ') : '')
      + (p.failed && p.failed.length ? ' · failed: ' + p.failed.join(', ') : ''),
    link: 'reports', type: 'report_sent'
  }),
  REPORT_BULK_COMPLETE: (p) => ({
    title: '📚 Progress reports ready',
    body: clip(p.done, 6) + ' of ' + clip(p.total, 6) + ' ' + clip(p.type, 12) + ' reports generated' + (Number(p.failed) ? ' · ' + p.failed + ' failed' : ''),
    link: 'reports', type: 'report_bulk'
  }),
  // Only a member deleting their own account is news — an admin deletion was
  // done by staff in the first place.
  USER_DELETED: (p) => (p.name !== 'self-deleted' ? null : {
    title: '🗑️ A member deleted their account', body: clip(p.email, 80) || 'A member account was removed.',
    link: 'memberships', type: 'user_deleted', roles: ['admin', 'superadmin']
  }),
  USER_MEMBERSHIP_ACTIVATED: (p) => ({
    title: '✅ Membership activated — ' + who(p),
    body: (p.plan ? clip(p.plan, 30) + ' plan' : 'Membership') + ' is now active.',
    link: 'memberships', type: 'membership', inbox: false
  })
};

/** Turn a notify() event into a staff push (or null when it isn't pushed). */
function staffPushForEvent(eventType, payload) {
  const fn = STAFF_EVENT_PUSH[eventType];
  if (!fn) return null;
  try { return fn(payload || {}); } catch (_) { return null; }
}

module.exports = {
  createNotificationHub,
  ensureNotificationColumns,
  staffPushForEvent,
  STAFF_EVENT_PUSH,
  STAFF_ROLES,
  linkUrl
};
