/**
 * Admin + operator dashboard test.
 * Run: node tests/staff-dashboards.js      (no dependencies, no server, no DB)
 *
 * Both the nutrition assessment and the multi-device wearable work shipped with
 * member-facing screens and per-member staff views, but with no presence on any
 * dashboard — so an admin on mobile, where the bbmd console IS the whole surface,
 * had no way to see that either feature existed. This suite covers the pieces that
 * fixes that, because they had no coverage at all:
 *
 *   1. /api/operator/overview actually queries and returns both features.
 *   2. bbmdRenderExtras()               — the admin mobile console.
 *   3. opRenderAssessmentsAndWearables()— the operator pulse screen.
 *   4. Both degrade to an honest dash against an OLD server payload, rather than
 *      rendering a row of zeros that would read as "nobody has done this".
 *   5. Cache-busting: a changed JS asset must carry a bumped ?v=, or returning
 *      staff are served the 7-day-cached old file and see none of this.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function check(cond, msg) {
  if (assert(cond, msg)) console.log('  OK   ' + msg);
  else console.log('  FAIL ' + msg);
}

const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const opConsole = fs.readFileSync(path.join(ROOT, 'public', 'js', 'operator-console.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. The API actually carries both features
 * ------------------------------------------------------------------ */

section('/api/operator/overview returns both features');
{
  const start = serverJs.indexOf("app.get('/api/operator/overview'");
  const end = serverJs.indexOf("app.get('/api/operator/", start + 10);
  const handler = serverJs.slice(start, end > start ? end : start + 20000);

  check(start > 0, 'the overview handler was found');
  check(/nutrition_assessments/.test(handler),
    'it queries nutrition_assessments — without this the dashboards have nothing to show');
  check(/readiness_daily/.test(handler),
    'it queries readiness_daily, so wearable adoption covers every provider');
  check(/wearable_uploads/.test(handler), 'it counts wearable uploads');
  check(/nutritionAssessments:/.test(handler), 'the response carries a nutritionAssessments block');
  check(/wearables:/.test(handler), 'the response carries a wearables block');
  check(/by_device/.test(handler),
    'and a per-device breakdown — the point of the multi-device work');

  // A missing table must not take the whole dashboard down with it.
  check(/safeOne/.test(handler),
    'the new counts are wrapped so an unmigrated deployment loses a number, not the dashboard');
  check(/review_status = 'blocked'/.test(handler),
    'needs-review counts the blocked safety flags, not merely completed forms');
  check(/source <> 'derived'/.test(handler),
    'wearable adoption excludes BodyBank-derived rows, which are not a worn device');

  // The feed is what makes either feature visible as activity.
  check(/type: 'assessment'/.test(handler), 'assessments appear in the live activity feed');
  check(/type: 'wearable'/.test(handler), 'watch imports appear in the live activity feed');
}

/* ------------------------------------------------------------------ *
 * A tiny DOM stub shared by both renderers
 * ------------------------------------------------------------------ */

function makeDom() {
  const els = {};
  const mk = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    className: '',
    parentNode: null,
    setAttribute() {},
    appendChild() {}
  });
  return {
    els,
    get: (id) => (els[id] || (els[id] = mk(id))),
    doc: {
      getElementById: (id) => (els[id] || (els[id] = mk(id))),
      createElement: (t) => mk('created-' + t)
    }
  };
}

/** A realistic payload from the new /api/operator/overview. */
const PAYLOAD = {
  stats: { total_clients: 40 },
  engagement: {},
  trends: {},
  nutritionAssessments: {
    total: 20, complete: 12, in_progress: 8, needs_review: 3, new_7d: 5, completion_rate: 60
  },
  wearables: {
    members: 14, active_7d: 9, uploads_7d: 6, days_total: 900, adoption_rate: 35,
    by_device: [
      { provider: 'whoop', members: 6, days: 400, last_date: '2026-09-01' },
      { provider: 'apple_health', members: 4, days: 300, last_date: '2026-09-01' },
      { provider: 'screenshot', members: 4, days: 200, last_date: '2026-08-30' }
    ]
  },
  feed: []
};

/* ------------------------------------------------------------------ *
 * 2. The admin mobile console
 * ------------------------------------------------------------------ */

section('bbmdRenderExtras — the admin MOBILE console');
{
  const i = indexHtml.indexOf('function bbmdRenderExtras');
  check(i > 0, 'bbmdRenderExtras was found in index.html');

  if (i > 0) {
    // Take just this function, to the start of the next top-level declaration.
    let end = indexHtml.indexOf('\nfunction ', i + 10);
    const endAsync = indexHtml.indexOf('\nasync function ', i + 10);
    if (endAsync > 0 && (endAsync < end || end < 0)) end = endAsync;
    const src = indexHtml.slice(i, end > i ? end : i + 6000);

    const dom = makeDom();
    const meters = {};
    const texts = {};
    const sandbox = {
      document: dom.doc,
      escapeHtml: (s) => String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      bbmdText: (id, val) => { texts[id] = String(val); },
      bbmdSetMeter: (fill, val, pct, label, tone) => { meters[fill] = { pct, label, tone }; },
      console
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'index.html:bbmdRenderExtras' });

    check(typeof sandbox.bbmdRenderExtras === 'function', 'it evaluates as a function');

    sandbox.bbmdRenderExtras(PAYLOAD, 40);

    check(meters.bbmdNaBar && meters.bbmdNaBar.pct === 60,
      'the assessment completion meter reflects the API (60%)');
    check(meters.bbmdNaBar && /12 \/ 20/.test(meters.bbmdNaBar.label),
      'and shows the real counts (12 / 20)');
    check(meters.bbmdWearBar && meters.bbmdWearBar.pct === 35,
      'the wearable adoption meter reflects the API (35%)');

    const mix = dom.get('bbmdDeviceMix').innerHTML;
    check(/Whoop/.test(mix) && /Apple health/i.test(mix),
      'the device mix names the actual devices in use');
    check(/lower confidence/.test(mix),
      'and flags screenshot-sourced members as lower confidence');
    check(!/lower confidence/.test(mix.split('Whoop')[1].split('<div')[0] || ''),
      'while a real device export is NOT flagged as lower confidence');

    // The regression that matters: an older server returns neither key.
    const dom2 = makeDom();
    const texts2 = {};
    const sandbox2 = Object.assign({}, sandbox, {
      document: dom2.doc,
      bbmdText: (id, val) => { texts2[id] = String(val); }
    });
    sandbox2.window = sandbox2;
    vm.createContext(sandbox2);
    vm.runInContext(src, sandbox2, { filename: 'bbmd-old-payload' });
    sandbox2.bbmdRenderExtras({ stats: {} }, 40);
    check(texts2.bbmdNaVal === '—' && texts2.bbmdWearVal === '—',
      'against an OLD server payload it shows a dash, not a misleading zero');
  }
}

/* ------------------------------------------------------------------ *
 * 3. The operator console
 * ------------------------------------------------------------------ */

section('opRenderAssessmentsAndWearables — the operator pulse screen');
{
  const i = opConsole.indexOf('function opRenderAssessmentsAndWearables');
  check(i > 0, 'opRenderAssessmentsAndWearables was found in operator-console.js');

  if (i > 0) {
    const stop = opConsole.indexOf('\nfunction opExtraStat');
    const helper = opConsole.slice(stop, opConsole.indexOf('\n}', stop + 10) + 2);
    const src = opConsole.slice(i, stop > i ? stop : i + 6000) + '\n' + helper;

    const dom = makeDom();
    const sandbox = {
      document: dom.doc,
      opEl: (id) => dom.get(id),
      opEsc: (s) => String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      console
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'operator-console.js:extras' });

    check(typeof sandbox.opRenderAssessmentsAndWearables === 'function', 'it evaluates as a function');

    sandbox.opRenderAssessmentsAndWearables(PAYLOAD);
    const out = dom.get('opExtras').innerHTML;

    check(/FitChef assessments/.test(out), 'the operator sees a FitChef assessment block');
    check(/Needs review/.test(out) && />3</.test(out),
      'including the 3 that need a human decision');
    check(/opLeadsView\('nutrition'\)/.test(out),
      'with a direct route to the flagged list');
    check(/Watch data/.test(out), 'the operator sees a watch data block');
    check(/Whoop/.test(out) && /Apple health/i.test(out), 'naming the devices actually in use');
    check(/lower confidence/.test(out), 'and marking screenshot data as lower confidence');

    // Old payload -> render nothing rather than zeros.
    const dom2 = makeDom();
    const sandbox2 = Object.assign({}, sandbox, { document: dom2.doc, opEl: (id) => dom2.get(id) });
    sandbox2.window = sandbox2;
    vm.createContext(sandbox2);
    vm.runInContext(src, sandbox2, { filename: 'op-old-payload' });
    sandbox2.opRenderAssessmentsAndWearables({ stats: {} });
    check(dom2.get('opExtras').innerHTML === '',
      'against an OLD server payload it renders nothing, not a row of zeros');
  }
}

/* ------------------------------------------------------------------ *
 * 3b. THE DUAL-PANE RULE
 *
 * The admin console has two entirely separate dashboards:
 *
 *   .admin-dash-page       mobile  — fed by /api/operator/overview
 *   .bb-desktop-dashboard  desktop — fed by /api/admin/overview
 *
 * and the desktop media query sets `.admin-dash-page { display:none !important }`.
 * A widget added to one pane is therefore INVISIBLE on the other. That is exactly
 * how nutrition assessments and watch data ended up unreachable on the web
 * console while being present on mobile. These checks fail loudly if either pane
 * loses them again.
 * ------------------------------------------------------------------ */

section('the dual-pane rule: BOTH admin dashboards carry both features');
{
  // The trap itself must still be true — if the swap is ever removed, the note
  // above stops applying and these tests should be revisited.
  check(/#tab-dashboard-section \.admin-dash-page\{display:none !important\}/.test(indexHtml),
    'desktop still hides the mobile pane, so both panes really are required');

  // --- desktop API ---
  const start = serverJs.indexOf("app.get('/api/admin/overview'");
  const end = serverJs.indexOf("\napp.get('/api/", start + 10);
  const handler = serverJs.slice(start, end > start ? end : start + 24000);
  check(start > 0, 'the DESKTOP overview handler was found');
  check(/nutritionAssessments:/.test(handler),
    '/api/admin/overview returns nutritionAssessments (desktop pane)');
  check(/wearables:/.test(handler),
    '/api/admin/overview returns wearables (desktop pane)');
  check(/type: 'assessment'/.test(handler) && /type: 'wearable'/.test(handler),
    'and both appear in the desktop activity feed');
  check(/safeOneA/.test(handler),
    'its counts are wrapped so an unmigrated deployment does not 500 the dashboard');

  // --- desktop renderer ---
  const adminHome = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin-home.js'), 'utf8');
  check(/d\.nutritionAssessments/.test(adminHome) && /d\.wearables/.test(adminHome),
    'admin-home.js reads both blocks off the payload');
  check(/'FitChef Assessment'/.test(adminHome), 'the desktop pane renders a FitChef Assessment tile');
  check(/'Need review'/.test(adminHome), 'and a Need review tile');
  check(/'Watch data'/.test(adminHome), 'and a Watch data tile');
  check(/nutritionassessment/.test(adminHome),
    'the assessment tiles link through to the Nutrition Assessment tab');

  // Render the real desktop tiles against a real-shaped payload.
  const ids = {};
  const sb = {
    document: { getElementById: (id) => (ids[id] = ids[id] || { id, innerHTML: '', classList: { add() {}, remove() {} }, style: {} }) },
    escapeHtml: (v) => String(v === null || v === undefined ? '' : v),
    switchTab() {}, apiCall: async () => ({}), console, setTimeout
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(adminHome, sb, { filename: 'admin-home.js' });
  sb.ahState.data = {
    roster: {}, pipeline: {}, inbox: {}, trends: {}, feed: [],
    nutritionAssessments: { total: 7, complete: 4, needs_review: 2, new_7d: 3 },
    wearables: { members: 5, uploads_7d: 2, by_device: [{ provider: 'whoop', members: 3 }, { provider: 'screenshot', members: 2 }] }
  };
  sb.renderAdminHome();
  const pipe = (ids.ahTilesPipeline && ids.ahTilesPipeline.innerHTML) || '';
  check(/FitChef Assessment/.test(pipe) && /Need review/.test(pipe) && /Watch data/.test(pipe),
    'all three tiles actually render on the desktop pane');
  check(/>7</.test(pipe) && />2</.test(pipe),
    'and they show the real numbers from the payload');
  check(/lower confidence/.test(pipe),
    'the watch tile flags screenshot-sourced members as lower confidence');

  // The regression that started all this: an old payload must not throw.
  sb.ahState.data = { roster: {}, pipeline: {}, inbox: {}, trends: {}, feed: [] };
  let threw = false;
  try { sb.renderAdminHome(); } catch (e) { threw = true; }
  check(!threw, 'an OLD server payload renders 0s rather than throwing and blanking the dashboard');
}

/* ------------------------------------------------------------------ *
 * 3c. Quick Access + the FitChef name
 * ------------------------------------------------------------------ */

section('Quick Access carries both features on every pane');
{
  const adminHome = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin-home.js'), 'utf8');

  // --- desktop quick access grid ---
  const qi = adminHome.indexOf('var AH_QUICK');
  const quick = adminHome.slice(qi, adminHome.indexOf('];', qi));
  check(/FitChef Assessment/.test(quick), 'desktop Quick Access has a FitChef Assessment entry');
  check(/Watch Data/.test(quick), 'desktop Quick Access has a Watch Data entry');
  check(/to: 'nutritionassessment'/.test(quick), 'and it routes to the assessment tab');

  // Render the real grid rather than trusting the array.
  const ids = {};
  const sb = {
    document: { getElementById: (id) => (ids[id] = ids[id] || { id, innerHTML: '', classList: { add() {}, remove() {} }, style: {} }) },
    escapeHtml: (v) => String(v === null || v === undefined ? '' : v),
    switchTab() {}, apiCall: async () => ({}), console, setTimeout
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(adminHome, sb, { filename: 'admin-home.js' });
  sb.renderAdminQuick();
  const grid = (ids.ahQuick && ids.ahQuick.innerHTML) || '';
  check(/FitChef Assessment/.test(grid) && /Watch Data/.test(grid),
    'both actually render as Quick Access buttons on desktop');

  // --- mobile quick access grid ---
  const mi = indexHtml.indexOf('id="bbmdQaGrid"');
  const mgrid = indexHtml.slice(mi, indexHtml.indexOf('</div>', indexHtml.indexOf('bbmd-qa-more', mi) - 400));
  check(/switchTab\('nutritionassessment'\)/.test(mgrid), 'mobile Quick Access links to the assessment tab');
  check(/Watch data/.test(mgrid), 'mobile Quick Access has a Watch data button');

  // --- operator quick access ---
  check(/function opRenderQuickAccess/.test(opConsole), 'the operator console has a Quick Access renderer');
  check(/id="opQuickAccess"/.test(indexHtml) && /id="opQuickBlock"/.test(indexHtml),
    'and the operator home carries its container');

  const dom = makeDom();
  const osb = {
    document: dom.doc,
    opEl: (id) => dom.get(id),
    opEsc: (s) => String(s === null || s === undefined ? '' : s),
    console
  };
  osb.window = osb;
  vm.createContext(osb);
  const qStart = opConsole.indexOf('function opRenderQuickAccess');
  const qEnd = opConsole.indexOf('\nfunction opExtraStat');
  vm.runInContext(opConsole.slice(qStart, qEnd), osb, { filename: 'op-quick' });
  osb.opRenderQuickAccess(PAYLOAD);
  const oq = dom.get('opQuickAccess').innerHTML;
  check(/FitChef assessments/.test(oq), 'operator Quick Access shows FitChef assessments');
  check(/Need review/.test(oq) && />3</.test(oq), 'with the live flagged count');
  check(/Watch data/.test(oq), 'and a Watch data tile');
  check(/opLeadsView\(&quot;nutrition&quot;\)/.test(oq), 'routing straight to the assessment list');
  check(dom.get('opQuickBlock').style.display === '', 'the block is revealed when data is present');

  // Old payload -> hide the block entirely rather than show false zeros.
  const dom2 = makeDom();
  const osb2 = Object.assign({}, osb, { document: dom2.doc, opEl: (id) => dom2.get(id) });
  osb2.window = osb2;
  vm.createContext(osb2);
  vm.runInContext(opConsole.slice(qStart, qEnd), osb2, { filename: 'op-quick-old' });
  osb2.opRenderQuickAccess({ stats: {} });
  check(dom2.get('opQuickBlock').style.display === 'none',
    'against an OLD server payload the block hides rather than claiming zero');
}

section('the feature is named FitChef Assessment throughout the staff UI');
{
  const adminHome = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin-home.js'), 'utf8');

  check(/>FitChef Assessment<\/div>/.test(indexHtml), 'the admin nav tab reads FitChef Assessment');
  check(/nutritionassessment: 'FitChef Assessment'/.test(indexHtml),
    'the section-label map reads FitChef Assessment (drives the breadcrumb)');
  check(/'FitChef Assessment'/.test(adminHome), 'the desktop tile reads FitChef Assessment');
  check(/FitChef assessments<\/button>/.test(indexHtml), 'the operator chip reads FitChef assessments');
  check(/FitChef assessments/.test(opConsole), 'the operator pulse block reads FitChef assessments');
  check(/'FitChef assessment — needs review'/.test(serverJs)
    && /'FitChef assessment completed'/.test(serverJs),
  'the activity feed labels read FitChef assessment');

  // The old bare wording must be gone from staff-facing copy. Comments and the
  // route/table names deliberately keep "nutrition_assessment" — that is the
  // schema, not a label.
  const staleTab = />Nutrition Assessment<\/div>/.test(indexHtml);
  check(!staleTab, 'no staff nav tab still reads the old "Nutrition Assessment"');
  check(!/>Nutrition assessments<\/button>/.test(indexHtml),
    'no staff chip still reads the old "Nutrition assessments"');
}

/* ------------------------------------------------------------------ *
 * 4. Device provenance in the per-member staff view
 * ------------------------------------------------------------------ */

section('the staff readiness view exposes device provenance');
{
  check(/This window mixes/.test(indexHtml),
    'a member who switched devices gets an explicit mixed-measurement warning');
  check(/hardware changing, not/.test(indexHtml),
    'and it says the step is the hardware, not a real change in recovery');
  check(/read from a screenshot by AI rather than from a device export/.test(indexHtml),
    'AI-read days are called out to staff as lower confidence');
  check(/sdnn_spot: 'SDNN spot check'/.test(indexHtml),
    'HRV methods are spelled out in words a coach can act on');
  check(!/Import a Whoop export, or check in daily/.test(indexHtml),
    'the empty-state copy no longer assumes Whoop is the only option');
}

/* ------------------------------------------------------------------ *
 * 5. Cache busting — the reason none of this was visible
 * ------------------------------------------------------------------ */

section('changed JS assets carry a bumped cache-busting version');
{
  // Production serves /public with maxAge 7d, so a changed .js that keeps its old
  // ?v= is invisible to every returning admin for a week. This asserts the two
  // files that actually changed were bumped past the versions that shipped stale.
  const opV = /js\/operator-console\.js\?v=(\d+)/.exec(indexHtml);
  const mhV = /js\/member-home\.js\?v=(\d+)/.exec(indexHtml);
  check(opV && Number(opV[1]) >= 12,
    'operator-console.js is past v11 (Quick Access changed) — now v' + (opV && opV[1]));
  const ahV = /js\/admin-home\.js\?v=(\d+)/.exec(indexHtml);
  check(ahV && Number(ahV[1]) >= 6,
    'admin-home.js is past v5 (Quick Access changed) — now v' + (ahV && ahV[1]));
  check(mhV && Number(mhV[1]) >= 7,
    'member-home.js is past v6 (was stale at v6) — now v' + (mhV && mhV[1]));

  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const cacheV = /bodybank-v(\d+)/.exec(sw);
  check(cacheV && Number(cacheV[1]) >= 76,
    'the service worker cache name is past v75 — now v' + (cacheV && cacheV[1]));

  // Every versioned asset reference must point at a file that exists, or the tag
  // silently 404s and the feature it carries never loads at all.
  const refs = indexHtml.match(/(?:src|href)="([a-zA-Z0-9/_.-]+\.(?:js|css))\?v=\d+"/g) || [];
  const missing = [];
  refs.forEach((tag) => {
    const m = /"([a-zA-Z0-9/_.-]+\.(?:js|css))\?/.exec(tag);
    if (!m) return;
    const rel = m[1].replace(/^\//, '');
    if (!fs.existsSync(path.join(ROOT, 'public', rel))) missing.push(rel);
  });
  check(missing.length === 0,
    'every versioned asset reference resolves to a real file'
    + (missing.length ? ' — missing: ' + missing.join(', ') : ' (' + refs.length + ' checked)'));
}

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log('\n' + '-'.repeat(60));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' of ' + checks + ' checks:');
  failures.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
console.log('--- All ' + checks + ' staff dashboard checks passed ---');
