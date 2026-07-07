'use strict';

/**
 * A/B experiments (Phase 7). An experiment targets an event type (or 'all') and defines
 * weighted variants that can override the personality and/or append an instruction to the
 * generation task. Assignment is deterministic per (user, experiment) so a user always
 * sees the same variant, and the variant is stamped on coach_messages.ab_variant for a
 * clean readout on reply/open rate.
 *
 *   variant = { key:'A', weight:1, personality?:'science', append?:'Lead with the number.' }
 */

const { safeJsonParse } = require('./util');

/** Stable 0..1 hash of a string (FNV-ish). Deterministic across runs. */
function hash01(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Convert to unsigned then scale to [0,1)
  return ((h >>> 0) % 100000) / 100000;
}

async function listActive(ctx) {
  const rows = await ctx.queryAll(
    "SELECT * FROM coach_experiments WHERE status = 'active' ORDER BY created_at ASC"
  ).catch(() => []);
  return (rows || []).map((r) => ({ ...r, variants: safeJsonParse(r.variants, []) }));
}

/**
 * Pick the variant for this user on the experiment matching eventType (or 'all').
 * Returns null when there is no applicable experiment (→ no behaviour change).
 */
async function assign(ctx, userId, eventType) {
  const exps = await listActive(ctx);
  const exp = exps.find((e) => e.target_type === eventType) || exps.find((e) => e.target_type === 'all');
  if (!exp || !Array.isArray(exp.variants) || !exp.variants.length) return null;

  const total = exp.variants.reduce((s, v) => s + (Number(v.weight) > 0 ? Number(v.weight) : 1), 0);
  const point = hash01(`${userId}:${exp.id}`) * total;
  let acc = 0;
  let chosen = exp.variants[exp.variants.length - 1];
  for (const v of exp.variants) {
    acc += (Number(v.weight) > 0 ? Number(v.weight) : 1);
    if (point < acc) { chosen = v; break; }
  }
  return {
    experimentId: exp.id,
    experimentName: exp.name,
    variantKey: chosen.key,
    personality: chosen.personality || null,
    append: chosen.append || null,
    abVariant: `${exp.id}:${chosen.key}`
  };
}

async function create(ctx, { name, targetType, metric, variants }) {
  const id = ctx.uuidv4();
  await ctx.run(
    `INSERT INTO coach_experiments (id, name, target_type, metric, variants, status, created_at)
     VALUES (?, ?, ?, ?, ?::jsonb, 'active', NOW())`,
    [id, String(name || 'experiment').slice(0, 120), String(targetType || 'all'),
     String(metric || 'reply_rate'), JSON.stringify(Array.isArray(variants) ? variants : [])]
  );
  return { id };
}

/** Readout: per-variant send/open/reply counts over the last 30 days. */
async function readout(ctx) {
  const rows = await ctx.queryAll(
    `SELECT ab_variant,
            COUNT(*)::int AS sends,
            COUNT(opened_at)::int AS opens,
            COUNT(replied_at)::int AS replies
     FROM coach_messages
     WHERE ab_variant IS NOT NULL AND sent_at >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY ab_variant ORDER BY sends DESC`
  ).catch(() => []);
  return (rows || []).map((r) => ({
    ab_variant: r.ab_variant,
    sends: r.sends,
    opens: r.opens,
    replies: r.replies,
    open_rate: r.sends ? Number((r.opens / r.sends).toFixed(3)) : 0,
    reply_rate: r.sends ? Number((r.replies / r.sends).toFixed(3)) : 0
  }));
}

module.exports = { hash01, listActive, assign, create, readout };
