'use strict';

/**
 * BodyBank — GRADED HEALTH REPORT MODEL.
 *
 * Assembles the typed `HealthReport` that every downstream surface renders: the
 * editable document, the PDF, the staff preview and the v2 API. Nothing below this
 * point grades, compares or prioritises — those decisions are already made by the
 * pure engines, and this file only arranges their output for reading.
 *
 *   extracted_blood_data ─┐
 *   previous extraction ──┤──▶ buildGradedHealthReport() ──▶ HealthReport
 *   client + dates       ─┤
 *   existing ai_report ──┘        (the Opus clinical pass, carried through intact)
 *
 * ─── ORDERING IS THE PRODUCT ──────────────────────────────────────────────────
 * A client gives this report about ten seconds before deciding whether it is worth
 * reading. So the order is fixed and never data-dependent in a surprising way:
 *
 *   anything at a panic level  →  Health Map  →  one framing sentence  →
 *   at most three priorities   →  area cards worst-first  →  every marker  →
 *   next steps  →  disclaimer
 *
 * Areas sort D → C → B → A so the reader meets the thing that matters first, and
 * within a grade they hold canonical order so two reports of the same shape read
 * the same way.
 *
 * ─── THE FOUR LAYERS, KEPT APART ──────────────────────────────────────────────
 * Every marker row carries RESULT, STATUS, BODYBANK INSIGHT and NEXT STEP as
 * separate fields, and the renderers are required to keep them visually distinct.
 * A measured number and an interpretation of that number must never be mistakable
 * for one another — that is the single most important rule in the whole report.
 */

const { AREAS, AREA_ORDER, getMarker, weightIn } = require('./grading/markerRegistry');
const { SEVERITY, classifyReport } = require('./grading/classify');
const grading = require('./grading');
const { pickPriorities } = require('./priority');
const comparison = require('./comparison');
const copy = require('./grading/copy');

const MODEL_VERSION = 'bb-health-report@1.0.0';

/** Client-facing name of this report variant. */
const REPORT_TITLE = 'BodyBank Health Map Report';

const GRADE_SORT = { D: 0, C: 1, B: 2, A: 3, NOT_ASSESSED: 4 };

/**
 * Which area a marker is filed under in the detailed table.
 * A shared marker appears once, under the area where it carries the most weight;
 * ties break on canonical area order so the choice is stable across renders.
 */
function primaryAreaFor(marker) {
  if (!marker.markerId || !marker.areaIds || !marker.areaIds.length) return null;
  let best = null;
  marker.areaIds.forEach((areaId) => {
    const w = weightIn(marker.markerId, areaId);
    if (!best || w > best.weight ||
      (w === best.weight && AREA_ORDER.indexOf(areaId) < AREA_ORDER.indexOf(best.areaId))) {
      best = { areaId, weight: w };
    }
  });
  return best ? best.areaId : null;
}

/** Format one marker's RESULT string: value, unit, and the range it was judged against. */
function resultLine(marker) {
  const reg = getMarker(marker.markerId);
  const decimals = reg && reg.decimals != null ? reg.decimals : null;
  let shown;
  if (marker.value != null && decimals != null) {
    shown = `${marker.qualifier || ''}${Number(marker.value).toFixed(decimals)}`;
  } else {
    shown = marker.rawValue || '—';
  }
  return marker.unit ? `${shown} ${marker.unit}` : shown;
}

/** The reference-range string plus an explicit note when it is BodyBank's, not the lab's. */
function rangeLine(marker) {
  const r = marker.referenceRange || {};
  if (!r.printed) return { text: '—', source: null };
  return {
    text: r.printed,
    source: r.source,
    label: r.source === 'BODYBANK_PREFERRED' ? 'BodyBank preferred range' : 'Lab reference range'
  };
}

/** Build the full marker table, grouped by area, with unmapped results last. */
function buildMarkerTable(classified) {
  const groups = new Map();
  AREA_ORDER.forEach((areaId) => {
    groups.set(areaId, { areaId, label: AREAS[areaId].label, markers: [] });
  });
  const other = { areaId: 'OTHER', label: 'Other Results', markers: [] };

  classified.markers.forEach((m) => {
    const row = {
      markerId: m.markerId,
      displayName: m.displayName,
      printedName: m.printedName,
      panelName: m.panelName,
      result: resultLine(m),
      value: m.value,
      unit: m.unit,
      range: rangeLine(m),
      status: m.status,
      statusLabel: copy.STATUS_LABEL[m.status],
      statusMark: copy.STATUS_MARK[m.status],
      statusSource: m.statusSource,
      severity: m.severity,
      duplicate: !!m.duplicate,
      insight: m.insight || '',
      nextStep: m.nextStep || '',
      note: m.note || '',
      trend: m.trend || 'NOT_COMPARABLE',
      trendLabel: copy.TREND_LABEL[m.trend || 'NOT_COMPARABLE'],
      delta: m.delta != null ? m.delta : null,
      deltaPct: m.deltaPct != null ? m.deltaPct : null,
      previous: m.previous || null
    };
    const areaId = primaryAreaFor(m);
    if (areaId && groups.has(areaId)) groups.get(areaId).markers.push(row);
    else other.markers.push(row);
  });

  const ordered = AREA_ORDER
    .map((id) => groups.get(id))
    .filter((g) => g.markers.length > 0);
  if (other.markers.length) ordered.push(other);
  return ordered;
}

/**
 * One finding as it appears on a health-area card.
 *
 * The grading engine leaves `keyFindings` as raw MarkerResult objects, because that
 * is what the rules operate on. Renderers need the four presentation layers already
 * separated — RESULT, STATUS, INSIGHT, NEXT STEP — so they are built here, once, and
 * every surface reads the same strings.
 */
function findingRow(marker) {
  return {
    markerId: marker.markerId,
    displayName: marker.displayName,
    result: resultLine(marker),
    range: rangeLine(marker),
    status: marker.status,
    statusLabel: copy.STATUS_LABEL[marker.status],
    statusMark: copy.STATUS_MARK[marker.status],
    statusSource: marker.statusSource,
    severity: marker.severity,
    insight: marker.insight || '',
    nextStep: marker.nextStep || '',
    note: marker.note || '',
    trend: marker.trend || 'NOT_COMPARABLE',
    trendLabel: copy.TREND_LABEL[marker.trend || 'NOT_COMPARABLE'],
    delta: marker.delta != null ? marker.delta : null,
    deltaPct: marker.deltaPct != null ? marker.deltaPct : null,
    previous: marker.previous || null
  };
}

/**
 * Markers sitting well outside their range, surfaced above everything else.
 * Ordered by clinical weight so the most consequential one leads.
 */
function collectCriticalFindings(classified) {
  const out = [];
  classified.byId.forEach((m) => {
    if (m.duplicate || !m.gradable) return;
    if (m.severity < SEVERITY.CRITICAL) return;
    if (!grading.isUnfavourable(m)) return;
    out.push({
      markerId: m.markerId,
      displayName: m.displayName,
      result: resultLine(m),
      range: rangeLine(m),
      statusLabel: copy.STATUS_LABEL[m.status],
      insight: m.insight,
      nextStep: copy.PROFESSIONAL_LINE
    });
  });
  out.sort((a, b) => String(a.markerId).localeCompare(String(b.markerId)));
  return out;
}

/**
 * Three to five next steps: professional review where indicated, then the actions
 * behind the priorities, then a retest date. Never padded past what the data supports.
 */
function buildNextSteps(areas, priorities, criticalFindings, aiReport) {
  const steps = [];
  const seen = new Set();
  const push = (text, opts) => {
    const key = String(text).toLowerCase();
    if (!text || seen.has(key) || steps.length >= 5) return;
    seen.add(key);
    steps.push(Object.assign({ text }, opts || {}));
  };

  const dAreas = areas.filter((a) => a.grade === 'D');
  if (criticalFindings.length || dAreas.length) {
    const names = dAreas.map((a) => a.label);
    const what = criticalFindings.length
      ? 'the results flagged at the top of this report'
      : `your ${names.join(' and ')} results`;
    push(
      `Book time with your healthcare professional to review ${what}. Take this report with you.`,
      { requiresProfessional: true, priority: true }
    );
  }

  // Every priority contributes its action, including the ones that also need a
  // professional. Skipping those would leave a client whose findings all sit in a
  // grade-D area with a single instruction — book an appointment — and nothing to
  // do in the weeks before it. The referral and the lifestyle lever are both steps.
  priorities.forEach((p) => {
    if (!p.nextStep || p.nextStep === copy.PROFESSIONAL_LINE) return;
    push(p.nextStep, { areaId: p.areaId, markerId: p.markerId });
  });

  // Retest timing: reuse the clinical pass's schedule when it produced one, so the
  // graded report and the clinical narrative never contradict each other.
  const schedule = aiReport && Array.isArray(aiReport.retest_schedule) ? aiReport.retest_schedule : [];
  if (schedule.length) {
    const first = schedule[0];
    if (first && first.test && first.when) {
      push(`Retest ${first.test} ${String(first.when).toLowerCase()} to confirm the change.`, { retest: true });
    }
  } else if (priorities.length) {
    push('Repeat this panel in about three months so the next report can show your trend.', { retest: true });
  }

  if (!steps.length) {
    push('Repeat this panel at your next annual screening to keep the trend going.', { retest: true });
  }
  return steps;
}

/** Grade counts for the Health Map header. */
function summarise(areas) {
  const assessed = areas.filter((a) => a.grade !== 'NOT_ASSESSED');
  return {
    assessed: assessed.length,
    notAssessed: areas.length - assessed.length,
    A: assessed.filter((a) => a.grade === 'A').length,
    B: assessed.filter((a) => a.grade === 'B').length,
    C: assessed.filter((a) => a.grade === 'C').length,
    D: assessed.filter((a) => a.grade === 'D').length
  };
}

/**
 * Build the complete graded health report.
 *
 * @param {object} input
 *   @param {object} input.extracted        current extracted_blood_data (required)
 *   @param {object} [input.previous]       { extracted, date } — the prior screening
 *   @param {object} input.client           { name, age, sex, goal }
 *   @param {string} input.screeningDate    lab draw date, 'YYYY-MM-DD'
 *   @param {string} input.reportId
 *   @param {object} [input.aiReport]       the existing Opus clinical analysis
 * @returns {object} HealthReport
 */
function buildGradedHealthReport(input) {
  const opts = input || {};
  const client = opts.client || {};
  const sex = client.sex || client.gender || '';

  const { classified, areas } = grading.gradeExtractedReport(opts.extracted, { sex });

  // Trends, when there is a genuine previous screening. Never fabricated.
  let progress = null;
  let hasPrevious = false;
  if (opts.previous && opts.previous.extracted) {
    const prevClassified = classifyReport(opts.previous.extracted, { sex });
    const prevAreas = grading.gradeAreas(prevClassified);
    progress = comparison.buildProgress(
      { areas, classified, date: opts.screeningDate },
      { areas: prevAreas, classified: prevClassified, date: opts.previous.date }
    );
    hasPrevious = true;
    // Each card explains its own movement, not just its grade delta.
    areas.forEach((ar) => { ar.trendLine = copy.areaTrendLine(ar); });
  }

  // Priorities are picked AFTER trends are attached, so an unfavourable trend can
  // break a tie between two otherwise equal findings (brief §8 rule 4).
  const priorities = pickPriorities(areas, classified.byId);

  // Turn each area's raw findings into render-ready rows. Done after trends are
  // attached so a card can show "182 → 158" without asking the renderer to look
  // anything up.
  areas.forEach((a) => { a.keyFindings = (a.keyFindings || []).map(findingRow); });

  const assessed = areas.filter((a) => a.grade !== 'NOT_ASSESSED');
  const notAssessed = areas.filter((a) => a.grade === 'NOT_ASSESSED');

  const healthMap = assessed
    .slice()
    .sort((a, b) => {
      const g = GRADE_SORT[a.grade] - GRADE_SORT[b.grade];
      if (g !== 0) return g;
      return AREA_ORDER.indexOf(a.areaId) - AREA_ORDER.indexOf(b.areaId);
    });

  const criticalFindings = collectCriticalFindings(classified);

  return {
    reportTitle: REPORT_TITLE,
    reportId: opts.reportId || '',
    variant: 'graded',
    client: {
      name: client.name || 'Member',
      age: client.age || '',
      sex: client.sex || client.gender || '',
      goal: client.goal || ''
    },
    screeningDate: opts.screeningDate || '',

    criticalFindings,

    healthMap,
    healthMapSummary: summarise(areas),
    keyMessage: copy.keyMessage(areas),

    priorities,

    // Full drill-downs, worst first — the order the client should read them in.
    areas: healthMap,
    notAssessed: notAssessed.map((a) => ({
      areaId: a.areaId,
      label: a.label,
      needs: a.sufficiencyDescribe,
      missing: a.markersMissing
    })),

    markerGroups: buildMarkerTable(classified),
    markerCount: classified.markers.length,
    unmappedCount: classified.unmapped.length,

    progress,
    hasPrevious,
    firstScreeningNote: hasPrevious
      ? ''
      : 'First screening — trends will appear on your next report.',

    nextSteps: buildNextSteps(areas, priorities, criticalFindings, opts.aiReport),

    // The existing clinical pass, carried through untouched so the graded report
    // can render it as later sections without re-running or re-writing it.
    clinical: opts.aiReport || null,

    disclaimer: copy.DISCLAIMER,
    engineVersion: grading.ENGINE_VERSION,
    rulesetVersion: grading.RULESET_VERSION,
    modelVersion: MODEL_VERSION
  };
}

module.exports = {
  MODEL_VERSION,
  REPORT_TITLE,
  buildGradedHealthReport,
  primaryAreaFor,
  buildMarkerTable,
  findingRow,
  collectCriticalFindings,
  buildNextSteps,
  resultLine,
  rangeLine,
  summarise
};
