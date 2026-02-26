#!/usr/bin/env node
/**
 * One-time script to add/update a user for testing (PostgreSQL).
 * Run: node scripts/seed-user.js
 * Requires: DATABASE_URL in .env
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';
const EMAIL = process.env.SEED_EMAIL || 'dineshkishoresingh@gmail.com';
const PASSWORD = process.env.SEED_PASSWORD || 'Password@123';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('PostgreSQL connection failed. Set DATABASE_URL in .env. Error:', e.message);
    process.exit(1);
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const emailNorm = EMAIL.trim().toLowerCase();

  const existing = await pool.query(toPg('SELECT id FROM users WHERE LOWER(email) = ?'), [emailNorm]);
  const hasExisting = existing.rows && existing.rows.length > 0;

  if (hasExisting && existing.rows[0].id) {
    await pool.query(toPg('UPDATE users SET password = ? WHERE LOWER(email) = ?'), [hash, emailNorm]);
    console.log('✅ Updated password for', EMAIL);
  } else {
    const id = uuidv4();
    await pool.query(
      toPg('INSERT INTO users (id, email, password, first_name, last_name, role) VALUES (?, ?, ?, ?, ?, ?)'),
      [id, emailNorm, hash, 'Dinesh', 'Singh', 'user']
    );
    console.log('✅ Created user:', EMAIL);
  }

  await pool.end();
  console.log('Done. You can now login with:', EMAIL, '/', PASSWORD);
}

main().catch(e => { console.error(e); process.exit(1); });
