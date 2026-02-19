/**
 * Remove all data created by E2E tests from the database.
 * Run: node scripts/remove-e2e-data.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';

async function run() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  let totalDeleted = 0;

  console.log('Removing E2E test data...\n');

  // Get E2E user ids first (email like e2e.% or @test.bodybank.fit)
  const e2eUsers = await pool.query(
    "SELECT id FROM users WHERE email LIKE 'e2e.%' OR email LIKE '%@test.bodybank.fit'"
  );
  const e2eUserIds = (e2eUsers.rows || []).map(r => r.id);

  if (e2eUserIds.length > 0) {
    const placeholders = e2eUserIds.map((_, i) => `$${i + 1}`).join(',');
    const delWorkouts = await pool.query(`DELETE FROM workout_logs WHERE user_id IN (${placeholders})`, e2eUserIds);
    const delContact = await pool.query(`DELETE FROM contact_messages WHERE user_id IN (${placeholders})`, e2eUserIds);
    const delMeetings = await pool.query(`DELETE FROM meetings WHERE user_id IN (${placeholders})`, e2eUserIds);
    const delCheckins = await pool.query(`DELETE FROM sunday_checkins WHERE user_id IN (${placeholders})`, e2eUserIds);
    totalDeleted += (delWorkouts.rowCount || 0) + (delContact.rowCount || 0) + (delMeetings.rowCount || 0) + (delCheckins.rowCount || 0);
    console.log('  workout_logs:', delWorkouts.rowCount || 0);
    console.log('  contact_messages:', delContact.rowCount || 0);
    console.log('  meetings:', delMeetings.rowCount || 0);
    console.log('  sunday_checkins:', delCheckins.rowCount || 0);
  }

  // Contact/messages may also be by name
  const delContactByName = await pool.query("DELETE FROM contact_messages WHERE name = 'E2E User'");
  if ((delContactByName.rowCount || 0) > 0) {
    totalDeleted += delContactByName.rowCount;
    console.log('  contact_messages (by name):', delContactByName.rowCount);
  }

  // Delete E2E users (keep admin)
  const delUsers = await pool.query(
    "DELETE FROM users WHERE (email LIKE 'e2e.%' OR email LIKE '%@test.bodybank.fit') AND role = 'user'"
  );
  totalDeleted += delUsers.rowCount || 0;
  console.log('  users:', delUsers.rowCount || 0);

  // Audit requests from E2E (public.audit@e2e.test)
  const delAudit = await pool.query("DELETE FROM audit_requests WHERE email = 'public.audit@e2e.test'");
  totalDeleted += delAudit.rowCount || 0;
  console.log('  audit_requests:', delAudit.rowCount || 0);

  // Part2 from E2E
  const delPart2 = await pool.query("DELETE FROM part2_audit WHERE email = 'part2@e2e.test'");
  totalDeleted += delPart2.rowCount || 0;
  console.log('  part2_audit:', delPart2.rowCount || 0);

  // Tribe members from E2E
  const delTribe = await pool.query("DELETE FROM tribe_members WHERE email = 'tribe@e2e.test' OR first_name = 'E2ETribe'");
  totalDeleted += delTribe.rowCount || 0;
  console.log('  tribe_members:', delTribe.rowCount || 0);

  await pool.end();
  console.log('\nDone. Total rows removed:', totalDeleted);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
