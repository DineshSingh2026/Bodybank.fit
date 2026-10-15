'use strict';

/**
 * Coach Mode API — mounted at /api/coach (see services/coachModeService.js).
 *
 * Member (behind COACH_MODE_ENABLED; 404 when the flag is off for the caller):
 *   GET  /flags                      { enabled } — always answers, drives the entry points
 *   GET  /home                       first name, workouts in the last 14 days, streak, area counts
 *   GET  /exercises?area=lower       approved exercises for an area (care tags applied)
 *   GET  /exercises/:id              full form guide
 *   GET  /last?exercise_ids=a,b      last logged sets + best load per exercise
 *   POST /workouts                   save a finished workout (idempotent on client_uuid)
 *   GET  /workouts?limit=20          the caller's Coach Mode history
 *
 * Staff (admin / superadmin; not gated by the flag so the library can be reviewed
 * before rollout):
 *   GET  /admin/exercises?status=&area=&q=
 *   GET  /admin/exercises/:id
 *   PUT  /admin/exercises/:id
 *   POST /admin/exercises/:id/approve | /retire | /draft
 *   GET  /admin/care-tags?q=         find members + their care tags
 *   PUT  /admin/care-tags/:userId    set a member's care tags
 *
 * The member's id always comes from the token, never from the body. Nothing here
 * writes daily_checkins or touches the AI Trainer trial counters.
 */

const express = require('express');
const crypto = require('crypto');
const C = require('../services/coachModeService');

function createCoachRouter(deps) {
  const {
    verifyToken, requireAdminOrSuperadmin, rateLimiter,
    queryAll, queryOne, run, getPool,
    coinService, plans, streakService,
    todayInTz, defaultTz,
    onWorkoutSaved, applyPenalties, env
  } = deps;
  const router = express.Router();
  const flagCfg = () => C.flagConfig(env || process.env);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

  async function userCtx(userId) {
    const u = await queryOne(
      'SELECT id, role, email, first_name, timezone, plan_tier, subscription_status, access_expires_at, coach_care_tags FROM users WHERE id = ?',
      [userId]
    );
    if (!u) return null;
    const tz = (u.timezone && String(u.timezone).trim()) || defaultTz;
    const today = todayInTz(tz) || new Date().toISOString().slice(0, 10);
    const careTags = C.asArray(u.coach_care_tags);
    let aiAllowed = true;
    if (u.role === 'user' && plans) {
      const plan = plans.planForUser(u);
      aiAllowed = !!(plan && Array.isArray(plan.features) && plan.features.includes('ai_trainer'));
    }
    return { u, tz, today, careTags, aiAllowed };
  }

  function memberGate(req, res, next) {
    if (!C.isEnabledFor(req.user, flagCfg())) return res.status(404).json({ error: 'Not found' });
    return next();
  }

  function fail(res, where, e) {
    console.error('[coach]', where, e && e.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  /* ------------------------------------------------------------ member */

  router.get('/flags', verifyToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: C.isEnabledFor(req.user, flagCfg()) });
  });

  router.get('/home', verifyToken, memberGate, async (req, res) => {
    try {
      const ctx = await userCtx(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const since = C.toYmd(new Date(Date.parse(ctx.today + 'T00:00:00Z') - 13 * 86400000));
      const wk = await queryOne(
        `SELECT COUNT(*)::int AS n FROM workout_logs
          WHERE user_id = ? AND COALESCE(session_date, created_at::date) >= ?::date`,
        [req.user.id, since]
      );
      const last = await queryOne(
        'SELECT area, local_date, total_sets FROM coach_workouts WHERE user_id = ? ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1',
        [req.user.id]
      );
      const counts = await queryAll(
        "SELECT area, COUNT(*)::int AS n FROM coach_exercises WHERE status = 'approved' GROUP BY area"
      );
      const area_counts = { upper: 0, lower: 0, core: 0, full: 0 };
      counts.forEach((r) => { area_counts[r.area] = r.n; });
      res.json({
        first_name: ctx.u.first_name || '',
        today: ctx.today,
        workouts_14d: wk ? wk.n : 0,
        last_workout: last ? { area: last.area, local_date: C.toYmd(last.local_date), total_sets: last.total_sets } : null,
        area_counts,
        has_care_tags: ctx.careTags.length > 0
      });
    } catch (e) { return fail(res, 'home', e); }
  });

  router.get('/exercises', verifyToken, memberGate, async (req, res) => {
    try {
      const area = String(req.query.area || '').toLowerCase();
      if (!C.AREAS.includes(area)) return res.status(400).json({ error: 'Invalid area', errors: { area: 'area must be one of ' + C.AREAS.join(', ') } });
      const ctx = await userCtx(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const rows = await queryAll(
        "SELECT * FROM coach_exercises WHERE area = ? AND status = 'approved' ORDER BY sort_order, name",
        [area]
      );
      const items = rows.map((r) => C.toListItem(r, ctx.careTags)).filter((x) => !x.hidden);
      items.forEach((x) => { delete x.hidden; });
      res.json({ area, exercises: items });
    } catch (e) { return fail(res, 'exercises', e); }
  });

  router.get('/exercises/:id', verifyToken, memberGate, async (req, res) => {
    try {
      const ctx = await userCtx(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const row = await queryOne("SELECT * FROM coach_exercises WHERE id = ? AND status = 'approved'", [String(req.params.id)]);
      if (!row) return res.status(404).json({ error: 'Exercise not found' });
      const guide = C.toGuide(row, ctx.careTags, ctx.aiAllowed);
      if (guide.hidden) return res.status(404).json({ error: 'Exercise not found' });
      delete guide.hidden;
      res.json(guide);
    } catch (e) { return fail(res, 'exercise', e); }
  });

  router.get('/last', verifyToken, memberGate, async (req, res) => {
    try {
      const ids = String(req.query.exercise_ids || '')
        .split(',').map((s) => s.trim()).filter(Boolean).slice(0, C.LIMITS.maxExercises);
      if (!ids.length) return res.json({ last: {} });
      const latest = await queryAll(
        `SELECT DISTINCT ON (s.exercise_id) s.exercise_id, s.workout_id, s.exercise_order, w.local_date
           FROM coach_sets s JOIN coach_workouts w ON w.id = s.workout_id
          WHERE s.user_id = ? AND s.exercise_id = ANY(?::text[])
          ORDER BY s.exercise_id, w.finished_at DESC NULLS LAST, w.created_at DESC`,
        [req.user.id, ids]
      );
      const best = await queryAll(
        `SELECT exercise_id, MAX(load_kg) AS best_load_kg, MAX(reps) AS best_reps, MAX(seconds) AS best_seconds
           FROM coach_sets WHERE user_id = ? AND exercise_id = ANY(?::text[]) GROUP BY exercise_id`,
        [req.user.id, ids]
      );
      const out = {};
      for (const l of latest) {
        const sets = await queryAll(
          `SELECT set_number, load_kg, reps, seconds FROM coach_sets
            WHERE workout_id = ? AND exercise_id = ? AND exercise_order = ? ORDER BY set_number`,
          [l.workout_id, l.exercise_id, l.exercise_order]
        );
        out[l.exercise_id] = {
          local_date: C.toYmd(l.local_date),
          sets: sets.map((s) => ({ set_number: s.set_number, load_kg: s.load_kg == null ? null : Number(s.load_kg), reps: s.reps, seconds: s.seconds }))
        };
      }
      for (const b of best) {
        out[b.exercise_id] = Object.assign(out[b.exercise_id] || { local_date: null, sets: [] }, {
          best_load_kg: b.best_load_kg == null ? null : Number(b.best_load_kg),
          best_reps: b.best_reps,
          best_seconds: b.best_seconds
        });
      }
      res.json({ last: out });
    } catch (e) { return fail(res, 'last', e); }
  });

  async function workoutSummary(workoutId) {
    const w = await queryOne('SELECT * FROM coach_workouts WHERE id = ?', [workoutId]);
    if (!w) return null;
    return {
      id: w.id,
      client_uuid: w.client_uuid,
      area: w.area,
      local_date: C.toYmd(w.local_date),
      duration_seconds: w.duration_seconds,
      total_sets: w.total_sets,
      total_volume_kg: Number(w.total_volume_kg || 0),
      workout_log_id: w.workout_log_id
    };
  }

  async function coinBalance(userId) {
    try {
      const r = await queryOne('SELECT balance FROM coin_wallet WHERE user_id = ?', [userId]);
      return r ? Number(r.balance) || 0 : 0;
    } catch (_) { return null; }
  }

  async function currentStreak(userId, tz) {
    try {
      const rows = await queryAll('SELECT checkin_date FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 365', [userId]);
      return streakService.computeStreakState(rows, null, tz).streak;
    } catch (_) { return null; }
  }

  router.post('/workouts', verifyToken, memberGate, rateLimiter(20, 60000), async (req, res) => {
    const userId = String(req.user.id);
    let ctx;
    try {
      ctx = await userCtx(userId);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
    } catch (e) { return fail(res, 'save:ctx', e); }

    const body = req.body || {};
    const ids = Array.isArray(body.exercises)
      ? [...new Set(body.exercises.map((x) => String((x && x.exercise_id) || '')).filter(Boolean))].slice(0, 50)
      : [];

    // A retry of a workout that already saved must not fail validation just because
    // an exercise was retired in between: answer with the stored workout first.
    const cu = String(body.client_uuid || '').trim();
    if (cu) {
      try {
        const existing = await queryOne('SELECT id FROM coach_workouts WHERE user_id = ? AND client_uuid = ?', [userId, cu]);
        if (existing) {
          return res.json({
            duplicate: true,
            workout: await workoutSummary(existing.id),
            coins: { awarded: false, delta: 0, balance: await coinBalance(userId) },
            streak: await currentStreak(userId, ctx.tz)
          });
        }
      } catch (e) { return fail(res, 'save:dupcheck', e); }
    }

    let rows = {};
    try {
      if (ids.length) {
        const list = await queryAll("SELECT * FROM coach_exercises WHERE id = ANY(?::text[]) AND status = 'approved'", [ids]);
        list.forEach((r) => { rows[r.id] = r; });
      }
    } catch (e) { return fail(res, 'save:rows', e); }

    const v = C.validateWorkout(body, rows, ctx.today);
    if (v.errors) return res.status(400).json({ error: 'Please check the workout', errors: v.errors });
    const w = v.value;

    const client = await getPool().connect();
    let workoutId = null;
    let logId = null;
    let duplicate = false;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO coach_workouts (id, user_id, client_uuid, area, started_at, finished_at, duration_seconds,
                                     total_sets, total_volume_kg, notes, local_date, app_platform)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12)
         ON CONFLICT (user_id, client_uuid) DO NOTHING RETURNING id`,
        [uuid(), userId, w.client_uuid, w.area, w.started_at, w.finished_at, w.duration_seconds,
          w.total_sets, w.total_volume_kg, w.notes, w.local_date, w.app_platform]
      );
      if (!ins.rows.length) {
        // A concurrent retry won the race: the first insert owns the sets, mirror and coins.
        duplicate = true;
        await client.query('ROLLBACK');
        const ex = await queryOne('SELECT id FROM coach_workouts WHERE user_id = ? AND client_uuid = ?', [userId, w.client_uuid]);
        workoutId = ex && ex.id;
      } else {
        workoutId = ins.rows[0].id;
        for (const ex of w.exercises) {
          for (const s of ex.sets) {
            await client.query(
              `INSERT INTO coach_sets (id, workout_id, user_id, exercise_id, exercise_order, set_number, load_kg, reps, seconds, completed, rpe)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)`,
              [uuid(), workoutId, userId, ex.exercise_id, ex.order, s.set_number, s.load_kg, s.reps, s.seconds, s.rpe]
            );
          }
        }
        // Mirror row so admin charts, reports, care passes and the agent webhook see it.
        logId = uuid();
        const feedback = w.exercises.map((ex) => ex.name + ' ' + ex.sets.length + '×').join(', ').slice(0, 1000);
        await client.query(
          `INSERT INTO workout_logs (id, user_id, workout_name, duration_seconds, feedback, session_date, workout_type, workout_completed)
           VALUES ($1,$2,$3,$4,$5,$6::date,'coach_mode',TRUE)`,
          [logId, userId, C.workoutLogName(w.area), w.duration_seconds, feedback, w.local_date]
        );
        await client.query('UPDATE coach_workouts SET workout_log_id = $1 WHERE id = $2', [logId, workoutId]);
        await client.query('COMMIT');
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      client.release();
      return fail(res, 'save:tx', e);
    }
    client.release();

    // Coins: the same event key as My Workout, so one day can never pay twice.
    let coins = { awarded: false, delta: 0, balance: null };
    if (!duplicate) {
      const ymd = C.coinDay(w.local_date, ctx.today);
      // Same order as My Workout: settle missed-day penalties, then award.
      if (typeof applyPenalties === 'function') {
        try { await applyPenalties(userId); } catch (e) { console.warn('[coach penalties]', e.message); }
      }
      try {
        const r = await coinService.awardCoins(
          { run, queryOne, queryAll },
          {
            userId,
            eventType: 'workout_session',
            eventKey: `coins:workout_session:${userId}:${ymd}`,
            coinsDelta: coinService.COIN_RULES.WORKOUT_SESSION,
            meta: { source: 'coach_mode', workout_id: workoutId },
            createdAtYmd: ymd
          }
        );
        coins = { awarded: !!(r && r.applied), delta: r && r.applied ? r.delta : 0, balance: null };
      } catch (e) { console.warn('[coach coins]', e.message); }
      if (typeof onWorkoutSaved === 'function') {
        try { await onWorkoutSaved({ userId, workoutId, workoutLogId: logId, workout: w, user: ctx.u }); } catch (e) { console.warn('[coach saved hook]', e.message); }
      }
    }
    coins.balance = await coinBalance(userId);
    res.json({
      duplicate,
      workout: await workoutSummary(workoutId),
      coins,
      streak: await currentStreak(userId, ctx.tz)
    });
  });

  router.get('/workouts', verifyToken, memberGate, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
      const ws = await queryAll(
        `SELECT id, area, local_date, duration_seconds, total_sets, total_volume_kg, finished_at
           FROM coach_workouts WHERE user_id = ? ORDER BY local_date DESC, finished_at DESC NULLS LAST LIMIT ?`,
        [req.user.id, limit]
      );
      const wids = ws.map((w) => w.id);
      const names = wids.length ? await queryAll(
        `SELECT s.workout_id, s.exercise_order, e.name, COUNT(*)::int AS sets
           FROM coach_sets s JOIN coach_exercises e ON e.id = s.exercise_id
          WHERE s.workout_id = ANY(?::text[])
          GROUP BY s.workout_id, s.exercise_order, e.name ORDER BY s.workout_id, s.exercise_order`,
        [wids]
      ) : [];
      const byW = {};
      names.forEach((n) => { (byW[n.workout_id] = byW[n.workout_id] || []).push({ name: n.name, sets: n.sets }); });
      res.json({
        workouts: ws.map((w) => ({
          id: w.id,
          area: w.area,
          local_date: C.toYmd(w.local_date),
          duration_seconds: w.duration_seconds,
          total_sets: w.total_sets,
          total_volume_kg: Number(w.total_volume_kg || 0),
          exercises: byW[w.id] || []
        }))
      });
    } catch (e) { return fail(res, 'history', e); }
  });

  /* ------------------------------------------------------------- admin */

  const staff = [verifyToken, requireAdminOrSuperadmin];

  function adminRow(r) {
    return Object.assign({}, r, {
      load_step_kg: r.load_step_kg == null ? null : Number(r.load_step_kg),
      steps: C.asArray(r.steps),
      cues: C.asArray(r.cues),
      common_mistakes: C.asArray(r.common_mistakes),
      contraindications: C.asArray(r.contraindications),
      images: C.asArray(r.images),
      primary_muscles: C.asArray(r.primary_muscles),
      secondary_muscles: C.asArray(r.secondary_muscles),
      approval_problems: C.approvalProblems(r)
    });
  }

  router.get('/admin/exercises', ...staff, async (req, res) => {
    try {
      const where = [];
      const params = [];
      const status = String(req.query.status || '');
      const area = String(req.query.area || '');
      const q = String(req.query.q || '').trim();
      if (C.STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
      if (C.AREAS.includes(area)) { where.push('area = ?'); params.push(area); }
      if (q) { where.push('(name ILIKE ? OR id ILIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
      const rows = await queryAll(
        `SELECT * FROM coach_exercises ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY area, sort_order, name`,
        params
      );
      const counts = await queryAll('SELECT area, status, COUNT(*)::int AS n FROM coach_exercises GROUP BY area, status');
      const c = {};
      C.AREAS.forEach((a) => { c[a] = { draft: 0, approved: 0, retired: 0 }; });
      counts.forEach((r) => { if (c[r.area]) c[r.area][r.status] = r.n; });
      res.json({ exercises: rows.map(adminRow), counts: c, target: { min: 60, max: 80 } });
    } catch (e) { return fail(res, 'admin:list', e); }
  });

  router.get('/admin/exercises/:id', ...staff, async (req, res) => {
    try {
      const r = await queryOne('SELECT * FROM coach_exercises WHERE id = ?', [String(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Exercise not found' });
      res.json(adminRow(r));
    } catch (e) { return fail(res, 'admin:get', e); }
  });

  router.put('/admin/exercises/:id', ...staff, async (req, res) => {
    try {
      const id = String(req.params.id);
      const cur = await queryOne('SELECT * FROM coach_exercises WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'Exercise not found' });
      const v = C.validateExercisePatch(req.body);
      if (v.errors) return res.status(400).json({ error: 'Please fix the highlighted fields', errors: v.errors });
      const keys = Object.keys(v.patch);
      if (!keys.length) return res.json(adminRow(cur));
      // An approved exercise must stay approvable after an edit.
      if (cur.status === 'approved') {
        const next = Object.assign({}, cur, v.patch);
        const probs = C.approvalProblems(next);
        if (probs.length) return res.status(400).json({ error: 'An approved exercise ' + probs.join(', ') + '. Move it back to draft first.', errors: { status: probs.join('; ') } });
      }
      const JSONB = ['steps', 'cues', 'common_mistakes', 'contraindications'];
      const sets = keys.map((k) => (JSONB.includes(k) ? `${k} = ?::jsonb` : `${k} = ?`));
      const vals = keys.map((k) => v.patch[k]);
      await run(`UPDATE coach_exercises SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [...vals, id]);
      const r = await queryOne('SELECT * FROM coach_exercises WHERE id = ?', [id]);
      res.json(adminRow(r));
    } catch (e) { return fail(res, 'admin:put', e); }
  });

  async function setStatus(req, res, status) {
    try {
      const id = String(req.params.id);
      const cur = await queryOne('SELECT * FROM coach_exercises WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'Exercise not found' });
      const note = req.body && req.body.review_notes != null ? String(req.body.review_notes).trim().slice(0, 2000) : null;
      if (status === 'approved') {
        const probs = C.approvalProblems(Object.assign({}, cur, note != null ? { review_notes: note } : {}));
        if (probs.length) return res.status(400).json({ error: 'Cannot approve: ' + probs.join(', '), errors: { approve: probs } });
      }
      await run(
        `UPDATE coach_exercises
            SET status = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW(),
                review_notes = COALESCE(?, review_notes)
          WHERE id = ?`,
        [status, String(req.user.id), note, id]
      );
      const r = await queryOne('SELECT * FROM coach_exercises WHERE id = ?', [id]);
      res.json(adminRow(r));
    } catch (e) { return fail(res, 'admin:' + status, e); }
  }
  router.post('/admin/exercises/:id/approve', ...staff, (req, res) => setStatus(req, res, 'approved'));
  router.post('/admin/exercises/:id/retire', ...staff, (req, res) => setStatus(req, res, 'retired'));
  router.post('/admin/exercises/:id/draft', ...staff, (req, res) => setStatus(req, res, 'draft'));

  router.get('/admin/care-tags', ...staff, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const rows = q.length >= 2
        ? await queryAll(
          `SELECT id, first_name, last_name, email, coach_care_tags FROM users
            WHERE role = 'user' AND (email ILIKE ? OR first_name ILIKE ? OR last_name ILIKE ? OR (first_name || ' ' || COALESCE(last_name,'')) ILIKE ?)
            ORDER BY first_name LIMIT 20`,
          ['%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%'])
        : await queryAll(
          `SELECT id, first_name, last_name, email, coach_care_tags FROM users
            WHERE role = 'user' AND COALESCE(array_length(coach_care_tags, 1), 0) > 0 ORDER BY first_name LIMIT 100`);
      res.json({ tags: C.CARE_TAGS, users: rows.map((u) => Object.assign({}, u, { coach_care_tags: C.asArray(u.coach_care_tags) })) });
    } catch (e) { return fail(res, 'admin:care', e); }
  });

  router.put('/admin/care-tags/:userId', ...staff, async (req, res) => {
    try {
      const tags = C.asArray(req.body && req.body.tags).map(String);
      const bad = tags.filter((t) => !C.CARE_TAGS.includes(t));
      if (bad.length) return res.status(400).json({ error: 'Unknown tag: ' + bad.join(', '), errors: { tags: 'Unknown tag' } });
      const u = await queryOne("SELECT id FROM users WHERE id = ? AND role = 'user'", [String(req.params.userId)]);
      if (!u) return res.status(404).json({ error: 'Member not found' });
      await run('UPDATE users SET coach_care_tags = ?::text[] WHERE id = ?', [[...new Set(tags)], u.id]);
      res.json({ id: u.id, coach_care_tags: [...new Set(tags)] });
    } catch (e) { return fail(res, 'admin:care:put', e); }
  });

  return router;
}

module.exports = { createCoachRouter };
