'use strict';

/**
 * Apple Health adapter — a streaming, zero-dependency scanner for `export.xml`.
 *
 * ── Why this file looks nothing like the CSV adapters ────────────────────────
 *
 * Apple Health exports as `export.zip`, whose payload is a single `export.xml`.
 * Two facts dominate every design decision below:
 *
 *   1. SIZE. For a multi-year Apple Watch user the file is routinely 200MB and
 *      not rarely 1.5GB. It CANNOT be read into a JavaScript string (V8's string
 *      cap is ~512MB, and even below that the copy would OOM a 512MB Render dyno).
 *      So the primary entry point is `parseStream()`, which consumes a Node
 *      Readable chunk by chunk and never holds more than one XML element plus a
 *      bounded set of per-day accumulators in memory. `parse(files)` exists for
 *      the small-file case and REFUSES politely above a cap rather than exploding.
 *
 *   2. GRANULARITY. Apple's export is sample-level, not day-level. A single day
 *      contains thousands of `<Record type="HKQuantityTypeIdentifierHeartRate">`
 *      elements. Every canonical day here is aggregated by us, from raw samples.
 *      Nothing in the file corresponds to a "day" at all.
 *
 * ── THE MOST IMPORTANT CORRECTNESS RULE IN THIS ADAPTER ──────────────────────
 *
 *   APPLE'S HRV IS **SDNN**, MEASURED OVER A ~60-SECOND SPOT CHECK.
 *   IT IS NOT THE OVERNIGHT **RMSSD** THAT WHOOP, OURA AND FITBIT REPORT.
 *
 *   SDNN over a short window captures a different slice of the variability
 *   spectrum than RMSSD, and in practice runs MATERIALLY HIGHER — commonly 1.5x
 *   to 2.5x a person's overnight RMSSD, with a ratio that is specific to the
 *   individual, to their breathing during the reading, and to the time of day the
 *   watch happened to sample.
 *
 *   THEREFORE:
 *     - Every Apple day carrying `hrvMs` MUST also carry
 *       `hrvMethod: HRV_METHOD.SDNN_SPOT`. There is no exception.
 *     - WE MUST NEVER CONVERT SDNN TO RMSSD. No published conversion factor is
 *       valid per-individual. Inventing one — even a "conservative" one, even
 *       behind a flag — would silently corrupt every downstream trend, baseline,
 *       z-score and readiness verdict for every member who ever switches device,
 *       and the corruption would be invisible because the numbers would still
 *       look plausible. A fake 20% cliff on the day a member changes watches is
 *       infinitely better than a smooth, confident, wrong line.
 *     - Comparison across methods is the BASELINE layer's problem, not ours. Our
 *       only job is to make the method unambiguous and impossible to lose.
 *
 * ── Apple has no recovery score and no strain ────────────────────────────────
 *
 * `recoveryScore`, `readinessScore` and `strain` stay null. Apple ships no
 * equivalent. Synthesising one from HRV and RHR would be a BodyBank-invented
 * number wearing a device's name, which is exactly what rule 5 forbids.
 *
 * ── Duplicate sources: the bug that doubles everybody's step count ───────────
 *
 * An Apple export contains the SAME instant written by several sources: the
 * iPhone's motion coprocessor, the Watch, and any third-party app that mirrors
 * into HealthKit (Strava, Nike Run Club, MyFitnessPal, Withings...). Summing
 * `StepCount` or `ActiveEnergyBurned` naively double- or triple-counts. See
 * `createDedupe()` and `CUMULATIVE_TYPES` below.
 *
 * @module services/wearables/adapters/appleHealth
 */

const {
  parseTimestamp,
  ymdInTz,
  toNum,
  canonicalizeTemp,
  canonicalizeEnergy,
  WHOOP_TZ
} = require('../whoopParser');

const C = require('../canonicalDay');

const PROVIDER = 'apple_health';

/**
 * A vendor's own structured export is strong evidence, but Apple's is weaker than
 * Whoop's: the numbers are ours (we aggregated raw samples), not Apple's, and the
 * de-duplication below is best-effort against an undocumented source-priority
 * scheme. Sits one notch under the Whoop export ceiling of 1.
 */
const APPLE_EXPORT_CONFIDENCE = 0.9;

/* ------------------------------------------------------------------ *
 * Limits — every one of these exists to keep a hostile or simply huge
 * file from becoming an OOM.
 * ------------------------------------------------------------------ */

/**
 * The largest single XML element we will buffer. Apple's `<Record>` elements are
 * a few hundred bytes; the `<!DOCTYPE ... [` internal subset is a few KB. A
 * "tag" larger than this means the file is not really Apple Health XML (or an
 * unterminated quote has swallowed the document), so we resynchronise instead of
 * growing the buffer without bound.
 */
const MAX_ELEMENT_CHARS = 1024 * 1024;

/**
 * `parse()` (the non-streaming path) refuses above this. It is deliberately far
 * below V8's string limit: by the time a caller has a 64MB string in hand the
 * damage — the base64 decode, the JSON body, the copy — is already done.
 * See the INTEGRATION NOTE at the bottom of this file.
 */
const MAX_INLINE_CHARS = 32 * 1024 * 1024;

/** Cap on how many rejected records we keep. Beyond this we only count. */
const MAX_REJECTED_KEPT = 200;

/** Cap on distinct unknown record types reported. */
const MAX_UNKNOWN_TYPES = 200;

/**
 * How many recent sample keys the de-duplicator remembers. Apple's export is
 * written in roughly ascending `startDate` order, so a sliding window catches the
 * multi-source duplicates (which are adjacent) without an unbounded Set.
 * Held twice over (two generations), so peak is 2x this.
 */
const DEFAULT_DEDUPE_WINDOW = 50000;

/** Per-day cap on retained individual samples for median-style metrics. */
const MAX_SAMPLES_PER_DAY_METRIC = 4000;

/* ------------------------------------------------------------------ *
 * Sleep constants
 * ------------------------------------------------------------------ */

/**
 * Asleep intervals closer together than this belong to the same sleep session.
 * Apple emits one `<Record>` per stage transition, so a night is dozens of
 * adjacent intervals; a bathroom trip is a 10-20 minute gap.
 */
const SESSION_GAP_MS = 60 * 60 * 1000;

/** Rule 3: a nap must never inflate nightly sleep. */
const NAP_MAX_MINUTES = 180;
/** Local-clock window in which a short sleep is read as a nap, not a night. */
const NAP_START_HOUR_MIN = 8;
const NAP_START_HOUR_MAX = 20; // exclusive

/* ------------------------------------------------------------------ *
 * Type mapping (rule 1: never by position, always through a table)
 * ------------------------------------------------------------------ */

const QUANTITY_PREFIX = 'HKQuantityTypeIdentifier';
const CATEGORY_PREFIX = 'HKCategoryTypeIdentifier';
const SLEEP_VALUE_PREFIX = 'HKCategoryValueSleepAnalysis';

/**
 * Apple record type (with the `HKQuantityTypeIdentifier` prefix stripped) -> how
 * we aggregate it. `agg` values:
 *   'sum'    cumulative over the day (steps, energy, exercise minutes)
 *   'median' a spot reading sampled many times a day; the median is robust to
 *            the one artefact reading a wrist-worn optical sensor always produces
 *   'mean'   a value Apple already computes once or twice a day
 *   'hr'     the special heart-rate accumulator (mean + max, no sample retention)
 */
const RECORD_TYPES = {
  HeartRateVariabilitySDNN: { field: 'hrvMs', agg: 'sdnn', unit: 'ms' },
  RestingHeartRate: { field: 'restingHr', agg: 'mean', unit: 'count/min' },
  OxygenSaturation: { field: 'spo2', agg: 'median', unit: '%' },
  RespiratoryRate: { field: 'respiratoryRate', agg: 'median', unit: 'count/min' },
  AppleSleepingWristTemperature: { field: 'skinTemp', agg: 'temp', unit: 'degC' },
  HeartRate: { field: 'hr', agg: 'hr', unit: 'count/min' },
  ActiveEnergyBurned: { field: 'activeKcal', agg: 'energy', unit: 'kcal' },
  BasalEnergyBurned: { field: 'basalKcal', agg: 'energy', unit: 'kcal' },
  StepCount: { field: 'steps', agg: 'sum', unit: 'count' },
  AppleExerciseTime: { field: 'activeMinutes', agg: 'sum', unit: 'min' },
  // Category type — handled entirely separately by the sleep sessioniser.
  SleepAnalysis: { field: 'sleep', agg: 'sleep', unit: null }
};

/**
 * Types whose day total is a SUM. These are the ones a duplicate source
 * silently doubles; a duplicated median or mean is harmless.
 */
const CUMULATIVE_TYPES = new Set([
  'StepCount', 'ActiveEnergyBurned', 'BasalEnergyBurned', 'AppleExerciseTime'
]);

/**
 * Apple's sleep category values, prefix-stripped and lowercased.
 * iOS 16+ emits the staged values; anything older emits a bare `Asleep`.
 */
const SLEEP_STAGES = {
  asleepcore: 'core',
  asleepdeep: 'deep',
  asleeprem: 'rem',
  asleepunspecified: 'asleep',
  asleep: 'asleep', // pre-iOS-16 fallback: sleep with no stage breakdown
  awake: 'awake',
  inbed: 'inbed'
};

/** Stages that count toward time asleep. `inbed` and `awake` never do. */
const ASLEEP_STAGES = new Set(['core', 'deep', 'rem', 'asleep']);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function round(n, digits) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function median(list) {
  if (!list || !list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(list) {
  if (!list || !list.length) return null;
  let t = 0;
  for (let i = 0; i < list.length; i += 1) t += list[i];
  return t / list.length;
}

/** Local hour (0-23) of an instant in `tz`. Used only for the nap heuristic. */
function hourInTz(epochMs, tz) {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || WHOOP_TZ, hour: '2-digit', hourCycle: 'h23'
    }).format(new Date(epochMs));
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return new Date(epochMs).getUTCHours();
  }
}

/** Total covered minutes of a set of [startMs,endMs) intervals, overlaps merged. */
function unionMinutes(intervals) {
  if (!intervals || !intervals.length) return 0;
  const s = intervals.slice().sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let cs = s[0].startMs;
  let ce = s[0].endMs;
  for (let i = 1; i < s.length; i += 1) {
    const iv = s[i];
    if (iv.startMs > ce) { total += ce - cs; cs = iv.startMs; ce = iv.endMs; }
    else if (iv.endMs > ce) ce = iv.endMs;
  }
  total += ce - cs;
  return total / 60000;
}

/**
 * Strip an `HK...TypeIdentifier` prefix. Returns the bare type name, e.g.
 * `HKQuantityTypeIdentifierStepCount` -> `StepCount`.
 */
function shortType(type) {
  const s = String(type || '');
  if (s.indexOf(QUANTITY_PREFIX) === 0) return s.slice(QUANTITY_PREFIX.length);
  if (s.indexOf(CATEGORY_PREFIX) === 0) return s.slice(CATEGORY_PREFIX.length);
  return s;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five XML predefined entities plus numeric references. */
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

/**
 * Apple writes the device as an opaque blob that itself contains `>` characters:
 *   device="&lt;&lt;HKDevice: 0x2823&gt;, name:Apple Watch, manufacturer:Apple Inc.,
 *            model:Watch, hardware:Watch6,2, software:10.1&gt;"
 * Pull a human label out of it, or fall back to the sourceName.
 */
function deviceLabel(deviceAttr, sourceName) {
  const d = String(deviceAttr || '');
  const name = /(?:^|,)\s*name:([^,>]+)/.exec(d);
  // hardware values legitimately contain a comma: "Watch6,2", "iPhone15,2".
  const hw = /hardware:([A-Za-z0-9]+(?:,[0-9]+)?)/.exec(d);
  if (name) {
    const base = name[1].trim();
    return hw ? base + ' (' + hw[1].trim() + ')' : base;
  }
  const sn = String(sourceName || '').trim();
  return sn || null;
}

/**
 * Source priority for de-duplication ties and for which device we credit a day
 * to. The Apple Watch is the only source here that actually has the sensors; the
 * iPhone infers steps from its accelerometer and third-party apps re-write data
 * they got from somewhere else.
 *
 * UNVERIFIED: Apple's own Health app uses a private, user-reorderable source
 * priority list that is NOT present in export.xml. A real export from a member
 * with several fitness apps would confirm whether matching on the string "Watch"
 * is sufficient in non-English locales (`sourceName` is localised).
 */
function sourcePriority(sourceName, deviceAttr) {
  const s = (String(sourceName || '') + ' ' + String(deviceAttr || '')).toLowerCase();
  if (/apple\s*watch|hardware:watch/.test(s)) return 3;
  if (/iphone/.test(s)) return 2;
  return 1;
}

/* ------------------------------------------------------------------ *
 * 1. The incremental XML scanner
 * ------------------------------------------------------------------ *
 *
 * Not a parser — a scanner. It finds element start tags and hands their
 * attributes to a callback, and it discards everything else (text, close tags,
 * the DOCTYPE internal subset, comments). That is all an Apple Health export
 * needs, and it means the scanner's memory is O(one element), not O(document).
 *
 * The four things that break naive implementations, all handled here:
 *   a) attribute values containing `>` — `findTagEnd` is quote-aware;
 *   b) self-closing `<Record ... />` vs `<Record ...>...</Record>` — both occur,
 *      the second whenever a record carries `<MetadataEntry>` children;
 *   c) nested children — `MetadataEntry`, `HeartRateVariabilityMetadataList` and
 *      `InstantaneousBeatsPerMinute` are simply not in the wanted set, so they
 *      fall out with no state machine at all;
 *   d) an element split across a chunk boundary — the tail of the buffer is kept
 *      and re-scanned when the next chunk arrives. `tests/wearables-apple.js`
 *      proves this by feeding the same document 7 bytes at a time.
 */

/** Index of the `>` that closes the tag starting at `start`, or -1 if truncated. */
function findTagEnd(s, start) {
  let quote = 0; // 0 none, 1 double, 2 single
  for (let k = start + 1; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (quote === 1) { if (c === 34) quote = 0; continue; }
    if (quote === 2) { if (c === 39) quote = 0; continue; }
    if (c === 34) { quote = 1; continue; }
    if (c === 39) { quote = 2; continue; }
    if (c === 62) return k; // '>'
  }
  return -1;
}

const ATTR_RE = /([A-Za-z_:][-\w.:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse the attributes out of a raw start tag. */
function parseAttrs(raw) {
  const attrs = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(raw);
  while (m) {
    const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
    attrs[m[1]] = decodeEntities(v);
    m = ATTR_RE.exec(raw);
  }
  return attrs;
}

const TAG_NAME_RE = /^<\s*([A-Za-z_][-\w.:]*)/;

/**
 * Create a chunk-fed scanner.
 *
 * @param {Set<string>} wanted element names to report
 * @param {(name:string, attrs:Object, selfClosing:boolean)=>void} onOpen
 * @param {(name:string)=>void} [onClose] close tags, filtered by `wanted`
 * @param {(reason:string, sample:string)=>void} [onDesync]
 * @returns {{write:(s:string)=>void, end:()=>void}}
 */
function createScanner(wanted, onOpen, onClose, onDesync) {
  let buf = '';

  function drain(final) {
    let i = 0;
    for (;;) {
      const lt = buf.indexOf('<', i);
      if (lt === -1) { i = buf.length; break; }

      if (buf.startsWith('<!--', lt)) {
        const e = buf.indexOf('-->', lt + 4);
        if (e === -1) { i = lt; break; }
        i = e + 3;
        continue;
      }
      if (buf.startsWith('<![CDATA[', lt)) {
        const e = buf.indexOf(']]>', lt + 9);
        if (e === -1) { i = lt; break; }
        i = e + 3;
        continue;
      }

      const end = findTagEnd(buf, lt);
      if (end === -1) {
        // Truncated tag. Normally we wait for the next chunk — unless it has
        // grown past anything a real element could be, which means the document
        // is malformed (typically an unbalanced quote). Resynchronise on the next
        // '<' rather than buffering the rest of a 1.5GB file into memory.
        if (buf.length - lt > MAX_ELEMENT_CHARS) {
          if (onDesync) onDesync('unterminated element', buf.slice(lt, lt + 120));
          i = lt + 1;
          continue;
        }
        i = lt;
        break;
      }

      const raw = buf.slice(lt, end + 1);
      const c1 = raw.charAt(1);
      if (c1 === '/') {
        const cm = /^<\/\s*([A-Za-z_][-\w.:]*)/.exec(raw);
        if (cm && onClose && wanted.has(cm[1])) onClose(cm[1]);
      } else if (c1 !== '!' && c1 !== '?') {
        const nm = TAG_NAME_RE.exec(raw);
        if (nm && wanted.has(nm[1])) {
          onOpen(nm[1], parseAttrs(raw), /\/\s*>$/.test(raw));
        }
      }
      i = end + 1;
    }

    buf = i >= buf.length ? '' : buf.slice(i);
    if (final && buf.length && onDesync && buf.indexOf('<') !== -1) {
      onDesync('truncated document', buf.slice(0, 120));
    }
  }

  return {
    write(chunk) { buf += chunk; drain(false); },
    end() { drain(true); }
  };
}

/* ------------------------------------------------------------------ *
 * 2. De-duplication
 * ------------------------------------------------------------------ */

/**
 * A bounded "have I seen this sample" set.
 *
 * The key is `(type, startDate, endDate, value)` exactly as specified. Note what
 * that key implies: two records sharing it have the SAME NUMBER, so which of them
 * we keep cannot change any total. Source priority therefore does not need to
 * win a race here — it is used to decide which device we credit the day to, and
 * to break ties in the overlap suppressor below.
 *
 * Memory: Apple writes records in roughly ascending startDate order, so genuine
 * duplicates are adjacent. Two generations of a Set, rotated at `limit`, keep the
 * footprint bounded at 2x`limit` keys regardless of file size. A duplicate pair
 * separated by more than that window is missed — reported, not hidden, in
 * `summary.notes`.
 */
function createDedupe(limit) {
  let cur = new Set();
  let prev = new Set();
  let rotations = 0;
  return {
    seen(key) {
      if (cur.has(key) || prev.has(key)) return true;
      cur.add(key);
      if (cur.size >= limit) { prev = cur; cur = new Set(); rotations += 1; }
      return false;
    },
    get rotations() { return rotations; }
  };
}

/* ------------------------------------------------------------------ *
 * 3. The aggregator
 * ------------------------------------------------------------------ */

function newDayBucket(date) {
  return {
    date,
    hrvSamples: [],      // {epochMs, v}
    rhr: [],
    spo2: [],
    resp: [],
    temp: [],            // {v, unit}
    hr: { sum: 0, n: 0, max: null },
    activeKcal: null,
    basalKcal: null,
    steps: null,
    activeMinutes: null,
    // sourceName -> kcal/steps, kept only to warn about multi-source totals
    cumulativeBySource: Object.create(null),
    devicePriority: 0,
    deviceModel: null
  };
}

/**
 * Create the streaming state machine. Feed it chunks of XML through `write()`,
 * call `end()`, then `finish()` for the contract shape.
 *
 * @param {Object} [opts]
 * @param {string} [opts.timezone] IANA zone for day attribution (default Asia/Kolkata)
 * @param {number} [opts.dedupeWindow]
 * @param {boolean} [opts.suppressOverlaps] drop a lower-priority cumulative sample
 *        fully covered by a higher-priority one (default true)
 * @returns {{write:Function, end:Function, finish:Function, note:Function}}
 */
function createAggregator(opts) {
  const options = opts || {};
  const tz = options.timezone || WHOOP_TZ;
  const suppressOverlaps = options.suppressOverlaps !== false;
  const dedupe = createDedupe(options.dedupeWindow || DEFAULT_DEDUPE_WINDOW);

  const days = new Map();          // 'YYYY-MM-DD' -> bucket
  const sleepIntervals = [];       // {startMs, endMs, stage, source, priority}
  const workouts = [];
  const rejected = [];
  const notes = [];
  const unknownTypes = new Map();  // type -> count
  const sources = new Map();       // sourceName -> count

  let rowsParsed = 0;
  let rowsRejected = 0;
  let duplicatesDropped = 0;
  let overlapsDropped = 0;
  let unknownTypeOverflow = 0;
  let pendingWorkout = null;

  // Last accepted cumulative sample per (type|priority) — the overlap suppressor's
  // one-slot memory. Bounded by construction.
  const lastCumulative = new Map();

  function reject(reason, attrs) {
    rowsRejected += 1;
    if (rejected.length < MAX_REJECTED_KEPT) {
      rejected.push({
        file: options.file || 'export.xml',
        rowNumber: null,
        reason,
        raw: attrs || null
      });
    }
  }

  function note(text) { if (notes.indexOf(text) === -1) notes.push(text); }

  function dayFor(date) {
    let b = days.get(date);
    if (!b) { b = newDayBucket(date); days.set(date, b); }
    return b;
  }

  function pushCapped(arr, v) {
    if (arr.length < MAX_SAMPLES_PER_DAY_METRIC) arr.push(v);
  }

  /* ---------------- sleep ---------------- */

  function handleSleep(attrs, startP, endP) {
    if (!startP || startP.epochMs == null || !endP || endP.epochMs == null) {
      reject('sleep record without a resolvable start/end instant', attrs);
      return;
    }
    if (endP.epochMs <= startP.epochMs) {
      reject('sleep record ends at or before it starts', attrs);
      return;
    }
    const rawValue = String(attrs.value || '');
    const key = rawValue.indexOf(SLEEP_VALUE_PREFIX) === 0
      ? rawValue.slice(SLEEP_VALUE_PREFIX.length).toLowerCase()
      : rawValue.toLowerCase();
    const stage = SLEEP_STAGES[key];
    if (!stage) {
      // Never guess a stage. An unrecognised value is surfaced, not folded into
      // "asleep" — folding an unknown into asleep is how nightly sleep silently
      // grows by an hour after an iOS update.
      reject('unrecognised SleepAnalysis value ' + JSON.stringify(rawValue), attrs);
      return;
    }
    sleepIntervals.push({
      startMs: startP.epochMs,
      endMs: endP.epochMs,
      stage,
      source: String(attrs.sourceName || ''),
      priority: sourcePriority(attrs.sourceName, attrs.device)
    });
    rowsParsed += 1;
  }

  /* ---------------- quantity records ---------------- */

  function handleRecord(attrs) {
    const type = attrs.type;
    if (!type) { reject('record without a type attribute', attrs); return; }

    const short = shortType(type);
    const spec = RECORD_TYPES[short];
    if (!spec) {
      const n = unknownTypes.get(short);
      if (n !== undefined) unknownTypes.set(short, n + 1);
      else if (unknownTypes.size < MAX_UNKNOWN_TYPES) unknownTypes.set(short, 1);
      else unknownTypeOverflow += 1;
      return; // not an error — Apple exports 100+ types we have no field for
    }

    const startP = attrs.startDate ? parseTimestamp(attrs.startDate) : null;
    if (!startP) {
      reject('unparseable startDate ' + JSON.stringify(attrs.startDate || ''), attrs);
      return;
    }
    const endP = attrs.endDate ? parseTimestamp(attrs.endDate) : startP;

    // Rule: de-duplicate BEFORE aggregating, on (type, startDate, endDate, value).
    const dupKey = short + '|' + (attrs.startDate || '') + '|' + (attrs.endDate || '')
      + '|' + (attrs.value === undefined ? '' : attrs.value);
    if (dedupe.seen(dupKey)) {
      duplicatesDropped += 1;
      return;
    }

    if (spec.agg === 'sleep') { handleSleep(attrs, startP, endP); return; }

    const value = toNum(attrs.value);
    if (value === null) {
      reject('non-numeric value ' + JSON.stringify(attrs.value || '') + ' for ' + short, attrs);
      return;
    }

    // Attribution for a quantity sample is the calendar date of its START in the
    // member's timezone. (Sleep is the exception — rule 2, handled above.)
    const date = ymdInTz(attrs.startDate, tz);
    if (!date) { reject('could not attribute a calendar date for ' + short, attrs); return; }

    const priority = sourcePriority(attrs.sourceName, attrs.device);

    if (suppressOverlaps && CUMULATIVE_TYPES.has(short) && endP && endP.epochMs != null
        && startP.epochMs != null) {
      const prev = lastCumulative.get(short);
      if (prev && prev.priority > priority
          && startP.epochMs >= prev.startMs && endP.epochMs <= prev.endMs) {
        // A lower-priority source restating an interval a higher-priority one
        // already covered — the classic iPhone-mirrors-the-Watch double count.
        overlapsDropped += 1;
        return;
      }
      if (!prev || priority >= prev.priority || startP.epochMs > prev.endMs) {
        lastCumulative.set(short, { priority, startMs: startP.epochMs, endMs: endP.epochMs });
      }
    }

    const bucket = dayFor(date);
    // Credit the day to the best evidence we have: highest source priority, and
    // within that, a record that actually carried a `device` blob (which names the
    // hardware) over one that only had a sourceName.
    const rank = priority * 2 + (attrs.device ? 1 : 0);
    if (rank > bucket.devicePriority) {
      bucket.devicePriority = rank;
      const label = deviceLabel(attrs.device, attrs.sourceName);
      if (label) bucket.deviceModel = label;
    }

    const sn = String(attrs.sourceName || 'unknown');
    sources.set(sn, (sources.get(sn) || 0) + 1);

    switch (spec.agg) {
      case 'sdnn':
        pushCapped(bucket.hrvSamples, { epochMs: startP.epochMs, v: value });
        break;
      case 'mean':
        pushCapped(bucket.rhr, value);
        break;
      case 'median':
        if (spec.field === 'spo2') pushCapped(bucket.spo2, normalizeSpo2(value, attrs.unit));
        else pushCapped(bucket.resp, value);
        break;
      case 'temp':
        pushCapped(bucket.temp, { v: value, unit: attrs.unit || spec.unit });
        break;
      case 'hr':
        bucket.hr.sum += value;
        bucket.hr.n += 1;
        if (bucket.hr.max === null || value > bucket.hr.max) bucket.hr.max = value;
        break;
      case 'energy': {
        const e = canonicalizeEnergy(attrs.value, attrs.unit || spec.unit);
        if (e.energyKcal === null) { reject('unreadable energy value for ' + short, attrs); return; }
        bucket[spec.field] = (bucket[spec.field] || 0) + e.energyKcal;
        bucket.cumulativeBySource[short + '|' + sn] =
          (bucket.cumulativeBySource[short + '|' + sn] || 0) + e.energyKcal;
        break;
      }
      case 'sum':
        bucket[spec.field] = (bucket[spec.field] || 0) + value;
        bucket.cumulativeBySource[short + '|' + sn] =
          (bucket.cumulativeBySource[short + '|' + sn] || 0) + value;
        break;
      default:
        return;
    }
    rowsParsed += 1;
  }

  /**
   * Apple exports SpO2 as a FRACTION with `unit="%"` — `value="0.97"` means 97%.
   *
   * UNVERIFIED: this is HKUnit.percent() semantics (0..1) and matches every
   * export.xml sample I have seen described, but a real multi-device export would
   * confirm that no third-party app writes 97 directly. The magnitude test below
   * makes either encoding safe: nothing between 1.5 and 50 is a plausible SpO2,
   * so the two representations cannot be confused.
   */
  function normalizeSpo2(value, unit) {
    const isPercentUnit = !unit || /%|percent/i.test(String(unit));
    if (isPercentUnit && value > 0 && value <= 1.5) return round(value * 100, 1);
    return round(value, 1);
  }

  /* ---------------- workouts ---------------- */

  function flushWorkout() {
    if (!pendingWorkout) return;
    workouts.push(pendingWorkout);
    pendingWorkout = null;
  }

  function handleWorkout(attrs) {
    flushWorkout();
    const startRaw = attrs.startDate;
    const p = startRaw ? parseTimestamp(startRaw) : null;
    if (!p) { reject('workout without a parseable startDate', attrs); return; }
    const date = ymdInTz(startRaw, tz);
    if (!date) { reject('workout start could not be attributed to a date', attrs); return; }
    const pe = attrs.endDate ? parseTimestamp(attrs.endDate) : null;

    let durationMin = toNum(attrs.duration);
    const du = String(attrs.durationUnit || 'min').toLowerCase();
    if (durationMin !== null) {
      if (du === 's' || du === 'sec' || du === 'second') durationMin /= 60;
      else if (du === 'h' || du === 'hr' || du === 'hour') durationMin *= 60;
    }

    const energy = attrs.totalEnergyBurned !== undefined
      ? canonicalizeEnergy(attrs.totalEnergyBurned, attrs.totalEnergyBurnedUnit || 'kcal')
      : { energyKcal: null };

    pendingWorkout = {
      date,
      startedAt: p.iso || p.localYmd,
      endedAt: pe ? (pe.iso || pe.localYmd) : null,
      durationMin: round(durationMin, 2),
      activity: String(attrs.workoutActivityType || '').replace(/^HKWorkoutActivityType/, '') || null,
      // Apple ships no strain metric. Rule 5: leave it null, never approximate.
      strain: null,
      energyKcal: energy.energyKcal,
      maxHr: null,
      avgHr: null,
      zones: { z1: null, z2: null, z3: null, z4: null, z5: null }
    };
  }

  /**
   * iOS 15+ moved workout totals out of the `<Workout>` attributes and into
   * `<WorkoutStatistics>` children. Both shapes are handled.
   */
  function handleWorkoutStatistics(attrs) {
    if (!pendingWorkout) return;
    const short = shortType(attrs.type);
    if (short === 'ActiveEnergyBurned') {
      const e = canonicalizeEnergy(attrs.sum, attrs.unit || 'kcal');
      if (e.energyKcal !== null) {
        pendingWorkout.energyKcal = (pendingWorkout.energyKcal || 0) + e.energyKcal;
      }
    } else if (short === 'HeartRate') {
      const avg = toNum(attrs.average);
      const mx = toNum(attrs.maximum);
      if (avg !== null) pendingWorkout.avgHr = round(avg, 1);
      if (mx !== null) pendingWorkout.maxHr = round(mx, 1);
    }
  }

  const WANTED = new Set(['Record', 'Workout', 'WorkoutStatistics']);

  const scanner = createScanner(
    WANTED,
    (name, attrs) => {
      if (name === 'Record') handleRecord(attrs);
      else if (name === 'Workout') handleWorkout(attrs);
      else handleWorkoutStatistics(attrs);
    },
    null,
    (reason, sample) => {
      reject('XML scanner desync: ' + reason, { sample });
    }
  );

  /* ---------------- sleep sessionisation (rules 2 and 3) ---------------- */

  /**
   * Group raw stage intervals into sessions, decide which session is THE night,
   * and make sure every other one lands in `napMinutes`.
   *
   * @returns {Map<string,{sleepMinutes:number, remMin:number|null, deepMin:number|null,
   *          lightMin:number|null, awakeMin:number|null, inBedMin:number|null,
   *          napMinutes:number, staged:boolean, stageNote:string|null}>}
   */
  function sessionise() {
    const out = new Map();
    if (!sleepIntervals.length) return out;

    const asleep = sleepIntervals.filter((iv) => ASLEEP_STAGES.has(iv.stage))
      .sort((a, b) => a.startMs - b.startMs);
    if (!asleep.length) return out;

    // Build sessions: consecutive asleep intervals separated by < SESSION_GAP_MS.
    const sessions = [];
    let cur = { startMs: asleep[0].startMs, endMs: asleep[0].endMs, items: [asleep[0]] };
    for (let i = 1; i < asleep.length; i += 1) {
      const iv = asleep[i];
      if (iv.startMs - cur.endMs > SESSION_GAP_MS) {
        sessions.push(cur);
        cur = { startMs: iv.startMs, endMs: iv.endMs, items: [iv] };
      } else {
        cur.items.push(iv);
        if (iv.endMs > cur.endMs) cur.endMs = iv.endMs;
      }
    }
    sessions.push(cur);

    const awakeAll = sleepIntervals.filter((iv) => iv.stage === 'awake');
    const inBedAll = sleepIntervals.filter((iv) => iv.stage === 'inbed');

    const byDate = new Map();

    sessions.forEach((s) => {
      // Rule 2: a night belongs to the calendar date of its WAKE time.
      const date = ymdInTz(new Date(s.endMs).toISOString(), tz);
      if (!date) return;

      const sleepMinutes = unionMinutes(s.items);

      // Rule 3: a short sleep starting in daylight hours is a nap, full stop.
      const startHour = hourInTz(s.startMs, tz);
      const isNap = sleepMinutes < NAP_MAX_MINUTES
        && startHour !== null
        && startHour >= NAP_START_HOUR_MIN
        && startHour < NAP_START_HOUR_MAX;

      // Stages come from ONE source only. Two sources staging the same night
      // (a Watch and a third-party sleep app) would otherwise sum to more sleep
      // than the night contained, and the contract validator would reject the day.
      let staged = false;
      let rem = null;
      let deep = null;
      let light = null;
      let stageNote = null;
      if (!isNap) {
        const byPriority = new Map();
        s.items.forEach((iv) => {
          if (iv.stage === 'asleep') return; // unstaged, pre-iOS-16
          const k = iv.source + '#' + iv.priority;
          if (!byPriority.has(k)) byPriority.set(k, { priority: iv.priority, items: [] });
          byPriority.get(k).items.push(iv);
        });
        let best = null;
        byPriority.forEach((entry) => {
          const mins = unionMinutes(entry.items);
          if (!best || entry.priority > best.priority
              || (entry.priority === best.priority && mins > best.mins)) {
            best = { priority: entry.priority, mins, items: entry.items };
          }
        });
        if (best) {
          const pick = (st) => {
            const sub = best.items.filter((iv) => iv.stage === st);
            return sub.length ? round(unionMinutes(sub), 1) : null;
          };
          rem = pick('rem');
          deep = pick('deep');
          light = pick('core');
          const total = (rem || 0) + (deep || 0) + (light || 0);
          if (total > sleepMinutes * 1.03 + 1) {
            // Should be impossible once staging is single-source, but never ship a
            // day that violates the contract: drop the breakdown and say so.
            rem = null; deep = null; light = null;
            stageNote = 'sleep stages exceeded the session length on ' + date
              + '; stage breakdown dropped rather than scaled';
          } else {
            staged = total > 0;
          }
        }
      }

      const overlaps = (iv) => iv.endMs > s.startMs && iv.startMs < s.endMs;
      const awakeMin = isNap ? null : round(unionMinutes(awakeAll.filter(overlaps)), 1);
      const inBedMin = isNap ? null : round(unionMinutes(inBedAll.filter(overlaps)), 1);

      const rec = {
        date,
        isNap,
        startMs: s.startMs,
        endMs: s.endMs,
        sleepMinutes: round(sleepMinutes, 1),
        remMin: rem,
        deepMin: deep,
        lightMin: light,
        awakeMin: awakeMin === 0 ? null : awakeMin,
        inBedMin: inBedMin === 0 ? null : inBedMin,
        staged,
        stageNote
      };
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(rec);
    });

    byDate.forEach((list, date) => {
      const nights = list.filter((r) => !r.isNap);
      const napsOnly = list.filter((r) => r.isNap);
      let night = null;
      let napMinutes = 0;
      napsOnly.forEach((r) => { napMinutes += r.sleepMinutes; });

      if (nights.length) {
        night = nights.reduce((a, b) => (b.sleepMinutes > a.sleepMinutes ? b : a));
        // A second full-length sleep on one date cannot both be "the night".
        // Whoop's parser drops the loser; we keep its minutes as nap time so the
        // total sleep a member sees is never smaller than what they recorded.
        nights.forEach((r) => { if (r !== night) napMinutes += r.sleepMinutes; });
        if (nights.length > 1) {
          note(nights.length + ' nightly sleep sessions landed on ' + date
            + '; kept the longest as the night, the rest counted as naps');
        }
      }

      if (night && night.stageNote) note(night.stageNote);

      out.set(date, {
        // The night's clock window, so the HRV picker can prefer the spot checks
        // the watch took while the member was actually asleep.
        nightStartMs: night ? night.startMs : null,
        nightEndMs: night ? night.endMs : null,
        sleepMinutes: night ? night.sleepMinutes : null,
        remMin: night ? night.remMin : null,
        deepMin: night ? night.deepMin : null,
        lightMin: night ? night.lightMin : null,
        awakeMin: night ? night.awakeMin : null,
        inBedMin: night ? night.inBedMin : null,
        napMinutes: round(napMinutes, 1),
        staged: night ? night.staged : false
      });
    });

    return out;
  }

  /* ---------------- finish ---------------- */

  function finish(meta) {
    flushWorkout();

    const implausible = [];
    const sleepByDate = sessionise();
    sleepByDate.forEach((_v, date) => { if (!days.has(date)) days.set(date, newDayBucket(date)); });

    const dates = Array.from(days.keys()).sort();
    const outDays = dates.map((date) => {
      const b = days.get(date);
      const day = C.emptyCanonicalDay(date, PROVIDER);
      day.measurementSource = C.MEASUREMENT_SOURCE.DEVICE_EXPORT;
      day.deviceModel = b.deviceModel;

      const set = (field, value) => applyMetric(day, field, value, implausible);

      /* ── HRV: SDNN, and it must stay labelled as SDNN forever ──────────── */
      if (b.hrvSamples.length) {
        // Prefer the samples taken during the night this day is attributed to.
        // Apple takes spot readings around the clock; a daytime reading taken
        // mid-conversation is not comparable with a sleeping one, and the night
        // sample is the closest analogue to what other devices report — but it is
        // still SDNN, and it is still a spot check, so the tag does not change.
        const sleepRec = sleepByDate.get(date);
        let picked = null;
        let pickedFrom = 'all_day_median';
        if (sleepRec && sleepRec.nightStartMs !== null && sleepRec.nightEndMs !== null) {
          const nightSamples = b.hrvSamples
            .filter((s) => s.epochMs >= sleepRec.nightStartMs && s.epochMs <= sleepRec.nightEndMs)
            .map((s) => s.v);
          if (nightSamples.length) { picked = median(nightSamples); pickedFrom = 'sleep_window_median'; }
        }
        if (picked === null) picked = median(b.hrvSamples.map((s) => s.v));
        set('hrvMs', round(picked, 1));
        day.providerScores['apple.hrv_window'] = pickedFrom;
        if (day.hrvMs !== null) {
          // ────────────────────────────────────────────────────────────────
          // NEVER change this to RMSSD_SLEEP, and NEVER apply a conversion.
          // Apple measures SDNN over roughly 60 seconds. It is a different
          // statistic from the overnight RMSSD Whoop/Oura/Fitbit report and it
          // runs materially higher. No published SDNN->RMSSD conversion is valid
          // per-individual; applying one would corrupt every trend downstream in
          // a way that still looks plausible on a chart.
          // ────────────────────────────────────────────────────────────────
          day.hrvMethod = C.HRV_METHOD.SDNN_SPOT;
        }
        day.providerScores['apple.hrv_sdnn_sample_count'] = b.hrvSamples.length;
      }

      set('restingHr', round(mean(b.rhr), 1));
      set('spo2', round(median(b.spo2), 1));
      set('respiratoryRate', round(median(b.resp), 2));

      /* ── Temperature: absolute vs deviation, never mixed ──────────────── */
      if (b.temp.length) {
        // canonicalizeTemp() also catches an account exporting Fahrenheit.
        const cs = b.temp
          .map((t) => canonicalizeTemp(t.v, t.unit))
          .filter((t) => t.skinTempC !== null);
        if (cs.length) {
          const avgC = mean(cs.map((t) => t.skinTempC));
          day.skinTempRaw = round(mean(b.temp.map((t) => t.v)), 3);
          day.skinTempUnit = cs[0].skinTempUnit;
          // ── DECIDED: Apple wrist temperature is stored as an ABSOLUTE ─────
          //
          // deviceRegistry.js declares apple_health with tempBasis
          // 'deviation_c', reasoning from the Health app's UI, which shows a
          // nightly "+0.3" against the wearer's baseline. That describes the
          // PRESENTATION, not the sample. The record in export.xml is
          //   <Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature"
          //           unit="degC" ... value="33.42"/>
          // — an absolute skin temperature in degrees Celsius, of the magnitude
          // an absolute wrist reading has and nothing like a delta. The baseline
          // Apple subtracts to produce its "+0.3" is private to the device and
          // does not appear anywhere in the export, so we could not reproduce
          // their deviation even if we wanted to.
          //
          // We therefore store the measurement and let
          // services/wearables/baselineService.js derive deviations from a
          // trailing per-member window, which is both better science than a
          // guessed baseline and the one place that knows to segregate by tag.
          // An adapter minting its own baseline would lock in a worse one and
          // duplicate that engine.
          //
          // THE TAG DESCRIBES WHAT THIS ADAPTER ACTUALLY WROTE — it is never
          // copied from the registry. skinTempC + 'absolute_c', or
          // skinTempDeviationC + 'deviation_c'. Never both; validateCanonicalDay
          // rejects a day carrying both, and rightly.
          //
          // UNVERIFIED: a real Series 8+/Ultra export would confirm the absolute
          // encoding and the exact `degC` unit string. The magnitude test below
          // makes us safe either way: if some writer ever does put a delta in
          // this field, a value of |x| <= 10 cannot be an absolute wrist
          // temperature, so it is routed to skinTempDeviationC with the matching
          // basis. Neither field can ever receive the wrong kind of number.
          if (Math.abs(avgC) <= 10) {
            set('skinTempDeviationC', round(avgC, 2));
            if (day.skinTempDeviationC !== null) day.tempBasis = C.TEMP_BASIS.DEVIATION_C;
            note('AppleSleepingWristTemperature arrived as a small magnitude and was '
              + 'stored as a baseline deviation, not an absolute temperature');
          } else {
            set('skinTempC', round(avgC, 2));
            if (day.skinTempC !== null) day.tempBasis = C.TEMP_BASIS.ABSOLUTE_C;
          }
        }
      }

      /* ── Heart rate ──────────────────────────────────────────────────── */
      if (b.hr.n > 0) {
        set('avgHr', round(b.hr.sum / b.hr.n, 1));
        set('maxHr', round(b.hr.max, 0));
      }

      /* ── Energy: active + basal is the day's total burn ───────────────── */
      if (b.activeKcal !== null || b.basalKcal !== null) {
        set('energyKcal', round((b.activeKcal || 0) + (b.basalKcal || 0), 1));
        if (b.activeKcal !== null) day.providerScores['apple.active_energy_kcal'] = round(b.activeKcal, 1);
        if (b.basalKcal !== null) day.providerScores['apple.basal_energy_kcal'] = round(b.basalKcal, 1);
      }

      set('steps', b.steps === null ? null : round(b.steps, 0));
      set('activeMinutes', b.activeMinutes === null ? null : round(b.activeMinutes, 0));

      /* ── Sleep (rules 2 and 3) ───────────────────────────────────────── */
      const sr = sleepByDate.get(date);
      if (sr) {
        set('sleepMinutes', sr.sleepMinutes);
        if (day.sleepMinutes !== null) {
          set('sleepHours', round(day.sleepMinutes / 60, 2));
          set('remMin', sr.remMin);
          set('deepMin', sr.deepMin);
          set('lightMin', sr.lightMin);
          set('awakeMin', sr.awakeMin);
          if (sr.inBedMin !== null && sr.inBedMin >= day.sleepMinutes && sr.inBedMin > 0) {
            // Arithmetic on two measured quantities, not an invented score.
            set('sleepEfficiencyPct', round((day.sleepMinutes / sr.inBedMin) * 100, 1));
          }
        } else {
          // No night — only naps. Stages would be meaningless without a night.
          day.remMin = null; day.deepMin = null; day.lightMin = null; day.awakeMin = null;
        }
        set('napMinutes', sr.napMinutes || 0);
        if (day.napMinutes === null) day.napMinutes = 0; // accumulator, never null
      }

      // If sanity nulled the night, the stage breakdown has nothing to belong to.
      if (day.sleepMinutes === null) {
        day.remMin = null; day.deepMin = null; day.lightMin = null;
        day.sleepHours = null;
        day.sleepEfficiencyPct = null;
      }

      /* ── What Apple does NOT have. Rule 5: never synthesise. ──────────── */
      day.recoveryScore = null;   // Apple ships no recovery score
      day.readinessScore = null;  // and no readiness score
      day.strain = null;          // and no strain metric

      day.confidence = APPLE_EXPORT_CONFIDENCE;

      // Multi-source cumulative warning: after exact-key de-duplication a day can
      // still hold steps from both the iPhone and the Watch for the same walk.
      const cumKeys = Object.keys(b.cumulativeBySource);
      if (cumKeys.length > 1) {
        const types = new Set(cumKeys.map((k) => k.split('|')[0]));
        types.forEach((t) => {
          const contributors = cumKeys.filter((k) => k.split('|')[0] === t);
          if (contributors.length > 1) {
            note(t + ' on ' + date + ' was written by ' + contributors.length
              + ' sources (' + contributors.map((k) => k.split('|')[1]).join(', ')
              + '); exact duplicates were removed but partial overlap may remain');
          }
        });
      }

      return day;
    });

    const workoutsOut = workouts.slice().sort((a, b) => (
      a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0
    ));

    if (duplicatesDropped) {
      note(duplicatesDropped + ' duplicate record(s) removed on (type, startDate, endDate, value)');
    }
    if (overlapsDropped) {
      note(overlapsDropped + ' cumulative sample(s) dropped as fully covered by a '
        + 'higher-priority source (Apple Watch over iPhone over third-party apps)');
    }
    if (dedupe.rotations > 0) {
      note('de-duplication ran with a sliding window of '
        + (options.dedupeWindow || DEFAULT_DEDUPE_WINDOW)
        + ' keys; duplicates separated by more than that window in the file are not detected');
    }
    if (unknownTypeOverflow) {
      note(unknownTypeOverflow + ' further unknown record type occurrence(s) not itemised');
    }
    if (rejected.length >= MAX_REJECTED_KEPT) {
      note('rejected-record list truncated at ' + MAX_REJECTED_KEPT + ' entries ('
        + rowsRejected + ' total)');
    }

    const unknownColumns = [];
    unknownTypes.forEach((count, type) => {
      unknownColumns.push({
        file: (meta && meta.file) || options.file || 'export.xml',
        kind: 'record-type',
        column: type,
        count
      });
    });

    const allDates = []
      .concat(outDays.map((d) => d.date))
      .concat(workoutsOut.map((w) => w.date))
      .filter(Boolean)
      .sort();

    return {
      days: outDays,
      workouts: workoutsOut,
      journal: [], // Apple Health has no journal / behaviour log
      summary: {
        provider: PROVIDER,
        filesSeen: (meta && meta.filesSeen) || [],
        rowsParsed,
        rowsRejected,
        dateRange: { from: allDates[0] || null, to: allDates[allDates.length - 1] || null },
        unknownColumns,
        duplicates: [{ kind: 'exact-key', dropped: duplicatesDropped },
          { kind: 'covered-interval', dropped: overlapsDropped }],
        implausible,
        notes,
        timezone: tz,
        sources: Array.from(sources.entries()).map(([name, count]) => ({ name, count }))
      },
      rejected
    };
  }

  return {
    write(chunk) { scanner.write(typeof chunk === 'string' ? chunk : String(chunk)); },
    end() { scanner.end(); },
    finish,
    note
  };
}

/**
 * Write a metric through the SANITY filter. Rule 4/5: a value outside its
 * physiological range is NOT clamped and NOT silently kept — it is nulled and
 * reported, so a unit bug surfaces as a warning rather than as a fact in a PDF.
 */
function applyMetric(day, field, value, implausible) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    day[field] = null;
    return;
  }
  const range = C.SANITY[field];
  if (!range) { day[field] = value; return; }
  if ((range[0] !== null && value < range[0]) || (range[1] !== null && value > range[1])) {
    implausible.push({
      date: day.date, field, value, range,
      reason: 'outside the plausible range; nulled rather than clamped'
    });
    day[field] = null;
    return;
  }
  day[field] = value;
}

/* ------------------------------------------------------------------ *
 * 4. Public entry points
 * ------------------------------------------------------------------ */

/** Contract-shaped result, with a `contractViolations` note if we ever break it. */
function selfCheck(out) {
  const check = C.validateParsedExport(out);
  if (!check.ok) {
    out.summary.notes = (out.summary.notes || []).concat(
      check.errors.slice(0, 20).map((e) => 'contract: ' + e)
    );
    out.summary.contractViolations = check.errors.length;
  }
  return out;
}

/**
 * Parse an Apple Health `export.xml` from a stream. THIS IS THE PRIMARY ENTRY
 * POINT — see the size discussion at the top of the file.
 *
 * @param {import('stream').Readable} readable
 * @param {Object} [opts] see createAggregator
 * @returns {Promise<{days:Object[], workouts:Object[], journal:Object[], summary:Object, rejected:Object[]}>}
 */
function parseStream(readable, opts) {
  return new Promise((resolve, reject) => {
    if (!readable || typeof readable.on !== 'function') {
      resolve(selfCheck(C.emptyParsedExport(PROVIDER, [
        'parseStream() was not given a readable stream'
      ])));
      return;
    }
    const options = opts || {};
    const agg = createAggregator(options);
    const name = options.file || 'export.xml';
    let bytes = 0;
    let settled = false;

    if (typeof readable.setEncoding === 'function') {
      // Decodes UTF-8 across chunk boundaries for us — a multi-byte character
      // split between two Buffers would otherwise become two replacement chars.
      readable.setEncoding('utf8');
    }

    readable.on('data', (chunk) => {
      if (settled) return;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      try {
        agg.write(chunk);
      } catch (e) {
        settled = true;
        reject(e);
      }
    });
    readable.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    readable.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        agg.end();
        resolve(selfCheck(agg.finish({
          file: name,
          filesSeen: [{ name, kind: 'apple-health-xml', bytes, rowsParsed: 0, rowsRejected: 0 }]
        })));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Feed a fixed list of chunks. `parseStream` is a thin async wrapper over this;
 * the chunk-boundary test drives it directly with 7-byte slices.
 *
 * @param {Iterable<string>} chunks
 * @param {Object} [opts]
 */
function parseChunks(chunks, opts) {
  const options = opts || {};
  const agg = createAggregator(options);
  const name = options.file || 'export.xml';
  let bytes = 0;
  const list = chunks == null ? [] : chunks;
  for (const chunk of list) {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    bytes += Buffer.byteLength(s);
    agg.write(s);
  }
  agg.end();
  return selfCheck(agg.finish({
    file: name,
    filesSeen: [{ name, kind: 'apple-health-xml', bytes, rowsParsed: 0, rowsRejected: 0 }]
  }));
}

/** Is this file name plausibly the Apple Health XML export? */
function classifyFile(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!base) return null;
  if (!/\.xml$/.test(base)) return null;
  // export_cda.xml is the Clinical Document Architecture sibling: medical records,
  // no wearable metrics. Reading it would produce zero days and a confusing error.
  if (/cda/.test(base)) return 'clinical';
  if (/^export(\s*\(\d+\))?\.xml$/.test(base) || /export/.test(base)) return 'apple-health-xml';
  return 'apple-health-xml';
}

/**
 * Small-file entry point, matching the other adapters' `parse(files)` signature.
 *
 * Deliberately conservative: an in-memory Apple export above MAX_INLINE_CHARS is
 * REFUSED with an explanation rather than parsed, because by that size the caller
 * has already paid the memory cost that `parseStream` exists to avoid and the
 * next member with a bigger watch history will OOM the process.
 *
 * @param {{files:Array<{name:string,text:string}>}|string|Array} input
 * @param {Object} [opts]
 */
function parse(input, opts) {
  const options = opts || {};
  let files;
  if (typeof input === 'string') files = [{ name: 'export.xml', text: input }];
  else if (Array.isArray(input)) files = input;
  else if (input && Array.isArray(input.files)) files = input.files;
  else files = [];
  files = files.filter(Boolean);

  if (!files.length) {
    return selfCheck(C.emptyParsedExport(PROVIDER, [
      'No file was supplied. Apple Health exports as export.zip — send the '
      + 'export.xml from inside it.'
    ]));
  }

  const agg = createAggregator(options);
  const filesSeen = [];
  const notes = [];
  let usable = 0;

  files.forEach((f) => {
    const name = String((f && f.name) || 'export.xml');
    // adapterRegistry hands adapters [{name,text}] and/or [{name,buffer}].
    let text = f && typeof f.text === 'string' ? f.text : '';
    if (!text && f && f.buffer && typeof f.buffer.toString === 'function') {
      // Decode only if it could not blow the inline cap; a huge buffer is refused
      // below by name rather than being turned into a huge string first.
      if (typeof f.buffer.length !== 'number' || f.buffer.length <= MAX_INLINE_CHARS) {
        text = f.buffer.toString('utf8');
      } else {
        text = ' '.repeat(0); // stays empty; the size branch below reports it
        filesSeen.push({ name, kind: 'too-large', bytes: f.buffer.length, rowsParsed: 0, rowsRejected: 0 });
        notes.push('Refused ' + name + ': ' + Math.round(f.buffer.length / (1024 * 1024))
          + 'MB exceeds the ' + Math.round(MAX_INLINE_CHARS / (1024 * 1024))
          + 'MB in-memory limit. Stream it with appleHealth.parseStream instead.');
        return;
      }
    }
    const kind = classifyFile(name);

    if (kind === 'clinical') {
      filesSeen.push({ name, kind: 'clinical', bytes: text.length, rowsParsed: 0, rowsRejected: 0 });
      notes.push('Skipped ' + name + ': export_cda.xml holds clinical documents, '
        + 'not wearable samples. The file we need is export.xml.');
      return;
    }
    if (kind === null) {
      filesSeen.push({ name, kind: null, bytes: text.length, rowsParsed: 0, rowsRejected: 0 });
      notes.push('Unrecognised file skipped: ' + name);
      return;
    }
    if (text.length > MAX_INLINE_CHARS) {
      filesSeen.push({ name, kind: 'too-large', bytes: text.length, rowsParsed: 0, rowsRejected: 0 });
      notes.push('Refused ' + name + ': ' + Math.round(text.length / (1024 * 1024))
        + 'MB exceeds the ' + Math.round(MAX_INLINE_CHARS / (1024 * 1024))
        + 'MB in-memory limit. Apple Health exports of this size must be streamed '
        + '(appleHealth.parseStream) from a direct file upload, not sent inline.');
      return;
    }
    if (!/<\s*(Record|Workout|HealthData)\b/.test(text.slice(0, 200000))) {
      filesSeen.push({ name, kind: 'not-apple-health', bytes: text.length, rowsParsed: 0, rowsRejected: 0 });
      notes.push('Skipped ' + name + ': it is XML but contains no Apple Health '
        + '<Record> elements. Check this is the export.xml from export.zip.');
      return;
    }
    filesSeen.push({ name, kind: 'apple-health-xml', bytes: text.length, rowsParsed: 0, rowsRejected: 0 });
    agg.write(text);
    usable += 1;
  });

  agg.end();
  const out = agg.finish({ file: filesSeen.length ? filesSeen[0].name : 'export.xml', filesSeen });
  notes.forEach((n) => { if (out.summary.notes.indexOf(n) === -1) out.summary.notes.push(n); });
  if (!usable) out.summary.notes.push('No readable Apple Health XML was found in this upload.');
  return selfCheck(out);
}

/* ------------------------------------------------------------------ *
 * INTEGRATION NOTES — changes needed in files this module may not touch
 * ------------------------------------------------------------------ */
/*
 * INTEGRATION NOTE (upload path — REQUIRED, this adapter is unusable without it):
 *   routes/wearables.js accepts uploads as base64 inside a JSON body, capped at
 *   MAX_UPLOAD_BYTES = 25MB (routes/wearables.js:44) under an express.json limit
 *   of 40mb (server.js:344). An Apple Health export.xml is commonly 200MB-1.5GB;
 *   base64 inflates that by 4/3 and express.json buffers the WHOLE body as a
 *   string before any handler runs. Every real Apple upload therefore fails with
 *   the generic 413 today, and raising the limit would OOM the dyno instead.
 *
 *   Recommended endpoint shape (no change to this module required):
 *
 *     POST /api/wearables/apple/upload
 *       Content-Type: application/octet-stream   (or multipart/form-data)
 *       X-BB-Filename: export.zip | export.xml
 *
 *     - Mounted BEFORE express.json, or excluded from it by path, so the body is
 *       never buffered. Handler does NOT read req.body.
 *     - ZIP: stream-inflate the single `apple_health_export/export.xml` entry and
 *       pipe the inflate stream straight into appleHealth.parseStream(). The
 *       existing services/wearables/zipReader.js is a whole-buffer reader and is
 *       NOT suitable here; a streaming inflate (zlib.createInflateRaw over the
 *       local file header) or a spooled temp file is needed.
 *     - XML: pipe the request straight into appleHealth.parseStream(req, {...}).
 *     - Enforce a byte ceiling by counting bytes as they flow and destroying the
 *       stream on breach — never by pre-reading Content-Length alone.
 *     - Suggested ceiling: 2GB, since nothing is ever held in memory. Peak RSS of
 *       parseStream is bounded by MAX_ELEMENT_CHARS + the per-day accumulators
 *       (~2000 days x a few hundred bytes) + the 50k-key dedupe window.
 *     - The sha256 that previewUpload/commitUpload already take must be computed
 *       INCREMENTALLY over the same stream (crypto.createHash('sha256') in a
 *       PassThrough), not from a buffer.
 *
 * INTEGRATION NOTE (deviceRegistry):
 *   Register provider id 'apple_health' with:
 *     confidence prior 0.9, hrvMethod 'sdnn_spot', tempBasis 'absolute_c',
 *     hasRecovery false, hasStrain false, hasReadiness false.
 *   Baseline/trend code MUST segregate hrvMs series by day.hrvMethod. An Apple
 *   day and a Whoop day are not on the same axis.
 *
 * INTEGRATION NOTE (readinessService.VALID_PROVIDERS):
 *   'apple_health', 'health_connect' and 'samsung_health' must all be present in
 *   VALID_PROVIDERS or commitUpload silently persists nothing.
 */

module.exports = {
  parse,
  parseStream,
  parseChunks,
  classifyFile,
  createAggregator,
  // exported for tests / reuse
  createScanner,
  findTagEnd,
  parseAttrs,
  decodeEntities,
  deviceLabel,
  sourcePriority,
  shortType,
  unionMinutes,
  PROVIDER,
  RECORD_TYPES,
  SLEEP_STAGES,
  APPLE_EXPORT_CONFIDENCE,
  MAX_INLINE_CHARS,
  NAP_MAX_MINUTES,
  SESSION_GAP_MS
};
