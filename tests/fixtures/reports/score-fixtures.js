'use strict';

/**
 * Hand-built datasets for tests/report-score.js. Every number here was chosen
 * so the expected pillar scores can be worked out on paper — the arithmetic is
 * written next to each assertion in the test.
 *
 * Period: Mon 2026-09-07 .. Sun 2026-09-13 (weekly).
 */

const START = '2026-09-07';
const END = '2026-09-13';
const PREV_START = '2026-08-31';
const PREV_END = '2026-09-06';
const DAYS = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'];
const PREV_DAYS = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];

const TARGETS = { mealsPerDay: 3, sleepH: 7, steps: 8000, waterL: 3, protein: 150, calories: 2200, workoutsPerWeek: 4, yogaPerWeek: 3 };

function bloodReports(inPeriod) {
  return [
    { date: '2026-05-01', markers: [
      { key: 'hemoglobin', name: 'Hemoglobin', value: 12.8, unit: 'g/dL', low: 13.5, high: 17.5 },
      { key: 'vitamin d', name: 'Vitamin D', value: 24, unit: 'ng/mL', low: 30, high: 100 }
    ] },
    { date: inPeriod ? '2026-09-09' : '2026-08-01', markers: [
      { key: 'hemoglobin', name: 'Hemoglobin', value: 14.1, unit: 'g/dL', low: 13.5, high: 17.5 },
      { key: 'vitamin d', name: 'Vitamin D', value: 28, unit: 'ng/mL', low: 30, high: 100 }
    ] }
  ];
}

/** Everything done, volume +20% on last week, mobility up >20%, weight on track. */
function perfectWeek() {
  const workoutDays = [DAYS[0], DAYS[1], DAYS[3], DAYS[4]];
  const cur = {
    period: { start: START, end: END },
    targets: TARGETS,
    goal: { direction: 'lose', targetWeightKg: 75 },
    plannedWorkouts: 4,
    workouts: workoutDays.map((d) => ({ date: d, planned: true, completed: true, volumeKg: 3000, rpe: 8, durationMin: 60 })),
    meals: DAYS.map((d) => ({ date: d, meals: 3, calories: 2200, protein: 160, carbs: 220, fat: 70 })),
    checkins: DAYS.map((d) => ({ date: d, source: 'checkin', sleepH: 7.5, steps: 10000, waterL: 3.2 })),
    yoga: [DAYS[2], DAYS[5], DAYS[6]].map((d) => ({ date: d, durationMin: 30, style: 'Hatha', mobilityScore: 80 })),
    weights: [{ date: DAYS[6], weightKg: 79.5 }],
    baselineWeight: { date: PREV_DAYS[6], weightKg: 80 },
    measurements: [],
    blood: bloodReports(true)
  };
  cur.blood[1].markers[1].value = 34; // vitamin D back in range
  const prev = {
    period: { start: PREV_START, end: PREV_END },
    targets: TARGETS,
    goal: { direction: 'lose', targetWeightKg: 75 },
    plannedWorkouts: 4,
    workouts: [PREV_DAYS[0], PREV_DAYS[2], PREV_DAYS[4], PREV_DAYS[5]].map((d) => ({ date: d, planned: true, completed: true, volumeKg: 2500, rpe: 8 })),
    meals: PREV_DAYS.map((d) => ({ date: d, meals: 3, calories: 2200, protein: 160 })),
    checkins: PREV_DAYS.map((d) => ({ date: d, source: 'checkin', sleepH: 7.5, steps: 10000, waterL: 3.2 })),
    yoga: [PREV_DAYS[1], PREV_DAYS[3], PREV_DAYS[6]].map((d) => ({ date: d, durationMin: 30, mobilityScore: 66 })),
    weights: [],
    blood: bloodReports(true).slice(0, 1)
  };
  return { cur, prev };
}

/** Nothing logged, this week or last. */
function emptyWeek() {
  return {
    cur: { period: { start: START, end: END }, targets: TARGETS },
    prev: { period: { start: PREV_START, end: PREV_END }, targets: TARGETS }
  };
}

/**
 * Half a week. Worked numbers:
 *   workouts  planned 4, done 2 (d1, d3), volume 9000 vs 10000 last week, RPE 6
 *   meals     d1 3 meals 2200/160, d2 3 meals 2500/140, d3 2 meals 1500/90, d4 1 meal 700/40
 *   check-ins d1..d4: sleep 7.5/6/8/6.5, steps 9000/5000/8000/3000, water 3.0/2.0/3.5/1.0
 *   yoga      1 session (d6), no mobility score
 *   body      no new weigh-in, no new blood -> health redistributed
 */
function partialWeek() {
  const cur = {
    period: { start: START, end: END },
    targets: TARGETS,
    goal: { direction: 'lose', targetWeightKg: 75 },
    plannedWorkouts: 4,
    workouts: [
      { date: DAYS[0], planned: true, completed: true, volumeKg: 5000, rpe: 6 },
      { date: DAYS[2], planned: true, completed: true, volumeKg: 4000, rpe: 6 },
      { date: DAYS[4], planned: true, completed: false },
      { date: DAYS[5], planned: true, completed: false }
    ],
    meals: [
      { date: DAYS[0], meals: 3, calories: 2200, protein: 160 },
      { date: DAYS[1], meals: 3, calories: 2500, protein: 140 },
      { date: DAYS[2], meals: 2, calories: 1500, protein: 90 },
      { date: DAYS[3], meals: 1, calories: 700, protein: 40 }
    ],
    checkins: [
      { date: DAYS[0], source: 'checkin', sleepH: 7.5, steps: 9000, waterL: 3.0 },
      { date: DAYS[1], source: 'checkin', sleepH: 6, steps: 5000, waterL: 2.0 },
      { date: DAYS[2], source: 'checkin', sleepH: 8, steps: 8000, waterL: 3.5 },
      { date: DAYS[3], source: 'checkin', sleepH: 6.5, steps: 3000, waterL: 1.0 }
    ],
    yoga: [{ date: DAYS[5], durationMin: 20, style: 'Surya Namaskar', mobilityScore: null }],
    weights: [],
    baselineWeight: { date: '2026-08-20', weightKg: 81 },
    measurements: [],
    blood: bloodReports(false)
  };
  const prev = {
    period: { start: PREV_START, end: PREV_END },
    targets: TARGETS,
    plannedWorkouts: 4,
    workouts: [
      { date: PREV_DAYS[0], planned: true, completed: true, volumeKg: 4000, rpe: 7 },
      { date: PREV_DAYS[2], planned: true, completed: true, volumeKg: 3000, rpe: 7 },
      { date: PREV_DAYS[4], planned: true, completed: true, volumeKg: 3000, rpe: 7 }
    ],
    meals: PREV_DAYS.slice(0, 2).map((d) => ({ date: d, meals: 2, calories: 1800, protein: 100 })),
    checkins: PREV_DAYS.slice(0, 5).map((d) => ({ date: d, source: 'checkin', sleepH: 7, steps: 8500, waterL: 3 })),
    yoga: []
  };
  return { cur, prev };
}

module.exports = { perfectWeek, emptyWeek, partialWeek, START, END, DAYS, TARGETS };
