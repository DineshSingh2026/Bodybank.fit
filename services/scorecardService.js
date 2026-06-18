/**
 * Program-aware weekly scorecard: daily check-ins, Sunday check-in, workouts, progress logs.
 * Week = Monday–Sunday in UTC (aligned with server date fields for daily_checkins).
 */

const DEFAULT_WEIGHTS = {
  daily: 0.28,
  sunday: 0.22,
  workouts: 0.35,
  progress: 0.15,
  workout_target: 4
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseISODate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo, d, 12, 0, 0));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return dt;
}

function weekStartMondayUTC(d) {
  const dt = new Date(d.getTime());
  const wd = dt.getUTCDay();
  const diff = wd === 0 ? -6 : 1 - wd;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function addDaysISO(iso, n) {
  const d = parseISODate(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function normalizeWeekStart(weekParam) {
  const today = new Date();
  let base = weekStartMondayUTC(today);
  if (weekParam) {
    const p = parseISODate(weekParam);
    if (p) base = weekStartMondayUTC(p);
  }
  return base;
}

function mergeWeights(raw) {
  const w = { ...DEFAULT_WEIGHTS };
  if (raw && typeof raw === 'object') {
    if (raw.daily != null) w.daily = Number(raw.daily);
    if (raw.sunday != null) w.sunday = Number(raw.sunday);
    if (raw.workouts != null) w.workouts = Number(raw.workouts);
    if (raw.progress != null) w.progress = Number(raw.progress);
    if (raw.workout_target != null) w.workout_target = Math.max(1, Math.round(Number(raw.workout_target)));
  }
  const sum = w.daily + w.sunday + w.workouts + w.progress;
  if (sum > 0 && Math.abs(sum - 1) > 0.01) {
    w.daily /= sum;
    w.sunday /= sum;
    w.workouts /= sum;
    w.progress /= sum;
  }
  return w;
}

function formatWeekRangeLabel(weekStartISO) {
  const start = parseISODate(weekStartISO);
  if (!start) return weekStartISO;
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  const a = start.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  const b = end.toLocaleDateString('en-US', { ...opts, year: 'numeric', timeZone: 'UTC' });
  return `${a} – ${b}`;
}

function createScorecardService({ queryOne, queryAll }) {
  async function getPrimaryProgram(userId) {
    const row = await queryOne(
      `SELECT a.program_id, p.name as program_name, p.score_weights
       FROM user_program_assignments a
       JOIN programs p ON p.id = a.program_id
       WHERE a.user_id = ? AND a.removed_at IS NULL
       ORDER BY a.assigned_at DESC
       LIMIT 1`,
      [userId]
    );
    if (!row) {
      return { program_id: null, program_name: 'Body Bank', weights: mergeWeights(null) };
    }
    let raw = row.score_weights;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (_) {
        raw = null;
      }
    }
    return {
      program_id: row.program_id,
      program_name: row.program_name || 'Program',
      weights: mergeWeights(raw)
    };
  }

  async function getWorkoutTarget(userId, weights) {
    const tm = await queryOne(
      `SELECT activity_per_week FROM tribe_members
       WHERE LOWER(email) = LOWER((SELECT email FROM users WHERE id = ?))
       ORDER BY start_date DESC NULLS LAST LIMIT 1`,
      [userId]
    );
    const apw = tm && tm.activity_per_week != null ? parseInt(tm.activity_per_week, 10) : NaN;
    if (!isNaN(apw) && apw > 0) return clamp(apw, 1, 14);
    return weights.workout_target || DEFAULT_WEIGHTS.workout_target;
  }

  async function fetchWeekSlice(userId, weekStartISO) {
    const weekEndExclusive = addDaysISO(weekStartISO, 7);
    if (!weekEndExclusive) return null;
    const fromIso = `${weekStartISO}T00:00:00.000Z`;
    const toIso = `${weekEndExclusive}T00:00:00.000Z`;

    const [dailyRows, sundayRows, workoutRows, progressRows] = await Promise.all([
      queryAll(
        `SELECT checkin_date FROM daily_checkins
         WHERE user_id = ? AND checkin_date >= ?::date AND checkin_date < ?::date
           AND COALESCE(is_freeze, FALSE) = FALSE`,
        [userId, weekStartISO, weekEndExclusive]
      ),
      queryAll(
        `SELECT id FROM sunday_checkins
         WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
        [userId, fromIso, toIso]
      ),
      queryAll(
        `SELECT id FROM workout_logs
         WHERE user_id = ? AND (
           (session_date IS NOT NULL AND session_date >= ?::date AND session_date < ?::date)
           OR (session_date IS NULL AND created_at >= ?::timestamptz AND created_at < ?::timestamptz)
         )`,
        [userId, weekStartISO, weekEndExclusive, fromIso, toIso]
      ),
      queryAll(
        `SELECT created_at::date AS d FROM progress_logs
         WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
        [userId, fromIso, toIso]
      )
    ]);

    const dailyDates = new Set(
      (dailyRows || []).map((r) => String(r.checkin_date).slice(0, 10)).filter(Boolean)
    );
    const workoutCount = (workoutRows || []).length;
    const sundayCount = (sundayRows || []).length;
    const progressDays = new Set(
      (progressRows || []).map((r) => String(r.d).slice(0, 10)).filter(Boolean)
    );

    return {
      dailyDays: dailyDates.size,
      sundayCount,
      workoutCount,
      progressDistinctDays: progressDays.size
    };
  }

  function computePillars(slice, weights, workoutTarget) {
    const dailyScore = (slice.dailyDays / 7) * 100;
    const sundayScore = slice.sundayCount >= 1 ? 100 : 0;
    const workoutScore = clamp((slice.workoutCount / workoutTarget) * 100, 0, 100);
    const progressScore = clamp((slice.progressDistinctDays / 7) * 100, 0, 100);

    const total =
      dailyScore * weights.daily +
      sundayScore * weights.sunday +
      workoutScore * weights.workouts +
      progressScore * weights.progress;

    return {
      daily: Math.round(dailyScore),
      sunday: Math.round(sundayScore),
      workouts: Math.round(workoutScore),
      progress: Math.round(progressScore),
      total: Math.round(total),
      breakdown: {
        daily_days: slice.dailyDays,
        sunday_done: slice.sundayCount >= 1,
        workouts_logged: slice.workoutCount,
        workout_target: workoutTarget,
        progress_days: slice.progressDistinctDays
      }
    };
  }

  async function computeWeeklyScore(userId, weekStartISO) {
    const program = await getPrimaryProgram(userId);
    const weights = program.weights;
    const workoutTarget = await getWorkoutTarget(userId, weights);
    const slice = await fetchWeekSlice(userId, weekStartISO);
    if (!slice) return null;
    const pillars = computePillars(slice, weights, workoutTarget);
    return {
      week_start: weekStartISO,
      week_label: formatWeekRangeLabel(weekStartISO),
      program_id: program.program_id,
      program_name: program.program_name,
      weights,
      ...pillars
    };
  }

  async function cohortOptedInUserIds(programId) {
    if (!programId) return [];
    const rows = await queryAll(
      `SELECT DISTINCT u.id
       FROM users u
       JOIN user_program_assignments a ON a.user_id = u.id AND a.program_id = ? AND a.removed_at IS NULL
       WHERE u.role = 'user' AND COALESCE(u.leaderboard_opt_in, FALSE) = TRUE
         AND COALESCE(u.leaderboard_public_program, TRUE) = TRUE
         AND TRIM(COALESCE(u.leaderboard_display_name, '')) <> ''`,
      [programId]
    );
    return (rows || []).map((r) => r.id);
  }

  async function globalLeaderboardUserIds() {
    const rows = await queryAll(
      `SELECT u.id FROM users u
       WHERE u.role = 'user'
        AND (u.approval_status IS NULL OR u.approval_status = 'approved')
        AND COALESCE(u.suspended, FALSE) = FALSE
        AND COALESCE(u.leaderboard_opt_in, FALSE) = TRUE
        AND COALESCE(u.leaderboard_public_global, FALSE) = TRUE
        AND TRIM(COALESCE(u.leaderboard_display_name, '')) <> ''`,
      []
    );
    return (rows || []).map((r) => r.id);
  }

  /** Same week activity as program scorecard, but weights = BodyBank default (fair across programs). */
  async function computeWeeklyScoreDedication(userId, weekStartISO) {
    const weights = mergeWeights(null);
    const workoutTarget = await getWorkoutTarget(userId, weights);
    const slice = await fetchWeekSlice(userId, weekStartISO);
    if (!slice) return null;
    const pillars = computePillars(slice, weights, workoutTarget);
    return {
      week_start: weekStartISO,
      week_label: formatWeekRangeLabel(weekStartISO),
      program_id: null,
      program_name: 'BodyBank',
      weights,
      ...pillars
    };
  }

  async function rankInCohort(userId, programId, weekStartISO, optedIn, publicProgram) {
    if (!optedIn || !programId || !publicProgram) {
      return { rank: null, cohort_size: null };
    }
    const ids = await cohortOptedInUserIds(programId);
    if (!ids.length) {
      return { rank: null, cohort_size: 0 };
    }
    const scores = [];
    for (const uid of ids) {
      const s = await computeWeeklyScore(uid, weekStartISO);
      if (s) scores.push({ id: uid, total: s.total });
    }
    scores.sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)));
    const idx = scores.findIndex((x) => x.id === userId);
    const rank = idx >= 0 ? idx + 1 : null;
    return { rank, cohort_size: scores.length };
  }

  async function rankInGlobal(userId, weekStartISO, optedIn, publicGlobal) {
    if (!optedIn || !publicGlobal) {
      return { rank: null, cohort_size: null };
    }
    const ids = await globalLeaderboardUserIds();
    if (!ids.length) {
      return { rank: null, cohort_size: 0 };
    }
    const scores = [];
    for (const uid of ids) {
      const s = await computeWeeklyScoreDedication(uid, weekStartISO);
      if (s) scores.push({ id: uid, total: s.total });
    }
    scores.sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)));
    const idx = scores.findIndex((x) => x.id === userId);
    const rank = idx >= 0 ? idx + 1 : null;
    return { rank, cohort_size: scores.length };
  }

  async function buildLeaderboard(programId, weekStartISO, limit = 50) {
    if (!programId) return [];
    const ids = await cohortOptedInUserIds(programId);
    const rows = [];
    for (const uid of ids) {
      const s = await computeWeeklyScore(uid, weekStartISO);
      if (!s) continue;
      const u = await queryOne(
        `SELECT id, first_name, last_name, leaderboard_display_name, profile_picture FROM users WHERE id = ?`,
        [uid]
      );
      const nick = u && u.leaderboard_display_name ? String(u.leaderboard_display_name).trim() : '';
      const display = nick || 'Member';
      const pic = u && u.profile_picture ? String(u.profile_picture).trim() : '';
      rows.push({
        user_id: uid,
        display_name: display,
        profile_picture: pic,
        total: s.total,
        pillars: {
          daily: s.daily,
          sunday: s.sunday,
          workouts: s.workouts,
          progress: s.progress
        }
      });
    }
    rows.sort((a, b) => b.total - a.total || String(a.user_id).localeCompare(String(b.user_id)));
    return rows.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
  }

  async function buildLeaderboardGlobal(weekStartISO, limit = 50) {
    const ids = await globalLeaderboardUserIds();
    const rows = [];
    for (const uid of ids) {
      const s = await computeWeeklyScoreDedication(uid, weekStartISO);
      if (!s) continue;
      const u = await queryOne(
        `SELECT id, first_name, last_name, leaderboard_display_name, profile_picture FROM users WHERE id = ?`,
        [uid]
      );
      const nick = u && u.leaderboard_display_name ? String(u.leaderboard_display_name).trim() : '';
      const display = nick || 'Member';
      const pic = u && u.profile_picture ? String(u.profile_picture).trim() : '';
      rows.push({
        user_id: uid,
        display_name: display,
        profile_picture: pic,
        total: s.total,
        pillars: {
          daily: s.daily,
          sunday: s.sunday,
          workouts: s.workouts,
          progress: s.progress
        }
      });
    }
    rows.sort((a, b) => b.total - a.total || String(a.user_id).localeCompare(String(b.user_id)));
    return rows.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /** All active assignments for program — audit view with admin rank + public rank (opted-in only). */
  async function buildAdminLeaderboardPreview(programId, weekStartISO) {
    if (!programId) return [];
    const users = await queryAll(
      `SELECT u.id, u.first_name, u.last_name, u.email,
              COALESCE(u.leaderboard_opt_in, FALSE) AS leaderboard_opt_in,
              u.leaderboard_display_name
       FROM users u
       INNER JOIN user_program_assignments a
         ON a.user_id = u.id AND a.program_id = ? AND a.removed_at IS NULL
       WHERE u.role = 'user'
       GROUP BY u.id, u.first_name, u.last_name, u.email, u.leaderboard_opt_in, u.leaderboard_display_name`,
      [programId]
    );
    const rows = [];
    for (const u of users || []) {
      const s = await computeWeeklyScore(u.id, weekStartISO);
      if (!s) continue;
      const display =
        (u.leaderboard_display_name && String(u.leaderboard_display_name).trim()) ||
        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
        u.email ||
        'Member';
      const internal = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || '—';
      rows.push({
        user_id: u.id,
        display_name: display,
        internal_name: internal,
        email: u.email || '',
        opted_in: !!u.leaderboard_opt_in,
        total: s.total,
        pillars: {
          daily: s.daily,
          sunday: s.sunday,
          workouts: s.workouts,
          progress: s.progress
        },
        breakdown: s.breakdown
      });
    }
    rows.sort((a, b) => b.total - a.total || String(a.user_id).localeCompare(String(b.user_id)));
    rows.forEach((r, i) => {
      r.rank_admin = i + 1;
    });
    const opted = rows.filter((r) => r.opted_in);
    opted.forEach((r, i) => {
      r.rank_public = i + 1;
    });
    rows.forEach((r) => {
      if (!r.opted_in) r.rank_public = null;
    });
    return rows;
  }

  return {
    normalizeWeekStart,
    previousWeekStart: (iso) => addDaysISO(iso, -7),
    computeWeeklyScore,
    computeWeeklyScoreDedication,
    rankInCohort,
    rankInGlobal,
    buildLeaderboard,
    buildLeaderboardGlobal,
    buildAdminLeaderboardPreview,
    formatWeekRangeLabel
  };
}

module.exports = { createScorecardService, DEFAULT_WEIGHTS };
