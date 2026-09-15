'use strict';

/**
 * Seeded report bundles — the same shape services/reportData.loadReportBundle
 * returns, built from a fixed-seed PRNG so every run produces identical data.
 *
 *   seedBundle('weekly' | 'monthly', 'normal' | 'empty' | 'extreme')
 *
 * NORMAL   "Aarav Mehta", fat-loss client, May -> Sep 2026: training 4x/week with
 *          rising lifts, 3 meals most days (protein dips at weekends), daily
 *          check-ins with some misses, yoga 2-3x/week, weigh-ins trending down,
 *          two blood reports (Mar, Aug). Used for the two sample PDFs.
 * EMPTY    a client with an account and nothing logged.
 * EXTREME  pathological values for the layout audit: 400-char names, 60-char
 *          unbroken tokens, 40 blood markers, 30 sessions a week, huge numbers.
 *
 * No database. No network.
 */

const S = require('../../../services/reportScore');

const WEEK = { start: '2026-08-31', end: '2026-09-06' };
const MONTH = { start: '2026-08-01', end: '2026-08-31' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIFTS = {
  Push: [['bench_press', 'Bench press', 'Chest', 72], ['overhead_press', 'Overhead press', 'Shoulders', 42], ['triceps_pushdown', 'Triceps pushdown', 'Arms', 30]],
  Pull: [['deadlift', 'Deadlift', 'Back', 120], ['barbell_row', 'Barbell row', 'Back', 62], ['bicep_curl', 'Bicep curl', 'Arms', 16]],
  Legs: [['back_squat', 'Back squat', 'Legs', 95], ['romanian_deadlift', 'Romanian deadlift', 'Legs', 80], ['calf_raise', 'Calf raise', 'Legs', 60]],
  Upper: [['incline_press', 'Incline press', 'Chest', 30], ['lat_pulldown', 'Lat pulldown', 'Back', 60], ['lateral_raise', 'Lateral raise', 'Shoulders', 10]]
};
const DAY_PLAN = { 1: 'Push', 2: 'Pull', 4: 'Legs', 5: 'Upper' }; // Mon Tue Thu Fri

function dow(iso) { return new Date(S.dayNum(iso) * 86400000).getUTCDay(); }
function r1(v) { return Math.round(v * 10) / 10; }

function marker(key, name, unit, low, high, value, labStatus) {
  return { key, name, unit, low, high, value, rawValue: String(value), labStatus: labStatus || '' };
}

function normalHistory(rand) {
  const start = '2026-05-01'; const end = '2026-09-06';
  const workouts = []; const meals = []; const checkins = []; const yoga = []; const weights = []; const measurements = []; const recovery = [];
  const dates = S.datesInRange(start, end);
  const total = dates.length;
  dates.forEach((d, i) => {
    const t = i / total;               // 0 -> 1 over the history: habits improve
    const w = dow(d);
    // Training
    const plan = DAY_PLAN[w];
    if (plan) {
      const doIt = rand() < 0.62 + 0.3 * t;
      if (doIt) {
        const lifts = LIFTS[plan].map(([key, label, mg, base]) => {
          const kg = Math.round((base * (0.88 + 0.2 * t) + (rand() - 0.5) * 2) * 2) / 2;
          return { key, label, mg, kg, reps: 8 };
        });
        const muscleVolume = {};
        let vol = 0;
        lifts.forEach((l) => { const v = l.kg * l.reps * 3; vol += v; muscleVolume[l.mg] = (muscleVolume[l.mg] || 0) + v; });
        workouts.push({
          date: d, name: plan + ' day', completed: true, planned: false, durationMin: 50 + Math.round(rand() * 20),
          rpe: [7, 8.5, 7, 8.5, 10][Math.floor(rand() * 5)], energy: rand() < 0.7 ? 9 : 6,
          volumeKg: Math.round(vol), muscleVolume, lifts: lifts.map((l) => ({ key: l.key, label: l.label, kg: l.kg, reps: l.reps })), source: 'log'
        });
      }
    }
    // Yoga on Wed / Sat / Sun (not always)
    if ((w === 3 || w === 6 || w === 0) && rand() < 0.55 + 0.25 * t) {
      yoga.push({ date: d, durationMin: 20 + Math.round(rand() * 15), style: ['Surya Namaskar', 'Hatha flow', 'Warrior II', 'Downward Dog'][Math.floor(rand() * 4)], mobilityScore: null, source: 'log' });
    }
    // Meals: weekends slip on protein and run higher on calories
    const weekend = w === 0 || w === 6;
    const logP = weekend ? 0.8 : 0.93;
    if (rand() < logP) {
      const n = rand() < 0.82 ? 3 : 2;
      const cal = weekend ? 2350 + Math.round(rand() * 350) : 1980 + Math.round(rand() * 260);
      const protein = weekend ? 112 + Math.round(rand() * 20) : 142 + Math.round(rand() * 22);
      meals.push({ date: d, meals: n, calories: Math.round(cal * (n / 3)), protein: Math.round(protein * (n / 3)), carbs: Math.round(cal * 0.45 / 4 * (n / 3)), fat: Math.round(cal * 0.28 / 9 * (n / 3)) });
    }
    // Check-ins
    if (rand() < 0.8 + 0.12 * t) {
      checkins.push({
        date: d, source: 'checkin',
        sleepH: r1(6.1 + rand() * 1.9 + (weekend ? 0.4 : 0)),
        steps: Math.round(6200 + rand() * 5200 + 1200 * t),
        waterL: r1(2.3 + rand() * 1.1),
        proteinG: null
      });
    }
    // Weigh-ins ~5 days a week, trending 86.4 -> ~81.6
    if (rand() < 0.72) weights.push({ date: d, weightKg: r1(86.4 - 4.8 * t + (rand() - 0.5) * 0.8), source: 'scale' });
    // Measurements on the first Sunday of each month and mid-month
    const day = Number(d.slice(8, 10));
    if (w === 0 && (day <= 7 || (day >= 15 && day <= 21))) {
      measurements.push({ date: d, waistCm: r1(95 - 5.5 * t + (rand() - 0.5) * 0.4), chestCm: r1(104 - 1.5 * t), hipsCm: r1(102 - 3 * t), armsCm: r1(35.2 + 0.6 * t), thighsCm: r1(60 - 1.6 * t) });
    }
  });
  // Energy from workouts feeds the check-in energy series.
  workouts.forEach((wk) => { if (wk.energy != null) checkins.push({ date: wk.date, source: 'derived', energy: wk.energy }); });
  return { start, end, workouts, meals, checkins, yoga, weights, measurements, recovery };
}

function normalBlood() {
  return [
    { id: 'b1', date: '2026-03-10', markers: [
      marker('hba1c', 'HbA1c', '%', 4.0, 5.6, 5.9, 'High'),
      marker('vitamin d 25 oh', 'Vitamin D (25-OH)', 'ng/mL', 30, 100, 18, 'Low'),
      marker('ldl cholesterol', 'LDL Cholesterol', 'mg/dL', null, 130, 142, 'High'),
      marker('hdl cholesterol', 'HDL Cholesterol', 'mg/dL', 40, null, 38, 'Low'),
      marker('triglycerides', 'Triglycerides', 'mg/dL', null, 150, 181, 'High'),
      marker('hemoglobin', 'Hemoglobin', 'g/dL', 13.5, 17.5, 14.2, 'Normal'),
      marker('vitamin b12', 'Vitamin B12', 'pg/mL', 200, 900, 240, 'Normal'),
      marker('tsh', 'TSH', 'mIU/L', 0.4, 4.0, 2.1, 'Normal'),
      marker('ferritin', 'Ferritin', 'ng/mL', 30, 400, 34, 'Normal')
    ], ai: { summary: 'Most markers sit in range. Vitamin D, LDL, HDL, triglycerides and HbA1c were outside their ranges at this test.', keyFindings: [] } },
    { id: 'b2', date: '2026-08-20', markers: [
      marker('hba1c', 'HbA1c', '%', 4.0, 5.6, 5.6, 'Normal'),
      marker('vitamin d 25 oh', 'Vitamin D (25-OH)', 'ng/mL', 30, 100, 26, 'Low'),
      marker('ldl cholesterol', 'LDL Cholesterol', 'mg/dL', null, 130, 124, 'Normal'),
      marker('hdl cholesterol', 'HDL Cholesterol', 'mg/dL', 40, null, 43, 'Normal'),
      marker('triglycerides', 'Triglycerides', 'mg/dL', null, 150, 156, 'High'),
      marker('hemoglobin', 'Hemoglobin', 'g/dL', 13.5, 17.5, 14.6, 'Normal'),
      marker('vitamin b12', 'Vitamin B12', 'pg/mL', 200, 900, 318, 'Normal'),
      marker('tsh', 'TSH', 'mIU/L', 0.4, 4.0, 2.4, 'Normal'),
      marker('ferritin', 'Ferritin', 'ng/mL', 30, 400, 41, 'Normal'),
      marker('fasting glucose', 'Fasting Glucose', 'mg/dL', 70, 100, 94, 'Normal')
    ], ai: { summary: 'Most markers moved toward their reference ranges since March. Vitamin D and triglycerides are still outside range.', keyFindings: [] } }
  ];
}

function prsFrom(workouts, start, end) {
  const best = {}; const prs = [];
  workouts.slice().sort((a, b) => S.dayNum(a.date) - S.dayNum(b.date)).forEach((w) => {
    (w.lifts || []).forEach((l) => {
      if (best[l.key] != null && l.kg > best[l.key] && S.dayNum(w.date) >= S.dayNum(start) && S.dayNum(w.date) <= S.dayNum(end)) {
        prs.push({ date: w.date, key: l.key, label: l.label, kg: l.kg, previousKg: best[l.key] });
      }
      if (best[l.key] == null || l.kg > best[l.key]) best[l.key] = l.kg;
    });
  });
  return prs;
}

function assemble(type, user, targets, goal, h, blood, extra) {
  const period = type === 'monthly' ? MONTH : WEEK;
  const prev = S.previousPeriod(period.start, period.end);
  const prev2 = S.previousPeriod(prev.start, prev.end);
  const lastBefore = (rows, date, f) => { let out = null; for (const r of rows) { if (S.dayNum(r.date) >= S.dayNum(date)) break; if (r[f] != null) out = r; } return out; };
  const slice = (s, e) => ({
    period: { start: s, end: e }, targets, goal,
    workouts: h.workouts, meals: h.meals, checkins: h.checkins, yoga: h.yoga, blood,
    plannedWorkouts: Math.round((targets.workoutsPerWeek * S.daysBetween(s, e)) / 7), plannedYoga: null,
    weights: h.weights, baselineWeight: lastBefore(h.weights, s, 'weightKg'),
    measurements: h.measurements, baselineMeasurement: lastBefore(h.measurements, s, 'waistCm')
  });
  return Object.assign({
    user, type, targets, goal,
    current: slice(period.start, period.end),
    previous: slice(prev.start, prev.end),
    previous2: slice(prev2.start, prev2.end),
    history: { start: h.start, end: h.end, workouts: h.workouts, meals: h.meals, checkins: h.checkins, yoga: h.yoga, weights: h.weights, measurements: h.measurements, recovery: h.recovery },
    blood,
    photos: [],
    prs: prsFrom(h.workouts, period.start, period.end),
    coins: [],
    sunday: []
  }, extra || {});
}

function seedBundle(type, variant) {
  const kind = type === 'monthly' ? 'monthly' : 'weekly';
  const v = variant || 'normal';
  const period = kind === 'monthly' ? MONTH : WEEK;
  const targets = { mealsPerDay: 3, sleepH: 7, steps: 9000, waterL: 3, protein: 150, calories: 2150, workoutsPerWeek: 4, workoutsPerWeekSource: 'plan', yogaPerWeek: 3 };

  if (v === 'empty') {
    const user = { id: 'seed-empty', name: 'Riya Kapoor', firstName: 'Riya', email: 'riya@example.com', phone: '', goalType: '', timezone: 'Asia/Kolkata' };
    const h = { start: '2026-05-01', end: period.end, workouts: [], meals: [], checkins: [], yoga: [], weights: [], measurements: [], recovery: [] };
    return assemble(kind, user, Object.assign({}, targets, { calories: null, protein: 120 }), { goalType: '', targetWeightKg: null, direction: null }, h, []);
  }

  const rand = mulberry32(20260911);
  const h = normalHistory(rand);
  const user = { id: 'seed-aarav', name: 'Aarav Mehta', firstName: 'Aarav', email: 'aarav@example.com', phone: '+919800000000', goalType: 'fat_loss', timezone: 'Asia/Kolkata' };
  const goal = { goalType: 'fat_loss', targetWeightKg: 78, targetBodyFat: null, direction: 'lose' };
  const extra = {
    coins: [{ date: period.start, type: 'workout_session', coins: 20 }, { date: S.addDays(period.start, 2), type: 'daily_checkin', coins: 10 }, { date: S.addDays(period.start, 4), type: 'daily_goal_water', coins: 5 }],
    sunday: [{ date: S.addDays(period.end, 0), achievements: 'Stayed off sugar on weekdays and hit a bench press PR. Felt much stronger on leg day.', improve: 'Weekend protein' }]
  };

  if (v === 'extreme') {
    const LONG = 'Supercalifragilisticexpialidocious'.repeat(2) + 'x'.repeat(0);
    const TOKEN = 'A'.repeat(60);
    const longName = ('Aaravindhan Venkataraghavan Subramaniam-Krishnamurthy ' + TOKEN + ' ').repeat(4).trim().slice(0, 400);
    user.name = longName; user.firstName = 'Aaravindhan' + TOKEN;
    // 30 sessions a week, absurd volumes, long labels.
    const days = S.datesInRange(S.addDays(period.start, -100), period.end);
    days.forEach((d, i) => {
      for (let k = 0; k < 4; k += 1) {
        h.workouts.push({ date: d, name: TOKEN, completed: true, planned: false, durationMin: 240, rpe: 10, energy: 9, volumeKg: 9876543, muscleVolume: { Chest: 3000000, Back: 3000000, Legs: 3876543 }, lifts: [{ key: 'bench_press', label: LONG, kg: 400 + i, reps: 30 }], source: 'log' });
      }
      h.yoga.push({ date: d, durationMin: 600, style: TOKEN + TOKEN, mobilityScore: 50 + (i % 40), source: 'log' });
      h.meals.push({ date: d, meals: 12, calories: 99999, protein: 9999, carbs: 9999, fat: 9999 });
      h.checkins.push({ date: d, source: 'checkin', sleepH: 23.5, steps: 999999, waterL: 99.9 });
      h.weights.push({ date: d, weightKg: 300 - (i % 50), source: 'scale' });
      h.measurements.push({ date: d, waistCm: 180 - (i % 30), chestCm: 190, hipsCm: 170 + (i % 20), armsCm: 70, thighsCm: 99 });
    });
    const bigMarkers = (val) => Array.from({ length: 40 }, (_, i) => marker('m' + i, (i % 3 === 0 ? TOKEN + ' ' : '') + 'Marker number ' + i + ' with a very long laboratory name ' + 'y'.repeat(i * 8), 'units/unit-' + TOKEN.slice(0, 12), 10, 20, val + i, 'High'));
    const blood = [
      { id: 'x1', date: '2026-02-01', markers: bigMarkers(25), ai: { summary: 'z'.repeat(2000), keyFindings: [] } },
      { id: 'x2', date: S.addDays(period.start, 2), markers: bigMarkers(30), ai: { summary: ('Very long summary ' + TOKEN + ' ').repeat(80), keyFindings: [] } }
    ];
    const ex = {
      coins: Array.from({ length: 80 }, (_, i) => ({ date: S.addDays(period.start, i % 7), type: 'x', coins: 99999 })),
      sunday: [{ date: period.end, achievements: ('An enormous achievement paragraph ' + TOKEN + ' ').repeat(40), improve: TOKEN }],
      prs: Array.from({ length: 12 }, (_, i) => ({ date: period.start, key: 'bench_press', label: LONG + TOKEN, kg: 9999 + i, previousKg: 9998 }))
    };
    const t = Object.assign({}, targets, { steps: 12000, calories: 9000, protein: 900 });
    const b = assemble(kind, user, t, { goalType: 'fat_loss', targetWeightKg: 60, direction: 'lose' }, h, blood, ex);
    b.user.goalType = 'x'.repeat(120);
    return b;
  }

  return assemble(kind, user, targets, goal, h, normalBlood(), extra);
}

module.exports = { seedBundle, WEEK, MONTH };
