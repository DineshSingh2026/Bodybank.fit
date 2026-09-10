'use strict';

/**
 * BodyBank — GRADED HEALTH REPORT PDF.
 *
 * Renders the editable document (services/gradedReportDocument.js) and nothing else.
 * It never reads the engine output directly, so what a reviewer sees in the editor
 * and what a client receives cannot disagree.
 *
 * ─── THE GRADE PALETTE ────────────────────────────────────────────────────────
 * Four muted, professional tones plus a neutral. Three constraints shaped them:
 *
 *   • No traffic light. Pure red/green reads as pass/fail on a medical document, and
 *     a D is not a failure — it is an appointment.
 *   • Distinguishable in greyscale. The four tones are separated by LIGHTNESS as
 *     well as hue (roughly 0.74 / 0.64 / 0.52 / 0.38), so a printed black-and-white
 *     copy still ranks them correctly.
 *   • Never colour alone. Every grade is drawn with its letter, its label, AND a
 *     four-segment severity bar. A reader with any form of colour blindness, or a
 *     fax machine, still gets the full signal.
 *
 * ─── PRINT HIERARCHY IS FIXED ─────────────────────────────────────────────────
 * Page 1 carries the cover, the Health Map and the key message — nothing competes
 * with the map. Page 2 opens the priorities. The document's `pageBreak` flags carry
 * that intent, so a reviewer reordering sections keeps the structure.
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { txt, hasText } = require('./pdfText');

// ---------------------------------------------------------------------------
// Brand + grade palette
// ---------------------------------------------------------------------------

const C = {
  BG: '#0d0f11',
  SURFACE: '#161a1e',
  SURFACE2: '#1e2328',
  DARK: '#1a1f24',
  BORDER: '#2a2f35',
  BORDER_SOFT: '#22272c',
  TEXT: '#f0ede8',
  MUTED: '#8a8880',
  DIM: '#6e7378',
  WHITE: '#ffffff',
  GOLD: '#e6c46a',
  GOLD_DIM: '#c8a44e',
  DISC_BG: '#141414'
};

/** Grade tones: muted, lightness-separated, never a traffic light. */
const GRADE = {
  A: { fill: '#8FCBB0', ink: '#0d1f18', pips: 1, label: 'Healthy' },
  B: { fill: '#C2A25E', ink: '#211a08', pips: 2, label: 'Monitor' },
  C: { fill: '#C9773E', ink: '#231007', pips: 3, label: 'Attention Recommended' },
  D: { fill: '#A8504B', ink: '#230d0c', pips: 4, label: 'Further Evaluation' },
  NOT_ASSESSED: { fill: '#4a5157', ink: '#c9cdd1', pips: 0, label: 'Not Assessed' }
};
function gradeTone(g) { return GRADE[g] || GRADE.NOT_ASSESSED; }

/** Trend tones — deliberately not the grade colours, so the two never blur. */
const TREND_TONE = {
  IMPROVED: '#8FCBB0',
  RESOLVED: '#8FCBB0',
  STABLE: '#8a8880',
  NO_SIGNIFICANT_CHANGE: '#8a8880',
  NEEDS_ATTENTION: '#C9773E',
  NEW_FINDING: '#C2A25E',
  NOT_COMPARABLE: '#6e7378'
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 51;
const CW = PAGE_W - 2 * M;
const TOP = 72;
const BOTTOM = 780;

function resolveLogo() {
  const dir = path.join(__dirname, '..', 'public', 'img');
  const candidates = [
    'bodybank-logo.png - short.png',
    'bodybank-logo-short.png',
    'logo-bb.png',
    'Bodybank logo.png'
  ];
  for (const f of candidates) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}
const LOGO = resolveLogo();

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function box(doc, x, y, w, h, fill, stroke, lw, radius) {
  // Construct the path only when there is something to paint with it. Building a
  // rect and then neither filling nor stroking it leaves an open path in the
  // graphics state, and the next text() call is consumed by it — which is how every
  // second row of the lab table rendered blank.
  if (!fill && !stroke) return;
  doc.save();
  const shape = radius ? doc.roundedRect(x, y, w, h, radius) : doc.rect(x, y, w, h);
  if (fill && stroke) shape.fillAndStroke(fill, stroke);
  else if (fill) shape.fill(fill);
  else { doc.lineWidth(lw || 0.6); shape.stroke(stroke); }
  doc.restore();
}

function paintBg(doc) {
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.BG);
  doc.rect(0, 0, PAGE_W, 2).fill(C.GOLD_DIM);
  doc.restore();
}

function newPage(ctx) {
  ctx.doc.addPage();
  ctx.y = TOP;
  ctx.contentPages.add(ctx.doc.bufferedPageRange().count - 1);
}

/** Ensure `need` points of vertical space, starting a page if not. */
function ensure(ctx, need) {
  if (ctx.y + need > BOTTOM) { newPage(ctx); return true; }
  return false;
}

function paintChrome(doc, clientName, dateLabel, contentPages) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    if (!contentPages.has(i)) continue;
    doc.switchToPage(i);
    // The footer sits BELOW the bottom margin. PDFKit tracks doc.y through every
    // text() call, so writing down there leaves the cursor past the margin and the
    // next write auto-adds a page — which is how painting chrome onto 11 pages
    // silently produced 22 blank ones. Dropping the bottom margin for the duration
    // keeps the flow engine out of it.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GOLD);
    const wm = 'BodyBank.fit';
    const tw = doc.widthOfString(wm);
    doc.text(wm, PAGE_W - M - tw, 28, { lineBreak: false });
    if (LOGO) { try { doc.image(LOGO, PAGE_W - M - tw - 20, 24, { width: 15, height: 15 }); } catch (_) { /* ignore */ } }

    doc.rect(0, PAGE_H - 44, PAGE_W, 44).fill(C.SURFACE);
    doc.rect(M, PAGE_H - 44, CW, 0.4).fill(C.BORDER);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.MUTED)
      .text(txt(`BodyBank.fit  ·  Health Map Report  ·  ${clientName}`), M, PAGE_H - 26,
        { width: CW * 0.62, lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(C.MUTED)
      .text(txt(`${dateLabel}  ·  Page ${i + 1}`), M, PAGE_H - 26,
        { width: CW, align: 'right', lineBreak: false });
    doc.restore();
    doc.page.margins.bottom = savedBottom;
  }
}

function sectionHeading(ctx, title, subtitle) {
  const doc = ctx.doc;
  if (!hasText(title)) return;
  const subH = hasText(subtitle) ? doc.font('Helvetica').fontSize(9).heightOfString(txt(subtitle), { width: CW }) : 0;
  ensure(ctx, 34 + subH);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.GOLD).text(txt(title), M, ctx.y, { width: CW });
  ctx.y = doc.y + 6;
  doc.save().rect(M, ctx.y, 46, 1.6).fill(C.GOLD_DIM).restore();
  doc.save().rect(M + 46, ctx.y, CW - 46, 0.5).fill(C.BORDER).restore();
  ctx.y += 10;
  if (hasText(subtitle)) {
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED)
      .text(txt(subtitle), M, ctx.y, { width: CW, lineGap: 2 });
    ctx.y = doc.y + 8;
  }
}

/**
 * The grade badge: colour, letter and severity pips together.
 * Nothing here depends on colour alone.
 */
function gradeBadge(doc, x, y, size, grade) {
  const t = gradeTone(grade);
  box(doc, x, y, size, size, t.fill, null, 0, 4);
  const letter = grade === 'NOT_ASSESSED' ? '–' : grade;
  doc.font('Helvetica-Bold').fontSize(size * 0.56).fillColor(t.ink);
  const lw = doc.widthOfString(letter);
  doc.text(letter, x + (size - lw) / 2, y + size * 0.2, { lineBreak: false });
}

/** Four segments, filled to the grade's severity — a non-colour rank cue. */
function severityPips(doc, x, y, w, grade) {
  const t = gradeTone(grade);
  const gap = 2.5;
  const seg = (w - gap * 3) / 4;
  for (let i = 0; i < 4; i += 1) {
    const filled = i < t.pips;
    box(doc, x + i * (seg + gap), y, seg, 3.2, filled ? t.fill : C.BORDER, null, 0, 1.6);
  }
}

function bodyText(ctx, text, opts) {
  const o = opts || {};
  const doc = ctx.doc;
  const s = txt(text);
  if (!s.trim()) return;
  const width = o.width || CW;
  doc.font(o.font || 'Helvetica').fontSize(o.size || 9.5);
  const h = doc.heightOfString(s, { width, lineGap: o.lineGap != null ? o.lineGap : 3 });
  ensure(ctx, h + 6);
  doc.fillColor(o.color || C.TEXT)
    .text(s, o.x != null ? o.x : M, ctx.y, { width, lineGap: o.lineGap != null ? o.lineGap : 3, align: o.align || 'left' });
  ctx.y = doc.y + (o.spaceAfter != null ? o.spaceAfter : 8);
}

/** A small uppercase layer label — RESULT / STATUS / BODYBANK INSIGHT / NEXT STEP. */
function layerLabel(doc, x, y, text, color) {
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(color || C.DIM)
    .text(txt(String(text).toUpperCase()), x, y, { characterSpacing: 0.6, lineBreak: false });
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

function buildCover(ctx, cover) {
  const doc = ctx.doc;
  ctx.contentPages.add(0);
  ctx.y = TOP;

  if (LOGO) {
    try { doc.image(LOGO, M, ctx.y, { width: 40, height: 40 }); } catch (_) { /* ignore */ }
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.GOLD)
    .text('BodyBank.fit', M + (LOGO ? 50 : 0), ctx.y + 8, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
    .text('Preventive Health Screening', M + (LOGO ? 50 : 0), ctx.y + 23, { lineBreak: false });
  ctx.y += 58;

  doc.font('Helvetica-Bold').fontSize(26).fillColor(C.TEXT)
    .text(txt(cover.title), M, ctx.y, { width: CW });
  ctx.y = doc.y + 10;

  doc.save().rect(M, ctx.y, 64, 2).fill(C.GOLD).restore();
  ctx.y += 18;

  // Client card
  const cardH = 62;
  box(doc, M, ctx.y, CW, cardH, C.SURFACE, C.BORDER, 0.6, 6);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.TEXT)
    .text(txt(cover.clientName || 'Member'), M + 16, ctx.y + 13, { width: CW - 32, lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor(C.MUTED)
    .text(txt(cover.clientMeta || ''), M + 16, ctx.y + 33, { width: CW * 0.6, lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
    .text(txt('SCREENING DATE'), M, ctx.y + 16, { width: CW - 16, align: 'right', lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.GOLD)
    .text(txt(cover.screeningDateLabel || cover.screeningDate || ''), M, ctx.y + 30,
      { width: CW - 16, align: 'right', lineBreak: false });
  ctx.y += cardH + 14;

  // Stat strip
  const stats = (cover.stats || []).filter((s) => s.show !== false);
  if (stats.length) {
    const gap = 10;
    const w = (CW - gap * (stats.length - 1)) / stats.length;
    const h = 50;
    stats.forEach((s, i) => {
      const x = M + i * (w + gap);
      box(doc, x, ctx.y, w, h, C.DARK, C.BORDER_SOFT, 0.5, 6);
      doc.font('Helvetica-Bold').fontSize(19).fillColor(C.GOLD)
        .text(txt(s.value), x, ctx.y + 10, { width: w, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(C.MUTED)
        .text(txt(String(s.label).toUpperCase()), x, ctx.y + 33,
          { width: w, align: 'center', characterSpacing: 0.5, lineBreak: false });
    });
    ctx.y += h + 16;
  }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHealthMap(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);

  const areas = (s.areas || []).filter((a) => a.show !== false);
  if (areas.length) {
    // Tile geometry is tuned so a nine-area map, its legend and the key message all
    // land on page one. The map is the hero of that page; pushing the key message
    // onto page two costs the reader the framing sentence that explains the grid.
    const cols = 2;
    const gap = 8;
    const w = (CW - gap * (cols - 1)) / cols;
    const h = 52;
    areas.forEach((a, i) => {
      const col = i % cols;
      if (col === 0) ensure(ctx, h + gap);
      const x = M + col * (w + gap);
      const y = ctx.y;
      box(doc, x, y, w, h, C.SURFACE, C.BORDER_SOFT, 0.6, 6);
      gradeBadge(doc, x + 11, y + 10, 32, a.grade);

      const tx = x + 52;
      const tw = w - 64;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT)
        .text(txt(a.label), tx, y + 9, { width: tw, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(7.8).fillColor(gradeTone(a.grade).fill)
        .text(txt(a.gradeLabel || gradeTone(a.grade).label), tx, y + 22, { width: tw, lineBreak: false, ellipsis: true });

      severityPips(doc, tx, y + 36, Math.min(tw, 70), a.grade);

      if (a.previousGrade && a.previousGrade !== a.grade) {
        doc.font('Helvetica').fontSize(7.5).fillColor(C.MUTED)
          .text(txt(`was ${a.previousGrade}`), x + w - 48, y + 35, { width: 38, align: 'right', lineBreak: false });
      }
      // A grade that held needs no annotation. Printing 'no change' on six of
      // seven tiles turns the one tile that DID move into noise.

      if (col === cols - 1 || i === areas.length - 1) ctx.y += h + gap;
    });
  }

  if (s.legend !== false) {
    ensure(ctx, 24);
    let lx = M;
    ['A', 'B', 'C', 'D'].forEach((g) => {
      const t = gradeTone(g);
      box(doc, lx, ctx.y + 2, 8, 8, t.fill, null, 0, 2);
      doc.font('Helvetica').fontSize(7.5).fillColor(C.MUTED)
        .text(txt(`${g} ${t.label}`), lx + 12, ctx.y + 2, { lineBreak: false });
      lx += 14 + doc.widthOfString(txt(`${g} ${t.label}`)) + 16;
    });
    ctx.y += 20;
  }

  const na = (s.notAssessed || []).filter((a) => a.show !== false);
  if (na.length) {
    // One flowing paragraph rather than a row per area. This block is genuinely
    // secondary — it explains a gap, it does not report a finding — so it earns a
    // couple of lines, not a quarter of page one.
    const line = na.map((a) => `${a.label} (needs ${a.needs})`).join(';  ');
    doc.font('Helvetica').fontSize(8).fillColor(C.DIM);
    const h = doc.heightOfString(txt(line), { width: CW - 14, lineGap: 2 });
    ensure(ctx, h + 26);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.MUTED)
      .text(txt(s.notAssessedTitle || 'Not assessed in this screening'), M, ctx.y, { width: CW, lineBreak: false });
    ctx.y += 13;
    doc.font('Helvetica').fontSize(8).fillColor(C.DIM)
      .text(txt(line), M, ctx.y, { width: CW - 14, lineGap: 2 });
    ctx.y = doc.y + 8;
  }
}

function renderText(ctx, s) {
  const doc = ctx.doc;
  if (s.variant === 'lead') {
    const body = txt(s.body);
    if (!body.trim()) return;
    doc.font('Helvetica').fontSize(12);
    const h = doc.heightOfString(body, { width: CW - 32, lineGap: 4 });
    ensure(ctx, h + 30);
    box(doc, M, ctx.y, CW, h + 26, C.SURFACE2, null, 0, 6);
    doc.save().rect(M, ctx.y, 2.5, h + 26).fill(C.GOLD).restore();
    doc.fillColor(C.TEXT).text(body, M + 18, ctx.y + 13, { width: CW - 32, lineGap: 4 });
    ctx.y += h + 34;
    return;
  }
  sectionHeading(ctx, s.title, s.subtitle);
  // Paragraph by paragraph, so a long narrative breaks across pages cleanly.
  String(s.body || '').split(/\n\s*\n/).forEach((para) => {
    bodyText(ctx, para, { size: 9.5, lineGap: 3.5, spaceAfter: 9 });
  });
}

function renderPriorities(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);
  const items = (s.items || []).filter((p) => p.show !== false);
  if (!items.length) {
    bodyText(ctx, 'No finding on this screening rises to the level of a priority. The detailed results below show everything that was measured.', { color: C.MUTED });
    return;
  }

  items.forEach((p) => {
    const tw = CW - 32;
    doc.font('Helvetica').fontSize(9);
    const whyH = doc.heightOfString(txt(p.whyItMatters), { width: tw, lineGap: 2.5 });
    const stepH = doc.heightOfString(txt(p.nextStep), { width: tw, lineGap: 2.5 });
    const proH = p.requiresProfessional && hasText(p.professionalNote) ? 18 : 0;
    const h = 46 + 16 + whyH + 16 + 20 + 16 + stepH + proH + 16;

    ensure(ctx, h + 12);
    const y = ctx.y;
    box(doc, M, y, CW, h, C.SURFACE, C.BORDER_SOFT, 0.6, 6);
    const tone = gradeTone(p.grade);
    doc.save().rect(M, y, 3, h).fill(tone.fill).restore();

    // rank + title
    doc.font('Helvetica-Bold').fontSize(9).fillColor(tone.ink);
    box(doc, M + 16, y + 15, 18, 18, tone.fill, null, 0, 9);
    doc.text(String(p.rank), M + 16, y + 20, { width: 18, align: 'center', lineBreak: false });

    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.TEXT)
      .text(txt(p.title), M + 42, y + 15, { width: CW - 58 });
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
      .text(txt(`${p.areaLabel}  ·  Grade ${p.grade}`), M + 42, y + 32, { width: CW - 58, lineBreak: false });

    let cy = y + 54;

    layerLabel(doc, M + 16, cy, 'Result');
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.TEXT)
      .text(txt(p.result), M + 16, cy + 10, { width: tw * 0.66, lineBreak: false, ellipsis: true });
    layerLabel(doc, M + 16 + tw * 0.68, cy, 'Status');
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(tone.fill)
      .text(txt(p.status), M + 16 + tw * 0.68, cy + 10, { width: tw * 0.32, lineBreak: false });
    cy += 30;

    layerLabel(doc, M + 16, cy, 'Why it matters');
    doc.font('Helvetica').fontSize(9).fillColor(C.TEXT)
      .text(txt(p.whyItMatters), M + 16, cy + 11, { width: tw, lineGap: 2.5 });
    cy += 11 + whyH + 10;

    layerLabel(doc, M + 16, cy, 'Next step', C.GOLD_DIM);
    doc.font('Helvetica').fontSize(9).fillColor(C.TEXT)
      .text(txt(p.nextStep), M + 16, cy + 11, { width: tw, lineGap: 2.5 });
    cy += 11 + stepH;

    if (proH) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRADE.D.fill)
        .text(txt('>  ' + p.professionalNote), M + 16, cy + 6, { width: tw, lineBreak: false });
    }

    ctx.y = y + h + 12;
  });
}

function renderAreaCards(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);

  (s.cards || []).filter((c) => c.show !== false).forEach((card) => {
    const tone = gradeTone(card.grade);
    const tw = CW - 32;

    // Header block — kept with at least the summary so a card never orphans.
    doc.font('Helvetica').fontSize(9);
    const sumH = hasText(card.summary) ? doc.heightOfString(txt(card.summary), { width: tw, lineGap: 2.5 }) : 0;
    ensure(ctx, 54 + sumH + 24);

    const y = ctx.y;
    box(doc, M, y, CW, 42, C.SURFACE2, null, 0, 6);
    doc.save().rect(M, y, 3, 42).fill(tone.fill).restore();
    gradeBadge(doc, M + 14, y + 6, 30, card.grade);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(C.TEXT)
      .text(txt(card.label), M + 54, y + 10, { width: CW - 190, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(8.5).fillColor(tone.fill)
      .text(txt(card.gradeLabel || tone.label), M + 54, y + 25, { width: CW - 190, lineBreak: false });
    if (card.requiresProfessional) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GRADE.D.fill)
        .text(txt('DISCUSS WITH A PROFESSIONAL'), M, y + 17, { width: CW - 14, align: 'right', lineBreak: false });
    }
    ctx.y = y + 50;

    if (hasText(card.summary)) bodyText(ctx, card.summary, { size: 9, spaceAfter: 6 });
    if (hasText(card.trendLine)) {
      bodyText(ctx, card.trendLine, { size: 8.5, color: C.MUTED, spaceAfter: 8 });
    }

    const findings = (card.findings || []).filter((f) => f.show !== false);
    findings.forEach((f) => {
      doc.font('Helvetica').fontSize(8.5);
      const insH = hasText(f.insight) ? doc.heightOfString(txt(f.insight), { width: tw - 8, lineGap: 2 }) : 0;
      const rowH = 30 + insH + (insH ? 6 : 0);
      ensure(ctx, rowH + 4);
      const fy = ctx.y;
      box(doc, M, fy, CW, rowH, C.DARK, null, 0, 4);

      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.TEXT)
        .text(txt(f.label), M + 12, fy + 8, { width: CW * 0.34, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.TEXT)
        .text(txt(f.result), M + CW * 0.37, fy + 8, { width: CW * 0.22, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
        .text(txt(f.range ? `ref ${f.range}` : ''), M + CW * 0.59, fy + 9, { width: CW * 0.18, lineBreak: false, ellipsis: true });

      const stCol = f.status === 'Within range' ? C.MUTED : tone.fill;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(stCol)
        .text(txt(f.status), M + CW * 0.77, fy + 9, { width: CW * 0.21 - 12, align: 'right', lineBreak: false });

      if (insH) {
        doc.font('Helvetica').fontSize(8.5).fillColor(C.MUTED)
          .text(txt(f.insight), M + 12, fy + 24, { width: tw - 8, lineGap: 2 });
      }
      ctx.y = fy + rowH + 4;
    });

    if (hasText(card.focus)) {
      doc.font('Helvetica').fontSize(9);
      const fh = doc.heightOfString(txt(card.focus), { width: tw - 46, lineGap: 2.5 });
      ensure(ctx, fh + 24);
      const fy = ctx.y;
      box(doc, M, fy, CW, fh + 20, '#1b2320', null, 0, 4);
      layerLabel(doc, M + 12, fy + 8, 'Focus on', C.GOLD_DIM);
      doc.font('Helvetica').fontSize(9).fillColor(C.TEXT)
        .text(txt(card.focus), M + 56, fy + 7, { width: tw - 46, lineGap: 2.5 });
      ctx.y = fy + fh + 26;
    }

    ctx.y += 8;
  });
}

function renderMarkers(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);

  // The trend column has to hold "No Significant Change" on one line. The fixed
  // trend vocabulary is not ours to abbreviate, so the column is sized to it.
  const cols = [
    { header: 'Marker', frac: 0.28, align: 'left' },
    { header: 'Result', frac: 0.17, align: 'left' },
    { header: 'Reference', frac: 0.19, align: 'left' },
    { header: 'Status', frac: 0.17, align: 'left' },
    { header: 'Trend', frac: 0.19, align: 'right' }
  ];
  const xs = [];
  let acc = M;
  cols.forEach((c) => { xs.push(acc); acc += c.frac * CW; });
  const pad = 8;

  const drawHeader = () => {
    box(doc, M, ctx.y, CW, 20, C.SURFACE2, null, 0, 3);
    cols.forEach((c, i) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.MUTED)
        .text(txt(c.header.toUpperCase()), xs[i] + pad, ctx.y + 7,
          { width: c.frac * CW - 2 * pad, align: c.align, characterSpacing: 0.5, lineBreak: false });
    });
    ctx.y += 20;
  };

  (s.groups || []).filter((g) => g.show !== false).forEach((g) => {
    const markers = (g.markers || []).filter((m) => m.show !== false);
    if (!markers.length) return;

    ensure(ctx, 56);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.GOLD_DIM)
      .text(txt(g.label), M, ctx.y, { width: CW });
    ctx.y = doc.y + 6;
    drawHeader();

    markers.forEach((m, ri) => {
      const rowH = 19;
      if (ctx.y + rowH > BOTTOM) { newPage(ctx); drawHeader(); }
      box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : null);
      const ty = ctx.y + 5.5;

      doc.font('Helvetica').fontSize(8.5).fillColor(C.TEXT)
        .text(txt(m.label), xs[0] + pad, ty, { width: cols[0].frac * CW - 2 * pad, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.TEXT)
        .text(txt(m.result), xs[1] + pad, ty, { width: cols[1].frac * CW - 2 * pad, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
        .text(txt(m.range) + (m.rangeSource === 'BODYBANK_PREFERRED' ? ' *' : ''),
          xs[2] + pad, ty + 0.4, { width: cols[2].frac * CW - 2 * pad, lineBreak: false, ellipsis: true });

      const within = m.status === 'Within range';
      doc.font(within ? 'Helvetica' : 'Helvetica-Bold').fontSize(8.5)
        .fillColor(within ? C.MUTED : C.TEXT)
        .text(txt(m.status), xs[3] + pad, ty, { width: cols[3].frac * CW - 2 * pad, lineBreak: false, ellipsis: true });

      if (m.trend && m.trend !== 'NOT_COMPARABLE') {
        doc.font('Helvetica').fontSize(7).fillColor(TREND_TONE[m.trend] || C.DIM)
          .text(txt(m.trendLabel || ''), xs[4] + pad, ty + 0.6,
            { width: cols[4].frac * CW - 2 * pad, align: 'right', lineBreak: false, ellipsis: true });
      }
      ctx.y += rowH;
    });

    doc.save().rect(M, ctx.y, CW, 0.4).fill(C.BORDER_SOFT).restore();
    ctx.y += 14;
  });

  // Footnote for any BodyBank-supplied range used above.
  const usedPreferred = (s.groups || []).some((g) => (g.markers || [])
    .some((m) => m.rangeSource === 'BODYBANK_PREFERRED'));
  if (usedPreferred) {
    ensure(ctx, 20);
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.MUTED)
      .text(txt('*  Your lab did not print a reference range for this marker, so a BodyBank preferred range was used and is shown here.'),
        M, ctx.y, { width: CW, lineGap: 2 });
    ctx.y = doc.y + 8;
  }
}

function renderProgress(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);

  if (hasText(s.caution)) {
    doc.font('Helvetica').fontSize(8.5);
    const h = doc.heightOfString(txt(s.caution), { width: CW - 28 });
    ensure(ctx, h + 22);
    box(doc, M, ctx.y, CW, h + 16, '#241f16', null, 0, 4);
    doc.fillColor(C.GOLD).text(txt(s.caution), M + 14, ctx.y + 8, { width: CW - 28 });
    ctx.y += h + 24;
  }

  (s.groups || []).filter((g) => g.show !== false).forEach((g) => {
    const items = (g.items || []).filter((i) => i.show !== false);
    if (!items.length) return;
    const tone = TREND_TONE[
      g.key === 'improved' ? 'IMPROVED'
        : g.key === 'needsAttention' ? 'NEEDS_ATTENTION'
          : g.key === 'newFindings' ? 'NEW_FINDING'
            : g.key === 'resolved' ? 'RESOLVED' : 'STABLE'
    ] || C.MUTED;

    ensure(ctx, 40);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(tone)
      .text(txt(`${g.title}  (${items.length})`), M, ctx.y, { width: CW, lineBreak: false });
    ctx.y = doc.y + 6;

    // The stable group is a long list of names; print it as flowing text rather
    // than one row per marker, so it never fills a page on its own.
    if (g.key === 'stable') {
      bodyText(ctx, items.map((i) => i.label).join(', '), { size: 8.5, color: C.MUTED, spaceAfter: 12 });
      return;
    }

    items.forEach((it, ri) => {
      const rowH = 18;
      ensure(ctx, rowH);
      box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : null);
      const ty = ctx.y + 5;
      doc.font('Helvetica').fontSize(8.5).fillColor(C.TEXT)
        .text(txt(it.label), M + 10, ty, { width: CW * 0.42, lineBreak: false, ellipsis: true });

      const move = it.previous ? `${it.previous}  ->  ${it.current}` : txt(it.current);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.TEXT)
        .text(txt(move), M + CW * 0.44, ty, { width: CW * 0.34, lineBreak: false, ellipsis: true });

      let tag = '';
      if (it.newReason === 'FIRST_MEASURED') tag = 'first measured';
      else if (it.newReason === 'MOVED_OUT_OF_RANGE') tag = 'moved out of range';
      if (tag) {
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.MUTED)
          .text(txt(tag), M + CW * 0.78, ty + 0.5, { width: CW * 0.22 - 10, align: 'right', lineBreak: false });
      }
      ctx.y += rowH;
    });
    ctx.y += 12;
  });
}

function renderList(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);
  const items = (s.items || []).filter((i) => i.show !== false);
  items.forEach((it, i) => {
    const marker = s.style === 'bulleted' ? '•' : String(i + 1);
    const tw = CW - 40;
    doc.font('Helvetica').fontSize(9.5);
    const h = doc.heightOfString(txt(it.text), { width: tw, lineGap: 3 });
    ensure(ctx, h + 18);
    const y = ctx.y;
    box(doc, M, y, 20, 20, it.requiresProfessional ? GRADE.D.fill : C.SURFACE2, null, 0, 10);
    doc.font('Helvetica-Bold').fontSize(9)
      .fillColor(it.requiresProfessional ? GRADE.D.ink : C.GOLD)
      .text(marker, M, y + 5.5, { width: 20, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).fillColor(C.TEXT)
      .text(txt(it.text), M + 32, y + 4, { width: tw, lineGap: 3 });
    ctx.y = Math.max(y + 26, doc.y + 10);
  });
}

function renderCallout(ctx, s) {
  const doc = ctx.doc;
  const tone = s.tone === 'review' ? GRADE.D.fill
    : s.tone === 'attention' ? GRADE.C.fill
      : s.tone === 'gold' ? C.GOLD : C.MUTED;
  const bg = s.tone === 'review' ? '#241514' : s.tone === 'attention' ? '#241a12'
    : s.tone === 'gold' ? '#221d12' : C.SURFACE;

  const items = (s.items || []).filter((i) => i.show !== false);
  const tw = CW - 34;
  doc.font('Helvetica').fontSize(9);
  const bodyH = hasText(s.body) ? doc.heightOfString(txt(s.body), { width: tw, lineGap: 3 }) : 0;
  const itemsH = items.reduce((acc, it) => {
    doc.font('Helvetica').fontSize(8.5);
    const nh = hasText(it.note) ? doc.heightOfString(txt(it.note), { width: tw - 6, lineGap: 2 }) : 0;
    return acc + 20 + nh + 6;
  }, 0);
  const h = 16 + (hasText(s.title) ? 18 : 0) + bodyH + (itemsH ? itemsH + 6 : 0) + 14;

  ensure(ctx, h + 10);
  const y = ctx.y;
  box(doc, M, y, CW, h, bg, null, 0, 6);
  doc.save().rect(M, y, 3, h).fill(tone).restore();

  let cy = y + 14;
  if (hasText(s.title)) {
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(tone)
      .text(txt(s.title), M + 17, cy, { width: tw, lineBreak: false });
    cy += 18;
  }
  if (bodyH) {
    doc.font('Helvetica').fontSize(9).fillColor(C.TEXT)
      .text(txt(s.body), M + 17, cy, { width: tw, lineGap: 3 });
    cy += bodyH + 6;
  }
  items.forEach((it) => {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.TEXT)
      .text(txt(it.label), M + 17, cy, { width: tw * 0.4, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(tone)
      .text(txt(it.result), M + 17 + tw * 0.42, cy, { width: tw * 0.28, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
      .text(txt(it.range ? `ref ${it.range}` : ''), M + 17 + tw * 0.72, cy + 1,
        { width: tw * 0.28, lineBreak: false, ellipsis: true });
    cy += 16;
    if (hasText(it.note)) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.MUTED)
        .text(txt(it.note), M + 17, cy, { width: tw - 6, lineGap: 2 });
      cy = doc.y + 6;
    } else {
      cy += 6;
    }
  });

  ctx.y = y + h + 12;
}

function renderDisclaimer(ctx, s) {
  const doc = ctx.doc;
  const tw = CW - 28;
  doc.font('Helvetica-Oblique').fontSize(8.5);
  const h = doc.heightOfString(txt(s.body), { width: tw, lineGap: 2.5 });
  ensure(ctx, h + 40);
  ctx.y += 6;
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.y += 10;
  box(doc, M, ctx.y, CW, h + 30, C.DISC_BG, C.BORDER, 0.5, 4);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.MUTED)
    .text(txt(s.title || 'Medical Disclaimer'), M + 14, ctx.y + 10, { width: tw, lineBreak: false });
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.MUTED)
    .text(txt(s.body), M + 14, ctx.y + 23, { width: tw, lineGap: 2.5 });
  ctx.y += h + 38;
}

const RENDERERS = {
  healthmap: renderHealthMap,
  text: renderText,
  priorities: renderPriorities,
  areacards: renderAreaCards,
  markers: renderMarkers,
  progress: renderProgress,
  list: renderList,
  callout: renderCallout,
  disclaimer: renderDisclaimer
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render a graded-report document to a PDF file.
 * @param {object} doc  sanitised document from services/gradedReportDocument.js
 * @param {string} outPath
 * @returns {Promise<string>} the path written
 */
function buildGradedReportPdf(doc, outPath) {
  return new Promise((resolve, reject) => {
    try {
      const pdf = new PDFDocument({
        size: 'A4',
        margins: { top: TOP, bottom: 60, left: M, right: M },
        bufferPages: true,
        info: {
          Title: txt((doc.cover && doc.cover.title) || 'BodyBank Health Map Report'),
          Author: 'BodyBank.fit',
          Subject: 'Preventive health screening report'
        }
      });

      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });
      const stream = fs.createWriteStream(outPath);
      pdf.pipe(stream);

      const ctx = { doc: pdf, y: TOP, contentPages: new Set() };

      // Background on every page, including ones added mid-render.
      paintBg(pdf);
      pdf.on('pageAdded', () => paintBg(pdf));

      buildCover(ctx, doc.cover || {});

      const sections = (doc.sections || []).filter((s) => s && s.show !== false);
      sections.forEach((s) => {
        const render = RENDERERS[s.type];
        if (!render) return;
        if (s.pageBreak) newPage(ctx);
        try {
          render(ctx, s);
        } catch (e) {
          // One malformed section must not cost the client their whole report.
          console.error('[gradedReportPdf] section failed:', s.type, e && e.message);
        }
      });

      paintChrome(
        pdf,
        txt((doc.cover && doc.cover.clientName) || 'Member'),
        txt((doc.cover && doc.cover.screeningDateLabel) || ''),
        ctx.contentPages
      );

      pdf.end();
      stream.on('finish', () => resolve(outPath));
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildGradedReportPdf, GRADE, C };
