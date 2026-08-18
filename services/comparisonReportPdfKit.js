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
  doc.on('pageAdded', () => paintBg(doc));
  paintBg(doc);

  const ctx = { doc, y: TOP, contentPages: new Set(), coverDrawn: false, anyContent: false };

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
    ctx.doc.font('Helvetica-Oblique').fontSize(11).fillColor(C.MUTED)
      .text('This report has no visible sections.', M, ctx.y, { width: CW });
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
  ctx.doc.addPage();
  ctx.y = TOP;
  ctx.contentPages.add(ctx.doc.bufferedPageRange().count - 1);
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
  else if (ctx.y + 90 > BOTTOM) newPage(ctx);
}
function paintChrome(doc, name, dateStr, contentPages) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    if (!contentPages.has(i)) continue;
    doc.switchToPage(i);
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GREEN);
    const wm = 'BodyBank.fit';
    const tw = doc.widthOfString(wm);
    doc.text(wm, PAGE_W - M - tw, 27, { lineBreak: false });
    if (LOGO) { try { doc.image(LOGO, PAGE_W - M - tw - 20, 23, { width: 15, height: 15 }); } catch (_) {} }
    doc.rect(0, PAGE_H - 46, PAGE_W, 46).fill(C.SURFACE);
    doc.rect(M, PAGE_H - 46, CW, 0.4).fill(C.BORDER);
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
      .text(`BodyBank.fit  ·  Progress Report  ·  ${name}`, M, PAGE_H - 26, { width: CW * 0.6, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
      .text(`${dateStr}  ·  Page ${i + 1}`, M, PAGE_H - 26, { width: CW, align: 'right', lineBreak: false });
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
  ctx.doc.font('Helvetica-Bold').fontSize(15).fillColor(C.GREEN).text(txt(text), M, ctx.y, { width: CW });
  ctx.y += 22;
  hr(ctx, ruleColor || C.GREEN, 1);
  ctx.y += 4;
}
function subheading(ctx, text) {
  if (!hasText(text)) return;
  if (ctx.y + 40 > BOTTOM) newPage(ctx);
  ctx.doc.font('Helvetica-Bold').fontSize(12).fillColor(C.WHITE).text(txt(text), M, ctx.y, { width: CW });
  ctx.y += 18;
}
function bodyText(ctx, text, opts) {
  opts = opts || {};
  const doc = ctx.doc;
  doc.font(opts.oblique ? 'Helvetica-Oblique' : 'Helvetica').fontSize(opts.size || 10).fillColor(opts.color || C.TEXT);
  doc.text(txt(text), M, ctx.y, { width: opts.width || CW, align: opts.align || 'left', lineGap: 3 });
  ctx.y = doc.y + (opts.spaceAfter != null ? opts.spaceAfter : 6);
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

  doc.font('Helvetica-Bold').fontSize(26).fillColor(C.WHITE).text(txt(cover.brandTitle || 'Blood Report Progress Review'), M, y, { width: CW });
  y = doc.y + 4;
  if (hasText(cover.brandSubtitle)) {
    doc.font('Helvetica').fontSize(13).fillColor(C.MUTED).text(txt(cover.brandSubtitle), M, y, { width: CW });
    y = doc.y;
  }
  y += 20;
  doc.save().rect(M, y, CW, 1).fill(C.GREEN).restore();
  y += 12;

  // patient + tests-compared card
  if (cover.showFields !== false) {
    const cardH = 118;
    box(doc, M, y, CW, cardH, C.DARK, C.BORDER, 0.5);
    const col = CW / 3;
    const label = (t, x, yy) => doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(String(t).toUpperCase(), x, yy, { width: col - 20, lineBreak: false });
    const val = (t, x, yy, color, size) => doc.font(size >= 14 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size || 11).fillColor(color || C.TEXT).text(txt(t), x, yy, { width: col - 20 });
    label('Patient Name', M + 14, y + 12); label('Report Date', M + 14 + col, y + 12); label('Report Type', M + 14 + 2 * col, y + 12);
    val(fields.patientName || '—', M + 14, y + 26, C.WHITE, 14);
    val(fields.reportDate || '—', M + 14 + col, y + 26, C.WHITE, 14);
    val(fields.reportType || '—', M + 14 + 2 * col, y + 26, C.GREEN, 14);
    label('Age / Gender', M + 14, y + 62); label('Fitness Goal', M + 14 + col, y + 62); label('Tests Compared', M + 14 + 2 * col, y + 62);
    val(fields.ageGender || '—', M + 14, y + 76, C.TEXT, 11);
    val(fields.goal || '—', M + 14 + col, y + 76, C.TEXT, 11);
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text(txt(fields.testsCompared || '—'), M + 14 + 2 * col, y + 78, { width: col - 20 });
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
    doc.font('Helvetica').fontSize(10);
    const sumH = summaryText ? doc.heightOfString(summaryText, { width: sumW, lineGap: 2 }) : 0;
    const bH = Math.max(78, sumH + 30);
    box(doc, M, y, CW, bH, C.SURFACE, tc, 1);
    const leftCy = y + bH / 2;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text('OVERALL TRAJECTORY', M + 14, leftCy - 20, { width: CW * 0.3 - 18 });
    doc.font('Helvetica-Bold').fontSize(19).fillColor(tc).text(label, M + 14, leftCy - 6, { width: CW * 0.3 - 14, lineBreak: false });
    if (summaryText) doc.font('Helvetica').fontSize(10).fillColor(C.TEXT).text(summaryText, sumX, y + 15, { width: sumW, lineGap: 2 });
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
      doc.font('Helvetica-Bold').fontSize(18).fillColor(statColor(c.tone)).text(txt(c.value), x + 12, y + 8, { width: cw - 24, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.MUTED).text(txt(c.label).toUpperCase(), x + 12, y + 30, { width: cw - 24, lineBreak: false });
    });
    y += 46 + 10;
  }

  const footnote = cover.footnote || {};
  if (footnote.show !== false && hasText(footnote.text)) {
    doc.save().rect(M, y, CW, 0.5).fill(C.BORDER).restore();
    y += 8;
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.MUTED)
      .text(txt(footnote.text), M, y, { width: CW, align: 'justify', lineGap: 2 });
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
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(c.kind === 'date' ? C.GREEN : C.MUTED)
        .text(String(c.header).toUpperCase(), xs[i] + pad, ctx.y + 9, { width: c.w - 2 * pad, lineBreak: false });
    });
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.y += headerH;
  };

  panels.forEach((panel) => {
    if (ctx.y + 60 > BOTTOM) newPage(ctx);
    ctx.y += 4;
    subheading(ctx, panel.name);
    drawHeader();
    panel.markers.forEach((m, ri) => {
      doc.font('Helvetica-Bold').fontSize(9);
      const nameH = doc.heightOfString(txt(m.name), { width: cols[0].w - 2 * pad });
      const rowH = Math.max(22, nameH + 12);
      if (ctx.y + rowH > BOTTOM) { newPage(ctx); drawHeader(); }
      box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
      const cy = ctx.y + rowH / 2;
      cols.forEach((c, i) => {
        const x = xs[i] + pad;
        const w = c.w - 2 * pad;
        if (c.kind === 'marker') {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.TEXT).text(txt(m.name), x, cy - nameH / 2, { width: w });
        } else if (c.kind === 'ref') {
          doc.font('Helvetica').fontSize(8).fillColor(C.MUTED).text(txt(m.reference) || '—', x, cy - 5, { width: w });
        } else if (c.kind === 'date') {
          const cell = (m.values || [])[c.valueIndex];
          if (cell && hasText(cell.text)) {
            doc.font('Helvetica-Bold').fontSize(9).fillColor(statusColorLite(cell.status)).text(txt(cell.text), x, cy - 6, { width: w, lineBreak: false });
          } else {
            doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text('—', x, cy - 6, { width: w, lineBreak: false });
          }
        } else if (c.kind === 'trend') {
          drawTrend(doc, m.trend || {}, xs[i], ctx.y, c.w, rowH);
        }
      });
      doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
      ctx.y += rowH;
    });
    ctx.y += 10;
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
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(col).text(txt(trend.text), cx + 8, cy - 4, { width: w - 22, lineBreak: false });
  }
}

// ---- prose -------------------------------------------------------------------
function buildTextSection(ctx, section) {
  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  const badge = section.badge || {};
  if (badge.show && (hasText(badge.label) || hasText(badge.text))) {
    const doc = ctx.doc;
    if (ctx.y + 50 > BOTTOM) newPage(ctx);
    const labelText = txt(badge.label || '').toUpperCase();
    doc.font('Helvetica-Bold').fontSize(8);
    const labelW = labelText ? Math.max(70, doc.widthOfString(labelText) + 16) : 0;
    box(doc, M, ctx.y, CW, 30, C.SURFACE, C.GREEN, 0.5);
    if (labelText) doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(labelText, M + 12, ctx.y + 6, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.GREEN)
      .text(txt(badge.text), M + 12 + labelW, ctx.y + 9, { width: CW - 24 - labelW, lineBreak: false });
    ctx.y += 30 + 10;
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
  doc.font('Helvetica').fontSize(9.5);
  const th = meaning ? doc.heightOfString(meaning, { width: CW - 28, lineGap: 2 }) : 0;
  const h = Math.max(38, th + (arrow ? 42 : 28));
  if (ctx.y + h > BOTTOM) newPage(ctx);
  box(doc, M, ctx.y, CW, h, t.bg, t.border, 0.5);
  doc.save().rect(M, ctx.y, 3, h).fill(t.border).restore();
  const topY = ctx.y + 10;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT).text(title, M + 14, topY, { width: CW - 90 });
  if (item.level) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(levelColor(item.level))
      .text(String(item.level).toUpperCase(), M + CW - 74, topY, { width: 60, align: 'right', lineBreak: false });
  }
  let y = topY + 14;
  if (arrow) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(t.border).text(arrow, M + 14, y, { width: CW - 28, lineBreak: false });
    y += 14;
  }
  if (meaning) doc.font('Helvetica').fontSize(9.5).fillColor(C.MUTED).text(meaning, M + 14, y, { width: CW - 28, lineGap: 2 });
  ctx.y += h + 6;
}

function buildCardsSection(ctx, section) {
  const groups = visible(section.groups)
    .map((g) => ({ title: g.title, tone: g.tone, items: visible(g.items) }))
    .filter((g) => g.items.length);
  if (!groups.length) return;
  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  groups.forEach((g, gi) => {
    if (gi > 0 && ctx.y + 70 > BOTTOM) newPage(ctx);
    if (hasText(g.title)) { subheading(ctx, g.title); ctx.y += 2; }
    g.items.forEach((it) => changeCard(ctx, it, g.tone));
    ctx.y += 6;
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
  if (ctx.y + 80 > BOTTOM) newPage(ctx);
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
    columns.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED)
      .text(txt(c.header).toUpperCase(), xs[i] + pad, ctx.y + 8, { width: widths[i] - 2 * pad, lineBreak: false }));
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.y += headerH;
  };
  drawHeader();

  rows.forEach((row, ri) => {
    const cells = columns.map((c) => {
      const value = txt((row.cells || {})[c.id]);
      return { value, style: cellStyle(c.style, value) };
    });
    let rowH = 20;
    cells.forEach((cell, i) => {
      const tw = widths[i] - 2 * pad;
      doc.font(cell.style.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.style.size);
      const hh = doc.heightOfString(cell.value, { width: tw }) + 12;
      if (hh > rowH) rowH = hh;
    });
    if (ctx.y + rowH > BOTTOM) { newPage(ctx); drawHeader(); }
    box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
    const cy = ctx.y + rowH / 2;
    cells.forEach((cell, i) => {
      const tw = widths[i] - 2 * pad;
      doc.font(cell.style.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.style.size).fillColor(cell.style.color);
      const th = doc.heightOfString(cell.value, { width: tw });
      doc.text(cell.value, xs[i] + pad, cy - th / 2, { width: tw });
    });
    doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
    ctx.y += rowH;
  });
  ctx.y += 10;
}

// ---- callout -----------------------------------------------------------------
function buildCalloutSection(ctx, section) {
  if (!hasText(section.text) && !hasText(section.label)) return;
  const doc = ctx.doc;
  heading(ctx, section.title);
  if (ctx.y + 70 > BOTTOM) newPage(ctx);
  subheading(ctx, section.subtitle);

  const tone = calloutTone(section.tone);
  const label = txt(section.label).toUpperCase();
  const body = txt(section.text);
  const font = section.italic ? 'Helvetica-Oblique' : 'Helvetica-Bold';
  doc.font(font).fontSize(section.italic ? 10 : 11);
  const th = body ? doc.heightOfString(body, { width: CW - 28, lineGap: 2 }) : 0;
  const h = th + (label ? 34 : 22);
  if (ctx.y + h > BOTTOM) newPage(ctx);
  box(doc, M, ctx.y, CW, h, tone.bg, tone.border, tone.lw);
  let y = ctx.y + (label ? 10 : 11);
  if (label) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(label, M + 14, y, { lineBreak: false });
    y += 12;
  }
  if (body) doc.font(font).fontSize(section.italic ? 10 : 11).fillColor(C.TEXT).text(body, M + 14, y, { width: CW - 28, lineGap: 2 });
  ctx.y += h + 10;
}

// ---- disclaimer --------------------------------------------------------------
function buildDisclaimerSection(ctx, section) {
  const doc = ctx.doc;
  const body = txt(section.text);
  if (!hasText(body)) return;
  heading(ctx, section.title);
  subheading(ctx, section.subtitle);
  ctx.y += 10;
  doc.font('Helvetica').fontSize(8.5);
  const th = doc.heightOfString(body, { width: CW - 28, lineGap: 2 });
  const h = th + 24;
  if (ctx.y + h + 10 > BOTTOM) newPage(ctx);
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.y += 8;
  box(doc, M, ctx.y, CW, h, C.DISC_BG, C.BORDER, 0.5);
  const label = txt(section.label);
  if (label) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.MUTED).text(label, M + 14, ctx.y + 12, { width: CW - 28, continued: true })
      .font('Helvetica-Oblique').fillColor(C.MUTED).text(body, { lineGap: 2 });
  } else {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.MUTED).text(body, M + 14, ctx.y + 12, { width: CW - 28, lineGap: 2 });
  }
  ctx.y += h;
}

module.exports = { buildComparisonReportPdf };
