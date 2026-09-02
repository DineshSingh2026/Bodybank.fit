'use strict';

/**
 * Wearable (Whoop) opt-in, upload and readiness routes.
 *
 * Mounted from server.js as:
 *   app.use('/api/wearables', createWearablesRouter({ run, queryOne, queryAll, verifyToken,
 *                                                     requireAdminOrSuperadmin, rateLimiter }))
 *
 * Design rules enforced here (see services/wearables/*):
 *  - Upload is preview -> confirm. Preview NEVER writes.
 *  - The file sha256 is computed from the raw bytes and passed to both calls,
 *    so re-uploading an identical export is a no-op instead of a duplicate.
 *  - Claude never computes a number: the stats engine runs first and the model
 *    only receives finished figures, which are then validated back.
 *  - A file we cannot read is reported as the wrong file, not as the member's
 *    Whoop export being incomplete.
 */

const express = require('express');
const crypto = require('crypto');

const readinessService = require('../services/wearables/readinessService');
const { parseWhoopExport } = require('../services/wearables/whoopParser');
const { readZipTextFiles, isZip } = require('../services/wearables/zipReader');
const { computeWhoopStats } = require('../services/wearables/whoopStatsService');
const { generateWhoopReport } = require('../services/wearables/whoopReportService');
const { buildWhoopReportPdf } = require('../services/wearables/whoopReportPdfKit');
const { recordAiUsage } = require('../services/aiUsageLedger');

// PDF ingestion is an optional add-on: a deployment without the module still serves
// every ZIP/CSV route, and a PDF upload gets an honest "we can't read this here"
// instead of crashing the whole app at require time.
let whoopPdfExtract = null;
try {
  whoopPdfExtract = require('../services/wearables/whoopPdfExtract');
} catch (e) { /* not deployed — handled at the call site */ }

const PROVIDER = 'whoop';
// Whoop exports are small (a few hundred KB); this is a generous ceiling that still
// keeps a hostile upload from occupying memory. It is checked on the ENCODED length
// too, before any buffer is allocated. Note the ceiling must stay well under what
// express.json accepts (40mb of base64 ≈ 30MB decoded, server.js:344): above that the
// body parser rejects first and the member gets the generic blood-report 413 text.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// How long the narrative may hold up a PDF that is already fully valid without it.
const PDF_NARRATIVE_BUDGET_MS = Math.max(
  5000,
  parseInt(process.env.WHOOP_PDF_NARRATIVE_BUDGET_MS || '60000', 10) || 60000
);

function createWearablesRouter(deps = {}) {
  const { run, queryOne, queryAll, verifyToken, requireAdminOrSuperadmin, requireOperator, rateLimiter } = deps;

  const db = { run, queryOne, queryAll };
  const router = express.Router();

  const limit = (max, windowMs) =>
    (typeof rateLimiter === 'function' ? rateLimiter(max, windowMs) : (req, res, next) => next());

  // The mount in server.js passes six deps and does not include requireOperator.
  // Fall back to the same inline role gate routes/blood.js uses so the read-only
  // operator routes work whether or not that mount is updated. Read-only always.
  const operatorOnly = typeof requireOperator === 'function'
    ? requireOperator
    : (req, res, next) => {
      if (req.user && ['operator', 'admin', 'superadmin'].includes(req.user.role)) return next();
      return res.status(403).json({ error: 'Operator access required' });
    };

  const ACCEPTED_FORMATS = 'Upload the ZIP Whoop emailed you, a CSV from inside it, or a Whoop PDF report.';

  /**
   * HTTP status per whoopPdfExtract failure code. Its fail() helper returns
   * { ok:false, code, error, message } and carries no `status`, so without this
   * table every PDF failure collapses to 422 — telling a member their file is
   * malformed when the real cause was an unconfigured key or an oversized document.
   */
  const PDF_ERROR_STATUS = {
    NOT_A_PDF: 400,
    PDF_EMPTY: 400,
    NOT_A_WHOOP_PDF: 400,
    PDF_TOO_LARGE: 413,
    PDF_TOO_MANY_PAGES: 413,
    PDF_AI_UNAVAILABLE: 503,
    // ── universal vision extractor (services/wearables/deviceVisionExtract.js) ──
    // One cause, one code. The whole point of this table is that a member is never
    // told their file is malformed when the real fault was ours: an unconfigured
    // key is a 503, an oversized image is a 413, and only a document we genuinely
    // could not read falls through to the 422 default.
    UPLOAD_EMPTY: 400,
    NOT_AN_IMAGE: 400,
    UNSUPPORTED_IMAGE_FORMAT: 415,
    MIXED_UPLOAD_TYPES: 400,
    DEVICE_NOT_SPECIFIED: 400,
    DEVICE_MISMATCH: 400,
    IMAGE_TOO_LARGE: 413,
    IMAGES_TOTAL_TOO_LARGE: 413,
    TOO_MANY_IMAGES: 413,
    VISION_AI_UNAVAILABLE: 503,
    VISION_CLIENT_INVALID: 503,
    PDF_EXTRACTOR_UNAVAILABLE: 503
    // PDF_UNREADABLE, PDF_NO_DATA, VISION_UNREADABLE and VISION_NO_DATA describe the
    // document's content, not a transport fault, so they take the 422 default below.
  };

  /** Does the head of the buffer read as text, or is it binary we should refuse? */
  function looksLikeText(buf) {
    const head = buf.slice(0, 4096);
    if (!head.length) return false;
    let printable = 0;
    for (let i = 0; i < head.length; i += 1) {
      const c = head[i];
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 128) printable += 1;
      if (c === 0) return false; // a NUL in the first 4KB means UTF-16 or a binary blob
    }
    return printable / head.length > 0.9;
  }

  /**
   * Which format did the member actually send?
   *
   * whoopPdfExtract owns this when it is deployed — it knows every shape its extractor
   * can handle. The fallback below runs only without that module and exists so a
   * wrong-file upload still gets an honest answer: this used to be a bare
   * `isZip(buf) ? zip : csv`, so a PDF, an XLSX or a UTF-16 CSV was parsed as CSV,
   * produced zero rows, and the member was told their Whoop export was incomplete.
   *
   * @returns {'zip'|'csv'|'pdf'|'unknown'}
   */
  function classifyUpload(buf, fileName) {
    if (whoopPdfExtract && typeof whoopPdfExtract.classifyUploadBuffer === 'function') {
      const c = whoopPdfExtract.classifyUploadBuffer(buf, fileName);
      const kind = c && typeof c === 'object' ? c.kind : c;
      if (kind) return String(kind);
    }
    if (isZip(buf)) return 'zip';
    if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    return looksLikeText(buf) ? 'csv' : 'unknown';
  }

  /**
   * Decode an uploaded export and run it through the parser.
   * Accepts a ZIP (the raw Whoop download), a single CSV, or a Whoop PDF report.
   * Async because the PDF branch calls the extractor.
   * Returns { ok, parsed, sha256, fileName, extraction } or { ok:false, status, error }.
   */
  async function decodeAndParse(body) {
    const b = body || {};
    const raw = String(b.file_base64 || b.fileBase64 || b.data || '');
    const fileName = String(b.file_name || b.fileName || 'whoop_export.zip').slice(0, 200);
    const b64 = raw.replace(/^data:[^;]+;base64,/, '').trim();
    if (!b64) return { ok: false, status: 400, error: 'No file was uploaded.' };

    // Check the ENCODED length first: 4 base64 chars = 3 bytes, so this rejects an
    // oversized upload without allocating the buffer at all.
    if (Math.floor((b64.length * 3) / 4) > MAX_UPLOAD_BYTES) {
      return { ok: false, status: 413, error: 'That file is too large. Please upload your Whoop export directly.' };
    }
    // Buffer.from(x, 'base64') NEVER throws — it silently drops every invalid
    // character — so a garbage payload used to sail through as an "incomplete
    // Whoop export". Validate the alphabet explicitly instead.
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      return { ok: false, status: 400, error: 'That upload was not valid base64. Please attach the file again.' };
    }

    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { ok: false, status: 400, error: 'That file is empty.' };
    if (buf.length > MAX_UPLOAD_BYTES) {
      return { ok: false, status: 413, error: 'That file is too large. Please upload your Whoop export directly.' };
    }

    // sha256 of the raw bytes — the idempotency key for the whole upload.
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    const kind = classifyUpload(buf, fileName);
    let files;
    // `parsed` is the canonical {days, workouts, journal, summary} shape. The ZIP and
    // CSV branches produce `files` for parseWhoopExport to turn into it; the PDF
    // branch produces it directly, because the extractor IS the parser for that
    // format — it never emits CSV text.
    let parsed = null;
    let extraction = null;

    if (kind === 'zip') {
      try {
        files = readZipTextFiles(buf, { extensions: ['.csv'], basename: true });
      } catch (e) {
        // zipReader throws coded errors (ZIP_TRUNCATED, ZIP64_UNSUPPORTED, …).
        return { ok: false, status: 400, error: `That archive could not be read (${e.code || 'unreadable'}). Please re-download your Whoop export.` };
      }
      if (!files || !files.length) {
        // A spreadsheet (.xlsx) is also a ZIP, and lands here.
        return { ok: false, status: 400, error: `That archive contains no CSV files, so it is not a Whoop export. ${ACCEPTED_FORMATS}` };
      }
    } else if (kind === 'csv') {
      files = [{ name: fileName.replace(/\.[^.]*$/, '') + '.csv', text: buf.toString('utf8') }];
    } else if (kind === 'pdf') {
      if (!whoopPdfExtract || typeof whoopPdfExtract.extractWhoopPdf !== 'function') {
        return { ok: false, status: 400, error: `PDF imports are not available here. ${ACCEPTED_FORMATS}` };
      }
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) {
        return { ok: false, status: 503, error: `PDF imports are not configured. ${ACCEPTED_FORMATS}` };
      }
      let out;
      try {
        out = await whoopPdfExtract.extractWhoopPdf({ buffer: buf, fileName, apiKey });
      } catch (e) {
        console.error('[wearables pdf extract]', e && e.message);
        out = null;
      }
      if (!out || !out.ok) {
        return {
          ok: false,
          status: (out && out.status) || PDF_ERROR_STATUS[out && out.code] || 422,
          error: (out && out.error) || 'We could not read any daily records out of that PDF.'
        };
      }
      // extractWhoopPdf returns the same {days, workouts, journal, summary} contract
      // parseWhoopExport emits, so it flows on unchanged. Asking it for `files` was
      // asking for a shape it never produces, and rejected every valid PDF.
      parsed = {
        days: Array.isArray(out.days) ? out.days : [],
        workouts: Array.isArray(out.workouts) ? out.workouts : [],
        journal: Array.isArray(out.journal) ? out.journal : [],
        summary: (out.summary && typeof out.summary === 'object') ? out.summary : {}
      };
      if (!parsed.days.length) {
        // A monthly or weekly assessment is not an incomplete export. Say what the
        // document actually gave us, in the extractor's own words — a period average
        // is never expanded into days.
        return {
          ok: false,
          status: 422,
          error: out.message || 'That PDF carries no per-day records. Upload your Whoop ZIP export for your day-by-day history.'
        };
      }
      // Surfaced so the member (and the cost audit) can see a PDF import cost money.
      // coverage/message ride along so preview can repeat what the document held.
      recordAiUsage({ scope: 'whoop_extract', usage: out.usage, model: out.model });
      extraction = {
        source: 'pdf',
        model: out.model || null,
        usage: out.usage || null,
        pages: out.pages != null ? out.pages : null,
        coverage: out.coverage || null,
        message: out.message || null
      };
    } else {
      return { ok: false, status: 400, error: `That does not look like a Whoop export. ${ACCEPTED_FORMATS}` };
    }

    if (!parsed) {
      try {
        parsed = parseWhoopExport({ files });
      } catch (e) {
        return { ok: false, status: 400, error: 'That export could not be parsed.' };
      }
    }

    if (!parsed || !Array.isArray(parsed.days) || !parsed.days.length) {
      return { ok: false, status: 400, error: 'No daily records were found in that export. Make sure you exported your full Whoop data.' };
    }
    return { ok: true, parsed, sha256, fileName, extraction };
  }

  /**
   * The parser reports unrecognised CSV headers as {file, kind, column} objects while
   * readinessService reports unrecognised normalized fields as plain strings. The route
   * used to overwrite the second with the first, so the member was shown
   * "[object Object]" and that literal string was persisted for operator triage too.
   * Emit display strings here; the objects stay available as unknownColumnsDetail.
   *
   * readinessService also folds the parser's objects into its own string list, where
   * they stringify to the literal "[object Object]". Drop that — the real header name
   * is recovered from the parser's array, which is merged in below.
   */
  function unknownColumnNames(...lists) {
    const out = [];
    lists.forEach((list) => {
      (Array.isArray(list) ? list : []).forEach((c) => {
        const name = String((c && typeof c === 'object' ? c.column : c) || '').trim();
        if (!name || name === '[object Object]') return;
        if (out.indexOf(name) === -1) out.push(name);
      });
    });
    return out;
  }

  /**
   * Coverage denominator for the stats engine. Without it computeWhoopStats falls back
   * to the span of the rows it was handed, so a member with 10 days of data inside a
   * one-year window was shown "Days with data: 10 of 10 — Coverage: 100%".
   * @returns {number|null} inclusive day count, or null when the bounds are unusable.
   */
  function daysInWindow(from, to) {
    const a = Date.parse(`${from}T00:00:00Z`);
    const bMs = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(bMs)) return null;
    return Math.floor(Math.abs(bMs - a) / 86400000) + 1;
  }

  /** computeWhoopStats options with an honest coverage denominator when we have one. */
  function statsOptions(memberLabel, from, to) {
    const opts = { memberLabel };
    const expectedDays = daysInWindow(from, to);
    if (expectedDays) opts.expectedDays = expectedDays;
    return opts;
  }

  // ---- Connection / opt-in -------------------------------------------------

  router.get('/connection', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      const r = await readinessService.getConnection(db, { userId: String(req.user.id), provider: PROVIDER });
      res.json({ provider: PROVIDER, connection: (r && r.connection) || null });
    } catch (e) {
      console.error('[wearables connection]', e.message);
      res.status(500).json({ error: 'Could not load your connection.' });
    }
  });

  router.post('/opt-in', verifyToken, limit(20, 60000), async (req, res) => {
    try {
      const r = await readinessService.optIn(db, { userId: String(req.user.id), provider: PROVIDER });
      if (!r || !r.ok) return res.status(500).json({ error: 'Could not enable Whoop syncing.' });
      res.json({ ok: true, connection: r.connection });
    } catch (e) {
      console.error('[wearables opt-in]', e.message);
      res.status(500).json({ error: 'Could not enable Whoop syncing.' });
    }
  });

  router.post('/opt-out', verifyToken, limit(20, 60000), async (req, res) => {
    try {
      const r = await readinessService.optOut(db, { userId: String(req.user.id), provider: PROVIDER });
      // Opting out never deletes history — that needs the explicit purge below.
      res.json({ ok: true, dataPreserved: true, connection: r && r.connection });
    } catch (e) {
      console.error('[wearables opt-out]', e.message);
      res.status(500).json({ error: 'Could not disconnect Whoop.' });
    }
  });

  /** Explicit, user-requested deletion of all Whoop-sourced data. */
  router.delete('/data', verifyToken, limit(5, 60000), async (req, res) => {
    try {
      const r = await readinessService.purgeProviderData(db, { userId: String(req.user.id), provider: PROVIDER });
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[wearables purge]', e.message);
      res.status(500).json({ error: 'Could not delete your Whoop data.' });
    }
  });

  // ---- Upload: preview -> confirm -----------------------------------------

  /**
   * POST /api/wearables/whoop/preview
   * Parses and reports what WOULD be written. Writes nothing.
   */
  router.post('/whoop/preview', verifyToken, limit(10, 60000), async (req, res) => {
    try {
      const decoded = await decodeAndParse(req.body);
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });

      const { parsed, sha256, fileName, extraction } = decoded;
      const preview = await readinessService.previewUpload(db, {
        userId: String(req.user.id),
        parsed,
        provider: PROVIDER,
        sha256
      });

      res.json({
        ok: true,
        fileName,
        sha256,
        extraction: extraction || null,
        ...preview,
        // Honesty signals — surfaced, never swallowed. unknownColumns is the
        // early warning that Whoop changed their export format.
        rowsRejected: parsed.summary.rowsRejected,
        unknownColumns: unknownColumnNames(preview.unknownColumns, parsed.summary.unknownColumns),
        unknownColumnsDetail: parsed.summary.unknownColumns || [],
        duplicates: parsed.summary.duplicates || [],
        notes: parsed.summary.notes || [],
        // A PDF states in its own words what it actually held — daily rows, period
        // averages, or both. The CSV parser has no such message and these stay null.
        message: parsed.summary.message || null,
        coverage: parsed.summary.coverage || null,
        workouts: parsed.workouts.length,
        journal: parsed.journal.length
      });
    } catch (e) {
      console.error('[wearables preview]', e.message);
      res.status(500).json({ error: 'Could not read that export. Please try again.' });
    }
  });

  /**
   * POST /api/wearables/whoop/commit
   * Same file, now written. Re-uploading an identical file is a no-op.
   */
  router.post('/whoop/commit', verifyToken, limit(10, 60000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const decoded = await decodeAndParse(req.body);
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });

      const { parsed, sha256, fileName, extraction } = decoded;
      const result = await readinessService.commitUpload(db, {
        userId,
        provider: PROVIDER,
        fileName,
        sha256,
        parsed
      });
      if (!result || !result.ok) return res.status(500).json({ error: 'Could not save that export.' });

      if (result.duplicate) {
        return res.json({ ok: true, duplicate: true, message: 'You have already uploaded this export — nothing changed.' });
      }

      // Opt-in is implied by a successful upload, but recorded explicitly.
      await readinessService.optIn(db, { userId, provider: PROVIDER }).catch(() => {});

      // Back-fill blank sleep values on the affected dates. Never overwrites a value
      // the member typed themselves — the service guards on IS NULL. One batched call:
      // this used to be three sequential queries per day of the export, so a two-year
      // import issued ~2,200 round-trips inside this request and could outlive the
      // proxy timeout.
      const autofill = await readinessService
        .autoPopulateCheckinRange(db, { userId, dates: parsed.days.map((d) => d.date) })
        .catch(() => null);

      // A pending status means some rows did not land. Say so — the member's retry
      // resumes the same upload, so this is recoverable, but it is not "done".
      const partial = result.status === 'pending';
      const payload = {
        ok: true,
        duplicate: false,
        ...result,
        partial,
        extraction: extraction || null,
        checkinsAutoFilled: (autofill && autofill.filled) || 0,
        unknownColumns: unknownColumnNames(result.unknownColumns, parsed.summary.unknownColumns),
        unknownColumnsDetail: parsed.summary.unknownColumns || []
      };
      if (partial) {
        payload.message = 'Part of that export could not be saved. Upload the same file again to finish the import.';
      }
      res.json(payload);
    } catch (e) {
      console.error('[wearables commit]', e.message);
      res.status(500).json({ error: 'Could not save that export. Please try again.' });
    }
  });

  /* ══════════════════════════════════════════════════════════════════════════
   * UNIVERSAL DEVICE UPLOAD
   *
   * The member picks their device, then uploads whatever their app gave them.
   * The Whoop routes above are deliberately left byte-identical: a shipped mobile
   * build calls them, and a member's working upload path is not something to
   * migrate for tidiness. Whoop flows through here too, via its own adapter.
   *
   *   POST /api/wearables/upload/preview   reads, writes nothing
   *   POST /api/wearables/upload/commit    same file, now written
   *   GET  /api/wearables/devices          what we support, and honestly how well
   *
   * Every failure below names the real cause. Telling a member their file is
   * malformed when the true reason was an unconfigured API key is a bug this
   * codebase has already had to fix once (see PDF_ERROR_STATUS above).
   * ══════════════════════════════════════════════════════════════════════════ */

  const canonicalDay = require('../services/wearables/canonicalDay');
  const adapterRegistry = require('../services/wearables/adapterRegistry');

  // Both are optional at deploy time, exactly like whoopPdfExtract: a build missing
  // one must still serve every other device rather than failing at require time.
  let deviceRegistry = null;
  try { deviceRegistry = require('../services/wearables/deviceRegistry'); } catch (e) { /* handled at call sites */ }
  let deviceVision = null;
  try { deviceVision = require('../services/wearables/deviceVisionExtract'); } catch (e) { /* handled at call sites */ }

  /**
   * Apple Health exports are sample-level XML and routinely run to hundreds of
   * megabytes, far past MAX_UPLOAD_BYTES and past what express.json will accept at
   * all. Rather than let a member wait through a long upload only to be refused by
   * the body parser with a generic 413, we detect the device up front and explain.
   */
  const APPLE_XML_GUIDANCE = 'Apple Health exports are usually far too large to upload here. '
    + 'Open the BodyBank app on your iPhone and connect Apple Health directly — it syncs '
    + 'the same data without the file.';

  /** Which upload routes a magic-byte classification corresponds to. */
  function classifyDeviceUpload(buf, fileName) {
    if (isZip(buf)) return 'zip';
    if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buf.length >= 8 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image';
    if (buf.length >= 3 && buf.slice(0, 3).toString('hex') === 'ffd8ff') return 'image';
    if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF'
        && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image';
    if (!looksLikeText(buf)) return 'unknown';

    // Text: distinguish JSON and XML from CSV by their first non-whitespace byte.
    // Guessing wrong here means handing an adapter a shape it cannot read and
    // reporting "your export was incomplete", which is the wrong diagnosis.
    const head = buf.slice(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
    if (head[0] === '{' || head[0] === '[') return 'json';
    if (head[0] === '<') return 'xml';
    return 'csv';
  }

  /** Text extensions worth pulling out of a vendor ZIP, across all devices. */
  const ZIP_TEXT_EXTENSIONS = ['.csv', '.json', '.xml', '.txt'];

  /**
   * Decode and parse an upload for a DECLARED device.
   *
   * @returns {{ok:true, parsed, sha256, fileName, provider, extraction}}
   *        | {ok:false, status:number, error:string}
   */
  async function decodeForDevice(body, userId) {
    const b = body || {};
    const provider = String(b.device || b.provider || b.device_id || '').trim().toLowerCase();

    if (!provider) return { ok: false, status: 400, error: 'Please choose which device this file came from.' };
    if (canonicalDay.PROVIDERS.indexOf(provider) === -1) {
      return { ok: false, status: 400, error: 'We do not recognise that device.' };
    }

    const device = deviceRegistry ? deviceRegistry.getDevice(provider) : null;
    const deviceLabel = (device && device.label) || provider;

    const raw = String(b.file_base64 || b.fileBase64 || b.data || '');
    const fileName = String(b.file_name || b.fileName || (provider + '_export')).slice(0, 200);
    const b64 = raw.replace(/^data:[^;]+;base64,/, '').trim();
    if (!b64) return { ok: false, status: 400, error: 'No file was uploaded.' };

    // Encoded-length check first: 4 base64 chars = 3 bytes, so an oversized upload
    // is refused without ever allocating the buffer.
    if (Math.floor((b64.length * 3) / 4) > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        error: provider === 'apple_health'
          ? APPLE_XML_GUIDANCE
          : 'That file is too large to upload here.'
      };
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      return { ok: false, status: 400, error: 'That upload was not valid base64. Please attach the file again.' };
    }

    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { ok: false, status: 400, error: 'That file is empty.' };
    if (buf.length > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        error: provider === 'apple_health' ? APPLE_XML_GUIDANCE : 'That file is too large to upload here.'
      };
    }

    // The idempotency key for the whole upload, over the raw bytes.
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const kind = classifyDeviceUpload(buf, fileName);
    if (kind === 'unknown') {
      return { ok: false, status: 400, error: 'We could not tell what kind of file that is. Upload the export your ' + deviceLabel + ' app produced, or a screenshot of it.' };
    }

    /* ---- images and PDFs go to the vision extractor ---- */
    if (kind === 'image' || (kind === 'pdf' && provider !== 'whoop')) {
      if (!deviceVision || typeof deviceVision.extract !== 'function') {
        return { ok: false, status: 400, error: 'Reading data from images is not available on this deployment yet.' };
      }
      if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
        // A configuration fault, NOT the member's file being wrong.
        return { ok: false, status: 503, error: 'Reading data from images is not configured here yet.' };
      }
      let out;
      try {
        out = await deviceVision.extract(
          { buffer: buf, fileName: fileName, kind: kind },
          { device: provider, apiKey: (process.env.ANTHROPIC_API_KEY || '').trim() }
        );
      } catch (e) {
        console.error('[wearables vision]', e && e.message);
        out = null;
      }
      // Every AI call in this codebase records its cost, or the cost is invisible.
      // This runs on BOTH paths: a failed extraction still burned real tokens, and
      // DEVICE_MISMATCH / VISION_NO_DATA / VISION_UNREADABLE all return usage.
      if (out && out.usage) {
        recordAiUsage({
          scope: 'device_vision',
          usage: out.usage,
          model: out.model,
          userId: userId || null,
          refType: 'wearable_upload',
          refId: sha256
        });
      }
      if (!out || !out.ok) {
        return {
          ok: false,
          status: (out && out.status) || PDF_ERROR_STATUS[out && out.code] || 422,
          error: (out && out.error) || 'We could not read any readings out of that image.'
        };
      }

      const parsed = out.parsed || out;
      const verdict = canonicalDay.validateParsedExport(parsed);
      if (!verdict.ok) {
        console.error('[wearables vision] contract violation:', verdict.errors.slice(0, 8));
        return { ok: false, status: 422, error: 'We could not read those readings reliably, so nothing was saved.' };
      }
      if (!parsed.days.length) {
        return { ok: false, status: 422, error: out.message || 'We could not find any daily readings in that image.' };
      }
      return {
        ok: true,
        parsed: parsed,
        sha256: sha256,
        fileName: fileName,
        provider: provider,
        extraction: {
          source: kind,
          model: out.model || null,
          usage: out.usage || null,
          message: out.message || null,
          // The member MUST be able to see that these numbers were read off a
          // picture rather than parsed from their device's own file.
          readFromImage: true
        }
      };
    }

    /* ---- Whoop PDFs keep their existing, proven path ---- */
    if (kind === 'pdf' && provider === 'whoop') {
      const legacy = await decodeAndParse(b);
      if (!legacy.ok) return legacy;
      return Object.assign({ provider: 'whoop' }, legacy);
    }

    /* ---- structured files go to the device's adapter ---- */
    let files;
    if (kind === 'zip') {
      try {
        files = readZipTextFiles(buf, { extensions: ZIP_TEXT_EXTENSIONS, basename: true });
      } catch (e) {
        return { ok: false, status: 400, error: 'That archive could not be read (' + (e.code || 'unreadable') + '). Please re-download your export.' };
      }
      if (!files || !files.length) {
        return { ok: false, status: 400, error: 'That archive contains no readable data files. Please upload the export your ' + deviceLabel + ' app produced.' };
      }
    } else {
      const ext = kind === 'json' ? '.json' : kind === 'xml' ? '.xml' : '.csv';
      files = [{ name: fileName.replace(/\.[^.]*$/, '') + ext, text: buf.toString('utf8') }];
    }

    const result = adapterRegistry.parseForDevice(provider, files, { fileName: fileName });
    if (!result.ok) {
      const status = result.code === 'DEVICE_NOT_SUPPORTED_HERE' ? 501
        : result.code === 'ADAPTER_CONTRACT_VIOLATION' ? 422
          : result.code === 'UNKNOWN_DEVICE' ? 400 : 422;
      const note = (result.parsed.summary.notes || [])[0];
      return { ok: false, status: status, error: note || 'We could not read that file.' };
    }

    if (!result.parsed.days.length) {
      // An empty parse is not the same as a broken one. Say which.
      const note = (result.parsed.summary.notes || [])[0];
      return {
        ok: false,
        status: 422,
        error: note || 'No daily readings were found in that file. Make sure you exported your full ' + deviceLabel + ' history.'
      };
    }

    return {
      ok: true,
      parsed: result.parsed,
      sha256: sha256,
      fileName: fileName,
      provider: provider,
      extraction: null
    };
  }

  /**
   * GET /api/wearables/devices
   * Drives the device picker. Returns what each device can and cannot give us, so
   * the member is told BEFORE they upload rather than left to infer it from a
   * half-empty report afterwards.
   */
  router.get('/devices', verifyToken, limit(60, 60000), (req, res) => {
    if (!deviceRegistry) {
      return res.json({
        ok: true,
        devices: [{ id: 'whoop', label: 'Whoop', tier: 'full', ingest: ['zip', 'csv', 'pdf'] }],
        budgetBands: [],
        available: adapterRegistry.availableProviders()
      });
    }
    const available = adapterRegistry.availableProviders();
    res.json({
      ok: true,
      devices: deviceRegistry.listDevices().map((d) => ({
        id: d.id,
        label: d.label,
        shortLabel: d.shortLabel,
        brand: d.brand,
        tier: d.tier,
        ingest: d.ingest,
        exportInstructions: d.exportInstructions,
        caveats: d.caveats,
        // Whether THIS deployment can actually parse it right now, as opposed to
        // whether the device is known to us in principle.
        supported: available.indexOf(d.id) !== -1
          || (Array.isArray(d.ingest) && d.ingest.indexOf('screenshot') !== -1 && !!deviceVision)
      })),
      budgetBands: typeof deviceRegistry.listBudgetBands === 'function'
        ? deviceRegistry.listBudgetBands()
        : [],
      available: available
    });
  });

  /**
   * POST /api/wearables/native/health-connect
   *
   * The in-app native bridge: the Capacitor build reads Health Connect (Android) or
   * HealthKit (iOS) and POSTs daily aggregates as JSON. This is the route that makes
   * Apple, Samsung and every Android band that writes to Health Connect work without
   * asking a member to export a file at all — see docs/NATIVE_HEALTH_BRIDGE.md.
   *
   * Payloads are small (daily aggregates, not raw samples), so the ordinary
   * express.json path is fine. Only Apple's XML export needs a streaming endpoint.
   */
  router.post('/native/health-connect', verifyToken, limit(30, 60000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const hc = adapterRegistry.loadAdapter('health_connect');
      if (!hc) return res.status(501).json({ error: 'Native health sync is not available on this deployment.' });

      const payload = req.body && typeof req.body === 'object' ? req.body : null;
      if (!payload) return res.status(400).json({ error: 'No sync payload was sent.' });

      const parsed = hc.parse(payload, {});
      const verdict = canonicalDay.validateParsedExport(parsed);
      if (!verdict.ok) {
        console.error('[wearables health-connect] contract violation:', verdict.errors.slice(0, 8));
        return res.status(422).json({ error: 'That sync payload could not be read, so nothing was saved.' });
      }
      if (!parsed.days.length) {
        const note = (parsed.summary.notes || [])[0];
        return res.status(422).json({ error: note || 'That sync payload contained no daily readings.' });
      }

      // Idempotency. The app re-sends overlapping windows on every sync, and the
      // envelope carries a fresh `exportedAt` each time — hashing the raw body would
      // therefore produce a new sha256 for identical data and defeat the duplicate
      // check entirely. Hash the DAYS instead, so a re-sync of unchanged readings is
      // correctly recognised as one it has already stored.
      const idempotencyBasis = JSON.stringify({
        provider: 'health_connect',
        days: parsed.days
      });
      const sha256 = crypto.createHash('sha256').update(idempotencyBasis).digest('hex');

      const result = await readinessService.commitUpload(db, {
        userId,
        provider: 'health_connect',
        fileName: 'health-connect-sync.json',
        sha256,
        parsed
      });
      if (!result || !result.ok) return res.status(500).json({ error: 'Could not save that sync.' });

      if (result.duplicate) {
        return res.json({ ok: true, duplicate: true, days: 0, message: 'Already up to date.' });
      }

      await readinessService.optIn(db, { userId, provider: 'health_connect' }).catch(() => {});
      const autofill = await readinessService
        .autoPopulateCheckinRange(db, { userId, dates: parsed.days.map((d) => d.date) })
        .catch(() => null);

      res.json(Object.assign({ ok: true, duplicate: false }, result, {
        partial: result.status === 'pending',
        checkinsAutoFilled: (autofill && autofill.filled) || 0,
        notes: parsed.summary.notes || []
      }));
    } catch (e) {
      console.error('[wearables health-connect]', e && e.message);
      res.status(500).json({ error: 'Could not save that sync. Please try again.' });
    }
  });

  /** POST /api/wearables/upload/preview — reads, writes nothing. */
  router.post('/upload/preview', verifyToken, limit(10, 60000), async (req, res) => {
    try {
      const decoded = await decodeForDevice(req.body, String(req.user.id));
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });

      const { parsed, sha256, fileName, provider, extraction } = decoded;
      const preview = await readinessService.previewUpload(db, {
        userId: String(req.user.id),
        parsed,
        provider,
        sha256
      });

      res.json(Object.assign({
        ok: true,
        device: provider,
        fileName,
        sha256,
        extraction: extraction || null
      }, preview, {
        rowsRejected: parsed.summary.rowsRejected,
        unknownColumns: unknownColumnNames(preview.unknownColumns, parsed.summary.unknownColumns),
        unknownColumnsDetail: parsed.summary.unknownColumns || [],
        duplicates: parsed.summary.duplicates || [],
        implausible: parsed.summary.implausible || [],
        notes: parsed.summary.notes || [],
        message: parsed.summary.message || null,
        workouts: parsed.workouts.length,
        journal: parsed.journal.length
      }));
    } catch (e) {
      console.error('[wearables upload preview]', e && e.message);
      res.status(500).json({ error: 'Could not read that file. Please try again.' });
    }
  });

  /** POST /api/wearables/upload/commit — same file, now written. */
  router.post('/upload/commit', verifyToken, limit(10, 60000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const decoded = await decodeForDevice(req.body, String(req.user.id));
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });

      const { parsed, sha256, fileName, provider, extraction } = decoded;
      const result = await readinessService.commitUpload(db, {
        userId, provider, fileName, sha256, parsed
      });
      if (!result || !result.ok) return res.status(500).json({ error: 'Could not save that file.' });

      if (result.duplicate) {
        return res.json({ ok: true, device: provider, duplicate: true, message: 'You have already uploaded this file — nothing changed.' });
      }

      await readinessService.optIn(db, { userId, provider }).catch(() => {});

      const autofill = await readinessService
        .autoPopulateCheckinRange(db, { userId, dates: parsed.days.map((d) => d.date) })
        .catch(() => null);

      const partial = result.status === 'pending';
      const payload = Object.assign({ ok: true, device: provider, duplicate: false }, result, {
        partial,
        extraction: extraction || null,
        checkinsAutoFilled: (autofill && autofill.filled) || 0,
        unknownColumns: unknownColumnNames(result.unknownColumns, parsed.summary.unknownColumns),
        unknownColumnsDetail: parsed.summary.unknownColumns || []
      });
      if (partial) {
        payload.message = 'Part of that file could not be saved. Upload it again to finish the import.';
      }
      res.json(payload);
    } catch (e) {
      console.error('[wearables upload commit]', e && e.message);
      res.status(500).json({ error: 'Could not save that file. Please try again.' });
    }
  });

  // ---- Readiness (works for Whoop and non-Whoop members alike) -------------

  router.get('/readiness', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      const userId = String(req.user.id);
      const { from, to, date } = req.query;

      if (date) {
        const row = await readinessService.getReadiness(db, { userId, date: String(date) });
        return res.json({ readiness: row || null });
      }
      if (from && to) {
        const rows = await readinessService.getReadinessRange(db, { userId, from: String(from), to: String(to) });
        return res.json({ readiness: rows || [] });
      }
      return res.status(400).json({ error: 'Provide either ?date= or ?from=&to=' });
    } catch (e) {
      console.error('[wearables readiness]', e.message);
      res.status(500).json({ error: 'Could not load readiness.' });
    }
  });

  /**
   * Compute (and persist) today's derived readiness — the non-Whoop path.
   * Returns null rather than a fabricated score when there isn't enough data.
   */
  router.post('/readiness/derive', verifyToken, limit(20, 60000), async (req, res) => {
    try {
      const date = String((req.body || {}).date || '').slice(0, 10) || null;
      const r = await readinessService.computeDerivedReadiness(db, {
        userId: String(req.user.id),
        date: date || undefined
      });
      res.json({ ok: true, derived: r || null });
    } catch (e) {
      console.error('[wearables derive]', e.message);
      res.status(500).json({ error: 'Could not compute readiness.' });
    }
  });

  // ---- Workouts & journal (persisted by the upload commit) -----------------

  /**
   * ?from=&to= — either bound alone (or ?date=) means a single day. Optional ?limit=.
   * @returns {{from:string, to:string, limit:number|undefined}|null} null when unusable.
   */
  function rangeQuery(q) {
    const src = q || {};
    const date = String(src.date || '').slice(0, 10);
    const from = String(src.from || date || '').slice(0, 10);
    const to = String(src.to || date || '').slice(0, 10);
    if (!from && !to) return null;
    const max = parseInt(String(src.limit || ''), 10);
    return { from: from || to, to: to || from, limit: Number.isFinite(max) && max > 0 ? max : undefined };
  }

  // The three readers below back the member, admin and operator mounts alike — every
  // one of them is a pure read, so the only thing that differs is whose id is used.

  async function sendReadinessRange(res, userId, q) {
    const range = rangeQuery(q);
    if (!range) return res.status(400).json({ error: 'Provide ?from=&to= or ?date=' });
    const rows = await readinessService.getReadinessRange(db, { userId, from: range.from, to: range.to });
    return res.json({ from: range.from, to: range.to, readiness: rows || [] });
  }

  async function sendWorkouts(res, userId, q) {
    const range = rangeQuery(q);
    if (!range) return res.status(400).json({ error: 'Provide ?from=&to= or ?date=' });
    const workouts = await readinessService.getWorkoutsRange(db, {
      userId,
      provider: PROVIDER,
      from: range.from,
      to: range.to,
      limit: range.limit
    });
    return res.json({ from: range.from, to: range.to, workouts: workouts || [] });
  }

  async function sendJournal(res, userId, q) {
    const range = rangeQuery(q);
    if (!range) return res.status(400).json({ error: 'Provide ?from=&to= or ?date=' });
    const journal = await readinessService.getJournalRange(db, {
      userId,
      provider: PROVIDER,
      from: range.from,
      to: range.to,
      limit: range.limit
    });
    return res.json({ from: range.from, to: range.to, journal: journal || [] });
  }

  router.get('/workouts', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      await sendWorkouts(res, String(req.user.id), req.query);
    } catch (e) {
      console.error('[wearables workouts]', e.message);
      res.status(500).json({ error: 'Could not load your workouts.' });
    }
  });

  router.get('/journal', verifyToken, limit(60, 60000), async (req, res) => {
    try {
      await sendJournal(res, String(req.user.id), req.query);
    } catch (e) {
      console.error('[wearables journal]', e.message);
      res.status(500).json({ error: 'Could not load your journal answers.' });
    }
  });

  // ---- AI report -----------------------------------------------------------

  /**
   * The member's own report and a coach's report for a client are the same report.
   * Only the id differs: every figure still comes from the stats engine before the
   * model is called, and is validated back afterwards.
   */
  async function sendNarrativeReport(res, userId, body) {
    const b = body || {};
    const to = String(b.to || '').slice(0, 10);
    const from = String(b.from || '').slice(0, 10);
    if (!from || !to) return res.status(400).json({ error: 'A from and to date are required.' });

    const rows = await readinessService.getReadinessRange(db, { userId, from, to });
    if (!rows || rows.length < 7) {
      return res.status(400).json({ error: 'At least 7 days of data are needed for a report.' });
    }

    const user = await queryOne('SELECT first_name, last_name FROM users WHERE id = ?', [userId]);
    const memberLabel = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : '';

    // Every number in the report originates here, in plain arithmetic. The window
    // the member asked for is the coverage denominator — not the span of the rows
    // that came back, which would report 100% for any gap-free run of days.
    const stats = computeWhoopStats(rows, statsOptions(memberLabel, from, to));

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return res.status(503).json({ error: 'Report generation is not configured.' });

    const out = await generateWhoopReport({ stats, member: { name: memberLabel }, apiKey });
    recordAiUsage({ scope: 'whoop_report', usage: out.usage, model: out.model });

    return res.json({
      ok: true,
      stats,
      report: out.report,
      // Surfaced deliberately: a report whose numbers failed validation is
      // returned flagged rather than silently presented as verified.
      validation: out.validation,
      usage: out.usage,
      model: out.model
    });
  }

  /**
   * POST /api/wearables/report  { from, to }
   * Deterministic stats first; Claude writes prose only; numbers validated back.
   */
  router.post('/report', verifyToken, limit(5, 300000), async (req, res) => {
    try {
      await sendNarrativeReport(res, String(req.user.id), req.body);
    } catch (e) {
      console.error('[wearables report]', e.message);
      res.status(500).json({ error: 'Could not generate that report right now.' });
    }
  });

  /**
   * Renders the branded PDF for whoever `userId` names. Works with NO Anthropic key
   * configured — the stats-only document is fully valid, since every figure in it is
   * computed deterministically and needs no model. The narrative is additive.
   */
  async function sendReportPdf(res, userId, opts) {
    const os = require('os');
    const fsp = require('fs');
    const pathMod = require('path');
    const b = opts || {};
    let tmpPath = null;
    try {
      const from = String(b.from || '').slice(0, 10);
      const to = String(b.to || '').slice(0, 10);
      if (!from || !to) return res.status(400).json({ error: 'A from and to date are required.' });

      const rows = await readinessService.getReadinessRange(db, { userId, from, to });
      if (!rows || rows.length < 7) {
        return res.status(400).json({ error: 'At least 7 days of data are needed for a report.' });
      }

      const user = await queryOne('SELECT first_name, last_name, email FROM users WHERE id = ?', [userId]);
      const memberName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Member';
      const stats = computeWhoopStats(rows, statsOptions(memberName, from, to));

      // Narrative is best-effort: a model failure must not cost the member their
      // report — and neither must a slow one. generateWhoopReport can retry a
      // validation failure up to three times at a 5-minute per-call ceiling, which
      // outlives the proxy timeout and takes the (fully valid) stats-only PDF down
      // with it. Ship the document when the budget is spent.
      let report = null;
      let validation = null;
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (apiKey && b.includeNarrative !== false) {
        let budgetTimer = null;
        try {
          const out = await Promise.race([
            generateWhoopReport({ stats, member: { name: memberName }, apiKey }),
            new Promise((_, reject) => {
              budgetTimer = setTimeout(() => reject(new Error('narrative budget exceeded')), PDF_NARRATIVE_BUDGET_MS);
            })
          ]);
          report = out.report;
          validation = out.validation;
        } catch (e) {
          console.warn('[wearables pdf narrative]', e.message);
        } finally {
          if (budgetTimer) clearTimeout(budgetTimer);
        }
      }

      tmpPath = pathMod.join(os.tmpdir(), `bb-whoop-${userId.slice(0, 8)}-${Date.now()}.pdf`);
      const built = await buildWhoopReportPdf(
        { member: { name: memberName, email: user && user.email }, stats, report, validation, generatedAt: new Date().toISOString() },
        tmpPath
      );
      if (!built || !built.ok) {
        // Returning here skips the catch, so unlink explicitly or every failure
        // leaves a stray PDF in os.tmpdir() forever.
        try { fsp.unlinkSync(tmpPath); } catch (_) {}
        return res.status(500).json({ error: 'Could not build that report.' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(built.bytes));
      res.setHeader('Content-Disposition', `attachment; filename="bodybank-readiness-${from}-to-${to}.pdf"`);
      const stream = fsp.createReadStream(tmpPath);
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.on('close', () => { try { fsp.unlinkSync(tmpPath); } catch (_) {} });
      return stream.pipe(res);
    } catch (e) {
      console.error('[wearables pdf]', e.message);
      if (tmpPath) { try { require('fs').unlinkSync(tmpPath); } catch (_) {} }
      if (!res.headersSent) return res.status(500).json({ error: 'Could not build that report.' });
      return res.end();
    }
  }

  /**
   * POST /api/wearables/report/pdf  { from, to, includeNarrative }
   */
  router.post('/report/pdf', verifyToken, limit(5, 300000), async (req, res) => {
    await sendReportPdf(res, String(req.user.id), req.body || {});
  });

  // ---- Admin / coach read-only --------------------------------------------

  // A request with no window used to fall through to getReadinessRange and come back
  // as an empty array, which reads as "this member has no data" rather than "you
  // forgot the dates". sendReadinessRange answers 400 instead.
  router.get('/admin/:userId/readiness', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      await sendReadinessRange(res, String(req.params.userId), req.query);
    } catch (e) {
      console.error('[wearables admin readiness]', e.message);
      res.status(500).json({ error: 'Could not load readiness.' });
    }
  });

  router.get('/admin/:userId/workouts', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      await sendWorkouts(res, String(req.params.userId), req.query);
    } catch (e) {
      console.error('[wearables admin workouts]', e.message);
      res.status(500).json({ error: 'Could not load workouts.' });
    }
  });

  router.get('/admin/:userId/journal', verifyToken, requireAdminOrSuperadmin, limit(60, 60000), async (req, res) => {
    try {
      await sendJournal(res, String(req.params.userId), req.query);
    } catch (e) {
      console.error('[wearables admin journal]', e.message);
      res.status(500).json({ error: 'Could not load journal answers.' });
    }
  });

  // A coach reviewing a roster pulls more of these than a member ever does, so the
  // window is the same 5 minutes but the allowance is per-coach, not per-client.
  router.post('/admin/:userId/report', verifyToken, requireAdminOrSuperadmin, limit(20, 300000), async (req, res) => {
    try {
      await sendNarrativeReport(res, String(req.params.userId), req.body);
    } catch (e) {
      console.error('[wearables admin report]', e.message);
      res.status(500).json({ error: 'Could not generate that report right now.' });
    }
  });

  router.post('/admin/:userId/report/pdf', verifyToken, requireAdminOrSuperadmin, limit(20, 300000), async (req, res) => {
    await sendReportPdf(res, String(req.params.userId), req.body || {});
  });

  // ---- Operator read-only --------------------------------------------------
  // Monitoring only. Every route below is a pure GET gated by operatorOnly; nothing
  // here may ever mutate a member's health record.

  router.get('/operator/:userId/readiness', verifyToken, operatorOnly, limit(60, 60000), async (req, res) => {
    try {
      await sendReadinessRange(res, String(req.params.userId), req.query);
    } catch (e) {
      console.error('[wearables operator readiness]', e.message);
      res.status(500).json({ error: 'Could not load readiness.' });
    }
  });

  router.get('/operator/:userId/workouts', verifyToken, operatorOnly, limit(60, 60000), async (req, res) => {
    try {
      await sendWorkouts(res, String(req.params.userId), req.query);
    } catch (e) {
      console.error('[wearables operator workouts]', e.message);
      res.status(500).json({ error: 'Could not load workouts.' });
    }
  });

  router.get('/operator/:userId/journal', verifyToken, operatorOnly, limit(60, 60000), async (req, res) => {
    try {
      await sendJournal(res, String(req.params.userId), req.query);
    } catch (e) {
      console.error('[wearables operator journal]', e.message);
      res.status(500).json({ error: 'Could not load journal answers.' });
    }
  });

  /**
   * GET /api/wearables/operator/:userId/report/pdf?from=&to=
   *
   * A GET, and deliberately narrative-free: monitoring gets the deterministic
   * document, every figure of which the stats engine computed. That keeps the
   * operator surface a pure read — no model call, no spend, nothing written.
   */
  router.get('/operator/:userId/report/pdf', verifyToken, operatorOnly, limit(20, 300000), async (req, res) => {
    const q = req.query || {};
    await sendReportPdf(res, String(req.params.userId), { from: q.from, to: q.to, includeNarrative: false });
  });

  return router;
}

module.exports = { createWearablesRouter };
