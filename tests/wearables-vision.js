/**
 * Unit test: universal vision extraction (services/wearables/deviceVisionExtract.js).
 * Run: node tests/wearables-vision.js
 *
 * NO NETWORK. NO DATABASE. NO SERVER. global.fetch is replaced with a thrower for
 * the whole run, so any accidental real call fails the suite loudly; the model is
 * supplied through the module's injectable `opts.client`.
 *
 * Every assertion below is about OUR gates, not the model's:
 *  - a number the model did not quote is never kept
 *  - an implausible number is reported, never clamped and never saved
 *  - a brand's proprietary score never reaches a canonical field
 *  - a day with no printed date is rejected, never guessed
 *  - "I could not read this" is honoured by nulling the field
 *  - every produced day is marked as read-from-an-image and trusted less
 */

const vision = require('../services/wearables/deviceVisionExtract');
const canonicalDay = require('../services/wearables/canonicalDay');

const {
  extract,
  classifyVisionBuffer,
  devicePromptFragment,
  coerceVisionExtraction,
  acceptVisionField,
  acceptProviderScore,
  evidenceSupports,
  resolveHrvMethod,
  resolveSource,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_VISION_CONFIDENCE,
  FILE_PARSE_CONFIDENCE,
  CONFIDENCE
} = vision;

const { validateParsedExport, MEASUREMENT_SOURCE, HRV_METHOD } = canonicalDay;

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
// Fixtures — buffers built from real magic bytes, never from file extensions
// ---------------------------------------------------------------------------

function pad(head, total) {
  const buf = Buffer.alloc(Math.max(total, head.length));
  Buffer.from(head).copy(buf, 0);
  return buf;
}

const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 512);
const PNG_TRUNCATED = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 512);

const WEBP = (() => {
  const b = Buffer.alloc(512);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(504, 4);
  b.write('WEBPVP8 ', 8, 'latin1');
  return b;
})();

const GIF = (() => {
  const b = Buffer.alloc(256);
  b.write('GIF89a', 0, 'latin1');
  return b;
})();

const HEIC = (() => {
  const b = Buffer.alloc(256);
  b.writeUInt32BE(24, 0);
  b.write('ftypheic', 4, 'latin1');
  return b;
})();

const TEXT_FILE = Buffer.from('Cycle start time,Recovery score %\n2026-03-01,62\n', 'utf8');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
const BINARY_NOISE = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03, 0x99, 0x00, 0x00]);

/** A minimal, uncompressed PDF whose text sits in plain `(...) Tj` literals. */
function makePdf(lines, pageCount) {
  const pages = pageCount || 1;
  const body = lines.map((l) => `BT /F1 12 Tf 72 700 Td (${l}) Tj ET`).join('\n');
  let out = '%PDF-1.4\n';
  out += '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n';
  out += `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n`;
  for (let i = 0; i < pages; i += 1) out += `${3 + i} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`;
  out += `${3 + pages} 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj\n`;
  out += 'trailer << /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

const WHOOP_PDF = makePdf([
  'WHOOP Monthly Performance Assessment',
  'Member: Test Member       Period: March 2026',
  'Avg Recovery 62%          Avg Day Strain 13.8',
  'Avg HRV 71 ms             Resting Heart Rate 54 bpm',
  'Average Sleep 7h 32m      Sleep Performance 84%',
  'Respiratory Rate 14.9 rpm Blood Oxygen 96%',
  'Your recovery score trended upward through the month.',
  'Sleep consistency was your weakest area this period.'
], 2);

const NOISE_PDF = makePdf([
  'NoiseFit Weekly Wellness Report',
  'Generated for the week of 09 March 2026',
  'Sleep 7h 12m   Sleep Score 82',
  'Resting Heart Rate 58 bpm   SpO2 96%'
], 1);

// ---------------------------------------------------------------------------
// Model payloads (all stubbed — nothing here ever leaves the process)
// ---------------------------------------------------------------------------

const NOISE_OK = {
  is_expected_device: true,
  app_seen: 'NoiseFit',
  device_model: 'Noise ColorFit Pro 5',
  screens: [
    { index: 0, screen_type: 'sleep', printed_date: '12 Mar 2026' },
    { index: 1, screen_type: 'home', printed_date: '13 Mar 2026' }
  ],
  days: [
    {
      date: '2026-03-12',
      date_evidence: '12 Mar 2026',
      fields: [
        { name: 'sleep_minutes', value: 432, unit: 'min', readable: 'confident', evidence: 'Sleep 7h 12m', screen_index: 0 },
        { name: 'deep_min', value: 96, unit: 'min', readable: 'confident', evidence: 'Deep 1h 36m', screen_index: 0 },
        { name: 'light_min', value: 250, unit: 'min', readable: 'confident', evidence: 'Light 250 min', screen_index: 0 },
        { name: 'resting_hr', value: 58, unit: 'bpm', readable: 'confident', evidence: 'Resting 58 bpm', screen_index: 0 },
        { name: 'spo2', value: 96, unit: '%', readable: 'confident', evidence: 'SpO2 96%', screen_index: 0 },
        { name: 'steps', value: 8421, unit: 'steps', readable: 'confident', evidence: 'Steps 8,421', screen_index: 1 },
        { name: 'hrv', value: 41, unit: 'ms', readable: 'confident', evidence: 'HRV 41 ms', screen_index: 0 }
      ],
      provider_scores: [
        { key: 'sleep_score', value: 82, readable: 'confident', evidence: 'Sleep Score 82' }
      ]
    },
    {
      date: '2026-03-13',
      date_evidence: '13 Mar 2026',
      fields: [
        { name: 'steps', value: 11240, unit: 'steps', readable: 'confident', evidence: 'Steps 11,240', screen_index: 1 },
        { name: 'calories', value: 2180, unit: 'kcal', readable: 'confident', evidence: 'Calories 2180 kcal', screen_index: 1 }
      ],
      provider_scores: []
    }
  ],
  workouts: [],
  undated: [],
  unreadable: [],
  notes: [],
  confidence: 'high'
};

/** The stub client. Mirrors the Anthropic /v1/messages response shape exactly. */
function stubClient(payload, usage) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return {
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      usage: usage || { input_tokens: 4200, output_tokens: 900 },
      stop_reason: 'end_turn'
    };
  };
  fn.calls = calls;
  return fn;
}

/** Deep-clone so a mutation in one case never leaks into the next. */
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function images(n, buf) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ buffer: buf || PNG, fileName: `screen_${i + 1}.png` });
  return out;
}

// ---------------------------------------------------------------------------

const realFetch = global.fetch;

/** Any real network call anywhere in this suite must fail loudly. */
function forbidNetwork() {
  global.fetch = async () => {
    throw new Error('NETWORK CALL ATTEMPTED IN TESTS');
  };
}

/** Only the Whoop-delegation case swaps this in, to stub the legacy PDF path. */
function stubWhoopFetch(payload) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 3000, output_tokens: 400 },
        stop_reason: 'end_turn'
      })
    };
  };
  return calls;
}

async function run() {
  const savedEnv = {
    key: process.env.ANTHROPIC_API_KEY,
    inr: process.env.AI_COST_USD_TO_INR,
    inUsd: process.env.ANTHROPIC_INPUT_PER_MILLION_USD,
    outUsd: process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD,
    mVision: process.env.ANTHROPIC_MODEL_DEVICE_VISION,
    mPdf: process.env.ANTHROPIC_MODEL_WHOOP_PDF,
    mBlood: process.env.ANTHROPIC_MODEL_BLOOD,
    mAny: process.env.ANTHROPIC_MODEL
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_COST_USD_TO_INR;
  delete process.env.ANTHROPIC_INPUT_PER_MILLION_USD;
  delete process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD;
  delete process.env.ANTHROPIC_MODEL_DEVICE_VISION;
  delete process.env.ANTHROPIC_MODEL_WHOOP_PDF;
  delete process.env.ANTHROPIC_MODEL_BLOOD;
  delete process.env.ANTHROPIC_MODEL;
  forbidNetwork();

  // -------------------------------------------------------------------------
  section('magic-byte detection (the type comes from the bytes, never the name)');

  eq(classifyVisionBuffer(PNG), 'png', 'a PNG signature is detected');
  eq(classifyVisionBuffer(JPEG), 'jpeg', 'a JPEG SOI marker is detected');
  eq(classifyVisionBuffer(WEBP), 'webp', 'RIFF....WEBP is detected');
  eq(classifyVisionBuffer(GIF), 'gif', 'GIF89a is detected');
  eq(classifyVisionBuffer(HEIC), 'heic', 'an iPhone HEIC brand is detected so we can explain it');
  eq(classifyVisionBuffer(WHOOP_PDF), 'pdf', 'a PDF is detected');
  eq(classifyVisionBuffer(ZIP), 'zip', 'a ZIP local-file header is detected');
  eq(classifyVisionBuffer(TEXT_FILE), 'text', 'a CSV is text, never an image');
  eq(classifyVisionBuffer(PNG_TRUNCATED), 'unknown', 'a 4-byte truncated PNG is NOT claimed as a PNG');
  eq(classifyVisionBuffer(BINARY_NOISE), 'unknown', 'binary noise is unknown');
  eq(classifyVisionBuffer(Buffer.alloc(0)), 'unknown', 'an empty buffer is unknown');
  eq(classifyVisionBuffer(null), 'unknown', 'null is unknown, not a throw');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('per-device prompt fragments');

  const noiseFrag = devicePromptFragment('noise');
  eq(noiseFrag.known, true, 'noise is a known device');
  eq(noiseFrag.app, 'NoiseFit', 'the Noise fragment names the real app');
  assert(noiseFrag.hint.indexOf('NoiseFit') !== -1, 'the Noise hint describes NoiseFit screens');
  assert(noiseFrag.proprietary.indexOf('sleep_score') !== -1, 'Noise sleep_score is declared proprietary');

  const garminFrag = devicePromptFragment('Garmin Connect');
  eq(garminFrag.id, 'garmin', 'a spaced, capitalised device name normalises');
  assert(garminFrag.hint.indexOf('Body Battery') !== -1, 'the Garmin hint warns about Body Battery');
  assert(devicePromptFragment('boAt').id === 'boat', 'boAt normalises to boat');
  assert(devicePromptFragment('Fire-Boltt').id === 'fire_boltt', 'Fire-Boltt normalises to fire_boltt');
  assert(devicePromptFragment('apple watch').id === 'apple_health', 'apple watch maps to apple_health');

  const unknownFrag = devicePromptFragment('some_no_name_band');
  eq(unknownFrag.known, false, 'an unlisted brand falls back');
  assert(unknownFrag.hint.length > 40, 'the generic fallback still carries a usable hint');
  eq(unknownFrag.ns, 'some_no_name_band', 'the fallback still gets its own providerScores namespace');
  const sys = vision.buildSystemPrompt(noiseFrag);
  assert(sys.indexOf('TRANSCRIBER, not an analyst') !== -1, 'the system prompt forbids analysis');
  assert(sys.indexOf('NEVER compute') !== -1, 'the system prompt forbids computing a number');
  assert(sys.indexOf('provider_scores') !== -1, 'the system prompt routes brand scores to provider_scores');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('rule 6 — hrvMethod is declared, never guessed');

  eq(resolveHrvMethod('noise', {}), HRV_METHOD.UNKNOWN,
    'an unlisted band\'s HRV method is unknown, NOT assumed to be rmssd_sleep');
  eq(resolveHrvMethod('apple_health', {}), HRV_METHOD.SDNN_SPOT, 'Apple declares SDNN spot');
  eq(resolveHrvMethod('whoop', {}), HRV_METHOD.RMSSD_SLEEP, 'Whoop declares overnight RMSSD');
  eq(resolveHrvMethod('noise', { hrvMethod: HRV_METHOD.RMSSD_SPOT }), HRV_METHOD.RMSSD_SPOT,
    'an explicit declaration wins');
  eq(resolveHrvMethod('noise', { hrvMethod: 'made_up' }), HRV_METHOD.UNKNOWN,
    'an invalid declaration is refused, not passed through');
  eq(resolveSource({}), 'screenshot', 'vision days default to the screenshot source');
  eq(resolveSource({ source: 'garmin' }), 'garmin', 'an explicit canonical provider is honoured');
  eq(resolveSource({ source: 'not_a_provider' }), 'screenshot', 'an unknown provider falls back to screenshot');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('evidence gate + field acceptance');

  assert(evidenceSupports(58, 'Resting 58 bpm'), 'a verbatim figure is supported');
  assert(!evidenceSupports(59, 'Resting 58 bpm'), 'a figure absent from the quote is NOT supported');
  assert(evidenceSupports(432, 'Sleep 7h 12m'), '"7h 12m" supports 432 minutes');
  assert(evidenceSupports(7.2, 'Sleep 7h 12m'), '"7h 12m" supports 7.2 hours');
  assert(evidenceSupports(8421, 'Steps 8,421'), 'a thousands separator does not hide the figure');
  assert(!evidenceSupports(346, 'Deep 96 min Light 250 min'), 'a sum the model computed is not supported');

  const ok = acceptVisionField({ name: 'resting_hr', value: 58, unit: 'bpm', readable: 'confident', evidence: 'Resting 58 bpm' }, {});
  eq(ok.ok, true, 'a quoted, flagged, in-range field is accepted');
  eq(ok.field, 'restingHr', 'resting_hr maps to restingHr');

  eq(acceptVisionField({ name: 'resting_hr', value: 58, evidence: 'Resting 58 bpm' }, {}).reason, 'bad_readable_flag',
    'a field with no readable flag is rejected, not defaulted');
  eq(acceptVisionField({ name: 'resting_hr', value: 58, readable: 'probably', evidence: 'Resting 58 bpm' }, {}).reason, 'bad_readable_flag',
    'a readable flag outside the enum is rejected, not coerced');
  eq(acceptVisionField({ name: 'resting_hr', value: '58', readable: 'confident', evidence: 'Resting 58 bpm' }, {}).reason, 'non_numeric_value',
    'a stringified number is rejected — the contract says JSON number');
  eq(acceptVisionField({ name: 'resting_hr', value: 58, readable: 'confident' }, {}).reason, 'no_evidence',
    'a field with no on-screen quote is rejected');
  eq(acceptVisionField({ name: 'resting_hr', value: 58, readable: 'confident', evidence: 'Resting 61 bpm' }, {}).reason, 'value_not_in_evidence',
    'a value that is not in its own quote is rejected');
  eq(acceptVisionField({ name: 'chakra_index', value: 5, readable: 'confident', evidence: 'Chakra 5' }, {}).reason, 'unknown_field',
    'an unrecognised label is rejected, never coerced onto a canonical field');
  eq(acceptVisionField({ name: 'hrv', value: 9000, readable: 'confident', evidence: 'HRV 9000 ms' }, {}).reason, 'implausible',
    'an impossible HRV is flagged implausible, not clamped');
  eq(acceptVisionField({ name: 'skin_temp', value: 33.4, unit: '', readable: 'confident', evidence: 'Temp 33.4' }, {}).reason, 'ambiguous_temperature_unit',
    'a unitless temperature is refused rather than assumed Celsius');
  eq(acceptVisionField({ name: 'skin_temp', value: 92.3, unit: 'F', readable: 'confident', evidence: 'Temp 92.3 F' }, {}).field, 'skinTempRaw',
    'a Fahrenheit temperature is stored raw, NEVER converted');
  eq(acceptVisionField({ name: 'skin_temp_deviation', value: -0.3, unit: 'C', readable: 'confident', evidence: 'Temp -0.3 C' }, {}).extra.tempBasis,
    'deviation_c', 'a deviation carries the deviation basis, never the absolute one');

  const ps = acceptProviderScore({ key: 'sleep_score', value: 82, readable: 'confident', evidence: 'Sleep Score 82' }, 'noise', {});
  eq(ps.ok, true, 'a quoted provider score is accepted');
  eq(ps.key, 'noise.sleep_score', 'the provider score key is namespaced to the brand');
  eq(acceptProviderScore({ key: 'sleep_score', value: 82, readable: 'unreadable' }, 'noise', {}).reason, 'unreadable',
    'an unreadable provider score is dropped, not guessed');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('strict schema validation of the model response');

  eq(coerceVisionExtraction(null), null, 'null is not an extraction');
  eq(coerceVisionExtraction('nope'), null, 'a string is rejected');
  eq(coerceVisionExtraction([]), null, 'an array is rejected');
  eq(coerceVisionExtraction({ days: [] }), null, 'a missing is_expected_device is rejected');
  eq(coerceVisionExtraction({ is_expected_device: 'yes', days: [] }), null, 'a non-boolean is_expected_device is rejected');
  eq(coerceVisionExtraction({ is_expected_device: true }), null, 'a missing days array is rejected');
  eq(coerceVisionExtraction({ is_expected_device: true, days: 'lots' }), null, 'a non-array days is rejected, not coerced');
  eq(coerceVisionExtraction({ is_expected_device: true, days: [], workouts: {} }), null, 'a non-array workouts is rejected');
  const coerced = coerceVisionExtraction(clone(NOISE_OK));
  assert(coerced && coerced.isExpectedDevice === true, 'a well-formed payload is accepted');
  eq(coerced.days.length, 2, 'both days survive coercion');
  eq(coerceVisionExtraction({ is_expected_device: true, days: [], confidence: 'certain' }).confidence, 'low',
    'an unrecognised confidence value falls back to low');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('guards — each cap has its OWN typed code (no model call)');

  const guardClient = stubClient(clone(NOISE_OK));

  const noDevice = await extract(images(1), { client: guardClient });
  eq(noDevice.ok, false, 'an undeclared device is refused');
  eq(noDevice.code, 'DEVICE_NOT_SPECIFIED', 'the refusal is coded DEVICE_NOT_SPECIFIED');

  eq((await extract([], { deviceId: 'noise', client: guardClient })).code, 'UPLOAD_EMPTY',
    'an empty upload is coded UPLOAD_EMPTY');
  eq((await extract([{ buffer: Buffer.alloc(0), fileName: 'a.png' }], { deviceId: 'noise', client: guardClient })).code, 'UPLOAD_EMPTY',
    'a zero-length file is coded UPLOAD_EMPTY');
  eq((await extract(TEXT_FILE, { deviceId: 'noise', client: guardClient })).code, 'NOT_AN_IMAGE',
    'a CSV is coded NOT_AN_IMAGE');
  eq((await extract(ZIP, { deviceId: 'noise', client: guardClient })).code, 'NOT_AN_IMAGE',
    'a ZIP is coded NOT_AN_IMAGE');
  eq((await extract(PNG_TRUNCATED, { deviceId: 'noise', client: guardClient })).code, 'NOT_AN_IMAGE',
    'a truncated PNG is coded NOT_AN_IMAGE, never read as a PNG');

  const heic = await extract(HEIC, { deviceId: 'noise', client: guardClient });
  eq(heic.code, 'UNSUPPORTED_IMAGE_FORMAT', 'HEIC gets its OWN code, not NOT_AN_IMAGE');
  assert(heic.message.indexOf('Most Compatible') !== -1, 'the HEIC message tells the member how to fix it');

  const tooMany = await extract(images(MAX_IMAGES + 1), { deviceId: 'noise', client: guardClient });
  eq(tooMany.code, 'TOO_MANY_IMAGES', 'the count cap has its own code');
  eq(tooMany.imageCount, MAX_IMAGES + 1, 'the count is reported back');

  const bigOne = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], MAX_IMAGE_BYTES + 1024);
  eq((await extract([{ buffer: bigOne, fileName: 'huge.png' }], { deviceId: 'noise', client: guardClient })).code,
    'IMAGE_TOO_LARGE', 'the per-image cap has its own code');

  const atCap = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], MAX_IMAGE_BYTES);
  const totalBatch = [
    { buffer: atCap, fileName: 'a.png' },
    { buffer: atCap, fileName: 'b.png' },
    { buffer: atCap, fileName: 'c.png' }
  ];
  assert(atCap.length * 3 > MAX_TOTAL_IMAGE_BYTES, 'the total-cap fixture really does exceed the total cap');
  eq((await extract(totalBatch, { deviceId: 'noise', client: guardClient })).code, 'IMAGES_TOTAL_TOO_LARGE',
    'the total-bytes cap has its own code, distinct from the per-image one');

  eq((await extract([{ buffer: NOISE_PDF, fileName: 'r.pdf' }, { buffer: PNG, fileName: 'a.png' }],
    { deviceId: 'noise', client: guardClient })).code, 'MIXED_UPLOAD_TYPES',
  'a PDF mixed with screenshots is refused with its own code');

  const noAi = await extract(images(1), { deviceId: 'noise' });
  eq(noAi.code, 'VISION_AI_UNAVAILABLE',
    'no API key degrades gracefully — NOT reported as a malformed file');
  assert(noAi.message.indexOf('manually') !== -1, 'the no-key message tells the member what to do instead');
  eq((await extract(images(1), { deviceId: 'noise', client: { nope: true } })).code, 'VISION_CLIENT_INVALID',
    'an uncallable injected client gets its own code');

  eq(guardClient.calls.length, 0, 'NOT ONE of the guard cases called the model');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('happy path — a well-formed model response produces contract-valid days');

  const okClient = stubClient(clone(NOISE_OK));
  const out = await extract(images(2), { deviceId: 'noise', client: okClient, apiKey: 'unused-when-stubbed' });

  eq(out.ok, true, 'two NoiseFit screenshots are read successfully');
  eq(okClient.calls.length, 1, 'exactly one model call was made');
  eq(okClient.calls[0].model, 'claude-haiku-4-5', 'the default model matches the codebase convention');
  eq(okClient.calls[0].messages[0].content[0].type, 'image', 'the images are sent first, as image blocks');
  eq(okClient.calls[0].messages[0].content[0].source.media_type, 'image/png', 'the media type comes from the magic bytes');
  eq(okClient.calls[0].messages[0].content[1].type, 'image', 'both screenshots are sent');
  eq(okClient.calls[0].messages[0].content[2].type, 'text', 'the instruction follows the media blocks');
  assert(okClient.calls[0].system.indexOf('NoiseFit') !== -1, 'the per-device prompt was actually used');

  const contract = validateParsedExport({
    days: out.days,
    workouts: out.workouts,
    journal: out.journal,
    summary: out.summary,
    rejected: out.rejected
  });
  assert(contract.ok, `the result satisfies validateParsedExport — ${contract.errors.join('; ')}`);
  eq(contract.dayCount, 2, 'two canonical days were produced');
  eq(out.days[0].date, '2026-03-12', 'days are sorted ascending');
  eq(out.days[0].sleepMinutes, 432, 'the quoted sleep total survives');
  eq(out.days[0].restingHr, 58, 'the quoted resting HR survives');
  eq(out.days[0].spo2, 96, 'the quoted SpO2 survives');
  eq(out.days[0].steps, 8421, 'a thousands-separated step count survives');
  eq(out.days[0].hrvMs, 41, 'the quoted HRV survives');
  eq(out.days[0].hrvMethod, HRV_METHOD.UNKNOWN, 'an unlisted band\'s HRV is tagged unknown, never rmssd_sleep');
  eq(out.days[0].sleepHours, null, 'sleep hours were never derived from sleep minutes — that would be computing');
  eq(out.days[1].energyKcal, 2180, 'the second day keeps its calories');
  eq(out.days[1].restingHr, null, 'a metric absent on a day stays null, never 0');
  eq(out.summary.rowsParsed, 10, 'ten quoted figures were accepted');
  eq(out.summary.dateRange.from, '2026-03-12', 'the date range starts at the first day');
  eq(out.summary.dateRange.to, '2026-03-13', 'the date range ends at the last day');
  eq(out.deviceModel, 'Noise ColorFit Pro 5', 'the on-screen device model is carried through');
  eq(out.usage.input_tokens, 4200, 'input tokens are exposed for the ledger');
  eq(out.usage.output_tokens, 900, 'output tokens are exposed for the ledger');
  eq(out.usage.total_tokens, 5100, 'the ledger gets a total');
  eq(out.usage.estimated_cost_usd, 0.0087, 'haiku pricing: 4200 in + 900 out = $0.0087');
  eq(out.model, 'claude-haiku-4-5', 'the model id is returned for auditing');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('the honesty requirement — provenance, confidence, the plain sentence');

  out.days.forEach((d, i) => {
    eq(d.measurementSource, MEASUREMENT_SOURCE.VISION, `day ${i} is marked measurementSource=vision`);
    eq(d.source, 'screenshot', `day ${i} uses the screenshot source, so it can never overwrite a real export`);
    assert(d.confidence < FILE_PARSE_CONFIDENCE, `day ${i} confidence ${d.confidence} is below the file-parse tier`);
    assert(d.confidence <= MAX_VISION_CONFIDENCE, `day ${i} confidence ${d.confidence} respects the vision ceiling`);
  });
  eq(out.days[0].confidence, CONFIDENCE.VISION_SCREENSHOT, 'a clean screenshot read lands on the screenshot tier');
  assert(MAX_VISION_CONFIDENCE < FILE_PARSE_CONFIDENCE, 'the vision ceiling is materially below a parsed file');

  const note0 = out.summary.notes[0];
  assert(note0.indexOf('read by AI') !== -1, 'the first note says plainly that AI read these');
  assert(note0.indexOf('not from a data file') !== -1, 'the first note distinguishes this from a data file');
  assert(note0.indexOf('confirm every number') !== -1, 'the first note asks the member to confirm');
  eq(out.summary.reviewRequired, true, 'the summary flags that this needs review');
  eq(out.summary.measurementSource, MEASUREMENT_SOURCE.VISION, 'the summary carries the provenance too');
  assert(Array.isArray(out.review) && out.review.length === 2, 'a review row exists per day');
  eq(out.review[0].date, '2026-03-12', 'review rows are keyed by date');
  assert(out.review[0].confident.indexOf('restingHr') !== -1, 'confidently-read fields are listed for the confirm screen');
  assert(out.review[0].providerScores.indexOf('noise.sleep_score') !== -1, 'brand scores are listed separately for review');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('rule 6 — a proprietary score NEVER reaches a canonical field');

  eq(out.days[0].providerScores['noise.sleep_score'], 82, 'the NoiseFit sleep score is kept, namespaced');
  eq(out.days[0].sleepPerformancePct, null, 'the sleep score did NOT become sleep performance');
  eq(out.days[0].sleepEfficiencyPct, null, 'the sleep score did NOT become sleep efficiency');
  eq(out.days[0].recoveryScore, null, 'the sleep score did NOT become a recovery score');
  eq(out.days[0].readinessScore, null, 'the sleep score did NOT become a readiness score');

  // The harder case: the model files a brand composite under `fields`, where a
  // naive alias table would map it onto something canonical.
  const garminPayload = {
    is_expected_device: true,
    app_seen: 'Garmin Connect',
    device_model: null,
    screens: [],
    days: [{
      date: '2026-03-14',
      date_evidence: 'Mar 14',
      fields: [
        { name: 'body_battery', value: 62, readable: 'confident', evidence: 'Body Battery 62' },
        { name: 'sleep_score', value: 79, readable: 'confident', evidence: 'Sleep Score 79' },
        { name: 'resting_hr', value: 51, unit: 'bpm', readable: 'confident', evidence: 'Resting Heart Rate 51 bpm' }
      ],
      provider_scores: []
    }],
    workouts: [],
    undated: [],
    unreadable: [],
    notes: [],
    confidence: 'high'
  };
  const garminClient = stubClient(garminPayload);
  const g = await extract(images(1), { deviceId: 'garmin', client: garminClient });
  eq(g.ok, true, 'the Garmin read succeeds');
  const gd = g.days[0];
  eq(gd.providerScores['garmin.body_battery'], 62, 'Body Battery filed under `fields` is REROUTED to providerScores');
  eq(gd.providerScores['garmin.sleep_score'], 79, 'the Garmin sleep score is rerouted too');
  eq(gd.recoveryScore, null, 'Body Battery did NOT become a recovery score');
  eq(gd.readinessScore, null, 'Body Battery did NOT become a readiness score');
  eq(gd.restingHr, 51, 'the genuine measurement on the same screen still lands canonically');
  assert(validateParsedExport({ days: g.days, workouts: g.workouts, journal: g.journal, summary: g.summary, rejected: g.rejected }).ok,
    'the Garmin result is contract-valid');
  assert(g.dropped.some((d) => d.reason === 'proprietary_score_rerouted'), 'the reroute is reported, not silent');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('implausible values are nulled into summary.implausible, never persisted');

  const madPayload = clone(NOISE_OK);
  madPayload.days = [{
    date: '2026-03-12',
    date_evidence: '12 Mar 2026',
    fields: [
      { name: 'hrv', value: 9000, unit: 'ms', readable: 'confident', evidence: 'HRV 9000 ms' },
      { name: 'spo2', value: 140, unit: '%', readable: 'confident', evidence: 'SpO2 140%' },
      { name: 'resting_hr', value: 58, unit: 'bpm', readable: 'confident', evidence: 'Resting 58 bpm' }
    ],
    provider_scores: []
  }];
  const mad = await extract(images(1), { deviceId: 'noise', client: stubClient(madPayload) });
  eq(mad.ok, true, 'the day survives — one bad reading does not discard the good ones');
  eq(mad.days[0].hrvMs, null, 'an HRV of 9000ms is NOT persisted');
  eq(mad.days[0].spo2, null, 'an SpO2 of 140% is NOT persisted');
  eq(mad.days[0].hrvMethod, null, 'with no HRV there is no HRV method to declare');
  eq(mad.days[0].restingHr, 58, 'the plausible reading on the same day survives');
  eq(mad.summary.implausible.length, 2, 'both impossible values are reported');
  assert(mad.summary.implausible.some((x) => x.field === 'hrvMs' && x.value === 9000),
    'the implausible HRV is reported with its original value, not clamped to 400');
  assert(mad.summary.implausible.some((x) => x.field === 'spo2' && x.value === 140),
    'the implausible SpO2 is reported with its original value');
  assert(mad.summary.notes.some((n) => n.indexOf('plausible range') !== -1),
    'the removal is explained in the notes rather than done silently');
  assert(validateParsedExport({ days: mad.days, workouts: mad.workouts, journal: mad.journal, summary: mad.summary, rejected: mad.rejected }).ok,
    'the sanitised result is still contract-valid');
  assert(mad.days[0].confidence <= CONFIDENCE.VISION_DEGRADED, 'a day with dropped fields is trusted less');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('"I could not read this" is honoured, not guessed around');

  const unreadablePayload = clone(NOISE_OK);
  unreadablePayload.days = [{
    date: '2026-03-12',
    date_evidence: '12 Mar 2026',
    fields: [
      { name: 'hrv', value: 41, unit: 'ms', readable: 'unreadable', evidence: 'HRV 41 ms' },
      { name: 'spo2', value: 96, unit: '%', readable: 'low_confidence', evidence: 'SpO2 96%' },
      { name: 'resting_hr', value: 58, unit: 'bpm', readable: 'confident', evidence: 'Resting 58 bpm' }
    ],
    provider_scores: []
  }];
  const unread = await extract(images(1), { deviceId: 'noise', client: stubClient(unreadablePayload) });
  eq(unread.ok, true, 'the day survives');
  eq(unread.days[0].hrvMs, null, 'a field flagged unreadable is NULLED, even though a number was supplied');
  eq(unread.days[0].restingHr, 58, 'the confidently-read field survives');
  eq(unread.days[0].spo2, 96, 'a low-confidence field is kept but flagged for the member to confirm');
  assert(unread.review[0].flagged.some((f) => f.field === 'spo2'), 'the low-confidence field is flagged for review');
  assert(unread.review[0].dropped.some((d) => d.reason === 'unreadable'), 'the unreadable field is listed as dropped, with a reason');
  assert(unread.review[0].confident.indexOf('restingHr') !== -1, 'the confirm screen can tell confident from flagged');
  assert(unread.days[0].confidence <= CONFIDENCE.VISION_DEGRADED, 'a flagged day is trusted less than a clean one');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('a day with no date is REJECTED, never guessed');

  const mixedDates = clone(NOISE_OK);
  mixedDates.days = [
    {
      date: 'Today',
      date_evidence: 'Today',
      fields: [{ name: 'steps', value: 9000, readable: 'confident', evidence: 'Steps 9000' }],
      provider_scores: []
    },
    {
      date: null,
      fields: [{ name: 'steps', value: 4000, readable: 'confident', evidence: 'Steps 4000' }],
      provider_scores: []
    },
    {
      date: '2026-02-31',
      fields: [{ name: 'steps', value: 100, readable: 'confident', evidence: 'Steps 100' }],
      provider_scores: []
    },
    {
      date: '2026-03-12',
      date_evidence: '12 Mar 2026',
      fields: [{ name: 'steps', value: 8421, readable: 'confident', evidence: 'Steps 8,421' }],
      provider_scores: []
    }
  ];
  const dated = await extract(images(1), { deviceId: 'noise', client: stubClient(mixedDates) });
  eq(dated.ok, true, 'the one properly dated day is still returned');
  eq(dated.days.length, 1, 'only the dated day becomes a row');
  eq(dated.days[0].date, '2026-03-12', 'the surviving day is the dated one');
  eq(dated.rejected.filter((r) => r.reason === 'undated_day').length, 3,
    '"Today", null and an impossible calendar date are all rejected as undated');
  assert(dated.rejected[0].detail.indexOf('Today') !== -1, 'the rejection explains why, for the member');

  const allUndated = clone(NOISE_OK);
  allUndated.days = [{ date: 'Yesterday', fields: [{ name: 'steps', value: 9000, readable: 'confident', evidence: 'Steps 9000' }], provider_scores: [] }];
  const none = await extract(images(1), { deviceId: 'noise', client: stubClient(allUndated) });
  eq(none.ok, false, 'a payload with nothing datable produces no data');
  eq(none.code, 'VISION_NO_DATA', 'that is coded VISION_NO_DATA, not "unreadable"');
  assert(none.message.indexOf('calendar date') !== -1, 'the message tells the member to include the date in the screenshot');
  assert(none.usage && none.usage.total_tokens === 5100, 'the tokens a fruitless read cost are still reported to the ledger');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('malformed model responses fail cleanly, never throw');

  const cases = [
    ['this is not JSON at all', 'VISION_UNREADABLE', 'a non-JSON reply'],
    [{ is_expected_device: true }, 'VISION_UNREADABLE', 'a reply with no days array'],
    [{ is_expected_device: 'yes', days: [] }, 'VISION_UNREADABLE', 'a reply with a non-boolean flag'],
    [{ days: [], notes: [] }, 'VISION_UNREADABLE', 'a reply missing the contract key'],
    [{ is_expected_device: true, days: { '2026-03-12': {} } }, 'VISION_UNREADABLE', 'a reply whose days is an object'],
    [[1, 2, 3], 'VISION_UNREADABLE', 'a reply that is a bare array'],
    [{ is_expected_device: true, days: [] }, 'VISION_NO_DATA', 'a schema-valid reply with zero days']
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [payload, code, label] = cases[i];
    let res;
    try {
      res = await extract(images(1), { deviceId: 'noise', client: stubClient(payload) });
    } catch (e) {
      res = { code: `THREW: ${e.message}` };
    }
    eq(res.code, code, `${label} fails with ${code} and never throws`);
  }

  const boom = await extract(images(1), {
    deviceId: 'noise',
    client: async () => { throw new Error('socket hang up'); }
  });
  eq(boom.ok, false, 'a transport failure returns a result, never a throw');
  eq(boom.code, 'VISION_UNREADABLE', 'a transport failure is coded VISION_UNREADABLE');
  assert(boom.detail.indexOf('socket hang up') !== -1, 'the underlying cause is preserved for the operator');

  const mismatch = await extract(images(1), {
    deviceId: 'noise',
    client: stubClient({
      is_expected_device: false,
      app_seen: 'Google Photos',
      days: [],
      workouts: [],
      undated: [],
      unreadable: [],
      notes: ['This looks like a photo gallery.'],
      confidence: 'high'
    })
  });
  eq(mismatch.code, 'DEVICE_MISMATCH', 'the model saying "wrong app" gets its own code');
  assert(mismatch.message.indexOf('Google Photos') !== -1, 'the mismatch message names what we actually saw');
  assert(mismatch.usage.total_tokens === 5100, 'a refused read still reports its cost');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('non-Whoop PDF goes through the vision path as a document block');

  const pdfClient = stubClient(clone(NOISE_OK));
  const pdfOut = await extract([{ buffer: NOISE_PDF, fileName: 'noisefit_week.pdf' }], {
    deviceId: 'noise',
    client: pdfClient
  });
  eq(pdfOut.ok, true, 'a NoiseFit PDF is read');
  eq(pdfOut.inputKind, 'pdf', 'the input kind is reported as pdf');
  eq(pdfClient.calls[0].messages[0].content[0].type, 'document', 'the PDF is sent as a document block');
  eq(pdfClient.calls[0].messages[0].content[0].source.media_type, 'application/pdf', 'with the pdf media type');
  eq(pdfOut.days[0].confidence, CONFIDENCE.VISION_PDF, 'a generated PDF earns the higher vision tier');
  assert(pdfOut.days[0].confidence < FILE_PARSE_CONFIDENCE, 'a PDF is still trusted less than a parsed file');
  assert(pdfOut.summary.notes[0].indexOf('a PDF') !== -1, 'the honesty note names the input kind');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('Whoop PDF delegation — wrapped, never reimplemented');

  const whoopCalls = stubWhoopFetch({
    is_whoop_document: true,
    document_type: 'monthly_performance_assessment',
    member_name: 'Test Member',
    periods: [{
      label: 'March 2026',
      granularity: 'monthly',
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      metrics: [{ name: 'recovery_score', value: 62, unit: '%', statistic: 'average', evidence: 'Avg Recovery 62%', page: 1 }]
    }],
    daily: [],
    workouts: [],
    journal: [],
    notes: [],
    uncertain: [],
    confidence: 'high'
  });
  const visionClient = stubClient(clone(NOISE_OK));
  const whoop = await extract([{ buffer: WHOOP_PDF, fileName: 'march.pdf' }], {
    deviceId: 'whoop',
    apiKey: 'test-key',
    client: visionClient
  });
  eq(whoop.ok, true, 'a Whoop PDF is read by the existing extractor');
  eq(whoop.kind, 'whoop_pdf', 'the result is passed through UNCHANGED — still kind whoop_pdf');
  eq(whoop.documentType, 'monthly_performance_assessment', 'the delegated document type survives');
  eq(whoop.memberName, 'Test Member', 'the delegated member name survives');
  eq(whoop.coverage.periods, 1, 'the delegated coverage survives');
  eq(whoop.days.length, 0, 'a monthly Whoop PDF still produces zero days — we did not change that');
  eq(whoopCalls.length, 1, 'the legacy extractor made the call');
  eq(visionClient.calls.length, 0, 'the vision client was NOT used for a Whoop PDF');
  forbidNetwork();
  // Delegation is keyed on (pdf AND device===whoop). The SAME bytes declared as a
  // different device must go through the vision path instead, never silently into
  // the Whoop extractor — that is what keeps the wrap from becoming a takeover.
  const notWhoopDevice = await extract([{ buffer: WHOOP_PDF, fileName: 'march.pdf' }], {
    deviceId: 'garmin',
    client: visionClient
  });
  eq(notWhoopDevice.kind, 'device_vision', 'a PDF declared as a non-Whoop device uses the vision path');
  eq(visionClient.calls.length, 1, 'and that path used the injected client, not the Whoop extractor');
  eq(whoopCalls.length, 1, 'the Whoop extractor was not called a second time');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('cross-field contract repair (rule 4 / rule 5)');

  const conflicting = clone(NOISE_OK);
  conflicting.days = [{
    date: '2026-03-12',
    date_evidence: '12 Mar 2026',
    fields: [
      { name: 'sleep_minutes', value: 300, unit: 'min', readable: 'confident', evidence: 'Sleep 300 min' },
      { name: 'sleep_hours', value: 7.2, unit: 'h', readable: 'confident', evidence: 'Sleep 7.2 h' },
      { name: 'deep_min', value: 200, unit: 'min', readable: 'confident', evidence: 'Deep 200 min' },
      { name: 'light_min', value: 250, unit: 'min', readable: 'confident', evidence: 'Light 250 min' },
      { name: 'resting_hr', value: 58, unit: 'bpm', readable: 'confident', evidence: 'Resting 58 bpm' }
    ],
    provider_scores: []
  }];
  const fixed = await extract(images(1), { deviceId: 'noise', client: stubClient(conflicting) });
  eq(fixed.ok, true, 'the day survives the repair');
  eq(fixed.days[0].sleepMinutes, 300, 'the finer-grained sleep reading is kept');
  eq(fixed.days[0].sleepHours, null, 'the disagreeing hours reading is dropped, NOT reconciled');
  eq(fixed.days[0].deepMin, null, 'stages that exceed the night are dropped');
  eq(fixed.days[0].lightMin, null, 'all stages go together — we cannot tell which was misread');
  eq(fixed.days[0].restingHr, 58, 'unrelated fields are untouched');
  assert(fixed.summary.notes.some((n) => n.indexOf('disagree') !== -1), 'the disagreement is explained');
  assert(fixed.summary.notes.some((n) => n.indexOf('stages add up') !== -1), 'the stage overflow is explained');
  assert(validateParsedExport({ days: fixed.days, workouts: fixed.workouts, journal: fixed.journal, summary: fixed.summary, rejected: fixed.rejected }).ok,
    'the repaired result is contract-valid');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  section('an unlisted brand still works (the whole point of the vision path)');

  const noNamePayload = clone(NOISE_OK);
  noNamePayload.app_seen = 'FitPro';
  noNamePayload.days = [{
    date: '2026-03-12',
    fields: [{ name: 'steps', value: 6120, readable: 'confident', evidence: 'Steps 6120' }],
    provider_scores: [{ key: 'vitality_score', value: 71, readable: 'confident', evidence: 'Vitality 71' }]
  }];
  const noName = await extract(images(1), { deviceId: 'fitpro_band', client: stubClient(noNamePayload) });
  eq(noName.ok, true, 'an unlisted brand is readable through the generic prompt');
  eq(noName.deviceKnown, false, 'the result says plainly that this device is not in the table');
  eq(noName.days[0].steps, 6120, 'the generic read still produces a canonical value');
  eq(noName.days[0].providerScores['fitpro_band.vitality_score'], 71,
    'the unlisted brand still gets its own providerScores namespace');
  eq(noName.days[0].hrvMethod, null, 'no HRV, so no method claimed');
  assert(validateParsedExport({ days: noName.days, workouts: noName.workouts, journal: noName.journal, summary: noName.summary, rejected: noName.rejected }).ok,
    'the generic result is contract-valid');
  console.log(`  ${failures.length === 0 ? 'OK' : 'see failures'}`);

  // -------------------------------------------------------------------------
  global.fetch = realFetch;
  if (savedEnv.key !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv.key;
  if (savedEnv.inr !== undefined) process.env.AI_COST_USD_TO_INR = savedEnv.inr;
  if (savedEnv.inUsd !== undefined) process.env.ANTHROPIC_INPUT_PER_MILLION_USD = savedEnv.inUsd;
  if (savedEnv.outUsd !== undefined) process.env.ANTHROPIC_OUTPUT_PER_MILLION_USD = savedEnv.outUsd;
  if (savedEnv.mVision !== undefined) process.env.ANTHROPIC_MODEL_DEVICE_VISION = savedEnv.mVision;
  if (savedEnv.mPdf !== undefined) process.env.ANTHROPIC_MODEL_WHOOP_PDF = savedEnv.mPdf;
  if (savedEnv.mBlood !== undefined) process.env.ANTHROPIC_MODEL_BLOOD = savedEnv.mBlood;
  if (savedEnv.mAny !== undefined) process.env.ANTHROPIC_MODEL = savedEnv.mAny;

  console.log('');
  if (failures.length > 0) {
    console.log('--- FAILURES ---');
    failures.forEach((f) => console.log(' ', f));
    console.log(`\n${failures.length} of ${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`--- All ${checks} wearables-vision checks passed ---`);
}

run().catch((e) => {
  global.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
