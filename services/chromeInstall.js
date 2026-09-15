'use strict';

/**
 * Installs the pinned headless Chrome for the Reports PDF engine.
 *
 * Shared by the build step (scripts/ensure-report-chrome.js) and the running
 * server (services/reportPdf.js ensureBrowser), so both always agree on where the
 * browser lives and how it gets there.
 *
 * Why not just `@puppeteer/browsers.install()`:
 *   - it unpacks the ~112 MB zip with a pure-JavaScript extractor inside the Node
 *     process. On a small host (Render, 512 MB / low CPU) that step crawled or
 *     stalled at "unpacking Chrome" while memory climbed. Here the archive is only
 *     downloaded by the library and then extracted by the system's native `unzip`
 *     (or Python's zipfile), with the JavaScript extractor as the last resort.
 *   - the default location (the project's .cache folder) did not reach the
 *     running instance on Render. The browser now lives in node_modules/.cache,
 *     which ships with the app by definition (see .puppeteerrc.cjs).
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultCacheDir() {
  return path.join(__dirname, '..', 'node_modules', '.cache', 'puppeteer');
}

/** Where the build step records what it did (read by the engine diagnostics). */
function markerPath() {
  return path.join(__dirname, '..', 'node_modules', '.cache', 'report-chrome-build.json');
}

/** The exact browser build Puppeteer expects, and where it must end up. */
function resolveTarget() {
  const puppeteer = require('puppeteer');
  const B = require('@puppeteer/browsers');
  const buildId = puppeteer.PUPPETEER_REVISIONS['chrome-headless-shell'];
  const cfg = puppeteer.configuration || (puppeteer.default && puppeteer.default.configuration) || {};
  const cacheDir = (process.env.PUPPETEER_CACHE_DIR || '').trim() || cfg.cacheDirectory || defaultCacheDir();
  const platform = B.detectBrowserPlatform();
  if (!platform) throw new Error('Unsupported platform for headless Chrome: ' + process.platform + '/' + process.arch);
  const opts = { browser: B.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform };
  const cache = new B.Cache(cacheDir);
  return {
    B,
    opts,
    buildId,
    cacheDir,
    platform,
    exe: B.computeExecutablePath(opts),
    installDir: cache.installationDir(opts.browser, platform, buildId),
    browserRoot: cache.browserRoot(opts.browser)
  };
}

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 10000 });
  return !(r.error && r.error.code === 'ENOENT');
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? String(err.message).slice(0, 300) : null, stderr: String(stderr || '').slice(0, 300) });
    });
  });
}

function chmodTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) chmodTree(p);
    else if (entry.isFile()) { try { fs.chmodSync(p, 0o755); } catch (_) { /* best effort */ } }
  }
}

/**
 * Extract with a native tool. Returns the method used, or null if none worked.
 * Native extraction is skipped on Windows unless REPORTS_FORCE_NATIVE_UNZIP=1
 * (tests), where the JavaScript extractor is fast enough.
 */
async function extractNative(archive, dest, log) {
  if (process.platform === 'win32' && process.env.REPORTS_FORCE_NATIVE_UNZIP !== '1') return null;
  fs.mkdirSync(dest, { recursive: true });
  if (commandExists('unzip')) {
    const r = await run('unzip', ['-q', '-o', archive, '-d', dest], EXTRACT_TIMEOUT_MS);
    if (r.ok) return 'unzip';
    log('native unzip failed: ' + (r.stderr || r.error));
  }
  for (const py of ['python3', 'python']) {
    if (!commandExists(py)) continue;
    const r = await run(py, ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, dest], EXTRACT_TIMEOUT_MS);
    if (r.ok) {
      chmodTree(dest); // zipfile does not restore execute permissions
      return py + ' zipfile';
    }
    log(py + ' zipfile extraction failed: ' + (r.stderr || r.error));
  }
  return null;
}

/**
 * Ensure the browser is installed. Idempotent.
 * @param {object} [o]
 * @param {(done:number,total:number)=>void} [o.onProgress] download progress in bytes
 * @param {(phase:string)=>void} [o.onPhase] 'downloading' | 'extracting'
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{exe, status:'already-installed'|'installed', method, target}>}
 */
async function installHeadlessShell(o) {
  const opt = o || {};
  const log = opt.log || (() => {});
  const phase = opt.onPhase || (() => {});
  const t = resolveTarget();
  const { B, opts, exe } = t;
  if (fs.existsSync(exe)) return { exe, status: 'already-installed', method: null, target: t };

  // A restart mid-install leaves a folder without the executable, or a truncated
  // archive. Both would poison the next attempt: start clean.
  if (fs.existsSync(t.installDir)) {
    log('removing a half-finished install: ' + t.installDir);
    try { await B.uninstall(opts); } catch (_) { /* fall through to rm */ }
    fs.rmSync(t.installDir, { recursive: true, force: true });
  }
  const removeArchives = () => {
    if (!fs.existsSync(t.browserRoot)) return;
    for (const f of fs.readdirSync(t.browserRoot)) {
      if (f.startsWith(t.buildId) && f.endsWith('.zip')) { try { fs.rmSync(path.join(t.browserRoot, f), { force: true }); } catch (_) { /* in use */ } }
    }
  };
  removeArchives();

  // A dropped connection mid-download (seen as ECONNRESET) must not fail the
  // whole install: retry with a short backoff, starting from a clean archive.
  phase('downloading');
  let archive = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      archive = await B.install(Object.assign({}, opts, { unpack: false, downloadProgressCallback: opt.onProgress }));
      break;
    } catch (err) {
      removeArchives();
      if (attempt === DOWNLOAD_ATTEMPTS) throw err;
      log(`Chrome download attempt ${attempt} failed (${String(err.message).split(String.fromCharCode(10)).pop().trim().slice(0, 120)}); retrying`);
      await sleep(attempt * 3000);
    }
  }
  if (typeof archive !== 'string' || !fs.existsSync(archive)) {
    if (fs.existsSync(exe)) return { exe, status: 'installed', method: 'library', target: t };
    throw new Error('Chrome download did not produce an archive');
  }

  phase('extracting');
  let method = await extractNative(archive, t.installDir, log);
  if (!method || !fs.existsSync(exe)) {
    if (method) log('native extraction finished but the executable is missing; using the built-in extractor');
    fs.rmSync(t.installDir, { recursive: true, force: true });
    await B.install(opts); // re-uses the downloaded archive, JavaScript extraction
    method = 'extract-zip';
  }
  try { fs.rmSync(archive, { force: true }); } catch (_) { /* keep going */ }
  if (!fs.existsSync(exe)) throw new Error('Chrome install finished but the executable is missing: ' + exe);
  try { fs.chmodSync(exe, 0o755); } catch (_) { /* Windows */ }
  return { exe, status: 'installed', method, target: t };
}

module.exports = { installHeadlessShell, resolveTarget, markerPath, defaultCacheDir, extractNative };
