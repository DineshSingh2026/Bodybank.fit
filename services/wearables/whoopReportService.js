'use strict';

/**
 * BodyBank — Whoop / readiness narrative report.
 *
 * THE RULE: Claude never computes, estimates, or infers a number. All arithmetic
 * happened in services/wearables/whoopStatsService.js, deterministically and
 * unit-tested. This module hands the model a FINISHED fact object and asks for
 * interpretive prose only, then mechanically proves the prose invented nothing:
 *
 *   1. narrative pass   (Opus-tier)  → strict JSON report
 *   2. numeric validation (no LLM)   → every numeral in the prose must exist in
 *                                      flattenFactsToNumbers(stats) or the small
 *                                      allowlist; orphans → reject + retry (max 2)
 *   3. semantic pass    (Haiku)      → {contradictions, unsupportedClaims}
 *
 * The HTTP harness (fetch → /v1/messages, x-api-key + anthropic-version,
 * AbortController timeout, escalating-max_tokens retry, defensive JSON parsing,
 * usage/cost estimation) mirrors services/bloodAnalysisService.js exactly.
 */

const { parseAnthropicJson, formatAnthropicApiError } = require('../nutritionService');
const { flattenFactsToNumbers } = require('./whoopStatsService');

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** Numerals the model may legitimately use without them being a cited fact. */
const ALLOWLIST_MAX_ORDINAL = 10; // "1." … "10." ranking, "3 nights", small counts
const ALLOWLIST_YEAR_MIN = 1900;
const ALLOWLIST_YEAR_MAX = 2100;
const ALLOWLIST_EXTRA = new Set(['0', '100']); // percent anchors

const MAX_VALIDATION_RETRIES = 2;

// ---------------------------------------------------------------------------
// Anthropic harness (mirrors services/bloodAnalysisService.js)
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
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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
 * JSON-producing pass with escalating max_tokens (same contract as the blood
 * analysis harness): parses defensively, retries once at a much larger budget
 * when the first attempt is truncated, and sums usage across attempts.
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

function sumUsage(model, parts) {
  let input = 0;
  let output = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    input += toNumber(parts[i].input_tokens, 0);
    output += toNumber(parts[i].output_tokens, 0);
  }
  return buildUsage(model, input, output);
}

// ---------------------------------------------------------------------------
// Facts sent to the model (aggregates only — never the raw daily rows)
// ---------------------------------------------------------------------------

function dropNulls(obj) {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(dropNulls).filter((v) => v !== null);
  if (typeof obj !== 'object') return obj;
  const out = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i += 1) {
    const v = dropNulls(obj[keys[i]]);
    if (v !== null && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
      out[keys[i]] = v;
    }
  }
  return out;
}

/**
 * The trimmed fact JSON actually sent to the model. Aggregates only: cheaper, and
 * with no daily rows there is nothing for the model to do arithmetic ON.
 * Exported so it is testable and so a caller can log exactly what was sent.
 */
function buildFactsForPrompt(stats) {
  if (!stats || typeof stats !== 'object') return {};
  const weekly = Array.isArray(stats.weekly) ? stats.weekly.slice(-12) : [];
  return dropNulls({
    coverage: stats.coverage,
    metrics: stats.metrics,
    trends: stats.trends,
    weekly,
    sleepDebt: stats.sleepDebt,
    strainRecoveryBalance: stats.strainRecoveryBalance,
    correlations: stats.correlations,
    notableDays: stats.notableDays,
    flags: stats.flags,
    thresholds: stats.thresholds
  });
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function coerceReport(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed.report && typeof parsed.report === 'object' && !Array.isArray(parsed.report)
    ? parsed.report
    : parsed;
  if (!root.headline && !root.summary && !Array.isArray(root.sections)) return null;

  const sections = Array.isArray(root.sections)
    ? root.sections
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({ title: str(s.title), body: str(s.body) }))
    : [];
  const actions = Array.isArray(root.actions)
    ? root.actions
        .filter((a) => a && typeof a === 'object')
        .map((a, i) => ({
          rank: Number.isFinite(Number(a.rank)) ? Number(a.rank) : i + 1,
          action: str(a.action),
          rationale: str(a.rationale)
        }))
    : [];

  return {
    headline: str(root.headline),
    summary: str(root.summary),
    sections,
    sleepAnalysis: str(root.sleepAnalysis),
    recoveryAnalysis: str(root.recoveryAnalysis),
    trainingLoadAnalysis: str(root.trainingLoadAnalysis),
    correlationInsights: str(root.correlationInsights),
    actions,
    coachNotes: str(root.coachNotes)
  };
}

/** Every piece of generated prose, as {field, text} — the validator's input. */
function reportProseParts(report) {
  if (!report || typeof report !== 'object') return [];
  const parts = [
    { field: 'headline', text: str(report.headline) },
    { field: 'summary', text: str(report.summary) },
    { field: 'sleepAnalysis', text: str(report.sleepAnalysis) },
    { field: 'recoveryAnalysis', text: str(report.recoveryAnalysis) },
    { field: 'trainingLoadAnalysis', text: str(report.trainingLoadAnalysis) },
    { field: 'correlationInsights', text: str(report.correlationInsights) },
    { field: 'coachNotes', text: str(report.coachNotes) }
  ];
  const sections = Array.isArray(report.sections) ? report.sections : [];
  for (let i = 0; i < sections.length; i += 1) {
    parts.push({ field: `sections[${i}].title`, text: str(sections[i].title) });
    parts.push({ field: `sections[${i}].body`, text: str(sections[i].body) });
  }
  const actions = Array.isArray(report.actions) ? report.actions : [];
  for (let i = 0; i < actions.length; i += 1) {
    // `rank` is a structural ordinal, not prose — it is not validated as a citation.
    parts.push({ field: `actions[${i}].action`, text: str(actions[i].action) });
    parts.push({ field: `actions[${i}].rationale`, text: str(actions[i].rationale) });
  }
  return parts.filter((p) => p.text.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Deterministic numeric validation (NO LLM)
// ---------------------------------------------------------------------------

/** Numerals in a piece of prose, thousands separators removed, as strings. */
function extractNumbersFromText(text) {
  const cleaned = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  const found = cleaned.match(/-?\d+(?:\.\d+)?/g);
  return found ? found.slice() : [];
}

function isAllowlisted(token) {
  if (ALLOWLIST_EXTRA.has(token)) return true;
  const n = Number(token);
  if (!Number.isFinite(n)) return true; // not really a number → nothing to verify
  if (Number.isInteger(n) && n >= 0 && n <= ALLOWLIST_MAX_ORDINAL) return true;
  if (Number.isInteger(n) && n >= ALLOWLIST_YEAR_MIN && n <= ALLOWLIST_YEAR_MAX) return true;
  return false;
}

/**
 * Mechanically proves the prose cites only supplied facts.
 *
 * @param {object} report          the generated report
 * @param {Set<string>} factNumbers  from flattenFactsToNumbers(stats)
 * @returns {{passed:boolean, orphanNumbers:string[], occurrences:Array, checked:number}}
 */
function validateReportNumbers(report, factNumbers) {
  const facts = factNumbers instanceof Set ? factNumbers : new Set(factNumbers || []);
  const occurrences = [];
  const orphans = new Set();
  let checked = 0;

  const parts = reportProseParts(report);
  for (let i = 0; i < parts.length; i += 1) {
    const tokens = extractNumbersFromText(parts[i].text);
    for (let j = 0; j < tokens.length; j += 1) {
      const token = tokens[j];
      checked += 1;
      if (facts.has(token)) continue;
      // "-3.4" in prose for a fact stored as 3.4 (and vice-versa) is the same fact.
      const unsigned = token.startsWith('-') ? token.slice(1) : null;
      if (unsigned && facts.has(unsigned)) continue;
      if (isAllowlisted(token)) continue;
      orphans.add(token);
      occurrences.push({ field: parts[i].field, number: token });
    }
  }

  return {
    passed: orphans.size === 0,
    orphanNumbers: Array.from(orphans),
    occurrences,
    checked
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const NARRATIVE_SYSTEM = `You are BodyBank's recovery and readiness coach writing a wearable-data report for one member.

ABSOLUTE, NON-NEGOTIABLE RULE — YOU MUST NOT DO ARITHMETIC.
You are given a PRE-COMPUTED statistics object. Every mean, median, minimum, maximum, standard deviation, delta, percentage, correlation coefficient, count and date you are allowed to mention is ALREADY IN THAT OBJECT, already rounded.
- NEVER calculate, add, subtract, average, convert, re-round, extrapolate, project or estimate any number.
- NEVER introduce a number that is not present verbatim in the supplied facts. Not "about 8 hours", not "roughly 15%", not "around 60 bpm", not a converted unit, not a re-rounded value.
- Copy every figure EXACTLY as written in the facts (if the fact says 62.5, write 62.5 — never 62, 63 or "about 63").
- If you want to make a point that needs a number you were not given, make the point qualitatively instead, in words, with no number at all.
- Do not invent dates. Only dates present in the facts may appear.
- Numerals 1 to 10 may be used for ranking or ordinary counting of your own list items; everything else must be a supplied fact.
A downstream validator mechanically checks every numeral in your output against the supplied facts and REJECTS the report if even one number is not there. Qualitative writing with no number always beats an invented number.

YOUR JOB is interpretation, not calculation: explain what the numbers mean for this member, how the metrics relate to each other, what is going well, what is a risk, and what to do next. Be specific, warm and practical. Use the polarity information correctly — a FALLING resting heart rate is an improvement; a falling recovery score is not. Use the supplied direction labels rather than deciding for yourself.

Return ONLY valid JSON, no markdown fences, with exactly this shape:
{
  "headline": "one-line verdict on the window",
  "summary": "2-4 sentence executive summary",
  "sections": [ { "title": "Section title", "body": "Interpretive paragraph(s)" } ],
  "sleepAnalysis": "paragraph(s) on sleep duration, efficiency and debt",
  "recoveryAnalysis": "paragraph(s) on recovery, HRV and resting heart rate",
  "trainingLoadAnalysis": "paragraph(s) on strain vs recovery balance",
  "correlationInsights": "what the supplied correlations do and do not show, with their strength labels and sample sizes",
  "actions": [ { "rank": 1, "action": "Specific, doable action", "rationale": "Why, tied to a supplied fact" } ],
  "coachNotes": "short note for the coach reviewing this member"
}`;

const VALIDATOR_SYSTEM = `You are a strict fact-checker. You receive (A) a JSON object of pre-computed statistics and (B) a narrative report written about them.

Find statements in the narrative that CONTRADICT the statistics, and claims that the statistics do not support.

Return ONLY valid JSON:
{
  "contradictions": [ { "quote": "exact sentence from the narrative", "why": "which fact it contradicts" } ],
  "unsupportedClaims": [ { "quote": "exact sentence", "why": "what is missing from the facts" } ]
}

Rules:
- Judge ONLY against the supplied statistics. Do not use outside knowledge of physiology to invent problems.
- Direction words matter: a falling resting heart rate is an improvement; a falling recovery score is a decline.
- A correlation is not causation — flag causal language over a weak or 'none' correlation as unsupported.
- Return empty arrays when the narrative is faithful. Never do arithmetic yourself.`;

function correctiveInstruction(orphanNumbers, occurrences) {
  const list = orphanNumbers.map((n) => `"${n}"`).join(', ');
  const where = (occurrences || [])
    .slice(0, 12)
    .map((o) => `${o.field}: ${o.number}`)
    .join('; ');
  return `

CORRECTION REQUIRED — YOUR PREVIOUS ANSWER WAS REJECTED.
These numbers appeared in your prose but DO NOT EXIST in the supplied facts: ${list}.
Locations: ${where || 'multiple fields'}.
You computed, estimated, re-rounded or invented them. Rewrite the ENTIRE report. Remove every one of those numbers. Either cite the exact figure from the facts instead, or make the point in words with no number at all. Do not perform any arithmetic.`;
}

function buildUserContent({ facts, member, bloodContext }) {
  const chunks = [];
  chunks.push(
    `MEMBER:\n${JSON.stringify(
      {
        name: (member && (member.name || member.fullName)) || 'Member',
        age: (member && member.age) || null,
        gender: (member && member.gender) || null,
        goal: (member && member.goal) || null
      },
      null,
      2
    )}`
  );
  chunks.push(
    `PRE-COMPUTED WEARABLE STATISTICS (the ONLY numbers you may cite):\n${JSON.stringify(facts, null, 2)}`
  );
  if (bloodContext) {
    chunks.push(
      `BLOOD MARKER CONTEXT (from the member's blood analysis reports — cross-reference HRV and resting-heart-rate trends against these markers, but again: cite only numbers that appear here or in the statistics above):\n${JSON.stringify(
        bloodContext,
        null,
        2
      )}`
    );
  }
  chunks.push('Write the report as JSON. Interpretation only — no arithmetic, no invented numbers.');
  return [{ type: 'text', text: chunks.join('\n\n') }];
}

// ---------------------------------------------------------------------------
// Semantic (LLM) validation pass
// ---------------------------------------------------------------------------

async function runSemanticValidation({ apiKey, model, facts, report }) {
  try {
    const pass = await runJsonPass({
      apiKey,
      model,
      maxTokens: Math.max(
        400,
        parseInt(process.env.ANTHROPIC_WHOOP_VALIDATOR_MAX_TOKENS || '1500', 10) || 1500
      ),
      maxRetryTokens: 3000,
      system: VALIDATOR_SYSTEM,
      userContent: [
        {
          type: 'text',
          text: `STATISTICS:\n${JSON.stringify(facts, null, 2)}\n\nNARRATIVE REPORT:\n${JSON.stringify(
            report,
            null,
            2
          )}\n\nReturn the JSON verdict.`
        }
      ],
      coerce: (parsed) => (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
    });
    const result = pass.result || {};
    return {
      semantic: {
        ran: !!pass.result,
        model,
        contradictions: Array.isArray(result.contradictions) ? result.contradictions : [],
        unsupportedClaims: Array.isArray(result.unsupportedClaims) ? result.unsupportedClaims : [],
        error: pass.result ? null : `Validator returned no JSON (stop_reason: ${pass.stopReason || 'unknown'})`
      },
      usage: pass.usage
    };
  } catch (err) {
    // A failed cheap validator must never sink an otherwise-verified report.
    return {
      semantic: {
        ran: false,
        model,
        contradictions: [],
        unsupportedClaims: [],
        error: String((err && err.message) || err || 'semantic validation failed').slice(0, 500)
      },
      usage: buildUsage(model, 0, 0)
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.stats         output of computeWhoopStats()
 * @param {object} [args.member]      {name, age, gender, goal}
 * @param {object} [args.bloodContext] marker trends from blood_analysis_reports
 * @param {string} [args.apiKey]      defaults to ANTHROPIC_API_KEY
 * @returns {Promise<{report:object, validation:object, usage:object, model:object}>}
 */
async function generateWhoopReport({ stats, member, bloodContext, apiKey } = {}) {
  const key = String(apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured');
  if (!stats || typeof stats !== 'object') throw new Error('generateWhoopReport requires a stats object');

  const narrativeModel = (process.env.ANTHROPIC_MODEL_WHOOP_NARRATIVE || 'claude-opus-5').trim();
  const validatorModel = (process.env.ANTHROPIC_MODEL_WHOOP_VALIDATOR || 'claude-haiku-4-5').trim();
  // Opus 5 thinks by default and max_tokens caps thinking + response text together,
  // so this needs headroom the pre-Opus-5 default (8000) did not.
  const narrativeMaxTokens = Math.max(
    2000,
    parseInt(process.env.ANTHROPIC_WHOOP_NARRATIVE_MAX_TOKENS || '16000', 10) || 16000
  );

  const facts = buildFactsForPrompt(stats);
  const factNumbers = flattenFactsToNumbers(stats);
  const userContent = buildUserContent({ facts, member, bloodContext });

  const narrativeUsages = [];
  const attempts = [];
  let report = null;
  let numeric = null;
  let system = NARRATIVE_SYSTEM;

  for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt += 1) {
    const pass = await runJsonPass({
      apiKey: key,
      model: narrativeModel,
      maxTokens: narrativeMaxTokens,
      maxRetryTokens: 24000,
      system,
      userContent,
      coerce: coerceReport
    });
    narrativeUsages.push(pass.usage);

    if (!pass.result) {
      attempts.push({ attempt: attempt + 1, ok: false, reason: `no valid JSON (stop_reason: ${pass.stopReason || 'unknown'})` });
      if (attempt === MAX_VALIDATION_RETRIES) {
        throw new Error(
          `Whoop narrative pass did not return valid JSON (stop_reason: ${pass.stopReason || 'unknown'})`
        );
      }
      continue;
    }

    report = pass.result;
    numeric = validateReportNumbers(report, factNumbers);
    attempts.push({
      attempt: attempt + 1,
      ok: numeric.passed,
      orphanNumbers: numeric.orphanNumbers,
      numbersChecked: numeric.checked
    });
    if (numeric.passed) break;

    // Retry with a corrective instruction that names the offending numbers.
    system = NARRATIVE_SYSTEM + correctiveInstruction(numeric.orphanNumbers, numeric.occurrences);
  }

  const { semantic, usage: validatorUsage } = await runSemanticValidation({
    apiKey: key,
    model: validatorModel,
    facts,
    report
  });

  const narrativeUsage = sumUsage(narrativeModel, narrativeUsages);
  const usage = {
    ...sumUsage(`${narrativeModel} + ${validatorModel}`, [narrativeUsage, validatorUsage]),
    narrative: narrativeUsage,
    validator: validatorUsage
  };

  return {
    report,
    validation: {
      // NEVER silently ship unverified numbers: passed:false is surfaced, with the
      // exact orphan numbers, rather than being swallowed.
      passed: !!(numeric && numeric.passed),
      orphanNumbers: (numeric && numeric.orphanNumbers) || [],
      occurrences: (numeric && numeric.occurrences) || [],
      numbersChecked: (numeric && numeric.checked) || 0,
      attempts,
      factNumberCount: factNumbers.size,
      semantic
    },
    usage,
    model: { narrative: narrativeModel, validator: validatorModel }
  };
}

module.exports = {
  generateWhoopReport,
  buildFactsForPrompt,
  // exported for tests / reuse
  validateReportNumbers,
  extractNumbersFromText,
  reportProseParts,
  coerceReport,
  isAllowlisted,
  NARRATIVE_SYSTEM,
  VALIDATOR_SYSTEM
};
