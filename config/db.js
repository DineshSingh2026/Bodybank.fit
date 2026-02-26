require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

const pool = new Pool({ connectionString: DATABASE_URL });

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res;
}

async function queryAll(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows || [];
}

async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = { pool, query, queryAll, queryOne, toPg };
