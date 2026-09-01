'use strict';

/**
 * Launches the BodyBank server against the isolated security-test environment.
 *
 * The real .env is loaded by server.js via dotenv, and dotenv never overwrites a
 * key that already exists on process.env. This launcher therefore pre-populates
 * process.env *before* requiring the server:
 *
 *   - every outbound credential is pre-set to '' so the real SMTP / Twilio /
 *     Firebase / Anthropic / VAPID values in .env can never be injected;
 *   - DATABASE_URL is pinned to the throwaway bodybank_sectest database;
 *   - the isolation guard runs before the server module is loaded at all.
 *
 * Net effect: the process physically cannot email anyone, message anyone, push
 * to anyone, spend AI credits, or touch the real database.
 *
 *   node tests/security/run-test-server.js
 */

const path = require('path');
const fs = require('fs');
const { FORBIDDEN_SIDE_EFFECT_VARS, assertIsolatedTestEnv } = require('./lib/env-guard');

// ---- 1. Neutralise every outbound credential BEFORE dotenv can inject it ----
for (const key of FORBIDDEN_SIDE_EFFECT_VARS) process.env[key] = '';
// Not in the guard list but still outbound / identity-bearing.
process.env.SMTP_FROM = '';
process.env.SMTP_PORT = '';
process.env.SMTP_SECURE = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.APPLE_SERVICE_ID = '';
process.env.APPLE_BUNDLE_ID = '';
process.env.TWILIO_WHATSAPP_FROM = '';
process.env.TWILIO_WHATSAPP_TEMPLATE_SID = '';
process.env.TWILIO_AUDIT_TEMPLATE_SID = '';
process.env.NUTRITION_ADMIN_REPORT_EMAIL = '';
process.env.APPLE_REVIEW_EMAIL = '';
process.env.APPLE_REVIEW_PASS = '';
process.env.CAMPAIGNS_ENABLED = 'false';

// ---- 2. Pin the environment to the isolated test target ----
const TEST_PORT = process.env.SECTEST_PORT || '3099';
process.env.PORT = TEST_PORT;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.SECTEST_DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/bodybank_sectest';
process.env.SECTEST_API_BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.RESET_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Deterministic, obviously-fake secrets. Never reused outside the test DB.
process.env.JWT_SECRET = 'sectest-jwt-secret-not-used-anywhere-real';
process.env.NUTRITION_PHOTO_LINK_SECRET = 'sectest-photo-link-secret';
process.env.CRON_SECRET = 'sectest-cron-secret';

// Test-only staff accounts.
process.env.ADMIN_EMAIL = 'security-test-admin-001@sectest.invalid';
process.env.ADMIN_PASS = 'SecTest!Admin#2026';
process.env.SUPERADMIN_EMAIL = 'security-test-superadmin-001@sectest.invalid';
process.env.SUPERADMIN_PASS = 'SecTest!Super#2026';
process.env.OPERATOR_EMAIL = 'security-test-operator-001@sectest.invalid';
process.env.OPERATOR_PASS = 'SecTest!Operator#2026';

// Uploads land in a dedicated directory so the real ./uploads is never written.
const TEST_UPLOADS = path.join(__dirname, '.sectest-uploads');
fs.mkdirSync(TEST_UPLOADS, { recursive: true });
process.env.UPLOADS_DIR = TEST_UPLOADS;

// ---- 3. Prove isolation, then and only then load the server ----
const checkpoint = assertIsolatedTestEnv();
console.log('\n=== SECURITY TEST SAFETY CHECKPOINT ===');
for (const [k, v] of Object.entries(checkpoint)) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}
console.log(`  ${'uploadsDir'.padEnd(24)} ${TEST_UPLOADS}`);
console.log('=======================================\n');

require(path.join(__dirname, '..', '..', 'server.js'));
