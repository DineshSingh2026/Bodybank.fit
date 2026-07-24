'use strict';

const path = require('path');
const fs = require('fs');
const { buildHealthReportPdf } = require('./healthReportPdfKit');
const { buildComparisonReportPdf } = require('./comparisonReportPdfKit');

function outputPathFor(payload) {
  const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
  const outDir = path.join(uploadsRoot, 'health-reports');
  fs.mkdirSync(outDir, { recursive: true });
  return path.join(outDir, `BodyBank_Report_${(payload && payload.reportId) || 'r'}_${Date.now()}.pdf`);
}

function comparisonOutputPathFor(payload) {
  const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
  const outDir = path.join(uploadsRoot, 'health-reports');
  fs.mkdirSync(outDir, { recursive: true });
  return path.join(outDir, `BodyBank_Progress_${(payload && payload.comparisonId) || 'c'}_${Date.now()}.pdf`);
}

/**
 * Generate the branded longitudinal PROGRESS report (blood-report comparison).
 * @returns {Promise<string>} absolute path to generated PDF
 */
function generateComparisonReportPdf(payload) {
  return buildComparisonReportPdf(payload, comparisonOutputPathFor(payload));
}

/**
 * Generate the branded health-report PDF. Pure Node (PDFKit) — no Python/ReportLab,
 * so it renders identically on any host (Render native Node included).
 * @returns {Promise<string>} absolute path to generated PDF
 */
function generateHealthReportPdf(payload) {
  return buildHealthReportPdf(payload, outputPathFor(payload));
}

// Kept for API compatibility with existing callers (bloodAnalysisService).
// There is no longer a separate fallback engine — the Node generator IS the engine.
function generateHealthReportPdfWithFallback(payload) {
  return generateHealthReportPdf(payload);
}

module.exports = {
  generateHealthReportPdf,
  generateHealthReportPdfWithFallback,
  generateComparisonReportPdf
};
