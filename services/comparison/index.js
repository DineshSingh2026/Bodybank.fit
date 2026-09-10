'use strict';

/**
 * BodyBank — COMPARISON ENGINE (graded report).
 *
 * Answers "what actually changed since last time", for one marker and for one
 * health area. Pure and deterministic.
 *
 * This is a SEPARATE engine from services/bloodComparisonService.js, which powers
 * the existing progress report and is left exactly as it is. The difference that
 * justifies a second engine is the one below.
 *
 * ─── CLINICAL SIGNIFICANCE: THE POINT OF THIS FILE ────────────────────────────
 * Every lab value moves between draws even when nothing about the person changed —
 * analytical variation in the assay, and biological variation within the individual.
 * An engine that calls any downward movement "Improved" will tell a client their
 * cholesterol improved when it did not, and that is worse than saying nothing.
 *
 * So each marker declares a significance threshold in the registry (`sig`), and a
 * change must CLEAR EVERY DEFINED BAR before it is called anything but noise. LDL
 * carries `{ abs: 10, pct: 10 }`, so 200 → 190 mg/dL clears the absolute bar but is
 * only a 5 % move — inside normal variation — and is reported as
 * NO_SIGNIFICANT_CHANGE, not as an improvement.
 *
 * Requiring both bars is deliberately more conservative than requiring either. It
 * means BodyBank occasionally under-claims a real improvement rather than routinely
 * over-claiming one. The thresholds themselves are listed for clinical review in
 * docs/health-report-redesign/METHODOLOGY.md.
 *
 * ─── DIRECTION IS PER MARKER ──────────────────────────────────────────────────
 * Falling LDL is an improvement. Falling HDL is not. Falling TSH is neither until
 * you know which side of the range it started on. The registry's `direction` field
 * decides, and RANGE markers are judged by whether they moved toward their range.
 *
 * ─── WHAT THIS ENGINE WILL NOT DO ─────────────────────────────────────────────
 *   • Invent a previous value. No prior report means no progress report.
 *   • Convert between units it does not recognise. Unknown units are NOT_COMPARABLE.
 *   • Compare Urea against BUN. They are separate markers by design.
 */

const { getMarker, normalizeUnit, weightIn, AREAS } = require('../grading/markerRegistry');
const { SEVERITY } = require('../grading/classify');
const { isUnfavourable } = require('../grading');
const { rank } = require('../grading/rules');

const TREND = {
  IMPROVED: 'IMPROVED',
  STABLE: 'STABLE',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
  NEW_FINDING: 'NEW_FINDING',
  RESOLVED: 'RESOLVED',
  NO_SIGNIFICANT_CHANGE: 'NO_SIGNIFICANT_CHANGE',
  NOT_COMPARABLE: 'NOT_COMPARABLE'
};

/** Screenings closer together than this are flagged — many markers cannot move yet. */
const SHORT_INTERVAL_DAYS = 28;

/** Fallback threshold for a marker with no declared `sig`: a 10 % move. */
const DEFAULT_SIG = { pct: 10 };

/**
 * Pick a pair of values that can honestly be subtracted.
 * Prefers canonical-unit values (so mmol/L vs mg/dL compares correctly); falls back
 * to raw values only when both reports printed the same unit.
 * @returns {{ cur:number, prev:number, unit:string }|null}
 */
function comparablePair(cur, prev) {
  if (!cur || !prev) return null;
  if (cur.canonicalValue != null && prev.canonicalValue != null) {
    return { cur: cur.canonicalValue, prev: prev.canonicalValue, unit: cur.canonicalUnit || '' };
  }
  if (cur.value == null || prev.value == null) return null;
  const cu = normalizeUnit(cur.unit);
  const pu = normalizeUnit(prev.unit);
  if (cu !== pu) return null;   // a unit we cannot reconcile is never guessed
  return { cur: cur.value, prev: prev.value, unit: cur.unit || '' };
}

/** Does this change clear every threshold the marker declares? */
function isSignificant(markerId, delta, prevValue) {
  const reg = getMarker(markerId);
  const sig = (reg && reg.sig) || DEFAULT_SIG;
  const abs = Math.abs(delta);

  if (sig.abs != null && abs < sig.abs) return false;
  if (sig.pct != null) {
    const base = Math.abs(prevValue);
    if (base === 0) return sig.abs != null ? abs >= sig.abs : false;
    if ((abs / base) * 100 < sig.pct) return false;
  }
  // A marker declaring neither bar would otherwise call every wobble significant.
  if (sig.abs == null && sig.pct == null) return false;
  return true;
}

/** How far a value sits outside a { low, high } range. 0 = inside. */
function deviation(value, range) {
  if (value == null || !range) return null;
  if (range.low != null && value < range.low) return range.low - value;
  if (range.high != null && value > range.high) return value - range.high;
  return 0;
}

/**
 * Was this movement in the favourable direction?
 * @returns {boolean|null} null when direction cannot be determined
 */
function isFavourableMove(marker, delta) {
  if (delta === 0) return null;
  const dir = marker.direction;
  if (dir === 'LOWER') return delta < 0;
  if (dir === 'HIGHER') return delta > 0;

  // RANGE: favourable means "moved toward the range". Needs a usable range on both
  // sides of the comparison, which is why this is checked by the caller instead.
  return null;
}

/**
 * Compare one marker against its previous reading.
 * @param {object} cur  current MarkerResult
 * @param {object} prev previous MarkerResult, or null
 * @returns {object} { trend, delta, deltaPct, previous }
 */
function compareMarker(cur, prev) {
  const out = {
    trend: TREND.NOT_COMPARABLE, delta: null, deltaPct: null, previous: null,
    // Two very different things both read as "New Finding": a marker the previous
    // lab simply did not run, and a marker that was fine last time and is not now.
    // The renderer needs to tell the client which one this is.
    newReason: null
  };
  if (!cur) return out;

  const curFlagged = cur.gradable && cur.severity > SEVERITY.NONE && isUnfavourable(cur);

  // No previous reading at all. A newly measured marker that is already outside its
  // range is genuinely new information; one that is fine has nothing to say yet.
  if (!prev || prev.value == null) {
    if (curFlagged) { out.trend = TREND.NEW_FINDING; out.newReason = 'FIRST_MEASURED'; }
    return out;
  }

  out.previous = {
    value: prev.value,
    rawValue: prev.rawValue,
    unit: prev.unit,
    status: prev.status,
    severity: prev.severity
  };

  const pair = comparablePair(cur, prev);
  if (!pair) {
    // We know there was a previous reading, we just cannot subtract it honestly.
    out.trend = TREND.NOT_COMPARABLE;
    return out;
  }

  const delta = pair.cur - pair.prev;
  out.delta = Number(delta.toFixed(4));
  out.deltaPct = pair.prev !== 0
    ? Number(((delta / Math.abs(pair.prev)) * 100).toFixed(1))
    : null;

  const prevFlagged = prev.gradable && prev.severity > SEVERITY.NONE && isUnfavourable(prev);

  // Crossing the boundary in either direction is reportable regardless of size:
  // the client's situation changed even if the number moved only a little.
  if (prevFlagged && !curFlagged) { out.trend = TREND.RESOLVED; return out; }
  if (!prevFlagged && curFlagged) {
    out.trend = TREND.NEW_FINDING;
    out.newReason = 'MOVED_OUT_OF_RANGE';
    return out;
  }

  const significant = isSignificant(cur.markerId, delta, pair.prev);

  if (!significant) {
    // Distinguish "nothing happened" from "the label moved but the number barely
    // did" — the second is worth a different word, so nobody over-reads a status
    // flip caused by a value sitting on a boundary.
    out.trend = cur.status === prev.status ? TREND.STABLE : TREND.NO_SIGNIFICANT_CHANGE;
    return out;
  }

  let favourable = isFavourableMove(cur, delta);

  if (favourable == null) {
    // RANGE marker: judge by whether it moved toward its reference range.
    const range = cur.referenceRange && (cur.referenceRange.low != null || cur.referenceRange.high != null)
      ? { low: cur.referenceRange.low, high: cur.referenceRange.high }
      : null;
    const dCur = deviation(pair.cur, range);
    const dPrev = deviation(pair.prev, range);
    if (dCur != null && dPrev != null) {
      if (dCur < dPrev) favourable = true;
      else if (dCur > dPrev) favourable = false;
      else favourable = null;
    }
  }

  if (favourable === true) out.trend = TREND.IMPROVED;
  else if (favourable === false) out.trend = TREND.NEEDS_ATTENTION;
  else out.trend = TREND.NO_SIGNIFICANT_CHANGE;

  return out;
}

/**
 * Attach trends to every current marker, in place.
 * @param {Map<string,object>} curById
 * @param {Map<string,object>} prevById
 */
function applyMarkerTrends(curById, prevById) {
  curById.forEach((m) => {
    if (!m.markerId) return;
    const prev = prevById ? prevById.get(m.markerId) : null;
    const cmp = compareMarker(m, prev || null);
    m.trend = cmp.trend;
    m.delta = cmp.delta;
    m.deltaPct = cmp.deltaPct;
    m.previous = cmp.previous;
    m.newReason = cmp.newReason;
  });
}

/**
 * Area-level trend: the grade delta, plus the single marker most responsible.
 *
 * "Most responsible" is the marker whose weighted contribution to the area score
 * changed most between the two reports — which is exactly the quantity the grade
 * was computed from, so the driver always explains the grade rather than merely
 * correlating with it.
 */
function compareAreas(curAreas, prevAreas, curById, prevById) {
  const prevByArea = new Map((prevAreas || []).map((a) => [a.areaId, a]));

  curAreas.forEach((area) => {
    const prev = prevByArea.get(area.areaId);
    if (!prev || prev.grade === 'NOT_ASSESSED' || area.grade === 'NOT_ASSESSED') {
      // A previous screening that could not grade this area is not a previous
      // grade — showing 'was Not Assessed' next to an A reads as a downgrade.
      area.previousGrade = null;
      area.trend = TREND.NOT_COMPARABLE;
      area.trendDriver = null;
      return;
    }

    area.previousGrade = prev.grade;
    const r = rank(area.grade) - rank(prev.grade);
    if (r < 0) area.trend = TREND.IMPROVED;
    else if (r > 0) area.trend = TREND.NEEDS_ATTENTION;
    else area.trend = TREND.STABLE;

    // Contribution = weight × severity, the same quantity the grade was built from.
    let driver = null;
    let driverShift = 0;
    curById.forEach((m) => {
      if (!m.markerId || m.duplicate) return;
      const w = weightIn(m.markerId, area.areaId);
      if (!w) return;
      const p = prevById ? prevById.get(m.markerId) : null;
      const now = (m.gradable && isUnfavourable(m)) ? w * m.severity : 0;
      const was = (p && p.gradable && isUnfavourable(p)) ? w * p.severity : 0;
      const shift = Math.abs(now - was);
      if (shift > driverShift) { driverShift = shift; driver = m; }
    });

    area.trendDriver = driver
      ? { markerId: driver.markerId, displayName: driver.displayName, trend: driver.trend }
      : null;

    // A grade is a coarse instrument: LDL can fall 24 mg/dL and the area can still
    // be graded D. Reporting only the grade delta would tell that client their work
    // achieved nothing. These counts let the card say "grade unchanged, and LDL
    // improved" — honest about both halves.
    const movement = { improved: 0, needsAttention: 0, resolved: 0, newFindings: 0 };
    const movedMarkers = [];
    curById.forEach((m) => {
      if (!m.markerId || m.duplicate) return;
      if (!weightIn(m.markerId, area.areaId)) return;
      if (m.trend === TREND.IMPROVED) { movement.improved += 1; movedMarkers.push(m); }
      else if (m.trend === TREND.NEEDS_ATTENTION) { movement.needsAttention += 1; movedMarkers.push(m); }
      else if (m.trend === TREND.RESOLVED) { movement.resolved += 1; movedMarkers.push(m); }
      else if (m.trend === TREND.NEW_FINDING) { movement.newFindings += 1; movedMarkers.push(m); }
    });
    area.movement = movement;
    area.movedMarkers = movedMarkers
      .sort((a, b) => weightIn(b.markerId, area.areaId) - weightIn(a.markerId, area.areaId) ||
        String(a.markerId).localeCompare(String(b.markerId)))
      .map((m) => ({
        markerId: m.markerId,
        displayName: m.displayName,
        trend: m.trend,
        previous: m.previous ? m.previous.value : null,
        current: m.value,
        unit: m.unit
      }));
  });
}

/** Whole days between two dates, ignoring time-of-day. */
function daysBetween(aDate, bDate) {
  const a = toDate(aDate);
  const b = toDate(bDate);
  if (!a || !b) return null;
  return Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
}

/**
 * Parse a report date without a timezone dragging it onto the previous day.
 * A pg DATE column arrives here as the string 'YYYY-MM-DD'.
 */
function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v == null ? '' : v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Group every compared marker into the buckets the Progress Summary renders.
 * @returns {{improved:[], needsAttention:[], stable:[], newFindings:[], resolved:[]}}
 */
function groupByTrend(curById) {
  const buckets = { improved: [], needsAttention: [], stable: [], newFindings: [], resolved: [] };
  curById.forEach((m) => {
    switch (m.trend) {
      case TREND.IMPROVED: buckets.improved.push(m); break;
      case TREND.NEEDS_ATTENTION: buckets.needsAttention.push(m); break;
      case TREND.NEW_FINDING: buckets.newFindings.push(m); break;
      case TREND.RESOLVED: buckets.resolved.push(m); break;
      case TREND.STABLE:
      case TREND.NO_SIGNIFICANT_CHANGE:
        buckets.stable.push(m); break;
      default: break;
    }
  });
  // Stable order everywhere: most clinically weighty first, then alphabetical.
  const order = (a, b) => {
    const wa = Math.max.apply(null, (a.areaIds || []).map((x) => weightIn(a.markerId, x)).concat([0]));
    const wb = Math.max.apply(null, (b.areaIds || []).map((x) => weightIn(b.markerId, x)).concat([0]));
    if (wb !== wa) return wb - wa;
    return String(a.markerId).localeCompare(String(b.markerId));
  };
  Object.keys(buckets).forEach((k) => buckets[k].sort(order));
  return buckets;
}

/**
 * Full progress comparison between two graded reports.
 *
 * @param {object} current  { areas, classified, date }
 * @param {object} previous { areas, classified, date }
 * @returns {object} progress model
 */
function buildProgress(current, previous) {
  applyMarkerTrends(current.classified.byId, previous.classified.byId);
  compareAreas(current.areas, previous.areas, current.classified.byId, previous.classified.byId);

  const intervalDays = daysBetween(previous.date, current.date);
  const buckets = groupByTrend(current.classified.byId);

  const areasCompared = current.areas.filter((a) => a.trend !== TREND.NOT_COMPARABLE);

  return {
    currentDate: current.date,
    previousDate: previous.date,
    intervalDays,
    shortInterval: intervalDays != null && intervalDays < SHORT_INTERVAL_DAYS,
    shortIntervalNote: 'Short interval between screenings — some changes may not be meaningful yet.',
    areas: current.areas,
    areasImproved: areasCompared.filter((a) => a.trend === TREND.IMPROVED).length,
    areasStable: areasCompared.filter((a) => a.trend === TREND.STABLE).length,
    areasNeedingAttention: areasCompared.filter((a) => a.trend === TREND.NEEDS_ATTENTION).length,
    improved: buckets.improved,
    needsAttention: buckets.needsAttention,
    stable: buckets.stable,
    newFindings: buckets.newFindings,
    resolved: buckets.resolved
  };
}

module.exports = {
  TREND,
  SHORT_INTERVAL_DAYS,
  DEFAULT_SIG,
  AREAS,
  comparablePair,
  isSignificant,
  deviation,
  isFavourableMove,
  compareMarker,
  applyMarkerTrends,
  compareAreas,
  groupByTrend,
  daysBetween,
  buildProgress
};
