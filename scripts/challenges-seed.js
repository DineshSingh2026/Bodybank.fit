#!/usr/bin/env node
'use strict';

/**
 * Seed BodyBank Challenges (data/challenges/*.json) as DRAFTS.
 *
 *   npm run seed:challenges                  insert / refresh drafts
 *   node scripts/challenges-seed.js --check  validate the seed files only (no DB)
 *   node scripts/challenges-seed.js --publish starter-7
 *        publish one challenge (local testing; in production use Admin → Challenges → Publish)
 */

require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const C = require('../services/challengeService');
const { readSeeds, seedChallenges } = require('../services/challengeSeed');

async function main() {
  const args = process.argv.slice(2);
  const seeds = readSeeds();
  const problems = seeds.map((s) => ({ id: s.id, p: C.seedProblems(s) })).filter((x) => x.p.length);
  if (problems.length) {
    problems.forEach((x) => console.error(`✗ ${x.id}: ${x.p.join('; ')}`));
    process.exit(1);
  }
  if (args.includes('--check')) {
    console.log(`✓ ${seeds.length} challenge seed files are valid`);
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const db = {
    run: (sql, p = []) => pool.query(toPg(sql), p),
    queryOne: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0] || null
  };
  try {
    await C.ensureChallengeTables(pool);
    const pi = args.indexOf('--publish');
    if (pi >= 0) {
      const id = args[pi + 1];
      const r = await db.run("UPDATE challenges SET status = 'published', published_at = COALESCE(published_at, NOW()), updated_at = NOW() WHERE id = $1 RETURNING id", [id]);
      console.log(r.rowCount ? `✓ published ${id}` : `✗ no challenge ${id} (seed first)`);
      return;
    }
    const out = await seedChallenges(db, seeds);
    console.log('inserted:', out.inserted.join(', ') || '—');
    console.log('updated: ', out.updated.join(', ') || '—');
    out.skipped.forEach((s) => console.log(`skipped:  ${s.id} (${s.reason})`));
    out.invalid.forEach((s) => console.log(`invalid:  ${s.id}: ${s.problems.join('; ')}`));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
