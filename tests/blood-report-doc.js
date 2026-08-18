'use strict';

/**
 * Blood PROGRESS REPORT document pipeline.
 *
 *   aligned comparison + AI verdict -> document -> (doctor edits) -> PDF
 *
 * Guards the contract the in-app report editor depends on: the default document
 * mirrors what the AI produced, an edited document survives sanitisation
 * unchanged, hostile input cannot break the renderer, and every hide/edit the
 * reviewer makes actually changes the printed page.
 *
 * Run:  node tests/blood-report-doc.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { alignReports } = require('../services/bloodComparisonService');
const {
  buildComparisonDoc,
  sanitizeComparisonDoc,
  docHasVisibleContent,
  docCoachNote,
  setDocCoachNote
} = require('../services/comparisonDocument');
const { buildComparisonReportPdf } = require('../services/comparisonReportPdfKit');

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(name + (detail ? ' :: ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------
function report(id, date, hb, ferritin, ldl) {
  return {
    id,
    created_at: date + 'T09:00:00Z',
    report_date: date,
    status: 'complete',
    ai_report: { overall_status: 'Fair' },
    extracted_blood_data: {
      panels: [
        { name: 'Complete Blood Count', markers: [
          { name: 'Hemoglobin', value: String(hb), unit: 'g/dL', reference_range: '13.5-17.5', status: hb < 13.5 ? 'Low' : 'Normal' },
          { name: 'Platelet Count', value: '250', unit: 'x10^3/uL', reference_range: '150-410', status: 'Normal' }
        ] },
        { name: 'Iron Studies', markers: [
          { name: 'Ferritin', value: String(ferritin), unit: 'ng/mL', reference_range: '30-400', status: ferritin < 30 ? 'Deficient' : 'Normal' }
        ] },
        { name: 'Lipid Profile', markers: [
          { name: 'LDL Cholesterol', value: String(ldl), unit: 'mg/dL', reference_range: '< 100', status: ldl > 100 ? 'High' : 'Normal' }
        ] }
      ]
    }
  };
}

const comparison = alignReports([
  report('r1', '2025-02-10', 12.1, 18, 148),
  report('r2', '2025-08-14', 13.9, 61, 112),
  report('r3', '2026-03-02', 14.6, 88, 96)
]);

const verdict = {
  overall_trajectory: 'Improving',
  trajectory_score_delta: 'Fair -> Good',
  executive_summary: 'Iron status corrected and lipids moved into a healthy band.',
  trajectory_narrative: 'Ferritin tripled from 18 to 88 ng/mL.',
  improvements: [{ marker: 'Ferritin', from: '18', to: '88', meaning: 'Stores restored.' }],
  concerns: [{ marker: 'Hemoglobin', from: '12.1', to: '14.6', level: 'Low', meaning: 'Keep monitoring.' }],
  unchanged_watch: [{ marker: 'Platelet Count', value: '250', note: 'Stable.' }],
  interventions_assessment: 'The iron protocol worked.',
  updated_recommendations: [{ area: 'Diet', action: 'Rajma twice weekly', reason: 'Sustains ferritin' }],
  updated_supplements: [
    { name: 'Ferrous ascorbate', action: 'Adjust', dose: '50 mg alt days', reason: 'Ferritin 88' },
    { name: 'Vitamin D3', action: 'Continue', dose: '2000 IU', reason: 'Seasonal cover' }
  ],
  next_retest: [{ test: 'Ferritin + CBC', when: '3 months', reason: 'Confirm maintenance' }],
  final_verdict: 'Strong progress.'
};

const baseArgs = {
  comparison,
  verdict,
  adminNotes: 'Keep the walks going.',
  user: { name: 'Rahul Sharma', age: '34', gender: 'Male', goal: 'Fat loss' }
};

// --------------------------------------------------------------------------
// 1. default document
// --------------------------------------------------------------------------
const doc = buildComparisonDoc(baseArgs);
const byId = (d, id) => (d.sections || []).filter((s) => s.id === id)[0];

eq('cover carries the patient name', doc.cover.fields.patientName, 'Rahul Sharma');
eq('cover carries the trajectory', doc.cover.trajectory.label, 'Improving');
ok('cover stats count the markers', doc.cover.stats.items.some((s) => s.value === String(comparison.markerCount)));
ok('sections are in print order',
  doc.sections.map((s) => s.id).join(',').indexOf('sec-trend,sec-narrative,sec-changes') === 0,
  doc.sections.map((s) => s.id).join(','));
eq('the disclaimer closes the report', doc.sections[doc.sections.length - 1].type, 'disclaimer');
eq('the coach note is carried in', docCoachNote(doc), 'Keep the walks going.');

const trend = byId(doc, 'sec-trend');
eq('one trend column per test', trend.columns.length, 3);
// Every marker travels into the document; only the interesting ones start visible,
// so a reviewer can switch a quiet marker back on without rebuilding anything.
const allMarkers = trend.panels.reduce((n, p) => n + p.markers.length, 0);
const shownMarkers = trend.panels.reduce((n, p) => n + p.markers.filter((m) => m.show).length, 0);
eq('all markers are carried', allMarkers, 4);
eq('only moved/flagged markers start visible', shownMarkers, 3);
ok('a stable in-range marker starts hidden',
  trend.panels[0].markers.filter((m) => /Platelet/.test(m.name))[0].show === false);
eq('marker values align to the columns', trend.panels[1].markers[0].values.map((v) => v.text).join('/'), '18/61/88');
eq('trend direction is carried', trend.panels[1].markers[0].trend.dir, 'improving');

eq('supplements become a table', byId(doc, 'sec-supplements').rows.length, 2);
eq('empty verdict fields hide their section',
  buildComparisonDoc({ comparison, verdict: {}, adminNotes: '', user: {} }).sections
    .filter((s) => s.id === 'sec-changes')[0].show, false);

// --------------------------------------------------------------------------
// 2. sanitisation
// --------------------------------------------------------------------------
const round = sanitizeComparisonDoc(JSON.parse(JSON.stringify(doc)));
ok('a default document survives sanitising unchanged', JSON.stringify(round) === JSON.stringify(doc));
ok('sanitising is idempotent', JSON.stringify(sanitizeComparisonDoc(round)) === JSON.stringify(round));

const junk = sanitizeComparisonDoc({
  sections: [{ type: 'nope', title: 42 }, null, 'string', 7,
    { type: 'table', columns: 'bad', rows: 'worse' },
    { type: 'cards', groups: [{ items: [{ level: 'Fake' }] }] }]
});
eq('unusable entries are dropped', junk.sections.length, 3);
eq('an unknown type falls back to text', junk.sections[0].type, 'text');
eq('a non-array column list becomes empty', junk.sections[1].columns.length, 0);
eq('an invalid level is discarded', junk.sections[2].groups[0].items[0].level, '');
ok('a junk document is still renderable', docHasVisibleContent(junk) === true);
ok('sanitising never throws on nonsense', (function () {
  try { sanitizeComparisonDoc(null); sanitizeComparisonDoc([]); sanitizeComparisonDoc('x'); return true; }
  catch (e) { return false; }
})());

eq('an all-hidden document reports no content',
  docHasVisibleContent(sanitizeComparisonDoc({ cover: { show: false }, sections: [] })), false);

// --------------------------------------------------------------------------
// 3. the coach-note bridge (notes can be saved outside the editor)
// --------------------------------------------------------------------------
const stripped = { ...doc, sections: doc.sections.filter((s) => s.id !== 'sec-coach-note') };
const readded = setDocCoachNote(stripped, 'Re-added note');
eq('the note comes back', docCoachNote(readded), 'Re-added note');
ok('and lands before the disclaimer',
  readded.sections.findIndex((s) => s.id === 'sec-coach-note') <
  readded.sections.findIndex((s) => s.type === 'disclaimer'));
ok('setDocCoachNote does not mutate its input',
  stripped.sections.findIndex((s) => s.id === 'sec-coach-note') === -1);
eq('clearing the note hides the section',
  setDocCoachNote(doc, '').sections.filter((s) => s.id === 'sec-coach-note')[0].show, false);

// --------------------------------------------------------------------------
// 4. rendering — the reviewer's edits must reach the page
// --------------------------------------------------------------------------
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-progress-'));

async function render(name, d) {
  const out = path.join(outDir, name + '.pdf');
  await buildComparisonReportPdf({ doc: d }, out);
  const size = fs.statSync(out).size;
  ok('renders ' + name, size > 5000, size + ' bytes');
  return out;
}

(async function run() {
  await render('default', doc);

  // A legacy caller that still passes raw comparison + verdict must keep working.
  const legacy = path.join(outDir, 'legacy.pdf');
  await buildComparisonReportPdf({
    user: baseArgs.user, comparison, verdict, adminNotes: baseArgs.adminNotes
  }, legacy);
  ok('renders the legacy payload shape', fs.statSync(legacy).size > 5000);

  // Hide a section, a whole test column, a table row and a table column; re-enable a
  // quiet marker; add a section. All of it must survive sanitising.
  const edited = JSON.parse(JSON.stringify(doc));
  byId(edited, 'sec-changes').show = false;
  byId(edited, 'sec-trend').columns[1].show = false;
  byId(edited, 'sec-trend').panels[2].show = false;
  byId(edited, 'sec-trend').panels[0].markers[1].show = true;
  byId(edited, 'sec-supplements').rows[1].show = false;
  byId(edited, 'sec-supplements').columns[2].show = false;
  edited.cover.stats.items[2].show = false;
  edited.sections.splice(2, 0, {
    id: 'sec-custom', type: 'text', show: true, pageBreak: true,
    title: 'Physician Addendum', subtitle: '',
    badge: { show: true, label: 'REVIEWED BY', text: 'Dr. A. Menon' },
    align: 'justify', body: 'Reviewed in clinic.'
  });
  const clean = sanitizeComparisonDoc(edited);
  eq('the added section survives the save', clean.sections.filter((s) => s.id === 'sec-custom').length, 1);
  eq('the hidden section stays hidden', byId(clean, 'sec-changes').show, false);
  eq('the re-enabled marker stays on', byId(clean, 'sec-trend').panels[0].markers[1].show, true);
  await render('edited', clean);

  // Cover off, everything hidden but the disclaimer: must not emit a blank first page.
  const bare = JSON.parse(JSON.stringify(doc));
  bare.cover.show = false;
  bare.sections.forEach((s) => { s.show = false; });
  bare.sections.filter((s) => s.type === 'disclaimer')[0].show = true;
  await render('bare', sanitizeComparisonDoc(bare));

  // A completely empty document is a reviewer mistake, not a crash.
  await render('empty', sanitizeComparisonDoc({ cover: { show: false }, sections: [] }));

  // PDFKit's Helvetica is WinAnsi-only: characters outside it must be transliterated
  // rather than emitted as raw bytes (which used to turn "→" into "!’").
  const uni = JSON.parse(JSON.stringify(doc));
  uni.cover.trajectory.summary = 'Target ≥5 µg → 10 µg. Platelets 250×10⁹/L, cost ₹1200.';
  await render('unicode', sanitizeComparisonDoc(uni));

  fs.rmSync(outDir, { recursive: true, force: true });

  console.log('\nblood-report document pipeline');
  console.log('  passed: ' + passed);
  if (failures.length) {
    console.log('  FAILED: ' + failures.length);
    failures.forEach((f) => console.log('    x ' + f));
    process.exit(1);
  }
  console.log('  all good\n');
})().catch((e) => {
  console.error('threw:', e);
  process.exit(1);
});
