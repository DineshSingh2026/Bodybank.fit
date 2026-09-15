'use strict';

/**
 * Reports module — HTML template builder.
 *
 *   buildDocument(model) -> { specs, photos, pages, render({ images, photos }) -> html }
 *
 * Two passes, because charts are drawn in Chrome: first the layout decides every
 * chart's slot size and emits the specs; services/reportPdf.js draws them to PNG;
 * render() then embeds the PNGs into templates/report.html.
 *
 * Page order (spec): Cover/Scorecard -> Workout -> Nutrition -> Check-in &
 * Consistency -> Yoga & Recovery -> Body & Progress -> Blood Reports ->
 * Achievements & Next Plan. Weekly: Yoga merges into Check-in; Body and Blood
 * appear only with new data in the period. Monthly: all eight.
 *
 * Every dynamic string goes through esc(). Every section has KPI tiles, charts
 * (or the empty-state line), an Insight box and an Action box.
 */

const fs = require('fs');
const path = require('path');
const S = require('./reportScore');
const CH = require('./reportCharts');

const TPL_DIR = path.join(__dirname, '..', 'templates');
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO_FILE = path.join(__dirname, '..', 'assets', 'report', 'logo-coin.png');

let cache = null;
function assets() {
  if (cache) return cache;
  const read = (p) => { try { return fs.readFileSync(p); } catch (_) { return null; } };
  const face = (file, weight) => {
    const buf = read(path.join(FONT_DIR, file));
    return buf ? `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/ttf;base64,${buf.toString('base64')}) format('truetype');}` : '';
  };
  const logo = read(LOGO_FILE);
  cache = {
    shell: fs.readFileSync(path.join(TPL_DIR, 'report.html'), 'utf8'),
    css: fs.readFileSync(path.join(TPL_DIR, 'report.css'), 'utf8'),
    fonts: [face('Inter-Regular.ttf', 400), face('Inter-SemiBold.ttf', 600), face('InterDisplay-Bold.ttf', 700)].join('\n'),
    logo: logo ? 'data:image/png;base64,' + logo.toString('base64') : ''
  };
  return cache;
}

// ---------------------------------------------------------------------------
// Tiny HTML helpers
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtInt(n) { return n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-IN'); }
function fmt1(n) { return n == null || !isFinite(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
function gradeClass(g) {
  if (g === 'A+' || g === 'A') return 'g-good';
  if (g === 'B' || g === 'C') return 'g-warn';
  if (g === 'D' || g === 'E') return 'g-flag';
  return 'g-none';
}
function badge(g, lg) { return `<span class="badge ${lg ? 'badge--lg ' : ''}${gradeClass(g)}">${esc(g || '—')}</span>`; }
const ARROW = {
  up: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2 9.2 8.6H.8z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8.8.8 1.4h8.4z" fill="currentColor"/></svg>',
  flat: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="4.2" width="8" height="1.6" rx=".8" fill="currentColor"/></svg>'
};
/** @param dir 'up'|'down'|'flat'  @param good true/false/null (null = neutral colour) */
function delta(dir, text, good) {
  const cls = good == null ? (dir === 'flat' ? 'flat' : 'neutral') : (good ? 'up' : 'down');
  return `<span class="delta ${dir === 'flat' ? 'flat' : cls}">${ARROW[dir] || ARROW.flat}${esc(text)}</span>`;
}
function mmStyle(h) { return `height:${h}mm`; }

const ICON = {
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-9-1 3-3 4-4 4 0-2-1-4-3-6 0 4-3 6-3 11a7 7 0 0 0 7 7Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 3c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5ZM17 9c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5ZM5 16h5M15 22h5"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c9 0 14-5 14-14-9 0-14 5-14 14Z"/><path d="M5 19 13 11"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-4 4.5a1.8 1.8 0 0 1 0 3.5h-4.5M11 8v10" stroke-linecap="round"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 15.5l3-3.5 3 2 3.5-4.5"/></svg>'
};

// ---------------------------------------------------------------------------
// Geometry (mm). Card inner width = card width - 2*3.2 padding - 2*0.3 border.
// ---------------------------------------------------------------------------

const W = {
  full: 179,
  half: 84,
  quarter: 37.2
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * Growable slot attributes. `data-h` is the height the fit pass scales from;
 * `data-slot` names the slot the layout probe may grow (services/reportPdf.js
 * probeLayout); `data-stack` says how many slots share one row height.
 */
function slotAttrs(slot, h, stack) {
  return `data-h="${h}"${slot ? ` data-slot="${esc(slot)}"` : ''}${stack && stack > 1 ? ` data-stack="${stack}"` : ''} style="${mmStyle(h)}"`;
}

/**
 * @param ch   chart from services/reportCharts.js (carries .slot and .h in mm)
 * @param opts { row: true } when the card is a row of its own; { h, slot, oneLine }
 */
function chartCard(ch, imgs, opts) {
  const o = opts || {};
  const h = o.h != null ? o.h : ch.h;
  const slot = o.slot !== undefined ? o.slot : ch.slot;
  const row = o.row ? ' data-row' : '';
  const title = `<figcaption class="c-title" data-fit>${esc(ch.title)}</figcaption>`;
  const cap = `<p class="c-cap${o.oneLine ? ' one' : ''}" data-fit-lines="${o.oneLine ? 1 : 2}">${esc(ch.caption || '')}</p>`;
  if (ch.empty) {
    return `<figure class="card chart"${row}>${title}<div class="empty" ${slotAttrs(slot, h)}>${ICON.empty}<p>${esc(ch.emptyText)}</p></div>${cap}</figure>`;
  }
  const src = imgs[ch.spec.id];
  const body = src
    ? `<img class="c-img" ${slotAttrs(slot, h)} src="${src}" alt="${esc(ch.title)}">`
    : `<div class="empty" ${slotAttrs(slot, h)}>${ICON.empty}<p>Chart unavailable for this period.</p></div>`;
  const center = ch.center ? `<div class="donut-center"><b>${esc(ch.center.value)}</b><span>${esc(ch.center.label)}</span></div>` : '';
  return `<figure class="card chart"${row}>${title}${center ? `<div class="donut-wrap">${body}${center}</div>` : body}${cap}</figure>`;
}

function kpiTile(t) {
  return `<div class="kpi">
    <div class="kpi-top"><span class="kpi-label" data-fit>${esc(t.label)}</span>${t.grade !== undefined ? badge(t.grade) : ''}</div>
    <div class="kpi-value" data-fit>${esc(t.value)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div>
    <div class="kpi-delta" data-fit>${t.delta || '<span class="delta flat">&nbsp;</span>'}</div>
  </div>`;
}

function callouts(rows) {
  if (rows.length === 1) {
    return `<div class="callouts push">
      <div class="callout callout--insight"><div class="co-label">Insight</div><p class="co-text">${esc(rows[0].insight)}</p></div>
      <div class="callout callout--action"><div class="co-label">Action</div><p class="co-text">${esc(rows[0].action)}</p></div>
    </div>`;
  }
  const col = (kind) => rows.map((r) => `<div class="co-row"><span class="co-tag">${esc(r.tag)}</span><p class="co-text">${esc(r[kind])}</p></div>`).join('');
  return `<div class="callouts push">
    <div class="callout callout--insight"><div class="co-label">Insight</div><div class="co-rows">${col('insight')}</div></div>
    <div class="callout callout--action"><div class="co-label">Action</div><div class="co-rows">${col('action')}</div></div>
  </div>`;
}

function sectionHead(num, eyebrow, title, pillar, word) {
  let right = '';
  if (pillar) {
    const has = pillar.score != null;
    const d = pillar.deltaPct;
    const dTxt = d == null ? 'First report' : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} pts vs last ${word}`;
    right = `<div class="sh-score">
      <div class="sh-delta">${d == null ? delta('flat', dTxt, null) : delta(d > 0 ? 'up' : d < 0 ? 'down' : 'flat', dTxt, d === 0 ? null : d > 0)}</div>
      <div class="sh-num">${has ? esc(pillar.score) : '—'}<span>/100</span></div>${badge(pillar.grade, true)}
    </div>`;
  }
  return `<div class="sh"><div class="sh-left"><div class="sh-eyebrow">${esc(String(num).padStart(2, '0'))} · ${esc(eyebrow)}</div><h2 class="sh-title" data-fit>${esc(title)}</h2></div>${right}</div>`;
}

function deltaCount(cur, prev, word, unit, goodUp) {
  if (prev == null || cur == null) return delta('flat', 'No previous data', null);
  const d = Math.round((cur - prev) * 10) / 10;
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const good = d === 0 ? null : (goodUp == null ? null : (goodUp ? d > 0 : d < 0));
  return delta(dir, `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt1(Math.abs(d))}${unit || ''} vs last ${word}`, good);
}
function deltaPts(p, word) {
  if (p.deltaPct == null) return delta('flat', 'First report', null);
  const d = p.deltaPct;
  return delta(d > 0 ? 'up' : d < 0 ? 'down' : 'flat', `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} pts vs last ${word}`, d === 0 ? null : d > 0);
}
function pctGrade(pct) { return pct == null ? null : S.gradeFor(pct); }

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function pageShell(model, key, inner, pageNo, total, extraClass) {
  const a = assets();
  const head = key === 'cover' ? '' : `<header class="ph">
    <div class="ph-brand">${a.logo ? `<img class="ph-logo" src="${a.logo}" alt="">` : ''}<div><div class="ph-word">BODYBANK</div><div class="ph-sub">${esc(model.titleShort)}</div></div></div>
    <div class="ph-meta"><div class="ph-client" data-fit>${esc(model.client.name)}</div><div class="ph-period" data-fit>${esc(model.periodLabel)}</div></div>
  </header>`;
  return `<section class="page page--${esc(key)}${extraClass ? ' ' + extraClass : ''}" data-page="${pageNo}">
  ${head}
  ${inner}
  <footer class="pf"><span class="pf-site">bodybank.fit</span><span class="pf-mid">Prepared for ${esc(model.client.name)} · ${esc(model.titleShort)} · Confidential</span><span class="pf-page">Page ${pageNo} of ${total}</span></footer>
</section>`;
}

function coverInner(model, imgs, sections) {
  const a = assets();
  const s = model.score;
  const word = model.word;
  const d = s.totalDelta;
  const dHtml = d == null ? delta('flat', `Your first ${word}ly score`, null)
    : delta(d > 0 ? 'up' : d < 0 ? 'down' : 'flat', `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} pts vs last ${word} (${s.previous.total})`, d === 0 ? null : d > 0);
  const chips = [];
  if (model.client.goalLabel) chips.push(`Goal: ${model.client.goalLabel}`);
  if (model.goalWeight) chips.push(`Target weight ${model.goalWeight} kg`);
  chips.push(`${model.periodDays} days`);
  const pillarCards = S.PILLARS.map((k) => {
    const p = s.pillars[k];
    const wTxt = p.weight ? `Weight ${p.weight}%` : (k === 'health' ? 'Not counted this ' + word : 'Not counted');
    const dd = p.deltaPct;
    const dTxt = dd == null ? delta('flat', 'First report', null) : delta(dd > 0 ? 'up' : dd < 0 ? 'down' : 'flat', `${dd > 0 ? '+' : dd < 0 ? '−' : '±'}${Math.abs(dd)} pts`, dd === 0 ? null : dd > 0);
    return `<div class="pillar">
      <div class="pillar-g">${imgs['g-' + k] ? `<img src="${imgs['g-' + k]}" alt="">` : ''}<b>${p.score == null ? '—' : esc(p.score)}</b></div>
      <div><div class="pillar-name" data-fit>${esc(p.label)}</div><div class="pillar-meta">${badge(p.grade)}${dTxt}</div><div class="pillar-w" data-fit>${esc(wTxt)}</div></div>
    </div>`;
  }).join('');

  const COMP = { workout: CH.PAL.blue, nutrition: CH.PAL.orange, checkin: CH.PAL.aqua, consistency: CH.PAL.yellow, yoga: CH.PAL.magenta, health: CH.PAL.violet };
  const contrib = S.PILLARS.map((k) => ({ k, p: s.pillars[k], pts: s.pillars[k].weight ? ((s.pillars[k].score || 0) * s.pillars[k].weight) / 100 : 0 }));
  const bar = contrib.filter((c) => c.pts > 0).map((c) => `<i style="width:${(c.pts).toFixed(2)}%;background:${COMP[c.k]}"></i>`).join('');
  const legend = contrib.map((c) => `<div><b>${c.p.weight ? fmt1(c.pts) : '—'}<span style="color:#8a877f;font-weight:600"> / ${c.p.weight}</span></b><em style="background:${COMP[c.k]}"></em>${esc(c.p.label)}</div>`).join('');
  const summary = (model.insights.summary || []).slice(0, 3).map((l) => `<li>${esc(l)}</li>`).join('');

  return `<div class="cover-hero">
    <div class="ch-brand">${a.logo ? `<img src="${a.logo}" alt="">` : ''}<div><div class="ch-word">BODYBANK</div><div class="ch-tag">Lifestyle performance coaching</div></div></div>
    <div class="ch-main">
      <div class="ch-kicker">${esc(model.titleShort)}</div>
      <h1 class="ch-title">Your ${esc(word)} in review</h1>
      <div class="ch-client" data-fit>${esc(model.client.name)}</div>
      <div class="ch-period" data-fit>${esc(model.periodLabel)}</div>
      <div class="ch-chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
    </div>
    <div class="ch-gauge">
      ${imgs['g-total'] ? `<img src="${imgs['g-total']}" alt="">` : ''}
      <div class="ch-gauge-center"><div class="ch-score">${esc(s.total)}</div><div class="ch-score-of">BodyBank Score</div><div class="ch-grade">${badge(s.grade, true)}</div></div>
      <div class="ch-gauge-foot">${dHtml}</div>
    </div>
  </div>
  <div class="cover-body">
    <div class="summary"><div class="co-label">Summary</div><ol>${summary}</ol></div>
    <div class="pillars">${pillarCards}</div>
    <div class="cover-row">
      <div class="comp">
        <div class="comp-head"><h3>How your ${esc(s.total)} points were earned</h3><span>Pillar score × weight</span></div>
        <div class="comp-bar">${bar}</div>
        <div class="comp-legend">${legend}</div>
      </div>
      ${tocHtml(model, sections || [])}
    </div>
    <p class="cover-note push">Grades: A+ 90+, A 80+, B 70+, C 60+, D 50+, E below 50. ${s.healthRedistributed ? `Health is not counted this ${esc(word)} (no new body or blood data), so its 10% moved to workout and nutrition (+5 each). ` : ''}Every score is computed the same way for the previous ${esc(word)} to show your trend. This report is coaching guidance, not medical advice.</p>
  </div>`;
}

const TOC_TITLES = {
  workout: 'Workout', nutrition: 'Nutrition', checkin: 'Check-in & consistency', yoga: 'Yoga & recovery',
  body: 'Body & progress', blood: 'Blood reports', achievements: 'Achievements & next plan'
};
const TOC_PILLAR = { workout: 'workout', nutrition: 'nutrition', checkin: 'checkin', yoga: 'yoga', body: 'health' };

function tocHtml(model, sections) {
  const items = sections.map((key, i) => ({ key, n: i + 1 })).filter((x) => x.key !== 'cover').map((x) => {
    const title = x.key === 'checkin' && model.type === 'weekly' ? 'Check-in, consistency & yoga' : TOC_TITLES[x.key];
    const pk = TOC_PILLAR[x.key];
    const p = pk ? model.score.pillars[pk] : null;
    const g = p && p.score != null && (p.counted || pk !== 'health') ? badge(p.grade) : '<span class="badge g-none toc-dash">—</span>';
    return `<li><span class="toc-n">${String(x.n).padStart(2, '0')}</span><span class="toc-t" data-fit>${esc(title)}</span>${g}</li>`;
  }).join('');
  return `<div class="toc"><div class="comp-head"><h3>Inside this report</h3><span>Page · grade</span></div><ol>${items}</ol></div>`;
}

function workoutInner(model, imgs, charts, num) {
  const p = model.score.pillars.workout; const m = p.metrics; const word = model.word;
  const prev = model.prevMetrics('workout');
  const kpis = [
    { label: 'Workout score', value: p.score, unit: '/100', grade: p.grade, delta: deltaPts(p, word) },
    { label: 'Sessions done', value: m.completed, unit: `/${m.planned}`, grade: pctGrade(m.completionPct), delta: deltaCount(m.completed, prev && prev.completed, word, '', true) },
    { label: 'Volume', value: fmtInt(m.volumeKg), unit: 'kg', grade: undefined, delta: m.volumeDeltaPct == null ? delta('flat', 'No previous volume', null) : delta(m.volumeDeltaPct > 0 ? 'up' : m.volumeDeltaPct < 0 ? 'down' : 'flat', `${m.volumeDeltaPct > 0 ? '+' : m.volumeDeltaPct < 0 ? '−' : '±'}${Math.abs(Math.round(m.volumeDeltaPct))}% vs last ${word}`, m.volumeDeltaPct === 0 ? null : m.volumeDeltaPct > 0) },
    { label: 'Avg effort (RPE)', value: m.avgRpe == null ? '—' : fmt1(m.avgRpe), unit: m.avgRpe == null ? '' : '/10', grade: m.avgRpe == null ? null : (m.avgRpe >= 7 && m.avgRpe <= 9 ? 'A' : 'C'), delta: m.avgRpe == null ? delta('flat', 'Log session intensity', null) : delta('flat', 'Target band 7–9', null) }
  ];
  return `<main class="pb">
    ${sectionHead(num, 'Training', 'Workout', p, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    <div class="grid2" data-row>${chartCard(charts.planned, imgs)}${chartCard(charts.muscle, imgs)}</div>
    ${chartCard(charts.volume, imgs, { row: true })}
    ${callouts([model.insights.pillars.workout])}
  </main>`;
}

function nutritionInner(model, imgs, charts, num) {
  const p = model.score.pillars.nutrition; const m = p.metrics; const word = model.word;
  const prev = model.prevMetrics('nutrition');
  const calDelta = m.avgCalories != null && m.calorieTarget
    ? delta('flat', `Target ${fmtInt(m.calorieTarget)} kcal`, null)
    : deltaCount(m.avgCalories, prev && prev.avgCalories, word, '', null);
  const kpis = [
    { label: 'Nutrition score', value: p.score, unit: '/100', grade: p.grade, delta: deltaPts(p, word) },
    { label: 'Meals logged', value: m.mealsLogged, unit: `/${m.mealsExpected}`, grade: pctGrade(m.adherencePct), delta: deltaCount(m.mealsLogged, prev && prev.mealsLogged, word, '', true) },
    { label: 'Avg calories', value: m.avgCalories == null ? '—' : fmtInt(m.avgCalories), unit: m.avgCalories == null ? '' : 'kcal', grade: m.calorieTarget && m.calorieHitDays != null ? pctGrade((m.calorieHitDays / model.periodDays) * 100) : undefined, delta: calDelta },
    { label: 'Avg protein', value: m.avgProtein == null ? '—' : fmtInt(m.avgProtein), unit: m.avgProtein == null ? '' : 'g', grade: m.proteinTarget && m.proteinHitDays != null ? pctGrade((m.proteinHitDays / model.periodDays) * 100) : undefined, delta: m.proteinTarget ? delta('flat', `Target ${fmtInt(m.proteinTarget)} g`, null) : deltaCount(m.avgProtein, prev && prev.avgProtein, word, ' g', true) }
  ];
  return `<main class="pb">
    ${sectionHead(num, 'Fuel', 'Nutrition', p, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    ${chartCard(charts.calories, imgs, { row: true })}
    <div class="grid2" data-row>${chartCard(charts.macros, imgs)}${chartCard(charts.adherence, imgs)}</div>
    ${callouts([model.insights.pillars.nutrition])}
  </main>`;
}

function heatmapHtml(cells, weekly, hMm) {
  if (weekly) {
    const cols = cells.map((c) => `<div class="heat-dow">${esc(CH.dayLabel(c.date))}</div>`).join('');
    const boxes = cells.map((c) => `<div class="heat-cell lv${c.level}" style="height:${hMm}mm">${c.perfect ? '<i class="star"></i>' : ''}${c.freeze ? '<i class="frz"></i>' : ''}</div>`).join('');
    return `<div class="heat" style="grid-template-columns:repeat(7,1fr)">${cols}${boxes}</div>`;
  }
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const head = DOW.map((d) => `<div class="heat-dow">${d}</div>`).join('');
  const lead = cells.length ? (cells[0].dow + 6) % 7 : 0;
  const rows = Math.ceil((lead + cells.length) / 7);
  const cellH = Math.max(4, Math.min(11, (hMm - 4.5 - rows * 1.2) / rows));
  let body = '';
  for (let i = 0; i < lead; i += 1) body += `<div class="heat-cell off" style="height:${cellH}mm"></div>`;
  body += cells.map((c) => `<div class="heat-cell lv${c.level}" style="height:${cellH.toFixed(2)}mm">${c.day}${c.perfect ? '<i class="star"></i>' : ''}${c.freeze ? '<i class="frz"></i>' : ''}</div>`).join('');
  return `<div class="heat" style="grid-template-columns:repeat(7,1fr)">${head}${body}</div>`;
}

function heatCard(model, cells, hMm, weekly, slot) {
  const m = model.score.pillars.consistency.metrics;
  const legend = `<div class="heat-legend"><span>Less</span><i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><span>More</span><span class="sp"></span><span class="star-key"></span><span>Perfect day</span></div>`;
  const any = cells.some((c) => c.level > 0);
  const inner = any
    ? `<div class="heat-wrap" ${slotAttrs(slot, hMm)}>${heatmapHtml(cells, weekly, weekly ? hMm - 5 : hMm)}</div>`
    : `<div class="empty" ${slotAttrs(slot, hMm)}>${ICON.empty}<p>No check-ins logged this period — logging is the fastest way to raise your score</p></div>`;
  return `<figure class="card chart"><figcaption class="c-title" data-fit>Daily activity calendar</figcaption>${inner}${legend}<p class="c-cap one" data-fit-lines="1">${esc(`Active ${m.activeDays} of ${model.periodDays} days · longest streak ${m.longestStreak} · ${m.perfectDays} perfect ${m.perfectDays === 1 ? 'day' : 'days'}.`)}</p></figure>`;
}

/** Two stacked panels (small multiples) share one card: sleep, then energy/recovery. */
function sleepCard(sp, imgs) {
  if (sp.empty) return chartCard({ title: sp.title, empty: true, emptyText: sp.emptyText, caption: sp.caption, slot: 'checkin-sleepcard', h: sp.emptyH }, imgs);
  const panels = sp.panels.map((p) => {
    const body = p.empty
      ? `<div class="empty" ${slotAttrs('checkin-panels', sp.panelH, 2)}><p>${esc(p.emptyText)}</p></div>`
      : `<img class="c-img" ${slotAttrs('checkin-panels', sp.panelH, 2)} src="${imgs[p.spec.id] || ''}" alt="${esc(p.label)}">`;
    return `<div class="c-sub" data-fit>${esc(p.label)}</div>${body}`;
  }).join('');
  return `<figure class="card chart"><figcaption class="c-title" data-fit>${esc(sp.title)}</figcaption><div class="panel-stack">${panels}</div><p class="c-cap" data-fit-lines="2">${esc(sp.caption)}</p></figure>`;
}

function checkinInner(model, imgs, charts, num) {
  const P = model.score.pillars; const word = model.word;
  const cm = P.checkin.metrics; const prev = model.prevMetrics('checkin');
  const weekly = model.type === 'weekly';
  const k4 = weekly
    ? { label: 'Yoga sessions', value: P.yoga.metrics.sessions, unit: `/${P.yoga.metrics.planned}`, grade: P.yoga.grade, delta: deltaCount(P.yoga.metrics.sessions, model.prevMetrics('yoga') && model.prevMetrics('yoga').sessions, word, '', true) }
    : { label: 'Avg steps', value: cm.avgSteps == null ? '—' : fmtInt(cm.avgSteps), unit: '', grade: pctGrade((cm.stepsOkDays / model.periodDays) * 100), delta: deltaCount(cm.avgSteps, prev && prev.avgSteps, word, '', true) };
  const kpis = [
    { label: 'Check-in score', value: P.checkin.score, unit: '/100', grade: P.checkin.grade, delta: deltaPts(P.checkin, word) },
    { label: 'Consistency', value: P.consistency.score, unit: '/100', grade: P.consistency.grade, delta: deltaPts(P.consistency, word) },
    { label: 'Avg sleep', value: cm.avgSleepH == null ? '—' : fmt1(cm.avgSleepH), unit: cm.avgSleepH == null ? '' : 'h', grade: pctGrade((cm.sleepOkDays / model.periodDays) * 100), delta: deltaCount(cm.avgSleepH, prev && prev.avgSleepH, word, ' h', true) },
    k4
  ];
  const rows = [
    Object.assign({ tag: 'Check-in' }, model.insights.pillars.checkin),
    Object.assign({ tag: 'Consistency' }, model.insights.pillars.consistency)
  ];
  if (weekly) {
    rows.push(Object.assign({ tag: 'Yoga' }, model.insights.pillars.yoga));
    return `<main class="pb">
      ${sectionHead(num, 'Habits · Recovery', 'Check-in, Consistency & Yoga', P.checkin, word)}
      <div class="kpis">${kpis.map(kpiTile).join('')}</div>
      ${heatCard(model, charts.heat, 17, true, null)}
      <div class="grid2" data-row>${sleepCard(charts.sleep, imgs)}${chartCard(charts.steps, imgs)}</div>
      <div class="grid2" data-row>${chartCard(charts.yogaMinutes, imgs)}${chartCard(charts.mobility, imgs)}</div>
      ${callouts(rows)}
    </main>`;
  }
  return `<main class="pb">
    ${sectionHead(num, 'Habits', 'Check-in & Consistency', P.checkin, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    <div class="grid2" data-row>${heatCard(model, charts.heat, charts.heatH, false, 'heat')}${sleepCard(charts.sleep, imgs)}</div>
    ${chartCard(charts.steps, imgs, { row: true })}
    ${callouts(rows)}
  </main>`;
}

function yogaInner(model, imgs, charts, num) {
  const p = model.score.pillars.yoga; const m = p.metrics; const word = model.word;
  const prev = model.prevMetrics('yoga'); const cm = model.score.pillars.checkin.metrics;
  const kpis = [
    { label: 'Yoga score', value: p.score, unit: '/100', grade: p.grade, delta: deltaPts(p, word) },
    { label: 'Sessions', value: m.sessions, unit: `/${m.planned}`, grade: pctGrade((m.sessions / Math.max(1, m.planned)) * 100), delta: deltaCount(m.sessions, prev && prev.sessions, word, '', true) },
    { label: 'Minutes', value: fmtInt(m.minutes), unit: 'min', grade: undefined, delta: deltaCount(m.minutes, prev && prev.minutes, word, ' min', true) },
    { label: 'Avg mobility', value: m.avgMobility == null ? '—' : fmt1(m.avgMobility), unit: '', grade: undefined, delta: m.mobilityDeltaPct == null ? delta('flat', m.avgMobility == null ? 'Not recorded yet' : 'No previous score', null) : delta(m.mobilityDeltaPct > 0 ? 'up' : m.mobilityDeltaPct < 0 ? 'down' : 'flat', `${m.mobilityDeltaPct > 0 ? '+' : '−'}${Math.abs(Math.round(m.mobilityDeltaPct))}% vs last ${word}`, m.mobilityDeltaPct > 0) }
  ];
  void cm;
  return `<main class="pb">
    ${sectionHead(num, 'Mobility · Recovery', 'Yoga & Recovery', p, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    ${chartCard(charts.yogaMinutes, imgs, { row: true })}
    <div class="grid2" data-row>${chartCard(charts.mobility, imgs)}${chartCard(charts.sleepTrend, imgs)}</div>
    ${callouts([model.insights.pillars.yoga])}
  </main>`;
}

function photosCard(model, photos, hMm) {
  const list = (model.photoPair || []).filter((p) => photos[p.id]);
  if (list.length < 1) {
    return chartCard({ title: 'Progress photos', empty: true, emptyText: 'No progress photos shared this period — add front and side photos in Body Snapshots', caption: 'Photos appear here when you share them with your coach.', slot: 'body-photos', h: hMm }, {});
  }
  const items = list.map((p) => `<div class="photo"><img ${slotAttrs('body-photos', hMm - 4)} src="${photos[p.id]}" alt=""><span>${esc(p.label)}</span></div>`).join('');
  return `<figure class="card chart"><figcaption class="c-title" data-fit>Progress photos</figcaption><div class="photos" style="grid-template-columns:repeat(${list.length},1fr)">${items}</div><p class="c-cap" data-fit-lines="2">${esc(list.length > 1 ? 'Earliest and latest photos shared with your coach in this window.' : 'Latest photo shared with your coach.')}</p></figure>`;
}

function bodyInner(model, imgs, photos, charts, num) {
  const p = model.score.pillars.health; const m = p.metrics; const word = model.word;
  const b = m.body;
  const goal = model.goalWeight;
  const latest = model.latestWeight;
  const toGoal = goal != null && latest != null ? Math.round((latest - goal) * 10) / 10 : null;
  const waist = b && b.waistChangeCm != null ? b.waistChangeCm : null;
  const dirGood = (d) => {
    if (d == null || d === 0 || !b) return null;
    if (b.direction === 'lose') return d < 0;
    if (b.direction === 'gain') return d > 0;
    return null;
  };
  const kpis = [
    { label: 'Health score', value: p.score == null ? '—' : p.score, unit: p.score == null ? '' : '/100', grade: p.score == null ? null : p.grade, delta: p.counted ? deltaPts(p, word) : delta('flat', `Not counted this ${word}`, null) },
    { label: 'Latest weight', value: latest == null ? '—' : fmt1(latest), unit: latest == null ? '' : 'kg', grade: undefined, delta: b ? delta(b.changeKg > 0 ? 'up' : b.changeKg < 0 ? 'down' : 'flat', `${b.changeKg > 0 ? '+' : b.changeKg < 0 ? '−' : '±'}${fmt1(Math.abs(b.changeKg))} kg this ${word}`, dirGood(b.changeKg)) : delta('flat', 'Needs two weigh-ins', null) },
    { label: 'To goal', value: toGoal == null ? '—' : fmt1(Math.abs(toGoal)), unit: toGoal == null ? '' : 'kg', grade: undefined, delta: goal != null ? delta('flat', `Goal ${fmt1(goal)} kg`, null) : delta('flat', 'No goal weight set', null) },
    { label: 'Waist change', value: waist == null ? '—' : `${waist > 0 ? '+' : ''}${fmt1(waist)}`, unit: waist == null ? '' : 'cm', grade: undefined, delta: waist == null ? delta('flat', 'Measure waist weekly', null) : delta(waist > 0 ? 'up' : waist < 0 ? 'down' : 'flat', 'vs previous measurement', waist === 0 ? null : waist < 0) }
  ];
  const ins = model.insights.pillars.health;
  return `<main class="pb">
    ${sectionHead(num, 'Composition', 'Body & Progress', p.score == null ? null : p, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    ${chartCard(charts.weight, imgs, { row: true })}
    <div class="grid2" data-row>${chartCard(charts.measure, imgs)}${photosCard(model, photos, charts.photosH)}</div>
    ${callouts([ins])}
  </main>`;
}

function bloodInner(model, imgs, charts, num) {
  const bl = model.insights.blood; const word = model.word;
  const hm = model.score.pillars.health.metrics;
  if (!bl.available) {
    const kpis = [
      { label: 'Reports on file', value: 0, unit: '', grade: undefined, delta: delta('flat', 'Upload in Blood Reports', null) },
      { label: 'Markers tracked', value: '—', unit: '', grade: undefined, delta: delta('flat', 'No data yet', null) },
      { label: 'In range', value: '—', unit: '', grade: undefined, delta: delta('flat', 'No data yet', null) },
      { label: 'Flagged', value: '—', unit: '', grade: undefined, delta: delta('flat', 'No data yet', null) }
    ];
    return `<main class="pb">
      ${sectionHead(num, 'Biomarkers', 'Blood Reports', null, word)}
      <div class="kpis">${kpis.map(kpiTile).join('')}</div>
      ${chartCard({ title: 'Key markers over time', empty: true, emptyText: 'No blood reports uploaded yet — upload your latest lab report so markers can be tracked against your habits', caption: 'Markers appear here after your first blood report is analysed.', slot: 'blood-empty', h: charts.bloodEmptyH }, {}, { row: true })}
      ${callouts([{ insight: 'No blood work on file yet, so this section cannot show marker trends.', action: 'Upload your most recent blood test in the Blood Reports tab — a photo or PDF is enough.' }])}
    </main>`;
  }
  const inRange = model.score.detail.markers.filter((m) => m.inRange === true).length;
  const tracked = model.score.detail.markers.length;
  const kpis = [
    { label: 'Markers tracked', value: tracked, unit: '', grade: undefined, delta: delta('flat', `${bl.reportsCount} ${bl.reportsCount === 1 ? 'report' : 'reports'} on file`, null) },
    { label: 'In range', value: inRange, unit: `/${tracked}`, grade: pctGrade(tracked ? (inRange / tracked) * 100 : null), delta: delta('flat', `Latest ${CH.shortDate(bl.latestDate)} ${bl.latestDate.slice(0, 4)}`, null) },
    { label: 'Moved toward range', value: bl.improvedCount, unit: '', grade: undefined, delta: bl.improvedCount ? delta('up', 'since previous test', true) : delta('flat', 'since previous test', null) },
    { label: 'Flagged', value: bl.flagged.length, unit: '', grade: undefined, delta: bl.flagged.length ? delta('down', 'Discuss with your doctor', false) : delta('flat', 'None out of range', null) }
  ];
  const markers = (charts.markers || []);
  const cols = Math.max(1, markers.length);
  const markerCards = markers.length
    ? `<div class="grid4" data-row style="grid-template-columns:repeat(${cols},1fr)">${markers.map((c) => `<figure class="card chart"><figcaption class="c-title" data-fit>${esc(c.title)}</figcaption><img class="c-img" ${slotAttrs(c.slot, c.h)} src="${imgs[c.spec.id] || ''}" alt=""><p class="c-cap one${c.flagged ? ' c-flag' : ''}" data-fit-lines="1">${esc(c.caption)}</p></figure>`).join('')}</div>`
    : chartCard({ title: 'Key markers over time', empty: true, emptyText: 'Only one blood report so far — marker trends appear after your next test', caption: '', slot: 'blood-marker-0', h: charts.markerH }, {}, { oneLine: true, row: true });
  const fmtRange = (r) => (r.low != null && r.high != null ? `${r.low}–${r.high}` : r.low != null ? `≥ ${r.low}` : r.high != null ? `≤ ${r.high}` : '—');
  const STATUS = { in: 'In range', low: 'Below range', high: 'Above range', unknown: 'No range' };
  const MOVE = { improved: 'Toward range', worsened: 'Moved away', rose: 'Rose', fell: 'Fell', flat: 'Steady' };
  const rows = bl.rows.slice(0, 8).map((r) => `<tr>
    <td data-fit><span class="dot ${r.light}"></span>${esc(r.name)}</td>
    <td class="num" data-fit>${esc(r.value == null ? '—' : r.value)} ${esc(r.unit || '')}</td>
    <td class="num" data-fit>${esc(r.previous == null ? '—' : r.previous)}</td>
    <td class="num" data-fit>${esc(fmtRange(r))}</td>
    <td data-fit>${esc(r.previous == null ? 'First test' : (MOVE[r.movement] || '—'))}</td>
    <td data-fit>${r.doctor ? '<span class="doc">Discuss with your doctor</span>' : esc(STATUS[r.status] || '—')}</td>
  </tr>`).join('');
  const hidden = Math.max(0, tracked - Math.min(8, bl.rows.length));
  const table = `<figure class="card chart"><figcaption class="c-title">Marker status (latest report)</figcaption>
    <table class="tl"><colgroup><col style="width:27%"><col style="width:15%"><col style="width:10%"><col style="width:12%"><col style="width:12%"><col style="width:24%"></colgroup>
    <thead><tr><th>Marker</th><th>Latest</th><th>Previous</th><th>Range</th><th>Trend</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="tl-note">${hidden ? `${hidden} more ${hidden === 1 ? 'marker is' : 'markers are'} in your full blood report. ` : ''}Green = in range · Amber = moved away from range · Red = out of range · Grey = no reference range.</p></figure>`;
  const info = `<div class="info">
    <h3>How your habits connect</h3>
    <p>${esc(bl.behaviourLink)}</p>
    ${bl.aiSummary ? `<p class="ai">From your blood report analysis: ${esc(bl.aiSummary)}</p>` : ''}
    ${bl.flagged.length ? `<span class="doctor-flag">Discuss with your doctor: ${esc(bl.flagged.slice(0, 4).join(', '))}${bl.flagged.length > 4 ? ` +${bl.flagged.length - 4} more` : ''}</span>` : ''}
  </div>`;
  const ins = {
    insight: hm.bloodEligible ? `${hm.bloodGood} of ${hm.bloodEligible} markers you have tested twice improved or sit in range.` : `Your first tracked blood report is from ${CH.shortDate(bl.latestDate)} ${bl.latestDate.slice(0, 4)}; trends appear after the next test.`,
    action: bl.flagged.length ? 'Book a follow-up with your doctor for the flagged markers and keep your habits steady until then.' : 'Plan a repeat test in 3–6 months to confirm the trend.'
  };
  return `<main class="pb">
    ${sectionHead(num, 'Biomarkers', 'Blood Reports', null, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    ${markerCards}
    ${table}
    ${info}
    ${callouts([ins])}
  </main>`;
}

function achievementsInner(model, num) {
  const s = model.score; const word = model.word;
  const cm = s.pillars.consistency.metrics;
  const ach = (model.achievements || []).slice(0, 6);
  const achHtml = ach.length
    ? `<div class="ach">${ach.map((a) => `<div class="ach-item"><div class="ach-icon">${ICON[a.icon] || ICON.star}</div><div><div class="ach-title" data-fit-lines="2">${esc(a.title)}</div><div class="ach-sub">${esc(a.sub)}</div></div></div>`).join('')}</div>`
    : `<div class="empty" style="height:17mm" data-h="17">${ICON.empty}<p>No achievements unlocked this period — log daily and they will start stacking up</p></div>`;
  const mv = (list, title, up) => `<div class="mv"><h3>${delta(up ? 'up' : 'down', '', up)}${esc(title)}</h3><ol>${list.slice(0, 3).map((x, i) => `<li><span class="n">${i + 1}</span><div><div class="t" data-fit>${esc(x.title)}</div><div class="d" data-fit>${esc(x.detail)}</div></div>${badge(x.grade)}</li>`).join('') || '<li><span class="n">–</span><div class="d">Not enough data yet</div><span></span></li>'}</ol></div>`;
  const targets = (model.insights.targets || []).slice(0, 3).map((t, i) => `<div class="target"><div class="k">Target ${i + 1}</div><p>${esc(t)}</p></div>`).join('');
  const kpis = [
    { label: 'BodyBank Score', value: s.total, unit: '/100', grade: s.grade, delta: s.totalDelta == null ? delta('flat', 'First report', null) : delta(s.totalDelta > 0 ? 'up' : s.totalDelta < 0 ? 'down' : 'flat', `${s.totalDelta > 0 ? '+' : s.totalDelta < 0 ? '−' : '±'}${Math.abs(s.totalDelta)} pts vs last ${word}`, s.totalDelta === 0 ? null : s.totalDelta > 0) },
    { label: 'Active days', value: cm.activeDays, unit: `/${model.periodDays}`, grade: pctGrade((cm.activeDays / model.periodDays) * 100), delta: deltaCount(cm.activeDays, model.prevMetrics('consistency') && model.prevMetrics('consistency').activeDays, word, '', true) },
    { label: 'Longest streak', value: cm.longestStreak, unit: cm.longestStreak === 1 ? 'day' : 'days', grade: undefined, delta: deltaCount(cm.longestStreak, model.prevMetrics('consistency') && model.prevMetrics('consistency').longestStreak, word, '', true) },
    { label: 'Perfect days', value: cm.perfectDays, unit: '', grade: undefined, delta: deltaCount(cm.perfectDays, model.prevMetrics('consistency') && model.prevMetrics('consistency').perfectDays, word, '', true) }
  ];
  const first = model.insights.toImprove[0];
  const ins = {
    insight: s.totalDelta == null
      ? `Your first BodyBank Score is ${s.total} (${s.grade}) — every future ${word} is measured against it.`
      : `Your score moved ${s.totalDelta >= 0 ? 'up' : 'down'} ${Math.abs(s.totalDelta)} points to ${s.total} (${s.grade}) this ${word}.`,
    action: first ? `Start with ${first.label.toLowerCase()} — the three targets above are your plan for next ${word}.` : `Keep doing what worked — the three targets above are your plan for next ${word}.`
  };
  return `<main class="pb">
    ${sectionHead(num, 'Wins · Plan', 'Achievements & Next Plan', null, word)}
    <div class="kpis">${kpis.map(kpiTile).join('')}</div>
    ${achHtml}
    <div class="movers">${mv(model.insights.improvements, 'Top 3 improvements', true)}${mv(model.insights.toImprove, 'Top 3 to improve', false)}</div>
    <div class="targets">${targets}</div>
    <div class="note"><div class="co-label">A note from your coach</div><p>${esc(model.insights.closingNote)}</p><div class="sig">— ${esc(model.coachName)}, BodyBank</div></div>
    ${callouts([ins])}
  </main>`;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * @param {object} model built by reportService.buildModel()
 */
function buildDocument(model, grow) {
  const score = model.score; const bundle = model.bundle;
  const weekly = model.type === 'weekly';
  const g = grow || {};
  const px = CH.px;
  const specs = [];
  const r2 = (v) => Math.round(v * 100) / 100;
  /** Slot height in mm: the base below plus whatever the layout probe granted. */
  const H = (slot, base) => r2(base + (g[slot] || 0));
  /** Build one chart at its slot's final size and remember slot + height on it. */
  const mk = (slot, base, wMm, fn) => {
    const h = H(slot, base);
    const c = fn(px(wMm), px(h));
    c.slot = slot; c.h = h;
    if (!c.empty && c.spec) specs.push(c.spec);
    return c;
  };

  // Cover gauges
  specs.push(CH.gaugeSpec('g-total', score.total, score.grade, 66, '82%'));
  for (const k of S.PILLARS) specs.push(CH.gaugeSpec('g-' + k, score.pillars[k].score || 0, score.pillars[k].grade, 17, '76%'));

  const charts = {};
  charts.planned = mk('workout-planned', 58, W.half, (w, h) => CH.plannedVsCompleted(bundle, score, w, h));
  charts.muscle = mk('workout-muscle', 58, W.half, (w, h) => CH.volumeByMuscle(bundle, score, w, h));
  charts.volume = mk('workout-volume', 52, W.full, (w, h) => CH.weeklyVolumeTrend(bundle, score, w, h));
  charts.calories = mk('nutrition-calories', 56, W.full, (w, h) => CH.caloriesLine(bundle, score, w, h));
  charts.macros = mk('nutrition-macros', 60, W.half, (w, h) => CH.macroBars(bundle, score, w, h));
  charts.adherence = mk('nutrition-adherence', 60, W.half, (w, h) => CH.adherenceDonut(score, w, h));
  charts.heat = CH.heatmapCells(bundle, score);
  const panelBase = weekly ? 16 : 27.5;
  const panelH = H('checkin-panels', panelBase);
  charts.sleep = CH.sleepPanels(bundle, score, px(W.half), px(panelH));
  charts.sleep.panelH = panelH;
  charts.sleep.emptyH = H('checkin-sleepcard', panelBase * 2 + 7);
  (charts.sleep.panels || []).forEach((p) => { if (!p.empty && p.spec) specs.push(p.spec); });
  if (weekly) {
    charts.steps = mk('checkin-steps', 39, W.half, (w, h) => CH.stepsBar(bundle, score, w, h));
    charts.yogaMinutes = mk('yoga-minutes', 27, W.half, (w, h) => CH.yogaMinutes(bundle, score, w, h));
    charts.mobility = mk('yoga-mobility', 27, W.half, (w, h) => CH.mobilityLine(bundle, score, w, h));
  } else {
    charts.heatH = H('heat', 59);
    charts.steps = mk('checkin-steps', 50, W.full, (w, h) => CH.stepsBar(bundle, score, w, h));
    charts.yogaMinutes = mk('yoga-minutes', 54, W.full, (w, h) => CH.yogaMinutes(bundle, score, w, h));
    charts.mobility = mk('yoga-mobility', 54, W.half, (w, h) => CH.mobilityLine(bundle, score, w, h));
    charts.sleepTrend = mk('yoga-sleeptrend', 54, W.half, (w, h) => CH.sleepTrend(bundle, score, w, h));
  }

  // Sections present
  const hm = score.pillars.health.metrics;
  const includeBody = !weekly || hm.newBodyData;
  const includeBlood = !weekly || hm.newBloodData;
  if (includeBody) {
    charts.weight = mk('body-weight', 60, W.full, (w, h) => CH.weightLine(bundle, score, w, h));
    charts.measure = mk('body-measure', 56, W.half, (w, h) => CH.measurementDeltas(bundle, score, w, h));
    charts.photosH = H('body-photos', 56);
  }
  if (includeBlood) {
    const n = (model.insights.blood.keyMarkers || []).length;
    const cardW = n <= 1 ? W.full : ((186 - 3 * (n - 1)) / n) - 7;
    charts.markerH = H('blood-marker-0', 24);
    charts.bloodEmptyH = H('blood-empty', 60);
    charts.markers = CH.markerCharts(model.insights.blood, px(cardW), px(charts.markerH));
    charts.markers.forEach((c, i) => { c.slot = 'blood-marker-' + i; c.h = charts.markerH; specs.push(c.spec); });
  }

  const sections = ['cover', 'workout', 'nutrition', 'checkin'];
  if (!weekly) sections.push('yoga');
  if (includeBody) sections.push('body');
  if (includeBlood) sections.push('blood');
  sections.push('achievements');

  const photoReq = (model.photoPair || []).map((p) => ({ id: p.id, src: p.src, maxW: 700, maxH: 900 }));

  function render(out) {
    const imgs = (out && out.images) || {};
    const photos = (out && out.photos) || {};
    const total = sections.length;
    const pages = sections.map((key, i) => {
      const n = i + 1;
      let inner;
      switch (key) {
        case 'cover': inner = coverInner(model, imgs, sections); break;
        case 'workout': inner = workoutInner(model, imgs, charts, n); break;
        case 'nutrition': inner = nutritionInner(model, imgs, charts, n); break;
        case 'checkin': inner = checkinInner(model, imgs, charts, n); break;
        case 'yoga': inner = yogaInner(model, imgs, charts, n); break;
        case 'body': inner = bodyInner(model, imgs, photos, charts, n); break;
        case 'blood': inner = bloodInner(model, imgs, charts, n); break;
        default: inner = achievementsInner(model, n);
      }
      return pageShell(model, key, inner, n, total);
    }).join('\n');
    const a = assets();
    return a.shell
      .replace('{{TITLE}}', esc(`${model.titleShort} — ${model.client.name} — ${model.periodLabel}`))
      .replace('{{FONTS}}', () => a.fonts)
      .replace('{{CSS}}', () => a.css)
      .replace('{{BODY_CLASS}}', 'report report--' + model.type)
      .replace('{{PAGES}}', () => pages);
  }

  return { specs, photos: photoReq, sections, render };
}

module.exports = { buildDocument, esc, assets };
