const fs = require('fs');
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

const C = {
  bg: '#0A0A0D',
  pageBg: '#F6F7FB',
  panel: '#FFFFFF',
  panelSoft: '#EDEFF5',
  gold: '#D4AF37',
  goldSoft: '#9F7E22',
  text: '#1A1F2E',
  muted: '#5F667A',
  blue: '#2F6FE4',
  violet: '#7C56D8',
  emerald: '#1E9E78',
  danger: '#C75C4A'
};

function asList(value, max = 6) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, max);
  const raw = String(value || '').trim();
  if (!raw) return [];
  const lines = raw.split('\n').map((v) => v.trim()).filter(Boolean);
  return lines.slice(0, max);
}

function drawCover(doc, meta) {
  const { title, subtitle, logoPath } = meta;
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.bg);
  doc.roundedRect(24, 24, doc.page.width - 48, doc.page.height - 48, 20).lineWidth(2).strokeColor(C.goldSoft).stroke();
  doc.roundedRect(44, 44, doc.page.width - 88, doc.page.height - 88, 16).lineWidth(0.8).strokeColor('#53411A').stroke();

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 44, 50, { fit: [64, 64] });
    } catch (e) { /* ignore logo load errors */ }
  }

  doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(12).text('BODYBANK | PRIVATE CLIENT DOSSIER', 122, 58);
  doc.fillColor(C.text).font('Helvetica-Bold').fontSize(34).text(title, 44, 155, { width: 510, lineGap: 4 });
  doc.fillColor(C.muted).font('Helvetica').fontSize(14).text(subtitle, 44, 260, { width: 510, lineGap: 5 });

  doc.roundedRect(44, 320, doc.page.width - 88, 230, 14).fillAndStroke(C.panel, '#262324');
  doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(11).text('EXECUTIVE STATEMENT', 62, 340);
  doc.fillColor(C.text).font('Helvetica').fontSize(14).text(
    'This monthly report is designed as a high-clarity performance dossier for premium clients. It consolidates compliance, biometrics, behavior, and coaching strategy into one actionable decision document.',
    62, 370, { width: 470, lineGap: 7 }
  );
  doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(11).text('CONFIDENTIAL | COACHING TEAM USE ONLY', 62, 522);
  doc.fillColor('#8E8572').font('Helvetica').fontSize(10).text('bodybank.fit', 44, doc.page.height - 52);
}

function drawPageHeader(doc, subtitle, logoPath) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
  doc.rect(0, 0, doc.page.width, 86).fill(C.bg);
  doc.lineWidth(1).strokeColor('#3B3424').moveTo(0, 86).lineTo(doc.page.width, 86).stroke();
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 34, 18, { fit: [46, 46] });
    } catch (e) { /* ignore */ }
  }
  doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(11).text('BODYBANK MONTHLY PROGRESS REPORT', 92, 22);
  doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(subtitle, 92, 42, { width: 460 });
}

function sectionTitle(doc, text, y) {
  doc.roundedRect(36, y, 522, 26, 8).fillAndStroke(C.panelSoft, '#D3D8E5');
  doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(10).text(text.toUpperCase(), 48, y + 8);
}

function drawKpiCard(doc, x, y, w, h, label, value, sub) {
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#D6DCEA');
  doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), x + 12, y + 10, { width: w - 24 });
  doc.fillColor(C.text).font('Helvetica-Bold').fontSize(20).text(String(value), x + 12, y + 30, { width: w - 24 });
  if (sub) doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(sub, x + 12, y + 57, { width: w - 24 });
}

function drawLineChart(doc, cfg) {
  const { x, y, w, h, title, values, lineColor, labels } = cfg;
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#D6DCEA');
  doc.fillColor(C.text).font('Helvetica-Bold').fontSize(10).text(title, x + 12, y + 10);
  const pad = 26;
  const cx = x + pad;
  const cy = y + pad;
  const cw = w - pad * 1.4;
  const ch = h - pad * 1.8;
  doc.strokeColor('#E4E8F2').lineWidth(1);
  for (let i = 0; i <= 4; i += 1) {
    const gy = cy + (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).stroke();
  }
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) {
    doc.fillColor('#7A8196').font('Helvetica').fontSize(9).text('No data for selected month', cx + 4, cy + ch / 2 - 5);
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
  doc.fillColor(lineColor || C.gold);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const px = cx + (values.length === 1 ? 0 : (cw * i) / (values.length - 1));
    const py = cy + ch - ((v - min) / spread) * ch;
    doc.circle(px, py, 2.6).fill();
  }
  const labelFirst = labels && labels.length ? labels[0] : '';
  const labelLast = labels && labels.length ? labels[labels.length - 1] : '';
  doc.fillColor('#707891').font('Helvetica').fontSize(8)
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

function addBulletList(doc, items, x, y, width, color = C.text) {
  let curY = y;
  const list = asList(items, 8);
  if (!list.length) {
    doc.fillColor('#7A8196').font('Helvetica').fontSize(10).text('No data available.', x, curY, { width });
    return curY + 18;
  }
  list.forEach((item) => {
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(10).text('•', x, curY);
    doc.fillColor(color).font('Helvetica').fontSize(10).text(item, x + 12, curY, { width: width - 12, lineGap: 2 });
    curY = doc.y + 5;
  });
  return curY;
}

function generateMonthlyClientReport(opts) {
  return new Promise((resolve, reject) => {
    const { outputPath, monthKey, user, data, insights, logoPath } = opts;
    const reportSummary = summarize(data);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const subtitle = `${monthLabel(monthKey)} | Client: ${user.name || user.email || user.id}`;
    drawPageHeader(doc, subtitle, logoPath);

    const startY = 110;
    const cardW = 122;
    const cardH = 66;
    const gap = 10;
    sectionTitle(doc, 'Performance scorecard', 92);
    drawKpiCard(doc, 36, startY, cardW, cardH, 'Daily check-ins', reportSummary.dailyCount, 'Submissions this month');
    drawKpiCard(doc, 36 + (cardW + gap), startY, cardW, cardH, 'Workouts', reportSummary.workoutCount, 'Logged sessions');
    drawKpiCard(doc, 36 + (cardW + gap) * 2, startY, cardW, cardH, 'Avg steps', reportSummary.avgSteps ? Math.round(reportSummary.avgSteps).toLocaleString('en-IN') : '-', 'Per day');
    drawKpiCard(doc, 36 + (cardW + gap) * 3, startY, cardW, cardH, 'Avg sleep', reportSummary.avgSleep ? reportSummary.avgSleep.toFixed(1) + ' h' : '-', 'Per day');

    const labels = (data.progressLogs || []).map((r) => formatDate(r.created_at).slice(0, 6));
    const weightSeries = (data.progressLogs || []).map((r) => (r.weight != null ? num(r.weight) : null));
    const bfSeries = (data.progressLogs || []).map((r) => (r.body_fat != null ? num(r.body_fat) : null));
    const stepsSeries = (data.dailyCheckins || []).map((r) => (r.steps != null ? num(r.steps) : null));

    drawLineChart(doc, {
      x: 36, y: 186, w: 168, h: 156, title: 'Weight (kg)', values: weightSeries, lineColor: C.gold, labels
    });
    drawLineChart(doc, {
      x: 213, y: 186, w: 168, h: 156, title: 'Body Fat (%)', values: bfSeries, lineColor: C.violet, labels
    });
    drawLineChart(doc, {
      x: 390, y: 186, w: 168, h: 156, title: 'Steps Trend', values: stepsSeries, lineColor: C.emerald,
      labels: (data.dailyCheckins || []).map((r) => formatDate(r.checkin_date).slice(0, 6))
    });

    sectionTitle(doc, 'Executive narrative & detailed intelligence', 352);
    doc.fillColor(C.text).font('Helvetica').fontSize(9.4);
    const summaryText = [
      `Client: ${user.name || '-'} (${user.email || '-'})`,
      `Latest weight: ${reportSummary.latestWeight != null ? reportSummary.latestWeight.toFixed(1) + ' kg' : '-'}`,
      `Weight change: ${reportSummary.weightDelta != null ? (reportSummary.weightDelta >= 0 ? '+' : '') + reportSummary.weightDelta.toFixed(1) + ' kg' : '-'}`,
      `Latest body fat: ${reportSummary.latestBodyFat != null ? reportSummary.latestBodyFat.toFixed(1) + '%' : '-'}`,
      `Avg protein (daily): ${reportSummary.avgProtein != null ? reportSummary.avgProtein.toFixed(0) + ' g' : '-'}`,
      `Sunday check-ins submitted: ${reportSummary.sundayCount}`
    ].join('\n');
    doc.roundedRect(36, 384, 255, 90, 10).fillAndStroke(C.panel, '#D6DCEA');
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(9.5).text('Executive Summary', 48, 398);
    doc.fillColor(C.text).font('Helvetica').fontSize(9.2).text(summaryText, 48, 414, { width: 232, lineGap: 3 });

    const sundayRows = (data.sundayCheckins || []).map((r) =>
      `${formatDate(r.created_at)}: ${String(r.achievements || '').slice(0, 72)}${String(r.achievements || '').length > 72 ? '...' : ''}`
    );
    const workoutRows = (data.workouts || []).slice(-10).map((r) =>
      `${formatDate(r.created_at)} | ${String(r.workout_name || 'Workout')} | ${num(r.duration_seconds, 0)} sec`
    );

    doc.roundedRect(36, 482, 255, 274, 10).fillAndStroke(C.panel, '#D6DCEA');
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(9.5).text('Behavior & Adherence', 48, 496);
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(8.5).text('Sunday Highlights', 48, 514);
    let y1 = addBulletList(doc, sundayRows, 48, 528, 232, C.text) + 4;
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(8.5).text('Workout Snapshot', 48, y1);
    y1 = addBulletList(doc, workoutRows, 48, y1 + 14, 232, C.text) + 4;
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(8.5).text('Strategic Interpretation', 48, y1);
    doc.fillColor(C.text).font('Helvetica').fontSize(10).text(
      'Preserve compliance momentum while increasing protocol precision across training intensity, nutrition timing, and recovery quality.',
      48, y1 + 14, { width: 232, lineGap: 3 }
    );

    const insightLines = insights && typeof insights === 'object'
      ? JSON.stringify(insights, null, 2)
        .replace(/[{}"]/g, '')
        .replace(/,\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      : [];
    const topInsights = insightLines.slice(0, 10);
    const riskHints = insightLines.filter((l) => /risk|drop|plateau|sleep|stress/i.test(l)).slice(0, 6);
    const actionHints = insightLines.filter((l) => /action|plan|adjust|target|coach|next/i.test(l)).slice(0, 7);

    doc.roundedRect(303, 384, 255, 372, 10).fillAndStroke(C.panel, '#D6DCEA');
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(9.5).text('Coach Insights, Risks & Action Protocol', 315, 398, { width: 232 });
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(8.5).text('Top Insights', 315, 420);
    let pY = addBulletList(doc, topInsights, 315, 434, 232, C.text) + 4;
    doc.fillColor(C.danger).font('Helvetica-Bold').fontSize(8.5).text('Risk Flags', 315, pY);
    pY = addBulletList(doc, riskHints, 315, pY + 14, 232, '#9A3E31') + 4;
    doc.fillColor(C.emerald).font('Helvetica-Bold').fontSize(8.5).text('Action Protocol (Next 30 days)', 315, pY);
    addBulletList(doc, actionHints, 315, pY + 14, 232, '#146E59');

    doc.fillColor('#7F7764').font('Helvetica').fontSize(8.5)
      .text('CONFIDENTIAL PERFORMANCE DOSSIER | bodybank.fit', 36, doc.page.height - 22, { width: 522, align: 'center' });

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { generateMonthlyClientReport, monthLabel };
