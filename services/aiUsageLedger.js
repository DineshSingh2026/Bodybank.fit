/**
 * AI TOKEN LEDGER
 *
 * Every Anthropic call in BodyBank writes one row here. Before this module the
 * usage of each feature lived in its own JSONB column (blood_analysis_reports,
 * nutrition_meal_logs, blood_comparison_reports) and three features — admin AI
 * Assist, Marketing AI, and the Whoop importer — recorded nothing at all, so
 * "what did AI cost us today" was unanswerable.
 *
 * Two rules keep this honest:
 *
 *  1. Pricing lives HERE and nowhere else. modelPricing() below is the single
 *     source of truth; the per-service copies now defer to it, so a rate change
 *     is one edit rather than five that drift apart.
 *  2. Recording NEVER breaks a feature. recordAiUsage() swallows every error —
 *     a ledger write failing must not fail a member's meal scan or a blood
 *     report. Cost tracking is observability, not business logic.
 *
 * The USD→INR rate is snapshotted onto each row at write time, so restating
 * AI_COST_USD_TO_INR later never silently rewrites past months.
 */

const { query } = require('../config/db');
const { todayYmdInTz } = require('./streakService');

/** Day bucketing follows the business day, not UTC — a 1am IST call belongs to today. */
const LEDGER_TZ = (process.env.APP_TIMEZONE || '').trim() || 'Asia/Kolkata';

/** Anthropic list price, USD per 1M tokens. Keep in sync with platform.claude.com/docs/en/pricing. */
const MODEL_PRICING = [
  { match: 'haiku', input: 1, output: 5 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'opus', input: 5, output: 25 },
  { match: 'fable', input: 10, output: 50 },
  { match: 'mythos', input: 10, output: 50 }
];

/** Unknown models bill at Haiku rates — the cheapest, so we under-report rather than alarm. */
const FALLBACK_PRICING = [1, 5];

/**
 * Scopes are the vocabulary the admin Tokens screen groups by. Adding an AI
 * feature means adding it here so it gets a readable label instead of a slug.
 */
const SCOPE_LABELS = {
  admin_ai_assist: 'Admin AI Assist',
  marketing_ai: 'Marketing AI',
  nutrition_meal: 'Meal scan (members)',
  blood_validation: 'Blood report — validation',
  blood_extraction: 'Blood report — extraction',
  blood_analysis: 'Blood report — analysis',
  blood_comparison: 'Blood report — comparison',
  whoop_extract: 'Whoop — PDF import',
  whoop_report: 'Whoop — monthly report',
  // Universal device upload: reading a member's watch data off a screenshot or a
  // non-Whoop PDF. Without this entry the admin Tokens screen shows a raw slug.
  device_vision: 'Wearables — screenshot import',
  smart_scale_extraction: 'Smart scale — extraction'
};

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * @returns {[number, number]} [inputPerMillionUsd, outputPerMillionUsd]
 */
function modelPricing(model) {
  const m = String(model || '').toLowerCase();
  const hit = MODEL_PRICING.find((p) => m.includes(p.match));
  let inPerM = hit ? hit.input : FALLBACK_PRICING[0];
  let outPerM = hit ? hit.output : FALLBACK_PRICING[1];
  // Explicit env overrides win — they exist so a negotiated rate can be applied
  // without a deploy, and they have always applied across every model.
  if (process.env.ANTHROPIC_INPUT_PER_MILLION_USD) {
    inPerM = toNumber(process.env.ANTHROPIC_INPUT_PER_MILLION_USD, inPerM);
  }
  if (process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD) {
    outPerM = toNumber(process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD, outPerM);
  }
  return [inPerM, outPerM];
}

function usdToInrRate() {
  return toNumber(process.env.AI_COST_USD_TO_INR, 83);
}

/** The cost half of the `usage` object every AI service already returns. */
function estimateAnthropicUsageCost(inputTokens, outputTokens, model) {
  const [inputPerMillionUsd, outputPerMillionUsd] = modelPricing(model);
  const inUsd =
    (toNumber(inputTokens) / 1000000) * inputPerMillionUsd +
    (toNumber(outputTokens) / 1000000) * outputPerMillionUsd;
  return {
    estimated_cost_usd: Number(inUsd.toFixed(6)),
    estimated_cost_inr: Number((inUsd * usdToInrRate()).toFixed(4))
  };
}

/** The full `usage` object shape shared by every AI service in the app. */
function buildUsage(model, inputTokens, outputTokens) {
  return {
    provider: 'anthropic',
    model: String(model || ''),
    input_tokens: toNumber(inputTokens),
    output_tokens: toNumber(outputTokens),
    total_tokens: toNumber(inputTokens) + toNumber(outputTokens),
    ...estimateAnthropicUsageCost(inputTokens, outputTokens, model)
  };
}

/**
 * Record one AI call. Fire-and-forget: callers may await it, but a rejection is
 * impossible by design — see rule 2 in the file header.
 *
 * @param {object}  entry
 * @param {string}  entry.scope     One of SCOPE_LABELS' keys.
 * @param {object}  [entry.usage]   A `usage` object from any AI service (preferred).
 * @param {string}  [entry.model]   Used only when `usage` is absent.
 * @param {number}  [entry.inputTokens]
 * @param {number}  [entry.outputTokens]
 * @param {string}  [entry.userId]  Whose action triggered the spend, when known.
 * @param {string}  [entry.refType] e.g. 'blood_report', 'meal_log'.
 * @param {string}  [entry.refId]
 */
async function recordAiUsage(entry) {
  try {
    const e = entry || {};
    const scope = String(e.scope || 'unknown').trim().slice(0, 60);
    const usage = e.usage && typeof e.usage === 'object' ? e.usage : null;

    const model = String((usage && usage.model) || e.model || '').trim().slice(0, 120);
    const inputTokens = Math.max(0, Math.round(toNumber(usage ? usage.input_tokens : e.inputTokens)));
    const outputTokens = Math.max(0, Math.round(toNumber(usage ? usage.output_tokens : e.outputTokens)));

    // A call that consumed nothing is a failed call, not a cost — skip it so the
    // daily call count stays a count of real spend.
    if (inputTokens <= 0 && outputTokens <= 0) return;

    // Recompute rather than trusting the caller's cost fields: services priced a
    // multi-model total as one blended string, and one formula beats five.
    const { estimated_cost_usd: costUsd, estimated_cost_inr: costInr } =
      estimateAnthropicUsageCost(inputTokens, outputTokens, model);

    const usageDate = todayYmdInTz(LEDGER_TZ) || new Date().toISOString().slice(0, 10);

    await query(
      `INSERT INTO ai_usage_events
         (usage_date, scope, provider, model, input_tokens, output_tokens, total_tokens,
          cost_usd, cost_inr, usd_to_inr, user_id, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usageDate,
        scope,
        String((usage && usage.provider) || 'anthropic'),
        model,
        inputTokens,
        outputTokens,
        inputTokens + outputTokens,
        costUsd,
        costInr,
        usdToInrRate(),
        e.userId ? String(e.userId) : null,
        e.refType ? String(e.refType).slice(0, 40) : null,
        e.refId ? String(e.refId).slice(0, 80) : null
      ]
    );
  } catch (err) {
    // Deliberately swallowed. A ledger failure must never surface to a member.
    console.error('[ai-usage-ledger]', err.message);
  }
}

module.exports = {
  recordAiUsage,
  modelPricing,
  estimateAnthropicUsageCost,
  buildUsage,
  usdToInrRate,
  SCOPE_LABELS,
  LEDGER_TZ
};
