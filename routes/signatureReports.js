'use strict';

/**
 * Signature reports (the new weekly / monthly templates) — admin API.
 *
 * Mounted at /api/admin/signature-reports (verifyToken + requireAdmin) and the
 * member link /r/sig (public, token-gated, SENT reports only).
 *
 *   GET    /                          ?status=&userId=&type=     -> { reports, counts }   review queue
 *   GET    /clients                   ?q=                         -> client picker (all members, any status)
 *   POST   /draft                     { userId, type, startDate, endDate, ai }  -> report (status draft)
 *   GET    /:id                                                   -> report (narrative, targets, review flags)
 *   GET    /:id/preview                                           -> text/html (fitted A4 pages)
 *   PUT    /:id/edits                 { headline, letter, chapter, ps, targets[] } -> report (back to draft)
 *   POST   /:id/refresh                                           -> report (new data, edits kept)
 *   POST   /:id/approve                                           -> report (PDF stored, status approved)
 *   POST   /:id/send                  { channels: ['email','whatsapp'] } -> results (approved reports only)
 *   GET    /:id/pdf                   ?inline=1                    -> the PDF (approved / sent)
 *   DELETE /:id                                                   -> discard a draft
 *   DELETE /:id/share-link                                        -> revoke the member link
 *   POST   /bulk-draft                { type, startDate, endDate } -> job (drafts only, never sends)
 *   GET    /bulk/:jobId                                           -> job progress
 *   GET    /r/sig/:token                                          -> PDF for the member link
 *
 * Nothing here touches the classic Reports module, its table or its scheduler.
 */

const express = require('express');
const fs = require('fs');
const { createSignatureService } = require('../services/signatureReports/service');

function isId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(v); }

function sendError(res, err, fallback) {
  if (err && /^engine_/.test(String(err.code || ''))) {
    console.error('[signature]', err.code, err.message);
    return res.status(503).json({ success: false, error: 'Report engine not ready', code: err.code, hint: err.hint || '' });
  }
  if (err && /Client not found/.test(err.message || '')) err.status = 404;
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[signature]', (err && err.stack) || err);
  const body = { success: false, error: status >= 500 ? (fallback || 'Report failed') : err.message };
  if (err && err.jobId) body.jobId = err.jobId;
  res.status(status).json(body);
}

function reqBase(req) {
  return (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
}

/** filename= gets an ASCII fallback; filename*= carries the exact UTF-8 name ("BodyBank - Performance Report - Ananya Rao.pdf"). */
function pdfHeaders(res, name, inline) {
  res.set('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/pdf');
  const ascii = String(name).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'BodyBank report.pdf';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
}

function createSignatureReportsRouter(deps) {
  const d = deps || {};
  const router = express.Router();
  const svc = d.service || createSignatureService({
    db: { run: d.run, queryOne: d.queryOne, queryAll: d.queryAll },
    uploadsDir: d.uploadsDir, notify: d.notify, notifyAgent: d.notifyAgent, sendMail: d.sendMail, luxuryWrap: d.luxuryWrap,
    sendWhatsAppWithFallback: d.sendWhatsAppWithFallback, waStore: d.waStore, notifyHub: d.notifyHub
  });
  const limit = (n, ms) => (d.rateLimiter ? d.rateLimiter(n, ms) : (req, res, next) => next());
  const adminId = (req) => (req.user && req.user.id) || null;

  router.use(d.verifyToken, d.requireAdmin);

  // Declared before /:id so 'clients' is never read as a report id.
  router.get('/clients', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, clients: await svc.clients({ q: String(req.query.q || '').slice(0, 120), limit: req.query.limit }) });
    } catch (err) { sendError(res, err, 'Could not search clients'); }
  });

  router.get('/', async (req, res) => {
    try {
      const userId = req.query.userId ? String(req.query.userId) : '';
      if (userId && !isId(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
      res.json(Object.assign({ success: true }, await svc.list({ status: String(req.query.status || ''), userId: userId || null, type: String(req.query.type || ''), limit: req.query.limit })));
    } catch (err) { sendError(res, err, 'Could not load reports'); }
  });

  router.post('/draft', limit(30, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      if (!isId(b.userId)) return res.status(400).json({ success: false, error: 'userId is required' });
      res.json({ success: true, report: await svc.draft({ userId: b.userId, type: b.type, startDate: b.startDate, endDate: b.endDate, createdBy: adminId(req), ai: b.ai !== false }) });
    } catch (err) { sendError(res, err, 'Could not build the draft'); }
  });

  router.post('/bulk-draft', limit(5, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      res.status(202).json(Object.assign({ success: true }, await svc.startBulk({ type: b.type, startDate: b.startDate, endDate: b.endDate, createdBy: adminId(req), ai: b.ai !== false })));
    } catch (err) { sendError(res, err, 'Bulk drafting failed'); }
  });

  router.get('/bulk/:jobId', (req, res) => {
    const job = svc.getJob(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found (jobs are kept until the server restarts)' });
    res.json(Object.assign({ success: true }, job));
  });

  router.get('/:id', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      res.json({ success: true, report: await svc.get(req.params.id) });
    } catch (err) { sendError(res, err, 'Could not load the report'); }
  });

  router.get('/:id/preview', limit(30, 60000), async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      const out = await svc.preview(req.params.id);
      res.set('Cache-Control', 'no-store');
      res.set('X-Report-Pages', String(out.pages || ''));
      res.set('X-Report-Warnings', String((out.warnings || []).length));
      res.type('html').send(out.html);
    } catch (err) { sendError(res, err, 'Preview failed'); }
  });

  router.put('/:id/edits', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      res.json({ success: true, report: await svc.saveEdits(req.params.id, req.body || {}) });
    } catch (err) { sendError(res, err, 'Could not save edits'); }
  });

  router.post('/:id/refresh', limit(20, 60000), async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      res.json({ success: true, report: await svc.refresh(req.params.id) });
    } catch (err) { sendError(res, err, 'Could not refresh the data'); }
  });

  router.post('/:id/approve', limit(30, 60000), async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      res.json({ success: true, report: await svc.approve(req.params.id, adminId(req)) });
    } catch (err) { sendError(res, err, 'Could not approve the report'); }
  });

  router.post('/:id/send', limit(30, 60000), async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      const out = await svc.send(req.params.id, { channels: (req.body || {}).channels, sentBy: adminId(req), reqBase: reqBase(req) });
      res.status(out.ok ? 200 : 502).json(Object.assign({ success: out.ok }, out, out.ok ? {} : { error: 'No channel could be delivered' }));
    } catch (err) { sendError(res, err, 'Send failed'); }
  });

  router.get('/:id/pdf', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      const out = await svc.pdfFor(req.params.id);
      pdfHeaders(res, out.name, String(req.query.inline || '') === '1');
      fs.createReadStream(out.file).pipe(res);
    } catch (err) { sendError(res, err, 'Could not load the PDF'); }
  });

  router.delete('/:id/share-link', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      await svc.revokeShareLink(req.params.id);
      res.json({ success: true });
    } catch (err) { sendError(res, err, 'Could not revoke the link'); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid report id' });
      res.json(Object.assign({ success: true }, await svc.discard(req.params.id)));
    } catch (err) { sendError(res, err, 'Could not discard the report'); }
  });

  router.service = svc;
  return router;
}

/** Public member link. The token is the credential, and only SENT reports resolve. */
function createSignaturePublicRouter(deps) {
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
      console.error('[signature] public link:', err.message);
      res.status(500).type('text/plain').send('Report unavailable right now. Please try again shortly.');
    }
  });
  return router;
}

module.exports = { createSignatureReportsRouter, createSignaturePublicRouter };
