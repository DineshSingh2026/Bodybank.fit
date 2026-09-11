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
const PL = require('./pdfLayout');

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
  ctx.newPage();
}

/**
 * Ensure `need` points of vertical space, starting a page if not.
 *
 * Delegated to the flow, which refuses to break a page that carries no ink —
 * breaking an empty page only produces another empty one.
 */
function ensure(ctx, need) {
  return ctx.ensure(need);
}

function paintChrome(doc, clientName, dateLabel, contentPages) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i += 1) {
    if (!contentPages.has(i)) continue;
    doc.switchToPage(i);
    // The footer sits BELOW the bottom margin. PDFKit tracks doc.y through every
    // text() call, so writing down there leaves the cursor past the margin and the
    // next write auto-adds a page — which is how painting chrome onto 11 pages
    // silently produced 22 blank ones. Dropping the bottom margin for the duration
    // keeps the flow engine out of it. The fitting helpers below then keep the
    // wrapper out of it entirely: `{ width, lineBreak: false }` still wraps in
    // PDFKit, and a long client name wrapped to a second line under the paper.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GOLD);
    const wm = 'BodyBank.fit';
    const tw = doc.widthOfString(wm);
    PL.drawSingle(doc, wm, PAGE_W - M - tw, 28, 0, {});
    if (LOGO) { try { doc.image(LOGO, PAGE_W - M - tw - 20, 24, { width: 15, height: 15 }); } catch (_) { /* ignore */ } }

    doc.rect(0, PAGE_H - 44, PAGE_W, 44).fill(C.SURFACE);
    doc.rect(M, PAGE_H - 44, CW, 0.4).fill(C.BORDER);
    const right = txt(`${dateLabel}  ·  Page ${i + 1} of ${total}`);
    doc.font('Helvetica').fontSize(7.5);
    const rightW = Math.min(CW * 0.45, doc.widthOfString(right));
    PL.drawFit(doc, right, M + CW - rightW, PAGE_H - 26, rightW, { font: 'Helvetica', size: 7.5, color: C.MUTED, align: 'right' });
    PL.drawFit(doc, txt(`BodyBank.fit  ·  Health Map Report  ·  ${clientName}`), M, PAGE_H - 26,
      CW - rightW - 14, { font: 'Helvetica', size: 7.5, color: C.MUTED });
    doc.restore();
    doc.page.margins.bottom = savedBottom;
  }
}

function sectionHeading(ctx, title, subtitle) {
  const doc = ctx.doc;
  if (!hasText(title)) return;
  const titleL = PL.layout(doc, title, { font: 'Helvetica-Bold', size: 15, width: CW });
  const subL = hasText(subtitle)
    ? PL.layout(doc, subtitle, { font: 'Helvetica', size: 9, width: CW, lineGap: 2 })
    : null;
  ensure(ctx, titleL.height + 16 + (subL ? subL.height + 8 : 0));
  PL.drawLayout(doc, titleL, M, ctx.y, { color: C.GOLD });
  ctx.advance(titleL.height + 6);
  doc.save().rect(M, ctx.y, 46, 1.6).fill(C.GOLD_DIM).restore();
  doc.save().rect(M + 46, ctx.y, CW - 46, 0.5).fill(C.BORDER).restore();
  ctx.advance(10);
  if (subL) {
    PL.drawLayout(doc, subL, M, ctx.y, { color: C.MUTED });
    ctx.advance(subL.height + 8);
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
  PL.drawFit(doc, letter, x, y + size * 0.2, size, { font: 'Helvetica-Bold', size: size * 0.56, color: t.ink, align: 'center' });
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

/**
 * Flowing prose. Written through the flow, line by line, so a paragraph longer
 * than the room left simply continues on the next page — instead of letting
 * PDFKit add a page the renderer does not know about (which is how pages went
 * out without a footer).
 */
function bodyText(ctx, text, opts) {
  const o = opts || {};
  const s = txt(text);
  if (!s.trim()) return;
  PL.flowText(ctx, s, {
    x: o.x != null ? o.x : M,
    width: o.width || CW,
    font: o.font || 'Helvetica',
    size: o.size || 9.5,
    lineGap: o.lineGap != null ? o.lineGap : 3,
    align: o.align || 'left',
    color: o.color || C.TEXT,
    spaceAfter: o.spaceAfter != null ? o.spaceAfter : 8
  });
}

/** A small uppercase layer label — RESULT / STATUS / BODYBANK INSIGHT / NEXT STEP. */
function layerLabel(doc, x, y, text, color, width) {
  PL.drawFit(doc, String(text).toUpperCase(), x, y, width == null ? 150 : width,
    { font: 'Helvetica-Bold', size: 6.5, color: color || C.DIM, characterSpacing: 0.6 });
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
  const brandX = M + (LOGO ? 50 : 0);
  PL.drawFit(doc, 'BodyBank.fit', brandX, ctx.y + 8, CW - (brandX - M), { font: 'Helvetica-Bold', size: 11, color: C.GOLD });
  PL.drawFit(doc, 'Preventive Health Screening', brandX, ctx.y + 23, CW - (brandX - M), { font: 'Helvetica', size: 8, color: C.MUTED });
  ctx.advance(58);

  ctx.advance(PL.drawText(doc, cover.title, M, ctx.y, { font: 'Helvetica-Bold', size: 26, width: CW, color: C.TEXT }) + 10);

  doc.save().rect(M, ctx.y, 64, 2).fill(C.GOLD).restore();
  ctx.advance(18);

  // Client card. The card is split into two columns that never overlap: the
  // date plate takes a fixed share on the right, the name and meta take what is
  // left. Both are then FITTED TO THEIR OWN COLUMN — drawing the date
  // right-aligned across the full card width instead let a long date reach back
  // across the card and land on top of the client meta line.
  const dateLabel = txt(cover.screeningDateLabel || cover.screeningDate || '');
  const dateW = CW * 0.34;
  const dateX = M + CW - 16 - dateW;
  const nameW = dateX - (M + 16) - 14;
  const cardH = 62;
  box(doc, M, ctx.y, CW, cardH, C.SURFACE, C.BORDER, 0.6, 6);
  PL.drawFit(doc, cover.clientName || 'Member', M + 16, ctx.y + 13, nameW, { font: 'Helvetica-Bold', size: 15, minSize: 8, color: C.TEXT });
  PL.drawFit(doc, cover.clientMeta || '', M + 16, ctx.y + 33, nameW, { font: 'Helvetica', size: 9, minSize: 6.5, color: C.MUTED });
  PL.drawFit(doc, 'SCREENING DATE', dateX, ctx.y + 16, dateW, { font: 'Helvetica', size: 8, color: C.MUTED, align: 'right' });
  PL.drawFit(doc, dateLabel, dateX, ctx.y + 30, dateW, { font: 'Helvetica-Bold', size: 10.5, minSize: 6.5, color: C.GOLD, align: 'right' });
  ctx.advance(cardH + 14);

  // Stat strip
  const stats = (cover.stats || []).filter((s) => s.show !== false);
  if (stats.length) {
    const gap = 10;
    const w = (CW - gap * (stats.length - 1)) / stats.length;
    const h = 50;
    stats.forEach((s, i) => {
      const x = M + i * (w + gap);
      box(doc, x, ctx.y, w, h, C.DARK, C.BORDER_SOFT, 0.5, 6);
      PL.drawFit(doc, s.value, x + 4, ctx.y + 10, w - 8, { font: 'Helvetica-Bold', size: 19, minSize: 8, color: C.GOLD, align: 'center' });
      PL.drawFit(doc, String(s.label).toUpperCase(), x + 4, ctx.y + 33, w - 8,
        { font: 'Helvetica', size: 7.5, minSize: 5.5, color: C.MUTED, align: 'center', characterSpacing: 0.5 });
    });
    ctx.advance(h + 16);
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
      // `ellipsis: true` is not a clip either — PDFKit only honours it inside
      // its line wrapper, which it then also uses to WRAP, so a long area name
      // ran onto a second line and out through the bottom of its tile. Both
      // labels are fitted to the tile instead.
      PL.drawFit(doc, a.label, tx, y + 9, tw, { font: 'Helvetica-Bold', size: 10, minSize: 7, color: C.TEXT });
      PL.drawFit(doc, a.gradeLabel || gradeTone(a.grade).label, tx, y + 22, tw,
        { font: 'Helvetica', size: 7.8, minSize: 6, color: gradeTone(a.grade).fill });

      severityPips(doc, tx, y + 36, Math.min(tw, 70), a.grade);

      if (a.previousGrade && a.previousGrade !== a.grade) {
        PL.drawFit(doc, `was ${a.previousGrade}`, x + w - 48, y + 35, 38,
          { font: 'Helvetica', size: 7.5, color: C.MUTED, align: 'right' });
      }
      // A grade that held needs no annotation. Printing 'no change' on six of
      // seven tiles turns the one tile that DID move into noise.

      if (col === cols - 1 || i === areas.length - 1) ctx.advance(h + gap);
    });
  }

  if (s.legend !== false) {
    ensure(ctx, 24);
    let lx = M;
    ['A', 'B', 'C', 'D'].forEach((g) => {
      const t = gradeTone(g);
      const label = txt(`${g} ${t.label}`);
      doc.font('Helvetica').fontSize(7.5);
      const lw = doc.widthOfString(label);
      // The legend is a single strip: an entry that will not fit in the room
      // left is dropped rather than drawn past the content column.
      if (lx + 12 + lw > M + CW) return;
      box(doc, lx, ctx.y + 2, 8, 8, t.fill, null, 0, 2);
      PL.drawFit(doc, label, lx + 12, ctx.y + 2, M + CW - lx - 12, { font: 'Helvetica', size: 7.5, color: C.MUTED });
      lx += 14 + lw + 16;
    });
    ctx.advance(20);
  }

  const na = (s.notAssessed || []).filter((a) => a.show !== false);
  if (na.length) {
    // One flowing paragraph rather than a row per area. This block is genuinely
    // secondary — it explains a gap, it does not report a finding — so it earns a
    // couple of lines, not a quarter of page one.
    const line = na.map((a) => `${a.label} (needs ${a.needs})`).join(';  ');
    ensure(ctx, 30);
    PL.drawFit(doc, s.notAssessedTitle || 'Not assessed in this screening', M, ctx.y, CW,
      { font: 'Helvetica-Bold', size: 8.5, color: C.MUTED });
    ctx.advance(13);
    PL.flowText(ctx, line, { x: M, width: CW - 14, font: 'Helvetica', size: 8, lineGap: 2, color: C.DIM, spaceAfter: 8 });
  }
}

function renderText(ctx, s) {
  const doc = ctx.doc;
  if (s.variant === 'lead') {
    const body = txt(s.body);
    if (!body.trim()) return;
    // The lead sits in a single tinted box, so it is capped to a page: a lead
    // taller than the paper has no box that could hold it.
    const L = PL.layout(doc, body, { font: 'Helvetica', size: 12, width: CW - 32, lineGap: 4, maxHeight: (BOTTOM - TOP) - 40 });
    ensure(ctx, L.height + 30);
    box(doc, M, ctx.y, CW, L.height + 26, C.SURFACE2, null, 0, 6);
    doc.save().rect(M, ctx.y, 2.5, L.height + 26).fill(C.GOLD).restore();
    PL.drawLayout(doc, L, M + 18, ctx.y + 13, { color: C.TEXT });
    ctx.advance(L.height + 34);
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
    // Every block inside the card is measured before the card is drawn, and the
    // title is allowed the lines it needs: a two-line priority title used to run
    // straight through the RESULT layer beneath it, because the header was
    // assumed to be a fixed 46pt tall.
    const room = (BOTTOM - TOP) - 30;
    const titleL = PL.layout(doc, p.title, { font: 'Helvetica-Bold', size: 13, width: CW - 58, maxLines: 2 });
    const headH = Math.max(46, 15 + titleL.height + 4 + 12 + 6);
    const whyL = PL.layout(doc, p.whyItMatters, { font: 'Helvetica', size: 9, width: tw, lineGap: 2.5, maxHeight: room * 0.45 });
    const stepL = PL.layout(doc, p.nextStep, { font: 'Helvetica', size: 9, width: tw, lineGap: 2.5, maxHeight: room * 0.35 });
    const proH = p.requiresProfessional && hasText(p.professionalNote) ? 18 : 0;
    const h = headH + 8 + 30 + 11 + whyL.height + 10 + 11 + stepL.height + proH + 16;

    ensure(ctx, h + 12);
    const y = ctx.y;
    box(doc, M, y, CW, h, C.SURFACE, C.BORDER_SOFT, 0.6, 6);
    const tone = gradeTone(p.grade);
    doc.save().rect(M, y, 3, h).fill(tone.fill).restore();

    // rank + title
    box(doc, M + 16, y + 15, 18, 18, tone.fill, null, 0, 9);
    PL.drawFit(doc, String(p.rank), M + 16, y + 20, 18, { font: 'Helvetica-Bold', size: 9, color: tone.ink, align: 'center' });

    PL.drawLayout(doc, titleL, M + 42, y + 15, { color: C.TEXT });
    PL.drawFit(doc, `${p.areaLabel}  ·  Grade ${p.grade}`, M + 42, y + 15 + titleL.height + 3, CW - 58,
      { font: 'Helvetica', size: 8, color: C.MUTED });

    let cy = y + headH + 8;

    // RESULT and STATUS share one row; each is fitted to its own half so a long
    // result can never cross into the status column.
    layerLabel(doc, M + 16, cy, 'Result', null, tw * 0.66);
    PL.drawFit(doc, p.result, M + 16, cy + 10, tw * 0.66, { font: 'Helvetica-Bold', size: 10.5, minSize: 7, color: C.TEXT });
    layerLabel(doc, M + 16 + tw * 0.68, cy, 'Status', null, tw * 0.32);
    PL.drawFit(doc, p.status, M + 16 + tw * 0.68, cy + 10, tw * 0.32, { font: 'Helvetica-Bold', size: 10.5, minSize: 7, color: tone.fill });
    cy += 30;

    layerLabel(doc, M + 16, cy, 'Why it matters', null, tw);
    PL.drawLayout(doc, whyL, M + 16, cy + 11, { color: C.TEXT });
    cy += 11 + whyL.height + 10;

    layerLabel(doc, M + 16, cy, 'Next step', C.GOLD_DIM, tw);
    PL.drawLayout(doc, stepL, M + 16, cy + 11, { color: C.TEXT });
    cy += 11 + stepL.height;

    if (proH) {
      PL.drawFit(doc, '>  ' + p.professionalNote, M + 16, cy + 6, tw, { font: 'Helvetica-Bold', size: 8.5, minSize: 6.5, color: GRADE.D.fill });
    }

    ctx.y = y + h + 12;
    ctx.touch();
  });
}

function renderAreaCards(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);

  (s.cards || []).filter((c) => c.show !== false).forEach((card) => {
    const tone = gradeTone(card.grade);
    const tw = CW - 32;

    // Header block — kept with at least the summary so a card never orphans.
    const sumH = hasText(card.summary)
      ? PL.measure(doc, card.summary, { font: 'Helvetica', size: 9, width: tw, lineGap: 2.5 })
      : 0;
    ensure(ctx, 54 + Math.min(sumH, 60) + 24);

    const y = ctx.y;
    box(doc, M, y, CW, 42, C.SURFACE2, null, 0, 6);
    doc.save().rect(M, y, 3, 42).fill(tone.fill).restore();
    gradeBadge(doc, M + 14, y + 6, 30, card.grade);
    const headW = CW - (card.requiresProfessional ? 190 : 70);
    PL.drawFit(doc, card.label, M + 54, y + 10, headW, { font: 'Helvetica-Bold', size: 12.5, minSize: 8, color: C.TEXT });
    PL.drawFit(doc, card.gradeLabel || tone.label, M + 54, y + 25, headW, { font: 'Helvetica', size: 8.5, minSize: 6.5, color: tone.fill });
    if (card.requiresProfessional) {
      PL.drawFit(doc, 'DISCUSS WITH A PROFESSIONAL', M, y + 17, CW - 14,
        { font: 'Helvetica-Bold', size: 7.5, color: GRADE.D.fill, align: 'right' });
    }
    ctx.y = y + 50;
    ctx.touch();

    if (hasText(card.summary)) bodyText(ctx, card.summary, { size: 9, spaceAfter: 6 });
    if (hasText(card.trendLine)) {
      bodyText(ctx, card.trendLine, { size: 8.5, color: C.MUTED, spaceAfter: 8 });
    }

    const findings = (card.findings || []).filter((f) => f.show !== false);
    findings.forEach((f) => {
      const insL = hasText(f.insight)
        ? PL.layout(doc, f.insight, { font: 'Helvetica', size: 8.5, width: tw - 8, lineGap: 2, maxHeight: (BOTTOM - TOP) - 44 })
        : null;
      const insH = insL ? insL.height : 0;
      const rowH = 30 + insH + (insH ? 6 : 0);
      ensure(ctx, rowH + 4);
      const fy = ctx.y;
      box(doc, M, fy, CW, rowH, C.DARK, null, 0, 4);

      // Four columns on one line. Each is fitted to its own share, so a long
      // marker name shrinks inside its column instead of running into the
      // result beside it.
      PL.drawFit(doc, f.label, M + 12, fy + 8, CW * 0.34 - 14, { font: 'Helvetica-Bold', size: 9.5, minSize: 6.5, color: C.TEXT });
      PL.drawFit(doc, f.result, M + CW * 0.37, fy + 8, CW * 0.21, { font: 'Helvetica-Bold', size: 9.5, minSize: 6.5, color: C.TEXT });
      PL.drawFit(doc, f.range ? `ref ${f.range}` : '', M + CW * 0.59, fy + 9, CW * 0.17, { font: 'Helvetica', size: 8, minSize: 6, color: C.MUTED });

      const stCol = f.status === 'Within range' ? C.MUTED : tone.fill;
      PL.drawFit(doc, f.status, M + CW * 0.77, fy + 9, CW * 0.21 - 12,
        { font: 'Helvetica-Bold', size: 8.5, minSize: 6, color: stCol, align: 'right' });

      if (insL) PL.drawLayout(doc, insL, M + 12, fy + 24, { color: C.MUTED });
      ctx.y = fy + rowH + 4;
      ctx.touch();
    });

    if (hasText(card.focus)) {
      const fL = PL.layout(doc, card.focus, { font: 'Helvetica', size: 9, width: tw - 46, lineGap: 2.5, maxHeight: (BOTTOM - TOP) - 30 });
      ensure(ctx, fL.height + 24);
      const fy = ctx.y;
      box(doc, M, fy, CW, fL.height + 20, '#1b2320', null, 0, 4);
      layerLabel(doc, M + 12, fy + 8, 'Focus on', C.GOLD_DIM, 42);
      PL.drawLayout(doc, fL, M + 56, fy + 7, { color: C.TEXT });
      ctx.y = fy + fL.height + 26;
      ctx.touch();
    }

    ctx.advance(8);
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
      PL.drawFit(doc, c.header.toUpperCase(), xs[i] + pad, ctx.y + 7, c.frac * CW - 2 * pad,
        { font: 'Helvetica-Bold', size: 7, color: C.MUTED, align: c.align, characterSpacing: 0.5 });
    });
    ctx.advance(20);
  };

  (s.groups || []).filter((g) => g.show !== false).forEach((g) => {
    const markers = (g.markers || []).filter((m) => m.show !== false);
    if (!markers.length) return;

    ensure(ctx, 56);
    const gL = PL.layout(doc, g.label, { font: 'Helvetica-Bold', size: 10, width: CW, maxLines: 2 });
    PL.drawLayout(doc, gL, M, ctx.y, { color: C.GOLD_DIM });
    ctx.advance(gL.height + 6);
    drawHeader();

    markers.forEach((m, ri) => {
      const rowH = 19;
      // The row is a fixed 19pt, so every cell is fitted to its column: the
      // trend vocabulary is fixed, but marker names and lab ranges are not.
      if (ctx.y + rowH > BOTTOM && !ctx.isFresh()) { newPage(ctx); drawHeader(); }
      box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : null);
      const ty = ctx.y + 5.5;

      PL.drawFit(doc, m.label, xs[0] + pad, ty, cols[0].frac * CW - 2 * pad,
        { font: 'Helvetica', size: 8.5, minSize: 6, color: C.TEXT });
      PL.drawFit(doc, m.result, xs[1] + pad, ty, cols[1].frac * CW - 2 * pad,
        { font: 'Helvetica-Bold', size: 8.5, minSize: 6, color: C.TEXT });
      PL.drawFit(doc, txt(m.range) + (m.rangeSource === 'BODYBANK_PREFERRED' ? ' *' : ''),
        xs[2] + pad, ty + 0.4, cols[2].frac * CW - 2 * pad,
        { font: 'Helvetica', size: 8, minSize: 5.5, color: C.MUTED });

      const within = m.status === 'Within range';
      PL.drawFit(doc, m.status, xs[3] + pad, ty, cols[3].frac * CW - 2 * pad,
        { font: within ? 'Helvetica' : 'Helvetica-Bold', size: 8.5, minSize: 6, color: within ? C.MUTED : C.TEXT });

      if (m.trend && m.trend !== 'NOT_COMPARABLE') {
        PL.drawFit(doc, m.trendLabel || '', xs[4] + pad, ty + 0.6, cols[4].frac * CW - 2 * pad,
          { font: 'Helvetica', size: 7, minSize: 5.5, color: TREND_TONE[m.trend] || C.DIM, align: 'right' });
      }
      ctx.advance(rowH);
    });

    doc.save().rect(M, ctx.y, CW, 0.4).fill(C.BORDER_SOFT).restore();
    ctx.advance(14);
  });

  // Footnote for any BodyBank-supplied range used above.
  const usedPreferred = (s.groups || []).some((g) => (g.markers || [])
    .some((m) => m.rangeSource === 'BODYBANK_PREFERRED'));
  if (usedPreferred) {
    ensure(ctx, 20);
    PL.flowText(ctx, '*  Your lab did not print a reference range for this marker, so a BodyBank preferred range was used and is shown here.',
      { x: M, width: CW, font: 'Helvetica-Oblique', size: 7.5, lineGap: 2, color: C.MUTED, spaceAfter: 8 });
  }
}

function renderProgress(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);

  if (hasText(s.caution)) {
    const L = PL.layout(doc, s.caution, { font: 'Helvetica', size: 8.5, width: CW - 28, maxHeight: (BOTTOM - TOP) - 30 });
    ensure(ctx, L.height + 22);
    box(doc, M, ctx.y, CW, L.height + 16, '#241f16', null, 0, 4);
    PL.drawLayout(doc, L, M + 14, ctx.y + 8, { color: C.GOLD });
    ctx.advance(L.height + 24);
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
    PL.drawFit(doc, `${g.title}  (${items.length})`, M, ctx.y, CW, { font: 'Helvetica-Bold', size: 10, color: tone });
    ctx.advance(18);

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
      PL.drawFit(doc, it.label, M + 10, ty, CW * 0.42 - 10, { font: 'Helvetica', size: 8.5, minSize: 6, color: C.TEXT });

      const move = it.previous ? `${it.previous}  ->  ${it.current}` : txt(it.current);
      PL.drawFit(doc, move, M + CW * 0.44, ty, CW * 0.33, { font: 'Helvetica-Bold', size: 8.5, minSize: 6, color: C.TEXT });

      let tag = '';
      if (it.newReason === 'FIRST_MEASURED') tag = 'first measured';
      else if (it.newReason === 'MOVED_OUT_OF_RANGE') tag = 'moved out of range';
      if (tag) {
        PL.drawFit(doc, tag, M + CW * 0.78, ty + 0.5, CW * 0.22 - 10,
          { font: 'Helvetica-Oblique', size: 7.5, minSize: 5.5, color: C.MUTED, align: 'right' });
      }
      ctx.advance(rowH);
    });
    ctx.advance(12);
  });
}

function renderList(ctx, s) {
  const doc = ctx.doc;
  sectionHeading(ctx, s.title, s.subtitle);
  const items = (s.items || []).filter((i) => i.show !== false);
  items.forEach((it, i) => {
    const marker = s.style === 'bulleted' ? '•' : String(i + 1);
    const tw = CW - 40;
    const L = PL.layout(doc, it.text, { font: 'Helvetica', size: 9.5, width: tw, lineGap: 3, maxHeight: (BOTTOM - TOP) - 24 });
    ensure(ctx, L.height + 18);
    const y = ctx.y;
    box(doc, M, y, 20, 20, it.requiresProfessional ? GRADE.D.fill : C.SURFACE2, null, 0, 10);
    PL.drawFit(doc, marker, M, y + 5.5, 20,
      { font: 'Helvetica-Bold', size: 9, color: it.requiresProfessional ? GRADE.D.ink : C.GOLD, align: 'center' });
    PL.drawLayout(doc, L, M + 32, y + 4, { color: C.TEXT });
    ctx.y = Math.max(y + 26, y + 4 + L.height + 10);
    ctx.touch();
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
  const room = (BOTTOM - TOP) - 40;
  // Every piece is laid out up front and the box is sized from those layouts,
  // then the very same layouts are drawn into it. The note under an item used
  // to be measured at one width and drawn at another, so a long note pushed the
  // last item through the bottom of the callout.
  const bodyL = hasText(s.body)
    ? PL.layout(doc, s.body, { font: 'Helvetica', size: 9, width: tw, lineGap: 3, maxHeight: room * 0.6 })
    : null;
  const itemLs = items.map((it) => ({
    it,
    noteL: hasText(it.note)
      ? PL.layout(doc, it.note, { font: 'Helvetica', size: 8.5, width: tw - 6, lineGap: 2, maxHeight: room * 0.3 })
      : null
  }));
  const titleL = hasText(s.title)
    ? PL.layout(doc, s.title, { font: 'Helvetica-Bold', size: 10.5, width: tw, maxLines: 2 })
    : null;
  const itemsH = itemLs.reduce((acc, e) => acc + 16 + (e.noteL ? e.noteL.height + 6 : 6), 0);
  const h = 14 + (titleL ? titleL.height + 6 : 0) + (bodyL ? bodyL.height + 6 : 0) + itemsH + 12;

  ensure(ctx, h + 10);
  const y = ctx.y;
  box(doc, M, y, CW, h, bg, null, 0, 6);
  doc.save().rect(M, y, 3, h).fill(tone).restore();

  let cy = y + 14;
  if (titleL) {
    PL.drawLayout(doc, titleL, M + 17, cy, { color: tone });
    cy += titleL.height + 6;
  }
  if (bodyL) {
    PL.drawLayout(doc, bodyL, M + 17, cy, { color: C.TEXT });
    cy += bodyL.height + 6;
  }
  itemLs.forEach((e) => {
    PL.drawFit(doc, e.it.label, M + 17, cy, tw * 0.4, { font: 'Helvetica-Bold', size: 9.5, minSize: 6.5, color: C.TEXT });
    PL.drawFit(doc, e.it.result, M + 17 + tw * 0.42, cy, tw * 0.28, { font: 'Helvetica-Bold', size: 9.5, minSize: 6.5, color: tone });
    PL.drawFit(doc, e.it.range ? `ref ${e.it.range}` : '', M + 17 + tw * 0.72, cy + 1, tw * 0.26,
      { font: 'Helvetica', size: 8, minSize: 6, color: C.MUTED });
    cy += 16;
    if (e.noteL) {
      PL.drawLayout(doc, e.noteL, M + 17, cy, { color: C.MUTED });
      cy += e.noteL.height + 6;
    } else {
      cy += 6;
    }
  });

  ctx.y = y + h + 12;
  ctx.touch();
}

function renderDisclaimer(ctx, s) {
  const doc = ctx.doc;
  const tw = CW - 28;
  const L = PL.layout(doc, s.body, { font: 'Helvetica-Oblique', size: 8.5, width: tw, lineGap: 2.5, maxHeight: (BOTTOM - TOP) - 50 });
  ensure(ctx, L.height + 46);
  ctx.advance(6);
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.advance(10);
  box(doc, M, ctx.y, CW, L.height + 30, C.DISC_BG, C.BORDER, 0.5, 4);
  PL.drawFit(doc, s.title || 'Medical Disclaimer', M + 14, ctx.y + 10, tw, { font: 'Helvetica-Bold', size: 8.5, color: C.MUTED });
  PL.drawLayout(doc, L, M + 14, ctx.y + 23, { color: C.MUTED });
  ctx.advance(L.height + 38);
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

      // Background on every page, including ones added mid-render.
      paintBg(pdf);

      // The flow owns pagination and page bookkeeping. Registering pages here
      // rather than only inside newPage() is what stops a page from going out
      // without its footer: pages this renderer did not open itself were never
      // added to the set, so chrome skipped them.
      const ctx = PL.createFlow(pdf, {
        top: TOP, bottom: BOTTOM, left: M, width: CW,
        claimFirstPage: false,
        onPage: (d) => paintBg(d)
      });
      ctx.contentPages = ctx.pages;

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
