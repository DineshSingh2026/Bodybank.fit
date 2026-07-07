'use strict';

/**
 * Structured memory: per-user coach_settings + coach_user_profile.
 * - Settings: consent, personality, budget, quiet hours (auto-created with defaults).
 * - Profile: fast-read health score, streak, learned active hour, engagement — the
 *   deterministic facts the Decision Engine and Context Builder read on every event.
 */

const { computeHealthScore } = require('./healthScore');
const { safeJsonParse } = require('./util');

const DEFAULT_SETTINGS = {
  coach_enabled: true,
  personality: 'friendly',
  daily_budget: 2,
  min_send_threshold: 35,
  quiet_start: '21:30',
  quiet_end: '07:30',
  timezone: 'Asia/Kolkata',
  whatsapp_opt_in: false,
  muted_categories: [],
  language: 'en'
};

async function getSettings(ctx, userId) {
  let row = await ctx.queryOne('SELECT * FROM coach_settings WHERE user_id = ?', [userId]);
  if (!row) {
    // Inherit the user's own timezone if we know it, else IST.
    const u = await ctx.queryOne('SELECT timezone FROM users WHERE id = ?', [userId]).catch(() => null);
    const tz = (u && u.timezone && String(u.timezone).trim()) || DEFAULT_SETTINGS.timezone;
    await ctx.run(
      `INSERT INTO coach_settings (user_id, timezone) VALUES (?, ?)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, tz]
    );
    row = await ctx.queryOne('SELECT * FROM coach_settings WHERE user_id = ?', [userId]);
  }
  if (!row) return { user_id: userId, ...DEFAULT_SETTINGS };
  row.muted_categories = safeJsonParse(row.muted_categories, []);
  return row;
}

async function updateSettings(ctx, userId, patch) {
  await getSettings(ctx, userId); // ensure row exists
  const allowed = {
    coach_enabled: 'bool', personality: 'text', daily_budget: 'int',
    min_send_threshold: 'int', quiet_start: 'text', quiet_end: 'text',
    timezone: 'text', whatsapp_opt_in: 'bool', muted_categories: 'json', language: 'text'
  };
  const sets = [];
  const params = [];
  for (const [k, kind] of Object.entries(allowed)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (kind === 'bool') v = !!v;
    else if (kind === 'int') v = Math.max(0, parseInt(v, 10) || 0);
    else if (kind === 'json') v = JSON.stringify(Array.isArray(v) ? v : []);
    else v = String(v == null ? '' : v);
    if (kind === 'json') { sets.push(`${k} = ?::jsonb`); } else { sets.push(`${k} = ?`); }
    params.push(v);
  }
  if (!sets.length) return getSettings(ctx, userId);
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(userId);
  await ctx.run(`UPDATE coach_settings SET ${sets.join(', ')} WHERE user_id = ?`, params);
  return getSettings(ctx, userId);
}

async function getProfile(ctx, userId) {
  const row = await ctx.queryOne('SELECT * FROM coach_user_profile WHERE user_id = ?', [userId]);
  if (!row) return null;
  row.score_breakdown = safeJsonParse(row.score_breakdown, {});
  row.active_hours = safeJsonParse(row.active_hours, {});
  return row;
}

async function safe(fn, fb) { try { return await fn(); } catch (_) { return fb; } }

/** Consecutive-day check-in streak ending today or yesterday. */
async function computeStreak(ctx, userId) {
  const rows = await safe(() => ctx.queryAll(
    `SELECT DISTINCT checkin_date::text AS d FROM daily_checkins
     WHERE user_id = ? ORDER BY d DESC LIMIT 400`,
    [userId]
  ), []);
  const set = new Set((rows || []).map((r) => String(r.d).slice(0, 10)));
  const addDays = (ymd, delta) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  };
  let cursor = new Date().toISOString().slice(0, 10);
  if (!set.has(cursor)) cursor = addDays(cursor, -1);
  let streak = 0;
  for (let i = 0; i < 400 && cursor && set.has(cursor); i++) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Learn the hour of day this user is typically active (mode across activity tables). */
async function learnActiveHours(ctx, userId) {
  const hist = {};
  const add = (h) => { if (h != null) hist[h] = (hist[h] || 0) + 1; };
  const q = async (sql) => safe(() => ctx.queryAll(sql, [userId]), []);
  const rows = [
    ...(await q(`SELECT EXTRACT(HOUR FROM created_at)::int AS h FROM workout_logs WHERE user_id = ? AND created_at >= CURRENT_DATE - INTERVAL '30 days'`)),
    ...(await q(`SELECT EXTRACT(HOUR FROM created_at)::int AS h FROM nutrition_meal_logs WHERE user_id = ? AND created_at >= CURRENT_DATE - INTERVAL '30 days'`))
  ];
  rows.forEach((r) => add(r.h));
  let mode = null; let best = -1;
  for (const [h, c] of Object.entries(hist)) { if (c > best) { best = c; mode = parseInt(h, 10); } }
  return { typical: mode, hist };
}

async function lastActiveAt(ctx, userId) {
  const r = await safe(() => ctx.queryOne(
    `SELECT MAX(t) AS t FROM (
       SELECT MAX(created_at) AS t FROM workout_logs WHERE user_id = ?
       UNION ALL SELECT MAX(created_at) FROM nutrition_meal_logs WHERE user_id = ?
       UNION ALL SELECT MAX(created_at) FROM daily_checkins WHERE user_id = ?
     ) x`,
    [userId, userId, userId]
  ), null);
  return r && r.t ? r.t : null;
}

/** Engagement bucket from the last few coach messages (opens / replies). */
async function computeEngagement(ctx, userId) {
  const rows = await safe(() => ctx.queryAll(
    `SELECT opened_at, replied_at FROM coach_messages
     WHERE user_id = ? AND channel <> 'reply' ORDER BY sent_at DESC LIMIT 5`,
    [userId]
  ), []);
  if (!rows || rows.length < 2) return 'medium';
  const replies = rows.filter((r) => r.replied_at).length;
  const opens = rows.filter((r) => r.opened_at || r.replied_at).length;
  if (replies >= 2) return 'high';
  if (opens === 0 && rows.length >= 3) return 'low';
  return 'medium';
}

/** Recompute + persist the full profile. Called nightly and on significant events. */
async function recomputeProfile(ctx, userId) {
  const [health, streak, active, lastAt, engagement] = await Promise.all([
    computeHealthScore(ctx, userId),
    computeStreak(ctx, userId),
    learnActiveHours(ctx, userId),
    lastActiveAt(ctx, userId),
    computeEngagement(ctx, userId)
  ]);

  const prev = await getProfile(ctx, userId);
  const longest = Math.max(streak, (prev && prev.longest_streak) || 0);

  await ctx.run(
    `INSERT INTO coach_user_profile
       (user_id, health_score, score_breakdown, streak_days, longest_streak,
        typical_active_hour, active_hours, weak_dimension, engagement, last_active_at, recomputed_at)
     VALUES (?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       health_score = EXCLUDED.health_score,
       score_breakdown = EXCLUDED.score_breakdown,
       streak_days = EXCLUDED.streak_days,
       longest_streak = EXCLUDED.longest_streak,
       typical_active_hour = EXCLUDED.typical_active_hour,
       active_hours = EXCLUDED.active_hours,
       weak_dimension = EXCLUDED.weak_dimension,
       engagement = EXCLUDED.engagement,
       last_active_at = EXCLUDED.last_active_at,
       recomputed_at = CURRENT_TIMESTAMP`,
    [
      userId,
      health.score,
      JSON.stringify(health.breakdown || {}),
      streak,
      longest,
      active.typical,
      JSON.stringify(active.hist || {}),
      health.weak_dimension,
      engagement,
      lastAt
    ]
  );
  return getProfile(ctx, userId);
}

/** Event types the coach has already messaged about in the last `hours` — novelty guard. */
async function recentMessageTypes(ctx, userId, hours = 48) {
  const rows = await safe(() => ctx.queryAll(
    `SELECT DISTINCT type FROM coach_messages
     WHERE user_id = ? AND sent_at >= NOW() - (? || ' hours')::interval`,
    [userId, String(hours)]
  ), []);
  return (rows || []).map((r) => r.type).filter(Boolean);
}

/** Last N coach message bodies for anti-repetition in the post-filter. */
async function recentMessageBodies(ctx, userId, limit = 5) {
  const rows = await safe(() => ctx.queryAll(
    `SELECT body FROM coach_messages WHERE user_id = ? ORDER BY sent_at DESC LIMIT ?`,
    [userId, limit]
  ), []);
  return (rows || []).map((r) => r.body).filter(Boolean);
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  getProfile,
  recomputeProfile,
  computeStreak,
  recentMessageTypes,
  recentMessageBodies
};
