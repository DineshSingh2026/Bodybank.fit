'use strict';

/**
 * Signature reports — A4 HTML. PURE: render(model, narrative, opts) -> html.
 *
 * Weekly (3 pages):  Your week, decoded · What moved your score · Next week
 * Monthly (6 pages): Cover · Since day one · The month in motion ·
 *                    Body, fuel & recovery · What your data says · Next month
 *
 * Charts are inline SVG drawn here (no Chart.js pass): vector-sharp in print,
 * and their numbers stay in the PDF text layer. Every dynamic string goes
 * through esc(). Text that could run long is clipped in the model AND marked
 * [data-fit] / [data-fit-lines] so the fit pass in services/reportPdf.js can
 * shrink it; chart boxes carry data-h so an overfull page steps them down.
 */

const fs = require('fs');
const path = require('path');
const S = require('../reportScore');

const TPL = path.join(__dirname, '..', '..', 'templates');
let cache = null;
function assets() {
  if (cache) return cache;
  const classic = require('../reportTemplate').assets();
  cache = {
    css: fs.readFileSync(path.join(TPL, 'signature-report.css'), 'utf8'),
    fonts: classic.fonts,
    logo: classic.logo
  };
  return cache;
}

const C = { gold: '#a8842f', goldHi: '#d6b25e', cmp: '#3f6fb0', grid: '#ece6d8', muted: '#8a8273', text2: '#4f493e', ink: '#17140f', good: '#1d7f48', track: '#efeadf', nightTrack: '#2e2920', surface: '#ffffff' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtInt(n) { return n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-IN'); }
function fmt1(n) { return n == null || !isFinite(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
function sign(n, unit) { if (n == null) return ''; const r = Math.round(n * 10) / 10; return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${fmt1(Math.abs(r))}${unit || ''}`; }
function gradeClass(g) {
  if (g === 'A+' || g === 'A') return 'g-good';
  if (g === 'B' || g === 'C') return 'g-warn';
  if (g === 'D' || g === 'E') return 'g-flag';
  return 'g-none';
}
function chip(g) { return `<span class="chip ${gradeClass(g)}">${esc(g || '—')}</span>`; }
function deltaTxt(d, word, unit) {
  if (d == null) return `<span class="delta flat">First ${esc(word)}</span>`;
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return `<span class="delta ${cls}">${esc(sign(d, unit == null ? ' pts' : unit))}</span>`;
}
function prevName(m) {
  if (m.type !== 'monthly') return 'last week';
  const d = new Date(S.dayNum(m.period.start) * 86400000);
  return MON[(d.getUTCMonth() + 11) % 12];
}
function shortDate(iso) { const d = new Date(S.dayNum(iso) * 86400000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }
function gradeColor(g) { return g === 'A+' || g === 'A' ? '#3fbf7a' : (g === 'B' || g === 'C' ? C.goldHi : (g === 'D' || g === 'E' ? '#e0705f' : '#8a8273')); }

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="m7.8 12.4 2.9 2.9 5.6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M8 12h8"/></svg>',
  miss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  manual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 8v5M12 16.5v.5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  mind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20c-4.4 0-8-3.1-8-7 0-2.8 1.8-5.2 4.5-6.3A4 4 0 0 1 16 6.4c2.4 1 4 3.6 4 6.6 0 3.9-3.6 7-8 7Z"/><path d="M9 13h6M12 10v6"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"/></svg>',
  steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 3c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5ZM17 9c2 0 3 2 3 5s-1 5-3 5-3-2-3-5 1-5 3-5ZM5 16h5M15 22h5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-9-1 3-3 4-4 4 0-2-1-4-3-6 0 4-3 6-3 11a7 7 0 0 0 7 7Z"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c9 0 14-5 14-14-9 0-14 5-14 14Z"/><path d="M5 19 13 11"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.5 10h4a1.6 1.6 0 0 1 0 3.2h-3" stroke-linecap="round"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/></svg>'
};
ICON.hit = ICON.check;
const STATUS = { hit: 'Kept', close: 'Close', miss: 'Missed', manual: 'Coach review' };

// ---------------------------------------------------------------------------
// SVG charts (units: mm)
// ---------------------------------------------------------------------------

function ringSvg(value, sizeMm, color, track, stroke) {
  const s = sizeMm; const w = stroke; const r = (s - w) / 2; const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  const arc = v > 0 ? `<circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${(c * v).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${s / 2} ${s / 2})"/>` : '';
  return `<svg viewBox="0 0 ${s} ${s}" aria-hidden="true"><circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${w}"/>${arc}</svg>`;
}

/**
 * Column chart, one series. values: [{ label, v }] (v null = not logged).
 * Value labels sit on the caps when there are few columns; otherwise only the
 * highest and the last are labelled and the target line carries the rest.
 */
function columnsSvg(values, o) {
  const W = o.w; const H = o.h;
  const padT = 3.6; const padB = 4.2; const padL = 1; const padR = o.target != null ? 11 : 1;
  const n = Math.max(1, values.length);
  const vs = values.map((x) => x.v).filter((v) => v != null);
  const max = Math.max(o.target || 0, ...(vs.length ? vs : [1])) * 1.12 || 1;
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const band = plotW / n;
  const bw = Math.min(o.barMax || 6.3, band * 0.66);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const labelAll = n <= 8;
  const iMax = vs.length ? values.findIndex((x) => x.v === Math.max(...vs)) : -1;
  let iLast = -1; for (let i = values.length - 1; i >= 0; i -= 1) if (values[i].v != null) { iLast = i; break; }
  const dec = o.decimals || 0;
  const fmtV = (v) => (dec ? fmt1(v) : fmtInt(v));
  let g = `<line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="${C.grid}" stroke-width=".25"/>`;
  values.forEach((x, i) => {
    const cx = padL + band * i + band / 2;
    if (x.v == null || x.v <= 0) {
      g += `<line x1="${(cx - bw / 2).toFixed(2)}" x2="${(cx + bw / 2).toFixed(2)}" y1="${padT + plotH - 0.5}" y2="${padT + plotH - 0.5}" stroke="#cfc7b6" stroke-width=".5" stroke-linecap="round"/>`;
    } else {
      const top = y(x.v); const h = padT + plotH - top; const r = Math.min(1, bw / 2, h);
      const x0 = cx - bw / 2; const x1 = cx + bw / 2; const yb = padT + plotH;
      const fill = o.okFn ? (o.okFn(x.v) ? C.gold : '#d9c69a') : C.gold;
      g += `<path d="M${x0.toFixed(2)} ${yb} L${x0.toFixed(2)} ${(top + r).toFixed(2)} Q${x0.toFixed(2)} ${top.toFixed(2)} ${(x0 + r).toFixed(2)} ${top.toFixed(2)} L${(x1 - r).toFixed(2)} ${top.toFixed(2)} Q${x1.toFixed(2)} ${top.toFixed(2)} ${x1.toFixed(2)} ${(top + r).toFixed(2)} L${x1.toFixed(2)} ${yb} Z" fill="${fill}"/>`;
      if (labelAll || i === iMax || i === iLast) {
        const lx = Math.min(W - padR - 2, Math.max(padL + 3, cx));
        g += `<text x="${lx.toFixed(2)}" y="${(top - 0.9).toFixed(2)}" text-anchor="middle" font-size="2.3" font-weight="600" fill="${C.ink}">${esc(fmtV(x.v))}</text>`;
      }
    }
    const showX = n <= 10 || i === 0 || i === n - 1 || i % Math.ceil(n / 7) === 0;
    if (showX) g += `<text x="${cx.toFixed(2)}" y="${(H - 0.8).toFixed(2)}" text-anchor="middle" font-size="2.2" fill="${C.muted}">${esc(x.label)}</text>`;
  });
  if (o.target != null && o.target > 0) {
    const ty = y(o.target);
    g += `<line x1="${padL}" x2="${W - padR + 1}" y1="${ty.toFixed(2)}" y2="${ty.toFixed(2)}" stroke="${C.cmp}" stroke-width=".4"/>`;
    g += `<text x="${(W - padR + 1.6).toFixed(2)}" y="${(ty + 0.8).toFixed(2)}" font-size="2.2" font-weight="600" fill="${C.text2}">${esc(o.targetLabel || fmtV(o.target))}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}mm" data-h="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(o.aria || '')}">${g}</svg>`;
}

/** Line chart, one series + optional goal line. points: [{ label, v }] */
function lineSvg(points, o) {
  const W = o.w; const H = o.h;
  const padT = 4; const padB = 4.4; const padL = 8.5; const padR = 12;
  const vs = points.map((p) => p.v).filter((v) => v != null);
  if (!vs.length) return '';
  // Round, evenly spaced ticks (0.5 / 1 / 2 / 5 ...) that bracket the data and the goal.
  const dlo = Math.min(...vs, o.goal != null ? o.goal : Infinity); const dhi = Math.max(...vs, o.goal != null ? o.goal : -Infinity);
  const raw = Math.max(0.5, (dhi - dlo) / 3);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || 10 * mag;
  let lo = Math.floor(dlo / step) * step; let hi = Math.ceil(dhi / step) * step;
  if (hi - lo < step) hi = lo + step;
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const n = points.length;
  const x = (i) => padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  let g = '';
  const ticks = Math.round((hi - lo) / step);
  for (let t = 0; t <= ticks; t += 1) {
    const v = lo + step * t; const yy = y(v);
    g += `<line x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(2)}" y2="${yy.toFixed(2)}" stroke="${C.grid}" stroke-width=".22"/>`;
    g += `<text x="${(padL - 1.2).toFixed(2)}" y="${(yy + 0.8).toFixed(2)}" text-anchor="end" font-size="2.2" fill="${C.muted}">${esc(fmt1(v))}</text>`;
  }
  if (o.goal != null) {
    const gy = y(o.goal);
    g += `<line x1="${padL}" x2="${W - padR}" y1="${gy.toFixed(2)}" y2="${gy.toFixed(2)}" stroke="${C.cmp}" stroke-width=".45"/>`;
    g += `<text x="${(W - padR + 1.2).toFixed(2)}" y="${(gy + 0.8).toFixed(2)}" font-size="2.2" font-weight="600" fill="${C.text2}">${esc(o.goalLabel || 'Goal')}</text>`;
  }
  const pts = points.map((p, i) => (p.v == null ? null : [x(i), y(p.v)])).filter(Boolean);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  if (o.area) {
    const base = padT + plotH;
    g += `<path d="${d} L${pts[pts.length - 1][0].toFixed(2)} ${base} L${pts[0][0].toFixed(2)} ${base} Z" fill="${C.gold}" fill-opacity=".10"/>`;
  }
  g += `<path d="${d}" fill="none" stroke="${C.gold}" stroke-width=".55" stroke-linecap="round" stroke-linejoin="round"/>`;
  const dot = (p, label, anchor) => `<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="1.15" fill="${C.gold}" stroke="${C.surface}" stroke-width=".55"/>`
    + `<text x="${(anchor === 'end' ? p[0] + 1.8 : p[0]).toFixed(2)}" y="${(p[1] - 2).toFixed(2)}" text-anchor="${anchor === 'end' ? 'start' : 'middle'}" font-size="2.4" font-weight="700" fill="${C.ink}">${esc(label)}</text>`;
  if (pts.length > 1) g += `<circle cx="${pts[0][0].toFixed(2)}" cy="${pts[0][1].toFixed(2)}" r="1" fill="${C.surface}" stroke="${C.gold}" stroke-width=".5"/>`;
  g += dot(pts[pts.length - 1], fmt1(vs[vs.length - 1]) + (o.unit || ''), 'end');
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  xl.forEach((i) => { g += `<text x="${x(i).toFixed(2)}" y="${(H - 0.8).toFixed(2)}" text-anchor="middle" font-size="2.2" fill="${C.muted}">${esc(points[i].label)}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}mm" data-h="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(o.aria || '')}">${g}</svg>`;
}

function pairHtml(p) {
  const max = p.max || Math.max(p.a.value || 0, p.b.value || 0) || 1;
  const w = (v) => Math.max(2, Math.min(100, ((v || 0) / max) * 100)).toFixed(1);
  return `<div class="pair">
    <div class="pair-row"><span class="lb fit" data-fit>${esc(p.a.label)}</span><div class="pair-bar"><i class="a" style="width:${w(p.a.value)}%"></i></div><span class="vl">${esc(p.a.display)}</span></div>
    <div class="pair-row"><span class="lb fit" data-fit>${esc(p.b.label)}</span><div class="pair-bar"><i class="b" style="width:${w(p.b.value)}%"></i></div><span class="vl">${esc(p.b.display)}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

function header(m) {
  const a = assets();
  return `<header class="ph">
    <div class="ph-brand">${a.logo ? `<img class="ph-logo" src="${a.logo}" alt="">` : ''}<div><div class="ph-word">BODYBANK</div><div class="ph-sub">${esc(m.title)}</div></div></div>
    <div class="ph-meta"><div class="ph-client fit" data-fit>${esc(m.client.name)}</div><div class="ph-period fit" data-fit>${esc(m.period.label)}</div></div>
  </header>`;
}
function footer(m, n, total) {
  return `<footer class="pf"><span>bodybank.fit</span><span class="pf-mid">Prepared for ${esc(m.client.name)} · Private and confidential</span><span>${n} / ${total}</span></footer>`;
}
function page(m, key, inner, n, total, opts) {
  const o = opts || {};
  return `<section class="page page--${esc(key)}" data-page="${n}">${o.noHeader ? '' : header(m)}${o.before || ''}<main class="pb">${inner}</main>${footer(m, n, total)}</section>`;
}
function sectionHead(eyebrow, title, side) {
  return `<div class="sh"><div><div class="sh-eyebrow">${esc(eyebrow)}</div><h2 class="sh-title fit" data-fit>${esc(title)}</h2></div>${side ? `<div class="sh-side">${side}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------------------
// Blocks shared by both cadences
// ---------------------------------------------------------------------------

function promiseCard(m) {
  const pr = m.promise;
  if (!pr || !pr.items.length) {
    return `<div class="card"><div class="card-h"><div class="card-t">Promise check</div><div class="card-s">Starts next ${esc(m.word)}</div></div>
      <p class="firstnote">This is your first Signature report, so this ${esc(m.word)} sets the baseline. Your three targets are on the last page. Next ${esc(m.word)}'s report opens by checking each one.</p></div>`;
  }
  const rows = pr.items.map((i) => `<div class="pr-row">
      <span class="pr-label fit" data-fit>${esc(i.label)}</span>
      <span class="pr-val">${i.actual == null ? '—' : `${esc(fmtInt(i.actual))} of ${esc(fmtInt(i.goal))} ${esc(i.unit)}`}</span>
      <span class="st ${esc(i.status)}">${ICON[i.status] || ICON.manual}${esc(STATUS[i.status] || '')}</span>
    </div>`).join('');
  return `<div class="card"><div class="card-h"><div class="card-t">Promise check</div><div class="card-s">Your targets from last ${esc(m.word)}</div></div>
    <div class="promise"><div class="pr-rows">${rows}</div>
    <div class="pr-sum"><b>${esc(pr.hit)}<span style="font-size:11pt;color:#8a8273"> / ${esc(pr.of)}</span></b><span>${pr.of ? 'kept' : 'scored by your coach'}${pr.close ? ` · ${esc(pr.close)} close` : ''}</span></div></div></div>`;
}

function pillarsCard(m, title) {
  const rows = m.pillars.map((p) => `<div class="pl">
      <span class="pl-name">${esc(p.label)}</span>
      <div class="pl-track"><div class="pl-fill${p.counted ? '' : ' off'}" style="width:${Math.max(0, Math.min(100, p.score || 0))}%"></div></div>
      <span class="pl-score">${p.score == null ? '—' : esc(p.score)}</span>${chip(p.score == null ? null : p.grade)}
      ${deltaTxt(p.delta, m.word)}
      <span class="pl-w">${p.weight ? `${esc(p.weight)}% weight` : 'not counted'}</span>
    </div>`).join('');
  const note = m.score.healthRedistributed ? `Health is not counted this ${m.word} (no new body or blood data), so its weight moved to workout and nutrition.` : 'Each pillar is scored out of 100 and weighted into your BodyBank Score.';
  return `<div class="card"><div class="card-h"><div class="card-t">${esc(title || 'The six pillars')}</div><div class="card-s">Score · grade · vs last ${esc(m.word)}</div></div>
    <div class="pillars">${rows}</div><p class="c-cap">${esc(note)}</p></div>`;
}

function patternsCard(m, title) {
  const list = m.patterns || [];
  const body = list.length
    ? `<div class="pats">${list.map((p) => `<div class="pat">
        <div class="pat-ico">${ICON[p.icon] || ICON.star}</div>
        <div style="min-width:0"><div class="pat-t fit" data-fit>${esc(p.title)}</div><p class="pat-x clamp3" data-fit-lines="3">${esc(p.text)}</p></div>
        ${pairHtml(p)}
      </div>`).join('')}</div>`
    : `<p class="empty-note">Not enough logged days yet to find your patterns. Every day you log makes this section sharper: sleep, meals, training and mood are compared against each other here.</p>`;
  return `<div class="card"><div class="card-h"><div class="card-t">${esc(title || 'What your data says')}</div><div class="card-s">${m.type === 'weekly' ? 'From your last 4 weeks' : 'From this month'}</div></div>${body}
    ${list.length ? '<p class="c-cap">Patterns compare your own days with each other. They show what tends to go together, not proof of cause.</p>' : ''}</div>`;
}

function kpi(label, value, unit, sub) {
  return `<div class="k"><div class="k-l fit" data-fit>${esc(label)}</div><div class="k-v fit" data-fit>${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="k-d fit" data-fit>${sub || '&nbsp;'}</div></div>`;
}

function dayLabels(m, list) {
  return list.map((x) => {
    const d = new Date(S.dayNum(x.date) * 86400000);
    return m.type === 'weekly' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] : String(d.getUTCDate());
  });
}

function seriesOf(m, list) {
  const labels = dayLabels(m, list);
  return list.map((x, i) => ({ label: labels[i], v: x.v }));
}
function emptyChart(h, text) { return `<p class="empty-note" style="height:${h}mm" data-h="${h}">${esc(text)}</p>`; }
function chartBlock(label, svgOrEmpty) { return `<div class="label cl">${esc(label)}</div>${svgOrEmpty}`; }

function trainingCard(m, chartH) {
  const s = m.stats;
  const vol = s.volumeDeltaPct == null ? 'No previous volume' : `${s.volumeDeltaPct > 0 ? '+' : s.volumeDeltaPct < 0 ? '−' : '±'}${Math.abs(Math.round(s.volumeDeltaPct))}% vs ${prevName(m)}`;
  const prs = (m.prs || []).slice(0, 3);
  const prHtml = prs.length
    ? `<div class="prs">${prs.map((p) => `<div><b class="fit" data-fit>${esc(p.label)}</b><span>${esc(fmt1(p.previousKg))} → <b>${esc(fmt1(p.kg))} kg</b></span></div>`).join('')}</div>`
    : '<p class="c-cap">No new personal bests this time. Add 2.5 kg or one rep to your main lift next session.</p>';
  const yoga = s.yogaPlanned ? `${s.yogaSessions} of ${s.yogaPlanned} yoga` : `${s.yogaSessions} yoga`;
  const vw = (m.volumeWeeks || []);
  const vchart = vw.some((x) => x.v > 0)
    ? columnsSvg(vw.map((x) => ({ label: x.label, v: x.v })), { w: 84, h: chartH, barMax: 8, aria: 'Training volume by week' })
    : emptyChart(chartH, 'Log the weight and reps of your lifts and your weekly volume appears here.');
  return `<div class="card"><div class="card-h"><div class="card-t">Training</div><div class="card-s">${esc(yoga)} · ${esc(fmtInt(s.minutes))} min trained</div></div>
    <div class="kp">${kpi('Sessions', `${s.sessions}`, `/${s.planned}`, s.planned ? `${Math.round((Math.min(s.sessions, s.planned) / s.planned) * 100)}% of plan` : '')}${kpi('Volume', fmtInt(s.volumeKg), 'kg', esc(vol))}${kpi('Avg effort', s.avgRpe == null ? '—' : fmt1(s.avgRpe), s.avgRpe == null ? '' : '/10', s.avgRpe == null ? 'Log session intensity' : 'Target band 7–9')}</div>
    ${chartBlock(m.type === 'monthly' ? 'Volume by week (kg)' : 'Volume, last 6 weeks (kg)', vchart)}
    <div class="label cl">Personal bests</div>${prHtml}</div>`;
}

function fuelCard(m, chartH) {
  const s = m.stats;
  const prot = seriesOf(m, m.proteinDaily);
  const pchart = prot.some((v) => v.v != null)
    ? columnsSvg(prot, { w: 84, h: chartH, target: s.proteinTarget || null, targetLabel: s.proteinTarget ? `${fmtInt(s.proteinTarget)} g` : '', okFn: s.proteinTarget ? (v) => v >= s.proteinTarget * 0.9 : null, aria: 'Daily protein' })
    : emptyChart(chartH, 'No meals logged. Log three meals a day and your protein appears here.');
  const cal = seriesOf(m, m.caloriesDaily);
  const ct = s.calorieTarget;
  const cchart = cal.some((v) => v.v != null)
    ? columnsSvg(cal, { w: 84, h: chartH, target: ct || null, targetLabel: ct ? `${fmtInt(ct)}` : '', okFn: ct ? (v) => Math.abs(v - ct) <= ct * 0.1 : null, aria: 'Daily calories' })
    : emptyChart(chartH, 'Calories appear here once meals are logged.');
  return `<div class="card"><div class="card-h"><div class="card-t">Fuel</div><div class="card-s">${esc(s.mealsLogged)} of ${esc(s.mealsExpected)} meals logged</div></div>
    <div class="kp">${kpi('Avg calories', fmtInt(s.avgCalories), 'kcal', ct ? `${esc(s.calorieHitDays || 0)} days within 10%` : 'No calorie target set')}${kpi('Avg protein', fmtInt(s.avgProtein), 'g', s.proteinTarget ? `Target ${esc(fmtInt(s.proteinTarget))} g` : '')}${kpi('Protein days', s.proteinHitDays == null ? '—' : String(s.proteinHitDays), s.proteinHitDays == null ? '' : `/${m.period.days}`, 'At 90%+ of target')}</div>
    ${chartBlock('Protein by day (g)', pchart)}
    ${chartBlock(ct ? `Calories by day · darker = within 10% of ${fmtInt(ct)}` : 'Calories by day', cchart)}</div>`;
}

function recoveryCard(m, chartH) {
  const s = m.stats;
  const sl = seriesOf(m, m.sleepDaily);
  const schart = sl.some((v) => v.v != null)
    ? columnsSvg(sl, { w: 84, h: chartH, target: 7, targetLabel: '7 h', decimals: 1, okFn: (v) => v >= 7, aria: 'Sleep by night' })
    : emptyChart(chartH, "No sleep logged. Add last night's sleep to your daily check-in, or connect a wearable.");
  const st = seriesOf(m, m.stepsDaily);
  const stchart = st.some((v) => v.v != null)
    ? columnsSvg(st.map((x) => ({ label: x.label, v: x.v })), { w: 84, h: chartH, target: s.stepsTarget, targetLabel: s.stepsTarget >= 1000 ? `${fmt1(s.stepsTarget / 1000)}k` : fmtInt(s.stepsTarget), okFn: (v) => v >= s.stepsTarget, aria: 'Steps by day' })
    : emptyChart(chartH, 'Add your steps to the daily check-in, or connect a wearable.');
  const w = m.wearable;
  const third = w
    ? kpi(w.hrv != null ? 'HRV' : 'Recovery', w.hrv != null ? fmtInt(w.hrv) : fmtInt(w.recovery), w.hrv != null ? 'ms' : '%', w.hrv != null ? (w.hrvDelta == null ? `Resting HR ${w.rhr == null ? '—' : esc(fmtInt(w.rhr))}` : `${esc(sign(w.hrvDelta, ' ms'))} vs ${esc(prevName(m))}`) : (w.recoveryDelta == null ? '' : `${esc(sign(w.recoveryDelta, ''))} vs ${esc(prevName(m))}`))
    : kpi('Avg steps', fmtInt(s.avgSteps), '', `${esc(s.stepsOkDays)} days at target`);
  return `<div class="card"><div class="card-h"><div class="card-t">Recovery</div><div class="card-s">${esc(s.checkinDays)} of ${esc(m.period.days)} days checked in</div></div>
    <div class="kp">${kpi('Avg sleep', fmt1(s.avgSleepH), s.avgSleepH == null ? '' : 'h', `${esc(s.sleepOkDays)} nights of 7 h+`)}${kpi('Water', fmt1(s.avgWaterL), s.avgWaterL == null ? '' : 'L', `Target ${esc(s.waterTargetL)} L`)}${third}</div>
    ${chartBlock('Sleep by night (h)', schart)}
    ${chartBlock('Steps by day', stchart)}</div>`;
}

/** Second chart for the body/mind card: mood if logged, else wearable recovery, else water. */
function mindSeries(m, chartH) {
  const mood = seriesOf(m, m.moodDaily);
  if (mood.filter((v) => v.v != null).length >= 2) {
    return chartBlock('Mood by day (1–5)', columnsSvg(mood, { w: 84, h: chartH, target: 4, targetLabel: 'Good', okFn: (v) => v >= 4, aria: 'Mood by day' }));
  }
  const rec = seriesOf(m, m.recoveryDaily);
  if (rec.filter((v) => v.v != null).length >= 2) {
    return chartBlock('Wearable recovery by day (%)', columnsSvg(rec, { w: 84, h: chartH, target: 67, targetLabel: '67%', okFn: (v) => v >= 67, aria: 'Recovery by day' }));
  }
  const wat = seriesOf(m, m.waterDaily);
  if (wat.some((v) => v.v != null)) {
    return chartBlock('Water by day (L)', columnsSvg(wat, { w: 84, h: chartH, target: m.stats.waterTargetL, targetLabel: `${m.stats.waterTargetL} L`, decimals: 1, okFn: (v) => v >= m.stats.waterTargetL, aria: 'Water by day' }));
  }
  return chartBlock('Mood by day', emptyChart(chartH, 'Log your mood in Mind each day and how you feel is tracked next to how you train.'));
}

function bodyMindCard(m, chartH) {
  const b = m.stats.body; const word = m.word;
  const series = (m.weightRecent || []).map((w) => ({ label: shortDate(w.date), v: w.kg }));
  const chart = series.length >= 2
    ? lineSvg(series, { w: 84, h: chartH, unit: '', goal: null, aria: 'Weekly average weight' })
    : emptyChart(chartH, 'Weigh in twice a week, same time and conditions, and your trend line appears here.');
  const mind = m.mind;
  const k3 = mind
    ? kpi('Mood · stress', `${mind.avgMood == null ? '—' : fmt1(mind.avgMood)} · ${mind.avgStress == null ? '—' : fmt1(mind.avgStress)}`, '/5', `${esc(mind.days)} days logged${mind.sessions ? ` · ${esc(mind.sessions)} sessions` : ''}`)
    : kpi('Mind check-ins', '—', '', 'Log mood daily in Mind');
  const latest = series.length ? series[series.length - 1].v : null;
  return `<div class="card"><div class="card-h"><div class="card-t">Body &amp; mind</div><div class="card-s">Weight is a weekly average</div></div>
    <div class="kp">${kpi('Weight', latest == null ? '—' : fmt1(latest), latest == null ? '' : 'kg', b ? `${esc(sign(b.changeKg, ' kg'))} this ${esc(word)}` : 'Needs two weigh-ins')}${kpi('Waist', b && b.waistChangeCm != null ? sign(b.waistChangeCm, '') : '—', b && b.waistChangeCm != null ? 'cm' : '', b && b.waistChangeCm != null ? 'vs last time' : 'Measure weekly')}${k3}</div>
    ${chartBlock('Weight trend (kg)', chart)}
    ${mindSeries(m, chartH)}</div>`;
}

function planBlocks(m, n) {
  const word = m.word; const nextWord = `next ${word}`;
  const lever = m.lever;
  const leverHtml = lever
    ? `<div class="lever"><div><div class="label">Your one big lever for ${esc(nextWord)}</div><div class="lever-t clamp2" data-fit-lines="2">${esc(lever.label)}</div>
        <p class="lever-x">This ${esc(word)}: ${esc(fmtInt(lever.baseline))} of ${esc(fmtInt(lever.baselineOf))} ${esc(lever.unit)}. Of everything you could change, this moves your score the most.</p></div>
        <div class="lever-pts"><b>+${esc(fmt1(lever.points))}</b><span>points on its own</span></div></div>`
    : `<div class="lever"><div><div class="label">Your plan for ${esc(nextWord)}</div><div class="lever-t">Hold the line</div><p class="lever-x">Every pillar is at or near its maximum. Keep the habits below exactly where they are.</p></div><div class="lever-pts"><b>${esc(m.score.total)}</b><span>to protect</span></div></div>`;
  const tg = m.targets.map((t, i) => `<div class="tg">
      <div class="tg-n">${i + 1}</div>
      <div style="min-width:0"><div class="tg-t clamp2" data-fit-lines="2">${esc(t.label)}</div></div>
      <div class="tg-b">${t.baseline == null ? 'Set by your coach' : `This ${esc(word)}: ${esc(fmtInt(t.baseline))} / ${esc(fmtInt(t.baselineOf))}`}</div>
      <div class="tg-p${t.points ? '' : ' zero'}">${t.points ? `+${esc(fmt1(t.points))} pts` : (t.metric ? 'Keep it' : '—')}</div>
    </div>`).join('');
  const pj = m.projection;
  const proj = `<div class="card"><div class="card-h"><div class="card-t">If you hit all three</div><div class="card-s">Estimate from the score formula</div></div>
    <div class="proj"><div class="proj-bars">
      <div class="proj-row"><span>This ${esc(word)}</span><div class="proj-track"><i style="width:${Math.max(2, pj.now)}%"></i></div><b>${esc(pj.now)}</b></div>
      <div class="proj-row"><span>Projected</span><div class="proj-track"><i class="next" style="width:${Math.max(2, pj.projected)}%"></i></div><b>${esc(pj.projected)}</b></div>
    </div><p class="proj-x clamp4" data-fit-lines="4">${pj.gain > 0 ? `Hitting all three targets is worth about ${esc(fmt1(pj.gain))} points, taking you to ${esc(pj.projected)} (${esc(S.gradeFor(pj.projected))}), if everything else holds steady.` : 'Your targets protect what you have built. Holding them keeps your score where it is.'}</p></div></div>`;
  return `${sectionHead(n, `Next ${word}: the plan`, esc(m.next.label))}
    ${leverHtml}
    <div class="card"><div class="card-h"><div class="card-t">Three targets</div><div class="card-s">Scored at the start of your next report</div></div>${tg}</div>
    ${proj}`;
}

function winsAndLetter(m, narrative, opts) {
  const o = opts || {};
  const ach = (m.achievements || []).slice(0, o.maxWins || 4);
  const wins = ach.length
    ? `<div class="card"><div class="card-h"><div class="card-t">Wins worth naming</div><div class="card-s">This ${esc(m.word)}</div></div><div class="wins">${ach.map((a) => `<div class="win"><div class="win-ico">${ICON[a.icon] || ICON.star}</div><div style="min-width:0"><div class="win-t fit" data-fit>${esc(a.title)}</div><div class="win-s clamp2" data-fit-lines="2">${esc(a.sub)}</div></div></div>`).join('')}</div></div>`
    : '';
  const quote = m.quote && !o.noQuote ? `<div class="quote clamp4" data-fit-lines="4">“${esc(m.quote)}”<span>You, in your Sunday check-in</span></div>` : '';
  const ps = narrative.ps ? `<p class="ps clamp2" data-fit-lines="2"><b>P.S.</b> ${esc(narrative.ps)}</p>` : '';
  const letter = `<div class="letter"><div class="label">From your coach</div><p class="body clamp8" data-fit-lines="8">${esc(narrative.letter)}</p>${ps}<div class="sig">— ${esc(m.coachName)}, your BodyBank coach</div></div>`;
  return { wins, quote, letter };
}

function blueprintCard(m) {
  const bp = m.blueprint;
  if (!bp) return '';
  const cells = bp.days.map((d) => `<div class="bp-d${d.best ? ' best' : ''}${d.watch ? ' watch' : ''}">
      <div class="bp-dow">${esc(d.dow)}</div><div class="bp-plan">${esc(d.plan)}</div>
      <div class="bp-meta">${d.trainPct == null ? '' : (d.plan === 'Yoga' ? `Yoga ${esc(d.yogaPct)}% of weeks` : `Trained ${esc(d.trainPct)}% of weeks`)}</div>
      <div class="bp-tag">${d.best ? 'Strongest' : (d.watch ? 'Plan ahead' : '&nbsp;')}</div></div>`).join('');
  return `<div class="card"><div class="card-h"><div class="card-t">Your week blueprint for ${esc(m.next.label)}</div><div class="card-s">Built from your own month</div></div>
    <div class="bp">${cells}</div>
    <p class="c-cap">Train on the days you already train most; your "plan ahead" day is the one that slipped most often, so prepare meals and kit the night before.</p></div>`;
}

function disclaimer(m) {
  return `<p class="disclaimer push">Your BodyBank Score is calculated the same way every ${esc(m.word)} from what you log, so your trend is always comparable. Grades: A+ 90+, A 80+, B 70+, C 60+, D 50+, E below 50. Projections are estimates. This report is coaching guidance, not medical advice${m.blood && m.blood.flagged.length ? '; please discuss any flagged blood markers with your doctor' : ''}.</p>`;
}

// ---------------------------------------------------------------------------
// Weekly
// ---------------------------------------------------------------------------

function weeklyCover(m, narrative) {
  const a = assets(); const s = m.score;
  const d = s.totalDelta;
  const pill = d == null ? '<span class="pill flat">Your first Signature score</span>'
    : `<span class="pill ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${esc(sign(d, ' pts'))} vs last week (${esc(s.previous.total)})</span>`;
  const chips = [m.client.goalLabel && `Goal: ${m.client.goalLabel}`, m.client.planLabel, `${m.period.days} days`].filter(Boolean);
  const st = m.stats;
  return `<div class="hero">
    <div class="hero-top"><div class="hero-brand">${a.logo ? `<img src="${a.logo}" alt="">` : ''}<div><div class="hero-word">BODYBANK</div><div class="hero-kind">Weekly Signature Report</div></div></div>
      <div class="hero-period"><b class="fit" data-fit>${esc(m.period.label)}</b>Your week, decoded</div></div>
    <div class="hero-main">
      <div class="hero-for">Prepared for</div>
      <div class="hero-name fit" data-fit>${esc(m.client.name)}</div>
      <div class="hero-chips">${chips.map((c) => `<span class="hero-chip">${esc(c)}</span>`).join('')}</div>
      <p class="hero-headline clamp3" data-fit-lines="3">${esc(narrative.headline)}</p>
    </div>
    <div class="hero-stats">
      <div class="hero-stat"><b>${esc(st.activeDays)}<small>/ ${esc(m.period.days)}</small></b><span>Active days</span></div>
      <div class="hero-stat"><b>${esc(st.sessions)}<small>/ ${esc(st.planned)}</small></b><span>Workouts</span></div>
      <div class="hero-stat"><b>${esc(st.longestStreak)}<small>${st.longestStreak === 1 ? 'day' : 'days'}</small></b><span>Best streak</span></div>
      <div class="hero-stat"><b>${esc(st.perfectDays)}</b><span>Perfect days</span></div>
    </div>
    <div class="hero-ring">${ringSvg(s.total, 58, gradeColor(s.grade), C.nightTrack, 4.2)}
      <div class="ring-center"><div class="ring-num">${esc(s.total)}</div><div class="ring-of">BodyBank Score</div><div class="ring-grade">${chip(s.grade)}</div></div></div>
    <div class="hero-delta">${pill}</div>
  </div>`;
}

function matrixCard(m) {
  const cols = m.matrix;
  const cell = (cls, txt) => `<td class="${cls}">${txt}</td>`;
  const row = (label, fn) => `<tr><td class="rl">${esc(label)}</td>${cols.map(fn).join('')}</tr>`;
  const head = `<tr><th class="rl"></th>${cols.map((c) => `<th>${esc(c.dow)} ${esc(c.day)}</th>`).join('')}</tr>`;
  const rows = [
    row('Check-in', (c) => (c.checkin ? cell('ok', '✓') : (c.freeze ? cell('frz', 'Freeze') : cell('none', '—')))),
    row('Meals', (c) => (c.meals >= 3 ? cell('ok', `${c.meals}`) : (c.meals > 0 ? cell('part', `${c.meals}`) : cell('none', '0')))),
    row('Training', (c) => (c.workout ? cell('ok', esc(c.workout)) : cell('none', 'Rest'))),
    row('Sleep', (c) => (c.sleepH == null ? cell('none', '—') : cell(c.sleepOk ? 'ok' : 'part', `${esc(fmt1(c.sleepH))} h`))),
    row('Steps', (c) => (c.steps == null ? cell('none', '—') : cell(c.stepsOk ? 'ok' : 'part', `${esc(c.steps >= 1000 ? fmt1(c.steps / 1000) + 'k' : fmtInt(c.steps))}`))),
    row('Water', (c) => (c.waterL == null ? cell('none', '—') : cell(c.waterOk ? 'ok' : 'part', `${esc(fmt1(c.waterL))} L`))),
    row('Protein', (c) => (c.protein == null ? cell('none', '—') : cell(c.proteinOk === true ? 'ok' : (c.proteinOk === false ? 'part' : ''), `${esc(fmtInt(c.protein))} g`)))
  ];
  if (cols.some((c) => c.mood != null)) rows.push(row('Mood', (c) => (c.mood == null ? cell('none', '—') : cell(c.mood >= 4 ? 'ok' : (c.mood <= 2 ? 'part' : ''), `${esc(c.mood)}/5`))));
  return `<div class="card grow"><div class="card-h"><div class="card-t">Your week, day by day</div><div class="card-s">Every habit, every day</div></div>
    <table class="mx">${head}${rows.join('')}</table>
    <div class="mx-key"><span><i style="background:#e6f3ea"></i>On target</span><span><i style="background:#fbf0dc"></i>Logged, below target</span><span><i style="background:#efeadf"></i>Not logged</span></div></div>`;
}

function renderWeekly(m, nar) {
  const total = 3;
  const p1 = page(m, 'cover', `${promiseCard(m)}${pillarsCard(m)}${matrixCard(m)}`, 1, total, { noHeader: true, before: weeklyCover(m, nar) });
  const p2 = page(m, 'drivers', `${sectionHead('02 · Drivers', 'What moved your score', `Score ${esc(m.score.total)} ${chip(m.score.grade)}`)}
    ${patternsCard(m, 'The patterns behind your week')}
    <div class="grid2">${trainingCard(m, 22)}${fuelCard(m, 22)}</div>
    <div class="grid2 grow">${recoveryCard(m, 22)}${bodyMindCard(m, 22)}</div>`, 2, total);
  const wl = winsAndLetter(m, nar, { maxWins: 4 });
  const p3 = page(m, 'plan', `${planBlocks(m, '03 · Plan')}${wl.wins}${wl.quote}${wl.letter}${disclaimer(m)}`, 3, total);
  return [p1, p2, p3];
}

// ---------------------------------------------------------------------------
// Monthly
// ---------------------------------------------------------------------------

function monthlyCover(m, nar) {
  const a = assets(); const s = m.score; const st = m.stats; const j = m.journey || {};
  const d = s.totalDelta;
  const pill = d == null ? '<span class="pill flat">Your first Signature month</span>'
    : `<span class="pill ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${esc(sign(d, ' pts'))} vs last month (${esc(s.previous.total)})</span>`;
  const monthWord = m.period.label.split(' ')[0];
  const b = st.body;
  const weightTile = b ? `<b>${esc(sign(b.changeKg, ''))}<small>kg</small></b><span>Weight this month</span>` : `<b>${esc(st.checkinDays)}<small>/ ${esc(m.period.days)}</small></b><span>Check-ins</span>`;
  const pillars = m.pillars.map((p) => `<div class="mc-p"><b>${p.score == null ? '—' : esc(p.score)}</b><span class="fit" data-fit>${esc(p.label)}</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, p.score || 0))}%"></i></div></div>`).join('');
  const inside = ['Since day one', 'The month in motion', 'Body, fuel & recovery', 'What your data says', 'Your plan for next month'];
  return `<div class="mc"><div class="mc-glow"></div>
    <div class="mc-top"><div class="hero-brand">${a.logo ? `<img src="${a.logo}" alt="">` : ''}<div><div class="hero-word">BODYBANK</div><div class="hero-kind">Lifestyle performance coaching</div></div></div>
      <div class="hero-period"><b>Private &amp; confidential</b>Prepared by your coach</div></div>
    <div class="mc-kind">Monthly Signature Report</div>
    <div class="mc-month fit" data-fit>${esc(m.period.label)}</div>
    <div class="mc-chapter clamp2" data-fit-lines="2">${esc(nar.chapter || `Your ${monthWord}`)}</div>
    <div class="mc-name"><div class="hero-for">Prepared for</div><b class="fit" data-fit>${esc(m.client.name)}</b></div>
    <div class="mc-ring">${ringSvg(s.total, 62, gradeColor(s.grade), C.nightTrack, 4.4)}
      <div class="ring-center"><div class="ring-num" style="font-size:40pt">${esc(s.total)}</div><div class="ring-of">BodyBank Score</div><div class="ring-grade">${chip(s.grade)}</div></div></div>
    <div class="mc-delta">${pill}</div>
    <p class="mc-headline clamp3" data-fit-lines="3">${esc(nar.headline)}</p>
    <div class="mc-stats">
      <div class="mc-stat"><b>${esc(st.sessions)}<small>/ ${esc(st.planned)}</small></b><span>Workouts</span></div>
      <div class="mc-stat"><b>${esc(st.activeDays)}<small>/ ${esc(m.period.days)}</small></b><span>Active days</span></div>
      <div class="mc-stat">${weightTile}</div>
      <div class="mc-stat"><b>${esc(st.perfectDays)}</b><span>Perfect days</span></div>
    </div>
    <div class="mc-pillars">${pillars}</div>
    ${(m.achievements || []).length ? `<div class="mc-hl"><div class="hero-for">Highlights</div><div class="mc-hl-row">${m.achievements.slice(0, 3).map((x) => `<div class="mc-hl-i"><div class="mc-hl-ico">${ICON[x.icon] || ICON.star}</div><div style="min-width:0"><b class="fit" data-fit>${esc(x.title)}</b><span class="clamp2" data-fit-lines="2">${esc(x.sub)}</span></div></div>`).join('')}</div></div>` : ''}
    <div class="mc-day">${j.dayN ? `<b>Day ${esc(fmtInt(j.dayN))}</b><span>with BodyBank${j.memberSince ? `<br>since ${esc(shortDate(j.memberSince))} ${esc(j.memberSince.slice(0, 4))}` : ''}</span>` : `<b>${esc(monthWord)}</b><span>in review</span>`}<span class="sp"></span>
      <div class="inside">${inside.map((t, i) => `${String(i + 2).padStart(2, '0')} · ${esc(t)}`).join('<br>')}</div></div>
  </div>`;
}

function journeyPage(m, photos) {
  const j = m.journey || {}; const w = j.weight;
  const series = (j.weightSeries || []).map((p) => ({ label: shortDate(p.date), v: p.kg }));
  const tiles = [
    kpi('Started at', w ? fmt1(w.startKg) : '—', w ? 'kg' : '', w ? esc(shortDate(w.startDate) + ' ' + w.startDate.slice(0, 4)) : 'First weigh-in'),
    kpi('Now', w ? fmt1(w.nowKg) : '—', w ? 'kg' : '', w ? `${esc(sign(w.changeKg, ' kg'))} in total` : 'Latest weigh-in'),
    w && w.goalKg != null
      ? `<div class="k"><div class="k-l">Goal ${esc(fmt1(w.goalKg))} kg</div><div class="k-v">${w.toGoalPct == null ? '—' : esc(w.toGoalPct)}<small>%</small></div><div class="goalbar"><i style="width:${Math.max(2, w.toGoalPct || 0)}%"></i></div><div class="k-d">of the way there</div></div>`
      : kpi('Goal', '—', '', 'Set a goal weight with your coach'),
    kpi('Waist', j.waist ? sign(j.waist.changeCm, '') : '—', j.waist ? 'cm' : '', j.waist ? `${esc(fmt1(j.waist.startCm))} → ${esc(fmt1(j.waist.nowCm))} cm` : 'Measure monthly')
  ];
  const chart = series.length >= 2
    ? lineSvg(series, { w: 178, h: 74, goal: w && w.goalKg != null ? w.goalKg : null, goalLabel: w && w.goalKg != null ? `Goal ${fmt1(w.goalKg)}` : '', area: true, aria: 'Weight since day one' })
    : `<p class="empty-note" style="height:74mm" data-h="74">Your weight story starts with two weigh-ins. Weigh in twice a week and this line becomes the proof of your progress.</p>`;
  const lifts = (j.lifts || []).length
    ? `<table class="lifts"><thead><tr><th>Lift</th><th class="num">First logged</th><th class="num">Best</th><th class="num">Gain</th></tr></thead><tbody>${j.lifts.map((l) => `<tr><td><span class="fit" data-fit style="max-width:40mm">${esc(l.label)}</span></td><td class="num">${esc(fmt1(l.firstKg))} kg</td><td class="num"><b>${esc(fmt1(l.bestKg))} kg</b></td><td class="num gain">${esc(sign(l.gainKg, ' kg'))}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty-note">Log the weight on your main lifts and your strength story fills in here.</p>';
  const ph = (m.photos || []).filter((p) => photos[p.id]);
  const photoCard = ph.length
    ? `<div class="card"><div class="card-h"><div class="card-t">${ph.length > 1 ? 'Then and now' : 'Your latest photo'}</div><div class="card-s">Shared with your coach</div></div><div class="photos" style="grid-template-columns:repeat(${ph.length},1fr)">${ph.map((p) => `<div class="photo"><img src="${photos[p.id]}" style="height:58mm" data-h="58" alt=""><span>${esc(p.label)}</span></div>`).join('')}</div></div>`
    : `<div class="card"><div class="card-h"><div class="card-t">Then and now</div><div class="card-s">Progress photos</div></div><p class="empty-note">No progress photos shared yet. Take front and side photos once a month in Body Snapshots — in three months they will tell your story better than any number.</p></div>`;
  return `${sectionHead('02 · Journey', 'Since day one', j.dayN ? `Day ${esc(fmtInt(j.dayN))} with BodyBank` : '')}
    <div class="jt">${tiles.join('')}</div>
    ${m.lifetime && (m.lifetime.workouts || m.lifetime.meals || m.lifetime.checkins) ? `<div class="life"><span class="label">Since day one you have logged</span><div><b>${esc(fmtInt(m.lifetime.workouts))}</b> workouts</div><div><b>${esc(fmtInt(m.lifetime.meals))}</b> meals</div><div><b>${esc(fmtInt(m.lifetime.checkins))}</b> daily check-ins</div>${m.lifetime.prs ? `<div><b>${esc(fmtInt(m.lifetime.prs))}</b> personal bests</div>` : ''}</div>` : ''}
    <div class="card"><div class="card-h"><div class="card-t">Your weight, week by week</div><div class="card-s">Weekly average since your first weigh-in</div></div>${chart}</div>
    <div class="grid2"><div class="card"><div class="card-h"><div class="card-t">Stronger than when you started</div><div class="card-s">First logged → best ever</div></div>${lifts}</div>${photoCard}</div>`;
}

function motionPage(m) {
  const weeks = m.weeks || [];
  const wk = weeks.length
    ? columnsSvg(weeks.map((w) => ({ label: w.label, v: w.score })), { w: 84, h: 46, barMax: 11, aria: 'BodyBank Score by week' })
    : '';
  const rows = m.pillars.map((p) => {
    const prev = p.delta != null && p.score != null ? p.score - p.delta : null;
    return `<tr><td>${esc(p.label)}</td><td class="num">${prev == null ? '—' : esc(prev)}</td><td class="num"><b>${p.score == null ? '—' : esc(p.score)}</b></td><td class="num">${deltaTxt(p.delta, 'month')}</td><td class="num">${chip(p.score == null ? null : p.grade)}</td></tr>`;
  }).join('');
  const heat = m.heat || [];
  const lead = heat.length ? (heat[0].dow + 6) % 7 : 0;
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push('<div class="c off"></div>');
  heat.forEach((h) => cells.push(`<div class="c ${h.freeze ? 'frz' : 'lv' + h.level}"><span>${esc(h.day)}</span><em>${h.freeze ? 'Freeze' : `${esc(h.level)}/4`}</em></div>`));
  const best = weeks.length ? weeks.slice().sort((a, b) => b.score - a.score)[0] : null;
  return `${sectionHead('03 · Rhythm', 'The month in motion', '')}
    <div class="grid2">
      <div class="card"><div class="card-h"><div class="card-t">Score, week by week</div><div class="card-s">${best ? `Best: ${esc(best.label)}` : ''}</div></div>${wk}<p class="c-cap">Each bar is a full BodyBank Score for that week alone.</p></div>
      <div class="card"><div class="card-h"><div class="card-t">Pillars vs last month</div><div class="card-s">Score out of 100</div></div>
        <table class="ptab"><thead><tr><th>Pillar</th><th class="num">Last</th><th class="num">Now</th><th class="num">Change</th><th class="num">Grade</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>
    <div class="card grow"><div class="card-h"><div class="card-t">Every day of ${esc(m.period.label)}</div><div class="card-s">Habits completed each day</div></div>
      <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dw">${d}</div>`).join('')}${cells.join('')}</div>
      <div class="cal-key"><span>0</span><i style="background:#efeadf"></i><i style="background:#f1e6c9"></i><i style="background:#e2cb8d"></i><i style="background:#c9a552"></i><i style="background:#8f6d22"></i><span>4 of 4 habits: check-in, 2+ meals, training, 7 h sleep</span><span style="margin-left:3mm"></span><i style="background:#e8eef7"></i><span>Streak freeze</span></div>
      <p class="c-cap">${esc(m.stats.activeDays)} active days · longest streak ${esc(m.stats.longestStreak)} · ${esc(m.stats.perfectDays)} perfect ${m.stats.perfectDays === 1 ? 'day' : 'days'}.</p></div>`;
}

function healthCard(m, chartH) {
  const bl = m.blood; const mind = m.mind; const w = m.wearable;
  const rows = [];
  if (w) rows.push(kpi('Recovery', w.recovery == null ? '—' : fmtInt(w.recovery), w.recovery == null ? '' : '%', w.recoveryDelta == null ? `${esc(w.days)} days tracked` : `${esc(sign(w.recoveryDelta, ''))} vs ${esc(prevName(m))}`));
  if (w && w.rhr != null) rows.push(kpi('Resting HR', fmtInt(w.rhr), 'bpm', w.rhrDelta == null ? '' : `${esc(sign(w.rhrDelta, ' bpm'))} vs ${esc(prevName(m))}`));
  rows.push(mind ? kpi('Mood · stress', `${mind.avgMood == null ? '—' : fmt1(mind.avgMood)} · ${mind.avgStress == null ? '—' : fmt1(mind.avgStress)}`, '/5', `${esc(mind.days)} days${mind.sessions ? ` · ${esc(mind.sessions)} sessions` : ''}`) : kpi('Mind', '—', '', 'Log mood daily in Mind'));
  const blood = bl
    ? `<div class="label" style="margin-top:2mm">Blood work</div><p style="margin-top:1mm">${esc(bl.inRange)} of ${esc(bl.tracked)} tracked markers in range on your latest test (${esc(shortDate(bl.latestDate))} ${esc(bl.latestDate.slice(0, 4))})${bl.movedIntoRange ? `, ${esc(bl.movedIntoRange)} moved into range since the previous one` : ''}.</p>${bl.flagged.length ? `<p class="doc clamp2" data-fit-lines="2" style="margin-top:1mm">Discuss with your doctor: ${esc(bl.flagged.join(', '))}${bl.flaggedMore ? ` +${esc(bl.flaggedMore)} more` : ''}.</p>` : ''}`
    : '<div class="label" style="margin-top:2mm">Blood work</div><p class="c-cap">No blood report on file. A test every 3–6 months lets us connect your habits to your markers.</p>';
  return `<div class="card"><div class="card-h"><div class="card-t">Mind &amp; health</div><div class="card-s">${w ? 'Wearable + check-ins' : 'Check-ins'}</div></div>
    <div class="kp ${rows.length === 2 ? 'k2' : ''}">${rows.slice(0, 3).join('')}</div>${mindSeries(m, chartH)}${blood}</div>`;
}

function bodyFuelPage(m) {
  return `${sectionHead('04 · Detail', 'Body, fuel & recovery', '')}
    <div class="grid2">${trainingCard(m, 36)}${fuelCard(m, 36)}</div>
    <div class="grid2 grow">${recoveryCard(m, 36)}${healthCard(m, 36)}</div>`;
}

function dataPage(m) {
  const tp = m.touchpoints;
  const tpHtml = tp
    ? `<div class="card"><div class="card-h"><div class="card-t">Your coaching this month</div><div class="card-s">${esc(tp.total)} touchpoints from your team</div></div><div class="tp">${tp.items.map((i) => `<div><b>${esc(i.value)}</b><span>${esc(i.label)}</span></div>`).join('')}</div></div>`
    : '';
  const ach = (m.achievements || []).slice(0, 6);
  const wins = ach.length
    ? `<div class="card"><div class="card-h"><div class="card-t">Wins worth naming</div><div class="card-s">${esc(m.period.label)}</div></div><div class="wins">${ach.map((a) => `<div class="win"><div class="win-ico">${ICON[a.icon] || ICON.star}</div><div style="min-width:0"><div class="win-t fit" data-fit>${esc(a.title)}</div><div class="win-s clamp2" data-fit-lines="2">${esc(a.sub)}</div></div></div>`).join('')}</div></div>`
    : `<div class="card"><div class="card-t">Wins worth naming</div><p class="empty-note">Log daily next month and your wins will stack up here.</p></div>`;
  const quote = m.quote ? `<div class="quote clamp4" data-fit-lines="4">“${esc(m.quote)}”<span>You, in your Sunday check-in</span></div>` : '';
  const noticed = m.noticed ? `<div class="quote clamp3" data-fit-lines="3">“${esc(m.noticed)}”<span>What you noticed this month</span></div>` : '';
  return `${sectionHead('05 · Insight', 'What your data says', '')}
    ${patternsCard(m, 'Your patterns this month')}
    ${promiseCard(m)}
    ${wins}${tpHtml}${quote}${noticed}`;
}

function renderMonthly(m, nar, photos) {
  const total = 6;
  const pages = [];
  pages.push(page(m, 'mcover', monthlyCover(m, nar), 1, total, { noHeader: true }));
  pages.push(page(m, 'journey', journeyPage(m, photos), 2, total));
  pages.push(page(m, 'motion', motionPage(m), 3, total));
  pages.push(page(m, 'detail', bodyFuelPage(m), 4, total));
  pages.push(page(m, 'insight', dataPage(m), 5, total));
  const wl = winsAndLetter(m, nar, { maxWins: 0, noQuote: true });
  pages.push(page(m, 'plan', `${planBlocks(m, '06 · Plan')}${blueprintCard(m)}${wl.letter}${disclaimer(m)}`, 6, total));
  return pages;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * @param m          model.buildModel() output (stored snapshot)
 * @param narrative  { headline, letter, chapter, ps }
 * @param opts       { photos: { id: dataUrl } }
 */
function render(m, narrative, opts) {
  const o = opts || {};
  const nar = Object.assign({ headline: '', letter: '', chapter: '', ps: '' }, narrative || {});
  const pages = m.type === 'monthly' ? renderMonthly(m, nar, o.photos || {}) : renderWeekly(m, nar);
  const a = assets();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(`${m.title} — ${m.client.name} — ${m.period.label}`)}</title><style>${a.fonts}</style><style>${a.css}</style></head>
<body class="sgr sgr--${esc(m.type)}">${pages.join('\n')}</body></html>`;
}

module.exports = { render, esc, ringSvg, columnsSvg, lineSvg };
