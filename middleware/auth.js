const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// JWT signing key.
//
// This file previously fell back to a hardcoded literal when JWT_SECRET was unset.
// Because this repository is published, that literal was a public signing key: anyone
// could forge a token for any user or admin. There is now no committed fallback.
//
//   production            -> JWT_SECRET is mandatory; the process refuses to start
//                            without it rather than sign with a guessable key.
//   development / test    -> a random per-process secret is generated. Tokens stop
//                            working across restarts, which is correct for local work
//                            and keeps a weak constant out of the source tree.
const JWT_SECRET = (() => {
  const configured = String(process.env.JWT_SECRET || '').trim();
  if (configured) {
    if (configured.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters. Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
      );
    }
    return configured;
  }
  if (String(process.env.NODE_ENV || '').trim() === 'production') {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start in production with an ephemeral or ' +
      'default signing key — every session token would be forgeable. Set JWT_SECRET ' +
      'in the service environment. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
  }
  const ephemeral = crypto.randomBytes(48).toString('base64url');
  console.warn(
    '[auth] JWT_SECRET is not set — using a random per-process secret. ' +
    'Tokens will not survive a restart. Set JWT_SECRET for anything but local work.'
  );
  return ephemeral;
})();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

// ============ SIGN IN WITH APPLE ============
// Apple publishes its identity-token signing keys (JWKS) at this URL. We cache them
// and verify the token's RS256 signature, issuer, and audience locally — no Apple
// client secret / .p8 is needed because we consume the identity token directly.
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
let _appleKeysCache = { keys: null, fetchedAt: 0 };

// Allowed audiences = the web Services ID and/or the native app bundle id.
// A web token's `aud` is the Services ID; a native (iOS) token's `aud` is the bundle id.
function appleAllowedAudiences() {
  return [
    process.env.APPLE_SERVICE_ID,        // e.g. com.bodybank.web (Sign in with Apple "Services ID")
    process.env.APPLE_BUNDLE_ID || 'com.bodybank.app' // native iOS app id
  ].filter(Boolean);
}

async function fetchAppleKeys(force) {
  const now = Date.now();
  if (!force && _appleKeysCache.keys && (now - _appleKeysCache.fetchedAt) < 12 * 60 * 60 * 1000) {
    return _appleKeysCache.keys;
  }
  const resp = await fetch(APPLE_KEYS_URL);
  if (!resp.ok) throw new Error('Failed to fetch Apple public keys (' + resp.status + ')');
  const data = await resp.json();
  _appleKeysCache = { keys: data.keys || [], fetchedAt: now };
  return _appleKeysCache.keys;
}

async function applePublicKeyPem(kid) {
  let keys = await fetchAppleKeys(false);
  let jwk = keys.find(k => k.kid === kid);
  if (!jwk) { keys = await fetchAppleKeys(true); jwk = keys.find(k => k.kid === kid); } // refresh once on miss
  if (!jwk) throw new Error('Apple signing key not found for kid ' + kid);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

// Verifies an Apple identity token and returns its payload ({ sub, email, email_verified,
// is_private_email, ... }). Throws if the signature/issuer/audience/expiry are invalid.
async function verifyAppleIdentityToken(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('Malformed Apple identity token');
  }
  const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64').toString());
  const pem = await applePublicKeyPem(header.kid);
  const audiences = appleAllowedAudiences();
  return jwt.verify(idToken, pem, {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    ...(audiences.length ? { audience: audiences } : {})
  });
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body?.token || req.query?.token);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function requireSuperadmin(req, res, next) {
  if (req.user && req.user.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Superadmin access required' });
}

function requireAdminOrSuperadmin(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin')) return next();
  return res.status(403).json({ error: 'Admin or Superadmin access required' });
}

/**
 * Ownership gate for routes addressed by a user id in the path, e.g.
 * /api/profile/:id or /api/workouts/:userId.
 *
 * Admits the owner of the record, and staff. Without this, any such route is a
 * straightforward IDOR: swapping the id in the URL reaches another member's data.
 *
 * @param {string} param  name of the route parameter holding the user id
 * @param {object} opts   { staffRoles } — roles allowed to act on any user.
 *                        Defaults to admin/superadmin/operator. Pass a narrower
 *                        list on mutating routes so operators stay read-only.
 */
function requireSelfOrStaff(param = 'id', opts = {}) {
  const staffRoles = opts.staffRoles || ['admin', 'superadmin', 'operator'];
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const target = String(req.params?.[param] || '');
    if (target && String(req.user.id) === target) return next();
    if (staffRoles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

// Monitoring gate. Admits the Operator role plus admin/superadmin (so admins can QA
// the operator view).
//
// Do not attach this to a mutating route. Operators are read-only *through this
// gate*; the one deliberate exception in the product is blood-report management,
// where routes/blood.js grants operators full parity with admins (download, re-date,
// delete, compare) because the coach running a retest is often the operator. That
// exception is enforced by that router's own STAFF_ROLES list, not by this function —
// so anything guarded here stays read-only.
function requireOperator(req, res, next) {
  if (req.user && (req.user.role === 'operator' || req.user.role === 'admin' || req.user.role === 'superadmin')) return next();
  return res.status(403).json({ error: 'Operator access required' });
}

const REPORT_LINK_EXPIRY = process.env.PROGRESS_REPORT_LINK_EXPIRY || '30d';

function signProgressReportToken(userId) {
  return jwt.sign(
    { userId, purpose: 'progress-report' },
    JWT_SECRET,
    { expiresIn: REPORT_LINK_EXPIRY }
  );
}

function verifyProgressReportToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.purpose === 'progress-report' && decoded.userId) return decoded.userId;
    return null;
  } catch (e) {
    return null;
  }
}

const SHARE_LINK_EXPIRY = process.env.SUPERADMIN_SHARE_LINK_EXPIRY || '24h';

function signShareToken(payload) {
  return jwt.sign(
    { ...payload, purpose: 'superadmin-share' },
    JWT_SECRET,
    { expiresIn: SHARE_LINK_EXPIRY }
  );
}

function verifyShareToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.purpose === 'superadmin-share') return decoded;
    return null;
  } catch (e) {
    return null;
  }
}

function signPdfAccessToken(programId, userId) {
  return jwt.sign(
    { programId, userId, purpose: 'pdf-view' },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
}

function verifyPdfAccessToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.purpose === 'pdf-view' && decoded.programId && decoded.userId) {
      return { programId: decoded.programId, userId: decoded.userId };
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { signToken, verifyToken, requireAdmin, requireSelfOrStaff, requireSuperadmin, requireAdminOrSuperadmin, requireOperator, signProgressReportToken, verifyProgressReportToken, signShareToken, verifyShareToken, signPdfAccessToken, verifyPdfAccessToken, verifyAppleIdentityToken, JWT_SECRET };
