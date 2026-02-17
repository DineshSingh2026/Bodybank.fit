/**
 * View all data in the BodyBank SQLite database.
 * Run: node scripts/view-db.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bodybank.db');

const TABLES = [
  'users',
  'audit_requests',
  'tribe_members',
  'workout_logs',
  'contact_messages',
  'meetings',
  'part2_audit'
];

function formatRow(cols, row) {
  const obj = {};
  cols.forEach((c, i) => { obj[c] = row[i]; });
  return obj;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('No database found at:', DB_PATH);
    return;
  }

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  console.log('========== BodyBank DB:', DB_PATH, '==========\n');

  for (const table of TABLES) {
    try {
      const result = db.exec(`SELECT * FROM ${table}`);
      if (!result.length || !result[0].values.length) {
        console.log(`--- ${table} (0 rows) ---\n`);
        continue;
      }
      const { columns, values } = result[0];
      console.log(`--- ${table} (${values.length} row(s)) ---`);
      values.forEach((row, i) => {
        console.log(JSON.stringify(formatRow(columns, row), null, 2));
      });
      console.log('');
    } catch (e) {
      console.log(`--- ${table} (table missing or error: ${e.message}) ---\n`);
    }
  }

  db.close();
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
