-- BodyBank Challenges schema (2026-10-15). Identical to services/challengeService.js DDL,
-- which server.js runs at boot. Additive only: new tables, no DROP, no RENAME, no edits to existing columns.
-- Rollback: CHALLENGES_ENABLED=off hides everything; these tables are harmless to keep.

CREATE TABLE IF NOT EXISTS challenges (
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
  );

CREATE TABLE IF NOT EXISTS challenge_tasks (
    id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    day_number INT NOT NULL, position INT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily_checkin','protein_target','meals_logged','coach_workout','workout_any','steps','water','sleep','mind_checkin','sunday_checkin','manual')),
    params JSONB NOT NULL DEFAULT '{}',
    title TEXT NOT NULL, points INT DEFAULT 100,
    UNIQUE (challenge_id, day_number, position)
  );

CREATE TABLE IF NOT EXISTS challenge_enrollments (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_challenge_active_one ON challenge_enrollments(user_id, challenge_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ch_enroll_board ON challenge_enrollments(challenge_id, status, points DESC);

CREATE INDEX IF NOT EXISTS idx_ch_enroll_user ON challenge_enrollments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS challenge_task_completions (
    id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES challenge_enrollments(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES challenge_tasks(id), user_id TEXT NOT NULL, day_number INT NOT NULL, local_date DATE NOT NULL,
    evidence JSONB DEFAULT '{}', completed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (enrollment_id, task_id)
  );

CREATE TABLE IF NOT EXISTS challenge_rewards (
    id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES challenge_enrollments(id), user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('coins_day','coins_complete','badge','certificate','discount','lm_call')),
    reward_key TEXT NOT NULL UNIQUE,
    payload JSONB DEFAULT '{}', status TEXT DEFAULT 'granted', created_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_ch_rewards_user ON challenge_rewards(user_id, kind);

CREATE TABLE IF NOT EXISTS challenge_lm_requests (
    id TEXT PRIMARY KEY, enrollment_id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, phone TEXT, preferred_slot TEXT,
    status TEXT DEFAULT 'requested' CHECK (status IN ('requested','scheduled','done','cancelled')), notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS challenge_discounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, enrollment_id TEXT UNIQUE NOT NULL, pct INT NOT NULL CHECK (pct BETWEEN 1 AND 50),
    applies_to TEXT[] NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_payment_id TEXT, used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS challenge_discount_orders (
    order_id TEXT PRIMARY KEY, discount_id TEXT NOT NULL REFERENCES challenge_discounts(id), user_id TEXT NOT NULL,
    original_paise INT NOT NULL, discounted_paise INT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS challenge_push_log (
    id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, user_id TEXT NOT NULL, local_date DATE NOT NULL, slot TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (enrollment_id, local_date, slot)
  );

CREATE TABLE IF NOT EXISTS challenge_audit (
    id TEXT PRIMARY KEY, enrollment_id TEXT, challenge_id TEXT, actor_id TEXT, action TEXT NOT NULL,
    notes TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW()
  );
