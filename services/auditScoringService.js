'use strict';

// BodyBank — Body Audit scoring service.
// Deterministic: same Part-1 + Part-2 answers => same result. No AI calls.
// Floors are deliberate — a lead's first impression should be honest but never demoralising.

const FLOOR = 30;
const MAX = 100;

function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function normaliseText(value) {
  return String(value == null ? '' : value).toLowerCase().trim();
}

function textLengthBoost(value, lowChars, highChars) {
  const len = normaliseText(value).length;
  if (len <= 0) return 0;
  if (len >= highChars) return 15;
  if (len <= lowChars) return 5;
  const span = highChars - lowChars;
  return Math.round(5 + ((len - lowChars) / span) * 10);
}

function keywordHits(value, words) {
  const text = normaliseText(value);
  if (!text) return 0;
  let hits = 0;
  for (const w of words) {
    if (text.includes(w)) hits += 1;
  }
  return hits;
}

const WORK_INTENSITY_MAP = {
  'sedentary': 25,
  'light': 50,
  'moderate': 75,
  'heavy': 92
};

const ACTIVITY_LEVEL_MAP = {
  'sedentary': 22,
  'light': 48,
  'moderate': 72,
  'high': 92
};

const FITNESS_EXPERIENCE_MAP = {
  'complete beginner': 35,
  'some experience': 58,
  'regular gym-goer': 82,
  'advanced': 95,
  'athletic': 95
};

function mapByPrefix(value, table, fallback = FLOOR) {
  const v = normaliseText(value);
  if (!v) return fallback;
  for (const key of Object.keys(table)) {
    if (v.startsWith(key) || v.includes(key)) return table[key];
  }
  return fallback;
}

// Maps for the new structured fields
const WORKOUTS_PER_WEEK_MAP = {
  '0': 25,
  '1-2': 55,
  '3-4': 80,
  '5-6': 92,
  '7': 95
};

const SLEEP_HOURS_MAP = {
  '<5': 25,
  '5-6': 50,
  '6-7': 72,
  '7-8': 92,
  '8+': 88
};

const SMOKING_MAP = {
  'never': 95,
  'occasional': 60,
  'daily': 30
};

const ALCOHOL_MAP = {
  'never': 95,
  'social': 75,
  'frequent': 48,
  'daily': 30
};

function lookupExact(value, table, fallback) {
  if (value == null) return fallback;
  const v = String(value).toLowerCase().trim();
  if (!v) return fallback;
  return Object.prototype.hasOwnProperty.call(table, v) ? table[v] : fallback;
}

function scoreActivity(part1, part2) {
  const work = mapByPrefix(part1.work_intensity, WORK_INTENSITY_MAP, 40);
  const act = mapByPrefix(part2.activity_level, ACTIVITY_LEVEL_MAP, work);
  const generalActivity = part2.activity_level ? Math.round(work * 0.4 + act * 0.6) : work;

  // Primary signal: structured workouts-per-week
  const wpw = lookupExact(part2.workouts_per_week, WORKOUTS_PER_WEEK_MAP, null);
  if (wpw !== null) {
    // 70% workouts/week + 30% general activity context
    return clamp(Math.round(wpw * 0.7 + generalActivity * 0.3), FLOOR, MAX);
  }
  return clamp(generalActivity, FLOOR, MAX);
}

function scoreTraining(part1, part2) {
  const baseFromExperience = mapByPrefix(part1.fitness_experience, FITNESS_EXPERIENCE_MAP, 40);
  const wpw = lookupExact(part2.workouts_per_week, WORKOUTS_PER_WEEK_MAP, null);

  // Free-text supplementary boost
  const gymText = part2.gym_experience || '';
  const sportText = part2.sports_history || '';
  const positiveHits = keywordHits(`${gymText} ${sportText}`, [
    'years', 'consistent', 'regular', 'routine', 'compete', 'athlete',
    'trainer', 'coach', 'lifting', 'sports', 'team', 'discipline'
  ]);
  const negativeHits = keywordHits(`${gymText} ${sportText}`, [
    'never', 'none', 'no experience', "haven't", 'dont', "don't"
  ]);
  const textBoost = positiveHits * 2 - negativeHits * 3;

  let base;
  if (wpw !== null) {
    // 50% experience tier + 50% frequency — frequency is the honest current-state signal
    base = baseFromExperience * 0.5 + wpw * 0.5;
  } else {
    base = baseFromExperience;
  }
  return clamp(Math.round(base + textBoost), FLOOR, MAX);
}

function scoreNutrition(part2) {
  const food = part2.food_choices || '';
  if (!food.trim()) return 45;
  const good = keywordHits(food, [
    'vegetable', 'veg ', 'salad', 'fruit', 'protein', 'whole grain', 'oats',
    'eggs', 'fish', 'chicken', 'dal', 'paneer', 'tofu', 'home cooked',
    'home-cooked', 'lean', 'roti', 'curd', 'yogurt', 'nuts', 'legumes', 'pulses'
  ]);
  const bad = keywordHits(food, [
    'junk', 'fried', 'fast food', 'soda', 'soft drink', 'chips', 'biscuit',
    'sweet', 'sugar', 'mithai', 'processed', 'maggi', 'pizza', 'burger',
    'cold drink', 'alcohol', 'wafers', 'chocolate', 'ice cream'
  ]);
  const lenBoost = textLengthBoost(food, 40, 300);
  const base = 55 + good * 4 - bad * 5 + Math.round(lenBoost * 0.4);
  return clamp(base, FLOOR, MAX);
}

function scoreMindset(part2) {
  // Text-based engagement signal (secondary now)
  const compelled = part2.what_compelled || '';
  const goals = part2.goals || '';
  const mental = part2.mental_health || '';
  let textScore = 50;
  textScore += textLengthBoost(compelled, 30, 250);
  textScore += textLengthBoost(goals, 30, 250);
  if (mental.trim().length > 20) textScore += 8;
  const positives = keywordHits(`${compelled} ${goals}`, [
    'family', 'kids', 'health', 'energy', 'strength', 'discipline',
    'longevity', 'confidence', 'consistency', 'long term', 'sustainable',
    'transformation', 'lifestyle', 'commit', 'serious'
  ]);
  textScore += positives * 2;
  textScore = clamp(textScore, FLOOR, MAX);

  // Primary signal: stress level (1 = calm, 10 = overwhelmed → inverse)
  const stress = Number(part2.stress_level);
  if (Number.isFinite(stress) && stress >= 1 && stress <= 10) {
    // 1 → 95, 5 → 65, 10 → 30
    const stressScore = clamp(Math.round(95 - (stress - 1) * 7.2), FLOOR, MAX);
    return clamp(Math.round(stressScore * 0.7 + textScore * 0.3), FLOOR, MAX);
  }
  return textScore;
}

function scoreLifestyle(part2) {
  // Primary: structured sleep + smoking + alcohol fields
  const sleep = lookupExact(part2.sleep_hours, SLEEP_HOURS_MAP, null);
  const smoking = lookupExact(part2.smoking, SMOKING_MAP, null);
  const alcohol = lookupExact(part2.alcohol, ALCOHOL_MAP, null);

  const haveAnyStructured = sleep !== null || smoking !== null || alcohol !== null;

  // Secondary: free-text vices fallback
  const vices = part2.vices_addictions || '';
  const noVices = !vices.trim() || /none|nil|no\s|nothing/i.test(vices);
  let viceTextScore = noVices ? 80 : 60;
  const heavyHits = keywordHits(vices, ['smoke', 'smoking', 'cigarette', 'daily drink', 'alcohol daily', 'addiction', 'heavy', 'binge']);
  viceTextScore -= heavyHits * 6;
  const lightHits = keywordHits(vices, ['occasional', 'rarely', 'social', 'sometimes', 'weekend']);
  viceTextScore += lightHits * 2;
  viceTextScore = clamp(viceTextScore, FLOOR, MAX);

  let base;
  if (haveAnyStructured) {
    // Weighted blend: sleep 0.5, smoking 0.25, alcohol 0.25. Missing parts fall back to viceTextScore.
    const sleepPart = sleep !== null ? sleep : viceTextScore;
    const smokingPart = smoking !== null ? smoking : viceTextScore;
    const alcoholPart = alcohol !== null ? alcohol : viceTextScore;
    base = sleepPart * 0.5 + smokingPart * 0.25 + alcoholPart * 0.25;
  } else {
    base = viceTextScore;
  }

  // Injury severity penalty (kept from prior version)
  const injuries = part2.injuries || '';
  if (/ongoing|severe|chronic/i.test(injuries)) base -= 6;
  return clamp(Math.round(base), FLOOR, MAX);
}

const WEIGHTS = {
  activity: 0.20,
  training: 0.25,
  nutrition: 0.20,
  mindset: 0.20,
  lifestyle: 0.15
};

function totalFromSubs(subs) {
  const t =
    subs.activity * WEIGHTS.activity +
    subs.training * WEIGHTS.training +
    subs.nutrition * WEIGHTS.nutrition +
    subs.mindset * WEIGHTS.mindset +
    subs.lifestyle * WEIGHTS.lifestyle;
  return clamp(Math.round(t), FLOOR, MAX);
}

function tierFromScore(score) {
  if (score >= 75) return { key: 'athlete', label: 'Athlete', blurb: 'You already train with intent. Now we sharpen the edges.' };
  if (score >= 55) return { key: 'builder', label: 'Builder', blurb: 'A real base is here. The next 12 weeks are about momentum.' };
  return { key: 'foundation', label: 'Foundation', blurb: 'Every athlete started here. We build it right, not fast.' };
}

function topLever(subs) {
  const entries = Object.entries(subs).sort((a, b) => a[1] - b[1]);
  const [name] = entries[0];
  const labels = {
    activity: 'Daily movement',
    training: 'Structured training',
    nutrition: 'Nutrition',
    mindset: 'Mindset & clarity',
    lifestyle: 'Lifestyle habits'
  };
  return labels[name] || 'Daily movement';
}

function computeAuditResult(part1 = {}, part2 = {}) {
  const subs = {
    activity: scoreActivity(part1, part2),
    training: scoreTraining(part1, part2),
    nutrition: scoreNutrition(part2),
    mindset: scoreMindset(part2),
    lifestyle: scoreLifestyle(part2)
  };
  const total = totalFromSubs(subs);
  const tier = tierFromScore(total);
  return {
    total,
    sub_scores: subs,
    tier_key: tier.key,
    tier_label: tier.label,
    tier_blurb: tier.blurb,
    weak_lever: topLever(subs)
  };
}

module.exports = { computeAuditResult, tierFromScore };
