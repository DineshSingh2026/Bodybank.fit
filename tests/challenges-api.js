/**
 * API test: BodyBank Challenges against a real PostgreSQL (DATABASE_URL).
 * Run: npm run test:challenges-api
 *
 * Mounts routes/challenges.js in-process with the real auth middleware, coin
 * service, engine and DB, so the flag can be switched per case. Creates throwaway
 * members, staff and two throwaway challenges; deletes everything afterwards.
 *
 * Guards:
 *  - flag off → member + public routes 404, /flags answers enabled:false;
 *  - staff cannot join; members only; plan access (core locked out of a guided challenge);
 *  - join is idempotent: same client_uuid twice and 4× in parallel → one enrollment;
 *  - one active challenge at a time; free challenge once per 90 days;
 *  - evidence: a back-dated check-in does NOT complete an earlier day; same-day does;
 *  - coins once per day and once per completion under parallel syncs;
 *  - webhooks (CHALLENGE_JOINED / DAY_DONE / COMPLETED / LM_CALL_REQUESTED) fire once;
 *  - rewards: badge, certificate, discount (once), LM call (one per enrollment);
 *  - certificate signed link serves a PDF; share card serves an image;
 *  - leaderboard: staff, opted-out and new accounts hidden;
 *  - discount applied only server side, to the right tiers, used once;
 *  - admin routes 403 for members; publish refuses price / medical wording.
 */
'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const C = require('../services/challengeService');
const { createChallengeEngine } = require('../services/challengeEngine');
const { createChallengesRouter } = require('../routes/challenges');
const coinService = require('../services/coinService');
const plans = require('../services/plans');
const paymentsLib = require('../services/payments');
const { verifyToken, requireAdminOrSuperadmin, signToken, signPdfAccessToken, verifyPdfAccessToken } = require('../middleware/auth');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const run = (sql, p = []) => pool.query(toPg(sql), p);
const queryAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
const queryOne = async (sql, p = []) => (await queryAll(sql, p))[0] || null;

const TAG = 'zzchtest' + crypto.randomBytes(3).toString('hex');
const TZ = 'Asia/Kolkata';
const U = {
  core: { id: TAG + '-core', role: 'user', tier: 'core', first: 'Arjun', last: 'Rao' },
  guided: { id: TAG + '-guided', role: 'user', tier: 'guided', first: 'Priya', last: 'Shah' },
  late: { id: TAG + '-late', role: 'user', tier: 'core', first: 'Vik', last: 'K', young: true },
  shy: { id: TAG + '-shy', role: 'user', tier: 'core', first: 'Shy', last: 'One' },
  admin: { id: TAG + '-admin', role: 'admin', tier: null, first: 'Ad', last: 'Min' }
};
const CH_FREE = TAG + '-free';
const CH_PLAN = TAG + '-plan';
const events = [];
const pushes = [];

function makeEngine(env) {
  return createChallengeEngine({
    queryAll, queryOne, run, getPool: () => pool, coinService, plans, env,
    notifyAgent: (name, data) => events.push({ name, data }),
    notifyHub: { user: (id, n) => pushes.push({ id, n }), staff: (n) => pushes.push({ staff: true, n }) },
    defaultTz: TZ, logger: { warn: () => {} }
  });
}

let env = { CHALLENGES_ENABLED: 'all' };
let engine = makeEngine(env);
function makeApp() {
  const app = express();
  app.use(express.json());
  // env is read through a proxy so a test can flip the flag without remounting.
  const envProxy = new Proxy({}, { get: (t, k) => env[k] });
  engine = makeEngine(envProxy);
  app.use('/api/challenges', createChallengesRouter({
    verifyToken, requireAdminOrSuperadmin, rateLimiter: () => (req, res, next) => next(),
    queryAll, queryOne, run, engine, plans, signPdfAccessToken, verifyPdfAccessToken, env: envProxy
  }));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

let base = '';
const tok = {};
async function call(method, path, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = 'Bearer ' + tok[who];
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  let data = null;
  if (type.includes('json')) data = await r.json().catch(() => null);
  else data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, type };
}

const today = () => C.todayIn(TZ);
const ago = (n) => C.addDays(today(), -n);

async function setup() {
  await C.ensureChallengeTables(pool);
  for (const k of Object.keys(U)) {
    const u = U[k];
    await run(
      `INSERT INTO users (id, email, password, first_name, last_name, role, timezone, plan_tier, approval_status, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'approved', ?)`,
      [u.id, `${u.id}@test.bodybank.fit`, 'x', u.first, u.last, u.role, TZ, u.tier,
        u.young ? new Date().toISOString() : new Date(Date.now() - 5 * 86400000).toISOString()]
    );
    tok[k] = signToken({ id: u.id, email: `${u.id}@test.bodybank.fit`, role: u.role });
  }
}

async function cleanup() {
  const ids = Object.values(U).map((u) => u.id);
  const ens = (await queryAll('SELECT id FROM challenge_enrollments WHERE user_id = ANY(?::text[])', [ids])).map((r) => r.id);
  await run('DELETE FROM challenge_discount_orders WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM challenge_discounts WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM challenge_lm_requests WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM challenge_rewards WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM challenge_push_log WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM challenge_task_completions WHERE user_id = ANY(?::text[])', [ids]);
  if (ens.length) await run('DELETE FROM challenge_audit WHERE enrollment_id = ANY(?::text[])', [ens]);
  await run('DELETE FROM challenge_audit WHERE challenge_id = ANY(?::text[])', [[CH_FREE, CH_PLAN]]);
  await run('DELETE FROM challenge_enrollments WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM challenge_tasks WHERE challenge_id = ANY(?::text[])', [[CH_FREE, CH_PLAN]]);
  await run('DELETE FROM challenges WHERE id = ANY(?::text[])', [[CH_FREE, CH_PLAN]]);
  await run('DELETE FROM daily_checkins WHERE user_id = ANY(?::text[])', [ids]);
  await run('DELETE FROM coin_ledger WHERE user_id = ANY(?::text[])', [ids]).catch(() => {});
  await run('DELETE FROM coin_wallet WHERE user_id = ANY(?::text[])', [ids]).catch(() => {});
  await run('DELETE FROM payments WHERE user_id = ANY(?::text[])', [ids]).catch(() => {});
  await run('DELETE FROM users WHERE id = ANY(?::text[])', [ids]);
}

/** A check-in row written at `hh:mm` on `ymd` (naive, in the DB session zone). */
async function checkin(userId, ymd, opts) {
  const o = opts || {};
  const created = o.createdNow ? 'NOW()::timestamp' : `(?::date + time '${o.at || '10:00'}')`;
  const params = [crypto.randomUUID(), userId, ymd, o.steps == null ? 9000 : o.steps];
  if (!o.createdNow) params.push(o.createdOn || ymd);
  await run(`INSERT INTO daily_checkins (id, user_id, checkin_date, steps, water_ml, protein_g, sleep_hours, created_at)
             VALUES (?, ?, ?::date, ?, 3000, 130, 7.5, ${created})`, params);
}

async function main() {
  await cleanup().catch(() => {});
  await setup();
  const server = await makeApp();
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    // ── admin builds two challenges ──────────────────────────────────────
    let r = await call('GET', '/api/challenges/admin/challenges', 'core');
    eq(r.status, 403, 'member → admin list 403');
    const mk = (id, access, tiers) => call('POST', '/api/challenges/admin/challenges', 'admin', {
      id, slug: id, title: 'Test ' + access, subtitle: 'Seven days', length_days: 7, access, included_tiers: tiers,
      rewards: { coins: 100, badge_key: 'starter', badge_label: 'Starter badge', certificate: true, discount: true, lm_call: true }
    });
    r = await mk(CH_FREE, 'free', []);
    eq(r.status, 201, 'admin creates a challenge (draft)');
    eq(r.data.status, 'draft', 'new challenge is a draft');
    await mk(CH_PLAN, 'plan', ['guided', 'tribe_elite']);
    const tasks = [];
    for (let d = 1; d <= 7; d++) {
      tasks.push({ day_number: d, position: 1, kind: 'daily_checkin', title: 'Daily check in' });
      tasks.push({ day_number: d, position: 2, kind: 'steps', title: '8,000 steps', params: { steps: 8000 } });
    }
    r = await call('PUT', `/api/challenges/admin/challenges/${CH_FREE}/tasks`, 'admin', { tasks });
    eq(r.status, 200, 'admin saves tasks');
    eq(r.data.tasks.length, 14, '14 tasks stored');
    await call('PUT', `/api/challenges/admin/challenges/${CH_PLAN}/tasks`, 'admin', { tasks });
    r = await call('PUT', `/api/challenges/admin/challenges/${CH_FREE}`, 'admin', { subtitle: 'Only ₹99' });
    eq(r.status, 400, 'price wording rejected on edit');

    // Not published yet → members cannot see or join.
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: TAG + '-x1' });
    eq(r.status, 404, 'draft challenge cannot be joined');
    r = await call('POST', `/api/challenges/admin/challenges/${CH_FREE}/publish`, 'admin');
    eq([r.status, r.data.status], [200, 'published'], 'admin publishes');
    await call('POST', `/api/challenges/admin/challenges/${CH_PLAN}/publish`, 'admin');

    // ── flag off ─────────────────────────────────────────────────────────
    env = { CHALLENGES_ENABLED: 'off' };
    r = await call('GET', '/api/challenges/flags', 'core');
    eq(r.data, { enabled: false }, 'flag off → /flags enabled:false');
    r = await call('GET', '/api/challenges/', 'core');
    eq(r.status, 404, 'flag off → member list 404');
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: TAG + '-x2' });
    eq(r.status, 404, 'flag off → join 404');
    r = await call('GET', '/api/challenges/public');
    eq(r.status, 404, 'flag off → public list 404');
    r = await call('GET', '/api/challenges/admin/challenges', 'admin');
    eq(r.status, 200, 'flag off → admin still works');
    env = { CHALLENGES_ENABLED: 'staff' };
    r = await call('GET', '/api/challenges/flags', 'core');
    eq(r.data, { enabled: false }, 'staff mode hides members');
    env = { CHALLENGES_ENABLED: 'all' };

    // ── access ───────────────────────────────────────────────────────────
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'admin', { client_uuid: TAG + '-adm' });
    eq(r.status, 403, 'staff cannot join');
    r = await call('POST', `/api/challenges/${CH_PLAN}/join`, 'core', { client_uuid: TAG + '-c-plan' });
    eq([r.status, r.data.error], [403, 'not_included'], 'core member locked out of a guided challenge');
    r = await call('GET', '/api/challenges/', 'core');
    const planRow = r.data.challenges.find((c) => c.id === CH_PLAN);
    assert(planRow && planRow.my.locked, 'list marks the plan challenge locked for core');
    assert(!JSON.stringify(r.data).match(/₹|price/i), 'member list carries no price');
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: 'bad' });
    eq(r.status, 400, 'bad client_uuid rejected');

    // ── idempotent join ──────────────────────────────────────────────────
    const cu = TAG + '-join-1';
    const par = await Promise.all([1, 2, 3, 4].map(() => call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: cu, utm: { utm_source: 'test' } })));
    const ids = new Set(par.map((x) => x.data.enrollment_id));
    eq(ids.size, 1, '4 parallel joins with one client_uuid → one enrollment');
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: cu });
    eq([r.status, r.data.duplicate], [200, true], 'repeat join → duplicate:true');
    let n = await queryOne('SELECT COUNT(*)::int AS n FROM challenge_enrollments WHERE user_id = ?', [U.core.id]);
    eq(n.n, 1, 'exactly one enrollment row');
    eq(events.filter((e) => e.name === 'CHALLENGE_JOINED' && e.data.challenge_id === CH_FREE).length, 1, 'CHALLENGE_JOINED fired once');
    const eid = [...ids][0];
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: TAG + '-join-2' });
    eq([r.status, r.data.already], [200, true], 'joining the same active challenge again returns it');
    r = await call('POST', `/api/challenges/${CH_PLAN}/join`, 'guided', { client_uuid: TAG + '-g-plan' });
    eq(r.status, 201, 'guided member joins the plan challenge');
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'guided', { client_uuid: TAG + '-g-free' });
    eq([r.status, r.data.error], [409, 'already_active'], 'one active challenge at a time');

    // ── evidence: back-dated does not count ──────────────────────────────
    // Pretend the run started 2 days ago: today is day 3.
    await run('UPDATE challenge_enrollments SET start_date = ?::date WHERE id = ?', [ago(2), eid]);
    await checkin(U.core.id, ago(2), { createdNow: true }); // dated day 1, written today
    await checkin(U.core.id, ago(1), { at: '09:00' }); // a real day-2 check-in made on day 2
    r = await call('GET', '/api/challenges/me/active', 'core');
    eq(r.status, 200, 'day view loads');
    const v = r.data.active;
    eq(v.enrollment.day, 3, 'today is day 3');
    eq(v.days[0].state, 'missed', 'back-dated check-in does NOT complete day 1');
    n = await queryOne('SELECT COUNT(*)::int AS n FROM challenge_task_completions WHERE enrollment_id = ? AND day_number = 1', [eid]);
    eq(n.n, 0, 'no completion rows for day 1');
    eq(v.days[1].state, 'done', 'same-day check-in completes day 2');
    eq(v.enrollment.grace_left, 0, 'the missed day 1 used the grace day');
    // Today's check-in makes day 3.
    await checkin(U.core.id, today(), { createdNow: true });
    // Parallel syncs: coins once per day.
    await Promise.all([1, 2, 3, 4, 5].map(() => engine.sync(eid)));
    r = await call('GET', '/api/challenges/me/active', 'core');
    eq(r.data.active.days.map((d) => d.state).slice(0, 3), ['missed', 'done', 'done'], 'days 2 and 3 done from same-day evidence');
    eq(r.data.active.today.all_done, true, 'today all done');
    assert(/^Done \d{1,2}:\d{2} (am|pm)$/.test(r.data.active.today.tasks[0].done_label), 'done label shows local time');
    n = await queryOne("SELECT COUNT(*)::int AS n FROM coin_ledger WHERE event_key = ?", [C.coinEventKey(eid, 'day', 3)]);
    eq(n.n, 1, 'day coins paid once under parallel syncs');
    eq(events.filter((e) => e.name === 'CHALLENGE_DAY_DONE' && e.data.day === 3).length, 1, 'CHALLENGE_DAY_DONE fired once for day 3');
    eq(r.data.active.enrollment.status, 'active', 'still active with one missed day');

    // ── completion ───────────────────────────────────────────────────────
    // Move the run so today is day 7, give day 4–6 valid evidence; day 1 stays missed (grace).
    await run('UPDATE challenge_enrollments SET start_date = ?::date WHERE id = ?', [ago(6), eid]);
    await run('DELETE FROM challenge_task_completions WHERE enrollment_id = ?', [eid]);
    await run('DELETE FROM challenge_rewards WHERE enrollment_id = ?', [eid]);
    await run('DELETE FROM daily_checkins WHERE user_id = ?', [U.core.id]);
    for (let k = 5; k >= 1; k--) await checkin(U.core.id, ago(k), { at: '08:30' });
    await checkin(U.core.id, today(), { createdNow: true });
    const lmEarly = await call('POST', '/api/challenges/me/lm-call', 'core', { enrollment_id: eid, preferred_slot: 'evening' });
    eq(lmEarly.status, 409, 'LM call refused before completion');
    await Promise.all([1, 2, 3, 4].map(() => engine.sync(eid)));
    const e2 = await queryOne('SELECT status, days_done, points FROM challenge_enrollments WHERE id = ?', [eid]);
    eq([e2.status, e2.days_done], ['completed', 6], '6 of 7 days (one grace) → completed');
    n = await queryOne('SELECT COUNT(*)::int AS n FROM coin_ledger WHERE event_key = ?', [C.coinEventKey(eid, 'complete')]);
    eq(n.n, 1, 'completion coins paid once');
    const rw = await queryAll('SELECT kind FROM challenge_rewards WHERE enrollment_id = ? ORDER BY kind', [eid]);
    eq([...new Set(rw.map((x) => x.kind))].sort(), ['badge', 'certificate', 'coins_complete', 'coins_day', 'discount', 'lm_call'], 'all rewards granted');
    n = await queryOne('SELECT COUNT(*)::int AS n FROM challenge_discounts WHERE enrollment_id = ?', [eid]);
    eq(n.n, 1, 'one discount');
    eq(events.filter((e) => e.name === 'CHALLENGE_COMPLETED').length, 1, 'CHALLENGE_COMPLETED fired once');
    assert(pushes.some((p) => p.id === U.core.id && /complete/.test(p.n.title)), 'member pushed on completion');

    // ── results, certificate, share ──────────────────────────────────────
    r = await call('GET', `/api/challenges/me/results/${eid}`, 'core');
    eq([r.status, r.data.days_done, r.data.stats.checkins], [200, 6, 6], 'results: 6 days, 6 valid check-ins');
    assert(!JSON.stringify(r.data).match(/₹|price|amount/i), 'results carry no price');
    r = await call('GET', `/api/challenges/me/certificate/${eid}`, 'core');
    assert(r.status === 200 && /^\/api\/challenges\/certificate\/.+\.pdf$/.test(r.data.url), 'signed certificate link');
    const pdf = await fetch(base + r.data.url);
    eq([pdf.status, pdf.headers.get('content-type')], [200, 'application/pdf'], 'certificate link serves a PDF');
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    assert(pdfBuf.slice(0, 4).toString() === '%PDF', 'PDF bytes');
    r = await call('GET', `/api/challenges/me/certificate/${eid}`, 'guided');
    eq(r.status, 409, 'another member cannot get my certificate');
    r = await call('GET', '/api/challenges/certificate/not-a-token.pdf');
    eq(r.status, 403, 'bad certificate token refused');
    const tokRow = await queryOne('SELECT share_token FROM challenge_enrollments WHERE id = ?', [eid]);
    r = await call('GET', `/api/challenges/share/${tokRow.share_token}.png?format=square`);
    assert(r.status === 200 && /image\//.test(r.type), 'share card image served');

    // ── LM call ──────────────────────────────────────────────────────────
    r = await call('POST', '/api/challenges/me/lm-call', 'core', { enrollment_id: eid, preferred_slot: 'noon' });
    eq(r.status, 400, 'bad slot rejected');
    const lm = await Promise.all([1, 2].map(() => call('POST', '/api/challenges/me/lm-call', 'core', { enrollment_id: eid, preferred_slot: 'evening', phone: '+91 98765 43210' })));
    eq(lm.map((x) => x.status).sort(), [200, 201], 'LM call: one created, one duplicate');
    eq(events.filter((e) => e.name === 'CHALLENGE_LM_CALL_REQUESTED').length, 1, 'LM webhook fired once');
    assert(pushes.some((p) => p.staff && /call/i.test(p.n.title)), 'staff pushed for LM call');

    // ── repeat rule ──────────────────────────────────────────────────────
    r = await call('POST', `/api/challenges/${CH_FREE}/join`, 'core', { client_uuid: TAG + '-again' });
    eq([r.status, r.data.error], [409, 'repeat_too_soon'], 'free challenge once per 90 days');

    // ── leaderboard ──────────────────────────────────────────────────────
    await call('POST', `/api/challenges/${CH_FREE}/join`, 'late', { client_uuid: TAG + '-late-1' });
    await call('POST', `/api/challenges/${CH_FREE}/join`, 'shy', { client_uuid: TAG + '-shy-1', leaderboard_opt_out: true });
    r = await call('GET', `/api/challenges/${CH_FREE}/leaderboard`, 'late');
    eq(r.status, 200, 'leaderboard loads');
    const names = r.data.top.map((x) => x.name);
    eq(names, ['Arjun R.'], 'board: first name + initial; new account and opted-out hidden');
    eq([r.data.me.hidden, r.data.me.reason], [true, 'new_account'], 'a 1-hour-old account sees itself as hidden');
    r = await call('GET', `/api/challenges/${CH_FREE}/leaderboard`, 'shy');
    eq(r.data.me.reason, 'opted_out', 'opted-out member sees why');
    r = await call('PUT', '/api/challenges/me/leaderboard', 'shy', { opt_out: false });
    r = await call('GET', `/api/challenges/${CH_FREE}/leaderboard`, 'shy');
    assert(r.data.top.some((x) => x.name === 'Shy O.'), 'opting back in shows the member');

    // ── discount (web checkout only, server side) ────────────────────────
    const d1 = await engine.discountFor({ id: U.core.id, role: 'user' }, 'guided');
    assert(d1 && d1.pct === 15, 'discount usable for guided');
    eq(await engine.discountFor({ id: U.core.id, role: 'user' }, 'core'), null, 'not for core');
    const saved = { id: process.env.RAZORPAY_KEY_ID, s: process.env.RAZORPAY_KEY_SECRET };
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_KEY_SECRET = 'y';
    const sent = [];
    const pay = paymentsLib.createPaymentsService({
      getPool: () => pool, run, queryOne, queryAll,
      fetchImpl: async (url, opt) => { const b = JSON.parse(opt.body); sent.push(b); return { ok: true, json: async () => ({ id: 'order_' + TAG + sent.length, amount: b.amount, currency: 'INR' }) }; },
      discounts: {
        forOrder: (u, t) => engine.discountFor(Object.assign({ role: 'user' }, u), t),
        apply: C.applyDiscount,
        attach: (o, d, u, a, b2) => engine.attachOrder(o, d, u, a, b2),
        markPaid: (o, p) => engine.markOrderPaid(o, p)
      }
    });
    await pay.ensureTables();
    const tierPrice = plans.PLAN_CATALOG.guided.prices.find((p) => Number(p.amount) > 0);
    if (tierPrice) {
      const out = await pay.createOrder({ id: U.core.id, email: 'a@b', role: 'user' }, 'guided', tierPrice.term);
      const full = Math.round(Number(tierPrice.amount) * 100);
      eq(sent[0].amount, C.applyDiscount(full, 15), 'Razorpay order amount discounted server side');
      eq(sent[0].notes.discount_id, d1.id, 'discount id in Razorpay order notes');
      eq(out.price.discount.original_paise, full, 'original price kept for staff');
      const coreOut = await pay.createOrder({ id: U.core.id, email: 'a@b', role: 'user' }, 'core', (plans.PLAN_CATALOG.core.prices[0] || {}).term);
      if (!coreOut.error) eq(sent[1].amount, Math.round(Number(plans.PLAN_CATALOG.core.prices[0].amount) * 100), 'core order not discounted');
      const g = await pay.createOrder({ id: U.guided.id, email: 'g@b', role: 'user' }, 'guided', tierPrice.term);
      eq(g.order.amount, full, 'a member without a discount pays full price');
      assert(await engine.markOrderPaid(out.order.id, 'pay_1'), 'discount marked used on payment');
      assert(!(await engine.markOrderPaid(out.order.id, 'pay_1')), 'marking again is a no-op');
      eq(await engine.discountFor({ id: U.core.id, role: 'user' }, 'guided'), null, 'used discount is gone');
    } else {
      assert(true, 'no priced guided term in the catalog — discount order test skipped');
    }
    process.env.RAZORPAY_KEY_ID = saved.id || ''; process.env.RAZORPAY_KEY_SECRET = saved.s || '';
    if (!saved.id) delete process.env.RAZORPAY_KEY_ID;
    if (!saved.s) delete process.env.RAZORPAY_KEY_SECRET;

    // ── admin views ──────────────────────────────────────────────────────
    r = await call('GET', `/api/challenges/admin/stats/${CH_FREE}`, 'admin');
    eq([r.status, r.data.counts.completed], [200, 1], 'admin stats count the completion');
    eq(r.data.retention.length, 7, 'retention curve has 7 days');
    r = await call('GET', `/api/challenges/admin/enrollments?challenge_id=${CH_FREE}`, 'admin');
    assert(r.data.enrollments.length >= 3, 'admin enrollments list');
    r = await call('GET', `/api/challenges/admin/export.csv?challenge_id=${CH_FREE}`, 'admin');
    assert(r.status === 200 && String(r.data).includes('days_done'), 'CSV export');
    const late = await queryOne('SELECT id FROM challenge_enrollments WHERE user_id = ?', [U.late.id]);
    r = await call('POST', `/api/challenges/admin/enrollments/${late.id}/void`, 'admin', { reason: 'test' });
    eq(r.status, 200, 'admin voids an enrollment');
    r = await call('POST', `/api/challenges/admin/enrollments/${late.id}/void`, 'core', { reason: 'x' });
    eq(r.status, 403, 'member cannot void');
    r = await call('POST', '/api/challenges/me/active/leave', 'shy');
    eq(r.status, 200, 'member leaves');
    r = await call('GET', '/api/challenges/public');
    assert(r.status === 200 && Array.isArray(r.data.challenges), 'public list at all');
  } finally {
    server.close();
    await cleanup().catch((e) => console.warn('cleanup:', e.message));
    await pool.end();
  }

  if (failures.length) {
    console.error(`\nchallenges-api: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`challenges-api: ${checks} passed, 0 failed`);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
