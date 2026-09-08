require('dotenv').config();
const express = require('express');
const compression = require('compression');
const pg = require('pg');
const { Pool } = pg;
// Parse Postgres DATE (OID 1082) as the raw 'YYYY-MM-DD' string instead of a JS Date.
// node-pg otherwise builds a Date at LOCAL midnight, so toISOString()/UTC math shifts
// the calendar day on any server ahead of UTC (e.g. IST locally). Returning the literal
// date string keeps streaks/check-in dates correct regardless of the server timezone.
try { pg.types.setTypeParser(1082, (v) => v); } catch (_) { /* ignore */ }
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
let multer = null;
try {
  multer = require('multer');
} catch (_) {
  multer = null;
}
const webPush = require('web-push');
let firebaseAdmin = null;
try { firebaseAdmin = require('firebase-admin'); } catch (_) { firebaseAdmin = null; }
const { signToken, verifyToken, requireAdmin, requireSelfOrStaff, requireSuperadmin, requireAdminOrSuperadmin, requireOperator, signProgressReportToken, verifyProgressReportToken, signShareToken, verifyShareToken, signPdfAccessToken, verifyPdfAccessToken, verifyAppleIdentityToken, JWT_SECRET: AUTH_JWT_SECRET } = require('./middleware/auth');
const { safeExtraHttpHeaders, optionalApiAccessLog, redactServerErrors } = require('./middleware/safeSecurityLayers');
const progressRoutes = require('./routes/progress');
const { createNutritionRouter, runWeeklyNutritionEmailJob, runAdminNutritionDailyEmailJob } = require('./routes/nutrition');
const { createBloodRouter, createBloodPublicRouter } = require('./routes/blood');
const { createSmartScaleRouter } = require('./routes/smartScale');
const { createReferralRouter } = require('./routes/referrals');
const { createWearablesRouter } = require('./routes/wearables');
const { createMarketingAIRouter } = require('./routes/marketingAI');
const { createNutritionAssessmentRouter } = require('./routes/nutritionAssessment');
const cron = require('node-cron');
const { getUserProgress: getAdminUserProgress } = require('./controllers/adminProgressController');
const progressService = require('./services/progressService');
const workoutSessionLifts = require('./services/workoutSessionLifts');
const { recomputeDailyStats: recomputeNutritionDailyStats } = require('./services/nutritionService');
const { inferTimezoneFromCountry, getUserTimezone, localDateTimeToUtcIso, getLocalDateParts } = require('./utils/timezone');
const { startCampaignScheduler, restartScheduler: restartCampaignScheduler, broadcastMessage: broadcastCampaignMessage } = require('./services/campaignScheduler');
const { parseAICampaignCommand, formatCampaignListReply, normalizeDay: normalizeCampaignDay, normalizeTime: normalizeCampaignTime } = require('./controllers/campaignController');
const {
  generateMonthlyClientReport,
  monthLabel: monthLabelForReport,
  summarize: summarizeMonthlyReportData,
  daysInMonthKey: daysInMonthKeyForReport
} = require('./services/monthlyReportService');
const monthlyReportNarrative = require('./services/monthlyReportNarrative');
const { writeSundayCheckinPdf, writePart2Pdf } = require('./services/formPdfService');
const { computeAuditResult } = require('./services/auditScoringService');
const bodybankAiCoach = require('./services/bodybankAiCoachContext');
const userEmail = require('./services/userEmailService');
const weeklyReportPdf = require('./services/weeklyReportPdf');
const coinService = require('./services/coinService');
// Single source of truth for AI token cost — see services/aiUsageLedger.js
const { recordAiUsage, SCOPE_LABELS: AI_SCOPE_LABELS, modelPricing: aiModelPricing, usdToInrRate, LEDGER_TZ: AI_LEDGER_TZ } = require('./services/aiUsageLedger');
const referralService = require('./services/referralService');
const readinessService = require('./services/wearables/readinessService');
const crypto = require('crypto');
const { notify, notifyAsync, formatEventMessage } = require('./utils/notify');
const { sendWhatsApp, sendWhatsAppTemplate, sendWhatsAppWithFallback } = require('./services/whatsapp');
const { createWaInbound, createPgStore, ensureWaTables } = require('./services/waInbound');
const { notifyAgent } = require('./utils/agentWebhook');
const { verifyToken: verifyNutritionPhotoLink } = require('./utils/nutritionPhotoLink');
const { startEmailScheduler, getAdminDailyComplianceReportData, sendAdminDailyComplianceReport } = require('./services/emailScheduler');
const {
  toDateStr: streakDateToYmd,
  computeStreakState,
  todayYmdInTz: streakTodayYmdInTz,
  addCalendarDaysYmd: streakAddDays,
  STREAK_TZ: STREAK_TIMEZONE
} = require('./services/streakService');

// ============ CONFIG ============
const PORT = process.argv[2] || process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bodybank.fit';
// Staff passwords have NO default. They used to fall back to 'admin123' /
// 'superadmin123', and the login handler compares the submitted password against
// these values directly (bypassing bcrypt) — so an unset env var turned a published
// constant into a working production staff login. Empty means "not configured",
// and every consumer below already treats empty as disabled.
const ADMIN_PASS = String(process.env.ADMIN_PASS || '').trim();
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@bodybank.fit';
const SUPERADMIN_PASS = String(process.env.SUPERADMIN_PASS || '').trim();
// Apple App Store reviewer demo account. Auto-seeded as approved on startup so the
// reviewer can sign in past the admin-approval gate. Provide the same credentials in
// App Store Connect → App Review Information.
const APPLE_REVIEW_EMAIL = process.env.APPLE_REVIEW_EMAIL || '';
const APPLE_REVIEW_PASS = process.env.APPLE_REVIEW_PASS || '';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://yoursite.com (production)
const VAPID_PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();
const FIREBASE_SERVICE_ACCOUNT = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
const RESET_BASE_URL = (process.env.RESET_BASE_URL || process.env.APP_BASE_URL || process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '') || (NODE_ENV === 'production' ? '' : `http://localhost:${PORT}`);
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const SMTP_FROM = (process.env.SMTP_FROM || 'BodyBank <noreply@bodybank.fit>').trim();
const NUTRITION_ADMIN_REPORT_EMAIL = (process.env.NUTRITION_ADMIN_REPORT_EMAIL || ADMIN_EMAIL || '').trim();
const CAMPAIGNS_ENABLED = String(process.env.CAMPAIGNS_ENABLED || 'false').trim().toLowerCase() === 'true';
// Honour UPLOADS_DIR the same way routes/blood.js and services/pdfService.js do.
// Unset (the production default) keeps the historical ./uploads path exactly.
const FEED_UPLOADS_DIR = (process.env.UPLOADS_DIR || '').trim()
  ? path.resolve(process.env.UPLOADS_DIR.trim())
  : path.join(__dirname, 'uploads');

async function safeRestartCampaignScheduler(logPrefix) {
  if (!CAMPAIGNS_ENABLED) return;
  const prefix = logPrefix || '[campaigns]';
  await restartCampaignScheduler().catch(e => console.error(prefix + ' Restart error:', e.message));
}

async function safeBroadcastCampaignMessage(message) {
  if (!CAMPAIGNS_ENABLED) return 0;
  return broadcastCampaignMessage(message);
}

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webPush.setVapidDetails('mailto:support@bodybank.fit', VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) {
    console.warn('VAPID keys invalid or malformed - push notifications disabled. Error:', e.message);
  }
}

// Firebase Cloud Messaging (native Android/iOS push). Guarded exactly like VAPID:
// if FIREBASE_SERVICE_ACCOUNT is not set, native push is simply disabled (no crash).
let _fcmReady = false;
if (firebaseAdmin && FIREBASE_SERVICE_ACCOUNT) {
  try {
    const svc = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    if (!firebaseAdmin.apps.length) {
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(svc) });
    }
    _fcmReady = true;
    console.log('[FCM] firebase-admin initialized - native push enabled.');
  } catch (e) {
    console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT invalid or init failed - native push disabled. Error:', e.message);
  }
} else {
  console.warn('[FCM] Skipped init: set FIREBASE_SERVICE_ACCOUNT to enable native (Android/iOS) push.');
}

// Native push via Firebase Cloud Messaging — for installed Android/iOS apps.
// Accepts the SAME payload shape as web-push (a JSON string or object with
// { title, body, icon, id, type, url }) so every existing call site works unchanged.
async function sendFcmToUser(userId, payload) {
  if (!_fcmReady) return;
  let data = {};
  try { data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {}); } catch (_) { data = {}; }
  const title = String(data.title || 'BodyBank').slice(0, 120);
  const body = String(data.body || data.desc || 'You have a new notification').slice(0, 240);
  try {
    const rows = await queryAll('SELECT token FROM device_push_tokens WHERE user_id = ?', [userId]);
    if (!rows || rows.length === 0) return;
    const sent = new Set();
    for (const r of rows) {
      if (!r.token || sent.has(r.token)) continue;
      sent.add(r.token);
      try {
        await firebaseAdmin.messaging().send({
          token: r.token,
          notification: { title, body },
          data: { id: String(data.id || ''), type: String(data.type || ''), url: String(data.url || '/') },
          android: { priority: 'high', notification: { sound: 'default' } }
        });
      } catch (e) {
        const code = (e && (e.code || (e.errorInfo && e.errorInfo.code))) || '';
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument') {
          await run('DELETE FROM device_push_tokens WHERE token = ?', [r.token]);
          console.warn('[FCM] Removed invalid token for user', userId);
        } else {
          console.warn('[FCM] Send failed for user', userId, ':', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[FCM] Error:', e.message);
  }
}

async function sendPushToUser(userId, payload) {
  // Native (FCM) push for installed apps — runs independently of web-push/VAPID config.
  await sendFcmToUser(userId, payload);
  // Web Push (VAPID) for browsers + installed PWAs.
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return;
  }
  try {
    const rows = await queryAll('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
    if (!rows || rows.length === 0) {
      console.warn('[Push] No subscriptions for user', userId, '- user must enable notifications in the app.');
      return;
    }
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sent = new Set();
    for (const sub of rows) {
      if (!sub.endpoint || sent.has(sub.endpoint)) continue;
      sent.add(sub.endpoint);
      try {
        await webPush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        }, body, { TTL: 86400 });
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
          console.warn('[Push] Removed expired subscription for user', userId);
        } else {
          console.warn('[Push] Send failed for user', userId, ':', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[Push] Error:', e.message);
  }
}

async function sendPushToAdmins(payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    // Operators are read-only monitoring staff and receive the SAME activity alerts as admins.
    const admins = await queryAll("SELECT id FROM users WHERE role IN ('admin', 'superadmin', 'operator')");
    for (const a of admins) {
      await sendPushToUser(a.id, payload);
    }
  } catch (e) { /* ignore */ }
}

// ============ MEMBERSHIP / TRIAL ACCESS (manual billing — no payment gateway) ============
// The coach calls the client and collects payment offline, then "Activates" them in the
// admin panel which sets a paid term. New sign-ups get instant access for TRIAL_DAYS days.
const TRIAL_DAYS = (parseInt(process.env.TRIAL_DAYS, 10) > 0) ? parseInt(process.env.TRIAL_DAYS, 10) : 7;
// Native app sign-ups can get a different trial length than the website (e.g. a longer
// trial during closed testing so testers aren't auto-locked). The client sends
// `client:'app'` in the sign-up body; web omits it / sends 'web'. Falls back to TRIAL_DAYS.
const TRIAL_DAYS_APP = (parseInt(process.env.TRIAL_DAYS_APP, 10) > 0) ? parseInt(process.env.TRIAL_DAYS_APP, 10) : TRIAL_DAYS;
function trialDaysForReq(req) {
  const c = String((req && req.body && req.body.client) || '').toLowerCase();
  return c === 'app' ? TRIAL_DAYS_APP : TRIAL_DAYS;
}

// An ISO timestamp `days` from now (days may be fractional). Pass as a parameter so it
// works on both Postgres (TIMESTAMP) and the legacy SQLite store (ISO text compares fine).
function isoFromNow(days) {
  return new Date(Date.now() + Math.round((Number(days) || 0) * 86400000)).toISOString();
}

// Calendar-accurate ISO timestamp `months` from now (so "1 Month" lands on the same day next month).
function isoMonthsFromNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + (Number(months) || 0));
  return d.toISOString();
}

// Whole days left until `expiresAt` (negative if already expired, null if no expiry).
function daysLeftUntil(expiresAt) {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt).getTime();
  if (!Number.isFinite(exp)) return null;
  return Math.ceil((exp - Date.now()) / 86400000);
}

// Returns { code, message } if a client is locked out, else null.
// Admins/superadmins are never gated. NULL expiry == lifetime/unlimited access.
function subscriptionGate(user) {
  if (!user || user.role !== 'user') return null;
  const sub = String(user.subscription_status || 'active').toLowerCase();
  if (sub === 'canceled') {
    return { code: 'subscription_inactive', message: 'Your membership is paused. Message your coach on WhatsApp to reactivate your access.' };
  }
  const expRaw = user.access_expires_at;
  if (expRaw) {
    const exp = new Date(expRaw).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      return { code: 'subscription_expired', message: 'Your access has ended. Message your coach on WhatsApp to renew and unlock your plan again.' };
    }
  }
  return null;
}

// Start (or restart) a free trial — instant full access for N days.
async function startTrialForUser(userId, days) {
  const d = (Number(days) > 0) ? Number(days) : TRIAL_DAYS;
  await run(
    "UPDATE users SET approval_status='approved', subscription_status='trialing', plan_label='Trial', access_expires_at=?, activated_at=NULL, activated_by='', trial_reminder_sent='', suspended=FALSE WHERE id=?",
    [isoFromNow(d), userId]
  );
  return d;
}

/**
 * Attach a referral at signup and grant the referee their bonus access days.
 *
 * Returns the number of bonus days actually granted (0 if there was no code, the
 * code was invalid, or the referral was auto-held by the duplicate-device guard).
 * Never throws — a broken referral must never cost us a new member.
 */
async function safeAttachReferral(req, userId) {
  try {
    const b = (req && req.body) || {};
    const code = String(b.ref || b.referral_code || b.referralCode || '').trim();
    if (!code || !userId) return 0;

    const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');
    const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    const ip = fwd || req.ip || '';
    const device = b.device_id || b.deviceId || (req.headers && req.headers['user-agent']) || '';

    const r = await referralService.attachReferralOnSignup(
      { run, queryOne, queryAll },
      {
        refereeUserId: String(userId),
        code,
        ipHash: ip ? sha(ip) : null,
        deviceHash: device ? sha(device) : null
      }
    );

    const bonus = (r && r.ok && Number(r.bonusDays) > 0) ? Number(r.bonusDays) : 0;
    if (!bonus) return 0;

    // Same SQL expression as the coin-redemption path so the two can never drift,
    // and so unexpired time is extended rather than overwritten.
    await run(
      `UPDATE users
         SET access_expires_at = GREATEST(COALESCE(access_expires_at, NOW()::timestamp), NOW()::timestamp)
                                 + (?::int * INTERVAL '1 day')
       WHERE id = ?`,
      [bonus, String(userId)]
    );
    return bonus;
  } catch (e) {
    console.warn('[referral attach]', e.message);
    return 0;
  }
}

const app = express();

// Trust proxy (Render, Nginx, etc.) so req.protocol and req.get('host') are correct for share links
app.set('trust proxy', 1);

// ============ MIDDLEWARE ============
app.use(compression());
app.use(cors({
  origin: NODE_ENV === 'production' && ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(s => s.trim()) : true,
  credentials: true
}));
// 40mb accommodates large blood-report uploads (base64 in JSON). The blood route
// caps the decoded payload lower, aligned to Claude's ~32MB PDF request limit.
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: false }));

// Content Security Policy.
//
// Shipped in REPORT-ONLY mode deliberately. The member UI is one large HTML document
// with inline <script> and inline style throughout, so an enforcing policy would have
// to allow 'unsafe-inline' — which buys almost nothing — or the pages would break.
// Report-Only costs nothing at runtime, breaks nothing, and surfaces every violation
// in the browser console so the inline blocks can be migrated to nonces over time.
//
// To enforce later: move the inline scripts to files or nonces, then set
// CSP_ENFORCE=true to switch this to the enforcing header.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline'/'unsafe-eval' are listed so the report reflects what a realistic
  // first enforcing policy would allow; tighten as inline code is migrated.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://accounts.google.com https://appleid.cdn-apple.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://accounts.google.com https://appleid.cdn-apple.com https://www.googletagmanager.com",
  "frame-src 'self' https://accounts.google.com https://appleid.cdn-apple.com https://play.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
const CSP_ENFORCE = String(process.env.CSP_ENFORCE || '').trim().toLowerCase() === 'true';

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    CSP_ENFORCE ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    CSP_DIRECTIVES
  );
  // Powerful features this product never uses. Camera stays enabled — the AI Trainer
  // form-coaching flow calls getUserMedia — and so does fullscreen for video.
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()'
  );
  if (NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(safeExtraHttpHeaders);
app.use(redactServerErrors);

// ---- In-process rate limiter -------------------------------------------------
//
// Counters live in this process only. With a single Render instance that is the
// whole picture; if the service is ever scaled to multiple instances, the effective
// limit multiplies by the instance count and this should move to a shared store.
//
// The previous version never removed keys, so the map grew by one entry per unique
// (ip, path) pair for the lifetime of the process — unbounded memory an attacker
// could drive by rotating source addresses. Entries are now swept once a minute and
// the map is capped.
const rateLimit = new Map();
const RATE_LIMIT_MAX_KEYS = 50000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimit) {
    if (now - entry.last > entry.windowMs) rateLimit.delete(key);
  }
  // Hard cap: if something still drives the map up, drop the oldest entries rather
  // than letting the process run out of memory.
  if (rateLimit.size > RATE_LIMIT_MAX_KEYS) {
    const excess = rateLimit.size - RATE_LIMIT_MAX_KEYS;
    let i = 0;
    for (const key of rateLimit.keys()) {
      if (i++ >= excess) break;
      rateLimit.delete(key);
    }
  }
}, 60000).unref();

/**
 * The canonical origin for links emailed to users (password reset).
 *
 * Configuration only — never the request. Falls back to the first entry of
 * ALLOWED_ORIGIN, which is already the vetted public origin, and then to Render's
 * own RENDER_EXTERNAL_URL. Returns '' in production when nothing is configured, and
 * the caller then declines to send rather than emit a poisonable link.
 *
 * @returns {string} origin with no trailing slash, or '' if unconfigured
 */
function resolveResetBaseUrl() {
  const configured = String(RESET_BASE_URL || '').trim();
  const firstAllowed = String(ALLOWED_ORIGIN || '').split(',')[0].trim();
  let base = configured || firstAllowed || String(process.env.RENDER_EXTERNAL_URL || '').trim();

  if (!base) {
    // Local development only: a loopback origin is not a phishing risk.
    return NODE_ENV === 'production' ? '' : `http://localhost:${PORT}`;
  }
  base = base.replace(/\/+$/, '');
  if (NODE_ENV === 'production' && base.startsWith('http://')) base = 'https://' + base.slice(7);
  return base;
}

/**
 * Length-safe constant-time string comparison for shared secrets.
 *
 * `crypto.timingSafeEqual` throws when the two buffers differ in length, and that
 * throw is itself a timing signal. Hashing both sides first gives equal-length
 * inputs, so the comparison leaks neither content nor length.
 */
function timingSafeEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Password-reset token hashing -------------------------------------------
//
// Reset tokens are bearer credentials: whoever holds one can set a new password.
// They are therefore stored as a SHA-256 digest, never in plaintext, so a leaked
// database gives an attacker nothing usable.
//
// A plain digest (not bcrypt) is the right choice here: the token is already 122
// bits of CSPRNG output, so there is nothing to brute-force, and lookup must stay a
// single indexed query.
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

// ---- Per-account login throttle ----------------------------------------------
//
// The IP-based limiter alone lets one address try 20 passwords a minute against a
// single account indefinitely. This adds a second, account-scoped counter so a
// distributed guessing attack against one member is also slowed: after
// LOGIN_MAX_FAILURES wrong passwords the account stops accepting attempts for
// LOGIN_LOCKOUT_MS, regardless of where they come from.
//
// Successful logins clear the counter, so a legitimate user who mistypes a few
// times and then succeeds is never affected.
const LOGIN_MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES || '10', 10);
const LOGIN_LOCKOUT_MS = parseInt(process.env.LOGIN_LOCKOUT_MS || '900000', 10); // 15 min
const loginFailures = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now - entry.last > LOGIN_LOCKOUT_MS) loginFailures.delete(key);
  }
}, 60000).unref();

function loginLockoutRemainingMs(emailNorm) {
  const entry = loginFailures.get(emailNorm);
  if (!entry || entry.count < LOGIN_MAX_FAILURES) return 0;
  const remaining = LOGIN_LOCKOUT_MS - (Date.now() - entry.last);
  return remaining > 0 ? remaining : 0;
}

function recordLoginFailure(emailNorm) {
  const entry = loginFailures.get(emailNorm) || { count: 0, last: 0 };
  entry.count += 1;
  entry.last = Date.now();
  loginFailures.set(emailNorm, entry);
}

function clearLoginFailures(emailNorm) {
  loginFailures.delete(emailNorm);
}

function rateLimiter(limit, windowMs) {
  return (req, res, next) => {
    // Key by authenticated user when there is one, and fall back to IP otherwise.
    //
    // Keying purely by IP punishes shared egress: mobile carriers (CGNAT), offices
    // and university networks put many members behind one address, so a per-IP quota
    // of 20 check-ins/minute is really 20 for everyone on that carrier combined. It
    // is also the weaker control for an authenticated route, where the account is the
    // thing worth limiting. Unauthenticated routes (login, signup, password reset)
    // still key by IP, which is correct — there is no identity to key on yet.
    const identity = req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`;
    const key = identity + req.path;
    const now = Date.now();
    let entry = rateLimit.get(key);
    if (!entry) {
      entry = { hits: [], last: now, windowMs };
      rateLimit.set(key, entry);
    }
    entry.windowMs = windowMs;
    entry.last = now;
    entry.hits = entry.hits.filter((t) => now - t < windowMs);
    if (entry.hits.length >= limit) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    entry.hits.push(now);
    next();
  };
}

// Request logging (dev only)
if (NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });
}

app.use(optionalApiAccessLog);

let pool;

/** Convert SQL with ? placeholders to PostgreSQL $1, $2, ... */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res;
}

async function queryAll(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows || [];
}

async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

const { createScorecardService } = require('./services/scorecardService');
const scorecardSvc = createScorecardService({ queryOne, queryAll });
const { createMuscleRankingService } = require('./services/muscleRankingService');
const muscleRankingSvc = createMuscleRankingService({ queryOne, queryAll });
const focusWheelSvc = require('./services/focusWheelService');
const waInbound = createWaInbound({
  store: createPgStore({ queryAll, queryOne, run, uuidv4 }),
  uuidv4,
  notify,
  sendWhatsApp: (message, opts) => sendWhatsAppWithFallback(message, opts)
});

function normalizeGeoFields(country, timezone) {
  const cleanCountry = String(country || '').trim();
  const cleanTimezone = String(timezone || '').trim() || inferTimezoneFromCountry(cleanCountry);
  return { country: cleanCountry, timezone: cleanTimezone };
}

function getDataUrlBytes(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!match) return null;
  const base64 = match[2];
  const padding = (base64.match(/=+$/) || [''])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function validateProfilePicture(profilePicture) {
  if (profilePicture === undefined) return null;
  const value = String(profilePicture || '').trim();
  if (!value) return null;
  if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(value)) {
    return 'Please upload a valid image file.';
  }
  const bytes = getDataUrlBytes(value);
  if (!bytes) return 'Could not process this image.';
  if (bytes > 5 * 1024 * 1024) return 'Profile photo must be 5 MB or smaller.';
  return null;
}

// ── Feed helpers: PostgreSQL-backed, survive all deployments ─────────
function feedRowToPost(row) {
  return {
    id: row.id,
    username: row.username,
    caption: row.caption || '',
    imageUrl: `/api/feed/image/${row.id}`,
    likes: row.likes || 0,
    featured: !!row.featured,
    createdAt: row.created_at
  };
}

// Cap base64 feed images at roughly the same 8 MB the multipart path allows.
// Base64 inflates by ~4/3, so 12 MB of text is about 8 MB of image.
const FEED_IMAGE_B64_MAX = 12 * 1024 * 1024;

function parseFeedImageInput(dataUrl) {
  const raw = String(dataUrl || '');
  if (raw.length > FEED_IMAGE_B64_MAX) throw new Error('Image is too large (max 8MB).');
  const match = raw.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  if (!match) throw new Error('Provide a valid PNG/JPEG/WEBP base64 image.');
  // Trust the bytes, not the declared type: the data: prefix is attacker-controlled.
  const buf = Buffer.from(match[2], 'base64');
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error('Provide a valid PNG/JPEG/WEBP base64 image.');
  return { imageData: `data:${mime};base64,${buf.toString('base64')}`, imageMime: mime };
}

/**
 * Determines an image's type from its magic bytes.
 *
 * The filename extension used to decide the stored MIME, so any file renamed to
 * .png was stored and later served as image/png regardless of its real content.
 * Sniffing the header means only genuine JPEG/PNG/WEBP data is accepted.
 *
 * @returns {'image/jpeg'|'image/png'|'image/webp'|null} null if unrecognised
 */
function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

function bufferToFeedDataUrl(buffer, originalName) {
  const mime = sniffImageMime(buffer);
  if (!mime) throw new Error('Provide a valid PNG/JPEG/WEBP image.');
  return { imageData: `data:${mime};base64,${buffer.toString('base64')}`, imageMime: mime };
}

async function syncUserCountryAndTimezone(userId, email) {
  if (!userId || !email) return;
  try {
    const audit = await queryOne(
      "SELECT country FROM audit_requests WHERE LOWER(email) = ? AND COALESCE(TRIM(country), '') <> '' ORDER BY created_at DESC LIMIT 1",
      [String(email).trim().toLowerCase()]
    );
    if (!audit || !audit.country) return;
    const inferredTimezone = inferTimezoneFromCountry(audit.country);
    await run(
      "UPDATE users SET country = COALESCE(NULLIF(country, ''), ?), timezone = COALESCE(NULLIF(timezone, ''), ?) WHERE id = ?",
      [audit.country, inferredTimezone || '', userId]
    );
  } catch (e) {
    console.warn('Failed to sync user country/timezone:', e.message);
  }
}

async function ensureApprovedUsersInActiveTribe() {
  try {
    const approved = await queryAll(
      `SELECT id, email, first_name, last_name, phone, country, created_at
       FROM users
       WHERE role = 'user' AND COALESCE(approval_status, 'approved') = 'approved'`
    );
    let inserted = 0;
    for (const u of (approved || [])) {
      const emailNorm = String(u.email || '').trim().toLowerCase();
      if (!emailNorm) continue;
      const existing = await queryOne(
        "SELECT id FROM tribe_members WHERE LOWER(email) = ?",
        [emailNorm]
      );
      if (existing) continue;
      const tribeId = uuidv4();
      const startDate = u.created_at ? String(u.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
      const city = String(u.country || '').trim();
      await run(
        `INSERT INTO tribe_members
         (id, first_name, last_name, email, phone, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, next_checkin, notes, status)
         VALUES (?,?,?,?,?,?,1,?,0,?,?,?,?,?,'active')`,
        [tribeId, u.first_name || '', u.last_name || '', u.email || '', u.phone || '', city, startDate, null, null, null, '', 'Auto-synced approved member']
      );
      inserted++;
    }
    if (inserted > 0) {
      console.log(`✅ Tribe sync: added ${inserted} approved user(s) to active tribe`);
    }
  } catch (e) {
    console.warn('Tribe sync warning:', e.message);
  }
}

// Add a single approved/trial user to the active Client Board if not already present.
// Used at signup time so new trial members appear on the board immediately
// (previously this happened inside the now-removed approve-user route).
async function addApprovedUserToTribe(user) {
  try {
    const emailNorm = String(user.email || '').trim().toLowerCase();
    if (!emailNorm) return;
    const existing = await queryOne("SELECT id FROM tribe_members WHERE LOWER(email) = ?", [emailNorm]);
    if (existing) return;
    const tribeId = uuidv4();
    const startDate = new Date().toISOString().slice(0, 10);
    const city = String(user.city || user.country || '').trim();
    await run(
      `INSERT INTO tribe_members
       (id, first_name, last_name, email, phone, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, next_checkin, notes, status)
       VALUES (?,?,?,?,?,?,1,?,0,?,?,?,?,?,'active')`,
      [tribeId, user.first_name || '', user.last_name || '', user.email || '', user.phone || '', city, startDate, null, null, null, '', 'New trial member']
    );
  } catch (e) {
    console.warn('Tribe add warning:', e.message);
  }
}

// ============ DATABASE ============
async function initDB() {
  pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (e) {
    console.error('❌ PostgreSQL connection failed:', e.message);
    throw e;
  }

  // Create tables (PostgreSQL types: TEXT, INTEGER, REAL, TIMESTAMP)
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    country TEXT DEFAULT '',
    state_province TEXT DEFAULT '',
    city TEXT DEFAULT '',
    dob DATE,
    gender TEXT DEFAULT '',
    timezone TEXT DEFAULT '',
    profile_picture TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    approval_status TEXT DEFAULT 'approved',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'approved'`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN country TEXT DEFAULT ''`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT ''`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN suspended BOOLEAN DEFAULT FALSE`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN state_province TEXT DEFAULT ''`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN city TEXT DEFAULT ''`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN dob DATE`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN gender TEXT DEFAULT ''`); } catch (e) { /* column may exist */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_type TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_training_days_per_week INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS diet_type TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_limitations TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stress_level_baseline INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  // Per-user access control for Nutrition AI and AI Trainer.
  // Existing users default to unlimited so this rollout does not block anyone; admin opts trial users in.
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nutrition_ai_unlimited BOOLEAN DEFAULT TRUE`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nutrition_ai_meal_limit INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nutrition_ai_meal_used INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trainer_unlimited BOOLEAN DEFAULT TRUE`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trainer_trial_limit INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trainer_trial_used INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nutrition_ai_last_used_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_trainer_last_used_at TIMESTAMP`); } catch (e) { /* ignore */ }
  // ── Membership / trial access (manual billing — coach collects payment offline, then activates) ──
  // Existing users default to 'active' with NULL expiry, so this rollout never locks anyone out.
  // New sign-ups start as 'trialing' with a 7-day access_expires_at (set at sign-up time).
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active'`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_label TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_by TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_sent TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  // ── Daily-goal targets + onboarding (powers the unified Today screen progress rings & first-run) ──
  // Defaults chosen as sensible starting targets; onboarded_at NULL means "show first-run".
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_steps INTEGER DEFAULT 8000`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_water_ml INTEGER DEFAULT 3000`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_protein_g INTEGER DEFAULT 120`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_sleep_hours REAL DEFAULT 7.5`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP`); } catch (e) { /* ignore */ }
  // guide_seen_at NULL means "show the first-run app guide" (the walkthrough of each section).
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guide_seen_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_freezes_used INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_freeze_month TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  await pool.query("UPDATE users SET subscription_status = 'active' WHERE subscription_status IS NULL").catch(() => {});
  await pool.query("UPDATE users SET approval_status = 'approved' WHERE approval_status IS NULL").catch(() => {});

  await pool.query(`CREATE TABLE IF NOT EXISTS audit_requests (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    age INTEGER,
    sex TEXT DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT DEFAULT '',
    country TEXT DEFAULT '',
    city TEXT DEFAULT '',
    occupation TEXT DEFAULT '',
    work_intensity TEXT DEFAULT '',
    fitness_experience TEXT DEFAULT '',
    goals TEXT DEFAULT '',
    motivation TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  // Leads pipeline columns (CRM state for each audit submission)
  try { await pool.query(`ALTER TABLE audit_requests ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'new_audit'`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE audit_requests ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE audit_requests ADD COLUMN IF NOT EXISTS call_scheduled_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE audit_requests ADD COLUMN IF NOT EXISTS lost_reason TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE audit_requests ADD COLUMN IF NOT EXISTS linked_user_id TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE audit_requests ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`UPDATE audit_requests SET stage = 'new_audit' WHERE stage IS NULL OR stage = ''`); } catch (e) { /* ignore */ }
  // Collapse legacy 11-stage pipeline into the streamlined 6-stage set (idempotent).
  try {
    await pool.query(`UPDATE audit_requests SET stage = 'contacted' WHERE stage IN ('whatsapp_sent','in_conversation')`);
    await pool.query(`UPDATE audit_requests SET stage = 'part2' WHERE stage IN ('part2_sent','part2_received')`);
    await pool.query(`UPDATE audit_requests SET stage = 'call' WHERE stage IN ('call_proposed','call_scheduled','call_done')`);
    await pool.query(`UPDATE audit_requests SET stage = 'converted' WHERE stage IN ('payment_pending','onboarded')`);
  } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_requests_stage ON audit_requests(stage)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_requests_email_lower ON audit_requests(LOWER(email))`); } catch (e) { /* ignore */ }

  // Lead notes timeline — every comment + automatic stage-change entries
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_notes (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    author_id TEXT DEFAULT '',
    author_name TEXT DEFAULT '',
    body TEXT NOT NULL,
    kind TEXT DEFAULT 'note',
    stage_at_time TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_notes_audit_id ON lead_notes(audit_id)`); } catch (e) { /* ignore */ }
  await pool.query(`
    UPDATE users u
    SET country = src.country
    FROM (
      SELECT DISTINCT ON (LOWER(email)) LOWER(email) AS email_norm, country
      FROM audit_requests
      WHERE COALESCE(TRIM(country), '') <> ''
      ORDER BY LOWER(email), created_at DESC
    ) src
    WHERE LOWER(u.email) = src.email_norm AND COALESCE(TRIM(u.country), '') = ''
  `).catch(() => {});
  try {
    const geoUsers = await queryAll("SELECT id, country, timezone FROM users WHERE COALESCE(TRIM(timezone), '') = ''");
    for (const user of geoUsers) {
      const inferredTimezone = inferTimezoneFromCountry(user.country);
      if (inferredTimezone) {
        await run("UPDATE users SET timezone = ? WHERE id = ?", [inferredTimezone, user.id]);
      }
    }
  } catch (e) {
    console.warn('User timezone backfill skipped:', e.message);
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS tribe_members (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    city TEXT DEFAULT '',
    phase INTEGER DEFAULT 1,
    start_date TEXT,
    activity_per_week INTEGER DEFAULT 0,
    starting_weight REAL,
    current_weight REAL,
    target_weight REAL,
    next_checkin TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS workout_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workout_name TEXT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    feedback TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    message TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS message_threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS thread_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_message_threads_user_id ON message_threads(user_id)`); } catch (e) { /* ignore */ }

  // Inbound WhatsApp mirroring (draft/review). Same raw-SQL bootstrap as the rest of initDB.
  await ensureWaTables(pool);

  // Operator → Admin escalations: an operator shares a client with admin for review,
  // and the two hold a threaded conversation about that client. Kept separate from the
  // client-facing message_threads so internal notes can NEVER leak to the client.
  await pool.query(`CREATE TABLE IF NOT EXISTS operator_escalations (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    operator_name TEXT DEFAULT '',
    client_id TEXT NOT NULL,
    client_name TEXT DEFAULT '',
    client_email TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS operator_escalation_messages (
    id TEXT PRIMARY KEY,
    escalation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    sender_name TEXT DEFAULT '',
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_esc_msgs_esc_id ON operator_escalation_messages(escalation_id)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_op_esc_operator ON operator_escalations(operator_id)`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    user_phone TEXT DEFAULT '',
    meeting_date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    status TEXT DEFAULT 'scheduled',
    notes TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // A consultation can now be moved, so a row is no longer write-once.
  try { await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS rescheduled_count INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_meetings_date_slot ON meetings(meeting_date, time_slot)`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS part2_audit (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    mobile TEXT DEFAULT '',
    sports_history TEXT DEFAULT '',
    injuries TEXT DEFAULT '',
    mental_health TEXT DEFAULT '',
    gym_experience TEXT DEFAULT '',
    food_choices TEXT DEFAULT '',
    vices_addictions TEXT DEFAULT '',
    goals TEXT DEFAULT '',
    what_compelled TEXT DEFAULT '',
    activity_level TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS score INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS tier_key TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS tier_label TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS sub_scores TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS weak_lever TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS result_generated_at TIMESTAMP`); } catch (e) { /* ignore */ }
  // Structured quick-detail fields (added 2026-05-13 to improve scoring accuracy)
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS height_cm INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS bodyweight_kg NUMERIC(5,1)`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS workouts_per_week TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS sleep_hours TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS stress_level INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS smoking TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE part2_audit ADD COLUMN IF NOT EXISTS alcohol TEXT DEFAULT ''`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_calls (
    id TEXT PRIMARY KEY,
    audit_id TEXT DEFAULT '',
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    mobile TEXT DEFAULT '',
    call_date TEXT NOT NULL,
    call_time TEXT NOT NULL,
    timezone TEXT DEFAULT 'Asia/Kolkata',
    channel TEXT DEFAULT 'call',
    status TEXT DEFAULT 'scheduled',
    notes TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_calls_email_lower ON scheduled_calls(LOWER(email))`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_calls_date ON scheduled_calls(call_date)`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS hydration_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_ml INTEGER DEFAULT 0,
    glasses INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS weight_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sunday_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    full_name TEXT NOT NULL,
    reply_email TEXT NOT NULL,
    plan TEXT DEFAULT '',
    current_weight_waist_week TEXT DEFAULT '',
    last_week_weight_waist TEXT DEFAULT '',
    total_weight_loss TEXT DEFAULT '',
    training_go TEXT DEFAULT '',
    nutrition_go TEXT DEFAULT '',
    sleep TEXT DEFAULT '',
    occupation_stress TEXT DEFAULT '',
    other_stress TEXT DEFAULT '',
    differences_felt TEXT DEFAULT '',
    achievements TEXT DEFAULT '',
    improve_next_week TEXT DEFAULT '',
    questions TEXT DEFAULT '',
    body_fat_percent REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`ALTER TABLE sunday_checkins ADD COLUMN IF NOT EXISTS body_fat_percent REAL`); } catch (e) { /* ignore */ }

  // Smart scale uploads (InBody / decades-scan / smart weighing scale reports) —
  // optional, offered alongside the Sunday check-in but not part of that table/route.
  await pool.query(`CREATE TABLE IF NOT EXISTS smart_scale_uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    checkin_id TEXT,
    file_path TEXT NOT NULL,
    original_filename TEXT DEFAULT '',
    mime_type TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  // AI extraction of the printed metrics (Weight/BMI/Fat%/Muscle mass/etc) — added
  // after the table itself, so existing rows just backfill to 'pending'.
  try { await pool.query(`ALTER TABLE smart_scale_uploads ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending'`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE smart_scale_uploads ADD COLUMN IF NOT EXISTS extracted_data JSONB`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE smart_scale_uploads ADD COLUMN IF NOT EXISTS extraction_error TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE smart_scale_uploads ADD COLUMN IF NOT EXISTS extraction_ai_usage JSONB`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE smart_scale_uploads ADD COLUMN IF NOT EXISTS device_brand TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE smart_scale_uploads ADD COLUMN IF NOT EXISTS report_date DATE`); } catch (e) { /* ignore */ }

  // Client Progress Analytics: user_goals, progress_logs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_goals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_weight NUMERIC,
      target_body_fat NUMERIC,
      weekly_workout_target INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weight NUMERIC(5,2),
      body_fat NUMERIC(5,2),
      calories_intake INTEGER,
      protein_intake INTEGER,
      workout_completed BOOLEAN DEFAULT false,
      workout_type VARCHAR(100),
      strength_bench NUMERIC(6,2),
      strength_squat NUMERIC(6,2),
      strength_deadlift NUMERIC(6,2),
      sleep_hours NUMERIC(3,1),
      water_intake NUMERIC(4,1),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_progress_logs_user_id ON progress_logs(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_progress_logs_created_at ON progress_logs(created_at)`).catch(() => {});

  // Daily check-ins (micro-goals: steps, water, protein, sleep)
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    checkin_date DATE NOT NULL,
    steps INTEGER,
    water_ml INTEGER,
    protein_g INTEGER,
    sleep_hours REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_checkins_user_date ON daily_checkins(user_id, checkin_date)`); } catch (e) { /* ignore */ }
  // Streak-freeze marker: an empty row inserted to preserve a streak across a missed day.
  // Counts toward the streak (presence) but is excluded from averages, weekly counts and admin views.
  try { await pool.query(`ALTER TABLE daily_checkins ADD COLUMN IF NOT EXISTS is_freeze BOOLEAN DEFAULT FALSE`); } catch (e) { /* ignore */ }
  // Today's entry can be corrected, so a row is no longer write-once.
  try { await pool.query(`ALTER TABLE daily_checkins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`); } catch (e) { /* ignore */ }

  // Mind check-ins (mental-fitness exercises: box_breathing, grounding_54321, body_scan)
  await pool.query(`CREATE TABLE IF NOT EXISTS mind_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    exercise_key TEXT NOT NULL,
    checkin_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mind_checkins_user_ex_date ON mind_checkins(user_id, exercise_key, checkin_date)`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS coin_wallet (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0,
    lifetime_earned INTEGER NOT NULL DEFAULT 0,
    lifetime_redeemed INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS coin_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    coins_delta INTEGER NOT NULL,
    meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS coin_penalty_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_penalty_date DATE,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_coin_ledger_user_date ON coin_ledger(user_id, created_at DESC)`); } catch (_) {}

  await pool.query(`CREATE TABLE IF NOT EXISTS nutrition_meal_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date DATE NOT NULL,
    meal_type TEXT NOT NULL,
    photo_data TEXT,
    photo_mime TEXT,
    manual_note TEXT,
    portion_size TEXT DEFAULT 'medium',
    ai_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    photo_upload_count INTEGER DEFAULT 0,
    meal_score INTEGER,
    submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    notified_at TIMESTAMPTZ
  )`);
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nutrition_meal_user_date_type ON nutrition_meal_logs(user_id, log_date, meal_type)`);
  } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_nutrition_meal_logs_date ON nutrition_meal_logs(log_date)`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS nutrition_daily_stats (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stat_date DATE NOT NULL,
    total_calories INTEGER DEFAULT 0,
    total_protein INTEGER DEFAULT 0,
    total_carbs INTEGER DEFAULT 0,
    total_fat INTEGER DEFAULT 0,
    total_fiber INTEGER DEFAULT 0,
    calorie_goal INTEGER,
    protein_goal INTEGER,
    meals_logged INTEGER DEFAULT 0,
    calories_out INTEGER DEFAULT 0,
    workout_calories_out INTEGER DEFAULT 0,
    step_calories_out INTEGER DEFAULT 0,
    energy_difference INTEGER,
    weekly_avg_calories REAL,
    weekly_avg_protein REAL,
    meal_quality_score REAL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, stat_date)
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_nutrition_daily_stats_date ON nutrition_daily_stats(stat_date)`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE nutrition_daily_stats ADD COLUMN IF NOT EXISTS workout_calories_out INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE nutrition_daily_stats ADD COLUMN IF NOT EXISTS step_calories_out INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE nutrition_daily_stats ADD COLUMN IF NOT EXISTS rmr_kcal_est INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE nutrition_daily_stats ADD COLUMN IF NOT EXISTS tef_kcal_est INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE nutrition_daily_stats ADD COLUMN IF NOT EXISTS total_out_est_kcal INTEGER`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE nutrition_daily_stats ADD COLUMN IF NOT EXISTS energy_balance_est INTEGER`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS blood_analysis_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blood_report_file_path TEXT,
    symptoms JSONB DEFAULT '[]'::jsonb,
    extracted_blood_data JSONB,
    nutrition_snapshot JSONB,
    ai_report JSONB,
    pdf_path TEXT,
    admin_notes TEXT,
    sent_to_user BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending',
    user_name TEXT,
    user_email TEXT,
    user_age TEXT,
    user_gender TEXT,
    user_goal TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_blood_reports_user_created ON blood_analysis_reports(user_id, created_at DESC)`
    );
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blood_reports_status ON blood_analysis_reports(status)`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS analysis_last_error TEXT`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS extraction_ai_usage JSONB`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS analysis_ai_usage JSONB`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS total_ai_usage JSONB`);
  } catch (e) {
    /* ignore */
  }
  // The DATE the blood was actually drawn, as printed on the lab report — distinct
  // from created_at (when the file was uploaded). Re-uploading an old report today
  // must not make it the "newest" point on the trend, so every timeline ordering
  // and label uses COALESCE(report_date, created_at::date).
  try {
    await pool.query(`ALTER TABLE blood_analysis_reports ADD COLUMN IF NOT EXISTS report_date DATE`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_blood_reports_user_labdate
       ON blood_analysis_reports(user_id, (COALESCE(report_date, created_at::date)) DESC)`
    );
  } catch (e) {
    /* ignore */
  }

  // Longitudinal blood-report COMPARISONS (admin-built progress reviews across a
  // client's uploaded reports). Deterministic aligned matrix + Claude verdict.
  await pool.query(`CREATE TABLE IF NOT EXISTS blood_comparison_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    report_ids JSONB DEFAULT '[]'::jsonb,
    comparison_data JSONB,
    ai_verdict JSONB,
    ai_usage JSONB,
    admin_notes TEXT,
    pdf_path TEXT,
    sent_to_user BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMPTZ,
    status TEXT DEFAULT 'draft',
    user_name TEXT,
    user_email TEXT,
    user_age TEXT,
    user_gender TEXT,
    user_goal TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_blood_comparisons_user_created ON blood_comparison_reports(user_id, created_at DESC)`
    );
  } catch (e) {
    /* ignore */
  }
  // The doctor-edited PROGRESS REPORT DOCUMENT. Null means "never edited" — the PDF
  // is then rendered from a document built on the fly out of comparison_data +
  // ai_verdict. Once a reviewer edits the report in-app, this column is what prints.
  try {
    await pool.query(`ALTER TABLE blood_comparison_reports ADD COLUMN IF NOT EXISTS report_doc JSONB`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE blood_comparison_reports ADD COLUMN IF NOT EXISTS doc_updated_at TIMESTAMPTZ`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE blood_comparison_reports ADD COLUMN IF NOT EXISTS doc_updated_by TEXT DEFAULT ''`);
  } catch (e) {
    /* ignore */
  }
  // Public share link for WhatsApp: a random token is the only credential, so it
  // carries an expiry, an audit trail, and can be revoked by clearing the column.
  for (const col of [
    `share_token TEXT`,
    `share_expires_at TIMESTAMPTZ`,
    `share_created_at TIMESTAMPTZ`,
    `share_created_by TEXT DEFAULT ''`,
    `share_last_viewed_at TIMESTAMPTZ`
  ]) {
    try {
      await pool.query(`ALTER TABLE blood_comparison_reports ADD COLUMN IF NOT EXISTS ${col}`);
    } catch (e) {
      /* ignore */
    }
  }
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_blood_comparisons_share_token
       ON blood_comparison_reports(share_token) WHERE share_token IS NOT NULL`
    );
  } catch (e) {
    /* ignore */
  }

  try {
    await pool.query(`ALTER TABLE nutrition_meal_logs ADD COLUMN IF NOT EXISTS ai_usage JSONB`);
  } catch (e) {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE nutrition_meal_logs ADD COLUMN IF NOT EXISTS photo_upload_count INTEGER DEFAULT 0`);
  } catch (e) {
    /* ignore */
  }
  // ── AI TOKEN LEDGER ──────────────────────────────────────────────────────
  // One row per Anthropic call, across every feature. Before this table, usage
  // lived in per-feature JSONB columns and three features recorded nothing, so
  // there was no way to answer "what did AI cost today". services/aiUsageLedger.js
  // owns the writes and the pricing; nothing else should compute AI cost.
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_usage_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    usage_date DATE NOT NULL,
    scope TEXT NOT NULL,
    provider TEXT DEFAULT 'anthropic',
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
    cost_inr NUMERIC(14,4) NOT NULL DEFAULT 0,
    usd_to_inr NUMERIC(10,3),
    user_id TEXT,
    ref_type TEXT,
    ref_id TEXT,
    backfilled BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  try { await pool.query(`ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT FALSE`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_events(usage_date DESC)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_scope_date ON ai_usage_events(scope, usage_date DESC)`); } catch (e) { /* ignore */ }
  // Guards ONLY the backfill below, so re-running the migration cannot double-count
  // history. Scoped to backfilled rows on purpose: live inserts must stay
  // unconstrained, because a genuine retry of the same blood report is a second
  // real cost that has to be recorded, not deduplicated away.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_backfill_once
       ON ai_usage_events(scope, ref_type, ref_id)
       WHERE backfilled AND ref_type IS NOT NULL AND ref_id IS NOT NULL`
    );
  } catch (e) { /* ignore */ }

  // One-time backfill so the Tokens screen opens with history rather than an
  // empty table. Only the three features that already persisted usage can be
  // recovered; admin AI Assist, Marketing AI, and Whoop start from today.
  // ON CONFLICT DO NOTHING makes this safe to re-run on every boot.
  const AI_BACKFILLS = [
    {
      scope: 'blood_extraction',
      sql: `INSERT INTO ai_usage_events
              (occurred_at, usage_date, scope, model, input_tokens, output_tokens, total_tokens,
               cost_usd, cost_inr, user_id, ref_type, ref_id, backfilled)
            SELECT created_at, (created_at AT TIME ZONE 'Asia/Kolkata')::date, 'blood_extraction',
                   extraction_ai_usage->>'model',
                   COALESCE((extraction_ai_usage->>'input_tokens')::int, 0),
                   COALESCE((extraction_ai_usage->>'output_tokens')::int, 0),
                   COALESCE((extraction_ai_usage->>'total_tokens')::int, 0),
                   COALESCE((extraction_ai_usage->>'estimated_cost_usd')::numeric, 0),
                   COALESCE((extraction_ai_usage->>'estimated_cost_inr')::numeric, 0),
                   user_id, 'blood_report', id, TRUE
            FROM blood_analysis_reports
            WHERE extraction_ai_usage IS NOT NULL
              AND COALESCE((extraction_ai_usage->>'total_tokens')::int, 0) > 0
            ON CONFLICT DO NOTHING`
    },
    {
      scope: 'blood_analysis',
      sql: `INSERT INTO ai_usage_events
              (occurred_at, usage_date, scope, model, input_tokens, output_tokens, total_tokens,
               cost_usd, cost_inr, user_id, ref_type, ref_id, backfilled)
            SELECT created_at, (created_at AT TIME ZONE 'Asia/Kolkata')::date, 'blood_analysis',
                   analysis_ai_usage->>'model',
                   COALESCE((analysis_ai_usage->>'input_tokens')::int, 0),
                   COALESCE((analysis_ai_usage->>'output_tokens')::int, 0),
                   COALESCE((analysis_ai_usage->>'total_tokens')::int, 0),
                   COALESCE((analysis_ai_usage->>'estimated_cost_usd')::numeric, 0),
                   COALESCE((analysis_ai_usage->>'estimated_cost_inr')::numeric, 0),
                   user_id, 'blood_report', id, TRUE
            FROM blood_analysis_reports
            WHERE analysis_ai_usage IS NOT NULL
              AND COALESCE((analysis_ai_usage->>'total_tokens')::int, 0) > 0
            ON CONFLICT DO NOTHING`
    },
    {
      scope: 'blood_comparison',
      sql: `INSERT INTO ai_usage_events
              (occurred_at, usage_date, scope, model, input_tokens, output_tokens, total_tokens,
               cost_usd, cost_inr, user_id, ref_type, ref_id, backfilled)
            SELECT created_at, (created_at AT TIME ZONE 'Asia/Kolkata')::date, 'blood_comparison',
                   ai_usage->>'model',
                   COALESCE((ai_usage->>'input_tokens')::int, 0),
                   COALESCE((ai_usage->>'output_tokens')::int, 0),
                   COALESCE((ai_usage->>'total_tokens')::int, 0),
                   COALESCE((ai_usage->>'estimated_cost_usd')::numeric, 0),
                   COALESCE((ai_usage->>'estimated_cost_inr')::numeric, 0),
                   user_id, 'blood_comparison', id, TRUE
            FROM blood_comparison_reports
            WHERE ai_usage IS NOT NULL
              AND COALESCE((ai_usage->>'total_tokens')::int, 0) > 0
            ON CONFLICT DO NOTHING`
    },
    {
      scope: 'nutrition_meal',
      sql: `INSERT INTO ai_usage_events
              (occurred_at, usage_date, scope, model, input_tokens, output_tokens, total_tokens,
               cost_usd, cost_inr, user_id, ref_type, ref_id, backfilled)
            SELECT COALESCE(submitted_at, CURRENT_TIMESTAMP), log_date, 'nutrition_meal',
                   ai_usage->>'model',
                   COALESCE((ai_usage->>'input_tokens')::int, 0),
                   COALESCE((ai_usage->>'output_tokens')::int, 0),
                   COALESCE((ai_usage->>'total_tokens')::int, 0),
                   COALESCE((ai_usage->>'estimated_cost_usd')::numeric, 0),
                   COALESCE((ai_usage->>'estimated_cost_inr')::numeric, 0),
                   user_id, 'meal_log', id, TRUE
            FROM nutrition_meal_logs
            WHERE ai_usage IS NOT NULL
              AND COALESCE((ai_usage->>'total_tokens')::int, 0) > 0
            ON CONFLICT DO NOTHING`
    }
  ];
  for (const b of AI_BACKFILLS) {
    try {
      const r = await pool.query(b.sql);
      if (r && r.rowCount > 0) console.log(`[ai-usage] backfilled ${r.rowCount} ${b.scope} rows`);
    } catch (e) {
      console.error(`[ai-usage backfill ${b.scope}]`, e.message);
    }
  }

  // Push notification subscriptions
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT,
    auth TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)`); } catch (e) { /* ignore */ }

  // Native (FCM) device push tokens — installed Android/iOS apps
  await pool.query(`CREATE TABLE IF NOT EXISTS device_push_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    platform TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user_id ON device_push_tokens(user_id)`); } catch (e) { /* ignore */ }

  // Password reset tokens (users only, not admin/superadmin)
  await pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at)`); } catch (e) { /* ignore */ }

  // ── Campaign messages (scheduled broadcast to all active users) ──────────
  await pool.query(`CREATE TABLE IF NOT EXISTS campaign_messages (
    id TEXT PRIMARY KEY,
    day_of_week TEXT NOT NULL,
    time_of_day TEXT NOT NULL,
    message TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_messages_active ON campaign_messages(is_active, day_of_week, time_of_day)`); } catch (e) { /* ignore */ }

  // ── Campaign send log ────────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS campaign_send_log (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    message TEXT NOT NULL,
    sent_to INTEGER DEFAULT 0,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_send_log_sent_at ON campaign_send_log(sent_at DESC)`); } catch (e) { /* ignore */ }

  // Per-user inbox — stores every broadcast message so users see it even without push enabled
  await pool.query(`CREATE TABLE IF NOT EXISTS user_inbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'BodyBank',
    body TEXT NOT NULL,
    type TEXT DEFAULT 'campaign',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_inbox_user ON user_inbox(user_id, created_at DESC)`); } catch (e) { /* ignore */ }

  // Attention alert email dedupe log for inactive users (milestone-based, keyed by last check-in date)
  await pool.query(`CREATE TABLE IF NOT EXISTS attention_email_log (
    user_id TEXT NOT NULL,
    milestone_key TEXT NOT NULL, -- e.g. '2d' | '5d'
    last_checkin_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, milestone_key, last_checkin_date)
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_attention_email_log_user ON attention_email_log(user_id)`); } catch (e) { /* ignore */ }

  // Daily admin compliance report dedupe log
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_daily_report_log (
    report_key TEXT PRIMARY KEY,
    window_start TIMESTAMP NOT NULL,
    window_end TIMESTAMP NOT NULL,
    recipient_email TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_daily_report_log_sent_at ON admin_daily_report_log(sent_at DESC)`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS marketing_contents (
    id SERIAL PRIMARY KEY,
    keywords TEXT,
    post_type TEXT,
    tone TEXT,
    response_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketing_contents_created_at ON marketing_contents(created_at DESC)`); } catch (e) { /* ignore */ }

  // Seed default weekly campaigns if table is empty
  try {
    const campaignRow = await queryOne('SELECT COUNT(*) as c FROM campaign_messages');
    if (parseInt(campaignRow?.c ?? 0, 10) === 0) {
      await seedDefaultCampaigns();
      console.log('✅ Default campaigns seeded (22 messages, IST schedule)');
    }
  } catch (e) { console.warn('Campaign seed check error:', e.message); }

  // Programs (PDF + YouTube) - admin assigns to users, max 4 per user
  await pool.query(`CREATE TABLE IF NOT EXISTS programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pdf_url TEXT NOT NULL,
    image_url TEXT,
    youtube_url TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_program_assignments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    assigned_by TEXT,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP,
    seen_at TIMESTAMP
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_program_assignments_user ON user_program_assignments(user_id)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_program_assignments_program ON user_program_assignments(program_id)`); } catch (e) { /* ignore */ }

  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_opt_in BOOLEAN DEFAULT FALSE`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_display_name TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_opt_in_at TIMESTAMPTZ`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE programs ADD COLUMN IF NOT EXISTS score_weights JSONB`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS focus_wheel_last_spin_date TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS focus_wheel_last_label TEXT DEFAULT ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_public_program BOOLEAN DEFAULT TRUE`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_public_global BOOLEAN DEFAULT FALSE`); } catch (e) { /* ignore */ }

  // ── Elite Feed posts — persistent across deployments ──────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS feed_posts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL DEFAULT 'bodybank_member',
    caption TEXT DEFAULT '',
    image_data TEXT DEFAULT '',
    image_mime TEXT DEFAULT 'image/jpeg',
    likes INTEGER DEFAULT 0,
    featured BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  // Real ownership for feed posts. Deletion used to trust a `username` string sent by
  // the client, so anyone could delete anyone's post by echoing back the username the
  // feed listing had just given them. Nullable so pre-existing rows keep working —
  // those fall back to the legacy username comparison, staff-only.
  try { await pool.query(`ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS user_id TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_feed_posts_created_at ON feed_posts(created_at DESC)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_feed_posts_username ON feed_posts(username)`); } catch (e) { /* ignore */ }
  // ── My Body section (Phase 1) ──
  // Photos + bodyweight + waist; measurements JSONB and shared_with_manager
  // are forward-compat for Phases 2 & 4. user_id is TEXT to match users.id.
  await pool.query(`CREATE TABLE IF NOT EXISTS body_snapshots (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_date TEXT NOT NULL,
    photo_front TEXT,
    photo_side TEXT,
    photo_back TEXT,
    bodyweight_kg REAL,
    waist_cm REAL,
    measurements JSONB,
    shared_with_manager BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  // Defensive ALTERs — cover EVERY column in the table so a deploy that landed
  // mid-evolution (i.e. a body_snapshots row created with a partial schema)
  // upgrades cleanly the next time the server boots. Each is wrapped in its
  // own try so one ADD failing won't skip the rest.
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS photo_front TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS photo_side TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS photo_back TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS bodyweight_kg REAL`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS waist_cm REAL`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS measurements JSONB`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS shared_with_manager BOOLEAN DEFAULT FALSE`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS notes TEXT`); } catch (e) { /* ignore */ }
  try { await pool.query(`ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_body_snapshots_user_date ON body_snapshots(user_id, snapshot_date DESC)`); } catch (e) { /* ignore */ }

  // ── FitChef Nutrition Assessment ────────────────────────────────────────
  // Over a hundred questions, so the answers live in JSONB keyed by step rather
  // than one column per question — part2_audit took the other road and needed
  // twenty ALTER TABLE patches to reach twenty fields. Only the columns the
  // admin list filters, sorts or searches on are promoted out of the blob.
  await pool.query(`CREATE TABLE IF NOT EXISTS nutrition_assessments (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'partial',
    last_step INTEGER DEFAULT 1,
    full_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    mobile TEXT DEFAULT '',
    city TEXT DEFAULT '',
    goal_primary TEXT DEFAULT '',
    diet_type TEXT DEFAULT '',
    answers JSONB DEFAULT '{}'::jsonb,
    derived JSONB DEFAULT '{}'::jsonb,
    flags JSONB DEFAULT '[]'::jsonb,
    review_status TEXT DEFAULT '',
    review_note TEXT DEFAULT '',
    reviewed_by TEXT DEFAULT '',
    reviewed_at TIMESTAMPTZ,
    consent_health BOOLEAN DEFAULT FALSE,
    consent_marketing BOOLEAN DEFAULT FALSE,
    consent_ip TEXT DEFAULT '',
    consent_at TIMESTAMPTZ,
    ref_source TEXT DEFAULT '',
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  // ── Two-part delivery ─────────────────────────────────────────────────────
  // The assessment is filled in two sittings. It stays ONE row: `answers` is
  // already JSONB keyed by step, so part 2 adds keys rather than needing a second
  // table that could drift out of step with the first.
  //
  //   status  'partial'        mid part 1, nothing submitted
  //           'part1_complete' part 1 submitted — safe to act on
  //           'complete'       both parts in
  //
  // `part` is which part they are currently filling; `last_step` is their index
  // WITHIN that part, not across all ten steps.
  for (const sql of [
    `ALTER TABLE nutrition_assessments ADD COLUMN IF NOT EXISTS part INTEGER DEFAULT 1`,
    `ALTER TABLE nutrition_assessments ADD COLUMN IF NOT EXISTS part1_submitted_at TIMESTAMPTZ`,
    `ALTER TABLE nutrition_assessments ADD COLUMN IF NOT EXISTS part2_submitted_at TIMESTAMPTZ`,
    `ALTER TABLE nutrition_assessments ADD COLUMN IF NOT EXISTS part2_sent_at TIMESTAMPTZ`
  ]) {
    try { await pool.query(sql); } catch (e) { /* ignore */ }
  }
  // Backfill rows written before the split. They were filled against the whole
  // form, so a completed one has genuinely answered both parts and must not be
  // dragged back into an "awaiting part 2" state that a member would be chased
  // about. Guarded on part1_submitted_at so this can never run twice.
  try {
    await pool.query(
      `UPDATE nutrition_assessments
          SET part = 2,
              part1_submitted_at = submitted_at,
              part2_submitted_at = submitted_at
        WHERE status = 'complete' AND part1_submitted_at IS NULL AND submitted_at IS NOT NULL`
    );
  } catch (e) { /* ignore */ }
  // A pre-split draft's last_step counted across all ten steps; part 1 has five,
  // so anything above that would resume off the end of the part-1 step list.
  try {
    await pool.query(
      `UPDATE nutrition_assessments SET last_step = 1
        WHERE status = 'partial' AND (last_step IS NULL OR last_step > 5)`
    );
  } catch (e) { /* ignore */ }

  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_nutrition_assessments_user ON nutrition_assessments(user_id, created_at DESC)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_nutrition_assessments_status ON nutrition_assessments(status, created_at DESC)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_nutrition_assessments_email ON nutrition_assessments(LOWER(email))`); } catch (e) { /* ignore */ }

  await pool.query(`CREATE TABLE IF NOT EXISTS leaderboard_virtual_config (
    id INTEGER PRIMARY KEY,
    enabled BOOLEAN DEFAULT TRUE,
    virtual_count INTEGER DEFAULT 15,
    volatility TEXT DEFAULT 'medium',
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leaderboard_virtual_registry (
    virtual_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    tier TEXT DEFAULT 'pro',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  try {
    await pool.query(
      `INSERT INTO leaderboard_virtual_config (id, enabled, virtual_count, volatility)
       VALUES (1, TRUE, 15, 'medium')
       ON CONFLICT (id) DO NOTHING`
    );
  } catch (e) { /* ignore */ }

  const wkCols = [
    ['session_date', 'DATE'],
    ['workout_type', 'TEXT'],
    ['session_lifts', 'JSONB'],
    ['session_reps', 'JSONB'],
    ['bench_kg', 'REAL'],
    ['squat_kg', 'REAL'],
    ['deadlift_kg', 'REAL'],
    ['weight_kg', 'REAL'],
    ['body_fat_percent', 'REAL'],
    ['calories', 'INTEGER'],
    ['protein_g', 'INTEGER'],
    ['water_liters', 'REAL'],
    ['sleep_hrs', 'REAL'],
    ['workout_completed', 'BOOLEAN'],
    ['intensity', 'TEXT'],
    ['energy_level', 'TEXT']
  ];
  for (const [col, typ] of wkCols) {
    try {
      await pool.query(`ALTER TABLE workout_logs ADD COLUMN IF NOT EXISTS ${col} ${typ}`);
    } catch (e) { /* ignore */ }
  }

  // ── AI Coach removed: drop its tables + orphaned inbox rows (idempotent). ──
  try {
    await pool.query(
      `DROP TABLE IF EXISTS coach_events, coach_settings, coach_dossier, coach_user_profile,
         coach_messages, coach_budget_ledger, coach_cost_ledger, coach_experiments CASCADE`
    );
    await pool.query(`DELETE FROM user_inbox WHERE type = 'coach'`);
  } catch (e) { /* ignore */ }

  // Sync programs table with PDF files on disk
  try {
    const fs = require('fs');
    const pdfDir = path.join(__dirname, 'public', 'programs', 'pdfs');
    let files = [];
    try {
      files = fs.readdirSync(pdfDir, { withFileTypes: true })
        .filter(d => d.isFile && typeof d.isFile === 'function' ? d.isFile() : !d.isDirectory())
        .map(d => d.name || d)
        .filter(name => String(name).toLowerCase().endsWith('.pdf'));
    } catch (e) {
      console.warn('Programs folder not found or not readable:', e.message);
      files = [];
    }
    for (const file of files) {
      const base = String(file);
      const id = base;
      const name = base.replace(/\.pdf$/i, '');
      const pdfUrl = '/programs/pdfs/' + encodeURIComponent(base);
      const existing = await queryOne('SELECT id FROM programs WHERE id = ?', [id]);
      if (existing && existing.id) {
        await run('UPDATE programs SET name = ?, pdf_url = ? WHERE id = ?', [name, pdfUrl, id]);
      } else {
        await run('INSERT INTO programs (id, name, pdf_url) VALUES (?, ?, ?)', [id, name, pdfUrl]);
      }
    }
    console.log('✅ Synced programs from PDFs:', files.length);
  } catch (e) {
    console.error('Failed to sync programs from PDFs:', e.message);
  }

  // Create admin. ADMIN_PASS has no default, so an unset value means "do not seed".
  if (!ADMIN_PASS) {
    console.warn('⚠️ ADMIN_PASS is not set — the admin account will not be seeded.');
  }
  const adminRow = await queryOne("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!adminRow) {
    if (!ADMIN_PASS) {
      console.error('❌ Refusing to create an admin without ADMIN_PASS. Set it and restart.');
    } else if (ADMIN_PASS.length < 12) {
      console.error('❌ Refusing to create an admin with a password under 12 characters.');
    } else {
      const hash = await bcrypt.hash(ADMIN_PASS, 10);
      const adminEmailNorm = String(ADMIN_EMAIL).trim().toLowerCase();
      await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), adminEmailNorm, hash, 'Body', 'Bank', 'admin', 'approved']);
      console.log(`✅ Admin created: ${ADMIN_EMAIL}`);
    }
  }

  if (!SUPERADMIN_PASS) {
    console.warn('⚠️ SUPERADMIN_PASS is not set — the superadmin account will not be synced.');
  }
  const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
  const canSyncSuperadmin =
    superadminEmailNorm && superadminPassTrimmed && superadminPassTrimmed.length >= 12;
  // Sync uses trimmed password so Render env vars with accidental newlines/spaces still work
  if (canSyncSuperadmin) {
    const hash = await bcrypt.hash(superadminPassTrimmed, 10);
    const byEmail = await queryOne("SELECT id, role FROM users WHERE LOWER(email) = ?", [superadminEmailNorm]);
    if (byEmail) {
      await run("UPDATE users SET role = 'superadmin', password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE id = ?", [hash, byEmail.id]);
      await run("UPDATE users SET role = 'user' WHERE role = 'superadmin' AND id != ?", [byEmail.id]);
      console.log(`✅ Superadmin synced (existing email): ${SUPERADMIN_EMAIL}`);
    } else {
      const superadminRow = await queryOne("SELECT id FROM users WHERE role='superadmin' LIMIT 1");
      if (superadminRow) {
        await run("UPDATE users SET email = ?, password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE role = 'superadmin'", [superadminEmailNorm, hash]);
        console.log(`✅ Superadmin synced (updated): ${SUPERADMIN_EMAIL}`);
      } else {
        await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [uuidv4(), superadminEmailNorm, hash, 'Super', 'Admin', 'superadmin', 'approved']);
        console.log(`✅ Superadmin created: ${SUPERADMIN_EMAIL}`);
      }
    }
  } else {
    const existingSa = await queryOne("SELECT id FROM users WHERE role='superadmin' LIMIT 1");
    if (!existingSa && !superadminPassTrimmed) {
      console.error('❌ Refusing to create a superadmin without SUPERADMIN_PASS. Set SUPERADMIN_EMAIL and SUPERADMIN_PASS and redeploy.');
    } else if (!existingSa && superadminPassTrimmed.length < 12) {
      console.error('❌ Refusing to create a superadmin with a password under 12 characters.');
    } else if (!existingSa && (!process.env.SUPERADMIN_EMAIL || !superadminEmailNorm)) {
      console.warn('⚠️ Superadmin not created: set SUPERADMIN_EMAIL and SUPERADMIN_PASS in env.');
    }
  }

  // Operator (read-only monitoring role) — auto-provision from env on boot so no
  // manual script is needed on Render. Only acts when BOTH OPERATOR_EMAIL and
  // OPERATOR_PASS are set; never creates a default operator and never demotes an admin.
  const operatorEmailNorm = String(process.env.OPERATOR_EMAIL || '').trim().toLowerCase();
  const operatorPassTrimmed = String(process.env.OPERATOR_PASS || '').trim();
  if (operatorEmailNorm && operatorPassTrimmed) {
    try {
      const opHash = await bcrypt.hash(operatorPassTrimmed, 10);
      const opByEmail = await queryOne("SELECT id, role FROM users WHERE LOWER(email) = ?", [operatorEmailNorm]);
      if (opByEmail) {
        if (opByEmail.role === 'admin' || opByEmail.role === 'superadmin') {
          console.warn(`⚠️ OPERATOR_EMAIL ${operatorEmailNorm} is already an ${opByEmail.role}; skipping operator sync.`);
        } else {
          await run("UPDATE users SET role = 'operator', password = ?, approval_status = 'approved' WHERE id = ?", [opHash, opByEmail.id]);
          console.log(`✅ Operator synced (existing email): ${operatorEmailNorm}`);
        }
      } else {
        await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [uuidv4(), operatorEmailNorm, opHash, 'Operator', '', 'operator', 'approved']);
        console.log(`✅ Operator created: ${operatorEmailNorm}`);
      }
    } catch (e) { console.warn('[operator bootstrap]', e.message); }
  }

  // Apple App Store reviewer demo account — pre-approved so the reviewer can sign in
  // past the admin-approval gate. Provide the same creds in App Store Connect → App
  // Review Information. No-op if APPLE_REVIEW_EMAIL / APPLE_REVIEW_PASS are unset.
  try {
    const revEmail = String(APPLE_REVIEW_EMAIL || '').trim().toLowerCase();
    const revPass  = String(APPLE_REVIEW_PASS  || '').trim();
    if (revEmail && revPass) {
      const hash = await bcrypt.hash(revPass, 10);
      const existing = await queryOne("SELECT id FROM users WHERE LOWER(email) = ?", [revEmail]);
      if (existing) {
        await run("UPDATE users SET password = ?, approval_status = 'approved', suspended = FALSE, role = 'user' WHERE id = ?", [hash, existing.id]);
        console.log(`✅ Apple reviewer account synced (existing): ${APPLE_REVIEW_EMAIL}`);
      } else {
        await run(
          "INSERT INTO users (id, email, password, first_name, last_name, phone, country, timezone, height_cm, dob, gender, role, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [uuidv4(), revEmail, hash, 'Apple', 'Reviewer', '+10000000000', 'United States', 'America/Los_Angeles', 175, '1990-01-01', 'Prefer not to say', 'user', 'approved']
        );
        console.log(`✅ Apple reviewer account created: ${APPLE_REVIEW_EMAIL}`);
      }
    }
  } catch (e) {
    console.error('Apple reviewer sync error:', e.message);
  }

  // Seed sample data if empty
  try {
    const tribeRow = await queryOne("SELECT COUNT(*) as c FROM tribe_members");
    const tribeCount = parseInt(tribeRow?.c ?? 0, 10);
    if (tribeCount === 0) {
      await seedData();
      console.log('✅ Sample data seeded');
    }
    await ensureApprovedUsersInActiveTribe();
  } catch (e) {
    console.error('Seed check error:', e.message);
  }

  // ---- Referral system tables (idempotent; must run after `users` exists) ----
  try {
    await referralService.ensureReferralTables({ run, queryOne, queryAll });
  } catch (e) {
    console.error('Referral table init error:', e.message);
  }

  // ---- Wearable / readiness tables (idempotent; needs `daily_checkins` + its unique index) ----
  try {
    await readinessService.ensureReadinessTables({ run, queryOne, queryAll });
  } catch (e) {
    console.error('Readiness table init error:', e.message);
  }

  // ---- Read-path indexes (idempotent) ----------------------------------------
  // Every table below is read with `WHERE user_id = ?` on the login path, or with
  // `ORDER BY created_at DESC LIMIT n` by the admin landing's activity feed, and
  // several carried nothing but a primary key on `id` — so Postgres scanned the
  // whole table each time. Nothing here changes a result; it changes how the rows
  // are found. `IF NOT EXISTS` keeps this safe to run on every boot.
  const readPathIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_workout_logs_user_created ON workout_logs(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_workout_logs_created ON workout_logs(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sunday_checkins_user_created ON sunday_checkins(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sunday_checkins_created ON sunday_checkins(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_hydration_logs_user_created ON hydration_logs(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_weight_logs_user_created ON weight_logs(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_meetings_user_date ON meetings(user_id, meeting_date)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_checkins_created ON daily_checkins(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_nutrition_meal_logs_submitted ON nutrition_meal_logs(submitted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_requests_created ON audit_requests(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created ON thread_messages(thread_id, created_at DESC)`
  ];
  for (const sql of readPathIndexes) {
    try { await pool.query(sql); } catch (e) { /* table may not exist on older installs */ }
  }
}

// ============ DEFAULT CAMPAIGN SEED ============
async function seedDefaultCampaigns() {
  const campaigns = [
    // SUNDAY
    { day: 'sunday',    time: '09:00', msg: 'Sunday CHECK-IN today 🙌 Don\'t forget to submit!' },
    { day: 'sunday',    time: '11:00', msg: 'Drink ORS / Hydrate well 💧' },
    { day: 'sunday',    time: '16:00', msg: 'Eat good protein today 🥩' },
    { day: 'sunday',    time: '21:30', msg: 'Let\'s win this week! 💪' },
    // MONDAY
    { day: 'monday',    time: '09:00', msg: 'Let\'s win this week! 💪' },
    { day: 'monday',    time: '12:00', msg: 'Hydrate well! 💧' },
    { day: 'monday',    time: '16:30', msg: 'Chew snacks well! 🥜' },
    { day: 'monday',    time: '21:00', msg: 'How many steps so far? 👟' },
    // TUESDAY
    { day: 'tuesday',   time: '09:00', msg: 'Use time well and stay active.' },
    { day: 'tuesday',   time: '12:00', msg: 'Chew food well! 🍽️' },
    { day: 'tuesday',   time: '20:00', msg: 'Hydration good so far? 💧' },
    // WEDNESDAY
    { day: 'wednesday', time: '09:00', msg: 'I hope you\'re not skipping meals 🍽️' },
    { day: 'wednesday', time: '12:00', msg: 'Take tiny breathing breaks! 🧘' },
    { day: 'wednesday', time: '20:00', msg: 'How\'s it going so far? 💬' },
    // THURSDAY
    { day: 'thursday',  time: '10:00', msg: 'I hope digestion is going well! 🌿' },
    { day: 'thursday',  time: '13:00', msg: 'How have your energy levels been so far? ⚡' },
    { day: 'thursday',  time: '22:00', msg: 'Sleep on time — rest is part of the plan 🌙' },
    // FRIDAY
    { day: 'friday',    time: '11:00', msg: 'How\'re you feeling mentally? 🧠' },
    { day: 'friday',    time: '18:00', msg: 'Take care of food — it\'s the weekend! 🍽️' },
    // SATURDAY
    { day: 'saturday',  time: '11:00', msg: 'Hydrate well, drink ORS! 💧' },
    { day: 'saturday',  time: '16:00', msg: 'Don\'t forget to carry your snack if you\'re heading out! 🎒' },
    { day: 'saturday',  time: '19:30', msg: 'Sunday CHECK-In tomorrow morning — don\'t forget! ⏰' },
  ];
  for (const c of campaigns) {
    await run(
      'INSERT INTO campaign_messages (id, day_of_week, time_of_day, message, is_active) VALUES (?, ?, ?, ?, TRUE)',
      [uuidv4(), c.day, c.time, c.msg]
    );
  }
}

function shutdown() {
  console.log('\nShutting down...');
  if (pool) pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function seedData() {
  const members = [
    ['Arjun', 'Sharma', 'arjun.s@gmail.com', '9876543210', 'Mumbai', 2, '2024-12-20', 5, 78, 72, 68, '2026-02-16', 'Strong progress'],
    ['Neha', 'Kapoor', 'neha.k@gmail.com', '9876543211', 'Delhi', 1, '2026-01-30', 4, 65, 64, 58, '2026-02-18', 'Just started'],
    ['Vikram', 'Rao', 'vikram.r@gmail.com', '9876543212', 'Hyderabad', 3, '2024-11-08', 6, 90, 76, 74, '2026-02-15', 'Almost done'],
    ['Sneha', 'Pillai', 'sneha.p@gmail.com', '9876543213', 'Bangalore', 2, '2025-01-03', 4, 58, 54, 52, '2026-02-17', 'Great commitment'],
    ['Rohan', 'Joshi', 'rohan.j@gmail.com', '9876543214', 'Pune', 1, '2026-02-06', 3, 85, 85, 75, '2026-02-20', 'Week 1'],
  ];
  for (const m of members) {
    await run(`INSERT INTO tribe_members (id, first_name, last_name, email, phone, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, next_checkin, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), ...m]);
  }
  const requests = [
    ['Priya', 'Sharma', 28, 'Female', 'priya.s@gmail.com', '9876543220', 'India', 'Mumbai', 'Marketing Manager', 'Sedentary', 'Some experience', 'Fat loss & toning', 'Want to feel confident'],
    ['Rahul', 'Mehra', 32, 'Male', 'rahul.m@outlook.com', '9876543221', 'India', 'Delhi', 'Software Engineer', 'Sedentary', 'Regular gym-goer', 'Muscle gain', 'Health scare from doctor'],
    ['Ananya', 'Reddy', 25, 'Female', 'ananya.r@yahoo.com', '9876543222', 'India', 'Hyderabad', 'Student', 'Light', 'Complete beginner', 'Overall wellness', 'Tired of feeling tired'],
    ['Karan', 'Singh', 29, 'Male', 'karan.s@gmail.com', '9876543223', 'India', 'Bangalore', 'Consultant', 'Moderate', 'Some experience', 'Body recomposition', 'Getting married soon'],
    ['Meera', 'Patel', 34, 'Female', 'meera.p@gmail.com', '9876543224', 'India', 'Pune', 'Business Owner', 'Heavy', 'Complete beginner', 'Lifestyle change', 'Burnout from work'],
  ];
  for (const r of requests) {
    await run(`INSERT INTO audit_requests (id, first_name, last_name, age, sex, email, phone, country, city, occupation, work_intensity, fitness_experience, goals, motivation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), ...r]);
  }
}

// ============ CONFIG ============
// Lightweight health check (no DB) — Render uses this for deploy success
app.get('/health', (req, res) => res.json({ ok: true, status: 'live' }));

// Diagnostic endpoint — reveals deployment configuration, so it is superadmin-only.
app.get('/api/debug-reset-setup', verifyToken, requireSuperadmin, (req, res) => {
  const base = RESET_BASE_URL || '(from request)';
  res.json({ reset_base_set: !!RESET_BASE_URL, reset_base_preview: base ? base.slice(0, 40) + (base.length > 40 ? '...' : '') : 'empty', node_env: NODE_ENV });
});

app.get('/api/config', (req, res) => {
  const cid = process.env.GOOGLE_CLIENT_ID || process.env['GOOGLE-CLIENT-ID'] || 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
  res.set('Cache-Control', 'no-store');
  res.json({
    google_client_id: cid,
    // Sign in with Apple: web Services ID (browser flow) + native bundle id (iOS app flow).
    apple_client_id: process.env.APPLE_SERVICE_ID || '',
    apple_bundle_id: process.env.APPLE_BUNDLE_ID || 'com.bodybank.app',
    apple_redirect_uri: process.env.APPLE_REDIRECT_URI || ''
  });
});

// Health check: API + DB connection test
app.get('/api/health', async (req, res) => {
  try {
    const adminCheck = await queryOne("SELECT email FROM users WHERE role='admin' LIMIT 1");
    const superadminCheck = await queryOne("SELECT email FROM users WHERE role='superadmin' LIMIT 1");
    res.json({
      ok: true,
      db: 'connected',
      admin_email: ADMIN_EMAIL,
      admin_exists: !!adminCheck,
      superadmin_email: SUPERADMIN_EMAIL,
      superadmin_exists: !!superadminCheck
    });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error', error: e.message });
  }
});

// Shared: sync superadmin user from env (create or update). Used by startup, bootstrap, and login self-heal.
async function runSuperadminSync() {
  const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
  if (!superadminEmailNorm || !superadminPassTrimmed) return;
  const hash = await bcrypt.hash(superadminPassTrimmed, 10);
  const byEmail = await queryOne("SELECT id, role FROM users WHERE LOWER(email) = ?", [superadminEmailNorm]);
  if (byEmail) {
    await run("UPDATE users SET role = 'superadmin', password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE id = ?", [hash, byEmail.id]);
    await run("UPDATE users SET role = 'user' WHERE role = 'superadmin' AND id != ?", [byEmail.id]);
  } else {
    const existingSa = await queryOne("SELECT id FROM users WHERE role='superadmin' LIMIT 1");
    if (existingSa) {
      await run("UPDATE users SET email = ?, password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE role = 'superadmin'", [superadminEmailNorm, hash]);
    } else {
      await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), superadminEmailNorm, hash, 'Super', 'Admin', 'superadmin', 'approved']);
    }
  }
}

// ============ AUTH ROUTES ============
app.post('/api/auth/login', rateLimiter(20, 60000), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const emailNorm = String(email).trim().toLowerCase();
    const pwTrimmed = String(password).trim();

    // Account-scoped brute-force throttle (see loginLockoutRemainingMs above).
    const lockedMs = loginLockoutRemainingMs(emailNorm);
    if (lockedMs > 0) {
      res.setHeader('Retry-After', Math.ceil(lockedMs / 1000));
      return res.status(429).json({
        error: 'Too many failed attempts. Please try again in a few minutes.'
      });
    }

    // NOTE: a hardcoded superadmin credential pair used to live here as a "works even
    // if env vars are missing on Render" escape hatch. Because this repository is
    // published, those credentials were a public, unauthenticated superadmin login —
    // and the recovery path rewrote the existing superadmin row, locking out the real
    // owner. It has been removed. Superadmin recovery is now an operator task run
    // against the database directly: scripts/ensure-superadmin.js.
    let user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      {
        const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
        const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
        if (superadminEmailNorm && superadminPassTrimmed && emailNorm === superadminEmailNorm && pwTrimmed === superadminPassTrimmed) {
          await runSuperadminSync();
          user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
        }
      }
      if (!user) {
        if (NODE_ENV !== 'production') console.log('[Login] User not found:', emailNorm);
        recordLoginFailure(emailNorm);
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }
    const suspended = user.suspended === true || user.suspended === 't';
    if (suspended) {
      return res.status(403).json({ error: 'suspended', message: 'Your account has been suspended. Please contact support.' });
    }
    const status = user.approval_status || 'approved';
    if (status === 'rejected') {
      return res.status(403).json({ error: 'rejected', message: 'Your request was rejected. Please sign up again to submit a new request.' });
    }
    if (status !== 'approved') {
      return res.status(403).json({ error: 'pending_approval', message: 'Your account is pending admin approval. You will be able to log in once approved.' });
    }
    if (!user.password || !await bcrypt.compare(pwTrimmed, user.password)) {
      {
        // (The hardcoded-credential privilege-escalation branch that stood here has
        // been removed — see the note at the top of this handler.)
        const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
        const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
        if (superadminEmailNorm && superadminPassTrimmed && emailNorm === superadminEmailNorm && pwTrimmed === superadminPassTrimmed) {
          await runSuperadminSync();
          user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
        }
      }
      if (!user || !await bcrypt.compare(pwTrimmed, user.password)) {
        if (NODE_ENV !== 'production') console.log('[Login] Password mismatch for:', emailNorm);
        recordLoginFailure(emailNorm);
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }

    await syncUserCountryAndTimezone(user.id, user.email);
    user = await queryOne("SELECT * FROM users WHERE id = ?", [user.id]);
    const subGate = subscriptionGate(user);
    if (subGate) return res.status(403).json({ error: subGate.code, message: subGate.message });
    clearLoginFailures(emailNorm);
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    if (user.role === 'user') {
      notifyAsync('USER_LOGIN', { name: `${user.first_name || ''} ${user.last_name || ''}`.trim(), email: user.email, role: user.role, mobile: user.phone || '—' });
    }
    res.json({ id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, profile_picture: user.profile_picture || '', role: user.role, country: user.country || '', timezone: user.timezone || '', height_cm: user.height_cm != null && user.height_cm !== '' ? Number(user.height_cm) : null, token });
  } catch (e) {
    console.error('[Login] Error:', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Google Auth (auto sign-up/login)
app.post('/api/auth/google', rateLimiter(20, 60000), async (req, res) => {
  try {
    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'ID token required' });

    // Decode JWT (in production, verify signature with Google's public keys)
    const parts = id_token.split('.');
    if (parts.length !== 3) return res.status(400).json({ error: 'Invalid token' });
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const { email, given_name, family_name, sub: google_id, picture } = payload;
    
    if (!email) return res.status(400).json({ error: 'Email required' });

    const emailNorm = String(email).trim().toLowerCase();
    let user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      // New user: require profile completion (phone, password) before creating
      return res.json({
        needs_profile: true,
        email: emailNorm,
        given_name: given_name || '',
        family_name: family_name || '',
        picture: picture || ''
      });
    }
    const status = user.approval_status || 'approved';
    if (status === 'rejected') {
      return res.status(403).json({ error: 'rejected', message: 'Your request was rejected. Please sign up again to submit a new request.' });
    }
    if (status !== 'approved') {
      return res.status(403).json({ error: 'pending_approval', message: 'Your account is pending admin approval. You will be able to log in once approved.' });
    }
    if (picture && !user.profile_picture) {
      await run("UPDATE users SET profile_picture = ? WHERE id = ?", [picture, user.id]);
      user.profile_picture = picture;
    }
    await syncUserCountryAndTimezone(user.id, user.email);
    user = await queryOne("SELECT * FROM users WHERE id = ?", [user.id]);
    const subGateG = subscriptionGate(user);
    if (subGateG) return res.status(403).json({ error: subGateG.code, message: subGateG.message });
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.json({ id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '', profile_picture: user.profile_picture || '', role: user.role, country: user.country || '', timezone: user.timezone || '', height_cm: user.height_cm != null && user.height_cm !== '' ? Number(user.height_cm) : null, token });
  } catch (e) {
    console.error('Google auth error:', e);
    res.status(500).json({ error: 'Google auth failed' });
  }
});

// Google Sign-up: complete profile (phone, password + new fields) for new Google users
app.post('/api/auth/google-complete', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { id_token, phone, password, dob, gender, country, timezone, state_province, city, height_cm } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'ID token required' });
    if (!phone || typeof phone !== 'string' || !phone.trim()) return res.status(400).json({ error: 'Mobile (WhatsApp) number is required' });
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const heightParsed = parseInt(height_cm, 10);
    if (!Number.isFinite(heightParsed) || heightParsed < 100 || heightParsed > 230) {
      return res.status(400).json({ error: 'Height must be a whole number between 100 and 230 cm' });
    }

    const parts = id_token.split('.');
    if (parts.length !== 3) return res.status(400).json({ error: 'Invalid token' });
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const { email, given_name, family_name, sub: google_id, picture } = payload;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const emailNorm = String(email).trim().toLowerCase();
    const phoneTrimmed = String(phone || '').trim();
    const geo = normalizeGeoFields(country, timezone);
    const cleanDob = dob && String(dob).trim() ? String(dob).trim().slice(0, 10) : null;
    const cleanGender = String(gender || '').trim().slice(0, 20);
    const cleanState = String(state_province || '').trim().slice(0, 100);
    const cleanCity = String(city || '').trim().slice(0, 100);

    const existing = await queryOne("SELECT id, approval_status FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (existing) return res.status(409).json({ error: 'Email already registered. Please log in instead.' });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, profile_picture, country, timezone, state_province, city, dob, gender, height_cm, role, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, emailNorm, hash, given_name || '', family_name || '', phoneTrimmed, picture || '', geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, 'user', 'approved']);
    const trialDays = trialDaysForReq(req);
    await startTrialForUser(id, trialDays).catch(() => {});
    const referralBonusDays = await safeAttachReferral(req, id);
    await addApprovedUserToTribe({ email: emailNorm, first_name: given_name, last_name: family_name, phone: phoneTrimmed, country: geo.country, city: cleanCity });
    sendPushToAdmins(JSON.stringify({ title: '🔥 New trial started (Google)', body: `${given_name || ''} ${family_name || ''} (${emailNorm}) started a ${trialDays}-day trial — call to convert`, id: 'signup-' + id })).catch(() => {});
    try { userEmail.emailAccountApproved(emailNorm, given_name); } catch (_) {}
    notifyAsync('TRIAL_STARTED', { name: `${given_name || ''} ${family_name || ''}`.trim(), email: emailNorm, phone: phoneTrimmed || '—', country: geo.country || '—', trial_days: trialDays, via: 'Google' });
    notifyAgent('TRIAL_STARTED', { name: `${given_name || ''} ${family_name || ''}`.trim(), email: emailNorm, phone: phoneTrimmed || '—', country: geo.country || '—', trial_days: trialDays, via: 'Google' });
    res.json({
      id, email: emailNorm, first_name: given_name || '', last_name: family_name || '', role: 'user',
      country: geo.country, timezone: geo.timezone, trial: true, trial_days: trialDays + referralBonusDays,
      referral_bonus_days: referralBonusDays,
      message: referralBonusDays > 0
        ? `Your account is ready — enjoy ${trialDays + referralBonusDays} days of full access (${trialDays} + ${referralBonusDays} referral bonus).`
        : `Your account is ready — enjoy ${trialDays} days of full access.`
    });
  } catch (e) {
    console.error('Google complete error:', e);
    res.status(500).json({ error: 'Failed to complete sign-up. Please try again.' });
  }
});

// Sign in with Apple (auto sign-up/login) — mirrors the Google flow (same approval gate).
// Accepts identity tokens from both the web (Services ID audience) and the native iOS
// app (bundle id audience). Apple sends the user's name only on the FIRST authorization,
// in a separate `user` object — never inside the token.
app.post('/api/auth/apple', rateLimiter(20, 60000), async (req, res) => {
  try {
    const { id_token, user } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'Identity token required' });

    let claims;
    try { claims = await verifyAppleIdentityToken(id_token); }
    catch (e) { console.error('Apple token verify failed:', e.message); return res.status(401).json({ error: 'Invalid Apple token' }); }

    const appleSub = String(claims.sub || '');
    const appleName = (user && user.name) || {};
    const givenName = String(appleName.firstName || '').trim();
    const familyName = String(appleName.lastName || '').trim();
    // Email comes from the token claim; may be a private @privaterelay.appleid.com address.
    const email = claims.email || (user && user.email) || '';
    const emailNorm = String(email).trim().toLowerCase();

    let userRow = null;
    if (emailNorm) userRow = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!userRow && appleSub) userRow = await queryOne("SELECT * FROM users WHERE apple_id = ?", [appleSub]);

    if (!userRow) {
      if (!emailNorm) return res.status(400).json({ error: 'Email required. Please retry and choose “Share My Email” when Apple asks.' });
      // New user: require profile completion (phone, password) before creating.
      return res.json({ needs_profile: true, provider: 'apple', email: emailNorm, given_name: givenName, family_name: familyName });
    }

    const status = userRow.approval_status || 'approved';
    if (status === 'rejected') return res.status(403).json({ error: 'rejected', message: 'Your request was rejected. Please sign up again to submit a new request.' });
    if (status !== 'approved') return res.status(403).json({ error: 'pending_approval', message: 'Your account is pending admin approval. You will be able to log in once approved.' });

    // Link the Apple identity to an existing (email / Google / password) account on first use.
    if (appleSub && !userRow.apple_id) { await run("UPDATE users SET apple_id = ? WHERE id = ?", [appleSub, userRow.id]); }
    await syncUserCountryAndTimezone(userRow.id, userRow.email);
    userRow = await queryOne("SELECT * FROM users WHERE id = ?", [userRow.id]);
    const subGateA = subscriptionGate(userRow);
    if (subGateA) return res.status(403).json({ error: subGateA.code, message: subGateA.message });
    const token = signToken({ id: userRow.id, email: userRow.email, role: userRow.role });
    res.json({ id: userRow.id, email: userRow.email, first_name: userRow.first_name || '', last_name: userRow.last_name || '', profile_picture: userRow.profile_picture || '', role: userRow.role, country: userRow.country || '', timezone: userRow.timezone || '', height_cm: userRow.height_cm != null && userRow.height_cm !== '' ? Number(userRow.height_cm) : null, token });
  } catch (e) {
    console.error('Apple auth error:', e);
    res.status(500).json({ error: 'Apple auth failed' });
  }
});

// Apple Sign-up: complete profile (phone, password + new fields) for new Apple users.
app.post('/api/auth/apple-complete', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { id_token, user, phone, password, dob, gender, country, timezone, state_province, city, height_cm } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'Identity token required' });
    if (!phone || typeof phone !== 'string' || !phone.trim()) return res.status(400).json({ error: 'Mobile (WhatsApp) number is required' });
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Password is required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const heightParsed = parseInt(height_cm, 10);
    if (!Number.isFinite(heightParsed) || heightParsed < 100 || heightParsed > 230) {
      return res.status(400).json({ error: 'Height must be a whole number between 100 and 230 cm' });
    }

    let claims;
    try { claims = await verifyAppleIdentityToken(id_token); }
    catch (e) { console.error('Apple complete verify failed:', e.message); return res.status(401).json({ error: 'Invalid Apple token' }); }

    const appleSub = String(claims.sub || '');
    const appleName = (user && user.name) || {};
    const givenName = String(appleName.firstName || '').trim();
    const familyName = String(appleName.lastName || '').trim();
    const email = claims.email || (user && user.email) || '';
    if (!email) return res.status(400).json({ error: 'Email required' });

    const emailNorm = String(email).trim().toLowerCase();
    const phoneTrimmed = String(phone || '').trim();
    const geo = normalizeGeoFields(country, timezone);
    const cleanDob = dob && String(dob).trim() ? String(dob).trim().slice(0, 10) : null;
    const cleanGender = String(gender || '').trim().slice(0, 20);
    const cleanState = String(state_province || '').trim().slice(0, 100);
    const cleanCity = String(city || '').trim().slice(0, 100);

    const existing = await queryOne("SELECT id FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (existing) return res.status(409).json({ error: 'Email already registered. Please log in instead.' });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, apple_id, country, timezone, state_province, city, dob, gender, height_cm, role, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, emailNorm, hash, givenName, familyName, phoneTrimmed, appleSub, geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, 'user', 'approved']);
    const trialDays = trialDaysForReq(req);
    await startTrialForUser(id, trialDays).catch(() => {});
    const referralBonusDays = await safeAttachReferral(req, id);
    await addApprovedUserToTribe({ email: emailNorm, first_name: givenName, last_name: familyName, phone: phoneTrimmed, country: geo.country, city: cleanCity });
    sendPushToAdmins(JSON.stringify({ title: '🔥 New trial started (Apple)', body: `${givenName} ${familyName} (${emailNorm}) started a ${trialDays}-day trial — call to convert`, id: 'signup-' + id })).catch(() => {});
    try { userEmail.emailAccountApproved(emailNorm, givenName); } catch (_) {}
    notifyAsync('TRIAL_STARTED', { name: `${givenName} ${familyName}`.trim(), email: emailNorm, phone: phoneTrimmed || '—', country: geo.country || '—', trial_days: trialDays, via: 'Apple' });
    notifyAgent('TRIAL_STARTED', { name: `${givenName} ${familyName}`.trim(), email: emailNorm, phone: phoneTrimmed || '—', country: geo.country || '—', trial_days: trialDays, via: 'Apple' });
    res.json({
      id, email: emailNorm, first_name: givenName, last_name: familyName, role: 'user',
      country: geo.country, timezone: geo.timezone, trial: true, trial_days: trialDays + referralBonusDays,
      referral_bonus_days: referralBonusDays,
      message: referralBonusDays > 0
        ? `Your account is ready — enjoy ${trialDays + referralBonusDays} days of full access (${trialDays} + ${referralBonusDays} referral bonus).`
        : `Your account is ready — enjoy ${trialDays} days of full access.`
    });
  } catch (e) {
    console.error('Apple complete error:', e);
    res.status(500).json({ error: 'Failed to complete sign-up. Please try again.' });
  }
});

app.post('/api/auth/signup', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone, country, timezone, state_province, city, dob, gender, height_cm } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const heightParsed = parseInt(height_cm, 10);
    if (!Number.isFinite(heightParsed) || heightParsed < 100 || heightParsed > 230) {
      return res.status(400).json({ error: 'Height must be a whole number between 100 and 230 cm' });
    }
    const geo = normalizeGeoFields(country, timezone);
    const cleanDob = dob && String(dob).trim() ? String(dob).trim().slice(0, 10) : null;
    const cleanGender = String(gender || '').trim().slice(0, 20);
    const cleanState = String(state_province || '').trim().slice(0, 100);
    const cleanCity = String(city || '').trim().slice(0, 100);

    const emailNorm = String(email).trim().toLowerCase();
    const existing = await queryOne("SELECT id, approval_status FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (existing && existing.approval_status === 'rejected') {
      const hash = await bcrypt.hash(password, 10);
      await run("UPDATE users SET password=?, first_name=?, last_name=?, phone=?, country=?, timezone=?, state_province=?, city=?, dob=?, gender=?, height_cm=?, approval_status='approved' WHERE id=?",
        [hash, first_name || '', last_name || '', phone || '', geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, existing.id]);
      const trialDaysR = trialDaysForReq(req);
      await startTrialForUser(existing.id, trialDaysR).catch(() => {});
      const referralBonusDaysR = await safeAttachReferral(req, existing.id);
      await addApprovedUserToTribe({ email: emailNorm, first_name, last_name, phone, country: geo.country, city: cleanCity });
      try { userEmail.emailAccountApproved(emailNorm, first_name); } catch (_) {}
      notifyAsync('TRIAL_STARTED', { name: `${first_name || ''} ${last_name || ''}`.trim(), email: emailNorm, phone: phone || '—', country: geo.country || '—', trial_days: trialDaysR, via: 'Email' });
      notifyAgent('TRIAL_STARTED', { name: `${first_name || ''} ${last_name || ''}`.trim(), email: emailNorm, phone: phone || '—', country: geo.country || '—', trial_days: trialDaysR, via: 'Email' });
      return res.json({ id: existing.id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user', country: geo.country, timezone: geo.timezone, trial: true, trial_days: trialDaysR + referralBonusDaysR, referral_bonus_days: referralBonusDaysR });
    }
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, country, timezone, state_province, city, dob, gender, height_cm, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, emailNorm, hash, first_name || '', last_name || '', phone || '', geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, 'approved']);
    // Instant access: start a free trial right away (no manual approval gate).
    const trialDays = trialDaysForReq(req);
    await startTrialForUser(id, trialDays).catch(() => {});
    const referralBonusDays = await safeAttachReferral(req, id);
    await addApprovedUserToTribe({ email: emailNorm, first_name, last_name, phone, country: geo.country, city: cleanCity });
    sendPushToAdmins(JSON.stringify({ title: '🔥 New trial started', body: `${first_name || ''} ${last_name || ''} (${emailNorm}) started a ${trialDays}-day trial — call to convert`, id: 'signup-' + id })).catch(() => {});
    try { userEmail.emailAccountApproved(emailNorm, first_name); } catch (_) {}
    notifyAsync('TRIAL_STARTED', { name: `${first_name || ''} ${last_name || ''}`.trim(), email: emailNorm, phone: phone || '—', country: geo.country || '—', trial_days: trialDays, via: 'Email' });
    notifyAgent('TRIAL_STARTED', { name: `${first_name || ''} ${last_name || ''}`.trim(), email: emailNorm, phone: phone || '—', country: geo.country || '—', trial_days: trialDays, via: 'Email' });
    res.json({ id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user', country: geo.country, timezone: geo.timezone, trial: true, trial_days: trialDays + referralBonusDays, referral_bonus_days: referralBonusDays });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ FORGOT PASSWORD (users only, not admin/superadmin) ============
app.post('/api/auth/forgot-password', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' });
    const emailNorm = String(email).trim().toLowerCase();
    if (!emailNorm) return res.status(400).json({ error: 'Email required' });

    const user = await queryOne("SELECT id, role FROM users WHERE LOWER(email) = ?", [emailNorm]);
    // Only allow password reset for role='user'. Never reset admin/superadmin via this flow.
    if (!user || user.role !== 'user') {
      return res.json({ ok: true, message: "Please check your email if an account exists with this address." });
    }

    // Invalidate any existing pending resets for this user
    await run("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0", [user.id]);

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
    const id = uuidv4();
    // Only the hash is stored. The plaintext token lives just long enough to build
    // the email link below. Previously the token was stored verbatim, so anyone who
    // obtained a copy of the table — a backup, a dump, the unauthenticated
    // /api/admin/db-view that used to exist — held a working account-takeover link
    // for every pending reset.
    await run("INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)", [id, user.id, hashResetToken(token), expiresAt]);

    // The reset link must never be built from the request.
    //
    // This used to fall back to `req.get('host')`. Host is attacker-controlled, so a
    // forged forgot-password request for someone else's address ("Host: evil.example")
    // emailed the victim a genuine-looking BodyBank link pointing at the attacker —
    // click it and the reset token is theirs. Classic password-reset poisoning.
    //
    // The base now comes only from configuration. In production, if nothing is
    // configured we refuse to send rather than send a poisonable link.
    const base = resolveResetBaseUrl();
    if (!base) {
      console.error(
        '[ForgotPassword] No reset base URL configured. Set RESET_BASE_URL (or ' +
        'APP_BASE_URL / SITE_URL) to the canonical site origin. Refusing to build a ' +
        'reset link from the request Host header.'
      );
      // Same opaque answer as every other path, so this reveals nothing to a caller.
      return res.json({ ok: true, message: "Please check your email if an account exists with this address." });
    }
    const resetLink = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    if (userEmail.isConfigured()) {
      try {
        userEmail.emailPasswordResetLuxury(emailNorm, resetLink);
        console.log('[ForgotPassword] Reset email queued for', emailNorm, '| link base:', base);
      } catch (err) {
        console.error('[ForgotPassword] SMTP failed:', err.message);
      }
    } else if (NODE_ENV === 'production') {
      console.warn('[ForgotPassword] SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS) – user did not receive reset link');
    }

    notifyAsync('PASSWORD_RESET_REQUEST', { email: emailNorm });
    const includeLink = NODE_ENV !== 'production';
    return res.json({ ok: true, message: "Please check your email if an account exists with this address.", resetLink: includeLink ? resetLink : undefined });
  } catch (e) {
    console.error('[ForgotPassword] Error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.get('/api/auth/verify-reset-token/:token', async (req, res) => {
  try {
    // Strip any chars that email clients might add (line breaks, zero-width, etc). Keep only UUID chars [a-fA-F0-9-]
    let token = String(req.params.token || '').replace(/[^a-fA-F0-9-]/g, '');
    if (!token || token.length < 32) {
      console.log('[VerifyResetToken] Token too short or empty (len=' + (token && token.length) + ')');
      return res.json({ valid: false });
    }

    const row = await queryOne(
      "SELECT pr.id, pr.used, pr.expires_at, u.role FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token IN (?, ?)",
      // Hash first; the raw token is the legacy form, accepted so links already in
      // people's inboxes when this shipped keep working until they expire (24h).
      // The plaintext arm can be deleted after that window.
      [hashResetToken(token), token]
    );
    if (!row) {
      console.log('[VerifyResetToken] Token not found in DB (len=' + token.length + ')');
      return res.json({ valid: false });
    }
    if (row.used) {
      console.log('[VerifyResetToken] Token already used');
      return res.json({ valid: false });
    }
    if (new Date(row.expires_at) < new Date()) {
      console.log('[VerifyResetToken] Token expired');
      return res.json({ valid: false });
    }
    if (row.role !== 'user') {
      console.log('[VerifyResetToken] Wrong role');
      return res.json({ valid: false });
    }

    return res.json({ valid: true });
  } catch (e) {
    console.error('[VerifyResetToken] Error:', e.message);
    return res.json({ valid: false });
  }
});

app.post('/api/auth/reset-password', rateLimiter(10, 60000), async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Invalid reset token' });
    if (!new_password || typeof new_password !== 'string') return res.status(400).json({ error: 'New password required' });
    const pw = String(new_password).trim();
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const row = await queryOne(
      "SELECT pr.id, pr.user_id, pr.used, pr.expires_at, u.role, u.password, u.email, u.first_name, u.last_name, u.profile_picture, u.country, u.timezone, u.height_cm FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token IN (?, ?)",
      // Hash first; the raw token is the legacy form, accepted so links already in
      // people's inboxes when this shipped keep working until they expire (24h).
      // The plaintext arm can be deleted after that window.
      [hashResetToken(token), token]
    );
    if (!row || row.used) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (row.role !== 'user') return res.status(400).json({ error: 'Invalid or expired reset token' });

    if (row.password && await bcrypt.compare(pw, row.password)) {
      return res.status(400).json({ error: 'You cannot use the same password as your previous one. Please choose a different password.' });
    }

    const hash = await bcrypt.hash(pw, 10);
    await run("UPDATE users SET password = ? WHERE id = ?", [hash, row.user_id]);
    await run("UPDATE password_resets SET used = 1 WHERE id = ?", [row.id]);

    userEmail.emailPasswordChanged(row.email, row.first_name);
    notifyAsync('PASSWORD_RESET_DONE', { email: row.email });

    const sessionToken = signToken({ id: row.user_id, email: row.email, role: row.role });
    return res.json({
      ok: true,
      message: 'Password updated successfully.',
      id: row.user_id,
      email: row.email,
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      profile_picture: row.profile_picture || '',
      role: row.role,
      country: row.country || '',
      timezone: row.timezone || '',
      height_cm: row.height_cm != null && row.height_cm !== '' ? Number(row.height_cm) : null,
      token: sessionToken
    });
  } catch (e) {
    console.error('[ResetPassword] Error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ============ AUDIT REQUESTS ============
app.post('/api/audit', rateLimiter(5, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name || !b.email) return res.status(400).json({ error: 'Name and email required' });

    const id = uuidv4();
    await run(`INSERT INTO audit_requests (id,first_name,last_name,age,sex,email,phone,country,city,occupation,work_intensity,fitness_experience,goals,motivation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.first_name, b.last_name||'', b.age||null, b.sex||'', b.email, b.phone||'', b.country||'', b.city||'', b.occupation||'', b.work_intensity||'', b.fitness_experience||'', b.goals||'', b.motivation||'']);
    sendPushToAdmins(JSON.stringify({ title: 'New audit form', body: `${b.first_name || ''} ${b.last_name || ''} submitted a Body Audit`, id: 'audit-' + id })).catch(() => {});
    const auditPayload = {
      name: `${b.first_name || ''} ${b.last_name || ''}`.trim() || '—',
      email: b.email || '—',
      mobile: b.phone || '—',
      city: b.city || '—',
      country: b.country || '—',
      age: b.age || '—',
      sex: b.sex || '—',
      occupation: b.occupation || '—',
      work_intensity: b.work_intensity || '—',
      fitness_experience: b.fitness_experience || '—',
      goals: b.goals || '—',
      motivation: b.motivation || '—',
      raw: b
    };
    console.log('[audit] firing AUDIT_FORM notify for:', b.email);
    const auditTemplateSid = String(process.env.TWILIO_AUDIT_TEMPLATE_SID || '').trim();
    let auditNotifyResult = null;
    if (auditTemplateSid) {
      auditNotifyResult = await sendWhatsAppTemplate(auditTemplateSid, {
        1: auditPayload.name,
        2: auditPayload.email,
        3: auditPayload.mobile,
        4: `${auditPayload.city}, ${auditPayload.country}`,
        5: `${auditPayload.age} | ${auditPayload.sex}`,
        6: auditPayload.occupation,
        7: auditPayload.work_intensity,
        8: auditPayload.fitness_experience
      });
    }
    if (!auditNotifyResult || !auditNotifyResult.ok) {
      const agentAuditPayload = {
        name: auditPayload.name,
        email: auditPayload.email,
        mobile: auditPayload.mobile,
        city: auditPayload.city,
        country: auditPayload.country,
        age: auditPayload.age,
        sex: auditPayload.sex,
        occupation: auditPayload.occupation,
        work_intensity: auditPayload.work_intensity,
        fitness_experience: auditPayload.fitness_experience,
        goals: auditPayload.goals,
        motivation: auditPayload.motivation
      };
      notifyAgent('AUDIT_FORM', agentAuditPayload);
      auditNotifyResult = await notify('AUDIT_FORM', auditPayload, { noDedup: true });
    }
    if (!auditNotifyResult || !auditNotifyResult.ok) {
      const formatted = formatEventMessage('AUDIT_FORM', auditPayload);
      if (formatted && formatted.message) {
        console.warn('[audit] notifier path failed, trying direct WhatsApp fallback for:', b.email);
        auditNotifyResult = await sendWhatsApp(formatted.message);
      }
    }
    if (!auditNotifyResult || !auditNotifyResult.ok) {
      console.error('[audit] WhatsApp send ultimately failed for:', b.email, auditNotifyResult);
    }
    userEmail.emailAuditReceived(String(b.email).trim(), b.first_name);
    res.json({ id, message: 'Request submitted successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/audit', verifyToken, requireOperator, async (req, res) => {
  const rows = await queryAll("SELECT * FROM audit_requests ORDER BY created_at DESC");
  res.json(rows);
});

// Twilio WhatsApp inbound (signature-verified). Disabled unless WA_INBOUND_ENABLED=true.
app.post('/wa/inbound', rateLimiter(60, 60000), (req, res) => waInbound.handleWebhook(req, res));

app.get('/api/admin/wa/drafts', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await waInbound.listDrafts(req.query && req.query.status);
    res.json(rows);
  } catch (e) {
    console.error('[wa-inbound] list drafts:', e.message);
    res.status(500).json({ error: 'Failed to load WhatsApp drafts' });
  }
});

app.post('/api/admin/wa/drafts/:id/approve', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const result = await waInbound.approveDraft(req.params.id, {
      body: req.body && req.body.body,
      reviewedBy: (req.user && (req.user.email || req.user.id)) || ''
    });
    if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Draft not found' });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[wa-inbound] approve:', e.message);
    res.status(500).json({ error: 'Failed to approve draft' });
  }
});

app.post('/api/admin/wa/drafts/:id/reject', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const result = await waInbound.rejectDraft(req.params.id, {
      reviewedBy: (req.user && (req.user.email || req.user.id)) || ''
    });
    if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Draft not found' });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[wa-inbound] reject:', e.message);
    res.status(500).json({ error: 'Failed to reject draft' });
  }
});

// ── WhatsApp test (admin only) ── send a test message to verify Twilio config
app.get('/api/admin/test-whatsapp', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  const { sendWhatsApp, isConfigured } = require('./services/whatsapp');
  if (!isConfigured()) {
    const missing = ['TWILIO_SID', 'TWILIO_AUTH', 'ADMIN_WHATSAPP'].filter(k => !process.env[k]);
    return res.status(400).json({ ok: false, reason: 'not_configured', missing });
  }
  const result = await sendWhatsApp(`🧪 BodyBank WhatsApp Test\nSent at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\nIf you received this, Twilio is working correctly.`);
  res.json(result);
});

app.get('/api/audit/:id', verifyToken, requireOperator, async (req, res) => {
  const row = await queryOne("SELECT * FROM audit_requests WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.put('/api/audit/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await run("UPDATE audit_requests SET status = ? WHERE id = ?", [status, req.params.id]);
  res.json({ message: 'Updated' });
});

app.delete('/api/audit/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  await run("DELETE FROM audit_requests WHERE id = ?", [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ============ PART-2 BODY AUDIT FORM (Shareable) ============
app.post('/api/part2', rateLimiter(5, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.email) return res.status(400).json({ error: 'Name and email required' });

    const id = uuidv4();
    const heightCm = Number.isFinite(Number(b.height_cm)) ? Number(b.height_cm) : null;
    const bodyweightKg = Number.isFinite(Number(b.bodyweight_kg)) ? Number(b.bodyweight_kg) : null;
    const stressLevel = Number.isFinite(Number(b.stress_level)) ? Math.max(1, Math.min(10, Math.round(Number(b.stress_level)))) : null;
    await run(`INSERT INTO part2_audit (id, name, email, mobile, sports_history, injuries, mental_health, gym_experience, food_choices, vices_addictions, goals, what_compelled, activity_level, height_cm, bodyweight_kg, workouts_per_week, sleep_hours, stress_level, smoking, alcohol) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name || '', b.email || '', b.mobile || '', b.sports_history || '', b.injuries || '', b.mental_health || '', b.gym_experience || '', b.food_choices || '', b.vices_addictions || '', b.goals || '', b.what_compelled || '', b.activity_level || '', heightCm, bodyweightKg, b.workouts_per_week || '', b.sleep_hours || '', stressLevel, b.smoking || '', b.alcohol || '']);

    let result = null;
    try {
      const part1 = await queryOne(
        `SELECT first_name, last_name, age, sex, occupation, work_intensity, fitness_experience
         FROM audit_requests WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1`,
        [b.email]
      );
      result = computeAuditResult(part1 || {}, b);
      await run(
        `UPDATE part2_audit SET score = ?, tier_key = ?, tier_label = ?, sub_scores = ?, weak_lever = ?, result_generated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [result.total, result.tier_key, result.tier_label, JSON.stringify(result.sub_scores), result.weak_lever, id]
      );
    } catch (scoringErr) {
      console.error('[audit-result] scoring failed:', scoringErr.message);
    }

    sendPushToAdmins(JSON.stringify({ title: 'New Part-2 form', body: `${b.name || ''} (${b.email || ''}) submitted Part-2 audit`, id: 'part2-' + id })).catch(() => {});
    userEmail.emailPart2Received(String(b.email).trim(), b.name);
    if (b.user_id) {
      await safeAwardCoins(
        String(b.user_id),
        'part2_complete',
        `coins:part2_complete:${String(b.user_id)}`,
        coinService.COIN_RULES.PART2_COMPLETE,
        { formId: id }
      );
    }
    notifyAsync('PART2_FORM', {
      name: b.name || '—',
      email: b.email || '—',
      mobile: b.mobile || '—',
      goals: b.goals || '—',
      sports_history: b.sports_history || '—',
      injuries: b.injuries || '—',
      mental_health: b.mental_health || '—',
      gym_experience: b.gym_experience || '—',
      food_choices: b.food_choices || '—',
      vices_addictions: b.vices_addictions || '—',
      what_compelled: b.what_compelled || '—',
      activity_level: b.activity_level || '—',
      user_id: b.user_id || '—'
    });
    notifyAgent('PART2_FORM', {
      name: b.name || '—',
      email: b.email || '—',
      mobile: b.mobile || '—',
      goals: b.goals || '—',
      sports_history: b.sports_history || '—',
      injuries: b.injuries || '—',
      mental_health: b.mental_health || '—',
      gym_experience: b.gym_experience || '—',
      food_choices: b.food_choices || '—',
      vices_addictions: b.vices_addictions || '—',
      what_compelled: b.what_compelled || '—',
      activity_level: b.activity_level || '—',
      user_id: b.user_id || '—'
    });
    res.json({ id, message: 'Form submitted successfully', result: result || null });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/audit-result/:part2_id', verifyToken, requireOperator, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT id, name, email, score, tier_key, tier_label, sub_scores, weak_lever, result_generated_at
       FROM part2_audit WHERE id = ?`,
      [req.params.part2_id]
    );
    if (!row) return res.status(404).json({ error: 'Result not found' });
    if (row.score == null) return res.status(404).json({ error: 'Result not yet generated' });
    let subs = {};
    try { subs = row.sub_scores ? JSON.parse(row.sub_scores) : {}; } catch (_) { subs = {}; }
    res.json({
      id: row.id,
      name: row.name,
      total: row.score,
      tier_key: row.tier_key || '',
      tier_label: row.tier_label || '',
      sub_scores: subs,
      weak_lever: row.weak_lever || '',
      generated_at: row.result_generated_at
    });
  } catch (e) {
    console.error('[audit-result] fetch failed:', e.message);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

app.get('/api/part2', verifyToken, requireOperator, async (req, res) => {
  const rows = await queryAll("SELECT * FROM part2_audit ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/part2/:id', verifyToken, requireOperator, async (req, res) => {
  const row = await queryOne("SELECT * FROM part2_audit WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.delete('/api/part2/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  await run("DELETE FROM part2_audit WHERE id = ?", [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ============ SCHEDULED CALLS (Public funnel — Step 3) ============
// Working hours / slot config for the auto-scheduling flow. 30-min slots in IST.
const SCHEDULE_CALL_TZ = 'Asia/Kolkata';
const SCHEDULE_CALL_SLOTS = [
  '10:00','10:30','11:00','11:30','12:00','12:30',
  '14:00','14:30','15:00','15:30','16:00','16:30',
  '17:00','17:30','18:00','18:30'
];

// GET /api/schedule-call/availability?date=YYYY-MM-DD
// Returns { date, slots: [{ time, available }] }
app.get('/api/schedule-call/availability', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const booked = await queryAll(
      "SELECT call_time FROM scheduled_calls WHERE call_date = ? AND status = 'scheduled'",
      [date]
    );
    const bookedSet = new Set(booked.map(r => String(r.call_time)));
    const slots = SCHEDULE_CALL_SLOTS.map(t => ({ time: t, available: !bookedSet.has(t) }));
    res.json({ date, timezone: SCHEDULE_CALL_TZ, slots });
  } catch (e) {
    console.error('[schedule-call] availability error:', e.message);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

// POST /api/schedule-call
// Body: { name, email, mobile, call_date, call_time, channel, audit_id?, notes? }
app.post('/api/schedule-call', rateLimiter(5, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const mobile = String(b.mobile || '').trim();
    const date = String(b.call_date || '').trim();
    const time = String(b.call_time || '').trim();
    const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'call';
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    if (!/^\d{2}:\d{2}$/.test(time) || !SCHEDULE_CALL_SLOTS.includes(time)) {
      return res.status(400).json({ error: 'Invalid time slot' });
    }
    // Reject past dates (use IST date)
    const todayIst = new Date(new Date().toLocaleString('en-US', { timeZone: SCHEDULE_CALL_TZ }));
    const todayStr = todayIst.toISOString().slice(0, 10);
    if (date < todayStr) return res.status(400).json({ error: 'Date is in the past' });

    // Check the slot isn't already taken
    const existing = await queryOne(
      "SELECT id FROM scheduled_calls WHERE call_date = ? AND call_time = ? AND status = 'scheduled'",
      [date, time]
    );
    if (existing) return res.status(409).json({ error: 'That slot was just booked — please pick another time.' });

    const id = uuidv4();
    await run(
      `INSERT INTO scheduled_calls (id, audit_id, name, email, mobile, call_date, call_time, timezone, channel, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, String(b.audit_id || ''), name, email, mobile, date, time, SCHEDULE_CALL_TZ, channel, 'scheduled', String(b.notes || '')]
    );

    // Roll the matching audit_requests row forward to the "call" stage so the admin pipeline reflects it.
    try {
      await run(
        `UPDATE audit_requests
         SET stage = 'call', stage_changed_at = NOW(), call_scheduled_at = NOW(), last_contact_at = NOW()
         WHERE LOWER(email) = LOWER(?)`,
        [email]
      );
    } catch (e) { /* ignore — pipeline columns are best-effort */ }

    // Pretty date string for the email body
    const friendlyDate = (function () {
      try {
        return new Date(date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      } catch (_) { return date; }
    })();

    // Build ICS + send luxury confirmation email
    try {
      const ics = userEmail.buildCallIcs({
        id, name, email, date, time, durationMin: 30, tz: SCHEDULE_CALL_TZ
      });
      userEmail.emailCallScheduledWithICS({
        email,
        name: (name.split(/\s+/)[0] || 'there'),
        dateStr: friendlyDate,
        timeStr: time,
        channel,
        icsContent: ics
      });
    } catch (e) { console.warn('[schedule-call] email error:', e.message); }

    // Admin push + WhatsApp/email alert
    sendPushToAdmins(JSON.stringify({
      title: 'New call scheduled',
      body: `${name} booked a ${channel === 'whatsapp' ? 'WhatsApp' : 'call'} on ${friendlyDate} at ${time} IST`,
      id: 'sched-' + id
    })).catch(() => {});
    notifyAsync('MEETING_SCHEDULED', {
      name: name || '—',
      email: email || '—',
      mobile: mobile || '—',
      date: friendlyDate || '—',
      slot: `${time} IST (${channel === 'whatsapp' ? 'WhatsApp' : 'Phone call'})`
    });
    notifyAgent('MEETING_SCHEDULED', {
      name: name || '—',
      email: email || '—',
      mobile: mobile || '—',
      date: friendlyDate || '—',
      slot: `${time} IST (${channel === 'whatsapp' ? 'WhatsApp' : 'Phone call'})`
    });

    res.json({ id, ok: true, message: 'Call scheduled successfully' });
  } catch (e) {
    console.error('[schedule-call] POST error:', e.message);
    res.status(500).json({ error: 'Failed to schedule call' });
  }
});

// ============ MEETINGS (Schedule a Call) ============
//
// A consultation is a real hour of someone's day, so three things have to hold:
// a member can only take a slot that is still ahead of them, only one member can
// hold a given slot, and a booking belongs to whoever made it. None of that was
// true before — the route had no auth at all and read user_id straight off the
// body, and nothing stopped a booking being placed last Tuesday at 9am.

// Labels are the display strings already stored in meetings.time_slot, so no
// existing row has to be migrated; the 24h pair beside each one is what makes
// "is this slot in the past?" answerable.
const MEETING_TZ = SCHEDULE_CALL_TZ;
const MEETING_SLOTS = [
  { label: '9:00 AM',  h: 9  },
  { label: '10:00 AM', h: 10 },
  { label: '11:00 AM', h: 11 },
  { label: '12:00 PM', h: 12 },
  { label: '2:00 PM',  h: 14 },
  { label: '3:00 PM',  h: 15 },
  { label: '4:00 PM',  h: 16 },
  { label: '5:00 PM',  h: 17 },
  { label: '6:00 PM',  h: 18 }
];
const MEETING_SLOT_BY_LABEL = MEETING_SLOTS.reduce((m, s) => (m[s.label] = s, m), {});
// How far ahead a member may book. Beyond this the coach's diary is not real yet.
const MEETING_MAX_DAYS_AHEAD = 60;
// A slot stops being bookable this many minutes before it starts, so nobody
// books a call that begins in ninety seconds.
const MEETING_LEAD_MINUTES = 30;

/** Today, and the minutes elapsed today, in the coaching timezone. */
function meetingNowInTz() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: MEETING_TZ }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return { today: `${y}-${m}-${d}`, minutes: now.getHours() * 60 + now.getMinutes() };
}

/** The furthest date a member may book, as YYYY-MM-DD. */
function meetingMaxDate() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: MEETING_TZ }));
  now.setDate(now.getDate() + MEETING_MAX_DAYS_AHEAD);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** True when this date+slot has already started (or is inside the lead time). */
function meetingSlotHasPassed(dateStr, label) {
  const slot = MEETING_SLOT_BY_LABEL[label];
  if (!slot) return true;
  const { today, minutes } = meetingNowInTz();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return slot.h * 60 <= minutes + MEETING_LEAD_MINUTES;
}

/**
 * Everything a booking has to satisfy, in one place so the book and the
 * reschedule paths cannot drift apart.
 * @returns {{error:string}|{date:string,slot:string}}
 */
function validateMeetingSlot(dateStr, label) {
  const date = String(dateStr || '').trim();
  const slot = String(label || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a valid date.' };
  if (!MEETING_SLOT_BY_LABEL[slot]) return { error: 'Pick one of the available time slots.' };
  const { today } = meetingNowInTz();
  if (date < today) return { error: 'That date has already passed. Please pick a future date.' };
  if (date > meetingMaxDate()) return { error: `Bookings open ${MEETING_MAX_DAYS_AHEAD} days ahead. Please pick an earlier date.` };
  if (meetingSlotHasPassed(date, slot)) return { error: 'That time has already passed today. Please pick a later slot.' };
  return { date, slot };
}

/** Is anyone else holding this slot? `exceptId` skips the booking being moved. */
async function meetingSlotTaken(date, slot, exceptId) {
  const row = await queryOne(
    `SELECT id FROM meetings
      WHERE meeting_date = ? AND time_slot = ? AND status = 'scheduled'
        AND (?::text IS NULL OR id <> ?) LIMIT 1`,
    [date, slot, exceptId || null, exceptId || '']);
  return !!row;
}

function meetingIsStaff(user) {
  return !!user && (user.role === 'admin' || user.role === 'superadmin');
}

// What the booking form draws itself from: the slot list, the bookable window,
// and which slots are gone for the chosen day.
app.get('/api/meetings/availability', verifyToken, async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    const { today } = meetingNowInTz();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
    let takenSet = new Set();
    if (date) {
      const booked = await queryAll(
        "SELECT time_slot FROM meetings WHERE meeting_date = ? AND status = 'scheduled'", [date]);
      takenSet = new Set(booked.map(r => String(r.time_slot)));
    }
    const slots = MEETING_SLOTS.map(s => {
      const past = date ? meetingSlotHasPassed(date, s.label) : false;
      const taken = takenSet.has(s.label);
      return { label: s.label, past, taken, available: !!date && !past && !taken };
    });
    res.json({ date: date || null, timezone: MEETING_TZ, today, maxDate: meetingMaxDate(), slots });
  } catch (e) {
    console.error('[meetings] availability error:', e.message);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

// The signed-in member's own consultations, upcoming first — the list they
// track a booking in.
app.get('/api/meetings/mine', verifyToken, async (req, res) => {
  try {
    const rows = await queryAll(
      'SELECT * FROM meetings WHERE user_id = ? ORDER BY meeting_date DESC, created_at DESC LIMIT 100',
      [req.user.id]);
    const { today, minutes } = meetingNowInTz();
    res.json({
      today,
      timezone: MEETING_TZ,
      maxDate: meetingMaxDate(),
      meetings: (rows || []).map(m => {
        const slot = MEETING_SLOT_BY_LABEL[String(m.time_slot)];
        const past = m.meeting_date < today ||
          (m.meeting_date === today && slot && slot.h * 60 + 60 <= minutes);
        return { ...m, is_past: !!past, can_change: m.status === 'scheduled' && !past };
      })
    });
  } catch (e) {
    console.error('[meetings] mine error:', e.message);
    res.status(500).json({ error: 'Failed to load your consultations' });
  }
});
app.post('/api/meetings', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    // A member books for themselves and nobody else. Only staff may name a
    // different client — before this, user_id came straight off the body.
    const staff = meetingIsStaff(req.user);
    const ownerId = staff && b.user_id ? String(b.user_id) : String(req.user.id);
    if (!ownerId) return res.status(400).json({ error: 'User, date and time slot required' });

    const v = validateMeetingSlot(b.meeting_date, b.time_slot);
    if (v.error) return res.status(400).json({ error: v.error });
    if (await meetingSlotTaken(v.date, v.slot, null)) {
      return res.status(409).json({ error: 'That slot has just been taken. Please pick another time.' });
    }

    const id = uuidv4();
    // Name, email and phone are taken from the profile rather than the body, so
    // an admin list can never show a client-supplied identity.
    const who = await queryOne('SELECT first_name, last_name, email, phone FROM users WHERE id = ?', [ownerId]).catch(() => null);
    const fullName = who ? `${who.first_name || ''} ${who.last_name || ''}`.trim() : '';
    b.user_name = fullName || b.user_name || '';
    b.user_email = (who && who.email) || b.user_email || '';
    b.user_phone = (who && who.phone) || b.user_phone || '';
    b.meeting_date = v.date;
    b.time_slot = v.slot;
    await run(`INSERT INTO meetings (id, user_id, user_name, user_email, user_phone, meeting_date, time_slot, status, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, ownerId, b.user_name, b.user_email, b.user_phone, v.date, v.slot, 'scheduled', b.notes||'']);
    if (b.user_email && String(b.user_email).trim()) {
      const dn = b.meeting_date ? new Date(b.meeting_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : String(b.meeting_date || '');
      userEmail.emailMeetingScheduled(String(b.user_email).trim(), (b.user_name || '').split(/\s+/)[0] || 'there', dn, b.time_slot || '');
    }
    notifyAsync('MEETING_SCHEDULED', { name: b.user_name || '—', email: b.user_email || '—', mobile: b.user_phone || '—', date: b.meeting_date || '—', slot: b.time_slot || '—' });
    notifyAgent('MEETING_SCHEDULED', { name: b.user_name || '—', email: b.user_email || '—', mobile: b.user_phone || '—', date: b.meeting_date || '—', slot: b.time_slot || '—' });
    res.json({ id, message: 'Call scheduled successfully' });
  } catch (e) {
    console.error('[meetings] POST error:', e.message);
    res.status(500).json({ error: e.message || 'Failed to schedule call' });
  }
});

app.get('/api/meetings', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  const rows = await queryAll("SELECT * FROM meetings WHERE status='scheduled' ORDER BY meeting_date ASC, time_slot ASC");
  res.json(rows);
});

// Anyone could read anyone's consultations from this by guessing an id.
app.get('/api/meetings/user/:userId', verifyToken, async (req, res) => {
  if (String(req.params.userId) !== String(req.user.id) && !meetingIsStaff(req.user)) {
    return res.status(403).json({ error: 'Not your consultations' });
  }
  const rows = await queryAll("SELECT * FROM meetings WHERE user_id = ? ORDER BY meeting_date DESC, created_at DESC", [req.params.userId]);
  res.json(rows);
});

app.get('/api/admin/meetings/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM meetings WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load meeting' });
  }
});

app.get('/api/admin/contact-messages/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM contact_messages WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load message' });
  }
});

// Reschedule or cancel. A member may only touch their own booking, may only
// move it to a slot that is free and still ahead, and may not resurrect one
// that is finished. Staff keep the wider hand they always had.
app.put('/api/meetings/:id', verifyToken, rateLimiter(20, 60000), async (req, res) => {
  try {
    const { meeting_date, time_slot, status } = req.body || {};
    const row = await queryOne("SELECT * FROM meetings WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const staff = meetingIsStaff(req.user);
    if (!staff && String(row.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Not your consultation' });
    }

    const updates = [];
    const values = [];
    const movingDate = meeting_date !== undefined && meeting_date !== null;
    const movingSlot = time_slot !== undefined && time_slot !== null;

    if (movingDate || movingSlot) {
      if (!staff && row.status !== 'scheduled') {
        return res.status(400).json({ error: 'Only a scheduled consultation can be moved.' });
      }
      const nextDate = movingDate ? meeting_date : row.meeting_date;
      const nextSlot = movingSlot ? time_slot : row.time_slot;
      // Staff book on the phone with a client and sometimes need a past slot to
      // record what actually happened; a member never does.
      if (!staff) {
        const v = validateMeetingSlot(nextDate, nextSlot);
        if (v.error) return res.status(400).json({ error: v.error });
        if (await meetingSlotTaken(v.date, v.slot, row.id)) {
          return res.status(409).json({ error: 'That slot has just been taken. Please pick another time.' });
        }
      }
      updates.push('meeting_date=?'); values.push(nextDate);
      updates.push('time_slot=?'); values.push(nextSlot);
      updates.push('rescheduled_count=COALESCE(rescheduled_count,0)+1');
    }

    if (status !== undefined) {
      const allowed = staff ? ['scheduled', 'cancelled', 'completed'] : ['cancelled'];
      if (allowed.indexOf(String(status)) === -1) {
        return res.status(400).json({ error: 'You can cancel a consultation, or reschedule it.' });
      }
      updates.push('status=?'); values.push(status);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
    updates.push('updated_at=CURRENT_TIMESTAMP');

    values.push(req.params.id);
    await run(`UPDATE meetings SET ${updates.join(',')} WHERE id=?`, values);
    const fresh = await queryOne("SELECT * FROM meetings WHERE id = ?", [req.params.id]);

    // Tell them where it moved to, the same way the first booking told them.
    if ((movingDate || movingSlot) && fresh && fresh.user_email) {
      try {
        const dn = new Date(fresh.meeting_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        userEmail.emailMeetingScheduled(String(fresh.user_email).trim(), String(fresh.user_name || '').split(/\s+/)[0] || 'there', dn, fresh.time_slot || '');
      } catch (_) { /* the booking still moved */ }
      notifyAsync('MEETING_SCHEDULED', {
        name: fresh.user_name || '—', email: fresh.user_email || '—', mobile: fresh.user_phone || '—',
        date: fresh.meeting_date || '—', slot: fresh.time_slot || '—'
      });
      notifyAgent('MEETING_SCHEDULED', {
        name: fresh.user_name || '—', email: fresh.user_email || '—', mobile: fresh.user_phone || '—',
        date: fresh.meeting_date || '—', slot: fresh.time_slot || '—'
      });
    }
    res.json({ message: 'Updated', meeting: fresh });
  } catch (e) {
    console.error('[meetings] PUT error:', e.message);
    res.status(500).json({ error: 'Failed to update consultation' });
  }
});

// ============ TRIBE MEMBERS ============
app.get('/api/tribe', verifyToken, requireOperator, async (req, res) => {
  try {
    // Add recent daily-check-in context so admin can surface inactive/high-risk clients.
    // NOTE: tribe_members.email is joined to users.email for inactivity calculations.
    const rows = await queryAll(`
      SELECT
        tm.*,
        u.id AS user_id,
        u.profile_picture AS profile_picture,
        u.email AS user_email,
        u.created_at AS user_created_at,
        (SELECT MAX(dc.checkin_date)::text
           FROM daily_checkins dc
          WHERE dc.user_id = u.id
            AND COALESCE(dc.is_freeze, FALSE) = FALSE
        ) AS last_checkin_date
      FROM tribe_members tm
      INNER JOIN users u
        ON LOWER(u.email) = LOWER(tm.email)
       AND u.role = 'user'
       AND COALESCE(u.approval_status, 'approved') = 'approved'
       AND COALESCE(u.suspended, FALSE) = FALSE
      WHERE tm.status = 'active'
      ORDER BY tm.phase DESC, tm.start_date ASC
    `);

    const weekStart = scorecardSvc.normalizeWeekStart('');
    const prevWeek = scorecardSvc.previousWeekStart(weekStart);
    const enriched = await Promise.all((rows || []).map(async (r) => {
      const uid = r && r.user_id ? String(r.user_id) : '';
      if (!uid) {
        return {
          ...r,
          score_total: null,
          score_week_label: scorecardSvc.formatWeekRangeLabel(weekStart),
          score_trend_delta: null,
          score_pillars: null
        };
      }
      const current = await scorecardSvc.computeWeeklyScoreDedication(uid, weekStart);
      const previous = prevWeek ? await scorecardSvc.computeWeeklyScoreDedication(uid, prevWeek) : null;
      return {
        ...r,
        score_total: current ? current.total : null,
        score_week_label: current ? current.week_label : scorecardSvc.formatWeekRangeLabel(weekStart),
        score_trend_delta: current && previous ? (current.total - previous.total) : null,
        score_pillars: current ? {
          daily: current.daily,
          sunday: current.sunday,
          workouts: current.workouts,
          progress: current.progress
        } : null
      };
    }));

    res.json(enriched);
  } catch (e) {
    console.error('Tribe data error:', e.message);
    res.status(500).json({ error: 'Failed to load client performance board' });
  }
});

app.get('/api/tribe/:id', verifyToken, requireOperator, async (req, res) => {
  const row = await queryOne("SELECT * FROM tribe_members WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/tribe', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name) return res.status(400).json({ error: 'Name required' });

    const id = uuidv4();
    await run(`INSERT INTO tribe_members (id,first_name,last_name,email,phone,city,phase,start_date,activity_per_week,starting_weight,current_weight,target_weight,next_checkin,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.first_name, b.last_name||'', b.email||'', b.phone||'', b.city||'', b.phase||1, b.start_date||new Date().toISOString().split('T')[0], b.activity_per_week||0, b.starting_weight||null, b.current_weight||null, b.target_weight||null, b.next_checkin||'', b.notes||'']);
    res.json({ id, message: 'Member added' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

app.put('/api/tribe/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  const allowed = ['first_name','last_name','email','phone','city','phase','activity_per_week','starting_weight','current_weight','target_weight','next_checkin','notes','status'];
  const updates = [], values = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.includes(k)) { updates.push(`${k}=?`); values.push(v); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
  values.push(req.params.id);
  await run(`UPDATE tribe_members SET ${updates.join(',')} WHERE id=?`, values);
  res.json({ message: 'Updated' });
});

app.delete('/api/tribe/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  await run("DELETE FROM tribe_members WHERE id = ?", [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ============ USER PROFILE ============
app.get('/api/profile/:id', verifyToken, requireSelfOrStaff('id'), async (req, res) => {
  const user = await queryOne("SELECT id,email,first_name,last_name,phone,country,state_province,city,dob,gender,height_cm,goal_type,primary_training_days_per_week,diet_type,injury_limitations,stress_level_baseline,timezone,profile_picture,role,created_at FROM users WHERE id=?", [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.put('/api/profile/:id', verifyToken, requireSelfOrStaff('id', { staffRoles: ['admin', 'superadmin'] }), async (req, res) => {
  const {
    first_name,
    last_name,
    phone,
    email,
    profile_picture,
    country,
    timezone,
    state_province,
    city,
    dob,
    gender,
    height_cm,
    goal_type,
    primary_training_days_per_week,
    diet_type,
    injury_limitations,
    stress_level_baseline
  } = req.body || {};
  const updates = [], values = [];
  let heightUpdated = false;
  if (first_name !== undefined) { updates.push('first_name=?'); values.push(first_name); }
  if (last_name !== undefined) { updates.push('last_name=?'); values.push(last_name); }
  if (phone !== undefined) { updates.push('phone=?'); values.push(phone); }
  if (country !== undefined) { updates.push('country=?'); values.push(String(country || '').trim()); }
  if (state_province !== undefined) { updates.push('state_province=?'); values.push(String(state_province || '').trim().slice(0, 100)); }
  if (city !== undefined) { updates.push('city=?'); values.push(String(city || '').trim().slice(0, 100)); }
  if (dob !== undefined) { updates.push('dob=?'); values.push(dob && String(dob).trim() ? String(dob).trim().slice(0, 10) : null); }
  if (gender !== undefined) { updates.push('gender=?'); values.push(String(gender || '').trim().slice(0, 20)); }
  if (goal_type !== undefined) { updates.push('goal_type=?'); values.push(String(goal_type || '').trim().slice(0, 40)); }
  if (diet_type !== undefined) { updates.push('diet_type=?'); values.push(String(diet_type || '').trim().slice(0, 30)); }
  if (injury_limitations !== undefined) { updates.push('injury_limitations=?'); values.push(String(injury_limitations || '').trim().slice(0, 500)); }
  if (primary_training_days_per_week !== undefined) {
    if (primary_training_days_per_week === null || primary_training_days_per_week === '') {
      updates.push('primary_training_days_per_week=?');
      values.push(null);
    } else {
      const n = parseInt(primary_training_days_per_week, 10);
      if (!Number.isFinite(n) || n < 0 || n > 14) {
        return res.status(400).json({ error: 'Primary training days per week must be between 0 and 14' });
      }
      updates.push('primary_training_days_per_week=?');
      values.push(n);
    }
  }
  if (stress_level_baseline !== undefined) {
    if (stress_level_baseline === null || stress_level_baseline === '') {
      updates.push('stress_level_baseline=?');
      values.push(null);
    } else {
      const n = parseInt(stress_level_baseline, 10);
      if (!Number.isFinite(n) || n < 1 || n > 5) {
        return res.status(400).json({ error: 'Stress level baseline must be between 1 and 5' });
      }
      updates.push('stress_level_baseline=?');
      values.push(n);
    }
  }
  if (height_cm !== undefined) {
    if (height_cm === null || height_cm === '') {
      updates.push('height_cm=?');
      values.push(null);
      heightUpdated = true;
    } else {
      const h = parseInt(height_cm, 10);
      if (!Number.isFinite(h) || h < 100 || h > 230) {
        return res.status(400).json({ error: 'Height must be a whole number between 100 and 230 cm' });
      }
      updates.push('height_cm=?');
      values.push(h);
      heightUpdated = true;
    }
  }
  if (timezone !== undefined) {
    const tzValue = String(timezone || '').trim() || inferTimezoneFromCountry(country);
    updates.push('timezone=?');
    values.push(tzValue || '');
  }
  if (email !== undefined) {
    const emailNorm = String(email).trim().toLowerCase();
    const other = await queryOne("SELECT id FROM users WHERE LOWER(email) = ? AND id != ?", [emailNorm, req.params.id]);
    if (other) return res.status(409).json({ error: 'Email already in use' });
    updates.push('email=?');
    values.push(emailNorm);
  }
  if (profile_picture !== undefined) {
    const profilePictureError = validateProfilePicture(profile_picture);
    if (profilePictureError) return res.status(400).json({ error: profilePictureError });
    updates.push('profile_picture=?');
    values.push(String(profile_picture || '').trim());
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  try {
    await run(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);
    if (heightUpdated) {
      const tzRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [req.params.id]);
      const uTz = (tzRow && tzRow.timezone) ? tzRow.timezone : STREAK_TIMEZONE;
      const today = streakTodayYmdInTz(uTz) || streakDateToYmd(new Date());
      await safeRecomputeNutritionForDate(req.params.id, today);
    }
    res.json({ message: 'Profile updated' });
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ============ WORKOUT LOGS ============
app.post('/api/workouts', verifyToken, async (req, res) => {
  try {
    const { workout_name, duration_seconds, feedback } = req.body || {};
    // The workout is always attributed to the authenticated caller. A user_id in the
    // body used to be trusted, which let anyone write workout rows into any account
    // (and burn that account's AI-trainer trial quota).
    const user_id = req.user.id;
    if (!workout_name) return res.status(400).json({ error: 'Workout name required' });
    // Mirror the AI Trainer trial cap from /api/workouts/session — this endpoint is the legacy fallback for the same UI.
    const legacyTrainerAccess = await queryOne(
      `SELECT COALESCE(ai_trainer_unlimited, TRUE) AS unlimited,
              COALESCE(ai_trainer_trial_limit, 0)::int AS lim,
              COALESCE(ai_trainer_trial_used, 0)::int AS used
         FROM users WHERE id = ?`,
      [user_id]
    );
    if (legacyTrainerAccess && !legacyTrainerAccess.unlimited && legacyTrainerAccess.used >= legacyTrainerAccess.lim) {
      return res.status(403).json({
        error: 'limit_reached',
        feature: 'ai_trainer',
        used: legacyTrainerAccess.used,
        limit: legacyTrainerAccess.lim,
        message: "You've reached your AI Trainer trial limit. Please contact admin to continue."
      });
    }
    const id = uuidv4();
    await run("INSERT INTO workout_logs (id,user_id,workout_name,duration_seconds,feedback) VALUES (?,?,?,?,?)",
      [id, user_id, workout_name, duration_seconds || 0, feedback || '']);
    if (legacyTrainerAccess && !legacyTrainerAccess.unlimited) {
      await run('UPDATE users SET ai_trainer_trial_used = COALESCE(ai_trainer_trial_used, 0) + 1, ai_trainer_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [user_id]);
    } else {
      await run('UPDATE users SET ai_trainer_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [user_id]);
    }
    await safeRecomputeNutritionForDate(String(user_id), new Date().toISOString().slice(0, 10));
    const wu = await queryOne('SELECT email, first_name, phone FROM users WHERE id = ?', [user_id]);
    if (wu && wu.email) {
      userEmail.emailWorkoutLogged(wu.email, wu.first_name, workout_name, duration_seconds != null ? Math.round(duration_seconds / 60) : null);
    }
    const ymd = new Date().toISOString().slice(0, 10);
    await safeApplyCoinPenaltiesForUser(String(user_id));
    await safeAwardCoins(
      String(user_id),
      'workout_session',
      `coins:workout_session:${String(user_id)}:${ymd}`,
      coinService.COIN_RULES.WORKOUT_SESSION,
      { source: 'workouts_legacy', workoutName: workout_name },
      ymd
    );
    notifyAsync('WORKOUT_LOGGED', { name: wu ? `${wu.first_name || ''}`.trim() : user_id, email: wu ? wu.email : user_id, mobile: wu ? wu.phone : '—', type: workout_name, duration: duration_seconds != null ? Math.round(duration_seconds / 60) + ' min' : '—' });
    notifyAgent('WORKOUT_LOGGED', { name: wu ? `${wu.first_name || ''}`.trim() : user_id, email: wu ? wu.email : user_id, mobile: wu ? wu.phone : '—', type: workout_name, duration: duration_seconds != null ? Math.round(duration_seconds / 60) + ' min' : '—' });
    res.json({ id, message: 'Workout logged' });
  } catch (e) {
    console.error('Workout error:', e.message);
    res.status(500).json({ error: 'Failed to log workout' });
  }
});

/** Full workout session (My Workout redesign) — authenticated user, extended columns + progress_logs when body metrics present */
app.post('/api/workouts/session', verifyToken, rateLimiter(30, 60000), async (req, res) => {
  try {
    const userId = req.user.id;
    const b = req.body || {};
    const date = String(b.date || '').trim().slice(0, 10);
    const workoutType = String(b.workout_type || '').trim();
    if (!date || !workoutType) return res.status(400).json({ error: 'Date and workout type are required' });
    // Admin-controlled AI Trainer trial cap. Unlimited users skip; trial users are blocked once `used >= limit`.
    const aiTrainerAccess = await queryOne(
      `SELECT COALESCE(ai_trainer_unlimited, TRUE) AS unlimited,
              COALESCE(ai_trainer_trial_limit, 0)::int AS lim,
              COALESCE(ai_trainer_trial_used, 0)::int AS used
         FROM users WHERE id = ?`,
      [userId]
    );
    if (aiTrainerAccess && !aiTrainerAccess.unlimited && aiTrainerAccess.used >= aiTrainerAccess.lim) {
      return res.status(403).json({
        error: 'limit_reached',
        feature: 'ai_trainer',
        used: aiTrainerAccess.used,
        limit: aiTrainerAccess.lim,
        message: "You've reached your AI Trainer trial limit. Please contact admin to continue."
      });
    }
    const id = uuidv4();
    const dur = parseInt(b.duration_seconds, 10);
    const notes = String(b.notes || '').trim().slice(0, 5000);
    // Body/nutrition fields are owned by Daily/Sunday check-ins, not My Workout.
    const waterLiters = null;
    const sleepH = null;
    const sl = workoutSessionLifts.parseSessionLifts(b);
    const canon = workoutSessionLifts.canonicalLiftsFromSessionLifts(sl);
    const legacyBench = b.bench_kg != null && b.bench_kg !== '' ? parseFloat(b.bench_kg) : null;
    const legacySquat = b.squat_kg != null && b.squat_kg !== '' ? parseFloat(b.squat_kg) : null;
    const legacyDl = b.deadlift_kg != null && b.deadlift_kg !== '' ? parseFloat(b.deadlift_kg) : null;
    const benchKg = canon.bench_kg != null ? canon.bench_kg : legacyBench;
    const squatKg = canon.squat_kg != null ? canon.squat_kg : legacySquat;
    const deadliftKg = canon.deadlift_kg != null ? canon.deadlift_kg : legacyDl;
    const sessionLiftsForDb = workoutSessionLifts.hasAnySessionLift(sl) ? sl : null;
    const srp = workoutSessionLifts.parseSessionReps(b);
    const sessionRepsForDb = (srp && Object.keys(srp).length) ? srp : null;
    await run(
      `INSERT INTO workout_logs (
        id, user_id, workout_name, duration_seconds, feedback,
        session_date, workout_type, session_lifts, session_reps, bench_kg, squat_kg, deadlift_kg,
        weight_kg, body_fat_percent, calories, protein_g, water_liters, sleep_hrs,
        workout_completed, intensity, energy_level
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        userId,
        workoutType,
        Number.isFinite(dur) ? dur : 0,
        notes,
        date,
        workoutType,
        sessionLiftsForDb,
        sessionRepsForDb,
        benchKg,
        squatKg,
        deadliftKg,
        null,
        null,
        null,
        null,
        null,
        null,
        !!b.workout_completed,
        b.intensity ? String(b.intensity).slice(0, 40) : null,
        b.energy_level ? String(b.energy_level).slice(0, 40) : null
      ]
    );
    if (aiTrainerAccess && !aiTrainerAccess.unlimited) {
      await run('UPDATE users SET ai_trainer_trial_used = COALESCE(ai_trainer_trial_used, 0) + 1, ai_trainer_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    } else {
      await run('UPDATE users SET ai_trainer_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    }
    await safeRecomputeNutritionForDate(userId, date);
    // Workout session: structured lifts + session completion sync to progress_logs (canonical bench/squat/dead map from session_lifts when present).
    const hasProgress =
      workoutSessionLifts.hasAnySessionLift(sl) ||
      [legacyBench, legacySquat, legacyDl].some((v) => v != null && v !== '' && !Number.isNaN(v)) ||
      !!b.workout_completed;
    if (hasProgress) {
      await progressService.insertProgress(userId, {
        log_date: date,
        weight: null,
        body_fat: null,
        calories_intake: null,
        protein_intake: null,
        workout_completed: !!b.workout_completed,
        workout_type: workoutType,
        strength_bench: benchKg,
        strength_squat: squatKg,
        strength_deadlift: deadliftKg,
        sleep_hours: null,
        water_intake: null
      });
    }
    const wu = await queryOne('SELECT email, first_name, phone FROM users WHERE id = ?', [userId]);
    if (wu && wu.email) {
      userEmail.emailWorkoutLogged(
        wu.email,
        wu.first_name,
        workoutType,
        Number.isFinite(dur) ? Math.round(dur / 60) : null
      );
    }
    await safeApplyCoinPenaltiesForUser(userId);
    await safeAwardCoins(
      userId,
      'workout_session',
      `coins:workout_session:${userId}:${date}`,
      coinService.COIN_RULES.WORKOUT_SESSION,
      { source: 'workouts_session', workoutType },
      date
    );
    if (wu) {
      notifyAsync('WORKOUT_LOGGED', { name: `${wu.first_name || ''}`.trim(), email: wu.email, mobile: wu.phone || '—', type: workoutType, duration: Number.isFinite(dur) ? Math.round(dur / 60) + ' min' : '—' });
      notifyAgent('WORKOUT_LOGGED', { name: `${wu.first_name || ''}`.trim(), email: wu.email, mobile: wu.phone || '—', type: workoutType, duration: Number.isFinite(dur) ? Math.round(dur / 60) + ' min' : '—' });
    }
    res.json({ id, message: 'Session saved' });
  } catch (e) {
    console.error('Workout session error:', e.message);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// Admin: get all workouts (must be before :userId to avoid conflict)
app.get('/api/workouts', verifyToken, requireOperator, async (req, res) => {
  const rows = await queryAll(`SELECT w.*, u.first_name, u.last_name, u.email 
    FROM workout_logs w JOIN users u ON w.user_id = u.id 
    ORDER BY w.created_at DESC LIMIT 100`);
  res.json(rows);
});

app.get('/api/workouts/:userId', verifyToken, requireSelfOrStaff('userId'), async (req, res) => {
  const rows = await queryAll("SELECT * FROM workout_logs WHERE user_id=? ORDER BY created_at DESC", [req.params.userId]);
  res.json(rows);
});

// ============ CONTACT MESSAGES ============
app.post('/api/contact', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { user_id, name, phone, email, message } = req.body || {};
    if (!name || !message) return res.status(400).json({ error: 'Name and message required' });
    const id = uuidv4();
    await run("INSERT INTO contact_messages (id,user_id,name,phone,email,message) VALUES (?,?,?,?,?,?)",
      [id, user_id || null, name, phone || '', email || '', message]);
    sendPushToAdmins(JSON.stringify({ title: 'New contact message', body: `${name || 'Someone'}: ${String(message || '').slice(0, 80)}`, id: 'message-' + id })).catch(() => {});
    if (email && String(email).includes('@')) userEmail.emailContactReceived(String(email).trim(), name);
    notifyAsync('CONTACT_MESSAGE', { name, email: email || '—', phone: phone || '—', message });
    notifyAgent('CONTACT_MESSAGE', { name, email: email || '—', phone: phone || '—', message: String(message || '').slice(0, 180) });
    res.json({ id, message: 'Message sent' });
  } catch (e) {
    console.error('Contact error:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/api/contact', verifyToken, requireOperator, async (req, res) => {
  const rows = await queryAll("SELECT * FROM contact_messages ORDER BY created_at DESC");
  res.json(rows);
});

// ============ MESSAGE THREADS (2-way user ↔ admin) ============
// All messages are persisted in DB: message_threads (one per user) and thread_messages (every message).
// No in-memory or alternate storage — create/read/send all use the database.
// One chat per user (no subject). User: single thread or none. Admin: one row per user, new users below.
app.get('/api/threads', verifyToken, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    let rows;
    if (isAdmin) {
      rows = await queryAll(
        `SELECT * FROM (
          SELECT DISTINCT ON (t.user_id) t.id, t.user_id, t.subject, t.created_at, t.updated_at,
            u.first_name, u.last_name, u.email, u.profile_picture,
            (SELECT body FROM thread_messages WHERE thread_id = t.id AND sender_role = 'user' ORDER BY created_at DESC LIMIT 1) AS last_message
          FROM message_threads t
          LEFT JOIN users u ON u.id = t.user_id
          ORDER BY t.user_id, t.updated_at DESC
        ) sub
        ORDER BY created_at ASC`
      );
    } else {
      rows = await queryAll(
        `SELECT t.id, t.user_id, t.subject, t.created_at, t.updated_at,
         (SELECT body FROM thread_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message
         FROM message_threads t
         WHERE t.user_id = ?
         ORDER BY t.updated_at DESC
         LIMIT 1`,
        [req.user.id]
      );
    }
    res.json(rows);
  } catch (e) {
    console.error('Threads list error:', e.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// Get-or-create single thread for user (no subject). Optional first_message.
app.post('/api/threads', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only users can start conversations' });
    const { first_message } = req.body || {};
    let thread = await queryOne('SELECT id, user_id, subject, created_at, updated_at FROM message_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [req.user.id]);
    if (thread) {
      if (first_message && String(first_message).trim()) {
        const msgId = uuidv4();
        await run(
          'INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
          [msgId, thread.id, req.user.id, 'user', String(first_message).trim().slice(0, 5000)]
        );
        await run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [thread.id]);
        thread = await queryOne('SELECT id, user_id, subject, created_at, updated_at FROM message_threads WHERE id = ?', [thread.id]);
      }
      return res.json(thread);
    }
    const threadId = uuidv4();
    await run(
      'INSERT INTO message_threads (id, user_id, subject) VALUES (?, ?, ?)',
      [threadId, req.user.id, '']
    );
    if (first_message && String(first_message).trim()) {
      const msgId = uuidv4();
      await run(
        'INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
        [msgId, threadId, req.user.id, 'user', String(first_message).trim().slice(0, 5000)]
      );
      await run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);
    }
    thread = await queryOne('SELECT id, user_id, subject, created_at, updated_at FROM message_threads WHERE id = ?', [threadId]);
    res.status(201).json(thread);
  } catch (e) {
    console.error('Create thread error:', e.message);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get one thread (user: own only, admin: any)
app.get('/api/threads/:id', verifyToken, async (req, res) => {
  try {
    const thread = await queryOne('SELECT * FROM message_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (!isAdmin && thread.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (isAdmin) {
      const user = await queryOne('SELECT id, first_name, last_name, email, profile_picture FROM users WHERE id = ?', [thread.user_id]);
      thread.user = user || null;
    }
    res.json(thread);
  } catch (e) {
    console.error('Get thread error:', e.message);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// Get messages in thread
app.get('/api/threads/:id/messages', verifyToken, async (req, res) => {
  try {
    const thread = await queryOne('SELECT * FROM message_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (!isAdmin && thread.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const rows = await queryAll(
      'SELECT id, thread_id, sender_id, sender_role, body, created_at FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('Get messages error:', e.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Send message in thread
app.post('/api/threads/:id/messages', verifyToken, rateLimiter(30, 60000), async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body required' });
    const thread = await queryOne('SELECT * FROM message_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (!isAdmin && thread.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const senderRole = isAdmin ? 'admin' : 'user';
    const msgId = uuidv4();
    await run(
      'INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
      [msgId, req.params.id, req.user.id, senderRole, String(body).trim().slice(0, 5000)]
    );
    await run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    const msg = await queryOne('SELECT id, thread_id, sender_id, sender_role, body, created_at FROM thread_messages WHERE id = ?', [msgId]);
    if (isAdmin && thread.user_id) {
      sendPushToUser(thread.user_id, JSON.stringify({ type: 'coach_reply', title: '💬 Your Lifestyle Manager replied', body: String(body).trim().slice(0, 100), id: 'chat-' + msgId })).catch(() => {});
      const coachUser = await queryOne('SELECT email, first_name FROM users WHERE id = ?', [thread.user_id]);
      if (coachUser && coachUser.email) {
        userEmail.emailCoachReply(coachUser.email, coachUser.first_name, String(body).trim());
      }
    }
    if (!isAdmin) {
      const u = await queryOne('SELECT first_name, last_name, email FROM users WHERE id = ?', [thread.user_id]);
      const userName = u ? [(u.first_name || '').trim(), (u.last_name || '').trim()].filter(Boolean).join(' ') || u.email : 'A client';
      sendPushToAdmins(JSON.stringify({ title: 'New message', body: `${userName}: ${String(body).trim().slice(0, 80)}`, id: 'chat-' + msgId })).catch(() => {});
    }
    res.status(201).json(msg);
  } catch (e) {
    console.error('Send message error:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============ SUNDAY CHECK-IN (User submit) ============
function parseSundayBodyFatPercent(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (n < 2 || n > 70) return null;
  return Math.round(n * 100) / 100;
}

app.post('/api/sunday-checkin', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    // Identity comes from the session, never the body.
    //
    // This route used to be unauthenticated and take both `user_id` and
    // `reply_email` from the request. That let anyone file a check-in against any
    // member's account (awarding them coins and polluting their history), and — worse
    // — send a "check-in received" email to any address they chose, turning the
    // service's SMTP credentials into an open relay.
    b.user_id = req.user.id;
    const nu = await queryOne(
      'SELECT first_name, last_name, email FROM users WHERE id = ?',
      [req.user.id]
    ).catch(() => null);
    if (!nu) return res.status(401).json({ error: 'Authentication required' });
    if (!b.full_name) {
      b.full_name = `${nu.first_name || ''} ${nu.last_name || ''}`.trim()
        || String(nu.email || '').split('@')[0];
    }
    // The confirmation only ever goes to the account's own address.
    b.reply_email = nu.email || '';
    if (!b.full_name) return res.status(400).json({ error: 'Full name is required' });
    const bodyFatPct = parseSundayBodyFatPercent(b.body_fat_percent);
    const id = uuidv4();
    await run(`INSERT INTO sunday_checkins (id, user_id, full_name, reply_email, plan, current_weight_waist_week, last_week_weight_waist, total_weight_loss, training_go, nutrition_go, sleep, occupation_stress, other_stress, differences_felt, achievements, improve_next_week, questions, body_fat_percent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.user_id || null, b.full_name || '', b.reply_email || '', b.plan || '', b.current_weight_waist_week || '', b.last_week_weight_waist || '', b.total_weight_loss || '', b.training_go || '', b.nutrition_go || '', b.sleep || '', b.occupation_stress || '', b.other_stress || '', b.differences_felt || '', b.achievements || '', b.improve_next_week || '', b.questions || '', bodyFatPct]);
    if (b.reply_email && String(b.reply_email).trim().includes('@')) {
      userEmail.emailSundayCheckinReceived(String(b.reply_email).trim(), (b.full_name || 'there').split(/\s+/)[0]);
    } else if (b.user_id) {
      const su = await queryOne('SELECT email, first_name FROM users WHERE id = ?', [b.user_id]);
      if (su && su.email) userEmail.emailSundayCheckinReceived(su.email, su.first_name);
    }
    if (b.user_id) {
      const ymd = streakTodayYmdInTz(STREAK_TIMEZONE) || streakDateToYmd(new Date());
      const weekKey = coinService.isoWeekKey(ymd);
      await safeApplyCoinPenaltiesForUser(String(b.user_id));
      await safeAwardCoins(
        String(b.user_id),
        'sunday_checkin',
        `coins:sunday_checkin:${String(b.user_id)}:${weekKey}`,
        coinService.COIN_RULES.SUNDAY_CHECKIN,
        { checkinId: id, weekKey },
        ymd
      );
    }
    notifyAsync('SUNDAY_CHECKIN', {
      name: b.full_name || '—',
      email: b.reply_email || '—',
      user_id: b.user_id || '—',
      plan: b.plan || '—',
      current_weight_waist_week: b.current_weight_waist_week || '—',
      last_week_weight_waist: b.last_week_weight_waist || '—',
      total_weight_loss: b.total_weight_loss || '—',
      training_go: b.training_go || '—',
      nutrition_go: b.nutrition_go || '—',
      sleep: b.sleep || '—',
      occupation_stress: b.occupation_stress || '—',
      other_stress: b.other_stress || '—',
      differences_felt: b.differences_felt || '—',
      achievements: b.achievements || '—',
      improve_next_week: b.improve_next_week || '—',
      questions: b.questions || '—',
      body_fat_percent: bodyFatPct != null ? bodyFatPct : '—'
    });
    notifyAgent('SUNDAY_CHECKIN', {
      name: b.full_name || '—',
      email: b.reply_email || '—',
      user_id: b.user_id || '—',
      plan: b.plan || '—',
      current_weight_waist_week: b.current_weight_waist_week || '—',
      last_week_weight_waist: b.last_week_weight_waist || '—',
      total_weight_loss: b.total_weight_loss || '—',
      training_go: b.training_go || '—',
      nutrition_go: b.nutrition_go || '—',
      sleep: b.sleep || '—',
      occupation_stress: b.occupation_stress || '—',
      other_stress: b.other_stress || '—',
      differences_felt: b.differences_felt || '—',
      achievements: b.achievements || '—',
      improve_next_week: b.improve_next_week || '—',
      questions: b.questions || '—',
      body_fat_percent: bodyFatPct != null ? bodyFatPct : '—'
    });
    res.json({ id, message: 'Sunday check-in submitted successfully' });
  } catch (e) {
    console.error('Sunday check-in error:', e.message);
    res.status(500).json({ error: 'Failed to submit check-in' });
  }
});

app.get('/api/sunday-checkin', verifyToken, requireOperator, async (req, res) => {
  const rows = await queryAll("SELECT id, full_name, reply_email, created_at FROM sunday_checkins ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/sunday-checkin/last-weight/:userId', verifyToken, requireSelfOrStaff('userId'), async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) return res.status(400).json({ error: 'Missing user id' });
    const rows = await queryAll(
      'SELECT current_weight_waist_week, body_fat_percent FROM sunday_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    if (!rows.length) return res.json({ last_week_weight_waist: '', last_body_fat_percent: null });
    const value = (rows[0].current_weight_waist_week || '').trim();
    const bf = rows[0].body_fat_percent;
    res.json({
      last_week_weight_waist: value,
      last_body_fat_percent: bf != null && bf !== '' ? Number(bf) : null
    });
  } catch (e) {
    console.error('Failed to get last sunday weight', e.message);
    res.status(500).json({ error: 'Failed to load last week weight' });
  }
});

app.get('/api/sunday-checkin/:id', verifyToken, async (req, res) => {
  const row = await queryOne("SELECT * FROM sunday_checkins WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // The check-in id is not the caller's id, so ownership is checked on the row.
  // 404 rather than 403 so the endpoint does not confirm that an id exists.
  const isStaff = ['admin', 'superadmin', 'operator'].includes(req.user.role);
  if (!isStaff && String(row.user_id || '') !== String(req.user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(row);
});

// ============ DAILY CHECK-IN (micro-goals: steps, water, protein, sleep) ============
// DB stores water_ml; API accepts water_liters (preferred) or legacy water_ml; responses include water_liters.

// ---- What a real day looks like --------------------------------------------
// Every figure here is typed by hand on a phone, and until these bounds existed
// a slipped digit was stored and then averaged, charted and scored like fact:
// 6851 hours of sleep, a million steps, kilograms of protein. Each ceiling is
// deliberately far past any real athlete, so the only values it turns away are
// mistakes. Out-of-range input is REJECTED, never silently dropped — a member
// who typed something has to be told it did not land.
const DAILY_CHECKIN_LIMITS = {
  steps:       { label: 'Steps',   min: 0, max: 100000, unit: '',     integer: true },
  water_l:     { label: 'Water',   min: 0, max: 15,     unit: ' L' },
  protein_g:   { label: 'Protein', min: 0, max: 500,    unit: ' g',   integer: true },
  sleep_hours: { label: 'Sleep',   min: 0, max: 24,     unit: ' hrs' }   // there are 24 in a day
};

/**
 * One field, held to its bound. Blank stays blank — these are all optional —
 * but anything present must be a real number inside the range.
 * @returns {{ok:true,value:(number|null)}|{ok:false,error:string}}
 */
function readDailyCheckinField(raw, key) {
  const lim = DAILY_CHECKIN_LIMITS[key];
  if (raw == null || raw === '') return { ok: true, value: null };
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return { ok: false, error: `${lim.label} must be a number.` };
  if (n < lim.min || n > lim.max) {
    return { ok: false, error: `${lim.label} must be between ${lim.min}${lim.unit} and ${lim.max}${lim.unit}.` };
  }
  return { ok: true, value: lim.integer ? Math.round(n) : n };
}

/**
 * The whole check-in body, validated as one. Water is the only derived field:
 * the API speaks litres (older clients send millilitres) and the column stores
 * millilitres.
 * @returns {{error:string}|{steps,water_ml,protein_g,sleep_hours,filled}}
 */
function validateDailyCheckinBody(body) {
  const b = body || {};
  let waterRaw = b.water_liters;
  if ((waterRaw == null || waterRaw === '') && b.water_ml != null && b.water_ml !== '') {
    const ml = Number(String(b.water_ml).replace(/,/g, '').trim());
    if (!Number.isFinite(ml)) return { error: 'Water must be a number.' };
    waterRaw = ml / 1000;
  }
  const water   = readDailyCheckinField(waterRaw,     'water_l');
  if (!water.ok) return { error: water.error };
  const steps   = readDailyCheckinField(b.steps,       'steps');
  if (!steps.ok) return { error: steps.error };
  const protein = readDailyCheckinField(b.protein_g,   'protein_g');
  if (!protein.ok) return { error: protein.error };
  const sleep   = readDailyCheckinField(b.sleep_hours, 'sleep_hours');
  if (!sleep.ok) return { error: sleep.error };

  const out = {
    steps: steps.value,
    water_ml: water.value == null ? null : Math.round(water.value * 1000),
    protein_g: protein.value,
    sleep_hours: sleep.value
  };
  out.filled = [out.steps, out.water_ml, out.protein_g, out.sleep_hours].some(v => v != null);
  return out;
}
function attachWaterLitersToDailyRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (out.water_ml != null && out.water_ml !== '') {
    out.water_liters = Math.round((Number(out.water_ml) / 1000) * 1000) / 1000;
  } else {
    out.water_liters = null;
  }
  return out;
}

async function safeRecomputeNutritionForDate(userId, ymd) {
  try {
    if (!userId || !ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return;
    await recomputeNutritionDailyStats({ run, queryOne, queryAll }, String(userId), String(ymd));
  } catch (e) {
    console.warn('[nutrition recompute sync]', e.message);
  }
}

async function safeAwardCoins(userId, eventType, eventKey, coinsDelta, meta, createdAtYmd) {
  try {
    if (!userId || !eventType || !eventKey) return;
    await coinService.awardCoins(
      { run, queryOne, queryAll },
      { userId: String(userId), eventType, eventKey, coinsDelta, meta: meta || {}, createdAtYmd }
    );
  } catch (e) {
    console.warn('[coins award]', e.message);
  }
}

/**
 * Advance any referral this member is the *referee* of. Idempotent and never
 * throws, so it is safe to fire on every check-in; the coin ledger's unique
 * event_key is what actually guarantees the referrer is paid exactly once.
 */
async function safeCheckReferralQualification(userId) {
  try {
    if (!userId) return;
    await referralService.checkQualification({ run, queryOne, queryAll }, String(userId));
  } catch (e) {
    console.warn('[referral qualification]', e.message);
  }
}

async function safeApplyCoinPenaltiesForUser(userId) {
  try {
    if (!userId) return;
    const today = streakTodayYmdInTz(STREAK_TIMEZONE) || streakDateToYmd(new Date());
    await coinService.applyMissedDailyPenaltiesForUser({ run, queryOne, queryAll }, String(userId), today);
  } catch (e) {
    console.warn('[coins penalty]', e.message);
  }
}

// User can fill only once per day for streak
app.post('/api/daily-checkin', verifyToken, rateLimiter(20, 60000), async (req, res) => {
  try {
    const userId = req.user.id;
    const b = req.body || {};
    const checkin = validateDailyCheckinBody(b);
    if (checkin.error) return res.status(400).json({ error: checkin.error });
    const { steps, protein_g, sleep_hours } = checkin;
    const waterMl = checkin.water_ml;
    const _userTzRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [userId]).catch(() => null);
    const _userTz = (_userTzRow && _userTzRow.timezone) ? _userTzRow.timezone : STREAK_TIMEZONE;
    const today = streakTodayYmdInTz(_userTz) || streakDateToYmd(new Date());
    const existing = await queryOne('SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]);
    if (existing) {
      return res.status(400).json({ error: 'You can only fill the daily check-in once per day.' });
    }
    const id = uuidv4();
    await run(
      `INSERT INTO daily_checkins (id, user_id, checkin_date, steps, water_ml, protein_g, sleep_hours)
       VALUES (?, ?, ?::date, ?, ?, ?, ?)`,
      [id, userId, today, steps != null ? steps : null, waterMl, protein_g != null ? protein_g : null, sleep_hours != null ? sleep_hours : null]
    );
    await safeRecomputeNutritionForDate(userId, today);
    const row = await queryOne('SELECT * FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]);
    const du = await queryOne('SELECT email, first_name, phone FROM users WHERE id = ?', [userId]);
    if (du && du.email) {
      const lines = [];
      if (steps != null) lines.push(`Steps: ${steps}`);
      if (waterMl != null) lines.push(`Water: ${(waterMl / 1000).toFixed(waterMl % 1000 === 0 ? 1 : 2)} L`);
      if (protein_g != null) lines.push(`Protein: ${protein_g} g`);
      if (sleep_hours != null) lines.push(`Sleep: ${sleep_hours} hrs`);
      userEmail.emailDailyCheckinReceived(du.email, du.first_name, lines);
    }
    await safeApplyCoinPenaltiesForUser(userId);
    await safeAwardCoins(
      userId,
      'daily_checkin',
      `coins:daily_checkin:${userId}:${today}`,
      coinService.COIN_RULES.DAILY_CHECKIN,
      { checkinDate: today },
      today
    );
    // A daily check-in is the qualifying event for whoever referred this member.
    await safeCheckReferralQualification(userId);
    if (waterMl != null && waterMl >= 2000) {
      await safeAwardCoins(
        userId,
        'daily_goal_water',
        `coins:daily_goal_water:${userId}:${today}`,
        3,
        { waterMl, targetMl: 2000 },
        today
      );
    }
    if (protein_g != null && Number(protein_g) >= 100) {
      await safeAwardCoins(
        userId,
        'daily_goal_protein',
        `coins:daily_goal_protein:${userId}:${today}`,
        3,
        { proteinG: Number(protein_g), targetG: 100 },
        today
      );
    }
    if (sleep_hours != null && Number(sleep_hours) >= 7) {
      await safeAwardCoins(
        userId,
        'daily_goal_sleep',
        `coins:daily_goal_sleep:${userId}:${today}`,
        3,
        { sleepHours: Number(sleep_hours), targetHours: 7 },
        today
      );
    }
    const dcUser = await queryOne('SELECT first_name, last_name, email, phone FROM users WHERE id = ?', [userId]).catch(() => null);
    notifyAsync('DAILY_CHECKIN', {
      name    : dcUser ? `${dcUser.first_name || ''} ${dcUser.last_name || ''}`.trim() : userId,
      email   : dcUser ? dcUser.email : userId,
      mobile  : dcUser ? (dcUser.phone || '—') : '—',
      steps   : steps != null ? steps : '—',
      water   : waterMl != null ? (waterMl / 1000).toFixed(2) + ' L' : '—',
      protein : protein_g != null ? protein_g + ' g' : '—',
      sleep   : sleep_hours != null ? sleep_hours + ' hrs' : '—'
    });
    notifyAgent('DAILY_CHECKIN', {
      name    : dcUser ? `${dcUser.first_name || ''} ${dcUser.last_name || ''}`.trim() : userId,
      email   : dcUser ? dcUser.email : userId,
      mobile  : dcUser ? (dcUser.phone || '—') : '—',
      steps   : steps != null ? steps : '—',
      water   : waterMl != null ? (waterMl / 1000).toFixed(2) + ' L' : '—',
      protein : protein_g != null ? protein_g + ' g' : '—',
      sleep   : sleep_hours != null ? sleep_hours + ' hrs' : '—'
    });
    res.json(attachWaterLitersToDailyRow(row) || attachWaterLitersToDailyRow({ id, user_id: userId, checkin_date: today, steps, water_ml: waterMl, protein_g, sleep_hours }));
  } catch (e) {
    console.error('Daily check-in error:', e.message);
    res.status(500).json({ error: 'Failed to save check-in' });
  }
});

// Correcting today's entry. Deliberately today ONLY: the date is taken from the
// server's idea of the member's today and never from the request, so there is no
// past or future day a caller could reach. A check-in is filled in seconds on a
// phone and used to be write-once, which made every typo permanent.
app.put('/api/daily-checkin/today', verifyToken, rateLimiter(30, 60000), async (req, res) => {
  try {
    const userId = req.user.id;
    const checkin = validateDailyCheckinBody(req.body || {});
    if (checkin.error) return res.status(400).json({ error: checkin.error });
    if (!checkin.filled) return res.status(400).json({ error: 'Enter at least one value before saving.' });

    const tzRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [userId]).catch(() => null);
    const tz = (tzRow && tzRow.timezone) ? tzRow.timezone : STREAK_TIMEZONE;
    const today = streakTodayYmdInTz(tz) || streakDateToYmd(new Date());

    const existing = await queryOne(
      `SELECT id, COALESCE(is_freeze, FALSE) AS is_freeze FROM daily_checkins
        WHERE user_id = ? AND checkin_date = ?::date`, [userId, today]);
    if (!existing) return res.status(404).json({ error: 'No check-in saved today yet.' });
    // A freeze row is a marker that the day was excused, not a day of data.
    if (existing.is_freeze) return res.status(400).json({ error: 'Today is covered by a streak freeze, so there is nothing to edit.' });

    await run(
      `UPDATE daily_checkins
          SET steps = ?, water_ml = ?, protein_g = ?, sleep_hours = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND checkin_date = ?::date`,
      [checkin.steps, checkin.water_ml, checkin.protein_g, checkin.sleep_hours, userId, today]
    );
    await safeRecomputeNutritionForDate(userId, today);

    // Goal coins are keyed per member per day, so replaying them lets a corrected
    // figure earn what it should have earned the first time. An edit downwards
    // cannot take a coin back: the ledger is append-only by design.
    if (checkin.water_ml != null && checkin.water_ml >= 2000) {
      await safeAwardCoins(userId, 'daily_goal_water', `coins:daily_goal_water:${userId}:${today}`, 3,
        { waterMl: checkin.water_ml, targetMl: 2000 }, today);
    }
    if (checkin.protein_g != null && Number(checkin.protein_g) >= 100) {
      await safeAwardCoins(userId, 'daily_goal_protein', `coins:daily_goal_protein:${userId}:${today}`, 3,
        { proteinG: Number(checkin.protein_g), targetG: 100 }, today);
    }
    if (checkin.sleep_hours != null && Number(checkin.sleep_hours) >= 7) {
      await safeAwardCoins(userId, 'daily_goal_sleep', `coins:daily_goal_sleep:${userId}:${today}`, 3,
        { sleepHours: Number(checkin.sleep_hours), targetHours: 7 }, today);
    }

    const row = await queryOne('SELECT * FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]);
    res.json(attachWaterLitersToDailyRow(row));
  } catch (e) {
    console.error('Daily check-in edit error:', e.message);
    res.status(500).json({ error: 'Failed to update check-in' });
  }
});

app.get('/api/daily-checkin/today', verifyToken, async (req, res) => {
  try {
    const _utzRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [req.user.id]).catch(() => null);
    const _utz = (_utzRow && _utzRow.timezone) ? _utzRow.timezone : STREAK_TIMEZONE;
    const today = streakTodayYmdInTz(_utz) || streakDateToYmd(new Date());
    const row = await queryOne('SELECT * FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [req.user.id, today]);
    res.json(row ? attachWaterLitersToDailyRow(row) : { checkin_date: today, water_liters: null });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load check-in' });
  }
});

// The form draws its own min/max from this, so the two can never disagree.
app.get('/api/daily-checkin/limits', verifyToken, (req, res) => res.json(DAILY_CHECKIN_LIMITS));

app.get('/api/daily-checkin/streak', verifyToken, async (req, res) => {
  try {
    const _uRow = await queryOne('SELECT created_at, timezone FROM users WHERE id = ?', [req.user.id]);
    const _uTz = (_uRow && _uRow.timezone) ? _uRow.timezone : STREAK_TIMEZONE;
    const rows = await queryAll(
      `SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, COALESCE(is_freeze, FALSE) AS is_freeze FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365`,
      [req.user.id]
    );
    if (!rows || rows.length === 0) {
      const today = streakTodayYmdInTz(_uTz) || streakDateToYmd(new Date());
      const createdAtDate = streakDateToYmd(_uRow && _uRow.created_at ? _uRow.created_at : null);
      let inactiveDays = null;
      if (createdAtDate) {
        inactiveDays = Math.floor((new Date(today + 'T00:00:00Z') - new Date(createdAtDate + 'T00:00:00Z')) / (24 * 60 * 60 * 1000));
        if (inactiveDays < 0) inactiveDays = 0;
      }
      const inactiveSeverity = inactiveDays != null && inactiveDays >= 5 ? 'P0' : (inactiveDays != null && inactiveDays >= 2 ? 'P1' : null);
      return res.json({
        streak: 0,
        todaySaved: false,
        atRisk: false,
        secondsUntilMidnight: null,
        weekly: {},
        days: [],
        inactiveDays,
        inactiveSeverity
      });
    }
    const { today, todaySaved, streak } = computeStreakState(rows, null, _uTz);
    const lastCheckinDate = rows[0] ? streakDateToYmd(rows[0].checkin_date) : null;
    let inactiveDays = todaySaved ? 0 : (lastCheckinDate
      ? Math.floor((new Date(today + 'T00:00:00Z') - new Date(lastCheckinDate + 'T00:00:00Z')) / (24 * 60 * 60 * 1000))
      : null);
    if (inactiveDays != null && inactiveDays < 0) inactiveDays = 0;
    const inactiveSeverity = (!todaySaved && inactiveDays != null && inactiveDays >= 5)
      ? 'P0'
      : (!todaySaved && inactiveDays != null && inactiveDays >= 2 ? 'P1' : null);
    const atRisk = !todaySaved && streak > 0;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const secondsUntilMidnight = Math.max(0, Math.floor((midnight - now) / 1000));
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekData = rows.filter(r => new Date(r.checkin_date) >= weekStart && !r.is_freeze);
    const avgSteps = weekData.length ? Math.round(weekData.reduce((s, r) => s + (r.steps || 0), 0) / weekData.length) : null;
    const avgWater = weekData.length
      ? Math.round((weekData.reduce((s, r) => s + (r.water_ml || 0), 0) / weekData.length / 1000) * 100) / 100
      : null;
    const avgProtein = weekData.length ? Math.round(weekData.reduce((s, r) => s + (r.protein_g || 0), 0) / weekData.length) : null;
    const avgSleep = weekData.length ? (weekData.reduce((s, r) => s + (r.sleep_hours || 0), 0) / weekData.length).toFixed(1) : null;
    res.json({
      streak,
      todaySaved: !!todaySaved,
      atRisk: !!atRisk,
      secondsUntilMidnight: atRisk ? secondsUntilMidnight : null,
      inactiveDays,
      inactiveSeverity,
      weekly: { avgSteps, avgWater, avgProtein, avgSleep },
      days: rows.map((r) => attachWaterLitersToDailyRow(r))
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load streak' });
  }
});

// Streak freeze (#12): preserve a streak across one missed day. 1 per calendar month.
// Inserts a marked empty check-in for yesterday so the streak chain stays intact;
// freeze rows are excluded from averages, weekly counts and admin views.
app.post('/api/me/streak-freeze', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const uRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [userId]).catch(() => null);
    const tz = (uRow && uRow.timezone) ? uRow.timezone : STREAK_TIMEZONE;
    const today = streakTodayYmdInTz(tz) || streakDateToYmd(new Date());
    const yesterday = streakAddDays(today, -1);
    if (!yesterday) return res.status(400).json({ error: 'Could not determine the day to protect' });
    const ym = String(today).slice(0, 7);
    // Enforce one freeze per calendar month.
    const usedRows = await queryAll(
      "SELECT checkin_date FROM daily_checkins WHERE user_id = ? AND COALESCE(is_freeze, FALSE) = TRUE AND to_char(checkin_date, 'YYYY-MM') = ?",
      [userId, ym]
    );
    if (usedRows && usedRows.length >= 1) {
      return res.status(409).json({ error: 'You have already used your streak freeze this month.' });
    }
    // Only allow if yesterday is actually missing (otherwise nothing to protect).
    const existing = await queryOne('SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, yesterday]);
    if (existing) {
      return res.status(409).json({ error: 'Yesterday is already logged — no freeze needed.' });
    }
    // Only worth it if there was a chain to reconnect (day before yesterday was a check-in).
    const dayBefore = streakAddDays(today, -2);
    const prior = dayBefore ? await queryOne('SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, dayBefore]) : null;
    if (!prior) {
      return res.status(409).json({ error: 'No active streak to recover right now.' });
    }
    await run(
      `INSERT INTO daily_checkins (id, user_id, checkin_date, is_freeze) VALUES (?, ?, ?::date, TRUE)
       ON CONFLICT (user_id, checkin_date) DO NOTHING`,
      [uuidv4(), userId, yesterday]
    );
    const rows = await queryAll('SELECT checkin_date FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365', [userId]);
    const { streak } = computeStreakState(rows, null, tz);
    res.json({ ok: true, frozen_date: yesterday, streak, freezeAvailable: false });
  } catch (e) {
    console.error('[streak-freeze]', e.message);
    res.status(500).json({ error: 'Failed to apply streak freeze' });
  }
});

// ============ MIND CHECK-IN (mental-fitness exercises) ============
const MIND_EXERCISE_KEYS = ['box_breathing', 'grounding_54321', 'body_scan'];

app.post('/api/mind-checkin', verifyToken, rateLimiter(30, 60000), async (req, res) => {
  try {
    const userId = req.user.id;
    const exercise_key = (req.body || {}).exercise_key;
    if (!MIND_EXERCISE_KEYS.includes(exercise_key)) {
      return res.status(400).json({ error: 'Invalid exercise' });
    }
    const _userTzRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [userId]).catch(() => null);
    const _userTz = (_userTzRow && _userTzRow.timezone) ? _userTzRow.timezone : STREAK_TIMEZONE;
    const today = streakTodayYmdInTz(_userTz) || streakDateToYmd(new Date());
    await run(
      `INSERT INTO mind_checkins (id, user_id, exercise_key, checkin_date)
       VALUES (?, ?, ?, ?::date)
       ON CONFLICT (user_id, exercise_key, checkin_date) DO NOTHING`,
      [uuidv4(), userId, exercise_key, today]
    );
    await safeAwardCoins(
      userId,
      'mind_checkin',
      `coins:mind_checkin:${userId}:${today}`,
      coinService.COIN_RULES.MIND_CHECKIN,
      { exerciseKey: exercise_key },
      today
    );
    const rows = await queryAll('SELECT exercise_key FROM mind_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]);
    res.json({ completed: (rows || []).map(r => r.exercise_key) });
  } catch (e) {
    console.error('Mind check-in error:', e.message);
    res.status(500).json({ error: 'Failed to save mind check-in' });
  }
});

app.get('/api/mind-checkin/today', verifyToken, async (req, res) => {
  try {
    const _utzRow = await queryOne('SELECT timezone FROM users WHERE id = ?', [req.user.id]).catch(() => null);
    const _utz = (_utzRow && _utzRow.timezone) ? _utzRow.timezone : STREAK_TIMEZONE;
    const today = streakTodayYmdInTz(_utz) || streakDateToYmd(new Date());
    const rows = await queryAll('SELECT exercise_key FROM mind_checkins WHERE user_id = ? AND checkin_date = ?::date', [req.user.id, today]);
    res.json({ completed: (rows || []).map(r => r.exercise_key) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load mind check-in' });
  }
});

app.get('/api/coins/summary', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // Keep read endpoints side-effect free so refresh/reload never mutates balances.
    // Penalties are still handled by cron + activity write flows.
    const summary = await coinService.getCoinSummary({ run, queryOne, queryAll }, userId);
    res.json(summary);
  } catch (e) {
    console.error('[coins summary]', e.message);
    res.status(500).json({ error: 'Failed to load coin summary' });
  }
});

app.get('/api/coins/ledger', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    // Read-only request: do not apply penalties on UI refresh.
    const rows = await coinService.listCoinLedger({ run, queryOne, queryAll }, userId, req.query.limit);
    res.json(rows || []);
  } catch (e) {
    console.error('[coins ledger]', e.message);
    res.status(500).json({ error: 'Failed to load coin history' });
  }
});

// Shared search builder for the admin/coach list screens.
// `textCols` are matched with a plain ILIKE substring. `phoneCols` are matched
// the same way AND digit-to-digit — the stored number is stripped to digits and
// compared against the digits the user typed — so "9876543210", "98765 43210"
// and "+91-98765-43210" all find the same client no matter how it was saved.
function buildContactSearchClause(search, textCols, phoneCols) {
  const raw = String(search || '').trim();
  if (!raw) return { sql: '', params: [] };
  const like = '%' + raw.replace(/%/g, '\\%') + '%';
  const phones = phoneCols || [];
  const parts = [];
  const params = [];
  (textCols || []).concat(phones).forEach((col) => {
    parts.push(`${col} ILIKE ?`);
    params.push(like);
  });
  // 4+ digits is enough to be a deliberate number lookup (a partial phone),
  // while short numeric strings still fall back to plain text matching only.
  // Longer inputs also match on the last 10 digits, so a number typed with a
  // country code still finds the same client saved without one.
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) {
    const needles = digits.length > 10 ? [digits, digits.slice(-10)] : [digits];
    phones.forEach((col) => {
      needles.forEach((needle) => {
        parts.push(`regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g') LIKE ?`);
        params.push('%' + needle + '%');
      });
    });
  }
  if (!parts.length) return { sql: '', params: [] };
  return { sql: ' AND (' + parts.join(' OR ') + ')', params };
}

app.get('/api/admin/daily-checkins', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    let sql = `SELECT dc.id, dc.user_id, dc.checkin_date, dc.steps, dc.water_ml, dc.protein_g, dc.sleep_hours, dc.created_at,
              u.first_name, u.last_name, u.email, u.phone
       FROM daily_checkins dc
       LEFT JOIN users u ON u.id = dc.user_id
       WHERE COALESCE(dc.is_freeze, FALSE) = FALSE`;
    const params = [];
    if (from) { sql += ` AND dc.checkin_date >= ?`; params.push(from); }
    if (to) { sql += ` AND dc.checkin_date <= ?`; params.push(to); }
    const dcSearch = buildContactSearchClause(search, ['u.first_name', 'u.last_name', 'u.email'], ['u.phone']);
    sql += dcSearch.sql;
    params.push(...dcSearch.params);
    // Group each client's daily check-ins together; clients ordered by their
    // most recent check-in, newest-first within a client.
    const clientKey = "COALESCE(CAST(dc.user_id AS TEXT), CAST(dc.id AS TEXT))";
    sql += ` ORDER BY MAX(dc.checkin_date) OVER (PARTITION BY ${clientKey}) DESC, ${clientKey} ASC, dc.checkin_date DESC, dc.created_at DESC LIMIT 250`;
    const rows = await queryAll(sql, params);
    res.json(rows.map((r) => attachWaterLitersToDailyRow(r)));
  } catch (e) {
    console.error('Admin daily check-ins list error:', e.message);
    res.status(500).json({ error: 'Failed to load daily check-ins' });
  }
});

// ============ DAILY CHECK-IN — ADMIN STATUS DASHBOARD ============
// Same projection as the Sunday dashboard, but the unit is a calendar day instead of a
// check-in week. NOTE: these two routes must stay ABOVE /api/admin/daily-checkins/:id —
// Express matches in registration order and ":id" would otherwise swallow "summary".
//
// Hours after midnight (report tz) that a daily check-in still counts as on time.
// 24 (default) = anytime that day, so nothing is Late until a coach tightens it.
const DAILY_DEADLINE_HOURS = (() => {
  const raw = parseFloat(process.env.DAILY_CHECKIN_DEADLINE_HOURS);
  return (Number.isFinite(raw) && raw > 0 && raw <= 48) ? raw : 24;
})();

function resolveDayWindow(dayParam) {
  const raw = String(dayParam == null ? 'today' : dayParam).trim().toLowerCase();
  const todayYmd = streakTodayYmdInTz(FORM_REPORT_TZ) || streakDateToYmd(new Date());
  const base = { timezone: FORM_REPORT_TZ, deadline_hours: DAILY_DEADLINE_HOURS, today_ymd: todayYmd };
  if (raw === 'all') return { ...base, mode: 'all', ymd: null, deadline_utc: null };
  let ymd = todayYmd;
  if (raw === 'yesterday') ymd = streakAddDays(todayYmd, -1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) ymd = raw;
  else if (raw !== 'today' && raw !== '') return null;
  if (!ymd) return null;
  const dDays = Math.floor(DAILY_DEADLINE_HOURS / 24);
  const rem = DAILY_DEADLINE_HOURS - dDays * 24;
  const hh = String(Math.floor(rem)).padStart(2, '0');
  const mm = String(Math.round((rem - Math.floor(rem)) * 60)).padStart(2, '0');
  return {
    ...base,
    mode: 'day',
    ymd,
    deadline_utc: localDateTimeToUtcIso(streakAddDays(ymd, dDays), `${hh}:${mm}`, FORM_REPORT_TZ),
    is_today: ymd === todayYmd
  };
}

app.get('/api/admin/daily-checkins/summary', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const win = resolveDayWindow(req.query.day);
    if (!win) return res.status(400).json({ error: 'Invalid day filter. Use today, yesterday, all or YYYY-MM-DD.' });
    const search = String(req.query.search || '').trim();
    const sort = String(req.query.sort || 'latest').trim().toLowerCase();
    const includeInactive = String(req.query.roster || 'active').trim().toLowerCase() === 'all';
    const activeClause = includeInactive ? '' : `
      AND COALESCE(u.suspended, FALSE) = FALSE
      AND LOWER(COALESCE(u.subscription_status, 'active')) <> 'canceled'
      AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW())`;
    const rosterSearch = buildContactSearchClause(
      search, ['u.first_name', 'u.last_name', 'u.email'], ['u.phone']
    );

    // checkin_date is a DATE column, so the day filter needs no timezone arithmetic;
    // only the on-time verdict compares the created_at timestamp to the deadline.
    const dayLateral = win.mode === 'day' ? `
      LEFT JOIN LATERAL (
        SELECT d.id, d.created_at, COALESCE(d.is_freeze, FALSE) AS is_freeze,
               (d.created_at > ?::timestamp) AS is_late,
               d.steps, d.water_ml, d.protein_g, d.sleep_hours
        FROM daily_checkins d
        WHERE d.user_id = r.id AND d.checkin_date = ?::date
        ORDER BY d.created_at DESC NULLS LAST
        LIMIT 1
      ) c ON TRUE` : `
      LEFT JOIN LATERAL (
        SELECT NULL::text AS id, NULL::timestamp AS created_at, FALSE AS is_freeze,
               NULL::boolean AS is_late, NULL::int AS steps, NULL::int AS water_ml,
               NULL::int AS protein_g, NULL::real AS sleep_hours
      ) c ON TRUE`;

    const sql = `
      WITH roster AS (
        SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
               u.subscription_status, u.access_expires_at, COALESCE(u.suspended, FALSE) AS suspended,
               u.created_at AS joined_at
        FROM users u
        WHERE ${OPERATOR_CLIENT_WHERE}${activeClause}${rosterSearch.sql}
      )
      SELECT r.id AS user_id, r.first_name, r.last_name, r.email, r.phone, r.profile_picture,
             r.suspended, r.subscription_status, ${formTsIso('r.joined_at')} AS joined_at,
             c.id AS day_checkin_id, ${formTsIso('c.created_at')} AS day_submitted_at,
             c.is_freeze, c.is_late, c.steps, c.water_ml, c.protein_g, c.sleep_hours,
             l.id AS last_checkin_id, ${formTsIso('l.created_at')} AS last_submitted_at,
             l.checkin_date::text AS last_checkin_date,
             COALESCE(t.n, 0) AS total_checkins, COALESCE(t.streak7, 0) AS last7
      FROM roster r
      ${dayLateral}
      LEFT JOIN LATERAL (
        SELECT d.id, d.created_at, d.checkin_date
        FROM daily_checkins d
        WHERE d.user_id = r.id AND COALESCE(d.is_freeze, FALSE) = FALSE
        ORDER BY d.checkin_date DESC NULLS LAST, d.created_at DESC NULLS LAST
        LIMIT 1
      ) l ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE d.checkin_date > CURRENT_DATE - 7)::int AS streak7
        FROM daily_checkins d
        WHERE d.user_id = r.id AND COALESCE(d.is_freeze, FALSE) = FALSE
      ) t ON TRUE
      LIMIT 5000`;
    const params = [...rosterSearch.params];
    if (win.mode === 'day') params.push(win.deadline_utc, win.ymd);
    const rosterRows = await queryAll(sql, params);

    const rows = rosterRows.map(r => {
      let status;
      if (win.mode === 'all') status = r.last_submitted_at ? 'submitted' : 'never';
      else if (!r.day_checkin_id) status = 'pending';
      else if (r.is_freeze === true) status = 'freeze';   // streak freeze = excused, not missed
      else if (typeof r.is_late === 'boolean') status = r.is_late ? 'late' : 'submitted';
      else status = 'submitted';
      return {
        key: 'user:' + String(r.user_id || ''),
        user_id: String(r.user_id || ''),
        name: formDisplayName(r),
        email: String(r.email || '').trim(),
        phone: String(r.phone || '').trim(),
        status,
        unlinked: false,
        suspended: !!r.suspended,
        joined_at: formIso(r.joined_at),
        last_submitted_at: formIso(r.last_submitted_at),
        last_checkin_date: r.last_checkin_date || null,
        last_checkin_id: r.last_checkin_id ? String(r.last_checkin_id) : null,
        day_submitted_at: formIso(r.day_submitted_at),
        day_checkin_id: r.day_checkin_id ? String(r.day_checkin_id) : null,
        is_freeze: r.is_freeze === true,
        steps: r.steps != null ? Number(r.steps) : null,
        water_ml: r.water_ml != null ? Number(r.water_ml) : null,
        protein_g: r.protein_g != null ? Number(r.protein_g) : null,
        sleep_hours: r.sleep_hours != null ? Number(r.sleep_hours) : null,
        total_checkins: Number(r.total_checkins) || 0,
        last7: Number(r.last7) || 0
      };
    });

    const appliedSort = formSortRows(rows, sort);
    const summary = formSummarize(rows);
    if (win.mode === 'all') summary.pending = summary.never;

    let hiddenInactive = 0;
    if (!includeInactive) {
      try {
        const h = await queryOne(`
          SELECT COUNT(*)::int AS n FROM users u
          WHERE ${OPERATOR_CLIENT_WHERE} AND NOT (
            COALESCE(u.suspended, FALSE) = FALSE
            AND LOWER(COALESCE(u.subscription_status, 'active')) <> 'canceled'
            AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW())
          )`);
        hiddenInactive = Number(h && h.n) || 0;
      } catch (he) { hiddenInactive = 0; }
    }

    res.json({
      window: {
        mode: win.mode, ymd: win.ymd, deadline_utc: win.deadline_utc,
        deadline_hours: win.deadline_hours, timezone: win.timezone,
        today_ymd: win.today_ymd, is_today: !!win.is_today
      },
      roster: includeInactive ? 'all' : 'active',
      hidden_inactive: hiddenInactive,
      sort: appliedSort,
      summary,
      rows
    });
  } catch (e) {
    console.error('Admin daily-checkins summary error:', e.message);
    res.status(500).json({ error: 'Failed to load daily check-in status' });
  }
});

app.get('/api/admin/daily-checkins/history', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const userId = String(req.query.user_id || '').trim();
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);

    const user = await queryOne(
      `SELECT id, first_name, last_name, email, phone, ${formTsIso('created_at')} AS created_at
       FROM users WHERE id = ?`, [userId]
    );
    const subs = await queryAll(`
      SELECT id, checkin_date::text AS checkin_date, ${formTsIso('created_at')} AS created_at,
             steps, water_ml, protein_g, sleep_hours, COALESCE(is_freeze, FALSE) AS is_freeze
      FROM daily_checkins WHERE user_id = ?
      ORDER BY checkin_date DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 400`, [userId]);

    const byDate = new Map();
    subs.forEach(s => { if (s.checkin_date && !byDate.has(s.checkin_date)) byDate.set(s.checkin_date, s); });

    const todayYmd = streakTodayYmdInTz(FORM_REPORT_TZ) || streakDateToYmd(new Date());
    const joinedMs = formMs(user && user.created_at);
    const ledger = [];
    for (let i = 0; i < days; i++) {
      const ymd = streakAddDays(todayYmd, -i);
      if (!ymd) break;
      const hit = byDate.get(ymd) || null;
      let status;
      if (hit && hit.is_freeze) status = 'freeze';
      else if (hit) {
        const deadlineMs = formMs(localDateTimeToUtcIso(ymd, '00:00', FORM_REPORT_TZ)) + DAILY_DEADLINE_HOURS * 3600000;
        const gotMs = formMs(hit.created_at);
        status = (Number.isFinite(gotMs) && gotMs > deadlineMs) ? 'late' : 'submitted';
      } else if (Number.isFinite(joinedMs) &&
                 formMs(localDateTimeToUtcIso(streakAddDays(ymd, 1), '00:00', FORM_REPORT_TZ)) <= joinedMs) {
        status = 'not_expected';
      } else status = 'not_submitted';
      ledger.push({
        ymd, status,
        submitted_at: hit ? hit.created_at : null,
        checkin_id: hit ? String(hit.id) : null,
        steps: hit && hit.steps != null ? Number(hit.steps) : null,
        water_ml: hit && hit.water_ml != null ? Number(hit.water_ml) : null,
        protein_g: hit && hit.protein_g != null ? Number(hit.protein_g) : null,
        sleep_hours: hit && hit.sleep_hours != null ? Number(hit.sleep_hours) : null
      });
    }

    const real = subs.filter(s => !s.is_freeze);
    res.json({
      user: {
        user_id: user ? String(user.id) : userId,
        name: user ? ([user.first_name, user.last_name].filter(Boolean).join(' ').trim() || '—') : '—',
        email: (user && user.email) || '',
        phone: (user && user.phone) || '',
        joined_at: formIso(user && user.created_at),
        linked: !!user
      },
      timezone: FORM_REPORT_TZ,
      deadline_hours: DAILY_DEADLINE_HOURS,
      total_checkins: real.length,
      freeze_days: subs.length - real.length,
      latest: real[0] || null,
      submissions: subs.map(s => ({
        id: String(s.id), checkin_date: s.checkin_date, created_at: s.created_at,
        steps: s.steps, water_ml: s.water_ml, protein_g: s.protein_g,
        sleep_hours: s.sleep_hours, is_freeze: !!s.is_freeze
      })),
      days: ledger
    });
  } catch (e) {
    console.error('Admin daily-checkin history error:', e.message);
    res.status(500).json({ error: 'Failed to load daily check-in history' });
  }
});

app.get('/api/admin/daily-checkins/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT dc.*, u.first_name, u.last_name, u.email, u.phone
       FROM daily_checkins dc
       LEFT JOIN users u ON u.id = dc.user_id
       WHERE dc.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(attachWaterLitersToDailyRow(row));
  } catch (e) {
    console.error('Admin daily check-in detail error:', e.message);
    res.status(500).json({ error: 'Failed to load daily check-in' });
  }
});

app.get('/api/admin/audit-requests', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    let sql = 'SELECT * FROM audit_requests WHERE 1=1';
    const params = [];
    if (from) {
      sql += ' AND created_at::date >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at::date <= ?';
      params.push(to);
    }
    const arSearch = buildContactSearchClause(
      search,
      ['first_name', 'last_name', 'email', '(COALESCE(first_name,\'\') || \' \' || COALESCE(last_name,\'\'))'],
      ['phone']
    );
    sql += arSearch.sql;
    params.push(...arSearch.params);
    // Group each client's submissions together; clients ordered by their most
    // recent submission, newest-first within a client.
    const clientKey = "COALESCE(NULLIF(LOWER(TRIM(email)), ''), CAST(id AS TEXT))";
    sql += ` ORDER BY MAX(created_at) OVER (PARTITION BY ${clientKey}) DESC, ${clientKey} ASC, created_at DESC LIMIT 250`;
    const rows = await queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Admin audit-requests list error:', e.message);
    res.status(500).json({ error: 'Failed to load audit requests' });
  }
});

app.get('/api/admin/sunday-checkins', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    let sql = `SELECT s.id, s.full_name, s.reply_email, s.created_at, s.user_id,
         u.first_name, u.last_name, u.email, u.phone
       FROM sunday_checkins s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE 1=1`;
    const params = [];
    if (from) {
      sql += ' AND s.created_at::date >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND s.created_at::date <= ?';
      params.push(to);
    }
    const scSearch = buildContactSearchClause(
      search,
      ['s.full_name', 's.reply_email', 'u.first_name', 'u.last_name', 'u.email'],
      ['u.phone']
    );
    sql += scSearch.sql;
    params.push(...scSearch.params);
    // Group each client's check-ins together; clients ordered by their most
    // recent check-in, newest-first within a client. Key on user_id when linked,
    // else the reply email.
    const clientKey = "COALESCE(CAST(s.user_id AS TEXT), NULLIF(LOWER(TRIM(s.reply_email)), ''), CAST(s.id AS TEXT))";
    sql += ` ORDER BY MAX(s.created_at) OVER (PARTITION BY ${clientKey}) DESC, ${clientKey} ASC, s.created_at DESC LIMIT 250`;
    const rows = await queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Admin sunday-checkins list error:', e.message);
    res.status(500).json({ error: 'Failed to load Sunday check-ins' });
  }
});

// ============ SUNDAY CHECK-IN — ADMIN STATUS DASHBOARD ============
// The list endpoint above returns one row per historical submission, which makes it
// impossible to see who is still missing this week. Everything below is a read-only
// "latest status" projection over the same append-only table — no submission is ever
// mutated, merged or deleted.
//
// Week model: a check-in week runs Sunday 00:00 → the following Sunday 00:00 in the
// report timezone. That matches the client-facing "pending check-in" badge, which
// anchors on the Sunday of the current week. It deliberately differs from
// coinService.isoWeekKey() (ISO, Monday-start), which only de-duplicates coin awards.
const FORM_REPORT_TZ = (process.env.APP_TIMEZONE || '').trim() || STREAK_TIMEZONE;
// Hours after Sunday 00:00 (report tz) that a check-in still counts as on time.
// 24 = anytime on Sunday, 12 = Sunday noon, 36 = Monday noon.
const SUNDAY_DEADLINE_HOURS = (() => {
  const raw = parseFloat(process.env.SUNDAY_CHECKIN_DEADLINE_HOURS);
  return (Number.isFinite(raw) && raw > 0 && raw <= 168) ? raw : 24;
})();

// The Sunday that starts the check-in week containing `ymd`.
function sundayWeekStartYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return streakAddDays(m[0], -d.getUTCDay());
}

// Turn the ?week= filter into concrete UTC instants. `all` disables the window and
// falls back to an all-time view. Returns null only for an unparseable custom date.
function resolveSundayWindow(weekParam) {
  const raw = String(weekParam == null ? 'this' : weekParam).trim().toLowerCase();
  const todayYmd = streakTodayYmdInTz(FORM_REPORT_TZ) || streakDateToYmd(new Date());
  const base = {
    timezone: FORM_REPORT_TZ,
    deadline_hours: SUNDAY_DEADLINE_HOURS,
    today_ymd: todayYmd,
    current_sunday_ymd: sundayWeekStartYmd(todayYmd)
  };
  if (raw === 'all') {
    return { ...base, mode: 'all', sunday_ymd: null, start_utc: null, end_utc: null, deadline_utc: null };
  }
  let anchor = todayYmd;
  if (raw === 'last') {
    // Saturday of the previous week → its week start is last Sunday.
    anchor = streakAddDays(sundayWeekStartYmd(todayYmd), -1);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    anchor = raw;
  } else if (raw !== 'this' && raw !== '') {
    return null;
  }
  const sunday = sundayWeekStartYmd(anchor);
  if (!sunday) return null;
  // Day/time arithmetic (not +N ms) so a DST shift inside the week cannot skew the
  // boundaries in timezones that observe it.
  const deadlineDays = Math.floor(SUNDAY_DEADLINE_HOURS / 24);
  const remHours = SUNDAY_DEADLINE_HOURS - deadlineDays * 24;
  const hh = String(Math.floor(remHours)).padStart(2, '0');
  const mm = String(Math.round((remHours - Math.floor(remHours)) * 60)).padStart(2, '0');
  return {
    ...base,
    mode: 'week',
    sunday_ymd: sunday,
    start_utc: localDateTimeToUtcIso(sunday, '00:00', FORM_REPORT_TZ),
    end_utc: localDateTimeToUtcIso(streakAddDays(sunday, 7), '00:00', FORM_REPORT_TZ),
    deadline_utc: localDateTimeToUtcIso(streakAddDays(sunday, deadlineDays), `${hh}:${mm}`, FORM_REPORT_TZ),
    is_current_week: sunday === base.current_sunday_ymd
  };
}

// A submission belongs to a client when it carries their id, or — for the legacy rows
// that were saved before check-ins were linked to accounts — when the reply email
// matches. Kept in one place so the roster join, the orphan sweep and the history
// endpoint can never drift apart.
const SC_LINK_TO_ROSTER = `(
     (s.user_id IS NOT NULL AND s.user_id = r.id)
  OR (s.user_id IS NULL AND NULLIF(LOWER(TRIM(s.reply_email)), '') = LOWER(TRIM(r.email)))
)`;

// Render a timestamp column as a canonical UTC ISO string in SQL instead of letting the
// driver build a Date. node-postgres materialises `timestamp without time zone` using the
// Node process's local offset, so the same row would come back shifted on a machine that
// is not on UTC. Formatting in the database keeps this dashboard's instants — and the
// late/on-time verdicts derived from them — identical wherever the app is deployed.
const formTsIso = (expr) => `to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function formDisplayName(row) {
  const fromAccount = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return fromAccount || String(row.last_full_name || row.full_name || '').trim() || '—';
}

// pg hands `timestamp` columns back as Date objects; the legacy store hands back ISO
// text. Normalise both, and never throw on a corrupt value.
function formMs(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

function formIso(v) {
  const ms = formMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---- Shared ranking / rollup for every "one row per person" dashboard ----
// Sunday, Daily, Audit and Part-2 all present the same shape (name, email, status,
// last submission) so they sort and summarise identically.
const FORM_STATUS_RANK = { pending: 0, never: 0, late: 1, freeze: 2, submitted: 3 };

// Sorts in place and returns the sort key that was actually applied.
function formSortRows(rows, sort) {
  const nameKey = r => (r.name || '').toLowerCase();
  const lastMs = r => { const m = formMs(r.last_submitted_at); return Number.isFinite(m) ? m : null; };
  // Rows that have never submitted sort last under "latest" and first under "oldest" —
  // either way the people needing attention are never buried in the middle.
  const byRecency = dir => (a, b) => {
    const am = lastMs(a); const bm = lastMs(b);
    if (am === null && bm === null) return nameKey(a).localeCompare(nameKey(b));
    if (am === null) return dir;
    if (bm === null) return -dir;
    return (dir > 0 ? bm - am : am - bm) || nameKey(a).localeCompare(nameKey(b));
  };
  const comparators = {
    latest: byRecency(1),
    oldest: byRecency(-1),
    name: (a, b) => nameKey(a).localeCompare(nameKey(b)),
    status: (a, b) => (FORM_STATUS_RANK[a.status] - FORM_STATUS_RANK[b.status]) || nameKey(a).localeCompare(nameKey(b))
  };
  const key = comparators[sort] ? sort : 'latest';
  rows.sort(comparators[key]);
  return key;
}

function formSummarize(rows) {
  const s = { total: rows.length, submitted: 0, pending: 0, late: 0, never: 0, freeze: 0, unlinked: 0 };
  rows.forEach(r => {
    if (r.status === 'submitted') s.submitted++;
    else if (r.status === 'late') { s.late++; s.submitted++; }   // Late is a subset of Submitted
    else if (r.status === 'freeze') s.freeze++;
    else if (r.status === 'never') s.never++;
    else s.pending++;
    if (r.unlinked) s.unlinked++;
  });
  // A streak-freeze day is an excused absence, so it counts as covered rather than
  // being punished as Pending — but it is reported separately, never as "Submitted".
  const covered = s.submitted + s.freeze;
  s.completion_pct = s.total > 0 ? Math.round((covered / s.total) * 1000) / 10 : 0;
  return s;
}

// Calendar date of an instant in the report timezone (so a Sunday 11pm IST submission
// is not filed under Monday just because it is past midnight UTC).
function formLocalYmd(v) {
  const ms = formMs(v);
  if (!Number.isFinite(ms)) return null;
  try {
    return getLocalDateParts(new Date(ms), FORM_REPORT_TZ).date;
  } catch (e) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

app.get('/api/admin/sunday-checkins/summary', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const win = resolveSundayWindow(req.query.week);
    if (!win) return res.status(400).json({ error: 'Invalid week filter. Use this, last, all or YYYY-MM-DD.' });
    const search = String(req.query.search || '').trim();
    const sort = String(req.query.sort || 'latest').trim().toLowerCase();
    // Default roster = clients who can actually submit right now, so Completion % is
    // not diluted by expired/paused accounts. `roster=all` shows every approved client.
    const includeInactive = String(req.query.roster || 'active').trim().toLowerCase() === 'all';
    const activeClause = includeInactive ? '' : `
      AND COALESCE(u.suspended, FALSE) = FALSE
      AND LOWER(COALESCE(u.subscription_status, 'active')) <> 'canceled'
      AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW())`;

    // --- Roster-first pass: every expected client, with or without a submission. ---
    const rosterSearch = buildContactSearchClause(
      search,
      ['u.first_name', 'u.last_name', 'u.email'],
      ['u.phone']
    );
    const weekLateral = win.mode === 'week' ? `
      LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, (s.created_at > ?::timestamp) AS is_late
        FROM sunday_checkins s
        WHERE ${SC_LINK_TO_ROSTER} AND s.created_at >= ?::timestamp AND s.created_at < ?::timestamp
        ORDER BY s.created_at DESC NULLS LAST
        LIMIT 1
      ) w ON TRUE` : `
      LEFT JOIN LATERAL (SELECT NULL::text AS id, NULL::timestamp AS created_at, NULL::boolean AS is_late) w ON TRUE`;

    const rosterSql = `
      WITH roster AS (
        SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
               u.subscription_status, u.access_expires_at, COALESCE(u.suspended, FALSE) AS suspended,
               u.created_at AS joined_at
        FROM users u
        WHERE ${OPERATOR_CLIENT_WHERE}${activeClause}${rosterSearch.sql}
      )
      SELECT r.id AS user_id, r.first_name, r.last_name, r.email, r.phone, r.profile_picture,
             r.subscription_status, r.access_expires_at, r.suspended,
             ${formTsIso('r.joined_at')} AS joined_at,
             w.id AS week_checkin_id, ${formTsIso('w.created_at')} AS week_submitted_at, w.is_late,
             l.id AS last_checkin_id, ${formTsIso('l.created_at')} AS last_submitted_at,
             l.full_name AS last_full_name,
             COALESCE(t.n, 0) AS total_checkins
      FROM roster r
      ${weekLateral}
      LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.full_name
        FROM sunday_checkins s
        WHERE ${SC_LINK_TO_ROSTER}
        ORDER BY s.created_at DESC NULLS LAST
        LIMIT 1
      ) l ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n FROM sunday_checkins s WHERE ${SC_LINK_TO_ROSTER}
      ) t ON TRUE
      LIMIT 5000`;
    // Params are pushed in the same order the placeholders appear in the SQL above.
    const rosterParams = [...rosterSearch.params];
    if (win.mode === 'week') rosterParams.push(win.deadline_utc, win.start_utc, win.end_utc);
    const rosterRows = await queryAll(rosterSql, rosterParams);

    // --- Orphan sweep: submissions that belong to no account at all (unlinked user_id
    // and an email nobody signed up with). Without this they would silently vanish from
    // a dashboard whose entire job is "who is missing".
    //
    // "No account at all" is deliberate: matching against EVERY user — not the filtered
    // roster — means a submission from a test account, an unapproved account or an
    // expired client stays intentionally out of scope instead of reappearing here as an
    // untraceable row. The noise filters are re-applied to the orphan's own fields so
    // seeded e2e submissions cannot sneak back in through the email column either.
    const orphanSearch = buildContactSearchClause(search, ['o.full_name', 'o.reply_email'], []);
    const orphanWeekFilter = win.mode === 'week'
      ? 'o.created_at >= ?::timestamp AND o.created_at < ?::timestamp'
      : 'FALSE';
    const orphanSql = `
      WITH orphan AS (
        SELECT s.id, s.full_name, s.reply_email, s.created_at,
               COALESCE(NULLIF(LOWER(TRIM(s.reply_email)), ''), 'id:' || s.id) AS gkey
        FROM sunday_checkins s
        WHERE NOT EXISTS (SELECT 1 FROM users r WHERE ${SC_LINK_TO_ROSTER})
          AND COALESCE(s.reply_email, '') NOT LIKE '%@test.bodybank.fit'
          AND LOWER(COALESCE(s.full_name, '')) NOT LIKE '%e2e%'
      )
      SELECT o.gkey,
             (ARRAY_AGG(o.full_name  ORDER BY o.created_at DESC NULLS LAST))[1] AS last_full_name,
             (ARRAY_AGG(o.reply_email ORDER BY o.created_at DESC NULLS LAST))[1] AS email,
             (ARRAY_AGG(o.id          ORDER BY o.created_at DESC NULLS LAST))[1] AS last_checkin_id,
             ${formTsIso('MAX(o.created_at)')} AS last_submitted_at,
             COUNT(*)::int AS total_checkins,
             ${formTsIso(`MAX(o.created_at) FILTER (WHERE ${orphanWeekFilter})`)} AS week_submitted_at,
             (ARRAY_AGG(o.id ORDER BY o.created_at DESC NULLS LAST)
                FILTER (WHERE ${orphanWeekFilter}))[1] AS week_checkin_id,
             ${win.mode === 'week'
               ? `(ARRAY_AGG(o.created_at > ?::timestamp ORDER BY o.created_at DESC NULLS LAST)
                    FILTER (WHERE ${orphanWeekFilter}))[1]`
               : 'NULL::boolean'} AS is_late
      FROM orphan o
      WHERE 1=1${orphanSearch.sql}
      GROUP BY o.gkey
      LIMIT 2000`;
    const orphanParams = [];
    if (win.mode === 'week') {
      orphanParams.push(
        win.start_utc, win.end_utc,                     // week_submitted_at filter
        win.start_utc, win.end_utc,                     // week_checkin_id filter
        win.deadline_utc, win.start_utc, win.end_utc    // is_late expression + its filter
      );
    }
    orphanParams.push(...orphanSearch.params);
    let orphanRows = [];
    try {
      orphanRows = await queryAll(orphanSql, orphanParams);
    } catch (oe) {
      // An orphan-sweep failure must not take the whole dashboard down.
      console.warn('[sunday summary] orphan sweep failed:', oe.message);
    }

    const deadlineMs = win.mode === 'week' ? formMs(win.deadline_utc) : NaN;
    const toRow = (r, unlinked) => {
      const weekMs = formMs(r.week_submitted_at);
      const submittedThisWeek = Number.isFinite(weekMs);
      let status;
      if (win.mode === 'all') status = Number.isFinite(formMs(r.last_submitted_at)) ? 'submitted' : 'never';
      else if (!submittedThisWeek) status = 'pending';
      // Trust the database's on-time verdict whenever it produced one. It compares the
      // stored timestamp against the deadline inside a single reference frame, whereas
      // the JS fallback depends on how the driver localises `timestamp` columns — those
      // two disagree by the process's UTC offset unless the app runs on UTC. The JS
      // branch only serves the orphan rows, which carry no SQL verdict.
      else if (typeof r.is_late === 'boolean') status = r.is_late ? 'late' : 'submitted';
      else status = (Number.isFinite(deadlineMs) && weekMs > deadlineMs) ? 'late' : 'submitted';
      return {
        key: unlinked ? 'email:' + String(r.gkey || '') : 'user:' + String(r.user_id || ''),
        user_id: unlinked ? null : String(r.user_id || ''),
        name: formDisplayName(r),
        email: String(r.email || '').trim(),
        phone: unlinked ? '' : String(r.phone || '').trim(),
        profile_picture: r.profile_picture || '',
        status,
        unlinked: !!unlinked,
        suspended: !!r.suspended,
        subscription_status: r.subscription_status || '',
        joined_at: formIso(r.joined_at),
        last_submitted_at: formIso(r.last_submitted_at),
        last_checkin_id: r.last_checkin_id ? String(r.last_checkin_id) : null,
        week_submitted_at: formIso(r.week_submitted_at),
        week_checkin_id: r.week_checkin_id ? String(r.week_checkin_id) : null,
        total_checkins: Number(r.total_checkins) || 0
      };
    };
    const rows = rosterRows.map(r => toRow(r, false)).concat(orphanRows.map(r => toRow(r, true)));

    const appliedSort = formSortRows(rows, sort);
    const summary = formSummarize(rows);
    if (win.mode === 'all') summary.pending = summary.never;

    // How many approved clients the active-roster filter is holding back, so the
    // denominator is never silently smaller than the admin expects.
    let hiddenInactive = 0;
    if (!includeInactive) {
      try {
        const h = await queryOne(`
          SELECT COUNT(*)::int AS n FROM users u
          WHERE ${OPERATOR_CLIENT_WHERE} AND NOT (
            COALESCE(u.suspended, FALSE) = FALSE
            AND LOWER(COALESCE(u.subscription_status, 'active')) <> 'canceled'
            AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW())
          )`);
        hiddenInactive = Number(h && h.n) || 0;
      } catch (he) { hiddenInactive = 0; }
    }

    res.json({
      window: {
        mode: win.mode,
        sunday_ymd: win.sunday_ymd,
        start_utc: win.start_utc,
        end_utc: win.end_utc,
        deadline_utc: win.deadline_utc,
        deadline_hours: win.deadline_hours,
        timezone: win.timezone,
        is_current_week: !!win.is_current_week,
        current_sunday_ymd: win.current_sunday_ymd
      },
      roster: includeInactive ? 'all' : 'active',
      hidden_inactive: hiddenInactive,
      sort: appliedSort,
      summary,
      rows
    });
  } catch (e) {
    console.error('Admin sunday-checkins summary error:', e.message);
    res.status(500).json({ error: 'Failed to load Sunday check-in status' });
  }
});

// Full submission history for one client — every historical row is preserved and
// returned here, plus the weeks they missed. Identify by ?user_id= (linked accounts)
// or ?email= (unlinked legacy submissions).
app.get('/api/admin/sunday-checkins/history', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const userId = String(req.query.user_id || '').trim();
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!userId && !email) return res.status(400).json({ error: 'user_id or email is required' });
    const weeksBack = Math.min(Math.max(parseInt(req.query.weeks, 10) || 12, 1), 52);

    let user = null;
    if (userId) {
      user = await queryOne(
        `SELECT id, first_name, last_name, email, phone, ${formTsIso('created_at')} AS created_at FROM users WHERE id = ?`,
        [userId]
      );
    }
    if (!user && email) {
      user = await queryOne(
        `SELECT id, first_name, last_name, email, phone, ${formTsIso('created_at')} AS created_at FROM users WHERE LOWER(TRIM(email)) = ?`,
        [email]
      );
    }

    const matchId = user ? String(user.id) : userId;
    const matchEmail = (user && user.email ? String(user.email) : email).trim().toLowerCase();
    const subs = await queryAll(`
      SELECT id, full_name, reply_email, ${formTsIso('created_at')} AS created_at,
             plan, current_weight_waist_week, body_fat_percent
      FROM sunday_checkins
      WHERE (? <> '' AND user_id = ?)
         OR (? <> '' AND NULLIF(LOWER(TRIM(reply_email)), '') = ?)
      ORDER BY created_at DESC NULLS LAST
      LIMIT 300`,
      [matchId || '', matchId || '', matchEmail || '', matchEmail || '']
    );

    const deadlineHours = SUNDAY_DEADLINE_HOURS;
    const submissions = subs.map(s => {
      const iso = formIso(s.created_at);
      const localYmd = iso ? formLocalYmd(iso) : null;
      return {
        id: String(s.id),
        created_at: iso,
        sunday_ymd: localYmd ? sundayWeekStartYmd(localYmd) : null,
        plan: s.plan || '',
        weight_note: s.current_weight_waist_week || '',
        body_fat_percent: s.body_fat_percent != null ? s.body_fat_percent : null
      };
    });

    // Week ledger: newest `weeksBack` Sundays, with the gaps made explicit.
    const todayYmd = streakTodayYmdInTz(FORM_REPORT_TZ) || streakDateToYmd(new Date());
    const currentSunday = sundayWeekStartYmd(todayYmd);
    const joinedMs = formMs(user && user.created_at);
    const firstSubMs = submissions.reduce((min, s) => {
      const m = formMs(s.created_at);
      return Number.isFinite(m) && (min === null || m < min) ? m : min;
    }, null);
    const expectedFromMs = Number.isFinite(joinedMs)
      ? (firstSubMs !== null ? Math.min(joinedMs, firstSubMs) : joinedMs)
      : firstSubMs;
    const weeks = [];
    for (let i = 0; i < weeksBack; i++) {
      const sunday = streakAddDays(currentSunday, -7 * i);
      if (!sunday) break;
      const startMs = formMs(localDateTimeToUtcIso(sunday, '00:00', FORM_REPORT_TZ));
      const endMs = formMs(localDateTimeToUtcIso(streakAddDays(sunday, 7), '00:00', FORM_REPORT_TZ));
      const deadlineMs = startMs + deadlineHours * 3600000;
      const inWeek = submissions
        .filter(s => { const m = formMs(s.created_at); return Number.isFinite(m) && m >= startMs && m < endMs; })
        .sort((a, b) => formMs(b.created_at) - formMs(a.created_at));
      const latest = inWeek[0] || null;
      let status;
      if (latest) status = formMs(latest.created_at) > deadlineMs ? 'late' : 'submitted';
      else if (expectedFromMs !== null && Number.isFinite(expectedFromMs) && endMs <= expectedFromMs) status = 'not_expected';
      else status = 'not_submitted';
      weeks.push({
        sunday_ymd: sunday,
        status,
        submitted_at: latest ? latest.created_at : null,
        checkin_id: latest ? latest.id : null,
        submissions_in_week: inWeek.length
      });
    }

    res.json({
      user: {
        user_id: user ? String(user.id) : null,
        name: user
          ? ([user.first_name, user.last_name].filter(Boolean).join(' ').trim() || (submissions[0] && submissions[0].full_name) || '—')
          : ((subs[0] && subs[0].full_name) || matchEmail || '—'),
        email: (user && user.email) || (subs[0] && subs[0].reply_email) || matchEmail || '',
        phone: (user && user.phone) || '',
        joined_at: formIso(user && user.created_at),
        linked: !!user
      },
      timezone: FORM_REPORT_TZ,
      deadline_hours: deadlineHours,
      total_checkins: submissions.length,
      latest: submissions[0] || null,
      submissions,
      weeks
    });
  } catch (e) {
    console.error('Admin sunday-checkin history error:', e.message);
    res.status(500).json({ error: 'Failed to load check-in history' });
  }
});

// ============ INTAKE FUNNEL — AUDIT FORM & PART-2 DASHBOARDS ============
// These two forms are not recurring client check-ins: they are the one-time lead
// intake pair. Most people who submit them are prospects, not registered clients, so
// measuring them against the client roster would hide the real submissions and mark
// every client "pending" for a form they were never asked to fill.
//
// Instead the cohort is the Audit form itself:
//   Audit tab  — one row per person (duplicate submissions rolled up, full history kept)
//   Part-2 tab — same people, showing who has and has not completed the follow-up
// Both are keyed on the lowercased email, which is the only identifier the two tables
// share (part2_audit has no user_id at all).
const INTAKE_PERSON_KEY = "COALESCE(NULLIF(LOWER(TRIM(a.email)), ''), 'id:' || a.id)";

// The grouped-by-person Audit cohort, reused by both dashboards.
function buildIntakeCohortSql(fromDate, toDate, searchClause) {
  return `
    WITH scoped AS (
      SELECT a.* , ${INTAKE_PERSON_KEY} AS gkey, NULLIF(LOWER(TRIM(a.email)), '') AS email_key
      FROM audit_requests a
      WHERE 1=1${fromDate ? ' AND a.created_at::date >= ?' : ''}${toDate ? ' AND a.created_at::date <= ?' : ''}${searchClause}
    ),
    people AS (
      SELECT gkey,
             MIN(email_key) AS email_key,
             (ARRAY_AGG(first_name ORDER BY created_at DESC NULLS LAST))[1] AS first_name,
             (ARRAY_AGG(last_name  ORDER BY created_at DESC NULLS LAST))[1] AS last_name,
             (ARRAY_AGG(email      ORDER BY created_at DESC NULLS LAST))[1] AS email,
             (ARRAY_AGG(phone      ORDER BY created_at DESC NULLS LAST))[1] AS phone,
             (ARRAY_AGG(stage      ORDER BY created_at DESC NULLS LAST))[1] AS stage,
             (ARRAY_AGG(status     ORDER BY created_at DESC NULLS LAST))[1] AS status,
             (ARRAY_AGG(linked_user_id ORDER BY created_at DESC NULLS LAST))[1] AS linked_user_id,
             (ARRAY_AGG(id         ORDER BY created_at DESC NULLS LAST))[1] AS last_audit_id,
             ${formTsIso('MAX(created_at)')} AS last_audit_at,
             ${formTsIso('MIN(created_at)')} AS first_audit_at,
             COUNT(*)::int AS audit_submissions
      FROM scoped GROUP BY gkey
    )`;
}

// Latest Part-2 submission for a cohort row, matched on the shared email.
const INTAKE_PART2_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT x.id, x.created_at, x.score, x.tier_label
    FROM part2_audit x
    WHERE p.email_key IS NOT NULL AND NULLIF(LOWER(TRIM(x.email)), '') = p.email_key
    ORDER BY x.created_at DESC NULLS LAST
    LIMIT 1
  ) p2 ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS n FROM part2_audit x
    WHERE p.email_key IS NOT NULL AND NULLIF(LOWER(TRIM(x.email)), '') = p.email_key
  ) p2c ON TRUE`;

function intakeDisplayName(r) {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  return n || String(r.name || '').trim() || String(r.email || '').trim() || '—';
}

// --- Audit Form: one row per person, duplicates rolled up, history preserved ---
app.get('/api/admin/audit-requests/summary', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const search = String(req.query.search || '').trim();
    const sort = String(req.query.sort || 'latest').trim().toLowerCase();
    const sc = buildContactSearchClause(
      search,
      ['a.first_name', 'a.last_name', 'a.email', "(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,''))"],
      ['a.phone']
    );
    const sql = buildIntakeCohortSql(from, to, sc.sql) + `
      SELECT p.*, p2.id AS part2_id, ${formTsIso('p2.created_at')} AS part2_at,
             p2.score AS part2_score, p2.tier_label AS part2_tier,
             COALESCE(p2c.n, 0) AS part2_submissions
      FROM people p
      ${INTAKE_PART2_LATERAL}
      LIMIT 5000`;
    const params = [];
    if (from) params.push(from);
    if (to) params.push(to);
    params.push(...sc.params);
    const raw = await queryAll(sql, params);

    const rows = raw.map(r => ({
      key: 'intake:' + String(r.gkey || ''),
      email_key: r.email_key || null,
      name: intakeDisplayName(r),
      email: String(r.email || '').trim(),
      phone: String(r.phone || '').trim(),
      // Everyone in this cohort submitted the Audit form by definition, so the status
      // column carries the funnel step that is actually still open: Part-2.
      status: 'submitted',
      part2_status: r.part2_id ? 'submitted' : 'pending',
      part2_at: formIso(r.part2_at),
      part2_id: r.part2_id ? String(r.part2_id) : null,
      part2_score: r.part2_score != null ? Number(r.part2_score) : null,
      part2_tier: r.part2_tier || '',
      part2_submissions: Number(r.part2_submissions) || 0,
      stage: r.stage || '',
      lead_status: r.status || '',
      linked_user_id: r.linked_user_id || null,
      unlinked: false,
      last_submitted_at: formIso(r.last_audit_at),
      first_submitted_at: formIso(r.first_audit_at),
      last_checkin_id: r.last_audit_id ? String(r.last_audit_id) : null,
      total_checkins: Number(r.audit_submissions) || 0
    }));

    let appliedSort;
    if (sort === 'part2') {
      // Not-yet-completed first — that is the actionable half of this list.
      rows.sort((a, b) =>
        (a.part2_status === b.part2_status ? 0 : (a.part2_status === 'pending' ? -1 : 1)) ||
        (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
      appliedSort = 'part2';
    } else if (sort === 'submissions') {
      rows.sort((a, b) => (b.total_checkins - a.total_checkins) ||
        (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
      appliedSort = 'submissions';
    } else {
      appliedSort = formSortRows(rows, sort);
    }

    const totalSubmissions = rows.reduce((n, r) => n + r.total_checkins, 0);
    const part2Done = rows.filter(r => r.part2_status === 'submitted').length;
    const weekAgo = Date.now() - 7 * 86400000;
    const newThisWeek = rows.filter(r => {
      const m = formMs(r.first_submitted_at);
      return Number.isFinite(m) && m >= weekAgo;
    }).length;

    res.json({
      timezone: FORM_REPORT_TZ,
      sort: appliedSort,
      summary: {
        total: rows.length,
        submissions: totalSubmissions,
        new_this_week: newThisWeek,
        part2_done: part2Done,
        part2_pending: rows.length - part2Done,
        completion_pct: rows.length > 0 ? Math.round((part2Done / rows.length) * 1000) / 10 : 0
      },
      rows
    });
  } catch (e) {
    console.error('Admin audit-requests summary error:', e.message);
    res.status(500).json({ error: 'Failed to load audit form status' });
  }
});

// --- Part-2: who has completed the follow-up, who is still stuck ---
app.get('/api/admin/part2-submissions/summary', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const search = String(req.query.search || '').trim();
    const sort = String(req.query.sort || 'status').trim().toLowerCase();
    const sc = buildContactSearchClause(
      search,
      ['a.first_name', 'a.last_name', 'a.email', "(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,''))"],
      ['a.phone']
    );
    const sql = buildIntakeCohortSql(from, to, sc.sql) + `
      SELECT p.*, p2.id AS part2_id, ${formTsIso('p2.created_at')} AS part2_at,
             p2.score AS part2_score, p2.tier_label AS part2_tier,
             COALESCE(p2c.n, 0) AS part2_submissions
      FROM people p
      ${INTAKE_PART2_LATERAL}
      LIMIT 5000`;
    const params = [];
    if (from) params.push(from);
    if (to) params.push(to);
    params.push(...sc.params);
    const raw = await queryAll(sql, params);

    const rows = raw.map(r => ({
      key: 'intake:' + String(r.gkey || ''),
      email_key: r.email_key || null,
      name: intakeDisplayName(r),
      email: String(r.email || '').trim(),
      phone: String(r.phone || '').trim(),
      status: r.part2_id ? 'submitted' : 'pending',
      unlinked: false,
      stage: r.stage || '',
      linked_user_id: r.linked_user_id || null,
      last_submitted_at: formIso(r.part2_at),
      last_checkin_id: r.part2_id ? String(r.part2_id) : null,
      part2_score: r.part2_score != null ? Number(r.part2_score) : null,
      part2_tier: r.part2_tier || '',
      audit_at: formIso(r.last_audit_at),
      first_audit_at: formIso(r.first_audit_at),
      audit_submissions: Number(r.audit_submissions) || 0,
      total_checkins: Number(r.part2_submissions) || 0
    }));

    // Part-2 submissions whose email matches no Audit record would otherwise be
    // invisible on their own tab, so surface them as unlinked cohort members.
    const orphanSearch = buildContactSearchClause(search, ['o.name', 'o.email'], ['o.mobile']);
    let orphans = [];
    try {
      orphans = await queryAll(`
        WITH orphan AS (
          SELECT x.id, x.name, x.email, x.mobile, x.created_at, x.score, x.tier_label,
                 COALESCE(NULLIF(LOWER(TRIM(x.email)), ''), 'id:' || x.id) AS gkey
          FROM part2_audit x
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_requests a
            WHERE NULLIF(LOWER(TRIM(a.email)), '') = NULLIF(LOWER(TRIM(x.email)), '')
          )
        )
        SELECT o.gkey,
               (ARRAY_AGG(o.name   ORDER BY o.created_at DESC NULLS LAST))[1] AS name,
               (ARRAY_AGG(o.email  ORDER BY o.created_at DESC NULLS LAST))[1] AS email,
               (ARRAY_AGG(o.mobile ORDER BY o.created_at DESC NULLS LAST))[1] AS phone,
               (ARRAY_AGG(o.id     ORDER BY o.created_at DESC NULLS LAST))[1] AS part2_id,
               (ARRAY_AGG(o.score  ORDER BY o.created_at DESC NULLS LAST))[1] AS part2_score,
               (ARRAY_AGG(o.tier_label ORDER BY o.created_at DESC NULLS LAST))[1] AS part2_tier,
               ${formTsIso('MAX(o.created_at)')} AS part2_at,
               COUNT(*)::int AS n
        FROM orphan o
        WHERE 1=1${orphanSearch.sql}
        GROUP BY o.gkey
        LIMIT 2000`, orphanSearch.params);
    } catch (oe) {
      console.warn('[part2 summary] orphan sweep failed:', oe.message);
    }
    orphans.forEach(o => rows.push({
      key: 'intake:' + String(o.gkey || ''),
      email_key: String(o.email || '').trim().toLowerCase() || null,
      name: String(o.name || '').trim() || String(o.email || '').trim() || '—',
      email: String(o.email || '').trim(),
      phone: String(o.phone || '').trim(),
      status: 'submitted',
      unlinked: true,
      stage: '',
      linked_user_id: null,
      last_submitted_at: formIso(o.part2_at),
      last_checkin_id: o.part2_id ? String(o.part2_id) : null,
      part2_score: o.part2_score != null ? Number(o.part2_score) : null,
      part2_tier: o.part2_tier || '',
      audit_at: null,
      first_audit_at: null,
      audit_submissions: 0,
      total_checkins: Number(o.n) || 0
    }));

    const appliedSort = formSortRows(rows, sort);
    const summary = formSummarize(rows);

    res.json({
      timezone: FORM_REPORT_TZ,
      sort: appliedSort,
      summary,
      rows
    });
  } catch (e) {
    console.error('Admin part2 summary error:', e.message);
    res.status(500).json({ error: 'Failed to load Part-2 status' });
  }
});

// --- Shared history for both intake tabs: one person's full Audit + Part-2 trail ---
app.get('/api/admin/intake-history', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const auditId = String(req.query.audit_id || '').trim();
    if (!email && !auditId) return res.status(400).json({ error: 'email or audit_id is required' });

    const audits = await queryAll(`
      SELECT id, first_name, last_name, email, phone, stage, status, goals, linked_user_id,
             ${formTsIso('created_at')} AS created_at
      FROM audit_requests
      WHERE (? <> '' AND NULLIF(LOWER(TRIM(email)), '') = ?)
         OR (? <> '' AND id = ?)
      ORDER BY created_at DESC NULLS LAST
      LIMIT 200`, [email || '', email || '', auditId || '', auditId || '']);

    // An audit_id lookup may resolve an email we were not given.
    const resolvedEmail = email || String((audits[0] && audits[0].email) || '').trim().toLowerCase();
    const part2 = resolvedEmail ? await queryAll(`
      SELECT id, name, email, mobile, score, tier_label, weak_lever,
             ${formTsIso('created_at')} AS created_at
      FROM part2_audit
      WHERE NULLIF(LOWER(TRIM(email)), '') = ?
      ORDER BY created_at DESC NULLS LAST
      LIMIT 200`, [resolvedEmail]) : [];

    const head = audits[0] || null;
    const p2head = part2[0] || null;
    res.json({
      person: {
        name: head
          ? ([head.first_name, head.last_name].filter(Boolean).join(' ').trim() || head.email || '—')
          : ((p2head && p2head.name) || resolvedEmail || '—'),
        email: (head && head.email) || (p2head && p2head.email) || resolvedEmail || '',
        phone: (head && head.phone) || (p2head && p2head.mobile) || '',
        stage: (head && head.stage) || '',
        lead_status: (head && head.status) || '',
        linked_user_id: (head && head.linked_user_id) || null,
        has_audit: audits.length > 0,
        has_part2: part2.length > 0
      },
      timezone: FORM_REPORT_TZ,
      audit_total: audits.length,
      part2_total: part2.length,
      audits: audits.map(a => ({
        id: String(a.id), created_at: a.created_at, stage: a.stage || '',
        status: a.status || '', goals: a.goals || ''
      })),
      part2: part2.map(p => ({
        id: String(p.id), created_at: p.created_at,
        score: p.score != null ? Number(p.score) : null,
        tier_label: p.tier_label || '', weak_lever: p.weak_lever || ''
      }))
    });
  } catch (e) {
    console.error('Admin intake history error:', e.message);
    res.status(500).json({ error: 'Failed to load intake history' });
  }
});

app.get('/api/admin/part2-submissions', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    let sql = 'SELECT * FROM part2_audit WHERE 1=1';
    const params = [];
    if (from) {
      sql += ' AND created_at::date >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at::date <= ?';
      params.push(to);
    }
    const p2Search = buildContactSearchClause(search, ['name', 'email'], ['mobile']);
    sql += p2Search.sql;
    params.push(...p2Search.params);
    // Group each client's submissions together; clients ordered by their most
    // recent submission, newest-first within a client.
    const clientKey = "COALESCE(NULLIF(LOWER(TRIM(email)), ''), CAST(id AS TEXT))";
    sql += ` ORDER BY MAX(created_at) OVER (PARTITION BY ${clientKey}) DESC, ${clientKey} ASC, created_at DESC LIMIT 250`;
    const rows = await queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Admin part2 list error:', e.message);
    res.status(500).json({ error: 'Failed to load Part-2 submissions' });
  }
});

app.get('/api/admin/sunday-checkins/:id/pdf', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM sunday_checkins WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Sunday check-in not found' });

    const reportsDir = path.join(__dirname, 'public', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const datePart = (row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
    const baseName = `sunday-checkin-${safeFilePart(row.full_name, 'client')}-${datePart}`;
    const fileName = `${baseName}-${Date.now()}.pdf`;
    const outputPath = path.join(reportsDir, fileName);
    const logoPath = path.join(__dirname, 'public', 'img', 'bodybank X fitchef logo.png');
    await writeSundayCheckinPdf({ outputPath, record: row, logoPath });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
    return res.sendFile(outputPath);
  } catch (e) {
    console.error('Admin sunday-checkin pdf error:', e.message);
    return res.status(500).json({ error: 'Failed to generate Sunday check-in PDF' });
  }
});

app.get('/api/admin/part2-submissions/:id/pdf', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM part2_audit WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Part-2 submission not found' });

    const reportsDir = path.join(__dirname, 'public', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const datePart = (row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
    const baseName = `part2-${safeFilePart(row.name, 'client')}-${datePart}`;
    const fileName = `${baseName}-${Date.now()}.pdf`;
    const outputPath = path.join(reportsDir, fileName);
    const logoPath = path.join(__dirname, 'public', 'img', 'bodybank X fitchef logo.png');
    await writePart2Pdf({ outputPath, record: row, logoPath });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
    return res.sendFile(outputPath);
  } catch (e) {
    console.error('Admin part2 pdf error:', e.message);
    return res.status(500).json({ error: 'Failed to generate Part-2 PDF' });
  }
});

// ============================================================
// LEADS PIPELINE — CRM-style state on top of audit_requests
// ============================================================
// Streamlined pipeline: pre-conversion stages only. Once a lead converts they
// become a trial member and are managed in the Memberships tab (billing lives there).
const LEAD_STAGE_IDS = [
  'new_audit', 'contacted', 'part2', 'call', 'converted', 'no_reply', 'lost'
];
const LEAD_STAGE_LABELS = {
  new_audit: 'New audit',
  contacted: 'Contacted',
  part2: 'Part-2',
  call: 'Call',
  converted: 'Converted',
  // Reached out and heard nothing back. Distinct from Lost, which is somebody
  // who actually said no — the two need different follow-up, and lumping them
  // together made the board read as failure when most of it is just silence.
  no_reply: 'No reply',
  lost: 'Lost / Cold'
};
// Maps legacy stage ids (pre-collapse) to the streamlined set above, so old leads
// and any cached references still resolve to a valid stage.
const LEAD_STAGE_ALIASES = {
  whatsapp_sent: 'contacted',
  in_conversation: 'contacted',
  no_response: 'no_reply',
  cold: 'no_reply',
  part2_sent: 'part2',
  part2_received: 'part2',
  call_proposed: 'call',
  call_scheduled: 'call',
  call_done: 'call',
  payment_pending: 'converted',
  onboarded: 'converted'
};
function normalizeStage(stage) {
  const s = String(stage || '').trim() || 'new_audit';
  if (LEAD_STAGE_IDS.indexOf(s) >= 0) return s;
  return LEAD_STAGE_ALIASES[s] || 'new_audit';
}

function leadAuthorFromReq(req) {
  const u = req.user || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
    u.email || (u.role === 'superadmin' ? 'Superadmin' : 'Admin');
  return { id: u.id || '', name };
}

async function appendLeadNote(auditId, author, body, kind, stageAtTime) {
  await run(
    'INSERT INTO lead_notes (id, audit_id, author_id, author_name, body, kind, stage_at_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), auditId, author.id || '', author.name || '', String(body || ''), kind || 'note', stageAtTime || '']
  );
}

// Bring back enough fields for the leads list, plus joined Part-2 status and notes count
async function loadLeadsList({ stage, search, from, to } = {}) {
  let sql = `
    SELECT a.*,
      (SELECT p.id FROM part2_audit p WHERE LOWER(p.email) = LOWER(a.email) ORDER BY p.created_at DESC LIMIT 1) AS part2_id,
      (SELECT p.created_at FROM part2_audit p WHERE LOWER(p.email) = LOWER(a.email) ORDER BY p.created_at DESC LIMIT 1) AS part2_at,
      (SELECT COUNT(*)::int FROM lead_notes ln WHERE ln.audit_id = a.id) AS notes_count,
      u.id AS account_id, u.subscription_status, u.created_at AS joined_at,
      (u.id IS NOT NULL) AS has_account,
      (u.id IS NOT NULL AND EXISTS (
         SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date >= CURRENT_DATE - 6 AND COALESCE(d.is_freeze, FALSE) = FALSE
         UNION ALL SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at >= NOW() - INTERVAL '7 days'
         UNION ALL SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date >= CURRENT_DATE - 6
      )) AS account_active
    FROM audit_requests a
    LEFT JOIN users u ON LOWER(u.email) = LOWER(a.email) AND u.role = 'user'
      AND COALESCE(u.suspended, FALSE) = FALSE
    WHERE 1=1`;
  const params = [];
  if (stage && LEAD_STAGE_IDS.indexOf(stage) >= 0) {
    sql += ' AND COALESCE(a.stage, \'new_audit\') = ?';
    params.push(stage);
  }
  if (from) { sql += ' AND a.created_at::date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.created_at::date <= ?'; params.push(to); }
  const leadSearch = buildContactSearchClause(
    search,
    ['a.first_name', 'a.last_name', 'a.email', '(COALESCE(a.first_name,\'\') || \' \' || COALESCE(a.last_name,\'\'))'],
    ['a.phone']
  );
  sql += leadSearch.sql;
  params.push(...leadSearch.params);
  sql += ' ORDER BY COALESCE(a.stage_changed_at, a.created_at) DESC LIMIT 500';
  return await queryAll(sql, params);
}

// LIST — for both kanban and table views
app.get('/api/admin/leads', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await loadLeadsList({
      stage: (req.query.stage || '').trim(),
      search: (req.query.search || '').trim(),
      from: (req.query.from || '').trim(),
      to: (req.query.to || '').trim()
    });
    // Clients who joined without ever submitting an audit had no row here at
    // all, so the board silently under-reported the business. Surface them as
    // read-only entries in Converted rather than leaving them out.
    const orphans = await queryAll(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.created_at,
             u.subscription_status, u.profile_picture,
             EXISTS (
               SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date >= CURRENT_DATE - 6 AND COALESCE(d.is_freeze, FALSE) = FALSE
               UNION ALL SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at >= NOW() - INTERVAL '7 days'
               UNION ALL SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date >= CURRENT_DATE - 6
             ) AS account_active
        FROM users u
       WHERE u.role = 'user'
         AND (u.approval_status IS NULL OR u.approval_status = 'approved')
         AND COALESCE(u.suspended, FALSE) = FALSE
         AND u.email NOT LIKE '%@test.bodybank.fit'
         AND LOWER(COALESCE(u.first_name, '')) NOT LIKE '%e2e%'
         AND NOT EXISTS (SELECT 1 FROM audit_requests a WHERE LOWER(a.email) = LOWER(u.email))
       ORDER BY u.created_at DESC LIMIT 300`);

    res.json({
      stages: LEAD_STAGE_IDS.map(id => ({ id, label: LEAD_STAGE_LABELS[id] })),
      leads: rows,
      members: (orphans || []).map(m => ({
        id: 'member:' + m.id, account_id: m.id, virtual: true,
        first_name: m.first_name, last_name: m.last_name, email: m.email, phone: m.phone,
        created_at: m.created_at, stage: 'converted', has_account: true,
        subscription_status: m.subscription_status, account_active: m.account_active,
        profile_picture: m.profile_picture, notes_count: 0
      }))
    });
  } catch (e) {
    console.error('Admin leads list error:', e.message);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

// "Today" widget — what's on my plate right now
app.get('/api/admin/leads/today', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const summaryRows = await queryAll(
      "SELECT COALESCE(stage, 'new_audit') AS stage, COUNT(*)::int AS count FROM audit_requests GROUP BY COALESCE(stage, 'new_audit')"
    );
    const counts = {};
    LEAD_STAGE_IDS.forEach(s => { counts[s] = 0; });
    summaryRows.forEach(r => { if (counts.hasOwnProperty(r.stage)) counts[r.stage] = r.count; });

    const callsToday = await queryAll(
      `SELECT id, first_name, last_name, email, phone, call_scheduled_at, COALESCE(stage,'new_audit') AS stage
       FROM audit_requests
       WHERE call_scheduled_at IS NOT NULL
         AND call_scheduled_at::date = CURRENT_DATE
       ORDER BY call_scheduled_at ASC LIMIT 20`
    );
    const pendingOutreach = await queryAll(
      `SELECT id, first_name, last_name, email, phone, created_at
       FROM audit_requests
       WHERE COALESCE(stage,'new_audit') = 'new_audit'
       ORDER BY created_at ASC LIMIT 20`
    );
    const stuckPart2 = await queryAll(
      `SELECT id, first_name, last_name, email, phone, stage_changed_at
       FROM audit_requests
       WHERE COALESCE(stage,'new_audit') = 'part2'
         AND COALESCE(stage_changed_at, created_at) < NOW() - INTERVAL '7 days'
       ORDER BY stage_changed_at ASC LIMIT 20`
    );
    // Calls that have already happened (scheduled time in the past) but the lead is
    // still parked in the 'call' stage — they need a convert/lost decision.
    const afterCall = await queryAll(
      `SELECT id, first_name, last_name, email, phone, call_scheduled_at AS stage_changed_at
       FROM audit_requests
       WHERE COALESCE(stage,'new_audit') = 'call'
         AND call_scheduled_at IS NOT NULL
         AND call_scheduled_at < NOW()
       ORDER BY call_scheduled_at ASC LIMIT 20`
    );
    const lostThisWeekRow = await queryOne(
      `SELECT COUNT(*)::int AS count FROM audit_requests
       WHERE COALESCE(stage,'new_audit') = 'lost'
         AND COALESCE(stage_changed_at, created_at) >= NOW() - INTERVAL '7 days'`
    );

    res.json({
      counts,
      stage_labels: LEAD_STAGE_LABELS,
      calls_today: callsToday,
      pending_outreach: pendingOutreach,
      stuck_part2: stuckPart2,
      after_call: afterCall,
      lost_this_week: lostThisWeekRow ? lostThisWeekRow.count : 0
    });
  } catch (e) {
    console.error('Admin leads/today error:', e.message);
    res.status(500).json({ error: 'Failed to load today widget' });
  }
});

// DETAIL — audit + Part-2 + linked user + notes timeline
app.get('/api/admin/leads/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const lead = await queryOne('SELECT * FROM audit_requests WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const part2 = await queryOne(
      'SELECT * FROM part2_audit WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1',
      [lead.email || '']
    );
    const linkedUser = lead.linked_user_id
      ? await queryOne('SELECT id, email, first_name, last_name, role, approval_status, subscription_status, access_expires_at, plan_label, created_at FROM users WHERE id = ?', [lead.linked_user_id])
      : await queryOne('SELECT id, email, first_name, last_name, role, approval_status, subscription_status, access_expires_at, plan_label, created_at FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [lead.email || '']);
    const notes = await queryAll(
      'SELECT id, author_id, author_name, body, kind, stage_at_time, created_at FROM lead_notes WHERE audit_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({
      lead,
      part2: part2 || null,
      linked_user: linkedUser || null,
      notes,
      stages: LEAD_STAGE_IDS.map(id => ({ id, label: LEAD_STAGE_LABELS[id] }))
    });
  } catch (e) {
    console.error('Admin leads detail error:', e.message);
    res.status(500).json({ error: 'Failed to load lead' });
  }
});

// CHANGE STAGE — also writes an automatic timeline entry
app.patch('/api/admin/leads/:id/stage', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const stage = String((req.body && req.body.stage) || '').trim();
    if (LEAD_STAGE_IDS.indexOf(stage) < 0) return res.status(400).json({ error: 'Invalid stage' });
    const lead = await queryOne('SELECT id, stage FROM audit_requests WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const lostReason = stage === 'lost' ? String((req.body && req.body.lost_reason) || '').trim() : '';
    await run(
      `UPDATE audit_requests
       SET stage = ?, stage_changed_at = NOW(), last_contact_at = NOW(),
           lost_reason = CASE WHEN ? = 'lost' THEN ? ELSE COALESCE(lost_reason, '') END
       WHERE id = ?`,
      [stage, stage, lostReason, req.params.id]
    );
    const author = leadAuthorFromReq(req);
    const fromLabel = LEAD_STAGE_LABELS[normalizeStage(lead.stage)] || 'New audit';
    const toLabel = LEAD_STAGE_LABELS[stage] || stage;
    let entry = `Stage: ${fromLabel} → ${toLabel}`;
    if (stage === 'lost' && lostReason) entry += ` (reason: ${lostReason})`;
    await appendLeadNote(req.params.id, author, entry, 'stage_change', stage);
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin leads stage update error:', e.message);
    res.status(500).json({ error: 'Failed to update stage' });
  }
});

// ADD NOTE — manual timeline entry
app.post('/api/admin/leads/:id/notes', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Note cannot be empty' });
    if (body.length > 4000) return res.status(400).json({ error: 'Note too long (max 4000 chars)' });
    const lead = await queryOne('SELECT id, stage FROM audit_requests WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const author = leadAuthorFromReq(req);
    await appendLeadNote(req.params.id, author, body, 'note', lead.stage || 'new_audit');
    await run('UPDATE audit_requests SET last_contact_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin leads add note error:', e.message);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// SCHEDULE CALL — datetime + auto-bump stage to call_scheduled if not past it
app.patch('/api/admin/leads/:id/call', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const lead = await queryOne('SELECT id, stage FROM audit_requests WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const raw = (req.body && req.body.call_scheduled_at) || '';
    if (!raw) {
      await run('UPDATE audit_requests SET call_scheduled_at = NULL WHERE id = ?', [req.params.id]);
      const author = leadAuthorFromReq(req);
      await appendLeadNote(req.params.id, author, 'Call schedule cleared', 'call', lead.stage || 'new_audit');
      return res.json({ ok: true });
    }
    const dt = new Date(raw);
    if (isNaN(dt.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
    let newStage = normalizeStage(lead.stage);
    const preCall = ['new_audit', 'contacted', 'part2'];
    if (preCall.indexOf(newStage) >= 0) newStage = 'call';
    await run(
      `UPDATE audit_requests
       SET call_scheduled_at = ?, stage = ?, stage_changed_at = NOW(), last_contact_at = NOW()
       WHERE id = ?`,
      [dt.toISOString(), newStage, req.params.id]
    );
    const author = leadAuthorFromReq(req);
    await appendLeadNote(req.params.id, author, `Call scheduled for ${dt.toLocaleString()}`, 'call', newStage);
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin leads schedule call error:', e.message);
    res.status(500).json({ error: 'Failed to schedule call' });
  }
});

// LINK to existing BodyBank user — looks up by email; admin can also pass user_id
app.post('/api/admin/leads/:id/link-user', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const lead = await queryOne('SELECT id, email, stage FROM audit_requests WHERE id = ?', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const explicitId = String((req.body && req.body.user_id) || '').trim();
    let user = null;
    if (explicitId) {
      user = await queryOne('SELECT id, email, first_name, last_name FROM users WHERE id = ?', [explicitId]);
    }
    if (!user) {
      user = await queryOne('SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [lead.email || '']);
    }
    if (!user) return res.status(404).json({ error: 'No BodyBank user found with that email. Ask the user to sign up first.' });
    await run(
      `UPDATE audit_requests
       SET linked_user_id = ?, stage = 'converted', stage_changed_at = NOW(), last_contact_at = NOW()
       WHERE id = ?`,
      [user.id, req.params.id]
    );
    const author = leadAuthorFromReq(req);
    await appendLeadNote(req.params.id, author, `Linked to user ${user.email} — marked Converted (manage billing in Memberships)`, 'stage_change', 'converted');
    res.json({ ok: true, user });
  } catch (e) {
    console.error('Admin leads link-user error:', e.message);
    res.status(500).json({ error: 'Failed to link user' });
  }
});

app.get('/api/admin/workouts', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    let sql = `SELECT w.*, u.first_name, u.last_name, u.email, u.phone
       FROM workout_logs w
       JOIN users u ON w.user_id = u.id
       WHERE 1=1`;
    const params = [];
    if (from) {
      sql += ' AND w.created_at::date >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND w.created_at::date <= ?';
      params.push(to);
    }
    const woSearch = buildContactSearchClause(
      search,
      ['u.first_name', 'u.last_name', 'u.email', 'w.workout_name', 'COALESCE(w.workout_type,\'\')', 'COALESCE(w.feedback,\'\')'],
      ['u.phone']
    );
    sql += woSearch.sql;
    params.push(...woSearch.params);
    sql += ' ORDER BY w.created_at DESC LIMIT 250';
    const rows = await queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Admin workouts list error:', e.message);
    res.status(500).json({ error: 'Failed to load workouts' });
  }
});

app.get('/api/admin/workouts/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT w.*, u.first_name, u.last_name, u.email, u.phone
       FROM workout_logs w JOIN users u ON u.id = w.user_id WHERE w.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    console.error('Admin workout detail error:', e.message);
    res.status(500).json({ error: 'Failed to load workout' });
  }
});

// ============ TODAY DASHBOARD ============
app.get('/api/today', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const [checkin, meetings, workouts, lastMessageRow] = await Promise.all([
      queryOne('SELECT * FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]),
      queryAll("SELECT * FROM meetings WHERE user_id = ? AND status != 'cancelled' ORDER BY meeting_date ASC, time_slot ASC", [userId]),
      queryAll('SELECT * FROM workout_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]),
      queryOne('SELECT tm.body, tm.created_at, tm.sender_role, mt.id as thread_id FROM thread_messages tm JOIN message_threads mt ON mt.id = tm.thread_id WHERE mt.user_id = ? ORDER BY tm.created_at DESC LIMIT 1', [userId])
    ]);
    const lastMessage = lastMessageRow ? { body: lastMessageRow.body, created_at: lastMessageRow.created_at, sender_role: lastMessageRow.sender_role, thread_id: lastMessageRow.thread_id } : null;
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString();
    const sundayRows = await queryAll("SELECT id, created_at FROM sunday_checkins WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1", [userId, weekStartStr]);
    const pendingCheckin = sundayRows.length === 0;
    const upcomingMeetings = (meetings || []).filter(m => new Date(m.meeting_date + 'T12:00:00') >= new Date()).slice(0, 1);
    res.json({
      checkin: checkin || null,
      nextMeeting: upcomingMeetings[0] || null,
      lastWorkout: workouts && workouts[0] ? workouts[0] : null,
      lastMessage: lastMessage || null,
      pendingSundayCheckin: pendingCheckin
    });
  } catch (e) {
    console.error('Today API error:', e.message);
    res.status(500).json({ error: 'Failed to load today data' });
  }
});

// ============ HOME AGGREGATE — one call powers the unified "Today" screen ============
// Each section is independently try/caught so a single slow/failing piece degrades to null
// instead of failing the whole payload. This replaces ~8 separate round-trips on home load.
app.get('/api/me/home', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const out = { profile: null, today: null, streak: null, series: null, mind: null, coins: null, scorecard: null };
  // Profile + goals (also tells the client whether to show first-run onboarding)
  let _utz = STREAK_TIMEZONE;
  try {
    const u = await queryOne(
      `SELECT id, first_name, last_name, profile_picture, height_cm, timezone, created_at,
              onboarded_at, guide_seen_at, goal_type,
              COALESCE(goal_steps, 8000) AS goal_steps,
              COALESCE(goal_water_ml, 3000) AS goal_water_ml,
              COALESCE(goal_protein_g, 120) AS goal_protein_g,
              COALESCE(goal_sleep_hours, 7.5) AS goal_sleep_hours
         FROM users WHERE id = ?`,
      [userId]
    );
    if (u) {
      _utz = (u.timezone) ? u.timezone : STREAK_TIMEZONE;
      out.profile = {
        id: u.id, first_name: u.first_name || '', last_name: u.last_name || '',
        profile_picture: u.profile_picture || '', height_cm: u.height_cm || null,
        goal_type: u.goal_type || '',
        onboarded: !!u.onboarded_at,
        guideSeen: !!u.guide_seen_at,
        goals: {
          steps: u.goal_steps, water_ml: u.goal_water_ml,
          protein_g: u.goal_protein_g, sleep_hours: u.goal_sleep_hours
        }
      };
    }
  } catch (e) { console.warn('[home] profile:', e.message); }
  // Six independent reads. The profile has to land first (it carries the
  // timezone the day boundaries are computed in); the rest no longer wait
  // on each other. Each keeps its own catch, so one failing section still
  // returns the others exactly as before.
  await Promise.all([
    (async () => {
      // Today (mirror of /api/today)
      try {
        const today = streakTodayYmdInTz(_utz) || streakDateToYmd(new Date());
        const [checkin, meetings, workouts, lastMessageRow] = await Promise.all([
          queryOne('SELECT * FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]),
          queryAll("SELECT * FROM meetings WHERE user_id = ? AND status != 'cancelled' ORDER BY meeting_date ASC, time_slot ASC", [userId]),
          queryAll('SELECT * FROM workout_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]),
          queryOne('SELECT tm.body, tm.created_at, tm.sender_role, mt.id as thread_id FROM thread_messages tm JOIN message_threads mt ON mt.id = tm.thread_id WHERE mt.user_id = ? ORDER BY tm.created_at DESC LIMIT 1', [userId])
        ]);
        const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
        const sundayRows = await queryAll("SELECT id FROM sunday_checkins WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1", [userId, weekStart.toISOString()]);
        const upcoming = (meetings || []).filter(m => new Date(m.meeting_date + 'T12:00:00') >= new Date()).slice(0, 1);
        out.today = {
          checkin: checkin ? attachWaterLitersToDailyRow(checkin) : null,
          nextMeeting: upcoming[0] || null,
          lastWorkout: (workouts && workouts[0]) || null,
          lastMessage: lastMessageRow ? { body: lastMessageRow.body, created_at: lastMessageRow.created_at, sender_role: lastMessageRow.sender_role, thread_id: lastMessageRow.thread_id } : null,
          pendingSundayCheckin: sundayRows.length === 0
        };
      } catch (e) { console.warn('[home] today:', e.message); }
    })(),
    (async () => {
      // Streak (lightweight mirror of /api/daily-checkin/streak)
      try {
        const rows = await queryAll('SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, COALESCE(is_freeze, FALSE) AS is_freeze FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365', [userId]);
        if (rows && rows.length) {
          const { today, todaySaved, streak, dates } = computeStreakState(rows, null, _utz);
          const atRisk = !todaySaved && streak > 0;
          const now = new Date();
          const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
          const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
          const wk = rows.filter(r => new Date(r.checkin_date) >= weekStart && !r.is_freeze);
          const ym = String(today).slice(0, 7);
          const freezeUsedThisMonth = rows.filter(r => r.is_freeze && streakDateToYmd(r.checkin_date) && String(streakDateToYmd(r.checkin_date)).slice(0, 7) === ym).length;
          // Freeze recovers a streak broken by a single missed day: offer it only when
          // yesterday is missing but the day before was a check-in (a chain worth saving).
          const yDay = streakAddDays(today, -1);
          const d2Day = streakAddDays(today, -2);
          const freezeAvailable = freezeUsedThisMonth < 1 && !!d2Day && dates.has(d2Day) && !dates.has(yDay);
          out.streak = {
            streak, todaySaved: !!todaySaved, atRisk: !!atRisk,
            secondsUntilMidnight: atRisk ? Math.max(0, Math.floor((midnight - now) / 1000)) : null,
            checkinsThisWeek: Math.min(7, wk.length),
            freezeAvailable,
            weekly: {
              avgSteps: wk.length ? Math.round(wk.reduce((s, r) => s + (r.steps || 0), 0) / wk.length) : null,
              avgWater: wk.length ? Math.round((wk.reduce((s, r) => s + (r.water_ml || 0), 0) / wk.length / 1000) * 100) / 100 : null,
              avgProtein: wk.length ? Math.round(wk.reduce((s, r) => s + (r.protein_g || 0), 0) / wk.length) : null,
              avgSleep: wk.length ? (wk.reduce((s, r) => s + (r.sleep_hours || 0), 0) / wk.length).toFixed(1) : null
            }
          };
          // 7-day series per metric (for the Pulse card sparklines) — real check-ins only
          const byDay = {};
          rows.forEach((r) => { const d = streakDateToYmd(r.checkin_date); if (d && !r.is_freeze) byDay[d] = r; });
          const days = [], sSteps = [], sWater = [], sProt = [], sSleep = [];
          for (let i = 6; i >= 0; i--) {
            const d = streakAddDays(today, -i);
            days.push(d);
            const r = byDay[d];
            sSteps.push(r && r.steps != null ? r.steps : 0);
            sWater.push(r && r.water_ml != null ? r.water_ml : 0);
            sProt.push(r && r.protein_g != null ? r.protein_g : 0);
            sSleep.push(r && r.sleep_hours != null ? r.sleep_hours : 0);
          }
          out.series = { days, steps: sSteps, water_ml: sWater, protein_g: sProt, sleep_hours: sSleep };
        } else {
          out.streak = { streak: 0, todaySaved: false, atRisk: false, secondsUntilMidnight: null, weekly: {} };
          out.series = null;
        }
      } catch (e) { console.warn('[home] streak:', e.message); }
    })(),
    (async () => {
      // Mind exercises completed today
      try {
        const today = streakTodayYmdInTz(_utz) || streakDateToYmd(new Date());
        const rows = await queryAll('SELECT exercise_key FROM mind_checkins WHERE user_id = ? AND checkin_date = ?::date', [userId, today]);
        out.mind = { completed: (rows || []).map(r => r.exercise_key) };
      } catch (e) { console.warn('[home] mind:', e.message); }
    })(),
    (async () => {
      // Coins
      try { out.coins = await coinService.getCoinSummary({ run, queryOne, queryAll }, userId); }
      catch (e) { console.warn('[home] coins:', e.message); }
    })(),
    (async () => {
      // Scorecard — this week's total, trend vs last week, and the 4 pillars (score + weight%)
      try {
        const ws = scorecardSvc.normalizeWeekStart('');
        const cur = await scorecardSvc.computeWeeklyScore(userId, ws);
        if (cur) {
          let trend = null;
          try {
            const pw = scorecardSvc.previousWeekStart(ws);
            const prev = pw ? await scorecardSvc.computeWeeklyScore(userId, pw) : null;
            if (prev) trend = cur.total - prev.total;
          } catch (_) {}
          const w = cur.weights || {};
          const pct = (x) => Math.round((x || 0) * 100);
          out.scorecard = {
            total: cur.total,
            week_label: cur.week_label,
            trend_delta: trend,
            pillars: [
              { key: 'daily', label: 'Daily', score: cur.daily, weight: pct(w.daily) },
              { key: 'workouts', label: 'Workouts', score: cur.workouts, weight: pct(w.workouts) },
              { key: 'sunday', label: 'Sunday', score: cur.sunday, weight: pct(w.sunday) },
              { key: 'progress', label: 'Progress', score: cur.progress, weight: pct(w.progress) }
            ]
          };
        } else { out.scorecard = null; }
      } catch (e) { console.warn('[home] scorecard:', e.message); }
    })()
  ]);
  res.json(out);
});

// Save first-run onboarding (goal + daily targets) and mark the user onboarded.
app.post('/api/me/onboarding', verifyToken, async (req, res) => {
  try {
    const b = req.body || {};
    const clampInt = (v, min, max, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
    const clampFloat = (v, min, max, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
    const goalType = String(b.goal_type || '').slice(0, 40);
    const steps = clampInt(b.goal_steps, 0, 100000, 8000);
    const waterMl = clampInt(b.goal_water_ml, 0, 15000, 3000);
    const proteinG = clampInt(b.goal_protein_g, 0, 500, 120);
    const sleepH = clampFloat(b.goal_sleep_hours, 0, 24, 7.5);
    await run(
      `UPDATE users SET goal_type = COALESCE(NULLIF(?, ''), goal_type), goal_steps = ?, goal_water_ml = ?, goal_protein_g = ?, goal_sleep_hours = ?, onboarded_at = COALESCE(onboarded_at, NOW()) WHERE id = ?`,
      [goalType, steps, waterMl, proteinG, sleepH, req.user.id]
    );
    res.json({ ok: true, goals: { steps, water_ml: waterMl, protein_g: proteinG, sleep_hours: sleepH }, goal_type: goalType });
  } catch (e) {
    console.error('[onboarding]', e.message);
    res.status(500).json({ error: 'Failed to save onboarding' });
  }
});

// Mark the first-run app guide as seen (idempotent — only stamps the first time, so it never re-shows).
app.post('/api/me/guide-seen', verifyToken, async (req, res) => {
  try {
    await run(`UPDATE users SET guide_seen_at = COALESCE(guide_seen_at, NOW()) WHERE id = ?`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[guide-seen]', e.message);
    res.status(500).json({ error: 'Failed to save guide state' });
  }
});

// Weekly Insights & Health Debt — accurate, timezone-aware, real calendar week (Sun→today).
// Daily goals live on the users table; weekly target = daily × 7. Debt is computed on the
// last COMPLETED week (so it isn't misleading mid-week); recovery target = this week's target + last week's debt.
app.get('/api/me/weekly-insights', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const u = await queryOne(
      `SELECT timezone,
              COALESCE(goal_steps, 8000)      AS goal_steps,
              COALESCE(goal_water_ml, 3000)   AS goal_water_ml,
              COALESCE(goal_protein_g, 120)   AS goal_protein_g,
              COALESCE(goal_sleep_hours, 7.5) AS goal_sleep_hours
         FROM users WHERE id = ?`,
      [userId]
    );
    const tz = (u && u.timezone) ? u.timezone : STREAK_TIMEZONE;
    const goals = {
      steps: Number(u && u.goal_steps) || 8000,
      water_ml: Number(u && u.goal_water_ml) || 3000,
      protein_g: Number(u && u.goal_protein_g) || 120,
      sleep_hours: Number(u && u.goal_sleep_hours) || 7.5
    };

    const today = streakTodayYmdInTz(tz) || streakDateToYmd(new Date());
    const parts = String(today).split('-').map((n) => parseInt(n, 10));
    const dow = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay(); // 0=Sun..6=Sat
    const weekStart = streakAddDays(today, -dow);            // Sunday of this week
    const weekEnd = streakAddDays(weekStart, 6);             // Saturday
    const lastWeekStart = streakAddDays(weekStart, -7);
    const lastWeekEnd = streakAddDays(weekStart, -1);
    const daysElapsed = dow + 1;                             // Sun=1 .. Sat=7
    const daysRemaining = 7 - daysElapsed;

    const rows = await queryAll(
      `SELECT checkin_date,
              COALESCE(steps, 0)        AS steps,
              COALESCE(water_ml, 0)     AS water_ml,
              COALESCE(protein_g, 0)    AS protein_g,
              COALESCE(sleep_hours, 0)  AS sleep_hours,
              COALESCE(is_freeze, FALSE) AS is_freeze
         FROM daily_checkins
        WHERE user_id = ? AND checkin_date >= ?::date AND checkin_date <= ?::date`,
      [userId, lastWeekStart, today]
    );

    const sumWeek = (start, end) => {
      const acc = { steps: 0, water_ml: 0, protein_g: 0, sleep_hours: 0, days: 0 };
      (rows || []).forEach((r) => {
        if (r.is_freeze) return;
        const ymd = streakDateToYmd(r.checkin_date);
        if (!ymd || ymd < start || ymd > end) return;
        acc.steps += Number(r.steps) || 0;
        acc.water_ml += Number(r.water_ml) || 0;
        acc.protein_g += Number(r.protein_g) || 0;
        acc.sleep_hours += Number(r.sleep_hours) || 0;
        acc.days += 1;
      });
      return acc;
    };
    const thisWeek = sumWeek(weekStart, today);
    const lastWeek = sumWeek(lastWeekStart, lastWeekEnd);

    const cap = (x) => Math.max(0, Math.min(100, x));
    const r1 = (x) => Math.round(x * 10) / 10;
    const buildMetric = (key) => {
      const daily = goals[key];
      const target = daily * 7;                       // full-week target
      const actual = thisWeek[key];                   // achieved so far this week
      const expectedByNow = daily * daysElapsed;      // on-pace expectation by today
      const lwActual = lastWeek[key];
      const lwDebt = Math.max(0, target - lwActual);  // debt from the COMPLETED last week
      return {
        daily,
        target,
        actual,
        progressPct: r1(target > 0 ? (actual / target) * 100 : 0),
        expectedByNow,
        pacePct: r1(expectedByNow > 0 ? (actual / expectedByNow) * 100 : 0),
        onPace: actual >= expectedByNow,
        remaining: Math.max(0, target - actual),
        lastWeekActual: lwActual,
        lastWeekDebt: lwDebt,
        recoveryTarget: target + lwDebt
      };
    };
    const metrics = {
      steps: buildMetric('steps'),
      water: buildMetric('water_ml'),
      protein: buildMetric('protein_g'),
      sleep: buildMetric('sleep_hours')
    };
    const consistency = Math.round(
      (cap(metrics.steps.pacePct) + cap(metrics.water.pacePct) + cap(metrics.protein.pacePct) + cap(metrics.sleep.pacePct)) / 4
    );

    // Per-day completion for this week (Sun..Sat) — overall % of that day's 4 goals met. Future days = null.
    const dayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const byYmd = {};
    (rows || []).forEach((r) => { if (r.is_freeze) return; const y = streakDateToYmd(r.checkin_date); if (y) byYmd[y] = r; });
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const dymd = streakAddDays(weekStart, i);
      const future = dymd > today;
      const r = byYmd[dymd];
      let completion = null;
      if (!future) {
        const frac = (
          Math.min(1, (Number(r && r.steps) || 0) / (goals.steps || 1)) +
          Math.min(1, (Number(r && r.water_ml) || 0) / (goals.water_ml || 1)) +
          Math.min(1, (Number(r && r.protein_g) || 0) / (goals.protein_g || 1)) +
          Math.min(1, (Number(r && r.sleep_hours) || 0) / (goals.sleep_hours || 1))
        ) / 4;
        completion = Math.round(frac * 100);
      }
      weekDays.push({ ymd: dymd, label: dayLetters[i], completion, logged: !!r, future, isToday: dymd === today });
    }

    res.json({
      tz, today, weekStart, weekEnd, lastWeekStart, lastWeekEnd,
      daysElapsed, daysRemaining,
      goals,
      weeklyTarget: { steps: goals.steps * 7, water_ml: goals.water_ml * 7, protein_g: goals.protein_g * 7, sleep_hours: goals.sleep_hours * 7 },
      thisWeek, lastWeek, metrics, consistency, weekDays
    });
  } catch (e) {
    console.error('[weekly-insights]', e.message);
    res.status(500).json({ error: 'Failed to load weekly insights' });
  }
});

// Weekly Report — rich last-COMPLETED-week breakdown (per-day bars, prior-week deltas,
// overall score, goals hit, best days, streak, cumulative steps). Reusable for the
// dashboard AND the admin PDF (callable for any userId).
async function buildWeeklyReport(userId) {
  const u = await queryOne(
    `SELECT timezone, first_name, last_name, email, dob,
            COALESCE(goal_steps, 8000) gs, COALESCE(goal_water_ml, 3000) gw,
            COALESCE(goal_protein_g, 120) gp, COALESCE(goal_sleep_hours, 7.5) gsl
       FROM users WHERE id = ?`, [userId]);
  if (!u) return null;
  const tz = u.timezone || STREAK_TIMEZONE;
  const goals = { steps: Number(u.gs) || 8000, water_ml: Number(u.gw) || 3000, protein_g: Number(u.gp) || 120, sleep_hours: Number(u.gsl) || 7.5 };

  const today = streakTodayYmdInTz(tz) || streakDateToYmd(new Date());
  const p = String(today).split('-').map((n) => parseInt(n, 10));
  const dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  const thisWeekStart = streakAddDays(today, -dow);
  const lastWeekStart = streakAddDays(thisWeekStart, -7);
  const lastWeekEnd = streakAddDays(thisWeekStart, -1);
  const prevWeekStart = streakAddDays(thisWeekStart, -14);
  const prevWeekEnd = streakAddDays(thisWeekStart, -8);

  const rows = await queryAll(
    `SELECT checkin_date, COALESCE(steps,0) steps, COALESCE(water_ml,0) water_ml,
            COALESCE(protein_g,0) protein_g, COALESCE(sleep_hours,0) sleep_hours, COALESCE(is_freeze,false) is_freeze
       FROM daily_checkins WHERE user_id = ? AND checkin_date >= ?::date AND checkin_date <= ?::date`,
    [userId, prevWeekStart, lastWeekEnd]);
  const byYmd = {};
  (rows || []).forEach((r) => { if (r.is_freeze) return; const y = streakDateToYmd(r.checkin_date); if (y) byYmd[y] = r; });

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayName(start, i) {
    const d = streakAddDays(start, i);
    const dp = String(d).split('-').map((n) => parseInt(n, 10));
    return DOW[new Date(Date.UTC(dp[0], dp[1] - 1, dp[2])).getUTCDay()];
  }
  function sumWeek(start) {
    const s = { steps: 0, water_ml: 0, protein_g: 0, sleep_hours: 0, days: 0 };
    for (let i = 0; i < 7; i++) { const r = byYmd[streakAddDays(start, i)]; if (!r) continue; s.steps += Number(r.steps) || 0; s.water_ml += Number(r.water_ml) || 0; s.protein_g += Number(r.protein_g) || 0; s.sleep_hours += Number(r.sleep_hours) || 0; s.days++; }
    return s;
  }
  const lastSum = sumWeek(lastWeekStart);
  const prevSum = sumWeek(prevWeekStart);
  const mk = (m) => (m === 'steps' ? 'steps' : m === 'water_ml' ? 'water' : m === 'protein_g' ? 'protein' : 'sleep');

  function buildMetric(m) {
    const dailyGoal = goals[m];
    const target = dailyGoal * 7;
    const actual = lastSum[m];
    const prevActual = prevSum[m];
    const achievementPct = target > 0 ? Math.round((actual / target) * 1000) / 10 : 0;
    const days = [];
    let bestVal = -1, bestLabel = '', daysLogged = 0;
    for (let i = 0; i < 7; i++) {
      const r = byYmd[streakAddDays(lastWeekStart, i)];
      const val = r ? (Number(r[m]) || 0) : 0;
      const lbl = dayName(lastWeekStart, i);
      days.push({ label: lbl, value: val, hitGoal: val >= dailyGoal });
      if (r) daysLogged++;
      if (val > bestVal) { bestVal = val; bestLabel = lbl; }
    }
    const dailyAvg = daysLogged > 0 ? actual / daysLogged : 0;
    const vsPrevPct = prevActual > 0 ? Math.round(((actual - prevActual) / prevActual) * 100) : null;
    return {
      key: mk(m), dailyGoal, target, actual,
      achievementPct, status: achievementPct >= 90 ? 'on_track' : 'behind',
      days, dailyAvg: Math.round(dailyAvg * 10) / 10,
      bestDay: { label: bestLabel, value: bestVal < 0 ? 0 : bestVal }, vsPrevPct
    };
  }
  const metrics = { steps: buildMetric('steps'), water: buildMetric('water_ml'), protein: buildMetric('protein_g'), sleep: buildMetric('sleep_hours') };

  const cap = (x) => Math.max(0, Math.min(100, x));
  const overallScore = Math.round((cap(metrics.steps.achievementPct) + cap(metrics.water.achievementPct) + cap(metrics.protein.achievementPct) + cap(metrics.sleep.achievementPct)) / 4);
  const goalsHit = ['steps', 'water', 'protein', 'sleep'].filter((k) => metrics[k].achievementPct >= 90).length;

  let cum = 0; const stepSeries = [];
  for (let i = 0; i < 7; i++) { const r = byYmd[streakAddDays(lastWeekStart, i)]; cum += r ? (Number(r.steps) || 0) : 0; stepSeries.push({ label: dayName(lastWeekStart, i), cumulative: cum }); }
  const totalProgress = { value: cum, vsPrevPct: prevSum.steps > 0 ? Math.round(((lastSum.steps - prevSum.steps) / prevSum.steps) * 100) : null, series: stepSeries };

  const dayHits = [];
  for (let i = 0; i < 7; i++) {
    const r = byYmd[streakAddDays(lastWeekStart, i)]; let hits = 0;
    if (r) { if ((Number(r.steps) || 0) >= goals.steps) hits++; if ((Number(r.water_ml) || 0) >= goals.water_ml) hits++; if ((Number(r.protein_g) || 0) >= goals.protein_g) hits++; if ((Number(r.sleep_hours) || 0) >= goals.sleep_hours) hits++; }
    dayHits.push({ label: dayName(lastWeekStart, i), hits });
  }
  const maxHits = dayHits.reduce((mx, x) => Math.max(mx, x.hits), 0);
  const mostConsistentDays = maxHits > 0 ? dayHits.filter((x) => x.hits === maxHits).map((x) => x.label) : [];

  let streak = 0;
  try { const sr = await queryAll('SELECT checkin_date, COALESCE(is_freeze,false) is_freeze FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365', [userId]); streak = (computeStreakState(sr, null, tz) || {}).streak || 0; } catch (_) {}

  return {
    user: { first_name: u.first_name || '', last_name: u.last_name || '', email: u.email || '' },
    tz, weekStart: lastWeekStart, weekEnd: lastWeekEnd, prevWeekStart, prevWeekEnd,
    goals, overallScore, goalsHit, goalsTotal: 4, streak,
    metrics, totalProgress,
    highlights: { mostConsistentDays, goalsHit, goalsTotal: 4, streak, vsPrevPct: totalProgress.vsPrevPct }
  };
}

app.get('/api/me/weekly-report', verifyToken, async (req, res) => {
  try {
    const report = await buildWeeklyReport(req.user.id);
    if (!report) return res.status(404).json({ error: 'User not found' });
    res.json(report);
  } catch (e) {
    console.error('[weekly-report]', e.message);
    res.status(500).json({ error: 'Failed to build weekly report' });
  }
});

// Admin: generate the last-week PDF report for a user and email it to them (or just produce the link).
// Body { send:false } produces the PDF + download link without emailing.
app.post('/api/admin/users/:userId/weekly-report', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const report = await buildWeeklyReport(userId);
    if (!report) return res.status(404).json({ error: 'User not found' });

    const fs = require('fs');
    const reportsDir = path.join(__dirname, 'public', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const fileName = `weekly-report-${userId}-${report.weekStart}-${Date.now()}.pdf`;
    const outputPath = path.join(reportsDir, fileName);
    const logoPath = path.join(__dirname, 'public', 'img', 'bodybank X fitchef logo.png');

    await weeklyReportPdf.generateWeeklyReportPdf({ outputPath, report, logoPath });

    const wantEmail = !(req.body && req.body.send === false);
    let emailed = false;
    if (wantEmail) {
      if (!report.user.email) return res.status(400).json({ error: 'User has no email on file — PDF generated but not sent.', reportUrl: `/reports/${encodeURIComponent(fileName)}` });
      emailed = await userEmail.emailWeeklyReport({
        toEmail: report.user.email,
        firstName: report.user.first_name,
        pdfPath: outputPath,
        weekLabel: `${report.weekStart} – ${report.weekEnd}`,
        overallScore: report.overallScore,
        goalsHit: report.goalsHit,
        goalsTotal: report.goalsTotal
      });
    }
    const baseUrl = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
    res.json({ ok: true, emailed: !!emailed, email: report.user.email || null, reportUrl: `${baseUrl}/reports/${encodeURIComponent(fileName)}` });
  } catch (e) {
    console.error('[admin weekly-report]', e.message);
    res.status(500).json({ error: 'Failed to generate weekly report' });
  }
});

// ============ PUSH NOTIFICATIONS (opt-in) ============
app.post('/api/push/subscribe', verifyToken, rateLimiter(5, 60000), async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys) return res.status(400).json({ error: 'Subscription required' });
    const existing = await queryOne('SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
    if (existing) {
      await run('UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE user_id = ? AND endpoint = ?',
        [keys.p256dh || null, keys.auth || null, req.user.id, endpoint]);
    } else {
      const id = uuidv4();
      await run('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, endpoint, keys.p256dh || null, keys.auth || null]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

app.delete('/api/push/subscribe', verifyToken, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) {
      await run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
    } else {
      await run('DELETE FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

app.get('/api/push/vapid-public', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || null });
});

// Native (FCM) device tokens — installed Android/iOS apps register here after login.
app.post('/api/push/register-token', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token required' });
    const plat = (platform === 'ios' || platform === 'android') ? platform : null;
    const existing = await queryOne('SELECT id FROM device_push_tokens WHERE token = ?', [token]);
    if (existing) {
      // Token already known — (re)assign to this user (handles shared/reused devices) and refresh platform.
      await run('UPDATE device_push_tokens SET user_id = ?, platform = ?, updated_at = CURRENT_TIMESTAMP WHERE token = ?',
        [req.user.id, plat, token]);
    } else {
      const id = uuidv4();
      await run('INSERT INTO device_push_tokens (id, user_id, token, platform) VALUES (?, ?, ?, ?)',
        [id, req.user.id, token, plat]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to register token' });
  }
});

app.delete('/api/push/register-token', verifyToken, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (token) {
      await run('DELETE FROM device_push_tokens WHERE user_id = ? AND token = ?', [req.user.id, token]);
    } else {
      await run('DELETE FROM device_push_tokens WHERE user_id = ?', [req.user.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unregister token' });
  }
});

// NOTE: Pending-signup approval routes were removed. New sign-ups now get instant
// trial access (approval_status='approved' + trialing) via the signup routes above,
// and members are managed in the unified Memberships tab. The approval_status column
// is retained only to keep blocking previously-rejected accounts at login.

// ============ NOTIFICATIONS (Admin + User; role-based) ============
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const notifications = [];
    // Operators share the admin in-app notification feed (read-only monitoring).
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin' || req.user.role === 'operator';

    if (isAdmin) {
      // Operator escalations (a monitoring operator flagged a client for admin review).
      const escs = await queryAll("SELECT e.id, e.client_name, e.operator_name, e.updated_at, (SELECT body FROM operator_escalation_messages m WHERE m.escalation_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_body FROM operator_escalations e WHERE e.status = 'open' ORDER BY e.updated_at DESC LIMIT 20");
      escs.forEach(r => {
        notifications.push({
          id: 'esc-' + r.id,
          type: 'escalation',
          title: '🔔 Operator flagged: ' + (r.client_name || 'a client'),
          desc: (r.last_body || '').slice(0, 90),
          time: r.updated_at,
          link: 'escalations'
        });
      });
      const pending = await queryAll("SELECT id, first_name, last_name, email, created_at FROM audit_requests WHERE status='pending' ORDER BY created_at DESC LIMIT 20");
      pending.forEach(r => {
        notifications.push({
          id: 'audit-' + r.id,
          type: 'audit',
          title: 'New Body Audit Request',
          desc: `${r.first_name} ${r.last_name} (${r.email})`,
          time: r.created_at,
          link: 'requests'
        });
      });
      const messages = await queryAll("SELECT id, name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 20");
      messages.forEach(m => {
        const msg = (m.message || '').substring(0, 50);
        notifications.push({
          id: 'message-' + m.id,
          type: 'message',
          title: 'New Contact Message',
          desc: `${m.name}: ${msg}${(m.message || '').length > 50 ? '...' : ''}`,
          time: m.created_at,
          link: 'messages'
        });
      });
      const chatMessages = await queryAll(
        `SELECT m.id, m.thread_id, m.body, m.created_at, u.first_name, u.last_name, u.email
         FROM thread_messages m
         JOIN message_threads t ON t.id = m.thread_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE m.sender_role = 'user'
         ORDER BY m.created_at DESC LIMIT 50`
      );
      chatMessages.forEach(m => {
        const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'User';
        const preview = (m.body || '').substring(0, 80) + ((m.body || '').length > 80 ? '...' : '');
        notifications.push({
          id: 'chat-' + m.id,
          type: 'chat',
          title: 'Message from ' + name,
          desc: preview,
          time: m.created_at,
            link: 'messages'
        });
      });
      const tribe = await queryAll("SELECT id, first_name, last_name, created_at FROM tribe_members WHERE status='active' ORDER BY created_at DESC LIMIT 10");
      tribe.forEach(t => {
        notifications.push({
          id: 'tribe-' + t.id,
          type: 'user',
          title: 'New Tribe Member',
          desc: `${t.first_name} ${t.last_name} joined`,
          time: t.created_at,
          link: 'tribe'
        });
      });
      // FitChef assessments. These had no presence in the bell at all, so a
      // submission only ever reached staff as a push — which needs VAPID keys
      // configured and the browser permission granted, and silently reaches
      // nobody when either is missing.
      //
      // Wrapped because the table belongs to its own migration: a deployment that
      // has not run it must lose this one feed, not the whole notification list.
      // Each part is its own entry, keyed on the part, so Part 1 landing and Part
      // 2 landing are two separate things staff can see and act on.
      try {
        const naRows = await queryAll(
          `SELECT id, full_name, email, review_status, status,
                  part1_submitted_at, part2_submitted_at
             FROM nutrition_assessments
            WHERE part1_submitted_at IS NOT NULL OR part2_submitted_at IS NOT NULL
            ORDER BY COALESCE(part2_submitted_at, part1_submitted_at) DESC LIMIT 30`
        );
        naRows.forEach(r => {
          const who = r.full_name || r.email || 'Someone';
          const blocked = r.review_status === 'blocked';
          if (r.part1_submitted_at) {
            notifications.push({
              id: 'na1-' + r.id,
              type: 'assessment',
              // A blocked row is a safety flag a human has to clear before any
              // plan goes out, so it must not read like an ordinary submission.
              title: blocked ? '⚠ FitChef Part 1 — needs review' : 'FitChef Assessment — Part 1 submitted',
              desc: who + (blocked
                ? ' — flagged, no plan is generated automatically'
                : (r.part2_submitted_at ? '' : ' — Part 2 still outstanding')),
              time: r.part1_submitted_at,
              link: 'nutritionassessment'
            });
          }
          if (r.part2_submitted_at) {
            notifications.push({
              id: 'na2-' + r.id,
              type: 'assessment',
              title: blocked ? '⚠ FitChef complete — needs review' : 'FitChef Assessment — Part 2 submitted',
              desc: who + (blocked ? ' — flagged for review' : ' — both parts in, ready to build'),
              time: r.part2_submitted_at,
              link: 'nutritionassessment'
            });
          }
        });
      } catch (_) { /* table not migrated on this deployment */ }

      const workouts = await queryAll("SELECT w.id, w.workout_name, w.duration_seconds, w.created_at, u.first_name, u.last_name FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 20");
      workouts.forEach(w => {
        const m = Math.floor((w.duration_seconds || 0) / 60);
        notifications.push({
          id: 'workout-' + w.id,
          type: 'workout',
          title: 'Workout Logged',
          desc: `${w.first_name || ''} ${w.last_name || ''} - ${w.workout_name} (${m} min)`,
          time: w.created_at,
          link: 'workouts'
        });
      });
      const part2Subs = await queryAll("SELECT id, name, email, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 15");
      part2Subs.forEach(p => {
        notifications.push({
          id: 'part2-' + p.id,
          type: 'audit',
          title: 'Part-2 Form Submitted',
          desc: `${p.name} (${p.email})`,
          time: p.created_at,
          link: 'part2'
        });
      });
      const meetReqs = await queryAll("SELECT id, user_name, user_email, meeting_date, time_slot, created_at FROM meetings WHERE status='scheduled' ORDER BY created_at DESC LIMIT 15");
      meetReqs.forEach(m => {
        notifications.push({
          id: 'meeting-' + m.id,
          type: 'audit',
          title: 'Call Scheduled',
          desc: `${m.user_name || m.user_email} — ${m.meeting_date} ${m.time_slot}`,
          time: m.created_at,
          link: 'meetings'
        });
      });
      // User-submitted Sunday check-ins (were missing from admin bell)
      try {
        const sundayRows = await queryAll(
          `SELECT s.id, s.full_name, s.reply_email, s.created_at, u.first_name, u.last_name
           FROM sunday_checkins s
           LEFT JOIN users u ON u.id = s.user_id
           ORDER BY s.created_at DESC LIMIT 25`
        );
        sundayRows.forEach(s => {
          const who = [s.first_name, s.last_name].filter(Boolean).join(' ') || s.full_name || s.reply_email || 'User';
          notifications.push({
            id: 'sunday-' + s.id,
            type: 'checkin',
            title: 'Sunday Check-in Submitted',
            desc: who,
            time: s.created_at,
            link: 'sundaycheckin'
          });
        });
      } catch (_) { /* table may be empty */ }
      // Blood report uploads — were reaching admin WhatsApp only; the in-app bell
      // (which operators also read) had no idea a report was even sitting there.
      try {
        const bloodRows = await queryAll(
          `SELECT id, user_name, user_email, created_at FROM blood_analysis_reports
           ORDER BY created_at DESC LIMIT 25`
        );
        bloodRows.forEach(b => {
          notifications.push({
            id: 'blood-' + b.id,
            type: 'blood',
            title: '🩸 Blood Report Uploaded',
            desc: b.user_name || b.user_email || 'A client',
            time: b.created_at,
            link: 'blood'
          });
        });
      } catch (_) { /* table not migrated on this deployment */ }
      // Smart scale uploads (decades scan / InBody / weighing scale reports from
      // the Sunday check-in page) — had zero notification presence anywhere.
      try {
        const scaleRows = await queryAll(
          `SELECT id, user_name, user_email, created_at FROM smart_scale_uploads
           ORDER BY created_at DESC LIMIT 25`
        );
        scaleRows.forEach(sc => {
          notifications.push({
            id: 'scale-' + sc.id,
            type: 'scale',
            title: '⚖️ Smart Scale Report Uploaded',
            desc: sc.user_name || sc.user_email || 'A client',
            time: sc.created_at,
            link: 'smartscale'
          });
        });
      } catch (_) { /* table not migrated on this deployment */ }
      // Daily micro check-ins from users
      try {
        const dailyRows = await queryAll(
          `SELECT d.id, d.checkin_date, d.created_at, d.steps, d.water_ml, d.protein_g, d.sleep_hours,
                  u.first_name, u.last_name, u.email
           FROM daily_checkins d
           LEFT JOIN users u ON u.id = d.user_id
           ORDER BY d.created_at DESC LIMIT 30`
        );
        dailyRows.forEach(d => {
          const who = [d.first_name, d.last_name].filter(Boolean).join(' ') || d.email || 'User';
          const bits = [];
          if (d.steps != null) bits.push(`${d.steps} steps`);
          if (d.water_ml != null) bits.push(`${(Number(d.water_ml) / 1000).toFixed(d.water_ml % 1000 === 0 ? 1 : 2)}L water`);
          if (d.protein_g != null) bits.push(`${d.protein_g}g protein`);
          if (d.sleep_hours != null) bits.push(`${d.sleep_hours}h sleep`);
          notifications.push({
            id: 'daily-' + d.id,
            type: 'checkin',
            title: 'Daily Check-in — ' + who,
            desc: (bits.length ? bits.join(' · ') : 'Logged') + ' · ' + String(d.checkin_date || ''),
            time: d.created_at,
            link: 'dailycheckin'
          });
        });
      } catch (_) { /* ignore */ }
      // Weight logs
      try {
        const wlogs = await queryAll(
          `SELECT w.id, w.weight_kg, w.created_at, u.first_name, u.last_name
           FROM weight_logs w
           LEFT JOIN users u ON w.user_id = u.id
           ORDER BY w.created_at DESC LIMIT 20`
        );
        wlogs.forEach(w => {
          const who = [w.first_name, w.last_name].filter(Boolean).join(' ') || 'User';
          notifications.push({
            id: 'weight-' + w.id,
            type: 'workout',
            title: 'Weight Logged',
            desc: `${who} — ${w.weight_kg} kg`,
            time: w.created_at,
            link: 'clientprogress'
          });
        });
      } catch (_) { /* ignore */ }
      // Client progress logs (analytics)
      try {
        const prog = await queryAll(
          `SELECT p.id, p.weight, p.body_fat, p.created_at, u.first_name, u.last_name
           FROM progress_logs p
           LEFT JOIN users u ON p.user_id = u.id
           ORDER BY p.created_at DESC LIMIT 25`
        );
        prog.forEach(p => {
          const who = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'User';
          const parts = [];
          if (p.weight != null) parts.push(`${p.weight} kg`);
          if (p.body_fat != null) parts.push(`${p.body_fat}% bf`);
          notifications.push({
            id: 'progress-' + String(p.id),
            type: 'workout',
            title: 'Progress Update — ' + who,
            desc: parts.length ? parts.join(', ') : 'New entry',
            time: p.created_at,
            link: 'clientprogress'
          });
        });
      } catch (_) { /* ignore */ }
      // Hydration quick logs
      try {
        const hyd = await queryAll(
          `SELECT h.id, h.amount_ml, h.glasses, h.created_at, u.first_name, u.last_name
           FROM hydration_logs h
           LEFT JOIN users u ON h.user_id = u.id
           ORDER BY h.created_at DESC LIMIT 15`
        );
        hyd.forEach(h => {
          const who = [h.first_name, h.last_name].filter(Boolean).join(' ') || 'User';
          const amt = h.amount_ml ? `${h.amount_ml} ml` : (h.glasses ? `${h.glasses} glasses` : 'Hydration');
          notifications.push({
            id: 'hyd-' + h.id,
            type: 'checkin',
            title: 'Hydration Logged',
            desc: `${who} — ${amt}`,
            time: h.created_at,
            link: 'dailycheckin'
          });
        });
      } catch (_) { /* ignore */ }

      // Nutrition meal uploads from users
      try {
        const nutritionLogs = await queryAll(
          `SELECT n.id, n.meal_type, n.log_date, n.submitted_at, n.meal_score, u.first_name, u.last_name, u.email
           FROM nutrition_meal_logs n
           LEFT JOIN users u ON u.id = n.user_id
           ORDER BY n.submitted_at DESC NULLS LAST, n.log_date DESC
           LIMIT 40`
        );
        nutritionLogs.forEach(n => {
          const who = [n.first_name, n.last_name].filter(Boolean).join(' ') || n.email || 'User';
          const meal = String(n.meal_type || '').trim();
          const mealLabel = meal ? meal.charAt(0).toUpperCase() + meal.slice(1) : 'Meal';
          const score = n.meal_score != null ? ` · score ${n.meal_score}/10` : '';
          const datePart = n.log_date ? ` · ${String(n.log_date).slice(0, 10)}` : '';
          notifications.push({
            id: 'nutrition-' + String(n.id),
            type: 'checkin',
            title: 'Nutrition Meal Uploaded',
            desc: `${who} — ${mealLabel}${score}${datePart}`,
            time: n.submitted_at || n.log_date,
            link: 'nutrition'
          });
        });
      } catch (_) { /* ignore */ }

      // Admin Daily Compliance report readiness (12:00–12:00 IST window)
      // Logged when the scheduled email is sent; drives the admin bell notification.
      try {
        const compliance = await queryAll(
          `SELECT report_key, sent_at, window_start, window_end
           FROM admin_daily_report_log
           WHERE sent_at >= NOW() - INTERVAL '6 hours'
           ORDER BY sent_at DESC
           LIMIT 5`
        );
        compliance.forEach(r => {
          const ws = String(r.window_start || '').slice(0, 10);
          const we = String(r.window_end || '').slice(0, 10);
          notifications.push({
            id: 'dailycompliance-' + String(r.report_key || ''),
            type: 'admin_daily_compliance',
            title: 'Daily Compliance Report Ready',
            desc: 'Window ' + ws + ' → ' + we,
            time: r.sent_at,
            link: 'dailycompliance'
          });
        });
      } catch (_) { /* ignore */ }
    } else {
      const thread = await queryOne('SELECT id FROM message_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [req.user.id]);
      if (thread) {
        const adminMsgs = await queryAll(
          "SELECT id, body, created_at FROM thread_messages WHERE thread_id = ? AND sender_role = 'admin' ORDER BY created_at DESC LIMIT 10",
          [thread.id]
        );
        adminMsgs.forEach(m => {
          const preview = (m.body || '').substring(0, 60) + ((m.body || '').length > 60 ? '...' : '');
          notifications.push({
            id: 'chat-' + m.id,
            type: 'chat',
            title: 'New message from Lifestyle Manager',
            desc: preview,
            time: m.created_at,
            link: 'messages'
          });
        });
      }
      const programAssignments = await queryAll(
        `SELECT a.id, a.assigned_at, p.name FROM user_program_assignments a
         JOIN programs p ON p.id = a.program_id
         WHERE a.user_id = ? AND a.removed_at IS NULL AND a.seen_at IS NULL
         ORDER BY a.assigned_at DESC LIMIT 5`,
        [req.user.id]
      );
      programAssignments.forEach(a => {
        notifications.push({
          id: 'program-' + a.id,
          type: 'program',
          title: 'Program Assigned',
          desc: 'Your lifestyle manager assigned "' + (a.name || '') + '"',
          time: a.assigned_at,
          link: 'programs'
        });
      });

      // Campaign inbox messages — delivered to all users regardless of push subscription
      try {
        const inboxMsgs = await queryAll(
          `SELECT id, title, body, type, created_at FROM user_inbox
           WHERE user_id = ? AND is_read = FALSE
           ORDER BY created_at DESC LIMIT 20`,
          [req.user.id]
        );
        inboxMsgs.forEach(m => {
          notifications.push({
            id: 'inbox-' + m.id,
            type: m.type || 'campaign',
            title: m.title || 'BodyBank',
            desc: (m.body || '').substring(0, 120),
            time: m.created_at,
            link: m.type === 'inactivity_attention' ? 'checkin' : null
          });
        });
      } catch (_) { /* non-critical */ }
    }

    notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
    const maxItems = isAdmin ? 150 : 40;
    res.json(notifications.slice(0, maxItems));
  } catch (e) {
    res.status(500).json([]);
  }
});

// Mark a single inbox message as read (called when user clears the notification)
app.delete('/api/inbox/:id', verifyToken, async (req, res) => {
  try {
    const rawId = String(req.params.id || '').replace(/^inbox-/, '');
    await run('UPDATE user_inbox SET is_read = TRUE WHERE id = ? AND user_id = ?', [rawId, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark ALL unread inbox messages as read for the current user
app.delete('/api/inbox', verifyToken, async (req, res) => {
  try {
    await run('UPDATE user_inbox SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ PROGRAMS ============
// Legacy admin-only route (kept under different path to avoid conflicts)
app.get('/api/programs-legacy', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await queryAll('SELECT id, name, pdf_url, image_url, youtube_url, sort_order FROM programs ORDER BY sort_order, name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/program-catalog', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await queryAll('SELECT id, name, pdf_url FROM programs ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Weekly scorecard: per-program pillar weights (JSON) + cohort leaderboard audit
app.get('/api/admin/program-score-rules', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await queryAll('SELECT id, name, score_weights FROM programs ORDER BY name');
    const out = (rows || []).map((r) => {
      let sw = r.score_weights;
      if (typeof sw === 'string') {
        try {
          sw = JSON.parse(sw);
        } catch (_) {
          sw = null;
        }
      }
      return { id: r.id, name: r.name, score_weights: sw };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VIRTUAL_NAME_POOL = [
  'Aarav N', 'Ishaan K', 'Vihaan R', 'Aditya S', 'Reyansh M',
  'Arjun P', 'Kabir T', 'Krish V', 'Ayaan D', 'Rudra L',
  'Anaya R', 'Myra K', 'Kiara S', 'Sara M', 'Rhea P',
  'Siya T', 'Aisha N', 'Ira D', 'Diya L', 'Navya V',
  'Kunal R', 'Mihir P', 'Nisha T', 'Rohan K', 'Aman S',
  'Yash M', 'Dev P', 'Nirav T', 'Harsh D', 'Pranav L',
  'Mehul V', 'Ritika N', 'Tanya R', 'Saanvi K', 'Neha S',
  'Pooja M', 'Manav P', 'Rahul T', 'Raghav D', 'Karan L'
];

function clampNum(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hashStringStable(text) {
  const s = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function todayUtcYmd() {
  return new Date().toISOString().slice(0, 10);
}

function parseISODate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo, d, 12, 0, 0));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return dt;
}

function dayIndexWithinWeek(weekStartISO, ymdISO) {
  const s = parseISODate(String(weekStartISO || '').slice(0, 10));
  const d = parseISODate(String(ymdISO || '').slice(0, 10));
  if (!s || !d) return null;
  const diffDays = Math.floor((d.getTime() - s.getTime()) / (24 * 60 * 60 * 1000));
  return diffDays;
}

async function ensureVirtualLeaderboardRegistrySeeded() {
  const row = await queryOne('SELECT COUNT(*)::int AS c FROM leaderboard_virtual_registry');
  const count = parseInt(row && row.c, 10) || 0;
  if (count > 0) return;
  for (let i = 1; i <= 30; i += 1) {
    const virtualId = 'bot_' + String(i).padStart(3, '0');
    const tier = i <= 10 ? 'starter' : i <= 22 ? 'pro' : 'elite';
    const display = VIRTUAL_NAME_POOL[(i - 1) % VIRTUAL_NAME_POOL.length];
    await run(
      `INSERT INTO leaderboard_virtual_registry (virtual_id, display_name, tier, status)
       VALUES (?, ?, ?, 'active') ON CONFLICT (virtual_id) DO NOTHING`,
      [virtualId, display, tier]
    );
  }
}

async function getVirtualLeaderboardConfig() {
  await ensureVirtualLeaderboardRegistrySeeded();
  const row = await queryOne('SELECT * FROM leaderboard_virtual_config WHERE id = 1');
  const enabled = row ? !!row.enabled : true;
  const virtualCount = clampNum(parseInt(row && row.virtual_count, 10) || 15, 0, 30);
  const rawVol = String((row && row.volatility) || 'medium').toLowerCase();
  const volatility = ['low', 'medium', 'high'].includes(rawVol) ? rawVol : 'medium';
  return { enabled, virtual_count: virtualCount, volatility };
}

async function getVirtualRegistryRows(limitCount = 15) {
  await ensureVirtualLeaderboardRegistrySeeded();
  const n = clampNum(parseInt(limitCount, 10) || 15, 0, 30);
  if (n <= 0) return [];
  return queryAll(
    `SELECT virtual_id, display_name, tier, status
     FROM leaderboard_virtual_registry
     WHERE COALESCE(status, 'active') = 'active'
     ORDER BY virtual_id ASC
     LIMIT ?`,
    [n]
  );
}

function buildVirtualScore(virtualId, tier, volatility, weekStart) {
  const t = String((tier || 'pro')).toLowerCase();
  const vol = String((volatility || 'medium')).toLowerCase();
  const wk = String(weekStart || '');
  const day = todayUtcYmd();
  const baseSeed = hashStringStable(virtualId + '|base|' + wk);
  const daySeed = hashStringStable(virtualId + '|day|' + day);
  const trendSeed = hashStringStable(virtualId + '|trend|' + wk);
  let startFloor = 6;
  let startCeil = 18;
  let endFloor = 52;
  let endCeil = 76;
  if (t === 'starter') {
    startFloor = 3; startCeil = 14; endFloor = 40; endCeil = 66;
  } else if (t === 'elite') {
    startFloor = 10; startCeil = 24; endFloor = 64; endCeil = 90;
  }
  const weekIndex = dayIndexWithinWeek(wk, day);
  const rawProgress = weekIndex == null ? 1 : weekIndex < 0 ? 0 : weekIndex >= 6 ? 1 : ((weekIndex + 1) / 7);
  // Non-linear weekly growth: slower at start, faster mid-to-late week.
  const weekProgress = Math.pow(rawProgress, 1.22);
  const bandStart = startFloor + (baseSeed % Math.max(1, startCeil - startFloor + 1));
  const bandEnd = endFloor + ((baseSeed >> 4) % Math.max(1, endCeil - endFloor + 1));
  const amp = vol === 'low' ? 1.2 : vol === 'high' ? 3.4 : 2.2;
  const jitter = (((daySeed % 1000) / 1000) - 0.5) * amp;
  const trend = (((trendSeed % 13) - 6) * 0.14);
  const ramped = bandStart + ((bandEnd - bandStart) * weekProgress);
  const total = Math.round(clampNum(ramped + jitter + trend, 20, 99));
  const daily = Math.round(clampNum(total + ((hashStringStable(virtualId + '|d') % 11) - 5), 20, 100));
  const sunday = Math.round(clampNum(total + ((hashStringStable(virtualId + '|s') % 15) - 7), 0, 100));
  const workouts = Math.round(clampNum(total + ((hashStringStable(virtualId + '|w') % 13) - 6), 0, 100));
  const progress = Math.round(clampNum(total + ((hashStringStable(virtualId + '|p') % 17) - 8), 0, 100));
  return { total, pillars: { daily, sunday, workouts, progress } };
}

async function buildVirtualLeaderboardRows({ weekStart, limitCount, volatility }) {
  const rows = await getVirtualRegistryRows(limitCount);
  return (rows || []).map((r) => {
    const sc = buildVirtualScore(r.virtual_id, r.tier, volatility, weekStart);
    return {
      user_id: r.virtual_id,
      virtual_id: r.virtual_id,
      display_name: String(r.display_name || 'Member').slice(0, 80),
      total: sc.total,
      pillars: sc.pillars,
      is_virtual: true,
      tier: String(r.tier || 'pro'),
      status: String(r.status || 'active')
    };
  });
}

function mergeLeaderboardRows(realRows, virtualRows) {
  const merged = ([]).concat(realRows || [], virtualRows || []);
  merged.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0) || String(a.user_id).localeCompare(String(b.user_id)));
  return merged.map((r, i) => ({ ...r, rank: i + 1 }));
}

async function getRealUserNameSetLower() {
  const users = await queryAll(
    `SELECT first_name, last_name, leaderboard_display_name
     FROM users
     WHERE role = 'user' AND (approval_status IS NULL OR approval_status = 'approved') AND COALESCE(suspended, FALSE) = FALSE`
  );
  const set = new Set();
  (users || []).forEach((u) => {
    const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
    const dn = String(u.leaderboard_display_name || '').trim();
    if (full) set.add(full.toLowerCase());
    if (dn) set.add(dn.toLowerCase());
  });
  return set;
}

async function listVirtualNameCollisions() {
  const [virtuals, realSet] = await Promise.all([
    queryAll(`SELECT virtual_id, display_name FROM leaderboard_virtual_registry ORDER BY virtual_id ASC`),
    getRealUserNameSetLower()
  ]);
  return (virtuals || [])
    .filter((v) => realSet.has(String(v.display_name || '').trim().toLowerCase()))
    .map((v) => ({ virtual_id: v.virtual_id, display_name: v.display_name }));
}

app.put('/api/admin/program-score-rules/:programId', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const programId = req.params.programId;
    const exists = await queryOne('SELECT id FROM programs WHERE id = ?', [programId]);
    if (!exists) return res.status(404).json({ error: 'Program not found' });
    const body = req.body || {};
    if (body.score_weights === null) {
      await run('UPDATE programs SET score_weights = NULL WHERE id = ?', [programId]);
    } else if (typeof body.score_weights === 'object' && body.score_weights !== null) {
      await run('UPDATE programs SET score_weights = ?::jsonb WHERE id = ?', [JSON.stringify(body.score_weights), programId]);
    } else {
      return res.status(400).json({ error: 'Body must include score_weights (object) or score_weights: null' });
    }
    const row = await queryOne('SELECT id, name, score_weights FROM programs WHERE id = ?', [programId]);
    let sw = row.score_weights;
    if (typeof sw === 'string') {
      try {
        sw = JSON.parse(sw);
      } catch (_) {
        sw = null;
      }
    }
    res.json({ ok: true, id: row.id, name: row.name, score_weights: sw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/leaderboard-preview', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const programId = (req.query.program_id || '').trim();
    const weekParam = (req.query.week || '').trim();
    if (!programId) return res.status(400).json({ error: 'program_id required' });
    const weekStart = scorecardSvc.normalizeWeekStart(weekParam);
    const prog = await queryOne('SELECT id, name FROM programs WHERE id = ?', [programId]);
    if (!prog) return res.status(404).json({ error: 'Program not found' });
    const rows = await scorecardSvc.buildAdminLeaderboardPreview(programId, weekStart);
    const includeVirtual = String(req.query.include_virtual_for_testing || '').toLowerCase() === 'true';
    let mergedRows = rows;
    if (includeVirtual) {
      const cfg = await getVirtualLeaderboardConfig();
      if (cfg.enabled && cfg.virtual_count > 0) {
        const virtualRows = await buildVirtualLeaderboardRows({
          weekStart,
          limitCount: cfg.virtual_count,
          volatility: cfg.volatility
        });
        const baseReal = (rows || []).map((r) => ({
          user_id: r.user_id,
          display_name: r.display_name,
          total: r.total,
          pillars: r.pillars || {},
          is_virtual: false
        }));
        mergedRows = mergeLeaderboardRows(baseReal, virtualRows).map((r) => ({
          rank_admin: r.rank,
          rank_public: r.is_virtual ? null : null,
          display_name: r.display_name,
          internal_name: r.is_virtual ? '(virtual)' : '',
          email: '',
          opted_in: !r.is_virtual,
          total: r.total,
          pillars: r.pillars || {},
          is_virtual: !!r.is_virtual,
          virtual_id: r.virtual_id || null,
          tier: r.tier || null,
          status: r.status || null
        }));
      }
    }
    res.json({
      program_id: programId,
      program_name: prog.name || programId,
      week_start: weekStart,
      week_label: scorecardSvc.formatWeekRangeLabel(weekStart),
      rows: mergedRows
    });
  } catch (e) {
    console.error('leaderboard-preview error:', e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/programs/user/:userId', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const userId = req.params.userId;
    const rows = await queryAll(
      `SELECT a.id, a.user_id, a.program_id, a.assigned_by, a.assigned_at, a.removed_at,
        p.name as program_name, p.pdf_url, p.youtube_url
       FROM user_program_assignments a
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ?
       ORDER BY a.removed_at IS NULL DESC, a.assigned_at DESC`,
      [userId]
    );
    const users = await queryAll("SELECT id, first_name, last_name, email FROM users WHERE id IN (SELECT DISTINCT assigned_by FROM user_program_assignments WHERE assigned_by IS NOT NULL)");
    const userMap = {};
    users.forEach(u => { userMap[u.id] = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email; });
    const out = rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      program_id: r.program_id,
      program_name: r.program_name,
      pdf_url: r.pdf_url,
      youtube_url: r.youtube_url,
      assigned_by: r.assigned_by,
      assigned_by_name: userMap[r.assigned_by] || '—',
      assigned_at: r.assigned_at,
      removed_at: r.removed_at,
      is_active: !r.removed_at
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/programs/assign', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { user_id, program_id } = req.body;
    if (!user_id || !program_id) return res.status(400).json({ error: 'user_id and program_id required' });
    const activeCount = await queryOne(
      'SELECT COUNT(*) as c FROM user_program_assignments WHERE user_id = ? AND removed_at IS NULL',
      [user_id]
    );
    if (Number(activeCount?.c || 0) >= 4) return res.status(400).json({ error: 'User already has maximum 4 programs assigned' });
    const existing = await queryOne(
      'SELECT id FROM user_program_assignments WHERE user_id = ? AND program_id = ? AND removed_at IS NULL',
      [user_id, program_id]
    );
    if (existing) return res.status(400).json({ error: 'This program is already assigned to the user' });
    const id = uuidv4();
    await run(
      'INSERT INTO user_program_assignments (id, user_id, program_id, assigned_by) VALUES (?, ?, ?, ?)',
      [id, user_id, program_id, req.user.id]
    );
    try {
      await sendPushToUser(
        user_id,
        JSON.stringify({
          type: 'program_assigned',
          title: '🎯 New program assigned',
          body: 'Your lifestyle manager assigned a new program — open the app to view it.',
          id: 'program-' + id,
          assignmentId: id
        })
      );
    } catch (_) {}
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/programs/assign/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const id = req.params.id;
    await run('UPDATE user_program_assignments SET removed_at = CURRENT_TIMESTAMP WHERE id = ? AND removed_at IS NULL', [id]);
    const r = await queryOne('SELECT id FROM user_program_assignments WHERE id = ?', [id]);
    if (!r) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me/programs', verifyToken, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT a.id, a.program_id, a.assigned_at, p.name, p.pdf_url, p.image_url, p.youtube_url
       FROM user_program_assignments a
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? AND a.removed_at IS NULL
       ORDER BY a.assigned_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me/program-assignments/unseen', verifyToken, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT a.id, p.name
       FROM user_program_assignments a
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? AND a.removed_at IS NULL AND a.seen_at IS NULL
       ORDER BY a.assigned_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json([]);
  }
});

app.post('/api/me/program-assignments/:id/seen', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    await run(
      'UPDATE user_program_assignments SET seen_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND removed_at IS NULL',
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Weekly scorecard + global leaderboard (auto-visible once users start scoring)
app.get('/api/me/scorecard', verifyToken, async (req, res) => {
  try {
    const weekParam = (req.query.week || '').trim();
    const weekStart = scorecardSvc.normalizeWeekStart(weekParam);
    const prevWeek = scorecardSvc.previousWeekStart(weekStart);
    const urow = await queryOne(
      `SELECT leaderboard_opt_in, leaderboard_display_name,
              COALESCE(leaderboard_public_program, TRUE) AS leaderboard_public_program,
              COALESCE(leaderboard_public_global, FALSE) AS leaderboard_public_global
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    const optedIn = !!(urow && urow.leaderboard_opt_in);
    const publicProgram = !!(urow && urow.leaderboard_public_program);
    const publicGlobal = !!(urow && urow.leaderboard_public_global);
    const dn = (urow && String(urow.leaderboard_display_name || '').trim()) || '';
    const inCohortLb = optedIn && dn.length > 0 && publicProgram;
    const inGlobalLb = optedIn && dn.length > 0 && publicGlobal;
    const current = await scorecardSvc.computeWeeklyScore(req.user.id, weekStart);
    const previous = prevWeek ? await scorecardSvc.computeWeeklyScore(req.user.id, prevWeek) : null;
    const dedication = await scorecardSvc.computeWeeklyScoreDedication(req.user.id, weekStart);
    let rank = null;
    let cohort_size = null;
    let global_rank = null;
    let global_cohort_size = null;
    const cohortRes = await scorecardSvc.rankInCohort(
      req.user.id,
      current ? current.program_id : null,
      weekStart,
      inCohortLb,
      publicProgram
    );
    rank = cohortRes.rank;
    cohort_size = cohortRes.cohort_size;
    const g = await scorecardSvc.rankInGlobal(req.user.id, weekStart, inGlobalLb, publicGlobal);
    global_rank = g.rank;
    global_cohort_size = g.cohort_size;
    const trend_delta =
      current && previous ? (current.total - previous.total) : null;
    res.json({
      week_start: weekStart,
      week_label: current ? current.week_label : scorecardSvc.formatWeekRangeLabel(weekStart),
      opted_in: optedIn,
      public_program: publicProgram,
      public_global: publicGlobal,
      display_name: (urow && urow.leaderboard_display_name) || '',
      leaderboard_rank: inCohortLb ? rank : null,
      cohort_size: inCohortLb ? cohort_size : null,
      global_rank: inGlobalLb ? global_rank : null,
      global_cohort_size: inGlobalLb ? global_cohort_size : null,
      dedication_total: dedication ? dedication.total : null,
      dedication_pillars: dedication
        ? {
            daily: dedication.daily,
            sunday: dedication.sunday,
            workouts: dedication.workouts,
            progress: dedication.progress
          }
        : null,
      dedication_breakdown: dedication ? dedication.breakdown : null,
      dedication_weights: dedication ? dedication.weights : null,
      program_id: current ? current.program_id : null,
      program_name: current ? current.program_name : null,
      total: current ? current.total : 0,
      pillars: current
        ? {
            daily: current.daily,
            sunday: current.sunday,
            workouts: current.workouts,
            progress: current.progress
          }
        : null,
      breakdown: current ? current.breakdown : null,
      weights: current ? current.weights : null,
      trend_delta,
      previous_total: previous ? previous.total : null
    });
  } catch (e) {
    console.error('scorecard error:', e);
    res.status(500).json({ error: e.message || 'Failed to load scorecard' });
  }
});

// Muscle ranking — strength-based regional scores from logged lifts (read-only)
app.get('/api/me/muscle-ranking', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    const data = await muscleRankingSvc.computeMuscleRanking(req.user.id);
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (e) {
    console.error('[muscle-ranking]', e.message);
    res.status(500).json({ error: e.message || 'Failed to compute muscle ranking' });
  }
});

// Daily luxury focus wheel (one spin per UTC day)
app.get('/api/me/focus-wheel', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    const ymd = focusWheelSvc.todayUTCYmd();
    const row = await queryOne(
      'SELECT focus_wheel_last_spin_date, focus_wheel_last_label FROM users WHERE id = ?',
      [req.user.id]
    );
    const last = row && String(row.focus_wheel_last_spin_date || '').trim();
    const can_spin = last !== ymd;
    const segments = await focusWheelSvc.buildFocusSegments({ queryAll, queryOne }, req.user.id, 8);
    res.json({
      can_spin,
      date_ymd: ymd,
      last_label: !can_spin ? String(row.focus_wheel_last_label || '') : null,
      segments
    });
  } catch (e) {
    console.error('[focus-wheel GET]', e.message);
    res.status(500).json({ error: e.message || 'Failed to load focus wheel' });
  }
});

app.post('/api/me/focus-wheel/spin', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    const ymd = focusWheelSvc.todayUTCYmd();
    const row = await queryOne(
      'SELECT focus_wheel_last_spin_date, focus_wheel_last_label FROM users WHERE id = ?',
      [req.user.id]
    );
    const last = row && String(row.focus_wheel_last_spin_date || '').trim();
    const segments = await focusWheelSvc.buildFocusSegments({ queryAll, queryOne }, req.user.id, 8);
    if (last === ymd) {
      return res.json({
        ok: true,
        already_spun: true,
        date_ymd: ymd,
        label: String(row.focus_wheel_last_label || ''),
        winning_index: null,
        segments
      });
    }
    const n = segments.length;
    const winning_index = Math.floor(Math.random() * n);
    const label = segments[winning_index];
    await run('UPDATE users SET focus_wheel_last_spin_date = ?, focus_wheel_last_label = ? WHERE id = ?', [
      ymd,
      label,
      req.user.id
    ]);
    res.json({
      ok: true,
      already_spun: false,
      date_ymd: ymd,
      winning_index,
      label,
      segments
    });
  } catch (e) {
    console.error('[focus-wheel POST]', e.message);
    res.status(500).json({ error: e.message || 'Spin failed' });
  }
});

app.post('/api/me/leaderboard-opt-in', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    const body = req.body || {};
    let optIn = !!body.opt_in;
    const displayName = String(body.display_name || '').trim().slice(0, 80);
    const publicProgram = body.public_program !== false;
    const publicGlobal = !!body.public_global;
    if (optIn && !publicProgram && !publicGlobal) {
      return res.status(400).json({
        error: 'Choose at least one: program cohort or BodyBank leaderboard.'
      });
    }
    if (optIn && !displayName) {
      return res.status(400).json({
        error: 'Leaderboard nickname is required. It is shown instead of your real name.'
      });
    }
    if (optIn) {
      await run(
        `UPDATE users SET leaderboard_opt_in = TRUE, leaderboard_display_name = ?,
         leaderboard_public_program = ?, leaderboard_public_global = ?,
         leaderboard_opt_in_at = COALESCE(leaderboard_opt_in_at, CURRENT_TIMESTAMP) WHERE id = ?`,
        [displayName, publicProgram, publicGlobal, req.user.id]
      );
    } else {
      await run(
        `UPDATE users SET leaderboard_opt_in = FALSE, leaderboard_display_name = '', leaderboard_opt_in_at = NULL,
         leaderboard_public_program = TRUE, leaderboard_public_global = FALSE WHERE id = ?`,
        [req.user.id]
      );
    }
    const row = await queryOne(
      `SELECT leaderboard_opt_in, leaderboard_display_name, leaderboard_opt_in_at,
              COALESCE(leaderboard_public_program, TRUE) AS leaderboard_public_program,
              COALESCE(leaderboard_public_global, FALSE) AS leaderboard_public_global
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    res.json({ ok: true, ...row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/me/leaderboard-profile', verifyToken, rateLimiter(10, 60000), async (req, res) => {
  try {
    const body = req.body || {};
    const displayName = String(body.display_name || '').trim().slice(0, 80);
    if (!displayName) {
      return res.status(400).json({
        error: 'Enter a leaderboard nickname (required). It is shown instead of your real name.'
      });
    }
    await run(
      `UPDATE users SET leaderboard_display_name = ?,
       leaderboard_opt_in = TRUE,
       leaderboard_public_program = TRUE,
       leaderboard_public_global = TRUE,
       leaderboard_opt_in_at = COALESCE(leaderboard_opt_in_at, CURRENT_TIMESTAMP)
       WHERE id = ?`,
      [displayName, req.user.id]
    );
    const row = await queryOne(
      `SELECT leaderboard_display_name FROM users WHERE id = ?`,
      [req.user.id]
    );
    res.json({ ok: true, display_name: (row && row.leaderboard_display_name) || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me/leaderboard', verifyToken, async (req, res) => {
  try {
    const weekParam = (req.query.week || '').trim();
    const weekStart = scorecardSvc.normalizeWeekStart(weekParam);
    const boardRaw = String(req.query.board || 'program').trim().toLowerCase();
    const board = boardRaw === 'dedication' || boardRaw === 'global' || boardRaw === 'bodybank' ? 'dedication' : 'program';

    const cfg = await getVirtualLeaderboardConfig();
    if (board === 'dedication') {
      const rowsReal = await scorecardSvc.buildLeaderboardGlobal(weekStart, 50);
      const virtualRows =
        cfg.enabled && cfg.virtual_count > 0
          ? await buildVirtualLeaderboardRows({
              weekStart,
              limitCount: cfg.virtual_count,
              volatility: cfg.volatility
            })
          : [];
      const rows = mergeLeaderboardRows(rowsReal, virtualRows).slice(0, 50);
      return res.json({
        board: 'dedication',
        week_start: weekStart,
        week_label: scorecardSvc.formatWeekRangeLabel(weekStart),
        program_id: null,
        program_name: 'BodyBank',
        rows,
        virtual_enabled: cfg.enabled,
        virtual_count: cfg.virtual_count
      });
    }

    const current = await scorecardSvc.computeWeeklyScore(req.user.id, weekStart);
    if (!current || !current.program_id) {
      return res.json({
        board: 'program',
        week_start: weekStart,
        week_label: scorecardSvc.formatWeekRangeLabel(weekStart),
        program_id: null,
        program_name: current ? current.program_name : null,
        rows: []
      });
    }
    const rowsReal = await scorecardSvc.buildLeaderboard(current.program_id, weekStart, 50);
    const virtualRows =
      cfg.enabled && cfg.virtual_count > 0
        ? await buildVirtualLeaderboardRows({
            weekStart,
            limitCount: cfg.virtual_count,
            volatility: cfg.volatility
          })
        : [];
    const rows = mergeLeaderboardRows(rowsReal, virtualRows).slice(0, 50);
    res.json({
      board: 'program',
      week_start: weekStart,
      week_label: current.week_label,
      program_id: current.program_id,
      program_name: current.program_name,
      rows,
      virtual_enabled: cfg.enabled,
      virtual_count: cfg.virtual_count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/leaderboard/virtual-config', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const cfg = await getVirtualLeaderboardConfig();
    const collisions = await listVirtualNameCollisions();
    res.json({
      ...cfg,
      collisions
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load virtual leaderboard config' });
  }
});

app.put('/api/admin/leaderboard/virtual-config', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const enabled = body.enabled !== false;
    const virtualCount = clampNum(parseInt(body.virtual_count, 10) || 15, 0, 30);
    const rawVol = String(body.volatility || 'medium').toLowerCase();
    const volatility = ['low', 'medium', 'high'].includes(rawVol) ? rawVol : 'medium';
    await run(
      `UPDATE leaderboard_virtual_config
       SET enabled = ?, virtual_count = ?, volatility = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [enabled, virtualCount, volatility]
    );
    const cfg = await getVirtualLeaderboardConfig();
    res.json({ ok: true, ...cfg });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to save virtual leaderboard config' });
  }
});

app.post('/api/admin/leaderboard/virtual-regenerate-aliases', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const [virtualRows, realSet] = await Promise.all([
      queryAll(`SELECT virtual_id FROM leaderboard_virtual_registry ORDER BY virtual_id ASC`),
      getRealUserNameSetLower()
    ]);
    const used = new Set();
    const names = [];
    for (let i = 0; i < VIRTUAL_NAME_POOL.length; i += 1) names.push(VIRTUAL_NAME_POOL[i]);
    let ptr = 0;
    for (const row of virtualRows || []) {
      let chosen = '';
      for (let guard = 0; guard < names.length + 100; guard += 1) {
        const base = names[ptr % names.length];
        ptr += 1;
        const candidate = guard > names.length ? `${base} ${String((guard % 90) + 10)}` : base;
        const k = candidate.toLowerCase();
        if (realSet.has(k) || used.has(k)) continue;
        chosen = candidate;
        used.add(k);
        break;
      }
      if (!chosen) {
        chosen = `Member ${String(hashStringStable(row.virtual_id) % 900 + 100)}`;
      }
      await run(
        `UPDATE leaderboard_virtual_registry
         SET display_name = ?, updated_at = CURRENT_TIMESTAMP
         WHERE virtual_id = ?`,
        [chosen, row.virtual_id]
      );
    }
    const collisions = await listVirtualNameCollisions();
    res.json({ ok: true, collisions });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to regenerate aliases' });
  }
});

app.get('/api/admin/leaderboard/live', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const boardRaw = String(req.query.board || 'dedication').trim().toLowerCase();
    const board = boardRaw === 'program' ? 'program' : 'dedication';
    const weekStart = scorecardSvc.normalizeWeekStart(String(req.query.week || '').trim());
    const viewMode = String(req.query.view || 'all').toLowerCase();
    const includeVirtualForTesting = String(req.query.include_virtual_for_testing || '').toLowerCase() === 'true';
    const cfg = await getVirtualLeaderboardConfig();
    let realRows = [];
    let programId = null;
    let programName = 'BodyBank';
    if (board === 'program') {
      programId = String(req.query.program_id || '').trim();
      if (!programId) return res.status(400).json({ error: 'program_id required for program board' });
      const prog = await queryOne('SELECT id, name FROM programs WHERE id = ?', [programId]);
      if (!prog) return res.status(404).json({ error: 'Program not found' });
      programName = prog.name || programId;
      realRows = await scorecardSvc.buildLeaderboard(programId, weekStart, 100);
    } else {
      realRows = await scorecardSvc.buildLeaderboardGlobal(weekStart, 100);
    }
    const virtualRows =
      cfg.enabled && includeVirtualForTesting && cfg.virtual_count > 0
        ? await buildVirtualLeaderboardRows({
            weekStart,
            limitCount: cfg.virtual_count,
            volatility: cfg.volatility
          })
        : [];
    const merged = mergeLeaderboardRows(realRows, virtualRows);
    const rowsFiltered = merged.filter((r) => {
      if (viewMode === 'real') return !r.is_virtual;
      if (viewMode === 'virtual') return !!r.is_virtual;
      return true;
    });
    const collisions = await listVirtualNameCollisions();
    res.json({
      board,
      program_id: programId,
      program_name: programName,
      week_start: weekStart,
      week_label: scorecardSvc.formatWeekRangeLabel(weekStart),
      view: viewMode,
      include_virtual_for_testing: includeVirtualForTesting,
      rows: rowsFiltered,
      counts: {
        real_clients: realRows.length,
        virtual_competitors: virtualRows.length,
        shown_on_user_leaderboard: (mergeLeaderboardRows(realRows, virtualRows).slice(0, 50)).length
      },
      virtual_config: cfg,
      collisions
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load admin leaderboard live view' });
  }
});

app.get('/api/admin/leaderboard/virtual-registry', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const weekStart = scorecardSvc.normalizeWeekStart(String(req.query.week || '').trim());
    await ensureVirtualLeaderboardRegistrySeeded();
    const cfg = await getVirtualLeaderboardConfig();
    const rows = await queryAll(
      `SELECT virtual_id, display_name, tier, status
       FROM leaderboard_virtual_registry
       ORDER BY virtual_id ASC`
    );
    const out = (rows || []).map((r) => {
      const sc = buildVirtualScore(r.virtual_id, r.tier, cfg.volatility, weekStart);
      return {
        virtual_id: r.virtual_id,
        display_name: r.display_name,
        tier: r.tier || 'pro',
        status: r.status || 'active',
        current_score: sc.total
      };
    });
    res.json({
      week_start: weekStart,
      week_label: scorecardSvc.formatWeekRangeLabel(weekStart),
      rows: out
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to load virtual registry' });
  }
});

app.put('/api/admin/leaderboard/virtual-registry/:virtualId', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const virtualId = String(req.params.virtualId || '').trim();
    if (!virtualId) return res.status(400).json({ error: 'virtualId required' });
    const body = req.body || {};
    let status = String(body.status || '').toLowerCase();
    if (!['active', 'paused'].includes(status)) status = 'active';
    let tier = String(body.tier || '').toLowerCase();
    if (!['starter', 'pro', 'elite'].includes(tier)) tier = 'pro';
    const displayName = String(body.display_name || '').trim().slice(0, 80);
    await run(
      `UPDATE leaderboard_virtual_registry
       SET status = ?, tier = ?, display_name = COALESCE(NULLIF(?, ''), display_name), updated_at = CURRENT_TIMESTAMP
       WHERE virtual_id = ?`,
      [status, tier, displayName, virtualId]
    );
    const row = await queryOne(
      `SELECT virtual_id, display_name, tier, status FROM leaderboard_virtual_registry WHERE virtual_id = ?`,
      [virtualId]
    );
    if (!row) return res.status(404).json({ error: 'Virtual row not found' });
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update virtual registry row' });
  }
});

// Short-lived PDF access token (restricts sharing - link expires in 10 min)
app.post('/api/me/programs/pdf-token', verifyToken, async (req, res) => {
  try {
    const programId = (req.body && req.body.program_id) ? String(req.body.program_id).trim() : '';
    if (!programId) return res.status(400).json({ error: 'program_id required' });
    const hasAccess = await queryOne(
      'SELECT 1 FROM user_program_assignments a JOIN programs p ON p.id = a.program_id WHERE a.user_id = ? AND a.program_id = ? AND a.removed_at IS NULL',
      [req.user.id, programId]
    );
    if (!hasAccess) return res.status(403).json({ error: 'Not authorized to view this program' });
    const token = signPdfAccessToken(programId, req.user.id);
    const base = (req.protocol + '://' + req.get('host')).replace(/\/$/, '');
    const url = base + '/api/me/programs/pdf?t=' + encodeURIComponent(token) + '&f=' + encodeURIComponent(programId);
    const viewUrl = base + '/program-viewer.html?url=' + encodeURIComponent(url);
    res.json({ url, viewUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream PDF with token (no static URL - restricts sharing & downloading)
app.get('/api/me/programs/pdf', async (req, res) => {
  try {
    const token = req.query.t || '';
    const fileParam = req.query.f || '';
    const payload = verifyPdfAccessToken(token);
    if (!payload || payload.programId !== fileParam) return res.status(403).json({ error: 'Invalid or expired link' });
    const hasAccess = await queryOne(
      'SELECT 1 FROM user_program_assignments WHERE user_id = ? AND program_id = ? AND removed_at IS NULL',
      [payload.userId, fileParam]
    );
    if (!hasAccess) return res.status(403).json({ error: 'Not authorized' });
    const fs = require('fs');
    const filePath = path.join(__dirname, 'public', 'programs', 'pdfs', fileParam);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ STATS ============
app.get('/api/stats', verifyToken, requireOperator, async (req, res) => {
  await ensureApprovedUsersInActiveTribe();
  const pending = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'");
  const active = await queryAll(
    `SELECT COUNT(*) as c
       FROM tribe_members tm
       INNER JOIN users u
         ON LOWER(u.email) = LOWER(tm.email)
        AND u.role = 'user'
        AND COALESCE(u.approval_status, 'approved') = 'approved'
        AND COALESCE(u.suspended, FALSE) = FALSE
      WHERE tm.status = 'active'`
  );
  const completed = await queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='completed'");
  const total = await queryAll("SELECT COUNT(*) as c FROM tribe_members");
  const [workouts] = await queryAll("SELECT COUNT(*) as c FROM workout_logs");
  const [formsTotal] = await queryAll("SELECT COUNT(*) as c FROM audit_requests");
  const [sundayCheckins] = await queryAll("SELECT COUNT(*) as c FROM sunday_checkins");
  const [dailyCheckins] = await queryAll("SELECT COUNT(*) as c FROM daily_checkins");
  // Today-scoped, de-duplicated by user, freeze markers excluded. The all-time
  // `daily_checkins` count above is not a meaningful dashboard headline — it read
  // 566 against a 36-member roster. Kept for back-compat; new clients use this.
  const [dailyCheckinsToday] = await queryAll(
    "SELECT COUNT(DISTINCT user_id) as c FROM daily_checkins WHERE checkin_date = CURRENT_DATE AND COALESCE(is_freeze, FALSE) = FALSE"
  );
  const [trials] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND subscription_status='trialing' AND COALESCE(suspended, FALSE) = FALSE");
  const [contactMsgs] = await queryAll("SELECT COUNT(*) as c FROM contact_messages");
  const [unreadThreads] = await queryAll(
    "SELECT COUNT(*) as c FROM message_threads t WHERE (SELECT sender_role FROM thread_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) = 'user'"
  );

  const num = (v) => (v === undefined || v === null ? 0 : parseInt(String(v), 10) || 0);
  res.json({
    pending_requests: num(pending[0]?.c),
    active_members: num(active[0]?.c),
    completed: num(completed[0]?.c),
    total_members: num(total[0]?.c),
    success_rate: 92,
    workouts: num(workouts?.c),
    forms: num(formsTotal?.c),
    check_ins: num(sundayCheckins[0]?.c),
    daily_checkins: num(dailyCheckins?.c),
    daily_checkins_today: num(dailyCheckinsToday?.c),
    trials: num(trials?.c),
    messages: num(unreadThreads?.c)
  });
});

// ============ ADMIN: RECENT ACTIVITY (for dashboard live activity) ============
app.get('/api/admin/recent-activity', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const limit = 10;
    const activities = [];
    const sc = await queryAll('SELECT full_name, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT ?', [limit]);
    (sc || []).forEach(r => activities.push({ name: r.full_name || 'Unknown', type: 'Check-in', status: 'NEW', created_at: r.created_at }));
    const wl = await queryAll(
      `SELECT u.first_name, u.last_name, w.created_at FROM workout_logs w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT ?`,
      [limit]
    );
    (wl || []).forEach(r => activities.push({ name: ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'User', type: 'Workout logged', status: 'DONE', created_at: r.created_at }));
    const cm = await queryAll('SELECT name, created_at FROM contact_messages ORDER BY created_at DESC LIMIT ?', [limit]);
    (cm || []).forEach(r => activities.push({ name: r.name || 'Unknown', type: 'Message', status: 'UNREAD', created_at: r.created_at }));
    const ps = await queryAll(
      "SELECT first_name, last_name, created_at FROM users WHERE role='user' AND subscription_status='trialing' ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    (ps || []).forEach(r => activities.push({ name: ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'New user', type: 'Trial started', status: 'TRIAL', created_at: r.created_at }));
    activities.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    res.json(activities.slice(0, limit));
  } catch (e) {
    console.error('[recent-activity]', e.message);
    res.status(500).json([]);
  }
});

// ============ ADMIN: ATTNETION / HIGH RISK CLIENTS (mobile luxury cards) ============
app.get('/api/admin/attention-clients', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rawLimit = req.query && req.query.limit ? parseInt(String(req.query.limit), 10) : 4;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 4;

    // P1: inactive >= 2 days (no daily check-in), P0: inactive >= 5 days.
    // Inactivity uses last daily_checkins.checkin_date; if none, falls back to users.created_at::date.
    const rows = await queryAll(`
      WITH last_checkin AS (
        SELECT user_id, MAX(checkin_date)::date AS last_checkin_date
        FROM daily_checkins
        GROUP BY user_id
      )
      SELECT
        u.id AS user_id,
        u.email AS email,
        u.profile_picture AS profile_picture,
        TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
        lc.last_checkin_date::text AS last_checkin_date,
        (CURRENT_DATE - COALESCE(lc.last_checkin_date, u.created_at::date))::int AS inactive_days,
        CASE
          WHEN (CURRENT_DATE - COALESCE(lc.last_checkin_date, u.created_at::date))::int >= 5 THEN 'P0'
          WHEN (CURRENT_DATE - COALESCE(lc.last_checkin_date, u.created_at::date))::int >= 2 THEN 'P1'
          ELSE NULL
        END AS severity,

        COALESCE(dc7.daily_checkins_count_7d, 0)::int AS daily_checkins_count_7d,
        COALESCE(dc7.daily_checkins_pct_7d, 0)::float AS daily_checkins_pct_7d,

        COALESCE(wl7.workouts_count_7d, 0)::int AS workouts_count_7d,
        wl7.last_workout_date::text AS last_workout_date,

        COALESCE(sc14.sunday_checkins_count_14d, 0)::int AS sunday_checkins_count_14d,
        sc14.last_sunday_checkin_date::text AS last_sunday_checkin_date
      FROM tribe_members tm
      JOIN users u
        ON LOWER(u.email) = LOWER(tm.email)
      LEFT JOIN last_checkin lc
        ON lc.user_id = u.id

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS daily_checkins_count_7d,
          (COUNT(*)::float * 100.0 / 7.0) AS daily_checkins_pct_7d
        FROM daily_checkins dc
        WHERE dc.user_id = u.id
          AND dc.checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date
          AND COALESCE(dc.is_freeze, FALSE) = FALSE
      ) dc7 ON TRUE

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS workouts_count_7d,
          MAX(wl.created_at)::date AS last_workout_date
        FROM workout_logs wl
        WHERE wl.user_id = u.id
          AND wl.created_at >= NOW() - INTERVAL '7 days'
      ) wl7 ON TRUE

      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS sunday_checkins_count_14d,
          MAX(sc.created_at)::date AS last_sunday_checkin_date
        FROM sunday_checkins sc
        WHERE sc.user_id = u.id
          AND sc.created_at >= NOW() - INTERVAL '14 days'
      ) sc14 ON TRUE

      WHERE tm.status = 'active'
        AND u.role = 'user'
        AND COALESCE(u.approval_status, 'approved') = 'approved'
        AND (CURRENT_DATE - COALESCE(lc.last_checkin_date, u.created_at::date))::int >= 2

      ORDER BY
        CASE
          WHEN (CURRENT_DATE - COALESCE(lc.last_checkin_date, u.created_at::date))::int >= 5 THEN 0
          ELSE 1
        END ASC,
        (CURRENT_DATE - COALESCE(lc.last_checkin_date, u.created_at::date))::int DESC
      LIMIT ?
    `, [limit]);

    res.json(rows || []);
  } catch (e) {
    console.error('[attention-clients]', e.message);
    res.status(500).json([]);
  }
});

// ==================================================================================
// ============ OPERATOR: READ-ONLY USER-ACTIVITY MONITORING DASHBOARD ==============
// ==================================================================================
// The Operator role is monitoring-only: it can SEE everything a client does but can
// change nothing. Every route below is a pure GET gated by `requireOperator`
// (admin/superadmin also pass, so they can QA the view). There are deliberately NO
// write endpoints here — all client management stays with Admin/Superadmin.

// --- Member home: what have I done today, and what is left ---
// The home screen used to answer this from half a dozen scattered reads, which
// is why it could tell you to check in after you already had. One read, one
// truth, and every figure is about TODAY unless it says otherwise.
app.get('/api/member/home', verifyToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const one = async (sql, params = [uid]) => {
      const r = await queryOne(sql, params);
      return r ? Number(r.c || 0) : 0;
    };

    // Every read below is independent of every other, so they go out together
    // rather than one-after-another. Same queries, same results, one round trip
    // of latency instead of fourteen.
    const [
      checkedIn, workoutToday, mealsToday, waterToday, sundayThisWeek,
      weekRow, streakRow, user, today, bloodRows, whoop, unread, programs
    ] = await Promise.all([
      one(`SELECT COUNT(*)::int c FROM daily_checkins WHERE user_id = ? AND checkin_date = CURRENT_DATE AND COALESCE(is_freeze, FALSE) = FALSE`),
      one(`SELECT COUNT(*)::int c FROM workout_logs WHERE user_id = ? AND created_at::date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM nutrition_meal_logs WHERE user_id = ? AND log_date = CURRENT_DATE`),
      one(`SELECT COALESCE(SUM(amount_ml), 0)::int c FROM hydration_logs WHERE user_id = ? AND created_at::date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM sunday_checkins WHERE user_id = ? AND created_at >= date_trunc('week', CURRENT_DATE)`),

      // A 7-day strip of which days were checked in, oldest -> newest.
      queryOne(`
      SELECT string_agg(CASE WHEN EXISTS (
               SELECT 1 FROM daily_checkins d WHERE d.user_id = ? AND d.checkin_date = g.day
                 AND COALESCE(d.is_freeze, FALSE) = FALSE) THEN '1' ELSE '0' END, '' ORDER BY g.day) AS days
        FROM generate_series((CURRENT_DATE - INTERVAL '6 days')::date, CURRENT_DATE, INTERVAL '1 day') AS g(day)`, [uid]),

      // Current streak of consecutive days ending today or yesterday.
      queryOne(`
      WITH d AS (
        SELECT DISTINCT checkin_date FROM daily_checkins
         WHERE user_id = ? AND COALESCE(is_freeze, FALSE) = FALSE AND checkin_date <= CURRENT_DATE
      ), g AS (
        SELECT checkin_date, checkin_date - (ROW_NUMBER() OVER (ORDER BY checkin_date))::int AS grp FROM d
      )
      SELECT COUNT(*)::int AS c FROM g
       WHERE grp = (SELECT grp FROM g ORDER BY checkin_date DESC LIMIT 1)
         AND (SELECT MAX(checkin_date) FROM d) >= CURRENT_DATE - 1`, [uid]),

      queryOne(`
      SELECT first_name, last_name, email, profile_picture, goal_type, diet_type,
             goal_steps, goal_water_ml, goal_protein_g, goal_sleep_hours,
             subscription_status, plan_label, access_expires_at, created_at
        FROM users WHERE id = ?`, [uid]),

      queryOne(
      `SELECT steps, water_ml, protein_g, sleep_hours FROM daily_checkins
        WHERE user_id = ? AND checkin_date = CURRENT_DATE AND COALESCE(is_freeze, FALSE) = FALSE
        ORDER BY created_at DESC LIMIT 1`, [uid]),

      // What the upload panel needs to know.
      queryAll(
      `SELECT id, status, report_date, created_at, sent_to_user,
              ai_report->>'overall_status' AS overall_status
         FROM blood_analysis_reports WHERE user_id = ?
        ORDER BY COALESCE(report_date, created_at::date) DESC, created_at DESC LIMIT 5`, [uid]),

      (async () => {
        try {
          const [w, up] = await Promise.all([
            queryOne(`SELECT COUNT(*)::int AS c, MAX(date)::text AS last_day FROM readiness_daily WHERE user_id = ?`, [uid]),
            queryOne(`SELECT COUNT(*)::int AS c, MAX(created_at) AS last_at FROM wearable_uploads WHERE user_id = ? AND status = 'committed'`, [uid])
          ]);
          const days = w ? Number(w.c || 0) : 0;
          return {
            connected: days > 0,
            last_sync: (w && w.last_day) || null,
            days: days,
            uploads: up ? Number(up.c || 0) : 0,
            last_upload_at: (up && up.last_at) || null
          };
        } catch (e) { /* wearables tables are optional on older installs */ }
        return { connected: false, last_sync: null, days: 0, uploads: 0 };
      })(),

      one(
      `SELECT COUNT(*)::int c FROM thread_messages m
         JOIN message_threads t ON t.id = m.thread_id
        WHERE t.user_id = ? AND m.sender_role <> 'user'
          AND m.created_at > COALESCE((SELECT MAX(created_at) FROM thread_messages me
                WHERE me.thread_id = t.id AND me.sender_role = 'user'), '1970-01-01')`),

      one(`SELECT COUNT(*)::int c FROM programs`, [])
    ]);

    res.json({
      user: user || {},
      today: {
        checked_in: checkedIn > 0,
        workout_logged: workoutToday > 0,
        meals_logged: mealsToday,
        // Water lands in two places: the hydration widget appends to hydration_logs,
        // the daily check-in writes daily_checkins.water_ml and never touches that
        // table. Reading only hydration_logs meant a member who filled the check-in
        // saw 0 ml here. Take the larger of the two — both are a stated day total,
        // so summing them would double-count a member who used both.
        water_ml: Math.max(waterToday, Number((today && today.water_ml) || 0)) || 0,
        sunday_done: sundayThisWeek > 0,
        is_sunday: new Date().getDay() === 0,
        steps: today ? today.steps : null,
        protein_g: today ? today.protein_g : null,
        sleep_hours: today ? today.sleep_hours : null
      },
      week: (weekRow && weekRow.days) || '0000000',
      streak: streakRow ? Number(streakRow.c || 0) : 0,
      blood: { reports: bloodRows || [], slots_used: (bloodRows || []).length, slots_total: 3 },
      whoop,
      unread_messages: unread,
      programs
    });
  } catch (e) {
    console.error('[member home]', e.message);
    res.status(500).json({ error: 'Failed to load your home' });
  }
});

// --- Admin landing: every figure the Dashboard shows, in one read ---
// The landing used to assemble itself from ten separate calls, which is why its
// numbers could disagree with each other. One endpoint, one snapshot.
app.get('/api/admin/overview', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const one = async (sql, params = []) => {
      const r = await queryOne(sql, params);
      return r ? Number(r.c || 0) : 0;
    };
    const CLIENT = `u.role = 'user'
      AND (u.approval_status IS NULL OR u.approval_status = 'approved')
      AND (u.email NOT LIKE '%@test.bodybank.fit')
      AND (LOWER(COALESCE(u.first_name, '')) NOT LIKE '%e2e%')
      AND COALESCE(u.suspended, FALSE) = FALSE`;

    // The four groups below do not depend on each other, so they are started
    // together and awaited once. Same queries, same snapshot — the landing simply
    // stops waiting for each group to finish before the next one begins.
    const rosterP = Promise.all([
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT}`),
      // Every activity count is scoped to the same client set as `members`.
      // Unscoped, a test or suspended account logging anything inflated
      // "Active" above the roster it is measured against.
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT} AND (
             EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = CURRENT_DATE AND COALESCE(d.is_freeze, FALSE) = FALSE)
          OR EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at::date = CURRENT_DATE)
          OR EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date = CURRENT_DATE)
          OR EXISTS (SELECT 1 FROM weight_logs g WHERE g.user_id = u.id AND g.created_at::date = CURRENT_DATE))`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT} AND (
             EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date >= CURRENT_DATE - 6 AND COALESCE(d.is_freeze, FALSE) = FALSE)
          OR EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at >= NOW() - INTERVAL '7 days')
          OR EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date >= CURRENT_DATE - 6)
          OR EXISTS (SELECT 1 FROM weight_logs g WHERE g.user_id = u.id AND g.created_at >= NOW() - INTERVAL '7 days'))`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT}
             AND EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = CURRENT_DATE AND COALESCE(d.is_freeze, FALSE) = FALSE)`),
      // Two different questions, so two different numbers: how many SESSIONS
      // were logged (volume), and how many PEOPLE logged one (coverage). The
      // landing shows coverage, because every tile opens a list of people.
      one(`SELECT COUNT(*)::int c FROM workout_logs w JOIN users u ON u.id = w.user_id WHERE ${CLIENT} AND w.created_at::date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM nutrition_meal_logs m JOIN users u ON u.id = m.user_id WHERE ${CLIENT} AND m.log_date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT}
             AND EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at::date = CURRENT_DATE)`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT}
             AND EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date = CURRENT_DATE)`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT} AND u.subscription_status = 'trialing'`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT} AND u.subscription_status = 'trialing'
             AND u.access_expires_at IS NOT NULL AND u.access_expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT} AND u.subscription_status = 'trialing'
             AND u.access_expires_at IS NOT NULL AND u.access_expires_at < NOW()`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${CLIENT} AND u.created_at >= NOW() - INTERVAL '7 days'`)
    ]);

    // Work that is genuinely waiting on the admin.
    const pipelineP = Promise.all([
      // The stage workflow never writes audit_requests.status, so counting
      // status='pending' returned every audit ever submitted. The column that
      // actually means "not looked at yet" is the pipeline's New audit stage.
      one(`SELECT COUNT(*)::int c FROM audit_requests WHERE COALESCE(NULLIF(stage, ''), 'new_audit') = 'new_audit'`),
      one(`SELECT COUNT(*)::int c FROM audit_requests WHERE created_at::date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM audit_requests WHERE created_at >= NOW() - INTERVAL '7 days'`),
      one(`SELECT COUNT(*)::int c FROM audit_requests a WHERE a.created_at >= NOW() - INTERVAL '30 days'
             AND NOT EXISTS (SELECT 1 FROM users u2 WHERE LOWER(u2.email) = LOWER(a.email) AND u2.role = 'user')`),
      one(`SELECT COUNT(*)::int c FROM part2_audit WHERE created_at::date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM part2_audit WHERE created_at >= NOW() - INTERVAL '7 days'`),
      one(`SELECT COUNT(*)::int c FROM message_threads t WHERE (
             SELECT sender_role FROM thread_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) = 'user'`),
      one(`SELECT COUNT(*)::int c FROM operator_escalations WHERE status = 'open'`),
      one(`SELECT COUNT(*)::int c FROM blood_analysis_reports WHERE COALESCE(status, '') <> 'complete'`),
      one(`SELECT COUNT(*)::int c FROM blood_analysis_reports WHERE status = 'complete' AND COALESCE(sent_to_user, FALSE) = FALSE`),
      one(`SELECT COUNT(*)::int c FROM contact_messages`)
    ]);

    // 14 days of distinct active clients — the same definition used everywhere
    // else, so the landing can never disagree with the Clients list.
    const trendP = queryAll(`
      WITH days AS (
        SELECT generate_series((CURRENT_DATE - INTERVAL '13 days')::date, CURRENT_DATE, INTERVAL '1 day')::date AS d
      )
      SELECT days.d::text AS day,
        (SELECT COUNT(*)::int FROM users u WHERE ${CLIENT} AND (
             EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = days.d AND COALESCE(d.is_freeze, FALSE) = FALSE)
          OR EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at::date = days.d)
          OR EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date = days.d)
          OR EXISTS (SELECT 1 FROM weight_logs g WHERE g.user_id = u.id AND g.created_at::date = days.d))) AS active,
        (SELECT COUNT(*)::int FROM audit_requests r WHERE r.created_at::date = days.d) AS audits
      FROM days ORDER BY days.d`);

    // Live feed, newest first.
    const feedP = Promise.all([
      queryAll(`SELECT u.first_name, u.last_name, dc.created_at FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id
                          WHERE COALESCE(dc.is_freeze, FALSE) = FALSE ORDER BY dc.created_at DESC LIMIT 10`),
      queryAll(`SELECT u.first_name, u.last_name, w.workout_name, w.created_at FROM workout_logs w LEFT JOIN users u ON u.id = w.user_id
                          ORDER BY w.created_at DESC LIMIT 10`),
      queryAll(`SELECT u.first_name, u.last_name, m.meal_type, m.submitted_at AS created_at FROM nutrition_meal_logs m LEFT JOIN users u ON u.id = m.user_id
                          ORDER BY m.submitted_at DESC LIMIT 10`),
      queryAll(`SELECT first_name, last_name, email, created_at FROM audit_requests ORDER BY created_at DESC LIMIT 8`),
      queryAll(`SELECT full_name, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT 6`)
    ]);

    const [
      [
        members, activeToday, active7d, checkedIn, workouts, meals, trainedToday, ateToday,
        trials, expiring, trialsEnded, newMembers7d
      ],
      [
        pendingAudits, auditsToday, audits7d, auditsNoAccount, part2Today, part2_7d,
        unreadThreads, escalations, bloodPending, bloodUnsent, contactMsgs
      ],
      trendRows,
      [feedCheckins, feedWorkouts, feedMeals, feedAudits, feedSundays]
    ] = await Promise.all([rosterP, pipelineP, trendP, feedP]);

    const feed = [];
    const nm = r => (String(r.first_name || '') + ' ' + String(r.last_name || '')).trim() || 'Client';
    const push = (rows, map) => (rows || []).forEach(r => feed.push(map(r)));
    push(feedCheckins,
      r => ({ name: nm(r), type: 'checkin', label: 'Daily check-in', created_at: r.created_at }));
    push(feedWorkouts,
      r => ({ name: nm(r), type: 'workout', label: 'Logged: ' + (r.workout_name || 'Workout'), created_at: r.created_at }));
    push(feedMeals,
      r => ({ name: nm(r), type: 'nutrition', label: 'Meal logged (' + (r.meal_type || 'meal') + ')', created_at: r.created_at }));
    push(feedAudits,
      r => ({ name: nm(r) !== 'Client' ? nm(r) : (r.email || 'Prospect'), type: 'signup', label: 'Body audit submitted', created_at: r.created_at }));
    push(feedSundays,
      r => ({ name: r.full_name || 'Client', type: 'weekly', label: 'Weekly (Sunday) check-in', created_at: r.created_at }));
    feed.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    // ── Nutrition assessments + wearables, for the DESKTOP dashboard ────────
    // The admin console has two entirely separate panes: .admin-dash-page (mobile,
    // fed by /api/operator/overview) and .bb-desktop-dashboard (fed by THIS
    // endpoint). On desktop the mobile pane is `display:none !important`, so a
    // widget added to only one of them is invisible on the other — which is
    // exactly why these two features could not be seen on the web console.
    // See the same warning at public/index.html: "The widget HTML exists in two
    // places (.bb-desktop-dashboard + .admin-dash-page)".
    //
    // safeOne so a deployment whose migration has not run loses one number rather
    // than the whole dashboard to a 500.
    const safeOneA = async (sql) => {
      try {
        const r = await queryOne(sql);
        return r ? Number(r.c || 0) : 0;
      } catch (_) { return 0; }
    };
    const [naTotalA, naCompleteA, naFlaggedA, naNew7dA, naPart1A, naPart2A, wearMembersA, wearUploads7dA] = await Promise.all([
      safeOneA(`SELECT COUNT(*)::int c FROM nutrition_assessments`),
      safeOneA(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE status = 'complete'`),
      safeOneA(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE review_status = 'blocked'`),
      safeOneA(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE created_at >= NOW() - INTERVAL '7 days'`),
      safeOneA(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE part1_submitted_at IS NOT NULL`),
      safeOneA(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE part2_submitted_at IS NOT NULL`),
      safeOneA(`SELECT COUNT(DISTINCT user_id)::int c FROM readiness_daily WHERE source <> 'derived'`),
      safeOneA(`SELECT COUNT(*)::int c FROM wearable_uploads WHERE status = 'committed' AND created_at >= NOW() - INTERVAL '7 days'`)
    ]);
    let wearByDeviceA = [];
    try {
      wearByDeviceA = (await queryAll(
        `SELECT source, COUNT(DISTINCT user_id)::int AS members
           FROM readiness_daily WHERE source <> 'derived'
          GROUP BY source ORDER BY members DESC`
      )) || [];
    } catch (_) { wearByDeviceA = []; }

    // The desktop feed is built from its own queries, so these two need adding
    // here as well or a submission never shows up in "what just happened".
    try {
      push(await queryAll(
        `SELECT full_name, review_status, status, COALESCE(submitted_at, created_at) AS created_at
           FROM nutrition_assessments ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 8`
      ), r => ({
        name: r.full_name || 'Prospect',
        type: 'assessment',
        label: r.review_status === 'blocked'
          ? 'FitChef assessment — needs review'
          : (r.status === 'complete' ? 'FitChef assessment completed' : 'FitChef assessment started'),
        created_at: r.created_at
      }));
    } catch (_) { /* not migrated here */ }
    try {
      push(await queryAll(
        `SELECT u.first_name, u.last_name, wu.provider, wu.created_at
           FROM wearable_uploads wu LEFT JOIN users u ON u.id = wu.user_id
          WHERE wu.status = 'committed' ORDER BY wu.created_at DESC LIMIT 8`
      ), r => ({
        name: nm(r),
        type: 'wearable',
        label: 'Watch data imported (' + String(r.provider || 'device').replace(/_/g, ' ') + ')',
        created_at: r.created_at
      }));
    } catch (_) { /* not migrated here */ }
    feed.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    res.json({
      nutritionAssessments: {
        total: naTotalA,
        complete: naCompleteA,
        in_progress: Math.max(0, naTotalA - naCompleteA),
        needs_review: naFlaggedA,
        new_7d: naNew7dA,
        part1_submitted: naPart1A,
        part2_submitted: naPart2A,
        awaiting_part2: Math.max(0, naPart1A - naPart2A)
      },
      wearables: {
        members: wearMembersA,
        uploads_7d: wearUploads7dA,
        by_device: (wearByDeviceA || []).map(r => ({ provider: r.source, members: Number(r.members || 0) }))
      },
      roster: {
        members, active_today: activeToday, active_7d: active7d, inactive_7d: Math.max(0, members - active7d),
        checked_in_today: checkedIn,
        // volume
        workouts_today: workouts, meals_today: meals,
        // coverage — how many people, which is what the tiles link to
        trained_today: trainedToday, ate_today: ateToday,
        trials, trials_expiring: expiring, trials_ended: trialsEnded, new_members_7d: newMembers7d
      },
      pipeline: {
        pending_audits: pendingAudits, audits_today: auditsToday, audits_7d: audits7d,
        audits_no_account: auditsNoAccount, part2_today: part2Today, part2_7d: part2_7d
      },
      inbox: {
        unread_threads: unreadThreads, escalations, blood_pending: bloodPending,
        blood_unsent: bloodUnsent, contact_messages: contactMsgs
      },
      trends: {
        labels: (trendRows || []).map(r => r.day),
        active: (trendRows || []).map(r => Number(r.active || 0)),
        audits: (trendRows || []).map(r => Number(r.audits || 0))
      },
      feed: feed.slice(0, 20)
    });
  } catch (e) {
    console.error('[admin overview]', e.message);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// Shared WHERE fragment for "a real, active client account".
const OPERATOR_CLIENT_WHERE = `u.role = 'user'
  AND (u.approval_status IS NULL OR u.approval_status = 'approved')
  AND (u.email NOT LIKE '%@test.bodybank.fit')
  AND (LOWER(COALESCE(u.first_name, '')) NOT LIKE '%e2e%')`;

// --- Overview / Pulse: headline stats + live activity feed + at-risk clients ---
app.get('/api/operator/overview', verifyToken, requireOperator, async (req, res) => {
  try {
    const one = async (sql, params = []) => {
      const r = await queryOne(sql, params);
      return r ? Number(r.c || 0) : 0;
    };

    const [
      totalClients, activeToday, checkedInToday, workoutsToday, mealsToday,
      newTrials7d, expiringTrials3d
    ] = await Promise.all([
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE`),
      // scoped to the same roster the percentages are measured against
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE AND (
             EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = CURRENT_DATE AND COALESCE(d.is_freeze, FALSE) = FALSE)
          OR EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at::date = CURRENT_DATE)
          OR EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date = CURRENT_DATE)
          OR EXISTS (SELECT 1 FROM weight_logs g WHERE g.user_id = u.id AND g.created_at::date = CURRENT_DATE)
          OR EXISTS (SELECT 1 FROM hydration_logs h WHERE h.user_id = u.id AND h.created_at::date = CURRENT_DATE))`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE
             AND EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = CURRENT_DATE AND COALESCE(d.is_freeze, FALSE) = FALSE)`),
      one(`SELECT COUNT(*)::int c FROM workout_logs w JOIN users u ON u.id = w.user_id WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE AND w.created_at::date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM nutrition_meal_logs m JOIN users u ON u.id = m.user_id WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE AND m.log_date = CURRENT_DATE`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND u.subscription_status = 'trialing' AND u.created_at >= NOW() - INTERVAL '7 days'`),
      one(`SELECT COUNT(*)::int c FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND u.subscription_status = 'trialing' AND u.access_expires_at IS NOT NULL AND u.access_expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`)
    ]);

    // At-risk counts (inactivity by last daily check-in; falls back to signup date).
    const riskRow = await queryOne(`
      WITH last_checkin AS (
        SELECT user_id, MAX(checkin_date)::date AS lc FROM daily_checkins WHERE COALESCE(is_freeze, FALSE) = FALSE GROUP BY user_id
      )
      SELECT
        COUNT(*) FILTER (WHERE inactive >= 5)::int AS p0,
        COUNT(*) FILTER (WHERE inactive >= 2 AND inactive < 5)::int AS p1
      FROM (
        SELECT (CURRENT_DATE - COALESCE(lc.lc, u.created_at::date))::int AS inactive
        FROM users u LEFT JOIN last_checkin lc ON lc.user_id = u.id
        WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE
      ) t`);

    // ── Nutrition assessments + wearable uploads ────────────────────────────
    // Both features shipped with member-facing and per-member staff views but no
    // presence on the dashboards, so an admin on mobile — where bbmd is the whole
    // console — had no way to see that either existed.
    //
    // Every count goes through safeOne: these tables are created by their own
    // feature's migration, and a deployment that has not run it yet must still get
    // a working dashboard rather than a 500 that blanks every other number on the
    // screen. A missing table reads as zero, which is honest here.
    const safeOne = async (sql, params = []) => {
      try { return await one(sql, params); } catch (_) { return 0; }
    };

    const [
      naTotal, naComplete, naNeedsReview, naNew7d, naPart1, naPart2,
      wearMembers, wearUploads7d, wearDaysTotal, wearActive7d
    ] = await Promise.all([
      safeOne(`SELECT COUNT(*)::int c FROM nutrition_assessments`),
      safeOne(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE status = 'complete'`),
      // 'blocked' is what review.reviewStatus() writes when a flag demands a human
      // — a clinician-review or safety flag, not merely an odd answer.
      safeOne(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE review_status = 'blocked'`),
      safeOne(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE created_at >= NOW() - INTERVAL '7 days'`),
      // Counted off the part stamps rather than off `status`, so a row that is
      // mid-part-2 still counts as a part-1 submission.
      safeOne(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE part1_submitted_at IS NOT NULL`),
      safeOne(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE part2_submitted_at IS NOT NULL`),
      // Distinct members with any wearable day at all, across every provider —
      // this is the number that shows multi-device adoption rather than Whoop's.
      safeOne(`SELECT COUNT(DISTINCT user_id)::int c FROM readiness_daily WHERE source <> 'derived'`),
      safeOne(`SELECT COUNT(*)::int c FROM wearable_uploads WHERE status = 'committed' AND created_at >= NOW() - INTERVAL '7 days'`),
      safeOne(`SELECT COUNT(*)::int c FROM readiness_daily WHERE source <> 'derived'`),
      safeOne(`SELECT COUNT(DISTINCT user_id)::int c FROM readiness_daily WHERE source <> 'derived' AND date >= CURRENT_DATE - 7`)
    ]);

    // Which devices the roster actually wears. Drives the staff-facing device mix
    // and, more usefully, tells an admin at a glance when someone is on a
    // screenshot-only band whose numbers carry lower confidence.
    let wearByDevice = [];
    try {
      wearByDevice = (await queryAll(
        `SELECT source, COUNT(DISTINCT user_id)::int AS members, COUNT(*)::int AS days,
                MAX(date)::date AS last_date
           FROM readiness_daily
          WHERE source <> 'derived'
          GROUP BY source
          ORDER BY members DESC, days DESC`
      )) || [];
    } catch (_) { wearByDevice = []; }

    // Live activity feed (most recent user actions across the platform).
    const feed = [];
    const push = (rows, mapper) => (rows || []).forEach(r => feed.push(mapper(r)));
    const nm = r => (String(r.first_name || '') + ' ' + String(r.last_name || '')).trim() || 'Client';
    push(await queryAll(`SELECT u.first_name, u.last_name, dc.checkin_date, dc.created_at FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id WHERE COALESCE(dc.is_freeze, FALSE) = FALSE ORDER BY dc.created_at DESC LIMIT 12`),
      r => ({ name: nm(r), type: 'checkin', label: 'Daily check-in', created_at: r.created_at }));
    push(await queryAll(`SELECT u.first_name, u.last_name, w.workout_name, w.created_at FROM workout_logs w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT 12`),
      r => ({ name: nm(r), type: 'workout', label: 'Logged: ' + (r.workout_name || 'Workout'), created_at: r.created_at }));
    push(await queryAll(`SELECT u.first_name, u.last_name, m.meal_type, m.submitted_at AS created_at FROM nutrition_meal_logs m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.submitted_at DESC LIMIT 12`),
      r => ({ name: nm(r), type: 'nutrition', label: 'Meal logged (' + (r.meal_type || 'meal') + ')', created_at: r.created_at }));
    push(await queryAll(`SELECT u.first_name, u.last_name, wt.weight_kg, wt.created_at FROM weight_logs wt LEFT JOIN users u ON u.id = wt.user_id ORDER BY wt.created_at DESC LIMIT 8`),
      r => ({ name: nm(r), type: 'weight', label: 'Weight logged: ' + (r.weight_kg != null ? r.weight_kg + ' kg' : ''), created_at: r.created_at }));
    push(await queryAll(`SELECT full_name, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT 6`),
      r => ({ name: r.full_name || 'Client', type: 'weekly', label: 'Weekly (Sunday) check-in', created_at: r.created_at }));
    push(await queryAll(`SELECT first_name, last_name, created_at FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND u.subscription_status = 'trialing' ORDER BY created_at DESC LIMIT 6`),
      r => ({ name: nm(r), type: 'signup', label: 'Started 7-day trial', created_at: r.created_at }));

    // Both of these are wrapped rather than pushed blind: an unmigrated deployment
    // must lose one feed row, not the whole activity feed.
    try {
      push(await queryAll(
        `SELECT full_name, review_status, status, COALESCE(submitted_at, created_at) AS created_at
           FROM nutrition_assessments
          ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 8`
      ), r => ({
        name: r.full_name || 'Prospect',
        type: 'assessment',
        label: r.review_status === 'blocked'
          ? 'FitChef assessment — needs review'
          : (r.status === 'complete' ? 'FitChef assessment completed' : 'FitChef assessment started'),
        created_at: r.created_at
      }));
    } catch (_) { /* table not migrated here */ }

    try {
      push(await queryAll(
        `SELECT u.first_name, u.last_name, wu.provider, wu.date_from, wu.date_to, wu.created_at
           FROM wearable_uploads wu LEFT JOIN users u ON u.id = wu.user_id
          WHERE wu.status = 'committed'
          ORDER BY wu.created_at DESC LIMIT 8`
      ), r => ({
        name: nm(r),
        type: 'wearable',
        // Name the device rather than saying "watch data": which device it came
        // from is exactly what tells staff how far to trust the numbers.
        label: 'Watch data imported (' + String(r.provider || 'device').replace(/_/g, ' ') + ')',
        created_at: r.created_at
      }));
    } catch (_) { /* table not migrated here */ }

    feed.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    // 14-day activity trend (for charts).
    const trendRows = await queryAll(`
      WITH days AS (
        SELECT generate_series((CURRENT_DATE - INTERVAL '13 days')::date, CURRENT_DATE, INTERVAL '1 day')::date AS d
      )
      SELECT days.d::text AS day,
        -- how many DISTINCT clients did anything at all that day: the only
        -- honest way to show whether engagement is climbing or sliding
        (SELECT COUNT(*)::int FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE AND (
             EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = days.d AND COALESCE(d.is_freeze, FALSE) = FALSE)
          OR EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at::date = days.d)
          OR EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date = days.d)
          OR EXISTS (SELECT 1 FROM weight_logs g WHERE g.user_id = u.id AND g.created_at::date = days.d))) AS active,
        (SELECT COUNT(*)::int FROM daily_checkins dc JOIN users u ON u.id = dc.user_id
           WHERE ${OPERATOR_CLIENT_WHERE} AND dc.checkin_date = days.d AND COALESCE(dc.is_freeze, FALSE) = FALSE) AS checkins,
        (SELECT COUNT(*)::int FROM workout_logs w JOIN users u ON u.id = w.user_id
           WHERE ${OPERATOR_CLIENT_WHERE} AND w.created_at::date = days.d) AS workouts,
        (SELECT COUNT(*)::int FROM nutrition_meal_logs m JOIN users u ON u.id = m.user_id
           WHERE ${OPERATOR_CLIENT_WHERE} AND m.log_date = days.d) AS meals
      FROM days ORDER BY days.d`);

    // Average 7-day check-in consistency across all active clients (0..7).
    const avgRow = await queryOne(`
      SELECT COALESCE(AVG(c7), 0)::float AS avg_checkins_7d FROM (
        SELECT (SELECT COUNT(*) FROM daily_checkins dc WHERE dc.user_id = u.id
                  AND dc.checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date
                  AND COALESCE(dc.is_freeze, FALSE) = FALSE) AS c7
        FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE
      ) t`);

    const pct = (n, d) => (d > 0 ? Math.round((Number(n) / Number(d)) * 100) : 0);

    res.json({
      stats: {
        total_clients: totalClients,
        active_today: activeToday,
        checked_in_today: checkedInToday,
        workouts_today: workoutsToday,
        meals_today: mealsToday,
        new_trials_7d: newTrials7d,
        expiring_trials_3d: expiringTrials3d,
        at_risk_p0: riskRow ? Number(riskRow.p0 || 0) : 0,
        at_risk_p1: riskRow ? Number(riskRow.p1 || 0) : 0
      },
      engagement: {
        active_rate: pct(activeToday, totalClients),
        checkin_rate: pct(checkedInToday, totalClients),
        avg_consistency_pct: avgRow ? Math.round((Number(avgRow.avg_checkins_7d || 0) / 7) * 100) : 0,
        at_risk_rate: pct((riskRow ? Number(riskRow.p0 || 0) + Number(riskRow.p1 || 0) : 0), totalClients)
      },
      trends: {
        labels: (trendRows || []).map(r => r.day),
        active: (trendRows || []).map(r => Number(r.active || 0)),
        checkins: (trendRows || []).map(r => Number(r.checkins || 0)),
        workouts: (trendRows || []).map(r => Number(r.workouts || 0)),
        meals: (trendRows || []).map(r => Number(r.meals || 0))
      },
      // Nutrition assessment funnel. `needs_review` is the only number here that
      // demands an action today, so it is the one the dashboards surface as a chip.
      nutritionAssessments: {
        total: naTotal,
        complete: naComplete,
        in_progress: Math.max(0, naTotal - naComplete),
        needs_review: naNeedsReview,
        new_7d: naNew7d,
        completion_rate: pct(naComplete, naTotal),
        // The two-part funnel, which is what staff actually chase.
        part1_submitted: naPart1,
        part2_submitted: naPart2,
        awaiting_part2: Math.max(0, naPart1 - naPart2),
        part2_rate: pct(naPart2, naPart1)
      },
      // Wearable adoption across every provider, not just Whoop.
      wearables: {
        members: wearMembers,
        active_7d: wearActive7d,
        uploads_7d: wearUploads7d,
        days_total: wearDaysTotal,
        adoption_rate: pct(wearMembers, totalClients),
        by_device: (wearByDevice || []).map(r => ({
          provider: r.source,
          members: Number(r.members || 0),
          days: Number(r.days || 0),
          last_date: r.last_date
        }))
      },
      feed: feed.slice(0, 25)
    });
  } catch (e) {
    console.error('[operator overview]', e.message);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// --- Client Monitor: every client with an at-a-glance engagement row ---
app.get('/api/operator/clients', verifyToken, requireOperator, async (req, res) => {
  try {
    const rows = await queryAll(`
      WITH last_checkin AS (
        SELECT user_id, MAX(checkin_date)::date AS lc FROM daily_checkins WHERE COALESCE(is_freeze, FALSE) = FALSE GROUP BY user_id
      ),
      last_workout AS (
        SELECT user_id, MAX(created_at) AS lw FROM workout_logs GROUP BY user_id
      ),
      dc7 AS (
        SELECT user_id, COUNT(*)::int AS c FROM daily_checkins
        WHERE checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date AND COALESCE(is_freeze, FALSE) = FALSE GROUP BY user_id
      ),
      wo7 AS (
        SELECT user_id, COUNT(*)::int AS c FROM workout_logs WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY user_id
      ),
      -- One character per day, oldest -> newest, for the 7-dot week strip on a
      -- client card. A count alone cannot say WHICH days were missed.
      week AS (
        SELECT u.id AS user_id, string_agg(
                 CASE WHEN EXISTS (
                   SELECT 1 FROM daily_checkins dc
                    WHERE dc.user_id = u.id AND dc.checkin_date = d.day
                      AND COALESCE(dc.is_freeze, FALSE) = FALSE
                 ) THEN '1' ELSE '0' END, '' ORDER BY d.day) AS days
          FROM users u
          CROSS JOIN generate_series((CURRENT_DATE - INTERVAL '6 days')::date, CURRENT_DATE, INTERVAL '1 day') AS d(day)
         WHERE u.role = 'user'
         GROUP BY u.id
      ),
      blood AS (
        SELECT user_id, COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE COALESCE(status,'') <> 'complete')::int AS pending,
               MAX(COALESCE(report_date, created_at::date))::text AS latest
          FROM blood_analysis_reports GROUP BY user_id
      ),
      cmp AS (
        SELECT user_id, COUNT(*)::int AS n FROM blood_comparison_reports GROUP BY user_id
      ),
      -- "Active" means the client did SOMETHING, not just that they filed a
      -- daily check-in: a logged workout or meal counts every bit as much.
      act AS (
        SELECT user_id, MAX(ts) AS last_at FROM (
          SELECT user_id, checkin_date::timestamp AS ts FROM daily_checkins WHERE COALESCE(is_freeze, FALSE) = FALSE
          UNION ALL SELECT user_id, created_at::timestamp FROM workout_logs
          UNION ALL SELECT user_id, log_date::timestamp FROM nutrition_meal_logs
          UNION ALL SELECT user_id, created_at::timestamp FROM weight_logs
        ) x GROUP BY user_id
      ),
      today AS (
        SELECT u.id AS user_id,
          EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date = CURRENT_DATE
                    AND COALESCE(d.is_freeze, FALSE) = FALSE) AS checkin_today,
          EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at::date = CURRENT_DATE) AS workout_today,
          EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date = CURRENT_DATE) AS meal_today
        FROM users u WHERE u.role = 'user'
      )
      SELECT
        u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
        u.subscription_status, u.access_expires_at, u.created_at,
        u.nutrition_ai_last_used_at, u.ai_trainer_last_used_at,
        lc.lc::text AS last_checkin_date,
        act.last_at AS last_activity_at,
        -- days since ANY activity; falls back to signup so a brand-new account
        -- reads as new rather than as silent forever
        (CURRENT_DATE - COALESCE(act.last_at::date, u.created_at::date))::int AS inactive_days,
        (act.last_at IS NOT NULL AND act.last_at >= (CURRENT_DATE - INTERVAL '6 days')) AS active_7d,
        COALESCE(today.checkin_today, FALSE) AS checkin_today,
        COALESCE(today.workout_today, FALSE) AS workout_today,
        COALESCE(today.meal_today, FALSE) AS meal_today,
        lw.lw AS last_workout_at,
        COALESCE(dc7.c, 0)::int AS checkins_7d,
        COALESCE(wo7.c, 0)::int AS workouts_7d,
        COALESCE(week.days, '0000000') AS checkin_week,
        COALESCE(blood.n, 0)::int AS blood_reports,
        COALESCE(blood.pending, 0)::int AS blood_pending,
        blood.latest AS blood_latest,
        COALESCE(cmp.n, 0)::int AS blood_comparisons
      FROM users u
      LEFT JOIN last_checkin lc ON lc.user_id = u.id
      LEFT JOIN last_workout lw ON lw.user_id = u.id
      LEFT JOIN dc7 ON dc7.user_id = u.id
      LEFT JOIN wo7 ON wo7.user_id = u.id
      LEFT JOIN week ON week.user_id = u.id
      LEFT JOIN blood ON blood.user_id = u.id
      LEFT JOIN cmp ON cmp.user_id = u.id
      LEFT JOIN act ON act.user_id = u.id
      LEFT JOIN today ON today.user_id = u.id
      WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE
      ORDER BY inactive_days DESC, LOWER(COALESCE(u.first_name, '')), LOWER(COALESCE(u.last_name, ''))
    `);
    res.json({ rows: rows || [] });
  } catch (e) {
    console.error('[operator clients]', e.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// --- Client drilldown: full read-only activity profile for one client ---
app.get('/api/operator/clients/:id', verifyToken, requireOperator, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const user = await queryOne(
      `SELECT id, first_name, last_name, email, phone, country, city, gender, dob, profile_picture,
              subscription_status, plan_label, access_expires_at, created_at, timezone,
              goal_steps, goal_water_ml, goal_protein_g, goal_sleep_hours, height_cm, goal_type, diet_type,
              nutrition_ai_last_used_at, ai_trainer_last_used_at
       FROM users WHERE id = ? AND role = 'user'`, [id]);
    if (!user) return res.status(404).json({ error: 'Client not found' });

    const [daily, workouts, weights, nutritionDaily, meals, strength, hydration, sunday, bodyRows, bloodReports] = await Promise.all([
      queryAll(`SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, COALESCE(is_freeze,FALSE) AS is_freeze, created_at FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 21`, [id]),
      // Full workout detail incl. per-exercise weight (session_lifts) & reps (session_reps).
      queryAll(`SELECT workout_name, workout_type, duration_seconds, feedback, session_lifts, session_reps, bench_kg, squat_kg, deadlift_kg, intensity, energy_level, workout_completed, session_date, created_at FROM workout_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 24`, [id]),
      queryAll(`SELECT weight_kg, created_at FROM weight_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`, [id]),
      queryAll(`SELECT stat_date, total_calories, total_protein, total_carbs, total_fat, total_fiber, meals_logged, meal_quality_score, calorie_goal, protein_goal FROM nutrition_daily_stats WHERE user_id = ? ORDER BY stat_date DESC LIMIT 21`, [id]),
      // Per-meal detail with full macros from ai_result.
      queryAll(`SELECT log_date, meal_type, portion_size, manual_note, meal_score, ai_result, submitted_at FROM nutrition_meal_logs WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 24`, [id]),
      // Canonical strength time series (bench/squat/deadlift) for a lifts-over-time chart.
      queryAll(`SELECT weight, body_fat, strength_bench, strength_squat, strength_deadlift, created_at FROM progress_logs WHERE user_id = ? ORDER BY created_at ASC LIMIT 120`, [id]),
      queryAll(`SELECT amount_ml, glasses, created_at FROM hydration_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 14`, [id]),
      queryAll(`SELECT full_name, plan, total_weight_loss, training_go, nutrition_go, sleep, created_at FROM sunday_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 6`, [id]),
      queryAll(`SELECT snapshot_date, photo_front, photo_side, photo_back, bodyweight_kg, waist_cm, measurements, notes, created_at FROM body_snapshots WHERE user_id = ? AND shared_with_manager = TRUE ORDER BY snapshot_date DESC, id DESC LIMIT 12`, [id]),
      // Blood reports for the client-profile snapshot + download. Ordered newest-first
      // by LAB date (not upload date) so a back-filled old report sorts where it belongs.
      queryAll(`SELECT id, created_at, report_date, status, sent_to_user, pdf_path,
                       ai_report->>'overall_status' AS overall_status, extracted_blood_data,
                       (blood_report_file_path IS NOT NULL AND blood_report_file_path <> '') AS has_source_file
                FROM blood_analysis_reports WHERE user_id = ?
                ORDER BY COALESCE(report_date, created_at::date) DESC, created_at DESC LIMIT 12`, [id])
    ]);

    res.json({
      user,
      daily_checkins: daily || [],
      workouts: workouts || [],
      weights: weights || [],
      nutrition: nutritionDaily || [],
      meals: meals || [],
      strength: strength || [],
      hydration: hydration || [],
      sunday_checkins: sunday || [],
      body_snapshots: bodyRows || [],
      blood: bloodReports || []
    });
  } catch (e) {
    console.error('[operator client detail]', e.message);
    res.status(500).json({ error: 'Failed to load client' });
  }
});

// --- Activity timeline: filterable stream across all clients ---
app.get('/api/operator/activity', verifyToken, requireOperator, async (req, res) => {
  try {
    const type = String((req.query && req.query.type) || 'all').toLowerCase();
    const rawDays = parseInt(String((req.query && req.query.days) || '7'), 10);
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
    const rawLimit = parseInt(String((req.query && req.query.limit) || '150'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 10), 400) : 150;
    const nm = r => (String(r.first_name || '') + ' ' + String(r.last_name || '')).trim() || 'Client';
    const want = k => type === 'all' || type === k;
    const items = [];

    if (want('checkin')) (await queryAll(`SELECT u.first_name, u.last_name, dc.steps, dc.water_ml, dc.protein_g, dc.created_at FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id WHERE dc.created_at >= NOW() - ($1 || ' days')::interval AND COALESCE(dc.is_freeze,FALSE)=FALSE ORDER BY dc.created_at DESC LIMIT $2`, [String(days), limit]))
      .forEach(r => items.push({ name: nm(r), type: 'checkin', label: 'Daily check-in', detail: [r.steps ? r.steps + ' steps' : '', r.water_ml ? r.water_ml + 'ml water' : '', r.protein_g ? r.protein_g + 'g protein' : ''].filter(Boolean).join(' · '), created_at: r.created_at }));
    if (want('workout')) (await queryAll(`SELECT u.first_name, u.last_name, w.workout_name, w.duration_seconds, w.created_at FROM workout_logs w LEFT JOIN users u ON u.id = w.user_id WHERE w.created_at >= NOW() - ($1 || ' days')::interval ORDER BY w.created_at DESC LIMIT $2`, [String(days), limit]))
      .forEach(r => items.push({ name: nm(r), type: 'workout', label: r.workout_name || 'Workout', detail: r.duration_seconds ? Math.round(r.duration_seconds / 60) + ' min' : '', created_at: r.created_at }));
    if (want('nutrition')) (await queryAll(`SELECT u.first_name, u.last_name, m.meal_type, m.meal_score, m.submitted_at AS created_at FROM nutrition_meal_logs m LEFT JOIN users u ON u.id = m.user_id WHERE m.submitted_at >= NOW() - ($1 || ' days')::interval ORDER BY m.submitted_at DESC LIMIT $2`, [String(days), limit]))
      .forEach(r => items.push({ name: nm(r), type: 'nutrition', label: 'Meal: ' + (r.meal_type || 'meal'), detail: r.meal_score != null ? 'score ' + r.meal_score : '', created_at: r.created_at }));
    if (want('weight')) (await queryAll(`SELECT u.first_name, u.last_name, wt.weight_kg, wt.created_at FROM weight_logs wt LEFT JOIN users u ON u.id = wt.user_id WHERE wt.created_at >= NOW() - ($1 || ' days')::interval ORDER BY wt.created_at DESC LIMIT $2`, [String(days), limit]))
      .forEach(r => items.push({ name: nm(r), type: 'weight', label: 'Weight logged', detail: r.weight_kg != null ? r.weight_kg + ' kg' : '', created_at: r.created_at }));
    if (want('weekly')) (await queryAll(`SELECT full_name AS first_name, '' AS last_name, created_at FROM sunday_checkins WHERE created_at >= NOW() - ($1 || ' days')::interval ORDER BY created_at DESC LIMIT $2`, [String(days), limit]))
      .forEach(r => items.push({ name: r.first_name || 'Client', type: 'weekly', label: 'Weekly (Sunday) check-in', detail: '', created_at: r.created_at }));
    if (want('signup')) (await queryAll(`SELECT first_name, last_name, created_at FROM users u WHERE ${OPERATOR_CLIENT_WHERE} AND u.subscription_status = 'trialing' AND u.created_at >= NOW() - ($1 || ' days')::interval ORDER BY u.created_at DESC LIMIT $2`, [String(days), limit]))
      .forEach(r => items.push({ name: nm(r), type: 'signup', label: 'Started 7-day trial', detail: '', created_at: r.created_at }));

    items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    res.json({ items: items.slice(0, limit) });
  } catch (e) {
    console.error('[operator activity]', e.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// --- Leads: body-audit + Part-2 prospects (to reach out & onboard) ---
app.get('/api/operator/leads', verifyToken, requireOperator, async (req, res) => {
  try {
    const rawDays = parseInt(String((req.query && req.query.days) || '30'), 10);
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 365) : 30;
    const audits = await queryAll(`
      SELECT a.id, a.first_name, a.last_name, a.email, a.phone, a.country, a.city, a.age, a.sex,
             a.occupation, a.fitness_experience, a.goals, a.motivation, a.status, a.stage, a.created_at,
             (u.id IS NOT NULL) AS has_account,
             (p.email IS NOT NULL) AS has_part2
        FROM audit_requests a
        LEFT JOIN users u ON LOWER(u.email) = LOWER(a.email) AND u.role = 'user'
        LEFT JOIN (SELECT DISTINCT LOWER(email) AS email FROM part2_audit) p ON p.email = LOWER(a.email)
       WHERE a.created_at >= NOW() - (? || ' days')::interval
         AND a.email NOT LIKE '%@test.bodybank.fit' AND LOWER(a.email) NOT LIKE '%e2e%'
       ORDER BY a.created_at DESC LIMIT 300`, [String(days)]);
    const part2 = await queryAll(`
      SELECT p.id, p.name, p.email, p.mobile, p.goals, p.activity_level, p.gym_experience, p.injuries,
             p.score, p.tier_label, p.created_at,
             (u.id IS NOT NULL) AS has_account
        FROM part2_audit p
        LEFT JOIN users u ON LOWER(u.email) = LOWER(p.email) AND u.role = 'user'
       WHERE p.created_at >= NOW() - (? || ' days')::interval
         AND p.email NOT LIKE '%@test.bodybank.fit' AND LOWER(p.email) NOT LIKE '%e2e%'
       ORDER BY p.created_at DESC LIMIT 300`, [String(days)]);
    const c = async (sql) => { const r = await queryOne(sql); return r ? Number(r.c || 0) : 0; };
    const counts = {
      audits_today: await c(`SELECT COUNT(*)::int c FROM audit_requests WHERE created_at::date = CURRENT_DATE`),
      audits_7d: await c(`SELECT COUNT(*)::int c FROM audit_requests WHERE created_at >= NOW() - INTERVAL '7 days'`),
      part2_today: await c(`SELECT COUNT(*)::int c FROM part2_audit WHERE created_at::date = CURRENT_DATE`),
      part2_7d: await c(`SELECT COUNT(*)::int c FROM part2_audit WHERE created_at >= NOW() - INTERVAL '7 days'`),
      audits_no_account: await c(`SELECT COUNT(*)::int c FROM audit_requests a WHERE a.created_at >= NOW() - INTERVAL '30 days' AND LOWER(a.email) NOT LIKE '%e2e%' AND a.email NOT LIKE '%@test.bodybank.fit' AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(a.email) AND u.role = 'user')`)
    };
    res.json({ audits: audits || [], part2: part2 || [], counts });
  } catch (e) {
    console.error('[operator leads]', e.message);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

// --- Compliance: is every client keeping up Daily check-in / Workout / Sunday check-in? ---
app.get('/api/operator/compliance', verifyToken, requireOperator, async (req, res) => {
  try {
    const rows = await queryAll(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.profile_picture, u.created_at,
        (SELECT COUNT(*)::int FROM daily_checkins dc WHERE dc.user_id = u.id AND dc.checkin_date = CURRENT_DATE AND COALESCE(dc.is_freeze,FALSE)=FALSE) AS daily_today,
        (SELECT COUNT(*)::int FROM daily_checkins dc WHERE dc.user_id = u.id AND dc.checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date AND COALESCE(dc.is_freeze,FALSE)=FALSE) AS daily_7d,
        (SELECT MAX(checkin_date)::text FROM daily_checkins dc WHERE dc.user_id = u.id AND COALESCE(dc.is_freeze,FALSE)=FALSE) AS last_daily,
        (SELECT COUNT(*)::int FROM workout_logs w WHERE w.user_id = u.id AND w.created_at >= NOW() - INTERVAL '7 days') AS workouts_7d,
        (SELECT MAX(created_at)::text FROM workout_logs w WHERE w.user_id = u.id) AS last_workout,
        (SELECT COUNT(*)::int FROM sunday_checkins s WHERE s.user_id = u.id AND s.created_at >= NOW() - INTERVAL '7 days') AS sunday_week,
        (SELECT MAX(created_at)::text FROM sunday_checkins s WHERE s.user_id = u.id) AS last_sunday
      FROM users u
      WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE
      ORDER BY LOWER(u.first_name), LOWER(u.last_name)`);
    const summary = { total: (rows || []).length, missed_daily_today: 0, no_workout_week: 0, missed_sunday: 0 };
    (rows || []).forEach(r => {
      if (!(r.daily_today > 0)) summary.missed_daily_today++;
      if (!(r.workouts_7d > 0)) summary.no_workout_week++;
      if (!(r.sunday_week > 0)) summary.missed_sunday++;
    });
    res.json({ clients: rows || [], summary });
  } catch (e) {
    console.error('[operator compliance]', e.message);
    res.status(500).json({ error: 'Failed to load compliance' });
  }
});

// --- Blood console: one row per client with their blood-report position ---
// Powers the operator's Blood workspace: who has reports, when the newest lab test
// was drawn, what is still processing and who has never sent one in. Read-only.
app.get('/api/operator/blood', verifyToken, requireOperator, async (req, res) => {
  try {
    const rows = await queryAll(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.profile_picture, u.created_at,
        COALESCE(b.reports, 0)::int   AS reports,
        COALESCE(b.pending, 0)::int   AS pending,
        b.latest_lab_date::text       AS latest_lab_date,
        b.latest_upload               AS latest_upload,
        latest.status                 AS latest_status,
        latest.overall_status         AS latest_overall,
        COALESCE(c.comparisons, 0)::int AS comparisons
      FROM users u
      LEFT JOIN (
        SELECT user_id,
               COUNT(*)                                             AS reports,
               COUNT(*) FILTER (WHERE COALESCE(status,'') <> 'complete') AS pending,
               MAX(COALESCE(report_date, created_at::date))         AS latest_lab_date,
               MAX(created_at)                                      AS latest_upload
          FROM blood_analysis_reports GROUP BY user_id
      ) b ON b.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT r.status, r.ai_report->>'overall_status' AS overall_status
          FROM blood_analysis_reports r
         WHERE r.user_id = u.id
         ORDER BY COALESCE(r.report_date, r.created_at::date) DESC, r.created_at DESC
         LIMIT 1
      ) latest ON TRUE
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS comparisons FROM blood_comparison_reports GROUP BY user_id
      ) c ON c.user_id = u.id
      WHERE ${OPERATOR_CLIENT_WHERE} AND COALESCE(u.suspended, FALSE) = FALSE
      ORDER BY b.latest_upload DESC NULLS LAST, LOWER(COALESCE(u.first_name, '')), LOWER(COALESCE(u.last_name, ''))`);

    const summary = { clients: (rows || []).length, reports: 0, pending: 0, none: 0, comparisons: 0 };
    (rows || []).forEach(r => {
      summary.reports += Number(r.reports || 0);
      summary.pending += Number(r.pending || 0);
      summary.comparisons += Number(r.comparisons || 0);
      if (!Number(r.reports || 0)) summary.none++;
    });
    res.json({ rows: rows || [], summary });
  } catch (e) {
    console.error('[operator blood]', e.message);
    res.status(500).json({ error: 'Failed to load blood reports' });
  }
});

// --- Muscle ranking for one client (read-only; reuses the muscle-ranking service) ---
app.get('/api/operator/clients/:id/muscle-ranking', verifyToken, requireOperator, async (req, res) => {
  try {
    const data = await muscleRankingSvc.computeMuscleRanking(String(req.params.id));
    res.json(data || {});
  } catch (e) {
    console.error('[operator muscle-ranking]', e.message);
    res.status(500).json({ error: 'Failed to load muscle ranking' });
  }
});

// --- Last-week performance for one client (read-only; reuses buildWeeklyReport) ---
app.get('/api/operator/clients/:id/weekly-report', verifyToken, requireOperator, async (req, res) => {
  try {
    const rep = await buildWeeklyReport(String(req.params.id));
    if (!rep) return res.status(404).json({ error: 'No weekly report available' });
    res.json(rep);
  } catch (e) {
    console.error('[operator weekly-report]', e.message);
    res.status(500).json({ error: 'Failed to load weekly report' });
  }
});

// Get-or-create the single message thread for a client (mirrors POST /api/threads logic).
async function getOrCreateThreadForUser(userId) {
  const existing = await queryOne('SELECT id, user_id FROM message_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [userId]);
  if (existing) return existing;
  const threadId = uuidv4();
  await run('INSERT INTO message_threads (id, user_id, subject) VALUES (?, ?, ?)', [threadId, userId, '']);
  return { id: threadId, user_id: userId };
}

// --- Operator sends a reminder message straight into the client's chat ---
// Inserted with sender_role='admin' so it appears as a normal "Lifestyle Manager"
// message in the client's existing Messages view (sender_id records the operator for audit).
app.post('/api/operator/clients/:id/reminder', verifyToken, requireOperator, rateLimiter(30, 60000), async (req, res) => {
  try {
    const clientId = String(req.params.id);
    const body = req.body && req.body.body;
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body required' });
    const client = await queryOne("SELECT id, email, first_name FROM users WHERE id = ? AND role = 'user'", [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const thread = await getOrCreateThreadForUser(clientId);
    const msgId = uuidv4();
    await run('INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
      [msgId, thread.id, req.user.id, 'admin', String(body).trim().slice(0, 5000)]);
    await run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [thread.id]);
    sendPushToUser(clientId, JSON.stringify({ type: 'coach_reply', title: '💬 Your Lifestyle Manager', body: String(body).trim().slice(0, 100), id: 'chat-' + msgId })).catch(() => {});
    try { if (client.email) userEmail.emailCoachReply(client.email, client.first_name, String(body).trim()); } catch (_) {}
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[operator reminder]', e.message);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// --- Operator shares a client with Admin for review (starts an escalation thread) ---
app.post('/api/operator/clients/:id/share-to-admin', verifyToken, requireOperator, rateLimiter(20, 60000), async (req, res) => {
  try {
    const clientId = String(req.params.id);
    const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
    if (!note) return res.status(400).json({ error: 'A note for the admin is required' });
    const client = await queryOne("SELECT id, first_name, last_name, email FROM users WHERE id = ? AND role = 'user'", [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const clientName = [(client.first_name || '').trim(), (client.last_name || '').trim()].filter(Boolean).join(' ') || client.email;
    const snap = await queryOne(`
      SELECT
        (CURRENT_DATE - COALESCE((SELECT MAX(checkin_date)::date FROM daily_checkins WHERE user_id = ? AND COALESCE(is_freeze,FALSE)=FALSE), CURRENT_DATE))::int AS inactive_days,
        (SELECT COUNT(*)::int FROM daily_checkins WHERE user_id = ? AND checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date AND COALESCE(is_freeze,FALSE)=FALSE) AS checkins_7d,
        (SELECT COUNT(*)::int FROM workout_logs WHERE user_id = ? AND created_at >= NOW() - INTERVAL '7 days') AS workouts_7d
    `, [clientId, clientId, clientId]);
    const summary = 'Inactive ' + ((snap && snap.inactive_days) || 0) + 'd · ' + ((snap && snap.checkins_7d) || 0) + ' check-ins/7d · ' + ((snap && snap.workouts_7d) || 0) + ' workouts/7d';
    const operatorName = req.user.email || 'Operator';
    const eid = uuidv4();
    await run('INSERT INTO operator_escalations (id, operator_id, operator_name, client_id, client_name, client_email, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [eid, req.user.id, operatorName, clientId, clientName, client.email || '', summary, 'open']);
    const mid = uuidv4();
    await run('INSERT INTO operator_escalation_messages (id, escalation_id, sender_id, sender_role, sender_name, body) VALUES (?, ?, ?, ?, ?, ?)',
      [mid, eid, req.user.id, 'operator', operatorName, note.slice(0, 5000)]);
    sendPushToAdmins(JSON.stringify({ title: '🔔 Operator escalation: ' + clientName, body: note.slice(0, 80), id: 'esc-' + eid })).catch(() => {});
    res.status(201).json({ ok: true, id: eid });
  } catch (e) {
    console.error('[operator share-to-admin]', e.message);
    res.status(500).json({ error: 'Failed to share with admin' });
  }
});

// --- Operator: list own escalations + read/reply within one ---
app.get('/api/operator/escalations', verifyToken, requireOperator, async (req, res) => {
  try {
    const rows = await queryAll(`
      SELECT e.*,
        (SELECT body FROM operator_escalation_messages m WHERE m.escalation_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_body,
        (SELECT sender_role FROM operator_escalation_messages m WHERE m.escalation_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_role,
        (SELECT COUNT(*)::int FROM operator_escalation_messages m WHERE m.escalation_id = e.id AND m.sender_role = 'admin') AS admin_replies
      FROM operator_escalations e WHERE e.operator_id = ? ORDER BY e.updated_at DESC LIMIT 100`, [req.user.id]);
    res.json({ rows: rows || [] });
  } catch (e) {
    console.error('[operator escalations]', e.message);
    res.status(500).json({ error: 'Failed to load escalations' });
  }
});
app.get('/api/operator/escalations/:eid/messages', verifyToken, requireOperator, async (req, res) => {
  try {
    const esc = await queryOne('SELECT * FROM operator_escalations WHERE id = ?', [req.params.eid]);
    if (!esc) return res.status(404).json({ error: 'Not found' });
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (esc.operator_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'Access denied' });
    const msgs = await queryAll('SELECT id, sender_role, sender_name, body, created_at FROM operator_escalation_messages WHERE escalation_id = ? ORDER BY created_at ASC', [req.params.eid]);
    res.json({ escalation: esc, messages: msgs || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load escalation' });
  }
});
app.post('/api/operator/escalations/:eid/reply', verifyToken, requireOperator, rateLimiter(30, 60000), async (req, res) => {
  try {
    const body = (req.body && req.body.body) ? String(req.body.body).trim() : '';
    if (!body) return res.status(400).json({ error: 'Message body required' });
    const esc = await queryOne('SELECT * FROM operator_escalations WHERE id = ?', [req.params.eid]);
    if (!esc) return res.status(404).json({ error: 'Not found' });
    if (esc.operator_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    const mid = uuidv4();
    await run('INSERT INTO operator_escalation_messages (id, escalation_id, sender_id, sender_role, sender_name, body) VALUES (?, ?, ?, ?, ?, ?)',
      [mid, req.params.eid, req.user.id, 'operator', esc.operator_name || req.user.email || 'Operator', body.slice(0, 5000)]);
    await run("UPDATE operator_escalations SET updated_at = CURRENT_TIMESTAMP, status = 'open' WHERE id = ?", [req.params.eid]);
    sendPushToAdmins(JSON.stringify({ title: 'Operator re: ' + (esc.client_name || 'client'), body: body.slice(0, 80), id: 'esc-' + req.params.eid + '-' + mid })).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reply' });
  }
});

// --- Admin: review escalations from operators and reply ---
app.get('/api/admin/escalations', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await queryAll(`
      SELECT e.*,
        (SELECT body FROM operator_escalation_messages m WHERE m.escalation_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_body,
        (SELECT sender_role FROM operator_escalation_messages m WHERE m.escalation_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_role,
        (SELECT COUNT(*)::int FROM operator_escalation_messages m WHERE m.escalation_id = e.id) AS msg_count
      FROM operator_escalations e ORDER BY e.updated_at DESC LIMIT 200`);
    res.json({ rows: rows || [] });
  } catch (e) {
    console.error('[admin escalations]', e.message);
    res.status(500).json({ error: 'Failed to load escalations' });
  }
});
app.get('/api/admin/escalations/:eid/messages', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const esc = await queryOne('SELECT * FROM operator_escalations WHERE id = ?', [req.params.eid]);
    if (!esc) return res.status(404).json({ error: 'Not found' });
    const msgs = await queryAll('SELECT id, sender_role, sender_name, body, created_at FROM operator_escalation_messages WHERE escalation_id = ? ORDER BY created_at ASC', [req.params.eid]);
    res.json({ escalation: esc, messages: msgs || [] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load escalation' });
  }
});
app.post('/api/admin/escalations/:eid/reply', verifyToken, requireAdminOrSuperadmin, rateLimiter(30, 60000), async (req, res) => {
  try {
    const body = (req.body && req.body.body) ? String(req.body.body).trim() : '';
    if (!body) return res.status(400).json({ error: 'Message body required' });
    const esc = await queryOne('SELECT * FROM operator_escalations WHERE id = ?', [req.params.eid]);
    if (!esc) return res.status(404).json({ error: 'Not found' });
    const mid = uuidv4();
    await run('INSERT INTO operator_escalation_messages (id, escalation_id, sender_id, sender_role, sender_name, body) VALUES (?, ?, ?, ?, ?, ?)',
      [mid, req.params.eid, req.user.id, 'admin', 'Admin', body.slice(0, 5000)]);
    await run("UPDATE operator_escalations SET updated_at = CURRENT_TIMESTAMP, status = 'replied' WHERE id = ?", [req.params.eid]);
    sendPushToUser(esc.operator_id, JSON.stringify({ type: 'admin_reply', title: '↩︎ Admin replied re: ' + (esc.client_name || 'client'), body: body.slice(0, 100), id: 'esc-' + req.params.eid + '-' + mid })).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[admin escalation reply]', e.message);
    res.status(500).json({ error: 'Failed to reply' });
  }
});

// ============ ADMIN: USERS LIST (for insights filter; exclude E2E test users) ============
app.get('/api/admin/users', verifyToken, requireOperator, async (req, res) => {
  try {
    await ensureApprovedUsersInActiveTribe();
    const list = await queryAll(
      `SELECT DISTINCT u.id, u.first_name, u.last_name, u.email, u.country, u.timezone, u.profile_picture,
              COALESCE(u.suspended, false) as suspended
       FROM users u
       INNER JOIN tribe_members tm ON LOWER(tm.email) = LOWER(u.email) AND COALESCE(tm.status, 'active') = 'active'
       WHERE u.role = 'user'
         AND (u.approval_status IS NULL OR u.approval_status = 'approved')
         AND COALESCE(u.suspended, FALSE) = FALSE
         AND (u.email NOT LIKE '%@test.bodybank.fit')
         AND (LOWER(u.first_name) NOT LIKE '%e2e%')
       ORDER BY u.first_name, u.last_name`
    );
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/coins/leaderboard', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
    const rows = await queryAll(
      `SELECT
         u.id AS user_id,
         u.first_name,
         u.last_name,
         u.email,
         u.profile_picture,
         COALESCE(cw.balance, 0)::int AS balance,
         COALESCE(cw.lifetime_earned, 0)::int AS lifetime_earned,
         COALESCE(cw.lifetime_redeemed, 0)::int AS lifetime_redeemed,
         cw.updated_at
       FROM users u
       LEFT JOIN coin_wallet cw ON cw.user_id = u.id
       WHERE u.role = 'user'
         AND (u.approval_status IS NULL OR u.approval_status = 'approved')
         AND COALESCE(u.suspended, FALSE) = FALSE
       ORDER BY COALESCE(cw.balance, 0) DESC, COALESCE(cw.lifetime_earned, 0) DESC, LOWER(u.email) ASC
       LIMIT ?`,
      [limit]
    );
    res.json({ rows: rows || [] });
  } catch (e) {
    console.error('[admin coins leaderboard]', e.message);
    res.status(500).json({ error: 'Failed to load coin leaderboard' });
  }
});

app.get('/api/admin/client-progress-audit', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    await ensureApprovedUsersInActiveTribe();
    const users = await queryAll(
      `SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
       FROM users u
       INNER JOIN tribe_members tm ON LOWER(tm.email) = LOWER(u.email) AND COALESCE(tm.status, 'active') = 'active'
       WHERE u.role = 'user'
         AND (u.approval_status IS NULL OR u.approval_status = 'approved')
         AND COALESCE(u.suspended, FALSE) = FALSE
         AND (u.email NOT LIKE '%@test.bodybank.fit')
         AND (LOWER(u.first_name) NOT LIKE '%e2e%')
       ORDER BY u.first_name, u.last_name`
    );

    function normalizeAuditWeight(value) {
      if (value == null || value === '') return null;
      const n = Number.parseFloat(String(value));
      if (!Number.isFinite(n)) return null;
      if (n < 25 || n > 400) return null;
      return n;
    }
    function parseSundayWeightCandidate(row) {
      const txt = String((row && (row.current_weight_waist_week || row.last_week_weight_waist)) || '');
      const kgMatches = [...txt.matchAll(/(\d+\.?\d*)\s*(?:kg|kgs)\b/ig)]
        .map((m) => normalizeAuditWeight(m[1]))
        .filter((v) => v != null);
      if (kgMatches.length) return kgMatches[kgMatches.length - 1];
      const m = txt.match(/(\d+\.?\d*)/);
      return m ? normalizeAuditWeight(m[1]) : null;
    }

    const audits = await Promise.all((users || []).map(async (u) => {
      const userId = u.id;
      const email = String(u.email || '').trim().toLowerCase();
      const displayName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || u.id;
      const [dailyCountRow, progressCountRow, sundayUserRows, sundayEmailRows, progress] = await Promise.all([
        queryOne('SELECT COUNT(*)::int AS c FROM daily_checkins WHERE user_id = ?', [userId]),
        queryOne('SELECT COUNT(*)::int AS c FROM progress_logs WHERE user_id = ?', [userId]),
        queryAll('SELECT current_weight_waist_week, last_week_weight_waist FROM sunday_checkins WHERE user_id = ?', [userId]),
        queryAll('SELECT current_weight_waist_week, last_week_weight_waist FROM sunday_checkins WHERE user_id IS NULL AND LOWER(COALESCE(reply_email, \'\')) = ?', [email]),
        progressService.getAdminUserProgress(userId).catch(() => null)
      ]);

      const sundayRowsMerged = [...(sundayUserRows || []), ...(sundayEmailRows || [])];
      const sundayHasWeightCandidate = sundayRowsMerged.some((r) => parseSundayWeightCandidate(r) != null);
      const dailyCount = Number(dailyCountRow && dailyCountRow.c) || 0;
      const progressLogCount = Number(progressCountRow && progressCountRow.c) || 0;
      const sundayByUserIdCount = Array.isArray(sundayUserRows) ? sundayUserRows.length : 0;
      const sundayByEmailFallbackCount = Array.isArray(sundayEmailRows) ? sundayEmailRows.length : 0;
      const totalSundayCount = sundayByUserIdCount + sundayByEmailFallbackCount;
      const activeStreak = progress && progress.activeStreak != null ? Number(progress.activeStreak) : 0;
      const currentWeight = progress && progress.currentWeight != null ? Number(progress.currentWeight) : null;
      const noDataAnywhere = (dailyCount + progressLogCount + totalSundayCount) === 0;
      const weightMissingButSundayPresent = currentWeight == null && sundayHasWeightCandidate;
      const streakZeroButDailyPresent = activeStreak === 0 && dailyCount > 0;
      const issues = [];
      if (weightMissingButSundayPresent) issues.push('weight_missing_from_sunday');
      if (streakZeroButDailyPresent) issues.push('streak_not_reflecting_daily_checkins');
      if (noDataAnywhere) issues.push('no_data_submitted');

      return {
        user_id: userId,
        name: displayName,
        email: u.email || '',
        daily_checkins_count: dailyCount,
        progress_logs_count: progressLogCount,
        sunday_checkins_user_id_count: sundayByUserIdCount,
        sunday_checkins_email_fallback_count: sundayByEmailFallbackCount,
        current_weight_kg: currentWeight,
        active_streak_days: activeStreak,
        issue_count: issues.length,
        issues
      };
    }));

    const issueRows = audits.filter((a) => a.issue_count > 0);
    res.json({
      generated_at: new Date().toISOString(),
      total_active_users: audits.length,
      users_with_issues: issueRows.length,
      issue_breakdown: {
        weight_missing_from_sunday: issueRows.filter((r) => r.issues.includes('weight_missing_from_sunday')).length,
        streak_not_reflecting_daily_checkins: issueRows.filter((r) => r.issues.includes('streak_not_reflecting_daily_checkins')).length,
        no_data_submitted: issueRows.filter((r) => r.issues.includes('no_data_submitted')).length
      },
      rows: audits
    });
  } catch (e) {
    console.error('[client-progress-audit]', e.message);
    res.status(500).json({ error: 'Failed to run client progress audit' });
  }
});

// Preview daily compliance report payload (no email send)
app.get('/api/admin/daily-compliance-preview', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const data = await getAdminDailyComplianceReportData({ queryAll });
    if (data && data.reason) return res.status(400).json(data);
    res.json({
      window_start_utc: data.startIso,
      window_end_utc: data.endIso,
      window_label_ist: data.windowLabel,
      summary: data.summary,
      rows: data.rows
    });
  } catch (e) {
    console.error('[daily-compliance-preview]', e.message);
    res.status(500).json({ error: 'Failed to build daily compliance preview' });
  }
});

// Manual admin trigger for daily compliance email report
app.post('/api/admin/daily-compliance-send', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const out = await sendAdminDailyComplianceReport({ queryAll, force: true });
    if (out && out.sent) {
      const data = await getAdminDailyComplianceReportData({ queryAll }).catch(() => null);
      if (data && data.summary) {
        const total = data.summary.totalUsers || 0;
        const yes   = data.summary.dailyYes   || 0;
        const miss  = data.summary.dailyMissed || 0;
        const rate  = total > 0 ? Math.round((yes / total) * 100) + '%' : '—';
        notifyAsync('DAILY_COMPLIANCE_SENT', { total, checkedIn: yes, missed: miss, rate });
      }
    }
    res.json(out);
  } catch (e) {
    console.error('[daily-compliance-send]', e.message);
    res.status(500).json({ error: 'Failed to send daily compliance report' });
  }
});

app.post('/api/admin/users/:id/suspend', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only suspend client users' });
    await run("UPDATE users SET suspended = TRUE WHERE id = ?", [id]);
    const suspUser = await queryOne("SELECT first_name, last_name, email, phone FROM users WHERE id = ?", [id]).catch(() => null);
    notifyAsync('USER_SUSPENDED', { name: suspUser ? `${suspUser.first_name || ''} ${suspUser.last_name || ''}`.trim() : id, email: suspUser ? suspUser.email : id, mobile: suspUser ? (suspUser.phone || '—') : '—' });
    notifyAgent('USER_SUSPENDED', { name: suspUser ? `${suspUser.first_name || ''} ${suspUser.last_name || ''}`.trim() : id, email: suspUser ? suspUser.email : id, mobile: suspUser ? (suspUser.phone || '—') : '—' });
    res.json({ message: 'User suspended' });
  } catch (e) {
    console.error('Suspend user error:', e.message);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
});

app.post('/api/admin/users/:id/reactivate', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only reactivate client users' });
    await run("UPDATE users SET suspended = FALSE WHERE id = ?", [id]);
    const reactUser = await queryOne("SELECT first_name, last_name, email, phone FROM users WHERE id = ?", [id]).catch(() => null);
    notifyAsync('USER_REACTIVATED', { name: reactUser ? `${reactUser.first_name || ''} ${reactUser.last_name || ''}`.trim() : id, email: reactUser ? reactUser.email : id, mobile: reactUser ? (reactUser.phone || '—') : '—' });
    notifyAgent('USER_REACTIVATED', { name: reactUser ? `${reactUser.first_name || ''} ${reactUser.last_name || ''}`.trim() : id, email: reactUser ? reactUser.email : id, mobile: reactUser ? (reactUser.phone || '—') : '—' });
    res.json({ message: 'User reactivated' });
  } catch (e) {
    console.error('Reactivate user error:', e.message);
    res.status(500).json({ error: 'Failed to reactivate user' });
  }
});

// ============ ACCESS CONTROL: Nutrition AI + AI Trainer per-user gating ============
app.get('/api/admin/users-access', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT id, email, first_name, last_name, suspended,
              COALESCE(nutrition_ai_unlimited, TRUE)  AS nutrition_ai_unlimited,
              COALESCE(nutrition_ai_meal_limit, 0)::int  AS nutrition_ai_meal_limit,
              COALESCE(nutrition_ai_meal_used, 0)::int   AS nutrition_ai_meal_used,
              COALESCE(ai_trainer_unlimited, TRUE)    AS ai_trainer_unlimited,
              COALESCE(ai_trainer_trial_limit, 0)::int   AS ai_trainer_trial_limit,
              COALESCE(ai_trainer_trial_used, 0)::int    AS ai_trainer_trial_used,
              nutrition_ai_last_used_at,
              ai_trainer_last_used_at
         FROM users
        WHERE role = 'user'
        ORDER BY COALESCE(first_name, '') ASC, COALESCE(last_name, '') ASC, email ASC`
    );
    res.json({ users: rows || [] });
  } catch (e) {
    console.error('[users-access list]', e.message);
    res.status(500).json({ error: 'Failed to load users access' });
  }
});

app.get('/api/admin/users/:id/access', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const row = await queryOne(
      `SELECT id, email, first_name, last_name,
              COALESCE(nutrition_ai_unlimited, TRUE)  AS nutrition_ai_unlimited,
              COALESCE(nutrition_ai_meal_limit, 0)::int  AS nutrition_ai_meal_limit,
              COALESCE(nutrition_ai_meal_used, 0)::int   AS nutrition_ai_meal_used,
              COALESCE(ai_trainer_unlimited, TRUE)    AS ai_trainer_unlimited,
              COALESCE(ai_trainer_trial_limit, 0)::int   AS ai_trainer_trial_limit,
              COALESCE(ai_trainer_trial_used, 0)::int    AS ai_trainer_trial_used,
              nutrition_ai_last_used_at,
              ai_trainer_last_used_at
         FROM users WHERE id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  } catch (e) {
    console.error('[users-access get]', e.message);
    res.status(500).json({ error: 'Failed to load user access' });
  }
});

app.put('/api/admin/users/:id/access', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only configure client users' });
    const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
    const nutUnlim = truthy(b.nutrition_ai_unlimited);
    const trnUnlim = truthy(b.ai_trainer_unlimited);
    const nutLimit = Math.max(0, parseInt(b.nutrition_ai_meal_limit, 10) || 0);
    const trnLimit = Math.max(0, parseInt(b.ai_trainer_trial_limit, 10) || 0);
    await run(
      `UPDATE users SET
         nutrition_ai_unlimited  = ?,
         nutrition_ai_meal_limit = ?,
         ai_trainer_unlimited    = ?,
         ai_trainer_trial_limit  = ?
       WHERE id = ?`,
      [nutUnlim, nutLimit, trnUnlim, trnLimit, id]
    );
    const fresh = await queryOne(
      `SELECT id,
              COALESCE(nutrition_ai_unlimited, TRUE)  AS nutrition_ai_unlimited,
              COALESCE(nutrition_ai_meal_limit, 0)::int  AS nutrition_ai_meal_limit,
              COALESCE(nutrition_ai_meal_used, 0)::int   AS nutrition_ai_meal_used,
              COALESCE(ai_trainer_unlimited, TRUE)    AS ai_trainer_unlimited,
              COALESCE(ai_trainer_trial_limit, 0)::int   AS ai_trainer_trial_limit,
              COALESCE(ai_trainer_trial_used, 0)::int    AS ai_trainer_trial_used,
              nutrition_ai_last_used_at,
              ai_trainer_last_used_at
         FROM users WHERE id = ?`,
      [id]
    );
    res.json({ message: 'Access updated', user: fresh });
  } catch (e) {
    console.error('[users-access update]', e.message);
    res.status(500).json({ error: 'Failed to update access' });
  }
});

app.post('/api/admin/users/:id/access/reset', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const feature = String((req.body || {}).feature || '').toLowerCase();
    if (!['nutrition', 'trainer', 'both'].includes(feature)) {
      return res.status(400).json({ error: 'feature must be "nutrition", "trainer", or "both"' });
    }
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (feature === 'nutrition' || feature === 'both') {
      await run("UPDATE users SET nutrition_ai_meal_used = 0 WHERE id = ?", [id]);
    }
    if (feature === 'trainer' || feature === 'both') {
      await run("UPDATE users SET ai_trainer_trial_used = 0 WHERE id = ?", [id]);
    }
    res.json({ message: 'Counter reset', feature });
  } catch (e) {
    console.error('[users-access reset]', e.message);
    res.status(500).json({ error: 'Failed to reset counter' });
  }
});

// ============ MEMBERSHIPS — trials, activations & renewals (manual billing) ============
// Quick-access hub: who's on trial, who's expiring, who to call, one-click activate.
function computeMembershipState(u) {
  const now = Date.now();
  const exp = u.access_expires_at ? new Date(u.access_expires_at).getTime() : null;
  const hasExp = exp != null && Number.isFinite(exp);
  const daysLeft = hasExp ? Math.ceil((exp - now) / 86400000) : null;
  let state = String(u.subscription_status || 'active').toLowerCase();
  if (state === 'canceled') { /* keep */ }
  else if (hasExp && exp < now) state = 'expired';
  return { days_left: daysLeft, state };
}

// ── AI TOKEN LEDGER (admin Tokens screen) ────────────────────────────────
// Admin-only by design: this exposes company spend, so requireAdminOrSuperadmin
// rather than the operator role that shares most other read-only dashboards.
app.get('/api/admin/ai-usage', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    // Clamped so a hand-edited query string can't ask for an unbounded scan.
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const today = streakTodayYmdInTz(AI_LEDGER_TZ) || new Date().toISOString().slice(0, 10);
    const since = streakAddDays(today, -(days - 1)) || today;

    // Rounded once, here, so the four views can never disagree by a paisa.
    const TOTALS = `COUNT(*)::int AS calls,
                    COALESCE(SUM(total_tokens), 0)::float8 AS tokens,
                    COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
                    COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
                    ROUND(COALESCE(SUM(cost_usd), 0), 4)::float8 AS usd,
                    ROUND(COALESCE(SUM(cost_inr), 0), 2)::float8 AS inr`;

    const [daily, scopes, models, rangeRow, todayRow, allTimeRow] = await Promise.all([
      queryAll(
        `SELECT usage_date::text AS date, ${TOTALS}
           FROM ai_usage_events WHERE usage_date >= ?::date
          GROUP BY usage_date ORDER BY usage_date DESC`,
        [since]
      ),
      queryAll(
        `SELECT scope, ${TOTALS}
           FROM ai_usage_events WHERE usage_date >= ?::date
          GROUP BY scope ORDER BY SUM(cost_usd) DESC`,
        [since]
      ),
      queryAll(
        `SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model, ${TOTALS}
           FROM ai_usage_events WHERE usage_date >= ?::date
          GROUP BY 1 ORDER BY SUM(cost_usd) DESC`,
        [since]
      ),
      queryOne(`SELECT ${TOTALS} FROM ai_usage_events WHERE usage_date >= ?::date`, [since]),
      queryOne(`SELECT ${TOTALS} FROM ai_usage_events WHERE usage_date = ?::date`, [today]),
      queryOne(`SELECT ${TOTALS} FROM ai_usage_events`)
    ]);

    const zero = { calls: 0, tokens: 0, input_tokens: 0, output_tokens: 0, usd: 0, inr: 0 };
    res.json({
      success: true,
      days,
      since,
      today,
      timezone: AI_LEDGER_TZ,
      usdToInr: usdToInrRate(),
      scopeLabels: AI_SCOPE_LABELS,
      totals: {
        today: todayRow || zero,
        range: rangeRow || zero,
        allTime: allTimeRow || zero
      },
      daily: daily || [],
      scopes: scopes || [],
      models: models || []
    });
  } catch (e) {
    console.error('[admin ai-usage]', e.message);
    res.status(500).json({ success: false, error: 'Failed to load AI usage' });
  }
});

app.get('/api/admin/memberships', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT id, email, first_name, last_name, phone, country,
              COALESCE(subscription_status, 'active') AS subscription_status,
              access_expires_at, plan_label, activated_at, activated_by, created_at, suspended,
              COALESCE(nutrition_ai_unlimited, TRUE) AS nutrition_ai_unlimited,
              COALESCE(nutrition_ai_meal_limit, 0) AS nutrition_ai_meal_limit,
              COALESCE(nutrition_ai_meal_used, 0) AS nutrition_ai_meal_used,
              nutrition_ai_last_used_at,
              COALESCE(ai_trainer_unlimited, TRUE) AS ai_trainer_unlimited,
              COALESCE(ai_trainer_trial_limit, 0) AS ai_trainer_trial_limit,
              COALESCE(ai_trainer_trial_used, 0) AS ai_trainer_trial_used,
              ai_trainer_last_used_at
         FROM users
        WHERE role = 'user'
        ORDER BY created_at DESC`
    );
    const users = (rows || []).map((u) => Object.assign({}, u, computeMembershipState(u)));
    // Sort: most urgent first — expiring trials/active, then expired, then healthy, then lifetime.
    const rank = (u) => {
      if ((u.state === 'trialing' || u.state === 'active') && u.days_left != null && u.days_left <= 2) return 0;
      if (u.state === 'expired') return 1;
      if (u.state === 'canceled') return 2;
      if (u.state === 'trialing') return 3;
      if (u.state === 'active') return 4;
      return 5;
    };
    users.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      const da = a.days_left == null ? 1e9 : a.days_left;
      const db = b.days_left == null ? 1e9 : b.days_left;
      return da - db;
    });
    const summary = {
      trialing: users.filter((u) => u.state === 'trialing').length,
      active:   users.filter((u) => u.state === 'active').length,
      expiring: users.filter((u) => (u.state === 'trialing' || u.state === 'active') && u.days_left != null && u.days_left <= 2).length,
      expired:  users.filter((u) => u.state === 'expired').length,
      canceled: users.filter((u) => u.state === 'canceled').length,
      total:    users.length
    };
    res.json({ users, summary, trial_days: TRIAL_DAYS });
  } catch (e) {
    console.error('[memberships list]', e.message);
    res.status(500).json({ error: 'Failed to load memberships' });
  }
});

// Activate a paid membership after collecting payment offline.
// body: { months } (1/3/12...) or { days } or { term:'lifetime' }; optional { plan_label }.
app.post('/api/admin/users/:id/activate', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const user = await queryOne("SELECT id, role, email, first_name, last_name, phone FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only activate client users' });

    const months = parseInt(b.months, 10);
    const rawDays = parseInt(b.days, 10);
    const term = String(b.term || '').toLowerCase();
    let expires, label;
    if (term === 'lifetime' || b.lifetime === true) {
      expires = null; label = 'Lifetime';
    } else if (Number.isFinite(months) && months > 0) {
      expires = isoMonthsFromNow(months); label = months + (months === 1 ? ' Month' : ' Months');
    } else if (Number.isFinite(rawDays) && rawDays > 0) {
      expires = isoFromNow(rawDays); label = rawDays + ' Days';
    } else {
      expires = isoMonthsFromNow(1); label = '1 Month';
    }
    if (b.plan_label) label = String(b.plan_label).slice(0, 40);
    const actor = (req.user && (req.user.email || req.user.id)) || 'admin';

    await run(
      "UPDATE users SET subscription_status='active', approval_status='approved', suspended=FALSE, plan_label=?, access_expires_at=?, activated_at=?, activated_by=?, trial_reminder_sent='' WHERE id=?",
      [label, expires, isoFromNow(0), actor, id]
    );
    sendPushToUser(id, JSON.stringify({ title: '✅ Membership active', body: `Your ${label} plan is live — let's get to work!`, id: 'membership-' + id })).catch(() => {});
    try { if (user.email) userEmail.emailAccountApproved(user.email, user.first_name); } catch (_) {}
    notifyAsync('USER_MEMBERSHIP_ACTIVATED', { name: `${user.first_name || ''} ${user.last_name || ''}`.trim(), email: user.email, mobile: user.phone || '—', plan: label });
    const fresh = await queryOne("SELECT id, email, first_name, last_name, phone, subscription_status, access_expires_at, plan_label, activated_at, activated_by, suspended FROM users WHERE id = ?", [id]);
    res.json({ message: 'Membership activated', plan_label: label, expires_at: expires, user: Object.assign({}, fresh, computeMembershipState(fresh)) });
  } catch (e) {
    console.error('[membership activate]', e.message);
    res.status(500).json({ error: 'Failed to activate membership' });
  }
});

// Start or extend a free trial. body: { days } (defaults to TRIAL_DAYS).
app.post('/api/admin/users/:id/trial', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const days = parseInt((req.body || {}).days, 10);
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only configure client users' });
    const d = await startTrialForUser(id, (Number.isFinite(days) && days > 0) ? days : TRIAL_DAYS);
    const fresh = await queryOne("SELECT id, email, first_name, last_name, phone, subscription_status, access_expires_at, plan_label, activated_at, activated_by, suspended FROM users WHERE id = ?", [id]);
    res.json({ message: `Trial set to ${d} days`, user: Object.assign({}, fresh, computeMembershipState(fresh)) });
  } catch (e) {
    console.error('[membership trial]', e.message);
    res.status(500).json({ error: 'Failed to set trial' });
  }
});

// Lock access immediately (membership paused / lapsed).
app.post('/api/admin/users/:id/membership-lock', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only configure client users' });
    await run("UPDATE users SET subscription_status='canceled', access_expires_at=? WHERE id=?", [isoFromNow(0), id]);
    const fresh = await queryOne("SELECT id, email, first_name, last_name, phone, subscription_status, access_expires_at, plan_label, activated_at, activated_by, suspended FROM users WHERE id = ?", [id]);
    res.json({ message: 'Access locked', user: Object.assign({}, fresh, computeMembershipState(fresh)) });
  } catch (e) {
    console.error('[membership lock]', e.message);
    res.status(500).json({ error: 'Failed to lock access' });
  }
});

// Phase 2 — nightly lifecycle: expire lapsed members, remind those expiring soon,
// and push a "call queue" digest to admins. Also runnable on demand (endpoint below).
async function runMembershipLifecycleJob() {
  const nowIso = new Date().toISOString();

  // Void referrals whose qualification window lapsed without the referee hitting
  // the check-in bar. Deliberately runs first so the call-queue digest below
  // reflects an already-settled referral state.
  try {
    const voided = await referralService.voidExpiredReferrals({ run, queryOne, queryAll });
    if (voided && voided.voided) console.log(`[referrals] voided ${voided.voided} expired referral(s)`);
  } catch (e) {
    console.warn('[referrals void sweep]', e.message);
  }

  const expiredRows = await queryAll(
    "SELECT id, email, first_name, last_name, phone FROM users WHERE role='user' AND subscription_status IN ('trialing','active') AND access_expires_at IS NOT NULL AND access_expires_at < ?",
    [nowIso]
  ).catch(() => []);
  for (const u of (expiredRows || [])) {
    await run("UPDATE users SET subscription_status='expired' WHERE id=?", [u.id]).catch(() => {});
    sendPushToUser(u.id, JSON.stringify({ title: '⏳ Access ended', body: 'Your access has ended. Message your coach to renew and pick up where you left off.', id: 'exp-' + u.id })).catch(() => {});
  }
  const soon = await queryAll(
    "SELECT id, email, first_name, last_name, phone, subscription_status, access_expires_at, COALESCE(trial_reminder_sent,'') AS trial_reminder_sent FROM users WHERE role='user' AND subscription_status IN ('trialing','active') AND access_expires_at IS NOT NULL AND access_expires_at >= ?",
    [nowIso]
  ).catch(() => []);
  for (const u of (soon || [])) {
    const dl = daysLeftUntil(u.access_expires_at);
    if (dl == null) continue;
    let stage = '';
    if (dl <= 0) stage = 'd0';
    else if (dl <= 2) stage = 'd2';
    if (!stage || u.trial_reminder_sent === stage) continue;
    const word = dl <= 0 ? 'today' : (dl === 1 ? 'in 1 day' : 'in ' + dl + ' days');
    const kind = u.subscription_status === 'trialing' ? 'Trial' : 'Plan';
    sendPushToUser(u.id, JSON.stringify({ title: `⏳ ${kind} ends ${word}`, body: 'Secure your spot — message your coach to continue without losing your streak.', id: 'rem-' + u.id })).catch(() => {});
    await run("UPDATE users SET trial_reminder_sent=? WHERE id=?", [stage, u.id]).catch(() => {});
  }
  const callList = (soon || []).filter((u) => { const dl = daysLeftUntil(u.access_expires_at); return dl != null && dl <= 2; });
  const justExpired = expiredRows || [];
  if (callList.length || justExpired.length) {
    const lines = [];
    callList.slice(0, 20).forEach((u) => { const dl = daysLeftUntil(u.access_expires_at); lines.push(`• ${(u.first_name || '')} ${(u.last_name || '')} (${u.phone || 'no phone'}) — ${dl <= 0 ? 'expires today' : dl + 'd left'}`); });
    justExpired.slice(0, 20).forEach((u) => { lines.push(`• ${(u.first_name || '')} ${(u.last_name || '')} (${u.phone || 'no phone'}) — just expired`); });
    sendPushToAdmins(JSON.stringify({ title: '☎️ Memberships: call queue', body: `${callList.length} expiring soon · ${justExpired.length} expired`, id: 'mem-digest' })).catch(() => {});
    // Twilio WhatsApp to admin via the reliable notify path (template fallback for the 24h window).
    notifyAsync('MEMBERSHIP_DIGEST', { expiring_count: callList.length, expired_count: justExpired.length, lines });
  }
  return { expired: (expiredRows || []).length, expiring_soon: callList.length, scanned: (soon || []).length };
}

// Manual trigger (useful for local testing / "run now" button).
app.post('/api/admin/memberships/run-lifecycle', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const result = await runMembershipLifecycleJob();
    res.json(Object.assign({ message: 'Lifecycle job ran' }, result));
  } catch (e) {
    console.error('[membership lifecycle manual]', e.message);
    res.status(500).json({ error: 'Failed to run lifecycle job' });
  }
});

app.delete('/api/admin/users/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (NODE_ENV !== 'production') console.log('[DELETE /api/admin/users/:id] id=', id);
    const user = await queryOne("SELECT id, role, email, phone FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Can only remove client users' });
    const threads = await queryAll('SELECT id FROM message_threads WHERE user_id = ?', [id]);
    const threadIds = (threads || []).map(t => t.id).filter(Boolean);
    if (threadIds.length > 0) {
      for (const tid of threadIds) {
        await run('DELETE FROM thread_messages WHERE thread_id = ?', [tid]);
      }
    }
    await run('DELETE FROM message_threads WHERE user_id = ?', [id]);
    await run('DELETE FROM workout_logs WHERE user_id = ?', [id]);
    await run('DELETE FROM contact_messages WHERE user_id = ?', [id]);
    await run('DELETE FROM meetings WHERE user_id = ?', [id]);
    await run('DELETE FROM sunday_checkins WHERE user_id = ?', [id]);
    await run('DELETE FROM hydration_logs WHERE user_id = ?', [id]);
    await run('DELETE FROM weight_logs WHERE user_id = ?', [id]);
    await run('DELETE FROM daily_checkins WHERE user_id = ?', [id]);
    await run('DELETE FROM push_subscriptions WHERE user_id = ?', [id]);
    await waInbound.unlinkClient(id);
    if (user.email) {
      await run('DELETE FROM tribe_members WHERE LOWER(email) = LOWER(?)', [user.email]);
    }
    await run('DELETE FROM users WHERE id = ?', [id]);
    notifyAsync('USER_DELETED', { name: id, email: user.email, mobile: user.phone || '—' });
    notifyAgent('USER_DELETED', { name: id, email: user.email, mobile: user.phone || '—' });
    res.json({ message: 'User removed' });
  } catch (e) {
    console.error('Delete user error:', e.message);
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// User self-delete (required by Apple Guideline 5.1.1(v) for any app with sign-in).
// Requires the user's password to confirm. Mirrors the admin cascade above.
app.post('/api/me/account/delete', verifyToken, rateLimiter(3, 60000), async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account.' });
    const id = req.user.id;
    const user = await queryOne("SELECT id, role, email, phone, password FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.role !== 'user') return res.status(403).json({ error: 'This account type cannot be deleted in-app. Please contact support.' });
    if (!user.password || !await bcrypt.compare(String(password), user.password)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    const threads = await queryAll('SELECT id FROM message_threads WHERE user_id = ?', [id]);
    const threadIds = (threads || []).map(t => t.id).filter(Boolean);
    for (const tid of threadIds) { await run('DELETE FROM thread_messages WHERE thread_id = ?', [tid]); }
    await run('DELETE FROM message_threads WHERE user_id = ?', [id]);
    await run('DELETE FROM workout_logs WHERE user_id = ?', [id]);
    await run('DELETE FROM contact_messages WHERE user_id = ?', [id]);
    await run('DELETE FROM meetings WHERE user_id = ?', [id]);
    await run('DELETE FROM sunday_checkins WHERE user_id = ?', [id]);
    await run('DELETE FROM hydration_logs WHERE user_id = ?', [id]);
    await run('DELETE FROM weight_logs WHERE user_id = ?', [id]);
    await run('DELETE FROM daily_checkins WHERE user_id = ?', [id]);
    await run('DELETE FROM push_subscriptions WHERE user_id = ?', [id]);
    await waInbound.unlinkClient(id);
    if (user.email) await run('DELETE FROM tribe_members WHERE LOWER(email) = LOWER(?)', [user.email]);
    await run('DELETE FROM users WHERE id = ?', [id]);
    notifyAsync('USER_DELETED', { name: 'self-deleted', email: user.email, mobile: user.phone || '—' });
    notifyAgent('USER_DELETED', { name: 'self-deleted', email: user.email, mobile: user.phone || '—' });
    res.json({ message: 'Your account has been deleted.' });
  } catch (e) {
    console.error('Self-delete error:', e.message);
    res.status(500).json({ error: 'Failed to delete account. Please try again.' });
  }
});

// ============ ADMIN: PERFORMANCE INSIGHTS ============
app.get('/api/admin/performance-insights', verifyToken, requireOperator, async (req, res) => {
  try {
    const { source = 'all', from: dateFrom, to: dateTo, user_id: filterUserId } = req.query || {};
    const hasDate = dateFrom || dateTo;
    const dateParams = [dateFrom, dateTo].filter(Boolean);

    const summary = {};
    const tables = [
      { key: 'workouts', table: 'workout_logs', countSql: 'SELECT COUNT(*) as c FROM workout_logs w', dateCol: 'w.created_at', userCol: 'w.user_id' },
      { key: 'sunday_checkin', table: 'sunday_checkins', countSql: 'SELECT COUNT(*) as c FROM sunday_checkins', dateCol: 'created_at', userCol: 'user_id' },
      { key: 'audit', table: 'audit_requests', countSql: 'SELECT COUNT(*) as c FROM audit_requests', dateCol: 'created_at', userCol: null },
      { key: 'part2', table: 'part2_audit', countSql: 'SELECT COUNT(*) as c FROM part2_audit', dateCol: 'created_at', userCol: null },
      { key: 'meetings', table: 'meetings', countSql: "SELECT COUNT(*) as c FROM meetings WHERE status='scheduled'", dateCol: 'created_at', userCol: 'user_id' },
      { key: 'messages', table: 'contact_messages', countSql: 'SELECT COUNT(*) as c FROM contact_messages', dateCol: 'created_at', userCol: 'user_id' }
    ];
    const usersApproved = await queryOne("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'approved')");
    summary.users_approved = usersApproved?.c ?? 0;
    const [pendingAudit] = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'");
    summary.pending_requests = pendingAudit?.c ?? 0;
    const [dailyCheckins] = await queryAll("SELECT COUNT(*) as c FROM daily_checkins");
    summary.daily_checkins = dailyCheckins?.c ?? 0;

    for (const { key, countSql, dateCol, userCol } of tables) {
      let sql = countSql;
      const params = [];
      const conditions = [];
      if (hasDate && dateCol) {
        if (dateFrom) conditions.push(`date(${dateCol}) >= date(?)`);
        if (dateTo) conditions.push(`date(${dateCol}) <= date(?)`);
        params.push(...dateParams);
      }
      if (filterUserId && userCol) {
        conditions.push(`${userCol} = ?`);
        params.push(filterUserId);
      }
      if (conditions.length) sql += (countSql.toLowerCase().includes(' where ') ? ' AND ' : ' WHERE ') + conditions.join(' AND ');
      const row = await queryOne(sql, params);
      summary[key] = row?.c ?? 0;
    }

    let data = [];
    const pickSource = source.toLowerCase();

    async function runQuery(sql, params = []) {
      return queryAll(sql, params);
    }

    if (pickSource === 'all' || pickSource === 'overview') {
      const limit = 80;
      const w = (await runQuery(`SELECT w.id, w.user_id, w.workout_name, w.duration_seconds, w.created_at, u.first_name, u.last_name FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 200`)).map(r => ({ ...r, _source: 'workouts', _date: r.created_at }));
      const sc = (await runQuery('SELECT id, user_id, full_name, reply_email, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'sunday_checkin', _date: r.created_at }));
      const ar = (await runQuery('SELECT id, first_name, last_name, email, created_at FROM audit_requests ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'audit', _date: r.created_at }));
      const p2 = (await runQuery('SELECT id, name, email, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'part2', _date: r.created_at }));
      const meet = (await runQuery("SELECT id, user_id, user_name, user_email, meeting_date, time_slot, created_at FROM meetings ORDER BY created_at DESC LIMIT 200")).map(r => ({ ...r, _source: 'meetings', _date: r.created_at }));
      const msg = (await runQuery('SELECT id, user_id, name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'messages', _date: r.created_at }));
      data = [...w, ...sc, ...ar, ...p2, ...meet, ...msg];
      if (hasDate) data = data.filter(r => { const d = (r._date || r.created_at || '').toString().slice(0, 10); return (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo); });
      if (filterUserId) data = data.filter(r => r.user_id === filterUserId);
      data.sort((a, b) => new Date(b._date || b.created_at) - new Date(a._date || a.created_at));
      data = data.slice(0, limit);
    } else {
      const limit = 500;
      let sql, params = [];
      const uidCol = { workouts: 'w.user_id', sunday_checkin: 'user_id', meetings: 'user_id' }[pickSource];
      if (pickSource === 'workouts') {
        sql = `SELECT w.id, w.user_id, w.workout_name, w.duration_seconds, w.feedback, w.created_at, u.first_name, u.last_name, u.email FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(w.created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(w.created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('w.user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY w.created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'sunday_checkin') {
        sql = `SELECT id, user_id, full_name, reply_email, plan, total_weight_loss, created_at FROM sunday_checkins`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'audit') {
        sql = `SELECT id, first_name, last_name, email, city, goals, status, created_at FROM audit_requests`;
        if (hasDate) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'part2') {
        sql = `SELECT id, name, email, mobile, activity_level, created_at FROM part2_audit`;
        if (hasDate) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'meetings') {
        sql = `SELECT id, user_id, user_name, user_email, user_phone, meeting_date, time_slot, status, created_at FROM meetings`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'messages') {
        sql = `SELECT id, user_id, name, email, phone, message, created_at FROM contact_messages`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      }
    }

    const stats = { ...summary, sunday_checkins: summary.sunday_checkin };
    res.json({ summary, stats, data, filters: { source: pickSource, dateFrom: dateFrom || null, dateTo: dateTo || null, user_id: filterUserId || null } });
  } catch (e) {
    console.error('Performance insights error:', e.message);
    res.status(500).json({ error: e.message, summary: {}, data: [] });
  }
});

// ============ ADMIN: VIEW DATABASE ============
app.get('/api/admin/db-view', verifyToken, requireSuperadmin, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const tables = ['users', 'audit_requests', 'tribe_members', 'workout_logs', 'contact_messages', 'meetings', 'part2_audit', 'hydration_logs', 'weight_logs', 'sunday_checkins'];
    // Columns that must never leave the database, even for a superadmin. Password
    // hashes are offline-crackable and reset tokens are bearer credentials; neither
    // has any legitimate use in a data browser.
    const REDACTED_COLUMNS = new Set(['password', 'password_hash', 'reset_token', 'token']);
    const redactRow = (row) => {
      if (!row || typeof row !== 'object') return row;
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = REDACTED_COLUMNS.has(String(k).toLowerCase()) && v ? '[REDACTED]' : v;
      }
      return out;
    };

    const result = {};

    for (const table of tables) {
      try {
        const rows = await queryAll(`SELECT * FROM ${table}`);
        result[table] = Array.isArray(rows) ? rows.map(redactRow) : rows;
      } catch (e) {
        result[table] = { error: e.message };
      }
    }

    res.json({
      db: 'postgresql',
      tables: result,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('DB view error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ ADMIN: AI ASSIST (context from DB, optional OpenAI) ============
function num(v) { return (v === undefined || v === null ? 0 : parseInt(String(v), 10) || 0); }

async function getAdminAIContext() {
  const lines = [];
  const now = new Date().toISOString();
  lines.push('LIVE DATA — BodyBank database. Fetched just now (' + now + '). Use this to answer the admin.\n');

  try {
    const [pendingReq] = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'");
    const [approvedReq] = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='approved'");
    const [rejectedReq] = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='rejected'");
    const [auditTotal] = await queryAll("SELECT COUNT(*) as c FROM audit_requests");
    const [tribeTotal] = await queryAll("SELECT COUNT(*) as c FROM tribe_members");
    const [tribeActive] = await queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='active'");
    const [tribeCompleted] = await queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='completed'");
    const [workouts] = await queryAll("SELECT COUNT(*) as c FROM workout_logs");
    const [messages] = await queryAll("SELECT COUNT(*) as c FROM contact_messages");
    const [meetings] = await queryAll("SELECT COUNT(*) as c FROM meetings");
    const [meetingsScheduled] = await queryAll("SELECT COUNT(*) as c FROM meetings WHERE status='scheduled'");
    const [part2] = await queryAll("SELECT COUNT(*) as c FROM part2_audit");
    const [sundayCheck] = await queryAll("SELECT COUNT(*) as c FROM sunday_checkins");
    const [signups] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND subscription_status='trialing' AND COALESCE(suspended, FALSE) = FALSE");
    const [approvedUsers] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status = 'approved' OR approval_status IS NULL)");

    const p = num(pendingReq?.c), a = num(approvedReq?.c), r = num(rejectedReq?.c), totAudit = num(auditTotal?.c);
    const totTribe = num(tribeTotal?.c), act = num(tribeActive?.c), comp = num(tribeCompleted?.c);
    const w = num(workouts?.c), msg = num(messages?.c), meet = num(meetings?.c), sched = num(meetingsScheduled?.c);
    const p2 = num(part2?.c), sc = num(sundayCheck?.c), pendSign = num(signups?.c), appUsers = num(approvedUsers?.c);

    lines.push('--- COUNTS (use these for "how many" questions) ---');
    lines.push('Audit forms: ' + totAudit + ' total. Pending: ' + p + ', Approved: ' + a + ', Rejected: ' + r + '.');
    if (totAudit === 0) lines.push('(No audit form submissions in the database yet.)');
    lines.push('Tribe members: ' + totTribe + ' total. Active: ' + act + ', Completed: ' + comp + '.');
    if (totTribe === 0) lines.push('(No tribe members yet.)');
    lines.push('Workout logs: ' + w + '.');
    if (w === 0) lines.push('(No workout logs yet.)');
    lines.push('Contact messages: ' + msg + '.');
    if (msg === 0) lines.push('(No contact messages yet.)');
    lines.push('Meetings: ' + meet + ' total, ' + sched + ' scheduled.');
    if (meet === 0) lines.push('(No meetings yet.)');
    lines.push('Part-2 form submissions: ' + p2 + '.');
    if (p2 === 0) lines.push('(No Part-2 submissions yet.)');
    lines.push('Sunday check-ins: ' + sc + '.');
    if (sc === 0) lines.push('(No Sunday check-ins yet.)');
    lines.push('Members on a trial: ' + pendSign + '.');
    lines.push('Approved users (can log in): ' + appUsers + '.');
    const [dailyCheckCount] = await queryAll("SELECT COUNT(*) as c FROM daily_checkins");
    const dcCount = num(dailyCheckCount?.c);
    lines.push('Daily check-ins (steps, water, protein, sleep): ' + dcCount + '.');

    const recentAudit = await queryAll("SELECT first_name, last_name, email, city, goals, status, created_at FROM audit_requests ORDER BY created_at DESC LIMIT 20");
    lines.push('\n--- RECENT AUDIT REQUESTS (latest first) ---');
    if (recentAudit && recentAudit.length > 0) {
      recentAudit.forEach(r => {
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${r.email || ''} | ${r.city || ''} | status: ${r.status || 'pending'} | ${(r.goals || '').slice(0, 50)} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const recentTribe = await queryAll("SELECT first_name, last_name, email, city, phase, start_date, activity_per_week, status FROM tribe_members ORDER BY start_date DESC LIMIT 20");
    lines.push('\n--- TRIBE MEMBERS ---');
    if (recentTribe && recentTribe.length > 0) {
      recentTribe.forEach(r => {
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${r.email || ''} | ${r.city || ''} | Phase ${r.phase} | ${r.activity_per_week}x/week | ${r.status || 'active'} | start ${r.start_date || ''}`);
      });
    } else lines.push('  (None.)');

    const recentWorkouts = await queryAll(`SELECT w.workout_name, w.workout_type, w.session_date, w.duration_seconds, w.workout_completed,
      w.bench_kg, w.squat_kg, w.deadlift_kg, w.intensity, w.energy_level, w.feedback, w.created_at, u.first_name, u.last_name
      FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 15`);
    lines.push('\n--- RECENT MY WORKOUT SESSIONS ---');
    if (recentWorkouts && recentWorkouts.length > 0) {
      recentWorkouts.forEach(r => {
        const day = r.session_date ? String(r.session_date).slice(0, 10) : '';
        const typ = (r.workout_type || r.workout_name || '').trim();
        const lifts = [r.bench_kg, r.squat_kg, r.deadlift_kg].some(x => x != null && x !== '') ? ` B/S/DL:${r.bench_kg ?? '—'}/${r.squat_kg ?? '—'}/${r.deadlift_kg ?? '—'}` : '';
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${day || '—'} | ${typ} | ${r.duration_seconds || 0}s | done:${r.workout_completed ? 'yes' : 'no'}${lifts} | ${(r.feedback || '').slice(0, 36)} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const recentMessages = await queryAll("SELECT name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 12");
    lines.push('\n--- RECENT CONTACT MESSAGES ---');
    if (recentMessages && recentMessages.length > 0) {
      recentMessages.forEach(r => {
        const msgSnippet = (r.message || '').replace(/\s+/g, ' ').slice(0, 80);
        lines.push(`  ${r.name || ''} (${r.email || ''}): "${msgSnippet}" | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const recentMeetings = await queryAll("SELECT user_name, user_email, meeting_date, time_slot, status, created_at FROM meetings ORDER BY created_at DESC LIMIT 10");
    lines.push('\n--- MEETINGS ---');
    if (recentMeetings && recentMeetings.length > 0) {
      recentMeetings.forEach(r => {
        lines.push(`  ${r.user_name || ''} | ${r.user_email || ''} | ${r.meeting_date || ''} ${r.time_slot || ''} | ${r.status || ''} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const recentPart2 = await queryAll("SELECT name, email, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 10");
    lines.push('\n--- PART-2 SUBMISSIONS ---');
    if (recentPart2 && recentPart2.length > 0) {
      recentPart2.forEach(r => {
        lines.push(`  ${r.name || ''} | ${r.email || ''} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const recentCheckins = await queryAll("SELECT full_name, reply_email, total_weight_loss, achievements, improve_next_week, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT 10");
    lines.push('\n--- SUNDAY CHECK-INS ---');
    if (recentCheckins && recentCheckins.length > 0) {
      recentCheckins.forEach(r => {
        lines.push(`  ${r.full_name || ''} | ${r.reply_email || ''} | weight: ${r.total_weight_loss || '-'} | ${(r.achievements || '').slice(0, 40)} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const recentDailyCheckins = await queryAll("SELECT dc.checkin_date, dc.steps, dc.water_ml, dc.protein_g, dc.sleep_hours, dc.created_at, u.first_name, u.last_name, u.email FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id WHERE COALESCE(dc.is_freeze, FALSE) = FALSE ORDER BY dc.checkin_date DESC, dc.created_at DESC LIMIT 15");
    lines.push('\n--- DAILY CHECK-INS (steps, water, protein, sleep) ---');
    if (recentDailyCheckins && recentDailyCheckins.length > 0) {
      recentDailyCheckins.forEach(r => {
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${r.checkin_date || ''} | steps: ${r.steps ?? '-'} | water: ${r.water_ml != null ? (Number(r.water_ml) / 1000).toFixed(2) + ' L' : '-'} | protein: ${r.protein_g ?? '-'} g | sleep: ${r.sleep_hours ?? '-'} hrs | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const trialMemberList = await queryAll("SELECT first_name, last_name, email, created_at FROM users WHERE role='user' AND subscription_status='trialing' ORDER BY created_at DESC LIMIT 10");
    lines.push('\n--- TRIAL MEMBERS (call to convert) ---');
    if (trialMemberList && trialMemberList.length > 0) {
      trialMemberList.forEach(r => {
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${r.email || ''} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');
  } catch (e) {
    lines.push('\n(Data fetch issue: ' + e.message + '. Still answer politely from the counts above if any.)');
  }
  lines.push('\n--- ADMIN ACTIONS (suggest these when relevant) ---');
  lines.push('The admin can: Approve or reject audit forms (Audit forms tab); Track and convert leads (Leads pipeline tab); Manage trials, activations, renewals and AI access in one place (Members tab); View and manage Tribe, Workouts, Messages & Meetings, Part-2 Form, Sunday Check-in; View Client Progress and share a progress report link with a client; Use Performance Insights for filters and CSV export. New sign-ups get instant trial access automatically — there is no approval queue. When data suggests follow-up (e.g. trial members to call, new messages, inactive users), suggest 1–3 concrete actions the admin can take in the dashboard.');

  return lines.join('\n');
}

// Admin AI Assist system prompt + formatting: services/bodybankAiCoachContext.js

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Cost for one AI call. Rates come from services/aiUsageLedger.js so the figure
 * shown next to an AI Assist reply always matches the Tokens ledger — this used
 * to hardcode Sonnet's rate for every model, which quietly mispriced any run on
 * a non-Sonnet ANTHROPIC_MODEL.
 */
function estimateAICost({ provider, inputTokens, outputTokens, model }) {
  const usdToInr = usdToInrRate();
  if (provider && provider !== 'anthropic') {
    return { estimated_cost_usd: 0, estimated_cost_inr: 0, usd_to_inr: usdToInr };
  }
  const [inputPerMillionUsd, outputPerMillionUsd] = aiModelPricing(model);
  const inUsd = ((toNumber(inputTokens) / 1000000) * inputPerMillionUsd) + ((toNumber(outputTokens) / 1000000) * outputPerMillionUsd);
  return {
    estimated_cost_usd: Number(inUsd.toFixed(6)),
    estimated_cost_inr: Number((inUsd * usdToInr).toFixed(4)),
    usd_to_inr: usdToInr
  };
}

async function callAnthropicChat(systemContentFull, userMessage, maxTokensOverride) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  const modelCandidates = Array.from(new Set([
    process.env.ANTHROPIC_MODEL,
    'claude-sonnet-4-6'
  ].map((m) => String(m || '').trim()).filter(Boolean)));
  let lastErr = null;
  const defaultMax = Math.max(1024, parseInt(process.env.ADMIN_AI_MAX_OUTPUT_TOKENS || '8192', 10));
  const maxOut = maxTokensOverride || defaultMax;

  for (const model of modelCandidates) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOut,
        system: systemContentFull,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      const errMsg = 'Anthropic (' + model + '): ' + (errText || response.statusText);
      lastErr = new Error(errMsg);
      const low = errMsg.toLowerCase();
      const shouldTryAnotherModel =
        low.includes('model') ||
        low.includes('not found') ||
        low.includes('unsupported') ||
        low.includes('invalid_request_error');
      if (shouldTryAnotherModel) continue;
      throw lastErr;
    }

    const data = await response.json();
    const block = data.content && data.content[0];
    const text = block && block.type === 'text' ? block.text : (typeof block?.text === 'string' ? block.text : '');
    const inputTokens = toNumber(data && data.usage && data.usage.input_tokens, 0);
    const outputTokens = toNumber(data && data.usage && data.usage.output_tokens, 0);
    const usage = {
      provider: 'anthropic',
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...estimateAICost({ provider: 'anthropic', inputTokens, outputTokens, model })
    };
    // Recorded here rather than at the route because both AI Assist entry points
    // funnel through this function — one hook covers them all.
    recordAiUsage({ scope: 'admin_ai_assist', usage });
    return {
      reply: text ? text.trim() : null,
      usage
    };
  }

  throw lastErr || new Error('Anthropic: all model attempts failed');
}

/** Claude Sonnet-only provider for Admin AI Assist (BodyBank Lifestyle Manager prompt + enriched client/program context). */
async function callAIChat(baseContext, userMessage) {
  let enriched = baseContext || '';
  try {
    enriched = await bodybankAiCoach.enrichAdminAiContext({ queryAll, fs, rootDir: __dirname }, userMessage, baseContext || '');
  } catch (enrichErr) {
    console.error('[admin ai-assist enrich]', enrichErr.message);
  }
  const systemFull = bodybankAiCoach.buildTrainerSystemContent(enriched);
  // Detailed/monthly reports can produce very long responses — allow up to 16 384 tokens
  const msgLower = String(userMessage || '').toLowerCase();
  const isDetailed = /\b(detailed\s+report|monthly\s+report|complete\s+report|everything|full\s+report|in.?depth|deep\s+report|thorough|comprehensive\s+report)\b/.test(msgLower);
  const maxTokens = isDetailed ? 16384 : undefined;
  return callAnthropicChat(systemFull, userMessage, maxTokens);
}

function parseMonthlyReportCommand(text, lastClient) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const hasReportIntent =
    /\bmonthly\s+report\b/i.test(normalized) ||
    /\bdetailed\s+report\b/i.test(normalized) ||
    /\bfull\s+report\b/i.test(normalized) ||
    /\bcomplete\s+report\b/i.test(normalized) ||
    /\bperformance\s+report\b/i.test(normalized) ||
    /\bin.?depth\s+report\b/i.test(normalized) ||
    (/\breport\b/i.test(normalized) && /\b(monthly|this month|last month|for|of)\b/i.test(normalized)) ||
    (/\b(generate|create|make|download|get|give\s+me)\b/i.test(normalized) && /\breport\b/i.test(normalized));
  if (!hasReportIntent) return null;

  /* Explicit phrasing so month + client are never ambiguous */
  const lastMonthFor = normalized.match(/\bmonthly\s+report\s+last\s+month\s+for\s+(.+)/i);
  const forLastMonth = normalized.match(/\bmonthly\s+report\s+for\s+(.+?)\s+last\s+month\b/i);
  if (lastMonthFor || forLastMonth) {
    const rawClient = String((lastMonthFor && lastMonthFor[1]) || (forLastMonth && forLastMonth[1]) || '').trim();
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let clientQuery = rawClient
      .replace(/\b(this month|last month)\b/gi, '')
      .replace(/\b(for|in)\s+\d{4}-\d{2}\b/gi, '')
      .replace(/\b(for|in)\s+[a-zA-Z]+\s+\d{4}\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const PRONOUNS = /^(her|him|he|she|they|them|this|that|it|this\s+person|that\s+person|the\s+client|this\s+client|that\s+client)$/i;
    if ((!clientQuery || PRONOUNS.test(clientQuery)) && lastClient) {
      clientQuery = String(lastClient).trim();
    }
    return { clientQuery, monthKey: mk };
  }

  // Month extraction supports explicit yyyy-mm, "March 2026", and relative phrases.
  let monthRaw = '';
  const isoMonth = normalized.match(/\b(\d{4}-\d{2})\b/i);
  if (isoMonth) {
    monthRaw = isoMonth[1];
  } else {
    const namedMonth = normalized.match(/\b(?:for|in)\s+([a-zA-Z]+\s+\d{4})\b/i);
    if (namedMonth) monthRaw = namedMonth[1];
  }

  let inferredMonthKey = '';
  if (!monthRaw && /\bthis month\b/i.test(normalized)) {
    const now = new Date();
    inferredMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  } else if (!monthRaw && /\blast month\b/i.test(normalized)) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    inferredMonthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // Client extraction:
  // 1) monthly report [of|for] <client> ...
  // 2) report for <client> ...
  // 3) for <email> / of <email>
  let clientQuery = '';
  const m1 = normalized.match(/\bmonthly\s+report\b(?:\s+(?:of|for)\s+(.+?))?(?:\s+(?:for|in)\s+(\d{4}-\d{2}|[a-zA-Z]+\s+\d{4}|this month|last month))?\s*$/i);
  if (m1) {
    clientQuery = (m1[1] || '').trim();
    if (!monthRaw && (m1[2] || '').trim()) monthRaw = (m1[2] || '').trim();
  }
  if (!clientQuery) {
    const m2 = normalized.match(/\breport\b.*?\bfor\s+(.+?)(?:\s+(?:for|in)\s+(\d{4}-\d{2}|[a-zA-Z]+\s+\d{4}|this month|last month))?\s*$/i);
    if (m2) {
      clientQuery = (m2[1] || '').trim();
      if (!monthRaw && (m2[2] || '').trim()) monthRaw = (m2[2] || '').trim();
    }
  }
  if (!clientQuery) {
    const emailMatch = normalized.match(/\b(?:for|of)\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
    if (emailMatch) clientQuery = (emailMatch[1] || '').trim();
  }

  // Also extract client from "full/detailed/performance/complete report for X"
  if (!clientQuery) {
    const m3 = normalized.match(/\b(?:full|detailed|complete|performance|in.?depth)\s+report\s+(?:for|of)\s+(.+?)(?:\s+(?:for|in)\s+(?:\d{4}-\d{2}|[a-zA-Z]+\s+\d{4}|this month|last month))?\s*$/i);
    if (m3) clientQuery = (m3[1] || '').trim();
  }

  // Pronoun resolution — use lastClient passed from frontend conversation history
  const PRONOUNS = /^(her|him|he|she|they|them|this|that|it|this\s+person|that\s+person|the\s+client|this\s+client|that\s+client)$/i;
  if ((!clientQuery || PRONOUNS.test(clientQuery.trim())) && lastClient) {
    clientQuery = String(lastClient).trim();
  }

  // Clean common trailing phrases from client query.
  clientQuery = clientQuery
    .replace(/\b(this month|last month)\b/ig, '')
    .replace(/\b(for|in)\s+\d{4}-\d{2}\b/ig, '')
    .replace(/\b(for|in)\s+[a-zA-Z]+\s+\d{4}\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  let monthKey = inferredMonthKey;
  if (monthRaw) {
    if (/^\d{4}-\d{2}$/.test(monthRaw)) {
      monthKey = monthRaw;
    } else {
      const d = new Date(monthRaw);
      if (!Number.isNaN(d.getTime())) {
        monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
    }
  }
  if (!monthKey) {
    const now = new Date();
    monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  return { clientQuery, monthKey };
}

function getMonthRange(monthKey) {
  const [y, m] = String(monthKey || '').split('-').map((n) => parseInt(n, 10));
  const from = new Date(y, Math.max(0, m - 1), 1);
  const to = new Date(y, Math.max(0, m - 1) + 1, 1);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

function shiftMonthKey(monthKey, deltaMonths) {
  const [y, m] = String(monthKey || '').split('-').map((n) => parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  const d = new Date(y, m - 1 + deltaMonths, 1);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchMonthSliceForReport(userId, monthKey) {
  const range = getMonthRange(monthKey);
  if (!range) return null;
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  const [progressLogs, dailyCheckins, sundayCheckins, workouts] = await Promise.all([
    queryAll(
      `SELECT * FROM progress_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz
       ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ),
    queryAll(
      `SELECT * FROM daily_checkins
       WHERE user_id = ? AND checkin_date >= ?::date AND checkin_date < ?::date
       ORDER BY checkin_date ASC`,
      [userId, fromDate, toDate]
    ),
    queryAll(
      `SELECT * FROM sunday_checkins
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz
       ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ),
    queryAll(
      `SELECT * FROM workout_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz
       ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    )
  ]);
  return { progressLogs, dailyCheckins, sundayCheckins, workouts, monthKey };
}

function safeFilePart(value, fallback = 'record') {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

async function findUserForMonthlyReport(clientQuery) {
  const q = String(clientQuery || '').trim();
  if (!q) return null;
  const like = '%' + q.replace(/%/g, '\\%') + '%';
  return queryOne(
    `SELECT id, first_name, last_name, email
     FROM users
     WHERE role = 'user'
       AND (email ILIKE ? OR first_name ILIKE ? OR last_name ILIKE ? OR (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE ?)
     ORDER BY created_at DESC
     LIMIT 1`,
    [like, like, like, like]
  );
}

async function collectMonthlyReportData(userId, monthKey) {
  if (!getMonthRange(monthKey)) throw new Error('Invalid month format');
  const prevKey = shiftMonthKey(monthKey, -1);
  const range = getMonthRange(monthKey);
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();
  const [
    slice,
    previousMonth,
    part2,
    programs,
    tribeMember,
    audit,
    userGoals,
    hydrationLogs,
    weightLogs,
    meetings
  ] = await Promise.all([
    fetchMonthSliceForReport(userId, monthKey),
    prevKey ? fetchMonthSliceForReport(userId, prevKey) : Promise.resolve(null),
    queryOne(
      `SELECT * FROM part2_audit
       WHERE LOWER(email) = LOWER((SELECT email FROM users WHERE id = ?))
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    ),
    queryAll(
      `SELECT a.assigned_at, p.id as program_id, p.name as program_name
       FROM user_program_assignments a
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? AND a.removed_at IS NULL
       ORDER BY a.assigned_at DESC`,
      [userId]
    ).catch(() => []),
    queryOne(
      `SELECT phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, status, notes, next_checkin
       FROM tribe_members
       WHERE LOWER(email) = LOWER((SELECT email FROM users WHERE id = ?))
       ORDER BY start_date DESC LIMIT 1`,
      [userId]
    ).catch(() => null),
    queryOne(
      `SELECT * FROM audit_requests
       WHERE LOWER(email) = LOWER((SELECT email FROM users WHERE id = ?))
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ).catch(() => null),
    queryAll(
      `SELECT target_weight, target_body_fat, weekly_workout_target, created_at
       FROM user_goals WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    ).catch(() => []),
    queryAll(
      `SELECT amount_ml, glasses, created_at FROM hydration_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz
       ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ).catch(() => []),
    queryAll(
      `SELECT weight_kg, created_at FROM weight_logs
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz
       ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ).catch(() => []),
    queryAll(
      `SELECT meeting_date, time_slot, status, notes, created_at FROM meetings
       WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz
       ORDER BY created_at ASC`,
      [userId, fromIso, toIso]
    ).catch(() => [])
  ]);
  if (!slice) throw new Error('Invalid month format');
  const { progressLogs, dailyCheckins, sundayCheckins, workouts } = slice;
  return {
    progressLogs,
    dailyCheckins,
    sundayCheckins,
    workouts,
    part2,
    previousMonth,
    programs: programs || [],
    tribeMember: tribeMember || null,
    audit: audit || null,
    userGoals: userGoals || [],
    hydrationLogs: hydrationLogs || [],
    weightLogs: weightLogs || [],
    meetings: meetings || []
  };
}

function buildPoliteFallbackReply(context, question) {
  const q = (question || '').toLowerCase();
  let answer = '';
  const getCount = (regex) => { const m = context.match(regex); return m ? parseInt(m[1], 10) : 0; };
  const pendingAudit = getCount(/Pending:\s*(\d+)/);
  const pendingSignups = getCount(/Members on a trial:\s*(\d+)/);
  const contactMsg = getCount(/Contact messages:\s*(\d+)/);
  const tribeTotal = getCount(/Tribe members:\s*(\d+)\s+total/);
  const workouts = getCount(/Workout logs:\s*(\d+)/);
  const sundayCheck = getCount(/Sunday check-ins:\s*(\d+)/);
  const act = getCount(/Active:\s*(\d+)/);
  const suggestActions = () => {
    const actions = [];
    if (pendingAudit > 0) actions.push('• Go to **Audit forms** and approve or reject the ' + pendingAudit + ' pending request(s).');
    if (pendingSignups > 0) actions.push('• Open the **Memberships** tab to call new trial members and convert them.');
    if (contactMsg > 0) actions.push('• Check **Messages & Meetings** for contact messages and follow up if needed.');
    if (actions.length === 0) actions.push('• Use the dashboard tabs to explore Tribe, Workouts, Client Progress, and Performance Insights.');
    return '\n\n**Suggested actions:**\n' + actions.join('\n');
  };
  if (/\bhow many\b.*pending|pending.*(audit|form)/.test(q)) {
    answer = pendingAudit === 0 ? 'There are no pending audit forms at the moment.' : 'You have ' + pendingAudit + ' pending audit form' + (pendingAudit === 1 ? '' : 's') + ' right now.';
    answer += suggestActions();
  } else if (/\bhow many\b.*tribe|tribe.*(member|active)/.test(q)) {
    answer = tribeTotal === 0 ? 'There are no tribe members yet.' : 'You have ' + tribeTotal + ' tribe member' + (tribeTotal === 1 ? '' : 's') + ' in total, ' + act + ' active.';
    answer += suggestActions();
  } else if (/\bhow many\b.*workout|workout.*log/.test(q)) {
    answer = workouts === 0 ? 'There are no workout logs yet.' : 'There are ' + workouts + ' workout log' + (workouts === 1 ? '' : 's') + ' in the database.';
    answer += suggestActions();
  } else if (/\bhow many\b.*(message|contact)/.test(q)) {
    answer = contactMsg === 0 ? 'There are no contact messages yet.' : 'You have ' + contactMsg + ' contact message' + (contactMsg === 1 ? '' : 's') + '.';
    answer += suggestActions();
  } else if (/\bhow many\b.*(sunday|check-in|checkin)/.test(q)) {
    answer = sundayCheck === 0 ? 'There are no Sunday check-ins yet.' : 'There are ' + sundayCheck + ' Sunday check-in' + (sundayCheck === 1 ? '' : 's') + '.';
    answer += suggestActions();
  } else if (/\bhow many\b.*(sign-up|signup|pending.*approval)/.test(q)) {
    answer = 'New sign-ups now get instant trial access automatically — there is no approval queue. Track and convert trial members in the **Memberships** tab.';
    answer += suggestActions();
  } else if (/\b(what should i do|what can i do|suggest|recommend|what to do)\b/.test(q) && !/\b(list|summarize|how many|who|recent|latest)\b/.test(q)) {
    answer = 'Based on your current data:' + suggestActions();
  } else if (/\bpart-?2|part2\b/.test(q)) {
    const p2 = getCount(/Part-2 form submissions:\s*(\d+)/);
    answer = p2 === 0 ? 'There are no Part-2 form submissions yet.' : 'There are ' + p2 + ' Part-2 form submission' + (p2 === 1 ? '' : 's') + '. See the Part-2 Form tab for details.';
    answer += suggestActions();
  } else if (/\bmeeting\b/.test(q)) {
    const meet = getCount(/Meetings:\s*(\d+)\s+total/);
    answer = meet === 0 ? 'There are no meetings yet.' : 'There are ' + meet + ' meeting' + (meet === 1 ? '' : 's') + ' in total. See Messages & Meetings tab for details.';
    answer += suggestActions();
  } else if (/\b(summarize|list|who|recent|latest)\b.*\b(tribe|member)\b|\b(tribe|member)\b.*\b(summarize|list|who|recent)\b/.test(q)) {
    answer = tribeTotal === 0 ? 'There are no tribe members yet.' : 'You have ' + tribeTotal + ' tribe member' + (tribeTotal === 1 ? '' : 's') + ' (' + act + ' active). Check the Tribe tab for names and details.';
    answer += suggestActions();
  } else if (/\b(summarize|list|recent)\b.*\b(audit|request|form)\b|\b(audit|request)\b.*\b(summarize|list|recent)\b/.test(q)) {
    answer = pendingAudit > 0 ? 'You have ' + pendingAudit + ' pending audit form' + (pendingAudit === 1 ? '' : 's') + '. Open the Audit forms tab to review and approve or reject.' : 'No pending audit forms right now. Total audit forms are in the Audit forms tab.';
    answer += suggestActions();
  } else if (/\b(summarize|list|recent)\b.*\b(workout|exercise)\b|\b(workout|exercise)\b.*\b(summarize|list|recent)\b/.test(q)) {
    answer = workouts === 0 ? 'There are no workout logs yet.' : 'There are ' + workouts + ' workout log' + (workouts === 1 ? '' : 's') + '. See the Workouts tab for details.';
    answer += suggestActions();
  } else if (/\b(summarize|list|recent)\b.*\b(message|contact)\b|\b(message|contact)\b.*\b(summarize|list|recent)\b/.test(q)) {
    answer = contactMsg === 0 ? 'There are no contact messages yet.' : 'You have ' + contactMsg + ' contact message' + (contactMsg === 1 ? '' : 's') + '. See Messages & Meetings tab to read them.';
    answer += suggestActions();
  } else if (/\bwho\b.*\b(pending|sign-up|signup)\b|\b(pending|sign-up)\b.*\bwho\b/.test(q)) {
    answer = 'There is no approval queue anymore — new sign-ups get instant trial access. Open the **Memberships** tab to see new trial members and convert them.';
    answer += suggestActions();
  } else {
    answer = 'Here’s a snapshot of your current data:\n\n' + context.split('---').slice(0, 3).join('---').trim() + '\n\nIf you’d like answers to specific questions (e.g. “How many pending forms?”). For AI answers to any question, set ANTHROPIC_API_KEY in .env and restart.';
  }
  return answer;
}

app.post('/api/admin/ai-assist', verifyToken, requireAdmin, async (req, res) => {
  let reply = '';
  let usage = null;
  try {
    const { message, lastClient } = req.body || {};
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) {
      reply = 'Please ask a question about your BodyBank data (e.g. “How many pending audit forms?” or “Summarize tribe members”).';
      return res.json({ reply });
    }


    // ── Campaign command detection (before provider call) ───────────────────
    const campaignCmd = parseAICampaignCommand(text);
    if (campaignCmd) {
      try {
        if (campaignCmd.action === 'list') {
          const campaigns = await queryAll('SELECT * FROM campaign_messages ORDER BY day_of_week, time_of_day');
          reply = formatCampaignListReply(campaigns);
        } else if (campaignCmd.action === 'create') {
          const { message: cMsg, day_of_week: cDay, time_of_day: cTime } = campaignCmd.data;
          const cId = uuidv4();
          const cDayN = (cDay === 'daily') ? 'daily' : (normalizeCampaignDay(cDay) || cDay);
          const cTimeN = normalizeCampaignTime(cTime) || cTime;
          await run('INSERT INTO campaign_messages (id, day_of_week, time_of_day, message, is_active) VALUES (?, ?, ?, ?, TRUE)', [cId, cDayN, cTimeN, String(cMsg).trim()]);
          await safeRestartCampaignScheduler('[ai-assist campaign]');
          reply = 'Campaign created! Day: ' + cDayN + ' | Time: ' + cTimeN + ' IST | Message: "' + cMsg + '". It will be broadcast to all active users at the scheduled time.';
        } else if (campaignCmd.action === 'pause') {
          const cRow = await queryOne('SELECT * FROM campaign_messages WHERE id = ?', [campaignCmd.id]);
          if (!cRow) { reply = 'Campaign not found. Use "list campaigns" to see available IDs.'; }
          else {
            await run('UPDATE campaign_messages SET is_active = FALSE WHERE id = ?', [campaignCmd.id]);
            await safeRestartCampaignScheduler('[ai-assist campaign]');
            reply = 'Campaign paused: "' + cRow.message + '" (' + cRow.day_of_week + ' ' + cRow.time_of_day + ')';
          }
        } else if (campaignCmd.action === 'resume') {
          const cRow = await queryOne('SELECT * FROM campaign_messages WHERE id = ?', [campaignCmd.id]);
          if (!cRow) { reply = 'Campaign not found. Use "list campaigns" to see available IDs.'; }
          else {
            await run('UPDATE campaign_messages SET is_active = TRUE WHERE id = ?', [campaignCmd.id]);
            await safeRestartCampaignScheduler('[ai-assist campaign]');
            reply = 'Campaign resumed: "' + cRow.message + '" (' + cRow.day_of_week + ' ' + cRow.time_of_day + ')';
          }
        } else if (campaignCmd.action === 'delete') {
          const cRow = await queryOne('SELECT * FROM campaign_messages WHERE id = ?', [campaignCmd.id]);
          if (!cRow) { reply = 'Campaign not found. Use "list campaigns" to see available IDs.'; }
          else {
            await run('DELETE FROM campaign_messages WHERE id = ?', [campaignCmd.id]);
            await safeRestartCampaignScheduler('[ai-assist campaign]');
            reply = 'Campaign deleted: "' + cRow.message + '" (' + cRow.day_of_week + ' ' + cRow.time_of_day + ')';
          }
        } else if (campaignCmd.action === 'broadcast') {
          if (!CAMPAIGNS_ENABLED) {
            reply = 'Campaigns are currently on hold (CAMPAIGNS_ENABLED=false). Enable campaigns to broadcast.';
          } else {
            const bSent = await safeBroadcastCampaignMessage(campaignCmd.message);
            reply = 'Broadcast sent! Message: "' + campaignCmd.message + '". Reached ' + bSent + ' user(s).';
          }
        }
      } catch (cErr) {
        console.error('[ai-assist campaign]', cErr.message);
        reply = 'Campaign action failed. Please try again or use the Campaigns tab directly.';
      }
      return res.json({ reply, usage });
    }
    // ── End campaign command detection ───────────────────────────────────────

    // ── Monthly report command detection (PDF) ───────────────────────────────
    const monthlyCmd = parseMonthlyReportCommand(text, lastClient || '');
    if (monthlyCmd) {
      try {
        if (!monthlyCmd.clientQuery) {
          reply = 'Please specify the client name or email. Example: "monthly report of sai".';
          return res.json({ reply, usage });
        }
        const user = await findUserForMonthlyReport(monthlyCmd.clientQuery);
        if (!user) {
          reply = `I could not find a client matching "${monthlyCmd.clientQuery}". Please use full name or email.`;
          return res.json({ reply, usage });
        }
        const data = await collectMonthlyReportData(user.id, monthlyCmd.monthKey);
        const insights = await progressService.getAdminUserProgress(user.id).catch(() => null);

        const reportSummary = Object.assign(summarizeMonthlyReportData(data), {
          _daysInMonth: daysInMonthKeyForReport(monthlyCmd.monthKey)
        });
        const prevSummary = data.previousMonth ? summarizeMonthlyReportData(data.previousMonth) : null;
        let aiNarrative = monthlyReportNarrative.buildHeuristicNarrative({
          data,
          reportSummary,
          prevSummary,
          insights
        });
        if (
          String(process.env.MONTHLY_REPORT_AI || '1').trim() !== '0' &&
          process.env.ANTHROPIC_API_KEY &&
          process.env.ANTHROPIC_API_KEY.trim()
        ) {
          try {
            const fetched = await monthlyReportNarrative.fetchMonthlyReportNarrative({
              data,
              user: {
                id: user.id,
                name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
                email: user.email || ''
              },
              monthKey: monthlyCmd.monthKey,
              monthKeyText: monthLabelForReport(monthlyCmd.monthKey),
              reportSummary,
              prevSummary,
              insights,
              callAnthropicChat: (system, userMsg, maxTok) => callAnthropicChat(system, userMsg, maxTok)
            });
            if (fetched) aiNarrative = fetched;
          } catch (narErr) {
            console.error('[admin ai-assist monthly-report narrative]', narErr.message);
          }
        }

        const reportsDir = path.join(__dirname, 'public', 'reports');
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
        const fileName = `monthly-report-${user.id}-${monthlyCmd.monthKey}-${Date.now()}.pdf`;
        const outputPath = path.join(reportsDir, fileName);
        const logoPath = path.join(__dirname, 'public', 'img', 'bodybank X fitchef logo.png');

        await generateMonthlyClientReport({
          outputPath,
          monthKey: monthlyCmd.monthKey,
          user: {
            id: user.id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
            email: user.email || ''
          },
          data,
          insights,
          logoPath,
          aiNarrative
        });

        const baseUrl = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
        const reportUrl = `${baseUrl}/reports/${encodeURIComponent(fileName)}`;
        reply =
          `Monthly report generated for ${user.first_name || ''} ${user.last_name || ''} (${user.email || '-'})` +
          `\nMonth: ${monthLabelForReport(monthlyCmd.monthKey)}` +
          `\nDownload PDF: ${reportUrl}`;
      } catch (reportErr) {
        console.error('[admin ai-assist monthly-report]', reportErr.message);
        reply = 'I could not generate the monthly PDF report right now. Please try again.';
      }
      return res.json({ reply, usage });
    }
    // ── End monthly report command detection ─────────────────────────────────

    let context = '';
    try {
      context = await getAdminAIContext();
    } catch (ctxErr) {
      console.error('[admin ai-assist context]', ctxErr.message);
      context = '';
    }
    const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
    const hasAI = hasAnthropic;

    if (hasAI) {
      try {
        const aiResult = await callAIChat(context, text);
        if (aiResult && typeof aiResult === 'object') {
          reply = aiResult.reply;
          usage = aiResult.usage || null;
        } else {
          reply = aiResult;
        }
      } catch (aiErr) {
        console.error('[admin ai-assist provider]', aiErr.message);
        if (context && context.trim()) {
          reply = buildPoliteFallbackReply(context, text);
          const details = String(aiErr && aiErr.message ? aiErr.message : '').replace(/\s+/g, ' ').slice(0, 220);
          if (details) {
            reply += `\n\nProvider warning: ${details}`;
          }
        } else {
          reply = 'AI provider is unavailable right now. Please try again in a moment.';
        }
      }
    }
    if (reply == null || reply === '') {
      reply = hasAI
        ? 'I could not generate an answer right now. Please try again in a moment.'
        : 'To enable AI answers using your live data, add ANTHROPIC_API_KEY (Claude Sonnet) to the server .env file and restart.';
    }
    return res.json({ reply, usage });
  } catch (e) {
    console.error('[admin ai-assist]', e.message);
    reply = 'I couldn’t look up the data right now. Please try again in a moment, or check the dashboard directly.';
    return res.json({ reply, usage });
  }
});

// ============ CLIENT PROGRESS ANALYTICS (JWT-protected) ============
app.use('/api/progress', progressRoutes);
app.use(
  '/api/nutrition',
  createNutritionRouter({
    run,
    queryOne,
    queryAll,
    verifyToken,
    requireAdminOrSuperadmin,
    rateLimiter
  })
);
app.use(
  '/api/blood',
  createBloodRouter({
    run,
    queryOne,
    queryAll,
    verifyToken,
    requireAdminOrSuperadmin,
    rateLimiter,
    sendPushToAdmins
  })
);
// Unauthenticated by design: a client opening a WhatsApp link is not logged in.
// The token in the path is the credential — see createBloodPublicRouter.
app.use('/r/blood', createBloodPublicRouter({ run, queryOne, rateLimiter }));
app.use(
  '/api/smart-scale',
  createSmartScaleRouter({
    run,
    queryOne,
    queryAll,
    verifyToken,
    rateLimiter,
    sendPushToAdmins
  })
);
app.use('/api/marketing-ai', createMarketingAIRouter({ run, queryAll }));
app.use(
  '/api/referrals',
  createReferralRouter({
    run,
    queryOne,
    queryAll,
    verifyToken,
    requireAdminOrSuperadmin,
    rateLimiter,
    publicOrigin: process.env.PUBLIC_URL || process.env.APP_ORIGIN || ''
  })
);
app.use(
  '/api/wearables',
  createWearablesRouter({
    run,
    queryOne,
    queryAll,
    verifyToken,
    requireAdminOrSuperadmin,
    // The router has an inline fallback gate, but passing the real middleware keeps the
    // operator read-only routes on the same auth path as every other /api/operator/*.
    requireOperator,
    rateLimiter
  })
);
// ── FitChef Nutrition Assessment ─────────────────────────────────────────────
// Deliberately not behind verifyToken at the mount: the form is reachable with a
// signed invite link and with the plain shareable link, so each route inside
// applies its own gate (staff routes use verifyToken + requireOperator/admin).
app.use(
  '/api/nutrition-assessment',
  createNutritionAssessmentRouter({
    run,
    queryOne,
    queryAll,
    verifyToken,
    requireAdminOrSuperadmin,
    requireOperator,
    rateLimiter,
    jwtSecret: AUTH_JWT_SECRET,
    uploadsDir: FEED_UPLOADS_DIR,
    multer,
    // Fired on EVERY part, so it has to say which one landed. Sent to admins,
    // superadmins and operators alike — sendPushToAdmins covers all three,
    // because an operator's job is chasing exactly this.
    onSubmit: ({ id, identity, flags, part, complete }) => {
      const flagged = flags.filter((f) => f.block);
      const who = identity.full_name || identity.email || 'Someone';
      const partLabel = complete ? 'Part 2' : 'Part 1';

      let title;
      if (flagged.length) {
        // A blocking flag outranks everything else: no plan is generated for
        // these, and a human has to look before anything goes out.
        title = `⚠ FitChef ${partLabel} — needs review`;
      } else if (complete) {
        title = 'FitChef Assessment complete';
      } else {
        title = 'FitChef Assessment — Part 1 in';
      }

      const body = flagged.length
        ? `${who} — ${flagged.map((f) => f.label).join(', ')}`
        : (complete
          ? `${who} finished Part 2 — both parts are in`
          : `${who} submitted Part 1 — Part 2 still to send`);

      sendPushToAdmins(JSON.stringify({
        title,
        body,
        // Keyed per part so a Part 2 push cannot replace the Part 1 one in the
        // tray before anybody has read it.
        id: 'nutrition-assessment-' + id + '-p' + (complete ? 2 : 1),
        link: 'nutritionassessment'
      })).catch(() => {});
    }
  })
);

app.get('/api/admin/user-progress/:userId', (req, res, next) => {
  if (NODE_ENV === 'development' && (!req.headers.authorization || !String(req.headers.authorization).startsWith('Bearer '))) {
    return progressService.getAdminUserProgress(req.params.userId)
      .then((data) => res.json(data))
      .catch((e) => { console.error('[admin user-progress]', e.message); res.status(500).json({ error: e.message }); });
  }
  next();
}, verifyToken, requireAdmin, (req, res) => {
  getAdminUserProgress(req, res).catch((e) => {
    console.error('[admin user-progress]', e.message);
    res.status(500).json({ error: e.message });
  });
});

// Progress report: shareable link (token in query – no login required)
app.get('/api/progress-report', async (req, res) => {
  try {
    const token = req.query.token || req.query.t;
    const userId = verifyProgressReportToken(token);
    if (!userId) return res.status(401).json({ error: 'Invalid or expired link' });
    const data = await progressService.getAdminUserProgress(userId);
    res.json(data);
  } catch (e) {
    console.error('[progress-report]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: get shareable progress report link for a user
app.get('/api/admin/progress-report-link/:userId', verifyToken, requireAdmin, (req, res) => {
  try {
    const userId = req.params.userId;
    const token = signProgressReportToken(userId);
    const baseUrl = (req.protocol + '://' + req.get('host')).replace(/\/$/, '');
    const url = baseUrl + '/progress-report.html?t=' + encodeURIComponent(token);
    res.json({ url, token });
  } catch (e) {
    console.error('[progress-report-link]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ SUPERADMIN: DASHBOARD DATA (single payload with filters) ============
async function getSuperadminDashboardData(filters = {}) {
  const { from: dateFrom, to: dateTo, user_id: filterUserId } = filters;
  const hasDate = dateFrom || dateTo;
  const dateParams = [dateFrom, dateTo].filter(Boolean);
  const num = (v) => (v === undefined || v === null ? 0 : parseInt(String(v), 10) || 0);

  const addDateAndUser = (sql, dateCol, userCol) => {
    const conditions = [];
    const params = [];
    if (dateFrom && dateCol) { conditions.push(`date(${dateCol}) >= date(?)`); params.push(dateFrom); }
    if (dateTo && dateCol) { conditions.push(`date(${dateCol}) <= date(?)`); params.push(dateTo); }
    if (filterUserId && userCol) { conditions.push(`${userCol} = ?`); params.push(filterUserId); }
    if (conditions.length === 0) return { sql, params: [] };
    const where = sql.toLowerCase().includes(' where ') ? ' AND ' : ' WHERE ';
    return { sql: sql + where + conditions.join(' AND '), params };
  };

  const [pendingReq] = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'");
  const [auditTotal] = await queryAll("SELECT COUNT(*) as c FROM audit_requests");
  const [tribeTotal] = await queryAll("SELECT COUNT(*) as c FROM tribe_members");
  const [tribeActive] = await queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='active'");
  const [workoutsCount] = await queryAll("SELECT COUNT(*) as c FROM workout_logs");
  const [part2Count] = await queryAll("SELECT COUNT(*) as c FROM part2_audit");
  const [sundayCount] = await queryAll("SELECT COUNT(*) as c FROM sunday_checkins");
  const [messagesCount] = await queryAll("SELECT COUNT(*) as c FROM contact_messages");
  const [meetingsCount] = await queryAll("SELECT COUNT(*) as c FROM meetings");
  const [trialsCount] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND subscription_status='trialing' AND COALESCE(suspended, FALSE) = FALSE");
  const [usersApproved] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status = 'approved' OR approval_status IS NULL)");
  const [dailyCheckinsCount] = await queryAll("SELECT COUNT(*) as c FROM daily_checkins");
  const [programAssignCount] = await queryAll("SELECT COUNT(*) as c FROM user_program_assignments WHERE removed_at IS NULL");

  const stats = {
    pending_requests: num(pendingReq?.c),
    audit_total: num(auditTotal?.c),
    tribe_total: num(tribeTotal?.c),
    tribe_active: num(tribeActive?.c),
    workouts: num(workoutsCount?.c),
    part2: num(part2Count?.c),
    sunday_checkins: num(sundayCount?.c),
    daily_checkins: num(dailyCheckinsCount?.c),
    program_assignments: num(programAssignCount?.c),
    messages: num(messagesCount?.c),
    meetings: num(meetingsCount?.c),
    trials: num(trialsCount?.c),
    approved_users: num(usersApproved?.c)
  };

  let audit = await queryAll("SELECT id, first_name, last_name, email, city, goals, status, created_at FROM audit_requests ORDER BY created_at DESC LIMIT 200");
  let part2 = await queryAll("SELECT id, name, email, mobile, activity_level, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 200");
  let sunday_checkins = await queryAll("SELECT id, full_name, reply_email, total_weight_loss, achievements, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT 200");
  let users = await queryAll("SELECT id, first_name, last_name, email, approval_status, created_at FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 300");
  let workouts = await queryAll("SELECT w.id, w.user_id, w.workout_name, w.duration_seconds, w.feedback, w.created_at, u.first_name, u.last_name FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 200");
  let tribe = await queryAll("SELECT id, first_name, last_name, email, city, phase, start_date, activity_per_week, status FROM tribe_members ORDER BY start_date DESC LIMIT 200");
  let meetings = await queryAll("SELECT id, user_id, user_name, user_email, meeting_date, time_slot, status, created_at FROM meetings ORDER BY created_at DESC LIMIT 200");
  let messages = await queryAll("SELECT id, user_id, name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 200");
  let daily_checkins = await queryAll(
    "SELECT dc.id, dc.user_id, dc.checkin_date, dc.steps, dc.water_ml, dc.protein_g, dc.sleep_hours, dc.created_at, u.first_name, u.last_name, u.email FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id WHERE COALESCE(dc.is_freeze, FALSE) = FALSE ORDER BY dc.checkin_date DESC, dc.created_at DESC LIMIT 200"
  );
  let program_assignments = await queryAll(
    "SELECT a.id, a.user_id, a.program_id, a.assigned_at, p.name as program_name, u.first_name, u.last_name, u.email FROM user_program_assignments a JOIN programs p ON p.id = a.program_id LEFT JOIN users u ON u.id = a.user_id WHERE a.removed_at IS NULL ORDER BY a.assigned_at DESC LIMIT 200"
  );

  if (hasDate || filterUserId) {
    const filterByDate = (rows, dateKey) => {
      if (!hasDate) return filterUserId ? rows.filter(r => r.user_id === filterUserId) : rows;
      return rows.filter(r => {
        const d = (r[dateKey] || r.created_at || '').toString().slice(0, 10);
        const okDate = (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);
        const okUser = !filterUserId || r.user_id === filterUserId;
        return okDate && okUser;
      });
    };
    audit = filterByDate(audit, 'created_at');
    part2 = filterByDate(part2, 'created_at');
    sunday_checkins = filterByDate(sunday_checkins, 'created_at');
    workouts = filterByDate(workouts, 'created_at');
    meetings = filterByDate(meetings, 'created_at');
    messages = filterByDate(messages, 'created_at');
    daily_checkins = filterByDate(daily_checkins, 'checkin_date');
    program_assignments = filterByDate(program_assignments, 'assigned_at');
    if (filterUserId) {
      users = users.filter(r => r.id === filterUserId);
      daily_checkins = daily_checkins.filter(r => r.user_id === filterUserId);
      program_assignments = program_assignments.filter(r => r.user_id === filterUserId);
    }
  }

  const performance = { ...stats };

  return {
    stats,
    performance,
    audit,
    part2,
    sunday_checkins,
    daily_checkins: daily_checkins.map((r) => attachWaterLitersToDailyRow(r)),
    program_assignments,
    users,
    workouts,
    tribe,
    meetings,
    messages,
    filters: { from: dateFrom || null, to: dateTo || null, user_id: filterUserId || null }
  };
}

app.get('/api/superadmin/dashboard', verifyToken, requireSuperadmin, async (req, res) => {
  try {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const user_id = req.query.user_id || null;
    const data = await getSuperadminDashboardData({ from, to, user_id });
    res.json(data);
  } catch (e) {
    console.error('[superadmin dashboard]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/superadmin/share-link', verifyToken, requireSuperadmin, async (req, res) => {
  try {
    const { from, to, user_id } = req.body || {};
    const token = signShareToken({ from: from || null, to: to || null, user_id: user_id || null });
    const baseUrl = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
    const url = baseUrl + '/index.html?superadmin_share=' + encodeURIComponent(token);
    res.json({ url, token });
  } catch (e) {
    console.error('[superadmin share-link]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// One-time bootstrap: sync superadmin from env. Call once after deploy, then remove SUPERADMIN_BOOTSTRAP_SECRET from env.
app.get('/api/superadmin/bootstrap', async (req, res) => {
  try {
    const secret = req.query.secret || req.headers['x-bootstrap-secret'] || '';
    const expected = process.env.SUPERADMIN_BOOTSTRAP_SECRET || '';
    // Constant-time comparison so response timing cannot be used to recover the
    // secret byte by byte. Also refuse a weak secret outright: this endpoint syncs
    // the superadmin account, so a short value here is a real risk.
    if (!expected || expected.length < 24 || !timingSafeEquals(String(secret), expected)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
    const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
    if (!superadminEmailNorm || !superadminPassTrimmed) {
      return res.status(400).json({ error: 'Set SUPERADMIN_EMAIL and SUPERADMIN_PASS in environment' });
    }
    await runSuperadminSync();
    return res.json({ ok: true, message: 'Superadmin synced. You can now log in with ' + SUPERADMIN_EMAIL });
  } catch (e) {
    console.error('[superadmin bootstrap]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/superadmin/shared', async (req, res) => {
  try {
    const token = req.query.t || req.query.token || null;
    const decoded = verifyShareToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid or expired share link' });
    const data = await getSuperadminDashboardData({
      from: decoded.from || null,
      to: decoded.to || null,
      user_id: decoded.user_id || null
    });
    res.json(data);
  } catch (e) {
    console.error('[superadmin shared]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ SERVE FRONTEND ============
// PWA: serve service worker and manifest with no-cache so updates apply quickly
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
// ============ CAMPAIGN API ============

// GET /api/campaigns — list all campaigns (admin)
app.get('/api/campaigns', verifyToken, requireAdmin, async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const rows = activeOnly
      ? await queryAll('SELECT * FROM campaign_messages WHERE is_active = TRUE ORDER BY day_of_week, time_of_day')
      : await queryAll('SELECT * FROM campaign_messages ORDER BY day_of_week, time_of_day');
    res.json(rows);
  } catch (e) {
    console.error('[campaigns] GET error:', e.message);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

// POST /api/campaigns — create a new campaign (admin)
app.post('/api/campaigns', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { message, day_of_week, time_of_day } = req.body || {};
    if (!message || !day_of_week || !time_of_day) {
      return res.status(400).json({ error: 'message, day_of_week, and time_of_day are required' });
    }
    const day  = normalizeCampaignDay(day_of_week);
    const time = normalizeCampaignTime(time_of_day);
    if (!day && day_of_week !== 'daily') {
      return res.status(400).json({ error: 'Invalid day_of_week. Use: sunday–saturday or daily' });
    }
    if (!time) {
      return res.status(400).json({ error: 'Invalid time_of_day. Use HH:MM or H:MM AM/PM' });
    }
    const id = uuidv4();
    await run(
      'INSERT INTO campaign_messages (id, day_of_week, time_of_day, message, is_active) VALUES (?, ?, ?, ?, TRUE)',
      [id, day || 'daily', time, String(message).trim()]
    );
    const row = await queryOne('SELECT * FROM campaign_messages WHERE id = ?', [id]);
    await safeRestartCampaignScheduler('[campaigns]');
    res.json({ ok: true, campaign: row });
  } catch (e) {
    console.error('[campaigns] POST error:', e.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// PUT /api/campaigns/:id — update a campaign (admin)
app.put('/api/campaigns/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { message, day_of_week, time_of_day, is_active } = req.body || {};
    const updates = [];
    const params  = [];
    if (message     !== undefined) { updates.push('message = ?');     params.push(String(message).trim()); }
    if (day_of_week !== undefined) {
      const d = normalizeCampaignDay(day_of_week) || (day_of_week === 'daily' ? 'daily' : null);
      if (!d) return res.status(400).json({ error: 'Invalid day_of_week' });
      updates.push('day_of_week = ?'); params.push(d);
    }
    if (time_of_day !== undefined) {
      const t = normalizeCampaignTime(time_of_day);
      if (!t) return res.status(400).json({ error: 'Invalid time_of_day' });
      updates.push('time_of_day = ?'); params.push(t);
    }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(Boolean(is_active)); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await run(`UPDATE campaign_messages SET ${updates.join(', ')} WHERE id = ?`, params);
    const row = await queryOne('SELECT * FROM campaign_messages WHERE id = ?', [req.params.id]);
    await safeRestartCampaignScheduler('[campaigns]');
    res.json({ ok: true, campaign: row });
  } catch (e) {
    console.error('[campaigns] PUT error:', e.message);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// DELETE /api/campaigns/:id — delete a campaign (admin)
app.delete('/api/campaigns/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM campaign_messages WHERE id = ?', [req.params.id]);
    await safeRestartCampaignScheduler('[campaigns]');
    res.json({ ok: true });
  } catch (e) {
    console.error('[campaigns] DELETE error:', e.message);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

// POST /api/campaigns/:id/pause — pause a campaign (admin)
app.post('/api/campaigns/:id/pause', verifyToken, requireAdmin, async (req, res) => {
  try {
    await run('UPDATE campaign_messages SET is_active = FALSE WHERE id = ?', [req.params.id]);
    await safeRestartCampaignScheduler('[campaigns]');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to pause campaign' });
  }
});

// POST /api/campaigns/:id/resume — resume a campaign (admin)
app.post('/api/campaigns/:id/resume', verifyToken, requireAdmin, async (req, res) => {
  try {
    await run('UPDATE campaign_messages SET is_active = TRUE WHERE id = ?', [req.params.id]);
    await safeRestartCampaignScheduler('[campaigns]');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resume campaign' });
  }
});

// POST /api/campaigns/broadcast — immediate broadcast to all active users (admin)
app.post('/api/campaigns/broadcast', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!CAMPAIGNS_ENABLED) {
      return res.status(400).json({ error: 'Campaigns are on hold. Set CAMPAIGNS_ENABLED=true to send broadcasts.' });
    }
    const sent = await safeBroadcastCampaignMessage(String(message).trim());
    res.json({ ok: true, sent });
  } catch (e) {
    console.error('[campaigns] Broadcast error:', e.message);
    res.status(500).json({ error: 'Broadcast failed' });
  }
});

// GET /api/campaigns/log — view recent send log (admin)
app.get('/api/campaigns/log', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM campaign_send_log ORDER BY sent_at DESC LIMIT 50');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load send log' });
  }
});

// Serve HTML pages with no-cache so users always get latest UI after deploys
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Standalone auth pages — shareable direct links (/signin, /signup) that do not
// depend on the landing-page SPA. They write the same `bodybank_session` key and
// hand off to /index.html, which opens the right dashboard for the role.
app.get(['/signin', '/sign-in', '/login', '/signin.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'signin.html'));
});
app.get(['/signup', '/sign-up', '/register', '/join', '/signup.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});
app.get('/ai-trainer.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'ai-trainer.html'));
});
app.get('/feed.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'feed.html'));
});

// Server-rendered reset password page — token validated on server, no client-side URL parsing
app.get('/reset-password', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  let token = String(req.query.token || '').replace(/[^a-fA-F0-9-]/g, '');
  if (!token || token.length < 32) {
    return res.send(resetPasswordHtml(false, 'Invalid or expired link. Please use Forgot Password to request a new one.'));
  }
  try {
    const row = await queryOne(
      "SELECT pr.id, pr.used, pr.expires_at, u.role FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token IN (?, ?)",
      // Hash first; the raw token is the legacy form, accepted so links already in
      // people's inboxes when this shipped keep working until they expire (24h).
      // The plaintext arm can be deleted after that window.
      [hashResetToken(token), token]
    );
    if (!row || row.used || new Date(row.expires_at) < new Date() || row.role !== 'user') {
      return res.send(resetPasswordHtml(false, 'This reset link is invalid or has expired. Please use Forgot Password to request a new one.'));
    }
    return res.send(resetPasswordHtml(true, null, token));
  } catch (e) {
    console.error('[ResetPassword page]', e.message);
    return res.send(resetPasswordHtml(false, 'Something went wrong. Please try again.'));
  }
});

function resetPasswordHtml(valid, errorMsg, token) {
  const base = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset Password - BodyBank</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;background:#060606;color:#e8e4dc;font-family:'Outfit',sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.box{background:#0d0d0d;border:1.5px solid #c8a44e;border-radius:20px;padding:40px;max-width:400px;width:100%}
h1{font-family:'Cormorant Garamond',serif;font-size:28px;margin-bottom:12px;color:#e8e4dc}
p{margin-bottom:20px;font-size:14px;color:rgba(232,228,220,0.8)}
input{width:100%;padding:14px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e8e4dc;font-size:16px;margin-bottom:16px}
button{width:100%;padding:14px;background:linear-gradient(135deg,#d4af37,#c8a44e);border:none;border-radius:8px;color:#060606;font-weight:700;font-size:15px;cursor:pointer}
button:hover{opacity:.95}
a{color:#c8a44e;text-decoration:none;font-size:14px;display:inline-block;margin-top:16px}
a:hover{text-decoration:underline}
.err{color:#e05050;margin-bottom:16px}
.pw-wrap{position:relative;display:block;margin-bottom:16px}.pw-wrap input{padding-right:44px;margin-bottom:0}.pw-toggle{position:absolute;right:0;top:0;bottom:0;width:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;color:rgba(232,228,220,0.6);cursor:pointer;font-size:18px;-webkit-tap-highlight-color:transparent}.pw-toggle:hover{color:#e8e4dc}
.ok{color:#50c878;font-weight:600;margin-top:12px}
</style></head><body><div class="box">`;
  if (!valid) {
    return base + `<h1>Invalid or Expired Link</h1><p class="err">${(errorMsg || 'This reset link is invalid or has expired.').replace(/</g, '&lt;')}</p><a href="/index.html">← Back to Home</a></div></body></html>`;
  }
  return base + `<h1>Set New Password</h1><p>Enter your new password below.</p>
<form id="f" onsubmit="return false;"><input type="hidden" name="token" value="${token.replace(/"/g, '&quot;')}">
<div class="pw-wrap"><input type="password" name="new_password" id="rpNew" placeholder="New password (min 6 characters)" minlength="6" required><button type="button" class="pw-toggle" onclick="var i=document.getElementById('rpNew');i.type=i.type==='password'?'text':'password'" title="Show password">&#128065;</button></div>
<div class="pw-wrap"><input type="password" name="confirm" id="rpConfirm" placeholder="Confirm password" minlength="6" required><button type="button" class="pw-toggle" onclick="var i=document.getElementById('rpConfirm');i.type=i.type==='password'?'text':'password'" title="Show password">&#128065;</button></div>
<button type="submit">Update Password</button></form>
<p id="msg"></p><a href="/index.html">← Back to Home</a></div>
<script>
document.getElementById('f').onsubmit=async function(e){
  if(e){e.preventDefault();e.stopPropagation();}
  var np=this.new_password.value, cf=this.confirm.value, tok=this.token.value;
  var submitBtn=this.querySelector('button[type=submit]');
  if(np.length<6){alert('Password must be at least 6 characters.');return false;}
  if(np!==cf){alert('Passwords do not match.');return false;}
  submitBtn.disabled=true;
  try{
    var r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:tok,new_password:np})});
    var d=await r.json();
    if(d.error){
      alert(d.error);
      document.getElementById('msg').innerHTML='<span class="err">'+d.error.replace(/</g,'&lt;')+'</span>';
    }else{
      try{
        localStorage.setItem('bodybank_session', JSON.stringify(d));
        localStorage.setItem('bodybank_reset_success', '1');
      }catch(_){}
      document.getElementById('msg').innerHTML='<span class="ok">Password updated successfully. Taking you to your dashboard...</span>';
      this.style.display='none';
      window.location.replace('/index.html');
      return;
    }
  }catch(e){
    alert('Network error. Try again.');
    document.getElementById('msg').innerHTML='<span class="err">Network error. Try again.</span>';
  }
  submitBtn.disabled=false;
};
</script></body></html>`;
}
// Sign in with Apple — domain ownership verification.
// Apple fetches this file when a domain is added to the Services ID. Express's
// static middleware ignores dotfiles by default, so serve the .well-known path
// explicitly. The file lives at public/.well-known/apple-developer-domain-association.txt;
// replace its contents with the string Apple gives you in the Services ID setup.
app.get('/.well-known/apple-developer-domain-association.txt', (req, res) => {
  const file = path.join(__dirname, 'public', '.well-known', 'apple-developer-domain-association.txt');
  res.type('text/plain').sendFile(file, { dotfiles: 'allow' }, err => {
    if (err) res.status(404).end();
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '7d' : 0,
  setHeaders: (res, filePath) => {
    if (/\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// Deep link into SPA admin Nutrition tab (bookmark / share)
app.get(['/admin/nutrition-report', '/admin/nutrition-report/'], (req, res) => {
  res.redirect(302, '/?adminNutrition=1');
});
app.get(['/admin/blood-reports', '/admin/blood-reports/'], (req, res) => {
  res.redirect(302, '/?adminBlood=1');
});

// Public programs list (used by Admin "Assign Program" tab)
// Kept very simple and safe: just returns id, name and PDF URL.
app.get('/api/programs', async (req, res) => {
  try {
    const rows = await queryAll('SELECT id, name, pdf_url FROM programs ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Body snapshots (My Body section) ────────────────────────────────
// Phase 1 forward-compat contract (locked):
//  • measurements JSONB is the home for chest/arms/hips/thighs in Phase 2
//    (keys: chest_cm, arms_cm, hips_cm, thighs_cm — left/right merge or split TBD).
//  • shared_with_manager BOOLEAN powers Phase 4 admin/manager view.
//  • photo_front/side/back are PLAIN relative URLs (e.g. /uploads/body/<uid>/<ts>-front.jpg)
//    so Phase 5 can rewrite them through a background-removal pipeline.
//  • Phase 3 home dashboard "days since last snapshot" is derivable from the
//    GET /api/me/body/snapshots first item's snapshot_date.
// Files live on disk under <root>/uploads/body/<user_id>/ — served by the
// existing app.use('/uploads', express.static(...)) mount below.
var BODY_UPLOADS_DIR = path.join(FEED_UPLOADS_DIR, 'body');
function bbBodyEnsureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}
function bbBodyExtFromMime(mime, originalName) {
  var m = String(mime || '').toLowerCase();
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/heic' || m === 'image/heif') return '.heic';
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  var ext = String(path.extname(originalName || '') || '').toLowerCase();
  if (ext === '.png' || ext === '.webp' || ext === '.heic' || ext === '.heif') return ext;
  return '.jpg';
}
function bbBodyValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}
function bbBodyTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}
function bbBodyParseFloat(v) {
  if (v === undefined || v === null || v === '') return null;
  var n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}
function bbBodyParseMeasurements(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    var obj = JSON.parse(String(raw));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) {}
  return null;
}
function bbBodyRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_date: row.snapshot_date,
    photo_front: row.photo_front || null,
    photo_side: row.photo_side || null,
    photo_back: row.photo_back || null,
    bodyweight_kg: row.bodyweight_kg !== null && row.bodyweight_kg !== undefined ? Number(row.bodyweight_kg) : null,
    waist_cm: row.waist_cm !== null && row.waist_cm !== undefined ? Number(row.waist_cm) : null,
    measurements: row.measurements || null,
    notes: row.notes || '',
    shared_with_manager: !!row.shared_with_manager,
    created_at: row.created_at
  };
}

var bodyUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024, files: 3 }
    })
  : null;

var bodyUploadFields = bodyUpload
  ? bodyUpload.fields([
      { name: 'front', maxCount: 1 },
      { name: 'side',  maxCount: 1 },
      { name: 'back',  maxCount: 1 }
    ])
  : function(req, _res, next) { next(); };

// ── Phase 5: AI background removal ────────────────────────────────
// We lazy-load `@imgly/background-removal-node` (ESM-only, ONNX-based, ~80 MB
// model auto-downloads on first call and is cached under node_modules). The
// dynamic import keeps server start-up cheap even on machines that haven't run
// `npm install` for this dep yet — the upload route just falls back to saving
// the original photo if the module / model can't be loaded.
var BB_BG_REMOVAL_DISABLED = String(process.env.BB_BG_REMOVAL_DISABLED || '').toLowerCase() === '1';
var bbBgRemovalModulePromise = null;
function bbLoadBgRemoval() {
  if (BB_BG_REMOVAL_DISABLED) return Promise.resolve(null);
  if (!bbBgRemovalModulePromise) {
    bbBgRemovalModulePromise = (async () => {
      try {
        // eslint-disable-next-line no-new-func -- avoid CJS transpilers turning
        // the dynamic import into a require() call (which would fail on this ESM dep).
        var dynImport = new Function('s', 'return import(s)');
        var mod = await dynImport('@imgly/background-removal-node');
        return mod && (mod.removeBackground || (mod.default && mod.default.removeBackground))
          ? mod
          : null;
      } catch (e) {
        console.warn('[body-snapshot] bg-removal module unavailable:', e && e.message);
        return null;
      }
    })();
  }
  return bbBgRemovalModulePromise;
}
// Returns a PNG Buffer with bg removed, or null if processing failed / not available.
async function bbBodyRemoveBackground(buffer) {
  try {
    if (!buffer || !buffer.length) return null;
    var mod = await bbLoadBgRemoval();
    if (!mod) return null;
    var removeBackground = mod.removeBackground || (mod.default && mod.default.removeBackground);
    if (typeof removeBackground !== 'function') return null;
    // The node build accepts a Buffer/Uint8Array/Blob and returns a Blob.
    var out = await removeBackground(buffer, { output: { format: 'image/png', quality: 0.92 } });
    if (!out) return null;
    // out is a Blob (web-style). Convert to Buffer.
    if (typeof out.arrayBuffer === 'function') {
      var ab = await out.arrayBuffer();
      return Buffer.from(ab);
    }
    if (Buffer.isBuffer(out)) return out;
    if (out instanceof Uint8Array) return Buffer.from(out);
    return null;
  } catch (e) {
    console.warn('[body-snapshot] bg-removal failed, falling back to original:', e && e.message);
    return null;
  }
}

app.post('/api/me/body/snapshot', verifyToken, bodyUploadFields, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    var userId = req.user.id;
    var body = req.body || {};
    var snapshotDate = String(body.snapshot_date || '').trim();
    if (!snapshotDate) snapshotDate = bbBodyTodayUTC();
    if (!bbBodyValidYmd(snapshotDate)) {
      return res.status(400).json({ error: 'snapshot_date must be YYYY-MM-DD.' });
    }
    var bodyweightKg = bbBodyParseFloat(body.bodyweight_kg);
    var waistCm      = bbBodyParseFloat(body.waist_cm);
    var measurements = bbBodyParseMeasurements(body.measurements);
    var notes = String(body.notes || '').trim().slice(0, 2000) || null;

    var files = (req.files && typeof req.files === 'object') ? req.files : {};
    var hasFront = !!(files.front && files.front[0]);
    var hasSide  = !!(files.side  && files.side[0]);
    var hasBack  = !!(files.back  && files.back[0]);
    var hasAnyPhoto = hasFront || hasSide || hasBack;
    var hasAnyMetric = (bodyweightKg !== null) || (waistCm !== null);
    if (!hasAnyPhoto && !hasAnyMetric) {
      return res.status(400).json({ error: 'Add at least one photo, bodyweight, or waist measurement.' });
    }

    // Persist files to disk
    // Phase 5 naming convention (locked):
    //   • Original (raw upload) is always written at  <ts>-<view>-orig.<ext>
    //     so we never lose the source data.
    //   • If background-removal succeeds, the processed PNG is written at
    //     <ts>-<view>.png  and that URL is stored in the DB.
    //   • If bg-removal is opted out OR fails, we copy/keep the original at
    //     <ts>-<view>.<ext> as the canonical (DB-stored) path. This keeps the
    //     `photo_*` columns as plain relative URLs (Phase 1 contract).
    //   • Backwards-compat: existing snapshots from Phase 1 already point to
    //     <ts>-<view>.<ext>, which still resolves on disk.
    var dir = path.join(BODY_UPLOADS_DIR, String(userId));
    bbBodyEnsureDir(dir);
    var ts = Date.now();
    var photoFront = null, photoSide = null, photoBack = null;

    // Opt-in (default OFF). Bg-removal can take 5–60s depending on cold-start,
    // so we default it off to keep saves fast. Users explicitly opt in via the
    // upload modal checkbox, which sends remove_bg=1.
    var rmFlagRaw = body.remove_bg;
    var rmFlag = String(rmFlagRaw == null ? '' : rmFlagRaw).toLowerCase().trim();
    var wantBgRemoval = (rmFlag === '1' || rmFlag === 'true' || rmFlag === 'on');

    async function saveOne(fileObj, viewName) {
      if (!fileObj || !fileObj.buffer) return null;
      var origExt = bbBodyExtFromMime(fileObj.mimetype, fileObj.originalname);

      // 1) Always preserve the source upload (best-effort; non-fatal on failure).
      try {
        var origName = ts + '-' + viewName + '-orig' + origExt;
        fs.writeFileSync(path.join(dir, origName), fileObj.buffer);
      } catch (eOrig) {
        console.warn('[body-snapshot] could not save original copy:', eOrig && eOrig.message);
      }

      // 2) Try bg-removal if requested.
      var processedBuf = null;
      if (wantBgRemoval) {
        processedBuf = await bbBodyRemoveBackground(fileObj.buffer);
      }

      var canonicalExt, canonicalBuf;
      if (processedBuf && processedBuf.length) {
        canonicalExt = '.png';
        canonicalBuf = processedBuf;
      } else {
        canonicalExt = origExt;
        canonicalBuf = fileObj.buffer;
      }
      var fname = ts + '-' + viewName + canonicalExt;
      fs.writeFileSync(path.join(dir, fname), canonicalBuf);
      return '/uploads/body/' + encodeURIComponent(String(userId)) + '/' + fname;
    }
    try {
      if (hasFront) photoFront = await saveOne(files.front[0], 'front');
      if (hasSide)  photoSide  = await saveOne(files.side[0],  'side');
      if (hasBack)  photoBack  = await saveOne(files.back[0],  'back');
    } catch (e) {
      console.error('[body-snapshot] file save error:', e.message);
      return res.status(500).json({ error: 'Could not save photo to disk.' });
    }

    var inserted = await queryOne(
      `INSERT INTO body_snapshots
         (user_id, snapshot_date, photo_front, photo_side, photo_back,
          bodyweight_kg, waist_cm, measurements, notes, shared_with_manager)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, user_id, snapshot_date, photo_front, photo_side, photo_back,
                 bodyweight_kg, waist_cm, measurements, notes,
                 shared_with_manager, created_at`,
      [
        userId,
        snapshotDate,
        photoFront,
        photoSide,
        photoBack,
        bodyweightKg,
        waistCm,
        measurements ? JSON.stringify(measurements) : null,
        notes,
        false
      ]
    );

    return res.status(201).json({ snapshot: bbBodyRowToJson(inserted) });
  } catch (e) {
    console.error('[body-snapshot POST]', e.message);
    return res.status(500).json({ error: e.message || 'Failed to save snapshot.' });
  }
});

app.get('/api/me/body/snapshots', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    var rows;
    try {
      rows = await queryAll(
        `SELECT id, user_id, snapshot_date, photo_front, photo_side, photo_back,
                bodyweight_kg, waist_cm, measurements, notes,
                shared_with_manager, created_at
           FROM body_snapshots
          WHERE user_id = ?
          ORDER BY snapshot_date DESC, id DESC
          LIMIT 200`,
        [req.user.id]
      );
    } catch (eFull) {
      // Table or one of the newer columns is missing on this deploy.
      // Self-heal: run the same idempotent CREATE / ALTERs that initDB does,
      // then retry. If the retry still fails we fall back to a minimal SELECT
      // so the user always sees their snapshots (even if a column is missing).
      console.warn('[body-snapshot GET] full SELECT failed, attempting self-heal:', eFull && eFull.message);
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS body_snapshots (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          snapshot_date TEXT NOT NULL,
          photo_front TEXT, photo_side TEXT, photo_back TEXT,
          bodyweight_kg REAL, waist_cm REAL,
          measurements JSONB,
          shared_with_manager BOOLEAN DEFAULT FALSE,
          notes TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )`);
        var addCols = ['photo_front TEXT','photo_side TEXT','photo_back TEXT','bodyweight_kg REAL','waist_cm REAL','measurements JSONB','shared_with_manager BOOLEAN DEFAULT FALSE','notes TEXT','created_at TIMESTAMP DEFAULT NOW()'];
        for (var ci = 0; ci < addCols.length; ci++) {
          try { await pool.query('ALTER TABLE body_snapshots ADD COLUMN IF NOT EXISTS ' + addCols[ci]); } catch (_) {}
        }
      } catch (eHeal) {
        console.warn('[body-snapshot GET] self-heal create/alter failed:', eHeal && eHeal.message);
      }
      try {
        rows = await queryAll(
          `SELECT id, user_id, snapshot_date, photo_front, photo_side, photo_back,
                  bodyweight_kg, waist_cm, measurements, notes,
                  shared_with_manager, created_at
             FROM body_snapshots
            WHERE user_id = ?
            ORDER BY snapshot_date DESC, id DESC
            LIMIT 200`,
          [req.user.id]
        );
      } catch (eRetry) {
        console.warn('[body-snapshot GET] retry failed, using minimal SELECT:', eRetry && eRetry.message);
        // Final fallback: minimal columns. Returns an empty list if even this
        // throws (rather than letting the route 500 → "Network error" toast).
        try {
          rows = await queryAll(
            `SELECT id, user_id, snapshot_date FROM body_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC, id DESC LIMIT 200`,
            [req.user.id]
          );
        } catch (eMin) {
          console.warn('[body-snapshot GET] minimal SELECT also failed:', eMin && eMin.message);
          rows = [];
        }
      }
    }
    return res.json({ snapshots: (rows || []).map(bbBodyRowToJson) });
  } catch (e) {
    console.error('[body-snapshot GET]', e.message);
    return res.status(500).json({ error: e.message || 'Failed to load snapshots.' });
  }
});

// PATCH /api/me/body/snapshot/:id — update only the shared_with_manager flag.
// Phase 4 contract (locked): the ONLY field accepted here is shared_with_manager.
// Any other field on the request body is silently ignored. Owner-checked.
app.patch('/api/me/body/snapshot/:id', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    var idNum = parseInt(req.params.id, 10);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return res.status(400).json({ error: 'Invalid snapshot id.' });
    }
    var body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'shared_with_manager')) {
      return res.status(400).json({ error: 'shared_with_manager is required.' });
    }
    var raw = body.shared_with_manager;
    var shared;
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') shared = true;
    else if (raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === null) shared = false;
    else return res.status(400).json({ error: 'shared_with_manager must be a boolean.' });

    var existing = await queryOne(
      `SELECT id FROM body_snapshots WHERE id = ? AND user_id = ?`,
      [idNum, req.user.id]
    );
    if (!existing) return res.status(404).json({ error: 'Snapshot not found.' });

    var updated = await queryOne(
      `UPDATE body_snapshots
          SET shared_with_manager = ?
        WHERE id = ? AND user_id = ?
       RETURNING id, user_id, snapshot_date, photo_front, photo_side, photo_back,
                 bodyweight_kg, waist_cm, measurements, notes,
                 shared_with_manager, created_at`,
      [shared, idNum, req.user.id]
    );
    if (!updated) return res.status(404).json({ error: 'Snapshot not found.' });
    return res.json({ ok: true, snapshot: bbBodyRowToJson(updated) });
  } catch (e) {
    console.error('[body-snapshot PATCH]', e.message);
    return res.status(500).json({ error: e.message || 'Failed to update snapshot.' });
  }
});

// GET /api/admin/users/:userId/body/snapshots — admin/manager view.
// Privacy contract (locked): NEVER returns rows where shared_with_manager = FALSE.
app.get('/api/admin/users/:userId/body/snapshots', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    var targetUserId = String(req.params.userId || '').trim();
    if (!targetUserId) return res.status(400).json({ error: 'Invalid user id.' });
    var rows = await queryAll(
      `SELECT id, user_id, snapshot_date, photo_front, photo_side, photo_back,
              bodyweight_kg, waist_cm, measurements, notes,
              shared_with_manager, created_at
         FROM body_snapshots
        WHERE user_id = ? AND shared_with_manager = TRUE
        ORDER BY snapshot_date DESC, id DESC
        LIMIT 200`,
      [targetUserId]
    );
    return res.json({ snapshots: (rows || []).map(bbBodyRowToJson) });
  } catch (e) {
    console.error('[admin body-snapshots GET]', e.message);
    return res.status(500).json({ error: e.message || 'Failed to load shared snapshots.' });
  }
});

app.delete('/api/me/body/snapshot/:id', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'user') return res.status(403).json({ error: 'Only for members' });
    var idNum = parseInt(req.params.id, 10);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return res.status(400).json({ error: 'Invalid snapshot id.' });
    }
    var existing = await queryOne(
      `SELECT id, user_id, photo_front, photo_side, photo_back
         FROM body_snapshots WHERE id = ? AND user_id = ?`,
      [idNum, req.user.id]
    );
    if (!existing) return res.status(404).json({ error: 'Snapshot not found.' });
    await run(`DELETE FROM body_snapshots WHERE id = ? AND user_id = ?`, [idNum, req.user.id]);

    // Best-effort: unlink the on-disk files (only if they live in our upload dir)
    // Phase 5: also unlink the `<ts>-<view>-orig.<ext>` sibling we save alongside
    // the canonical (bg-removed) file. We don't know the original extension, so
    // glob the directory for any file whose basename starts with that prefix.
    var paths = [existing.photo_front, existing.photo_side, existing.photo_back];
    for (var i = 0; i < paths.length; i++) {
      var rel = paths[i];
      if (!rel || typeof rel !== 'string') continue;
      if (rel.indexOf('/uploads/body/') !== 0) continue;
      try {
        var diskPath = path.join(FEED_UPLOADS_DIR, rel.replace(/^\/uploads\//, ''));
        if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
        // Also clean up the preserved original (best-effort).
        var baseName = path.basename(diskPath);
        var dotIdx = baseName.lastIndexOf('.');
        var stem = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
        var dirPath = path.dirname(diskPath);
        if (fs.existsSync(dirPath)) {
          var siblings = fs.readdirSync(dirPath);
          for (var j = 0; j < siblings.length; j++) {
            var nm = siblings[j];
            if (nm.indexOf(stem + '-orig.') === 0) {
              try { fs.unlinkSync(path.join(dirPath, nm)); } catch (_) {}
            }
          }
        }
      } catch (_) { /* best effort */ }
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[body-snapshot DELETE]', e.message);
    return res.status(500).json({ error: e.message || 'Failed to delete snapshot.' });
  }
});

const feedUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 }
    })
  : null;

// Serve legacy uploaded images (existing posts that were saved as files before migration)
// Generated health/progress report PDFs are written under uploads/health-reports.
// The static mount below would otherwise hand any of them to anyone who has the
// filename, with no login and no expiry. Patient reports are only ever served by an
// authenticated route (/api/blood/...) or a revocable share token (/r/blood/...).
app.use('/uploads/health-reports', (req, res) => res.status(404).send('Not found'));
// Assessment attachments are progress photos and lab reports — sensitive personal
// data under DPDP. /uploads is a public static mount, so this directory is closed
// off here and served only through the staff-authenticated route on the router.
app.use('/uploads/nutrition-assessment', (req, res) => res.status(404).send('Not found'));
// Smart scale reports (InBody/decades-scan PDFs, weigh-in screenshots) are health
// data too — closed off from the public static mount, served only via
// /api/smart-scale/file/:id which checks ownership/staff role.
app.use('/uploads/smart-scale', (req, res) => res.status(404).send('Not found'));
app.use('/uploads', express.static(FEED_UPLOADS_DIR, {
  maxAge: NODE_ENV === 'production' ? '7d' : 0
}));

// ── GET /api/feed/image/:id — serve post image from PostgreSQL ──────
app.get('/api/feed/image/:id', async (req, res) => {
  try {
    const row = await queryOne('SELECT image_data, image_mime FROM feed_posts WHERE id = $1', [req.params.id]);
    if (!row || !row.image_data) return res.status(404).send('Not found');
    const data = String(row.image_data);
    const mime = String(row.image_mime || 'image/jpeg');
    // Strip data URL prefix if present, send raw buffer
    const b64 = data.includes(',') ? data.split(',')[1] : data;
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(buf);
  } catch (e) {
    return res.status(500).send('Error');
  }
});

// ── GET /api/public/nutrition-photo/:mealId — signed public URL for Twilio media fetch ──
app.get('/api/public/nutrition-photo/:mealId', async (req, res) => {
  try {
    const mealId = String(req.params.mealId || '').trim();
    const e = String(req.query.e || '').trim();
    const sig = String(req.query.sig || '').trim();
    if (!mealId || !e || !sig) {
      console.warn('[photo-serve] Missing params mealId=%s e=%s sig=%s', mealId, !!e, !!sig);
      return res.status(400).send('Bad request');
    }
    if (!verifyNutritionPhotoLink(mealId, e, sig)) {
      console.warn('[photo-serve] Invalid or expired signature for mealId=%s expiry=%s now=%s', mealId, e, Date.now());
      return res.status(403).send('Forbidden');
    }

    const row = await queryOne(
      'SELECT photo_data, photo_mime FROM nutrition_meal_logs WHERE id = ? LIMIT 1',
      [mealId]
    );
    if (!row || !row.photo_data) {
      console.warn('[photo-serve] No photo found for mealId=%s (purged or missing)', mealId);
      return res.status(404).send('Not found');
    }
    const data = String(row.photo_data || '');
    const mime = String(row.photo_mime || 'image/jpeg');
    const b64 = data.includes(',') ? data.split(',')[1] : data;
    const buf = Buffer.from(b64, 'base64');
    // dl=1 → force a real file download (used by the admin "Download image" button).
    // Top-level navigation to an attachment response is the only reliable way to
    // save an image on iOS Safari, which ignores the download attr on data: URIs.
    const wantsDownload = /^(1|true|yes)$/i.test(String(req.query.dl || req.query.download || ''));
    // WhatsApp / Twilio hard limit is 5 MB for images — inline (Twilio) fetch only.
    // Admin downloads are exempt so large meal photos still save correctly.
    if (!wantsDownload && buf.length > 5 * 1024 * 1024) {
      console.warn('[photo-serve] Photo too large for Twilio: %d bytes for mealId=%s', buf.length, mealId);
      return res.status(413).send('Photo too large');
    }
    const ext = mime.indexOf('png') > -1 ? 'png' : mime.indexOf('webp') > -1 ? 'webp' : 'jpg';
    console.log('[photo-serve] Serving photo mealId=%s size=%d mime=%s dl=%s', mealId, buf.length, mime, wantsDownload);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', buf.length);
    if (wantsDownload) {
      const fnRaw = String(req.query.fn || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
      const filename = (fnRaw || `meal-${mealId}`) + '.' + ext;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
    return res.send(buf);
  } catch (err) {
    console.error('[photo-serve] Error for mealId=%s:', req.params.mealId, err.message);
    return res.status(500).send('Error');
  }
});

// ── GET /api/feed/posts ─────────────────────────────────────────────
app.get('/api/feed/posts', async (req, res) => {
  try {
    const limitRaw  = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 24) : 10;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const countRow = await queryOne('SELECT COUNT(*)::int AS total FROM feed_posts', []);
    const total = (countRow && countRow.total) ? Number(countRow.total) : 0;
    const rows = await queryAll(
      'SELECT id, username, caption, image_mime, likes, featured, created_at FROM feed_posts ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return res.json({
      posts: rows.map(feedRowToPost),
      hasMore: offset + limit < total,
      total
    });
  } catch (e) {
    console.error('[feed] GET /posts error:', e.message);
    return res.status(500).json({ error: 'Failed to load feed posts.' });
  }
});

// ── GET /api/feed/user-posts ────────────────────────────────────────
app.get('/api/feed/user-posts', async (req, res) => {
  try {
    const username = String(req.query.username || '').trim().toLowerCase();
    let rows;
    if (username) {
      rows = await queryAll(
        'SELECT id, username, caption, image_mime, likes, featured, created_at FROM feed_posts WHERE LOWER(username) = $1 ORDER BY created_at DESC',
        [username]
      );
    } else {
      rows = await queryAll(
        'SELECT id, username, caption, image_mime, likes, featured, created_at FROM feed_posts ORDER BY created_at DESC',
        []
      );
    }
    return res.json({ posts: rows.map(feedRowToPost) });
  } catch (e) {
    console.error('[feed] GET /user-posts error:', e.message);
    return res.status(500).json({ error: 'Failed to load user posts.' });
  }
});

// ── POST /api/feed/upload ───────────────────────────────────────────
app.post('/api/feed/upload', verifyToken, feedUpload ? feedUpload.single('image') : (req, _res, next) => next(), async (req, res) => {
  try {
    const caption  = String(req.body?.caption  || '').trim().slice(0, 240);
    // The poster is the authenticated user. A client-supplied username used to be
    // accepted verbatim, so an anonymous caller could post to the public feed under
    // any member's name. `featured` is an editorial flag and is staff-only.
    const isStaff = ['admin', 'superadmin'].includes(req.user.role);
    const owner = await queryOne('SELECT id, first_name, email FROM users WHERE id = ?', [req.user.id]);
    if (!owner) return res.status(401).json({ error: 'Authentication required' });
    const username = String(owner.first_name || owner.email || 'bodybank_member')
      .trim().slice(0, 32) || 'bodybank_member';
    const featured = isStaff && String(req.body?.featured || '') === '1';
    let imageData = '', imageMime = 'image/jpeg';

    // Image validation failures are the caller's fault, not a server fault: report
    // them as 400 rather than letting them fall through to the 500 handler (which
    // also echoed the raw exception message back to the client).
    try {
      if (req.file && req.file.buffer && req.file.buffer.length) {
        const parsed = bufferToFeedDataUrl(req.file.buffer, req.file.originalname);
        imageData = parsed.imageData;
        imageMime = parsed.imageMime;
      } else if (req.body && req.body.imageData) {
        const parsed = parseFeedImageInput(req.body.imageData);
        imageData = parsed.imageData;
        imageMime = parsed.imageMime;
      } else {
        return res.status(400).json({ error: 'Image is required (multipart "image" or base64 imageData).' });
      }
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    const id = uuidv4();
    const likes = Math.floor(Math.random() * 70) + 12;
    await pool.query(
      `INSERT INTO feed_posts (id, user_id, username, caption, image_data, image_mime, likes, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.user.id, username, caption || 'BodyBank.fit transformation in progress.', imageData, imageMime, likes, featured]
    );
    const post = feedRowToPost({ id, username, caption, image_mime: imageMime, likes, featured, created_at: new Date().toISOString() });
    notifyAsync('FEED_POST_UPLOADED', { username, caption });
    return res.status(201).json({ ok: true, post, imageUrl: post.imageUrl });
  } catch (e) {
    console.error('[feed] POST /upload error:', e.message);
    return res.status(500).json({ error: e.message || 'Upload failed.' });
  }
});

// ── POST /api/feed/delete ───────────────────────────────────────────
app.post('/api/feed/delete', verifyToken, async (req, res) => {
  try {
    const postId = String(req.body?.postId || '').trim();
    if (!postId) return res.status(400).json({ error: 'postId is required.' });

    const row = await queryOne('SELECT id, user_id, username FROM feed_posts WHERE id = $1', [postId]);
    if (!row) return res.status(404).json({ error: 'Post not found.' });

    // Ownership comes from the session, never from the request body. The previous
    // check compared against a username the caller supplied — and the feed listing
    // hands out every post's username, so any post could be deleted by anyone.
    const isStaff = ['admin', 'superadmin'].includes(req.user.role);
    const ownsPost = row.user_id && String(row.user_id) === String(req.user.id);
    if (!isStaff && !ownsPost) {
      return res.status(403).json({ error: 'You can delete only your own posts.' });
    }
    await pool.query('DELETE FROM feed_posts WHERE id = $1', [postId]);
    return res.json({ ok: true, removedId: postId });
  } catch (e) {
    console.error('[feed] POST /delete error:', e.message);
    return res.status(500).json({ error: 'Failed to delete post.' });
  }
});

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  // Oversized body (large blood-report upload) or aborted request — user/client
  // caused, not a server fault. Return a clear message; do NOT fire the noisy alert.
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
    return res.status(413).json({
      success: false,
      error: 'File is too large. Please upload a report under ~22 MB (compress or split scanned PDFs).'
    });
  }
  if (err && (err.type === 'request.aborted' || err.code === 'ECONNABORTED')) {
    return res.status(400).json({ success: false, error: 'Upload was interrupted. Please try again on a stable connection.' });
  }
  notifyAsync('SERVER_ERROR', { action: `${req.method} ${req.originalUrl}`, error: err.message }, { noDedup: false });
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[unhandledRejection]', msg);
  notifyAsync('SERVER_ERROR', { action: 'process.unhandledRejection', error: msg });
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
  notifyAsync('SERVER_ERROR', { action: 'process.uncaughtException', error: err.message });
});

// ============ START ============
// Listen first so Render health check passes; initDB runs in background
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏋️ BodyBank Server listening on port ${PORT}`);
  initDB().then(async () => {
    console.log(`✅ DB ready | Admin: ${ADMIN_EMAIL} | Superadmin: ${SUPERADMIN_EMAIL}`);
    const resetBase = RESET_BASE_URL || '(from request)';
    console.log(`🔐 Forgot password: /api/auth/forgot-password | Reset link base: ${resetBase} | Push: ${VAPID_PUBLIC && VAPID_PRIVATE ? 'On' : 'Off'} | Member emails: ${userEmail.isConfigured() ? 'On (SMTP + reminders/digests)' : 'Off (set SMTP_*)'} | Env: ${NODE_ENV}\n`);
    // Start campaign scheduler only when enabled via environment
    if (CAMPAIGNS_ENABLED) {
      await startCampaignScheduler({ queryAll, run, sendPushToUser, uuidv4 })
        .catch(e => console.error('❌ Campaign scheduler failed to start:', e.message));
    } else {
      console.log('⏸ Campaign scheduler is ON HOLD (CAMPAIGNS_ENABLED=false)');
    }

    startEmailScheduler({ queryAll });

    try {
      cron.schedule(
        '0 8 * * 0',
        () => {
          runWeeklyNutritionEmailJob({ queryAll, queryOne, run }).catch((e) =>
            console.warn('[nutrition] Weekly cron error:', e.message)
          );
        },
        { timezone: 'Asia/Kolkata' }
      );
      console.log('✅ Nutrition weekly email cron scheduled (Sun 08:00 Asia/Kolkata)');
    } catch (e) {
      console.warn('Nutrition cron schedule skipped:', e.message);
    }

    try {
      cron.schedule(
        '0 8 * * *',
        () => {
          runAdminNutritionDailyEmailJob({
            queryAll,
            adminEmail: NUTRITION_ADMIN_REPORT_EMAIL
          }).catch((e) => console.warn('[nutrition] Admin daily digest cron error:', e.message));
        },
        { timezone: 'Asia/Kolkata' }
      );
      console.log(`✅ Nutrition admin daily digest cron scheduled (Daily 08:00 Asia/Kolkata -> ${NUTRITION_ADMIN_REPORT_EMAIL || 'not set'})`);
    } catch (e) {
      console.warn('Nutrition admin daily digest cron schedule skipped:', e.message);
    }

    try {
      cron.schedule(
        '10 0 * * *',
        () => {
          coinService
            .runDailyCoinPenaltyJob({ queryAll, queryOne, run })
            .catch((e) => console.warn('[coins] Daily penalty cron error:', e.message));
        },
        { timezone: 'Asia/Kolkata' }
      );
      console.log('✅ Coin penalty cron scheduled (Daily 00:10 Asia/Kolkata)');
    } catch (e) {
      console.warn('Coin penalty cron schedule skipped:', e.message);
    }

    // ── Membership lifecycle — expire lapsed members, remind expiring, push admin call queue ──
    try {
      cron.schedule(
        '30 8 * * *',
        () => {
          runMembershipLifecycleJob()
            .then((r) => console.log(`[memberships] Lifecycle ran — expired ${r.expired}, expiring soon ${r.expiring_soon}`))
            .catch((e) => console.warn('[memberships] Lifecycle cron error:', e.message));
        },
        { timezone: 'Asia/Kolkata' }
      );
      console.log('✅ Membership lifecycle cron scheduled (Daily 08:30 Asia/Kolkata)');
    } catch (e) {
      console.warn('Membership lifecycle cron schedule skipped:', e.message);
    }

    // ── Daily executive WhatsApp digest — 09:00 IST ──────────────────
    try {
      cron.schedule(
        '0 9 * * *',
        async () => {
          try {
            const { notifyAsync: _na } = require('./utils/notify');
            const today = new Date();
            const ymd = today.toISOString().slice(0, 10);
            const yesterday = new Date(today - 86400000).toISOString().slice(0, 10);

            const [
              usersRow,
              signupsRow,
              checkinsRow,
              workoutsRow,
              mealsRow,
              bloodRow,
              messagesRow,
              coinsRow
            ] = await Promise.all([
              queryOne(`SELECT COUNT(*) AS n FROM users WHERE role='user' AND COALESCE(approval_status,'approved')='approved' AND COALESCE(suspended,FALSE)=FALSE`),
              queryOne(`SELECT COUNT(*) AS n FROM users WHERE role='user' AND DATE(created_at AT TIME ZONE 'Asia/Kolkata') = ?::date`, [yesterday]),
              queryOne(`SELECT COUNT(*) AS n FROM daily_checkins WHERE checkin_date = ?::date`, [yesterday]),
              queryOne(`SELECT COUNT(*) AS n FROM workout_logs WHERE DATE(created_at AT TIME ZONE 'Asia/Kolkata') = ?::date`, [yesterday]),
              queryOne(`SELECT COUNT(*) AS n FROM nutrition_meal_logs WHERE log_date = ?::date`, [yesterday]),
              queryOne(`SELECT COUNT(*) AS n FROM blood_analysis_reports WHERE DATE(created_at AT TIME ZONE 'Asia/Kolkata') = ?::date`, [yesterday]),
              queryOne(`SELECT COUNT(*) AS n FROM thread_messages WHERE sender_role='user' AND DATE(created_at AT TIME ZONE 'Asia/Kolkata') = ?::date`, [yesterday]),
              queryOne(`SELECT COALESCE(SUM(coins_delta),0) AS n FROM coin_ledger WHERE coins_delta > 0 AND DATE(created_at AT TIME ZONE 'Asia/Kolkata') = ?::date`, [yesterday])
            ]).catch(() => Array(8).fill({ n: '—' }));

            const digestDate = new Date(yesterday + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

            _na('DAILY_DIGEST', {
              date          : digestDate,
              totalUsers    : usersRow    && usersRow.n    != null ? usersRow.n    : '—',
              signups       : signupsRow  && signupsRow.n  != null ? signupsRow.n  : '—',
              logins        : '—',
              checkins      : checkinsRow && checkinsRow.n != null ? checkinsRow.n : '—',
              workouts      : workoutsRow && workoutsRow.n != null ? workoutsRow.n : '—',
              meals         : mealsRow    && mealsRow.n    != null ? mealsRow.n    : '—',
              bloodReports  : bloodRow    && bloodRow.n    != null ? bloodRow.n    : '—',
              messages      : messagesRow && messagesRow.n != null ? messagesRow.n : '—',
              coinsAwarded  : coinsRow    && coinsRow.n    != null ? coinsRow.n    : '—'
            }, { noDedup: true });
            console.log('[digest] Daily WhatsApp digest sent for', yesterday);
          } catch (e) {
            console.warn('[digest] Daily digest cron error:', e.message);
          }
        },
        { timezone: 'Asia/Kolkata' }
      );
      console.log('✅ Daily WhatsApp executive digest cron scheduled (Daily 09:00 Asia/Kolkata)');
    } catch (e) {
      console.warn('Daily digest cron schedule skipped:', e.message);
    }

    try {
      cron.schedule(
        '*/15 * * * *',
        () => {
          waInbound.runSchedulerTick().catch((e) =>
            console.warn('[wa-inbound] scheduler error:', e.message)
          );
        },
        { timezone: 'Asia/Kolkata' }
      );
      console.log('✅ WhatsApp inbound scheduler cron (every 15 min Asia/Kolkata; draft flush + no_activity_3d stub)');
    } catch (e) {
      console.warn('WhatsApp inbound scheduler cron skipped:', e.message);
    }
  }).catch(err => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
});
