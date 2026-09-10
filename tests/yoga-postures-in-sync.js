/**
 * Keeps the yoga posture lists from drifting apart.
 * Run: node tests/yoga-postures-in-sync.js      (no dependencies, no server, no DB)
 *
 * The same postures appear in two places that cannot import each other:
 *   - public/js/bb-yoga-postures.js  → the "Yoga" dropdown in My Workout (index.html)
 *   - public/ai-trainer.html         → the #ygSel list the AI Trainer coaches from
 *
 * They are joined by `key`, which is also the AI Trainer's exercise key. If a
 * posture is added to one list and not the other, a member can log a session the
 * trainer cannot coach (or vice versa), and the mismatch is invisible until a
 * user hits it. Every posture key must also have a detector behind it, or
 * selecting it in the trainer would score nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'public', 'js', 'bb-yoga-postures.js');
const TRAINER = path.join(ROOT, 'public', 'ai-trainer.html');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

// ── The shared list, evaluated in a bare sandbox ──────────────
const root = {};
new Function('window', fs.readFileSync(SHARED, 'utf8'))(root);
const shared = root.BB_YOGA_POSTURES;
assert(Array.isArray(shared) && shared.length > 0, 'bb-yoga-postures.js did not define BB_YOGA_POSTURES');
if (!Array.isArray(shared)) { report(); return; }

// ── The trainer's yoga dropdown ───────────────────────────────
const html = fs.readFileSync(TRAINER, 'utf8');
const ygStart = html.indexOf('<select id="ygSel"');
assert(ygStart > -1, 'ai-trainer.html has no #ygSel dropdown');
const ygEnd = html.indexOf('</select>', ygStart);
const ygBlock = ygStart > -1 ? html.slice(ygStart, ygEnd) : '';
const trainer = [...ygBlock.matchAll(/<option value="([a-z0-9]+)"[^>]*>([^<]*)</g)]
  .map(m => ({ key: m[1], label: m[2].trim() }));

assert(trainer.length > 0, '#ygSel has no postures');

// ── Same keys, same order ─────────────────────────────────────
const sharedKeys = shared.map(p => p.key);
const trainerKeys = trainer.map(p => p.key);

for (const k of sharedKeys) {
  assert(trainerKeys.includes(k), `posture "${k}" is in bb-yoga-postures.js but missing from #ygSel in ai-trainer.html`);
}
for (const k of trainerKeys) {
  assert(sharedKeys.includes(k), `posture "${k}" is in #ygSel but missing from bb-yoga-postures.js`);
}
assert(
  sharedKeys.join(',') === trainerKeys.join(','),
  `posture order differs\n    shared:  ${sharedKeys.join(', ')}\n    trainer: ${trainerKeys.join(', ')}`
);

// ── Same visible label, so a logged session reads like a coached one ──
for (const p of shared) {
  const t = trainer.find(x => x.key === p.key);
  if (!t) continue;
  const expected = `${p.emoji} ${p.en} · ${p.sa}`;
  assert(t.label === expected, `label mismatch for "${p.key}"\n    shared:  ${expected}\n    trainer: ${t.label}`);
}

// ── Every posture must actually have a detector ───────────────
for (const p of shared) {
  assert(
    html.includes(`exKey==='${p.key}'`),
    `posture "${p.key}" has no branch in the AI Trainer's detector dispatch`
  );
}

// ── Plank is deliberately in both trainer lists but is not a yoga mode ──
const yogaModesLine = (html.match(/const YOGA_MODES = \[[^\]]*\]/) || [''])[0];
assert(
  yogaModesLine.includes("'plank'") === false,
  'plank must NOT be in YOGA_MODES — it is scored by the original plank detector, not the yoga engine'
);
assert(
  sharedKeys.includes('plank'),
  'plank should be offered as a loggable posture (Kumbhakasana)'
);

report();

function report() {
  if (failures.length) {
    console.error(`\nyoga-postures-in-sync: ${failures.length} of ${checks} checks FAILED\n`);
    failures.forEach(f => console.error('  ✗ ' + f));
    console.error('');
    process.exit(1);
  }
  console.log(`yoga-postures-in-sync: ${checks} checks passed (${shared.length} postures in sync)`);
}
