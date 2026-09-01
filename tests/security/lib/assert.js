'use strict';

/** Tiny result recorder so every security test reports uniformly. */

const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  const icon = { PASS: '  PASS', FAIL: '  FAIL', WARN: '  WARN', INFO: '  ..  ' }[status];
  console.log(`${icon}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const pass = (name, detail) => record('PASS', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);
const warn = (name, detail) => record('WARN', name, detail);
const info = (name, detail) => record('INFO', name, detail);

/** Asserts a cross-tenant request was refused. 401/403/404 all count as denied. */
function expectDenied(name, res, { allowEmpty = false } = {}) {
  const denied = [401, 403, 404].includes(res.status);
  if (denied) return pass(name, `HTTP ${res.status}`);
  if (allowEmpty && res.status === 200) {
    const body = res.json;
    const empty =
      body == null ||
      (Array.isArray(body) && body.length === 0) ||
      (Array.isArray(body?.data) && body.data.length === 0) ||
      (Array.isArray(body?.posts) && body.posts.length === 0);
    if (empty) return pass(name, 'HTTP 200 but empty result set');
  }
  return fail(name, `HTTP ${res.status} — ${String(res.text).slice(0, 160)}`);
}

function expectStatus(name, res, expected) {
  const list = Array.isArray(expected) ? expected : [expected];
  return list.includes(res.status)
    ? pass(name, `HTTP ${res.status}`)
    : fail(name, `expected ${list.join('/')}, got ${res.status} — ${String(res.text).slice(0, 160)}`);
}

/** Fails if a response body contains a value that belongs to another user. */
function expectNotLeaking(name, res, needles) {
  const hay = String(res.text || '');
  const hit = needles.filter((n) => n && hay.includes(n));
  return hit.length
    ? fail(name, `response contained foreign value(s): ${hit.join(', ').slice(0, 160)}`)
    : pass(name, 'no foreign data in response');
}

function summary(title) {
  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\n=== ${title} ===`);
  console.log(
    `  PASS ${counts.PASS || 0}   FAIL ${counts.FAIL || 0}   WARN ${counts.WARN || 0}`
  );
  if (failed.length) {
    console.log('\n  Failures:');
    failed.forEach((f) => console.log(`   - ${f.name}: ${f.detail || ''}`));
  }
  console.log('');
  return { counts, failed, results };
}

function exitCode() {
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

module.exports = { pass, fail, warn, info, expectDenied, expectStatus, expectNotLeaking, summary, exitCode, results };
