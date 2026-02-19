/**
 * End-to-end test: Sign up → Admin approve → Login → User actions → Admin dashboard & DB check.
 * Run: node tests/e2e-flow.js (server must be running on port 3000)
 */
require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const BASE = 'http://localhost:3000';
const PORT = 3000;

const testUser = {
  email: `e2e.${Date.now()}@test.bodybank.fit`,
  password: 'TestPass123!',
  first_name: 'E2E',
  last_name: 'Tester',
  phone: '9998887770'
};

let createdIds = { userId: null, auditId: null, part2Id: null, meetingId: null, workoutId: null, contactId: null, checkinId: null };
let failures = [];

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port || PORT,
      path: url.pathname,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(ok, msg) {
  if (!ok) failures.push(msg);
  return ok;
}

async function queryDb(sql, params = []) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const res = await pool.query(pgSql, params);
    return res.rows;
  } finally {
    await pool.end();
  }
}

async function runTests() {
  console.log('=== E2E: Sign up ===');
  const signup = await request('POST', '/api/auth/signup', {
    email: testUser.email,
    password: testUser.password,
    first_name: testUser.first_name,
    last_name: testUser.last_name,
    phone: testUser.phone
  });
  assert(signup.status === 200, `Signup status ${signup.status}: ${JSON.stringify(signup.body)}`);
  assert(signup.body && signup.body.pending_approval === true, 'Signup should return pending_approval');
  createdIds.userId = signup.body?.id || null;
  console.log(signup.status === 200 ? '  OK' : '  FAIL', signup.body);

  console.log('=== E2E: Login before approve (should be pending) ===');
  const loginPending = await request('POST', '/api/auth/login', { email: testUser.email, password: testUser.password });
  assert(loginPending.status === 403 && loginPending.body?.error === 'pending_approval', 'Login before approve should be 403 pending_approval');
  console.log(loginPending.status === 403 ? '  OK' : '  FAIL');

  console.log('=== E2E: Admin – pending signups ===');
  const pending = await request('GET', '/api/admin/pending-signups');
  assert(pending.status === 200 && Array.isArray(pending.body), 'Pending signups should be array');
  const found = pending.body?.find(u => u.email === testUser.email);
  assert(!!found, 'New user should appear in pending signups');
  console.log(found ? '  OK' : '  FAIL');

  console.log('=== E2E: Admin – approve user ===');
  const approve = await request('POST', `/api/admin/approve-user/${createdIds.userId}`);
  assert(approve.status === 200, `Approve status ${approve.status}`);
  console.log(approve.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Login after approve ===');
  const login = await request('POST', '/api/auth/login', { email: testUser.email, password: testUser.password });
  assert(login.status === 200 && login.body?.id, 'Login should return user');
  const userId = login.body?.id || createdIds.userId;
  console.log(login.status === 200 ? '  OK' : '  FAIL', login.body?.email);

  console.log('=== E2E: Profile get & update ===');
  const profileGet = await request('GET', `/api/profile/${userId}`);
  assert(profileGet.status === 200 && profileGet.body?.email === testUser.email, 'Profile GET');
  const profilePut = await request('PUT', `/api/profile/${userId}`, { first_name: 'E2EUpdated', phone: '1112223334' });
  assert(profilePut.status === 200, 'Profile PUT');
  console.log(profilePut.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Workout log ===');
  const workout = await request('POST', '/api/workouts', {
    user_id: userId,
    workout_name: 'E2E Run',
    duration_seconds: 600,
    feedback: 'Good'
  });
  assert(workout.status === 200 && workout.body?.id, 'Workout POST');
  createdIds.workoutId = workout.body?.id;
  console.log(workout.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Contact message ===');
  const contact = await request('POST', '/api/contact', {
    user_id: userId,
    name: 'E2E User',
    phone: '1112223334',
    email: testUser.email,
    message: 'E2E test message'
  });
  assert(contact.status === 200 && contact.body?.id, 'Contact POST');
  createdIds.contactId = contact.body?.id;
  console.log(contact.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Meeting (schedule call) ===');
  const meeting = await request('POST', '/api/meetings', {
    user_id: userId,
    user_name: 'E2E Tester',
    user_email: testUser.email,
    user_phone: testUser.phone,
    meeting_date: '2026-03-01',
    time_slot: '10:00-11:00',
    notes: 'E2E test'
  });
  assert(meeting.status === 200 && meeting.body?.id, 'Meeting POST');
  createdIds.meetingId = meeting.body?.id;
  console.log(meeting.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Sunday check-in ===');
  const checkin = await request('POST', '/api/sunday-checkin', {
    user_id: userId,
    full_name: 'E2E Tester',
    reply_email: testUser.email,
    plan: 'Phase 1',
    current_weight_waist_week: '70kg',
    achievements: 'E2E test'
  });
  assert(checkin.status === 200 && checkin.body?.id, 'Sunday check-in POST');
  createdIds.checkinId = checkin.body?.id;
  console.log(checkin.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Public audit form ===');
  const audit = await request('POST', '/api/audit', {
    first_name: 'Public',
    last_name: 'Audit',
    email: 'public.audit@e2e.test',
    city: 'Mumbai',
    goals: 'E2E audit'
  });
  assert(audit.status === 200 && audit.body?.id, 'Audit POST');
  createdIds.auditId = audit.body?.id;
  console.log(audit.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Public part2 form ===');
  const part2 = await request('POST', '/api/part2', {
    name: 'Part2 User',
    email: 'part2@e2e.test',
    mobile: '9990001111',
    activity_level: 'Moderate',
    goals: 'E2E part2'
  });
  assert(part2.status === 200 && part2.body?.id, 'Part2 POST');
  createdIds.part2Id = part2.body?.id;
  console.log(part2.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Admin dashboard – stats ===');
  const stats = await request('GET', '/api/stats');
  assert(stats.status === 200 && stats.body && Number.isFinite(Number(stats.body.pending_requests)), 'Stats');
  console.log(stats.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Admin – notifications ===');
  const notif = await request('GET', '/api/notifications');
  assert(notif.status === 200 && Array.isArray(notif.body), 'Notifications');
  console.log(notif.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Admin – db-view ===');
  const dbView = await request('GET', '/api/admin/db-view');
  assert(dbView.status === 200 && dbView.body?.tables, 'DB view');
  const tables = dbView.body?.tables || {};
  assert(Array.isArray(tables.workout_logs) && tables.workout_logs.some(w => w.id === createdIds.workoutId), 'Workout in db-view');
  assert(Array.isArray(tables.contact_messages) && tables.contact_messages.some(c => c.id === createdIds.contactId), 'Contact in db-view');
  assert(Array.isArray(tables.meetings) && tables.meetings.some(m => m.id === createdIds.meetingId), 'Meeting in db-view');
  assert(Array.isArray(tables.sunday_checkins) && tables.sunday_checkins.some(s => s.id === createdIds.checkinId), 'Sunday checkin in db-view');
  assert(Array.isArray(tables.audit_requests) && tables.audit_requests.some(a => a.id === createdIds.auditId), 'Audit in db-view');
  assert(Array.isArray(tables.part2_audit) && tables.part2_audit.some(p => p.id === createdIds.part2Id), 'Part2 in db-view');
  console.log(dbView.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Database direct check ===');
  const userRow = await queryDb('SELECT id, email, first_name, approval_status FROM users WHERE id = ?', [userId]);
  assert(userRow.length === 1 && userRow[0].approval_status === 'approved' && userRow[0].first_name === 'E2EUpdated', 'User in DB');
  const workoutRows = await queryDb('SELECT id FROM workout_logs WHERE id = ?', [createdIds.workoutId]);
  assert(workoutRows.length === 1, 'Workout in DB');
  const contactRows = await queryDb('SELECT id FROM contact_messages WHERE id = ?', [createdIds.contactId]);
  assert(contactRows.length === 1, 'Contact in DB');
  const meetingRows = await queryDb('SELECT id FROM meetings WHERE id = ?', [createdIds.meetingId]);
  assert(meetingRows.length === 1, 'Meeting in DB');
  const checkinRows = await queryDb('SELECT id FROM sunday_checkins WHERE id = ?', [createdIds.checkinId]);
  assert(checkinRows.length === 1, 'Sunday checkin in DB');
  const auditRows = await queryDb('SELECT id FROM audit_requests WHERE id = ?', [createdIds.auditId]);
  assert(auditRows.length === 1, 'Audit in DB');
  const part2Rows = await queryDb('SELECT id FROM part2_audit WHERE id = ?', [createdIds.part2Id]);
  assert(part2Rows.length === 1, 'Part2 in DB');
  console.log('  OK');

  console.log('=== E2E: Admin – list endpoints (data visible) ===');
  const workoutsList = await request('GET', '/api/workouts');
  assert(workoutsList.status === 200 && workoutsList.body?.some(w => w.id === createdIds.workoutId), 'GET /api/workouts');
  const contactList = await request('GET', '/api/contact');
  assert(contactList.status === 200 && contactList.body?.some(c => c.id === createdIds.contactId), 'GET /api/contact');
  const auditList = await request('GET', '/api/audit');
  assert(auditList.status === 200 && auditList.body?.some(a => a.id === createdIds.auditId), 'GET /api/audit');
  const part2List = await request('GET', '/api/part2');
  assert(part2List.status === 200 && part2List.body?.some(p => p.id === createdIds.part2Id), 'GET /api/part2');
  const checkinList = await request('GET', '/api/sunday-checkin');
  assert(checkinList.status === 200 && checkinList.body?.some(s => s.id === createdIds.checkinId), 'GET /api/sunday-checkin');
  const meetingsList = await request('GET', '/api/meetings');
  assert(meetingsList.status === 200 && meetingsList.body?.some(m => m.id === createdIds.meetingId), 'GET /api/meetings');
  const meetingsByUser = await request('GET', `/api/meetings/user/${userId}`);
  assert(meetingsByUser.status === 200 && meetingsByUser.body?.some(m => m.id === createdIds.meetingId), 'GET /api/meetings/user/:id');
  const workoutsByUser = await request('GET', `/api/workouts/${userId}`);
  assert(workoutsByUser.status === 200 && workoutsByUser.body?.some(w => w.id === createdIds.workoutId), 'GET /api/workouts/:userId');
  console.log('  OK');

  console.log('=== E2E: Admin – performance insights ===');
  const perf = await request('GET', '/api/admin/performance-insights');
  assert(perf.status === 200 && perf.body?.summary != null && Array.isArray(perf.body?.data), 'Performance insights');
  console.log(perf.status === 200 ? '  OK' : '  FAIL');

  console.log('=== E2E: Admin – audit update status ===');
  const auditUpdate = await request('PUT', `/api/audit/${createdIds.auditId}`, { status: 'approved' });
  assert(auditUpdate.status === 200, 'Audit PUT status');
  const auditGet = await request('GET', `/api/audit/${createdIds.auditId}`);
  assert(auditGet.status === 200 && auditGet.body?.status === 'approved', 'Audit status updated in DB');
  console.log('  OK');

  console.log('=== E2E: Admin – tribe add ===');
  const tribePost = await request('POST', '/api/tribe', {
    first_name: 'E2ETribe',
    last_name: 'Member',
    email: 'tribe@e2e.test',
    city: 'Delhi',
    phase: 1
  });
  assert(tribePost.status === 200 && tribePost.body?.id, 'Tribe POST');
  const tribeId = tribePost.body?.id;
  const tribeGet = await request('GET', `/api/tribe/${tribeId}`);
  assert(tribeGet.status === 200 && tribeGet.body?.first_name === 'E2ETribe', 'Tribe GET');
  console.log('  OK');

  console.log('=== E2E: Admin – tribe update ===');
  const tribePut = await request('PUT', `/api/tribe/${tribeId}`, { notes: 'E2E note', status: 'active' });
  assert(tribePut.status === 200, 'Tribe PUT');
  console.log('  OK');

  console.log('=== E2E: Rejected user can re-signup ===');
  const reject = await request('POST', `/api/admin/reject-user/${userId}`);
  assert(reject.status === 200, 'Admin reject user');
  const signupAgain = await request('POST', '/api/auth/signup', {
    email: testUser.email,
    password: 'NewPass456!',
    first_name: 'E2E',
    last_name: 'ReSignup',
    phone: testUser.phone
  });
  assert(signupAgain.status === 200 && signupAgain.body?.pending_approval === true, 'Re-signup after reject');
  const reApprove = await request('POST', `/api/admin/approve-user/${userId}`);
  assert(reApprove.status === 200, 'Re-approve');
  const loginAgain = await request('POST', '/api/auth/login', { email: testUser.email, password: 'NewPass456!' });
  assert(loginAgain.status === 200, 'Login after re-signup');
  console.log('  OK');

  if (failures.length > 0) {
    console.log('\n--- FAILURES ---');
    failures.forEach(f => console.log(' ', f));
    process.exit(1);
  }
  console.log('\n--- All E2E checks passed ---');
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
