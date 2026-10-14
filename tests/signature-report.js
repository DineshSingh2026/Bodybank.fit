'use strict';

/**
 * Signature reports — model, narrative, workflow gates and layout.   node tests/signature-report.js
 *
 * No database and no network: seeded bundles (tests/fixtures/reports/signatureSeed.js),
 * a stubbed fetch for the LLM, and a stubbed db for the workflow gates. The layout
 * part prints every variant in headless Chrome and fails on any page overflow.
 */

const S = require('../services/reportScore');
const M = require('../services/signatureReports/model');
const N = require('../services/signatureReports/narrative');
const T = require('../services/signatureReports/template');
const { createSignatureService } = require('../services/signatureReports/service');
const { seedSignature } = require('./fixtures/reports/signatureSeed');

let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; }
function ok(name, cond, detail) { if (cond) { passed += 1; return; } failures.push(`[${group}] ${name}` + (detail ? ` :: ${detail}` : '')); }
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

function build(type, variant, prevOverride) {
  const s = seedSignature(type, variant);
  return M.buildModel(s.bundle, s.extras, { previous: prevOverride === undefined ? s.previous : prevOverride, coachName: 'Kling' });
}

async function main() {
  // -------------------------------------------------------------------------
  section('score parity');
  for (const type of ['weekly', 'monthly']) {
    const s = seedSignature(type, 'normal');
    const classic = S.scoreDataset(s.bundle.current, s.bundle.previous, s.bundle.previous2, type);
    const m = M.buildModel(s.bundle, s.extras, { previous: s.previous });
    eq(`${type}: same BodyBank Score as the classic report`, m.score.total, classic.total);
    eq(`${type}: same grade`, m.score.grade, classic.grade);
    eq(`${type}: pages of data`, m.matrix.length, classic.period.days);
  }

  // -------------------------------------------------------------------------
  section('targets');
  for (const type of ['weekly', 'monthly']) {
    const m = build(type, 'normal');
    eq(`${type}: three targets`, m.targets.length, 3);
    ok(`${type}: distinct metrics`, new Set(m.targets.map((t) => t.metric)).size === 3);
    ok(`${type}: every target has a number`, m.targets.every((t) => /\d/.test(t.label)));
    ok(`${type}: points are positive`, m.targets.every((t) => t.points > 0), JSON.stringify(m.targets.map((t) => t.points)));
    ok(`${type}: lever is the biggest target`, m.lever && m.lever.points === Math.max(...m.targets.map((t) => t.points)));
    ok(`${type}: projection adds the points`, m.projection.projected >= m.projection.now && m.projection.projected <= 100);
    const perPillar = {};
    m.targets.forEach((t) => { const p = M.METRICS[t.metric].pillar; perPillar[p] = (perPillar[p] || 0) + 1; });
    ok(`${type}: at most two targets per pillar`, Object.values(perPillar).every((n) => n <= 2));
  }
  {
    const m = build('weekly', 'empty');
    eq('empty: still three targets', m.targets.length, 3);
    ok('empty: targets are small first steps', m.targets.every((t) => t.value <= 5), JSON.stringify(m.targets.map((t) => t.value)));
  }

  // -------------------------------------------------------------------------
  section('promise check');
  {
    const m = build('weekly', 'normal', { periodLabel: 'x', targets: [
      { metric: 'workouts', value: 1, label: 'a' }, { metric: 'workouts', value: 99, label: 'b' }, { metric: 'nope', value: 3, label: 'c' }
    ] });
    eq('hit when actual >= goal', m.promise.items[0].status, 'hit');
    eq('miss when far below', m.promise.items[1].status, 'miss');
    eq('unknown metric needs the coach', m.promise.items[2].status, 'manual');
    eq('kept count', m.promise.hit, 1);
    eq('scored count excludes manual', m.promise.of, 2);
    eq('no previous report -> no promise block', build('weekly', 'normal', null).promise, null);
  }

  // -------------------------------------------------------------------------
  section('patterns');
  {
    const m = build('monthly', 'normal');
    ok('finds at least one pattern on a full month', m.patterns.length >= 1);
    ok('at most three', m.patterns.length <= 3);
    ok('every pattern has two comparable values', m.patterns.every((p) => p.a && p.b && p.a.display && p.b.display));
    eq('no patterns from an empty month', build('monthly', 'empty').patterns.length, 0);
  }

  // -------------------------------------------------------------------------
  section('monthly extras');
  {
    const m = build('monthly', 'normal');
    ok('a score for every week of the month', m.weeks.length >= 4 && m.weeks.every((w) => w.score >= 0 && w.score <= 100));
    ok('journey weight start -> now', m.journey.weight && m.journey.weight.startKg > m.journey.weight.nowKg);
    ok('journey lifts first -> best', m.journey.lifts.length > 0 && m.journey.lifts.every((l) => l.bestKg >= l.firstKg));
    ok('week blueprint covers 7 days', m.blueprint && m.blueprint.days.length === 7);
    ok('touchpoints counted', m.touchpoints && m.touchpoints.total > 0);
    ok('renewal flag for the admin', m.review.some((f) => /Membership ends/.test(f.text)));
    ok('Sunday question surfaced to the admin', m.review.some((f) => /asked/.test(f.text)));
  }

  // -------------------------------------------------------------------------
  section('replan after coach edits');
  {
    const m = build('weekly', 'normal');
    const edited = N.applyTargetEdits(m.targets, [{ value: m.targets[0].baselineOf }, null, { custom: true, label: 'Book your blood test' }], m);
    const plan = M.replan(m, edited);
    ok('raised goal keeps its metric', plan.targets[0].metric === m.targets[0].metric);
    ok('raised goal is worth at least as much', plan.targets[0].points >= m.targets[0].points);
    eq('custom target has no metric', plan.targets[2].metric, null);
    eq('custom target carries no points', plan.targets[2].points, null);
    eq('custom label kept', plan.targets[2].label, 'Book your blood test');
  }

  // -------------------------------------------------------------------------
  section('narrative');
  {
    const m = build('weekly', 'normal');
    const r = await N.buildNarrative(m, { ai: false });
    eq('rules source', r.source, 'rules');
    ok('rules headline within limit', r.headline.length > 10 && r.headline.length <= N.LIMITS.headline);
    ok('rules letter within limit', r.letter.length > 80 && r.letter.length <= N.LIMITS.letter);
    ok('letter names the client', r.letter.includes(m.client.firstName));

    const facts = JSON.stringify(N.factsFor(m));
    const good = { headline: `Up ${m.score.totalDelta} points to ${m.score.total} this week.`, letter: `${m.client.firstName}, you trained ${m.stats.sessions} times and held your streak. Keep the weekend meals logged next week, because that is where your next points are. I am proud of how you showed up.` };
    const stub = (obj, status) => async () => ({ ok: (status || 200) < 400, status: status || 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 10 } }) });
    const ai = await N.buildNarrative(m, { apiKey: 'k', fetchImpl: stub(good) });
    eq('valid answer is used', ai.source, 'ai');
    eq('valid headline kept', ai.headline, good.headline);
    ok('facts carry the score', facts.includes(String(m.score.total)));

    const bad = await N.buildNarrative(m, { apiKey: 'k', fetchImpl: stub({ headline: 'Your diabetes risk dropped by 37%.', letter: 'You lost 9.4 kg and your disease markers improved. '.repeat(3) }) });
    eq('hostile answer falls back to rules', bad.source, 'rules');
    ok('no medical word reached the report', !/diabet|disease/i.test(bad.headline + bad.letter));
    ok('no invented number reached the report', !/9\.4|37%/.test(bad.headline + bad.letter));

    const boom = await N.buildNarrative(m, { apiKey: 'k', fetchImpl: async () => { throw new Error('network down'); } });
    eq('failed call -> rules', boom.source, 'rules');
    ok('failed call records the reason', /network down/.test(boom.aiError || ''));

    const mm = build('monthly', 'normal');
    const chap = await N.buildNarrative(mm, { apiKey: 'k', fetchImpl: stub({ headline: good.headline, letter: good.letter, chapter: 'The month 2 things changed' }) });
    ok('monthly chapter with a number is rejected', !/\d/.test(chap.chapter) && /^the month|fresh/i.test(chap.chapter));

    const ed = N.applyEdits(r, { headline: 'x'.repeat(500), ps: '' });
    eq('edits are clipped to the limit', ed.headline.length, N.LIMITS.headline);
    const empty = await N.buildNarrative(build('weekly', 'empty'), { ai: false });
    ok('empty week gets a fresh-start letter', /starting line/.test(empty.letter) && !/strongest pillar at 0/.test(empty.letter));
  }

  // -------------------------------------------------------------------------
  section('escaping');
  {
    const s = seedSignature('weekly', 'normal');
    s.bundle.user.name = '<script>alert(1)</script> Mehta';
    const m = M.buildModel(s.bundle, s.extras, { previous: s.previous });
    const html = T.render(m, { headline: '<img src=x onerror=alert(1)>', letter: 'hi', chapter: '', ps: '' }, {});
    ok('client name is escaped', !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'));
    ok('narrative is escaped', !html.includes('<img src=x'));
  }

  // -------------------------------------------------------------------------
  section('workflow gates');
  {
    const model = build('weekly', 'normal');
    const row = (status) => ({ id: 'rep_123456', user_id: 'u1', type: 'weekly', period_start: '2026-08-31', period_end: '2026-09-06', status, score: 86, grade: 'A', model_json: model, narrative_json: { headline: 'h', letter: 'l' }, client_name: 'A', client_email: 'a@x.io', client_phone: '+919800000000', client_first: 'A' });
    const mk = (status) => createSignatureService({ db: { queryOne: async (sql) => (/share_token = \?/.test(sql) ? { id: 'rep_123456', status, share_expires_at: new Date(Date.now() + 864e5).toISOString() } : row(status)), queryAll: async () => [], run: async () => ({}) }, sendMail: async () => true, uploadsDir: require('os').tmpdir() });
    let code = null;
    try { await mk('draft').send('rep_123456', { channels: ['email'] }); } catch (e) { code = e.status; }
    eq('a draft cannot be sent', code, 409);
    code = null;
    try { await mk('draft').pdfFor('rep_123456'); } catch (e) { code = e.status; }
    eq('a draft has no PDF', code, 409);
    code = null;
    try { await mk('sent').saveEdits('rep_123456', { headline: 'x' }); } catch (e) { code = e.status; }
    eq('a sent report cannot be edited', code, 409);
    code = null;
    try { await mk('sent').discard('rep_123456'); } catch (e) { code = e.status; }
    eq('a sent report cannot be discarded', code, 409);
    eq('member link refuses an approved-but-unsent report', await mk('approved').byShareToken('A'.repeat(32)), null);
    eq('member link refuses a draft', await mk('draft').byShareToken('A'.repeat(32)), null);
    eq('member link refuses a malformed token', await mk('sent').byShareToken('../../etc'), null);
  }

  // -------------------------------------------------------------------------
  section('layout (headless Chrome)');
  if (process.env.SKIP_PDF) {
    console.log('  (SKIP_PDF set — layout checks skipped)');
  } else {
    const { renderReport } = require('../services/signatureReports/render');
    const pdf = require('../services/reportPdf');
    try {
      for (const variant of ['normal', 'empty', 'extreme']) {
        for (const type of ['weekly', 'monthly']) {
          const m = build(type, variant);
          const nar = await N.buildNarrative(m, { ai: false });
          const out = await renderReport(m, nar, { pdf: false });
          const serious = (out.warnings || []).filter((w) => w.kind === 'page-overflow' || w.kind === 'block-outside-body');
          eq(`${type}/${variant}: page count`, out.pages, type === 'monthly' ? 6 : 3);
          ok(`${type}/${variant}: nothing overflows a page`, serious.length === 0, JSON.stringify(serious).slice(0, 300));
          const p = await renderReport(m, nar, { pdf: true });
          ok(`${type}/${variant}: PDF bytes`, p.pdf && p.pdf.length > 20000 && p.pdf.slice(0, 4).toString() === '%PDF');
        }
      }
    } finally { await pdf.close(); }
  }

  console.log(`\nsignature-report: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
