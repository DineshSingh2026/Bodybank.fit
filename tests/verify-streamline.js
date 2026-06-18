/**
 * Targeted verification of the 2026-06-18 admin streamlining changes.
 * Run with server up: E2E_BASE_URL=http://localhost:3088 node tests/verify-streamline.js
 */
require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3088';

function request(method, path, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...(opts.headers || {}) };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (opts.auth && opts.auth.token) headers['Authorization'] = 'Bearer ' + opts.auth.token;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const out = [];
let fails = 0;
function check(name, cond, detail) {
  out.push((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : ''));
  if (!cond) fails++;
}

(async () => {
  // 1) Fresh signup → instant trial + appears on Client Board (tribe)
  const email = `verify.${Date.now()}@test.bodybank.fit`;
  const signup = await request('POST', '/api/auth/signup', {
    email, password: 'TestPass123!', first_name: 'Verify', last_name: 'Streamline',
    phone: '9990001234', height_cm: 175, country: 'IN', timezone: 'Asia/Kolkata',
    city: 'Mumbai', dob: '1990-01-15', gender: 'other', state_province: 'MH'
  });
  console.log('\n--- PHASE 1: instant trial + auto Client Board ---');
  check('signup returns trial:true', signup.body && signup.body.trial === true, JSON.stringify(signup.body));
  const userId = signup.body && signup.body.id;

  const adminEmail = process.env.SUPERADMIN_EMAIL || 'superadmin@bodybank.fit';
  const adminPass = process.env.SUPERADMIN_PASS || 'superadmin123';
  const adminLogin = await request('POST', '/api/auth/login', { email: adminEmail, password: adminPass });
  const token = adminLogin.body && adminLogin.body.token;
  check('admin/superadmin login works', !!token);

  const tribe = await request('GET', '/api/tribe', null, { auth: { token } });
  const onBoard = Array.isArray(tribe.body) && tribe.body.some(m => String(m.email || '').toLowerCase() === email.toLowerCase());
  check('new trial user auto-added to Client Board', onBoard);

  // pending-signups route should be gone (404)
  const pend = await request('GET', '/api/admin/pending-signups', null, { auth: { token } });
  check('GET /api/admin/pending-signups removed (404)', pend.status === 404, 'status ' + pend.status);

  // 2) stats: has `trials`, no `pending_signups`
  console.log('\n--- PHASE 1: stats repurposed to trials ---');
  const stats = await request('GET', '/api/stats', null, { auth: { token } });
  check('stats has numeric `trials`', stats.body && typeof stats.body.trials === 'number', 'trials=' + (stats.body && stats.body.trials));
  check('stats no longer has `pending_signups`', stats.body && stats.body.pending_signups === undefined);

  // 3) Leads pipeline: 6 stages, no legacy ids
  console.log('\n--- PHASE 2: pipeline collapsed to 6 stages ---');
  const leads = await request('GET', '/api/admin/leads', null, { auth: { token } });
  const stageIds = (leads.body && leads.body.stages || []).map(s => s.id);
  const expected = ['new_audit', 'contacted', 'part2', 'call', 'converted', 'lost'];
  check('leads returns exactly the 6 new stages', JSON.stringify(stageIds) === JSON.stringify(expected), stageIds.join(','));

  const today = await request('GET', '/api/admin/leads/today', null, { auth: { token } });
  check('today widget has `after_call` key', today.body && Object.prototype.hasOwnProperty.call(today.body, 'after_call'));
  check('today widget dropped `payment_pending` key', today.body && !Object.prototype.hasOwnProperty.call(today.body, 'payment_pending'));

  // 4) Members tab: memberships carries AI-access fields
  console.log('\n--- PHASE 3: Members tab (memberships + AI access merged) ---');
  const mem = await request('GET', '/api/admin/memberships', null, { auth: { token } });
  const sample = mem.body && Array.isArray(mem.body.users) && mem.body.users[0];
  check('memberships returns users', !!sample);
  if (sample) {
    const hasAi = ['nutrition_ai_unlimited','nutrition_ai_meal_limit','nutrition_ai_meal_used','ai_trainer_unlimited','ai_trainer_trial_limit','ai_trainer_trial_used']
      .every(k => Object.prototype.hasOwnProperty.call(sample, k));
    check('each member carries AI-access fields', hasAi, 'keys: ' + Object.keys(sample).filter(k => k.indexOf('ai') > -1).join(','));
  }

  // 5) DB-level: no legacy stage values remain
  console.log('\n--- DB: stage migration applied ---');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await pool.query("SELECT DISTINCT stage FROM audit_requests");
    const distinct = r.rows.map(x => x.stage);
    const legacy = ['whatsapp_sent','in_conversation','part2_sent','part2_received','call_proposed','call_scheduled','call_done','payment_pending','onboarded'];
    const stray = distinct.filter(s => legacy.indexOf(s) >= 0);
    check('no legacy stage values left in audit_requests', stray.length === 0, 'distinct stages: [' + distinct.join(', ') + ']');
  } finally { await pool.end(); }

  console.log('\n' + out.join('\n'));
  console.log('\n' + (fails === 0 ? '✅ ALL VERIFICATION CHECKS PASSED' : `❌ ${fails} CHECK(S) FAILED`));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('VERIFY ERROR:', e); process.exit(1); });
