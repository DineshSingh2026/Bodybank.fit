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
      water_intake: row.water_intake != null ? parseFloat(row.water_intake) : null,
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
    .map((d) => ({ ...byDate[d], created_at: byDate[d].created_at || d + 'T12:00:00' }));
}

async function getAdminUserProgress(userId) {
  const userRow = await db.queryOne('SELECT COALESCE(suspended, false) as suspended FROM users WHERE id = ?', [userId]);
  const suspended = userRow ? (userRow.suspended === true || userRow.suspended === 't') : false;
  const userIdentity = await db.queryOne('SELECT email FROM users WHERE id = ?', [userId]);
  const userEmail = userIdentity && userIdentity.email ? String(userIdentity.email).trim().toLowerCase() : '';
  const [progressLogs, dailyCheckins, sundayByUserId, sundayByEmail] = await Promise.all([
    db.queryAll('SELECT * FROM progress_logs WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.queryAll('SELECT checkin_date, steps, water_ml, protein_g, sleep_hours FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date ASC', [userId]),
    db.queryAll('SELECT id, current_weight_waist_week, last_week_weight_waist, sleep, created_at FROM sunday_checkins WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    userEmail
      ? db.queryAll(
        'SELECT id, current_weight_waist_week, last_week_weight_waist, sleep, created_at FROM sunday_checkins WHERE user_id IS NULL AND LOWER(COALESCE(reply_email, \'\')) = ? ORDER BY created_at ASC',
        [userEmail]
      )
      : Promise.resolve([])
  ]);
  const seenSundayIds = new Set();
  const sundayCheckins = [...(sundayByUserId || []), ...(sundayByEmail || [])].filter((row) => {
    const id = row && row.id ? String(row.id) : '';
    if (!id) return true;
    if (seenSundayIds.has(id)) return false;
    seenSundayIds.add(id);
    return true;
  });

  const logs = mergeLogs(progressLogs, dailyCheckins, sundayCheckins);

  const streak = await getCurrentStreak(userId);
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
    activeStreak: streak,
    goalCompletionPercent: goalPct,
    averageCalories: avgCalories,
    averageSleep: avgSleep,
    insights,
    logs,
    suspended
  };
}

module.exports = { insertProgress, getProgressForUser, getProgressWithMeta, getAdminUserProgress };
