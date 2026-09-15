'use strict';

/**
 * Puppeteer config — used by the admin Reports module (services/reportPdf.js).
 *
 * The browser lives in node_modules/.cache/puppeteer. node_modules ships with the
 * app on every host by definition; the project's own .cache folder did not reach
 * the running instance on Render. It is installed at build time by
 * scripts/ensure-report-chrome.js (root postinstall) and, failing that, by the
 * server at runtime (services/chromeInstall.js). Only the small headless shell is
 * fetched; the full Chrome is not needed to print PDFs.
 *
 * Local override: set PUPPETEER_EXECUTABLE_PATH (or CHROME_PATH) to use an
 * installed Chrome instead.
 */
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
  chrome: { skipDownload: true },
  'chrome-headless-shell': { skipDownload: false }
};
