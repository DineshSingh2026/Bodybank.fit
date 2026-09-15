'use strict';

/**
 * Reports module — data loader.
 *
 * Maps the report's data sources onto BodyBank's ACTUAL schema and returns the
 * normalised dataset services/reportScore.js scores. Read-only: nothing here
 * writes to the database.
 *
 *   Spec source            -> real table(s)
 *   ---------------------------------------------------------------------------
 *   workouts/sessions      -> workout_logs (session_date, else created_at day),
 *                             wearable_workouts (days with no manual log)
 *     planned              -> weekly target: user_goals.weekly_workout_target ->
 *                             users.primary_training_days_per_week ->
 *                             tribe_members.activity_per_week -> 3/week
 *     sets/reps/weight     -> session_lifts / session_reps (one working set per lift)
 *     RPE                  -> workout_logs.intensity (Easy 5, Moderate 7,
 *                             Hard 8.5, Max Effort 10) — the app logs no numeric RPE
 *   meals                  -> nutrition_meal_logs.ai_result (calories/protein/carbs/fat)
 *     targets              -> nutrition_assessments.derived.calorie_target,
 *                             users.goal_protein_g
 *   check-ins              -> daily_checkins (sleep_hours, steps, water_ml; freeze
 *                             rows keep a streak alive but are not a check-in)
 *                             + readiness_daily via getReadinessRange (wearable
 *                             sleep/steps/recovery on days the member did not log)
 *     mood/energy          -> workout_logs.energy_level (Low/Medium/High) — there
 *                             is no mood/stress column; wearable recovery is used
 *                             when the member has a device
 *   yoga                   -> workout_logs whose type/name is a yoga practice
 *                             (AI Trainer postures, Surya Namaskar) + wearable
 *                             "yoga" workouts. No mobility score is stored anywhere,
 *                             so mobility stays empty until one is.
 *   body                   -> body_snapshots (weight, waist, measurements, photos
 *                             shared with the coach), progress_logs.weight,
 *                             smart_scale_uploads extracted weight
 *   blood                  -> blood_analysis_reports.extracted_blood_data (parsed
 *                             with the comparison engine's own helpers) + ai_report
 *   achievements           -> derived: personal bests from session_lifts, streaks,
 *                             perfect days, coin_ledger milestones, the member's own
 *                             Sunday check-in "achievements" answer
 *   goals                  -> user_goals, users.goal_type, tribe_members.target_weight
 */

const fs = require('fs');
const path = require('path');
const S = require('./reportScore');

let bloodHelpers = null;
function blood() {
  if (!bloodHelpers) bloodHelpers = require('./bloodComparisonService');
  return bloodHelpers;
}

const DEFAULT_TZ = (process.env.APP_TIMEZONE || '').trim() || 'Asia/Kolkata';

const YOGA_RE = /(yoga|surya|namaskar|asana|pranayama|vinyasa|hatha|\byin\b|mobility|stretch|warrior\s*(i{1,2}|1|2|one|two)\b|^tree$|goddess|downward\s*dog|^chair$|triangle|^boat$|^bridge$|^cobra$|\bpose\b)/i;

const LIFT_MUSCLE = Object.freeze({
  bench_press: 'Chest', incline_press: 'Chest',
  overhead_press: 'Shoulders', lateral_raise: 'Shoulders', face_pull: 'Shoulders',
  triceps_pushdown: 'Arms', bicep_curl: 'Arms',
  deadlift: 'Back', barbell_row: 'Back', lat_pulldown: 'Back',
  back_squat: 'Legs', squat: 'Legs', romanian_deadlift: 'Legs', leg_press: 'Legs', leg_curl: 'Legs', calf_raise: 'Legs'
});
const LIFT_LABEL = Object.freeze({
  bench_press: 'Bench press', incline_press: 'Incline press', overhead_press: 'Overhead press',
  lateral_raise: 'Lateral raise', face_pull: 'Face pull', triceps_pushdown: 'Triceps pushdown',
  bicep_curl: 'Bicep curl', deadlift: 'Deadlift', barbell_row: 'Barbell row', lat_pulldown: 'Lat pulldown',
  back_squat: 'Back squat', squat: 'Squat', romanian_deadlift: 'Romanian deadlift', leg_press: 'Leg press',
  leg_curl: 'Leg curl', calf_raise: 'Calf raise'
});
const INTENSITY_RPE = Object.freeze({ easy: 5, light: 5, moderate: 7, medium: 7, hard: 8.5, 'very hard': 9.5, 'max effort': 10, max: 10 });
const ENERGY_SCORE = Object.freeze({ low: 3, medium: 6, moderate: 6, high: 9 });

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function safeTz(tz) {
  const t = String(tz || '').trim();
  if (!t || t.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(t)) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; } catch (_) { return DEFAULT_TZ; }
}
function rpeFromIntensity(s) {
  if (s == null) return null;
  const str = String(s).trim().toLowerCase();
  if (!str) return null;
  const n = /(\d+(?:\.\d+)?)/.exec(str);
  if (n && /rpe|\/\s*10/.test(str)) { const v = parseFloat(n[1]); if (v >= 1 && v <= 10) return v; }
  return INTENSITY_RPE[str] != null ? INTENSITY_RPE[str] : null;
}
function energyScore(s) {
  if (s == null) return null;
  const str = String(s).trim().toLowerCase();
  return ENERGY_SCORE[str] != null ? ENERGY_SCORE[str] : null;
}

/** Wraps a query so a missing optional table never fails a report. */
async function safe(p) {
  try { return (await p) || []; } catch (err) {
    if (process.env.REPORTS_DEBUG) console.warn('[reports] query skipped:', err.message);
    return [];
  }
}

function localDateSql(col, tzParam) {
  // TIMESTAMP (no tz) columns hold UTC wall-clock time on the app's Postgres.
  return `((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tzParam})::date`;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapWorkout(r) {
  const lifts = parseJson(r.session_lifts) || {};
  const reps = parseJson(r.session_reps) || {};
  const muscleVolume = {};
  const liftList = [];
  let volume = 0;
  for (const [key, kgRaw] of Object.entries(lifts)) {
    const kg = num(kgRaw);
    if (!kg || kg <= 0) continue;
    const rp = num(reps[key]);
    const load = kg * (rp && rp > 0 ? rp : 1);
    volume += load;
    const mg = LIFT_MUSCLE[key] || 'Other';
    muscleVolume[mg] = (muscleVolume[mg] || 0) + load;
    liftList.push({ key, label: LIFT_LABEL[key] || key, kg, reps: rp });
  }
  const name = String(r.workout_type || r.workout_name || 'Workout').trim() || 'Workout';
  const durMin = num(r.duration_seconds) != null ? Math.round(num(r.duration_seconds) / 60) : null;
  const explicit = r.workout_completed;
  const completed = explicit === true || explicit == null || liftList.length > 0 || (durMin != null && durMin >= 10);
  return {
    date: r.d,
    name: name.slice(0, 80),
    completed,
    planned: false,
    durationMin: durMin,
    rpe: rpeFromIntensity(r.intensity),
    energy: energyScore(r.energy_level),
    volumeKg: Math.round(volume),
    muscleVolume,
    lifts: liftList,
    source: 'log'
  };
}

function isYogaName(name) {
  return YOGA_RE.test(String(name || '').trim());
}

function mapBloodReport(r) {
  const B = blood();
  const extracted = parseJson(r.extracted_blood_data) || {};
  const panels = Array.isArray(extracted.panels) ? extracted.panels
    : (Array.isArray(extracted.markers) ? [{ name: 'Markers', markers: extracted.markers }] : []);
  const markers = [];
  for (const p of panels) {
    for (const m of (p && Array.isArray(p.markers) ? p.markers : [])) {
      if (!m || !m.name) continue;
      const { key, display } = B.canonicalizeMarker(m.name);
      const parsed = B.parseNumericValue(m.value);
      const range = B.parseReferenceRange(m.reference_range != null ? m.reference_range : m.reference);
      markers.push({
        key, name: display, panel: String((p && p.name) || '').slice(0, 60),
        value: parsed.num, rawValue: String(m.value == null ? '' : m.value).slice(0, 40),
        unit: String(m.unit || '').slice(0, 20),
        low: range ? range.low : null, high: range ? range.high : null,
        referenceRange: String(m.reference_range || '').slice(0, 40),
        labStatus: String(m.status || '').slice(0, 20)
      });
    }
  }
  const ai = parseJson(r.ai_report) || {};
  return {
    id: r.id,
    date: r.d,
    markers,
    ai: {
      overallStatus: ai.overall_status || null,
      summary: ai.overall_summary_short || null,
      keyFindings: Array.isArray(ai.key_findings) ? ai.key_findings.slice(0, 6).map((k) => ({
        severity: k && k.severity ? String(k.severity) : '',
        title: k && k.title ? String(k.title) : '',
        detail: k && k.detail ? String(k.detail) : ''
      })) : []
    }
  };
}

function extractScaleWeight(extracted) {
  const x = parseJson(extracted);
  if (!x || !Array.isArray(x.sections)) return null;
  for (const sec of x.sections) {
    for (const m of (sec && Array.isArray(sec.metrics) ? sec.metrics : [])) {
      const nm = String((m && m.name) || '').toLowerCase();
      if (/^(body\s*)?weight$/.test(nm.trim()) || nm === 'weight (kg)') {
        let v = num(m.value);
        if (v != null && /lb/i.test(String(m.unit || ''))) v = v * 0.45359237;
        if (v != null && v > 25 && v < 350) return Math.round(v * 10) / 10;
      }
    }
  }
  return null;
}

function goalDirection(goalType, targetKg, currentKg) {
  if (targetKg != null && currentKg != null) {
    if (targetKg < currentKg - 0.5) return 'lose';
    if (targetKg > currentKg + 0.5) return 'gain';
    return 'maintain';
  }
  const g = String(goalType || '').toLowerCase();
  if (/fat|loss|lose|cut|slim/.test(g)) return 'lose';
  if (/muscle|gain|bulk|mass/.test(g)) return 'gain';
  if (g) return 'maintain';
  return null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function defaultDb() {
  return require('../config/db');
}

async function loadUser(db, userId) {
  return db.queryOne(
    `SELECT id, first_name, last_name, email, phone, timezone, goal_type, goal_steps, goal_water_ml,
            goal_protein_g, goal_sleep_hours, primary_training_days_per_week, height_cm, gender,
            subscription_status, plan_label, created_at
       FROM users WHERE id = ?`,
    [userId]
  );
}

/**
 * Loads everything a report needs for [start, end] and the two previous
 * periods of equal length (trend baselines), plus enough history for the
 * trend charts (6 weeks for weekly, 3 periods for monthly).
 */
async function loadReportBundle(userId, startDate, endDate, type, opts) {
  const o = opts || {};
  const db = o.db || defaultDb();
  if (!userId) throw new Error('userId required');
  if (!isYmd(startDate) || !isYmd(endDate)) throw new Error('startDate/endDate must be YYYY-MM-DD');
  if (S.dayNum(endDate) < S.dayNum(startDate)) throw new Error('endDate is before startDate');

  const user = await loadUser(db, userId);
  if (!user) throw new Error('Client not found');
  const tz = safeTz(user.timezone);

  const prev = S.previousPeriod(startDate, endDate);
  const prev2 = S.previousPeriod(prev.start, prev.end);
  const histStart = S.dayNum(prev2.start) < S.dayNum(S.addDays(startDate, -42)) ? prev2.start : S.addDays(startDate, -42);
  const W = [histStart, endDate];

  const q = (sql, params) => safe(db.queryAll(sql, params));
  const logDay = `COALESCE(session_date, ${localDateSql('created_at', '?')})`;

  const [
    workoutRows, wearableWorkoutRows, mealRows, checkinRows, readinessRows,
    snapshotRows, progressWeightRows, scaleRows, bloodRows, goalRow, tribeRow,
    assessmentRow, coinRows, sundayRows, priorLiftRows
  ] = await Promise.all([
    q(`SELECT id, workout_name, workout_type, duration_seconds, session_lifts, session_reps,
              workout_completed, intensity, energy_level,
              to_char(${logDay}, 'YYYY-MM-DD') AS d
         FROM workout_logs
        WHERE user_id = ? AND ${logDay} BETWEEN ?::date AND ?::date
        ORDER BY d, id`, [tz, userId, tz, W[0], W[1]]),
    q(`SELECT to_char(date, 'YYYY-MM-DD') AS d, activity, duration_min, strain, avg_hr
         FROM wearable_workouts
        WHERE user_id = ? AND date BETWEEN ?::date AND ?::date
        ORDER BY date`, [userId, W[0], W[1]]),
    q(`SELECT to_char(log_date, 'YYYY-MM-DD') AS d, meal_type,
              ai_result->>'calories' AS calories, ai_result->>'protein' AS protein,
              ai_result->>'carbs' AS carbs, ai_result->>'fat' AS fat
         FROM nutrition_meal_logs
        WHERE user_id = ? AND log_date BETWEEN ?::date AND ?::date`, [userId, W[0], W[1]]),
    q(`SELECT to_char(checkin_date, 'YYYY-MM-DD') AS d, steps, water_ml, protein_g, sleep_hours,
              COALESCE(is_freeze, FALSE) AS is_freeze
         FROM daily_checkins
        WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date`, [userId, W[0], W[1]]),
    (async () => {
      try {
        const rs = require('./wearables/readinessService');
        return await rs.getReadinessRange({ queryAll: db.queryAll, queryOne: db.queryOne, run: db.run || db.query }, { userId, from: W[0], to: W[1] });
      } catch (_) { return []; }
    })(),
    q(`SELECT snapshot_date AS d, bodyweight_kg, waist_cm, measurements, photo_front, photo_side,
              COALESCE(shared_with_manager, FALSE) AS shared
         FROM body_snapshots
        WHERE user_id = ? AND snapshot_date <= ?
        ORDER BY snapshot_date`, [userId, endDate]),
    q(`SELECT to_char(${localDateSql('created_at', '?')}, 'YYYY-MM-DD') AS d, weight
         FROM progress_logs
        WHERE user_id = ? AND weight IS NOT NULL AND ${localDateSql('created_at', '?')} <= ?::date`, [tz, userId, tz, endDate]),
    q(`SELECT to_char(COALESCE(report_date, ${localDateSql('created_at', '?')}), 'YYYY-MM-DD') AS d, extracted_data
         FROM smart_scale_uploads
        WHERE user_id = ? AND extracted_data IS NOT NULL
          AND COALESCE(report_date, ${localDateSql('created_at', '?')}) <= ?::date`, [tz, userId, tz, endDate]),
    q(`SELECT id, extracted_blood_data, ai_report,
              to_char(COALESCE(report_date, (created_at AT TIME ZONE ?)::date), 'YYYY-MM-DD') AS d
         FROM blood_analysis_reports
        WHERE user_id = ? AND extracted_blood_data IS NOT NULL
          AND COALESCE(report_date, (created_at AT TIME ZONE ?)::date) <= ?::date
        ORDER BY COALESCE(report_date, (created_at AT TIME ZONE ?)::date) ASC`, [tz, userId, tz, endDate, tz]),
    q(`SELECT target_weight, target_body_fat, weekly_workout_target
         FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]),
    user.email ? q(`SELECT starting_weight, current_weight, target_weight, activity_per_week, phase
         FROM tribe_members WHERE LOWER(email) = LOWER(?) LIMIT 1`, [user.email]) : [],
    q(`SELECT derived FROM nutrition_assessments
        WHERE user_id = ? AND derived IS NOT NULL
        ORDER BY COALESCE(submitted_at, updated_at, created_at) DESC LIMIT 1`, [userId]),
    q(`SELECT to_char((created_at AT TIME ZONE ?)::date, 'YYYY-MM-DD') AS d, event_type, coins_delta
         FROM coin_ledger
        WHERE user_id = ? AND (created_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date`, [tz, userId, tz, W[0], W[1]]),
    q(`SELECT to_char(${localDateSql('created_at', '?')}, 'YYYY-MM-DD') AS d, achievements, improve_next_week
         FROM sunday_checkins
        WHERE user_id = ? AND ${localDateSql('created_at', '?')} BETWEEN ?::date AND ?::date
        ORDER BY created_at DESC LIMIT 12`, [tz, userId, tz, W[0], W[1]]),
    q(`SELECT session_lifts, session_reps
         FROM workout_logs
        WHERE user_id = ? AND session_lifts IS NOT NULL AND ${logDay} < ?::date`, [userId, tz, W[0]])
  ]);

  // ---- workouts & yoga ------------------------------------------------------
  const workouts = [];
  const yoga = [];
  for (const r of workoutRows) {
    if (!r.d) continue;
    const w = mapWorkout(r);
    if (isYogaName(r.workout_type) || isYogaName(r.workout_name)) {
      yoga.push({ date: w.date, durationMin: w.durationMin, style: w.name, mobilityScore: null, source: 'log' });
    } else {
      workouts.push(w);
    }
  }
  const loggedDays = new Set(workouts.map((w) => w.date));
  for (const r of wearableWorkoutRows) {
    if (!r.d) continue;
    const dur = num(r.duration_min);
    const act = String(r.activity || 'Workout').slice(0, 60);
    if (isYogaName(act)) {
      yoga.push({ date: r.d, durationMin: dur != null ? Math.round(dur) : null, style: act, mobilityScore: null, source: 'wearable' });
    } else if (!loggedDays.has(r.d) && dur != null && dur >= 15) {
      workouts.push({
        date: r.d, name: act, completed: true, planned: false, durationMin: Math.round(dur),
        rpe: null, energy: null, volumeKg: 0, muscleVolume: {}, lifts: [], source: 'wearable'
      });
    }
  }

  // ---- meals (one row per day) ---------------------------------------------
  const mealByDay = new Map();
  for (const r of mealRows) {
    if (!r.d) continue;
    const cur = mealByDay.get(r.d) || { date: r.d, meals: 0, calories: 0, protein: 0, carbs: 0, fat: 0, types: new Set() };
    const type = String(r.meal_type || '').toLowerCase();
    if (!cur.types.has(type)) { cur.types.add(type); cur.meals += 1; }
    cur.calories += num(r.calories) || 0;
    cur.protein += num(r.protein) || 0;
    cur.carbs += num(r.carbs) || 0;
    cur.fat += num(r.fat) || 0;
    mealByDay.set(r.d, cur);
  }
  const meals = Array.from(mealByDay.values()).map((m) => ({
    date: m.date, meals: m.meals,
    calories: Math.round(m.calories), protein: Math.round(m.protein), carbs: Math.round(m.carbs), fat: Math.round(m.fat)
  }));

  // ---- check-ins, wearables, energy ----------------------------------------
  const checkins = [];
  for (const r of checkinRows) {
    if (!r.d) continue;
    if (r.is_freeze === true) { checkins.push({ date: r.d, source: 'freeze' }); continue; }
    checkins.push({
      date: r.d, source: 'checkin',
      steps: num(r.steps), waterL: num(r.water_ml) != null ? Math.round(num(r.water_ml) / 100) / 10 : null,
      sleepH: num(r.sleep_hours), proteinG: num(r.protein_g)
    });
  }
  const recovery = [];
  for (const r of readinessRows || []) {
    if (!r || !r.date) continue;
    checkins.push({ date: r.date, source: 'wearable', sleepH: num(r.sleepHours), steps: num(r.steps) });
    if (num(r.score) != null) recovery.push({ date: r.date, value: num(r.score) });
  }
  const energyByDay = new Map();
  for (const w of workouts) if (w.energy != null) energyByDay.set(w.date, w.energy);
  for (const [date, v] of energyByDay) checkins.push({ date, source: 'derived', energy: v });

  // ---- body -----------------------------------------------------------------
  const weightByDay = new Map();
  const PRIORITY = { snapshot: 4, scale: 3, progress: 2 };
  const putWeight = (date, kg, source) => {
    if (!isYmd(date) || kg == null || kg < 25 || kg > 350) return;
    const cur = weightByDay.get(date);
    if (!cur || PRIORITY[source] > PRIORITY[cur.source]) weightByDay.set(date, { date, weightKg: Math.round(kg * 10) / 10, source });
  };
  const measurements = [];
  const photos = [];
  for (const r of snapshotRows) {
    const d = String(r.d || '').slice(0, 10);
    if (!isYmd(d)) continue;
    putWeight(d, num(r.bodyweight_kg), 'snapshot');
    const m = parseJson(r.measurements) || {};
    const row = { date: d, waistCm: num(r.waist_cm), chestCm: num(m.chest_cm), armsCm: num(m.arms_cm), hipsCm: num(m.hips_cm), thighsCm: num(m.thighs_cm) };
    if (row.waistCm != null || row.chestCm != null || row.armsCm != null || row.hipsCm != null || row.thighsCm != null) measurements.push(row);
    if (r.shared === true && (r.photo_front || r.photo_side)) photos.push({ date: d, front: r.photo_front || null, side: r.photo_side || null });
  }
  for (const r of progressWeightRows) putWeight(r.d, num(r.weight), 'progress');
  for (const r of scaleRows) putWeight(r.d, extractScaleWeight(r.extracted_data), 'scale');
  const weightsAll = Array.from(weightByDay.values()).sort((a, b) => S.dayNum(a.date) - S.dayNum(b.date));

  // ---- blood ----------------------------------------------------------------
  const bloodReports = bloodRows.map(mapBloodReport).filter((b) => b.date && b.markers.length);

  // ---- targets & goals -----------------------------------------------------
  const goal = goalRow[0] || {};
  const tribe = tribeRow[0] || {};
  const derived = assessmentRow[0] ? (parseJson(assessmentRow[0].derived) || {}) : {};
  const weeklyTarget = num(goal.weekly_workout_target) || num(user.primary_training_days_per_week) || num(tribe.activity_per_week) || null;
  const protTarget = num(user.goal_protein_g)
    || (derived.protein_target_g && typeof derived.protein_target_g === 'object' ? num(derived.protein_target_g.low) : num(derived.protein_target_g))
    || null;
  const targets = {
    mealsPerDay: 3,
    sleepH: 7,
    steps: num(user.goal_steps) || S.DEFAULT_TARGETS.steps,
    waterL: num(user.goal_water_ml) ? Math.round(num(user.goal_water_ml) / 100) / 10 : S.DEFAULT_TARGETS.waterL,
    protein: protTarget,
    calories: num(derived.calorie_target) ? Math.round(num(derived.calorie_target)) : null,
    workoutsPerWeek: weeklyTarget && weeklyTarget > 0 && weeklyTarget <= 14 ? weeklyTarget : S.DEFAULT_TARGETS.workoutsPerWeek,
    workoutsPerWeekSource: weeklyTarget ? 'plan' : 'default',
    yogaPerWeek: S.DEFAULT_TARGETS.yogaPerWeek
  };
  const targetWeight = num(goal.target_weight) || num(tribe.target_weight) || null;
  const firstKg = weightsAll.length ? weightsAll[0].weightKg : num(tribe.starting_weight);
  const goalInfo = {
    goalType: user.goal_type || '',
    targetWeightKg: targetWeight,
    targetBodyFat: num(goal.target_body_fat),
    direction: goalDirection(user.goal_type, targetWeight, weightsAll.length ? weightsAll[weightsAll.length - 1].weightKg : firstKg)
  };

  // ---- personal bests (a lift beating everything logged before it) ---------
  const bestBefore = {};
  for (const r of priorLiftRows) {
    const l = parseJson(r.session_lifts) || {};
    for (const [k, v] of Object.entries(l)) { const kg = num(v); if (kg && (!bestBefore[k] || kg > bestBefore[k])) bestBefore[k] = kg; }
  }
  const prs = [];
  const running = Object.assign({}, bestBefore);
  for (const w of workouts.slice().sort((a, b) => S.dayNum(a.date) - S.dayNum(b.date))) {
    for (const l of w.lifts) {
      if (running[l.key] != null && l.kg > running[l.key]) prs.push({ date: w.date, key: l.key, label: l.label, kg: l.kg, previousKg: running[l.key] });
      if (running[l.key] == null || l.kg > running[l.key]) running[l.key] = l.kg;
    }
  }

  // ---- period slicing -------------------------------------------------------
  const base = { targets, goal: goalInfo };
  const plannedFor = (s, e) => Math.round((targets.workoutsPerWeek * S.daysBetween(s, e)) / 7);
  const lastBefore = (rows, date, field) => {
    let out = null;
    for (const r of rows) {
      if (S.dayNum(r.date) >= S.dayNum(date)) break;
      if (field == null || r[field] != null) out = r;
    }
    return out;
  };
  const measAsc = measurements.slice().sort((a, b) => S.dayNum(a.date) - S.dayNum(b.date));
  const slice = (s, e) => Object.assign({}, base, {
    period: { start: s, end: e },
    workouts, meals, checkins, yoga, blood: bloodReports,
    plannedWorkouts: plannedFor(s, e),
    plannedYoga: null,
    weights: weightsAll,
    baselineWeight: lastBefore(weightsAll, s, 'weightKg'),
    measurements: measAsc,
    baselineMeasurement: lastBefore(measAsc, s, 'waistCm')
  });

  return {
    user: {
      id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'Client',
      firstName: String(user.first_name || '').trim() || 'there',
      email: user.email || '',
      phone: user.phone || '',
      goalType: user.goal_type || '',
      timezone: tz,
      planLabel: user.plan_label || ''
    },
    type: type === 'monthly' ? 'monthly' : 'weekly',
    targets,
    goal: goalInfo,
    current: slice(startDate, endDate),
    previous: slice(prev.start, prev.end),
    previous2: slice(prev2.start, prev2.end),
    history: {
      start: histStart, end: endDate,
      workouts, meals, checkins, yoga, weights: weightsAll, measurements: measAsc, recovery
    },
    blood: bloodReports,
    photos: photos.filter((p) => S.dayNum(p.date) <= S.dayNum(endDate)),
    prs: prs.filter((p) => S.dayNum(p.date) >= S.dayNum(startDate) && S.dayNum(p.date) <= S.dayNum(endDate)),
    coins: coinRows.filter((c) => c.d && S.dayNum(c.d) >= S.dayNum(startDate)).map((c) => ({ date: c.d, type: c.event_type, coins: num(c.coins_delta) || 0 })),
    sunday: sundayRows.filter((r) => r.d && S.dayNum(r.d) >= S.dayNum(startDate)).map((r) => ({
      date: r.d, achievements: String(r.achievements || '').trim(), improve: String(r.improve_next_week || '').trim()
    }))
  };
}

/** Resolves a stored /uploads/... photo URL to a readable file, or null. */
function resolvePhotoFile(url, uploadsDir) {
  const u = String(url || '');
  if (!u.startsWith('/uploads/') || u.includes('..')) return null;
  const root = uploadsDir || path.join(__dirname, '..', 'uploads');
  const p = path.join(root, u.slice('/uploads/'.length));
  if (!p.startsWith(path.resolve(root))) return null;
  try { const st = fs.statSync(p); return st.isFile() && st.size < 6 * 1024 * 1024 ? p : null; } catch (_) { return null; }
}

module.exports = {
  loadReportBundle,
  resolvePhotoFile,
  // exported for tests
  mapWorkout,
  isYogaName,
  rpeFromIntensity,
  energyScore,
  goalDirection,
  LIFT_MUSCLE
};
