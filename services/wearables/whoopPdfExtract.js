'use strict';

/**
 * BodyBank — Whoop PDF ingestion.
 *
 * Members often hold a Whoop PDF (Monthly Performance Assessment, Health
 * Monitor report) rather than the ZIP export. routes/wearables.js used to read
 * a PDF as if it were CSV and then blame the member — "No daily records were
 * found in that export" — for a format we never supported. This module reads it
 * properly, and is honest about the ceiling:
 *
 *   A MONTHLY PDF CARRIES AGGREGATES, NOT 365 PER-DAY ROWS. A monthly average is
 *   never spread across the days of that month. If the document only supports
 *   monthly summaries we return them flagged as such, with a plain sentence the
 *   caller can show the member, and `days` stays empty.
 *
 * The same design rule as the rest of the Whoop subsystem applies: NOTHING IS
 * EVER INVENTED. Claude transcribes; it does not compute. Every number it
 * returns must arrive with the verbatim PDF line it came from, and a
 * deterministic gate here proves the number actually appears in that line
 * before the value is kept. Missing numerics stay null — never 0.
 *
 * The HTTP harness (fetch -> /v1/messages, x-api-key + anthropic-version,
 * AbortController timeout, escalating-max_tokens retry, defensive JSON parsing,
 * usage/cost estimation) mirrors services/bloodAnalysisService.js and
 * services/wearables/whoopReportService.js.
 */

const { parseAnthropicJson, formatAnthropicApiError } = require('../nutritionService');
const { isZip } = require('./zipReader');

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** Claude accepts ~32MB per request; a Whoop PDF is a few hundred KB. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Claude caps a PDF at 100 pages on a 200k-context model. A monthly assessment is under 20. */
const MAX_PDF_PAGES = 60;
/** Below this many recovered characters we cannot judge the text layer at all. */
const MIN_TEXT_CHARS_TO_JUDGE = 400;
/** An identical value on this many consecutive days is a smeared average, not daily data. */
const SMEAR_RUN_LEN = 7;

/** Words that only appear in a Whoop document. Used for a free, fail-open prefilter. */
const WHOOP_MARKERS = [
  'whoop',
  'recovery score',
  'day strain',
  'sleep performance',
  'hrv',
  'heart rate variability',
  'resting heart rate',
  'strain coach',
  'sleep coach'
];

// ---------------------------------------------------------------------------
// Anthropic harness (mirrors services/wearables/whoopReportService.js)
// ---------------------------------------------------------------------------

function anthropicTextFromMessage(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  return blocks.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('');
}

function parseAnyJsonBlock(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  try {
    return JSON.parse(t);
  } catch (_) {}

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(t))) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    try {
      return JSON.parse(body);
    } catch (_) {}
  }

  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < t.length; j += 1) {
      const ch = t[j];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth === 0) {
        const candidate = t.slice(i, j + 1);
        try {
          return JSON.parse(candidate);
        } catch (_) {
          break;
        }
      }
    }
  }
  return null;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function callAnthropicMessages({ apiKey, model, maxTokens, system, userContent }) {
  const timeoutMs = Math.max(
    30000,
    parseInt(process.env.ANTHROPIC_WHOOP_REQUEST_TIMEOUT_MS || '300000', 10) || 300000
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Anthropic request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  const messages = [{ role: 'user', content: userContent }];
  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages
    })
  }).finally(() => clearTimeout(timer));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(formatAnthropicApiError(res.status, data));
  }
  return data;
}

/**
 * JSON-producing pass with escalating max_tokens: parses defensively, retries
 * once at a much larger budget when the first attempt is truncated, and sums
 * usage across attempts. No assistant prefill — some models reject it.
 */
async function runJsonPass({ apiKey, model, maxTokens, system, userContent, coerce, maxRetryTokens }) {
  let inputTokens = 0;
  let outputTokens = 0;
  let lastData = null;
  const bumped = Math.min(maxRetryTokens || 32000, Math.max(maxTokens + 4000, Math.floor(maxTokens * 1.8)));
  const attempts = maxTokens >= bumped ? [maxTokens] : [maxTokens, bumped];
  for (let i = 0; i < attempts.length; i += 1) {
    const data = await callAnthropicMessages({ apiKey, model, maxTokens: attempts[i], system, userContent });
    lastData = data;
    inputTokens += toNumber(data && data.usage && data.usage.input_tokens, 0);
    outputTokens += toNumber(data && data.usage && data.usage.output_tokens, 0);
    const text = anthropicTextFromMessage(data);
    const parsed = parseAnyJsonBlock(text) || parseAnthropicJson(text);
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

function modelPricing(model) {
  const m = String(model || '').toLowerCase();
  let inPerM;
  let outPerM;
  if (m.includes('haiku')) {
    inPerM = 1;
    outPerM = 5;
  } else if (m.includes('sonnet')) {
    inPerM = 3;
    outPerM = 15;
  } else if (m.includes('opus')) {
    inPerM = 5;
    outPerM = 25;
  } else if (m.includes('fable') || m.includes('mythos')) {
    inPerM = 10;
    outPerM = 50;
  } else {
    inPerM = 1;
    outPerM = 5;
  }
  if (process.env.ANTHROPIC_INPUT_PER_MILLION_USD) {
    inPerM = toNumber(process.env.ANTHROPIC_INPUT_PER_MILLION_USD, inPerM);
  }
  if (process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD) {
    outPerM = toNumber(process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD, outPerM);
  }
  return [inPerM, outPerM];
}

function estimateAnthropicUsageCost(inputTokens, outputTokens, model) {
  const usdToInr = toNumber(process.env.AI_COST_USD_TO_INR, 83);
  const [inputPerMillionUsd, outputPerMillionUsd] = modelPricing(model);
  const inUsd =
    (toNumber(inputTokens, 0) / 1000000) * inputPerMillionUsd +
    (toNumber(outputTokens, 0) / 1000000) * outputPerMillionUsd;
  const inInr = inUsd * usdToInr;
  return {
    estimated_cost_usd: Number(inUsd.toFixed(6)),
    estimated_cost_inr: Number(inInr.toFixed(4))
  };
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

// ---------------------------------------------------------------------------
// Buffer classification (pure — the route imports this to branch on upload type)
// ---------------------------------------------------------------------------

function toBuf(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return null;
}

/**
 * What did the member actually upload?
 *
 * Pure, allocation-light, and never throws — the route calls it before deciding
 * between the ZIP/CSV parser and the PDF path.
 *
 * @param {Buffer} input
 * @returns {'zip'|'csv'|'pdf'|'unknown'}
 */
function classifyUploadBuffer(input) {
  const buf = toBuf(input);
  if (!buf || !buf.length) return 'unknown';

  // A PDF starts with %PDF-, though some tools prepend a few junk bytes.
  const head = buf.slice(0, 1024).toString('latin1');
  if (head.indexOf('%PDF-') !== -1) return 'pdf';
  if (isZip(buf)) return 'zip';

  // CSV is anything that decodes as mostly-printable text with a delimiter.
  const sample = buf.slice(0, 4096).toString('utf8');
  if (!sample) return 'unknown';
  let printable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 65533)) printable += 1;
  }
  if (printable / sample.length < 0.9) return 'unknown';
  if (sample.indexOf(',') === -1 && sample.indexOf('\t') === -1 && sample.indexOf(';') === -1) return 'unknown';
  return 'csv';
}

// ---------------------------------------------------------------------------
// Cheap PDF inspection (no dependency — we only need caps and a fail-open sniff)
// ---------------------------------------------------------------------------

/**
 * Page count from the page objects, or null when the structure is hidden inside
 * compressed object streams. Null means "we don't know" — it is never guessed,
 * and an unknown count skips the page cap rather than inventing a reason to
 * reject a member's file.
 */
function pdfPageCount(input) {
  const buf = toBuf(input);
  if (!buf || !buf.length) return null;
  const raw = buf.toString('latin1');
  const matches = raw.match(/\/Type\s*\/Page(?![s])/g);
  if (!matches || !matches.length) return null;
  return matches.length;
}

/**
 * Recover whatever plain text sits in uncompressed content streams. Most PDFs
 * Flate-compress their text, so this often returns very little — hence the
 * `decidable` flag rather than a bare string.
 */
function extractPdfTextLayer(input) {
  const buf = toBuf(input);
  if (!buf || !buf.length) return { text: '', decidable: false };
  const raw = buf.toString('latin1');
  const out = [];
  const re = /\(((?:\\.|[^\\()]){2,400})\)/g;
  let m;
  while ((m = re.exec(raw))) {
    const s = String(m[1] || '').replace(/\\([()\\])/g, '$1');
    let printable = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable += 1;
    }
    // Compressed streams yield parenthesised binary noise; skip anything that
    // is not overwhelmingly readable ASCII.
    if (s.length && printable / s.length >= 0.9) out.push(s);
    if (out.length > 20000) break;
  }
  const text = out.join(' ');
  return { text, decidable: text.length >= MIN_TEXT_CHARS_TO_JUDGE };
}

/**
 * Free prefilter: is this a Whoop document at all?
 *
 * FAIL-OPEN by design. We only claim "not Whoop" when there IS a readable text
 * layer and it contains none of the markers. When the text is compressed we
 * cannot tell, so we say so and let the model decide — the same posture as the
 * blood-report pre-validator, which never blocks a valid member on an
 * inconclusive check.
 */
function sniffWhoopMarkers(input) {
  const layer = extractPdfTextLayer(input);
  const low = layer.text.toLowerCase();
  const matched = WHOOP_MARKERS.filter((w) => low.indexOf(w) !== -1);
  return { decidable: layer.decidable, matched, textLength: layer.text.length, text: layer.text };
}

// ---------------------------------------------------------------------------
// What we accept back from the model
// ---------------------------------------------------------------------------

/**
 * Canonical day fields we will accept, with the plausible range for each.
 * A value outside its range is a transcription error, and "we don't know" is
 * honest where "temperature 900" is not — so it is dropped and reported.
 */
const METRIC_SPECS = {
  recoveryScore: { min: 0, max: 100 },
  hrvMs: { min: 1, max: 400 },
  restingHr: { min: 20, max: 150 },
  spo2: { min: 50, max: 100 },
  respiratoryRate: { min: 4, max: 40 },
  strain: { min: 0, max: 21 },
  energyKcal: { min: 0, max: 20000 },
  maxHr: { min: 40, max: 240 },
  avgHr: { min: 30, max: 220 },
  sleepHours: { min: 0, max: 24 },
  sleepPerformancePct: { min: 0, max: 100 },
  sleepEfficiencyPct: { min: 0, max: 100 },
  sleepConsistencyPct: { min: 0, max: 100 },
  sleepDebtMin: { min: 0, max: 1440 },
  sleepNeedMin: { min: 0, max: 1440 },
  remMin: { min: 0, max: 1440 },
  deepMin: { min: 0, max: 1440 },
  lightMin: { min: 0, max: 1440 },
  awakeMin: { min: 0, max: 1440 },
  skinTempC: { min: 20, max: 45 },
  skinTempRaw: { min: -50, max: 130 }
};

/** Every name the model might use for a metric -> the canonical field. */
const METRIC_ALIASES = {
  recovery: 'recoveryScore',
  recovery_score: 'recoveryScore',
  recovery_percent: 'recoveryScore',
  hrv: 'hrvMs',
  hrv_ms: 'hrvMs',
  heart_rate_variability: 'hrvMs',
  rhr: 'restingHr',
  resting_hr: 'restingHr',
  resting_heart_rate: 'restingHr',
  spo2: 'spo2',
  blood_oxygen: 'spo2',
  oxygen_saturation: 'spo2',
  respiratory_rate: 'respiratoryRate',
  breathing_rate: 'respiratoryRate',
  strain: 'strain',
  day_strain: 'strain',
  calories: 'energyKcal',
  energy_kcal: 'energyKcal',
  calories_burned: 'energyKcal',
  max_hr: 'maxHr',
  max_heart_rate: 'maxHr',
  avg_hr: 'avgHr',
  average_heart_rate: 'avgHr',
  sleep: 'sleepHours',
  sleep_hours: 'sleepHours',
  sleep_duration: 'sleepHours',
  hours_of_sleep: 'sleepHours',
  time_asleep: 'sleepHours',
  sleep_performance: 'sleepPerformancePct',
  sleep_performance_pct: 'sleepPerformancePct',
  sleep_efficiency: 'sleepEfficiencyPct',
  sleep_consistency: 'sleepConsistencyPct',
  sleep_debt: 'sleepDebtMin',
  sleep_debt_min: 'sleepDebtMin',
  sleep_need: 'sleepNeedMin',
  sleep_need_min: 'sleepNeedMin',
  rem: 'remMin',
  rem_min: 'remMin',
  rem_sleep: 'remMin',
  deep: 'deepMin',
  deep_min: 'deepMin',
  deep_sleep: 'deepMin',
  sws: 'deepMin',
  light: 'lightMin',
  light_min: 'lightMin',
  light_sleep: 'lightMin',
  awake: 'awakeMin',
  awake_min: 'awakeMin',
  time_awake: 'awakeMin',
  skin_temp: 'skinTemp',
  skin_temperature: 'skinTemp',
  temperature: 'skinTemp'
};

/** Fields where the same value on many consecutive days cannot be real data. */
const SMEAR_GUARD_FIELDS = [
  'recoveryScore',
  'hrvMs',
  'restingHr',
  'strain',
  'sleepHours',
  'sleepPerformancePct',
  'sleepEfficiencyPct',
  'spo2',
  'respiratoryRate'
];

const SYSTEM_PROMPT = `You transcribe Whoop PDF reports for a health platform. You are a TRANSCRIBER, not an analyst.

ABSOLUTE RULES — a violation makes the whole extraction worthless:
1. NEVER compute, average, estimate, convert, infer or interpolate a number. Copy what is printed.
2. NEVER turn a monthly or weekly figure into daily rows. If the report shows "March average recovery 62%", that is ONE monthly period, not 31 days.
3. Only put an entry in "daily" when the report prints a value against ONE specific calendar date.
4. Every number you return MUST come with "evidence": the exact text from the page it was read from, copied verbatim, containing that number. If you cannot quote it, omit the value.
5. A value you are unsure of goes in "uncertain" as a sentence, not into the data.
6. Use null for anything absent. Never use 0 to mean "missing".

Return ONLY valid JSON:
{
  "is_whoop_document": true,
  "document_type": "monthly_performance_assessment" | "health_monitor" | "weekly_report" | "other",
  "member_name": "name printed on the report, or null",
  "periods": [
    {
      "label": "March 2026",
      "granularity": "monthly" | "weekly" | "range",
      "start_date": "YYYY-MM-DD or null",
      "end_date": "YYYY-MM-DD or null",
      "metrics": [
        { "name": "recovery_score", "value": 62, "unit": "%", "statistic": "average", "evidence": "Avg Recovery 62%", "page": 2 }
      ]
    }
  ],
  "daily": [
    { "date": "YYYY-MM-DD", "metrics": [ { "name": "hrv", "value": 71, "unit": "ms", "statistic": "value", "evidence": "12 Mar  HRV 71 ms", "page": 3 } ] }
  ],
  "workouts": [
    { "date": "YYYY-MM-DD", "activity": "Running", "duration_min": 42, "strain": 12.4, "energy_kcal": null, "max_hr": null, "avg_hr": null, "evidence": "12 Mar Running 42 min, strain 12.4", "page": 4 }
  ],
  "journal": [ { "date": "YYYY-MM-DD", "question": "Alcohol", "answer": "No", "evidence": "12 Mar Alcohol: No" } ],
  "notes": ["anything the reader should know about this document"],
  "uncertain": ["figures you could see but could not read confidently"],
  "confidence": "high" | "medium" | "low"
}

Metric names to use where they apply: recovery_score, hrv, resting_hr, spo2, respiratory_rate, strain, calories, max_hr, avg_hr, sleep_hours, sleep_performance, sleep_efficiency, sleep_consistency, sleep_debt_min, sleep_need_min, rem_min, deep_min, light_min, awake_min, skin_temp. Anything else: use the label printed on the page.

If the document is not a Whoop report, return {"is_whoop_document": false, "document_type": "other", "periods": [], "daily": [], "workouts": [], "journal": [], "notes": ["what it appears to be"], "uncertain": [], "confidence": "high"}.`;

// ---------------------------------------------------------------------------
// Deterministic gates (NO model involvement below this line)
// ---------------------------------------------------------------------------

function cleanStr(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

/** Tolerates "72 bpm" / "7.5 h". Returns null for anything unreadable — never 0. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Numerals in a piece of text, thousands separators removed. */
function numeralsIn(text) {
  const cleaned = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  const found = cleaned.match(/-?\d+(?:\.\d+)?/g);
  return found ? found.slice() : [];
}

/** Durations printed as "7h 32m" or "7:32", expressed as both hours and minutes. */
function durationCandidates(text) {
  const t = String(text || '');
  const out = [];
  let m;
  const hm = /(\d{1,3})\s*(?:h|hr|hrs|hours)\s*(\d{1,2})\s*(?:m|min|mins|minutes)?/gi;
  while ((m = hm.exec(t))) out.push([Number(m[1]), Number(m[2])]);
  const colon = /(\d{1,3}):(\d{2})\b/g;
  while ((m = colon.exec(t))) out.push([Number(m[1]), Number(m[2])]);
  const res = [];
  out.forEach(([h, mi]) => {
    if (!Number.isFinite(h) || !Number.isFinite(mi)) return;
    res.push(h + mi / 60);
    res.push(h * 60 + mi);
  });
  return res;
}

/**
 * Does the quoted PDF line actually contain the number the model reported?
 *
 * This is the whole traceability guarantee, and it runs with no LLM: the figure
 * must appear verbatim in the evidence, or as the same figure at one decimal
 * place, or as an h/m duration that reads out to it. Anything else is
 * arithmetic the model did in its head — exactly what we refuse to accept.
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

/** Case- and whitespace-insensitive check that a quote came off this document. */
function textContainsQuote(pdfText, quote) {
  const hay = String(pdfText || '').toLowerCase().replace(/\s+/g, ' ');
  const needle = String(quote || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!hay || needle.length < 4) return false;
  if (hay.indexOf(needle) !== -1) return true;
  // The text layer often loses spacing between glyph runs, so fall back to
  // requiring every numeral of the quote to be present.
  const nums = numeralsIn(needle);
  if (!nums.length) return false;
  return nums.every((n) => hay.indexOf(n) !== -1);
}

/**
 * One metric entry -> `{ field, value, unit, statistic, evidence, page }`, or a
 * rejection with the reason. Rejections are surfaced, never swallowed.
 */
function acceptMetric(entry, ctx) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const rawName = cleanStr(raw.name, 120);
  const key = normKey(rawName);
  const evidence = cleanStr(raw.evidence, 400);
  const unit = cleanStr(raw.unit, 24);
  const where = ctx && ctx.where ? ctx.where : '';

  let field = METRIC_ALIASES[key] || null;
  if (!field) {
    return { ok: false, reason: 'unknown_metric', name: rawName || key, where };
  }

  const value = num(raw.value);
  if (value === null) {
    return { ok: false, reason: 'no_value', name: rawName, where };
  }
  if (!evidence) {
    return { ok: false, reason: 'no_evidence', name: rawName, value, where };
  }
  if (!evidenceSupports(value, evidence)) {
    return { ok: false, reason: 'value_not_in_evidence', name: rawName, value, evidence, where };
  }

  // Skin temperature carries a unit we must not guess at. Celsius goes to the
  // canonical column; anything else is stored raw with its unit so a later
  // reading is recoverable rather than silently wrong.
  if (field === 'skinTemp') {
    const u = unit.toLowerCase();
    if (u.indexOf('c') !== -1 && u.indexOf('f') === -1) {
      field = 'skinTempC';
    } else if (u.indexOf('f') !== -1) {
      const spec = METRIC_SPECS.skinTempRaw;
      if (value < spec.min || value > spec.max) {
        return { ok: false, reason: 'out_of_range', name: rawName, value, where };
      }
      return {
        ok: true,
        field: 'skinTempRaw',
        value,
        unit,
        extra: { skinTempUnit: 'F' },
        statistic: cleanStr(raw.statistic, 40) || 'value',
        evidence,
        page: num(raw.page)
      };
    } else {
      return { ok: false, reason: 'ambiguous_temperature_unit', name: rawName, value, where };
    }
  }

  const spec = METRIC_SPECS[field];
  if (spec && (value < spec.min || value > spec.max)) {
    return { ok: false, reason: 'out_of_range', name: rawName, value, where };
  }

  return {
    ok: true,
    field,
    value,
    unit,
    statistic: cleanStr(raw.statistic, 40) || 'value',
    evidence,
    page: num(raw.page)
  };
}

/**
 * Shape-check the model's JSON. Returns null when it is unusable, which is what
 * makes runJsonPass retry rather than accept junk.
 */
function coerceWhoopPdfExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root =
    parsed.extraction && typeof parsed.extraction === 'object' && !Array.isArray(parsed.extraction)
      ? parsed.extraction
      : parsed;
  if (typeof root.is_whoop_document !== 'boolean') return null;

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const strs = (v) =>
    (Array.isArray(v) ? v : []).map((x) => cleanStr(x, 500)).filter(Boolean).slice(0, 40);

  return {
    isWhoopDocument: root.is_whoop_document === true,
    documentType: cleanStr(root.document_type, 60) || 'other',
    memberName: cleanStr(root.member_name, 120) || null,
    periods: arr(root.periods).slice(0, 60),
    daily: arr(root.daily).slice(0, 500),
    workouts: arr(root.workouts).slice(0, 500),
    journal: arr(root.journal).slice(0, 500),
    notes: strs(root.notes),
    uncertain: strs(root.uncertain),
    confidence: ['high', 'medium', 'low'].indexOf(cleanStr(root.confidence, 10).toLowerCase()) !== -1
      ? cleanStr(root.confidence, 10).toLowerCase()
      : 'low'
  };
}

/**
 * A monthly average copied onto every day of that month is the single most
 * damaging thing this pipeline could do. It cannot happen by construction (we
 * never expand a period), but a model could still emit it as "daily" rows — so
 * an identical value repeated across a long run of consecutive days is stripped
 * and reported rather than trusted.
 */
function stripSmearedSeries(days, notes) {
  if (!Array.isArray(days) || days.length < SMEAR_RUN_LEN) return 0;
  let dropped = 0;
  SMEAR_GUARD_FIELDS.forEach((field) => {
    let runStart = 0;
    for (let i = 1; i <= days.length; i += 1) {
      const prev = days[i - 1][field];
      const cur = i < days.length ? days[i][field] : undefined;
      if (i < days.length && cur !== undefined && cur !== null && cur === prev) continue;
      const runLen = i - runStart;
      if (prev !== undefined && prev !== null && runLen >= SMEAR_RUN_LEN) {
        for (let j = runStart; j < i; j += 1) delete days[j][field];
        dropped += runLen;
        notes.push(
          `Dropped ${field} on ${runLen} consecutive days (${days[runStart].date} to ${days[i - 1].date}): an identical value repeated that many times is an average spread across days, not daily data.`
        );
      }
      runStart = i;
    }
  });
  return dropped;
}

// ---------------------------------------------------------------------------
// Canonical build
// ---------------------------------------------------------------------------

function firstDate(list) {
  const dates = list.filter(Boolean).sort();
  return dates.length ? dates[0] : null;
}

function lastDate(list) {
  const dates = list.filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/** The sentence the caller shows the member. Plain, and never oversells a PDF. */
function coverageMessage(coverage) {
  const c = coverage || {};
  const zip = 'Upload your Whoop ZIP export (Whoop app → Settings → Data Export) for your full day-by-day history.';
  const periodWord = (n) => (n === 1 ? 'summary' : 'summaries');
  const granWord = c.granularity === 'mixed' ? 'period' : c.granularity;

  if (!c.dailyRows && !c.periods) {
    return `We could not read any Whoop figures from that PDF. ${zip}`;
  }
  if (!c.dailyRows) {
    return `That PDF gave us ${c.periods} ${granWord} ${periodWord(c.periods)}, not daily data. ${zip}`;
  }
  if (!c.periods) {
    return `That PDF gave us ${c.dailyRows} daily ${c.dailyRows === 1 ? 'record' : 'records'}, which is everything it prints per day. ${zip}`;
  }
  return `That PDF gave us ${c.dailyRows} daily ${c.dailyRows === 1 ? 'record' : 'records'} and ${c.periods} ${granWord} ${periodWord(c.periods)}. ${zip}`;
}

/**
 * Model output -> the canonical shape whoopParser emits, so the result can flow
 * through readinessService.previewUpload / commitUpload unchanged.
 *
 * `days` only ever contains genuinely per-day rows. Period aggregates live in
 * `periods` and are never expanded into days.
 */
function buildCanonicalFromExtraction(extraction, opts) {
  const o = opts || {};
  const fileName = cleanStr(o.fileName, 200) || 'whoop_report.pdf';
  const pdfText = o.pdfText || '';
  const verifiable = !!o.textDecidable;

  const notes = (extraction.notes || []).slice();
  const uncertain = (extraction.uncertain || []).slice();
  const dropped = [];
  const unknownMetrics = [];
  let accepted = 0;
  let unverifiedQuotes = 0;

  const noteDrop = (rej) => {
    if (rej.reason === 'unknown_metric') {
      const label = cleanStr(rej.name, 120);
      if (label && unknownMetrics.indexOf(label) === -1) unknownMetrics.push(label);
    }
    if (dropped.length < 200) dropped.push(rej);
  };

  const takeMetrics = (list, where) => {
    const out = {};
    (Array.isArray(list) ? list : []).forEach((entry) => {
      const res = acceptMetric(entry, { where });
      if (!res.ok) {
        noteDrop(res);
        return;
      }
      // Second, stronger check where the PDF has a readable text layer: the
      // quote itself must come off this document. Surfaced, not enforced —
      // most Whoop PDFs compress their text and cannot be checked at all.
      const verified = verifiable ? textContainsQuote(pdfText, res.evidence) : null;
      if (verified === false) unverifiedQuotes += 1;
      out[res.field] = { ...res, verified };
      accepted += 1;
    });
    return out;
  };

  /* ---- daily rows ---- */
  const dayMap = new Map();
  (extraction.daily || []).forEach((entry, i) => {
    const date = cleanStr(entry.date, 10);
    if (!isYmd(date)) {
      noteDrop({ ok: false, reason: 'undated_daily_row', where: `daily[${i}]` });
      return;
    }
    const picked = takeMetrics(entry.metrics, `daily[${i}] ${date}`);
    const fields = Object.keys(picked);
    if (!fields.length) return;
    const day = dayMap.get(date) || { date, source: 'whoop' };
    fields.forEach((f) => {
      day[f] = picked[f].value;
      if (picked[f].extra) Object.assign(day, picked[f].extra);
    });
    dayMap.set(date, day);
  });
  const days = Array.from(dayMap.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const smeared = stripSmearedSeries(days, notes);
  const usableDays = days.filter((d) => Object.keys(d).some((k) => k !== 'date' && k !== 'source'));

  /* ---- period aggregates (NEVER expanded into days) ---- */
  const periods = [];
  (extraction.periods || []).forEach((p, i) => {
    const label = cleanStr(p.label, 120);
    const gran = ['monthly', 'weekly', 'range'].indexOf(normKey(p.granularity)) !== -1 ? normKey(p.granularity) : 'range';
    const from = isYmd(cleanStr(p.start_date, 10)) ? cleanStr(p.start_date, 10) : null;
    const to = isYmd(cleanStr(p.end_date, 10)) ? cleanStr(p.end_date, 10) : null;
    const picked = takeMetrics(p.metrics, `periods[${i}] ${label || gran}`);
    const metrics = {};
    Object.keys(picked).forEach((f) => {
      metrics[f] = {
        value: picked[f].value,
        unit: picked[f].unit || null,
        statistic: picked[f].statistic,
        evidence: picked[f].evidence,
        page: picked[f].page,
        evidenceVerified: picked[f].verified
      };
    });
    if (!Object.keys(metrics).length) return;
    periods.push({ label: label || gran, granularity: gran, from, to, metrics });
  });

  /* ---- workouts ---- */
  const workouts = [];
  (extraction.workouts || []).forEach((w, i) => {
    const date = cleanStr(w.date, 10);
    if (!isYmd(date)) {
      noteDrop({ ok: false, reason: 'undated_workout', where: `workouts[${i}]` });
      return;
    }
    const evidence = cleanStr(w.evidence, 400);
    // Same rule as metrics: a workout figure with no quote, or a quote that
    // does not contain it, is left null rather than carried through.
    const traced = (v) => {
      const n = num(v);
      if (n === null) return null;
      if (!evidence || !evidenceSupports(n, evidence)) {
        noteDrop({ ok: false, reason: 'value_not_in_evidence', name: 'workout', value: n, where: `workouts[${i}]` });
        return null;
      }
      accepted += 1;
      return n;
    };
    workouts.push({
      date,
      startedAt: date,
      endedAt: null,
      durationMin: traced(w.duration_min),
      activity: cleanStr(w.activity, 120) || null,
      strain: traced(w.strain),
      energyKcal: traced(w.energy_kcal),
      maxHr: traced(w.max_hr),
      avgHr: traced(w.avg_hr),
      zones: { z1: null, z2: null, z3: null, z4: null, z5: null }
    });
  });
  workouts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /* ---- journal ---- */
  const journal = [];
  (extraction.journal || []).forEach((j, i) => {
    const date = cleanStr(j.date, 10);
    const question = cleanStr(j.question, 300);
    if (!isYmd(date) || !question) {
      noteDrop({ ok: false, reason: 'incomplete_journal_row', where: `journal[${i}]` });
      return;
    }
    journal.push({
      date,
      question,
      answer: cleanStr(j.answer, 500),
      notes: cleanStr(j.notes, 2000)
    });
    accepted += 1;
  });
  journal.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /* ---- coverage: what this PDF honestly gave us ---- */
  const grans = {};
  periods.forEach((p) => { grans[p.granularity] = true; });
  const granKeys = Object.keys(grans);
  const granularity = usableDays.length
    ? (periods.length ? 'mixed' : 'daily')
    : (granKeys.length === 1 ? granKeys[0] : (granKeys.length ? 'mixed' : 'none'));

  const allDates = []
    .concat(usableDays.map((d) => d.date))
    .concat(workouts.map((w) => w.date))
    .concat(journal.map((j) => j.date))
    .concat(periods.map((p) => p.from))
    .concat(periods.map((p) => p.to));
  const dateRange = { from: firstDate(allDates), to: lastDate(allDates) };

  const coverage = {
    granularity,
    dailyRows: usableDays.length,
    periods: periods.length,
    workouts: workouts.length,
    journal: journal.length,
    dateRange,
    aggregatesOnly: periods.length > 0 && usableDays.length === 0,
    evidenceVerifiable: verifiable,
    unverifiedQuotes
  };
  const message = coverageMessage(coverage);

  if (coverage.aggregatesOnly) {
    notes.push('This PDF carries period summaries only. No per-day rows were created, because a monthly average is not a day.');
  }
  if (verifiable && unverifiedQuotes) {
    notes.push(`${unverifiedQuotes} quoted figure(s) could not be found in this PDF's text layer and are flagged rather than trusted.`);
  }
  if (smeared) {
    notes.push(`${smeared} daily value(s) were dropped as repeated averages.`);
  }

  // Confidence is ours, not the model's: it can only be lowered from what the
  // model claimed, never raised.
  const rank = { low: 0, medium: 1, high: 2 };
  let computed = 'high';
  if (dropped.length || unverifiedQuotes || smeared) computed = 'medium';
  if (!accepted || dropped.length > accepted) computed = 'low';
  const confidence = rank[computed] <= rank[extraction.confidence] ? computed : extraction.confidence;

  const summary = {
    filesSeen: [{ name: fileName, kind: 'pdf', rowsParsed: accepted, rowsRejected: dropped.length }],
    rowsParsed: accepted,
    rowsRejected: dropped.length,
    dateRange,
    // Metric labels we did not recognise ride the same channel the CSV parser
    // uses, so preview surfaces them as the early warning they are.
    unknownColumns: unknownMetrics.map((column) => ({ file: fileName, kind: 'pdf', column })),
    duplicates: [],
    notes,
    timezone: null,
    source: 'pdf',
    documentType: extraction.documentType,
    memberName: extraction.memberName,
    granularity,
    coverage,
    message
  };

  return {
    days: usableDays,
    workouts,
    journal,
    summary,
    periods,
    coverage,
    message,
    confidence,
    uncertain,
    dropped
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function fail(code, error, extra) {
  return Object.assign({ ok: false, code, error, message: error }, extra || {});
}

/**
 * Read a Whoop PDF into the canonical parser shape.
 *
 * Success returns `{ ok:true, days, workouts, journal, summary, ... }` — the
 * same `{days, workouts, journal, summary}` contract parseWhoopExport emits, so
 * the caller can hand it straight to previewUpload / commitUpload — plus the
 * honesty fields (`coverage`, `periods`, `message`, `confidence`, `dropped`).
 *
 * Failure returns `{ ok:false, code, error, message }` and never throws. Codes:
 *   PDF_AI_UNAVAILABLE  — no ANTHROPIC_API_KEY; PDF reading needs the model
 *   NOT_A_PDF           — the bytes are not a PDF
 *   PDF_EMPTY           — zero-length upload
 *   PDF_TOO_LARGE       — over MAX_PDF_BYTES
 *   PDF_TOO_MANY_PAGES  — over MAX_PDF_PAGES
 *   NOT_A_WHOOP_PDF     — a readable document that is not a Whoop report
 *   PDF_UNREADABLE      — the model returned nothing usable
 *   PDF_NO_DATA         — a Whoop PDF we could not pull a single traceable figure from
 *
 * @param {{buffer: Buffer, apiKey?: string, fileName?: string}} args
 */
async function extractWhoopPdf({ buffer, apiKey, fileName } = {}) {
  const buf = toBuf(buffer);
  const name = cleanStr(fileName, 200) || 'whoop_report.pdf';

  if (!buf || !buf.length) {
    return fail('PDF_EMPTY', 'That file is empty.');
  }
  if (classifyUploadBuffer(buf) !== 'pdf') {
    return fail('NOT_A_PDF', 'That file is not a PDF.');
  }
  if (buf.length > MAX_PDF_BYTES) {
    return fail(
      'PDF_TOO_LARGE',
      `That PDF is larger than ${Math.round(MAX_PDF_BYTES / (1024 * 1024))}MB. Please upload the report on its own, or send the Whoop ZIP export instead.`
    );
  }

  const pages = pdfPageCount(buf);
  if (pages !== null && pages > MAX_PDF_PAGES) {
    return fail(
      'PDF_TOO_MANY_PAGES',
      `That PDF has ${pages} pages, more than the ${MAX_PDF_PAGES} we can read. Please upload the Whoop report on its own.`,
      { pages }
    );
  }

  const key = String(apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) {
    // Graceful degradation: without the model we genuinely cannot read a PDF,
    // and saying so beats pretending the member's file was malformed.
    return fail(
      'PDF_AI_UNAVAILABLE',
      'Reading PDF reports is not configured on this server. Please upload your Whoop ZIP export instead (Whoop app → Settings → Data Export).'
    );
  }

  // Free prefilter. Only rejects when the text layer is readable AND contains
  // no Whoop wording at all — otherwise the model gets to decide.
  const sniff = sniffWhoopMarkers(buf);
  if (sniff.decidable && !sniff.matched.length) {
    return fail(
      'NOT_A_WHOOP_PDF',
      'That PDF does not look like a Whoop report. Upload your Whoop Monthly Performance Assessment, or the ZIP export for full history.',
      { pages }
    );
  }

  const model = (
    process.env.ANTHROPIC_MODEL_WHOOP_PDF ||
    process.env.ANTHROPIC_MODEL_BLOOD ||
    process.env.ANTHROPIC_MODEL ||
    'claude-haiku-4-5'
  ).trim();
  const maxTokens = Math.max(
    2000,
    parseInt(process.env.ANTHROPIC_WHOOP_PDF_MAX_TOKENS || '12000', 10) || 12000
  );

  let pass;
  try {
    pass = await runJsonPass({
      apiKey: key,
      model,
      maxTokens,
      maxRetryTokens: 32000,
      system: SYSTEM_PROMPT,
      userContent: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }
        },
        {
          type: 'text',
          text: 'Transcribe every Whoop figure printed in this report, page by page. Quote the exact line each number came from. Do not turn a monthly or weekly figure into daily rows.'
        }
      ],
      coerce: coerceWhoopPdfExtraction
    });
  } catch (err) {
    console.warn('[whoop pdf] extraction failed:', err && err.message);
    return fail('PDF_UNREADABLE', 'We could not read that PDF right now. Please try again, or upload your Whoop ZIP export.', {
      model,
      detail: String((err && err.message) || err || '').slice(0, 500)
    });
  }

  if (!pass.result) {
    return fail('PDF_UNREADABLE', 'We could not read that PDF. Please upload your Whoop ZIP export instead.', {
      model,
      usage: pass.usage,
      stopReason: pass.stopReason
    });
  }

  const extraction = pass.result;
  if (!extraction.isWhoopDocument) {
    return fail(
      'NOT_A_WHOOP_PDF',
      'That PDF does not look like a Whoop report. Upload your Whoop Monthly Performance Assessment, or the ZIP export for full history.',
      { model, usage: pass.usage, documentType: extraction.documentType, notes: extraction.notes }
    );
  }

  const canonical = buildCanonicalFromExtraction(extraction, {
    fileName: name,
    pdfText: sniff.text,
    textDecidable: sniff.decidable
  });

  if (!canonical.days.length && !canonical.periods.length && !canonical.workouts.length && !canonical.journal.length) {
    return fail('PDF_NO_DATA', canonical.message, {
      model,
      usage: pass.usage,
      coverage: canonical.coverage,
      dropped: canonical.dropped,
      uncertain: canonical.uncertain,
      notes: canonical.summary.notes
    });
  }

  return {
    ok: true,
    kind: 'whoop_pdf',
    documentType: extraction.documentType,
    memberName: extraction.memberName,
    pages,
    // Canonical parser shape — flows through previewUpload / commitUpload as-is.
    days: canonical.days,
    workouts: canonical.workouts,
    journal: canonical.journal,
    summary: canonical.summary,
    // Honesty surface.
    periods: canonical.periods,
    coverage: canonical.coverage,
    message: canonical.message,
    confidence: canonical.confidence,
    uncertain: canonical.uncertain,
    dropped: canonical.dropped,
    usage: pass.usage,
    model
  };
}

module.exports = {
  extractWhoopPdf,
  classifyUploadBuffer,
  // exported for tests / reuse
  pdfPageCount,
  extractPdfTextLayer,
  sniffWhoopMarkers,
  coerceWhoopPdfExtraction,
  buildCanonicalFromExtraction,
  acceptMetric,
  evidenceSupports,
  coverageMessage,
  stripSmearedSeries,
  METRIC_SPECS,
  METRIC_ALIASES,
  SYSTEM_PROMPT,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  SMEAR_RUN_LEN
};
