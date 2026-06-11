'use strict';

/**
 * Campaign Scheduler Service
 * Manages node-cron jobs for BodyBank campaign messages.
 * Timezone: Asia/Kolkata (IST)
 *
 * Usage:
 *   const { startCampaignScheduler } = require('./services/campaignScheduler');
 *   await startCampaignScheduler({ queryAll, run, sendPushToUser, uuidv4 });
 *
 * After any campaign create/update/delete/pause/resume call:
 *   await restartScheduler();
 */

const cron = require('node-cron');

const TIMEZONE = 'Asia/Kolkata';

const DOW_TO_CRON = {
  sunday:    0,
  monday:    1,
  tuesday:   2,
  wednesday: 3,
  thursday:  4,
  friday:    5,
  saturday:  6,
};

// Map<campaignId, cron.ScheduledTask>
const _jobs = new Map();

// Injected dependencies (set via startCampaignScheduler)
let _queryAll = null;
let _run = null;
let _sendPushToUser = null;
let _uuidv4 = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse "HH:MM" → { hour, minute } or null on invalid input.
 */
function parseTime(timeStr) {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour   = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Build a 5-field cron expression.
 *  day_of_week = 'daily'   → "MM HH * * *"   (every day)
 *  day_of_week = 'sunday'  → "MM HH * * 0"
 *  …
 * Returns null on invalid inputs.
 */
function buildCronExpression(day_of_week, time_of_day) {
  const t = parseTime(time_of_day);
  if (!t) return null;
  const day = String(day_of_week || '').trim().toLowerCase();
  if (day === 'daily') {
    return `${t.minute} ${t.hour} * * *`;
  }
  const dow = DOW_TO_CRON[day];
  if (dow === undefined) return null;
  return `${t.minute} ${t.hour} * * ${dow}`;
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Fetch all active users eligible to receive campaign messages.
 */
async function getActiveUsers() {
  return _queryAll(
    "SELECT id, first_name FROM users WHERE role = 'user'" +
    " AND COALESCE(approval_status, 'approved') = 'approved'" +
    " AND COALESCE(suspended, FALSE) = FALSE"
  );
}

/**
 * Broadcast a message to all active users.
 * - Writes to user_inbox so the message appears in the bell/inbox.
 * - Inserts the same message into each user's chat with the Lifestyle Manager.
 * - Attempts a push notification for users who have subscribed.
 * Returns the number of users that received an inbox entry.
 */
async function broadcastMessage(message) {
  let users;
  try {
    users = await getActiveUsers();
  } catch (e) {
    console.error('[Campaign] Failed to fetch active users:', e.message);
    return 0;
  }

  if (!users || users.length === 0) {
    console.log('[Campaign] No active users to broadcast to.');
    return 0;
  }

  const trimmed = String(message).trim();
  const bodyForChat = trimmed.slice(0, 5000);

  // Resolve one admin to use as "Lifestyle Manager" sender for chat messages
  let lifestyleManagerId = null;
  try {
    const adminRows = await _queryAll(
      "SELECT id FROM users WHERE role IN ('admin','superadmin') LIMIT 1"
    );
    if (adminRows && adminRows[0]) lifestyleManagerId = adminRows[0].id;
  } catch (e) {
    console.warn('[Campaign] Could not resolve admin for chat sender:', e.message);
  }

  let inboxCount = 0;
  let pushCount = 0;
  let chatCount = 0;

  for (const user of users) {
    // 1. Write to in-app inbox (always — no push subscription required)
    const inboxRowId = _uuidv4();
    var inboxInsertOk = false;
    try {
      await _run(
        'INSERT INTO user_inbox (id, user_id, title, body, type, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [inboxRowId, user.id, 'BodyBank', trimmed, 'campaign']
      );
      inboxInsertOk = true;
      inboxCount++;
    } catch (e) {
      console.warn(`[Campaign] Inbox insert failed for user ${user.id}: ${e.message}`);
    }

    // 2. Same message into Lifestyle Manager chat (get-or-create thread, then insert as admin message)
    if (lifestyleManagerId) {
      try {
        const threads = await _queryAll(
          'SELECT id FROM message_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
          [user.id]
        );
        let threadId = threads && threads[0] ? threads[0].id : null;
        if (!threadId) {
          threadId = _uuidv4();
          await _run(
            'INSERT INTO message_threads (id, user_id, subject) VALUES (?, ?, ?)',
            [threadId, user.id, '']
          );
        }
        const msgId = _uuidv4();
        await _run(
          'INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
          [msgId, threadId, lifestyleManagerId, 'admin', bodyForChat]
        );
        await _run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);
        chatCount++;
      } catch (e) {
        console.warn(`[Campaign] Chat insert failed for user ${user.id}: ${e.message}`);
      }
    }

    // 3. Push notification (only if inbox row exists; id matches bell list)
    if (inboxInsertOk) {
      try {
        const pushPayload = JSON.stringify({
          title: '🔔 BodyBank',
          body: trimmed.slice(0, 200),
          icon: '/icons/icon-192.png',
          id: 'inbox-' + inboxRowId
        });
        await _sendPushToUser(user.id, pushPayload);
        pushCount++;
      } catch (_) { /* expected for users without push subscriptions */ }
    }
  }

  // Persist aggregate send log
  try {
    await _run(
      'INSERT INTO campaign_send_log (id, message, sent_to, sent_at) VALUES (?, ?, ?, NOW())',
      [_uuidv4(), trimmed.slice(0, 500), inboxCount]
    );
  } catch (_) { /* non-critical */ }

  const nowIST = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });
  console.log(
    `[Campaign] ✅ Broadcast → inbox: ${inboxCount}/${users.length}, chat: ${chatCount}/${users.length}, push: ${pushCount}/${users.length} at ${nowIST} IST`
  );
  return inboxCount;
}

// ─── Job management ──────────────────────────────────────────────────────────

/**
 * Stop and remove a campaign's cron job (if any).
 */
function stopCampaign(id) {
  const key = String(id);
  const existing = _jobs.get(key);
  if (existing) {
    existing.stop();
    _jobs.delete(key);
  }
}

/**
 * Schedule a single campaign. Replaces any existing job for the same id.
 * Returns true on success, false if the schedule is invalid.
 */
function scheduleCampaign(campaign) {
  const { id, day_of_week, time_of_day, message } = campaign;
  const expr = buildCronExpression(day_of_week, time_of_day);

  if (!expr) {
    console.warn(
      `[Campaign] Skipping invalid schedule: id=${id} day=${day_of_week} time=${time_of_day}`
    );
    return false;
  }

  // Validate with node-cron before creating
  if (!cron.validate(expr)) {
    console.warn(`[Campaign] Invalid cron expression "${expr}" for campaign ${id}`);
    return false;
  }

  stopCampaign(id); // remove any previous job

  const task = cron.schedule(expr, async () => {
    const nowIST = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });
    console.log(`[Campaign] Firing: "${message}" (${day_of_week} ${time_of_day}) at ${nowIST} IST`);
    try {
      await broadcastMessage(message);
    } catch (e) {
      console.error(`[Campaign] Broadcast error for campaign ${id}:`, e.message);
    }
  }, {
    timezone: TIMEZONE,
    scheduled: true,
  });

  _jobs.set(String(id), task);
  console.log(
    `[Campaign] Scheduled: ${String(day_of_week).padEnd(9)} ${time_of_day} IST` +
    ` | cron: ${expr} | "${message}"`
  );
  return true;
}

/**
 * Stop all running cron jobs.
 */
function stopAll() {
  for (const [, task] of _jobs) {
    task.stop();
  }
  _jobs.clear();
}

/**
 * Load all active campaigns from DB and schedule them.
 * Clears all existing jobs first (safe restart).
 */
async function loadAndScheduleAll() {
  stopAll();

  let campaigns;
  try {
    campaigns = await _queryAll(
      "SELECT id, day_of_week, time_of_day, message" +
      " FROM campaign_messages WHERE is_active = TRUE" +
      " ORDER BY day_of_week, time_of_day"
    );
  } catch (e) {
    console.error('[Campaign] Failed to load campaigns from DB:', e.message);
    return 0;
  }

  let scheduled = 0;
  for (const c of (campaigns || [])) {
    if (scheduleCampaign(c)) scheduled++;
  }

  console.log(
    `[Campaign] Scheduler ready — ${scheduled} active job(s) running (timezone: ${TIMEZONE})`
  );
  return scheduled;
}

/**
 * Reload all campaigns from DB and reschedule.
 * Call after any CRUD operation on campaign_messages.
 */
async function restartScheduler() {
  console.log('[Campaign] Restarting scheduler...');
  return loadAndScheduleAll();
}

/**
 * Start the campaign scheduler.
 * Must be called AFTER the database is ready.
 *
 * @param {{ queryAll: Function, run: Function, sendPushToUser: Function, uuidv4: Function }} deps
 */
async function startCampaignScheduler({ queryAll, run, sendPushToUser, uuidv4 }) {
  _queryAll       = queryAll;
  _run            = run;
  _sendPushToUser = sendPushToUser;
  _uuidv4         = uuidv4;

  console.log('[Campaign] Initialising scheduler (timezone: Asia/Kolkata)...');
  return loadAndScheduleAll();
}

module.exports = {
  startCampaignScheduler,
  restartScheduler,
  broadcastMessage,
  scheduleCampaign,
  stopCampaign,
  getActiveUsers,
  buildCronExpression,
  /** @internal – exposed for unit tests only */
  _jobs,
};
