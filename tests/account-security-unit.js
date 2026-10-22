/**
 * Unit test: login sessions, pure parts (services/sessionService.js).
 * Run: node tests/account-security-unit.js
 *
 * NO NETWORK. NO DATABASE.
 *
 * Guards:
 *  - device labels for the iOS and Android apps, phone and desktop browsers;
 *  - the X-BB-Client hint wins over the user agent, and junk hints are ignored;
 *  - IP masking never shows a full address;
 *  - legacy session ids are stable per token and differ between tokens;
 *  - verifyToken without a session store behaves exactly as before.
 */
'use strict';

const S = require('../services/sessionService');

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); return ok; }
function eq(a, b, msg) { return assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const UA = {
  iosApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  androidApp: 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36',
  androidChromeReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  pixelChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
  ipadSafari: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
};

const d = (ua, hint) => { const r = S.describeDevice(ua, hint); return [r.platform, r.kind, r.label]; };
eq(d(UA.iosApp), ['ios-app', 'phone', 'BodyBank app on iPhone'], 'iOS app (WKWebView, no Safari token)');
eq(d(UA.iosSafari), ['web', 'phone', 'Safari on iPhone'], 'iPhone Safari');
eq(d(UA.iosChrome), ['web', 'phone', 'Chrome on iPhone'], 'iPhone Chrome');
eq(d(UA.androidApp), ['android-app', 'phone', 'BodyBank app on SM-S918B'], 'Android app (wv) with model');
eq(d(UA.androidChromeReduced), ['web', 'phone', 'Chrome on Android phone'], 'reduced Android UA "K" model is hidden');
eq(d(UA.pixelChrome), ['web', 'phone', 'Chrome on Pixel 8'], 'Pixel Chrome');
eq(d(UA.winEdge), ['web', 'desktop', 'Edge on Windows'], 'Edge before Chrome');
eq(d(UA.winChrome), ['web', 'desktop', 'Chrome on Windows'], 'Chrome on Windows');
eq(d(UA.macSafari), ['web', 'desktop', 'Safari on Mac'], 'Safari on Mac');
eq(d(UA.macFirefox), ['web', 'desktop', 'Firefox on Mac'], 'Firefox on Mac');
eq(d(UA.ipadSafari), ['web', 'tablet', 'Safari on iPad'], 'iPad Safari');
eq(d(UA.iosSafari, 'ios-app'), ['ios-app', 'phone', 'BodyBank app on iPhone'], 'client hint wins');
eq(d(UA.androidApp, 'web'), ['web', 'phone', 'Chrome on SM-S918B'], 'explicit web hint keeps a browser label');
eq(d(UA.winChrome, '<script>'), ['web', 'desktop', 'Chrome on Windows'], 'junk hint ignored');
eq(d('', ''), ['web', 'desktop', 'Browser on Unknown device'], 'empty user agent');
eq(d(null, null)[0], 'web', 'null user agent');

eq(S.maskIp('49.37.12.200'), '49.37.x.x', 'IPv4 masked');
eq(S.maskIp('::ffff:49.37.12.200'), '49.37.x.x', 'IPv4-mapped IPv6 masked');
eq(S.maskIp('2401:4900:1c5a:9d2e::1'), '2401:4900:…', 'IPv6 masked');
eq(S.maskIp(''), '', 'no IP');
eq(S.maskIp('garbage'), '', 'junk IP hidden');

const a = S.legacySid('token-a');
assert(/^legacy-[0-9a-f]{40}$/.test(a), 'legacy sid shape');
eq(S.legacySid('token-a'), a, 'legacy sid stable');
assert(S.legacySid('token-b') !== a, 'legacy sid differs per token');

eq(S.clientIp({ ip: '::ffff:10.0.0.7' }), '10.0.0.7', 'client IP strips the IPv4 prefix');
eq(S.clientIp({}), '', 'no IP on request');

// verifyToken without a store: unchanged behaviour (signature + expiry only).
(async () => {
  const auth = require('../middleware/auth');
  auth.setSessionStore(null);
  const tok = auth.signToken({ id: 'u1', email: 'a@b.c', role: 'user' });
  const run = (headers) => new Promise((resolve) => {
    const req = { headers, body: {}, query: {} };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b, req }); } };
    auth.verifyToken(req, res, () => resolve({ code: 'next', req }));
  });
  let r = await run({ authorization: 'Bearer ' + tok });
  eq([r.code, r.req.user && r.req.user.id], ['next', 'u1'], 'no store: valid token passes');
  r = await run({});
  eq([r.code, r.body.error], [401, 'Authentication required'], 'no token: 401');
  r = await run({ authorization: 'Bearer nope' });
  eq([r.code, r.body.error], [401, 'Invalid or expired token'], 'bad token: 401 with the message the apps recognise');

  // A store that says no → the same 401; a store that throws → fail open.
  auth.setSessionStore({ check: async () => ({ ok: false }) });
  r = await run({ authorization: 'Bearer ' + tok });
  eq([r.code, r.body.error], [401, 'Invalid or expired token'], 'revoked session: 401 Invalid or expired token');
  auth.setSessionStore({ check: async () => { throw new Error('db down'); } });
  const warn = console.warn; console.warn = () => {};
  r = await run({ authorization: 'Bearer ' + tok });
  console.warn = warn;
  eq(r.code, 'next', 'session store error fails open');
  auth.setSessionStore({ check: async () => ({ ok: true, sid: 's1' }) });
  r = await run({ authorization: 'Bearer ' + tok });
  eq([r.code, r.req.sessionId], ['next', 's1'], 'session id exposed on the request');
  let called = false;
  auth.setSessionStore({ check: async () => { called = true; return { ok: false }; } });
  const purpose = require('jsonwebtoken').sign({ userId: 'u1', purpose: 'pdf-view' }, auth.JWT_SECRET, { expiresIn: '1h' });
  r = await run({ authorization: 'Bearer ' + purpose });
  eq([r.code, called], ['next', false], 'tokens without a user id skip the session check');
  auth.setSessionStore(null);

  if (failures.length) {
    console.error(`account-security-unit: ${failures.length} of ${checks} checks FAILED`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log(`account-security-unit: all ${checks} checks passed`);
})();
