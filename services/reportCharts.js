'use strict';

/**
 * Reports module — chart DATA. Pure functions: (bundle, score) -> chart specs
 * that templates/report-charts.js draws inside headless Chrome.
 *
 * A spec is { id, kind, w, h, data } with w/h in CSS px at 96 dpi — the exact
 * size of the slot in the A4 template (see MM / px() below), so nothing is
 * scaled after drawing. `empty` on a returned chart means the data source had
 * no entries and the template must print the empty-state line instead.
 */

const S = require('./reportScore');

const PAL = Object.freeze({
  gold: '#9a7b2f', goldLight: '#c8a44e', goldWash: '#f6efdc',
  green: '#16a34a', amber: '#f59e0b', red: '#dc2626', grey: '#9ca3af', track: '#efece5',
  blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100', magenta: '#e87ba4', violet: '#4a3aa7',
  ink: '#1d1c1a'
});
// Validated order (dataviz validator, light surface, adjacent pairs).
const MUSCLE_ORDER = ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Other'];
const MUSCLE_COLOR = { Chest: PAL.blue, Back: PAL.orange, Legs: PAL.aqua, Shoulders: PAL.yellow, Arms: PAL.magenta, Other: PAL.violet };

const MM = 3.7795275591; // CSS px per mm at 96 dpi
function px(mm) { return Math.round(mm * MM); }

function gradeColor(grade) {
  if (grade === 'A+' || grade === 'A') return PAL.green;
  if (grade === 'B' || grade === 'C') return PAL.amber;
  if (grade === 'D' || grade === 'E') return PAL.red;
  return PAL.grey;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dparts(iso) { const d = new Date(S.dayNum(iso) * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() }; }
function dayLabel(iso) { const p = dparts(iso); return `${DOW[p.w]} ${p.d}`; }
function shortDate(iso) { const p = dparts(iso); return `${p.d} ${MON[p.m]}`; }
function monthYear(iso) { const p = dparts(iso); return `${MON[p.m]} ${String(p.y).slice(2)}`; }

/** Consecutive chunks of `size` days from start to end (last may be short). */
function chunks(start, end, size) {
  const out = [];
  for (let s = S.dayNum(start); s <= S.dayNum(end); s += size) {
    const e = Math.min(s + size - 1, S.dayNum(end));
    out.push({ start: S.isoFromDay(s), end: S.isoFromDay(e), days: e - s + 1, label: shortDate(S.isoFromDay(s)) });
  }
  return out;
}
function within(r, a, b) { return r && r.date && S.dayNum(r.date) >= S.dayNum(a) && S.dayNum(r.date) <= S.dayNum(b); }
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function mean(a) { return a.length ? sum(a) / a.length : null; }
function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }

/** Trend window for history charts: 6 weeks (weekly) or three periods (monthly). */
function trendWindow(score) {
  if (score.type === 'monthly') {
    const p1 = S.previousPeriod(score.period.start, score.period.end);
    const p2 = S.previousPeriod(p1.start, p1.end);
    return { start: p2.start, end: score.period.end };
  }
  return { start: S.addDays(score.period.end, -41), end: score.period.end };
}

/** Buckets used by "per period" bar charts: days (weekly) or 7-day chunks (monthly). */
function periodBuckets(score) {
  if (score.type === 'weekly') {
    return S.datesInRange(score.period.start, score.period.end).map((d) => ({ start: d, end: d, days: 1, label: dayLabel(d) }));
  }
  return chunks(score.period.start, score.period.end, 7);
}

function dailyCheckins(bundle, a, b) {
  const m = new Map();
  for (const c of bundle.history.checkins || []) {
    if (!within(c, a, b)) continue;
    const cur = m.get(c.date) || { date: c.date };
    const own = !['wearable', 'derived', 'freeze'].includes(c.source);
    for (const f of ['sleepH', 'steps', 'waterL', 'energy']) {
      if (c[f] != null && (cur[f] == null || own)) cur[f] = c[f];
    }
    if (own) cur.checkin = true;
    if (c.source === 'freeze') cur.freeze = true;
    m.set(c.date, cur);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Chart builders — each returns { spec, empty, caption, title }
// ---------------------------------------------------------------------------

function gaugeSpec(id, value, grade, sizeMm, cutout) {
  return { id, kind: 'gauge', w: px(sizeMm), h: px(sizeMm), data: { value: value || 0, color: gradeColor(grade), track: PAL.track, cutout } };
}

function plannedVsCompleted(bundle, score, w, h) {
  const weekly = score.type === 'weekly';
  const buckets = weekly ? chunks(S.addDays(score.period.end, -41), score.period.end, 7) : chunks(score.period.start, score.period.end, 7);
  const perWeek = bundle.targets.workoutsPerWeek || S.DEFAULT_TARGETS.workoutsPerWeek;
  const planned = buckets.map((b) => Math.round((perWeek * b.days) / 7));
  const completed = buckets.map((b) => bundle.history.workouts.filter((x) => x.completed && within(x, b.start, b.end)).length);
  const m = score.pillars.workout.metrics;
  const prevM = score.detail.previousPillars && score.detail.previousPillars.workout.metrics;
  const prevTxt = prevM && score.previous ? `, vs ${prevM.completed} last ${weekly ? 'week' : 'month'}` : '';
  return {
    title: 'Planned vs completed sessions',
    caption: `${m.completed} of ${m.planned} planned sessions completed${prevTxt}.`,
    empty: false,
    spec: {
      id: 'workout-planned', kind: 'bars', w, h,
      data: {
        labels: buckets.map((b) => b.label), xTitle: 'Week starting', yTitle: 'Sessions', yDecimals: 0,
        ySuggestedMax: Math.max(...planned, ...completed, 1) + 1,
        datasets: [{ label: 'Planned', data: planned, color: PAL.grey }, { label: 'Completed', data: completed, color: PAL.gold }]
      }
    }
  };
}

function volumeByMuscle(bundle, score, w, h) {
  const buckets = periodBuckets(score);
  const byGroup = {};
  for (const g of MUSCLE_ORDER) byGroup[g] = buckets.map(() => 0);
  buckets.forEach((b, i) => {
    for (const wk of bundle.history.workouts) {
      if (!wk.completed || !within(wk, b.start, b.end)) continue;
      for (const [g, v] of Object.entries(wk.muscleVolume || {})) {
        const key = MUSCLE_ORDER.includes(g) ? g : 'Other';
        byGroup[key][i] += v;
      }
    }
  });
  const groups = MUSCLE_ORDER.filter((g) => sum(byGroup[g]) > 0);
  const totalAll = sum(groups.map((g) => sum(byGroup[g])));
  if (!groups.length) {
    return { title: 'Volume by muscle group', empty: true, emptyText: 'No lifting weights logged this period — log the weight and reps of your lifts to track volume', caption: '' };
  }
  const top = groups.slice().sort((a, b) => sum(byGroup[b]) - sum(byGroup[a]))[0];
  return {
    title: 'Volume by muscle group',
    caption: `Most volume went to ${top.toLowerCase()} (${Math.round((sum(byGroup[top]) / totalAll) * 100)}%); total ${Math.round(totalAll).toLocaleString('en-IN')} kg.`,
    empty: false,
    spec: {
      id: 'workout-muscle', kind: 'bars', w, h,
      data: {
        labels: buckets.map((b) => b.label), stacked: true, xTitle: score.type === 'weekly' ? 'Day' : 'Week starting', yTitle: 'Volume (kg)',
        legend: true,
        datasets: groups.map((g) => ({ label: g, data: byGroup[g].map(Math.round), color: MUSCLE_COLOR[g] }))
      }
    }
  };
}

function weeklyVolumeTrend(bundle, score, w, h) {
  const win = trendWindow(score);
  const buckets = chunks(win.start, win.end, 7);
  const vol = buckets.map((b) => Math.round(sum(bundle.history.workouts.filter((x) => x.completed && within(x, b.start, b.end)).map((x) => x.volumeKg || 0))));
  if (!vol.some((v) => v > 0)) {
    return { title: score.type === 'monthly' ? 'Weekly volume — 3-month trend' : 'Weekly volume trend', empty: true, emptyText: 'No lifting volume logged in this window — logging is the fastest way to raise your score', caption: '' };
  }
  const m = score.pillars.workout.metrics;
  const cap = m.volumeDeltaPct != null
    ? `Volume ${m.volumeDeltaPct >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(m.volumeDeltaPct))}% on the previous ${score.type === 'monthly' ? 'month' : 'week'}.`
    : 'Total lifting volume per week (kg × reps).';
  return {
    title: score.type === 'monthly' ? 'Weekly volume — 3-month trend' : 'Weekly volume trend',
    caption: cap,
    empty: false,
    spec: {
      id: 'workout-volume', kind: 'lines', w, h,
      data: {
        labels: buckets.map((b) => b.label), xTitle: 'Week starting', yTitle: 'Volume (kg)',
        datasets: [{ label: 'Volume', data: vol, color: PAL.gold, fill: true, points: 'all' }]
      }
    }
  };
}

function caloriesLine(bundle, score, w, h) {
  const days = S.datesInRange(score.period.start, score.period.end);
  const mealMap = new Map((bundle.history.meals || []).filter((m) => within(m, score.period.start, score.period.end)).map((m) => [m.date, m]));
  const cal = days.map((d) => { const m = mealMap.get(d); return m && m.calories > 0 ? m.calories : null; });
  const nm = score.pillars.nutrition.metrics;
  if (!cal.some((v) => v != null)) {
    return { title: 'Daily calories vs target', empty: true, emptyText: 'No meals logged this period — logging is the fastest way to raise your score', caption: '' };
  }
  const target = nm.calorieTarget;
  const prevAvg = score.detail.previousPillars && score.detail.previousPillars.nutrition.metrics.avgCalories;
  const refs = [];
  if (target) refs.push({ label: `Target ${target.toLocaleString('en-IN')} kcal (±10% band)`, data: days.map(() => target), color: PAL.green, ref: true });
  if (prevAvg) refs.push({ label: `Last ${score.type === 'monthly' ? 'month' : 'week'} avg ${prevAvg.toLocaleString('en-IN')}`, data: days.map(() => prevAvg), color: PAL.grey, ref: true });
  const present = cal.filter((v) => v != null);
  const maxV = Math.max(...present, target || 0, prevAvg || 0);
  const minV = Math.min(...present, target ? target * 0.9 : Infinity, prevAvg || Infinity);
  return {
    title: 'Daily calories vs target',
    caption: target
      ? `Within ±10% of the ${target.toLocaleString('en-IN')} kcal target on ${nm.calorieHitDays} of ${score.period.days} days.`
      : `Averaged ${nm.avgCalories == null ? '—' : nm.avgCalories.toLocaleString('en-IN')} kcal on logged days — no calorie target set yet.`,
    empty: false,
    spec: {
      id: 'nutrition-calories', kind: 'lines', w, h,
      data: {
        labels: days.map(score.type === 'weekly' ? dayLabel : (d) => String(dparts(d).d)),
        xTitle: score.type === 'weekly' ? 'Day' : 'Day of month', yTitle: 'kcal',
        yBeginAtZero: false,
        ySuggestedMin: Math.max(0, Math.floor((minV * 0.85) / 250) * 250),
        ySuggestedMax: Math.ceil((maxV * 1.1) / 250) * 250,
        bands: target ? [{ low: target * 0.9, high: target * 1.1, color: PAL.green, alpha: 0.10 }] : [],
        datasets: [{ label: 'Calories logged', data: cal, color: PAL.gold, points: 'all', spanGaps: false }].concat(refs),
        legend: true
      }
    }
  };
}

function macroBars(bundle, score, w, h) {
  const buckets = periodBuckets(score);
  const meals = (bundle.history.meals || []).filter((m) => within(m, score.period.start, score.period.end) && (m.meals > 0));
  const avgFor = (b, f) => {
    const rows = meals.filter((m) => within(m, b.start, b.end));
    return rows.length ? mean(rows.map((m) => m[f] || 0)) : 0;
  };
  const carbs = buckets.map((b) => Math.round(avgFor(b, 'carbs') * 4));
  const protein = buckets.map((b) => Math.round(avgFor(b, 'protein') * 4));
  const fat = buckets.map((b) => Math.round(avgFor(b, 'fat') * 9));
  if (!carbs.concat(protein, fat).some((v) => v > 0)) {
    return { title: 'Macro split (kcal)', empty: true, emptyText: 'No macros logged this period — snap each meal to see your protein, carbs and fat', caption: '' };
  }
  const target = score.pillars.nutrition.metrics.calorieTarget;
  const totP = sum(protein); const tot = sum(carbs) + totP + sum(fat);
  return {
    title: score.type === 'weekly' ? 'Macro split by day (kcal)' : 'Average daily macro split by week (kcal)',
    caption: `Protein supplied ${tot ? Math.round((totP / tot) * 100) : 0}% of logged calories${target ? `; line marks the ${target.toLocaleString('en-IN')} kcal target` : ''}.`,
    empty: false,
    spec: {
      id: 'nutrition-macros', kind: 'bars', w, h,
      data: {
        labels: buckets.map((b) => b.label), stacked: true, legend: true,
        xTitle: score.type === 'weekly' ? 'Day' : 'Week starting', yTitle: 'kcal',
        ySuggestedMax: target ? Math.ceil((target * 1.2) / 500) * 500 : undefined,
        datasets: [
          { label: 'Carbs', data: carbs, color: PAL.gold },
          { label: 'Protein', data: protein, color: PAL.blue },
          { label: 'Fat', data: fat, color: PAL.aqua }
        ].concat(target ? [{ type: 'line', label: 'Target', data: buckets.map(() => target), color: PAL.green }] : [])
      }
    }
  };
}

function adherenceDonut(score, w, h) {
  const m = score.pillars.nutrition.metrics;
  const logged = Math.min(m.mealsLogged, m.mealsExpected);
  if (!m.hasData) {
    return { title: 'Meal logging adherence', empty: true, emptyText: 'No meals logged this period — logging is the fastest way to raise your score', caption: '' };
  }
  return {
    title: 'Meal logging adherence',
    caption: `${m.mealsLogged} of ${m.mealsExpected} expected meals logged (3 a day).`,
    empty: false,
    center: { value: `${m.adherencePct}%`, label: 'logged' },
    spec: {
      id: 'nutrition-adherence', kind: 'donut', w, h,
      data: { parts: [{ label: `Logged ${logged}`, value: logged, color: PAL.gold }, { label: `Missed ${Math.max(0, m.mealsExpected - logged)}`, value: Math.max(0, m.mealsExpected - logged), color: PAL.track }] }
    }
  };
}

/** Calendar heatmap cells (HTML/CSS grid, not a chart). */
function heatmapCells(bundle, score) {
  const days = score.detail.days || [];
  return days.map((d) => {
    const level = (d.checkedIn ? 1 : 0) + (d.meals > 0 ? 1 : 0) + ((d.workout || d.yoga) ? 1 : 0) + (d.perfect ? 1 : 0);
    const p = dparts(d.date);
    return { date: d.date, dow: p.w, day: p.d, level, perfect: d.perfect, freeze: d.freeze };
  });
}

function sleepPanels(bundle, score, w, hEach) {
  const days = S.datesInRange(score.period.start, score.period.end);
  const m = dailyCheckins(bundle, score.period.start, score.period.end);
  const sleep = days.map((d) => (m.get(d) && m.get(d).sleepH != null ? m.get(d).sleepH : null));
  const energy = days.map((d) => (m.get(d) && m.get(d).energy != null ? m.get(d).energy : null));
  const recMap = new Map((bundle.history.recovery || []).map((r) => [r.date, r.value]));
  const recovery = days.map((d) => (recMap.has(d) ? recMap.get(d) : null));
  const labels = days.map(score.type === 'weekly' ? dayLabel : (d) => String(dparts(d).d));
  const xTitle = score.type === 'weekly' ? 'Day' : 'Day of month';
  // Small multiples share the x axis: only the lower panel carries its title.
  const sl = sleep.filter((v) => v != null);
  const sMin = sl.length ? Math.min(4, Math.floor(Math.min(...sl))) : 4;
  const sMax = sl.length ? Math.max(9, Math.ceil(Math.max(...sl))) : 9;
  const out = { title: 'Sleep vs energy', panels: [] };
  const cm = score.pillars.checkin.metrics;
  if (sleep.some((v) => v != null)) {
    out.panels.push({
      label: 'Sleep (hours) — green line = 7 h target', empty: false,
      spec: { id: 'checkin-sleep', kind: 'lines', w, h: hEach, data: { labels, xTitle: '', yTitle: 'Hours', yBeginAtZero: false, yMin: sMin, yMax: sMax, yTicks: 4, endLabels: false, refLines: [{ value: 7, color: PAL.green }], datasets: [{ label: 'Sleep', data: sleep, color: PAL.gold, points: score.type === 'weekly' ? 'all' : undefined }], legend: false } }
    });
  } else out.panels.push({ label: 'Sleep (hours)', empty: true, emptyText: 'No sleep logged this period' });
  const useRecovery = !energy.some((v) => v != null) && recovery.some((v) => v != null);
  if (energy.some((v) => v != null)) {
    out.panels.push({
      label: 'Energy (Low 3 · Medium 6 · High 9)', empty: false,
      spec: { id: 'checkin-energy', kind: 'lines', w, h: hEach, data: { labels, xTitle, yTitle: 'Energy', yMin: 0, yMax: 10, yTicks: 3, endLabels: false, datasets: [{ label: 'Energy', data: energy, color: PAL.blue, points: 'all' }], legend: false } }
    });
  } else if (useRecovery) {
    out.title = 'Sleep vs recovery';
    out.panels.push({
      label: 'Wearable recovery (%)', empty: false,
      spec: { id: 'checkin-energy', kind: 'lines', w, h: hEach, data: { labels, xTitle, yTitle: 'Recovery %', yMin: 0, yMax: 100, yTicks: 3, endLabels: false, datasets: [{ label: 'Recovery', data: recovery, color: PAL.blue, points: score.type === 'weekly' ? 'all' : undefined }], legend: false } }
    });
  } else out.panels.push({ label: 'Energy', empty: true, emptyText: 'No energy ratings logged — rate your energy when you log a workout' });
  out.caption = cm.avgSleepH != null
    ? `Average sleep ${cm.avgSleepH} h; 7 h+ on ${cm.sleepOkDays} of ${score.period.days} nights.`
    : 'Sleep is not being logged yet.';
  out.empty = out.panels.every((p) => p.empty);
  out.emptyText = 'No sleep or energy logged this period — logging is the fastest way to raise your score';
  return out;
}

function stepsBar(bundle, score, w, h) {
  const days = S.datesInRange(score.period.start, score.period.end);
  const m = dailyCheckins(bundle, score.period.start, score.period.end);
  const steps = days.map((d) => (m.get(d) && m.get(d).steps != null ? Math.round(m.get(d).steps) : null));
  const cm = score.pillars.checkin.metrics;
  if (!steps.some((v) => v != null)) {
    return { title: 'Daily steps', empty: true, emptyText: 'No steps logged this period — logging is the fastest way to raise your score', caption: '' };
  }
  const target = cm.stepsTarget;
  return {
    title: 'Daily steps',
    caption: `Target of ${target.toLocaleString('en-IN')} met on ${cm.stepsOkDays} of ${score.period.days} days; average ${cm.avgSteps == null ? '—' : cm.avgSteps.toLocaleString('en-IN')}.`,
    empty: false,
    spec: {
      id: 'checkin-steps', kind: 'bars', w, h,
      data: {
        labels: days.map(score.type === 'weekly' ? dayLabel : (d) => String(dparts(d).d)),
        xTitle: score.type === 'weekly' ? 'Day' : 'Day of month', yTitle: 'Steps',
        ySuggestedMax: Math.ceil(Math.max(target * 1.2, ...steps.filter((v) => v != null)) / 2000) * 2000,
        datasets: [
          { label: 'Steps', data: steps.map((v) => (v == null ? 0 : v)), color: PAL.gold },
          { type: 'line', label: `Target ${target.toLocaleString('en-IN')}`, data: days.map(() => target), color: PAL.green }
        ],
        legend: true, barMax: score.type === 'weekly' ? 22 : 9
      }
    }
  };
}

function yogaMinutes(bundle, score, w, h) {
  const sessions = (bundle.history.yoga || []).filter((y) => within(y, score.period.start, score.period.end))
    .sort((a, b) => S.dayNum(a.date) - S.dayNum(b.date));
  const ym = score.pillars.yoga.metrics;
  if (!sessions.length) {
    return { title: 'Minutes per yoga session', empty: true, emptyText: 'No yoga sessions logged this period — logging is the fastest way to raise your score', caption: '' };
  }
  const shown = sessions.slice(-16);
  const styles = {};
  for (const s of sessions) styles[s.style || 'Yoga'] = (styles[s.style || 'Yoga'] || 0) + 1;
  const topStyle = Object.keys(styles).sort((a, b) => styles[b] - styles[a])[0];
  return {
    title: 'Minutes per yoga session',
    caption: `${ym.sessions} ${ym.sessions === 1 ? 'session' : 'sessions'}, ${ym.minutes} minutes in total; most practised: ${String(topStyle).slice(0, 40)}.`,
    empty: false,
    spec: {
      id: 'yoga-minutes', kind: 'bars', w, h,
      data: {
        labels: shown.map((s) => (score.type === 'weekly' ? dayLabel(s.date) : shortDate(s.date))), xTitle: 'Session', yTitle: 'Minutes', yDecimals: 0,
        datasets: [{ label: 'Minutes', data: shown.map((s) => s.durationMin || 0), color: PAL.gold }],
        legend: false, valueLabels: shown.length <= 10, barMax: 16
      }
    }
  };
}

function mobilityLine(bundle, score, w, h) {
  const win = trendWindow(score);
  const buckets = chunks(win.start, win.end, 7);
  const vals = buckets.map((b) => {
    const v = (bundle.history.yoga || []).filter((y) => within(y, b.start, b.end) && y.mobilityScore != null).map((y) => y.mobilityScore);
    return v.length ? r1(mean(v)) : null;
  });
  if (!vals.some((v) => v != null)) {
    return { title: 'Mobility score', empty: true, emptyText: 'No mobility scores logged this period — logging is the fastest way to raise your score', caption: '' };
  }
  const ym = score.pillars.yoga.metrics;
  return {
    title: score.type === 'monthly' ? 'Mobility score — 3-month trend' : 'Mobility score trend',
    caption: ym.avgMobility != null ? `Average mobility ${ym.avgMobility}${ym.mobilityDeltaPct != null ? ` (${ym.mobilityDeltaPct >= 0 ? '+' : ''}${Math.round(ym.mobilityDeltaPct)}% on last period)` : ''}.` : 'No mobility score in this period.',
    empty: false,
    spec: { id: 'yoga-mobility', kind: 'lines', w, h, data: { labels: buckets.map((b) => b.label), xTitle: 'Week starting', yTitle: 'Score', yBeginAtZero: false, datasets: [{ label: 'Mobility', data: vals, color: PAL.gold, points: 'all' }], legend: false } }
  };
}

function sleepTrend(bundle, score, w, h) {
  const win = trendWindow(score);
  const buckets = chunks(win.start, win.end, 7);
  const m = dailyCheckins(bundle, win.start, win.end);
  const vals = buckets.map((b) => {
    const v = S.datesInRange(b.start, b.end).map((d) => m.get(d) && m.get(d).sleepH).filter((x) => x != null);
    return v.length ? r1(mean(v)) : null;
  });
  if (!vals.some((v) => v != null)) {
    return { title: 'Recovery: weekly sleep', empty: true, emptyText: 'No sleep logged in this window — logging is the fastest way to raise your score', caption: '' };
  }
  return {
    title: 'Recovery: average sleep per week',
    caption: 'Three-month view of nightly sleep; the line marks the 7-hour target.',
    empty: false,
    spec: { id: 'yoga-sleeptrend', kind: 'lines', w, h, data: { labels: buckets.map((b) => b.label), xTitle: 'Week starting', yTitle: 'Hours', yBeginAtZero: false, ySuggestedMin: 5, ySuggestedMax: 9, valueDecimals: 1, datasets: [{ label: 'Average sleep', data: vals, color: PAL.blue, points: 'all' }, { label: '7 h target', data: buckets.map(() => 7), color: PAL.green, ref: true }], legend: true } }
  };
}

function weightLine(bundle, score, w, h) {
  const win = trendWindow(score);
  const days = S.datesInRange(win.start, win.end);
  const wmap = new Map((bundle.history.weights || []).filter((x) => within(x, win.start, win.end)).map((x) => [x.date, x.weightKg]));
  if (!wmap.size) {
    return { title: 'Weight trend', empty: true, emptyText: 'No weigh-ins logged this period — logging is the fastest way to raise your score', caption: '' };
  }
  const raw = days.map((d) => (wmap.has(d) ? wmap.get(d) : null));
  const ma = days.map((d, i) => {
    const vals = [];
    for (let k = Math.max(0, i - 6); k <= i; k += 1) if (raw[k] != null) vals.push(raw[k]);
    return vals.length ? r1(mean(vals)) : null;
  });
  const goal = bundle.goal && bundle.goal.targetWeightKg;
  const b = score.pillars.health.metrics.body;
  const vals = raw.filter((v) => v != null).concat(goal ? [goal] : []);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  return {
    title: score.type === 'monthly' ? 'Weight — 3-month trend' : 'Weight trend (6 weeks)',
    caption: b
      ? `${b.startKg} → ${b.endKg} kg this ${score.type === 'monthly' ? 'month' : 'week'} (${b.changeKg > 0 ? '+' : ''}${b.changeKg} kg)${goal ? `; goal ${goal} kg` : ''}.`
      : `Daily weigh-ins with a 7-day average${goal ? `; goal ${goal} kg` : ''}.`,
    empty: false,
    spec: {
      id: 'body-weight', kind: 'lines', w, h,
      data: {
        labels: days.map(shortDate), xTitle: 'Date', yTitle: 'kg', yBeginAtZero: false, xTicks: 8,
        ySuggestedMin: Math.floor(lo - 1), ySuggestedMax: Math.ceil(hi + 1), valueDecimals: 1,
        legend: true,
        datasets: [
          { label: 'Weigh-in', data: raw, color: PAL.grey, points: 'all', showLine: false, noEndLabel: true },
          { label: '7-day average', data: ma, color: PAL.gold }
        ].concat(goal ? [{ label: `Goal ${goal} kg`, data: days.map(() => goal), color: PAL.green, ref: true }] : [])
      }
    }
  };
}

function measurementDeltas(bundle, score, w, h) {
  const rows = (bundle.history.measurements || []).slice().sort((a, b) => S.dayNum(a.date) - S.dayNum(b.date));
  const inP = rows.filter((r) => within(r, score.period.start, score.period.end));
  const before = rows.filter((r) => S.dayNum(r.date) < S.dayNum(score.period.start));
  const F = [['waistCm', 'Waist'], ['chestCm', 'Chest'], ['hipsCm', 'Hips'], ['armsCm', 'Arms'], ['thighsCm', 'Thighs']];
  const labels = []; const data = []; const colors = [];
  const dir = (bundle.goal && bundle.goal.direction) || 'maintain';
  for (const [f, label] of F) {
    const last = inP.filter((r) => r[f] != null).pop();
    const base = before.filter((r) => r[f] != null).pop() || inP.find((r) => r[f] != null);
    if (!last || !base || last === base) continue;
    const d = r1(last[f] - base[f]);
    labels.push(label); data.push(d);
    const goodDown = f === 'waistCm' || f === 'hipsCm' || dir === 'lose';
    const good = d === 0 ? null : (goodDown ? d < 0 : d > 0);
    colors.push(good == null ? PAL.grey : (good ? PAL.green : PAL.amber));
  }
  if (!labels.length) {
    return { title: 'Measurement changes', empty: true, emptyText: 'No repeat measurements this period — log your waist in Body Snapshots to track change', caption: '' };
  }
  const span = Math.max(1, ...data.map((v) => Math.abs(v)));
  return {
    title: 'Measurement changes (cm)',
    caption: 'Latest vs previous measurement; green = toward your goal, amber = away.',
    empty: false,
    spec: {
      id: 'body-measure', kind: 'hbars', w, h,
      data: { labels, xTitle: 'Change (cm)', xMin: -Math.ceil(span * 1.4), xMax: Math.ceil(span * 1.4), valueSuffix: ' cm', legend: false, datasets: [{ label: 'Change', data, colors }] }
    }
  };
}

function markerCharts(blood, w, h) {
  return (blood.keyMarkers || []).map((m, i) => {
    const pts = m.series || [];
    const vals = pts.map((p) => p.value);
    // Show the readings plus the range bound(s) that matter to them — a far-away
    // bound (vitamin D's 100 when readings sit near 20) would flatten the line.
    const dMin = Math.min(...vals); const dMax = Math.max(...vals);
    const span = Math.max(dMax - dMin, Math.abs(dMax) * 0.1, 0.5);
    let lo = dMin; let hi = dMax;
    if (m.low != null && (dMin < m.low || m.low >= dMin - span * 2)) lo = Math.min(lo, m.low);
    if (m.high != null && (dMax > m.high || m.high <= dMax + span * 2)) hi = Math.max(hi, m.high);
    const pad = Math.max((hi - lo) * 0.18, 0.2);
    const yMin = dMin >= 0 ? Math.max(0, lo - pad) : lo - pad;
    const yMax = hi + pad;
    const dec = yMax - yMin < 3 ? 1 : 0;
    return {
      title: m.name,
      caption: `${vals[vals.length - 1]}${m.unit ? ' ' + m.unit : ''}${m.low != null || m.high != null ? ` · range ${m.low != null ? m.low : '<'}${m.low != null && m.high != null ? '–' : ''}${m.high != null ? m.high : '+'}` : ''}`,
      flagged: m.inRange === false,
      spec: {
        id: 'blood-marker-' + i, kind: 'lines', w, h,
        data: {
          labels: pts.map((p) => monthYear(p.date)), yTitle: m.unit || '', yBeginAtZero: false, yTicks: 4, xTicks: 6,
          yMin: Math.round(yMin * 10) / 10, yMax: Math.round(yMax * 10) / 10, yDecimals: dec,
          bands: (m.low != null || m.high != null) ? [{ low: m.low, high: m.high, color: PAL.green, alpha: 0.12 }] : [],
          datasets: [{ label: m.name, data: vals, color: m.inRange === false ? PAL.red : PAL.gold, points: 'all' }],
          legend: false
        }
      }
    };
  });
}

module.exports = {
  PAL, MUSCLE_COLOR, MM, px, gradeColor, dayLabel, shortDate, monthYear, chunks, trendWindow,
  gaugeSpec, plannedVsCompleted, volumeByMuscle, weeklyVolumeTrend, caloriesLine, macroBars, adherenceDonut,
  heatmapCells, sleepPanels, stepsBar, yogaMinutes, mobilityLine, sleepTrend, weightLine, measurementDeltas, markerCharts
};
