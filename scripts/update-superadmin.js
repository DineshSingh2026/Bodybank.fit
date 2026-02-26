/**
 * Create or UPDATE the superadmin user.
 * Use this if superadmin was never created on Render or was created with wrong credentials.
 *
 * Run (from project root):
 *   .env must have DATABASE_URL = Render's Internal Database URL (Render → Postgres → Connect).
 *   Then either:
 *   A) Set in .env: SUPERADMIN_EMAIL=..., SUPERADMIN_PASS=...
 *      node scripts/update-superadmin.js
 *   B) Pass email and password as arguments (password not saved in .env):
 *      node scripts/update-superadmin.js "Superadmin@gmail.com" "Bodybank@2026"
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';
const SUPERADMIN_EMAIL = process.argv[2] || process.env.SUPERADMIN_EMAIL || 'superadmin@bodybank.fit';
const SUPERADMIN_PASS = process.argv[3] || process.env.SUPERADMIN_PASS || 'superadmin123';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function main() {
  if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASS) {
    console.error('Provide email and password: node scripts/update-superadmin.js "your@email.com" "YourPassword"');
    process.exit(1);
  }
  if (!DATABASE_URL || DATABASE_URL === 'postgresql://localhost:5432/bodybank') {
    console.error('Set DATABASE_URL in .env to your Render Postgres Internal URL (Render → Postgres → Connect → Internal Database URL).');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const emailNorm = String(SUPERADMIN_EMAIL).trim().toLowerCase();
    const hash = bcrypt.hashSync(SUPERADMIN_PASS, 10);

    // 1) If any user has this email (e.g. signed up as normal user), make them superadmin and set password
    const byEmail = await pool.query(toPg("SELECT id FROM users WHERE LOWER(email) = ?"), [emailNorm]);
    if (byEmail.rows.length > 0) {
      await pool.query(toPg("UPDATE users SET role = 'superadmin', password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE LOWER(email) = ?"), [hash, emailNorm]);
      // Ensure only one superadmin: demote any other superadmin (different id) to user
      await pool.query(toPg("UPDATE users SET role = 'user' WHERE role = 'superadmin' AND LOWER(email) != ?"), [emailNorm]);
      console.log('Superadmin set for existing email. Email:', emailNorm);
      console.log('Log in with:', SUPERADMIN_EMAIL, 'and your password.');
      return;
    }

    // 2) Else if a superadmin row already exists (different email), update it to this email/password
    const existing = await pool.query(toPg("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1"), []);
    if (existing.rows.length > 0) {
      await pool.query(toPg("UPDATE users SET email = ?, password = ?, first_name = 'Super', last_name = 'Admin', approval_status = 'approved' WHERE role = 'superadmin'"), [emailNorm, hash]);
      console.log('Superadmin updated. Email:', emailNorm);
    } else {
      await pool.query(
        toPg("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)"),
        [uuidv4(), emailNorm, hash, 'Super', 'Admin', 'superadmin', 'approved']
      );
      console.log('Superadmin created. Email:', emailNorm);
    }
    console.log('Log in with the email and password you set.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
