'use strict';

/**
 * Deterministic guardrails applied to every generated message *before* it reaches a
 * user. Catches "AI slop" and repetition without asking the model to police itself.
 * Pure functions — unit-tested.
 */

// Openers/phrases that read as robotic. Configurable; keep lowercase.
const BANNED_PHRASES = [
  'i hope this message finds you',
  'i hope this finds you well',
  'as an ai',
  "as your ai coach",
  'i am an ai',
  'in conclusion',
  'in summary,',
  'furthermore,',
  'it is important to note',
  'i wanted to reach out',
  'i just wanted to check in to say',
  'delve into',
  'as a language model'
];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** Jaccard similarity over word sets — cheap, good enough to catch near-duplicates. */
function similarity(a, b) {
  const A = new Set(normalize(a).split(' ').filter(Boolean));
  const B = new Set(normalize(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * @param {string} text                 candidate message
 * @param {object} opts
 *   maxWords (default 110), minWords (default 4)
 *   recentMessages (string[])  last N coach messages, for anti-repeat
 *   similarityThreshold (default 0.6)
 * @returns {{ ok:boolean, reasons:string[], text:string }}
 */
function checkMessage(text, opts = {}) {
  const reasons = [];
  const cleaned = String(text || '').trim();
  const maxWords = opts.maxWords || 110;
  const minWords = opts.minWords || 4;
  const simThreshold = opts.similarityThreshold || 0.6;

  if (!cleaned) reasons.push('empty');

  const wc = wordCount(cleaned);
  if (wc && wc < minWords) reasons.push('too_short');
  if (wc > maxWords) reasons.push('too_long');

  const norm = normalize(cleaned);
  for (const phrase of BANNED_PHRASES) {
    if (norm.includes(normalize(phrase))) {
      reasons.push('banned_phrase:' + phrase);
      break;
    }
  }

  const recent = Array.isArray(opts.recentMessages) ? opts.recentMessages : [];
  for (const prev of recent) {
    if (similarity(cleaned, prev) >= simThreshold) {
      reasons.push('too_similar');
      break;
    }
  }

  return { ok: reasons.length === 0, reasons, text: cleaned };
}

module.exports = { checkMessage, similarity, wordCount, normalize, BANNED_PHRASES };
