/**
 * Provision an Operator account (read-only user-activity monitoring role).
 *
 * The Operator sees everything a client does but can change nothing — all client
 * management stays with Admin/Superadmin. This mirrors scripts/ensure-superadmin.js.
 *
 * Behaviour:
 *   - If a user with OPERATOR_EMAIL already exists, promote them to role='operator'.
 *   - Otherwise create a new approved operator account with OPERATOR_PASS.
 *
 * Run: node scripts/ensure-operator.js
 * Env: OPERATOR_EMAIL (default operator@bodybank.fit), OPERATOR_PASS (default operator123)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';
const OPERATOR_EMAIL = (process.env.OPERATOR_EMAIL || 'operator@bodybank.fit').trim().toLowerCase();
const OPERATOR_PASS = process.env.OPERATOR_PASS || 'operator123';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const existing = await pool.query(toPg('SELECT id, role FROM users WHERE LOWER(email) = ? LIMIT 1'), [OPERATOR_EMAIL]);
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.role === 'operator') {
        console.log('Operator already exists:', OPERATOR_EMAIL, '(' + row.id + ')');
        return;
      }
      await pool.query(toPg("UPDATE users SET role = 'operator', approval_status = 'approved' WHERE id = ?"), [row.id]);
      console.log('Promoted existing user to operator:', OPERATOR_EMAIL, '(' + row.id + ')');
      return;
    }
    const hash = bcrypt.hashSync(OPERATOR_PASS, 10);
    await pool.query(
      toPg('INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      [uuidv4(), OPERATOR_EMAIL, hash, 'Operator', '', 'operator', 'approved']
    );
    console.log('Operator created:', OPERATOR_EMAIL);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
