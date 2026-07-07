'use strict';

/**
 * Generates ONE candidate message for an event, then runs the deterministic post-filter
 * (length / banned phrases / anti-repeat). Retries generation once on a filter miss. If
 * the LLM is unavailable/degraded/refuses, falls back to a safe deterministic template
 * so the pipeline never sends a broken or half message — and never leaves the caller
 * without an answer for a user reply.
 */

const llm = require('./llm');
const { checkMessage } = require('./postFilter');
const { getPersonality } = require('./prompts/personalities');

/**
 * @param {object} ctx
 * @param {object} plan  from contextBuilder.buildContext: { system, userText, maxWords, recentBodies, personality }
 * @param {object} opts  { tier='generate', maxTokens=350, allowFallback=true, fallbackText }
 * @returns {Promise<{ ok, text, model, usage, source }>}  source: 'llm' | 'fallback'
 */
async function generateMessage(ctx, plan, opts = {}) {
  const tier = opts.tier || 'generate';
  const maxTokens = opts.maxTokens || 350;

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.generate(ctx, {
      tier,
      system: plan.system,
      messages: plan.messages || [{ role: 'user', content: plan.userText }],
      maxTokens
    });
    if (!out.ok) break; // degraded / refusal / error → fall through to fallback
    const check = checkMessage(out.text, {
      maxWords: (plan.maxWords || 90) + 20, // small grace over the personality target
      recentMessages: plan.recentBodies || []
    });
    if (check.ok) {
      return { ok: true, text: check.text, model: out.model, usage: out.usage, source: 'llm' };
    }
    // One retry with an explicit nudge appended to the user turn.
    if (attempt === 0) {
      const nudge = `\n\n(Your previous attempt was rejected: ${check.reasons.join(', ')}. Write a fresh, shorter message that avoids repeating recent ones.)`;
      plan = { ...plan, userText: (plan.userText || '') + nudge, messages: null };
    }
  }

  // Safe fallback — silence-equivalent quality guarantee.
  if (opts.allowFallback === false) {
    return { ok: false, text: '', source: 'none' };
  }
  const text = opts.fallbackText || fallbackFor(plan);
  return { ok: true, text, model: 'fallback', usage: {}, source: 'fallback' };
}

/** A minimal, on-brand deterministic message when the LLM can't produce one. */
function fallbackFor(plan) {
  const p = plan && plan.personality ? plan.personality : getPersonality('friendly');
  const name = plan && plan.factsName ? plan.factsName : '';
  const hey = name ? `Hey ${name} — ` : '';
  if (p.id === 'minimal') return `Quick nudge: check in today and keep the streak alive.`;
  return `${hey}checking in on your progress today. Log your check-in and let's keep the momentum going.`;
}

module.exports = { generateMessage, fallbackFor };
