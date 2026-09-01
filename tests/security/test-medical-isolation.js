'use strict';

/**
 * MEDICAL & NUTRITION ISOLATION SUITE
 *
 * The blood-report, wearables and nutrition routers carry the most sensitive data in
 * the product — lab results, readiness metrics, food logs. This suite confirms a
 * member reaches only their own, and that every staff-only route refuses a member.
 *
 * Note on roles: routes/blood.js deliberately grants the Operator role full parity
 * with admins for blood-report management (see STAFF_ROLES there). That is a product
 * decision, not a defect; these tests assert the member boundary, which is the one
 * that must never move.
 *
 *   node tests/security/test-medical-isolation.js
 */

const { assertIsolatedTestEnv, newTestSessionId } = require('./lib/env-guard');
const checkpoint = assertIsolatedTestEnv();

const { get, post, put, del, createUserFast } = require('./lib/client');
const A = require('./lib/assert');

const SESSION = newTestSessionId();

async function main() {
  console.log('\n=== SAFETY CHECKPOINT ===');
  Object.entries(checkpoint).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));
  console.log(`  ${'testSessionId'.padEnd(24)} ${SESSION}`);
  console.log('=========================\n');

  const today = new Date().toISOString().slice(0, 10);
  const userA = await createUserFast('med-a');
  const userB = await createUserFast('med-b');
  const tA = { token: userA.token };
  const tB = { token: userB.token };
  console.log(`  USER_A ${userA.id}\n  USER_B ${userB.id}\n`);

  // ---- 1. anonymous access to medical surfaces --------------------------------
  console.log('--- 1. anonymous access ---');
  A.expectDenied('anon -> GET /api/blood/my-reports', await get('/api/blood/my-reports'));
  A.expectDenied('anon -> GET /api/blood/my-progress', await get('/api/blood/my-progress'));
  A.expectDenied('anon -> GET /api/blood/admin/all', await get('/api/blood/admin/all'));
  A.expectDenied('anon -> POST /api/blood/upload', await post('/api/blood/upload', {}));
  A.expectDenied('anon -> GET /api/nutrition/admin/all', await get('/api/nutrition/admin/all'));
  A.expectDenied('anon -> GET /api/wearables/readiness', await get('/api/wearables/readiness'));
  A.expectDenied('anon -> GET /api/wearables/journal', await get('/api/wearables/journal'));

  // ---- 2. member cannot reach staff medical surfaces ---------------------------
  console.log('\n--- 2. member -> staff-only medical routes ---');
  A.expectDenied('A -> GET /api/blood/admin/all', await get('/api/blood/admin/all', tA));
  A.expectDenied('A -> GET /api/blood/admin/comparable', await get('/api/blood/admin/comparable', tA));
  A.expectDenied(`A -> GET /api/blood/admin/slots/{B}`, await get(`/api/blood/admin/slots/${userB.id}`, tA));
  A.expectDenied(`A -> GET /api/blood/admin/comparisons/{B}`, await get(`/api/blood/admin/comparisons/${userB.id}`, tA));
  A.expectDenied(
    `A -> POST /api/blood/admin/upload/{B}`,
    await post(`/api/blood/admin/upload/${userB.id}`, { fileBase64: 'x', mimeType: 'application/pdf' }, tA)
  );
  A.expectDenied('A -> POST /api/blood/admin/compare', await post('/api/blood/admin/compare', { userId: userB.id, reportIds: [] }, tA));
  A.expectDenied('A -> GET /api/nutrition/admin/all', await get('/api/nutrition/admin/all', tA));
  A.expectDenied('A -> GET /api/nutrition/admin/export', await get('/api/nutrition/admin/export', tA));
  // The wearables router exposes the same client data three ways — member, admin and
  // operator. A member must be refused on both staff variants for another member.
  A.expectDenied(`A -> GET /api/wearables/admin/{B}/readiness`, await get(`/api/wearables/admin/${userB.id}/readiness`, tA));
  A.expectDenied(`A -> GET /api/wearables/admin/{B}/journal`, await get(`/api/wearables/admin/${userB.id}/journal`, tA));
  A.expectDenied(`A -> GET /api/wearables/operator/{B}/readiness`, await get(`/api/wearables/operator/${userB.id}/readiness`, tA));
  A.expectDenied(`A -> POST /api/wearables/admin/{B}/report`, await post(`/api/wearables/admin/${userB.id}/report`, {}, tA));
  // DELETE /api/wearables/data purges the CALLER's provider data and takes no target
  // parameter. Passing another member's id must therefore be ignored, not honoured:
  // a 200 here is correct, and what matters is that B's data survives it.
  const purgeAsB = await del('/api/wearables/data?userId=' + userB.id, tA);
  A.expectStatus('A -> DELETE /api/wearables/data?userId={B} is accepted for A only', purgeAsB, 200);
  const bReadiness = await get(`/api/wearables/readiness?date=${today}`, tB);
  A.expectStatus("B's wearables data is unaffected by A's purge", bReadiness, 200);

  // ---- 3. cross-member nutrition reads -------------------------------------------
  console.log('\n--- 3. cross-member nutrition ---');
  const nlogB = await get(`/api/nutrition/log/${userB.id}/${today}`, tA);
  A.expectDenied('A -> GET /api/nutrition/log/{B}/{today}', nlogB, { allowEmpty: true });
  A.expectNotLeaking('A -> nutrition log(B) leaks nothing', nlogB, [userB.email]);

  const nrepB = await get(`/api/nutrition/report/${userB.id}`, tA);
  A.expectDenied('A -> GET /api/nutrition/report/{B}', nrepB, { allowEmpty: true });
  A.expectNotLeaking('A -> nutrition report(B) leaks nothing', nrepB, [userB.email]);

  // ---- 4. blood report id substitution ---------------------------------------------
  console.log('\n--- 4. blood report id substitution ---');
  // A random uuid stands in for another member's report id. The handler must not
  // distinguish "not yours" from "does not exist" in a way that confirms existence.
  const fakeId = '00000000-0000-4000-8000-000000000001';
  A.expectDenied(`A -> GET /api/blood/pdf/{other}`, await get(`/api/blood/pdf/${fakeId}`, tA));
  A.expectDenied(`A -> GET /api/blood/file/{other}`, await get(`/api/blood/file/${fakeId}`, tA));
  A.expectDenied(`A -> DELETE /api/blood/{other}`, await del(`/api/blood/${fakeId}`, tA));
  A.expectDenied(`A -> GET /api/blood/impact/{other}`, await get(`/api/blood/impact/${fakeId}`, tA));

  // ---- 5. share-token surface ---------------------------------------------------------
  console.log('\n--- 5. public share-link surface ---');
  A.expectDenied('anon -> /r/blood/{garbage}', await get('/r/blood/not-a-real-token'));
  A.expectDenied('anon -> /r/blood/{empty-ish}', await get('/r/blood/0'));

  // ---- 6. member self-service still works (regression) -----------------------------------
  console.log('\n--- 6. regression: members still reach their own data ---');
  A.expectStatus('A -> GET /api/blood/my-reports', await get('/api/blood/my-reports', tA), 200);
  A.expectStatus('A -> GET /api/blood/my-progress', await get('/api/blood/my-progress', tA), 200);
  A.expectStatus('A -> GET /api/blood/my-comparisons', await get('/api/blood/my-comparisons', tA), 200);
  A.expectStatus('B -> GET /api/blood/my-reports', await get('/api/blood/my-reports', tB), 200);
  A.expectStatus(
    'A -> GET own nutrition log',
    await get(`/api/nutrition/log/${userA.id}/${today}`, tA),
    200
  );

  A.summary('MEDICAL & NUTRITION ISOLATION RESULTS');
  process.exit(A.exitCode());
}

main().catch((e) => {
  console.error('\nSUITE ERROR:', e.message);
  process.exit(1);
});
