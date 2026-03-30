'use strict';

/**
 * Scheduled reminder & digest emails (IST).
 * Requires userEmailService SMTP + queryAll from server.
 */

const cron = require('node-cron');
const userEmail = require('./userEmailService');
const PDFDocument = require('pdfkit');

const TZ = 'Asia/Kolkata';
const ADMIN_DAILY_REPORT_EMAIL = 'bodybank.fit369@gmail.com';

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

function toIstPseudoDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() + (330 * 60 * 1000));
}

function fromIstPseudoDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() - (330 * 60 * 1000));
}

function getIstComplianceWindow(now = new Date()) {
  const istNow = toIstPseudoDate(now);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const noonIst = new Date(Date.UTC(y, m, d, 12, 0, 0));
  const endIst = istNow.getTime() >= noonIst.getTime()
    ? noonIst
    : new Date(noonIst.getTime() - (24 * 60 * 60 * 1000));
  const startIst = new Date(endIst.getTime() - (24 * 60 * 60 * 1000));
  return {
    startUtc: fromIstPseudoDate(startIst),
    endUtc: fromIstPseudoDate(endIst)
  };
}

function fmtIst(date) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildAdminReportPdf({ rows, summary, windowLabel }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const col = { name: 190, daily: 82, progress: 82, sunday: 82, workout: 82 };
    const rowH = 24;

    function drawHeader() {
      doc
        .fillColor('#111111')
        .font('Helvetica-Bold')
        .fontSize(16)
        .text('BodyBank Daily Compliance Report', { align: 'left' });
      doc
        .moveDown(0.3)
        .fillColor('#555555')
        .font('Helvetica')
        .fontSize(10)
        .text(windowLabel, { align: 'left' });

      doc.moveDown(0.8);
      const startY = doc.y;
      const boxW = (pageW - 24) / 3;
      const stats = [
        `Active Users\n${summary.totalUsers}`,
        `Daily Yes\n${summary.dailyYes}`,
        `Daily Missed\n${summary.dailyMissed}`
      ];
      for (let i = 0; i < stats.length; i++) {
        const x = doc.page.margins.left + (i * (boxW + 12));
        doc.roundedRect(x, startY, boxW, 46, 6).fillAndStroke('#F8F8F8', '#D8D8D8');
        const parts = stats[i].split('\n');
        doc.fillColor('#7A6220').font('Helvetica').fontSize(9).text(parts[0], x + 10, startY + 9, { width: boxW - 20, align: 'left' });
        doc.fillColor('#111111').font('Helvetica-Bold').fontSize(14).text(parts[1], x + 10, startY + 22, { width: boxW - 20, align: 'left' });
      }
      doc.y = startY + 58;
    }

    function ensureSpace(heightNeeded) {
      if (doc.y + heightNeeded > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    }

    function drawTableHeader() {
      ensureSpace(rowH + 8);
      const y = doc.y;
      let x = doc.page.margins.left;
      const labels = ['User Name', 'Daily', 'Progress', 'Sunday', 'Workout'];
      const widths = [col.name, col.daily, col.progress, col.sunday, col.workout];
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10);
      for (let i = 0; i < labels.length; i++) {
        doc.roundedRect(x, y, widths[i], rowH, 4).fillAndStroke('#EFE7D2', '#D1C099');
        doc.fillColor('#111111').text(labels[i], x + 8, y + 7, { width: widths[i] - 16, align: i === 0 ? 'left' : 'center' });
        x += widths[i];
      }
      doc.y = y + rowH + 6;
    }

    function drawStatus(value, x, y, w) {
      const isYes = String(value) === 'Yes';
      doc.roundedRect(x + 8, y + 4, w - 16, rowH - 8, 6).fillAndStroke(isYes ? '#E8F5EE' : '#FDEBEC', isYes ? '#A6D9BB' : '#E8A8AC');
      doc.fillColor(isYes ? '#0F6A43' : '#A13B44').font('Helvetica-Bold').fontSize(9).text(value, x + 8, y + 9, { width: w - 16, align: 'center' });
    }

    drawHeader();
    drawTableHeader();

    for (let i = 0; i < rows.length; i++) {
      ensureSpace(rowH + 4);
      if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        drawTableHeader();
      }
      const y = doc.y;
      const zebra = i % 2 === 0 ? '#FFFFFF' : '#FAFAFA';
      doc.rect(doc.page.margins.left, y, pageW, rowH).fillAndStroke(zebra, '#ECECEC');

      let x = doc.page.margins.left;
      doc.fillColor('#1B1B1B').font('Helvetica').fontSize(9).text(String(rows[i].name || '-'), x + 8, y + 7, { width: col.name - 16, ellipsis: true });
      x += col.name;
      drawStatus(rows[i].daily_status, x, y, col.daily); x += col.daily;
      drawStatus(rows[i].progress_status, x, y, col.progress); x += col.progress;
      drawStatus(rows[i].sunday_status, x, y, col.sunday); x += col.sunday;
      drawStatus(rows[i].workout_status, x, y, col.workout);

      doc.y = y + rowH;
    }

    doc.moveDown(0.7);
    doc.fillColor('#666666').font('Helvetica').fontSize(9).text('Legend: Yes = submitted in report window, Missed = not submitted.', { align: 'left' });
    doc.end();
  });
}

function buildAdminReportHtml({ rows, summary, windowLabel }) {
  const esc = userEmail.escapeHtml;
  const rowHtml = rows.map((r) => {
    const status = (v) => {
      const yes = String(v) === 'Yes';
      const bg = yes ? '#E8F5EE' : '#FDEBEC';
      const fg = yes ? '#0F6A43' : '#A13B44';
      return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${bg};color:${fg};font-weight:700;font-size:12px">${esc(v)}</span>`;
    };
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08)">${esc(r.name || '-')}</td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:center">${status(r.daily_status)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:center">${status(r.progress_status)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:center">${status(r.sunday_status)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:center">${status(r.workout_status)}</td>
    </tr>`;
  }).join('');

  return userEmail.luxuryWrap({
    title: 'Admin Daily Compliance Report',
    preheader: '12:00 to 12:00 IST check-in compliance report',
    lead: 'Daily operations report for active clients.',
    bodyHtml: `
      <p style="margin:0 0 12px"><strong>Window:</strong> ${esc(windowLabel)}</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;border-collapse:collapse;background:rgba(255,255,255,0.02);border:1px solid rgba(200,164,78,0.25);border-radius:12px;overflow:hidden">
        <tr>
          <td style="padding:14px"><strong>Active Users:</strong> ${summary.totalUsers}</td>
          <td style="padding:14px"><strong>Daily Yes:</strong> ${summary.dailyYes}</td>
          <td style="padding:14px"><strong>Daily Missed:</strong> ${summary.dailyMissed}</td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid rgba(255,255,255,0.08);font-size:13px">
        <thead>
          <tr style="background:rgba(200,164,78,0.14);color:#f5f0e8">
            <th style="padding:10px 12px;text-align:left">User Name</th>
            <th style="padding:10px 12px;text-align:center">Daily Check-in</th>
            <th style="padding:10px 12px;text-align:center">My Progress</th>
            <th style="padding:10px 12px;text-align:center">Sunday Check-in</th>
            <th style="padding:10px 12px;text-align:center">Workout Logged</th>
          </tr>
        </thead>
        <tbody>${rowHtml || '<tr><td colspan="5" style="padding:12px;text-align:center;color:#bbb">No active users found.</td></tr>'}</tbody>
      </table>
    `
  });
}

async function getAdminDailyComplianceReportData(opts = {}) {
  if (!_queryAll && !opts.queryAll) return { sent: false, reason: 'query_not_configured' };
  const queryAll = opts.queryAll || _queryAll;
  const now = opts.now || new Date();
  const window = getIstComplianceWindow(now);
  const startIso = window.startUtc.toISOString().slice(0, 19).replace('T', ' ');
  const endIso = window.endUtc.toISOString().slice(0, 19).replace('T', ' ');

  const rows = await queryAll(
    `SELECT
      u.id,
      TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
      CASE WHEN EXISTS (
        SELECT 1 FROM daily_checkins d
        WHERE d.user_id = u.id
          AND d.created_at >= ?::timestamp
          AND d.created_at < ?::timestamp
      ) THEN 'Yes' ELSE 'Missed' END AS daily_status,
      CASE WHEN EXISTS (
        SELECT 1 FROM progress_logs p
        WHERE p.user_id = u.id
          AND p.created_at >= ?::timestamp
          AND p.created_at < ?::timestamp
      ) THEN 'Yes' ELSE 'Missed' END AS progress_status,
      CASE WHEN EXISTS (
        SELECT 1 FROM sunday_checkins s
        WHERE s.user_id = u.id
          AND s.created_at >= ?::timestamp
          AND s.created_at < ?::timestamp
      ) THEN 'Yes' ELSE 'Missed' END AS sunday_status,
      CASE WHEN EXISTS (
        SELECT 1 FROM workout_logs w
        WHERE w.user_id = u.id
          AND w.created_at >= ?::timestamp
          AND w.created_at < ?::timestamp
      ) THEN 'Yes' ELSE 'Missed' END AS workout_status
    FROM users u
    WHERE u.role = 'user'
      AND COALESCE(u.approval_status, 'approved') = 'approved'
      AND COALESCE(u.suspended, FALSE) = FALSE
    ORDER BY TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), u.email`,
    [startIso, endIso, startIso, endIso, startIso, endIso, startIso, endIso]
  );

  const summary = {
    totalUsers: rows.length,
    dailyYes: rows.filter(r => r.daily_status === 'Yes').length,
    dailyMissed: rows.filter(r => r.daily_status !== 'Yes').length
  };
  const windowLabel = `${fmtIst(window.startUtc)} IST to ${fmtIst(window.endUtc)} IST`;
  return {
    window,
    startIso,
    endIso,
    windowLabel,
    rows,
    summary
  };
}

async function sendAdminDailyComplianceReport(opts = {}) {
  if (!userEmail.isConfigured()) return { sent: false, reason: 'smtp_not_configured' };
  const data = await getAdminDailyComplianceReportData(opts);
  if (data && data.reason) return data;
  const reportKey = `daily-${data.window.endUtc.toISOString().slice(0, 10)}`;

  const queryAll = opts.queryAll || _queryAll;
  const prior = await queryAll('SELECT report_key FROM admin_daily_report_log WHERE report_key = ? LIMIT 1', [reportKey]).catch(() => []);
  if (prior && prior.length && !opts.force) {
    return { sent: false, reason: 'already_sent', reportKey };
  }

  const { rows, summary, windowLabel, startIso, endIso, window } = data;
  const html = buildAdminReportHtml({ rows, summary, windowLabel });
  const pdf = await buildAdminReportPdf({ rows, summary, windowLabel });
  const subject = `BodyBank Daily Compliance Report - ${fmtIst(window.endUtc)} IST`;
  const text = `BodyBank Daily Compliance Report\nWindow: ${windowLabel}\nActive: ${summary.totalUsers}\nDaily Yes: ${summary.dailyYes}\nDaily Missed: ${summary.dailyMissed}`;

  const sent = await userEmail.sendMail(
    ADMIN_DAILY_REPORT_EMAIL,
    subject,
    html,
    text,
    [{
      filename: `bodybank-daily-compliance-${window.endUtc.toISOString().slice(0, 10)}.pdf`,
      content: pdf,
      contentType: 'application/pdf'
    }]
  );
  if (!sent) return { sent: false, reason: 'mail_failed' };

  await queryAll(
    'INSERT INTO admin_daily_report_log (report_key, window_start, window_end, recipient_email) VALUES (?, ?::timestamp, ?::timestamp, ?) ON CONFLICT DO NOTHING',
    [reportKey, startIso, endIso, ADMIN_DAILY_REPORT_EMAIL]
  ).catch(() => {});

  return { sent: true, reportKey, recipient: ADMIN_DAILY_REPORT_EMAIL, summary };
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
  _jobs.push(cron.schedule('10 12 * * *', wrap(sendAdminDailyComplianceReport), { timezone: TZ }));

  console.log('[emailScheduler] Reminder & digest jobs started (timezone: ' + TZ + ')');
}

module.exports = { startEmailScheduler, sendAdminDailyComplianceReport, getAdminDailyComplianceReportData };
