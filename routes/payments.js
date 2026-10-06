'use strict';

/**
 * Website payments (Razorpay). Web only — nothing here is linked from the apps.
 *
 * Mounted from server.js as:
 *   app.use('/api/payments', createPaymentsRouter({ service, queryOne, verifyToken, verifyRenewToken,
 *                                                   requireAdminOrSuperadmin, rateLimiter }))
 *
 * The webhook needs the raw body for its signature, so server.js registers
 * express.raw() for /api/payments/webhook before the global express.json().
 *
 * Business rules live in services/payments.js.
 */

const express = require('express');
const payments = require('../services/payments');

function createPaymentsRouter(deps = {}) {
  const { service, queryOne, verifyToken, verifyRenewToken, requireAdminOrSuperadmin, rateLimiter } = deps;
  const router = express.Router();

  // A member session, or the renew-only token an expired member gets at login
  // (middleware/auth.js). The renew token is honoured on the buy routes only.
  const verifyPayer = (req, res, next) => {
    const auth = String(req.headers.authorization || '');
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const renew = tok && typeof verifyRenewToken === 'function' ? verifyRenewToken(tok) : null;
    if (renew) {
      req.user = { id: renew.uid, email: renew.email, role: 'user', renew: true };
      return next();
    }
    return verifyToken(req, res, next);
  };

  const limit = (max, windowMs) =>
    (typeof rateLimiter === 'function' ? rateLimiter(max, windowMs) : (req, res, next) => next());

  const notReady = (res) => res.status(503).json({
    error: 'payments_unavailable',
    message: 'Online payment is not available right now. Message us on WhatsApp and we will set up your plan.'
  });

  /** GET /api/payments/config — whether checkout is on, and the public key id. */
  router.get('/config', (req, res) => {
    const cfg = payments.config();
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: cfg.enabled, key_id: cfg.enabled ? cfg.keyId : null, mode: cfg.enabled ? cfg.mode : null, currency: 'INR' });
  });

  /**
   * POST /api/payments/order  { plan_tier, term }
   * The price comes from the server catalog; the browser only names the plan.
   */
  router.post('/order', verifyPayer, limit(10, 60000), async (req, res) => {
    try {
      if (!payments.config().enabled) return notReady(res);
      const b = req.body || {};
      const user = await queryOne(
        'SELECT id, role, email, first_name, last_name, phone FROM users WHERE id = ?',
        [req.user.id]
      );
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      if (user.role !== 'user') {
        return res.status(403).json({ error: 'staff_account', message: 'Staff accounts cannot buy a plan. Sign in with a member account.' });
      }
      const out = await service.createOrder(user, b.plan_tier, b.term);
      if (out.error) return res.status(400).json({ error: 'unknown_plan', message: 'That plan is not available. Please refresh and try again.' });
      res.json({
        key_id: out.keyId,
        order_id: out.order.id,
        amount: out.order.amount,
        currency: out.order.currency,
        plan: { tier: out.price.tier, name: require('../services/plans').tierName(out.price.tier), term: out.price.term, label: out.price.label, months: out.price.months },
        prefill: { name: out.name, email: user.email || '', contact: user.phone || '' }
      });
    } catch (e) {
      console.error('[payments order]', e.message);
      res.status(502).json({ error: 'order_failed', message: 'Could not start the payment. Please try again in a minute.' });
    }
  });

  /**
   * POST /api/payments/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
   * Called by the checkout success handler.
   */
  router.post('/verify', verifyPayer, limit(20, 60000), async (req, res) => {
    try {
      if (!payments.config().enabled) return notReady(res);
      const b = req.body || {};
      const orderId = String(b.razorpay_order_id || '');
      const paymentId = String(b.razorpay_payment_id || '');
      const signature = String(b.razorpay_signature || '');
      if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'missing_fields' });

      const r = await service.verifyAndFulfil(req.user.id, orderId, paymentId, signature);
      if (r.ok) {
        const p = r.payment || {};
        return res.json({
          ok: true,
          plan_tier: p.plan_tier,
          plan_name: require('../services/plans').tierName(p.plan_tier),
          access_until: p.access_until,
          extended: !!p.extended
        });
      }
      const messages = {
        bad_signature: 'We could not confirm this payment. If money left your account, message us on WhatsApp with your payment id and we will sort it out.',
        failed: 'The payment did not go through. No money was taken. Please try again.',
        not_captured: 'Your payment is still processing. Your plan will unlock automatically once it completes.',
        mismatch: 'Something did not match on this payment. Our team has been alerted and will contact you.',
        no_member: 'Payment received. Our team will finish setting up your plan shortly.',
        unknown_order: 'We could not find this order. Please refresh and try again.'
      };
      const pending = r.reason === 'not_captured' || r.reason === 'no_member';
      res.status(pending ? 202 : 400).json({ ok: false, error: r.reason, pending, message: messages[r.reason] || 'Payment could not be confirmed.' });
    } catch (e) {
      console.error('[payments verify]', e.message);
      res.status(502).json({ ok: false, error: 'verify_failed', pending: true, message: 'We are confirming your payment. Your plan unlocks automatically once it clears; refresh in a minute.' });
    }
  });

  /** GET /api/payments/status/:orderId — for polling after a slow confirmation. */
  router.get('/status/:orderId', verifyPayer, limit(60, 60000), async (req, res) => {
    try {
      const row = await queryOne(
        'SELECT order_id, user_id, status, plan_tier, access_until, applied_at FROM payments WHERE order_id = ?',
        [String(req.params.orderId || '')]
      );
      if (!row || String(row.user_id) !== String(req.user.id)) return res.status(404).json({ error: 'not_found' });
      res.json({ status: row.status, active: !!row.applied_at, plan_tier: row.plan_tier, access_until: row.access_until });
    } catch (e) {
      console.error('[payments status]', e.message);
      res.status(500).json({ error: 'Failed to load payment status' });
    }
  });

  /** GET /api/payments/mine — the member's own payment history. */
  router.get('/mine', verifyToken, limit(30, 60000), async (req, res) => {
    try {
      res.json({ payments: await service.listForUser(req.user.id) });
    } catch (e) {
      console.error('[payments mine]', e.message);
      res.status(500).json({ error: 'Failed to load payments' });
    }
  });

  /** GET /api/payments/admin — every payment, newest first. */
  router.get('/admin', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const rows = await service.listAll(req.query.limit);
      const cfg = payments.config();
      res.json({ payments: rows, enabled: cfg.enabled, mode: cfg.enabled ? cfg.mode : null, webhook: !!cfg.webhookSecret });
    } catch (e) {
      console.error('[payments admin]', e.message);
      res.status(500).json({ error: 'Failed to load payments' });
    }
  });

  /** POST /api/payments/webhook — Razorpay server-to-server events. */
  router.post('/webhook', async (req, res) => {
    const cfg = payments.config();
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    const sig = req.get('X-Razorpay-Signature') || '';
    if (!cfg.webhookSecret || !raw || !payments.verifyWebhookSignature(raw, sig, cfg.webhookSecret)) {
      console.warn('[payments webhook] rejected: ' + (!cfg.webhookSecret ? 'no secret set' : !raw ? 'no raw body' : 'bad signature'));
      return res.status(400).json({ error: 'invalid_signature' });
    }
    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'bad_json' }); }
    try {
      const r = await service.handleWebhookEvent(evt);
      res.json({ ok: true, result: r && (r.reason || r.ignored || (r.already ? 'already' : 'done')) });
    } catch (e) {
      // 5xx makes Razorpay retry, which is what we want for a transient DB error.
      console.error('[payments webhook]', evt && evt.event, e.message);
      res.status(500).json({ error: 'webhook_failed' });
    }
  });

  return router;
}

module.exports = { createPaymentsRouter };
