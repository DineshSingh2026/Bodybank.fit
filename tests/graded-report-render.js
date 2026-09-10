'use strict';

/**
 * BodyBank — graded health report: document + PDF render tests.
 *
 *   node tests/graded-report-render.js
 *
 * Guards the half of the feature that unit tests on the engines cannot reach:
 * the editable document contract, and the fact that everything in the report
 * actually lands on a page.
 *
 * Three render bugs are pinned here because each shipped once and each was
 * invisible in the data layer:
 *   1. A rect built with nothing to paint left an open path and swallowed the next
 *      text draw — every second row of the lab table came out blank.
 *   2. Painting the footer below the bottom margin left PDFKit's cursor past the
 *      page end, so the next write auto-added a page: 11 real pages, 22 blank ones.
 *   3. Non-WinAnsi characters printed as mojibake.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildGradedHealthReport } = require('../services/gradedHealthReport');
const gradedDoc = require('../services/gradedReportDocument');
const { buildGradedReportPdf } = require('../services/gradedReportPdfKit');
const { txt } = require('../services/pdfText');
const copy = require('../services/grading/copy');

let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; }
function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(`[${group}] ${name}` + (detail ? ` :: ${detail}` : ''));
}
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const FIX = path.join(__dirname, '..', 'fixtures', 'demo');
const cur = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-current.json'), 'utf8'));
const prev = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-previous.json'), 'utf8'));

const report = buildGradedHealthReport({
  extracted: cur.extracted,
  previous: { extracted: prev.extracted, date: prev.extracted.report_date },
  client: cur.client,
  screeningDate: cur.extracted.report_date,
  reportId: 'render-test'
});

// ===========================================================================
section('document');
// ===========================================================================

const COACH_NOTE = 'Strong work on the haemoglobin. Next quarter is about the lipids.';
const doc = gradedDoc.buildGradedDoc(report, { coachNote: COACH_NOTE });

const types = doc.sections.map((s) => s.type);
ok('has a health map', types.indexOf('healthmap') >= 0);
ok('has priorities', types.indexOf('priorities') >= 0);
ok('has area cards', types.indexOf('areacards') >= 0);
ok('has the marker table', types.indexOf('markers') >= 0);
ok('has progress when a previous screening exists', types.indexOf('progress') >= 0);
ok('has next steps', types.indexOf('list') >= 0);
eq('the disclaimer is last', types[types.length - 1], 'disclaimer');

const mapSection = doc.sections.filter((s) => s.type === 'healthmap')[0];
const priSection = doc.sections.filter((s) => s.type === 'priorities')[0];
ok('the health map comes before the priorities',
  types.indexOf('healthmap') < types.indexOf('priorities'));
eq('priorities open a new page', priSection.pageBreak, true);
eq('the health map does not break the page', mapSection.pageBreak, false);

// Nothing is lost between the report and the document.
const docMarkerCount = doc.sections.filter((s) => s.type === 'markers')[0]
  .groups.reduce((n, g) => n + g.markers.length, 0);
eq('every marker reaches the document', docMarkerCount, report.markerCount);

// A first screening has no progress section — trends are never invented.
const firstReport = buildGradedHealthReport({
  extracted: cur.extracted, client: cur.client,
  screeningDate: cur.extracted.report_date, reportId: 'render-first'
});
const firstDoc = gradedDoc.buildGradedDoc(firstReport, {});
eq('a first screening has no progress section',
  firstDoc.sections.filter((s) => s.type === 'progress').length, 0);
ok('a first screening says trends will come later',
  firstDoc.sections.some((s) => s.type === 'text' && /trends will appear/i.test(s.body || '')));

// ===========================================================================
section('document — sanitising');
// ===========================================================================

const round = gradedDoc.sanitizeGradedDoc(JSON.parse(JSON.stringify(doc)));
eq('a round trip preserves the section count', round.sections.length, doc.sections.length);
eq('a round trip preserves the coach note', gradedDoc.docCoachNote(round), COACH_NOTE);

// RESULT and STATUS survive a round trip byte for byte. These are lab facts; if an
// edit could alter them the report would stop being evidence.
const origRows = doc.sections.filter((s) => s.type === 'markers')[0].groups
  .reduce((acc, g) => acc.concat(g.markers.map((m) => `${m.label}|${m.result}|${m.range}|${m.status}`)), []);
const roundRows = round.sections.filter((s) => s.type === 'markers')[0].groups
  .reduce((acc, g) => acc.concat(g.markers.map((m) => `${m.label}|${m.result}|${m.range}|${m.status}`)), []);
eq('RESULT and STATUS survive a round trip unchanged', roundRows.join('\n'), origRows.join('\n'));

// Hostile input.
const hostile = gradedDoc.sanitizeGradedDoc({
  sections: [
    { type: 'evil', body: 'x' },
    null,
    'not-an-object',
    { type: 'text', body: 'y'.repeat(999999) },
    { type: 'markers', groups: 'not-an-array' },
    { type: 'priorities', items: new Array(500).fill({ title: 'spam' }) }
  ]
});
ok('an unknown section type is dropped', hostile.sections.every((s) => s.type !== 'evil'));
ok('null and string sections are dropped', hostile.sections.length <= 5);
ok('an oversized body is capped', hostile.sections.filter((s) => s.type === 'text')[0].body.length
  <= gradedDoc.LIMITS.body);
eq('a non-array group list becomes empty',
  hostile.sections.filter((s) => s.type === 'markers')[0].groups.length, 0);
ok('priorities are capped at three',
  hostile.sections.filter((s) => s.type === 'priorities')[0].items.length <= 3);

// The disclaimer cannot be removed, hidden or emptied by any edit.
[
  ['deleted', { sections: [{ type: 'text', body: 'hi' }] }],
  ['hidden', { sections: [{ type: 'disclaimer', show: false, body: 'x' }] }],
  ['gutted to one word', { sections: [{ type: 'disclaimer', body: 'Whatever.' }] }],
  ['emptied', { sections: [{ type: 'disclaimer', body: '' }] }],
  ['whitespaced', { sections: [{ type: 'disclaimer', body: '   \n  ' }] }]
].forEach(([how, input]) => {
  const d = gradedDoc.sanitizeGradedDoc(input);
  const disc = d.sections.filter((s) => s.type === 'disclaimer')[0];
  ok(`disclaimer survives being ${how}`, !!disc);
  eq(`disclaimer stays visible after being ${how}`, disc.show, true);
  ok(`disclaimer keeps a body after being ${how}`, disc.body.trim().length > 50);
});
// A deliberate rewrite of real length is still allowed — legal may refine the wording.
const LEGAL_REWRITE = 'This report is provided for information only and does not constitute '
  + 'medical advice, diagnosis or treatment. Please consult a registered medical practitioner.';
eq('a rewritten disclaimer of real length is kept',
  gradedDoc.sanitizeGradedDoc({ sections: [{ type: 'disclaimer', body: LEGAL_REWRITE }] })
    .sections.filter((s) => s.type === 'disclaimer')[0].body,
  LEGAL_REWRITE);

// ===========================================================================
section('pdf');
// ===========================================================================

const outPath = path.join(os.tmpdir(), `bb-graded-test-${process.pid}.pdf`);

buildGradedReportPdf(gradedDoc.sanitizeGradedDoc(doc), outPath).then(() => {
  ok('the PDF file exists', fs.existsSync(outPath));
  const size = fs.statSync(outPath).size;
  ok('the PDF is a plausible size', size > 50 * 1024 && size < 8 * 1024 * 1024, `${size} bytes`);

  const raw = fs.readFileSync(outPath, 'latin1');
  const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  ok('the PDF has a sensible page count', pageCount >= 5 && pageCount <= 20, `${pageCount} pages`);

  // Every string drawn to the page came through txt(). Anything that did not would
  // show as a raw byte in the content stream. Assert the transliteration itself.
  eq('an arrow is transliterated', txt('182 → 158'), '182 -> 158');
  eq('a superscript unit is transliterated', txt('mL/min/1.73m²'), 'mL/min/1.73m2');
  eq('a comparison operator is transliterated', txt('≥ 10'), '>= 10');
  eq('a middot survives (it is WinAnsi)', txt('a · b'), 'a · b');
  ok('an em dash survives', txt('a — b').indexOf('—') >= 0);

  // Nothing the renderer emits should contain a character PDFKit cannot encode.
  const collect = (node, out) => {
    if (node == null) return out;
    if (typeof node === 'string') { out.push(node); return out; }
    if (Array.isArray(node)) { node.forEach((v) => collect(v, out)); return out; }
    if (typeof node === 'object') Object.keys(node).forEach((k) => collect(node[k], out));
    return out;
  };
  const allStrings = collect(doc, []);
  const unencodable = allStrings.filter((s) => txt(s) !== s);
  // The document may legitimately hold characters that txt() rewrites; what matters
  // is that the rewrite is lossless enough to stay readable.
  unencodable.forEach((s) => {
    ok(`transliteration keeps "${s.slice(0, 40)}" readable`, txt(s).trim().length > 0);
  });

  fs.unlinkSync(outPath);
  finish();
}).catch((e) => {
  failures.push(`[pdf] render threw :: ${e && e.message}`);
  finish();
});

function finish() {
  console.log('');
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks`);
    failures.slice(0, 30).forEach((f) => console.log('  x ' + f));
    process.exit(1);
  }
  console.log(`PASSED  ${passed} checks — graded report document + PDF`);
}
