'use strict';

const crypto = require('crypto');

const LINK_SECRET = String(
  process.env.NUTRITION_PHOTO_LINK_SECRET ||
  process.env.JWT_SECRET ||
  'bodybank-nutrition-photo-secret'
);

function signToken(mealId, expiresAt) {
  const base = `${String(mealId)}:${String(expiresAt)}`;
  return crypto.createHmac('sha256', LINK_SECRET).update(base).digest('hex');
}

function verifyToken(mealId, expiresAt, sig) {
  if (!mealId || !expiresAt || !sig) return false;
  const expMs = Number(expiresAt);
  if (!Number.isFinite(expMs)) return false;
  if (Date.now() > expMs) return false;
  const expected = signToken(mealId, expMs);
  try {
    return crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(String(expected)));
  } catch (_) {
    return false;
  }
}

function buildSignedPhotoUrl(baseUrl, mealId, ttlMs) {
  if (!baseUrl || !mealId) return null;
  const cleanBase = String(baseUrl).replace(/\/$/, '');
  const exp = Date.now() + Math.max(60 * 1000, Number(ttlMs) || (24 * 60 * 60 * 1000));
  const sig = signToken(mealId, exp);
  return `${cleanBase}/api/public/nutrition-photo/${encodeURIComponent(String(mealId))}?e=${exp}&sig=${sig}`;
}

module.exports = {
  buildSignedPhotoUrl,
  verifyToken
};
