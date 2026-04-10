'use strict';

/**
 * Luxury transactional & lifecycle emails for BodyBank members.
 * Requires SMTP_HOST, SMTP_USER, SMTP_PASS (same as password reset).
 */

const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const SMTP_FROM = (process.env.SMTP_FROM || 'BodyBank <noreply@bodybank.fit>').trim();
const APP_BASE = (process.env.RESET_BASE_URL || process.env.APP_BASE_URL || process.env.SITE_URL || 'https://bodybank.fit').replace(/\/$/, '');

function isConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function escapeHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTransporter() {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000
  });
}

function fromAddress() {
  const isGmail = SMTP_HOST === 'smtp.gmail.com' || SMTP_HOST === 'gmail';
  return isGmail ? `BodyBank <${SMTP_USER}>` : (SMTP_FROM || `BodyBank <${SMTP_USER}>`);
}

/**
 * Dark luxury HTML shell — gold accent, minimal, professional.
 */
function luxuryWrap({ title, preheader, lead, bodyHtml, ctaLabel, ctaUrl }) {
  const ph = escapeHtml(preheader || title || '');
  const safeLead = lead ? `<p style="margin:0 0 24px;font-size:17px;line-height:1.65;color:#f5f0e8;font-weight:400">${escapeHtml(lead)}</p>` : '';
  const cta = ctaLabel && ctaUrl
    ? `<p style="margin:28px 0 0"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#c8a44e,#a8863a);color:#0d0d0d;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.5px;border-radius:8px">${escapeHtml(ctaLabel)}</a></p>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,'Times New Roman',serif;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0">${ph}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0a0a0a;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;border:1px solid rgba(200,164,78,0.25);border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#141414 0%,#0d0d0d 100%);">
<tr><td style="padding:32px 36px 8px;text-align:center;border-bottom:1px solid rgba(200,164,78,0.15)">
<p style="margin:0;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#c8a44e;font-family:system-ui,-apple-system,sans-serif">BodyBank</p>
<h1 style="margin:12px 0 0;font-size:22px;font-weight:400;color:#f5f0e8;letter-spacing:0.5px">${escapeHtml(title)}</h1>
</td></tr>
<tr><td style="padding:28px 36px 36px;color:#d4cfc4;font-size:15px;line-height:1.7">
${safeLead}
${bodyHtml || ''}
${cta}
<p style="margin:32px 0 0;font-size:12px;color:#888;font-family:system-ui,-apple-system,sans-serif;line-height:1.5">With care,<br><span style="color:#c8a44e">Your Lifestyle Team</span></p>
</td></tr>
</table>
<p style="margin:24px 0 0;font-size:11px;color:#555;font-family:system-ui,-apple-system,sans-serif">You are receiving this because you use BodyBank. If this wasn’t you, you can ignore this message.</p>
</td></tr></table></body></html>`;
}

async function sendMail(to, subject, html, text, attachments) {
  if (!isConfigured() || !to) return false;
  try {
    const transporter = getTransporter();
    console.log('[userEmail] Sending:', subject, 'to', String(to).trim().toLowerCase());
    await transporter.sendMail({
      from: fromAddress(),
      to: String(to).trim().toLowerCase(),
      subject,
      text: text || subject,
      html,
      attachments: Array.isArray(attachments) ? attachments : undefined
    });
    console.log('[userEmail] Sent:', subject, 'to', String(to).trim().toLowerCase());
    return true;
  } catch (e) {
    console.warn('[userEmail]', subject, e.message);
    return false;
  }
}

function fire(fn) {
  if (!isConfigured()) return;
  Promise.resolve().then(fn).catch(e => console.warn('[userEmail] async', e.message));
}

// ——— Transactional ———

function emailSignupPending(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'We’ve received your request',
      preheader: 'Your BodyBank journey begins with this step.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Thank you for choosing BodyBank. Your account is being reviewed by our team with the attention it deserves.</p>
<p style="margin:0">You’ll receive another email as soon as your access is approved. Until then, know that your commitment to transformation already matters.</p>`,
      ctaLabel: 'Visit BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Welcome — your BodyBank request is received', html);
  });
}

function emailGoogleSignupPending(email, firstName) {
  emailSignupPending(email, firstName);
}

function emailAccountApproved(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'You’re in — welcome to BodyBank',
      preheader: 'Your membership is active.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">We’re delighted to welcome you. Your account is now active — log in to explore your dashboard, connect with your Lifestyle Manager, and begin your personalised path.</p>
<p style="margin:0">Consistency is the bridge between goals and results. We’re honoured to walk it with you.</p>`,
      ctaLabel: 'Open your dashboard',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'You’re approved — welcome to BodyBank', html);
  });
}

function emailAccountRejected(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Update on your BodyBank request',
      preheader: 'Regarding your membership application.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Thank you for your interest in BodyBank. We’re unable to approve your request at this time.</p>
<p style="margin:0">If you believe this was in error, or you’d like to apply again with updated information, you’re welcome to start a new sign-up from our website.</p>`,
      ctaLabel: 'Return to BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Update on your BodyBank application', html);
  });
}

function emailPasswordResetLuxury(email, resetLink) {
  fire(async () => {
    const html = luxuryWrap({
      title: 'Reset your password',
      preheader: 'Secure link — valid 24 hours.',
      lead: null,
      bodyHtml: `<p style="margin:0 0 16px">We received a request to reset your BodyBank password. Tap the button below to choose a new one. This link expires in 24 hours.</p>
<p style="margin:0;font-size:13px;color:#888;word-break:break-all">${escapeHtml(resetLink)}</p>`,
      ctaLabel: 'Reset password',
      ctaUrl: resetLink
    });
    await sendMail(email, 'Reset your BodyBank password', html);
  });
}

function emailPasswordChanged(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Your password was updated',
      preheader: 'Your account is secure.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0">Your BodyBank password was just changed. If this was you, no further action is needed. If you didn’t make this change, please contact support immediately.</p>`,
      ctaLabel: 'Sign in',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Your BodyBank password was updated', html);
  });
}

function emailAuditReceived(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Your Body Audit is with us',
      preheader: 'Thank you for your trust.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">We’ve received your Body Audit submission. Our team will review your story with care.</p>
<p style="margin:0">Taking this step reflects real courage — we’re proud to support you.</p>`,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'We received your Body Audit', html);
  });
}

function emailPart2Received(email, name) {
  fire(async () => {
    const n = name || 'there';
    const html = luxuryWrap({
      title: 'Part-2 questionnaire received',
      preheader: 'Your details help us serve you better.',
      lead: `Dear ${n},`,
      bodyHtml: `<p style="margin:0 0 16px">Thank you for completing the Part-2 form. Your answers deepen our understanding of you — movement, mindset, and lifestyle.</p>
<p style="margin:0">We’ll use this to refine your experience alongside your Lifestyle Manager.</p>`,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'We received your Part-2 form', html);
  });
}

function emailSundayCheckinReceived(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Sunday check-in — beautifully done',
      preheader: 'Your weekly reflection is saved.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Your Sunday check-in has been received. Reflecting on your week is one of the most powerful habits you can build — and you just did it.</p>
<p style="margin:0">We’ll review your notes and continue to stand beside you, one week at a time.</p>`,
      ctaLabel: 'View your dashboard',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Sunday check-in received — thank you', html);
  });
}

function emailDailyCheckinReceived(email, firstName, summaryLines) {
  fire(async () => {
    const name = firstName || 'there';
    const lines = (summaryLines || []).map(l => `<p style="margin:0 0 8px;color:#e8e4dc">${escapeHtml(l)}</p>`).join('');
    const html = luxuryWrap({
      title: 'Today’s check-in is logged',
      preheader: 'Small steps, compounding wins.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Your daily check-in is saved. Showing up today is worth celebrating.</p>${lines || '<p style="margin:0">Keep building momentum — we’re cheering for you.</p>'}`,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Daily check-in saved — nice work', html);
  });
}

function emailProgressSaved(email, firstName, summaryLines) {
  fire(async () => {
    const name = firstName || 'there';
    const lines = (summaryLines || []).map(l => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('');
    const html = luxuryWrap({
      title: 'Your progress entry is saved',
      preheader: 'Data that tells your story.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Your progress log has been recorded. Every entry is a brick in the foundation of your transformation.</p>${lines}`,
      ctaLabel: 'View progress',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Progress saved — keep going', html);
  });
}

function emailWorkoutLogged(email, firstName, workoutName, durationMin) {
  fire(async () => {
    const name = firstName || 'there';
    const dur = durationMin != null ? `${durationMin} min` : '';
    const html = luxuryWrap({
      title: 'Workout logged — outstanding',
      preheader: 'Movement is medicine.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">We’ve recorded your session${workoutName ? `: <strong style="color:#c8a44e">${escapeHtml(workoutName)}</strong>` : ''}${dur ? ` · ${escapeHtml(dur)}` : ''}.</p>
<p style="margin:0">Consistency beats intensity. Another rep in the story of your best self.</p>`,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Workout logged — well done', html);
  });
}

function emailMeetingScheduled(email, firstName, dateStr, timeStr) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Your call is scheduled',
      preheader: 'We’ll see you then.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Your meeting with the team is confirmed.</p>
<p style="margin:0 0 8px"><strong style="color:#c8a44e">Date:</strong> ${escapeHtml(dateStr || '—')}</p>
<p style="margin:0"><strong style="color:#c8a44e">Time:</strong> ${escapeHtml(timeStr || '—')}</p>
<p style="margin:16px 0 0">Add it to your calendar — we look forward to connecting.</p>`,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Your BodyBank call is scheduled', html);
  });
}

function emailContactReceived(email, name) {
  fire(async () => {
    const n = name || 'there';
    const html = luxuryWrap({
      title: 'We received your message',
      preheader: 'The team will get back to you.',
      lead: `Dear ${n},`,
      bodyHtml: `<p style="margin:0">Thank you for reaching out. Your message is in safe hands — we’ll respond as soon as we can.</p>`,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'We received your message — BodyBank', html);
  });
}

function emailCoachReply(email, firstName, preview) {
  fire(async () => {
    const name = firstName || 'there';
    const prev = (preview || '').slice(0, 200);
    const html = luxuryWrap({
      title: 'Your Lifestyle Manager replied',
      preheader: 'You have a new message.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">You have a new reply in your BodyBank messages.</p>
<p style="margin:0;padding:12px 16px;background:rgba(200,164,78,0.08);border-left:3px solid #c8a44e;font-size:14px;color:#d4cfc4">${escapeHtml(prev)}${(preview || '').length > 200 ? '…' : ''}</p>`,
      ctaLabel: 'Read message',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'New message from your Lifestyle Manager', html);
  });
}

// ——— Scheduled / digest (called from emailScheduler) ———

function emailSundayReminderTomorrow(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Tomorrow: your Sunday check-in',
      preheader: 'A gentle heads-up.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0 0 16px">Sunday is your moment to reflect — weight, habits, wins, and what’s next. A few thoughtful minutes keep your journey aligned.</p>
<p style="margin:0">We’ll be ready when you are.</p>`,
      ctaLabel: 'Open check-in',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Tomorrow — Sunday check-in awaits', html);
  });
}

function emailSundayReminderToday(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Your Sunday check-in is waiting',
      preheader: 'Complete it when you can.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0">This is a gentle nudge: your weekly Sunday check-in hasn’t been submitted yet. When you’re ready, we’re here — your reflection matters.</p>`,
      ctaLabel: 'Submit check-in',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Reminder — Sunday check-in', html);
  });
}

function emailDailyCheckinReminder(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'Your daily check-in',
      preheader: 'Two minutes for your future self.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0">We haven’t seen today’s micro-goals yet — steps, water, protein, sleep. Small inputs, remarkable outcomes. Tap below when you can.</p>`,
      ctaLabel: 'Log today',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Gentle reminder — daily check-in', html);
  });
}

function emailProgressNudge(email, firstName) {
  fire(async () => {
    const name = firstName || 'there';
    const html = luxuryWrap({
      title: 'We’d love to see your progress',
      preheader: 'Your metrics tell the story.',
      lead: `Dear ${name},`,
      bodyHtml: `<p style="margin:0">It’s been a little while since your last progress entry. Even a quick log helps your Lifestyle Manager support you better — and celebrates how far you’ve come.</p>`,
      ctaLabel: 'Log progress',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Your progress — we’re here for you', html);
  });
}

// Attention escalation for inactive users (2d / 5d milestones)
function emailInactiveAttention(email, firstName, severity, inactiveDays) {
  fire(async () => {
    const name = firstName || 'there';
    const sev = severity === 'P0' ? 'P0' : 'P1'; // treat unknown as P1
    const days = inactiveDays != null ? String(inactiveDays) : '';
    const isP0 = sev === 'P0';
    const title = isP0 ? 'Urgent attention — please check in today' : 'A gentle attention — log today';
    const preheader = isP0 ? 'We haven’t seen your daily check-in.' : 'Your check-in is waiting.';
    const lead = `Dear ${name},`;
    const bodyHtml =
      isP0
        ? `<p style="margin:0 0 16px">We haven’t seen your daily check-in for ${days} days. This is your moment to reset the rhythm.</p>
<p style="margin:0">Log steps, water, protein, and sleep — and your Lifestyle Manager can support you properly again.</p>`
        : `<p style="margin:0 0 16px">We haven’t seen your daily check-in for ${days} days. Even one quick check-in helps us keep you aligned.</p>
<p style="margin:0">When you’re ready, log your steps, water, protein, and sleep — it takes two minutes.</p>`;

    const html = luxuryWrap({
      title,
      preheader,
      lead,
      bodyHtml,
      ctaLabel: 'Log daily check-in',
      ctaUrl: APP_BASE + '/'
    });

    await sendMail(email, 'Attention — your daily check-in is waiting', html);
  });
}

function emailDailyDigest(email, firstName, lines) {
  fire(async () => {
    const name = firstName || 'there';
    const arr = lines || [];
    const body = arr.length
      ? arr.map(l => `<p style="margin:0 0 10px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:10px">${escapeHtml(l)}</p>`).join('')
      : '<p style="margin:0">No micro-goals were logged yesterday — today is a fresh chance to show up for yourself.</p>';
    const html = luxuryWrap({
      title: 'Your yesterday at a glance',
      preheader: 'BodyBank daily brief.',
      lead: `Dear ${name},`,
      bodyHtml: body,
      ctaLabel: 'Open BodyBank',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Your BodyBank yesterdays Daily Brief', html);
  });
}

function emailWeeklyDigest(email, firstName, lines) {
  fire(async () => {
    const name = firstName || 'there';
    const body = (lines || []).map(l => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('');
    const html = luxuryWrap({
      title: 'Your week in review',
      preheader: 'BodyBank weekly summary.',
      lead: `Dear ${name},`,
      bodyHtml: body || '<p style="margin:0">Thank you for another week with BodyBank. Keep showing up — that’s the work that changes everything.</p>',
      ctaLabel: 'Open dashboard',
      ctaUrl: APP_BASE + '/'
    });
    await sendMail(email, 'Your BodyBank weekly review', html);
  });
}

/** Dark-card HTML nutrition day report (matches Nutrition AI feature). */
async function emailNutritionDayReport(email, firstName, payload) {
  if (!isConfigured() || !email) return false;
  const name = firstName || 'there';
  const { formattedDate, stats, meals, energyDiff } = payload;
  const s = stats || {};
  const mealRows = (meals || [])
    .map((m) => {
      const ar = m.aiResult || {};
      const mt = String(m.mealType || '').replace(/^\w/, (c) => c.toUpperCase());
      return `<div style="border-bottom:1px solid #1e2328;padding:12px 0">
  <div style="font-weight:600;margin-bottom:4px">${escapeHtml(mt)}: ${escapeHtml(ar.dish || '—')}</div>
  <div style="font-size:12px;color:#8a8880">${escapeHtml(String(ar.calories ?? '—'))} kcal · ${escapeHtml(String(ar.protein ?? '—'))}g protein · ${escapeHtml(String(ar.carbs ?? '—'))}g carbs · ${escapeHtml(String(ar.fat ?? '—'))}g fat · Score: ${escapeHtml(String(m.mealScore ?? '—'))}/10</div>
</div>`;
    })
    .join('');

  const ed =
    energyDiff != null && Number.isFinite(Number(energyDiff))
      ? `<div style="background:${Number(energyDiff) >= 0 ? 'rgba(61,214,140,0.1)' : 'rgba(255,92,92,0.1)'};border:1px solid ${Number(energyDiff) >= 0 ? 'rgba(61,214,140,0.25)' : 'rgba(255,92,92,0.25)'};border-radius:10px;padding:16px;margin-bottom:24px">
  <div style="font-size:12px;color:#8a8880;margin-bottom:4px">ENERGY DIFFERENCE (Burned − Intake)</div>
  <div style="font-size:24px;font-weight:700;color:${Number(energyDiff) >= 0 ? '#3dd68c' : '#ff5c5c'}">${Number(energyDiff) >= 0 ? '+' : ''}${escapeHtml(String(energyDiff))} kcal</div>
</div>`
      : '';

  const inner = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#0d0f11;color:#f0ede8;padding:32px;border-radius:16px">
  <h2 style="color:#3dd68c;margin-bottom:4px">BodyBank Nutrition Report</h2>
  <p style="color:#8a8880;margin-bottom:24px">${escapeHtml(formattedDate || '')}</p>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
    <div style="background:#161a1e;border-radius:10px;padding:14px;text-align:center"><div style="font-size:11px;color:#8a8880;margin-bottom:4px">CALORIES</div><div style="font-size:22px;font-weight:700;color:#f5a623">${escapeHtml(String(s.totalCalories ?? '—'))}</div></div>
    <div style="background:#161a1e;border-radius:10px;padding:14px;text-align:center"><div style="font-size:11px;color:#8a8880;margin-bottom:4px">PROTEIN</div><div style="font-size:22px;font-weight:700;color:#3dd68c">${escapeHtml(String(s.totalProtein ?? '—'))}g</div></div>
    <div style="background:#161a1e;border-radius:10px;padding:14px;text-align:center"><div style="font-size:11px;color:#8a8880;margin-bottom:4px">CARBS</div><div style="font-size:22px;font-weight:700;color:#4da6ff">${escapeHtml(String(s.totalCarbs ?? '—'))}g</div></div>
    <div style="background:#161a1e;border-radius:10px;padding:14px;text-align:center"><div style="font-size:11px;color:#8a8880;margin-bottom:4px">FAT</div><div style="font-size:22px;font-weight:700;color:#ff5c5c">${escapeHtml(String(s.totalFat ?? '—'))}g</div></div>
  </div>
  ${ed}
  ${mealRows}
  <div style="margin-top:24px;background:#161a1e;border-radius:10px;padding:14px">
    <div style="font-size:11px;color:#8a8880;margin-bottom:4px">MEAL QUALITY SCORE</div>
    <div style="font-size:28px;font-weight:700;color:#3dd68c">${escapeHtml(String(s.mealQualityScore ?? '—'))}/10</div>
  </div>
</div>`;

  const html = luxuryWrap({
    title: 'Your nutrition report',
    preheader: `Macros for ${formattedDate || 'today'}.`,
    lead: `Dear ${name},`,
    bodyHtml: inner,
    ctaLabel: 'Open BodyBank',
    ctaUrl: APP_BASE + '/'
  });
  return sendMail(email, `Your BodyBank Nutrition Report — ${formattedDate || ''}`, html);
}

async function emailNutritionWeeklySummary(email, firstName, report) {
  if (!isConfigured() || !email) return false;
  const name = firstName || 'there';
  const r = report || {};
  const bodyHtml = `<p style="margin:0 0 16px">Here is your 7-day nutrition snapshot from BodyBank AI.</p>
<ul style="margin:0;padding-left:20px;color:#d4cfc4;line-height:1.8">
<li>Avg daily calories: <strong>${escapeHtml(String(r.avgCalories ?? '—'))}</strong></li>
<li>Avg daily protein: <strong>${escapeHtml(String(r.avgProtein ?? '—'))} g</strong></li>
<li>Avg meal quality score: <strong>${escapeHtml(String(r.avgScore ?? '—'))}/10</strong></li>
<li>Avg energy difference (burn − intake): <strong>${escapeHtml(String(r.avgEnergyDiff ?? '—'))} kcal</strong></li>
<li>Days with logged data: <strong>${escapeHtml(String(r.daysLogged ?? '—'))}</strong></li>
</ul>`;
  const html = luxuryWrap({
    title: 'Weekly nutrition overview',
    preheader: 'Your 7-day BodyBank nutrition summary.',
    lead: `Dear ${name},`,
    bodyHtml,
    ctaLabel: 'Open BodyBank',
    ctaUrl: APP_BASE + '/'
  });
  return sendMail(email, 'Your BodyBank weekly nutrition summary', html);
}

module.exports = {
  isConfigured,
  sendMail,
  luxuryWrap,
  escapeHtml,
  emailSignupPending,
  emailGoogleSignupPending,
  emailAccountApproved,
  emailAccountRejected,
  emailPasswordResetLuxury,
  emailPasswordChanged,
  emailAuditReceived,
  emailPart2Received,
  emailSundayCheckinReceived,
  emailDailyCheckinReceived,
  emailProgressSaved,
  emailWorkoutLogged,
  emailMeetingScheduled,
  emailContactReceived,
  emailCoachReply,
  emailSundayReminderTomorrow,
  emailSundayReminderToday,
  emailDailyCheckinReminder,
  emailProgressNudge,
  emailInactiveAttention,
  emailDailyDigest,
  emailWeeklyDigest,
  emailNutritionDayReport,
  emailNutritionWeeklySummary
};
