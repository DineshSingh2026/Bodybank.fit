'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const userEmail = require('../services/userEmailService');
const { triggerBloodAnalysis, ensureHealthReportPdf, resolveStoredUploadPath } = require('../services/bloodAnalysisService');

const MAX_B64_CHARS = 22 * 1024 * 1024;
const MAX_BLOOD_FILE_BYTES = Math.floor(MAX_B64_CHARS * 3 / 4);

function mapReportRow(r) {
  if (!r) return null;
  const id = r.id;
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
    sentToUser: !!r.sent_to_user,
    sentAt: r.sent_at,
    adminNotes: r.admin_notes,
    pdfUrl: r.pdf_path,
    aiReport,
    analysisLastError: r.analysis_last_error || ''
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

function createBloodRouter(deps) {
  const { run, queryOne, queryAll, verifyToken, requireAdminOrSuperadmin, rateLimiter } = deps;
  const db = { run, queryOne, queryAll };

  const router = require('express').Router();
  router.use(verifyToken);
  const adminOnly = requireAdminOrSuperadmin;

  router.post('/upload', rateLimiter(5, 120000), async (req, res) => {
    try {
      const userId = req.user.id;
      const { bloodReportBase64, bloodReportMimeType, symptoms, userAge, userGender, userGoal } = req.body || {};
      const b64 = bloodReportBase64 ? String(bloodReportBase64).replace(/\s/g, '') : '';
      if (!b64) return res.status(400).json({ error: 'No file provided' });
      if (b64.length > MAX_B64_CHARS) return res.status(400).json({ error: 'File payload too large' });

      const mime = String(bloodReportMimeType || 'image/jpeg').slice(0, 80);
      const ext = mime.toLowerCase().includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
      const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
      const fileDir = path.join(uploadsRoot, 'blood-reports');
      fs.mkdirSync(fileDir, { recursive: true });
      const fileName = `blood_${userId}_${Date.now()}.${ext}`;
      const filePath = path.join(fileDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));

      const u = await queryOne(`SELECT id, first_name, last_name, email FROM users WHERE id = ?`, [userId]);
      const displayName = [u && u.first_name, u && u.last_name].filter(Boolean).join(' ').trim() || (u && u.email) || '';

      const symList = Array.isArray(symptoms) ? symptoms.map((s) => String(s).slice(0, 80)) : [];
      const reportId = uuidv4();

      await run(
        `INSERT INTO blood_analysis_reports (
          id, user_id, blood_report_file_path, symptoms, status,
          user_name, user_email, user_age, user_gender, user_goal
        ) VALUES (?, ?, ?, ?::jsonb, 'pending', ?, ?, ?, ?, ?)`,
        [
          reportId,
          userId,
          filePath,
          JSON.stringify(symList),
          displayName,
          u && u.email ? String(u.email) : '',
          userAge != null ? String(userAge).slice(0, 32) : '',
          userGender != null ? String(userGender).slice(0, 32) : '',
          userGoal != null ? String(userGoal).slice(0, 200) : ''
        ]
      );

      triggerBloodAnalysis(db, reportId, b64, mime, userId).catch((err) =>
        console.error('[blood] Analysis pipeline failed:', err && err.message)
      );

      res.json({ success: true, reportId });
    } catch (e) {
      console.error('[blood upload]', e.message);
      res.status(500).json({ success: false, error: e.message || 'Upload failed' });
    }
  });

  router.get('/pdf/:reportId', async (req, res) => {
    try {
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [req.params.reportId]);
      if (!report) return res.status(404).json({ error: 'Not found' });
      const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
      if (report.user_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
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

  router.get('/my-reports', async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT * FROM blood_analysis_reports WHERE user_id = ? ORDER BY created_at DESC`,
        [req.user.id]
      );
      const reports = (rows || []).map((r) => mapReportRow(r));
      res.json({ reports });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/all', adminOnly, async (req, res) => {
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
        `SELECT r.* FROM blood_analysis_reports r WHERE 1=1 ${extra} ORDER BY r.created_at DESC`
      );
      res.json({ reports: (rows || []).map((r) => mapReportRow(r)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/admin/send/:reportId', adminOnly, async (req, res) => {
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

      res.json({ success: true });
    } catch (e) {
      console.error('[blood admin send]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.put('/admin/notes/:reportId', adminOnly, async (req, res) => {
    try {
      const notes = String((req.body && req.body.adminNotes) || '').slice(0, 8000);
      await run(`UPDATE blood_analysis_reports SET admin_notes = ? WHERE id = ?`, [notes, req.params.reportId]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/admin/retry/:reportId', adminOnly, rateLimiter(3, 120000), async (req, res) => {
    try {
      const { reportId } = req.params;
      const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
      if (!report) {
        return res.status(404).json({ success: false, error: 'Report not found' });
      }
      const st = String(report.status || '').toLowerCase();
      if (st === 'extracting' || st === 'analysing') {
        return res.status(409).json({
          success: false,
          error: 'Analysis is already in progress for this report. Wait or refresh in a minute.'
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

      const b64 = buf.toString('base64');
      const mime = mimeFromBloodFilePath(resolved);
      const userId = report.user_id;

      await run(
        `UPDATE blood_analysis_reports SET status = 'pending', pdf_path = NULL, extracted_blood_data = NULL, nutrition_snapshot = NULL, ai_report = NULL, analysis_last_error = NULL WHERE id = ?`,
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

  return router;
}

module.exports = { createBloodRouter };
