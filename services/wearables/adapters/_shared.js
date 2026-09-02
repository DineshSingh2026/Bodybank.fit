'use strict';

/**
 * Shared plumbing for BodyBank's STRUCTURED-FILE wearable adapters
 * (Oura, Fitbit, Garmin, Polar, Amazfit/Zepp and the generic-CSV fallback).
 *
 * Every adapter in this family follows the same shape:
 *
 *     parse(files, opts) -> { days, workouts, journal, summary, rejected }
 *
 * and must pass `canonicalDay.validateParsedExport()`. This module owns the parts
 * that would otherwise be copy-pasted six times and drift:
 *
 *   - reading a file that may arrive as text, as a Buffer, or inside a ZIP;
 *   - a tolerant date / timestamp normaliser (ISO, US M/D/YY, YYYYMMDD, epoch
 *     seconds or milliseconds, month names);
 *   - a duration normaliser that turns HH:MM, decimal hours, minutes, seconds or
 *     milliseconds into minutes, driven by the HEADER and sanity-checked against
 *     the VALUE (rule 4) — never by magnitude alone unless explicitly asked;
 *   - a day-merge that mirrors whoopParser's "longer sleep wins a same-date
 *     collision" rule, including the fact that a night's sleep block is atomic
 *     (stages from two different nights are never blended);
 *   - an implausible-value filter driven by `canonicalDay.SANITY` that NULLS the
 *     value and records it in `summary.implausible`. It never clamps (a clamp
 *     turns a unit bug into a plausible-looking lie) and never drops silently;
 *   - a builder that assembles the final result with days sorted ascending and
 *     de-duplicated, and that refuses to emit a day which still fails the
 *     contract — such a day becomes a `rejected` entry instead.
 *
 * NOTHING in here invents a value. Every "I could not read this" path produces
 * `null` plus a visible record (a rejection, an unknown column, a note, or an
 * implausible entry).
 *
 * @module services/wearables/adapters/_shared
 */

const C = require('../canonicalDay');
const whoop = require('../whoopParser');
const zipReader = require('../zipReader');

/** BodyBank's canonical timezone — the same constant whoopParser attributes in. */
const TZ = whoop.WHOOP_TZ;

/* ================================================================== *
 * 1. Re-exported primitives
 *
 * These are whoopParser's, deliberately NOT reimplemented. whoopParser is the
 * production-proven reference; a second copy of `parseCsv` in this file would be
 * a second place for an RFC4180 bug to live.
 * ================================================================== */

const parseCsv = whoop.parseCsv;
const normalizeHeaderKey = whoop.normalizeHeaderKey;
const parseTimestamp = whoop.parseTimestamp;
const parseOffsetMinutes = whoop.parseOffsetMinutes;
const ymdInTz = whoop.ymdInTz;
const toNum = whoop.toNum;
const toBool = whoop.toBool;
const canonicalizeTemp = whoop.canonicalizeTemp;
const canonicalizeEnergy = whoop.canonicalizeEnergy;

/* ================================================================== *
 * 2. Tiny helpers
 * ================================================================== */

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function toStr(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/** True when every cell of a physical CSV row is blank. */
function isBlankRow(cells) {
  return !cells || cells.every((c) => String(c == null ? '' : c).trim() === '');
}

function stripBom(s) {
  if (typeof s !== 'string') return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function basenameOf(name) {
  return String(name || '').replace(/\\/g, '/').split('/').pop();
}

function lowerBase(name) {
  return basenameOf(name).toLowerCase();
}

/** Invert `{canonical: [alias, ...]}` tables into `{normalizedAlias: canonical}`. */
function buildAliasIndex() {
  const out = Object.create(null);
  for (let i = 0; i < arguments.length; i += 1) {
    const table = arguments[i];
    if (!table) continue;
    Object.keys(table).forEach((canon) => {
      (table[canon] || []).forEach((alias) => {
        const key = normalizeHeaderKey(alias);
        if (key && !(key in out)) out[key] = canon;
      });
    });
  }
  return out;
}

/* ================================================================== *
 * 3. File input — text, Buffer, or a ZIP of either
 * ================================================================== */

function bufferOf(file) {
  if (!file) return null;
  const b = file.buffer || file.bytes || file.data || file.content;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  return null;
}

/**
 * Decode one input file to UTF-8 text.
 * @returns {string|null} null when the file carried neither text nor bytes.
 */
function toText(file) {
  if (!file) return null;
  if (typeof file.text === 'string') return stripBom(file.text);
  const buf = bufferOf(file);
  if (buf) return stripBom(buf.toString('utf8'));
  return null;
}

/**
 * Normalise the adapter input into a flat `[{name, text}]` list, transparently
 * expanding any ZIP archive (Garmin's GDPR export and Google Takeout both arrive
 * that way). A malformed archive is a NOTE, never a throw.
 *
 * @param {Array|Object} input `[{name,text|buffer}]` or `{files: [...]}`
 * @param {{note:function}} sink usually the builder
 * @returns {Array<{name:string, text:string|null}>}
 */
function expandFiles(input, sink) {
  const files = Array.isArray(input) ? input : (input && Array.isArray(input.files) ? input.files : []);
  const note = (sink && typeof sink.note === 'function') ? sink.note : function () {};
  const out = [];

  files.filter(Boolean).forEach((f) => {
    const name = String(f.name || f.path || 'unnamed');
    const buf = typeof f.text === 'string' ? null : bufferOf(f);

    if (buf && zipReader.isZip(buf)) {
      let res = null;
      try {
        res = zipReader.readZipEntries(buf, { extensions: null, basename: false });
      } catch (err) {
        note('Could not read ZIP "' + name + '": ' + ((err && err.message) || String(err)));
        return;
      }
      res.entries.forEach((e) => {
        let text = null;
        try {
          text = stripBom(e.text());
        } catch (err) {
          note('Could not decompress "' + e.path + '": ' + ((err && err.message) || String(err)));
          return;
        }
        out.push({ name: e.path, text: text });
      });
      (res.skipped || []).forEach((s) => {
        // 'directory' and 'empty' are structural noise, not information.
        if (s.reason !== 'directory' && s.reason !== 'empty') {
          note('ZIP entry skipped (' + s.reason + '): ' + s.name);
        }
      });
      (res.warnings || []).forEach((w) => note('ZIP warning: ' + w));
      return;
    }

    out.push({ name: name, text: toText(f) });
  });

  return out;
}

/**
 * Parse JSON tolerantly: a plain document, or NDJSON (one JSON value per line,
 * which several vendor exports use for large series).
 * @returns {{value:*, error:string|null}}
 */
function readJson(text) {
  const s = typeof text === 'string' ? stripBom(text).trim() : '';
  if (!s) return { value: null, error: 'empty file' };
  try {
    return { value: JSON.parse(s), error: null };
  } catch (err) {
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      const rows = [];
      for (let i = 0; i < lines.length; i += 1) {
        try {
          rows.push(JSON.parse(lines[i]));
        } catch (e2) {
          return { value: null, error: (err && err.message) || 'invalid JSON' };
        }
      }
      return { value: rows, error: null };
    }
    return { value: null, error: (err && err.message) || 'invalid JSON' };
  }
}

/* ================================================================== *
 * 4. Dates and timestamps
 * ================================================================== */

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};

function pad2(n) { return String(n).padStart(2, '0'); }

function validEpochUtc(y, mo, d, h, mi, se, ms) {
  if (h > 23 || mi > 59 || se > 60) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms || 0);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return t;
}

/**
 * Epoch number -> timestamp record. Seconds and milliseconds are told apart by
 * magnitude: 1e11 seconds is the year 5138 and 1e11 ms is 1973, so the split is
 * unambiguous for any real wearable reading. Anything below 1e8 (1973 in seconds)
 * is refused rather than guessed.
 */
function fromEpochNumber(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs < 1e8) return null;
  const ms = abs >= 1e11 ? n : n * 1000;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return {
    epochMs: ms,
    hasZone: true, // an epoch IS an absolute instant
    localYmd: d.toISOString().slice(0, 10),
    iso: d.toISOString()
  };
}

function ymdRecord(y, mo, d) {
  if (validEpochUtc(y, mo, d, 0, 0, 0, 0) == null) return null;
  return { epochMs: null, hasZone: false, localYmd: y + '-' + pad2(mo) + '-' + pad2(d), iso: null };
}

/**
 * Tolerant timestamp parse. Delegates to whoopParser first (ISO with or without
 * an offset, `YYYY-MM-DD`, US `M/D/YYYY h:mm:ss AM`), then adds the forms the
 * other vendors use.
 *
 * Returns the same record whoopParser.parseTimestamp does:
 *   `{epochMs, hasZone, localYmd, iso}` — `hasZone:false` means the only truth we
 *   have is the printed local date, and callers must NOT convert it.
 *
 * @param {*} value
 * @param {string} [tzHint] a declared offset such as "UTC+05:30"
 * @returns {{epochMs:number|null, hasZone:boolean, localYmd:string, iso:string|null}|null}
 */
function parseLooseTimestamp(value, tzHint) {
  if (value == null) return null;
  if (typeof value === 'number') return fromEpochNumber(value);

  const s = String(value).trim();
  if (!s) return null;

  // Bare digits: a compact date (YYYYMMDD) or an epoch.
  if (/^-?\d+$/.test(s)) {
    if (/^\d{8}$/.test(s)) {
      return ymdRecord(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    }
    return fromEpochNumber(Number(s));
  }

  const viaWhoop = parseTimestamp(s, tzHint);
  if (viaWhoop) return viaWhoop;

  // US short year, e.g. Google Takeout's "01/02/24 00:00:00".
  // UNVERIFIED: Fitbit Takeout writes MM/DD/YY. A real export covering a day
  // after the 12th of a month confirms the ordering; before then the two
  // readings collide and nothing in the file distinguishes them.
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (m) {
    const mo = +m[1];
    const d = +m[2];
    const y = 2000 + (+m[3]);
    let h = m[4] == null ? 0 : +m[4];
    const mi = m[5] == null ? 0 : +m[5];
    const se = m[6] == null ? 0 : +m[6];
    if (m[7]) {
      const pm = /p/i.test(m[7]);
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    if (mo < 1 || mo > 12) return null;
    if (validEpochUtc(y, mo, d, h, mi, se, 0) == null) return null;
    return { epochMs: null, hasZone: false, localYmd: y + '-' + pad2(mo) + '-' + pad2(d), iso: null };
  }

  // "2 Jan 2024", "Jan 2, 2024" — any time component is ignored, because these
  // forms are only ever used here to name a calendar date.
  m = /^(\d{1,2})[ \-]([A-Za-z]{3,9})[ \-](\d{4})/.exec(s);
  if (m && MONTH_NAMES[m[2].toLowerCase()]) {
    return ymdRecord(+m[3], MONTH_NAMES[m[2].toLowerCase()], +m[1]);
  }
  m = /^([A-Za-z]{3,9})[ \-](\d{1,2}),?[ \-](\d{4})/.exec(s);
  if (m && MONTH_NAMES[m[1].toLowerCase()]) {
    return ymdRecord(+m[3], MONTH_NAMES[m[1].toLowerCase()], +m[2]);
  }

  return null;
}

/**
 * Calendar date (YYYY-MM-DD) of a value, in `tz`.
 *
 * A timestamp that carries no zone is NOT converted — its printed date is the
 * only truth available and inventing a zone would move a night across midnight.
 *
 * @returns {string|null}
 */
function ymdOf(value, tz, tzHint) {
  const p = parseLooseTimestamp(value, tzHint);
  if (!p) return null;
  if (!p.hasZone || p.epochMs == null) return p.localYmd;
  const zone = tz || TZ;
  try {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(p.epochMs));
    return s.length >= 10 ? s.slice(0, 10) : null;
  } catch (_) {
    return new Date(p.epochMs).toISOString().slice(0, 10);
  }
}

/** ISO-8601 string for a value, or the bare local date when it carries no zone. */
function isoOf(value, tzHint) {
  const p = parseLooseTimestamp(value, tzHint);
  if (!p) return null;
  return p.iso || p.localYmd;
}

/**
 * Whole minutes between two timestamps, or null when either is unusable.
 * Both sides must be absolute instants; mixing an absolute with a bare
 * wall-clock value would apply an offset to only one end of the interval.
 */
function minutesBetween(startValue, endValue, tzHint) {
  const a = parseLooseTimestamp(startValue, tzHint);
  const b = parseLooseTimestamp(endValue, tzHint);
  if (!a || !b) return null;
  if (a.epochMs != null && b.epochMs != null) return round((b.epochMs - a.epochMs) / 60000, 2);
  return null;
}

/* ================================================================== *
 * 5. Durations  (rule 4: the header is a hint, the value is the check)
 * ================================================================== */

const DURATION_UNIT_MULTIPLIER = {
  ms: 1 / 60000,
  s: 1 / 60,
  min: 1,
  h: 60
};

/**
 * Which time unit does this header text declare? `null` when it says nothing.
 * Deliberately conservative: a bare "duration" declares nothing.
 */
function declaredDurationUnit(header) {
  const h = String(header == null ? '' : header);
  if (/millisecond|\bmsec\b|\(\s*ms\s*\)|\bms\b/i.test(h)) return 'ms';
  if (/second|\bsecs?\b|\(\s*s\s*\)|_seconds\b|seconds$/i.test(h)) return 's';
  if (/minute|\bmins?\b|\(\s*m\s*\)|_minutes\b/i.test(h)) return 'min';
  if (/\bhours?\b|\bhrs?\b|\(\s*h\s*\)/i.test(h)) return 'h';
  return null;
}

/** Largest unit whose reading fits inside [minMinutes, maxMinutes]. */
function inferDurationUnit(n, maxMinutes, minMinutes) {
  const lo = minMinutes == null ? 0 : minMinutes;
  const order = ['h', 'min', 's', 'ms'];
  for (let i = 0; i < order.length; i += 1) {
    const mins = n * DURATION_UNIT_MULTIPLIER[order[i]];
    if (mins <= maxMinutes && mins >= lo) return order[i];
  }
  return null;
}

/**
 * Detect the time unit of a WHOLE COLUMN of durations at once.
 *
 * This is far safer than deciding row by row. Oura, Zepp and hand-rolled CSVs all
 * write "Total Sleep Duration" without a unit, and the same number could be 450
 * minutes or 450 seconds. One row cannot tell you which; the column's median can,
 * because a plausible night is 60-1440 minutes and only one interpretation of the
 * median lands in that window.
 *
 * Priority: an explicit header unit, then the caller's documented `assume`, then
 * the median's magnitude. An `assume` that produces an implausible column is
 * discarded — that is the "sanity-check the header against the value" half of
 * rule 4 applied to a whole series.
 *
 * @param {Array} values every raw cell of the column
 * @param {string} header the column's raw header text
 * @param {{assume?:string, minMinutes?:number, maxMinutes?:number}} [opts]
 * @returns {{unit:string|null, basis:string|null, median:number|null, sampleCount:number}}
 */
function detectSeriesDurationUnit(values, header, opts) {
  const options = opts || {};
  const maxMinutes = options.maxMinutes == null ? 1440 : options.maxMinutes;
  const minMinutes = options.minMinutes == null ? 0 : options.minMinutes;

  const nums = (values || [])
    .map((v) => toNum(v))
    .filter((v) => v !== null && v > 0)
    .sort((a, b) => a - b);
  const median = nums.length ? nums[Math.floor(nums.length / 2)] : null;

  const declared = declaredDurationUnit(header);
  const fits = (unit) => {
    if (!unit || DURATION_UNIT_MULTIPLIER[unit] == null) return false;
    if (median === null) return true;
    const mins = median * DURATION_UNIT_MULTIPLIER[unit];
    return mins <= maxMinutes && mins >= minMinutes;
  };

  if (declared && fits(declared)) {
    return { unit: declared, basis: 'header', median: median, sampleCount: nums.length };
  }
  if (options.assume && fits(options.assume)) {
    return { unit: options.assume, basis: 'assumed', median: median, sampleCount: nums.length };
  }
  if (median === null) {
    const fallback = declared || options.assume || null;
    return {
      unit: fallback,
      basis: fallback ? (declared ? 'header' : 'assumed') : null,
      median: null,
      sampleCount: 0
    };
  }
  const inferred = inferDurationUnit(median, maxMinutes, minMinutes);
  return { unit: inferred, basis: inferred ? 'magnitude' : null, median: median, sampleCount: nums.length };
}

/**
 * Normalise a duration cell to MINUTES.
 *
 * Resolution order:
 *   1. `HH:MM` / `HH:MM:SS` text — unambiguous, wins outright.
 *   2. the unit declared by the header text;
 *   3. `opts.assume` — the unit this vendor's format is documented to use;
 *   4. `opts.inferByMagnitude` — ONLY when the caller opts in. Magnitude
 *      inference is genuinely dangerous (a 20-minute nap read as 20 hours), so it
 *      is never the default.
 *
 * After conversion the result is sanity-checked against `opts.maxMinutes`
 * (default 1440, one day). A hinted unit that produces an impossible duration is
 * re-read with a unit that does not — that is unit DETECTION, not clamping: the
 * value itself is never altered, only its interpretation, and `reinterpreted`
 * tells the caller it happened so it can be surfaced.
 *
 * @returns {{minutes:number|null, unit:string|null, reinterpreted:boolean}}
 */
function parseDurationMinutes(raw, header, opts) {
  const options = opts || {};
  const maxMinutes = options.maxMinutes == null ? 1440 : options.maxMinutes;
  const s = toStr(raw);
  if (s == null) return { minutes: null, unit: null, reinterpreted: false };

  // 1. clock notation
  const clock = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (clock) {
    const mins = (+clock[1]) * 60 + (+clock[2]) + (clock[3] ? (+clock[3]) / 60 : 0);
    return { minutes: round(mins, 2), unit: 'hh:mm', reinterpreted: false };
  }

  const n = toNum(s);
  if (n == null || n < 0) return { minutes: null, unit: null, reinterpreted: false };

  const declared = declaredDurationUnit(header);
  const assumed = options.assume || null;
  const unit = declared || assumed || null;
  let reinterpreted = false;

  if (unit && DURATION_UNIT_MULTIPLIER[unit] != null) {
    const mins = n * DURATION_UNIT_MULTIPLIER[unit];
    if (mins <= maxMinutes) return { minutes: round(mins, 2), unit: unit, reinterpreted: false };
    // The declared unit cannot be right; fall through to magnitude and say so.
    reinterpreted = true;
  } else if (!options.inferByMagnitude) {
    // No unit anywhere and the caller did not authorise guessing: refuse.
    return { minutes: null, unit: null, reinterpreted: false };
  }

  const inferred = inferDurationUnit(n, maxMinutes);
  if (!inferred) return { minutes: null, unit: null, reinterpreted: reinterpreted };
  return {
    minutes: round(n * DURATION_UNIT_MULTIPLIER[inferred], 2),
    unit: inferred,
    reinterpreted: reinterpreted
  };
}

/**
 * A percentage that a vendor may have written as a 0..1 fraction.
 * `0.92` becomes `92`; `92` stays `92`. Only used where a fraction is a real
 * possibility (the generic CSV fallback), because 1 is ambiguous between "1%"
 * and "100%" — and 1% of any of these metrics is not a plausible reading.
 *
 * @returns {{value:number|null, scaled:boolean}}
 */
function percentFromMaybeFraction(raw) {
  const n = toNum(raw);
  if (n == null) return { value: null, scaled: false };
  if (n > 0 && n <= 1) return { value: round(n * 100, 2), scaled: true };
  return { value: n, scaled: false };
}

/**
 * A temperature DEVIATION (a delta from the member's own baseline), canonicalised
 * to Celsius. A deviation converts from Fahrenheit by the RATIO ALONE — applying
 * the 32-degree offset to a delta is the classic bug and turns -0.3 into -17.9.
 *
 * The caller is responsible for writing this into `skinTempDeviationC` with
 * `tempBasis: 'deviation_c'` and NEVER into `skinTempC`.
 *
 * @returns {{skinTempDeviationC:number|null, skinTempRaw:number|null, skinTempUnit:string|null}}
 */
function canonicalizeTempDeviation(value, header) {
  const raw = toNum(value);
  if (raw == null) return { skinTempDeviationC: null, skinTempRaw: null, skinTempUnit: null };
  const h = String(header == null ? '' : header);
  const unit = /fahrenheit|deg\s*f|°\s*f|\(\s*f\s*\)/i.test(h) ? 'F' : 'C';
  const c = unit === 'F' ? raw * 5 / 9 : raw;
  return { skinTempDeviationC: round(c, 3), skinTempRaw: raw, skinTempUnit: unit };
}

/* ================================================================== *
 * 6. JSON key mapping  (rule 1, for JSON exports)
 *
 * The JSON equivalent of "never read a column by position": every leaf is looked
 * up in an alias table by BOTH its full dotted path and its own leaf name, and
 * anything unmatched is reported as an unknown column rather than dropped.
 * ================================================================== */

/**
 * Flatten a JSON object into `{dottedPath: primitiveValue}`.
 * Arrays are flattened with numeric segments so `napList.0.duration` is reachable.
 */
function flattenJson(obj, prefix, out, depth) {
  const acc = out || Object.create(null);
  const p = prefix || '';
  const d = depth || 0;
  if (d > 8) return acc;
  if (obj === null || obj === undefined) return acc;
  if (typeof obj !== 'object') {
    if (p) acc[p] = obj;
    return acc;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenJson(v, p ? p + '.' + i : String(i), acc, d + 1));
    return acc;
  }
  Object.keys(obj).forEach((k) => {
    const next = p ? p + '.' + k : k;
    const v = obj[k];
    if (v !== null && typeof v === 'object') flattenJson(v, next, acc, d + 1);
    else acc[next] = v;
  });
  return acc;
}

/**
 * Map a flattened JSON record through an alias index.
 *
 * @param {Object} obj a JSON record
 * @param {Object} aliasIndex normalizedAlias -> canonical key
 * @param {{ignore?:Object}} [opts] `ignore` is a second index of keys we know
 *        about and deliberately do not map, so they are not reported as unknown
 * @returns {{values:Object, headerByField:Object, unknown:string[]}}
 */
function mapJsonRecord(obj, aliasIndex, opts) {
  const ignore = (opts && opts.ignore) || Object.create(null);
  const flat = flattenJson(obj, '', null, 0);
  const values = Object.create(null);
  const headerByField = Object.create(null);
  const unknown = [];

  Object.keys(flat).forEach((dotted) => {
    const v = flat[dotted];
    const leaf = dotted.split('.').pop();
    const fullKey = normalizeHeaderKey(dotted.replace(/\./g, ' '));
    const leafKey = normalizeHeaderKey(leaf);
    const canon = aliasIndex[fullKey] || aliasIndex[leafKey];
    if (!canon) {
      if (ignore[fullKey] || ignore[leafKey]) return;
      // A numeric path segment means an array member; report the shape once
      // rather than once per element.
      const generic = dotted.replace(/\.\d+(?=\.|$)/g, '[]');
      if (unknown.indexOf(generic) === -1) unknown.push(generic);
      return;
    }
    if (v === null || v === undefined || v === '') return;
    if (!(canon in values)) {
      values[canon] = v;
      headerByField[canon] = dotted;
    }
  });

  return { values: values, headerByField: headerByField, unknown: unknown };
}

/* ================================================================== *
 * 7. Sanity filter  (rule 5)
 * ================================================================== */

/**
 * Fields that describe ONE night and must move together. When two records collide
 * on a date, the losing night's stages must not be blended into the winner's — a
 * mixed record would report REM from one night against a total from another.
 */
const SLEEP_BLOCK_FIELDS = [
  'sleepMinutes', 'sleepHours', 'sleepPerformancePct', 'sleepEfficiencyPct',
  'sleepConsistencyPct', 'sleepNeedMin', 'sleepDebtMin',
  'remMin', 'deepMin', 'lightMin', 'awakeMin', 'respiratoryRate'
];
const SLEEP_BLOCK_SET = new Set(SLEEP_BLOCK_FIELDS);

/** Provenance fields that must travel with the value they describe. */
const HRV_COMPANIONS = ['hrvMethod'];
const TEMP_COMPANIONS = ['tempBasis', 'skinTempRaw', 'skinTempUnit'];

/**
 * Null every metric outside its `SANITY` range and record why.
 *
 * The value is NEVER clamped: clamping a 4500-minute "sleep" to 1440 turns a
 * seconds-vs-minutes bug into a plausible-looking night that then gets averaged
 * into a member's PDF as fact. The original value is preserved in the report.
 *
 * @param {Object} day a canonical day, mutated in place
 * @param {Array} implausible the builder's `summary.implausible` array
 * @param {{file?:string, rowNumber?:number}} [ctx]
 */
function applySanity(day, implausible, ctx) {
  const where = ctx || {};
  C.METRIC_FIELDS.forEach((f) => {
    const v = day[f];
    if (v === null || v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      implausible.push({
        date: day.date,
        field: f,
        value: v === undefined ? null : v,
        min: null,
        max: null,
        reason: 'not a finite number',
        file: where.file || null,
        rowNumber: where.rowNumber == null ? null : where.rowNumber
      });
      day[f] = f === 'napMinutes' ? 0 : null;
      return;
    }
    const range = C.SANITY[f];
    if (!range) return;
    const belowMin = range[0] !== null && v < range[0];
    const aboveMax = range[1] !== null && v > range[1];
    if (!belowMin && !aboveMax) return;
    implausible.push({
      date: day.date,
      field: f,
      value: v,
      min: range[0],
      max: range[1],
      reason: belowMin ? 'below plausible minimum' : 'above plausible maximum',
      file: where.file || null,
      rowNumber: where.rowNumber == null ? null : where.rowNumber
    });
    day[f] = f === 'napMinutes' ? 0 : null;
  });
}

/**
 * Make the sleep fields internally consistent, then drop what cannot be true.
 * Runs AFTER applySanity so a nulled total also removes the hours that mirrored
 * it and the stages that claimed to fit inside it.
 */
function reconcileSleep(day, implausible, ctx) {
  const where = ctx || {};

  if (day.sleepMinutes === null && day.sleepHours !== null) {
    day.sleepMinutes = round(day.sleepHours * 60, 1);
  } else if (day.sleepMinutes !== null) {
    day.sleepHours = round(day.sleepMinutes / 60, 2);
  }
  if (day.sleepMinutes === null) day.sleepHours = null;

  const stageFields = ['remMin', 'deepMin', 'lightMin'];
  const stages = stageFields.reduce((acc, f) => (day[f] === null ? acc : acc + day[f]), 0);
  if (day.sleepMinutes !== null && stages > 0 && stages > day.sleepMinutes * 1.03 + 1) {
    implausible.push({
      date: day.date,
      field: 'sleepStages',
      value: round(stages, 2),
      min: null,
      max: day.sleepMinutes,
      reason: 'sleep stages total more than the night they belong to; stages dropped, total kept',
      file: where.file || null,
      rowNumber: where.rowNumber == null ? null : where.rowNumber
    });
    stageFields.forEach((f) => { day[f] = null; });
  }

  // Provenance without a value is meaningless; a value without provenance is
  // unusable. Keep the pair honest in both directions.
  if (day.hrvMs === null) day.hrvMethod = null;
  if (day.skinTempC === null && day.skinTempDeviationC === null) {
    day.tempBasis = null;
    day.skinTempRaw = null;
    day.skinTempUnit = null;
  }
  if (day.napMinutes === null || day.napMinutes === undefined) day.napMinutes = 0;
  day.napMinutes = round(day.napMinutes, 2);
}

/* ================================================================== *
 * 8. The builder
 * ================================================================== */

function numOr(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return toNum(v);
}

function sortByStart(a, b) {
  const av = (a && (a.startedAt || a.date)) || '';
  const bv = (b && (b.startedAt || b.date)) || '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function sortByDate(a, b) {
  const av = (a && a.date) || '';
  const bv = (b && b.date) || '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create a result builder for one adapter run.
 *
 * @param {string} provider a value from canonicalDay.PROVIDERS
 * @param {{timezone?:string, measurementSource?:string, confidence?:number}} [opts]
 */
function createBuilder(provider, opts) {
  const options = opts || {};
  const timezone = options.timezone || TZ;
  const measurementSource = options.measurementSource || C.MEASUREMENT_SOURCE.DEVICE_EXPORT;
  const confidence = options.confidence == null ? null : options.confidence;

  const days = new Map(); // date -> canonical day
  const filesSeen = [];
  const unknownColumns = [];
  const duplicates = [];
  const implausible = [];
  const notes = [];
  const rejected = [];
  const workouts = [];
  const journal = [];

  function note(text) {
    const t = toStr(text);
    if (t && notes.indexOf(t) === -1) notes.push(t);
  }

  /** Register a file. The returned record is mutated as its rows are read. */
  function file(name, kind) {
    const rec = { name: String(name || 'unnamed'), kind: kind || null, rowsParsed: 0, rowsRejected: 0 };
    filesSeen.push(rec);
    return rec;
  }

  function nameOf(fileRec) {
    if (!fileRec) return null;
    if (typeof fileRec === 'string') return fileRec;
    return fileRec.name || null;
  }

  function reject(fileRec, rowNumber, reason, raw) {
    rejected.push({
      file: nameOf(fileRec),
      rowNumber: rowNumber == null ? null : rowNumber,
      reason: String(reason || 'unusable row'),
      raw: raw === undefined ? null : raw
    });
    if (fileRec && typeof fileRec.rowsRejected === 'number') fileRec.rowsRejected += 1;
  }

  function unknownColumn(fileRec, kind, column) {
    const name = nameOf(fileRec);
    const col = toStr(column);
    if (!col) return;
    if (unknownColumns.some((u) => u.file === name && u.column === col)) return;
    unknownColumns.push({ file: name, kind: kind || (fileRec && fileRec.kind) || null, column: col });
  }

  function dayFor(date) {
    if (!days.has(date)) {
      const d = C.emptyCanonicalDay(date, provider);
      d.measurementSource = measurementSource;
      if (confidence !== null) d.confidence = confidence;
      days.set(date, d);
    }
    return days.get(date);
  }

  /**
   * Record a device-native score. These are never comparable across brands, so
   * they live outside the canonical fields under a namespaced key.
   */
  function addProviderScores(date, scores, onlyFillGaps) {
    if (typeof date !== 'string' || !YMD_RE.test(date)) return;
    const day = dayFor(date);
    Object.keys(scores || {}).forEach((key) => {
      const v = scores[key];
      if (v === null || v === undefined) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(key)) {
        note('Ignored a provider score with a non-namespaced key: ' + key);
        return;
      }
      if (onlyFillGaps && day.providerScores[key] !== undefined) return;
      day.providerScores[key] = v;
    });
  }

  /**
   * Merge one source record into the day it belongs to.
   *
   * Collision rule (mirrors whoopParser): when the incoming record and the day
   * already present BOTH carry a nightly sleep duration, the LONGER sleep wins
   * and the collision is reported in `summary.duplicates`. The winner owns the
   * whole sleep block atomically. Fields outside that block are first-writer-wins
   * unless the incoming record won the sleep collision, in which case it is the
   * authoritative record for that date and overwrites.
   *
   * @param {string} date YYYY-MM-DD
   * @param {Object} patch canonical field names -> values (null means "no data")
   * @param {{file?:Object, rowNumber?:number, kind?:string, providerScores?:Object,
   *          deviceModel?:string, countRow?:boolean}} [meta]
   * @returns {Object|null} the day, or null when `date` was unusable
   */
  function mergeDay(date, patch, meta) {
    const m = meta || {};
    if (typeof date !== 'string' || !YMD_RE.test(date)) return null;
    const day = dayFor(date);
    const p = patch || {};

    const incomingSleep = numOr(p.sleepMinutes);
    const existingSleep = numOr(day.sleepMinutes);
    const collision = incomingSleep !== null && existingSleep !== null;
    let incomingWins = true;

    if (collision) {
      incomingWins = incomingSleep > existingSleep;
      duplicates.push({
        date: date,
        kind: m.kind || (m.file && m.file.kind) || null,
        file: nameOf(m.file),
        keptRowNumber: incomingWins ? (m.rowNumber == null ? null : m.rowNumber) : (day._sleepRowNumber == null ? null : day._sleepRowNumber),
        droppedRowNumber: incomingWins ? (day._sleepRowNumber == null ? null : day._sleepRowNumber) : (m.rowNumber == null ? null : m.rowNumber),
        reason: 'two nightly sleeps map to one date; kept the longer one',
        keptSleepMinutes: incomingWins ? incomingSleep : existingSleep,
        droppedSleepMinutes: incomingWins ? existingSleep : incomingSleep
      });
    }

    Object.keys(p).forEach((field) => {
      const v = p[field];
      if (v === undefined) return;
      if (!(field in day)) return; // never smuggle an unknown key into a row

      if (SLEEP_BLOCK_SET.has(field)) {
        if (collision) {
          // Atomic: the winner's block replaces the loser's entirely, nulls
          // included, so stages never blend across two different nights.
          if (incomingWins) day[field] = v;
        } else if (v !== null) {
          day[field] = v;
        }
        return;
      }

      if (v === null) return;
      if (day[field] === null || day[field] === undefined || (collision && incomingWins)) {
        day[field] = v;
        if (field === 'hrvMs') {
          HRV_COMPANIONS.forEach((c) => { if (p[c] !== undefined) day[c] = p[c]; });
        }
        if (field === 'skinTempC' || field === 'skinTempDeviationC') {
          TEMP_COMPANIONS.forEach((c) => { if (p[c] !== undefined) day[c] = p[c]; });
        }
      }
    });

    if (!collision || incomingWins) {
      if (incomingSleep !== null) day._sleepRowNumber = m.rowNumber == null ? null : m.rowNumber;
    }

    if (m.providerScores) addProviderScores(date, m.providerScores, collision && !incomingWins);
    if (m.deviceModel && !day.deviceModel) day.deviceModel = String(m.deviceModel);

    if (m.countRow !== false && m.file && typeof m.file.rowsParsed === 'number') m.file.rowsParsed += 1;
    return day;
  }

  /** Naps accumulate; they NEVER touch nightly sleep (rule 3). */
  function addNap(date, minutes) {
    if (typeof date !== 'string' || !YMD_RE.test(date)) return;
    const n = numOr(minutes);
    if (n === null || n < 0) return;
    const day = dayFor(date);
    day.napMinutes = (day.napMinutes || 0) + n;
  }

  function addWorkout(w) { if (w) workouts.push(w); }
  function addJournal(j) { if (j) journal.push(j); }

  /**
   * Assemble the contract result: days sorted ascending and de-duplicated,
   * sanity-filtered, sleep-reconciled, and — as a last gate — any day that STILL
   * fails `validateCanonicalDay` moved out of `days` and into `rejected`, so the
   * output cannot violate the contract no matter what a vendor file contained.
   */
  function finish(extraNotes) {
    (extraNotes || []).forEach(note);

    // A recognised file that yielded neither a row nor a rejection is the one
    // failure mode a member cannot see: it looks like a successful import of
    // nothing. Say so explicitly.
    filesSeen.forEach((f) => {
      if (f.kind && !f.rowsParsed && !f.rowsRejected) {
        note('No data rows were read from "' + f.name + '".');
      }
    });

    const ordered = Array.from(days.keys()).sort();
    const outDays = [];

    ordered.forEach((date) => {
      const day = days.get(date);
      delete day._sleepRowNumber;
      applySanity(day, implausible, {});
      reconcileSleep(day, implausible, {});

      const errs = C.validateCanonicalDay(day);
      if (errs.length) {
        // Should be unreachable — but a malformed day reaching the database is
        // worse than a day the member can see was refused.
        rejected.push({
          file: null,
          rowNumber: null,
          reason: 'day failed the canonical contract and was dropped: ' + errs.join('; '),
          raw: { date: date }
        });
        return;
      }
      outDays.push(day);
    });

    const allDates = []
      .concat(outDays.map((d) => d.date))
      .concat(workouts.map((w) => w && w.date).filter(Boolean))
      .concat(journal.map((j) => j && j.date).filter(Boolean))
      .filter(Boolean)
      .sort();

    const rowsParsed = filesSeen.reduce((a, f) => a + (f.rowsParsed || 0), 0);
    const rowsRejected = filesSeen.reduce((a, f) => a + (f.rowsRejected || 0), 0);

    const out = C.emptyParsedExport(provider, notes);
    out.days = outDays;
    out.workouts = workouts.slice().sort(sortByStart);
    out.journal = journal.slice().sort(sortByDate);
    out.rejected = rejected;
    out.summary.filesSeen = filesSeen;
    out.summary.rowsParsed = rowsParsed;
    out.summary.rowsRejected = rowsRejected;
    out.summary.dateRange = { from: allDates[0] || null, to: allDates[allDates.length - 1] || null };
    out.summary.unknownColumns = unknownColumns;
    out.summary.duplicates = duplicates;
    out.summary.implausible = implausible;
    out.summary.notes = notes;
    out.summary.timezone = timezone;
    return out;
  }

  return {
    provider: provider,
    timezone: timezone,
    note: note,
    file: file,
    reject: reject,
    unknownColumn: unknownColumn,
    dayFor: dayFor,
    mergeDay: mergeDay,
    addProviderScores: addProviderScores,
    addNap: addNap,
    addWorkout: addWorkout,
    addJournal: addJournal,
    finish: finish,
    _days: days
  };
}

/* ================================================================== *
 * 9. CSV table helper
 * ================================================================== */

/**
 * Read a CSV into `{headers, fields, headerByField, rows, unknown, headerLine}`
 * using an alias index — never by column position (rule 1).
 *
 * The header row is located by scanning the first `opts.maxHeaderScan` (default
 * 8) non-blank lines for the one that maps the most known aliases. Vendor exports
 * routinely prefix a title, an account id or a blank line before the real header.
 *
 * @param {string} text
 * @param {Object} aliasIndex
 * @param {{maxHeaderScan?:number, minKnown?:number}} [opts]
 */
function readCsvTable(text, aliasIndex, opts) {
  const options = opts || {};
  const maxScan = options.maxHeaderScan == null ? 8 : options.maxHeaderScan;
  const minKnown = options.minKnown == null ? 1 : options.minKnown;
  const table = parseCsv(text == null ? '' : text);

  const out = {
    headers: [], fields: [], headerByField: Object.create(null),
    rows: [], unknown: [], headerLine: -1
  };
  if (!table.length) return out;

  let best = -1;
  let bestScore = 0;
  let scanned = 0;
  for (let i = 0; i < table.length && scanned < maxScan; i += 1) {
    if (isBlankRow(table[i])) continue;
    scanned += 1;
    const score = table[i].reduce((acc, h) => {
      const k = normalizeHeaderKey(h);
      return acc + (k && aliasIndex[k] ? 1 : 0);
    }, 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best === -1 || bestScore < minKnown) return out;

  out.headerLine = best;
  out.headers = table[best].map((h) => String(h == null ? '' : h).replace(/^\uFEFF/, '').trim());
  const seen = new Set();
  out.fields = out.headers.map((h) => {
    const key = normalizeHeaderKey(h);
    const canon = key ? aliasIndex[key] : undefined;
    if (!canon) {
      if (h !== '' && out.unknown.indexOf(h) === -1) out.unknown.push(h);
      return null;
    }
    if (!seen.has(canon)) {
      seen.add(canon);
      if (!(canon in out.headerByField)) out.headerByField[canon] = h;
    }
    return canon;
  });

  for (let i = best + 1; i < table.length; i += 1) {
    const cells = table[i];
    if (isBlankRow(cells)) continue;
    const raw = Object.create(null);
    for (let c = 0; c < out.fields.length; c += 1) {
      const f = out.fields[c];
      if (!f) continue;
      const v = c < cells.length ? String(cells[c] == null ? '' : cells[c]).trim() : '';
      if (v !== '' && (raw[f] == null || raw[f] === '')) raw[f] = v;
      else if (!(f in raw)) raw[f] = '';
    }
    out.rows.push({ raw: raw, cells: cells.slice(), rowNumber: i + 1 });
  }
  return out;
}

module.exports = {
  TZ,
  // re-exported whoopParser primitives (never reimplemented)
  parseCsv,
  normalizeHeaderKey,
  parseTimestamp,
  parseOffsetMinutes,
  ymdInTz,
  toNum,
  toBool,
  canonicalizeTemp,
  canonicalizeEnergy,
  // local helpers
  round,
  toStr,
  numOr,
  isBlankRow,
  stripBom,
  basenameOf,
  lowerBase,
  buildAliasIndex,
  bufferOf,
  toText,
  expandFiles,
  readJson,
  parseLooseTimestamp,
  fromEpochNumber,
  ymdOf,
  isoOf,
  minutesBetween,
  declaredDurationUnit,
  inferDurationUnit,
  detectSeriesDurationUnit,
  parseDurationMinutes,
  percentFromMaybeFraction,
  canonicalizeTempDeviation,
  flattenJson,
  mapJsonRecord,
  applySanity,
  reconcileSleep,
  readCsvTable,
  createBuilder,
  SLEEP_BLOCK_FIELDS
};
