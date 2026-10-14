'use strict';

/**
 * Signature reports — model + narrative -> fitted HTML or PDF.
 *
 * Reuses the classic report engine in services/reportPdf.js (one shared,
 * network-blocked headless Chrome and its fit pass). Photos are the only
 * external input: shared progress photos are read from disk and downscaled in
 * Chrome, so the PDF stays small.
 */

const fs = require('fs');
const path = require('path');
const pdfSvc = require('../reportPdf');
const template = require('./template');

function photoSources(model, uploadsDir) {
  const out = [];
  for (const p of model.photos || []) {
    let src = p.src || null;
    if (!src && p.url) {
      try {
        const file = require('../reportData').resolvePhotoFile(p.url, uploadsDir);
        if (file) {
          const ext = path.extname(file).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
          src = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        }
      } catch (_) { src = null; }
    }
    if (src) out.push({ id: p.id, src, maxW: 700, maxH: 900 });
  }
  return out;
}

/**
 * @param model      signatureReports/model.buildModel() output
 * @param narrative  { headline, letter, chapter, ps }
 * @param opts       { pdf: boolean, uploadsDir }
 * @returns {{ html?, pdf?, pages, warnings, ms }}
 */
async function renderReport(model, narrative, opts) {
  const o = opts || {};
  const t0 = Date.now();
  let photos = {};
  const req = photoSources(model, o.uploadsDir);
  if (req.length) {
    try { photos = (await pdfSvc.renderCharts([], req, '')).photos || {}; } catch (_) { photos = {}; }
  }
  const html = template.render(model, narrative, { photos });
  if (o.pdf) {
    const out = await pdfSvc.htmlToPdf(html);
    return { pdf: out.pdf, pages: out.pages, warnings: out.warnings, ms: Date.now() - t0 };
  }
  const out = await pdfSvc.finalize(html);
  return { html: out.html, pages: out.pages, warnings: out.warnings, ms: Date.now() - t0 };
}

module.exports = { renderReport };
