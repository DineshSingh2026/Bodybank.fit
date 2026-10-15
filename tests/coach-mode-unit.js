/**
 * Unit test: Coach Mode (services/coachModeService.js + the curated library files).
 * Run: node tests/coach-mode-unit.js
 *
 * NO NETWORK. NO DATABASE.
 *
 * What this guards:
 *  - workout validation: types, ranges (load 0–500 in 0.25 steps, reps 0–100,
 *    seconds 0–3600), ≤12 exercises, ≤10 sets, area enum, unit vs exercise, dates;
 *  - volume = Σ load × reps over kg sets only;
 *  - cue / step / mistake length limits on every curated draft, no medical or
 *    price wording, whitelist ↔ drafts ↔ source ids consistent, no duplicates;
 *  - care tags: recovery/pregnancy hide, kidney_gentle etc. only add a soft note;
 *  - the rollout flag (off / staff / allowlist / all);
 *  - coins post on the workout's own day, never a future day;
 *  - the admin approve gate (≥3 cues, ≥2 mistakes, ≥1 image, review note);
 *  - the migration SQL file is byte-identical to the boot DDL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../services/coachModeService');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const ROWS = {
  'barbell-back-squat': { id: 'barbell-back-squat', name: 'Barbell Back Squat', unit: 'reps', load_type: 'kg' },
  'plank': { id: 'plank', name: 'Plank', unit: 'seconds', load_type: 'bodyweight' },
  'push-ups': { id: 'push-ups', name: 'Push Ups', unit: 'reps', load_type: 'bodyweight' }
};
const TODAY = '2026-10-15';
function body(over) {
  return Object.assign({
    client_uuid: '6f1c2c1e-1111-4a4a-9b9b-123456789abc',
    area: 'lower',
    started_at: '2026-10-15T05:00:00.000Z',
    finished_at: '2026-10-15T05:34:00.000Z',
    local_date: TODAY,
    exercises: [
      { exercise_id: 'barbell-back-squat', order: 0, sets: [
        { set_number: 1, load_kg: 40, reps: 8 }, { set_number: 2, load_kg: 42.5, reps: 8 }] },
      { exercise_id: 'plank', order: 1, sets: [{ set_number: 1, seconds: 30 }] },
      { exercise_id: 'push-ups', order: 2, sets: [{ set_number: 1, reps: 12 }] }
    ]
  }, over || {});
}

// ── validation: happy path ──────────────────────────────────────────────────
{
  const v = C.validateWorkout(body(), ROWS, TODAY);
  assert(!v.errors, 'valid workout should pass: ' + JSON.stringify(v.errors));
  if (v.value) {
    eq(v.value.total_sets, 4, 'total sets');
    eq(v.value.total_volume_kg, 40 * 8 + 42.5 * 8, 'volume counts kg sets only');
    eq(v.value.duration_seconds, 34 * 60, 'duration from timestamps');
    eq(v.value.exercises[1].sets[0].reps, null, 'timed exercise drops reps');
    eq(v.value.exercises[1].sets[0].seconds, 30, 'timed exercise keeps seconds');
  }
}

// ── validation: every rejection reports its field ───────────────────────────
function bad(over, field, label) {
  const v = C.validateWorkout(body(over), ROWS, TODAY);
  const keys = v.errors ? Object.keys(v.errors) : [];
  assert(keys.some((k) => k.indexOf(field) >= 0), `${label} → expected error on ${field}, got ${JSON.stringify(v.errors || null)}`);
}
bad({ client_uuid: 'x' }, 'client_uuid', 'short client_uuid');
bad({ area: 'arms' }, 'area', 'unknown area');
bad({ started_at: 'yesterday' }, 'started_at', 'bad started_at');
bad({ finished_at: '2026-10-15T04:00:00.000Z' }, 'finished_at', 'finished before start');
bad({ local_date: '15/10/2026' }, 'local_date', 'bad local_date format');
bad({ local_date: '2026-10-20' }, 'local_date', 'future local_date');
bad({ local_date: '2026-08-01' }, 'local_date', 'too old local_date');
bad({ exercises: [] }, 'exercises', 'no exercises');
bad({ exercises: Array.from({ length: 13 }, (_, i) => ({ exercise_id: 'push-ups', order: i, sets: [{ set_number: 1, reps: 5 }] })) }, 'exercises', '13 exercises');
bad({ exercises: [{ exercise_id: 'nope', order: 0, sets: [{ set_number: 1, reps: 5 }] }] }, 'exercise_id', 'unknown / unapproved exercise');
bad({ exercises: [{ exercise_id: 'push-ups', order: 0, sets: Array.from({ length: 11 }, (_, i) => ({ set_number: i + 1, reps: 5 })) }] }, 'sets', '11 sets');
bad({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: 40.1, reps: 5 }] }] }, 'load_kg', 'load not in 0.25 steps');
bad({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: 501, reps: 5 }] }] }, 'load_kg', 'load over 500');
bad({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: -1, reps: 5 }] }] }, 'load_kg', 'negative load');
bad({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: 20, reps: 101 }] }] }, 'reps', 'reps over 100');
bad({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: 20, reps: 2.5 }] }] }, 'reps', 'fractional reps');
bad({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: 20 }] }] }, 'reps', 'reps missing on a reps move');
bad({ exercises: [{ exercise_id: 'plank', order: 0, sets: [{ set_number: 1, seconds: 3601 }] }] }, 'seconds', 'seconds over 3600');
bad({ exercises: [{ exercise_id: 'plank', order: 0, sets: [{ set_number: 1, reps: 10 }] }] }, 'seconds', 'seconds missing on a timed move');
bad({ exercises: [{ exercise_id: 'push-ups', order: 0, sets: [{ set_number: 1, reps: 5 }, { set_number: 1, reps: 5 }] }] }, 'set_number', 'duplicate set_number');
bad({ exercises: [
  { exercise_id: 'push-ups', order: 0, sets: [{ set_number: 1, reps: 5 }] },
  { exercise_id: 'plank', order: 0, sets: [{ set_number: 1, seconds: 20 }] }] }, 'order', 'duplicate order');
bad({ notes: 'x'.repeat(501) }, 'notes', 'notes too long');
{
  const v = C.validateWorkout(body({ user_id: 'someone-else' }), ROWS, TODAY);
  assert(!v.errors && !('user_id' in v.value), 'user_id in the body is ignored, never echoed into the value');
}
{
  // Load 0.25 steps accepted at the edges.
  const v = C.validateWorkout(body({ exercises: [{ exercise_id: 'barbell-back-squat', order: 0, sets: [{ set_number: 1, load_kg: 500, reps: 0 }, { set_number: 2, load_kg: 0.25, reps: 100 }] }] }), ROWS, TODAY);
  assert(!v.errors, 'edge values 500 kg / 0.25 kg / 0 and 100 reps are valid: ' + JSON.stringify(v.errors));
}

// ── volume ──────────────────────────────────────────────────────────────────
eq(C.computeVolume([{ sets: [{ load_kg: 40, reps: 8 }, { load_kg: null, reps: 12 }, { load_kg: 10, seconds: 30 }] }]), { total_sets: 3, total_volume_kg: 320 }, 'volume ignores bodyweight and timed sets');
eq(C.computeVolume([]), { total_sets: 0, total_volume_kg: 0 }, 'empty volume');
eq(C.computeVolume([{ sets: [{ load_kg: 42.5, reps: 3 }] }]).total_volume_kg, 127.5, 'decimal volume');

// ── coin day ────────────────────────────────────────────────────────────────
eq(C.coinDay('2026-10-14', TODAY), '2026-10-14', 'an offline sync pays on the workout day');
eq(C.coinDay('2026-10-16', TODAY), TODAY, 'never pays on a future day');
eq(C.coinDay('garbage', TODAY), TODAY, 'bad date falls back to today');
eq(C.workoutLogName('lower'), 'Coach Mode · Lower', 'mirror workout name');

// ── care tags ───────────────────────────────────────────────────────────────
{
  const m1 = C.careMatch(['recovery', 'knee'], ['recovery']);
  assert(m1.hidden, 'recovery member never sees a recovery-tagged move');
  const m2 = C.careMatch(['kidney_gentle'], ['kidney_gentle']);
  assert(!m2.hidden && m2.notes.length === 1, 'kidney_gentle shows a soft note, does not hide');
  const m3 = C.careMatch(['pregnancy'], ['pregnancy']);
  assert(m3.hidden, 'pregnancy-tagged move hidden for a pregnancy-tagged member');
  const m4 = C.careMatch(['knee'], []);
  assert(!m4.hidden && !m4.notes.length, 'no care tags → no change');
  Object.values(C.CARE_NOTES).forEach((n) => assert(!/\b(cure|treat|diagnos|heal|kidney stone|disease)\b/i.test(n), 'care note has no medical wording: ' + n));
}

// ── flag ────────────────────────────────────────────────────────────────────
{
  const member = { id: 'u1', role: 'user', email: 'Kling@Test.com' };
  const admin = { id: 'a1', role: 'admin' };
  assert(C.isEnabledFor(member, C.flagConfig({})), 'default is on (launched 2026-10-15)');
  assert(!C.isEnabledFor(admin, C.flagConfig({ COACH_MODE_ENABLED: 'off' })), 'off hides it from staff too');
  assert(C.isEnabledFor(admin, C.flagConfig({ COACH_MODE_ENABLED: 'staff' })), 'staff mode admits staff');
  assert(!C.isEnabledFor(member, C.flagConfig({ COACH_MODE_ENABLED: 'staff' })), 'staff mode excludes members');
  assert(C.isEnabledFor(member, C.flagConfig({ COACH_MODE_ENABLED: 'allowlist', COACH_MODE_ALLOWLIST: 'x, kling@test.com' })), 'allowlist by email (case-insensitive)');
  assert(C.isEnabledFor(member, C.flagConfig({ COACH_MODE_ENABLED: 'allowlist', COACH_MODE_ALLOWLIST: 'u1' })), 'allowlist by user id');
  assert(!C.isEnabledFor({ id: 'u2', role: 'user' }, C.flagConfig({ COACH_MODE_ENABLED: 'allowlist', COACH_MODE_ALLOWLIST: 'u1' })), 'allowlist excludes others');
  assert(C.isEnabledFor(member, C.flagConfig({ COACH_MODE_ENABLED: 'all' })), 'all admits members');
  assert(!C.isEnabledFor(member, C.flagConfig({ COACH_MODE_ENABLED: 'banana' })), 'unknown value is off');
}

// ── admin patch + approve gate ──────────────────────────────────────────────
{
  const p = C.validateExercisePatch({ cues: ['Chest up', 'x'.repeat(61)] });
  assert(p.errors && p.errors.cues, 'cue over 60 chars rejected');
  const p2 = C.validateExercisePatch({ contraindications: ['knee', 'heart'] });
  assert(p2.errors && p2.errors.contraindications, 'unknown tag rejected');
  const p3 = C.validateExercisePatch({ ai_trainer_key: 'deadlift' });
  assert(p3.errors && p3.errors.ai_trainer_key, 'AI key must be a move the AI Trainer can judge');
  const p4 = C.validateExercisePatch({ load_step_kg: 1.3 });
  assert(p4.errors && p4.errors.load_step_kg, 'kg step in 0.25 steps');
  const p5 = C.validateExercisePatch({ name: 'Goblet Squat', steps: ['a', 'b'], status: 'approved', reviewed_by: 'me' });
  assert(!p5.errors && !('status' in p5.patch) && !('reviewed_by' in p5.patch), 'status/reviewed_by are not editable through PUT');
  const ok = { cues: ['a', 'b', 'c'], common_mistakes: [{ mistake: 'm1' }, { mistake: 'm2' }], images: [{ src: '/img/coach/x.webp' }], review_notes: 'checked', steps: ['s'] };
  eq(C.approvalProblems(ok), [], 'complete exercise approvable');
  assert(C.approvalProblems(Object.assign({}, ok, { cues: ['a', 'b'] })).length === 1, 'needs 3 cues');
  assert(C.approvalProblems(Object.assign({}, ok, { common_mistakes: [{ mistake: 'm1' }] })).length === 1, 'needs 2 mistakes');
  assert(C.approvalProblems(Object.assign({}, ok, { images: [] })).length === 1, 'needs an image');
  assert(C.approvalProblems(Object.assign({}, ok, { review_notes: ' ' })).length === 1, 'needs a review note');
}

// ── curated library files ───────────────────────────────────────────────────
{
  const dir = path.join(__dirname, '..', 'data', 'coach');
  const wl = JSON.parse(fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8'));
  const ids = new Set();
  const src = new Set();
  let n = 0;
  for (const area of C.AREAS) {
    for (const e of wl[area] || []) {
      n += 1;
      assert(!ids.has(e.id), 'duplicate whitelist id ' + e.id);
      assert(!src.has(e.source_id), 'duplicate source id ' + e.source_id);
      ids.add(e.id); src.add(e.source_id);
      const f = path.join(dir, 'drafts', e.id + '.json');
      if (!assert(fs.existsSync(f), 'draft file missing for ' + e.id)) continue;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      eq(d.area, area, e.id + ' area');
      eq(d.source_id, e.source_id, e.id + ' source id');
      const probs = C.draftProblems(d);
      assert(!probs.length, e.id + ': ' + probs.join('; '));
      (d.cues || []).forEach((c) => assert(c.length <= 60, `${e.id} cue over 60: ${c}`));
      (d.steps || []).forEach((s) => assert(s.length <= 110, `${e.id} step over 110: ${s}`));
      assert(d.cues.length >= 3 && d.cues.length <= 5, e.id + ' needs 3–5 cues');
      assert(d.common_mistakes.length >= 2, e.id + ' needs ≥2 mistakes');
      if (d.ai_trainer_key) assert(C.AI_TRAINER_KEYS.includes(d.ai_trainer_key), e.id + ' AI key');
      if (d.unit === 'seconds') assert(d.default_reps >= 5, e.id + ' timed default sensible');
    }
  }
  const files = fs.readdirSync(path.join(dir, 'drafts')).filter((f) => f.endsWith('.json'));
  eq(files.length, n, 'every draft file is on the whitelist (no orphans)');
  assert(n >= 150, 'library has at least 150 curated exercises, has ' + n);
}

// ── migration file == boot DDL ──────────────────────────────────────────────
{
  const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrations', '20261015_coach_mode.sql'), 'utf8');
  const norm = (s) => s.replace(/--[^\n]*\n/g, '').replace(/\s+/g, ' ').trim();
  const fromDdl = norm(C.DDL.map((s) => s + ';').join('\n'));
  eq(norm(sql), fromDdl, 'migration SQL matches the boot DDL');
  assert(!/\bDROP\b|\bRENAME\b/i.test(norm(sql)), 'migration is additive (no DROP / RENAME)');
}

if (failures.length) {
  console.error(`\ncoach-mode-unit: ${failures.length} of ${checks} checks FAILED`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`coach-mode-unit: ${checks} passed, 0 failed`);
