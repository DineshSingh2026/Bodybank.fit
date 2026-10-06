'use strict';

/**
 * BloodMap by BodyBank — public order flow + staff console API.
 *
 * Mounted from server.js as:
 *   app.use('/api/bloodmap', createBloodmapRouter({ service, verifyToken, rateLimiter }))
 *
 * Public routes are unauthenticated by design: the buyer has no BodyBank account.
 * The order's access token in the path is the credential (see services/bloodmap.js).
 * Business rules live in the service.
 */

const express = require('express');
const fs = require('fs');

const STAFF_ROLES = ['admin', 'superadmin', 'operator'];

function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_URL || process.env.APP_BASE_URL || process.env.SITE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return `${req.protocol}://${host}`.replace(/\/$/, '');
}

function createBloodmapRouter(deps = {}) {
  const { service, verifyToken, rateLimiter } = deps;
  const router = express.Router();
  const limit = (max, windowMs) =>
    (typeof rateLimiter === 'function' ? rateLimiter(max, windowMs) : (req, res, next) => next());

  // Health data: nothing here may be cached or indexed.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  });

  const send = (res, out) => {
    if (out && out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  };
  const fail = (res, tag, e, msg) => {
    console.error('[bloodmap ' + tag + ']', e && e.message);
    res.status(500).json({ error: msg || 'Something went wrong. Please try again.' });
  };

  // Loads the order for a token route. A wrong token and a missing order look the same.
  // An expired or revoked link is refused here, before any route can serve from it.
  const withOrder = async (req, res, next) => {
    try {
      const order = await service.orderByToken(req.params.token);
      if (!order) return res.status(404).json({ error: 'This order link is not valid.' });
      if (service.linkExpired(order)) {
        return res.status(410).json({ expired: true, error: 'This private link has expired. Enter your email to get back to your order.' });
      }
      req.order = order;
      next();
    } catch (e) { fail(res, 'order', e); }
  };

  router.get('/config', async (req, res) => {
    try { res.json(await service.publicConfig()); } catch (e) { fail(res, 'config', e); }
  });

  /** POST /email/request { email } — emails the code that proves the address before an order is made. */
  router.post('/email/request', limit(5, 60000), async (req, res) => {
    try { send(res, await service.requestEmailCode(req.body && req.body.email)); } catch (e) { fail(res, 'email code', e); }
  });

  /** POST /order { name, phone, email, email_code, city, age, gender, consent } → { token, checkout } */
  router.post('/order', limit(8, 60000), async (req, res) => {
    try {
      const made = await service.createOrder(req.body || {}, publicOrigin(req), { ip: req.ip, ua: req.get('user-agent') });
      if (made.error) return send(res, made);
      const order = await service.orderByToken(made.token);
      const checkout = await service.startPayment(order);
      if (checkout.error) return res.status(checkout.status || 503).json({ error: checkout.error, token: made.token });
      res.json({ token: made.token, checkout });
    } catch (e) { fail(res, 'create', e, 'Could not start your order. Please try again in a minute.'); }
  });

  router.get('/order/:token', limit(120, 60000), withOrder, async (req, res) => {
    try { res.json(await service.view(req.order)); } catch (e) { fail(res, 'view', e); }
  });

  /** Resume payment for an order whose checkout was closed. */
  router.post('/order/:token/pay', limit(10, 60000), withOrder, async (req, res) => {
    try { send(res, await service.startPayment(req.order)); } catch (e) { fail(res, 'pay', e, 'Could not start the payment. Please try again in a minute.'); }
  });

  router.post('/order/:token/verify', limit(20, 60000), withOrder, async (req, res) => {
    try {
      const r = await service.verifyPayment(req.order, req.body || {});
      if (r.ok) return res.json({ ok: true });
      const messages = {
        bad_signature: 'We could not confirm this payment. If money left your account, message us on WhatsApp with your payment id and we will sort it out.',
        failed: 'The payment did not go through. No money was taken. Please try again.',
        not_captured: 'Your payment is still processing. This page will update on its own once it completes.',
        mismatch: 'Something did not match on this payment. Our team has been alerted and will contact you.',
        unknown_order: 'We could not find this order. Please refresh and try again.',
        closed: 'This order was refunded and is now closed.',
        missing_fields: 'Payment details were incomplete. Please try again.'
      };
      const pending = r.reason === 'not_captured';
      res.status(pending ? 202 : 400).json({ ok: false, pending, error: messages[r.reason] || 'Payment could not be confirmed.' });
    } catch (e) {
      console.error('[bloodmap verify]', e.message);
      res.status(502).json({ ok: false, pending: true, error: 'We are confirming your payment. This page will update on its own once it clears.' });
    }
  });

  // Local development only (no Razorpay keys, not production) — see devPayAllowed().
  router.post('/order/:token/dev-pay', limit(10, 60000), withOrder, async (req, res) => {
    try { send(res, await service.devPay(req.order)); } catch (e) { fail(res, 'dev-pay', e); }
  });

  /** POST /order/:token/upload { files: [{ base64, mime }], reportDate, goal, medicines, conditions } */
  router.post('/order/:token/upload', limit(6, 120000), withOrder, async (req, res) => {
    try { send(res, await service.uploadReport(req.order, req.body || {})); } catch (e) { fail(res, 'upload', e, 'Upload failed. Please try again.'); }
  });

  router.get('/order/:token/slots', limit(60, 60000), withOrder, async (req, res) => {
    try { send(res, await service.slotsFor(req.order, String(req.query.role || ''))); } catch (e) { fail(res, 'slots', e); }
  });

  router.post('/order/:token/book', limit(12, 60000), withOrder, async (req, res) => {
    try {
      const b = req.body || {};
      send(res, await service.book(req.order, String(b.role || ''), b.starts_at));
    } catch (e) { fail(res, 'book', e, 'Could not save that time. Please try again.'); }
  });

  router.get('/order/:token/report.pdf', limit(30, 60000), withOrder, async (req, res) => {
    try {
      const chosen = await service.reportPdf(req.order);
      if (!chosen) return res.status(404).json({ error: 'Your report is not ready yet.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${chosen.filename}"`);
      res.setHeader('Referrer-Policy', 'no-referrer');
      fs.createReadStream(chosen.path).pipe(res);
    } catch (e) { fail(res, 'report', e); }
  });

  router.post('/track/request', limit(5, 60000), async (req, res) => {
    try { send(res, await service.requestCode(req.body && req.body.contact)); } catch (e) { fail(res, 'track', e); }
  });

  router.post('/track/verify', limit(10, 60000), async (req, res) => {
    try { send(res, await service.verifyCode(req.body && req.body.contact, req.body && req.body.code)); } catch (e) { fail(res, 'track', e); }
  });

  // ── staff ───────────────────────────────────────────────────────────────
  const staff = [verifyToken, (req, res, next) => {
    if (!req.user || !STAFF_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  }];
  const who = (req) => 'staff:' + String((req.user && (req.user.email || req.user.id)) || '');

  router.get('/admin/orders', staff, async (req, res) => {
    try {
      res.json({ orders: await service.adminList(), consultants: await service.getConsultants(), config: await service.publicConfig() });
    } catch (e) { fail(res, 'admin list', e); }
  });

  router.get('/admin/orders/:id/events', staff, async (req, res) => {
    try { res.json({ events: await service.adminEvents(req.params.id) }); } catch (e) { fail(res, 'admin events', e); }
  });

  router.post('/admin/orders/:id/release', staff, async (req, res) => {
    try { send(res, await service.adminRelease(req.params.id, who(req))); } catch (e) { fail(res, 'admin release', e); }
  });

  router.post('/admin/orders/:id/request-reupload', staff, async (req, res) => {
    try { send(res, await service.adminRequestReupload(req.params.id, req.body && req.body.note, who(req))); } catch (e) { fail(res, 'admin reupload', e); }
  });

  router.post('/admin/orders/:id/call', staff, async (req, res) => {
    try {
      const b = req.body || {};
      send(res, await service.adminCall(req.params.id, String(b.role || ''), String(b.action || ''), who(req)));
    } catch (e) { fail(res, 'admin call', e); }
  });

  router.put('/admin/orders/:id/notes', staff, async (req, res) => {
    try { send(res, await service.adminNotes(req.params.id, req.body && req.body.notes)); } catch (e) { fail(res, 'admin notes', e); }
  });

  router.post('/admin/orders/:id/resend-link', staff, limit(10, 60000), async (req, res) => {
    try { send(res, await service.adminResendLink(req.params.id, who(req))); } catch (e) { fail(res, 'admin resend', e); }
  });

  router.post('/admin/orders/:id/revoke-link', staff, async (req, res) => {
    try { send(res, await service.adminRevokeLink(req.params.id, who(req))); } catch (e) { fail(res, 'admin revoke', e); }
  });

  router.put('/admin/consultants/:role', staff, async (req, res) => {
    try { send(res, await service.saveConsultant(String(req.params.role || ''), req.body || {})); } catch (e) { fail(res, 'admin consultant', e); }
  });

  return router;
}

module.exports = { createBloodmapRouter };
