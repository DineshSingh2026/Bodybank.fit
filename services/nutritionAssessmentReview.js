'use strict';

/**
 * FitChef Nutrition Assessment — red-flag routing.
 *
 * These are the rules from §11 of the spec, implemented as code that runs on
 * every submission rather than as a checklist a reviewer is trusted to remember.
 * A flag with `block: true` means the submission must NOT receive an
 * auto-generated calorie plan until a human — in two cases a clinician — has
 * signed it off. The admin table shows the flag on the row, so a blocked
 * submission cannot be worked without seeing why.
 *
 * `age_under_18` is the one rule enforced at the door: the route refuses the
 * submission outright rather than storing it, because we should not be holding
 * a minor's health data at all.
 */

const metrics = require('../public/js/nutrition-assessment-metrics');

function has(list, ...values) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  return values.some((v) => arr.indexOf(v) !== -1);
}

/** Phrases that suggest disordered eating rather than ordinary dieting. */
const DISTRESS = /\b(binge|bingeing|binging|purge|purging|vomit|laxative|bulimi|anorexi|starv|eating disorder|self.?harm|hate my body|disgusting|obsess(ed|ive)? (with|about) (food|calories|weight))\b/i;

/**
 * @param {object} answers flat answer map (every step merged)
 * @returns {Array<{code,label,detail,block,clinician}>}
 */
function computeFlags(answers = {}) {
  const flags = [];
  const add = (code, label, detail, opts = {}) =>
    flags.push({ code, label, detail, block: opts.block !== false, clinician: !!opts.clinician });

  const conditions = Array.isArray(answers.conditions) ? answers.conditions : [];
  const d = metrics.derive(answers);

  if (d.age !== null && d.age < 18) {
    add('age_under_18', 'Under 18', 'Submission refused — we do not accept assessments from minors.', { clinician: false });
  }

  if (has(conditions, 'Kidney disease or stones')) {
    add('kidney', 'Kidney disease', 'Protein ceiling required (0.6–0.8 g/kg shown). Needs clinician sign-off before any plan.', { clinician: true });
  }

  if (has(conditions, 'Type 1 diabetes')) {
    add('t1_diabetes', 'Type 1 diabetes', 'Carbohydrate changes interact with insulin dosing. Clinician sign-off required.', { clinician: true });
  } else if (has(conditions, 'Type 2 diabetes') && String(answers.on_insulin || '') === 'Yes') {
    add('t2_insulin', 'T2 diabetes on insulin', 'Deficit plus insulin is a hypoglycaemia risk. Clinician sign-off required.', { clinician: true });
  }

  const preg = String(answers.pregnancy_status || '');
  if (preg === 'Pregnant' || preg === 'Breastfeeding') {
    add('pregnancy', preg, 'No deficit plan. Route to a specialist in maternal nutrition.', { clinician: true });
  }

  const notes = [answers.food_relationship_notes, answers.final_notes, answers.past_success_notes]
    .filter(Boolean).join(' \n ');
  if (String(answers.emotional_eating || '') === 'Very often') {
    add('emotional_eating', 'Emotional eating — very often', 'Do not auto-generate a deficit. Human review, and signpost professional support.');
  } else if (DISTRESS.test(notes)) {
    add('food_distress', 'Distress flagged in free text', 'The member described their relationship with food in terms that need a person, not a plan.');
  }

  if (d.bmi !== null && d.bmi < 18.5 && String(answers.goal_primary || '') === 'Fat loss') {
    add('underweight_fatloss', 'BMI under 18.5 with a fat-loss goal', 'BMI ' + d.bmi + '. Human review before anything is sent.');
  }

  if (has(conditions, 'Cancer (current or past)')) {
    add('cancer', 'Cancer (current or past)', 'Human review — confirm whether treatment is active before planning.', { clinician: true });
  }
  if (has(conditions, 'Recent surgery')) {
    add('recent_surgery', 'Recent surgery', 'Human review — recovery needs a surplus, not a deficit.');
  }
  if (has(conditions, "IBD (Crohn's / colitis)") && String(answers.flare_frequency || '') === 'Currently in a flare') {
    add('ibd_flare', 'IBD flare in progress', 'Human review — fibre and residue targets have to be reversed during a flare.');
  }

  // Pace sanity: more than ~1% of bodyweight per week is not a plan, it is a crash.
  const weight = parseFloat(answers.weight_kg);
  const target = parseFloat(answers.target_weight);
  const pace = String(answers.goal_pace || '');
  if (Number.isFinite(weight) && Number.isFinite(target) && answers.target_date) {
    const weeks = (new Date(answers.target_date) - Date.now()) / (7 * 86400000);
    const delta = Math.abs(weight - target);
    if (weeks > 0 && delta > 0) {
      const perWeek = delta / weeks;
      if (perWeek > weight * 0.01) {
        flags.push({
          code: 'pace_too_fast',
          label: 'Requested pace is unsafe',
          detail: `${perWeek.toFixed(2)} kg/week needed to hit the target date — above 1% of bodyweight. Downgrade to a safe pace and explain why in the report.`,
          block: false,
          clinician: false
        });
      }
    }
  } else if (pace.indexOf('Moderate') === 0 && Number.isFinite(weight) && weight < 60) {
    flags.push({
      code: 'pace_review', label: 'Pace worth a second look',
      detail: '0.5–0.75 kg/week is over 1% of bodyweight at this weight.', block: false, clinician: false
    });
  }

  return flags;
}

/** '' when clear, 'blocked' when anything requires sign-off before a plan goes out. */
function reviewStatus(flags) {
  return (flags || []).some((f) => f.block) ? 'blocked' : '';
}

/** True when the submission must be refused outright rather than stored. */
function isRefused(flags) {
  return (flags || []).some((f) => f.code === 'age_under_18');
}

module.exports = { computeFlags, reviewStatus, isRefused, DISTRESS };
