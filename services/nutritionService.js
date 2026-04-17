'use strict';

const { todayYmdInTz, STREAK_TZ } = require('./streakService');

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'snack', 'dinner']);
const DEFAULT_CAL_GOAL = 2000;
const DEFAULT_PRO_GOAL = 150;

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function computeMealScore(aiResult) {
  const calories = Math.max(1, clampInt(aiResult.calories, 1, 20000));
  const protein = clampInt(aiResult.protein, 0, 1000);
  const carbs = clampInt(aiResult.carbs, 0, 2000);
  const fat = clampInt(aiResult.fat, 0, 2000);
  const fiber = clampInt(aiResult.fiber, 0, 200);

  let score = 0;
  const proteinDensity = ((protein * 4) / calories) * 100;
  if (proteinDensity >= 25) score += 3;
  else if (proteinDensity >= 15) score += 2;
  else score += 1;

  const fatPct = ((fat * 9) / calories) * 100;
  if (fatPct <= 30) score += 2;
  else if (fatPct <= 40) score += 1;

  if (fiber >= 6) score += 2;
  else if (fiber >= 3) score += 1;

  if (calories >= 300 && calories <= 700) score += 2;
  else if (calories >= 200 && calories <= 900) score += 1;

  const carbPct = ((carbs * 4) / calories) * 100;
  if (carbPct <= 55) score += 1;

  return Math.min(10, Math.max(1, score));
}

function parseAnthropicJson(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAiResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const confidence = String(raw.confidence || 'medium').toLowerCase();
  const conf = ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium';
  return {
    dish: String(raw.dish || 'Meal').slice(0, 200),
    description: '',
    serving: String(raw.serving || '').slice(0, 120),
    calories: clampInt(raw.calories, 0, 15000),
    protein: clampInt(raw.protein, 0, 500),
    carbs: clampInt(raw.carbs, 0, 2000),
    fat: clampInt(raw.fat, 0, 2000),
    fiber: clampInt(raw.fiber, 0, 200),
    sodium: clampInt(raw.sodium, 0, 20000),
    weight: clampInt(raw.weight, 0, 5000),
    confidence: conf,
    tips: ''
  };
}

/**
 * Confidence policy for nutrition AI output.
 * Returns a stable UI-safe label users can understand without reading model internals.
 */
function classifyMealConfidence({ aiResult, hasImage, hasManualNote, source }) {
  const src = String(source || 'ai').toLowerCase();
  if (src === 'manual') {
    return {
      level: 'high',
      label: 'High confidence (manual entry)',
      score: 5
    };
  }

  const conf = String((aiResult && aiResult.confidence) || '').toLowerCase();
  let score = conf === 'high' ? 4 : conf === 'medium' ? 3 : conf === 'low' ? 1 : 2;
  if (hasImage) score += 1;
  if (hasManualNote) score += 1;

  const calories = Number(aiResult && aiResult.calories);
  const protein = Number(aiResult && aiResult.protein);
  const carbs = Number(aiResult && aiResult.carbs);
  const fat = Number(aiResult && aiResult.fat);
  if (![calories, protein, carbs, fat].every((n) => Number.isFinite(n))) score -= 1;

  score = Math.max(0, Math.min(5, score));
  let level = 'low';
  let label = 'Low confidence';
  if (score >= 4) {
    level = 'high';
    label = 'High confidence';
  } else if (score >= 2) {
    level = 'medium';
    label = 'Moderate confidence';
  }
  return { level, label, score };
}

function summarizeDailyConfidence(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return { level: 'low', label: 'Low confidence', score: 0, meals: 0 };
  }
  const sum = list.reduce((s, it) => s + (Number(it && it.score) || 0), 0);
  const avg = sum / list.length;
  let level = 'low';
  let label = 'Low confidence';
  if (avg >= 4) {
    level = 'high';
    label = 'High confidence';
  } else if (avg >= 2) {
    level = 'medium';
    label = 'Moderate confidence';
  }
  return {
    level,
    label,
    score: Math.round(avg * 10) / 10,
    meals: list.length,
    lowMeals: list.filter((x) => x && x.level === 'low').length
  };
}

function buildSystemPrompt(portionSize, manualNote) {
  const ps = portionSize || 'medium';
  const note = (manualNote || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  return `You are a nutrition macro estimator. Keep output compact and numeric-first.

ACCURACY RULES:
- If the portion appears ${ps}, adjust calorie estimates accordingly: small=-25%, medium=baseline, large=+35%
- If user provided a manual description: "${note}", use this to confirm or correct your visual analysis
- For mixed dishes (thali, biryani, dal-rice), estimate each component separately then sum
- Always provide realistic ranges; use the midpoint as your estimate
- Sodium estimates for Indian food: add 200-400mg for home cooking, 400-800mg for restaurant
- IMPORTANT: Keep text very short to reduce token usage. No paragraphs.

Return ONLY valid JSON, no markdown, no explanation:
{
  "dish": "short dish name",
  "description": "",
  "serving": "short serving text",
  "weight": 380,
  "calories": 520,
  "protein": 28,
  "carbs": 62,
  "fat": 16,
  "fiber": 6,
  "sodium": 680,
  "confidence": "high",
  "tips": ""
}
All numeric values must be integers. confidence must be exactly: high, medium, or low.`;
}

/** Map Anthropic HTTP errors to short, actionable messages for the app UI. */
function formatAnthropicApiError(status, data) {
  const raw =
    data && data.error && typeof data.error.message === 'string'
      ? data.error.message
      : data && typeof data.error === 'string'
        ? data.error
        : '';
  const low = raw.toLowerCase();
  if (
    low.includes('credit') ||
    low.includes('billing') ||
    low.includes('balance') ||
    low.includes('purchase') ||
    low.includes('plans & billing')
  ) {
    return (
      'Anthropic API has no credits on this key. Open https://console.anthropic.com → Plans & billing, add credits, ' +
      'put the key in ANTHROPIC_API_KEY on your server, then restart.'
    );
  }
  if (status === 401 || (low.includes('invalid') && low.includes('api key'))) {
    return 'Nutrition AI: Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your server .env and restart.';
  }
  if (status === 429 || low.includes('rate limit')) {
    return 'Nutrition AI is temporarily rate-limited. Try again in a minute.';
  }
  if (raw) return raw.length > 280 ? raw.slice(0, 277) + '…' : raw;
  return `Claude API error (${status})`;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function estimateAnthropicUsageCost(inputTokens, outputTokens) {
  const usdToInr = toNumber(process.env.AI_COST_USD_TO_INR, 83);
  const inputPerMillionUsd = toNumber(process.env.ANTHROPIC_INPUT_PER_MILLION_USD, 3);
  const outputPerMillionUsd = toNumber(process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD, 15);
  const inUsd =
    (toNumber(inputTokens, 0) / 1000000) * inputPerMillionUsd +
    (toNumber(outputTokens, 0) / 1000000) * outputPerMillionUsd;
  const inInr = inUsd * usdToInr;
  return {
    estimated_cost_usd: Number(inUsd.toFixed(6)),
    estimated_cost_inr: Number(inInr.toFixed(4))
  };
}

function macroDerivedCalories(aiResult) {
  const protein = toNumber(aiResult && aiResult.protein, 0);
  const carbs = toNumber(aiResult && aiResult.carbs, 0);
  const fat = toNumber(aiResult && aiResult.fat, 0);
  return protein * 4 + carbs * 4 + fat * 9;
}

function calorieMacroGapPct(aiResult) {
  const calories = Math.max(1, toNumber(aiResult && aiResult.calories, 0));
  const derived = macroDerivedCalories(aiResult);
  return Math.abs(calories - derived) / calories;
}

async function callClaudeNutrition({
  apiKey,
  model,
  imageBase64,
  mimeType,
  mealType,
  portionSize,
  manualNote
}) {
  const system = buildSystemPrompt(portionSize, manualNote);
  const userText = `Analyze this ${mealType} meal. Portion size observed: ${portionSize || 'medium'}. ${manualNote ? `User note: ${manualNote}` : ''} Give complete nutritional breakdown.`;

  const content = [];
  if (imageBase64 && String(imageBase64).length > 50) {
    const mt = mimeType && /^image\/(jpeg|png|gif|webp)$/i.test(mimeType) ? mimeType : 'image/jpeg';
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mt, data: String(imageBase64).replace(/\s/g, '') }
    });
  }
  content.push({ type: 'text', text: userText });

  async function invokeOnce() {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 450,
        temperature: 0,
        system,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = formatAnthropicApiError(res.status, data);
      if (res.status === 402 || res.status === 403) {
        console.warn('[nutrition/claude]', res.status, data && data.error);
      } else {
        console.warn('[nutrition/claude]', res.status, (data && data.error) || data);
      }
      throw new Error(msg);
    }
    const block = (data.content || []).find((b) => b.type === 'text');
    const text = block && block.text ? block.text : '';
    const parsed = parseAnthropicJson(text);
    const aiResult = normalizeAiResult(parsed);
    if (!aiResult) throw new Error('Could not parse nutrition response from AI');
    const inputTokens = toNumber(data && data.usage && data.usage.input_tokens, 0);
    const outputTokens = toNumber(data && data.usage && data.usage.output_tokens, 0);
    const usage = {
      provider: 'anthropic',
      model: String(model || ''),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...estimateAnthropicUsageCost(inputTokens, outputTokens)
    };
    return { aiResult, rawText: text, usage };
  }

  const first = await invokeOnce();
  const firstGap = calorieMacroGapPct(first.aiResult);
  if (firstGap <= 0.15) return first;

  const second = await invokeOnce();
  const secondGap = calorieMacroGapPct(second.aiResult);
  return secondGap <= firstGap ? second : first;
}

async function validateNutritionMealInput({
  apiKey,
  model,
  imageBase64,
  mimeType,
  mealType,
  manualNote
}) {
  const textNote = String(manualNote || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const content = [];
  if (imageBase64 && String(imageBase64).length > 50) {
    const mt = mimeType && /^image\/(jpeg|png|gif|webp)$/i.test(mimeType) ? mimeType : 'image/jpeg';
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mt, data: String(imageBase64).replace(/\s/g, '') }
    });
  }
  content.push({
    type: 'text',
    text: `Meal type: ${String(mealType || '').slice(0, 40)}. User note: ${textNote || '(none)'}`
  });
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        system: `You are a strict food-input validator for a nutrition app.
Return ONLY valid JSON:
{
  "is_food_meal": true,
  "confidence": "high|medium|low",
  "reason": "short reason"
}
Mark is_food_meal=false when input appears non-food (documents, faces, pets, random objects, scenery, gym equipment, screenshots, forms, medicine strips without meal context).`,
        messages: [{ role: 'user', content }]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(formatAnthropicApiError(res.status, data));
    }
    const block = (data.content || []).find((b) => b.type === 'text');
    const parsed = parseAnthropicJson(block && block.text ? block.text : '');
    const decision = !!(parsed && parsed.is_food_meal === true);
    const confidence = String((parsed && parsed.confidence) || 'low').toLowerCase();
    const reason = String((parsed && parsed.reason) || '').trim().slice(0, 200);
    return {
      isFoodMeal: decision,
      confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
      reason: reason || (decision ? 'Looks like a food meal entry.' : 'Input does not appear to be a meal.')
    };
  } catch (_) {
    // Fail-open to avoid blocking valid users during transient validator issues.
    return { isFoodMeal: true, confidence: 'low', reason: 'Validation unavailable; allowed.' };
  }
}

async function getUserGoals(db, userId) {
  const row = await db.queryOne(
    'SELECT target_weight, weekly_workout_target FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  let calorieGoal = DEFAULT_CAL_GOAL;
  let proteinGoal = DEFAULT_PRO_GOAL;
  if (row && row.weekly_workout_target != null) {
    /* optional: nudge goals — keep defaults unless you add columns later */
  }
  return { calorieGoal, proteinGoal };
}

/** Estimated workout kcal burned: use logged calories when present, else ~5 kcal/min from duration */
async function sumWorkoutCaloriesOut(db, userId, ymd) {
  const rows = await db.queryAll(
    `SELECT duration_seconds, calories, workout_completed
     FROM workout_logs
     WHERE user_id = ?
       AND (
         (session_date IS NOT NULL AND session_date = ?::date)
         OR (session_date IS NULL AND created_at::date = ?::date)
       )`,
    [userId, ymd, ymd]
  );
  let sum = 0;
  (rows || []).forEach((w) => {
    const c = w.calories != null ? parseInt(w.calories, 10) : NaN;
    if (Number.isFinite(c) && c > 0) sum += c;
    else {
      const sec = parseInt(w.duration_seconds, 10) || 0;
      const min = sec / 60;
      sum += Math.round(min * 5);
    }
  });
  return sum;
}

/**
 * Resolve lightweight anthropometric profile for step-calorie estimation.
 * Uses latest known values and safe defaults when profile data is missing.
 */
async function getUserEnergyProfile(db, userId) {
  const user = await db.queryOne('SELECT id, email FROM users WHERE id = ?', [userId]);
  const email = user && user.email ? String(user.email).trim().toLowerCase() : '';

  let weightKg = null;
  const wl = await db.queryOne(
    `SELECT weight_kg
     FROM weight_logs
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  if (wl && wl.weight_kg != null) weightKg = Number(wl.weight_kg);

  if (!Number.isFinite(weightKg) && email) {
    const tm = await db.queryOne(
      `SELECT current_weight, target_weight
       FROM tribe_members
       WHERE LOWER(email) = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );
    if (tm && tm.current_weight != null) weightKg = Number(tm.current_weight);
    else if (tm && tm.target_weight != null) weightKg = Number(tm.target_weight);
  }

  if (!Number.isFinite(weightKg)) {
    const ug = await db.queryOne(
      `SELECT target_weight
       FROM user_goals
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );
    if (ug && ug.target_weight != null) weightKg = Number(ug.target_weight);
  }

  if (!Number.isFinite(weightKg) || weightKg <= 0) weightKg = 70;

  let sex = '';
  if (email) {
    const ar = await db.queryOne(
      `SELECT sex
       FROM audit_requests
       WHERE LOWER(email) = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );
    sex = String((ar && ar.sex) || '').toLowerCase();
  }
  const isFemale = /^(f|female|woman|girl)$/.test(sex);

  // Conservative walking defaults (sports-science friendly for broad populations).
  const strideMeters = isFemale ? 0.70 : 0.78;
  const kcalPerKgPerKm = isFemale ? 0.72 : 0.78;
  return { weightKg, strideMeters, kcalPerKgPerKm };
}

/** Step kcal estimate from date-scoped daily checkin steps. */
async function sumStepCaloriesOut(db, userId, ymd) {
  const row = await db.queryOne(
    'SELECT steps FROM daily_checkins WHERE user_id = ? AND checkin_date = ?::date LIMIT 1',
    [userId, ymd]
  );
  const steps = row && row.steps != null ? Number(row.steps) : 0;
  if (!Number.isFinite(steps) || steps <= 0) return 0;
  const profile = await getUserEnergyProfile(db, userId);
  const distanceKm = (steps * profile.strideMeters) / 1000;
  const kcal = distanceKm * profile.weightKg * profile.kcalPerKgPerKm;
  return Math.max(0, Math.round(kcal));
}

async function recomputeDailyStats(db, userId, ymd) {
  const meals = await db.queryAll(
    'SELECT ai_result, meal_score FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date',
    [userId, ymd]
  );
  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let totalFiber = 0;
  let scoreSum = 0;
  let scoreN = 0;
  (meals || []).forEach((m) => {
    let ar = m.ai_result;
    if (typeof ar === 'string') {
      try {
        ar = JSON.parse(ar);
      } catch {
        ar = {};
      }
    }
    if (!ar || typeof ar !== 'object') return;
    totalCalories += clampInt(ar.calories, 0, 20000);
    totalProtein += clampInt(ar.protein, 0, 500);
    totalCarbs += clampInt(ar.carbs, 0, 2000);
    totalFat += clampInt(ar.fat, 0, 2000);
    totalFiber += clampInt(ar.fiber, 0, 200);
    if (m.meal_score != null) {
      scoreSum += Number(m.meal_score);
      scoreN += 1;
    }
  });
  const mealsLogged = (meals || []).length;
  const { calorieGoal, proteinGoal } = await getUserGoals(db, userId);
  const workoutCaloriesOut = await sumWorkoutCaloriesOut(db, userId, ymd);
  const stepCaloriesOut = await sumStepCaloriesOut(db, userId, ymd);
  const caloriesOut = workoutCaloriesOut + stepCaloriesOut;
  const energyDifference = caloriesOut - totalCalories;

  const weekAgg = await db.queryAll(
    `SELECT log_date,
            SUM(COALESCE((ai_result->>'calories')::int, 0)) AS cals,
            SUM(COALESCE((ai_result->>'protein')::int, 0)) AS pros
     FROM nutrition_meal_logs
     WHERE user_id = ? AND log_date >= (?::date - INTERVAL '6 days') AND log_date <= ?::date
     GROUP BY log_date`,
    [userId, ymd, ymd]
  );
  const dayMap = new Map();
  (weekAgg || []).forEach((r) => {
    const d = String(r.log_date).slice(0, 10);
    dayMap.set(d, { cals: parseInt(r.cals, 10) || 0, pros: parseInt(r.pros, 10) || 0 });
  });
  dayMap.set(ymd, { cals: totalCalories, pros: totalProtein });
  const vals = [...dayMap.values()];
  const n = Math.max(1, vals.length);
  const weeklyAvgCalories = Math.round(vals.reduce((s, v) => s + v.cals, 0) / n);
  const weeklyAvgProtein = Math.round(vals.reduce((s, v) => s + v.pros, 0) / n);
  const mealQualityScore = scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null;

  await db.run(
    `INSERT INTO nutrition_daily_stats (
      user_id, stat_date, total_calories, total_protein, total_carbs, total_fat, total_fiber,
      calorie_goal, protein_goal, meals_logged, calories_out, workout_calories_out, step_calories_out, energy_difference,
      weekly_avg_calories, weekly_avg_protein, meal_quality_score, updated_at
    ) VALUES (?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, stat_date) DO UPDATE SET
      total_calories = EXCLUDED.total_calories,
      total_protein = EXCLUDED.total_protein,
      total_carbs = EXCLUDED.total_carbs,
      total_fat = EXCLUDED.total_fat,
      total_fiber = EXCLUDED.total_fiber,
      calorie_goal = EXCLUDED.calorie_goal,
      protein_goal = EXCLUDED.protein_goal,
      meals_logged = EXCLUDED.meals_logged,
      calories_out = EXCLUDED.calories_out,
      workout_calories_out = EXCLUDED.workout_calories_out,
      step_calories_out = EXCLUDED.step_calories_out,
      energy_difference = EXCLUDED.energy_difference,
      weekly_avg_calories = EXCLUDED.weekly_avg_calories,
      weekly_avg_protein = EXCLUDED.weekly_avg_protein,
      meal_quality_score = EXCLUDED.meal_quality_score,
      updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      ymd,
      totalCalories,
      totalProtein,
      totalCarbs,
      totalFat,
      totalFiber,
      calorieGoal,
      proteinGoal,
      mealsLogged,
      caloriesOut,
      workoutCaloriesOut,
      stepCaloriesOut,
      energyDifference,
      weeklyAvgCalories,
      weeklyAvgProtein,
      mealQualityScore
    ]
  );

  return {
    totalCalories,
    totalProtein,
    totalCarbs,
    totalFat,
    totalFiber,
    calorieGoal,
    proteinGoal,
    mealsLogged,
    caloriesOut,
    workoutCaloriesOut,
    stepCaloriesOut,
    energyDifference,
    weeklyAvgCalories,
    weeklyAvgProtein,
    mealQualityScore
  };
}

async function countMealsForDay(db, userId, ymd) {
  const row = await db.queryOne(
    'SELECT COUNT(*)::int AS c FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date',
    [userId, ymd]
  );
  return row && row.c != null ? Number(row.c) : 0;
}

/**
 * Last-N-days nutrition snapshot for blood report PDF / clinical pass (Postgres rows).
 * Shape matches ReportLab `nutrition_analysis` section (averages, top_meals, meal_quality_score).
 */
async function computeNutritionSummaryForUserWindow(db, userId, startYmd, endYmd) {
  const rows = await db.queryAll(
    `SELECT log_date::text AS log_date, ai_result, meal_score
     FROM nutrition_meal_logs
     WHERE user_id = ? AND log_date >= ?::date AND log_date <= ?::date`,
    [userId, startYmd, endYmd]
  );
  if (!rows || !rows.length) return null;

  const daySet = new Set();
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  const mealFreq = {};

  for (const row of rows) {
    const ymd = String(row.log_date || '').slice(0, 10);
    if (ymd) daySet.add(ymd);
    let ar = row.ai_result;
    if (typeof ar === 'string') {
      try {
        ar = JSON.parse(ar);
      } catch {
        ar = null;
      }
    }
    if (!ar || typeof ar !== 'object') continue;
    totals.calories += Number(ar.calories) || 0;
    totals.protein += Number(ar.protein) || 0;
    totals.carbs += Number(ar.carbs) || 0;
    totals.fat += Number(ar.fat) || 0;
    totals.fiber += Number(ar.fiber) || 0;
    const dish = String(ar.dish || '').trim();
    if (dish) {
      if (!mealFreq[dish]) mealFreq[dish] = { count: 0, totalCal: 0 };
      mealFreq[dish].count += 1;
      mealFreq[dish].totalCal += Number(ar.calories) || 0;
    }
  }

  const days = Math.max(1, daySet.size);
  const topMeals = Object.entries(mealFreq)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([name, d]) => {
      const avgCal = Math.round(d.totalCal / d.count);
      return {
        name,
        frequency: d.count,
        avg_calories: avgCal,
        assessment: avgCal < 400 ? 'Good' : avgCal < 700 ? 'Fair' : 'Poor'
      };
    });

  const scores = rows.map((r) => r.meal_score).filter((x) => x != null && Number.isFinite(Number(x)));
  const avgScore = scores.length
    ? parseFloat((scores.reduce((s, v) => s + Number(v), 0) / scores.length).toFixed(1))
    : null;

  return {
    days_tracked: daySet.size,
    averages: {
      calories: Math.round(totals.calories / days),
      protein: Math.round(totals.protein / days),
      carbs: Math.round(totals.carbs / days),
      fat: Math.round(totals.fat / days),
      fiber: Math.round(totals.fiber / days)
    },
    meal_quality_score: avgScore,
    quality_interpretation: !avgScore
      ? 'No data'
      : avgScore >= 7
        ? 'Good overall diet quality'
        : avgScore >= 5
          ? 'Moderate — some areas for improvement'
          : 'Below average — significant dietary changes recommended',
    top_meals: topMeals
  };
}

async function nutritionLoggingStreak(db, userId) {
  const rows = await db.queryAll(
    `SELECT DISTINCT log_date FROM nutrition_meal_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT 400`,
    [userId]
  );
  const set = new Set((rows || []).map((r) => String(r.log_date).slice(0, 10)));
  let streak = 0;
  let cursor = todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
  const addDays = (ymd, d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
    if (!m) return null;
    const dt = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    dt.setUTCDate(dt.getUTCDate() + d);
    return dt.toISOString().slice(0, 10);
  };
  if (!set.has(cursor)) cursor = addDays(cursor, -1);
  for (let i = 0; i < 400; i++) {
    if (!cursor || !set.has(cursor)) break;
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

module.exports = {
  MEAL_TYPES,
  computeMealScore,
  callClaudeNutrition,
  normalizeAiResult,
  parseAnthropicJson,
  formatAnthropicApiError,
  getUserGoals,
  sumWorkoutCaloriesOut,
  recomputeDailyStats,
  countMealsForDay,
  nutritionLoggingStreak,
  computeNutritionSummaryForUserWindow,
  validateNutritionMealInput,
  classifyMealConfidence,
  summarizeDailyConfidence,
  todayYmdInTz,
  STREAK_TZ,
  DEFAULT_CAL_GOAL,
  DEFAULT_PRO_GOAL
};
