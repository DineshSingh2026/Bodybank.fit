/**
 * zipReader.js — dependency-free, in-memory ZIP archive reader.
 *
 * Whoop (and other wearable) exports arrive as a .zip of CSV files. We must read them
 * server-side without adding a dependency (`npm install` is not available on the deployed
 * box), so this module parses the ZIP container format directly using only Node built-ins.
 *
 * Approach (correctness first):
 *   1. Locate the End Of Central Directory (EOCD, sig 0x06054b50) by scanning BACKWARD from
 *      the end of the buffer, bounded by the 65535-byte maximum archive comment.
 *   2. Read the central-directory offset + entry count from the EOCD.
 *   3. Walk each Central Directory File Header (sig 0x02014b50) for method / sizes / name /
 *      local-header offset.
 *   4. Seek to each Local File Header (sig 0x04034b50) and skip *its own* name + extra-field
 *      lengths — these routinely differ from the central directory's values. Using the CD
 *      lengths here is the classic ZIP-reader bug and silently yields garbage.
 *   5. Inflate: method 0 (STORED) -> raw slice, method 8 (DEFLATE) -> zlib.inflateRawSync.
 *      Any other method is recorded in `skipped`, never thrown.
 *
 * We deliberately do NOT scan for local file header signatures: archives with data
 * descriptors and compressed payloads that happen to contain "PK\x03\x04" break that.
 *
 * Security: this parses untrusted uploads. Nothing is ever written to disk; path traversal
 * names are refused; entry count, per-entry and total uncompressed byte ceilings guard
 * against zip bombs; every offset/length is bounds-checked before any slice.
 *
 * Exports: readZipEntries(buffer, opts), readZipTextFiles(buffer, opts), isZip(buffer)
 */

'use strict';

const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
const SIG_LOCAL_FILE_HEADER = 0x04034b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const CENTRAL_HEADER_FIXED = 46;
const LOCAL_HEADER_FIXED = 30;
const ZIP64_LOCATOR_SIZE = 20;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// ---------------------------------------------------------------------------
// Defaults (all overridable via opts)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  maxTotalBytes: 200 * 1024 * 1024, // 200 MB of uncompressed output across the archive
  maxEntryBytes: 64 * 1024 * 1024, //  64 MB for any single member
  maxEntries: 5000,
  extensions: null, // null = accept every extension
  basename: false, // true = strip any leading directory prefix from entry names
  verifyCrc: true // mismatches are reported as warnings, never thrown
};

/** Error carrying a stable machine-readable `code`. */
class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Bounds-checked readers — every read goes through these.
// ---------------------------------------------------------------------------
function ensureRange(buf, offset, length, what) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    throw new ZipError('ZIP_MALFORMED', `Invalid ${what} range (offset=${offset}, length=${length})`);
  }
  if (offset + length > buf.length) {
    throw new ZipError(
      'ZIP_TRUNCATED',
      `Truncated or malformed ZIP: ${what} needs bytes ${offset}..${offset + length} but archive is only ${buf.length} bytes`
    );
  }
}

function u16(buf, offset, what) {
  ensureRange(buf, offset, 2, what);
  return buf.readUInt16LE(offset);
}

function u32(buf, offset, what) {
  ensureRange(buf, offset, 4, what);
  return buf.readUInt32LE(offset);
}

function u64(buf, offset, what) {
  ensureRange(buf, offset, 8, what);
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError('ZIP64_UNSUPPORTED', `${what} exceeds Number.MAX_SAFE_INTEGER (${value})`);
  }
  return Number(value);
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new ZipError('ZIP_INVALID_INPUT', 'Expected a Buffer/Uint8Array/ArrayBuffer');
}

// ---------------------------------------------------------------------------
// isZip
// ---------------------------------------------------------------------------
/**
 * Cheap sniff: does this buffer start with a ZIP signature?
 * Accepts a leading local file header (normal archives) or an EOCD / central-directory
 * signature (an empty archive is nothing but an EOCD record).
 * @param {Buffer} input
 * @returns {boolean}
 */
function isZip(input) {
  let buf;
  try {
    buf = toBuffer(input);
  } catch (_) {
    return false;
  }
  if (buf.length < 4) return false;
  const sig = buf.readUInt32LE(0);
  return (
    sig === SIG_LOCAL_FILE_HEADER ||
    sig === SIG_EOCD ||
    sig === SIG_CENTRAL_DIR ||
    sig === SIG_DATA_DESCRIPTOR
  );
}

// ---------------------------------------------------------------------------
// EOCD discovery
// ---------------------------------------------------------------------------
function findEocdOffset(buf) {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipError('ZIP_TRUNCATED', `Buffer of ${buf.length} bytes is too small to be a ZIP archive`);
  }
  const lowest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  let loose = -1;
  for (let i = buf.length - EOCD_MIN_SIZE; i >= lowest; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLength = buf.readUInt16LE(i + 20);
    // Preferred match: declared comment length exactly reaches the end of the buffer.
    if (i + EOCD_MIN_SIZE + commentLength === buf.length) return i;
    if (loose === -1) loose = i;
  }
  if (loose !== -1) return loose;
  throw new ZipError(
    'ZIP_NO_EOCD',
    'Not a valid ZIP archive: End Of Central Directory record not found (file truncated or not a ZIP)'
  );
}

function readEocd(buf) {
  const offset = findEocdOffset(buf);
  const eocd = {
    entryCount: u16(buf, offset + 10, 'EOCD total entries'),
    entriesThisDisk: u16(buf, offset + 8, 'EOCD entries on disk'),
    centralDirSize: u32(buf, offset + 12, 'EOCD central directory size'),
    centralDirOffset: u32(buf, offset + 16, 'EOCD central directory offset'),
    diskNumber: u16(buf, offset + 4, 'EOCD disk number'),
    centralDirDisk: u16(buf, offset + 6, 'EOCD central directory disk'),
    offset
  };

  const looksZip64 =
    eocd.entryCount === 0xffff ||
    eocd.entriesThisDisk === 0xffff ||
    eocd.centralDirSize === 0xffffffff ||
    eocd.centralDirOffset === 0xffffffff ||
    eocd.diskNumber === 0xffff;

  if (looksZip64 || hasZip64Locator(buf, offset)) {
    // Detect explicitly rather than silently misreading truncated 32-bit fields.
    throw new ZipError(
      'ZIP64_UNSUPPORTED',
      'Zip64 archives are not supported by this reader (entry count or offsets exceed the 32-bit ZIP limits). Re-export the archive without Zip64.'
    );
  }

  if (eocd.diskNumber !== 0 || eocd.centralDirDisk !== 0 || eocd.entriesThisDisk !== eocd.entryCount) {
    throw new ZipError('ZIP_MULTIDISK_UNSUPPORTED', 'Split/multi-disk ZIP archives are not supported');
  }
  return eocd;
}

function hasZip64Locator(buf, eocdOffset) {
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  if (locatorOffset < 0) return false;
  if (buf.readUInt32LE(locatorOffset) !== SIG_ZIP64_EOCD_LOCATOR) return false;
  // A well-formed locator points at a Zip64 EOCD record; confirm before declaring Zip64.
  try {
    const zip64Offset = u64(buf, locatorOffset + 8, 'Zip64 EOCD offset');
    return zip64Offset + 4 <= buf.length && buf.readUInt32LE(zip64Offset) === SIG_ZIP64_EOCD;
  } catch (_) {
    return true; // locator present but unreadable — still Zip64 territory
  }
}

// ---------------------------------------------------------------------------
// Name normalisation + safety
// ---------------------------------------------------------------------------
function normaliseName(raw) {
  return String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** @returns {string|null} a rejection reason, or null when the name is safe. */
function unsafeNameReason(name) {
  if (!name) return 'empty-name';
  if (name.indexOf('\0') !== -1) return 'null-byte-in-name';
  if (name.startsWith('//')) return 'unc-path';
  if (name.startsWith('/')) return 'absolute-path';
  if (/^[A-Za-z]:/.test(name)) return 'drive-letter-path';
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '..') return 'path-traversal';
  }
  return null;
}

function basenameOf(name) {
  const index = name.lastIndexOf('/');
  return index === -1 ? name : name.slice(index + 1);
}

function extensionOf(name) {
  const base = basenameOf(name);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function normaliseExtensions(extensions) {
  if (!extensions) return null;
  const list = (Array.isArray(extensions) ? extensions : [extensions])
    .map(e => String(e).trim().toLowerCase())
    .filter(Boolean)
    .map(e => (e.startsWith('.') ? e : '.' + e));
  return list.length ? list : null;
}

function decodeUtf8(buf) {
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
}

// ---------------------------------------------------------------------------
// readZipEntries
// ---------------------------------------------------------------------------
/**
 * Parse a ZIP archive held entirely in memory.
 *
 * @param {Buffer} input raw archive bytes
 * @param {object} [opts]
 * @param {number} [opts.maxTotalBytes=209715200] ceiling on total uncompressed bytes
 * @param {number} [opts.maxEntryBytes=67108864]  ceiling on a single entry's uncompressed size
 * @param {number} [opts.maxEntries=5000]         ceiling on the number of central-directory entries
 * @param {string[]} [opts.extensions]            e.g. ['.csv'] — others are recorded in `skipped`
 * @param {boolean} [opts.basename=false]         strip leading directory prefixes from names
 * @param {boolean} [opts.verifyCrc=true]         CRC mismatches become warnings on the entry
 * @returns {{entries: Array<{name:string,path:string,size:number,method:number,compressedSize:number,bytes:function():Buffer,text:function():string}>, skipped: Array<{name:string,reason:string}>, warnings: string[]}}
 */
function readZipEntries(input, opts = {}) {
  const buf = toBuffer(input);
  const options = { ...DEFAULTS, ...(opts || {}) };
  const maxTotalBytes = Number(options.maxTotalBytes);
  const maxEntryBytes = Number(options.maxEntryBytes);
  const maxEntries = Number(options.maxEntries);
  const extensions = normaliseExtensions(options.extensions);

  if (!(maxTotalBytes > 0) || !(maxEntryBytes > 0) || !(maxEntries > 0)) {
    throw new ZipError('ZIP_INVALID_OPTIONS', 'maxTotalBytes, maxEntryBytes and maxEntries must all be positive numbers');
  }

  const eocd = readEocd(buf);

  if (eocd.entryCount > maxEntries) {
    throw new ZipError(
      'ZIP_TOO_MANY_ENTRIES',
      `ZIP declares ${eocd.entryCount} entries which exceeds the limit of ${maxEntries}`
    );
  }
  ensureRange(buf, eocd.centralDirOffset, eocd.centralDirSize, 'central directory');

  const entries = [];
  const skipped = [];
  const warnings = [];
  // Shared budget so lazy text()/bytes() calls can never collectively blow the ceiling.
  const budget = { used: 0, max: maxTotalBytes };

  let cursor = eocd.centralDirOffset;
  const centralDirEnd = eocd.centralDirOffset + eocd.centralDirSize;
  let declaredTotal = 0;

  for (let index = 0; index < eocd.entryCount; index++) {
    if (cursor + CENTRAL_HEADER_FIXED > centralDirEnd) {
      throw new ZipError(
        'ZIP_TRUNCATED',
        `Central directory ended early: expected ${eocd.entryCount} entries, ran out after ${index}`
      );
    }
    const signature = u32(buf, cursor, `central directory header #${index}`);
    if (signature !== SIG_CENTRAL_DIR) {
      throw new ZipError(
        'ZIP_BAD_SIGNATURE',
        `Expected central directory signature at offset ${cursor} for entry #${index}, found 0x${signature.toString(16)}`
      );
    }

    const flags = u16(buf, cursor + 8, 'central flags');
    const method = u16(buf, cursor + 10, 'central compression method');
    const crc32Expected = u32(buf, cursor + 16, 'central crc32');
    const compressedSize = u32(buf, cursor + 20, 'central compressed size');
    const uncompressedSize = u32(buf, cursor + 24, 'central uncompressed size');
    const nameLength = u16(buf, cursor + 28, 'central name length');
    const extraLength = u16(buf, cursor + 30, 'central extra length');
    const commentLength = u16(buf, cursor + 32, 'central comment length');
    const localHeaderOffset = u32(buf, cursor + 42, 'central local header offset');

    ensureRange(buf, cursor + CENTRAL_HEADER_FIXED, nameLength, `entry #${index} name`);
    const rawName = buf.toString('utf8', cursor + CENTRAL_HEADER_FIXED, cursor + CENTRAL_HEADER_FIXED + nameLength);
    const nextCursor = cursor + CENTRAL_HEADER_FIXED + nameLength + extraLength + commentLength;
    if (nextCursor > centralDirEnd) {
      throw new ZipError('ZIP_TRUNCATED', `Central directory entry #${index} overruns the central directory`);
    }

    const path = normaliseName(rawName);
    const name = options.basename ? basenameOf(path) : path;
    cursor = nextCursor;

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipError(
        'ZIP64_UNSUPPORTED',
        `Entry "${path}" uses Zip64 size/offset placeholders, which this reader does not support`
      );
    }

    // --- filters -----------------------------------------------------------
    if (path.endsWith('/')) {
      skipped.push({ name: path, reason: 'directory' });
      continue;
    }
    const unsafe = unsafeNameReason(path);
    if (unsafe) {
      skipped.push({ name: path, reason: unsafe });
      continue;
    }
    if ((flags & 0x0001) !== 0) {
      skipped.push({ name: path, reason: 'encrypted' });
      continue;
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      skipped.push({ name: path, reason: `unsupported-compression-method-${method}` });
      continue;
    }
    if (uncompressedSize === 0) {
      skipped.push({ name: path, reason: 'empty' });
      continue;
    }
    if (extensions && extensions.indexOf(extensionOf(path)) === -1) {
      skipped.push({ name: path, reason: 'extension-filtered' });
      continue;
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new ZipError(
        'ZIP_ENTRY_TOO_LARGE',
        `Entry "${path}" declares ${uncompressedSize} uncompressed bytes, over the per-entry limit of ${maxEntryBytes}`
      );
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > maxTotalBytes) {
      throw new ZipError(
        'ZIP_TOTAL_TOO_LARGE',
        `Archive declares more than ${maxTotalBytes} uncompressed bytes (${declaredTotal} so far) — refusing to expand a potential zip bomb`
      );
    }

    // --- resolve payload location via the LOCAL header ----------------------
    const localSignature = u32(buf, localHeaderOffset, `local header for "${path}"`);
    if (localSignature !== SIG_LOCAL_FILE_HEADER) {
      throw new ZipError(
        'ZIP_BAD_SIGNATURE',
        `Expected local file header for "${path}" at offset ${localHeaderOffset}, found 0x${localSignature.toString(16)}`
      );
    }
    // IMPORTANT: the local header carries its OWN name/extra lengths, which frequently
    // differ from the central directory's. Reading them from the CD is the classic bug.
    const localNameLength = u16(buf, localHeaderOffset + 26, `local name length for "${path}"`);
    const localExtraLength = u16(buf, localHeaderOffset + 28, `local extra length for "${path}"`);
    const dataOffset = localHeaderOffset + LOCAL_HEADER_FIXED + localNameLength + localExtraLength;

    // Local sizes are zero when a data descriptor (flag bit 3) is used — the central
    // directory is authoritative in that case, and always correct otherwise.
    let payloadLength = compressedSize;
    if (payloadLength === 0 && method === METHOD_STORED) payloadLength = uncompressedSize;
    ensureRange(buf, dataOffset, payloadLength, `compressed data for "${path}"`);

    entries.push(
      makeEntry({
        buf,
        name,
        path,
        method,
        dataOffset,
        payloadLength,
        uncompressedSize,
        compressedSize,
        crc32Expected,
        maxEntryBytes,
        budget,
        verifyCrc: options.verifyCrc !== false,
        warnings
      })
    );
  }

  return { entries, skipped, warnings };
}

function makeEntry(ctx) {
  let cached = null;

  const entry = {
    name: ctx.name,
    path: ctx.path,
    size: ctx.uncompressedSize,
    compressedSize: ctx.compressedSize,
    method: ctx.method,
    /** Decompress on demand (cached). */
    bytes() {
      if (cached) return cached;
      cached = inflateEntry(ctx);
      return cached;
    },
    /** UTF-8 text with any BOM stripped. Lazy — decompression happens on first call. */
    text() {
      return decodeUtf8(entry.bytes());
    }
  };
  return entry;
}

function inflateEntry(ctx) {
  const { buf, path, method, dataOffset, payloadLength, uncompressedSize, maxEntryBytes, budget } = ctx;
  const remainingBudget = budget.max - budget.used;
  if (uncompressedSize > remainingBudget) {
    throw new ZipError(
      'ZIP_TOTAL_TOO_LARGE',
      `Decompressing "${path}" would exceed the ${budget.max}-byte total ceiling`
    );
  }
  const cap = Math.min(maxEntryBytes, remainingBudget);
  // Which ceiling are we actually up against? Drives the error code below.
  const capCode = remainingBudget < maxEntryBytes ? 'ZIP_TOTAL_TOO_LARGE' : 'ZIP_ENTRY_TOO_LARGE';

  let out;
  if (method === METHOD_STORED) {
    ensureRange(buf, dataOffset, payloadLength, `stored data for "${path}"`);
    if (payloadLength > cap) {
      throw new ZipError(capCode, `Entry "${path}" (${payloadLength} bytes) exceeds the ${cap}-byte ceiling`);
    }
    out = Buffer.from(buf.subarray(dataOffset, dataOffset + payloadLength));
  } else {
    const slice = buf.subarray(dataOffset, dataOffset + payloadLength);
    try {
      // maxOutputLength stops a zip bomb that lies about its uncompressed size in the headers.
      out = zlib.inflateRawSync(slice, { maxOutputLength: cap });
    } catch (err) {
      if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer larger/i.test(err.message || ''))) {
        throw new ZipError(
          capCode,
          `Entry "${path}" inflates beyond the ${cap}-byte ceiling (declared ${uncompressedSize}) — refusing to expand a potential zip bomb`
        );
      }
      throw new ZipError('ZIP_INFLATE_FAILED', `Failed to inflate "${path}": ${err && err.message ? err.message : err}`);
    }
  }

  if (out.length > cap) {
    throw new ZipError(capCode, `Entry "${path}" produced ${out.length} bytes, over the ${cap}-byte ceiling`);
  }
  budget.used += out.length;

  if (out.length !== uncompressedSize) {
    ctx.warnings.push(`Entry "${path}": declared ${uncompressedSize} uncompressed bytes but produced ${out.length}`);
  }
  if (ctx.verifyCrc && typeof zlib.crc32 === 'function' && ctx.crc32Expected !== 0) {
    const actual = zlib.crc32(out) >>> 0;
    if (actual !== (ctx.crc32Expected >>> 0)) {
      ctx.warnings.push(`Entry "${path}": CRC32 mismatch (expected ${ctx.crc32Expected >>> 0}, got ${actual})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// readZipTextFiles
// ---------------------------------------------------------------------------
/**
 * Convenience wrapper: decode every matching entry to UTF-8 text (BOM stripped).
 * Defaults to `.csv` and to basename-only names, which is what the Whoop importer wants
 * (Whoop sometimes nests the CSVs inside a `my_whoop_data/` folder).
 *
 * @param {Buffer} input
 * @param {object} [opts] same shape as readZipEntries; `extensions` defaults to ['.csv']
 * @returns {Array<{name:string, path:string, text:string}>}
 */
function readZipTextFiles(input, opts = {}) {
  const options = { basename: true, ...(opts || {}) };
  if (options.extensions === undefined) options.extensions = ['.csv'];
  const { entries } = readZipEntries(input, options);
  return entries.map(entry => ({ name: entry.name, path: entry.path, text: entry.text() }));
}

module.exports = {
  readZipEntries,
  readZipTextFiles,
  isZip,
  ZipError,
  DEFAULTS
};
