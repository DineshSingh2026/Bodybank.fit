'use strict';

/**
 * Muscle Ranking Service
 * ---------------------
 * Computes per-region strength scores (0–100) from the user's existing
 * progress_logs + workout_logs session_lifts + canonical bench/squat/deadlift.
 *
 * NO tables are written, NO schemas are changed.
 * All reads are from: users, weight_logs, progress_logs, workout_logs, audit_requests.
 *
 * Scoring model (formula_version: 1):
 *  - relative_strength = best_lift_kg / bodyweight_kg
 *  - score = clamp(0, 100, 20 + (relStr - weakThreshold) / (strongThreshold - weakThreshold) * 60)
 *    → at weakThreshold  → score ≈ 20  (Weak)
 *    → at strongThreshold → score ≈ 80  (Strong)
 *    → above strong → scales to 100
 *  - Tiers: Weak 0–39 | Average 40–69 | Strong 70–100
 *  - Body Audit Index = weighted average of 6 regional scores
 *  - Upper body = avg(chest, back, shoulders, arms)
 *  - Lower body = avg(legs, core)
 */

// ── Region definitions ───────────────────────────────────────────────────────

const REGIONS = [
  {
    key: 'chest',
    label: 'Chest',
    // Lifts that contribute — first match wins (highest priority first)
    lifts: [
      { src: 'session', key: 'bench_press' },
      { src: 'session', key: 'incline_press', factor: 0.9 },
      { src: 'progress', key: 'strength_bench' },
      { src: 'canonical', key: 'bench_kg' }
    ],
    // Male thresholds (relative to body weight) for Weak / Strong
    weakBw: 0.50,
    strongBw: 1.25,
    femaleFactor: 0.72   // female thresholds = male × femaleFactor
  },
  {
    key: 'back',
    label: 'Back',
    lifts: [
      { src: 'session', key: 'barbell_row' },
      { src: 'session', key: 'lat_pulldown', factor: 0.85 },
      { src: 'session', key: 'deadlift', factor: 0.65 },
      { src: 'progress', key: 'strength_deadlift', factor: 0.65 },
      { src: 'canonical', key: 'deadlift_kg', factor: 0.65 }
    ],
    weakBw: 0.40,
    strongBw: 1.00,
    femaleFactor: 0.70
  },
  {
    key: 'shoulders',
    label: 'Shoulders',
    lifts: [
      { src: 'session', key: 'overhead_press' },
      { src: 'session', key: 'lateral_raise', factor: 0.50 },
      { src: 'session', key: 'face_pull', factor: 0.35 }
    ],
    weakBw: 0.30,
    strongBw: 0.75,
    femaleFactor: 0.68
  },
  {
    key: 'arms',
    label: 'Arms',
    lifts: [
      { src: 'session', key: 'bicep_curl' },
      { src: 'session', key: 'triceps_pushdown', factor: 0.80 }
    ],
    weakBw: 0.15,
    strongBw: 0.50,
    femaleFactor: 0.70
  },
  {
    key: 'legs',
    label: 'Legs',
    lifts: [
      { src: 'session', key: 'back_squat' },
      { src: 'session', key: 'squat' },
      { src: 'session', key: 'romanian_deadlift', factor: 0.85 },
      { src: 'session', key: 'leg_press', factor: 0.55 },
      { src: 'session', key: 'leg_curl', factor: 0.30 },
      { src: 'progress', key: 'strength_squat' },
      { src: 'canonical', key: 'squat_kg' }
    ],
    weakBw: 0.60,
    strongBw: 1.75,
    femaleFactor: 0.75
  },
  {
    key: 'core',
    label: 'Core',
    // Core is proxied via compound lifts (no direct isolation movement tracked)
    lifts: [
      { src: 'session', key: 'deadlift', factor: 0.45 },
      { src: 'session', key: 'back_squat', factor: 0.35 },
      { src: 'session', key: 'squat', factor: 0.35 },
      { src: 'progress', key: 'strength_deadlift', factor: 0.45 },
      { src: 'progress', key: 'strength_squat', factor: 0.35 },
      { src: 'canonical', key: 'deadlift_kg', factor: 0.45 },
      { src: 'canonical', key: 'squat_kg', factor: 0.35 }
    ],
    weakBw: 0.30,
    strongBw: 1.00,
    femaleFactor: 0.72
  }
];

// Weighted average for Body Audit Index
const REGION_INDEX_WEIGHT = {
  chest: 0.20,
  back: 0.20,
  shoulders: 0.15,
  arms: 0.10,
  legs: 0.25,
  core: 0.10
};

// Exercises to recommend per region
const REGION_EXERCISES = {
  chest: [
    { name: 'Barbell Bench Press', sets: '3–4 sets × 6–10 reps', impact: 'High Impact' },
    { name: 'Incline Dumbbell Press', sets: '3–4 sets × 8–12 reps', impact: 'High Impact' },
    { name: 'Cable Chest Fly', sets: '3–4 sets × 12–15 reps', impact: 'Medium Impact' }
  ],
  back: [
    { name: 'Barbell Row', sets: '3–4 sets × 6–10 reps', impact: 'High Impact' },
    { name: 'Lat Pulldown', sets: '3–4 sets × 8–12 reps', impact: 'High Impact' },
    { name: 'Seated Cable Row', sets: '3–4 sets × 10–15 reps', impact: 'Medium Impact' }
  ],
  shoulders: [
    { name: 'Overhead Barbell Press', sets: '3–4 sets × 6–10 reps', impact: 'High Impact' },
    { name: 'Dumbbell Lateral Raise', sets: '3–4 sets × 12–15 reps', impact: 'High Impact' },
    { name: 'Face Pull', sets: '3–4 sets × 15–20 reps', impact: 'Medium Impact' }
  ],
  arms: [
    { name: 'Barbell Bicep Curl', sets: '3–4 sets × 8–12 reps', impact: 'High Impact' },
    { name: 'Tricep Pushdown', sets: '3–4 sets × 10–15 reps', impact: 'High Impact' },
    { name: 'Hammer Curl', sets: '3–4 sets × 12–15 reps', impact: 'Medium Impact' }
  ],
  legs: [
    { name: 'Barbell Squat', sets: '3–4 sets × 6–10 reps', impact: 'High Impact' },
    { name: 'Romanian Deadlift', sets: '3–4 sets × 8–12 reps', impact: 'High Impact' },
    { name: 'Walking Lunges', sets: '3–4 sets × 12–16 reps', impact: 'Medium Impact' }
  ],
  core: [
    { name: 'Deadlift (focus on bracing)', sets: '3–4 sets × 5–8 reps', impact: 'High Impact' },
    { name: 'Hanging Leg Raise', sets: '3–4 sets × 10–15 reps', impact: 'High Impact' },
    { name: 'Ab Wheel Rollout', sets: '3–4 sets × 8–12 reps', impact: 'Medium Impact' }
  ]
};

// Score-to-week improvement estimate
const IMPROVEMENT_ESTIMATE = {
  legs: '+10–14 Score in 4 Weeks',
  chest: '+8–12 Score in 4 Weeks',
  back: '+8–12 Score in 4 Weeks',
  shoulders: '+6–10 Score in 4 Weeks',
  arms: '+6–8 Score in 4 Weeks',
  core: '+8–12 Score in 4 Weeks'
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function safeNum(v, fallback = null) {
  const n = num(v);
  return n !== null ? n : fallback;
}

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

/** YYYY-MM-DD from Postgres DATE/TIMESTAMP (node-pg Date) or ISO-ish strings — never String(date).slice(0,10). */
function rowYmd(val) {
  if (val == null || val === '') return '';
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  const head = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (head) return head[1];
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return '';
}

function tier(score) {
  if (score === null) return 'no_data';
  if (score >= 70) return 'Strong';
  if (score >= 40) return 'Average';
  return 'Weak';
}

/**
 * Convert relative strength (lift / bodyweight) to 0-100 score for a region.
 * weakBw → ≈ 20, strongBw → ≈ 80, higher → up to 100
 */
function relStrToScore(relStr, weakBw, strongBw) {
  if (!Number.isFinite(relStr) || relStr <= 0) return null;
  const range = strongBw - weakBw;
  const raw = 20 + ((relStr - weakBw) / range) * 60;
  return Math.round(clamp(raw, 0, 100));
}

/**
 * Extract the best (max) effective lift value from a bag of workout/progress rows.
 * Returns kg or null.
 */
function extractBestLift(region, workoutRows, progressRows) {
  let best = null;

  for (const liftDef of region.lifts) {
    const factor = liftDef.factor != null ? liftDef.factor : 1.0;

    if (liftDef.src === 'session') {
      for (const row of workoutRows) {
        const sl = row.session_lifts;
        if (!sl || typeof sl !== 'object') continue;
        const raw = num(sl[liftDef.key]);
        if (raw !== null && raw > 0) {
          const eff = raw * factor;
          if (best === null || eff > best) best = eff;
        }
      }
    } else if (liftDef.src === 'progress') {
      for (const row of progressRows) {
        const raw = num(row[liftDef.key]);
        if (raw !== null && raw > 0) {
          const eff = raw * factor;
          if (best === null || eff > best) best = eff;
        }
      }
    } else if (liftDef.src === 'canonical') {
      // canonical bench_kg / squat_kg / deadlift_kg on workout_logs
      for (const row of workoutRows) {
        const raw = num(row[liftDef.key]);
        if (raw !== null && raw > 0) {
          const eff = raw * factor;
          if (best === null || eff > best) best = eff;
        }
      }
    }
  }

  return best;
}

/**
 * Compute a score for a given snapshot of data (used for history).
 * workoutRows and progressRows are already filtered up to a specific date.
 */
function computeRegionScore(region, workoutRows, progressRows, bodyweightKg, isFemale) {
  const bestKg = extractBestLift(region, workoutRows, progressRows);
  if (bestKg === null || bodyweightKg <= 0) return null;

  const gf = isFemale ? region.femaleFactor : 1.0;
  const weakBw = region.weakBw * gf;
  const strongBw = region.strongBw * gf;
  const relStr = bestKg / bodyweightKg;

  return relStrToScore(relStr, weakBw, strongBw);
}

/**
 * Compute Body Audit Index from a map of regional scores.
 * Regions with no data are excluded from the weighted average.
 */
function computeBodyAuditIndex(scores) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, score] of Object.entries(scores)) {
    if (score === null) continue;
    const w = REGION_INDEX_WEIGHT[key] || 0;
    weightedSum += score * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

// ── Main export ──────────────────────────────────────────────────────────────

function createMuscleRankingService({ queryOne, queryAll }) {

  async function computeMuscleRanking(userId) {
    const LOOKBACK_DAYS = 180; // 6 months of data for best-lift extraction

    // 1. User basics (gender, weight)
    const user = await queryOne(
      `SELECT id, email, gender, height_cm FROM users WHERE id = ?`,
      [userId]
    );
    if (!user) return null;

    const email = user.email ? String(user.email).trim().toLowerCase() : '';

    // Determine gender
    const genderRaw = String(user.gender || '').toLowerCase();
    let isFemale = /^(f|female|woman|girl)$/.test(genderRaw);
    if (!isFemale && email) {
      const ar = await queryOne(
        `SELECT sex FROM audit_requests WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1`,
        [email]
      );
      if (ar && ar.sex) {
        isFemale = /^(f|female|woman|girl)$/.test(String(ar.sex).toLowerCase());
      }
    }

    // Body weight (kg) — priority: weight_logs → progress_logs → workout_logs
    let bodyweightKg = null;
    const wl = await queryOne(
      `SELECT weight_kg FROM weight_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (wl && num(wl.weight_kg) != null) bodyweightKg = num(wl.weight_kg);

    if (!bodyweightKg) {
      const pl = await queryOne(
        `SELECT weight FROM progress_logs WHERE user_id = ? AND weight IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (pl && num(pl.weight) != null) bodyweightKg = num(pl.weight);
    }

    if (!bodyweightKg) {
      const wkl = await queryOne(
        `SELECT weight_kg FROM workout_logs WHERE user_id = ? AND weight_kg IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (wkl && num(wkl.weight_kg) != null) bodyweightKg = num(wkl.weight_kg);
    }

    if (!bodyweightKg || bodyweightKg <= 0) bodyweightKg = 75; // safe default

    // 2. Fetch lift data (all within lookback window)
    const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 86400000)
      .toISOString().slice(0, 10);

    const workoutRows = await queryAll(
      `SELECT session_lifts, bench_kg, squat_kg, deadlift_kg, session_date, created_at
       FROM workout_logs
       WHERE user_id = ? AND created_at >= ?::date
       ORDER BY created_at ASC`,
      [userId, lookbackDate]
    );

    const progressRows = await queryAll(
      `SELECT strength_bench, strength_squat, strength_deadlift, created_at
       FROM progress_logs
       WHERE user_id = ? AND created_at >= ?::date
       ORDER BY created_at ASC`,
      [userId, lookbackDate]
    );

    // 3. Compute current regional scores (best lift ever in window)
    const regionScores = {};
    const regionDetails = [];

    for (const region of REGIONS) {
      const score = computeRegionScore(region, workoutRows, progressRows, bodyweightKg, isFemale);
      regionScores[region.key] = score;

      const bestKg = extractBestLift(region, workoutRows, progressRows);
      regionDetails.push({
        key: region.key,
        label: region.label,
        score,
        tier: tier(score),
        best_lift_kg: bestKg !== null ? Math.round(bestKg * 10) / 10 : null
      });
    }

    // 4. Body Audit Index
    const auditIndex = computeBodyAuditIndex(regionScores);

    // 5. Upper vs lower body balance
    const upperKeys = ['chest', 'back', 'shoulders', 'arms'];
    const lowerKeys = ['legs', 'core'];

    const upperScores = upperKeys.map(k => regionScores[k]).filter(s => s !== null);
    const lowerScores = lowerKeys.map(k => regionScores[k]).filter(s => s !== null);

    const upperAvg = upperScores.length
      ? Math.round(upperScores.reduce((a, b) => a + b, 0) / upperScores.length)
      : null;
    const lowerAvg = lowerScores.length
      ? Math.round(lowerScores.reduce((a, b) => a + b, 0) / lowerScores.length)
      : null;

    let bodyInsight = null;
    if (upperAvg !== null && lowerAvg !== null) {
      const diff = Math.abs(upperAvg - lowerAvg);
      const pct = Math.round((diff / Math.max(upperAvg, lowerAvg)) * 100);
      if (lowerAvg < upperAvg) {
        bodyInsight = {
          type: 'lower_weaker',
          message: `Your lower body is ${pct}% weaker than your upper body.`,
          detail: 'This imbalance may slow fat loss, limit your performance and increase injury risk.',
          pct
        };
      } else if (upperAvg < lowerAvg) {
        bodyInsight = {
          type: 'upper_weaker',
          message: `Your upper body is ${pct}% weaker than your lower body.`,
          detail: 'Adding more upper body compound movements will improve your overall balance.',
          pct
        };
      } else {
        bodyInsight = {
          type: 'balanced',
          message: 'Your upper and lower body strength are well balanced.',
          detail: 'Keep training both halves consistently to maintain this advantage.',
          pct: 0
        };
      }
    }

    // 6. Recommended fix — weakest region with data
    const weakest = regionDetails
      .filter(r => r.score !== null)
      .sort((a, b) => a.score - b.score)[0] || null;

    const recommendation = weakest
      ? {
          target: weakest.label.toUpperCase(),
          targetKey: weakest.key,
          exercises: REGION_EXERCISES[weakest.key] || [],
          estimated_improvement: IMPROVEMENT_ESTIMATE[weakest.key] || '+8–12 Score in 4 Weeks'
        }
      : null;

    // 7. Self-ranking (within user's own tracked regions — no fabricated cohort)
    const rankedRegions = regionDetails
      .filter(r => r.score !== null)
      .sort((a, b) => b.score - a.score);

    const selfRanking = {
      strongest: rankedRegions[0] || null,
      weakest: rankedRegions[rankedRegions.length - 1] || null,
      above_avg_regions: rankedRegions.filter(r => r.score >= 70),
      below_avg_regions: rankedRegions.filter(r => r.score < 40)
    };

    // 8. Score history — compute monthly snapshots (last 6 months)
    const history = buildScoreHistory(workoutRows, progressRows, bodyweightKg, isFemale);

    // 9. Prev week delta (compare last vs second-to-last history point)
    let indexDelta = null;
    if (history.length >= 2) {
      const last = history[history.length - 1].index;
      const prev = history[history.length - 2].index;
      if (last !== null && prev !== null) {
        indexDelta = Math.round(last - prev);
      }
    }

    const hasRealData = regionDetails.some(r => r.score !== null);

    // When the user hasn't logged any lifts yet, build motivational placeholder scores
    // so the full UI always renders. Every region shows "Unranked" at score 0
    // with a special tier so CSS can dim them appropriately.
    const finalRegions = hasRealData ? regionDetails : REGIONS.map(r => ({
      key: r.key,
      label: r.label,
      score: null,
      tier: 'unranked',
      best_lift_kg: null
    }));

    const finalAuditIndex = hasRealData ? auditIndex : null;

    const finalInsight = hasRealData ? bodyInsight : {
      type: 'no_data',
      message: 'Log your first workout with lifts to unlock your Muscle Ranking.',
      detail: 'Bench press, squat, deadlift — any logged lift starts generating your personalised heatmap.',
      pct: 0
    };

    const finalRecommendation = hasRealData ? recommendation : {
      target: 'YOUR FIRST WORKOUT',
      targetKey: 'legs',
      exercises: REGION_EXERCISES.legs,
      estimated_improvement: '+Start Today'
    };

    const finalSelfRanking = hasRealData ? selfRanking : {
      strongest: null,
      weakest: null,
      above_avg_regions: [],
      below_avg_regions: []
    };

    return {
      formula_version: 1,
      user_id: userId,
      bodyweight_kg: Math.round(bodyweightKg * 10) / 10,
      is_female: isFemale,
      audit_index: finalAuditIndex,
      audit_index_delta: indexDelta,
      regions: finalRegions,
      upper_avg: hasRealData ? upperAvg : null,
      lower_avg: hasRealData ? lowerAvg : null,
      body_insight: finalInsight,
      recommendation: finalRecommendation,
      self_ranking: finalSelfRanking,
      history,
      has_data: hasRealData,
      is_placeholder: !hasRealData
    };
  }

  /**
   * Build a historical score series.
   * Groups sessions into monthly buckets, computes cumulative-best audit index up to each date.
   */
  function buildScoreHistory(workoutRows, progressRows, bodyweightKg, isFemale) {
    // Collect all unique session dates
    const allDates = new Set();
    workoutRows.forEach(r => {
      const d = rowYmd(r.session_date) || rowYmd(r.created_at);
      if (d) allDates.add(d);
    });
    progressRows.forEach(r => {
      const d = rowYmd(r.created_at);
      if (d) allDates.add(d);
    });

    if (allDates.size === 0) return [];

    const sortedDates = [...allDates].sort();

    // Sample at most 12 points evenly across the date range, always including the last
    const MAX_POINTS = 12;
    let sampleDates;
    if (sortedDates.length <= MAX_POINTS) {
      sampleDates = sortedDates;
    } else {
      sampleDates = [];
      const step = (sortedDates.length - 1) / (MAX_POINTS - 1);
      for (let i = 0; i < MAX_POINTS - 1; i++) {
        sampleDates.push(sortedDates[Math.round(i * step)]);
      }
      sampleDates.push(sortedDates[sortedDates.length - 1]); // always include last
    }

    const historyPoints = [];

    // Cumulative best approach — running max lifts up to each sample date
    const cumulativeWorkout = [];
    const cumulativeProgress = [];

    let wIdx = 0;
    let pIdx = 0;

    for (const date of sampleDates) {
      // Add all rows up to and including this date
      while (wIdx < workoutRows.length) {
        const d = rowYmd(workoutRows[wIdx].session_date) || rowYmd(workoutRows[wIdx].created_at);
        if (d <= date) { cumulativeWorkout.push(workoutRows[wIdx]); wIdx++; }
        else break;
      }
      while (pIdx < progressRows.length) {
        const d = rowYmd(progressRows[pIdx].created_at);
        if (d <= date) { cumulativeProgress.push(progressRows[pIdx]); pIdx++; }
        else break;
      }

      const scores = {};
      for (const region of REGIONS) {
        scores[region.key] = computeRegionScore(
          region, cumulativeWorkout, cumulativeProgress, bodyweightKg, isFemale
        );
      }
      const idx = computeBodyAuditIndex(scores);

      // Format date label: "1 May" style
      const [y, m, d2] = date.split('-');
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const label = `${parseInt(d2)} ${monthNames[parseInt(m) - 1]}`;

      historyPoints.push({ date, label, index: idx });
    }

    // Deduplicate consecutive identical dates (can happen if same day logged twice)
    const seen = new Set();
    return historyPoints.filter(p => {
      if (seen.has(p.date)) return false;
      seen.add(p.date);
      return true;
    });
  }

  return { computeMuscleRanking };
}

module.exports = { createMuscleRankingService };
