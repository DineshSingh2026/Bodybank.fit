'use strict';

/**
 * BodyBank — Signal service: the data layer and the visibility boundary.
 *
 * Two jobs, deliberately kept in one place:
 *
 *  1. LOAD  — gather everything the Signal engine needs from across the app (wearable
 *             readiness, Whoop workouts and journal, nutrition, daily check-ins, mind
 *             sessions, logged workouts, blood reports, bodyweight). Each read is
 *             independently try/caught, exactly like /api/me/home: one missing table or
 *             one slow query degrades that input to empty rather than failing the whole
 *             feature.
 *
 *  2. PROJECT — enforce who may see what. This is the security boundary for the whole
 *             feature and it is a WHITELIST, never a delete-list: projectForMember()
 *             constructs a fresh object containing only named fields, so a field added
 *             to the engine tomorrow cannot leak to a member by being forgotten here.
 *
 * What a member may never receive from this service:
 *   - any absolute physiological reading their Whoop app already shows them
 *     (HRV in ms, resting HR in bpm, SpO2, respiratory rate, strain, sleep stages)
 *   - risk flags — "possible illness" / "overreaching" is a coach's conversation
 *   - statistics: n per test, effect sizes, p, q, rejected hypotheses
 *   - the daily audit table
 *
 * What a member DOES receive: a verdict, the reason in their own words, one action, the
 * laws their own data has earned, and the bloodwork connection. That is the product.
 */

const readinessService = require('./readinessService');
const { buildSignal } = require('./signalEngine');
const { buildBloodBridge } = require('./bloodBridge');
const { todayYmdInTz, STREAK_TZ, addCalendarDaysYmd } = require('../streakService');

const PROVIDER = 'whoop';

/** Correlation needs history: 90 days is the default, a year the ceiling. */
const DEFAULT_DAYS = 90;
const MIN_DAYS = 14;
const MAX_DAYS = 365;

function clampDays(v) {
  const n = parseInt(String(v == null ? '' : v), 10);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, n));
}

function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Run a read, and turn any failure into an empty result plus a named note. */
async function safe(label, notes, fn, fallback) {
  try {
    const r = await fn();
    return r == null ? fallback : r;
  } catch (e) {
    console.warn(`[signal] ${label}:`, e && e.message);
    notes.push(label);
    return fallback;
  }
}

/** The member's own today, so a directive is never a day out for an overseas client. */
async function resolveToday(db, userId) {
  let tz = STREAK_TZ;
  try {
    const u = await db.queryOne('SELECT timezone FROM users WHERE id = ?', [userId]);
    if (u && u.timezone) tz = u.timezone;
  } catch (_) { /* fall through to the default zone */ }
  return todayYmdInTz(tz) || new Date().toISOString().slice(0, 10);
}

/** Most recent known bodyweight, from whichever source logged it last. */
async function resolveWeightKg(db, userId, notes) {
  const candidates = [];
  await safe('weight_logs', notes, async () => {
    const r = await db.queryOne(
      'SELECT weight_kg AS kg, created_at AS at FROM weight_logs WHERE user_id = ? AND weight_kg IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    if (r && num(r.kg)) candidates.push({ kg: num(r.kg), at: ymd(r.at) || '' });
    return true;
  }, null);
  await safe('body_snapshots_weight', notes, async () => {
    const r = await db.queryOne(
      'SELECT bodyweight_kg AS kg, snapshot_date AS at FROM body_snapshots WHERE user_id = ? AND bodyweight_kg IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1',
      [userId]
    );
    if (r && num(r.kg)) candidates.push({ kg: num(r.kg), at: ymd(r.at) || String(r.at || '').slice(0, 10) });
    return true;
  }, null);
  if (!candidates.length) return null;
  candidates.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return candidates[0].kg;
}

/* ─────────────────────────────── loading ─────────────────────────────── */

/**
 * Everything the engine needs, for one member, over one window.
 * @returns {Promise<object>} always resolves; failed reads become empty arrays.
 */
async function loadSignalInputs(db, opts) {
  const userId = String((opts && opts.userId) || '');
  const days = clampDays(opts && opts.days);
  const notes = [];
  const today = (opts && opts.today) || await resolveToday(db, userId);
  const to = today;
  const from = addCalendarDaysYmd(to, -(days - 1)) || to;

  const [readiness, whoopWorkouts, journal, nutrition, checkins, mindDates, workoutDates, reports, weightKg, profile] = await Promise.all([
    safe('readiness', notes, () => readinessService.getReadinessRange(db, { userId, from, to }), []),
    safe('whoop_workouts', notes, () => readinessService.getWorkoutsRange(db, { userId, provider: PROVIDER, from, to, limit: 2000 }), []),
    safe('journal', notes, () => readinessService.getJournalRange(db, { userId, provider: PROVIDER, from, to, limit: 5000 }), []),
    safe('nutrition', notes, () => db.queryAll(
      `SELECT stat_date, total_calories, total_protein, total_carbs, total_fat, total_fiber,
              meal_quality_score, energy_difference, energy_balance_est, meals_logged
         FROM nutrition_daily_stats
        WHERE user_id = ? AND stat_date BETWEEN ?::date AND ?::date
        ORDER BY stat_date ASC`,
      [userId, from, to]
    ), []),
    safe('checkins', notes, () => db.queryAll(
      `SELECT checkin_date, steps, water_ml, protein_g, sleep_hours, is_freeze
         FROM daily_checkins
        WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date
        ORDER BY checkin_date ASC`,
      [userId, from, to]
    ), []),
    safe('mind', notes, () => db.queryAll(
      `SELECT DISTINCT checkin_date
         FROM mind_checkins
        WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date`,
      [userId, from, to]
    ), []),
    safe('workout_logs', notes, () => db.queryAll(
      `SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d
         FROM workout_logs
        WHERE user_id = ? AND created_at >= ?::timestamp AND created_at < (?::date + INTERVAL '1 day')`,
      [userId, from, to]
    ), []),
    // Blood reports are NOT limited to the window: the whole point of the bridge is to
    // reach back to a draw that happened months ago. Only reports whose extraction
    // succeeded carry markers, so the rest are filtered out here rather than parsed.
    safe('blood_reports', notes, () => db.queryAll(
      `SELECT id, report_date, created_at, extracted_blood_data
         FROM blood_analysis_reports
        WHERE user_id = ? AND extracted_blood_data IS NOT NULL
        ORDER BY COALESCE(report_date, created_at::date) ASC
        LIMIT 40`,
      [userId]
    ), []),
    resolveWeightKg(db, userId, notes),
    safe('profile', notes, () => db.queryOne('SELECT first_name, goal_type FROM users WHERE id = ?', [userId]), null)
  ]);

  return {
    userId,
    from,
    to,
    today,
    days,
    readiness: readiness || [],
    whoopWorkouts: whoopWorkouts || [],
    journal: journal || [],
    nutrition: (nutrition || []).map((r) => ({ ...r, date: ymd(r.stat_date) })),
    checkins: (checkins || []).map((r) => ({ ...r, date: ymd(r.checkin_date) })),
    mindDates: (mindDates || []).map((r) => ymd(r.checkin_date)).filter(Boolean),
    workoutDates: (workoutDates || []).map((r) => ymd(r.d)).filter(Boolean),
    reports: reports || [],
    profile: {
      firstName: (profile && profile.first_name) || '',
      goalType: (profile && profile.goal_type) || '',
      weightKg
    },
    loadNotes: notes
  };
}

/* ─────────────────────────────── projection ─────────────────────────────── */

/**
 * What the member is allowed to see. Built field by field from scratch.
 *
 * Every string that reaches this object has already been through the engine's template
 * layer, which expresses Whoop's headline readings as percentages and deltas against the
 * member's own baseline — never as the reading itself. That is the difference between
 * "your HRV is 12% below your normal" (ours) and "HRV 41ms" (theirs).
 */
function projectForMember(full, bridge) {
  const sig = full || {};
  const directive = sig.directive || null;
  const coverage = sig.coverage || {};
  const laws = Array.isArray(sig.laws) ? sig.laws : [];
  const levers = Array.isArray(sig.levers) ? sig.levers : [];
  const memberBlood = (bridge && Array.isArray(bridge.memberItems)) ? bridge.memberItems : [];

  const hasWearable = (coverage.wearableDays || 0) > 0;
  const pairsHave = coverage.usablePairs || 0;
  const pairsNeed = coverage.pairsNeeded || 14;

  return {
    ok: true,
    audience: 'member',
    window: { from: sig.window && sig.window.from, to: sig.window && sig.window.to, days: sig.window && sig.window.days },
    today: sig.today || null,
    hasData: hasWearable,

    directive: directive ? {
      code: directive.code,
      label: directive.label,
      tone: directive.tone,
      headline: directive.headline,
      reason: directive.reason,
      guidance: directive.guidance,
      confidence: directive.confidence,
      asOf: directive.asOf,
      isToday: directive.isToday,
      stalenessDays: directive.stalenessDays
    } : null,

    // The one action. The rest are available in the detail view but the home card only
    // ever shows this, because three "priorities" is zero priorities.
    lever: levers.length ? {
      title: levers[0].title,
      detail: levers[0].detail,
      evidence: levers[0].evidence,
      tier: levers[0].tier
    } : null,
    levers: levers.map((l) => ({ title: l.title, detail: l.detail, evidence: l.evidence, tier: l.tier })),

    // Statement and the number of the member's own days behind it — nothing else. The
    // day count is there because it is what makes the claim credible, and it is theirs.
    laws: laws.map((l) => ({ statement: l.statement, days: l.days })),

    blood: memberBlood.map((b) => ({
      kind: b.kind,
      marker: b.marker,
      statement: b.statement,
      why: b.why,
      reportDate: b.reportDate
    })),

    // Honest progress toward the first law, so an empty state is a countdown rather
    // than a dead end.
    progress: {
      daysWithData: coverage.wearableDays || 0,
      daysLogged: Math.max(coverage.nutritionDays || 0, coverage.checkinDays || 0),
      pairsHave,
      pairsNeed,
      lawsUnlocked: laws.length,
      needsMore: laws.length === 0 ? Math.max(0, pairsNeed - pairsHave) : 0
    },

    bloodPending: !!(bridge && bridge.reportsSeen === 1 && !memberBlood.length)
  };
}

/**
 * What a coach or an operator sees: everything, including what was rejected and why.
 * Read-only in both cases — nothing in this feature ever writes.
 */
function projectForStaff(full, bridge, extra) {
  const e = extra || {};
  return {
    ok: true,
    audience: e.audience || 'admin',
    window: full.window,
    today: full.today,
    coverage: full.coverage,
    baselines: full.baselines,
    directive: full.directive,
    levers: full.levers,
    laws: full.laws,
    findings: full.findings,
    flags: full.flags,
    diagnostics: full.diagnostics,
    // The per-day audit trail is ~250KB over a year and no panel renders it, so it is
    // opt-in (?includeDaily=1). It stays available because "show me the rows behind
    // this claim" is a question a coach is entitled to ask.
    daily: e.includeDaily ? full.daily : null,
    dailyAvailable: Array.isArray(full.daily) ? full.daily.length : 0,
    blood: bridge || null,
    // What the member is being shown right now, so a coach is never guessing which
    // sentence their client is reading.
    memberView: projectForMember(full, bridge),
    loadNotes: (extra && extra.loadNotes) || []
  };
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

/**
 * Build a member's Signal.
 * @param {object} db {run, queryOne, queryAll}
 * @param {object} opts { userId, days, audience: 'member'|'admin'|'operator' }
 * @returns {Promise<object>} the audience-appropriate payload. Never throws.
 */
async function getSignal(db, opts) {
  const o = opts || {};
  const userId = String(o.userId || '');
  const audience = o.audience === 'member' ? 'member' : (o.audience === 'operator' ? 'operator' : 'admin');
  if (!userId) return { ok: false, error: 'A user is required.' };

  const input = await loadSignalInputs(db, { userId, days: o.days });

  const full = buildSignal({
    readiness: input.readiness,
    nutrition: input.nutrition,
    checkins: input.checkins,
    whoopWorkouts: input.whoopWorkouts,
    journal: input.journal,
    mindDates: input.mindDates,
    workoutDates: input.workoutDates,
    profile: input.profile,
    from: input.from,
    to: input.to,
    today: input.today
  });

  let bridge = null;
  try {
    bridge = buildBloodBridge({ reports: input.reports, rows: full.daily || [] });
  } catch (e) {
    console.warn('[signal] blood bridge:', e && e.message);
    bridge = { ok: false, items: [], memberItems: [], reportsSeen: 0, notes: ['The bloodwork bridge could not be built.'] };
  }

  if (audience === 'member') return projectForMember(full, bridge);
  return projectForStaff(full, bridge, {
    audience,
    loadNotes: input.loadNotes,
    includeDaily: !!o.includeDaily
  });
}

module.exports = {
  getSignal,
  loadSignalInputs,
  projectForMember,
  projectForStaff,
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS
};
