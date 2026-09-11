const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { renderLuxuryDetailSections } = require('./monthlyReportPdfDetail');
const PL = require('./pdfLayout');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

/** Register on each PDFDocument instance (PDFKit requires per-doc registration). */
function registerReportFonts(doc) {
  const regular = path.join(FONT_DIR, 'Inter-Regular.ttf');
  const semi = path.join(FONT_DIR, 'Inter-SemiBold.ttf');
  const display = path.join(FONT_DIR, 'InterDisplay-Bold.ttf');
  try {
    if (!fs.existsSync(regular)) return false;
    doc.registerFont('BBBody', regular);
    if (fs.existsSync(semi)) doc.registerFont('BBSemi', semi);
    else doc.registerFont('BBSemi', regular);
    if (fs.existsSync(display)) doc.registerFont('BBDisplay', display);
    else doc.registerFont('BBDisplay', semi);
    return true;
  } catch (e) {
    return false;
  }
}

function F(doc, role) {
  const custom = doc._bbCustomFonts === true;
  if (!custom) {
    if (role === 'display' || role === 'semi') return 'Helvetica-Bold';
    return 'Helvetica';
  }
  if (role === 'display') return 'BBDisplay';
  if (role === 'semi') return 'BBSemi';
  return 'BBBody';
}

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

function daysInMonthKey(monthKey) {
  const [y, m] = String(monthKey || '').split('-').map((n) => parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return 31;
  return new Date(y, m, 0).getDate();
}

const C = {
  bg: '#07070A',
  pageBg: '#E8ECF4',
  panel: '#FFFFFF',
  panelSoft: '#E2E6EF',
  gold: '#D4AF37',
  goldMid: '#B8922E',
  goldDark: '#7A6220',
  text: '#0E1118',
  muted: '#5A6278',
  violet: '#6B4FC9',
  emerald: '#0D7A5F',
  danger: '#B03A32',
  grid: '#D0D6E4',
  heroAccent: '#1A1510'
};

/** Distinct saturated colors for multi-series / bar charts (WCAG-friendly on light panels). */
const VIBRANT = {
  coral: '#F43F5E',
  teal: '#14B8A6',
  amber: '#F59E0B',
  violet: '#8B5CF6',
  sky: '#0EA5E9',
  lime: '#84CC16',
  rose: '#EC4899',
  indigo: '#6366F1',
  orange: '#F97316',
  cyan: '#06B6D4',
  chartLine: ['#E11D48', '#0891B2', '#CA8A04', '#7C3AED', '#059669', '#EA580C', '#DB2777', '#4F46E5']
};

function asList(value, max = 10) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, max);
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split('\n').map((v) => v.trim()).filter(Boolean).slice(0, max);
}

function extractCoachPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    currentWeight: raw.currentWeight,
    weightChangePercent: raw.weightChangePercent,
    strengthGrowthPercent: raw.strengthGrowthPercent,
    workoutConsistencyPercent: raw.workoutConsistencyPercent,
    activeStreak: raw.activeStreak,
    goalCompletionPercent: raw.goalCompletionPercent,
    averageCalories: raw.averageCalories,
    averageSleep: raw.averageSleep,
    insightTags: Array.isArray(raw.insights) ? raw.insights.map((s) => String(s || '').trim()).filter(Boolean) : []
  };
}

function formatCoachPerformanceLines(payload) {
  if (!payload) return ['No program-wide signals on file.'];
  const lines = [];
  const w = payload.currentWeight;
  lines.push(`Latest weight on record: ${w != null && Number.isFinite(Number(w)) ? `${Number(w).toFixed(1)} kg` : '—'}`);
  lines.push(`Rolling weight change: ${payload.weightChangePercent != null && payload.weightChangePercent !== '' ? `${payload.weightChangePercent}%` : '—'}`);
  lines.push(`Strength trend vs baseline: ${payload.strengthGrowthPercent != null && payload.strengthGrowthPercent !== '' ? `${payload.strengthGrowthPercent}%` : '—'}`);
  lines.push(`Workout completion (progress logs): ${payload.workoutConsistencyPercent != null && payload.workoutConsistencyPercent !== '' ? `${Number(payload.workoutConsistencyPercent).toFixed(0)}%` : '—'}`);
  lines.push(`Check-in streak: ${payload.activeStreak != null && payload.activeStreak !== '' ? `${payload.activeStreak} day${Number(payload.activeStreak) === 1 ? '' : 's'}` : '—'}`);
  lines.push(`Goal completion: ${payload.goalCompletionPercent != null && payload.goalCompletionPercent !== '' ? `${payload.goalCompletionPercent}%` : '—'}`);
  lines.push(`Avg. calories (when logged): ${payload.averageCalories != null && payload.averageCalories !== '' ? `${payload.averageCalories} kcal` : '—'}`);
  lines.push(`Avg. sleep (when logged): ${payload.averageSleep != null && payload.averageSleep !== '' ? `${payload.averageSleep} h` : '—'}`);
  return lines;
}

function deriveRiskLines(payload, summary) {
  const risks = [];
  const sleep = payload && payload.averageSleep != null ? Number(payload.averageSleep) : NaN;
  if (Number.isFinite(sleep) && sleep < 6.5) {
    risks.push(`Sleep is averaging ${sleep}h — prioritize recovery and stress load review.`);
  }
  const cons = payload && payload.workoutConsistencyPercent != null ? Number(payload.workoutConsistencyPercent) : NaN;
  if (Number.isFinite(cons) && cons < 45) {
    risks.push('Training consistency is soft; momentum depends on locking a non-negotiable session rhythm.');
  }
  if (summary.dailyCount === 0) risks.push('No daily check-ins this month — trend visibility and accountability are reduced.');
  if (summary.progressCount === 0 && summary.dailyCount === 0) {
    risks.push('Sparse biometric logging; decisions are being made without a full data picture.');
  }
  if (!risks.length) risks.push('No acute risk flags from available signals; maintain standards and watch sleep/load balance.');
  return risks.slice(0, 5);
}

function deriveActionLines(payload, summary, insightTags) {
  const actions = [];
  if (summary.dailyCount < 4) {
    actions.push('Target 4–6 daily check-ins per week to stabilise weight, steps, and nutrition trends.');
  }
  if (summary.workoutCount < 3) {
    actions.push('Book 2–3 progressive strength sessions weekly with explicit RPE or load targets.');
  }
  if (payload && Number(payload.averageSleep) < 7) {
    actions.push('Set a fixed wind-down and aim for 7+ hours sleep on 5+ nights this month.');
  }
  if (insightTags.includes('Consistency Needs Improvement')) {
    actions.push('Reduce friction: shorter sessions on busy weeks beat perfect weeks that never happen.');
  }
  if (insightTags.includes('Weight Plateau Detected')) {
    actions.push('Audit energy balance and step targets; adjust one variable at a time for 14 days.');
  }
  if (insightTags.includes('Strength Milestone Achieved')) {
    actions.push('Capitalise on strength gains — introduce a measured progression block on primary lifts.');
  }
  if (!actions.length) {
    actions.push('Continue current protocol; layer one new measurable habit (steps, protein, or sleep window).');
  }
  return actions.slice(0, 6);
}

function buildStrategicNarrative(summary, data) {
  const sundayN = (data.sundayCheckins || []).length;
  const parts = [];
  if (summary.dailyCount === 0 && sundayN > 0) {
    parts.push('Engagement is visible through weekly reviews, but daily telemetry is thin — the next lever is consistent daily logging so trends become undeniable.');
  } else if (summary.dailyCount === 0 && sundayN === 0) {
    parts.push('This month shows minimal structured touchpoints; re-establish a simple weekly rhythm before pushing intensity.');
  }
  if (summary.workoutCount === 0) {
    parts.push('Resistance work is under-represented in the log — anchor the client to scheduled sessions.');
  } else if (summary.workoutCount === 1) {
    parts.push('A single logged session suggests the habit is fragile; protect frequency before volume.');
  }
  if (summary.latestWeight != null && summary.weightDelta != null && Math.abs(summary.weightDelta) < 0.3 && summary.progressCount >= 3) {
    parts.push('Weight is stable — decide whether this is maintenance success or a plateau requiring a deliberate phase shift.');
  }
  if (summary.avgSleep != null && summary.avgSleep < 6.5) {
    parts.push(`Sleep is averaging ${summary.avgSleep.toFixed(1)}h in daily data — treat recovery as a performance multiplier, not an afterthought.`);
  }
  if (!parts.length) {
    parts.push('The dataset this month supports steady execution: preserve adherence, tighten one variable (nutrition timing, steps, or training density), and validate with next month\'s curves.');
  }
  return parts.join(' ');
}

function buildCoachLetter(userName, summary, prevSummary, strategic) {
  const name = userName || 'Client';
  const open = `${name}, this dossier captures how you executed against the BodyBank standard during the reporting window. `;
  let body = '';
  if (summary.dailyCount >= 12) {
    body += 'Daily telemetry is strong — that level of visibility is what separates guesswork from precision guidance. ';
  } else if (summary.dailyCount === 0) {
    body += 'We are flying with limited daily telemetry; the priority is not perfection — it is predictable touchpoints. ';
  } else {
    body += 'Your logging cadence has room to compound; small increases in consistency typically move the curves first. ';
  }
  if (summary.workoutCount >= 8) {
    body += 'Training frequency looks committed — now we refine quality, recovery, and progression. ';
  } else if (summary.workoutCount <= 2) {
    body += 'Training volume this month is not yet reflective of an elite outcome; we protect the habit before we chase the hero sessions. ';
  }
  if (prevSummary && (prevSummary.dailyCount > 0 || prevSummary.workoutCount > 0)) {
    body += 'Use the prior-month deltas as your scoreboard — the trend matters more than any single entry. ';
  }
  body += strategic;
  return open + body;
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

function formatIntMom(cur, prev) {
  if (prev == null || !Number.isFinite(prev)) return 'No prior month in dataset';
  const d = cur - prev;
  if (d === 0) return 'Flat vs prior month';
  return `${d > 0 ? '+' : ''}${d} vs prior month`;
}

function formatAvgMom(cur, prev, unit, decimals = 0) {
  if (cur == null || prev == null) return '— vs prior month';
  const d = cur - prev;
  const u = unit === 'steps' ? '' : ` ${unit}`;
  const fmt = (v) => (decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString('en-IN'));
  if (Math.abs(d) < 1e-9) return `Flat vs prior month${u}`;
  return `${d > 0 ? '+' : ''}${fmt(d)}${u} vs prior`;
}

function dailyPresenceSpark(monthKey, dailyCheckins) {
  const n = daysInMonthKey(monthKey);
  const set = new Set((dailyCheckins || []).map((r) => String(r.checkin_date || '').slice(0, 10)));
  const [y, mo] = String(monthKey || '').split('-').map((x) => parseInt(x, 10));
  const out = [];
  for (let d = 1; d <= n; d += 1) {
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push(set.has(key) ? 1 : 0.12);
  }
  return out;
}

function lastNumericSeries(arr, pick, max = 24) {
  const raw = (arr || []).map(pick).filter((v) => Number.isFinite(v));
  return raw.slice(-max);
}

function drawWatermark(doc) {
  // Placed by the kernel, which computes the rotated bounding box from the real
  // string metrics and keeps every repetition on the sheet. Drawn with no width
  // so PDFKit can neither wrap it nor add a page for it.
  PL.diagonalWatermark(doc, { text: 'CONFIDENTIAL', font: F(doc, 'display'), size: 52, color: C.gold, opacity: 0.035, count: 4 });
}

/**
 * The hero band on page one.
 *
 * Every plate is anchored to the right MARGIN and fitted to its own width, so a
 * long client name, a long program name or a long email cannot run into each
 * other or past the edge of the sheet.
 */
function drawHeroBand(doc, { user, monthKeyText, docId, logoPath, currentProgram }) {
  const w = doc.page.width;
  const mR = doc.page.margins.right;
  const plateW = 160;
  const plateX = w - mR - plateW;
  const textX = 258;
  const textW = Math.max(180, plateX - textX - 16);
  doc.rect(0, 0, w, 108).fill(C.bg);
  doc.moveTo(0, 108).lineTo(w, 108).lineWidth(3).strokeColor(C.gold).stroke();
  doc.moveTo(0, 111).lineTo(w, 111).lineWidth(0.5).strokeColor(C.goldDark).stroke();

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 40, 28, { fit: [200, 52] });
    } catch (e) { /* ignore */ }
  } else {
    // Without the lockup image the dossier still has to be branded.
    PL.drawFit(doc, 'BODYBANK', 40, 40, 200, { font: F(doc, 'display'), size: 22, color: C.gold });
    PL.drawFit(doc, 'bodybank.fit', 40, 66, 200, { font: F(doc, 'body'), size: 9, color: '#8FA0C4' });
  }

  PL.drawFit(doc, 'PRIVATE PERFORMANCE DOSSIER', textX, 46, textW, { font: F(doc, 'body'), size: 8.5, color: '#8FA0C4' });

  const displayName = (user.name || user.email || 'Client').toUpperCase();
  PL.drawFit(doc, displayName, textX, 62, textW, { font: F(doc, 'display'), size: 21, minSize: 9, color: '#F2F4FA' });
  PL.drawFit(doc, monthKeyText, textX, 90, textW, { font: F(doc, 'semi'), size: 10, color: C.goldMid });

  // Show current program in top-right corner
  if (currentProgram) {
    PL.drawFit(doc, 'PROGRAM', plateX, 28, plateW, { font: F(doc, 'semi'), size: 7.5, color: C.gold, align: 'right' });
    PL.drawText(doc, currentProgram, plateX, 40,
      { font: F(doc, 'body'), size: 8, width: plateW, align: 'right', lineGap: 1, color: '#E8ECF4', maxLines: 2 });
  }
  PL.drawFit(doc, 'DOC ' + docId, plateX, currentProgram ? 62 : 28, plateW,
    { font: F(doc, 'body'), size: 7.5, color: '#5C6578', align: 'right' });
  PL.drawFit(doc, new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
    plateX, currentProgram ? 74 : 42, plateW, { font: F(doc, 'body'), size: 7, color: '#4A5568', align: 'right' });
}

function drawSparkBars(doc, x, y, barW, h, values, fillColor) {
  const n = values.length || 1;
  const gap = Math.max(0.3, (barW - n * 1.2) / Math.max(n, 1));
  const bw = Math.min(2.2, (barW - (n - 1) * gap) / n);
  values.forEach((v, i) => {
    const bh = Math.max(1, v * h);
    const bx = x + i * (bw + gap);
    const by = y + h - bh;
    doc.roundedRect(bx, by, bw, bh, 0.4).fill(fillColor);
  });
}

function drawSparkLine(doc, x, y, w, h, values, strokeColor) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) return;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const spread = max - min || 1;
  const pts = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const px = x + (values.length === 1 ? w / 2 : (w * i) / (values.length - 1));
    const py = y + h - ((v - min) / spread) * h;
    pts.push([px, py]);
  }
  if (pts.length >= 2) {
    doc.strokeColor(strokeColor).lineWidth(1.2).moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) doc.lineTo(pts[i][0], pts[i][1]);
    doc.stroke();
  }
  pts.forEach(([px, py]) => {
    doc.fillColor(strokeColor).circle(px, py, 1.6).fill();
  });
}

/** Vertical stack inside KPI card — avoids overlap between big number, MoM text, spark, and caption. */
function drawKpiPremium(doc, x, y, w, h, { label, value, sub, mom, sparkVals, sparkMode, sparkColor, accentColor }) {
  const inset = 12;
  const innerW = w - inset * 2;
  doc.save();
  doc.roundedRect(x, y, w, h, 11).fillAndStroke(C.panel, '#B8C2D6');
  const barInset = 10;
  doc.roundedRect(x + 3, y + barInset, 3.2, h - barInset * 2, 1).fill(accentColor || C.gold);
  doc.restore();

  const sparkH = 15;
  const subBand = sub ? 13 : 6;
  const bottomSparkTop = y + h - subBand - sparkH - 6;

  // Each row is fitted or capped to the card, and the whole stack is bounded by
  // where the sparkline starts, so a seven-figure average or a long
  // month-on-month note cannot push anything through the bottom of the card.
  let cy = y + 10;
  PL.drawFit(doc, label.toUpperCase(), x + inset, cy, innerW, { font: F(doc, 'semi'), size: 7.5, minSize: 5.5, color: C.muted });
  cy += 11;

  PL.drawFit(doc, String(value), x + inset, cy, innerW, { font: F(doc, 'display'), size: 17, minSize: 7, color: C.text });
  cy += 19;

  PL.drawText(doc, mom || '', x + inset, cy,
    { font: F(doc, 'body'), size: 6.9, width: innerW, lineGap: 1.5, color: C.goldDark, maxHeight: Math.max(0, bottomSparkTop - cy - 3) });

  const sparkTop = bottomSparkTop;
  const sw = w - inset * 2;
  const sx = x + inset;
  if (sparkMode === 'bars' && sparkVals && sparkVals.length) {
    drawSparkBars(doc, sx, sparkTop, sw, sparkH, sparkVals, sparkColor || C.gold);
  } else if (sparkMode === 'line' && sparkVals && sparkVals.length) {
    drawSparkLine(doc, sx, sparkTop, sw, sparkH, sparkVals, sparkColor || C.emerald);
  }

  if (sub) {
    PL.drawFit(doc, sub, x + inset, y + h - 11, innerW, { font: F(doc, 'body'), size: 7.2, minSize: 5.5, color: C.muted });
  }
}

function sectionTitle(doc, text, y, contentW, margin) {
  doc.roundedRect(margin, y, contentW, 22, 5).fillAndStroke(C.panelSoft, '#BFC8D8');
  PL.drawFit(doc, String(text).toUpperCase(), margin + 10, y + 7, contentW - 20,
    { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.goldDark });
}

function drawLineChart(doc, cfg) {
  const { x, y, w, h, title, values, lineColor, labels } = cfg;
  const titleBarH = 22;
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#C5CDDC');
  doc.rect(x + 1, y + 1, w - 2, titleBarH).fill('#F8F9FC');
  PL.drawFit(doc, title, x + 10, y + 6, w - 20, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.text });
  const padX = 24;
  const padTop = titleBarH + 6;
  const padBottom = 22;
  const cx = x + padX;
  const cy = y + padTop;
  const cw = w - padX * 1.3;
  const ch = h - padTop - padBottom;
  doc.strokeColor(C.grid).lineWidth(0.5);
  for (let i = 0; i <= 4; i += 1) {
    const gy = cy + (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).stroke();
  }
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) {
    PL.drawFit(doc, 'No series data this month', cx, cy + ch * 0.32, cw, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.muted, align: 'center' });
    PL.drawText(doc, 'Log progress or daily check-ins in this month to unlock this curve.',
      cx, cy + ch * 0.46, { font: F(doc, 'body'), size: 7.8, width: cw, align: 'center', lineGap: 2, color: C.muted,
        maxHeight: Math.max(0, (cy + ch) - (cy + ch * 0.46)) });
    return;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const spread = max - min || 1;
  // Axis extremes sit in an 18pt gutter; they shrink rather than cut, because
  // a truncated axis value is a wrong one.
  PL.drawFit(doc, max.toFixed(1), cx - 20, cy - 1, 18, { font: F(doc, 'body'), size: 6.8, minSize: 4.5, color: C.muted, align: 'right' });
  PL.drawFit(doc, min.toFixed(1), cx - 20, cy + ch - 9, 18, { font: F(doc, 'body'), size: 6.8, minSize: 4.5, color: C.muted, align: 'right' });
  const path = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const px = cx + (values.length === 1 ? cw / 2 : (cw * i) / (values.length - 1));
    const py = cy + ch - ((v - min) / spread) * ch;
    path.push([px, py]);
  }
  if (path.length >= 2) {
    doc.moveTo(path[0][0], cy + ch);
    path.forEach(([px, py]) => doc.lineTo(px, py));
    doc.lineTo(path[path.length - 1][0], cy + ch);
    doc.closePath();
    doc.fillColor(lineColor || C.gold).opacity(0.13).fill().opacity(1);
  }
  if (path.length) {
    doc.strokeColor(lineColor || C.gold).lineWidth(1.8).moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i += 1) doc.lineTo(path[i][0], path[i][1]);
    doc.stroke();
  }
  doc.fillColor(lineColor || C.gold);
  path.forEach(([px, py]) => {
    doc.circle(px, py, 2.8).fill();
    doc.strokeColor('#FFFFFF').lineWidth(0.8).circle(px, py, 2.8).stroke();
  });
  const labelFirst = labels && labels.length ? labels[0] : '';
  const labelLast = labels && labels.length ? labels[labels.length - 1] : '';
  PL.drawFit(doc, labelFirst, cx, cy + ch + 4, Math.min(70, cw / 2 - 4), { font: F(doc, 'body'), size: 7, minSize: 5, color: C.muted });
  PL.drawFit(doc, labelLast, cx + cw - 52, cy + ch + 4, 52, { font: F(doc, 'body'), size: 7, minSize: 5, color: C.muted, align: 'right' });
}

/** Vertical bar chart — one bar per value; each bar can use a rotating color. */
function drawVerticalBarChart(doc, cfg) {
  const { x, y, w, h, title, values, labels } = cfg;
  const titleBarH = 22;
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#C5CDDC');
  doc.rect(x + 1, y + 1, w - 2, titleBarH).fill('#F8FAFC');
  PL.drawFit(doc, title, x + 10, y + 6, w - 20, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.text });
  const nums = (values || []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : null));
  const valid = nums.filter((v) => v != null && v > 0);
  const cx = x + 14;
  const cw = w - 28;
  const ch = h - titleBarH - 30;
  const cy = y + titleBarH + 8;
  if (!valid.length) {
    PL.drawFit(doc, 'No numeric data this month', cx, cy + ch * 0.35, cw, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.muted, align: 'center' });
    return;
  }
  const max = Math.max(...valid);
  const n = nums.length;
  const gap = Math.max(1.5, cw * 0.04 / Math.max(n, 1));
  const barW = Math.max(3, (cw - gap * (n - 1)) / n);
  nums.forEach((v, i) => {
    if (v == null || v <= 0) return;
    const bh = (v / max) * ch;
    const bx = cx + i * (barW + gap);
    const by = cy + ch - bh;
    const col = VIBRANT.chartLine[i % VIBRANT.chartLine.length];
    doc.roundedRect(bx, by, barW, bh, 2).fill(col);
  });
  if (labels && labels.length === n && n <= 14) {
    nums.forEach((_, i) => {
      const lab = String(labels[i] || '').slice(0, 4);
      PL.drawFit(doc, lab, cx + i * (barW + gap), cy + ch + 3, barW + gap, { font: F(doc, 'body'), size: 5.8, minSize: 4.5, color: C.muted, align: 'center' });
    });
  }
}

/** Horizontal stacked bars for category counts (e.g. workout_type). */
function drawHorizontalCategoryBars(doc, cfg) {
  const { x, y, w, h, title, items } = cfg;
  const titleBarH = 22;
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#C5CDDC');
  doc.rect(x + 1, y + 1, w - 2, titleBarH).fill('#F8FAFC');
  PL.drawFit(doc, title, x + 10, y + 6, w - 20, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.text });
  const list = (items || []).filter((it) => it && Number(it.value) > 0);
  const innerTop = y + titleBarH + 6;
  const innerH = h - titleBarH - 20;
  if (!list.length) {
    PL.drawFit(doc, 'No categories logged', x + 16, innerTop + innerH * 0.3, w - 32, { font: F(doc, 'body'), size: 8.5, color: C.muted, align: 'center' });
    return;
  }
  const max = Math.max(...list.map((it) => Number(it.value)), 1);
  const rowH = Math.min(16, Math.max(9, innerH / Math.max(list.length, 1) - 3));
  let ry = innerTop;
  list.forEach((it, i) => {
    const val = Number(it.value);
    const lab = String(it.label || '—').replace(/\s+/g, ' ').trim().slice(0, 22);
    const barMaxW = w - 108;
    const bw = (val / max) * barMaxW;
    // Fitted to its 74pt gutter: a wrapped category label used to spill into the
    // row beneath it.
    PL.drawFit(doc, lab, x + 8, ry + 2, 72, { font: F(doc, 'body'), size: 6.8, minSize: 5, color: C.text });
    doc.roundedRect(x + 84, ry + 1, barMaxW, rowH - 2, 2).fill('#E8EDF5');
    doc.roundedRect(x + 84, ry + 1, Math.max(2, bw), rowH - 2, 2).fill(VIBRANT.chartLine[i % VIBRANT.chartLine.length]);
    PL.drawFit(doc, String(val), x + w - 26, ry + 2, 22, { font: F(doc, 'semi'), size: 7, minSize: 4.5, color: C.text, align: 'right' });
    ry += rowH + 3;
    if (ry > y + h - 14) return;
  });
}

function aggregateWorkoutTypes(workouts) {
  const m = {};
  (workouts || []).forEach((w) => {
    const t = String(w.workout_type || w.workout_name || 'Other').trim() || 'Other';
    m[t] = (m[t] || 0) + 1;
  });
  return Object.entries(m)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

/** Second page — six colorful charts from all logged series. */
function drawVisualAnalyticsPage(doc, {
  margin,
  contentW,
  gap,
  monthKeyText,
  user,
  data
}) {
  doc.addPage();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
  drawWatermark(doc);
  doc.rect(0, 0, doc.page.width, 56).fill(C.bg);
  doc.rect(0, 54, doc.page.width, 2).fill(C.gold);
  PL.drawFit(doc, 'BODYBANK  ·  VISUAL ANALYTICS', margin, 14, contentW, { font: F(doc, 'display'), size: 12, color: C.gold });
  PL.drawFit(doc, `${monthKeyText} · ${(user.name || user.email || 'Client').slice(0, 48)}`, margin, 32, contentW,
    { font: F(doc, 'body'), size: 8.5, minSize: 6.5, color: '#A5B4FC' });

  const daily = data.dailyCheckins || [];
  const prog = data.progressLogs || [];
  const wk = data.workouts || [];

  const stepLabelsDaily = daily.map((r) => formatDate(r.checkin_date).slice(0, 9));
  const proteinSeries = daily.map((r) => (r.protein_g != null ? num(r.protein_g) : null));
  const sleepSeriesDaily = daily.map((r) => (r.sleep_hours != null ? num(r.sleep_hours) : null));
  const waterMlSeries = daily.map((r) => (r.water_ml != null ? num(r.water_ml) : null));
  const calSeries = prog.map((r) => (r.calories_intake != null ? num(r.calories_intake) : null));
  const labelsProg = prog.map((r) => formatDate(r.created_at).slice(0, 9));
  const benchSeries = prog.map((r) => (r.strength_bench != null ? num(r.strength_bench) : null));
  const squatSeries = prog.map((r) => (r.strength_squat != null ? num(r.strength_squat) : null));

  const wl = (data.weightLogs || []).map((r) => (r.weight_kg != null ? num(r.weight_kg) : null));
  const wlLabels = (data.weightLogs || []).map((r) => formatDate(r.created_at).slice(0, 9));

  const durSessions = (wk || []).map((r) => (r.duration_seconds != null ? num(r.duration_seconds) / 60 : null));
  const durLabels = (wk || []).map((r) => formatDate(r.created_at || r.session_date).slice(0, 6));

  const chartH = 120;
  const chartW = (contentW - gap * 2) / 3;
  let rowY = margin + 62;

  sectionTitle(doc, 'Nutrition, recovery & body metrics — color series', rowY - 20, contentW, margin);
  rowY += 6;

  drawLineChart(doc, {
    x: margin,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Daily protein (g)',
    values: proteinSeries,
    lineColor: VIBRANT.coral,
    labels: stepLabelsDaily
  });
  drawLineChart(doc, {
    x: margin + chartW + gap,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Daily sleep (hours)',
    values: sleepSeriesDaily,
    lineColor: VIBRANT.teal,
    labels: stepLabelsDaily
  });
  drawLineChart(doc, {
    x: margin + (chartW + gap) * 2,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Daily water (ml)',
    values: waterMlSeries,
    lineColor: VIBRANT.sky,
    labels: stepLabelsDaily
  });

  rowY += chartH + gap + 18;
  sectionTitle(doc, 'Training load, intake & distribution', rowY - 20, contentW, margin);
  rowY += 6;

  drawLineChart(doc, {
    x: margin,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Calories (progress log)',
    values: calSeries,
    lineColor: VIBRANT.amber,
    labels: labelsProg
  });

  const deadSeries = prog.map((r) => (r.strength_deadlift != null ? num(r.strength_deadlift) : null));
  const bfProgSeries = prog.map((r) => (r.body_fat != null ? num(r.body_fat) : null));
  const hasBenchAny = benchSeries.some((v) => v != null && Number.isFinite(v));
  const hasSquatAny = squatSeries.some((v) => v != null && Number.isFinite(v));
  const hasDeadAny = deadSeries.some((v) => v != null && Number.isFinite(v));
  const hasBfProg = bfProgSeries.some((v) => v != null && Number.isFinite(v));

  if (hasBenchAny && hasSquatAny) {
    drawMultiLineChart(doc, {
      x: margin + chartW + gap,
      y: rowY,
      w: chartW,
      h: chartH,
      title: 'Strength — bench vs squat (kg)',
      series: [
        { values: benchSeries, color: VIBRANT.violet, label: 'Bench' },
        { values: squatSeries, color: VIBRANT.orange, label: 'Squat' }
      ],
      labels: labelsProg
    });
  } else if (hasBenchAny) {
    drawLineChart(doc, {
      x: margin + chartW + gap,
      y: rowY,
      w: chartW,
      h: chartH,
      title: 'Bench press (kg)',
      values: benchSeries,
      lineColor: VIBRANT.violet,
      labels: labelsProg
    });
  } else if (hasSquatAny) {
    drawLineChart(doc, {
      x: margin + chartW + gap,
      y: rowY,
      w: chartW,
      h: chartH,
      title: 'Squat (kg)',
      values: squatSeries,
      lineColor: VIBRANT.orange,
      labels: labelsProg
    });
  } else if (hasDeadAny) {
    drawLineChart(doc, {
      x: margin + chartW + gap,
      y: rowY,
      w: chartW,
      h: chartH,
      title: 'Deadlift (kg)',
      values: deadSeries,
      lineColor: VIBRANT.indigo,
      labels: labelsProg
    });
  } else if (hasBfProg) {
    drawLineChart(doc, {
      x: margin + chartW + gap,
      y: rowY,
      w: chartW,
      h: chartH,
      title: 'Body fat % (progress log)',
      values: bfProgSeries,
      lineColor: VIBRANT.lime,
      labels: labelsProg
    });
  } else {
    drawLineChart(doc, {
      x: margin + chartW + gap,
      y: rowY,
      w: chartW,
      h: chartH,
      title: 'Protein (progress log, g)',
      values: prog.map((r) => (r.protein_intake != null ? num(r.protein_intake) : null)),
      lineColor: VIBRANT.coral,
      labels: labelsProg
    });
  }

  const lastN = 18;
  const durSlice = durSessions.slice(-lastN);
  const durLabSlice = durLabels.slice(-lastN);
  drawVerticalBarChart(doc, {
    x: margin + (chartW + gap) * 2,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Session duration (min, last sessions)',
    values: durSlice,
    labels: durLabSlice
  });

  rowY += chartH + gap + 18;
  sectionTitle(doc, 'Weight & workout mix', rowY - 20, contentW, margin);
  rowY += 6;

  drawLineChart(doc, {
    x: margin,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Weight — dedicated logs (kg)',
    values: wl.length ? wl : [],
    lineColor: VIBRANT.rose,
    labels: wlLabels
  });

  drawHorizontalCategoryBars(doc, {
    x: margin + chartW + gap,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Workout type / name mix',
    items: aggregateWorkoutTypes(wk)
  });

  const hyd = data.hydrationLogs || [];
  const hydLab = hyd.map((h) => formatDate(h.created_at).slice(0, 9));
  drawLineChart(doc, {
    x: margin + (chartW + gap) * 2,
    y: rowY,
    w: chartW,
    h: chartH,
    title: 'Hydration logs (ml per entry)',
    values: hyd.map((h) => (h.amount_ml != null ? num(h.amount_ml) : null)),
    lineColor: VIBRANT.cyan,
    labels: hydLab
  });

  const footnote =
    'Each chart uses a distinct palette colour. Empty charts mean no rows in that table for this month.';
  const footY = rowY + chartH + 14;
  const footH = PL.drawText(doc, footnote, margin, footY,
    { font: F(doc, 'body'), size: 7.2, width: contentW, align: 'center', lineGap: 2, color: C.muted });
  return footY + footH + 12;
}

/** Two line series overlaid (aligned by index). */
function drawMultiLineChart(doc, cfg) {
  const { x, y, w, h, title, series, labels } = cfg;
  const titleBarH = 22;
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#C5CDDC');
  doc.rect(x + 1, y + 1, w - 2, titleBarH).fill('#F8FAFC');
  PL.drawFit(doc, title, x + 10, y + 6, w - 20, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.text });
  const padX = 22;
  const padTop = titleBarH + 6;
  const padBottom = 26;
  const cx = x + padX;
  const cy = y + padTop;
  const cw = w - padX * 1.4;
  const ch = h - padTop - padBottom;
  doc.strokeColor(C.grid).lineWidth(0.45);
  for (let i = 0; i <= 4; i += 1) {
    const gy = cy + (ch * i) / 4;
    doc.moveTo(cx, gy).lineTo(cx + cw, gy).stroke();
  }

  let allVals = [];
  (series || []).forEach((s) => {
    (s.values || []).forEach((v) => {
      if (v != null && Number.isFinite(v)) allVals.push(v);
    });
  });
  if (!allVals.length) {
    PL.drawFit(doc, 'No strength data this month', cx, cy + ch * 0.35, cw, { font: F(doc, 'semi'), size: 8.5, minSize: 6, color: C.muted, align: 'center' });
    return;
  }
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const spread = max - min || 1;

  (series || []).forEach((s) => {
    const stroke = s.color || VIBRANT.violet;
    const vals = s.values || [];
    doc.strokeColor(stroke).lineWidth(1.6).opacity(0.95);
    let started = false;
    for (let i = 0; i < vals.length; i += 1) {
      const v = vals[i];
      if (!Number.isFinite(v)) continue;
      const px = cx + (vals.length === 1 ? cw / 2 : (cw * i) / Math.max(vals.length - 1, 1));
      const py = cy + ch - ((v - min) / spread) * ch;
      if (!started) {
        doc.moveTo(px, py);
        started = true;
      } else doc.lineTo(px, py);
    }
    doc.stroke();
    doc.opacity(1);
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const px = cx + (vals.length === 1 ? cw / 2 : (cw * i) / Math.max(vals.length - 1, 1));
      const py = cy + ch - ((v - min) / spread) * ch;
      doc.fillColor(stroke).circle(px, py, 2.2).fill();
    });
  });

  // Legend entries each get a 74pt slot inside the card. The bullet goes
  // through the WinAnsi table too — a raw U+25CF printed as mojibake here.
  (series || []).slice(0, 3).forEach((s, i) => {
    PL.drawFit(doc, `● ${s.label || 'S' + (i + 1)}`, x + 12 + i * 78, y + h - 16, Math.min(74, x + w - 12 - (x + 12 + i * 78)),
      { font: F(doc, 'body'), size: 6.5, minSize: 5, color: s.color || VIBRANT.violet });
  });
  const labelFirst = labels && labels.length ? labels[0] : '';
  const labelLast = labels && labels.length ? labels[labels.length - 1] : '';
  PL.drawFit(doc, labelFirst, cx, cy + ch + 4, Math.min(70, cw / 2 - 4), { font: F(doc, 'body'), size: 6.8, minSize: 5, color: C.muted });
  PL.drawFit(doc, labelLast, cx + cw - 52, cy + ch + 4, 52, { font: F(doc, 'body'), size: 6.8, minSize: 5, color: C.muted, align: 'right' });
}

/**
 * Bullets drawn inside a box the caller has already measured and stroked.
 *
 * `maxY` is a hard floor: this list never opens a page of its own (that is the
 * appendix paginator's job) and never draws past the bottom of the panel it was
 * given, so the risk and action columns stay inside their cards.
 */
function addBulletList(doc, items, x, y, width, color, fontSize = 9, maxY = Infinity) {
  let curY = y;
  const list = asList(items, 12);
  if (!list.length) {
    PL.drawFit(doc, '—', x, curY, width, { font: F(doc, 'body'), size: fontSize, color: C.muted });
    return curY + 14;
  }
  list.forEach((item) => {
    const L = PL.layout(doc, item, { font: F(doc, 'body'), size: fontSize, width: width - 10, lineGap: 2 });
    L.lines.forEach((line, i) => {
      if (curY + L.lineHeight > maxY) return;
      if (i === 0) PL.drawFit(doc, '•', x, curY, 10, { font: F(doc, 'semi'), size: fontSize, color: C.goldMid });
      const single = {
        lines: [line], lineHeight: L.lineHeight, height: L.lineHeight,
        font: L.font, size: L.size, lineGap: L.lineGap, width: L.width, align: L.align
      };
      PL.drawLayout(doc, single, x + 10, curY, { color });
      curY += L.lineHeight;
    });
    curY += 3;
  });
  return curY;
}

/** Height needed to render bullets (for layout before drawing boxes). */
function measureBulletsHeight(doc, items, width, fontSize = 8) {
  const list = asList(items, 12);
  if (!list.length) return 16;
  let h = 0;
  list.forEach((item) => {
    h += PL.measure(doc, item, { font: F(doc, 'body'), size: fontSize, width: width - 10, lineGap: 2 }) + 5;
  });
  return h;
}

const PART2_LABELS = {
  name: 'Name',
  email: 'Email',
  mobile: 'Mobile',
  sports_history: 'Sports history',
  injuries: 'Injuries',
  mental_health: 'Mental health',
  gym_experience: 'Gym experience',
  food_choices: 'Food choices',
  vices_addictions: 'Vices / addictions',
  goals: 'Goals',
  what_compelled: 'What compelled you',
  activity_level: 'Activity level',
  created_at: 'Submitted'
};

function workoutVolumeSpark(workouts) {
  const buckets = [0, 0, 0, 0, 0];
  (workouts || []).forEach((w) => {
    const d = new Date(w.created_at);
    if (Number.isNaN(d.getTime())) return;
    const idx = Math.min(4, Math.floor((d.getDate() - 1) / 7));
    buckets[idx] += 1;
  });
  const mx = Math.max(...buckets, 1);
  return buckets.map((n) => n / mx);
}

function part2Lines(part2) {
  if (!part2 || typeof part2 !== 'object') return [];
  const lines = [];
  Object.keys(PART2_LABELS).forEach((key) => {
    if (part2[key] == null || part2[key] === '') return;
    const label = PART2_LABELS[key];
    let val = part2[key];
    if (key === 'created_at') val = formatDate(val);
    const s = String(val).replace(/\s+/g, ' ').trim();
    lines.push(`${label}: ${s.slice(0, 320)}${s.length > 320 ? '…' : ''}`);
  });
  return lines;
}

function generateMonthlyClientReport(opts) {
  return new Promise((resolve, reject) => {
    const { outputPath, monthKey, user, data, insights, logoPath, aiNarrative } = opts;
    const prevData = data.previousMonth || null;
    const reportSummary = summarize(data);
    const prevSummary = prevData ? summarize(prevData) : null;

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc._bbCustomFonts = registerReportFonts(doc);
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const margin = 36;
    const contentW = doc.page.width - margin * 2;
    const gap = 8;
    const kpiW = (contentW - gap * 3) / 4;
    const chartW = (contentW - gap * 2) / 3;
    const docId = crypto.randomBytes(5).toString('hex').toUpperCase();
    const monthKeyText = monthLabel(monthKey);

    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
    drawWatermark(doc);
    const currentProgramName = (data.programs && data.programs.length) ? data.programs[0].program_name : null;
    drawHeroBand(doc, { user, monthKeyText, docId, logoPath, currentProgram: currentProgramName });

    const kpiY = 122;
    const cardH = 100;
    const chartY = kpiY + cardH + gap + 16;
    const chartH = 128;

    sectionTitle(doc, 'Performance scorecard · vs prior month', kpiY - 24, contentW, margin);

    const sparkDaily = dailyPresenceSpark(monthKey, data.dailyCheckins);
    const stepsRaw = lastNumericSeries(data.dailyCheckins, (r) => (r.steps != null ? num(r.steps) : null), 28);
    const stepsMax = Math.max(...stepsRaw, 1);
    const sparkSteps = stepsRaw.map((v) => v / stepsMax);
    const sleepRaw = lastNumericSeries(data.dailyCheckins, (r) => (r.sleep_hours != null ? num(r.sleep_hours) : null), 28);
    const sleepMax = Math.max(...sleepRaw, 12, 1);
    const sparkSleep = sleepRaw.map((v) => v / sleepMax);
    const sparkWorkouts = workoutVolumeSpark(data.workouts);

    drawKpiPremium(doc, margin, kpiY, kpiW, cardH, {
      label: 'Daily check-ins',
      value: reportSummary.dailyCount,
      sub: 'Days with a log',
      mom: formatIntMom(reportSummary.dailyCount, prevSummary ? prevSummary.dailyCount : null),
      sparkVals: sparkDaily,
      sparkMode: 'bars',
      sparkColor: VIBRANT.coral,
      accentColor: VIBRANT.coral
    });
    drawKpiPremium(doc, margin + kpiW + gap, kpiY, kpiW, cardH, {
      label: 'Workouts',
      value: reportSummary.workoutCount,
      sub: 'Sessions this month',
      mom: formatIntMom(reportSummary.workoutCount, prevSummary ? prevSummary.workoutCount : null),
      sparkVals: sparkWorkouts,
      sparkMode: 'bars',
      sparkColor: VIBRANT.teal,
      accentColor: VIBRANT.teal
    });
    drawKpiPremium(doc, margin + (kpiW + gap) * 2, kpiY, kpiW, cardH, {
      label: 'Avg steps',
      value: reportSummary.avgSteps ? Math.round(reportSummary.avgSteps).toLocaleString('en-IN') : '—',
      sub: 'Daily average',
      mom: formatAvgMom(reportSummary.avgSteps, prevSummary ? prevSummary.avgSteps : null, 'steps', 0),
      sparkVals: sparkSteps,
      sparkMode: 'line',
      sparkColor: VIBRANT.lime,
      accentColor: VIBRANT.lime
    });
    drawKpiPremium(doc, margin + (kpiW + gap) * 3, kpiY, kpiW, cardH, {
      label: 'Avg sleep',
      value: reportSummary.avgSleep ? `${reportSummary.avgSleep.toFixed(1)} h` : '—',
      sub: 'Daily average',
      mom: formatAvgMom(reportSummary.avgSleep, prevSummary ? prevSummary.avgSleep : null, 'h', 1),
      sparkVals: sparkSleep.length ? sparkSleep : [],
      sparkMode: 'line',
      sparkColor: VIBRANT.sky,
      accentColor: VIBRANT.sky
    });

    const labels = (data.progressLogs || []).map((r) => formatDate(r.created_at).slice(0, 9));
    const weightSeries = (data.progressLogs || []).map((r) => (r.weight != null ? num(r.weight) : null));
    const bfSeries = (data.progressLogs || []).map((r) => (r.body_fat != null ? num(r.body_fat) : null));
    const stepsSeries = (data.dailyCheckins || []).map((r) => (r.steps != null ? num(r.steps) : null));
    const stepLabels = (data.dailyCheckins || []).map((r) => formatDate(r.checkin_date).slice(0, 9));

    sectionTitle(doc, 'Biometric & activity curves', chartY - 22, contentW, margin);
    drawLineChart(doc, {
      x: margin,
      y: chartY,
      w: chartW,
      h: chartH,
      title: 'Weight (kg)',
      values: weightSeries,
      lineColor: VIBRANT.chartLine[0],
      labels
    });
    drawLineChart(doc, {
      x: margin + chartW + gap,
      y: chartY,
      w: chartW,
      h: chartH,
      title: 'Body fat (%)',
      values: bfSeries,
      lineColor: VIBRANT.rose,
      labels
    });
    drawLineChart(doc, {
      x: margin + (chartW + gap) * 2,
      y: chartY,
      w: chartW,
      h: chartH,
      title: 'Steps',
      values: stepsSeries,
      lineColor: VIBRANT.lime,
      labels: stepLabels
    });

    const afterVisualY = drawVisualAnalyticsPage(doc, { margin, contentW, gap, monthKeyText, user, data });

    const coachPayload = extractCoachPayload(insights);
    const performanceLines = formatCoachPerformanceLines(coachPayload);
    const riskLines = deriveRiskLines(coachPayload, reportSummary);
    const insightTags = coachPayload ? coachPayload.insightTags : [];
    const actionLines = deriveActionLines(coachPayload, reportSummary, insightTags);
    const strategic = buildStrategicNarrative(reportSummary, data);
    const fallbackLetter = buildCoachLetter(user.name || user.email || 'Client', reportSummary, prevSummary, strategic);
    const letter =
      aiNarrative && aiNarrative.executive_summary && String(aiNarrative.executive_summary).trim()
        ? String(aiNarrative.executive_summary).trim()
        : fallbackLetter;

    const letterY = afterVisualY + 8;
    sectionTitle(doc, 'Executive dossier — lead coach narrative', letterY - 14, contentW, margin);
    const letterPadX = 16;
    const letterTextW = contentW - letterPadX * 2;
    // The box was capped at 420pt while the narrative was drawn uncapped, so
    // any long executive summary ran straight out of the bottom of it and over
    // the panels beneath. The narrative is now split: the lines that fit the
    // room on this page go in the box, and every remaining line is handed to
    // the appendix, which prints it first under "continued". Nothing is cut.
    const letterBoxTop = letterY + 4;
    const letterRoom = Math.max(48, (doc.page.height - margin - 120) - letterBoxTop - 40);
    const letterFull = PL.layout(doc, letter, { font: F(doc, 'body'), size: 9, width: letterTextW, lineGap: 3 });
    const fitLines = Math.max(1, Math.floor(Math.min(420 - 48, letterRoom) / letterFull.lineHeight));
    const letterL = Object.assign({}, letterFull, {
      lines: letterFull.lines.slice(0, fitLines),
      height: Math.min(fitLines, letterFull.lines.length) * letterFull.lineHeight
    });
    const letterRest = letterFull.lines.length > fitLines
      ? Object.assign({}, letterFull, {
        lines: letterFull.lines.slice(fitLines),
        height: (letterFull.lines.length - fitLines) * letterFull.lineHeight
      })
      : null;
    const letterBoxH = Math.max(62, 34 + letterL.height + 14);
    doc.roundedRect(margin, letterBoxTop, contentW, letterBoxH, 10).fill('#FFFCF5');
    doc.roundedRect(margin, letterBoxTop, contentW, letterBoxH, 10).lineWidth(1.5).strokeColor(C.gold).stroke();
    PL.drawFit(doc, 'FROM THE COACHING DESK · FULL MONTH SIGNAL', margin + letterPadX, letterBoxTop + 12, letterTextW,
      { font: F(doc, 'semi'), size: 8, minSize: 6, color: C.goldDark });
    PL.drawLayout(doc, letterL, margin + letterPadX, letterBoxTop + 26, { color: C.text });

    const stripY = letterBoxTop + letterBoxH + 10;
    const stripH = 42;
    doc.roundedRect(margin, stripY, contentW, stripH, 8).fillAndStroke(C.panel, '#C5CDDC');
    PL.drawFit(doc, 'AT A GLANCE', margin + 12, stripY + 9, contentW - 24, { font: F(doc, 'semi'), size: 7.5, color: C.muted });
    const programLabel = (data.programs && data.programs.length) ? data.programs[0].program_name : 'No program assigned';
    const glance = [
      `Program: ${programLabel}`,
      `Weight (month): ${reportSummary.latestWeight != null ? `${reportSummary.latestWeight.toFixed(1)} kg` : '—'} · Δ ${reportSummary.weightDelta != null ? `${reportSummary.weightDelta >= 0 ? '+' : ''}${reportSummary.weightDelta.toFixed(1)} kg` : '—'}`,
      `Body fat: ${reportSummary.latestBodyFat != null ? `${reportSummary.latestBodyFat.toFixed(1)}%` : '—'} · Protein avg: ${reportSummary.avgProtein != null ? `${reportSummary.avgProtein.toFixed(0)} g` : '—'}`,
      `Sunday check-ins: ${reportSummary.sundayCount} · ${user.email || '—'}`
    ].join('   ·   ');
    // Capped to the strip it lives in: the glance line is built from the
    // member's own program name and email and can be arbitrarily long.
    PL.drawText(doc, glance, margin + 12, stripY + 23,
      { font: F(doc, 'body'), size: 8, width: contentW - 24, lineGap: 2, color: C.text, maxHeight: stripH - 25 });

    const colTop = stripY + stripH + 10;
    const colW = (contentW - gap) / 2;
    const footerReserve = 28;
    const maxColH = doc.page.height - margin - footerReserve - colTop;
    const riskBlockH = measureBulletsHeight(doc, riskLines.slice(0, 4), colW - 24, 8.5);
    const actBlockH = measureBulletsHeight(doc, actionLines.slice(0, 5), colW - 24, 8.5);
    const colNeeded = Math.max(riskBlockH, actBlockH) + 36;
    const colH = Math.max(56, Math.min(maxColH, colNeeded));
    doc.roundedRect(margin, colTop, colW, colH, 9).fillAndStroke(C.panel, '#B8C2D6');
    doc.roundedRect(margin + colW + gap, colTop, colW, colH, 9).fillAndStroke(C.panel, '#B8C2D6');
    const colHdrY = colTop + 12;
    const colBodyY = colTop + 28;
    const colFloor = colTop + colH - 8;
    PL.drawFit(doc, 'Risk focus', margin + 12, colHdrY, colW - 24, { font: F(doc, 'semi'), size: 9, color: C.danger });
    PL.drawFit(doc, 'Action protocol', margin + colW + gap + 12, colHdrY, colW - 24, { font: F(doc, 'semi'), size: 9, color: C.emerald });
    // Both columns are bounded by the card they sit in, so neither can bleed
    // out of it when the coaching lines run long.
    addBulletList(doc, riskLines.slice(0, 4), margin + 12, colBodyY, colW - 24, '#7A2E28', 8.5, colFloor);
    addBulletList(doc, actionLines.slice(0, 5), margin + colW + gap + 12, colBodyY, colW - 24, '#0F6B52', 8.5, colFloor);

    const detailStartY = colTop + colH + 12;
    renderLuxuryDetailSections(doc, {
      margin,
      contentW,
      user,
      monthKeyText,
      data,
      aiNarrative: aiNarrative || null,
      performanceLines,
      insightTags,
      docId,
      startY: detailStartY,
      letterRest
    });

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = {
  generateMonthlyClientReport,
  monthLabel,
  summarize,
  daysInMonthKey
};
