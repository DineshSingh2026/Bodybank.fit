/**
 * Remove all e2e test data from the database so admin/superadmin dashboards are clean.
 * Deletes: users (e2e.*@test.bodybank.fit), their workouts, meetings, contact messages,
 * sunday check-ins; audit_requests (e2e.test emails); part2_audit (e2e.test); tribe (tribe@e2e.test).
 * Run: node scripts/clean-e2e-data.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    // 1. Get e2e user ids
    const e2eUsers = await pool.query(
      toPg("SELECT id FROM users WHERE email LIKE 'e2e.%@test.bodybank.fit'"),
      []
    );
    const userIds = e2eUsers.rows.map((r) => r.id);

    if (userIds.length > 0) {
      // 2. Delete dependent rows (no FK CASCADE from users for these)
      await pool.query(toPg('DELETE FROM workout_logs WHERE user_id = ANY(?)'), [userIds]);
      await pool.query(toPg('DELETE FROM contact_messages WHERE user_id = ANY(?)'), [userIds]);
      await pool.query(toPg('DELETE FROM meetings WHERE user_id = ANY(?)'), [userIds]);
      await pool.query(toPg('DELETE FROM sunday_checkins WHERE user_id = ANY(?)'), [userIds]);
      await pool.query(toPg('DELETE FROM hydration_logs WHERE user_id = ANY(?)'), [userIds]);
      await pool.query(toPg('DELETE FROM weight_logs WHERE user_id = ANY(?)'), [userIds]);
      // progress_logs and user_goals have ON DELETE CASCADE from users, so deleted with users
      await pool.query(toPg("DELETE FROM users WHERE email LIKE 'e2e.%@test.bodybank.fit'"), []);
      console.log('Removed', userIds.length, 'e2e user(s) and their related data.');
    } else {
      console.log('No e2e users found.');
    }

    // 3. Audit requests from e2e (public.audit@e2e.test etc.)
    const auditRes = await pool.query(toPg("DELETE FROM audit_requests WHERE email LIKE '%e2e.test' RETURNING id"), []);
    if (auditRes.rowCount > 0) console.log('Removed', auditRes.rowCount, 'e2e audit request(s).');

    // 4. Part2 from e2e (part2@e2e.test)
    const part2Res = await pool.query(toPg("DELETE FROM part2_audit WHERE email LIKE '%e2e.test' RETURNING id"), []);
    if (part2Res.rowCount > 0) console.log('Removed', part2Res.rowCount, 'e2e part2 submission(s).');

    // 5. Tribe member from e2e (tribe@e2e.test / E2ETribe)
    const tribeRes = await pool.query(
      toPg("DELETE FROM tribe_members WHERE email = 'tribe@e2e.test' OR (first_name = 'E2ETribe' AND last_name = 'Member') RETURNING id"),
      []
    );
    if (tribeRes.rowCount > 0) console.log('Removed', tribeRes.rowCount, 'e2e tribe member(s).');

    console.log('E2E test data cleanup done.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
