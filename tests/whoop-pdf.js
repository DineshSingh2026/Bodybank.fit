/**
 * Unit test: branded Whoop / readiness PDF renderer.
 * Run: node tests/whoop-pdf.js      (no dependencies, no server, no DB, no network)
 *
 * The stats fixture is NOT hand-written: it comes from running the real
 * computeWhoopStats() over the real golden Whoop export in tests/fixtures/whoop/,
 * so the renderer is exercised against the exact object shape it will see in
 * production.
 *
 * What is proven here:
 *   1. a full report renders — file exists, is non-trivial, starts with %PDF-
 *   2. a STATS-ONLY payload (no `report`, no `validation`) still renders
 *   3. validation.passed === false puts the orphan numbers ON THE PAGE
 *   4. a null metric renders as an em-dash and NEVER as 0
 *   5. numbers are printed byte-identically to the stats object (no re-rounding)
 *
 * PDFs are rendered with {compress:false} so the content streams are plain and
 * the drawn text can be read back out of the file without any PDF library.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../services/wearables/whoopParser');
const { computeWhoopStats } = require('../services/wearables/whoopStatsService');
const PDF = require('../services/wearables/whoopReportPdfKit');

const FIXTURES = path.join(__dirname, 'fixtures', 'whoop');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-whoop-pdf-'));
const written = [];

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

function section(name) { console.log(`=== ${name} ===`); }
function done(before) { console.log(failures.length === before ? '  OK' : '  FAIL'); }

function read(name) { return fs.readFileSync(path.join(FIXTURES, name), 'utf8'); }

function outPath(name) {
  const p = path.join(OUT_DIR, name);
  written.push(p);
  return p;
}

/**
 * Minimal PDF text reader for UNCOMPRESSED PDFKit output.
 * PDFKit writes standard-font runs as `[<hex> kern <hex> ...] TJ`; the kerning
 * numbers insert no characters, so concatenating the hex chunks in document
 * order reproduces the drawn strings exactly (bytes are WinAnsi).
 */
function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  let out = '';
  const re = /<([0-9A-Fa-f]+)>/g;
  let m;
  while ((m = re.exec(raw))) {
    const hex = m[1];
    if (hex.length % 2 !== 0) continue;
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
  }
  return out;
}

/** WinAnsi code point for the em-dash PDFKit writes for '—'. */
const WINANSI_EMDASH = '';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const parsed = W.parseWhoopExport({
  files: [
    { name: 'my_whoop_data/physiological_cycles.csv', text: read('physiological_cycles.csv') },
    { name: 'my_whoop_data/sleeps.csv', text: read('sleeps.csv') },
    { name: 'my_whoop_data/workouts.csv', text: read('workouts.csv') },
    { name: 'my_whoop_data/journal_entries.csv', text: read('journal_entries.csv') }
  ]
});

const GOLDEN_STATS = computeWhoopStats(parsed.days, { expectedDays: 30, memberLabel: 'Golden Fixture' });

/**
 * 30 days, deliberately missing TWO things so the null paths are exercised:
 *   - respiratoryRate is absent entirely  -> metrics.respiratoryRate === null
 *   - sleepDebtMin is absent entirely     -> every sleepDebt figure is null
 */
const THIRTY_DAYS = [];
for (let i = 0; i < 30; i += 1) {
  THIRTY_DAYS.push({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    source: 'whoop',
    recovery_score: i < 15 ? 70 : 30,
    resting_hr: i < 15 ? 60 : 54,
    hrv_ms: i % 3 === 1 ? null : 50,
    sleep_hours: i % 5 === 0 ? 5.5 : 7.5,
    sleep_efficiency_pct: 88,
    strain: 16
  });
}
const SPARSE_STATS = computeWhoopStats(THIRTY_DAYS, { expectedDays: 30, memberLabel: 'Sparse' });

const REPORT = {
  headline: 'Recovery slipped in the back half of the window while sleep held steady.',
  summary: 'Coverage was good and the picture is clear: recovery fell between the halves while resting heart '
    + 'rate improved. Sleep duration was consistent but sat below what the training load asks for. '
    + 'The next fortnight should protect sleep before adding any more strain.',
  sections: [
    { title: 'What the window shows', body: 'The first half and second half of this window are genuinely different. '.repeat(14) },
    { title: 'Where the risk sits', body: 'The risk is concentrated in the interaction between load and sleep. '.repeat(12) }
  ],
  sleepAnalysis: 'Sleep duration was stable across the window, but stability at a low number is not a win. '.repeat(10),
  recoveryAnalysis: 'Recovery is the metric that moved most, and it moved in the wrong direction. '.repeat(10),
  trainingLoadAnalysis: 'Strain stayed flat while recovery fell, which is the classic shape of accumulating fatigue. '.repeat(10),
  correlationInsights: 'The correlations here are associations over a small number of aligned days, not causes. '.repeat(9),
  actions: [
    { rank: 1, action: 'Protect a fixed lights-out time for the next fortnight.', rationale: 'Sleep is the lever with the most headroom in this window.' },
    { rank: 2, action: 'Cap hard sessions on any morning that opens in the red.', rationale: 'Hard days landing on low recovery are what drove the decline.' },
    { rank: 3, action: 'Wear the strap every night, including rest days.', rationale: 'Gaps in the calendar break the day-to-day pairings entirely.' }
  ],
  coachNotes: 'Worth a call before the next block is written. '.repeat(6)
};

const VALIDATION_PASSED = {
  passed: true,
  orphanNumbers: [],
  occurrences: [],
  numbersChecked: 42,
  attempts: [{ attempt: 1, ok: true }],
  semantic: { ran: true, contradictions: [], unsupportedClaims: [] }
};

const ORPHANS = ['88.6', '1234', '62.75'];
const VALIDATION_FAILED = {
  passed: false,
  orphanNumbers: ORPHANS.slice(),
  occurrences: [
    { field: 'recoveryAnalysis', number: '88.6' },
    { field: 'actions[0].rationale', number: '1234' },
    { field: 'summary', number: '62.75' }
  ],
  numbersChecked: 51,
  attempts: [{ attempt: 1, ok: false, orphanNumbers: ORPHANS.slice() }],
  semantic: {
    ran: true,
    contradictions: [{ quote: 'Recovery improved steadily.', why: 'The recovery trend direction is declining.' }],
    unsupportedClaims: []
  }
};

// ---------------------------------------------------------------------------

async function run() {
  // -------------------------------------------------------------------------
  section('Fixture sanity (real parser + real stats engine)');
  {
    const before = failures.length;
    assert(parsed.days.length > 0, 'golden Whoop export parsed into day rows');
    assert(GOLDEN_STATS && GOLDEN_STATS.coverage && GOLDEN_STATS.coverage.dateFrom,
      'computeWhoopStats produced a coverage window from the golden fixtures');
    eq(SPARSE_STATS.metrics.respiratoryRate, null, 'sparse fixture leaves respiratoryRate null');
    eq(SPARSE_STATS.sleepDebt.totalMin, null, 'sparse fixture leaves sleep debt null');
    done(before);
  }

  // -------------------------------------------------------------------------
  section('Full report renders (stats + narrative + passing validation)');
  let fullText = '';
  {
    const before = failures.length;
    const p = outPath('full.pdf');
    const res = await PDF.buildWhoopReportPdf({
      member: { name: 'Golden Member', email: 'golden@example.com' },
      stats: GOLDEN_STATS,
      report: REPORT,
      validation: VALIDATION_PASSED,
      generatedAt: '2026-08-08T09:30:00.000Z'
    }, p, { compress: false });

    eq(res.ok, true, 'buildWhoopReportPdf resolves ok:true');
    eq(res.path, p, 'result carries the output path');
    assert(fs.existsSync(p), 'PDF file exists on disk');
    const buf = fs.readFileSync(p);
    eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'file begins with the %PDF- magic bytes');
    assert(buf.length > 5000, `PDF is non-trivial in size (got ${buf.length} bytes)`);
    eq(res.bytes, buf.length, 'reported byte count matches the file on disk');
    assert(res.pages >= 3, `a full report paginates into multiple pages (got ${res.pages})`);

    fullText = extractPdfText(buf);
    assert(fullText.indexOf('Recovery & Readiness Report') !== -1, 'cover title is drawn');
    assert(fullText.indexOf('Golden Member') !== -1, 'member name is on the cover');
    assert(fullText.indexOf(String(GOLDEN_STATS.coverage.dateFrom)) !== -1, 'coverage dateFrom is on the cover');
    assert(fullText.indexOf(String(GOLDEN_STATS.coverage.dateTo)) !== -1, 'coverage dateTo is on the cover');
    assert(fullText.indexOf(`${GOLDEN_STATS.coverage.completenessPct}%`) !== -1,
      'coverage completeness is printed exactly as computed');
    assert(fullText.indexOf('Figures verified against source data') !== -1,
      'a passing validation renders the verification confirmation');
    assert(fullText.indexOf('Page 1 of ') !== -1, 'footer carries the page number');
    assert(fullText.indexOf('8 August 2026') !== -1, 'footer carries the generation date');
    assert(fullText.toLowerCase().indexOf('computed deterministically') !== -1,
      'footer carries the provenance line');
    assert(fullText.indexOf('What to do next') !== -1, 'ranked actions section is rendered');
    assert(fullText.indexOf('Coach notes') !== -1, 'coach notes section is rendered');
    done(before);
  }

  // -------------------------------------------------------------------------
  section('Numbers are printed byte-identically to the stats object');
  {
    const before = failures.length;
    const m = GOLDEN_STATS.metrics;
    Object.keys(m).forEach((k) => {
      if (!m[k]) return;
      const cells = PDF.metricRowCells(k, m[k]);
      eq(cells.mean, String(m[k].mean), `${k}.mean is printed as String(value), never re-rounded`);
      eq(cells.latest, String(m[k].latest), `${k}.latest is printed as String(value)`);
      eq(cells.n, String(m[k].n), `${k}.n is printed as String(value)`);
      assert(fullText.indexOf(String(m[k].mean)) !== -1, `${k}.mean (${m[k].mean}) appears verbatim in the PDF`);
    });
    // The rendered document must not contain a re-rounded variant of a fact.
    const cov = GOLDEN_STATS.coverage;
    if (String(cov.completenessPct).indexOf('.') !== -1) {
      const truncated = String(cov.completenessPct).split('.')[0];
      assert(fullText.indexOf(`${truncated}%`) === -1 || fullText.indexOf(`${cov.completenessPct}%`) !== -1,
        're-rounded coverage is never printed in place of the exact figure');
    }
    done(before);
  }

  // -------------------------------------------------------------------------
  section('Stats-only payload (no report, no validation) still renders');
  {
    const before = failures.length;
    const p = outPath('stats-only.pdf');
    const res = await PDF.buildWhoopReportPdf({
      member: { name: 'No Narrative' },
      stats: GOLDEN_STATS,
      generatedAt: '2026-08-08T09:30:00.000Z'
    }, p, { compress: false });

    eq(res.ok, true, 'stats-only render resolves ok:true');
    assert(fs.existsSync(p), 'stats-only PDF exists');
    const buf = fs.readFileSync(p);
    eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'stats-only file begins with %PDF-');
    assert(buf.length > 5000, `stats-only PDF is non-trivial (got ${buf.length} bytes)`);
    assert(res.pages >= 2, `stats-only PDF still has real content (${res.pages} pages)`);

    const text = extractPdfText(buf);
    assert(text.indexOf('Metric summary') !== -1, 'stats-only PDF still has the metric table');
    assert(text.indexOf('Strain vs recovery balance') !== -1, 'stats-only PDF still has the balance section');
    assert(text.indexOf('Figures verified against source data') === -1,
      'no validation object means no verification claim is made');
    assert(text.indexOf('FIGURES NOT VERIFIED') === -1, 'no validation object means no warning banner either');
    assert(text.indexOf('no AI narrative was attached') !== -1, 'the missing narrative is stated, not faked');
    done(before);
  }

  // -------------------------------------------------------------------------
  section('Failed validation is surfaced loudly, with the orphan numbers');
  {
    const before = failures.length;
    const p = outPath('unverified.pdf');
    const res = await PDF.buildWhoopReportPdf({
      member: { name: 'Unverified Member' },
      stats: GOLDEN_STATS,
      report: REPORT,
      validation: VALIDATION_FAILED,
      generatedAt: '2026-08-08T09:30:00.000Z'
    }, p, { compress: false });

    eq(res.ok, true, 'a failed validation still produces a report (it is not suppressed)');
    const buf = fs.readFileSync(p);
    const text = extractPdfText(buf);

    assert(text.indexOf('FIGURES NOT VERIFIED') !== -1, 'the warning banner headline is on the page');
    ORPHANS.forEach((n) => {
      assert(text.indexOf(n) !== -1, `orphan number ${n} is printed in the PDF`);
    });
    assert(text.indexOf('recoveryAnalysis') !== -1, 'the offending field name is printed');
    assert(text.indexOf('Figures verified against source data') === -1,
      'a failing report never also claims to be verified');
    assert(text.indexOf('Recovery slipped in the back half') !== -1,
      'the narrative is still included — surfaced as unverified, not omitted');
    assert(text.indexOf('Recovery improved steadily.') !== -1,
      'the semantic reviewer contradiction is surfaced too');
    done(before);
  }

  // -------------------------------------------------------------------------
  section('A null metric renders as an em-dash — never as 0');
  {
    const before = failures.length;

    // (a) the pure formatter the renderer itself uses
    eq(PDF.fmt(null), PDF.DASH, 'fmt(null) is an em-dash');
    eq(PDF.fmt(undefined), PDF.DASH, 'fmt(undefined) is an em-dash');
    eq(PDF.fmt(0), '0', 'a real 0 is still printed as 0');
    eq(PDF.fmt(NaN), PDF.DASH, 'a non-finite value is an em-dash');
    eq(PDF.fmtUnit(null, '%'), PDF.DASH, 'fmtUnit(null) is a bare em-dash, with no unit tacked on');
    eq(PDF.fmtUnit(33.3, '%'), '33.3%', 'fmtUnit prints the exact value plus its unit');

    // (b) the row builder the metric table draws from
    const nullRow = PDF.metricRowCells('respiratoryRate', null);
    ['mean', 'median', 'min', 'max', 'stdDev', 'latest', 'latestDate', 'n'].forEach((f) => {
      eq(nullRow[f], PDF.DASH, `metricRowCells(null).${f} is an em-dash`);
      assert(nullRow[f] !== '0', `metricRowCells(null).${f} is never 0`);
    });

    // (c) the rendered document, for a stats object with genuinely null figures
    const p = outPath('sparse.pdf');
    const res = await PDF.buildWhoopReportPdf({
      member: { name: 'Sparse Member' },
      stats: SPARSE_STATS,
      generatedAt: '2026-08-08T09:30:00.000Z'
    }, p, { compress: false });
    eq(res.ok, true, 'sparse (null-heavy) stats still render');
    assert(res.pages >= 3, `a 30-day report is a clean multi-page document (got ${res.pages} pages)`);

    const text = extractPdfText(fs.readFileSync(p));
    assert(text.indexOf(WINANSI_EMDASH) !== -1, 'the rendered PDF actually contains em-dashes');
    assert(text.indexOf(`TOTAL DEBT (MIN)${WINANSI_EMDASH}`) !== -1,
      'the null sleep-debt total renders as an em-dash immediately after its label');
    assert(text.indexOf('TOTAL DEBT (MIN)0') === -1, 'the null sleep-debt total is NEVER rendered as 0');
    assert(text.indexOf(`AVG PER NIGHT (MIN)${WINANSI_EMDASH}`) !== -1,
      'the null average nightly debt renders as an em-dash');
    assert(text.indexOf(`WORST DEBT (MIN)${WINANSI_EMDASH}`) !== -1,
      'the null worst-night debt renders as an em-dash');
    assert(text.indexOf('Respiratory rate') === -1,
      'a wholly-null metric is skipped from the summary table rather than shown as zeros');
    assert(text.indexOf('Recovery (%)') !== -1, 'metrics that DO have data are still listed');
    done(before);
  }

  // -------------------------------------------------------------------------
  section('Degenerate payloads never throw');
  {
    const before = failures.length;
    const p = outPath('empty.pdf');
    const res = await PDF.buildWhoopReportPdf({}, p, { compress: false });
    eq(res.ok, true, 'an empty payload still produces a valid PDF');
    const buf = fs.readFileSync(p);
    eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'empty-payload file begins with %PDF-');
    const text = extractPdfText(buf);
    assert(text.indexOf('Member') !== -1, 'a missing member falls back to a placeholder name');
    assert(text.indexOf('0 of 0') === -1, 'missing coverage is not invented as zeros');
    done(before);
  }
}

function cleanup() {
  written.forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
  try { fs.rmdirSync(OUT_DIR); } catch (_) {}
}

run()
  .then(() => {
    cleanup();
    console.log('');
    if (failures.length > 0) {
      console.log('--- FAILURES ---');
      failures.forEach((f) => console.log(' ', f));
      console.log(`\n${failures.length} of ${checks} checks FAILED`);
      process.exit(1);
    }
    console.log(`--- All ${checks} whoop-pdf checks passed ---`);
  })
  .catch((e) => {
    cleanup();
    console.error(e);
    console.log(`\nwhoop-pdf test threw after ${checks} checks (${failures.length} already failing)`);
    process.exit(1);
  });
