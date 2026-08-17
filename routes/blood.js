'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const userEmail = require('../services/userEmailService');
const { notifyAsync } = require('../utils/notify');
const {
  triggerBloodAnalysis,
  ensureHealthReportPdf,
  validateBloodReportInput,
  resolveStoredUploadPath
} = require('../services/bloodAnalysisService');
const { alignReports, generateComparisonVerdict, reportTimelineMs } = require('../services/bloodComparisonService');
const { generateComparisonReportPdf } = require('../services/pdfService');
const { computeNutritionSummaryForUserWindow } = require('../services/nutritionService');

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
    profile_picture: String(r.client_profile_picture || '').trim()
  };
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
    profile_picture: String(r.client_profile_picture || '').trim()
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
      const rows = await queryAll(
        `SELECT id, created_at, sent_at,
                ai_verdict->>'overall_trajectory' AS trajectory,
                ai_verdict->>'executive_summary' AS summary
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
      const rows = await queryAll(
        `SELECT r.*, u.profile_picture AS client_profile_picture
         FROM blood_analysis_reports r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE 1=1 ${extra}
         ORDER BY COALESCE(r.report_date, r.created_at::date) DESC, r.created_at DESC`
      );
      res.json({ reports: (rows || []).map((r) => mapReportRow(r)) });
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
      const rows = await queryAll(
        `SELECT r.id, r.user_id, r.user_name, r.user_email, r.created_at, r.report_date, r.status,
                r.ai_report->>'overall_status' AS overall_status,
                (r.extracted_blood_data IS NOT NULL) AS has_data,
                (r.blood_report_file_path IS NOT NULL AND r.blood_report_file_path <> '') AS has_source_file,
                u.profile_picture AS client_profile_picture
         FROM blood_analysis_reports r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE r.extracted_blood_data IS NOT NULL
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
          overallStatus: r.overall_status || null
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
        `SELECT c.*, u.profile_picture AS client_profile_picture
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
        `SELECT c.*, u.profile_picture AS client_profile_picture
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
        sets.push('admin_notes = ?');
        args.push(String(req.body.adminNotes).slice(0, 8000));
      }
      if (req.body && req.body.verdict && typeof req.body.verdict === 'object') {
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
      if (!out.verdict) {
        return res.status(502).json({ success: false, error: `AI verdict failed (stop reason: ${out.stopReason || 'unknown'}).` });
      }
      await run(
        `UPDATE blood_comparison_reports
         SET comparison_data = ?::jsonb, ai_verdict = ?::jsonb, ai_usage = ?::jsonb, status = 'complete', pdf_path = NULL
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
  async function ensureComparisonPdf(row) {
    const existing = row.pdf_path ? resolveStoredUploadPath(String(row.pdf_path).trim()) : null;
    if (existing && fs.existsSync(existing)) return existing;
    const comparison = parseJsonCol(row.comparison_data);
    const verdict = parseJsonCol(row.ai_verdict) || {};
    if (!comparison || !Array.isArray(comparison.panels)) return null;
    const verdictForPdf = {
      ...verdict,
      __improved: comparison.improvedCount,
      __worsened: comparison.worsenedCount,
      __markerCount: comparison.markerCount
    };
    const pdfPath = await generateComparisonReportPdf({
      comparisonId: row.id,
      user: {
        name: row.user_name || 'Member',
        age: row.user_age || '—',
        gender: row.user_gender || '—',
        goal: row.user_goal || '—'
      },
      comparison,
      verdict: verdictForPdf,
      adminNotes: row.admin_notes || ''
    });
    await run(`UPDATE blood_comparison_reports SET pdf_path = ? WHERE id = ?`, [pdfPath, row.id]).catch(() => {});
    return pdfPath;
  }

  // Download the branded progress PDF (generated on demand).
  router.get('/admin/comparison/:id/pdf', staffOnly, async (req, res) => {
    try {
      const row = await queryOne(`SELECT * FROM blood_comparison_reports WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Comparison not found' });
      const pdfPath = await ensureComparisonPdf(row);
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return res.status(400).json({ error: 'Comparison PDF could not be generated (run the AI verdict first).' });
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
      const emailed = await userEmail.emailHealthReportWithPdf({
        toEmail: row.user_email,
        firstName: (row.user_name || '').split(/\s+/)[0] || 'there',
        pdfPath,
        adminNotes: row.admin_notes || '',
        overallStatus: verdict.overall_trajectory,
        summary: verdict.executive_summary
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
          `Your blood-report progress review is ready. ${String(verdict.executive_summary || '')}`.slice(0, 4000),
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

module.exports = { createBloodRouter };
