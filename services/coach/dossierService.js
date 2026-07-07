'use strict';

/**
 * The dossier — the long-term, natural-language "what I know about this person" memory
 * that gets injected into every generation prompt. Regenerated nightly (or after a
 * significant event) by Claude from structured facts + the prior dossier. Falls back to
 * a deterministic, facts-only dossier when no API key / LLM is available, so the coach
 * always has *some* memory to read.
 */

const llm = require('./llm');
const { gatherFacts } = require('./facts');
const { getSettings } = require('./memoryService');
const { safeJsonParse } = require('./util');

async function getDossier(ctx, userId) {
  const row = await ctx.queryOne('SELECT * FROM coach_dossier WHERE user_id = ?', [userId]).catch(() => null);
  if (!row) return null;
  row.facts = safeJsonParse(row.facts, {});
  return row;
}

function deterministicDossier(facts) {
  const L = [`## ${facts.name} — coach dossier`];
  if (facts.goalType) L.push(`**Goal:** ${facts.goalType}${facts.targetWeight != null ? `, target ${facts.targetWeight}kg` : ''}.`);
  if (facts.healthScore != null) L.push(`**Health score:** ${facts.healthScore}/100${facts.weakDimension ? `, weakest area is ${facts.weakDimension}` : ''}.`);
  if (facts.streak != null) L.push(`**Streak:** ${facts.streak} day check-in streak (best ${facts.longestStreak || facts.streak}).`);
  const w = facts.week;
  L.push(`**Last 7 days:** ${w.workouts ?? 0} workout day(s), ${w.checkins ?? 0} check-in(s), ${w.mealDays ?? 0} day(s) with meals logged.`);
  if (facts.weakDimension) L.push(`**Coaching focus:** their weakest lever right now is ${facts.weakDimension} — steer support there without nagging.`);
  L.push(`**Note:** keep messages warm and specific; never fabricate numbers not in their data.`);
  return L.join('\n');
}

const DOSSIER_SYSTEM = `You maintain a concise coaching dossier about one fitness client. Given structured facts and their previous dossier, produce an updated dossier: a ~250-400 word markdown profile a human coach could read at a glance.

Include (only what the facts support — never invent specifics): Goal, Program/focus, Strengths, Weak spots, Patterns, Recent arc (are they improving, plateaued, lapsing?), Wins worth remembering, and Coaching notes (what tone/approach works, what to avoid). If a fact isn't given, don't fabricate it — omit that line.

Output ONLY the markdown dossier. No preamble.`;

async function regenerate(ctx, userId) {
  const settings = await getSettings(ctx, userId);
  const facts = await gatherFacts(ctx, userId, settings.timezone);
  const prior = await getDossier(ctx, userId);

  let summary = null;
  const factsBlock = JSON.stringify(facts, null, 0);
  const priorBlock = prior && prior.summary ? `\n\nPREVIOUS DOSSIER:\n${prior.summary}` : '';

  const out = await llm.generate(ctx, {
    tier: 'report',
    system: [{ text: DOSSIER_SYSTEM, cache: true }],
    userText: `STRUCTURED FACTS (JSON):\n${factsBlock}${priorBlock}`,
    maxTokens: 900
  });

  summary = out.ok && out.text ? out.text : deterministicDossier(facts);

  const version = (prior && prior.version ? prior.version : 0) + 1;
  await ctx.run(
    `INSERT INTO coach_dossier (user_id, summary, facts, version, refreshed_at)
     VALUES (?, ?, ?::jsonb, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       facts = EXCLUDED.facts,
       version = EXCLUDED.version,
       refreshed_at = CURRENT_TIMESTAMP`,
    [userId, summary, JSON.stringify(facts), version]
  );
  return { summary, facts, version, generated: out.ok };
}

module.exports = { getDossier, regenerate, deterministicDossier };
