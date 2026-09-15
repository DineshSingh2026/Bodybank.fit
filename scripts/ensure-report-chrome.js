'use strict';

/**
 * Build-time installer for the headless Chrome used by the Reports PDF engine.
 *
 * Runs as the root `postinstall`, so it executes on every `npm ci` / `npm install`
 * — including hosts whose build restores cached packages, where Puppeteer's own
 * postinstall does not run again.
 *
 * Installs the pinned chrome-headless-shell into node_modules/.cache/puppeteer
 * (ships with the app) using services/chromeInstall.js: download the archive,
 * extract it with the native `unzip` / Python, JavaScript extractor as fallback.
 * Idempotent, cleans half-finished installs, and records the outcome in
 * node_modules/.cache/report-chrome-build.json for the engine diagnostics.
 *
 * It never fails the install: if Chrome cannot be installed here, the report
 * engine retries at runtime.
 *
 * Skip with REPORTS_SKIP_CHROME_INSTALL=1, or by setting PUPPETEER_EXECUTABLE_PATH.
 */

const fs = require('fs');
const path = require('path');

const TAG = '[report-chrome]';
const record = { at: new Date().toISOString(), ok: false, status: 'started', cwd: process.cwd(), node: process.version };

function writeMarker(extra) {
  try {
    const CI = require('../services/chromeInstall');
    const file = CI.markerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.assign(record, extra || {}), null, 2));
  } catch (_) { /* diagnostics will report "no record" */ }
}

async function main() {
  if (process.env.REPORTS_SKIP_CHROME_INSTALL === '1') { console.log(TAG, 'skipped (REPORTS_SKIP_CHROME_INSTALL=1)'); writeMarker({ status: 'skipped' }); return; }
  if ((process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '').trim()) { console.log(TAG, 'skipped (explicit Chrome path set)'); writeMarker({ status: 'skipped-explicit-path' }); return; }

  let CI;
  try {
    require.resolve('puppeteer');
    require.resolve('@puppeteer/browsers');
    CI = require('../services/chromeInstall');
  } catch (_) {
    console.log(TAG, 'puppeteer is not installed — nothing to do');
    return;
  }

  const target = CI.resolveTarget();
  Object.assign(record, { buildId: target.buildId, platform: target.platform, cacheDir: target.cacheDir, exe: target.exe });
  const t0 = Date.now();
  let lastLogged = -1;
  const res = await CI.installHeadlessShell({
    log: (m) => console.log(TAG, m),
    onPhase: (p) => { if (p === 'downloading') console.log(TAG, `installing chrome-headless-shell ${target.buildId} (${target.platform}) into ${target.cacheDir}`); else console.log(TAG, p + '…'); },
    onProgress: (done, total) => {
      const pct = total ? Math.floor((done * 100) / total) : null;
      if (pct != null && pct >= lastLogged + 25) { lastLogged = pct; console.log(TAG, `download ${pct}% (${Math.round(done / 1048576)} of ${Math.round(total / 1048576)} MB)`); }
    }
  });
  const ms = Date.now() - t0;
  if (res.status === 'already-installed') console.log(TAG, 'ready:', res.exe);
  else console.log(TAG, `installed in ${Math.round(ms / 1000)} s (unpacked with ${res.method}):`, res.exe);
  writeMarker({ ok: true, status: res.status, method: res.method, ms });
}

main()
  .catch((err) => {
    console.warn(TAG, 'could not install Chrome now; the report engine will retry at runtime:', err.message);
    writeMarker({ ok: false, status: 'failed', error: String(err && err.message ? err.message : err).slice(0, 500) });
  })
  .finally(() => { process.exitCode = 0; });
