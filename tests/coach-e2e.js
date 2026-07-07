'use strict';

/**
 * End-to-end pipeline test for the AI Coach against a real Postgres DB.
 * Exercises: schema creation, event ingest + dedup, the Decision Engine verdicts
 * (send / batch / suppress / budget), delivery into the Lifestyle Manager thread,
 * two-way chat, and nightly memory (profile + dossier). Works WITHOUT an API key —
 * the LLM layer degrades to safe templates, so message rows still get created.
 *
 * Run (with a reachable DATABASE_URL):  node tests/coach-e2e.js
 */

require('dotenv').config();
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const coach = require('../services/coach');

const run = (sql, params) => db.query(sql, params);
const queryAll = db.queryAll;
const queryOne = db.queryOne;

const TEST_ID = 'coachtest-' + Date.now();
const TEST_EMAIL = `${TEST_ID}@e2e.bodybank.local`;
let _expId = null;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e.message)); }
}

async function ingest(type, payload) {
  const r = await coach.eventEngine.ingest(coach.getCtx(), TEST_ID, type, payload || {});
  return r;
}
async function eventStatus(id) {
  const row = await queryOne('SELECT status, suppress_reason FROM coach_events WHERE id = ?', [id]);
  return row || {};
}

async function main() {
  // No-op push so the test never tries to hit VAPID/FCM.
  await coach.initCoach({ queryAll, queryOne, run, uuidv4, sendPushToUser: async () => {} });

  // Seed a test user + a bit of activity so facts/health have something to read.
  await run(
    `INSERT INTO users (id, email, password, first_name, role, approval_status, subscription_status, suspended)
     VALUES (?, ?, ?, ?, 'user', 'approved', 'active', FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_ID, TEST_EMAIL, 'x', 'Testy']
  );
  const today = new Date().toISOString().slice(0, 10);
  await run(
    `INSERT INTO daily_checkins (id, user_id, checkin_date, steps, water_ml, protein_g, sleep_hours)
     VALUES (?, ?, ?::date, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [uuidv4(), TEST_ID, today, 8000, 1500, 95, 6]
  ).catch(() => {}); // non-fatal

  // Disable quiet hours (equal start/end => never quiet) and give ample budget.
  await coach.api.updateSettings(TEST_ID, {
    coach_enabled: true, daily_budget: 10, min_send_threshold: 35,
    quiet_start: '00:00', quiet_end: '00:00', personality: 'friendly'
  });

  console.log('event engine');
  await test('ingest creates a pending event', async () => {
    const r = await ingest('GOAL_ACHIEVED', { note: 'hit target weight' });
    assert.ok(r.ok && r.id, JSON.stringify(r));
    const s = await eventStatus(r.id);
    assert.strictEqual(s.status, 'pending');
  });
  await test('dedup drops a duplicate inside the TTL', async () => {
    await ingest('WORKOUT_COMPLETED', { ymd: today });
    const dup = await ingest('WORKOUT_COMPLETED', { ymd: today });
    assert.ok(!dup.ok && dup.reason === 'deduped', JSON.stringify(dup));
  });

  console.log('decision + delivery');
  // Clear anything already queued (GOAL_ACHIEVED from the ingest test, etc.) so the
  // next assertions run against a clean queue — one event per drain (coalescing means
  // the first send suppresses the rest of a batch, which is the intended anti-spam).
  await coach.drainOnce(50);

  await test('high-value event is SENT and delivered into the thread', async () => {
    const ev = await ingest('NEW_PR', { lift: 'bench', ymd: today, kg: 80 });
    await coach.drainOnce(50);
    const s = await eventStatus(ev.id);
    assert.strictEqual(s.status, 'sent', 'status=' + s.status + ' reason=' + s.suppress_reason);
    const msg = await queryOne('SELECT body, channel FROM coach_messages WHERE event_id = ?', [ev.id]);
    assert.ok(msg && msg.body && msg.body.length > 0, 'no coach_messages row');
    const tm = await queryOne(
      `SELECT tm.sender_role, tm.body FROM thread_messages tm
       JOIN message_threads mt ON mt.id = tm.thread_id
       WHERE mt.user_id = ? AND tm.sender_role = 'admin' ORDER BY tm.created_at DESC LIMIT 1`,
      [TEST_ID]
    );
    assert.ok(tm && tm.body, 'message not delivered to Lifestyle Manager thread');
  });

  await test('budget exhausted → a fresh non-batchable nudge is suppressed (budget_exceeded)', async () => {
    await coach.drainOnce(50); // ensure queue is empty
    const spentRow = await queryOne('SELECT spent FROM coach_budget_ledger WHERE user_id = ? ORDER BY ymd DESC LIMIT 1', [TEST_ID]);
    const spent = spentRow ? Number(spentRow.spent) : 0;
    assert.ok(spent >= 1, 'expected at least one spend by now, got ' + spent);
    await coach.api.updateSettings(TEST_ID, { daily_budget: spent }); // remaining = 0
    const ev = await ingest('RAPID_WEIGHT_LOSS', { ymd: today, kg: 1 }); // non-batchable, non-deferrable
    await coach.drainOnce(50);
    const s = await eventStatus(ev.id);
    assert.strictEqual(s.status, 'suppressed', 'status=' + s.status);
    assert.strictEqual(s.suppress_reason, 'budget_exceeded');
  });

  await test('low-value reinforce event batches instead of sending', async () => {
    await coach.api.updateSettings(TEST_ID, { daily_budget: 10 }); // budget not the gate here
    const ev = await ingest('MEAL_LOGGED', { ymd: today + '-x' });
    await coach.drainOnce(50);
    const s = await eventStatus(ev.id);
    assert.strictEqual(s.status, 'batched', 'status=' + s.status + ' reason=' + s.suppress_reason);
  });

  console.log('memory');
  await test('recomputeProfile writes a profile row', async () => {
    await coach.memory.recomputeProfile(coach.getCtx(), TEST_ID);
    const p = await queryOne('SELECT * FROM coach_user_profile WHERE user_id = ?', [TEST_ID]);
    assert.ok(p, 'no profile row');
    assert.ok(p.health_score == null || (p.health_score >= 0 && p.health_score <= 100));
  });
  await test('dossier regenerate writes a summary (LLM or deterministic fallback)', async () => {
    const d = await coach.dossierService.regenerate(coach.getCtx(), TEST_ID);
    assert.ok(d.summary && d.summary.length > 10, 'empty dossier');
    const row = await queryOne('SELECT summary, version FROM coach_dossier WHERE user_id = ?', [TEST_ID]);
    assert.ok(row && row.summary.length > 10);
  });

  console.log('two-way chat');
  await test('handleUserReply stores the user msg + returns a coach reply', async () => {
    const out = await coach.handleUserReply(TEST_ID, 'How am I doing on protein this week?');
    assert.ok(out.ok && out.reply && out.reply.length > 0, JSON.stringify(out));
    const userMsg = await queryOne(
      `SELECT tm.body FROM thread_messages tm JOIN message_threads mt ON mt.id = tm.thread_id
       WHERE mt.user_id = ? AND tm.sender_role = 'user' ORDER BY tm.created_at DESC LIMIT 1`,
      [TEST_ID]
    );
    assert.ok(userMsg && /protein/i.test(userMsg.body), 'user message not persisted');
  });

  console.log('instant feedback');
  await test('instant workout feedback: specific message, delivered, budget-exempt', async () => {
    await run(
      `INSERT INTO workout_logs (id, user_id, workout_name, workout_type, session_lifts, intensity, created_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?, NOW())`,
      [uuidv4(), TEST_ID, 'Chest Day', 'push',
       JSON.stringify([{ exercise: 'Bench Press', sets: 2, reps: 15, weight_kg: 10 }]), 'moderate']
    ).catch(() => {});
    const before = await queryOne('SELECT spent FROM coach_budget_ledger WHERE user_id = ? ORDER BY ymd DESC LIMIT 1', [TEST_ID]);
    const out = await coach.instantWorkoutFeedback(TEST_ID);
    assert.ok(out.ok && out.reply && out.reply.length > 0, JSON.stringify(out));
    const msg = await queryOne(
      `SELECT body FROM coach_messages WHERE user_id = ? AND type = 'WORKOUT_COMPLETED' ORDER BY sent_at DESC LIMIT 1`,
      [TEST_ID]
    );
    assert.ok(msg && msg.body, 'no workout feedback message recorded');
    const after = await queryOne('SELECT spent FROM coach_budget_ledger WHERE user_id = ? ORDER BY ymd DESC LIMIT 1', [TEST_ID]);
    assert.strictEqual(after ? Number(after.spent) : 0, before ? Number(before.spent) : 0, 'instant feedback must not spend budget');
  });
  await test('instant meal feedback: specific message from macros', async () => {
    const out = await coach.instantMealFeedback(TEST_ID, { mealType: 'lunch', aiResult: { dish: 'Chicken & rice', calories: 620, protein: 48, carbs: 70, fat: 14 } });
    assert.ok(out.ok && out.reply && out.reply.length > 0, JSON.stringify(out));
  });

  console.log('admin surface');
  await test('adminMetrics + adminInspect return data', async () => {
    const m = await coach.api.adminMetrics();
    assert.ok(m && typeof m.sends_7d === 'number');
    const insp = await coach.api.adminInspect(TEST_ID);
    assert.ok(insp.settings && Array.isArray(insp.events));
    assert.ok(insp.events.length >= 1, 'expected decision-inspector events');
  });

  console.log('A/B experiments');
  await test('active experiment stamps ab_variant on a sent message', async () => {
    await coach.drainOnce(50); // clear queue
    const exp = await coach.api.createExperiment({
      name: 'e2e-tone', targetType: 'all', metric: 'reply_rate',
      variants: [{ key: 'A', weight: 1, append: 'Open with the exact number.' }, { key: 'B', weight: 1, personality: 'minimal' }]
    });
    _expId = exp.id;
    await coach.api.updateSettings(TEST_ID, { daily_budget: 10 });
    const ev = await ingest('STREAK_MILESTONE', { days: 21, ymd: today + '-ab' });
    await coach.drainOnce(50);
    const s = await eventStatus(ev.id);
    assert.strictEqual(s.status, 'sent', 'status=' + s.status + ' reason=' + s.suppress_reason);
    const msg = await queryOne('SELECT ab_variant FROM coach_messages WHERE event_id = ?', [ev.id]);
    assert.ok(msg && msg.ab_variant && msg.ab_variant.startsWith(exp.id + ':'), 'ab_variant not stamped: ' + (msg && msg.ab_variant));
    const ro = await coach.api.listExperiments();
    assert.ok(Array.isArray(ro.readout), 'no readout');
  });
}

async function cleanup() {
  const tables = [
    'coach_events', 'coach_messages', 'coach_budget_ledger', 'coach_settings',
    'coach_dossier', 'coach_user_profile'
  ];
  for (const t of tables) await run(`DELETE FROM ${t} WHERE user_id = ?`, [TEST_ID]).catch(() => {});
  if (_expId) await run(`DELETE FROM coach_experiments WHERE id = ?`, [_expId]).catch(() => {});
  await run(`DELETE FROM thread_messages WHERE thread_id IN (SELECT id FROM message_threads WHERE user_id = ?)`, [TEST_ID]).catch(() => {});
  await run(`DELETE FROM message_threads WHERE user_id = ?`, [TEST_ID]).catch(() => {});
  await run(`DELETE FROM user_inbox WHERE user_id = ?`, [TEST_ID]).catch(() => {});
  await run(`DELETE FROM daily_checkins WHERE user_id = ?`, [TEST_ID]).catch(() => {});
  await run(`DELETE FROM workout_logs WHERE user_id = ?`, [TEST_ID]).catch(() => {});
  await run(`DELETE FROM users WHERE id = ?`, [TEST_ID]).catch(() => {});
}

(async () => {
  try {
    await main();
  } catch (e) {
    failed++;
    console.log('  ✗ FATAL: ' + (e.stack || e.message));
  } finally {
    await cleanup();
    try { await db.pool.end(); } catch (_) {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
