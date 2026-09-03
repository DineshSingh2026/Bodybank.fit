'use strict';

/**
 * BodyBank security-test safety interlock.
 *
 * Every security test file MUST call assertIsolatedTestEnv() before doing
 * anything else. It refuses to run unless the process is pointed at the
 * dedicated local test database and the test API origin, and it refuses
 * outright if any credential that can reach a real user (SMTP, Twilio,
 * Firebase, Anthropic, VAPID) is present in the environment.
 *
 * This is the code-level expression of the audit's zero-impact rule:
 * a test can only ever touch the throwaway database.
 */

// The only database name these tests are permitted to touch.
const REQUIRED_DB_NAME = 'bodybank_sectest';

// The only hosts the test database is permitted to live on.
const ALLOWED_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

// Any of these being set means the process can emit real messages / spend real
// money / reach a real user. A security test must never run in that process.
const FORBIDDEN_SIDE_EFFECT_VARS = [
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
  'TWILIO_SID', 'TWILIO_AUTH', 'ADMIN_WHATSAPP', 'ADMIN_WHATSAPP_LIST',
  'FIREBASE_SERVICE_ACCOUNT',
  'ANTHROPIC_API_KEY', 'SONET_API_KEY', 'SONNET_API_KEY', 'XAI_API_KEY',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'
];

// Hostnames that indicate production. Seeing any of these anywhere in the
// database URL or the API base is an immediate hard stop.
const PRODUCTION_MARKERS = [
  'bodybank.fit',
  'render.com',
  'railway.app',
  'onrender.com',
  'amazonaws.com',
  'supabase',
  'neon.tech'
];

function fail(reason) {
  const banner =
    '\n' +
    '================================================================\n' +
    '  SECURITY TEST ABORTED — ENVIRONMENT IS NOT PROVABLY ISOLATED\n' +
    '================================================================\n' +
    `  ${reason}\n` +
    '  No test was executed. No data was touched.\n' +
    '================================================================\n';
  process.stderr.write(banner);
  process.exit(2);
}

function parseDbUrl(raw) {
  try {
    // pg accepts postgres:// and postgresql://; URL handles both.
    return new URL(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Hard-stops the process unless the environment is the isolated test target.
 * Returns a descriptive checkpoint object for the test to print/record.
 */
function assertIsolatedTestEnv() {
  const dbUrl = String(process.env.DATABASE_URL || '').trim();
  if (!dbUrl) fail('DATABASE_URL is not set. Refusing to fall back to any default database.');

  const lowered = dbUrl.toLowerCase();
  for (const marker of PRODUCTION_MARKERS) {
    if (lowered.includes(marker)) {
      fail(`DATABASE_URL contains the production marker "${marker}".`);
    }
  }

  const parsed = parseDbUrl(dbUrl);
  if (!parsed) fail('DATABASE_URL could not be parsed, so its target cannot be verified.');

  const host = (parsed.hostname || '').toLowerCase();
  if (!ALLOWED_DB_HOSTS.has(host)) {
    fail(`DATABASE_URL host "${host}" is not a local host. Only localhost is permitted.`);
  }

  const dbName = decodeURIComponent((parsed.pathname || '').replace(/^\//, ''));
  if (dbName !== REQUIRED_DB_NAME) {
    fail(`DATABASE_URL database is "${dbName}", not the dedicated test database "${REQUIRED_DB_NAME}".`);
  }

  const present = FORBIDDEN_SIDE_EFFECT_VARS.filter(
    (k) => String(process.env[k] || '').trim() !== ''
  );
  if (present.length) {
    fail(
      'These outbound credentials are set, so this process could reach a real ' +
      `user or spend real money: ${present.join(', ')}. Unset them and retry.`
    );
  }

  const apiBase = String(process.env.SECTEST_API_BASE || '').trim();
  if (apiBase) {
    const apiLower = apiBase.toLowerCase();
    for (const marker of PRODUCTION_MARKERS) {
      if (apiLower.includes(marker)) {
        fail(`SECTEST_API_BASE contains the production marker "${marker}".`);
      }
    }
    const apiParsed = parseDbUrl(apiBase);
    if (!apiParsed || !ALLOWED_DB_HOSTS.has((apiParsed.hostname || '').toLowerCase())) {
      fail(`SECTEST_API_BASE "${apiBase}" is not a local host.`);
    }
  }

  return {
    dbHost: host,
    dbPort: parsed.port || '5432',
    dbName,
    apiBase: apiBase || '(not set)',
    nodeEnv: process.env.NODE_ENV || '(unset)',
    sideEffectCredentials: 'none present',
    verifiedAt: new Date().toISOString()
  };
}

/** Prefix stamped on every synthetic record so test data is unmistakable. */
const TEST_MARKER = 'SECTEST';

/** Builds a traceable identifier for one run of the suite. */
function newTestSessionId() {
  return `${TEST_MARKER}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  assertIsolatedTestEnv,
  newTestSessionId,
  TEST_MARKER,
  REQUIRED_DB_NAME,
  FORBIDDEN_SIDE_EFFECT_VARS,
  PRODUCTION_MARKERS
};
