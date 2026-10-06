'use strict';

// ── BloodMap by BodyBank ─────────────────────────────────────────────────────
//
// A one-time paid service for people who are NOT BodyBank members: pay, upload a
// lab report, get the Health Map report, then a doctor call and a sports
// nutritionist call. Website only — the page lives outside public/, so it is
// never bundled into the iOS / Android apps and its price never reaches them.
//
// The report itself is produced by the existing pipeline, untouched:
// triggerBloodAnalysis → gradedReportService (the "Health Map" variant). This
// file only owns the order around it: payment, intake, tracking, call slots.
//
// There is no login. An order is opened with its access token (a private link
// emailed to the client), or recovered with a one-time code.
//
// The EMAIL is the only identity that is ever proven: the buyer confirms it with
// a code before the order is created, and every later code goes to an order's own
// email and unlocks only orders on that email. The mobile number is never proven,
// so nothing secret (a code, a private link) is ever sent to it — otherwise
// anyone could place a small order with a stranger's number and read their report.
// Links expire, staff can revoke them, and a refunded order closes.
//
// blood_analysis_reports.user_id references users(id), so each order gets an
// inert shadow row (role 'bloodmap', unusable password, synthetic email). Every
// member query filters role = 'user', so these never show up as members.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paymentsLib = require('./payments');
const graded = require('./gradedReportService');
const { triggerBloodAnalysis, ensureHealthReportPdf, validateBloodReportInput } = require('./bloodAnalysisService');

const NODE_ENV = process.env.NODE_ENV || 'development';
const CURRENCY = 'INR';
const IST_OFFSET_MIN = 330;
const HOUR = 60 * 60 * 1000;

// Owner-set launch price. Change BLOODMAP_PRICE_INR (or the default) to reprice;
// the page reads it from /api/bloodmap/config and never hardcodes an amount.
const PRICE_RUPEES = Math.max(1, Math.round(Number(process.env.BLOODMAP_PRICE_INR) || 50));
const REPORT_HOURS = Math.max(1, Number(process.env.BLOODMAP_REPORT_HOURS) || 48);
const MIN_LEAD_HOURS = 2;          // never offer a call starting sooner than this
const RESCHEDULE_CUTOFF_HOURS = 12;
const MAX_CHANGES = 2;
const BOOKING_WINDOW_DAYS = 14;
const OTP_TTL_MIN = 10;
const LINK_DAYS = Math.max(1, Number(process.env.BLOODMAP_LINK_DAYS) || 30);
// Bump when the consent wording on the page changes, so each order records what was agreed to.
const CONSENT_VERSION = '2026-10-06';
const OTP_MAX_ATTEMPTS = 5;
const MAX_IMAGES = 6;
// Same ceiling the member upload uses: keeps the base64 under the model's PDF limit.
const MAX_B64_CHARS = 30 * 1024 * 1024;
const SUPPORT_WHATSAPP = String(process.env.BLOODMAP_WHATSAPP || '919502575669').replace(/[^0-9]/g, '');

const ROLES = ['doctor', 'nutritionist'];
const ROLE_LABEL = { doctor: 'Doctor', nutritionist: 'Sports Nutritionist' };

// A consultant's profile is shown publicly only once staff publish it. Until then
// the page names nobody: an invented name beside "registered doctor" is a false claim.
const DEFAULT_TITLE = { doctor: 'Consulting Physician', nutritionist: 'Sports Nutritionist' };
// The first release seeded invented names; these are cleared on boot.
const LEGACY_PLACEHOLDER_NAMES = ['Dr. Name Surname', 'Name Surname'];

// Shown on the report-ready screen. Display only: each one opens WhatsApp with a
// prefilled message, so the team sets it up by hand until amounts are decided.
const OFFERS = [
  { key: 'app', tag: 'Included', title: '30 days of the BodyBank app', body: 'Track food, training, sleep and streaks with a coach watching your numbers. Included with your BloodMap.', cta: 'Claim my 30 days' },
  { key: 'membership', tag: 'BloodMap offer', title: 'A member price on any BodyBank plan', body: 'Join a BodyBank coaching plan within 14 days of your report and get the BloodMap member offer.', cta: 'Ask for my offer' },
  { key: 'retest', tag: '90 days later', title: 'Retest and see what changed', body: 'Upload a new report in 3 months. We compare both and show exactly which markers moved.', cta: 'Remind me to retest' }
];

function devPayAllowed() {
  // Local development without Razorpay keys: lets the whole flow be walked through.
  // Both conditions must hold, so it can never open on the live site.
  return NODE_ENV !== 'production' && !paymentsLib.config().enabled;
}

function clip(v, n) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}

function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 160 ? s : '';
}

/** Last 10 digits — how an Indian mobile is matched whatever prefix was typed. */
function phoneKey(v) {
  const d = String(v || '').replace(/[^0-9]/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/** E.164-ish for WhatsApp: a bare 10-digit number is assumed Indian. */
function phoneE164(v) {
  const raw = String(v || '').trim();
  const d = raw.replace(/[^0-9]/g, '');
  if (d.length < 10) return '';
  if (raw.startsWith('+')) return '+' + d;
  return d.length === 10 ? '+91' + d : '+' + d;
}

function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!u || !d) return '';
  return u.slice(0, 1) + '***' + (u.length > 2 ? u.slice(-1) : '') + '@' + d;
}

function maskPhone(p) {
  const d = String(p || '').replace(/[^0-9]/g, '');
  return d.length >= 4 ? '******' + d.slice(-4) : '';
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function refOf(order) {
  return 'BM-' + String(order.id || '').replace(/-/g, '').slice(0, 6).toUpperCase();
}

function inr(paise) {
  return '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtIST(d, withDay = true) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-IN', Object.assign(
    { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true },
    withDay ? { weekday: 'short' } : {}
  ));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function normalizeReportDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { date: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { error: 'Test date must be a valid date.' };
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (dt.getUTCFullYear() !== +m[1] || dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) return { error: 'That is not a real calendar date.' };
  if (+m[1] < 1990) return { error: 'Test date looks too far in the past.' };
  if (dt.getTime() > Date.now() + 24 * HOUR) return { error: 'Test date cannot be in the future.' };
  return { date: s };
}

/** Several phone photos of one report become a single PDF, one photo per page. */
function imagesToPdf(buffers) {
  return new Promise((resolve, reject) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      for (const b of buffers) {
        doc.addPage({ size: 'A4', margin: 0 });
        doc.image(b, 0, 0, { fit: [595.28, 841.89], align: 'center', valign: 'center' });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

/**
 * @param {object} deps
 * @param {() => import('pg').Pool} deps.getPool
 * @param {Function} deps.run / queryOne / queryAll
 * @param {Function} deps.rzp           (method, path, body) → Razorpay JSON
 * @param {object}   [deps.email]       services/userEmailService
 * @param {Function} [deps.sendWhatsApp] (message, { to }) → Promise
 * @param {object}   [deps.notifyHub]   staff push + inbox
 * @param {Function} [deps.notifyAsync] staff WhatsApp alert
 * @param {Function} [deps.uuid]
 */
function createBloodmapService(deps) {
  const { getPool, run, queryOne, queryAll, rzp } = deps;
  const db = { run, queryOne, queryAll };
  const email = deps.email || null;
  const uuid = typeof deps.uuid === 'function' ? deps.uuid : () => crypto.randomUUID();
  const sendWa = typeof deps.sendWhatsApp === 'function' ? deps.sendWhatsApp : null;
  const hub = deps.notifyHub || null;
  const notifyAsync = typeof deps.notifyAsync === 'function' ? deps.notifyAsync : () => {};

  // ── tables ────────────────────────────────────────────────────────────────
  async function ensureTables() {
    await run(`CREATE TABLE IF NOT EXISTS bloodmap_orders (
      id TEXT PRIMARY KEY,
      access_token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_key TEXT NOT NULL,
      email TEXT NOT NULL,
      city TEXT DEFAULT '',
      age TEXT DEFAULT '',
      gender TEXT DEFAULT '',
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      rzp_order_id TEXT UNIQUE,
      payment_id TEXT,
      pay_status TEXT NOT NULL DEFAULT 'created',
      pay_error TEXT,
      mode TEXT,
      refunded_paise INTEGER DEFAULT 0,
      paid_at TIMESTAMPTZ,
      user_id TEXT,
      report_id TEXT,
      intake JSONB,
      uploaded_at TIMESTAMPTZ,
      released_at TIMESTAMPTZ,
      reupload_note TEXT,
      reupload_requested_at TIMESTAMPTZ,
      reminder_count INTEGER DEFAULT 0,
      admin_notes TEXT DEFAULT '',
      origin TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_bloodmap_orders_email ON bloodmap_orders (email)');
    await run('CREATE INDEX IF NOT EXISTS idx_bloodmap_orders_phone ON bloodmap_orders (phone_key)');
    await run('CREATE INDEX IF NOT EXISTS idx_bloodmap_orders_payment ON bloodmap_orders (payment_id)');
    for (const col of [
      'email_verified_at TIMESTAMPTZ',
      'token_expires_at TIMESTAMPTZ',
      'consent_at TIMESTAMPTZ',
      `consent_version TEXT DEFAULT ''`,
      `consent_ip TEXT DEFAULT ''`,
      `consent_ua TEXT DEFAULT ''`
    ]) await run(`ALTER TABLE bloodmap_orders ADD COLUMN IF NOT EXISTS ${col}`);
    // Links issued before expiry existed get the standard lifetime from now.
    await run(`UPDATE bloodmap_orders SET token_expires_at = NOW() + INTERVAL '${LINK_DAYS} days' WHERE token_expires_at IS NULL`);

    await run(`CREATE TABLE IF NOT EXISTS bloodmap_consultants (
      role TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      title TEXT DEFAULT '',
      qualification TEXT DEFAULT '',
      reg_no TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      work_days TEXT DEFAULT '1,2,3,4,5,6',
      start_min INTEGER DEFAULT 600,
      end_min INTEGER DEFAULT 1140,
      slot_min INTEGER DEFAULT 60,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    await run('ALTER TABLE bloodmap_consultants ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT FALSE');
    for (const role of ROLES) {
      await run('INSERT INTO bloodmap_consultants (role, title) VALUES (?, ?) ON CONFLICT (role) DO NOTHING', [role, DEFAULT_TITLE[role]]);
    }
    await run(
      `UPDATE bloodmap_consultants SET name = '', qualification = '', reg_no = '', bio = '', published = FALSE WHERE name IN (?, ?)`,
      LEGACY_PLACEHOLDER_NAMES
    );

    await run(`CREATE TABLE IF NOT EXISTS bloodmap_bookings (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      role TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      change_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (order_id, role)
    )`);
    // The database, not the application, is what stops two clients taking one slot.
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bloodmap_slot ON bloodmap_bookings (role, starts_at) WHERE status <> 'cancelled'`);

    await run(`CREATE TABLE IF NOT EXISTS bloodmap_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT DEFAULT '',
      actor TEXT DEFAULT 'client',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_bloodmap_events_order ON bloodmap_events (order_id, created_at)');

    await run(`CREATE TABLE IF NOT EXISTS bloodmap_otps (
      id TEXT PRIMARY KEY,
      contact TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_bloodmap_otps_contact ON bloodmap_otps (contact, created_at DESC)');
    // purpose: 'order' (confirming an email before buying) | 'track' (reopening an order).
    // email: the one address this code was sent to, and the only orders it can unlock.
    await run(`ALTER TABLE bloodmap_otps ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'track'`);
    await run(`ALTER TABLE bloodmap_otps ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
    await run(`DELETE FROM bloodmap_otps WHERE expires_at < NOW() - INTERVAL '1 day'`);
  }

  function logEvent(orderId, kind, detail, actor) {
    return run(
      'INSERT INTO bloodmap_events (id, order_id, kind, detail, actor) VALUES (?, ?, ?, ?, ?)',
      [uuid(), orderId, kind, clip(detail, 500), actor || 'client']
    ).catch((e) => console.warn('[bloodmap] event log failed:', e.message));
  }

  // ── messaging ─────────────────────────────────────────────────────────────
  function linkFor(order) {
    const base = String(order.origin || process.env.PUBLIC_URL || process.env.APP_BASE_URL || process.env.SITE_URL || 'https://www.bodybank.fit').replace(/\/$/, '');
    return base + '/bloodmap?o=' + encodeURIComponent(order.access_token);
  }

  /**
   * Email carries the private link. WhatsApp is a nudge only and never carries the
   * link: the mobile number is unproven, so a mistyped or borrowed number must not
   * hand a stranger the way into someone's blood report. Never throws.
   */
  function tellClient(order, msg) {
    const url = linkFor(order);
    const first = String(order.name || '').trim().split(/\s+/)[0] || 'there';
    if (email && email.isConfigured && email.isConfigured()) {
      const html = email.luxuryWrap({
        title: msg.title,
        preheader: msg.lead,
        lead: 'Hi ' + first + ', ' + msg.lead,
        bodyHtml: (msg.lines || []).map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('') +
          `<p style="margin:14px 0 0;font-size:12px;color:#8a8880">Order ${esc(refOf(order))} · BloodMap by BodyBank. This link is private to you, please do not forward it.</p>`,
        ctaLabel: msg.cta || 'Open my BloodMap',
        ctaUrl: url
      });
      email.sendMail(order.email, msg.subject || msg.title, html, `${msg.title}\n\n${msg.lead}\n\n${url}`)
        .catch((e) => console.warn('[bloodmap] email failed:', e.message));
    } else if (NODE_ENV !== 'production') {
      console.log(`[bloodmap] (email not configured) → ${order.email}: ${msg.title} — ${url}`);
    }
    const to = phoneE164(order.phone);
    if (sendWa && to) {
      Promise.resolve(sendWa(`BloodMap by BodyBank\n\nHi ${first}, ${msg.lead}\n\nOpen the link in the email we sent to ${maskEmail(order.email)}.`, { to }))
        .catch((e) => console.warn('[bloodmap] whatsapp failed:', e.message));
    }
  }

  function tellStaff(order, title, body, waEvent, extra) {
    if (hub) hub.staff({ title, body, type: 'bloodmap', url: '/bloodmap/admin', tag: 'bloodmap-' + order.id });
    if (waEvent) {
      notifyAsync(waEvent, Object.assign({
        name: order.name, email: order.email, mobile: order.phone, ref: refOf(order), city: order.city || '—'
      }, extra || {}));
    }
  }

  // ── consultants + slots ───────────────────────────────────────────────────
  async function getConsultants() {
    const rows = await queryAll('SELECT * FROM bloodmap_consultants');
    const out = {};
    for (const role of ROLES) {
      const r = rows.find((x) => x.role === role) || {};
      out[role] = {
        role,
        label: ROLE_LABEL[role],
        published: !!r.published && !!String(r.name || '').trim(),
        name: r.name || '',
        title: r.title || DEFAULT_TITLE[role],
        qualification: r.qualification || '',
        reg_no: r.reg_no || '',
        bio: r.bio || '',
        photo_url: r.photo_url || '',
        work_days: String(r.work_days || '1,2,3,4,5,6').split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6),
        start_min: Number.isFinite(Number(r.start_min)) ? Number(r.start_min) : 600,
        end_min: Number.isFinite(Number(r.end_min)) ? Number(r.end_min) : 1140,
        slot_min: Number(r.slot_min) > 0 ? Number(r.slot_min) : 60
      };
    }
    return out;
  }

  /** What the public may see. An unpublished profile leaves the server as a role and nothing else. */
  function publicConsultant(c) {
    if (!c.published) return { role: c.role, label: c.label, published: false, name: '', title: '', qualification: '', reg_no: '', bio: '', photo_url: '' };
    return { role: c.role, label: c.label, published: true, name: c.name, title: c.title, qualification: c.qualification, reg_no: c.reg_no, bio: c.bio, photo_url: c.photo_url };
  }

  async function saveConsultant(role, body) {
    if (!ROLES.includes(role)) return { error: 'Unknown consultant', status: 404 };
    const b = body || {};
    const days = (Array.isArray(b.work_days) ? b.work_days : String(b.work_days || '').split(','))
      .map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6);
    const startMin = Math.min(Math.max(parseInt(b.start_min, 10) || 600, 0), 1380);
    const endMin = Math.min(Math.max(parseInt(b.end_min, 10) || 1140, startMin + 30), 1440);
    const slotMin = [30, 45, 60, 90].includes(parseInt(b.slot_min, 10)) ? parseInt(b.slot_min, 10) : 60;
    const photo = clip(b.photo_url, 600);
    if (photo && !/^(https:\/\/|\/)/.test(photo)) return { error: 'Photo must be an https:// link.', status: 400 };
    const name = clip(b.name, 80), qualification = clip(b.qualification, 160), regNo = clip(b.reg_no, 80);
    const publish = b.published === true || b.published === 'true';
    if (publish) {
      if (name.length < 3 || LEGACY_PLACEHOLDER_NAMES.includes(name)) return { error: 'Enter the real name before showing this profile on the public page.', status: 400 };
      if (!qualification) return { error: 'Enter the qualification before showing this profile on the public page.', status: 400 };
      // The page calls the doctor "registered", so the registration number must be on it.
      if (role === 'doctor' && !regNo) return { error: 'Enter the medical registration number before showing the doctor on the public page.', status: 400 };
    }
    await run(
      `UPDATE bloodmap_consultants SET name = ?, title = ?, qualification = ?, reg_no = ?, bio = ?, photo_url = ?,
              work_days = ?, start_min = ?, end_min = ?, slot_min = ?, published = ?, updated_at = NOW() WHERE role = ?`,
      [name, clip(b.title, 80), qualification, regNo, clip(b.bio, 600), photo,
        (days.length ? days : [1, 2, 3, 4, 5, 6]).join(','), startMin, endMin, slotMin, publish, role]
    );
    return { ok: true, published: publish };
  }

  async function bookingsFor(orderId) {
    const rows = await queryAll('SELECT * FROM bloodmap_bookings WHERE order_id = ?', [orderId]);
    const out = {};
    for (const r of rows) out[r.role] = r;
    return out;
  }

  /** When the report is expected: the promise shown to the client and the floor for call slots. */
  function reportDueAt(order) {
    if (order.released_at) return new Date(order.released_at);
    const from = order.uploaded_at ? new Date(order.uploaded_at) : new Date();
    return new Date(from.getTime() + REPORT_HOURS * HOUR);
  }

  /**
   * Free slots for one consultant, in IST (no DST, so a fixed offset is exact).
   * The doctor call comes first: a nutritionist slot must start after the doctor
   * call ends, and a moved doctor call must still end before the nutritionist's.
   */
  async function slotsFor(order, role) {
    if (!ROLES.includes(role)) return { error: 'Unknown call type', status: 400 };
    if (isClosed(order)) return CLOSED;
    const consultants = await getConsultants();
    const c = consultants[role];
    const mine = await bookingsFor(order.id);
    const now = Date.now();

    let earliest = Math.max(now + MIN_LEAD_HOURS * HOUR, order.released_at ? 0 : reportDueAt(order).getTime());
    let latest = now + BOOKING_WINDOW_DAYS * 24 * HOUR;
    const active = (b) => b && b.status !== 'cancelled';
    if (role === 'nutritionist') {
      if (!active(mine.doctor)) return { role, needs: 'doctor', days: [], message: 'Book your doctor call first. The nutritionist call comes after it.' };
      earliest = Math.max(earliest, new Date(mine.doctor.ends_at).getTime());
      latest = Math.max(latest, earliest + 7 * 24 * HOUR);
    } else if (active(mine.nutritionist)) {
      latest = Math.min(latest, new Date(mine.nutritionist.starts_at).getTime());
    }

    const taken = new Set((await queryAll(
      `SELECT starts_at FROM bloodmap_bookings WHERE role = ? AND status <> 'cancelled' AND order_id <> ? AND starts_at > NOW()`,
      [role, order.id]
    )).map((r) => new Date(r.starts_at).getTime()));

    const days = [];
    const istNow = new Date(now + IST_OFFSET_MIN * 60000);
    for (let i = 0; i <= BOOKING_WINDOW_DAYS + 7; i++) {
      const dayUtcMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + i);
      const wd = new Date(dayUtcMidnight).getUTCDay();
      if (!c.work_days.includes(wd)) continue;
      const slots = [];
      for (let t = c.start_min; t + c.slot_min <= c.end_min; t += c.slot_min) {
        const start = dayUtcMidnight + (t - IST_OFFSET_MIN) * 60000;
        const end = start + c.slot_min * 60000;
        if (start < earliest || taken.has(start)) continue;
        if (role === 'doctor' ? end > latest : start > latest) continue;
        const h = Math.floor(t / 60), m = t % 60;
        slots.push({ start: new Date(start).toISOString(), label: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` });
      }
      if (slots.length) {
        const d = new Date(dayUtcMidnight);
        days.push({
          date: d.toISOString().slice(0, 10),
          label: d.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }),
          slots
        });
      }
      if (days.length >= 10) break;
    }
    return { role, slot_min: c.slot_min, days, current: active(mine[role]) ? new Date(mine[role].starts_at).toISOString() : null };
  }

  function bookingView(b, role) {
    if (!b || b.status === 'cancelled') return { role, status: 'none' };
    const startsMs = new Date(b.starts_at).getTime();
    const changesLeft = Math.max(0, MAX_CHANGES - Number(b.change_count || 0));
    const canChange = b.status === 'booked' && changesLeft > 0 && startsMs - Date.now() >= RESCHEDULE_CUTOFF_HOURS * HOUR;
    return {
      role, status: b.status,
      starts_at: new Date(b.starts_at).toISOString(), ends_at: new Date(b.ends_at).toISOString(),
      when: fmtIST(b.starts_at), can_change: canChange, changes_left: changesLeft
    };
  }

  async function book(order, role, startIso) {
    if (!ROLES.includes(role)) return { error: 'Unknown call type', status: 400 };
    if (isClosed(order)) return CLOSED;
    if (order.pay_status !== 'paid') return { error: 'Payment is not complete for this order.', status: 402 };
    if (!order.report_id) return { error: 'Upload your blood report first, then choose your call times.', status: 400 };
    const startMs = new Date(String(startIso || '')).getTime();
    if (!Number.isFinite(startMs)) return { error: 'Pick a time slot.', status: 400 };

    const avail = await slotsFor(order, role);
    if (avail.error) return avail;
    if (avail.needs) return { error: avail.message, status: 400 };
    const offered = avail.days.some((d) => d.slots.some((s) => new Date(s.start).getTime() === startMs));
    if (!offered) return { error: 'That time is no longer available. Please pick another slot.', status: 409 };

    const existing = (await bookingsFor(order.id))[role];
    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + avail.slot_min * 60000).toISOString();
    let changed = false;
    try {
      if (existing && existing.status === 'done') return { error: 'This call is already completed.', status: 400 };
      if (existing && existing.status === 'booked') {
        if (new Date(existing.starts_at).getTime() === startMs) return { ok: true, unchanged: true };
        const v = bookingView(existing, role);
        if (!v.can_change) {
          return {
            error: v.changes_left <= 0
              ? 'You have used both changes for this call. Message us on WhatsApp and we will move it for you.'
              : `Calls can be changed up to ${RESCHEDULE_CUTOFF_HOURS} hours before they start. Message us on WhatsApp and we will help.`,
            status: 400
          };
        }
        await run(
          `UPDATE bloodmap_bookings SET starts_at = ?, ends_at = ?, change_count = change_count + 1, updated_at = NOW() WHERE id = ? AND status = 'booked'`,
          [start, end, existing.id]
        );
        changed = true;
      } else if (existing) {
        await run(`UPDATE bloodmap_bookings SET starts_at = ?, ends_at = ?, status = 'booked', updated_at = NOW() WHERE id = ?`, [start, end, existing.id]);
      } else {
        await run('INSERT INTO bloodmap_bookings (id, order_id, role, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)', [uuid(), order.id, role, start, end]);
      }
    } catch (e) {
      if (e && e.code === '23505') return { error: 'That slot was just taken. Please pick another.', status: 409 };
      throw e;
    }

    const when = fmtIST(start);
    const label = ROLE_LABEL[role];
    if (changed) {
      logEvent(order.id, 'call_changed', `${label} call moved from ${fmtIST(existing.starts_at)} to ${when}`);
      tellStaff(order, `🔁 ${order.name} moved the ${label.toLowerCase()} call`, `${fmtIST(existing.starts_at)} → ${when} · ${refOf(order)}`,
        'BLOODMAP_CALL_CHANGED', { call: label, from: fmtIST(existing.starts_at), to: when });
    } else {
      logEvent(order.id, 'call_booked', `${label} call booked for ${when}`);
      tellStaff(order, `📅 ${order.name} booked the ${label.toLowerCase()} call`, `${when} · ${refOf(order)}`,
        'BLOODMAP_CALL_BOOKED', { call: label, when });
    }
    tellClient(order, {
      title: changed ? `${label} call moved` : `${label} call booked`,
      lead: `your ${label.toLowerCase()} call is ${changed ? 'now ' : ''}set for ${when} (India time). We will call you on ${order.phone}.`,
      cta: 'View my BloodMap'
    });
    return { ok: true, changed };
  }

  // ── orders ────────────────────────────────────────────────────────────────
  function validateDetails(b) {
    const name = clip(b && b.name, 80);
    const mail = normEmail(b && b.email);
    const phone = clip(b && b.phone, 20);
    const city = clip(b && b.city, 60);
    const age = parseInt(b && b.age, 10);
    const gender = String((b && b.gender) || '').toLowerCase();
    if (name.length < 2) return { error: 'Please enter your full name.' };
    if (!phoneKey(phone)) return { error: 'Please enter a valid mobile number.' };
    if (!mail) return { error: 'Please enter a valid email address.' };
    if (city.length < 2) return { error: 'Please enter your city.' };
    if (!(age >= 5 && age <= 110)) return { error: 'Please enter your age.' };
    if (!['male', 'female', 'other'].includes(gender)) return { error: 'Please select your gender.' };
    if (!(b && b.consent === true)) return { error: 'Please accept the consent to continue.' };
    return { value: { name, email: mail, phone, city, age: String(age), gender } };
  }

  /**
   * @param {object} body   the details form + email_code
   * @param {string} origin site origin the order was placed on (for links in emails)
   * @param {{ip?:string, ua?:string}} [meta] recorded with the consent
   */
  async function createOrder(body, origin, meta) {
    const v = validateDetails(body);
    if (v.error) return { error: v.error, status: 400 };
    const d = v.value;
    // The buyer must prove the email is theirs before an order exists. It is where
    // the private link goes, and the key every later sign-in code is tied to.
    const proof = await checkCode('order', d.email, body && body.email_code);
    if (proof.error) return { error: proof.error, status: 400 };
    const id = uuid();
    const token = newToken();
    const m = meta || {};
    await run(
      `INSERT INTO bloodmap_orders (id, access_token, token_expires_at, name, phone, phone_key, email, email_verified_at, city, age, gender,
                                    amount_paise, currency, origin, mode, consent_at, consent_version, consent_ip, consent_ua)
       VALUES (?, ?, NOW() + INTERVAL '${LINK_DAYS} days', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [id, token, d.name, d.phone, phoneKey(d.phone), d.email, d.city, d.age, d.gender, PRICE_RUPEES * 100, CURRENCY,
        clip(origin, 200), paymentsLib.config().enabled ? paymentsLib.config().mode : 'dev',
        CONSENT_VERSION, clip(m.ip, 64), clip(m.ua, 300)]
    );
    logEvent(id, 'created', `Details submitted from ${d.city}. Email confirmed by code. Consent ${CONSENT_VERSION} recorded.`);
    return { ok: true, token };
  }

  async function orderByToken(token) {
    const t = String(token || '');
    // Length check first so a junk request never reaches the database.
    if (t.length < 20 || t.length > 128) return null;
    return queryOne('SELECT * FROM bloodmap_orders WHERE access_token = ?', [t]);
  }

  /** A link stops working when it expires or staff revoke it (revoking sets the expiry to now). */
  function linkExpired(order) {
    const exp = order && order.token_expires_at ? new Date(order.token_expires_at).getTime() : 0;
    return !(exp > Date.now());
  }

  // A fully refunded order is closed: the page says so and nothing else is served.
  function isClosed(order) { return !!order && order.pay_status === 'refunded'; }
  const CLOSED = { error: 'This order was refunded and is now closed.', status: 403 };

  /** Give the order a brand-new link. The old one stops working at once. */
  async function reissueLink(order) {
    const token = newToken();
    const r = await run(
      `UPDATE bloodmap_orders SET access_token = ?, token_expires_at = NOW() + INTERVAL '${LINK_DAYS} days', updated_at = NOW() WHERE id = ? RETURNING *`,
      [token, order.id]
    );
    return (r.rows && r.rows[0]) || order;
  }

  /** Start (or resume) the Razorpay checkout for an unpaid order. */
  async function startPayment(order) {
    if (isClosed(order)) return CLOSED;
    if (order.pay_status === 'paid') return { ok: true, paid: true };
    const cfg = paymentsLib.config();
    if (!cfg.enabled) {
      if (devPayAllowed()) return { ok: true, dev: true, amount: order.amount_paise, currency: order.currency };
      return { error: 'Online payment is not available right now. Message us on WhatsApp and we will help.', status: 503 };
    }
    const rz = await rzp('POST', '/orders', {
      amount: Number(order.amount_paise),
      currency: order.currency,
      receipt: ('bm_' + String(order.id).replace(/-/g, '')).slice(0, 40),
      notes: { product: 'bloodmap', bloodmap_order: String(order.id), email: clip(order.email, 250) }
    });
    await run(`UPDATE bloodmap_orders SET rzp_order_id = ?, mode = ?, updated_at = NOW() WHERE id = ? AND pay_status <> 'paid'`, [rz.id, cfg.mode, order.id]);
    return {
      ok: true, key_id: cfg.keyId, order_id: rz.id, amount: rz.amount, currency: rz.currency, mode: cfg.mode,
      prefill: { name: order.name, email: order.email, contact: order.phone }
    };
  }

  /** Mark an order paid for a captured payment. Idempotent (row lock + pay_status). */
  async function markPaid(rzpOrderId, payment, source) {
    const client = await getPool().connect();
    let paidRow = null;
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM bloodmap_orders WHERE rzp_order_id = $1 FOR UPDATE', [rzpOrderId]);
      const row = r.rows[0];
      if (!row) { await client.query('ROLLBACK'); return { ok: false, reason: 'unknown_order' }; }
      if (row.pay_status === 'paid') { await client.query('COMMIT'); return { ok: true, already: true }; }
      if (!payment || payment.order_id !== rzpOrderId || Number(payment.amount) !== Number(row.amount_paise) ||
          String(payment.currency || '').toUpperCase() !== String(row.currency).toUpperCase()) {
        await client.query(`UPDATE bloodmap_orders SET pay_status = 'mismatch', payment_id = $1, pay_error = 'Amount/order mismatch', updated_at = NOW() WHERE id = $2`, [payment && payment.id, row.id]);
        await client.query('COMMIT');
        tellStaff(row, '⚠️ BloodMap payment needs attention', `Paid amount did not match the order for ${row.name}. Not marked paid.`);
        return { ok: false, reason: 'mismatch' };
      }
      if (payment.status !== 'captured') { await client.query('ROLLBACK'); return { ok: false, reason: 'not_captured' }; }
      const u = await client.query(
        `UPDATE bloodmap_orders SET pay_status = 'paid', payment_id = $1, paid_at = NOW(), pay_error = NULL, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [payment.id, row.id]
      );
      await client.query('COMMIT');
      paidRow = u.rows[0];
      return { ok: true };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
      if (paidRow) afterPaid(paidRow, source);
    }
  }

  function afterPaid(order, source) {
    logEvent(order.id, 'paid', `${inr(order.amount_paise)} received (${source})`, 'system');
    tellStaff(order, `💰 BloodMap order — ${order.name}`, `${inr(order.amount_paise)} paid${order.mode !== 'live' ? ' (' + order.mode + ' mode)' : ''} · ${refOf(order)} · waiting for the report upload`,
      'BLOODMAP_PAID', { amount: inr(order.amount_paise), mode: order.mode });
    tellClient(order, {
      title: 'Payment received',
      subject: 'Your BloodMap order is confirmed',
      lead: `we have received your payment of ${inr(order.amount_paise)}. Upload your blood report to begin.`,
      lines: ['Keep this email. The button below is your private link to upload the report, track progress, book your calls and download your Health Map report.'],
      cta: 'Upload my report'
    });
  }

  async function verifyPayment(order, body) {
    if (isClosed(order)) return { ok: false, reason: 'closed' };
    if (order.pay_status === 'paid') return { ok: true, already: true };
    const cfg = paymentsLib.config();
    const orderId = String((body && body.razorpay_order_id) || '');
    const paymentId = String((body && body.razorpay_payment_id) || '');
    const signature = String((body && body.razorpay_signature) || '');
    if (!orderId || !paymentId || !signature) return { ok: false, reason: 'missing_fields' };
    if (orderId !== order.rzp_order_id) return { ok: false, reason: 'unknown_order' };
    if (!paymentsLib.verifyCheckoutSignature(orderId, paymentId, signature, cfg.keySecret)) {
      await run(`UPDATE bloodmap_orders SET pay_status = 'failed', payment_id = ?, pay_error = 'Bad checkout signature', updated_at = NOW() WHERE id = ? AND pay_status <> 'paid'`, [paymentId, order.id]);
      return { ok: false, reason: 'bad_signature' };
    }
    let payment = await rzp('GET', '/payments/' + encodeURIComponent(paymentId));
    if (payment.order_id !== orderId) return { ok: false, reason: 'mismatch' };
    if (payment.status === 'authorized') {
      payment = await rzp('POST', '/payments/' + encodeURIComponent(paymentId) + '/capture', { amount: Number(order.amount_paise), currency: order.currency });
    }
    if (payment.status === 'failed') {
      await run(`UPDATE bloodmap_orders SET pay_status = 'failed', payment_id = ?, pay_error = ?, updated_at = NOW() WHERE id = ? AND pay_status <> 'paid'`,
        [paymentId, clip(payment.error_description || 'Payment failed', 300), order.id]);
      return { ok: false, reason: 'failed' };
    }
    return markPaid(orderId, payment, 'checkout');
  }

  async function devPay(order) {
    if (!devPayAllowed()) return { error: 'Not available', status: 404 };
    if (isClosed(order)) return CLOSED;
    if (order.pay_status === 'paid') return { ok: true };
    const r = await run(`UPDATE bloodmap_orders SET pay_status = 'paid', payment_id = ?, paid_at = NOW(), mode = 'dev', updated_at = NOW() WHERE id = ? AND pay_status <> 'paid' RETURNING *`,
      ['dev_' + Date.now(), order.id]);
    if (r.rows && r.rows[0]) afterPaid(r.rows[0], 'local test');
    return { ok: true };
  }

  /**
   * Razorpay webhook events for orders the membership payments table does not
   * know. Wired from services/payments.js, so both products share one webhook.
   */
  async function handleWebhookEvent(type, evt) {
    const pay = evt && evt.payload && evt.payload.payment && evt.payload.payment.entity;
    if (type === 'payment.captured' || type === 'order.paid') {
      if (!pay || !pay.order_id) return { ok: false, reason: 'unknown_order' };
      return markPaid(pay.order_id, pay, 'webhook');
    }
    if (type === 'refund.processed' || type === 'refund.created') {
      const ref = evt.payload && evt.payload.refund && evt.payload.refund.entity;
      const paymentId = (ref && ref.payment_id) || (pay && pay.id);
      if (!paymentId) return { ok: true, ignored: 'no_payment' };
      const amount = pay && Number(pay.amount_refunded) > 0 ? Number(pay.amount_refunded) : Number(ref && ref.amount) || 0;
      const r = await run(
        `UPDATE bloodmap_orders SET refunded_paise = GREATEST(COALESCE(refunded_paise, 0), ?),
                pay_status = CASE WHEN GREATEST(COALESCE(refunded_paise, 0), ?) >= amount_paise THEN 'refunded' ELSE pay_status END,
                updated_at = NOW()
          WHERE payment_id = ? RETURNING *`,
        [amount, amount, paymentId]
      );
      const row = r && r.rows && r.rows[0];
      if (row && row.pay_status === 'refunded') {
        // Closed order: free the consultants' time. The link now serves the
        // "refunded" notice and nothing else (see isClosed).
        const freed = await run(`UPDATE bloodmap_bookings SET status = 'cancelled', updated_at = NOW() WHERE order_id = ? AND status = 'booked'`, [row.id]);
        if (type === 'refund.processed') {
          logEvent(row.id, 'refunded', `${inr(amount)} refunded in full. Order closed${freed.rowCount ? ', booked calls cancelled' : ''}.`, 'system');
          tellStaff(row, `↩️ BloodMap refund — ${row.name}`, `${inr(amount)} refunded · ${refOf(row)} · order closed`);
        }
      } else if (row && type === 'refund.processed') {
        logEvent(row.id, 'refunded', `${inr(amount)} refunded (partial)`, 'system');
        tellStaff(row, `↩️ BloodMap part refund — ${row.name}`, `${inr(amount)} refunded · ${refOf(row)}`);
      }
      return { ok: true, refunded: !!row };
    }
    return { ok: true, ignored: type || 'unknown' };
  }

  // ── upload → analysis ─────────────────────────────────────────────────────
  async function ensureShadowUser(order) {
    if (order.user_id) {
      const u = await queryOne('SELECT id FROM users WHERE id = ?', [order.user_id]);
      if (u) return order.user_id;
    }
    const id = uuid();
    const parts = String(order.name || '').trim().split(/\s+/);
    // The password is not a bcrypt hash, so no login can ever match it; the email
    // is on a reserved domain, so no reset, digest or sign-in can reach it.
    await run(
      `INSERT INTO users (id, email, password, first_name, last_name, city, gender, role, approval_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'bloodmap', 'approved')`,
      [id, `bloodmap+${String(order.id).replace(/-/g, '')}@clients.bloodmap.invalid`, 'x:' + crypto.randomBytes(24).toString('hex'),
        parts[0] || 'BloodMap', parts.slice(1).join(' '), order.city || '', order.gender || '']
    );
    await run('UPDATE bloodmap_orders SET user_id = ?, updated_at = NOW() WHERE id = ?', [id, order.id]);
    return id;
  }

  async function uploadReport(order, body) {
    if (isClosed(order)) return CLOSED;
    if (order.pay_status !== 'paid') return { error: 'Payment is not complete for this order.', status: 402 };
    if (order.report_id && !order.reupload_requested_at) return { error: 'Your report is already with us. If you need to replace it, message us on WhatsApp.', status: 409 };

    const files = Array.isArray(body && body.files) ? body.files : [];
    if (!files.length) return { error: 'Please choose your blood report file.', status: 400 };
    const parsed = files.map((f) => ({
      b64: String((f && f.base64) || '').replace(/^data:[^,]*,/, '').replace(/\s/g, ''),
      mime: String((f && f.mime) || '').toLowerCase().slice(0, 80)
    })).filter((f) => f.b64);
    if (!parsed.length) return { error: 'Please choose your blood report file.', status: 400 };
    if (parsed.reduce((n, f) => n + f.b64.length, 0) > MAX_B64_CHARS) return { error: 'These files are too large. Please upload a file under 20 MB.', status: 400 };

    const pdfs = parsed.filter((f) => f.mime.includes('pdf'));
    const images = parsed.filter((f) => /image\/(jpeg|jpg|png)/.test(f.mime));
    if (pdfs.length + images.length !== parsed.length) return { error: 'Please upload a PDF, or JPG / PNG photos of the report.', status: 400 };
    if (pdfs.length > 1 || (pdfs.length && images.length)) return { error: 'Upload one PDF, or up to ' + MAX_IMAGES + ' photos of the same report.', status: 400 };
    if (images.length > MAX_IMAGES) return { error: 'Upload up to ' + MAX_IMAGES + ' photos. For a longer report, please upload the PDF.', status: 400 };

    const date = normalizeReportDate(body && body.reportDate);
    if (date.error) return { error: date.error, status: 400 };

    let b64, mime;
    if (pdfs.length) { b64 = pdfs[0].b64; mime = 'application/pdf'; }
    else if (images.length === 1) { b64 = images[0].b64; mime = images[0].mime.includes('png') ? 'image/png' : 'image/jpeg'; }
    else {
      try {
        b64 = (await imagesToPdf(images.map((f) => Buffer.from(f.b64, 'base64')))).toString('base64');
        mime = 'application/pdf';
      } catch (_) {
        return { error: 'We could not read one of those photos. Please try again or upload the PDF.', status: 400 };
      }
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    const model = (process.env.ANTHROPIC_MODEL_BLOOD || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim();
    const check = await validateBloodReportInput({ apiKey, model, imageBase64: b64, mimeType: mime });
    if (!check.isBloodReport) return { error: 'This does not look like a blood test report. Please upload the lab report with your results.', status: 400 };

    const userId = await ensureShadowUser(order);
    const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
    const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
    const fileDir = path.join(uploadsRoot, 'blood-reports');
    fs.mkdirSync(fileDir, { recursive: true });
    const filePath = path.join(fileDir, `blood_${userId}_${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));

    const intake = {
      goal: clip(body && body.goal, 200),
      medicines: clip(body && body.medicines, 400),
      conditions: clip(body && body.conditions, 400),
      report_date: date.date
    };
    const reportId = uuid();
    // Same row shape as a staff upload, on the Health Map ('graded') variant.
    await run(
      `INSERT INTO blood_analysis_reports (
        id, user_id, blood_report_file_path, symptoms, status,
        user_name, user_email, user_age, user_gender, user_goal, report_date, report_variant
      ) VALUES (?, ?, ?, '[]'::jsonb, 'pending', ?, ?, ?, ?, ?, ?::date, 'graded')`,
      [reportId, userId, filePath, order.name, order.email, order.age || '', order.gender || '', intake.goal, date.date]
    );
    const wasReupload = !!order.reupload_requested_at;
    await run(
      `UPDATE bloodmap_orders SET report_id = ?, intake = ?::jsonb, uploaded_at = NOW(), reupload_note = NULL, reupload_requested_at = NULL, updated_at = NOW() WHERE id = ?`,
      [reportId, JSON.stringify(intake), order.id]
    );
    logEvent(order.id, wasReupload ? 'reuploaded' : 'uploaded', `Blood report ${wasReupload ? 're-' : ''}uploaded (${images.length > 1 ? images.length + ' photos' : ext.toUpperCase()})`);
    tellStaff(order, `🩸 BloodMap report uploaded — ${order.name}`, `${refOf(order)} · analysis started`, 'BLOODMAP_UPLOADED', { goal: intake.goal || '—' });

    // Fire-and-forget, exactly like a staff upload: analysis, then the graded build.
    triggerBloodAnalysis(db, reportId, b64, mime, userId)
      .then(() => graded.buildGradedReportFor(db, reportId))
      .then(() => {
        logEvent(order.id, 'analysed', 'Analysis finished, waiting for expert review', 'system');
        tellStaff(order, `✅ BloodMap analysis ready — ${order.name}`, `Review the Health Map report, then release it to the client. ${refOf(order)}`);
      })
      .catch((err) => {
        console.error('[bloodmap] analysis failed:', err && err.message);
        logEvent(order.id, 'analysis_failed', clip(err && err.message, 300), 'system');
        tellStaff(order, `⚠️ BloodMap analysis failed — ${order.name}`, `Open Blood reports to retry, or ask the client for a clearer copy. ${refOf(order)}`);
      });

    return { ok: true };
  }

  async function reportRow(order) {
    if (!order.report_id) return null;
    return queryOne('SELECT id, status, analysis_last_error FROM blood_analysis_reports WHERE id = ?', [order.report_id]);
  }

  /** The Health Map PDF, only once staff have released it to this client. */
  async function reportPdf(order) {
    if (isClosed(order) || !order.report_id || !order.released_at) return null;
    const chosen = await graded.reportPdfFor(db, order.report_id, ensureHealthReportPdf);
    return chosen && chosen.path && fs.existsSync(chosen.path) ? chosen : null;
  }

  // ── what the client sees ──────────────────────────────────────────────────
  function stageOf(order, report, bookings) {
    if (order.pay_status !== 'paid') return 'payment';
    if (!order.report_id || order.reupload_requested_at) return 'upload';
    if (order.released_at) {
      const done = (r) => bookings[r] && bookings[r].status === 'done';
      return done('doctor') && done('nutritionist') ? 'completed' : 'ready';
    }
    const st = String((report && report.status) || '').toLowerCase();
    return st === 'complete' || st === 'failed' ? 'review' : 'analysing';
  }

  async function view(order) {
    if (isClosed(order)) {
      return {
        ref: refOf(order), stage: 'refunded',
        client: { name: order.name, email: order.email, phone: order.phone, city: order.city },
        payment: { paid: false, status: 'refunded', amount: inr(order.amount_paise), paid_at: order.paid_at, mode: order.mode },
        steps: [], upload: { needed: false, reupload_note: '' }, report: { ready: false, due_by: '', hours: REPORT_HOURS },
        calls: { doctor: { role: 'doctor', status: 'none' }, nutritionist: { role: 'nutritionist', status: 'none' }, can_book: false, cutoff_hours: RESCHEDULE_CUTOFF_HOURS },
        consultants: {}, offers: [], whatsapp: SUPPORT_WHATSAPP
      };
    }
    const [report, bookings, consultants] = await Promise.all([reportRow(order), bookingsFor(order.id), getConsultants()]);
    const stage = stageOf(order, report, bookings);
    const rank = { payment: 0, upload: 1, analysing: 2, review: 3, ready: 4, completed: 5 }[stage];
    const st = (i) => (rank > i ? 'done' : rank === i ? 'current' : 'todo');
    const doc = bookingView(bookings.doctor, 'doctor');
    const nut = bookingView(bookings.nutritionist, 'nutritionist');
    const callState = (b) => (b.status === 'done' ? 'done' : b.status === 'booked' ? 'current' : 'todo');
    return {
      ref: refOf(order),
      stage,
      client: { name: order.name, email: order.email, phone: order.phone, city: order.city },
      payment: { paid: order.pay_status === 'paid', status: order.pay_status, amount: inr(order.amount_paise), paid_at: order.paid_at, mode: order.mode },
      steps: [
        { key: 'paid', label: 'Payment received', state: st(0), at: order.paid_at },
        { key: 'uploaded', label: 'Report uploaded', state: st(1), at: order.uploaded_at },
        { key: 'analysing', label: 'Analysing your markers', state: st(2) },
        { key: 'review', label: 'Expert review', state: st(3) },
        { key: 'ready', label: 'Health Map report ready', state: rank >= 4 ? 'done' : 'todo', at: order.released_at },
        { key: 'doctor', label: 'Doctor call', state: callState(doc), at: doc.starts_at },
        { key: 'nutritionist', label: 'Sports nutritionist call', state: callState(nut), at: nut.starts_at }
      ],
      upload: { needed: stage === 'upload', reupload_note: order.reupload_requested_at ? (order.reupload_note || 'We need a clearer copy of your report.') : '' },
      report: {
        ready: !!order.released_at,
        due_by: order.report_id && !order.released_at ? fmtIST(reportDueAt(order)) : '',
        hours: REPORT_HOURS
      },
      calls: { doctor: doc, nutritionist: nut, can_book: order.pay_status === 'paid' && !!order.report_id, cutoff_hours: RESCHEDULE_CUTOFF_HOURS },
      consultants: { doctor: publicConsultant(consultants.doctor), nutritionist: publicConsultant(consultants.nutritionist) },
      offers: order.released_at ? OFFERS : [],
      whatsapp: SUPPORT_WHATSAPP
    };
  }

  async function publicConfig() {
    const cfg = paymentsLib.config();
    const c = await getConsultants();
    return {
      price_rupees: PRICE_RUPEES,
      currency: CURRENCY,
      pay_enabled: cfg.enabled,
      pay_mode: cfg.enabled ? cfg.mode : null,
      dev_pay: devPayAllowed(),
      report_hours: REPORT_HOURS,
      consultants: { doctor: publicConsultant(c.doctor), nutritionist: publicConsultant(c.nutritionist) },
      whatsapp: SUPPORT_WHATSAPP
    };
  }

  // ── one-time codes ────────────────────────────────────────────────────────
  // Every code is emailed, tied to the single address it was sent to, and can
  // only ever act for that address.
  const hashCode = (purpose, contact, emailAddr, code) =>
    crypto.createHash('sha256').update([purpose, contact, emailAddr, code].join('|')).digest('hex');
  const mailOn = () => !!(email && email.isConfigured && email.isConfigured());

  /** Create a code for (purpose, contact) and email it to `emailAddr`. Returns the code. */
  async function issueCode(purpose, contact, emailAddr, why) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await run(
      `INSERT INTO bloodmap_otps (id, purpose, contact, email, code_hash, expires_at) VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL '${OTP_TTL_MIN} minutes')`,
      [uuid(), purpose, contact, emailAddr, hashCode(purpose, contact, emailAddr, code)]
    );
    if (mailOn()) {
      const html = email.luxuryWrap({
        title: 'Your BloodMap code',
        preheader: 'Your code is ' + code,
        lead: why,
        bodyHtml: `<p style="margin:0;font-size:30px;letter-spacing:8px;color:#c8a44e;font-family:system-ui,sans-serif">${code}</p><p style="margin:14px 0 0;font-size:12px;color:#8a8880">It works for ${OTP_TTL_MIN} minutes. Never share it. If you did not ask for it, ignore this email.</p>`
      });
      email.sendMail(emailAddr, 'Your BloodMap code: ' + code, html, 'Your BloodMap code is ' + code).catch(() => {});
    }
    if (NODE_ENV !== 'production') console.log(`[bloodmap] ${purpose} code for ${emailAddr}: ${code}`);
    return code;
  }

  async function tooManyCodes(purpose, contact) {
    const r = await queryOne(
      `SELECT COUNT(*)::int AS n FROM bloodmap_otps WHERE purpose = ? AND contact = ? AND created_at > NOW() - INTERVAL '15 minutes'`,
      [purpose, contact]
    );
    return !!r && r.n >= 4;
  }

  /**
   * Check a code. On success the matching code is used up and its email returned.
   * A wrong guess counts against every live code for that contact.
   * @returns {Promise<{email:string}|{error:string}>}
   */
  async function checkCode(purpose, contact, code) {
    const cd = String(code || '').replace(/[^0-9]/g, '');
    if (cd.length !== 6) return { error: 'Enter the 6-digit code we emailed you.' };
    const rows = await queryAll(
      `SELECT * FROM bloodmap_otps WHERE purpose = ? AND contact = ? AND expires_at > NOW() AND attempts < ${OTP_MAX_ATTEMPTS} ORDER BY created_at DESC LIMIT 12`,
      [purpose, contact]
    );
    if (!rows.length) return { error: 'That code has expired. Please ask for a new one.' };
    const hit = rows.find((r) => r.code_hash === hashCode(purpose, contact, r.email, cd));
    if (!hit) {
      await run(`UPDATE bloodmap_otps SET attempts = attempts + 1 WHERE purpose = ? AND contact = ? AND expires_at > NOW()`, [purpose, contact]);
      return { error: 'That code is not right. Please check and try again.' };
    }
    await run('DELETE FROM bloodmap_otps WHERE id = ?', [hit.id]);
    return { email: hit.email };
  }

  /** Step before buying: prove the email. */
  async function requestEmailCode(rawEmail) {
    const mail = normEmail(rawEmail);
    if (!mail) return { error: 'Please enter a valid email address.', status: 400 };
    const dev = NODE_ENV !== 'production';
    if (!mailOn() && !dev) return { error: 'We cannot send email right now. Message us on WhatsApp and we will help.', status: 503 };
    if (await tooManyCodes('order', mail)) return { error: 'Too many codes requested. Please wait a few minutes and try again.', status: 429 };
    const code = await issueCode('order', mail, mail, 'Use this code to confirm your email and start your BloodMap order.');
    const out = { ok: true };
    if (dev && !mailOn()) out.dev_code = code;
    return out;
  }

  // ── reopening an order without the link ───────────────────────────────────
  function contactKey(raw) {
    const s = String(raw || '').trim();
    if (s.includes('@')) { const e = normEmail(s); return e ? { kind: 'email', key: e } : null; }
    const p = phoneKey(s);
    return p ? { kind: 'phone', key: p } : null;
  }

  function ordersForContact(c) {
    return queryAll(
      `SELECT * FROM bloodmap_orders WHERE ${c.kind === 'email' ? 'email' : 'phone_key'} = ? AND pay_status IN ('paid', 'refunded') ORDER BY created_at DESC LIMIT 20`,
      [c.key]
    );
  }

  /**
   * Answers the same way whether or not an order exists, with no hint of where a
   * code went, so this cannot be used to find out who is a client.
   *
   * A mobile number can sit on several people's orders (anyone can type any
   * number), so each distinct email among them gets its OWN code. Whoever reads a
   * code can open only the orders on the email it arrived at.
   */
  async function requestCode(rawContact) {
    const c = contactKey(rawContact);
    if (!c) return { error: 'Enter the email or mobile number you used for your order.', status: 400 };
    const out = { ok: true };
    const orders = await ordersForContact(c);
    if (!orders.length || await tooManyCodes('track', c.key)) return out;
    const emails = Array.from(new Set(orders.map((o) => o.email))).slice(0, 3);
    for (const addr of emails) {
      const code = await issueCode('track', c.key, addr, 'Use this code to open your BloodMap order.');
      if (NODE_ENV !== 'production' && !mailOn() && emails.length === 1) out.dev_code = code;
    }
    return out;
  }

  async function verifyCode(rawContact, code) {
    const c = contactKey(rawContact);
    if (!c) return { error: 'Enter the email or mobile number you used for your order.', status: 400 };
    const proof = await checkCode('track', c.key, code);
    if (proof.error) return { error: proof.error, status: 400 };
    // Only orders on the proven email — and, for a mobile lookup, with that mobile too.
    const orders = (await ordersForContact(c)).filter((o) => o.email === proof.email);
    const list = [];
    for (let o of orders) {
      // A lapsed or revoked link is replaced; a working one is handed back as it is.
      if (linkExpired(o)) o = await reissueLink(o);
      const [rep, bk] = await Promise.all([reportRow(o), bookingsFor(o.id)]);
      list.push({ token: o.access_token, ref: refOf(o), created_at: o.created_at, stage: isClosed(o) ? 'refunded' : stageOf(o, rep, bk) });
    }
    return { ok: true, orders: list };
  }

  // ── staff ─────────────────────────────────────────────────────────────────
  async function adminList() {
    const rows = await queryAll(
      `SELECT o.*, r.status AS report_status, r.analysis_last_error
         FROM bloodmap_orders o LEFT JOIN blood_analysis_reports r ON r.id = o.report_id
        WHERE o.pay_status <> 'created' OR o.created_at > NOW() - INTERVAL '2 days'
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT 500`
    );
    const bookings = await queryAll(`SELECT * FROM bloodmap_bookings WHERE status <> 'cancelled'`);
    const now = Date.now();
    return rows.map((o) => {
      const bk = {};
      for (const b of bookings) if (b.order_id === o.id) bk[b.role] = b;
      const stage = isClosed(o) ? 'refunded' : stageOf(o, { status: o.report_status }, bk);
      const flags = [];
      if (o.pay_status === 'paid' && !o.report_id && o.paid_at && now - new Date(o.paid_at).getTime() > 24 * HOUR) flags.push('No upload after 24h');
      if (o.report_id && !o.released_at && String(o.report_status).toLowerCase() === 'failed') flags.push('Analysis failed');
      if (o.report_id && !o.released_at && now > reportDueAt(o).getTime()) flags.push('Report is late');
      if (o.reupload_requested_at) flags.push('Waiting for a clearer copy');
      return {
        id: o.id, ref: refOf(o), name: o.name, phone: o.phone, email: o.email, city: o.city, age: o.age, gender: o.gender,
        pay_status: o.pay_status, amount: inr(o.amount_paise), mode: o.mode, payment_id: o.payment_id,
        created_at: o.created_at, paid_at: o.paid_at, uploaded_at: o.uploaded_at, released_at: o.released_at,
        report_id: o.report_id, report_status: o.report_status || '', intake: parseJson(o.intake) || {},
        stage, flags, admin_notes: o.admin_notes || '',
        consent_at: o.consent_at, consent_version: o.consent_version || '', email_verified: !!o.email_verified_at,
        link_expires_at: o.token_expires_at, link_expired: linkExpired(o),
        due_by: o.report_id && !o.released_at ? fmtIST(reportDueAt(o)) : '',
        calls: {
          doctor: Object.assign(bookingView(bk.doctor, 'doctor'), { id: bk.doctor && bk.doctor.id }),
          nutritionist: Object.assign(bookingView(bk.nutritionist, 'nutritionist'), { id: bk.nutritionist && bk.nutritionist.id })
        }
      };
    });
  }

  async function adminEvents(orderId) {
    return queryAll('SELECT kind, detail, actor, created_at FROM bloodmap_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 100', [orderId]);
  }

  const orderById = (id) => queryOne('SELECT * FROM bloodmap_orders WHERE id = ?', [String(id || '')]);

  async function adminRelease(orderId, who) {
    const order = await orderById(orderId);
    if (!order) return { error: 'Order not found', status: 404 };
    if (isClosed(order)) return { error: 'This order was refunded. Nothing can be released on it.', status: 400 };
    if (order.released_at) return { ok: true, already: true };
    const rep = await reportRow(order);
    if (!rep || String(rep.status).toLowerCase() !== 'complete') return { error: 'The analysis is not complete yet.', status: 400 };
    const chosen = await graded.reportPdfFor(db, order.report_id, ensureHealthReportPdf);
    if (!chosen || !chosen.path || !fs.existsSync(chosen.path)) return { error: 'The report PDF could not be built. Open it in Blood reports and try again.', status: 400 };
    await run('UPDATE bloodmap_orders SET released_at = NOW(), updated_at = NOW() WHERE id = ?', [order.id]);
    logEvent(order.id, 'released', 'Health Map report released to the client', who);
    const bk = await bookingsFor(order.id);
    const booked = (r) => bk[r] && bk[r].status === 'booked';
    tellClient(Object.assign({}, order, { released_at: new Date() }), {
      title: 'Your Health Map report is ready',
      lead: 'your Health Map report has been reviewed and is ready to view and download.',
      lines: [booked('doctor') ? `Your doctor call is on ${fmtIST(bk.doctor.starts_at)} (India time).` : 'Next step: choose a time for your doctor call.'],
      cta: 'View my report'
    });
    return { ok: true };
  }

  async function adminRequestReupload(orderId, note, who) {
    const order = await orderById(orderId);
    if (!order) return { error: 'Order not found', status: 404 };
    if (order.released_at) return { error: 'This report was already released to the client.', status: 400 };
    const msg = clip(note, 300) || 'The copy we received is not clear enough to read every value.';
    await run('UPDATE bloodmap_orders SET reupload_note = ?, reupload_requested_at = NOW(), updated_at = NOW() WHERE id = ?', [msg, order.id]);
    logEvent(order.id, 'reupload_requested', msg, who);
    tellClient(order, {
      title: 'We need a clearer copy of your report',
      lead: 'we could not read your blood report properly. Please upload it again.',
      lines: [msg, 'A PDF from the lab works best. If you only have paper, take one sharp photo per page in good light.'],
      cta: 'Upload again'
    });
    return { ok: true };
  }

  async function adminCall(orderId, role, action, who) {
    const order = await orderById(orderId);
    if (!order) return { error: 'Order not found', status: 404 };
    const b = (await bookingsFor(order.id))[role];
    if (!b || b.status === 'cancelled') return { error: 'No call is booked.', status: 400 };
    const label = ROLE_LABEL[role] || role;
    if (action === 'done') {
      await run(`UPDATE bloodmap_bookings SET status = 'done', updated_at = NOW() WHERE id = ?`, [b.id]);
      logEvent(order.id, 'call_done', `${label} call completed`, who);
    } else if (action === 'reopen') {
      await run(`UPDATE bloodmap_bookings SET status = 'booked', updated_at = NOW() WHERE id = ?`, [b.id]);
      logEvent(order.id, 'call_reopened', `${label} call marked not done`, who);
    } else if (action === 'cancel') {
      await run(`UPDATE bloodmap_bookings SET status = 'cancelled', change_count = 0, updated_at = NOW() WHERE id = ?`, [b.id]);
      logEvent(order.id, 'call_cancelled', `${label} call on ${fmtIST(b.starts_at)} cancelled by staff`, who);
      tellClient(order, {
        title: `Please pick a new time for your ${label.toLowerCase()} call`,
        lead: `we had to cancel your ${label.toLowerCase()} call on ${fmtIST(b.starts_at)}. Please choose a new time that suits you.`,
        cta: 'Choose a new time'
      });
    } else {
      return { error: 'Unknown action', status: 400 };
    }
    return { ok: true };
  }

  async function adminNotes(orderId, notes) {
    await run('UPDATE bloodmap_orders SET admin_notes = ?, updated_at = NOW() WHERE id = ?', [String(notes || '').slice(0, 4000), String(orderId || '')]);
    return { ok: true };
  }

  /** Emails a brand-new link. Any link sent before it stops working. */
  async function adminResendLink(orderId, who) {
    const order = await orderById(orderId);
    if (!order) return { error: 'Order not found', status: 404 };
    if (isClosed(order)) return { error: 'This order was refunded and is closed.', status: 400 };
    const fresh = await reissueLink(order);
    tellClient(fresh, { title: 'Your new BloodMap link', lead: 'here is a new private link to your BloodMap. Links we sent you before no longer work.', cta: 'Open my BloodMap' });
    logEvent(order.id, 'link_resent', 'New private link emailed; earlier links stopped working', who);
    return { ok: true };
  }

  /** Kills the current link without sending a new one. The client gets back in with an email code. */
  async function adminRevokeLink(orderId, who) {
    const order = await orderById(orderId);
    if (!order) return { error: 'Order not found', status: 404 };
    await run('UPDATE bloodmap_orders SET access_token = ?, token_expires_at = NOW(), updated_at = NOW() WHERE id = ?', [newToken(), order.id]);
    logEvent(order.id, 'link_revoked', 'Private link revoked', who);
    return { ok: true };
  }

  // ── nudges ────────────────────────────────────────────────────────────────
  // Paid but nothing uploaded: one reminder after 24h, one after 72h.
  async function sweepReminders() {
    const rows = await queryAll(
      `SELECT * FROM bloodmap_orders
        WHERE pay_status = 'paid' AND report_id IS NULL AND paid_at IS NOT NULL
          AND ((COALESCE(reminder_count, 0) = 0 AND paid_at < NOW() - INTERVAL '24 hours')
            OR (COALESCE(reminder_count, 0) = 1 AND paid_at < NOW() - INTERVAL '72 hours'))
        LIMIT 50`
    );
    for (const o of rows) {
      const r = await run('UPDATE bloodmap_orders SET reminder_count = COALESCE(reminder_count, 0) + 1 WHERE id = ? AND COALESCE(reminder_count, 0) = ?', [o.id, Number(o.reminder_count) || 0]);
      if (!r.rowCount) continue;
      tellClient(o, {
        title: 'Your blood report is still to be uploaded',
        lead: 'your BloodMap is paid for and waiting. Upload your blood report and we will start right away.',
        cta: 'Upload my report'
      });
      logEvent(o.id, 'reminder', 'Upload reminder sent', 'system');
    }
  }

  function startScheduler() {
    const tick = () => sweepReminders().catch((e) => console.warn('[bloodmap] reminder sweep:', e.message));
    const t = setInterval(tick, HOUR);
    if (t.unref) t.unref();
    return t;
  }

  return {
    ensureTables, publicConfig, createOrder, orderByToken, startPayment, verifyPayment, devPay, handleWebhookEvent,
    uploadReport, view, reportPdf, slotsFor, book, requestEmailCode, requestCode, verifyCode, linkExpired,
    adminList, adminEvents, adminRelease, adminRequestReupload, adminCall, adminNotes, adminResendLink, adminRevokeLink,
    getConsultants, saveConsultant, sweepReminders, startScheduler
  };
}

module.exports = {
  createBloodmapService,
  // exported for tests
  phoneKey, phoneE164, normEmail, maskEmail, maskPhone, normalizeReportDate, PRICE_RUPEES, ROLES
};
