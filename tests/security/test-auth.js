'use strict';

/**
 * AUTHENTICATION SUITE
 *
 * Covers login, signup, brute-force throttling, account enumeration, password
 * reset, token handling, and the specific credentials that were previously
 * hardcoded in the source.
 *
 *   node tests/security/test-auth.js
 */

const { assertIsolatedTestEnv, newTestSessionId } = require('./lib/env-guard');
const checkpoint = assertIsolatedTestEnv();

const { get, post, req, createUser } = require('./lib/client');
const A = require('./lib/assert');

const SESSION = newTestSessionId();

async function main() {
  console.log('\n=== SAFETY CHECKPOINT ===');
  Object.entries(checkpoint).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));
  console.log(`  ${'testSessionId'.padEnd(24)} ${SESSION}`);
  console.log('=========================\n');

  // ---- 1. removed hardcoded credentials -------------------------------------
  console.log('--- 1. previously hardcoded credentials must not work ---');
  const knownCreds = [
    ['superadmin@gmail.com', 'Bodybank@2026', 'source-embedded superadmin backdoor'],
    ['admin@bodybank.fit', 'admin123', 'default admin password'],
    ['superadmin@bodybank.fit', 'superadmin123', 'default superadmin password']
  ];
  for (const [email, password, label] of knownCreds) {
    const r = await post('/api/auth/login', { email, password });
    const gotToken = !!r.json?.token;
    gotToken
      ? A.fail(`${label} rejected`, `HTTP ${r.status} returned a token for ${email}`)
      : A.pass(`${label} rejected`, `HTTP ${r.status}`);
  }

  // ---- 2. login correctness ---------------------------------------------------
  console.log('\n--- 2. login ---');
  const user = await createUser('auth');
  A.expectStatus(
    'correct credentials succeed',
    await post('/api/auth/login', { email: user.email, password: user.password }),
    200
  );
  A.expectStatus(
    'wrong password fails',
    await post('/api/auth/login', { email: user.email, password: 'definitely-not-it' }),
    401
  );
  A.expectStatus(
    'empty password fails',
    await post('/api/auth/login', { email: user.email, password: '' }),
    400
  );

  // SQL injection attempts through the login form.
  console.log('\n--- 3. injection attempts on the login form ---');
  const injections = [
    "' OR '1'='1",
    "admin'--",
    "' OR 1=1--",
    "'; DROP TABLE users; --",
    "' UNION SELECT NULL,NULL,NULL--"
  ];
  for (const payload of injections) {
    const r = await post('/api/auth/login', { email: payload, password: payload });
    r.json?.token
      ? A.fail(`SQL injection rejected: ${payload}`, 'returned a token')
      : A.pass(`SQL injection rejected: ${payload}`, `HTTP ${r.status}`);
  }
  // The users table must still exist after the DROP TABLE attempt.
  A.expectStatus(
    'users table intact after injection attempts',
    await post('/api/auth/login', { email: user.email, password: user.password }),
    200
  );

  // ---- 4. account enumeration --------------------------------------------------
  console.log('\n--- 4. account enumeration ---');
  const known = await post('/api/auth/login', {
    email: user.email,
    password: 'wrong-password-here'
  });
  const unknown = await post('/api/auth/login', {
    email: `no-such-user-${Date.now()}@sectest.invalid`,
    password: 'wrong-password-here'
  });
  const sameStatus = known.status === unknown.status;
  const sameBody = JSON.stringify(known.json) === JSON.stringify(unknown.json);
  sameStatus && sameBody
    ? A.pass('login does not reveal whether an account exists', `both HTTP ${known.status}`)
    : A.fail(
        'login does not reveal whether an account exists',
        `known=${known.status} ${known.text.slice(0, 60)} | unknown=${unknown.status} ${unknown.text.slice(0, 60)}`
      );

  const fp = await post('/api/auth/forgot-password', {
    email: `no-such-user-${Date.now()}@sectest.invalid`
  });
  [200, 202].includes(fp.status)
    ? A.pass('forgot-password does not reveal whether an account exists', `HTTP ${fp.status}`)
    : A.warn('forgot-password response for unknown address', `HTTP ${fp.status} ${fp.text.slice(0, 80)}`);

  // ---- 5. brute-force throttle ---------------------------------------------------
  console.log('\n--- 5. brute-force throttle ---');
  const victim = await createUser('brute');
  let sawThrottle = false;
  let attempts = 0;
  for (let i = 0; i < 25; i++) {
    const r = await post('/api/auth/login', { email: victim.email, password: `guess-${i}` });
    attempts++;
    if (r.status === 429) {
      sawThrottle = true;
      break;
    }
  }
  sawThrottle
    ? A.pass('repeated failed logins are throttled', `429 after ${attempts} attempts`)
    : A.fail('repeated failed logins are throttled', `25 attempts, never throttled`);

  // ---- 6. signup validation --------------------------------------------------------
  console.log('\n--- 6. signup validation ---');
  A.expectStatus(
    'short password rejected',
    await post('/api/auth/signup', {
      email: `short-${Date.now()}@sectest.invalid`,
      password: '123',
      height_cm: 175
    }),
    400
  );
  A.expectStatus(
    'duplicate email rejected',
    await post('/api/auth/signup', { email: user.email, password: 'AnotherPass123!', height_cm: 175 }),
    409
  );
  const roleInject = await post('/api/auth/signup', {
    email: `roleinject-${Date.now()}@sectest.invalid`,
    password: 'ValidPass123!',
    height_cm: 175,
    role: 'superadmin',
    approval_status: 'approved'
  });
  roleInject.json?.role === 'superadmin'
    ? A.fail('signup ignores a client-supplied role', 'account was created as superadmin')
    : A.pass('signup ignores a client-supplied role', `role=${roleInject.json?.role}`);

  // ---- 6b. password-reset link cannot be poisoned via the Host header ---------------
  console.log('\n--- 6b. password-reset host-header injection ---');
  {
    // A forged Host must not end up in the emailed reset link. In the test
    // environment the response echoes the link back (production never does), so the
    // origin it would have emailed is directly observable.
    const poisoned = await req('POST', '/api/auth/forgot-password', {
      body: { email: user.email },
      headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' }
    });
    const link = String(poisoned.json?.resetLink || '');
    /evil\.example/i.test(link)
      ? A.fail('reset link ignores a forged Host header', `link was ${link.slice(0, 90)}`)
      : A.pass('reset link ignores a forged Host header', link ? link.split('/reset-password')[0] : 'no link emitted');
  }

  // ---- 7. token handling ------------------------------------------------------------
  console.log('\n--- 7. token handling ---');
  A.expectDenied('no token rejected', await get('/api/me/home'));
  A.expectDenied('garbage token rejected', await get('/api/me/home', { token: 'not-a-jwt' }));
  A.expectDenied(
    'expired token rejected',
    await get('/api/me/home', {
      token: require('jsonwebtoken').sign(
        { id: user.id, email: user.email, role: 'user' },
        'sectest-jwt-secret-not-used-anywhere-real',
        { expiresIn: '-1h' }
      )
    })
  );
  A.expectStatus(
    'valid token accepted',
    await get('/api/me/home', { token: user.token }),
    200
  );

  A.summary('AUTHENTICATION RESULTS');
  process.exit(A.exitCode());
}

main().catch((e) => {
  console.error('\nSUITE ERROR:', e.message);
  process.exit(1);
});
