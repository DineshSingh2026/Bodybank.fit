'use strict';

/**
 * BodyBank.fit — Blood Report PROGRESS / COMPARISON report (pure Node, PDFKit).
 *
 * Same dark-green brand system + gold coin as the single-report health PDF, but
 * built around the trajectory: a marker-trend table (one column per test date),
 * improvements vs concerns, and updated recommendations.
 *
 * This renderer draws a **document** (see services/comparisonDocument.js) rather
 * than the raw comparison + AI verdict. The document is an ordered list of
 * sections that the reviewing doctor can edit in the app before printing, so the
 * printout is exactly what they approved — nothing is re-derived here.
 */

const path = require('path');
const fs = require('fs');
const { buildComparisonDoc, sanitizeComparisonDoc } = require('./comparisonDocument');
const PL = require('./pdfLayout');

const C = {
  BG: '#0d0f11', SURFACE: '#161a1e', SURFACE2: '#1e2328', GREEN: '#3dd68c',
  AMBER: '#f5a623', BLUE: '#4da6ff', RED: '#ff5c5c', TEXT: '#f0ede8',
  MUTED: '#8a8880', WHITE: '#ffffff', DARK: '#1a1f24', BORDER: '#2a2f35',
  INC_BG: '#1a2e1a', AVD_BG: '#2e1a1a', WATCH_BG: '#2a2410', PURPLE: '#a855f7',
  DISC_BG: '#141414', GOLD: '#e6c46a', GOLD_DIM: '#c8a44e'
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 51;
const CW = PAGE_W - 2 * M;
const TOP = 70;
const BOTTOM = 782;

function resolveLogo() {
  const dir = path.join(__dirname, '..', 'public', 'img');
  const candidates = ['bodybank-logo.png - short.png', 'bodybank-logo-short.png', 'logo-bb.png', 'Bodybank logo.png'];
  for (const f of candidates) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}
const LOGO = resolveLogo();

function visible(list) { return (Array.isArray(list) ? list : []).filter((x) => x && x.show !== false); }

// --------------------------------------------------------------------------
// WinAnsi safety
// --------------------------------------------------------------------------
// PDFKit's built-in Helvetica is a WinAnsi font: give it a character outside that
// encoding and it writes the raw low byte, so "→" printed as "!’". That already
// affected the from→to arrows, and now that a reviewer types free text into this
// report it matters much more — a pasted "≥", "µg" or "₹" must not turn to noise.
// So every string is transliterated into WinAnsi before it reaches the page.
const UNI_MAP = {
  // arrows
  '→': '->', '⟶': '->', '➔': '->', '➜': '->', '⇒': '=>',
  '←': '<-', '⟵': '<-', '⇐': '<=', '↔': '<->', '↑': '^', '↓': 'v',
  // maths / comparison
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '≡': '=',
  '−': '-', '­': '-', '‐': '-', '‑': '-', '⁄': '/',
  '∞': 'infinity', '±': '±',
  // units commonly printed on Indian lab reports
  'μ': 'µ', '₹': 'Rs.', '′': "'", '″': '"',
  // superscripts not present in WinAnsi (x10^9/L and friends)
  '⁰': '^0', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7',
  '⁸': '^8', '⁹': '^9', '⁺': '^+', '⁻': '^-', 'ⁿ': '^n',
  // subscripts
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  // marks a reviewer might paste from a word processor
  '✓': '*', '✔': '*', '✗': 'x', '✘': 'x', '▲': '^', '▼': 'v',
  '●': '•', '▪': '•', '★': '*', '☆': '*', '⁃': '-',
  // spaces that would otherwise vanish or break measurement
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
  '​': '', '‌': '', '‍': '', '﻿': ''
};

// The 0x80–0x9F slots of WinAnsi hold these Unicode characters; everything else the
// encoding supports is Latin-1 (0x20–0x7E, 0xA0–0xFF).
const WINANSI_HIGH = new Set([
  '€', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ',
  '‰', 'Š', '‹', 'Œ', 'Ž', '‘', '’', '“',
  '”', '•', '–', '—', '˜', '™', 'š', '›',
  'œ', 'ž', 'Ÿ'
]);

function winAnsiSafe(input) {
  const s = String(input);
  // Fast path: plain ASCII, which is the overwhelming majority of every report.
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

function trajColor(t) {
  if (t === 'improving') return C.GREEN;
  if (t === 'worsening') return C.RED;
  if (t === 'changed') return C.BLUE;
  return C.MUTED;
}
function levelColor(l) {
  if (l === 'High') return C.RED;
  if (l === 'Medium') return C.AMBER;
  return C.GREEN;
}
function statColor(tone) {
  if (tone === 'green') return C.GREEN;
  if (tone === 'red') return C.RED;
  if (tone === 'amber') return C.AMBER;
  if (tone === 'gold') return C.GOLD;
  return C.BLUE;
}
function statusColorLite(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'normal' || s === 'optimal') return C.GREEN;
  if (s === 'critical' || s === 'high' || s === 'deficient' || s === 'elevated') return C.RED;
  if (!s) return C.TEXT;
  return C.AMBER;
}
function supplActionColor(a) {
  const s = String(a || '').toLowerCase();
  if (s === 'stop') return C.RED;
  if (s === 'start') return C.GREEN;
  if (s === 'adjust') return C.AMBER;
  return C.TEXT;
}
// tone -> the box treatment used by callout sections
function calloutTone(tone) {
  if (tone === 'gold') return { border: C.GOLD_DIM, bg: C.DARK, lw: 0.6, accent: C.GOLD };
  if (tone === 'amber') return { border: C.AMBER, bg: C.SURFACE, lw: 1, accent: C.AMBER };
  if (tone === 'red') return { border: C.RED, bg: C.SURFACE, lw: 1, accent: C.RED };
  if (tone === 'blue') return { border: C.BLUE, bg: C.SURFACE, lw: 1, accent: C.BLUE };
  return { border: C.GREEN, bg: C.SURFACE, lw: 1, accent: C.GREEN };
}
function cardTone(tone) {
  if (tone === 'bad') return { bg: C.AVD_BG, border: C.RED };
  if (tone === 'watch') return { bg: C.WATCH_BG, border: C.AMBER };
  return { bg: C.INC_BG, border: C.GREEN };
}

// glyphs (WinAnsi-safe, drawn)
function gUp(doc, cx, cy, s, color) { doc.save().fillColor(color).moveTo(cx - s / 2, cy + s / 2).lineTo(cx + s / 2, cy + s / 2).lineTo(cx, cy - s / 2).fill().restore(); }
function gDown(doc, cx, cy, s, color) { doc.save().fillColor(color).moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy - s / 2).lineTo(cx, cy + s / 2).fill().restore(); }
function gDash(doc, cx, cy, s, color) { doc.save().strokeColor(color).lineWidth(1.6).lineCap('round').moveTo(cx - s / 2, cy).lineTo(cx + s / 2, cy).stroke().restore(); }

/**
 * Render a progress report to `outPath`.
 *
 * @param {object} payload either `{ doc }` (the edited document) or the legacy
 *   `{ user, comparison, verdict, adminNotes }` shape, which is converted to a
 *   default document first so old callers keep working.
 * @param {string} outPath
 * @returns {Promise<string>} outPath
 */
function buildComparisonReportPdf(payload, outPath) {
  const PDFDocument = require('pdfkit');
  const document = resolvePayloadDoc(payload);
  const cover = document.cover || {};
  const sections = visible(document.sections);
  const name = txt((cover.fields && cover.fields.patientName) || (payload && payload.user && payload.user.name) || 'Member');
  const dateStr = txt((cover.fields && cover.fields.reportDate) || '');

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);
  paintBg(doc);

  // The flow owns pagination: it paints the background of every page and
  // records which pages carry content, including any page PDFKit opens itself.
  const ctx = PL.createFlow(doc, {
    top: TOP, bottom: BOTTOM, left: M, width: CW,
    claimFirstPage: false,
    onPage: (d) => paintBg(d)
  });
  ctx.contentPages = ctx.pages;
  ctx.coverDrawn = false;
  ctx.anyContent = false;

  if (cover.show !== false) {
    buildCover(ctx, cover);
    ctx.coverDrawn = true;
  }

  sections.forEach((section) => {
    beginSection(ctx, !!section.pageBreak);
    renderSection(ctx, section);
  });

  // A document with everything switched off would otherwise emit a blank page.
  if (!ctx.anyContent && !ctx.coverDrawn) {
    beginSection(ctx, false);
    PL.drawFit(ctx.doc, 'This report has no visible sections.', M, ctx.y, CW,
      { font: 'Helvetica-Oblique', size: 11, color: C.MUTED });
  }

  paintChrome(doc, name, dateStr, ctx.contentPages);

  return new Promise((resolve, reject) => {
    doc.end();
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

/** Accept an edited document, or build the default one from raw comparison data. */
function resolvePayloadDoc(payload) {
  const p = payload || {};
  if (p.doc && typeof p.doc === 'object') return sanitizeComparisonDoc(p.doc);
  return buildComparisonDoc({
    comparison: p.comparison,
    verdict: p.verdict,
    adminNotes: p.adminNotes,
    user: p.user
  });
}

// ---- section dispatch ---------------------------------------------------------
function renderSection(ctx, section) {
  switch (section.type) {
    case 'trend': return buildTrendSection(ctx, section);
    case 'text': return buildTextSection(ctx, section);
    case 'cards': return buildCardsSection(ctx, section);
    case 'table': return buildTableSection(ctx, section);
    case 'callout': return buildCalloutSection(ctx, section);
    case 'disclaimer': return buildDisclaimerSection(ctx, section);
    default: return undefined;
  }
}

// ---- chrome ------------------------------------------------------------------
function paintBg(doc) {
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.BG);
  doc.rect(0, 0, PAGE_W, 2).fill(C.GREEN);
  doc.restore();
}
function newPage(ctx) {
  ctx.newPage();
}
/** Break only when the current page already carries content. */
function ensure(ctx, need) {
  return ctx.ensure(need);
}
/**
 * Open the space a section will render into. The first content section either
 * adopts page 1 (when the cover is switched off) or starts a fresh page; later
 * sections start a new page only when they ask for one or genuinely run out of room.
 */
function beginSection(ctx, pageBreak) {
  if (!ctx.anyContent) {
    if (ctx.coverDrawn) {
      newPage(ctx);
    } else {
      ctx.contentPages.add(0);
      ctx.y = TOP;
    }
    ctx.anyContent = true;
    return;
  }
  if (pageBreak) newPage(ctx);
  else ensure(ctx, 90);
}
function paintChrome(doc, name, dateStr, contentPages) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i += 1) {
    if (!contentPages.has(i)) continue;
    doc.switchToPage(i);
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GREEN);
    const wm = 'BodyBank.fit';
    const tw = doc.widthOfString(wm);
    PL.drawSingle(doc, wm, PAGE_W - M - tw, 27, 0, {});
    if (LOGO) { try { doc.image(LOGO, PAGE_W - M - tw - 20, 23, { width: 15, height: 15 }); } catch (_) {} }
    doc.rect(0, PAGE_H - 46, PAGE_W, 46).fill(C.SURFACE);
    doc.rect(M, PAGE_H - 46, CW, 0.4).fill(C.BORDER);
    // Fitted, so a long patient name shortens instead of wrapping below the
    // edge of the paper — which is what `{ width, lineBreak: false }` did.
    const right = `${dateStr}  ·  Page ${i + 1} of ${total}`;
    doc.font('Helvetica').fontSize(8);
    const rightW = Math.min(CW * 0.5, doc.widthOfString(right));
    PL.drawFit(doc, right, M + CW - rightW, PAGE_H - 26, rightW, { font: 'Helvetica', size: 8, color: C.MUTED, align: 'right' });
    PL.drawFit(doc, `BodyBank.fit  ·  Progress Report  ·  ${name}`, M, PAGE_H - 26, CW - rightW - 16,
      { font: 'Helvetica', size: 8, color: C.MUTED });
    doc.restore();
  }
}

// ---- primitives --------------------------------------------------------------
function box(doc, x, y, w, h, fill, stroke, lw) {
  doc.save();
  if (fill) doc.rect(x, y, w, h).fill(fill);
  if (stroke) { doc.lineWidth(lw || 0.5).rect(x, y, w, h).stroke(stroke); }
  doc.restore();
}
function hr(ctx, color, thickness) {
  ctx.doc.save().rect(M, ctx.y, CW, thickness || 1).fill(color || C.BORDER).restore();
  ctx.y += (thickness || 1) + 6;
}
function heading(ctx, text, ruleColor) {
  if (!hasText(text)) return;
  const L = PL.layout(ctx.doc, text, { font: 'Helvetica-Bold', size: 15, width: CW });
  ensure(ctx, L.height + 32);
  PL.drawLayout(ctx.doc, L, M, ctx.y, { color: C.GREEN });
  ctx.advance(Math.max(22, L.height + 4));
  hr(ctx, ruleColor || C.GREEN, 1);
  ctx.advance(4);
}
function subheading(ctx, text) {
  if (!hasText(text)) return;
  const L = PL.layout(ctx.doc, text, { font: 'Helvetica-Bold', size: 12, width: CW });
  ensure(ctx, L.height + 26);
  PL.drawLayout(ctx.doc, L, M, ctx.y, { color: C.WHITE });
  ctx.advance(Math.max(18, L.height + 4));
}
/** Flowing prose, paginated by the flow rather than by PDFKit. */
function bodyText(ctx, text, opts) {
  opts = opts || {};
  PL.flowText(ctx, text, {
    x: M,
    width: opts.width || CW,
    font: opts.oblique ? 'Helvetica-Oblique' : 'Helvetica',
    size: opts.size || 10,
    align: opts.align || 'left',
    lineGap: 3,
    color: opts.color || C.TEXT,
    spaceAfter: opts.spaceAfter != null ? opts.spaceAfter : 6
  });
}

// ---- cover -------------------------------------------------------------------
function buildCover(ctx, cover) {
  const doc = ctx.doc;
  const fields = cover.fields || {};
  let y = 128;
  if (LOGO) {
    try {
      doc.image(LOGO, M, y, { fit: [58, 58], align: 'left' });
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.GOLD).text('BODYBANK', M + 70, y + 8, { lineBreak: false });
      doc.font('Helvetica').fontSize(11).fillColor(C.GOLD_DIM).text('.FIT   ·   AI HEALTH INTELLIGENCE', M + 70, y + 34, { lineBreak: false, characterSpacing: 1 });
    } catch (_) {
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.GOLD).text('BODYBANK.FIT', M, y + 8, { lineBreak: false });
    }
    y += 84;
  } else {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.GOLD).text('BODYBANK.FIT', M, y, { lineBreak: false });
    y += 50;
  }

  y += PL.drawText(doc, cover.brandTitle || 'Blood Report Progress Review', M, y,
    { font: 'Helvetica-Bold', size: 26, width: CW, color: C.WHITE }) + 4;
  if (hasText(cover.brandSubtitle)) {
    y += PL.drawText(doc, cover.brandSubtitle, M, y, { font: 'Helvetica', size: 13, width: CW, color: C.MUTED });
  }
  y += 20;
  doc.save().rect(M, y, CW, 1).fill(C.GREEN).restore();
  y += 12;

  // ---- patient + tests-compared card --------------------------------------
  // Measured first, drawn second: the card grows to hold a long name or goal
  // instead of letting either run through the row beneath it and out of the
  // bottom border.
  if (cover.showFields !== false) {
    const col = CW / 3;
    const valW = col - 20;
    const cellOf = (labelText, value, color, size) => ({
      label: labelText,
      L: PL.layout(doc, value, {
        font: size >= 14 ? 'Helvetica-Bold' : 'Helvetica', size, width: valW, maxLines: 2
      }),
      color
    });
    const row1 = [
      cellOf('Patient Name', fields.patientName || '—', C.WHITE, 14),
      cellOf('Report Date', fields.reportDate || '—', C.WHITE, 14),
      cellOf('Report Type', fields.reportType || '—', C.GREEN, 14)
    ];
    const row2 = [
      cellOf('Age / Gender', fields.ageGender || '—', C.TEXT, 11),
      cellOf('Fitness Goal', fields.goal || '—', C.TEXT, 11),
      cellOf('Tests Compared', fields.testsCompared || '—', C.MUTED, 9)
    ];
    const rowH = (r) => 14 + r.reduce((m, c) => Math.max(m, c.L.height), 0);
    const r1H = rowH(row1);
    const r2H = rowH(row2);
    const cardH = Math.max(118, 12 + r1H + 16 + r2H + 14);
    box(doc, M, y, CW, cardH, C.DARK, C.BORDER, 0.5);
    const drawRow = (r, top) => r.forEach((c, i) => {
      const x = M + 14 + i * col;
      PL.drawFit(doc, String(c.label).toUpperCase(), x, top, valW, { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
      PL.drawLayout(doc, c.L, x, top + 14, { color: c.color });
    });
    drawRow(row1, y + 12);
    drawRow(row2, y + 12 + r1H + 16);
    y += cardH + 10;
  }

  // trajectory banner
  const traj = cover.trajectory || {};
  if (traj.show !== false && (hasText(traj.label) || hasText(traj.summary))) {
    const label = txt(traj.label || '—');
    const tc = /improv/i.test(label) ? C.GREEN : (/worsen/i.test(label) ? C.RED : (/stable/i.test(label) ? C.BLUE : C.AMBER));
    const summaryText = txt(traj.summary);
    const sumX = M + CW * 0.32;
    const sumW = CW * 0.65;
    // The cover is a single page by design, so the summary is capped to the
    // room that is left on it.
    const sumL = summaryText
      ? PL.layout(doc, summaryText, { font: 'Helvetica', size: 10, width: sumW, lineGap: 2, maxHeight: Math.max(30, BOTTOM - y - 100) })
      : null;
    const bH = Math.max(78, (sumL ? sumL.height : 0) + 30);
    box(doc, M, y, CW, bH, C.SURFACE, tc, 1);
    const leftCy = y + bH / 2;
    PL.drawFit(doc, 'OVERALL TRAJECTORY', M + 14, leftCy - 20, CW * 0.3 - 18, { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
    PL.drawFit(doc, label, M + 14, leftCy - 6, CW * 0.3 - 14, { font: 'Helvetica-Bold', size: 19, minSize: 8, color: tc });
    if (sumL) PL.drawLayout(doc, sumL, sumX, y + 15, { color: C.TEXT });
    y += bH + 12;
  }

  // quick stat chips
  const stats = cover.stats || {};
  const chips = stats.show === false ? [] : visible(stats.items).filter((s) => hasText(s.value));
  if (chips.length) {
    const cw = (CW - (chips.length - 1) * 10) / chips.length;
    chips.forEach((c, i) => {
      const x = M + i * (cw + 10);
      box(doc, x, y, cw, 46, C.DARK, C.BORDER, 0.4);
      PL.drawFit(doc, c.value, x + 12, y + 8, cw - 24, { font: 'Helvetica-Bold', size: 18, minSize: 8, color: statColor(c.tone) });
      PL.drawFit(doc, txt(c.label).toUpperCase(), x + 12, y + 30, cw - 24, { font: 'Helvetica-Bold', size: 7.5, minSize: 5.5, color: C.MUTED });
    });
    y += 46 + 10;
  }

  const footnote = cover.footnote || {};
  if (footnote.show !== false && hasText(footnote.text)) {
    doc.save().rect(M, y, CW, 0.5).fill(C.BORDER).restore();
    y += 8;
    PL.drawText(doc, footnote.text, M, y, {
      font: 'Helvetica-Oblique', size: 8.5, width: CW, align: 'justify', lineGap: 2, color: C.MUTED,
      maxHeight: Math.max(12, BOTTOM - y)
    });
  }
}

// ---- trend table -------------------------------------------------------------
function buildTrendSection(ctx, section) {
  const doc = ctx.doc;
  const dateCols = (section.columns || []).map((c, i) => ({ col: c, index: i })).filter((x) => x.col && x.col.show !== false);
  const panels = visible(section.panels)
    .map((p) => ({ name: p.name, markers: visible(p.markers) }))
    .filter((p) => p.markers.length);
  if (!panels.length) return;

  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  if (hasText(section.intro)) {
    bodyText(ctx, section.intro, { color: C.MUTED, size: 9 });
    ctx.y += 4;
  }

  // layout: Marker (fixed) | Ref (fixed) | one column per visible date | Trend (fixed)
  const nCols = dateCols.length;
  const markerFrac = 0.26;
  const refFrac = 0.16;
  const trendFrac = 0.12;
  const dateFrac = Math.max(0.08, (1 - markerFrac - refFrac - trendFrac) / Math.max(1, nCols));
  const pad = 8;

  const cols = [];
  cols.push({ w: markerFrac * CW, header: 'Marker', kind: 'marker' });
  cols.push({ w: refFrac * CW, header: 'Reference', kind: 'ref' });
  dateCols.forEach((x) => cols.push({ w: dateFrac * CW, header: txt(x.col.label), kind: 'date', valueIndex: x.index }));
  cols.push({ w: trendFrac * CW, header: 'Trend', kind: 'trend' });
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const scale = CW / totalW;
  cols.forEach((c) => { c.w *= scale; });
  const xs = [];
  let acc = M;
  cols.forEach((c) => { xs.push(acc); acc += c.w; });

  const headerH = 26;
  const drawHeader = () => {
    box(doc, M, ctx.y, CW, headerH, C.SURFACE2);
    cols.forEach((c, i) => {
      PL.drawFit(doc, String(c.header).toUpperCase(), xs[i] + pad, ctx.y + 9, c.w - 2 * pad,
        { font: 'Helvetica-Bold', size: 7.5, minSize: 5.5, color: c.kind === 'date' ? C.GREEN : C.MUTED });
    });
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.advance(headerH);
  };

  panels.forEach((panel) => {
    ensure(ctx, 60);
    ctx.advance(4);
    subheading(ctx, panel.name);
    drawHeader();
    panel.markers.forEach((m, ri) => {
      // The marker name is the only wrapping cell, and the row is sized from
      // its measured layout; the reference, the values and the trend are all
      // fitted to their narrow columns so they cannot bleed into each other.
      const maxRowH = ctx.pageHeight() - headerH - 2;
      const nameL = PL.layout(doc, m.name, {
        font: 'Helvetica-Bold', size: 9, width: cols[0].w - 2 * pad, maxHeight: maxRowH - 12
      });
      const rowH = Math.min(maxRowH, Math.max(22, nameL.height + 12));
      if (ctx.y + rowH > BOTTOM && !ctx.isFresh()) { newPage(ctx); drawHeader(); }
      box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
      const cy = ctx.y + rowH / 2;
      cols.forEach((c, i) => {
        const x = xs[i] + pad;
        const w = c.w - 2 * pad;
        if (c.kind === 'marker') {
          PL.drawLayout(doc, nameL, x, cy - nameL.height / 2, { color: C.TEXT });
        } else if (c.kind === 'ref') {
          PL.drawFit(doc, txt(m.reference) || '—', x, cy - 5, w, { font: 'Helvetica', size: 8, minSize: 5.5, color: C.MUTED });
        } else if (c.kind === 'date') {
          const cell = (m.values || [])[c.valueIndex];
          if (cell && hasText(cell.text)) {
            PL.drawFit(doc, cell.text, x, cy - 6, w, { font: 'Helvetica-Bold', size: 9, minSize: 5.5, color: statusColorLite(cell.status) });
          } else {
            PL.drawFit(doc, '—', x, cy - 6, w, { font: 'Helvetica', size: 9, color: C.MUTED });
          }
        } else if (c.kind === 'trend') {
          drawTrend(doc, m.trend || {}, xs[i], ctx.y, c.w, rowH);
        }
      });
      doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
      ctx.advance(rowH);
    });
    ctx.advance(10);
  });
}

function drawTrend(doc, trend, x0, y0, w, h) {
  const cx = x0 + 14;
  const cy = y0 + h / 2;
  // Colour carries the CLINICAL meaning (improving/worsening/stable); the arrow
  // direction reflects the raw numeric move (up/down). WinAnsi-safe vector glyphs.
  const col = trajColor(trend.dir);
  if (trend.arrow === 'up') gUp(doc, cx, cy, 7, col);
  else if (trend.arrow === 'down') gDown(doc, cx, cy, 7, col);
  else gDash(doc, cx, cy, 8, col);
  if (hasText(trend.text)) {
    PL.drawFit(doc, trend.text, cx + 8, cy - 4, Math.max(0, x0 + w - (cx + 8) - 6),
      { font: 'Helvetica-Bold', size: 7.5, minSize: 5.5, color: col });
  }
}

// ---- prose -------------------------------------------------------------------
function buildTextSection(ctx, section) {
  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  const badge = section.badge || {};
  if (badge.show && (hasText(badge.label) || hasText(badge.text))) {
    const doc = ctx.doc;
    ensure(ctx, 50);
    const labelText = txt(badge.label || '').toUpperCase();
    doc.font('Helvetica-Bold').fontSize(8);
    // The label may not take more than a third of the badge, so there is always
    // room left for the verdict beside it.
    const labelW = labelText ? Math.min(CW * 0.34, Math.max(70, doc.widthOfString(labelText) + 16)) : 0;
    box(doc, M, ctx.y, CW, 30, C.SURFACE, C.GREEN, 0.5);
    if (labelText) PL.drawFit(doc, labelText, M + 12, ctx.y + 6, labelW - 12, { font: 'Helvetica-Bold', size: 8, minSize: 6, color: C.MUTED });
    PL.drawFit(doc, badge.text, M + 12 + labelW, ctx.y + 9, CW - 24 - labelW,
      { font: 'Helvetica-Bold', size: 11, minSize: 7, color: C.GREEN });
    ctx.advance(30 + 10);
  }
  if (hasText(section.body)) bodyText(ctx, section.body, { align: section.align === 'left' ? 'left' : 'justify' });
}

// ---- improvements / concerns -------------------------------------------------
function changeCard(ctx, item, tone) {
  const doc = ctx.doc;
  const t = cardTone(tone);
  const from = txt(item.from);
  const to = txt(item.to);
  const arrow = txt(from && to ? `${from}  →  ${to}` : (to || from || ''));
  const meaning = txt(item.meaning);
  const title = txt(item.marker);
  // The card is built from measured parts: a marker name that needs two lines
  // gets them, and the card grows rather than the title running over the arrow.
  const titleL = PL.layout(doc, title, { font: 'Helvetica-Bold', size: 10, width: CW - 90, maxLines: 2 });
  const meaningL = meaning
    ? PL.layout(doc, meaning, { font: 'Helvetica', size: 9.5, width: CW - 28, lineGap: 2, maxHeight: ctx.pageHeight() - 60 })
    : null;
  const h = Math.max(38, 10 + titleL.height + 4 + (arrow ? 14 : 0) + (meaningL ? meaningL.height : 0) + 12);
  ensure(ctx, h + 6);
  box(doc, M, ctx.y, CW, h, t.bg, t.border, 0.5);
  doc.save().rect(M, ctx.y, 3, h).fill(t.border).restore();
  const topY = ctx.y + 10;
  PL.drawLayout(doc, titleL, M + 14, topY, { color: C.TEXT });
  if (item.level) {
    PL.drawFit(doc, String(item.level).toUpperCase(), M + CW - 74, topY, 60,
      { font: 'Helvetica-Bold', size: 8, minSize: 6, color: levelColor(item.level), align: 'right' });
  }
  let y = topY + titleL.height + 4;
  if (arrow) {
    PL.drawFit(doc, arrow, M + 14, y, CW - 28, { font: 'Helvetica-Bold', size: 9, minSize: 6.5, color: t.border });
    y += 14;
  }
  if (meaningL) PL.drawLayout(doc, meaningL, M + 14, y, { color: C.MUTED });
  ctx.advance(h + 6);
}

function buildCardsSection(ctx, section) {
  const groups = visible(section.groups)
    .map((g) => ({ title: g.title, tone: g.tone, items: visible(g.items) }))
    .filter((g) => g.items.length);
  if (!groups.length) return;
  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  groups.forEach((g, gi) => {
    if (gi > 0) ensure(ctx, 70);
    if (hasText(g.title)) { subheading(ctx, g.title); ctx.advance(2); }
    g.items.forEach((it) => changeCard(ctx, it, g.tone));
    ctx.advance(6);
  });
}

// ---- generic table -----------------------------------------------------------
function cellStyle(style, value) {
  if (style === 'accent') return { color: C.BLUE, bold: true, size: 9.5 };
  if (style === 'strong') return { color: C.TEXT, bold: true, size: 9.5 };
  if (style === 'muted') return { color: C.MUTED, bold: false, size: 9 };
  if (style === 'warn') return { color: C.AMBER, bold: true, size: 9.5 };
  if (style === 'action') return { color: supplActionColor(value), bold: true, size: 9.5 };
  return { color: C.TEXT, bold: false, size: 9.5 };
}

function buildTableSection(ctx, section) {
  const doc = ctx.doc;
  const columns = visible(section.columns);
  const rows = visible(section.rows);
  if (!columns.length || !rows.length) return;

  heading(ctx, section.title);
  ensure(ctx, 80);
  subheading(ctx, section.subtitle);

  // Hiding a column frees its share of the width — renormalise so the table still
  // spans the full content column.
  const totalFrac = columns.reduce((s, c) => s + (Number(c.width) || 0.25), 0) || 1;
  const widths = columns.map((c) => ((Number(c.width) || 0.25) / totalFrac) * CW);
  const xs = [];
  let acc = M;
  widths.forEach((w) => { xs.push(acc); acc += w; });
  const pad = 9;
  const headerH = 24;

  const drawHeader = () => {
    box(doc, M, ctx.y, CW, headerH, C.SURFACE2);
    columns.forEach((c, i) => PL.drawFit(doc, txt(c.header).toUpperCase(), xs[i] + pad, ctx.y + 8, widths[i] - 2 * pad,
      { font: 'Helvetica-Bold', size: 8, minSize: 5.5, color: C.MUTED }));
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.advance(headerH);
  };
  ensure(ctx, headerH + 28);
  drawHeader();

  rows.forEach((row, ri) => {
    const cells = columns.map((c) => {
      const value = txt((row.cells || {})[c.id]);
      return { value, style: cellStyle(c.style, value) };
    });
    const maxRowH = ctx.pageHeight() - headerH - 2;
    // One layout per cell, used for BOTH the row height and the drawing, so the
    // two can never disagree.
    const lays = cells.map((cell, i) => PL.layout(doc, cell.value, {
      font: cell.style.bold ? 'Helvetica-Bold' : 'Helvetica',
      size: cell.style.size,
      width: widths[i] - 2 * pad,
      maxHeight: maxRowH - 12
    }));
    let rowH = 20;
    lays.forEach((L) => { if (L.height + 12 > rowH) rowH = L.height + 12; });
    if (rowH > maxRowH) rowH = maxRowH;
    if (ctx.y + rowH > BOTTOM && !ctx.isFresh()) { newPage(ctx); drawHeader(); }
    box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
    const cy = ctx.y + rowH / 2;
    cells.forEach((cell, i) => {
      PL.drawLayout(doc, lays[i], xs[i] + pad, cy - lays[i].height / 2, { color: cell.style.color });
    });
    doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
    ctx.advance(rowH);
  });
  ctx.advance(10);
}

// ---- callout -----------------------------------------------------------------
function buildCalloutSection(ctx, section) {
  if (!hasText(section.text) && !hasText(section.label)) return;
  const doc = ctx.doc;
  heading(ctx, section.title);
  ensure(ctx, 70);
  subheading(ctx, section.subtitle);

  const tone = calloutTone(section.tone);
  const label = txt(section.label).toUpperCase();
  const body = txt(section.text);
  const font = section.italic ? 'Helvetica-Oblique' : 'Helvetica-Bold';
  const L = body
    ? PL.layout(doc, body, { font, size: section.italic ? 10 : 11, width: CW - 28, lineGap: 2, maxHeight: ctx.pageHeight() - 40 })
    : null;
  const h = (L ? L.height : 0) + (label ? 34 : 22);
  ensure(ctx, h + 10);
  box(doc, M, ctx.y, CW, h, tone.bg, tone.border, tone.lw);
  let y = ctx.y + (label ? 10 : 11);
  if (label) {
    PL.drawFit(doc, label, M + 14, y, CW - 28, { font: 'Helvetica-Bold', size: 8, minSize: 6, color: C.MUTED });
    y += 12;
  }
  if (L) PL.drawLayout(doc, L, M + 14, y, { color: C.TEXT });
  ctx.advance(h + 10);
}

// ---- disclaimer --------------------------------------------------------------
function buildDisclaimerSection(ctx, section) {
  const doc = ctx.doc;
  const body = txt(section.text);
  if (!hasText(body)) return;
  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  ctx.advance(10);
  const label = txt(section.label);
  // Label and body are one run in two faces. Measuring only the body left the
  // box short by the width of the label, so the last line fell out of it.
  const L = PL.richLayout(doc, [
    { text: label, font: 'Helvetica-Bold', size: 8.5, color: C.MUTED },
    { text: body, font: 'Helvetica-Oblique', size: 8.5, color: C.MUTED }
  ], CW - 28, { lineGap: 2, maxHeight: ctx.pageHeight() - 40 });
  const h = L.height + 24;
  ensure(ctx, h + 10);
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.advance(8);
  box(doc, M, ctx.y, CW, h, C.DISC_BG, C.BORDER, 0.5);
  PL.drawRich(doc, L, M + 14, ctx.y + 12);
  ctx.advance(h);
}

module.exports = { buildComparisonReportPdf };
