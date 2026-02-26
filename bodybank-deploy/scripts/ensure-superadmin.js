/**
 * One-off: ensure a superadmin user exists (same logic as server.js init).
 * Run: node scripts/ensure-superadmin.js (with server stopped or use separate DB concern)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@bodybank.fit';
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'superadmin123';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const r = await pool.query(toPg("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1"), []);
    if (r.rows.length > 0) {
      console.log('Superadmin already exists:', r.rows[0].id);
      return;
    }
    const hash = bcrypt.hashSync(SUPERADMIN_PASS, 10);
    const emailNorm = String(SUPERADMIN_EMAIL).trim().toLowerCase();
    await pool.query(
      toPg("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      [uuidv4(), emailNorm, hash, 'Super', 'Admin', 'superadmin', 'approved']
    );
    console.log('Superadmin created:', SUPERADMIN_EMAIL);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
