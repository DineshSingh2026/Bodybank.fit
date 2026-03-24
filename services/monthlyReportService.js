const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function monthLabel(monthKey) {
  const [y, m] = String(monthKey || '').split('-');
  const d = new Date(Number(y), Math.max(0, Number(m) - 1), 1);
  if (Number.isNaN(d.getTime())) return monthKey || '';
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function drawHeader(doc, title, subtitle, logoPath) {
  doc.rect(0, 0, doc.page.width, 90).fill('#0C2238');
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 40, 18, { fit: [50, 50] });
    } catch (e) { /* ignore logo load errors */ }
  }
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text(title, 105, 24);
  doc.font('Helvetica').fontSize(11).fillColor('#D7E7FA').text(subtitle, 105, 52);
  doc.moveDown();
  doc.fillColor('#111111');
}

function drawKpiCard(doc, x, y, w, h, label, value, sub) {
  doc.roundedRect(x, y, w, h, 8).fillAndStroke('#F6FAFF', '#D9E7F5');
  doc.fillColor('#4F6B8A').font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), x + 10, y + 10, { width: w - 20 });
  doc.fillColor('#0C2238').font('Helvetica-Bold').fontSize(18).text(String(value), x + 10, y + 26, { width: w - 20 });
  if (sub) {
    doc.fillColor('#506680').font('Helvetica').fontSize(9).text(sub, x + 10, y + 50, { width: w - 20 });
  }
}

function drawLineChart(doc, cfg) {
  const { x, y, w, h, title, values, lineColor, labels } = cfg;
  doc.roundedRect(x, y, w, h, 8).fillAndStroke('#FFFFFF', '#D9E7F5');
  doc.fillColor('#0C2238').font('Helvetica-Bold').fontSize(10).text(title, x + 10, y + 8);
  const pad = 26;
  const cx = x + pad;
  const cy = y + pad;
  const cw = w - pad * 1.4;
  const ch = h - pad * 1.8;
  doc.strokeColor('#E5EEF8').lineWidth(1);
  for (let i = 0; i <= 4; i += 1) {
    const gy = cy + (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).stroke();
  }
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) {
    doc.fillColor('#7A8EA8').font('Helvetica').fontSize(9).text('No data for selected month', cx + 4, cy + ch / 2 - 5);
    return;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const spread = max - min || 1;
  doc.strokeColor(lineColor || '#2E86DE').lineWidth(2);
  let started = false;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const px = cx + (values.length === 1 ? 0 : (cw * i) / (values.length - 1));
    const py = cy + ch - ((v - min) / spread) * ch;
    if (!started) {
      doc.moveTo(px, py);
      started = true;
    } else {
      doc.lineTo(px, py);
    }
  }
  if (started) doc.stroke();
  doc.fillColor('#2E86DE');
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const px = cx + (values.length === 1 ? 0 : (cw * i) / (values.length - 1));
    const py = cy + ch - ((v - min) / spread) * ch;
    doc.circle(px, py, 2.6).fill();
  }
  const labelFirst = labels && labels.length ? labels[0] : '';
  const labelLast = labels && labels.length ? labels[labels.length - 1] : '';
  doc.fillColor('#6A7F98').font('Helvetica').fontSize(8)
    .text(labelFirst, cx, cy + ch + 4, { width: 70 })
    .text(labelLast, cx + cw - 50, cy + ch + 4, { width: 50, align: 'right' });
}

function summarize(data) {
  const daily = data.dailyCheckins || [];
  const progress = data.progressLogs || [];
  const workouts = data.workouts || [];
  const sunday = data.sundayCheckins || [];

  const weights = progress.map((r) => (r.weight != null ? num(r.weight) : null)).filter((v) => Number.isFinite(v));
  const bf = progress.map((r) => (r.body_fat != null ? num(r.body_fat) : null)).filter((v) => Number.isFinite(v));
  const steps = daily.map((r) => (r.steps != null ? num(r.steps) : null)).filter((v) => Number.isFinite(v));
  const protein = daily.map((r) => (r.protein_g != null ? num(r.protein_g) : null)).filter((v) => Number.isFinite(v));
  const sleep = daily.map((r) => (r.sleep_hours != null ? num(r.sleep_hours) : null)).filter((v) => Number.isFinite(v));

  const firstWeight = weights.length ? weights[0] : null;
  const lastWeight = weights.length ? weights[weights.length - 1] : null;
  const weightDelta = firstWeight != null && lastWeight != null ? (lastWeight - firstWeight) : null;

  return {
    dailyCount: daily.length,
    progressCount: progress.length,
    sundayCount: sunday.length,
    workoutCount: workouts.length,
    avgSteps: avg(steps),
    avgProtein: avg(protein),
    avgSleep: avg(sleep),
    latestWeight: lastWeight,
    latestBodyFat: bf.length ? bf[bf.length - 1] : null,
    weightDelta
  };
}

function generateMonthlyClientReport(opts) {
  return new Promise((resolve, reject) => {
    const { outputPath, monthKey, user, data, insights, logoPath } = opts;
    const reportSummary = summarize(data);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    drawHeader(
      doc,
      'BodyBank Monthly Progress Report',
      `${monthLabel(monthKey)} | Client: ${user.name || user.email || user.id}`,
      logoPath
    );

    const startY = 108;
    const cardW = 122;
    const cardH = 72;
    const gap = 10;
    drawKpiCard(doc, 36, startY, cardW, cardH, 'Daily check-ins', reportSummary.dailyCount, 'Submissions this month');
    drawKpiCard(doc, 36 + (cardW + gap), startY, cardW, cardH, 'Workouts', reportSummary.workoutCount, 'Logged sessions');
    drawKpiCard(doc, 36 + (cardW + gap) * 2, startY, cardW, cardH, 'Avg steps', reportSummary.avgSteps ? Math.round(reportSummary.avgSteps).toLocaleString('en-IN') : '-', 'Per day');
    drawKpiCard(doc, 36 + (cardW + gap) * 3, startY, cardW, cardH, 'Avg sleep', reportSummary.avgSleep ? reportSummary.avgSleep.toFixed(1) + ' h' : '-', 'Per day');

    const labels = (data.progressLogs || []).map((r) => formatDate(r.created_at).slice(0, 6));
    const weightSeries = (data.progressLogs || []).map((r) => (r.weight != null ? num(r.weight) : null));
    const bfSeries = (data.progressLogs || []).map((r) => (r.body_fat != null ? num(r.body_fat) : null));
    const stepsSeries = (data.dailyCheckins || []).map((r) => (r.steps != null ? num(r.steps) : null));

    drawLineChart(doc, {
      x: 36, y: 198, w: 255, h: 170, title: 'Weight Trend (kg)', values: weightSeries, lineColor: '#2066D1', labels
    });
    drawLineChart(doc, {
      x: 303, y: 198, w: 255, h: 170, title: 'Body Fat Trend (%)', values: bfSeries, lineColor: '#8E44AD', labels
    });
    drawLineChart(doc, {
      x: 36, y: 378, w: 522, h: 165, title: 'Daily Steps Trend', values: stepsSeries, lineColor: '#17A589',
      labels: (data.dailyCheckins || []).map((r) => formatDate(r.checkin_date).slice(0, 6))
    });

    let textY = 553;
    doc.fillColor('#0C2238').font('Helvetica-Bold').fontSize(12).text('Monthly Narrative Summary', 36, textY);
    textY += 16;
    doc.fillColor('#2C3E50').font('Helvetica').fontSize(10);
    const summaryText = [
      `Client: ${user.name || '-'} (${user.email || '-'})`,
      `Latest weight: ${reportSummary.latestWeight != null ? reportSummary.latestWeight.toFixed(1) + ' kg' : '-'}`,
      `Weight change: ${reportSummary.weightDelta != null ? (reportSummary.weightDelta >= 0 ? '+' : '') + reportSummary.weightDelta.toFixed(1) + ' kg' : '-'}`,
      `Latest body fat: ${reportSummary.latestBodyFat != null ? reportSummary.latestBodyFat.toFixed(1) + '%' : '-'}`,
      `Avg protein (daily): ${reportSummary.avgProtein != null ? reportSummary.avgProtein.toFixed(0) + ' g' : '-'}`,
      `Sunday check-ins submitted: ${reportSummary.sundayCount}`
    ].join('\n');
    doc.text(summaryText, 36, textY, { width: 522, lineGap: 4 });

    if (insights && typeof insights === 'object') {
      doc.addPage();
      drawHeader(doc, 'Coach Insights & Recommendations', `${monthLabel(monthKey)} | ${user.name || user.email || user.id}`, logoPath);
      doc.fillColor('#0C2238').font('Helvetica-Bold').fontSize(12).text('Generated Insight Notes', 36, 108);
      doc.fillColor('#2C3E50').font('Helvetica').fontSize(10);
      const insightText = JSON.stringify(insights, null, 2)
        .replace(/[{}"]/g, '')
        .replace(/,\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 120)
        .join('\n');
      doc.text(insightText || 'No additional insights available for this month.', 36, 128, { width: 522, lineGap: 3 });
    }

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { generateMonthlyClientReport, monthLabel };
