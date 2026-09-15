'use strict';

/**
 * Generate the two sample client reports from seeded data (no database).
 *
 *   node scripts/report-samples.js            -> docs/reports/sample-weekly-report.pdf
 *                                                docs/reports/sample-monthly-report.pdf
 *   node scripts/report-samples.js --html     also writes the fitted preview HTML
 *   node scripts/report-samples.js --ai       use the LLM narrative (needs ANTHROPIC_API_KEY)
 *
 * The seeded client is defined in tests/fixtures/reports/seed.js.
 */

const fs = require('fs');
const path = require('path');
const { seedBundle } = require('../tests/fixtures/reports/seed');
const { renderFromBundle } = require('../services/reportService');
const pdf = require('../services/reportPdf');

const OUT = path.join(__dirname, '..', 'docs', 'reports');

async function main() {
  const args = process.argv.slice(2);
  const wantHtml = args.includes('--html');
  const ai = args.includes('--ai');
  const variant = (args.find((a) => a.startsWith('--variant=')) || '--variant=normal').split('=')[1];
  fs.mkdirSync(OUT, { recursive: true });
  for (const type of ['weekly', 'monthly']) {
    const bundle = seedBundle(type, variant);
    const suffix = variant === 'normal' ? '' : '-' + variant;
    const res = await renderFromBundle(bundle, { pdf: true, ai });
    const file = path.join(OUT, `sample-${type}-report${suffix}.pdf`);
    fs.writeFileSync(file, res.pdf);
    console.log(`${type}: ${path.relative(process.cwd(), file)}  score ${res.score.total} (${res.score.grade})  ${res.pages} pages  ${res.ms} ms  narrative=${res.insights.source}${res.insights.aiError ? ' (' + res.insights.aiError + ')' : ''}`);
    if (res.warnings && res.warnings.length) console.log('  layout warnings:', JSON.stringify(res.warnings).slice(0, 600));
    if (Object.keys(res.chartErrors || {}).length) console.log('  chart errors:', res.chartErrors);
    if (wantHtml) {
      const h = await renderFromBundle(bundle, { pdf: false, ai: false, insights: res.insights, score: res.score });
      fs.writeFileSync(path.join(OUT, `sample-${type}-report${suffix}.html`), h.html);
    }
  }
  await pdf.close();
}

main().catch(async (err) => { console.error(err); await pdf.close(); process.exit(1); });
