'use strict';

/**
 * Reports insight service — rules, LLM validation and fallback.   node tests/report-insights.js
 *
 * The LLM is never called for real: fetch is replaced by stubs that return a
 * valid answer, a hostile answer (diagnosis language, invented numbers, wrong
 * shape), or throw. In every case a complete report narrative must come back,
 * and nothing unchecked may reach the client. No database, no network.
 */

const S = require('../services/reportScore');
const I = require('../services/reportInsights');
const F = require('./fixtures/reports/score-fixtures');
const { seedBundle } = require('./fixtures/reports/seed');

let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; }
function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(`[${group}] ${name}` + (detail ? ` :: ${detail}` : ''));
}
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

function fetchReturning(obj, status) {
  return async () => ({
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], usage: { input_tokens: 1000, output_tokens: 300 } })
  });
}

async function main() {
  const bundle = seedBundle('monthly', 'normal');
  const score = S.scoreDataset(bundle.current, bundle.previous, bundle.previous2, 'monthly');

  section('rules: one insight + one action per pillar');
  const rules = I.ruleInsights(score, bundle);
  for (const k of S.PILLARS) {
    ok(k + ' has insight', typeof rules[k].insight === 'string' && rules[k].insight.length > 10);
    ok(k + ' has action', typeof rules[k].action === 'string' && rules[k].action.length > 10);
    ok(k + ' insight within limit', rules[k].insight.length <= I.LIMITS.insight);
    ok(k + ' action within limit', rules[k].action.length <= I.LIMITS.action);
  }
  ok('weekend protein pattern detected on the seeded client', /Sat\/Sun/.test(rules.nutrition.insight), rules.nutrition.insight);
  eq('weekend protein action', rules.nutrition.action, 'Add one 30 g protein shake on weekend mornings.');

  section('empty week still yields every insight');
  {
    const { cur, prev } = F.emptyWeek();
    const s = S.scoreDataset(cur, prev, null, 'weekly');
    const r = I.ruleInsights(s, { targets: F.TARGETS, current: cur });
    ok('workout empty insight', /No workouts logged/.test(r.workout.insight));
    ok('nutrition empty action mentions logging', /logging is the fastest way to raise your score/.test(r.nutrition.action));
  }

  section('top movers');
  const mv = I.topMovers(score);
  eq('3 improvements', mv.improvements.length, 3);
  eq('3 to improve', mv.toImprove.length, 3);
  ok('improvements sorted by delta', mv.improvements.filter((x) => x.delta > 0).every((x, i, a) => i === 0 || a[i - 1].delta >= x.delta));
  ok('no to-improve item reads as a gain', mv.toImprove.every((x) => !/\+\d+ pts/.test(x.title)), JSON.stringify(mv.toImprove.map((x) => x.title)));

  section('blood section: informational, doctor flag');
  const blood = I.bloodSection(score, bundle);
  ok('available', blood.available);
  ok('flagged markers listed', blood.flagged.includes('Vitamin D (25-OH)'), JSON.stringify(blood.flagged));
  ok('HDL (range >= 40, value 43) is NOT flagged', !blood.flagged.includes('HDL Cholesterol'));
  ok('LDL (range <= 130, value 124) is NOT flagged', !blood.flagged.includes('LDL Cholesterol'));
  ok('behaviour link ends with the doctor flag', /discuss the flagged markers with your doctor\.$/i.test(blood.behaviourLink), blood.behaviourLink);
  ok('behaviour link says informational', /informational only/i.test(blood.behaviourLink));
  ok('behaviour link within limit', blood.behaviourLink.length <= I.LIMITS.bloodLink);
  ok('no medical claim words', !I.MEDICAL_RE.test(blood.behaviourLink));
  ok('key markers capped at 4', blood.keyMarkers.length <= 4);
  ok('table rows capped at 10', blood.rows.length <= 10);
  ok('every red row carries the doctor flag', blood.rows.filter((r) => r.light === 'red').every((r) => r.doctor));
  {
    const b2 = JSON.parse(JSON.stringify(bundle));
    b2.blood[1].ai.summary = 'This suggests early diabetes; start medication.';
    const bl = I.bloodSection(score, b2);
    eq('diagnosis-language AI summary is dropped', bl.aiSummary, '');
  }
  {
    const ex = seedBundle('monthly', 'extreme');
    const es = S.scoreDataset(ex.current, ex.previous, ex.previous2, 'monthly');
    const eb = I.bloodSection(es, ex);
    ok('extreme: doctor flag survives a huge marker list', /doctor\.$/.test(eb.behaviourLink), eb.behaviourLink.slice(-80));
    ok('extreme: link within limit', eb.behaviourLink.length <= I.LIMITS.bloodLink);
  }

  section('scorer null handling (regression)');
  {
    const markers = S.bloodMarkerStatus({
      period: { start: '2026-01-01', end: '2026-12-31' },
      blood: [
        { date: '2026-01-10', markers: [{ key: 'hdl', name: 'HDL', value: 38, low: 40, high: null }] },
        { date: '2026-06-10', markers: [{ key: 'hdl', name: 'HDL', value: 43, low: 40, high: null }] }
      ]
    });
    eq('open upper bound stays open', markers[0].high, null);
    eq('43 with range >= 40 is in range', markers[0].inRange, true);
    const r = S.scoreDataset({
      period: { start: F.START, end: F.END }, targets: F.TARGETS,
      checkins: [{ date: F.DAYS[0], source: 'derived', energy: 9, sleepH: null }]
    }, null, null, 'weekly');
    eq('a missing sleep value is not a 0 h night', r.pillars.checkin.metrics.avgSleepH, null);
  }

  section('LLM success path');
  {
    const facts = JSON.stringify({ total: score.total, grade: score.grade });
    const good = {
      summary: [
        `Aarav, your score this month is ${score.total} (${score.grade}).`,
        'Your workouts carried the month — keep that rhythm going.',
        'Weekend protein is the easiest place to pick up points next.'
      ],
      closingNote: 'Aarav, this was a strong month of showing up. I can see the work in your training and your check-ins. Next month, let us tighten weekend protein and add short yoga sessions on rest days. Message me any time.',
      targets: ['Complete 18 of 18 planned workouts.', 'Hit 150 g protein on 23 of 31 days.', 'Do 13 yoga sessions of 15 minutes.'],
      bloodLink: 'Several markers moved toward range while you logged most meals. This section is informational only. Please discuss the flagged markers with your doctor.'
    };
    const out = await I.buildInsights(score, bundle, { apiKey: 'test', fetchImpl: fetchReturning(good) });
    eq('source ai', out.source, 'ai');
    eq('no AI error', out.aiError, null);
    eq('summary used', out.summary[0], good.summary[0]);
    eq('targets used', out.targets[1], good.targets[1]);
    ok('facts contain score', facts.length > 0);
  }

  section('LLM hostile output -> field-level fallback');
  {
    const bad = {
      summary: ['You have diabetes.', 'x', 'y'],
      closingNote: 'Your weight dropped 17.3 kg which is amazing, keep going and you will reach 54.7 kg by next week for sure — we are so proud of the progress you are making here.',
      targets: ['Eat better', 'Sleep more', 'Train'],
      bloodLink: 'Your ferritin suggests anaemia.'
    };
    const out = await I.buildInsights(score, bundle, { apiKey: 'test', fetchImpl: fetchReturning(bad) });
    ok('diagnosis summary rejected', out.aiRejected.includes('summary'));
    ok('invented numbers in closing note rejected', out.aiRejected.includes('closingNote'));
    ok('unmeasurable targets rejected', out.aiRejected.includes('targets'));
    ok('medical blood link rejected', out.aiRejected.includes('bloodLink'));
    eq('falls back to rules when most fields fail', out.source, 'rules');
    ok('fallback summary has 3 lines', out.summary.length === 3);
    ok('fallback targets measurable', out.targets.every((t) => /\d/.test(t)));
    ok('blood link still carries the doctor flag', /doctor/i.test(out.blood.behaviourLink));
  }

  section('LLM dropped the doctor flag -> re-attached');
  {
    const v = I.validateNarrative(
      { summary: ['a', 'b', 'c'], closingNote: '', targets: [], bloodLink: 'Markers moved toward range while logging stayed steady.' },
      { summary: ['1', '2', '3'], closingNote: 'x'.repeat(100), targets: ['1', '2', '3'] },
      '{}',
      'Rule link. This section is informational only. Please discuss the flagged markers with your doctor.'
    );
    ok('doctor sentence appended', /doctor\.$/.test(v.bloodLink), v.bloodLink);
  }

  section('LLM failure never blocks a report');
  for (const [label, impl] of [
    ['throws', async () => { throw new Error('network down'); }],
    ['HTTP 529', fetchReturning({ error: { message: 'overloaded' } }, 529)],
    ['not JSON', fetchReturning('Sure! Here is your summary...')]
  ]) {
    const out = await I.buildInsights(score, bundle, { apiKey: 'test', fetchImpl: impl });
    eq(label + ': rules source', out.source, 'rules');
    ok(label + ': error recorded', !!out.aiError, String(out.aiError));
    eq(label + ': summary complete', out.summary.length, 3);
    eq(label + ': targets complete', out.targets.length, 3);
    ok(label + ': closing note present', out.closingNote.length > 80);
  }
  {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const out = await I.buildInsights(score, bundle, {});
    eq('no API key: rules source', out.source, 'rules');
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  }

  section('admin edits');
  {
    const base = await I.buildInsights(score, bundle, { ai: false });
    const e = I.applyEdits(base, { summary: 'Line one\nLine two\nLine three\nLine four', closingNote: 'y'.repeat(900), targets: ['A 1', '', 'B 2', 'C 3', 'D 4'] });
    eq('summary capped at 3 lines', e.summary.length, 3);
    eq('closing note capped', e.closingNote.length, I.LIMITS.closingNote);
    eq('empty targets dropped, capped at 3', JSON.stringify(e.targets), JSON.stringify(['A 1', 'B 2', 'C 3']));
    const same = I.applyEdits(base, {});
    eq('no edits -> unchanged summary', same.summary.join('|'), base.summary.join('|'));
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks`);
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`PASSED  ${passed} checks — report insights`);
}

main().catch((err) => { console.error(err); process.exit(1); });
