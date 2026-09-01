'use strict';

/**
 * Creates (or recreates) the isolated security-test database.
 *
 * Reads the *admin* connection from SECTEST_ADMIN_DATABASE_URL — a URL pointing
 * at any database on the local server, used only to issue CREATE DATABASE. The
 * test database itself is always named bodybank_sectest on localhost.
 *
 * Refuses to run against anything non-local. Refuses to drop any database whose
 * name is not exactly bodybank_sectest.
 *
 *   node tests/security/bootstrap-test-db.js          # create if missing
 *   node tests/security/bootstrap-test-db.js --reset  # drop and recreate
 */

const { Client } = require('pg');
const { REQUIRED_DB_NAME, PRODUCTION_MARKERS } = require('./lib/env-guard');

const RESET = process.argv.includes('--reset');

function die(msg) {
  console.error('\n[bootstrap] ABORTED: ' + msg + '\n');
  process.exit(2);
}

async function main() {
  const adminUrl = String(process.env.SECTEST_ADMIN_DATABASE_URL || '').trim();
  if (!adminUrl) {
    die(
      'SECTEST_ADMIN_DATABASE_URL is not set.\n' +
      '  Set it to a local admin connection, e.g.\n' +
      '  postgres://<user>:<password>@localhost:5432/postgres'
    );
  }

  const lowered = adminUrl.toLowerCase();
  for (const marker of PRODUCTION_MARKERS) {
    if (lowered.includes(marker)) die(`admin URL contains production marker "${marker}".`);
  }

  let parsed;
  try {
    parsed = new URL(adminUrl);
  } catch (_) {
    die('SECTEST_ADMIN_DATABASE_URL could not be parsed.');
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    die(`admin URL host "${host}" is not local.`);
  }

  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 8000 });
  await client.connect();

  const who = await client.query(
    'select current_database() db, current_user usr, inet_server_port() port'
  );
  console.log(
    `[bootstrap] connected: db=${who.rows[0].db} user=${who.rows[0].usr} ` +
    `host=${host} port=${who.rows[0].port}`
  );

  const exists = await client.query('select 1 from pg_database where datname = $1', [
    REQUIRED_DB_NAME
  ]);

  if (exists.rowCount && RESET) {
    // Guarded twice: the name is a constant, and we re-assert it here so no
    // future edit can widen this into dropping something else.
    if (REQUIRED_DB_NAME !== 'bodybank_sectest') die('refusing to drop a non-test database.');
    console.log(`[bootstrap] --reset: terminating connections to ${REQUIRED_DB_NAME}`);
    await client.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [REQUIRED_DB_NAME]
    );
    await client.query(`DROP DATABASE "${REQUIRED_DB_NAME}"`);
    console.log(`[bootstrap] dropped ${REQUIRED_DB_NAME}`);
  } else if (exists.rowCount) {
    console.log(`[bootstrap] ${REQUIRED_DB_NAME} already exists (use --reset to recreate)`);
    await client.end();
    return;
  }

  await client.query(`CREATE DATABASE "${REQUIRED_DB_NAME}"`);
  console.log(`[bootstrap] created ${REQUIRED_DB_NAME}`);
  await client.end();

  console.log(
    '\n[bootstrap] done. Start the test server with:\n' +
    '  node tests/security/run-test-server.js\n'
  );
}

main().catch((e) => {
  console.error('[bootstrap] failed:', e.message);
  process.exit(1);
});
