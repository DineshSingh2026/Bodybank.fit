'use strict';

/**
 * BodyBank.fit — branded blood/health report, pure Node (PDFKit).
 * No Python / ReportLab dependency — renders identically on any host.
 * Reproduces the 13-section dark-theme template (see public/reports sample),
 * with the gold BodyBank coin logo, and NEVER emits empty pages: any section
 * without data is skipped entirely (no page, no TOC entry).
 *
 * ---------------------------------------------------------------------------
 * LAYOUT SAFETY
 * ---------------------------------------------------------------------------
 * A lab report is the least predictable document BodyBank prints: the marker
 * names, reference ranges and AI prose all come from the client's own panel,
 * so every column can receive a value ten times longer than the design assumed.
 * Every string therefore goes through services/pdfLayout.js, which fits single
 * lines to their column and measures wrapped blocks with the exact options they
 * are drawn with. Box heights are derived from those measurements rather than
 * guessed, so nothing can spill out of a card, a row or a page.
 */

const path = require('path');
const fs = require('fs');
const PL = require('./pdfLayout');
const { txt } = require('./pdfText');

// ---- palette (matches the ReportLab template) --------------------------------
const C = {
  BG: '#0d0f11', SURFACE: '#161a1e', SURFACE2: '#1e2328', GREEN: '#3dd68c',
  AMBER: '#f5a623', BLUE: '#4da6ff', RED: '#ff5c5c', TEXT: '#f0ede8',
  MUTED: '#8a8880', WHITE: '#ffffff', DARK: '#1a1f24', BORDER: '#2a2f35',
  INC_BG: '#1a2e1a', AVD_BG: '#2e1a1a', PURPLE: '#a855f7', DISC_BG: '#141414',
  GOLD: '#e6c46a', GOLD_DIM: '#c8a44e'
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 51;                 // ~18mm margin
const CW = PAGE_W - 2 * M;    // content width
const TOP = 70;               // content top (below header)
const BOTTOM = 782;           // content bottom (above footer band)

function resolveLogo() {
  const dir = path.join(__dirname, '..', 'public', 'img');
  const candidates = [
    'bodybank-logo.png - short.png', // transparent gold coin emblem (preferred)
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

function statusColor(st) {
  if (st === 'Normal' || st === 'Optimal') return C.GREEN;
  if (st === 'Critical' || st === 'High' || st === 'Deficient') return C.RED;
  return C.AMBER;
}

// ---- data presence checks (drive section/TOC skipping) -----------------------
function hasPanels(blood) {
  return blood && Array.isArray(blood.panels) && blood.panels.some((p) => p && Array.isArray(p.markers) && p.markers.length);
}
function hasNutrition(n) {
  return n && typeof n === 'object' && (n.averages || (Array.isArray(n.top_meals) && n.top_meals.length) || n.meal_quality_score != null);
}
function nonEmpty(v) { return Array.isArray(v) && v.length > 0; }
function hasClinical(ai) { return !!(ai.clinical_interpretation || nonEmpty(ai.key_findings)); }
function hasLifestyle(ai) {
  const l = ai.lifestyle || {};
  return !!(l.sleep || l.stress || l.exercise || l.hydration || l.recovery);
}

function buildHealthReportPdf(payload, outPath) {
  const PDFDocument = require('pdfkit');
  const user = (payload && payload.user) || {};
  const blood = (payload && payload.blood_analysis) || {};
  const nutrition = (payload && payload.nutrition_analysis) || {};
  const ai = (payload && payload.ai_report) || {};
  const dateStr = formatDate(new Date());
  const name = String(user.name || 'Member');

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  paintBg(doc); // first page

  // The flow owns pagination. It paints the background of every page — including
  // one PDFKit might add on its own — and records which pages carry content, so
  // chrome can never be painted onto a page that has none, nor missed on one
  // that does.
  const ctx = PL.createFlow(doc, {
    top: TOP, bottom: BOTTOM, left: M, width: CW,
    claimFirstPage: false,
    onPage: (d) => paintBg(d)
  });
  ctx.contentPages = ctx.pages;

  buildCover(ctx, user, ai, dateStr);

  // Decide which sections have data — only these get a page + a TOC entry.
  const toc = [];
  const bodySections = [];
  const add = (num, title, sub, has, build) => {
    if (!has) return;
    toc.push([num, title, sub]);
    bodySections.push(build);
  };
  add('1', 'Blood Test Analysis', 'CBC, Metabolic Panel, Vitamins & Hormones', hasPanels(blood), () => buildBlood(ctx, blood));
  add('2', 'Nutrition Intelligence', 'Dietary pattern from BodyBank meal tracker', hasNutrition(nutrition), () => buildNutrition(ctx, nutrition));
  add('3', 'Clinical Interpretation', 'Doctor-level analysis of all findings', hasClinical(ai), () => buildClinical(ctx, ai));
  add('4', 'Risk Assessment', 'Identified risks and areas of concern', nonEmpty(ai.risks), () => buildRisks(ctx, ai));
  // Foods 5 & 6 share one page group.
  const foodsHas = nonEmpty(ai.foods_include) || nonEmpty(ai.foods_avoid);
  if (nonEmpty(ai.foods_include)) toc.push(['5', 'Foods to Include', 'Evidence-based food recommendations']);
  if (nonEmpty(ai.foods_avoid)) toc.push(['6', 'Foods to Avoid', 'Foods conflicting with your blood markers']);
  if (foodsHas) bodySections.push(() => buildFoods(ctx, ai));
  add('7', 'Weekly Meal Plan', 'Personalised 7-day nutrition framework', nonEmpty(ai.weekly_meal_plan), () => buildMealPlan(ctx, ai));
  add('8', 'Supplement Protocol', 'Recommended supplements for deficiencies', nonEmpty(ai.supplements), () => buildSupplements(ctx, ai));
  add('9', 'Lifestyle Recommendations', 'Sleep, stress, exercise and recovery', hasLifestyle(ai), () => buildLifestyle(ctx, ai));
  add('10', 'Progress Tracking', 'What to retest and when', nonEmpty(ai.retest_schedule), () => buildProgress(ctx, ai));

  if (toc.length) { newPage(ctx); buildContents(ctx, toc); }
  bodySections.forEach((build) => { newPage(ctx); build(); });

  // disclaimer always closes the report
  buildDisclaimer(ctx, !!bodySections.length);

  paintChrome(doc, name, dateStr, ctx.contentPages);

  return new Promise((resolve, reject) => {
    doc.end();
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

// ---- page chrome -------------------------------------------------------------
function paintBg(doc) {
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.BG);
  doc.rect(0, 0, PAGE_W, 2).fill(C.GREEN);
  doc.restore();
}
function newPage(ctx) {
  ctx.newPage();
}
/**
 * Brand lockup + footer band on every content page.
 *
 * The footer sits deliberately below the content box. Chrome is drawn with the
 * fitting helpers so a long member name is shortened to its column instead of
 * wrapping onto a second line below the edge of the paper — which is exactly
 * what `{ width, lineBreak: false }` used to do here, because PDFKit runs its
 * line wrapper whenever a width is given.
 */
function paintChrome(doc, name, dateStr, contentPages) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i += 1) {
    if (!contentPages.has(i)) continue;
    doc.switchToPage(i);
    doc.save();
    // top-right brand: small gold coin + green wordmark
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GREEN);
    const wm = 'BodyBank.fit';
    const tw = doc.widthOfString(wm);
    PL.drawSingle(doc, wm, PAGE_W - M - tw, 27, 0, {});
    if (LOGO) { try { doc.image(LOGO, PAGE_W - M - tw - 20, 23, { width: 15, height: 15 }); } catch (_) {} }
    // footer band
    doc.rect(0, PAGE_H - 46, PAGE_W, 46).fill(C.SURFACE);
    doc.rect(M, PAGE_H - 46, CW, 0.4).fill(C.BORDER);
    // The page marker is laid out first; the member line gets whatever is left,
    // so the two can never collide however long the name is.
    const right = `${dateStr}  ·  Page ${i + 1} of ${total}`;
    doc.font('Helvetica').fontSize(8);
    const rightW = Math.min(CW * 0.5, doc.widthOfString(right));
    PL.drawFit(doc, right, M + CW - rightW, PAGE_H - 26, rightW, { font: 'Helvetica', size: 8, color: C.MUTED, align: 'right' });
    PL.drawFit(doc, `BodyBank.fit  ·  Health Report  ·  ${name}`, M, PAGE_H - 26, CW - rightW - 16,
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
/**
 * A section heading. The title is allowed to wrap (AI-supplied panel names can
 * be long), and the rule is placed under however many lines it actually took —
 * the old fixed `+= 22` drew the rule through the second line.
 */
function heading(ctx, text, ruleColor) {
  const h = PL.measure(ctx.doc, text, { font: 'Helvetica-Bold', size: 15, width: CW });
  ctx.ensure(h + 30);
  PL.drawText(ctx.doc, text, M, ctx.y, { font: 'Helvetica-Bold', size: 15, width: CW, color: C.GREEN });
  ctx.advance(Math.max(22, h + 4));
  hr(ctx, ruleColor || C.GREEN, 1);
  ctx.advance(2);
}
function subheading(ctx, text) {
  const h = PL.measure(ctx.doc, text, { font: 'Helvetica-Bold', size: 12, width: CW });
  ctx.ensure(h + 24);
  PL.drawText(ctx.doc, text, M, ctx.y, { font: 'Helvetica-Bold', size: 12, width: CW, color: C.WHITE });
  ctx.advance(Math.max(18, h + 4));
}
/**
 * Flowing prose. Written line by line through the flow so a long clinical
 * interpretation breaks between pages instead of running into the footer.
 */
function bodyText(ctx, text, opts) {
  opts = opts || {};
  PL.flowText(ctx, text, {
    font: 'Helvetica',
    size: 10,
    width: opts.width || CW,
    align: opts.align || 'left',
    lineGap: 3,
    color: opts.color || C.TEXT,
    spaceAfter: opts.spaceAfter != null ? opts.spaceAfter : 6
  });
}

// vector glyphs (WinAnsi-safe: drawn, not typed)
function gDown(doc, cx, cy, s, color) { doc.save().fillColor(color).moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy - s / 2).lineTo(cx, cy + s / 2).fill().restore(); }
function gUp(doc, cx, cy, s, color) { doc.save().fillColor(color).moveTo(cx - s / 2, cy + s / 2).lineTo(cx + s / 2, cy + s / 2).lineTo(cx, cy - s / 2).fill().restore(); }
function gCheck(doc, cx, cy, s, color) { doc.save().strokeColor(color).lineWidth(1.5).lineJoin('round').moveTo(cx - s / 2, cy).lineTo(cx - s / 8, cy + s / 2).lineTo(cx + s / 2, cy - s / 2).stroke().restore(); }
function gCross(doc, cx, cy, s, color) { doc.save().strokeColor(color).lineWidth(1.5).lineCap('round').moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy + s / 2).moveTo(cx + s / 2, cy - s / 2).lineTo(cx - s / 2, cy + s / 2).stroke().restore(); }
function gSquare(doc, cx, cy, s, color) { doc.save().fillColor(color).rect(cx - s / 2, cy - s / 2, s, s).fill().restore(); }

function drawStatus(doc, status, x, y, h, colW) {
  const col = statusColor(status);
  const cy = y + h / 2;
  let tx = x + 10;
  const st = String(status || 'Normal');
  if (st === 'Low') { gDown(doc, x + 12, cy, 6, col); tx = x + 20; }
  else if (st === 'Elevated' || st === 'High') { gUp(doc, x + 12, cy, 6, col); tx = x + 20; }
  else if (st === 'Deficient') { gSquare(doc, x + 12, cy, 6, col); tx = x + 20; }
  else if (st === 'Critical') { gUp(doc, x + 12, cy, 6, col); tx = x + 20; }
  // The status vocabulary is not fixed — an AI panel can return "Borderline
  // High" — so the label is fitted to whatever room is left in its column.
  PL.drawFit(doc, st, tx, cy - 5, Math.max(0, x + (colW || 90) - tx - 6),
    { font: 'Helvetica-Bold', size: 9, color: col });
}

/**
 * Paginating table.
 *
 * Three things make it overflow-proof:
 *  - each cell is measured at the font and width it is drawn at, and the row
 *    takes the tallest of those measurements;
 *  - a row taller than an empty page is capped to the page and its cells are
 *    ellipsised, because such a row cannot be made to fit anywhere and pushing
 *    it forward only produces blank pages;
 *  - the header is redrawn after every break, so a continued table still reads.
 */
function table(ctx, columns, rows) {
  const doc = ctx.doc;
  const xs = [];
  const ws = [];
  let acc = M;
  columns.forEach((c) => { xs.push(acc); ws.push(c.frac * CW); acc += c.frac * CW; });
  const pad = 10;
  const headerH = 24;
  const drawHeader = () => {
    box(doc, M, ctx.y, CW, headerH, C.SURFACE2);
    columns.forEach((c, i) => {
      PL.drawFit(doc, String(c.header).toUpperCase(), xs[i] + pad, ctx.y + 8, ws[i] - 2 * pad,
        { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
    });
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.advance(headerH);
  };
  ctx.ensure(headerH + 28);
  drawHeader();
  rows.forEach((row, ri) => {
    const cells = columns.map((c) => c.get(row) || {});
    const maxRowH = ctx.pageHeight() - headerH - 2;
    // Measure first, with the exact layout each cell will be drawn with.
    const lays = cells.map((cell, i) => {
      if (cell.status) return null;
      return PL.layout(doc, cell.text == null ? '' : String(cell.text), {
        font: cell.bold ? 'Helvetica-Bold' : 'Helvetica',
        size: cell.size || 10,
        width: ws[i] - 2 * pad,
        align: cell.align || 'left',
        maxHeight: maxRowH - 14
      });
    });
    let rowH = 20;
    lays.forEach((L) => { if (L && L.height + 14 > rowH) rowH = L.height + 14; });
    if (rowH > maxRowH) rowH = maxRowH;

    if (ctx.y + rowH > BOTTOM && !ctx.isFresh()) { newPage(ctx); drawHeader(); }
    box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
    const cy = ctx.y + rowH / 2;
    cells.forEach((cell, i) => {
      const cx = xs[i];
      if (cell.status) { drawStatus(doc, cell.status, cx, ctx.y, rowH, ws[i]); return; }
      const L = lays[i];
      if (!L || !L.lines.length) return;
      PL.drawLayout(doc, L, cx + pad, cy - L.height / 2, { color: cell.color || C.TEXT, align: cell.align || 'left' });
    });
    doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
    ctx.advance(rowH);
  });
  ctx.advance(8);
}

// ---- cover -------------------------------------------------------------------
function buildCover(ctx, user, ai, dateStr) {
  const doc = ctx.doc;
  // logo lockup
  let y = 130;
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

  y += PL.drawText(doc, 'Comprehensive Health Report', M, y,
    { font: 'Helvetica-Bold', size: 26, width: CW, color: C.WHITE }) + 4;
  y += PL.drawText(doc, 'Blood Analysis + Nutrition Intelligence Report', M, y,
    { font: 'Helvetica', size: 13, width: CW, color: C.MUTED }) + 22;
  doc.save().rect(M, y, CW, 1).fill(C.GREEN).restore();
  y += 12;

  // ---- patient info card ---------------------------------------------------
  // The card used to be a fixed 120pt with values dropped at fixed offsets, so
  // a long name or fitness goal ran straight through the labels beneath it and
  // out of the bottom border. Both rows are now measured first and the card is
  // whatever height those measurements need.
  const col = CW / 3;
  const valW = col - 20;
  const cell = (label, value, color, size, font) => ({
    label,
    L: PL.layout(doc, value, {
      font: font || (size >= 14 ? 'Helvetica-Bold' : 'Helvetica'),
      size,
      width: valW,
      // Two lines is the most a cover cell may take; past that the value is
      // ellipsised rather than allowed to grow the card without limit.
      maxLines: 2
    }),
    color
  });
  const row1 = [
    cell('Patient Name', user.name || '—', C.WHITE, 14),
    cell('Date of Report', dateStr, C.WHITE, 14),
    cell('Report Type', 'AI Health Analysis', C.GREEN, 14)
  ];
  const row2 = [
    cell('Age / Gender', `${user.age || '—'} / ${user.gender || '—'}`, C.TEXT, 11),
    cell('Fitness Goal', user.goal || '—', C.TEXT, 11),
    cell('Prepared By', 'BodyBank AI + Medical Review', C.MUTED, 9)
  ];
  const rowH = (r) => 14 + r.reduce((m, c) => Math.max(m, c.L.height), 0);
  const r1H = rowH(row1);
  const r2H = rowH(row2);
  const cardH = Math.max(120, 12 + r1H + 16 + r2H + 14);
  box(doc, M, y, CW, cardH, C.DARK, C.BORDER, 0.5);
  const drawRow = (r, top) => {
    r.forEach((c, i) => {
      const x = M + 14 + i * col;
      PL.drawFit(doc, c.label.toUpperCase(), x, top, valW, { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
      PL.drawLayout(doc, c.L, x, top + 14, { color: c.color });
    });
  };
  drawRow(row1, y + 12);
  drawRow(row2, y + 12 + r1H + 16);
  y += cardH + 10;

  // overall status banner — height grows to fit the AI summary (never overflow)
  const overall = ai.overall_status || 'Fair';
  const oc = (overall === 'Good' || overall === 'Excellent') ? C.GREEN : (overall === 'Fair' ? C.AMBER : C.RED);
  const summaryText = String(ai.overall_summary_short || 'Full analysis of your blood markers and nutrition follows on the next pages.');
  const sumX = M + CW * 0.45;
  const sumW = CW * 0.52;
  // The cover is one page by design, so the summary is capped to the room left
  // on it rather than pushed past the disclaimer.
  const bannerRoom = BOTTOM - y - 70;
  const sumL = PL.layout(doc, summaryText, { font: 'Helvetica', size: 10, width: sumW, lineGap: 2, maxHeight: Math.max(30, bannerRoom - 30) });
  // The verdict word is its own column; it is fitted so a long status such as
  // "Requires Immediate Clinical Attention" shrinks instead of crossing into
  // the summary.
  const verdictW = CW * 0.22;
  const bH = Math.max(74, sumL.height + 30);
  box(doc, M, y, CW, bH, C.SURFACE, oc, 1);
  const leftCy = y + bH / 2;
  PL.drawText(doc, 'OVERALL HEALTH STATUS', M + 14, leftCy - 11,
    { font: 'Helvetica-Bold', size: 8, width: CW * 0.23 - 18, color: C.MUTED, maxLines: 2 });
  PL.drawFit(doc, overall, M + CW * 0.23, leftCy - 13, verdictW,
    { font: 'Helvetica-Bold', size: 22, minSize: 9, color: oc });
  PL.drawLayout(doc, sumL, sumX, y + 15, { color: C.TEXT });
  y += bH + 14;

  doc.save().rect(M, y, CW, 0.5).fill(C.BORDER).restore();
  y += 8;
  PL.drawText(doc, 'This report is generated by BodyBank.fit AI Health System. It is for informational purposes only and does not constitute a medical diagnosis. Please share this report with your physician.',
    M, y, { font: 'Helvetica-Oblique', size: 8.5, width: CW, align: 'justify', lineGap: 2, color: C.MUTED, maxHeight: Math.max(12, BOTTOM - y) });
}

// ---- contents ----------------------------------------------------------------
function buildContents(ctx, toc) {
  const doc = ctx.doc;
  heading(ctx, 'Contents');
  ctx.advance(4);
  toc.forEach((r) => {
    const titleL = PL.layout(doc, r[1], { font: 'Helvetica-Bold', size: 10, width: CW - 34 });
    const subL = PL.layout(doc, r[2], { font: 'Helvetica', size: 8, width: CW - 34 });
    ctx.ensure(titleL.height + subL.height + 13);
    const rowY = ctx.y;
    PL.drawFit(doc, r[0], M, rowY + 4, 26, { font: 'Helvetica-Bold', size: 10, color: C.GREEN });
    PL.drawLayout(doc, titleL, M + 34, rowY, { color: C.TEXT });
    PL.drawLayout(doc, subL, M + 34, rowY + titleL.height + 1, { color: C.MUTED });
    ctx.advance(titleL.height + subL.height + 9);
    doc.save().rect(M, ctx.y - 4, CW, 0.3).fill(C.BORDER).restore();
    ctx.advance(4);
  });
}

// ---- section builders --------------------------------------------------------
function buildBlood(ctx, blood) {
  heading(ctx, '1. Blood Test Analysis');
  const cols = [
    { frac: 0.35, header: 'Marker', get: (m) => ({ text: m.name }) },
    { frac: 0.22, header: 'Value', get: (m) => ({ text: `${m.value != null ? m.value : ''} ${m.unit || ''}`.trim(), bold: true, color: C.WHITE }) },
    { frac: 0.25, header: 'Reference Range', get: (m) => ({ text: m.reference || m.reference_range || '—', color: C.MUTED, size: 9 }) },
    { frac: 0.18, header: 'Status', get: (m) => ({ status: m.status || 'Normal' }) }
  ];
  (blood.panels || []).forEach((p) => {
    if (!p || !Array.isArray(p.markers) || !p.markers.length) return;
    ctx.ensure(70);
    ctx.advance(4);
    subheading(ctx, p.name || 'Panel');
    table(ctx, cols, p.markers);
  });
}

function buildNutrition(ctx, n) {
  const doc = ctx.doc;
  heading(ctx, '2. Nutrition Intelligence');
  const avg = n.averages || {};
  const cardH = 74, col = CW / 4;
  ctx.ensure(cardH + 10);
  box(doc, M, ctx.y, CW, cardH, C.DARK, C.BORDER, 0.5);
  const macro = [
    ['AVG DAILY CALORIES', avg.calories != null ? String(avg.calories) : '—', 'kcal/day', C.AMBER],
    ['AVG PROTEIN', (avg.protein != null ? avg.protein : '—') + 'g', '/day', C.GREEN],
    ['AVG CARBS', (avg.carbs != null ? avg.carbs : '—') + 'g', '/day', C.BLUE],
    ['AVG FAT', (avg.fat != null ? avg.fat : '—') + 'g', '/day', C.RED]
  ];
  macro.forEach((mv, i) => {
    const x = M + i * col;
    if (i > 0) doc.save().rect(x, ctx.y, 0.3, cardH).fill(C.BORDER).restore();
    PL.drawFit(doc, mv[0], x + 12, ctx.y + 10, col - 20, { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
    // A six-figure calorie average must shrink into its quarter of the card
    // rather than run across the divider into the next macro.
    PL.drawFit(doc, mv[1], x + 12, ctx.y + 26, col - 20, { font: 'Helvetica-Bold', size: 20, minSize: 9, color: mv[3] });
    PL.drawFit(doc, mv[2], x + 12, ctx.y + 54, col - 20, { font: 'Helvetica', size: 9, color: C.MUTED });
  });
  ctx.advance(cardH + 10);

  if (n.meal_quality_score != null) {
    const mqs = n.meal_quality_score;
    const mqsC = mqs >= 7 ? C.GREEN : (mqs >= 5 ? C.AMBER : C.RED);
    const qText = String(n.quality_interpretation || '');
    const qX = M + CW * 0.46, qW = CW * 0.52;
    // Capped to a page: an interpretation longer than that is a data fault, and
    // a box taller than the paper cannot be placed anywhere.
    const qL = PL.layout(doc, qText, {
      font: 'Helvetica', size: 9, width: qW, lineGap: 2, maxHeight: ctx.pageHeight() - 40
    });
    const qH = Math.max(54, qL.height + 26);
    ctx.ensure(qH + 12);
    box(doc, M, ctx.y, CW, qH, C.SURFACE, mqsC, 0.5);
    const cy = ctx.y + qH / 2;
    PL.drawFit(doc, 'MEAL QUALITY SCORE', M + 12, cy - 5, CW * 0.28 - 12, { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
    PL.drawFit(doc, `${mqs}/10`, M + CW * 0.28, cy - 9, CW * 0.18, { font: 'Helvetica-Bold', size: 16, color: mqsC });
    PL.drawLayout(doc, qL, qX, ctx.y + 13, { color: C.MUTED });
    ctx.advance(qH + 12);
  }

  if (Array.isArray(n.top_meals) && n.top_meals.length) {
    subheading(ctx, 'Most Frequently Consumed Meals');
    const cols = [
      { frac: 0.4, header: 'Meal', get: (m) => ({ text: m.name }) },
      { frac: 0.18, header: 'Freq', get: (m) => ({ text: `${m.frequency}x/wk`, color: C.MUTED, size: 9 }) },
      { frac: 0.22, header: 'Avg Cal', get: (m) => ({ text: `${m.avg_calories} kcal`, bold: true, color: C.AMBER }) },
      { frac: 0.2, header: 'Assessment', get: (m) => ({ text: m.assessment || '', bold: true, size: 9, color: m.assessment === 'Good' ? C.GREEN : (m.assessment === 'Fair' ? C.AMBER : C.RED) }) }
    ];
    table(ctx, cols, n.top_meals);
  }
}

function buildClinical(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '3. Clinical Interpretation');
  ctx.y += 2;
  if (ai.clinical_interpretation) { bodyText(ctx, ai.clinical_interpretation, { align: 'justify' }); ctx.y += 6; }
  const findings = Array.isArray(ai.key_findings) ? ai.key_findings : [];
  if (findings.length) {
    subheading(ctx, 'Key Findings');
    ctx.advance(2);
    findings.forEach((f) => {
      const sev = f.severity || 'info';
      const bg = sev === 'good' ? C.INC_BG : (sev === 'critical' ? C.AVD_BG : '#2a2410');
      const bc = sev === 'good' ? C.GREEN : (sev === 'critical' ? C.RED : C.AMBER);
      // Title and detail are two different faces on one flowing run. Measuring
      // the concatenation in a single font (as this did) is wrong in both
      // directions, so the box it sized was wrong too — this is the mixed-face
      // measurement that put finding text below its own border.
      const runW = CW - 42;
      const L = PL.richLayout(doc, [
        { text: (f.title || '') + '  ', font: 'Helvetica-Bold', size: 10, color: C.TEXT },
        { text: String(f.detail || ''), font: 'Helvetica', size: 9, color: C.MUTED }
      ], runW, { maxHeight: ctx.pageHeight() - 24 });
      const h = Math.max(34, L.height + 18);
      ctx.ensure(h + 5);
      box(doc, M, ctx.y, CW, h, bg, bc, 0.5);
      const cy = ctx.y + h / 2;
      if (sev === 'good') gCheck(doc, M + 14, cy, 10, bc);
      else PL.drawFit(doc, '!', M + 11, cy - 8, 10, { font: 'Helvetica-Bold', size: 13, color: bc });
      PL.drawRich(doc, L, M + 28, cy - L.height / 2);
      ctx.advance(h + 5);
    });
  }
}

function buildRisks(ctx, ai) {
  heading(ctx, '4. Risk Assessment');
  ctx.y += 2;
  const cols = [
    { frac: 0.3, header: 'Risk Area', get: (r) => ({ text: r.area, bold: true }) },
    { frac: 0.18, header: 'Level', get: (r) => ({ text: r.level || 'Medium', bold: true, color: r.level === 'High' ? C.RED : (r.level === 'Medium' ? C.AMBER : C.GREEN) }) },
    { frac: 0.52, header: 'Contributing Factors', get: (r) => ({ text: r.factors || '', color: C.MUTED, size: 9 }) }
  ];
  table(ctx, cols, ai.risks);
}

function buildFoods(ctx, ai) {
  const doc = ctx.doc;
  if (nonEmpty(ai.foods_include)) {
    heading(ctx, '5. Foods to Include');
    ctx.y += 2;
    if (ai.foods_include_intro) bodyText(ctx, ai.foods_include_intro);
    ctx.y += 2;
    ai.foods_include.forEach((f) => foodRow(ctx, f, true));
  }
  if (nonEmpty(ai.foods_avoid)) {
    ctx.advance(10);
    ctx.ensure(80);
    PL.drawText(doc, '6. Foods to Avoid', M, ctx.y, { font: 'Helvetica-Bold', size: 15, width: CW, color: C.GREEN });
    ctx.advance(22); hr(ctx, C.RED, 1); ctx.advance(2);
    if (ai.foods_avoid_intro) bodyText(ctx, ai.foods_avoid_intro);
    ctx.advance(2);
    ai.foods_avoid.forEach((f) => foodRow(ctx, f, false));
  }
}
function foodRow(ctx, f, include) {
  const doc = ctx.doc;
  const bg = include ? C.INC_BG : C.AVD_BG;
  const bc = include ? C.GREEN : C.RED;
  // Bold food name, muted reason: measured per face so the row is exactly as
  // tall as the text inside it.
  const runW = CW - 40;
  const L = PL.richLayout(doc, [
    { text: (f.name || '') + '  —  ', font: 'Helvetica-Bold', size: 10, color: C.TEXT },
    { text: String(f.reason || ''), font: 'Helvetica', size: 9, color: C.MUTED }
  ], runW, { maxHeight: ctx.pageHeight() - 22 });
  const h = Math.max(30, L.height + 16);
  ctx.ensure(h + 3);
  box(doc, M, ctx.y, CW, h, bg, bc, 0.3);
  const cy = ctx.y + h / 2;
  if (include) gCheck(doc, M + 13, cy, 10, bc); else gCross(doc, M + 13, cy, 9, bc);
  PL.drawRich(doc, L, M + 26, cy - L.height / 2);
  ctx.advance(h + 3);
}

function buildMealPlan(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '7. Personalised Weekly Meal Plan');
  ctx.y += 2;
  if (ai.meal_plan_intro) bodyText(ctx, ai.meal_plan_intro);
  ctx.y += 2;
  const accents = [C.BLUE, C.GREEN, C.AMBER, C.PURPLE, C.RED, C.GREEN, C.PURPLE];
  const dayBgs = ['#1a2030', '#1a2820', '#2a2410', '#1a1a2e', '#2a1a1a', '#1a2828', '#201a28'];
  ai.weekly_meal_plan.forEach((day, i) => {
    const da = accents[i % accents.length];
    const db = dayBgs[i % dayBgs.length];
    const meals = Array.isArray(day.meals) ? day.meals : [];
    // Keep the day header with at least its first meal; the old estimate of
    // 22pt per meal was blind to meals that wrap, so a day block could start
    // near the bottom and run its last rows off the page.
    ctx.ensure(28 + 32);
    box(doc, M, ctx.y, CW, 28, db);
    doc.save().rect(M, ctx.y + 27, CW, 1).fill(da).restore();
    PL.drawFit(doc, day.day || '', M + 10, ctx.y + 8, CW * 0.25 - 10, { font: 'Helvetica-Bold', size: 11, color: da });
    PL.drawFit(doc, `~${day.total_calories || '—'} kcal  ·  ${day.total_protein || '—'}g protein`,
      M + CW * 0.25, ctx.y + 9, CW * 0.75 - 10, { font: 'Helvetica', size: 9, color: C.MUTED });
    ctx.advance(28);
    meals.forEach((meal, mi) => {
      const tw = CW * 0.62 - 20;
      const L = PL.layout(doc, meal.meal || '', {
        font: 'Helvetica', size: 9.5, width: tw, maxHeight: ctx.pageHeight() - 14
      });
      const h = Math.max(20, L.height + 12);
      // Every meal row gets its own break check, so a long plan paginates row
      // by row instead of spilling past the footer.
      ctx.ensure(h);
      box(doc, M, ctx.y, CW, h, mi % 2 === 0 ? C.DARK : C.SURFACE, C.BORDER, 0.3);
      const cy = ctx.y + h / 2;
      PL.drawFit(doc, String(meal.type || '').toUpperCase(), M + 10, cy - 4, CW * 0.18 - 14,
        { font: 'Helvetica-Bold', size: 8, color: C.MUTED });
      PL.drawLayout(doc, L, M + CW * 0.18, cy - L.height / 2, { color: C.TEXT });
      PL.drawFit(doc, `${meal.calories || '—'} kcal`, M + CW * 0.8, cy - 5, CW * 0.2 - 10,
        { font: 'Helvetica-Bold', size: 9, color: C.AMBER });
      ctx.advance(h);
    });
    ctx.advance(6);
  });
}

function buildSupplements(ctx, ai) {
  heading(ctx, '8. Supplement Protocol');
  ctx.y += 2;
  if (ai.supplement_intro) bodyText(ctx, ai.supplement_intro);
  ctx.y += 2;
  const cols = [
    { frac: 0.28, header: 'Supplement', get: (s) => ({ text: s.name, bold: true, color: C.BLUE }) },
    { frac: 0.2, header: 'Dose', get: (s) => ({ text: s.dose || '', color: C.MUTED, size: 9 }) },
    { frac: 0.18, header: 'Timing', get: (s) => ({ text: s.timing || '', color: C.MUTED, size: 9 }) },
    { frac: 0.34, header: 'Reason', get: (s) => ({ text: s.reason || '', color: C.MUTED, size: 9 }) }
  ];
  table(ctx, cols, ai.supplements);
}

function buildLifestyle(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '9. Lifestyle Recommendations');
  ctx.y += 2;
  const ls = ai.lifestyle || {};
  const cats = [
    ['Sleep', ls.sleep, C.BLUE],
    ['Stress Management', ls.stress, C.PURPLE],
    ['Exercise', ls.exercise, C.GREEN],
    ['Hydration', ls.hydration, C.BLUE],
    ['Recovery', ls.recovery, C.AMBER]
  ];
  const labelW = 92;
  cats.forEach((cat) => {
    if (!cat[1]) return;
    // Measured at the width AND line gap it is drawn with. The old code
    // measured 8pt narrower and without the line gap, so a long recommendation
    // was drawn taller than the box that had been sized for it.
    const bodyW = CW - labelW - 12;
    const L = PL.layout(doc, String(cat[1]), {
      font: 'Helvetica', size: 10, width: bodyW, lineGap: 2, align: 'justify',
      maxHeight: ctx.pageHeight() - 26
    });
    const h = Math.max(40, L.height + 20);
    ctx.ensure(h + 5);
    box(doc, M, ctx.y, CW, h, C.DARK, C.BORDER, 0.3);
    doc.save().rect(M, ctx.y, 3, h).fill(cat[2]).restore();
    PL.drawText(doc, cat[0], M + 12, ctx.y + 10, { font: 'Helvetica-Bold', size: 10, width: labelW - 16, color: cat[2], maxLines: 2 });
    PL.drawLayout(doc, L, M + labelW, ctx.y + 10, { color: C.TEXT, align: 'justify' });
    ctx.advance(h + 5);
  });
}

function buildProgress(ctx, ai) {
  heading(ctx, '10. Progress Tracking & Retest Schedule');
  ctx.y += 2;
  if (ai.progress_intro) bodyText(ctx, ai.progress_intro);
  ctx.y += 2;
  const cols = [
    { frac: 0.35, header: 'Test', get: (r) => ({ text: r.test, bold: true }) },
    { frac: 0.18, header: 'Retest In', get: (r) => ({ text: r.when || '', bold: true, color: C.AMBER }) },
    { frac: 0.47, header: 'Reason', get: (r) => ({ text: r.reason || '', color: C.MUTED, size: 9 }) }
  ];
  table(ctx, cols, ai.retest_schedule);
}

function buildDisclaimer(ctx, hadSections) {
  const doc = ctx.doc;
  // The report must end on a page that carries chrome. When nothing but the
  // cover was rendered we open one; otherwise the current page already counts.
  if (!hadSections) newPage(ctx);
  ctx.advance(10);
  const disc = 'This report is generated by BodyBank.fit’s AI Health System. It does not constitute a medical diagnosis. All supplement and dietary recommendations must be reviewed with your physician before implementation.';
  // The bold label and the italic body are one run in two faces; measuring only
  // the body (as before) under-sized the box by the width of the label.
  const L = PL.richLayout(doc, [
    { text: 'Medical Disclaimer: ', font: 'Helvetica-Bold', size: 8.5, color: C.MUTED },
    { text: disc, font: 'Helvetica-Oblique', size: 8.5, color: C.MUTED }
  ], CW - 28, { lineGap: 2, maxHeight: ctx.pageHeight() - 30 });
  const h = L.height + 24;
  ctx.ensure(h + 10);
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.advance(8);
  box(doc, M, ctx.y, CW, h, C.DISC_BG, C.BORDER, 0.5);
  PL.drawRich(doc, L, M + 14, ctx.y + 12);
  ctx.advance(h);
}

function formatDate(d) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

module.exports = { buildHealthReportPdf };
