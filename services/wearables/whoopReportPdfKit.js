'use strict';

/**
 * BodyBank.fit — Whoop / readiness REPORT PDF (pure Node, PDFKit).
 *
 * Same dark-green brand system + gold coin as services/healthReportPdfKit.js and
 * services/comparisonReportPdfKit.js.
 *
 * ===========================================================================
 * THE ONE INVIOLABLE RULE — THIS FILE PERFORMS NO ARITHMETIC.
 * ===========================================================================
 * Every number printed here is read straight out of the `stats` object produced
 * by services/wearables/whoopStatsService.js, coerced with String(), and drawn.
 * There is no .toFixed(), no Math.round(), no unit conversion, no percentage
 * derivation and no interpolation anywhere below — the ONLY numeric helpers are
 * `fmt()` / `fmtUnit()`, which do `String(value)` and nothing else.
 *
 * That is the whole accuracy guarantee of the system: the figure in the prose,
 * the figure in the validator's fact set (flattenFactsToNumbers) and the figure
 * on this page are byte-identical, because rounding happened exactly once, in
 * the stats engine.
 *
 * A `null` fact prints as an em-dash. Never 0. Never a guess. Never "n/a as 0".
 *
 * (Layout maths — x/y coordinates, box heights, column widths — is of course
 * arithmetic, but it never touches a member's data value.)
 */

const path = require('path');
const fs = require('fs');
const PL = require('../pdfLayout');

/**
 * Fitting a FIGURE is not the same as fitting a label.
 *
 * Shortening "Anti-Mullerian Hormone…" costs the reader nothing. Shortening
 * "123456789" to "1234…" would print a number that is not the member's number,
 * which this file exists to prevent. So every numeric cell is fitted with a
 * very low floor: it shrinks as far as it must to stay inside its column, and
 * only a value that will not fit at 4.5pt is ever cut.
 */
const FIGURE_MIN = 4.5;

// ---- palette (identical to the blood-report template) ------------------------
const C = {
  BG: '#0d0f11', SURFACE: '#161a1e', SURFACE2: '#1e2328', GREEN: '#3dd68c',
  AMBER: '#f5a623', BLUE: '#4da6ff', RED: '#ff5c5c', TEXT: '#f0ede8',
  MUTED: '#8a8880', WHITE: '#ffffff', DARK: '#1a1f24', BORDER: '#2a2f35',
  INC_BG: '#1a2e1a', AVD_BG: '#2e1a1a', PURPLE: '#a855f7', DISC_BG: '#141414',
  GOLD: '#e6c46a', GOLD_DIM: '#c8a44e', WARN_BG: '#2e2410'
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 51;
const CW = PAGE_W - 2 * M;
const TOP = 70;
const BOTTOM = 776;          // above the (2-line) footer band
const FOOTER_H = 52;

/** WinAnsi-safe em-dash. Every null fact renders as exactly this. */
const DASH = '—';

function resolveLogo() {
  const dir = path.join(__dirname, '..', '..', 'public', 'img');
  const candidates = [
    'bodybank-logo.png - short.png',
    'bodybank-logo-short.png',
    'logo-bb.png',
    'Bodybank logo.png'
  ];
  for (const f of candidates) {
    const p = path.join(dir, f);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}
const LOGO = resolveLogo();

// ===========================================================================
// THE ONLY TWO NUMBER FORMATTERS IN THIS FILE
// ===========================================================================

/**
 * Print a fact exactly as the stats engine rounded it. No re-rounding, ever.
 * null / undefined / non-finite -> em-dash (never 0).
 */
function fmt(value) {
  if (value === null || value === undefined) return DASH;
  if (typeof value === 'number' && !Number.isFinite(value)) return DASH;
  if (typeof value === 'string' && value.trim() === '') return DASH;
  return String(value);
}

/** Same, with the unit string the stats engine supplied alongside the value. */
function fmtUnit(value, unit) {
  if (value === null || value === undefined) return DASH;
  if (typeof value === 'number' && !Number.isFinite(value)) return DASH;
  const s = String(value);
  const u = unit === null || unit === undefined ? '' : String(unit);
  if (!u) return s;
  return u === '%' ? s + u : s + ' ' + u;
}

// ===========================================================================
// Labels (presentation only — never touches a value)
// ===========================================================================

/** Display order + label for the metric blocks. Unit comes from the data. */
const METRIC_ROWS = [
  ['recovery', 'Recovery'],
  ['hrv', 'HRV'],
  ['restingHr', 'Resting HR'],
  ['sleepHours', 'Sleep duration'],
  ['sleepEfficiency', 'Sleep efficiency'],
  ['strain', 'Strain'],
  ['respiratoryRate', 'Respiratory rate']
];

const CORRELATION_ROWS = [
  ['sleepHoursToNextDayRecovery', 'Sleep hours -> next-day recovery'],
  ['strainToNextDayRecovery', 'Strain -> next-day recovery'],
  ['sleepEfficiencyToHrv', 'Sleep efficiency -> HRV (same day)'],
  ['napMinToNextDayRecovery', 'Nap minutes -> next-day recovery']
];

const FLAG_LABELS = {
  chronic_sleep_debt: 'Chronic sleep debt',
  declining_hrv: 'Declining HRV',
  elevated_resting_hr: 'Elevated resting heart rate',
  overreaching: 'Overreaching',
  undertraining: 'Undertraining',
  low_average_recovery: 'Low average recovery'
};

const FLAG_FIELD_LABELS = {
  avgPerNightMin: 'Avg per night (min)',
  totalMin: 'Total (min)',
  nights: 'Nights',
  thresholdMin: 'Threshold (min)',
  firstHalfMean: 'First-half mean',
  secondHalfMean: 'Second-half mean',
  deltaAbs: 'Change',
  deltaPct: 'Change (%)',
  daysHighStrainLowRecovery: 'High-strain / low-recovery days',
  daysLowStrainHighRecovery: 'Low-strain / high-recovery days',
  daysConsidered: 'Days considered',
  avgStrainOnLowRecoveryDays: 'Avg strain on low-recovery days',
  mean: 'Mean',
  thresholdPct: 'Threshold (%)',
  n: 'Days'
};

const BALANCE_LABELS = {
  overreaching: 'Overreaching',
  undertraining: 'Undertraining',
  balanced: 'Balanced',
  insufficient_data: 'Insufficient data'
};

const NOTABLE_ROWS = [
  ['bestRecovery', 'Best recovery'],
  ['worstRecovery', 'Worst recovery'],
  ['longestSleep', 'Longest sleep'],
  ['shortestSleep', 'Shortest sleep']
];

function humanize(key) {
  const s = String(key || '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function metricLabel(key, unit) {
  const found = METRIC_ROWS.find((r) => r[0] === key);
  const base = found ? found[1] : humanize(key);
  const u = unit === null || unit === undefined ? '' : String(unit);
  return u ? `${base} (${u})` : base;
}

/** Metric keys to render: the known order first, then anything else present. */
function metricKeys(metrics) {
  const src = metrics && typeof metrics === 'object' ? metrics : {};
  const known = METRIC_ROWS.map((r) => r[0]).filter((k) => Object.prototype.hasOwnProperty.call(src, k));
  const extra = Object.keys(src).filter((k) => !METRIC_ROWS.some((r) => r[0] === k));
  return known.concat(extra);
}

function directionColor(direction) {
  if (direction === 'improving') return C.GREEN;
  if (direction === 'declining') return C.RED;
  return C.MUTED;
}
function severityColor(severity) {
  if (severity === 'critical') return C.RED;
  if (severity === 'warn') return C.AMBER;
  return C.BLUE;
}
function severityBg(severity) {
  if (severity === 'critical') return C.AVD_BG;
  if (severity === 'warn') return C.WARN_BG;
  return C.DARK;
}
function balanceColor(key) {
  if (key === 'overreaching') return C.RED;
  if (key === 'undertraining') return C.AMBER;
  if (key === 'balanced') return C.GREEN;
  return C.MUTED;
}
function strengthColor(strength) {
  if (strength === 'strong') return C.GREEN;
  if (strength === 'moderate') return C.BLUE;
  if (strength === 'weak') return C.AMBER;
  return C.MUTED;
}

function formatDate(d) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// ===========================================================================
// Page chrome + primitives
// ===========================================================================

function paintBg(doc) {
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.BG);
  doc.rect(0, 0, PAGE_W, 2).fill(C.GREEN);
  doc.restore();
}

function newPage(ctx) {
  ctx.newPage();
  return ctx;
}

/** Start a new page only if the current one already has content. */
function sectionBreak(ctx) {
  ctx.sectionBreak();
}

/**
 * Guarantee `h` points of room; page-break first if not.
 * A page nothing has been drawn on is never broken — that only makes another
 * empty one.
 */
function ensure(ctx, h) {
  ctx.ensure(h);
}

/**
 * Footer on EVERY page: page number, generation date, provenance line.
 *
 * The provenance sentence is the reason this has to be careful. It is drawn
 * 25pt into a 52pt footer band that sits below the bottom margin, and PDFKit
 * wraps (and paginates) whenever a width is present — `lineBreak: false` does
 * not stop it. Two lines fitted inside the band; the wrapper is never engaged.
 */
function paintChrome(doc, name, dateStr) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const provenance =
    'Figures computed deterministically from the member’s uploaded wearable data. '
    + 'No value in this document is estimated, converted or re-rounded.';
  for (let i = 0; i < total; i += 1) {
    doc.switchToPage(range.start + i);
    doc.save();
    // top-right brand lockup
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GREEN);
    const wm = 'BodyBank.fit';
    const tw = doc.widthOfString(wm);
    PL.drawSingle(doc, wm, PAGE_W - M - tw, 27, 0, {});
    if (LOGO) { try { doc.image(LOGO, PAGE_W - M - tw - 20, 23, { width: 15, height: 15 }); } catch (_) {} }
    // footer band
    doc.rect(0, PAGE_H - FOOTER_H, PAGE_W, FOOTER_H).fill(C.SURFACE);
    doc.rect(M, PAGE_H - FOOTER_H, CW, 0.4).fill(C.BORDER);
    const right = `${dateStr}  ·  Page ${range.start + i + 1} of ${total}`;
    doc.font('Helvetica').fontSize(8);
    const rightW = Math.min(CW * 0.45, doc.widthOfString(right));
    PL.drawFit(doc, right, M + CW - rightW, PAGE_H - FOOTER_H + 10, rightW, { font: 'Helvetica', size: 8, color: C.MUTED, align: 'right' });
    PL.drawFit(doc, `BodyBank.fit  ·  Recovery & Readiness Report  ·  ${name}`,
      M, PAGE_H - FOOTER_H + 10, CW - rightW - 14, { font: 'Helvetica', size: 8, color: C.MUTED });
    PL.drawText(doc, provenance, M, PAGE_H - FOOTER_H + 25,
      { font: 'Helvetica-Oblique', size: 6.8, width: CW, lineGap: 1, color: C.MUTED, maxHeight: FOOTER_H - 27 });
    doc.restore();
  }
}

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
  const L = PL.layout(ctx.doc, text, { font: 'Helvetica-Bold', size: 15, width: CW });
  ensure(ctx, Math.max(60, L.height + 32));
  PL.drawLayout(ctx.doc, L, M, ctx.y, { color: C.GREEN });
  ctx.advance(Math.max(22, L.height + 4));
  hr(ctx, ruleColor || C.GREEN, 1);
  ctx.advance(2);
}

function subheading(ctx, text, color) {
  const L = PL.layout(ctx.doc, text, { font: 'Helvetica-Bold', size: 11, width: CW });
  ensure(ctx, Math.max(34, L.height + 20));
  PL.drawLayout(ctx.doc, L, M, ctx.y, { color: color || C.WHITE });
  ctx.advance(Math.max(17, L.height + 4));
}

const breakLongWord = PL.breakWord;

/**
 * Manual greedy wrap so pagination stays under our control (never overflows).
 * Kept as a named export because the tests drive it directly; it now delegates
 * to the shared kernel so measurement and drawing share one implementation.
 */
function wrapLines(doc, text, width) {
  return PL.wrapLines(doc, text, width);
}

/** Long-text writer: wraps, then draws line by line, adding pages as needed. */
function paragraph(ctx, text, opts) {
  opts = opts || {};
  PL.flowText(ctx, text, {
    x: opts.x === undefined ? M : opts.x,
    width: opts.width === undefined ? CW : opts.width,
    font: opts.font || 'Helvetica',
    size: opts.size === undefined ? 10 : opts.size,
    lineGap: opts.lineGap === undefined ? 3 : opts.lineGap,
    color: opts.color || C.TEXT,
    spaceAfter: opts.spaceAfter === undefined ? 8 : opts.spaceAfter
  });
}

/**
 * Label/value strip inside a card.
 *
 * Both the caption and the figure are fitted to their cell. The figure shrinks
 * all the way to FIGURE_MIN before anything is cut, because a truncated
 * statistic is a wrong statistic.
 */
function kvGrid(ctx, items, cols, opts) {
  opts = opts || {};
  const doc = ctx.doc;
  const columns = cols || 3;
  const rows = Math.ceil(items.length / columns);
  const colW = CW / columns;
  const rowH = opts.rowH || 40;
  const h = rows * rowH + 12;
  ensure(ctx, h);
  box(doc, M, ctx.y, CW, h, C.DARK, C.BORDER, 0.5);
  items.forEach((it, i) => {
    const r = Math.floor(i / columns);
    const c = i % columns;
    const x = M + c * colW + 12;
    const y = ctx.y + 10 + r * rowH;
    PL.drawFit(doc, String(it[0]).toUpperCase(), x, y, colW - 20,
      { font: 'Helvetica-Bold', size: 7.5, minSize: 5.5, color: C.MUTED });
    PL.drawFit(doc, String(it[1]), x, y + 12, colW - 20,
      { font: 'Helvetica-Bold', size: it[3] || 13, minSize: FIGURE_MIN, color: it[2] || C.WHITE });
  });
  ctx.advance(h + 10);
}

/** Paginating table (same contract as the blood-report kit). */
function table(ctx, columns, rows) {
  const doc = ctx.doc;
  const xs = [];
  let acc = M;
  columns.forEach((c) => { xs.push(acc); acc += c.frac * CW; });
  const pad = 8;
  const headerH = 22;
  const drawHeader = () => {
    box(doc, M, ctx.y, CW, headerH, C.SURFACE2);
    columns.forEach((c, i) => {
      PL.drawFit(doc, String(c.header).toUpperCase(), xs[i] + pad, ctx.y + 7, c.frac * CW - 2 * pad,
        { font: 'Helvetica-Bold', size: 7.5, minSize: 5, color: C.MUTED, align: c.align || 'left' });
    });
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.advance(headerH);
  };
  ensure(ctx, headerH + 26);
  drawHeader();
  rows.forEach((row, ri) => {
    const cells = columns.map((c) => c.get(row) || {});
    const maxRowH = ctx.pageHeight() - headerH - 2;
    // One layout per cell, used for BOTH the row height and the drawing.
    const lays = cells.map((cell, i) => PL.layout(doc, cell.text === undefined ? '' : String(cell.text), {
      font: cell.bold ? 'Helvetica-Bold' : 'Helvetica',
      size: cell.size || 9,
      width: columns[i].frac * CW - 2 * pad,
      align: columns[i].align || 'left',
      maxHeight: maxRowH - 12
    }));
    let rowH = 19;
    lays.forEach((L) => { if (L.height + 12 > rowH) rowH = L.height + 12; });
    if (rowH > maxRowH) rowH = maxRowH;
    if (ctx.y + rowH > BOTTOM && !ctx.isFresh()) { newPage(ctx); drawHeader(); }
    box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
    const cy = ctx.y + rowH / 2;
    cells.forEach((cell, i) => {
      PL.drawLayout(doc, lays[i], xs[i] + pad, cy - lays[i].height / 2,
        { color: cell.color || C.TEXT, align: columns[i].align || 'left' });
    });
    doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
    ctx.advance(rowH);
  });
  ctx.advance(10);
}

// ---- vector glyphs (WinAnsi-safe: drawn, never typed) ------------------------
function gUp(doc, cx, cy, s, color) {
  doc.save().fillColor(color)
    .moveTo(cx - s / 2, cy + s / 2).lineTo(cx + s / 2, cy + s / 2).lineTo(cx, cy - s / 2).fill().restore();
}
function gDown(doc, cx, cy, s, color) {
  doc.save().fillColor(color)
    .moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy - s / 2).lineTo(cx, cy + s / 2).fill().restore();
}
function gDash(doc, cx, cy, s, color) {
  doc.save().strokeColor(color).lineWidth(1.6).lineCap('round')
    .moveTo(cx - s / 2, cy).lineTo(cx + s / 2, cy).stroke().restore();
}
function gCheck(doc, cx, cy, s, color) {
  doc.save().strokeColor(color).lineWidth(1.5).lineJoin('round')
    .moveTo(cx - s / 2, cy).lineTo(cx - s / 8, cy + s / 2).lineTo(cx + s / 2, cy - s / 2).stroke().restore();
}
/** Warning triangle with a bang — the "⚠" glyph is not WinAnsi, so we draw it. */
function gWarn(doc, cx, cy, s, color) {
  doc.save();
  doc.fillColor(color)
    .moveTo(cx, cy - s / 2).lineTo(cx + s / 2, cy + s / 2).lineTo(cx - s / 2, cy + s / 2).fill();
  doc.fillColor(C.BG).rect(cx - s / 16, cy - s / 8, s / 8, s / 3.4).fill();
  doc.fillColor(C.BG).rect(cx - s / 16, cy + s / 4.4, s / 8, s / 12).fill();
  doc.restore();
}

/** Movement glyph: arrow follows the actual change, colour follows polarity. */
function drawChangeGlyph(doc, changeDirection, color, cx, cy) {
  if (changeDirection === 'up') gUp(doc, cx, cy, 7, color);
  else if (changeDirection === 'down') gDown(doc, cx, cy, 7, color);
  else gDash(doc, cx, cy, 7, color);
}

// ===========================================================================
// 1. Cover
// ===========================================================================

function buildCover(ctx, member, stats, report, dateStr) {
  const doc = ctx.doc;
  const cov = (stats && stats.coverage) || {};
  let y = 108;

  if (LOGO) {
    try {
      doc.image(LOGO, M, y, { fit: [58, 58], align: 'left' });
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.GOLD);
      PL.drawSingle(doc, 'BODYBANK', M + 70, y + 8, 0, {});
      doc.font('Helvetica').fontSize(11).fillColor(C.GOLD_DIM);
      PL.drawSingle(doc, '.FIT   ·   RECOVERY INTELLIGENCE', M + 70, y + 34, 0, { characterSpacing: 1 });
    } catch (_) {
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.GOLD);
      PL.drawSingle(doc, 'BODYBANK.FIT', M, y + 8, 0, {});
    }
    y += 84;
  } else {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.GOLD);
    PL.drawSingle(doc, 'BODYBANK.FIT', M, y, 0, {});
    y += 50;
  }

  y += PL.drawText(doc, 'Recovery & Readiness Report', M, y, { font: 'Helvetica-Bold', size: 26, width: CW, color: C.WHITE }) + 4;
  y += PL.drawText(doc, 'Wearable data analysis  ·  sleep, recovery, HRV and training load', M, y,
    { font: 'Helvetica', size: 12, width: CW, color: C.MUTED }) + 20;
  doc.save().rect(M, y, CW, 1).fill(C.GREEN).restore();
  y += 12;

  ctx.y = y;
  kvGrid(ctx, [
    ['Member', String((member && member.name) || 'Member'), C.WHITE, 14],
    ['Window', `${fmt(cov.dateFrom)}  to  ${fmt(cov.dateTo)}`, C.WHITE, 11],
    ['Report date', dateStr, C.WHITE, 11],
    ['Days with data', `${fmt(cov.daysWithData)} of ${fmt(cov.daysTotal)}`, C.GREEN, 14],
    ['Coverage', fmtUnit(cov.completenessPct, '%'), C.GREEN, 14],
    ['Prepared by', 'BodyBank Readiness Engine', C.TEXT, 10]
  ], 3, { rowH: 42 });

  const headline = report && report.headline ? String(report.headline) : '';
  if (headline) {
    // The headline sits in a single box, so it is capped to the room left on
    // the cover rather than growing a box taller than the page.
    const L = PL.layout(doc, headline, {
      font: 'Helvetica-Bold', size: 13, width: CW - 28, lineGap: 2,
      maxHeight: Math.max(20, BOTTOM - ctx.y - 60)
    });
    const h = L.height + 24;
    ensure(ctx, h + 12);
    box(doc, M, ctx.y, CW, h, C.SURFACE, C.GREEN, 1);
    PL.drawLayout(doc, L, M + 14, ctx.y + 12, { color: C.TEXT });
    ctx.advance(h + 12);
  }

  const summary = report && report.summary ? String(report.summary) : '';
  if (summary) paragraph(ctx, summary, { size: 10, color: C.TEXT, lineGap: 3, spaceAfter: 10 });

  if (!headline && !summary) {
    doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
    ctx.y += 8;
    paragraph(ctx, 'This edition contains the deterministic statistics only — no AI narrative was attached to it.',
      { font: 'Helvetica-Oblique', size: 9, color: C.MUTED, spaceAfter: 8 });
  }
}

// ===========================================================================
// 2. Validation banner  (NEVER hidden — an unverified report says so, loudly)
// ===========================================================================

function buildValidationBanner(ctx, validation) {
  if (!validation || typeof validation !== 'object') return;
  const doc = ctx.doc;

  if (validation.passed === false) {
    const orphans = Array.isArray(validation.orphanNumbers) ? validation.orphanNumbers : [];
    const orphanText = orphans.length ? orphans.map((n) => fmt(n)).join(', ') : '(not recorded)';
    const occurrences = Array.isArray(validation.occurrences) ? validation.occurrences : [];

    ensure(ctx, 96);
    const top = ctx.y;
    // header strip
    box(doc, M, ctx.y, CW, 28, C.RED);
    gWarn(doc, M + 18, ctx.y + 14, 13, C.BG);
    PL.drawFit(doc, 'FIGURES NOT VERIFIED — READ WITH CAUTION', M + 32, ctx.y + 9, CW - 44,
      { font: 'Helvetica-Bold', size: 11, color: C.BG });
    ctx.advance(28);

    const innerTop = ctx.y;
    ctx.advance(10);
    paragraph(ctx,
      'The automatic fact-check could not match every number in the written narrative to the source '
      + 'statistics. The numbers below appear in the prose but do NOT exist in the computed data set, '
      + 'which means they were estimated, re-rounded or invented by the narrative model.',
      { x: M + 14, width: CW - 28, size: 9, color: C.TEXT, lineGap: 2, spaceAfter: 6 });

    ensure(ctx, 16);
    PL.drawFit(doc, 'Unverified numbers:', M + 14, ctx.y, CW - 28, { font: 'Helvetica-Bold', size: 9, color: C.RED });
    ctx.advance(14);
    paragraph(ctx, orphanText, { x: M + 14, width: CW - 28, font: 'Helvetica-Bold', size: 11, color: C.RED, spaceAfter: 6 });

    if (occurrences.length) {
      const where = occurrences.slice(0, 12).map((o) => `${String((o && o.field) || '?')}: ${fmt(o && o.number)}`).join('   ·   ');
      paragraph(ctx, `Where they appear — ${where}${occurrences.length > 12 ? '  ·  …' : ''}`,
        { x: M + 14, width: CW - 28, size: 8, color: C.MUTED, lineGap: 2, spaceAfter: 6 });
    }
    paragraph(ctx,
      'Everything in the tables of this report is still computed deterministically and is safe to rely on. '
      + 'Treat only the flagged figures inside the narrative as unverified.',
      { x: M + 14, width: CW - 28, font: 'Helvetica-Oblique', size: 8.5, color: C.MUTED, lineGap: 2, spaceAfter: 4 });

    // Outline the body only when it did not straddle a page boundary.
    if (ctx.y > innerTop) {
      box(doc, M, innerTop, CW, ctx.y - innerTop + 6, null, C.RED, 1);
      if (top === innerTop - 28) box(doc, M, top, CW, ctx.y - top + 6, null, C.RED, 1);
    }
    ctx.y += 14;
  } else if (validation.passed === true) {
    ensure(ctx, 40);
    const h = 30;
    box(doc, M, ctx.y, CW, h, C.INC_BG, C.GREEN, 0.6);
    gCheck(doc, M + 18, ctx.y + h / 2, 11, C.GREEN);
    PL.drawFit(doc, 'Figures verified against source data', M + 34, ctx.y + 7, CW - 48,
      { font: 'Helvetica-Bold', size: 9, color: C.GREEN });
    PL.drawFit(doc, 'Every numeral in the narrative was matched to the deterministic statistics below.',
      M + 34, ctx.y + 18, CW - 48, { font: 'Helvetica', size: 8, minSize: 6.5, color: C.MUTED });
    ctx.advance(h + 12);
  }

  const sem = validation.semantic;
  if (sem && typeof sem === 'object') {
    const contradictions = Array.isArray(sem.contradictions) ? sem.contradictions : [];
    const unsupported = Array.isArray(sem.unsupportedClaims) ? sem.unsupportedClaims : [];
    if (contradictions.length || unsupported.length) {
      subheading(ctx, 'Reviewer notes on the narrative', C.AMBER);
      contradictions.forEach((c) => {
        paragraph(ctx, `Contradiction — “${String((c && c.quote) || '')}”  (${String((c && c.why) || '')})`,
          { size: 8.5, color: C.AMBER, lineGap: 2, spaceAfter: 4 });
      });
      unsupported.forEach((c) => {
        paragraph(ctx, `Unsupported — “${String((c && c.quote) || '')}”  (${String((c && c.why) || '')})`,
          { size: 8.5, color: C.AMBER, lineGap: 2, spaceAfter: 4 });
      });
      ctx.y += 4;
    }
  }
}

// ===========================================================================
// 3. Metric summary table
// ===========================================================================

/**
 * The cells for one metric row, as strings. Exported and used by the renderer,
 * so a test asserting on this is asserting on what actually gets drawn.
 * A null metric (or a null field) yields an em-dash — never "0".
 */
function metricRowCells(key, metric) {
  const m = metric && typeof metric === 'object' ? metric : null;
  return {
    label: metricLabel(key, m ? m.unit : null),
    mean: fmt(m ? m.mean : null),
    median: fmt(m ? m.median : null),
    min: fmt(m ? m.min : null),
    max: fmt(m ? m.max : null),
    stdDev: fmt(m ? m.stdDev : null),
    latest: fmt(m ? m.latest : null),
    latestDate: fmt(m ? m.latestDate : null),
    n: fmt(m ? m.n : null)
  };
}

function buildMetricTable(ctx, stats) {
  const metrics = (stats && stats.metrics) || {};
  const keys = metricKeys(metrics).filter((k) => metrics[k]); // skip null metrics entirely
  heading(ctx, 'Metric summary');
  if (!keys.length) {
    paragraph(ctx, 'No metric had a single usable reading in this window.',
      { font: 'Helvetica-Oblique', size: 9.5, color: C.MUTED });
    return;
  }
  paragraph(ctx,
    'One row per metric that has data. Metrics with no readings are omitted rather than shown as zero.',
    { size: 9, color: C.MUTED, spaceAfter: 8 });

  const rows = keys.map((k) => metricRowCells(k, metrics[k]));
  table(ctx, [
    { frac: 0.26, header: 'Metric', get: (r) => ({ text: r.label, bold: true, color: C.WHITE }) },
    { frac: 0.11, header: 'Mean', align: 'right', get: (r) => ({ text: r.mean, bold: true, color: C.GREEN }) },
    { frac: 0.11, header: 'Median', align: 'right', get: (r) => ({ text: r.median }) },
    { frac: 0.1, header: 'Min', align: 'right', get: (r) => ({ text: r.min, color: C.MUTED }) },
    { frac: 0.1, header: 'Max', align: 'right', get: (r) => ({ text: r.max, color: C.MUTED }) },
    { frac: 0.1, header: 'SD', align: 'right', get: (r) => ({ text: r.stdDev, color: C.MUTED }) },
    { frac: 0.12, header: 'Latest', align: 'right', get: (r) => ({ text: r.latest, bold: true, color: C.BLUE }) },
    { frac: 0.1, header: 'Days', align: 'right', get: (r) => ({ text: r.n, color: C.MUTED }) }
  ], rows);

  const latestDates = keys
    .map((k) => (metrics[k] && metrics[k].latestDate ? `${metricLabel(k, null)} ${fmt(metrics[k].latestDate)}` : null))
    .filter(Boolean);
  if (latestDates.length) {
    paragraph(ctx, `Latest reading per metric — ${latestDates.join('   ·   ')}`,
      { size: 8, color: C.MUTED, lineGap: 2, spaceAfter: 6 });
  }
}

// ===========================================================================
// 4. Trends (polarity-aware — direction is READ, never derived)
// ===========================================================================

function buildTrends(ctx, stats) {
  const trends = (stats && stats.trends) || {};
  const metrics = (stats && stats.metrics) || {};
  const keys = metricKeys(Object.keys(trends).length ? trends : metrics).filter((k) => trends[k]);

  ensure(ctx, 210);
  heading(ctx, 'Trends — first half vs second half');
  if (!keys.length) {
    paragraph(ctx, `No metric had enough days for a trend (minimum ${fmt(stats && stats.thresholds && stats.thresholds.trendMinDays)} days of readings).`,
      { font: 'Helvetica-Oblique', size: 9.5, color: C.MUTED });
    return;
  }
  paragraph(ctx,
    'Direction is polarity-aware and comes from the statistics engine: a FALLING resting heart rate or '
    + 'respiratory rate is an improvement, while a falling recovery score is a decline. Load metrics such as '
    + 'strain are never labelled good or bad — only their movement is shown.',
    { size: 9, color: C.MUTED, spaceAfter: 8 });

  const doc = ctx.doc;
  const rows = keys.map((k) => ({ key: k, t: trends[k] }));
  table(ctx, [
    { frac: 0.24, header: 'Metric', get: (r) => ({ text: metricLabel(r.key, r.t.unit), bold: true, color: C.WHITE }) },
    { frac: 0.14, header: 'First half', align: 'right', get: (r) => ({ text: fmt(r.t.firstHalfMean), color: C.MUTED }) },
    { frac: 0.14, header: 'Second half', align: 'right', get: (r) => ({ text: fmt(r.t.secondHalfMean), color: C.MUTED }) },
    { frac: 0.13, header: 'Change', align: 'right', get: (r) => ({ text: fmt(r.t.deltaAbs), bold: true, color: directionColor(r.t.direction) }) },
    { frac: 0.13, header: 'Change %', align: 'right', get: (r) => ({ text: r.t.deltaPct === null || r.t.deltaPct === undefined ? DASH : fmtUnit(r.t.deltaPct, '%'), color: directionColor(r.t.direction) }) },
    { frac: 0.14, header: 'Direction', get: (r) => ({ text: humanize(r.t.direction), bold: true, color: directionColor(r.t.direction) }) },
    { frac: 0.08, header: 'Days', align: 'right', get: (r) => ({ text: fmt(r.t.n), color: C.MUTED }) }
  ], rows);

  // arrow legend strip — the movement glyph, coloured by polarity-aware direction
  ensure(ctx, 30);
  let lx = M;
  rows.slice(0, 7).forEach((r) => {
    const col = directionColor(r.t.direction);
    const label = metricLabel(r.key, null);
    doc.font('Helvetica').fontSize(8);
    const w = doc.widthOfString(label) + 22;
    if (lx + w > M + CW) return;
    drawChangeGlyph(doc, r.t.changeDirection, col, lx + 6, ctx.y + 6);
    PL.drawFit(doc, label, lx + 14, ctx.y + 2, M + CW - (lx + 14), { font: 'Helvetica', size: 8, color: col });
    lx += w;
  });
  ctx.advance(22);
}

// ===========================================================================
// 5a. Sleep debt
// ===========================================================================

function buildSleepDebt(ctx, stats) {
  const sd = (stats && stats.sleepDebt) || {};
  const th = (stats && stats.thresholds) || {};
  ensure(ctx, 230);
  heading(ctx, 'Sleep debt');
  kvGrid(ctx, [
    ['Total debt (min)', fmt(sd.totalMin), C.AMBER, 14],
    ['Avg per night (min)', fmt(sd.avgPerNightMin), C.AMBER, 14],
    ['Nights measured', fmt(sd.nights), C.WHITE, 14],
    ['Worst night', fmt(sd.worstDate), C.WHITE, 11],
    ['Worst debt (min)', fmt(sd.worstMin), C.RED, 14],
    ['Short / long nights', `${fmt(sd.nightsUnder6h)} / ${fmt(sd.nightsOver8h)}`, C.WHITE, 14]
  ], 3, { rowH: 42 });
  paragraph(ctx,
    `Short nights are under ${fmt(th.shortNightHours)} h and long nights over ${fmt(th.longNightHours)} h. `
    + `A nightly debt at or above ${fmt(th.sleepDebtWarnMin)} min is flagged, and at or above `
    + `${fmt(th.sleepDebtCriticalMin)} min it is flagged as critical.`,
    { size: 8.5, color: C.MUTED, lineGap: 2, spaceAfter: 10 });
}

// ===========================================================================
// 5b. Strain vs recovery balance
// ===========================================================================

function buildBalance(ctx, stats) {
  const b = (stats && stats.strainRecoveryBalance) || {};
  const key = b.interpretationKey || 'insufficient_data';
  const col = balanceColor(key);
  ensure(ctx, 250);
  heading(ctx, 'Strain vs recovery balance');

  // The note beside the verdict wraps to two or three lines, so the verdict box
  // is sized from it. At a fixed 46pt the third line fell out of the border.
  const noteText = `Based on ${fmt(b.daysConsidered)} day(s) that had both a strain and a recovery score.`;
  const noteL = PL.layout(ctx.doc, noteText, {
    font: 'Helvetica', size: 9, width: CW * 0.52 - 14, maxHeight: ctx.pageHeight() - 40
  });
  const h = Math.max(46, noteL.height + 28);
  ensure(ctx, h + 12);
  box(ctx.doc, M, ctx.y, CW, h, C.SURFACE, col, 1);
  PL.drawFit(ctx.doc, 'VERDICT', M + 14, ctx.y + 10, CW * 0.4 - 14, { font: 'Helvetica-Bold', size: 7.5, color: C.MUTED });
  PL.drawFit(ctx.doc, BALANCE_LABELS[key] || humanize(key), M + 14, ctx.y + 21, CW * 0.4 - 14,
    { font: 'Helvetica-Bold', size: 18, minSize: 8, color: col });
  PL.drawLayout(ctx.doc, noteL, M + CW * 0.45, ctx.y + (h - noteL.height) / 2, { color: C.MUTED });
  ctx.advance(h + 12);

  kvGrid(ctx, [
    ['High strain / low recovery', fmt(b.daysHighStrainLowRecovery), C.RED, 14],
    ['Low strain / high recovery', fmt(b.daysLowStrainHighRecovery), C.BLUE, 14],
    ['Avg strain on low-recovery days', fmt(b.avgStrainOnLowRecoveryDays), C.AMBER, 14]
  ], 3, { rowH: 42 });

  paragraph(ctx,
    `Zones — high strain at or above ${fmt(b.highStrainThreshold)}, low strain at or below `
    + `${fmt(b.lowStrainThreshold)}, low recovery below ${fmt(b.lowRecoveryThreshold)}%, `
    + `high recovery at or above ${fmt(b.highRecoveryThreshold)}%.`,
    { size: 8.5, color: C.MUTED, lineGap: 2, spaceAfter: 10 });
}

// ===========================================================================
// 5c. Notable days
// ===========================================================================

function buildNotableDays(ctx, stats) {
  const nd = (stats && stats.notableDays) || {};
  const present = NOTABLE_ROWS.filter((r) => nd[r[0]]);
  ensure(ctx, 200);
  heading(ctx, 'Notable days');
  if (!present.length) {
    paragraph(ctx, 'No day stood out — the window has no recovery or sleep readings.',
      { font: 'Helvetica-Oblique', size: 9.5, color: C.MUTED });
    return;
  }
  const colorFor = (k) => (k === 'bestRecovery' || k === 'longestSleep' ? C.GREEN : C.RED);
  kvGrid(ctx, present.map((r) => {
    const d = nd[r[0]];
    return [r[1], `${fmt(d.value)}   ·   ${fmt(d.date)}`, colorFor(r[0]), 12];
  }), 2, { rowH: 42 });
}

// ===========================================================================
// 5d. Correlations
// ===========================================================================

function buildCorrelations(ctx, stats) {
  const corr = (stats && stats.correlations) || {};
  const th = (stats && stats.thresholds) || {};
  const known = CORRELATION_ROWS.filter((r) => corr[r[0]]);
  const extra = Object.keys(corr)
    .filter((k) => !CORRELATION_ROWS.some((r) => r[0] === k))
    .map((k) => [k, humanize(k)]);
  // Skip any correlation whose r is null — an undefined coefficient is not a fact.
  const rows = known.concat(extra)
    .filter((r) => corr[r[0]] && corr[r[0]].r !== null && corr[r[0]].r !== undefined)
    .map((r) => ({ label: r[1], c: corr[r[0]] }));

  ensure(ctx, 230);
  heading(ctx, 'Correlations');
  const skipped = known.concat(extra).length - rows.length;
  if (!rows.length) {
    paragraph(ctx,
      `No correlation could be computed — every pairing had fewer than `
      + `${fmt(th.correlationMinPairs)} aligned days, or one of the two series never varied.`,
      { font: 'Helvetica-Oblique', size: 9.5, color: C.MUTED });
    return;
  }
  paragraph(ctx,
    'Pairs are aligned by calendar date, so a missing day breaks the pair rather than shifting it. '
    + 'Correlation is association, not causation.',
    { size: 9, color: C.MUTED, spaceAfter: 8 });

  table(ctx, [
    { frac: 0.42, header: 'Relationship', get: (r) => ({ text: r.label, bold: true, color: C.WHITE }) },
    { frac: 0.12, header: 'r', align: 'right', get: (r) => ({ text: fmt(r.c.r), bold: true, color: strengthColor(r.c.strength) }) },
    { frac: 0.1, header: 'Pairs', align: 'right', get: (r) => ({ text: fmt(r.c.n), color: C.MUTED }) },
    { frac: 0.12, header: 'Lag (days)', align: 'right', get: (r) => ({ text: fmt(r.c.lagDays), color: C.MUTED }) },
    { frac: 0.12, header: 'Strength', get: (r) => ({ text: humanize(r.c.strength), color: strengthColor(r.c.strength) }) },
    { frac: 0.12, header: 'Direction', get: (r) => ({ text: humanize(r.c.direction), color: C.MUTED }) }
  ], rows);

  const notes = [
    `|r| at or above ${fmt(th.correlationStrong)} is strong, ${fmt(th.correlationModerate)} moderate, ${fmt(th.correlationWeak)} weak.`
  ];
  if (skipped > 0) notes.push(`${fmt(skipped)} pairing(s) are omitted because no coefficient could be computed for them.`);
  paragraph(ctx, notes.join(' '), { size: 8.5, color: C.MUTED, lineGap: 2, spaceAfter: 8 });
}

// ===========================================================================
// 5e. Flags
// ===========================================================================

function buildFlags(ctx, stats) {
  const flags = Array.isArray(stats && stats.flags) ? stats.flags : [];
  ensure(ctx, 170);
  heading(ctx, 'Flags');
  if (!flags.length) {
    ensure(ctx, 40);
    const h = 30;
    box(ctx.doc, M, ctx.y, CW, h, C.INC_BG, C.GREEN, 0.6);
    gCheck(ctx.doc, M + 18, ctx.y + h / 2, 11, C.GREEN);
    PL.drawFit(ctx.doc, 'No flags raised in this window.', M + 34, ctx.y + 11, CW - 48,
      { font: 'Helvetica-Bold', size: 9.5, color: C.GREEN });
    ctx.advance(h + 10);
    return;
  }

  const doc = ctx.doc;
  flags.forEach((f) => {
    const flag = f && typeof f === 'object' ? f : {};
    const sev = String(flag.severity || 'info');
    const col = severityColor(sev);
    const bg = severityBg(sev);
    const fields = Object.keys(flag).filter((k) => k !== 'key' && k !== 'severity');
    const detail = fields
      .map((k) => `${FLAG_FIELD_LABELS[k] || humanize(k)}: ${fmt(flag[k])}`)
      .join('    ·    ');

    // The detail strip is capped to a page: a flag carrying dozens of fields
    // still has to live inside one box.
    const detailL = PL.layout(doc, detail, {
      font: 'Helvetica', size: 9, width: CW - 46, lineGap: 2, maxHeight: ctx.pageHeight() - 40
    });
    const h = 22 + detailL.height + 12;
    ensure(ctx, h + 6);
    box(doc, M, ctx.y, CW, h, bg, col, 0.6);
    doc.save().rect(M, ctx.y, 3, h).fill(col).restore();
    if (sev === 'info') gDash(doc, M + 18, ctx.y + 15, 9, col);
    else gWarn(doc, M + 18, ctx.y + 15, 11, col);
    PL.drawFit(doc, `${FLAG_LABELS[flag.key] || humanize(flag.key)}   [${sev.toUpperCase()}]`,
      M + 32, ctx.y + 10, CW - 46, { font: 'Helvetica-Bold', size: 10, minSize: 6.5, color: col });
    PL.drawLayout(doc, detailL, M + 32, ctx.y + 26, { color: C.TEXT });
    ctx.advance(h + 8);
  });
}

// ===========================================================================
// 5f. Weekly buckets
// ===========================================================================

function buildWeekly(ctx, stats) {
  const weekly = Array.isArray(stats && stats.weekly) ? stats.weekly : [];
  if (!weekly.length) return;
  ensure(ctx, 200);
  heading(ctx, 'Week by week');
  paragraph(ctx, 'ISO week means for each metric. A blank cell means the week had no reading for that metric.',
    { size: 9, color: C.MUTED, spaceAfter: 8 });
  table(ctx, [
    { frac: 0.16, header: 'Week', get: (w) => ({ text: fmt(w.week), bold: true, color: C.WHITE }) },
    { frac: 0.2, header: 'Dates', get: (w) => ({ text: `${fmt(w.dateFrom)} – ${fmt(w.dateTo)}`, size: 8, color: C.MUTED }) },
    { frac: 0.07, header: 'Days', align: 'right', get: (w) => ({ text: fmt(w.days), color: C.MUTED }) },
    { frac: 0.1, header: 'Recovery', align: 'right', get: (w) => ({ text: fmt(w.recovery), color: C.GREEN }) },
    { frac: 0.09, header: 'HRV', align: 'right', get: (w) => ({ text: fmt(w.hrv) }) },
    { frac: 0.09, header: 'RHR', align: 'right', get: (w) => ({ text: fmt(w.restingHr) }) },
    { frac: 0.09, header: 'Sleep', align: 'right', get: (w) => ({ text: fmt(w.sleepHours) }) },
    { frac: 0.1, header: 'Sleep eff', align: 'right', get: (w) => ({ text: fmt(w.sleepEfficiency) }) },
    { frac: 0.1, header: 'Strain', align: 'right', get: (w) => ({ text: fmt(w.strain), color: C.AMBER }) }
  ], weekly);
}

// ===========================================================================
// 6. Narrative
// ===========================================================================

function buildNarrative(ctx, report) {
  if (!report || typeof report !== 'object') return;
  sectionBreak(ctx);
  heading(ctx, 'Interpretation');

  if (report.headline) {
    paragraph(ctx, String(report.headline), { font: 'Helvetica-Bold', size: 12, color: C.WHITE, spaceAfter: 6 });
  }
  if (report.summary) {
    paragraph(ctx, String(report.summary), { size: 10, color: C.TEXT, lineGap: 3, spaceAfter: 10 });
  }

  const sections = Array.isArray(report.sections) ? report.sections : [];
  sections.forEach((s) => {
    if (!s || (!s.title && !s.body)) return;
    if (s.title) subheading(ctx, String(s.title), C.GREEN);
    if (s.body) paragraph(ctx, String(s.body), { size: 10, color: C.TEXT, lineGap: 3, spaceAfter: 10 });
  });

  const analyses = [
    ['Sleep analysis', report.sleepAnalysis, C.BLUE],
    ['Recovery analysis', report.recoveryAnalysis, C.GREEN],
    ['Training load analysis', report.trainingLoadAnalysis, C.AMBER],
    ['Correlation insights', report.correlationInsights, C.PURPLE]
  ].filter((a) => a[1]);

  if (analyses.length) {
    ensure(ctx, 200);
    heading(ctx, 'Detailed analysis');
    analyses.forEach((a) => {
      subheading(ctx, a[0], a[2]);
      ctx.doc.save().rect(M, ctx.y - 6, 40, 1.4).fill(a[2]).restore();
      ctx.y += 4;
      paragraph(ctx, String(a[1]), { size: 10, color: C.TEXT, lineGap: 3, spaceAfter: 12 });
    });
  }

  buildActions(ctx, report);

  if (report.coachNotes) {
    ensure(ctx, 150);
    heading(ctx, 'Coach notes');
    paragraph(ctx, String(report.coachNotes), { size: 10, color: C.TEXT, lineGap: 3, spaceAfter: 10 });
  }
}

function buildActions(ctx, report) {
  const actions = Array.isArray(report && report.actions) ? report.actions : [];
  if (!actions.length) return;
  ensure(ctx, 170);
  heading(ctx, 'What to do next');
  const doc = ctx.doc;
  actions.forEach((a, i) => {
    const act = a && typeof a === 'object' ? a : {};
    ensure(ctx, 34);
    const rankY = ctx.y;
    doc.save().circle(M + 9, rankY + 8, 9).fill(C.SURFACE2).restore();
    PL.drawFit(doc, fmt(act.rank === undefined || act.rank === null ? i + 1 : act.rank), M, rankY + 4, 18,
      { font: 'Helvetica-Bold', size: 9, minSize: FIGURE_MIN, color: C.GREEN, align: 'center' });
    paragraph(ctx, String(act.action || ''), {
      x: M + 26, width: CW - 26, font: 'Helvetica-Bold', size: 10, color: C.WHITE, lineGap: 2, spaceAfter: 2
    });
    if (act.rationale) {
      paragraph(ctx, String(act.rationale), {
        x: M + 26, width: CW - 26, size: 9, color: C.MUTED, lineGap: 2, spaceAfter: 6
      });
    }
    ensure(ctx, 8);
    doc.save().rect(M, ctx.y, CW, 0.3).fill(C.BORDER).restore();
    ctx.y += 8;
  });
}

// ===========================================================================
// 7. Closing disclaimer
// ===========================================================================

function buildDisclaimer(ctx) {
  const doc = ctx.doc;
  ctx.y += 8;
  const disc = 'This report is generated by BodyBank.fit’s readiness system. Every statistic above is computed '
    + 'deterministically from the wearable data the member uploaded; the interpretive text is AI-written and '
    + 'fact-checked against those statistics. It is informational and does not constitute a medical diagnosis. '
    + 'Discuss any concerning trend with your physician.';
  const L = PL.layout(doc, disc, { font: 'Helvetica-Oblique', size: 8.5, width: CW - 28, lineGap: 2 });
  const h = L.height + 22;
  ensure(ctx, h + 10);
  box(doc, M, ctx.y, CW, h, C.DISC_BG, C.BORDER, 0.5);
  PL.drawLayout(doc, L, M + 14, ctx.y + 11, { color: C.MUTED });
  ctx.advance(h + 6);
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * @param {object} payload {member:{name,email?}, stats, report?, validation?, generatedAt?}
 * @param {string} outPath absolute path to write the PDF to
 * @param {object} [options] {compress:boolean} — compress:false emits plain content
 *                 streams (used by tests that assert on the rendered text)
 * @returns {Promise<{ok:boolean, path:string, bytes:number, pages:number}>}
 */
function buildWhoopReportPdf(payload, outPath, options) {
  const PDFDocument = require('pdfkit');
  const opts = options && typeof options === 'object' ? options : {};
  const p = payload && typeof payload === 'object' ? payload : {};
  const member = p.member && typeof p.member === 'object' ? p.member : {};
  const stats = p.stats && typeof p.stats === 'object' ? p.stats : {};
  const report = p.report && typeof p.report === 'object' ? p.report : null;
  const validation = p.validation && typeof p.validation === 'object' ? p.validation : null;

  const gen = p.generatedAt ? new Date(p.generatedAt) : new Date();
  const dateStr = formatDate(Number.isNaN(gen.getTime()) ? new Date() : gen);
  const name = String(member.name || 'Member');

  const docOptions = { size: 'A4', margin: 0, bufferPages: true };
  if (opts.compress === false) docOptions.compress = false;

  const doc = new PDFDocument(docOptions);
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);
  paintBg(doc);

  // The flow owns pagination: it paints the background of every page, including
  // any page PDFKit opens on its own, and it refuses to break a page that
  // carries no ink.
  const ctx = PL.createFlow(doc, { top: TOP, bottom: BOTTOM, left: M, width: CW, onPage: (d) => paintBg(d) });

  buildCover(ctx, member, stats, report, dateStr);
  buildValidationBanner(ctx, validation);

  newPage(ctx);
  buildMetricTable(ctx, stats);
  buildTrends(ctx, stats);

  buildSleepDebt(ctx, stats);
  buildBalance(ctx, stats);
  buildNotableDays(ctx, stats);

  buildCorrelations(ctx, stats);
  buildFlags(ctx, stats);
  buildWeekly(ctx, stats);

  if (report) buildNarrative(ctx, report);

  buildDisclaimer(ctx);

  paintChrome(doc, name, dateStr);
  const pages = doc.bufferedPageRange().count;

  return new Promise((resolve, reject) => {
    doc.end();
    stream.on('error', reject);
    stream.on('finish', () => {
      let bytes = 0;
      try { bytes = fs.statSync(outPath).size; } catch (_) {}
      resolve({ ok: true, path: outPath, bytes, pages });
    });
  });
}

module.exports = {
  buildWhoopReportPdf,
  // section builders (exported so tests and callers can drive them individually)
  buildCover,
  buildValidationBanner,
  buildMetricTable,
  buildTrends,
  buildSleepDebt,
  buildBalance,
  buildNotableDays,
  buildCorrelations,
  buildFlags,
  buildWeekly,
  buildNarrative,
  buildActions,
  buildDisclaimer,
  // pure helpers — the entire numeric surface of this module
  fmt,
  fmtUnit,
  metricRowCells,
  metricLabel,
  metricKeys,
  wrapLines,
  DASH
};
