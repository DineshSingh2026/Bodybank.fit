/**
 * Verify PostgreSQL connection and that data is readable/writable.
 * Run: node scripts/check-db.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

async function run() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const errors = [];
  const results = { connection: false, tables: {}, writeTest: false };

  console.log('1. Testing connection...');
  try {
    const r = await pool.query('SELECT 1 as ok, current_database() as db');
    results.connection = r.rows[0]?.ok === 1;
    console.log('   OK – connected to database:', r.rows[0]?.db || 'bodybank');
  } catch (e) {
    errors.push('Connection failed: ' + e.message);
    console.log('   FAIL:', e.message);
    await pool.end();
    process.exit(1);
  }

  const tables = [
    'users', 'audit_requests', 'tribe_members', 'workout_logs',
    'contact_messages', 'meetings', 'part2_audit', 'hydration_logs',
    'weight_logs', 'sunday_checkins'
  ];

  console.log('\n2. Table row counts (data saved):');
  for (const table of tables) {
    try {
      const r = await pool.query(`SELECT COUNT(*) as c FROM ${table}`);
      const count = parseInt(r.rows[0]?.c ?? 0, 10);
      results.tables[table] = count;
      console.log('   ', table + ':', count, 'rows');
    } catch (e) {
      results.tables[table] = 'error';
      errors.push(`${table}: ${e.message}`);
      console.log('   ', table + ': ERROR –', e.message);
    }
  }

  console.log('\n3. Write test (INSERT then SELECT then DELETE):');
  try {
    const testId = 'check-db-test-' + Date.now();
    await pool.query(
      "INSERT INTO contact_messages (id, user_id, name, email, message) VALUES ($1, $2, $3, $4, $5)",
      [testId, null, 'CheckDB', 'check@test.local', 'Connection and write test']
    );
    const r = await pool.query('SELECT id, name FROM contact_messages WHERE id = $1', [testId]);
    if (r.rows.length === 1 && r.rows[0].name === 'CheckDB') {
      results.writeTest = true;
      console.log('   OK – row written and read back');
    } else {
      errors.push('Write test: row not found after insert');
      console.log('   FAIL – row not found after insert');
    }
    await pool.query('DELETE FROM contact_messages WHERE id = $1', [testId]);
  } catch (e) {
    errors.push('Write test: ' + e.message);
    console.log('   FAIL:', e.message);
  }

  await pool.end();

  console.log('\n--- Summary ---');
  if (errors.length > 0) {
    console.log('Errors:', errors);
    process.exit(1);
  }
  console.log('All checks passed. Connection OK, tables readable, write/read/delete OK.');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
