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

function scoreActivity(part1, part2) {
  const work = mapByPrefix(part1.work_intensity, WORK_INTENSITY_MAP, 40);
  const act = mapByPrefix(part2.activity_level, ACTIVITY_LEVEL_MAP, work);
  const blended = part2.activity_level ? Math.round(work * 0.4 + act * 0.6) : work;
  return clamp(blended, FLOOR, MAX);
}

function scoreTraining(part1, part2) {
  const base = mapByPrefix(part1.fitness_experience, FITNESS_EXPERIENCE_MAP, 40);
  const gymText = part2.gym_experience || '';
  const sportText = part2.sports_history || '';
  const positiveHits = keywordHits(`${gymText} ${sportText}`, [
    'years', 'consistent', 'regular', 'routine', 'compete', 'athlete',
    'trainer', 'coach', 'lifting', 'sports', 'team', 'discipline'
  ]);
  const negativeHits = keywordHits(`${gymText} ${sportText}`, [
    'never', 'none', 'no experience', 'haven\'t', 'dont', "don't"
  ]);
  const boost = positiveHits * 3 - negativeHits * 4;
  return clamp(base + boost, FLOOR, MAX);
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
  const compelled = part2.what_compelled || '';
  const goals = part2.goals || '';
  const mental = part2.mental_health || '';
  let base = 50;
  base += textLengthBoost(compelled, 30, 250);
  base += textLengthBoost(goals, 30, 250);
  if (mental.trim().length > 20) base += 8;
  const positives = keywordHits(`${compelled} ${goals}`, [
    'family', 'kids', 'health', 'energy', 'strength', 'discipline',
    'longevity', 'confidence', 'consistency', 'long term', 'sustainable',
    'transformation', 'lifestyle', 'commit', 'serious'
  ]);
  base += positives * 2;
  return clamp(base, FLOOR, MAX);
}

function scoreLifestyle(part2) {
  const vices = part2.vices_addictions || '';
  const injuries = part2.injuries || '';
  const noVices = !vices.trim() || /none|nil|no\s|nothing/i.test(vices);
  let base = noVices ? 85 : 60;
  const heavyHits = keywordHits(vices, [
    'smoke', 'smoking', 'cigarette', 'daily drink', 'alcohol daily',
    'addiction', 'heavy', 'binge'
  ]);
  base -= heavyHits * 6;
  const lightHits = keywordHits(vices, [
    'occasional', 'rarely', 'social', 'sometimes', 'weekend'
  ]);
  base += lightHits * 2;
  if (/ongoing|severe|chronic/i.test(injuries)) base -= 6;
  return clamp(base, FLOOR, MAX);
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
