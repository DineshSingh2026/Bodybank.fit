'use strict';

/**
 * BodyBank — universal VISION extraction for wearables.
 *
 * Most of the world does not own a Whoop. A member on a Noise, boAt, Fire-Boltt,
 * Realme or no-name band has an app that shows the numbers beautifully and
 * exports nothing at all. Their only route into BodyBank is a screenshot — or,
 * for the brands that do print one, a PDF summary. This module is that route.
 *
 *   extract({ files, deviceId })  ->  { ok:true, days, workouts, journal, summary, rejected, ... }
 *                                     { ok:false, code, error, message }
 *
 * It is a generalisation of services/wearables/whoopPdfExtract.js — same fail()
 * shape, same failure-code discipline, same "the model transcribes, it never
 * computes" rule, same escalating-max_tokens JSON harness — widened to (a) any
 * device, via a per-device prompt fragment table, and (b) images, not just PDFs.
 *
 * ── THE HONESTY REQUIREMENT (the reason this file exists at all) ─────────────
 *
 * A number an LLM read off a phone screenshot is NOT the same evidence as a
 * number parsed out of a vendor CSV, and this system must never present it as if
 * it were. Three mechanisms carry that distinction all the way to the database:
 *
 *   1. `day.measurementSource = 'vision'` on EVERY day this module produces.
 *   2. `day.confidence` is capped at MAX_VISION_CONFIDENCE (0.60) — materially
 *      below the file-parse tier (FILE_PARSE_CONFIDENCE, 1.0). See CONFIDENCE.
 *   3. `summary.notes[0]` says, in plain words a member will read, that these
 *      figures were read from an image and must be confirmed.
 *
 * The upload flow is preview -> confirm, so the member approves every number
 * before anything is saved. `day.review` exists to make that screen trivial to
 * build: per day, which fields were read confidently, which were flagged, and
 * which were thrown away and why.
 *
 * ── The discipline rules this module inherits ────────────────────────────────
 *
 *  (whoopParser's five, restated for a screen instead of a CSV column)
 *   1. A metric is never read by position on screen — only through the alias
 *      table below. An unrecognised label is collected, never dropped silently.
 *   2. A day is the calendar date PRINTED on the screen. "Today" is not a date.
 *   3. Naps never inflate nightly sleep.
 *   4. Units are taken from what is printed AND sanity-checked against the value.
 *   5. Nothing is ever invented. A value we cannot read is null, never 0, and an
 *      unusable day becomes a `rejected` entry.
 *
 *  (canonicalDay's sixth, which vision breaks most easily)
 *   6. Noise's "Sleep Score" and Garmin's "Body Battery" are NOT canonical
 *      metrics. They go to `day.providerScores` under a namespaced key and are
 *      never charted against another brand's number. `hrvMethod` comes from the
 *      device registry's declaration or is 'unknown' — it is NEVER guessed to be
 *      'rmssd_sleep' just because Whoop happens to work that way.
 *
 * THE MODEL NEVER COMPUTES A NUMBER. It transcribes what is visibly printed and
 * quotes the on-screen text it came from; a deterministic gate here proves the
 * number actually appears in that quote before the value is kept. Everything
 * below the "Deterministic gates" banner runs with no model involvement.
 *
 * @module services/wearables/deviceVisionExtract
 */

const { estimateAnthropicUsageCost } = require('../aiUsageLedger');
const { formatAnthropicApiError } = require('../nutritionService');

const canonical = require('./canonicalDay');
const {
  SANITY,
  MEASUREMENT_SOURCE,
  HRV_METHOD,
  HRV_METHODS,
  TEMP_BASIS,
  PROVIDERS,
  emptyCanonicalDay,
  emptyParsedExport,
  validateCanonicalDay
} = canonical;

/**
 * Whoop PDFs are already handled, correctly and in production, by
 * services/wearables/whoopPdfExtract.js. We WRAP it; we never reimplement it.
 * The require is guarded exactly as routes/wearables.js guards it, so a
 * deployment without that module still serves every screenshot upload.
 */
let whoopPdfExtract = null;
try {
  whoopPdfExtract = require('./whoopPdfExtract');
} catch (e) { /* not deployed — handled at the delegation site */ }

/**
 * The device registry is another agent's module and may not exist yet. Guarded
 * for the same reason. We ask it exactly two things — the device's declared
 * HRV method and its canonical provider — and fall back to honest defaults.
 *
 * INTEGRATION NOTE: see registryDevice() below for the shapes probed. If
 * deviceRegistry.js settles on a different accessor, that function is the one
 * place to change.
 */
let deviceRegistry = null;
try {
  deviceRegistry = require('./deviceRegistry');
} catch (e) { /* not deployed — hrvMethod falls back to 'unknown' */ }

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/* ------------------------------------------------------------------ *
 * Caps. Each has its OWN failure code — see the note on fail().
 * ------------------------------------------------------------------ */

/** One screenshot. 6MB of PNG is an enormous phone screenshot already. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** All screenshots together. base64 inflates by 4/3, and the API caps ~32MB. */
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
/** A member documenting a week of screens needs several; a hundred is an attack. */
const MAX_IMAGES = 8;
/** Mirrors whoopPdfExtract.MAX_PDF_BYTES when that module is present. */
const MAX_PDF_BYTES = (whoopPdfExtract && whoopPdfExtract.MAX_PDF_BYTES) || 10 * 1024 * 1024;
/** Mirrors whoopPdfExtract.MAX_PDF_PAGES when that module is present. */
const MAX_PDF_PAGES = (whoopPdfExtract && whoopPdfExtract.MAX_PDF_PAGES) || 60;

/* ------------------------------------------------------------------ *
 * Confidence — requirement: materially below a file-parsed day
 * ------------------------------------------------------------------ */

/**
 * `day.confidence` is a 0..1 canonical field (canonicalDay.SANITY.confidence).
 *
 * whoopParser does not set it at all, because a value read straight out of the
 * vendor's own CSV needs no qualification — that is the 1.0 tier, named here so
 * this module's ceiling can be compared against something explicit rather than
 * against a magic number.
 *
 * Why these numbers:
 *  - 0.60 ceiling (MAX_VISION_CONFIDENCE). A PDF a brand generated has a real
 *    text layer and consistent typography; it is the best vision can be, and it
 *    is still well under half the trust of a parsed file, because a single
 *    misread digit is invisible and unrecoverable.
 *  - 0.50 for a clean multi-screenshot read. Screenshots add cropping, scaling,
 *    dark mode, overlapping ring labels and a member's finger. One notch below a
 *    generated PDF, and deliberately below the 0.5 midpoint so no UI that treats
 *    ">= 0.5" as "trustworthy" ever picks these up by accident.
 *  - 0.35 when the model itself reported medium confidence, or any field on that
 *    day was flagged low_confidence / unreadable / dropped.
 *  - 0.20 floor when the model reported low confidence. Never 0: 0 would read as
 *    "no data", and we do have data — we just do not vouch for it.
 *
 * All of these sit below FILE_PARSE_CONFIDENCE and below DEVICE_API_CONFIDENCE,
 * so any ranking or precedence code that sorts on `confidence` puts a real
 * export ahead of a screenshot without needing to know this module exists.
 */
const FILE_PARSE_CONFIDENCE = 1.0;
const DEVICE_API_CONFIDENCE = 0.95;
const NATIVE_SDK_CONFIDENCE = 0.9;
const MAX_VISION_CONFIDENCE = 0.6;
const CONFIDENCE = {
  VISION_PDF: 0.6,
  VISION_SCREENSHOT: 0.5,
  VISION_DEGRADED: 0.35,
  VISION_LOW: 0.2
};

/* ------------------------------------------------------------------ *
 * Magic-byte detection (rule: type comes from the bytes, never the name)
 * ------------------------------------------------------------------ */

const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

/** ISO-BMFF brands that mean HEIF/HEIC. The API cannot read these. */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];

function toBuf(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input && input.buffer instanceof ArrayBuffer && typeof input.byteLength === 'number') {
    try {
      return Buffer.from(input.buffer, input.byteOffset || 0, input.byteLength);
    } catch (_) { return null; }
  }
  return null;
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * What did the member actually upload?
 *
 * Pure, allocation-light, never throws. Deliberately parallel to
 * whoopPdfExtract.classifyUploadBuffer — that one answers zip/csv/pdf for the
 * Whoop route; this one adds the image formats and keeps the same posture:
 * a truncated or unrecognised buffer is 'unknown', never a guess.
 *
 * @param {Buffer} input
 * @returns {'png'|'jpeg'|'webp'|'gif'|'heic'|'pdf'|'zip'|'text'|'unknown'}
 */
function classifyVisionBuffer(input) {
  const buf = toBuf(input);
  if (!buf || !buf.length) return 'unknown';

  // PNG: the full 8-byte signature. A 4-byte truncation must NOT pass.
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  // JPEG: SOI + the first marker byte, and a real JPEG has more than a header.
  if (buf.length >= 4 && startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  // GIF87a / GIF89a
  if (buf.length >= 6 && buf.slice(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'gif';
  // WebP: RIFF....WEBP
  if (buf.length >= 12
      && buf.slice(0, 4).toString('latin1') === 'RIFF'
      && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  // HEIF/HEIC: ....ftyp<brand>. Detected so we can say WHY we cannot read it.
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1').toLowerCase();
    if (HEIF_BRANDS.indexOf(brand) !== -1) return 'heic';
  }

  const head = buf.slice(0, 1024).toString('latin1');
  if (head.indexOf('%PDF-') !== -1) return 'pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return 'zip';

  // Mostly-printable bytes are text (a CSV, a JSON blob, a .txt). Not an image.
  const sample = buf.slice(0, 4096).toString('utf8');
  if (!sample) return 'unknown';
  let printable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 65533)) printable += 1;
  }
  if (printable / sample.length >= 0.9) return 'text';
  return 'unknown';
}

function isImageKind(kind) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, kind);
}

/**
 * Page count from the page objects, or null when the structure hides inside
 * compressed object streams. Same fail-open posture as whoopPdfExtract: null
 * means "we do not know" and skips the cap rather than inventing a rejection.
 */
function pdfPageCount(input) {
  if (whoopPdfExtract && typeof whoopPdfExtract.pdfPageCount === 'function') {
    try { return whoopPdfExtract.pdfPageCount(input); } catch (_) { /* fall through */ }
  }
  const buf = toBuf(input);
  if (!buf || !buf.length) return null;
  const matches = buf.toString('latin1').match(/\/Type\s*\/Page(?![s])/g);
  return matches && matches.length ? matches.length : null;
}

/* ------------------------------------------------------------------ *
 * Device table — prompt fragments, namespaces, proprietary scores
 * ------------------------------------------------------------------ */

/** Fold every spelling a client might send into one registry key. */
function normalizeDeviceId(raw) {
  const k = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const ALIASES = {
    boat: 'boat', boat_wearables: 'boat', boat_crest: 'boat',
    fire_boltt: 'fire_boltt', fireboltt: 'fire_boltt', firebolt: 'fire_boltt',
    noise: 'noise', noisefit: 'noise', nooise: 'noise',
    apple: 'apple_health', apple_watch: 'apple_health', healthkit: 'apple_health',
    apple_health: 'apple_health', health: 'apple_health',
    samsung: 'samsung_health', samsung_health: 'samsung_health', galaxy_watch: 'samsung_health',
    health_connect: 'health_connect',
    mi: 'mi_band', mi_band: 'mi_band', xiaomi: 'mi_band', mi_fitness: 'mi_band', smart_band: 'mi_band',
    zepp: 'amazfit', amazfit: 'amazfit',
    garmin: 'garmin', garmin_connect: 'garmin',
    fitbit: 'fitbit', oura: 'oura', whoop: 'whoop', polar: 'polar', polar_flow: 'polar',
    realme: 'realme', oneplus: 'oneplus', honor: 'honor', huawei: 'huawei', ultrahuman: 'ultrahuman'
  };
  return ALIASES[k] || k || '';
}

/**
 * What the declared device's app actually looks like on screen.
 *
 * `hint` is spliced into the system prompt. It exists because a prompt that
 * describes "your wearable app" gets a mush of hallucinated labels, while one
 * that names the actual screen ("NoiseFit's home ring shows Steps, Calories and
 * Distance; sleep lives behind the Sleep card") gets a transcription.
 *
 * `proprietary` lists the brand-native scores that must go to providerScores.
 * `ns` is the providerScores namespace. `provider` is the canonical
 * canonicalDay.PROVIDERS value the device maps to, used only for reporting —
 * `day.source` is 'screenshot' regardless (see resolveSource()).
 */
const GENERIC_DEVICE = {
  app: 'your wearable app',
  ns: 'device',
  provider: 'screenshot',
  hrvMethod: null,
  proprietary: ['sleep_score', 'stress_score', 'energy_score', 'wellness_score', 'activity_score', 'fitness_age'],
  hint: 'This is an unlisted brand. Read only labels that are literally printed next to a number. '
    + 'Do not assume any layout. If a metric name is a brand score you do not recognise as a standard '
    + 'physiological measure, put it in provider_scores, not fields.'
};

const DEVICE_PROMPTS = {
  whoop: {
    app: 'WHOOP',
    ns: 'whoop',
    provider: 'whoop',
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    proprietary: [],
    hint: 'WHOOP screens show three coloured rings/cards: Recovery (a green/yellow/red percentage), '
      + 'Day Strain (a 0-21 decimal, NOT a percentage) and Sleep Performance (a percentage). '
      + 'The Recovery detail screen lists HRV in ms, Resting Heart Rate in bpm, Respiratory Rate in rpm '
      + 'and Blood Oxygen as a percentage. Sleep detail lists Hours of Sleep, Sleep Need, Sleep Debt, '
      + 'Sleep Efficiency and the REM/SWS(Deep)/Light/Awake breakdown in h:mm.'
  },
  oura: {
    app: 'Oura',
    ns: 'oura',
    provider: 'oura',
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    proprietary: ['activity_score', 'crown'],
    hint: 'Oura shows Readiness Score, Sleep Score and Activity Score as 0-100 numbers on the home screen. '
      + 'Readiness Score is a genuine readiness percentage. Sleep Score and Activity Score are Oura-specific '
      + 'composites and belong in provider_scores. Readiness detail lists Resting Heart Rate (bpm), '
      + 'HRV Balance / Average HRV (ms), Body Temperature as a DEVIATION in degrees (e.g. "-0.3"), and '
      + 'Respiratory Rate. A temperature printed with a leading + or - is a deviation, never an absolute.'
  },
  fitbit: {
    app: 'Fitbit',
    ns: 'fitbit',
    provider: 'fitbit',
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    proprietary: ['sleep_score', 'daily_readiness_score', 'active_zone_minutes', 'stress_management_score'],
    hint: 'Fitbit Today shows Steps, Calories burned, Active Zone Minutes and a Sleep Score out of 100. '
      + 'Sleep Score, Daily Readiness Score and Stress Management Score are Fitbit composites and belong in '
      + 'provider_scores. Health Metrics lists Breathing Rate (br/min), Heart Rate Variability (ms), '
      + 'Resting Heart Rate (bpm), Oxygen Saturation (SpO2 %) and Skin Temperature Variation, which is a '
      + 'DEVIATION in degrees, never an absolute temperature.'
  },
  garmin: {
    app: 'Garmin Connect',
    ns: 'garmin',
    provider: 'garmin',
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    proprietary: ['body_battery', 'sleep_score', 'stress_score', 'training_readiness', 'fitness_age', 'intensity_minutes'],
    hint: 'Garmin Connect shows Body Battery (0-100), Stress (0-100), Sleep Score (0-100), Training Readiness '
      + 'and Fitness Age. EVERY one of those is Garmin-specific and belongs in provider_scores — Body Battery '
      + 'is not a recovery percentage and must never be recorded as one. Genuine measurements on these screens '
      + 'are Resting Heart Rate (bpm), HRV Status / Overnight Avg HRV (ms), Respiration (brpm), Pulse Ox (%), '
      + 'Steps, Intensity Minutes and Calories.'
  },
  polar: {
    app: 'Polar Flow',
    ns: 'polar',
    provider: 'polar',
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    proprietary: ['sleep_score', 'nightly_recharge', 'ans_charge'],
    hint: 'Polar shows Nightly Recharge and ANS Charge — both Polar-specific, both provider_scores. '
      + 'Real measurements: Sleep time, Heart rate (lowest, bpm), HRV (ms), Breathing rate.'
  },
  amazfit: {
    app: 'Zepp / Amazfit',
    ns: 'amazfit',
    provider: 'amazfit',
    hrvMethod: null,
    proprietary: ['pai', 'sleep_score', 'readiness_score', 'stress_score'],
    hint: 'Zepp shows PAI (Personal Activity Intelligence) and a Sleep Score — both provider_scores. '
      + 'Real measurements: Steps, Calories, Resting heart rate (bpm), Blood oxygen (%), Sleep duration '
      + 'and the Deep/Light/REM/Awake breakdown.'
  },
  apple_health: {
    app: 'Apple Health / Fitness',
    ns: 'apple',
    provider: 'apple_health',
    hrvMethod: HRV_METHOD.SDNN_SPOT,
    proprietary: ['move_ring', 'exercise_ring', 'stand_ring'],
    hint: 'Apple Health charts are labelled "Heart Rate Variability" but Apple reports SDNN over a short '
      + 'sample, not overnight RMSSD — transcribe the number, never relabel it. Screens show Resting Heart '
      + 'Rate (BPM), Blood Oxygen (%), Respiratory Rate (breaths/min), Wrist Temperature as a DEVIATION, '
      + 'Steps and Move/Exercise/Stand rings. Ring closures are provider_scores, not activity minutes. '
      + 'A chart showing a RANGE (e.g. "42-88 ms") has no single value — do not pick one.'
  },
  samsung_health: {
    app: 'Samsung Health',
    ns: 'samsung',
    provider: 'samsung_health',
    hrvMethod: null,
    proprietary: ['sleep_score', 'stress_score', 'energy_score', 'sleep_animal'],
    hint: 'Samsung Health shows a Sleep Score out of 100 and a "sleep animal" — both provider_scores. '
      + 'Real measurements: Steps, Calories, Sleep duration, Blood oxygen (%), Heart rate (bpm), '
      + 'Skin temperature during sleep (a DEVIATION).'
  },
  health_connect: {
    app: 'Health Connect',
    ns: 'health_connect',
    provider: 'health_connect',
    hrvMethod: null,
    proprietary: [],
    hint: 'Health Connect lists raw records by type with a source app beside each. Transcribe only the '
      + 'numeric record values and their dates.'
  },
  noise: {
    app: 'NoiseFit',
    ns: 'noise',
    provider: 'screenshot',
    hrvMethod: null,
    proprietary: ['sleep_score', 'stress_score', 'noise_health_score'],
    hint: 'NoiseFit\'s home screen is a step ring with Steps, Calories (kcal) and Distance beneath it. '
      + 'The Sleep card shows a total like "7h 12m" with a Sleep Score out of 100 and a coloured '
      + 'Deep / Light / Awake / REM bar in hours and minutes. Separate cards show Heart Rate (bpm, often as '
      + 'a min-max range plus an average), SpO2 (%) and a Stress number out of 100. '
      + 'Sleep Score and Stress are NoiseFit composites and belong in provider_scores — Sleep Score is NOT '
      + 'sleep efficiency and NOT sleep performance. A heart-rate RANGE is not a resting heart rate; only '
      + 'transcribe resting HR when the screen literally says "Resting".'
  },
  boat: {
    app: 'boAt Crest / boAt Wearables',
    ns: 'boat',
    provider: 'screenshot',
    hrvMethod: null,
    proprietary: ['sleep_score', 'stress_score', 'energy_score'],
    hint: 'The boAt app shows Steps, Calories, Distance, a Sleep card with total sleep and a Deep/Light '
      + 'split, Heart Rate in bpm, SpO2 as a percentage and a Stress level. Any "score" out of 100 is a '
      + 'boAt composite and belongs in provider_scores.'
  },
  fire_boltt: {
    app: 'Fire-Boltt / Da Fit',
    ns: 'fire_boltt',
    provider: 'screenshot',
    hrvMethod: null,
    proprietary: ['sleep_score', 'stress_score'],
    hint: 'Fire-Boltt (often the Da Fit or FireBoltt app) shows Steps, Calories, Distance, Sleep with a '
      + 'Deep/Light split in hours and minutes, Heart Rate in bpm, SpO2 as a percentage and Blood Pressure. '
      + 'IGNORE blood pressure entirely — it is not a field we accept. Any score out of 100 is a composite '
      + 'and belongs in provider_scores.'
  },
  mi_band: {
    app: 'Mi Fitness / Zepp Life',
    ns: 'mi',
    provider: 'screenshot',
    hrvMethod: null,
    proprietary: ['sleep_score', 'pai', 'stress_score', 'vitality_score'],
    hint: 'Mi Fitness shows Steps, Calories, a Sleep card with a score out of 100 and a Deep/Light/REM '
      + 'breakdown, Heart Rate (bpm), SpO2 (%), Stress and PAI. Sleep score, Stress, Vitality and PAI are '
      + 'Xiaomi composites and belong in provider_scores.'
  },
  realme: {
    app: 'realme Link',
    ns: 'realme',
    provider: 'screenshot',
    hrvMethod: null,
    proprietary: ['sleep_score', 'stress_score'],
    hint: 'realme Link shows Steps, Calories, Sleep (total plus Deep/Light), Heart Rate (bpm) and SpO2 (%). '
      + 'Any score out of 100 belongs in provider_scores.'
  },
  ultrahuman: {
    app: 'Ultrahuman',
    ns: 'ultrahuman',
    provider: 'screenshot',
    hrvMethod: HRV_METHOD.RMSSD_SLEEP,
    proprietary: ['recovery_score', 'movement_index', 'sleep_index', 'dynamic_recovery'],
    hint: 'Ultrahuman shows a Recovery Score, Sleep Index and Movement Index — all Ultrahuman composites, '
      + 'all provider_scores. Real measurements: HRV (ms), Resting Heart Rate (bpm), Skin Temperature, '
      + 'Sleep duration and stages.'
  }
};

/**
 * The prompt fragment + namespace for a declared device id, with a generic
 * fallback so an unlisted brand still works (that is the whole point of the
 * vision path — the long tail has no adapter and never will).
 *
 * @param {string} deviceId
 * @returns {{id:string, known:boolean, app:string, ns:string, provider:string, hrvMethod:?string, proprietary:string[], hint:string}}
 */
function devicePromptFragment(deviceId) {
  const id = normalizeDeviceId(deviceId);
  const hit = Object.prototype.hasOwnProperty.call(DEVICE_PROMPTS, id) ? DEVICE_PROMPTS[id] : null;
  const base = hit || GENERIC_DEVICE;
  return {
    id: id || 'generic',
    known: !!hit,
    app: base.app,
    ns: hit ? base.ns : (id ? id.replace(/[^a-z0-9_]/g, '') || 'device' : 'device'),
    provider: base.provider,
    hrvMethod: base.hrvMethod,
    proprietary: base.proprietary.slice(),
    hint: base.hint
  };
}

/* ------------------------------------------------------------------ *
 * Device registry bridge (rule 6: hrvMethod is DECLARED, never guessed)
 * ------------------------------------------------------------------ */

/**
 * Look the device up in services/wearables/deviceRegistry.js if that module is
 * deployed.
 *
 * UNVERIFIED: deviceRegistry.js does not exist in this tree yet, so the accessor
 * names below are probed rather than known. Every probe is wrapped, and a total
 * miss simply means we fall back to `'unknown'`, which is the honest answer.
 */
function registryDevice(deviceId) {
  if (!deviceRegistry || !deviceId) return null;
  try {
    const fns = ['getDevice', 'getDeviceById', 'resolveDevice', 'findDevice', 'lookupDevice', 'get'];
    for (let i = 0; i < fns.length; i += 1) {
      const fn = deviceRegistry[fns[i]];
      if (typeof fn === 'function') {
        const d = fn.call(deviceRegistry, deviceId);
        if (d && typeof d === 'object') return d;
      }
    }
    const maps = ['DEVICES', 'DEVICE_REGISTRY', 'REGISTRY', 'devices', 'registry'];
    for (let i = 0; i < maps.length; i += 1) {
      const c = deviceRegistry[maps[i]];
      if (!c) continue;
      if (Array.isArray(c)) {
        const d = c.find((x) => x && (x.id === deviceId || x.deviceId === deviceId || x.key === deviceId));
        if (d) return d;
      } else if (typeof c === 'object' && c[deviceId] && typeof c[deviceId] === 'object') {
        return c[deviceId];
      }
    }
  } catch (_) { /* a registry that throws must not break an upload */ }
  return null;
}

/**
 * The device's DECLARED HRV method, or 'unknown'.
 *
 * Never 'rmssd_sleep' by default. Apple's SDNN spot check and Whoop's overnight
 * RMSSD are different measurements; tagging a Noise band's unlabelled HRV as
 * RMSSD would let it be charted in the same series as a Whoop number and invent
 * a trend that does not exist.
 */
function resolveHrvMethod(deviceId, opts) {
  const explicit = opts && opts.hrvMethod;
  if (HRV_METHODS.indexOf(explicit) !== -1) return explicit;
  const d = registryDevice(deviceId);
  if (d) {
    const cands = [
      d.hrvMethod,
      d.hrv_method,
      d.capabilities && d.capabilities.hrvMethod,
      d.metrics && d.metrics.hrvMethod
    ];
    for (let i = 0; i < cands.length; i += 1) {
      if (HRV_METHODS.indexOf(cands[i]) !== -1) return cands[i];
    }
  }
  const frag = devicePromptFragment(deviceId);
  if (HRV_METHODS.indexOf(frag.hrvMethod) !== -1) return frag.hrvMethod;
  return HRV_METHOD.UNKNOWN;
}

/**
 * `day.source` for vision-extracted days.
 *
 * DEFAULT: 'screenshot', ALWAYS — even for a Garmin screenshot.
 *
 * readiness_daily is UNIQUE(user_id, date, source). If a Garmin screenshot were
 * stored as source='garmin', a later real Garmin export for the same date would
 * be indistinguishable from it at the key level, and — worse — a screenshot
 * uploaded after an export would silently overwrite genuine file data with an
 * LLM's reading of a picture. Segregating vision under its own source makes that
 * impossible, and lets any precedence rule prefer the file without extra logic.
 *
 * `opts.source` can override it, but only to another canonicalDay provider.
 */
function resolveSource(opts) {
  const wanted = opts && opts.source ? String(opts.source).trim().toLowerCase() : '';
  if (wanted && PROVIDERS.indexOf(wanted) !== -1) return wanted;
  return 'screenshot';
}

/* ------------------------------------------------------------------ *
 * The structured-output contract (rule 7)
 * ------------------------------------------------------------------ */

/** Every label the model may use for a metric -> the canonical field. */
const FIELD_ALIASES = {
  recovery: 'recoveryScore',
  recovery_score: 'recoveryScore',
  recovery_percent: 'recoveryScore',
  readiness: 'readinessScore',
  readiness_score: 'readinessScore',
  hrv: 'hrvMs',
  hrv_ms: 'hrvMs',
  heart_rate_variability: 'hrvMs',
  average_hrv: 'hrvMs',
  overnight_hrv: 'hrvMs',
  rhr: 'restingHr',
  resting_hr: 'restingHr',
  resting_heart_rate: 'restingHr',
  lowest_heart_rate: 'restingHr',
  spo2: 'spo2',
  blood_oxygen: 'spo2',
  oxygen_saturation: 'spo2',
  pulse_ox: 'spo2',
  respiratory_rate: 'respiratoryRate',
  breathing_rate: 'respiratoryRate',
  respiration: 'respiratoryRate',
  strain: 'strain',
  day_strain: 'strain',
  calories: 'energyKcal',
  energy_kcal: 'energyKcal',
  calories_burned: 'energyKcal',
  active_calories: 'energyKcal',
  max_hr: 'maxHr',
  max_heart_rate: 'maxHr',
  avg_hr: 'avgHr',
  average_heart_rate: 'avgHr',
  sleep_hours: 'sleepHours',
  sleep_minutes: 'sleepMinutes',
  sleep_duration_min: 'sleepMinutes',
  total_sleep_min: 'sleepMinutes',
  sleep_performance: 'sleepPerformancePct',
  sleep_efficiency: 'sleepEfficiencyPct',
  sleep_consistency: 'sleepConsistencyPct',
  sleep_need_min: 'sleepNeedMin',
  sleep_debt_min: 'sleepDebtMin',
  rem_min: 'remMin',
  deep_min: 'deepMin',
  light_min: 'lightMin',
  awake_min: 'awakeMin',
  nap_min: 'napMinutes',
  nap_minutes: 'napMinutes',
  steps: 'steps',
  step_count: 'steps',
  active_minutes: 'activeMinutes',
  active_min: 'activeMinutes',
  exercise_minutes: 'activeMinutes',
  skin_temp: 'skinTemp',
  skin_temperature: 'skinTemp',
  body_temperature: 'skinTemp',
  wrist_temperature: 'skinTemp',
  temperature: 'skinTemp',
  skin_temp_deviation: 'skinTempDeviation',
  temperature_deviation: 'skinTempDeviation',
  skin_temperature_variation: 'skinTempDeviation',
  temperature_variation: 'skinTempDeviation'
};

/**
 * Brand composites that must NEVER reach a canonical field, whichever bucket the
 * model puts them in. A model that helpfully files "sleep_score" under `fields`
 * gets it moved to providerScores here, not mapped onto sleepPerformancePct —
 * Noise's 82/100 and Whoop's 82% sleep performance are not the same quantity.
 */
const PROPRIETARY_SCORE_NAMES = [
  'sleep_score', 'stress_score', 'stress', 'stress_level', 'body_battery', 'energy_score',
  'wellness_score', 'activity_score', 'vitality_score', 'fitness_age', 'pai',
  'nightly_recharge', 'ans_charge', 'daily_readiness_score', 'stress_management_score',
  'training_readiness', 'movement_index', 'sleep_index', 'noise_health_score', 'sleep_animal',
  'move_ring', 'exercise_ring', 'stand_ring', 'active_zone_minutes', 'intensity_minutes',
  'crown', 'dynamic_recovery'
];

/** How sure was the model that it actually READ this, rather than inferred it? */
const READ_FLAGS = ['confident', 'low_confidence', 'unreadable'];

function buildSystemPrompt(frag) {
  const propList = frag.proprietary.length
    ? frag.proprietary.join(', ')
    : 'any score out of 100 whose name is brand-specific';
  return `You transcribe screenshots and PDF pages from ${frag.app} for a health platform. You are a TRANSCRIBER, not an analyst.

ABSOLUTE RULES — a violation makes the whole extraction worthless:
1. NEVER compute, average, estimate, convert, infer or interpolate a number. Copy exactly what is printed on the screen. If the screen shows "7h 12m" you may report sleep_minutes 432 ONLY because the h/m are printed; you may NOT convert Fahrenheit to Celsius, add up stages to make a total, or turn a weekly bar chart into daily values.
2. NEVER read a number off a chart, bar, ring or sparkline that has no printed numeral beside it. Estimating a bar's height is inventing data.
3. A day is the calendar date PRINTED on the screen. "Today", "Yesterday", "Last night" and "This week" are NOT dates. If you cannot see an unambiguous calendar date for a value, do not emit a day for it — describe it in "undated" instead.
4. Every value MUST carry "evidence": the exact on-screen text you read it from, copied verbatim, containing that number. If you cannot quote it, omit the value.
5. Every value MUST carry "readable": "confident" if you can read the digits clearly, "low_confidence" if the text is small/blurred/overlapped but you believe you read it, "unreadable" if you cannot make it out. NEVER guess in place of "unreadable".
6. A weekly or monthly average is not a day. Do not emit it.
7. Use null for anything absent. Never use 0 to mean "missing".

WHAT THIS APP LOOKS LIKE:
${frag.hint}

PROPRIETARY SCORES — this is the rule people get wrong most often:
${propList} are brand-specific composites. They go in "provider_scores", NEVER in "fields". A brand's sleep score is not sleep efficiency, not sleep performance and not a recovery percentage. If you are unsure whether a named number is a real physiological measurement or a brand composite, it is a brand composite.

Blood pressure, weight, body fat, VO2 max, distance and floors are NOT accepted here. Omit them.

Return ONLY valid JSON, no prose, no markdown fence:
{
  "is_expected_device": true,
  "app_seen": "the app name actually visible on screen, or null",
  "device_model": "a device/watch model name printed on screen, or null",
  "screens": [ { "index": 0, "screen_type": "home" | "sleep" | "heart" | "spo2" | "activity" | "stress" | "other", "printed_date": "the date text printed on this screen, or null" } ],
  "days": [
    {
      "date": "YYYY-MM-DD",
      "date_evidence": "the printed date text this came from",
      "fields": [
        { "name": "hrv", "value": 48, "unit": "ms", "readable": "confident", "evidence": "HRV 48 ms", "screen_index": 0 }
      ],
      "provider_scores": [
        { "key": "sleep_score", "value": 82, "readable": "confident", "evidence": "Sleep Score 82" }
      ]
    }
  ],
  "workouts": [
    { "date": "YYYY-MM-DD", "activity": "Running", "duration_min": 42, "energy_kcal": null, "max_hr": null, "avg_hr": null, "readable": "confident", "evidence": "Running 42 min 310 kcal" }
  ],
  "undated": ["values you could see but could not attach to a printed calendar date"],
  "unreadable": ["things you could see were there but could not read at all"],
  "notes": ["anything the reader should know about these screenshots"],
  "confidence": "high" | "medium" | "low"
}

"value" MUST be a JSON number. Not a string, not "48 ms", not "n/a". If it is not a number, omit the entry.

Field names to use where they apply: recovery_score, readiness_score, hrv, resting_hr, spo2, respiratory_rate, strain, calories, max_hr, avg_hr, sleep_hours, sleep_minutes, sleep_performance, sleep_efficiency, sleep_consistency, sleep_need_min, sleep_debt_min, rem_min, deep_min, light_min, awake_min, nap_min, steps, active_minutes, skin_temp, skin_temp_deviation. Anything else printed on screen: put it in provider_scores under its printed label.

If these images are clearly not from ${frag.app}, return {"is_expected_device": false, "app_seen": "what you actually see", "device_model": null, "screens": [], "days": [], "workouts": [], "undated": [], "unreadable": [], "notes": ["what this appears to be"], "confidence": "high"}.`;
}

/* ------------------------------------------------------------------ *
 * Anthropic harness (mirrors whoopPdfExtract / whoopReportService)
 * ------------------------------------------------------------------ */

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function anthropicTextFromMessage(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  return blocks.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('');
}

/** Tolerates fences and surrounding prose. Same defensive parse as the PDF path. */
function parseAnyJsonBlock(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  try { return JSON.parse(t); } catch (_) { /* keep looking */ }

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(t))) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    try { return JSON.parse(body); } catch (_) { /* keep looking */ }
  }

  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < t.length; j += 1) {
      const ch = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(t.slice(i, j + 1)); } catch (_) { break; }
      }
    }
  }
  return null;
}

function buildUsage(model, inputTokens, outputTokens) {
  return {
    provider: 'anthropic',
    model: String(model || ''),
    input_tokens: toNumber(inputTokens, 0),
    output_tokens: toNumber(outputTokens, 0),
    total_tokens: toNumber(inputTokens, 0) + toNumber(outputTokens, 0),
    ...estimateAnthropicUsageCost(inputTokens, outputTokens, model)
  };
}

/**
 * The real client. Isolated behind the same `createMessage(request)` interface a
 * stub implements, so tests never reach the network.
 */
const defaultClient = {
  async createMessage(request) {
    const timeoutMs = Math.max(
      30000,
      parseInt(process.env.ANTHROPIC_VISION_REQUEST_TIMEOUT_MS
        || process.env.ANTHROPIC_WHOOP_REQUEST_TIMEOUT_MS || '300000', 10) || 300000
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Anthropic request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': request.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.max_tokens,
        system: request.system,
        messages: request.messages
      })
    }).finally(() => clearTimeout(timer));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(formatAnthropicApiError(res.status, data));
    return data;
  }
};

/**
 * Normalise whatever the caller injected into `{createMessage(request)}`.
 *
 * Accepts a bare function, an object with `createMessage`, or an Anthropic SDK
 * instance (`client.messages.create`). Returns null for anything else, which the
 * caller turns into VISION_CLIENT_INVALID rather than a crash.
 */
function normalizeClient(client) {
  if (!client) return null;
  if (typeof client === 'function') return { createMessage: (r) => client(r) };
  if (typeof client.createMessage === 'function') return { createMessage: (r) => client.createMessage(r) };
  if (client.messages && typeof client.messages.create === 'function') {
    return { createMessage: (r) => client.messages.create(r) };
  }
  return null;
}

/**
 * One JSON-producing pass with an escalating max_tokens retry, summing usage
 * across attempts. Identical strategy to whoopPdfExtract.runJsonPass.
 */
async function runJsonPass({ client, apiKey, model, maxTokens, maxRetryTokens, system, userContent, coerce }) {
  let inputTokens = 0;
  let outputTokens = 0;
  let lastData = null;
  const bumped = Math.min(maxRetryTokens || 32000, Math.max(maxTokens + 4000, Math.floor(maxTokens * 1.8)));
  const attempts = maxTokens >= bumped ? [maxTokens] : [maxTokens, bumped];

  for (let i = 0; i < attempts.length; i += 1) {
    const data = await client.createMessage({
      apiKey,
      model,
      max_tokens: attempts[i],
      system,
      messages: [{ role: 'user', content: userContent }]
    });
    lastData = data;
    inputTokens += toNumber(data && data.usage && data.usage.input_tokens, 0);
    outputTokens += toNumber(data && data.usage && data.usage.output_tokens, 0);
    const parsed = parseAnyJsonBlock(anthropicTextFromMessage(data));
    const result = coerce ? coerce(parsed) : parsed;
    if (result) {
      return { result, usage: buildUsage(model, inputTokens, outputTokens), stopReason: data && data.stop_reason };
    }
    if (data && data.stop_reason && data.stop_reason !== 'max_tokens') break;
  }
  return {
    result: null,
    usage: buildUsage(model, inputTokens, outputTokens),
    stopReason: (lastData && lastData.stop_reason) || 'unknown'
  };
}

/* =================================================================== *
 * Deterministic gates — NO model involvement below this line
 * =================================================================== */

function cleanStr(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** A real calendar date, not just a well-shaped string. 2026-02-31 is not a day. */
function isRealYmd(s) {
  if (!isYmd(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function numeralsIn(text) {
  const cleaned = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  const found = cleaned.match(/-?\d+(?:\.\d+)?/g);
  return found ? found.slice() : [];
}

/** Durations printed as "7h 12m" or "7:12", expressed as both hours and minutes. */
function durationCandidates(text) {
  const t = String(text || '');
  const out = [];
  let m;
  const hm = /(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\s*(\d{1,2})\s*(?:m|min|mins|minute|minutes)?/gi;
  while ((m = hm.exec(t))) out.push([Number(m[1]), Number(m[2])]);
  const colon = /(\d{1,3}):(\d{2})\b/g;
  while ((m = colon.exec(t))) out.push([Number(m[1]), Number(m[2])]);
  const res = [];
  out.forEach((pair) => {
    const h = pair[0];
    const mi = pair[1];
    if (!Number.isFinite(h) || !Number.isFinite(mi)) return;
    res.push(h + mi / 60);
    res.push(h * 60 + mi);
  });
  return res;
}

/**
 * Does the quoted on-screen text actually contain the number the model reported?
 *
 * This is the whole traceability guarantee for a screenshot, and it runs with no
 * LLM. A screenshot has no text layer to cross-check against, so the quote is
 * all we have — but requiring the figure to appear inside the quote still stops
 * the failure mode that matters: the model doing arithmetic in its head and
 * presenting the result as a reading. Copied in behaviour from
 * whoopPdfExtract.evidenceSupports, deliberately, so the two paths agree.
 */
function evidenceSupports(value, evidence) {
  if (!Number.isFinite(value)) return false;
  const tokens = numeralsIn(evidence);
  for (let i = 0; i < tokens.length; i += 1) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) continue;
    if (n === value) return true;
    if (Math.abs(n - value) < 0.05 && Math.round(n * 10) === Math.round(value * 10)) return true;
  }
  const durations = durationCandidates(evidence);
  for (let i = 0; i < durations.length; i += 1) {
    const d = durations[i];
    if (Math.abs(d - value) <= (d > 30 ? 0.5 : 0.02)) return true;
  }
  return false;
}

/** Is `value` inside canonicalDay's plausible band for `field`? */
function withinSanity(field, value) {
  const range = SANITY[field];
  if (!range) return true;
  if (range[0] !== null && value < range[0]) return false;
  if (range[1] !== null && value > range[1]) return false;
  return true;
}

/**
 * Strict schema validation of the model's response.
 *
 * Anything that does not fit is REJECTED, not coerced: a missing
 * `is_expected_device`, a non-array `days`, a value that is not a JSON number,
 * a `readable` flag outside the enum. Returning null here is what makes
 * runJsonPass retry, and ultimately what produces VISION_UNREADABLE instead of
 * a half-invented day.
 *
 * @returns {Object|null}
 */
function coerceVisionExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed.extraction && typeof parsed.extraction === 'object' && !Array.isArray(parsed.extraction)
    ? parsed.extraction
    : parsed;

  // The two load-bearing contract keys. Absent or wrong-typed => not our schema.
  if (typeof root.is_expected_device !== 'boolean') return null;
  if (!Array.isArray(root.days)) return null;
  if (root.workouts !== undefined && !Array.isArray(root.workouts)) return null;
  if (root.screens !== undefined && !Array.isArray(root.screens)) return null;

  const objs = (v, n) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []).slice(0, n);
  const strs = (v) => (Array.isArray(v) ? v : []).map((x) => cleanStr(x, 500)).filter(Boolean).slice(0, 60);
  const conf = cleanStr(root.confidence, 10).toLowerCase();

  return {
    isExpectedDevice: root.is_expected_device === true,
    appSeen: cleanStr(root.app_seen, 120) || null,
    deviceModel: cleanStr(root.device_model, 120) || null,
    screens: objs(root.screens, 40),
    days: objs(root.days, 400),
    workouts: objs(root.workouts, 200),
    undated: strs(root.undated),
    unreadable: strs(root.unreadable),
    notes: strs(root.notes),
    confidence: ['high', 'medium', 'low'].indexOf(conf) !== -1 ? conf : 'low'
  };
}

/**
 * One `fields[]` entry -> an accepted canonical assignment, or a typed rejection.
 *
 * Rejection reasons (all surfaced, never swallowed):
 *   bad_readable_flag        the `readable` signal is missing or not in the enum
 *   unreadable               the model said it could not read this — honoured by nulling
 *   unknown_field            a label we have no canonical field for
 *   proprietary_score        a brand composite that must go to providerScores
 *   non_numeric_value        `value` was not a JSON number
 *   no_evidence              no on-screen quote
 *   value_not_in_evidence    the figure does not appear in its own quote
 *   ambiguous_temperature_unit  a temperature with no unit printed
 *   implausible              outside canonicalDay.SANITY — reported, never clamped
 */
function acceptVisionField(entry, ctx) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const where = (ctx && ctx.where) || '';
  const rawName = cleanStr(raw.name, 120);
  const key = normKey(rawName);
  const evidence = cleanStr(raw.evidence, 400);
  const unit = cleanStr(raw.unit, 24);
  const flag = cleanStr(raw.readable, 20).toLowerCase();

  if (READ_FLAGS.indexOf(flag) === -1) {
    return { ok: false, reason: 'bad_readable_flag', name: rawName || key, where, flag: flag || null };
  }
  if (flag === 'unreadable') {
    // Requirement 7: honour the signal. The field is nulled, and the member is
    // told which one, so they can type it in on the confirm screen.
    return { ok: false, reason: 'unreadable', name: rawName || key, where };
  }

  if (PROPRIETARY_SCORE_NAMES.indexOf(key) !== -1) {
    return { ok: false, reason: 'proprietary_score', name: rawName || key, key, value: raw.value, evidence, flag, where };
  }

  let field = FIELD_ALIASES[key] || null;
  if (!field) {
    return { ok: false, reason: 'unknown_field', name: rawName || key, where };
  }

  // Strict: JSON numbers only. "48 ms" is the model narrating, not transcribing.
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    return { ok: false, reason: 'non_numeric_value', name: rawName, value: raw.value, where };
  }
  const value = raw.value;

  if (!evidence) return { ok: false, reason: 'no_evidence', name: rawName, value, where };
  if (!evidenceSupports(value, evidence)) {
    return { ok: false, reason: 'value_not_in_evidence', name: rawName, value, evidence, where };
  }

  // Temperature is the field a unit mistake ruins most completely, so its unit is
  // never assumed. Celsius -> canonical absolute; Fahrenheit -> raw + unit tag,
  // never converted; unitless -> refused.
  const extra = {};
  if (field === 'skinTemp' || field === 'skinTempDeviation') {
    const isDev = field === 'skinTempDeviation';
    const u = unit.toLowerCase();
    const celsius = (u.indexOf('c') !== -1 && u.indexOf('f') === -1)
      || u.indexOf('°c') !== -1 || u === 'celsius';
    const fahrenheit = u.indexOf('f') !== -1 && u.indexOf('c') === -1;
    if (celsius) {
      field = isDev ? 'skinTempDeviationC' : 'skinTempC';
      extra.tempBasis = isDev ? TEMP_BASIS.DEVIATION_C : TEMP_BASIS.ABSOLUTE_C;
      extra.skinTempUnit = 'C';
      extra.skinTempRaw = value;
    } else if (fahrenheit) {
      // Deliberately NOT converted — conversion is arithmetic, and arithmetic is
      // exactly what the model (and this module) must never do to a reading.
      return {
        ok: true,
        field: 'skinTempRaw',
        value,
        unit,
        flag,
        evidence,
        extra: { skinTempUnit: 'F' },
        screenIndex: Number.isFinite(raw.screen_index) ? raw.screen_index : null
      };
    } else {
      return { ok: false, reason: 'ambiguous_temperature_unit', name: rawName, value, where };
    }
  }

  if (!withinSanity(field, value)) {
    const range = SANITY[field] || [null, null];
    return { ok: false, reason: 'implausible', name: rawName, field, value, min: range[0], max: range[1], evidence, where };
  }

  return {
    ok: true,
    field,
    value,
    unit,
    flag,
    evidence,
    extra,
    screenIndex: Number.isFinite(raw.screen_index) ? raw.screen_index : null
  };
}

/** One `provider_scores[]` entry -> `{key, value}` under the device namespace. */
function acceptProviderScore(entry, ns, ctx) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const where = (ctx && ctx.where) || '';
  const key = normKey(raw.key || raw.name || raw.label);
  const flag = cleanStr(raw.readable, 20).toLowerCase();
  const evidence = cleanStr(raw.evidence, 400);

  if (!key) return { ok: false, reason: 'unnamed_provider_score', where };
  if (READ_FLAGS.indexOf(flag) === -1) return { ok: false, reason: 'bad_readable_flag', name: key, where, flag: flag || null };
  if (flag === 'unreadable') return { ok: false, reason: 'unreadable', name: key, where };

  let value = null;
  if (typeof raw.value === 'number' && Number.isFinite(raw.value)) {
    value = raw.value;
    if (!evidence) return { ok: false, reason: 'no_evidence', name: key, value, where };
    if (!evidenceSupports(value, evidence)) {
      return { ok: false, reason: 'value_not_in_evidence', name: key, value, evidence, where };
    }
  } else if (typeof raw.value === 'string' && raw.value.trim()) {
    // A brand score can legitimately be a word ("Balanced", "Bear"). Kept as a
    // short label; it is display-only and never charted.
    value = cleanStr(raw.value, 60);
  } else {
    return { ok: false, reason: 'non_numeric_value', name: key, value: raw.value, where };
  }

  // canonicalDay requires a namespaced, lowercase key: "noise.sleep_score".
  const safeNs = normKey(ns) || 'device';
  const namespaced = `${safeNs}.${key}`;
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(namespaced)) {
    return { ok: false, reason: 'unnamespaceable_key', name: key, where };
  }
  return { ok: true, key: namespaced, value, flag, evidence };
}

/* ------------------------------------------------------------------ *
 * Canonical build
 * ------------------------------------------------------------------ */

function firstDate(list) {
  const d = list.filter(Boolean).sort();
  return d.length ? d[0] : null;
}
function lastDate(list) {
  const d = list.filter(Boolean).sort();
  return d.length ? d[d.length - 1] : null;
}

/** The sentence the member reads on the confirm screen. It never oversells. */
function visionMessage(ctx) {
  const c = ctx || {};
  const n = c.dayCount || 0;
  const app = c.app || 'your app';
  if (!n) {
    return `We could not read a single dated reading from ${c.imageCount === 1 ? 'that screenshot' : 'those screenshots'}. `
      + 'Make sure the screen shows the calendar date next to the numbers, and that the whole card is in the picture.';
  }
  return `We read ${n} ${n === 1 ? 'day' : 'days'} from ${c.imageCount === 1 ? 'your screenshot' : `your ${c.imageCount} screenshots`} of ${app}. `
    + 'These figures were read by AI from a picture of your screen, not from a data file, so please check every number before you save it.';
}

/**
 * Model output -> the canonical `{days, workouts, journal, summary, rejected}`
 * contract, plus the review surface the confirm screen renders.
 *
 * Everything here is deterministic. The model's numbers are gated, sanity-checked
 * against canonicalDay.SANITY, tagged with their provenance and, where they
 * cannot survive the contract, dropped with a reason rather than fixed up.
 */
function buildCanonicalFromVision(extraction, opts) {
  const o = opts || {};
  const frag = o.fragment || devicePromptFragment(o.deviceId);
  const source = o.source || 'screenshot';
  const hrvMethod = o.hrvMethod || HRV_METHOD.UNKNOWN;
  const inputKind = o.inputKind === 'pdf' ? 'pdf' : 'images';
  const imageCount = Math.max(0, toNumber(o.imageCount, 0));
  const files = Array.isArray(o.files) ? o.files : [];
  const deviceModel = cleanStr(o.deviceModel || extraction.deviceModel, 120) || null;

  const notes = [];
  const implausible = [];
  const dropped = [];
  const rejected = [];
  const unknownLabels = [];
  const providerScoreKeys = [];
  const review = [];
  let accepted = 0;

  const noteDrop = (rej) => {
    if (rej.reason === 'unknown_field') {
      const label = cleanStr(rej.name, 120);
      if (label && unknownLabels.indexOf(label) === -1) unknownLabels.push(label);
    }
    if (rej.reason === 'implausible') {
      implausible.push({
        date: rej.date || null,
        field: rej.field,
        label: rej.name,
        value: rej.value,
        min: rej.min,
        max: rej.max,
        evidence: rej.evidence || null,
        reason: 'outside_plausible_range'
      });
    }
    if (dropped.length < 300) dropped.push(rej);
  };

  /* ---- days ---- */
  const dayMap = new Map();
  const reviewMap = new Map();

  (extraction.days || []).forEach((entry, i) => {
    const date = cleanStr(entry.date, 10);
    if (!isRealYmd(date)) {
      // Requirement 5: a day with no date is REJECTED, never guessed at, never
      // attached to "today". A date we cannot see is a day we do not have.
      rejected.push({
        reason: 'undated_day',
        where: `days[${i}]`,
        detail: `The model returned a day with no readable calendar date (${JSON.stringify(entry.date)}). `
          + 'Screenshots that say only "Today" cannot be dated.'
      });
      return;
    }

    const day = dayMap.get(date) || (() => {
      const d = emptyCanonicalDay(date, source);
      d.measurementSource = MEASUREMENT_SOURCE.VISION;
      d.deviceModel = deviceModel;
      return d;
    })();
    const rv = reviewMap.get(date) || { date, confident: [], flagged: [], dropped: [], implausible: [], providerScores: [] };

    (Array.isArray(entry.fields) ? entry.fields : []).forEach((f, fi) => {
      const res = acceptVisionField(f, { where: `days[${i}].fields[${fi}] ${date}` });
      if (!res.ok) {
        res.date = date;
        // A brand composite filed under `fields` is not thrown away — it is
        // rerouted to where rule 6 says it belongs.
        if (res.reason === 'proprietary_score') {
          const ps = acceptProviderScore(
            { key: res.key, value: res.value, readable: res.flag || 'confident', evidence: res.evidence },
            frag.ns,
            { where: res.where }
          );
          if (ps.ok) {
            day.providerScores[ps.key] = ps.value;
            if (providerScoreKeys.indexOf(ps.key) === -1) providerScoreKeys.push(ps.key);
            rv.providerScores.push(ps.key);
            noteDrop({
              ok: false,
              reason: 'proprietary_score_rerouted',
              name: res.name,
              to: ps.key,
              where: res.where,
              date
            });
            return;
          }
        }
        noteDrop(res);
        rv.dropped.push({ field: res.name || null, reason: res.reason });
        return;
      }
      day[res.field] = res.value;
      if (res.extra) Object.assign(day, res.extra);
      accepted += 1;
      if (res.flag === 'low_confidence') {
        rv.flagged.push({ field: res.field, evidence: res.evidence, why: 'the model said it was hard to read' });
      } else {
        rv.confident.push(res.field);
      }
    });

    (Array.isArray(entry.provider_scores) ? entry.provider_scores : []).forEach((p, pi) => {
      const res = acceptProviderScore(p, frag.ns, { where: `days[${i}].provider_scores[${pi}] ${date}` });
      if (!res.ok) {
        res.date = date;
        noteDrop(res);
        rv.dropped.push({ field: res.name || null, reason: res.reason });
        return;
      }
      day.providerScores[res.key] = res.value;
      if (providerScoreKeys.indexOf(res.key) === -1) providerScoreKeys.push(res.key);
      rv.providerScores.push(res.key);
      accepted += 1;
    });

    dayMap.set(date, day);
    reviewMap.set(date, rv);
  });

  /* ---- provenance + cross-field contract repair (rule 6 / rule 4) ---- */
  dayMap.forEach((day, date) => {
    const rv = reviewMap.get(date);

    if (day.hrvMs !== null) day.hrvMethod = hrvMethod;
    else day.hrvMethod = null;

    if (day.skinTempC !== null && day.skinTempDeviationC !== null) {
      // Contradictory: the same reading cannot be both. We do not pick a winner.
      notes.push(`${date}: both an absolute skin temperature and a deviation were read from the same day; both were discarded because they cannot both be right.`);
      implausible.push({ date, field: 'skinTempC', value: day.skinTempC, reason: 'absolute_and_deviation_conflict' });
      implausible.push({ date, field: 'skinTempDeviationC', value: day.skinTempDeviationC, reason: 'absolute_and_deviation_conflict' });
      day.skinTempC = null;
      day.skinTempDeviationC = null;
      day.tempBasis = null;
      if (rv) rv.dropped.push({ field: 'skinTempC', reason: 'absolute_and_deviation_conflict' });
    }
    if (day.skinTempC === null && day.skinTempDeviationC === null) day.tempBasis = null;

    if (day.sleepHours !== null && day.sleepMinutes !== null
        && Math.abs(day.sleepHours * 60 - day.sleepMinutes) > 1.5) {
      // Two readings of the same night that disagree. Keep the finer-grained one
      // and say so; do NOT reconcile them, that would be computing.
      notes.push(`${date}: the sleep total was read twice and the two readings disagree (${day.sleepHours}h vs ${day.sleepMinutes}min). The hours figure was dropped.`);
      implausible.push({ date, field: 'sleepHours', value: day.sleepHours, reason: 'disagrees_with_sleep_minutes' });
      day.sleepHours = null;
      if (rv) rv.dropped.push({ field: 'sleepHours', reason: 'disagrees_with_sleep_minutes' });
    }

    const stageSum = ['remMin', 'deepMin', 'lightMin']
      .reduce((acc, f) => (day[f] === null ? acc : acc + day[f]), 0);
    if (day.sleepMinutes !== null && stageSum > 0 && stageSum > day.sleepMinutes * 1.03 + 1) {
      notes.push(`${date}: the sleep stages add up to ${Math.round(stageSum)} minutes, more than the ${day.sleepMinutes}-minute night they belong to. All three stages were dropped — we cannot tell which was misread.`);
      ['remMin', 'deepMin', 'lightMin'].forEach((f) => {
        if (day[f] !== null) {
          implausible.push({ date, field: f, value: day[f], reason: 'stages_exceed_night' });
          day[f] = null;
          if (rv) rv.dropped.push({ field: f, reason: 'stages_exceed_night' });
        }
      });
    }
  });

  /* ---- confidence (ours, never the model's, and always capped) ---- */
  const modelBase = extraction.confidence === 'high'
    ? (inputKind === 'pdf' ? CONFIDENCE.VISION_PDF : CONFIDENCE.VISION_SCREENSHOT)
    : (extraction.confidence === 'medium' ? CONFIDENCE.VISION_DEGRADED : CONFIDENCE.VISION_LOW);

  const usableDays = [];
  dayMap.forEach((day, date) => {
    const rv = reviewMap.get(date) || { confident: [], flagged: [], dropped: [], providerScores: [] };
    const hasCanonical = canonical.METRIC_FIELDS.some((f) => f !== 'confidence' && f !== 'napMinutes' && day[f] !== null);
    const hasScores = Object.keys(day.providerScores).length > 0;
    if (!hasCanonical && !hasScores) {
      rejected.push({ reason: 'no_readable_values', where: `day ${date}`, detail: 'Nothing on that day survived the evidence and plausibility gates.' });
      return;
    }
    let c = modelBase;
    if (rv.flagged.length || rv.dropped.length) c = Math.min(c, CONFIDENCE.VISION_DEGRADED);
    c = Math.min(c, MAX_VISION_CONFIDENCE);
    day.confidence = Number(Math.max(CONFIDENCE.VISION_LOW, c).toFixed(2));
    usableDays.push(day);
    review.push(rv);
  });

  usableDays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  review.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /* ---- final contract self-check (belt and braces) ---- */
  const contractClean = [];
  usableDays.forEach((day, idx) => {
    const errs = validateCanonicalDay(day, { index: idx });
    if (errs.length) {
      // Should be unreachable: everything above already enforces the contract.
      // If it ever fires, the day is dropped with its errors rather than written.
      rejected.push({ reason: 'contract_violation', where: `day ${day.date}`, detail: errs.join('; ') });
      return;
    }
    contractClean.push(day);
  });

  /* ---- workouts ---- */
  const workouts = [];
  (extraction.workouts || []).forEach((w, i) => {
    const date = cleanStr(w.date, 10);
    if (!isRealYmd(date)) {
      rejected.push({ reason: 'undated_workout', where: `workouts[${i}]`, detail: 'A workout with no printed date cannot be placed.' });
      return;
    }
    const flag = cleanStr(w.readable, 20).toLowerCase();
    if (READ_FLAGS.indexOf(flag) === -1 || flag === 'unreadable') {
      rejected.push({ reason: flag === 'unreadable' ? 'unreadable_workout' : 'bad_readable_flag', where: `workouts[${i}]` });
      return;
    }
    const evidence = cleanStr(w.evidence, 400);
    const traced = (v, field) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      if (!evidence || !evidenceSupports(v, evidence)) {
        noteDrop({ ok: false, reason: 'value_not_in_evidence', name: `workout.${field}`, value: v, where: `workouts[${i}]`, date });
        return null;
      }
      if (field && SANITY[field] && !withinSanity(field, v)) {
        noteDrop({ ok: false, reason: 'implausible', name: `workout.${field}`, field, value: v, min: SANITY[field][0], max: SANITY[field][1], where: `workouts[${i}]`, date });
        return null;
      }
      accepted += 1;
      return v;
    };
    workouts.push({
      date,
      startedAt: date,
      endedAt: null,
      durationMin: traced(w.duration_min, null),
      activity: cleanStr(w.activity, 120) || null,
      strain: traced(w.strain, 'strain'),
      energyKcal: traced(w.energy_kcal, 'energyKcal'),
      maxHr: traced(w.max_hr, 'maxHr'),
      avgHr: traced(w.avg_hr, 'avgHr'),
      zones: { z1: null, z2: null, z3: null, z4: null, z5: null },
      measurementSource: MEASUREMENT_SOURCE.VISION
    });
  });
  workouts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /* ---- summary ---- */
  const dates = contractClean.map((d) => d.date).concat(workouts.map((w) => w.date));
  const dateRange = { from: firstDate(dates), to: lastDate(dates) };

  const parsedOut = emptyParsedExport(source, []);
  parsedOut.days = contractClean;
  parsedOut.workouts = workouts;
  parsedOut.journal = [];
  parsedOut.rejected = rejected;

  const s = parsedOut.summary;
  s.provider = source;
  s.device = frag.id;
  s.deviceLabel = frag.app;
  s.deviceProvider = frag.provider;
  s.deviceKnown = frag.known;
  s.deviceModel = deviceModel;
  s.measurementSource = MEASUREMENT_SOURCE.VISION;
  s.hrvMethod = hrvMethod;
  s.inputKind = inputKind;
  s.imageCount = imageCount;
  s.filesSeen = files.map((f) => ({
    name: f.fileName,
    kind: f.kind,
    bytes: f.bytes,
    rowsParsed: null,
    rowsRejected: null
  }));
  s.rowsParsed = accepted;
  s.rowsRejected = dropped.length + rejected.length;
  s.dateRange = dateRange;
  s.unknownColumns = unknownLabels.map((column) => ({ file: files.length === 1 ? files[0].fileName : 'screenshots', kind: inputKind, column }));
  s.duplicates = [];
  s.implausible = implausible;
  s.providerScoreKeys = providerScoreKeys;
  s.review = review;
  s.reviewRequired = true;
  s.confidenceTier = { vision: MAX_VISION_CONFIDENCE, fileParse: FILE_PARSE_CONFIDENCE };

  const message = visionMessage({ dayCount: contractClean.length, imageCount: imageCount || files.length, app: frag.app });

  // THE honesty note. First in the list because the UI shows the first note
  // most prominently, and this is the one sentence that must not be missed.
  s.notes = [
    `These figures were read by AI from ${inputKind === 'pdf' ? 'a PDF' : (imageCount === 1 ? 'a screenshot' : `${imageCount} screenshots`)} of ${frag.app}, not from a data file. Please confirm every number below before saving — a misread digit looks exactly like a real reading.`
  ]
    .concat(notes)
    .concat((extraction.notes || []).slice(0, 20));

  if (implausible.length) {
    s.notes.push(`${implausible.length} value(s) were outside the physiologically plausible range and were removed rather than saved. They are listed under "implausible".`);
  }
  if (providerScoreKeys.length) {
    s.notes.push(`${providerScoreKeys.length} ${frag.app} score(s) (${providerScoreKeys.join(', ')}) were kept as brand-specific figures. They are shown beside the ${frag.app} name and are never compared with another device's numbers.`);
  }
  if ((extraction.undated || []).length) {
    s.notes.push(`${extraction.undated.length} reading(s) had no calendar date on screen and were not saved. Screens that say only "Today" cannot be dated.`);
  }
  if ((extraction.unreadable || []).length) {
    s.notes.push(`${extraction.unreadable.length} value(s) were too unclear to read and were left blank rather than guessed.`);
  }

  const rank = { low: 0, medium: 1, high: 2 };
  let computed = 'high';
  if (dropped.length || implausible.length || rejected.length) computed = 'medium';
  if (!accepted || dropped.length > accepted) computed = 'low';
  const confidence = rank[computed] <= rank[extraction.confidence] ? computed : extraction.confidence;

  return {
    days: parsedOut.days,
    workouts: parsedOut.workouts,
    journal: parsedOut.journal,
    summary: s,
    rejected: parsedOut.rejected,
    parsed: parsedOut,
    review,
    implausible,
    dropped,
    providerScoreKeys,
    message,
    confidence,
    uncertain: (extraction.undated || []).concat(extraction.unreadable || [])
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * The failure shape every caller already understands.
 *
 * ONE CAUSE, ONE CODE. This codebase has already had to fix a bug where an
 * unconfigured API key was reported to the member as a malformed file; every
 * distinct cause below therefore keeps its own code, and routes/wearables.js's
 * PDF_ERROR_STATUS table maps them to HTTP status without guessing.
 */
function fail(code, error, extra) {
  return Object.assign({ ok: false, code, error, message: error }, extra || {});
}

/**
 * Normalise whatever the route hands us into `[{buffer, fileName, kind, bytes}]`.
 * Accepts a Buffer, an array of Buffers, `{buffer, fileName}`, an array of those,
 * or `{files: [...]}`.
 */
function normalizeInputs(input) {
  let list = [];
  if (!input) return list;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) list = [input];
  else if (Array.isArray(input)) list = input;
  else if (Array.isArray(input.files)) list = input.files;
  else if (input.buffer !== undefined || input.data !== undefined) list = [input];
  else return list;

  return list.map((item, i) => {
    const buf = toBuf(item) || toBuf(item && (item.buffer !== undefined ? item.buffer : item.data));
    const fileName = cleanStr(item && (item.fileName || item.name || item.filename), 200) || `upload_${i + 1}`;
    return {
      buffer: buf,
      fileName,
      bytes: buf ? buf.length : 0,
      kind: buf ? classifyVisionBuffer(buf) : 'unknown'
    };
  });
}

/**
 * Read a PDF or a set of screenshots from ANY wearable app into canonical days.
 *
 * Success returns the canonical `{days, workouts, journal, summary, rejected}`
 * contract — validated against canonicalDay.validateParsedExport before it is
 * returned — plus the honesty surface (`review`, `implausible`, `message`,
 * `confidence`, `dropped`) and `usage` for the token ledger.
 *
 * Failure returns `{ok:false, code, error, message}` and NEVER throws. Codes:
 *
 *   Inherited from whoopPdfExtract (Whoop-PDF delegation passes these through):
 *     NOT_A_PDF, PDF_EMPTY, PDF_TOO_LARGE, PDF_TOO_MANY_PAGES,
 *     NOT_A_WHOOP_PDF, PDF_UNREADABLE, PDF_NO_DATA, PDF_AI_UNAVAILABLE
 *   New, one per distinct cause:
 *     UPLOAD_EMPTY               nothing, or a zero-length file, was uploaded
 *     NOT_AN_IMAGE               the bytes are neither an image nor a PDF
 *     UNSUPPORTED_IMAGE_FORMAT   a real image we cannot send (HEIC from an iPhone)
 *     IMAGE_TOO_LARGE            one image over MAX_IMAGE_BYTES
 *     IMAGES_TOTAL_TOO_LARGE     the set over MAX_TOTAL_IMAGE_BYTES
 *     TOO_MANY_IMAGES            more than MAX_IMAGES files
 *     MIXED_UPLOAD_TYPES         a PDF and screenshots in one upload
 *     DEVICE_NOT_SPECIFIED       no device id was declared
 *     DEVICE_MISMATCH            the screens are not from the declared device's app
 *     VISION_AI_UNAVAILABLE      no API key — reading images needs the model
 *     VISION_CLIENT_INVALID      an injected client we cannot call
 *     VISION_UNREADABLE          the model returned nothing that fits the schema
 *     VISION_NO_DATA             readable screens with no dated, traceable value
 *     PDF_EXTRACTOR_UNAVAILABLE  a Whoop PDF, but whoopPdfExtract is not deployed
 *
 * @param {Buffer|Buffer[]|{files:Array}|{buffer:Buffer}} input
 * @param {Object} [opts]
 * @param {string}  opts.deviceId   declared device, e.g. 'noise' | 'garmin' | 'whoop'
 * @param {string} [opts.apiKey]    defaults to process.env.ANTHROPIC_API_KEY
 * @param {Object|Function} [opts.client]  injectable model client — tests pass a stub
 * @param {string} [opts.source]    canonical provider for day.source (default 'screenshot')
 * @param {string} [opts.hrvMethod] overrides the registry's declaration
 * @param {string} [opts.deviceModel]
 * @param {boolean}[opts.allowGenericDevice=true]
 */
async function extract(input, opts = {}) {
  const o = opts || {};
  const rawDeviceId = cleanStr(o.deviceId || o.device || o.provider, 60);
  const files = normalizeInputs(input);

  if (!files.length || files.every((f) => !f.buffer || !f.buffer.length)) {
    return fail('UPLOAD_EMPTY', 'That upload is empty. Please attach a screenshot of your app, or the PDF summary it exported.');
  }

  if (!rawDeviceId) {
    // Deliberately not defaulted: a prompt written for the wrong app produces a
    // confident, wrong transcription, which is worse than a refusal.
    return fail('DEVICE_NOT_SPECIFIED', 'Please tell us which app or device this screenshot is from, so we read the right screen.');
  }
  const frag = devicePromptFragment(rawDeviceId);

  /* ---- 1. type gates ---- */
  const pdfs = files.filter((f) => f.kind === 'pdf');
  if (pdfs.length && pdfs.length !== files.length) {
    return fail('MIXED_UPLOAD_TYPES', 'Please upload either one PDF, or a set of screenshots — not both together.');
  }
  if (pdfs.length > 1) {
    return fail('MIXED_UPLOAD_TYPES', 'Please upload one PDF at a time.');
  }

  /* ---- 2. Whoop PDF: delegate, unchanged ---- */
  if (pdfs.length === 1 && frag.id === 'whoop') {
    if (!whoopPdfExtract || typeof whoopPdfExtract.extractWhoopPdf !== 'function') {
      return fail(
        'PDF_EXTRACTOR_UNAVAILABLE',
        'Whoop PDF imports are not available on this server. Please upload your Whoop ZIP export instead (Whoop app → Settings → Data Export).'
      );
    }
    // Pass through UNCHANGED. That extractor is live in production, it is the
    // authority on Whoop PDFs, and wrapping it must not alter one field.
    return whoopPdfExtract.extractWhoopPdf({
      buffer: pdfs[0].buffer,
      fileName: pdfs[0].fileName,
      apiKey: o.apiKey
    });
  }

  const inputKind = pdfs.length === 1 ? 'pdf' : 'images';

  if (inputKind === 'pdf') {
    const f = pdfs[0];
    if (f.bytes > MAX_PDF_BYTES) {
      return fail('PDF_TOO_LARGE', `That PDF is larger than ${Math.round(MAX_PDF_BYTES / (1024 * 1024))}MB. Please upload just the summary pages.`);
    }
    const pages = pdfPageCount(f.buffer);
    if (pages !== null && pages > MAX_PDF_PAGES) {
      return fail('PDF_TOO_MANY_PAGES', `That PDF has ${pages} pages, more than the ${MAX_PDF_PAGES} we can read.`, { pages });
    }
  } else {
    // Count first, then per-image, then the total. Each cap keeps its own code so
    // the member is told what to actually change.
    if (files.length > MAX_IMAGES) {
      return fail('TOO_MANY_IMAGES', `Please upload at most ${MAX_IMAGES} screenshots at a time. You sent ${files.length}.`, { imageCount: files.length, max: MAX_IMAGES });
    }
    let total = 0;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      if (!f.buffer || !f.bytes) {
        return fail('UPLOAD_EMPTY', `"${f.fileName}" is empty. Please attach the screenshot again.`, { fileName: f.fileName });
      }
      if (f.kind === 'heic') {
        return fail(
          'UNSUPPORTED_IMAGE_FORMAT',
          `"${f.fileName}" is an HEIC photo, which we cannot read. On iPhone, open the screenshot in Photos, tap Share → Options and choose "Most Compatible", or take a screenshot instead of exporting the photo.`,
          { fileName: f.fileName, detected: 'heic' }
        );
      }
      if (!isImageKind(f.kind)) {
        return fail(
          'NOT_AN_IMAGE',
          `"${f.fileName}" is not an image. Please upload a PNG or JPEG screenshot of your app, or the PDF it exported.`,
          { fileName: f.fileName, detected: f.kind }
        );
      }
      if (f.bytes > MAX_IMAGE_BYTES) {
        return fail(
          'IMAGE_TOO_LARGE',
          `"${f.fileName}" is larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB. A phone screenshot is normally well under that — please send the screenshot rather than a full-resolution photo.`,
          { fileName: f.fileName, bytes: f.bytes, max: MAX_IMAGE_BYTES }
        );
      }
      total += f.bytes;
    }
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      return fail(
        'IMAGES_TOTAL_TOO_LARGE',
        `Those ${files.length} screenshots come to ${Math.round(total / (1024 * 1024))}MB together, over the ${Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))}MB limit. Please send them in two batches.`,
        { totalBytes: total, max: MAX_TOTAL_IMAGE_BYTES }
      );
    }
  }

  /* ---- 3. client + key ---- */
  let client = null;
  if (o.client) {
    client = normalizeClient(o.client);
    if (!client) {
      return fail('VISION_CLIENT_INVALID', 'The configured AI client cannot be called. This is a server configuration problem, not a problem with your file.');
    }
  }
  const key = String(o.apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!client) {
    if (!key) {
      // Graceful degradation, and NOT collapsed into "your file is unreadable" —
      // that conflation is a bug this codebase has already fixed once.
      return fail(
        'VISION_AI_UNAVAILABLE',
        'Reading screenshots is not configured on this server. Please enter your figures manually, or upload a data export from your app if it offers one.'
      );
    }
    client = defaultClient;
  }

  /* ---- 4. the one model call ---- */
  const model = (
    process.env.ANTHROPIC_MODEL_DEVICE_VISION ||
    process.env.ANTHROPIC_MODEL_WHOOP_PDF ||
    process.env.ANTHROPIC_MODEL_BLOOD ||
    process.env.ANTHROPIC_MODEL ||
    // Same default as whoopPdfExtract, deliberately — one convention, not two.
    // A dense multi-screen upload reads better on a stronger model; raise it with
    // ANTHROPIC_MODEL_DEVICE_VISION=claude-sonnet-4-6 rather than editing this.
    'claude-haiku-4-5'
  ).trim();
  const maxTokens = Math.max(
    2000,
    parseInt(process.env.ANTHROPIC_DEVICE_VISION_MAX_TOKENS || '12000', 10) || 12000
  );

  const mediaBlocks = inputKind === 'pdf'
    ? [{
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfs[0].buffer.toString('base64') }
    }]
    : files.map((f) => ({
      type: 'image',
      source: { type: 'base64', media_type: IMAGE_MEDIA_TYPES[f.kind], data: f.buffer.toString('base64') }
    }));

  const instruction = inputKind === 'pdf'
    ? `Transcribe every figure printed in this ${frag.app} document. Quote the exact text each number came from. Only emit a day when a calendar date is printed beside the value.`
    : `Transcribe every figure visible in ${files.length === 1 ? 'this screenshot' : `these ${files.length} screenshots`} of ${frag.app}, in order. Quote the exact on-screen text each number came from. Only emit a day when a calendar date is printed on the screen.`;

  let pass;
  try {
    pass = await runJsonPass({
      client,
      apiKey: key,
      model,
      maxTokens,
      maxRetryTokens: 32000,
      system: buildSystemPrompt(frag),
      userContent: mediaBlocks.concat([{ type: 'text', text: instruction }]),
      coerce: coerceVisionExtraction
    });
  } catch (err) {
    console.warn('[device vision] extraction failed:', err && err.message);
    return fail(
      'VISION_UNREADABLE',
      `We could not read ${inputKind === 'pdf' ? 'that PDF' : 'those screenshots'} right now. Please try again in a moment.`,
      { model, device: frag.id, detail: String((err && err.message) || err || '').slice(0, 500) }
    );
  }

  if (!pass.result) {
    return fail(
      'VISION_UNREADABLE',
      `We could not read ${inputKind === 'pdf' ? 'that PDF' : 'those screenshots'}. Please make sure the numbers and the date are fully visible and try again.`,
      { model, device: frag.id, usage: pass.usage, stopReason: pass.stopReason }
    );
  }

  const extraction = pass.result;
  if (!extraction.isExpectedDevice) {
    return fail(
      'DEVICE_MISMATCH',
      `Those ${inputKind === 'pdf' ? 'pages' : 'screenshots'} do not look like ${frag.app}${extraction.appSeen ? ` — they look like ${extraction.appSeen}` : ''}. Please pick the right app, or upload screenshots from ${frag.app}.`,
      { model, device: frag.id, appSeen: extraction.appSeen, usage: pass.usage, notes: extraction.notes }
    );
  }

  /* ---- 5. deterministic canonical build ---- */
  const built = buildCanonicalFromVision(extraction, {
    deviceId: rawDeviceId,
    fragment: frag,
    source: resolveSource(o),
    hrvMethod: resolveHrvMethod(frag.id, o),
    deviceModel: o.deviceModel || extraction.deviceModel,
    inputKind,
    imageCount: inputKind === 'pdf' ? 0 : files.length,
    files
  });

  if (!built.days.length && !built.workouts.length) {
    return fail('VISION_NO_DATA', built.message, {
      model,
      device: frag.id,
      usage: pass.usage,
      rejected: built.rejected,
      dropped: built.dropped,
      implausible: built.implausible,
      notes: built.summary.notes
    });
  }

  // The single gate every adapter must pass. If we cannot satisfy our own
  // contract we say so rather than handing the route something the persist layer
  // will reject halfway through.
  const check = canonical.validateParsedExport(built.parsed);
  if (!check.ok) {
    console.warn('[device vision] contract violation:', check.errors.slice(0, 5).join('; '));
    return fail('VISION_UNREADABLE', 'We read those screens but could not turn them into a valid record. Nothing was saved.', {
      model,
      device: frag.id,
      usage: pass.usage,
      contractErrors: check.errors.slice(0, 20)
    });
  }

  return {
    ok: true,
    kind: 'device_vision',
    device: frag.id,
    deviceLabel: frag.app,
    deviceKnown: frag.known,
    appSeen: extraction.appSeen,
    deviceModel: built.summary.deviceModel,
    inputKind,
    imageCount: inputKind === 'pdf' ? 0 : files.length,
    // Canonical contract — flows through previewUpload / commitUpload unchanged.
    days: built.days,
    workouts: built.workouts,
    journal: built.journal,
    summary: built.summary,
    rejected: built.rejected,
    // Honesty surface, for the preview -> confirm screen.
    review: built.review,
    implausible: built.implausible,
    providerScoreKeys: built.providerScoreKeys,
    message: built.message,
    confidence: built.confidence,
    dayConfidence: built.days.length ? built.days[0].confidence : null,
    maxConfidence: MAX_VISION_CONFIDENCE,
    uncertain: built.uncertain,
    dropped: built.dropped,
    // ── TOKEN LEDGER ──
    // Every AI call in BodyBank writes one row, or its cost is invisible. The
    // route MUST make this call on BOTH the success and the failure paths (a
    // refused read still burned tokens):
    //
    //   recordAiUsage({
    //     scope: 'device_vision',
    //     usage: out.usage,
    //     model: out.model,
    //     userId: req.user.id,
    //     refType: 'wearable_upload',
    //     refId: sha256
    //   });
    //
    // INTEGRATION NOTE: add `device_vision: 'Wearables — screenshot import'` to
    // SCOPE_LABELS in services/aiUsageLedger.js, or the admin Tokens screen shows
    // the raw slug instead of a readable label.
    usage: pass.usage,
    model
  };
}

module.exports = {
  extract,
  // Alias so a caller can name the concern at the call site.
  extractDeviceVision: extract,

  // Pure helpers, exported for tests and for the route's own branching.
  classifyVisionBuffer,
  isImageKind,
  pdfPageCount,
  normalizeInputs,
  normalizeDeviceId,
  devicePromptFragment,
  buildSystemPrompt,
  registryDevice,
  resolveHrvMethod,
  resolveSource,
  coerceVisionExtraction,
  acceptVisionField,
  acceptProviderScore,
  buildCanonicalFromVision,
  evidenceSupports,
  withinSanity,
  visionMessage,
  fail,

  // Constants the route's error table and the UI copy read from.
  DEVICE_PROMPTS,
  GENERIC_DEVICE,
  FIELD_ALIASES,
  PROPRIETARY_SCORE_NAMES,
  READ_FLAGS,
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  CONFIDENCE,
  MAX_VISION_CONFIDENCE,
  FILE_PARSE_CONFIDENCE,
  DEVICE_API_CONFIDENCE,
  NATIVE_SDK_CONFIDENCE
};

/*
 * ───────────────────────────────────────────────────────────────────────────
 * INTEGRATION NOTES — changes needed in files this slice does not own
 * ───────────────────────────────────────────────────────────────────────────
 *
 * INTEGRATION NOTE 1 (VERIFIED CLEAR — recheck if either list changes):
 *   Every day this module produces uses source='screenshot' (see resolveSource()
 *   for why that matters). readinessService.VALID_PROVIDERS was checked while
 *   writing this and now contains 'screenshot', so commitUpload will accept these
 *   rows. If that list is ever narrowed again, this module's output will be
 *   normalised to null and every screenshot upload will silently write nothing
 *   while appearing to succeed. 'screenshot' must also keep a SOURCE_PRECEDENCE
 *   rank BELOW 'whoop' and 'manual' (a higher number) so a real export always
 *   wins a same-date collision.
 *
 * INTEGRATION NOTE 2 (token ledger):
 *   services/aiUsageLedger.js SCOPE_LABELS needs
 *     device_vision: 'Wearables — screenshot import'
 *   or the admin Tokens screen groups this spend under a raw slug. The exact
 *   recordAiUsage() call the route should make is documented at the `usage`
 *   field of the success return above; it must ALSO be made when this function
 *   returns {ok:false} with a `usage` field (DEVICE_MISMATCH, VISION_NO_DATA and
 *   VISION_UNREADABLE-after-a-call all spent real tokens).
 *
 * INTEGRATION NOTE 3 (route error table):
 *   routes/wearables.js PDF_ERROR_STATUS should gain, for this module's codes:
 *     UPLOAD_EMPTY: 400, NOT_AN_IMAGE: 400, UNSUPPORTED_IMAGE_FORMAT: 415,
 *     MIXED_UPLOAD_TYPES: 400, DEVICE_NOT_SPECIFIED: 400, DEVICE_MISMATCH: 400,
 *     IMAGE_TOO_LARGE: 413, IMAGES_TOTAL_TOO_LARGE: 413, TOO_MANY_IMAGES: 413,
 *     VISION_AI_UNAVAILABLE: 503, VISION_CLIENT_INVALID: 503,
 *     PDF_EXTRACTOR_UNAVAILABLE: 503
 *   VISION_UNREADABLE and VISION_NO_DATA describe the content, so they take the
 *   existing 422 default.
 *
 * INTEGRATION NOTE 4 (upload size ceiling):
 *   MAX_TOTAL_IMAGE_BYTES is 15MB decoded (~20MB base64). routes/wearables.js
 *   MAX_UPLOAD_BYTES is 25MB and server.js's express.json limit is 40mb, so a
 *   full batch fits — but the route currently checks ONE base64 body. A
 *   multi-screenshot endpoint must sum the encoded lengths before allocating.
 *
 * INTEGRATION NOTE 5 (device registry — VERIFIED WORKING):
 *   registryDevice() probes several accessor names because deviceRegistry.js did
 *   not exist when this was written. It has since landed and exports getDevice(),
 *   which the probe finds first; resolveHrvMethod() was checked against it and
 *   correctly returns the DECLARED method (garmin/oura/fitbit/whoop rmssd_sleep,
 *   apple_health sdnn_spot). Devices the registry does not carry — Noise, boAt,
 *   Fire-Boltt and the rest of the long tail this module exists for — fall back
 *   to 'unknown', which is correct: their HRV must stay out of cross-device
 *   trends until somebody can say how it was measured. The probe can be collapsed
 *   to a direct getDevice() call whenever someone wants to tidy it.
 *
 *   Its confidence model agrees with this one by construction: the registry's
 *   SOURCE_MULTIPLIER[VISION] is 0.6, the same ceiling as MAX_VISION_CONFIDENCE
 *   here. If one moves, move the other, or a day's confidence will mean two
 *   different things depending on which module computed it.
 *
 * INTEGRATION NOTE 6 (preview -> confirm UI):
 *   `summary.review` (and the identical top-level `review`) is per-day
 *   `{date, confident[], flagged[], dropped[], providerScores[]}`. Render
 *   `flagged` fields as editable-and-highlighted, `dropped` as "we could not read
 *   this — type it in", and show `summary.notes[0]` verbatim above the table.
 *   `day.confidence` (<= 0.60) and `day.measurementSource === 'vision'` are what
 *   any later screen must use to avoid presenting these as measured facts.
 */
