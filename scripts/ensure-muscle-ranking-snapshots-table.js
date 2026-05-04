/**
 * Ensures the muscle_ranking_snapshots table exists with a per-region scores
 * JSONB column. Idempotent — safe to run repeatedly.
 *
 *   - Creates the table if missing.
 *   - Adds `region_scores JSONB` column if the table pre-existed without it.
 *
 * Existing rows keep NULL for region_scores; the API treats NULL as
 * "no per-region history yet" and the frontend renders an empty sparkline.
 *
 * Usage: node scripts/ensure-muscle-ranking-snapshots-table.js
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS muscle_ranking_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL,
      audit_index INTEGER,
      region_scores JSONB,
      formula_version INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // For pre-existing tables that don't yet have region_scores
    await pool.query(`ALTER TABLE muscle_ranking_snapshots
      ADD COLUMN IF NOT EXISTS region_scores JSONB`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mr_snapshots_user_date
      ON muscle_ranking_snapshots(user_id, snapshot_date DESC)`).catch(() => {});

    console.log('muscle_ranking_snapshots table ready (region_scores JSONB present)');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
main();
