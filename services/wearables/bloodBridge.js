'use strict';

/**
 * BodyBank — the Bloodwork Bridge.
 *
 * A lab report is the most expensive and least used data a member ever gives us. It is
 * read once, filed, and never connects to anything they feel. Meanwhile their band has
 * been recording, every single morning, the physiology those markers actually govern.
 *
 * This module joins the two. For each marker it knows, it compares the 30 days of
 * wearable data ENDING at the blood draw against the member's own baseline outside that
 * window, and reports whether the body was behaving the way the marker predicts. When a
 * member has two reports it does the far more valuable thing: it puts the change in the
 * marker next to the change in the physiology over the same period.
 *
 *   "Your ferritin went from 22 to 48 ng/mL between March and July. Across those same
 *    weeks your resting heart rate came down 7% and your recovery averaged 13 points
 *    higher."
 *
 * No wearable company can write that sentence — they have no labs. No lab can write it
 * — they have no wearable. That sentence is the product.
 *
 * HONESTY RULES
 * -------------
 *  - Only markers in the curated LINKS table are bridged. An out-of-range LDL has no
 *    reliable overnight-physiology signature, so we say nothing about it here rather
 *    than inventing a connection.
 *  - Every link carries `strength`: 'established' or 'suggestive'. Staff see which is
 *    which; only concordant, established-or-better items reach the member.
 *  - When the wearable did NOT move the way the marker predicts, that is recorded as
 *    `discordant` and shown to staff. It is never quietly dropped and it is never shown
 *    to the member as if it agreed.
 *  - Association, stated as association. The word "caused" appears nowhere.
 *  - A window with fewer than MIN_WINDOW_DAYS measured days produces nothing at all.
 */

const {
  parseNumericValue,
  parseReferenceRange,
  canonicalizeMarker
} = require('../bloodComparisonService');

/* ────────────────────────────── small helpers ────────────────────────────── */

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

function mean(arr) {
  let s = 0;
  let c = 0;
  (arr || []).forEach((v) => { const n = num(v); if (n != null) { s += n; c += 1; } });
  return c ? s / c : null;
}

function median(arr) {
  const v = [];
  (arr || []).forEach((x) => { const n = num(x); if (n != null) v.push(n); });
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function ymdShift(ymd, delta) {
  const d = new Date(String(ymd) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** A DATE column, a timestamp, or a Date -> 'YYYY-MM-DD'. Null when unusable. */
function toYmd(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return null;
}

/** "12 Mar 2026" — short, unambiguous, and never locale-dependent on the client. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd || '');
  return `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

/* ─────────────────────────── the metrics we bridge ─────────────────────────── */

/**
 * The physiological metrics a marker can be linked to. `member` decides how a change is
 * spoken to the member: 'percent' for the readings Whoop already headlines (we describe
 * the movement, never reprint the number), 'points' for the recovery/efficiency scales.
 */
const METRICS = {
  restingHr: { label: 'resting heart rate', short: 'Resting HR', unit: 'bpm', dp: 0, higherIsBetter: false, member: 'percent', minPct: 3 },
  hrvMs: { label: 'HRV', short: 'HRV', unit: 'ms', dp: 0, higherIsBetter: true, member: 'percent', minPct: 5 },
  score: { label: 'recovery', short: 'Recovery', unit: '', dp: 0, higherIsBetter: true, member: 'points', minAbs: 4 },
  sleepEfficiencyPct: { label: 'sleep efficiency', short: 'Sleep eff.', unit: '%', dp: 0, higherIsBetter: true, member: 'points', minAbs: 3 },
  sleepHours: { label: 'sleep duration', short: 'Sleep', unit: 'h', dp: 1, higherIsBetter: true, member: 'absolute', minAbs: 0.4 },
  respiratoryRate: { label: 'overnight breathing rate', short: 'Resp. rate', unit: 'rpm', dp: 1, higherIsBetter: false, member: 'percent', minPct: 4 }
};

const METRIC_KEYS = Object.keys(METRICS);

/* ─────────────────────────────── the link table ─────────────────────────────── */

/**
 * Marker -> the overnight physiology it governs.
 *
 * `key` matches canonicalizeMarker().key from bloodComparisonService, so the two engines
 * can never disagree about what "Hb" or "25-OH Vitamin D" is.
 *
 * `when` is the abnormality this entry describes ('low' or 'high'), and `expect` is what
 * that abnormality does to each metric. A marker can appear twice when both directions
 * matter (TSH does, and they point opposite ways — encoding only one would have us tell
 * a hyperthyroid member their raised heart rate disagreed with their labs).
 */
const LINKS = [
  {
    key: 'ferritin', display: 'Ferritin', when: 'low', strength: 'established',
    expect: { restingHr: 'up', hrvMs: 'down', score: 'down' },
    mechanism: 'Ferritin is your iron store. When it runs down, your blood carries less oxygen per beat, so your heart beats more often to deliver the same amount — at rest and in training.',
    memberWhy: 'Low iron stores make your heart work harder for the same effort.'
  },
  {
    key: 'hemoglobin', display: 'Haemoglobin', when: 'low', strength: 'established',
    expect: { restingHr: 'up', hrvMs: 'down', score: 'down' },
    mechanism: 'Haemoglobin is the oxygen carrier itself. Less of it means a higher heart rate to move the same oxygen.',
    memberWhy: 'Less oxygen-carrying capacity means a harder-working heart.'
  },
  {
    key: 'serum iron', display: 'Serum Iron', when: 'low', strength: 'suggestive',
    expect: { restingHr: 'up', score: 'down' },
    mechanism: 'Circulating iron tracks with oxygen transport, though it moves day to day far more than ferritin does.',
    memberWhy: 'Low circulating iron shows up as a harder-working heart.'
  },
  {
    key: 'vitamin d', display: 'Vitamin D', when: 'low', strength: 'established',
    expect: { sleepEfficiencyPct: 'down', score: 'down' },
    mechanism: 'Vitamin D status is consistently associated with sleep quality and with how completely the body recovers overnight.',
    memberWhy: 'Low vitamin D is repeatedly linked to broken, less restorative sleep.'
  },
  {
    key: 'vitamin b12', display: 'Vitamin B12', when: 'low', strength: 'established',
    expect: { score: 'down', hrvMs: 'down' },
    mechanism: 'B12 is required to build red blood cells and to maintain nerve signalling, including the vagal signalling that HRV measures.',
    memberWhy: 'B12 sits underneath both your blood and your nervous system.'
  },
  {
    key: 'tsh', display: 'TSH', when: 'high', strength: 'established',
    expect: { restingHr: 'down', score: 'down', sleepHours: 'up' },
    mechanism: 'A raised TSH means the thyroid is being pushed to produce more — an underactive picture, which slows the resting heart rate and raises sleep need.',
    memberWhy: 'An underactive thyroid slows your whole system down.'
  },
  {
    key: 'tsh', display: 'TSH', when: 'low', strength: 'established',
    expect: { restingHr: 'up', hrvMs: 'down', sleepEfficiencyPct: 'down' },
    mechanism: 'A suppressed TSH means an overactive picture, which drives the resting heart rate up and fragments sleep.',
    memberWhy: 'An overactive thyroid keeps your system revved even at rest.'
  },
  {
    key: 'hba1c', display: 'HbA1c', when: 'high', strength: 'established',
    expect: { hrvMs: 'down', restingHr: 'up', sleepEfficiencyPct: 'down' },
    mechanism: 'HbA1c is your three-month average blood sugar. Sustained high glucose blunts the autonomic control that HRV measures and fragments the second half of the night.',
    memberWhy: 'Your three-month average blood sugar shows up directly in your overnight recovery.'
  },
  {
    key: 'fasting glucose', display: 'Fasting Glucose', when: 'high', strength: 'established',
    expect: { hrvMs: 'down', sleepEfficiencyPct: 'down' },
    mechanism: 'A raised fasting glucose reflects the same metabolic pressure HbA1c averages, and shows in overnight autonomic tone.',
    memberWhy: 'Raised fasting sugar and disturbed overnight recovery travel together.'
  },
  {
    key: 'triglycerides', display: 'Triglycerides', when: 'high', strength: 'suggestive',
    expect: { hrvMs: 'down', restingHr: 'up' },
    mechanism: 'Raised triglycerides accompany the same metabolic pattern that suppresses heart-rate variability. The association is real but weaker than for HbA1c.',
    memberWhy: 'Raised triglycerides tend to travel with lower overnight recovery.'
  },
  {
    key: 'crp', display: 'CRP', when: 'high', strength: 'established',
    expect: { restingHr: 'up', hrvMs: 'down', respiratoryRate: 'up' },
    mechanism: 'CRP is a direct measure of systemic inflammation, and inflammation raises resting heart rate and breathing rate while suppressing HRV.',
    memberWhy: 'Inflammation shows up overnight before you feel it in the day.'
  },
  {
    key: 'hs crp', display: 'hs-CRP', when: 'high', strength: 'established',
    expect: { restingHr: 'up', hrvMs: 'down', respiratoryRate: 'up' },
    mechanism: 'High-sensitivity CRP picks up the low-grade inflammation that standard CRP misses — the level that still moves resting heart rate and HRV.',
    memberWhy: 'Even low-grade inflammation is visible in your overnight numbers.'
  },
  {
    key: 'esr', display: 'ESR', when: 'high', strength: 'suggestive',
    expect: { restingHr: 'up', hrvMs: 'down' },
    mechanism: 'ESR is a slower, less specific inflammation marker, and moves with the same autonomic picture as CRP.',
    memberWhy: 'Inflammation shows up overnight before you feel it in the day.'
  },
  {
    key: 'wbc', display: 'White Cell Count', when: 'high', strength: 'established',
    expect: { restingHr: 'up', respiratoryRate: 'up' },
    mechanism: 'A raised white cell count means the immune system was active at the draw — which raises resting heart rate and breathing rate in the same period.',
    memberWhy: 'Your immune system was busy, and your overnight numbers show it.'
  },
  {
    key: 'testosterone', display: 'Testosterone', when: 'low', strength: 'established',
    expect: { score: 'down', sleepEfficiencyPct: 'down' },
    mechanism: 'Testosterone and sleep quality are bidirectional: poor sleep suppresses it, and low levels degrade recovery from training.',
    memberWhy: 'Testosterone and sleep quality feed each other in both directions.'
  },
  {
    key: 'uric acid', display: 'Uric Acid', when: 'high', strength: 'suggestive',
    expect: { hrvMs: 'down', restingHr: 'up' },
    mechanism: 'Raised uric acid accompanies metabolic and oxidative load, which is associated with lower overnight autonomic variability.',
    memberWhy: 'Raised uric acid travels with the same load that lowers overnight recovery.'
  },
  {
    key: 'alt', display: 'ALT (SGPT)', when: 'high', strength: 'suggestive',
    expect: { hrvMs: 'down', score: 'down' },
    mechanism: 'A raised ALT reflects hepatic load — commonly alcohol, medication or metabolic fat — and the same exposures suppress overnight recovery.',
    memberWhy: 'Whatever is loading your liver is usually loading your recovery too.'
  },
  {
    key: 'ast', display: 'AST (SGOT)', when: 'high', strength: 'suggestive',
    expect: { hrvMs: 'down', score: 'down' },
    mechanism: 'AST rises with both hepatic and muscular load, so a raised value alongside heavy training is expected rather than alarming.',
    memberWhy: 'Raised AST can simply reflect hard training, not illness.'
  }
  // Deliberately absent: LDL, HDL, Total Cholesterol, VLDL, Creatinine, Platelets, RBC,
  // TIBC. They matter clinically and appear in the member's blood report — but none has
  // an overnight-physiology signature reliable enough to bridge, and a fabricated link
  // would poison the credibility of the ones above.
];

/** Fastest lookup for "does this report contain anything we can bridge". */
const LINKS_BY_KEY = new Map();
LINKS.forEach((l) => {
  if (!LINKS_BY_KEY.has(l.key)) LINKS_BY_KEY.set(l.key, []);
  LINKS_BY_KEY.get(l.key).push(l);
});

/* ────────────────────────────── thresholds ────────────────────────────── */

const WINDOW_DAYS = 30;        // days ENDING at the draw date — labs reflect the weeks before
const MIN_WINDOW_DAYS = 10;    // measured days needed inside that window
const MIN_BASELINE_DAYS = 10;  // measured days needed outside it
const MEMBER_MAX_ITEMS = 2;

/* ─────────────────────────── marker extraction ─────────────────────────── */

/**
 * Every marker in one report, canonicalised and range-parsed.
 * @returns {Map<string, {key,display,value,numeric,unit,referenceRange,range,status,position}>}
 */
function markersOf(reportRow) {
  const out = new Map();
  const extracted = parseMaybeJson(reportRow && reportRow.extracted_blood_data);
  const panels = extracted && Array.isArray(extracted.panels) ? extracted.panels : [];
  panels.forEach((panel) => {
    const markers = panel && Array.isArray(panel.markers) ? panel.markers : [];
    markers.forEach((m) => {
      if (!m || !m.name) return;
      const { key, display } = canonicalizeMarker(m.name);
      const refRaw = m.reference_range != null ? m.reference_range : (m.reference != null ? m.reference : '');
      const range = parseReferenceRange(refRaw);
      const parsed = parseNumericValue(m.value);
      // Where the value sits relative to its own printed range. The lab's range is the
      // only authority here — a hard-coded "normal ferritin" would be wrong for half the
      // labs in the country.
      let position = null;
      if (parsed.num != null && range) {
        if (range.low != null && parsed.num < range.low) position = 'low';
        else if (range.high != null && parsed.num > range.high) position = 'high';
        else position = 'in';
      }
      // First occurrence wins: a marker repeated across panels is the same test.
      if (!out.has(key)) {
        out.set(key, {
          key,
          display,
          value: String(m.value != null ? m.value : '').trim(),
          numeric: parsed.num,
          unit: String(m.unit || '').trim(),
          referenceRange: String(refRaw || '').trim(),
          range,
          status: String(m.status || '').trim() || null,
          position
        });
      }
    });
  });
  return out;
}

/** Reports that carry a usable date, oldest -> newest by the LAB date. */
function orderedReports(reportRows) {
  return (reportRows || [])
    .map((r) => {
      const date = toYmd(r && r.report_date) || toYmd(r && r.created_at);
      return date ? { row: r, date, isLabDate: !!(r && r.report_date), markers: markersOf(r), id: r && r.id } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/* ─────────────────────────── window statistics ─────────────────────────── */

/** Mean of each bridged metric across the days in [from, to]. */
function windowStats(rows, from, to) {
  const slice = (rows || []).filter((r) => r && r.date >= from && r.date <= to);
  const out = { from, to, days: 0, metrics: {} };
  let measured = 0;
  slice.forEach((r) => {
    if (r.score != null || r.hrvMs != null || r.restingHr != null || r.sleepHours != null) measured += 1;
  });
  out.days = measured;
  METRIC_KEYS.forEach((k) => {
    const vals = slice.map((r) => r[k]);
    const m = mean(vals);
    const n = vals.filter((v) => num(v) != null).length;
    out.metrics[k] = { mean: round(m, METRICS[k].dp + 1), n };
  });
  return out;
}

/** Baseline from every measured day OUTSIDE [from, to] — otherwise the window is compared to itself. */
function baselineOutside(rows, from, to) {
  const slice = (rows || []).filter((r) => r && (r.date < from || r.date > to));
  const out = { days: 0, metrics: {} };
  let measured = 0;
  slice.forEach((r) => {
    if (r.score != null || r.hrvMs != null || r.restingHr != null || r.sleepHours != null) measured += 1;
  });
  out.days = measured;
  METRIC_KEYS.forEach((k) => {
    const vals = slice.map((r) => r[k]);
    const m = median(vals);
    const n = vals.filter((v) => num(v) != null).length;
    out.metrics[k] = { median: round(m, METRICS[k].dp + 1), n };
  });
  return out;
}

/**
 * Did `value` move meaningfully against `base`, and in which direction?
 * The per-metric floors in METRICS keep noise out: a 1% HRV wobble is not a finding.
 * @returns {{diff:number, pct:number|null, direction:'up'|'down'|'flat', moved:boolean}|null}
 */
function movement(metricKey, value, base) {
  const meta = METRICS[metricKey];
  if (!meta || value == null || base == null) return null;
  const diff = value - base;
  const pct = base !== 0 ? (diff / Math.abs(base)) * 100 : null;
  let moved;
  if (meta.minPct != null) moved = pct != null && Math.abs(pct) >= meta.minPct;
  else moved = Math.abs(diff) >= (meta.minAbs || 0);
  return {
    diff: round(diff, meta.dp + 1),
    pct: round(pct, 1),
    direction: !moved ? 'flat' : (diff > 0 ? 'up' : 'down'),
    moved
  };
}

/** How a movement is spoken to a member: never the reading, always the change. */
function movementPhrase(metricKey, mv) {
  const meta = METRICS[metricKey];
  if (!meta || !mv || !mv.moved) return null;
  const better = meta.higherIsBetter ? mv.diff > 0 : mv.diff < 0;
  const verb = mv.direction === 'up' ? 'rose' : 'came down';
  let size;
  if (meta.member === 'percent') size = `${Math.abs(mv.pct)}%`;
  else if (meta.member === 'points') size = `${Math.abs(round(mv.diff, 0))} points`;
  else size = `${Math.abs(round(mv.diff, meta.dp))}${meta.unit ? ' ' + meta.unit : ''}`;
  return { text: `your ${meta.label} ${verb} ${size}`, better, size, verb };
}

/* ─────────────────────────── state items (one report) ─────────────────────────── */

/**
 * "This marker was out of range, and here is what your body was doing over the weeks
 * that produced it."
 */
function buildStateItem(link, marker, report, rows) {
  const to = report.date;
  const from = ymdShift(to, -(WINDOW_DAYS - 1));
  if (!from) return null;

  const win = windowStats(rows, from, to);
  if (win.days < MIN_WINDOW_DAYS) return null;
  const base = baselineOutside(rows, from, to);
  if (base.days < MIN_BASELINE_DAYS) return null;

  const observations = [];
  let concordant = 0;
  let discordant = 0;

  Object.keys(link.expect).forEach((mk) => {
    const expected = link.expect[mk];
    const w = win.metrics[mk];
    const b = base.metrics[mk];
    if (!w || !b || w.mean == null || b.median == null || w.n < 5) return;
    const mv = movement(mk, w.mean, b.median);
    if (!mv) return;
    const agrees = mv.moved && mv.direction === expected;
    const opposes = mv.moved && mv.direction !== expected;
    if (agrees) concordant += 1;
    if (opposes) discordant += 1;
    observations.push({
      metric: mk,
      label: METRICS[mk].label,
      short: METRICS[mk].short,
      expected,
      observed: mv.direction,
      windowMean: w.mean,
      baselineMedian: b.median,
      windowN: w.n,
      diff: mv.diff,
      pct: mv.pct,
      moved: mv.moved,
      agrees,
      phrase: movementPhrase(mk, mv)
    });
  });

  if (!observations.length) return null;

  const verdict = concordant > 0 && concordant >= discordant
    ? 'concordant'
    : (concordant === 0 && discordant > 0 ? 'discordant' : 'mixed');

  const agreeing = observations.filter((o) => o.agrees && o.phrase);
  const memberStatement = verdict === 'concordant' && agreeing.length
    ? `Your ${marker.display.toLowerCase()} was ${marker.value}${marker.unit ? ' ' + marker.unit : ''} on ${prettyDate(report.date)}` +
      `${marker.referenceRange ? ` (reference ${marker.referenceRange})` : ''}. ` +
      `Across the 30 days leading up to that draw, ${agreeing.map((o) => o.phrase.text).join(' and ')} compared with your usual.`
    : null;

  return {
    kind: 'state',
    markerKey: link.key,
    marker: marker.display,
    linkDirection: link.when,
    strength: link.strength,
    reportId: report.id,
    reportDate: report.date,
    isLabDate: report.isLabDate,
    value: marker.value,
    numeric: marker.numeric,
    unit: marker.unit,
    referenceRange: marker.referenceRange,
    position: marker.position,
    window: { from, to, days: win.days },
    baselineDays: base.days,
    observations,
    concordantCount: concordant,
    discordantCount: discordant,
    verdict,
    mechanism: link.mechanism,
    memberWhy: link.memberWhy,
    memberStatement,
    memberSafe: verdict === 'concordant' && link.strength === 'established' && !!memberStatement
  };
}

/* ─────────────────────── change items (two reports) ─────────────────────── */

/**
 * The one nobody else can produce: the marker moved THIS much, and over the same period
 * the physiology moved THAT much. Two windows compared directly — no baseline needed,
 * because each window is the other's control.
 */
function buildChangeItem(link, earlier, later, rows) {
  const a = earlier.marker;
  const b = later.marker;
  if (a.numeric == null || b.numeric == null) return null;

  const aTo = earlier.report.date;
  const aFrom = ymdShift(aTo, -(WINDOW_DAYS - 1));
  const bTo = later.report.date;
  const bFrom = ymdShift(bTo, -(WINDOW_DAYS - 1));
  if (!aFrom || !bFrom) return null;
  // Overlapping windows would compare a period with itself.
  if (bFrom <= aTo) return null;

  const winA = windowStats(rows, aFrom, aTo);
  const winB = windowStats(rows, bFrom, bTo);
  if (winA.days < MIN_WINDOW_DAYS || winB.days < MIN_WINDOW_DAYS) return null;

  const markerDiff = b.numeric - a.numeric;
  if (markerDiff === 0) return null;

  // Which way is "better" for this marker? The link's `when` names the abnormal side:
  // a 'low' link improves as the value rises.
  const markerImproved = link.when === 'low' ? markerDiff > 0 : markerDiff < 0;

  const observations = [];
  let concordant = 0;
  let discordant = 0;

  Object.keys(link.expect).forEach((mk) => {
    const expectedWhenAbnormal = link.expect[mk];
    const mA = winA.metrics[mk];
    const mB = winB.metrics[mk];
    if (!mA || !mB || mA.mean == null || mB.mean == null || mA.n < 5 || mB.n < 5) return;
    const mv = movement(mk, mB.mean, mA.mean);
    if (!mv) return;
    // If the marker got better, the physiology should move AWAY from the abnormal
    // direction; if it got worse, toward it.
    const expected = markerImproved
      ? (expectedWhenAbnormal === 'up' ? 'down' : 'up')
      : expectedWhenAbnormal;
    const agrees = mv.moved && mv.direction === expected;
    const opposes = mv.moved && mv.direction !== expected;
    if (agrees) concordant += 1;
    if (opposes) discordant += 1;
    observations.push({
      metric: mk,
      label: METRICS[mk].label,
      short: METRICS[mk].short,
      expected,
      observed: mv.direction,
      earlierMean: mA.mean,
      laterMean: mB.mean,
      diff: mv.diff,
      pct: mv.pct,
      moved: mv.moved,
      agrees,
      phrase: movementPhrase(mk, mv)
    });
  });

  if (!observations.length) return null;

  const verdict = concordant > 0 && concordant >= discordant
    ? 'concordant'
    : (concordant === 0 && discordant > 0 ? 'discordant' : 'mixed');

  const agreeing = observations.filter((o) => o.agrees && o.phrase);
  const unit = b.unit || a.unit || '';
  const memberStatement = verdict === 'concordant' && agreeing.length
    ? `Your ${b.display.toLowerCase()} moved from ${a.value || a.numeric} to ${b.value || b.numeric}${unit ? ' ' + unit : ''} ` +
      `between ${prettyDate(aTo)} and ${prettyDate(bTo)}. Over those same weeks, ${agreeing.map((o) => o.phrase.text).join(' and ')}.`
    : null;

  return {
    kind: 'change',
    markerKey: link.key,
    marker: b.display,
    linkDirection: link.when,
    strength: link.strength,
    from: { reportId: earlier.report.id, date: aTo, value: a.value, numeric: a.numeric, referenceRange: a.referenceRange, position: a.position, window: { from: aFrom, to: aTo, days: winA.days } },
    to: { reportId: later.report.id, date: bTo, value: b.value, numeric: b.numeric, referenceRange: b.referenceRange, position: b.position, window: { from: bFrom, to: bTo, days: winB.days } },
    unit,
    markerDiff: round(markerDiff, 3),
    markerImproved,
    observations,
    concordantCount: concordant,
    discordantCount: discordant,
    verdict,
    mechanism: link.mechanism,
    memberWhy: link.memberWhy,
    memberStatement,
    memberSafe: verdict === 'concordant' && !!memberStatement
  };
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

/**
 * @param {object} input
 *   reports  blood_analysis_reports rows (need id, report_date, created_at, extracted_blood_data)
 *   rows     the signal engine's daily table (or any [{date, score, hrvMs, restingHr,
 *            sleepEfficiencyPct, sleepHours, respiratoryRate}])
 * @returns {object} { ok, items, memberItems, reportsSeen, markersSeen, bridgedMarkers, notes }
 */
function buildBloodBridge(input) {
  const opts = input || {};
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const reports = orderedReports(opts.reports);
  const notes = [];

  if (!reports.length) {
    return { ok: true, items: [], memberItems: [], reportsSeen: 0, markersSeen: 0, bridgedMarkers: [], notes: ['No blood reports on file.'] };
  }
  if (!rows.length) {
    return { ok: true, items: [], memberItems: [], reportsSeen: reports.length, markersSeen: 0, bridgedMarkers: [], notes: ['No wearable history to bridge against.'] };
  }

  const items = [];
  const bridged = new Set();
  let markersSeen = 0;
  reports.forEach((r) => { markersSeen += r.markers.size; });

  LINKS.forEach((link) => {
    // Every report that measured this marker with a usable number.
    const hits = [];
    reports.forEach((rep) => {
      const m = rep.markers.get(link.key);
      if (m && m.numeric != null) hits.push({ report: rep, marker: m });
    });
    if (!hits.length) return;

    // ---- change item: the two most recent measurements of this marker ----
    if (hits.length >= 2) {
      const later = hits[hits.length - 1];
      const earlier = hits[hits.length - 2];
      const change = buildChangeItem(link, earlier, later, rows);
      if (change) { items.push(change); bridged.add(link.key); }
    }

    // ---- state item: the latest measurement, when it is on this link's abnormal side ----
    const latest = hits[hits.length - 1];
    if (latest.marker.position === link.when) {
      const state = buildStateItem(link, latest.marker, latest.report, rows);
      if (state) { items.push(state); bridged.add(link.key); }
    }
  });

  // Change items first (they carry a before and an after), then concordant, then the
  // strongest link evidence, then the biggest observed movement.
  const verdictRank = { concordant: 0, mixed: 1, discordant: 2 };
  const strengthRank = { established: 0, suggestive: 1 };
  items.sort((a, b) => (
    (a.kind === b.kind ? 0 : a.kind === 'change' ? -1 : 1) ||
    (verdictRank[a.verdict] - verdictRank[b.verdict]) ||
    (strengthRank[a.strength] - strengthRank[b.strength]) ||
    (b.concordantCount - a.concordantCount)
  ));

  // The member gets at most two, each about a different marker AND about a different
  // piece of physiology. Ferritin and haemoglobin move together and govern the same
  // metrics, so without the second check the member reads the identical sentence twice
  // with only the marker name swapped — which makes the whole feature look automated.
  const memberItems = [];
  const seenMarker = new Set();
  const seenEvidence = new Set();
  for (let i = 0; i < items.length && memberItems.length < MEMBER_MAX_ITEMS; i += 1) {
    const it = items[i];
    if (!it.memberSafe) continue;
    if (seenMarker.has(it.markerKey)) continue;
    const evidenceKey = (it.observations || [])
      .filter((o) => o.agrees)
      .map((o) => o.metric)
      .sort()
      .join('+');
    if (evidenceKey && seenEvidence.has(evidenceKey)) continue;
    if (evidenceKey) seenEvidence.add(evidenceKey);
    seenMarker.add(it.markerKey);
    memberItems.push({
      kind: it.kind,
      marker: it.marker,
      statement: it.memberStatement,
      why: it.memberWhy,
      reportDate: it.kind === 'change' ? it.to.date : it.reportDate
    });
  }

  if (!items.length) {
    notes.push(
      reports.length === 1
        ? 'One report on file. A second report unlocks the before-and-after comparison, which is where this becomes powerful.'
        : 'No bridgeable marker was both measured and matched by enough wearable days in its window.'
    );
  }

  return {
    ok: true,
    items,
    memberItems,
    reportsSeen: reports.length,
    reportDates: reports.map((r) => ({ id: r.id, date: r.date, isLabDate: r.isLabDate })),
    markersSeen,
    bridgedMarkers: Array.from(bridged),
    config: { windowDays: WINDOW_DAYS, minWindowDays: MIN_WINDOW_DAYS, minBaselineDays: MIN_BASELINE_DAYS, linksKnown: LINKS.length },
    notes
  };
}

module.exports = {
  buildBloodBridge,
  _internals: { LINKS, METRICS, markersOf, orderedReports, windowStats, baselineOutside, movement, movementPhrase, prettyDate, toYmd }
};
