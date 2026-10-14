'use strict';

/**
 * Generate the Signature sample reports from seeded data (no database).
 *
 *   node scripts/signature-samples.js                 -> docs/reports/performance-report-sample.pdf (2 weeks)
 *                                                        docs/reports/transformation-report-sample.pdf (monthly)
 *   node scripts/signature-samples.js --variant=empty  (or extreme) for the layout edge cases
 *   node scripts/signature-samples.js --ai             use the LLM narrative (needs ANTHROPIC_API_KEY)
 *   node scripts/signature-samples.js --out=<dir>      write somewhere else
 */

const fs = require('fs');
const path = require('path');
const { seedSignature } = require('../tests/fixtures/reports/signatureSeed');
const M = require('../services/signatureReports/model');
const N = require('../services/signatureReports/narrative');
const { renderReport } = require('../services/signatureReports/render');
const pdf = require('../services/reportPdf');

async function main() {
  const args = process.argv.slice(2);
  const ai = args.includes('--ai');
  const variant = (args.find((a) => a.startsWith('--variant=')) || '--variant=normal').split('=')[1];
  const outDir = (args.find((a) => a.startsWith('--out=')) || '').split('=')[1] || path.join(__dirname, '..', 'docs', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  for (const type of ['weekly', 'monthly']) {
    const seed = seedSignature(type, variant);
    const model = M.buildModel(seed.bundle, seed.extras, { previous: seed.previous, coachName: 'Kling' });
    const nar = await N.buildNarrative(model, { ai, userId: null });
    const res = await renderReport(model, nar, { pdf: true });
    const suffix = variant === 'normal' ? '' : '-' + variant;
    const file = path.join(outDir, `${type === 'monthly' ? 'transformation' : 'performance'}-report-sample${suffix}.pdf`);
    fs.writeFileSync(file, res.pdf);
    console.log(`${type}: ${path.relative(process.cwd(), file)}  score ${model.score.total} (${model.score.grade})  ${res.pages} pages  ${res.ms} ms  narrative=${nar.source}${nar.aiError ? ' (' + nar.aiError + ')' : ''}`);
    if (res.warnings && res.warnings.length) console.log('  layout warnings:', JSON.stringify(res.warnings).slice(0, 900));
    if (args.includes('--html')) {
      const { render } = require('../services/signatureReports/template');
      fs.writeFileSync(file.replace(/\.pdf$/, '.html'), render(model, nar, {}));
    }
  }
  await pdf.close();
}

main().catch(async (err) => { console.error(err); await pdf.close(); process.exit(1); });
