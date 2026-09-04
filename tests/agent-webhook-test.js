/**
 * Unit test for utils/agentWebhook.js
 *
 * Run: node tests/agent-webhook-test.js
 */
'use strict';

const { notifyAgent } = require('../utils/agentWebhook');

function failuresToExitCode(failures, checks) {
  if (failures.length === 0) {
    console.log(`\n--- All ${checks} agent-webhook tests passed ---`);
    process.exit(0);
  }
  console.log(`\n--- ${failures.length} of ${checks} agent-webhook tests FAILED ---`);
  failures.forEach((f) => console.log(' ', f));
  process.exit(1);
}

let failures = [];
let checks = 0;
function check(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function isIso8601(s) {
  if (typeof s !== 'string') return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

async function main() {
  const oldUrl = process.env.AGENT_WEBHOOK_URL;
  const oldToken = process.env.AGENT_WEBHOOK_TOKEN;
  const oldFetch = globalThis.fetch;

  try {
    /* ------------------------------------------------------------ */
    // 1) Complete no-op when AGENT_WEBHOOK_URL is unset
    delete process.env.AGENT_WEBHOOK_URL;
    delete process.env.AGENT_WEBHOOK_TOKEN;
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called');
    };

    let threw = false;
    try {
      notifyAgent('TRIAL_STARTED', { name: 'Alice', email: 'a@example.com' });
    } catch (e) {
      threw = true;
    }
    await tick();
    check(!threw, 'notifyAgent() should not throw when webhook URL is unset');
    check(fetchCalls === 0, 'notifyAgent() should not call fetch when webhook URL is unset');

    /* ------------------------------------------------------------ */
    // 2) Payload shape + Authorization header when configured
    process.env.AGENT_WEBHOOK_URL = 'https://example.test/webhook';
    process.env.AGENT_WEBHOOK_TOKEN = 'secret-token';
    let captured = null;

    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return { text: async () => 'ok' };
    };

    const sundayData = { user_id: 'u1', plan: 'P0', body_fat_percent: '—' };
    notifyAgent('SUNDAY_CHECKIN', sundayData);
    await tick();

    check(captured !== null, 'fetch should have been called when webhook URL is set');
    check(captured.url === 'https://example.test/webhook', 'fetch should be called with the configured URL');
    check(captured.opts.method === 'POST', 'webhook method must be POST');
    check(
      captured.opts.headers && captured.opts.headers.Authorization === 'Bearer secret-token',
      'webhook must include Authorization: Bearer <token>'
    );

    const parsed = (() => {
      try { return JSON.parse(captured.opts.body); } catch (_) { return null; }
    })();
    check(parsed && parsed.event === 'SUNDAY_CHECKIN', 'payload.event must equal the provided event name');
    check(isIso8601(parsed.occurred_at), 'payload.occurred_at must be an ISO 8601 timestamp string');
    deepEq(parsed.data, sundayData, 'payload.data must equal the input data (no transformation)');

    /* ------------------------------------------------------------ */
    // 3) Must never throw if POST fails (sync throw + rejected promise)
    let unhandled = false;
    const handler = () => { unhandled = true; };
    process.on('unhandledRejection', handler);

    globalThis.fetch = () => {
      throw new Error('sync boom');
    };

    threw = false;
    try {
      notifyAgent('TRIAL_STARTED', { x: 1 });
    } catch (e) {
      threw = true;
    }
    await tick();
    check(!threw, 'notifyAgent() should not throw if fetch throws synchronously');

    globalThis.fetch = () => Promise.reject(new Error('async boom'));
    threw = false;
    try {
      notifyAgent('TRIAL_STARTED', { x: 1 });
    } catch (e) {
      threw = true;
    }
    await tick();
    check(!threw, 'notifyAgent() should not throw if fetch promise rejects');
    await tick();

    process.removeListener('unhandledRejection', handler);
    check(unhandled === false, 'notifyAgent() should swallow POST failures (no unhandledRejection)');
  } finally {
    process.env.AGENT_WEBHOOK_URL = oldUrl;
    process.env.AGENT_WEBHOOK_TOKEN = oldToken;
    globalThis.fetch = oldFetch;
  }
}

main()
  .then(() => failuresToExitCode(failures, checks))
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });

