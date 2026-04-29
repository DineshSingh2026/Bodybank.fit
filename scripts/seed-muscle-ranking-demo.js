/**
 * Inserts demo strength data so Muscle Ranking has something to score.
 * Run from repo root (PostgreSQL + DATABASE_URL required):
 *   node scripts/seed-muscle-ranking-demo.js
 *   node scripts/seed-muscle-ranking-demo.js you@email.com
 */
require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const emailArg = (process.argv[2] || '').trim();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    let row;
    if (emailArg) {
      const r = await pool.query(
        `SELECT id, email, first_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [emailArg]
      );
      row = r.rows[0];
    } else {
      const r = await pool.query(
        `SELECT id, email, first_name FROM users WHERE role = 'user'
         AND (approval_status IS NULL OR approval_status = 'approved')
         ORDER BY created_at DESC NULLS LAST LIMIT 1`
      );
      row = r.rows[0];
    }
    if (!row) {
      console.error('No member user found. Pass an email: node scripts/seed-muscle-ranking-demo.js you@email.com');
      process.exit(1);
    }
    const userId = row.id;
    const today = new Date().toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO weight_logs (id, user_id, weight_kg, created_at) VALUES ($1, $2, $3, NOW())`,
      [uuidv4(), userId, 78]
    );

    await pool.query(
      `INSERT INTO progress_logs (
        user_id, weight, strength_bench, strength_squat, strength_deadlift, workout_completed
      ) VALUES ($1, $2, $3, $4, $5, true)`,
      [userId, 78, 70, 95, 110]
    );

    const sessionLifts = {
      bench_press: 72,
      incline_press: 60,
      overhead_press: 42,
      lateral_raise: 12,
      bicep_curl: 14,
      triceps_pushdown: 28,
      barbell_row: 65,
      lat_pulldown: 55,
      deadlift: 105,
      back_squat: 100,
      romanian_deadlift: 85,
      leg_press: 180,
      leg_curl: 45,
      calf_raise: 80,
      face_pull: 22
    };

    await pool.query(
      `INSERT INTO workout_logs (
        id, user_id, workout_name, duration_seconds, feedback,
        session_date, workout_type, session_lifts, bench_kg, squat_kg, deadlift_kg,
        workout_completed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, true)`,
      [
        uuidv4(),
        userId,
        'Demo — Muscle Ranking',
        3600,
        'Seeded by scripts/seed-muscle-ranking-demo.js',
        today,
        'Full Body',
        JSON.stringify(sessionLifts),
        72,
        100,
        105
      ]
    );

    const port = process.env.PORT || 3000;
    console.log('');
    console.log('✅ Demo strength data added for:', row.email, '(' + (row.first_name || userId) + ')');
    console.log('');
    console.log('Next: restart the server (Ctrl+C then npm start), then open:');
    console.log('  http://localhost:' + port + '/');
    console.log('Log in as that user → sidebar "Muscle Ranking" or bottom nav "Ranking".');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
