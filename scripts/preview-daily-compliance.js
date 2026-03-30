/**
 * Preview the admin daily compliance dataset from DB.
 * Run:
 *   DATABASE_URL=... node scripts/preview-daily-compliance.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const { getAdminDailyComplianceReportData } = require('../services/emailScheduler');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const queryAll = async (sql, params = []) => {
    let i = 0;
    const text = String(sql).replace(/\?/g, () => `$${++i}`);
    const r = await pool.query(text, params);
    return r.rows;
  };

  const counts = async () => {
    const all = (await pool.query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
    const roleUsers = (await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'user'")).rows[0].c;
    const approved = (await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'user' AND COALESCE(approval_status, 'approved') = 'approved'")).rows[0].c;
    const active = (await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'user' AND COALESCE(approval_status, 'approved') = 'approved' AND COALESCE(suspended, FALSE) = FALSE")).rows[0].c;
    return { all, roleUsers, approved, active };
  };

  try {
    const c = await counts();
    const data = await getAdminDailyComplianceReportData({ queryAll });
    console.log(JSON.stringify({
      window_start_utc: data.startIso,
      window_end_utc: data.endIso,
      window_label_ist: data.windowLabel,
      summary: data.summary,
      user_counts: c,
      first_rows: (data.rows || []).slice(0, 10)
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

