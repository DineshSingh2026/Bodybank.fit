'use strict';

/**
 * Referral + coin-redemption routes.
 *
 * Mounted from server.js as:
 *   app.use('/api/referrals', createReferralRouter({ run, queryOne, queryAll, verifyToken,
 *                                                    requireAdminOrSuperadmin, rateLimiter, publicOrigin }))
 *
 * Business rules live in services/referralService.js — this layer only does HTTP
 * concerns (auth, validation, shaping) so the rules stay testable without Express.
 */

const express = require('express');
const referralService = require('../services/referralService');

function createReferralRouter(deps = {}) {
  const {
    run,
    queryOne,
    queryAll,
    verifyToken,
    requireAdminOrSuperadmin,
    rateLimiter,
    publicOrigin
  } = deps;

  const db = { run, queryOne, queryAll };
  const router = express.Router();

  // rateLimiter is optional so the router stays unit-testable without server.js wiring.
  const limit = (max, windowMs) =>
    (typeof rateLimiter === 'function' ? rateLimiter(max, windowMs) : (req, res, next) => next());

  const originFor = (req) => {
    const configured = String(publicOrigin || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}`;
  };

  const shareUrlFor = (req, code) => `${originFor(req)}/signup?ref=${encodeURIComponent(code)}`;

  /**
   * GET /api/referrals/summary
   * The member's own code, share link, stats and per-referral progress.
   */
  router.get('/summary', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const summary = await referralService.getReferralSummaryForUser(db, String(userId));
      if (!summary || !summary.code) {
        return res.status(500).json({ error: 'Could not load your referral details. Please try again.' });
      }

      const wallet = await queryOne('SELECT balance FROM coin_wallet WHERE user_id = ?', [String(userId)]);
      const balance = Number(wallet && wallet.balance) || 0;
      const cfg = referralService.REFERRAL_CONFIG;

      res.json({
        ...summary,
        shareUrl: shareUrlFor(req, summary.code),
        // Everything the UI needs to render the progress bar and the redeem panel
        // without hardcoding any tunable that lives in env.
        config: {
          coinsPerReferral: cfg.REFERRAL_COINS,
          refereeBonusDays: cfg.REFERRAL_REFEREE_BONUS_DAYS,
          qualifyCheckins: cfg.REFERRAL_QUALIFY_CHECKINS,
          qualifyWindowDays: cfg.REFERRAL_QUALIFY_WINDOW_DAYS,
          redeemBlock: cfg.COIN_REDEEM_BLOCK,
          redeemDays: cfg.COIN_REDEEM_DAYS,
          redeemMaxBlocks: cfg.COIN_REDEEM_MAX_BLOCKS
        },
        wallet: {
          balance,
          redeemableBlocks: Math.min(
            Math.floor(balance / cfg.COIN_REDEEM_BLOCK),
            cfg.COIN_REDEEM_MAX_BLOCKS
          )
        }
      });
    } catch (e) {
      console.error('[referrals summary]', e.message);
      res.status(500).json({ error: 'Could not load your referral details. Please try again.' });
    }
  });

  /**
   * GET /api/referrals/resolve/:code   (PUBLIC — powers the /signup?ref=CODE landing page)
   *
   * Deliberately returns only a first name, never an email, id or count, so a
   * scraped code cannot be turned into member data. Rate-limited against enumeration.
   */
  router.get('/resolve/:code', limit(20, 60000), async (req, res) => {
    try {
      const code = String(req.params.code || '').trim();
      if (!code || code.length > 32) return res.status(400).json({ error: 'Invalid code' });

      const resolved = await referralService.resolveCode(db, code);
      if (!resolved) return res.status(404).json({ valid: false });

      const firstName = String(resolved.name || '').trim().split(/\s+/)[0] || 'A friend';
      res.json({
        valid: true,
        referrerName: firstName,
        bonusDays: referralService.REFERRAL_CONFIG.REFERRAL_REFEREE_BONUS_DAYS
      });
    } catch (e) {
      console.error('[referrals resolve]', e.message);
      res.status(500).json({ error: 'Could not check that link right now.' });
    }
  });

  /**
   * POST /api/referrals/redeem  { blocks }
   * Spends coins to extend access_expires_at. Tight rate limit — this moves money-equivalent state.
   */
  router.post('/redeem', verifyToken, limit(6, 60000), async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const blocks = parseInt((req.body || {}).blocks, 10);
      const result = await referralService.redeemCoinsForAccess(db, { userId: String(userId), blocks });

      if (!result || !result.ok) {
        const reason = (result && result.reason) || 'error';
        const messages = {
          invalid_blocks: `You can redeem between 1 and ${referralService.REFERRAL_CONFIG.COIN_REDEEM_MAX_BLOCKS} blocks at a time.`,
          insufficient_balance: 'You don’t have enough coins yet for that.',
          duplicate_event: 'That redemption was already processed.',
          user_not_found: 'Account not found.'
        };
        const status = reason === 'insufficient_balance' || reason === 'invalid_blocks' ? 400 : 500;
        return res.status(status).json({ error: messages[reason] || 'Could not redeem right now. Please try again.', reason });
      }

      // The service intentionally only moves access_expires_at; reactivating the
      // membership label is a server-side concern so both paths stay consistent.
      try {
        await run(
          `UPDATE users
             SET subscription_status = CASE WHEN subscription_status IN ('expired','canceled')
                                            THEN 'active' ELSE subscription_status END,
                 trial_reminder_sent = ''
           WHERE id = ?`,
          [String(userId)]
        );
      } catch (e) { /* non-fatal: access days are already granted */ }

      res.json({
        ok: true,
        blocks: result.blocks,
        coinsSpent: result.coinsSpent,
        daysGranted: result.daysGranted,
        accessExpiresAt: result.accessExpiresAfter,
        balance: result.balance,
        message: `${result.daysGranted} days added to your access.`
      });
    } catch (e) {
      console.error('[referrals redeem]', e.message);
      res.status(500).json({ error: 'Could not redeem right now. Please try again.' });
    }
  });

  /**
   * GET /api/referrals/admin?status=&limit=&offset=
   * Read-only awareness for admins: who referred whom. No approval workflow.
   */
  router.get('/admin', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      const status = String(req.query.status || '').trim() || null;
      const limitN = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const rows = await referralService.listReferralsForAdmin(db, { status, limit: limitN, offset });
      res.json({ referrals: rows || [], limit: limitN, offset });
    } catch (e) {
      console.error('[referrals admin list]', e.message);
      res.status(500).json({ error: 'Could not load referrals.' });
    }
  });

  /**
   * POST /api/referrals/admin/:id/release
   * The single admin action that exists: release a referral auto-held by the
   * duplicate-device/IP guard, then immediately re-run qualification for it.
   */
  router.post('/admin/:id/release', verifyToken, requireAdminOrSuperadmin, limit(30, 60000), async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Referral id required' });

      const row = await queryOne('SELECT id, status, referee_user_id FROM referrals WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: 'Referral not found' });
      if (row.status !== 'held') {
        return res.status(400).json({ error: `Only held referrals can be released (this one is ${row.status}).` });
      }

      await run(
        "UPDATE referrals SET status = 'signed_up', held_reason = NULL WHERE id = ? AND status = 'held'",
        [id]
      );

      // Released referrals may already have met the bar while held.
      const qualification = await referralService.checkQualification(db, String(row.referee_user_id));
      res.json({ ok: true, id, qualification });
    } catch (e) {
      console.error('[referrals admin release]', e.message);
      res.status(500).json({ error: 'Could not release that referral.' });
    }
  });

  return router;
}

module.exports = { createReferralRouter };
