require('dotenv').config();
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
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
const { signToken, verifyToken, requireAdmin, requireSuperadmin, requireAdminOrSuperadmin, signProgressReportToken, verifyProgressReportToken, signShareToken, verifyShareToken, signPdfAccessToken, verifyPdfAccessToken, verifyAppleIdentityToken } = require('./middleware/auth');
const { safeExtraHttpHeaders, optionalApiAccessLog } = require('./middleware/safeSecurityLayers');
const progressRoutes = require('./routes/progress');
const { createNutritionRouter, runWeeklyNutritionEmailJob, runAdminNutritionDailyEmailJob } = require('./routes/nutrition');
const { createBloodRouter } = require('./routes/blood');
const { createMarketingAIRouter } = require('./routes/marketingAI');
const cron = require('node-cron');
const { getUserProgress: getAdminUserProgress } = require('./controllers/adminProgressController');
const progressService = require('./services/progressService');
const workoutSessionLifts = require('./services/workoutSessionLifts');
const { recomputeDailyStats: recomputeNutritionDailyStats } = require('./services/nutritionService');
const { inferTimezoneFromCountry, getUserTimezone } = require('./utils/timezone');
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
const coinService = require('./services/coinService');
const { notify, notifyAsync, formatEventMessage } = require('./utils/notify');
const { sendWhatsApp, sendWhatsAppTemplate } = require('./services/whatsapp');
const { verifyToken: verifyNutritionPhotoLink } = require('./utils/nutritionPhotoLink');
const { startEmailScheduler, getAdminDailyComplianceReportData, sendAdminDailyComplianceReport } = require('./services/emailScheduler');
const {
  toDateStr: streakDateToYmd,
  computeStreakState,
  todayYmdInTz: streakTodayYmdInTz,
  STREAK_TZ: STREAK_TIMEZONE
} = require('./services/streakService');

// ============ CONFIG ============
const PORT = process.argv[2] || process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bodybank.fit';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@bodybank.fit';
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'superadmin123';
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
const RESET_BASE_URL = (process.env.RESET_BASE_URL || process.env.APP_BASE_URL || process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '') || (NODE_ENV === 'production' ? '' : `http://localhost:${PORT}`);
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const SMTP_FROM = (process.env.SMTP_FROM || 'BodyBank <noreply@bodybank.fit>').trim();
const NUTRITION_ADMIN_REPORT_EMAIL = (process.env.NUTRITION_ADMIN_REPORT_EMAIL || ADMIN_EMAIL || '').trim();
const CAMPAIGNS_ENABLED = String(process.env.CAMPAIGNS_ENABLED || 'false').trim().toLowerCase() === 'true';
const FEED_UPLOADS_DIR = path.join(__dirname, 'uploads');

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

async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[Push] Skipped: VAPID keys not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in env.');
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
    const admins = await queryAll("SELECT id FROM users WHERE role IN ('admin', 'superadmin')");
    for (const a of admins) {
      await sendPushToUser(a.id, payload);
    }
  } catch (e) { /* ignore */ }
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
app.use(express.json({ limit: '20mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(safeExtraHttpHeaders);

// Simple rate limiter (in-memory)
const rateLimit = {};
function rateLimiter(limit, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    if (!rateLimit[key]) rateLimit[key] = [];
    rateLimit[key] = rateLimit[key].filter(t => now - t < windowMs);
    if (rateLimit[key].length >= limit) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    rateLimit[key].push(now);
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

function parseFeedImageInput(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  if (!match) throw new Error('Provide a valid PNG/JPEG/WEBP base64 image.');
  const mime = match[1].toLowerCase() === 'jpg' ? 'image/jpeg'
             : match[1].toLowerCase() === 'jpeg' ? 'image/jpeg'
             : match[1].toLowerCase() === 'png'  ? 'image/png'
             : 'image/webp';
  return { imageData: dataUrl, imageMime: mime };
}

function bufferToFeedDataUrl(buffer, originalName) {
  const ext = String(path.extname(originalName || '') || '.jpg').toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
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

  // Create admin (in production, require ADMIN_PASS to be set and not default)
  if (NODE_ENV === 'production' && (!process.env.ADMIN_PASS || ADMIN_PASS === 'admin123')) {
    console.warn('⚠️ Production: set ADMIN_PASS in .env to a strong password. Default admin password is not allowed.');
  }
  const adminRow = await queryOne("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!adminRow) {
    if (NODE_ENV === 'production' && ADMIN_PASS === 'admin123') {
      console.error('❌ Refusing to create admin with default password in production. Set ADMIN_PASS in .env and restart.');
    } else {
      const hash = bcrypt.hashSync(ADMIN_PASS, 10);
      const adminEmailNorm = String(ADMIN_EMAIL).trim().toLowerCase();
      await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), adminEmailNorm, hash, 'Body', 'Bank', 'admin', 'approved']);
      console.log(`✅ Admin created: ${ADMIN_EMAIL}`);
    }
  }

  if (NODE_ENV === 'production' && (!process.env.SUPERADMIN_PASS || SUPERADMIN_PASS === 'superadmin123')) {
    console.warn('⚠️ Production: set SUPERADMIN_PASS in .env to a strong password. Default superadmin password is not allowed.');
  }
  const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
  const canSyncSuperadmin = superadminEmailNorm && superadminPassTrimmed && (NODE_ENV !== 'production' || superadminPassTrimmed !== 'superadmin123');
  // Sync uses trimmed password so Render env vars with accidental newlines/spaces still work
  if (canSyncSuperadmin) {
    const hash = bcrypt.hashSync(superadminPassTrimmed, 10);
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
    if (!existingSa && NODE_ENV === 'production' && (!process.env.SUPERADMIN_PASS || SUPERADMIN_PASS === 'superadmin123')) {
      console.error('❌ Refusing to create superadmin with default password in production. Set SUPERADMIN_EMAIL and SUPERADMIN_PASS in Render and redeploy.');
    } else if (!existingSa && (!process.env.SUPERADMIN_EMAIL || !superadminEmailNorm)) {
      console.warn('⚠️ Superadmin not created: set SUPERADMIN_EMAIL and SUPERADMIN_PASS in env.');
    }
  }

  // Apple App Store reviewer demo account — pre-approved so the reviewer can sign in
  // past the admin-approval gate. Provide the same creds in App Store Connect → App
  // Review Information. No-op if APPLE_REVIEW_EMAIL / APPLE_REVIEW_PASS are unset.
  try {
    const revEmail = String(APPLE_REVIEW_EMAIL || '').trim().toLowerCase();
    const revPass  = String(APPLE_REVIEW_PASS  || '').trim();
    if (revEmail && revPass) {
      const hash = bcrypt.hashSync(revPass, 10);
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

app.get('/api/debug-reset-setup', (req, res) => {
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
  const hash = bcrypt.hashSync(superadminPassTrimmed, 10);
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

    // Fallback: if login is with Superadmin@gmail.com / Bodybank@2026, ensure superadmin exists and log in (works even if env vars are wrong or missing on Render)
    const FALLBACK_SA_EMAIL = 'superadmin@gmail.com';
    const FALLBACK_SA_PASS = 'Bodybank@2026';
    const isFallbackCreds = emailNorm === FALLBACK_SA_EMAIL && pwTrimmed === FALLBACK_SA_PASS;

    let user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      if (isFallbackCreds) {
        const hash = bcrypt.hashSync(FALLBACK_SA_PASS, 10);
        const existingSa = await queryOne("SELECT id FROM users WHERE role='superadmin' LIMIT 1");
        if (existingSa) {
          await run("UPDATE users SET email = ?, password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE role = 'superadmin'", [FALLBACK_SA_EMAIL, hash]);
        } else {
          await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [uuidv4(), FALLBACK_SA_EMAIL, hash, 'Super', 'Admin', 'superadmin', 'approved']);
        }
        user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
      } else {
        const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
        const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
        if (superadminEmailNorm && superadminPassTrimmed && emailNorm === superadminEmailNorm && pwTrimmed === superadminPassTrimmed) {
          await runSuperadminSync();
          user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
        }
      }
      if (!user) {
        if (NODE_ENV !== 'production') console.log('[Login] User not found:', emailNorm);
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
    if (!user.password || !bcrypt.compareSync(pwTrimmed, user.password)) {
      if (isFallbackCreds) {
        const hash = bcrypt.hashSync(FALLBACK_SA_PASS, 10);
        await run("UPDATE users SET role = 'superadmin', password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE LOWER(email) = ?", [hash, emailNorm]);
        await run("UPDATE users SET role = 'user' WHERE role = 'superadmin' AND LOWER(email) != ?", [emailNorm]);
        user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
      } else {
        const superadminEmailNorm = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
        const superadminPassTrimmed = String(SUPERADMIN_PASS || '').trim();
        if (superadminEmailNorm && superadminPassTrimmed && emailNorm === superadminEmailNorm && pwTrimmed === superadminPassTrimmed) {
          await runSuperadminSync();
          user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
        }
      }
      if (!user || !bcrypt.compareSync(pwTrimmed, user.password)) {
        if (NODE_ENV !== 'production') console.log('[Login] Password mismatch for:', emailNorm);
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }

    await syncUserCountryAndTimezone(user.id, user.email);
    user = await queryOne("SELECT * FROM users WHERE id = ?", [user.id]);
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
app.post('/api/auth/google', async (req, res) => {
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
    const hash = bcrypt.hashSync(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, profile_picture, country, timezone, state_province, city, dob, gender, height_cm, role, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, emailNorm, hash, given_name || '', family_name || '', phoneTrimmed, picture || '', geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, 'user', 'pending']);
    sendPushToAdmins(JSON.stringify({ title: 'New sign-up (Google)', body: `${given_name || ''} ${family_name || ''} (${emailNorm}) requested access`, id: 'signup-' + id })).catch(() => {});
    userEmail.emailGoogleSignupPending(emailNorm, given_name);
    notifyAsync('USER_SIGNUP_GOOGLE', { name: `${given_name || ''} ${family_name || ''}`.trim(), email: emailNorm, phone: phoneTrimmed || '—', country: geo.country || '—' });
    res.json({
      id, email: emailNorm, first_name: given_name || '', last_name: family_name || '', role: 'user',
      country: geo.country, timezone: geo.timezone, pending_approval: true,
      message: 'Your account has been created and is pending admin approval.'
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
app.post('/api/auth/apple', async (req, res) => {
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
    const hash = bcrypt.hashSync(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, apple_id, country, timezone, state_province, city, dob, gender, height_cm, role, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, emailNorm, hash, givenName, familyName, phoneTrimmed, appleSub, geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, 'user', 'pending']);
    sendPushToAdmins(JSON.stringify({ title: 'New sign-up (Apple)', body: `${givenName} ${familyName} (${emailNorm}) requested access`, id: 'signup-' + id })).catch(() => {});
    try { userEmail.emailSignupPending(emailNorm, givenName); } catch (_) {}
    notifyAsync('USER_SIGNUP', { name: `${givenName} ${familyName}`.trim(), email: emailNorm, phone: phoneTrimmed || '—', country: geo.country || '—' });
    res.json({
      id, email: emailNorm, first_name: givenName, last_name: familyName, role: 'user',
      country: geo.country, timezone: geo.timezone, pending_approval: true,
      message: 'Your account has been created and is pending admin approval.'
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
      const hash = bcrypt.hashSync(password, 10);
      await run("UPDATE users SET password=?, first_name=?, last_name=?, phone=?, country=?, timezone=?, state_province=?, city=?, dob=?, gender=?, height_cm=?, approval_status='pending' WHERE id=?",
        [hash, first_name || '', last_name || '', phone || '', geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, existing.id]);
      userEmail.emailSignupPending(emailNorm, first_name);
      return res.json({ id: existing.id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user', country: geo.country, timezone: geo.timezone, pending_approval: true });
    }
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, country, timezone, state_province, city, dob, gender, height_cm, approval_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, emailNorm, hash, first_name || '', last_name || '', phone || '', geo.country, geo.timezone, cleanState, cleanCity, cleanDob, cleanGender, heightParsed, 'pending']);
    sendPushToAdmins(JSON.stringify({ title: 'New sign-up', body: `${first_name || ''} ${last_name || ''} (${emailNorm}) requested access`, id: 'signup-' + id })).catch(() => {});
    userEmail.emailSignupPending(emailNorm, first_name);
    notifyAsync('USER_SIGNUP', { name: `${first_name || ''} ${last_name || ''}`.trim(), email: emailNorm, phone: phone || '—', country: geo.country || '—' });
    res.json({ id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user', country: geo.country, timezone: geo.timezone, pending_approval: true });
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
    await run("INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)", [id, user.id, token, expiresAt]);

    let base = RESET_BASE_URL || (req.protocol + '//' + (req.get('host') || req.get('x-forwarded-host') || 'localhost:3000'));
    base = String(base).trim().replace(/\/$/, '');
    if (NODE_ENV === 'production' && base.startsWith('http://')) base = 'https://' + base.slice(7);
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
      "SELECT pr.id, pr.used, pr.expires_at, u.role FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token = ?",
      [token]
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
      "SELECT pr.id, pr.user_id, pr.used, pr.expires_at, u.role, u.password, u.email, u.first_name, u.last_name, u.profile_picture, u.country, u.timezone, u.height_cm FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token = ?",
      [token]
    );
    if (!row || row.used) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (row.role !== 'user') return res.status(400).json({ error: 'Invalid or expired reset token' });

    if (row.password && bcrypt.compareSync(pw, row.password)) {
      return res.status(400).json({ error: 'You cannot use the same password as your previous one. Please choose a different password.' });
    }

    const hash = bcrypt.hashSync(pw, 10);
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

app.get('/api/audit', async (req, res) => {
  const rows = await queryAll("SELECT * FROM audit_requests ORDER BY created_at DESC");
  res.json(rows);
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

app.get('/api/audit/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM audit_requests WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.put('/api/audit/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await run("UPDATE audit_requests SET status = ? WHERE id = ?", [status, req.params.id]);
  res.json({ message: 'Updated' });
});

app.delete('/api/audit/:id', async (req, res) => {
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
    res.json({ id, message: 'Form submitted successfully', result: result || null });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/audit-result/:part2_id', async (req, res) => {
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

app.get('/api/part2', async (req, res) => {
  const rows = await queryAll("SELECT * FROM part2_audit ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/part2/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM part2_audit WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.delete('/api/part2/:id', async (req, res) => {
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

    // Roll the matching audit_requests row forward to "call_proposed" so the admin pipeline reflects it.
    try {
      await run(
        `UPDATE audit_requests
         SET stage = 'call_proposed', stage_changed_at = NOW(), call_scheduled_at = NOW(), last_contact_at = NOW()
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

    res.json({ id, ok: true, message: 'Call scheduled successfully' });
  } catch (e) {
    console.error('[schedule-call] POST error:', e.message);
    res.status(500).json({ error: 'Failed to schedule call' });
  }
});

// ============ MEETINGS (Schedule a Call) ============
app.post('/api/meetings', rateLimiter(10, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.user_id || !b.meeting_date || !b.time_slot) {
      return res.status(400).json({ error: 'User, date and time slot required' });
    }

    const id = uuidv4();
    await run(`INSERT INTO meetings (id, user_id, user_name, user_email, user_phone, meeting_date, time_slot, status, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.user_id, b.user_name||'', b.user_email||'', b.user_phone||'', b.meeting_date, b.time_slot, 'scheduled', b.notes||'']);
    if (b.user_email && String(b.user_email).trim()) {
      const dn = b.meeting_date ? new Date(b.meeting_date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : String(b.meeting_date || '');
      userEmail.emailMeetingScheduled(String(b.user_email).trim(), (b.user_name || '').split(/\s+/)[0] || 'there', dn, b.time_slot || '');
    }
    notifyAsync('MEETING_SCHEDULED', { name: b.user_name || '—', email: b.user_email || '—', mobile: b.user_phone || '—', date: b.meeting_date || '—', slot: b.time_slot || '—' });
    res.json({ id, message: 'Call scheduled successfully' });
  } catch (e) {
    console.error('[meetings] POST error:', e.message);
    res.status(500).json({ error: e.message || 'Failed to schedule call' });
  }
});

app.get('/api/meetings', async (req, res) => {
  const rows = await queryAll("SELECT * FROM meetings WHERE status='scheduled' ORDER BY meeting_date ASC, time_slot ASC");
  res.json(rows);
});

app.get('/api/meetings/user/:userId', async (req, res) => {
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

app.put('/api/meetings/:id', async (req, res) => {
  const { meeting_date, time_slot, status } = req.body || {};
  const row = await queryOne("SELECT * FROM meetings WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const values = [];
  if (meeting_date !== undefined) { updates.push('meeting_date=?'); values.push(meeting_date); }
  if (time_slot !== undefined) { updates.push('time_slot=?'); values.push(time_slot); }
  if (status !== undefined) { updates.push('status=?'); values.push(status); }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });

  values.push(req.params.id);
  await run(`UPDATE meetings SET ${updates.join(',')} WHERE id=?`, values);
  res.json({ message: 'Updated' });
});

// ============ TRIBE MEMBERS ============
app.get('/api/tribe', async (req, res) => {
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

app.get('/api/tribe/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM tribe_members WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/tribe', async (req, res) => {
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

app.put('/api/tribe/:id', async (req, res) => {
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

app.delete('/api/tribe/:id', async (req, res) => {
  await run("DELETE FROM tribe_members WHERE id = ?", [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ============ USER PROFILE ============
app.get('/api/profile/:id', async (req, res) => {
  const user = await queryOne("SELECT id,email,first_name,last_name,phone,country,state_province,city,dob,gender,height_cm,goal_type,primary_training_days_per_week,diet_type,injury_limitations,stress_level_baseline,timezone,profile_picture,role,created_at FROM users WHERE id=?", [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.put('/api/profile/:id', async (req, res) => {
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
app.post('/api/workouts', async (req, res) => {
  try {
    const { user_id, workout_name, duration_seconds, feedback } = req.body || {};
    if (!user_id || !workout_name) return res.status(400).json({ error: 'User and workout name required' });
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
    await run(
      `INSERT INTO workout_logs (
        id, user_id, workout_name, duration_seconds, feedback,
        session_date, workout_type, session_lifts, bench_kg, squat_kg, deadlift_kg,
        weight_kg, body_fat_percent, calories, protein_g, water_liters, sleep_hrs,
        workout_completed, intensity, energy_level
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        userId,
        workoutType,
        Number.isFinite(dur) ? dur : 0,
        notes,
        date,
        workoutType,
        sessionLiftsForDb,
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
    if (wu) notifyAsync('WORKOUT_LOGGED', { name: `${wu.first_name || ''}`.trim(), email: wu.email, mobile: wu.phone || '—', type: workoutType, duration: Number.isFinite(dur) ? Math.round(dur / 60) + ' min' : '—' });
    res.json({ id, message: 'Session saved' });
  } catch (e) {
    console.error('Workout session error:', e.message);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// Admin: get all workouts (must be before :userId to avoid conflict)
app.get('/api/workouts', async (req, res) => {
  const rows = await queryAll(`SELECT w.*, u.first_name, u.last_name, u.email 
    FROM workout_logs w JOIN users u ON w.user_id = u.id 
    ORDER BY w.created_at DESC LIMIT 100`);
  res.json(rows);
});

app.get('/api/workouts/:userId', async (req, res) => {
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
    res.json({ id, message: 'Message sent' });
  } catch (e) {
    console.error('Contact error:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/api/contact', async (req, res) => {
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
      sendPushToUser(thread.user_id, JSON.stringify({ type: 'coach_reply', title: 'Lifestyle Manager replied', body: String(body).trim().slice(0, 100), id: 'chat-' + msgId })).catch(() => {});
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

app.post('/api/sunday-checkin', rateLimiter(10, 60000), async (req, res) => {
  try {
    const b = req.body || {};
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
    res.json({ id, message: 'Sunday check-in submitted successfully' });
  } catch (e) {
    console.error('Sunday check-in error:', e.message);
    res.status(500).json({ error: 'Failed to submit check-in' });
  }
});

app.get('/api/sunday-checkin', async (req, res) => {
  const rows = await queryAll("SELECT id, full_name, reply_email, created_at FROM sunday_checkins ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/sunday-checkin/last-weight/:userId', async (req, res) => {
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

app.get('/api/sunday-checkin/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM sunday_checkins WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ============ DAILY CHECK-IN (micro-goals: steps, water, protein, sleep) ============
// DB stores water_ml; API accepts water_liters (preferred) or legacy water_ml; responses include water_liters.
function waterMlFromDailyBody(body) {
  const b = body || {};
  if (b.water_liters != null && b.water_liters !== '') {
    const L = parseFloat(String(b.water_liters).replace(/,/g, ''));
    if (!Number.isFinite(L) || L < 0 || L > 25) return null;
    return Math.round(L * 1000);
  }
  if (b.water_ml != null && b.water_ml !== '') {
    const ml = parseInt(String(b.water_ml).replace(/,/g, ''), 10);
    if (!Number.isFinite(ml) || ml < 0) return null;
    return ml;
  }
  return null;
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
    const { steps, protein_g, sleep_hours } = b;
    const waterMl = waterMlFromDailyBody(b);
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
    res.json(attachWaterLitersToDailyRow(row) || attachWaterLitersToDailyRow({ id, user_id: userId, checkin_date: today, steps, water_ml: waterMl, protein_g, sleep_hours }));
  } catch (e) {
    console.error('Daily check-in error:', e.message);
    res.status(500).json({ error: 'Failed to save check-in' });
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

app.get('/api/daily-checkin/streak', verifyToken, async (req, res) => {
  try {
    const _uRow = await queryOne('SELECT created_at, timezone FROM users WHERE id = ?', [req.user.id]);
    const _uTz = (_uRow && _uRow.timezone) ? _uRow.timezone : STREAK_TIMEZONE;
    const rows = await queryAll(
      `SELECT checkin_date, steps, water_ml, protein_g, sleep_hours FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365`,
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
    const weekData = rows.filter(r => new Date(r.checkin_date) >= weekStart);
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

app.get('/api/admin/daily-checkins', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
  try {
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    let sql = `SELECT dc.id, dc.user_id, dc.checkin_date, dc.steps, dc.water_ml, dc.protein_g, dc.sleep_hours, dc.created_at,
              u.first_name, u.last_name, u.email
       FROM daily_checkins dc
       LEFT JOIN users u ON u.id = dc.user_id
       WHERE 1=1`;
    const params = [];
    if (from) { sql += ` AND dc.checkin_date >= ?`; params.push(from); }
    if (to) { sql += ` AND dc.checkin_date <= ?`; params.push(to); }
    if (search) {
      const q = '%' + search.replace(/%/g, '\\%') + '%';
      sql += ` AND (u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.email ILIKE ?)`;
      params.push(q, q, q);
    }
    sql += ` ORDER BY dc.checkin_date DESC, dc.created_at DESC LIMIT 250`;
    const rows = await queryAll(sql, params);
    res.json(rows.map((r) => attachWaterLitersToDailyRow(r)));
  } catch (e) {
    console.error('Admin daily check-ins list error:', e.message);
    res.status(500).json({ error: 'Failed to load daily check-ins' });
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
    if (search) {
      const q = '%' + search.replace(/%/g, '\\%') + '%';
      sql +=
        ' AND (first_name ILIKE ? OR last_name ILIKE ? OR email ILIKE ? OR (COALESCE(first_name,\'\') || \' \' || COALESCE(last_name,\'\')) ILIKE ?)';
      params.push(q, q, q, q);
    }
    sql += ' ORDER BY created_at DESC LIMIT 250';
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
         u.first_name, u.last_name, u.email
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
    if (search) {
      const q = '%' + search.replace(/%/g, '\\%') + '%';
      sql +=
        ' AND (s.full_name ILIKE ? OR s.reply_email ILIKE ? OR u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.email ILIKE ?)';
      params.push(q, q, q, q, q);
    }
    sql += ' ORDER BY s.created_at DESC LIMIT 250';
    const rows = await queryAll(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Admin sunday-checkins list error:', e.message);
    res.status(500).json({ error: 'Failed to load Sunday check-ins' });
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
    if (search) {
      const q = '%' + search.replace(/%/g, '\\%') + '%';
      sql += ' AND (name ILIKE ? OR email ILIKE ? OR mobile ILIKE ?)';
      params.push(q, q, q);
    }
    sql += ' ORDER BY created_at DESC LIMIT 250';
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
const LEAD_STAGE_IDS = [
  'new_audit', 'whatsapp_sent', 'in_conversation',
  'part2_sent', 'part2_received',
  'call_proposed', 'call_scheduled', 'call_done',
  'payment_pending', 'onboarded', 'lost'
];
const LEAD_STAGE_LABELS = {
  new_audit: 'New audit',
  whatsapp_sent: 'WhatsApp sent',
  in_conversation: 'In conversation',
  part2_sent: 'Part-2 sent',
  part2_received: 'Part-2 received',
  call_proposed: 'Call proposed',
  call_scheduled: 'Call scheduled',
  call_done: 'Call done',
  payment_pending: 'Payment pending',
  onboarded: 'Paid & onboarded',
  lost: 'Lost / Cold'
};

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
      (SELECT COUNT(*)::int FROM lead_notes ln WHERE ln.audit_id = a.id) AS notes_count
    FROM audit_requests a
    WHERE 1=1`;
  const params = [];
  if (stage && LEAD_STAGE_IDS.indexOf(stage) >= 0) {
    sql += ' AND COALESCE(a.stage, \'new_audit\') = ?';
    params.push(stage);
  }
  if (from) { sql += ' AND a.created_at::date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.created_at::date <= ?'; params.push(to); }
  if (search) {
    const q = '%' + String(search).replace(/%/g, '\\%') + '%';
    sql += ' AND (a.first_name ILIKE ? OR a.last_name ILIKE ? OR a.email ILIKE ? OR a.phone ILIKE ? OR (COALESCE(a.first_name,\'\') || \' \' || COALESCE(a.last_name,\'\')) ILIKE ?)';
    params.push(q, q, q, q, q);
  }
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
    res.json({ stages: LEAD_STAGE_IDS.map(id => ({ id, label: LEAD_STAGE_LABELS[id] })), leads: rows });
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
       WHERE COALESCE(stage,'new_audit') = 'part2_sent'
         AND COALESCE(stage_changed_at, created_at) < NOW() - INTERVAL '7 days'
       ORDER BY stage_changed_at ASC LIMIT 20`
    );
    const paymentPending = await queryAll(
      `SELECT id, first_name, last_name, email, phone, stage_changed_at
       FROM audit_requests
       WHERE COALESCE(stage,'new_audit') = 'payment_pending'
       ORDER BY stage_changed_at ASC LIMIT 20`
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
      payment_pending: paymentPending,
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
      ? await queryOne('SELECT id, email, first_name, last_name, role, approval_status, created_at FROM users WHERE id = ?', [lead.linked_user_id])
      : await queryOne('SELECT id, email, first_name, last_name, role, approval_status, created_at FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [lead.email || '']);
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
    const fromLabel = LEAD_STAGE_LABELS[lead.stage] || lead.stage || 'New audit';
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
    let newStage = lead.stage || 'new_audit';
    const preCall = ['new_audit', 'whatsapp_sent', 'in_conversation', 'part2_sent', 'part2_received', 'call_proposed'];
    if (preCall.indexOf(newStage) >= 0) newStage = 'call_scheduled';
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
       SET linked_user_id = ?, stage = 'onboarded', stage_changed_at = NOW(), last_contact_at = NOW()
       WHERE id = ?`,
      [user.id, req.params.id]
    );
    const author = leadAuthorFromReq(req);
    await appendLeadNote(req.params.id, author, `Linked to user ${user.email} — marked Paid & onboarded`, 'stage_change', 'onboarded');
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
    let sql = `SELECT w.*, u.first_name, u.last_name, u.email
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
    if (search) {
      const q = '%' + search.replace(/%/g, '\\%') + '%';
      sql +=
        ' AND (u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.email ILIKE ? OR w.workout_name ILIKE ? OR COALESCE(w.workout_type,\'\') ILIKE ? OR COALESCE(w.feedback,\'\') ILIKE ?)';
      params.push(q, q, q, q, q, q);
    }
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

// ============ ADMIN: PENDING SIGNUPS & APPROVE ============
app.get('/api/admin/pending-signups', async (req, res) => {
  try {
    const list = await queryAll("SELECT id, email, first_name, last_name, created_at FROM users WHERE role = 'user' AND (approval_status IS NULL OR approval_status = 'pending') ORDER BY created_at DESC");
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch pending sign-ups' });
  }
});

app.post('/api/admin/approve-user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role, email, first_name, last_name, phone, country FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot change admin approval' });
    await run("UPDATE users SET approval_status = 'approved' WHERE id = ?", [id]);
    await syncUserCountryAndTimezone(user.id, user.email);
    // Add to tribe_members so new member appears in Clients section
    const existing = await queryOne("SELECT id FROM tribe_members WHERE LOWER(email) = ?", [(user.email || '').toLowerCase()]);
    if (!existing) {
      const tribeId = uuidv4();
      const today = new Date().toISOString().split('T')[0];
      const city = (user.country || '').trim() || '';
      await run(`INSERT INTO tribe_members (id, first_name, last_name, email, phone, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, next_checkin, notes) VALUES (?,?,?,?,?,?,1,?,0,?,?,?,?,?)`,
        [tribeId, user.first_name || '', user.last_name || '', user.email || '', user.phone || '', city, today, null, null, null, '', 'Newly approved']);
    }
    await ensureApprovedUsersInActiveTribe();
    if (user.email) userEmail.emailAccountApproved(user.email, user.first_name);
    notifyAsync('USER_APPROVED', { name: `${user.first_name || ''} ${user.last_name || ''}`.trim(), email: user.email, mobile: user.phone || '—' });
    res.json({ message: 'User approved' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

app.post('/api/admin/reject-user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role, email, first_name, phone FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot change admin approval' });
    await run("UPDATE users SET approval_status = 'rejected' WHERE id = ?", [id]);
    if (user.email) userEmail.emailAccountRejected(user.email, user.first_name);
    notifyAsync('USER_REJECTED', { name: user.first_name || '', email: user.email, mobile: user.phone || '—' });
    res.json({ message: 'User rejected' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

app.get('/api/admin/pending-signup/:id', async (req, res) => {
  try {
    const user = await queryOne("SELECT id, email, first_name, last_name, phone, country, state_province, city, dob, gender, timezone, created_at FROM users WHERE id = ? AND role = 'user' AND (approval_status IS NULL OR approval_status = 'pending')", [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch sign-up request' });
  }
});

// ============ NOTIFICATIONS (Admin + User; role-based) ============
app.get('/api/notifications', verifyToken, async (req, res) => {
  try {
    const notifications = [];
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';

    if (isAdmin) {
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
      const pendingSignups = await queryAll("SELECT id, email, first_name, last_name, created_at FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'pending') ORDER BY created_at DESC LIMIT 20");
      pendingSignups.forEach(u => {
        notifications.push({
          id: 'signup-' + u.id,
          type: 'user',
          title: 'New User Sign-up (Pending Approval)',
          desc: `${u.first_name || ''} ${u.last_name || ''} (${u.email})`,
          time: u.created_at,
          link: 'signups'
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
          title: 'Program assigned',
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
app.get('/api/stats', async (req, res) => {
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
  const [pendingSignups] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status='pending')");
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
    pending_signups: num(pendingSignups[0]?.c),
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
      "SELECT first_name, last_name, created_at FROM users WHERE role='user' AND approval_status='pending' ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    (ps || []).forEach(r => activities.push({ name: ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'New user', type: 'Sign-up', status: 'PENDING', created_at: r.created_at }));
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

// ============ ADMIN: USERS LIST (for insights filter; exclude E2E test users) ============
app.get('/api/admin/users', async (req, res) => {
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
    if (user.email) {
      await run('DELETE FROM tribe_members WHERE LOWER(email) = LOWER(?)', [user.email]);
    }
    await run('DELETE FROM users WHERE id = ?', [id]);
    notifyAsync('USER_DELETED', { name: id, email: user.email, mobile: user.phone || '—' });
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
    if (!user.password || !bcrypt.compareSync(String(password), user.password)) {
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
    if (user.email) await run('DELETE FROM tribe_members WHERE LOWER(email) = LOWER(?)', [user.email]);
    await run('DELETE FROM users WHERE id = ?', [id]);
    notifyAsync('USER_DELETED', { name: 'self-deleted', email: user.email, mobile: user.phone || '—' });
    res.json({ message: 'Your account has been deleted.' });
  } catch (e) {
    console.error('Self-delete error:', e.message);
    res.status(500).json({ error: 'Failed to delete account. Please try again.' });
  }
});

// ============ ADMIN: PERFORMANCE INSIGHTS ============
app.get('/api/admin/performance-insights', async (req, res) => {
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
app.get('/api/admin/db-view', async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const tables = ['users', 'audit_requests', 'tribe_members', 'workout_logs', 'contact_messages', 'meetings', 'part2_audit', 'hydration_logs', 'weight_logs', 'sunday_checkins'];
    const result = {};
    
    for (const table of tables) {
      try {
        const rows = await queryAll(`SELECT * FROM ${table}`);
        result[table] = rows;
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
    const [signups] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'pending')");
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
    lines.push('Pending sign-ups (awaiting approval): ' + pendSign + '.');
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

    const recentDailyCheckins = await queryAll("SELECT dc.checkin_date, dc.steps, dc.water_ml, dc.protein_g, dc.sleep_hours, dc.created_at, u.first_name, u.last_name, u.email FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id ORDER BY dc.checkin_date DESC, dc.created_at DESC LIMIT 15");
    lines.push('\n--- DAILY CHECK-INS (steps, water, protein, sleep) ---');
    if (recentDailyCheckins && recentDailyCheckins.length > 0) {
      recentDailyCheckins.forEach(r => {
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${r.checkin_date || ''} | steps: ${r.steps ?? '-'} | water: ${r.water_ml != null ? (Number(r.water_ml) / 1000).toFixed(2) + ' L' : '-'} | protein: ${r.protein_g ?? '-'} g | sleep: ${r.sleep_hours ?? '-'} hrs | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');

    const pendingSignupList = await queryAll("SELECT first_name, last_name, email, created_at FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'pending') ORDER BY created_at DESC LIMIT 10");
    lines.push('\n--- PENDING SIGN-UPS (awaiting approval) ---');
    if (pendingSignupList && pendingSignupList.length > 0) {
      pendingSignupList.forEach(r => {
        lines.push(`  ${(r.first_name || '')} ${(r.last_name || '')} | ${r.email || ''} | ${r.created_at || ''}`);
      });
    } else lines.push('  (None.)');
  } catch (e) {
    lines.push('\n(Data fetch issue: ' + e.message + '. Still answer politely from the counts above if any.)');
  }
  lines.push('\n--- ADMIN ACTIONS (suggest these when relevant) ---');
  lines.push('The admin can: Approve or reject audit forms (Audit forms tab); Approve pending sign-ups (Pending Sign-ups tab); View and manage Tribe, Workouts, Messages & Meetings, Part-2 Form, Sunday Check-in; View Client Progress and share a progress report link with a client; Use Performance Insights for filters and CSV export. When data suggests follow-up (e.g. pending items, new messages, inactive users), suggest 1–3 concrete actions the admin can take in the dashboard.');

  return lines.join('\n');
}

// Admin AI Assist system prompt + formatting: services/bodybankAiCoachContext.js

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function estimateAICost({ provider, inputTokens, outputTokens }) {
  const usdToInr = toNumber(process.env.AI_COST_USD_TO_INR, 83);
  const pricing = {
    anthropic: {
      inputPerMillionUsd: toNumber(process.env.ANTHROPIC_INPUT_PER_MILLION_USD, 3),
      outputPerMillionUsd: toNumber(process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD, 15)
    }
  };
  const p = pricing[provider] || { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };
  const inUsd = ((toNumber(inputTokens) / 1000000) * p.inputPerMillionUsd) + ((toNumber(outputTokens) / 1000000) * p.outputPerMillionUsd);
  const inInr = inUsd * usdToInr;
  return {
    estimated_cost_usd: Number(inUsd.toFixed(6)),
    estimated_cost_inr: Number(inInr.toFixed(4)),
    usd_to_inr: usdToInr
  };
}

async function callAnthropicChat(systemContentFull, userMessage, maxTokensOverride) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  const modelCandidates = Array.from(new Set([
    process.env.ANTHROPIC_MODEL,
    'claude-sonnet-4-20250514'
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
      ...estimateAICost({ provider: 'anthropic', inputTokens, outputTokens })
    };
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
  const pendingSignups = getCount(/Pending sign-ups[^:]*:\s*(\d+)/);
  const contactMsg = getCount(/Contact messages:\s*(\d+)/);
  const tribeTotal = getCount(/Tribe members:\s*(\d+)\s+total/);
  const workouts = getCount(/Workout logs:\s*(\d+)/);
  const sundayCheck = getCount(/Sunday check-ins:\s*(\d+)/);
  const act = getCount(/Active:\s*(\d+)/);
  const suggestActions = () => {
    const actions = [];
    if (pendingAudit > 0) actions.push('• Go to **Audit forms** and approve or reject the ' + pendingAudit + ' pending request(s).');
    if (pendingSignups > 0) actions.push('• Go to **Pending Sign-ups** and approve the ' + pendingSignups + ' user(s) so they can log in.');
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
    answer = pendingSignups === 0 ? 'There are no pending sign-ups awaiting approval.' : 'There are ' + pendingSignups + ' pending sign-up' + (pendingSignups === 1 ? '' : 's') + ' awaiting approval.';
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
    answer = pendingSignups === 0 ? 'No one is pending approval right now.' : 'There are ' + pendingSignups + ' pending sign-up' + (pendingSignups === 1 ? '' : 's') + ' awaiting approval. Open the Pending Sign-ups tab to see names and approve them.';
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
    rateLimiter
  })
);
app.use('/api/marketing-ai', createMarketingAIRouter({ run, queryAll }));
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
  const [signupsPending] = await queryAll("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'pending')");
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
    pending_signups: num(signupsPending?.c),
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
    "SELECT dc.id, dc.user_id, dc.checkin_date, dc.steps, dc.water_ml, dc.protein_g, dc.sleep_hours, dc.created_at, u.first_name, u.last_name, u.email FROM daily_checkins dc LEFT JOIN users u ON u.id = dc.user_id ORDER BY dc.checkin_date DESC, dc.created_at DESC LIMIT 200"
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
    if (!expected || secret !== expected) {
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
      "SELECT pr.id, pr.used, pr.expires_at, u.role FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token = ?",
      [token]
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
    // WhatsApp / Twilio hard limit is 5 MB for images
    if (buf.length > 5 * 1024 * 1024) {
      console.warn('[photo-serve] Photo too large for Twilio: %d bytes for mealId=%s', buf.length, mealId);
      return res.status(413).send('Photo too large');
    }
    console.log('[photo-serve] Serving photo mealId=%s size=%d mime=%s', mealId, buf.length, mime);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=300');
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
app.post('/api/feed/upload', feedUpload ? feedUpload.single('image') : (req, _res, next) => next(), async (req, res) => {
  try {
    const caption  = String(req.body?.caption  || '').trim().slice(0, 240);
    const username = String(req.body?.username || 'bodybank_member').trim().slice(0, 32) || 'bodybank_member';
    const featured = String(req.body?.featured || '') === '1';
    let imageData = '', imageMime = 'image/jpeg';

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

    const id = uuidv4();
    const likes = Math.floor(Math.random() * 70) + 12;
    await pool.query(
      `INSERT INTO feed_posts (id, username, caption, image_data, image_mime, likes, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, username, caption || 'BodyBank.fit transformation in progress.', imageData, imageMime, likes, featured]
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
app.post('/api/feed/delete', async (req, res) => {
  try {
    const postId  = String(req.body?.postId  || '').trim();
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!postId)   return res.status(400).json({ error: 'postId is required.' });
    if (!username) return res.status(400).json({ error: 'username is required.' });

    const row = await queryOne('SELECT id, username FROM feed_posts WHERE id = $1', [postId]);
    if (!row) return res.status(404).json({ error: 'Post not found.' });
    if (String(row.username || '').toLowerCase() !== username) {
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
  }).catch(err => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
});
