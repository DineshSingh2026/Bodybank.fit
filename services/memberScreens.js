'use strict';

/**
 * Member screens — the pure logic behind four member views:
 *   Daily Streak · Mind check-in · Two-week performance report · Blood grades.
 *
 * Pure and deterministic: no database, no clock (callers pass "today"), no
 * randomness. routes/memberScreens.js loads the rows and calls these; the
 * member app only draws what comes back. tests/member-screens.js pins them.
 */

// ── dates (YYYY-MM-DD strings, UTC arithmetic so no timezone drift) ─────────
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function dayNum(ymd) { return Math.floor(Date.parse(ymd + 'T00:00:00Z') / 86400000); }
function fromDayNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function addDays(ymd, d) { return fromDayNum(dayNum(ymd) + d); }
function toYmd(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : null;
}

// ── Streak ───────────────────────────────────────────────────────────────────

// Milestone rewards (owner-approved defaults 2026-09-30). Each is paid once per
// streak run: breaking the streak and rebuilding it earns them again, which is
// the point — the reward is for the run, not for the calendar.
const STREAK_MILESTONES = Object.freeze([
  { days: 7, label: 'Bronze', coins: 25 },
  { days: 14, label: 'Silver', coins: 50 },
  { days: 21, label: 'Gold', coins: 250 },
  { days: 30, label: 'Elite', coins: 400 },
  { days: 60, label: 'Legend', coins: 1000 }
]);

const FREEZES_PER_MONTH = 1;

/** Current run ending today (or yesterday when today isn't saved yet). */
function currentRun(dateSet, today) {
  const todaySaved = dateSet.has(today);
  let cursor = todaySaved ? today : addDays(today, -1);
  let len = 0;
  while (dateSet.has(cursor) && len < 3660) { len += 1; cursor = addDays(cursor, -1); }
  return { length: len, start: len ? addDays(cursor, 1) : null, todaySaved };
}

/** Longest run anywhere in the history. */
function bestRun(dateSet) {
  const days = Array.from(dateSet).filter(isYmd).map(dayNum).sort((a, b) => a - b);
  let best = 0; let run = 0; let prev = null;
  for (const d of days) {
    run = (prev != null && d === prev + 1) ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/** Milestones with reached flags for a run of `length` days. */
function milestonesFor(length) {
  const next = STREAK_MILESTONES.find((m) => length < m.days) || null;
  return {
    items: STREAK_MILESTONES.map((m) => ({ days: m.days, label: m.label, coins: m.coins, reached: length >= m.days })),
    next: next ? { days: next.days, label: next.label, coins: next.coins, in_days: next.days - length } : null
  };
}

/** Milestones a run has reached, each with the idempotency key its coins are paid under. */
function milestoneAwards(userId, run) {
  if (!run || !run.length || !run.start) return [];
  return STREAK_MILESTONES
    .filter((m) => run.length >= m.days)
    .map((m) => ({
      days: m.days,
      coins: m.coins,
      label: m.label,
      eventKey: `coins:streak_milestone:${userId}:${run.start}:${m.days}`
    }));
}

/**
 * One month of day cells. States:
 *   done    a real check-in       freeze  protected by a streak freeze
 *   missed  a past day with none  today   today, not yet saved
 *   future  after today           before  before the member joined
 */
function monthCalendar(ym, checkinSet, freezeSet, today, joinedYmd) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  const first = `${m[1]}-${m[2]}-01`;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const days = [];
  let done = 0; let elapsed = 0;
  for (let i = 0; i < daysInMonth; i++) {
    const d = addDays(first, i);
    let state;
    if (dayNum(d) > dayNum(today)) state = 'future';
    else if (freezeSet.has(d)) state = 'freeze';
    else if (checkinSet.has(d)) state = 'done';
    else if (joinedYmd && dayNum(d) < dayNum(joinedYmd)) state = 'before';
    else if (d === today) state = 'today';
    else state = 'missed';
    if (state !== 'future' && state !== 'before') {
      if (d !== today || state === 'done' || state === 'freeze') elapsed += 1;
      if (state === 'done' || state === 'freeze') done += 1;
    }
    days.push({ date: d, day: i + 1, state });
  }
  const prevYm = addDays(first, -1).slice(0, 7);
  const nextYm = addDays(first, daysInMonth).slice(0, 7);
  return { ym, first_weekday: firstWeekday, days, done, elapsed, prev: prevYm, next: nextYm };
}

// ── Mind ─────────────────────────────────────────────────────────────────────

const MOODS = Object.freeze([
  { value: 1, key: 'low', label: 'Low' },
  { value: 2, key: 'meh', label: 'Meh' },
  { value: 3, key: 'okay', label: 'Okay' },
  { value: 4, key: 'good', label: 'Good' },
  { value: 5, key: 'great', label: 'Great' }
]);
const STRESS = Object.freeze([
  { value: 1, label: 'Low' },
  { value: 2, label: 'Mild' },
  { value: 3, label: 'Moderate' },
  { value: 4, label: 'High' },
  { value: 5, label: 'Very high' }
]);

function validMood(v) { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; }
function moodLabel(v) { const m = MOODS.find((x) => x.value === Number(v)); return m ? m.label : null; }
function stressLabel(v) { const s = STRESS.find((x) => x.value === Number(v)); return s ? s.label : null; }

/** Consecutive days (ending today or yesterday) with any mind activity. */
function mindStreak(dateSet, today) {
  return currentRun(dateSet, today).length;
}

/** Seven sleep bars, oldest first; null where nothing was logged. */
function sleepWeek(rowsByDate, today) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const h = rowsByDate.has(d) ? rowsByDate.get(d) : null;
    out.push({ date: d, weekday: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(d + 'T00:00:00Z').getUTCDay()], hours: h });
  }
  const logged = out.filter((x) => x.hours != null);
  return {
    days: out,
    latest: logged.length ? logged[logged.length - 1] : null,
    avg: logged.length ? Math.round((logged.reduce((s, x) => s + x.hours, 0) / logged.length) * 10) / 10 : null
  };
}

// ── Blood grades ─────────────────────────────────────────────────────────────
//
// Per-marker letters, derived only from the classifier's status and the lab's own
// reference range — no AI, no invented numbers. Definitions (shown to members in
// the legend, so they must stay honest):
//   A Optimal     in range and clear of the edge that matters for this marker,
//                 or outside it on the favourable side (a low LDL is good news)
//   B Good        in range, but in the outer 15 % toward the unfavourable edge
//   C Borderline  the classifier's borderline band (within 5 % of a limit)
//   D Attention   outside the range on the unfavourable side, or critical
const MARKER_GRADE_LABEL = Object.freeze({ A: 'Optimal', B: 'Good', C: 'Borderline', D: 'Attention' });
const EDGE_FRACTION = 0.15;

function favourableSide(direction, side) {
  if (direction === 'LOWER') return side === 'low';
  if (direction === 'HIGHER') return side === 'high';
  return false;
}

function markerGrade(m) {
  if (!m || m.duplicate) return null;
  const st = String(m.status || '');
  if (!st || st === 'NOT_AVAILABLE') return null;
  const dir = m.direction || 'RANGE';
  const side = /LOW$/.test(st) ? 'low' : (/HIGH$/.test(st) ? 'high' : null);
  if (st === 'WITHIN_RANGE') {
    const r = m.referenceRange || {};
    const v = m.rangeValue != null ? m.rangeValue : m.value;
    const lo = Number.isFinite(r.low) ? r.low : null;
    const hi = Number.isFinite(r.high) ? r.high : null;
    if (v == null || lo == null || hi == null || hi <= lo) return 'A';
    const span = hi - lo;
    const nearLow = v < lo + span * EDGE_FRACTION;
    const nearHigh = v > hi - span * EDGE_FRACTION;
    if (dir === 'LOWER') return nearHigh ? 'B' : 'A';
    if (dir === 'HIGHER') return nearLow ? 'B' : 'A';
    return (nearLow || nearHigh) ? 'B' : 'A';
  }
  if (favourableSide(dir, side)) return 'A';
  if (/^BORDERLINE/.test(st)) return 'C';
  return 'D';
}

/** Where the value sits on a bar spanning the range plus a margin (0..1), and the range band. */
function markerBar(m) {
  const r = m.referenceRange || {};
  const v = m.rangeValue != null ? m.rangeValue : m.value;
  const lo = Number.isFinite(r.low) ? r.low : null;
  const hi = Number.isFinite(r.high) ? r.high : null;
  if (v == null || (lo == null && hi == null)) return null;
  let a; let b;
  if (lo != null && hi != null && hi > lo) {
    const pad = (hi - lo) * 0.5;
    a = lo - pad; b = hi + pad;
  } else if (hi != null) {
    a = 0; b = hi * 1.6 || 1;
  } else {
    a = 0; b = (lo * 2) || 1;
  }
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const pos = (x) => clamp((x - a) / (b - a));
  return {
    value: Math.round(pos(v) * 1000) / 1000,
    band_start: lo != null ? Math.round(pos(lo) * 1000) / 1000 : 0,
    band_end: hi != null ? Math.round(pos(hi) * 1000) / 1000 : 1
  };
}

const GRADE_ORDER = { D: 0, C: 1, B: 2, A: 3 };

/**
 * Member view of a graded report. `graded` is grading.gradeExtractedReport()'s
 * { classified, areas }.
 */
function bloodGradesView(graded) {
  const markers = [];
  for (const m of (graded && graded.classified && graded.classified.markers) || []) {
    const grade = markerGrade(m);
    if (!grade) continue;
    const valueText = m.value != null ? String(m.rawValue || m.value) : String(m.rawValue || '');
    markers.push({
      id: m.markerId || m.printedName,
      name: m.displayName || m.printedName,
      value: valueText,
      unit: m.unit || '',
      range: m.referenceRange && m.referenceRange.printed ? m.referenceRange.printed : '',
      grade,
      grade_label: MARKER_GRADE_LABEL[grade],
      bar: markerBar(m)
    });
  }
  // Worst first within the list is what a clinician would read; members asked for
  // the reverse (good news first, then what needs work) in the reference design.
  markers.sort((a, b) => (GRADE_ORDER[b.grade] - GRADE_ORDER[a.grade]) || a.name.localeCompare(b.name));
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  markers.forEach((m) => { counts[m.grade] += 1; });
  const areas = ((graded && graded.areas) || [])
    .filter((a) => a && a.grade && a.grade !== 'NOT_ASSESSED')
    .map((a) => ({ id: a.areaId, label: a.label, grade: a.grade, grade_label: a.gradeLabel || '' }));
  return {
    markers,
    counts,
    total: markers.length,
    optimal_or_good: counts.A + counts.B,
    areas,
    legend: MARKER_GRADE_LABEL
  };
}

// ── Two-week performance report ──────────────────────────────────────────────
//
// Built from reportData.loadReportBundle() + reportScore.scoreDataset() for a
// 14-day window. Facts only: every number here is something the member logged or
// a wearable measured, and a section with no data is null so the app hides it.
// There is deliberately no meal score (removed from members 2026-09-26).

const PILLAR_ORDER = ['workout', 'nutrition', 'checkin', 'consistency', 'yoga', 'health'];

function round1(v) { return Math.round(v * 10) / 10; }
function avgOf(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }

function hoursMinutes(h) {
  if (h == null) return null;
  let hh = Math.floor(h); let mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh += 1; mm = 0; }
  return { hours: hh, minutes: mm };
}

function momentumLabel(total) {
  return total >= 85 ? 'Strong' : total >= 70 ? 'Steady' : total >= 50 ? 'Building' : 'Getting started';
}

// One plain sentence for the score card. Facts only, never a judgement of food.
function momentumLine(score, checkinDays, workouts, protein) {
  if (score.totalDelta != null && score.totalDelta >= 5) return 'Best fortnight in a while. Keep this rhythm going.';
  const bits = [];
  if (workouts.planned && workouts.done >= workouts.planned) bits.push('training');
  if (protein.target && protein.avg != null && protein.avg >= protein.target * 0.9) bits.push('protein');
  if (checkinDays >= 12) bits.push('check-ins');
  if (bits.length === 3) return 'Training, protein and check-ins all on target.';
  if (bits.length === 2) return bits[0].charAt(0).toUpperCase() + bits[0].slice(1) + ' and ' + bits[1] + ' both on target.';
  if (bits.length === 1) return bits[0].charAt(0).toUpperCase() + bits[0].slice(1) + ' on target. One more habit and this climbs fast.';
  if (score.totalDelta != null && score.totalDelta < 0) return 'A quieter fortnight. Small daily check-ins bring it back.';
  return 'Every check-in, meal and workout you log moves this score.';
}

/** Average of a daily habit over the days it was logged, with goal hits. */
function habit(values, goal) {
  const logged = values.filter((v) => v != null);
  if (!logged.length) return null;
  return {
    avg: round1(avgOf(logged)),
    goal: goal || null,
    days_logged: logged.length,
    days_hit: goal ? logged.filter((v) => v >= goal).length : null
  };
}

function performanceView({ bundle, score, start, end, goalSleep }) {
  const cur = bundle.current || {};
  const targets = bundle.targets || {};
  const inWin = (d) => d && dayNum(d) >= dayNum(start) && dayNum(d) <= dayNum(end);
  const days14 = []; for (let i = 0; i < 14; i++) days14.push(addDays(start, i));

  // Weight: points inside the window, plus the last one before it as "from".
  const weights = ((bundle.history && bundle.history.weights) || []).filter((w) => w && w.date && dayNum(w.date) <= dayNum(end));
  const winW = weights.filter((w) => inWin(w.date));
  const before = weights.filter((w) => dayNum(w.date) < dayNum(start));
  const fromW = before.length ? before[before.length - 1] : (winW[0] || null);
  const toW = winW.length ? winW[winW.length - 1] : null;
  const meas = ((bundle.history && bundle.history.measurements) || []).filter((m) => m && m.waistCm != null && dayNum(m.date) <= dayNum(end));
  const waistIn = meas.filter((m) => inWin(m.date));
  const waistFrom = meas.filter((m) => dayNum(m.date) < dayNum(start)).pop() || waistIn[0] || null;
  const waistTo = waistIn.length ? waistIn[waistIn.length - 1] : null;
  const weight = toW ? {
    points: winW.map((w) => ({ date: w.date, kg: w.weightKg })),
    current: toW.weightKg,
    from: fromW ? fromW.weightKg : null,
    change: fromW && fromW !== toW ? round1(toW.weightKg - fromW.weightKg) : null,
    goal_direction: (bundle.goal && bundle.goal.direction) || null,
    waist: waistTo && waistFrom && waistTo !== waistFrom ? { current: waistTo.waistCm, change: round1(waistTo.waistCm - waistFrom.waistCm) } : null
  } : null;

  // Meals per day inside the window.
  const mealDays = (cur.meals || []).filter((m) => inWin(m.date));
  const mealByDate = new Map(mealDays.map((m) => [m.date, m]));

  // Protein per day: the larger of the check-in figure and the meal-log sum.
  const checkinByDate = new Map();
  (cur.checkins || []).forEach((c) => { if (c.source === 'checkin' && inWin(c.date)) checkinByDate.set(c.date, c); });
  const proteinTarget = targets.protein ? Math.round(targets.protein) : null;
  const pDays = days14.map((d) => {
    const a = checkinByDate.has(d) ? checkinByDate.get(d).proteinG : null;
    const b = mealByDate.has(d) ? mealByDate.get(d).protein : null;
    const g = a == null && !b ? null : Math.round(Math.max(a || 0, b || 0));
    return { date: d, grams: g };
  });
  const pLogged = pDays.filter((x) => x.grams != null);
  const protein = {
    days: pDays,
    avg: pLogged.length ? Math.round(avgOf(pLogged.map((x) => x.grams))) : null,
    target: proteinTarget,
    days_hit: proteinTarget ? pLogged.filter((x) => x.grams >= proteinTarget * 0.9).length : null
  };

  const nutrition = mealDays.length ? {
    days_logged: mealDays.length,
    meals_logged: mealDays.reduce((s, m) => s + (m.meals || 0), 0),
    calories: Math.round(avgOf(mealDays.map((m) => m.calories || 0))),
    calorie_target: targets.calories || null,
    protein: Math.round(avgOf(mealDays.map((m) => m.protein || 0))),
    carbs: Math.round(avgOf(mealDays.map((m) => m.carbs || 0))),
    fat: Math.round(avgOf(mealDays.map((m) => m.fat || 0)))
  } : null;

  // Training.
  const done = (cur.workouts || []).filter((w) => inWin(w.date) && w.completed !== false);
  const minutes = done.reduce((s, w) => s + (w.durationMin || 0), 0);
  const prs = (bundle.prs || []).filter((p) => inWin(p.date)).map((p) => ({ label: p.label || p.key, kg: p.kg, previous_kg: p.previousKg }));
  const workouts = {
    done: done.length,
    planned: cur.plannedWorkouts || null,
    days_trained: new Set(done.map((w) => w.date)).size,
    minutes: minutes || null,
    personal_bests: prs.slice(0, 5)
  };

  // Daily habits against the member's own goals.
  const checkinVals = (k) => days14.map((d) => (checkinByDate.has(d) ? checkinByDate.get(d)[k] : null));
  const sleepGoal = goalSleep || targets.sleepH || 7;
  const habits = {
    steps: habit(checkinVals('steps'), targets.steps || null),
    water: habit(checkinVals('waterL'), targets.waterL || null),
    sleep: habit(checkinVals('sleepH'), sleepGoal)
  };
  if (habits.steps) habits.steps.avg = Math.round(habits.steps.avg);
  const anyHabit = habits.steps || habits.water || habits.sleep;

  const checkinDays = new Set((cur.checkins || []).filter((c) => (c.source === 'checkin' || c.source === 'freeze') && inWin(c.date)).map((c) => c.date));
  const sleepVals = (cur.checkins || []).filter((c) => inWin(c.date) && c.sleepH != null && (c.source === 'checkin' || c.source === 'wearable')).map((c) => c.sleepH);

  const rec = ((bundle.history && bundle.history.recovery) || []).filter((r) => inWin(r.date) && r.value != null);
  const recovery = rec.length ? { avg: Math.round(avgOf(rec.map((r) => r.value))), days: rec.length } : null;

  const pillars = [];
  PILLAR_ORDER.forEach((k) => {
    const p = score.pillars && score.pillars[k];
    // A pillar at 0 (e.g. Yoga for someone who does not do yoga) is hidden rather
    // than shown as a discouraging zero. It still counts in the total.
    if (!p || !p.counted || p.score == null || p.score <= 0) return;
    pillars.push({ key: k, label: p.label, score: p.score, delta: p.deltaPct != null ? p.deltaPct : null });
  });

  const sunday = (bundle.sunday || []).filter((s) => inWin(s.date));
  const wins = sunday.map((s) => s.achievements).filter(Boolean).slice(0, 3);
  const focus = (sunday.find((s) => s.improve) || {}).improve || null;

  // Highlights: positive facts only, most meaningful first, at most four.
  const hl = [];
  if (checkinDays.size >= 10) hl.push(`Checked in ${checkinDays.size} of 14 days`);
  if (weight && weight.change) {
    const dir = weight.goal_direction;
    if ((weight.change < 0 && dir !== 'gain') || (weight.change > 0 && dir === 'gain')) hl.push(`${Math.abs(weight.change)} kg ${weight.change < 0 ? 'down' : 'up'} this fortnight`);
  }
  if (prs.length) hl.push(prs.length === 1 ? `New personal best: ${prs[0].label} ${prs[0].kg} kg` : `${prs.length} new personal bests`);
  if (workouts.planned && workouts.done >= workouts.planned) hl.push('Every planned workout done');
  if (protein.days_hit != null && protein.days_hit >= 7) hl.push(`Protein target hit on ${protein.days_hit} days`);
  if (habits.sleep && habits.sleep.avg >= sleepGoal) hl.push(`Averaged ${habits.sleep.avg} h of sleep`);
  if (habits.steps && habits.steps.goal && habits.steps.avg >= habits.steps.goal) hl.push(`Averaged ${habits.steps.avg.toLocaleString('en-IN')} steps a day`);

  const hasData = checkinDays.size > 0 || done.length > 0 || mealDays.length > 0 || !!weight;
  return {
    period: { start, end, days: 14 },
    previous_end: addDays(start, -1),
    has_data: hasData,
    score: {
      total: score.total,
      grade: score.grade,
      delta: score.totalDelta,
      previous: score.previous ? score.previous.total : null,
      momentum: momentumLabel(score.total),
      line: momentumLine(score, checkinDays.size, workouts, protein)
    },
    pillars,
    highlights: hl.slice(0, 4),
    weight,
    protein,
    nutrition,
    workouts,
    habits: anyHabit ? habits : null,
    checkins: { days: checkinDays.size, of: 14, strip: days14.map((d) => checkinDays.has(d)) },
    meals_logged: nutrition ? nutrition.meals_logged : 0,
    avg_sleep: sleepVals.length ? hoursMinutes(avgOf(sleepVals)) : null,
    recovery,
    wins,
    focus
  };
}

/** Mood and stress across the fortnight, plus days with a mind exercise. */
function mindSummary(rows, exerciseDays) {
  const moods = rows.map((r) => validMood(r.mood)).filter(Boolean);
  const stress = rows.map((r) => validMood(r.stress)).filter(Boolean);
  if (!moods.length && !stress.length && !exerciseDays) return null;
  const moodAvg = moods.length ? avgOf(moods) : null;
  const stressAvg = stress.length ? avgOf(stress) : null;
  return {
    mood_avg: moodAvg == null ? null : round1(moodAvg),
    mood_label: moodAvg == null ? null : moodLabel(Math.round(moodAvg)),
    mood_days: moods.length,
    stress_avg: stressAvg == null ? null : round1(stressAvg),
    stress_label: stressAvg == null ? null : stressLabel(Math.round(stressAvg)),
    stress_days: stress.length,
    exercise_days: exerciseDays || 0
  };
}

module.exports = {
  performanceView,
  mindSummary,
  momentumLine,
  momentumLabel,
  isYmd,
  toYmd,
  addDays,
  dayNum,
  STREAK_MILESTONES,
  FREEZES_PER_MONTH,
  currentRun,
  bestRun,
  milestonesFor,
  milestoneAwards,
  monthCalendar,
  MOODS,
  STRESS,
  validMood,
  moodLabel,
  stressLabel,
  mindStreak,
  sleepWeek,
  MARKER_GRADE_LABEL,
  markerGrade,
  markerBar,
  bloodGradesView
};
