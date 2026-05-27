const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'bodybank-progress-secret-change-in-production';
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

module.exports = { signToken, verifyToken, requireAdmin, requireSuperadmin, requireAdminOrSuperadmin, signProgressReportToken, verifyProgressReportToken, signShareToken, verifyShareToken, signPdfAccessToken, verifyPdfAccessToken, verifyAppleIdentityToken, JWT_SECRET };
