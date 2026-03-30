/**
 * Daily "Focus Wheel" segments: concise, premium copy with data-aware nudges.
 * Always returns exactly `count` labels (default 6).
 */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

const STATIC_QUOTES = [
  'Consistency compounds',
  'Progress over perfection',
  'One thing done well',
  'Recovery is performance',
  'Move with intention',
  'Discipline is freedom',
  'Show up today'
];

const STATIC_HABITS = [
  'Hydration priority',
  'Protein each meal',
  'Sleep fifteen minutes earlier',
  'Ten minute brisk walk',
  'Complete daily check-in',
  'One mindful meal',
  'Five minute mobility',
  'Breathe before scrolling'
];

function dedupeLabels(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const t = String(x || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function buildFocusSegments({ queryAll, queryOne }, userId, count = 6) {
  const dynamic = [];

  const weekRows = await queryAll(
    `SELECT steps, water_ml, protein_g, sleep_hours
     FROM daily_checkins
     WHERE user_id = ? AND checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date`,
    [userId]
  );

  const stepsVals = (weekRows || []).map((r) => r.steps).filter((s) => s != null && !Number.isNaN(Number(s)));
  const avgSteps =
    stepsVals.length > 0 ? Math.round(stepsVals.reduce((a, b) => a + Number(b), 0) / stepsVals.length) : null;

  if (avgSteps != null && avgSteps > 0) {
    const target = clamp(Math.round(avgSteps + 750), 3000, 20000);
    dynamic.push(`${target.toLocaleString()} steps today`);
    dynamic.push(`Beat ${avgSteps.toLocaleString()} avg steps`);
  } else {
    dynamic.push('Build toward 6,000 steps');
    dynamic.push('Start a 15 minute walk');
  }

  const todayRow = await queryOne(
    'SELECT steps, water_ml, protein_g, sleep_hours FROM daily_checkins WHERE user_id = ? AND checkin_date = CURRENT_DATE',
    [userId]
  );
  if (todayRow && todayRow.water_ml != null && todayRow.water_ml < 1500) {
    dynamic.push('Add 500 ml water');
  }
  if (todayRow && todayRow.protein_g != null && todayRow.protein_g < 80) {
    dynamic.push('Add 20 g protein');
  }

  const wo = await queryOne(
    `SELECT COUNT(*)::int AS c FROM workout_logs
     WHERE user_id = ? AND created_at >= (CURRENT_TIMESTAMP - INTERVAL '7 days')`,
    [userId]
  );
  const wn = wo && wo.c != null ? parseInt(wo.c, 10) : 0;
  if (wn < 2) {
    dynamic.push('Schedule one training session');
  }

  const pool = dedupeLabels([...dynamic, ...STATIC_QUOTES, ...STATIC_HABITS]);
  shuffleInPlace(pool);

  const out = [];
  for (const p of pool) {
    if (out.length >= count) break;
    out.push(p);
  }
  let i = 0;
  while (out.length < count) {
    out.push(STATIC_QUOTES[i % STATIC_QUOTES.length]);
    i++;
  }
  return out.slice(0, count);
}

function todayUTCYmd() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  buildFocusSegments,
  todayUTCYmd
};
