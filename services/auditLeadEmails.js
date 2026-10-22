'use strict';

/**
 * Audit lead email sequence: templates and pure rules (no DB, no network).
 *
 *   Email 1  sent by the admin "Send welcome email" action (queued, sent by the job)
 *   Email 2  24h after Email 1
 *   Email 3  72h after Email 1 (and never sooner than 24h after Email 2)
 *
 * Email 1 is templates/email/audit_lead_email1.html, kept byte for byte as the
 * founder's pack supplied it. Emails 2 and 3 are built here on the same shell
 * (logo, white card, sign off, footer with unsubscribe).
 *
 * Copy rules for every step: sign off is "Founder, BodyBank", never a personal
 * name; no dashes as punctuation, no emoji, no prices, no AI mentions, no
 * medical claims. tests/audit-lead-emails-unit.js enforces them.
 *
 * The stateful side (tables, cron job, stop rules against the DB) lives in
 * services/auditLeadEmailSequence.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = 'https://www.bodybank.fit';
const IMG = SITE + '/img/email';
const GOLD = '#B8892B';
const DEFAULT_WHATSAPP_NUMBER = '919502575669';
const DEFAULT_CC = 'bodybank.fit369@gmail.com';
const IOS_URL = 'https://apps.apple.com/in/app/bodybank/id6808102656';
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.bodybank.app';
const FIRST_NAME_FALLBACK = 'there';
const GOAL_FALLBACK = 'your fitness goal';
const GOAL_MAX = 80;
const STEPS = [1, 2, 3];

const EMAIL1_PATH = path.join(__dirname, '..', 'templates', 'email', 'audit_lead_email1.html');
let _email1Cache = null;
function email1Template() {
  if (_email1Cache == null) _email1Cache = fs.readFileSync(EMAIL1_PATH, 'utf8');
  return _email1Cache;
}

// ── config ──────────────────────────────────────────────────────────────────

function intEnv(v, dflt, min) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

function configFromEnv(env) {
  const e = env || process.env;
  const smtpUser = String(e.SMTP_USER || '').trim();
  const enabledRaw = String(e.AUDIT_LEAD_EMAILS_ENABLED == null ? '' : e.AUDIT_LEAD_EMAILS_ENABLED).trim().toLowerCase();
  const autoRaw = String(e.AUDIT_LEAD_AUTO_SEND == null ? '' : e.AUDIT_LEAD_AUTO_SEND).trim().toLowerCase();
  return {
    enabled: !['false', '0', 'off', 'no'].includes(enabledRaw),
    // Email 1 goes out the moment an audit is submitted (default on).
    autoSend: !['false', '0', 'off', 'no'].includes(autoRaw),
    whatsappNumber: String(e.LEAD_WHATSAPP_NUMBER || '').replace(/\D/g, '') || DEFAULT_WHATSAPP_NUMBER,
    cc: String(e.LEAD_EMAIL_CC == null ? DEFAULT_CC : e.LEAD_EMAIL_CC).trim(),
    replyTo: String(e.LEAD_EMAIL_REPLY_TO || '').trim() || smtpUser,
    smtpUser,
    batchSize: intEnv(e.LEAD_EMAIL_BATCH_SIZE, 20, 1),
    gapMs: intEnv(e.LEAD_EMAIL_GAP_MS, 4000, 0),
    dailyCap: intEnv(e.LEAD_EMAIL_DAILY_CAP, 400, 0),
    publicUrl: String(e.LEAD_EMAIL_PUBLIC_URL || SITE).trim().replace(/\/+$/, ''),
    unsubSecret: String(e.EMAIL_UNSUB_SECRET || e.JWT_SECRET || '').trim()
  };
}

// ── text helpers ────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/** Deliberately loose: one @, something before it, a dotted domain after, no spaces. */
function isValidEmail(email) {
  const e = normEmail(email);
  if (!e || e.length > 254 || /\s/.test(e)) return false;
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return false;
  const domain = e.slice(at + 1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) && !domain.startsWith('-');
}

/** Raw (unescaped) first name: first word, title case; fallback "there". */
function firstNameOf(raw) {
  const word = String(raw == null ? '' : raw).trim().split(/\s+/)[0] || '';
  if (!word) return FIRST_NAME_FALLBACK;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Raw (unescaped) goal phrase that reads inside a sentence, or null when there is none.
 * "Fat loss & toning." -> "fat loss & toning". Acronyms ("PCOS ...") and "I ..." keep
 * their capital. Long goals are cut at a word boundary at GOAL_MAX characters.
 */
function goalOf(raw) {
  let g = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  g = g.replace(/[\s.,;:!?&/+-]+$/, '').trim();
  if (!g) return null;
  if (g.length > GOAL_MAX) {
    let cut = g.slice(0, GOAL_MAX);
    const sp = cut.lastIndexOf(' ');
    if (sp >= GOAL_MAX / 2) cut = cut.slice(0, sp);
    g = cut.replace(/[\s.,;:!?&/+-]+$/, '').trim();
  }
  const firstWord = g.split(' ')[0];
  const keepCase = /^I('|$)/.test(firstWord) || (firstWord.length >= 2 && firstWord === firstWord.toUpperCase() && /[A-Z]/.test(firstWord));
  if (!keepCase) g = g.charAt(0).toLowerCase() + g.slice(1);
  return g;
}

function whatsappUrl(firstName, number) {
  const n = String(number || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, '') || DEFAULT_WHATSAPP_NUMBER;
  return 'https://wa.me/' + n + '?text=' + encodeURIComponent('Hi BodyBank, I filled the audit, my name is ' + firstName);
}

// ── unsubscribe token: base64url(email_norm) + "." + base64url(HMAC-SHA256) ──

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function unsubSig(emailNorm, secret) {
  if (!secret) throw new Error('EMAIL_UNSUB_SECRET (or JWT_SECRET) is not set');
  return crypto.createHmac('sha256', secret).update(emailNorm).digest();
}

function unsubToken(email, secret) {
  const e = normEmail(email);
  return b64url(e) + '.' + b64url(unsubSig(e, secret));
}

/** Email the token was issued for, or null when it is malformed or tampered. */
function verifyUnsubToken(token, secret) {
  try {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !secret) return null;
    const email = normEmail(fromB64url(parts[0]).toString('utf8'));
    if (!isValidEmail(email)) return null;
    const given = fromB64url(parts[1]);
    const expected = unsubSig(email, secret);
    if (given.length !== expected.length) return null;
    return crypto.timingSafeEqual(given, expected) ? email : null;
  } catch (_) {
    return null;
  }
}

function unsubUrl(email, cfg) {
  return cfg.publicUrl + '/api/email/unsubscribe?t=' + unsubToken(email, cfg.unsubSecret);
}

function listUnsubscribeHeaders(unsubscribeUrl, smtpUser) {
  const parts = ['<' + unsubscribeUrl + '>'];
  if (smtpUser) parts.push('<mailto:' + smtpUser + '?subject=unsubscribe>');
  return {
    'List-Unsubscribe': parts.join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
}

// ── IST schedule (IST is a fixed UTC+05:30, no daylight saving) ─────────────

const IST_OFFSET_MS = 330 * 60000;
const HOUR_MS = 3600000;
const SEND_START_HOUR = 8;  // inclusive, IST
const SEND_END_HOUR = 21;   // exclusive, IST
const PUSH_TO_HOUR = 9;

function istParts(date) {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

function istDateAt(y, m, d, h, min) {
  return new Date(Date.UTC(y, m, d, h, min || 0) - IST_OFFSET_MS);
}

function inSendWindow(date) {
  const h = istParts(date).h;
  return h >= SEND_START_HOUR && h < SEND_END_HOUR;
}

/** Inside 08:00 to 21:00 IST stays as is; otherwise the next 09:00 IST. */
function applyQuietHours(date) {
  const t = new Date(date);
  if (inSendWindow(t)) return t;
  const p = istParts(t);
  return p.h < SEND_START_HOUR ? istDateAt(p.y, p.m, p.d, PUSH_TO_HOUR) : istDateAt(p.y, p.m, p.d + 1, PUSH_TO_HOUR);
}

function startOfIstDay(date) {
  const p = istParts(date);
  return istDateAt(p.y, p.m, p.d, 0);
}

/**
 * What follows a successful send of `step`.
 * → { nextStep, nextSendAt } or { nextStep: 4, nextSendAt: null } when the sequence is done.
 */
function nextAfterSend(step, sentAt, firstSentAt) {
  const sent = new Date(sentAt).getTime();
  if (step === 1) return { nextStep: 2, nextSendAt: applyQuietHours(new Date(sent + 24 * HOUR_MS)) };
  if (step === 2) {
    const first = new Date(firstSentAt || sentAt).getTime();
    // Day 3 counts from Email 1, but if Email 2 ran late keep a full day between them.
    const at = Math.max(first + 72 * HOUR_MS, sent + 24 * HOUR_MS);
    return { nextStep: 3, nextSendAt: applyQuietHours(new Date(at)) };
  }
  return { nextStep: 4, nextSendAt: null };
}

// ── stop rules ──────────────────────────────────────────────────────────────

const STOP_STATUSES = ['stopped_replied', 'stopped_signed_up', 'stopped_unsubscribed', 'stopped_manual'];

/**
 * Status the sequence must move to instead of sending, or null to go ahead.
 * facts: { email, unsubscribed, hasUser, linkedUser, stages: [...], lastContactAt, startedAt }
 */
function stopReason(facts) {
  const f = facts || {};
  if (!isValidEmail(f.email)) return 'failed';
  if (f.unsubscribed) return 'stopped_unsubscribed';
  if (f.hasUser || f.linkedUser) return 'stopped_signed_up';
  const moved = (f.stages || []).some((s) => (String(s || '').trim() || 'new_audit') !== 'new_audit');
  if (moved) return 'stopped_replied';
  if (f.lastContactAt && f.startedAt && new Date(f.lastContactAt).getTime() > new Date(f.startedAt).getTime()) return 'stopped_replied';
  return null;
}

/** How many to send this run. */
function batchAllowance({ due, sentToday, batchSize, dailyCap }) {
  const left = Math.max(0, (dailyCap | 0) - (sentToday | 0));
  return Math.max(0, Math.min(batchSize | 0, left, due | 0));
}

// ── rendering ───────────────────────────────────────────────────────────────

const SUBJECTS = {
  1: (n) => `${n}, your BodyBank audit is in. Here is what happens next`,
  2: (n) => `${n}, a quick nudge on your audit`,
  3: (n) => `Last note from me, ${n}`
};

const PREHEADERS = {
  2: (n) => `One quick hello is all it takes, ${n}.`,
  3: (n) => `My last note on your audit, ${n}.`
};

const FEATURES_SHORT = [
  ['Daily check in', 'Log how you feel and build your streak.'],
  ['Snap your meal', 'A photo logs your meal and your protein for the day.'],
  ['Coach Mode', 'Guided workouts with clear form cues.'],
  ['7 Day Challenge', 'Seven simple daily habits, free to join.'],
  ['Blood reports', 'Keep your blood reports in one place, laid out clearly.'],
  ['Watch sync', 'Bring in your sleep, steps and recovery from your watch.'],
  ['Coins', 'Earn coins for showing up every day.'],
  ['Coach support', 'Message your coach on WhatsApp whenever you need a hand.']
];

const FONT = 'font-family:Helvetica,Arial,sans-serif';
const LINK = `color:${GOLD};text-decoration:underline`;

function goldButton(href, label) {
  const h = escapeHtml(href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${GOLD}" style="border-radius:4px;background:${GOLD}">
<!--[if mso]><v:roundrect href="${h}" style="height:48px;v-text-anchor:middle;width:260px" arcsize="8%" stroke="f" fillcolor="${GOLD}"><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${h}" style="display:inline-block;padding:15px 30px;${FONT};font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:4px">${label}</a><!--<![endif]-->
</td></tr></table>`;
}

/** Same shell as Email 1: logo, white 600px card, sign off, footer with unsubscribe. */
function shell({ title, preheader, rows, unsubscribeUrl }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${title}</title>
<!--[if mso]><style>table,td,a,p,h1{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){
 .wrap{width:100%!important}
 .px{padding-left:24px!important;padding-right:24px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:#F4F3F0;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#F4F3F0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4F3F0" style="background:#F4F3F0">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:600px;background:#FFFFFF;border:1px solid #E9E6E0;border-radius:4px">

<!-- logo -->
<tr><td class="px" align="left" style="padding:36px 48px 0">
<a href="${SITE}" style="text-decoration:none"><img src="${IMG}/logo_light.png" width="104" height="40" alt="BodyBank" style="display:block;border:0;width:104px;height:40px"></a>
</td></tr>
${rows}
<!-- sign off -->
<tr><td class="px" style="padding:36px 48px 40px;${FONT}">
<p style="margin:0;font-size:15px;line-height:22px;color:#111111;font-weight:bold">Founder, BodyBank</p>
<p style="margin:2px 0 0;font-size:14px"><a href="${SITE}" style="color:${GOLD};text-decoration:none">www.bodybank.fit</a></p>
</td></tr>
</table>

<!-- footer -->
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px">
<tr><td class="px" align="center" style="padding:24px 48px 8px;${FONT};font-size:12px;line-height:19px;color:#999999">
You received this because you filled the BodyBank audit at bodybank.fit.<br>
<a href="${escapeHtml(unsubscribeUrl)}" style="color:#999999;text-decoration:underline">Unsubscribe</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

function para(html, extra) {
  return `<p style="margin:${extra || '0 0 16px'};font-size:15px;line-height:25px;color:#444444">${html}</p>`;
}

function email2Html(v) {
  const features = FEATURES_SHORT.map(([t, d], i) =>
    `<tr><td valign="top" style="padding:${i ? '10px' : '0'} 0 0;font-size:14px;line-height:21px;color:#555555"><strong style="color:#111111">${t}.</strong> ${d}</td></tr>`).join('\n');
  const rows = `
<!-- body -->
<tr><td class="px" style="padding:36px 48px 0;${FONT}">
<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:bold;color:#111111">Hi ${v.nameHtml},</h1>
${para('Just checking in after your BodyBank audit. The easiest first step is a quick hello on WhatsApp, and I will take it from there.', '0')}
</td></tr>

<!-- primary CTA -->
<tr><td class="px" style="padding:28px 48px 0">
${goldButton(v.wa, 'Say hello on WhatsApp')}
</td></tr>

<!-- other ways in -->
<tr><td class="px" style="padding:28px 48px 0;${FONT}">
${para(`Or start the free 7 Day Challenge today and see how it feels. <a href="${SITE}/challenge" style="${LINK}">Join the challenge</a>`)}
<p style="margin:0;font-size:14px;line-height:24px;color:#555555">New here? <a href="${SITE}/signup" style="${LINK}">Create your account</a><br>Already signed up? <a href="${SITE}/login" style="${LINK}">Sign in</a></p>
</td></tr>

<!-- divider -->
<tr><td class="px" style="padding:32px 48px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" style="height:1px;line-height:1px;font-size:1px;background:#E9E6E0">&nbsp;</td></tr></table></td></tr>

<!-- features -->
<tr><td class="px" style="padding:28px 48px 0;${FONT}">
<p style="margin:0 0 16px;font-size:11px;letter-spacing:2px;font-weight:bold;color:${GOLD};text-transform:uppercase">Inside the app</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${features}
</table>
</td></tr>
`;
  return shell({ title: 'A quick nudge on your audit', preheader: PREHEADERS[2](v.nameHtml), rows, unsubscribeUrl: v.unsub });
}

function email3Html(v) {
  const rows = `
<!-- body -->
<tr><td class="px" style="padding:36px 48px 0;${FONT}">
<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:bold;color:#111111">Hi ${v.nameHtml},</h1>
${para(`I do not want to fill your inbox, so this is my last note on your audit. If ${v.goalHtml} still matters to you, one message is all it takes.`, '0')}
</td></tr>

<!-- primary CTA -->
<tr><td class="px" style="padding:28px 48px 0">
${goldButton(v.wa, 'Say hello on WhatsApp')}
</td></tr>

<tr><td class="px" style="padding:28px 48px 0;${FONT}">
${para(`The free 7 Day Challenge is also open anytime. <a href="${SITE}/challenge" style="${LINK}">Join the challenge</a>`)}
${para('Whenever you are ready, I am here.', '0')}
</td></tr>
`;
  return shell({ title: 'Last note on your audit', preheader: PREHEADERS[3](v.nameHtml), rows, unsubscribeUrl: v.unsub });
}

function email1Html(v) {
  let html = email1Template();
  // No goal on file: "your goal of your fitness goal is" would read badly, so the
  // sentence drops the phrase rather than inserting the fallback.
  if (!v.hasGoal) html = html.replace('your goal of {goal} is', 'your goal is');
  // Every wa.me link is rebuilt so the number follows LEAD_WHATSAPP_NUMBER and the
  // name is URL encoded (the raw template has a literal {first_name} in the query).
  html = html.replace(/https:\/\/wa\.me\/\d+\?text=[^"]*/g, () => escapeHtml(v.wa));
  return html
    .split('{first_name}').join(v.nameHtml)
    .split('{goal}').join(v.goalHtml)
    .split('{unsubscribe_url}').join(escapeHtml(v.unsub));
}

const SIGN_OFF_TEXT = 'Founder, BodyBank\nwww.bodybank.fit';
const FOOTER_TEXT = (u) => `You received this because you filled the BodyBank audit at bodybank.fit.\nUnsubscribe: ${u}`;

function email1Text(v) {
  const goalLine = v.hasGoal ? `your goal of ${v.goal} is` : 'your goal is';
  return [
    `Hi ${v.name}, your audit is in.`,
    '',
    `Thank you for filling the BodyBank audit. I have gone through what you shared, and ${goalLine} absolutely within reach with the right daily structure.`,
    '',
    `Say hello on WhatsApp: ${v.wa}`,
    'Send the message and I will personally reply with your next steps.',
    '',
    'NEXT STEPS',
    '',
    '01 Start the free 7 Day Challenge',
    `Seven simple daily habits. Free, no card needed. Join the challenge: ${SITE}/challenge`,
    '',
    '02 Create your free account',
    `Sign up: ${SITE}/signup`,
    `Sign in: ${SITE}/login`,
    `Get the app on iPhone: ${IOS_URL}`,
    `Get the app on Android: ${ANDROID_URL}`,
    '',
    '03 Book your free consult call',
    `We look at your audit together and map a plan that fits your routine. Pick a time: ${SITE}/schedule-call.html`,
    '',
    'INSIDE THE APP',
    '',
    'Daily check in. Log how you feel and build your streak.',
    'Snap your meal. A photo logs your meal and your protein for the day.',
    'Coach Mode. Guided workouts with clear form cues.',
    'Real coach support. Message your coach on WhatsApp whenever you need a hand.',
    '',
    'Simply reply to this email if you have any questions. I read every one.',
    '',
    SIGN_OFF_TEXT,
    '',
    FOOTER_TEXT(v.unsub)
  ].join('\n');
}

function email2Text(v) {
  return [
    `Hi ${v.name},`,
    '',
    'Just checking in after your BodyBank audit. The easiest first step is a quick hello on WhatsApp, and I will take it from there.',
    '',
    `Say hello on WhatsApp: ${v.wa}`,
    '',
    `Or start the free 7 Day Challenge today and see how it feels: ${SITE}/challenge`,
    '',
    `New here? Create your account: ${SITE}/signup`,
    `Already signed up? Sign in: ${SITE}/login`,
    '',
    'INSIDE THE APP',
    '',
    ...FEATURES_SHORT.map(([t, d]) => `${t}. ${d}`),
    '',
    SIGN_OFF_TEXT,
    '',
    FOOTER_TEXT(v.unsub)
  ].join('\n');
}

function email3Text(v) {
  return [
    `Hi ${v.name},`,
    '',
    `I do not want to fill your inbox, so this is my last note on your audit. If ${v.goal} still matters to you, one message is all it takes.`,
    '',
    `Say hello on WhatsApp: ${v.wa}`,
    '',
    `The free 7 Day Challenge is also open anytime: ${SITE}/challenge`,
    '',
    'Whenever you are ready, I am here.',
    '',
    SIGN_OFF_TEXT,
    '',
    FOOTER_TEXT(v.unsub)
  ].join('\n');
}

/**
 * render(step, lead, { unsubscribeUrl, whatsappNumber }) → { subject, html, text }
 * lead: an audit_requests row (first_name, goals).
 */
function render(step, lead, opts) {
  const o = opts || {};
  const s = Number(step);
  if (!STEPS.includes(s)) throw new Error('Unknown email step: ' + step);
  const l = lead || {};
  const name = firstNameOf(l.first_name);
  const goalRaw = goalOf(l.goals);
  const goal = goalRaw || GOAL_FALLBACK;
  const v = {
    name,
    nameHtml: escapeHtml(name),
    goal,
    goalHtml: escapeHtml(goal),
    hasGoal: !!goalRaw,
    wa: whatsappUrl(name, o.whatsappNumber),
    unsub: String(o.unsubscribeUrl || SITE + '/api/email/unsubscribe')
  };
  const html = s === 1 ? email1Html(v) : s === 2 ? email2Html(v) : email3Html(v);
  const text = s === 1 ? email1Text(v) : s === 2 ? email2Text(v) : email3Text(v);
  return { subject: SUBJECTS[s](name), html, text };
}

module.exports = {
  SITE,
  STEPS,
  STOP_STATUSES,
  DEFAULT_CC,
  DEFAULT_WHATSAPP_NUMBER,
  GOAL_FALLBACK,
  configFromEnv,
  escapeHtml,
  normEmail,
  isValidEmail,
  firstNameOf,
  goalOf,
  whatsappUrl,
  unsubToken,
  verifyUnsubToken,
  unsubUrl,
  listUnsubscribeHeaders,
  istParts,
  istDateAt,
  inSendWindow,
  applyQuietHours,
  startOfIstDay,
  nextAfterSend,
  stopReason,
  batchAllowance,
  render
};
