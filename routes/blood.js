'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const userEmail = require('../services/userEmailService');
const { notifyAsync } = require('../utils/notify');
const { notifyAgent } = require('../utils/agentWebhook');
const {
  triggerBloodAnalysis,
  ensureHealthReportPdf,
  validateBloodReportInput,
  resolveStoredUploadPath
} = require('../services/bloodAnalysisService');
const { alignReports, generateComparisonVerdict, reportTimelineMs } = require('../services/bloodComparisonService');
const {
  buildComparisonDoc,
  sanitizeComparisonDoc,
  docHasVisibleContent,
  docCoachNote,
  setDocCoachNote
} = require('../services/comparisonDocument');
const { generateComparisonReportPdf } = require('../services/pdfService');
const { computeNutritionSummaryForUserWindow } = require('../services/nutritionService');
const { recordAiUsage } = require('../services/aiUsageLedger');

// Keep decoded+base64 payload under Claude's ~32MB PDF request limit.
const MAX_B64_CHARS = 30 * 1024 * 1024;
const MAX_BLOOD_FILE_BYTES = Math.floor(MAX_B64_CHARS * 3 / 4);
const BLOOD_AUTO_PROCESS_ON_UPLOAD = String(process.env.BLOOD_AUTO_PROCESS_ON_UPLOAD || 'false').toLowerCase() === 'true';
const MAX_REPORTS_PER_USER = 3;
// A comparison must span at least 2 reports; cap the fan-out so the trend table
// and AI prompt stay readable.
const CMP_MIN_REPORTS = 2;
const CMP_MAX_REPORTS = 6;

// Roles allowed to manage a client's blood reports. Operators have full parity with
// admins here (download originals, re-date, re-upload, delete, compare) — the coach
// running the retest is often the operator, not the admin.
const STAFF_ROLES = ['admin', 'superadmin', 'operator'];
const isStaff = (req) => STAFF_ROLES.includes(req && req.user && req.user.role);

/**
 * Normalise a user-supplied lab date to 'YYYY-MM-DD', or null when absent/invalid.
 * Rejects nonsense dates and anything in the future — a blood draw cannot be
 * scheduled, and a future date would corrupt the trend ordering.
 * @param {*} v raw input
 * @returns {{date: string|null, error: string|null}}
 */
function normalizeReportDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { date: null, error: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { date: null, error: 'Lab date must be in YYYY-MM-DD format.' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip check rejects 2025-02-30 and friends, which Date would roll over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { date: null, error: 'That is not a real calendar date.' };
  }
  if (y < 1900) return { date: null, error: 'Lab date looks too far in the past.' };
  // Allow "today" in any timezone ahead of UTC — compare against tomorrow UTC.
  const tomorrowUtc = Date.now() + 24 * 60 * 60 * 1000;
  if (dt.getTime() > tomorrowUtc) return { date: null, error: 'Lab date cannot be in the future.' };
  return { date: s, error: null };
}

function parseJsonCol(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch (_) {
    return null;
  }
}

// The date a report sits at on the client's timeline: the printed lab draw date when
// known, else the upload timestamp. Every ordering + label uses this.
function effectiveReportDate(r) {
  return (r && (r.report_date || r.created_at)) || null;
}

function mapComparisonRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    userAge: r.user_age,
    userGender: r.user_gender,
    userGoal: r.user_goal,
    reportIds: parseJsonCol(r.report_ids) || [],
    comparison: parseJsonCol(r.comparison_data),
    verdict: parseJsonCol(r.ai_verdict),
    aiUsage: parseJsonCol(r.ai_usage),
    adminNotes: r.admin_notes || '',
    status: r.status,
    sentToUser: !!r.sent_to_user,
    sentAt: r.sent_at,
    pdfUrl: r.pdf_path,
    createdAt: r.created_at,
    // Has a reviewer edited the printable document, and when?
    docEdited: !!r.report_doc,
    docUpdatedAt: r.doc_updated_at || null,
    docUpdatedBy: r.doc_updated_by || '',
    clientPhone: String(r.client_phone || '').trim(),
    // A live, unexpired WhatsApp share link on this report?
    shareActive: !!(r.share_token && r.share_expires_at && new Date(r.share_expires_at).getTime() > Date.now()),
    shareExpiresAt: r.share_expires_at || null,
    profile_picture: String(r.client_profile_picture || '').trim()
  };
}

/**
 * The document that WILL print for this comparison: the reviewer's edited version
 * when one exists, otherwise a default built from the aligned data + AI verdict.
 * @param {object} row a blood_comparison_reports row
 * @returns {{ doc: object|null, edited: boolean }}
 */
function comparisonDocFor(row) {
  const stored = parseJsonCol(row && row.report_doc);
  if (stored && typeof stored === 'object' && Array.isArray(stored.sections)) {
    return { doc: sanitizeComparisonDoc(stored), edited: true };
  }
  const comparison = parseJsonCol(row && row.comparison_data);
  if (!comparison || !Array.isArray(comparison.panels)) return { doc: null, edited: false };
  const doc = buildComparisonDoc({
    comparison,
    verdict: parseJsonCol(row.ai_verdict) || {},
    adminNotes: row.admin_notes || '',
    user: {
      name: row.user_name || 'Member',
      age: row.user_age || '—',
      gender: row.user_gender || '—',
      goal: row.user_goal || '—'
    }
  });
  return { doc, edited: false };
}

/**
 * Ensure the progress PDF for a comparison row exists on disk, rendering the
 * EFFECTIVE document (the reviewer's edits when present) if it does not.
 * Module-scoped because both the staff router and the public share route need it.
 * @param {Function} run db runner
 * @param {object} row blood_comparison_reports row
 * @returns {Promise<string|null>} absolute path, or null when there is nothing to render
 */
async function ensureComparisonPdfForRow(run, row) {
  const existing = row.pdf_path ? resolveStoredUploadPath(String(row.pdf_path).trim()) : null;
  if (existing && fs.existsSync(existing)) return existing;
  const { doc } = comparisonDocFor(row);
  if (!doc) return null;
  const pdfPath = await generateComparisonReportPdf({ comparisonId: row.id, doc });
  await run(`UPDATE blood_comparison_reports SET pdf_path = ? WHERE id = ?`, [pdfPath, row.id]).catch(() => {});
  return pdfPath;
}

// ---- WhatsApp share links --------------------------------------------------
// WhatsApp deep links cannot carry an attachment, so sharing a report into a chat
// means sending a URL. That URL points at a patient's blood work, so it is a random
// 32-char token with an expiry that staff can revoke — never a guessable id and
// never a path under the public /uploads mount.

const SHARE_LINK_DAYS = Math.max(1, parseInt(process.env.BLOOD_SHARE_LINK_DAYS || '30', 10) || 30);

function newShareToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Absolute origin for links we hand to a client, honouring the proxy in front of us. */
function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_URL || process.env.APP_BASE_URL || process.env.SITE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return `${req.protocol}://${host}`.replace(/\/$/, '');
}

function shareUrlFor(req, token) {
  return `${publicOrigin(req)}/r/blood/${encodeURIComponent(token)}`;
}

/** Digits-only phone for a wa.me deep link, or '' when we have nothing usable. */
function waDigits(phone) {
  const d = String(phone == null ? '' : phone).replace(/[^0-9]/g, '');
  return d.length >= 7 ? d : '';
}

function shareMessage(firstName, url, expiresAt) {
  const who = String(firstName || '').trim();
  const when = expiresAt ? new Date(expiresAt) : null;
  const until = when && !Number.isNaN(when.getTime())
    ? ` The link works until ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`
    : '';
  return `Hi ${who || 'there'}, your BodyBank blood progress report is ready.\n\n${url}\n\nOpen it on your phone to see what changed and the updated plan.${until}`;
}

function mapReportRow(r) {
  if (!r) return null;
  const id = r.id;
  const parseJson = (val) => {
    if (!val) return null;
    if (typeof val === 'object') return val;
    try {
      return JSON.parse(val);
    } catch (_) {
      return null;
    }
  };
  let aiReport = r.ai_report;
  if (typeof aiReport === 'string') {
    try {
      aiReport = JSON.parse(aiReport);
    } catch (_) {
      aiReport = null;
    }
  }
  return {
    _id: id,
    id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    userGoal: r.user_goal,
    status: r.status,
    createdAt: r.created_at,
    // Lab draw date (nullable) vs upload time — the UI shows both.
    reportDate: r.report_date || null,
    effectiveDate: effectiveReportDate(r),
    hasSourceFile: !!(r.blood_report_file_path && String(r.blood_report_file_path).trim()),
    sentToUser: !!r.sent_to_user,
    sentAt: r.sent_at,
    adminNotes: r.admin_notes,
    pdfUrl: r.pdf_path,
    aiReport,
    analysisLastError: r.analysis_last_error || '',
    extractionAiUsage: parseJson(r.extraction_ai_usage),
    analysisAiUsage: parseJson(r.analysis_ai_usage),
    totalAiUsage: parseJson(r.total_ai_usage),
    profile_picture: String(r.client_profile_picture || '').trim(),
    // Present only where the query computes them (see /admin/all): which of the
    // client's 3 upload slots this report is, and how many they have on file.
    slotNo: r.slot_no != null ? Number(r.slot_no) : null,
    slotTotal: r.slot_total != null ? Number(r.slot_total) : null
  };
}

function mimeFromBloodFilePath(fp) {
  const lower = String(fp || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// "Rahul Sharma" + 2026-03-04 -> Rahul_Sharma_2026-03-04 — so a coach downloading an
// old and a new report gets two files they can tell apart without opening them.
function labFileDownloadName(report) {
  const ext = (path.extname(String(report.blood_report_file_path || '')) || '.pdf').toLowerCase();
  const who = String(report.user_name || 'client').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'client';
  const when = String(effectiveReportDate(report) || '').slice(0, 10) || 'undated';
  return `Lab_Report_${who}_${when}${ext}`;
}

function createBloodRouter(deps) {
  const { run, queryOne, queryAll, verifyToken, rateLimiter } = deps;
  const db = { run, queryOne, queryAll };

  const router = require('express').Router();
  router.use(verifyToken);
  // Every /admin/* blood route below is staff-gated rather than admin-gated: operators
  // have full parity on blood-report management (see STAFF_ROLES).
  const staffOnly = (req, res, next) => {
    if (!isStaff(req)) return res.status(403).json({ success: false, error: 'Forbidden' });
    next();
  };

  router.post('/upload', rateLimiter(5, 120000), async (req, res) => {
    try {
      const userId = req.user.id;
      const { bloodReportBase64, bloodReportMimeType, symptoms, userAge, userGender, userGoal } = req.body || {};
      const b64 = bloodReportBase64 ? String(bloodReportBase64).replace(/\s/g, '') : '';
      if (!b64) return res.status(400).json({ error: 'No file provided' });
      if (b64.length > MAX_B64_CHARS) return res.status(400).json({ error: 'File payload too large' });
      // Optional for members (older mobile builds don't send it) — falls back to
      // the upload time. Staff uploads below require it.
      const memberDate = normalizeReportDate(req.body && req.body.reportDate);
      if (memberDate.error) return res.status(400).json({ success: false, error: memberDate.error });

      // Users get up to MAX_REPORTS_PER_USER upload slots (Blood Report 1/2/3).
      // Check before spending AI validation tokens.
      const existingRows = await queryAll(`SELECT id FROM blood_analysis_reports WHERE user_id = ?`, [userId]);
      if ((existingRows || []).length >= MAX_REPORTS_PER_USER) {
        return res.status(400).json({
          success: false,
          error: `You can upload up to ${MAX_REPORTS_PER_USER} blood reports. Please remove one before uploading another.`
        });
      }

      const mime = String(bloodReportMimeType || 'image/jpeg').slice(0, 80);
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      const model =
        (process.env.ANTHROPIC_MODEL_BLOOD || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim();
      const reportValidation = await validateBloodReportInput({
        apiKey,
        model,
        imageBase64: b64,
        mimeType: mime
      });
      if (!reportValidation.isBloodReport) {
        return res.status(400).json({
          success: false,
          error: 'This file does not look like a blood lab report. Please upload a valid blood test report (PDF/image).'
        });
      }
      const ext = mime.toLowerCase().includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
      const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
      const fileDir = path.join(uploadsRoot, 'blood-reports');
      fs.mkdirSync(fileDir, { recursive: true });
      const fileName = `blood_${userId}_${Date.now()}.${ext}`;
      const filePath = path.join(fileDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));

      const u = await queryOne(`SELECT id, first_name, last_name, email, phone FROM users WHERE id = ?`, [userId]);
      const displayName = [u && u.first_name, u && u.last_name].filter(Boolean).join(' ').trim() || (u && u.email) || '';

      const symList = Array.isArray(symptoms) ? symptoms.map((s) => String(s).slice(0, 80)) : [];
      const reportId = uuidv4();

      await run(
        `INSERT INTO blood_analysis_reports (
          id, user_id, blood_report_file_path, symptoms, status,
          user_name, user_email, user_age, user_gender, user_goal, report_date
        ) VALUES (?, ?, ?, ?::jsonb, 'pending', ?, ?, ?, ?, ?, ?::date)`,
        [
          reportId,
          userId,
          filePath,
          JSON.stringify(symList),
          displayName,
          u && u.email ? String(u.email) : '',
          userAge != null ? String(userAge).slice(0, 32) : '',
          userGender != null ? String(userGender).slice(0, 32) : '',
          userGoal != null ? String(userGoal).slice(0, 200) : '',
          memberDate.date
        ]
      );

      if (BLOOD_AUTO_PROCESS_ON_UPLOAD) {
        triggerBloodAnalysis(db, reportId, b64, mime, userId).catch((err) =>
          console.error('[blood] Analysis pipeline failed:', err && err.message)
        );
      }

      notifyAsync('BLOOD_REPORT_UPLOADED', { name: displayName, email: u && u.email ? u.email : '—', mobile: u && u.phone ? u.phone : '—', goal: userGoal || '—' });
      notifyAgent('BLOOD_REPORT_UPLOADED', { name: displayName, email: u && u.email ? u.email : '—', mobile: u && u.phone ? u.phone : '—', goal: userGoal || '—' });
      res.json({
        success: true,
        reportId,
        status: 'pending',
        message: BLOOD_AUTO_PROCESS_ON_UPLOAD
          ? 'Report uploaded and analysis started.'
          : 'Report uploaded. Analysis will start only when admin clicks Process now.'
      });
    } catch (e) {
      console.error('[blood upload]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Upload failed' });
    }
  });

  // Admin OR operator uploads a blood report ON BEHALF of a client (e.g. quarterly
  // retest) and auto-starts analysis — so the client doesn't have to upload it.
  // Mirrors /upload but targets req.params.userId, pulls the client's profile for
  // the medical context, and is NOT subject to the per-user 3-slot cap.
  router.post('/admin/upload/:userId', staffOnly, rateLimiter(20, 120000), async (req, res) => {
    try {
      const targetUserId = String(req.params.userId || '').trim();
      if (!targetUserId) return res.status(400).json({ success: false, error: 'Missing client id' });
      const u = await queryOne(
        `SELECT id, first_name, last_name, email, phone, gender, dob, goal_type FROM users WHERE id = ?`,
        [targetUserId]
      );
      if (!u) return res.status(404).json({ success: false, error: 'Client not found' });

      const { bloodReportBase64, bloodReportMimeType, symptoms } = req.body || {};
      const b64 = bloodReportBase64 ? String(bloodReportBase64).replace(/\s/g, '') : '';
      if (!b64) return res.status(400).json({ success: false, error: 'No file provided' });
      if (b64.length > MAX_B64_CHARS) return res.status(400).json({ success: false, error: 'File payload too large' });

      // Required on staff uploads: this is the back-fill path (a coach uploading an
      // older retest), and the whole comparison timeline hangs off this date.
      const labDate = normalizeReportDate(req.body && req.body.reportDate);
      if (labDate.error) return res.status(400).json({ success: false, error: labDate.error });
      if (!labDate.date) {
        return res.status(400).json({
          success: false,
          error: 'Pick the lab test date printed on the report so it lands correctly on the client timeline.'
        });
      }

      const mime = String(bloodReportMimeType || 'image/jpeg').slice(0, 80);
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      const model = (process.env.ANTHROPIC_MODEL_BLOOD || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim();
      const reportValidation = await validateBloodReportInput({ apiKey, model, imageBase64: b64, mimeType: mime });
      if (!reportValidation.isBloodReport) {
        return res.status(400).json({
          success: false,
          error: 'This file does not look like a blood lab report. Please upload a valid blood test report (PDF/image).'
        });
      }

      const ext = mime.toLowerCase().includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
      const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
      const fileDir = path.join(uploadsRoot, 'blood-reports');
      fs.mkdirSync(fileDir, { recursive: true });
      const filePath = path.join(fileDir, `blood_${targetUserId}_${Date.now()}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));

      const displayName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || '';
      let ageStr = '';
      if (u.dob) {
        const a = Math.floor((Date.now() - new Date(u.dob).getTime()) / (365.25 * 86400000));
        if (a > 0 && a < 130) ageStr = String(a);
      }
      const symList = Array.isArray(symptoms) ? symptoms.map((s) => String(s).slice(0, 80)) : [];
      const reportId = uuidv4();

      await run(
        `INSERT INTO blood_analysis_reports (
          id, user_id, blood_report_file_path, symptoms, status,
          user_name, user_email, user_age, user_gender, user_goal, report_date
        ) VALUES (?, ?, ?, ?::jsonb, 'pending', ?, ?, ?, ?, ?, ?::date)`,
        [
          reportId,
          targetUserId,
          filePath,
          JSON.stringify(symList),
          displayName,
          u.email ? String(u.email) : '',
          ageStr,
          u.gender != null ? String(u.gender).slice(0, 32) : '',
          u.goal_type != null ? String(u.goal_type).slice(0, 200) : '',
          labDate.date
        ]
      );

      // Admin-initiated → start analysis immediately (fire-and-forget).
      triggerBloodAnalysis(db, reportId, b64, mime, targetUserId).catch((err) =>
        console.error('[blood admin upload] Analysis pipeline failed:', err && err.message)
      );

      notifyAsync('BLOOD_REPORT_UPLOADED', { name: displayName, email: u.email || '—', mobile: u.phone || '—', goal: u.goal_type || '—' });
      notifyAgent('BLOOD_REPORT_UPLOADED', { name: displayName, email: u.email || '—', mobile: u.phone || '—', goal: u.goal_type || '—' });
      res.json({
        success: true,
        reportId,
        status: 'pending',
        reportDate: labDate.date,
        message: `Uploaded for ${displayName || 'client'} (lab date ${labDate.date}) — analysis started.`
      });
    } catch (e) {
      console.error('[blood admin upload]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Upload failed' });
    }
  });

  router.get('/pdf/:reportId', async (req, res) => {
    try {
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      if (!report) return res.status(404).json({ error: 'Not found' });
      // Owner, admins, and read-only operators may download the branded report.
      const privileged = ['admin', 'superadmin', 'operator'].includes(req.user.role);
      if (report.user_id !== req.user.id && !privileged) return res.status(403).json({ error: 'Forbidden' });
      const pdfPath = await ensureHealthReportPdf(db, req.params.reportId);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        const st = String(report.status || '').toLowerCase();
        if (st === 'failed') {
          return res.status(410).json({ error: 'Blood analysis failed for this report. Ask the client to upload a new lab report.' });
        }
        return res.status(404).json({ error: 'PDF not ready yet' });
      }
      res.download(pdfPath, 'BodyBank_Health_Report.pdf');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download the ORIGINAL lab file the client uploaded (not the generated BodyBank
  // report). This is what a coach needs to open an old and a new report side by side
  // and read the printed values/dates for themselves.
  router.get('/file/:reportId', async (req, res) => {
    try {
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      if (!report) return res.status(404).json({ error: 'Not found' });
      if (report.user_id !== req.user.id && !isStaff(req)) return res.status(403).json({ error: 'Forbidden' });

      const raw = report.blood_report_file_path ? String(report.blood_report_file_path).trim() : '';
      const resolved = raw ? resolveStoredUploadPath(raw) : null;
      if (!resolved || !fs.existsSync(resolved)) {
        return res.status(404).json({
          error:
            'The original lab file is no longer on the server (common after a redeploy without a persistent disk). The extracted results and the generated report are still available.'
        });
      }
      res.setHeader('Content-Type', mimeFromBloodFilePath(resolved));
      res.download(resolved, labFileDownloadName(report));
    } catch (e) {
      console.error('[blood file]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/my-reports', async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT * FROM blood_analysis_reports WHERE user_id = ?
         ORDER BY COALESCE(report_date, created_at::date) DESC, created_at DESC`,
        [req.user.id]
      );
      const reports = (rows || []).map((r) => mapReportRow(r));
      res.json({ reports });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Member's OWN live progress trend across their processed reports — deterministic
  // alignment only (no AI, so it's free + instant). Powers the in-app trend card.
  router.get('/my-progress', async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT id, created_at, report_date, extracted_blood_data, ai_report, status
         FROM blood_analysis_reports WHERE user_id = ?
         ORDER BY COALESCE(report_date, created_at::date) ASC, created_at ASC`,
        [req.user.id]
      );
      const processed = (rows || []).filter((r) => {
        const ex = parseJsonCol(r.extracted_blood_data);
        return ex && Array.isArray(ex.panels) && ex.panels.length > 0;
      });
      if (processed.length < 2) {
        return res.json({ available: false, reportCount: processed.length, comparison: null });
      }
      const comparison = alignReports(processed);
      res.json({ available: comparison.markerCount > 0, reportCount: processed.length, comparison });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Coach-authored progress reviews that were SENT to this member (in-app access).
  router.get('/my-comparisons', async (req, res) => {
    try {
      // Prefer the reviewer's edited cover text — that is what the member's PDF says.
      const rows = await queryAll(
        `SELECT id, created_at, sent_at,
                COALESCE(report_doc->'cover'->'trajectory'->>'label',
                         ai_verdict->>'overall_trajectory') AS trajectory,
                COALESCE(report_doc->'cover'->'trajectory'->>'summary',
                         ai_verdict->>'executive_summary') AS summary
         FROM blood_comparison_reports
         WHERE user_id = ? AND sent_to_user = true
         ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json({
        comparisons: (rows || []).map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          sentAt: r.sent_at,
          trajectory: r.trajectory || null,
          summary: r.summary || null
        }))
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Member downloads their own sent progress-report PDF.
  router.get('/my-comparison/:id/pdf', async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
      if (!row.sent_to_user) return res.status(403).json({ error: 'This report has not been shared yet.' });
      const pdfPath = await ensureComparisonPdf(row);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return res.status(400).json({ error: 'Progress report is not ready.' });
      }
      res.download(pdfPath, 'BodyBank_Progress_Report.pdf');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // How many saved comparisons reference this report — the UI warns before deleting,
  // since removing a report leaves those progress reviews unable to regenerate.
  async function comparisonsUsingReport(reportId) {
    try {
      const row = await queryOne(
        `SELECT COUNT(*)::int AS n FROM blood_comparison_reports WHERE report_ids @> ?::jsonb`,
        [JSON.stringify([String(reportId)])]
      );
      return (row && Number(row.n)) || 0;
    } catch (_) {
      return 0;
    }
  }

  // Staff-facing pre-flight so the confirm dialog can state the real consequence.
  router.get('/impact/:reportId', staffOnly, async (req, res) => {
    try {
      const report = await queryOne(
        `SELECT id, user_name, report_date, created_at, status FROM blood_analysis_reports WHERE id = ?`,
        [req.params.reportId]
      );
      if (!report) return res.status(404).json({ error: 'Report not found' });
      res.json({
        reportId: report.id,
        userName: report.user_name || '',
        effectiveDate: effectiveReportDate(report),
        status: report.status,
        comparisonsAffected: await comparisonsUsingReport(req.params.reportId)
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Owner or staff removes a report entirely — DB row, original lab file and the
  // generated PDF — which frees an upload slot so a corrected file can be re-uploaded.
  router.delete('/:reportId', async (req, res) => {
    try {
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      if (!report) return res.status(404).json({ success: false, error: 'Report not found' });
      if (report.user_id !== req.user.id && !isStaff(req)) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      const affected = await comparisonsUsingReport(req.params.reportId);
      [report.blood_report_file_path, report.pdf_path].forEach((fp) => {
        try {
          const resolved = fp ? resolveStoredUploadPath(String(fp).trim()) : null;
          if (resolved && fs.existsSync(resolved)) fs.unlinkSync(resolved);
        } catch (_) {}
      });
      await run(`DELETE FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      res.json({
        success: true,
        comparisonsAffected: affected,
        message: affected
          ? `Report deleted. ${affected} saved comparison${affected === 1 ? '' : 's'} referenced it and can no longer be regenerated.`
          : 'Report deleted.'
      });
    } catch (e) {
      console.error('[blood delete]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Delete failed' });
    }
  });

  // Correct the lab date on an existing report (fixes legacy rows that predate the
  // field, and member uploads where nobody picked a date).
  router.put('/admin/report-date/:reportId', staffOnly, async (req, res) => {
    try {
      const report = await queryOne(`SELECT id FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      if (!report) return res.status(404).json({ success: false, error: 'Report not found' });
      const parsed = normalizeReportDate(req.body && req.body.reportDate);
      if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
      await run(`UPDATE blood_analysis_reports SET report_date = ?::date WHERE id = ?`, [
        parsed.date,
        req.params.reportId
      ]);
      // Stored comparisons embed the old ordering/labels; drop their cached PDFs so a
      // re-download reflects the corrected timeline.
      try {
        await run(
          `UPDATE blood_comparison_reports SET pdf_path = NULL WHERE report_ids @> ?::jsonb`,
          [JSON.stringify([String(req.params.reportId)])]
        );
      } catch (_) {}
      res.json({ success: true, reportDate: parsed.date });
    } catch (e) {
      console.error('[blood report-date]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Could not update the lab date' });
    }
  });

  // What a staff upload UI needs BEFORE it opens a file picker: how many of the
  // client's 3 slots are used, which number the next upload becomes, and the lab
  // dates already on file — so the same draw can't be uploaded twice by accident.
  router.get('/admin/slots/:userId', staffOnly, async (req, res) => {
    try {
      const targetUserId = String(req.params.userId || '').trim();
      if (!targetUserId) return res.status(400).json({ success: false, error: 'Missing client id' });
      const rows = await queryAll(
        `SELECT id, status, report_date, created_at FROM blood_analysis_reports
         WHERE user_id = ?
         ORDER BY COALESCE(report_date, created_at::date) ASC, created_at ASC`,
        [targetUserId]
      );
      // Oldest lab date first, so slot 1 is always the client's earliest report.
      const reports = (rows || []).map((r, i) => ({
        id: r.id,
        slotNo: i + 1,
        status: r.status,
        reportDate: r.report_date || null,
        effectiveDate: effectiveReportDate(r)
      }));
      res.json({
        success: true,
        max: MAX_REPORTS_PER_USER,
        used: reports.length,
        free: Math.max(0, MAX_REPORTS_PER_USER - reports.length),
        nextSlotNo: reports.length + 1,
        reports
      });
    } catch (e) {
      console.error('[blood slots]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Could not read upload slots' });
    }
  });

  router.get('/admin/all', staffOnly, async (req, res) => {
    try {
      const st = String(req.query.status || 'all').toLowerCase();
      let extra = '';
      if (st === 'complete') {
        extra = ` AND r.status = 'complete' AND COALESCE(r.sent_to_user, false) = false`;
      } else if (st === 'pending') {
        extra = ` AND r.status IN ('pending','extracting','analysing','generating_pdf')`;
      } else if (st === 'sent') {
        extra = ' AND r.sent_to_user = true';
      }
      // Slot numbering ("Blood Report 1/2/3") is computed inside the subquery, over the
      // client's WHOLE set, so a status filter can hide report 2 without renumbering
      // report 3. Oldest lab date is always slot 1 — a report's number never moves.
      const rows = await queryAll(
        `SELECT * FROM (
           SELECT r.*, u.profile_picture AS client_profile_picture,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.user_id
                    ORDER BY COALESCE(r.report_date, r.created_at::date) ASC, r.created_at ASC
                  ) AS slot_no,
                  COUNT(*) OVER (PARTITION BY r.user_id) AS slot_total
           FROM blood_analysis_reports r
           LEFT JOIN users u ON u.id = r.user_id
         ) r
         WHERE 1=1 ${extra}
         ORDER BY COALESCE(r.report_date, r.created_at::date) DESC, r.created_at DESC`
      );
      res.json({
        reports: (rows || []).map((r) => mapReportRow(r)),
        slotMax: MAX_REPORTS_PER_USER
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/admin/send/:reportId', staffOnly, async (req, res) => {
    try {
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      if (!report) {
        return res.status(404).json({ success: false, error: 'Report not found' });
      }
      const pdfPath = await ensureHealthReportPdf(db, req.params.reportId);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return res.status(400).json({ success: false, error: 'Report not ready' });
      }

      let aiReport = report.ai_report;
      if (typeof aiReport === 'string') {
        try {
          aiReport = JSON.parse(aiReport);
        } catch (_) {
          aiReport = {};
        }
      }

      const emailed = await userEmail.emailHealthReportWithPdf({
        toEmail: report.user_email,
        firstName: (report.user_name || '').split(/\s+/)[0] || 'there',
        pdfPath,
        adminNotes: report.admin_notes || '',
        overallStatus: aiReport && aiReport.overall_status,
        summary: aiReport && aiReport.overall_summary_short
      });
      if (!emailed) {
        if (!userEmail.isConfigured()) {
          return res.status(503).json({ success: false, error: 'Email is not configured (SMTP).' });
        }
        return res.status(500).json({ success: false, error: 'Failed to send email with PDF attachment.' });
      }

      const inboxId = uuidv4();
      const summaryShort = (aiReport && aiReport.overall_summary_short) || '';
      await run(
        `INSERT INTO user_inbox (id, user_id, title, body, type, is_read) VALUES (?, ?, ?, ?, ?, FALSE)`,
        [
          inboxId,
          report.user_id,
          'Your BodyBank Health Report is Ready',
          `Your comprehensive blood analysis report is ready. ${summaryShort}`.slice(0, 4000),
          'health_report'
        ]
      );

      await run(`UPDATE blood_analysis_reports SET sent_to_user = true, sent_at = CURRENT_TIMESTAMP WHERE id = ?`, [
        req.params.reportId
      ]);

      notifyAsync('BLOOD_REPORT_SENT', { name: report.user_name || '—', email: report.user_email || '—' });
      res.json({ success: true });
    } catch (e) {
      console.error('[blood admin send]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.put('/admin/notes/:reportId', staffOnly, async (req, res) => {
    try {
      const notes = String((req.body && req.body.adminNotes) || '').slice(0, 8000);
      await run(`UPDATE blood_analysis_reports SET admin_notes = ? WHERE id = ?`, [notes, req.params.reportId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/admin/retry/:reportId', staffOnly, rateLimiter(3, 120000), async (req, res) => {
    try {
      const { reportId } = req.params;
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
      if (!report) {
        return res.status(404).json({ success: false, error: 'Report not found' });
      }
      const st = String(report.status || '').toLowerCase();
      const force = !!(req.body && (req.body.force === true || req.body.force === 'true'));
      if ((st === 'extracting' || st === 'analysing') && !force) {
        return res.status(409).json({
          success: false,
          error: 'Analysis is currently in progress. Use force retry for stuck jobs.'
        });
      }
      if (st !== 'failed' && st !== 'pending' && st !== 'generating_pdf') {
        return res.status(400).json({
          success: false,
          error: 'Retry is only for failed, stuck pending, or incomplete PDF reports.'
        });
      }

      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) {
        return res.status(503).json({
          success: false,
          error: 'ANTHROPIC_API_KEY is not set on the server. Add credits / key in environment and try again.'
        });
      }

      // If a valid extraction already exists, analysis can be re-run WITHOUT the
      // original lab file (which may be gone after a redeploy on ephemeral disk).
      let hasExtraction = false;
      try {
        let ex = report.extracted_blood_data;
        if (typeof ex === 'string') ex = JSON.parse(ex);
        hasExtraction = !!(ex && Array.isArray(ex.panels) && ex.panels.length > 0);
      } catch (_) {}

      let b64 = '';
      let mime = '';
      if (!hasExtraction) {
        const rawPath = report.blood_report_file_path;
        const resolved = rawPath ? resolveStoredUploadPath(String(rawPath).trim()) : null;
        if (!resolved || !fs.existsSync(resolved)) {
          return res.status(400).json({
            success: false,
            error:
              'Original lab file is missing from server storage (common after redeploy without persistent disk). Ask the client to upload the report again.'
          });
        }

        let buf;
        try {
          buf = fs.readFileSync(resolved);
        } catch (readErr) {
          return res.status(400).json({
            success: false,
            error: `Could not read lab file: ${readErr && readErr.message ? readErr.message : 'read error'}`
          });
        }
        if (!buf || buf.length === 0) {
          return res.status(400).json({ success: false, error: 'Lab file is empty.' });
        }
        if (buf.length > MAX_BLOOD_FILE_BYTES) {
          return res.status(400).json({ success: false, error: 'Lab file is too large to reprocess.' });
        }

        b64 = buf.toString('base64');
        mime = mimeFromBloodFilePath(resolved);
      }
      const userId = report.user_id;

      // Keep extracted_blood_data + extraction_ai_usage so the pipeline reuses the
      // (expensive) extraction and only re-runs analysis — no double-charging on retry.
      await run(
        `UPDATE blood_analysis_reports
         SET status = 'pending', pdf_path = NULL, nutrition_snapshot = NULL, ai_report = NULL,
             analysis_ai_usage = NULL, total_ai_usage = NULL, analysis_last_error = NULL
         WHERE id = ?`,
        [reportId]
      );

      triggerBloodAnalysis(db, reportId, b64, mime, userId).catch((err) =>
        console.error('[blood] Retry pipeline failed:', err && err.message)
      );

      return res.json({
        success: true,
        message:
          'Analysis restarted using the saved lab file. Refresh this list in a minute. If it fails again, the last error will show on the card.'
      });
    } catch (e) {
      console.error('[blood admin retry]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Retry failed' });
    }
  });

  // ==========================================================================
  // BLOOD REPORT COMPARISON (longitudinal progress reviews) — admin only
  // ==========================================================================

  // Shared: load the compared report rows, ensure they all belong to the client
  // and carry extracted panel data (only processed reports can be compared).
  async function loadComparableReports(userId, reportIds) {
    const rows = await queryAll(
      `SELECT * FROM blood_analysis_reports WHERE user_id = ?
       ORDER BY COALESCE(report_date, created_at::date) ASC, created_at ASC`,
      [userId]
    );
    const byId = {};
    (rows || []).forEach((r) => { byId[r.id] = r; });
    const chosen = [];
    for (const id of reportIds) {
      const r = byId[id];
      if (!r) return { error: `Report ${id} not found for this client.` };
      const extracted = parseJsonCol(r.extracted_blood_data);
      if (!extracted || !Array.isArray(extracted.panels) || !extracted.panels.length) {
        return { error: 'One of the selected reports has no processed blood data yet. Process it first, then compare.' };
      }
      chosen.push(r);
    }
    return { rows: chosen };
  }

  // Clients that have 2+ processed reports — the pick list for the compare tool.
  router.get('/admin/comparable', staffOnly, async (req, res) => {
    try {
      // slot_no is numbered inside the subquery, over the client's WHOLE set, and only
      // then filtered to the processed ones — so an unprocessed report still holds its
      // number and the picker agrees with the report card above it.
      const rows = await queryAll(
        `SELECT * FROM (
           SELECT r.id, r.user_id, r.user_name, r.user_email, r.created_at, r.report_date, r.status,
                  r.ai_report->>'overall_status' AS overall_status,
                  (r.extracted_blood_data IS NOT NULL) AS has_data,
                  (r.blood_report_file_path IS NOT NULL AND r.blood_report_file_path <> '') AS has_source_file,
                  u.profile_picture AS client_profile_picture,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.user_id
                    ORDER BY COALESCE(r.report_date, r.created_at::date) ASC, r.created_at ASC
                  ) AS slot_no
           FROM blood_analysis_reports r
           LEFT JOIN users u ON u.id = r.user_id
         ) r
         WHERE r.has_data
         ORDER BY r.user_id, COALESCE(r.report_date, r.created_at::date) DESC, r.created_at DESC`
      );
      const byUser = new Map();
      (rows || []).forEach((r) => {
        if (!byUser.has(r.user_id)) {
          byUser.set(r.user_id, {
            userId: r.user_id,
            userName: r.user_name || r.user_email || '—',
            userEmail: r.user_email || '',
            profile_picture: String(r.client_profile_picture || '').trim(),
            reports: []
          });
        }
        byUser.get(r.user_id).reports.push({
          id: r.id,
          createdAt: r.created_at,
          reportDate: r.report_date || null,
          effectiveDate: effectiveReportDate(r),
          hasSourceFile: !!r.has_source_file,
          status: r.status,
          overallStatus: r.overall_status || null,
          slotNo: r.slot_no != null ? Number(r.slot_no) : null
        });
      });
      const clients = Array.from(byUser.values())
        .filter((c) => c.reports.length >= CMP_MIN_REPORTS)
        .sort((a, b) => String(a.userName).localeCompare(String(b.userName)));
      res.json({ clients });
    } catch (e) {
      console.error('[blood comparable]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // List saved comparisons for a client.
  router.get('/admin/comparisons/:userId', staffOnly, async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT c.*, u.profile_picture AS client_profile_picture, u.phone AS client_phone
         FROM blood_comparison_reports c
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.user_id = ? ORDER BY c.created_at DESC`,
        [req.params.userId]
      );
      res.json({ comparisons: (rows || []).map(mapComparisonRow) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Fetch one comparison.
  router.get('/admin/comparison/:id', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(
        `SELECT c.*, u.profile_picture AS client_profile_picture, u.phone AS client_phone
         FROM blood_comparison_reports c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.id = ?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: 'Comparison not found' });
      res.json({ comparison: mapComparisonRow(row) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Build a new comparison: deterministic alignment + (optional) Claude verdict.
  router.post('/admin/compare', staffOnly, rateLimiter(6, 120000), async (req, res) => {
    try {
      const userId = String((req.body && req.body.userId) || '').trim();
      let reportIds = (req.body && req.body.reportIds) || [];
      const runAi = !(req.body && req.body.runAi === false);
      if (!userId) return res.status(400).json({ success: false, error: 'Missing client id' });
      if (!Array.isArray(reportIds)) reportIds = [];
      reportIds = reportIds.map((x) => String(x)).filter(Boolean);
      // de-dup, preserve order
      reportIds = reportIds.filter((v, i) => reportIds.indexOf(v) === i);
      if (reportIds.length < CMP_MIN_REPORTS) {
        return res.status(400).json({ success: false, error: `Select at least ${CMP_MIN_REPORTS} reports to compare.` });
      }
      if (reportIds.length > CMP_MAX_REPORTS) {
        return res.status(400).json({ success: false, error: `Compare up to ${CMP_MAX_REPORTS} reports at a time.` });
      }

      const loaded = await loadComparableReports(userId, reportIds);
      if (loaded.error) return res.status(400).json({ success: false, error: loaded.error });
      const rows = loaded.rows;

      const comparison = alignReports(rows);
      if (!comparison.markerCount) {
        return res.status(400).json({ success: false, error: 'No comparable markers were found across the selected reports.' });
      }

      // Patient context from the newest compared report, by LAB date.
      const newest = rows.slice().sort((a, b) => reportTimelineMs(b) - reportTimelineMs(a))[0];
      const u = await queryOne(
        `SELECT id, first_name, last_name, email FROM users WHERE id = ?`,
        [userId]
      );
      const displayName =
        [u && u.first_name, u && u.last_name].filter(Boolean).join(' ').trim() ||
        newest.user_name || (u && u.email) || 'Member';

      // Union of reported symptoms across compared reports.
      const symSet = new Set();
      rows.forEach((r) => {
        const s = parseJsonCol(r.symptoms);
        if (Array.isArray(s)) s.forEach((x) => symSet.add(String(x)));
      });
      const symptomsText = symSet.size ? Array.from(symSet).join(', ') : 'None reported';

      let verdict = null;
      let aiUsage = null;
      if (runAi) {
        const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
        if (!apiKey) {
          return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY is not set on the server.' });
        }
        // Fresh 7-day nutrition context for cause/effect reasoning.
        let nutritionNote = 'No nutrition summary available.';
        try {
          const today = new Date().toISOString().split('T')[0];
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          const nut = await computeNutritionSummaryForUserWindow(db, userId, weekAgo, today);
          if (nut) nutritionNote = JSON.stringify(nut).slice(0, 4000);
        } catch (_) {}

        const out = await generateComparisonVerdict({
          apiKey,
          patient: {
            name: displayName,
            age: newest.user_age || '',
            gender: newest.user_gender || '',
            goal: newest.user_goal || ''
          },
          comparison,
          symptomsText,
          nutritionNote
        });
        verdict = out.verdict;
        aiUsage = out.usage;
        recordAiUsage({ scope: 'blood_comparison', usage: aiUsage, userId, refType: 'blood_comparison' });
        if (!verdict) {
          return res.status(502).json({
            success: false,
            error: `The AI verdict did not return valid JSON (stop reason: ${out.stopReason || 'unknown'}). Try again.`
          });
        }
      }

      const id = uuidv4();
      await run(
        `INSERT INTO blood_comparison_reports (
           id, user_id, report_ids, comparison_data, ai_verdict, ai_usage,
           status, user_name, user_email, user_age, user_gender, user_goal
         ) VALUES (?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId,
          JSON.stringify(reportIds),
          JSON.stringify(comparison),
          verdict ? JSON.stringify(verdict) : null,
          aiUsage ? JSON.stringify(aiUsage) : null,
          verdict ? 'complete' : 'draft',
          displayName,
          (u && u.email) || newest.user_email || '',
          newest.user_age || '',
          newest.user_gender || '',
          newest.user_goal || ''
        ]
      );

      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [id]);
      res.json({ success: true, comparison: mapComparisonRow(row) });
    } catch (e) {
      console.error('[blood compare]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Comparison failed' });
    }
  });

  // Edit admin notes and/or the AI verdict (coach can refine before sending).
  router.put('/admin/comparison/:id', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      const sets = [];
      const args = [];
      if (req.body && typeof req.body.adminNotes === 'string') {
        const note = String(req.body.adminNotes).slice(0, 8000);
        sets.push('admin_notes = ?');
        args.push(note);
        // The coach note also lives inside the editable document. Patch it there too
        // so saving a note from the summary view doesn't get overwritten at print time
        // by the copy the reviewer last saw in the editor.
        const stored = parseJsonCol(row.report_doc);
        if (stored && Array.isArray(stored.sections)) {
          sets.push('report_doc = ?::jsonb');
          args.push(JSON.stringify(sanitizeComparisonDoc(setDocCoachNote(stored, note))));
        }
      }
      if (req.body && req.body.verdict && typeof req.body.verdict === 'object') {
        // Note: when an edited document exists it is what prints — the document is
        // the editing surface for the report itself, not this raw verdict column.
        sets.push('ai_verdict = ?::jsonb');
        args.push(JSON.stringify(req.body.verdict));
      }
      if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
      // Any edit invalidates a cached PDF so the next download reflects the change.
      sets.push('pdf_path = NULL');
      args.push(req.params.id);
      await run(`UPDATE blood_comparison_reports SET ${sets.join(', ')} WHERE id = ?`, args);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Regenerate the AI verdict for an existing comparison (reuses stored alignment).
  router.post('/admin/comparison/:id/regenerate', staffOnly, rateLimiter(6, 120000), async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      const reportIds = parseJsonCol(row.report_ids) || [];
      const loaded = await loadComparableReports(row.user_id, reportIds.map(String));
      if (loaded.error) return res.status(400).json({ success: false, error: loaded.error });
      const comparison = alignReports(loaded.rows);

      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY is not set on the server.' });

      const symSet = new Set();
      loaded.rows.forEach((r) => {
        const s = parseJsonCol(r.symptoms);
        if (Array.isArray(s)) s.forEach((x) => symSet.add(String(x)));
      });
      let nutritionNote = 'No nutrition summary available.';
      try {
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const nut = await computeNutritionSummaryForUserWindow(db, row.user_id, weekAgo, today);
        if (nut) nutritionNote = JSON.stringify(nut).slice(0, 4000);
      } catch (_) {}

      const out = await generateComparisonVerdict({
        apiKey,
        patient: { name: row.user_name || 'Member', age: row.user_age || '', gender: row.user_gender || '', goal: row.user_goal || '' },
        comparison,
        symptomsText: symSet.size ? Array.from(symSet).join(', ') : 'None reported',
        nutritionNote
      });
      recordAiUsage({
        scope: 'blood_comparison',
        usage: out.usage,
        userId: row.user_id,
        refType: 'blood_comparison',
        refId: req.params.id
      });
      if (!out.verdict) {
        return res.status(502).json({ success: false, error: `AI verdict failed (stop reason: ${out.stopReason || 'unknown'}).` });
      }
      // A fresh verdict replaces every word the old document was built from, so any
      // prior hand-editing no longer maps onto it — drop the document and start clean.
      await run(
        `UPDATE blood_comparison_reports
         SET comparison_data = ?::jsonb, ai_verdict = ?::jsonb, ai_usage = ?::jsonb, status = 'complete',
             pdf_path = NULL, report_doc = NULL, doc_updated_at = NULL, doc_updated_by = ''
         WHERE id = ?`,
        [JSON.stringify(comparison), JSON.stringify(out.verdict), JSON.stringify(out.usage), req.params.id]
      );
      const updated = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      res.json({ success: true, comparison: mapComparisonRow(updated) });
    } catch (e) {
      console.error('[blood compare regen]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Regenerate failed' });
    }
  });

  // Ensure a progress PDF exists for a comparison row; returns absolute path.
  // Always renders the EFFECTIVE document, so a reviewer's edits are what print.
  const ensureComparisonPdf = (row) => ensureComparisonPdfForRow(run, row);

  // ---- editable progress-report document -----------------------------------
  // The document is what the in-app editor renders and what the PDF is drawn from.
  // Loading it never mutates anything: an un-edited comparison just gets its default
  // document built on the fly, so opening the editor is free.

  router.get('/admin/comparison/:id/doc', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(
        `SELECT c.*, u.phone AS client_phone
         FROM blood_comparison_reports c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.id = ?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      const { doc, edited } = comparisonDocFor(row);
      if (!doc) {
        return res.status(400).json({ success: false, error: 'This comparison has no aligned marker data to edit.' });
      }
      res.json({
        success: true,
        doc,
        edited,
        docUpdatedAt: row.doc_updated_at || null,
        docUpdatedBy: row.doc_updated_by || '',
        hasVerdict: !!parseJsonCol(row.ai_verdict),
        clientName: row.user_name || 'Member',
        clientPhone: row.client_phone || '',
        sentToUser: !!row.sent_to_user
      });
    } catch (e) {
      console.error('[blood compare doc]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.put('/admin/comparison/:id/doc', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT id FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      const incoming = req.body && req.body.doc;
      if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.sections)) {
        return res.status(400).json({ success: false, error: 'Malformed report document.' });
      }
      const doc = sanitizeComparisonDoc(incoming);
      if (!docHasVisibleContent(doc)) {
        return res.status(400).json({ success: false, error: 'The report would be empty — keep at least one visible section.' });
      }
      // The coach note lives in the document now, but admin_notes still drives the
      // email body and the member-facing summary, so keep the two in step.
      const editor = String((req.user && (req.user.email || req.user.id)) || '').slice(0, 200);
      await run(
        `UPDATE blood_comparison_reports
         SET report_doc = ?::jsonb, admin_notes = ?, doc_updated_at = CURRENT_TIMESTAMP, doc_updated_by = ?, pdf_path = NULL
         WHERE id = ?`,
        [JSON.stringify(doc), docCoachNote(doc).slice(0, 8000), editor, req.params.id]
      );
      res.json({ success: true, doc });
    } catch (e) {
      console.error('[blood compare doc save]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Throw away the reviewer's edits and go back to the AI-generated layout.
  router.post('/admin/comparison/:id/doc/reset', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      await run(
        `UPDATE blood_comparison_reports
         SET report_doc = NULL, doc_updated_at = NULL, doc_updated_by = '', pdf_path = NULL
         WHERE id = ?`,
        [req.params.id]
      );
      const fresh = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      const { doc } = comparisonDocFor(fresh);
      if (!doc) return res.status(400).json({ success: false, error: 'This comparison has no aligned marker data to edit.' });
      res.json({ success: true, doc, edited: false });
    } catch (e) {
      console.error('[blood compare doc reset]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Download the branded progress PDF (generated on demand).
  // `?inline=1` serves it for in-browser preview instead of forcing a download.
  router.get('/admin/comparison/:id/pdf', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Comparison not found' });
      const pdfPath = await ensureComparisonPdf(row);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return res.status(400).json({ error: 'Comparison PDF could not be generated (run the AI verdict first).' });
      }
      if (String(req.query.inline || '') === '1') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="BodyBank_Progress_Report.pdf"');
        return fs.createReadStream(pdfPath).pipe(res);
      }
      res.download(pdfPath, 'BodyBank_Progress_Report.pdf');
    } catch (e) {
      console.error('[blood compare pdf]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Send the progress report to the client by email + inbox.
  router.post('/admin/comparison/:id/send', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      const verdict = parseJsonCol(row.ai_verdict);
      if (!verdict) return res.status(400).json({ success: false, error: 'Run the AI verdict before sending.' });
      const pdfPath = await ensureComparisonPdf(row);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return res.status(400).json({ success: false, error: 'Progress report is not ready.' });
      }
      // The email blurb must quote the report the client is about to open, so read it
      // off the effective document rather than the raw AI verdict.
      const effective = comparisonDocFor(row).doc;
      const cover = (effective && effective.cover) || {};
      const coverTraj = cover.trajectory || {};
      const overallStatus = coverTraj.label || verdict.overall_trajectory;
      const summary = coverTraj.summary || verdict.executive_summary;
      const emailed = await userEmail.emailHealthReportWithPdf({
        toEmail: row.user_email,
        firstName: (row.user_name || '').split(/\s+/)[0] || 'there',
        pdfPath,
        adminNotes: row.admin_notes || '',
        overallStatus,
        summary
      });
      if (!emailed) {
        if (!userEmail.isConfigured()) {
          return res.status(503).json({ success: false, error: 'Email is not configured (SMTP).' });
        }
        return res.status(500).json({ success: false, error: 'Failed to send email with PDF attachment.' });
      }
      const inboxId = uuidv4();
      await run(
        `INSERT INTO user_inbox (id, user_id, title, body, type, is_read) VALUES (?, ?, ?, ?, ?, FALSE)`,
        [
          inboxId,
          row.user_id,
          'Your BodyBank Blood Progress Report is Ready',
          `Your blood-report progress review is ready. ${String(summary || '')}`.slice(0, 4000),
          'health_report'
        ]
      );
      await run(`UPDATE blood_comparison_reports SET sent_to_user = true, sent_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
      notifyAsync('BLOOD_REPORT_SENT', { name: row.user_name || '—', email: row.user_email || '—' });
      res.json({ success: true });
    } catch (e) {
      console.error('[blood compare send]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- WhatsApp / link sharing ---------------------------------------------
  // Mint (or reuse) a public link to the finished report so staff can drop it into
  // the client's WhatsApp chat. An unexpired token is reused rather than rotated —
  // rotating would silently break a link already sitting in someone's chat history.
  router.post('/admin/comparison/:id/share-link', staffOnly, rateLimiter(30, 120000), async (req, res) => {
    try {
      const row = await queryOne(
        `SELECT c.*, u.phone AS client_phone, u.first_name AS client_first_name
         FROM blood_comparison_reports c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.id = ?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });

      const pdfPath = await ensureComparisonPdf(row);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return res.status(400).json({ success: false, error: 'The report PDF could not be generated yet.' });
      }

      const rotate = String((req.body && req.body.rotate) || req.query.rotate || '') === '1';
      const stillValid = row.share_token && row.share_expires_at && new Date(row.share_expires_at).getTime() > Date.now();
      let token = stillValid && !rotate ? String(row.share_token) : newShareToken();
      let expiresAt = stillValid && !rotate ? row.share_expires_at : new Date(Date.now() + SHARE_LINK_DAYS * 86400000);

      if (!stillValid || rotate) {
        await run(
          `UPDATE blood_comparison_reports
           SET share_token = ?, share_expires_at = ?, share_created_at = CURRENT_TIMESTAMP, share_created_by = ?
           WHERE id = ?`,
          [token, expiresAt, String((req.user && (req.user.email || req.user.id)) || '').slice(0, 200), req.params.id]
        );
      }

      const url = shareUrlFor(req, token);
      const firstName = String(row.client_first_name || row.user_name || '').split(/\s+/)[0];
      const message = shareMessage(firstName, url, expiresAt);
      const digits = waDigits(row.client_phone);
      res.json({
        success: true,
        url,
        expiresAt,
        message,
        clientName: row.user_name || firstName || 'Member',
        clientPhone: row.client_phone || '',
        // Empty when we have no usable number — the UI then offers copy/share instead.
        waUrl: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : ''
      });
    } catch (e) {
      console.error('[blood compare share-link]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Kill an outstanding link (client asked, wrong person, report withdrawn).
  router.delete('/admin/comparison/:id/share-link', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT id FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      await run(
        `UPDATE blood_comparison_reports SET share_token = NULL, share_expires_at = NULL WHERE id = ?`,
        [req.params.id]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.delete('/admin/comparison/:id', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT pdf_path FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ success: false, error: 'Comparison not found' });
      try {
        const resolved = row.pdf_path ? resolveStoredUploadPath(String(row.pdf_path).trim()) : null;
        if (resolved && fs.existsSync(resolved)) fs.unlinkSync(resolved);
      } catch (_) {}
      await run(`DELETE FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

/**
 * PUBLIC router for shared progress reports — mounted at /r/blood, deliberately
 * outside the authenticated router above. The token IS the credential, so it is
 * long and random, scoped to one comparison, expiring, and revocable. Responses
 * are marked private and no-index so the PDF never lands in a cache or a crawler.
 */
function createBloodPublicRouter(deps) {
  const { run, queryOne, rateLimiter } = deps;
  const router = require('express').Router();

  const deny = (res, code, msg) => res
    .status(code)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BodyBank</title>
<body style="margin:0;background:#0d0f11;color:#f0ede8;font:16px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px">
<div style="max-width:420px;text-align:center">
<div style="font-size:20px;font-weight:700;color:#3dd68c;margin-bottom:10px">BodyBank.fit</div>
<p style="color:#8a8880">${msg}</p>
<p style="color:#8a8880;font-size:13px">Please ask your coach to send a fresh link.</p>
</div></body>`);

  router.get('/:token', rateLimiter(60, 60000), async (req, res) => {
    try {
      const token = String(req.params.token || '');
      // Length check first so a junk request never reaches the database.
      if (token.length < 20 || token.length > 128) return deny(res, 404, 'This report link is not valid.');

      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE share_token = ?`, [token]);
      if (!row) return deny(res, 404, 'This report link is not valid.');
      if (!row.share_expires_at || new Date(row.share_expires_at).getTime() < Date.now()) {
        return deny(res, 410, 'This report link has expired.');
      }

      const pdfPath = await ensureComparisonPdfForRow(run, row);
      if (!pdfPath || !fs.existsSync(pdfPath)) return deny(res, 404, 'This report is not available.');

      const who = String(row.user_name || 'Client').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Client';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="BodyBank_Progress_${who}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Referrer-Policy', 'no-referrer');
      fs.createReadStream(pdfPath).pipe(res);

      run(`UPDATE blood_comparison_reports SET share_last_viewed_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id])
        .catch(() => {});
    } catch (e) {
      console.error('[blood share view]', e.message);
      deny(res, 500, 'Something went wrong opening this report.');
    }
  });

  return router;
}

module.exports = { createBloodRouter, createBloodPublicRouter };
