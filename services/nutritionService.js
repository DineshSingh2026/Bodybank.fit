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
    description: String(raw.description || '').slice(0, 500),
    serving: String(raw.serving || '').slice(0, 120),
    calories: clampInt(raw.calories, 0, 15000),
    protein: clampInt(raw.protein, 0, 500),
    carbs: clampInt(raw.carbs, 0, 2000),
    fat: clampInt(raw.fat, 0, 2000),
    fiber: clampInt(raw.fiber, 0, 200),
    sodium: clampInt(raw.sodium, 0, 20000),
    weight: clampInt(raw.weight, 0, 5000),
    confidence: conf,
    tips: String(raw.tips || '').slice(0, 500)
  };
}

function buildSystemPrompt(portionSize, manualNote) {
  const ps = portionSize || 'medium';
  const note = (manualNote || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  return `You are a professional sports nutritionist and food recognition AI with expertise in Indian, Asian, and international cuisines. Analyze the meal photo with maximum accuracy.

ACCURACY RULES:
- If the portion appears ${ps}, adjust calorie estimates accordingly: small=-25%, medium=baseline, large=+35%
- If user provided a manual description: "${note}", use this to confirm or correct your visual analysis
- For mixed dishes (thali, biryani, dal-rice), estimate each component separately then sum
- Always provide realistic ranges; use the midpoint as your estimate
- Sodium estimates for Indian food: add 200-400mg for home cooking, 400-800mg for restaurant

Return ONLY valid JSON, no markdown, no explanation:
{
  "dish": "exact dish name",
  "description": "brief description including cooking method",
  "serving": "estimated serving size e.g. 1 plate ~380g",
  "weight": 380,
  "calories": 520,
  "protein": 28,
  "carbs": 62,
  "fat": 16,
  "fiber": 6,
  "sodium": 680,
  "confidence": "high",
  "tips": "one specific fitness tip about this meal"
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
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
  return { aiResult, rawText: text };
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

/** Estimated kcal burned: use logged calories when present, else ~5 kcal/min from duration */
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
  const caloriesOut = await sumWorkoutCaloriesOut(db, userId, ymd);
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
      calorie_goal, protein_goal, meals_logged, calories_out, energy_difference,
      weekly_avg_calories, weekly_avg_protein, meal_quality_score, updated_at
    ) VALUES (?, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
  getUserGoals,
  sumWorkoutCaloriesOut,
  recomputeDailyStats,
  countMealsForDay,
  nutritionLoggingStreak,
  todayYmdInTz,
  STREAK_TZ,
  DEFAULT_CAL_GOAL,
  DEFAULT_PRO_GOAL
};
