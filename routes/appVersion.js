'use strict';

/**
 * App update alert API (see services/appVersionService.js).
 *
 * Public, mounted at /api/app (no auth, rate limited, cached 5 min):
 *   GET /version                           store versions + links per platform
 *   GET /version?platform=ios&version=1.0.8  ... plus { evaluation: { status } }
 *   APP_UPDATE_ALERT_ENABLED=off → { enabled:false }; =staff → enabled only for
 *   a staff Bearer token (optional; never required).
 *
 * Admin (admin / superadmin), mounted at /api/admin/app-version:
 *   GET  /                    resolved config + the stored rows + env defaults
 *   PUT  /:platform           latest_version, min_supported_version, force, release_notes
 *   POST /:platform/notify    one app push (FCM, that platform's devices only), once per version
 *
 * An empty app_release_config table means the env values are used as they are.
 */

const express = require('express');
const S = require('../services/appVersionService');

const NOTIFY_BATCH = 50;
const DEFAULT_PUSH_BODY = 'A new version of BodyBank is ready. Update to get the latest improvements.';

function createAppVersionCore(deps) {
  const { queryOne, queryAll, env } = deps;
  const envCfg = () => S.configFromEnv(env || process.env);

  async function rows() {
    try {
      const list = await queryAll('SELECT * FROM app_release_config');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      // Table missing (boot DDL failed) → env values only. Never break the public check.
      console.warn('[app-version] read config:', e.message);
      return [];
    }
  }

  async function config() {
    const list = await rows();
    return { cfg: S.resolveConfig(envCfg(), list), rows: list };
  }

  return { envCfg, rows, config, queryOne };
}

/** Bearer token when present; a bad or missing token just means "anonymous". */
function optionalUser(verifyToken) {
  return (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return next();
    let done = false;
    const pass = () => { if (!done) { done = true; next(); } };
    const shim = { status() { return shim; }, json() { delete req.user; pass(); return shim; }, set() { return shim; } };
    try { verifyToken(req, shim, pass); } catch (_) { pass(); }
  };
}

function createAppVersionRouter(deps) {
  const { verifyToken, rateLimiter } = deps;
  const core = createAppVersionCore(deps);
  const router = express.Router();
  const limit = rateLimiter ? rateLimiter(60, 60 * 1000) : (req, res, next) => next();

  router.get('/version', limit, optionalUser(verifyToken), async (req, res) => {
    try {
      const { cfg } = await core.config();
      const staffOnly = cfg.mode === 'staff';
      res.set('Cache-Control', staffOnly ? 'private, no-store' : 'public, max-age=300');
      if (staffOnly) res.set('Vary', 'Authorization');
      if (!S.isEnabledFor(req.user, cfg.mode)) return res.json({ enabled: false });
      const out = S.publicPayload(cfg);
      const platform = String(req.query.platform || '').toLowerCase();
      if (req.query.version != null && S.PLATFORMS.includes(platform)) {
        out.evaluation = S.evaluate(platform, String(req.query.version).slice(0, 40), cfg);
      }
      return res.json(out);
    } catch (e) {
      console.error('[app-version] GET /version:', e && e.message);
      res.set('Cache-Control', 'no-store');
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  return router;
}

function createAppVersionAdminRouter(deps) {
  const { verifyToken, requireAdminOrSuperadmin, rateLimiter, run, queryAll, sendAppPush, pushReady } = deps;
  const core = createAppVersionCore(deps);
  const router = express.Router();
  const limit = rateLimiter ? rateLimiter(30, 60 * 1000) : (req, res, next) => next();
  const who = (req) => (req.user && (req.user.email || req.user.id)) || 'unknown';

  router.use(verifyToken, requireAdminOrSuperadmin);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  function platformParam(req, res) {
    const p = String(req.params.platform || '').toLowerCase();
    if (!S.PLATFORMS.includes(p)) { res.status(400).json({ error: 'Platform must be ios or android' }); return null; }
    return p;
  }

  async function adminView() {
    const { cfg, rows } = await core.config();
    const env = core.envCfg();
    const out = { mode: cfg.mode, platforms: {} };
    for (const p of S.PLATFORMS) {
      const row = rows.find((r) => r.platform === p) || null;
      out.platforms[p] = {
        effective: Object.assign({}, cfg[p], { store_url: S.storeUrl(p, cfg[p]) }),
        env: env[p],
        override: row ? {
          latest_version: row.latest_version, min_supported_version: row.min_supported_version,
          force: row.force, release_notes: row.release_notes,
          updated_by: row.updated_by, updated_at: row.updated_at
        } : null,
        notified_version: row ? row.notified_version || null : null,
        notified_at: row ? row.notified_at || null : null
      };
    }
    return out;
  }

  router.get('/', async (req, res) => {
    try { return res.json(await adminView()); } catch (e) {
      console.error('[app-version] admin GET:', e && e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  router.put('/:platform', limit, async (req, res) => {
    const platform = platformParam(req, res);
    if (!platform) return undefined;
    try {
      const { cfg } = await core.config();
      const v = S.validateUpdate(req.body, cfg[platform]);
      if (v.errors) return res.status(400).json({ error: 'Please fix the highlighted fields', fields: v.errors });
      const x = v.value;
      await run(
        `INSERT INTO app_release_config (platform, latest_version, min_supported_version, force, release_notes, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (platform) DO UPDATE SET latest_version = EXCLUDED.latest_version,
           min_supported_version = EXCLUDED.min_supported_version, force = EXCLUDED.force,
           release_notes = EXCLUDED.release_notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [platform, x.latest_version, x.min_supported_version, x.force, x.release_notes, who(req)]
      );
      const before = cfg[platform];
      console.log(`[app-version] ${platform} updated by ${who(req)}: latest ${before.latest_version} -> ${x.latest_version}, ` +
        `min ${before.min_supported_version} -> ${x.min_supported_version}, force ${before.force} -> ${x.force}`);
      return res.json(await adminView());
    } catch (e) {
      console.error('[app-version] admin PUT:', e && e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // Push "a new version is ready" to every device on the platform, once per latest_version.
  // device_push_tokens does not record the installed app version, so users already on
  // the latest build get it too (tapping it just opens the store page).
  router.post('/:platform/notify', limit, async (req, res) => {
    const platform = platformParam(req, res);
    if (!platform) return undefined;
    if (typeof sendAppPush !== 'function' || (typeof pushReady === 'function' && !pushReady())) {
      return res.status(503).json({ error: 'App push is not configured on this server (FIREBASE_SERVICE_ACCOUNT).' });
    }
    try {
      const { cfg } = await core.config();
      const p = cfg[platform];
      // Claim the version first (atomic), so two admins tapping at once send once.
      // The row may not exist yet when only env values are in use. force stays NULL
      // so this placeholder row never overrides APP_<PLATFORM>_FORCE.
      await run(
        `INSERT INTO app_release_config (platform, force, updated_by, updated_at) VALUES (?, NULL, ?, now())
         ON CONFLICT (platform) DO NOTHING`,
        [platform, who(req)]
      );
      const claimed = await queryAll(
        `UPDATE app_release_config SET notified_version = ?, notified_at = now()
         WHERE platform = ? AND (notified_version IS NULL OR notified_version <> ?)
         RETURNING platform`,
        [p.latest_version, platform, p.latest_version]
      );
      if (!claimed || !claimed.length) {
        return res.status(409).json({ error: 'App users were already notified about ' + p.latest_version, already: true });
      }
      const users = await queryAll(
        'SELECT DISTINCT user_id FROM device_push_tokens WHERE platform = ? AND user_id IS NOT NULL',
        [platform]
      );
      const payload = {
        title: 'BodyBank update',
        body: (p.release_notes || DEFAULT_PUSH_BODY).slice(0, 240),
        type: 'app_update',
        url: S.storeUrl(platform, p),
        id: 'app-update-' + platform + '-' + p.latest_version
      };
      let sent = 0;
      for (let i = 0; i < users.length; i += NOTIFY_BATCH) {
        const batch = users.slice(i, i + NOTIFY_BATCH);
        await Promise.all(batch.map((u) => Promise.resolve(sendAppPush(u.user_id, payload, platform)).then(() => { sent += 1; }, () => {})));
      }
      console.log(`[app-version] ${platform} ${p.latest_version} push sent to ${sent} of ${users.length} users by ${who(req)}`);
      return res.json({ ok: true, platform, version: p.latest_version, users: users.length, sent, note: 'Sent to every device on this platform; app version is not stored per device.' });
    } catch (e) {
      console.error('[app-version] notify:', e && e.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  return router;
}

module.exports = { createAppVersionRouter, createAppVersionAdminRouter, optionalUser };
