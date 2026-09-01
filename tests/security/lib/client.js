'use strict';

/** Minimal HTTP client + synthetic-user factory for the security suite. */

const { TEST_MARKER } = require('./env-guard');

const BASE = process.env.SECTEST_API_BASE || 'http://127.0.0.1:3099';

async function req(method, path, { token, body, raw, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* non-JSON response */
  }
  return { status: res.status, json, text, raw: raw ? res : undefined, headers: res.headers };
}

const get = (p, o) => req('GET', p, o);
const post = (p, b, o) => req('POST', p, { ...o, body: b });
const put = (p, b, o) => req('PUT', p, { ...o, body: b });
const del = (p, o) => req('DELETE', p, o);

/**
 * Registers and logs in a synthetic user. Every field is obviously fake and the
 * email lives on the reserved .invalid TLD, which can never resolve or receive mail.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signup and login are rate limited (5/min and 20/min per IP), which is correct
 * behaviour that the suites themselves trip when several run in sequence. Rather
 * than weakening the limiter for tests, back off and retry: a 429 here is the app
 * working, not a failure.
 */
async function withRetryOn429(label, fn, { attempts = 8, baseDelayMs = 12000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.status !== 429) return last;
    const wait = baseDelayMs + i * 3000;
    process.stdout.write(`  (rate limited on ${label}, waiting ${Math.round(wait / 1000)}s)\r`);
    await sleep(wait);
  }
  return last;
}

async function createUser(label) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const email = `${TEST_MARKER.toLowerCase()}-${label}-${stamp}@sectest.invalid`;
  const password = `SecTest!${label}#2026`;

  const signup = await withRetryOn429('signup', () =>
    post('/api/auth/signup', {
      email,
      password,
      first_name: TEST_MARKER,
      last_name: label.toUpperCase(),
      phone: '+10000000000',
      country: 'India',
      height_cm: 175,
      dob: '1990-01-01',
      gender: 'other'
    })
  );
  if (signup.status !== 200) {
    throw new Error(`signup failed for ${label}: ${signup.status} ${signup.text.slice(0, 200)}`);
  }

  const login = await withRetryOn429('login', () => post('/api/auth/login', { email, password }));
  if (login.status !== 200 || !login.json?.token) {
    throw new Error(`login failed for ${label}: ${login.status} ${login.text.slice(0, 200)}`);
  }

  return { label, email, password, id: login.json.id, token: login.json.token, role: login.json.role };
}

/**
 * Creates a synthetic member without touching /api/auth/signup.
 *
 * Signup is rate limited to 5/min per IP and login to 20/min — correct controls that
 * the suites trip simply by creating their fixtures. Going through them anyway means
 * a full run spends minutes sleeping, which is how a security suite ends up never
 * being run. So authorization suites seed the row directly and mint a token with the
 * test server's own key; the token is indistinguishable from a real one, so every
 * request under test still exercises the production auth path.
 *
 * The signup and login endpoints themselves are covered by test-auth.js, which does
 * drive them for real.
 */
async function createUserFast(label) {
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const { randomUUID } = require('crypto');

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const email = `${TEST_MARKER.toLowerCase()}-${label}-${stamp}@sectest.invalid`;
  const password = `SecTest!${label}#2026`;
  const id = randomUUID();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    await pool.query(
      `INSERT INTO users (id, email, password, first_name, last_name, role,
                          approval_status, height_cm, country, timezone, subscription_status)
       VALUES ($1,$2,$3,$4,$5,'user','approved',175,'India','Asia/Kolkata','active')`,
      [id, email, bcrypt.hashSync(password, 10), TEST_MARKER, label.toUpperCase()]
    );
  } finally {
    await pool.end().catch(() => {});
  }

  const secret = process.env.JWT_SECRET || 'sectest-jwt-secret-not-used-anywhere-real';
  const token = jwt.sign({ id, email, role: 'user' }, secret, { expiresIn: '1h' });
  return { label, email, password, id, token, role: 'user' };
}

async function loginAs(email, password) {
  const r = await post('/api/auth/login', { email, password });
  if (r.status !== 200 || !r.json?.token) {
    throw new Error(`login failed for ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return { email, id: r.json.id, token: r.json.token, role: r.json.role };
}

module.exports = { BASE, req, get, post, put, del, createUser, createUserFast, loginAs };
