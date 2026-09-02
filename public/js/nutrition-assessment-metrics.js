/**
 * FitChef Nutrition Assessment — the metabolic maths.
 *
 * Loaded twice, deliberately: the browser pulls it as a <script> so the mid-form
 * teaser can appear the instant the member finishes Step 3 with no network call,
 * and server.js `require()`s the same file so the numbers stored on the record
 * are computed by identical code. One formula, two runtimes — a UMD wrapper is
 * the cheapest way to guarantee the teaser never disagrees with the report.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NAMetrics = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function ageFromDob(dob) {
    if (!dob) return null;
    var d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var a = now.getFullYear() - d.getFullYear();
    var m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
    return a >= 0 && a < 130 ? a : null;
  }

  /** Mifflin–St Jeor. The "self-describe" case takes the midpoint of the two constants. */
  function bmr(sex, weightKg, heightCm, age) {
    var w = num(weightKg), h = num(heightCm), a = num(age);
    if (!w || !h || a === null) return null;
    var base = 10 * w + 6.25 * h - 5 * a;
    var s = String(sex || '').toLowerCase();
    var offset = s.indexOf('male') === 0 ? 5 : (s.indexOf('female') === 0 ? -161 : -78);
    return Math.round(base + offset);
  }

  /**
   * Activity multiplier. Steps and training are separate signals — someone who
   * lifts four times a week but sits at 3k steps is not the same as a field-sales
   * rep who never trains — so each contributes and the total is capped.
   */
  var STEP_MULT = { '<3k': 0.00, '3–5k': 0.05, '5–8k': 0.11, '8–12k': 0.17, '12k+': 0.24, 'Not tracked': 0.08 };
  var TRAIN_MULT = { 'Not currently': 0.00, '1–2× week': 0.06, '3–4× week': 0.12, '5–6× week': 0.18, 'Daily': 0.21 };
  var WORK_MULT = { 'Desk': 0.00, 'Student': 0.01, 'Homemaker': 0.04, 'Between jobs': 0.00, 'Shift or night work': 0.03, 'Field or travel-heavy': 0.06, 'Physical labour': 0.12 };

  function activityFactor(a) {
    a = a || {};
    var f = 1.2
      + (STEP_MULT[a.daily_steps] != null ? STEP_MULT[a.daily_steps] : 0.08)
      + (TRAIN_MULT[a.trains] != null ? TRAIN_MULT[a.trains] : 0)
      + (WORK_MULT[a.occupation_type] != null ? WORK_MULT[a.occupation_type] : 0);
    return Math.round(Math.min(f, 1.9) * 100) / 100;
  }

  function tdee(bmrValue, factor) {
    if (!bmrValue || !factor) return null;
    return Math.round(bmrValue * factor);
  }

  function bmi(weightKg, heightCm) {
    var w = num(weightKg), h = num(heightCm);
    if (!w || !h) return null;
    return Math.round((w / Math.pow(h / 100, 2)) * 10) / 10;
  }

  /** Waist-to-height ratio — a better metabolic-risk read than BMI, and free. */
  function whtr(waistCm, heightCm) {
    var wa = num(waistCm), h = num(heightCm);
    if (!wa || !h) return null;
    return Math.round((wa / h) * 100) / 100;
  }

  function whtrBand(r) {
    if (r === null || r === undefined) return null;
    if (r < 0.40) return { key: 'low', label: 'Below the healthy range', note: 'Worth a look at whether you are under-eating.' };
    if (r < 0.50) return { key: 'ok', label: 'Healthy range', note: 'Your waist is under half your height — where you want it.' };
    if (r < 0.60) return { key: 'raised', label: 'Raised', note: 'Central fat is the kind that matters most metabolically. This is the number we move first.' };
    return { key: 'high', label: 'High', note: 'This is the single most useful number to bring down, and it responds fast.' };
  }

  /**
   * Protein target range in grams/day. Anchored to bodyweight, lifted by training
   * load and a fat-loss goal (protein protects muscle in a deficit), and lowered
   * to a hard ceiling if kidney disease was declared — that case is a clinician's
   * call, so we show a conservative range and flag the submission.
   */
  function proteinTarget(a) {
    a = a || {};
    var w = num(a.weight_kg);
    if (!w) return null;
    var lo = 1.2, hi = 1.6;
    if (a.trains && a.trains !== 'Not currently') { lo = 1.6; hi = 2.0; }
    if (a.goal_primary === 'Muscle gain' || a.goal_primary === 'Body recomposition') { lo = Math.max(lo, 1.8); hi = 2.2; }
    if (a.goal_primary === 'Fat loss') { lo = Math.max(lo, 1.8); hi = Math.max(hi, 2.2); }
    if (a.renal) { lo = 0.6; hi = 0.8; }
    return { low: Math.round(w * lo), high: Math.round(w * hi) };
  }

  /** Calorie target from the goal and the requested pace. */
  var PACE_DELTA = { 'Steady (0.25–0.5 kg/wk)': 0.15, 'Moderate (0.5–0.75 kg/wk)': 0.22 };
  function calorieTarget(tdeeValue, goal, pace) {
    if (!tdeeValue) return null;
    var pct = PACE_DELTA[pace] != null ? PACE_DELTA[pace] : 0.12;
    if (goal === 'Fat loss') return Math.round(tdeeValue * (1 - pct));
    if (goal === 'Muscle gain') return Math.round(tdeeValue * (1 + Math.min(pct, 0.12)));
    if (goal === 'Body recomposition') return Math.round(tdeeValue * 0.95);
    return tdeeValue;
  }

  /**
   * Everything the teaser card and the stored record need, from the flat answer map.
   * Returns nulls rather than throwing when the inputs are not there yet.
   */
  function derive(answers) {
    var a = answers || {};
    var age = ageFromDob(a.dob);
    var b = bmr(a.sex, a.weight_kg, a.height_cm, age);
    var factor = activityFactor(a);
    var t = tdee(b, factor);
    var ratio = whtr(a.waist_cm, a.height_cm);
    var renal = Array.isArray(a.conditions) && a.conditions.indexOf('Kidney disease or stones') !== -1;
    return {
      age: age,
      bmr: b,
      activity_factor: factor,
      tdee: t,
      bmi: bmi(a.weight_kg, a.height_cm),
      whtr: ratio,
      whtr_band: whtrBand(ratio),
      protein_target_g: proteinTarget({
        weight_kg: a.weight_kg, trains: a.trains, goal_primary: a.goal_primary, renal: renal
      }),
      calorie_target: calorieTarget(t, a.goal_primary, a.goal_pace)
    };
  }

  return {
    ageFromDob: ageFromDob, bmr: bmr, tdee: tdee, bmi: bmi, whtr: whtr, whtrBand: whtrBand,
    activityFactor: activityFactor, proteinTarget: proteinTarget, calorieTarget: calorieTarget, derive: derive
  };
}));
