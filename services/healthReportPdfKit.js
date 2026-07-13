'use strict';

/**
 * BodyBank.fit — branded blood/health report, pure Node (PDFKit).
 * No Python / ReportLab dependency — renders identically on any host.
 * Reproduces the 13-section dark-theme template (see public/reports sample).
 *
 * Payload shape (same as the old ReportLab generator):
 *   { reportId, user:{name,age,gender,goal},
 *     blood_analysis:{panels:[{name,markers:[{name,value,unit,reference,status}]}]},
 *     nutrition_analysis:{averages,meal_quality_score,quality_interpretation,top_meals},
 *     ai_report:{ overall_status, overall_summary_short, clinical_interpretation,
 *                 key_findings, risks, foods_include(_intro), foods_avoid(_intro),
 *                 meal_plan_intro, weekly_meal_plan, supplement_intro, supplements,
 *                 lifestyle, progress_intro, retest_schedule } }
 */

const path = require('path');
const fs = require('fs');

// ---- palette (matches the ReportLab template) --------------------------------
const C = {
  BG: '#0d0f11', SURFACE: '#161a1e', SURFACE2: '#1e2328', GREEN: '#3dd68c',
  AMBER: '#f5a623', BLUE: '#4da6ff', RED: '#ff5c5c', TEXT: '#f0ede8',
  MUTED: '#8a8880', WHITE: '#ffffff', DARK: '#1a1f24', BORDER: '#2a2f35',
  INC_BG: '#1a2e1a', AVD_BG: '#2e1a1a', PURPLE: '#a855f7', DISC_BG: '#141414'
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 51;                 // ~18mm margin (matches ReportLab)
const CW = PAGE_W - 2 * M;    // content width
const TOP = 70;               // content top (below header)
const BOTTOM = 782;           // content bottom (above footer band)

function statusColor(st) {
  if (st === 'Normal' || st === 'Optimal') return C.GREEN;
  if (st === 'Critical' || st === 'High' || st === 'Deficient') return C.RED;
  return C.AMBER;
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

  // Paint dark background + top green bar on every page automatically.
  doc.on('pageAdded', () => {
    doc.save();
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.BG);
    doc.rect(0, 0, PAGE_W, 2).fill(C.GREEN);
    doc.restore();
  });
  // First page doesn't fire 'pageAdded' — paint it manually.
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.BG);
  doc.rect(0, 0, PAGE_W, 2).fill(C.GREEN);
  doc.restore();

  const ctx = { doc, y: TOP, contentPages: new Set() };

  buildCover(ctx, user, ai, dateStr);
  newPage(ctx);   buildContents(ctx);
  newPage(ctx);   buildBlood(ctx, blood);
  newPage(ctx);   buildNutrition(ctx, nutrition);
  newPage(ctx);   buildClinical(ctx, ai);
  newPage(ctx);   buildRisks(ctx, ai);
  newPage(ctx);   buildFoods(ctx, ai);
  newPage(ctx);   buildMealPlan(ctx, ai);
  newPage(ctx);   buildSupplements(ctx, ai);
  newPage(ctx);   buildLifestyle(ctx, ai);
  newPage(ctx);   buildProgress(ctx, ai);

  paintChrome(doc, name, dateStr, ctx.contentPages);

  return new Promise((resolve, reject) => {
    doc.end();
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

// ---- page chrome (header/footer on content pages) ----------------------------
function newPage(ctx) {
  ctx.doc.addPage();
  ctx.y = TOP;
  ctx.contentPages.add(ctx.doc.bufferedPageRange().count - 1);
}

function paintChrome(doc, name, dateStr, contentPages) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    if (!contentPages.has(i)) continue;
    doc.switchToPage(i);
    doc.save();
    // top-right brand
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.GREEN)
      .text('BodyBank.fit', PAGE_W - M - 120, 26, { width: 120, align: 'right' });
    // footer band
    doc.rect(0, PAGE_H - 46, PAGE_W, 46).fill(C.SURFACE);
    doc.rect(M, PAGE_H - 46, CW, 0.4).fill(C.BORDER);
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED)
      .text(`BodyBank.fit  ·  Health Report  ·  ${name}`, M, PAGE_H - 26, { width: CW * 0.6, lineBreak: false });
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
function heading(ctx, txt) {
  ctx.doc.font('Helvetica-Bold').fontSize(15).fillColor(C.GREEN)
    .text(txt, M, ctx.y, { width: CW });
  ctx.y += 22;
  hr(ctx, C.GREEN, 1);
  ctx.y += 2;
}
function subheading(ctx, txt) {
  ctx.doc.font('Helvetica-Bold').fontSize(12).fillColor(C.WHITE).text(txt, M, ctx.y, { width: CW });
  ctx.y += 18;
}
function bodyText(ctx, txt, opts) {
  opts = opts || {};
  const doc = ctx.doc;
  doc.font('Helvetica').fontSize(10).fillColor(opts.color || C.TEXT);
  const w = opts.width || CW;
  doc.text(String(txt || ''), M, ctx.y, { width: w, align: opts.align || 'left', lineGap: 3 });
  ctx.y = doc.y + (opts.spaceAfter != null ? opts.spaceAfter : 6);
}

// vector glyphs (WinAnsi-safe: drawn, not typed)
function gDown(doc, cx, cy, s, color) {
  doc.save().fillColor(color)
    .moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy - s / 2).lineTo(cx, cy + s / 2).fill().restore();
}
function gUp(doc, cx, cy, s, color) {
  doc.save().fillColor(color)
    .moveTo(cx - s / 2, cy + s / 2).lineTo(cx + s / 2, cy + s / 2).lineTo(cx, cy - s / 2).fill().restore();
}
function gCheck(doc, cx, cy, s, color) {
  doc.save().strokeColor(color).lineWidth(1.5).lineJoin('round')
    .moveTo(cx - s / 2, cy).lineTo(cx - s / 8, cy + s / 2).lineTo(cx + s / 2, cy - s / 2).stroke().restore();
}
function gCross(doc, cx, cy, s, color) {
  doc.save().strokeColor(color).lineWidth(1.5).lineCap('round')
    .moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy + s / 2)
    .moveTo(cx + s / 2, cy - s / 2).lineTo(cx - s / 2, cy + s / 2).stroke().restore();
}
function gSquare(doc, cx, cy, s, color) {
  doc.save().fillColor(color).rect(cx - s / 2, cy - s / 2, s, s).fill().restore();
}

// status glyph+label used across tables
function drawStatus(doc, status, x, y, h) {
  const col = statusColor(status);
  const cy = y + h / 2;
  let tx = x + 10;
  const st = String(status || 'Normal');
  if (st === 'Low') { gDown(doc, x + 12, cy, 6, col); tx = x + 20; }
  else if (st === 'Elevated' || st === 'High') { gUp(doc, x + 12, cy, 6, col); tx = x + 20; }
  else if (st === 'Deficient') { gSquare(doc, x + 12, cy, 6, col); tx = x + 20; }
  else if (st === 'Critical') { gUp(doc, x + 12, cy, 6, col); tx = x + 20; }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(col)
    .text(st, tx, cy - 5, { width: 90, lineBreak: false });
}

/**
 * Generic table. columns: [{frac, header, get(row)->{text,color,bold,glyph}}]
 * Returns after advancing ctx.y. Auto-breaks to a new page if it overflows.
 */
function table(ctx, columns, rows, opts) {
  opts = opts || {};
  const doc = ctx.doc;
  const xs = [];
  let acc = M;
  columns.forEach((c) => { xs.push(acc); acc += c.frac * CW; });
  const pad = 10;
  const headerH = 24;

  const drawHeader = () => {
    box(doc, M, ctx.y, CW, headerH, C.SURFACE2);
    columns.forEach((c, i) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED)
        .text(String(c.header).toUpperCase(), xs[i] + pad, ctx.y + 8,
          { width: c.frac * CW - 2 * pad, lineBreak: false });
    });
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.y += headerH;
  };
  drawHeader();

  rows.forEach((row, ri) => {
    const cells = columns.map((c) => c.get(row));
    // measure row height from wrapped text
    let rowH = 20;
    cells.forEach((cell, i) => {
      const tw = columns[i].frac * CW - 2 * pad - (cell.glyph ? 10 : 0);
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.size || 10);
      const hh = doc.heightOfString(String(cell.text || ''), { width: tw }) + 14;
      if (hh > rowH) rowH = hh;
    });
    if (ctx.y + rowH > BOTTOM) { newPage(ctx); drawHeader(); }
    const bg = ri % 2 === 0 ? C.DARK : C.SURFACE;
    box(doc, M, ctx.y, CW, rowH, bg);
    const cy = ctx.y + rowH / 2;
    cells.forEach((cell, i) => {
      const cx = xs[i];
      const tw = columns[i].frac * CW - 2 * pad;
      if (cell.status) { drawStatus(doc, cell.status, cx, ctx.y, rowH); return; }
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.size || 10)
        .fillColor(cell.color || C.TEXT);
      const th = doc.heightOfString(String(cell.text || ''), { width: tw });
      doc.text(String(cell.text || ''), cx + pad, cy - th / 2, { width: tw, align: cell.align || 'left' });
    });
    // bottom border
    doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
    ctx.y += rowH;
  });
  box(doc, M, ctx.y - rows.length * 0, CW, 0, null); // noop
  ctx.y += 8;
}

// ---- section 0: cover --------------------------------------------------------
function buildCover(ctx, user, ai, dateStr) {
  const doc = ctx.doc;
  let y = 200;
  doc.font('Helvetica-Bold').fontSize(26).fillColor(C.WHITE).text('Comprehensive Health Report', M, y, { width: CW });
  y = doc.y + 4;
  doc.font('Helvetica').fontSize(13).fillColor(C.MUTED).text('Blood Analysis + Nutrition Intelligence Report', M, y, { width: CW });
  y = doc.y + 24;
  doc.save().rect(M, y, CW, 1).fill(C.GREEN).restore();
  y += 12;

  // patient info card
  const cardH = 120;
  box(doc, M, y, CW, cardH, C.DARK, C.BORDER, 0.5);
  const col = CW / 3;
  const label = (t, x, yy) => doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(t.toUpperCase(), x, yy, { width: col - 20, lineBreak: false });
  const val = (t, x, yy, color, size) => doc.font(size >= 14 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size || 11).fillColor(color || C.TEXT).text(String(t), x, yy, { width: col - 20 });
  label('Patient Name', M + 14, y + 12); label('Date of Report', M + 14 + col, y + 12); label('Report Type', M + 14 + 2 * col, y + 12);
  val(user.name || '—', M + 14, y + 26, C.WHITE, 14);
  val(dateStr, M + 14 + col, y + 26, C.WHITE, 14);
  val('AI Health Analysis', M + 14 + 2 * col, y + 26, C.GREEN, 14);
  label('Age / Gender', M + 14, y + 62); label('Fitness Goal', M + 14 + col, y + 62); label('Prepared By', M + 14 + 2 * col, y + 62);
  val(`${user.age || '—'} / ${user.gender || '—'}`, M + 14, y + 76, C.TEXT, 11);
  val(user.goal || '—', M + 14 + col, y + 76, C.TEXT, 11);
  doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text('BodyBank AI + Medical Review', M + 14 + 2 * col, y + 78, { width: col - 20 });
  y += cardH + 10;

  // overall status banner
  const overall = ai.overall_status || 'Fair';
  const oc = (overall === 'Good' || overall === 'Excellent') ? C.GREEN : (overall === 'Fair' ? C.AMBER : C.RED);
  const bH = 74;
  box(doc, M, y, CW, bH, C.SURFACE, oc, 1);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text('OVERALL HEALTH STATUS', M + 14, y + 24, { width: CW * 0.23 - 14 });
  doc.font('Helvetica-Bold').fontSize(22).fillColor(oc).text(overall, M + CW * 0.23, y + 22, { width: CW * 0.22, lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor(C.TEXT).text(String(ai.overall_summary_short || ''), M + CW * 0.45, y + 16, { width: CW * 0.53, lineGap: 2 });
  y += bH + 14;

  doc.save().rect(M, y, CW, 0.5).fill(C.BORDER).restore();
  y += 8;
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.MUTED)
    .text('This report is generated by BodyBank.fit AI Health System. It is for informational purposes only and does not constitute a medical diagnosis. Please share this report with your physician.', M, y, { width: CW, align: 'justify', lineGap: 2 });
}

// ---- section: contents -------------------------------------------------------
function buildContents(ctx) {
  const doc = ctx.doc;
  heading(ctx, 'Contents');
  const toc = [
    ['1', 'Blood Test Analysis', 'CBC, Metabolic Panel, Vitamins & Hormones'],
    ['2', 'Nutrition Intelligence', 'Dietary pattern from BodyBank meal tracker'],
    ['3', 'Clinical Interpretation', 'Doctor-level analysis of all findings'],
    ['4', 'Risk Assessment', 'Identified risks and areas of concern'],
    ['5', 'Foods to Include', 'Evidence-based food recommendations'],
    ['6', 'Foods to Avoid', 'Foods conflicting with your blood markers'],
    ['7', 'Weekly Meal Plan', 'Personalised 7-day nutrition framework'],
    ['8', 'Supplement Protocol', 'Recommended supplements for deficiencies'],
    ['9', 'Lifestyle Recommendations', 'Sleep, stress, exercise and recovery'],
    ['10', 'Progress Tracking', 'What to retest and when']
  ];
  ctx.y += 4;
  toc.forEach((r) => {
    const rowY = ctx.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.GREEN).text(r[0], M, rowY + 4, { width: 26, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT).text(r[1], M + 34, rowY, { width: CW - 34 });
    doc.font('Helvetica').fontSize(8).fillColor(C.MUTED).text(r[2], M + 34, doc.y + 1, { width: CW - 34 });
    ctx.y = doc.y + 8;
    doc.save().rect(M, ctx.y - 4, CW, 0.3).fill(C.BORDER).restore();
    ctx.y += 4;
  });
}

// ---- section 1: blood --------------------------------------------------------
function buildBlood(ctx, blood) {
  heading(ctx, '1. Blood Test Analysis');
  const panels = Array.isArray(blood.panels) ? blood.panels : [];
  const cols = [
    { frac: 0.35, header: 'Marker', get: (m) => ({ text: m.name }) },
    { frac: 0.22, header: 'Value', get: (m) => ({ text: `${m.value || ''} ${m.unit || ''}`.trim(), bold: true, color: C.WHITE }) },
    { frac: 0.25, header: 'Reference Range', get: (m) => ({ text: m.reference || m.reference_range || '—', color: C.MUTED, size: 9 }) },
    { frac: 0.18, header: 'Status', get: (m) => ({ status: m.status || 'Normal' }) }
  ];
  panels.forEach((p) => {
    if (ctx.y + 60 > BOTTOM) newPage(ctx);
    ctx.y += 4;
    subheading(ctx, p.name || 'Panel');
    table(ctx, cols, Array.isArray(p.markers) ? p.markers : []);
  });
}

// ---- section 2: nutrition ----------------------------------------------------
function buildNutrition(ctx, n) {
  const doc = ctx.doc;
  heading(ctx, '2. Nutrition Intelligence');
  const avg = n.averages || {};
  if (Object.keys(n).length) {
    // macro cards
    const cardH = 74, col = CW / 4;
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
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(mv[0], x + 12, ctx.y + 10, { width: col - 20, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(20).fillColor(mv[3]).text(mv[1], x + 12, ctx.y + 26, { width: col - 20, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text(mv[2], x + 12, ctx.y + 54, { width: col - 20, lineBreak: false });
    });
    ctx.y += cardH + 10;

    // meal quality score
    const mqs = n.meal_quality_score != null ? n.meal_quality_score : 0;
    const mqsC = mqs >= 7 ? C.GREEN : (mqs >= 5 ? C.AMBER : C.RED);
    const qH = 54;
    box(doc, M, ctx.y, CW, qH, C.SURFACE, mqsC, 0.5);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text('MEAL QUALITY SCORE', M + 12, ctx.y + 22, { width: CW * 0.28 - 12 });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(mqsC).text(`${mqs}/10`, M + CW * 0.28, ctx.y + 18, { width: CW * 0.18, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text(String(n.quality_interpretation || ''), M + CW * 0.46, ctx.y + 14, { width: CW * 0.52, lineGap: 2 });
    ctx.y += qH + 12;

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
  } else {
    bodyText(ctx, 'No nutrition tracking data available. Begin logging meals in BodyBank to unlock this section.', { color: C.MUTED });
  }
}

// ---- section 3: clinical -----------------------------------------------------
function buildClinical(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '3. Clinical Interpretation');
  ctx.y += 2;
  bodyText(ctx, ai.clinical_interpretation || '', { align: 'justify' });
  ctx.y += 6;
  const findings = Array.isArray(ai.key_findings) ? ai.key_findings : [];
  if (findings.length) {
    subheading(ctx, 'Key Findings');
    ctx.y += 2;
    findings.forEach((f) => {
      const sev = f.severity || 'info';
      const bg = sev === 'good' ? C.INC_BG : (sev === 'critical' ? C.AVD_BG : '#2a2410');
      const bc = sev === 'good' ? C.GREEN : (sev === 'critical' ? C.RED : C.AMBER);
      const detail = `${f.title || ''}   ${f.detail || ''}`;
      doc.font('Helvetica').fontSize(10);
      const th = doc.heightOfString(detail, { width: CW - 34 });
      const h = Math.max(34, th + 18);
      if (ctx.y + h > BOTTOM) newPage(ctx);
      box(doc, M, ctx.y, CW, h, bg, bc, 0.5);
      // icon
      const cy = ctx.y + h / 2;
      if (sev === 'good') gCheck(doc, M + 14, cy, 10, bc);
      else doc.font('Helvetica-Bold').fontSize(13).fillColor(bc).text('!', M + 11, cy - 8, { width: 10, lineBreak: false });
      // title + detail (title bold, detail muted) on one flow
      const tx = M + 28;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT);
      const titleW = doc.widthOfString((f.title || '') + '  ');
      doc.text((f.title || '') + '  ', tx, cy - th / 2, { width: CW - 34, continued: true })
        .font('Helvetica').fontSize(9).fillColor(C.MUTED).text(String(f.detail || ''));
      ctx.y += h + 5;
    });
  }
}

// ---- section 4: risks --------------------------------------------------------
function buildRisks(ctx, ai) {
  heading(ctx, '4. Risk Assessment');
  ctx.y += 2;
  const risks = Array.isArray(ai.risks) ? ai.risks : [];
  const cols = [
    { frac: 0.3, header: 'Risk Area', get: (r) => ({ text: r.area, bold: true }) },
    { frac: 0.18, header: 'Level', get: (r) => ({ text: r.level || 'Medium', bold: true, color: r.level === 'High' ? C.RED : (r.level === 'Medium' ? C.AMBER : C.GREEN) }) },
    { frac: 0.52, header: 'Contributing Factors', get: (r) => ({ text: r.factors || '', color: C.MUTED, size: 9 }) }
  ];
  if (risks.length) table(ctx, cols, risks);
}

// ---- sections 5 & 6: foods ---------------------------------------------------
function buildFoods(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '5. Foods to Include');
  ctx.y += 2;
  bodyText(ctx, ai.foods_include_intro || '');
  ctx.y += 2;
  (Array.isArray(ai.foods_include) ? ai.foods_include : []).forEach((f) => foodRow(ctx, f, true));

  ctx.y += 10;
  if (ctx.y + 80 > BOTTOM) newPage(ctx);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.GREEN).text('6. Foods to Avoid', M, ctx.y, { width: CW });
  ctx.y += 22; hr(ctx, C.RED, 1); ctx.y += 2;
  bodyText(ctx, ai.foods_avoid_intro || '');
  ctx.y += 2;
  (Array.isArray(ai.foods_avoid) ? ai.foods_avoid : []).forEach((f) => foodRow(ctx, f, false));
}
function foodRow(ctx, f, include) {
  const doc = ctx.doc;
  const bg = include ? C.INC_BG : C.AVD_BG;
  const bc = include ? C.GREEN : C.RED;
  const detail = `${f.name || ''}  —  ${f.reason || ''}`;
  doc.font('Helvetica').fontSize(10);
  const th = doc.heightOfString(detail, { width: CW - 34 });
  const h = Math.max(30, th + 16);
  if (ctx.y + h > BOTTOM) newPage(ctx);
  box(doc, M, ctx.y, CW, h, bg, bc, 0.3);
  const cy = ctx.y + h / 2;
  if (include) gCheck(doc, M + 13, cy, 10, bc); else gCross(doc, M + 13, cy, 9, bc);
  const tx = M + 26;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT)
    .text((f.name || '') + '  —  ', tx, cy - th / 2, { width: CW - 34, continued: true })
    .font('Helvetica').fontSize(9).fillColor(C.MUTED).text(String(f.reason || ''));
  ctx.y += h + 3;
}

// ---- section 7: meal plan ----------------------------------------------------
function buildMealPlan(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '7. Personalised Weekly Meal Plan');
  ctx.y += 2;
  bodyText(ctx, ai.meal_plan_intro || '');
  ctx.y += 2;
  const accents = [C.BLUE, C.GREEN, C.AMBER, C.PURPLE, C.RED, C.GREEN, C.PURPLE];
  const dayBgs = ['#1a2030', '#1a2820', '#2a2410', '#1a1a2e', '#2a1a1a', '#1a2828', '#201a28'];
  const days = Array.isArray(ai.weekly_meal_plan) ? ai.weekly_meal_plan : [];
  days.forEach((day, i) => {
    const da = accents[i % accents.length];
    const db = dayBgs[i % dayBgs.length];
    const meals = Array.isArray(day.meals) ? day.meals : [];
    const needed = 30 + meals.length * 22;
    if (ctx.y + needed > BOTTOM) newPage(ctx);
    // day header
    box(doc, M, ctx.y, CW, 28, db);
    doc.save().rect(M, ctx.y + 28 - 1, CW, 1).fill(da).restore();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(da).text(day.day || '', M + 10, ctx.y + 8, { width: CW * 0.25, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED)
      .text(`~${day.total_calories || '—'} kcal  ·  ${day.total_protein || '—'}g protein`, M + CW * 0.25, ctx.y + 9, { width: CW * 0.75 - 10, lineBreak: false });
    ctx.y += 28;
    // meals
    meals.forEach((meal, mi) => {
      doc.font('Helvetica').fontSize(9.5);
      const tw = CW * 0.62 - 20;
      const th = doc.heightOfString(meal.meal || '', { width: tw });
      const h = Math.max(20, th + 12);
      const bg = mi % 2 === 0 ? C.DARK : C.SURFACE;
      box(doc, M, ctx.y, CW, h, bg, C.BORDER, 0.3);
      const cy = ctx.y + h / 2;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(String(meal.type || '').toUpperCase(), M + 10, cy - 4, { width: CW * 0.18 - 12, lineBreak: false });
      doc.font('Helvetica').fontSize(9.5).fillColor(C.TEXT).text(meal.meal || '', M + CW * 0.18, cy - th / 2, { width: tw });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.AMBER).text(`${meal.calories || '—'} kcal`, M + CW * 0.8, cy - 5, { width: CW * 0.2 - 10, align: 'left', lineBreak: false });
      ctx.y += h;
    });
    ctx.y += 6;
  });
}

// ---- section 8: supplements --------------------------------------------------
function buildSupplements(ctx, ai) {
  heading(ctx, '8. Supplement Protocol');
  ctx.y += 2;
  bodyText(ctx, ai.supplement_intro || '');
  ctx.y += 2;
  const sups = Array.isArray(ai.supplements) ? ai.supplements : [];
  const cols = [
    { frac: 0.28, header: 'Supplement', get: (s) => ({ text: s.name, bold: true, color: C.BLUE }) },
    { frac: 0.2, header: 'Dose', get: (s) => ({ text: s.dose || '', color: C.MUTED, size: 9 }) },
    { frac: 0.18, header: 'Timing', get: (s) => ({ text: s.timing || '', color: C.MUTED, size: 9 }) },
    { frac: 0.34, header: 'Reason', get: (s) => ({ text: s.reason || '', color: C.MUTED, size: 9 }) }
  ];
  if (sups.length) table(ctx, cols, sups);
}

// ---- section 9: lifestyle ----------------------------------------------------
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
    doc.font('Helvetica').fontSize(10);
    const th = doc.heightOfString(String(cat[1]), { width: CW - labelW - 20 });
    const h = Math.max(40, th + 20);
    if (ctx.y + h > BOTTOM) newPage(ctx);
    box(doc, M, ctx.y, CW, h, C.DARK, C.BORDER, 0.3);
    doc.save().rect(M, ctx.y, 3, h).fill(cat[2]).restore();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(cat[2]).text(cat[0], M + 12, ctx.y + 10, { width: labelW - 4 });
    doc.font('Helvetica').fontSize(10).fillColor(C.TEXT).text(String(cat[1]), M + labelW, ctx.y + 10, { width: CW - labelW - 12, align: 'justify', lineGap: 2 });
    ctx.y += h + 5;
  });
}

// ---- section 10: progress ----------------------------------------------------
function buildProgress(ctx, ai) {
  const doc = ctx.doc;
  heading(ctx, '10. Progress Tracking & Retest Schedule');
  ctx.y += 2;
  bodyText(ctx, ai.progress_intro || '');
  ctx.y += 2;
  const retests = Array.isArray(ai.retest_schedule) ? ai.retest_schedule : [];
  const cols = [
    { frac: 0.35, header: 'Test', get: (r) => ({ text: r.test, bold: true }) },
    { frac: 0.18, header: 'Retest In', get: (r) => ({ text: r.when || '', bold: true, color: C.AMBER }) },
    { frac: 0.47, header: 'Reason', get: (r) => ({ text: r.reason || '', color: C.MUTED, size: 9 }) }
  ];
  if (retests.length) table(ctx, cols, retests);

  ctx.y += 10;
  if (ctx.y + 90 > BOTTOM) newPage(ctx);
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.y += 8;
  const disc = 'Medical Disclaimer:  This report is generated by BodyBank.fit’s AI Health System. It does not constitute a medical diagnosis. All supplement and dietary recommendations must be reviewed with your physician before implementation.';
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.MUTED);
  const th = doc.heightOfString(disc, { width: CW - 28 });
  const h = th + 24;
  box(doc, M, ctx.y, CW, h, C.DISC_BG, C.BORDER, 0.5);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.MUTED).text('Medical Disclaimer: ', M + 14, ctx.y + 12, { continued: true })
    .font('Helvetica-Oblique').fillColor(C.MUTED)
    .text('This report is generated by BodyBank.fit’s AI Health System. It does not constitute a medical diagnosis. All supplement and dietary recommendations must be reviewed with your physician before implementation.', { width: CW - 28, lineGap: 2 });
  ctx.y += h;
}

function formatDate(d) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

module.exports = { buildHealthReportPdf };
