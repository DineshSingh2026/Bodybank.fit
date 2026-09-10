'use strict';

/**
 * Print the graded health report built from the demo fixtures, as plain text.
 *
 * A fast way to see what the engines actually produce without a database, a PDF
 * viewer or a browser — used during development and when reviewing a rule change.
 *
 *   node scripts/graded-report-demo.js            current + previous (progress)
 *   node scripts/graded-report-demo.js --first    first screening, no trends
 *   node scripts/graded-report-demo.js --why      include the full grade rationale
 *
 * The fixtures under fixtures/demo/ are synthetic and carry a DEMO DATA watermark.
 */

const fs = require('fs');
const path = require('path');
const { buildGradedHealthReport } = require('../services/gradedHealthReport');

const FIX = path.join(__dirname, '..', 'fixtures', 'demo');
const cur = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-current.json'), 'utf8'));
const prev = JSON.parse(fs.readFileSync(path.join(FIX, 'screening-previous.json'), 'utf8'));

const firstOnly = process.argv.indexOf('--first') >= 0;
const showWhy = process.argv.indexOf('--why') >= 0;

const report = buildGradedHealthReport({
  extracted: cur.extracted,
  previous: firstOnly ? null : { extracted: prev.extracted, date: prev.extracted.report_date },
  client: cur.client,
  screeningDate: cur.extracted.report_date,
  reportId: 'demo-fixture'
});

const rule = (ch) => console.log(String(ch || '─').repeat(78));
const head = (t) => { console.log(''); rule('═'); console.log('  ' + t.toUpperCase()); rule('═'); };

console.log('');
rule('═');
console.log('  ' + report.reportTitle + '   [ ' + cur.watermark + ' ]');
console.log('  ' + report.client.name + ' · ' + report.client.age + ' · ' + report.client.sex +
  ' · screening ' + report.screeningDate);
rule('═');

if (report.criticalFindings.length) {
  head('results to review first');
  report.criticalFindings.forEach((f) => {
    console.log('  ! ' + f.displayName + ' — ' + f.result + ' (' + f.statusLabel + ')');
    console.log('    ' + f.nextStep);
  });
}

head('health map');
report.healthMap.forEach((a) => {
  const was = a.previousGrade ? '  (was ' + a.previousGrade + ')' : '';
  console.log('  [' + a.grade + ']  ' + a.label.padEnd(26) + a.gradeLabel.padEnd(24) + was);
});
report.notAssessed.forEach((a) => {
  console.log('  [ ]  ' + a.label.padEnd(26) + 'Not assessed — needs ' + a.needs);
});

head('key message');
console.log('  ' + report.keyMessage);
if (report.firstScreeningNote) console.log('  ' + report.firstScreeningNote);

head('top priorities');
if (!report.priorities.length) console.log('  (no qualifying findings — this section is not padded)');
report.priorities.forEach((p) => {
  console.log('');
  console.log('  ' + p.rank + '. ' + p.title + '   [' + p.grade + ' · ' + p.areaLabel + ']');
  console.log('     RESULT           ' + p.result);
  console.log('     STATUS           ' + p.statusLabel);
  console.log('     WHY IT MATTERS   ' + p.whyItMatters);
  console.log('     NEXT STEP        ' + p.nextStep);
  if (p.professionalNote) console.log('     >>               ' + p.professionalNote);
});

head('health areas');
report.areas.forEach((a) => {
  console.log('');
  console.log('  [' + a.grade + '] ' + a.label + ' — ' + a.gradeLabel);
  console.log('      ' + a.summary);
  if (a.trendLine) console.log('      TREND  ' + a.trendLine);
  a.keyFindings.slice(0, 4).forEach((m) => {
    console.log('      · ' + m.displayName.padEnd(26) + String(m.result).padEnd(18) + m.statusLabel);
  });
  console.log('      FOCUS  ' + a.focus);
  if (showWhy) a.gradeRationale.forEach((r) => console.log('        ~ ' + r));
});

if (report.progress) {
  head('your health progress');
  console.log('  ' + report.progress.previousDate + '  →  ' + report.progress.currentDate +
    '   (' + report.progress.intervalDays + ' days)');
  if (report.progress.shortInterval) console.log('  ' + report.progress.shortIntervalNote);
  const show = (title, list) => {
    console.log('');
    console.log('  ' + title + ' (' + list.length + ')');
    if (!list.length) { console.log('    —'); return; }
    list.forEach((m) => {
      const from = m.previous ? m.previous.value + ' → ' : '';
      console.log('    · ' + m.displayName.padEnd(28) + from + m.value + ' ' + (m.unit || ''));
    });
  };
  show('IMPROVED', report.progress.improved);
  show('NEEDS ATTENTION', report.progress.needsAttention);
  show('NEW FINDINGS', report.progress.newFindings);
  show('RESOLVED', report.progress.resolved);
  console.log('');
  console.log('  STABLE (' + report.progress.stable.length + '): ' +
    report.progress.stable.map((m) => m.displayName).join(', '));
}

head('detailed lab results');
report.markerGroups.forEach((g) => {
  console.log('');
  console.log('  ' + g.label);
  g.markers.forEach((m) => {
    console.log('    ' + m.displayName.padEnd(30) + String(m.result).padEnd(18) +
      String(m.range.text).padEnd(16) + m.statusLabel +
      (m.duplicate ? '  (repeat)' : '') +
      (m.range.source === 'BODYBANK_PREFERRED' ? '  *BB preferred' : ''));
  });
});

head('your next steps');
report.nextSteps.forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s.text));

head('disclaimer');
console.log('  ' + report.disclaimer);

console.log('');
rule();
console.log('  engine=' + report.engineVersion + '  ruleset=' + report.rulesetVersion +
  '  model=' + report.modelVersion);
console.log('  markers=' + report.markerCount + '  unmapped=' + report.unmappedCount);
rule();
console.log('');
