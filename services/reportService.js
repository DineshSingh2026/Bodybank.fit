'use strict';

/**
 * Reports module — orchestrator.
 *
 *   previewReport / generateReport / sendReport / listReports / bulk jobs / scheduler
 *
 * Pipeline for one report:
 *   reportData.loadReportBundle  (SQL, read-only)
 *   -> reportScore.scoreDataset  (deterministic BodyBank Score)
 *   -> reportInsights            (rules, then one validated LLM call, rule fallback)
 *   -> reportTemplate            (A4 HTML + chart specs)
 *   -> reportPdf                 (Chrome: charts -> PNG, fit pass, PDF)
 *
 * Storage: PDFs are written to <UPLOADS_DIR>/client-reports/ (that path is 404'd
 * ahead of the public /uploads static mount — see server.js). The row keeps the
 * full score and narrative, so a PDF lost to a redeploy is rebuilt with the same
 * numbers and words. Clients get a revocable, expiring link (/r/report/:token).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./reportScore');
const reportData = require('./reportData');
const insightsSvc = require('./reportInsights');
const template = require('./reportTemplate');
const pdfSvc = require('./reportPdf');

const MODEL_VERSION = 'reports-v1';
const SHARE_DAYS = () => Math.max(1, Math.min(365, parseInt(process.env.REPORT_SHARE_LINK_DAYS || '30', 10) || 30));
const TZ = 'Asia/Kolkata';

const GOAL_LABELS = { fat_loss: 'Fat loss', recomp: 'Recomposition', muscle_gain: 'Muscle gain', performance: 'Performance', general_fitness: 'General fitness' };
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

function todayYmd(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

/** Default period: last completed Mon–Sun week, or last completed calendar month. */
function defaultPeriod(type, refYmd) {
  const ref = refYmd || todayYmd(TZ);
  if (type === 'monthly') {
    const [y, m] = ref.split('-').map(Number);
    const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return { start: `${py}-${String(pm).padStart(2, '0')}-01`, end: `${py}-${String(pm).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
  }
  const dow = new Date(S.dayNum(ref) * 86400000).getUTCDay(); // 0 Sun
  const sinceMonday = (dow + 6) % 7;
  const thisMonday = S.addDays(ref, -sinceMonday);
  return { start: S.addDays(thisMonday, -7), end: S.addDays(thisMonday, -1) };
}

function validatePeriod(type, start, end) {
  const t = type === 'monthly' ? 'monthly' : (type === 'weekly' ? 'weekly' : null);
  if (!t) return { error: "type must be 'weekly' or 'monthly'" };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!start || !end) { const p = defaultPeriod(t); return { type: t, start: p.start, end: p.end }; }
  if (!iso.test(start) || !iso.test(end) || !Number.isFinite(S.dayNum(start)) || !Number.isFinite(S.dayNum(end))) return { error: 'startDate/endDate must be YYYY-MM-DD' };
  const days = S.daysBetween(start, end);
  if (days < 1) return { error: 'endDate must be on or after startDate' };
  if (t === 'weekly' && days > 14) return { error: 'A weekly report covers at most 14 days' };
  if (t === 'monthly' && (days < 20 || days > 35)) return { error: 'A monthly report covers 20–35 days' };
  return { type: t, start, end };
}

function periodLabel(type, start, end) {
  const a = new Date(S.dayNum(start) * 86400000); const b = new Date(S.dayNum(end) * 86400000);
  const isWholeMonth = a.getUTCDate() === 1 && S.addDays(end, 1).slice(8, 10) === '01' && a.getUTCMonth() === b.getUTCMonth();
  if (type === 'monthly' && isWholeMonth) return `${MON_LONG[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const left = `${a.getUTCDate()} ${MON[a.getUTCMonth()]}${sameYear ? '' : ' ' + a.getUTCFullYear()}`;
  return `${left} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Achievements (deterministic)
// ---------------------------------------------------------------------------

function deriveAchievements(bundle, score) {
  const out = [];
  const P = score.pillars;
  const word = score.type === 'monthly' ? 'month' : 'week';
  // Latest personal best per lift, at most two — variety beats a wall of PRs.
  const seen = new Set();
  const prs = [];
  for (const pr of (bundle.prs || []).slice().reverse()) {
    if (seen.has(pr.key)) continue;
    seen.add(pr.key);
    prs.push({ icon: 'trophy', title: `New best: ${pr.label} ${pr.kg} kg`, sub: `Up from ${pr.previousKg} kg — a personal record on ${pr.date.slice(8, 10)}/${pr.date.slice(5, 7)}.` });
    if (prs.length === 2) break;
  }
  const cm = P.consistency.metrics;
  if (cm.longestStreak >= 3) out.push({ icon: 'flame', title: `${cm.longestStreak}-day streak`, sub: `Your longest run of active days this ${word}.` });
  if (cm.perfectDays >= 1) out.push({ icon: 'star', title: `${cm.perfectDays} perfect ${cm.perfectDays === 1 ? 'day' : 'days'}`, sub: 'Checked in, logged every meal and finished the planned session.' });
  const wm = P.workout.metrics;
  if (wm.planned > 0 && wm.completed >= wm.planned) out.push({ icon: 'check', title: 'Every planned session done', sub: `${wm.completed} of ${wm.planned} workouts completed.` });
  const ci = P.checkin.metrics;
  if (ci.checkinDays >= score.period.days) out.push({ icon: 'check', title: 'Checked in every day', sub: `${ci.checkinDays} of ${score.period.days} daily check-ins.` });
  const nm = P.nutrition.metrics;
  if (nm.proteinHitDays != null && nm.proteinHitDays >= Math.ceil(score.period.days * 5 / 7)) out.push({ icon: 'leaf', title: `Protein on target ${nm.proteinHitDays} days`, sub: `Hit ${nm.proteinTarget} g or close to it most days.` });
  if (ci.sleepOkDays >= Math.ceil(score.period.days * 5 / 7)) out.push({ icon: 'moon', title: `${ci.sleepOkDays} nights of 7 h+ sleep`, sub: 'Recovery is where the progress is built.' });
  if (ci.stepsOkDays >= Math.ceil(score.period.days * 5 / 7)) out.push({ icon: 'steps', title: `Steps target hit ${ci.stepsOkDays} days`, sub: `${Number(ci.stepsTarget).toLocaleString('en-IN')}+ steps on most days.` });
  const ym = P.yoga.metrics;
  if (ym.sessions >= ym.planned && ym.sessions > 0) out.push({ icon: 'leaf', title: `${ym.sessions} yoga sessions`, sub: `${ym.minutes} minutes of mobility work.` });
  const b = P.health.metrics.body;
  if (b && ((b.direction === 'lose' && b.changeKg < 0) || (b.direction === 'gain' && b.changeKg > 0))) {
    out.push({ icon: 'trophy', title: `${b.changeKg > 0 ? '+' : ''}${b.changeKg} kg toward your goal`, sub: `${b.startKg} → ${b.endKg} kg this ${word}.` });
  }
  const coins = (bundle.coins || []).reduce((a, c) => a + (c.coins > 0 ? c.coins : 0), 0);
  if (coins > 0) out.push({ icon: 'coin', title: `${coins} BB coins earned`, sub: 'Rewards for showing up and logging.' });
  const words = (bundle.sunday || []).find((s) => s.achievements && s.achievements.length > 3);
  if (words) out.push({ icon: 'quote', title: 'In your words', sub: words.achievements.length > 110 ? words.achievements.slice(0, 107).trim() + '…' : words.achievements });
  // Order: the two strongest habit wins, then personal bests, then the rest.
  return out.slice(0, 2).concat(prs, out.slice(2)).slice(0, 6);
}

// ---------------------------------------------------------------------------
// Model + rendering
// ---------------------------------------------------------------------------

function photoPair(bundle, score, uploadsDir) {
  const win = require('./reportCharts').trendWindow(score);
  const list = (bundle.photos || []).filter((p) => p.front && S.dayNum(p.date) >= S.dayNum(win.start) && S.dayNum(p.date) <= S.dayNum(score.period.end));
  if (!list.length) return [];
  const pick = list.length > 1 ? [list[0], list[list.length - 1]] : [list[0]];
  const out = [];
  pick.forEach((p, i) => {
    let src = p.src || null;
    if (!src) {
      const file = reportData.resolvePhotoFile(p.front, uploadsDir);
      if (file) {
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        try { src = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`; } catch (_) { src = null; }
      }
    }
    if (src) out.push({ id: 'photo-' + i, src, label: `${p.date.slice(8, 10)}/${p.date.slice(5, 7)}/${p.date.slice(0, 4)}` });
  });
  return out;
}

function buildModel(bundle, score, insights, opts) {
  const o = opts || {};
  const word = score.type === 'monthly' ? 'month' : 'week';
  const weights = (bundle.history.weights || []).filter((w) => S.dayNum(w.date) <= S.dayNum(score.period.end));
  const prevPillars = score.detail.previousPillars;
  return {
    type: score.type,
    word,
    titleShort: score.type === 'monthly' ? 'Monthly Progress Report' : 'Weekly Progress Report',
    periodLabel: periodLabel(score.type, score.period.start, score.period.end),
    periodDays: score.period.days,
    client: {
      name: bundle.user.name,
      firstName: bundle.user.firstName,
      goalLabel: GOAL_LABELS[bundle.user.goalType] || (bundle.user.goalType ? String(bundle.user.goalType).replace(/_/g, ' ') : '')
    },
    goalWeight: bundle.goal && bundle.goal.targetWeightKg != null ? bundle.goal.targetWeightKg : null,
    latestWeight: weights.length ? weights[weights.length - 1].weightKg : null,
    coachName: insightsSvc.COACH_NAME(),
    score,
    insights,
    bundle,
    achievements: deriveAchievements(bundle, score),
    photoPair: photoPair(bundle, score, o.uploadsDir),
    prevMetrics: (k) => (score.previous && prevPillars && prevPillars[k] ? prevPillars[k].metrics : null)
  };
}

/**
 * Bundle -> fitted HTML (+ optional PDF). Works on a real bundle from the DB or
 * a seeded one (samples, tests).
 */
async function renderFromBundle(bundle, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const T = {};
  let stage = 'score';
  const secs = (ms) => (ms / 1000).toFixed(1) + 's';
  const step = async (name, fn) => {
    stage = name;
    const t = Date.now();
    try { return await fn(); } finally { T[name] = Date.now() - t; }
  };
  const who = `${bundle && bundle.type} report for ${bundle && bundle.user && bundle.user.id}`;
  try {
    const score = o.score || S.scoreDataset(bundle.current, bundle.previous, bundle.previous2, bundle.type);
    let insights = o.insights || await step('insights', () => insightsSvc.buildInsights(score, bundle, { ai: o.ai !== false, userId: bundle.user.id }));
    insights = insightsSvc.applyEdits(insights, o.edits);
    const model = buildModel(bundle, score, insights, o);
    // Pass 1: lay the pages out with empty chart slots and measure the free space.
    // Pass 2: give that space to the charts and draw them at their final size.
    const probeDoc = template.buildDocument(model);
    const probe = await step('layout', () => pdfSvc.probeLayout(probeDoc.render({})));
    const grow = pdfSvc.growFromProbe(probe);
    const doc = template.buildDocument(model, grow);
    const drawn = await step('charts', () => pdfSvc.renderCharts(doc.specs, doc.photos, template.assets().fonts));
    const html = doc.render(drawn);
    const result = { score, insights, model, sections: doc.sections, chartErrors: drawn.errors || {} };
    if (o.pdf) {
      const out = await step('print', () => pdfSvc.htmlToPdf(html));
      Object.assign(result, { pdf: out.pdf, warnings: out.warnings, pages: out.pages });
    } else {
      const out = await step('fit', () => pdfSvc.finalize(html));
      Object.assign(result, { html: out.html, warnings: out.warnings, pages: out.pages });
    }
    result.ms = Date.now() - t0;
    result.timings = T;
    if (!process.env.REPORTS_QUIET) {
      console.log(`[reports] rendered ${who}: ${result.pages} pages in ${secs(result.ms)} (${Object.keys(T).map((k) => k + ' ' + secs(T[k])).join(', ')})`);
    }
    if (pdfSvc.noteRender) pdfSvc.noteRender({ ok: true, ms: result.ms, timings: T, at: new Date().toISOString() });
    return result;
  } catch (err) {
    if (!err.stage) err.stage = stage;
    console.error(`[reports] render failed for ${who} at "${stage}" after ${secs(Date.now() - t0)} (${Object.keys(T).map((k) => k + ' ' + secs(T[k])).join(', ') || 'no step finished'}): ${err.message}`);
    if (pdfSvc.noteRender) pdfSvc.noteRender({ ok: false, stage, code: err.code || null, error: String(err.message).slice(0, 300), at: new Date().toISOString() });
    throw err;
  }
}

/** The editable narrative the admin UI pre-fills. */
function draftOf(insights) {
  return { summary: insights.summary, closingNote: insights.closingNote, targets: insights.targets, source: insights.source, aiError: insights.aiError || null };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function ensureReportTables(db) {
  const q = (sql) => db.run(sql).catch((e) => { if (!/already exists/i.test(e.message)) console.warn('[reports] ddl:', e.message); });
  await q(`CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('weekly','monthly')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    score INTEGER,
    grade TEXT,
    pillars_json JSONB,
    pdf_url TEXT,
    edits_json JSONB,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    sent_channels JSONB DEFAULT '[]'::jsonb
  )`);
  for (const col of [
    ['insights_json', 'JSONB'], ['pdf_path', 'TEXT'], ['generated_by', 'TEXT'], ['source', "TEXT DEFAULT 'manual'"],
    ['ai_source', 'TEXT'], ['model_version', 'TEXT'], ['pages', 'INTEGER'], ['render_ms', 'INTEGER'],
    ['layout_warnings', 'JSONB'], ['share_token', 'TEXT'], ['share_expires_at', 'TIMESTAMPTZ'],
    ['share_last_viewed_at', 'TIMESTAMPTZ'], ['send_log', 'JSONB'], ['sent_by', 'TEXT']
  ]) {
    await q(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS ${col[0]} ${col[1]}`);
  }
  await q('CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, generated_at DESC)');
  await q('CREATE INDEX IF NOT EXISTS idx_reports_period ON reports(type, period_start, period_end)');
  await q("CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_share_token ON reports(share_token) WHERE share_token IS NOT NULL AND share_token <> ''");
  // Per-client opt-in for the Monday / 1st-of-month scheduler. Off by default:
  // nothing reaches a client until an admin switches it on for them.
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_reports BOOLEAN DEFAULT FALSE');
}

function storageDir(uploadsDir) {
  const root = uploadsDir || process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
  const dir = path.join(root, 'client-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileNameFor(row, userName) {
  const slug = String(userName || 'client').normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'client';
  const kind = row.type === 'monthly' ? 'Monthly' : 'Weekly';
  return `BodyBank_${kind}_Report_${slug}_${row.period_start}_${row.period_end}.pdf`;
}

function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    // DATE columns arrive at local midnight; format in local time.
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

function parseJ(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }

function publicRow(r) {
  if (!r) return null;
  const pillars = parseJ(r.pillars_json) || {};
  return {
    id: r.id,
    userId: r.user_id,
    clientName: r.client_name || undefined,
    type: r.type,
    periodStart: ymd(r.period_start),
    periodEnd: ymd(r.period_end),
    score: r.score,
    grade: r.grade,
    pillars: pillars.pillars ? Object.fromEntries(Object.entries(pillars.pillars).map(([k, p]) => [k, { score: p.score, grade: p.grade, trend: p.trend, deltaPct: p.deltaPct }])) : null,
    pdfUrl: r.pdf_url,
    edits: parseJ(r.edits_json),
    generatedAt: r.generated_at,
    sentAt: r.sent_at,
    sentChannels: parseJ(r.sent_channels) || [],
    source: r.source || 'manual',
    aiSource: r.ai_source || null,
    pages: r.pages || null,
    layoutWarnings: (parseJ(r.layout_warnings) || []).length,
    shareExpiresAt: r.share_expires_at || null
  };
}

function storedScore(row) {
  const s = parseJ(row.pillars_json);
  return s && s.pillars && s.period ? s : null;
}

// ---------------------------------------------------------------------------
// The service factory (DB-bound)
// ---------------------------------------------------------------------------

/**
 * @param {object} deps { db: {run, queryOne, queryAll}, uploadsDir, notify, notifyAgent,
 *                        sendMail, luxuryWrap, sendWhatsAppWithFallback, waStore, uuid, publicUrl }
 */
function createReportService(deps) {
  const d = deps || {};
  const db = d.db;
  const uuid = d.uuid || (() => crypto.randomUUID());
  const fire = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* never blocks */ } };
  const baseUrl = (reqBase) => String(reqBase || d.publicUrl || process.env.PUBLIC_URL || process.env.APP_ORIGIN || 'https://bodybank.fit').replace(/\/$/, '');

  async function loadBundle(userId, type, start, end) {
    return reportData.loadReportBundle(userId, start, end, type, { db });
  }

  async function preview({ userId, type, startDate, endDate, edits, ai }) {
    const p = validatePeriod(type, startDate, endDate);
    if (p.error) { const e = new Error(p.error); e.status = 400; throw e; }
    const bundle = await loadBundle(userId, p.type, p.start, p.end);
    // With edits supplied the admin already has a narrative: no second LLM call.
    const hasEdits = edits && (edits.summary || edits.closingNote || (Array.isArray(edits.targets) && edits.targets.length));
    const res = await renderFromBundle(bundle, { edits, ai: ai !== false && !hasEdits, uploadsDir: d.uploadsDir });
    return {
      html: res.html, score: res.score.total, grade: res.score.grade, draft: draftOf(res.insights),
      period: { type: p.type, start: p.start, end: p.end, label: periodLabel(p.type, p.start, p.end) },
      sections: res.sections, pages: res.pages, warnings: res.warnings, ms: res.ms,
      client: { id: bundle.user.id, name: bundle.user.name, email: bundle.user.email, phone: bundle.user.phone }
    };
  }

  async function writePdf(row, pdf, userName) {
    const dir = storageDir(d.uploadsDir);
    const file = path.join(dir, `${row.id}.pdf`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, pdf);
    fs.renameSync(tmp, file);
    return { file, name: fileNameFor(row, userName) };
  }

  async function generate({ userId, type, startDate, endDate, edits, generatedBy, source, ai, draft }) {
    const p = validatePeriod(type, startDate, endDate);
    if (p.error) { const e = new Error(p.error); e.status = 400; throw e; }
    const bundle = await loadBundle(userId, p.type, p.start, p.end);
    const score = S.scoreDataset(bundle.current, bundle.previous, bundle.previous2, p.type);
    // A narrative the admin already reviewed (draft/edits) is used as-is.
    let insights = await insightsSvc.buildInsights(score, bundle, { ai: false, userId });
    const e = edits || {};
    const haveNarrative = draft || e.summary || e.closingNote || (Array.isArray(e.targets) && e.targets.length);
    if (!haveNarrative && ai !== false) insights = await insightsSvc.buildInsights(score, bundle, { ai: true, userId });
    if (draft) insights = insightsSvc.applyEdits(insights, draft);
    const id = uuid();
    const res = await renderFromBundle(bundle, { score, insights, edits: e, pdf: true, uploadsDir: d.uploadsDir });
    const row = { id, type: p.type, period_start: p.start, period_end: p.end };
    await writePdf(row, res.pdf, bundle.user.name);
    const pdfUrl = `/api/admin/reports/${id}/pdf`;
    const scoreToStore = Object.assign({}, score);
    await db.run(
      `INSERT INTO reports (id, user_id, type, period_start, period_end, score, grade, pillars_json, pdf_url, edits_json,
                            generated_at, sent_channels, insights_json, pdf_path, generated_by, source, ai_source, model_version,
                            pages, render_ms, layout_warnings)
       VALUES (?, ?, ?, ?::date, ?::date, ?, ?, ?::jsonb, ?, ?::jsonb, NOW(), '[]'::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
      [id, userId, p.type, p.start, p.end, score.total, score.grade, JSON.stringify(scoreToStore), pdfUrl,
        JSON.stringify(e && Object.keys(e).length ? e : null), JSON.stringify(res.insights), `${id}.pdf`, generatedBy || null,
        source || 'manual', res.insights.source, MODEL_VERSION, res.pages || null, res.ms || null, JSON.stringify(res.warnings || [])]
    );
    const event = {
      report_id: id, user_id: userId, name: bundle.user.name, email: bundle.user.email, phone: bundle.user.phone,
      type: p.type, period_start: p.start, period_end: p.end, score: score.total, grade: score.grade, source: source || 'manual'
    };
    if (d.notifyAgent) fire(() => d.notifyAgent('REPORT_GENERATED', event));
    if (d.notify && (source || 'manual') === 'manual') fire(() => d.notify('REPORT_GENERATED', event));
    return { reportId: id, url: pdfUrl, score: score.total, grade: score.grade, pages: res.pages, warnings: res.warnings, ms: res.ms, aiSource: res.insights.source };
  }

  async function getRow(id) {
    return db.queryOne(
      `SELECT r.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS client_name,
              u.email AS client_email, u.phone AS client_phone, u.first_name AS client_first
         FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?`, [id]);
  }

  /** The PDF bytes for a report — rebuilt from the stored score + narrative if the file is gone. */
  async function pdfFor(id) {
    const row = await getRow(id);
    if (!row) return null;
    const dir = storageDir(d.uploadsDir);
    const file = path.join(dir, `${row.id}.pdf`);
    if (fs.existsSync(file)) return { file, name: fileNameFor({ type: row.type, period_start: ymd(row.period_start), period_end: ymd(row.period_end) }, row.client_name), row };
    const start = ymd(row.period_start); const end = ymd(row.period_end);
    const bundle = await loadBundle(row.user_id, row.type, start, end);
    const score = storedScore(row) || S.scoreDataset(bundle.current, bundle.previous, bundle.previous2, row.type);
    const insights = parseJ(row.insights_json) || await insightsSvc.buildInsights(score, bundle, { ai: false });
    const res = await renderFromBundle(bundle, { score, insights, edits: parseJ(row.edits_json), pdf: true, uploadsDir: d.uploadsDir });
    await writePdf({ id: row.id }, res.pdf, row.client_name);
    return { file, name: fileNameFor({ type: row.type, period_start: start, period_end: end }, row.client_name), row };
  }

  async function ensureShareLink(row) {
    const valid = row.share_token && row.share_expires_at && new Date(row.share_expires_at).getTime() > Date.now() + 24 * 3600 * 1000;
    if (valid) return { token: row.share_token, expiresAt: row.share_expires_at };
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_DAYS() * 86400000).toISOString();
    await db.run('UPDATE reports SET share_token = ?, share_expires_at = ?::timestamptz WHERE id = ?', [token, expiresAt, row.id]);
    return { token, expiresAt };
  }

  async function revokeShareLink(id) {
    await db.run('UPDATE reports SET share_token = NULL, share_expires_at = NULL WHERE id = ?', [id]);
  }

  async function byShareToken(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
    const row = await db.queryOne('SELECT id, share_expires_at FROM reports WHERE share_token = ?', [token]);
    if (!row || !row.share_expires_at || new Date(row.share_expires_at).getTime() < Date.now()) return null;
    db.run('UPDATE reports SET share_last_viewed_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
    return pdfFor(row.id);
  }

  function whatsappText(row, url) {
    const first = String(row.client_first || '').trim() || 'there';
    const kind = row.type === 'monthly' ? 'monthly' : 'weekly';
    const ins = parseJ(row.insights_json) || {};
    const edits = parseJ(row.edits_json) || {};
    const summary = (Array.isArray(edits.summary) ? edits.summary : (typeof edits.summary === 'string' ? edits.summary.split('\n') : ins.summary)) || [];
    const second = summary[1] ? ` ${String(summary[1]).trim()}` : '';
    return `Hi ${first}, your ${kind} BodyBank progress report is ready — score ${row.score} (${row.grade}).${second}\n\nOpen your report: ${url}`;
  }

  async function send(id, { channels, sentBy, reqBase }) {
    const want = Array.from(new Set((Array.isArray(channels) ? channels : []).filter((c) => c === 'email' || c === 'whatsapp')));
    if (!want.length) { const e = new Error("channels must include 'email' and/or 'whatsapp'"); e.status = 400; throw e; }
    const row = await getRow(id);
    if (!row) { const e = new Error('Report not found'); e.status = 404; throw e; }
    const pdf = await pdfFor(id);
    const link = await ensureShareLink(row);
    const url = `${baseUrl(reqBase)}/r/report/${link.token}`;
    const results = {};
    const kindTitle = row.type === 'monthly' ? 'Monthly' : 'Weekly';
    const periodTxt = periodLabel(row.type, ymd(row.period_start), ymd(row.period_end));

    if (want.includes('email')) {
      if (!row.client_email) results.email = { ok: false, reason: 'no_email' };
      else if (!d.sendMail) results.email = { ok: false, reason: 'email_not_configured' };
      else {
        const esc = template.esc;
        const ins = parseJ(row.insights_json) || {};
        const edits = parseJ(row.edits_json) || {};
        const lines = (Array.isArray(edits.summary) ? edits.summary : (typeof edits.summary === 'string' ? edits.summary.split('\n') : ins.summary)) || [];
        const bodyHtml = `<p style="margin:0 0 14px">Your BodyBank Score for ${esc(periodTxt)} is <strong style="color:#c8a44e">${esc(row.score)} (${esc(row.grade)})</strong>.</p>`
          + (lines.length ? `<ul style="margin:0 0 14px;padding-left:18px">${lines.slice(0, 3).map((l) => `<li style="margin:0 0 6px">${esc(l)}</li>`).join('')}</ul>` : '')
          + '<p style="margin:0">Your full report is attached as a PDF, and you can also open it with the button below.</p>';
        const html = d.luxuryWrap ? d.luxuryWrap({ title: `Your ${kindTitle} Progress Report`, preheader: `Score ${row.score} (${row.grade}) — ${periodTxt}`, lead: `Hi ${row.client_first || 'there'},`, bodyHtml, ctaLabel: 'Open your report', ctaUrl: url }) : bodyHtml;
        const text = `Hi ${row.client_first || 'there'}, your ${kindTitle.toLowerCase()} BodyBank report (${periodTxt}) is attached. Score ${row.score} (${row.grade}). Open it online: ${url}`;
        let ok = false;
        try {
          ok = await d.sendMail(row.client_email, `Your BodyBank ${kindTitle} Report — ${periodTxt}`, html, text, [{ filename: pdf.name, content: fs.readFileSync(pdf.file), contentType: 'application/pdf' }]);
        } catch (err) { ok = false; }
        results.email = ok ? { ok: true } : { ok: false, reason: 'send_failed' };
      }
    }

    if (want.includes('whatsapp')) {
      const phone = String(row.client_phone || '').trim();
      if (!phone || phone.replace(/\D/g, '').length < 8) results.whatsapp = { ok: false, reason: 'no_phone' };
      else if (!d.sendWhatsAppWithFallback) results.whatsapp = { ok: false, reason: 'whatsapp_not_configured' };
      else {
        const text = whatsappText(row, url);
        let r;
        try {
          r = await d.sendWhatsAppWithFallback(text, { to: phone, templateSid: process.env.TWILIO_CLIENT_REPORT_TEMPLATE_SID || undefined });
        } catch (err) { r = { ok: false, reason: 'send_failed', error: err.message }; }
        results.whatsapp = r && r.ok ? { ok: true, sid: r.sid } : { ok: false, reason: (r && r.reason) || 'send_failed', code: r && r.code };
        // Hand the message to the Grok WhatsApp agent: it lands in the client's
        // agent thread (wa_messages), so a reply to the report is answered in
        // context — the same path approved agent drafts are recorded on.
        if (r && r.ok && d.waStore && d.waStore.insertMessage) {
          const digits = phone.replace(/\D/g, '');
          fire(() => d.waStore.insertMessage({
            client_id: row.user_id, phone: digits.length === 10 ? '+91' + digits : '+' + digits,
            direction: 'outbound', body: text, twilio_sid: r.sid || '', unmatched: false
          }));
        }
      }
    }

    const okChannels = Object.keys(results).filter((k) => results[k] && results[k].ok);
    const prevCh = parseJ(row.sent_channels) || [];
    const merged = Array.from(new Set(prevCh.concat(okChannels)));
    if (okChannels.length) {
      await db.run('UPDATE reports SET sent_at = NOW(), sent_channels = ?::jsonb, send_log = ?::jsonb, sent_by = ? WHERE id = ?',
        [JSON.stringify(merged), JSON.stringify({ at: new Date().toISOString(), results }), sentBy || null, id]);
    } else {
      await db.run('UPDATE reports SET send_log = ?::jsonb WHERE id = ?', [JSON.stringify({ at: new Date().toISOString(), results }), id]);
    }
    const event = {
      report_id: id, user_id: row.user_id, name: row.client_name, email: row.client_email, phone: row.client_phone,
      type: row.type, period_start: ymd(row.period_start), period_end: ymd(row.period_end), score: row.score, grade: row.grade,
      channels: okChannels, failed: Object.keys(results).filter((k) => !results[k].ok), link_expires_at: link.expiresAt
    };
    if (okChannels.length) {
      if (d.notifyAgent) fire(() => d.notifyAgent('REPORT_SENT', event));
      if (d.notify) fire(() => d.notify('REPORT_SENT', event));
    }
    return { ok: okChannels.length > 0, results, sentChannels: merged, link: url, linkExpiresAt: link.expiresAt };
  }

  async function list({ userId, limit }) {
    const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const rows = userId
      ? await db.queryAll(`SELECT r.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS client_name
                             FROM reports r JOIN users u ON u.id = r.user_id WHERE r.user_id = ? ORDER BY r.generated_at DESC LIMIT ?`, [userId, lim])
      : await db.queryAll(`SELECT r.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS client_name
                             FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.generated_at DESC LIMIT ?`, [lim]);
    return rows.map(publicRow);
  }

  async function setAutoReports(userId, on) {
    await db.run('UPDATE users SET auto_reports = ? WHERE id = ?', [!!on, userId]);
    const r = await db.queryOne('SELECT id, auto_reports FROM users WHERE id = ?', [userId]);
    return r ? { userId: r.id, autoReports: !!r.auto_reports } : null;
  }

  const ACTIVE_CLIENT_SQL = `u.role = 'user'
    AND (u.approval_status IS NULL OR u.approval_status = 'approved')
    AND (u.email NOT LIKE '%@test.bodybank.fit')
    AND (LOWER(COALESCE(u.first_name, '')) NOT LIKE '%e2e%')
    AND COALESCE(u.suspended, FALSE) = FALSE
    AND (u.subscription_status IS NULL OR u.subscription_status NOT IN ('canceled', 'expired'))`;

  async function clients({ q, limit }) {
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 300));
    const term = String(q || '').trim().toLowerCase();
    const params = [];
    let where = ACTIVE_CLIENT_SQL;
    if (term) {
      where += ` AND (LOWER(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) LIKE ? OR LOWER(u.email) LIKE ? OR regexp_replace(COALESCE(u.phone,''), '[^0-9]', '', 'g') LIKE ?)`;
      params.push(`%${term}%`, `%${term}%`, `%${term.replace(/\D/g, '') || '~'}%`);
    }
    params.push(lim);
    const rows = await db.queryAll(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, COALESCE(u.auto_reports, FALSE) AS auto_reports,
              (SELECT MAX(r.generated_at) FROM reports r WHERE r.user_id = u.id) AS last_report_at
         FROM users u WHERE ${where}
        ORDER BY LOWER(COALESCE(u.first_name,'')), LOWER(COALESCE(u.last_name,'')) LIMIT ?`, params);
    return rows.map((r) => ({
      id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email, email: r.email, phone: r.phone,
      autoReports: !!r.auto_reports, lastReportAt: r.last_report_at
    }));
  }

  // ---- bulk jobs (in memory; a job survives only this process) -------------
  const jobs = new Map();
  function jobView(j) {
    return {
      jobId: j.id, type: j.type, period: j.period, status: j.status, total: j.total, done: j.done, failed: j.failed,
      progressPct: j.total ? Math.round(((j.done + j.failed) / j.total) * 100) : 100,
      startedAt: j.startedAt, finishedAt: j.finishedAt, results: j.results.slice(-500)
    };
  }

  async function startBulk({ type, period, startDate, endDate, generatedBy, onlyAuto, sendAfter, channels, source }) {
    const pr = period && period.start ? period : { start: startDate, end: endDate };
    const p = validatePeriod(type, pr.start, pr.end);
    if (p.error) { const e = new Error(p.error); e.status = 400; throw e; }
    for (const j of jobs.values()) {
      if (j.status === 'running') { const e = new Error('A bulk run is already in progress'); e.status = 409; e.jobId = j.id; throw e; }
    }
    const list = await db.queryAll(`SELECT u.id, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
                                      FROM users u WHERE ${ACTIVE_CLIENT_SQL}${onlyAuto ? ' AND COALESCE(u.auto_reports, FALSE) = TRUE' : ''}
                                     ORDER BY u.created_at`);
    const job = { id: uuid(), type: p.type, period: { start: p.start, end: p.end }, status: 'running', total: list.length, done: 0, failed: 0, results: [], startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(job.id, job);
    // Keep the map small.
    if (jobs.size > 20) { const oldest = Array.from(jobs.keys())[0]; if (oldest !== job.id) jobs.delete(oldest); }
    (async () => {
      for (const c of list) {
        try {
          const r = await generate({ userId: c.id, type: p.type, startDate: p.start, endDate: p.end, generatedBy, source: source || 'bulk', ai: true });
          let sent = null;
          if (sendAfter) {
            try { sent = await send_(r.reportId, channels); } catch (err) { sent = { ok: false, error: err.message }; }
          }
          job.done += 1;
          job.results.push({ userId: c.id, name: c.name, ok: true, reportId: r.reportId, score: r.score, grade: r.grade, sent: sent ? sent.ok : undefined });
        } catch (err) {
          job.failed += 1;
          job.results.push({ userId: c.id, name: c.name, ok: false, error: String(err.message || err).slice(0, 160) });
        }
      }
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      if (d.notify) fire(() => d.notify('REPORT_BULK_COMPLETE', { type: p.type, period: `${p.start} → ${p.end}`, total: job.total, done: job.done, failed: job.failed, source: source || 'bulk', action: 'reports_bulk_' + job.id }));
    })().catch((err) => { job.status = 'error'; job.error = err.message; job.finishedAt = new Date().toISOString(); });
    return jobView(job);
  }
  const send_ = (id, channels) => send(id, { channels: channels && channels.length ? channels : ['email', 'whatsapp'], sentBy: 'scheduler' });

  function getJob(id) { const j = jobs.get(id); return j ? jobView(j) : null; }

  /** node-cron entry points: generate + send for clients with auto_reports on. */
  async function runScheduled(type) {
    const p = defaultPeriod(type);
    // Idempotent per period: a client who already has a scheduled report for it is skipped by the unique check below.
    const already = await db.queryAll(`SELECT user_id FROM reports WHERE type = ? AND period_start = ?::date AND period_end = ?::date AND source = 'scheduler'`, [type, p.start, p.end]);
    if (already.length) {
      console.log(`[reports] scheduler: ${type} ${p.start}..${p.end} already has ${already.length} scheduled report(s); running for the rest`);
    }
    const skip = new Set(already.map((r) => r.user_id));
    const job = await startBulkFiltered({ type, p, skip });
    return job;
  }

  async function startBulkFiltered({ type, p, skip }) {
    const list = (await db.queryAll(`SELECT u.id, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
                                       FROM users u WHERE ${ACTIVE_CLIENT_SQL} AND COALESCE(u.auto_reports, FALSE) = TRUE ORDER BY u.created_at`))
      .filter((c) => !skip.has(c.id));
    const job = { id: uuid(), type, period: { start: p.start, end: p.end }, status: 'running', total: list.length, done: 0, failed: 0, results: [], startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(job.id, job);
    for (const c of list) {
      try {
        const r = await generate({ userId: c.id, type, startDate: p.start, endDate: p.end, generatedBy: 'scheduler', source: 'scheduler', ai: true });
        const s = await send_(r.reportId, ['email', 'whatsapp']).catch((err) => ({ ok: false, error: err.message }));
        job.done += 1;
        job.results.push({ userId: c.id, name: c.name, ok: true, reportId: r.reportId, score: r.score, grade: r.grade, sent: !!(s && s.ok) });
      } catch (err) {
        job.failed += 1;
        job.results.push({ userId: c.id, name: c.name, ok: false, error: String(err.message || err).slice(0, 160) });
      }
    }
    job.status = 'done'; job.finishedAt = new Date().toISOString();
    if (list.length && d.notify) fire(() => d.notify('REPORT_BULK_COMPLETE', { type, period: `${p.start} → ${p.end}`, total: job.total, done: job.done, failed: job.failed, source: 'scheduler', action: 'reports_sched_' + job.id }));
    return jobView(job);
  }

  function startScheduler(cron) {
    if (!cron || String(process.env.REPORTS_SCHEDULER_ENABLED || 'true').toLowerCase() === 'false') return false;
    const guard = (type) => () => runScheduled(type).catch((e) => console.warn(`[reports] ${type} scheduler failed:`, e.message));
    cron.schedule('0 6 * * 1', guard('weekly'), { timezone: TZ });
    cron.schedule('0 6 1 * *', guard('monthly'), { timezone: TZ });
    return true;
  }

  return {
    preview, generate, send, list, pdfFor, getRow, byShareToken, ensureShareLink, revokeShareLink,
    setAutoReports, clients, startBulk, getJob, runScheduled, startScheduler,
    diagnostics: (o) => pdfSvc.diagnostics(o),
    ensureTables: async () => {
      await ensureReportTables(db);
      // Fetch/verify headless Chrome in the background at boot so the first
      // preview after a deploy does not wait for a download (or fail on it).
      pdfSvc.ensureBrowser()
        .then((exe) => console.log('[reports] headless Chrome ready:', exe))
        .catch((err) => console.error('[reports] headless Chrome unavailable:', err.message));
    }
  };
}

module.exports = {
  createReportService,
  ensureReportTables,
  renderFromBundle,
  buildModel,
  deriveAchievements,
  defaultPeriod,
  validatePeriod,
  periodLabel,
  draftOf,
  MODEL_VERSION
};
