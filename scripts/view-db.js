/**
 * View all data in the BodyBank database (PostgreSQL).
 * Run: node scripts/view-db.js
 * Requires: DATABASE_URL in .env (e.g. postgresql://localhost:5432/bodybank)
 */
require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

const TABLES = [
  'users',
  'audit_requests',
  'tribe_members',
  'workout_logs',
  'contact_messages',
  'meetings',
  'part2_audit',
  'hydration_logs',
  'weight_logs',
  'sunday_checkins'
];

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('PostgreSQL connection failed. Set DATABASE_URL in .env. Error:', e.message);
    process.exit(1);
  }

  console.log('========== BodyBank DB (PostgreSQL) ==========\n');

  for (const table of TABLES) {
    try {
      const res = await pool.query(`SELECT * FROM ${table}`);
      const rows = res.rows;
      if (!rows.length) {
        console.log(`--- ${table} (0 rows) ---\n`);
        continue;
      }
      console.log(`--- ${table} (${rows.length} row(s)) ---`);
      rows.forEach((row, i) => {
        console.log(JSON.stringify(row, null, 2));
      });
      console.log('');
    } catch (e) {
      console.log(`--- ${table} (table missing or error: ${e.message}) ---\n`);
    }
  }

  await pool.end();
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
