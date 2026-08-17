'use strict';

/**
 * BodyBank — the Signal engine ("the Why engine").
 *
 * WHY THIS EXISTS
 * ---------------
 * Whoop already shows a member their recovery, HRV, sleep stages and strain. Rendering
 * those same figures inside BodyBank adds nothing — it is a second, worse Whoop app.
 *
 * What BodyBank alone holds is the OTHER half of the causal picture: what the member
 * actually ate (nutrition_daily_stats / nutrition_meal_logs), drank and walked
 * (daily_checkins), how they trained (workout_logs, wearable_workouts), what they said
 * about their week (sunday_checkins), what their blood says (blood_analysis_reports),
 * and a human coach in the loop. Whoop owns the OUTPUTS; BodyBank owns the INPUTS.
 *
 * So this engine does not present physiology. It computes, per member, from that
 * member's own history:
 *
 *   1. a DIRECTIVE for today   — push / build / hold / restore, with the facts that forced it
 *   2. LAWS                    — statistically guarded input(day D) -> physiology(day D+1)
 *                                relationships discovered in this member's own data
 *   3. LEVERS                  — the single highest-value action available today
 *   4. FLAGS                   — staff-only risk detectors (overreaching, under-fuelling,
 *                                illness signature, chronic sleep debt, thin data)
 *
 * DESIGN RULES (the same ones the rest of services/wearables/* follows)
 * --------------------------------------------------------------------
 *  - Deterministic. No model is called from here and none ever should be: every sentence
 *    is a template filled with an arithmetic result, so it cannot hallucinate and costs
 *    nothing to render on a home screen.
 *  - A number nobody measured stays null. Never a zero, never an interpolation.
 *  - Nothing is claimed without the evidence to back it: every finding carries its n,
 *    effect size, raw p and BH-adjusted q, and a tier derived from those. Findings below
 *    the member tier are not hidden failures — they are returned, flagged, for staff.
 *  - Association is never printed as causation. The statements say "on days you X, your
 *    next morning Y ran Z better", which is exactly and only what was measured.
 *  - Pure: no DB, no I/O, no clock. `today` is passed in (the caller resolves the
 *    member's timezone) so this file is deterministic and unit-testable.
 *
 * MULTIPLICITY
 * ------------
 * ~16 inputs x 6 outputs is ~96 hypotheses per member. At p<=0.05 that is ~5 false
 * "laws" per member by chance alone, which would be worse than showing nothing. Every
 * p-value goes through Benjamini-Hochberg across the whole tested set for that member,
 * and only q-controlled findings are ever allowed in front of a member.
 */

/* ────────────────────────────── numeric helpers ────────────────────────────── */

/** Finite number or null. Strings are coerced; '' and null stay null. */
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function round(n, dp) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, dp || 0);
  return Math.round(n * f) / f;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** The finite values of an array, in order. */
function finite(arr) {
  const out = [];
  (arr || []).forEach((v) => { const n = num(v); if (n != null) out.push(n); });
  return out;
}

function mean(arr) {
  const v = finite(arr);
  if (!v.length) return null;
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i];
  return s / v.length;
}

function median(arr) {
  const v = finite(arr).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Sample standard deviation (n-1). Null below two values. */
function stdev(arr) {
  const v = finite(arr);
  if (v.length < 2) return null;
  const m = mean(v);
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += (v[i] - m) * (v[i] - m);
  return Math.sqrt(s / (v.length - 1));
}

/** Percentage change of `v` against `base`. Null when base is absent or zero. */
function pctChange(v, base) {
  if (v == null || base == null || base === 0) return null;
  return ((v - base) / Math.abs(base)) * 100;
}

/* ────────────────────────── statistics (p-values) ─────────────────────────── */

/**
 * Lanczos log-gamma. Feeds the incomplete beta below, which is what turns a t
 * statistic into an honest p — the alternative (a hard-coded significance table)
 * silently mis-states every finding whose n falls between the table's rows.
 */
function logGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Continued-fraction expansion for the incomplete beta (Numerical Recipes §6.4). */
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a,b). */
function betai(a, b, x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p for a Student t statistic. Returns 1 when df is unusable. */
function tTestP(t, df) {
  if (t == null || df == null || !Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  return clamp(betai(df / 2, 0.5, df / (df + t * t)), 0, 1);
}

/** Ranks with ties averaged — the basis of Spearman. */
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Spearman rank correlation. Rank-based deliberately: a member's protein intake and
 * a single 20km hike are both wildly non-normal, and Pearson on the raw values would
 * let one outlier day manufacture a "law".
 * @returns {{rho:number, n:number, p:number}|null}
 */
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 4 || ys.length !== n) return null;
  const rho = pearson(ranks(xs), ranks(ys));
  if (rho == null || !Number.isFinite(rho)) return null;
  const r = clamp(rho, -0.999999, 0.999999);
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return { rho: r, n, p: tTestP(t, n - 2) };
}

/**
 * Welch's unequal-variance t test. Used for yes/no inputs (alcohol, a logged workout,
 * a mind session) where the question is "were these two groups of mornings different".
 * @returns {{meanA:number, meanB:number, diff:number, d:number, n:number, nA:number, nB:number, p:number}|null}
 */
function welch(a, b) {
  const A = finite(a);
  const B = finite(b);
  if (A.length < 3 || B.length < 3) return null;
  const mA = mean(A);
  const mB = mean(B);
  const sA = stdev(A);
  const sB = stdev(B);
  if (sA == null || sB == null) return null;
  const vA = (sA * sA) / A.length;
  const vB = (sB * sB) / B.length;
  const se = Math.sqrt(vA + vB);
  if (!(se > 0)) return null;
  const t = (mA - mB) / se;
  const dfNum = (vA + vB) * (vA + vB);
  const dfDen = (vA * vA) / (A.length - 1) + (vB * vB) / (B.length - 1);
  const df = dfDen > 0 ? dfNum / dfDen : null;
  // Pooled SD for Cohen's d, so the effect size is comparable across outputs whose
  // units are nothing alike (recovery points vs ms vs bpm).
  const pooled = Math.sqrt(
    (((A.length - 1) * sA * sA) + ((B.length - 1) * sB * sB)) / (A.length + B.length - 2)
  );
  return {
    meanA: mA,
    meanB: mB,
    diff: mA - mB,
    d: pooled > 0 ? (mA - mB) / pooled : 0,
    n: A.length + B.length,
    nA: A.length,
    nB: B.length,
    p: tTestP(t, df)
  };
}

/**
 * Benjamini-Hochberg. Mutates nothing; returns q per input index.
 * Without this a member with 96 tested hypotheses is handed ~5 laws that are pure noise.
 */
function benjaminiHochberg(pvals) {
  const m = pvals.length;
  const q = new Array(m).fill(1);
  if (!m) return q;
  const order = pvals.map((p, i) => [p == null ? 1 : p, i]).sort((a, b) => a[0] - b[0]);
  let prev = 1;
  for (let k = m - 1; k >= 0; k -= 1) {
    const [p, i] = order[k];
    const val = Math.min(prev, (p * m) / (k + 1));
    q[i] = clamp(val, 0, 1);
    prev = q[i];
  }
  return q;
}

/* ─────────────────────────── metric vocabulary ─────────────────────────── */

/**
 * The physiological OUTPUTS we test against. These belong to Whoop, so `memberAbsolute`
 * is false for every one that the Whoop app already displays as a headline number —
 * the member is shown how the figure MOVED with their own behaviour, never the reading
 * itself. That is the whole difference between this product and a Whoop mirror.
 */
const OUTPUTS = [
  { key: 'score', label: 'recovery', short: 'Recovery', unit: '', dp: 0, higherIsBetter: true, memberAbsolute: false, memberDelta: 'points' },
  { key: 'hrvMs', label: 'HRV', short: 'HRV', unit: 'ms', dp: 0, higherIsBetter: true, memberAbsolute: false, memberDelta: 'percent' },
  { key: 'restingHr', label: 'resting heart rate', short: 'Resting HR', unit: 'bpm', dp: 0, higherIsBetter: false, memberAbsolute: false, memberDelta: 'percent' },
  { key: 'sleepEfficiencyPct', label: 'sleep efficiency', short: 'Sleep eff.', unit: '%', dp: 0, higherIsBetter: true, memberAbsolute: false, memberDelta: 'points' },
  { key: 'sleepHours', label: 'sleep', short: 'Sleep', unit: 'h', dp: 1, higherIsBetter: true, memberAbsolute: true, memberDelta: 'absolute' },
  { key: 'respiratoryRate', label: 'respiratory rate', short: 'Resp. rate', unit: 'rpm', dp: 1, higherIsBetter: false, memberAbsolute: false, memberDelta: 'percent' }
];

const OUTPUT_BY_KEY = {};
OUTPUTS.forEach((o) => { OUTPUT_BY_KEY[o.key] = o; });

/**
 * The controllable INPUTS. Every one of these is something the member decides, which is
 * what makes a finding actionable — correlating two Whoop metrics with each other would
 * be interesting and useless.
 *
 * `highPhrase` completes "On days you ___". `unit`/`dp` format the threshold.
 */
const INPUTS = [
  { key: 'proteinG', label: 'protein', unit: 'g', dp: 0, kind: 'continuous', highPhrase: 'hit {v}g of protein or more', lowPhrase: 'stayed under {v}g of protein', lever: 'protein' },
  // {v} for these four is rendered by fmtThreshold, which supplies its own unit — so the
  // template must NOT repeat it or the sentence reads "2.4Lml".
  { key: 'calories', label: 'calories', unit: 'kcal', dp: 0, kind: 'continuous', highPhrase: 'ate {v} or more', lowPhrase: 'ate under {v}', lever: 'calories' },
  { key: 'carbsG', label: 'carbs', unit: 'g', dp: 0, kind: 'continuous', highPhrase: 'ate {v}g of carbs or more', lowPhrase: 'stayed under {v}g of carbs', lever: 'carbs' },
  { key: 'fatG', label: 'fat', unit: 'g', dp: 0, kind: 'continuous', highPhrase: 'ate {v}g of fat or more', lowPhrase: 'stayed under {v}g of fat', lever: null },
  { key: 'fiberG', label: 'fibre', unit: 'g', dp: 0, kind: 'continuous', highPhrase: 'got {v}g of fibre or more', lowPhrase: 'got under {v}g of fibre', lever: 'fibre' },
  { key: 'mealQuality', label: 'meal quality', unit: '', dp: 0, kind: 'continuous', highPhrase: 'your meals scored {v} or better', lowPhrase: 'your meals scored under {v}', lever: 'mealQuality' },
  { key: 'energyBalance', label: 'energy balance', unit: 'kcal', dp: 0, kind: 'continuous', highPhrase: 'you ate at or above {v} of balance', lowPhrase: 'you ran a deficit past {v}', lever: 'fuel' },
  { key: 'waterMl', label: 'water', unit: 'ml', dp: 0, kind: 'continuous', highPhrase: 'drank {v} of water or more', lowPhrase: 'drank under {v} of water', lever: 'water' },
  { key: 'steps', label: 'steps', unit: '', dp: 0, kind: 'continuous', highPhrase: 'walked {v} steps or more', lowPhrase: 'walked under {v} steps', lever: 'steps' },
  { key: 'strain', label: 'training strain', unit: '', dp: 1, kind: 'continuous', highPhrase: 'trained above a strain of {v}', lowPhrase: 'kept strain under {v}', lever: 'strain' },
  { key: 'workoutMin', label: 'training minutes', unit: 'min', dp: 0, kind: 'continuous', highPhrase: 'trained {v} minutes or more', lowPhrase: 'trained under {v} minutes', lever: null },
  // Sleep-timing consistency is a BEHAVIOUR — the member chooses when to go to bed —
  // even though Whoop is what measures it. Whoop's own export carries no bedtime clock
  // time, so this is the only honest handle we have on sleep regularity.
  { key: 'sleepConsistencyPct', label: 'sleep-timing consistency', unit: '%', dp: 0, kind: 'continuous', highPhrase: 'kept your sleep timing {v}% consistent or better', lowPhrase: 'let your sleep timing drift under {v}%', lever: 'bedtime' },
  { key: 'napMin', label: 'napping', unit: 'min', dp: 0, kind: 'continuous', highPhrase: 'napped {v} minutes or more', lowPhrase: 'napped under {v} minutes', lever: 'nap' },
  { key: 'loggedWorkout', label: 'a logged BodyBank workout', unit: '', dp: 0, kind: 'binary', highPhrase: 'logged a BodyBank workout', lowPhrase: 'logged no workout', lever: null },
  { key: 'mindSession', label: 'a mind session', unit: '', dp: 0, kind: 'binary', highPhrase: 'did a mind session', lowPhrase: 'skipped your mind session', lever: 'mind' }
  // Deliberately NOT tested: "completed your daily check-in". Logging a check-in cannot
  // move HRV; any association would be pure confounding (engaged weeks are also good
  // weeks) and would read to a member as causation.
];

const INPUT_BY_KEY = {};
INPUTS.forEach((i) => { INPUT_BY_KEY[i.key] = i; });

/**
 * A threshold as a human would write it. The median split lands on values like 2403ml
 * and 9184 steps; printing those verbatim makes a considered finding read like a
 * spreadsheet dump, and "clear 2403ml of water" is not an instruction anyone follows.
 */
function fmtThreshold(inputKey, value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return String(value);
  const v = Number(value);
  if (inputKey === 'waterMl') {
    return v >= 1000 ? `${round(v / 1000, 1)}L` : `${Math.round(v)}ml`;
  }
  if (inputKey === 'steps') return Math.round(v).toLocaleString('en-US');
  if (inputKey === 'calories') return `${Math.round(v).toLocaleString('en-US')} kcal`;
  if (inputKey === 'energyBalance') return `${Math.round(v).toLocaleString('en-US')} kcal`;
  const meta = INPUT_BY_KEY[inputKey];
  const dp = meta ? meta.dp : 0;
  const u = unit != null ? unit : (meta ? meta.unit : '');
  return `${round(v, dp)}${u || ''}`;
}

/**
 * Whoop journal questions become binary inputs too — they are the only place a member
 * records alcohol, illness, caffeine or a late meal, and those are the highest-signal
 * behaviours in the whole dataset. The question text drifts between Whoop app versions,
 * so match on substrings and fall back to the member's own wording.
 */
const JOURNAL_PHRASES = [
  { test: /alcohol|drink/i, phrase: 'had alcohol', anti: 'stayed off alcohol', lever: 'alcohol' },
  { test: /caffeine|coffee/i, phrase: 'had caffeine', anti: 'skipped caffeine', lever: 'caffeine' },
  { test: /close to bed|before bed.*(eat|meal|food)|late meal|eat.*bedtime/i, phrase: 'ate close to bedtime', anti: 'finished eating early', lever: 'lateMeal' },
  { test: /sick|ill\b|unwell/i, phrase: 'felt unwell', anti: 'felt well', lever: null },
  { test: /screen|device|phone|tv\b/i, phrase: 'used a screen in bed', anti: 'kept screens out of bed', lever: 'screens' },
  { test: /stretch|mobility|yoga/i, phrase: 'stretched', anti: 'skipped stretching', lever: 'stretch' },
  { test: /meditat|breathwork|mindful/i, phrase: 'meditated', anti: 'skipped meditation', lever: 'mind' },
  { test: /magnesium/i, phrase: 'took magnesium', anti: 'skipped magnesium', lever: 'magnesium' },
  { test: /read/i, phrase: 'read before bed', anti: 'did not read before bed', lever: 'read' },
  { test: /shared? (a )?bed|partner/i, phrase: 'shared a bed', anti: 'slept alone', lever: null },
  { test: /travel|flight|time ?zone/i, phrase: 'travelled', anti: 'stayed home', lever: null },
  { test: /stress/i, phrase: 'had a stressful day', anti: 'had a calm day', lever: 'stress' },
  { test: /sauna|heat/i, phrase: 'used a sauna', anti: 'skipped the sauna', lever: 'sauna' },
  { test: /cold|ice bath|plunge/i, phrase: 'did cold exposure', anti: 'skipped cold exposure', lever: 'cold' },
  { test: /nap/i, phrase: 'napped', anti: 'did not nap', lever: 'nap' },
  { test: /nicotine|smok|vape|tobacco/i, phrase: 'used nicotine', anti: 'stayed off nicotine', lever: 'nicotine' },
  { test: /cannabis|thc|marijuana/i, phrase: 'used cannabis', anti: 'stayed off cannabis', lever: null },
  { test: /sleep aid|melatonin|ambien/i, phrase: 'took a sleep aid', anti: 'skipped the sleep aid', lever: null },
  { test: /window|dark|blackout/i, phrase: 'slept in a dark room', anti: 'slept in a lit room', lever: null },
  { test: /viewed? .*sunlight|sunlight|daylight/i, phrase: 'got morning sunlight', anti: 'missed morning sunlight', lever: 'sunlight' }
];

/** "Have any alcoholic drinks?" -> { phrase:'had alcohol', anti:'stayed off alcohol' }. */
function journalPhrase(question) {
  const q = String(question || '').trim();
  for (let i = 0; i < JOURNAL_PHRASES.length; i += 1) {
    if (JOURNAL_PHRASES[i].test.test(q)) {
      return { phrase: JOURNAL_PHRASES[i].phrase, anti: JOURNAL_PHRASES[i].anti, lever: JOURNAL_PHRASES[i].lever };
    }
  }
  const plain = q.replace(/\?+\s*$/, '').replace(/^did you\s+/i, '').replace(/^have\s+/i, '').trim().toLowerCase();
  return { phrase: plain ? `answered yes to “${plain}”` : 'answered yes', anti: plain ? `answered no to “${plain}”` : 'answered no', lever: null };
}

/* ─────────────────────────── evidence thresholds ─────────────────────────── */

/**
 * The floors below which we refuse to publish anything. These are deliberately strict:
 * a wrong "law" told confidently to a paying member is far more damaging than a missing
 * one, and the honest alternative ("keep logging, N more days to your first law") is
 * itself a good experience.
 */
const MIN_PAIRS = 14;          // paired (input day D, output day D+1) observations
const MIN_GROUP = 5;           // per side of a yes/no split
const MIN_N_HIGH_TIER = 21;    // a "high confidence" law needs three weeks of evidence
const Q_HIGH = 0.05;
const Q_MODERATE = 0.10;
const MIN_ABS_RHO = 0.25;      // below this the relationship is real but not worth acting on
const MIN_ABS_D = 0.45;        // Cohen's d floor for yes/no findings
const MEMBER_MAX_LAWS = 3;

/* ───────────────────────────── the daily table ───────────────────────────── */

function ymdShift(ymd, delta) {
  const d = new Date(String(ymd) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetweenYmd(a, b) {
  const ta = Date.parse(String(a) + 'T00:00:00Z');
  const tb = Date.parse(String(b) + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/** Index an array of {date,...} by its YYYY-MM-DD. Last write wins. */
function byDate(rows, pick) {
  const m = new Map();
  (rows || []).forEach((r) => {
    const d = r && (r.date || r.stat_date || r.checkin_date || r.snapshot_date);
    const key = d ? String(d).slice(0, 10) : null;
    if (key) m.set(key, pick ? pick(r) : r);
  });
  return m;
}

/**
 * One row per calendar day in the window, holding every INPUT the member controls and
 * every OUTPUT their band measured. Days with nothing recorded still appear, as holes —
 * that is what keeps coverage honest downstream.
 */
function buildDailyTable(input, from, to) {
  const readiness = byDate(input.readiness);
  const nutrition = byDate(input.nutrition);
  const checkins = byDate(input.checkins);
  const mind = new Set((input.mindDates || []).map((d) => String(d).slice(0, 10)));
  const logged = new Set((input.workoutDates || []).map((d) => String(d).slice(0, 10)));

  // Whoop workouts collapse to a per-day total: three sessions in a day is one training
  // load, not three independent observations.
  const workoutMin = new Map();
  (input.whoopWorkouts || []).forEach((w) => {
    const d = w && w.date ? String(w.date).slice(0, 10) : null;
    const m = num(w && w.durationMin);
    if (!d || m == null) return;
    workoutMin.set(d, (workoutMin.get(d) || 0) + m);
  });

  // Journal answers -> per-day map of question -> boolean.
  const journal = new Map();
  (input.journal || []).forEach((j) => {
    const d = j && j.date ? String(j.date).slice(0, 10) : null;
    const q = j && j.question ? String(j.question).trim() : '';
    if (!d || !q || typeof j.answerBool !== 'boolean') return;
    if (!journal.has(d)) journal.set(d, {});
    journal.get(d)[q] = j.answerBool;
  });

  const rows = [];
  let cursor = from;
  let guard = 0;
  while (cursor && cursor <= to && guard < 800) {
    guard += 1;
    const r = readiness.get(cursor) || null;
    const n = nutrition.get(cursor) || null;
    const c = checkins.get(cursor) || null;

    // Protein/water/steps: the nutrition tracker is the richer source, the daily
    // check-in the fallback. A member using only one of the two still gets a full row.
    const proteinG = num(n && n.total_protein) != null ? num(n.total_protein) : num(c && c.protein_g);

    rows.push({
      date: cursor,
      // ---- inputs (things the member chose) ----
      proteinG,
      calories: num(n && n.total_calories),
      carbsG: num(n && n.total_carbs),
      fatG: num(n && n.total_fat),
      fiberG: num(n && n.total_fiber),
      mealQuality: num(n && n.meal_quality_score),
      energyBalance: num(n && (n.energy_balance_est != null ? n.energy_balance_est : n.energy_difference)),
      waterMl: num(c && c.water_ml),
      steps: num(c && c.steps),
      strain: num(r && r.strain),
      workoutMin: workoutMin.has(cursor) ? workoutMin.get(cursor) : null,
      sleepConsistencyPct: num(r && r.sleepConsistencyPct),
      napMin: num(r && r.napMin),
      // A binary input is 0 only on a day we know something about — otherwise "no mind
      // session" and "no data at all" would be the same observation, and every silent
      // day would quietly vote against the habit.
      loggedWorkout: logged.has(cursor) ? 1 : (c || n || r ? 0 : null),
      mindSession: mind.has(cursor) ? 1 : (c || n || r ? 0 : null),
      journal: journal.get(cursor) || null,
      // ---- outputs (things the band measured) ----
      score: num(r && r.score),
      hrvMs: num(r && r.hrvMs),
      restingHr: num(r && r.restingHr),
      sleepEfficiencyPct: num(r && r.sleepEfficiencyPct),
      sleepHours: num(r && r.sleepHours),
      respiratoryRate: num(r && r.respiratoryRate),
      sleepDebtMin: num(r && r.sleepDebtMin),
      sleepNeedMin: num(r && r.sleepNeedMin),
      source: (r && r.source) || null,
      hasWearable: !!(r && (r.score != null || r.hrvMs != null || r.sleepHours != null)),
      hasNutrition: !!n,
      hasCheckin: !!c
    });
    cursor = ymdShift(cursor, 1);
  }
  return rows;
}

/* ─────────────────────────────── baselines ─────────────────────────────── */

/**
 * A member's normal, from their own last `window` days — median, not mean, so one
 * illness week or one 20km hike does not redefine "normal".
 */
function computeBaselines(rows, endDate, window) {
  const start = ymdShift(endDate, -(window - 1));
  const slice = rows.filter((r) => r.date >= start && r.date <= endDate);
  const out = {};
  const keys = OUTPUTS.map((o) => o.key).concat(['strain', 'sleepDebtMin', 'sleepNeedMin']);
  keys.forEach((k) => {
    const vals = finite(slice.map((r) => r[k]));
    out[k] = {
      median: vals.length >= 5 ? round(median(vals), 2) : null,
      mean: vals.length >= 5 ? round(mean(vals), 2) : null,
      sd: vals.length >= 5 ? round(stdev(vals), 2) : null,
      n: vals.length
    };
  });
  out._window = window;
  out._from = start;
  out._to = endDate;
  return out;
}

/* ─────────────────────────────── directive ─────────────────────────────── */

const DIRECTIVES = {
  restore: {
    code: 'restore',
    label: 'Restore',
    tone: 'critical',
    headline: 'Today is for recovery, not training.',
    guidance: 'Keep it to walking, mobility or a light zone-2 session under 30 minutes.'
  },
  hold: {
    code: 'hold',
    label: 'Hold',
    tone: 'caution',
    headline: 'Hold your ground today — maintain, do not add.',
    guidance: 'Train, but keep it to your normal load. Today is not the day for a personal best.'
  },
  build: {
    code: 'build',
    label: 'Build',
    tone: 'steady',
    headline: 'A solid day to do the work as planned.',
    guidance: 'Your body is where it usually is. Follow your programme as written.'
  },
  push: {
    code: 'push',
    label: 'Push',
    tone: 'green',
    headline: 'Your body is ready for the hardest session of your week.',
    guidance: 'This is the day to go after a heavy lift, an interval session or a long effort.'
  }
};

/** The most recent day carrying any wearable measurement at all. */
function latestMeasuredDay(rows) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] && rows[i].hasWearable) return rows[i];
  }
  return null;
}

/** Total sleep debt over the last `n` days, in minutes. Null when never measured. */
function recentSleepDebt(rows, endDate, n) {
  const start = ymdShift(endDate, -(n - 1));
  const slice = rows.filter((r) => r.date >= start && r.date <= endDate);
  let debt = 0;
  let seen = 0;
  slice.forEach((r) => {
    if (r.sleepDebtMin != null) { debt += r.sleepDebtMin; seen += 1; return; }
    if (r.sleepNeedMin != null && r.sleepHours != null) {
      debt += Math.max(0, r.sleepNeedMin - r.sleepHours * 60);
      seen += 1;
    }
  });
  return seen ? { minutes: Math.round(debt), days: seen } : null;
}

/**
 * Acute:chronic training load. >1.5 is the classic spike that precedes both injury and
 * a flat month; <0.8 means the member has quietly stopped training.
 */
function acuteChronicRatio(rows, endDate) {
  const acute = finite(rows.filter((r) => r.date > ymdShift(endDate, -7) && r.date <= endDate).map((r) => r.strain));
  const chronic = finite(rows.filter((r) => r.date > ymdShift(endDate, -28) && r.date <= endDate).map((r) => r.strain));
  if (acute.length < 3 || chronic.length < 10) return null;
  const a = mean(acute);
  const c = mean(chronic);
  if (c == null || c <= 0) return null;
  return { ratio: round(a / c, 2), acute: round(a, 1), chronic: round(c, 1), acuteDays: acute.length, chronicDays: chronic.length };
}

function hoursText(minutes) {
  if (minutes == null) return null;
  const m = Math.abs(Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (!h) return `${rem}m`;
  if (!rem) return `${h}h`;
  return `${h}h ${rem}m`;
}

/**
 * Today's verdict, from this member's own baseline — never from a population norm.
 * Ordered by severity, first match wins, and each rule records the facts that fired it
 * so the member sees WHY rather than a bare colour.
 *
 * @returns {object|null} null only when there is not enough measured data to say anything.
 */
function computeDirective(rows, baselines, today) {
  const day = latestMeasuredDay(rows);
  if (!day) return null;

  const staleness = daysBetweenYmd(day.date, today);
  const b = baselines || {};
  const dev = {};
  ['score', 'hrvMs', 'restingHr', 'respiratoryRate', 'sleepHours'].forEach((k) => {
    const base = b[k] && b[k].median != null ? b[k].median : null;
    dev[k] = {
      value: day[k],
      baseline: base,
      pct: round(pctChange(day[k], base), 1),
      diff: day[k] != null && base != null ? round(day[k] - base, 2) : null
    };
  });

  const debt = recentSleepDebt(rows, day.date, 3);
  const acwr = acuteChronicRatio(rows, day.date);
  const reasons = [];
  const basis = [];

  const hrvDown = dev.hrvMs.pct != null && dev.hrvMs.pct <= -10;
  const rhrUp = dev.restingHr.pct != null && dev.restingHr.pct >= 5;
  const respUp = dev.respiratoryRate.pct != null && dev.respiratoryRate.pct >= 8;
  const bigDebt = debt && debt.minutes >= 180;
  const someDebt = debt && debt.minutes >= 90;
  const lowScore = day.score != null && day.score < 34;
  const midScore = day.score != null && day.score >= 34 && day.score < 60;
  const highScore = day.score != null && day.score >= 70;
  const spike = acwr && acwr.ratio > 1.5;

  let code = null;

  if (lowScore || (hrvDown && rhrUp) || bigDebt || respUp) {
    code = 'restore';
    if (hrvDown && rhrUp) {
      reasons.push(`your HRV is ${Math.abs(dev.hrvMs.pct)}% below your 30-day normal while your resting heart rate is ${Math.abs(dev.restingHr.pct)}% above it`);
      basis.push('hrv_rhr_divergence');
    } else if (hrvDown) {
      reasons.push(`your HRV is ${Math.abs(dev.hrvMs.pct)}% below your 30-day normal`);
      basis.push('hrv_down');
    }
    if (bigDebt) {
      reasons.push(`you have built ${hoursText(debt.minutes)} of sleep debt over ${debt.days} nights`);
      basis.push('sleep_debt');
    }
    if (respUp && !hrvDown) {
      reasons.push(`your breathing rate overnight is ${Math.abs(dev.respiratoryRate.pct)}% above your normal`);
      basis.push('resp_up');
    }
    if (!reasons.length && lowScore) {
      reasons.push('your body has recovered well below where it normally sits');
      basis.push('low_recovery');
    }
  } else if (midScore || spike || someDebt) {
    code = 'hold';
    if (spike) {
      reasons.push(`your training load this week is ${acwr.ratio}× your usual month`);
      basis.push('load_spike');
    }
    if (someDebt) {
      reasons.push(`you are carrying ${hoursText(debt.minutes)} of sleep debt`);
      basis.push('sleep_debt');
    }
    if (!reasons.length) {
      reasons.push('your recovery came in under where it normally sits');
      basis.push('mid_recovery');
    }
  } else if (highScore && !hrvDown && !someDebt && (!acwr || acwr.ratio < 1.3)) {
    code = 'push';
    if (dev.hrvMs.pct != null && dev.hrvMs.pct > 0) {
      reasons.push(`your HRV is ${Math.abs(dev.hrvMs.pct)}% above your 30-day normal and you are carrying no sleep debt`);
      basis.push('hrv_up');
    } else {
      reasons.push('you recovered well above your normal and are carrying no sleep debt');
      basis.push('high_recovery');
    }
  } else {
    code = 'build';
    reasons.push('everything is sitting where it normally does for you');
    basis.push('baseline');
  }

  const d = DIRECTIVES[code];
  // Below three weeks of history the baseline itself is soft, so the verdict is offered
  // as provisional rather than stated as fact.
  const baselineN = b.hrvMs && b.hrvMs.n ? b.hrvMs.n : (b.score && b.score.n ? b.score.n : 0);
  const confidence = baselineN >= 21 ? 'high' : (baselineN >= 10 ? 'moderate' : 'low');

  return {
    code: d.code,
    label: d.label,
    tone: d.tone,
    headline: d.headline,
    guidance: d.guidance,
    reason: reasons.length ? `${reasons.join(', and ')}.` : null,
    reasons,
    basis,
    confidence,
    baselineDays: baselineN,
    asOf: day.date,
    isToday: day.date === today,
    stalenessDays: staleness == null ? null : Math.max(0, staleness),
    // Staff-only detail. projectForMember() strips this.
    detail: {
      deviations: dev,
      sleepDebt: debt,
      acwr,
      score: day.score,
      source: day.source
    }
  };
}

/* ────────────────────────────── the laws ────────────────────────────── */

/**
 * Build the paired series for one input/output hypothesis: the input on day D against
 * the output on day D+1. The lag is the point — "what I did yesterday shaped this
 * morning" is a claim a member can act on; a same-day correlation is not.
 */
function pairSeries(rows, inputKey, outputKey, journalQuestion) {
  const xs = [];
  const ys = [];
  const dates = [];
  for (let i = 0; i < rows.length - 1; i += 1) {
    const a = rows[i];
    const b = rows[i + 1];
    if (!a || !b) continue;
    if (daysBetweenYmd(a.date, b.date) !== 1) continue;
    const y = num(b[outputKey]);
    if (y == null) continue;
    let x = null;
    if (journalQuestion) {
      const j = a.journal;
      if (!j || typeof j[journalQuestion] !== 'boolean') continue;
      x = j[journalQuestion] ? 1 : 0;
    } else {
      x = num(a[inputKey]);
      if (x == null) continue;
    }
    xs.push(x);
    ys.push(y);
    dates.push(a.date);
  }
  return { xs, ys, dates };
}

function deltaText(output, diff) {
  const o = output;
  if (diff == null) return null;
  const mag = Math.abs(diff);
  if (o.memberDelta === 'points') return `${round(mag, mag < 10 ? 1 : 0)} points`;
  if (o.memberDelta === 'absolute') return `${round(mag, o.dp)}${o.unit ? ' ' + o.unit : ''}`;
  return null; // percent handled by the caller, which has the baseline
}

/** "better"/"worse" in the direction that actually helps the member. */
function betterWord(output, diff) {
  if (diff == null) return null;
  const good = output.higherIsBetter ? diff > 0 : diff < 0;
  return good ? 'better' : 'worse';
}

/**
 * Test every (input, output) hypothesis, correct for multiplicity, and turn the
 * survivors into sentences. Returns EVERY tested hypothesis that cleared the data
 * floors — including the ones that failed significance — because a coach needs to see
 * what was looked at and rejected, not just what happened to pass.
 */
function computeFindings(rows, baselines) {
  const candidates = [];

  // Fixed inputs
  INPUTS.forEach((inp) => {
    OUTPUTS.forEach((out) => {
      candidates.push({ inp, out, journalQuestion: null });
    });
  });

  // Journal questions the member actually answered often enough to be worth testing.
  const qCount = new Map();
  rows.forEach((r) => {
    if (!r.journal) return;
    Object.keys(r.journal).forEach((q) => qCount.set(q, (qCount.get(q) || 0) + 1));
  });
  const questions = Array.from(qCount.entries())
    .filter(([, c]) => c >= MIN_PAIRS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([q]) => q);
  questions.forEach((q) => {
    const meta = journalPhrase(q);
    OUTPUTS.forEach((out) => {
      candidates.push({
        inp: {
          key: 'journal:' + q,
          label: meta.phrase,
          unit: '',
          dp: 0,
          kind: 'binary',
          highPhrase: meta.phrase,
          lowPhrase: meta.anti,
          lever: meta.lever
        },
        out,
        journalQuestion: q
      });
    });
  });

  const tested = [];

  candidates.forEach(({ inp, out, journalQuestion }) => {
    const { xs, ys, dates } = pairSeries(rows, inp.key, out.key, journalQuestion);
    if (xs.length < MIN_PAIRS) return;

    const isBinary = inp.kind === 'binary';
    let stat = null;
    let split = null;

    if (isBinary) {
      const yes = [];
      const no = [];
      for (let i = 0; i < xs.length; i += 1) (xs[i] ? yes : no).push(ys[i]);
      if (yes.length < MIN_GROUP || no.length < MIN_GROUP) return;
      const w = welch(yes, no);
      if (!w) return;
      stat = { kind: 'binary', p: w.p, effect: w.d, diff: w.diff, n: w.n, nHigh: w.nA, nLow: w.nB, meanHigh: w.meanA, meanLow: w.meanB };
      split = { threshold: null, highLabel: inp.highPhrase, lowLabel: inp.lowPhrase };
    } else {
      const sp = spearman(xs, ys);
      if (!sp) return;
      // The p-value uses every point (Spearman); the human-readable size of the effect
      // comes from a median split of the SAME data, because "11 points higher on days
      // you clear 130g" is actionable and "rho = 0.41" is not.
      const thr = median(xs);
      const hi = [];
      const lo = [];
      for (let i = 0; i < xs.length; i += 1) (xs[i] >= thr ? hi : lo).push(ys[i]);
      if (hi.length < MIN_GROUP || lo.length < MIN_GROUP) return;
      const w = welch(hi, lo);
      stat = {
        kind: 'continuous',
        p: sp.p,
        effect: sp.rho,
        rho: sp.rho,
        diff: w ? w.diff : null,
        d: w ? w.d : null,
        n: sp.n,
        nHigh: hi.length,
        nLow: lo.length,
        meanHigh: w ? w.meanA : mean(hi),
        meanLow: w ? w.meanB : mean(lo)
      };
      // The phrase templates carry their own unit ("{v}g of protein"), so the pretty
      // form is inserted WITHOUT one for those; water and steps override the unit
      // entirely, which is why fmtThreshold owns the whole token.
      const pretty = (inp.key === 'waterMl' || inp.key === 'steps' || inp.key === 'calories' || inp.key === 'energyBalance')
        ? fmtThreshold(inp.key, thr)
        : String(round(thr, inp.dp));
      split = {
        threshold: round(thr, inp.dp),
        thresholdText: pretty,
        highLabel: inp.highPhrase.replace('{v}', pretty),
        lowLabel: inp.lowPhrase.replace('{v}', pretty)
      };
    }

    tested.push({ inp, out, journalQuestion, stat, split, dates });
  });

  // One BH pass across every hypothesis tested for this member.
  const qs = benjaminiHochberg(tested.map((t) => t.stat.p));

  const findings = tested.map((t, i) => {
    const q = qs[i];
    const s = t.stat;
    const absEffect = Math.abs(s.effect);
    const effectFloor = s.kind === 'binary' ? MIN_ABS_D : MIN_ABS_RHO;
    const bigEnough = absEffect >= effectFloor;

    let tier = 'none';
    if (bigEnough && q <= Q_HIGH && s.n >= MIN_N_HIGH_TIER) tier = 'high';
    else if (bigEnough && q <= Q_MODERATE) tier = 'moderate';
    else if (bigEnough && s.p <= 0.05) tier = 'emerging';

    // Direction, phrased from the member's side: which behaviour was followed by the
    // better morning.
    const diff = s.diff;
    const favoursHigh = diff != null ? (t.out.higherIsBetter ? diff > 0 : diff < 0) : null;
    const behaviour = favoursHigh == null ? null : (favoursHigh ? t.split.highLabel : t.split.lowLabel);

    // The size of the effect, in the member's language. For metrics the Whoop app puts
    // on its front page (HRV ms, resting bpm) we deliberately express the CHANGE as a
    // percentage rather than reprint the reading.
    const baseline = baselines && baselines[t.out.key] ? baselines[t.out.key].median : null;
    let magnitude = null;
    if (diff != null) {
      if (t.out.memberDelta === 'percent' && baseline) {
        const pc = Math.abs((diff / baseline) * 100);
        magnitude = `${round(pc, pc < 10 ? 1 : 0)}%`;
      } else {
        magnitude = deltaText(t.out, diff);
      }
    }

    const better = betterWord(t.out, diff);
    const memberStatement = behaviour && magnitude && better
      ? `On days you ${behaviour}, your next-morning ${t.out.label} ran ${magnitude} ${better}.`
      : null;

    // The statement carries the DIRECTION and the SIZE; the caller renders n, effect,
    // p and q alongside it. Repeating them inside the sentence made every row print its
    // own statistics twice.
    const staffStatement = behaviour
      ? `${t.inp.label} → next-day ${t.out.label}: ${behaviour} associated with ` +
        `${diff == null
          ? 'no measurable change'
          : `${diff > 0 ? '+' : ''}${round(diff, t.out.dp + 1)}${t.out.unit ? ' ' + t.out.unit : ''}`}.`
      : null;

    return {
      id: `${t.inp.key}|${t.out.key}`,
      inputKey: t.inp.key,
      inputLabel: t.inp.label,
      journalQuestion: t.journalQuestion,
      leverKey: t.inp.lever || null,
      outputKey: t.out.key,
      outputLabel: t.out.label,
      outputShort: t.out.short,
      kind: s.kind,
      n: s.n,
      nHigh: s.nHigh,
      nLow: s.nLow,
      threshold: t.split.threshold,
      thresholdText: t.split.thresholdText || null,
      thresholdUnit: t.inp.unit,
      behaviour,
      favoursHigh,
      diff: round(diff, 3),
      magnitude,
      better,
      effect: round(s.effect, 3),
      effectKind: s.kind === 'binary' ? 'cohens_d' : 'spearman_rho',
      p: round(s.p, 5),
      q: round(q, 5),
      tier,
      memberSafe: tier === 'high' && !!memberStatement,
      memberStatement,
      staffStatement,
      meanHigh: round(s.meanHigh, t.out.dp + 1),
      meanLow: round(s.meanLow, t.out.dp + 1)
    };
  });

  // Strongest first: tier, then effect size.
  const tierRank = { high: 0, moderate: 1, emerging: 2, none: 3 };
  findings.sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || (Math.abs(b.effect) - Math.abs(a.effect)));

  return { findings, testedCount: tested.length, candidateCount: candidates.length };
}

/**
 * The member's laws: at most three, each about a DIFFERENT behaviour, so they read as
 * three levers rather than four restatements of "sleep more".
 */
function selectMemberLaws(findings) {
  const out = [];
  const seenInput = new Set();
  for (let i = 0; i < findings.length && out.length < MEMBER_MAX_LAWS; i += 1) {
    const f = findings[i];
    if (!f.memberSafe) continue;
    if (seenInput.has(f.inputKey)) continue;
    seenInput.add(f.inputKey);
    out.push({
      id: f.id,
      statement: f.memberStatement,
      behaviour: f.behaviour,
      outputLabel: f.outputLabel,
      magnitude: f.magnitude,
      better: f.better,
      days: f.n,
      leverKey: f.leverKey
    });
  }
  return out;
}

/* ─────────────────────────────── levers ─────────────────────────────── */

/**
 * Fallback actions when the member's own data has not yet produced a law worth acting
 * on. Keyed by directive, and each one is chosen against a real deficit measured today —
 * never generic advice.
 */
const DIRECTIVE_LEVERS = {
  restore: [
    { key: 'sleep', title: 'Get to bed 45 minutes earlier tonight', detail: 'Sleep is the only intervention that clears the debt you are carrying.' },
    { key: 'walk', title: 'Swap today\'s session for a 30-minute walk', detail: 'Movement without load lets the recovery happen instead of competing with it.' }
  ],
  hold: [
    { key: 'sameLoad', title: 'Repeat last week\'s load — do not add to it', detail: 'Your body is still absorbing what you have already given it.' },
    { key: 'protein', title: 'Front-load protein at breakfast', detail: 'Repair happens on the material you supply.' }
  ],
  build: [
    { key: 'programme', title: 'Do the session as written', detail: 'Nothing in your data argues for changing today\'s plan.' },
    { key: 'water', title: 'Clear your water target before 4pm', detail: 'Hydration is the cheapest thing you can get right today.' }
  ],
  push: [
    { key: 'hardest', title: 'Put your hardest session of the week here', detail: 'Days like this are rare — spending one on an easy session wastes it.' },
    { key: 'fuel', title: 'Eat before you train', detail: 'A ready body still needs fuel to express it.' }
  ]
};

/**
 * Today's single highest-value action.
 *
 * Ranked: (1) a law the member is currently on the wrong side of — that is a lever with
 * their own evidence behind it; (2) a deficit visible today; (3) the directive default.
 */
function computeLevers(rows, findings, directive, today, baselines) {
  const levers = [];
  const day = latestMeasuredDay(rows) || rows[rows.length - 1] || null;
  const recent = rows.filter((r) => r.date > ymdShift(today, -3) && r.date <= today);

  const lastValue = (key) => {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const v = num(recent[i][key]);
      if (v != null) return { value: v, date: recent[i].date };
    }
    return null;
  };

  // (1) Evidence-backed: the STRONGEST high-tier law whose favourable side the member
  // missed recently. Deliberately capped at one — the laws section already lists them
  // all, so a second evidence lever just reprints that section word for word and makes
  // the whole screen look automated. One action is an instruction; three is a list.
  for (let i = 0; i < findings.length; i += 1) {
    const f = findings[i];
    if (f.tier !== 'high' || !f.memberStatement || f.threshold == null) continue;
    if (f.kind !== 'continuous') continue;
    const cur = lastValue(f.inputKey);
    if (!cur) continue;
    const onGoodSide = f.favoursHigh ? cur.value >= f.threshold : cur.value < f.threshold;
    if (onGoodSide) continue;
    const inp = INPUT_BY_KEY[f.inputKey];
    // fmtThreshold, NOT thresholdText: the latter omits the unit for inputs whose
    // sentence template supplies it ("{v}g of protein"), and a lever has no template
    // to lean on — "clear 135 of protein" is not an instruction.
    const amount = fmtThreshold(f.inputKey, f.threshold, inp && inp.unit);
    levers.push({
      key: 'law:' + f.id,
      title: f.favoursHigh
        ? `Today, get your ${f.inputLabel} to ${amount} or above`
        : `Today, keep your ${f.inputLabel} under ${amount}`,
      detail: f.memberStatement,
      evidence: `Measured across ${f.n} of your own days.`,
      tier: 'evidence',
      lastValue: round(cur.value, inp ? inp.dp : 0),
      lastValueDate: cur.date
    });
    break;
  }

  // (2) A deficit that is true today regardless of whether it has reached significance.
  if (levers.length < 3 && directive) {
    const debt = directive.detail && directive.detail.sleepDebt;
    if (debt && debt.minutes >= 90) {
      levers.push({
        key: 'deficit:sleep',
        title: `Clear ${hoursText(debt.minutes)} of sleep debt`,
        detail: 'Earlier to bed tonight is worth more than anything you can do in the gym today.',
        evidence: `Measured across your last ${debt.days} nights.`,
        tier: 'deficit'
      });
    }
    const acwr = directive.detail && directive.detail.acwr;
    if (levers.length < 3 && acwr && acwr.ratio > 1.5) {
      levers.push({
        key: 'deficit:load',
        title: 'Pull today\'s session back to an easy effort',
        detail: `Your last 7 days of training are running ${acwr.ratio}× your usual month.`,
        evidence: 'Compared against your own 28-day training load.',
        tier: 'deficit'
      });
    }
    if (levers.length < 3 && day) {
      const water = lastValue('waterMl');
      if (water && water.value < 2000) {
        levers.push({
          key: 'deficit:water',
          title: 'Get 2 litres of water in before 4pm',
          detail: `Your most recent logged day came in at ${Math.round(water.value)}ml.`,
          evidence: 'From your own check-in log.',
          tier: 'deficit'
        });
      }
    }
  }

  // (3) Directive default — always available, so the member never sees an empty card.
  if (levers.length < 1 && directive) {
    (DIRECTIVE_LEVERS[directive.code] || []).slice(0, 1).forEach((l) => {
      levers.push({ key: 'directive:' + l.key, title: l.title, detail: l.detail, evidence: null, tier: 'guidance' });
    });
  }

  return levers.slice(0, 3);
}

/* ────────────────────────────── risk flags ────────────────────────────── */

/**
 * Staff-only detectors. Deliberately NOT shown to the member: "possible illness" or
 * "non-functional overreaching" is a conversation a coach has, not a push notification,
 * and BodyBank is not making a clinical claim. The member feels these through the
 * directive instead.
 */
function computeFlags(rows, baselines, today, profile) {
  const flags = [];
  const push = (key, severity, title, detail, evidence) => {
    flags.push({ key, severity, title, detail, evidence: evidence || null });
  };

  const measured = rows.filter((r) => r.hasWearable);
  const last = measured.length ? measured[measured.length - 1] : null;

  // ---- data trust ----
  const windowDays = rows.length;
  const coverage = windowDays ? measured.length / windowDays : 0;
  if (!last) {
    push('no_data', 'medium', 'No wearable data in this window',
      'Nothing can be computed for this client until an export is imported or they check in daily.');
  } else {
    const stale = daysBetweenYmd(last.date, today);
    if (stale != null && stale >= 4) {
      push('data_stale', stale >= 10 ? 'high' : 'medium', `Wearable data is ${stale} days old`,
        `Last measured day is ${last.date}. Every figure below describes that window, not today.`,
        { lastDate: last.date, days: stale });
    }
    if (coverage < 0.6) {
      push('low_coverage', 'medium', `Only ${Math.round(coverage * 100)}% of days have data`,
        'Findings from a window this sparse are provisional — the correlation floors may not be met.',
        { coverage: round(coverage * 100, 0), days: measured.length, windowDays });
    }
  }
  if (!last) return flags;

  // ---- illness / autonomic signature ----
  // Two consecutive mornings of HRV down AND resting HR up is the classic pre-symptomatic
  // pattern. Reported as a pattern, never as a diagnosis.
  const bHrv = baselines.hrvMs && baselines.hrvMs.median;
  const bRhr = baselines.restingHr && baselines.restingHr.median;
  const bResp = baselines.respiratoryRate && baselines.respiratoryRate.median;
  if (bHrv && bRhr) {
    let streak = 0;
    let best = 0;
    const tail = measured.slice(-7);
    tail.forEach((r) => {
      const hrvPct = pctChange(r.hrvMs, bHrv);
      const rhrPct = pctChange(r.restingHr, bRhr);
      if (hrvPct != null && rhrPct != null && hrvPct <= -10 && rhrPct >= 5) { streak += 1; best = Math.max(best, streak); }
      else streak = 0;
    });
    if (best >= 2) {
      const respPct = bResp ? pctChange(last.respiratoryRate, bResp) : null;
      push('autonomic_strain', best >= 3 ? 'high' : 'medium',
        `Autonomic strain pattern on ${best} consecutive days`,
        'HRV suppressed and resting heart rate elevated together against this client\'s own 30-day baseline' +
        (respPct != null && respPct >= 5 ? `, with breathing rate ${round(respPct, 0)}% up as well` : '') +
        '. Common before illness, after alcohol, or under sustained life stress. Worth a direct conversation before prescribing load.',
        { days: best, hrvBaseline: bHrv, rhrBaseline: bRhr, respPct: round(respPct, 1) });
    }
  }

  // ---- training load ----
  const acwr = acuteChronicRatio(rows, last.date);
  if (acwr && acwr.ratio > 1.5) {
    push('load_spike', acwr.ratio > 1.8 ? 'high' : 'medium',
      `Training load spike (${acwr.ratio}× usual)`,
      `Last 7 days average strain ${acwr.acute} against a 28-day average of ${acwr.chronic}. This is the ratio that precedes both injury and a flat month.`,
      acwr);
  }
  if (acwr && acwr.ratio < 0.7) {
    push('load_drop', 'low', `Training load has dropped to ${acwr.ratio}× usual`,
      `Last 7 days average strain ${acwr.acute} against a 28-day average of ${acwr.chronic}. Often the first visible sign of disengagement.`,
      acwr);
  }

  // Hard days on empty: training above the member's own median strain while recovery is
  // under 50. Three or more in a week is the definition of digging a hole.
  const medStrain = baselines.strain && baselines.strain.median;
  if (medStrain) {
    const week = measured.slice(-7);
    const hard = week.filter((r) => r.strain != null && r.score != null && r.strain > medStrain && r.score < 50);
    if (hard.length >= 3) {
      push('training_on_empty', 'high', `Trained hard on ${hard.length} low-recovery days this week`,
        'Repeatedly loading a body that has not recovered is how a plateau and a soft-tissue injury both start.',
        { days: hard.map((r) => r.date) });
    }
  }

  // ---- sleep ----
  const debt7 = recentSleepDebt(rows, last.date, 7);
  if (debt7 && debt7.days >= 4 && debt7.minutes >= 300) {
    push('sleep_debt_chronic', debt7.minutes >= 600 ? 'high' : 'medium',
      `${hoursText(debt7.minutes)} of sleep debt across ${debt7.days} nights`,
      'Sustained debt at this level suppresses recovery, appetite regulation and training adaptation at once.',
      debt7);
  }

  // ---- fuelling ----
  const week = rows.slice(-7);
  const eb = mean(week.map((r) => r.energyBalance));
  const strainAvg = mean(week.map((r) => r.strain));
  if (eb != null && eb <= -700 && strainAvg != null && strainAvg >= 10) {
    push('underfuelling', 'high', `Averaging ${Math.round(eb)} kcal balance while training at strain ${round(strainAvg, 1)}`,
      'A deficit this size against this training load is where lean mass, recovery and hormones all start paying for the scale.',
      { energyBalance: Math.round(eb), strain: round(strainAvg, 1) });
  }

  // Protein against bodyweight — only when we actually know the bodyweight.
  const kg = profile && num(profile.weightKg);
  const proteinAvg = mean(week.map((r) => r.proteinG));
  if (kg && proteinAvg != null) {
    const perKg = proteinAvg / kg;
    if (perKg < 1.2) {
      push('protein_low', perKg < 0.9 ? 'high' : 'medium',
        `Protein averaging ${round(perKg, 2)} g/kg`,
        `${Math.round(proteinAvg)}g/day against ${round(kg, 1)}kg bodyweight. Below the range that supports recovery from this training.`,
        { perKg: round(perKg, 2), proteinAvg: Math.round(proteinAvg), weightKg: round(kg, 1) });
    }
  }

  const sev = { high: 0, medium: 1, low: 2 };
  flags.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return flags;
}

/* ─────────────────────────────── coverage ─────────────────────────────── */

function computeCoverage(rows) {
  const total = rows.length || 0;
  const wearable = rows.filter((r) => r.hasWearable).length;
  const nutrition = rows.filter((r) => r.hasNutrition).length;
  const checkin = rows.filter((r) => r.hasCheckin).length;
  // A day only helps the correlation engine when it carries BOTH an input and the next
  // morning's output, so this — not the raw wearable count — is the number that decides
  // whether the member gets any laws at all.
  let usable = 0;
  for (let i = 0; i < rows.length - 1; i += 1) {
    const a = rows[i];
    const b = rows[i + 1];
    if (!a || !b || daysBetweenYmd(a.date, b.date) !== 1) continue;
    if ((a.hasNutrition || a.hasCheckin || a.hasWearable) && b.hasWearable) usable += 1;
  }
  return {
    days: total,
    wearableDays: wearable,
    nutritionDays: nutrition,
    checkinDays: checkin,
    usablePairs: usable,
    pairsNeeded: MIN_PAIRS,
    pct: total ? Math.round((wearable / total) * 100) : 0
  };
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

/**
 * @param {object} input
 *   readiness      resolved readiness rows (readinessService.getReadinessRange shape)
 *   nutrition      nutrition_daily_stats rows
 *   checkins       daily_checkins rows
 *   whoopWorkouts  wearable_workouts rows (readinessService shape)
 *   journal        wearable_journal rows
 *   mindDates      array of YYYY-MM-DD with a mind check-in
 *   workoutDates   array of YYYY-MM-DD with a logged BodyBank workout
 *   profile        { weightKg, firstName }
 *   from, to       window bounds (YYYY-MM-DD)
 *   today          the member's today in their own timezone (YYYY-MM-DD)
 * @returns {object} the FULL analysis. Audience projection happens in signalService.
 */
function buildSignal(input) {
  const opts = input || {};
  const to = String(opts.to || opts.today || '').slice(0, 10);
  const from = String(opts.from || '').slice(0, 10);
  const today = String(opts.today || to).slice(0, 10);
  if (!from || !to || from > to) {
    return {
      ok: false,
      error: 'A valid window is required.',
      window: { from: from || null, to: to || null },
      coverage: computeCoverage([]),
      directive: null,
      levers: [],
      laws: [],
      findings: [],
      flags: []
    };
  }

  const rows = buildDailyTable(opts, from, to);
  const coverage = computeCoverage(rows);
  const baselines = computeBaselines(rows, to, 30);
  const directive = computeDirective(rows, baselines, today);
  const { findings, testedCount, candidateCount } = computeFindings(rows, baselines);
  const laws = selectMemberLaws(findings);
  const levers = computeLevers(rows, findings, directive, today, baselines);
  const flags = computeFlags(rows, baselines, today, opts.profile || null);

  const highs = findings.filter((f) => f.tier === 'high').length;
  const moderates = findings.filter((f) => f.tier === 'moderate').length;
  const emerging = findings.filter((f) => f.tier === 'emerging').length;

  return {
    ok: true,
    window: { from, to, days: rows.length },
    today,
    coverage,
    baselines,
    directive,
    levers,
    laws,
    findings,
    flags,
    diagnostics: {
      hypothesesConsidered: candidateCount,
      hypothesesTested: testedCount,
      minPairs: MIN_PAIRS,
      minGroup: MIN_GROUP,
      qHigh: Q_HIGH,
      qModerate: Q_MODERATE,
      minAbsRho: MIN_ABS_RHO,
      minAbsD: MIN_ABS_D,
      tiers: { high: highs, moderate: moderates, emerging, none: findings.length - highs - moderates - emerging },
      lagDays: 1,
      correction: 'benjamini-hochberg'
    },
    // Kept for the staff surfaces only — the daily table is the audit trail behind
    // every sentence above. projectForMember() drops it.
    daily: rows
  };
}

module.exports = {
  buildSignal,
  // exported for tests and for bloodBridge, which reuses the same honest arithmetic
  _internals: {
    num, mean, median, stdev, pctChange, finite, round, clamp,
    spearman, welch, benjaminiHochberg, tTestP, betai,
    buildDailyTable, computeBaselines, computeDirective, computeFindings,
    computeFlags, computeLevers, computeCoverage, journalPhrase,
    acuteChronicRatio, recentSleepDebt, hoursText, ymdShift, daysBetweenYmd,
    latestMeasuredDay,
    INPUTS, OUTPUTS, OUTPUT_BY_KEY, DIRECTIVES,
    MIN_PAIRS, MIN_GROUP, MEMBER_MAX_LAWS
  }
};
