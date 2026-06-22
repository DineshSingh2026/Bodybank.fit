'use strict';

// Weekly Performance Report — branded one-page PDF built from buildWeeklyReport() data.
// Uses pdfkit built-in fonts (no font files) and hand-drawn bars, so it has no extra deps.

const PDFDocument = require('pdfkit');
const fs = require('fs');

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
    doc.font('Helvetica').fontSize(6.5).fillColor(C.sub).text(String(d.label || '').slice(0, 1), bx, y + h + 3, { width: bw, align: 'center' });
  });
}

function drawMetricCard(doc, x, y, w, h, mc, m) {
  m = m || {};
  doc.roundedRect(x, y, w, h, 12).fill(C.panel);
  const pad = 16, ix = x + pad, iy = y + pad;

  doc.circle(ix + 5, iy + 6, 5).fill(mc.color);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(mc.color).text(mc.label, ix + 16, iy);
  const ok = (m.achievementPct || 0) >= 90;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ok ? C.green : C.red).text(ok ? 'ON TRACK' : 'BEHIND', x + w - pad - 70, iy, { width: 70, align: 'right' });

  const vy = iy + 22;
  const valStr = fmt(mc.key, m.actual);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.cream).text(valStr, ix, vy);
  const vw = doc.widthOfString(valStr);
  doc.font('Helvetica').fontSize(12).fillColor(C.muted).text(' / ' + fmt(mc.key, m.target), ix + vw, vy + 7);
  const pct = Math.max(0, Math.min(100, Math.round(m.achievementPct || 0)));
  doc.font('Helvetica-Bold').fontSize(13).fillColor(mc.color).text(pct + '%', x + w - pad - 50, vy + 4, { width: 50, align: 'right' });

  const by = vy + 32, bw = w - pad * 2, bh = 6;
  doc.roundedRect(ix, by, bw, bh, 3).fill('#262626');
  if (pct > 0) doc.roundedRect(ix, by, Math.max(bh, (bw * pct) / 100), bh, 3).fill(mc.color);

  const chy = by + 18, chh = 68;
  drawWeekBars(doc, ix, chy, bw, chh, mc, m);

  const sy = chy + chh + 14;
  doc.font('Helvetica').fontSize(8).fillColor(C.sub).text('DAILY AVG', ix, sy);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.cream).text(fmt(mc.key, m.dailyAvg), ix, sy + 10);
  const bx = ix + bw / 3;
  doc.font('Helvetica').fontSize(8).fillColor(C.sub).text(mc.key === 'sleep' ? 'BEST NIGHT' : 'BEST DAY', bx, sy);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.cream).text(fmt(mc.key, m.bestDay && m.bestDay.value), bx, sy + 10);
  const dx = ix + (bw * 2) / 3;
  const dv = m.vsPrevPct;
  doc.font('Helvetica').fontSize(8).fillColor(C.sub).text('VS LAST WK', dx, sy);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(dv == null ? C.sub : (dv >= 0 ? C.green : C.red)).text(dv == null ? '—' : ((dv >= 0 ? '+' : '') + dv + '%'), dx, sy + 10);
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
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.cream).text('Weekly Performance Report', M, y + 42);
      const name = ((report.user.first_name || '') + ' ' + (report.user.last_name || '')).trim() || report.user.email || 'Member';
      doc.font('Helvetica').fontSize(11).fillColor(C.muted).text(name + '    •    Week of ' + md(report.weekStart) + ' – ' + md(report.weekEnd), M, y + 70);
      y += 96;
      doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(C.line).stroke();
      y += 22;

      // summary strip
      const score = Math.max(0, Math.min(100, report.overallScore || 0));
      const scoreColor = score >= 80 ? C.green : score >= 60 ? C.gold : C.red;
      doc.font('Helvetica-Bold').fontSize(40).fillColor(scoreColor).text(score + '%', M, y);
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('OVERALL WEEK SCORE', M, y + 50);
      const rx = M + 200;
      const kpi = (lx, big, bigColor, lbl) => {
        doc.font('Helvetica-Bold').fontSize(22).fillColor(bigColor).text(big, lx, y + 6, { width: 110 });
        doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(lbl, lx, y + 34, { width: 110 });
      };
      kpi(rx, report.goalsHit + ' / ' + report.goalsTotal, C.cream, 'GOALS HIT');
      kpi(rx + 120, String(report.streak || 0), C.gold, 'DAY STREAK');
      const tpv = report.totalProgress && report.totalProgress.vsPrevPct;
      kpi(rx + 240, (tpv != null ? ((tpv >= 0 ? '+' : '') + tpv + '%') : '—'), (tpv != null && tpv >= 0) ? C.green : C.red, 'VS LAST WEEK');
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

      // footer note
      const mcd = (report.highlights && report.highlights.mostConsistentDays) || [];
      doc.font('Helvetica').fontSize(10).fillColor(C.muted)
        .text('Most consistent on ' + (mcd.length ? mcd.join(' & ') : '—') + '.   Keep building — you’re getting stronger.', M, y, { width: contentW });
      doc.font('Helvetica').fontSize(8).fillColor(C.sub)
        .text('Generated by BodyBank × FitChef  •  bodybank.fit', M, H - 36, { width: contentW, align: 'center' });

      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

module.exports = { generateWeeklyReportPdf };
