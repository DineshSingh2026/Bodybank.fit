'use strict';

/**
 * BodyBank — HEALTH MAP 360 PDF.
 *
 * The 360 edition prints through the standard Health Map renderer
 * (services/gradedReportPdfKit.js): same page, same palette, same cover, same
 * chrome, and every standard section is drawn by the standard code. This file adds
 * only the two section types the edition introduces:
 *
 *   insights  rows of cross-marker patterns or calculated indices
 *   signoff   the reviewing doctor's name, registration and signature
 *
 * ─── LAYOUT RULE ──────────────────────────────────────────────────────────────
 * Nothing here calls doc.text(). Every string goes through services/pdfLayout.js,
 * and each card follows the same three steps: lay every piece of text out, size
 * the card from those layouts, then draw those same layouts. A card can therefore
 * never be shorter than its contents, and columns are fitted to their own width so
 * one can never run into the next. Every block is capped below a page in height,
 * so it always fits where `ensure()` places it. tests/pdf-layout-audit.js renders
 * this edition with empty, normal and extreme data and fails on any overflow,
 * collision, out-of-box text or blank page.
 */

const { buildGradedReportPdf, GRADE, C, kit } = require('./gradedReportPdfKit');
const completeDoc = require('./completeReportDocument');
const { LEVEL } = require('./complete/insights');

const { PL, txt, hasText, box, ensure, sectionHeading, layerLabel, M, CW, TOP, BOTTOM } = kit;

const FOOTER_LABEL = 'Health Map 360 Report';
const COVER_TAGLINE = 'Preventive Health Screening  ·  360 Edition';
const DRAFT_WATERMARK = 'DRAFT - AWAITING DOCTOR REVIEW';
const PAPER = '#f4f1ea';

function levelTone(level) {
  if (level === LEVEL.FLAG) return GRADE.D.fill;
  if (level === LEVEL.WATCH) return GRADE.C.fill;
  if (level === LEVEL.OK) return GRADE.A.fill;
  return C.MUTED;
}

/**
 * Patterns and calculated indices. One card per row; cards flow across pages and
 * a card is never split.
 */
function renderInsights(ctx, s) {
  const doc = ctx.doc;
  const rows = (s.rows || []).filter((r) => r && r.show !== false && (hasText(r.label) || hasText(r.note)));
  if (!rows.length) return;
  sectionHeading(ctx, s.title, s.subtitle);

  const pad = 16;
  const tw = CW - pad * 2;
  const room = (BOTTOM - TOP) - 40;
  const leftW = tw * 0.64;
  const rightX = M + pad + tw * 0.68;
  const rightW = tw * 0.32;

  rows.forEach((r) => {
    const tone = levelTone(r.level);
    const hasFigure = hasText(r.result);

    const labelL = PL.layout(doc, r.label, { font: 'Helvetica-Bold', size: 11, width: leftW, lineGap: 1.5, maxLines: 2 });
    const basisL = hasText(r.basis)
      ? PL.layout(doc, r.basis, { font: 'Helvetica', size: 7.8, width: tw, lineGap: 1.5, maxLines: 3 })
      : null;
    const noteL = hasText(r.note)
      ? PL.layout(doc, r.note, { font: 'Helvetica', size: 9, width: tw, lineGap: 2.5, maxHeight: room * 0.4 })
      : null;
    const actionL = hasText(r.action)
      ? PL.layout(doc, r.action, { font: 'Helvetica', size: 9, width: tw, lineGap: 2.5, maxHeight: room * 0.25 })
      : null;

    const headH = Math.max(labelL.height, 13);
    const figureH = hasFigure ? 22 : 0;
    const h = 13 + headH + 6 + figureH
      + (basisL ? basisL.height + 8 : 0)
      + (noteL ? noteL.height + 8 : 0)
      + (actionL ? 11 + actionL.height + 8 : 0)
      + 6;

    ensure(ctx, h + 10);
    const y = ctx.y;
    box(doc, M, y, CW, h, C.SURFACE, C.BORDER_SOFT, 0.6, 6);
    doc.save().rect(M, y, 3, h).fill(tone).restore();

    let cy = y + 13;
    PL.drawLayout(doc, labelL, M + pad, cy, { color: C.TEXT });
    PL.drawFit(doc, r.status, rightX, cy + 1.5, rightW, { font: 'Helvetica-Bold', size: 8.5, minSize: 6, color: tone, align: 'right' });
    cy += headH + 6;

    if (hasFigure) {
      // The figure and its preferred range share a line, each fitted to its own column.
      PL.drawFit(doc, r.result, M + pad, cy, tw * 0.4, { font: 'Helvetica-Bold', size: 14, minSize: 8, color: tone });
      PL.drawFit(doc, r.range, M + pad + tw * 0.44, cy + 4.5, tw * 0.56, { font: 'Helvetica', size: 8.5, minSize: 6, color: C.MUTED });
      cy += figureH;
    }
    if (basisL) {
      PL.drawLayout(doc, basisL, M + pad, cy, { color: C.DIM });
      cy += basisL.height + 8;
    }
    if (noteL) {
      PL.drawLayout(doc, noteL, M + pad, cy, { color: C.TEXT });
      cy += noteL.height + 8;
    }
    if (actionL) {
      layerLabel(doc, M + pad, cy, 'What to do', C.GOLD_DIM, tw);
      PL.drawLayout(doc, actionL, M + pad, cy + 11, { color: C.TEXT });
    }

    ctx.y = y + h + 10;
    ctx.touch();
  });
}

/** 'YYYY-MM-DD…' or an ISO timestamp → "6 October 2026", read in India time. */
function signedDateLabel(v) {
  const s = String(v || '');
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const ist = new Date(d.getTime() + 330 * 60000);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/**
 * The doctor's sign-off. Printed only when the report has been signed: an unsigned
 * report shows no doctor at all rather than a name without a signature.
 */
function renderSignoff(ctx, s) {
  if (!s.signed || !hasText(s.doctorName)) return;
  const doc = ctx.doc;
  const pad = 16;
  const tw = CW - pad * 2;
  const leftW = tw * 0.5;
  const rightX = M + pad + tw * 0.56;
  const rightW = tw * 0.44;
  const plateW = Math.min(170, leftW);
  const plateH = 50;
  const signature = ctx.assets && ctx.assets.signature;

  const stmtL = PL.layout(doc, s.statement, { font: 'Helvetica', size: 8.5, width: rightW, lineGap: 2, maxLines: 6 });
  const leftH = (signature ? plateH + 8 : 0) + 14 + 12 + 12;
  const rightH = 11 + 13 + 6 + stmtL.height;
  const h = 14 + Math.max(leftH, rightH) + 14;

  ensure(ctx, h + 12);
  const y = ctx.y;
  box(doc, M, y, CW, h, C.SURFACE2, C.BORDER, 0.6, 6);
  doc.save().rect(M, y, 3, h).fill(C.GOLD).restore();

  let cy = y + 14;
  if (signature) {
    // Signatures are dark ink, so they sit on a paper-coloured plate, not the dark card.
    box(doc, M + pad, cy, plateW, plateH, PAPER, null, 0, 4);
    try {
      doc.image(signature, M + pad + 6, cy + 4, { fit: [plateW - 12, plateH - 8], align: 'center', valign: 'center' });
    } catch (_) { /* an unreadable image must not cost the client their report */ }
    cy += plateH + 8;
  }
  PL.drawFit(doc, s.doctorName, M + pad, cy, leftW, { font: 'Helvetica-Bold', size: 11, minSize: 7, color: C.TEXT });
  PL.drawFit(doc, s.qualification, M + pad, cy + 14, leftW, { font: 'Helvetica', size: 8.5, minSize: 6, color: C.MUTED });
  PL.drawFit(doc, s.regNo ? `Reg. no. ${txt(s.regNo)}` : '', M + pad, cy + 26, leftW, { font: 'Helvetica', size: 8.5, minSize: 6, color: C.MUTED });

  const ry = y + 14;
  layerLabel(doc, rightX, ry, 'Reviewed and signed', C.GOLD_DIM, rightW);
  PL.drawFit(doc, signedDateLabel(s.signedAt), rightX, ry + 11, rightW, { font: 'Helvetica-Bold', size: 9.5, minSize: 7, color: C.TEXT });
  PL.drawLayout(doc, stmtL, rightX, ry + 11 + 13 + 6, { color: C.MUTED });

  ctx.y = y + h + 14;
  ctx.touch();
}

/**
 * Render a 360 document to a PDF file.
 * @param {object} doc      sanitised document from services/completeReportDocument.js
 * @param {string} outPath
 * @param {object} [opts]   { signature: Buffer } the doctor's signature image
 * @returns {Promise<string>} the path written
 */
function buildCompleteReportPdf(doc, outPath, opts) {
  const o = opts || {};
  const signed = completeDoc.isSigned(doc);
  return buildGradedReportPdf(doc, outPath, {
    renderers: { insights: renderInsights, signoff: renderSignoff },
    footerLabel: FOOTER_LABEL,
    coverTagline: COVER_TAGLINE,
    // An unsigned 360 report can be previewed by staff but is marked so it can
    // never be mistaken for the finished document.
    watermark: signed ? '' : DRAFT_WATERMARK,
    assets: { signature: signed && o.signature ? o.signature : null }
  });
}

module.exports = { buildCompleteReportPdf, renderInsights, renderSignoff, FOOTER_LABEL, DRAFT_WATERMARK };
