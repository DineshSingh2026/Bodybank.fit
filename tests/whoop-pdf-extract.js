/**
 * Unit test: Whoop PDF ingestion (services/wearables/whoopPdfExtract.js).
 * Run: node tests/whoop-pdf-extract.js
 *
 * NO NETWORK. NO DATABASE. The Anthropic call is stubbed by replacing global
 * fetch, so every assertion below is about OUR gates, not the model's:
 *  - a monthly PDF must NEVER become daily rows
 *  - every number must be traceable to the quoted PDF line
 *  - out-of-range and unquoted figures are dropped and reported, not averaged
 */

const {
  extractWhoopPdf,
  classifyUploadBuffer,
  pdfPageCount,
  extractPdfTextLayer,
  sniffWhoopMarkers,
  coerceWhoopPdfExtraction,
  buildCanonicalFromExtraction,
  acceptMetric,
  evidenceSupports,
  coverageMessage,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES
} = require('../services/wearables/whoopPdfExtract');

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

const WHOOP_LINES = [
  'WHOOP Monthly Performance Assessment',
  'Member: Test Member       Period: March 2026',
  'Avg Recovery 62%          Avg Day Strain 13.8',
  'Avg HRV 71 ms             Resting Heart Rate 54 bpm',
  'Average Sleep 7h 32m      Sleep Performance 84%',
  'Respiratory Rate 14.9 rpm Blood Oxygen 96%',
  'Your recovery score trended upward through the month.',
  'Sleep consistency was your weakest area this period.',
  'Compare with February 2026 and January 2026 on the next page.'
];

const NON_WHOOP_LINES = [
  'ACME LOGISTICS LIMITED',
  'Tax Invoice Number INV-2026-0042 dated 11 March 2026',
  'Description Quantity Rate Amount',
  'Pallet handling charges 12 450.00 5400.00',
  'Freight forwarding 3 1200.00 3600.00',
  'Subtotal 9000.00 Tax 18% 1620.00 Total 10620.00',
  'Payment due within thirty days of the invoice date.',
  'Registered office: 14 Harbour Road, please quote the invoice number on payment.',
  'Bank transfer remittances should reference the invoice number shown above.',
  'Goods remain the property of the seller until payment has been received in full.',
  'This document is computer generated and does not require a signature.'
];

const WHOOP_PDF = makePdf(WHOOP_LINES, 3);
const INVOICE_PDF = makePdf(NON_WHOOP_LINES, 2);

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
        { name: 'recovery_score', value: 62, unit: '%', statistic: 'average', evidence: 'Avg Recovery 62%', page: 1 },
        { name: 'hrv', value: 71, unit: 'ms', statistic: 'average', evidence: 'Avg HRV 71 ms', page: 1 },
        { name: 'resting_hr', value: 54, unit: 'bpm', statistic: 'average', evidence: 'Resting Heart Rate 54 bpm', page: 1 }
      ]
    },
    {
      label: 'February 2026',
      granularity: 'monthly',
      start_date: '2026-02-01',
      end_date: '2026-02-28',
      metrics: [
        { name: 'recovery_score', value: 58, unit: '%', statistic: 'average', evidence: 'Feb Avg Recovery 58%', page: 2 }
      ]
    },
    {
      label: 'January 2026',
      granularity: 'monthly',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      metrics: [
        { name: 'recovery_score', value: 55, unit: '%', statistic: 'average', evidence: 'Jan Avg Recovery 55%', page: 2 }
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
// fetch stub
// ---------------------------------------------------------------------------

const realFetch = global.fetch;

/** Replaces global fetch with one that answers every call with `payload`. */
function stubFetch(payload, usage) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
        usage: usage || { input_tokens: 5000, output_tokens: 800 },
        stop_reason: 'end_turn'
      })
    };
  };
  return calls;
}

function restoreFetch() {
  global.fetch = realFetch;
}

// ---------------------------------------------------------------------------

async function run() {
  // Pin the pricing env so the cost assertions are deterministic.
  const savedEnv = {
    key: process.env.ANTHROPIC_API_KEY,
    inr: process.env.AI_COST_USD_TO_INR,
    inUsd: process.env.ANTHROPIC_INPUT_PER_MILLION_USD,
    outUsd: process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD,
    model: process.env.ANTHROPIC_MODEL_WHOOP_PDF,
    modelBlood: process.env.ANTHROPIC_MODEL_BLOOD,
    modelAny: process.env.ANTHROPIC_MODEL
  };
  delete process.env.AI_COST_USD_TO_INR;
  delete process.env.ANTHROPIC_INPUT_PER_MILLION_USD;
  delete process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD;
  delete process.env.ANTHROPIC_MODEL_WHOOP_PDF;
  delete process.env.ANTHROPIC_MODEL_BLOOD;
  delete process.env.ANTHROPIC_MODEL;

  // -------------------------------------------------------------------------
  section('classifyUploadBuffer');

  eq(classifyUploadBuffer(WHOOP_PDF), 'pdf', 'a PDF is classified as pdf');
  eq(
    classifyUploadBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])),
    'zip',
    'a ZIP local-file header is classified as zip'
  );
  eq(
    classifyUploadBuffer(Buffer.from('Cycle start time,Recovery score %\n2026-03-01,62\n', 'utf8')),
    'csv',
    'delimited text is classified as csv'
  );
  eq(
    classifyUploadBuffer(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03, 0x99, 0x00, 0x00])),
    'unknown',
    'binary noise is classified as unknown'
  );
  eq(classifyUploadBuffer(Buffer.alloc(0)), 'unknown', 'an empty buffer is unknown');
  eq(classifyUploadBuffer(null), 'unknown', 'null is unknown, not a throw');
  eq(
    classifyUploadBuffer(Buffer.from('just some prose with no delimiter at all', 'utf8')),
    'unknown',
    'prose with no delimiter is not claimed as csv'
  );
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('PDF inspection (page count, text layer, Whoop sniff)');

  eq(pdfPageCount(WHOOP_PDF), 3, 'page objects are counted, /Type /Pages is not');
  eq(pdfPageCount(Buffer.from('%PDF-1.4\ncompressed object streams only\n%%EOF')), null,
    'an unreadable page tree returns null rather than a guess');

  const layer = extractPdfTextLayer(WHOOP_PDF);
  assert(layer.decidable, 'an uncompressed text layer is decidable');
  assert(layer.text.indexOf('Avg HRV 71 ms') !== -1, 'text literals are recovered verbatim');

  const sniffed = sniffWhoopMarkers(WHOOP_PDF);
  assert(sniffed.decidable, 'the Whoop PDF text layer is decidable');
  assert(sniffed.matched.indexOf('whoop') !== -1, 'the WHOOP marker is found');

  const sniffedInvoice = sniffWhoopMarkers(INVOICE_PDF);
  assert(sniffedInvoice.decidable, 'the invoice text layer is decidable');
  eq(sniffedInvoice.matched.length, 0, 'an invoice matches no Whoop markers');

  const sniffedBlind = sniffWhoopMarkers(Buffer.from('%PDF-1.4\n(hi) Tj\n%%EOF'));
  eq(sniffedBlind.decidable, false, 'too little text means we cannot judge — fail open');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('evidence gate (the traceability guarantee)');

  assert(evidenceSupports(62, 'Avg Recovery 62%'), 'a verbatim figure is supported');
  assert(!evidenceSupports(63, 'Avg Recovery 62%'), 'a figure absent from the quote is NOT supported');
  assert(evidenceSupports(71, 'Avg HRV 71 ms'), 'units around the figure do not matter');
  assert(evidenceSupports(7.53, 'Average Sleep 7h 32m'), '"7h 32m" supports 7.53 hours');
  assert(evidenceSupports(452, 'Average Sleep 7h 32m'), '"7h 32m" supports 452 minutes');
  assert(evidenceSupports(7.53, 'Sleep 7:32'), '"7:32" supports 7.53 hours');
  assert(!evidenceSupports(8.1, 'Average Sleep 7h 32m'), 'a computed duration is not supported');
  assert(evidenceSupports(13.8, 'Avg Day Strain 13.8'), 'a decimal figure is supported');
  assert(!evidenceSupports(1380, 'Avg Day Strain 13.8'), 'a rescaled figure is not supported');

  const okMetric = acceptMetric({ name: 'recovery_score', value: 62, unit: '%', evidence: 'Avg Recovery 62%' }, {});
  eq(okMetric.ok, true, 'a quoted in-range metric is accepted');
  eq(okMetric.field, 'recoveryScore', 'recovery_score maps to recoveryScore');

  eq(acceptMetric({ name: 'chakra_alignment', value: 5, evidence: 'Chakra 5' }, {}).reason, 'unknown_metric',
    'an unrecognised metric name is rejected, not coerced');
  eq(acceptMetric({ name: 'recovery_score', value: 62 }, {}).reason, 'no_evidence',
    'a metric with no quote is rejected');
  eq(acceptMetric({ name: 'recovery_score', value: 62, evidence: 'Avg Recovery 64%' }, {}).reason, 'value_not_in_evidence',
    'a value that is not in its own quote is rejected');
  eq(acceptMetric({ name: 'recovery_score', value: 250, evidence: 'Recovery 250%' }, {}).reason, 'out_of_range',
    'an impossible recovery score is rejected');
  eq(acceptMetric({ name: 'hrv', value: 0, evidence: 'HRV 0 ms' }, {}).reason, 'out_of_range',
    'a zero HRV is rejected rather than stored as a real reading');
  eq(acceptMetric({ name: 'skin_temp', value: 92.3, unit: 'F', evidence: 'Skin Temp 92.3 F' }, {}).field, 'skinTempRaw',
    'a Fahrenheit temperature is stored raw, never converted');
  eq(acceptMetric({ name: 'skin_temp', value: 33.4, unit: '', evidence: 'Skin Temp 33.4' }, {}).reason, 'ambiguous_temperature_unit',
    'a unitless temperature is refused rather than assumed to be Celsius');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('coerceWhoopPdfExtraction');

  eq(coerceWhoopPdfExtraction(null), null, 'null is not an extraction');
  eq(coerceWhoopPdfExtraction({}), null, 'an object with no is_whoop_document is rejected');
  eq(coerceWhoopPdfExtraction('nope'), null, 'a string is rejected');
  const coerced = coerceWhoopPdfExtraction(MONTHLY_PAYLOAD);
  assert(coerced && coerced.isWhoopDocument === true, 'a well-formed payload is accepted');
  eq(coerced.periods.length, 3, 'all three monthly periods survive coercion');
  eq(coerceWhoopPdfExtraction({ is_whoop_document: true, confidence: 'certain' }).confidence, 'low',
    'an unrecognised confidence value falls back to low');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('buildCanonicalFromExtraction — monthly stays monthly');

  const monthly = buildCanonicalFromExtraction(coerceWhoopPdfExtraction(MONTHLY_PAYLOAD), {
    fileName: 'march.pdf',
    pdfText: extractPdfTextLayer(WHOOP_PDF).text,
    textDecidable: true
  });
  eq(monthly.days.length, 0, 'a monthly PDF produces ZERO daily rows');
  eq(monthly.periods.length, 3, 'the three monthly summaries are kept as periods');
  eq(monthly.coverage.granularity, 'monthly', 'coverage is flagged monthly');
  eq(monthly.coverage.aggregatesOnly, true, 'coverage says aggregates only');
  eq(monthly.coverage.dailyRows, 0, 'coverage reports no daily rows');
  eq(monthly.periods[0].metrics.recoveryScore.value, 62, 'the March recovery average is 62');
  eq(monthly.periods[0].metrics.recoveryScore.statistic, 'average', 'the statistic is preserved');
  eq(monthly.periods[0].metrics.recoveryScore.evidenceVerified, true,
    'a quote found in the PDF text layer is marked verified');
  eq(monthly.periods[1].metrics.recoveryScore.evidenceVerified, false,
    'a quote NOT found in the text layer is flagged, not silently trusted');
  assert(monthly.message.indexOf('3 monthly summaries') !== -1, 'the member-facing message names the count');
  assert(monthly.message.indexOf('not daily data') !== -1, 'the message says plainly this is not daily data');
  assert(monthly.message.indexOf('ZIP export') !== -1, 'the message points at the ZIP export');
  eq(monthly.summary.rowsParsed, 5, 'five quoted figures were accepted');
  eq(monthly.summary.rowsRejected, 0, 'nothing was rejected from a clean payload');
  eq(monthly.summary.dateRange.from, '2026-01-01', 'the date range starts at the earliest period');
  eq(monthly.summary.dateRange.to, '2026-03-31', 'the date range ends at the latest period');
  eq(monthly.confidence, 'medium', 'an unverified quote lowers confidence below the model\'s "high"');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('buildCanonicalFromExtraction — genuine daily rows, drops, unknown metrics');

  const daily = buildCanonicalFromExtraction(
    coerceWhoopPdfExtraction({
      is_whoop_document: true,
      document_type: 'health_monitor',
      periods: [],
      daily: [
        {
          date: '2026-03-01',
          metrics: [
            { name: 'recovery_score', value: 61, unit: '%', evidence: '01 Mar Recovery 61%' },
            { name: 'hrv', value: 70, unit: 'ms', evidence: '01 Mar HRV 70 ms' }
          ]
        },
        {
          date: '2026-03-02',
          metrics: [
            { name: 'recovery_score', value: 45, unit: '%', evidence: '02 Mar Recovery 45%' },
            // Not in its own quote — must be dropped, and the day must survive.
            { name: 'hrv', value: 88, unit: 'ms', evidence: '02 Mar HRV 61 ms' },
            // Not a metric we know — must be reported as an unknown column.
            { name: 'Vitality Index', value: 9, evidence: 'Vitality Index 9' }
          ]
        },
        { date: 'not-a-date', metrics: [{ name: 'hrv', value: 70, evidence: 'HRV 70' }] }
      ],
      workouts: [
        {
          date: '2026-03-02',
          activity: 'Running',
          duration_min: 42,
          strain: 12.4,
          energy_kcal: 600,
          evidence: '02 Mar Running 42 min strain 12.4'
        }
      ],
      journal: [
        { date: '2026-03-02', question: 'Alcohol', answer: 'No', evidence: '02 Mar Alcohol No' },
        { date: '2026-03-02', question: '', answer: 'No' }
      ],
      notes: [],
      uncertain: ['One chart label was too small to read'],
      confidence: 'high'
    }),
    { fileName: 'health.pdf', textDecidable: false }
  );

  eq(daily.days.length, 2, 'only the two properly dated days become rows');
  eq(daily.days[0].date, '2026-03-01', 'days are sorted by date');
  eq(daily.days[0].recoveryScore, 61, 'the first day keeps its recovery score');
  eq(daily.days[0].hrvMs, 70, 'the first day keeps its HRV');
  eq(daily.days[0].source, 'whoop', 'day rows carry the whoop source');
  eq(daily.days[1].recoveryScore, 45, 'the second day keeps its quoted recovery score');
  eq(daily.days[1].hrvMs, undefined, 'the unquoted HRV is absent — not zero, not guessed');
  eq(daily.coverage.granularity, 'daily', 'daily-only coverage is flagged daily');
  eq(daily.coverage.aggregatesOnly, false, 'daily coverage is not aggregates-only');
  eq(daily.coverage.evidenceVerifiable, false, 'a compressed PDF reports that quotes could not be cross-checked');
  eq(daily.summary.unknownColumns.length, 1, 'the unrecognised metric is surfaced');
  eq(daily.summary.unknownColumns[0].column, 'Vitality Index', 'the unknown metric keeps its printed label');
  assert(daily.dropped.some((d) => d.reason === 'value_not_in_evidence'), 'the untraceable value is reported as dropped');
  assert(daily.dropped.some((d) => d.reason === 'undated_daily_row'), 'the undated row is reported as dropped');
  assert(daily.dropped.some((d) => d.reason === 'incomplete_journal_row'), 'the question-less journal row is dropped');
  eq(daily.workouts.length, 1, 'the dated workout is kept');
  eq(daily.workouts[0].durationMin, 42, 'a quoted workout duration survives');
  eq(daily.workouts[0].strain, 12.4, 'a quoted workout strain survives');
  eq(daily.workouts[0].energyKcal, null, 'an unquoted workout calorie figure stays null');
  eq(daily.workouts[0].maxHr, null, 'an absent max HR stays null, never 0');
  eq(daily.journal.length, 1, 'only the complete journal row is kept');
  eq(daily.uncertain.length, 1, 'the model\'s uncertainty is carried through, not swallowed');
  eq(daily.confidence, 'medium', 'drops lower the reported confidence');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('smeared-average guard');

  const smearDaily = [];
  for (let d = 1; d <= 8; d += 1) {
    const date = `2026-04-0${d}`;
    smearDaily.push({
      date,
      metrics: [{ name: 'hrv', value: 60, unit: 'ms', evidence: `${date} HRV 60 ms` }]
    });
  }
  const smeared = buildCanonicalFromExtraction(
    coerceWhoopPdfExtraction({
      is_whoop_document: true,
      document_type: 'monthly_performance_assessment',
      periods: [],
      daily: smearDaily,
      workouts: [],
      journal: [],
      notes: [],
      uncertain: [],
      confidence: 'high'
    }),
    { fileName: 'smear.pdf', textDecidable: false }
  );
  eq(smeared.days.length, 0, 'a monthly average smeared across 8 days is stripped, leaving no days');
  assert(
    smeared.summary.notes.some((n) => n.indexOf('consecutive days') !== -1),
    'the strip is explained in the notes rather than done silently'
  );
  eq(smeared.coverage.granularity, 'none', 'nothing usable means granularity none');
  assert(smeared.message.indexOf('could not read any') !== -1, 'the message admits we got nothing');

  const genuine = buildCanonicalFromExtraction(
    coerceWhoopPdfExtraction({
      is_whoop_document: true,
      periods: [],
      daily: [1, 2, 3, 4, 5, 6, 7, 8].map((d) => ({
        date: `2026-04-0${d}`,
        metrics: [{ name: 'hrv', value: 55 + d, unit: 'ms', evidence: `HRV ${55 + d} ms` }]
      })),
      workouts: [],
      journal: [],
      notes: [],
      uncertain: [],
      confidence: 'high'
    }),
    { fileName: 'real.pdf', textDecidable: false }
  );
  eq(genuine.days.length, 8, 'genuinely varying daily values are left alone');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('coverageMessage');

  assert(coverageMessage({ granularity: 'monthly', dailyRows: 0, periods: 1 }).indexOf('1 monthly summary') !== -1,
    'a single period is singular');
  assert(coverageMessage({ granularity: 'weekly', dailyRows: 0, periods: 4 }).indexOf('4 weekly summaries') !== -1,
    'weekly summaries are named as such');
  assert(coverageMessage({ granularity: 'mixed', dailyRows: 2, periods: 1 }).indexOf('2 daily records') !== -1,
    'a mixed document reports both halves');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('extractWhoopPdf — guards (no model call)');

  delete process.env.ANTHROPIC_API_KEY;
  let calls = stubFetch(MONTHLY_PAYLOAD);

  const notPdf = await extractWhoopPdf({ buffer: Buffer.from('date,value\n2026-03-01,62\n'), apiKey: 'k' });
  eq(notPdf.ok, false, 'a CSV is refused by the PDF path');
  eq(notPdf.code, 'NOT_A_PDF', 'the refusal is coded NOT_A_PDF');

  const empty = await extractWhoopPdf({ buffer: Buffer.alloc(0), apiKey: 'k' });
  eq(empty.code, 'PDF_EMPTY', 'an empty upload is coded PDF_EMPTY');

  const big = Buffer.alloc(MAX_PDF_BYTES + 1024);
  big.write('%PDF-1.4\n', 0, 'latin1');
  const tooBig = await extractWhoopPdf({ buffer: big, apiKey: 'k' });
  eq(tooBig.code, 'PDF_TOO_LARGE', 'an oversized PDF is coded PDF_TOO_LARGE');

  const manyPages = await extractWhoopPdf({ buffer: makePdf(WHOOP_LINES, MAX_PDF_PAGES + 1), apiKey: 'k' });
  eq(manyPages.code, 'PDF_TOO_MANY_PAGES', 'a book-length PDF is coded PDF_TOO_MANY_PAGES');
  eq(manyPages.pages, MAX_PDF_PAGES + 1, 'the page count is reported back');

  const noKey = await extractWhoopPdf({ buffer: WHOOP_PDF });
  eq(noKey.code, 'PDF_AI_UNAVAILABLE', 'no API key degrades gracefully with a coded error');
  assert(noKey.message.indexOf('ZIP export') !== -1, 'the no-key message tells the member what to do instead');

  const invoice = await extractWhoopPdf({ buffer: INVOICE_PDF, apiKey: 'k' });
  eq(invoice.code, 'NOT_A_WHOOP_PDF', 'a readable non-Whoop PDF is refused before spending tokens');
  eq(calls.length, 0, 'none of the guard cases called the model');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('extractWhoopPdf — end to end (stubbed model)');

  calls = stubFetch(MONTHLY_PAYLOAD);
  const out = await extractWhoopPdf({ buffer: WHOOP_PDF, apiKey: 'test-key', fileName: 'march.pdf' });

  eq(out.ok, true, 'a Whoop monthly PDF is read successfully');
  eq(calls.length, 1, 'exactly one model call was made');
  eq(calls[0].body.messages[0].content[0].type, 'document', 'the PDF is sent as a document block, media first');
  eq(calls[0].body.messages[0].content[0].source.media_type, 'application/pdf', 'the media type is application/pdf');
  eq(calls[0].body.messages[0].content[1].type, 'text', 'the instruction text follows the media block');
  eq(calls[0].body.model, 'claude-haiku-4-5', 'the default extraction model matches the blood pipeline');

  eq(out.days.length, 0, 'no daily rows are invented from monthly averages');
  eq(out.workouts.length, 0, 'workouts default to an empty array');
  eq(out.journal.length, 0, 'journal defaults to an empty array');
  assert(out.summary && Array.isArray(out.summary.notes), 'the canonical summary shape is present');
  eq(out.summary.filesSeen[0].name, 'march.pdf', 'the file name is recorded in filesSeen');
  eq(out.summary.filesSeen[0].kind, 'pdf', 'filesSeen records the pdf kind');
  eq(out.summary.granularity, 'monthly', 'the summary carries the granularity flag');
  eq(out.coverage.periods, 3, 'coverage counts three periods');
  eq(out.documentType, 'monthly_performance_assessment', 'the document type is reported');
  eq(out.memberName, 'Test Member', 'the member name printed on the report is reported');
  eq(out.pages, 3, 'the page count is reported');
  eq(out.model, 'claude-haiku-4-5', 'the model id is returned for auditing');
  eq(out.usage.input_tokens, 5000, 'input tokens are recorded');
  eq(out.usage.output_tokens, 800, 'output tokens are recorded');
  eq(out.usage.estimated_cost_usd, 0.009, 'haiku pricing: 5000 in + 800 out = $0.009');
  eq(out.usage.estimated_cost_inr, 0.747, 'INR cost uses the 83 default rate');

  const notWhoop = stubFetch({
    is_whoop_document: false,
    document_type: 'other',
    periods: [],
    daily: [],
    workouts: [],
    journal: [],
    notes: ['Looks like a gym membership contract.'],
    uncertain: [],
    confidence: 'high'
  });
  const rejected = await extractWhoopPdf({ buffer: WHOOP_PDF, apiKey: 'test-key' });
  eq(rejected.ok, false, 'the model saying "not Whoop" is honoured');
  eq(rejected.code, 'NOT_A_WHOOP_PDF', 'the refusal is coded NOT_A_WHOOP_PDF');
  assert(rejected.usage && rejected.usage.total_tokens === 5800, 'the cost of a refused read is still reported');
  eq(notWhoop.length, 1, 'the refusal path made exactly one call');

  stubFetch({
    is_whoop_document: true,
    document_type: 'other',
    periods: [],
    daily: [],
    workouts: [],
    journal: [],
    notes: [],
    uncertain: [],
    confidence: 'low'
  });
  const nothing = await extractWhoopPdf({ buffer: WHOOP_PDF, apiKey: 'test-key' });
  eq(nothing.code, 'PDF_NO_DATA', 'a Whoop PDF with no traceable figures is coded PDF_NO_DATA');
  assert(nothing.message.indexOf('ZIP export') !== -1, 'the empty-result message still points at the ZIP export');

  stubFetch('this is not JSON at all');
  const unreadable = await extractWhoopPdf({ buffer: WHOOP_PDF, apiKey: 'test-key' });
  eq(unreadable.code, 'PDF_UNREADABLE', 'a non-JSON model reply is coded PDF_UNREADABLE');

  global.fetch = async () => {
    throw new Error('socket hang up');
  };
  const network = await extractWhoopPdf({ buffer: WHOOP_PDF, apiKey: 'test-key' });
  eq(network.ok, false, 'a transport failure returns a result, never a throw');
  eq(network.code, 'PDF_UNREADABLE', 'a transport failure is coded PDF_UNREADABLE');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  restoreFetch();
  if (savedEnv.key !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv.key;
  if (savedEnv.inr !== undefined) process.env.AI_COST_USD_TO_INR = savedEnv.inr;
  if (savedEnv.inUsd !== undefined) process.env.ANTHROPIC_INPUT_PER_MILLION_USD = savedEnv.inUsd;
  if (savedEnv.outUsd !== undefined) process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD = savedEnv.outUsd;
  if (savedEnv.model !== undefined) process.env.ANTHROPIC_MODEL_WHOOP_PDF = savedEnv.model;
  if (savedEnv.modelBlood !== undefined) process.env.ANTHROPIC_MODEL_BLOOD = savedEnv.modelBlood;
  if (savedEnv.modelAny !== undefined) process.env.ANTHROPIC_MODEL = savedEnv.modelAny;

  console.log('');
  if (failures.length > 0) {
    console.log('--- FAILURES ---');
    failures.forEach((f) => console.log(' ', f));
    console.log(`\n${failures.length} of ${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`--- All ${checks} whoop-pdf-extract checks passed ---`);
}

run().catch((e) => {
  restoreFetch();
  console.error(e);
  process.exit(1);
});
