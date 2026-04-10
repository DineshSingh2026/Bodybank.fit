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

module.exports = { generateHealthReportPdf, pythonExecutable };
