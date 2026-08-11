/**
 * Integration test: the PDF upload path, end to end through routes/wearables.js.
 * Run: node tests/whoop-route-pdf.js
 *
 * NO NETWORK. NO DATABASE. The Anthropic call is stubbed by replacing global fetch
 * and the database by a recording fake, so what is under test is the WIRING that
 * tests/whoop-pdf-extract.js cannot see: the route asked extractWhoopPdf for a
 * `files` array of CSV text, which that module has never returned, so every valid
 * PDF was answered 422 after the tokens had already been spent.
 *
 * The same fixture also carries two same-activity workouts on one date — the case
 * where an untimed start stamp used to collapse two sessions into one row silently.
 */

const { createWearablesRouter } = require('../routes/wearables');
const readinessService = require('../services/wearables/readinessService');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}

function eq(actual, expected, msg) {
  checks += 1;
  const ok = Object.is(actual, expected);
  if (!ok) failures.push(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return ok;
}

function section(name) {
  console.log(`=== ${name} ===`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal, uncompressed PDF whose text sits in plain `(...) Tj` literals. */
function makePdf(lines, pageCount) {
  const pages = pageCount || 1;
  const body = lines.map((l) => `BT /F1 12 Tf 72 700 Td (${l}) Tj ET`).join('\n');
  let out = '%PDF-1.4\n';
  out += '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n';
  out += `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n`;
  for (let i = 0; i < pages; i += 1) {
    out += `${3 + i} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`;
  }
  out += `${3 + pages} 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj\n`;
  out += 'trailer << /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

const WHOOP_PDF = makePdf([
  'WHOOP Performance Assessment',
  'Member: Test Member    Period: March 2026',
  '11 Mar  Recovery 64%  HRV 68 ms  Resting Heart Rate 52 bpm',
  '12 Mar  Recovery 71%  HRV 74 ms  Resting Heart Rate 51 bpm',
  '12 Mar  Running 30 min, strain 8.1, 300 cal',
  '12 Mar  Running 55 min, strain 13.4, 700 cal'
], 2);

/** A daily report: two dated days and two same-activity workouts on one of them. */
const DAILY_PAYLOAD = {
  is_whoop_document: true,
  document_type: 'health_monitor',
  member_name: 'Test Member',
  periods: [],
  daily: [
    {
      date: '2026-03-11',
      metrics: [
        { name: 'recovery_score', value: 64, unit: '%', statistic: 'value', evidence: '11 Mar  Recovery 64%', page: 1 },
        { name: 'hrv', value: 68, unit: 'ms', statistic: 'value', evidence: '11 Mar  HRV 68 ms', page: 1 },
        { name: 'resting_hr', value: 52, unit: 'bpm', statistic: 'value', evidence: '11 Mar  Resting Heart Rate 52 bpm', page: 1 }
      ]
    },
    {
      date: '2026-03-12',
      metrics: [
        { name: 'recovery_score', value: 71, unit: '%', statistic: 'value', evidence: '12 Mar  Recovery 71%', page: 1 },
        { name: 'hrv', value: 74, unit: 'ms', statistic: 'value', evidence: '12 Mar  HRV 74 ms', page: 1 },
        { name: 'resting_hr', value: 51, unit: 'bpm', statistic: 'value', evidence: '12 Mar  Resting Heart Rate 51 bpm', page: 1 }
      ]
    }
  ],
  workouts: [
    { date: '2026-03-12', activity: 'Running', duration_min: 30, strain: 8.1, energy_kcal: 300, max_hr: null, avg_hr: null, evidence: '12 Mar  Running 30 min, strain 8.1, 300 cal', page: 2 },
    { date: '2026-03-12', activity: 'Running', duration_min: 55, strain: 13.4, energy_kcal: 700, max_hr: null, avg_hr: null, evidence: '12 Mar  Running 55 min, strain 13.4, 700 cal', page: 2 }
  ],
  journal: [],
  notes: [],
  uncertain: [],
  confidence: 'high'
};

/** The same report with only a monthly average: no day may ever be invented from it. */
const MONTHLY_PAYLOAD = {
  is_whoop_document: true,
  document_type: 'monthly_performance_assessment',
  member_name: 'Test Member',
  periods: [
    {
      label: 'March 2026',
      granularity: 'monthly',
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      metrics: [
        { name: 'recovery_score', value: 64, unit: '%', statistic: 'average', evidence: '11 Mar  Recovery 64%', page: 1 }
      ]
    }
  ],
  daily: [],
  workouts: [],
  journal: [],
  notes: [],
  uncertain: [],
  confidence: 'high'
};

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const realFetch = global.fetch;

/** Replaces global fetch with one that answers every call with `payload`. */
function stubFetch(payload) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 5000, output_tokens: 800 },
      stop_reason: 'end_turn'
    })
  });
}

/**
 * A database that writes nothing and remembers every statement, so the test can
 * assert on what WOULD have been written without a server.
 */
function fakeDb() {
  const statements = [];
  return {
    statements,
    run: async (sql, params) => { statements.push({ sql: String(sql), params: params || [] }); return { rowCount: 1 }; },
    queryOne: async () => null,
    queryAll: async () => [],
    /** Every parameter tuple written to one table, one array per row. */
    rowsFor(table, colCount) {
      const out = [];
      statements.forEach((s) => {
        if (s.sql.indexOf(`INSERT INTO ${table}`) === -1) return;
        for (let i = 0; i + colCount <= s.params.length; i += colCount) out.push(s.params.slice(i, i + colCount));
      });
      return out;
    }
  };
}

/** POST one route on the real router and resolve with { status, body }. */
function post(router, url, body) {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', url, headers: {}, body };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
      setHeader() {},
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    router(req, res, (err) => reject(err || new Error(`no route matched ${url}`)));
  });
}

function routerWith(db) {
  return createWearablesRouter({
    run: db.run,
    queryOne: db.queryOne,
    queryAll: db.queryAll,
    verifyToken: (req, res, next) => { req.user = { id: 'user-1', role: 'member' }; next(); },
    requireAdminOrSuperadmin: (req, res, next) => next()
  });
}

const UPLOAD = { file_base64: WHOOP_PDF.toString('base64'), file_name: 'whoop-march.pdf' };

// ---------------------------------------------------------------------------

async function run() {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';

  // -------------------------------------------------------------------------
  section('preview accepts a Whoop PDF');

  stubFetch(DAILY_PAYLOAD);
  const previewDb = fakeDb();
  const preview = await post(routerWith(previewDb), '/whoop/preview', UPLOAD);

  eq(preview.status, 200, 'a valid PDF previews with 200 (it used to be 422 for every PDF)');
  eq(preview.body && preview.body.ok, true, 'the preview reports ok');
  eq(preview.body && preview.body.totalDays, 2, 'both dated days are found');
  eq(preview.body && preview.body.workouts, 2, 'both workouts are counted');
  eq(preview.body && preview.body.extraction && preview.body.extraction.source, 'pdf', 'the PDF provenance is surfaced');
  assert(
    !!(preview.body && preview.body.extraction && preview.body.extraction.model),
    'the model that read the PDF is named, so the spend is auditable'
  );
  assert(
    !!(preview.body && preview.body.coverage && preview.body.coverage.granularity === 'daily'),
    'the coverage the extractor computed reaches the client'
  );
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('commit writes what the PDF held');

  stubFetch(DAILY_PAYLOAD);
  const commitDb = fakeDb();
  const commit = await post(routerWith(commitDb), '/whoop/commit', UPLOAD);

  eq(commit.status, 200, 'a valid PDF commits with 200');
  eq(commit.body && commit.body.ok, true, 'the commit reports ok');
  eq(commit.body && commit.body.daysWritten, 2, 'both days are written');
  eq(commit.body && commit.body.workoutsWritten, 2,
    'two same-day, same-activity workouts stay two rows — they used to collapse into one');
  eq(commit.body && commit.body.workoutsSkipped, 0, 'nothing is skipped');
  eq(commit.body && commit.body.workoutsCollapsed, 0, 'nothing is collapsed');

  // WORKOUT_COLS = 8 fixed columns + the metric columns + source_upload_id.
  const workoutCols = 8 + readinessService.WORKOUT_METRIC_COLUMNS.length + 1;
  const workoutRows = commitDb.rowsFor('wearable_workouts', workoutCols);
  eq(workoutRows.length, 2, 'two workout tuples reach the database');
  const keys = workoutRows.map((r) => r[4]);
  assert(keys[0] !== keys[1], 'the two workouts carry different natural keys');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('an aggregates-only PDF is refused in the extractor\'s own words');

  stubFetch(MONTHLY_PAYLOAD);
  const monthly = await post(routerWith(fakeDb()), '/whoop/preview', UPLOAD);
  eq(monthly.status, 422, 'a monthly-only PDF is refused');
  assert(
    typeof monthly.body.error === 'string' && /monthly|summar/i.test(monthly.body.error),
    `the refusal says what the document actually held, got: ${monthly.body && monthly.body.error}`
  );
  assert(
    monthly.body.error.indexOf('exported your full Whoop data') === -1,
    'a monthly report is not reported as an incomplete export'
  );
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('a failed extraction is still an honest refusal');

  global.fetch = async () => { throw new Error('socket hang up'); };
  const broken = await post(routerWith(fakeDb()), '/whoop/preview', UPLOAD);
  eq(broken.status, 422, 'an unreadable PDF is refused, not accepted empty');
  assert(typeof broken.body.error === 'string' && broken.body.error.length > 0, 'the refusal carries a message');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('workout natural keys');

  const untimed = (over) => Object.assign(
    { date: '2025-06-01', startedAt: '2025-06-01', activity: 'Running', durationMin: 30, strain: 8.1, energyKcal: 300 },
    over || {}
  );
  const morning = readinessService.normalizeWorkout(untimed());
  const evening = readinessService.normalizeWorkout(untimed({ durationMin: 55, strain: 13.4, energyKcal: 700 }));
  assert(morning.key !== evening.key, 'two untimed sessions on one date do not share a key');
  eq(
    readinessService.normalizeWorkout(untimed()).key,
    morning.key,
    'the same untimed session re-uploaded keeps its key, so it updates instead of duplicating'
  );

  const timed = readinessService.normalizeWorkout({
    date: '2025-06-01', startedAt: '2025-06-01T07:30:00.000Z', activity: 'Running', durationMin: 30
  });
  eq(timed.key, '2025-06-01T07:30:00.000Z|Running', 'a start stamp with a time of day is the key on its own');

  const collapseDb = fakeDb();
  const collapsed = await readinessService.persistWorkouts(collapseDb, {
    userId: 'user-1', provider: 'whoop', uploadId: 'up-1',
    workouts: [untimed(), untimed(), untimed({ durationMin: 55, strain: 13.4, energyKcal: 700 })]
  });
  eq(collapsed.written, 2, 'a genuinely identical duplicate is written once');
  eq(collapsed.collapsed, 1, 'the collapsed duplicate is counted');
  eq(collapsed.skipped, 1, 'and reported as skipped rather than vanishing');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  global.fetch = realFetch;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;

  console.log('');
  if (failures.length) {
    console.error(`FAILED ${failures.length} of ${checks} checks:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log(`whoop route PDF: all ${checks} checks passed`);
}

run().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
