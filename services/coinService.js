'use strict';

const { v4: uuidv4 } = require('uuid');
const { todayYmdInTz, STREAK_TZ } = require('./streakService');

const COIN_RULES = {
  DAILY_CHECKIN: 5,
  WORKOUT_SESSION: 10,
  SUNDAY_CHECKIN: 20,
  NUTRITION_DAY_COMPLETE: 10,
  PART2_COMPLETE: 30,
  MISSED_DAILY_CHECKIN_PENALTY: -2
};

const COIN_SETTINGS = {
  PENALTY_GRACE_DAYS: 7
};

function toYmd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return null;
  }
}

function ymdToDate(ymd) {
  return new Date(String(ymd) + 'T00:00:00Z');
}

function addDaysYmd(ymd, days) {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoWeekKey(ymd) {
  const d = ymdToDate(ymd);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function ensureWallet(db, userId) {
  await db.run(
    `INSERT INTO coin_wallet (user_id, balance, lifetime_earned, lifetime_redeemed)
     VALUES (?, 0, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function awardCoins(db, { userId, eventType, eventKey, coinsDelta, meta, createdAtYmd }) {
  if (!userId || !eventType || !eventKey || !Number.isFinite(Number(coinsDelta))) {
    return { applied: false, reason: 'invalid_input' };
  }
  const delta = parseInt(coinsDelta, 10);
  if (!delta) return { applied: false, reason: 'zero_delta' };
  await ensureWallet(db, userId);

  const ins = await db.run(
    `INSERT INTO coin_ledger (id, user_id, event_type, event_key, coins_delta, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?::jsonb, COALESCE(?::timestamptz, CURRENT_TIMESTAMP))
     ON CONFLICT (event_key) DO NOTHING`,
    [
      uuidv4(),
      userId,
      String(eventType).slice(0, 80),
      String(eventKey).slice(0, 180),
      delta,
      JSON.stringify(meta || {}),
      createdAtYmd ? `${String(createdAtYmd).slice(0, 10)}T00:00:00Z` : null
    ]
  );
  if (!ins || !ins.rowCount) return { applied: false, reason: 'duplicate_event' };

  await db.run(
    `UPDATE coin_wallet
     SET balance = GREATEST(0, balance + ?),
         lifetime_earned = lifetime_earned + CASE WHEN ? > 0 THEN ? ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [delta, delta, delta, userId]
  );
  return { applied: true, delta };
}

async function applyMissedDailyPenaltiesForUser(db, userId, todayYmd) {
  const user = await db.queryOne('SELECT id, created_at FROM users WHERE id = ?', [userId]);
  if (!user) return { penaltiesApplied: 0 };

  const state = await db.queryOne('SELECT last_penalty_date FROM coin_penalty_state WHERE user_id = ?', [userId]);
  const createdYmd = toYmd(user.created_at);
  if (!createdYmd) return { penaltiesApplied: 0 };

  const graceEnd = addDaysYmd(createdYmd, COIN_SETTINGS.PENALTY_GRACE_DAYS - 1);
  const yesterday = addDaysYmd(todayYmd, -1);
  if (graceEnd > yesterday) return { penaltiesApplied: 0 };

  let cursor = state && state.last_penalty_date
    ? addDaysYmd(toYmd(state.last_penalty_date), 1)
    : addDaysYmd(graceEnd, 1);
  if (cursor > yesterday) return { penaltiesApplied: 0 };

  let penaltiesApplied = 0;
  while (cursor <= yesterday) {
    const checkin = await db.queryOne(
      'SELECT 1 AS x FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date LIMIT 1',
      [userId, cursor]
    );
    if (!checkin) {
      const r = await awardCoins(db, {
        userId,
        eventType: 'penalty_missed_daily_checkin',
        eventKey: `coins:penalty:daily_checkin_missed:${userId}:${cursor}`,
        coinsDelta: COIN_RULES.MISSED_DAILY_CHECKIN_PENALTY,
        meta: { date: cursor, reason: 'missed_daily_checkin' },
        createdAtYmd: cursor
      });
      if (r.applied) penaltiesApplied += 1;
    }
    cursor = addDaysYmd(cursor, 1);
  }

  await db.run(
    `INSERT INTO coin_penalty_state (user_id, last_penalty_date, updated_at)
     VALUES (?, ?::date, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       last_penalty_date = EXCLUDED.last_penalty_date,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, yesterday]
  );
  return { penaltiesApplied };
}

async function getCoinSummary(db, userId) {
  await ensureWallet(db, userId);
  const w = await db.queryOne(
    `SELECT user_id, balance, lifetime_earned, lifetime_redeemed, updated_at
     FROM coin_wallet WHERE user_id = ?`,
    [userId]
  );
  return {
    userId,
    balance: Number(w && w.balance) || 0,
    lifetimeEarned: Number(w && w.lifetime_earned) || 0,
    lifetimeRedeemed: Number(w && w.lifetime_redeemed) || 0,
    updatedAt: w && w.updated_at ? w.updated_at : null
  };
}

async function listCoinLedger(db, userId, limit) {
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  return db.queryAll(
    `SELECT event_type, event_key, coins_delta, meta_json, created_at
     FROM coin_ledger
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, lim]
  );
}

async function runDailyCoinPenaltyJob({ queryAll, queryOne, run }) {
  const db = { queryAll, queryOne, run };
  const today = todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
  const users = await queryAll(
    `SELECT id FROM users
     WHERE role = 'user'
       AND (approval_status IS NULL OR approval_status = 'approved')
       AND COALESCE(suspended, FALSE) = FALSE`
  );
  let n = 0;
  for (const u of users || []) {
    const r = await applyMissedDailyPenaltiesForUser(db, u.id, today);
    if (r.penaltiesApplied > 0) n += 1;
  }
  console.log(`[coins] Daily penalty job processed ${users.length || 0} users; penalties applied to ${n} user(s).`);
}

module.exports = {
  COIN_RULES,
  STREAK_TZ,
  awardCoins,
  getCoinSummary,
  listCoinLedger,
  applyMissedDailyPenaltiesForUser,
  runDailyCoinPenaltyJob,
  isoWeekKey
};

