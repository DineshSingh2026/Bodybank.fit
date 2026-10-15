'use strict';

/**
 * Seed BodyBank Challenges from data/challenges/*.json.
 *
 * Seeds always land as DRAFT. A challenge only reaches members after a coach presses
 * Publish in the admin Challenges screen. Never overwrites a published / archived
 * challenge, and never rewrites tasks of a challenge somebody has already joined.
 */

const fs = require('fs');
const path = require('path');
const C = require('./challengeService');

const SEED_DIR = path.join(__dirname, '..', 'data', 'challenges');

function readSeeds(dir) {
  const d = dir || SEED_DIR;
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
}

/**
 * @param {{queryOne:Function, run:Function}} db
 * @param {object[]} seeds
 * @param {{onlyIfEmpty?:boolean}} [opts]
 */
async function seedChallenges(db, seeds, opts) {
  const o = opts || {};
  const out = { inserted: [], updated: [], skipped: [], invalid: [] };
  if (o.onlyIfEmpty) {
    const c = await db.queryOne('SELECT COUNT(*)::int AS n FROM challenges');
    if (c && c.n > 0) return Object.assign(out, { note: 'challenges table not empty' });
  }
  for (const s of seeds || []) {
    const probs = C.seedProblems(s);
    if (probs.length) { out.invalid.push({ id: s && s.id, problems: probs }); continue; }
    const cur = await db.queryOne('SELECT id, status FROM challenges WHERE id = ?', [s.id]);
    if (cur && cur.status !== 'draft') { out.skipped.push({ id: s.id, reason: 'already ' + cur.status }); continue; }
    const joined = cur ? await db.queryOne('SELECT COUNT(*)::int AS n FROM challenge_enrollments WHERE challenge_id = ?', [s.id]) : null;
    if (joined && joined.n > 0) { out.skipped.push({ id: s.id, reason: 'has enrollments' }); continue; }

    const vals = [s.slug || s.id, s.title, s.subtitle || '', s.description || '', s.length_days, s.min_days == null ? null : s.min_days,
      JSON.stringify(s.day_titles || []), s.access, s.included_tiers || [], JSON.stringify(s.rewards || {}), s.hero_image || null, s.sort_order == null ? 100 : s.sort_order];
    if (cur) {
      await db.run(
        `UPDATE challenges SET slug = ?, title = ?, subtitle = ?, description = ?, length_days = ?, min_days = ?, day_titles = ?::jsonb,
                access = ?, included_tiers = ?::text[], rewards = ?::jsonb, hero_image = ?, sort_order = ?, updated_at = NOW()
          WHERE id = ? AND status = 'draft'`,
        [...vals, s.id]
      );
      await db.run('DELETE FROM challenge_tasks WHERE challenge_id = ?', [s.id]);
      out.updated.push(s.id);
    } else {
      await db.run(
        `INSERT INTO challenges (id, slug, title, subtitle, description, length_days, min_days, day_titles, access, included_tiers, rewards, hero_image, sort_order, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::text[], ?::jsonb, ?, ?, 'draft', 'seed')`,
        [s.id, ...vals]
      );
      out.inserted.push(s.id);
    }
    for (const t of s.tasks) {
      await db.run(
        `INSERT INTO challenge_tasks (id, challenge_id, day_number, position, kind, params, title, points)
         VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, params = EXCLUDED.params, title = EXCLUDED.title, points = EXCLUDED.points`,
        [C.taskId(s.id, t.day_number, t.position), s.id, t.day_number, t.position, t.kind, JSON.stringify(t.params || {}), t.title, t.points == null ? 100 : t.points]
      );
    }
  }
  return out;
}

module.exports = { SEED_DIR, readSeeds, seedChallenges };
