'use strict';

/**
 * Scheduled reminder & digest emails (IST).
 * Requires userEmailService SMTP + queryAll from server.
 */

const cron = require('node-cron');
const userEmail = require('./userEmailService');

const TZ = 'Asia/Kolkata';

let _queryAll = null;
let _jobs = [];

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUtcDateString() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function getApprovedUsersWithEmail() {
  return _queryAll(
    "SELECT id, email, first_name, last_name FROM users WHERE role = 'user' AND COALESCE(approval_status,'approved') = 'approved' AND email IS NOT NULL AND TRIM(email) <> ''"
  );
}

/** Saturday 18:00 IST — “tomorrow is Sunday check-in” */
async function runSaturdaySundayPrep() {
  if (!userEmail.isConfigured()) return;
  const users = await getApprovedUsersWithEmail();
  for (const u of users) {
    userEmail.emailSundayReminderTomorrow(u.email, u.first_name || '');
  }
}

/** Sunday 09:30 IST — nudge if no Sunday check-in submitted today (UTC date match with app storage) */
async function runSundayMorningReminder() {
  if (!userEmail.isConfigured()) return;
  const today = todayUtcDateString();
  const users = await getApprovedUsersWithEmail();
  for (const u of users) {
    const done = await _queryAll(
      "SELECT id FROM sunday_checkins WHERE created_at::date = ?::date AND (user_id = ? OR (reply_email IS NOT NULL AND LOWER(TRIM(reply_email)) = LOWER(TRIM(?))))",
      [today, u.id, u.email]
    );
    if (done && done.length) continue;
    userEmail.emailSundayReminderToday(u.email, u.first_name || '');
  }
}

/** Daily 20:00 IST — daily check-in nudge (no row for “today” UTC) */
async function runDailyCheckinReminder() {
  if (!userEmail.isConfigured()) return;
  const today = todayUtcDateString();
  const users = await getApprovedUsersWithEmail();
  for (const u of users) {
    const row = await _queryAll('SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [u.id, today]);
    if (row && row.length) continue;
    userEmail.emailDailyCheckinReminder(u.email, u.first_name || '');
  }
}

function wrap(fn) {
  return () => { fn().catch(e => console.warn('[emailScheduler]', e.message)); };
}

/** Monday 10:00 IST — nudge if no progress in 14 days */
async function runProgressNudge() {
  if (!userEmail.isConfigured()) return;
  const users = await getApprovedUsersWithEmail();
  for (const u of users) {
    const rows = await _queryAll(
      'SELECT id FROM progress_logs WHERE user_id = ? AND created_at >= NOW() - INTERVAL \'14 days\' LIMIT 1',
      [u.id]
    );
    if (rows && rows.length) continue;
    userEmail.emailProgressNudge(u.email, u.first_name || '');
  }
}

/** Daily 21:15 IST — attention escalation for inactive users (2d / 5d milestones) */
async function runInactiveAttentionEscalation() {
  if (!userEmail.isConfigured()) return;

  const today = todayUtcDateString();
  const todayDt = new Date(today + 'T00:00:00Z');
  const users = await getApprovedUsersWithEmail();

  for (const u of users) {
    const rows = await _queryAll(
      `SELECT
        COALESCE(
          (SELECT MAX(dc.checkin_date)::date FROM daily_checkins dc WHERE dc.user_id = ?),
          (SELECT created_at::date FROM users u2 WHERE u2.id = ?)
        ) AS last_date`,
      [u.id, u.id]
    );

    if (!rows || !rows.length || !rows[0].last_date) continue;
    const lastDate = String(rows[0].last_date).slice(0, 10);
    const inactiveDays = Math.floor((todayDt - new Date(lastDate + 'T00:00:00Z')) / (24 * 60 * 60 * 1000));
    if (inactiveDays < 2) continue;

    const milestoneKey = inactiveDays >= 5 ? '5d' : '2d';
    const severity = inactiveDays >= 5 ? 'P0' : 'P1';

    const exists = await _queryAll(
      'SELECT 1 FROM attention_email_log WHERE user_id = ? AND milestone_key = ? AND last_checkin_date = ? LIMIT 1',
      [u.id, milestoneKey, lastDate]
    );
    if (exists && exists.length) continue;

    await _queryAll(
      'INSERT INTO attention_email_log (user_id, milestone_key, last_checkin_date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [u.id, milestoneKey, lastDate]
    );

    const inboxId = 'inact-' + milestoneKey + '-' + u.id + '-' + lastDate;
    const title = severity === 'P0' ? 'High attention — check-in needed' : 'Attention — daily check-in waiting';
    const body = 'We haven’t seen your daily check-in for ' + inactiveDays + ' days. Tap to log today and keep your momentum going.';

    await _queryAll(
      'INSERT INTO user_inbox (id, user_id, title, body, type, is_read, created_at) VALUES (?, ?, ?, ?, ?, FALSE, NOW()) ON CONFLICT DO NOTHING',
      [inboxId, u.id, title, body, 'inactivity_attention']
    );

    userEmail.emailInactiveAttention(u.email, u.first_name || '', severity, inactiveDays);
  }
}

/** Daily 07:30 IST — brief for yesterday’s check-in */
async function runDailyDigest() {
  if (!userEmail.isConfigured()) return;
  const y = yesterdayUtcDateString();
  const users = await getApprovedUsersWithEmail();
  for (const u of users) {
    const d = await _queryAll(
      'SELECT steps, water_ml, protein_g, sleep_hours FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date',
      [u.id, y]
    );
    if (!d || !d.length) {
      userEmail.emailDailyDigest(u.email, u.first_name || '', []);
      continue;
    }
    const r = d[0];
    const lines = [];
    if (r.steps != null) lines.push(`Steps: ${r.steps}`);
    if (r.water_ml != null) lines.push(`Water: ${r.water_ml} ml`);
    if (r.protein_g != null) lines.push(`Protein: ${r.protein_g} g`);
    if (r.sleep_hours != null) lines.push(`Sleep: ${r.sleep_hours} hrs`);
    userEmail.emailDailyDigest(u.email, u.first_name || '', lines);
  }
}

/** Monday 08:00 IST — weekly summary */
async function runWeeklyDigest() {
  if (!userEmail.isConfigured()) return;
  const users = await getApprovedUsersWithEmail();
  for (const u of users) {
    const dc = await _queryAll(
      `SELECT COUNT(*)::int AS c FROM daily_checkins WHERE user_id = ? AND checkin_date >= (CURRENT_DATE - INTERVAL '7 days')`,
      [u.id]
    );
    const wc = await _queryAll(
      `SELECT COUNT(*)::int AS c FROM workout_logs WHERE user_id = ? AND created_at >= NOW() - INTERVAL '7 days'`,
      [u.id]
    );
    const sc = await _queryAll(
      `SELECT COUNT(*)::int AS c FROM sunday_checkins WHERE user_id = ? AND created_at >= NOW() - INTERVAL '7 days'`,
      [u.id]
    );
    const pl = await _queryAll(
      `SELECT COUNT(*)::int AS c FROM progress_logs WHERE user_id = ? AND created_at >= NOW() - INTERVAL '7 days'`,
      [u.id]
    );
    const lines = [
      `Daily check-ins logged (7 days): ${dc && dc[0] ? dc[0].c : 0}`,
      `Workouts logged: ${wc && wc[0] ? wc[0].c : 0}`,
      `Sunday check-ins: ${sc && sc[0] ? sc[0].c : 0}`,
      `Progress entries: ${pl && pl[0] ? pl[0].c : 0}`
    ];
    userEmail.emailWeeklyDigest(u.email, u.first_name || '', lines);
  }
}

function startEmailScheduler({ queryAll }) {
  _queryAll = queryAll;
  if (!userEmail.isConfigured()) {
    console.log('[emailScheduler] SMTP not configured — scheduled member emails disabled');
    return;
  }
  _jobs.forEach(j => j.stop());
  _jobs = [];

  _jobs.push(cron.schedule('0 18 * * 6', wrap(runSaturdaySundayPrep), { timezone: TZ }));
  _jobs.push(cron.schedule('30 9 * * 0', wrap(runSundayMorningReminder), { timezone: TZ }));
  _jobs.push(cron.schedule('0 20 * * *', wrap(runDailyCheckinReminder), { timezone: TZ }));
  _jobs.push(cron.schedule('15 21 * * *', wrap(runInactiveAttentionEscalation), { timezone: TZ }));
  _jobs.push(cron.schedule('30 7 * * *', wrap(runDailyDigest), { timezone: TZ }));
  _jobs.push(cron.schedule('0 8 * * 1', wrap(runWeeklyDigest), { timezone: TZ }));
  _jobs.push(cron.schedule('0 10 * * 1', wrap(runProgressNudge), { timezone: TZ }));

  console.log('[emailScheduler] Reminder & digest jobs started (timezone: ' + TZ + ')');
}

module.exports = { startEmailScheduler };
