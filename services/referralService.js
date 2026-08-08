'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const coinService = require('./coinService');
const { todayYmdInTz, STREAK_TZ } = require('./streakService');

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const REFERRAL_CONFIG = {
  REFERRAL_COINS: envInt('REFERRAL_COINS', 1000),
  REFERRAL_REFEREE_BONUS_DAYS: envInt('REFERRAL_REFEREE_BONUS_DAYS', 7),
  REFERRAL_QUALIFY_CHECKINS: envInt('REFERRAL_QUALIFY_CHECKINS', 5),
  REFERRAL_QUALIFY_WINDOW_DAYS: envInt('REFERRAL_QUALIFY_WINDOW_DAYS', 14),
  REFERRAL_MAX_QUALIFIED_PER_YEAR: envInt('REFERRAL_MAX_QUALIFIED_PER_YEAR', 10),
  COIN_REDEEM_BLOCK: envInt('COIN_REDEEM_BLOCK', 1000),
  COIN_REDEEM_DAYS: envInt('COIN_REDEEM_DAYS', 7),
  COIN_REDEEM_MAX_BLOCKS: envInt('COIN_REDEEM_MAX_BLOCKS', 3)
};

const REFERRAL_STATUSES = ['signed_up', 'qualified', 'credited', 'held', 'voided'];

// Human-speakable alphabet: no 0/O, no 1/I/L.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function todayYmd() {
  return todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
}

function toYmd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return null;
  }
}

function cleanStr(v, max) {
  if (v == null) return '';
  const s = String(v).trim();
  return max ? s.slice(0, max) : s;
}

function normalizeEmail(v) {
  return cleanStr(v).toLowerCase();
}

/** Digits only, last 10 — so +91-98… and 098… compare equal. */
function normalizePhone(v) {
  const digits = cleanStr(v).replace(/\D+/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function randomCodeSuffix(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function codePrefixFrom(user) {
  const candidates = [
    user && user.first_name,
    user && user.last_name,
    user && String(user.email || '').split('@')[0]
  ];
  for (const c of candidates) {
    const letters = cleanStr(c).toUpperCase().replace(/[^A-Z]/g, '');
    if (letters.length >= 3) return letters.slice(0, 8);
  }
  return 'BODY';
}

function displayName(row) {
  if (!row) return '';
  const full = `${cleanStr(row.first_name)} ${cleanStr(row.last_name)}`.trim();
  if (full) return full;
  const email = cleanStr(row.email);
  if (!email) return 'Member';
  return email.split('@')[0];
}

/**
 * Add an ON DELETE CASCADE FK to users(id) if it is not already present.
 * Every failure is ignored: the constraint already exists, the table is brand new
 * (constraint came from CREATE TABLE), or legacy orphan rows block validation.
 */
async function addFkCascade(db, table, constraintName, column) {
  // CREATE TABLE already declares this FK inline (auto-named "<table>_<col>_fkey").
  // Without this check the ALTER below succeeds under a DIFFERENT name and the
  // column ends up with two identical foreign keys, re-validated on every write.
  // This path exists only to retrofit tables created before the FK was added.
  try {
    const existing = await db.queryOne(
      `SELECT 1 AS x
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
        WHERE t.relname = ? AND c.contype = 'f' AND a.attname = ?
        LIMIT 1`,
      [table, column]
    );
    if (existing) return;
  } catch (e) { /* pg_catalog unavailable — fall through and let the ALTER decide */ }

  try {
    await db.run(
      `ALTER TABLE ${table}
       ADD CONSTRAINT ${constraintName}
       FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE CASCADE`
    );
    return;
  } catch (e) { /* already exists, or existing rows fail validation — retry unvalidated below */ }
  try {
    // NOT VALID skips the backfill check but still cascades deletes and enforces new rows.
    await db.run(
      `ALTER TABLE ${table}
       ADD CONSTRAINT ${constraintName}
       FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE CASCADE NOT VALID`
    );
  } catch (e) { /* ignore */ }
}

/**
 * Idempotent schema bootstrap — safe to call on every boot (mirrors server.js initDB style).
 */
async function ensureReferralTables(db) {
  if (!db || typeof db.run !== 'function') return { ok: false, reason: 'invalid_db' };
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS referral_codes (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referee_user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'signed_up',
      signup_ip_hash TEXT,
      signup_device_hash TEXT,
      qualified_at TIMESTAMPTZ,
      credited_at TIMESTAMPTZ,
      coins_awarded INTEGER DEFAULT 0,
      referee_bonus_days INTEGER DEFAULT 0,
      held_reason TEXT,
      voided_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS coin_redemptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coins_spent INTEGER NOT NULL,
      days_granted INTEGER NOT NULL,
      blocks INTEGER NOT NULL,
      access_expires_before TIMESTAMPTZ,
      access_expires_after TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (e) {
    console.warn('[referral ensureTables]', e.message);
    return { ok: false, reason: 'create_failed' };
  }

  // Columns / indexes added after first release — each guarded independently.
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS signup_ip_hash TEXT`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS signup_device_hash TEXT`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS coins_awarded INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referee_bonus_days INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS held_reason TEXT`); } catch (e) { /* ignore */ }
  try { await db.run(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS voided_reason TEXT`); } catch (e) { /* ignore */ }
  // Retrofit FK cascades onto tables created before these constraints existed.
  // Postgres has no ADD CONSTRAINT IF NOT EXISTS — a duplicate_object error just means it is already there.
  await addFkCascade(db, 'referrals', 'fk_referrals_referrer_user', 'referrer_user_id');
  await addFkCascade(db, 'referrals', 'fk_referrals_referee_user', 'referee_user_id');
  await addFkCascade(db, 'coin_redemptions', 'fk_coin_redemptions_user', 'user_id');

  try { await db.run(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id)`); } catch (e) { /* ignore */ }
  try { await db.run(`CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status)`); } catch (e) { /* ignore */ }
  try { await db.run(`CREATE INDEX IF NOT EXISTS idx_referrals_created ON referrals(created_at DESC)`); } catch (e) { /* ignore */ }
  try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code_upper ON referral_codes(UPPER(code))`); } catch (e) { /* ignore */ }
  try { await db.run(`CREATE INDEX IF NOT EXISTS idx_coin_redemptions_user ON coin_redemptions(user_id, created_at DESC)`); } catch (e) { /* ignore */ }
  return { ok: true };
}

/**
 * Stable per-user share code. Same user always gets the same string back.
 */
async function getOrCreateCode(db, userId) {
  const uid = cleanStr(userId);
  if (!uid) return null;
  try {
    const existing = await db.queryOne('SELECT code FROM referral_codes WHERE user_id = ?', [uid]);
    if (existing && existing.code) return existing.code;

    const user = await db.queryOne('SELECT id, first_name, last_name, email FROM users WHERE id = ?', [uid]);
    if (!user) return null;
    const prefix = codePrefixFrom(user);

    for (let attempt = 0; attempt < 12; attempt++) {
      const suffix = randomCodeSuffix(attempt < 8 ? 3 : 5);
      const code = `${prefix}${suffix}`.slice(0, 24);
      // Untargeted DO NOTHING absorbs both the user_id and the code unique violation.
      await db.run(
        `INSERT INTO referral_codes (user_id, code) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [uid, code]
      );
      const row = await db.queryOne('SELECT code FROM referral_codes WHERE user_id = ?', [uid]);
      if (row && row.code) return row.code;
    }
    return null;
  } catch (e) {
    console.warn('[referral getOrCreateCode]', e.message);
    return null;
  }
}

/**
 * @returns {Promise<{userId:string,name:string}|null>} case-insensitive lookup
 */
async function resolveCode(db, code) {
  const c = cleanStr(code, 24);
  if (!c) return null;
  try {
    const row = await db.queryOne(
      `SELECT rc.user_id, u.first_name, u.last_name, u.email
       FROM referral_codes rc
       JOIN users u ON u.id = rc.user_id
       WHERE UPPER(rc.code) = UPPER(?)
       LIMIT 1`,
      [c]
    );
    if (!row) return null;
    return { userId: row.user_id, name: displayName(row) };
  } catch (e) {
    console.warn('[referral resolveCode]', e.message);
    return null;
  }
}

/**
 * Record the referral at sign-up time.
 * NOTE: never touches users.access_expires_at — the caller applies `bonusDays`.
 */
async function attachReferralOnSignup(db, { refereeUserId, code, ipHash, deviceHash } = {}) {
  const refereeId = cleanStr(refereeUserId);
  const rawCode = cleanStr(code, 24);
  const ip = cleanStr(ipHash, 128) || null;
  const device = cleanStr(deviceHash, 128) || null;
  if (!refereeId || !rawCode) return { ok: false, reason: 'invalid_input', referral: null, bonusDays: 0 };

  try {
    const referrer = await resolveCode(db, rawCode);
    if (!referrer) return { ok: false, reason: 'invalid_code', referral: null, bonusDays: 0 };
    if (referrer.userId === refereeId) return { ok: false, reason: 'self_referral', referral: null, bonusDays: 0 };

    const already = await db.queryOne('SELECT id FROM referrals WHERE referee_user_id = ? LIMIT 1', [refereeId]);
    if (already) return { ok: false, reason: 'already_referred', referral: null, bonusDays: 0 };

    const [refereeUser, referrerUser] = await Promise.all([
      db.queryOne('SELECT id, email, phone FROM users WHERE id = ?', [refereeId]),
      db.queryOne('SELECT id, email, phone FROM users WHERE id = ?', [referrer.userId])
    ]);
    if (!refereeUser) return { ok: false, reason: 'referee_not_found', referral: null, bonusDays: 0 };
    if (!referrerUser) return { ok: false, reason: 'invalid_code', referral: null, bonusDays: 0 };

    const sameEmail = !!normalizeEmail(refereeUser.email) &&
      normalizeEmail(refereeUser.email) === normalizeEmail(referrerUser.email);
    const samePhone = normalizePhone(refereeUser.phone).length >= 7 &&
      normalizePhone(refereeUser.phone) === normalizePhone(referrerUser.phone);
    if (sameEmail || samePhone) {
      return { ok: false, reason: 'same_contact', referral: null, bonusDays: 0 };
    }

    let status = 'signed_up';
    let heldReason = null;
    if (ip || device) {
      // Built dynamically so we never bind an untyped NULL into the comparison.
      const ors = [];
      const dupeParams = [refereeId];
      if (device) { ors.push('signup_device_hash = ?'); dupeParams.push(device); }
      if (ip) { ors.push('signup_ip_hash = ?'); dupeParams.push(ip); }
      const dupe = await db.queryOne(
        `SELECT id FROM referrals
         WHERE referee_user_id <> ?
           AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
           AND (${ors.join(' OR ')})
         LIMIT 1`,
        dupeParams
      );
      if (dupe) {
        status = 'held';
        heldReason = 'duplicate_device_or_ip_24h';
      }
    }

    const bonusDays = status === 'held' ? 0 : REFERRAL_CONFIG.REFERRAL_REFEREE_BONUS_DAYS;
    const id = uuidv4();
    const ins = await db.run(
      `INSERT INTO referrals
         (id, referrer_user_id, referee_user_id, code, status, signup_ip_hash, signup_device_hash,
          referee_bonus_days, held_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (referee_user_id) DO NOTHING`,
      [id, referrer.userId, refereeId, rawCode.toUpperCase(), status, ip, device, bonusDays, heldReason]
    );
    if (!ins || !ins.rowCount) return { ok: false, reason: 'already_referred', referral: null, bonusDays: 0 };

    const referral = await db.queryOne('SELECT * FROM referrals WHERE id = ?', [id]);
    return {
      ok: status !== 'held',
      reason: heldReason || 'created',
      referral: referral || null,
      bonusDays
    };
  } catch (e) {
    console.warn('[referral attachOnSignup]', e.message);
    return { ok: false, reason: 'error', referral: null, bonusDays: 0 };
  }
}

/** DISTINCT non-freeze check-in days inside the referral's qualification window. */
async function countQualifyingCheckins(db, refereeUserId, startYmd) {
  const row = await db.queryOne(
    `SELECT COUNT(DISTINCT dc.checkin_date)::int AS n
     FROM daily_checkins dc
     WHERE dc.user_id = ?
       AND COALESCE(dc.is_freeze, FALSE) = FALSE
       AND dc.checkin_date >= ?::date
       AND dc.checkin_date < (?::date + ?::int)`,
    [refereeUserId, startYmd, startYmd, REFERRAL_CONFIG.REFERRAL_QUALIFY_WINDOW_DAYS]
  );
  return Number(row && row.n) || 0;
}

/**
 * Call after every daily check-in for the referee. Idempotent, never throws.
 * signed_up -> qualified -> credited (coins to the referrer, exactly once via event_key).
 */
async function checkQualification(db, refereeUserId) {
  const refereeId = cleanStr(refereeUserId);
  if (!refereeId) return { ok: false, reason: 'invalid_input', changed: false };

  try {
    const referral = await db.queryOne(
      `SELECT r.*, (r.created_at AT TIME ZONE ?::text)::date AS created_ymd
       FROM referrals r WHERE r.referee_user_id = ? LIMIT 1`,
      [STREAK_TZ, refereeId]
    );
    if (!referral) return { ok: true, reason: 'no_referral', changed: false };
    if (referral.status !== 'signed_up') {
      return { ok: true, reason: 'not_pending', changed: false, status: referral.status };
    }

    const startYmd = toYmd(referral.created_ymd);
    if (!startYmd) return { ok: false, reason: 'bad_created_at', changed: false };

    const done = await countQualifyingCheckins(db, refereeId, startYmd);
    const need = REFERRAL_CONFIG.REFERRAL_QUALIFY_CHECKINS;
    if (done < need) {
      return { ok: true, reason: 'not_yet', changed: false, status: 'signed_up', checkinsDone: done, checkinsNeeded: need };
    }

    const capRow = await db.queryOne(
      `SELECT COUNT(*)::int AS n FROM referrals
       WHERE referrer_user_id = ?
         AND status IN ('qualified','credited')
         AND COALESCE(qualified_at, credited_at, created_at) > CURRENT_TIMESTAMP - INTERVAL '1 year'`,
      [referral.referrer_user_id]
    );
    const qualifiedThisYear = Number(capRow && capRow.n) || 0;
    if (qualifiedThisYear >= REFERRAL_CONFIG.REFERRAL_MAX_QUALIFIED_PER_YEAR) {
      await db.run(
        `UPDATE referrals SET status = 'held', held_reason = 'annual_cap'
         WHERE id = ? AND status = 'signed_up'`,
        [referral.id]
      );
      return { ok: true, reason: 'annual_cap', changed: true, status: 'held', checkinsDone: done, checkinsNeeded: need };
    }

    // Losing this race is harmless — the coin event_key below is the real exactly-once guard.
    await db.run(
      `UPDATE referrals SET status = 'qualified', qualified_at = COALESCE(qualified_at, CURRENT_TIMESTAMP)
       WHERE id = ? AND status = 'signed_up'`,
      [referral.id]
    );

    const award = await coinService.awardCoins(db, {
      userId: referral.referrer_user_id,
      eventType: 'referral_qualified',
      eventKey: `coins:referral:${referral.id}`,
      coinsDelta: REFERRAL_CONFIG.REFERRAL_COINS,
      meta: {
        referralId: referral.id,
        refereeUserId: refereeId,
        code: referral.code,
        checkinsDone: done
      },
      createdAtYmd: todayYmd()
    });
    if (!award.applied && award.reason !== 'duplicate_event') {
      return { ok: false, reason: award.reason || 'award_failed', changed: true, status: 'qualified' };
    }

    await db.run(
      `UPDATE referrals
       SET status = 'credited',
           credited_at = COALESCE(credited_at, CURRENT_TIMESTAMP),
           coins_awarded = ?
       WHERE id = ? AND status IN ('signed_up','qualified')`,
      [REFERRAL_CONFIG.REFERRAL_COINS, referral.id]
    );

    return {
      ok: true,
      reason: award.applied ? 'credited' : 'already_credited',
      changed: award.applied,
      status: 'credited',
      referralId: referral.id,
      referrerUserId: referral.referrer_user_id,
      coinsAwarded: award.applied ? REFERRAL_CONFIG.REFERRAL_COINS : 0,
      checkinsDone: done,
      checkinsNeeded: need
    };
  } catch (e) {
    console.warn('[referral checkQualification]', e.message);
    return { ok: false, reason: 'error', changed: false };
  }
}

/**
 * Nightly sweep: retire `signed_up` referrals whose qualification window has closed.
 * Voided is terminal — checkQualification only ever acts on status = 'signed_up',
 * so a voided row can never be credited afterwards.
 * Rows that actually hit the threshold but were never credited are deliberately left
 * alone so a later checkQualification can still pay them out.
 */
async function voidExpiredReferrals(db) {
  if (!db || typeof db.run !== 'function') return { ok: false, reason: 'invalid_db', voided: 0 };
  const windowDays = REFERRAL_CONFIG.REFERRAL_QUALIFY_WINDOW_DAYS;
  const need = REFERRAL_CONFIG.REFERRAL_QUALIFY_CHECKINS;
  try {
    const upd = await db.run(
      `UPDATE referrals r
       SET status = 'voided', voided_reason = 'qualify_window_expired'
       WHERE r.status = 'signed_up'
         AND r.created_at < CURRENT_TIMESTAMP - (?::int * INTERVAL '1 day')
         AND (SELECT COUNT(DISTINCT dc.checkin_date)
                FROM daily_checkins dc
               WHERE dc.user_id = r.referee_user_id
                 AND COALESCE(dc.is_freeze, FALSE) = FALSE
                 AND dc.checkin_date >= (r.created_at AT TIME ZONE ?::text)::date
                 AND dc.checkin_date < ((r.created_at AT TIME ZONE ?::text)::date + ?::int)
             ) < ?::int`,
      [windowDays, STREAK_TZ, STREAK_TZ, windowDays, need]
    );
    return { ok: true, voided: (upd && upd.rowCount) || 0 };
  } catch (e) {
    console.warn('[referral voidExpired]', e.message);
    return { ok: false, reason: 'error', voided: 0 };
  }
}

/**
 * Dashboard payload. `shareUrl` is left null — the caller knows the public origin.
 */
async function getReferralSummaryForUser(db, userId) {
  const uid = cleanStr(userId);
  const empty = {
    code: null,
    shareUrl: null,
    stats: { invited: 0, qualified: 0, credited: 0, coinsEarned: 0 },
    referrals: []
  };
  if (!uid) return empty;

  try {
    const code = await getOrCreateCode(db, uid);
    const rows = await db.queryAll(
      `SELECT r.id, r.status, r.created_at, r.coins_awarded, r.referee_user_id,
              u.first_name, u.last_name, u.email,
              (SELECT COUNT(DISTINCT dc.checkin_date)::int
                 FROM daily_checkins dc
                WHERE dc.user_id = r.referee_user_id
                  AND COALESCE(dc.is_freeze, FALSE) = FALSE
                  AND dc.checkin_date >= (r.created_at AT TIME ZONE ?::text)::date
                  AND dc.checkin_date < ((r.created_at AT TIME ZONE ?::text)::date + ?::int)
              ) AS checkins_done
       FROM referrals r
       LEFT JOIN users u ON u.id = r.referee_user_id
       WHERE r.referrer_user_id = ?
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [STREAK_TZ, STREAK_TZ, REFERRAL_CONFIG.REFERRAL_QUALIFY_WINDOW_DAYS, uid]
    );

    const stats = { invited: 0, qualified: 0, credited: 0, coinsEarned: 0 };
    const referrals = (rows || []).map((r) => {
      stats.invited += 1;
      if (r.status === 'qualified' || r.status === 'credited') stats.qualified += 1;
      if (r.status === 'credited') {
        stats.credited += 1;
        stats.coinsEarned += Number(r.coins_awarded) || 0;
      }
      const doneRaw = Number(r.checkins_done) || 0;
      return {
        name: displayName(r),
        status: r.status,
        checkinsDone: Math.min(doneRaw, REFERRAL_CONFIG.REFERRAL_QUALIFY_CHECKINS),
        checkinsNeeded: REFERRAL_CONFIG.REFERRAL_QUALIFY_CHECKINS,
        createdAt: r.created_at || null
      };
    });

    return { code: code || null, shareUrl: null, stats, referrals };
  } catch (e) {
    console.warn('[referral summary]', e.message);
    return empty;
  }
}

/**
 * Negative ledger entry + wallet debit. Unlike coinService.awardCoins this also
 * increments lifetime_redeemed, and it refuses to drive the balance negative.
 */
async function spendCoins(db, { userId, coins, eventType, eventKey, meta } = {}) {
  const uid = cleanStr(userId);
  const amount = parseInt(coins, 10);
  const type = cleanStr(eventType, 80);
  const key = cleanStr(eventKey, 180);
  if (!uid || !type || !key || !Number.isFinite(amount) || amount <= 0) {
    return { applied: false, reason: 'invalid_input' };
  }

  try {
    await db.run(
      `INSERT INTO coin_wallet (user_id, balance, lifetime_earned, lifetime_redeemed)
       VALUES (?, 0, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [uid]
    );

    const ins = await db.run(
      `INSERT INTO coin_ledger (id, user_id, event_type, event_key, coins_delta, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (event_key) DO NOTHING`,
      [uuidv4(), uid, type, key, -amount, JSON.stringify(meta || {})]
    );
    if (!ins || !ins.rowCount) return { applied: false, reason: 'duplicate_event' };

    // Balance re-checked here so a concurrent spend can never overdraw the wallet.
    const upd = await db.run(
      `UPDATE coin_wallet
       SET balance = balance - ?,
           lifetime_redeemed = lifetime_redeemed + ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND balance >= ?`,
      [amount, amount, uid, amount]
    );
    if (!upd || !upd.rowCount) {
      // Compensate: drop the reservation row so the spend can be retried later.
      try { await db.run('DELETE FROM coin_ledger WHERE event_key = ?', [key]); } catch (e) { /* ignore */ }
      return { applied: false, reason: 'insufficient_balance' };
    }
    return { applied: true, delta: -amount };
  } catch (e) {
    console.warn('[referral spendCoins]', e.message);
    try { await db.run('DELETE FROM coin_ledger WHERE event_key = ?', [key]); } catch (_) { /* ignore */ }
    return { applied: false, reason: 'error' };
  }
}

/**
 * Spend coins for access days. Extends from GREATEST(now, access_expires_at) so
 * unexpired access is never destroyed.
 */
async function redeemCoinsForAccess(db, { userId, blocks } = {}) {
  const uid = cleanStr(userId);
  const n = parseInt(blocks, 10);
  if (!uid) return { ok: false, reason: 'invalid_input' };
  if (!Number.isFinite(n) || n < 1 || n > REFERRAL_CONFIG.COIN_REDEEM_MAX_BLOCKS) {
    return { ok: false, reason: 'invalid_blocks', maxBlocks: REFERRAL_CONFIG.COIN_REDEEM_MAX_BLOCKS };
  }

  const cost = n * REFERRAL_CONFIG.COIN_REDEEM_BLOCK;
  const days = n * REFERRAL_CONFIG.COIN_REDEEM_DAYS;
  const redemptionId = uuidv4();
  const eventKey = `coins:redeem:${uid}:${redemptionId}`;

  try {
    const user = await db.queryOne('SELECT id, access_expires_at FROM users WHERE id = ?', [uid]);
    if (!user) return { ok: false, reason: 'user_not_found' };

    const wallet = await db.queryOne('SELECT balance FROM coin_wallet WHERE user_id = ?', [uid]);
    const balance = Number(wallet && wallet.balance) || 0;
    if (balance < cost) {
      return { ok: false, reason: 'insufficient_balance', balance, required: cost };
    }

    const spend = await spendCoins(db, {
      userId: uid,
      coins: cost,
      eventType: 'redeem_access_days',
      eventKey,
      meta: { redemptionId, blocks: n, daysGranted: days }
    });
    if (!spend.applied) {
      return { ok: false, reason: spend.reason || 'spend_failed', balance, required: cost };
    }

    const before = user.access_expires_at || null;
    const updated = await db.queryOne(
      `UPDATE users
       SET access_expires_at = GREATEST(COALESCE(access_expires_at, NOW()::timestamp), NOW()::timestamp)
                               + (?::int * INTERVAL '1 day')
       WHERE id = ?
       RETURNING access_expires_at`,
      [days, uid]
    );
    if (!updated) {
      // Refund — the user vanished between the balance check and the update.
      await coinService.awardCoins(db, {
        userId: uid,
        eventType: 'redeem_access_days_refund',
        eventKey: `${eventKey}:refund`,
        coinsDelta: cost,
        meta: { redemptionId, reason: 'access_update_failed' }
      });
      return { ok: false, reason: 'access_update_failed' };
    }

    await db.run(
      `INSERT INTO coin_redemptions
         (id, user_id, coins_spent, days_granted, blocks, access_expires_before, access_expires_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [redemptionId, uid, cost, days, n, before, updated.access_expires_at || null]
    );

    const after = await db.queryOne('SELECT balance FROM coin_wallet WHERE user_id = ?', [uid]);
    return {
      ok: true,
      reason: 'redeemed',
      redemptionId,
      blocks: n,
      coinsSpent: cost,
      daysGranted: days,
      accessExpiresBefore: before,
      accessExpiresAfter: updated.access_expires_at || null,
      balance: Number(after && after.balance) || 0
    };
  } catch (e) {
    console.warn('[referral redeem]', e.message);
    return { ok: false, reason: 'error' };
  }
}

/** Read-only admin listing. */
async function listReferralsForAdmin(db, { status, limit, offset } = {}) {
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const wanted = cleanStr(status, 20).toLowerCase();
  const filter = REFERRAL_STATUSES.includes(wanted) ? wanted : null;

  try {
    const params = [];
    let where = '';
    if (filter) {
      where = 'WHERE r.status = ?';
      params.push(filter);
    }
    params.push(lim, off);

    const rows = await db.queryAll(
      `SELECT r.id, r.status, r.code, r.coins_awarded, r.referee_bonus_days,
              r.held_reason, r.voided_reason, r.created_at, r.qualified_at, r.credited_at,
              r.referrer_user_id, r.referee_user_id,
              rf.first_name AS referrer_first_name, rf.last_name AS referrer_last_name, rf.email AS referrer_email,
              re.first_name AS referee_first_name, re.last_name AS referee_last_name, re.email AS referee_email
       FROM referrals r
       LEFT JOIN users rf ON rf.id = r.referrer_user_id
       LEFT JOIN users re ON re.id = r.referee_user_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      params
    );

    return (rows || []).map((r) => ({
      id: r.id,
      status: r.status,
      code: r.code,
      coinsAwarded: Number(r.coins_awarded) || 0,
      refereeBonusDays: Number(r.referee_bonus_days) || 0,
      heldReason: r.held_reason || null,
      voidedReason: r.voided_reason || null,
      createdAt: r.created_at || null,
      qualifiedAt: r.qualified_at || null,
      creditedAt: r.credited_at || null,
      referrer: {
        userId: r.referrer_user_id,
        name: displayName({ first_name: r.referrer_first_name, last_name: r.referrer_last_name, email: r.referrer_email }),
        email: r.referrer_email || ''
      },
      referee: {
        userId: r.referee_user_id,
        name: displayName({ first_name: r.referee_first_name, last_name: r.referee_last_name, email: r.referee_email }),
        email: r.referee_email || ''
      }
    }));
  } catch (e) {
    console.warn('[referral listForAdmin]', e.message);
    return [];
  }
}

module.exports = {
  REFERRAL_CONFIG,
  REFERRAL_STATUSES,
  STREAK_TZ,
  ensureReferralTables,
  getOrCreateCode,
  resolveCode,
  attachReferralOnSignup,
  checkQualification,
  voidExpiredReferrals,
  getReferralSummaryForUser,
  spendCoins,
  redeemCoinsForAccess,
  listReferralsForAdmin
};
