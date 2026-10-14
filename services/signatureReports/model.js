'use strict';

/**
 * Signature reports — the view model. PURE: (bundle, extras, options) -> model.
 *
 * Everything the Signature weekly / monthly templates print is computed here,
 * from the same BodyBank Score the classic reports use (services/reportScore.js),
 * so the two templates always agree on the number. On top of the score this adds:
 *
 *   promise   last Signature report's 3 targets, scored against this period
 *   patterns  the "why engine": paired comparisons over the member's own days
 *             (sleep -> training, weekend drift, stress -> logging, ...)
 *   targets   3 structured targets for next period, each with the score points
 *             it is worth (exact for the linear parts of the pillar formulas)
 *   lever     the single target worth the most points
 *   projection current score + the points of all three targets (capped at 100)
 *   journey   (monthly) since-day-one: weight, waist, lifts, photos
 *   weeks     (monthly) a BodyBank Score for every week inside the month
 *   review    staff-only flags for the approval screen — never printed
 *
 * No clock, no network, no randomness: same input, same model. The template and
 * the stored snapshot both read this object, so a PDF rebuilt later is identical.
 */

const S = require('../reportScore');

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function r0(v) { return v == null ? null : Math.round(v); }
function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function mean(a) { const xs = a.filter((x) => x != null); return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null; }
function dowOf(iso) { return new Date(S.dayNum(iso) * 86400000).getUTCDay(); }
function within(iso, a, b) { const n = S.dayNum(iso); return n >= S.dayNum(a) && n <= S.dayNum(b); }
function shortDate(iso) { const d = new Date(S.dayNum(iso) * 86400000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }
function longDate(iso) { const d = new Date(S.dayNum(iso) * 86400000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function fmtInt(n) { return n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-IN'); }
function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(1, max - 1)).trim() + '…' : t;
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

function periodLabel(type, start, end) {
  const a = new Date(S.dayNum(start) * 86400000); const b = new Date(S.dayNum(end) * 86400000);
  const whole = a.getUTCDate() === 1 && S.addDays(end, 1).slice(8, 10) === '01' && a.getUTCMonth() === b.getUTCMonth();
  if (type === 'monthly' && whole) return `${MON_LONG[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  return `${a.getUTCDate()} ${MON[a.getUTCMonth()]}${sameYear ? '' : ' ' + a.getUTCFullYear()} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

/** The period that follows this one: the next block of the same length (2 weeks), or the next calendar month. */
function nextPeriod(type, end, days) {
  const start = S.addDays(end, 1);
  if (type === 'monthly') {
    const y = Number(start.slice(0, 4)); const m = Number(start.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { start, end: `${start.slice(0, 8)}${String(last).padStart(2, '0')}`, days: last - Number(start.slice(8, 10)) + 1 };
  }
  const n = Math.max(1, days || 7);
  return { start, end: S.addDays(start, n - 1), days: n };
}

/** Report names printed on the PDF, in emails and in file names. */
const REPORT_NAMES = Object.freeze({ weekly: 'Performance Report', monthly: 'Transformation Report' });
/** 'fortnight' for the 2-week Performance Report, 'week' for a legacy 7-day one, 'month' otherwise. */
function periodWord(type, days) { return type === 'monthly' ? 'month' : (days > 7 ? 'fortnight' : 'week'); }

// ---------------------------------------------------------------------------
// Daily rows: one merged record per day, all sources
// ---------------------------------------------------------------------------

function dailyRows(bundle, extras, a, b) {
  const map = new Map();
  for (const d of S.datesInRange(a, b)) {
    map.set(d, { date: d, dow: dowOf(d), checkin: false, freeze: false, sleepH: null, steps: null, waterL: null,
      meals: 0, calories: null, protein: null, workout: false, workoutName: '', energy: null, rpe: null, volumeKg: 0,
      yoga: false, yogaMin: 0, mood: null, stress: null, hrv: null, rhr: null, recovery: null, strain: null, weight: null });
  }
  const h = bundle.history || {};
  const ownWins = (cur, f, v, own) => { if (v != null && (cur[f] == null || own)) cur[f] = v; };
  for (const c of h.checkins || []) {
    const row = map.get(c.date); if (!row) continue;
    const own = c.source === 'checkin';
    if (c.source === 'freeze') { row.freeze = true; continue; }
    if (own) row.checkin = true;
    if (c.source === 'derived') { if (c.energy != null) row.energy = c.energy; continue; }
    ownWins(row, 'sleepH', num(c.sleepH), own);
    ownWins(row, 'steps', num(c.steps), own);
    ownWins(row, 'waterL', num(c.waterL), own);
  }
  for (const m of h.meals || []) {
    const row = map.get(m.date); if (!row) continue;
    row.meals = Math.max(row.meals, Math.min(6, num(m.meals) || 0));
    row.calories = num(m.calories); row.protein = num(m.protein);
  }
  for (const w of h.workouts || []) {
    const row = map.get(w.date); if (!row || !w.completed) continue;
    row.workout = true;
    if (!row.workoutName) row.workoutName = String(w.name || 'Workout');
    if (w.rpe != null) row.rpe = w.rpe;
    row.volumeKg += num(w.volumeKg) || 0;
  }
  for (const y of h.yoga || []) {
    const row = map.get(y.date); if (!row) continue;
    row.yoga = true; row.yogaMin += num(y.durationMin) || 0;
  }
  for (const w of h.weights || []) { const row = map.get(w.date); if (row) row.weight = num(w.weightKg); }
  const ex = extras || {};
  for (const m of ex.moods || []) {
    const row = map.get(m.date); if (!row) continue;
    row.mood = num(m.mood); row.stress = num(m.stress);
  }
  for (const r of ex.readiness || []) {
    const row = map.get(r.date); if (!row) continue;
    row.hrv = num(r.hrv); row.rhr = num(r.rhr); row.recovery = num(r.recovery); row.strain = num(r.strain);
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Target catalogue — measured exactly the way the score measures it
// ---------------------------------------------------------------------------

/**
 * Each metric reads the scored period (pillar metrics) and knows how many
 * BodyBank Score points one more unit is worth under the pillar formulas in
 * docs/REPORTS.md. These are the linear components, so the value is exact up
 * to each component's cap.
 */
const METRICS = {
  workouts: {
    pillar: 'workout',
    read: (sc) => sc.pillars.workout.metrics.completed,
    max: (sc) => sc.pillars.workout.metrics.planned,
    perUnit: (sc) => { const pl = sc.pillars.workout.metrics.planned; return pl > 0 ? (0.6 * (sc.weights.workout || 0)) / pl : 0; },
    step: { weekly: 1, monthly: 3 },
    unit: 'sessions',
    label: (v) => `Complete ${plural(v, 'planned workout')}`,
    short: 'Workouts done'
  },
  protein: {
    pillar: 'nutrition',
    needs: (sc) => !!sc.pillars.nutrition.metrics.proteinTarget,
    read: (sc) => sc.pillars.nutrition.metrics.proteinHitDays || 0,
    max: (sc) => sc.period.days,
    perUnit: (sc) => (0.2 * (sc.weights.nutrition || 0)) / sc.period.days,
    step: { weekly: 2, monthly: 6 },
    unit: 'days',
    label: (v, sc, max) => `Hit ${fmtInt(sc.pillars.nutrition.metrics.proteinTarget)} g protein ${v >= max ? 'every day' : 'on ' + plural(v, 'day')}`,
    short: 'Protein days'
  },
  calories: {
    pillar: 'nutrition',
    needs: (sc) => !!sc.pillars.nutrition.metrics.calorieTarget,
    read: (sc) => sc.pillars.nutrition.metrics.calorieHitDays || 0,
    max: (sc) => sc.period.days,
    perUnit: (sc) => (0.3 * (sc.weights.nutrition || 0)) / sc.period.days,
    step: { weekly: 2, monthly: 6 },
    unit: 'days',
    label: (v, sc, max) => `Land within 10% of ${fmtInt(sc.pillars.nutrition.metrics.calorieTarget)} kcal ${v >= max ? 'every day' : 'on ' + plural(v, 'day')}`,
    short: 'Calorie days'
  },
  meals: {
    pillar: 'nutrition',
    read: (sc) => sc.pillars.nutrition.metrics.mealsLogged || 0,
    max: (sc) => sc.pillars.nutrition.metrics.mealsExpected || sc.period.days * 3,
    perUnit: (sc) => (0.5 * (sc.weights.nutrition || 0)) / Math.max(1, sc.pillars.nutrition.metrics.mealsExpected || sc.period.days * 3),
    step: { weekly: 5, monthly: 15 },
    unit: 'meals',
    label: (v, sc, max) => (v >= max ? `Log all ${v} meals` : `Log ${plural(v, 'meal')}`),
    short: 'Meals logged'
  },
  checkins: {
    pillar: 'checkin',
    read: (sc) => sc.pillars.checkin.metrics.checkinDays || 0,
    max: (sc) => sc.period.days,
    perUnit: (sc) => (0.5 * (sc.weights.checkin || 0)) / sc.period.days,
    step: { weekly: 2, monthly: 6 },
    unit: 'days',
    label: (v, sc, max) => (v >= max ? 'Check in every day' : `Check in on ${plural(v, 'day')}`),
    short: 'Check-in days'
  },
  sleep: {
    pillar: 'checkin',
    read: (sc) => sc.pillars.checkin.metrics.sleepOkDays || 0,
    max: (sc) => sc.period.days,
    perUnit: (sc) => (0.2 * (sc.weights.checkin || 0)) / sc.period.days,
    step: { weekly: 2, monthly: 6 },
    unit: 'nights',
    label: (v, sc, max) => (v >= max ? 'Sleep 7 h or more every night' : `Sleep 7 h or more on ${plural(v, 'night')}`),
    short: '7 h+ nights'
  },
  steps: {
    pillar: 'checkin',
    read: (sc) => sc.pillars.checkin.metrics.stepsOkDays || 0,
    max: (sc) => sc.period.days,
    perUnit: (sc) => (0.15 * (sc.weights.checkin || 0)) / sc.period.days,
    step: { weekly: 2, monthly: 6 },
    unit: 'days',
    label: (v, sc, max) => `Walk ${fmtInt(sc.pillars.checkin.metrics.stepsTarget)} steps ${v >= max ? 'every day' : 'on ' + plural(v, 'day')}`,
    short: 'Steps days'
  },
  water: {
    pillar: 'checkin',
    read: (sc) => sc.pillars.checkin.metrics.waterOkDays || 0,
    max: (sc) => sc.period.days,
    perUnit: (sc) => (0.15 * (sc.weights.checkin || 0)) / sc.period.days,
    step: { weekly: 2, monthly: 6 },
    unit: 'days',
    label: (v, sc, max) => `Drink ${sc.pillars.checkin.metrics.waterTargetL} L of water ${v >= max ? 'every day' : 'on ' + plural(v, 'day')}`,
    short: 'Water days'
  },
  yoga: {
    pillar: 'yoga',
    read: (sc) => sc.pillars.yoga.metrics.sessions || 0,
    max: (sc) => sc.pillars.yoga.metrics.planned || 0,
    perUnit: (sc) => { const pl = sc.pillars.yoga.metrics.planned; return pl > 0 ? (0.7 * (sc.weights.yoga || 0)) / pl : 0; },
    step: { weekly: 1, monthly: 3 },
    unit: 'sessions',
    label: (v) => `Do ${plural(v, 'yoga session')}`,
    short: 'Yoga sessions'
  }
};
const METRIC_KEYS = Object.keys(METRICS);

/** Rescale a count from this period's length to the next period's. */
function rescale(v, fromDays, toDays) { return fromDays === toDays ? v : Math.round((v * toDays) / fromDays); }

function buildTargets(score, next) {
  const type = score.type;
  const days = score.period.days;
  const cands = [];
  for (const key of METRIC_KEYS) {
    const M = METRICS[key];
    if (M.needs && !M.needs(score)) continue;
    const ppu = M.perUnit(score);
    if (!(ppu > 0)) continue;
    const cur = M.read(score);
    const max = M.max(score);
    if (!(max > 0)) continue;
    const room = Math.max(0, max - Math.min(cur, max));
    const step = Math.min(room, M.step[type] || 1);
    const gainNow = step * ppu;           // points, measured on this period's length
    cands.push({ key, cur, max, step, ppu, gain: gainNow });
  }
  cands.sort((x, y) => (y.gain - x.gain) || (METRIC_KEYS.indexOf(x.key) - METRIC_KEYS.indexOf(y.key)));
  // At most two targets from one pillar, so the plan is not "three nutrition chores".
  const picked = []; const perPillar = {};
  for (const c of cands) {
    if (picked.length === 3) break;
    if (c.step <= 0) continue;
    const p = METRICS[c.key].pillar;
    if ((perPillar[p] || 0) >= 2) continue;
    perPillar[p] = (perPillar[p] || 0) + 1;
    picked.push(c);
  }
  // A client who maxed everything: hold the three most valuable habits instead.
  for (const c of cands) {
    if (picked.length === 3) break;
    if (picked.find((p) => p.key === c.key)) continue;
    picked.push(Object.assign({}, c, { step: 0, gain: 0, hold: true }));
  }
  return picked.map((c, i) => {
    const M = METRICS[c.key];
    const goalNow = Math.min(c.max, Math.min(c.cur, c.max) + c.step);
    const maxNext = rescale(c.max, days, next.days);
    const value = Math.max(1, Math.min(maxNext, rescale(goalNow, days, next.days)));
    return {
      id: 't' + (i + 1),
      metric: c.key,
      value,
      unit: M.unit,
      label: M.label(value, score, maxNext),
      short: M.short,
      baseline: c.cur,
      baselineOf: c.max,
      points: r1(c.gain),
      hold: !!c.hold
    };
  });
}

/** Scores last report's structured targets against this period. */
function promiseCheck(prev, score) {
  if (!prev || !Array.isArray(prev.targets) || !prev.targets.length) return null;
  const items = [];
  for (const t of prev.targets.slice(0, 3)) {
    const M = METRICS[t && t.metric];
    const goal = num(t && t.value);
    if (!M || goal == null || goal <= 0) {
      items.push({ label: clip((t && t.label) || 'Coach target', 90), status: 'manual', actual: null, goal: null, unit: '' });
      continue;
    }
    const actual = M.read(score);
    const status = actual >= goal ? 'hit' : (actual >= goal * 0.7 ? 'close' : 'miss');
    items.push({ label: clip(t.label || M.label(goal, score), 90), status, actual, goal, unit: M.unit, short: M.short });
  }
  const scored = items.filter((i) => i.status !== 'manual');
  return {
    fromPeriod: prev.periodLabel || '',
    items,
    hit: scored.filter((i) => i.status === 'hit').length,
    close: scored.filter((i) => i.status === 'close').length,
    of: scored.length
  };
}

// ---------------------------------------------------------------------------
// The why engine — paired comparisons over the member's own days
// ---------------------------------------------------------------------------

function pct(n, d) { return d ? Math.round((n / d) * 100) : null; }

function patternEngine(rows, ctx) {
  const out = [];
  const minN = ctx.minN;
  const span = ctx.spanLabel;

  // 1) Sleep -> training the same day (sleep logged on a date is the night before it).
  {
    const good = rows.filter((r) => r.sleepH != null && r.sleepH >= 7);
    const short = rows.filter((r) => r.sleepH != null && r.sleepH < 7);
    if (good.length >= minN && short.length >= minN) {
      const a = pct(good.filter((r) => r.workout || r.yoga).length, good.length);
      const b = pct(short.filter((r) => r.workout || r.yoga).length, short.length);
      const diff = a - b;
      if (Math.abs(diff) >= 15) {
        out.push({
          key: 'sleep_training', icon: 'moon', tone: diff > 0 ? 'insight' : 'note',
          title: diff > 0 ? 'Sleep is your training switch' : 'You train through short nights',
          text: diff > 0
            ? `${span}, you trained on ${a}% of days after 7 h+ sleep, and on ${b}% after shorter nights.`
            : `${span}, you trained on ${b}% of days after short nights and ${a}% after 7 h+ sleep — protect sleep so the work pays off.`,
          a: { label: 'After 7 h+ sleep', value: a, display: a + '%' },
          b: { label: 'After < 7 h', value: b, display: b + '%' },
          max: 100, effect: Math.min(1, Math.abs(diff) / 60)
        });
      }
    }
  }

  // 2) Weekend drift — the biggest weekday/weekend gap among protein, meals, steps.
  {
    const wkd = rows.filter((r) => r.dow >= 1 && r.dow <= 5);
    const wke = rows.filter((r) => r.dow === 0 || r.dow === 6);
    const cands = [];
    const add = (key, field, unit, title, dec, onlyLogged, verb) => {
      const f = (r) => (onlyLogged ? r[field] != null && r.meals > 0 : r[field] != null);
      const A = wkd.filter(f).map((r) => r[field]); const B = wke.filter(f).map((r) => r[field]);
      if (A.length < Math.max(3, minN) || B.length < Math.max(2, minN - 1)) return;
      const ma = mean(A); const mb = mean(B);
      if (!(ma > 0)) return;
      const rel = (mb - ma) / ma;
      if (Math.abs(rel) < 0.12) return;
      const fmt = (v) => (dec ? r1(v) : fmtInt(v)) + unit;
      cands.push({
        key: 'weekend_' + key, icon: 'calendar', tone: rel < 0 ? 'note' : 'insight',
        title: rel < 0 ? `Weekends cost you ${title.toLowerCase()}` : `Weekends lift your ${title.toLowerCase()}`,
        text: `${span}, you ${verb(fmt(ma))} a day on weekdays and ${fmt(mb)} on weekends.`,
        a: { label: 'Weekdays', value: ma, display: fmt(ma) },
        b: { label: 'Weekends', value: mb, display: fmt(mb) },
        max: Math.max(ma, mb) * 1.1, effect: Math.min(1, Math.abs(rel) / 0.35)
      });
    };
    add('protein', 'protein', ' g', 'Protein', false, true, (v) => `ate ${v} of protein`);
    add('steps', 'steps', '', 'Steps', false, false, (v) => `walked ${v} steps`);
    add('meals', 'meals', '', 'Meals logged', true, false, (v) => `logged ${v} meals`);
    cands.sort((x, y) => y.effect - x.effect);
    if (cands[0]) out.push(cands[0]);
  }

  // 3) Stress -> logging (Mind check-in stress 1-5).
  {
    const hi = rows.filter((r) => r.stress != null && r.stress >= 4);
    const lo = rows.filter((r) => r.stress != null && r.stress <= 2);
    if (hi.length >= 2 && lo.length >= 2) {
      const a = r1(mean(lo.map((r) => r.meals)));
      const b = r1(mean(hi.map((r) => r.meals)));
      if (a != null && b != null && Math.abs(a - b) >= 0.6) {
        out.push({
          key: 'stress_meals', icon: 'mind', tone: b < a ? 'note' : 'insight',
          title: b < a ? 'Stress pulls your logging down' : 'You stay on plan under stress',
          text: `On calm days you logged ${a} meals; on high-stress days, ${b}.`,
          a: { label: 'Calm days', value: a, display: String(a) },
          b: { label: 'High-stress days', value: b, display: String(b) },
          max: 3.3, effect: Math.min(1, Math.abs(a - b) / 2)
        });
      }
    }
  }

  // 4) Wearable recovery -> training.
  {
    const hi = rows.filter((r) => r.recovery != null && r.recovery >= 67);
    const lo = rows.filter((r) => r.recovery != null && r.recovery < 50);
    if (hi.length >= minN && lo.length >= 2) {
      const a = pct(hi.filter((r) => r.workout).length, hi.length);
      const b = pct(lo.filter((r) => r.workout).length, lo.length);
      if (Math.abs(a - b) >= 15) {
        out.push({
          key: 'recovery_training', icon: 'heart', tone: 'insight',
          title: a > b ? 'You train when your body is ready' : 'You push on low-recovery days',
          text: `${span}, you trained on ${a}% of high-recovery days and ${b}% of low-recovery days.`,
          a: { label: 'Recovery 67+', value: a, display: a + '%' },
          b: { label: 'Recovery < 50', value: b, display: b + '%' },
          max: 100, effect: Math.min(1, Math.abs(a - b) / 60) * 0.9
        });
      }
    }
  }

  // 5) Sleep -> mood.
  {
    const good = rows.filter((r) => r.mood != null && r.sleepH != null && r.sleepH >= 7);
    const short = rows.filter((r) => r.mood != null && r.sleepH != null && r.sleepH < 7);
    if (good.length >= 2 && short.length >= 2) {
      const a = r1(mean(good.map((r) => r.mood))); const b = r1(mean(short.map((r) => r.mood)));
      if (Math.abs(a - b) >= 0.5) {
        out.push({
          key: 'sleep_mood', icon: 'mind', tone: 'insight',
          title: 'Better nights, better days',
          text: `Your mood averaged ${a} of 5 after 7 h+ sleep and ${b} of 5 after shorter nights.`,
          a: { label: 'After 7 h+', value: a, display: a + '/5' },
          b: { label: 'After < 7 h', value: b, display: b + '/5' },
          max: 5, effect: Math.min(1, Math.abs(a - b) / 1.5) * 0.85
        });
      }
    }
  }

  // 6) Training days move you more.
  {
    const tr = rows.filter((r) => r.workout && r.steps != null);
    const rest = rows.filter((r) => !r.workout && !r.yoga && r.steps != null);
    if (tr.length >= minN && rest.length >= minN) {
      const a = mean(tr.map((r) => r.steps)); const b = mean(rest.map((r) => r.steps));
      const rel = a > 0 ? (a - b) / a : 0;
      if (rel >= 0.15) {
        out.push({
          key: 'rest_steps', icon: 'steps', tone: 'note',
          title: 'Rest days go quiet',
          text: `You averaged ${fmtInt(a)} steps on training days and ${fmtInt(b)} on rest days — a walk keeps rest days active.`,
          a: { label: 'Training days', value: a, display: fmtInt(a) },
          b: { label: 'Rest days', value: b, display: fmtInt(b) },
          max: Math.max(a, b) * 1.1, effect: Math.min(1, rel / 0.4) * 0.7
        });
      }
    }
  }

  // 7) Best day of the week (monthly windows only — needs ~3 of each weekday).
  if (ctx.bestDay) {
    const byDow = [0, 1, 2, 3, 4, 5, 6].map((d) => rows.filter((r) => r.dow === d));
    const scoreDay = (r) => (r.checkin ? 1 : 0) + Math.min(3, r.meals) / 3 + (r.workout || r.yoga ? 1 : 0) + (r.sleepH != null && r.sleepH >= 7 ? 1 : 0);
    const avg = byDow.map((list) => (list.length >= 3 ? mean(list.map(scoreDay)) : null));
    const valid = avg.map((v, i) => ({ v, i })).filter((x) => x.v != null);
    if (valid.length >= 5) {
      valid.sort((x, y) => y.v - x.v);
      const best = valid[0]; const worst = valid[valid.length - 1];
      if (best.v - worst.v >= 0.8) {
        out.push({
          key: 'best_day', icon: 'star', tone: 'insight',
          title: `${DOW_LONG[best.i]} is your strongest day`,
          text: `${DOW_LONG[best.i]}s scored ${r1(best.v)} of 4 daily habits on average; ${DOW_LONG[worst.i]}s, ${r1(worst.v)}. Plan ${DOW_LONG[worst.i]} the night before.`,
          a: { label: DOW_LONG[best.i], value: best.v, display: r1(best.v) + '/4' },
          b: { label: DOW_LONG[worst.i], value: worst.v, display: r1(worst.v) + '/4' },
          max: 4, effect: Math.min(1, (best.v - worst.v) / 2) * 0.8
        });
      }
    }
  }

  out.sort((x, y) => y.effect - x.effect);
  return out.slice(0, 3).map((p) => Object.assign(p, { a: Object.assign({}, p.a, { value: r1(p.a.value) }), b: Object.assign({}, p.b, { value: r1(p.b.value) }), max: r1(p.max) }));
}

// ---------------------------------------------------------------------------
// Monthly: a score for every week inside the month
// ---------------------------------------------------------------------------

function sliceFor(bundle, s, e) {
  const t = bundle.targets || {};
  const lastBefore = (rows, date, field) => {
    let o = null;
    for (const r of rows || []) { if (S.dayNum(r.date) >= S.dayNum(date)) break; if (field == null || r[field] != null) o = r; }
    return o;
  };
  return Object.assign({}, bundle.current, {
    period: { start: s, end: e },
    plannedWorkouts: Math.round(((t.workoutsPerWeek || S.DEFAULT_TARGETS.workoutsPerWeek) * S.daysBetween(s, e)) / 7),
    baselineWeight: lastBefore(bundle.current.weights, s, 'weightKg'),
    baselineMeasurement: lastBefore(bundle.current.measurements, s, 'waistCm')
  });
}

function weekScores(bundle, score) {
  const out = [];
  const start = score.period.start; const end = score.period.end;
  const chunks = [];
  for (let d = S.dayNum(start); d <= S.dayNum(end); d += 7) {
    chunks.push({ start: S.isoFromDay(d), end: S.isoFromDay(Math.min(d + 6, S.dayNum(end))) });
  }
  // A tail of 1–3 days joins the week before it.
  if (chunks.length > 1 && S.daysBetween(chunks[chunks.length - 1].start, chunks[chunks.length - 1].end) < 4) {
    const tail = chunks.pop();
    chunks[chunks.length - 1].end = tail.end;
  }
  for (const c of chunks) {
    const prev = S.previousPeriod(c.start, c.end);
    const sc = S.scoreDataset(sliceFor(bundle, c.start, c.end), sliceFor(bundle, prev.start, prev.end), null, 'weekly');
    const a = shortDate(c.start).split(' '); const b = shortDate(c.end).split(' ');
    out.push({ start: c.start, end: c.end, label: a[1] === b[1] ? `${a[0]}–${b[0]} ${b[1]}` : `${a.join(' ')}–${b.join(' ')}`, score: sc.total, grade: sc.grade });
  }
  return out;
}

/** Training volume per week: the last 6 weeks (weekly) or the weeks of the month. */
function volumeWeeks(bundle, score) {
  const end = score.period.end;
  const chunks = [];
  if (score.type === 'monthly') {
    for (let d = S.dayNum(score.period.start); d <= S.dayNum(end); d += 7) chunks.push({ start: S.isoFromDay(d), end: S.isoFromDay(Math.min(d + 6, S.dayNum(end))) });
    if (chunks.length > 1 && S.daysBetween(chunks[chunks.length - 1].start, chunks[chunks.length - 1].end) < 4) { const t = chunks.pop(); chunks[chunks.length - 1].end = t.end; }
  } else {
    for (let i = 5; i >= 0; i -= 1) { const e = S.addDays(end, -7 * i); chunks.push({ start: S.addDays(e, -6), end: e }); }
  }
  return chunks.map((c) => {
    const list = (bundle.history.workouts || []).filter((w) => w.completed && within(w.date, c.start, c.end));
    return { label: shortDate(c.start), v: Math.round(list.reduce((a, w) => a + (num(w.volumeKg) || 0), 0)), sessions: list.length };
  });
}

/** The member's own week, from their month: which days they train, which day slips. */
function blueprint(rows) {
  const scoreDay = (r) => (r.checkin ? 1 : 0) + Math.min(3, r.meals) / 3 + (r.workout || r.yoga ? 1 : 0) + (r.sleepH != null && r.sleepH >= 7 ? 1 : 0);
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const list = rows.filter((r) => r.dow === d);
    if (!list.length) return { dow: DOW[d], plan: '—', trainPct: null, habits: null };
    const trainPct = Math.round((list.filter((r) => r.workout).length / list.length) * 100);
    const yogaPct = Math.round((list.filter((r) => r.yoga).length / list.length) * 100);
    const plan = trainPct >= 50 ? 'Train' : (yogaPct >= 40 ? 'Yoga' : 'Walk + rest');
    return { dow: DOW[d], plan, trainPct, yogaPct, habits: r1(mean(list.map(scoreDay))) };
  });
  const scored = days.filter((d) => d.habits != null);
  if (scored.length < 5) return null;
  const best = scored.slice().sort((a, b) => b.habits - a.habits)[0];
  const worst = scored.slice().sort((a, b) => a.habits - b.habits)[0];
  days.forEach((d) => { d.best = d === best; d.watch = d === worst && best.habits - worst.habits >= 0.5; });
  return { days, trainDays: days.filter((d) => d.plan === 'Train').length };
}

// ---------------------------------------------------------------------------
// Journey (since day one)
// ---------------------------------------------------------------------------

function weeklyWeightSeries(weights, end, maxPoints) {
  const list = (weights || []).filter((w) => w.weightKg != null && S.dayNum(w.date) <= S.dayNum(end));
  if (!list.length) return [];
  const buckets = new Map();
  for (const w of list) {
    const n = S.dayNum(w.date); const wkStart = n - ((new Date(n * 86400000).getUTCDay() + 6) % 7);
    const b = buckets.get(wkStart) || { day: wkStart, vals: [] };
    b.vals.push(w.weightKg); buckets.set(wkStart, b);
  }
  let pts = Array.from(buckets.values()).sort((a, b) => a.day - b.day).map((b) => ({ date: S.isoFromDay(b.day), kg: r1(mean(b.vals)) }));
  if (pts.length > maxPoints) {
    const step = pts.length / maxPoints;
    const keep = [];
    for (let i = 0; i < maxPoints; i += 1) keep.push(pts[Math.floor(i * step)]);
    keep[keep.length - 1] = pts[pts.length - 1];
    pts = keep;
  }
  return pts;
}

function journey(bundle, extras, score) {
  const end = score.period.end;
  const weights = (bundle.history.weights || []).filter((w) => S.dayNum(w.date) <= S.dayNum(end));
  const first = weights[0] || null; const last = weights[weights.length - 1] || null;
  const goal = bundle.goal && bundle.goal.targetWeightKg != null ? num(bundle.goal.targetWeightKg) : null;
  const meas = (bundle.history.measurements || []).filter((m) => m.waistCm != null && S.dayNum(m.date) <= S.dayNum(end));
  const w0 = meas[0] || null; const w1 = meas[meas.length - 1] || null;
  let toGoalPct = null;
  if (first && last && goal != null && first.weightKg !== goal) {
    toGoalPct = Math.max(0, Math.min(100, Math.round(((first.weightKg - last.weightKg) / (first.weightKg - goal)) * 100)));
  }
  const lifts = Object.values((extras && extras.lifts) || {})
    .filter((l) => l && l.first && l.best && l.best.kg > 0)
    .sort((a, b) => (b.best.kg - b.first.kg) - (a.best.kg - a.first.kg) || b.best.kg - a.best.kg)
    .slice(0, 4)
    .map((l) => ({ label: clip(l.label, 26), firstKg: r1(l.first.kg), firstDate: l.first.date, bestKg: r1(l.best.kg), bestDate: l.best.date, gainKg: r1(l.best.kg - l.first.kg) }));
  const memberSince = extras && extras.memberSince ? String(extras.memberSince).slice(0, 10) : (first ? first.date : null);
  const dayN = memberSince && /^\d{4}-\d{2}-\d{2}$/.test(memberSince) ? S.daysBetween(memberSince, end) : null;
  return {
    memberSince: memberSince && dayN != null && dayN > 0 && dayN < 3700 ? memberSince : null,
    dayN: dayN != null && dayN > 0 && dayN < 3700 ? dayN : null,
    weight: first && last ? { startKg: first.weightKg, startDate: first.date, nowKg: last.weightKg, nowDate: last.date, changeKg: r1(last.weightKg - first.weightKg), goalKg: goal, toGoalPct, direction: bundle.goal && bundle.goal.direction } : null,
    waist: w0 && w1 && w0 !== w1 ? { startCm: w0.waistCm, nowCm: w1.waistCm, changeCm: r1(w1.waistCm - w0.waistCm), startDate: w0.date } : null,
    weightSeries: weeklyWeightSeries(weights, end, 40),
    lifts
  };
}

// ---------------------------------------------------------------------------
// Supporting sections
// ---------------------------------------------------------------------------

function wearableSummary(rows, prevRows) {
  const pick = (list, f) => mean(list.map((r) => r[f]));
  const cur = { hrv: pick(rows, 'hrv'), rhr: pick(rows, 'rhr'), recovery: pick(rows, 'recovery'), strain: pick(rows, 'strain') };
  if (cur.hrv == null && cur.rhr == null && cur.recovery == null) return null;
  const prev = { hrv: pick(prevRows, 'hrv'), rhr: pick(prevRows, 'rhr'), recovery: pick(prevRows, 'recovery') };
  return {
    hrv: r0(cur.hrv), rhr: r0(cur.rhr), recovery: r0(cur.recovery), strain: r1(cur.strain),
    hrvDelta: cur.hrv != null && prev.hrv != null ? r0(cur.hrv - prev.hrv) : null,
    rhrDelta: cur.rhr != null && prev.rhr != null ? r0(cur.rhr - prev.rhr) : null,
    recoveryDelta: cur.recovery != null && prev.recovery != null ? r0(cur.recovery - prev.recovery) : null,
    days: rows.filter((r) => r.hrv != null || r.recovery != null).length
  };
}

function mindSummary(rows, extras, a, b) {
  const moods = rows.filter((r) => r.mood != null);
  const stress = rows.filter((r) => r.stress != null);
  const sessions = ((extras && extras.mindSessions) || []).filter((s) => s.date && within(s.date, a, b)).length;
  if (!moods.length && !stress.length && !sessions) return null;
  return {
    avgMood: r1(mean(moods.map((r) => r.mood))), avgStress: r1(mean(stress.map((r) => r.stress))),
    days: Math.max(moods.length, stress.length), sessions
  };
}

function heatLevel(r) {
  if (r.freeze && !r.checkin) return { level: 0, freeze: true };
  let n = 0;
  if (r.checkin) n += 1;
  if (r.meals >= 2) n += 1;
  if (r.workout || r.yoga) n += 1;
  if (r.sleepH != null && r.sleepH >= 7) n += 1;
  return { level: n, freeze: false };
}

function weekMatrix(rows, targets) {
  const t = targets || {};
  return rows.map((r) => ({
    date: r.date, dow: DOW[r.dow], day: Number(r.date.slice(8, 10)),
    checkin: r.checkin, freeze: r.freeze,
    meals: r.meals,
    workout: r.workout ? clip(r.workoutName || 'Workout', 14) : (r.yoga ? 'Yoga' : ''),
    sleepH: r1(r.sleepH), sleepOk: r.sleepH != null && r.sleepH >= (t.sleepH || 7),
    steps: r.steps, stepsOk: r.steps != null && r.steps >= (t.steps || 8000),
    waterL: r1(r.waterL), waterOk: r.waterL != null && r.waterL >= (t.waterL || 3),
    protein: r0(r.protein), proteinOk: r.protein != null && t.protein ? r.protein >= t.protein * 0.9 : null,
    mood: r.mood, stress: r.stress
  }));
}

function pillarRows(score) {
  return S.PILLARS.map((k) => {
    const p = score.pillars[k];
    return { key: k, label: p.label, score: p.score, grade: p.grade, delta: p.deltaPct, weight: p.weight, counted: p.counted };
  });
}

function bloodSummary(bundle, score) {
  const markers = (score.detail && score.detail.markers) || [];
  const reports = (bundle.blood || []).filter((b) => S.dayNum(b.date) <= S.dayNum(score.period.end));
  if (!reports.length) return null;
  const latest = reports[reports.length - 1];
  const tracked = markers.length;
  const inRange = markers.filter((m) => m.inRange === true).length;
  const flagged = markers.filter((m) => m.inRange === false).map((m) => clip(m.name, 28));
  const moved = markers.filter((m) => m.previous != null && m.value != null && m.low != null && m.high != null && m.inRange === true && (m.previous < m.low || m.previous > m.high)).length;
  return {
    reports: reports.length, latestDate: latest.date, tracked, inRange, flagged: flagged.slice(0, 6), flaggedMore: Math.max(0, flagged.length - 6), movedIntoRange: moved,
    newInPeriod: reports.some((b) => within(b.date, score.period.start, score.period.end))
  };
}

function touchpointSummary(extras) {
  const t = (extras && extras.touchpoints) || null;
  if (!t) return null;
  const items = [
    { key: 'messages', label: 'Coach messages', value: num(t.coachMessages) || 0 },
    { key: 'whatsapp', label: 'WhatsApp check-ins', value: num(t.whatsapp) || 0 },
    { key: 'calls', label: 'Calls & consults', value: num(t.calls) || 0 },
    { key: 'sunday', label: 'Sunday reviews', value: num(t.sundayReviews) || 0 },
    { key: 'blood', label: 'Lab reports analysed', value: num(t.bloodAnalysed) || 0 },
    { key: 'reports', label: 'Progress reports', value: num(t.reports) || 0 }
  ];
  const total = items.reduce((a, b) => a + b.value, 0);
  return { items, total };
}

// ---------------------------------------------------------------------------
// Staff-only review flags (shown on the approval screen, never printed)
// ---------------------------------------------------------------------------

function reviewFlags(m, extras) {
  const f = [];
  const s = m.score;
  if (s.totalDelta != null && s.totalDelta <= -8) f.push({ level: 'red', text: `Score fell ${Math.abs(s.totalDelta)} points. Consider a personal call before you send this.` });
  const active = s.pillars.consistency.metrics.activeDays;
  const minActive = m.type === 'monthly' ? 8 : Math.max(3, Math.round((m.period.days * 3) / 7));
  if (active < minActive) f.push({ level: 'red', text: `Only ${active} active ${active === 1 ? 'day' : 'days'} logged. The report will mostly show gaps — check in with the client first.` });
  if (m.blood && m.blood.flagged.length) f.push({ level: 'amber', text: `${m.blood.flagged.length + m.blood.flaggedMore} blood ${m.blood.flagged.length + m.blood.flaggedMore === 1 ? 'marker is' : 'markers are'} out of range. The report carries the "discuss with your doctor" line.` });
  const ex = extras || {};
  if (ex.accessExpiresAt) {
    const left = Math.round((Date.parse(ex.accessExpiresAt) - Date.parse(m.period.end + 'T00:00:00Z')) / 86400000);
    if (Number.isFinite(left) && left >= -3 && left <= 21) {
      f.push({ level: 'amber', text: left >= 0 ? `Membership ends in ${left} ${left === 1 ? 'day' : 'days'}. This report is your renewal conversation — make the note personal.` : 'Membership has already ended. Confirm access before sending.' });
    }
  }
  const last = ex.sundayLatest;
  const bare = (s, n) => clip(s, n).replace(/[.!…]+$/, '');
  if (last && last.questions && last.questions.length > 3) f.push({ level: 'info', text: `They asked in their Sunday check-in: "${bare(last.questions, 160)}". Answer it in your note.` });
  if (last && last.improve && last.improve.length > 3) f.push({ level: 'info', text: `They want to improve: "${bare(last.improve, 120)}".` });
  if (m.promise && m.promise.of && m.promise.hit === m.promise.of) f.push({ level: 'green', text: `Kept all ${m.promise.of} promises from last ${m.word}. Celebrate it in your note.` });
  if (s.totalDelta != null && s.totalDelta >= 8) f.push({ level: 'green', text: `Score up ${s.totalDelta} points. A good moment to ask for a review or referral.` });
  return f;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param bundle   services/reportData.loadReportBundle() output (or seeded)
 * @param extras   services/signatureReports/data.loadExtras() output (or seeded)
 * @param opts     { previous: { targets, periodLabel } | null, coachName }
 */
function buildModel(bundle, extras, opts) {
  const o = opts || {};
  const ex = extras || {};
  const type = bundle.type === 'monthly' ? 'monthly' : 'weekly';
  const score = S.scoreDataset(bundle.current, bundle.previous, bundle.previous2, type);
  const period = score.period;
  const word = periodWord(type, period.days);
  const next = nextPeriod(type, period.end, period.days);

  const rows = dailyRows(bundle, ex, period.start, period.end);
  const prevP = S.previousPeriod(period.start, period.end);
  const prevRows = dailyRows(bundle, ex, prevP.start, prevP.end);
  // Patterns: a weekly report reads the last 4 weeks (7 days is too few to trust),
  // a monthly report reads its own month.
  const patStart = type === 'weekly' ? S.addDays(period.end, -27) : period.start;
  const patRows = type === 'weekly' ? dailyRows(bundle, ex, patStart, period.end) : rows;
  const patterns = patternEngine(patRows, { minN: 3, spanLabel: type === 'weekly' ? 'Over the last 4 weeks' : `In ${periodLabel('monthly', period.start, period.end).split(' ')[0]}`, bestDay: type === 'monthly' });

  const targets = buildTargets(score, next);
  const gains = targets.reduce((a, t) => a + (t.points || 0), 0);
  const projection = { now: score.total, projected: Math.min(100, Math.round(score.total + gains)), gain: r1(Math.min(100 - score.total, gains)) };
  const leverT = targets.filter((t) => !t.hold).sort((a, b) => b.points - a.points)[0] || null;
  const promise = promiseCheck(o.previous, score);

  const achievements = (() => {
    // The shared achievement text says "this week"; a 2-week report says "this fortnight".
    try { return require('../reportService').deriveAchievements(bundle, score).map((a) => Object.assign({}, a, { sub: String(a.sub || '').replace(/\bthis week\b/g, `this ${word}`) })); } catch (_) { return []; }
  })();

  const lastSunday = (ex.sunday || []).filter((s) => s.date && within(s.date, S.addDays(period.start, -1), S.addDays(period.end, 1)))[0] || null;
  const quote = lastSunday && lastSunday.achievements && lastSunday.achievements.length > 3 ? clip(lastSunday.achievements, 220) : null;

  const P = score.pillars;
  const model = {
    version: 1,
    template: 'signature',
    type, word,
    title: REPORT_NAMES[type],
    reportName: REPORT_NAMES[type],
    period: { start: period.start, end: period.end, days: period.days, label: periodLabel(type, period.start, period.end) },
    next: { start: next.start, end: next.end, days: next.days, label: periodLabel(type, next.start, next.end) },
    client: {
      id: bundle.user.id, name: clip(bundle.user.name, 80), firstName: clip(bundle.user.firstName, 30),
      goalLabel: clip(({ fat_loss: 'Fat loss', recomp: 'Recomposition', muscle_gain: 'Muscle gain', performance: 'Performance', general_fitness: 'General fitness' })[bundle.user.goalType] || String(bundle.user.goalType || '').replace(/_/g, ' '), 30),
      planLabel: clip(ex.planLabel || bundle.user.planLabel || '', 30)
    },
    coachName: clip(o.coachName || 'Kling', 40),
    score: {
      total: score.total, grade: score.grade, totalDelta: score.totalDelta,
      previous: score.previous, weights: score.weights, healthRedistributed: score.healthRedistributed,
      pillars: score.pillars, period: score.period, type: score.type, detail: { markers: (score.detail.markers || []).length }
    },
    pillars: pillarRows(score),
    stats: {
      activeDays: P.consistency.metrics.activeDays, longestStreak: P.consistency.metrics.longestStreak, perfectDays: P.consistency.metrics.perfectDays,
      sessions: P.workout.metrics.completed, planned: P.workout.metrics.planned, volumeKg: P.workout.metrics.volumeKg, volumeDeltaPct: P.workout.metrics.volumeDeltaPct,
      avgRpe: P.workout.metrics.avgRpe, minutes: P.workout.metrics.minutes,
      mealsLogged: P.nutrition.metrics.mealsLogged, mealsExpected: P.nutrition.metrics.mealsExpected,
      avgCalories: P.nutrition.metrics.avgCalories, calorieTarget: P.nutrition.metrics.calorieTarget, calorieHitDays: P.nutrition.metrics.calorieHitDays,
      avgProtein: P.nutrition.metrics.avgProtein, proteinTarget: P.nutrition.metrics.proteinTarget, proteinHitDays: P.nutrition.metrics.proteinHitDays,
      checkinDays: P.checkin.metrics.checkinDays, avgSleepH: P.checkin.metrics.avgSleepH, sleepOkDays: P.checkin.metrics.sleepOkDays,
      avgSteps: P.checkin.metrics.avgSteps, stepsTarget: P.checkin.metrics.stepsTarget, stepsOkDays: P.checkin.metrics.stepsOkDays,
      avgWaterL: P.checkin.metrics.avgWaterL, waterTargetL: P.checkin.metrics.waterTargetL,
      yogaSessions: P.yoga.metrics.sessions, yogaPlanned: P.yoga.metrics.planned, yogaMinutes: P.yoga.metrics.minutes,
      body: P.health.metrics.body || null
    },
    matrix: weekMatrix(rows, bundle.targets),
    heat: rows.map((r) => Object.assign({ date: r.date, day: Number(r.date.slice(8, 10)), dow: r.dow }, heatLevel(r))),
    proteinDaily: rows.map((r) => ({ date: r.date, v: r0(r.protein) })),
    caloriesDaily: rows.map((r) => ({ date: r.date, v: r0(r.calories) })),
    sleepDaily: rows.map((r) => ({ date: r.date, v: r1(r.sleepH) })),
    stepsDaily: rows.map((r) => ({ date: r.date, v: r0(r.steps) })),
    waterDaily: rows.map((r) => ({ date: r.date, v: r1(r.waterL) })),
    moodDaily: rows.map((r) => ({ date: r.date, v: r.mood })),
    recoveryDaily: rows.map((r) => ({ date: r.date, v: r0(r.recovery) })),
    volumeWeeks: volumeWeeks(bundle, score),
    blueprint: type === 'monthly' ? blueprint(rows) : null,
    lifetime: ex.lifetime && typeof ex.lifetime === 'object' ? {
      workouts: num(ex.lifetime.workouts), meals: num(ex.lifetime.meals), checkins: num(ex.lifetime.checkins), prs: num(ex.lifetime.prs)
    } : null,
    weightRecent: weeklyWeightSeries(bundle.history.weights, period.end, 12).filter((w) => S.dayNum(w.date) >= S.dayNum(S.addDays(period.end, type === 'monthly' ? -120 : -55))),
    prs: (bundle.prs || []).slice(-6).reverse().map((p) => ({ label: clip(p.label, 24), kg: r1(p.kg), previousKg: r1(p.previousKg), date: p.date })),
    patterns,
    promise,
    targets,
    lever: leverT ? { metric: leverT.metric, label: leverT.label, points: leverT.points, pillar: METRICS[leverT.metric].pillar, baseline: leverT.baseline, baselineOf: leverT.baselineOf, unit: leverT.unit } : null,
    projection,
    achievements: achievements.slice(0, 6).map((a) => ({ icon: a.icon, title: clip(a.title, 60), sub: clip(a.sub, 110) })),
    quote,
    noticed: lastSunday && lastSunday.differences && lastSunday.differences.length > 3 ? clip(lastSunday.differences, 200) : null,
    wearable: wearableSummary(rows, prevRows),
    mind: mindSummary(rows, ex, period.start, period.end),
    blood: bloodSummary(bundle, score),
    journey: type === 'monthly' ? journey(bundle, ex, score) : null,
    weeks: type === 'monthly' ? weekScores(bundle, score) : null,
    touchpoints: type === 'monthly' ? touchpointSummary(ex) : null,
    photos: type === 'monthly' ? photoPick(bundle.photos, period.end) : []
  };
  model.review = reviewFlags(model, Object.assign({}, ex, { sundayLatest: lastSunday }));
  return model;
}

/**
 * Re-derives points, lever and projection for (possibly coach-edited) targets.
 * A custom free-text target carries no points.
 */
function replan(model, targets) {
  const sc = model.score;
  const days = model.period.days; const nextDays = model.next.days;
  const list = (targets || []).map((t) => {
    const M = t && t.metric ? METRICS[t.metric] : null;
    if (!M || t.value == null) return Object.assign({}, t, { points: null });
    const max = M.max(sc);
    const goalNow = Math.min(max, (t.value * days) / nextDays);
    const gain = Math.max(0, goalNow - Math.min(M.read(sc), max)) * M.perUnit(sc);
    return Object.assign({}, t, { points: r1(gain), hold: gain === 0 });
  });
  const gains = list.reduce((a, t) => a + (t.points || 0), 0);
  const top = list.filter((t) => t.points > 0).sort((a, b) => b.points - a.points)[0] || null;
  return {
    targets: list,
    projection: { now: sc.total, projected: Math.min(100, Math.round(sc.total + gains)), gain: r1(Math.min(100 - sc.total, gains)) },
    lever: top ? { metric: top.metric, label: top.label, points: top.points, pillar: METRICS[top.metric].pillar, baseline: top.baseline, baselineOf: top.baselineOf, unit: top.unit } : null
  };
}

/** Earliest and latest shared front photos (all time up to the period end). */
function photoPick(photos, end) {
  const list = (photos || []).filter((p) => p && p.front && S.dayNum(p.date) <= S.dayNum(end));
  if (list.length < 1) return [];
  const pick = list.length > 1 ? [list[0], list[list.length - 1]] : [list[0]];
  return pick.map((p, i) => ({ id: 'photo-' + i, url: p.front, src: p.src || null, date: p.date, label: longDate(p.date) }));
}

module.exports = {
  buildModel,
  replan,
  buildTargets,
  promiseCheck,
  patternEngine,
  dailyRows,
  nextPeriod,
  periodWord,
  REPORT_NAMES,
  periodLabel,
  weekScores,
  METRICS,
  METRIC_KEYS,
  shortDate,
  longDate,
  clip
};
