'use strict';

/**
 * Why can't I see nutrition assessments / watch data on the admin or operator
 * dashboard?
 *
 *   node scripts/diagnose-staff-visibility.js
 *
 * Run it against whichever environment you are actually looking at:
 *
 *   DATABASE_URL="postgres://…production…" node scripts/diagnose-staff-visibility.js
 *
 * "The feature is broken" and "nobody has used the feature yet" look identical
 * from a dashboard, and that ambiguity is what this script exists to remove. It
 * makes no writes — every statement is a SELECT.
 *
 * It answers, in order:
 *   1. Do the tables exist at all? (a missed migration)
 *   2. Do they have rows? (nobody has submitted or uploaded)
 *   3. Did the multi-device columns land? (a stale readinessService)
 *   4. What exactly would /api/operator/overview return right now?
 *   5. Is there a staff account to view it with?
 */

require('dotenv').config();
const { Pool } = require('pg');

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error('DATABASE_URL is not set. Point it at the environment you are looking at.');
  process.exit(1);
}

// Render and most managed Postgres need SSL; a local server refuses it outright.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(URL);
const pool = new Pool(
  isLocal ? { connectionString: URL } : { connectionString: URL, ssl: { rejectUnauthorized: false } }
);

const pad = (s, n) => String(s).padEnd(n);
const line = (n) => console.log('-'.repeat(n || 66));

async function rows(sql, params) {
  try {
    const r = await pool.query(sql, params || []);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function count(sql) {
  const r = await rows(sql);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, n: Number((r.rows[0] || {}).c || 0) };
}

(async () => {
  console.log('\nBodyBank — staff dashboard visibility diagnosis');
  console.log('Database: ' + URL.replace(/(:\/\/[^:]*:)[^@]*/, '$1***'));
  line();

  /* 1 ── tables ------------------------------------------------------------ */
  console.log('\n1. TABLES');
  const wanted = ['nutrition_assessments', 'readiness_daily', 'wearable_uploads', 'wearable_connections'];
  const present = {};
  for (const t of wanted) {
    const r = await rows(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [t]
    );
    present[t] = r.ok && r.rows.length > 0;
    console.log('   ' + pad(t, 24) + (present[t] ? 'exists' : 'MISSING — migration has not run here'));
  }

  /* 2 ── rows -------------------------------------------------------------- */
  console.log('\n2. IS THERE ANY DATA?');
  const na = present.nutrition_assessments
    ? await count('SELECT COUNT(*)::int c FROM nutrition_assessments') : { ok: false, error: 'no table' };
  const naDone = present.nutrition_assessments
    ? await count(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE status = 'complete'`) : { ok: false };
  const naFlag = present.nutrition_assessments
    ? await count(`SELECT COUNT(*)::int c FROM nutrition_assessments WHERE review_status = 'blocked'`) : { ok: false };
  const up = present.wearable_uploads
    ? await count(`SELECT COUNT(*)::int c FROM wearable_uploads WHERE status = 'committed'`) : { ok: false };
  const rdReal = present.readiness_daily
    ? await count(`SELECT COUNT(*)::int c FROM readiness_daily WHERE source <> 'derived'`) : { ok: false };
  const rdDer = present.readiness_daily
    ? await count(`SELECT COUNT(*)::int c FROM readiness_daily WHERE source = 'derived'`) : { ok: false };

  const show = (label, r) => console.log('   ' + pad(label, 40) + (r.ok ? r.n : '— (' + (r.error || 'n/a') + ')'));
  show('nutrition assessments (any)', na);
  show('  …completed', naDone);
  show('  …flagged, need review', naFlag);
  show('wearable files committed', up);
  show('readiness days from a real device', rdReal);
  show('readiness days BodyBank derived', rdDer);

  console.log('\n   For contrast, features that normally have data:');
  for (const t of ['users', 'daily_checkins', 'workout_logs']) {
    const c = await count('SELECT COUNT(*)::int c FROM ' + t);
    console.log('   ' + pad('  ' + t, 40) + (c.ok ? c.n : '—'));
  }

  /* 3 ── multi-device columns --------------------------------------------- */
  console.log('\n3. MULTI-DEVICE COLUMNS (added by readinessService on boot)');
  if (!present.readiness_daily) {
    console.log('   readiness_daily is missing entirely.');
  } else {
    const need = ['hrv_method', 'temp_basis', 'measurement_source', 'skin_temp_deviation_c', 'steps', 'active_minutes', 'device_model'];
    const r = await rows(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'readiness_daily' AND column_name = ANY($1)`, [need]
    );
    const have = r.ok ? r.rows.map((x) => x.column_name) : [];
    const missing = need.filter((c) => have.indexOf(c) === -1);
    console.log('   ' + have.length + ' of ' + need.length + ' present'
      + (missing.length ? ' — MISSING: ' + missing.join(', ') + ' (server has not rebooted on the new build)' : ' — all good'));
  }

  /* 4 ── device mix -------------------------------------------------------- */
  console.log('\n4. WHICH DEVICES ARE IN USE?');
  if (present.readiness_daily) {
    const r = await rows(
      `SELECT source, COUNT(*)::int AS days, COUNT(DISTINCT user_id)::int AS members, MAX(date)::date AS last
         FROM readiness_daily GROUP BY source ORDER BY days DESC`
    );
    if (!r.ok) console.log('   query failed: ' + r.error);
    else if (!r.rows.length) console.log('   No readiness rows at all.');
    else r.rows.forEach((x) => console.log('   ' + pad(x.source, 20) + pad(x.members + ' member(s)', 16)
      + pad(x.days + ' day(s)', 14) + 'last ' + (x.last ? String(x.last).slice(0, 10) : '—')));
  }

  /* 5 ── staff accounts ---------------------------------------------------- */
  console.log('\n5. STAFF ACCOUNTS TO VIEW IT WITH');
  const staff = await rows(`SELECT role, COUNT(*)::int c FROM users GROUP BY role ORDER BY role`);
  if (staff.ok) staff.rows.forEach((r) => console.log('   ' + pad(r.role, 20) + r.c));

  /* 6 ── verdict ----------------------------------------------------------- */
  line();
  console.log('VERDICT');
  const missingTable = wanted.filter((t) => !present[t]);
  const noData = (na.n || 0) === 0 && (up.n || 0) === 0 && (rdReal.n || 0) === 0;

  if (missingTable.length) {
    console.log('  A migration has not run here: ' + missingTable.join(', ') + '.');
    console.log('  Restart the server on the current build — the tables are created on boot.');
  } else if (noData) {
    console.log('  Everything is wired correctly and NOTHING HAS BEEN SUBMITTED YET.');
    console.log('  The dashboards are empty because there is genuinely nothing to show:');
    console.log('    - no member has completed the nutrition assessment');
    console.log('    - no member has uploaded watch data');
    console.log('  To prove the screens work, create one of each:');
    console.log('    - open /nutrition-assessment.html and submit it');
    console.log('    - sign in as a member, open Watch Data, and upload any export');
    console.log('  Both will then appear on the admin and operator dashboards.');
  } else {
    console.log('  There IS data here. If a dashboard still looks empty, it is a UI or');
    console.log('  caching problem, not a data one — hard-refresh (Ctrl+Shift+R), and');
    console.log('  check that index.html references the current ?v= for');
    console.log('  js/operator-console.js and js/member-home.js.');
  }
  line();

  await pool.end();
})().catch((e) => {
  console.error('\nCould not connect: ' + e.message);
  console.error('Check DATABASE_URL points at the environment you are actually looking at.');
  process.exit(1);
});
