/**
 * Daily "Focus Wheel" segments: activity-only, adaptive to member baseline.
 * Always returns exactly `count` labels (default 8, watch-dial segments).
 */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function roundToNearest(n, step) {
  return Math.round(n / step) * step;
}
function avg(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((a, b) => a + Number(b), 0) / arr.length;
}

const BASE_ACTIVITIES = [
  'Warm-up: 5 min brisk walk',
  'Activation: 10 bodyweight squats',
  'Recovery: 6 min stretch block',
  'Breath reset: 90 seconds',
  'Form first: controlled reps',
  'Check-in before 8 PM',
  'Walk 10 min after meals',
  'Mobility: hips + T-spine'
];

async function buildFocusSegments({ queryAll, queryOne }, userId, count = 8) {
  const weekRows = await queryAll(
    `SELECT steps, water_ml, protein_g, sleep_hours
     FROM daily_checkins
     WHERE user_id = ? AND checkin_date >= (CURRENT_DATE - INTERVAL '6 days')::date`,
    [userId]
  );

  const stepsVals = (weekRows || []).map((r) => r.steps).filter((v) => v != null && !Number.isNaN(Number(v)));
  const waterVals = (weekRows || []).map((r) => r.water_ml).filter((v) => v != null && !Number.isNaN(Number(v)));
  const proteinVals = (weekRows || []).map((r) => r.protein_g).filter((v) => v != null && !Number.isNaN(Number(v)));
  const sleepVals = (weekRows || []).map((r) => r.sleep_hours).filter((v) => v != null && !Number.isNaN(Number(v)));

  const avgSteps = avg(stepsVals);
  const avgWaterMl = avg(waterVals);
  const avgProtein = avg(proteinVals);
  const avgSleep = avg(sleepVals);

  const activities = [];

  // Steps: progressive and realistic (roughly +30%)
  if (avgSteps != null && avgSteps > 0) {
    const target = clamp(roundToNearest(avgSteps * 1.3, 100), 2500, 25000);
    activities.push(`Steps +30% (${Math.round(avgSteps).toLocaleString()}→${target.toLocaleString()})`);
  } else {
    activities.push('Steps focus: 6,000 today');
  }

  // Water: if baseline exists, progressive increase; else meaningful default
  if (avgWaterMl != null && avgWaterMl > 0) {
    const targetMl = clamp(roundToNearest(avgWaterMl * 1.4, 100), 1200, 5000);
    const baseL = (avgWaterMl / 1000).toFixed(1);
    const tarL = (targetMl / 1000).toFixed(1);
    activities.push(`Water +40% (${baseL}L→${tarL}L)`);
  } else {
    activities.push('Hydration focus: +0.8 L');
  }

  // Protein: progressive but not extreme
  if (avgProtein != null && avgProtein > 0) {
    const targetProtein = clamp(roundToNearest(avgProtein * 1.2, 5), 60, 240);
    activities.push(`Protein +20% (${Math.round(avgProtein)}g→${targetProtein}g)`);
  } else {
    activities.push('Protein focus: +20 g today');
  }

  // Sleep: nudge baseline toward better target
  if (avgSleep != null && avgSleep > 0) {
    const targetSleep = clamp(Math.round((avgSleep + 0.5) * 10) / 10, 6.5, 9.0);
    activities.push(`Sleep target: ${targetSleep.toFixed(1)}h tonight`);
  } else {
    activities.push('Sleep target: +30 min tonight');
  }

  const wo = await queryOne(
    `SELECT COUNT(*)::int AS c FROM workout_logs
     WHERE user_id = ? AND created_at >= (CURRENT_TIMESTAMP - INTERVAL '7 days')`,
    [userId]
  );
  const wn = wo && wo.c != null ? parseInt(wo.c, 10) : 0;
  if (wn < 2) activities.push('Gym prep: 1 activation set');
  else activities.push('Post-gym: 6 min cooldown walk');

  // Fill remaining with short action-only cards (no quotes).
  for (const b of BASE_ACTIVITIES) {
    if (activities.length >= count) break;
    if (!activities.includes(b)) activities.push(b);
  }

  return activities.slice(0, count);
}

function todayUTCYmd() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  buildFocusSegments,
  todayUTCYmd
};
