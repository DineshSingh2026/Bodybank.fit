require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

// Several hot paths (leaderboards, the notifications bell, admin broadcasts) were
// recently changed from one-query-at-a-time loops to concurrent Promise.all fan-outs
// for speed — that shifts the bottleneck to how many connections this pool allows
// at once. The `pg` default (10) was sized for the old sequential-only code.
// DB_POOL_MAX lets it be tuned back down on a connection-constrained DB plan without
// a code change; the new default (15) is a conservative bump that fits comfortably
// under the connection limit of every common managed-Postgres free/starter tier.
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 15
});

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
