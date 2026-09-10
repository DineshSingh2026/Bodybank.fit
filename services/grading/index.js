'use strict';

/**
 * BodyBank — GRADING ENGINE.
 *
 * Pure and side-effect free. No database, no network, no clock, no randomness and
 * no language model. The same extracted panel always produces the same grades and
 * the same rationale, which is what makes a grade defensible six months later.
 *
 *   classified markers  ──▶  gradeAreas()  ──▶  HealthAreaResult[]
 *
 * The rules themselves live in ./rules.js; this file is the machinery that applies
 * them in order and records what fired.
 *
 * ─── HOW ONE AREA IS GRADED ───────────────────────────────────────────────────
 *
 *   1. SUFFICIENCY   Minimum marker set present? No → NOT_ASSESSED, and the report
 *                    names the missing tests. An area is never graded on a guess.
 *
 *   2. DIRECTION     Each marker's deviation is checked against its favourable
 *                    direction. An LDL below range is a fact worth printing, but it
 *                    is not a cardiovascular concern, so it scores zero.
 *
 *   3. GROUPING      Unfavourable deviations are collected per correlation group,
 *                    and each group contributes only its single highest weighted
 *                    value. This is the anti-double-counting rule: Total Cholesterol
 *                    and LDL are one piece of evidence about atherogenic lipids, not
 *                    two, and Hb / Hct / RBC are one piece of evidence about red
 *                    cell mass, not three.
 *
 *   4. CEILING       The worst single marker sets a floor under the grade, so a
 *                    genuinely bad result cannot be diluted by a long panel of
 *                    normal ones.
 *
 *   5. PATTERNS      Recognised combinations apply their own floor. A pattern can
 *                    only make a grade worse, with one deliberate exception: the
 *                    isolated-TSH rule caps the grade, because a raised TSH with a
 *                    normal Free T4 does not by itself warrant the top tier of
 *                    concern. That cap stands down if anything in the area is at a
 *                    panic level.
 *
 * The final grade is the worst outcome of steps 3, 4 and 5.
 */

const {
  AREAS,
  AREA_ORDER,
  getMarker,
  weightIn
} = require('./markerRegistry');

const {
  STATUS,
  SEVERITY,
  isLowSide,
  isHighSide,
  classifyReport
} = require('./classify');

const {
  RULESET_VERSION,
  GRADE_LABEL,
  GRADE_MEANING,
  PATTERNS,
  worst,
  rank,
  checkSufficiency,
  accumulationGrade,
  ceilingFor
} = require('./rules');

const copy = require('./copy');

/** Engine stamp persisted with every generated report (brief §12.2). */
const ENGINE_VERSION = 'bb-grading@1.0.0';

/**
 * Is this marker's deviation in the direction that matters for health?
 * @returns {boolean}
 */
function isUnfavourable(marker) {
  if (!marker || !marker.gradable || marker.severity === SEVERITY.NONE) return false;
  const dir = marker.direction;
  if (dir === 'LOWER') return isHighSide(marker.status);
  if (dir === 'HIGHER') return isLowSide(marker.status);
  // RANGE, or a marker with no declared direction: either side counts.
  return true;
}

/**
 * Build the query helpers the pattern rules run against.
 * Every helper reads only gradable, non-duplicate markers.
 */
function makeQuery(byId) {
  const get = (id) => {
    const m = byId.get(id);
    return m && m.gradable && !m.duplicate ? m : null;
  };
  return {
    get,
    has: (id) => !!get(id),
    high: (id) => { const m = get(id); return !!m && isHighSide(m.status); },
    low: (id) => { const m = get(id); return !!m && isLowSide(m.status); },
    abnormalHigh: (id) => {
      const m = get(id);
      return !!m && isHighSide(m.status) && m.severity >= SEVERITY.ABNORMAL;
    },
    abnormalLow: (id) => {
      const m = get(id);
      return !!m && isLowSide(m.status) && m.severity >= SEVERITY.ABNORMAL;
    },
    value: (id) => {
      const m = get(id);
      return m && m.canonicalValue != null ? m.canonicalValue : null;
    },
    /** Does the value exceed its own upper reference bound by a factor of `x`? */
    overUpperBy: (id, x) => {
      const m = get(id);
      if (!m || m.rangeValue == null) return false;
      const hi = m.referenceRange && m.referenceRange.high;
      if (hi == null || !Number.isFinite(hi) || hi <= 0) return false;
      return m.rangeValue > hi * x;
    }
  };
}

/** Sort order for findings inside an area: worst first, then most important. */
function findingOrder(areaId) {
  return (a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    const wa = weightIn(a.markerId, areaId);
    const wb = weightIn(b.markerId, areaId);
    if (wb !== wa) return wb - wa;
    return String(a.markerId || a.displayName).localeCompare(String(b.markerId || b.displayName));
  };
}

/**
 * Grade one health area.
 * @param {string} areaId
 * @param {Map<string,object>} byId all classified markers, keyed by canonical id
 * @param {object} q pattern-rule query helpers
 * @returns {object} HealthAreaResult
 */
function gradeArea(areaId, byId, q) {
  const meta = AREAS[areaId];
  const rationale = [];

  // Markers of this area that are present AND may influence a grade.
  const gradable = [];
  const evaluated = [];
  byId.forEach((m) => {
    if (!m.markerId || m.duplicate) return;
    const w = weightIn(m.markerId, areaId);
    if (!w) return;
    evaluated.push(m);
    if (m.gradable) gradable.push(m);
  });

  const presentIds = new Set(gradable.map((m) => m.markerId));

  // ── 1. sufficiency ────────────────────────────────────────────────────────
  const suff = checkSufficiency(areaId, presentIds);
  if (!suff.met) {
    let missingNames = Array.from(new Set(suff.missing))
      .map((id) => {
        const reg = getMarker(id);
        return reg ? reg.display : null;
      })
      .filter(Boolean);
    // Some sufficiency clauses name a data source rather than a lab marker (body
    // composition is a measurement, not a blood test). Falling back to the clause
    // description keeps the "not assessed" notice from rendering an empty list.
    if (!missingNames.length && suff.describe) missingNames = [suff.describe];
    rationale.push(`SUFFICIENCY_NOT_MET: needs ${suff.describe}`);
    return {
      areaId,
      label: meta.label,
      blurb: meta.blurb,
      grade: 'NOT_ASSESSED',
      gradeLabel: GRADE_LABEL.NOT_ASSESSED,
      gradeMeaning: GRADE_MEANING.NOT_ASSESSED,
      gradeRationale: rationale,
      score: 0,
      markersEvaluated: evaluated.map((m) => m.markerId),
      markersMissing: missingNames,
      sufficiencyDescribe: suff.describe,
      summary: copy.areaSummary(
        { grade: 'NOT_ASSESSED', markersEvaluated: evaluated, keyFindings: [] },
        meta
      ),
      keyFindings: [],
      focus: '',
      patternsFired: [],
      requiresProfessional: false,
      previousGrade: null,
      trend: 'NOT_COMPARABLE',
      trendDriver: null
    };
  }
  rationale.push(`SUFFICIENCY_MET: ${suff.describe}`);

  // ── 2 & 3. direction-aware, group-capped accumulation ─────────────────────
  const groups = new Map();   // group -> best { contribution, marker }
  let ceiling = null;
  let maxSeverity = SEVERITY.NONE;
  const disregarded = [];

  gradable.forEach((m) => {
    const w = weightIn(m.markerId, areaId);
    if (m.severity === SEVERITY.NONE) return;

    if (!isUnfavourable(m)) {
      // Outside its range, but in the direction that is not a concern for health.
      disregarded.push(m);
      return;
    }

    maxSeverity = Math.max(maxSeverity, m.severity);

    const contribution = w * m.severity;
    const groupKey = m.group || m.markerId;
    const prev = groups.get(groupKey);
    if (!prev || contribution > prev.contribution) {
      groups.set(groupKey, { contribution, marker: m, weight: w });
    }

    const c = ceilingFor(m.severity, w);
    if (c) ceiling = worst(ceiling, c);
  });

  disregarded.forEach((m) => {
    rationale.push(
      `DISREGARDED: ${m.markerId}=${m.status} is a favourable-direction deviation for this area`
    );
  });

  let score = 0;
  groups.forEach((g, key) => {
    score += g.contribution;
    rationale.push(
      `SCORE ${key}: ${g.marker.markerId}=${g.marker.status} weight=${g.weight} severity=${g.marker.severity} → ${g.contribution}`
    );
  });

  // Report every group that had more than one contender, so the correlation guard
  // is visible in the audit trail rather than implied.
  const groupMembers = new Map();
  gradable.forEach((m) => {
    if (!isUnfavourable(m)) return;
    const key = m.group || m.markerId;
    groupMembers.set(key, (groupMembers.get(key) || 0) + 1);
  });
  groupMembers.forEach((n, key) => {
    if (n > 1) rationale.push(`CORRELATION_GUARD ${key}: ${n} related markers counted once`);
  });

  let grade = accumulationGrade(score);
  rationale.push(`ACCUMULATION: score=${score} → ${grade}`);

  // ── 4. ceiling ────────────────────────────────────────────────────────────
  if (ceiling) {
    const before = grade;
    grade = worst(grade, ceiling);
    if (grade !== before) rationale.push(`CEILING: worst single marker floors the grade at ${ceiling}`);
    else rationale.push(`CEILING: ${ceiling} (already met)`);
  }

  // ── 5. patterns ───────────────────────────────────────────────────────────
  const patternsFired = [];
  let capGrade = null;
  PATTERNS.forEach((p) => {
    if (p.areas.indexOf(areaId) < 0) return;
    let fired = false;
    try {
      fired = !!p.when(q);
    } catch (e) {
      fired = false; // a rule that cannot evaluate must never grade
    }
    if (!fired) return;
    patternsFired.push({ id: p.id, name: p.name, rationale: p.rationale });
    if (p.atLeast) {
      const before = grade;
      grade = worst(grade, p.atLeast);
      rationale.push(
        `PATTERN ${p.id} (${p.name}): floor ${p.atLeast}${grade !== before ? ' → applied' : ' (already met)'}`
      );
    }
    if (p.cap) capGrade = capGrade ? (rank(p.cap) < rank(capGrade) ? p.cap : capGrade) : p.cap;
  });

  // A cap only stands where nothing in the area is at a panic level.
  if (capGrade && maxSeverity < SEVERITY.CRITICAL && rank(grade) > rank(capGrade)) {
    rationale.push(`PATTERN_CAP: grade held at ${capGrade}`);
    grade = capGrade;
  } else if (capGrade && maxSeverity >= SEVERITY.CRITICAL) {
    rationale.push('PATTERN_CAP: not applied — a marker in this area is well outside its range');
  }

  rationale.push(`FINAL=${grade}`);

  // ── findings and copy ─────────────────────────────────────────────────────
  const keyFindings = evaluated
    .filter((m) => m.severity > 0 || (m.gradable && isUnfavourable(m)))
    .sort(findingOrder(areaId));

  const area = {
    areaId,
    label: meta.label,
    blurb: meta.blurb,
    grade,
    gradeLabel: GRADE_LABEL[grade],
    gradeMeaning: GRADE_MEANING[grade],
    gradeRationale: rationale,
    score,
    markersEvaluated: evaluated.map((m) => m.markerId),
    markersMissing: [],
    sufficiencyDescribe: suff.describe,
    keyFindings,
    patternsFired,
    requiresProfessional: grade === 'D' || maxSeverity >= SEVERITY.CRITICAL,
    previousGrade: null,
    trend: 'NOT_COMPARABLE',
    trendDriver: null
  };

  area.summary = copy.areaSummary(area, meta);
  area.focus = copy.areaFocus(area, meta);
  return area;
}

/**
 * Grade every health area for one report.
 * @param {object} classified output of classifyReport()
 * @returns {object[]} HealthAreaResult[] in canonical display order
 */
function gradeAreas(classified) {
  const byId = classified.byId;
  const q = makeQuery(byId);
  return AREA_ORDER.map((areaId) => gradeArea(areaId, byId, q));
}

/**
 * Classify and grade in one call.
 * @param {object} extracted extracted_blood_data
 * @param {object} opts { sex }
 */
function gradeExtractedReport(extracted, opts) {
  const classified = classifyReport(extracted, opts || {});
  const areas = gradeAreas(classified);
  // Attach the plain-English lines each marker will render with.
  classified.markers.forEach((m) => {
    m.insight = copy.markerInsight(m);
    m.nextStep = copy.markerNextStep(m);
  });
  return { classified, areas };
}

module.exports = {
  ENGINE_VERSION,
  RULESET_VERSION,
  STATUS,
  SEVERITY,
  isUnfavourable,
  makeQuery,
  gradeArea,
  gradeAreas,
  gradeExtractedReport
};
