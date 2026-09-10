'use strict';

/**
 * BodyBank — PRIORITY ENGINE.
 *
 * Chooses at most three things for the client to act on, out of a panel that may
 * carry sixty markers and a dozen abnormalities.
 *
 * Pure and deterministic: the same report always produces the same three cards in
 * the same order. That matters more than it sounds — a client who opens the report
 * twice, or a coach who regenerates it, must not see the priorities reshuffle.
 *
 * ─── THE ORDER, AND WHY ───────────────────────────────────────────────────────
 *
 *   1. Anything in an area graded D          a result that needs a professional
 *                                            always outranks one that needs a diet
 *                                            change, regardless of how large the
 *                                            numbers are.
 *   2. Severity tier                         well outside range beats outside range
 *                                            beats borderline.
 *   3. Clinical weight in its area           LDL outranks total cholesterol; eGFR
 *                                            outranks urea; HbA1c outranks a single
 *                                            fasting glucose.
 *   4. An unfavourable trend                 something that got worse since last
 *                                            time outranks something that held.
 *   5. Actionability                         a finding with a clear lifestyle lever
 *                                            is more useful on a card than one whose
 *                                            only answer is "see your doctor" —
 *                                            which is already covered by rule 1.
 *   6. Canonical marker id, ascending        the deterministic tie-break.
 *
 * ─── NO TWO CARDS FROM ONE FINDING ────────────────────────────────────────────
 * Total cholesterol and LDL would otherwise take two of the three slots and say the
 * same thing twice. Candidates are de-duplicated by correlation group, so the
 * strongest member of a group takes the slot and the rest step aside. The full
 * picture is still in the area card and the lab table.
 *
 * ─── NEVER PAD ────────────────────────────────────────────────────────────────
 * If a report has one qualifying finding it produces one card. Inventing a second
 * "priority" out of a within-range marker would teach clients that the section is
 * decoration.
 */

const { weightIn, getMarker } = require('../grading/markerRegistry');
const { SEVERITY } = require('../grading/classify');
const { isUnfavourable } = require('../grading');
const copy = require('../grading/copy');

const MAX_PRIORITIES = 3;

/** Trends that mean "this moved the wrong way". */
const UNFAVOURABLE_TRENDS = ['NEEDS_ATTENTION', 'NEW_FINDING'];

/**
 * Pick the area a marker should be attributed to on its priority card.
 * A shared marker (triglycerides, hs-CRP) belongs to more than one area; the card
 * names the area where it carries the most clinical weight, and where the areas
 * tie, the one with the worse grade — because that is the conversation that matters.
 */
function homeAreaFor(marker, areasById) {
  let best = null;
  (marker.areaIds || []).forEach((areaId) => {
    const area = areasById.get(areaId);
    if (!area || area.grade === 'NOT_ASSESSED') return;
    const w = weightIn(marker.markerId, areaId);
    if (!best) { best = { area, weight: w }; return; }
    if (w > best.weight) { best = { area, weight: w }; return; }
    if (w === best.weight && gradeRank(area.grade) > gradeRank(best.area.grade)) {
      best = { area, weight: w };
    }
  });
  return best;
}

function gradeRank(g) {
  return ['A', 'B', 'C', 'D'].indexOf(g);
}

/** Does this marker come with a real lifestyle lever, rather than only a referral? */
function isActionable(marker) {
  const c = copy.MARKER_COPY[marker.markerId];
  return !!(c && c.act && c.act !== copy.PROFESSIONAL_LINE);
}

/** "142 mg/dL (preferred < 100)" — the RESULT line on the card. */
function formatResult(marker) {
  const reg = getMarker(marker.markerId);
  const decimals = reg && reg.decimals != null ? reg.decimals : 1;
  const shownValue = marker.value != null
    ? `${marker.qualifier || ''}${Number(marker.value).toFixed(decimals)}`
    : marker.rawValue;
  const unit = marker.unit ? ` ${marker.unit}` : '';

  const r = marker.referenceRange || {};
  let rangeText = '';
  if (r.printed) {
    rangeText = r.source === 'BODYBANK_PREFERRED'
      ? ` (BodyBank preferred ${r.printed})`
      : ` (reference ${r.printed})`;
  }
  return `${shownValue}${unit}${rangeText}`;
}

/** Title: an action, not a label. "Bring LDL cholesterol down". */
function titleFor(marker) {
  const name = marker.displayName;
  const dir = marker.direction;
  const high = String(marker.status || '').indexOf('HIGH') >= 0;

  if (dir === 'RANGE') return `Bring ${name} into range`;
  if (high) return `Bring ${name} down`;
  return `Bring ${name} up`;
}

/**
 * Build the priority list for a graded report.
 *
 * @param {object[]} areas   HealthAreaResult[] from the grading engine
 * @param {Map<string,object>} byId classified markers by canonical id
 * @returns {object[]} Priority[] — at most three, ranked
 */
function pickPriorities(areas, byId) {
  const areasById = new Map(areas.map((a) => [a.areaId, a]));
  const candidates = [];

  byId.forEach((m) => {
    if (!m.markerId || m.duplicate || !m.gradable) return;
    if (m.severity === SEVERITY.NONE) return;
    if (!isUnfavourable(m)) return;      // favourable-direction deviations are not priorities

    const home = homeAreaFor(m, areasById);
    if (!home) return;                   // marker's only areas were NOT_ASSESSED

    candidates.push({
      marker: m,
      area: home.area,
      weight: home.weight,
      isD: home.area.grade === 'D' ? 1 : 0,
      severity: m.severity,
      trendBad: UNFAVOURABLE_TRENDS.indexOf(m.trend) >= 0 ? 1 : 0,
      actionable: isActionable(m) ? 1 : 0
    });
  });

  candidates.sort((a, b) => {
    if (b.isD !== a.isD) return b.isD - a.isD;
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.trendBad !== a.trendBad) return b.trendBad - a.trendBad;
    if (b.actionable !== a.actionable) return b.actionable - a.actionable;
    return String(a.marker.markerId).localeCompare(String(b.marker.markerId));
  });

  const usedGroups = new Set();
  const perArea = new Map();

  // Two passes. The first respects a soft cap of two cards per health area, so a
  // single bad lipid panel cannot take all three slots and leave a low ferritin or a
  // raised liver enzyme unmentioned. The second pass fills any slot the cap left
  // empty, which is what makes the cap soft: a report whose only findings are in one
  // area still gets three cards.
  const chosen = [];
  const take = (c) => {
    const groupKey = c.marker.group || c.marker.markerId;
    usedGroups.add(groupKey);
    perArea.set(c.area.areaId, (perArea.get(c.area.areaId) || 0) + 1);
    chosen.push(c);
  };
  const eligible = (c) => !usedGroups.has(c.marker.group || c.marker.markerId);

  for (let i = 0; i < candidates.length && chosen.length < MAX_PRIORITIES; i += 1) {
    const c = candidates[i];
    if (!eligible(c)) continue;                            // same finding, different name
    if ((perArea.get(c.area.areaId) || 0) >= 2) continue;   // soft per-area cap
    take(c);
  }
  for (let i = 0; i < candidates.length && chosen.length < MAX_PRIORITIES; i += 1) {
    const c = candidates[i];
    if (!eligible(c)) continue;
    take(c);
  }

  return chosen.map((c, i) => {
    const requiresProfessional = c.area.grade === 'D' || c.marker.severity >= SEVERITY.CRITICAL;
    return {
      rank: i + 1,
      title: titleFor(c.marker),
      areaId: c.area.areaId,
      areaLabel: c.area.label,
      markerId: c.marker.markerId,
      grade: c.area.grade,
      gradeLabel: c.area.gradeLabel,
      whyItMatters: copy.priorityWhy(c.marker),
      result: formatResult(c.marker),
      status: c.marker.status,
      statusLabel: copy.STATUS_LABEL[c.marker.status],
      trend: c.marker.trend,
      // The professional flag is shown ALONGSIDE the next step, never instead of it.
      // Replacing it would strip the one actionable line off exactly the cards that
      // matter most, and leave three identical "see your doctor" messages.
      nextStep: copy.markerNextStep(c.marker),
      requiresProfessional,
      professionalNote: requiresProfessional ? copy.PROFESSIONAL_LINE : ''
    };
  });
}

module.exports = {
  MAX_PRIORITIES,
  pickPriorities,
  homeAreaFor,
  isActionable,
  formatResult,
  titleFor
};
