'use strict';

/**
 * USER ISOLATION / IDOR (BOLA) SUITE
 *
 * Creates two synthetic members, USER_A and USER_B, gives each some data, then has
 * USER_A attempt to read and modify USER_B's resources by substituting ids. Every
 * such attempt must be denied.
 *
 * Also checks that a member cannot reach staff-only surfaces, and that no endpoint
 * accepts an unauthenticated request that should require a session.
 *
 * Runs only against the isolated bodybank_sectest database (enforced by env-guard).
 *
 *   node tests/security/test-user-isolation.js
 */

const { assertIsolatedTestEnv, newTestSessionId } = require('./lib/env-guard');
const checkpoint = assertIsolatedTestEnv();

const { get, post, put, del, createUserFast, loginAs } = require('./lib/client');
const A = require('./lib/assert');

const SESSION = newTestSessionId();

async function main() {
  console.log('\n=== SAFETY CHECKPOINT ===');
  Object.entries(checkpoint).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));
  console.log(`  ${'testSessionId'.padEnd(24)} ${SESSION}`);
  console.log('=========================\n');

  console.log('--- creating synthetic users ---');
  const userA = await createUserFast('user-a');
  const userB = await createUserFast('user-b');
  console.log(`  USER_A ${userA.id}  ${userA.email}`);
  console.log(`  USER_B ${userB.id}  ${userB.email}\n`);

  // ---- seed distinguishable data for each user -------------------------------
  console.log('--- seeding per-user data ---');
  const secretA = `${SESSION}-SECRET-OF-A`;
  const secretB = `${SESSION}-SECRET-OF-B`;

  await post('/api/weight', { weight_kg: 71.5, note: secretA }, { token: userA.token });
  await post('/api/weight', { weight_kg: 82.5, note: secretB }, { token: userB.token });
  await post('/api/hydration', { glasses: 3 }, { token: userA.token });
  await post(
    '/api/workouts',
    { user_id: userA.id, workout_name: secretA, duration_seconds: 1800 },
    { token: userA.token }
  );
  await post(
    '/api/workouts',
    { user_id: userB.id, workout_name: secretB, duration_seconds: 2700 },
    { token: userB.token }
  );
  console.log('  seeded\n');

  // ---- 1. unauthenticated access ---------------------------------------------
  console.log('--- 1. unauthenticated access to member data ---');
  A.expectDenied('anon -> GET /api/member/home', await get('/api/member/home'));
  A.expectDenied(`anon -> GET /api/profile/${userB.id}`, await get(`/api/profile/${userB.id}`));
  A.expectDenied(
    `anon -> GET /api/workouts/${userB.id}`,
    await get(`/api/workouts/${userB.id}`),
    { allowEmpty: true }
  );
  A.expectDenied(
    `anon -> GET /api/sunday-checkin/last-weight/${userB.id}`,
    await get(`/api/sunday-checkin/last-weight/${userB.id}`)
  );

  // ---- 2. USER_A reading USER_B by id ----------------------------------------
  console.log('\n--- 2. USER_A -> USER_B resources (read) ---');
  const t = { token: userA.token };

  const pB = await get(`/api/profile/${userB.id}`, t);
  A.expectDenied(`A -> GET /api/profile/${'{B}'}`, pB);
  A.expectNotLeaking('A -> profile(B) leaks no B identifiers', pB, [userB.email, secretB]);

  const wB = await get(`/api/workouts/${userB.id}`, t);
  A.expectDenied('A -> GET /api/workouts/{B}', wB, { allowEmpty: true });
  A.expectNotLeaking('A -> workouts(B) leaks no B data', wB, [secretB]);

  const lwB = await get(`/api/sunday-checkin/last-weight/${userB.id}`, t);
  A.expectDenied('A -> GET /api/sunday-checkin/last-weight/{B}', lwB);

  const upB = await get(`/api/admin/user-progress/${userB.id}`, t);
  A.expectDenied('A -> GET /api/admin/user-progress/{B}', upB);
  A.expectNotLeaking('A -> user-progress(B) leaks no B data', upB, [userB.email, secretB]);

  // ---- 3. USER_A writing to USER_B --------------------------------------------
  console.log('\n--- 3. USER_A -> USER_B resources (write) ---');
  A.expectDenied(
    'A -> PUT /api/profile/{B}',
    await put(`/api/profile/${userB.id}`, { first_name: 'HIJACKED' }, t)
  );

  // Mass assignment: can A set its own role by passing it in a profile update?
  const escalate = await put(`/api/profile/${userA.id}`, { role: 'admin', first_name: 'A' }, t);
  const afterEscalate = await get(`/api/profile/${userA.id}`, t);
  const escalatedRole = afterEscalate.json?.role || afterEscalate.json?.user?.role;
  if (escalatedRole === 'admin' || escalatedRole === 'superadmin') {
    A.fail('mass assignment: role escalation via PUT /api/profile/{self}', `role became ${escalatedRole}`);
  } else {
    A.pass('mass assignment: role not settable via PUT /api/profile/{self}', `role=${escalatedRole || 'user'} (HTTP ${escalate.status})`);
  }

  // Parameter tampering: write a workout claiming to be USER_B.
  const spoof = await post(
    '/api/workouts',
    { user_id: userB.id, workout_name: 'SPOOFED-BY-A', duration_seconds: 600 },
    t
  );
  const bSees = await get(`/api/workouts/${userB.id}`, { token: userB.token });
  if (String(bSees.text).includes('SPOOFED-BY-A')) {
    A.fail('parameter tampering: A wrote a workout into B\'s account', `HTTP ${spoof.status}`);
  } else {
    A.pass('parameter tampering: user_id in body cannot target another account');
  }

  // ---- 4. member -> staff surfaces ---------------------------------------------
  console.log('\n--- 4. member -> staff-only surfaces ---');
  A.expectDenied('A -> GET /api/admin/db-view', await get('/api/admin/db-view', t));
  A.expectDenied('A -> GET /api/admin/users', await get('/api/admin/users', t));
  A.expectDenied('A -> GET /api/stats', await get('/api/stats', t));
  A.expectDenied(
    'A -> GET /api/admin/performance-insights',
    await get('/api/admin/performance-insights', t)
  );
  A.expectDenied('A -> GET /api/debug-reset-setup', await get('/api/debug-reset-setup', t));
  A.expectDenied('A -> GET /api/operator/overview', await get('/api/operator/overview', t));

  // ---- 5. token integrity -------------------------------------------------------
  console.log('\n--- 5. token integrity ---');
  const forged = userA.token.slice(0, -3) + 'AAA';
  A.expectDenied('tampered signature rejected', await get('/api/me/home', { token: forged }));

  const alg_none = (() => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: userB.id, email: userB.email, role: 'superadmin' })}.`;
  })();
  A.expectDenied('alg:none token rejected', await get('/api/me/home', { token: alg_none }));

  const hs256Forged = (() => {
    const jwt = require('jsonwebtoken');
    return jwt.sign({ id: userB.id, email: userB.email, role: 'superadmin' }, 'bodybank-progress-secret-change-in-production');
  })();
  A.expectDenied(
    'token signed with the old published fallback secret is rejected',
    await get('/api/me/home', { token: hs256Forged })
  );

  // ---- 6. self-service still works (regression) ----------------------------------
  console.log('\n--- 6. regression: each user can still use their own data ---');
  A.expectStatus('A -> GET /api/me/home', await get('/api/me/home', t), 200);
  A.expectStatus('A -> GET /api/me/scorecard', await get('/api/me/scorecard', t), 200);
  A.expectStatus('B -> GET /api/me/home', await get('/api/me/home', { token: userB.token }), 200);
  const ownWorkouts = await get(`/api/workouts/${userA.id}`, t);
  A.expectStatus('A -> GET /api/workouts/{A}', ownWorkouts, 200);
  A.expectNotLeaking('A -> own workouts contain no B data', ownWorkouts, [secretB]);

  const s = A.summary('USER ISOLATION RESULTS');
  console.log(`Synthetic accounts left in ${checkpoint.dbName}: ${userA.email}, ${userB.email}`);
  process.exit(A.exitCode());
}

main().catch((e) => {
  console.error('\nSUITE ERROR:', e.message);
  process.exit(1);
});
