/**
 * Device-picker UI test.
 * Run: node tests/wearables-ui.js      (no dependencies, no server, no DB, no browser)
 *
 * The upload modal lives inline in public/index.html, so it has never had a test.
 * That is the layer most likely to drift away from the API without anyone noticing:
 * the backend can be perfect and the member still sees a Whoop-only button.
 *
 * This suite extracts the modal's script block straight out of index.html, runs it
 * against a stub DOM, and asserts the things a member would actually experience —
 * that they are asked which watch they own before any file is read, that a device
 * we cannot parse is visibly unavailable rather than silently broken, that the file
 * picker offers the extensions that device really produces, and that AI-read numbers
 * are labelled as such before anything is saved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

/* ------------------------------------------------------------------ *
 * Extract the real modal script out of index.html
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

const START = 'var whoop = { file: null';
const END = 'window.bbAdminRefFilter';
const i = html.indexOf(START);
const j = html.indexOf(END);

section('the upload modal script can still be located in index.html');
check(i > 0 && j > i, 'found the wearable upload block (' + (j - i) + ' chars)');
if (i < 0 || j <= i) {
  console.log('\nCannot continue without the script block.');
  process.exit(1);
}
const source = html.slice(i, j);

/* ------------------------------------------------------------------ *
 * A DOM stub just rich enough for the modal
 * ------------------------------------------------------------------ */

function makeEl(id) {
  return { id: id, innerHTML: '', className: '', style: {}, classList: { add() {}, remove() {} } };
}

const els = {};
function getEl(id) {
  if (!els[id]) els[id] = makeEl(id);
  return els[id];
}

/** Every endpoint the modal calls, in order, with its payload. */
const calls = [];
let catalogResponse = null;

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  document: {
    getElementById: (id) => getEl(id)
  },
  alert: () => {},
  confirm: () => true,
  esc: (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  num: (n) => String(n === null || n === undefined ? 0 : n),
  apiCall: async (method, url, body) => {
    calls.push({ method, url, body });
    if (url === '/api/wearables/devices') return catalogResponse;
    if (url === '/api/wearables/connection') return { connection: null };
    return { ok: true };
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'index.html:wearable-modal' });

section('the modal exposes the device-picker entry points');
check(typeof sandbox.bbOpenWhoop === 'function', 'bbOpenWhoop is defined');
check(typeof sandbox.bbPickDevice === 'function', 'bbPickDevice is defined — the device step exists');
check(typeof sandbox.bbWhoopPick === 'function', 'bbWhoopPick is defined');

/* ------------------------------------------------------------------ *
 * The catalog the real GET /api/wearables/devices returns
 * ------------------------------------------------------------------ */

// Built from the live registry rather than hand-written, so this test fails when
// the registry and the UI drift apart instead of quietly passing on stale copy.
let registry = null;
try { registry = require('../services/wearables/deviceRegistry'); } catch (e) { /* optional */ }

const devices = registry
  ? registry.listDevices().map((d) => ({
    id: d.id,
    label: d.label,
    shortLabel: d.shortLabel,
    tier: d.tier,
    ingest: d.ingest,
    exportInstructions: d.exportInstructions,
    caveats: d.caveats,
    // Pretend Polar is not deployed here, to prove the UI disables it.
    supported: d.id !== 'polar'
  }))
  : [{ id: 'whoop', label: 'Whoop', tier: 'full', ingest: ['zip', 'csv', 'pdf'], supported: true }];

const budgetBands = registry && typeof registry.listBudgetBands === 'function'
  ? registry.listBudgetBands()
  : [];

catalogResponse = { ok: true, devices: devices, budgetBands: budgetBands };

/* ------------------------------------------------------------------ *
 * Step 1 — the member is asked which watch they own
 * ------------------------------------------------------------------ */

const main = (async () => {
  sandbox.currentUser = { token: 'test-token' };
  await sandbox.bbOpenWhoop();
  const body = getEl('bbWhoopBody');

  section('step 1: the member picks a device before any file is read');
  check(/Which device do you wear/.test(body.innerHTML),
    'the picker asks which device, rather than assuming Whoop');
  check(calls.some((c) => c.url === '/api/wearables/devices'),
    'the device list is fetched from the API, not hardcoded in the page');

  // No file input yet — a file must never be readable before a device is declared,
  // because a file parsed as the wrong brand produces confident nonsense.
  check(!/type="file"/.test(body.innerHTML),
    'no file input is offered until a device is chosen');

  const listed = devices.filter((d) => d.id !== 'manual');
  const shown = listed.filter((d) => body.innerHTML.indexOf(d.shortLabel || d.label) !== -1);
  check(shown.length === listed.length,
    'every device from the registry is offered (' + shown.length + '/' + listed.length + ')');

  check(/disabled/.test(body.innerHTML),
    'a device this deployment cannot parse is visibly disabled, not silently broken');

  section('step 1: bands with no export are represented honestly');
  if (budgetBands.length) {
    check(/no data export at all/.test(body.innerHTML),
      'budget bands are described as having no export, not quietly omitted');
    check(/bbPickDevice\('screenshot'\)/.test(body.innerHTML),
      'and are routed to the screenshot path instead');
    check(/show you every number before saving/.test(body.innerHTML),
      'and the member is promised a review step before anything is saved');
  } else {
    console.log('  SKIP registry exposes no budget bands');
  }

  /* ---------------------------------------------------------------- *
   * Step 2 — the chosen device's real instructions and real limits
   * ---------------------------------------------------------------- */

  section('step 2: choosing a device shows ITS instructions, not generic copy');
  sandbox.bbPickDevice('fitbit');
  const fit = getEl('bbWhoopBody').innerHTML;
  const fitbit = devices.filter((d) => d.id === 'fitbit')[0];

  if (fitbit) {
    check(fit.indexOf('Takeout') !== -1 || (fitbit.exportInstructions
      && fit.indexOf(sandbox.esc(fitbit.exportInstructions).slice(0, 30)) !== -1),
    'Fitbit shows Fitbit-specific export instructions');
    check(/type="file"/.test(fit), 'the file picker appears once a device is chosen');
    check(/\.json/.test(fit),
      'the accept list includes .json — Fitbit exports JSON, not CSV');
    if ((fitbit.caveats || []).length) {
      check(fit.indexOf(sandbox.esc(fitbit.caveats[0]).slice(0, 30)) !== -1,
        'the device\'s honest caveats are shown BEFORE upload, not inferred after');
    }
  }
  check(/Change device/.test(fit), 'the member can go back and change device');

  section('step 2: the accept list matches what each device actually produces');
  sandbox.bbPickDevice('apple_health');
  const apple = getEl('bbWhoopBody').innerHTML;
  check(/\.xml/.test(apple), 'Apple offers .xml');

  sandbox.bbPickDevice('screenshot');
  const shot = getEl('bbWhoopBody').innerHTML;
  check(/\.png/.test(shot) && /\.jpg/.test(shot), 'the screenshot path offers image extensions');
  check(!/\.zip/.test(shot), 'and does NOT offer .zip, which it cannot read');

  /* ---------------------------------------------------------------- *
   * The endpoints
   * ---------------------------------------------------------------- */

  section('the modal calls the universal endpoints, carrying the device');
  check(/wearables\/upload\/preview/.test(source),
    'preview posts to /api/wearables/upload/preview');
  check(/wearables\/upload\/commit/.test(source),
    'commit posts to /api/wearables/upload/commit');
  check(/device: whoop\.device/.test(source),
    'both send the declared device');

  section('AI-read data is labelled before the member confirms it');
  check(/readFromImage/.test(source),
    'the preview checks the readFromImage flag the route sets');
  check(/not from a file your device produced/.test(source),
    'and says plainly that the figures were read from an image');
  check(/implausible/.test(source),
    'readings outside the possible range are reported as dropped, not hidden');

  /* ---------------------------------------------------------------- *
   * summary
   * ---------------------------------------------------------------- */

  console.log('\n' + '-'.repeat(60));
  if (failures.length) {
    console.log('FAILED ' + failures.length + ' of ' + checks + ' checks:');
    failures.forEach((f) => console.log('  x ' + f));
    process.exit(1);
  }
  console.log('--- All ' + checks + ' wearable UI checks passed ---');
})();

main.catch((e) => {
  console.error('\nUI test threw:', e && e.stack);
  process.exit(1);
});
