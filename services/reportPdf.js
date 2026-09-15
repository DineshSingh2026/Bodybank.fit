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
const os = require('os');

// Resolved lazily so a missing optional dependency can never break server boot.
const chartJsPath = () => path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
const CHART_BUILDERS = path.join(__dirname, '..', 'templates', 'report-charts.js');
const IDLE_MS = 60 * 1000;
const OP_TIMEOUT_MS = 45 * 1000;            // one Chrome step: layout probe, charts, fit, print
const OPEN_TIMEOUT_MS = 40 * 1000;          // launching Chrome / opening a tab
const ENGINE_WAIT_MS = 20 * 1000;           // how long a request waits on a first-time Chrome download
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;   // a stalled download must never wedge the engine

let browserPromise = null;
let browserGen = 0;
let idleTimer = null;
let queue = Promise.resolve();

/** What the report engine is doing — read by diagnostics() and the error hints. */
const engine = {
  status: 'idle',          // idle | checking | installing | ready | error
  since: null,
  exe: null,
  buildId: null,
  installMs: null,
  lastLaunchMs: null,
  error: null,
  queued: 0,
  restarts: 0,
  lastRender: null,
  progress: null,          // { phase: downloading|extracting|done, downloadedMb, totalMb, pct }
  cacheDir: null
};
function setEngine(status, extra) {
  engine.status = status;
  engine.since = new Date().toISOString();
  Object.assign(engine, extra || {});
}

function engineError(code, message, hint) {
  const e = new Error(message);
  e.code = code;
  e.status = 503;
  e.hint = hint;
  return e;
}

function executablePath() {
  const p = (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '').trim();
  return p || undefined;
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out after ' + Math.round(ms / 1000) + ' s')), ms); })
  ]).finally(() => clearTimeout(t));
}

/**
 * Makes sure the pinned headless Chrome exists and returns its path.
 *
 * `npm ci` is supposed to download it (puppeteer postinstall + .puppeteerrc.cjs),
 * but a host build can skip or relocate that step — production once failed with
 * "Could not find Chrome (ver. 148...)". So the server checks at runtime and, if
 * the browser is missing, installs that exact build into the project cache with
 * Puppeteer's own installer, once. A stalled download is abandoned after
 * INSTALL_TIMEOUT_MS so the next attempt can retry. PUPPETEER_EXECUTABLE_PATH /
 * CHROME_PATH win.
 */
let browserReady = null;
function ensureBrowser() {
  const override = executablePath();
  if (override) {
    if (engine.status === 'idle') setEngine('ready', { exe: override });
    return Promise.resolve(override);
  }
  if (!browserReady) {
    browserReady = (async () => {
      setEngine('checking');
      const puppeteer = require('puppeteer');
      const B = require('@puppeteer/browsers');
      const buildId = puppeteer.PUPPETEER_REVISIONS['chrome-headless-shell'];
      const cfg = puppeteer.configuration || (puppeteer.default && puppeteer.default.configuration) || {};
      const cacheDir = (process.env.PUPPETEER_CACHE_DIR || '').trim()
        || cfg.cacheDirectory
        || path.join(__dirname, '..', '.cache', 'puppeteer');
      const platform = B.detectBrowserPlatform();
      if (!platform) throw new Error('Unsupported platform for headless Chrome: ' + process.platform + '/' + process.arch);
      const opts = { browser: B.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform };
      const exe = B.computeExecutablePath(opts);
      engine.buildId = buildId;
      engine.cacheDir = cacheDir;
      if (!fs.existsSync(exe)) {
        const t0 = Date.now();
        setEngine('installing', { exe, error: null });
        // A download interrupted by a restart leaves the browser folder without its
        // executable; the installer refuses that state forever. Clear it first.
        try {
          const cache = new B.Cache(cacheDir);
          const dir = cache.installationDir(opts.browser, platform, buildId);
          if (fs.existsSync(dir)) {
            console.warn('[reports] removing a half-finished headless Chrome download:', dir);
            await B.uninstall(opts);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          }
          const root = cache.browserRoot(opts.browser);
          if (fs.existsSync(root)) {
            fs.readdirSync(root)
              .filter((f) => f.startsWith(buildId) && f.endsWith('.zip'))
              .forEach((f) => { try { fs.rmSync(path.join(root, f), { force: true }); } catch (_) { /* in use */ } });
          }
        } catch (cleanErr) {
          console.warn('[reports] could not clean a partial Chrome download:', cleanErr.message);
        }
        console.log(`[reports] headless Chrome ${buildId} not found at ${exe} — installing into ${cacheDir}`);
        engine.progress = { phase: 'downloading', downloadedMb: 0, totalMb: null, pct: 0, updatedAt: new Date().toISOString() };
        const installOpts = Object.assign({}, opts, {
          downloadProgressCallback: (done, total) => {
            engine.progress = {
              phase: total && done >= total ? 'extracting' : 'downloading',
              downloadedMb: Math.round(done / 1048576),
              totalMb: total ? Math.round(total / 1048576) : null,
              pct: total ? Math.floor((done * 100) / total) : null,
              updatedAt: new Date().toISOString()
            };
          }
        });
        await withTimeout(B.install(installOpts), INSTALL_TIMEOUT_MS, 'headless Chrome download');
        engine.progress = { phase: 'done', updatedAt: new Date().toISOString() };
        if (!fs.existsSync(exe)) throw new Error('headless Chrome install finished but the executable is missing: ' + exe);
        engine.installMs = Date.now() - t0;
        console.log(`[reports] headless Chrome ${buildId} installed in ${Math.round(engine.installMs / 1000)} s`);
      }
      setEngine('ready', { exe, error: null });
      return exe;
    })().catch((err) => {
      browserReady = null;
      setEngine('error', { error: 'install: ' + String(err.message).slice(0, 300) });
      console.error('[reports] headless Chrome unavailable:', err.message);
      throw err;
    });
  }
  return browserReady;
}

const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--font-render-hinting=none', '--disable-extensions', '--no-first-run', '--no-zygote',
  '--disable-background-networking', '--disable-default-apps', '--disable-sync', '--mute-audio',
  '--no-default-browser-check', '--disable-features=Translate,BackForwardCache,MediaRouter',
  // Low-memory host (512 MB): reports render one local page at a time, so one
  // renderer process and no per-site isolation processes are enough.
  '--renderer-process-limit=1', '--disable-site-isolation-trials'
];

/** Plain-language "still preparing" message, with live download progress when known. */
function progressHint() {
  const p = engine.progress;
  let where = '';
  if (p && p.phase === 'downloading') {
    where = p.totalMb ? ` (downloading Chrome: ${p.downloadedMb} of ${p.totalMb} MB, ${p.pct}%)` : ` (downloading Chrome: ${p.downloadedMb} MB so far)`;
  } else if (p && p.phase === 'extracting') {
    where = ' (download complete, unpacking Chrome)';
  }
  return 'The PDF engine is still being set up on the server' + where + '. Please try again shortly.';
}

async function launch() {
  const puppeteer = require('puppeteer');
  let exe;
  try {
    exe = await withTimeout(ensureBrowser(), ENGINE_WAIT_MS, 'report engine start');
  } catch (err) {
    if (engine.status === 'installing' || engine.status === 'checking') {
      throw engineError('engine_starting', 'Report engine still preparing: ' + err.message,
        progressHint());
    }
    throw engineError('engine_unavailable', 'Report engine unavailable: ' + err.message,
      'The PDF engine could not be prepared on the server: ' + String(err.message).slice(0, 200));
  }
  const t0 = Date.now();
  try {
    const browser = await puppeteer.launch({
      headless: 'shell',
      executablePath: exe,
      timeout: OPEN_TIMEOUT_MS,
      protocolTimeout: OP_TIMEOUT_MS + 15000,
      args: CHROME_ARGS
    });
    engine.lastLaunchMs = Date.now() - t0;
    if (engine.status !== 'ready') setEngine('ready', { error: null });
    return browser;
  } catch (err) {
    const first = String(err.message).split(String.fromCharCode(10)).filter(Boolean).slice(0, 3).join(' | ');
    setEngine('error', { error: 'launch: ' + first.slice(0, 300) });
    console.error('[reports] Chrome failed to launch:', err.message);
    throw engineError('engine_unavailable', 'Chrome failed to launch: ' + err.message,
      'Chrome could not start on the server: ' + first.slice(0, 200));
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const gen = ++browserGen;
    browserPromise = launch().then((b) => {
      if (gen !== browserGen) {
        // Its request already gave up and the engine moved on: do not leak it.
        b.close().catch(() => {});
        throw engineError('engine_timeout', 'Chrome started after its request gave up', 'The PDF engine was restarted. Please try again.');
      }
      b.on('disconnected', () => { if (gen === browserGen) browserPromise = null; });
      return b;
    }).catch((err) => {
      if (gen === browserGen) browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** Force a wedged or crashed Chrome out of the way so the next request starts clean. */
async function killBrowser(reason) {
  const p = browserPromise;
  browserGen += 1;
  browserPromise = null;
  engine.restarts += 1;
  if (!p) return;
  console.warn('[reports] restarting Chrome:', reason);
  try {
    const b = await withTimeout(p, 1500, 'pending launch');
    const proc = b.process && b.process();
    try {
      await withTimeout(b.close(), 3000, 'Chrome close');
    } catch (_) {
      if (proc && !proc.killed) { try { proc.kill('SIGKILL'); } catch (__) { /* already gone */ } }
    }
  } catch (_) { /* launch never finished: getBrowser closes it when it does */ }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (engine.queued > 0) return;
    const p = browserPromise;
    browserPromise = null;
    if (p) { try { (await p).close(); } catch (_) { /* already gone */ } }
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

const WEDGED_RE = /timed out|Target closed|Session closed|Protocol error|detached|crash|disconnected|Navigating frame was detached/i;

/**
 * Runs fn(page) on the shared browser, one at a time. Every step is bounded, so
 * a request always ends with a result or an error — never an endless wait — and
 * a Chrome that stops responding is killed so it cannot block the queue.
 */
function withPage(fn, label) {
  engine.queued += 1;
  const run = async () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    let page = null;
    try {
      const browser = await withTimeout(getBrowser(), ENGINE_WAIT_MS + OPEN_TIMEOUT_MS + 5000, 'Chrome start');
      page = await withTimeout(browser.newPage(), OPEN_TIMEOUT_MS, 'Chrome new tab');
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('data:') || u === 'about:blank') req.continue();
        else req.abort();
      });
      return await withTimeout(fn(page), OP_TIMEOUT_MS, 'report ' + (label || 'render'));
    } catch (err) {
      if (!err.code && WEDGED_RE.test(String(err.message))) {
        await killBrowser(err.message);
        err.code = 'engine_timeout';
        err.status = 503;
        err.hint = 'The PDF engine stopped responding (' + String(err.message).slice(0, 120) + ') and was restarted. Please try again.';
      }
      throw err;
    } finally {
      engine.queued = Math.max(0, engine.queued - 1);
      if (page) { try { await withTimeout(page.close(), 3000, 'close tab'); } catch (_) { /* ignore */ } }
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
    // Chart PNG resolution: 2x (~192 dpi on A4) stays sharp in print and renders
    // ~30% faster than 3x with a ~27% smaller PDF, which matters on a slow host CPU.
    const envDpr = Number(process.env.REPORTS_CHART_DPR);
    const dpr = envDpr >= 1 && envDpr <= 4 ? envDpr : 2;
    await page.evaluate((v) => { window.BB_REPORT_DPR = v; }, dpr);
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

/** Called by the report service after each render (success or failure). */
function noteRender(info) { engine.lastRender = info; }

function containerMemoryLimitMb() {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (/^[0-9]+$/.test(v)) {
        const mb = Math.round(Number(v) / 1048576);
        if (mb > 0 && mb < 1024 * 1024) return mb;
      }
    } catch (_) { /* not in a cgroup */ }
  }
  return null;
}

/** What the build-time installer (scripts/ensure-report-chrome.js) recorded, if anything. */
function readBuildMarker() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.cache', 'report-chrome-build.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Admin diagnostics: engine state, memory, and (test=true) a live one-page print. */
async function diagnostics(opts) {
  const mem = process.memoryUsage();
  const out = {
    engine: Object.assign({}, engine),
    exeExists: engine.exe ? fs.existsSync(engine.exe) : null,
    override: executablePath() || null,
    deploy: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
    cwd: process.cwd(),
    buildInstall: readBuildMarker(),
    node: process.version,
    platform: process.platform + '/' + process.arch,
    uptimeS: Math.round(process.uptime()),
    memoryMb: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
      containerLimit: containerMemoryLimitMb(),
      systemFree: Math.round(os.freemem() / 1048576),
      systemTotal: Math.round(os.totalmem() / 1048576)
    }
  };
  if (opts && opts.test) {
    const t0 = Date.now();
    try {
      const pdf = await withPage(async (page) => {
        await page.setContent('<!doctype html><p style="font-family:sans-serif">BodyBank report engine self-test</p>', { waitUntil: 'load' });
        return page.pdf({ format: 'A4' });
      }, 'self-test');
      out.test = { ok: true, ms: Date.now() - t0, bytes: pdf.length };
    } catch (err) {
      out.test = { ok: false, ms: Date.now() - t0, code: err.code || null, error: String(err.message).slice(0, 300) };
    }
    out.engine = Object.assign({}, engine);
  }
  return out;
}

async function close() {
  const p = browserPromise; browserPromise = null; browserGen += 1;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (p) { try { (await p).close(); } catch (_) { /* ignore */ } }
}

module.exports = { renderCharts, probeLayout, growFromProbe, finalize, htmlToPdf, close, ensureBrowser, diagnostics, noteRender };
