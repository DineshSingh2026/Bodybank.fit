'use strict';

/**
 * AI Coach routes. Mounted at /api/coach in server.js:
 *   app.use('/api/coach', createCoachRouter({ verifyToken, requireAdminOrSuperadmin, rateLimiter }));
 * All handlers operate through the coach module's injected DB ctx (see services/coach).
 */

const express = require('express');
const coach = require('../services/coach');

function createCoachRouter(deps) {
  const { verifyToken, requireAdminOrSuperadmin } = deps;
  const rl = deps.rateLimiter ? deps.rateLimiter : () => (req, res, next) => next();
  const router = express.Router();

  const uid = (req) => req.user && req.user.id;

  // ── User-facing ──────────────────────────────────────────────────────────
  router.get('/settings', verifyToken, async (req, res) => {
    try {
      const s = await coach.api.getSettings(uid(req));
      res.json({ ok: true, settings: publicSettings(s) });
    } catch (e) { res.status(500).json({ error: 'Failed to load settings' }); }
  });

  router.put('/settings', verifyToken, rl(30, 60000), async (req, res) => {
    try {
      const s = await coach.api.updateSettings(uid(req), req.body || {});
      res.json({ ok: true, settings: publicSettings(s) });
    } catch (e) { res.status(500).json({ error: 'Failed to save settings' }); }
  });

  router.get('/score', verifyToken, async (req, res) => {
    try { res.json({ ok: true, score: await coach.api.getScore(uid(req)) }); }
    catch (e) { res.status(500).json({ error: 'Failed to load score' }); }
  });

  router.get('/messages', verifyToken, async (req, res) => {
    try {
      await coach.api.markOpened(uid(req)).catch(() => {});
      res.json({ ok: true, messages: await coach.api.listMessages(uid(req), req.query.limit) });
    } catch (e) { res.status(500).json({ error: 'Failed to load messages' }); }
  });

  router.post('/messages/:id/feedback', verifyToken, rl(60, 60000), async (req, res) => {
    try {
      await coach.api.feedback(uid(req), String(req.params.id), (req.body && req.body.reaction) || '');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to save feedback' }); }
  });

  router.post('/pause', verifyToken, rl(20, 60000), async (req, res) => {
    try {
      const days = (req.body && req.body.days != null) ? req.body.days : 3;
      res.json({ ok: true, ...(await coach.api.pause(uid(req), days)) });
    } catch (e) { res.status(500).json({ error: 'Failed to pause coach' }); }
  });

  // Two-way chat: user sends a message → stored → coach replies (bypasses budget).
  router.post('/chat', verifyToken, rl(20, 60000), async (req, res) => {
    try {
      const text = String((req.body && req.body.message) || '').trim();
      if (!text) return res.status(400).json({ error: 'Message required' });
      const out = await coach.handleUserReply(uid(req), text.slice(0, 1000));
      if (!out.ok) return res.status(503).json({ error: 'Coach unavailable' });
      res.json({ ok: true, reply: out.reply, messageId: out.messageId, source: out.source });
    } catch (e) { res.status(500).json({ error: 'Coach chat failed' }); }
  });

  // ── Admin / internal ─────────────────────────────────────────────────────
  router.get('/admin/users/:id', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try { res.json({ ok: true, ...(await coach.api.adminInspect(String(req.params.id))) }); }
    catch (e) { res.status(500).json({ error: 'Failed to inspect user' }); }
  });

  router.get('/admin/metrics', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try { res.json({ ok: true, metrics: await coach.api.adminMetrics() }); }
    catch (e) { res.status(500).json({ error: 'Failed to load metrics' }); }
  });

  router.post('/admin/kill-switch', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const on = !!(req.body && req.body.on);
      res.json({ ok: true, killed: coach.api.killSwitch(on) });
    } catch (e) { res.status(500).json({ error: 'Failed to toggle kill switch' }); }
  });

  // Manual drain trigger (admin) — useful for testing without waiting for the interval.
  router.post('/admin/drain', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try { res.json({ ok: true, ...(await coach.drainOnce(50)) }); }
    catch (e) { res.status(500).json({ error: 'Drain failed' }); }
  });

  // A/B experiments (Phase 7).
  router.get('/admin/experiments', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try { res.json({ ok: true, ...(await coach.api.listExperiments()) }); }
    catch (e) { res.status(500).json({ error: 'Failed to load experiments' }); }
  });

  router.post('/admin/experiments', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const b = req.body || {};
      if (!Array.isArray(b.variants) || b.variants.length < 2) {
        return res.status(400).json({ error: 'Provide at least 2 variants' });
      }
      res.json({ ok: true, ...(await coach.api.createExperiment({
        name: b.name, targetType: b.targetType || 'all', metric: b.metric || 'reply_rate', variants: b.variants
      })) });
    } catch (e) { res.status(500).json({ error: 'Failed to create experiment' }); }
  });

  return router;
}

function publicSettings(s) {
  if (!s) return null;
  return {
    coach_enabled: !!s.coach_enabled,
    personality: s.personality,
    daily_budget: s.daily_budget,
    quiet_start: s.quiet_start,
    quiet_end: s.quiet_end,
    timezone: s.timezone,
    whatsapp_opt_in: !!s.whatsapp_opt_in,
    instant_feedback: s.instant_feedback !== false,
    muted_categories: s.muted_categories || [],
    language: s.language,
    paused_until: s.paused_until || null
  };
}

module.exports = { createCoachRouter };
