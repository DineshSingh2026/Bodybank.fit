'use strict';

/**
 * The Decision Engine — "should I speak, when, and how loud?" Deterministic gates first
 * (cheap, debuggable, every decision explainable); the LLM is only an optional tie-break
 * for genuinely ambiguous mid-score events. First failing gate wins.
 *
 * Returns one of:
 *   { action: 'send' }
 *   { action: 'suppress', reason }
 *   { action: 'defer',   reason, at: Date }
 *   { action: 'batch',   reason }
 * plus { score } for the decision inspector.
 */

const { metaFor, BUDGET_EXEMPT } = require('./taxonomy');
const { valueScore } = require('./valueScore');
const { tzNow, inQuietHours } = require('./util');

const DECISIONS = { SEND: 'send', SUPPRESS: 'suppress', DEFER: 'defer', BATCH: 'batch' };

function isMutedCategory(settings, category) {
  const muted = Array.isArray(settings.muted_categories) ? settings.muted_categories : [];
  return muted.includes(category);
}

/** Remaining proactive-message budget for the user today (in their tz). */
async function remainingBudget(ctx, userId, settings) {
  const ymd = tzNow(settings.timezone).ymd;
  const row = await ctx.queryOne(
    'SELECT spent, borrowed FROM coach_budget_ledger WHERE user_id = ? AND ymd = ?::date',
    [userId, ymd]
  );
  const spent = row ? Number(row.spent) || 0 : 0;
  const budget = Math.max(0, Number(settings.daily_budget) || 0);
  return budget - spent;
}

/** Compute the best send slot: prefer the user's learned active hour if we can wait. */
function bestSendSlot(meta, settings, profile, nowDate) {
  // Deferrable, low-urgency events that arrive at an odd hour → hold to the active hour.
  if (!meta.deferrable) return { waitMinutes: 0 };
  const tz = settings.timezone;
  const nowParts = tzNow(tz, nowDate);
  const activeHour = profile && profile.typical_active_hour != null ? Number(profile.typical_active_hour) : null;
  if (activeHour == null) return { waitMinutes: 0 };
  // If we're already within a couple hours of the active window, just send.
  if (Math.abs(nowParts.hour - activeHour) <= 2) return { waitMinutes: 0 };
  // Otherwise wait until the active hour today (or tomorrow if it has passed).
  let waitHours = activeHour - nowParts.hour;
  if (waitHours <= 0) waitHours += 24;
  // Cap the hold so we never sit on a message for a full day.
  const waitMinutes = Math.min(waitHours * 60, 6 * 60);
  const at = new Date((nowDate ? nowDate.getTime() : Date.now()) + waitMinutes * 60000);
  return { waitMinutes, at };
}

/**
 * @param {object} ctx
 * @param {object} event   coach_events row (type, created_at, category)
 * @param {object} params  { settings, profile, recentTypes, now, llmTieBreak? }
 */
async function decide(ctx, event, params = {}) {
  const settings = params.settings;
  const profile = params.profile || {};
  const recentTypes = params.recentTypes || [];
  const now = params.now || Date.now();
  const nowDate = new Date(now);
  const meta = metaFor(event.type);
  if (!meta) return { action: DECISIONS.SUPPRESS, reason: 'unknown_event', score: 0 };

  // ── HARD GATES (deterministic) ──
  if (!settings.coach_enabled) return { action: DECISIONS.SUPPRESS, reason: 'coach_off', score: 0 };
  if (settings.paused_until && new Date(settings.paused_until).getTime() > now) {
    return { action: DECISIONS.SUPPRESS, reason: 'paused', score: 0 };
  }
  if (isMutedCategory(settings, meta.category)) return { action: DECISIONS.SUPPRESS, reason: 'category_muted', score: 0 };

  // Stale? (aged past its decay window)
  const ageMs = now - new Date(event.created_at).getTime();
  if (ageMs > meta.decay_hours * 3600 * 1000) return { action: DECISIONS.SUPPRESS, reason: 'stale', score: 0 };

  // Quiet hours → defer to the end of quiet window (don't drop).
  const nowParts = tzNow(settings.timezone, nowDate);
  if (inQuietHours(nowParts.hhmm, settings.quiet_start, settings.quiet_end)) {
    const at = nextQuietEnd(settings, nowDate);
    return { action: DECISIONS.DEFER, reason: 'quiet_hours', at, score: 0 };
  }

  // Conversational replies bypass everything below (handled synchronously elsewhere,
  // but if one reaches the worker, always send).
  if (event.category === 'conversational') return { action: DECISIONS.SEND, score: 100, bypassBudget: true };

  // ── VALUE SCORE ──
  const score = valueScore(
    { type: event.type, created_at: new Date(event.created_at).getTime() },
    profile, recentTypes, now
  );
  if (score < (Number(settings.min_send_threshold) || 35)) {
    return { action: meta.batchable ? DECISIONS.BATCH : DECISIONS.SUPPRESS, reason: 'low_value', score };
  }

  // ── BUDGET (the anti-fatigue core) ──
  if (!BUDGET_EXEMPT.has(event.type)) {
    const remaining = await remainingBudget(ctx, event.user_id, settings);
    if (remaining <= 0) {
      return { action: meta.batchable ? DECISIONS.BATCH : DECISIONS.SUPPRESS, reason: 'budget_exceeded', score };
    }
  }

  // ── TIMING — would waiting produce a better moment? ──
  const slot = bestSendSlot(meta, settings, profile, nowDate);
  if (slot.waitMinutes > 0 && meta.deferrable) {
    return { action: DECISIONS.DEFER, reason: 'better_slot', at: slot.at, score };
  }

  // ── OPTIONAL LLM TIE-BREAK for ambiguous mid-score events ──
  if (params.llmTieBreak && score >= 40 && score <= 60) {
    const verdict = await params.llmTieBreak(event, { settings, profile, score }).catch(() => ({ send: true }));
    if (verdict && verdict.send === false) {
      return { action: DECISIONS.SUPPRESS, reason: 'llm_declined', score };
    }
  }

  return { action: DECISIONS.SEND, score };
}

/** The next moment quiet hours end, as a Date. */
function nextQuietEnd(settings, nowDate) {
  const tz = settings.timezone;
  const parts = tzNow(tz, nowDate);
  const [eh, em] = String(settings.quiet_end || '07:30').split(':').map((x) => parseInt(x, 10));
  let waitH = (eh - parts.hour);
  let waitM = (em - parts.minute);
  let total = waitH * 60 + waitM;
  if (total <= 0) total += 24 * 60; // quiet end is tomorrow
  return new Date((nowDate ? nowDate.getTime() : Date.now()) + total * 60000);
}

module.exports = { decide, remainingBudget, DECISIONS, bestSendSlot };
