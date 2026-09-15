'use strict';

/**
 * Reports module — headless Chrome (Puppeteer).
 *
 *   renderCharts(specs, photos) -> { images: {id: dataUrl}, photos: {id: dataUrl}, errors }
 *   finalize(html)              -> { html, warnings, pages }     fit pass, serialised
 *   htmlToPdf(html)             -> { pdf: Buffer, warnings, pages }
 *
 * One browser is shared and closed after 60 s idle. Work is serialised through a
 * single queue so a bulk run never holds more than one Chrome page — Render
 * instances are memory-bound. Every page blocks all network access: a report is
 * fully self-contained (fonts, logo, charts and photos are data: URIs).
 *
 * The FIT PASS enforces the PDF rule "no overflow, no overlap, nothing cut off":
 *   1. every [data-fit] single line is shrunk (down to 70%) until it fits;
 *   2. every [data-fit-lines] block is shrunk until its clamped height holds it;
 *   3. a page whose body still overflows steps down chart heights (fit-1..3, to
 *      76%) and gaps, and is reported in `warnings` if even that cannot hold it.
 */

const path = require('path');
const fs = require('fs');

// Resolved lazily so a missing optional dependency can never break server boot.
const chartJsPath = () => path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
const CHART_BUILDERS = path.join(__dirname, '..', 'templates', 'report-charts.js');
const IDLE_MS = 60 * 1000;
const OP_TIMEOUT_MS = 60 * 1000;

let browserPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function executablePath() {
  const p = (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '').trim();
  return p || undefined;
}

async function launch() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: 'shell',
    executablePath: executablePath(),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--font-render-hinting=none', '--disable-extensions', '--no-first-run', '--no-zygote'
    ]
  });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch().then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    const p = browserPromise;
    browserPromise = null;
    if (p) { try { (await p).close(); } catch (_) { /* already gone */ } }
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out')), ms); })
  ]).finally(() => clearTimeout(t));
}

/** Runs fn(page) on the shared browser, one at a time. */
function withPage(fn) {
  const run = async () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('data:') || u === 'about:blank') req.continue();
        else req.abort();
      });
      return await withTimeout(fn(page), OP_TIMEOUT_MS, 'report render');
    } finally {
      try { await page.close(); } catch (_) { /* ignore */ }
      scheduleIdleClose();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

let chartJsSrc = null;
let buildersSrc = null;
function scripts() {
  if (!chartJsSrc) chartJsSrc = fs.readFileSync(chartJsPath(), 'utf8');
  if (!buildersSrc) buildersSrc = fs.readFileSync(CHART_BUILDERS, 'utf8');
  return { chartJsSrc, buildersSrc };
}

async function renderCharts(specs, photos, fontsCss) {
  return withPage(async (page) => {
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fontsCss || ''} body{margin:0;background:#fff;font-family:'Inter',sans-serif}</style></head><body></body></html>`, { waitUntil: 'load' });
    const s = scripts();
    await page.addScriptTag({ content: s.chartJsSrc });
    await page.addScriptTag({ content: s.buildersSrc });
    return page.evaluate((sp, ph) => window.BBReportCharts.renderAll(sp, ph), specs || [], photos || []);
  });
}

/** In-page fit pass. Runs inside Chrome. */
function fitPass() {
  const warnings = [];
  const shrinkLine = (el, minRatio) => {
    const cs = getComputedStyle(el);
    const base = parseFloat(cs.fontSize);
    let size = base;
    let guard = 0;
    while (el.scrollWidth > el.clientWidth + 0.5 && size > base * minRatio && guard < 40) {
      size -= 0.25; el.style.fontSize = size + 'px'; guard += 1;
    }
    return el.scrollWidth <= el.clientWidth + 0.5;
  };
  const shrinkBlock = (el, minRatio) => {
    const base = parseFloat(getComputedStyle(el).fontSize);
    let size = base; let guard = 0;
    while (el.scrollHeight > el.clientHeight + 0.5 && size > base * minRatio && guard < 40) {
      size -= 0.25; el.style.fontSize = size + 'px'; guard += 1;
    }
    return el.scrollHeight <= el.clientHeight + 0.5;
  };
  document.querySelectorAll('[data-fit]').forEach((el) => {
    if (!shrinkLine(el, 0.7)) warnings.push({ kind: 'line-truncated', text: (el.textContent || '').slice(0, 60) });
  });
  document.querySelectorAll('[data-fit-lines]').forEach((el) => {
    if (!shrinkBlock(el, 0.75)) warnings.push({ kind: 'block-truncated', text: (el.textContent || '').slice(0, 60) });
  });
  const pages = Array.from(document.querySelectorAll('.page'));
  pages.forEach((pg, i) => {
    const body = pg.querySelector('.pb, .cover-body');
    if (!body) return;
    const over = () => body.scrollHeight > body.clientHeight + 0.5;
    const scaled = Array.from(pg.querySelectorAll('[data-h]'));
    const STEPS = [0.9, 0.83, 0.76];
    let level = 0;
    while (over() && level < STEPS.length) {
      const f = STEPS[level];
      level += 1;
      pg.classList.add('fit-' + level);
      scaled.forEach((el) => { el.style.height = (parseFloat(el.getAttribute('data-h')) * f).toFixed(2) + 'mm'; });
    }
    if (over()) warnings.push({ kind: 'page-overflow', page: i + 1, by: body.scrollHeight - body.clientHeight });
    // Every block inside the body must sit within it (no card spilling past the footer line).
    const bb = body.getBoundingClientRect();
    body.querySelectorAll('.card, .callout, .kpi, .info, .note, .target, .ach-item, .mv, .pillar, .summary, .comp').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > bb.bottom + 1 || r.right > bb.right + 1 || r.left < bb.left - 1) {
        warnings.push({ kind: 'block-outside-body', page: i + 1, cls: el.className });
      }
    });
  });
  return { warnings, pages: pages.length };
}

async function loadAndFit(page, html) {
  await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
  await page.emulateMediaType('print');
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; });
  return page.evaluate(fitPass);
}

/**
 * Layout probe (runs inside Chrome). For every page, measures how much of the
 * 255 mm body the content really uses and which growable slots sit in which
 * row, so charts can be enlarged to fill the page instead of leaving a gap.
 */
function probePass() {
  const MM = 96 / 25.4;
  const out = [];
  document.querySelectorAll('.page').forEach((pg, i) => {
    const body = pg.querySelector('.pb');
    if (!body) return;
    const pushed = Array.from(body.querySelectorAll(':scope > .push'));
    pushed.forEach((el) => { el.style.marginTop = '0'; });
    const prevJustify = body.style.justifyContent;
    body.style.justifyContent = 'flex-start';
    const kids = Array.from(body.children);
    const top = body.getBoundingClientRect().top;
    const natural = kids.length ? kids[kids.length - 1].getBoundingClientRect().bottom - top : 0;
    const slackMm = (body.clientHeight - natural) / MM;
    const rows = Array.from(body.querySelectorAll('[data-row]')).map((row) => {
      const seen = {};
      row.querySelectorAll('[data-slot]').forEach((el) => {
        seen[el.getAttribute('data-slot')] = Number(el.getAttribute('data-stack') || 1);
      });
      return Object.keys(seen).map((slot) => ({ slot, stack: seen[slot] }));
    }).filter((r) => r.length);
    pushed.forEach((el) => { el.style.marginTop = ''; });
    body.style.justifyContent = prevJustify;
    out.push({ page: i + 1, slackMm, rows });
  });
  return out;
}

/** Turns probe output into { slot: extraMm }: slack shared across rows, capped, with a safety margin. */
function growFromProbe(probe, opts) {
  const o = opts || {};
  const safety = o.safetyMm == null ? 4 : o.safetyMm;
  const cap = o.capMm == null ? 40 : o.capMm;
  const grow = {};
  (probe || []).forEach((pg) => {
    const usable = pg.slackMm - safety;
    if (!(usable > 1) || !pg.rows.length) return;
    const per = Math.min(usable / pg.rows.length, cap);
    pg.rows.forEach((row) => row.forEach((s) => { grow[s.slot] = Math.max(grow[s.slot] || 0, Math.floor((per / s.stack) * 10) / 10); }));
  });
  return grow;
}

async function probeLayout(html) {
  return withPage(async (page) => {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; });
    return page.evaluate(probePass);
  });
}

async function finalize(html) {
  return withPage(async (page) => {
    const fit = await loadAndFit(page, html);
    const out = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
    return { html: out, warnings: fit.warnings, pages: fit.pages };
  });
}

async function htmlToPdf(html) {
  return withPage(async (page) => {
    const fit = await loadAndFit(page, html);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    return { pdf: Buffer.from(pdf), warnings: fit.warnings, pages: fit.pages };
  });
}

async function close() {
  const p = browserPromise; browserPromise = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (p) { try { (await p).close(); } catch (_) { /* ignore */ } }
}

module.exports = { renderCharts, probeLayout, growFromProbe, finalize, htmlToPdf, close };
