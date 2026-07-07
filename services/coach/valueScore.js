'use strict';

/**
 * The value score — a deterministic 0..100 estimate of how much a candidate message
 * is worth sending *right now*. Pure functions only (no DB, no LLM) so this is the
 * unit-tested heart of the Decision Engine.
 *
 *   value = base_priority          (0..40 from taxonomy, scaled ×2.5 → 0..100)
 *         × freshness              (1.0 → 0.0 as the event ages toward its decay)
 *         × user_fit               (weak spot ×1.3 ; strength ×0.7 ; else 1.0)
 *         × novelty                (topic touched in last 48h ×0.4 ; else 1.0)
 *         × engagement             (ignores recent msgs ×0.6 ; replies often ×1.2)
 */

const { metaFor, HOUR } = require('./taxonomy');

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** 1.0 for a brand-new event, decaying linearly to 0.0 at `decay_hours`. */
function freshness(ageMs, decayHours) {
  const decayMs = Math.max(1, (Number(decayHours) || 1) * HOUR);
  const age = Math.max(0, Number(ageMs) || 0);
  return clamp(1 - age / decayMs, 0, 1);
}

/**
 * Does this event hit a known weak spot (score higher) or a strength (score lower)?
 * `weakDimension` comes from the health score's biggest negative driver.
 */
function userFit(eventType, profile) {
  const weak = String((profile && profile.weak_dimension) || '').toLowerCase();
  const map = {
    PROTEIN_DEFICIT: 'protein',
    PROTEIN_GOAL_HIT: 'protein',
    HYDRATION_LOW: 'hydration',
    WATER_GOAL_HIT: 'hydration',
    SLEEP_LOW: 'sleep',
    WORKOUT_MISSED: 'workouts',
    WORKOUT_COMPLETED: 'workouts',
    MEAL_LOGGED: 'nutrition',
    CALORIE_EXCESS: 'nutrition'
  };
  const dim = map[eventType];
  if (!dim || !weak) return 1.0;
  if (dim === weak) return 1.3;        // their chronic weak spot → more relevant
  return 0.9;                          // a dimension they're already doing fine on
}

/** Anti-repetition guard *before* generation: did we recently talk about this topic? */
function novelty(eventType, recentTypes) {
  const list = Array.isArray(recentTypes) ? recentTypes : [];
  return list.includes(eventType) ? 0.4 : 1.0;
}

/** Reward users who engage; back off from users who ignore. */
function engagement(profile) {
  const e = profile && profile.engagement;
  if (e === 'high') return 1.2;
  if (e === 'low') return 0.6;
  return 1.0;
}

/**
 * @param {object} event    { type, created_at (ms epoch or Date/ISO) }
 * @param {object} profile  coach_user_profile-ish { weak_dimension, engagement }
 * @param {string[]} recentTypes  event types messaged about in the last ~48h
 * @param {number} now       ms epoch (injectable for tests)
 */
function valueScore(event, profile, recentTypes, now) {
  const meta = metaFor(event && event.type);
  if (!meta) return 0;
  const base = clamp(meta.base_priority, 0, 40) * 2.5; // → 0..100
  const createdMs = toMs(event.created_at, now);
  const age = Math.max(0, (Number(now) || Date.now()) - createdMs);
  const f = freshness(age, meta.decay_hours);
  const fit = userFit(event.type, profile);
  const nov = novelty(event.type, recentTypes);
  const eng = engagement(profile);
  return Math.round(clamp(base * f * fit * nov * eng, 0, 100));
}

function toMs(v, fallback) {
  if (v == null) return Number(fallback) || Date.now();
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : (Number(fallback) || Date.now());
}

module.exports = { valueScore, freshness, userFit, novelty, engagement, clamp };
