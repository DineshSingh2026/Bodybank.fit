'use strict';

/**
 * Whoop adapter — the reference implementation of the universal contract.
 *
 * This is a THIN SHIM over the existing, production-proven
 * services/wearables/whoopParser.js. That parser is not modified: it already
 * satisfies rules 1-5 of the contract, and rewriting a module that has been
 * correctly ingesting member data would be a gratuitous risk. What it predates is
 * rule 6 — the provenance tags multi-device support requires — so this shim adds
 * them and nothing else.
 *
 * Concretely it:
 *   - starts every day from `canonicalDay.emptyCanonicalDay()` so fields the Whoop
 *     parser never emits (steps, readinessScore, skinTempDeviationC, ...) are
 *     present as null rather than `undefined`, which the contract validator
 *     rejects and which would serialise to SQL NULL only by accident;
 *   - tags `hrvMethod = 'rmssd_sleep'`, because Whoop reports RMSSD averaged over
 *     the sleep. This is the reference method every other adapter is compared
 *     against — see the SDNN warning in services/wearables/adapters/appleHealth.js;
 *   - tags `tempBasis = 'absolute_c'`, because Whoop's skin temperature is a real
 *     temperature, unlike Fitbit's and Apple's baseline deviations;
 *   - marks `measurementSource = 'device_export'` and assigns the confidence
 *     ceiling, since a vendor's own CSV is the strongest evidence we ever get.
 *
 * It deliberately does NOT touch the numbers. No rounding, no unit conversion, no
 * derived fields. Whoop's `recoveryScore` and `strain` stay in their canonical
 * fields because they ARE the reference definition of those fields; every other
 * adapter that lacks a true equivalent leaves them null rather than approximating.
 *
 * @module services/wearables/adapters/whoop
 */

const { parseWhoopExport } = require('../whoopParser');
const C = require('../canonicalDay');

const PROVIDER = 'whoop';

/**
 * Confidence for a Whoop export. The vendor's own structured export is the best
 * evidence tier available, so this is the ceiling other adapters sit below.
 * Coverage-based adjustment happens later in baselineService/deviceRegistry —
 * this is the per-source prior only.
 */
const WHOOP_EXPORT_CONFIDENCE = 1;

/**
 * Lift one whoopParser day onto the canonical shape.
 *
 * @param {Object} raw a day from parseWhoopExport().days
 * @returns {Object} a contract-valid canonical day
 */
function toCanonicalDay(raw) {
  const day = C.emptyCanonicalDay(raw && raw.date, PROVIDER);

  // Copy only fields the contract knows about. An unrecognised key from a future
  // parser change is ignored here rather than smuggled into the row — the parser
  // already reports genuinely unknown COLUMNS through summary.unknownColumns.
  C.METRIC_FIELDS.forEach((f) => {
    const v = raw ? raw[f] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) day[f] = v;
  });

  // whoopParser seeds napMinutes at 0 and accumulates; preserve that exactly,
  // including the meaningful 0 (a day with no naps is not a day with no data).
  if (raw && typeof raw.napMinutes === 'number' && Number.isFinite(raw.napMinutes)) {
    day.napMinutes = raw.napMinutes;
  }

  // ── rule 6: provenance ──
  if (day.hrvMs !== null) day.hrvMethod = C.HRV_METHOD.RMSSD_SLEEP;
  if (day.skinTempC !== null) day.tempBasis = C.TEMP_BASIS.ABSOLUTE_C;

  // Kept verbatim from the parser so a unit-detection misfire stays recoverable
  // from stored data rather than being baked in. See canonicalizeTemp().
  if (raw && raw.skinTempRaw !== undefined) day.skinTempRaw = raw.skinTempRaw;
  if (raw && raw.skinTempUnit !== undefined) day.skinTempUnit = raw.skinTempUnit;

  day.measurementSource = C.MEASUREMENT_SOURCE.DEVICE_EXPORT;
  day.confidence = WHOOP_EXPORT_CONFIDENCE;
  day.deviceModel = null; // Whoop's export does not name the strap generation.

  return day;
}

/**
 * Parse a Whoop export into the universal contract shape.
 *
 * @param {{files: Array<{name:string, text:string}>}|Array} input
 *        either the `{files}` object parseWhoopExport takes, or a bare array of files
 * @returns {{days:Object[], workouts:Object[], journal:Object[], summary:Object, rejected:Object[]}}
 */
function parse(input) {
  const files = Array.isArray(input) ? input : (input && input.files) || [];
  if (!files.length) {
    return C.emptyParsedExport(PROVIDER, ['No files were supplied.']);
  }

  const parsed = parseWhoopExport({ files: files });

  const out = {
    days: (parsed.days || []).map(toCanonicalDay),
    workouts: parsed.workouts || [],
    journal: parsed.journal || [],
    summary: Object.assign({}, parsed.summary, {
      provider: PROVIDER,
      // parseWhoopExport does not surface an `implausible` bucket; the contract
      // expects the key to exist so downstream code can count it unconditionally.
      implausible: (parsed.summary && parsed.summary.implausible) || []
    }),
    rejected: parsed.rejected || []
  };

  // Days already arrive sorted and de-duplicated from parseWhoopExport; assert it
  // rather than assume it, so a future parser change surfaces here instead of as a
  // wrong trend slope three layers downstream.
  const check = C.validateParsedExport(out);
  if (!check.ok) {
    out.summary.notes = (out.summary.notes || []).concat(
      check.errors.slice(0, 20).map((e) => 'contract: ' + e)
    );
    out.summary.contractViolations = check.errors.length;
  }

  return out;
}

module.exports = {
  parse,
  toCanonicalDay,
  PROVIDER,
  WHOOP_EXPORT_CONFIDENCE
};
