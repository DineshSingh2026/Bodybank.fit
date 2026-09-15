'use strict';

/**
 * Admin "Reports" module — client progress reports (weekly / monthly PDF).
 *
 * Mounted at /api/admin/reports (admin-only) and /r/report (public, token-gated).
 *
 *   POST /api/admin/reports/preview        { userId, type, startDate, endDate, edits? }  -> text/html
 *                                           ?format=json -> { html, draft, score, grade, period, ... }
 *   POST /api/admin/reports/generate       { userId, type, startDate, endDate, edits }   -> { reportId, url, score, grade }
 *   POST /api/admin/reports/:id/send       { channels: ['email','whatsapp'] }            -> { ok, results, sentChannels }
 *   GET  /api/admin/reports?userId=                                                       -> history
 *   GET  /api/admin/reports/:id/pdf                                                       -> the PDF (download)
 *   POST /api/admin/reports/bulk           { type, period: { start, end } }               -> { jobId, ... }
 *   GET  /api/admin/reports/bulk/:jobId                                                   -> progress
 *   GET  /api/admin/reports/clients?q=                                                    -> client picker rows
 *   PUT  /api/admin/reports/clients/:userId/auto  { enabled }                             -> per-client auto_reports
 *   DELETE /api/admin/reports/:id/share-link                                              -> revoke the client link
 *   GET  /r/report/:token                                                                 -> PDF for the client link
 *
 * A router factory like routes/blood.js: server.js passes in the database
 * helpers, auth middleware and messaging functions. Nothing here changes any
 * other feature's behaviour.
 */

const express = require('express');
const fs = require('fs');
const { createReportService } = require('../services/reportService');

function isId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(v); }

function sendError(res, err, fallback) {
  // Report-engine problems (Chrome downloading / not starting / stuck) carry a
  // code and a plain-language hint. Production redaction only rewrites `error`
  // and `message`, so `code` and `hint` still reach the admin screen.
  if (err && /^engine_/.test(String(err.code || ''))) {
    console.error('[reports]', err.code, err.message);
    return res.status(503).json({ success: false, error: 'Report engine not ready', code: err.code, hint: err.hint || '', stage: err.stage || null });
  }
  const status = err && err.status ? err.status : 500;
  const msg = status >= 500 ? (fallback || 'Report failed') : err.message;
  if (status >= 500) console.error('[reports]', (err && err.stack) || err);
  const body = { success: false, error: msg };
  if (err && err.jobId) body.jobId = err.jobId;
  res.status(status).json(body);
}

function reqBase(req) {
  return (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
}

function pdfHeaders(res, name, inline) {
  res.set('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
}

/**
 * @param {object} deps { run, queryOne, queryAll, verifyToken, requireAdmin, rateLimiter, uploadsDir,
 *                        notify, notifyAgent, sendMail, luxuryWrap, sendWhatsAppWithFallback, waStore, service }
 */
function createReportsRouter(deps) {
  const d = deps || {};
  const router = express.Router();
  const svc = d.service || createReportService({
    db: { run: d.run, queryOne: d.queryOne, queryAll: d.queryAll },
    uploadsDir: d.uploadsDir, notify: d.notify, notifyAgent: d.notifyAgent,
    sendMail: d.sendMail, luxuryWrap: d.luxuryWrap, sendWhatsAppWithFallback: d.sendWhatsAppWithFallback,
    waStore: d.waStore
  });
  const limit = (n, ms) => (d.rateLimiter ? d.rateLimiter(n, ms) : (req, res, next) => next());

  router.use(d.verifyToken, d.requireAdmin);

  router.get('/clients', async (req, res) => {
    try {
      res.json({ success: true, clients: await svc.clients({ q: req.query.q, limit: req.query.limit }) });
    } catch (err) { sendError(res, err, 'Could not load clients'); }
  });

  // Report engine health: Chrome state, memory, last render; ?test=1 prints a one-page PDF live.
  router.get('/diagnostics', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(Object.assign({ success: true }, await svc.diagnostics({ test: String(req.query.test || '') === '1' })));
    } catch (err) { sendError(res, err, 'Diagnostics failed'); }
  });

  router.put('/clients/:userId/auto', async (req, res) => {
    try {
      if (!isId(req.params.userId)) return res.status(400).json({ success: false, error: 'Invalid client id' });
      const out = await svc.setAutoReports(req.params.userId, !!(req.body && req.body.enabled));
      if (!out) return res.status(404).json({ success: false, error: 'Client not found' });
      res.json({ success: true, ...out });
    } catch (err) { sendError(res, err, 'Could not update auto reports'); }
  });

  router.post('/preview', limit(20, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      if (!isId(b.userId)) return res.status(400).json({ success: false, error: 'userId is required' });
      const out = await svc.preview({ userId: b.userId, type: b.type, startDate: b.startDate, endDate: b.endDate, edits: b.edits, ai: b.ai });
      if (String(req.query.format || '').toLowerCase() === 'json') return res.json({ success: true, ...out });
      res.set('Cache-Control', 'no-store');
      res.type('html').send(out.html);
    } catch (err) {
      if (err && /Client not found/.test(err.message)) err.status = 404;
      sendError(res, err, 'Preview failed');
    }
  });

  router.post('/generate', limit(20, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      if (!isId(b.userId)) return res.status(400).json({ success: false, error: 'userId is required' });
      const out = await svc.generate({
        userId: b.userId, type: b.type, startDate: b.startDate, endDate: b.endDate,
        edits: b.edits || {}, generatedBy: req.user && req.user.id, source: 'manual', ai: b.ai
      });
      res.json({ success: true, ...out });
    } catch (err) {
      if (err && /Client not found/.test(err.message)) err.status = 404;
      sendError(res, err, 'Report generation failed');
    }
  });

  router.post('/bulk', limit(5, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const out = await svc.startBulk({
        type: b.type, period: b.period, startDate: b.startDate, endDate: b.endDate,
        generatedBy: req.user && req.user.id, onlyAuto: !!b.onlyAuto,
        sendAfter: !!b.send, channels: b.channels, source: 'bulk'
      });
      res.status(202).json({ success: true, ...out });
    } catch (err) { sendError(res, err, 'Bulk generation failed'); }
  });

  router.get('/bulk/:jobId', (req, res) => {
    const job = svc.getJob(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found (bulk jobs are kept until the server restarts)' });
    res.json({ success: true, ...job });
  });

  router.get('/', async (req, res) => {
    try {
      const userId = req.query.userId ? String(req.query.userId) : '';
      if (userId && !isId(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
      res.json({ success: true, reports: await svc.list({ userId: userId || null, limit: req.query.limit }) });
    } catch (err) { sendError(res, err, 'Could not load reports'); }
  });

  router.get('/:id/pdf', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      const out = await svc.pdfFor(req.params.id);
      if (!out) return res.status(404).json({ success: false, error: 'Report not found' });
      pdfHeaders(res, out.name, String(req.query.inline || '') === '1');
      fs.createReadStream(out.file).pipe(res);
    } catch (err) { sendError(res, err, 'Could not load the PDF'); }
  });

  router.post('/:id/send', limit(30, 60000), async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      const b = req.body || {};
      const out = await svc.send(req.params.id, { channels: b.channels, sentBy: req.user && req.user.id, reqBase: reqBase(req) });
      res.status(out.ok ? 200 : 502).json(Object.assign({ success: out.ok }, out, out.ok ? {} : { error: 'No channel could be delivered' }));
    } catch (err) { sendError(res, err, 'Send failed'); }
  });

  router.delete('/:id/share-link', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      await svc.revokeShareLink(req.params.id);
      res.json({ success: true });
    } catch (err) { sendError(res, err, 'Could not revoke the link'); }
  });

  router.service = svc;
  return router;
}

/** Public: the client's link. The token in the path is the credential. */
function createReportsPublicRouter(deps) {
  const d = deps || {};
  const router = express.Router();
  const svc = d.service;
  const limit = d.rateLimiter ? d.rateLimiter(60, 60000) : (req, res, next) => next();
  router.get('/:token', limit, async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    try {
      const out = await svc.byShareToken(req.params.token);
      if (!out) {
        res.set('Cache-Control', 'no-store');
        return res.status(404).type('text/plain').send('This report link has expired or is no longer available.');
      }
      pdfHeaders(res, out.name, true);
      fs.createReadStream(out.file).pipe(res);
    } catch (err) {
      console.error('[reports] public link:', err.message);
      res.status(500).type('text/plain').send('Report unavailable right now. Please try again shortly.');
    }
  });
  return router;
}

module.exports = { createReportsRouter, createReportsPublicRouter };
