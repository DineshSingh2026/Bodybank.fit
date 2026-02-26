#!/usr/bin/env node
/**
 * One-time migration: copy data from SQLite (data/bodybank.db) to PostgreSQL.
 * Requires: DATABASE_URL in .env (e.g. postgresql://user:pass@localhost:5432/bodybank)
 *           SQLite file at DB_PATH or data/bodybank.db
 * Run: node scripts/migrate-sqlite-to-postgres.js
 * Then start the server with PostgreSQL (it will use DATABASE_URL).
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bodybank.db');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

const TABLE_LIST = [
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

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('SQLite file not found at:', DB_PATH);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  const sqliteDb = new SQL.Database(buffer);

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('PostgreSQL connection failed. Set DATABASE_URL in .env. Error:', e.message);
    process.exit(1);
  }

  console.log('Creating tables in PostgreSQL if not exist...');
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', phone TEXT DEFAULT '', profile_picture TEXT DEFAULT '', role TEXT DEFAULT 'user', approval_status TEXT DEFAULT 'approved', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS audit_requests (id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT DEFAULT '', age INTEGER, sex TEXT DEFAULT '', email TEXT NOT NULL, phone TEXT DEFAULT '', country TEXT DEFAULT '', city TEXT DEFAULT '', occupation TEXT DEFAULT '', work_intensity TEXT DEFAULT '', fitness_experience TEXT DEFAULT '', goals TEXT DEFAULT '', motivation TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS tribe_members (id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '', city TEXT DEFAULT '', phase INTEGER DEFAULT 1, start_date TEXT, activity_per_week INTEGER DEFAULT 0, starting_weight REAL, current_weight REAL, target_weight REAL, next_checkin TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS workout_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workout_name TEXT NOT NULL, duration_seconds INTEGER DEFAULT 0, feedback TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS contact_messages (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, phone TEXT DEFAULT '', email TEXT DEFAULT '', message TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT DEFAULT '', user_email TEXT DEFAULT '', user_phone TEXT DEFAULT '', meeting_date TEXT NOT NULL, time_slot TEXT NOT NULL, status TEXT DEFAULT 'scheduled', notes TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS part2_audit (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, mobile TEXT DEFAULT '', sports_history TEXT DEFAULT '', injuries TEXT DEFAULT '', mental_health TEXT DEFAULT '', gym_experience TEXT DEFAULT '', food_choices TEXT DEFAULT '', vices_addictions TEXT DEFAULT '', goals TEXT DEFAULT '', what_compelled TEXT DEFAULT '', activity_level TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS hydration_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_ml INTEGER DEFAULT 0, glasses INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS weight_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, weight_kg REAL NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS sunday_checkins (id TEXT PRIMARY KEY, user_id TEXT, full_name TEXT NOT NULL, reply_email TEXT NOT NULL, plan TEXT DEFAULT '', current_weight_waist_week TEXT DEFAULT '', last_week_weight_waist TEXT DEFAULT '', total_weight_loss TEXT DEFAULT '', training_go TEXT DEFAULT '', nutrition_go TEXT DEFAULT '', sleep TEXT DEFAULT '', occupation_stress TEXT DEFAULT '', other_stress TEXT DEFAULT '', differences_felt TEXT DEFAULT '', achievements TEXT DEFAULT '', improve_next_week TEXT DEFAULT '', questions TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
  ];
  for (const sql of ddl) await pool.query(sql).catch(() => {});
  console.log('Tables ready.\n');

  console.log('SQLite source:', DB_PATH);
  console.log('PostgreSQL target: connected');
  console.log('');

  for (const table of TABLE_LIST) {
    let result;
    try {
      result = sqliteDb.exec(`SELECT * FROM ${table}`);
    } catch (e) {
      console.log(`  [${table}] skip (missing or error: ${e.message})`);
      continue;
    }

    if (!result.length || !result[0].values.length) {
      console.log(`  [${table}] 0 rows`);
      continue;
    }

    const { columns, values } = result[0];
    const cols = columns.join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;

    let inserted = 0;
    for (const row of values) {
      try {
        const res = await pool.query(insertSql, row);
        if (res.rowCount > 0) inserted++;
      } catch (e) {
        console.error(`  [${table}] row error:`, e.message);
      }
    }
    console.log(`  [${table}] ${values.length} rows (${inserted} inserted)`);
  }

  sqliteDb.close();
  await pool.end();
  console.log('');
  console.log('Done. Start the server with DATABASE_URL set to use PostgreSQL.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
