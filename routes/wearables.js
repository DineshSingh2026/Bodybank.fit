'use strict';

/**
 * Wearable (Whoop) opt-in, upload and readiness routes.
 *
 * Mounted from server.js as:
 *   app.use('/api/wearables', createWearablesRouter({ run, queryOne, queryAll, verifyToken,
 *                                                     requireAdminOrSuperadmin, rateLimiter }))
 *
 * Design rules enforced here (see services/wearables/*):
 *  - Upload is preview -> confirm. Preview NEVER writes.
 *  - The file sha256 is computed from the raw bytes and passed to both calls,
 *    so re-uploading an identical export is a no-op instead of a duplicate.
 *  - Claude never computes a number: the stats engine runs first and the model
 *    only receives finished figures, which are then validated back.
 */

const express = require('express');
const crypto = require('crypto');

const readinessService = require('../services/wearables/readinessService');
const { parseWhoopExport } = require('../services/wearables/whoopParser');
const { readZipTextFiles, isZip } = require('../services/wearables/zipReader');
const { computeWhoopStats } = require('../services/wearables/whoopStatsService');
const { generateWhoopReport } = require('../services/wearables/whoopReportService');
const { buildWhoopReportPdf } = require('../services/wearables/whoopReportPdfKit');

const PROVIDER = 'whoop';
// Whoop exports are small (a few hundred KB); this is a generous ceiling that
// still keeps a hostile upload from occupying memory. express.json caps at 40mb.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function createWearablesRouter(deps = {}) {
  const { run, queryOne, queryAll, verifyToken, requireAdminOrSuperadmin, rateLimiter } = deps;

  const db = { run, queryOne, queryAll };
  const router = express.Router();

  const limit = (max, windowMs) =>
    (typeof rateLimiter === 'function' ? rateLimiter(max, windowMs) : (req, res, next) => next());

  /**
   * Decode an uploaded export and run it through the parser.
   * Accepts a ZIP (the raw Whoop download) or a single CSV pasted/uploaded directly.
   * Returns { ok, parsed, sha256, fileName } or { ok:false, status, error }.
   */
  function decodeAndParse(body) {
    const b = body || {};
    const b64 = String(b.file_base64 || b.fileBase64 || b.data || '');
    const fileName = String(b.file_name || b.fileName || 'whoop_export.zip').slice(0, 200);
    if (!b64) return { ok: false, status: 400, error: 'No file was uploaded.' };

    let buf;
    try {
      buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } catch (_) {
      return { ok: false, status: 400, error: 'That file could not be decoded.' };
    }
    if (!buf.length) return { ok: false, status: 400, error: 'That file is empty.' };
    if (buf.length > MAX_UPLOAD_BYTES) {
      return { ok: false, status: 413, error: 'That file is too large. Please upload your Whoop export directly.' };
    }

    // sha256 of the raw bytes — the idempotency key for the whole upload.
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    let files;
    try {
      if (isZip(buf)) {
        files = readZipTextFiles(buf, { extensions: ['.csv'], basename: true });
      } else {
        files = [{ name: fileName.replace(/\.[^.]*$/, '') + '.csv', text: buf.toString('utf8') }];
      }
    } catch (e) {
      // zipReader throws coded errors (ZIP_TRUNCATED, ZIP64_UNSUPPORTED, …).
      return { ok: false, status: 400, error: `That archive could not be read (${e.code || 'unreadable'}). Please re-download your Whoop export.` };
    }

    if (!files || !files.length) {
      return { ok: false, status: 400, error: 'No CSV files were found inside that export.' };
    }

    let parsed;
    try {
      parsed = parseWhoopExport({ files });
    } catch (e) {
      return { ok: false, status: 400, error: 'That export could not be parsed.' };
    }

    if (!parsed || !Array.isArray(parsed.days) || !parsed.days.length) {
      return { ok: false, status: 400, error: 'No daily records were found in that export. Make sure you exported your full Whoop data.' };
    }
    return { ok: true, parsed, sha256, fileName };
  }

  // ---- Connection / opt-in -------------------------------------------------

  router.get('/connection', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      const r = await readinessService.getConnection(db, { userId: String(req.user.id), provider: PROVIDER });
      res.json({ provider: PROVIDER, connection: (r && r.connection) || null });
    } catch (e) {
      console.error('[wearables connection]', e.message);
      res.status(500).json({ error: 'Could not load your connection.' });
    }
  });

  router.post('/opt-in', verifyToken, limit(20, 60000), async (req, res) => {
    try {
      const r = await readinessService.optIn(db, { userId: String(req.user.id), provider: PROVIDER });
      if (!r || !r.ok) return res.status(500).json({ error: 'Could not enable Whoop syncing.' });
      res.json({ ok: true, connection: r.connection });
    } catch (e) {
      console.error('[wearables opt-in]', e.message);
      res.status(500).json({ error: 'Could not enable Whoop syncing.' });
    }
  });

  router.post('/opt-out', verifyToken, limit(20, 60000), async (req, res) => {
    try {
      const r = await readinessService.optOut(db, { userId: String(req.user.id), provider: PROVIDER });
      // Opting out never deletes history — that needs the explicit purge below.
      res.json({ ok: true, dataPreserved: true, connection: r && r.connection });
    } catch (e) {
      console.error('[wearables opt-out]', e.message);
      res.status(500).json({ error: 'Could not disconnect Whoop.' });
    }
  });

  /** Explicit, user-requested deletion of all Whoop-sourced data. */
  router.delete('/data', verifyToken, limit(5, 60000), async (req, res) => {
    try {
      const r = await readinessService.purgeProviderData(db, { userId: String(req.user.id), provider: PROVIDER });
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[wearables purge]', e.message);
      res.status(500).json({ error: 'Could not delete your Whoop data.' });
    }
  });

  // ---- Upload: preview -> confirm -----------------------------------------

  /**
   * POST /api/wearables/whoop/preview
   * Parses and reports what WOULD be written. Writes nothing.
   */
  router.post('/whoop/preview', verifyToken, limit(10, 60000), async (req, res) => {
    try {
      const decoded = decodeAndParse(req.body);
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });

      const { parsed, sha256, fileName } = decoded;
      const preview = await readinessService.previewUpload(db, {
        userId: String(req.user.id),
        parsed,
        provider: PROVIDER,
        sha256
      });

      res.json({
        ok: true,
        fileName,
        sha256,
        ...preview,
        // Honesty signals — surfaced, never swallowed. unknownColumns is the
        // early warning that Whoop changed their export format.
        rowsRejected: parsed.summary.rowsRejected,
        unknownColumns: parsed.summary.unknownColumns || [],
        duplicates: parsed.summary.duplicates || [],
        notes: parsed.summary.notes || [],
        workouts: parsed.workouts.length
      });
    } catch (e) {
      console.error('[wearables preview]', e.message);
      res.status(500).json({ error: 'Could not read that export. Please try again.' });
    }
  });

  /**
   * POST /api/wearables/whoop/commit
   * Same file, now written. Re-uploading an identical file is a no-op.
   */
  router.post('/whoop/commit', verifyToken, limit(10, 60000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const decoded = decodeAndParse(req.body);
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });

      const { parsed, sha256, fileName } = decoded;
      const result = await readinessService.commitUpload(db, {
        userId,
        provider: PROVIDER,
        fileName,
        sha256,
        parsed
      });
      if (!result || !result.ok) return res.status(500).json({ error: 'Could not save that export.' });

      if (result.duplicate) {
        return res.json({ ok: true, duplicate: true, message: 'You have already uploaded this export — nothing changed.' });
      }

      // Opt-in is implied by a successful upload, but recorded explicitly.
      await readinessService.optIn(db, { userId, provider: PROVIDER }).catch(() => {});

      // Back-fill blank sleep values on the affected dates. Never overwrites a
      // value the member typed themselves — the service guards on IS NULL.
      let filled = 0;
      for (const day of parsed.days) {
        const r = await readinessService.autoPopulateCheckin(db, { userId, date: day.date }).catch(() => null);
        if (r && r.filled) filled += 1;
      }

      res.json({
        ok: true,
        duplicate: false,
        ...result,
        checkinsAutoFilled: filled,
        unknownColumns: parsed.summary.unknownColumns || []
      });
    } catch (e) {
      console.error('[wearables commit]', e.message);
      res.status(500).json({ error: 'Could not save that export. Please try again.' });
    }
  });

  // ---- Readiness (works for Whoop and non-Whoop members alike) -------------

  router.get('/readiness', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const { from, to, date } = req.query;

      if (date) {
        const row = await readinessService.getReadiness(db, { userId, date: String(date) });
        return res.json({ readiness: row || null });
      }
      if (from && to) {
        const rows = await readinessService.getReadinessRange(db, { userId, from: String(from), to: String(to) });
        return res.json({ readiness: rows || [] });
      }
      return res.status(400).json({ error: 'Provide either ?date= or ?from=&to=' });
    } catch (e) {
      console.error('[wearables readiness]', e.message);
      res.status(500).json({ error: 'Could not load readiness.' });
    }
  });

  /**
   * Compute (and persist) today's derived readiness — the non-Whoop path.
   * Returns null rather than a fabricated score when there isn't enough data.
   */
  router.post('/readiness/derive', verifyToken, limit(20, 60000), async (req, res) => {
    try {
      const date = String((req.body || {}).date || '').slice(0, 10) || null;
      const r = await readinessService.computeDerivedReadiness(db, {
        userId: String(req.user.id),
        date: date || undefined
      });
      res.json({ ok: true, derived: r || null });
    } catch (e) {
      console.error('[wearables derive]', e.message);
      res.status(500).json({ error: 'Could not compute readiness.' });
    }
  });

  // ---- AI report -----------------------------------------------------------

  /**
   * POST /api/wearables/report  { from, to }
   * Deterministic stats first; Claude writes prose only; numbers validated back.
   */
  router.post('/report', verifyToken, limit(5, 300000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const b = req.body || {};
      const to = String(b.to || '').slice(0, 10);
      const from = String(b.from || '').slice(0, 10);
      if (!from || !to) return res.status(400).json({ error: 'A from and to date are required.' });

      const rows = await readinessService.getReadinessRange(db, { userId, from, to });
      if (!rows || rows.length < 7) {
        return res.status(400).json({ error: 'At least 7 days of data are needed for a report.' });
      }

      const user = await queryOne('SELECT first_name, last_name FROM users WHERE id = ?', [userId]);
      const memberLabel = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : '';

      // Every number in the report originates here, in plain arithmetic.
      const stats = computeWhoopStats(rows, { memberLabel });

      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) return res.status(503).json({ error: 'Report generation is not configured.' });

      const out = await generateWhoopReport({ stats, member: { name: memberLabel }, apiKey });

      res.json({
        ok: true,
        stats,
        report: out.report,
        // Surfaced deliberately: a report whose numbers failed validation is
        // returned flagged rather than silently presented as verified.
        validation: out.validation,
        usage: out.usage,
        model: out.model
      });
    } catch (e) {
      console.error('[wearables report]', e.message);
      res.status(500).json({ error: 'Could not generate that report right now.' });
    }
  });

  /**
   * POST /api/wearables/report/pdf  { from, to, includeNarrative }
   *
   * Renders the branded PDF. Works with NO Anthropic key configured — the
   * stats-only document is fully valid, since every figure in it is computed
   * deterministically and needs no model. The narrative is additive.
   */
  router.post('/report/pdf', verifyToken, limit(5, 300000), async (req, res) => {
    const os = require('os');
    const fsp = require('fs');
    const pathMod = require('path');
    let tmpPath = null;
    try {
      const userId = String(req.user.id);
      const b = req.body || {};
      const from = String(b.from || '').slice(0, 10);
      const to = String(b.to || '').slice(0, 10);
      if (!from || !to) return res.status(400).json({ error: 'A from and to date are required.' });

      const rows = await readinessService.getReadinessRange(db, { userId, from, to });
      if (!rows || rows.length < 7) {
        return res.status(400).json({ error: 'At least 7 days of data are needed for a report.' });
      }

      const user = await queryOne('SELECT first_name, last_name, email FROM users WHERE id = ?', [userId]);
      const memberName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Member';
      const stats = computeWhoopStats(rows, { memberLabel: memberName });

      // Narrative is best-effort: a model failure must not cost the member their report.
      let report = null;
      let validation = null;
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (apiKey && b.includeNarrative !== false) {
        try {
          const out = await generateWhoopReport({ stats, member: { name: memberName }, apiKey });
          report = out.report;
          validation = out.validation;
        } catch (e) {
          console.warn('[wearables pdf narrative]', e.message);
        }
      }

      tmpPath = pathMod.join(os.tmpdir(), `bb-whoop-${userId.slice(0, 8)}-${Date.now()}.pdf`);
      const built = await buildWhoopReportPdf(
        { member: { name: memberName, email: user && user.email }, stats, report, validation, generatedAt: new Date().toISOString() },
        tmpPath
      );
      if (!built || !built.ok) return res.status(500).json({ error: 'Could not build that report.' });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(built.bytes));
      res.setHeader('Content-Disposition', `attachment; filename="bodybank-readiness-${from}-to-${to}.pdf"`);
      const stream = fsp.createReadStream(tmpPath);
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.on('close', () => { try { fsp.unlinkSync(tmpPath); } catch (_) {} });
      stream.pipe(res);
    } catch (e) {
      console.error('[wearables pdf]', e.message);
      if (tmpPath) { try { require('fs').unlinkSync(tmpPath); } catch (_) {} }
      if (!res.headersSent) res.status(500).json({ error: 'Could not build that report.' });
    }
  });

  // ---- Admin / coach read-only --------------------------------------------

  router.get('/admin/:userId/readiness', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      const { from, to } = req.query;
      const rows = await readinessService.getReadinessRange(db, {
        userId: String(req.params.userId),
        from: String(from || ''),
        to: String(to || '')
      });
      res.json({ readiness: rows || [] });
    } catch (e) {
      console.error('[wearables admin readiness]', e.message);
      res.status(500).json({ error: 'Could not load readiness.' });
    }
  });

  return router;
}

module.exports = { createWearablesRouter };
