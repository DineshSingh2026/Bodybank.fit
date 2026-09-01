'use strict';

/**
 * Static endpoint auth-posture scanner.
 *
 * Parses every Express route registration in server.js and routes/*.js and
 * reports the guard middleware attached to each. Purely static: it reads source,
 * makes no network or database calls, and is safe to run anywhere.
 *
 * Purpose: catch the class of bug where a new /api/ route ships without
 * verifyToken, or an admin-only route ships without requireAdmin.
 *
 *   node tests/security/scan-endpoint-auth.js            # human report
 *   node tests/security/scan-endpoint-auth.js --json     # machine readable
 *   node tests/security/scan-endpoint-auth.js --check    # exit 1 on regressions
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const SOURCES = [
  'server.js',
  ...fs
    .readdirSync(path.join(ROOT, 'routes'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('routes', f))
];

const GUARDS = [
  'verifyToken',
  'requireAdmin',
  'requireSuperadmin',
  'requireAdminOrSuperadmin',
  'requireOperator',
  'verifyProgressReportToken',
  'verifyShareToken',
  'verifyPdfAccessToken'
];

// Routes that carry no guard *middleware* but are nonetheless safe.
//
// Entries are "METHOD /path" — matched on BOTH, deliberately. An earlier version of
// this list matched on path alone, which meant listing "/api/audit" for the public
// POST lead form silently exempted GET /api/audit as well — and that GET returned
// every lead record, unauthenticated. Path-only matching hides exactly the kind of
// bug this scanner exists to find, so a method is now required.
//
// Each entry was verified by request against a running instance. Adding one is a
// security decision. Do not add one to silence the scan.
const INTENTIONALLY_PUBLIC = [
  // --- genuinely anonymous surfaces (pre-login or marketing) ---
  [/^GET \/api\/health$/, 'liveness probe, no data'],
  [/^GET \/api\/config$/, 'public OAuth client ids, needed before login'],
  [/^GET \/api\/push\/vapid-public$/, 'the public half of the VAPID keypair'],
  [/^POST \/api\/auth\/login$/, ''],
  [/^POST \/api\/auth\/signup$/, ''],
  [/^POST \/api\/auth\/google/, ''],
  [/^POST \/api\/auth\/apple/, ''],
  [/^POST \/api\/auth\/forgot-password$/, ''],
  [/^POST \/api\/auth\/reset-password$/, ''],
  [/^POST \/api\/audit$/, 'lead capture form. GET on this path lists every lead — staff only'],
  [/^POST \/api\/part2$/, 'lead capture form. GET lists every submission — staff only'],
  [/^POST \/api\/contact$/, 'contact form. GET lists every message — staff only'],
  [/^POST \/api\/schedule-call$/, 'public booking request'],
  [/^GET \/api\/schedule-call\/availability$/, 'free/busy calendar for the booking form'],
  [/^GET \/api\/programs$/, 'public programme catalogue (titles + pdf links)'],
  [/^GET \/api\/feed\/posts$/, 'public transformation wall'],
  [/^GET \/api\/feed\/image\/[^/]+$/, 'images for the same public wall'],
  [/^GET \/api\/feed\/user-posts$/, 'public wall filtered by display name; no PII'],
  [/^GET \/api\/public\//, 'signed-URL namespace (HMAC checked in handler)'],
  [/^GET \/api\/vapid-public-key$/, ''],

  // --- guarded inside the handler rather than by middleware ---
  // Each verified to return 401/403/404 to an anonymous caller.
  [/^GET \/api\/auth\/verify-reset-token\/[^/]+$/, 'the token in the path IS the credential'],
  [/^GET \/api\/me\/programs\/pdf$/, 'verifyPdfAccessToken -> 403 without a signed token'],
  [/^GET \/api\/progress-report$/, 'verifyProgressReportToken -> 401 without a token'],
  [/^GET \/api\/superadmin\/bootstrap$/, 'env secret, constant-time -> 404 when unset/wrong'],
  [/^GET \/api\/superadmin\/shared$/, 'verifyShareToken -> 401 without a share token'],
  [/^GET \/api\/admin\/user-progress\/[^/]+$/, 'verifyToken + role check inline -> 403 for members']
];

const ROUTE_RE =
  /\b(app|router)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\3\s*([\s\S]{0,400}?)(?:async\s*)?\(?\s*(?:req|_req)\b/g;

function scanFile(rel) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const lineStarts = [];
  let idx = 0;
  src.split('\n').forEach((l) => {
    lineStarts.push(idx);
    idx += l.length + 1;
  });
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const out = [];
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(src)) !== null) {
    const [, , method, , routePath, chainRaw] = m;
    const chain = String(chainRaw || '');
    const guards = GUARDS.filter((g) => new RegExp(`\\b${g}\\b`).test(chain));
    const rateLimited = /\brateLimiter\s*\(/.test(chain);
    out.push({
      file: rel,
      line: lineOf(m.index),
      method: method.toUpperCase(),
      path: routePath,
      guards,
      rateLimited
    });
  }
  return out;
}

function isApi(p) {
  return p.startsWith('/api/') || p === '/api';
}

function isIntentionallyPublic(route) {
  const key = `${route.method} ${route.path}`;
  return INTENTIONALLY_PUBLIC.some(([re]) => re.test(key));
}

function main() {
  const all = SOURCES.flatMap(scanFile);
  const api = all.filter((r) => isApi(r.path));

  const unauthenticated = api.filter(
    (r) => r.guards.length === 0 && !isIntentionallyPublic(r)
  );
  const publicByDesign = api.filter((r) => isIntentionallyPublic(r));
  const guarded = api.filter((r) => r.guards.length > 0);

  const unratedPublic = publicByDesign.filter((r) => !r.rateLimited);

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        { total: all.length, api: api.length, unauthenticated, publicByDesign, guarded },
        null,
        2
      )
    );
  } else {
    console.log('\n=== BodyBank endpoint auth posture ===');
    console.log(`  route registrations parsed : ${all.length}`);
    console.log(`  /api/ routes               : ${api.length}`);
    console.log(`  guarded                    : ${guarded.length}`);
    console.log(`  public by design           : ${publicByDesign.length}`);
    console.log(`  UNAUTHENTICATED (review)   : ${unauthenticated.length}`);

    if (unauthenticated.length) {
      console.log('\n--- /api/ routes with no guard middleware ---');
      unauthenticated
        .sort((a, b) => a.path.localeCompare(b.path))
        .forEach((r) =>
          console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(52)} ${r.file}:${r.line}`)
        );
    }

    if (unratedPublic.length) {
      console.log('\n--- public routes with no rate limiter ---');
      unratedPublic.forEach((r) =>
        console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(52)} ${r.file}:${r.line}`)
      );
    }
    console.log('');
  }

  if (process.argv.includes('--check') && unauthenticated.length) {
    console.error(
      `FAIL: ${unauthenticated.length} /api/ route(s) have no auth guard and are not ` +
      'listed in INTENTIONALLY_PUBLIC.'
    );
    process.exit(1);
  }
}

main();
