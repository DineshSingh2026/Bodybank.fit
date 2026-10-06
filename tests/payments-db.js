/**
 * Integration test: website payments (Razorpay) against a real Postgres.
 * Run: node tests/payments-db.js        (needs DATABASE_URL; NOT part of test:units)
 *
 * NO NETWORK: Razorpay's API is replaced by an in-process fake. The router, the
 * service and every SQL statement are the real ones. It creates its own members
 * (email prefix pay-test-) and removes them and their payment rows at the end.
 *
 * What this guards:
 *  - the browser cannot set the price: the order is priced from PLAN_CATALOG;
 *  - a payment activates the plan exactly once, however many times the browser
 *    confirm and the webhook both arrive (and in either order);
 *  - a forged checkout signature, a forged webhook, a wrong amount, or another
 *    member's order never activates anything;
 *  - buying the plan you are on extends your remaining time; another plan starts today;
 *  - an expired member's renew token can pay, but cannot open a session;
 *  - a refund is recorded and does not touch the member's access.
 */

require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Pool } = require('pg');

process.env.RAZORPAY_KEY_ID = 'rzp_test_unit0000000000';
process.env.RAZORPAY_KEY_SECRET = 'unit_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'unit_webhook_secret';

const auth = require('../middleware/auth');
const paymentsLib = require('../services/payments');
const { createPaymentsRouter } = require('../routes/payments');

const failures = [];
let checks = 0;
function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

if (!process.env.DATABASE_URL) {
  console.log('payments-db: DATABASE_URL not set — skipped');
  process.exit(0);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const run = (sql, p = []) => pool.query(toPg(sql), p);
const queryAll = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
const queryOne = async (sql, p = []) => (await queryAll(sql, p))[0] || null;

// ── Fake Razorpay ───────────────────────────────────────────────────────────
const rz = { orders: {}, payments: {}, captures: 0 };
let seq = 0;
async function fakeFetch(url, opts) {
  const path = url.replace('https://api.razorpay.com/v1', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (!String(opts.headers.Authorization || '').startsWith('Basic ')) return { ok: false, status: 401, json: async () => ({ error: { description: 'auth' } }) };
  if (opts.method === 'POST' && path === '/orders') {
    const o = { id: 'order_T' + (++seq) + crypto.randomBytes(4).toString('hex'), amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: 'created' };
    rz.orders[o.id] = o;
    return ok(o);
  }
  let m = path.match(/^\/payments\/([^/]+)$/);
  if (opts.method === 'GET' && m) return rz.payments[m[1]] ? ok(rz.payments[m[1]]) : { ok: false, status: 400, json: async () => ({ error: { description: 'no such payment' } }) };
  m = path.match(/^\/payments\/([^/]+)\/capture$/);
  if (opts.method === 'POST' && m) { rz.captures += 1; rz.payments[m[1]].status = 'captured'; return ok(rz.payments[m[1]]); }
  return { ok: false, status: 404, json: async () => ({ error: { description: 'unknown ' + path } }) };
}
function fakePay(orderId, over = {}) {
  const o = rz.orders[orderId];
  const p = Object.assign({ id: 'pay_T' + (++seq) + crypto.randomBytes(4).toString('hex'), order_id: orderId, amount: o.amount, currency: o.currency, status: 'captured' }, over);
  rz.payments[p.id] = p;
  return p;
}
const checkoutSig = (orderId, payId, secret = 'unit_key_secret') => crypto.createHmac('sha256', secret).update(orderId + '|' + payId).digest('hex');

// ── App under test ──────────────────────────────────────────────────────────
const events = [];
const service = paymentsLib.createPaymentsService({
  getPool: () => pool, run, queryOne, queryAll, fetchImpl: fakeFetch,
  onActivated: (info) => events.push(['activated', info]),
  onEvent: (kind, info) => events.push([kind, info])
});
const app = express();
app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json());
app.use('/api/payments', createPaymentsRouter({
  service, queryOne,
  verifyToken: auth.verifyToken,
  verifyRenewToken: auth.verifyRenewToken,
  requireAdminOrSuperadmin: auth.requireAdminOrSuperadmin
}));
// A stand-in for every normal member route, to prove a renew token opens none.
app.get('/api/me/anything', auth.verifyToken, (req, res) => res.json({ id: req.user.id }));

let base = '';
async function call(method, path, { token, body, raw, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (token) h.Authorization = 'Bearer ' + token;
  let payload;
  if (raw != null) { payload = raw; h['Content-Type'] = 'application/json'; }
  else if (body) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(base + path, { method, headers: h, body: payload });
  let json = {};
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}
function webhook(evt, secret = 'unit_webhook_secret') {
  const raw = JSON.stringify(evt);
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return call('POST', '/api/payments/webhook', { raw, headers: { 'X-Razorpay-Signature': sig } });
}

const made = [];
async function makeUser(tag, fields = {}) {
  const id = 'pay-test-' + tag + '-' + crypto.randomBytes(4).toString('hex');
  const f = Object.assign({ role: 'user', plan_tier: 'guided', subscription_status: 'trialing', access_expires_at: null }, fields);
  await run(
    `INSERT INTO users (id, email, password, first_name, last_name, role, approval_status, plan_tier, subscription_status, access_expires_at)
     VALUES (?, ?, 'x', 'Pay', ?, ?, 'approved', ?, ?, ?)`,
    [id, id + '@example.test', tag, f.role, f.plan_tier, f.subscription_status, f.access_expires_at]
  );
  made.push(id);
  return { id, email: id + '@example.test', role: f.role, token: auth.signToken({ id, email: id + '@example.test', role: f.role }) };
}
const userRow = (id) => queryOne("SELECT plan_tier, plan_label, subscription_status, (access_expires_at AT TIME ZONE 'UTC') AS access_expires_at, activated_by FROM users WHERE id = ?", [id]);
const days = (n) => new Date(Date.now() + n * 86400000);
const near = (a, b, tolMs = 5 * 60 * 1000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < tolMs;
const plusMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };

async function main() {
  await service.ensureTables();
  await service.ensureTables(); // idempotent
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;

  // ── config ──
  let r = await call('GET', '/api/payments/config');
  assert(r.json.enabled === true && r.json.key_id === 'rzp_test_unit0000000000' && r.json.mode === 'test', 'config exposes the public key id and test mode');
  assert(!JSON.stringify(r.json).includes('unit_key_secret'), 'config never exposes the key secret');

  // ── order: auth + server-side price ──
  r = await call('POST', '/api/payments/order', { body: { plan_tier: 'guided', term: '1m' } });
  assert(r.status === 401, 'an order needs a signed-in member');

  const trial = await makeUser('trial', { plan_tier: 'guided', subscription_status: 'trialing', access_expires_at: days(3).toISOString() });
  r = await call('POST', '/api/payments/order', { token: trial.token, body: { plan_tier: 'guided', term: '4m', amount: 100, months: 99 } });
  assert(r.status === 200 && r.json.amount === 999900 && r.json.currency === 'INR', 'Guided 4 months is priced by the server at ₹9,999, ignoring a browser-sent amount (got ' + r.json.amount + ')');
  assert(r.json.plan && r.json.plan.months === 4, 'the term comes from the catalog, not the browser');
  const order1 = r.json.order_id;

  r = await call('POST', '/api/payments/order', { token: trial.token, body: { plan_tier: 'guided', term: '99m' } });
  assert(r.status === 400 && r.json.error === 'unknown_plan', 'a term that is not in the catalog is refused');
  r = await call('POST', '/api/payments/order', { token: trial.token, body: { plan_tier: 'platinum', term: '1m' } });
  assert(r.status === 400, 'an unknown plan is refused');

  const admin = await makeUser('admin', { role: 'admin', plan_tier: null, subscription_status: 'active' });
  r = await call('POST', '/api/payments/order', { token: admin.token, body: { plan_tier: 'core', term: '12m' } });
  assert(r.status === 403 && r.json.error === 'staff_account', 'staff accounts cannot buy a plan');

  // ── a days-based term (the hidden ₹50 live smoke test, while it exists) ──
  const hiddenTest = (require('../services/plans').PLAN_CATALOG.core.prices || []).find((p) => p.term === 'test');
  assert(!JSON.stringify(require('../services/plans').publicCatalog()).includes('"hidden"'), 'hidden prices never appear in the public catalog');
  if (hiddenTest) {
    const dayUser = await makeUser('day', { plan_tier: 'guided', subscription_status: 'trialing', access_expires_at: days(3).toISOString() });
    r = await call('POST', '/api/payments/order', { token: dayUser.token, body: { plan_tier: 'core', term: 'test' } });
    assert(r.status === 200 && r.json.amount === hiddenTest.amount * 100, 'the hidden test price can be ordered by its direct term');
    const dp = fakePay(r.json.order_id);
    r = await call('POST', '/api/payments/verify', { token: dayUser.token, body: { razorpay_order_id: dp.order_id, razorpay_payment_id: dp.id, razorpay_signature: checkoutSig(dp.order_id, dp.id) } });
    const du = await userRow(dayUser.id);
    assert(r.json.ok === true && du.plan_tier === 'core' && du.plan_label === 'Core · 1 Day' && near(du.access_expires_at, days(1)), 'it buys exactly one day of Core (' + JSON.stringify(du) + ')');
  }

  // ── forged signature never activates ──
  const pay1 = fakePay(order1);
  r = await call('POST', '/api/payments/verify', { token: trial.token, body: { razorpay_order_id: order1, razorpay_payment_id: pay1.id, razorpay_signature: checkoutSig(order1, pay1.id, 'wrong_secret') } });
  assert(r.status === 400 && r.json.error === 'bad_signature', 'a forged checkout signature is rejected');
  let u = await userRow(trial.id);
  assert(u.subscription_status === 'trialing', 'a forged signature leaves the member on trial');

  // ── another member cannot confirm someone else's order ──
  const other = await makeUser('other', { plan_tier: 'core', subscription_status: 'active', access_expires_at: days(10).toISOString() });
  r = await call('POST', '/api/payments/verify', { token: other.token, body: { razorpay_order_id: order1, razorpay_payment_id: pay1.id, razorpay_signature: checkoutSig(order1, pay1.id) } });
  assert(r.status === 400 && r.json.error === 'unknown_order', "a member cannot confirm another member's order");

  // ── real confirm: same tier on trial → added on top of the trial days ──
  const trialEnd = (await userRow(trial.id)).access_expires_at;
  r = await call('POST', '/api/payments/verify', { token: trial.token, body: { razorpay_order_id: order1, razorpay_payment_id: pay1.id, razorpay_signature: checkoutSig(order1, pay1.id) } });
  assert(r.status === 200 && r.json.ok === true && r.json.plan_tier === 'guided' && r.json.extended === true, 'a valid payment activates the plan (' + JSON.stringify(r.json) + ')');
  u = await userRow(trial.id);
  assert(u.subscription_status === 'active' && u.plan_tier === 'guided' && u.plan_label === 'Guided · 4 Months' && u.activated_by === 'razorpay', 'the member row is active on Guided · 4 Months (' + JSON.stringify(u) + ')');
  assert(near(u.access_expires_at, plusMonths(trialEnd, 4)), 'same plan: 4 months are added on top of the remaining trial days');
  const firstExpiry = u.access_expires_at;
  assert(events.filter((e) => e[0] === 'activated' && e[1].user.id === trial.id).length === 1, 'activation side effects fire once');

  // ── idempotency: confirm again + webhook twice ──
  r = await call('POST', '/api/payments/verify', { token: trial.token, body: { razorpay_order_id: order1, razorpay_payment_id: pay1.id, razorpay_signature: checkoutSig(order1, pay1.id) } });
  assert(r.status === 200 && r.json.ok === true, 'a repeated confirm still reports success');
  const captured = { event: 'payment.captured', payload: { payment: { entity: pay1 } } };
  r = await webhook(captured);
  assert(r.status === 200 && r.json.result === 'already', 'the webhook for an already-applied payment is a no-op');
  await webhook({ event: 'order.paid', payload: { payment: { entity: pay1 } } });
  u = await userRow(trial.id);
  assert(new Date(u.access_expires_at).getTime() === new Date(firstExpiry).getTime(), 'a payment is never applied twice (expiry unchanged after 3 repeats)');
  assert(events.filter((e) => e[0] === 'activated' && e[1].user.id === trial.id).length === 1, 'repeats do not notify again');

  // ── webhook first (buyer closed the tab), then two at once ──
  r = await call('POST', '/api/payments/order', { token: other.token, body: { plan_tier: 'guided', term: '1m' } });
  const order2 = r.json.order_id;
  const pay2 = fakePay(order2);
  const evt2 = { event: 'payment.captured', payload: { payment: { entity: pay2 } } };
  const both = await Promise.all([webhook(evt2), webhook(evt2), call('POST', '/api/payments/verify', { token: other.token, body: { razorpay_order_id: order2, razorpay_payment_id: pay2.id, razorpay_signature: checkoutSig(order2, pay2.id) } })]);
  assert(both.every((x) => x.status === 200), 'concurrent webhook + confirm all succeed');
  u = await userRow(other.id);
  assert(u.plan_tier === 'guided' && u.subscription_status === 'active', 'webhook alone activates the plan (Core → Guided)');
  assert(near(u.access_expires_at, plusMonths(new Date(), 1)), 'a different plan starts today: 1 month from now, not from the old Core expiry');
  assert(events.filter((e) => e[0] === 'activated' && e[1].user.id === other.id).length === 1, 'three concurrent deliveries activate once');
  r = await call('GET', '/api/payments/status/' + order2, { token: other.token });
  assert(r.json.active === true && r.json.status === 'paid', 'status reports the paid order as active');
  r = await call('GET', '/api/payments/status/' + order2, { token: trial.token });
  assert(r.status === 404, "another member cannot read the order's status");

  // ── forged / unsigned webhook ──
  r = await call('POST', '/api/payments/order', { token: other.token, body: { plan_tier: 'tribe_elite', term: '1m' } });
  const order3 = r.json.order_id;
  assert(r.json.amount === 1800000, 'Tribe Elite monthly is ₹18,000');
  const pay3 = fakePay(order3);
  r = await webhook({ event: 'payment.captured', payload: { payment: { entity: pay3 } } }, 'attacker_secret');
  assert(r.status === 400, 'a webhook signed with the wrong secret is rejected');
  r = await call('POST', '/api/payments/webhook', { raw: JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: pay3 } } }) });
  assert(r.status === 400, 'an unsigned webhook is rejected');
  u = await userRow(other.id);
  assert(u.plan_tier === 'guided', 'a forged webhook does not upgrade anyone to Tribe Elite');

  // ── wrong amount (₹1 paid against an ₹18,000 order) ──
  const cheap = fakePay(order3, { amount: 100 });
  r = await webhook({ event: 'payment.captured', payload: { payment: { entity: cheap } } });
  u = await userRow(other.id);
  assert(u.plan_tier === 'guided', 'a payment for the wrong amount does not activate the plan');
  let row = await queryOne('SELECT status FROM payments WHERE order_id = ?', [order3]);
  assert(row.status === 'mismatch', 'the mismatched payment is flagged (status ' + row.status + ')');
  assert(events.some((e) => e[0] === 'attention'), 'staff are alerted about a mismatch');

  // ── authorized-not-captured gets captured, then activates ──
  const lapsed = await makeUser('lapsed', { plan_tier: 'guided', subscription_status: 'active', access_expires_at: days(-5).toISOString() });
  const login = require('../services/plans').accessState({ subscription_status: 'active', access_expires_at: days(-5) });
  assert(login === 'expired', 'fixture: the lapsed member is expired');
  const renew = auth.signRenewToken({ id: lapsed.id, email: lapsed.email });
  r = await call('GET', '/api/me/anything', { token: renew });
  assert(r.status === 401, 'a renew token is NOT a session: normal member routes reject it');
  r = await call('GET', '/api/payments/mine', { token: renew });
  assert(r.status === 401, 'a renew token cannot read payment history either');
  r = await call('POST', '/api/payments/order', { token: renew, body: { plan_tier: 'guided', term: '1m' } });
  assert(r.status === 200 && r.json.amount === 299900, 'an expired member can start a renewal with the renew token');
  const order4 = r.json.order_id;
  const pay4 = fakePay(order4, { status: 'authorized' });
  const before = rz.captures;
  r = await call('POST', '/api/payments/verify', { token: renew, body: { razorpay_order_id: order4, razorpay_payment_id: pay4.id, razorpay_signature: checkoutSig(order4, pay4.id) } });
  assert(r.status === 200 && r.json.ok === true && r.json.extended === false, 'the renewal confirms (' + JSON.stringify(r.json) + ')');
  assert(rz.captures === before + 1, 'an authorized payment is captured before activating');
  u = await userRow(lapsed.id);
  assert(u.subscription_status === 'active' && near(u.access_expires_at, plusMonths(new Date(), 1)), 'a lapsed plan restarts from today, not from the old expiry');

  // ── failed payment ──
  r = await call('POST', '/api/payments/order', { token: lapsed.token, body: { plan_tier: 'core', term: '12m' } });
  const order5 = r.json.order_id;
  const pay5 = fakePay(order5, { status: 'failed', error_description: 'Bank declined' });
  await webhook({ event: 'payment.failed', payload: { payment: { entity: pay5 } } });
  row = await queryOne('SELECT status, error FROM payments WHERE order_id = ?', [order5]);
  assert(row.status === 'failed' && row.error === 'Bank declined', 'a failed payment is recorded with its reason');
  u = await userRow(lapsed.id);
  assert(u.plan_tier === 'guided', 'a failed payment changes nothing');
  // …and the same order can still succeed on a retry with another method
  const pay5b = fakePay(order5);
  await webhook({ event: 'payment.captured', payload: { payment: { entity: pay5b } } });
  u = await userRow(lapsed.id);
  assert(u.plan_tier === 'core' && u.plan_label === 'Core · 12 Months', 'a retry on the same order after a failure activates the plan');

  // ── refund: recorded, access untouched ──
  const expiryBeforeRefund = (await userRow(trial.id)).access_expires_at;
  await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: pay1.id, amount: 999900 } }, payment: { entity: Object.assign({}, pay1, { amount_refunded: 999900 }) } } });
  row = await queryOne('SELECT status, refunded_paise FROM payments WHERE order_id = ?', [order1]);
  assert(row.status === 'refunded' && Number(row.refunded_paise) === 999900, 'a full refund is recorded');
  u = await userRow(trial.id);
  assert(u.subscription_status === 'active' && new Date(u.access_expires_at).getTime() === new Date(expiryBeforeRefund).getTime(), 'a refund does not change access by itself');
  assert(events.some((e) => e[0] === 'refunded'), 'staff are alerted about a refund');

  // ── admin list ──
  r = await call('GET', '/api/payments/admin', { token: trial.token });
  assert(r.status === 403, 'members cannot read the admin payments list');
  r = await call('GET', '/api/payments/admin', { token: admin.token });
  assert(r.status === 200 && Array.isArray(r.json.payments) && r.json.payments.some((p) => p.order_id === order2) && r.json.webhook === true, 'admins can list payments');
  r = await call('GET', '/api/payments/mine', { token: other.token });
  assert(r.status === 200 && r.json.payments.every((p) => p.order_id === order2 || p.order_id === order3), 'a member sees only their own payments');

  // ── switched off without keys ──
  const savedKey = process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY_SECRET;
  r = await call('GET', '/api/payments/config');
  assert(r.json.enabled === false && r.json.key_id === null, 'without keys, checkout is reported off');
  r = await call('POST', '/api/payments/order', { token: other.token, body: { plan_tier: 'guided', term: '1m' } });
  assert(r.status === 503, 'without keys, an order is refused cleanly');
  process.env.RAZORPAY_KEY_SECRET = savedKey;

  await new Promise((res) => server.close(res));
}

main()
  .catch((e) => { failures.push('crashed: ' + (e && e.stack || e)); })
  .then(async () => {
    try {
      if (made.length) {
        await pool.query('DELETE FROM payments WHERE user_id = ANY($1)', [made]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [made]);
      }
    } catch (e) { failures.push('cleanup: ' + e.message); }
    await pool.end();
    if (failures.length) {
      console.error('payments-db: ' + failures.length + ' of ' + checks + ' checks FAILED');
      failures.forEach((f) => console.error('  ✗ ' + f));
      process.exit(1);
    }
    console.log('payments-db: all ' + checks + ' checks passed');
  });
