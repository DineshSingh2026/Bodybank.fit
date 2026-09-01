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

// Routes that carry no guard *middleware* but are nonetheless safe. Each entry was
// verified by request against a running instance during the 2026-09-01 security
// audit; the note says why it is acceptable. Anything /api/ that is unguarded and
// NOT listed here is reported, and --check exits non-zero.
//
// Adding an entry here is a security decision. Do not add one to silence the scan.
const INTENTIONALLY_PUBLIC = [
  // --- genuinely anonymous surfaces (pre-login or marketing) ---
  /^\/api\/health$/,                          // liveness probe, no data
  /^\/api\/config$/,                          // public OAuth client ids, needed before login
  /^\/api\/push\/vapid-public$/,              // the public half of the VAPID keypair
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/signup$/,
  /^\/api\/auth\/google/,
  /^\/api\/auth\/apple/,
  /^\/api\/auth\/forgot-password$/,
  /^\/api\/auth\/reset-password$/,
  /^\/api\/audit$/,                           // POST: lead capture form
  /^\/api\/part2$/,                           // POST: lead capture form
  /^\/api\/schedule-call$/,                   // POST: public booking request
  /^\/api\/schedule-call\/availability$/,     // free/busy calendar for the booking form
  /^\/api\/contact$/,                         // POST: contact form
  /^\/api\/programs$/,                        // public program catalogue (titles + pdf links)
  /^\/api\/feed\/posts$/,                     // public transformation wall
  /^\/api\/feed\/image\/[^/]+$/,              // images for the same public wall
  /^\/api\/feed\/user-posts$/,                // public wall filtered by display name; no PII
  /^\/api\/public\//,                         // signed-URL namespace (HMAC checked in handler)
  /^\/api\/vapid-public-key$/,

  // --- guarded inside the handler rather than by middleware ---
  // Verified to return 401/403 to an anonymous caller.
  /^\/api\/auth\/verify-reset-token\/[^/]+$/, // the token in the path IS the credential
  /^\/api\/me\/programs\/pdf$/,               // verifyPdfAccessToken -> 403 without a signed token
  /^\/api\/progress-report$/,                 // verifyProgressReportToken -> 401 without a token
  /^\/api\/superadmin\/bootstrap$/,           // SUPERADMIN_BOOTSTRAP_SECRET -> 404 when unset/wrong
  /^\/api\/superadmin\/shared$/,              // verifyShareToken -> 401 without a share token
  /^\/api\/admin\/user-progress\/[^/]+$/      // verifyToken + role check inline -> 403 for members
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

function isIntentionallyPublic(p) {
  return INTENTIONALLY_PUBLIC.some((re) => re.test(p));
}

function main() {
  const all = SOURCES.flatMap(scanFile);
  const api = all.filter((r) => isApi(r.path));

  const unauthenticated = api.filter(
    (r) => r.guards.length === 0 && !isIntentionallyPublic(r.path)
  );
  const publicByDesign = api.filter((r) => isIntentionallyPublic(r.path));
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
