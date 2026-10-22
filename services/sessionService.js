'use strict';

/**
 * Login sessions: one row per signed-in device, so members can see where they are
 * logged in, log one device out, log out everywhere, and so a password change
 * actually ends every other login.
 *
 * How a token maps to a session
 *   - tokens issued from now on carry `sid` (the user_sessions row id);
 *   - tokens issued before this shipped have no `sid`. They are adopted on their first
 *     request as a row whose id is derived from the token hash ("legacy-…"), so they
 *     show up in the device list and can be logged out like any other;
 *   - users.sessions_valid_after is a hard cutoff: any token issued (iat) before it is
 *     rejected. "Log out everywhere" and a password change set it, which also ends
 *     legacy tokens that have not been seen since the deploy.
 *
 * verifyToken (middleware/auth.js) calls check() on every authenticated request. Rows
 * and cutoffs are cached for CACHE_MS and invalidated locally on every change, so a
 * revoke is instant on this instance and within CACHE_MS on any other.
 *
 * Revoking a session also deletes the push tokens / web push subscriptions that were
 * registered from it, so a logged-out phone stops getting notifications.
 */

const crypto = require('crypto');

const CACHE_MS = 30 * 1000;
const CACHE_MAX = 10000;
const TOUCH_MS = 5 * 60 * 1000;
const SWEEP_MS = 6 * 60 * 60 * 1000;
const KEEP_REVOKED_DAYS = 30;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    platform TEXT DEFAULT 'web',
    device_label TEXT DEFAULT '',
    device_kind TEXT DEFAULT 'desktop',
    user_agent TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    legacy BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, revoked_at)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ`,
  `ALTER TABLE device_push_tokens ADD COLUMN IF NOT EXISTS session_id TEXT`,
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS session_id TEXT`
];

async function ensureSessionSchema(pool) {
  for (const sql of SCHEMA_SQL) await pool.query(sql);
}

// ── device description (pure) ────────────────────────────────────────────────

const CLIENT_HINTS = new Set(['ios-app', 'android-app', 'web']);

/**
 * → { platform: 'ios-app' | 'android-app' | 'web', kind: 'phone' | 'tablet' | 'desktop', label }
 * clientHint is the X-BB-Client header the web app sends; the user agent is the fallback.
 */
function describeDevice(userAgent, clientHint) {
  const ua = String(userAgent || '');
  const hint = CLIENT_HINTS.has(String(clientHint || '')) ? String(clientHint) : '';
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const isIPhone = /iPhone|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);

  let device;
  let kind = 'desktop';
  if (isIPhone) { device = 'iPhone'; kind = 'phone'; }
  else if (isIPad) { device = 'iPad'; kind = 'tablet'; }
  else if (isAndroid) {
    const m = ua.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/);
    const model = m && m[1] && !/^(K|wv|Linux|U|[a-z]{2}[-_][A-Za-z]{2})$/.test(m[1].trim()) ? m[1].trim() : '';
    kind = /Mobile/.test(ua) ? 'phone' : 'tablet';
    device = model ? model : (kind === 'phone' ? 'Android phone' : 'Android tablet');
  }
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/CrOS/.test(ua)) device = 'Chromebook';
  else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux';
  else device = 'Unknown device';

  // The apps run in a WebView: Android marks it "; wv)", iOS WKWebView has no "Safari/".
  let platform = 'web';
  if (hint === 'ios-app' || hint === 'android-app') platform = hint;
  else if (!hint && isAndroid && /;\s*wv\)/.test(ua)) platform = 'android-app';
  else if (!hint && (isIPhone || isIPad) && !/Safari\//.test(ua) && /AppleWebKit/.test(ua)) platform = 'ios-app';

  if (platform !== 'web') return { platform, kind: kind === 'desktop' ? 'phone' : kind, label: 'BodyBank app on ' + device };

  let browser = 'Browser';
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return { platform, kind, label: browser + ' on ' + device };
}

function clientIp(req) {
  const raw = String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '');
  return raw.replace(/^::ffff:/, '').slice(0, 64);
}

/** 49.37.12.200 → 49.37.x.x ; IPv6 keeps the first two groups. */
function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 2).join('.') + '.x.x';
  if (s.includes(':')) return s.split(':').filter(Boolean).slice(0, 2).join(':') + ':…';
  return '';
}

function legacySid(token) {
  return 'legacy-' + crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 40);
}

// ── service ──────────────────────────────────────────────────────────────────

/**
 * deps: { queryAll, queryOne, run, signToken, now?() }
 */
function createSessionService(deps) {
  const { queryAll, queryOne, run, signToken } = deps;
  const now = deps.now || (() => Date.now());
  const rows = new Map();     // sid → { at, row | null }
  const cutoffs = new Map();  // userId → { at, sec }
  const touched = new Map();  // sid → last touch ms

  function cacheSet(map, key, val) {
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
    map.set(key, val);
  }

  async function cutoffSec(userId) {
    const hit = cutoffs.get(userId);
    if (hit && now() - hit.at < CACHE_MS) return hit.sec;
    const r = await queryOne('SELECT sessions_valid_after FROM users WHERE id = ?', [userId]);
    const sec = r && r.sessions_valid_after ? Math.floor(new Date(r.sessions_valid_after).getTime() / 1000) : 0;
    cacheSet(cutoffs, userId, { at: now(), sec });
    return sec;
  }

  async function rowFor(sid) {
    const hit = rows.get(sid);
    if (hit && now() - hit.at < CACHE_MS) return hit.row;
    const row = await queryOne('SELECT id, user_id, revoked_at FROM user_sessions WHERE id = ?', [sid]);
    cacheSet(rows, sid, { at: now(), row: row || null });
    return row || null;
  }

  function forget(sid) { rows.delete(sid); }

  /** New session for a login. → signed token carrying sid. Never throws: falls back to a plain token. */
  async function issue(req, user) {
    const payload = { id: user.id, email: user.email, role: user.role };
    try {
      const sid = crypto.randomBytes(16).toString('hex');
      const dev = describeDevice(req && req.get ? req.get('user-agent') : '', req && req.get ? req.get('x-bb-client') : '');
      const token = signToken(Object.assign({}, payload, { sid }));
      const exp = decodeExp(token);
      await run(
        `INSERT INTO user_sessions (id, user_id, platform, device_label, device_kind, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sid, user.id, dev.platform, dev.label, dev.kind, String((req && req.get && req.get('user-agent')) || '').slice(0, 400),
          clientIp(req), new Date(now()), new Date(now()), exp ? new Date(exp * 1000) : null]
      );
      cacheSet(rows, sid, { at: now(), row: { id: sid, user_id: user.id, revoked_at: null } });
      touched.set(sid, now());
      return { token, sid };
    } catch (e) {
      console.warn('[sessions] issue failed, plain token:', e.message);
      return { token: signToken(payload), sid: null };
    }
  }

  function decodeExp(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp || null; } catch (_) { return null; }
  }

  /**
   * Called by verifyToken for every token that carries a user id.
   * → { ok: true, sid } or { ok: false }
   */
  async function check(decoded, req, token) {
    const userId = String(decoded.id);
    const cut = await cutoffSec(userId);
    if (cut && Number(decoded.iat || 0) < cut) return { ok: false };
    const sid = decoded.sid ? String(decoded.sid) : legacySid(token);
    let row = await rowFor(sid);
    if (!row) {
      if (decoded.sid) return { ok: false };            // issued with a session that no longer exists
      row = await adopt(sid, decoded, req);              // pre-sessions token: start tracking it
    }
    if (!row || row.revoked_at || String(row.user_id) !== userId) return { ok: false };
    touch(sid, req);
    return { ok: true, sid };
  }

  async function adopt(sid, decoded, req) {
    const dev = describeDevice(req && req.get ? req.get('user-agent') : '', req && req.get ? req.get('x-bb-client') : '');
    await run(
      `INSERT INTO user_sessions (id, user_id, platform, device_label, device_kind, user_agent, ip, legacy, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [sid, String(decoded.id), dev.platform, dev.label, dev.kind, String((req && req.get && req.get('user-agent')) || '').slice(0, 400),
        clientIp(req), decoded.iat ? new Date(decoded.iat * 1000) : new Date(now()), new Date(now()),
        decoded.exp ? new Date(decoded.exp * 1000) : null]
    );
    rows.delete(sid);
    touched.set(sid, now());
    return rowFor(sid);
  }

  function touch(sid, req) {
    const last = touched.get(sid) || 0;
    if (now() - last < TOUCH_MS) return;
    touched.set(sid, now());
    if (touched.size > CACHE_MAX) touched.delete(touched.keys().next().value);
    const dev = describeDevice(req && req.get ? req.get('user-agent') : '', req && req.get ? req.get('x-bb-client') : '');
    run(`UPDATE user_sessions SET last_seen_at = ?, ip = ?, platform = CASE WHEN ? <> 'web' THEN ? ELSE platform END
          WHERE id = ? AND revoked_at IS NULL`,
      [new Date(now()), clientIp(req), dev.platform, dev.platform, sid]).catch(() => {});
  }

  /** Active sessions for the device list, newest activity first. */
  async function list(userId, currentSid) {
    const out = await queryAll(
      `SELECT id, platform, device_label, device_kind, ip, legacy, created_at, last_seen_at
         FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
          AND created_at >= COALESCE((SELECT sessions_valid_after FROM users WHERE id = ?), 'epoch'::timestamptz) - INTERVAL '1 second'
        ORDER BY last_seen_at DESC NULLS LAST
        LIMIT 50`,
      [userId, new Date(now()), userId]
    );
    return out.map((r) => ({
      id: r.id,
      label: r.device_label || 'Unknown device',
      kind: r.device_kind || 'desktop',
      platform: r.platform || 'web',
      ip: maskIp(r.ip),
      signed_in_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      last_active_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
      current: !!currentSid && r.id === currentSid
    }));
  }

  async function dropPushFor(sessionIds) {
    if (!sessionIds.length) return;
    await run('DELETE FROM device_push_tokens WHERE session_id = ANY(?)', [sessionIds]).catch(() => {});
    await run('DELETE FROM push_subscriptions WHERE session_id = ANY(?)', [sessionIds]).catch(() => {});
  }

  /** Log out one device. → true when it was an active session of this user. */
  async function revoke(userId, sid, reason) {
    const r = await queryOne(
      `UPDATE user_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL RETURNING id`,
      [new Date(now()), reason || 'logout', String(sid), String(userId)]
    );
    forget(String(sid));
    if (r) await dropPushFor([r.id]);
    return !!r;
  }

  /** Log out every session of a user except keepSid (null = all). → ids revoked */
  async function revokeAllExcept(userId, keepSid, reason) {
    const out = await queryAll(
      `UPDATE user_sessions SET revoked_at = ?, revoked_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL AND (?::text IS NULL OR id <> ?::text) RETURNING id`,
      [new Date(now()), reason || 'logout_all', String(userId), keepSid || null, keepSid || null]
    );
    const ids = out.map((r) => r.id);
    ids.forEach(forget);
    await dropPushFor(ids);
    return ids;
  }

  /** Every token issued before this second stops working (covers tokens never seen since deploy). */
  async function setCutoff(userId) {
    const at = new Date(Math.floor(now() / 1000) * 1000);
    await run('UPDATE users SET sessions_valid_after = ? WHERE id = ?', [at, String(userId)]);
    cutoffs.delete(String(userId));
    return at;
  }

  /**
   * End every other login and keep this device signed in on a fresh session:
   * cutoff now, revoke all rows, issue a new token here. → { token, sid, revoked }
   */
  async function rotate(req, user, reason) {
    await setCutoff(user.id);
    const revoked = await revokeAllExcept(user.id, null, reason);
    // Push tokens registered from the old current session follow the device.
    const fresh = await issue(req, user);
    if (fresh.sid && req.sessionId) {
      await run('UPDATE device_push_tokens SET session_id = ? WHERE session_id = ?', [fresh.sid, req.sessionId]).catch(() => {});
      await run('UPDATE push_subscriptions SET session_id = ? WHERE session_id = ?', [fresh.sid, req.sessionId]).catch(() => {});
    }
    return { token: fresh.token, sid: fresh.sid, revoked: revoked.filter((id) => id !== req.sessionId).length };
  }

  /** Log out everywhere including this device. */
  async function endAll(userId, reason) {
    await setCutoff(userId);
    return revokeAllExcept(userId, null, reason);
  }

  async function sweep() {
    try {
      await run(
        `DELETE FROM user_sessions
          WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '${KEEP_REVOKED_DAYS} days')
             OR (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '1 day')`
      );
    } catch (e) { console.warn('[sessions] sweep:', e.message); }
  }

  function startSweeper() {
    const t = setInterval(sweep, SWEEP_MS);
    if (t.unref) t.unref();
    setTimeout(sweep, 60 * 1000).unref?.();
    return t;
  }

  return { issue, check, list, revoke, revokeAllExcept, rotate, endAll, setCutoff, sweep, startSweeper, _caches: { rows, cutoffs, touched } };
}

module.exports = {
  SCHEMA_SQL,
  ensureSessionSchema,
  createSessionService,
  describeDevice,
  maskIp,
  legacySid,
  clientIp
};
