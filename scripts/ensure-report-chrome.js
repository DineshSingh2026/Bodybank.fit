'use strict';

/**
 * Build-time installer for the headless Chrome used by the Reports PDF engine.
 *
 * Runs as the root `postinstall`, so it executes on every `npm ci` / `npm install`
 * — including hosts (Render) whose build restores cached packages, where
 * Puppeteer's own postinstall does not run again and the browser is never
 * downloaded. That is what left production with "Could not find Chrome" and then
 * a slow runtime download on every restart.
 *
 * Installs the exact pinned chrome-headless-shell into ./.cache/puppeteer (see
 * .puppeteerrc.cjs), which ships with the build. Idempotent: an existing browser
 * is reused, a half-finished download folder is removed first.
 *
 * It never fails the install. If the download is impossible here, the report
 * engine still retries at runtime (services/reportPdf.js ensureBrowser).
 *
 * Skip with REPORTS_SKIP_CHROME_INSTALL=1, or by setting PUPPETEER_EXECUTABLE_PATH.
 */

const fs = require('fs');
const path = require('path');

const TAG = '[report-chrome]';

// A record of what this build did, read by the report engine's diagnostics at
// runtime (so "did the build install Chrome, and where?" has a definite answer).
const MARKER = path.join(__dirname, '..', '.cache', 'report-chrome-build.json');
const record = { at: new Date().toISOString(), ok: false, status: 'started', cwd: process.cwd(), node: process.version };
function writeMarker(extra) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify(Object.assign(record, extra || {}), null, 2));
  } catch (_) { /* read-only build dir: diagnostics will say "no marker" */ }
}

async function main() {
  if (process.env.REPORTS_SKIP_CHROME_INSTALL === '1') { console.log(TAG, 'skipped (REPORTS_SKIP_CHROME_INSTALL=1)'); writeMarker({ status: 'skipped' }); return; }
  if ((process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '').trim()) { console.log(TAG, 'skipped (explicit Chrome path set)'); writeMarker({ status: 'skipped-explicit-path' }); return; }

  let puppeteer;
  let B;
  try {
    puppeteer = require('puppeteer');
    B = require('@puppeteer/browsers');
  } catch (err) {
    console.log(TAG, 'puppeteer is not installed — nothing to do');
    return;
  }

  const buildId = puppeteer.PUPPETEER_REVISIONS['chrome-headless-shell'];
  const cfg = puppeteer.configuration || (puppeteer.default && puppeteer.default.configuration) || {};
  const cacheDir = (process.env.PUPPETEER_CACHE_DIR || '').trim()
    || cfg.cacheDirectory
    || path.join(__dirname, '..', '.cache', 'puppeteer');
  const platform = B.detectBrowserPlatform();
  if (!platform) { console.warn(TAG, 'unsupported platform', process.platform, process.arch); return; }

  const opts = { browser: B.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform };
  const exe = B.computeExecutablePath(opts);
  Object.assign(record, { buildId, platform, cacheDir, exe, envCacheDir: process.env.PUPPETEER_CACHE_DIR || null });
  if (fs.existsSync(exe)) { console.log(TAG, 'ready:', exe); writeMarker({ ok: true, status: 'already-installed' }); return; }

  const dir = new B.Cache(cacheDir).installationDir(opts.browser, platform, buildId);
  if (fs.existsSync(dir)) {
    console.log(TAG, 'removing a half-finished download:', dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const t0 = Date.now();
  console.log(TAG, `installing chrome-headless-shell ${buildId} (${platform}) into ${cacheDir}`);
  let lastLogged = -1;
  await B.install(Object.assign({}, opts, {
    downloadProgressCallback: (done, total) => {
      const pct = total ? Math.floor((done * 100) / total) : null;
      if (pct != null && pct >= lastLogged + 25) { lastLogged = pct; console.log(TAG, `download ${pct}% (${Math.round(done / 1048576)} of ${Math.round(total / 1048576)} MB)`); }
    }
  }));
  if (!fs.existsSync(exe)) throw new Error('install finished but the executable is missing: ' + exe);
  const ms = Date.now() - t0;
  console.log(TAG, `installed in ${Math.round(ms / 1000)} s:`, exe);
  writeMarker({ ok: true, status: 'installed', ms });
}

main()
  .catch((err) => {
    console.warn(TAG, 'could not install Chrome now; the report engine will retry at runtime:', err.message);
    writeMarker({ ok: false, status: 'failed', error: String(err && err.message ? err.message : err).slice(0, 500) });
  })
  .finally(() => { process.exitCode = 0; });
