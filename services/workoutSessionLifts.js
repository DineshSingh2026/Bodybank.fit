/**
 * Workout-type-specific lift keys (My Workout). Canonical bench/squat/deadlift columns
 * derive from these for charts and legacy queries.
 */
const ALLOWED_LIFT_KEYS = new Set([
  'bench_press',
  'incline_press',
  'overhead_press',
  'lateral_raise',
  'triceps_pushdown',
  'deadlift',
  'barbell_row',
  'lat_pulldown',
  'bicep_curl',
  'face_pull',
  'back_squat',
  'squat',
  'romanian_deadlift',
  'leg_press',
  'leg_curl',
  'calf_raise'
]);

function parseSessionLifts(body) {
  let raw = body && body.session_lifts;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !ALLOWED_LIFT_KEYS.has(k)) continue;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0 && n < 2000) out[k] = Math.round(n * 100) / 100;
  }
  return out;
}

/**
 * Parse the parallel reps map { liftKey: reps }. Additive to session_lifts —
 * never required, so old weight-only logs keep working. Reps clamped to 1..30.
 */
function parseSessionReps(body) {
  let raw = body && body.session_reps;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return {}; }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !ALLOWED_LIFT_KEYS.has(k)) continue;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 30) out[k] = n;
  }
  return out;
}

function val(sl, key) {
  if (!sl || sl[key] == null || sl[key] === '') return null;
  const n = parseFloat(sl[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Map structured lifts to legacy bench_kg / squat_kg / deadlift_kg for DB + progress_logs */
function canonicalLiftsFromSessionLifts(sl) {
  if (!sl || typeof sl !== 'object') {
    return { bench_kg: null, squat_kg: null, deadlift_kg: null };
  }
  const bench = val(sl, 'bench_press');
  const squat = val(sl, 'back_squat') ?? val(sl, 'squat');
  const deadlift = val(sl, 'deadlift') ?? val(sl, 'romanian_deadlift');
  return {
    bench_kg: bench,
    squat_kg: squat,
    deadlift_kg: deadlift
  };
}

function hasAnySessionLift(sl) {
  if (!sl || typeof sl !== 'object') return false;
  return Object.keys(sl).length > 0;
}

module.exports = {
  ALLOWED_LIFT_KEYS,
  parseSessionLifts,
  parseSessionReps,
  canonicalLiftsFromSessionLifts,
  hasAnySessionLift
};
