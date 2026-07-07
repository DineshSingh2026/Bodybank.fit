'use strict';

/**
 * Pure unit tests for the AI Coach decision core. No DB, no LLM, no network.
 * Run:  node tests/coach/unit.js
 */

const assert = require('assert');
const taxonomy = require('../../services/coach/taxonomy');
const { valueScore } = require('../../services/coach/valueScore');
const { checkMessage, similarity } = require('../../services/coach/postFilter');
const { inQuietHours, tzNow, hhmmToMinutes } = require('../../services/coach/util');
const { decide } = require('../../services/coach/decisionEngine');
const experiments = require('../../services/coach/experiments');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

(async () => {
  console.log('taxonomy');
  await test('known + unknown events', () => {
    assert.ok(taxonomy.metaFor('WORKOUT_COMPLETED'));
    assert.strictEqual(taxonomy.metaFor('NOPE'), null);
    assert.ok(taxonomy.isKnownEvent('USER_REPLIED'));
  });
  await test('USER_REPLIED and WEEKLY_SUMMARY are budget-exempt', () => {
    assert.ok(taxonomy.BUDGET_EXEMPT.has('USER_REPLIED'));
    assert.ok(taxonomy.BUDGET_EXEMPT.has('WEEKLY_SUMMARY'));
    assert.ok(!taxonomy.BUDGET_EXEMPT.has('WORKOUT_COMPLETED'));
  });

  console.log('valueScore');
  const now = Date.now();
  await test('fresh high-priority event scores high', () => {
    const s = valueScore({ type: 'GOAL_ACHIEVED', created_at: now }, {}, [], now);
    assert.ok(s >= 90, 'expected >=90, got ' + s);
  });
  await test('stale event scores ~0', () => {
    const old = now - 1000 * 3600 * 24 * 10; // 10 days
    const s = valueScore({ type: 'MEAL_LOGGED', created_at: old }, {}, [], now);
    assert.strictEqual(s, 0);
  });
  await test('novelty penalty when topic recently sent', () => {
    const base = valueScore({ type: 'PROTEIN_DEFICIT', created_at: now }, {}, [], now);
    const dup = valueScore({ type: 'PROTEIN_DEFICIT', created_at: now }, {}, ['PROTEIN_DEFICIT'], now);
    assert.ok(dup < base, `${dup} should be < ${base}`);
  });
  await test('weak-dimension boosts user_fit', () => {
    const neutral = valueScore({ type: 'PROTEIN_DEFICIT', created_at: now }, {}, [], now);
    const weak = valueScore({ type: 'PROTEIN_DEFICIT', created_at: now }, { weak_dimension: 'protein' }, [], now);
    assert.ok(weak >= neutral, `${weak} should be >= ${neutral}`);
  });

  console.log('postFilter');
  await test('rejects banned opener', () => {
    const r = checkMessage('I hope this message finds you well. Log your protein.');
    assert.ok(!r.ok && r.reasons.some((x) => x.startsWith('banned_phrase')));
  });
  await test('rejects over-long message', () => {
    const r = checkMessage(Array(200).fill('word').join(' '), { maxWords: 110 });
    assert.ok(!r.ok && r.reasons.includes('too_long'));
  });
  await test('rejects near-duplicate of a recent message', () => {
    const prev = 'Nice work hitting your protein target today, keep it going';
    const r = checkMessage('Nice work hitting your protein target today keep it going!', { recentMessages: [prev] });
    assert.ok(!r.ok && r.reasons.includes('too_similar'));
  });
  await test('accepts a clean message', () => {
    const r = checkMessage("You're at 95g of 150g protein — a Greek yogurt at dinner closes the gap.");
    assert.ok(r.ok, JSON.stringify(r.reasons));
  });
  await test('similarity is symmetric-ish and bounded', () => {
    assert.ok(similarity('a b c', 'a b c') > 0.99);
    assert.strictEqual(similarity('', 'x'), 0);
  });

  console.log('util');
  await test('overnight quiet window', () => {
    assert.ok(inQuietHours('23:00', '21:30', '07:30'));
    assert.ok(inQuietHours('06:00', '21:30', '07:30'));
    assert.ok(!inQuietHours('12:00', '21:30', '07:30'));
  });
  await test('same-day quiet window', () => {
    assert.ok(inQuietHours('13:00', '12:00', '14:00'));
    assert.ok(!inQuietHours('15:00', '12:00', '14:00'));
  });
  await test('tzNow returns a well-formed shape', () => {
    const p = tzNow('Asia/Kolkata');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p.ymd));
    assert.ok(p.hour >= 0 && p.hour <= 23);
    assert.strictEqual(hhmmToMinutes('07:30'), 450);
  });

  console.log('decisionEngine');
  const stubCtx = { queryOne: async () => null, run: async () => {} }; // budget full (no spend row)
  const baseSettings = {
    coach_enabled: true, personality: 'friendly', daily_budget: 2, min_send_threshold: 35,
    quiet_start: '21:30', quiet_end: '07:30', timezone: 'Asia/Kolkata', muted_categories: []
  };
  await test('coach_off suppresses', async () => {
    const d = await decide(stubCtx, mkEvent('WORKOUT_COMPLETED', now), { settings: { ...baseSettings, coach_enabled: false }, now });
    assert.strictEqual(d.action, 'suppress');
    assert.strictEqual(d.reason, 'coach_off');
  });
  await test('muted category suppresses', async () => {
    const d = await decide(stubCtx, mkEvent('WORKOUT_COMPLETED', now), { settings: { ...baseSettings, muted_categories: ['reinforce'] }, now });
    assert.strictEqual(d.action, 'suppress');
    assert.strictEqual(d.reason, 'category_muted');
  });
  await test('low-value reinforce event batches', async () => {
    // MEAL_LOGGED is low base priority → below threshold → batched (it is batchable)
    const d = await decide(stubCtx, mkEvent('MEAL_LOGGED', now), { settings: baseSettings, now });
    assert.ok(d.action === 'batch' || d.action === 'suppress', 'got ' + d.action);
  });
  await test('high-value event sends when budget available', async () => {
    const ctxBudgetOk = { queryOne: async () => ({ spent: 0 }), run: async () => {} };
    const d = await decide(ctxBudgetOk, mkEvent('GOAL_ACHIEVED', now), { settings: baseSettings, now, profile: { typical_active_hour: new Date().getHours() } });
    assert.strictEqual(d.action, 'send', 'got ' + d.action + '/' + d.reason);
  });
  await test('budget exhausted suppresses a non-batchable nudge', async () => {
    const ctxSpent = { queryOne: async () => ({ spent: 5 }), run: async () => {} };
    const d = await decide(ctxSpent, mkEvent('RAPID_WEIGHT_LOSS', now), { settings: baseSettings, now, profile: { typical_active_hour: new Date().getHours() } });
    assert.strictEqual(d.action, 'suppress');
    assert.strictEqual(d.reason, 'budget_exceeded');
  });
  await test('conversational replies bypass budget → send', async () => {
    const ctxSpent = { queryOne: async () => ({ spent: 99 }), run: async () => {} };
    const ev = mkEvent('USER_REPLIED', now); ev.category = 'conversational';
    const d = await decide(ctxSpent, ev, { settings: baseSettings, now });
    assert.strictEqual(d.action, 'send');
  });

  console.log('experiments');
  const expCtx = {
    queryAll: async () => [{
      id: 'exp1', name: 't', target_type: 'all', metric: 'reply_rate',
      variants: JSON.stringify([{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }]), status: 'active'
    }]
  };
  await test('assignment is deterministic per user', async () => {
    const a1 = await experiments.assign(expCtx, 'userX', 'NEW_PR');
    const a2 = await experiments.assign(expCtx, 'userX', 'NEW_PR');
    assert.ok(a1 && a2 && a1.variantKey === a2.variantKey, 'not deterministic');
    assert.ok(['A', 'B'].includes(a1.variantKey));
    assert.strictEqual(a1.abVariant, 'exp1:' + a1.variantKey);
  });
  await test('both variants are reachable across users', async () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      const a = await experiments.assign(expCtx, 'u' + i, 'NEW_PR');
      seen.add(a.variantKey);
    }
    assert.ok(seen.has('A') && seen.has('B'), 'expected both variants, got ' + [...seen]);
  });
  await test('no experiments → null (no behaviour change)', async () => {
    const none = await experiments.assign({ queryAll: async () => [] }, 'u', 'NEW_PR');
    assert.strictEqual(none, null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

function mkEvent(type, now) {
  return { id: 't', user_id: 'u', type, category: (taxonomy.metaFor(type) || {}).category, created_at: new Date(now).toISOString(), payload: {} };
}
