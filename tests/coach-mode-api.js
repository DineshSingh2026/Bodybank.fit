/**
 * API test: Coach Mode routes against a real PostgreSQL (DATABASE_URL).
 * Run: node tests/coach-mode-api.js
 *
 * Mounts routes/coachMode.js in-process with the real auth middleware, coin
 * service and DB, so the feature flag can be switched per case. Creates a
 * throwaway member + two throwaway exercises and deletes everything afterwards.
 *
 * Guards:
 *  - members see only approved exercises; a draft is invisible (list + detail);
 *  - user_id always comes from the token (a body user_id is ignored);
 *  - the same client_uuid saved twice (and three times concurrently) → one
 *    workout, one workout_logs mirror, coins once, {duplicate:true} on repeats;
 *  - coins are not paid twice when My Workout already paid today;
 *  - admin routes are 403 for members and operators; approve gate enforced;
 *  - the flag off → member routes 404, /flags answers enabled:false;
 *  - validation errors are 400 with field errors and write nothing;
 *  - seed upsert never overwrites an approved row.
 */
'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const { createCoachRouter } = require('../routes/coachMode');
const C = require('../services/coachModeService');
const coinService = require('../services/coinService');
const plans = require('../services/plans');
const streakService = require('../services/streakService');
const { verifyToken, requireAdminOrSuperadmin, signToken } = require('../middleware/auth');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const run = (sql, p = []) => pool.query(toPg(sql), p);
const queryAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
const queryOne = async (sql, p = []) => (await queryAll(sql, p))[0] || null;

const TAG = 'zzcoachtest' + crypto.randomBytes(3).toString('hex');
const MEMBER = { id: TAG + '-member', email: TAG + '@test.bodybank.fit', role: 'user' };
const OTHER = { id: TAG + '-other', email: TAG + '-o@test.bodybank.fit', role: 'user' };
const EX_OK = TAG + '-squat';
const EX_DRAFT = TAG + '-draft';
const EX_HIDE = TAG + '-heavy';

function makeApp(env) {
  const app = express();
  app.use(express.json());
  app.use('/api/coach', createCoachRouter({
    verifyToken, requireAdminOrSuperadmin, rateLimiter: () => (req, res, next) => next(),
    queryAll, queryOne, run, getPool: () => pool, coinService, plans, streakService,
    todayInTz: streakService.todayYmdInTz, defaultTz: streakService.STREAK_TZ, env
  }));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

async function call(base, method, path, token, body) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, data };
}

function workout(uuid, over) {
  const today = streakService.todayYmdInTz('Asia/Kolkata');
  return Object.assign({
    client_uuid: uuid, area: 'lower',
    started_at: new Date(Date.now() - 30 * 60000).toISOString(), finished_at: new Date().toISOString(),
    local_date: today,
    exercises: [{ exercise_id: EX_OK, order: 0, sets: [{ set_number: 1, load_kg: 40, reps: 8 }, { set_number: 2, load_kg: 42.5, reps: 8 }] }]
  }, over || {});
}

async function setup() {
  await C.ensureCoachTables(pool);
  for (const u of [MEMBER, OTHER]) {
    await run("INSERT INTO users (id, email, password, first_name, role, timezone) VALUES (?,?,?,?,?,'Asia/Kolkata')", [u.id, u.email, 'x', 'Test', u.role]);
  }
  const ins = `INSERT INTO coach_exercises (id, name, area, steps, cues, common_mistakes, contraindications, images, unit, load_type, status, review_notes)
               VALUES (?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?::jsonb,'reps','kg',?,?)`;
  const full = [JSON.stringify(['Stand tall', 'Squat down', 'Stand up']), JSON.stringify(['Chest up', 'Knees out', 'Drive through heels']),
    JSON.stringify([{ mistake: 'Knees cave', fix: 'Push knees out' }, { mistake: 'Heels lift', fix: 'Weight in heels' }])];
  const img = JSON.stringify([{ src: '/img/coach/x.webp', w: 480, h: 320 }]);
  await run(ins, [EX_OK, 'Test Squat', 'lower', ...full, '[]', img, 'approved', 'ok']);
  await run(ins, [EX_DRAFT, 'Test Draft', 'lower', ...full, '[]', img, 'draft', '']);
  await run(ins, [EX_HIDE, 'Test Heavy', 'lower', ...full, JSON.stringify(['recovery']), img, 'approved', 'ok']);
}

async function cleanup() {
  const ids = [MEMBER.id, OTHER.id];
  await run('DELETE FROM coach_workouts WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM workout_logs WHERE user_id = ANY(?::text[])', [ids]);
  try { await run('DELETE FROM coin_ledger WHERE user_id = ANY(?::text[])', [ids]); } catch (_) { /* table optional */ }
  try { await run('DELETE FROM coin_wallet WHERE user_id = ANY(?::text[])', [ids]); } catch (_) { /* table optional */ }
  try { await run('DELETE FROM nutrition_daily_stats WHERE user_id = ANY(?::text[])', [ids]); } catch (_) { /* optional */ }
  await run('DELETE FROM coach_exercises WHERE id LIKE ?', [TAG + '%']);
  await run('DELETE FROM users WHERE id = ANY(?::text[])', [ids]);
}

async function main() {
  await setup();
  const tok = signToken({ id: MEMBER.id, email: MEMBER.email, role: 'user' });
  const tokOther = signToken({ id: OTHER.id, email: OTHER.email, role: 'user' });
  const tokOp = signToken({ id: TAG + '-op', email: 'op@x', role: 'operator' });
  const tokAdmin = signToken({ id: TAG + '-admin', email: 'admin@x', role: 'admin' });

  const on = await makeApp({ COACH_MODE_ENABLED: 'all' });
  const off = await makeApp({ COACH_MODE_ENABLED: 'off' });
  const allow = await makeApp({ COACH_MODE_ENABLED: 'allowlist', COACH_MODE_ALLOWLIST: MEMBER.email });
  const B = 'http://127.0.0.1:' + on.address().port;
  const OFF = 'http://127.0.0.1:' + off.address().port;
  const AL = 'http://127.0.0.1:' + allow.address().port;
  try {
    // ── flag ──
    eq((await call(OFF, 'GET', '/api/coach/flags', tok)).data, { enabled: false }, 'flags off');
    eq((await call(OFF, 'GET', '/api/coach/exercises?area=lower', tok)).status, 404, 'member route 404 when flag off');
    eq((await call(OFF, 'POST', '/api/coach/workouts', tok, workout(crypto.randomUUID()))).status, 404, 'save 404 when flag off');
    eq((await call(B, 'GET', '/api/coach/flags', tok)).data, { enabled: true }, 'flags on');
    eq((await call(AL, 'GET', '/api/coach/flags', tok)).data, { enabled: true }, 'allowlisted member enabled');
    eq((await call(AL, 'GET', '/api/coach/flags', tokOther)).data, { enabled: false }, 'non-allowlisted member disabled');
    eq((await call(B, 'GET', '/api/coach/flags')).status, 401, 'flags needs a token');

    // ── approved only ──
    const list = await call(B, 'GET', '/api/coach/exercises?area=lower', tok);
    const ids = (list.data.exercises || []).map((x) => x.id);
    assert(ids.includes(EX_OK), 'approved exercise listed');
    assert(!ids.includes(EX_DRAFT), 'draft exercise NOT listed');
    eq((await call(B, 'GET', '/api/coach/exercises/' + EX_DRAFT, tok)).status, 404, 'draft detail 404');
    const g = await call(B, 'GET', '/api/coach/exercises/' + EX_OK, tok);
    eq(g.status, 200, 'approved detail 200');
    assert(Array.isArray(g.data.cues) && g.data.cues.length === 3, 'guide carries cues');
    eq((await call(B, 'GET', '/api/coach/exercises?area=arms', tok)).status, 400, 'bad area 400');

    // ── care tags hide recovery-tagged moves ──
    assert(ids.includes(EX_HIDE), 'untagged member sees the recovery-tagged move');
    await run("UPDATE users SET coach_care_tags = '{recovery}' WHERE id = ?", [MEMBER.id]);
    const list2 = await call(B, 'GET', '/api/coach/exercises?area=lower', tok);
    assert(!(list2.data.exercises || []).some((x) => x.id === EX_HIDE), 'recovery member does not see the recovery-tagged move');
    eq((await call(B, 'GET', '/api/coach/exercises/' + EX_HIDE, tok)).status, 404, 'recovery-tagged detail hidden too');
    await run("UPDATE users SET coach_care_tags = '{}' WHERE id = ?", [MEMBER.id]);

    // ── validation: 400, nothing written ──
    const v = await call(B, 'POST', '/api/coach/workouts', tok, workout(crypto.randomUUID(), { exercises: [{ exercise_id: EX_OK, order: 0, sets: [{ set_number: 1, load_kg: 40.1, reps: 8 }] }] }));
    eq(v.status, 400, 'invalid load 400');
    assert(v.data && v.data.errors && Object.keys(v.data.errors).some((k) => k.indexOf('load_kg') >= 0), 'field error names load_kg');
    const vd = await call(B, 'POST', '/api/coach/workouts', tok, workout(crypto.randomUUID(), { exercises: [{ exercise_id: EX_DRAFT, order: 0, sets: [{ set_number: 1, load_kg: 40, reps: 8 }] }] }));
    eq(vd.status, 400, 'saving a draft exercise is refused');
    eq((await queryOne('SELECT COUNT(*)::int AS n FROM coach_workouts WHERE user_id = ?', [MEMBER.id])).n, 0, 'nothing written on 400');

    // ── save, user id from token, idempotent ──
    const uuid = crypto.randomUUID();
    const first = await call(B, 'POST', '/api/coach/workouts', tok, Object.assign(workout(uuid), { user_id: OTHER.id }));
    eq(first.status, 200, 'save 200');
    eq(first.data.duplicate, false, 'first save not duplicate');
    eq(first.data.workout.total_sets, 2, 'total sets');
    eq(first.data.workout.total_volume_kg, 660, 'volume 40×8 + 42.5×8');
    eq(first.data.coins.awarded, true, 'coins awarded on first save');
    const row = await queryOne('SELECT user_id, workout_log_id FROM coach_workouts WHERE client_uuid = ?', [uuid]);
    eq(row && row.user_id, MEMBER.id, 'user_id from token, body user_id ignored');
    eq((await queryOne('SELECT COUNT(*)::int AS n FROM coach_workouts WHERE user_id = ?', [OTHER.id])).n, 0, 'nothing written for the body user_id');
    const mirror = await queryOne('SELECT workout_name, workout_type, workout_completed FROM workout_logs WHERE id = ?', [row.workout_log_id]);
    eq(mirror && mirror.workout_type, 'coach_mode', 'mirror row in workout_logs');
    eq(mirror && mirror.workout_name, 'Coach Mode · Lower', 'mirror name');

    const again = await call(B, 'POST', '/api/coach/workouts', tok, workout(uuid));
    eq(again.status, 200, 'retry 200');
    eq(again.data.duplicate, true, 'retry flagged duplicate');
    eq(again.data.workout.id, first.data.workout.id, 'retry returns the same workout');

    const uuid2 = crypto.randomUUID();
    const burst = await Promise.all([1, 2, 3].map(() => call(B, 'POST', '/api/coach/workouts', tok, workout(uuid2))));
    assert(burst.every((r) => r.status === 200), 'concurrent retries all 200');
    eq(burst.filter((r) => r.data && r.data.duplicate === false).length, 1, 'exactly one concurrent save is the original');

    eq((await queryOne('SELECT COUNT(*)::int AS n FROM coach_workouts WHERE user_id = ?', [MEMBER.id])).n, 2, 'two workouts (two uuids), no duplicates');
    eq((await queryOne("SELECT COUNT(*)::int AS n FROM workout_logs WHERE user_id = ? AND workout_type = 'coach_mode'", [MEMBER.id])).n, 2, 'one mirror per workout');
    eq((await queryOne('SELECT COUNT(*)::int AS n FROM coach_sets s JOIN coach_workouts w ON w.id = s.workout_id WHERE w.client_uuid = ?', [uuid])).n, 2, 'sets not duplicated by retries');
    eq((await queryOne("SELECT COUNT(*)::int AS n FROM coin_ledger WHERE user_id = ? AND event_type = 'workout_session'", [MEMBER.id])).n, 1, 'coins paid once per day');

    // ── My Workout already paid today → Coach Mode does not pay again ──
    const today = streakService.todayYmdInTz('Asia/Kolkata');
    await coinService.awardCoins({ run, queryOne, queryAll }, { userId: OTHER.id, eventType: 'workout_session', eventKey: `coins:workout_session:${OTHER.id}:${today}`, coinsDelta: coinService.COIN_RULES.WORKOUT_SESSION, meta: { source: 'workouts_session' }, createdAtYmd: today });
    const o = await call(B, 'POST', '/api/coach/workouts', tokOther, workout(crypto.randomUUID()));
    eq(o.status, 200, 'other member save 200');
    eq(o.data.coins.awarded, false, 'no second payout after My Workout paid today');
    eq((await queryOne("SELECT COUNT(*)::int AS n FROM coin_ledger WHERE user_id = ? AND event_type = 'workout_session'", [OTHER.id])).n, 1, 'still one workout payout');

    // ── last + history ──
    const last = await call(B, 'GET', '/api/coach/last?exercise_ids=' + EX_OK, tok);
    eq(last.data.last[EX_OK].sets.length, 2, 'last time returns the last workout sets');
    eq(last.data.last[EX_OK].best_load_kg, 42.5, 'best load');
    const hist = await call(B, 'GET', '/api/coach/workouts?limit=5', tok);
    eq(hist.data.workouts.length, 2, 'history lists both workouts');
    const otherLast = await call(B, 'GET', '/api/coach/last?exercise_ids=' + EX_OK, tokOther);
    eq(otherLast.data.last[EX_OK].sets.length, 2, "another member's last-time is their own");

    // ── admin ──
    eq((await call(B, 'GET', '/api/coach/admin/exercises', tok)).status, 403, 'member → admin list 403');
    eq((await call(B, 'GET', '/api/coach/admin/exercises', tokOp)).status, 403, 'operator → admin list 403');
    eq((await call(B, 'POST', '/api/coach/admin/exercises/' + EX_DRAFT + '/approve', tok)).status, 403, 'member cannot approve');
    eq((await call(B, 'PUT', '/api/coach/admin/care-tags/' + MEMBER.id, tok, { tags: ['recovery'] })).status, 403, 'member cannot set care tags');
    const al = await call(B, 'GET', '/api/coach/admin/exercises?status=draft&q=' + TAG, tokAdmin);
    eq(al.status, 200, 'admin list 200');
    assert((al.data.exercises || []).some((x) => x.id === EX_DRAFT), 'admin sees drafts');
    const noNote = await call(B, 'POST', '/api/coach/admin/exercises/' + EX_DRAFT + '/approve', tokAdmin, {});
    eq(noNote.status, 400, 'approve without a review note is refused');
    const badPut = await call(B, 'PUT', '/api/coach/admin/exercises/' + EX_DRAFT, tokAdmin, { cues: ['x'.repeat(61), 'b', 'c'] });
    eq(badPut.status, 400, 'admin PUT validates cue length');
    const put = await call(B, 'PUT', '/api/coach/admin/exercises/' + EX_DRAFT, tokAdmin, { name: 'Test Draft Edited', review_notes: 'checked photos and cues' });
    eq(put.data && put.data.name, 'Test Draft Edited', 'admin edit saved');
    const ap = await call(B, 'POST', '/api/coach/admin/exercises/' + EX_DRAFT + '/approve', tokAdmin, {});
    eq(ap.status, 200, 'approve 200');
    eq(ap.data.status, 'approved', 'status approved');
    eq(ap.data.reviewed_by, TAG + '-admin', 'reviewed_by = admin from token');
    assert(!!ap.data.reviewed_at, 'reviewed_at set');
    const list3 = await call(B, 'GET', '/api/coach/exercises?area=lower', tok);
    assert((list3.data.exercises || []).some((x) => x.id === EX_DRAFT), 'approved exercise now visible to members');
    const care = await call(B, 'PUT', '/api/coach/admin/care-tags/' + MEMBER.id, tokAdmin, { tags: ['kidney_gentle'] });
    eq(care.data && care.data.coach_care_tags, ['kidney_gentle'], 'admin sets care tags');
    eq((await call(B, 'PUT', '/api/coach/admin/care-tags/' + MEMBER.id, tokAdmin, { tags: ['heart'] })).status, 400, 'unknown care tag 400');

    // ── seed upsert never overwrites approved text ──
    await pool.query(
      `INSERT INTO coach_exercises (id, name, area, status) VALUES ($1, 'Seed Overwrite', 'lower', 'draft')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name WHERE coach_exercises.status = 'draft'`, [EX_DRAFT]);
    eq((await queryOne('SELECT name FROM coach_exercises WHERE id = ?', [EX_DRAFT])).name, 'Test Draft Edited', 'seed upsert leaves approved rows alone');

    // ── retire hides from members ──
    await call(B, 'POST', '/api/coach/admin/exercises/' + EX_DRAFT + '/retire', tokAdmin, {});
    const list4 = await call(B, 'GET', '/api/coach/exercises?area=lower', tok);
    assert(!(list4.data.exercises || []).some((x) => x.id === EX_DRAFT), 'retired exercise hidden from members');
  } finally {
    on.close(); off.close(); allow.close();
    await cleanup();
    await pool.end();
  }
}

main().then(() => {
  if (failures.length) {
    console.error(`\ncoach-mode-api: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`coach-mode-api: ${checks} passed, 0 failed`);
}).catch(async (e) => {
  console.error('coach-mode-api crashed:', e);
  try { await cleanup(); } catch (_) { /* ignore */ }
  process.exit(1);
});
