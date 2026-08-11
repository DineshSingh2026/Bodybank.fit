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
    PDF_AI_UNAVAILABLE: 503
    // PDF_UNREADABLE and PDF_NO_DATA describe the document's content, not a transport
    // fault, so they take the 422 default below.
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
