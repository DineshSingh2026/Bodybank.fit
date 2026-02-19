const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'bodybank-progress-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

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

module.exports = { signToken, verifyToken, requireAdmin, signProgressReportToken, verifyProgressReportToken, JWT_SECRET };
