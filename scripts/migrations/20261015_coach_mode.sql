-- Coach Mode schema (2026-10-15). Identical to services/coachModeService.js DDL,
-- which server.js runs at boot. Additive only: no DROP, no RENAME, no edits to existing columns.
-- Rollback: COACH_MODE_ENABLED=off hides everything; these tables are harmless to keep.

CREATE TABLE IF NOT EXISTS coach_exercises (
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
  );

CREATE INDEX IF NOT EXISTS idx_coach_ex_area_status ON coach_exercises(area, status, sort_order);

CREATE TABLE IF NOT EXISTS coach_workouts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  client_uuid TEXT NOT NULL,
  area TEXT NOT NULL, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  duration_seconds INT DEFAULT 0, total_sets INT DEFAULT 0, total_volume_kg NUMERIC(10,2) DEFAULT 0,
  notes TEXT DEFAULT '', local_date DATE NOT NULL, workout_log_id TEXT,
  app_platform TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, client_uuid)
  );

CREATE INDEX IF NOT EXISTS idx_coach_workouts_user_date ON coach_workouts(user_id, local_date DESC);

CREATE TABLE IF NOT EXISTS coach_sets (
  id TEXT PRIMARY KEY, workout_id TEXT NOT NULL REFERENCES coach_workouts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, exercise_id TEXT NOT NULL REFERENCES coach_exercises(id),
  exercise_order INT NOT NULL, set_number INT NOT NULL,
  load_kg NUMERIC(6,2), reps INT, seconds INT, completed BOOLEAN DEFAULT TRUE, rpe SMALLINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workout_id, exercise_order, set_number)
  );

CREATE INDEX IF NOT EXISTS idx_coach_sets_user_ex ON coach_sets(user_id, exercise_id, created_at DESC);

ALTER TABLE coach_exercises ADD COLUMN IF NOT EXISTS per_side BOOLEAN DEFAULT FALSE;

ALTER TABLE coach_exercises ADD COLUMN IF NOT EXISTS ai_trainer_key TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS coach_care_tags TEXT[] DEFAULT '{}';
