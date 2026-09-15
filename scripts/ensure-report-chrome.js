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

async function main() {
  if (process.env.REPORTS_SKIP_CHROME_INSTALL === '1') { console.log(TAG, 'skipped (REPORTS_SKIP_CHROME_INSTALL=1)'); return; }
  if ((process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '').trim()) { console.log(TAG, 'skipped (explicit Chrome path set)'); return; }

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
  if (fs.existsSync(exe)) { console.log(TAG, 'ready:', exe); return; }

  const dir = new B.Cache(cacheDir).installationDir(opts.browser, platform, buildId);
  if (fs.existsSync(dir)) {
    console.log(TAG, 'removing a half-finished download:', dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const t0 = Date.now();
  console.log(TAG, `installing chrome-headless-shell ${buildId} (${platform}) into ${cacheDir}`);
  await B.install(opts);
  if (!fs.existsSync(exe)) throw new Error('install finished but the executable is missing: ' + exe);
  console.log(TAG, `installed in ${Math.round((Date.now() - t0) / 1000)} s:`, exe);
}

main()
  .catch((err) => { console.warn(TAG, 'could not install Chrome now; the report engine will retry at runtime:', err.message); })
  .finally(() => { process.exitCode = 0; });
