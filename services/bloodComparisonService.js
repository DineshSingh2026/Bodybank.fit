'use strict';

/**
 * BodyBank — Blood Report Comparison engine.
 *
 * Two layers:
 *  1) A DETERMINISTIC marker-alignment engine (no AI): aligns the same marker
 *     across a client's reports over time, reconciles synonyms/units/ranges, and
 *     computes a trajectory (improving toward range / worsening / stable) per
 *     marker. Reliable, free, instant — this is the numeric truth.
 *  2) A CLAUDE longitudinal verdict pass that reasons over that matrix + nutrition
 *     to write the final consolidated "what changed and what to do now" report.
 *
 * The AI never invents numbers — it only interprets the aligned matrix.
 */

const {
  parseAnthropicJson,
  formatAnthropicApiError
} = require('./nutritionService');

// --------------------------------------------------------------------------
// Numeric + range parsing
// --------------------------------------------------------------------------

/**
 * Pull a comparable number out of a printed lab value.
 * Handles "13.5", "13.5 g/dL", "<0.1", "> 40", "5,000", "1.2 mg/dL".
 * @returns {{ num:number|null, qualifier:''|'<'|'>' }}
 */
function parseNumericValue(value) {
  if (value == null) return { num: null, qualifier: '' };
  let s = String(value).trim();
  if (!s) return { num: null, qualifier: '' };
  let qualifier = '';
  const q = s.match(/^\s*(<=?|>=?|≤|≥)/);
  if (q) {
    qualifier = q[1].indexOf('<') >= 0 || q[1].indexOf('≤') >= 0 ? '<' : '>';
  }
  // remove thousands separators, then grab the first number
  const cleaned = s.replace(/(\d),(\d{3})/g, '$1$2');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return { num: null, qualifier };
  const num = parseFloat(m[0]);
  return { num: Number.isFinite(num) ? num : null, qualifier };
}

/**
 * Parse a reference range into { low, high } (either may be null = open-ended).
 * Handles "13.5-17.5", "13.5 – 17.5", "13.5 to 17.5", "< 200", "> 40",
 * "Up to 5.0", "Desirable < 200".
 */
function parseReferenceRange(ref) {
  if (ref == null) return null;
  const s = String(ref).replace(/,/g, '').trim();
  if (!s) return null;

  // two-number range
  const range = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to|\bto\b)\s*(-?\d+(?:\.\d+)?)/i);
  if (range) {
    const low = parseFloat(range[1]);
    const high = parseFloat(range[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      return { low: Math.min(low, high), high: Math.max(low, high) };
    }
  }
  // upper bound only
  const upper = s.match(/(?:<=?|≤|up to|below|max(?:imum)?|desirable[^0-9]*<?)\s*(-?\d+(?:\.\d+)?)/i);
  if (upper) {
    const high = parseFloat(upper[1]);
    if (Number.isFinite(high)) return { low: null, high };
  }
  // lower bound only
  const lower = s.match(/(?:>=?|≥|above|min(?:imum)?|at least)\s*(-?\d+(?:\.\d+)?)/i);
  if (lower) {
    const low = parseFloat(lower[1]);
    if (Number.isFinite(low)) return { low, high: null };
  }
  return null;
}

/** How far a value sits outside its range (0 = inside range). */
function deviationFromRange(num, range) {
  if (num == null || !range) return null;
  const { low, high } = range;
  if (low != null && num < low) return low - num;
  if (high != null && num > high) return num - high;
  return 0;
}

// --------------------------------------------------------------------------
// Marker canonicalization (merge synonyms so the same test lines up)
// --------------------------------------------------------------------------

// normalized-synonym -> canonical display name
const MARKER_ALIASES = {
  'hba1c': 'HbA1c',
  'a1c': 'HbA1c',
  'glycated haemoglobin': 'HbA1c',
  'glycated hemoglobin': 'HbA1c',
  'hba1c glycated hemoglobin': 'HbA1c',
  'hemoglobin': 'Hemoglobin',
  'haemoglobin': 'Hemoglobin',
  'hb': 'Hemoglobin',
  'vitamin d': 'Vitamin D (25-OH)',
  'vitamin d3': 'Vitamin D (25-OH)',
  'vitamin d 25 oh': 'Vitamin D (25-OH)',
  '25 oh vitamin d': 'Vitamin D (25-OH)',
  '25 hydroxyvitamin d': 'Vitamin D (25-OH)',
  '25 hydroxy vitamin d': 'Vitamin D (25-OH)',
  'vitamin b12': 'Vitamin B12',
  'b12': 'Vitamin B12',
  'cobalamin': 'Vitamin B12',
  'tsh': 'TSH',
  'thyroid stimulating hormone': 'TSH',
  'ldl': 'LDL Cholesterol',
  'ldl cholesterol': 'LDL Cholesterol',
  'hdl': 'HDL Cholesterol',
  'hdl cholesterol': 'HDL Cholesterol',
  'total cholesterol': 'Total Cholesterol',
  'cholesterol total': 'Total Cholesterol',
  'cholesterol': 'Total Cholesterol',
  'triglycerides': 'Triglycerides',
  'tg': 'Triglycerides',
  'vldl': 'VLDL Cholesterol',
  'vldl cholesterol': 'VLDL Cholesterol',
  'fasting blood sugar': 'Fasting Glucose',
  'fasting glucose': 'Fasting Glucose',
  'glucose fasting': 'Fasting Glucose',
  'fbs': 'Fasting Glucose',
  'ferritin': 'Ferritin',
  'serum ferritin': 'Ferritin',
  'sgpt': 'ALT (SGPT)',
  'alt': 'ALT (SGPT)',
  'alanine aminotransferase': 'ALT (SGPT)',
  'sgot': 'AST (SGOT)',
  'ast': 'AST (SGOT)',
  'aspartate aminotransferase': 'AST (SGOT)',
  'creatinine': 'Creatinine',
  'serum creatinine': 'Creatinine',
  'uric acid': 'Uric Acid',
  'serum uric acid': 'Uric Acid',
  'wbc': 'WBC',
  'total leucocyte count': 'WBC',
  'total leukocyte count': 'WBC',
  'tlc': 'WBC',
  'white blood cell count': 'WBC',
  'rbc': 'RBC',
  'red blood cell count': 'RBC',
  'platelet count': 'Platelets',
  'platelets': 'Platelets',
  'iron': 'Serum Iron',
  'serum iron': 'Serum Iron',
  'tibc': 'TIBC',
  'total iron binding capacity': 'TIBC',
  'crp': 'CRP',
  'c reactive protein': 'CRP',
  'hs crp': 'hs-CRP',
  'hscrp': 'hs-CRP',
  'esr': 'ESR',
  'testosterone': 'Testosterone (Total)',
  'total testosterone': 'Testosterone (Total)',
  'testosterone total': 'Testosterone (Total)'
};

/** Normalize a marker name into a comparison key. */
function normalizeMarkerName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // drop parenthetical notes
    .replace(/[^a-z0-9]+/g, ' ')  // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

/** @returns {{ key:string, display:string }} */
function canonicalizeMarker(name) {
  const norm = normalizeMarkerName(name);
  if (MARKER_ALIASES[norm]) {
    const display = MARKER_ALIASES[norm];
    return { key: normalizeMarkerName(display), display };
  }
  // fall back to a title-cased version of the printed name
  return { key: norm || 'unknown', display: String(name || 'Unknown').trim() };
}

// --------------------------------------------------------------------------
// Alignment engine
// --------------------------------------------------------------------------

function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return null; }
  }
  return null;
}

/**
 * Build the aligned comparison matrix from an ordered list of report rows.
 * @param {Array} reportRows DB rows (need id, created_at, extracted_blood_data, ai_report, status)
 * @returns {object} comparison structure (see file header)
 */
function alignReports(reportRows) {
  // oldest -> newest so trend reads left to right
  const reports = (reportRows || [])
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((r, idx) => {
      const ai = parseMaybeJson(r.ai_report) || {};
      return {
        id: r.id,
        date: r.created_at,
        index: idx,
        overallStatus: ai.overall_status || null
      };
    });

  const reportIndex = {};
  reports.forEach((r) => { reportIndex[r.id] = r.index; });

  // canonicalKey -> { display, unit, referenceRange, range, panel, cells[] }
  const markerMap = new Map();
  // preserve panel order of first appearance
  const panelOrder = [];
  const panelSeen = new Set();

  (reportRows || []).forEach((row) => {
    const rid = row.id;
    const ci = reportIndex[rid];
    const extracted = parseMaybeJson(row.extracted_blood_data);
    const panels = (extracted && Array.isArray(extracted.panels)) ? extracted.panels : [];
    panels.forEach((panel) => {
      const panelName = String((panel && panel.name) || 'Other').trim() || 'Other';
      const markers = (panel && Array.isArray(panel.markers)) ? panel.markers : [];
      markers.forEach((m) => {
        if (!m || !m.name) return;
        const { key, display } = canonicalizeMarker(m.name);
        const mapKey = key;
        let entry = markerMap.get(mapKey);
        if (!entry) {
          const refRaw = m.reference_range != null ? m.reference_range : (m.reference != null ? m.reference : '');
          entry = {
            key: mapKey,
            display,
            panel: panelName,
            unit: String(m.unit || '').trim(),
            referenceRange: String(refRaw || '').trim(),
            range: parseReferenceRange(refRaw),
            cells: reports.map((r) => ({ reportId: r.id, present: false }))
          };
          markerMap.set(mapKey, entry);
          if (!panelSeen.has(panelName)) { panelSeen.add(panelName); panelOrder.push(panelName); }
        }
        // fill missing metadata from any report that has it
        if (!entry.unit && m.unit) entry.unit = String(m.unit).trim();
        if (!entry.range) {
          const refRaw = m.reference_range != null ? m.reference_range : (m.reference != null ? m.reference : '');
          if (refRaw) { entry.referenceRange = String(refRaw).trim(); entry.range = parseReferenceRange(refRaw); }
        }
        const parsed = parseNumericValue(m.value);
        entry.cells[ci] = {
          reportId: rid,
          present: true,
          value: String(m.value != null ? m.value : '').trim(),
          numeric: parsed.num,
          qualifier: parsed.qualifier,
          unit: String(m.unit || '').trim(),
          status: String(m.status || 'Normal').trim(),
          flag: String(m.flag || '').trim()
        };
      });
    });
  });

  // compute per-marker trajectory
  const markers = [];
  markerMap.forEach((entry) => {
    const present = entry.cells.filter(reportDisPresentSafe);
    const numericCells = entry.cells.filter((c) => c && c.present && c.numeric != null);
    let first = null;
    let last = null;
    if (numericCells.length >= 2) {
      first = numericCells[0];
      last = numericCells[numericCells.length - 1];
    }
    let delta = null;
    let deltaPct = null;
    let direction = 'na';       // improving | worsening | stable | changed | na
    let changed = false;
    if (first && last) {
      delta = Number((last.numeric - first.numeric).toFixed(4));
      if (first.numeric !== 0) deltaPct = Number(((delta / Math.abs(first.numeric)) * 100).toFixed(1));
      changed = Math.abs(delta) > 1e-9;
      const firstDev = deviationFromRange(first.numeric, entry.range);
      const lastDev = deviationFromRange(last.numeric, entry.range);
      if (firstDev != null && lastDev != null) {
        if (lastDev < firstDev - 1e-9) direction = 'improving';
        else if (lastDev > firstDev + 1e-9) direction = 'worsening';
        else direction = 'stable';
      } else {
        // no known range — we can't say good/bad, only that it moved
        direction = changed ? 'changed' : 'stable';
      }
    }
    const anyAbnormal = entry.cells.some((c) => c && c.present && c.status && !/^(normal|optimal)$/i.test(c.status));
    markers.push({
      ...entry,
      presentCount: present.length,
      first: first ? { value: first.value, numeric: first.numeric, status: first.status } : null,
      last: last ? { value: last.value, numeric: last.numeric, status: last.status } : null,
      delta,
      deltaPct,
      direction,
      changed,
      anyAbnormal
    });
  });

  // group markers back into panels, keeping first-seen order
  const panels = panelOrder.map((pn) => ({
    name: pn,
    markers: markers.filter((m) => m.panel === pn)
  })).filter((p) => p.markers.length);

  const improvedCount = markers.filter((m) => m.direction === 'improving').length;
  const worsenedCount = markers.filter((m) => m.direction === 'worsening').length;
  const changedCount = markers.filter((m) => m.changed).length;

  return {
    reports,
    panels,
    markerCount: markers.length,
    changedCount,
    improvedCount,
    worsenedCount
  };
}

function reportDisPresentSafe(c) { return !!(c && c.present); }
// (kept name distinct to avoid shadowing the exported helper)

// --------------------------------------------------------------------------
// Compact projection for the AI prompt (numbers only, no bloat)
// --------------------------------------------------------------------------

function comparisonForPrompt(comparison) {
  const dateLabels = comparison.reports.map((r) => {
    const d = new Date(r.date);
    return Number.isNaN(d.getTime()) ? String(r.date) : d.toISOString().slice(0, 10);
  });
  const panels = comparison.panels.map((p) => ({
    panel: p.name,
    markers: p.markers.map((m) => ({
      marker: m.display,
      unit: m.unit || '',
      reference: m.referenceRange || '',
      values: m.cells.map((c, i) => ({
        date: dateLabels[i],
        value: c && c.present ? (c.value + (c.unit ? ' ' + c.unit : '')) : null,
        status: c && c.present ? c.status : null
      })),
      delta: m.delta,
      delta_pct: m.deltaPct,
      trajectory: m.direction
    }))
  }));
  return { report_dates: dateLabels, panels };
}

// --------------------------------------------------------------------------
// Claude longitudinal verdict
// --------------------------------------------------------------------------

function anthropicTextFromMessage(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  return blocks.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('');
}

function parseAnyJsonBlock(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  try { return JSON.parse(t); } catch (_) {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(t))) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    try { return JSON.parse(body); } catch (_) {}
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function modelPricing(model) {
  const m = String(model || '').toLowerCase();
  let inPerM;
  let outPerM;
  if (m.includes('haiku')) { inPerM = 1; outPerM = 5; }
  else if (m.includes('sonnet')) { inPerM = 3; outPerM = 15; }
  else if (m.includes('opus')) { inPerM = 5; outPerM = 25; }
  else if (m.includes('fable') || m.includes('mythos')) { inPerM = 10; outPerM = 50; }
  else { inPerM = 1; outPerM = 5; }
  if (process.env.ANTHROPIC_INPUT_PER_MILLION_USD) inPerM = toNumber(process.env.ANTHROPIC_INPUT_PER_MILLION_USD, inPerM);
  if (process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD) outPerM = toNumber(process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD, outPerM);
  return [inPerM, outPerM];
}

function buildUsage(model, inputTokens, outputTokens) {
  const usdToInr = toNumber(process.env.AI_COST_USD_TO_INR, 83);
  const [inPerM, outPerM] = modelPricing(model);
  const inUsd = (toNumber(inputTokens) / 1e6) * inPerM + (toNumber(outputTokens) / 1e6) * outPerM;
  return {
    provider: 'anthropic',
    model: String(model || ''),
    input_tokens: toNumber(inputTokens),
    output_tokens: toNumber(outputTokens),
    total_tokens: toNumber(inputTokens) + toNumber(outputTokens),
    estimated_cost_usd: Number(inUsd.toFixed(6)),
    estimated_cost_inr: Number((inUsd * usdToInr).toFixed(4))
  };
}

async function callAnthropic({ apiKey, model, maxTokens, system, userText }) {
  const timeoutMs = Math.max(30000, parseInt(process.env.ANTHROPIC_BLOOD_REQUEST_TIMEOUT_MS || '300000', 10) || 300000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Anthropic request timed out after ${timeoutMs}ms`)), timeoutMs);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }]
    })
  }).finally(() => clearTimeout(timer));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatAnthropicApiError(res.status, data));
  return data;
}

const COMPARISON_SYSTEM = `You are the Reviewing Medical Officer — a Senior Consultant Physician and Sports Nutritionist with 20 years' experience in metabolic health and micronutrient medicine. You are performing a LONGITUDINAL review: the SAME patient has been tested 2 or more times over a period, and you have their aligned blood markers across those dates plus their recent nutrition data.

Your job is NOT to re-analyze a single snapshot — it is to evaluate the TRAJECTORY: what improved, what worsened, what stayed abnormal, whether earlier interventions worked, and exactly what to change now.

RULES:
1. Reason ONLY from the provided aligned values. NEVER invent a marker, value or date that is not in the data. The "trajectory" field per marker is pre-computed (improving = moving toward the reference range, worsening = moving away, stable = little change, changed = moved but range unknown) — trust it and explain WHY.
2. Prioritise clinically significant movements. A 0.1 wobble inside range is noise; a ferritin going 18 -> 61 or an HbA1c 6.4 -> 5.7 is the story.
3. Explicitly judge whether prior action worked: e.g. "the iron protocol clearly worked — ferritin tripled into range, so step down to a maintenance dose now."
4. Look for PATTERNS across markers moving together (e.g. Hb + MCV + ferritin all rising = resolving iron-deficiency anaemia).
5. Cross-reference the trajectory with the nutrition data to explain causes and prescribe fixes. Food recommendations MUST include Indian cuisine options where relevant. Supplement guidance must say START / CONTINUE / STOP / ADJUST with a therapeutic dose and the specific value that justifies it.
6. Be honest but reassuring and plainly worded — the patient will read this.
7. Scale the depth to the data: for a broad multi-panel comparison the trajectory_narrative should be several paragraphs.

Return ONLY valid JSON, no markdown:
{
  "overall_trajectory": "Improving|Stable|Mixed|Worsening",
  "trajectory_score_delta": "e.g. Fair -> Good, or a one-line movement summary",
  "executive_summary": "2-4 sentence plain-language summary of how the patient has changed across the tests",
  "trajectory_narrative": "Thorough multi-paragraph clinical narrative of the change over time: what moved, why, whether interventions worked, patterns across markers, nutrition's role, and the current picture",
  "improvements": [ { "marker": "name", "from": "old value", "to": "new value", "meaning": "what this improvement means clinically" } ],
  "concerns": [ { "marker": "name", "from": "old value", "to": "new value", "level": "High|Medium|Low", "meaning": "why this is concerning and the likely cause" } ],
  "unchanged_watch": [ { "marker": "name", "value": "current", "note": "still abnormal / still to watch and why" } ],
  "interventions_assessment": "Did earlier diet/supplement/lifestyle action work? Be specific about which markers responded.",
  "updated_recommendations": [ { "area": "Diet|Supplement|Lifestyle|Medical", "action": "specific action", "reason": "tied to a specific marker movement" } ],
  "updated_supplements": [ { "name": "name", "action": "Start|Continue|Stop|Adjust", "dose": "therapeutic dose", "reason": "the marker value that justifies it" } ],
  "next_retest": [ { "test": "test name", "when": "timeframe", "reason": "why, based on the trajectory" } ],
  "final_verdict": "1-3 sentence bottom line the patient should remember"
}`;

/**
 * Run the Claude longitudinal verdict over an aligned comparison.
 * @returns {{ verdict:object|null, usage:object, stopReason:string }}
 */
async function generateComparisonVerdict({ apiKey, model, patient, comparison, symptomsText, nutritionNote }) {
  const chosenModel = (model || process.env.ANTHROPIC_MODEL_BLOOD_COMPARISON || 'claude-opus-4-8').trim();
  const maxTokens = Math.max(4000, parseInt(process.env.ANTHROPIC_BLOOD_COMPARISON_MAX_TOKENS || '14000', 10) || 14000);
  const compact = comparisonForPrompt(comparison);

  const userText = `PATIENT PROFILE:
Name: ${patient.name || 'Member'}
Age: ${patient.age || 'Not provided'}
Gender: ${patient.gender || 'Not provided'}
Fitness Goal: ${patient.goal || 'General health'}
Reported Symptoms: ${symptomsText || 'None reported'}

NUMBER OF REPORTS COMPARED: ${comparison.reports.length}
REPORT DATES (oldest -> newest): ${compact.report_dates.join('  ->  ')}

ALIGNED BLOOD MARKER TRAJECTORY (same marker across every test date):
${JSON.stringify(compact.panels, null, 1)}

RECENT NUTRITION CONTEXT:
${nutritionNote || 'No nutrition summary available.'}

Deterministic summary: ${comparison.markerCount} markers aligned, ${comparison.improvedCount} improving, ${comparison.worsenedCount} worsening, ${comparison.changedCount} changed overall.

Produce the complete longitudinal comparison as JSON.`;

  let inputTokens = 0;
  let outputTokens = 0;
  const budgets = [maxTokens, Math.min(28000, maxTokens + 8000)];
  let stopReason = 'unknown';
  for (let i = 0; i < budgets.length; i += 1) {
    const data = await callAnthropic({ apiKey, model: chosenModel, maxTokens: budgets[i], system: COMPARISON_SYSTEM, userText });
    inputTokens += toNumber(data && data.usage && data.usage.input_tokens);
    outputTokens += toNumber(data && data.usage && data.usage.output_tokens);
    stopReason = (data && data.stop_reason) || 'unknown';
    const text = anthropicTextFromMessage(data);
    const parsed = parseAnyJsonBlock(text) || parseAnthropicJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { verdict: parsed, usage: buildUsage(chosenModel, inputTokens, outputTokens), stopReason };
    }
    if (stopReason !== 'max_tokens') break;
  }
  return { verdict: null, usage: buildUsage(chosenModel, inputTokens, outputTokens), stopReason };
}

module.exports = {
  // parsing helpers (exported for tests)
  parseNumericValue,
  parseReferenceRange,
  deviationFromRange,
  canonicalizeMarker,
  normalizeMarkerName,
  // engine
  alignReports,
  comparisonForPrompt,
  // ai
  generateComparisonVerdict,
  buildUsage
};
