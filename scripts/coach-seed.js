#!/usr/bin/env node
'use strict';

/**
 * Coach Mode seed + accuracy pipeline.
 *
 *   node scripts/coach-seed.js              validate → images → upsert drafts into the DB
 *   node scripts/coach-seed.js --dry-run    validate only (no network writes to disk, no DB)
 *   node scripts/coach-seed.js --no-images  skip the image step
 *   node scripts/coach-seed.js --no-db      skip the DB step
 *   node scripts/coach-seed.js --force-images  re-encode images that already exist
 *   node scripts/coach-seed.js --export     write data/coach/library.json (drafts + image
 *                                           metadata) for the server's launch import; no DB
 *
 * Inputs (all reviewed by a coach before anything reaches a member):
 *   data/coach/whitelist.json          curated ids per area → free-exercise-db source ids
 *   data/coach/drafts/<id>.json        rewritten steps / cues / mistakes / tags (drafts)
 * Source: free-exercise-db (Unlicense) — data/coach/LICENSE-free-exercise-db.txt.
 *
 * Every row seeds as status='draft'. Re-running is idempotent: a draft row is
 * refreshed from its file; an approved or retired row is never overwritten (its
 * images are filled only if it has none). Approval happens in the admin
 * "Coach Mode library" screen, never here.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const C = require('../services/coachModeService');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'coach');
const DRAFTS = path.join(DATA, 'drafts');
const CACHE = path.join(DATA, '.cache');
const IMG_OUT = path.join(ROOT, 'public', 'img', 'coach');
const DB_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';
const IMG_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';
const WIDTHS = [480, 960];
const QUALITY = { 480: 70, 960: 60 };
const BUDGET_BYTES = 15 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const NO_IMG = DRY || args.has('--no-images');
const NO_DB = DRY || args.has('--no-db');
const FORCE_IMG = args.has('--force-images');
const EXPORT = args.has('--export');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'bodybank-coach-seed' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} → HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function cached(name, url) {
  const p = path.join(CACHE, name);
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const buf = await get(url);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return buf;
}

function loadDrafts() {
  const wl = JSON.parse(fs.readFileSync(path.join(DATA, 'whitelist.json'), 'utf8'));
  const out = [];
  for (const area of C.AREAS) {
    for (const entry of wl[area] || []) {
      const file = path.join(DRAFTS, entry.id + '.json');
      if (!fs.existsSync(file)) throw new Error(`whitelist ${area}/${entry.id}: missing draft ${path.relative(ROOT, file)}`);
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.id !== entry.id) throw new Error(`${file}: id ${d.id} ≠ whitelist id ${entry.id}`);
      if (d.source_id !== entry.source_id) throw new Error(`${file}: source_id ${d.source_id} ≠ whitelist ${entry.source_id}`);
      if (d.area !== area) throw new Error(`${file}: area ${d.area} but listed under ${area}`);
      out.push(d);
    }
  }
  return { wl, drafts: out };
}

async function buildImages(d, src) {
  const sharp = require('sharp');
  const images = [];
  const paths = (src.images || []).slice(0, 2);
  for (let n = 0; n < paths.length; n++) {
    const jpg = await cached(path.join('img', paths[n]), IMG_BASE + paths[n]);
    const variants = [];
    for (const w of WIDTHS) {
      const name = `${d.id}-${n}-${w}.webp`;
      const out = path.join(IMG_OUT, name);
      if (FORCE_IMG || !fs.existsSync(out)) {
        // sharp drops EXIF/ICC metadata unless .withMetadata() is called.
        await sharp(jpg).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: QUALITY[w], effort: 6 }).toFile(out);
      }
      const meta = await sharp(out).metadata();
      variants.push({ src: `/img/coach/${name}`, w: meta.width, h: meta.height });
    }
    images.push({
      src: variants[0].src,
      w: variants[0].w,
      h: variants[0].h,
      srcset: variants.map((v) => `${v.src} ${v.w}w`).join(', '),
      label: n === 0 ? 'Start' : 'End'
    });
  }
  return images;
}

async function main() {
  const { drafts } = loadDrafts();
  console.log(`[coach-seed] ${drafts.length} drafts in whitelist`);

  // 1. Validate drafts against the shape rules and against the source db.
  const db = JSON.parse((await cached('exercises.json', DB_URL)).toString('utf8'));
  const byId = new Map(db.map((e) => [e.id, e]));
  const problems = [];
  const seenIds = new Set();
  const seenSrc = new Map();
  for (const d of drafts) {
    const p = C.draftProblems(d);
    if (seenIds.has(d.id)) p.push('duplicate id');
    seenIds.add(d.id);
    if (!byId.has(d.source_id)) p.push(`source_id ${d.source_id} not in free-exercise-db`);
    if (seenSrc.has(d.source_id)) p.push(`source_id also used by ${seenSrc.get(d.source_id)}`);
    seenSrc.set(d.source_id, d.id);
    if (p.length) problems.push(`${d.id}: ${p.join('; ')}`);
  }
  if (problems.length) {
    console.error('[coach-seed] validation failed:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  const perArea = {};
  drafts.forEach((d) => { perArea[d.area] = (perArea[d.area] || 0) + 1; });
  console.log('[coach-seed] valid. per area:', perArea);
  if (DRY) return;

  if (EXPORT) {
    // Launch library for the server's boot import (services/coachModeService.importLibraryIfEmpty).
    const out = [];
    for (const d of drafts) out.push(Object.assign({}, d, { images: await buildImages(d, byId.get(d.source_id)) }));
    const missing = out.filter((d) => !d.images.length).map((d) => d.id);
    if (missing.length) { console.error('[coach-seed] no images for: ' + missing.join(', ')); process.exit(1); }
    fs.writeFileSync(path.join(DATA, 'library.json'), JSON.stringify(out) + '\n');
    console.log(`[coach-seed] wrote data/coach/library.json (${out.length} exercises)`);
    return;
  }

  // 2. Images: 2 photos per exercise × 480w/960w WebP, EXIF stripped.
  const imagesById = {};
  if (!NO_IMG) {
    fs.mkdirSync(IMG_OUT, { recursive: true });
    let i = 0;
    for (const d of drafts) {
      imagesById[d.id] = await buildImages(d, byId.get(d.source_id));
      if (++i % 25 === 0) console.log(`[coach-seed] images ${i}/${drafts.length}`);
    }
    const total = fs.readdirSync(IMG_OUT).filter((f) => f.endsWith('.webp'))
      .reduce((s, f) => s + fs.statSync(path.join(IMG_OUT, f)).size, 0);
    console.log(`[coach-seed] images total ${(total / 1048576).toFixed(2)} MB (budget ${(BUDGET_BYTES / 1048576).toFixed(0)} MB)`);
    if (total > BUDGET_BYTES) console.warn('[coach-seed] WARNING: image total is over budget');
  }

  // 3. DB upsert (drafts only; approved text is never overwritten).
  if (NO_DB) return;
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /render\.com|sslmode=require/i.test(String(process.env.DATABASE_URL || '')) ? { rejectUnauthorized: false } : undefined
  });
  try {
    await C.ensureCoachTables(pool);
    let inserted = 0; let refreshed = 0; let kept = 0;
    for (const d of drafts) {
      const imgs = imagesById[d.id] || null;
      const vals = [
        d.id, d.source_id, d.name, d.area, d.equipment || null, d.level || null, d.mechanic || null, d.force || null,
        d.primary_muscles || [], d.secondary_muscles || [],
        JSON.stringify(d.steps || []), JSON.stringify(d.cues || []), JSON.stringify(d.common_mistakes || []),
        JSON.stringify(d.contraindications || []), imgs ? JSON.stringify(imgs) : null,
        d.unit, d.load_type, d.default_sets || 3, d.default_reps || 10, d.load_step_kg == null ? 2.5 : d.load_step_kg,
        !!d.ai_trainer_key, d.ai_trainer_key || null, !!d.per_side, d.sort_order || 100
      ];
      const r = await pool.query(
        `INSERT INTO coach_exercises (id, source, source_id, source_license, name, area, equipment, level, mechanic, force,
            primary_muscles, secondary_muscles, steps, cues, common_mistakes, contraindications, images,
            unit, load_type, default_sets, default_reps, load_step_kg, ai_form_check, ai_trainer_key, per_side, sort_order, status)
         VALUES ($1,'free-exercise-db',$2,'Unlicense',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
                 COALESCE($15::jsonb,'[]'::jsonb),$16,$17,$18,$19,$20,$21,$22,$23,$24,'draft')
         ON CONFLICT (id) DO UPDATE SET
            source_id = EXCLUDED.source_id, name = EXCLUDED.name, area = EXCLUDED.area, equipment = EXCLUDED.equipment,
            level = EXCLUDED.level, mechanic = EXCLUDED.mechanic, force = EXCLUDED.force,
            primary_muscles = EXCLUDED.primary_muscles, secondary_muscles = EXCLUDED.secondary_muscles,
            steps = EXCLUDED.steps, cues = EXCLUDED.cues, common_mistakes = EXCLUDED.common_mistakes,
            contraindications = EXCLUDED.contraindications,
            images = CASE WHEN $15::jsonb IS NULL THEN coach_exercises.images ELSE EXCLUDED.images END,
            unit = EXCLUDED.unit, load_type = EXCLUDED.load_type, default_sets = EXCLUDED.default_sets,
            default_reps = EXCLUDED.default_reps, load_step_kg = EXCLUDED.load_step_kg,
            ai_form_check = EXCLUDED.ai_form_check, ai_trainer_key = EXCLUDED.ai_trainer_key,
            per_side = EXCLUDED.per_side, sort_order = EXCLUDED.sort_order, updated_at = NOW()
          WHERE coach_exercises.status = 'draft'
         RETURNING (xmax = 0) AS inserted`,
        vals
      );
      if (r.rows.length) { if (r.rows[0].inserted) inserted++; else refreshed++; }
      else {
        kept++;
        if (imgs) {
          await pool.query(
            "UPDATE coach_exercises SET images = $1::jsonb, updated_at = NOW() WHERE id = $2 AND images = '[]'::jsonb",
            [JSON.stringify(imgs), d.id]
          );
        }
      }
    }
    console.log(`[coach-seed] db: ${inserted} inserted, ${refreshed} drafts refreshed, ${kept} reviewed rows left untouched`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('[coach-seed]', e.message); process.exit(1); });
