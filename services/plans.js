'use strict';

// ── Membership plans: Core · Guided · Tribe Elite ────────────────────────────
//
// One source of truth for what each plan includes. The server enforces it
// (requireFeature / gateMembers below); the member app only mirrors it to lock
// screens, so a hand-edited client can never unlock a paid feature.
//
// Store policy (Apple 3.1.1 / Google Play Payments): prices and purchase links
// are for the website only. The native apps show which plan a member is on and
// which plan includes a locked feature — never a price, a buy button, or a link
// out to a payment page. See public/js/bb-plans.js (bbPlanIsNativeApp).

const PLAN_TIERS = ['core', 'guided', 'tribe_elite'];

// Legacy rows (created before plan tiers existed) have plan_tier NULL. The owner
// placed every existing member on Tribe Elite, so NULL resolves there and nobody
// loses a feature they already had; staff downgrade members individually.
const LEGACY_TIER = 'tribe_elite';

// Tier a new sign-up's free trial runs on.
function trialTier() {
  const t = String(process.env.TRIAL_PLAN_TIER || 'guided').trim().toLowerCase();
  return PLAN_TIERS.includes(t) ? t : 'guided';
}

const FEATURES = {
  // Core — every plan
  meal_snap:          { tier: 'core',        label: 'AI meal snap + macros' },
  daily_checkins:     { tier: 'core',        label: 'Daily check-ins & streaks' },
  sunday_review:      { tier: 'core',        label: 'Sunday reviews' },
  progress_dashboard: { tier: 'core',        label: 'Progress dashboards' },
  energy_balance:     { tier: 'core',        label: 'Energy balance tracking' },
  // Guided
  blood_reports:      { tier: 'guided',      label: 'Blood report analysis' },
  nutrition_advice:   { tier: 'guided',      label: 'In-depth nutritional advice' },
  workout_program:    { tier: 'guided',      label: 'Custom workout program' },
  ai_trainer:         { tier: 'guided',      label: 'AI Trainer' },
  coach_chat:         { tier: 'guided',      label: 'Chat with your coach' },
  // Tribe Elite
  lifestyle_management: { tier: 'tribe_elite', label: 'Complete lifestyle management' },
  doctor_nutritionist:  { tier: 'tribe_elite', label: 'Doctor and sports nutritionist' },
  care_team:            { tier: 'tribe_elite', label: 'Dedicated group of people to monitor, remind and assist' },
  // Smart-scale uploads stay in every plan: they feed the Core Sunday review.
  wearables:          { tier: 'tribe_elite', label: 'Wearable insights (Whoop, Apple Health & more)' },
  progress_reports:   { tier: 'tribe_elite', label: 'Progress reports' }
};

// Display copy + prices. Prices are shown on the website only (see header note).
// amount is in rupees; compare_at is the struck-through reference price.
const PLAN_CATALOG = {
  core: {
    tier: 'core',
    name: 'Core',
    tagline: 'The full BodyBank app, on your own.',
    prices: [
      // TEMPORARY (owner's live payment test, 2026-10-06): Core is ₹50.
      // The real price is amount: 3499, compare_at: 5999 — restore it after the test.
      { term: '12m', months: 12, label: '12 months', amount: 50 }
    ]
  },
  guided: {
    tier: 'guided',
    name: 'Guided',
    tagline: 'The app plus expert guidance from your coach.',
    highlight: 'Most popular',
    prices: [
      { term: '1m', months: 1, label: 'Monthly', amount: 2999, compare_at: 4999 },
      { term: '4m', months: 4, label: '4 months', amount: 9999, compare_at: 15999, note: 'One full blood-report cycle' }
    ]
  },
  tribe_elite: {
    tier: 'tribe_elite',
    name: 'Tribe Elite',
    tagline: 'Everything, plus complete lifestyle management.',
    prices: [
      { term: '1m', months: 1, label: 'Monthly', amount: 18000, compare_at: 25000 },
      { term: '4m', months: 4, label: '4 months', amount: 72000 }
    ]
  }
};

function normalizeTier(t) {
  const s = String(t == null ? '' : t).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'elite' || s === 'tribe') return 'tribe_elite';
  return PLAN_TIERS.includes(s) ? s : null;
}

function tierRank(t) {
  return PLAN_TIERS.indexOf(normalizeTier(t));
}

// Effective tier for a users row. Unknown / NULL → legacy tier.
function tierOf(user) {
  return normalizeTier(user && user.plan_tier) || LEGACY_TIER;
}

function tierName(t) {
  const n = normalizeTier(t);
  return n ? PLAN_CATALOG[n].name : PLAN_CATALOG[LEGACY_TIER].name;
}

function featuresForTier(t) {
  const rank = tierRank(normalizeTier(t) || LEGACY_TIER);
  return Object.keys(FEATURES).filter((f) => tierRank(FEATURES[f].tier) <= rank);
}

function tierHasFeature(t, feature) {
  const f = FEATURES[feature];
  if (!f) return false;
  return tierRank(normalizeTier(t) || LEGACY_TIER) >= tierRank(f.tier);
}

// Lowest plan that includes a feature (what the lock screen names).
function requiredTierFor(feature) {
  return FEATURES[feature] ? FEATURES[feature].tier : null;
}

// Membership state, mirroring computeMembershipState in server.js.
function accessState(user) {
  const status = String((user && user.subscription_status) || 'active').toLowerCase();
  if (status === 'canceled') return 'canceled';
  const raw = user && user.access_expires_at;
  if (raw) {
    const exp = new Date(raw).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) return 'expired';
  }
  return status === 'trialing' ? 'trialing' : (status === 'expired' ? 'expired' : 'active');
}

// What the member app receives about its own plan. No prices on purpose — this
// payload also reaches the iOS / Android apps.
function planForUser(user) {
  const tier = tierOf(user);
  const state = accessState(user);
  const exp = user && user.access_expires_at ? new Date(user.access_expires_at) : null;
  const expMs = exp && Number.isFinite(exp.getTime()) ? exp.getTime() : null;
  return {
    tier,
    name: PLAN_CATALOG[tier].name,
    state,
    trial: state === 'trialing',
    expires_at: expMs != null ? new Date(expMs).toISOString() : null,
    days_left: expMs != null ? Math.ceil((expMs - Date.now()) / 86400000) : null,
    features: (state === 'expired' || state === 'canceled') ? [] : featuresForTier(tier)
  };
}

// Public catalog for the website pricing section and the admin Activate picker.
function publicCatalog() {
  return PLAN_TIERS.map((t) => {
    const p = PLAN_CATALOG[t];
    return {
      tier: t,
      name: p.name,
      tagline: p.tagline,
      highlight: p.highlight || null,
      prices: p.prices.filter((x) => !x.hidden).map((x) => Object.assign({}, x)),
      features: Object.keys(FEATURES)
        .filter((f) => FEATURES[f].tier === t)
        .map((f) => ({ key: f, label: FEATURES[f].label }))
    };
  });
}

// Feature → { tier, label } and tier → name, for the member app's lock screens.
// No prices (this reaches the native apps).
function featureCatalog() {
  const features = {};
  Object.keys(FEATURES).forEach((f) => { features[f] = { tier: FEATURES[f].tier, label: FEATURES[f].label }; });
  const tiers = {};
  PLAN_TIERS.forEach((t) => { tiers[t] = PLAN_CATALOG[t].name; });
  return { features, tiers, order: PLAN_TIERS.slice() };
}

function upgradeRequiredBody(feature) {
  const tier = requiredTierFor(feature);
  const planName = tier ? PLAN_CATALOG[tier].name : 'a higher';
  return {
    error: 'upgrade_required',
    feature,
    required_tier: tier,
    required_plan: planName,
    message: `${FEATURES[feature] ? FEATURES[feature].label : 'This feature'} is part of the ${planName} plan.`
  };
}

/**
 * Per-request plan enforcement. Plan data is read from the DB (not the JWT) so a
 * change in the admin console applies within CACHE_MS, not at the next login.
 *
 * @param {{ queryOne: Function, verifyToken: Function }} deps
 */
function createPlanGate(deps) {
  const { queryOne, verifyToken } = deps;
  const CACHE_MS = 30 * 1000;
  const cache = new Map();

  async function loadUser(id) {
    const key = String(id);
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.row;
    const row = await queryOne(
      'SELECT id, role, plan_tier, subscription_status, access_expires_at FROM users WHERE id = ?',
      [id]
    );
    cache.set(key, { at: Date.now(), row: row || null });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return row || null;
  }

  function invalidate(id) {
    if (id == null) cache.clear();
    else cache.delete(String(id));
  }

  // Assumes req.user is already set (verifyToken ran). Staff are never gated.
  function requireFeature(feature) {
    if (!FEATURES[feature]) throw new Error('Unknown plan feature: ' + feature);
    return async function planFeatureGate(req, res, next) {
      try {
        if (!req.user || req.user.role !== 'user') return next();
        const row = await loadUser(req.user.id);
        if (!row) return res.status(401).json({ error: 'Authentication required' });
        if (row.role !== 'user') return next();
        const state = accessState(row);
        if (state === 'expired' || state === 'canceled') {
          return res.status(403).json({
            error: 'subscription_expired',
            message: 'Your access has ended. Message your coach on WhatsApp to renew and unlock your plan again.'
          });
        }
        if (!tierHasFeature(tierOf(row), feature)) {
          return res.status(403).json(upgradeRequiredBody(feature));
        }
        return next();
      } catch (e) {
        console.error('[plan gate]', feature, e.message);
        return res.status(500).json({ error: 'Could not check your plan. Please try again.' });
      }
    };
  }

  // For mounting in front of a router whose routes run their own verifyToken:
  // authenticates, then gates members only. `skip(req)` exempts paths (e.g. the
  // opt-out / delete-my-data routes, or scoped-token attachment downloads).
  function gateMembers(feature, skip) {
    const gate = requireFeature(feature);
    return function planMountGate(req, res, next) {
      if (typeof skip === 'function' && skip(req)) return next();
      const auth = req.headers && req.headers.authorization;
      const hasToken = (auth && auth.startsWith('Bearer ')) || (req.body && req.body.token) || (req.query && req.query.token);
      // No token: let the router's own verifyToken answer 401 in its usual shape.
      if (!hasToken) return next();
      return verifyToken(req, res, () => gate(req, res, next));
    };
  }

  return { requireFeature, gateMembers, invalidate, loadUser };
}

module.exports = {
  PLAN_TIERS,
  LEGACY_TIER,
  FEATURES,
  PLAN_CATALOG,
  trialTier,
  normalizeTier,
  tierOf,
  tierName,
  tierRank,
  featuresForTier,
  tierHasFeature,
  requiredTierFor,
  accessState,
  planForUser,
  publicCatalog,
  featureCatalog,
  upgradeRequiredBody,
  createPlanGate
};
