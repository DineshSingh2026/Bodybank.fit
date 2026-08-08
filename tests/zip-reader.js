/**
 * Unit test: services/wearables/zipReader.js
 * Run: node tests/zip-reader.js
 *
 * No dependencies, no network, no DB, no binary fixtures — every ZIP under test is built
 * programmatically below with zlib.deflateRawSync so the inputs are known-good.
 */

'use strict';

const zlib = require('zlib');
const path = require('path');
const { readZipEntries, readZipTextFiles, isZip } = require(path.join(__dirname, '..', 'services', 'wearables', 'zipReader.js'));

let passes = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passes++;
    console.log('  OK   ' + label);
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
  return ok;
}

/** Assert that `fn` throws a ZipError whose code matches. */
function checkThrows(label, fn, expectedCode) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) return check(label, false, 'no error thrown');
  const codeOk = !expectedCode || err.code === expectedCode;
  return check(label, codeOk, codeOk ? undefined : `expected code ${expectedCode}, got ${err.code} (${err.message})`);
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (test-only) — local headers + central directory + EOCD.
// ---------------------------------------------------------------------------
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * @param {Array<object>} files each: {
 *   name, content (string|Buffer), method (0|8),
 *   localExtra (Buffer), centralExtra (Buffer),   // deliberately allowed to differ
 *   uncompressedSizeOverride, compressedSizeOverride
 * }
 * @param {object} [opts] { comment: string }
 */
function buildZip(files, opts = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8');
    const method = file.method === undefined ? 8 : file.method;
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(file.name, 'utf8');
    const localExtra = file.localExtra || Buffer.alloc(0);
    const centralExtra = file.centralExtra || Buffer.alloc(0);
    const uncompressedSize = file.uncompressedSizeOverride === undefined ? raw.length : file.uncompressedSizeOverride;
    const compressedSize = file.compressedSizeOverride === undefined ? payload.length : file.compressedSizeOverride;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localExtra.length, 28);

    chunks.push(local, nameBuf, localExtra, payload);
    const localOffset = offset;
    offset += local.length + nameBuf.length + localExtra.length + payload.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(centralExtra.length, 30);
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, nameBuf, centralExtra);
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const comment = Buffer.from(opts.comment || '', 'utf8');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...chunks, centralBuf, eocd, comment]);
}

/**
 * Overwrite the FIRST entry's compressed payload with 0xFF bytes, leaving every header,
 * size and offset intact. 0xFF decodes as BFINAL=1 / BTYPE=11, a reserved raw-deflate
 * block type, so inflate is guaranteed to fail rather than randomly succeed.
 * buildZip always places the first entry's local header at offset 0.
 */
function corruptFirstPayload(zip) {
  const out = Buffer.from(zip);
  const compressedSize = out.readUInt32LE(18);
  const dataOffset = 30 + out.readUInt16LE(26) + out.readUInt16LE(28);
  out.fill(0xff, dataOffset, dataOffset + compressedSize);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('=== zipReader: isZip sniffing ===');
{
  const zip = buildZip([{ name: 'a.csv', content: 'x,y\n1,2\n', method: 0 }]);
  check('isZip(true) on a real archive', isZip(zip) === true);
  check('isZip(false) on plain text', isZip(Buffer.from('not a zip at all')) === false);
  check('isZip(false) on tiny buffer', isZip(Buffer.from([0x50, 0x4b])) === false);
  check('isZip(false) on non-buffer', isZip(null) === false);
}

console.log('=== zipReader: STORED (method 0) round-trip ===');
{
  const body = 'cycle_start,score\n2026-01-01T00:00:00Z,88\n';
  const zip = buildZip([{ name: 'physiological_cycles.csv', content: body, method: 0 }]);
  const { entries, skipped, warnings } = readZipEntries(zip);
  check('one STORED entry found', entries.length === 1, `got ${entries.length}`);
  check('nothing skipped', skipped.length === 0, JSON.stringify(skipped));
  check('no warnings', warnings.length === 0, JSON.stringify(warnings));
  if (entries.length === 1) {
    check('STORED method recorded as 0', entries[0].method === 0);
    check('STORED name preserved', entries[0].name === 'physiological_cycles.csv', entries[0].name);
    check('STORED size matches', entries[0].size === Buffer.byteLength(body), String(entries[0].size));
    check('STORED content round-trips exactly', entries[0].text() === body);
  }
}

console.log('=== zipReader: DEFLATE (method 8) round-trip ===');
{
  // Highly compressible so the payload really is deflated, not stored.
  const body = 'sleep_id,duration\n' + Array.from({ length: 500 }, (_, i) => `${i},28800`).join('\n') + '\n';
  const zip = buildZip([{ name: 'sleeps.csv', content: body, method: 8 }]);
  const { entries } = readZipEntries(zip);
  check('one DEFLATE entry found', entries.length === 1, `got ${entries.length}`);
  if (entries.length === 1) {
    check('DEFLATE method recorded as 8', entries[0].method === 8);
    check('payload actually compressed', entries[0].compressedSize < entries[0].size, `${entries[0].compressedSize} vs ${entries[0].size}`);
    check('DEFLATE content round-trips exactly', entries[0].text() === body);
    check('bytes() is cached (same buffer instance)', entries[0].bytes() === entries[0].bytes());
  }
}

console.log('=== zipReader: multiple entries + nested folder + basename ===');
{
  const zip = buildZip([
    { name: 'my_whoop_data/sleeps.csv', content: 'a,b\n1,2\n', method: 8 },
    { name: 'my_whoop_data/workouts.csv', content: 'c,d\n3,4\n', method: 0 },
    { name: 'my_whoop_data/', content: '', method: 0 }, // directory entry
    { name: 'my_whoop_data/readme.txt', content: 'hello', method: 8 }
  ]);

  const plain = readZipEntries(zip);
  check('nested path kept when basename is off', plain.entries.some(e => e.name === 'my_whoop_data/sleeps.csv'), plain.entries.map(e => e.name).join(','));
  check('directory entry skipped', plain.skipped.some(s => s.reason === 'directory'), JSON.stringify(plain.skipped));

  const based = readZipEntries(zip, { basename: true });
  const names = based.entries.map(e => e.name).sort();
  check('basename:true strips the folder prefix', JSON.stringify(names) === JSON.stringify(['readme.txt', 'sleeps.csv', 'workouts.csv']), names.join(','));
  check('path still carries the full name', based.entries.every(e => e.path.startsWith('my_whoop_data/')));

  const csvs = readZipTextFiles(zip);
  const csvNames = csvs.map(f => f.name).sort();
  check('readZipTextFiles defaults to .csv + basename', JSON.stringify(csvNames) === JSON.stringify(['sleeps.csv', 'workouts.csv']), csvNames.join(','));
  check('readZipTextFiles decodes text', csvs.find(f => f.name === 'workouts.csv').text === 'c,d\n3,4\n');

  const txt = readZipTextFiles(zip, { extensions: ['txt'] });
  check('extensions option accepts a bare extension', txt.length === 1 && txt[0].text === 'hello', JSON.stringify(txt.map(t => t.name)));
}

console.log('=== zipReader: UTF-8 with BOM decodes cleanly ===');
{
  const body = 'name,valeur\ncafé,1\nnaïve,2\n';
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
  const zip = buildZip([
    { name: 'bom_deflate.csv', content: withBom, method: 8 },
    { name: 'bom_stored.csv', content: withBom, method: 0 }
  ]);
  const files = readZipTextFiles(zip);
  check('two BOM files read', files.length === 2, String(files.length));
  check('BOM stripped from DEFLATE entry', files.find(f => f.name === 'bom_deflate.csv').text === body);
  check('BOM stripped from STORED entry', files.find(f => f.name === 'bom_stored.csv').text === body);
  check('no stray U+FEFF anywhere', files.every(f => f.text.indexOf('\ufeff') === -1));
  check('multibyte UTF-8 intact', files[0].text.indexOf('café') !== -1);
}

console.log('=== zipReader: LOCAL extra-field length differs from CENTRAL (the classic bug) ===');
{
  const body = 'strain,kilojoule\n12.4,8800\n';
  // The local header declares a 17-byte extra field; the central directory declares none.
  // A reader that computes the data offset from the CENTRAL extra length reads 17 bytes of
  // padding as payload and produces garbage (or throws).
  const zip = buildZip([
    {
      name: 'cycles.csv',
      content: body,
      method: 8,
      localExtra: Buffer.alloc(17, 0x00),
      centralExtra: Buffer.alloc(0)
    },
    {
      // and the reverse: central has extra bytes, local has none
      name: 'recovery.csv',
      content: body,
      method: 0,
      localExtra: Buffer.alloc(0),
      centralExtra: Buffer.from([0x99, 0x99, 0x04, 0x00, 1, 2, 3, 4])
    }
  ]);
  const { entries } = readZipEntries(zip, { basename: true });
  check('both mismatched-extra entries read', entries.length === 2, String(entries.length));
  check('local extra > central extra still round-trips', entries[0] && entries[0].text() === body);
  check('central extra > local extra still round-trips', entries[1] && entries[1].text() === body);
}

console.log('=== zipReader: path traversal and unsafe names are skipped ===');
{
  const zip = buildZip([
    { name: '../evil.csv', content: 'pwned', method: 8 },
    { name: 'nested/../../escape.csv', content: 'pwned', method: 0 },
    { name: '/etc/passwd', content: 'pwned', method: 0 },
    { name: 'C:\\Windows\\system32\\evil.csv', content: 'pwned', method: 8 },
    { name: 'good.csv', content: 'safe', method: 8 }
  ]);
  const { entries, skipped } = readZipEntries(zip);
  check('only the safe entry is extracted', entries.length === 1 && entries[0].name === 'good.csv', entries.map(e => e.name).join(','));
  check('../evil.csv skipped as path-traversal', skipped.some(s => s.name === '../evil.csv' && s.reason === 'path-traversal'), JSON.stringify(skipped));
  check('deep traversal skipped', skipped.some(s => s.name.indexOf('escape.csv') !== -1 && s.reason === 'path-traversal'));
  check('absolute path skipped', skipped.some(s => s.name === '/etc/passwd' && s.reason === 'absolute-path'));
  check('drive-letter path skipped', skipped.some(s => s.reason === 'drive-letter-path'), JSON.stringify(skipped));
  check('no traversal name leaked into entries', !entries.some(e => e.text() === 'pwned'));
}

console.log('=== zipReader: unsupported compression method is recorded, not thrown ===');
{
  const zip = buildZip([
    { name: 'bzip2.csv', content: 'x', method: 12 },
    { name: 'ok.csv', content: 'y,z\n1,2\n', method: 8 }
  ]);
  const { entries, skipped } = readZipEntries(zip);
  check('supported entry still returned', entries.length === 1 && entries[0].name === 'ok.csv');
  check('method 12 recorded in skipped', skipped.some(s => s.reason === 'unsupported-compression-method-12'), JSON.stringify(skipped));
}

console.log('=== zipReader: malformed / truncated archives throw clear errors ===');
{
  const zip = buildZip([{ name: 'a.csv', content: 'hello,world\n'.repeat(20), method: 8 }]);

  checkThrows('non-zip buffer -> ZIP_NO_EOCD', () => readZipEntries(Buffer.from('this is definitely not a zip file')), 'ZIP_NO_EOCD');
  checkThrows('empty buffer -> ZIP_TRUNCATED', () => readZipEntries(Buffer.alloc(0)), 'ZIP_TRUNCATED');
  checkThrows('EOCD chopped off -> ZIP_NO_EOCD', () => readZipEntries(zip.subarray(0, zip.length - 10)), 'ZIP_NO_EOCD');

  // Head of the file removed: EOCD survives but points past/into the wrong bytes.
  const beheaded = Buffer.concat([zip.subarray(0, 8), zip.subarray(40)]);
  checkThrows('body bytes removed -> throws a coded ZipError', () => {
    const r = readZipEntries(beheaded);
    r.entries.forEach(e => e.text());
  });

  // Central directory offset pushed past the end of the buffer.
  const badOffset = Buffer.from(zip);
  const eocdAt = badOffset.length - 22;
  badOffset.writeUInt32LE(0xfffffff0, eocdAt + 16);
  checkThrows('central directory offset out of range -> ZIP_TRUNCATED', () => readZipEntries(badOffset), 'ZIP_TRUNCATED');

  // Central directory signature corrupted.
  const badSig = Buffer.from(zip);
  const cdOffset = badSig.readUInt32LE(eocdAt + 16);
  badSig.writeUInt32LE(0xdeadbeef, cdOffset);
  checkThrows('corrupt central directory signature -> ZIP_BAD_SIGNATURE', () => readZipEntries(badSig), 'ZIP_BAD_SIGNATURE');

  // Local header offset points somewhere that is not a local file header.
  const badLocal = Buffer.from(zip);
  badLocal.writeUInt32LE(3, badLocal.readUInt32LE(eocdAt + 16) + 42);
  checkThrows('bad local header offset -> ZIP_BAD_SIGNATURE', () => readZipEntries(badLocal), 'ZIP_BAD_SIGNATURE');

  // Corrupt the deflate stream itself (headers untouched).
  const badDeflate = corruptFirstPayload(zip);
  checkThrows('corrupt deflate stream -> ZIP_INFLATE_FAILED', () => readZipEntries(badDeflate).entries.forEach(e => e.text()), 'ZIP_INFLATE_FAILED');
}

console.log('=== zipReader: Zip64 is detected, never silently misread ===');
{
  const zip = buildZip([{ name: 'a.csv', content: 'x,y\n1,2\n', method: 0 }]);
  const z64 = Buffer.from(zip);
  z64.writeUInt16LE(0xffff, z64.length - 22 + 8);
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  checkThrows('0xFFFF entry count -> ZIP64_UNSUPPORTED', () => readZipEntries(z64), 'ZIP64_UNSUPPORTED');

  const z64b = Buffer.from(zip);
  z64b.writeUInt32LE(0xffffffff, z64b.length - 22 + 16);
  checkThrows('0xFFFFFFFF central dir offset -> ZIP64_UNSUPPORTED', () => readZipEntries(z64b), 'ZIP64_UNSUPPORTED');
}

console.log('=== zipReader: zip-bomb ceilings ===');
{
  // 1) Declared uncompressed sizes exceed the total ceiling -> refuse up front.
  const declared = buildZip([
    { name: 'a.csv', content: 'A'.repeat(4096), method: 8 },
    { name: 'b.csv', content: 'B'.repeat(4096), method: 8 }
  ]);
  checkThrows('declared total over maxTotalBytes -> ZIP_TOTAL_TOO_LARGE', () => readZipEntries(declared, { maxTotalBytes: 5000 }), 'ZIP_TOTAL_TOO_LARGE');
  checkThrows('declared entry over maxEntryBytes -> ZIP_ENTRY_TOO_LARGE', () => readZipEntries(declared, { maxEntryBytes: 100 }), 'ZIP_ENTRY_TOO_LARGE');
  check('same archive is fine under generous limits', readZipEntries(declared, { maxTotalBytes: 1 << 20 }).entries.length === 2);

  // 2) A lying header: tiny declared size, enormous actual expansion. The declared-size
  //    check passes, so zlib's maxOutputLength must be what stops it.
  const bomb = buildZip([
    { name: 'bomb.csv', content: Buffer.alloc(4 * 1024 * 1024, 0x41), method: 8, uncompressedSizeOverride: 16 }
  ]);
  const bombRead = readZipEntries(bomb, { maxEntryBytes: 64 * 1024, maxTotalBytes: 64 * 1024 });
  check('lying-header bomb passes the declared-size check', bombRead.entries.length === 1);
  checkThrows('lying-header bomb stopped at inflate -> ZIP_ENTRY_TOO_LARGE', () => bombRead.entries[0].text(), 'ZIP_ENTRY_TOO_LARGE');

  // 3) Shared budget across lazy reads: every header lies about its size, so the eager
  //    declared-size check cannot catch it — the running total must.
  const many = buildZip(
    Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.csv`, content: 'Z'.repeat(1000), method: 8, uncompressedSizeOverride: 10 }))
  );
  const lazy = readZipEntries(many, { maxTotalBytes: 3500, maxEntryBytes: 1 << 20 });
  let decoded = 0;
  let budgetErr = null;
  try {
    for (const e of lazy.entries) {
      e.text();
      decoded++;
    }
  } catch (e) {
    budgetErr = e;
  }
  check('running total across lazy reads stops the bomb', decoded === 3 && budgetErr && budgetErr.code === 'ZIP_TOTAL_TOO_LARGE', `decoded=${decoded} err=${budgetErr && budgetErr.code}`);
  check('size-lie recorded as a warning', lazy.warnings.length >= 3, JSON.stringify(lazy.warnings.slice(0, 2)));

  // 4) Entry-count ceiling.
  const lots = buildZip(Array.from({ length: 12 }, (_, i) => ({ name: `n${i}.csv`, content: 'q', method: 0 })));
  checkThrows('too many entries -> ZIP_TOO_MANY_ENTRIES', () => readZipEntries(lots, { maxEntries: 5 }), 'ZIP_TOO_MANY_ENTRIES');
}

console.log('=== zipReader: laziness + misc ===');
{
  // `broken.csv` has an undecodable payload. If decoding were eager, readZipEntries itself
  // would throw; because it is lazy, parsing succeeds and only touching that entry fails.
  const zip = corruptFirstPayload(
    buildZip([
      { name: 'broken.csv', content: 'x'.repeat(400), method: 8 },
      { name: 'wanted.csv', content: 'a,b\n1,2\n', method: 8 },
      { name: 'zero.csv', content: '', method: 0 }
    ])
  );
  const { entries, skipped } = readZipEntries(zip);
  check('zero-length entry skipped as empty', skipped.some(s => s.name === 'zero.csv' && s.reason === 'empty'), JSON.stringify(skipped));
  check('parsing an archive with an undecodable member does not throw', entries.length === 2, String(entries.length));
  const wanted = entries.find(e => e.name === 'wanted.csv');
  check('selective read succeeds without decoding the broken entry', wanted.text() === 'a,b\n1,2\n');
  checkThrows('touching the broken entry throws ZIP_INFLATE_FAILED', () => entries.find(e => e.name === 'broken.csv').text(), 'ZIP_INFLATE_FAILED');

  // Archive comment after the EOCD must not confuse the backward scan.
  const commented = buildZip([{ name: 'c.csv', content: 'ok', method: 0 }], { comment: 'created by BodyBank test '.repeat(40) });
  check('archive comment tolerated', readZipEntries(commented).entries[0].text() === 'ok');

  // Empty archive: EOCD only.
  const emptyZip = buildZip([]);
  const emptyRead = readZipEntries(emptyZip);
  check('empty archive parses to zero entries', emptyRead.entries.length === 0 && emptyRead.skipped.length === 0);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length > 0) {
  console.log('--- FAILURES (' + failures.length + ') ---');
  failures.forEach(f => console.log('  ' + f));
  console.log(`\n${failures.length} CHECK(S) FAILED, ${passes} passed`);
  process.exit(1);
}
console.log(`--- All ${passes} zipReader checks passed ---`);
process.exit(0);
