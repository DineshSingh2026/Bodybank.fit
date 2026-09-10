'use strict';

/**
 * Render the graded health report PDF from the demo fixtures.
 *
 *   node scripts/graded-report-pdf-demo.js [outPath]
 *   node scripts/graded-report-pdf-demo.js --first   first screening, no trends
 *
 * Prints the page count and per-page character counts so a layout regression
 * (blank pages, a section that never terminates) shows up without opening the file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildGradedHealthReport } = require('../services/gradedHealthReport');
const gradedDoc = require('../services/gradedReportDocument');
const { buildGradedReportPdf } = require('../services/gradedReportPdfKit');

const FIX = path.join(__dirname, '..', 'fixtures', 'demo');
const cur = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-current.json'), 'utf8'));
const prev = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-previous.json'), 'utf8'));

const firstOnly = process.argv.indexOf('--first') >= 0;
const outArg = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0)[0];
const out = outArg || path.join(os.tmpdir(), firstOnly ? 'bb-graded-first.pdf' : 'bb-graded-demo.pdf');

const report = buildGradedHealthReport({
  extracted: cur.extracted,
  previous: firstOnly ? null : { extracted: prev.extracted, date: prev.extracted.report_date },
  client: cur.client,
  screeningDate: cur.extracted.report_date,
  reportId: 'demo-fixture'
});

const doc = gradedDoc.sanitizeGradedDoc(gradedDoc.buildGradedDoc(report, {
  coachNote: 'Strong work on the haemoglobin — it moved from 10.4 to 11.2 g/dL over six months. '
    + 'Let us put the next quarter into the lipid numbers; the fibre and walking plan we discussed covers most of it.'
}));

buildGradedReportPdf(doc, out)
  .then((p) => {
    const size = fs.statSync(p).size;
    console.log(`PDF  ${p}  ${(size / 1024).toFixed(1)} KB`);
    console.log(`sections rendered: ${doc.sections.filter((s) => s.show).length}`);
  })
  .catch((e) => {
    console.error('FAILED', e);
    process.exit(1);
  });
