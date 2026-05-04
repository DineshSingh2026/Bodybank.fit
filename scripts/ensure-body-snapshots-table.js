/**
 * Ensures the body_snapshots table exists for the My Body section
 * (Phase 1 — photos + bodyweight + waist + slider compare).
 *
 * Idempotent — safe to run repeatedly.
 *
 *   - Creates the table if missing.
 *   - Adds forward-compatible columns via ADD COLUMN IF NOT EXISTS so
 *     pre-existing deployments upgrade safely:
 *       measurements         JSONB   (Phase 2: chest_cm, arms_cm, hips_cm, thighs_cm)
 *       shared_with_manager  BOOLEAN (Phase 4: admin/manager visibility)
 *       notes                TEXT
 *
 * Note on user_id type: this codebase uses TEXT (UUID) for users.id, so
 * body_snapshots.user_id is TEXT to match.
 *
 * Usage: node scripts/ensure-body-snapshots-table.js
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS body_snapshots (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date TEXT NOT NULL,
      photo_front TEXT,
      photo_side TEXT,
      photo_back TEXT,
      bodyweight_kg REAL,
      waist_cm REAL,
      measurements JSONB,
      shared_with_manager BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Forward-compat / safe-upgrade columns
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS photo_front TEXT`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS photo_side TEXT`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS photo_back TEXT`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS bodyweight_kg REAL`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS waist_cm REAL`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS measurements JSONB`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS shared_with_manager BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS notes TEXT`);
    await pool.query(`ALTER TABLE body_snapshots
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_body_snapshots_user_date
      ON body_snapshots(user_id, snapshot_date DESC)`).catch(() => {});

    console.log('body_snapshots table ready (My Body Phase 1)');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
main();
