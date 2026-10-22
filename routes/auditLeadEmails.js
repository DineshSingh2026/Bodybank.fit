'use strict';

/**
 * Audit lead email sequence API (services/auditLeadEmailSequence.js).
 *
 * Registered on the app with full paths so tests/security/scan-endpoint-auth.js
 * sees every guard.
 *
 * Admin (admin / superadmin):
 *   POST /api/admin/audit-requests/email-sequence           { ids, dryRun } queue Email 1 (the job sends)
 *   GET  /api/admin/audit-requests/email-sequence?status=   sequences + their last log row
 *   POST /api/admin/audit-requests/email-sequence/:id/stop  { reason: 'replied' | 'manual' }
 *   GET  /api/admin/audit-requests/email-preview?id=&step=  { subject, html, text } for an iframe srcdoc
 *   POST /api/admin/audit-requests/email-test               { to?, step, id? } one email to a staff address
 *
 * Public (rate limited, HMAC token):
 *   GET  /api/email/unsubscribe?t=   small page; it confirms with a POST from the browser so
 *                                    mail scanners that prefetch links do not unsubscribe anyone
 *   POST /api/email/unsubscribe?t=   RFC 8058 one-click (List-Unsubscribe-Post) and the page's POST
 */

const L = require('../services/auditLeadEmails');

const NOT_CONFIGURED = 'Email is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)';

function pageHtml(title, message, opts) {
  const o = opts || {};
  const script = o.token
    ? `<script>
(function(){
  var t = ${JSON.stringify(o.token)};
  var h = document.getElementById('h'), m = document.getElementById('m');
  fetch('/api/email/unsubscribe?t=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    .then(function(r){ if (!r.ok) throw new Error(String(r.status)); h.textContent = 'You are unsubscribed'; m.textContent = 'You will not get any more emails about your BodyBank audit.'; })
    .catch(function(){ h.textContent = 'Something went wrong'; m.textContent = 'Please try the link again in a minute, or reply to the email and we will take you off the list.'; });
})();
</script>`
    : '';
  const noscript = o.token
    ? `<noscript><form method="post" action="/api/email/unsubscribe?t=${encodeURIComponent(o.token)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="margin-top:20px;padding:12px 24px;border:0;border-radius:4px;background:#B8892B;color:#FFFFFF;font:bold 15px Helvetica,Arial,sans-serif;cursor:pointer">Confirm unsubscribe</button></form></noscript>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${L.escapeHtml(title)} | BodyBank</title></head>
<body style="margin:0;padding:0;background:#F4F3F0;font-family:Helvetica,Arial,sans-serif;color:#111111">
<div style="max-width:480px;margin:64px auto;padding:40px 32px;background:#FFFFFF;border:1px solid #E9E6E0;border-radius:4px">
<a href="https://www.bodybank.fit"><img src="/img/email/logo_light.png" width="104" height="40" alt="BodyBank" style="display:block;border:0"></a>
<h1 id="h" style="margin:32px 0 12px;font-size:22px;line-height:30px">${L.escapeHtml(title)}</h1>
<p id="m" style="margin:0;font-size:15px;line-height:24px;color:#444444">${L.escapeHtml(message)}</p>
${noscript}
<p style="margin:32px 0 0;font-size:14px"><a href="https://www.bodybank.fit" style="color:#B8892B;text-decoration:none">www.bodybank.fit</a></p>
</div>
${script}
</body></html>`;
}

function stepOf(v) {
  const n = parseInt(v, 10);
  return L.STEPS.includes(n) ? n : null;
}

/**
 * deps: { verifyToken, requireAdminOrSuperadmin, rateLimiter, queryAll, engine, isConfigured }
 */
function registerAuditLeadEmailRoutes(app, deps) {
  const { verifyToken, requireAdminOrSuperadmin, rateLimiter, queryAll, engine } = deps;
  const isConfigured = deps.isConfigured || (() => true);

  app.post('/api/admin/audit-requests/email-sequence', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const b = req.body || {};
      if (!Array.isArray(b.ids) || !b.ids.length) return res.status(400).json({ error: 'Select at least one lead' });
      if (b.ids.length > engine.MAX_QUEUE_IDS) return res.status(400).json({ error: `Select at most ${engine.MAX_QUEUE_IDS} leads at a time` });
      if (!isConfigured()) return res.status(503).json({ error: NOT_CONFIGURED });
      const out = await engine.queue({ ids: b.ids, dryRun: b.dryRun === true, startedBy: (req.user && (req.user.email || req.user.id)) || '' });
      const c = engine.config();
      out.enabled = c.enabled;
      res.json(out);
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('[auditLeadEmails] queue:', e.message);
      res.status(500).json({ error: 'Could not queue the emails' });
    }
  });

  app.get('/api/admin/audit-requests/email-sequence', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      res.json({ rows: await engine.list({ status: req.query.status }) });
    } catch (e) {
      console.error('[auditLeadEmails] list:', e.message);
      res.status(500).json({ error: 'Could not load email sequences' });
    }
  });

  app.post('/api/admin/audit-requests/email-sequence/:id/stop', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || 'manual');
      if (!['replied', 'manual'].includes(reason)) return res.status(400).json({ error: "reason must be 'replied' or 'manual'" });
      const row = await engine.stop(req.params.id, reason);
      if (!row) return res.status(404).json({ error: 'Sequence not found' });
      res.json({ ok: true, sequence: row });
    } catch (e) {
      console.error('[auditLeadEmails] stop:', e.message);
      res.status(500).json({ error: 'Could not stop the sequence' });
    }
  });

  app.get('/api/admin/audit-requests/email-preview', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const step = stepOf(req.query.step || 1);
      if (!step) return res.status(400).json({ error: 'step must be 1, 2 or 3' });
      const r = await engine.preview(req.query.id, step);
      if (!r) return res.status(404).json({ error: 'Lead not found' });
      res.json({ step, subject: r.subject, html: r.html, text: r.text });
    } catch (e) {
      console.error('[auditLeadEmails] preview:', e.message);
      res.status(500).json({ error: 'Could not render the preview' });
    }
  });

  app.post('/api/admin/audit-requests/email-test', verifyToken, requireAdminOrSuperadmin, rateLimiter(20, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const step = stepOf(b.step || 1);
      if (!step) return res.status(400).json({ error: 'step must be 1, 2 or 3' });
      if (!isConfigured()) return res.status(503).json({ error: NOT_CONFIGURED });
      const to = L.normEmail(b.to || (req.user && req.user.email));
      if (!L.isValidEmail(to)) return res.status(400).json({ error: 'A valid recipient email is required' });
      // Staff inboxes only: the requester, any admin / superadmin / operator, or the CC inbox.
      const staff = await queryAll(
        "SELECT 1 FROM users WHERE LOWER(TRIM(email)) = ? AND role IN ('admin','superadmin','operator') LIMIT 1", [to]);
      const allowed = to === L.normEmail(req.user && req.user.email) || staff.length > 0 || to === L.normEmail(engine.config().cc);
      if (!allowed) return res.status(403).json({ error: 'Test emails can only go to a staff address' });
      // Use a real lead's name and goal when one is given, so the test matches what they will get.
      let lead = null;
      if (b.id) {
        const rows = await queryAll('SELECT first_name, goals FROM audit_requests WHERE id = ?', [String(b.id)]);
        lead = rows[0] || null;
      }
      const r = await engine.sendTest({ to, step, lead: lead || { first_name: 'there', goals: 'fat loss and better energy' } });
      if (!r || !r.ok) return res.status(502).json({ error: 'Send failed: ' + ((r && r.error) || 'unknown error') });
      res.json({ ok: true, to, step, messageId: r.messageId || '' });
    } catch (e) {
      console.error('[auditLeadEmails] test:', e.message);
      res.status(500).json({ error: 'Could not send the test email' });
    }
  });

  // ── public ──────────────────────────────────────────────────────────────
  app.get('/api/email/unsubscribe', rateLimiter(30, 60000), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.query.t || '');
    const email = L.verifyUnsubToken(token, engine.config().unsubSecret);
    res.type('html');
    if (!email) return res.status(400).send(pageHtml('This link is not valid', 'The unsubscribe link looks incomplete. Please use the link from the latest email, or reply to it and we will take you off the list.'));
    res.send(pageHtml('One moment', 'Unsubscribing you from audit emails.', { token }));
  });

  app.post('/api/email/unsubscribe', rateLimiter(30, 60000), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const token = String((req.query && req.query.t) || (req.body && req.body.t) || '');
      const email = L.verifyUnsubToken(token, engine.config().unsubSecret);
      if (!email) return res.status(400).json({ error: 'Invalid unsubscribe link' });
      await engine.unsubscribe(email, 'audit_lead');
      // A plain form POST (no-JS fallback) gets the page; mail providers and fetch get JSON.
      if (req.is('application/x-www-form-urlencoded') && (req.get('accept') || '').includes('text/html')) {
        return res.type('html').send(pageHtml('You are unsubscribed', 'You will not get any more emails about your BodyBank audit.'));
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[auditLeadEmails] unsubscribe:', e.message);
      res.status(500).json({ error: 'Could not unsubscribe' });
    }
  });
}

module.exports = { registerAuditLeadEmailRoutes, NOT_CONFIGURED };
