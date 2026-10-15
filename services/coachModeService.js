'use strict';

/**
 * Coach Mode — pure logic + schema for the guided gym logger.
 *
 * Coach Mode is a NEW member section beside My Workout (which it never touches):
 * choose a body area → choose exercises → form guide → log sets → save. Exercises
 * come from a curated, coach-reviewed library (coach_exercises); members only ever
 * see rows with status = 'approved'.
 *
 * Everything here is pure apart from ensureCoachTables(pool), so tests can drive it
 * without a database. The HTTP surface is routes/coachMode.js.
 */

const AREAS = ['upper', 'lower', 'core', 'full'];
const AREA_LABELS = { upper: 'Upper body', lower: 'Lower body', core: 'Core', full: 'Full body' };
const STATUSES = ['draft', 'approved', 'retired'];
const CARE_TAGS = ['knee', 'lower_back', 'shoulder', 'recovery', 'kidney_gentle', 'pregnancy'];
// Moves the in-app AI Trainer can actually judge (public/ai-trainer.html exercise list).
const AI_TRAINER_KEYS = ['squat', 'pushup', 'plank', 'jumpingjack', 'biccurl', 'shoulderpress', 'bentoverrow', 'lunge', 'calfraise', 'lateralraise', 'tricepsdip', 'frontraise'];
const MUSCLES = ['abdominals', 'abductors', 'adductors', 'biceps', 'calves', 'chest', 'forearms', 'glutes', 'hamstrings', 'lats', 'lower back', 'middle back', 'neck', 'quadriceps', 'shoulders', 'traps', 'triceps'];

const LIMITS = {
  steps: { max: 6, len: 110 },
  cues: { min: 3, max: 5, len: 60 },
  mistakes: { max: 5, len: 90 },
  maxExercises: 12,
  maxSets: 10,
  loadKg: { min: 0, max: 500, step: 0.25 },
  reps: { min: 0, max: 100 },
  seconds: { min: 0, max: 3600 },
  notes: 500,
  // A finished workout can be synced from the offline outbox days later.
  pastDays: 30
};

// Member care tags (users.coach_care_tags, set by staff only). A match against an
// exercise's contraindication tags either hides the move or shows a soft note.
// Notes are coaching language only: no diagnosis, no medical claims.
const HIDE_TAGS = ['recovery', 'pregnancy'];
const CARE_NOTES = {
  kidney_gentle: 'Keep it easy today and stay hydrated.',
  knee: 'Your coach flagged your knees: go lighter and keep it pain free.',
  lower_back: 'Your coach flagged your lower back: go lighter and keep it pain free.',
  shoulder: 'Your coach flagged your shoulders: go lighter and keep it pain free.'
};

/* ------------------------------------------------------------------ schema */

// Identical SQL lives in scripts/migrations/20261015_coach_mode.sql.
const DDL = [
  `CREATE TABLE IF NOT EXISTS coach_exercises (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'free-exercise-db', source_id TEXT, source_license TEXT DEFAULT 'Unlicense',
    name TEXT NOT NULL, area TEXT NOT NULL CHECK (area IN ('upper','lower','core','full')),
    equipment TEXT, level TEXT, mechanic TEXT, force TEXT,
    primary_muscles TEXT[] NOT NULL DEFAULT '{}', secondary_muscles TEXT[] NOT NULL DEFAULT '{}',
    steps JSONB NOT NULL DEFAULT '[]',
    cues JSONB NOT NULL DEFAULT '[]',
    common_mistakes JSONB NOT NULL DEFAULT '[]',
    contraindications JSONB NOT NULL DEFAULT '[]',
    images JSONB NOT NULL DEFAULT '[]',
    unit TEXT NOT NULL DEFAULT 'reps' CHECK (unit IN ('reps','seconds')),
    load_type TEXT NOT NULL DEFAULT 'kg' CHECK (load_type IN ('kg','bodyweight')),
    default_sets INT DEFAULT 3, default_reps INT DEFAULT 10, load_step_kg NUMERIC(4,2) DEFAULT 2.5,
    ai_form_check BOOLEAN DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
    reviewed_by TEXT, reviewed_at TIMESTAMPTZ, review_notes TEXT DEFAULT '',
    sort_order INT DEFAULT 100, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coach_ex_area_status ON coach_exercises(area, status, sort_order)`,
  `CREATE TABLE IF NOT EXISTS coach_workouts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    client_uuid TEXT NOT NULL,
    area TEXT NOT NULL, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
    duration_seconds INT DEFAULT 0, total_sets INT DEFAULT 0, total_volume_kg NUMERIC(10,2) DEFAULT 0,
    notes TEXT DEFAULT '', local_date DATE NOT NULL, workout_log_id TEXT,
    app_platform TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, client_uuid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coach_workouts_user_date ON coach_workouts(user_id, local_date DESC)`,
  `CREATE TABLE IF NOT EXISTS coach_sets (
    id TEXT PRIMARY KEY, workout_id TEXT NOT NULL REFERENCES coach_workouts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, exercise_id TEXT NOT NULL REFERENCES coach_exercises(id),
    exercise_order INT NOT NULL, set_number INT NOT NULL,
    load_kg NUMERIC(6,2), reps INT, seconds INT, completed BOOLEAN DEFAULT TRUE, rpe SMALLINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (workout_id, exercise_order, set_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coach_sets_user_ex ON coach_sets(user_id, exercise_id, created_at DESC)`,
  // Additive columns beyond the base spec: per-side counting ("10 each leg") and the
  // AI Trainer exercise key behind "Check my form with AI trainer".
  `ALTER TABLE coach_exercises ADD COLUMN IF NOT EXISTS per_side BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE coach_exercises ADD COLUMN IF NOT EXISTS ai_trainer_key TEXT`,
  // Staff-set care tags (e.g. {recovery,kidney_gentle}); never written by the member.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS coach_care_tags TEXT[] DEFAULT '{}'`
];

async function ensureCoachTables(pool) {
  for (const sql of DDL) await pool.query(sql);
}

/**
 * Launch import: when the library table is empty (a fresh deploy), load the curated
 * library from data/coach/library.json (built by `node scripts/coach-seed.js --export`).
 * The owner approved the whole launch library on 2026-10-15, so rows land approved;
 * coaches edit and re-review them in the admin library afterwards. Never touches a
 * non-empty table, so it cannot overwrite reviewed text.
 */
async function importLibraryIfEmpty(pool, rows, opts) {
  const o = opts || {};
  if (!Array.isArray(rows) || !rows.length) return { imported: 0, skipped: 'no rows' };
  const c = await pool.query('SELECT COUNT(*)::int AS n FROM coach_exercises');
  if (c.rows[0].n > 0) return { imported: 0, skipped: 'library not empty' };
  const status = o.status || 'approved';
  const note = o.reviewNote || 'Approved for launch by the owner (2026-10-15). Edit and re-review in the Coach Mode library.';
  let n = 0;
  for (const d of rows) {
    if (draftProblems(d).length) continue;
    const r = await pool.query(
      `INSERT INTO coach_exercises (id, source, source_id, source_license, name, area, equipment, level, mechanic, force,
          primary_muscles, secondary_muscles, steps, cues, common_mistakes, contraindications, images,
          unit, load_type, default_sets, default_reps, load_step_kg, ai_form_check, ai_trainer_key, per_side, sort_order,
          status, reviewed_by, reviewed_at, review_notes)
       VALUES ($1,'free-exercise-db',$2,'Unlicense',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
               $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW(),$27)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.source_id, d.name, d.area, d.equipment || null, d.level || null, d.mechanic || null, d.force || null,
        d.primary_muscles || [], d.secondary_muscles || [],
        JSON.stringify(d.steps || []), JSON.stringify(d.cues || []), JSON.stringify(d.common_mistakes || []),
        JSON.stringify(d.contraindications || []), JSON.stringify(d.images || []),
        d.unit, d.load_type, d.default_sets || 3, d.default_reps || 10, d.load_step_kg == null ? 2.5 : d.load_step_kg,
        !!d.ai_trainer_key, d.ai_trainer_key || null, !!d.per_side, d.sort_order || 100,
        status, status === 'approved' ? 'launch-import' : null, status === 'approved' ? note : '']
    );
    n += r.rowCount;
  }
  return { imported: n };
}

/* ------------------------------------------------------------- feature flag */

const STAFF_ROLES = ['admin', 'superadmin', 'operator'];

function flagConfig(env) {
  const e = env || process.env;
  // Live for everyone by default since the 2026-10-15 launch; set COACH_MODE_ENABLED=off
  // (or staff / allowlist) on the server to pull it back without a deploy.
  let mode = String(e.COACH_MODE_ENABLED || 'all').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(mode)) mode = 'all';
  if (!['off', 'staff', 'allowlist', 'all'].includes(mode)) mode = 'off';
  const allow = new Set(
    String(e.COACH_MODE_ALLOWLIST || '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return { mode, allow };
}

/** Rollout: off → staff → allowlist (staff + listed user ids/emails) → all. */
function isEnabledFor(user, cfg) {
  const c = cfg || flagConfig();
  if (!user || c.mode === 'off') return false;
  if (c.mode === 'all') return true;
  const staff = STAFF_ROLES.includes(user.role);
  if (c.mode === 'staff') return staff;
  return staff || c.allow.has(String(user.id || '').toLowerCase()) || (!!user.email && c.allow.has(String(user.email).toLowerCase()));
}

/* --------------------------------------------------------------- helpers */

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

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ymdToDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}
function toYmd(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

function round2(n) { return Math.round(n * 100) / 100; }
function isLoadStep(kg) { return Math.abs(kg * 4 - Math.round(kg * 4)) < 1e-9; }

/** Sum of load × reps over kg sets that have both; bodyweight and timed sets add 0. */
function computeVolume(exercises) {
  let vol = 0;
  let sets = 0;
  for (const ex of exercises || []) {
    for (const s of ex.sets || []) {
      sets += 1;
      const kg = num(s.load_kg);
      const reps = num(s.reps);
      if (kg != null && reps != null && kg > 0 && reps > 0) vol += kg * reps;
    }
  }
  return { total_sets: sets, total_volume_kg: round2(vol) };
}

/** Care-tag match → { hidden, notes[] } for one exercise. */
function careMatch(exerciseTags, careTags) {
  const ex = new Set(asArray(exerciseTags));
  const mine = asArray(careTags).filter((t) => ex.has(t));
  const hidden = mine.some((t) => HIDE_TAGS.includes(t));
  const notes = mine.filter((t) => CARE_NOTES[t]).map((t) => CARE_NOTES[t]);
  return { hidden, notes, matched: mine };
}

function mapMistakes(v) {
  return asArray(v).map((m) => (typeof m === 'string' ? { mistake: m, fix: '' } : { mistake: String(m.mistake || ''), fix: String(m.fix || '') }));
}

function imagesOf(row) {
  return asArray(row.images).filter((i) => i && i.src);
}

/** Member list row (picker). */
function toListItem(row, careTags) {
  const imgs = imagesOf(row);
  const care = careMatch(row.contraindications, careTags);
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    equipment: row.equipment || '',
    level: row.level || '',
    primary_muscles: asArray(row.primary_muscles),
    secondary_muscles: asArray(row.secondary_muscles),
    thumb: imgs[0] ? { src: imgs[0].src, srcset: imgs[0].srcset || '', w: imgs[0].w || null, h: imgs[0].h || null } : null,
    unit: row.unit,
    load_type: row.load_type,
    per_side: !!row.per_side,
    default_sets: row.default_sets,
    default_reps: row.default_reps,
    load_step_kg: num(row.load_step_kg),
    contraindications: asArray(row.contraindications),
    care_notes: care.notes,
    hidden: care.hidden
  };
}

/** Member form guide. aiAllowed = plan includes the AI Trainer. */
function toGuide(row, careTags, aiAllowed) {
  const base = toListItem(row, careTags);
  const aiKey = row.ai_trainer_key && AI_TRAINER_KEYS.includes(row.ai_trainer_key) ? row.ai_trainer_key : null;
  const ai = !!(row.ai_form_check && aiKey && aiAllowed);
  return Object.assign(base, {
    mechanic: row.mechanic || '',
    force: row.force || '',
    steps: asArray(row.steps).map(String),
    cues: asArray(row.cues).map(String),
    common_mistakes: mapMistakes(row.common_mistakes),
    images: imagesOf(row),
    ai_form_check: ai,
    ai_form_check_url: ai ? `/ai-trainer.html?v=2&exercise=${encodeURIComponent(aiKey)}&from=coach` : null,
    source: row.source || '',
    source_license: row.source_license || ''
  });
}

/* ------------------------------------------------------------ validation */

/**
 * Validate a POST /api/coach/workouts body. `exerciseRows` maps id → approved row
 * (unit/load_type are enforced against it). `todayYmd` is the user's local today.
 * Returns { errors } (field → message) or { value } (normalised).
 */
function validateWorkout(body, exerciseRows, todayYmd) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const rows = exerciseRows || {};

  const clientUuid = String(b.client_uuid || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientUuid)) errors.client_uuid = 'client_uuid must be 8–64 letters, digits or dashes';

  const area = String(b.area || '').trim().toLowerCase();
  if (!AREAS.includes(area)) errors.area = 'area must be one of ' + AREAS.join(', ');

  const started = b.started_at ? new Date(b.started_at) : null;
  const finished = b.finished_at ? new Date(b.finished_at) : null;
  if (!started || Number.isNaN(started.getTime())) errors.started_at = 'started_at must be an ISO date-time';
  if (!finished || Number.isNaN(finished.getTime())) errors.finished_at = 'finished_at must be an ISO date-time';
  let duration = 0;
  if (!errors.started_at && !errors.finished_at) {
    duration = Math.round((finished.getTime() - started.getTime()) / 1000);
    if (duration < 0) errors.finished_at = 'finished_at is before started_at';
    else if (duration > 6 * 3600) duration = 6 * 3600; // an app left open overnight still saves
    if (finished.getTime() > Date.now() + 10 * 60 * 1000) errors.finished_at = 'finished_at is in the future';
  }

  const localDate = String(b.local_date || '').trim();
  if (!isYmd(localDate)) errors.local_date = 'local_date must be YYYY-MM-DD';
  else if (todayYmd && isYmd(todayYmd)) {
    const d = ymdToDay(localDate);
    const t = ymdToDay(todayYmd);
    if (d > t + 1) errors.local_date = 'local_date is in the future';
    else if (d < t - LIMITS.pastDays) errors.local_date = `local_date is more than ${LIMITS.pastDays} days ago`;
  }

  const notes = b.notes == null ? '' : String(b.notes);
  if (notes.length > LIMITS.notes) errors.notes = `notes must be ${LIMITS.notes} characters or fewer`;

  const exercises = Array.isArray(b.exercises) ? b.exercises : null;
  const outEx = [];
  if (!exercises || !exercises.length) errors.exercises = 'Add at least one exercise';
  else if (exercises.length > LIMITS.maxExercises) errors.exercises = `At most ${LIMITS.maxExercises} exercises`;
  else {
    const orders = new Set();
    exercises.forEach((ex, i) => {
      const p = `exercises[${i}]`;
      const e = ex && typeof ex === 'object' ? ex : {};
      const id = String(e.exercise_id || '').trim();
      const row = rows[id];
      if (!id) { errors[p + '.exercise_id'] = 'exercise_id is required'; return; }
      if (!row) { errors[p + '.exercise_id'] = 'Unknown or unavailable exercise'; return; }
      const order = Number(e.order);
      if (!Number.isInteger(order) || order < 0 || order >= LIMITS.maxExercises) errors[p + '.order'] = `order must be an integer 0–${LIMITS.maxExercises - 1}`;
      else if (orders.has(order)) errors[p + '.order'] = 'order must be unique';
      else orders.add(order);
      const sets = Array.isArray(e.sets) ? e.sets : null;
      if (!sets || !sets.length) { errors[p + '.sets'] = 'Log at least one set'; return; }
      if (sets.length > LIMITS.maxSets) { errors[p + '.sets'] = `At most ${LIMITS.maxSets} sets`; return; }
      const nums = new Set();
      const outSets = [];
      sets.forEach((s, j) => {
        const q = `${p}.sets[${j}]`;
        const st = s && typeof s === 'object' ? s : {};
        const n = Number(st.set_number);
        if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxSets) errors[q + '.set_number'] = `set_number must be 1–${LIMITS.maxSets}`;
        else if (nums.has(n)) errors[q + '.set_number'] = 'set_number must be unique';
        else nums.add(n);

        let kg = num(st.load_kg);
        if (st.load_kg != null && st.load_kg !== '' && kg == null) errors[q + '.load_kg'] = 'load_kg must be a number';
        else if (kg != null) {
          if (kg < LIMITS.loadKg.min || kg > LIMITS.loadKg.max) errors[q + '.load_kg'] = 'load_kg must be 0–500';
          else if (!isLoadStep(kg)) errors[q + '.load_kg'] = 'load_kg must be in 0.25 kg steps';
        }
        if (row.load_type === 'bodyweight') kg = kg == null ? null : kg; // bodyweight moves may carry added load

        const reps = st.reps == null || st.reps === '' ? null : Number(st.reps);
        if (reps != null && (!Number.isInteger(reps) || reps < LIMITS.reps.min || reps > LIMITS.reps.max)) errors[q + '.reps'] = 'reps must be a whole number 0–100';
        const secs = st.seconds == null || st.seconds === '' ? null : Number(st.seconds);
        if (secs != null && (!Number.isInteger(secs) || secs < LIMITS.seconds.min || secs > LIMITS.seconds.max)) errors[q + '.seconds'] = 'seconds must be a whole number 0–3600';

        if (row.unit === 'seconds' && secs == null && !errors[q + '.seconds']) errors[q + '.seconds'] = 'seconds is required for a timed exercise';
        if (row.unit === 'reps' && reps == null && !errors[q + '.reps']) errors[q + '.reps'] = 'reps is required';

        const rpe = st.rpe == null || st.rpe === '' ? null : Number(st.rpe);
        if (rpe != null && (!Number.isInteger(rpe) || rpe < 1 || rpe > 10)) errors[q + '.rpe'] = 'rpe must be 1–10';

        outSets.push({
          set_number: n,
          load_kg: kg,
          reps: row.unit === 'reps' ? reps : null,
          seconds: row.unit === 'seconds' ? secs : null,
          rpe
        });
      });
      outEx.push({ exercise_id: id, order, name: row.name, sets: outSets });
    });
  }

  if (Object.keys(errors).length) return { errors };
  outEx.sort((a, b2) => a.order - b2.order);
  const totals = computeVolume(outEx);
  return {
    value: {
      client_uuid: clientUuid,
      area,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_seconds: duration,
      local_date: localDate,
      notes: notes.trim(),
      app_platform: String(b.app_platform || '').trim().slice(0, 20) || null,
      exercises: outEx,
      total_sets: totals.total_sets,
      total_volume_kg: totals.total_volume_kg
    }
  };
}

/** Coins post on the workout's own local day, never later than the user's today. */
function coinDay(localDate, todayYmd) {
  if (!isYmd(localDate)) return todayYmd;
  if (isYmd(todayYmd) && ymdToDay(localDate) > ymdToDay(todayYmd)) return todayYmd;
  return localDate;
}

const LOG_AREA_NAMES = { upper: 'Upper', lower: 'Lower', core: 'Core', full: 'Full Body' };
function workoutLogName(area) {
  return 'Coach Mode · ' + (LOG_AREA_NAMES[area] || 'Workout');
}

/* ----------------------------------------------- admin edit + approval */

function cleanStrList(v, max, len) {
  return asArray(v).map((s) => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, len));
}

/**
 * Validate an admin PUT. Only the listed fields are editable; returns
 * { errors } or { patch } (column → value, JSON columns already stringified).
 */
function validateExercisePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (has('name')) {
    const v = String(b.name || '').trim();
    if (!v || v.length > 80) errors.name = 'name is required (80 characters max)';
    else patch.name = v;
  }
  if (has('area')) {
    if (!AREAS.includes(b.area)) errors.area = 'area must be one of ' + AREAS.join(', ');
    else patch.area = b.area;
  }
  for (const k of ['equipment', 'level', 'mechanic', 'force']) {
    if (has(k)) patch[k] = String(b[k] == null ? '' : b[k]).trim().slice(0, 40);
  }
  for (const k of ['primary_muscles', 'secondary_muscles']) {
    if (has(k)) {
      const list = cleanStrList(b[k], 8, 30).map((s) => s.toLowerCase());
      const bad = list.filter((m) => !MUSCLES.includes(m));
      if (bad.length) errors[k] = 'Unknown muscle: ' + bad.join(', ');
      else patch[k] = list;
    }
  }
  if (has('steps')) {
    const raw = asArray(b.steps).map((s) => String(s || '').trim()).filter(Boolean);
    if (raw.length > LIMITS.steps.max) errors.steps = `At most ${LIMITS.steps.max} steps`;
    else if (raw.some((s) => s.length > LIMITS.steps.len)) errors.steps = `Each step must be ${LIMITS.steps.len} characters or fewer`;
    else patch.steps = JSON.stringify(raw);
  }
  if (has('cues')) {
    const raw = asArray(b.cues).map((s) => String(s || '').trim()).filter(Boolean);
    if (raw.length > LIMITS.cues.max) errors.cues = `At most ${LIMITS.cues.max} cues`;
    else if (raw.some((s) => s.length > LIMITS.cues.len)) errors.cues = `Each cue must be ${LIMITS.cues.len} characters or fewer`;
    else patch.cues = JSON.stringify(raw);
  }
  if (has('common_mistakes')) {
    const raw = mapMistakes(b.common_mistakes)
      .map((m) => ({ mistake: m.mistake.trim(), fix: m.fix.trim() }))
      .filter((m) => m.mistake);
    if (raw.length > LIMITS.mistakes.max) errors.common_mistakes = `At most ${LIMITS.mistakes.max} mistakes`;
    else if (raw.some((m) => m.mistake.length > LIMITS.mistakes.len || m.fix.length > LIMITS.mistakes.len)) errors.common_mistakes = `Each mistake and fix must be ${LIMITS.mistakes.len} characters or fewer`;
    else patch.common_mistakes = JSON.stringify(raw);
  }
  if (has('contraindications')) {
    const list = cleanStrList(b.contraindications, 6, 20);
    const bad = list.filter((t) => !CARE_TAGS.includes(t));
    if (bad.length) errors.contraindications = 'Unknown tag: ' + bad.join(', ');
    else patch.contraindications = JSON.stringify([...new Set(list)]);
  }
  if (has('unit')) {
    if (!['reps', 'seconds'].includes(b.unit)) errors.unit = 'unit must be reps or seconds';
    else patch.unit = b.unit;
  }
  if (has('load_type')) {
    if (!['kg', 'bodyweight'].includes(b.load_type)) errors.load_type = 'load_type must be kg or bodyweight';
    else patch.load_type = b.load_type;
  }
  if (has('per_side')) patch.per_side = !!b.per_side;
  if (has('ai_form_check')) patch.ai_form_check = !!b.ai_form_check;
  if (has('ai_trainer_key')) {
    const v = b.ai_trainer_key == null || b.ai_trainer_key === '' ? null : String(b.ai_trainer_key);
    if (v && !AI_TRAINER_KEYS.includes(v)) errors.ai_trainer_key = 'Not a move the AI Trainer can judge';
    else patch.ai_trainer_key = v;
  }
  const intField = (k, lo, hi) => {
    if (!has(k)) return;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errors[k] = `${k} must be a whole number ${lo}–${hi}`;
    else patch[k] = n;
  };
  intField('default_sets', 1, 10);
  intField('default_reps', 1, 3600);
  intField('sort_order', 0, 10000);
  if (has('load_step_kg')) {
    const n = Number(b.load_step_kg);
    if (!Number.isFinite(n) || n < 0 || n > 20 || !isLoadStep(n)) errors.load_step_kg = 'load_step_kg must be 0–20 in 0.25 steps';
    else patch.load_step_kg = n;
  }
  if (has('review_notes')) patch.review_notes = String(b.review_notes || '').trim().slice(0, 2000);

  if (patch.ai_form_check === true && has('ai_trainer_key') && !patch.ai_trainer_key) {
    errors.ai_form_check = 'Pick the AI Trainer move first';
  }
  return Object.keys(errors).length ? { errors } : { patch };
}

/** Approve gate (spec): ≥3 cues, ≥2 mistakes, ≥1 image, review note written. */
function approvalProblems(row) {
  const out = [];
  const cues = asArray(row.cues).filter((s) => String(s || '').trim());
  if (cues.length < 3) out.push('needs at least 3 cues');
  if (mapMistakes(row.common_mistakes).filter((m) => m.mistake.trim()).length < 2) out.push('needs at least 2 common mistakes');
  if (!imagesOf(row).length) out.push('needs at least 1 image');
  if (!String(row.review_notes || '').trim()) out.push('write a review note first');
  if (!asArray(row.steps).length) out.push('needs steps');
  if (row.ai_form_check && !(row.ai_trainer_key && AI_TRAINER_KEYS.includes(row.ai_trainer_key))) out.push('AI form check is on but no AI Trainer move is set');
  return out;
}

/** Draft-file shape check for scripts/coach-seed.js and the unit tests. */
function draftProblems(d) {
  const p = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(d.id || ''))) p.push('id must be kebab-case');
  if (!d.source_id) p.push('source_id missing');
  if (!d.name) p.push('name missing');
  if (!AREAS.includes(d.area)) p.push('bad area');
  const steps = asArray(d.steps);
  if (steps.length < 1 || steps.length > LIMITS.steps.max) p.push('steps count');
  if (steps.some((s) => String(s).length > LIMITS.steps.len)) p.push('step too long');
  const cues = asArray(d.cues);
  if (cues.length < LIMITS.cues.min || cues.length > LIMITS.cues.max) p.push('cues count');
  if (cues.some((s) => String(s).length > LIMITS.cues.len)) p.push('cue too long');
  const mk = mapMistakes(d.common_mistakes);
  if (mk.length < 2) p.push('mistakes count');
  if (mk.some((m) => m.mistake.length > LIMITS.mistakes.len || m.fix.length > LIMITS.mistakes.len)) p.push('mistake too long');
  if (asArray(d.contraindications).some((t) => !CARE_TAGS.includes(t))) p.push('bad contraindication tag');
  if (!['reps', 'seconds'].includes(d.unit)) p.push('bad unit');
  if (!['kg', 'bodyweight'].includes(d.load_type)) p.push('bad load_type');
  if (d.ai_trainer_key != null && !AI_TRAINER_KEYS.includes(d.ai_trainer_key)) p.push('bad ai_trainer_key');
  const muscles = [...asArray(d.primary_muscles), ...asArray(d.secondary_muscles)];
  if (!asArray(d.primary_muscles).length) p.push('primary_muscles missing');
  if (muscles.some((m) => !MUSCLES.includes(m))) p.push('unknown muscle');
  // Member-facing text must stay clear of prices and medical claims.
  const text = [...steps, ...cues, ...mk.map((m) => m.mistake + ' ' + m.fix)].join(' ');
  if (/(₹|\brs\.?\s?\d|\$\d|\bprice\b|\bsupplement|\bcure[sd]?\b|\bheals?\b|\btreats?\b|\bdiagnos)/i.test(text)) p.push('forbidden wording (price/medical/supplement)');
  return p;
}

module.exports = {
  AREAS,
  AREA_LABELS,
  STATUSES,
  CARE_TAGS,
  AI_TRAINER_KEYS,
  MUSCLES,
  LIMITS,
  CARE_NOTES,
  DDL,
  STAFF_ROLES,
  ensureCoachTables,
  importLibraryIfEmpty,
  flagConfig,
  isEnabledFor,
  asArray,
  toYmd,
  computeVolume,
  careMatch,
  toListItem,
  toGuide,
  validateWorkout,
  coinDay,
  workoutLogName,
  validateExercisePatch,
  approvalProblems,
  draftProblems
};
