'use strict';

/**
 * Reports module — insight service.
 *
 *   buildInsights(score, bundle, opts) -> {
 *     pillars: { workout: { insight, action }, ... },   // rules, always present
 *     summary: [3 lines], closingNote, targets: [3],     // LLM, rule fallback
 *     improvements: [3], toImprove: [3],                 // deterministic
 *     blood: { ... },                                    // informational only
 *     source: 'ai' | 'rules', aiError
 *   }
 *
 * Order of work: rules first (deterministic, always succeed), then ONE LLM call
 * that sees every metric plus the rule output and writes the three narrative
 * pieces. The LLM's JSON is validated field by field; any field that fails —
 * wrong shape, too long, a number not in the facts, diagnosis language — is
 * replaced by its rule-based version, so a report is never blocked and never
 * carries an unchecked sentence.
 */

const S = require('./reportScore');

const LIMITS = Object.freeze({
  insight: 170, action: 150, summaryLine: 150, closingNote: 650, target: 120, bloodLink: 480
});

const COACH_NAME = () => (process.env.REPORTS_COACH_NAME || 'Kling').trim().slice(0, 40) || 'Kling';

/** Words that would turn an informational report into a medical claim. */
const MEDICAL_RE = /\b(diagnos\w*|disease|disorder|syndrome|prescri\w*|medication|medicine|dosage|cure[sd]?|treat(ment|ing|s)?|pathology|clinical(ly)?|anaemi\w*|anemi\w*|diabet\w*|hypothyroid\w*|hyperthyroid\w*|fatty liver)\b/i;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtInt(n) { return n == null ? '—' : Math.round(n).toLocaleString('en-IN'); }
function fmt1(n) { return n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, ''); }
function plural(n, w, pl) { return `${n} ${n === 1 ? w : (pl || w + 's')}`; }
function periodWord(type) { return type === 'monthly' ? 'month' : 'week'; }
function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—]$/, '') + '…';
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dow(iso) { return new Date(S.dayNum(iso) * 86400000).getUTCDay(); }

// ---------------------------------------------------------------------------
// Rule insights — one Insight + one Action per pillar
// ---------------------------------------------------------------------------

function inPeriod(rows, period) {
  return (rows || []).filter((r) => r && r.date && S.dayNum(r.date) >= S.dayNum(period.start) && S.dayNum(r.date) <= S.dayNum(period.end));
}

function workoutRule(p, ctx) {
  const m = p.metrics;
  if (!m.hasData || m.completed === 0) {
    return {
      insight: `No workouts logged this ${ctx.word} — ${m.planned} ${m.planned === 1 ? 'session was' : 'sessions were'} planned.`,
      action: 'Log every session in My Workout straight after training — even a short one counts.'
    };
  }
  const parts = [`${m.completed} of ${m.planned} planned sessions done (${m.completionPct}%)`];
  if (m.volumeDeltaPct != null) parts.push(`volume ${m.volumeDeltaPct >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(m.volumeDeltaPct))}% on last ${ctx.word}`);
  if (m.avgRpe != null) parts.push(`average effort RPE ${fmt1(m.avgRpe)}`);
  let action;
  if (m.completionPct < 75) action = `Lock ${m.planned} fixed training slots into your calendar for next ${ctx.word}, like meetings.`;
  else if (m.volumeDeltaPct != null && m.volumeDeltaPct < 0) action = 'Add one set or 2.5 kg to your first lift in every session next ' + ctx.word + '.';
  else if (m.avgRpe != null && m.avgRpe < 7) action = 'Take the last set of each exercise to 1–2 reps short of failure (RPE 8).';
  else if (m.avgRpe != null && m.avgRpe > 9) action = 'Keep most sets at RPE 7–9 — leave 1–2 reps in the tank to recover better.';
  else if (m.volumeKg === 0) action = 'Log the weight and reps of your main lifts so progress can be measured.';
  else action = 'Keep the same schedule and add 2.5 kg to your main lift next ' + ctx.word + '.';
  return { insight: parts.join('; ') + '.', action };
}

function nutritionRule(p, ctx) {
  const m = p.metrics;
  if (!m.hasData) {
    return {
      insight: `No meals logged this ${ctx.word} — nutrition cannot be scored without logs.`,
      action: 'Snap every meal in the Nutrition tracker — logging is the fastest way to raise your score.'
    };
  }
  const t = ctx.targets;
  const meals = inPeriod(ctx.bundle && ctx.bundle.current && ctx.bundle.current.meals, ctx.period).filter((d) => (d.meals || 0) > 0);
  // Weekend vs weekday protein pattern (the classic slip).
  if (m.proteinTarget) {
    const gap = (rows) => {
      const g = rows.map((d) => m.proteinTarget - (d.protein || 0)).filter((x) => x > 0);
      return { n: rows.length, avg: g.length ? g.reduce((a, b) => a + b, 0) / rows.length : 0 };
    };
    const we = gap(meals.filter((d) => [0, 6].includes(dow(d.date))));
    const wd = gap(meals.filter((d) => ![0, 6].includes(dow(d.date))));
    if (we.n >= 1 && we.avg >= 10 && we.avg > wd.avg + 5) {
      return {
        insight: `Protein under target on Sat/Sun by avg ${Math.round(we.avg)} g (target ${m.proteinTarget} g).`,
        action: 'Add one 30 g protein shake on weekend mornings.'
      };
    }
  }
  if (m.adherencePct < 60) {
    return {
      insight: `${m.mealsLogged} of ${m.mealsExpected} meals logged (${m.adherencePct}%) across ${plural(m.daysLogged, 'day')}.`,
      action: 'Snap every meal in the Nutrition tracker — logging is the fastest way to raise your score.'
    };
  }
  if (m.proteinTarget && m.avgProtein != null && m.avgProtein < m.proteinTarget * 0.9) {
    return {
      insight: `Protein averaged ${fmtInt(m.avgProtein)} g vs ${m.proteinTarget} g target (−${fmtInt(m.proteinTarget - m.avgProtein)} g) on logged days.`,
      action: 'Add a palm-sized protein serving (~25 g) to lunch and dinner.'
    };
  }
  if (m.calorieTarget && m.avgCalories != null) {
    const diff = m.avgCalories - m.calorieTarget;
    if (Math.abs(diff) > m.calorieTarget * 0.1) {
      return {
        insight: `Calories averaged ${fmtInt(m.avgCalories)} kcal vs ${fmtInt(m.calorieTarget)} target (${diff > 0 ? '+' : '−'}${fmtInt(Math.abs(diff))}).`,
        action: diff > 0 ? 'Swap one snack a day for fruit or Greek yoghurt to close the gap.' : 'Add one balanced snack a day (~300 kcal) to reach your target.'
      };
    }
    return {
      insight: `Calories on target on ${m.calorieHitDays} of ${ctx.days} days; ${m.adherencePct}% of meals logged.`,
      action: 'Keep logging every meal — aim to add one more on-target day next ' + ctx.word + '.'
    };
  }
  return {
    insight: `${m.adherencePct}% of meals logged; protein hit on ${m.proteinHitDays == null ? '—' : m.proteinHitDays} of ${ctx.days} days.`,
    action: t.calories ? 'Plan tomorrow\'s meals tonight so every day lands on target.' : 'Ask your coach to set a calorie target so it can be tracked here.'
  };
}

function checkinRule(p, ctx) {
  const m = p.metrics;
  const c = p.components;
  if (!m.hasData) {
    return {
      insight: `No check-ins logged this ${ctx.word} — sleep, steps and water are unmeasured.`,
      action: 'Check in every evening at the same time — it takes 30 seconds.'
    };
  }
  const weakest = [
    ['completion', c.completion], ['sleep', c.sleep], ['steps', c.steps], ['water', c.water]
  ].sort((a, b) => a[1] - b[1])[0][0];
  if (weakest === 'completion') {
    return { insight: `Checked in on ${m.checkinDays} of ${ctx.days} days (${m.completionPct}%).`, action: 'Set a daily 9 pm reminder and check in before bed — it takes 30 seconds.' };
  }
  if (weakest === 'sleep') {
    return {
      insight: `Sleep hit 7 h on ${m.sleepOkDays} of ${ctx.days} nights${m.avgSleepH != null ? ` (avg ${fmt1(m.avgSleepH)} h)` : ''}.`,
      action: 'Set a fixed lights-out 8 hours before your alarm, screens off 30 minutes earlier.'
    };
  }
  if (weakest === 'steps') {
    return {
      insight: `Steps target (${fmtInt(m.stepsTarget)}) met on ${m.stepsOkDays} of ${ctx.days} days${m.avgSteps != null ? ` (avg ${fmtInt(m.avgSteps)})` : ''}.`,
      action: 'Take a 15-minute walk after lunch and after dinner — about 3,000 extra steps.'
    };
  }
  return {
    insight: `Water target (${fmt1(m.waterTargetL)} L) met on ${m.waterOkDays} of ${ctx.days} days${m.avgWaterL != null ? ` (avg ${fmt1(m.avgWaterL)} L)` : ''}.`,
    action: 'Keep a 1 L bottle on your desk — finish it by noon and again by 5 pm.'
  };
}

function consistencyRule(p, ctx) {
  const m = p.metrics;
  if (!m.hasData) {
    return { insight: `No activity logged on any day this ${ctx.word}.`, action: 'Start with one small win a day: a check-in or one logged meal.' };
  }
  const insight = `Active on ${m.activeDays} of ${ctx.days} days; longest streak ${plural(m.longestStreak, 'day')}; ${plural(m.perfectDays, 'perfect day')}.`;
  let action;
  if (m.activeDays < ctx.days * 0.6) action = 'Never miss twice — if a day slips, log something first thing the next morning.';
  else if (m.perfectDays < ctx.days * 0.5) action = 'Aim for one more perfect day: check in, log all meals and finish the planned session.';
  else action = `Protect the streak — plan your busiest day of the ${ctx.word} in advance.`;
  return { insight, action };
}

function yogaRule(p, ctx) {
  const m = p.metrics;
  if (!m.hasData) {
    return {
      insight: `No yoga sessions logged this ${ctx.word} (plan: ${m.planned}).`,
      action: 'Book three 20-minute yoga sessions — Surya Namaskar in AI Trainer works well on rest days.'
    };
  }
  const mob = m.avgMobility != null ? `; mobility ${fmt1(m.avgMobility)}${m.mobilityDeltaPct != null ? ` (${m.mobilityDeltaPct >= 0 ? '+' : ''}${Math.round(m.mobilityDeltaPct)}%)` : ''}` : '';
  const insight = `${m.sessions} of ${m.planned} planned yoga sessions (${fmtInt(m.minutes)} min)${mob}.`;
  const action = m.sessions < m.planned
    ? `Add ${plural(m.planned - m.sessions, 'short session')} on rest days — 15 minutes is enough.`
    : 'Hold each posture a few breaths longer next ' + ctx.word + ' to build mobility.';
  return { insight, action };
}

function healthRule(p, ctx) {
  const m = p.metrics;
  const b = m.body;
  const bits = [];
  if (b) {
    const dirWord = b.changeKg < 0 ? 'down' : (b.changeKg > 0 ? 'up' : 'steady');
    bits.push(`Weight ${dirWord}${b.changeKg ? ' ' + fmt1(Math.abs(b.changeKg)) + ' kg' : ''} (${fmt1(b.startKg)} → ${fmt1(b.endKg)} kg)${b.targetKg ? `, goal ${fmt1(b.targetKg)} kg` : ''}`);
  }
  if (m.bloodEligible) bits.push(`${m.bloodGood} of ${m.bloodEligible} repeat blood markers improved or in range`);
  if (!bits.length) {
    return {
      insight: `No new weigh-ins or blood work this ${ctx.word}.`,
      action: 'Log your weight weekly in Body Snapshots so progress can be tracked.'
    };
  }
  let action;
  if (!b) action = 'Weigh in once a week, same morning and time, so body progress can be scored.';
  else if (b.direction === 'lose' && b.changeKg >= 0) action = 'Keep protein high and add 2,000 daily steps — that alone moves the scale.';
  else if (b.direction === 'gain' && b.changeKg <= 0) action = 'Add one extra meal or shake a day to support muscle gain.';
  else if (m.outOfRange > 0) action = 'Keep your habits steady and discuss the flagged blood markers with your doctor.';
  else action = 'Stay the course — weigh in 3 mornings a week at the same time.';
  return { insight: bits.join('; ') + '.', action };
}

const RULES = { workout: workoutRule, nutrition: nutritionRule, checkin: checkinRule, consistency: consistencyRule, yoga: yogaRule, health: healthRule };

function ruleInsights(score, bundle) {
  const ctx = {
    type: score.type, word: periodWord(score.type), days: score.period.days, period: score.period,
    targets: (bundle && bundle.targets) || {}, bundle
  };
  const out = {};
  for (const k of S.PILLARS) {
    const r = RULES[k](score.pillars[k], ctx);
    out[k] = { insight: clip(r.insight, LIMITS.insight), action: clip(r.action, LIMITS.action) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top 3 improvements / to-improve
// ---------------------------------------------------------------------------

function pillarDetail(k, p) {
  const m = p.metrics;
  switch (k) {
    case 'workout': return m.hasData ? `${m.completed}/${m.planned} sessions` : 'no sessions logged';
    case 'nutrition': return m.hasData ? `${m.adherencePct}% of meals logged` : 'no meals logged';
    case 'checkin': return m.hasData ? `${m.checkinDays} check-ins` : 'no check-ins';
    case 'consistency': return `${m.activeDays} active days`;
    case 'yoga': return m.hasData ? `${m.sessions}/${m.planned} sessions` : 'no sessions';
    case 'health': return m.body ? `weight ${m.body.changeKg > 0 ? '+' : ''}${fmt1(m.body.changeKg)} kg` : (m.bloodEligible ? `${m.bloodGood}/${m.bloodEligible} markers on track` : 'no new data');
    default: return '';
  }
}

function topMovers(score) {
  const counted = S.PILLARS.filter((k) => score.pillars[k].counted && score.pillars[k].score != null).map((k) => score.pillars[k]);
  const withDelta = counted.filter((p) => p.deltaPct != null);
  // A delta title only when the delta points the way the list is about; an
  // item picked for its grade (not its movement) says so instead — a "to
  // improve" entry must never read "+5 pts".
  const item = (p, kind) => {
    const movedRightWay = p.deltaPct != null && (kind === 'up' ? p.deltaPct > 0 : p.deltaPct < 0);
    return {
      pillar: p.key,
      label: p.label,
      score: p.score,
      grade: p.grade,
      delta: p.deltaPct,
      title: movedRightWay
        ? `${p.label} ${p.deltaPct > 0 ? '+' : '−'}${Math.abs(p.deltaPct)} pts`
        : (kind === 'up' ? `${p.label} strong at ${p.grade} (${p.score})` : `${p.label} at ${p.grade} (${p.score})`),
      detail: pillarDetail(p.key, p)
    };
  };

  const ups = withDelta.filter((p) => p.deltaPct > 0).sort((a, b) => b.deltaPct - a.deltaPct || b.score - a.score);
  const improvements = ups.slice(0, 3).map((p) => item(p, 'up'));
  for (const p of counted.slice().sort((a, b) => b.score - a.score)) {
    if (improvements.length >= 3) break;
    if (!improvements.some((i) => i.pillar === p.key) && p.score > 0) improvements.push(item(p, 'up'));
  }

  const downs = withDelta.filter((p) => p.deltaPct < 0).sort((a, b) => a.deltaPct - b.deltaPct || a.score - b.score);
  const toImprove = downs.slice(0, 3).map((p) => item(p, 'down'));
  for (const p of counted.slice().sort((a, b) => a.score - b.score)) {
    if (toImprove.length >= 3) break;
    if (!toImprove.some((i) => i.pillar === p.key) && !improvements.slice(0, 1).some((i) => i.pillar === p.key)) toImprove.push(item(p, 'down'));
  }
  return { improvements, toImprove };
}

// ---------------------------------------------------------------------------
// Blood section — informational, doctor flag on anything out of range
// ---------------------------------------------------------------------------

const KEY_MARKER_PRIORITY = ['hba1c', 'vitamin d', 'ldl cholesterol', 'hemoglobin', 'triglycerides', 'vitamin b12', 'tsh', 'hdl cholesterol', 'ferritin', 'fasting glucose', 'glucose fasting', 'total cholesterol', 'crp'];

function sanitizeInfo(text) {
  const t = String(text || '').trim();
  if (!t || MEDICAL_RE.test(t)) return '';
  return t;
}

function bloodSection(score, bundle) {
  const markers = (score.detail && score.detail.markers) || [];
  const reports = (bundle && bundle.blood) || [];
  if (!reports.length || !markers.length) {
    return { available: false, rows: [], keyMarkers: [], flagged: [], latestDate: null, aiSummary: '', behaviourLink: '', reportsCount: reports.length };
  }
  const latest = reports[reports.length - 1];
  const flagged = markers.filter((m) => m.inRange === false);
  // Table: flagged first, then repeat readings, then the rest — capped to fit the page.
  const ordered = markers.slice().sort((a, b) => {
    const fa = a.inRange === false ? 0 : 1; const fb = b.inRange === false ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if ((b.readings >= 2) !== (a.readings >= 2)) return (b.readings >= 2) - (a.readings >= 2);
    return String(a.name).localeCompare(String(b.name));
  });
  const rows = ordered.slice(0, 10).map((m) => ({
    name: m.name, value: m.value, unit: m.unit, low: m.low, high: m.high, previous: m.previous,
    status: m.status, movement: m.movement,
    light: m.inRange === false ? 'red' : (m.movement === 'worsened' ? 'amber' : (m.inRange ? 'green' : 'grey')),
    doctor: m.inRange === false
  }));
  const repeat = markers.filter((m) => m.readings >= 2);
  const rank = (m) => {
    const i = KEY_MARKER_PRIORITY.indexOf(m.key);
    return (m.inRange === false ? 0 : 100) + (i < 0 ? 50 : i);
  };
  const keyMarkers = repeat.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 4).map((m) => ({
    name: m.name, unit: m.unit, low: m.low, high: m.high, series: m.series, inRange: m.inRange
  }));

  const improved = repeat.filter((m) => m.movement === 'improved');
  const worsened = repeat.filter((m) => m.movement === 'worsened');
  const n = score.pillars.nutrition.metrics;
  const w = score.pillars.workout.metrics;
  const names = (arr) => arr.slice(0, 3).map((m) => m.name).join(', ') + (arr.length > 3 ? ` and ${arr.length - 3} more` : '');
  let link = '';
  if (repeat.length) {
    const moves = [];
    if (improved.length) moves.push(`${plural(improved.length, 'marker')} moved toward range (${names(improved)})`);
    if (worsened.length) moves.push(`${plural(worsened.length, 'marker')} moved away from range (${names(worsened)})`);
    if (!moves.length) moves.push('your repeat markers held steady');
    link = `Between your last two blood tests, ${moves.join(' and ')}. `
      + `This ${periodWord(score.type)} you logged ${n.adherencePct}% of meals and completed ${w.completionPct}% of planned sessions — `
      + (n.adherencePct >= 70 && w.completionPct >= 70
        ? 'the kind of steady routine that tends to show up in follow-up tests.'
        : 'more consistent logging will make the link between habits and markers clearer.');
  } else {
    link = 'This is your first blood report on BodyBank — once a follow-up test is uploaded, marker movement will be tracked here against your habits.';
  }
  // The informational line and the doctor flag are appended AFTER clipping so a
  // long marker list can never push them off the end.
  const suffix = ' This section is informational only.' + (flagged.length ? ' Please discuss the flagged markers with your doctor.' : '');
  link = clip(link, LIMITS.bloodLink - suffix.length) + suffix;

  const ai = latest.ai || {};
  return {
    available: true,
    latestDate: latest.date,
    reportsCount: reports.length,
    newInPeriod: S.dayNum(latest.date) >= S.dayNum(score.period.start),
    rows,
    hiddenRows: Math.max(0, markers.length - rows.length),
    keyMarkers,
    flagged: flagged.map((m) => m.name),
    improvedCount: improved.length,
    worsenedCount: worsened.length,
    aiSummary: clip(sanitizeInfo(ai.summary), 300),
    behaviourLink: link
  };
}

// ---------------------------------------------------------------------------
// Rule-based narrative (the LLM fallback)
// ---------------------------------------------------------------------------

function ruleNarrative(score, bundle, pillarsText, movers) {
  const first = (bundle && bundle.user && bundle.user.firstName) || 'there';
  const word = periodWord(score.type);
  const counted = S.PILLARS.filter((k) => score.pillars[k].counted && score.pillars[k].score != null);
  const best = counted.slice().sort((a, b) => score.pillars[b].score - score.pillars[a].score)[0];
  const worst = counted.slice().sort((a, b) => score.pillars[a].score - score.pillars[b].score)[0];
  const delta = score.totalDelta;
  const line1 = delta == null
    ? `${first}, your BodyBank Score this ${word} is ${score.total} (${score.grade}) — this sets your baseline.`
    : `${first}, your BodyBank Score this ${word} is ${score.total} (${score.grade}), ${delta > 0 ? 'up ' + delta : (delta < 0 ? 'down ' + Math.abs(delta) : 'level')}${delta ? ' from last ' + word : ' with last ' + word}.`;
  const line2 = best ? `Strongest area: ${score.pillars[best].label} (${score.pillars[best].score}) — ${lowerFirst(pillarsText[best].insight)}` : 'Every area has room to grow from here.';
  const line3 = worst ? `Biggest opportunity: ${score.pillars[worst].label} — ${lowerFirst(pillarsText[worst].action)}` : '';
  const summary = [line1, line2, line3].map((l) => clip(l, LIMITS.summaryLine)).filter(Boolean);
  while (summary.length < 3) summary.push(clip(`Keep logging every day — it is the fastest way to raise your score next ${word}.`, LIMITS.summaryLine));

  const wins = movers.improvements.slice(0, 2).map((i) => i.label.toLowerCase());
  const focus = movers.toImprove.slice(0, 2).map((i) => i.label.toLowerCase());
  const closing = [
    `${first}, thank you for the work you put in this ${word}.`,
    wins.length ? `I can see real effort in your ${wins.join(' and ')}, and that is exactly what builds results.` : 'Every day you log gives us something to build on.',
    focus.length ? `Next ${word} I want us to tighten up your ${focus.join(' and ')} — small, repeatable steps, not a big overhaul.` : '',
    `Your three targets for next ${word} are set out in this report — message me any time something gets in the way. I am in your corner.`
  ].filter(Boolean).join(' ');

  return { summary: summary.slice(0, 3), closingNote: clip(closing, LIMITS.closingNote), targets: ruleTargets(score) };
}

function lowerFirst(s) { const t = String(s || ''); return t ? t.charAt(0).toLowerCase() + t.slice(1) : t; }

/** Three measurable targets from the three weakest scoring components. */
function ruleTargets(score) {
  const P = score.pillars;
  const days = score.period.days;
  const word = periodWord(score.type);
  const cands = [];
  const add = (weight, text) => cands.push({ weight, text });
  const w = P.workout.metrics;
  add(P.workout.components.completion * 0.6, `Complete ${w.planned} of ${w.planned} planned workouts this ${word}.`);
  const n = P.nutrition.metrics;
  add(P.nutrition.components.adherence * 0.5, `Log all ${n.mealsExpected} meals (3 a day) in the Nutrition tracker.`);
  if (n.proteinTarget) add(P.nutrition.components.proteinHitRate * 0.4, `Hit ${n.proteinTarget} g protein on at least ${Math.max(1, Math.ceil(days * 5 / 7))} of ${days} days.`);
  const c = P.checkin.metrics;
  add(P.checkin.components.sleep * 0.4, `Sleep 7 h or more on at least ${Math.max(1, Math.ceil(days * 5 / 7))} of ${days} nights.`);
  add(P.checkin.components.steps * 0.35, `Reach ${fmtInt(c.stepsTarget)} steps on at least ${Math.max(1, Math.ceil(days * 5 / 7))} of ${days} days.`);
  add(P.checkin.components.completion * 0.45, `Check in on all ${days} days.`);
  const y = P.yoga.metrics;
  add(P.yoga.components.sessions * 0.3, `Do ${y.planned} yoga sessions of 15+ minutes.`);
  cands.sort((a, b) => a.weight - b.weight);
  const out = [];
  for (const cnd of cands) { if (!out.includes(cnd.text)) out.push(clip(cnd.text, LIMITS.target)); if (out.length === 3) break; }
  return out;
}

// ---------------------------------------------------------------------------
// LLM layer
// ---------------------------------------------------------------------------

function voiceGuide() {
  try {
    const { STYLE_GUIDE } = require('./waKlingPrompt');
    return String(STYLE_GUIDE || '').split('\n').filter((l) => !/^TODO/i.test(l.trim())).join('\n');
  } catch (_) { return ''; }
}

function buildFacts(score, bundle, pillarsText, movers, blood) {
  const P = {};
  for (const k of S.PILLARS) {
    const p = score.pillars[k];
    P[k] = { score: p.score, grade: p.grade, trend: p.trend, delta: p.deltaPct, counted: p.counted, metrics: p.metrics, ruleInsight: pillarsText[k].insight, ruleAction: pillarsText[k].action };
  }
  return {
    client_first_name: bundle.user.firstName,
    report_type: score.type,
    period: score.period,
    total: score.total, grade: score.grade, total_delta: score.totalDelta,
    previous: score.previous,
    health_redistributed: score.healthRedistributed,
    targets: bundle.targets,
    goal: bundle.goal,
    pillars: P,
    top_improvements: movers.improvements,
    top_to_improve: movers.toImprove,
    blood: blood.available ? {
      reports: blood.reportsCount, flagged_markers: blood.flagged, improved: blood.improvedCount, worsened: blood.worsenedCount,
      rule_behaviour_link: blood.behaviourLink
    } : null
  };
}

function numbersIn(text) {
  return (String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map((s) => s.replace(/,/g, ''));
}

/**
 * Every multi-digit number the LLM writes must exist in the facts as a whole
 * number token — "17.3" is not grounded by a "17" elsewhere, and "55" is not
 * grounded by "155". Decimals must match exactly (or as their one-decimal form).
 */
function numbersGrounded(text, factsText) {
  const tokens = new Set((String(factsText || '').match(/-?\d+(?:\.\d+)?/g) || []).map((t) => t.replace(/^-/, '')));
  for (const n of numbersIn(text)) {
    if (n.replace('.', '').length < 2) continue;
    const v = parseFloat(n);
    const variants = n.includes('.')
      ? [n, v.toFixed(1), String(v)]
      : [n, String(v)];
    if (!variants.some((x) => tokens.has(x))) return false;
  }
  return true;
}

function parseJsonLoose(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; } }
  return null;
}

/**
 * Validates the LLM JSON field by field against the rule fallback.
 * @returns {{ summary, closingNote, targets, bloodLink, rejected: string[] }}
 */
function validateNarrative(raw, fallback, factsText, bloodFallback) {
  const rejected = [];
  const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const clean = (v, max, grounded) => {
    const s = str(v);
    if (!s || s.length > max || MEDICAL_RE.test(s)) return null;
    if (grounded && !numbersGrounded(s, factsText)) return null;
    return s;
  };
  const r = raw && typeof raw === 'object' ? raw : {};
  let summary = Array.isArray(r.summary) ? r.summary.map((l) => clean(l, LIMITS.summaryLine, true)) : [];
  if (summary.length !== 3 || summary.some((l) => !l)) { summary = fallback.summary; rejected.push('summary'); }
  let closingNote = clean(r.closingNote, LIMITS.closingNote, true);
  if (!closingNote || closingNote.length < 80) { closingNote = fallback.closingNote; rejected.push('closingNote'); }
  let targets = Array.isArray(r.targets) ? r.targets.map((t) => clean(t, LIMITS.target, false)) : [];
  if (targets.length !== 3 || targets.some((t) => !t || !/\d/.test(t))) { targets = fallback.targets; rejected.push('targets'); }
  let bloodLink = bloodFallback;
  if (bloodFallback) {
    const bl = clean(r.bloodLink, LIMITS.bloodLink, true);
    if (!bl) rejected.push('bloodLink');
    else {
      bloodLink = bl;
      // The doctor flag is not optional: re-attach it if the model dropped it.
      const needsDoctor = /doctor/i.test(bloodFallback);
      if (needsDoctor && !/doctor/i.test(bl)) {
        const withFlag = bl + ' Please discuss the flagged markers with your doctor.';
        bloodLink = withFlag.length <= LIMITS.bloodLink ? withFlag : bloodFallback;
      }
    }
  }
  return { summary, closingNote, targets, bloodLink, rejected };
}

function aiModel() {
  return (process.env.ANTHROPIC_MODEL_REPORTS || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim();
}

async function callNarrativeModel(facts, opts) {
  const apiKey = (opts && opts.apiKey) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const model = aiModel();
  const system = [
    `You write the narrative parts of a BodyBank client progress report, as the client's coach (${COACH_NAME()}).`,
    'Voice guide (the same voice as our WhatsApp coach):',
    voiceGuide(),
    'This is a printed PDF report, not a chat: use normal sentence case and complete sentences. Direct, warm, first person, no fluff, no emoji.',
    'Use ONLY numbers that appear in FACTS. Never invent weights, measurements, lab values, dates or percentages.',
    'No medical diagnosis, no treatment or supplement advice, no disease names. Blood markers are informational only; anything out of range is for the client to discuss with their doctor.',
    'Return JSON only, no markdown, exactly these keys:',
    '{"summary":["line 1","line 2","line 3"],"closingNote":"...","targets":["...","...","..."],"bloodLink":"..."}',
    `summary: exactly 3 lines, each at most ${LIMITS.summaryLine} characters — line 1 the score and its movement, line 2 the biggest win, line 3 the biggest opportunity.`,
    `closingNote: 3–5 sentences, at most ${LIMITS.closingNote} characters, addressed to the client by first name, signed by nobody.`,
    `targets: exactly 3 measurable targets for the next ${facts.report_type === 'monthly' ? 'month' : 'week'}, each at most ${LIMITS.target} characters and containing a number; base them on the weakest metrics.`,
    `bloodLink: at most ${LIMITS.bloodLink} characters connecting blood marker movement to the nutrition and workout adherence numbers; it never explains what a marker means medically; end with "Please discuss the flagged markers with your doctor." when any are flagged. Empty string when FACTS.blood is null.`
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 25000);
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0.4,
        system,
        messages: [{ role: 'user', content: 'FACTS:\n' + JSON.stringify(facts) }]
      }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
    const text = Array.isArray(data.content) ? data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('') : '';
    return { json: parseJsonLoose(text), usage: data.usage || {}, model };
  } finally {
    clearTimeout(timer);
  }
}

async function recordUsage(result, opts) {
  try {
    const { recordAiUsage, buildUsage } = require('./aiUsageLedger');
    await recordAiUsage({
      scope: 'admin_reports',
      usage: buildUsage(result.model, result.usage.input_tokens || 0, result.usage.output_tokens || 0),
      userId: opts && opts.userId,
      refType: 'client_report',
      refId: opts && opts.refId
    });
  } catch (_) { /* the ledger never blocks a report */ }
}

/**
 * @param {object} score  scoreDataset() output
 * @param {object} bundle loadReportBundle() output (or a seeded equivalent)
 * @param {object} [opts] { ai: boolean (default true), apiKey, fetchImpl, userId, timeoutMs }
 */
async function buildInsights(score, bundle, opts) {
  const o = opts || {};
  const pillars = ruleInsights(score, bundle);
  const movers = topMovers(score);
  const blood = bloodSection(score, bundle);
  const fallback = ruleNarrative(score, bundle, pillars, movers);
  const out = {
    pillars, improvements: movers.improvements, toImprove: movers.toImprove, blood,
    summary: fallback.summary, closingNote: fallback.closingNote, targets: fallback.targets,
    source: 'rules', aiError: null, aiRejected: []
  };
  if (o.ai === false) return out;
  try {
    const facts = buildFacts(score, bundle, pillars, movers, blood);
    const res = await callNarrativeModel(facts, o);
    recordUsage(res, o);
    if (!res.json) throw new Error('model returned no JSON');
    const v = validateNarrative(res.json, fallback, JSON.stringify(facts), blood.available ? blood.behaviourLink : '');
    out.summary = v.summary; out.closingNote = v.closingNote; out.targets = v.targets;
    if (blood.available) out.blood.behaviourLink = v.bloodLink;
    out.aiRejected = v.rejected;
    out.source = v.rejected.length >= 3 ? 'rules' : 'ai';
  } catch (err) {
    out.aiError = String(err && err.message ? err.message : err).slice(0, 200);
  }
  return out;
}

/**
 * Applies admin edits over the generated narrative. Edits are validated with
 * the same length limits (never the grounding check — the coach may add facts).
 */
function applyEdits(insights, edits) {
  const e = edits && typeof edits === 'object' ? edits : {};
  const out = Object.assign({}, insights);
  const txt = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : null);
  if (e.summary != null) {
    const lines = (Array.isArray(e.summary) ? e.summary : String(e.summary).split('\n'))
      .map((l) => txt(String(l), LIMITS.summaryLine)).filter(Boolean).slice(0, 3);
    if (lines.length) out.summary = lines;
  }
  if (e.closingNote != null) {
    const c = txt(e.closingNote, LIMITS.closingNote);
    if (c) out.closingNote = c.replace(/\s*\n\s*/g, ' ');
  }
  if (Array.isArray(e.targets)) {
    const t = e.targets.map((x) => txt(String(x == null ? '' : x), LIMITS.target)).filter(Boolean).slice(0, 3);
    if (t.length) out.targets = t;
  }
  return out;
}

module.exports = {
  buildInsights,
  applyEdits,
  ruleInsights,
  topMovers,
  bloodSection,
  ruleNarrative,
  validateNarrative,
  parseJsonLoose,
  numbersGrounded,
  LIMITS,
  MEDICAL_RE,
  COACH_NAME
};
