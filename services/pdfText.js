'use strict';

/**
 * BodyBank — WinAnsi-safe text for PDFKit.
 *
 * PDFKit's built-in Helvetica is WinAnsi-only. Anything outside that encoding is
 * emitted as a raw low byte, which is how "→" printed as "!’" in production reports
 * for months. Every string handed to PDFKit must pass through `txt()` first.
 *
 * This module exists so the graded report, and the editor preview that has to match
 * it character for character, read from one table instead of two that drift apart.
 * The existing health and progress PDF generators keep their own copies; they are
 * deliberately not touched by the graded-report work.
 */

const UNI_MAP = {
  // arrows
  '→': '->', '⟶': '->', '➔': '->', '➜': '->', '⇒': '=>',
  '←': '<-', '⟵': '<-', '⇐': '<=', '↔': '<->', '↑': '^', '↓': 'v',
  // maths / comparison
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '≡': '=',
  '−': '-', '­': '-', '‐': '-', '‑': '-', '–': '-', '⁄': '/',
  '∞': 'infinity',
  // units commonly printed on Indian lab reports
  'μ': 'µ', '₹': 'Rs.', '′': "'", '″': '"',
  // superscripts not present in WinAnsi (x10^9/L, mL/min/1.73m²)
  '⁰': '^0', '¹': '^1', '²': '2', '³': '3', '⁴': '^4', '⁵': '^5',
  '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9', '⁺': '^+', '⁻': '^-', 'ⁿ': '^n',
  // subscripts
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  // marks a reviewer might paste from a word processor
  '✓': '*', '✔': '*', '✗': 'x', '✘': 'x', '▲': '^', '▼': 'v',
  '●': '•', '▪': '•', '■': '•', '★': '*', '☆': '*', '⁃': '-',
  '─': '-', '═': '=', '·': '·',
  // spaces that would otherwise vanish or break measurement
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
  '​': '', '‌': '', '‍': '', '﻿': ''
};

/**
 * The 0x80–0x9F slots of WinAnsi hold these Unicode characters; everything else the
 * encoding supports is Latin-1 (0x20–0x7E, 0xA0–0xFF).
 */
const WINANSI_HIGH = new Set([
  '€', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ',
  '‰', 'Š', '‹', 'Œ', 'Ž', '‘', '’', '“',
  '”', '•', '–', '—', '˜', '™', 'š', '›',
  'œ', 'ž', 'Ÿ'
]);

function winAnsiSafe(input) {
  const s = String(input);
  // Fast path: plain ASCII, which is most of every report.
  if (!/[^\n\t\x20-\x7E]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(UNI_MAP, ch)) { out += UNI_MAP[ch]; continue; }
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t') { out += ch; continue; }
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) { out += ch; continue; }
    if (WINANSI_HIGH.has(ch)) { out += ch; continue; }
    // Strip combining marks outright; drop anything else we cannot represent rather
    // than emitting the mojibake byte PDFKit would otherwise write.
    if (cp >= 0x0300 && cp <= 0x036f) continue;
  }
  return out;
}

/** Every string handed to PDFKit goes through here. */
function txt(v) { return winAnsiSafe(v == null ? '' : v); }
function hasText(v) { return !!txt(v).trim(); }

module.exports = { UNI_MAP, WINANSI_HIGH, winAnsiSafe, txt, hasText };
