'use strict';

// Weekly Performance Report — branded one-page PDF built from buildWeeklyReport() data.
// Uses pdfkit built-in fonts (no font files) and hand-drawn bars, so it has no extra deps.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const PL = require('./pdfLayout');

const C = {
  bg: '#0d0d0d', panel: '#181818', line: '#2a2a2a',
  gold: '#c8a44e', cream: '#f2ece0', muted: '#9b8f78', sub: '#7c715c',
  steps: '#f6a740', water: '#4aa8e0', protein: '#5fc88a', sleep: '#9b8cf0',
  green: '#3dd68c', red: '#ff6868'
};
const METRICS = [
  { key: 'steps', label: 'STEPS', color: C.steps },
  { key: 'water', label: 'WATER', color: C.water },
  { key: 'protein', label: 'PROTEIN', color: C.protein },
  { key: 'sleep', label: 'SLEEP', color: C.sleep }
];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function md(ymd) {
  const p = String(ymd || '').split('-');
  if (p.length < 3) return '';
  return MON[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10);
}
function fmt(key, v) {
  v = Number(v) || 0;
  if (key === 'steps') return Math.round(v).toLocaleString('en-US');
  if (key === 'water') return (Math.round(v / 100) / 10).toFixed(1) + 'L';
  if (key === 'protein') return Math.round(v) + 'g';
  if (key === 'sleep') return (Math.round(v * 10) / 10).toFixed(1) + 'h';
  return String(Math.round(v));
}

function drawWeekBars(doc, x, y, w, h, mc, m) {
  const days = m.days || [];
  const goal = Number(m.dailyGoal) || 0;
  const vals = days.map((d) => Number(d.value) || 0);
  const max = Math.max(goal, Math.max.apply(null, vals.concat([1]))) * 1.15;
  const n = 7, gap = 6;
  const bw = (w - gap * (n - 1)) / n;
  if (goal > 0 && max > 0) {
    const gly = y + h - (goal / max) * h;
    doc.save();
    doc.dash(3, { space: 3 }).moveTo(x, gly).lineTo(x + w, gly).lineWidth(0.8).strokeColor('#555').stroke();
    doc.undash();
    doc.restore();
  }
  days.forEach((d, i) => {
    const v = Number(d.value) || 0;
    const bh = max > 0 ? (v / max) * h : 0;
    const bx = x + i * (bw + gap);
    const by = y + h - bh;
    doc.roundedRect(bx, by, bw, Math.max(bh, v > 0 ? 2 : 0.4), 2).fill(mc.color);
    PL.drawFit(doc, String(d.label || '').slice(0, 1), bx, y + h + 3, bw, { font: 'Helvetica', size: 6.5, color: C.sub, align: 'center' });
  });
}

/**
 * One metric card. Every figure on it comes from a member's week and can be an
 * order of magnitude larger than the design assumed (a step count in the
 * millions, a -99999% swing), so each is fitted to its own slot: nothing here
 * may cross a column divider or leave the rounded panel.
 */
function drawMetricCard(doc, x, y, w, h, mc, m) {
  m = m || {};
  doc.roundedRect(x, y, w, h, 12).fill(C.panel);
  const pad = 16, ix = x + pad, iy = y + pad;
  const innerW = w - pad * 2;

  doc.circle(ix + 5, iy + 6, 5).fill(mc.color);
  const ok = (m.achievementPct || 0) >= 90;
  PL.drawFit(doc, mc.label, ix + 16, iy, innerW - 16 - 74, { font: 'Helvetica-Bold', size: 11, color: mc.color });
  PL.drawFit(doc, ok ? 'ON TRACK' : 'BEHIND', x + w - pad - 70, iy, 70, { font: 'Helvetica-Bold', size: 9, color: ok ? C.green : C.red, align: 'right' });

  const vy = iy + 22;
  const pct = Math.max(0, Math.min(100, Math.round(m.achievementPct || 0)));
  // The percentage on the right is placed first; the value/target pair gets the
  // width that is left of it.
  PL.drawFit(doc, pct + '%', x + w - pad - 50, vy + 4, 50, { font: 'Helvetica-Bold', size: 13, color: mc.color, align: 'right' });
  const valRoom = innerW - 58;
  const valStr = fmt(mc.key, m.actual);
  const targetStr = ' / ' + fmt(mc.key, m.target);
  doc.font('Helvetica-Bold').fontSize(20);
  const valFit = PL.fitText(doc, valStr, valRoom * 0.62, { font: 'Helvetica-Bold', size: 20, minSize: 10 });
  doc.font('Helvetica-Bold').fontSize(valFit.size);
  PL.drawSingle(doc, valFit.text, ix, vy, 0, {});
  const vw = doc.widthOfString(valFit.text);
  PL.drawFit(doc, targetStr, ix + vw, vy + 7, Math.max(0, valRoom - vw), { font: 'Helvetica', size: 12, minSize: 7, color: C.muted });

  const by = vy + 32, bw = innerW, bh = 6;
  doc.roundedRect(ix, by, bw, bh, 3).fill('#262626');
  if (pct > 0) doc.roundedRect(ix, by, Math.max(bh, (bw * pct) / 100), bh, 3).fill(mc.color);

  const chy = by + 18, chh = 68;
  drawWeekBars(doc, ix, chy, bw, chh, mc, m);

  // Three stats share the card's width; each is fitted to its own third.
  const sy = chy + chh + 14;
  const third = bw / 3;
  const stat = (sx, label, value, color) => {
    PL.drawFit(doc, label, sx, sy, third - 6, { font: 'Helvetica', size: 8, color: C.sub });
    PL.drawFit(doc, value, sx, sy + 10, third - 6, { font: 'Helvetica-Bold', size: 11, minSize: 6.5, color });
  };
  const dv = m.vsPrevPct;
  stat(ix, 'DAILY AVG', fmt(mc.key, m.dailyAvg), C.cream);
  stat(ix + third, mc.key === 'sleep' ? 'BEST NIGHT' : 'BEST DAY', fmt(mc.key, m.bestDay && m.bestDay.value), C.cream);
  stat(ix + third * 2, 'VS LAST WK', dv == null ? '—' : ((dv >= 0 ? '+' : '') + dv + '%'),
    dv == null ? C.sub : (dv >= 0 ? C.green : C.red));
}

function generateWeeklyReportPdf({ outputPath, report, logoPath }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);
      const W = doc.page.width, H = doc.page.height, M = 40, contentW = W - M * 2;

      doc.rect(0, 0, W, H).fill(C.bg);

      // header
      let y = 40;
      if (logoPath && fs.existsSync(logoPath)) {
        try { doc.image(logoPath, M, y, { height: 30 }); } catch (_) {}
      }
      PL.drawFit(doc, 'Weekly Performance Report', M, y + 42, contentW, { font: 'Helvetica-Bold', size: 20, color: C.cream });
      const name = ((report.user.first_name || '') + ' ' + (report.user.last_name || '')).trim() || report.user.email || 'Member';
      // Without a width this ran off the right edge of the page for any long
      // name; it is now fitted to the content column.
      PL.drawFit(doc, name + '    •    Week of ' + md(report.weekStart) + ' – ' + md(report.weekEnd), M, y + 70, contentW,
        { font: 'Helvetica', size: 11, minSize: 7, color: C.muted });
      y += 96;
      doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(C.line).stroke();
      y += 22;

      // summary strip
      const score = Math.max(0, Math.min(100, report.overallScore || 0));
      const scoreColor = score >= 80 ? C.green : score >= 60 ? C.gold : C.red;
      PL.drawFit(doc, score + '%', M, y, 190, { font: 'Helvetica-Bold', size: 40, minSize: 18, color: scoreColor });
      PL.drawFit(doc, 'OVERALL WEEK SCORE', M, y + 50, 190, { font: 'Helvetica', size: 9, color: C.muted });
      // The three KPIs divide whatever is left of the content column beside the
      // score. Hard-coded 120pt steps put the third one 35pt past the right
      // margin, which is where "-99999%" went off the page.
      const rx = M + 200;
      const kpiW = (W - M - rx) / 3;
      const kpi = (slot, big, bigColor, lbl) => {
        const lx = rx + slot * kpiW;
        PL.drawFit(doc, big, lx, y + 6, kpiW - 6, { font: 'Helvetica-Bold', size: 22, minSize: 8, color: bigColor });
        PL.drawFit(doc, lbl, lx, y + 34, kpiW - 6, { font: 'Helvetica', size: 9, minSize: 6.5, color: C.muted });
      };
      kpi(0, report.goalsHit + ' / ' + report.goalsTotal, C.cream, 'GOALS HIT');
      kpi(1, String(report.streak || 0), C.gold, 'DAY STREAK');
      const tpv = report.totalProgress && report.totalProgress.vsPrevPct;
      kpi(2, (tpv != null ? ((tpv >= 0 ? '+' : '') + tpv + '%') : '—'), (tpv != null && tpv >= 0) ? C.green : C.red, 'VS LAST WEEK');
      y += 82;

      // 2x2 metric cards
      const gap = 16;
      const cw = (contentW - gap) / 2;
      const ch = 198;
      METRICS.forEach((mc, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        drawMetricCard(doc, M + col * (cw + gap), y + row * (ch + gap), cw, ch, mc, report.metrics[mc.key]);
      });
      y += ch * 2 + gap + 22;

      // footer note — capped to the strip between the cards and the brand line,
      // so a long "most consistent" list cannot push text off the page.
      const mcd = (report.highlights && report.highlights.mostConsistentDays) || [];
      PL.drawText(doc, 'Most consistent on ' + (mcd.length ? mcd.join(' & ') : '—') + '.   Keep building — you’re getting stronger.',
        M, y, { font: 'Helvetica', size: 10, width: contentW, color: C.muted, maxHeight: Math.max(12, (H - 46) - y) });
      PL.drawFit(doc, 'Generated by BodyBank × FitChef  •  bodybank.fit', M, H - 36, contentW,
        { font: 'Helvetica', size: 8, color: C.sub, align: 'center' });

      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

module.exports = { generateWeeklyReportPdf };
