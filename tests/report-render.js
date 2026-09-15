'use strict';

/**
 * Client progress report — PDF LAYOUT AUDIT.   node tests/report-render.js
 *
 * The standing PDF rule, applied to the Puppeteer reports:
 *   (a) no glyph outside the page's safe area,
 *   (b) no two runs of text printed on top of each other,
 *   (c) no blank page, and exactly one page per section (nothing spills),
 *   (d) branding on every page: BODYBANK, bodybank.fit, "Page X of Y",
 *   (e) the in-Chrome fit pass reports no page overflow and no card outside its page body,
 *   (f) a warm render finishes in under 8 seconds,
 *   (g) the empty state line appears when there is no data; no diagnosis language anywhere.
 *
 * Rendered for weekly and monthly, each with EMPTY / NORMAL / EXTREME seeded
 * data (tests/fixtures/reports/seed.js). Opens the finished PDF with pdfjs, so
 * what is asserted is what a client sees. NO NETWORK. NO DATABASE.
 *
 * Needs headless Chrome (installed by `npm ci` via puppeteer). When Chrome is
 * genuinely unavailable the audit exits 0 with SKIPPED, unless REPORTS_REQUIRE_CHROME=1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedBundle } = require('./fixtures/reports/seed');
const { renderFromBundle } = require('../services/reportService');
const pdfSvc = require('../services/reportPdf');
const { MEDICAL_RE } = require('../services/reportInsights');

const OUT_DIR = path.join(os.tmpdir(), 'bodybank-report-audit');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MM = 72 / 25.4; // PDF points per mm
let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(label + (detail ? ' :: ' + detail : ''));
}

async function loadPdfjs() {
  for (const c of ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.js', 'pdfjs-dist/build/pdf.mjs']) {
    try {
      const url = require.resolve(c);
      const m = await import('file://' + url.replace(/\\/g, '/'));
      const lib = m && m.getDocument ? m : (m && m.default);
      if (lib && lib.getDocument) return lib;
    } catch (_) { /* next */ }
  }
  throw new Error('pdfjs-dist could not be loaded');
}

async function readPages(pdfjs, buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = [];
    for (const it of content.items) {
      const str = String(it.str || '');
      if (!str.trim()) continue;
      const t = it.transform;
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // rotated axis titles live inside chart PNGs, not here
      const h = Math.abs(it.height || t[3]) || 6;
      const x = t[4];
      const base = vp.height - t[5];
      items.push({ str, x, right: x + (it.width || 0), top: base - h, bottom: base + h * 0.22, base, h });
    }
    pages.push({ index: p, width: vp.width, height: vp.height, items, text: items.map((i) => i.str).join(' ') });
  }
  await doc.destroy();
  return pages;
}

function audit(label, pages, expectedPages) {
  ok(`${label}: page count = sections (${expectedPages})`, pages.length === expectedPages, `got ${pages.length}`);
  const safe = { left: 10 * MM, right: 200 * MM, top: 6 * MM, bottom: 293 * MM };
  pages.forEach((pg) => {
    const L = `${label} p${pg.index}`;
    // (d) branding
    // Letter-spaced text extracts as separated glyphs; it is still real text.
    ok(`${L}: BODYBANK wordmark`, /B\s*O\s*D\s*Y\s*B\s*A\s*N\s*K/i.test(pg.text));
    ok(`${L}: bodybank.fit footer`, /bodybank\.fit/.test(pg.text));
    ok(`${L}: page X of Y`, new RegExp(`Page\\s*${pg.index}\\s*of\\s*${pages.length}`).test(pg.text), pg.text.slice(-120));
    // (c) not blank: real content in the body band (between header and footer)
    const bodyItems = pg.items.filter((i) => i.base > 30 * MM && i.base < 278 * MM);
    ok(`${L}: not blank`, bodyItems.length >= 12, `${bodyItems.length} body text runs`);
    // (a) safe area
    let off = 0;
    pg.items.forEach((i) => {
      if (i.x < safe.left - 0.5 || i.right > safe.right + 0.5 || i.top < safe.top - 0.5 || i.bottom > safe.bottom + 0.5) {
        off += 1;
        if (off <= 3) failures.push(`${L}: OFF-PAGE "${i.str.slice(0, 50)}" x=${(i.x / MM).toFixed(1)}mm right=${(i.right / MM).toFixed(1)}mm top=${(i.top / MM).toFixed(1)}mm`);
      }
    });
    if (!off) passed += 1;
    // (b) overlapping text: two runs whose boxes intersect substantially
    let overlaps = 0;
    const its = pg.items;
    for (let a = 0; a < its.length; a += 1) {
      for (let b = a + 1; b < its.length; b += 1) {
        const A = its[a]; const B = its[b];
        const ix = Math.min(A.right, B.right) - Math.max(A.x, B.x);
        const iy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
        if (ix <= 1 || iy <= 1) continue;
        // Runs of one line split by Chrome sit on the same baseline and just touch.
        if (Math.abs(A.base - B.base) < 0.6 && ix < 2) continue;
        const minW = Math.max(1, Math.min(A.right - A.x, B.right - B.x));
        const minH = Math.max(1, Math.min(A.bottom - A.top, B.bottom - B.top));
        if (ix / minW > 0.25 && iy / minH > 0.35) {
          overlaps += 1;
          if (overlaps <= 3) failures.push(`${L}: OVERLAP "${A.str.slice(0, 30)}" / "${B.str.slice(0, 30)}"`);
        }
      }
    }
    if (!overlaps) passed += 1;
  });
}

async function main() {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (err) {
    console.log('SKIPPED report render audit — pdfjs unavailable:', err.message);
    return;
  }
  const t0 = Date.now();
  try {
    await pdfSvc.renderCharts([], [], '');
  } catch (err) {
    const msg = 'Chrome unavailable: ' + err.message;
    if (process.env.REPORTS_REQUIRE_CHROME === '1') { console.error('FAILED ' + msg); process.exit(1); }
    console.log('SKIPPED report render audit — ' + msg);
    return;
  }
  console.log(`chrome warm-up ${Date.now() - t0} ms`);

  for (const type of ['weekly', 'monthly']) {
    for (const variant of ['normal', 'empty', 'extreme']) {
      const label = `${type}/${variant}`;
      const bundle = seedBundle(type, variant);
      const res = await renderFromBundle(bundle, { pdf: true, ai: false });
      fs.writeFileSync(path.join(OUT_DIR, `${type}-${variant}.pdf`), res.pdf);
      const expected = type === 'monthly' ? 8 : res.sections.length;
      if (type === 'monthly') ok(`${label}: monthly has all 8 sections`, res.sections.length === 8, res.sections.join(','));
      if (type === 'weekly') {
        ok(`${label}: weekly merges yoga into check-in`, !res.sections.includes('yoga'));
        const hm = res.score.pillars.health.metrics;
        ok(`${label}: weekly body page only with new body data`, res.sections.includes('body') === !!hm.newBodyData);
        ok(`${label}: weekly blood page only with new blood data`, res.sections.includes('blood') === !!hm.newBloodData);
      }
      // (e) fit pass
      const hard = (res.warnings || []).filter((w) => w.kind === 'page-overflow' || w.kind === 'block-outside-body');
      ok(`${label}: no page overflow / card outside body`, hard.length === 0, JSON.stringify(hard).slice(0, 300));
      if (variant !== 'extreme') {
        ok(`${label}: no fit warnings at all`, (res.warnings || []).length === 0, JSON.stringify(res.warnings).slice(0, 300));
      }
      ok(`${label}: no chart errors`, Object.keys(res.chartErrors || {}).length === 0, JSON.stringify(res.chartErrors));
      // (f) timing (warm browser)
      if (variant === 'normal') ok(`${label}: renders under 8 s (${res.ms} ms)`, res.ms < 8000, `${res.ms} ms`);
      const pages = await readPages(pdfjs, res.pdf);
      audit(label, pages, expected);
      const all = pages.map((p) => p.text).join(' ');
      // (g) content rules
      if (variant === 'empty') {
        ok(`${label}: empty-state line printed`, /logging is the fastest way to raise your score/.test(all));
      }
      if (variant === 'normal' && type === 'monthly') {
        ok(`${label}: doctor flag printed for out-of-range markers`, /Discuss with your doctor/.test(all));
      }
      ok(`${label}: no diagnosis language`, !MEDICAL_RE.test(all.replace(/Grades: A\+[^.]*\./g, '')), (all.match(MEDICAL_RE) || [])[0]);
      const spaced = (w) => new RegExp(w.split('').join('\\s*'), 'gi');
      ok(`${label}: every section has Insight and Action`, (all.match(spaced('insight')) || []).length >= pages.length - 1 && (all.match(spaced('action')) || []).length >= pages.length - 1,
        `insight ${(all.match(spaced('insight')) || []).length}, action ${(all.match(spaced('action')) || []).length}, pages ${pages.length}`);
      console.log(`  ${label}: ${pages.length} pages, ${res.ms} ms, score ${res.score.total} (${res.score.grade})`);
    }
  }
  await pdfSvc.close();

  console.log('');
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks  (PDFs in ${OUT_DIR})`);
    failures.slice(0, 60).forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`PASSED  ${passed} checks — client report PDFs (weekly + monthly × empty/normal/extreme)`);
}

main().catch(async (err) => { console.error(err); try { await pdfSvc.close(); } catch (_) { /* ignore */ } process.exit(1); });
