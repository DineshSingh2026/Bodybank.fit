'use strict';

/**
 * Coach event taxonomy — the single source of truth for what events exist and how
 * "loud" each one is by default. Pure data + pure helpers (no DB, no LLM) so the
 * Decision Engine and unit tests can depend on it freely.
 *
 * Every event has:
 *   category      — reinforce | nudge | reengage | ritual | conversational
 *   base_priority — 0..40, the raw importance before the value score modulates it
 *   dedup_ttl     — ms; a same-key event inside this window is dropped at ingest
 *   decay_hours   — how long until the event is "stale" (freshness → 0)
 *   batchable     — may be folded into a daily/weekly summary instead of sent alone
 *   deferrable    — the engine may hold it for a better send slot / to coalesce
 *   template      — which message template renders it (see prompts/templates)
 */

const CATEGORY = {
  REINFORCE: 'reinforce',
  NUDGE: 'nudge',
  REENGAGE: 'reengage',
  RITUAL: 'ritual',
  CONVERSATIONAL: 'conversational'
};

const HOUR = 60 * 60 * 1000;

// eslint-disable-next-line no-unused-vars
const T = (category, base_priority, dedup_ttl, decay_hours, opts = {}) => ({
  category,
  base_priority,
  dedup_ttl,
  decay_hours,
  batchable: opts.batchable !== undefined ? opts.batchable : (category === CATEGORY.REINFORCE),
  deferrable: opts.deferrable !== undefined ? opts.deferrable : true,
  template: opts.template || 'generic'
});

const EVENT_META = {
  // ── Positive / reinforce (mostly batched — over-praising feels robotic) ──
  WORKOUT_COMPLETED:    T(CATEGORY.REINFORCE, 18, 6 * HOUR, 12, { template: 'reinforce' }),
  MEAL_LOGGED:          T(CATEGORY.REINFORCE, 10, 3 * HOUR, 8,  { template: 'reinforce' }),
  PROTEIN_GOAL_HIT:     T(CATEGORY.REINFORCE, 20, 12 * HOUR, 20, { template: 'reinforce' }),
  WATER_GOAL_HIT:       T(CATEGORY.REINFORCE, 12, 12 * HOUR, 20, { template: 'reinforce' }),
  NEW_PR:               T(CATEGORY.REINFORCE, 34, 0, 48,       { template: 'reinforce', batchable: false }),
  STREAK_MILESTONE:     T(CATEGORY.REINFORCE, 30, 0, 48,       { template: 'reinforce', batchable: false }),
  GOAL_ACHIEVED:        T(CATEGORY.REINFORCE, 38, 0, 72,       { template: 'reinforce', batchable: false }),
  CONSISTENCY_IMPROVED: T(CATEGORY.REINFORCE, 22, 24 * HOUR, 48, { template: 'reinforce' }),
  WEIGHT_GOAL_PROGRESS: T(CATEGORY.REINFORCE, 24, 24 * HOUR, 48, { template: 'reinforce' }),

  // ── Corrective / nudge (never guilt; rate-limit hard) ──
  WORKOUT_MISSED:       T(CATEGORY.NUDGE, 22, 20 * HOUR, 24, { template: 'nudge' }),
  PROTEIN_DEFICIT:      T(CATEGORY.NUDGE, 24, 8 * HOUR, 8,   { template: 'proteinNudge' }),
  CALORIE_EXCESS:       T(CATEGORY.NUDGE, 20, 12 * HOUR, 12, { template: 'nudge' }),
  HYDRATION_LOW:        T(CATEGORY.NUDGE, 16, 10 * HOUR, 8,  { template: 'nudge' }),
  SLEEP_LOW:            T(CATEGORY.NUDGE, 20, 20 * HOUR, 20, { template: 'nudge' }),
  PROGRESS_PLATEAU:     T(CATEGORY.NUDGE, 28, 48 * HOUR, 96, { template: 'plateau' }),
  RAPID_WEIGHT_LOSS:    T(CATEGORY.NUDGE, 34, 24 * HOUR, 48, { template: 'nudge', deferrable: false }),
  RAPID_WEIGHT_GAIN:    T(CATEGORY.NUDGE, 30, 24 * HOUR, 48, { template: 'nudge' }),

  // ── Lifecycle / re-engage (comeback = highest leverage) ──
  NO_ACTIVITY_1D:       T(CATEGORY.REENGAGE, 8,  24 * HOUR, 36, { template: 'reengage' }),
  NO_ACTIVITY_3D:       T(CATEGORY.REENGAGE, 24, 24 * HOUR, 72, { template: 'reengage' }),
  NO_ACTIVITY_7D:       T(CATEGORY.REENGAGE, 30, 48 * HOUR, 120, { template: 'reengage' }),
  COMEBACK:             T(CATEGORY.REENGAGE, 32, 12 * HOUR, 24, { template: 'comeback', batchable: false }),
  BIRTHDAY:             T(CATEGORY.REENGAGE, 26, 24 * HOUR, 24, { template: 'reengage', batchable: false }),

  // ── Scheduled / ritual (time-driven, from the scheduler) ──
  MORNING_CHECKIN:      T(CATEGORY.RITUAL, 14, 12 * HOUR, 6,  { template: 'ritual' }),
  EVENING_REFLECTION:   T(CATEGORY.RITUAL, 16, 12 * HOUR, 6,  { template: 'ritual' }),
  DAILY_MOTIVATION:     T(CATEGORY.RITUAL, 10, 12 * HOUR, 12, { template: 'ritual' }),
  WEEKLY_SUMMARY:       T(CATEGORY.RITUAL, 26, 24 * HOUR, 48, { template: 'weeklySummary', batchable: false }),
  COACH_CHECKIN:        T(CATEGORY.RITUAL, 18, 24 * HOUR, 24, { template: 'ritual' }),

  // ── Conversational (a user reply — always answered, bypasses budget) ──
  USER_REPLIED:         T(CATEGORY.CONVERSATIONAL, 40, 0, 2, { template: 'reply', batchable: false, deferrable: false })
};

/** Weekly/monthly reports and user replies do NOT count against the daily budget. */
const BUDGET_EXEMPT = new Set(['WEEKLY_SUMMARY', 'MONTHLY_SUMMARY', 'USER_REPLIED']);

function metaFor(type) {
  return EVENT_META[type] || null;
}

function isKnownEvent(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_META, type);
}

module.exports = { CATEGORY, EVENT_META, BUDGET_EXEMPT, metaFor, isKnownEvent, HOUR };
