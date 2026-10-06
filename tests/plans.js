/**
 * Unit test: membership plans (Core · Guided · Tribe Elite) and the per-request gate.
 * Run: node tests/plans.js
 *
 * NO NETWORK. NO DATABASE. services/plans.js is pure apart from the gate's one
 * users lookup, which is stubbed here.
 *
 * What this guards:
 *  - a Core member cannot reach a Guided or Tribe Elite endpoint, and gets a 403
 *    the app recognises (upgrade_required) rather than a generic error;
 *  - staff are never gated, whatever their plan column says;
 *  - an expired or locked member loses paid features on the next request, not at
 *    their next login (the JWT lives 7 days);
 *  - legacy rows with no plan_tier resolve to Tribe Elite (every member at rollout);
 *  - the member-facing payload carries no prices (it reaches the native apps).
 */

const plans = require('../services/plans');

const failures = [];
let checks = 0;
function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}
function eq(a, b, msg) { return assert(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const DAY = 86400000;
const future = new Date(Date.now() + 30 * DAY).toISOString();
const past = new Date(Date.now() - DAY).toISOString();

// --- tiers and features -------------------------------------------------------
eq(plans.tierOf({ plan_tier: null }), 'tribe_elite', 'legacy NULL tier resolves to Tribe Elite');
eq(plans.tierOf({ plan_tier: 'bogus' }), 'tribe_elite', 'unknown tier resolves to Tribe Elite');
eq(plans.normalizeTier('Tribe Elite'), 'tribe_elite', 'display name normalises');
eq(plans.normalizeTier('elite'), 'tribe_elite', 'short alias normalises');
eq(plans.normalizeTier('platinum'), null, 'unknown tier is rejected by normalizeTier');

const core = plans.featuresForTier('core');
const guided = plans.featuresForTier('guided');
const elite = plans.featuresForTier('tribe_elite');
assert(core.includes('meal_snap') && core.includes('sunday_review'), 'Core has the app basics');
assert(!core.includes('blood_reports') && !core.includes('ai_trainer') && !core.includes('coach_chat'), 'Core has no Guided features');
assert(guided.includes('blood_reports') && guided.includes('ai_trainer') && guided.includes('workout_program') && guided.includes('coach_chat'), 'Guided has its features');
assert(!guided.includes('wearables'), 'Guided has no Tribe Elite features');
assert(core.every((f) => guided.includes(f)), 'Guided includes everything in Core');
assert(guided.every((f) => elite.includes(f)), 'Tribe Elite includes everything in Guided');
assert(elite.includes('wearables') && elite.includes('lifestyle_management'), 'Tribe Elite has its features');
eq(plans.tierHasFeature('core', 'nonexistent'), false, 'unknown feature is never granted');

// --- membership state -----------------------------------------------------------
eq(plans.accessState({ subscription_status: 'active', access_expires_at: null }), 'active', 'NULL expiry is lifetime');
eq(plans.accessState({ subscription_status: 'active', access_expires_at: past }), 'expired', 'past expiry is expired');
eq(plans.accessState({ subscription_status: 'trialing', access_expires_at: future }), 'trialing', 'trial');
eq(plans.accessState({ subscription_status: 'canceled', access_expires_at: future }), 'canceled', 'locked');

const p1 = plans.planForUser({ plan_tier: 'guided', subscription_status: 'trialing', access_expires_at: future });
eq(p1.tier, 'guided', 'planForUser tier');
eq(p1.name, 'Guided', 'planForUser name');
eq(p1.trial, true, 'planForUser trial flag');
assert(p1.days_left >= 29 && p1.days_left <= 30, 'planForUser days_left');
eq(plans.planForUser({ plan_tier: 'tribe_elite', subscription_status: 'active', access_expires_at: past }).features.length, 0, 'expired member gets no features');
assert(!/amount|price|₹/i.test(JSON.stringify(p1)), 'member plan payload carries no prices');
assert(!/amount|price|₹/i.test(JSON.stringify(plans.featureCatalog())), 'feature catalog carries no prices');

// --- public catalog (website) -------------------------------------------------------
const cat = plans.publicCatalog();
eq(cat.map((c) => c.tier).join(','), 'core,guided,tribe_elite', 'catalog order');
eq(cat[0].prices[0].amount, 3499, 'Core 12-month price');
eq(cat[1].prices.map((p) => p.amount).join(','), '2999,9999', 'Guided prices');
eq(cat[2].prices.map((p) => p.amount).join(','), '18000,72000', 'Tribe Elite prices');
assert(cat.every((c) => c.features.length > 0), 'every plan lists what it adds');
assert(!/scor/i.test(JSON.stringify(cat)), 'no member-facing "score" wording in the catalog (meal score was removed)');

// --- trial tier ---------------------------------------------------------------------
delete process.env.TRIAL_PLAN_TIER;
eq(plans.trialTier(), 'guided', 'default trial tier');
process.env.TRIAL_PLAN_TIER = 'nonsense';
eq(plans.trialTier(), 'guided', 'invalid TRIAL_PLAN_TIER falls back to Guided');
process.env.TRIAL_PLAN_TIER = 'tribe_elite';
eq(plans.trialTier(), 'tribe_elite', 'TRIAL_PLAN_TIER override');
delete process.env.TRIAL_PLAN_TIER;

// --- the gate -------------------------------------------------------------------------
const users = {
  core: { id: 'core', role: 'user', plan_tier: 'core', subscription_status: 'active', access_expires_at: future },
  guided: { id: 'guided', role: 'user', plan_tier: 'guided', subscription_status: 'active', access_expires_at: future },
  legacy: { id: 'legacy', role: 'user', plan_tier: null, subscription_status: 'active', access_expires_at: null },
  expired: { id: 'expired', role: 'user', plan_tier: 'tribe_elite', subscription_status: 'active', access_expires_at: past },
  locked: { id: 'locked', role: 'user', plan_tier: 'tribe_elite', subscription_status: 'canceled', access_expires_at: future }
};
let lookups = 0;
const gate = plans.createPlanGate({
  queryOne: async (sql, params) => { lookups += 1; return users[params[0]] ? Object.assign({}, users[params[0]]) : null; },
  verifyToken: (req, res, next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: h.slice(7), role: h.slice(7) === 'admin' ? 'admin' : 'user' };
    return next();
  }
});

function run(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, next: false }); }
    };
    Promise.resolve(mw(req, res, () => resolve({ status: 200, next: true }))).catch((e) => resolve({ status: 'threw', body: String(e) }));
  });
}
const asUser = (id, role) => ({ user: { id, role: role || 'user' }, headers: {}, body: {}, query: {} });

(async () => {
  const blood = gate.requireFeature('blood_reports');
  const wear = gate.requireFeature('wearables');

  let r = await run(blood, asUser('core'));
  eq(r.status, 403, 'Core member is refused blood uploads');
  eq(r.body && r.body.error, 'upgrade_required', 'refusal is upgrade_required');
  eq(r.body && r.body.required_tier, 'guided', 'refusal names the plan that includes it');

  r = await run(blood, asUser('guided'));
  eq(r.next, true, 'Guided member passes blood gate');
  r = await run(wear, asUser('guided'));
  eq(r.status, 403, 'Guided member is refused wearables');

  r = await run(wear, asUser('legacy'));
  eq(r.next, true, 'legacy (NULL tier) member keeps Tribe Elite access');

  r = await run(blood, asUser('expired'));
  eq(r.body && r.body.error, 'subscription_expired', 'expired member is refused on the next request');
  r = await run(blood, asUser('locked'));
  eq(r.body && r.body.error, 'subscription_expired', 'locked member is refused');

  const before = lookups;
  r = await run(blood, asUser('admin', 'admin'));
  eq(r.next, true, 'staff are never gated');
  eq(lookups, before, 'staff cost no plan lookup');

  // Cache + invalidation: a plan change applies once invalidated.
  await run(blood, asUser('core'));
  users.core.plan_tier = 'guided';
  r = await run(blood, asUser('core'));
  eq(r.status, 403, 'cached plan is used within the cache window');
  gate.invalidate('core');
  r = await run(blood, asUser('core'));
  eq(r.next, true, 'plan change applies after invalidate()');
  users.core.plan_tier = 'core';
  gate.invalidate('core');

  // Mount gate: skip list, and no-token requests left to the router's own 401.
  const mount = gate.gateMembers('wearables', (req) => req.path === '/connection');
  r = await run(mount, { headers: { authorization: 'Bearer core' }, path: '/readiness', body: {}, query: {} });
  eq(r.status, 403, 'mount gate refuses a Core member');
  r = await run(mount, { headers: { authorization: 'Bearer core' }, path: '/connection', body: {}, query: {} });
  eq(r.next, true, 'mount gate honours its skip list');
  r = await run(mount, { headers: {}, path: '/readiness', body: {}, query: {} });
  eq(r.next, true, 'mount gate leaves tokenless requests to the router');

  let threw = false;
  try { gate.requireFeature('typo_feature'); } catch (e) { threw = true; }
  assert(threw, 'gating an unknown feature name fails loudly at boot');

  if (failures.length) {
    console.error(`plans: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`plans: all ${checks} checks passed`);
})();
