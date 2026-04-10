'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function pythonExecutable() {
  const fromEnv = (process.env.PYTHON_PATH || process.env.PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Writes JSON payload and runs ReportLab script. Expects keys: user, blood_analysis, ai_report; optional nutrition_analysis.
 * @returns {Promise<string>} absolute path to generated PDF
 */
function generateHealthReportPdf(payload) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'generate_health_report.py');
  const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
  const outDir = path.join(uploadsRoot, 'health-reports');
  fs.mkdirSync(outDir, { recursive: true });

  const tmpData = path.join(os.tmpdir(), `bb_health_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  const outPdf = path.join(outDir, `BodyBank_Report_${payload.reportId || 'r'}_${Date.now()}.pdf`);

  fs.writeFileSync(tmpData, JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const py = pythonExecutable();
    const args = [scriptPath, '--data', tmpData, '--output', outPdf];
    const child = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      try {
        fs.unlinkSync(tmpData);
      } catch (_) {}
      reject(err);
    });
    child.on('close', (code) => {
      try {
        fs.unlinkSync(tmpData);
      } catch (_) {}
      if (code !== 0) {
        reject(new Error(stderr || stdout || `PDF subprocess exited ${code}`));
      } else {
        resolve(outPdf);
      }
    });
  });
}

/**
 * Same payload shape as generateHealthReportPdf; uses PDFKit (pure Node) for hosts without Python/ReportLab.
 * @returns {Promise<string>} absolute path to generated PDF
 */
function generateHealthReportPdfPdfKit(payload) {
  const PDFDocument = require('pdfkit');
  const uploadsRoot = path.resolve(process.cwd(), (process.env.UPLOADS_DIR || './uploads').replace(/^\.\//, ''));
  const outDir = path.join(uploadsRoot, 'health-reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPdf = path.join(outDir, `BodyBank_Report_${(payload && payload.reportId) || 'r'}_${Date.now()}_node.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const stream = fs.createWriteStream(outPdf);
    doc.pipe(stream);

    const user = (payload && payload.user) || {};
    const ai = (payload && payload.ai_report) || {};
    const blood = (payload && payload.blood_analysis) || {};
    const panels = Array.isArray(blood.panels) ? blood.panels : [];

    function paragraph(txt, size) {
      const t = String(txt == null ? '' : txt).replace(/\r\n/g, '\n');
      doc.fontSize(size || 10).fillColor('#222222').text(t, { width: 510, align: 'left' });
      doc.moveDown(0.4);
    }

    doc.fontSize(20).fillColor('#0d4d2d').text('BodyBank Health Report', { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(10).fillColor('#333333');
    paragraph(`Member: ${user.name || '—'}`);
    paragraph(`Age: ${user.age || '—'}    Gender: ${user.gender || '—'}    Goal: ${user.goal || '—'}`);
    doc.moveDown(0.3);
    doc.fontSize(13).text(`Overall status: ${ai.overall_status || '—'}`, { width: 510 });
    doc.moveDown(0.4);
    paragraph(ai.overall_summary_short || '');

    if (ai.clinical_interpretation) {
      doc.addPage();
      doc.fontSize(14).fillColor('#111111').text('Clinical interpretation', { underline: true });
      doc.moveDown(0.4);
      paragraph(ai.clinical_interpretation, 9);
    }

    const kf = Array.isArray(ai.key_findings) ? ai.key_findings : [];
    if (kf.length) {
      doc.addPage();
      doc.fontSize(14).text('Key findings', { underline: true });
      doc.moveDown(0.4);
      kf.slice(0, 25).forEach((f) => {
        paragraph(`• ${f.title || ''}: ${f.detail || ''}`, 9);
      });
    }

    const risks = Array.isArray(ai.risks) ? ai.risks : [];
    if (risks.length) {
      doc.addPage();
      doc.fontSize(14).text('Risks', { underline: true });
      doc.moveDown(0.4);
      risks.slice(0, 15).forEach((r) => {
        paragraph(`• ${r.area || ''} (${r.level || ''}): ${r.factors || ''}`, 9);
      });
    }

    if (panels.length) {
      doc.addPage();
      doc.fontSize(14).text('Blood test summary', { underline: true });
      doc.moveDown(0.4);
      panels.forEach((panel) => {
        doc.fontSize(11).text(String(panel.name || 'Panel'), { underline: true });
        doc.moveDown(0.25);
        const markers = Array.isArray(panel.markers) ? panel.markers : [];
        markers.forEach((m) => {
          const ref = m.reference != null ? m.reference : m.reference_range;
          const line = `${m.name || ''}: ${m.value != null ? m.value : ''} ${m.unit || ''}  (ref ${ref || '—'})  ${m.status || ''}`;
          paragraph(line, 8);
        });
        doc.moveDown(0.4);
      });
    }

    doc.moveDown(0.8);
    doc.fontSize(8).fillColor('#666666').text(
      'BodyBank health report. If the server uses the Node fallback engine, install Python + ReportLab for the full styled PDF.',
      { width: 510, align: 'center' }
    );

    doc.end();
    stream.on('finish', () => resolve(outPdf));
    stream.on('error', reject);
  });
}

async function generateHealthReportPdfWithFallback(payload) {
  try {
    return await generateHealthReportPdf(payload);
  } catch (err) {
    console.warn('[pdfService] ReportLab PDF failed; using Node PDFKit fallback:', err && err.message);
    return generateHealthReportPdfPdfKit(payload);
  }
}

module.exports = {
  generateHealthReportPdf,
  generateHealthReportPdfPdfKit,
  generateHealthReportPdfWithFallback,
  pythonExecutable
};
