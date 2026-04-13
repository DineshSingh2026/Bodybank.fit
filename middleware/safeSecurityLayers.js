/**
 * Optional, non-breaking security helpers.
 * All handlers call next(); none block or alter req/res body.
 */

const API_ACCESS_LOG = String(process.env.API_ACCESS_LOG || '').trim().toLowerCase();
const API_ACCESS_LOG_ENABLED = API_ACCESS_LOG === '1' || API_ACCESS_LOG === 'true' || API_ACCESS_LOG === 'yes';

/**
 * Adds HTTP headers that are widely compatible and do not change HTML/JSON payloads.
 */
function safeExtraHttpHeaders(req, res, next) {
  if (!res.getHeader('Referrer-Policy')) {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  if (!res.getHeader('X-DNS-Prefetch-Control')) {
    res.setHeader('X-DNS-Prefetch-Control', 'off');
  }
  next();
}

/**
 * When API_ACCESS_LOG is enabled, logs method, path, and client IP for /api/* only.
 * Does not log bodies, query strings, or headers (avoids tokens and PII).
 * Default: off — zero runtime effect unless explicitly enabled in environment.
 */
function optionalApiAccessLog(req, res, next) {
  if (!API_ACCESS_LOG_ENABLED) return next();
  if (typeof req.path === 'string' && req.path.startsWith('/api/')) {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
    console.log(`[api-access] ${new Date().toISOString()} ${req.method} ${req.path} ip=${ip}`);
  }
  next();
}

module.exports = { safeExtraHttpHeaders, optionalApiAccessLog };
