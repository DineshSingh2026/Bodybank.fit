'use strict';

// ── Website payments through Razorpay ────────────────────────────────────────
//
// Web only. The iOS / Android apps never render a price or a buy button (Apple
// 3.1.1 / Google Play Payments) — see services/plans.js. A member buys on the
// website, and the app unlocks through the same plan_tier + access_expires_at
// columns the admin Activate button writes.
//
// Flow:
//   1. POST /api/payments/order   — the server prices the plan from PLAN_CATALOG
//      (never from the browser), creates a Razorpay order and a `payments` row.
//   2. Razorpay Checkout runs in the browser.
//   3. POST /api/payments/verify  — checks the checkout signature, re-reads the
//      payment from Razorpay (amount, order, status), captures it if needed and
//      activates the plan.
//   4. POST /api/payments/webhook — the same activation, for when the buyer
//      closed the tab before step 3. Whichever arrives first wins; the other is
//      a no-op (row lock + applied_at).
//
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET.

const crypto = require('crypto');
const plans = require('./plans');

const API = 'https://api.razorpay.com/v1';
const CURRENCY = 'INR';

function config() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  return {
    keyId,
    keySecret,
    webhookSecret,
    enabled: !!(keyId && keySecret),
    mode: keyId.startsWith('rzp_live_') ? 'live' : 'test'
  };
}

// The catalog price for a plan + term, or null. Amounts in the catalog are rupees.
function priceFor(tier, term) {
  const t = plans.normalizeTier(tier);
  if (!t) return null;
  const p = (plans.PLAN_CATALOG[t].prices || []).find((x) => x.term === String(term || ''));
  // A term is whole months, or (for short terms) whole days.
  if (!p || !(Number(p.amount) > 0) || !(Number(p.months) > 0 || Number(p.days) > 0)) return null;
  return {
    tier: t,
    term: p.term,
    months: Number(p.months) || 0,
    days: Number(p.days) || 0,
    amount_rupees: Number(p.amount),
    amount_paise: Math.round(Number(p.amount) * 100),
    label: p.label
  };
}

function termLabel(months, days) {
  if (!(months > 0) && days > 0) return days + (days === 1 ? ' Day' : ' Days');
  return months + (months === 1 ? ' Month' : ' Months');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Checkout handler signature: HMAC-SHA256(order_id + "|" + payment_id, key secret).
function verifyCheckoutSignature(orderId, paymentId, signature, keySecret) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(orderId + '|' + paymentId).digest('hex');
  return safeEqualHex(expected, signature);
}

// Webhook signature: HMAC-SHA256(raw request body, webhook secret).
function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!rawBody || !signature || !webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

// When the new access ends. Buying the plan you're already on extends your
// remaining time; any other plan (or a lapsed one) starts today.
function computeAccessWindow(user, tier, months, now = new Date(), days = 0) {
  const curTier = plans.tierOf(user);
  const state = plans.accessState(user);
  const exp = user && user.access_expires_at ? new Date(user.access_expires_at) : null;
  const stack = curTier === tier && (state === 'active' || state === 'trialing') &&
    exp && Number.isFinite(exp.getTime()) && exp.getTime() > now.getTime();
  const from = stack ? new Date(exp.getTime()) : new Date(now.getTime());
  const until = new Date(from.getTime());
  if (months > 0) until.setMonth(until.getMonth() + months);
  if (days > 0) until.setDate(until.getDate() + days);
  return { from, until, extended: !!stack };
}

/**
 * @param {object} deps
 * @param {() => import('pg').Pool} deps.getPool  pool is created at boot, so pass a getter
 * @param {Function} deps.run
 * @param {Function} deps.queryOne
 * @param {Function} deps.queryAll
 * @param {Function} [deps.onActivated]  (info) => void, side effects after commit
 * @param {Function} [deps.fetchImpl]    for tests
 */
function createPaymentsService(deps) {
  const { getPool, run, queryOne, queryAll } = deps;
  const onActivated = typeof deps.onActivated === 'function' ? deps.onActivated : () => {};
  // Staff alerts for refunds / mismatches: (kind, info) => void.
  const onEvent = (kind, info) => {
    try { if (typeof deps.onEvent === 'function') deps.onEvent(kind, info); } catch (e) { console.warn('[payments] onEvent:', e.message); }
  };
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));

  async function rzp(method, path, body) {
    const cfg = config();
    if (!cfg.enabled) throw Object.assign(new Error('Razorpay is not configured'), { code: 'not_configured' });
    const r = await fetchImpl(API + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(cfg.keyId + ':' + cfg.keySecret).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.description) || ('Razorpay HTTP ' + r.status);
      throw Object.assign(new Error(msg), { code: 'razorpay_error', status: r.status });
    }
    return data;
  }

  async function ensureTables() {
    // No foreign key to users on purpose: a payment record must outlive an
    // account deletion (refunds, accounting), so it snapshots who paid.
    await run(`CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'razorpay',
      order_id TEXT UNIQUE NOT NULL,
      payment_id TEXT,
      user_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      plan_tier TEXT NOT NULL,
      term TEXT NOT NULL,
      months INTEGER NOT NULL,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'created',
      source TEXT,
      error TEXT,
      access_from TIMESTAMPTZ,
      access_until TIMESTAMPTZ,
      extended BOOLEAN DEFAULT FALSE,
      refunded_paise INTEGER DEFAULT 0,
      mode TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    await run('ALTER TABLE payments ADD COLUMN IF NOT EXISTS days INTEGER DEFAULT 0');
    await run('CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC)');
    await run('CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments (payment_id)');
  }

  async function createOrder(user, tier, term) {
    const price = priceFor(tier, term);
    if (!price) return { error: 'unknown_plan' };
    const cfg = config();
    const id = crypto.randomUUID();
    const order = await rzp('POST', '/orders', {
      amount: price.amount_paise,
      currency: CURRENCY,
      receipt: ('bb_' + id.replace(/-/g, '')).slice(0, 40),
      notes: { user_id: String(user.id), plan_tier: price.tier, term: price.term, email: String(user.email || '').slice(0, 250) }
    });
    const name = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    await run(
      `INSERT INTO payments (id, order_id, user_id, email, name, plan_tier, term, months, days, amount_paise, currency, status, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
      [id, order.id, String(user.id), user.email || '', name, price.tier, price.term, price.months, price.days, price.amount_paise, CURRENCY, cfg.mode]
    );
    return { order, price, keyId: cfg.keyId, name };
  }

  async function markFailed(orderId, paymentId, reason) {
    await run(
      `UPDATE payments SET status = 'failed', payment_id = COALESCE(?, payment_id), error = ?, updated_at = NOW()
        WHERE order_id = ? AND applied_at IS NULL`,
      [paymentId || null, String(reason || '').slice(0, 300), orderId]
    );
  }

  /**
   * Activate the plan for a captured payment. Idempotent: the payments row is
   * locked, and a row with applied_at set is returned as-is.
   * `payment` is the Razorpay payment entity (already fetched or from a webhook).
   */
  async function fulfil(orderId, payment, source) {
    const client = await getPool().connect();
    let info = null;
    try {
      await client.query('BEGIN');
      const pr = await client.query('SELECT * FROM payments WHERE order_id = $1 FOR UPDATE', [orderId]);
      const row = pr.rows[0];
      if (!row) { await client.query('ROLLBACK'); return { ok: false, reason: 'unknown_order' }; }
      if (row.applied_at) { await client.query('COMMIT'); return { ok: true, already: true, payment: row }; }

      // The money must match the order we priced. Razorpay enforces this for
      // orders, but a mismatch here is never activated.
      if (!payment || payment.order_id !== orderId || Number(payment.amount) !== Number(row.amount_paise) ||
          String(payment.currency || '').toUpperCase() !== String(row.currency).toUpperCase()) {
        await client.query(
          "UPDATE payments SET status = 'mismatch', payment_id = $1, error = $2, updated_at = NOW() WHERE order_id = $3",
          [payment && payment.id, 'Amount/order mismatch', orderId]
        );
        await client.query('COMMIT');
        onEvent('attention', { row, payment, reason: 'Paid amount or order did not match what we priced. Plan NOT activated.' });
        return { ok: false, reason: 'mismatch' };
      }
      if (payment.status !== 'captured') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_captured', status: payment.status };
      }

      const ur = await client.query(
        // access_expires_at is a zone-less column holding UTC; read it as UTC so
        // the maths is right whatever timezone the server runs in.
        `SELECT id, role, email, first_name, last_name, phone, plan_tier, subscription_status,
                (access_expires_at AT TIME ZONE 'UTC') AS access_expires_at
           FROM users WHERE id = $1 FOR UPDATE`,
        [row.user_id]
      );
      const user = ur.rows[0];
      if (!user || user.role !== 'user') {
        // Paid, but there is no member account to unlock — staff handle it.
        await client.query(
          "UPDATE payments SET status = 'paid', payment_id = $1, paid_at = COALESCE(paid_at, NOW()), source = $2, error = $3, updated_at = NOW() WHERE order_id = $4",
          [payment.id, source, user ? 'Account is not a member account' : 'Account not found', orderId]
        );
        await client.query('COMMIT');
        info = { orphan: true, row, user, payment };
        return { ok: false, reason: 'no_member', payment: row };
      }

      const tier = row.plan_tier;
      const months = Number(row.months);
      const days = Number(row.days) || 0;
      const win = computeAccessWindow(user, tier, months, new Date(), days);
      const label = (plans.tierName(tier) + ' · ' + termLabel(months, days)).slice(0, 40);
      const previous = { tier: plans.tierOf(user), state: plans.accessState(user), expires_at: user.access_expires_at };

      await client.query(
        `UPDATE users SET subscription_status = 'active', approval_status = 'approved', suspended = FALSE,
                plan_label = $1, plan_tier = $2, access_expires_at = $3, activated_at = NOW(),
                activated_by = 'razorpay', trial_reminder_sent = ''
          WHERE id = $4`,
        [label, tier, win.until.toISOString(), user.id]
      );
      const upd = await client.query(
        `UPDATE payments SET status = 'paid', payment_id = $1, paid_at = COALESCE(paid_at, NOW()), applied_at = NOW(),
                source = $2, error = NULL, access_from = $3, access_until = $4, extended = $5, updated_at = NOW()
          WHERE order_id = $6 RETURNING *`,
        [payment.id, source, win.from.toISOString(), win.until.toISOString(), win.extended, orderId]
      );
      await client.query('COMMIT');
      info = { row: upd.rows[0], user, label, window: win, previous, payment };
      return { ok: true, payment: upd.rows[0], label };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
      if (info) { try { onActivated(info); } catch (e) { console.warn('[payments] onActivated:', e.message); } }
    }
  }

  // Browser path: trust nothing from the client except ids; re-read the payment
  // from Razorpay and capture it if the account isn't on auto-capture.
  async function verifyAndFulfil(userId, orderId, paymentId, signature) {
    const cfg = config();
    const row = await queryOne('SELECT * FROM payments WHERE order_id = ?', [orderId]);
    if (!row || String(row.user_id) !== String(userId)) return { ok: false, reason: 'unknown_order' };
    if (row.applied_at) return { ok: true, already: true, payment: row };
    if (!verifyCheckoutSignature(orderId, paymentId, signature, cfg.keySecret)) {
      await markFailed(orderId, paymentId, 'Bad checkout signature');
      return { ok: false, reason: 'bad_signature' };
    }
    let payment = await rzp('GET', '/payments/' + encodeURIComponent(paymentId));
    if (payment.order_id !== orderId) return { ok: false, reason: 'mismatch' };
    if (payment.status === 'authorized') {
      payment = await rzp('POST', '/payments/' + encodeURIComponent(paymentId) + '/capture', {
        amount: Number(row.amount_paise), currency: row.currency
      });
    }
    if (payment.status === 'failed') {
      await markFailed(orderId, paymentId, payment.error_description || 'Payment failed');
      return { ok: false, reason: 'failed' };
    }
    return fulfil(orderId, payment, 'checkout');
  }

  // Webhook path. Body already signature-checked by the caller.
  async function handleWebhookEvent(evt) {
    const type = String((evt && evt.event) || '');
    const pay = evt && evt.payload && evt.payload.payment && evt.payload.payment.entity;
    if (type === 'payment.captured' || type === 'order.paid') {
      if (!pay || !pay.order_id) return { ok: true, ignored: 'no_payment' };
      return fulfil(pay.order_id, pay, 'webhook');
    }
    if (type === 'payment.failed') {
      if (pay && pay.order_id) await markFailed(pay.order_id, pay.id, pay.error_description || 'Payment failed');
      return { ok: true };
    }
    if (type === 'refund.processed' || type === 'refund.created') {
      const ref = evt.payload && evt.payload.refund && evt.payload.refund.entity;
      const paymentId = (ref && ref.payment_id) || (pay && pay.id);
      if (!paymentId) return { ok: true, ignored: 'no_payment' };
      // Refunds don't touch the member's access automatically — staff decide.
      const amountRefunded = pay && Number(pay.amount_refunded) > 0 ? Number(pay.amount_refunded) : Number(ref && ref.amount) || 0;
      const r = await run(
        `UPDATE payments SET refunded_paise = GREATEST(COALESCE(refunded_paise, 0), ?),
                status = CASE WHEN GREATEST(COALESCE(refunded_paise, 0), ?) >= amount_paise THEN 'refunded' ELSE 'partially_refunded' END,
                updated_at = NOW()
          WHERE payment_id = ? RETURNING *`,
        [amountRefunded, amountRefunded, paymentId]
      );
      const row = r && r.rows && r.rows[0];
      if (row && type === 'refund.processed') onEvent('refunded', { row, amount_paise: amountRefunded });
      return { ok: true, refunded: row || null };
    }
    return { ok: true, ignored: type || 'unknown' };
  }

  async function listForUser(userId, limit = 20) {
    return queryAll(
      `SELECT order_id, payment_id, plan_tier, term, months, days, amount_paise, currency, status,
              access_from, access_until, created_at, paid_at
         FROM payments WHERE user_id = ? AND status <> 'created'
        ORDER BY created_at DESC LIMIT ?`,
      [String(userId), Math.min(Math.max(Number(limit) || 20, 1), 100)]
    );
  }

  async function listAll(limit = 200) {
    return queryAll(
      `SELECT p.*, u.first_name AS user_first_name, u.last_name AS user_last_name, u.phone AS user_phone
         FROM payments p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.status <> 'created' OR p.created_at > NOW() - INTERVAL '2 days'
        ORDER BY p.created_at DESC LIMIT ?`,
      [Math.min(Math.max(Number(limit) || 200, 1), 1000)]
    );
  }

  return { ensureTables, createOrder, verifyAndFulfil, handleWebhookEvent, fulfil, listForUser, listAll };
}

module.exports = {
  config,
  priceFor,
  termLabel,
  computeAccessWindow,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  createPaymentsService
};
