const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

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
    body += 'Daily telemetry is strong — that level of visibility is what separates guesswork from precision coaching. ';
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
  doc.save();
  doc.opacity(0.035);
  doc.fillColor(C.gold);
  doc.font(F(doc, 'display')).fontSize(56);
  for (let i = 0; i < 4; i += 1) {
    doc.save();
    doc.rotate(-28, { origin: [120 + i * 160, 200 + i * 120] });
    doc.text('CONFIDENTIAL', 40 + i * 40, 100 + i * 180);
    doc.restore();
  }
  doc.opacity(1);
  doc.restore();
}

function drawHeroBand(doc, { user, monthKeyText, docId, logoPath }) {
  const w = doc.page.width;
  doc.rect(0, 0, w, 108).fill(C.bg);
  doc.moveTo(0, 108).lineTo(w, 108).lineWidth(3).strokeColor(C.gold).stroke();
  doc.moveTo(0, 111).lineTo(w, 111).lineWidth(0.5).strokeColor(C.goldDark).stroke();

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, 40, 28, { fit: [52, 52] });
    } catch (e) { /* ignore */ }
  }

  doc.fillColor(C.gold).font(F(doc, 'display')).fontSize(11).text('BODYBANK', 104, 30);
  doc.fillColor('#8FA0C4').font(F(doc, 'body')).fontSize(8.5).text('PRIVATE PERFORMANCE DOSSIER', 104, 46);

  const displayName = (user.name || user.email || 'Client').toUpperCase();
  doc.fillColor('#F2F4FA').font(F(doc, 'display')).fontSize(21).text(displayName, 104, 62, { width: w - 200 });
  doc.fillColor(C.goldMid).font(F(doc, 'semi')).fontSize(10).text(monthKeyText, 104, 90);

  doc.fillColor('#5C6578').font(F(doc, 'body')).fontSize(7.5).text(`DOCUMENT ${docId}`, w - 128, 28, { width: 112, align: 'right' });
  doc.fillColor('#4A5568').font(F(doc, 'body')).fontSize(7).text(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC', w - 128, 42, { width: 112, align: 'right' });
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
function drawKpiPremium(doc, x, y, w, h, { label, value, sub, mom, sparkVals, sparkMode, sparkColor }) {
  const inset = 12;
  const innerW = w - inset * 2;
  doc.save();
  doc.roundedRect(x, y, w, h, 11).fillAndStroke(C.panel, '#B8C2D6');
  const barInset = 10;
  doc.roundedRect(x + 3, y + barInset, 3.2, h - barInset * 2, 1).fill(C.gold);
  doc.restore();

  const sparkH = 15;
  const subBand = sub ? 13 : 6;
  const bottomSparkTop = y + h - subBand - sparkH - 6;

  let cy = y + 10;
  doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(7.5).text(label.toUpperCase(), x + inset, cy, { width: innerW });
  cy = doc.y + 3;

  doc.fillColor(C.text).font(F(doc, 'display')).fontSize(17).text(String(value), x + inset, cy, { width: innerW });
  cy = doc.y + 2;

  doc.fillColor(C.goldDark).font(F(doc, 'body')).fontSize(6.9).text(mom || '', x + inset, cy, { width: innerW, lineGap: 1.5 });
  cy = doc.y + 3;

  const sparkTop = bottomSparkTop;
  const sw = w - inset * 2;
  const sx = x + inset;
  if (sparkMode === 'bars' && sparkVals && sparkVals.length) {
    drawSparkBars(doc, sx, sparkTop, sw, sparkH, sparkVals, sparkColor || C.gold);
  } else if (sparkMode === 'line' && sparkVals && sparkVals.length) {
    drawSparkLine(doc, sx, sparkTop, sw, sparkH, sparkVals, sparkColor || C.emerald);
  }

  if (sub) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.2).text(sub, x + inset, y + h - 11, { width: innerW });
  }
}

function sectionTitle(doc, text, y, contentW, margin) {
  doc.roundedRect(margin, y, contentW, 22, 5).fillAndStroke(C.panelSoft, '#BFC8D8');
  doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8.5).text(text.toUpperCase(), margin + 10, y + 7);
}

function drawLineChart(doc, cfg) {
  const { x, y, w, h, title, values, lineColor, labels } = cfg;
  const titleBarH = 22;
  doc.roundedRect(x, y, w, h, 10).fillAndStroke(C.panel, '#C5CDDC');
  doc.rect(x + 1, y + 1, w - 2, titleBarH).fill('#F8F9FC');
  doc.fillColor(C.text).font(F(doc, 'semi')).fontSize(8.5).text(title, x + 10, y + 6);
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
    doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(8.5).text('No series data this month', cx, cy + ch * 0.32, { width: cw, align: 'center' });
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.8).text(
      'Log progress or daily check-ins in this month to unlock this curve.',
      cx, cy + ch * 0.46, { width: cw, align: 'center', lineGap: 2 }
    );
    return;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const spread = max - min || 1;
  doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(6.8)
    .text(max.toFixed(1), cx - 20, cy - 1, { width: 18, align: 'right' })
    .text(min.toFixed(1), cx - 20, cy + ch - 9, { width: 18, align: 'right' });
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
  doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7)
    .text(labelFirst, cx, cy + ch + 4, { width: 70 })
    .text(labelLast, cx + cw - 52, cy + ch + 4, { width: 52, align: 'right' });
}

function addBulletList(doc, items, x, y, width, color, fontSize = 9) {
  let curY = y;
  const list = asList(items, 12);
  if (!list.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(fontSize).text('—', x, curY, { width });
    return curY + 14;
  }
  list.forEach((item) => {
    doc.fillColor(C.goldMid).font(F(doc, 'semi')).fontSize(fontSize).text('•', x, curY);
    doc.fillColor(color).font(F(doc, 'body')).fontSize(fontSize).text(item, x + 10, curY, { width: width - 10, lineGap: 2 });
    curY = doc.y + 3;
  });
  return curY;
}

/** Height needed to render bullets (for layout before drawing boxes). */
function measureBulletsHeight(doc, items, width, fontSize = 8) {
  const list = asList(items, 12);
  if (!list.length) return 16;
  doc.font(F(doc, 'body')).fontSize(fontSize);
  let h = 0;
  list.forEach((item) => {
    h += doc.heightOfString(item, { width: width - 10, lineGap: 2 }) + 5;
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

function drawAppendixPage(doc, {
  margin, contentW, user, monthKeyText, performanceLines, riskLines, actionLines, insightTags,
  data, part2LinesArr, logoPath
}) {
  const assignedPrograms = (data && data.programs) ? data.programs : [];
  const tribeMember = (data && data.tribeMember) ? data.tribeMember : null;
  doc.addPage();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
  drawWatermark(doc);

  doc.rect(0, 0, doc.page.width, 64).fill(C.bg);
  doc.rect(0, 62, doc.page.width, 2).fill(C.gold);
  doc.fillColor(C.gold).font(F(doc, 'display')).fontSize(12).text('APPENDIX — SOURCE DETAIL', margin, 22);
  doc.fillColor('#9EC4FF').font(F(doc, 'body')).fontSize(9).text(`${user.name || user.email} · ${monthKeyText}`, margin, 40, { width: contentW });

  if (logoPath && fs.existsSync(logoPath)) {
    try {
      const lh = 40;
      doc.image(logoPath, doc.page.width - margin - 44, 12 + (64 - lh) / 2, { fit: [lh, lh] });
    } catch (e) { /* ignore */ }
  }

  let y = 78;
  sectionTitle(doc, 'Program signals (full list)', y, contentW, margin);
  y += 30;
  const metricsTextW = contentW - 24;
  const perfH = measureBulletsHeight(doc, performanceLines.slice(0, 6), metricsTextW, 7.8);
  let engineBlock = 0;
  if (insightTags.length) {
    engineBlock = 12 + measureBulletsHeight(doc, insightTags.slice(0, 4), metricsTextW, 7.8);
  }
  const metricsBoxH = Math.min(200, 30 + perfH + engineBlock + 10);
  doc.roundedRect(margin, y, contentW, metricsBoxH, 8).fillAndStroke(C.panel, '#B8C2D6');
  doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.5).text('Cumulative / lifetime context from progress analytics (not limited to this month).', margin + 12, y + 8, { width: metricsTextW });
  let innerY = addBulletList(doc, performanceLines.slice(0, 6), margin + 12, y + 22, metricsTextW, C.text, 7.8) + 6;
  if (insightTags.length) {
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text('Engine signals', margin + 12, innerY);
    addBulletList(doc, insightTags.slice(0, 4), margin + 12, innerY + 10, metricsTextW, C.emerald, 7.8);
  }

  y += metricsBoxH + 10;
  const splitGutter = 12;
  const colHalf = (contentW - splitGutter) / 2;
  const riskTextW = colHalf - 24;
  const actTextW = colHalf - 24;
  const riskBodyH = measureBulletsHeight(doc, riskLines.slice(0, 4), riskTextW, 7.8);
  const actBodyH = measureBulletsHeight(doc, actionLines.slice(0, 5), actTextW, 7.8);
  const splitInner = Math.max(riskBodyH, actBodyH, 28);
  const splitBoxH = 12 + splitInner + 16;
  doc.roundedRect(margin, y, contentW, splitBoxH, 8).fillAndStroke('#FFFAF5', '#E8D9B8');
  const splitTitleY = y + 10;
  const splitBodyY = y + 24;
  doc.fillColor(C.danger).font(F(doc, 'semi')).fontSize(8).text('Risk focus', margin + 12, splitTitleY);
  doc.fillColor(C.emerald).font(F(doc, 'semi')).fontSize(8).text('Action protocol', margin + colHalf + splitGutter + 12, splitTitleY);
  addBulletList(doc, riskLines.slice(0, 4), margin + 12, splitBodyY, riskTextW, '#8F3A30', 7.8);
  addBulletList(doc, actionLines.slice(0, 5), margin + colHalf + splitGutter + 12, splitBodyY, actTextW, '#0F6B52', 7.8);

  y += splitBoxH + 12;
  // Assigned Programs
  if (assignedPrograms.length) {
    y += 10;
    sectionTitle(doc, 'Assigned programs', y, contentW, margin);
    y += 28;
    const progBoxH = Math.min(80, 16 + assignedPrograms.length * 18);
    doc.roundedRect(margin, y, contentW, progBoxH, 8).fillAndStroke('#F5F8FF', '#B8C2D6');
    let py = y + 10;
    assignedPrograms.forEach(function(p, i) {
      const bullet = i === 0 ? '\u2605 CURRENT' : '  ' + (i + 1) + '.';
      const assigned = p.assigned_at ? new Date(p.assigned_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '\u2014';
      doc.font(F(doc, i === 0 ? 'semi' : 'body')).fontSize(8)
        .fillColor(i === 0 ? C.goldDark : C.muted)
        .text(bullet + '  ' + (p.program_name || '\u2014') + '  \u00b7  Assigned: ' + assigned, margin + 12, py, { width: contentW - 24 });
      py += 16;
    });
    y += progBoxH + 10;
  }

  // Tribe Member Status
  if (tribeMember) {
    sectionTitle(doc, 'Tribe member status', y, contentW, margin);
    y += 28;
    const tribeLines = [
      'Status: ' + (tribeMember.status || '\u2014') + '  \u00b7  Phase: ' + (tribeMember.phase || '\u2014') + '  \u00b7  Started: ' + (tribeMember.start_date || '\u2014'),
      'Weight: ' + (tribeMember.starting_weight || '\u2014') + 'kg \u2192 ' + (tribeMember.current_weight || '\u2014') + 'kg (target: ' + (tribeMember.target_weight || '\u2014') + 'kg)',
    ];
    if (tribeMember.notes) tribeLines.push('Trainer notes: ' + String(tribeMember.notes).slice(0, 180));
    const tribeBoxH = 14 + tribeLines.length * 13;
    doc.roundedRect(margin, y, contentW, tribeBoxH, 8).fillAndStroke('#F5FFF8', '#9DCDB8');
    let ty = y + 8;
    tribeLines.forEach(function(line) {
      doc.font(F(doc, 'body')).fontSize(8).fillColor(C.text).text(line, margin + 12, ty, { width: contentW - 24 });
      ty += 13;
    });
    y += tribeBoxH + 10;
  }

  sectionTitle(doc, 'Sunday check-in transcripts', y, contentW, margin);
  y += 28;
  const sundays = data.sundayCheckins || [];
  if (!sundays.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(9).text('No Sunday check-ins in this month.', margin, y, { width: contentW });
    y += 20;
  } else {
    sundays.slice(0, 7).forEach((r) => {
      const body = String(r.achievements || '—').slice(0, 520);
      doc.font(F(doc, 'body')).fontSize(8.2);
      const bodyH = doc.heightOfString(body, { width: contentW - 28, lineGap: 2 });
      const cardH = Math.min(100, Math.max(40, 26 + bodyH + 10));
      doc.roundedRect(margin, y, contentW, cardH, 6).fillAndStroke('#FAFBFD', '#D0D6E6');
      doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text(formatDate(r.created_at), margin + 12, y + 8);
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(8.2).text(body, margin + 12, y + 20, { width: contentW - 24, lineGap: 2 });
      y += cardH + 10;
    });
  }

  sectionTitle(doc, 'Workout log (chronological)', y, contentW, margin);
  y += 28;
  const workouts = data.workouts || [];
  if (!workouts.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(9).text('No workouts logged this month.', margin, y);
    y += 18;
  } else {
    const xDate = margin + 8;
    const xSess = margin + contentW * 0.22;
    const xDur = margin + contentW * 0.72;
    const wDate = xSess - xDate - 6;
    const wSess = xDur - xSess - 8;
    const wDur = margin + contentW - xDur - 8;
    doc.fillColor(C.text).font(F(doc, 'semi')).fontSize(7.5);
    doc.text('DATE', xDate, y, { width: wDate });
    doc.text('SESSION', xSess, y, { width: wSess });
    doc.text('DURATION', xDur, y, { width: wDur, align: 'right' });
    y += 12;
    doc.moveTo(margin, y).lineTo(margin + contentW, y).lineWidth(0.5).strokeColor(C.grid).stroke();
    y += 8;
    workouts.slice(0, 28).forEach((r) => {
      doc.font(F(doc, 'body')).fontSize(8);
      const nm = String(r.workout_name || 'Workout').slice(0, 52);
      const rowH = Math.max(14, doc.heightOfString(nm, { width: wSess, lineGap: 1 }) + 4);
      doc.fillColor(C.text);
      doc.text(formatDate(r.created_at), xDate, y, { width: wDate });
      doc.text(nm, xSess, y, { width: wSess, lineGap: 1 });
      doc.text(`${num(r.duration_seconds, 0)} sec`, xDur, y, { width: wDur, align: 'right' });
      y += rowH;
    });
  }

  if (part2LinesArr.length) {
    y += 10;
    if (y > 720) y = 720;
    sectionTitle(doc, 'Latest Part-2 intake (on file)', y, contentW, margin);
    y += 28;
    doc.roundedRect(margin, y, contentW, Math.min(80, 20 + part2LinesArr.length * 11), 8).fillAndStroke(C.panel, '#B8C2D6');
    addBulletList(doc, part2LinesArr.slice(0, 8), margin + 10, y + 8, contentW - 20, C.text, 7.8);
  }

  doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.5)
    .text('BODYBANK · CONFIDENTIAL APPENDIX · bodybank.fit', margin, doc.page.height - margin - 4, { width: contentW, align: 'center' });
}

function generateMonthlyClientReport(opts) {
  return new Promise((resolve, reject) => {
    const { outputPath, monthKey, user, data, insights, logoPath } = opts;
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
    drawHeroBand(doc, { user, monthKeyText, docId, logoPath });

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
      sparkColor: C.gold
    });
    drawKpiPremium(doc, margin + kpiW + gap, kpiY, kpiW, cardH, {
      label: 'Workouts',
      value: reportSummary.workoutCount,
      sub: 'Sessions this month',
      mom: formatIntMom(reportSummary.workoutCount, prevSummary ? prevSummary.workoutCount : null),
      sparkVals: sparkWorkouts,
      sparkMode: 'bars',
      sparkColor: C.goldMid
    });
    drawKpiPremium(doc, margin + (kpiW + gap) * 2, kpiY, kpiW, cardH, {
      label: 'Avg steps',
      value: reportSummary.avgSteps ? Math.round(reportSummary.avgSteps).toLocaleString('en-IN') : '—',
      sub: 'Daily average',
      mom: formatAvgMom(reportSummary.avgSteps, prevSummary ? prevSummary.avgSteps : null, 'steps', 0),
      sparkVals: sparkSteps,
      sparkMode: 'line',
      sparkColor: C.emerald
    });
    drawKpiPremium(doc, margin + (kpiW + gap) * 3, kpiY, kpiW, cardH, {
      label: 'Avg sleep',
      value: reportSummary.avgSleep ? `${reportSummary.avgSleep.toFixed(1)} h` : '—',
      sub: 'Daily average',
      mom: formatAvgMom(reportSummary.avgSleep, prevSummary ? prevSummary.avgSleep : null, 'h', 1),
      sparkVals: sparkSleep.length ? sparkSleep : [],
      sparkMode: 'line',
      sparkColor: C.violet
    });

    const labels = (data.progressLogs || []).map((r) => formatDate(r.created_at).slice(0, 9));
    const weightSeries = (data.progressLogs || []).map((r) => (r.weight != null ? num(r.weight) : null));
    const bfSeries = (data.progressLogs || []).map((r) => (r.body_fat != null ? num(r.body_fat) : null));
    const stepsSeries = (data.dailyCheckins || []).map((r) => (r.steps != null ? num(r.steps) : null));
    const stepLabels = (data.dailyCheckins || []).map((r) => formatDate(r.checkin_date).slice(0, 9));

    sectionTitle(doc, 'Biometric & activity curves', chartY - 22, contentW, margin);
    drawLineChart(doc, {
      x: margin, y: chartY, w: chartW, h: chartH, title: 'Weight (kg)', values: weightSeries, lineColor: C.gold, labels
    });
    drawLineChart(doc, {
      x: margin + chartW + gap, y: chartY, w: chartW, h: chartH, title: 'Body fat (%)', values: bfSeries, lineColor: C.violet, labels
    });
    drawLineChart(doc, {
      x: margin + (chartW + gap) * 2, y: chartY, w: chartW, h: chartH, title: 'Steps', values: stepsSeries, lineColor: C.emerald, labels: stepLabels
    });

    const coachPayload = extractCoachPayload(insights);
    const performanceLines = formatCoachPerformanceLines(coachPayload);
    const riskLines = deriveRiskLines(coachPayload, reportSummary);
    const insightTags = coachPayload ? coachPayload.insightTags : [];
    const actionLines = deriveActionLines(coachPayload, reportSummary, insightTags);
    const strategic = buildStrategicNarrative(reportSummary, data);
    const letter = buildCoachLetter(user.name || user.email || 'Client', reportSummary, prevSummary, strategic);

    const letterY = chartY + chartH + gap + 8;
    sectionTitle(doc, 'Coach executive note', letterY - 14, contentW, margin);
    const letterPadX = 16;
    const letterTextW = contentW - letterPadX * 2;
    doc.font(F(doc, 'body')).fontSize(9);
    const letterBodyH = doc.heightOfString(letter, { width: letterTextW, lineGap: 3 });
    const letterBoxH = Math.min(198, Math.max(62, 34 + letterBodyH + 14));
    const letterBoxTop = letterY + 4;
    doc.roundedRect(margin, letterBoxTop, contentW, letterBoxH, 10).fill('#FFFCF5');
    doc.roundedRect(margin, letterBoxTop, contentW, letterBoxH, 10).lineWidth(1.5).strokeColor(C.gold).stroke();
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text('FROM THE COACHING DESK', margin + letterPadX, letterBoxTop + 12);
    doc.fillColor(C.text).font(F(doc, 'body')).fontSize(9).text(letter, margin + letterPadX, letterBoxTop + 26, { width: letterTextW, lineGap: 3 });

    const stripY = letterBoxTop + letterBoxH + 10;
    const stripH = 42;
    doc.roundedRect(margin, stripY, contentW, stripH, 8).fillAndStroke(C.panel, '#C5CDDC');
    doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(7.5).text('AT A GLANCE', margin + 12, stripY + 9);
    const glance = [
      `Weight (month): ${reportSummary.latestWeight != null ? `${reportSummary.latestWeight.toFixed(1)} kg` : '—'} · Δ ${reportSummary.weightDelta != null ? `${reportSummary.weightDelta >= 0 ? '+' : ''}${reportSummary.weightDelta.toFixed(1)} kg` : '—'}`,
      `Body fat: ${reportSummary.latestBodyFat != null ? `${reportSummary.latestBodyFat.toFixed(1)}%` : '—'} · Protein avg: ${reportSummary.avgProtein != null ? `${reportSummary.avgProtein.toFixed(0)} g` : '—'}`,
      `Sunday check-ins: ${reportSummary.sundayCount} · ${user.email || '—'}`
    ].join('   ·   ');
    doc.fillColor(C.text).font(F(doc, 'body')).fontSize(8).text(glance, margin + 12, stripY + 23, { width: contentW - 24, lineGap: 2 });

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
    doc.fillColor(C.danger).font(F(doc, 'semi')).fontSize(9).text('Risk focus', margin + 12, colHdrY);
    doc.fillColor(C.emerald).font(F(doc, 'semi')).fontSize(9).text('Action protocol', margin + colW + gap + 12, colHdrY);
    addBulletList(doc, riskLines.slice(0, 4), margin + 12, colBodyY, colW - 24, '#7A2E28', 8.5);
    addBulletList(doc, actionLines.slice(0, 5), margin + colW + gap + 12, colBodyY, colW - 24, '#0F6B52', 8.5);

    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.5)
      .text(`BODYBANK · PAGE 1 OF 2 · ${docId} · CONFIDENTIAL`, margin, doc.page.height - margin - 6, { width: contentW, align: 'center' });

    const p2lines = part2Lines(data.part2);
    drawAppendixPage(doc, {
      margin,
      contentW,
      user,
      monthKeyText,
      performanceLines,
      riskLines,
      actionLines,
      insightTags,
      data,
      part2LinesArr: p2lines,
      logoPath
    });

    doc.end();
    stream.on('finish', () => resolve({ outputPath }));
    stream.on('error', reject);
  });
}

module.exports = { generateMonthlyClientReport, monthLabel };
