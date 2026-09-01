# BodyBank security test suite

Automated checks for authentication, authorization/user isolation, file upload
handling, and endpoint auth posture — plus a controlled load harness.

Everything here runs **only** against an isolated throwaway database. It cannot be
pointed at production: `lib/env-guard.js` aborts the process unless

* `DATABASE_URL` names the database `bodybank_sectest` on a **local** host, and
* no outbound credential (`SMTP_*`, `TWILIO_*`, `FIREBASE_SERVICE_ACCOUNT`,
  `ANTHROPIC_API_KEY`, `VAPID_*`, …) is present in the environment, and
* neither the database URL nor the API base contains a production marker
  (`bodybank.fit`, `onrender.com`, `railway.app`, …).

If any of those fail the suite prints a banner and exits 2 without running a
single test.

## Running it

Three terminals' worth of commands, from the repository root:

```bash
# 1. create the throwaway database (once; --reset to recreate)
npm run sec:db

# 2. start the server against it, in its own terminal.
#    This pre-blanks every outbound credential BEFORE dotenv loads, so the real
#    .env cannot leak in. Look for "injecting env (0) from .env" in the output —
#    that is the proof of isolation.
npm run sec:server

# 3. run the suites
npm run sec:test
```

### Individual pieces

```bash
npm run sec:scan          # static endpoint auth posture report
npm run sec:scan:check    # same, exits 1 if any /api/ route is unguarded  <- CI gate
npm run sec:load          # controlled load ramp (local target only)
npm run sec:load -- --stages 10,50,100
```

The load harness aborts the ramp automatically if a stage exceeds a 10% error rate
or a 10s p95, so it degrades into a stop rather than a denial-of-service.

## What each file is

| File | Purpose |
| --- | --- |
| `lib/env-guard.js` | The safety interlock. Every suite calls `assertIsolatedTestEnv()` first. |
| `lib/client.js` | HTTP helpers + synthetic user factory. Backs off on 429 rather than weakening the rate limiter. |
| `lib/assert.js` | Result recording and the `expectDenied` / `expectNotLeaking` helpers. |
| `bootstrap-test-db.js` | Creates/recreates `bodybank_sectest`. Refuses to drop anything else. |
| `run-test-server.js` | Boots the real server against the isolated environment. |
| `scan-endpoint-auth.js` | Static: parses every route registration and reports its guards. |
| `test-auth.js` | Login, signup, throttling, enumeration, injection, token handling. |
| `test-user-isolation.js` | USER_A vs USER_B — the IDOR/BOLA matrix. |
| `test-file-upload.js` | Upload auth, magic-byte validation, size caps, cross-user deletion. |
| `test-medical-isolation.js` | Blood reports, wearables and nutrition — the most sensitive data in the product. |
| `test-email-transport.js` | Stands up a local SMTP sink and sends through the real service. Catches nodemailer regressions. |
| `load-test.js` | Ramped load with per-stage latency percentiles. |
| `run-all.js` | Runs the suites in sequence; non-zero exit if any fails. |

## Fixtures and the rate limiter

`test-auth.js` drives `/api/auth/signup` and `/api/auth/login` for real, because those
endpoints are what it is testing. The authorization suites instead create their
fixtures with `createUserFast()`, which inserts the row directly and mints a token
with the test server's key.

That is deliberate. Signup is limited to 5/min per IP and login to 20/min — correct
controls that the suites trip simply by making fixtures. Driving them anyway meant a
full run spent minutes asleep, which is how a security suite ends up never being run.
The minted token is indistinguishable from a real one, so every request under test
still goes through the production auth path. The whole suite now runs in a few
seconds.

**Never weaken a rate limit to make a test pass.**

## Synthetic data

Test accounts use the reserved `.invalid` TLD (`sectest-user-a-…@sectest.invalid`),
which can never resolve or receive mail, and every record is tagged with a
`SECTEST-…` session id. They accumulate in `bodybank_sectest`; `npm run sec:db:reset`
wipes the lot.

## Adding to the allowlist

`scan-endpoint-auth.js` has an `INTENTIONALLY_PUBLIC` list. Each entry carries a note
explaining why that route is safe without guard middleware — either it is genuinely
anonymous, or it is guarded inside the handler (signed token, env secret) and was
verified by request. **Adding an entry is a security decision.** Do not add one to
quiet the scanner; guard the route instead.
