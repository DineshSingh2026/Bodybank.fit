/**
 * Daily "Focus Wheel" segments: mix of data-aware micro-goals and luxury short quotes.
 * Always returns exactly `count` labels (default 8).
 */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

const STATIC_QUOTES = [
  'Consistency compounds.',
  'Progress over perfection.',
  'One thing done well.',
  'Recovery is performance.',
  'Move with intention.',
  'Small reps. Big effect.',
  'Discipline is freedom.',
  'Show up today.'
];

const STATIC_HABITS = [
  'Hydration: own your water.',
  'Protein at every meal.',
  'In bed fifteen minutes earlier.',
  'Ten minutes of brisk walking.',
  'Log your daily check-in.',
  'One mindful meal today.',
  'Stretch for five minutes.',
  'Breathe before you scroll.'
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

async function buildFocusSegments({ queryAll, queryOne }, userId, count = 8) {
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
    dynamic.push(`Aim for ${target.toLocaleString()} steps today`);
    dynamic.push(`Beat your week: ${avgSteps.toLocaleString()}+ steps`);
  } else {
    dynamic.push('Build toward 6,000 steps today');
    dynamic.push('Start with a 15-minute walk');
  }

  const todayRow = await queryOne(
    'SELECT steps, water_ml, protein_g, sleep_hours FROM daily_checkins WHERE user_id = ? AND checkin_date = CURRENT_DATE',
    [userId]
  );
  if (todayRow && todayRow.water_ml != null && todayRow.water_ml < 1500) {
    dynamic.push('Water focus: +500 ml today');
  }
  if (todayRow && todayRow.protein_g != null && todayRow.protein_g < 80) {
    dynamic.push('Protein: add 20 g today');
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
