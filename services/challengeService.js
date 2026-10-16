'use strict';

/**
 * BodyBank Challenges — pure logic + schema.
 *
 * A challenge is a fixed run of days (7 / 15 / 30) with a few small tasks per day.
 * Tasks are never ticked by the member: the server reads the data the member already
 * creates elsewhere (daily check-ins, meal logs, Coach Mode / My Workout sessions,
 * mind and Sunday check-ins) and decides. The DB side lives in
 * services/challengeEngine.js, the HTTP surface in routes/challenges.js.
 *
 * Everything in this file is pure apart from ensureChallengeTables(pool), so the
 * unit tests drive it without a database.
 *
 * Evidence rule (the lesson from Coach Mode, which pays coins on a back-dated day):
 *   a row only counts for challenge day D when
 *     - its business date (checkin_date / log_date / local_date / session_date) is D, AND
 *     - it was CREATED inside day D in the enrollment's time zone, AND
 *     - (value tasks) it was not edited after day D ended.
 *   No back-fill, no future days.
 */

/* ------------------------------------------------------------------ schema */

// Identical SQL lives in scripts/migrations/20261015_challenges.sql.
const DDL = [
  `CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, subtitle TEXT DEFAULT '', description TEXT DEFAULT '',
    length_days INT NOT NULL CHECK (length_days BETWEEN 1 AND 90),
    min_days INT, day_titles JSONB NOT NULL DEFAULT '[]',
    access TEXT NOT NULL CHECK (access IN ('free','plan','paid')),
    included_tiers TEXT[] DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    rewards JSONB NOT NULL DEFAULT '{}',
    hero_image TEXT, sort_order INT DEFAULT 100, created_by TEXT, published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_tasks (
    id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    day_number INT NOT NULL, position INT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily_checkin','protein_target','meals_logged','coach_workout','workout_any','steps','water','sleep','mind_checkin','sunday_checkin','manual')),
    params JSONB NOT NULL DEFAULT '{}',
    title TEXT NOT NULL, points INT DEFAULT 100,
    UNIQUE (challenge_id, day_number, position)
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_enrollments (
    id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL REFERENCES challenges(id), user_id TEXT NOT NULL,
    client_uuid TEXT NOT NULL, start_date DATE NOT NULL, tz TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','failed','left','void')),
    days_done INT DEFAULT 0, points INT DEFAULT 0, completed_at TIMESTAMPTZ,
    leaderboard_opt_out BOOLEAN DEFAULT FALSE, display_name TEXT,
    source TEXT, utm JSONB DEFAULT '{}', referral_code TEXT, invited_by TEXT,
    share_token TEXT UNIQUE, share_results BOOLEAN DEFAULT FALSE,
    ip_hash TEXT, ended_at TIMESTAMPTZ, void_reason TEXT, evaluated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, client_uuid)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_challenge_active_one ON challenge_enrollments(user_id, challenge_id) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_ch_enroll_board ON challenge_enrollments(challenge_id, status, points DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ch_enroll_user ON challenge_enrollments(user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS challenge_task_completions (
    id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES challenge_enrollments(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES challenge_tasks(id), user_id TEXT NOT NULL, day_number INT NOT NULL, local_date DATE NOT NULL,
    evidence JSONB DEFAULT '{}', completed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (enrollment_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_rewards (
    id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES challenge_enrollments(id), user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('coins_day','coins_complete','badge','certificate','discount','lm_call')),
    reward_key TEXT NOT NULL UNIQUE,
    payload JSONB DEFAULT '{}', status TEXT DEFAULT 'granted', created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ch_rewards_user ON challenge_rewards(user_id, kind)`,
  `CREATE TABLE IF NOT EXISTS challenge_lm_requests (
    id TEXT PRIMARY KEY, enrollment_id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, phone TEXT, preferred_slot TEXT,
    status TEXT DEFAULT 'requested' CHECK (status IN ('requested','scheduled','done','cancelled')), notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_discounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, enrollment_id TEXT UNIQUE NOT NULL, pct INT NOT NULL CHECK (pct BETWEEN 1 AND 50),
    applies_to TEXT[] NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_payment_id TEXT, used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_discount_orders (
    order_id TEXT PRIMARY KEY, discount_id TEXT NOT NULL REFERENCES challenge_discounts(id), user_id TEXT NOT NULL,
    original_paise INT NOT NULL, discounted_paise INT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_push_log (
    id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, user_id TEXT NOT NULL, local_date DATE NOT NULL, slot TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (enrollment_id, local_date, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS challenge_audit (
    id TEXT PRIMARY KEY, enrollment_id TEXT, challenge_id TEXT, actor_id TEXT, action TEXT NOT NULL,
    notes TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW()
  )`
];

async function ensureChallengeTables(pool) {
  for (const sql of DDL) await pool.query(sql);
}

/* ------------------------------------------------------------- feature flag */

const STAFF_ROLES = ['admin', 'superadmin', 'operator'];
const MEMBER_ROLE = 'user';

function flagConfig(env) {
  const e = env || process.env;
  // Ships OFF (unlike Coach Mode). Rollout: off → staff → allowlist → all.
  let mode = String(e.CHALLENGES_ENABLED || 'off').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(mode)) mode = 'all';
  if (!['off', 'staff', 'allowlist', 'all'].includes(mode)) mode = 'off';
  const allow = new Set(
    String(e.CHALLENGES_ALLOWLIST || '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return { mode, allow };
}

function isEnabledFor(user, cfg) {
  const c = cfg || flagConfig();
  if (!user || c.mode === 'off') return false;
  if (c.mode === 'all') return true;
  const staff = STAFF_ROLES.includes(user.role);
  if (c.mode === 'staff') return staff;
  return staff || c.allow.has(String(user.id || '').toLowerCase()) || (!!user.email && c.allow.has(String(user.email).toLowerCase()));
}

/** Public surfaces (landing page, share pages, public list) are live only at `all`. */
function isPublicEnabled(cfg) {
  return (cfg || flagConfig()).mode === 'all';
}

/* ----------------------------------------------------------- dates + zones */

const DEFAULT_TZ = 'Asia/Kolkata';

function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ymdToDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}
function dayToYmd(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function addDays(ymd, n) { return dayToYmd(ymdToDay(ymd) + n); }
function diffDays(a, b) { return ymdToDay(a) - ymdToDay(b); }
function toYmd(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}
function resolveTz(tz, fallback) {
  const t = String(tz || '').trim();
  if (validTz(t)) return t;
  return validTz(fallback) ? fallback : DEFAULT_TZ;
}

const _fmtCache = new Map();
function partsFmt(tz) {
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    _fmtCache.set(tz, f);
  }
  return f;
}
/** Wall-clock parts of an instant in a zone. */
function wallParts(ms, tz) {
  const p = {};
  for (const x of partsFmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
/** Offset (ms) of a zone at an instant: wall time − UTC. */
function tzOffsetMs(ms, tz) {
  const w = wallParts(ms, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
/** The instant a wall-clock time happens in a zone (DST gaps resolve forward). */
function wallToInstant(y, mo, d, h, mi, s, ms, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms || 0);
  let inst = guess - tzOffsetMs(guess, tz);
  const off2 = tzOffsetMs(inst, tz);
  if (guess - off2 !== inst) inst = guess - off2;
  return inst;
}

/** 'YYYY-MM-DD HH:MM:SS(.ffffff)' (pg text of a `timestamp`) → parts, or null. */
function parseNaive(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(String(s || '').trim());
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), ms: m[7] ? Math.floor(+(m[7] + '000000').slice(0, 6) / 1000) : 0 };
}

/**
 * Instant (epoch ms) of a DB timestamp.
 *  - timestamptz values: a Date, an ISO string with an offset, or epoch ms;
 *  - naive `timestamp` values: the wall time in `naiveZone` — the DB session's
 *    TimeZone (UTC on Render, often Asia/Kolkata on a dev machine).
 */
function instantOf(ts, isNaive, naiveZone) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.getTime();
  if (isNaive) {
    const p = parseNaive(ts);
    if (!p) return null;
    return wallToInstant(p.y, p.mo, p.d, p.h, p.mi, p.s, p.ms, resolveTz(naiveZone, 'UTC'));
  }
  const t = Date.parse(String(ts));
  return Number.isNaN(t) ? null : t;
}

/** Calendar day (YYYY-MM-DD) in `tz` of a DB timestamp. The one helper every evidence check uses. */
function localDayOf(ts, isNaive, tz, naiveZone) {
  const ms = instantOf(ts, isNaive, naiveZone == null ? 'UTC' : naiveZone);
  if (ms == null) return null;
  const w = wallParts(ms, resolveTz(tz));
  return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}
function todayIn(tz, nowMs) { return localDayOf(nowMs == null ? Date.now() : nowMs, false, tz); }
function localHourOf(ms, tz) { return wallParts(ms, resolveTz(tz)).h; }
function localTimeLabel(ms, tz) {
  if (ms == null) return '';
  const w = wallParts(ms, resolveTz(tz));
  const h12 = w.h % 12 === 0 ? 12 : w.h % 12;
  return `${h12}:${String(w.mi).padStart(2, '0')} ${w.h < 12 ? 'am' : 'pm'}`;
}

/** Day number (1-based) of `todayYmd` in an enrollment that started on `startYmd`. */
function dayNumberOf(startYmd, todayYmd) { return diffDays(todayYmd, startYmd) + 1; }
function dateOfDay(startYmd, n) { return addDays(startYmd, n - 1); }

/* ------------------------------------------------------------- task kinds */

const TASK_KINDS = ['daily_checkin', 'protein_target', 'meals_logged', 'coach_workout', 'workout_any', 'steps', 'water', 'sleep', 'mind_checkin', 'sunday_checkin', 'manual'];
const DEFAULT_PROTEIN_G = 120;
const MIN_WORKOUT_SECONDS = 300; // My Workout rows under 5 min are ignored
const POINTS_DAY_CAP = 500;
const COIN_RULES = {
  CHALLENGE_DAY: 10, // every fully done day
  CHALLENGE_COMPLETE: 100 // fallback when a challenge sets no rewards.coins
};
const NAME_LIMITS = { title: 80, subtitle: 160, description: 300, task: 80 };

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Filter raw rows to the evidence that counts for one day. Rows come straight
 * from SQL (see challengeEngine.fetchRows): naive timestamps as text, timestamptz
 * as epoch ms.
 */
function dayEvidence(raw, dayYmd, tz, naiveZone) {
  const r = raw || {};
  const inDay = (ts, naive) => localDayOf(ts, naive, tz, naiveZone) === dayYmd;

  // Daily check-in: the row exists, is not a streak freeze, and was created that day.
  const checkin = (r.checkins || []).find((c) => toYmd(c.checkin_date) === dayYmd && !c.is_freeze && inDay(c.created_at, true)) || null;
  // Values on it count only if it was not edited after the day ended.
  const checkinValuesOk = !!(checkin && (!checkin.updated_at || inDay(checkin.updated_at, true)));

  const meals = (r.meals || []).filter((m) => toYmd(m.log_date) === dayYmd && m.submitted_ms != null && inDay(m.submitted_ms, false));
  const mealProtein = meals.reduce((a, m) => a + Math.max(0, Math.min(500, num(m.protein) || 0)), 0);

  const coach = (r.coach || []).filter((w) => toYmd(w.local_date) === dayYmd && inDay(w.created_ms, false));
  const workouts = (r.workouts || []).filter((w) => {
    const business = toYmd(w.session_date) || localDayOf(w.created_at, true, tz, naiveZone);
    return business === dayYmd && inDay(w.created_at, true);
  });
  const mind = (r.mind || []).filter((m) => toYmd(m.checkin_date) === dayYmd && inDay(m.created_at, true));
  const sunday = (r.sunday || []).filter((s) => inDay(s.created_at, true));

  const at = (ts, naive) => instantOf(ts, naive, naiveZone);
  return {
    day: dayYmd,
    checkin: checkin ? {
      at: at(checkin.created_at, true),
      steps: checkinValuesOk ? num(checkin.steps) : null,
      water_ml: checkinValuesOk ? num(checkin.water_ml) : null,
      protein_g: checkinValuesOk ? num(checkin.protein_g) : null,
      sleep_hours: checkinValuesOk ? num(checkin.sleep_hours) : null
    } : null,
    meals: meals.map((m) => ({ at: m.submitted_ms, protein: num(m.protein) || 0 })),
    meal_protein: Math.round(mealProtein),
    coach: coach.map((w) => ({ at: w.created_ms, duration_seconds: num(w.duration_seconds) || 0, total_sets: num(w.total_sets) || 0, area: w.area })),
    workouts: workouts.map((w) => ({ at: at(w.created_at, true), duration_seconds: num(w.duration_seconds) || 0, type: w.workout_type || '' })),
    mind: mind.map((m) => ({ at: at(m.created_at, true) })),
    sunday: sunday.map((s) => ({ at: at(s.created_at, true) }))
  };
}

function pct(v, t) { return t > 0 ? Math.max(0, Math.min(1, v / t)) : 0; }

/**
 * Evaluate one task against one day's evidence.
 * @returns {{done:boolean, at:number|null, progress:{value,target,unit}|null, evidence:object}}
 */
function evaluateTask(task, ev, ctx) {
  const p = (task && task.params) || {};
  const c = ctx || {};
  const kind = task && task.kind;
  const out = (done, at, progress, evidence) => ({ done: !!done, at: done ? (at == null ? null : at) : null, progress: progress || null, evidence: evidence || {} });
  if (!ev) return out(false);

  switch (kind) {
    case 'daily_checkin':
      return out(!!ev.checkin, ev.checkin && ev.checkin.at, null, ev.checkin ? { source: 'daily_checkins' } : {});

    case 'protein_target': {
      const goal = num(c.goal_protein_g) > 0 ? num(c.goal_protein_g) : DEFAULT_PROTEIN_G;
      const share = num(p.pct) > 0 ? Math.min(150, num(p.pct)) : 90;
      const target = Math.round(goal * share / 100);
      const fromCheckin = ev.checkin && ev.checkin.protein_g != null ? ev.checkin.protein_g : 0;
      const grams = Math.round(Math.max(fromCheckin, ev.meal_protein || 0));
      const done = grams >= target && target > 0;
      let at = null;
      if (done) {
        if (fromCheckin >= target && ev.checkin) at = ev.checkin.at;
        else {
          let run = 0;
          const ms = ev.meals.slice().sort((a, b) => a.at - b.at);
          for (const m of ms) { run += m.protein; if (run >= target) { at = m.at; break; } }
        }
      }
      return out(done, at, { value: grams, target, goal, unit: 'g' }, { grams, target });
    }

    case 'meals_logged': {
      const need = Math.max(1, Math.min(8, Math.round(num(p.count) || 3)));
      const ms = ev.meals.slice().sort((a, b) => a.at - b.at);
      return out(ms.length >= need, ms.length >= need ? ms[need - 1].at : null, { value: ms.length, target: need, unit: 'meals' }, { meals: ms.length });
    }

    case 'coach_workout': {
      const minSec = Math.max(60, Math.round((num(p.min_minutes) || 20) * 60));
      const hit = ev.coach.filter((w) => w.duration_seconds >= minSec && w.total_sets >= 3).sort((a, b) => a.at - b.at)[0];
      let any = null;
      if (!hit && p.allow_any) {
        any = ev.workouts.filter((w) => w.duration_seconds >= Math.max(MIN_WORKOUT_SECONDS, minSec)).sort((a, b) => a.at - b.at)[0] || null;
      }
      const best = Math.max(0, ...ev.coach.map((w) => w.duration_seconds), ...(p.allow_any ? ev.workouts.map((w) => w.duration_seconds) : []));
      const done = !!(hit || any);
      return out(done, hit ? hit.at : any && any.at, { value: Math.floor(best / 60), target: Math.round(minSec / 60), unit: 'min' },
        hit ? { source: 'coach_workouts', area: hit.area } : any ? { source: 'workout_logs' } : {});
    }

    case 'workout_any': {
      const minSec = Math.max(MIN_WORKOUT_SECONDS, Math.round((num(p.min_minutes) || 5) * 60));
      const pool = ev.workouts.concat(ev.coach.filter((w) => w.total_sets >= 3));
      const hit = pool.filter((w) => w.duration_seconds >= minSec).sort((a, b) => a.at - b.at)[0];
      const best = Math.max(0, ...pool.map((w) => w.duration_seconds));
      return out(!!hit, hit && hit.at, { value: Math.floor(best / 60), target: Math.round(minSec / 60), unit: 'min' }, hit ? { source: 'workouts' } : {});
    }

    case 'steps': {
      const target = Math.max(1000, Math.round(num(p.steps) || 8000));
      const v = ev.checkin && ev.checkin.steps != null ? ev.checkin.steps : 0;
      return out(v >= target, ev.checkin && ev.checkin.at, { value: v, target, unit: 'steps' }, { steps: v });
    }

    case 'water': {
      const target = Math.max(500, Math.round(num(p.ml) || 3000));
      const v = ev.checkin && ev.checkin.water_ml != null ? ev.checkin.water_ml : 0;
      return out(v >= target, ev.checkin && ev.checkin.at, { value: v, target, unit: 'ml' }, { water_ml: v });
    }

    case 'sleep': {
      const target = Math.max(4, Math.min(12, num(p.hours) || 7));
      const v = ev.checkin && ev.checkin.sleep_hours != null ? ev.checkin.sleep_hours : 0;
      return out(v >= target, ev.checkin && ev.checkin.at, { value: v, target, unit: 'h' }, { sleep_hours: v });
    }

    case 'mind_checkin': {
      const m = ev.mind.slice().sort((a, b) => a.at - b.at)[0];
      return out(!!m, m && m.at, null, m ? { source: 'mind_checkins' } : {});
    }

    case 'sunday_checkin': {
      const s = ev.sunday.slice().sort((a, b) => a.at - b.at)[0];
      return out(!!s, s && s.at, null, s ? { source: 'sunday_checkins' } : {});
    }

    case 'manual':
    default:
      // Manual tasks are ticked by staff (admin route), never from member data.
      return out(false);
  }
}

/** Evaluate every task of a day. `tasks` must all belong to that day. */
function evaluateDay(tasks, ev, ctx) {
  const results = (tasks || []).slice().sort((a, b) => a.position - b.position).map((t) => Object.assign({ task: t }, evaluateTask(t, ev, ctx)));
  const done = results.filter((r) => r.done).length;
  return { results, done, total: results.length, all_done: results.length > 0 && done === results.length };
}

/** Points for a day: sum of done tasks' points, capped. */
function dayPoints(tasks, doneIds) {
  const set = new Set(doneIds || []);
  const sum = (tasks || []).filter((t) => set.has(t.id)).reduce((a, t) => a + Math.max(0, Math.min(1000, num(t.points) || 0)), 0);
  return Math.min(POINTS_DAY_CAP, sum);
}

/* --------------------------------------------------------- completion rules */

/** Days that must be fully done to finish. Starter 6 of 7 (one grace day); longer runs 85 %. */
function minDaysFor(challenge) {
  const len = Math.max(1, Number(challenge && challenge.length_days) || 1);
  const set = Number(challenge && challenge.min_days);
  if (Number.isInteger(set) && set >= 1 && set <= len) return set;
  if (len <= 7) return Math.max(1, len - 1);
  return Math.ceil(len * 0.85);
}

/**
 * Where an active enrollment stands.
 * @param {object} a { length, minDays, todayDay (1-based, may exceed length), doneDays:Set<number>, todayDone:boolean }
 * @returns {'active'|'completed'|'failed'}
 */
function completionState(a) {
  const len = a.length;
  const doneCount = a.doneDays.size;
  const windowClosed = a.todayDay > len;
  if (doneCount >= len) return 'completed';
  if (doneCount >= a.minDays && (windowClosed || (a.todayDay >= len && a.doneDays.has(len)))) return 'completed';
  if (windowClosed) return 'failed';
  // Days still winnable: today (if not yet done) and every later day.
  const remaining = Math.max(0, len - a.todayDay) + (a.doneDays.has(a.todayDay) ? 0 : 1);
  if (doneCount + remaining < a.minDays) return 'failed';
  return 'active';
}

/** Grace days left: how many more days may be missed and still finish. */
function graceLeft(a) {
  const len = a.length;
  const elapsedMissed = [];
  for (let d = 1; d < Math.min(a.todayDay, len + 1); d++) if (!a.doneDays.has(d)) elapsedMissed.push(d);
  return Math.max(0, (len - a.minDays) - elapsedMissed.length);
}

/** Consecutive fully done days ending today (or yesterday while today is still open). */
function challengeStreak(doneDays, todayDay) {
  let d = doneDays.has(todayDay) ? todayDay : todayDay - 1;
  let n = 0;
  while (d >= 1 && doneDays.has(d)) { n += 1; d -= 1; }
  return n;
}

/* ------------------------------------------------------------- rewards */

function rewardKey(enrollmentId, what, n) {
  const base = `challenge:${enrollmentId}`;
  if (what === 'day') return `${base}:day:${n}`;
  return `${base}:${what}`;
}
function coinEventKey(enrollmentId, what, n) {
  return what === 'day' ? `coins:challenge:${enrollmentId}:day:${n}` : `coins:challenge:${enrollmentId}:complete`;
}
function completionCoins(challenge) {
  const r = (challenge && challenge.rewards) || {};
  const c = Number(r.coins);
  return Number.isInteger(c) && c >= 0 && c <= 5000 ? c : COIN_RULES.CHALLENGE_COMPLETE;
}

/** Reward chips for cards (never a price). */
function rewardChips(rewards) {
  const r = rewards || {};
  const out = [];
  if (Number(r.coins) > 0) out.push({ key: 'coins', label: `${Number(r.coins)} coins` });
  if (r.badge_key) out.push({ key: 'badge', label: r.badge_label || 'Badge' });
  if (r.certificate) out.push({ key: 'certificate', label: 'Certificate' });
  if (r.discount) out.push({ key: 'discount', label: 'Upgrade discount' });
  if (r.lm_call) out.push({ key: 'lm_call', label: 'Lifestyle manager call' });
  return out;
}

/* ------------------------------------------------------------- discount */

function discountPct(env) {
  const n = parseInt((env || process.env).CHALLENGE_UPGRADE_DISCOUNT_PCT, 10);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 15;
}
const DISCOUNT_DAYS = 14;
const DISCOUNT_TIERS = ['guided', 'tribe_elite'];

/** Discounted price in paise, whole rupees, never below ₹1. */
function applyDiscount(paise, pctOff) {
  const p = Math.round(Number(paise) || 0);
  const pc = Math.max(0, Math.min(50, Math.round(Number(pctOff) || 0)));
  if (p <= 0 || pc <= 0) return p;
  const rupees = Math.floor((p * (100 - pc)) / 100 / 100);
  return Math.max(100, rupees * 100);
}

/** Is this stored discount usable for `tier` right now? */
function discountUsable(d, tier, nowMs) {
  if (!d || d.used_at || d.used_payment_id) return false;
  const exp = d.expires_at instanceof Date ? d.expires_at.getTime() : Date.parse(d.expires_at);
  if (!Number.isFinite(exp) || exp <= (nowMs == null ? Date.now() : nowMs)) return false;
  const list = asArray(d.applies_to);
  return list.includes(String(tier || ''));
}

/* ------------------------------------------------------------- leaderboard */

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { /* pg text[] literal */ }
    const m = /^\{(.*)\}$/.exec(v.trim());
    if (m) return m[1] ? m[1].split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
  }
  return [];
}

/** "Arjun R." — first name and last initial only. */
function displayName(first, last) {
  const f = String(first || '').trim().split(/\s+/)[0] || '';
  const l = String(last || '').trim();
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  if (!f && !l) return 'Member';
  if (!l) return cap(f).slice(0, 24);
  return `${cap(f).slice(0, 24)} ${l.charAt(0).toUpperCase()}.`;
}
function initials(name) {
  const parts = String(name || '').replace(/\./g, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || 'M').charAt(0) + (parts[1] || '').charAt(0)).toUpperCase();
}

/**
 * Who may appear on a board: members only (no staff, operators, or BloodMap shadow
 * accounts), not opted out, not voided, accounts older than 24 h.
 */
function boardEligible(row, nowMs) {
  if (!row || row.role !== MEMBER_ROLE) return false;
  if (row.leaderboard_opt_out) return false;
  if (!['active', 'completed'].includes(row.status)) return false;
  const created = row.user_created_ms != null ? Number(row.user_created_ms) : Date.parse(row.user_created_at);
  if (!Number.isFinite(created)) return false;
  return (nowMs == null ? Date.now() : nowMs) - created >= 24 * 3600 * 1000;
}

/** Sort: points desc, then the earlier finisher, then the earlier joiner. */
function rankBoard(rows, nowMs) {
  const list = (rows || []).filter((r) => boardEligible(r, nowMs));
  const t = (v) => { const x = v instanceof Date ? v.getTime() : Date.parse(v); return Number.isFinite(x) ? x : Infinity; };
  list.sort((a, b) =>
    (Number(b.points) || 0) - (Number(a.points) || 0) ||
    t(a.completed_at) - t(b.completed_at) ||
    t(a.created_at) - t(b.created_at) ||
    String(a.id).localeCompare(String(b.id)));
  return list.map((r, i) => Object.assign({}, r, { rank: i + 1 }));
}

/* ------------------------------------------------------------- push timing */

/** Never between 22:00 and 07:00 local. */
function inQuietHours(hour) { return hour >= 22 || hour < 7; }

/* --------------------------------------------------- admin + seed validation */

// Member-facing challenge copy must stay clear of prices, blood data, meal scores
// and medical claims (store policy + product rules).
const FORBIDDEN = /(₹|\brs\.?\s?\d|\$\s?\d|\bprice\b|\bpay\b|\bbuy\b|\bblood\b|\bmeal score\b|\bcure[sd]?\b|\bheals?\b|\btreats?\b|\bdiagnos|\bdisease\b|\bsupplement)/i;

function forbiddenText(s) { return FORBIDDEN.test(String(s || '')); }

function validateTaskInput(t, lengthDays) {
  const errors = [];
  const day = Number(t && t.day_number);
  const pos = Number(t && t.position);
  if (!Number.isInteger(day) || day < 1 || day > (lengthDays || 90)) errors.push('day_number out of range');
  if (!Number.isInteger(pos) || pos < 1 || pos > 6) errors.push('position must be 1–6');
  if (!TASK_KINDS.includes(t && t.kind)) errors.push('unknown kind');
  const title = String((t && t.title) || '').trim();
  if (!title || title.length > NAME_LIMITS.task) errors.push(`title is required (${NAME_LIMITS.task} characters max)`);
  if (forbiddenText(title)) errors.push('title has forbidden wording (price / blood / medical)');
  const pts = t && t.points != null ? Number(t.points) : 100;
  if (!Number.isInteger(pts) || pts < 0 || pts > 1000) errors.push('points must be 0–1000');
  const params = t && t.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {};
  if (JSON.stringify(params).length > 500) errors.push('params too large');
  return errors;
}

function validateChallengeInput(c, opts) {
  const o = opts || {};
  const errors = {};
  const b = c && typeof c === 'object' ? c : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const patch = {};
  if (o.create || has('id')) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(b.id || '')) || String(b.id).length > 40) errors.id = 'id must be kebab-case, 40 characters max';
    else patch.id = b.id;
  }
  if (o.create || has('slug')) {
    const s = String(b.slug || b.id || '');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) || s.length > 40) errors.slug = 'slug must be kebab-case';
    else patch.slug = s;
  }
  for (const k of ['title', 'subtitle', 'description']) {
    if (o.create || has(k)) {
      const v = String(b[k] == null ? '' : b[k]).trim();
      if (k === 'title' && !v) errors.title = 'title is required';
      else if (v.length > NAME_LIMITS[k]) errors[k] = `${k} must be ${NAME_LIMITS[k]} characters or fewer`;
      else if (forbiddenText(v)) errors[k] = 'no prices, blood data or medical claims in challenge text';
      else patch[k] = v;
    }
  }
  if (o.create || has('length_days')) {
    const n = Number(b.length_days);
    if (!Number.isInteger(n) || n < 1 || n > 90) errors.length_days = 'length_days must be 1–90';
    else patch.length_days = n;
  }
  if (has('min_days')) {
    const n = b.min_days == null || b.min_days === '' ? null : Number(b.min_days);
    const len = patch.length_days || o.lengthDays || 90;
    if (n != null && (!Number.isInteger(n) || n < 1 || n > len)) errors.min_days = 'min_days must be 1–length';
    else patch.min_days = n;
  }
  if (o.create || has('access')) {
    if (!['free', 'plan', 'paid'].includes(b.access)) errors.access = 'access must be free, plan or paid';
    else patch.access = b.access;
  }
  if (has('included_tiers')) {
    const list = asArray(b.included_tiers).map(String);
    const bad = list.filter((t) => !['core', 'guided', 'tribe_elite'].includes(t));
    if (bad.length) errors.included_tiers = 'Unknown tier: ' + bad.join(', ');
    else patch.included_tiers = [...new Set(list)];
  }
  if (has('rewards')) {
    const r = b.rewards && typeof b.rewards === 'object' ? b.rewards : {};
    const coins = r.coins == null ? 0 : Number(r.coins);
    if (!Number.isInteger(coins) || coins < 0 || coins > 5000) errors.rewards = 'coins must be 0–5000';
    else {
      patch.rewards = {
        coins,
        badge_key: r.badge_key ? String(r.badge_key).replace(/[^a-z0-9_-]/gi, '').slice(0, 30) : null,
        badge_label: r.badge_label ? String(r.badge_label).slice(0, 40) : null,
        certificate: !!r.certificate,
        discount: !!r.discount,
        lm_call: !!r.lm_call
      };
    }
  }
  if (has('sort_order')) {
    const n = Number(b.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 10000) errors.sort_order = 'sort_order must be 0–10000';
    else patch.sort_order = n;
  }
  if (has('hero_image')) patch.hero_image = b.hero_image ? String(b.hero_image).slice(0, 300) : null;
  if (has('day_titles')) {
    const list = asArray(b.day_titles).map((s) => String(s == null ? '' : s).trim());
    const len = patch.length_days || o.lengthDays || 90;
    if (list.length > len) errors.day_titles = 'more day titles than days';
    else if (list.some((s) => s.length > 60)) errors.day_titles = 'each day title must be 60 characters or fewer';
    else if (list.some(forbiddenText)) errors.day_titles = 'no prices, blood data or medical claims in challenge text';
    else patch.day_titles = list;
  }
  return Object.keys(errors).length ? { errors } : { patch };
}

/** Seed file problems (data/challenges/*.json). */
function seedProblems(seed) {
  const p = [];
  const v = validateChallengeInput(seed, { create: true });
  if (v.errors) Object.keys(v.errors).forEach((k) => p.push(`${k}: ${v.errors[k]}`));
  const len = Number(seed && seed.length_days) || 0;
  const tasks = Array.isArray(seed && seed.tasks) ? seed.tasks : [];
  if (!tasks.length) p.push('no tasks');
  const keys = new Set();
  tasks.forEach((t, i) => {
    validateTaskInput(t, len).forEach((e) => p.push(`tasks[${i}]: ${e}`));
    const k = `${t.day_number}:${t.position}`;
    if (keys.has(k)) p.push(`tasks[${i}]: duplicate day/position ${k}`);
    keys.add(k);
  });
  for (let d = 1; d <= len; d++) if (!tasks.some((t) => t.day_number === d)) p.push(`day ${d} has no tasks`);
  return p;
}

/** Stable task id: <challenge>-d<day>-<position>. */
function taskId(challengeId, day, position) { return `${challengeId}-d${day}-${position}`; }

/* ------------------------------------------------------------- shaping */

function publicChallenge(row, counts) {
  const len = Number(row.length_days);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle || '',
    description: row.description || '',
    length_days: len,
    min_days: minDaysFor(row),
    access: row.access,
    included_tiers: asArray(row.included_tiers),
    rewards: rewardChips(row.rewards),
    reward_flags: {
      coins: completionCoins(row),
      badge: !!(row.rewards && row.rewards.badge_key),
      badge_label: (row.rewards && row.rewards.badge_label) || null,
      certificate: !!(row.rewards && row.rewards.certificate),
      discount: !!(row.rewards && row.rewards.discount),
      lm_call: !!(row.rewards && row.rewards.lm_call)
    },
    day_titles: asArray(row.day_titles).map(String),
    sort_order: row.sort_order,
    joined: counts && counts[row.id] != null ? counts[row.id] : 0
  };
}

/** Public participant count: rounded down to 10, hidden under 50. */
function publicCount(n) {
  const x = Number(n) || 0;
  if (x < 50) return null;
  return Math.floor(x / 10) * 10;
}

/**
 * "N members have finished a BodyBank challenge": a real count, never invented.
 * Hidden below `min` (CHALLENGE_SOCIAL_PROOF_MIN, default 25). Exact under 100,
 * then rounded down to the nearest 10 with a "+".
 * @returns {{n:number, label:string}|null}
 */
function proofCount(n, env) {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  const raw = parseInt((env || process.env).CHALLENGE_SOCIAL_PROOF_MIN, 10);
  const min = Number.isInteger(raw) && raw >= 1 ? raw : 25;
  if (x < min || x < 1) return null;
  if (x < 100) return { n: x, label: x.toLocaleString('en-IN') };
  const r = Math.floor(x / 10) * 10;
  return { n: r, label: r.toLocaleString('en-IN') + '+' };
}

module.exports = {
  proofCount,
  DDL,
  ensureChallengeTables,
  STAFF_ROLES,
  MEMBER_ROLE,
  flagConfig,
  isEnabledFor,
  isPublicEnabled,
  DEFAULT_TZ,
  isYmd,
  addDays,
  diffDays,
  toYmd,
  validTz,
  resolveTz,
  tzOffsetMs,
  wallToInstant,
  instantOf,
  localDayOf,
  todayIn,
  localHourOf,
  localTimeLabel,
  dayNumberOf,
  dateOfDay,
  TASK_KINDS,
  DEFAULT_PROTEIN_G,
  MIN_WORKOUT_SECONDS,
  POINTS_DAY_CAP,
  COIN_RULES,
  dayEvidence,
  evaluateTask,
  evaluateDay,
  dayPoints,
  minDaysFor,
  completionState,
  graceLeft,
  challengeStreak,
  rewardKey,
  coinEventKey,
  completionCoins,
  rewardChips,
  discountPct,
  DISCOUNT_DAYS,
  DISCOUNT_TIERS,
  applyDiscount,
  discountUsable,
  asArray,
  displayName,
  initials,
  boardEligible,
  rankBoard,
  inQuietHours,
  forbiddenText,
  validateTaskInput,
  validateChallengeInput,
  seedProblems,
  taskId,
  publicChallenge,
  publicCount
};
