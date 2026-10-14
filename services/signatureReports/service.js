'use strict';

/**
 * Signature reports — workflow service (DB-bound).
 *
 *   draft      build the data snapshot + coach narrative -> status 'draft'
 *   saveEdits  coach edits (headline, letter, chapter, P.S., targets)
 *   refresh    rebuild the data snapshot (keeps the coach's edits)
 *   approve    render + store the PDF -> status 'approved'
 *   send       email (PDF attached) / WhatsApp link -> status 'sent'
 *   discard    drop a draft
 *
 * ADMIN CONTROL IS THE POINT: nothing here is scheduled, nothing is visible in
 * the member app, and send() refuses anything an admin has not approved. A
 * member only ever sees a Signature report through the email / WhatsApp link an
 * admin sends. Editing an approved report sends it back to draft.
 *
 * Storage: table signature_reports (own table — the classic `reports` table and
 * its scheduler are untouched, so either template can be removed on its own).
 * PDFs: <UPLOADS_DIR>/signature-reports/<id>.pdf, 404'd ahead of /uploads.
 * The row keeps the full model snapshot, so a lost PDF is rebuilt identically.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reportData = require('../reportData');
const { validatePeriod, periodLabel } = require('../reportService');
const { loadExtras } = require('./data');
const M = require('./model');
const N = require('./narrative');
const { renderReport } = require('./render');
const { esc } = require('./template');

const MODEL_VERSION = 'signature-v1';
const SHARE_DAYS = () => Math.max(1, Math.min(365, parseInt(process.env.REPORT_SHARE_LINK_DAYS || '30', 10) || 30));
const COACH = () => (process.env.REPORTS_COACH_NAME || 'Kling').trim().slice(0, 40) || 'Kling';
const STATUSES = ['draft', 'approved', 'sent', 'discarded'];

function parseJ(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function ensureTables(db) {
  const q = (sql) => db.run(sql).catch((e) => { if (!/already exists/i.test(e.message)) console.warn('[signature] ddl:', e.message); });
  await q(`CREATE TABLE IF NOT EXISTS signature_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('weekly','monthly')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    score INTEGER,
    grade TEXT,
    model_json JSONB NOT NULL,
    narrative_json JSONB,
    edits_json JSONB,
    targets_json JSONB,
    review_json JSONB,
    ai_source TEXT,
    ai_error TEXT,
    model_version TEXT,
    pdf_path TEXT,
    pages INTEGER,
    render_ms INTEGER,
    layout_warnings JSONB,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    sent_by TEXT,
    sent_at TIMESTAMPTZ,
    sent_channels JSONB DEFAULT '[]'::jsonb,
    send_log JSONB,
    share_token TEXT,
    share_expires_at TIMESTAMPTZ,
    share_last_viewed_at TIMESTAMPTZ
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_sigrep_user ON signature_reports(user_id, period_end DESC)');
  await q('CREATE INDEX IF NOT EXISTS idx_sigrep_status ON signature_reports(status, updated_at DESC)');
  await q("CREATE UNIQUE INDEX IF NOT EXISTS idx_sigrep_share ON signature_reports(share_token) WHERE share_token IS NOT NULL AND share_token <> ''");
}

function storageDir(uploadsDir) {
  const root = uploadsDir || process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
  const dir = path.join(root, 'signature-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileNameFor(row, name) {
  const slug = String(name || 'client').normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'client';
  return `BodyBank_${row.type === 'monthly' ? 'Monthly' : 'Weekly'}_Signature_${slug}_${ymd(row.period_start)}_${ymd(row.period_end)}.pdf`;
}

/** The report as it will print: snapshot + coach edits + re-planned targets. */
function effective(row) {
  const model = parseJ(row.model_json);
  const edits = parseJ(row.edits_json) || {};
  const narrative = N.applyEdits(parseJ(row.narrative_json) || N.rulesNarrative(model), edits);
  const targets = N.applyTargetEdits(model.targets, edits.targets, model);
  const plan = M.replan(model, targets);
  return { model: Object.assign({}, model, plan), narrative, edits };
}

function view(row) {
  if (!row) return null;
  const eff = effective(row);
  const m = eff.model;
  return {
    id: row.id,
    userId: row.user_id,
    clientName: row.client_name || m.client.name,
    clientEmail: row.client_email || null,
    clientPhone: row.client_phone || null,
    type: row.type,
    periodStart: ymd(row.period_start),
    periodEnd: ymd(row.period_end),
    periodLabel: m.period.label,
    status: row.status,
    score: row.score,
    grade: row.grade,
    scoreDelta: m.score.totalDelta,
    narrative: { headline: eff.narrative.headline, letter: eff.narrative.letter, chapter: eff.narrative.chapter || '', ps: eff.narrative.ps || '' },
    draftNarrative: parseJ(row.narrative_json) || null,
    edits: eff.edits,
    targets: m.targets.map((t) => ({ metric: t.metric, value: t.value, label: t.label, unit: t.unit, baseline: t.baseline, baselineOf: t.baselineOf, points: t.points, custom: !!t.custom })),
    projection: m.projection,
    lever: m.lever,
    patterns: (m.patterns || []).map((p) => ({ title: p.title, text: p.text })),
    promise: m.promise,
    review: parseJ(row.review_json) || m.review || [],
    aiSource: row.ai_source || null,
    aiError: row.ai_error || null,
    pages: row.pages || null,
    layoutWarnings: (parseJ(row.layout_warnings) || []).length,
    createdAt: row.created_at, updatedAt: row.updated_at,
    approvedAt: row.approved_at || null, approvedBy: row.approved_by || null,
    sentAt: row.sent_at || null, sentChannels: parseJ(row.sent_channels) || [],
    shareExpiresAt: row.share_expires_at || null, shareLastViewedAt: row.share_last_viewed_at || null
  };
}

function listRow(r) {
  return {
    id: r.id, userId: r.user_id, clientName: r.client_name || '', type: r.type,
    periodStart: ymd(r.period_start), periodEnd: ymd(r.period_end), periodLabel: periodLabel(r.type, ymd(r.period_start), ymd(r.period_end)),
    status: r.status, score: r.score, grade: r.grade, aiSource: r.ai_source || null,
    flags: (parseJ(r.review_json) || []).map((f) => f.level),
    createdAt: r.created_at, updatedAt: r.updated_at, approvedAt: r.approved_at, sentAt: r.sent_at, sentChannels: parseJ(r.sent_channels) || []
  };
}

/**
 * @param deps { db: {run, queryOne, queryAll}, uploadsDir, notify, notifyAgent, sendMail,
 *               luxuryWrap, sendWhatsAppWithFallback, waStore, notifyHub, uuid }
 */
function createSignatureService(deps) {
  const d = deps || {};
  const db = d.db;
  const uuid = d.uuid || (() => crypto.randomUUID());
  const fire = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* never blocks */ } };
  const baseUrl = (reqBase) => String(reqBase || process.env.PUBLIC_URL || process.env.APP_ORIGIN || 'https://bodybank.fit').replace(/\/$/, '');

  async function getRow(id) {
    return db.queryOne(
      `SELECT s.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS client_name,
              u.email AS client_email, u.phone AS client_phone, u.first_name AS client_first
         FROM signature_reports s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, [id]);
  }
  async function mustRow(id) { const r = await getRow(id); if (!r) throw httpError(404, 'Report not found'); return r; }

  /** The last approved / sent Signature report before this period — its targets open this report. */
  async function previousFor(userId, type, start) {
    const r = await db.queryOne(
      `SELECT type, period_start, period_end, targets_json FROM signature_reports
        WHERE user_id = ? AND type = ? AND status IN ('approved','sent') AND period_end < ?::date
        ORDER BY period_end DESC, approved_at DESC NULLS LAST LIMIT 1`, [userId, type, start]).catch(() => null);
    if (!r) return null;
    const targets = parseJ(r.targets_json);
    return Array.isArray(targets) && targets.length ? { targets, periodLabel: periodLabel(r.type, ymd(r.period_start), ymd(r.period_end)) } : null;
  }

  async function buildSnapshot(userId, type, start, end) {
    const bundle = await reportData.loadReportBundle(userId, start, end, type, { db });
    const extras = await loadExtras(db, bundle);
    const previous = await previousFor(userId, type, start);
    const model = M.buildModel(bundle, extras, { previous, coachName: COACH() });
    return model;
  }

  async function draft({ userId, type, startDate, endDate, createdBy, ai }) {
    const p = validatePeriod(type, startDate, endDate);
    if (p.error) throw httpError(400, p.error);
    // One working copy per client + period: rebuild an open draft / approved report in place.
    const open = await db.queryOne(
      `SELECT id, edits_json FROM signature_reports WHERE user_id = ? AND type = ? AND period_start = ?::date AND period_end = ?::date
          AND status IN ('draft','approved') ORDER BY updated_at DESC LIMIT 1`, [userId, p.type, p.start, p.end]);
    const id = open ? open.id : uuid();
    const model = await buildSnapshot(userId, p.type, p.start, p.end);
    const nar = await N.buildNarrative(model, { ai: ai !== false, userId, refId: id });
    const narrative = { headline: nar.headline, letter: nar.letter, chapter: nar.chapter, ps: '', source: nar.source };
    const vals = [p.type, p.start, p.end, model.score.total, model.score.grade, JSON.stringify(model), JSON.stringify(narrative),
      JSON.stringify(model.review || []), nar.source, nar.aiError || null, MODEL_VERSION];
    if (open) {
      await db.run(
        `UPDATE signature_reports SET type = ?, period_start = ?::date, period_end = ?::date, status = 'draft', score = ?, grade = ?,
                model_json = ?::jsonb, narrative_json = ?::jsonb, review_json = ?::jsonb, ai_source = ?, ai_error = ?, model_version = ?,
                pdf_path = NULL, pages = NULL, approved_by = NULL, approved_at = NULL, updated_at = NOW()
          WHERE id = ?`, vals.concat([id]));
    } else {
      await db.run(
        `INSERT INTO signature_reports (id, user_id, type, period_start, period_end, status, score, grade, model_json, narrative_json,
                                        review_json, ai_source, ai_error, model_version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?::date, ?::date, 'draft', ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?, NOW(), NOW())`,
        [id, userId].concat(vals, [createdBy || null]));
    }
    removePdf(id);
    return view(await getRow(id));
  }

  async function refresh(id) {
    const row = await mustRow(id);
    if (!['draft', 'approved'].includes(row.status)) throw httpError(409, 'Only a draft or approved report can be refreshed');
    const model = await buildSnapshot(row.user_id, row.type, ymd(row.period_start), ymd(row.period_end));
    await db.run(
      `UPDATE signature_reports SET status = 'draft', score = ?, grade = ?, model_json = ?::jsonb, review_json = ?::jsonb,
              pdf_path = NULL, pages = NULL, approved_by = NULL, approved_at = NULL, updated_at = NOW() WHERE id = ?`,
      [model.score.total, model.score.grade, JSON.stringify(model), JSON.stringify(model.review || []), id]);
    removePdf(id);
    return view(await getRow(id));
  }

  function cleanEdits(e) {
    const src = e && typeof e === 'object' ? e : {};
    const out = {};
    for (const k of ['headline', 'letter', 'chapter', 'ps']) if (typeof src[k] === 'string') out[k] = src[k].slice(0, 2000);
    if (Array.isArray(src.targets)) {
      out.targets = src.targets.slice(0, 3).map((t) => {
        if (!t || typeof t !== 'object') return null;
        const o = {};
        if (t.custom) { o.custom = true; o.label = String(t.label || '').slice(0, 300); return o; }
        if (t.value != null && t.value !== '' && Number.isFinite(Number(t.value))) o.value = Number(t.value);
        if (typeof t.label === 'string' && t.label.trim()) o.label = t.label.slice(0, 300);
        return Object.keys(o).length ? o : null;
      });
    }
    return out;
  }

  async function saveEdits(id, edits) {
    const row = await mustRow(id);
    if (!['draft', 'approved'].includes(row.status)) throw httpError(409, 'A sent report cannot be edited — create a new draft for this period');
    const clean = cleanEdits(edits);
    await db.run(
      `UPDATE signature_reports SET edits_json = ?::jsonb, status = 'draft', pdf_path = NULL, pages = NULL,
              approved_by = NULL, approved_at = NULL, updated_at = NOW() WHERE id = ?`, [JSON.stringify(clean), id]);
    removePdf(id);
    return view(await getRow(id));
  }

  async function preview(id) {
    const row = await mustRow(id);
    const eff = effective(row);
    const out = await renderReport(eff.model, eff.narrative, { pdf: false, uploadsDir: d.uploadsDir });
    return { html: out.html, pages: out.pages, warnings: out.warnings };
  }

  function pdfFile(id) { return path.join(storageDir(d.uploadsDir), `${id}.pdf`); }
  function removePdf(id) { try { fs.unlinkSync(pdfFile(id)); } catch (_) { /* none */ } }

  async function writePdf(row) {
    const eff = effective(row);
    const out = await renderReport(eff.model, eff.narrative, { pdf: true, uploadsDir: d.uploadsDir });
    const file = pdfFile(row.id);
    fs.writeFileSync(file + '.tmp', out.pdf);
    fs.renameSync(file + '.tmp', file);
    return { out, eff };
  }

  async function approve(id, adminId) {
    const row = await mustRow(id);
    if (row.status !== 'draft' && row.status !== 'approved') throw httpError(409, `A ${row.status} report cannot be approved`);
    const { out, eff } = await writePdf(row);
    await db.run(
      `UPDATE signature_reports SET status = 'approved', approved_by = ?, approved_at = NOW(), targets_json = ?::jsonb,
              pdf_path = ?, pages = ?, render_ms = ?, layout_warnings = ?::jsonb, updated_at = NOW() WHERE id = ?`,
      [adminId || null, JSON.stringify(eff.model.targets.map((t) => ({ metric: t.metric || null, value: t.value == null ? null : t.value, label: t.label }))),
        `${id}.pdf`, out.pages || null, out.ms || null, JSON.stringify(out.warnings || []), id]);
    return view(await getRow(id));
  }

  async function pdfFor(id) {
    const row = await mustRow(id);
    if (!['approved', 'sent'].includes(row.status)) throw httpError(409, 'Approve the report to create its PDF');
    const file = pdfFile(id);
    if (!fs.existsSync(file)) await writePdf(row);
    return { file, name: fileNameFor(row, row.client_name), row };
  }

  async function ensureShareLink(row) {
    const valid = row.share_token && row.share_expires_at && new Date(row.share_expires_at).getTime() > Date.now() + 24 * 3600 * 1000;
    if (valid) return { token: row.share_token, expiresAt: row.share_expires_at };
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_DAYS() * 86400000).toISOString();
    await db.run('UPDATE signature_reports SET share_token = ?, share_expires_at = ?::timestamptz WHERE id = ?', [token, expiresAt, row.id]);
    return { token, expiresAt };
  }

  async function revokeShareLink(id) {
    await db.run('UPDATE signature_reports SET share_token = NULL, share_expires_at = NULL WHERE id = ?', [id]);
  }

  /** The member's link. Only a report an admin actually SENT is reachable. */
  async function byShareToken(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
    const row = await db.queryOne(`SELECT id, status, share_expires_at FROM signature_reports WHERE share_token = ?`, [token]);
    if (!row || row.status !== 'sent' || !row.share_expires_at || new Date(row.share_expires_at).getTime() < Date.now()) return null;
    db.run('UPDATE signature_reports SET share_last_viewed_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
    return pdfFor(row.id);
  }

  async function send(id, { channels, sentBy, reqBase }) {
    const want = Array.from(new Set((Array.isArray(channels) ? channels : []).filter((c) => c === 'email' || c === 'whatsapp')));
    if (!want.length) throw httpError(400, "channels must include 'email' and/or 'whatsapp'");
    const row = await mustRow(id);
    if (row.status !== 'approved' && row.status !== 'sent') throw httpError(409, 'Approve the report before sending it');
    const pdf = await pdfFor(id);
    const link = await ensureShareLink(row);
    const url = `${baseUrl(reqBase)}/r/sig/${link.token}`;
    const eff = effective(row);
    const kind = row.type === 'monthly' ? 'Monthly' : 'Weekly';
    const periodTxt = eff.model.period.label;
    const first = String(row.client_first || '').trim() || 'there';
    const results = {};

    if (want.includes('email')) {
      if (!row.client_email) results.email = { ok: false, reason: 'no_email' };
      else if (!d.sendMail) results.email = { ok: false, reason: 'email_not_configured' };
      else {
        const lever = eff.model.lever;
        const bodyHtml = `<p style="margin:0 0 14px">${esc(eff.narrative.headline)}</p>`
          + `<p style="margin:0 0 14px">Your BodyBank Score for ${esc(periodTxt)} is <strong style="color:#c8a44e">${esc(row.score)} (${esc(row.grade)})</strong>.</p>`
          + (lever ? `<p style="margin:0 0 14px"><strong>Your one big lever next ${row.type === 'monthly' ? 'month' : 'week'}:</strong> ${esc(lever.label)}.</p>` : '')
          + '<p style="margin:0">Your full Signature report is attached as a PDF, and you can also open it with the button below.</p>';
        const html = d.luxuryWrap ? d.luxuryWrap({ title: `Your ${kind} Signature Report`, preheader: `${eff.narrative.headline}`.slice(0, 120), lead: `Hi ${first},`, bodyHtml, ctaLabel: 'Open your report', ctaUrl: url }) : bodyHtml;
        const text = `Hi ${first}, your ${kind.toLowerCase()} BodyBank Signature report (${periodTxt}) is attached. Score ${row.score} (${row.grade}). ${eff.narrative.headline} Open it online: ${url}`;
        let ok = false;
        try {
          ok = await d.sendMail(row.client_email, `Your BodyBank ${kind} Signature Report — ${periodTxt}`, html, text, [{ filename: pdf.name, content: fs.readFileSync(pdf.file), contentType: 'application/pdf' }]);
        } catch (_) { ok = false; }
        results.email = ok ? { ok: true } : { ok: false, reason: 'send_failed' };
      }
    }

    if (want.includes('whatsapp')) {
      const phone = String(row.client_phone || '').trim();
      if (!phone || phone.replace(/\D/g, '').length < 8) results.whatsapp = { ok: false, reason: 'no_phone' };
      else if (!d.sendWhatsAppWithFallback) results.whatsapp = { ok: false, reason: 'whatsapp_not_configured' };
      else {
        const text = `Hi ${first}, your ${kind.toLowerCase()} BodyBank report is ready — score ${row.score} (${row.grade}). ${eff.narrative.headline}\n\nOpen your report: ${url}`;
        let r;
        try { r = await d.sendWhatsAppWithFallback(text, { to: phone, templateSid: process.env.TWILIO_CLIENT_REPORT_TEMPLATE_SID || undefined }); } catch (err) { r = { ok: false, reason: 'send_failed', error: err.message }; }
        results.whatsapp = r && r.ok ? { ok: true, sid: r.sid } : { ok: false, reason: (r && r.reason) || 'send_failed', code: r && r.code };
        if (r && r.ok && d.waStore && d.waStore.insertMessage) {
          const digits = phone.replace(/\D/g, '');
          fire(() => d.waStore.insertMessage({ client_id: row.user_id, phone: digits.length === 10 ? '+91' + digits : '+' + digits, direction: 'outbound', body: text, twilio_sid: r.sid || '', unmatched: false }));
        }
      }
    }

    const okChannels = Object.keys(results).filter((k) => results[k] && results[k].ok);
    const merged = Array.from(new Set((parseJ(row.sent_channels) || []).concat(okChannels)));
    if (okChannels.length) {
      await db.run(`UPDATE signature_reports SET status = 'sent', sent_at = NOW(), sent_by = ?, sent_channels = ?::jsonb, send_log = ?::jsonb, updated_at = NOW() WHERE id = ?`,
        [sentBy || null, JSON.stringify(merged), JSON.stringify({ at: new Date().toISOString(), results }), id]);
      if (d.notifyHub && row.user_id) {
        fire(() => d.notifyHub.toUser(row.user_id, {
          title: `📊 Your ${kind.toLowerCase()} report from your coach`,
          body: `Sent to your ${okChannels.join(' and ')}. BodyBank Score ${row.score}.`,
          type: 'progress_report', link: 'home'
        }));
      }
      const event = { report_id: id, template: 'signature', user_id: row.user_id, name: row.client_name, email: row.client_email, phone: row.client_phone, type: row.type, period_start: ymd(row.period_start), period_end: ymd(row.period_end), score: row.score, grade: row.grade, channels: okChannels, link_expires_at: link.expiresAt };
      if (d.notifyAgent) fire(() => d.notifyAgent('REPORT_SENT', event));
    } else {
      await db.run('UPDATE signature_reports SET send_log = ?::jsonb WHERE id = ?', [JSON.stringify({ at: new Date().toISOString(), results }), id]);
    }
    return { ok: okChannels.length > 0, results, sentChannels: merged, link: url, linkExpiresAt: link.expiresAt };
  }

  async function discard(id) {
    const row = await mustRow(id);
    if (row.status === 'sent') throw httpError(409, 'A sent report cannot be discarded');
    await db.run(`UPDATE signature_reports SET status = 'discarded', updated_at = NOW() WHERE id = ?`, [id]);
    removePdf(id);
    return { ok: true };
  }

  async function get(id) { return view(await mustRow(id)); }

  async function list({ status, userId, type, limit }) {
    const where = []; const params = [];
    if (status && STATUSES.includes(status)) { where.push('s.status = ?'); params.push(status); } else { where.push("s.status <> 'discarded'"); }
    if (userId) { where.push('s.user_id = ?'); params.push(userId); }
    if (type === 'weekly' || type === 'monthly') { where.push('s.type = ?'); params.push(type); }
    params.push(Math.max(1, Math.min(300, parseInt(limit, 10) || 100)));
    const rows = await db.queryAll(
      `SELECT s.id, s.user_id, s.type, s.period_start, s.period_end, s.status, s.score, s.grade, s.ai_source, s.review_json,
              s.created_at, s.updated_at, s.approved_at, s.sent_at, s.sent_channels,
              TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS client_name
         FROM signature_reports s JOIN users u ON u.id = s.user_id
        WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ?`, params);
    const counts = await db.queryAll(`SELECT status, COUNT(*)::int AS c FROM signature_reports WHERE status IN ('draft','approved','sent') GROUP BY status`).catch(() => []);
    const c = { draft: 0, approved: 0, sent: 0 };
    for (const r of counts) c[r.status] = r.c;
    return { reports: rows.map(listRow), counts: c };
  }

  /**
   * Client picker for one-off drafts. Searches EVERY member account (not only
   * active ones — an admin may report on a paused or lapsed client), matches each
   * typed word anywhere in name / email / phone, and ranks name-prefix matches first.
   */
  async function clients({ q, limit }) {
    const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
    const words = String(q || '').toLowerCase().replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5);
    if (!words.length) return [];
    const where = [`u.role = 'user'`, `u.email NOT LIKE '%@test.bodybank.fit'`, `LOWER(COALESCE(u.first_name, '')) NOT LIKE '%e2e%'`];
    const params = [];
    for (const w of words) {
      const digits = w.replace(/\D/g, '');
      where.push(`(LOWER(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) LIKE ? OR LOWER(COALESCE(u.email,'')) LIKE ?${digits.length >= 3 ? ` OR regexp_replace(COALESCE(u.phone,''), '[^0-9]', '', 'g') LIKE ?` : ''})`);
      params.push(`%${w}%`, `%${w}%`);
      if (digits.length >= 3) params.push(`%${digits}%`);
    }
    const first = words[0];
    params.push(`${first}%`, `% ${first}%`, lim);
    const rows = await db.queryAll(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.subscription_status, u.approval_status,
              COALESCE(u.suspended, FALSE) AS suspended, u.plan_label,
              (SELECT to_char(MAX(d.checkin_date), 'YYYY-MM-DD') FROM daily_checkins d WHERE d.user_id = u.id) AS last_checkin,
              (SELECT COUNT(*)::int FROM signature_reports s WHERE s.user_id = u.id AND s.status <> 'discarded') AS sig_reports
         FROM users u
        WHERE ${where.join(' AND ')}
        ORDER BY CASE WHEN LOWER(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) LIKE ? THEN 0
                      WHEN LOWER(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) LIKE ? THEN 1 ELSE 2 END,
                 CASE WHEN COALESCE(u.suspended, FALSE) OR u.subscription_status IN ('canceled','expired') THEN 1 ELSE 0 END,
                 LOWER(COALESCE(u.first_name,'')), LOWER(COALESCE(u.last_name,''))
        LIMIT ?`, params);
    return rows.map((r) => {
      let status = 'Active';
      if (r.suspended) status = 'Suspended';
      else if (r.approval_status && r.approval_status !== 'approved') status = 'Pending approval';
      else if (r.subscription_status === 'trialing') status = 'Trial';
      else if (r.subscription_status === 'canceled' || r.subscription_status === 'expired') status = 'Lapsed';
      return {
        id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
        email: r.email || '', phone: r.phone || '', status, plan: r.plan_label || '',
        lastCheckin: r.last_checkin || null, signatureReports: r.sig_reports || 0
      };
    });
  }

  // ---- bulk drafting (never sends) ------------------------------------------
  const ACTIVE_CLIENT_SQL = `u.role = 'user'
    AND (u.approval_status IS NULL OR u.approval_status = 'approved')
    AND (u.email NOT LIKE '%@test.bodybank.fit')
    AND (LOWER(COALESCE(u.first_name, '')) NOT LIKE '%e2e%')
    AND COALESCE(u.suspended, FALSE) = FALSE
    AND (u.subscription_status IS NULL OR u.subscription_status NOT IN ('canceled', 'expired'))`;
  const jobs = new Map();
  function jobView(j) {
    return { jobId: j.id, type: j.type, period: j.period, status: j.status, total: j.total, done: j.done, skipped: j.skipped, failed: j.failed,
      progressPct: j.total ? Math.round(((j.done + j.failed + j.skipped) / j.total) * 100) : 100, startedAt: j.startedAt, finishedAt: j.finishedAt, results: j.results.slice(-300) };
  }
  async function startBulk({ type, startDate, endDate, createdBy, ai }) {
    const p = validatePeriod(type, startDate, endDate);
    if (p.error) throw httpError(400, p.error);
    for (const j of jobs.values()) if (j.status === 'running') { const e = httpError(409, 'A bulk draft run is already in progress'); e.jobId = j.id; throw e; }
    const list = await db.queryAll(`SELECT u.id, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name FROM users u WHERE ${ACTIVE_CLIENT_SQL} ORDER BY LOWER(COALESCE(u.first_name,''))`);
    const have = new Set((await db.queryAll(
      `SELECT user_id FROM signature_reports WHERE type = ? AND period_start = ?::date AND period_end = ?::date AND status <> 'discarded'`, [p.type, p.start, p.end])).map((r) => r.user_id));
    const job = { id: uuid(), type: p.type, period: { start: p.start, end: p.end }, status: 'running', total: list.length, done: 0, skipped: 0, failed: 0, results: [], startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(job.id, job);
    if (jobs.size > 20) { const oldest = Array.from(jobs.keys())[0]; if (oldest !== job.id) jobs.delete(oldest); }
    (async () => {
      for (const c of list) {
        if (have.has(c.id)) { job.skipped += 1; continue; }
        try {
          const r = await draft({ userId: c.id, type: p.type, startDate: p.start, endDate: p.end, createdBy, ai: ai !== false });
          job.done += 1;
          job.results.push({ userId: c.id, name: c.name, ok: true, reportId: r.id, score: r.score, grade: r.grade, flags: r.review.map((f) => f.level) });
        } catch (err) {
          job.failed += 1;
          job.results.push({ userId: c.id, name: c.name, ok: false, error: String(err.message || err).slice(0, 160) });
        }
      }
      job.status = 'done'; job.finishedAt = new Date().toISOString();
      if (d.notify) fire(() => d.notify('REPORT_BULK_COMPLETE', { type: p.type, period: `${p.start} → ${p.end}`, total: job.total, done: job.done, failed: job.failed, source: 'signature-drafts', action: 'sig_bulk_' + job.id }));
    })().catch((err) => { job.status = 'error'; job.error = err.message; job.finishedAt = new Date().toISOString(); });
    return jobView(job);
  }
  function getJob(id) { const j = jobs.get(id); return j ? jobView(j) : null; }

  return {
    ensureTables: () => ensureTables(db),
    draft, refresh, saveEdits, preview, approve, send, discard, get, list, pdfFor, clients,
    byShareToken, revokeShareLink, startBulk, getJob
  };
}

module.exports = { createSignatureService, ensureTables, effective, MODEL_VERSION };
