'use strict';

/**
 * Message templates — data-light, instruction-heavy. Each tells Claude the JOB and the
 * RULES for one kind of message and lets the dossier + stats supply the specifics.
 * Every template exports { id, version, build(ctx) } → returns the TASK block appended
 * after the (cached) base voice + personality + dossier + stats in the user turn.
 *
 * `ctx` = { event, stats, personality } where stats is a short pre-computed string.
 */

function tmpl(id, version, taskFn) {
  return { id, version, build: (ctx) => taskFn(ctx) };
}

const TEMPLATES = {
  reinforce: tmpl('reinforce', '1', () => `TASK: The user just did something good (see TRIGGER + STATS). Write ONE short message that:
- Names the specific thing they did, using the real numbers from STATS.
- Feels like you noticed, not like an automated "great job".
- Does NOT ask them to do more right now. Just acknowledge the win.
Output: the message only.`),

  nudge: tmpl('nudge', '1', () => `TASK: You noticed a gap (see TRIGGER + STATS). Write ONE forward-looking message that:
- Names what you noticed with the exact numbers, calmly.
- Gives ONE concrete action they can still take today.
- Contains no guilt and no "you should have". Forward-looking only.
Output: the message only.`),

  proteinNudge: tmpl('proteinNudge', '1', () => `TASK: The user is short on protein today and a meal is still left to log. Write ONE message (respect the word limit) that:
- States the exact gap from STATS (e.g. "you're at 95g of ~150g").
- Gives ONE achievable action for their next meal; if the dossier names a favourite high-protein food, use it.
- Only mentions previous days if STATS shows a multi-day pattern worth naming.
- No guilt. Forward-looking.
Output: the message only.`),

  plateau: tmpl('plateau', '1', () => `TASK: The user's progress has plateaued (see STATS). Write ONE message that:
- Acknowledges plateaus are normal and names how long it's been, using STATS.
- Reframes it without alarm and gives ONE specific lever to try (from their own data / program).
- Never implies they did something wrong.
Output: the message only.`),

  reengage: tmpl('reengage', '1', () => `TASK: The user has gone quiet (see TRIGGER for how long). Write ONE warm, low-pressure message that:
- Does NOT count their missed days back at them ("you missed 3 days" is banned).
- Reminds them you're here and makes restarting feel like no big deal.
- Offers ONE tiny first step to get moving again.
Output: the message only.`),

  comeback: tmpl('comeback', '1', () => `TASK: The user is coming back after a lapse — the single highest-leverage moment. Write ONE genuinely warm message that:
- Treats the return as a good thing, with zero reference to the gap being a failure.
- Frames it as "no big deal, let's go".
- Offers one easy on-ramp for today.
Output: the message only.`),

  ritual: tmpl('ritual', '1', () => `TASK: This is a scheduled check-in / reflection (see TRIGGER). Write ONE message that:
- Fits the time of day in CONSTRAINTS (morning = set intent; evening = reflect).
- Uses something real from STATS/DOSSIER so it's clearly for THIS person.
- Ends with a gentle prompt or a single suggestion — not a demand.
Output: the message only.`),

  weeklySummary: tmpl('weeklySummary', '1', () => `TASK: Write the user's weekly recap. This one may run a little longer than a normal nudge. It should:
- Lead with the single most important story of their week from STATS (a win or a clear trend).
- Name 2-3 concrete numbers that back it up. Never invent any.
- Close with ONE focus for the coming week tied to their weakest dimension.
- Sound like a coach who watched their whole week, warm and specific.
Output: the message only.`),

  reply: tmpl('reply', '1', () => `TASK: The user sent you a message (see the conversation). Reply as their coach:
- Answer their actual question directly, grounded in their real data from STATS/DOSSIER.
- If you don't have the data to answer precisely, say what you'd need rather than inventing numbers.
- Keep it conversational and specific to them. One clear answer + at most one next step.
Output: the reply only.`),

  generic: tmpl('generic', '1', () => `TASK: Write ONE short, specific coaching message for this user based on TRIGGER + STATS + DOSSIER. One observation tied to their real data, at most one action, no filler.
Output: the message only.`)
};

function getTemplate(id) {
  return TEMPLATES[String(id || 'generic')] || TEMPLATES.generic;
}

module.exports = { TEMPLATES, getTemplate };
