'use strict';

/**
 * BodyBank.fit — Blood Report PROGRESS / COMPARISON report (pure Node, PDFKit).
 * Same dark-green brand system + gold coin as the single-report health PDF, but
 * built around the trajectory: a marker-trend table (one column per test date),
 * improvements vs concerns, and updated recommendations. Sections with no data
 * are skipped entirely (no blank pages).
 */

const path = require('path');
const fs = require('fs');

const C = {
  BG: '#0d0f11', SURFACE: '#161a1e', SURFACE2: '#1e2328', GREEN: '#3dd68c',
  AMBER: '#f5a623', BLUE: '#4da6ff', RED: '#ff5c5c', TEXT: '#f0ede8',
  MUTED: '#8a8880', WHITE: '#ffffff', DARK: '#1a1f24', BORDER: '#2a2f35',
  INC_BG: '#1a2e1a', AVD_BG: '#2e1a1a', PURPLE: '#a855f7', DISC_BG: '#141414',
  GOLD: '#e6c46a', GOLD_DIM: '#c8a44e'
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

function nonEmpty(v) { return Array.isArray(v) && v.length > 0; }
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

function formatDate(d) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function shortDate(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v || '—');
  return `${String(d.getDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

// glyphs (WinAnsi-safe, drawn)
function gUp(doc, cx, cy, s, color) { doc.save().fillColor(color).moveTo(cx - s / 2, cy + s / 2).lineTo(cx + s / 2, cy + s / 2).lineTo(cx, cy - s / 2).fill().restore(); }
function gDown(doc, cx, cy, s, color) { doc.save().fillColor(color).moveTo(cx - s / 2, cy - s / 2).lineTo(cx + s / 2, cy - s / 2).lineTo(cx, cy + s / 2).fill().restore(); }
function gDash(doc, cx, cy, s, color) { doc.save().strokeColor(color).lineWidth(1.6).lineCap('round').moveTo(cx - s / 2, cy).lineTo(cx + s / 2, cy).stroke().restore(); }
function gCheck(doc, cx, cy, s, color) { doc.save().strokeColor(color).lineWidth(1.5).lineJoin('round').moveTo(cx - s / 2, cy).lineTo(cx - s / 8, cy + s / 2).lineTo(cx + s / 2, cy - s / 2).stroke().restore(); }

function buildComparisonReportPdf(payload, outPath) {
  const PDFDocument = require('pdfkit');
  const user = (payload && payload.user) || {};
  const comparison = (payload && payload.comparison) || {};
  const verdict = (payload && payload.verdict) || {};
  const adminNotes = String((payload && payload.adminNotes) || '').trim();
  const reports = Array.isArray(comparison.reports) ? comparison.reports : [];
  const panels = Array.isArray(comparison.panels) ? comparison.panels : [];
  const dateStr = formatDate(new Date());
  const name = String(user.name || 'Member');

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);
  doc.on('pageAdded', () => paintBg(doc));
  paintBg(doc);

  const ctx = { doc, y: TOP, contentPages: new Set() };

  buildCover(ctx, user, verdict, reports, dateStr);

  // Only markers that actually moved or are abnormal make the trend table — keeps
  // the report focused on the story, not 80 unchanged rows.
  const trendPanels = panels
    .map((p) => ({ name: p.name, markers: (p.markers || []).filter((m) => m.changed || m.anyAbnormal) }))
    .filter((p) => p.markers.length);

  if (trendPanels.length) { newPage(ctx); buildTrendTables(ctx, trendPanels, reports); }
  if (verdict.trajectory_narrative || verdict.executive_summary) { newPage(ctx); buildNarrative(ctx, verdict); }
  if (nonEmpty(verdict.improvements) || nonEmpty(verdict.concerns) || nonEmpty(verdict.unchanged_watch)) {
    newPage(ctx); buildChanges(ctx, verdict);
  }
  if (verdict.interventions_assessment || nonEmpty(verdict.updated_recommendations) || nonEmpty(verdict.updated_supplements)) {
    newPage(ctx); buildActions(ctx, verdict);
  }
  if (nonEmpty(verdict.next_retest) || verdict.final_verdict || adminNotes) {
    newPage(ctx); buildClose(ctx, verdict, adminNotes);
  }

  buildDisclaimer(ctx, ctx.contentPages.size > 0);
  paintChrome(doc, name, dateStr, ctx.contentPages);

  return new Promise((resolve, reject) => {
    doc.end();
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
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
function heading(ctx, txt, ruleColor) {
  ctx.doc.font('Helvetica-Bold').fontSize(15).fillColor(C.GREEN).text(txt, M, ctx.y, { width: CW });
  ctx.y += 22;
  hr(ctx, ruleColor || C.GREEN, 1);
  ctx.y += 2;
}
function subheading(ctx, txt) {
  ctx.doc.font('Helvetica-Bold').fontSize(12).fillColor(C.WHITE).text(txt, M, ctx.y, { width: CW });
  ctx.y += 18;
}
function bodyText(ctx, txt, opts) {
  opts = opts || {};
  const doc = ctx.doc;
  doc.font(opts.oblique ? 'Helvetica-Oblique' : 'Helvetica').fontSize(opts.size || 10).fillColor(opts.color || C.TEXT);
  doc.text(String(txt || ''), M, ctx.y, { width: opts.width || CW, align: opts.align || 'left', lineGap: 3 });
  ctx.y = doc.y + (opts.spaceAfter != null ? opts.spaceAfter : 6);
}

// ---- cover -------------------------------------------------------------------
function buildCover(ctx, user, verdict, reports, dateStr) {
  const doc = ctx.doc;
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

  doc.font('Helvetica-Bold').fontSize(26).fillColor(C.WHITE).text('Blood Report Progress Review', M, y, { width: CW });
  y = doc.y + 4;
  const n = reports.length;
  doc.font('Helvetica').fontSize(13).fillColor(C.MUTED)
    .text(`Longitudinal comparison across ${n} test${n === 1 ? '' : 's'}`, M, y, { width: CW });
  y = doc.y + 20;
  doc.save().rect(M, y, CW, 1).fill(C.GREEN).restore();
  y += 12;

  // patient + tests-compared card
  const cardH = 118;
  box(doc, M, y, CW, cardH, C.DARK, C.BORDER, 0.5);
  const col = CW / 3;
  const label = (t, x, yy) => doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text(t.toUpperCase(), x, yy, { width: col - 20, lineBreak: false });
  const val = (t, x, yy, color, size) => doc.font(size >= 14 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size || 11).fillColor(color || C.TEXT).text(String(t), x, yy, { width: col - 20 });
  label('Patient Name', M + 14, y + 12); label('Report Date', M + 14 + col, y + 12); label('Report Type', M + 14 + 2 * col, y + 12);
  val(user.name || '—', M + 14, y + 26, C.WHITE, 14);
  val(dateStr, M + 14 + col, y + 26, C.WHITE, 14);
  val('Progress Review', M + 14 + 2 * col, y + 26, C.GREEN, 14);
  label('Age / Gender', M + 14, y + 62); label('Fitness Goal', M + 14 + col, y + 62); label('Tests Compared', M + 14 + 2 * col, y + 62);
  val(`${user.age || '—'} / ${user.gender || '—'}`, M + 14, y + 76, C.TEXT, 11);
  val(user.goal || '—', M + 14 + col, y + 76, C.TEXT, 11);
  const span = n >= 2 ? `${shortDate(reports[0].date)}  →  ${shortDate(reports[n - 1].date)}` : (n === 1 ? shortDate(reports[0].date) : '—');
  doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text(span, M + 14 + 2 * col, y + 78, { width: col - 20 });
  y += cardH + 10;

  // trajectory banner
  const traj = String(verdict.overall_trajectory || 'Mixed');
  const tc = /improv/i.test(traj) ? C.GREEN : (/worsen/i.test(traj) ? C.RED : (/stable/i.test(traj) ? C.BLUE : C.AMBER));
  const summaryText = String(verdict.executive_summary || 'The trajectory of your key blood markers across these tests is summarised on the following pages.');
  const sumX = M + CW * 0.32;
  const sumW = CW * 0.65;
  doc.font('Helvetica').fontSize(10);
  const sumH = doc.heightOfString(summaryText, { width: sumW, lineGap: 2 });
  const bH = Math.max(78, sumH + 30);
  box(doc, M, y, CW, bH, C.SURFACE, tc, 1);
  const leftCy = y + bH / 2;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text('OVERALL TRAJECTORY', M + 14, leftCy - 20, { width: CW * 0.3 - 18 });
  doc.font('Helvetica-Bold').fontSize(19).fillColor(tc).text(traj, M + 14, leftCy - 6, { width: CW * 0.3 - 14, lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor(C.TEXT).text(summaryText, sumX, y + 15, { width: sumW, lineGap: 2 });
  y += bH + 12;

  // quick stat chips
  const chips = [
    ['IMPROVING', String(verdict.__improved != null ? verdict.__improved : ''), C.GREEN],
    ['WORSENING', String(verdict.__worsened != null ? verdict.__worsened : ''), C.RED],
    ['MARKERS TRACKED', String(verdict.__markerCount != null ? verdict.__markerCount : ''), C.BLUE]
  ].filter((c) => c[1] !== '');
  if (chips.length) {
    const cw = (CW - 2 * 10) / chips.length;
    chips.forEach((c, i) => {
      const x = M + i * (cw + 10);
      box(doc, x, y, cw, 46, C.DARK, C.BORDER, 0.4);
      doc.font('Helvetica-Bold').fontSize(18).fillColor(c[2]).text(c[1], x + 12, y + 8, { width: cw - 24, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.MUTED).text(c[0], x + 12, y + 30, { width: cw - 24, lineBreak: false });
    });
    y += 46 + 10;
  }

  doc.save().rect(M, y, CW, 0.5).fill(C.BORDER).restore();
  y += 8;
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.MUTED)
    .text('This progress report compares your own previous BodyBank blood analyses. It is for informational purposes only and does not constitute a medical diagnosis. Please review it with your physician.', M, y, { width: CW, align: 'justify', lineGap: 2 });
}

// ---- trend table -------------------------------------------------------------
function buildTrendTables(ctx, trendPanels, reports) {
  const doc = ctx.doc;
  heading(ctx, 'Marker Trend — value at each test');
  ctx.y += 2;
  bodyText(ctx, 'Only markers that moved or were flagged are shown. The trend column reflects movement relative to the reference range (green = moving into range, red = moving away).', { color: C.MUTED, size: 9 });
  ctx.y += 4;

  const nCols = reports.length;
  // layout: Marker (fixed) | Ref (fixed) | one column per date | Trend (fixed)
  const markerFrac = 0.26;
  const refFrac = 0.16;
  const trendFrac = 0.12;
  const dateFrac = Math.max(0.08, (1 - markerFrac - refFrac - trendFrac) / Math.max(1, nCols));
  const pad = 8;

  const cols = [];
  cols.push({ w: markerFrac * CW, header: 'Marker', kind: 'marker' });
  cols.push({ w: refFrac * CW, header: 'Reference', kind: 'ref' });
  reports.forEach((r, i) => cols.push({ w: dateFrac * CW, header: shortDate(r.date), kind: 'date', dateIndex: i }));
  cols.push({ w: trendFrac * CW, header: 'Trend', kind: 'trend' });
  // normalize widths to fill CW
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

  trendPanels.forEach((panel) => {
    if (ctx.y + 60 > BOTTOM) newPage(ctx);
    ctx.y += 4;
    subheading(ctx, panel.name);
    drawHeader();
    panel.markers.forEach((m, ri) => {
      // row height from marker name wrap
      doc.font('Helvetica-Bold').fontSize(9);
      const nameH = doc.heightOfString(m.display, { width: cols[0].w - 2 * pad });
      const rowH = Math.max(22, nameH + 12);
      if (ctx.y + rowH > BOTTOM) { newPage(ctx); drawHeader(); }
      box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
      const cy = ctx.y + rowH / 2;
      cols.forEach((c, i) => {
        const x = xs[i] + pad;
        const w = c.w - 2 * pad;
        if (c.kind === 'marker') {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.TEXT).text(m.display, x, cy - nameH / 2, { width: w });
        } else if (c.kind === 'ref') {
          doc.font('Helvetica').fontSize(8).fillColor(C.MUTED).text(m.referenceRange || '—', x, cy - 5, { width: w });
        } else if (c.kind === 'date') {
          const cell = m.cells[c.dateIndex];
          if (cell && cell.present) {
            const col = statusColorLite(cell.status);
            doc.font('Helvetica-Bold').fontSize(9).fillColor(col).text(String(cell.value || '—'), x, cy - 6, { width: w, lineBreak: false });
          } else {
            doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text('—', x, cy - 6, { width: w, lineBreak: false });
          }
        } else if (c.kind === 'trend') {
          drawTrend(doc, m, xs[i], ctx.y, c.w, rowH);
        }
      });
      doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
      ctx.y += rowH;
    });
    ctx.y += 10;
  });
}

function statusColorLite(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'normal' || s === 'optimal') return C.GREEN;
  if (s === 'critical' || s === 'high' || s === 'deficient' || s === 'elevated') return C.RED;
  if (!s) return C.TEXT;
  return C.AMBER;
}

function drawTrend(doc, m, x0, y0, w, h) {
  const cx = x0 + 14;
  const cy = y0 + h / 2;
  // Colour carries the CLINICAL meaning (improving/worsening/stable); the arrow
  // direction reflects the raw numeric move (up/down). WinAnsi-safe vector glyphs.
  const col = trajColor(m.direction);
  if (m.delta != null && Math.abs(m.delta) > 1e-9) {
    if (m.delta > 0) gUp(doc, cx, cy, 7, col); else gDown(doc, cx, cy, 7, col);
  } else {
    gDash(doc, cx, cy, 8, col);
  }
  const label = m.deltaPct != null
    ? `${m.delta > 0 ? '+' : ''}${m.deltaPct}%`
    : (m.delta != null ? `${m.delta > 0 ? '+' : ''}${m.delta}` : '');
  if (label) doc.font('Helvetica-Bold').fontSize(7.5).fillColor(col).text(label, cx + 8, cy - 4, { width: w - 22, lineBreak: false });
}

// ---- narrative ---------------------------------------------------------------
function buildNarrative(ctx, verdict) {
  heading(ctx, 'Clinical Trajectory');
  ctx.y += 2;
  if (verdict.trajectory_score_delta) {
    const doc = ctx.doc;
    box(doc, M, ctx.y, CW, 30, C.SURFACE, C.GREEN, 0.5);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text('MOVEMENT', M + 12, ctx.y + 6, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.GREEN).text(String(verdict.trajectory_score_delta), M + 90, ctx.y + 9, { width: CW - 100, lineBreak: false });
    ctx.y += 30 + 10;
  }
  if (verdict.trajectory_narrative) bodyText(ctx, verdict.trajectory_narrative, { align: 'justify' });
  else if (verdict.executive_summary) bodyText(ctx, verdict.executive_summary, { align: 'justify' });
}

// ---- improvements / concerns -------------------------------------------------
function changeCard(ctx, item, kind) {
  const doc = ctx.doc;
  const good = kind === 'good';
  const bg = good ? C.INC_BG : (kind === 'watch' ? '#2a2410' : C.AVD_BG);
  const bc = good ? C.GREEN : (kind === 'watch' ? C.AMBER : C.RED);
  const from = item.from != null ? String(item.from) : '';
  const to = item.to != null ? String(item.to) : (item.value != null ? String(item.value) : '');
  const arrow = from && to ? `${from}  →  ${to}` : (to || from || '');
  const meaning = String(item.meaning || item.note || '');
  const title = String(item.marker || '');
  doc.font('Helvetica').fontSize(9.5);
  const th = doc.heightOfString(meaning, { width: CW - 130 });
  const h = Math.max(38, th + 20);
  if (ctx.y + h > BOTTOM) newPage(ctx);
  box(doc, M, ctx.y, CW, h, bg, bc, 0.5);
  doc.save().rect(M, ctx.y, 3, h).fill(bc).restore();
  const topY = ctx.y + 10;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT).text(title, M + 14, topY, { width: CW - 150 });
  if (item.level) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(levelColor(item.level)).text(String(item.level).toUpperCase(), M + CW - 60, topY, { width: 50, align: 'right', lineBreak: false });
  }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(bc).text(arrow, M + 14, topY + 14, { width: CW - 28, lineBreak: false });
  doc.font('Helvetica').fontSize(9.5).fillColor(C.MUTED).text(meaning, M + 14, topY + 28, { width: CW - 28, lineGap: 2 });
  ctx.y += h + 6;
}

function buildChanges(ctx, verdict) {
  heading(ctx, 'What Changed');
  ctx.y += 2;
  if (nonEmpty(verdict.improvements)) {
    subheading(ctx, 'Improvements');
    ctx.y += 2;
    verdict.improvements.forEach((it) => changeCard(ctx, it, 'good'));
    ctx.y += 6;
  }
  if (nonEmpty(verdict.concerns)) {
    if (ctx.y + 70 > BOTTOM) newPage(ctx);
    subheading(ctx, 'Concerns');
    ctx.y += 2;
    verdict.concerns.forEach((it) => changeCard(ctx, it, 'bad'));
    ctx.y += 6;
  }
  if (nonEmpty(verdict.unchanged_watch)) {
    if (ctx.y + 70 > BOTTOM) newPage(ctx);
    subheading(ctx, 'Still to Watch');
    ctx.y += 2;
    verdict.unchanged_watch.forEach((it) => changeCard(ctx, it, 'watch'));
  }
}

// ---- actions -----------------------------------------------------------------
function simpleTable(ctx, title, ruleColor, columns, rows) {
  const doc = ctx.doc;
  if (!nonEmpty(rows)) return;
  if (ctx.y + 80 > BOTTOM) newPage(ctx);
  subheading(ctx, title);
  const xs = [];
  let acc = M;
  columns.forEach((c) => { xs.push(acc); acc += c.frac * CW; });
  const pad = 9;
  const headerH = 24;
  const drawHeader = () => {
    box(doc, M, ctx.y, CW, headerH, C.SURFACE2);
    columns.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED)
      .text(String(c.header).toUpperCase(), xs[i] + pad, ctx.y + 8, { width: c.frac * CW - 2 * pad, lineBreak: false }));
    box(doc, M, ctx.y, CW, headerH, null, C.BORDER, 0.4);
    ctx.y += headerH;
  };
  drawHeader();
  rows.forEach((row, ri) => {
    const cells = columns.map((c) => c.get(row));
    let rowH = 20;
    cells.forEach((cell, i) => {
      const tw = columns[i].frac * CW - 2 * pad;
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.size || 9.5);
      const hh = doc.heightOfString(String(cell.text || ''), { width: tw }) + 12;
      if (hh > rowH) rowH = hh;
    });
    if (ctx.y + rowH > BOTTOM) { newPage(ctx); drawHeader(); }
    box(doc, M, ctx.y, CW, rowH, ri % 2 === 0 ? C.DARK : C.SURFACE);
    const cy = ctx.y + rowH / 2;
    cells.forEach((cell, i) => {
      const tw = columns[i].frac * CW - 2 * pad;
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.size || 9.5).fillColor(cell.color || C.TEXT);
      const th = doc.heightOfString(String(cell.text || ''), { width: tw });
      doc.text(String(cell.text || ''), xs[i] + pad, cy - th / 2, { width: tw, align: cell.align || 'left' });
    });
    doc.save().rect(M, ctx.y + rowH - 0.3, CW, 0.3).fill(C.BORDER).restore();
    ctx.y += rowH;
  });
  ctx.y += 10;
}

function buildActions(ctx, verdict) {
  heading(ctx, 'What To Do Now');
  ctx.y += 2;
  if (verdict.interventions_assessment) {
    bodyText(ctx, verdict.interventions_assessment, { align: 'justify' });
    ctx.y += 4;
  }
  simpleTable(ctx, 'Updated Recommendations', C.GREEN,
    [
      { frac: 0.2, header: 'Area', get: (r) => ({ text: r.area || '', bold: true, color: C.BLUE }) },
      { frac: 0.42, header: 'Action', get: (r) => ({ text: r.action || '' }) },
      { frac: 0.38, header: 'Why', get: (r) => ({ text: r.reason || '', color: C.MUTED, size: 9 }) }
    ], verdict.updated_recommendations);
  simpleTable(ctx, 'Supplement Plan', C.BLUE,
    [
      { frac: 0.26, header: 'Supplement', get: (s) => ({ text: s.name || '', bold: true, color: C.BLUE }) },
      { frac: 0.16, header: 'Action', get: (s) => ({ text: s.action || '', bold: true, color: supplActionColor(s.action) }) },
      { frac: 0.2, header: 'Dose', get: (s) => ({ text: s.dose || '', color: C.MUTED, size: 9 }) },
      { frac: 0.38, header: 'Reason', get: (s) => ({ text: s.reason || '', color: C.MUTED, size: 9 }) }
    ], verdict.updated_supplements);
}
function supplActionColor(a) {
  const s = String(a || '').toLowerCase();
  if (s === 'stop') return C.RED;
  if (s === 'start') return C.GREEN;
  if (s === 'adjust') return C.AMBER;
  return C.TEXT;
}

// ---- close -------------------------------------------------------------------
function buildClose(ctx, verdict, adminNotes) {
  heading(ctx, 'Next Steps');
  ctx.y += 2;
  simpleTable(ctx, 'Recommended Retesting', C.AMBER,
    [
      { frac: 0.36, header: 'Test', get: (r) => ({ text: r.test || '', bold: true }) },
      { frac: 0.2, header: 'When', get: (r) => ({ text: r.when || '', bold: true, color: C.AMBER }) },
      { frac: 0.44, header: 'Reason', get: (r) => ({ text: r.reason || '', color: C.MUTED, size: 9 }) }
    ], verdict.next_retest);

  if (verdict.final_verdict) {
    const doc = ctx.doc;
    if (ctx.y + 70 > BOTTOM) newPage(ctx);
    doc.font('Helvetica').fontSize(11);
    const th = doc.heightOfString(String(verdict.final_verdict), { width: CW - 28, lineGap: 2 });
    const h = th + 26;
    box(doc, M, ctx.y, CW, h, C.SURFACE, C.GREEN, 1);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.MUTED).text('BOTTOM LINE', M + 14, ctx.y + 10, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.TEXT).text(String(verdict.final_verdict), M + 14, ctx.y + 22, { width: CW - 28, lineGap: 2 });
    ctx.y += h + 10;
  }

  if (adminNotes) {
    const doc = ctx.doc;
    if (ctx.y + 70 > BOTTOM) newPage(ctx);
    subheading(ctx, 'A Note From Your Coach');
    doc.font('Helvetica').fontSize(10);
    const th = doc.heightOfString(adminNotes, { width: CW - 28, lineGap: 2 });
    const h = th + 22;
    box(doc, M, ctx.y, CW, h, C.DARK, C.GOLD_DIM, 0.6);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(C.TEXT).text(adminNotes, M + 14, ctx.y + 11, { width: CW - 28, lineGap: 2 });
    ctx.y += h + 8;
  }
}

// ---- disclaimer --------------------------------------------------------------
function buildDisclaimer(ctx, hadSections) {
  const doc = ctx.doc;
  if (!hadSections) newPage(ctx);
  ctx.y += 10;
  if (ctx.y + 90 > BOTTOM) newPage(ctx);
  doc.save().rect(M, ctx.y, CW, 0.5).fill(C.BORDER).restore();
  ctx.y += 8;
  const disc = 'This progress report is generated by BodyBank.fit’s AI Health System from your own previous blood analyses. It does not constitute a medical diagnosis. All supplement and dietary recommendations must be reviewed with your physician before implementation.';
  doc.font('Helvetica').fontSize(8.5);
  const th = doc.heightOfString(disc, { width: CW - 28 });
  const h = th + 24;
  box(doc, M, ctx.y, CW, h, C.DISC_BG, C.BORDER, 0.5);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.MUTED).text('Medical Disclaimer: ', M + 14, ctx.y + 12, { width: CW - 28, continued: true })
    .font('Helvetica-Oblique').fillColor(C.MUTED).text(disc, { lineGap: 2 });
  ctx.y += h;
}

module.exports = { buildComparisonReportPdf };
