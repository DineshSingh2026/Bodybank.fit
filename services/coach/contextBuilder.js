'use strict';

/**
 * Assembles the prompt "context pack": a stable, cacheable prefix (base voice + active
 * personality) followed by the volatile per-user turn (dossier + real stats + trigger +
 * recent messages + constraints + the task from the template). Keeps the cached prefix
 * frozen and puts everything that changes per user/event after it.
 */

const { BASE_VOICE } = require('./prompts/base');
const { getPersonality } = require('./prompts/personalities');
const { getTemplate } = require('./prompts/templates');
const { gatherFacts, buildStatsString } = require('./facts');
const { getDossier } = require('./dossierService');
const { recentMessageBodies } = require('./memoryService');
const { metaFor } = require('./taxonomy');
const { tzNow, safeJsonParse } = require('./util');

function timeOfDay(hour) {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function payloadSummary(payload) {
  const p = safeJsonParse(payload, {}) || {};
  const keys = Object.keys(p).filter((k) => p[k] != null && p[k] !== '');
  if (!keys.length) return '';
  return keys.slice(0, 8).map((k) => `${k}=${typeof p[k] === 'object' ? JSON.stringify(p[k]) : p[k]}`).join(', ');
}

/**
 * @returns {{ system:Array, userText:string, personality:object, template:object,
 *             recentBodies:string[], maxWords:number, statsString:string }}
 */
async function buildContext(ctx, userId, event, settings, profile, opts = {}) {
  const personality = getPersonality(opts.personalityOverride || settings.personality);
  const meta = metaFor(event.type) || { template: 'generic' };
  const template = getTemplate(meta.template);

  const [facts, dossier, recentBodies] = await Promise.all([
    gatherFacts(ctx, userId, settings.timezone),
    getDossier(ctx, userId),
    recentMessageBodies(ctx, userId, 5)
  ]);
  const statsString = buildStatsString(facts);
  const dossierText = dossier && dossier.summary ? dossier.summary : `(${facts.name}: no dossier yet — rely on STATS.)`;

  const maxWords = personality.maxWords || 90;

  // Stable, cacheable prefix — base voice + personality + tone budget.
  const prefix = `${BASE_VOICE}

ACTIVE PERSONALITY: ${personality.label}
${personality.voice}
Hard limit: at most ${maxWords} words and at most ${personality.emojiBudget} emoji.`;

  const parts = tzNow(settings.timezone);
  const tod = timeOfDay(parts.hour);

  const recentBlock = recentBodies.length
    ? recentBodies.map((b) => `- "${String(b).slice(0, 160)}"`).join('\n')
    : '(none)';

  let task = template.build({ event, stats: statsString, personality });
  if (opts.variantAppend) task += `\n\nEXTRA: ${String(opts.variantAppend).slice(0, 400)}`;

  const userText = `DOSSIER (long-term memory):
${dossierText}

TRIGGER: ${event.type}${payloadSummary(event.payload) ? ` — ${payloadSummary(event.payload)}` : ''}

STATS (real data — use these exact numbers, invent nothing):
${statsString}

RECENT COACH MESSAGES (do NOT repeat any of these):
${recentBlock}

CONSTRAINTS: max_words=${maxWords}, time_of_day=${tod}, channel=in_app, language=${settings.language || 'en'}

${task}`;

  return {
    system: [{ text: prefix, cache: true }],
    userText,
    personality,
    template,
    recentBodies,
    maxWords,
    statsString
  };
}

module.exports = { buildContext, timeOfDay };
