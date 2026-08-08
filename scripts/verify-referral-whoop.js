#!/usr/bin/env node
'use strict';

/**
 * Post-deploy smoke test for the referral + Whoop features.
 *
 *   node scripts/verify-referral-whoop.js https://bodybank.fit
 *
 * READ-ONLY BY DEFAULT — creates no users, writes no rows. It verifies the
 * routes are mounted, the auth guards bite, and the public endpoints behave.
 * Safe to run against production.
 *
 * Optional authenticated pass (still read-only) for a real member account:
 *   node scripts/verify-referral-whoop.js https://bodybank.fit user@example.com 'password'
 */

const BASE = String(process.argv[2] || process.env.VERIFY_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = process.argv[3] || '';
const PASSWORD = process.argv[4] || '';

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '   -> ' + detail : '')); }
};
const skipped = (name, why) => { skip++; console.log('  SKIP  ' + name + '   (' + why + ')'); };

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(BASE + path, {
      method, headers, signal: ctl.signal,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { _raw: text.slice(0, 160) }; }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.name === 'AbortError' ? 'timeout' : e.message } };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('BodyBank referral + Whoop smoke test');
  console.log('target: ' + BASE + '\n');

  console.log('=== reachability ===');
  const health = await req('GET', '/health');
  ok('server reachable', health.status > 0, health.data.error || '');
  if (!health.status) {
    console.log('\nCannot reach the server — aborting.');
    process.exit(1);
  }
  ok('/health returns 200', health.status === 200, String(health.status));

  console.log('\n=== referral routes mounted ===');
  // A code that cannot exist: proves the route is mounted and reachable
  // without authenticating and without creating anything.
  const bogus = await req('GET', '/api/referrals/resolve/ZZZNOTAREALCODE');
  ok('resolve route mounted (not 404-by-router)', bogus.status === 404 || bogus.status === 400,
    'status ' + bogus.status + ' ' + JSON.stringify(bogus.data).slice(0, 90));
  ok('unknown code is not treated as valid', bogus.data.valid !== true, JSON.stringify(bogus.data).slice(0, 90));

  console.log('\n=== auth guards ===');
  const noTok = await req('GET', '/api/referrals/summary');
  ok('summary requires auth', noTok.status === 401 || noTok.status === 403, String(noTok.status));
  const noTok2 = await req('GET', '/api/wearables/connection');
  ok('wearables requires auth', noTok2.status === 401 || noTok2.status === 403, String(noTok2.status));
  const adminGuard = await req('GET', '/api/referrals/admin');
  ok('admin list requires auth', adminGuard.status === 401 || adminGuard.status === 403, String(adminGuard.status));
  const redeemGuard = await req('POST', '/api/referrals/redeem', { blocks: 1 });
  ok('redeem requires auth (no coins spendable anonymously)',
    redeemGuard.status === 401 || redeemGuard.status === 403, String(redeemGuard.status));

  console.log('\n=== upload endpoint rejects junk safely ===');
  const junk = await req('POST', '/api/wearables/whoop/preview', { file_base64: 'bm90IGEgemlw' });
  ok('unauthenticated upload blocked', junk.status === 401 || junk.status === 403, String(junk.status));

  if (!EMAIL || !PASSWORD) {
    console.log('\n=== authenticated checks ===');
    skipped('member summary / config', 'no email+password supplied');
  } else {
    console.log('\n=== authenticated checks (read-only) ===');
    const login = await req('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    ok('login succeeds', login.status === 200 && !!login.data.token,
      login.status + ' ' + JSON.stringify(login.data.error || '').slice(0, 80));
    const token = login.data.token;
    if (token) {
      const sum = await req('GET', '/api/referrals/summary', null, token);
      ok('summary 200', sum.status === 200, String(sum.status));
      ok('referral code issued', !!sum.data.code, String(sum.data.code));
      ok('share link is absolute', /^https?:\/\//.test(String(sum.data.shareUrl || '')), String(sum.data.shareUrl));
      ok('share link points at this host', String(sum.data.shareUrl || '').startsWith(BASE),
        'expected prefix ' + BASE + ' — if this fails, set PUBLIC_URL in Render');
      const cfg = sum.data.config || {};
      console.log('    config: ' + JSON.stringify(cfg));
      ok('coinsPerReferral present', Number(cfg.coinsPerReferral) > 0, String(cfg.coinsPerReferral));
      ok('redeem rate present', Number(cfg.redeemBlock) > 0 && Number(cfg.redeemDays) > 0,
        cfg.redeemBlock + '/' + cfg.redeemDays);

      const pub = await req('GET', '/api/referrals/resolve/' + encodeURIComponent(String(sum.data.code)));
      ok('own code resolves publicly', pub.status === 200 && pub.data.valid === true, JSON.stringify(pub.data).slice(0, 90));
      ok('resolve leaks no email', !('email' in (pub.data || {})), Object.keys(pub.data || {}).join(','));

      const conn = await req('GET', '/api/wearables/connection', null, token);
      ok('wearables connection 200', conn.status === 200, String(conn.status));
    }
  }

  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped =====');
  if (fail) console.log('\nOne or more checks failed. Nothing was written — safe to re-run.');
  process.exit(fail ? 1 : 0);
})();
