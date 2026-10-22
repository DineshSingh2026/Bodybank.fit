#!/usr/bin/env node
/*
 * Seeds one fictional, fully populated Tribe Elite member (plus a fictional care
 * team) into the LOCAL database so every member screen renders with data for
 * the plans brochure. `--clean` removes everything again.
 *
 *   node seed-brochure-demo.js <repoRoot>            seed
 *   node seed-brochure-demo.js <repoRoot> --clean    remove
 */
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(process.argv[2] || '.');
const req = (m) => require(path.join(REPO, 'node_modules', m));
req('dotenv').config({ path: path.join(REPO, '.env'), quiet: true });
const { Pool } = req('pg');
const bcrypt = req('bcryptjs');
const sharp = req('sharp');
const { randomUUID: uuid } = require('crypto');

const DOMAIN = '@brochuredemo.local';
const PASSWORD = 'Brochure-' + 'Demo-2026';
const url = String(process.env.DATABASE_URL || '');
if (!/localhost|127\.0\.0\.1/.test(url)) { console.error('Refusing: DATABASE_URL is not local.'); process.exit(1); }
const pool = new Pool({ connectionString: url });
const q = (s, p) => pool.query(s, p);

const PEOPLE = [
  { key: 'client', email: 'arjun' + DOMAIN, role: 'user', first: 'Arjun', last: 'Mehta', groupRole: 'client' },
  { key: 'lm', email: 'priya' + DOMAIN, role: 'operator', first: 'Priya', last: 'Nair', groupRole: 'lifestyle_manager' },
  { key: 'doctor', email: 'kavya' + DOMAIN, role: 'operator', first: 'Dr. Kavya', last: 'Rao', groupRole: 'doctor' },
  { key: 'op', email: 'rohan' + DOMAIN, role: 'operator', first: 'Rohan', last: 'Das', groupRole: 'operator' }
];

// Deterministic pseudo-random so re-seeding gives the same screens.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const between = (a, b) => a + (b - a) * rnd();
const ri = (a, b) => Math.round(between(a, b));

async function clean() {
  const like = '%' + DOMAIN;
  const ids = (await q('SELECT id FROM users WHERE email LIKE $1', [like])).rows.map((r) => r.id);
  await q('DELETE FROM chat_groups WHERE client_id = ANY($1)', [ids]);
  await q('DELETE FROM chat_group_members WHERE user_id = ANY($1)', [ids]);
  await q('DELETE FROM thread_messages WHERE thread_id IN (SELECT id FROM message_threads WHERE user_id = ANY($1))', [ids]);
  await q('DELETE FROM message_threads WHERE user_id = ANY($1)', [ids]);
  const byUser = ['daily_checkins', 'nutrition_meal_logs', 'nutrition_daily_stats', 'workout_logs', 'readiness_daily',
    'mind_moods', 'mind_checkins', 'body_snapshots', 'sunday_checkins', 'coin_wallet', 'coin_ledger',
    'blood_analysis_reports', 'user_program_assignments', 'meetings', 'user_goals', 'progress_logs', 'weight_logs',
    'nutrition_assessments', 'hydration_logs', 'wearable_workouts', 'wearable_connections', 'wearable_uploads',
    'wearable_journal', 'reports', 'user_inbox', 'push_subscriptions', 'device_push_tokens'];
  for (const t of byUser) {
    try { await q(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [ids]); } catch (e) { console.warn('  skip', t, e.message); }
  }
  await q('DELETE FROM tribe_members WHERE email LIKE $1', [like]);
  const r = await q('DELETE FROM users WHERE email LIKE $1', [like]);
  console.log(`Removed ${r.rowCount} demo account(s) and their data.`);
}

async function photoB64(file, w) {
  const buf = await sharp(path.join(REPO, 'public', 'img', 'fitchef meals', file)).extract({ left: 45, top: 337, width: 840, height: 481 }).resize(w, Math.round(w * 0.573), { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
  return buf.toString('base64');
}

async function main() {
  await clean();
  if (process.argv.includes('--clean')) return;

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const ids = {};
  for (const p of PEOPLE) {
    ids[p.key] = uuid();
    await q(
      `INSERT INTO users (id, email, password, first_name, last_name, role, approval_status, subscription_status,
                          suspended, height_cm, onboarded_at, guide_seen_at, created_at, timezone, country)
       VALUES ($1,$2,$3,$4,$5,$6,'approved','active',FALSE,178,NOW(),NOW(), NOW() - INTERVAL '118 days','Asia/Kolkata','India')`,
      [ids[p.key], p.email, hash, p.first, p.last, p.role]
    );
  }
  const U = ids.client;
  await q(
    `UPDATE users SET plan_tier='tribe_elite', plan_label='Tribe Elite · 4 months', gender='male', dob='1994-03-18',
            activated_at = NOW() - INTERVAL '46 days', access_expires_at = NOW() + INTERVAL '76 days',
            fortnight_report_enabled = TRUE, primary_training_days_per_week = 4, goal_type='fat_loss',
            goal_steps = 9000, goal_water_ml = 3000, goal_protein_g = 140, goal_sleep_hours = 7.5,
            city='Hyderabad', nutrition_ai_unlimited = TRUE, ai_trainer_unlimited = TRUE
      WHERE id = $1`, [U]);

  // ── Daily check-ins: 60 days back, two early misses, one freeze, 33-day live streak ──
  const MISS = new Set([41, 36]);
  const FREEZE = 34;
  for (let d = 59; d >= 0; d--) {
    if (MISS.has(d)) continue;
    const frz = d === FREEZE;
    await q(
      `INSERT INTO daily_checkins (id, user_id, checkin_date, steps, water_ml, protein_g, sleep_hours, is_freeze, created_at, updated_at)
       VALUES ($1,$2, CURRENT_DATE - $3::int, $4,$5,$6,$7,$8, NOW() - ($3::int * INTERVAL '1 day'), NOW() - ($3::int * INTERVAL '1 day'))`,
      [uuid(), U, d, frz ? null : (d === 0 ? 9420 : ri(8200, 11800)), frz ? null : (d === 0 ? 3100 : ri(26, 34) * 100),
        frz ? null : (d === 0 ? 148 : ri(128, 156)), frz ? null : (d === 0 ? 7.4 : Math.round(between(6.6, 8.1) * 10) / 10), frz]
    );
  }

  // ── Weight trend: 86.4 -> 81.6 kg over 16 weeks ──
  for (let w = 16; w >= 0; w--) {
    const kg = Math.round((81.6 + w * 0.3 + between(-0.15, 0.15)) * 10) / 10;
    const bf = Math.round((19.4 + w * 0.22) * 10) / 10;
    await q(`INSERT INTO weight_logs (id, user_id, weight_kg, created_at) VALUES ($1,$2,$3, NOW() - ($4::int * INTERVAL '7 days'))`, [uuid(), U, kg, w]);
    await q(`INSERT INTO progress_logs (user_id, weight, body_fat, created_at) VALUES ($1,$2,$3, NOW() - ($4::int * INTERVAL '7 days'))`, [U, kg, bf, w]);
    if (w % 2 === 0) {
      await q(
        `INSERT INTO body_snapshots (user_id, snapshot_date, bodyweight_kg, waist_cm, shared_with_manager, created_at)
         VALUES ($1, to_char(CURRENT_DATE - ($2::int * 7), 'YYYY-MM-DD'), $3, $4, TRUE, NOW() - ($2::int * INTERVAL '7 days'))`,
        [U, w, kg, Math.round((86.5 + w * 0.34) * 10) / 10]
      );
    }
  }
  await q(`INSERT INTO user_goals (user_id, target_weight, target_body_fat, weekly_workout_target) VALUES ($1, 78, 15, 4)`, [U]);
  await q(
    `INSERT INTO tribe_members (id, first_name, last_name, email, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, status)
     VALUES ($1,'Arjun','Mehta',$2,'Hyderabad',2, to_char(CURRENT_DATE - 112, 'YYYY-MM-DD'), 4, 86.4, 81.6, 78, 'active')`,
    [uuid(), 'arjun' + DOMAIN]
  );

  // ── Workouts: Mon / Tue / Thu / Sat, progressive lifts ──
  const SPLIT = {
    1: ['Push · Chest & Shoulders', 'strength', (k) => ({ bench_press: 70 + k, overhead_press: 42.5 + k / 2, incline_press: 26 + k / 2 })],
    2: ['Pull · Back & Biceps', 'strength', (k) => ({ deadlift: 120 + k * 1.5, barbell_row: 62.5 + k, lat_pulldown: 60 + k })],
    4: ['Legs · Squat day', 'strength', (k) => ({ back_squat: 95 + k * 1.5, romanian_deadlift: 80 + k, leg_press: 160 + k * 2 })],
    6: ['Full body + Zone 2', 'strength', (k) => ({ bench_press: 67.5 + k, back_squat: 90 + k, deadlift: 115 + k })]
  };
  for (let d = 59; d >= 0; d--) {
    const dow = (await q('SELECT EXTRACT(DOW FROM CURRENT_DATE - $1::int)::int AS w', [d])).rows[0].w;
    const s = SPLIT[dow];
    if (!s || d === 23) continue;
    const k = Math.round((59 - d) / 7 * 1.25 * 2) / 2;
    const lifts = s[2](k);
    await q(
      `INSERT INTO workout_logs (id, user_id, workout_name, duration_seconds, feedback, created_at, session_date, workout_type,
                                 session_lifts, bench_kg, squat_kg, deadlift_kg, workout_completed, intensity, energy_level, calories)
       VALUES ($1,$2,$3,$4,$5, (CURRENT_DATE - $6::int) + TIME '07:10', CURRENT_DATE - $6::int, $7, $8::jsonb, $9,$10,$11, TRUE, $12, $13, $14)`,
      [uuid(), U, s[0], ri(52, 68) * 60, d === 0 ? 'Felt strong. Added 2.5 kg on the last set.' : null, d, s[1], JSON.stringify(lifts),
        lifts.bench_press || null, lifts.back_squat || null, lifts.deadlift || null, ['moderate', 'high', 'high'][ri(0, 2)], ['good', 'great', 'good'][ri(0, 2)], ri(380, 520)]
    );
  }

  // ── Meals ──
  const B = await photoB64('bkfast1.jpeg', 900);
  const L = await photoB64('dinner.jpeg', 900);
  const meal = (dish, calories, protein, carbs, fat, fiber, photo) => ({
    dish, calories, protein, carbs, fat, fiber, confidence: 'high', _bbAnalyzedWithPhoto: !!photo, _bbEntrySource: photo ? 'photo' : 'manual'
  });
  const MENU = {
    breakfast: [['Masala Oats with Boiled Eggs', 410, 28, 44, 13, 7], ['Paneer Bhurji with Multigrain Toast', 430, 30, 32, 19, 6], ['Greek Yogurt, Berries and Almonds', 360, 26, 30, 14, 5]],
    lunch: [['Grilled Chicken, Brown Rice and Greens', 560, 46, 58, 14, 8], ['Dal, Roti and Paneer Tikka', 590, 38, 62, 20, 11], ['Fish Curry with Red Rice', 540, 42, 55, 16, 6]],
    snack: [['Whey Shake and a Banana', 240, 27, 28, 3, 3], ['Roasted Chana and Buttermilk', 210, 14, 26, 5, 7]],
    dinner: [['Chicken Stir Fry with Quinoa', 520, 44, 46, 16, 8], ['Palak Paneer with Two Phulkas', 480, 30, 40, 22, 9], ['Egg Curry and Millet Roti', 470, 32, 42, 18, 7]]
  };
  const TODAY = { breakfast: ['Overnight Oats Mango Jar with Whey', 380, 28, 50, 8, 7], lunch: ['Chicken Onion Mushroom Omelette', 385, 38, 6, 22, 2], snack: ['Whey Shake and a Banana', 240, 27, 28, 3, 3] };
  for (let d = 30; d >= 0; d--) {
    for (const mt of ['breakfast', 'lunch', 'snack', 'dinner']) {
      if (d === 0 && mt === 'dinner') continue; // today's dinner still open
      if (d > 0 && mt === 'snack' && rnd() < 0.25) continue;
      const m = (d === 0 && TODAY[mt]) || MENU[mt][(d + mt.length) % MENU[mt].length];
      const photo = d === 0 && mt === 'breakfast' ? B : (d === 0 && mt === 'lunch' ? L : null);
      await q(
        `INSERT INTO nutrition_meal_logs (id, user_id, log_date, meal_type, photo_data, photo_mime, portion_size, ai_result, photo_upload_count, submitted_at)
         VALUES ($1,$2, (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $3::int, $4,$5,$6,'medium',$7::jsonb,$8, NOW() - ($3::int * INTERVAL '1 day'))`,
        [uuid(), U, d, mt, photo, photo ? 'image/jpeg' : null, JSON.stringify(meal(m[0], m[1], m[2], m[3], m[4], m[5], photo)), photo ? 1 : 0]
      );
    }
  }
  for (const ml of [500, 750, 600, 500, 750]) await q(`INSERT INTO hydration_logs (id, user_id, amount_ml, glasses, created_at) VALUES ($1,$2,$3,$4,NOW())`, [uuid(), U, ml, Math.round(ml / 250)]);

  // ── Wearable (Whoop) recovery, 35 days ──
  await q(`INSERT INTO wearable_connections (user_id, provider, status, opted_in_at, last_sync_at) VALUES ($1,'whoop','connected', NOW() - INTERVAL '40 days', NOW())`, [U]).catch((e) => console.warn('  wearable_connections', e.message));
  const upId = uuid();
  await q(`INSERT INTO wearable_uploads (id, user_id, provider, file_name, file_sha256, rows_parsed, rows_rejected, date_from, date_to, summary_json, status)
           VALUES ($1,$2,'whoop','whoop-export.zip',$3,35,0,CURRENT_DATE - 34, CURRENT_DATE,'{}'::jsonb,'committed')`, [upId, U, 'brochure-demo-' + upId]);
  for (let d = 34; d >= 0; d--) {
    const wave = Math.sin((34 - d) / 3.1) * 11;
    const rec = Math.max(38, Math.min(96, Math.round(70 + wave + between(-7, 7) + (34 - d) * 0.25)));
    const sleep = Math.round(between(6.7, 8.2) * 10) / 10;
    await q(
      `INSERT INTO readiness_daily (id, user_id, date, source, confidence, recovery_score, hrv_ms, resting_hr, spo2, respiratory_rate,
                                    sleep_hours, sleep_performance_pct, sleep_efficiency_pct, sleep_debt_min, sleep_need_min,
                                    rem_min, deep_min, light_min, awake_min, strain, energy_kcal, max_hr, avg_hr, source_upload_id, hrv_method, measurement_source)
       VALUES ($1,$2, CURRENT_DATE - $3::int, 'whoop', 1, $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'rmssd','device')`,
      [uuid(), U, d, d === 0 ? 84 : rec, d === 0 ? 68 : Math.round(48 + rec * 0.24 + between(-3, 3)), d === 0 ? 52 : Math.round(60 - rec * 0.09 + between(-1, 1)),
        Math.round(between(96, 98.5) * 10) / 10, Math.round(between(14.2, 15.4) * 10) / 10, d === 0 ? 7.4 : sleep, d === 0 ? 91 : ri(78, 95), ri(88, 95),
        ri(10, 55), 480, ri(88, 118), ri(74, 102), ri(210, 250), ri(22, 40), Math.round(between(8.5, 15.8) * 10) / 10, ri(2350, 2900), ri(152, 176), ri(66, 78), upId]
    );
  }
  for (const [d, act, dur, strain] of [[0, 'Weightlifting', 58, 11.4], [1, 'Walking', 42, 6.2], [2, 'Running', 34, 12.8], [4, 'Weightlifting', 61, 11.9], [5, 'Functional Fitness', 45, 13.1]]) {
    await q(
      `INSERT INTO wearable_workouts (id, user_id, provider, date, workout_key, duration_min, activity, strain, energy_kcal, max_hr, avg_hr, zone1_min, zone2_min, zone3_min, zone4_min, zone5_min, source_upload_id)
       VALUES ($1,$2,'whoop', CURRENT_DATE - $3::int, $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [uuid(), U, d, 'bd-' + d, dur, act, strain, Math.round(dur * 7.4), ri(158, 174), ri(118, 136), Math.round(dur * 0.2), Math.round(dur * 0.35), Math.round(dur * 0.28), Math.round(dur * 0.13), Math.round(dur * 0.04), upId]
    ).catch((e) => console.warn('  wearable_workouts', e.message));
  }

  // ── Mind ──
  for (let d = 20; d >= 0; d--) {
    await q(`INSERT INTO mind_moods (user_id, mood_date, mood, stress) VALUES ($1, CURRENT_DATE - $2::int, $3, $4)`, [U, d, d === 0 ? 4 : ri(3, 5), d === 0 ? 2 : ri(1, 3)]);
    if (d <= 11) await q(`INSERT INTO mind_checkins (id, user_id, exercise_key, checkin_date) VALUES ($1,$2,$3, CURRENT_DATE - $4::int)`, [uuid(), U, d % 3 === 0 ? 'box_breathing' : (d % 3 === 1 ? 'body_scan' : 'grounding_54321'), d]);
  }

  // ── Sunday reviews (last 6 Sundays) ──
  const dowToday = (await q('SELECT EXTRACT(DOW FROM CURRENT_DATE)::int AS w')).rows[0].w;
  const WINS = ['Hit protein target on all seven days.', 'First 100 kg squat for reps.', 'Slept before 11 pm five nights.', 'Walked 10k steps every day.', 'No missed sessions this week.', 'Waist is down another centimetre.'];
  for (let i = 0; i < 6; i++) {
    const back = (dowToday === 0 ? 7 : dowToday) + i * 7;
    const kg = Math.round((81.8 + i * 0.3) * 10) / 10;
    await q(
      `INSERT INTO sunday_checkins (id, user_id, full_name, reply_email, plan, current_weight_waist_week, last_week_weight_waist, total_weight_loss,
                                    training_go, nutrition_go, sleep, occupation_stress, other_stress, differences_felt, achievements, improve_next_week, questions, body_fat_percent, created_at)
       VALUES ($1,$2,'Arjun Mehta',$3,'Tribe Elite',$4,$5,$6,'4 of 4 sessions done','On plan, one meal out','7.4 h average','Moderate','Low',
               'Clothes fit looser around the waist, energy is steadier through the afternoon.',$7,'Add a second Zone 2 walk and prep lunches on Sunday.','Can we move protein to 150 g from next week?',$8,
               (CURRENT_DATE - $9::int) + TIME '19:30')`,
      [uuid(), U, 'arjun' + DOMAIN, kg + ' kg / ' + (86.6 + i * 0.3).toFixed(1) + ' cm', (kg + 0.3).toFixed(1) + ' kg', (86.4 - kg).toFixed(1) + ' kg', WINS[i], Math.round((19.5 + i * 0.2) * 10) / 10, back]
    );
  }

  // ── Coins ──
  await q(`INSERT INTO coin_wallet (user_id, balance, lifetime_earned, lifetime_redeemed) VALUES ($1, 1840, 2340, 500)`, [U]);
  for (let d = 13; d >= 0; d--) await q(`INSERT INTO coin_ledger (id, user_id, event_type, event_key, coins_delta, meta_json, created_at) VALUES ($1,$2,'daily_checkin',$3,10,'{}'::jsonb, NOW() - ($4::int * INTERVAL '1 day'))`, [uuid(), U, 'bd-ci-' + d, d]);

  // ── Blood reports (bundled demo fixtures; fictional values) ──
  const cur = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures', 'demo', 'screening-current.json'), 'utf8')).extracted;
  const prev = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures', 'demo', 'screening-previous.json'), 'utf8')).extracted;
  const days = (n) => (new Date(Date.now() - n * 86400000 + 19800000)).toISOString().slice(0, 10);
  prev.report_date = days(118); cur.report_date = days(9);
  prev.lab_name = cur.lab_name = 'Demo Diagnostics';
  for (const [x, ago, status] of [[prev, 118, 'Fair'], [cur, 9, 'Good']]) {
    await q(
      `INSERT INTO blood_analysis_reports (id, user_id, extracted_blood_data, ai_report, sent_to_user, sent_at, status, user_name, user_email, user_age, user_gender, user_goal, created_at, report_date, report_variant)
       VALUES ($1,$2,$3::jsonb,$4::jsonb, TRUE, NOW() - ($5::int * INTERVAL '1 day') + INTERVAL '1 day', 'complete','Arjun Mehta',$6,'32','male','Fat loss', NOW() - ($5::int * INTERVAL '1 day'), $7::date, 'classic')`,
      [uuid(), U, JSON.stringify(x), JSON.stringify({ overall_status: status }), ago, 'arjun' + DOMAIN, x.report_date]
    );
  }

  // ── Programs, consult call, nutrition assessment ──
  for (const pid of ['DUMBBELL WORKOUT.pdf', 'FAT ON FIRE.pdf', 'STRETCH!.pdf']) {
    await q(`INSERT INTO user_program_assignments (id, user_id, program_id, assigned_by, assigned_at, seen_at) SELECT $1,$2,id,$3, NOW() - INTERVAL '40 days', NOW() - INTERVAL '39 days' FROM programs WHERE id = $4`, [uuid(), U, ids.lm, pid]);
  }
  await q(`INSERT INTO meetings (id, user_id, user_name, user_email, meeting_date, time_slot, status, notes) VALUES ($1,$2,'Arjun Mehta',$3, to_char(CURRENT_DATE + 3, 'YYYY-MM-DD'), '11:00', 'scheduled', 'Monthly review with Dr. Kavya')`, [uuid(), U, 'arjun' + DOMAIN]);
  await q(
    `INSERT INTO nutrition_assessments (id, user_id, status, last_step, full_name, email, city, goal_primary, diet_type, answers, derived, flags, consent_health, submitted_at, part, part1_submitted_at, part2_submitted_at)
     VALUES ($1,$2,'submitted', 1, 'Arjun Mehta',$3,'Hyderabad','fat_loss','non_vegetarian','{}'::jsonb,'{}'::jsonb,'{}'::jsonb, TRUE, NOW() - INTERVAL '44 days', 2, NOW() - INTERVAL '45 days', NOW() - INTERVAL '44 days')`,
    [uuid(), U, 'arjun' + DOMAIN]
  ).catch((e) => console.warn('  nutrition_assessments', e.message));

  // ── Coach note for the two-week report ──
  await q(
    `INSERT INTO reports (id, user_id, type, period_start, period_end, score, grade, pillars_json, edits_json, insights_json, generated_at, sent_at, source)
     VALUES ($1,$2,'weekly', CURRENT_DATE - 13, CURRENT_DATE, 84, 'A', '{}'::jsonb, $3::jsonb, '{}'::jsonb, NOW(), NOW(), 'manual')`,
    [uuid(), U, JSON.stringify({ closingNote: 'Strongest fortnight so far, Arjun. Protein and sleep were both on target, and it shows in your recovery. Next two weeks: hold the same food, add one Zone 2 walk. — Priya' })]
  ).catch((e) => console.warn('  reports', e.message));

  // ── Care group ──
  const gid = uuid();
  await q(`INSERT INTO chat_groups (id, name, client_id, created_by) VALUES ($1,'Arjun Mehta · Care Team',$2,$3)`, [gid, U, ids.lm]);
  for (const p of PEOPLE) await q(`INSERT INTO chat_group_members (id, group_id, user_id, group_role) VALUES ($1,$2,$3,$4)`, [uuid(), gid, ids[p.key], p.groupRole]);
  const SCRIPT = [
    ['lm', 'Morning Arjun. Week 7 plan is up: three lifting days and two Zone 2 walks.', 190],
    ['client', "Got it. Knee was a little stiff after Thursday's squats, is that expected?", 170],
    ['doctor', 'Some stiffness is normal at this load. Any swelling or clicking?', 160, 1],
    ['client', 'No swelling. Just stiff first thing in the morning.', 150],
    ['doctor', 'That reads as normal adaptation. Keep the load and add 5 minutes of mobility before you lift.', 140],
    ['op', "Logged. I've flagged the knee note so it shows in Sunday's review.", 120],
    ['lm', 'Great work today! Down 1.2 kg this fortnight and your step count is the best it has been.', 60],
    ['client', 'Thanks team 🙏', 50],
    ['doctor', "Your new blood report is in. Vitamin D is up nicely. Let's go through it on Thursday's call.", 20]
  ];
  const mids = [];
  for (const [who, body, minsAgo, replyIdx] of SCRIPT) {
    const id = uuid();
    await q(
      `INSERT INTO chat_messages (id, group_id, sender_id, sender_group_role, kind, body, reply_to_id, created_at)
       VALUES ($1,$2,$3,$4,'text',$5,$6, NOW() - ($7::int * INTERVAL '1 minute'))`,
      [id, gid, ids[who], PEOPLE.find((p) => p.key === who).groupRole, body, replyIdx == null ? null : mids[replyIdx], minsAgo]
    );
    mids.push(id);
  }
  for (const [on, by, emoji] of [[6, 'client', '❤️'], [6, 'doctor', '👍'], [4, 'client', '🙏'], [8, 'lm', '🎉']]) {
    await q(`INSERT INTO chat_message_reactions (id, message_id, group_id, user_id, emoji) VALUES ($1,$2,$3,$4,$5)`, [uuid(), mids[on], gid, ids[by], emoji]);
  }
  await q('UPDATE chat_groups SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1', [gid]);
  const maxSeq = (await q('SELECT MAX(seq) AS s FROM chat_messages WHERE group_id = $1', [gid])).rows[0].s;
  await q('UPDATE chat_group_members SET last_read_seq = $1 WHERE group_id = $2', [maxSeq, gid]);

  // ── Private coach thread ──
  const tid = uuid();
  await q(`INSERT INTO message_threads (id, user_id, subject, created_at, updated_at) VALUES ($1,$2,'', NOW() - INTERVAL '40 days', NOW())`, [tid, U]);
  const DM = [
    ['admin', 'Morning Arjun! Your recovery is 84% today, so this is a good day to push the squat session.', 300],
    ['user', 'Nice. Sleep has been much better since I moved dinner earlier.', 280],
    ['admin', 'It shows. Keep dinner before 8 pm this week and we will review on Sunday.', 270],
    ['user', 'Can I swap rice for millet rotis at lunch?', 95],
    ['admin', 'Yes. Two millet rotis is about the same carbs as your rice portion, so your macros stay on plan.', 88],
    ['user', 'Perfect. Also hit 10k steps five days straight 💪', 40],
    ['admin', 'Love that. The post-dinner walks are doing double duty for steps and sleep.', 32]
  ];
  for (const [role, body, minsAgo] of DM) {
    await q(`INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body, created_at, is_automated) VALUES ($1,$2,$3,$4,$5, NOW() - ($6::int * INTERVAL '1 minute'), FALSE)`,
      [uuid(), tid, role === 'user' ? U : ids.lm, role, body, minsAgo]);
  }

  fs.mkdirSync(path.join(__dirname, '.work'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '.work', 'demo.json'), JSON.stringify({ email: 'arjun' + DOMAIN, password: PASSWORD, userId: U, groupId: gid }, null, 2));
  console.log('Seeded demo member', 'arjun' + DOMAIN, U);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
