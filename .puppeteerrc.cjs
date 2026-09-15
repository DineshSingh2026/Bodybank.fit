'use strict';

/**
 * Puppeteer config — used by the admin Reports module (services/reportPdf.js).
 *
 * The browser is downloaded INTO the project (./.cache/puppeteer) at `npm ci`
 * time. Render only ships the project directory from the build to the running
 * instance, so the default ~/.cache location would leave production without a
 * browser. Only the small headless shell is fetched; the full Chrome is not
 * needed to print PDFs.
 *
 * Local override: set PUPPETEER_EXECUTABLE_PATH (or CHROME_PATH) to use an
 * installed Chrome instead.
 */
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  chrome: { skipDownload: true },
  'chrome-headless-shell': { skipDownload: false }
};
