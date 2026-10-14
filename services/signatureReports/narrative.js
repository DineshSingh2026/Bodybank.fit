'use strict';

/**
 * Signature reports — the coach's words.
 *
 *   rulesNarrative(model)            deterministic, always available
 *   buildNarrative(model, opts)      one validated LLM call over the rules draft
 *   applyEdits(narrative, edits)     the admin's edits (length-checked only)
 *
 * The model writes four fields and nothing else: headline, letter, chapter
 * (monthly cover title) and one line per pattern card is NOT among them — the
 * numbers on the page always come from services/signatureReports/model.js.
 * Every field the model returns is checked: length, no medical language, and
 * every multi-digit number must already be in FACTS. A field that fails falls
 * back to its rules version; a failed call leaves the rules draft in place.
 */

const { numbersGrounded, MEDICAL_RE, parseJsonLoose } = require('../reportInsights');

const LIMITS = Object.freeze({ headline: 110, letter: 760, chapter: 46, ps: 180, target: 110 });

/**
 * The voice for printed Signature reports. Written for paper, not WhatsApp:
 * a coach who knows the client's data and talks to them like a person.
 */
const SIGNATURE_VOICE = [
  'You are the client\'s BodyBank coach writing the personal part of their printed progress report.',
  'Voice: warm, direct, specific, first person, never generic. Talk to one person you know well.',
  'Lead with what they did, not with what they missed. Name the one thing that matters most next.',
  'Short sentences. No hype words (amazing, incredible, crushing it), no emoji, no exclamation marks in a row, no lists.',
  'Never shame. A bad week is information, not failure: say what it tells us and what we do next.',
  'Use ONLY numbers that appear in FACTS. Never invent a weight, measurement, lab value, date or percentage.',
  'No diagnosis, disease names, treatment, medication or supplement advice. Blood work is for their doctor.'
].join('\n');

function str(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; }
function clip(s, max) { const t = str(s); return t.length > max ? t.slice(0, max - 1).trim() + '…' : t; }
/** Lower-cases a sentence's first letter for mid-sentence use — but never a day or month name. */
function lowerFirst(s) {
  const t = String(s || '');
  if (!t || /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|^(January|February|March|April|May|June|July|August|September|October|November|December)\b|^BodyBank/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function bestPillar(m) {
  const list = m.pillars.filter((p) => p.counted && p.score != null && p.score > 0);
  if (!list.length) return null;
  const up = list.filter((p) => p.delta != null && p.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  return up || list.slice().sort((a, b) => b.score - a.score)[0];
}

function chapterRule(m) {
  const s = m.score; const st = m.stats;
  const j = m.journey;
  if (j && j.weight && j.weight.direction === 'lose' && st.body && st.body.changeKg <= -1) return 'The month the scale moved';
  if (j && j.weight && j.weight.direction === 'gain' && st.body && st.body.changeKg >= 0.5) return 'The month you built';
  if ((m.prs || []).length >= 2) return 'The month you got stronger';
  if (s.totalDelta != null && s.totalDelta >= 5) return 'The month it clicked';
  if (st.longestStreak >= 10) return 'The month you found your rhythm';
  if (s.totalDelta != null && s.totalDelta <= -5) return 'The month that tested you';
  if (st.activeDays >= 15) return 'The month you kept showing up';
  return 'A fresh chapter starts here';
}

function rulesNarrative(m) {
  const s = m.score; const d = s.totalDelta; const word = m.word;
  const first = m.client.firstName || 'there';
  const best = bestPillar(m);
  const lever = m.lever;

  if (!m.stats.activeDays) {
    const lv = lever ? lowerFirst(lever.label) : 'log one meal and one check-in';
    return {
      headline: clip(`A fresh start. This ${word} is a blank page, and the plan on the last page fills it.`, LIMITS.headline),
      letter: clip(`${first}, nothing was logged this ${word}, and that is okay — this report is your starting line, not a verdict. Next ${word}, just one thing: ${lv}. Small and done beats big and planned. Reply to me any time — I read every message.`, LIMITS.letter),
      chapter: m.type === 'monthly' ? 'A fresh chapter starts here' : '', ps: '', source: 'rules'
    };
  }

  let headline;
  if (d == null) headline = `${s.total} to start. Your baseline is set, and every ${word} from here is measured against it.`;
  else if (d >= 3) headline = `Up ${d} points to ${s.total}${best ? ` — ${best.label.toLowerCase()} led the way` : ''}.`;
  else if (d <= -3) headline = `${s.total} this ${word}, down ${Math.abs(d)}. ${lever ? 'One lever brings it back.' : 'We reset and go again.'}`;
  else headline = `Steady at ${s.total}. ${lever ? `The next points are in ${lever.label.toLowerCase().replace(/^(hit|log|do|walk|sleep|drink|check|land|complete) /, '')}.` : 'Consistency is doing its job.'}`;
  headline = clip(headline, LIMITS.headline);

  const sentences = [];
  if (d == null) sentences.push(`${first}, this is your first ${m.title}: a BodyBank Score of ${s.total} (${s.grade}).`);
  else if (d > 0) sentences.push(`${first}, you moved from ${s.previous.total} to ${s.total} this ${word}, and that is earned, not luck.`);
  else if (d < 0) sentences.push(`${first}, your score is ${s.total} this ${word}, ${Math.abs(d)} below last ${word}, and that is something we can fix together.`);
  else sentences.push(`${first}, you held ${s.total} this ${word} — steady is how lasting change looks.`);
  const ach = (m.achievements || [])[0];
  if (ach) sentences.push(`The highlight: ${lowerFirst(ach.title)}.`);
  else if (best) sentences.push(`${best.label} was your strongest pillar at ${best.score}.`);
  const pat = (m.patterns || [])[0];
  if (pat) sentences.push(`One thing your data shows: ${lowerFirst(pat.text)}`);
  if (lever && lever.points > 0) sentences.push(`Next ${word}, focus on one thing: ${lowerFirst(lever.label)}. It is worth about ${lever.points} points on its own.`);
  sentences.push('Reply to me any time — I read every message.');
  let letter = '';
  for (const sn of sentences) {
    if ((letter + ' ' + sn).trim().length > LIMITS.letter) break;
    letter = (letter + ' ' + sn).trim();
  }
  return { headline, letter, chapter: m.type === 'monthly' ? chapterRule(m) : '', ps: '', source: 'rules' };
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

function factsFor(m) {
  return {
    client_first_name: m.client.firstName,
    report: m.title, period_length: m.word, period: m.period.label, next_period: m.next.label,
    score: m.score.total, grade: m.score.grade, score_change: m.score.totalDelta,
    previous_score: m.score.previous ? m.score.previous.total : null,
    pillars: m.pillars.map((p) => ({ pillar: p.label, score: p.score, grade: p.grade, change: p.delta, counted: p.counted })),
    stats: {
      active_days: m.stats.activeDays, days: m.period.days, longest_streak: m.stats.longestStreak, perfect_days: m.stats.perfectDays,
      workouts_done: m.stats.sessions, workouts_planned: m.stats.planned,
      meals_logged: m.stats.mealsLogged, meals_expected: m.stats.mealsExpected,
      avg_protein_g: m.stats.avgProtein, protein_target_g: m.stats.proteinTarget, protein_days: m.stats.proteinHitDays,
      avg_sleep_h: m.stats.avgSleepH, nights_7h: m.stats.sleepOkDays, avg_steps: m.stats.avgSteps,
      weight_change_kg: m.stats.body ? m.stats.body.changeKg : null
    },
    personal_bests: (m.prs || []).map((p) => `${p.label} ${p.kg} kg (from ${p.previousKg} kg)`),
    achievements: (m.achievements || []).map((a) => a.title),
    patterns: (m.patterns || []).map((p) => p.text),
    promise_check: m.promise ? { kept: m.promise.hit, of: m.promise.of, items: m.promise.items.map((i) => `${i.label}: ${i.actual == null ? 'n/a' : i.actual} of ${i.goal == null ? 'n/a' : i.goal} (${i.status})`) } : null,
    lever: m.lever ? { focus: m.lever.label, worth_points: m.lever.points } : null,
    targets: m.targets.map((t) => t.label),
    projected_score_if_targets_hit: m.projection.projected,
    in_their_words: m.quote || null,
    journey: m.journey ? {
      days_with_bodybank: m.journey.dayN,
      weight_start_kg: m.journey.weight ? m.journey.weight.startKg : null, weight_now_kg: m.journey.weight ? m.journey.weight.nowKg : null,
      weight_change_kg: m.journey.weight ? m.journey.weight.changeKg : null, goal_progress_pct: m.journey.weight ? m.journey.weight.toGoalPct : null,
      waist_change_cm: m.journey.waist ? m.journey.waist.changeCm : null,
      lifts: m.journey.lifts.map((l) => `${l.label} ${l.firstKg} -> ${l.bestKg} kg`)
    } : null,
    week_scores: m.weeks ? m.weeks.map((w) => w.score) : null,
    blood_flagged_for_doctor: m.blood ? m.blood.flagged.length + m.blood.flaggedMore : 0
  };
}

function aiModel() {
  return (process.env.ANTHROPIC_MODEL_REPORTS || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim();
}

async function callModel(facts, m, opts) {
  const apiKey = (opts && opts.apiKey) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const model = aiModel();
  const monthly = m.type === 'monthly';
  const system = [
    SIGNATURE_VOICE,
    `You are ${m.coachName}. This is the client's printed ${m.title} covering one ${m.word}: sentence case, complete sentences. Call the period "this ${m.word}", never "this week" unless it is a week.`,
    'Return JSON only, no markdown, exactly these keys:',
    monthly ? '{"headline":"...","letter":"...","chapter":"..."}' : '{"headline":"...","letter":"..."}',
    `headline: ONE sentence, at most ${LIMITS.headline} characters, the truest single thing about this ${m.word}. It sits under the score on the cover.`,
    `letter: 3–5 sentences, at most ${LIMITS.letter} characters, addressed to the client by first name, not signed. Mention one specific win, one pattern from FACTS.patterns if any, and the lever for next ${m.word}. If FACTS.in_their_words exists, respond to it.`,
    monthly ? `chapter: a title for this month's chapter of their story, at most ${LIMITS.chapter} characters, starting with "The month", no numbers.` : ''
  ].filter(Boolean).join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 25000);
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 900, temperature: 0.5, system, messages: [{ role: 'user', content: 'FACTS:\n' + JSON.stringify(facts) }] }),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
    const text = Array.isArray(data.content) ? data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('') : '';
    return { json: parseJsonLoose(text), usage: data.usage || {}, model };
  } finally {
    clearTimeout(timer);
  }
}

function validate(raw, fallback, factsText, m) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rejected = [];
  const ok = (v, max, min) => {
    const s = str(v);
    if (!s || s.length > max || (min && s.length < min) || MEDICAL_RE.test(s) || !numbersGrounded(s, factsText)) return null;
    return s;
  };
  const headline = ok(r.headline, LIMITS.headline, 12);
  if (!headline) rejected.push('headline');
  const letter = ok(r.letter, LIMITS.letter, 120);
  if (!letter) rejected.push('letter');
  let chapter = '';
  if (m.type === 'monthly') {
    chapter = ok(r.chapter, LIMITS.chapter, 8);
    if (!chapter || /\d/.test(chapter) || !/^the month/i.test(chapter)) { chapter = null; rejected.push('chapter'); }
  }
  return {
    headline: headline || fallback.headline,
    letter: letter || fallback.letter,
    chapter: m.type === 'monthly' ? (chapter || fallback.chapter) : '',
    rejected
  };
}

async function recordUsage(result, opts) {
  try {
    const { recordAiUsage, buildUsage } = require('../aiUsageLedger');
    await recordAiUsage({
      scope: 'admin_reports',
      usage: buildUsage(result.model, result.usage.input_tokens || 0, result.usage.output_tokens || 0),
      userId: opts && opts.userId,
      refType: 'signature_report',
      refId: opts && opts.refId
    });
  } catch (_) { /* the ledger never blocks a report */ }
}

/**
 * @param m     model.buildModel() output
 * @param opts  { ai: boolean (default true), apiKey, fetchImpl, userId, refId, timeoutMs }
 */
async function buildNarrative(m, opts) {
  const o = opts || {};
  const fallback = rulesNarrative(m);
  if (o.ai === false) return Object.assign({}, fallback, { aiError: null, aiRejected: [] });
  try {
    const facts = factsFor(m);
    const res = await callModel(facts, m, o);
    recordUsage(res, o);
    if (!res.json) throw new Error('model returned no JSON');
    const v = validate(res.json, fallback, JSON.stringify(facts), m);
    const allRejected = v.rejected.length >= (m.type === 'monthly' ? 3 : 2);
    return { headline: v.headline, letter: v.letter, chapter: v.chapter, ps: '', source: allRejected ? 'rules' : 'ai', aiError: null, aiRejected: v.rejected };
  } catch (err) {
    return Object.assign({}, fallback, { aiError: String((err && err.message) || err).slice(0, 200), aiRejected: [] });
  }
}

/** Admin edits over the draft: length limits only (the coach may add facts). */
function applyEdits(narrative, edits) {
  const e = edits && typeof edits === 'object' ? edits : {};
  const out = Object.assign({}, narrative);
  const txt = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').replace(/\s*\n\s*/g, ' ').trim().slice(0, max) : null);
  for (const [k, max] of [['headline', LIMITS.headline], ['letter', LIMITS.letter], ['chapter', LIMITS.chapter], ['ps', LIMITS.ps]]) {
    if (e[k] == null) continue;
    const v = txt(e[k], max);
    if (v != null && (v || k === 'ps')) out[k] = v;
  }
  return out;
}

/**
 * Admin edits to the three targets. A target keeps its metric (so next period's
 * promise check can still score it); the coach can change the number and the
 * wording, or turn it into a free-text target (metric: null, scored by hand).
 */
function applyTargetEdits(targets, edits, model) {
  if (!Array.isArray(edits)) return targets;
  const M = require('./model').METRICS;
  return targets.map((t, i) => {
    const e = edits[i];
    if (!e || typeof e !== 'object') return t;
    const out = Object.assign({}, t);
    if (e.custom) {
      const label = clip(e.label, LIMITS.target);
      if (label) return { id: t.id, metric: null, value: null, unit: '', label, short: 'Coach target', baseline: null, baselineOf: null, points: null, hold: false, custom: true };
      return t;
    }
    const v = Number(e.value);
    if (Number.isFinite(v) && v >= 1 && v <= 999 && t.metric && M[t.metric]) {
      out.value = Math.round(v);
      out.label = M[t.metric].label(out.value, { pillars: model && model.score && model.score.pillars, period: model && model.period });
    }
    // The UI sends `label` only when the coach rewrote the wording; it wins over
    // the generated label (the metric and number are kept for the promise check).
    if (typeof e.label === 'string' && e.label.trim()) out.label = clip(e.label, LIMITS.target);
    return out;
  });
}

module.exports = { buildNarrative, rulesNarrative, applyEdits, applyTargetEdits, factsFor, LIMITS, SIGNATURE_VOICE };
