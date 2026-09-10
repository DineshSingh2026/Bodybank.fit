'use strict';

/**
 * BodyBank — DETERMINISTIC MARKER CLASSIFICATION.
 *
 * Turns the extracted lab panels into `MarkerResult` objects with a status that
 * was computed by arithmetic, not written by a language model.
 *
 * ─── WHY THIS REPLACES THE EXTRACTED STATUS ───────────────────────────────────
 * The extraction pass asks the model to decide "Normal | Low | High | Critical",
 * and to fall back on "standard adult clinical ranges" when the lab prints none.
 * That is a clinical judgement with no audit trail: two runs can disagree, and
 * nobody can point at the arithmetic afterwards. A grade built on it would be
 * unexplainable. So the graded report derives status itself, and records where
 * each status came from:
 *
 *   DERIVED_LAB        the lab printed a reference range; we compared against it.
 *                      This is the authority and covers the large majority of rows.
 *   DERIVED_PREFERRED  no printed range, but the registry holds a BodyBank
 *                      preferred range AND the unit was recognised. Labelled as
 *                      "BodyBank preferred range" everywhere it is shown.
 *   EXTRACTED          neither was available. We show the extracted status so the
 *                      row is not blank, mark it clearly, and EXCLUDE it from
 *                      grading — it can never move a grade.
 *
 * ─── THE STATUS LADDER ────────────────────────────────────────────────────────
 *   CRITICAL_LOW / CRITICAL_HIGH   beyond a documented panic bound
 *   LOW / HIGH                     outside the reference range
 *   BORDERLINE_LOW / _HIGH         inside, but within 5 % of the boundary
 *   WITHIN_RANGE                   comfortably inside
 *   NOT_AVAILABLE                  no numeric value could be read
 *
 * ─── STATUS IS A FACT; CONCERN IS A JUDGEMENT ─────────────────────────────────
 * Status describes where the number sits relative to its range — nothing more.
 * Whether that deviation is *unfavourable* depends on the marker's direction, and
 * that decision belongs to the grading engine, not here. An LDL below its range is
 * `LOW`, and the grading engine will disregard it because lower LDL is favourable.
 * Keeping the two separate is what lets the report print an honest table while
 * still grading sensibly.
 */

const {
  parseNumericValue,
  parseReferenceRange
} = require('../bloodComparisonService');

const {
  lookupMarker,
  toCanonicalUnit,
  preferredRange
} = require('./markerRegistry');

/** Fraction of a range treated as the "borderline" band at each end. */
const BORDERLINE_FRACTION = 0.05;

const STATUS = {
  WITHIN_RANGE: 'WITHIN_RANGE',
  BORDERLINE_LOW: 'BORDERLINE_LOW',
  BORDERLINE_HIGH: 'BORDERLINE_HIGH',
  LOW: 'LOW',
  HIGH: 'HIGH',
  CRITICAL_LOW: 'CRITICAL_LOW',
  CRITICAL_HIGH: 'CRITICAL_HIGH',
  NOT_AVAILABLE: 'NOT_AVAILABLE'
};

/** Severity tier used by the grading ceilings and the priority engine. */
const SEVERITY = {
  NONE: 0,
  BORDERLINE: 1,
  ABNORMAL: 2,
  CRITICAL: 3
};

function severityOf(status) {
  switch (status) {
    case STATUS.CRITICAL_LOW:
    case STATUS.CRITICAL_HIGH:
      return SEVERITY.CRITICAL;
    case STATUS.LOW:
    case STATUS.HIGH:
      return SEVERITY.ABNORMAL;
    case STATUS.BORDERLINE_LOW:
    case STATUS.BORDERLINE_HIGH:
      return SEVERITY.BORDERLINE;
    default:
      return SEVERITY.NONE;
  }
}

function isLowSide(status) {
  return status === STATUS.LOW || status === STATUS.BORDERLINE_LOW || status === STATUS.CRITICAL_LOW;
}
function isHighSide(status) {
  return status === STATUS.HIGH || status === STATUS.BORDERLINE_HIGH || status === STATUS.CRITICAL_HIGH;
}

/**
 * Where a value sits relative to a { low?, high? } range.
 * @returns {string} one of WITHIN_RANGE / BORDERLINE_* / LOW / HIGH
 */
function statusAgainstRange(num, range) {
  const low = range && range.low != null && Number.isFinite(range.low) ? range.low : null;
  const high = range && range.high != null && Number.isFinite(range.high) ? range.high : null;
  if (low == null && high == null) return null;

  if (low != null && num < low) return STATUS.LOW;
  if (high != null && num > high) return STATUS.HIGH;

  // Inside the range — is it hugging a boundary?
  // A two-sided range measures the band against its own span, so a narrow range
  // (potassium 3.5–5.1) gets a narrow band and a wide one (platelets 150–410)
  // gets a wide one. A one-sided range has no span, so it uses the bound itself.
  const span = low != null && high != null ? high - low : null;

  if (high != null) {
    const band = span != null ? span * BORDERLINE_FRACTION : Math.abs(high) * BORDERLINE_FRACTION;
    if (band > 0 && num >= high - band) return STATUS.BORDERLINE_HIGH;
  }
  if (low != null) {
    // A lower bound of zero (basophils 0–2) has no meaningful "just above zero"
    // warning band — every healthy result would trip it.
    const band = span != null ? span * BORDERLINE_FRACTION : Math.abs(low) * BORDERLINE_FRACTION;
    if (low > 0 && band > 0 && num <= low + band) return STATUS.BORDERLINE_LOW;
  }
  return STATUS.WITHIN_RANGE;
}

/** Escalate a status to CRITICAL_* when a documented panic bound is crossed. */
function applyCritical(status, canonicalValue, critical) {
  if (!critical || canonicalValue == null) return status;
  if (critical.low != null && canonicalValue < critical.low) return STATUS.CRITICAL_LOW;
  if (critical.high != null && canonicalValue > critical.high) return STATUS.CRITICAL_HIGH;
  return status;
}

/** Map an extracted (model-written) status word onto the ladder, for display only. */
function fallbackStatusFromExtracted(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return STATUS.NOT_AVAILABLE;
  if (/critical/.test(s)) return /low|deficien/.test(s) ? STATUS.CRITICAL_LOW : STATUS.CRITICAL_HIGH;
  if (/^(high|elevated|above)/.test(s)) return STATUS.HIGH;
  if (/^(low|deficient|below|insufficien)/.test(s)) return STATUS.LOW;
  if (/borderline/.test(s)) return /low/.test(s) ? STATUS.BORDERLINE_LOW : STATUS.BORDERLINE_HIGH;
  if (/^(normal|optimal|adequate|sufficient|desirable|within)/.test(s)) return STATUS.WITHIN_RANGE;
  return STATUS.NOT_AVAILABLE;
}

/** Human-readable range, preferring exactly what the lab printed. */
function formatRange(printed, range, unit) {
  const p = String(printed == null ? '' : printed).trim();
  if (p && p !== '—' && p !== '-') return p;
  if (!range) return '';
  const u = unit ? ' ' + unit : '';
  if (range.low != null && range.high != null) return `${range.low} – ${range.high}${u}`;
  if (range.high != null) return `< ${range.high}${u}`;
  if (range.low != null) return `> ${range.low}${u}`;
  return '';
}

/**
 * Classify one extracted marker.
 *
 * @param {object} raw   { name, value, unit, reference_range|reference, status, flag }
 * @param {object} opts  { sex, panelName }
 * @returns {object} MarkerResult (see services/grading/types.js)
 */
function classifyMarker(raw, opts) {
  const options = opts || {};
  const printedName = String((raw && raw.name) || '').trim();
  const entry = lookupMarker(printedName);
  const printedUnit = String((raw && raw.unit) || '').trim();
  const printedRef = raw && raw.reference_range != null ? raw.reference_range : (raw && raw.reference) || '';

  const parsedValue = parseNumericValue(raw && raw.value);
  const labRange = parseReferenceRange(printedRef);

  const result = {
    markerId: entry ? entry.id : null,
    displayName: entry ? entry.display : (printedName || 'Unknown'),
    printedName,
    panelName: String(options.panelName || '').trim(),
    areaIds: entry ? Object.keys(entry.areas || {}) : [],
    value: parsedValue.num,
    qualifier: parsedValue.qualifier || '',
    rawValue: String((raw && raw.value) != null ? raw.value : '').trim(),
    unit: printedUnit,
    canonicalValue: null,
    canonicalUnit: entry ? entry.unit : '',
    referenceRange: {
      low: labRange ? labRange.low : undefined,
      high: labRange ? labRange.high : undefined,
      printed: formatRange(printedRef, labRange, printedUnit),
      source: labRange ? 'LAB' : null
    },
    // The value that `referenceRange` was actually compared against. When the lab
    // printed the range, that is the printed value in the printed unit; when we fell
    // back to a BodyBank preferred range, it is the canonical-unit value. Consumers
    // that want to ask "how far outside its range is this?" must use this field —
    // mixing the two is how a unit bug becomes a wrong grade.
    rangeValue: null,
    status: STATUS.NOT_AVAILABLE,
    statusSource: 'EXTRACTED',
    extractedStatus: String((raw && raw.status) || '').trim(),
    severity: SEVERITY.NONE,
    gradable: false,
    direction: entry ? entry.direction : null,
    group: entry ? entry.group : null,
    note: entry && entry.note ? entry.note : '',
    trend: 'NOT_COMPARABLE',
    previous: null,
    insight: ''
  };

  // No readable number: nothing can be derived. Qualitative results ("Negative",
  // "Nil", "Absent") land here and still print in the detailed table.
  if (parsedValue.num == null) {
    result.status = STATUS.NOT_AVAILABLE;
    result.statusSource = 'EXTRACTED';
    return result;
  }

  // Canonical value, when the unit is one we recognise for this marker. Used for
  // critical bounds, preferred ranges and cross-report comparison — never guessed.
  if (entry) {
    const conv = toCanonicalUnit(entry, parsedValue.num, printedUnit);
    if (conv) result.canonicalValue = conv.value;
  }

  // ── 1. the lab's own printed range is the authority ──────────────────────
  let status = null;
  if (labRange) {
    status = statusAgainstRange(parsedValue.num, labRange);
    if (status) {
      result.statusSource = 'DERIVED_LAB';
      result.gradable = true;
      result.rangeValue = parsedValue.num;
    }
  }

  // ── 2. fall back to a labelled BodyBank preferred range ──────────────────
  if (!status && entry && result.canonicalValue != null) {
    const pref = preferredRange(entry, options.sex);
    if (pref && (pref.low != null || pref.high != null)) {
      status = statusAgainstRange(result.canonicalValue, pref);
      if (status) {
        result.statusSource = 'DERIVED_PREFERRED';
        result.gradable = true;
        result.rangeValue = result.canonicalValue;
        result.referenceRange = {
          low: pref.low,
          high: pref.high,
          printed: formatRange('', pref, entry.unit),
          source: 'BODYBANK_PREFERRED'
        };
      }
    }
  }

  // ── 3. last resort: show what extraction said, but never grade on it ──────
  if (!status) {
    result.status = fallbackStatusFromExtracted(raw && raw.status);
    result.statusSource = 'EXTRACTED';
    result.gradable = false;
    result.severity = SEVERITY.NONE; // ungraded rows carry no severity weight
    return result;
  }

  // ── 4. critical overlay, only where we hold a canonical value ─────────────
  if (entry && result.canonicalValue != null) {
    status = applyCritical(status, result.canonicalValue, entry.critical);
  }

  result.status = status;
  result.severity = severityOf(status);
  return result;
}

/**
 * Classify every marker in an extracted report.
 *
 * Duplicate handling matters: labs repeat markers across panels (a lipid profile
 * and a "cardiac risk" panel both printing HDL), and a repeated marker graded
 * twice is the classic double-count. Only the FIRST occurrence of a canonical id
 * is gradable; later ones are kept for the detailed table with `duplicate: true`
 * so nothing is hidden from the client, and are skipped by the grading engine.
 *
 * @param {object} extracted  extracted_blood_data — { panels: [{ name, markers: [] }] }
 * @param {object} opts       { sex }
 * @returns {{ markers: object[], byId: Map<string,object>, unmapped: object[] }}
 */
function classifyReport(extracted, opts) {
  const options = opts || {};
  const panels = (extracted && Array.isArray(extracted.panels)) ? extracted.panels : [];
  const markers = [];
  const byId = new Map();
  const unmapped = [];

  panels.forEach((panel) => {
    const panelName = String((panel && panel.name) || 'Other Results').trim() || 'Other Results';
    const rows = (panel && Array.isArray(panel.markers)) ? panel.markers : [];
    rows.forEach((row) => {
      if (!row || !row.name) return;
      const m = classifyMarker(row, { sex: options.sex, panelName });
      if (!m.markerId) {
        m.duplicate = false;
        unmapped.push(m);
        markers.push(m);
        return;
      }
      if (byId.has(m.markerId)) {
        // Second sighting of the same test. Keep it visible, exclude it from grading.
        m.duplicate = true;
        m.gradable = false;
        markers.push(m);
        return;
      }
      m.duplicate = false;
      byId.set(m.markerId, m);
      markers.push(m);
    });
  });

  return { markers, byId, unmapped };
}

module.exports = {
  STATUS,
  SEVERITY,
  BORDERLINE_FRACTION,
  severityOf,
  isLowSide,
  isHighSide,
  statusAgainstRange,
  applyCritical,
  fallbackStatusFromExtracted,
  formatRange,
  classifyMarker,
  classifyReport
};
