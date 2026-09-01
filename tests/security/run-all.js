'use strict';

/**
 * Runs the whole security suite in sequence against the isolated test server.
 *
 * Prerequisites (see tests/security/README.md):
 *   1. node tests/security/bootstrap-test-db.js
 *   2. node tests/security/run-test-server.js      (in another terminal)
 *   3. node tests/security/run-all.js
 *
 * Exits non-zero if any suite fails.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['static endpoint auth scan', 'scan-endpoint-auth.js', ['--check']],
  ['authentication', 'test-auth.js', []],
  ['user isolation / IDOR', 'test-user-isolation.js', []],
  ['file upload', 'test-file-upload.js', []],
  ['medical & nutrition isolation', 'test-medical-isolation.js', []],
  ['email transport', 'test-email-transport.js', []]
];

const results = [];
for (const [name, file, args] of SUITES) {
  console.log(`\n${'='.repeat(72)}\n  ${name.toUpperCase()}\n${'='.repeat(72)}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], {
    stdio: 'inherit',
    env: process.env
  });
  results.push({ name, code: r.status });
}

console.log(`\n${'='.repeat(72)}\n  SECURITY SUITE SUMMARY\n${'='.repeat(72)}`);
results.forEach((r) =>
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`)
);
const failed = results.filter((r) => r.code !== 0);
console.log(`\n  ${results.length - failed.length}/${results.length} suites passed\n`);
process.exit(failed.length ? 1 : 0);
