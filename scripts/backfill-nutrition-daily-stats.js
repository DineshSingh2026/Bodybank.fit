/**
 * Backfill nutrition_daily_stats so workout kcal reflects current calculation logic.
 *
 * Recomputes per user/day using services/nutritionService.recomputeDailyStats.
 *
 * Usage:
 *   node scripts/backfill-nutrition-daily-stats.js
 *   node scripts/backfill-nutrition-daily-stats.js --from=2026-01-01 --to=2026-04-21
 *   node scripts/backfill-nutrition-daily-stats.js --user=<userId>
 *   node scripts/backfill-nutrition-daily-stats.js --user=<userId> --from=2026-04-01
 */
require('dotenv').config();
const { Pool } = require('pg');
const { recomputeDailyStats } = require('../services/nutritionService');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function argVal(name) {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  return hit ? hit.slice(pfx.length).trim() : '';
}

function isYmd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
}

async function main() {
  const from = argVal('from');
  const to = argVal('to');
  const userId = argVal('user');

  if (from && !isYmd(from)) throw new Error('Invalid --from (expected YYYY-MM-DD)');
  if (to && !isYmd(to)) throw new Error('Invalid --to (expected YYYY-MM-DD)');

  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = {
    queryAll: async (sql, params = []) => {
      const r = await pool.query(toPg(sql), params);
      return r.rows || [];
    },
    queryOne: async (sql, params = []) => {
      const r = await pool.query(toPg(sql), params);
      return (r.rows && r.rows[0]) || null;
    },
    run: async (sql, params = []) => {
      await pool.query(toPg(sql), params);
    }
  };

  try {
    const where = [];
    const params = [];

    if (userId) {
      params.push(userId);
      where.push(`x.user_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      where.push(`x.day >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      where.push(`x.day <= $${params.length}::date`);
    }

    const sql = `
      SELECT x.user_id, x.day::date AS day
      FROM (
        SELECT user_id, log_date AS day FROM nutrition_meal_logs
        UNION
        SELECT user_id, COALESCE(session_date, created_at::date) AS day FROM workout_logs
        UNION
        SELECT user_id, stat_date AS day FROM nutrition_daily_stats
      ) x
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY x.user_id ASC, x.day ASC
    `;

    const rows = await pool.query(sql, params);
    const targets = rows.rows || [];
    console.log(`[backfill] targets: ${targets.length}`);
    if (!targets.length) {
      console.log('[backfill] nothing to recompute');
      return;
    }

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const r = targets[i];
      const uid = String(r.user_id || '');
      const ymd = String(r.day || '').slice(0, 10);
      try {
        await recomputeDailyStats(db, uid, ymd);
        ok += 1;
      } catch (e) {
        fail += 1;
        console.error(`[backfill] failed user=${uid} date=${ymd}: ${e.message}`);
      }
      if ((i + 1) % 100 === 0 || i + 1 === targets.length) {
        console.log(`[backfill] ${i + 1}/${targets.length} processed (ok=${ok}, fail=${fail})`);
      }
    }

    console.log(`[backfill] done (ok=${ok}, fail=${fail})`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[backfill] fatal:', e.message);
  process.exit(1);
});

