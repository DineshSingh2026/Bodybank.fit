'use strict';

/**
 * BodyBank — GRADED HEALTH REPORT: persistence and orchestration.
 *
 * The only module that knows both the database and the graded engines. Everything
 * below it is pure; everything above it is routing and UI.
 *
 *   blood_analysis_reports.extracted_blood_data  (UNCHANGED, the lab truth)
 *            │
 *            ├─▶ buildGradedHealthReport()  ─▶ graded_report   (engine output)
 *            │
 *            ├─▶ buildGradedDoc()           ─▶ graded_doc      (reviewer edits this)
 *            │
 *            └─▶ buildGradedReportPdf()     ─▶ graded_pdf_path (what the client gets)
 *
 * ─── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────
 * `ai_report`, `pdf_path`, `extracted_blood_data`, `nutrition_snapshot` and every
 * AI-usage column belong to the classic pipeline and are only ever READ here. A
 * client on the classic variant is unaffected by anything in this file, and
 * switching a report to the graded variant does not disturb its classic output —
 * both can exist side by side on the same row.
 *
 * ─── NO AI, NO COST ───────────────────────────────────────────────────────────
 * Everything here runs off data already extracted and paid for. Regenerating a
 * graded report, switching a report to the graded variant, or resetting an edited
 * document costs nothing and calls no model. That is what makes the variant switch
 * safe to offer as a button.
 */

const fs = require('fs');
const path = require('path');

const { buildGradedHealthReport } = require('./gradedHealthReport');
const gradedDoc = require('./gradedReportDocument');
const { buildGradedReportPdf } = require('./gradedReportPdfKit');
const { resolveStoredUploadPath } = require('./bloodAnalysisService');
const completeDoc = require('./completeReportDocument');
const { buildCompleteReportPdf } = require('./completeReportPdfKit');

/**
 * 'classic'  the standard health report (services/bloodAnalysisService.js)
 * 'graded'   the Health Map report
 * 'complete' Health Map 360: the Health Map plus a doctor's signed summary,
 *            cross-marker patterns, a personal reading, a nutrition plan and a
 *            retest plan. Built from the SAME graded_report; it has its own
 *            document and PDF columns, so the Health Map's are never touched.
 */
const VARIANTS = ['classic', 'graded', 'complete'];

/** Does this variant print from the graded engines (rather than the classic pipeline)? */
function usesGradedEngine(variant) {
  const v = normalizeVariant(variant);
  return v === 'graded' || v === 'complete';
}

/** Normalise a variant value from a request or a database row. */
function normalizeVariant(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return VARIANTS.indexOf(s) >= 0 ? s : 'classic';
}

function parseJsonCol(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (_) { return null; }
}

/** The date this report sits at on the client's timeline. */
function effectiveDate(row) {
  if (!row) return '';
  const d = row.report_date || row.created_at;
  if (!d) return '';
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  return String(s).slice(0, 10);
}

function hasExtraction(row) {
  const ex = parseJsonCol(row && row.extracted_blood_data);
  return !!(ex && Array.isArray(ex.panels) && ex.panels.length);
}

function outputPathFor(reportId, prefix) {
  const uploadsRoot = path.resolve(
    process.cwd(),
    String(process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, '')
  );
  // Same directory as every other generated report, which is already 404'd ahead of
  // the public /uploads static mount in server.js. Anything written elsewhere under
  // uploads/ would be world-readable.
  const outDir = path.join(uploadsRoot, 'health-reports');
  fs.mkdirSync(outDir, { recursive: true });
  return path.join(outDir, `${prefix || 'BodyBank_HealthMap'}_${reportId}_${Date.now()}.pdf`);
}

// ---------------------------------------------------------------------------
// Health Map 360: what the client told us, and who signs
// ---------------------------------------------------------------------------

/**
 * Everything the client told us, for the personal sections of the 360 edition.
 * A BloodMap order carries a full intake; a BodyBank member's profile supplies
 * what it can. Missing answers simply leave their sections out.
 */
async function completeContextFor(db, row) {
  let intake = {};
  let order = null;
  try {
    order = await db.queryOne(`SELECT intake, age, gender FROM bloodmap_orders WHERE report_id = ?`, [row.id]);
    intake = (order && parseJsonCol(order.intake)) || {};
  } catch (_) { /* BloodMap tables are optional */ }
  let user = null;
  try {
    user = await db.queryOne(`SELECT goal_type, diet_type, height_cm FROM users WHERE id = ?`, [row.user_id]);
  } catch (_) { /* profile columns are optional */ }
  const dietOf = (v) => {
    const s = String(v || '').toLowerCase();
    if (/vegan/.test(s)) return 'vegan';
    if (/egg/.test(s)) return 'egg';
    if (/non/.test(s)) return 'nonveg';
    if (/veg/.test(s)) return 'veg';
    return '';
  };
  return {
    age: row.user_age || (order && order.age) || '',
    sex: row.user_gender || (order && order.gender) || '',
    goal: intake.goal || row.user_goal || (user && user.goal_type) || '',
    medicines: intake.medicines || '',
    conditions: intake.conditions || '',
    diet: intake.diet || dietOf(user && user.diet_type),
    activity: intake.activity || '',
    alcohol: intake.alcohol || '',
    smoking: intake.smoking || '',
    fasting: intake.fasting || '',
    familyHistory: intake.familyHistory || [],
    symptoms: intake.symptoms || [],
    heightCm: intake.heightCm || (user && user.height_cm) || '',
    weightKg: intake.weightKg || ''
  };
}

/** The doctor whose name and signature go on a 360 report, from the consultant record. */
async function reviewingDoctor(db) {
  try {
    const d = await db.queryOne(
      `SELECT name, qualification, reg_no, signature FROM bloodmap_consultants WHERE role = 'doctor'`, []
    );
    if (!d) return null;
    let signature = null;
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(d.signature || ''));
    if (m) { try { signature = Buffer.from(m[2], 'base64'); } catch (_) { signature = null; } }
    return {
      name: String(d.name || '').trim(),
      qualification: String(d.qualification || '').trim(),
      regNo: String(d.reg_no || '').trim(),
      signature
    };
  } catch (_) {
    return null;
  }
}

/** Load, or build, the 360 document for a row. */
async function getCompleteDoc(db, row, opts) {
  const o = opts || {};
  const stored = parseJsonCol(row.complete_doc);
  if (stored && !o.forceRebuild) {
    return {
      doc: completeDoc.sanitizeCompleteDoc(stored),
      edited: true,
      updatedAt: row.complete_doc_updated_at || null,
      updatedBy: row.complete_doc_updated_by || '',
      row
    };
  }
  let report = parseJsonCol(row.graded_report);
  if (!report || o.forceRebuild) {
    const built = await buildGradedReportFor(db, row.id);
    if (built.error) return { error: built.error };
    report = built.report;
  }
  const [context, doctor] = await Promise.all([completeContextFor(db, row), reviewingDoctor(db)]);
  const doc = completeDoc.sanitizeCompleteDoc(
    completeDoc.buildCompleteDoc(report, context, { coachNote: row.admin_notes || '', doctor: doctor || {} })
  );
  return { doc, edited: false, updatedAt: null, updatedBy: '', row, report };
}

/**
 * Has the doctor signed this report? A 360 report must be signed before it can be
 * delivered; the other variants have no sign-off and are always deliverable.
 * @returns {Promise<{variant:string, signed:boolean, error?:string}>}
 */
async function deliveryStatus(db, reportId) {
  const row = await db.queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return { variant: 'classic', signed: false, error: 'Report not found' };
  const variant = normalizeVariant(row.report_variant);
  if (variant !== 'complete') return { variant, signed: true };
  const loaded = await getCompleteDoc(db, row);
  if (loaded.error) return { variant, signed: false, error: loaded.error };
  if (completeDoc.isSigned(loaded.doc)) return { variant, signed: true };
  return {
    variant, signed: false,
    error: 'This Health Map 360 report has not been signed by the doctor yet. Open it in the editor, review it, tick the doctor sign-off and save.'
  };
}

/**
 * The client's previous processed screening, by LAB date, strictly before this one.
 *
 * Ordering is by `COALESCE(report_date, created_at::date)` — the same rule the rest
 * of the blood feature uses. Uploading a 2024 report today must place it in 2024, or
 * every trend arrow points the wrong way.
 */
async function previousReportFor(db, row) {
  if (!row) return null;
  const rows = await db.queryAll(
    `SELECT id, created_at, report_date, extracted_blood_data
     FROM blood_analysis_reports
     WHERE user_id = ?
       AND id <> ?
       AND COALESCE(report_date, created_at::date) < COALESCE(?::date, ?::date)
     ORDER BY COALESCE(report_date, created_at::date) DESC, created_at DESC
     LIMIT 5`,
    [row.user_id, row.id, row.report_date || null, effectiveDate(row) || null]
  );
  const usable = (rows || []).filter(hasExtraction);
  if (!usable.length) return null;
  const prev = usable[0];
  return { extracted: parseJsonCol(prev.extracted_blood_data), date: effectiveDate(prev), id: prev.id };
}

/** Client details for the report header, from the row snapshot plus the user record. */
async function clientFor(db, row) {
  const user = await db.queryOne(
    `SELECT id, first_name, last_name, email, gender FROM users WHERE id = ?`,
    [row.user_id]
  );
  const name = [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim()
    || (row.user_name || '')
    || (user && user.email)
    || 'Member';
  return {
    name,
    age: row.user_age || '',
    // The row snapshot is taken at upload time and is what the grade was computed
    // against; the live profile is only a fallback.
    sex: row.user_gender || (user && user.gender) || '',
    goal: row.user_goal || ''
  };
}

/**
 * Run the graded engines for one report and persist the result.
 * Pure computation over already-extracted data — no AI call, no cost.
 *
 * @returns {{ report:object }|{ error:string }}
 */
async function buildGradedReportFor(db, reportId) {
  const row = await db.queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return { error: 'Report not found' };

  const extracted = parseJsonCol(row.extracted_blood_data);
  if (!extracted || !Array.isArray(extracted.panels) || !extracted.panels.length) {
    return { error: 'This report has not been processed yet. Process it first, then build the graded report.' };
  }

  const client = await clientFor(db, row);
  const previous = await previousReportFor(db, row);

  const report = buildGradedHealthReport({
    extracted,
    previous,
    client,
    screeningDate: effectiveDate(row),
    reportId: row.id,
    aiReport: parseJsonCol(row.ai_report)
  });

  await db.run(
    `UPDATE blood_analysis_reports
     SET graded_report = ?::jsonb, engine_version = ?, ruleset_version = ?
     WHERE id = ?`,
    [JSON.stringify(report), report.engineVersion, report.rulesetVersion, reportId]
  );

  return { report, row };
}

/**
 * The document to render or edit.
 *
 * A stored document always wins — it is what the reviewer approved. NULL means
 * "never edited", and the default is built on the fly so the report is viewable the
 * moment it is processed, with no separate "generate" step.
 */
async function getGradedDoc(db, reportId, opts) {
  const o = opts || {};
  const row = await db.queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return { error: 'Report not found' };
  if (normalizeVariant(row.report_variant) === 'complete') return getCompleteDoc(db, row, o);

  const stored = parseJsonCol(row.graded_doc);
  if (stored && !o.forceRebuild) {
    return {
      doc: gradedDoc.sanitizeGradedDoc(stored),
      edited: true,
      updatedAt: row.graded_doc_updated_at || null,
      updatedBy: row.graded_doc_updated_by || '',
      row
    };
  }

  let report = parseJsonCol(row.graded_report);
  if (!report || o.forceRebuild) {
    const built = await buildGradedReportFor(db, reportId);
    if (built.error) return { error: built.error };
    report = built.report;
  }

  const doc = gradedDoc.sanitizeGradedDoc(
    gradedDoc.buildGradedDoc(report, { coachNote: row.admin_notes || '' })
  );
  return { doc, edited: false, updatedAt: null, updatedBy: '', row, report };
}

/**
 * Persist a reviewer's edits.
 *
 * Clearing `graded_pdf_path` is the important half: the next download regenerates
 * from the document just saved, so a client can never receive a PDF built from text
 * the reviewer has since changed.
 */
async function saveGradedDoc(db, reportId, incoming, who) {
  const row = await db.queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return { error: 'Report not found' };
  if (normalizeVariant(row.report_variant) === 'complete') return saveCompleteDoc(db, row, incoming, who);

  const doc = gradedDoc.sanitizeGradedDoc(incoming);
  if (!gradedDoc.docHasVisibleContent(doc)) {
    return { error: 'This report would be empty. Keep at least one visible section.' };
  }

  const coachNote = gradedDoc.docCoachNote(doc);

  await db.run(
    `UPDATE blood_analysis_reports
     SET graded_doc = ?::jsonb,
         graded_doc_updated_at = CURRENT_TIMESTAMP,
         graded_doc_updated_by = ?,
         graded_pdf_path = NULL,
         admin_notes = ?
     WHERE id = ?`,
    [JSON.stringify(doc), String(who || '').slice(0, 200), coachNote.slice(0, 8000), reportId]
  );

  return { doc, edited: true };
}

/**
 * Discard a reviewer's edits and go back to what the engines produced.
 * The grades themselves never changed — only the words around them.
 */
async function resetGradedDoc(db, reportId) {
  const row = await db.queryOne(`SELECT id, report_variant FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return { error: 'Report not found' };
  if (normalizeVariant(row.report_variant) === 'complete') {
    await db.run(
      `UPDATE blood_analysis_reports
       SET complete_doc = NULL, complete_doc_updated_at = NULL, complete_doc_updated_by = '', complete_pdf_path = NULL
       WHERE id = ?`,
      [reportId]
    );
    return getGradedDoc(db, reportId);
  }
  await db.run(
    `UPDATE blood_analysis_reports
     SET graded_doc = NULL, graded_doc_updated_at = NULL, graded_doc_updated_by = '', graded_pdf_path = NULL
     WHERE id = ?`,
    [reportId]
  );
  return getGradedDoc(db, reportId);
}

/**
 * An absolute path to the graded PDF, rendering it if the file is missing.
 *
 * Mirrors `ensureHealthReportPdf` for the classic variant: a PDF that vanished with
 * a redeploy, or was cleared by an edit, is rebuilt from the stored document rather
 * than reported as broken.
 */
async function ensureGradedPdf(db, reportId) {
  const row = await db.queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return null;
  if (normalizeVariant(row.report_variant) === 'complete') return ensureCompletePdf(db, row);

  const existing = row.graded_pdf_path ? resolveStoredUploadPath(String(row.graded_pdf_path).trim()) : null;
  if (existing && fs.existsSync(existing)) {
    if (existing !== String(row.graded_pdf_path || '').trim()) {
      await db.run(`UPDATE blood_analysis_reports SET graded_pdf_path = ? WHERE id = ?`, [existing, reportId])
        .catch(() => {});
    }
    return existing;
  }

  const loaded = await getGradedDoc(db, reportId);
  if (loaded.error || !loaded.doc) return null;

  const out = outputPathFor(reportId);
  try {
    await buildGradedReportPdf(loaded.doc, out);
  } catch (e) {
    console.error('[gradedReport] PDF render failed:', e && e.message);
    return null;
  }
  await db.run(`UPDATE blood_analysis_reports SET graded_pdf_path = ? WHERE id = ?`, [out, reportId])
    .catch(() => {});
  return out;
}

/**
 * Persist a reviewer's edits to a 360 document.
 *
 * The sign-off is the one part of the document the browser does not control. The
 * doctor's name, qualification and registration number are copied from the
 * consultant record here, and the moment of signing and the staff account that
 * ticked it are stamped here. A report cannot be signed until that record is complete.
 */
async function saveCompleteDoc(db, row, incoming, who) {
  const doc = completeDoc.sanitizeCompleteDoc(incoming);
  if (!gradedDoc.docHasVisibleContent(doc)) {
    return { error: 'This report would be empty. Keep at least one visible section.' };
  }

  const sign = completeDoc.signoffOf(doc);
  if (sign) {
    const doctor = await reviewingDoctor(db);
    const before = completeDoc.signoffOf(completeDoc.sanitizeCompleteDoc(parseJsonCol(row.complete_doc) || {}));
    if (doctor) {
      sign.doctorName = doctor.name;
      sign.qualification = doctor.qualification;
      sign.regNo = doctor.regNo;
    }
    if (sign.signed) {
      if (!doctor || !doctor.name || !doctor.qualification || !doctor.regNo) {
        return { error: 'Add the doctor\'s name, qualification and registration number under BloodMap staff page > Consultants before signing a report.' };
      }
      const wasSigned = !!(before && before.signed && before.signedAt);
      sign.signedAt = wasSigned ? before.signedAt : new Date().toISOString();
      sign.signedBy = wasSigned ? before.signedBy : String(who || '').slice(0, 200);
    } else {
      sign.signedAt = '';
      sign.signedBy = '';
    }
  }

  const coachNote = gradedDoc.docCoachNote(doc);
  await db.run(
    `UPDATE blood_analysis_reports
     SET complete_doc = ?::jsonb,
         complete_doc_updated_at = CURRENT_TIMESTAMP,
         complete_doc_updated_by = ?,
         complete_pdf_path = NULL,
         admin_notes = ?
     WHERE id = ?`,
    [JSON.stringify(doc), String(who || '').slice(0, 200), coachNote.slice(0, 8000), row.id]
  );
  return { doc, edited: true };
}

/** An absolute path to the 360 PDF, rendering it if the file is missing. */
async function ensureCompletePdf(db, row) {
  const existing = row.complete_pdf_path ? resolveStoredUploadPath(String(row.complete_pdf_path).trim()) : null;
  if (existing && fs.existsSync(existing)) return existing;

  const loaded = await getCompleteDoc(db, row);
  if (loaded.error || !loaded.doc) return null;
  const doctor = await reviewingDoctor(db);

  const out = outputPathFor(row.id, 'BodyBank_HealthMap360');
  try {
    await buildCompleteReportPdf(loaded.doc, out, { signature: doctor && doctor.signature });
  } catch (e) {
    console.error('[completeReport] PDF render failed:', e && e.message);
    return null;
  }
  await db.run(`UPDATE blood_analysis_reports SET complete_pdf_path = ? WHERE id = ?`, [out, row.id])
    .catch(() => {});
  return out;
}

/**
 * Switch a report between the variants.
 *
 * Re-runs only the graded engines over the SAVED extraction — no re-extraction, no
 * re-analysis, no AI call, no cost. This is the recovery path for "we picked the
 * wrong variant at upload", and it is why picking one is a low-stakes decision.
 */
async function setVariant(db, reportId, variant) {
  const want = normalizeVariant(variant);
  const row = await db.queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
  if (!row) return { error: 'Report not found' };

  if (usesGradedEngine(want) && !hasExtraction(row)) {
    return { error: 'Process this report first — the graded report is built from the extracted results.' };
  }

  await db.run(`UPDATE blood_analysis_reports SET report_variant = ? WHERE id = ?`, [want, reportId]);

  if (usesGradedEngine(want) && !parseJsonCol(row.graded_report)) {
    const built = await buildGradedReportFor(db, reportId);
    if (built.error) return { error: built.error };
  }
  return { variant: want };
}

/**
 * The PDF a client should receive for this report, whichever variant it is on.
 * Callers that download or email a report go through here so the two paths cannot
 * drift apart.
 * @returns {Promise<{path:string, filename:string, variant:string}|null>}
 */
async function reportPdfFor(db, reportId, ensureClassicPdf) {
  const row = await db.queryOne(
    `SELECT id, user_name, report_variant FROM blood_analysis_reports WHERE id = ?`, [reportId]
  );
  if (!row) return null;
  const variant = normalizeVariant(row.report_variant);

  if (variant === 'complete') {
    const p = await ensureGradedPdf(db, reportId);
    if (!p) return null;
    return { path: p, filename: 'BodyBank_Health_Map_360_Report.pdf', variant };
  }
  if (variant === 'graded') {
    const p = await ensureGradedPdf(db, reportId);
    if (!p) return null;
    return { path: p, filename: 'BodyBank_Health_Map_Report.pdf', variant };
  }
  const p = await ensureClassicPdf(db, reportId);
  if (!p) return null;
  return { path: p, filename: 'BodyBank_Health_Report.pdf', variant };
}

module.exports = {
  VARIANTS,
  normalizeVariant,
  usesGradedEngine,
  deliveryStatus,
  completeContextFor,
  effectiveDate,
  hasExtraction,
  previousReportFor,
  buildGradedReportFor,
  getGradedDoc,
  saveGradedDoc,
  resetGradedDoc,
  ensureGradedPdf,
  setVariant,
  reportPdfFor
};
