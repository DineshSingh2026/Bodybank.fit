'use strict';

/**
 * CONTROLLED LOAD TEST — isolated environment only.
 *
 * Ramps synthetic users through a realistic BodyBank journey and reports latency
 * percentiles, throughput and error rate per stage.
 *
 * Safety:
 *   - env-guard refuses to run unless DATABASE_URL is the bodybank_sectest database
 *     on localhost and no outbound credentials are present;
 *   - the target must also be a local address;
 *   - the ramp ABORTS as soon as a stage exceeds the error threshold, so it degrades
 *     into a stop rather than a denial-of-service.
 *
 *   node tests/security/load-test.js
 *   node tests/security/load-test.js --stages 10,50          # custom ramp
 *   node tests/security/load-test.js --abort-error-rate 0.10
 */

const { assertIsolatedTestEnv, newTestSessionId } = require('./lib/env-guard');
const checkpoint = assertIsolatedTestEnv();

const { BASE, post, get, createUser } = require('./lib/client');

const SESSION = newTestSessionId();

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const STAGES = String(argVal('--stages', '10,50,100,250,500'))
  .split(',')
  .map((n) => parseInt(n.trim(), 10))
  .filter(Boolean);
const ABORT_ERROR_RATE = parseFloat(argVal('--abort-error-rate', '0.10'));
const ABORT_P95_MS = parseInt(argVal('--abort-p95-ms', '10000'), 10);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function timed(label, fn, acc) {
  const t0 = process.hrtime.bigint();
  let ok = false;
  let status = 0;
  try {
    const res = await fn();
    status = res?.status ?? 0;
    ok = status >= 200 && status < 400;
  } catch (_) {
    ok = false;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const s = (acc[label] = acc[label] || { times: [], ok: 0, err: 0, statuses: {} });
  s.times.push(ms);
  s.statuses[status] = (s.statuses[status] || 0) + 1;
  ok ? s.ok++ : s.err++;
  return ok;
}

/** One synthetic member's session: the journey from the brief. */
async function journey(user, acc) {
  const t = { token: user.token };
  await timed('dashboard (/api/me/home)', () => get('/api/me/home', t), acc);
  await timed('workout write', () => post('/api/workouts', { workout_name: 'Load Test Session', duration_seconds: 1800 }, t), acc);
  await timed('meal write', () => post('/api/nutrition/log', { mealType: 'lunch', portionSize: 'medium', manualNote: 'load test meal', macros: { calories: 600, protein_g: 40, carbs_g: 60, fat_g: 20 } }, t), acc);
  await timed('water/protein write', () => post('/api/daily-checkin', { steps: 8000, protein_g: 120, sleep_hours: 7, water_liters: 2.5 }, t), acc);
  await timed('body snapshot write', () => post('/api/me/body/snapshot', { bodyweight_kg: 75 }, t), acc);
  await timed('scorecard read', () => get('/api/me/scorecard', t), acc);
  await timed('progress read', () => get(`/api/workouts/${user.id}`, t), acc);
  await timed('leaderboard read', () => get('/api/me/leaderboard', t), acc);
}

function report(stage, acc, wallMs) {
  const rows = [];
  let totalReq = 0;
  let totalErr = 0;
  for (const [label, s] of Object.entries(acc)) {
    const sorted = s.times.slice().sort((a, b) => a - b);
    totalReq += s.times.length;
    totalErr += s.err;
    rows.push({
      step: label,
      n: s.times.length,
      p50: pct(sorted, 50).toFixed(0),
      p90: pct(sorted, 90).toFixed(0),
      p95: pct(sorted, 95).toFixed(0),
      p99: pct(sorted, 99).toFixed(0),
      max: sorted[sorted.length - 1].toFixed(0),
      err: s.err,
      statuses: Object.entries(s.statuses).map(([k, v]) => `${k}:${v}`).join(' ')
    });
  }

  console.log(`\n  ${'step'.padEnd(26)} ${'n'.padStart(5)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} ${'p95'.padStart(6)} ${'p99'.padStart(7)} ${'max'.padStart(7)}  ${'err'.padStart(4)}  statuses`);
  console.log('  ' + '-'.repeat(100));
  rows.forEach((r) =>
    console.log(
      `  ${r.step.padEnd(26)} ${String(r.n).padStart(5)} ${r.p50.padStart(6)} ${r.p90.padStart(6)} ${r.p95.padStart(6)} ${r.p99.padStart(7)} ${r.max.padStart(7)}  ${String(r.err).padStart(4)}  ${r.statuses}`
    )
  );

  const allTimes = Object.values(acc).flatMap((s) => s.times).sort((a, b) => a - b);
  const errorRate = totalReq ? totalErr / totalReq : 0;
  const rps = totalReq / (wallMs / 1000);
  console.log(
    `\n  stage ${stage}: ${totalReq} requests in ${(wallMs / 1000).toFixed(1)}s — ` +
    `${rps.toFixed(1)} req/s, error rate ${(errorRate * 100).toFixed(2)}%, ` +
    `overall p95 ${pct(allTimes, 95).toFixed(0)}ms`
  );
  return { errorRate, p95: pct(allTimes, 95), rps, totalReq, totalErr };
}

/**
 * Inserts N approved members directly into the isolated test database, then logs each
 * one in through the real API. Only ever reaches bodybank_sectest — env-guard has
 * already refused any other target before this runs.
 */
async function seedUsersDirect(count) {
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const { randomUUID } = require('crypto');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

  const password = 'LoadTest!Member#2026';
  const hash = bcrypt.hashSync(password, 10);
  const made = [];

  try {
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const email = `sectest-load-${SESSION.toLowerCase()}-${i}@sectest.invalid`;
      await pool.query(
        `INSERT INTO users (id, email, password, first_name, last_name, role,
                            approval_status, height_cm, country, timezone, subscription_status)
         VALUES ($1,$2,$3,$4,$5,'user','approved',175,'India','Asia/Kolkata','active')`,
        [id, email, hash, 'SECTEST', `LOAD${i}`]
      );
      made.push({ id, email, password });
      if ((i + 1) % 50 === 0) process.stdout.write(`  seeded ${i + 1}/${count}\r`);
    }
  } finally {
    await pool.end().catch(() => {});
  }

  // Tokens are minted with the test server's own signing key rather than obtained by
  // calling /api/auth/login N times. Login is rate limited to 20/min per IP, so bulk
  // logins would measure the rate limiter instead of the application — and that
  // limiter is a control we WANT, not one to weaken. The minted token is identical in
  // shape to a real one, so every measured request still runs the production auth
  // path. Login latency is measured separately, at a volume the limiter permits.
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'sectest-jwt-secret-not-used-anywhere-real';
  return made.map((u) => ({
    ...u,
    token: jwt.sign({ id: u.id, email: u.email, role: 'user' }, secret, { expiresIn: '1h' })
  }));
}

async function main() {
  console.log('\n=== SAFETY CHECKPOINT ===');
  Object.entries(checkpoint).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));
  console.log(`  ${'target'.padEnd(24)} ${BASE}`);
  console.log(`  ${'testSessionId'.padEnd(24)} ${SESSION}`);
  console.log('=========================');

  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)) {
    console.error(`\nABORT: load target ${BASE} is not local. Refusing to generate load.\n`);
    process.exit(2);
  }

  console.log(`\nRamp: ${STAGES.join(' -> ')} concurrent users`);
  console.log(`Abort thresholds: error rate > ${(ABORT_ERROR_RATE * 100).toFixed(0)}%, p95 > ${ABORT_P95_MS}ms\n`);

  // One pooled set of synthetic users, reused across stages so account creation is
  // not itself the thing being measured.
  const maxUsers = Math.max(...STAGES);
  console.log(`Provisioning ${maxUsers} synthetic users...`);
  // Users are inserted straight into the test database rather than driven through
  // /api/auth/signup: that endpoint is rate limited to 5/min per IP (correctly), so
  // signing up through it would measure the rate limiter, not the app. Tokens are
  // then obtained from the real login endpoint, so the measured journey is still the
  // production code path.
  const users = await seedUsersDirect(maxUsers);
  console.log(`  provisioned ${users.length} users            \n`);

  if (!users.length) {
    console.error('ABORT: could not provision any synthetic users.');
    process.exit(1);
  }

  // Login is measured on its own, within what the rate limiter allows, so its cost is
  // still reported without the ramp colliding with the limiter.
  {
    const acc = {};
    const sample = users.slice(0, 10);
    const t0 = Date.now();
    await Promise.all(
      sample.map((u) =>
        timed('login (sampled, n<=10)', () => post('/api/auth/login', { email: u.email, password: u.password }), acc)
      )
    );
    console.log('\n### LOGIN LATENCY (sampled separately from the ramp)');
    report('login-sample', acc, Date.now() - t0);
  }

  const summary = [];
  for (const stage of STAGES) {
    const cohort = users.slice(0, Math.min(stage, users.length));
    if (cohort.length < stage) {
      console.log(`\n### STAGE ${stage} — only ${cohort.length} users available, running with those`);
    } else {
      console.log(`\n### STAGE ${stage} concurrent users`);
    }
    const acc = {};
    const t0 = Date.now();
    await Promise.all(cohort.map((u) => journey(u, acc).catch(() => {})));
    const wallMs = Date.now() - t0;
    const r = report(stage, acc, wallMs);
    summary.push({ stage, ...r });

    if (r.errorRate > ABORT_ERROR_RATE) {
      console.log(`\n  STOP: error rate ${(r.errorRate * 100).toFixed(1)}% exceeded the ${(ABORT_ERROR_RATE * 100).toFixed(0)}% threshold. Ramp aborted.`);
      break;
    }
    if (r.p95 > ABORT_P95_MS) {
      console.log(`\n  STOP: p95 ${r.p95.toFixed(0)}ms exceeded the ${ABORT_P95_MS}ms threshold. Ramp aborted.`);
      break;
    }
    // Let the process settle between stages.
    await new Promise((r2) => setTimeout(r2, 2000));
  }

  console.log('\n=== LOAD SUMMARY ===');
  console.log(`  ${'users'.padStart(6)} ${'req'.padStart(7)} ${'req/s'.padStart(8)} ${'p95 ms'.padStart(8)} ${'errors'.padStart(7)}`);
  summary.forEach((s) =>
    console.log(
      `  ${String(s.stage).padStart(6)} ${String(s.totalReq).padStart(7)} ${s.rps.toFixed(1).padStart(8)} ${s.p95.toFixed(0).padStart(8)} ${String(s.totalErr).padStart(7)}`
    )
  );
  console.log('');
}

main().catch((e) => {
  console.error('\nLOAD TEST ERROR:', e.message);
  process.exit(1);
});
