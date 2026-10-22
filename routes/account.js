'use strict';

/**
 * Account security: change password, devices (login sessions), log out.
 * Registered on the app with full paths so tests/security/scan-endpoint-auth.js sees
 * the guards. Sessions live in services/sessionService.js.
 *
 *   POST   /api/me/password                 { current_password, new_password } → { ok, token, logged_out }
 *   GET    /api/me/sessions                 → { sessions: [{ id, label, kind, platform, ip, signed_in_at, last_active_at, current }] }
 *   DELETE /api/me/sessions/:id             log one device out → { ok, current }
 *   POST   /api/me/sessions/logout-others   → { ok, token, logged_out }   (this device stays in)
 *   POST   /api/me/sessions/logout-all      → { ok }                       (this device too)
 *   POST   /api/auth/logout                 ends the calling session
 *
 * A password change or "log out other devices" ends every other login, including
 * tokens issued before sessions existed, and hands this device a fresh token.
 */

const MIN_PASSWORD = 6;
const MAX_PASSWORD = 200;

function registerAccountRoutes(app, deps) {
  const { verifyToken, rateLimiter, queryOne, sessions, bcrypt, onPasswordChanged } = deps;

  async function userRow(id) {
    return queryOne('SELECT id, email, role, first_name, password FROM users WHERE id = ?', [String(id)]);
  }

  app.post('/api/me/password', verifyToken, rateLimiter(5, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const current = typeof b.current_password === 'string' ? b.current_password.trim() : '';
      const next = typeof b.new_password === 'string' ? b.new_password.trim() : '';
      if (!current) return res.status(400).json({ error: 'Enter your current password.', field: 'current_password' });
      if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `Your new password needs at least ${MIN_PASSWORD} characters.`, field: 'new_password' });
      if (next.length > MAX_PASSWORD) return res.status(400).json({ error: 'That password is too long.', field: 'new_password' });
      const user = await userRow(req.user.id);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      // 400, not 401: a wrong current password must never read as an expired session.
      if (!user.password || !(await bcrypt.compare(current, user.password))) {
        return res.status(400).json({ error: 'Your current password is not correct.', field: 'current_password' });
      }
      if (await bcrypt.compare(next, user.password)) {
        return res.status(400).json({ error: 'Choose a password you have not used for this account.', field: 'new_password' });
      }
      const hash = await bcrypt.hash(next, 10);
      await queryOne('UPDATE users SET password = ? WHERE id = ? RETURNING id', [hash, user.id]);
      const rot = await sessions.rotate(req, user, 'password_changed');
      try { if (onPasswordChanged) onPasswordChanged(user); } catch (_) { /* email is best effort */ }
      res.json({ ok: true, token: rot.token, logged_out: rot.revoked });
    } catch (e) {
      console.error('[account] password:', e.message);
      res.status(500).json({ error: 'Could not change your password. Please try again.' });
    }
  });

  app.get('/api/me/sessions', verifyToken, rateLimiter(30, 60000), async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ sessions: await sessions.list(req.user.id, req.sessionId || null) });
    } catch (e) {
      console.error('[account] sessions:', e.message);
      res.status(500).json({ error: 'Could not load your devices.' });
    }
  });

  app.delete('/api/me/sessions/:id', verifyToken, rateLimiter(20, 60000), async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const ok = await sessions.revoke(req.user.id, id, 'removed_by_user');
      if (!ok) return res.status(404).json({ error: 'That device is already logged out.' });
      res.json({ ok: true, current: !!req.sessionId && id === req.sessionId });
    } catch (e) {
      console.error('[account] revoke:', e.message);
      res.status(500).json({ error: 'Could not log that device out.' });
    }
  });

  app.post('/api/me/sessions/logout-others', verifyToken, rateLimiter(5, 60000), async (req, res) => {
    try {
      const user = await userRow(req.user.id);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      const rot = await sessions.rotate(req, user, 'logout_others');
      res.json({ ok: true, token: rot.token, logged_out: rot.revoked });
    } catch (e) {
      console.error('[account] logout-others:', e.message);
      res.status(500).json({ error: 'Could not log the other devices out.' });
    }
  });

  app.post('/api/me/sessions/logout-all', verifyToken, rateLimiter(5, 60000), async (req, res) => {
    try {
      await sessions.endAll(req.user.id, 'logout_all');
      res.json({ ok: true });
    } catch (e) {
      console.error('[account] logout-all:', e.message);
      res.status(500).json({ error: 'Could not log out of all devices.' });
    }
  });

  app.post('/api/auth/logout', verifyToken, rateLimiter(30, 60000), async (req, res) => {
    try {
      if (req.sessionId) await sessions.revoke(req.user.id, req.sessionId, 'logout');
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: true });
    }
  });
}

module.exports = { registerAccountRoutes, MIN_PASSWORD };
