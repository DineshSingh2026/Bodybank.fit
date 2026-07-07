'use strict';

/**
 * Central Anthropic wrapper for the coach. Every Claude call goes through here so we
 * own model tiering, prompt caching, retries, token/cost accounting (coach_cost_ledger)
 * and the monthly kill-switch. Mirrors the raw-fetch pattern already used in
 * services/nutritionService.js.
 *
 * IMPORTANT model notes (current API surface):
 *  - Tiers: Haiku 4.5 (decide/classify) · Sonnet 5 (generate) · Opus 4.8 (report/dossier).
 *  - Do NOT send `temperature` — it 400s on Opus 4.8 / Sonnet 5. (Omitted entirely.)
 *  - Always check stop_reason before reading content; on 'refusal' → safe fallback.
 *  - System prompt is sent as blocks with cache_control on the stable prefix.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const TIER = {
  decide: process.env.COACH_MODEL_DECIDE || 'claude-haiku-4-5',
  generate: process.env.COACH_MODEL_GENERATE || 'claude-sonnet-5',
  report: process.env.COACH_MODEL_REPORT || 'claude-opus-4-8'
};

// USD per 1M tokens (in / out). Used for the cost ledger + monthly guard.
const PRICING = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-4-8': { in: 5, out: 25 }
};

function priceFor(model) {
  return PRICING[model] || { in: 3, out: 15 };
}

function estCostUsd(model, inTok, outTok) {
  const p = priceFor(model);
  return (Number(inTok || 0) / 1e6) * p.in + (Number(outTok || 0) / 1e6) * p.out;
}

function hasApiKey() {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

function normalizeSystem(system) {
  // Accept a plain string or an array of {text, cache?} blocks. Returns Anthropic
  // system blocks with cache_control on the stable prefix (all but the last block,
  // or the block flagged cache:true).
  if (Array.isArray(system)) {
    return system.map((b) => {
      const block = { type: 'text', text: String(b.text || '') };
      if (b.cache) block.cache_control = { type: 'ephemeral' };
      return block;
    });
  }
  return [{ type: 'text', text: String(system || '') }];
}

async function invokeOnce({ model, system, messages, maxTokens }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 400,
      system: normalizeSystem(system),
      messages
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  // Refusal handling: check stop_reason before trusting content.
  if (data.stop_reason === 'refusal') {
    return { refusal: true, text: '', usage: data.usage || {}, model };
  }
  const block = (data.content || []).find((b) => b.type === 'text');
  const text = block && block.text ? String(block.text).trim() : '';
  return { refusal: false, text, usage: data.usage || {}, model };
}

/**
 * @param {object} ctx  { run, queryOne, tzYmd }
 * @param {object} opts { tier, system, messages, maxTokens }
 * @returns {Promise<{ok, text, model, usage, degraded, refusal, error}>}
 *   - ok:false with degraded/refusal/error tells the caller to fall back to a template.
 */
async function generate(ctx, opts = {}) {
  const model = opts.model || TIER[opts.tier] || TIER.generate;

  if (!hasApiKey()) {
    return { ok: false, degraded: true, text: '', model, usage: {}, reason: 'no_api_key' };
  }

  // Monthly kill-switch: hard ceiling on spend. 0/unset = unlimited.
  const budgetUsd = Number(process.env.COACH_MONTHLY_BUDGET_USD || 0);
  if (budgetUsd > 0) {
    const spent = await monthlyCostUsd(ctx).catch(() => 0);
    if (spent >= budgetUsd) {
      return { ok: false, degraded: true, text: '', model, usage: {}, reason: 'monthly_budget_exceeded' };
    }
  }

  const messages = opts.messages || [{ role: 'user', content: String(opts.userText || '') }];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await invokeOnce({ model, system: opts.system, messages, maxTokens: opts.maxTokens });
      const inTok = Number(out.usage && out.usage.input_tokens) || 0;
      const outTok = Number(out.usage && out.usage.output_tokens) || 0;
      const cost = estCostUsd(model, inTok, outTok);
      await recordCost(ctx, { inTok, outTok, cost }).catch(() => {});
      if (out.refusal) {
        return { ok: false, refusal: true, text: '', model, usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: cost } };
      }
      if (!out.text) {
        return { ok: false, error: 'empty_response', text: '', model, usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: cost } };
      }
      return { ok: true, text: out.text, model, usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: cost } };
    } catch (e) {
      lastErr = e;
      // Retry only transient errors (429 / 5xx). 4xx (bad request) → stop.
      const status = e.status || 0;
      if (status && status < 500 && status !== 429) break;
      await sleep(400 * (attempt + 1));
    }
  }
  return { ok: false, error: (lastErr && lastErr.message) || 'llm_failed', text: '', model, usage: {} };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function recordCost(ctx, { inTok, outTok, cost }) {
  const ymd = ctx.tzYmd ? ctx.tzYmd() : new Date().toISOString().slice(0, 10);
  await ctx.run(
    `INSERT INTO coach_cost_ledger (ymd, tokens_in, tokens_out, cost_usd, message_count)
     VALUES (?::date, ?, ?, ?, 1)
     ON CONFLICT (ymd) DO UPDATE SET
       tokens_in = coach_cost_ledger.tokens_in + EXCLUDED.tokens_in,
       tokens_out = coach_cost_ledger.tokens_out + EXCLUDED.tokens_out,
       cost_usd = coach_cost_ledger.cost_usd + EXCLUDED.cost_usd,
       message_count = coach_cost_ledger.message_count + 1`,
    [ymd, inTok, outTok, Number(cost.toFixed(6))]
  );
}

async function monthlyCostUsd(ctx) {
  const row = await ctx.queryOne(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM coach_cost_ledger
     WHERE ymd >= date_trunc('month', CURRENT_DATE)`
  );
  return row && row.total != null ? Number(row.total) : 0;
}

module.exports = { generate, recordCost, monthlyCostUsd, estCostUsd, TIER, PRICING, hasApiKey };
