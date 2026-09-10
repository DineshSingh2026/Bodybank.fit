'use strict';

/**
 * BodyBank — graded health report: persistence + route integration tests.
 *
 *   node tests/graded-report-service.js
 *
 * Runs the real service and the real Express router against a stubbed database, so
 * the whole path — upload variant, build, edit, reset, switch, download, send — is
 * exercised without needing Postgres.
 *
 * The isolation checks at the end are the important ones: they prove a graded report
 * cannot disturb a classic one, and that the classic route contract is unchanged.
 */

const http = require('http');
const fs = require('fs');
const express = require('express');

const graded = require('../services/gradedReportService');
const { createBloodRouter } = require('../routes/blood');

let passed = 0;
const failures = [];
let group = '';
function section(n) { group = n; }
function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(`[${group}] ${name}` + (detail ? ` :: ${detail}` : ''));
}
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------------------
// A stub database: enough SQL awareness for the queries this feature issues.
// ---------------------------------------------------------------------------

const fixture = JSON.parse(fs.readFileSync(require('path')
  .join(__dirname, '..', 'fixtures', 'demo', 'screening-current.json'), 'utf8'));
const fixturePrev = JSON.parse(fs.readFileSync(require('path')
  .join(__dirname, '..', 'fixtures', 'demo', 'screening-previous.json'), 'utf8'));

function newRow(id, over) {
  return Object.assign({
    id,
    user_id: 'u1',
    user_name: 'Demo Client',
    user_email: 'demo@example.com',
    user_age: '41',
    user_gender: 'male',
    user_goal: 'Fat loss',
    status: 'complete',
    report_date: '2026-09-02',
    created_at: '2026-09-02T09:00:00Z',
    report_variant: 'classic',
    extracted_blood_data: fixture.extracted,
    ai_report: { overall_status: 'Fair', overall_summary_short: 'Classic summary line.' },
    admin_notes: '',
    pdf_path: null,
    graded_report: null,
    graded_doc: null,
    graded_doc_updated_at: null,
    graded_doc_updated_by: '',
    graded_pdf_path: null,
    engine_version: null,
    ruleset_version: null,
    blood_report_file_path: null,
    sent_to_user: false,
    // Present and null, exactly as Postgres returns it. Leaving it off would make
    // mapReportRow emit `undefined`, which JSON drops — and the contract check below
    // would then fail on a stub artefact rather than a real regression.
    sent_at: null,
    analysis_last_error: null,
    extraction_ai_usage: null,
    analysis_ai_usage: null,
    total_ai_usage: null,
    nutrition_snapshot: null,
    symptoms: []
  }, over || {});
}

const state = {
  rows: new Map(),
  users: new Map([['u1', { id: 'u1', first_name: 'Demo', last_name: 'Client', email: 'demo@example.com', gender: 'male' }]])
};

/** Apply a simple `SET a = ?, b = ?` update to a row. */
function applySet(row, sql, params) {
  const setPart = sql.slice(sql.toUpperCase().indexOf(' SET ') + 5, sql.toUpperCase().lastIndexOf(' WHERE '));
  const assigns = setPart.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  let pi = 0;
  assigns.forEach((a) => {
    const col = a.split('=')[0].trim();
    const rhs = a.slice(a.indexOf('=') + 1).trim();
    if (/^\?/.test(rhs) || /^\?::/.test(rhs)) {
      let v = params[pi]; pi += 1;
      if (/::jsonb/.test(rhs) && typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { /* keep */ } }
      row[col] = v;
    } else if (/^NULL$/i.test(rhs)) {
      row[col] = null;
    } else if (/^CURRENT_TIMESTAMP$/i.test(rhs)) {
      row[col] = new Date().toISOString();
    } else if (/^'.*'$/.test(rhs)) {
      row[col] = rhs.slice(1, -1);
    }
  });
  return pi;
}

const db = {
  async run(sql, params) {
    params = params || [];
    if (/^\s*UPDATE blood_analysis_reports/i.test(sql)) {
      const id = params[params.length - 1];
      const row = state.rows.get(id);
      if (row) applySet(row, sql, params);
      return { rowCount: row ? 1 : 0 };
    }
    if (/^\s*INSERT INTO blood_analysis_reports/i.test(sql)) {
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
      const row = newRow(params[0]);
      cols.forEach((c, i) => { row[c] = params[i]; });
      state.rows.set(row.id, row);
      return { rowCount: 1 };
    }
    return { rowCount: 0 };
  },
  async queryOne(sql, params) {
    params = params || [];
    if (/FROM users/i.test(sql)) return state.users.get(params[0]) || null;
    if (/FROM blood_analysis_reports/i.test(sql)) return state.rows.get(params[0]) || null;
    return null;
  },
  async queryAll(sql, params) {
    params = params || [];
    if (/FROM blood_analysis_reports/i.test(sql)) {
      let rows = Array.from(state.rows.values()).filter((r) => r.user_id === params[0]);
      if (/id <> \?/.test(sql)) rows = rows.filter((r) => r.id !== params[1]);
      if (/< COALESCE/.test(sql)) {
        const cutoff = params[2] || params[3];
        rows = rows.filter((r) => String(r.report_date || '') < String(cutoff || ''));
      }
      return rows.sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    }
    return [];
  }
};

// ===========================================================================
section('service — build');
// ===========================================================================

async function main() {
  state.rows.set('r-prev', newRow('r-prev', {
    report_date: '2026-03-04',
    created_at: '2026-03-04T09:00:00Z',
    extracted_blood_data: fixturePrev.extracted
  }));
  state.rows.set('r1', newRow('r1'));

  eq('unknown variant falls back to classic', graded.normalizeVariant('nonsense'), 'classic');
  eq('missing variant falls back to classic', graded.normalizeVariant(undefined), 'classic');
  eq('graded is recognised', graded.normalizeVariant('GRADED'), 'graded');

  const built = await graded.buildGradedReportFor(db, 'r1');
  ok('the graded report builds', !built.error, built.error);
  ok('the engine version is stamped on the row', !!state.rows.get('r1').engine_version);
  ok('the ruleset version is stamped on the row', !!state.rows.get('r1').ruleset_version);
  ok('the graded report is persisted', !!state.rows.get('r1').graded_report);
  ok('the previous screening was found', built.report.hasPrevious === true);
  ok('progress is present', !!built.report.progress);
  eq('progress interval', built.report.progress.intervalDays, 182);

  // The classic columns are untouched by the graded build.
  const r1 = state.rows.get('r1');
  eq('ai_report untouched', r1.ai_report.overall_summary_short, 'Classic summary line.');
  eq('pdf_path untouched', r1.pdf_path, null);
  ok('extracted_blood_data untouched',
    JSON.stringify(r1.extracted_blood_data) === JSON.stringify(fixture.extracted));

  // A report with no prior screening gets no trends, never invented ones.
  state.rows.set('r-solo', newRow('r-solo', { user_id: 'u2', report_date: '2026-09-02' }));
  state.users.set('u2', { id: 'u2', first_name: 'Solo', last_name: 'Client', email: 's@x.com', gender: 'female' });
  const solo = await graded.buildGradedReportFor(db, 'r-solo');
  eq('a first screening has no previous', solo.report.hasPrevious, false);
  eq('a first screening has no progress model', solo.report.progress, null);
  ok('a first screening says so', /trends will appear/i.test(solo.report.firstScreeningNote));

  // An unprocessed report cannot be graded.
  state.rows.set('r-raw', newRow('r-raw', { extracted_blood_data: null, status: 'pending' }));
  const raw = await graded.buildGradedReportFor(db, 'r-raw');
  ok('an unprocessed report is refused with a clear message',
    !!raw.error && /process/i.test(raw.error), raw.error);

  // =========================================================================
  section('service — document lifecycle');
  // =========================================================================

  const loaded = await graded.getGradedDoc(db, 'r1');
  ok('a document is produced', !!loaded.doc);
  eq('an untouched report reports as not edited', loaded.edited, false);

  // Edit: hide a section and rewrite a sentence.
  const edited = JSON.parse(JSON.stringify(loaded.doc));
  const areaSection = edited.sections.filter((s) => s.type === 'areacards')[0];
  areaSection.show = false;
  const keySection = edited.sections.filter((s) => s.type === 'text')[0];
  keySection.body = 'A reviewer wrote this framing sentence by hand.';

  const saved = await graded.saveGradedDoc(db, 'r1', edited, 'coach@bodybank.fit');
  ok('the edit saves', !saved.error, saved.error);
  eq('the edit clears the cached PDF', state.rows.get('r1').graded_pdf_path, null);
  eq('the reviewer is recorded', state.rows.get('r1').graded_doc_updated_by, 'coach@bodybank.fit');

  const reloaded = await graded.getGradedDoc(db, 'r1');
  eq('the stored document wins on reload', reloaded.edited, true);
  eq('the hidden section stays hidden',
    reloaded.doc.sections.filter((s) => s.type === 'areacards')[0].show, false);
  eq('the rewritten sentence survives',
    reloaded.doc.sections.filter((s) => s.type === 'text')[0].body,
    'A reviewer wrote this framing sentence by hand.');

  // The coach note round-trips into admin_notes, as the progress report does.
  const withNote = JSON.parse(JSON.stringify(reloaded.doc));
  withNote.sections.filter((s) => s.type === 'callout' && s.coachNote)[0].body = 'See you next quarter.';
  await graded.saveGradedDoc(db, 'r1', withNote, 'coach@bodybank.fit');
  eq('the coach note syncs to admin_notes', state.rows.get('r1').admin_notes, 'See you next quarter.');

  // A document with nothing visible is refused rather than printed blank.
  const emptied = JSON.parse(JSON.stringify(reloaded.doc));
  emptied.sections.forEach((s) => { if (s.type !== 'disclaimer') s.show = false; });
  const emptyResult = await graded.saveGradedDoc(db, 'r1', emptied, 'coach@bodybank.fit');
  ok('an empty report is refused', !!emptyResult.error, JSON.stringify(emptyResult).slice(0, 120));

  // Reset returns to the engine default.
  const reset = await graded.resetGradedDoc(db, 'r1');
  eq('reset clears the edited flag', reset.edited, false);
  eq('reset clears the stored document', state.rows.get('r1').graded_doc, null);
  eq('reset clears the cached PDF', state.rows.get('r1').graded_pdf_path, null);
  ok('reset restores the hidden section',
    reset.doc.sections.filter((s) => s.type === 'areacards')[0].show === true);

  // =========================================================================
  section('service — variant switching');
  // =========================================================================

  eq('the row starts on classic', state.rows.get('r1').report_variant, 'classic');
  const sw = await graded.setVariant(db, 'r1', 'graded');
  eq('switching to graded succeeds', sw.variant, 'graded');
  eq('the row records the variant', state.rows.get('r1').report_variant, 'graded');

  const back = await graded.setVariant(db, 'r1', 'classic');
  eq('switching back succeeds', back.variant, 'classic');
  ok('switching back keeps the graded work for next time', !!state.rows.get('r1').graded_report);

  const badSwitch = await graded.setVariant(db, 'r-raw', 'graded');
  ok('an unprocessed report cannot be switched to graded', !!badSwitch.error);
  eq('a refused switch leaves the variant alone', state.rows.get('r-raw').report_variant, 'classic');

  // =========================================================================
  section('service — pdf routing');
  // =========================================================================

  let classicCalls = 0;
  const fakeClassic = async () => { classicCalls += 1; return null; };

  await graded.setVariant(db, 'r1', 'classic');
  const classicPick = await graded.reportPdfFor(db, 'r1', fakeClassic);
  eq('a classic report uses the classic generator', classicCalls, 1);
  eq('a classic report with no PDF yields nothing', classicPick, null);

  await graded.setVariant(db, 'r1', 'graded');
  classicCalls = 0;
  const gradedPick = await graded.reportPdfFor(db, 'r1', fakeClassic);
  eq('a graded report never calls the classic generator', classicCalls, 0);
  ok('a graded report produces a PDF', !!(gradedPick && gradedPick.path), JSON.stringify(gradedPick));
  eq('the graded PDF is named distinctly', gradedPick.filename, 'BodyBank_Health_Map_Report.pdf');
  ok('the graded PDF exists on disk', fs.existsSync(gradedPick.path));
  ok('the graded PDF is written under health-reports',
    gradedPick.path.replace(/\\/g, '/').indexOf('/uploads/health-reports/') >= 0, gradedPick.path);
  eq('the PDF path is cached on the row', state.rows.get('r1').graded_pdf_path, gradedPick.path);

  // A second call reuses the cached file rather than re-rendering.
  const again = await graded.reportPdfFor(db, 'r1', fakeClassic);
  eq('a cached PDF is reused', again.path, gradedPick.path);

  // An edit invalidates it.
  const d2 = (await graded.getGradedDoc(db, 'r1')).doc;
  await graded.saveGradedDoc(db, 'r1', d2, 'coach@bodybank.fit');
  eq('an edit invalidates the cached PDF', state.rows.get('r1').graded_pdf_path, null);
  const rerendered = await graded.reportPdfFor(db, 'r1', fakeClassic);
  ok('a new PDF is rendered after an edit', !!rerendered.path && rerendered.path !== gradedPick.path);

  [gradedPick.path, rerendered.path].forEach((p) => { try { fs.unlinkSync(p); } catch (_) { /* ignore */ } });

  // =========================================================================
  section('routes');
  // =========================================================================

  await runRouteTests();

  finish();
}

// ---------------------------------------------------------------------------
// Route-level checks through a real Express app
// ---------------------------------------------------------------------------

function request(server, method, path, body, role) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers: Object.assign(
        { 'x-role': role || 'admin' },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
      )
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runRouteTests() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const router = createBloodRouter({
    run: db.run, queryOne: db.queryOne, queryAll: db.queryAll,
    verifyToken: (req, res, next) => {
      req.user = { id: 'u1', role: req.headers['x-role'] || 'admin', email: 'staff@bodybank.fit' };
      next();
    },
    rateLimiter: () => (req, res, next) => next(),
    sendPushToAdmins: async () => {}
  });
  app.use('/api/blood', router);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    await graded.setVariant(db, 'r1', 'graded');

    let r = await request(server, 'GET', '/api/blood/admin/report/r1/graded-doc');
    eq('GET graded-doc returns 200', r.status, 200);
    ok('GET graded-doc returns a document', !!(r.json && r.json.doc && r.json.doc.sections.length));
    eq('GET graded-doc reports the variant', r.json.reportVariant, 'graded');

    // Non-staff must not reach it.
    r = await request(server, 'GET', '/api/blood/admin/report/r1/graded-doc', null, 'user');
    eq('a member cannot read the staff document', r.status, 403);
    r = await request(server, 'GET', '/api/blood/admin/report/r1/graded-doc', null, 'operator');
    eq('an operator has parity with admins', r.status, 200);

    // Save through the route.
    const docToSave = r.json.doc;
    docToSave.sections.filter((s) => s.type === 'text')[0].body = 'Edited through the route.';
    r = await request(server, 'PUT', '/api/blood/admin/report/r1/graded-doc', { doc: docToSave });
    eq('PUT graded-doc returns 200', r.status, 200);
    eq('the edit persisted',
      state.rows.get('r1').graded_doc.sections.filter((s) => s.type === 'text')[0].body,
      'Edited through the route.');

    r = await request(server, 'PUT', '/api/blood/admin/report/r1/graded-doc', { doc: docToSave }, 'user');
    eq('a member cannot save the document', r.status, 403);

    // Reset.
    r = await request(server, 'POST', '/api/blood/admin/report/r1/graded-doc/reset', {});
    eq('POST reset returns 200', r.status, 200);
    eq('reset cleared the stored document', state.rows.get('r1').graded_doc, null);

    // Variant switch through the route.
    r = await request(server, 'PUT', '/api/blood/admin/variant/r1', { reportVariant: 'classic' });
    eq('PUT variant returns 200', r.status, 200);
    eq('PUT variant switched the row', state.rows.get('r1').report_variant, 'classic');
    r = await request(server, 'PUT', '/api/blood/admin/variant/r1', { reportVariant: 'made-up' });
    eq('an unknown variant falls back to classic rather than erroring', r.json.reportVariant, 'classic');

    // Rationale is staff-only and explains every grade.
    r = await request(server, 'GET', '/api/blood/admin/report/r1/graded-rationale');
    eq('GET rationale returns 200', r.status, 200);
    ok('rationale covers every area', (r.json.areas || []).length >= 8, String((r.json.areas || []).length));
    ok('every graded area carries its rules',
      r.json.areas.filter((a) => a.grade !== 'NOT_ASSESSED').every((a) => (a.rationale || []).length > 0));
    r = await request(server, 'GET', '/api/blood/admin/report/r1/graded-rationale', null, 'user');
    eq('a member cannot read the rationale', r.status, 403);

    // =====================================================================
    section('isolation — the classic report is unchanged');
    // =====================================================================

    // mapReportRow still returns every key the mobile builds read.
    r = await request(server, 'GET', '/api/blood/my-reports');
    eq('GET my-reports returns 200', r.status, 200);
    const row = (r.json.reports || []).filter((x) => x.id === 'r1')[0];
    ok('my-reports still returns the report', !!row);
    ['_id', 'id', 'userId', 'userName', 'userEmail', 'userGoal', 'status', 'createdAt',
      'reportDate', 'effectiveDate', 'hasSourceFile', 'sentToUser', 'sentAt', 'adminNotes',
      'pdfUrl', 'aiReport', 'analysisLastError'].forEach((k) => {
      ok(`my-reports still carries "${k}"`, Object.prototype.hasOwnProperty.call(row, k));
    });
    ok('my-reports gained the variant field', row.reportVariant === 'classic');
    eq('the classic ai_report still reaches the client',
      row.aiReport.overall_summary_short, 'Classic summary line.');

    // A classic report is never touched by the graded engines.
    const classicRow = state.rows.get('r-solo');
    eq('an untouched classic row has no graded document', classicRow.graded_doc, null);
    eq('an untouched classic row has no graded PDF', classicRow.graded_pdf_path, null);
    eq('an untouched classic row stays on the classic variant', classicRow.report_variant, 'classic');
  } finally {
    server.close();
  }
}

function finish() {
  console.log('');
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks`);
    failures.slice(0, 30).forEach((f) => console.log('  x ' + f));
    process.exit(1);
  }
  console.log(`PASSED  ${passed} checks — graded report service + routes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
