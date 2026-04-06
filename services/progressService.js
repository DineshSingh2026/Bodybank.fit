const db = require('../config/db');
const { getCurrentStreak } = require('./streakService');
const { getGoalCompletionPercent } = require('./goalService');
const { getInsights } = require('./insightService');

const MIN_REALISTIC_WEIGHT_KG = 25;
const MAX_REALISTIC_WEIGHT_KG = 400;

function normalizeWeightKg(value) {
  if (value == null || value === '') return null;
  const n = Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  if (n < MIN_REALISTIC_WEIGHT_KG || n > MAX_REALISTIC_WEIGHT_KG) return null;
  return n;
}

async function insertProgress(userId, data) {
  const {
    log_date,
    weight, body_fat, calories_intake, protein_intake,
    workout_completed, workout_type, strength_bench, strength_squat, strength_deadlift,
    sleep_hours, water_intake
  } = data;
  // Use log_date for created_at if provided (YYYY-MM-DD or ISO string); otherwise server now
  let createdAt = null;
  if (log_date && String(log_date).trim()) {
    const d = new Date(String(log_date).trim());
    if (!isNaN(d.getTime())) createdAt = d.toISOString().slice(0, 19).replace('T', ' ');
  }
  await db.query(
    `INSERT INTO progress_logs (
      user_id, weight, body_fat, calories_intake, protein_intake,
      workout_completed, workout_type, strength_bench, strength_squat, strength_deadlift,
      sleep_hours, water_intake, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [
      userId,
      normalizeWeightKg(weight),
      body_fat != null ? parseFloat(body_fat) : null,
      calories_intake != null ? parseInt(calories_intake, 10) : null,
      protein_intake != null ? parseInt(protein_intake, 10) : null,
      !!workout_completed,
      workout_type || null,
      strength_bench != null ? parseFloat(strength_bench) : null,
      strength_squat != null ? parseFloat(strength_squat) : null,
      strength_deadlift != null ? parseFloat(strength_deadlift) : null,
      sleep_hours != null ? parseFloat(sleep_hours) : null,
      water_intake != null ? parseFloat(water_intake) : null,
      createdAt
    ]
  );
}

async function getProgressForUser(userId, limit = 365) {
  const rows = await db.queryAll(
    'SELECT * FROM progress_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );
  return rows;
}

async function getProgressWithMeta(userId) {
  const logs = await getProgressForUser(userId);
  const streak = await getCurrentStreak(userId);
  const goalPct = await getGoalCompletionPercent(userId);
  const insights = await getInsights(userId);
  return { logs, streak, goalCompletionPercent: goalPct, insights };
}

function parseWeightFromText(txt) {
  if (!txt || typeof txt !== 'string') return null;
  // Prefer explicit kg/kgs values and select a realistic body-weight candidate.
  const kgMatches = [...txt.matchAll(/(\d+\.?\d*)\s*(?:kg|kgs)\b/ig)]
    .map((m) => normalizeWeightKg(m[1]))
    .filter((v) => v != null);
  if (kgMatches.length > 0) {
    // Most forms put latest/current weight near the end.
    return kgMatches[kgMatches.length - 1];
  }
  const m = txt.match(/(\d+\.?\d*)/);
  return m ? normalizeWeightKg(m[1]) : null;
}

function parseSleepFromText(txt) {
  if (!txt || typeof txt !== 'string') return null;
  const m = txt.match(/(\d+\.?\d*)\s*(?:hrs?|hours?)?/i) || txt.match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

/** Average of logged lifts (bench/squat/DL); includes 0 as valid — do not use filter(Boolean). */
function averageStrengthTriplet(l) {
  if (!l) return null;
  const vals = [l.strength_bench, l.strength_squat, l.strength_deadlift]
    .map((v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? parseFloat(v) : null))
    .filter((v) => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function mergeLogs(progressLogs, dailyCheckins, sundayCheckins) {
  const byDate = {};

  progressLogs.forEach((row) => {
    const d = (row.created_at ? String(row.created_at) : '').slice(0, 10);
    if (!d) return;
    byDate[d] = {
      created_at: row.created_at,
      weight: normalizeWeightKg(row.weight),
      body_fat: row.body_fat != null ? parseFloat(row.body_fat) : null,
      calories_intake: row.calories_intake != null ? parseInt(row.calories_intake, 10) : null,
      protein_intake: row.protein_intake != null ? parseInt(row.protein_intake, 10) : null,
      workout_completed: !!row.workout_completed,
      workout_type: row.workout_type || null,
      strength_bench: row.strength_bench != null ? parseFloat(row.strength_bench) : null,
      strength_squat: row.strength_squat != null ? parseFloat(row.strength_squat) : null,
      strength_deadlift: row.strength_deadlift != null ? parseFloat(row.strength_deadlift) : null,
      sleep_hours: row.sleep_hours != null ? parseFloat(row.sleep_hours) : null,
      // progress_logs.water_intake is stored in litres; merged series uses ml (same as daily_checkins)
      water_intake: row.water_intake != null ? parseFloat(row.water_intake) * 1000 : null,
      steps: null
    };
  });

  (dailyCheckins || []).forEach((row) => {
    const d = (row.checkin_date ? String(row.checkin_date) : '').slice(0, 10);
    if (!d) return;
    const base = byDate[d] || { created_at: d + 'T12:00:00', weight: null, body_fat: null, calories_intake: null, protein_intake: null, workout_completed: false, workout_type: null, strength_bench: null, strength_squat: null, strength_deadlift: null, sleep_hours: null, water_intake: null, steps: null };
    if (row.steps != null) base.steps = parseInt(row.steps, 10);
    if (row.protein_g != null && base.protein_intake == null) base.protein_intake = parseInt(row.protein_g, 10);
    if (row.sleep_hours != null && base.sleep_hours == null) base.sleep_hours = parseFloat(row.sleep_hours);
    if (row.water_ml != null && base.water_intake == null) base.water_intake = parseFloat(row.water_ml);
    byDate[d] = base;
  });

  (sundayCheckins || []).forEach((row) => {
    const d = (row.created_at ? String(row.created_at) : '').slice(0, 10);
    if (!d) return;
    const base = byDate[d] || { created_at: row.created_at || d + 'T12:00:00', weight: null, body_fat: null, calories_intake: null, protein_intake: null, workout_completed: false, workout_type: null, strength_bench: null, strength_squat: null, strength_deadlift: null, sleep_hours: null, water_intake: null, steps: null };
    const w = parseWeightFromText(row.current_weight_waist_week || row.last_week_weight_waist);
    if (w != null && base.weight == null) base.weight = w;
    const s = parseSleepFromText(row.sleep);
    if (s != null && base.sleep_hours == null) base.sleep_hours = s;
    byDate[d] = base;
  });

  return Object.keys(byDate)
    .sort()
    .map((d) => ({
      ...byDate[d],
      checkin_date: d,
      // Stable UTC noon so charts/admin parse dates consistently across timezones
      created_at: byDate[d].created_at || `${d}T12:00:00.000Z`
    }));
}

function maxLift(a, b) {
  if (a == null || a === '' || Number.isNaN(Number(a))) return b != null && b !== '' ? parseFloat(b) : null;
  if (b == null || b === '' || Number.isNaN(Number(b))) return parseFloat(a);
  return Math.max(parseFloat(a), parseFloat(b));
}

function parseSessionLiftsObj(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mergeSessionLiftsMax(existing, incoming) {
  const inc = parseSessionLiftsObj(incoming);
  if (!inc || !Object.keys(inc).length) return parseSessionLiftsObj(existing);
  const ex = parseSessionLiftsObj(existing) || {};
  const out = { ...ex };
  Object.keys(inc).forEach((k) => {
    const n = parseFloat(inc[k]);
    if (!Number.isFinite(n) || n <= 0) return;
    const pn = out[k] != null ? parseFloat(out[k]) : null;
    out[k] = pn == null || !Number.isFinite(pn) ? n : Math.max(pn, n);
  });
  return Object.keys(out).length ? out : null;
}

/** Merge workout_logs session rows (My Workout) into daily merged logs by session_date */
function mergeWorkoutSessionsIntoLogs(baseLogs, workoutRows) {
  if (!workoutRows || !workoutRows.length) return baseLogs || [];
  const byDate = {};
  (baseLogs || []).forEach((row) => {
    const d = row.checkin_date || (row.created_at ? String(row.created_at).slice(0, 10) : '');
    if (d) byDate[d] = { ...row };
  });
  const byDaySessions = {};
  workoutRows.forEach((w) => {
    const raw = w.session_date || (w.created_at ? String(w.created_at).slice(0, 10) : '');
    const d = raw.slice(0, 10);
    if (!d) return;
    if (!byDaySessions[d]) byDaySessions[d] = [];
    byDaySessions[d].push(w);
  });
  Object.keys(byDaySessions).forEach((d) => {
    const sessions = byDaySessions[d];
    const cur = byDate[d] || {
      checkin_date: d,
      created_at: `${d}T12:00:00.000Z`,
      weight: null,
      body_fat: null,
      calories_intake: null,
      protein_intake: null,
      workout_completed: false,
      workout_type: null,
      strength_bench: null,
      strength_squat: null,
      strength_deadlift: null,
      sleep_hours: null,
      water_intake: null,
      steps: null
    };
    const next = { ...cur };
    let totalDur = 0;
    let mergedSl = null;
    let lastFeedback = next.session_notes || null;
    sessions.forEach((w) => {
      if (w.duration_seconds != null) totalDur += parseInt(w.duration_seconds, 10) || 0;
      if (w.weight_kg != null && w.weight_kg !== '' && next.weight == null) next.weight = normalizeWeightKg(w.weight_kg);
      if (w.body_fat_percent != null && w.body_fat_percent !== '' && next.body_fat == null) next.body_fat = parseFloat(w.body_fat_percent);
      if (w.calories != null && w.calories !== '' && next.calories_intake == null) next.calories_intake = parseInt(w.calories, 10);
      if (w.protein_g != null && w.protein_g !== '' && next.protein_intake == null) next.protein_intake = parseInt(w.protein_g, 10);
      next.strength_bench = maxLift(next.strength_bench, w.bench_kg);
      next.strength_squat = maxLift(next.strength_squat, w.squat_kg);
      next.strength_deadlift = maxLift(next.strength_deadlift, w.deadlift_kg);
      mergedSl = mergeSessionLiftsMax(mergedSl, w.session_lifts);
      if (w.water_liters != null && w.water_liters !== '' && next.water_intake == null) next.water_intake = parseFloat(w.water_liters) * 1000;
      if (w.sleep_hrs != null && w.sleep_hrs !== '' && next.sleep_hours == null) next.sleep_hours = parseFloat(w.sleep_hrs);
      if (w.workout_completed === true || w.workout_completed === 1 || w.workout_completed === 't') next.workout_completed = true;
      if (w.workout_type) next.workout_type = w.workout_type;
      if (w.intensity) next.intensity = String(w.intensity);
      if (w.energy_level) next.energy_level = String(w.energy_level);
      if (w.feedback && String(w.feedback).trim()) lastFeedback = String(w.feedback).trim().slice(0, 500);
    });
    next.duration_seconds = totalDur > 0 ? totalDur : next.duration_seconds;
    if (mergedSl && typeof mergedSl === 'object' && Object.keys(mergedSl).length) next.session_lifts = mergedSl;
    if (lastFeedback) next.session_notes = lastFeedback;
    byDate[d] = next;
  });
  return Object.keys(byDate)
    .sort()
    .map((d) => ({
      ...byDate[d],
      checkin_date: d,
      created_at: byDate[d].created_at || `${d}T12:00:00.000Z`
    }));
}

/** Count completed My Workout sessions per calendar week (Sun–Sat), aligned with admin chart logic */
function weeklyCompletedSessions(workoutRows) {
  const byWeek = {};
  (workoutRows || []).forEach((w) => {
    const done = w.workout_completed === true || w.workout_completed === 1 || w.workout_completed === 't';
    if (!done) return;
    let raw = w.session_date || (w.created_at ? String(w.created_at).slice(0, 10) : '');
    if (raw instanceof Date) raw = raw.toISOString().slice(0, 10);
    else raw = String(raw || '').slice(0, 10);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return;
    const [y, mo, day] = raw.split('-').map((x) => parseInt(x, 10));
    const d = new Date(y, mo - 1, day);
    if (Number.isNaN(d.getTime())) return;
    const start = new Date(d);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    byWeek[key] = (byWeek[key] || 0) + 1;
  });
  const weeks = Object.keys(byWeek).sort().slice(-12);
  return weeks.map((k) => {
    const [Y, M, D] = k.split('-').map((x) => parseInt(x, 10));
    const dt = new Date(Y, M - 1, D);
    return {
      weekStart: k,
      label: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: byWeek[k] || 0
    };
  });
}

async function getAdminUserProgress(userId) {
  const userRow = await db.queryOne('SELECT COALESCE(suspended, false) as suspended FROM users WHERE id = ?', [userId]);
  const suspended = userRow ? (userRow.suspended === true || userRow.suspended === 't') : false;
  const userIdentity = await db.queryOne('SELECT email FROM users WHERE id = ?', [userId]);
  const userEmail = userIdentity && userIdentity.email ? String(userIdentity.email).trim().toLowerCase() : '';
  const [progressLogs, dailyCheckins, sundayByUserId, sundayByEmail, workoutSessions] = await Promise.all([
    db.queryAll('SELECT * FROM progress_logs WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.queryAll('SELECT checkin_date, steps, water_ml, protein_g, sleep_hours FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date ASC', [userId]),
    db.queryAll('SELECT id, current_weight_waist_week, last_week_weight_waist, sleep, created_at FROM sunday_checkins WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    userEmail
      ? db.queryAll(
        'SELECT id, current_weight_waist_week, last_week_weight_waist, sleep, created_at FROM sunday_checkins WHERE user_id IS NULL AND LOWER(COALESCE(reply_email, \'\')) = ? ORDER BY created_at ASC',
        [userEmail]
      )
      : Promise.resolve([]),
    db.queryAll(
      `SELECT id, session_date, workout_type, duration_seconds, feedback, bench_kg, squat_kg, deadlift_kg,
              session_lifts, weight_kg, body_fat_percent, calories, protein_g, water_liters, sleep_hrs, workout_completed, intensity, energy_level, created_at
       FROM workout_logs WHERE user_id = ? ORDER BY created_at ASC`,
      [userId]
    )
  ]);
  const seenSundayIds = new Set();
  const sundayCheckins = [...(sundayByUserId || []), ...(sundayByEmail || [])].filter((row) => {
    const id = row && row.id ? String(row.id) : '';
    if (!id) return true;
    if (seenSundayIds.has(id)) return false;
    seenSundayIds.add(id);
    return true;
  });

  const logs = mergeWorkoutSessionsIntoLogs(mergeLogs(progressLogs, dailyCheckins, sundayCheckins), workoutSessions || []);

  const streak = await getCurrentStreak(userId);
  const daily7Row = await db.queryOne(
    `SELECT COUNT(DISTINCT checkin_date)::int AS c
     FROM daily_checkins
     WHERE user_id = ?
       AND checkin_date >= (CURRENT_DATE - INTERVAL '6 days')
       AND checkin_date <= CURRENT_DATE`,
    [userId]
  );
  const dailyCheckins7d = daily7Row && daily7Row.c != null ? Number(daily7Row.c) : 0;

  const goalPct = await getGoalCompletionPercent(userId);
  const insights = await getInsights(userId);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recent = logs.filter(l => new Date(l.created_at) >= thirtyDaysAgo);
  const withWeight = logs.filter(l => normalizeWeightKg(l.weight) != null)
    .map((l) => ({ ...l, weight: normalizeWeightKg(l.weight) }));
  const currentWeight = withWeight.length ? withWeight[withWeight.length - 1].weight : null;
  const weight30Ago = recent.length ? (() => {
    const past = logs.filter(l => new Date(l.created_at) <= thirtyDaysAgo);
    const w = past
      .filter(l => normalizeWeightKg(l.weight) != null)
      .map((l) => ({ ...l, weight: normalizeWeightKg(l.weight) }));
    return w.length ? w[w.length - 1].weight : null;
  })() : null;
  const weightChange = (currentWeight != null && weight30Ago != null && weight30Ago !== 0)
    ? (((currentWeight - weight30Ago) / weight30Ago) * 100).toFixed(1)
    : null;

  const withStrength = logs.filter(l => l.strength_bench != null || l.strength_squat != null || l.strength_deadlift != null);
  let strengthGrowth = null;
  if (withStrength.length >= 2) {
    const first = withStrength[0];
    const last = withStrength[withStrength.length - 1];
    const firstAvg = averageStrengthTriplet(first);
    const lastAvg = averageStrengthTriplet(last);
    if (firstAvg != null && lastAvg != null && firstAvg > 0) {
      strengthGrowth = (((lastAvg - firstAvg) / firstAvg) * 100).toFixed(1);
    }
  }

  const total = logs.length;
  const workoutCount = logs.filter(l => l.workout_completed).length;
  const consistency = total > 0 ? ((workoutCount / total) * 100).toFixed(1) : 0;
  const avgCalories = logs.filter(l => l.calories_intake != null).length
    ? (logs.reduce((s, l) => s + (parseInt(l.calories_intake, 10) || 0), 0) / logs.filter(l => l.calories_intake != null).length).toFixed(0)
    : null;
  const avgSleep = logs.filter(l => l.sleep_hours != null).length
    ? (logs.reduce((s, l) => s + (parseFloat(l.sleep_hours) || 0), 0) / logs.filter(l => l.sleep_hours != null).length).toFixed(1)
    : null;

  return {
    currentWeight,
    weightChangePercent: weightChange,
    strengthGrowthPercent: strengthGrowth,
    workoutConsistencyPercent: consistency,
    /** Daily micro-goal check-ins logged in the last 7 calendar days (incl. today), max 7 */
    dailyCheckins7d,
    activeStreak: streak,
    goalCompletionPercent: goalPct,
    averageCalories: avgCalories,
    averageSleep: avgSleep,
    insights,
    logs,
    suspended,
    /** Row counts feeding the merged timeline (admin transparency) */
    sourceStats: {
      progressLogs: progressLogs.length,
      dailyCheckins: dailyCheckins.length,
      sundayCheckins: sundayCheckins.length,
      workoutSessions: workoutSessions.length
    },
    /** Completed My Workout sessions per week — use for weekly chart (true session count) */
    weeklyWorkoutSessions: weeklyCompletedSessions(workoutSessions || [])
  };
}

module.exports = { insertProgress, getProgressForUser, getProgressWithMeta, getAdminUserProgress };
