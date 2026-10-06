'use strict';

/**
 * LOCAL ONLY. Finishes a BloodMap order's report with the demo fixture, so the
 * whole flow (review → release → view report) can be walked through on a machine
 * that has no ANTHROPIC_API_KEY. Refuses to run against anything but localhost.
 *
 *   node scripts/bloodmap-local-demo.js            latest order that has an upload
 *   node scripts/bloodmap-local-demo.js BM-1A2B3C  a specific order
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const graded = require('../services/gradedReportService');

(async () => {
  const url = new URL(process.env.DATABASE_URL || '');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    console.error('Refusing: this script only runs against a local database.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const db = {
    run: (sql, p = []) => pool.query(toPg(sql), p),
    queryAll: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows,
    queryOne: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0] || null
  };
  const ref = String(process.argv[2] || '').toUpperCase().replace(/^BM-/, '');
  const orders = await db.queryAll('SELECT * FROM bloodmap_orders WHERE report_id IS NOT NULL ORDER BY uploaded_at DESC');
  const order = ref ? orders.find((o) => o.id.replace(/-/g, '').slice(0, 6).toUpperCase() === ref) : orders[0];
  if (!order) { console.error('No BloodMap order with an uploaded report was found.'); process.exit(1); }

  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'demo', 'screening-current.json'), 'utf8'));
  await db.run(
    `UPDATE blood_analysis_reports SET extracted_blood_data = ?::jsonb, status = 'complete', analysis_last_error = NULL,
            graded_report = NULL, graded_doc = NULL, graded_pdf_path = NULL WHERE id = ?`,
    [JSON.stringify(fixture.extracted), order.report_id]
  );
  const built = await graded.buildGradedReportFor(db, order.report_id);
  if (built.error) { console.error('Graded build failed:', built.error); process.exit(1); }
  console.log(`Order ${order.name} now has a completed demo report. Open /bloodmap/admin and click "Release to client".`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
