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

/**
 * Redacts server-fault (5xx) error bodies.
 *
 * Around 80 handlers answer failures with `res.status(500).json({ error: e.message })`.
 * On Postgres that message can carry SQL text, column and table names, constraint
 * names, or connection details — a free schema map for anyone who can provoke an
 * error. This wraps res.json so any 5xx body's `error`/`message` is replaced with a
 * generic string plus a correlation id, while the real message goes to the log where
 * it belongs.
 *
 * 4xx bodies are untouched: those messages are written for the user and the UI
 * displays them ("Email already in use", "Height must be between 100 and 230 cm").
 *
 * Active in production only, so local debugging keeps full detail.
 */
function redactServerErrors(req, res, next) {
  if (String(process.env.NODE_ENV || '').trim() !== 'production') return next();

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500 && body && typeof body === 'object') {
      const ref = Math.random().toString(36).slice(2, 10);
      const detail = body.error || body.message || '';
      if (detail) {
        console.error(`[5xx ${ref}] ${req.method} ${req.path} — ${String(detail).slice(0, 500)}`);
      }
      const safe = { ...body };
      if ('error' in safe) safe.error = 'Server error. Please try again.';
      if ('message' in safe) safe.message = 'Server error. Please try again.';
      safe.ref = ref;
      return originalJson(safe);
    }
    return originalJson(body);
  };
  next();
}

module.exports = { safeExtraHttpHeaders, optionalApiAccessLog, redactServerErrors };
