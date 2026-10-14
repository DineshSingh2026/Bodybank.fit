'use strict';

/**
 * Signature reports — the extra data only Signature reads. READ-ONLY SQL.
 *
 * The core dataset (workouts, meals, check-ins, body, blood, goals) comes from
 * services/reportData.loadReportBundle, exactly as the classic report loads it,
 * so both templates score the same numbers. This adds:
 *
 *   moods          mind_moods (mood / stress 1–5)
 *   mindSessions   mind_checkins (breathing, grounding, body scan)
 *   readiness      readiness_daily via readinessService (HRV, resting HR, recovery, strain)
 *   lifts          workout_logs.session_lifts, all time: first logged and best per lift
 *   lifetime       all-time counts: workouts, meals, check-ins, personal bests
 *   memberSince    users.created_at       planLabel / accessExpiresAt  users
 *   touchpoints    coach messages (thread_messages), WhatsApp (wa_messages),
 *                  meetings, Sunday reviews, blood reports analysed, reports sent
 *   sunday         sunday_checkins: achievements, improve, questions, differences
 *
 * Every query is wrapped: a missing optional table never fails a report.
 */

const S = require('../reportScore');

async function safe(p) {
  try { return (await p) || []; } catch (err) {
    if (process.env.REPORTS_DEBUG) console.warn('[signature] query skipped:', err.message);
    return [];
  }
}
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function parseJson(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function liftLabel(key) {
  const k = String(key || '').replace(/_/g, ' ').trim();
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Lift';
}
const localDay = (col) => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE ?)::date`;

/**
 * @param db     { queryAll, queryOne, run }
 * @param bundle loadReportBundle() output (gives user, timezone, period)
 */
async function loadExtras(db, bundle) {
  const userId = bundle.user.id;
  const tz = bundle.user.timezone || 'Asia/Kolkata';
  const start = bundle.current.period.start;
  const end = bundle.current.period.end;
  const from = S.addDays(end, -120);
  const q = (sql, params) => safe(db.queryAll(sql, params));
  const one = async (sql, params) => { const r = await q(sql, params); return r[0] || null; };

  const [
    moodRows, mindRows, readiness, liftRows, userRow, sundayRows,
    coachMsg, waMsg, meetingRows, sundayCount, bloodCount, classicSent, sigSent,
    lifeWorkouts, lifeMeals, lifeCheckins
  ] = await Promise.all([
    q(`SELECT to_char(mood_date, 'YYYY-MM-DD') AS d, mood, stress FROM mind_moods
        WHERE user_id = ? AND mood_date BETWEEN ?::date AND ?::date`, [userId, from, end]),
    q(`SELECT to_char(checkin_date, 'YYYY-MM-DD') AS d, exercise_key FROM mind_checkins
        WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date`, [userId, from, end]),
    (async () => {
      try {
        const rs = require('../wearables/readinessService');
        return await rs.getReadinessRange({ queryAll: db.queryAll, queryOne: db.queryOne, run: db.run }, { userId, from, to: end });
      } catch (_) { return []; }
    })(),
    q(`SELECT session_lifts, to_char(COALESCE(session_date, ${localDay('created_at')}), 'YYYY-MM-DD') AS d
         FROM workout_logs
        WHERE user_id = ? AND session_lifts IS NOT NULL AND COALESCE(session_date, ${localDay('created_at')}) <= ?::date
        ORDER BY d`, [tz, userId, tz, end]),
    one(`SELECT created_at, plan_label, plan_tier, access_expires_at FROM users WHERE id = ?`, [userId]),
    q(`SELECT to_char(${localDay('created_at')}, 'YYYY-MM-DD') AS d, achievements, improve_next_week, questions, differences_felt
         FROM sunday_checkins
        WHERE user_id = ? AND ${localDay('created_at')} BETWEEN ?::date AND ?::date
        ORDER BY created_at DESC LIMIT 6`, [tz, userId, tz, S.addDays(start, -1), S.addDays(end, 1)]),
    one(`SELECT COUNT(*)::int AS c FROM thread_messages tm JOIN message_threads mt ON mt.id = tm.thread_id
          WHERE mt.user_id = ? AND tm.sender_role <> 'user' AND ${localDay('tm.created_at')} BETWEEN ?::date AND ?::date`, [userId, tz, start, end]),
    one(`SELECT COUNT(*)::int AS c FROM wa_messages
          WHERE client_id = ? AND direction = 'outbound' AND ${localDay('COALESCE(ts, created_at)')} BETWEEN ?::date AND ?::date`, [userId, tz, start, end]),
    q(`SELECT meeting_date, status FROM meetings WHERE user_id = ?`, [userId]),
    one(`SELECT COUNT(*)::int AS c FROM sunday_checkins WHERE user_id = ? AND ${localDay('created_at')} BETWEEN ?::date AND ?::date`, [userId, tz, start, end]),
    one(`SELECT COUNT(*)::int AS c FROM blood_analysis_reports WHERE user_id = ? AND (created_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date`, [userId, tz, start, end]),
    one(`SELECT COUNT(*)::int AS c FROM reports WHERE user_id = ? AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date`, [userId, tz, start, end]),
    one(`SELECT COUNT(*)::int AS c FROM signature_reports WHERE user_id = ? AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE ?)::date BETWEEN ?::date AND ?::date`, [userId, tz, start, end]),
    one(`SELECT COUNT(*)::int AS c FROM workout_logs WHERE user_id = ? AND COALESCE(workout_completed, TRUE) = TRUE AND COALESCE(session_date, ${localDay('created_at')}) <= ?::date`, [userId, tz, end]),
    one(`SELECT COUNT(*)::int AS c FROM nutrition_meal_logs WHERE user_id = ? AND log_date <= ?::date`, [userId, end]),
    one(`SELECT COUNT(*)::int AS c FROM daily_checkins WHERE user_id = ? AND COALESCE(is_freeze, FALSE) = FALSE AND checkin_date <= ?::date`, [userId, end])
  ]);

  // All-time lifts: first logged and best per lift, and how many personal bests were set.
  const lifts = {};
  let prs = 0;
  for (const r of liftRows) {
    const l = parseJson(r.session_lifts) || {};
    for (const [key, raw] of Object.entries(l)) {
      const kg = num(raw);
      if (!kg || kg <= 0 || kg > 700) continue;
      const cur = lifts[key];
      if (!cur) { lifts[key] = { label: liftLabel(key), first: { kg, date: r.d }, best: { kg, date: r.d } }; continue; }
      if (kg > cur.best.kg) { cur.best = { kg, date: r.d }; prs += 1; }
    }
  }

  const calls = (meetingRows || []).filter((m) => {
    const d = ymd(m.meeting_date);
    return d && S.dayNum(d) >= S.dayNum(start) && S.dayNum(d) <= S.dayNum(end) && !/cancel/i.test(String(m.status || ''));
  }).length;

  const u = userRow || {};
  const exp = u.access_expires_at ? new Date(u.access_expires_at) : null;
  return {
    moods: moodRows.filter((r) => r.d).map((r) => ({ date: r.d, mood: num(r.mood), stress: num(r.stress) })),
    mindSessions: mindRows.filter((r) => r.d).map((r) => ({ date: r.d, exercise: r.exercise_key })),
    readiness: (readiness || []).filter((r) => r && r.date).map((r) => ({ date: r.date, hrv: num(r.hrvMs), rhr: num(r.restingHr), recovery: num(r.score), strain: num(r.strain) })),
    lifts,
    lifetime: {
      workouts: lifeWorkouts ? lifeWorkouts.c : null,
      meals: lifeMeals ? lifeMeals.c : null,
      checkins: lifeCheckins ? lifeCheckins.c : null,
      prs
    },
    memberSince: ymd(u.created_at),
    planLabel: String(u.plan_label || u.plan_tier || '').slice(0, 40),
    accessExpiresAt: exp && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null,
    touchpoints: {
      coachMessages: coachMsg ? coachMsg.c : 0,
      whatsapp: waMsg ? waMsg.c : 0,
      calls,
      sundayReviews: sundayCount ? sundayCount.c : 0,
      bloodAnalysed: bloodCount ? bloodCount.c : 0,
      reports: (classicSent ? classicSent.c : 0) + (sigSent ? sigSent.c : 0)
    },
    sunday: sundayRows.filter((r) => r.d).map((r) => ({
      date: r.d,
      achievements: String(r.achievements || '').trim(),
      improve: String(r.improve_next_week || '').trim(),
      questions: String(r.questions || '').trim(),
      differences: String(r.differences_felt || '').trim()
    }))
  };
}

module.exports = { loadExtras };
