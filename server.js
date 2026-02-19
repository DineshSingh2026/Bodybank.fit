require('dotenv').config();
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { signToken, verifyToken, requireAdmin, signProgressReportToken, verifyProgressReportToken } = require('./middleware/auth');
const progressRoutes = require('./routes/progress');
const { getUserProgress: getAdminUserProgress } = require('./controllers/adminProgressController');
const progressService = require('./services/progressService');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bodybank.fit';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bodybank';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://yoursite.com (production)

const app = express();

// ============ MIDDLEWARE ============
app.use(compression());
app.use(cors({
  origin: NODE_ENV === 'production' && ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(s => s.trim()) : true,
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Simple rate limiter (in-memory)
const rateLimit = {};
function rateLimiter(limit, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    if (!rateLimit[key]) rateLimit[key] = [];
    rateLimit[key] = rateLimit[key].filter(t => now - t < windowMs);
    if (rateLimit[key].length >= limit) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    rateLimit[key].push(now);
    next();
  };
}

// Request logging (dev only)
if (NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });
}

let pool;

/** Convert SQL with ? placeholders to PostgreSQL $1, $2, ... */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res;
}

async function queryAll(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows || [];
}

async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ============ DATABASE ============
async function initDB() {
  pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (e) {
    console.error('❌ PostgreSQL connection failed:', e.message);
    throw e;
  }

  // Create tables (PostgreSQL types: TEXT, INTEGER, REAL, TIMESTAMP)
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    profile_picture TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    approval_status TEXT DEFAULT 'approved',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await pool.query(`ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'approved'`); } catch (e) { /* column may exist */ }
  await pool.query("UPDATE users SET approval_status = 'approved' WHERE approval_status IS NULL").catch(() => {});

  await pool.query(`CREATE TABLE IF NOT EXISTS audit_requests (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    age INTEGER,
    sex TEXT DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT DEFAULT '',
    country TEXT DEFAULT '',
    city TEXT DEFAULT '',
    occupation TEXT DEFAULT '',
    work_intensity TEXT DEFAULT '',
    fitness_experience TEXT DEFAULT '',
    goals TEXT DEFAULT '',
    motivation TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS tribe_members (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    city TEXT DEFAULT '',
    phase INTEGER DEFAULT 1,
    start_date TEXT,
    activity_per_week INTEGER DEFAULT 0,
    starting_weight REAL,
    current_weight REAL,
    target_weight REAL,
    next_checkin TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS workout_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workout_name TEXT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    feedback TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    message TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    user_phone TEXT DEFAULT '',
    meeting_date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    status TEXT DEFAULT 'scheduled',
    notes TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS part2_audit (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    mobile TEXT DEFAULT '',
    sports_history TEXT DEFAULT '',
    injuries TEXT DEFAULT '',
    mental_health TEXT DEFAULT '',
    gym_experience TEXT DEFAULT '',
    food_choices TEXT DEFAULT '',
    vices_addictions TEXT DEFAULT '',
    goals TEXT DEFAULT '',
    what_compelled TEXT DEFAULT '',
    activity_level TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS hydration_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_ml INTEGER DEFAULT 0,
    glasses INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS weight_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sunday_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    full_name TEXT NOT NULL,
    reply_email TEXT NOT NULL,
    plan TEXT DEFAULT '',
    current_weight_waist_week TEXT DEFAULT '',
    last_week_weight_waist TEXT DEFAULT '',
    total_weight_loss TEXT DEFAULT '',
    training_go TEXT DEFAULT '',
    nutrition_go TEXT DEFAULT '',
    sleep TEXT DEFAULT '',
    occupation_stress TEXT DEFAULT '',
    other_stress TEXT DEFAULT '',
    differences_felt TEXT DEFAULT '',
    achievements TEXT DEFAULT '',
    improve_next_week TEXT DEFAULT '',
    questions TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Client Progress Analytics: user_goals, progress_logs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_goals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_weight NUMERIC,
      target_body_fat NUMERIC,
      weekly_workout_target INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weight NUMERIC(5,2),
      body_fat NUMERIC(5,2),
      calories_intake INTEGER,
      protein_intake INTEGER,
      workout_completed BOOLEAN DEFAULT false,
      workout_type VARCHAR(100),
      strength_bench NUMERIC(6,2),
      strength_squat NUMERIC(6,2),
      strength_deadlift NUMERIC(6,2),
      sleep_hours NUMERIC(3,1),
      water_intake NUMERIC(4,1),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_progress_logs_user_id ON progress_logs(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_progress_logs_created_at ON progress_logs(created_at)`).catch(() => {});

  // Create admin (in production, require ADMIN_PASS to be set and not default)
  if (NODE_ENV === 'production' && (!process.env.ADMIN_PASS || ADMIN_PASS === 'admin123')) {
    console.warn('⚠️ Production: set ADMIN_PASS in .env to a strong password. Default admin password is not allowed.');
  }
  const adminRow = await queryOne("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!adminRow) {
    if (NODE_ENV === 'production' && ADMIN_PASS === 'admin123') {
      console.error('❌ Refusing to create admin with default password in production. Set ADMIN_PASS in .env and restart.');
    } else {
      const hash = bcrypt.hashSync(ADMIN_PASS, 10);
      const adminEmailNorm = String(ADMIN_EMAIL).trim().toLowerCase();
      await run("INSERT INTO users (id, email, password, first_name, last_name, role, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), adminEmailNorm, hash, 'Body', 'Bank', 'admin', 'approved']);
      console.log(`✅ Admin created: ${ADMIN_EMAIL}`);
    }
  }

  // Seed sample data if empty
  try {
    const tribeRow = await queryOne("SELECT COUNT(*) as c FROM tribe_members");
    const tribeCount = parseInt(tribeRow?.c ?? 0, 10);
    if (tribeCount === 0) {
      await seedData();
      console.log('✅ Sample data seeded');
    }
  } catch (e) {
    console.error('Seed check error:', e.message);
  }
}

function shutdown() {
  console.log('\nShutting down...');
  if (pool) pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function seedData() {
  const members = [
    ['Arjun', 'Sharma', 'arjun.s@gmail.com', '9876543210', 'Mumbai', 2, '2024-12-20', 5, 78, 72, 68, '2026-02-16', 'Strong progress'],
    ['Neha', 'Kapoor', 'neha.k@gmail.com', '9876543211', 'Delhi', 1, '2026-01-30', 4, 65, 64, 58, '2026-02-18', 'Just started'],
    ['Vikram', 'Rao', 'vikram.r@gmail.com', '9876543212', 'Hyderabad', 3, '2024-11-08', 6, 90, 76, 74, '2026-02-15', 'Almost done'],
    ['Sneha', 'Pillai', 'sneha.p@gmail.com', '9876543213', 'Bangalore', 2, '2025-01-03', 4, 58, 54, 52, '2026-02-17', 'Great commitment'],
    ['Rohan', 'Joshi', 'rohan.j@gmail.com', '9876543214', 'Pune', 1, '2026-02-06', 3, 85, 85, 75, '2026-02-20', 'Week 1'],
  ];
  for (const m of members) {
    await run(`INSERT INTO tribe_members (id, first_name, last_name, email, phone, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, next_checkin, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), ...m]);
  }
  const requests = [
    ['Priya', 'Sharma', 28, 'Female', 'priya.s@gmail.com', '9876543220', 'India', 'Mumbai', 'Marketing Manager', 'Sedentary', 'Some experience', 'Fat loss & toning', 'Want to feel confident'],
    ['Rahul', 'Mehra', 32, 'Male', 'rahul.m@outlook.com', '9876543221', 'India', 'Delhi', 'Software Engineer', 'Sedentary', 'Regular gym-goer', 'Muscle gain', 'Health scare from doctor'],
    ['Ananya', 'Reddy', 25, 'Female', 'ananya.r@yahoo.com', '9876543222', 'India', 'Hyderabad', 'Student', 'Light', 'Complete beginner', 'Overall wellness', 'Tired of feeling tired'],
    ['Karan', 'Singh', 29, 'Male', 'karan.s@gmail.com', '9876543223', 'India', 'Bangalore', 'Consultant', 'Moderate', 'Some experience', 'Body recomposition', 'Getting married soon'],
    ['Meera', 'Patel', 34, 'Female', 'meera.p@gmail.com', '9876543224', 'India', 'Pune', 'Business Owner', 'Heavy', 'Complete beginner', 'Lifestyle change', 'Burnout from work'],
  ];
  for (const r of requests) {
    await run(`INSERT INTO audit_requests (id, first_name, last_name, age, sex, email, phone, country, city, occupation, work_intensity, fitness_experience, goals, motivation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), ...r]);
  }
}

// ============ CONFIG ============
app.get('/api/config', (req, res) => {
  res.json({
    google_client_id: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com'
  });
});

// Health check: API + DB connection test
app.get('/api/health', async (req, res) => {
  try {
    const adminCheck = await queryOne("SELECT email FROM users WHERE role='admin' LIMIT 1");
    res.json({
      ok: true,
      db: 'connected',
      admin_email: ADMIN_EMAIL,
      admin_exists: !!adminCheck
    });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error', error: e.message });
  }
});

// ============ AUTH ROUTES ============
app.post('/api/auth/login', rateLimiter(20, 60000), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const emailNorm = String(email).trim().toLowerCase();
    const user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      if (NODE_ENV !== 'production') console.log('[Login] User not found:', emailNorm);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const status = user.approval_status || 'approved';
    if (status === 'rejected') {
      return res.status(403).json({ error: 'rejected', message: 'Your request was rejected. Please sign up again to submit a new request.' });
    }
    if (status !== 'approved') {
      return res.status(403).json({ error: 'pending_approval', message: 'Your account is pending admin approval. You will be able to log in once approved.' });
    }
    if (!user.password || !bcrypt.compareSync(String(password), user.password)) {
      if (NODE_ENV !== 'production') console.log('[Login] Password mismatch for:', emailNorm);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.json({ id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, profile_picture: user.profile_picture || '', role: user.role, token });
  } catch (e) {
    console.error('[Login] Error:', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Google Auth (auto sign-up/login)
app.post('/api/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'ID token required' });

    // Decode JWT (in production, verify signature with Google's public keys)
    const parts = id_token.split('.');
    if (parts.length !== 3) return res.status(400).json({ error: 'Invalid token' });
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const { email, given_name, family_name, sub: google_id, picture } = payload;
    
    if (!email) return res.status(400).json({ error: 'Email required' });

    const emailNorm = String(email).trim().toLowerCase();
    let user = await queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      // Auto-create account (pending approval)
      const id = uuidv4();
      const hash = bcrypt.hashSync('google_' + google_id, 10);
      await run("INSERT INTO users (id, email, password, first_name, last_name, profile_picture, role, approval_status) VALUES (?,?,?,?,?,?,?,?)",
        [id, emailNorm, hash, given_name || '', family_name || '', picture || '', 'user', 'pending']);
      return res.status(403).json({ error: 'pending_approval', message: 'Your account is pending admin approval. You will be able to log in once approved.' });
    }
    const status = user.approval_status || 'approved';
    if (status === 'rejected') {
      return res.status(403).json({ error: 'rejected', message: 'Your request was rejected. Please sign up again to submit a new request.' });
    }
    if (status !== 'approved') {
      return res.status(403).json({ error: 'pending_approval', message: 'Your account is pending admin approval. You will be able to log in once approved.' });
    }
    if (picture && !user.profile_picture) {
      await run("UPDATE users SET profile_picture = ? WHERE id = ?", [picture, user.id]);
      user.profile_picture = picture;
    }
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.json({ id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '', profile_picture: user.profile_picture || '', role: user.role, token });
  } catch (e) {
    console.error('Google auth error:', e);
    res.status(500).json({ error: 'Google auth failed' });
  }
});

app.post('/api/auth/signup', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { email, password, first_name, last_name, phone } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const emailNorm = String(email).trim().toLowerCase();
    const existing = await queryOne("SELECT id, approval_status FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (existing && existing.approval_status === 'rejected') {
      const hash = bcrypt.hashSync(password, 10);
      await run("UPDATE users SET password = ?, first_name = ?, last_name = ?, phone = ?, approval_status = 'pending' WHERE id = ?",
        [hash, first_name || '', last_name || '', phone || '', existing.id]);
      return res.json({ id: existing.id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user', pending_approval: true });
    }
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    await run("INSERT INTO users (id, email, password, first_name, last_name, phone, approval_status) VALUES (?,?,?,?,?,?,?)",
      [id, emailNorm, hash, first_name || '', last_name || '', phone || '', 'pending']);
    res.json({ id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user', pending_approval: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ AUDIT REQUESTS ============
app.post('/api/audit', rateLimiter(5, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name || !b.email) return res.status(400).json({ error: 'Name and email required' });

    const id = uuidv4();
    await run(`INSERT INTO audit_requests (id,first_name,last_name,age,sex,email,phone,country,city,occupation,work_intensity,fitness_experience,goals,motivation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.first_name, b.last_name||'', b.age||null, b.sex||'', b.email, b.phone||'', b.country||'', b.city||'', b.occupation||'', b.work_intensity||'', b.fitness_experience||'', b.goals||'', b.motivation||'']);
    res.json({ id, message: 'Request submitted successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/audit', async (req, res) => {
  const rows = await queryAll("SELECT * FROM audit_requests ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/audit/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM audit_requests WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.put('/api/audit/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await run("UPDATE audit_requests SET status = ? WHERE id = ?", [status, req.params.id]);
  res.json({ message: 'Updated' });
});

app.delete('/api/audit/:id', async (req, res) => {
  await run("DELETE FROM audit_requests WHERE id = ?", [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ============ PART-2 BODY AUDIT FORM (Shareable) ============
app.post('/api/part2', rateLimiter(5, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.email) return res.status(400).json({ error: 'Name and email required' });

    const id = uuidv4();
    await run(`INSERT INTO part2_audit (id, name, email, mobile, sports_history, injuries, mental_health, gym_experience, food_choices, vices_addictions, goals, what_compelled, activity_level) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name || '', b.email || '', b.mobile || '', b.sports_history || '', b.injuries || '', b.mental_health || '', b.gym_experience || '', b.food_choices || '', b.vices_addictions || '', b.goals || '', b.what_compelled || '', b.activity_level || '']);
    res.json({ id, message: 'Form submitted successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/part2', async (req, res) => {
  const rows = await queryAll("SELECT * FROM part2_audit ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/part2/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM part2_audit WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ============ MEETINGS (Schedule a Call) ============
app.post('/api/meetings', rateLimiter(10, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.user_id || !b.meeting_date || !b.time_slot) {
      return res.status(400).json({ error: 'User, date and time slot required' });
    }

    const id = uuidv4();
    await run(`INSERT INTO meetings (id, user_id, user_name, user_email, user_phone, meeting_date, time_slot, status, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.user_id, b.user_name||'', b.user_email||'', b.user_phone||'', b.meeting_date, b.time_slot, 'scheduled', b.notes||'']);
    res.json({ id, message: 'Call scheduled successfully' });
  } catch (e) {
    console.error('[meetings] POST error:', e.message);
    res.status(500).json({ error: e.message || 'Failed to schedule call' });
  }
});

app.get('/api/meetings', async (req, res) => {
  const rows = await queryAll("SELECT * FROM meetings WHERE status='scheduled' ORDER BY meeting_date ASC, time_slot ASC");
  res.json(rows);
});

app.get('/api/meetings/user/:userId', async (req, res) => {
  const rows = await queryAll("SELECT * FROM meetings WHERE user_id = ? ORDER BY meeting_date DESC, created_at DESC", [req.params.userId]);
  res.json(rows);
});

app.put('/api/meetings/:id', async (req, res) => {
  const { meeting_date, time_slot, status } = req.body || {};
  const row = await queryOne("SELECT * FROM meetings WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const values = [];
  if (meeting_date !== undefined) { updates.push('meeting_date=?'); values.push(meeting_date); }
  if (time_slot !== undefined) { updates.push('time_slot=?'); values.push(time_slot); }
  if (status !== undefined) { updates.push('status=?'); values.push(status); }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });

  values.push(req.params.id);
  await run(`UPDATE meetings SET ${updates.join(',')} WHERE id=?`, values);
  res.json({ message: 'Updated' });
});

// ============ TRIBE MEMBERS ============
app.get('/api/tribe', async (req, res) => {
  const rows = await queryAll("SELECT * FROM tribe_members WHERE status='active' ORDER BY phase DESC, start_date ASC");
  res.json(rows);
});

app.get('/api/tribe/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM tribe_members WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/tribe', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name) return res.status(400).json({ error: 'Name required' });

    const id = uuidv4();
    await run(`INSERT INTO tribe_members (id,first_name,last_name,email,phone,city,phase,start_date,activity_per_week,starting_weight,current_weight,target_weight,next_checkin,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.first_name, b.last_name||'', b.email||'', b.phone||'', b.city||'', b.phase||1, b.start_date||new Date().toISOString().split('T')[0], b.activity_per_week||0, b.starting_weight||null, b.current_weight||null, b.target_weight||null, b.next_checkin||'', b.notes||'']);
    res.json({ id, message: 'Member added' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

app.put('/api/tribe/:id', async (req, res) => {
  const allowed = ['first_name','last_name','email','phone','city','phase','activity_per_week','starting_weight','current_weight','target_weight','next_checkin','notes','status'];
  const updates = [], values = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.includes(k)) { updates.push(`${k}=?`); values.push(v); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
  values.push(req.params.id);
  await run(`UPDATE tribe_members SET ${updates.join(',')} WHERE id=?`, values);
  res.json({ message: 'Updated' });
});

app.delete('/api/tribe/:id', async (req, res) => {
  await run("DELETE FROM tribe_members WHERE id = ?", [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ============ USER PROFILE ============
app.get('/api/profile/:id', async (req, res) => {
  const user = await queryOne("SELECT id,email,first_name,last_name,phone,profile_picture,role,created_at FROM users WHERE id=?", [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.put('/api/profile/:id', async (req, res) => {
  const { first_name, last_name, phone, email, profile_picture } = req.body || {};
  const updates = [], values = [];
  if (first_name !== undefined) { updates.push('first_name=?'); values.push(first_name); }
  if (last_name !== undefined) { updates.push('last_name=?'); values.push(last_name); }
  if (phone !== undefined) { updates.push('phone=?'); values.push(phone); }
  if (email !== undefined) {
    const emailNorm = String(email).trim().toLowerCase();
    const other = await queryOne("SELECT id FROM users WHERE LOWER(email) = ? AND id != ?", [emailNorm, req.params.id]);
    if (other) return res.status(409).json({ error: 'Email already in use' });
    updates.push('email=?');
    values.push(emailNorm);
  }
  if (profile_picture !== undefined) { updates.push('profile_picture=?'); values.push(profile_picture); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  try {
    await run(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);
    res.json({ message: 'Profile updated' });
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ============ WORKOUT LOGS ============
app.post('/api/workouts', async (req, res) => {
  try {
    const { user_id, workout_name, duration_seconds, feedback } = req.body || {};
    if (!user_id || !workout_name) return res.status(400).json({ error: 'User and workout name required' });
    const id = uuidv4();
    await run("INSERT INTO workout_logs (id,user_id,workout_name,duration_seconds,feedback) VALUES (?,?,?,?,?)",
      [id, user_id, workout_name, duration_seconds || 0, feedback || '']);
    res.json({ id, message: 'Workout logged' });
  } catch (e) {
    console.error('Workout error:', e.message);
    res.status(500).json({ error: 'Failed to log workout' });
  }
});

// Admin: get all workouts (must be before :userId to avoid conflict)
app.get('/api/workouts', async (req, res) => {
  const rows = await queryAll(`SELECT w.*, u.first_name, u.last_name, u.email 
    FROM workout_logs w JOIN users u ON w.user_id = u.id 
    ORDER BY w.created_at DESC LIMIT 100`);
  res.json(rows);
});

app.get('/api/workouts/:userId', async (req, res) => {
  const rows = await queryAll("SELECT * FROM workout_logs WHERE user_id=? ORDER BY created_at DESC", [req.params.userId]);
  res.json(rows);
});

// ============ CONTACT MESSAGES ============
app.post('/api/contact', rateLimiter(5, 60000), async (req, res) => {
  try {
    const { user_id, name, phone, email, message } = req.body || {};
    if (!name || !message) return res.status(400).json({ error: 'Name and message required' });
    const id = uuidv4();
    await run("INSERT INTO contact_messages (id,user_id,name,phone,email,message) VALUES (?,?,?,?,?,?)",
      [id, user_id || null, name, phone || '', email || '', message]);
    res.json({ id, message: 'Message sent' });
  } catch (e) {
    console.error('Contact error:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/api/contact', async (req, res) => {
  const rows = await queryAll("SELECT * FROM contact_messages ORDER BY created_at DESC");
  res.json(rows);
});

// ============ SUNDAY CHECK-IN (User submit) ============
app.post('/api/sunday-checkin', rateLimiter(10, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.full_name) return res.status(400).json({ error: 'Full name is required' });
    const id = uuidv4();
    await run(`INSERT INTO sunday_checkins (id, user_id, full_name, reply_email, plan, current_weight_waist_week, last_week_weight_waist, total_weight_loss, training_go, nutrition_go, sleep, occupation_stress, other_stress, differences_felt, achievements, improve_next_week, questions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.user_id || null, b.full_name || '', b.reply_email || '', b.plan || '', b.current_weight_waist_week || '', b.last_week_weight_waist || '', b.total_weight_loss || '', b.training_go || '', b.nutrition_go || '', b.sleep || '', b.occupation_stress || '', b.other_stress || '', b.differences_felt || '', b.achievements || '', b.improve_next_week || '', b.questions || '']);
    res.json({ id, message: 'Sunday check-in submitted successfully' });
  } catch (e) {
    console.error('Sunday check-in error:', e.message);
    res.status(500).json({ error: 'Failed to submit check-in' });
  }
});

app.get('/api/sunday-checkin', async (req, res) => {
  const rows = await queryAll("SELECT id, full_name, reply_email, created_at FROM sunday_checkins ORDER BY created_at DESC");
  res.json(rows);
});

app.get('/api/sunday-checkin/:id', async (req, res) => {
  const row = await queryOne("SELECT * FROM sunday_checkins WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ============ ADMIN: PENDING SIGNUPS & APPROVE ============
app.get('/api/admin/pending-signups', async (req, res) => {
  try {
    const list = await queryAll("SELECT id, email, first_name, last_name, created_at FROM users WHERE role = 'user' AND (approval_status IS NULL OR approval_status = 'pending') ORDER BY created_at DESC");
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch pending sign-ups' });
  }
});

app.post('/api/admin/approve-user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot change admin approval' });
    await run("UPDATE users SET approval_status = 'approved' WHERE id = ?", [id]);
    res.json({ message: 'User approved' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

app.post('/api/admin/reject-user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot change admin approval' });
    await run("UPDATE users SET approval_status = 'rejected' WHERE id = ?", [id]);
    res.json({ message: 'User rejected' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

app.get('/api/admin/pending-signup/:id', async (req, res) => {
  try {
    const user = await queryOne("SELECT id, email, first_name, last_name, phone, created_at FROM users WHERE id = ? AND role = 'user' AND (approval_status IS NULL OR approval_status = 'pending')", [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch sign-up request' });
  }
});

// ============ NOTIFICATIONS (Admin) ============
app.get('/api/notifications', async (req, res) => {
  try {
    const notifications = [];
    const pending = await queryAll("SELECT id, first_name, last_name, email, created_at FROM audit_requests WHERE status='pending' ORDER BY created_at DESC LIMIT 10");
    pending.forEach(r => {
      notifications.push({
        id: 'audit-' + r.id,
        type: 'audit',
        title: 'New Body Audit Request',
        desc: `${r.first_name} ${r.last_name} (${r.email})`,
        time: r.created_at,
        link: 'requests'
      });
    });
    const messages = await queryAll("SELECT id, name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 10");
    messages.forEach(m => {
      const msg = (m.message || '').substring(0, 50);
      notifications.push({
        id: 'message-' + m.id,
        type: 'message',
        title: 'New Contact Message',
        desc: `${m.name}: ${msg}${(m.message || '').length > 50 ? '...' : ''}`,
        time: m.created_at,
        link: 'messages'
      });
    });
    const tribe = await queryAll("SELECT id, first_name, last_name, created_at FROM tribe_members WHERE status='active' ORDER BY created_at DESC LIMIT 5");
    tribe.forEach(t => {
      notifications.push({
        id: 'tribe-' + t.id,
        type: 'user',
        title: 'New Tribe Member',
        desc: `${t.first_name} ${t.last_name} joined`,
        time: t.created_at,
        link: 'tribe'
      });
    });
    const workouts = await queryAll("SELECT w.id, w.workout_name, w.duration_seconds, w.created_at, u.first_name, u.last_name FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 5");
    workouts.forEach(w => {
      const m = Math.floor((w.duration_seconds || 0) / 60);
      notifications.push({
        id: 'workout-' + w.id,
        type: 'workout',
        title: 'Workout Logged',
        desc: `${w.first_name || ''} ${w.last_name || ''} - ${w.workout_name} (${m} min)`,
        time: w.created_at,
        link: 'workouts'
      });
    });
    const pendingSignups = await queryAll("SELECT id, email, first_name, last_name, created_at FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'pending') ORDER BY created_at DESC LIMIT 10");
    pendingSignups.forEach(u => {
      notifications.push({
        id: 'signup-' + u.id,
        type: 'user',
        title: 'New User Sign-up (Pending Approval)',
        desc: `${u.first_name || ''} ${u.last_name || ''} (${u.email})`,
        time: u.created_at,
        link: 'signups'
      });
    });
    const part2Subs = await queryAll("SELECT id, name, email, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 5");
    part2Subs.forEach(p => {
      notifications.push({
        id: 'part2-' + p.id,
        type: 'audit',
        title: 'Part-2 Form Submitted',
        desc: `${p.name} (${p.email})`,
        time: p.created_at,
        link: 'part2'
      });
    });
    const meetReqs = await queryAll("SELECT id, user_name, user_email, meeting_date, time_slot, created_at FROM meetings WHERE status='scheduled' ORDER BY created_at DESC LIMIT 5");
    meetReqs.forEach(m => {
      notifications.push({
        id: 'meeting-' + m.id,
        type: 'audit',
        title: 'Call Scheduled',
        desc: `${m.user_name || m.user_email} — ${m.meeting_date} ${m.time_slot}`,
        time: m.created_at,
        link: 'meetings'
      });
    });
    notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json(notifications.slice(0, 30));
  } catch (e) {
    res.status(500).json([]);
  }
});

// ============ STATS ============
app.get('/api/stats', async (req, res) => {
  const pending = await queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'");
  const active = await queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='active'");
  const completed = await queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='completed'");
  const total = await queryAll("SELECT COUNT(*) as c FROM tribe_members");

  const num = (v) => (v === undefined || v === null ? 0 : parseInt(String(v), 10) || 0);
  res.json({
    pending_requests: num(pending[0]?.c),
    active_members: num(active[0]?.c),
    completed: num(completed[0]?.c),
    total_members: num(total[0]?.c),
    success_rate: 92
  });
});

// ============ ADMIN: USERS LIST (for insights filter; exclude E2E test users) ============
app.get('/api/admin/users', async (req, res) => {
  try {
    const list = await queryAll(
      "SELECT id, first_name, last_name, email FROM users WHERE role = 'user' AND (approval_status IS NULL OR approval_status = 'approved') AND (email NOT LIKE '%@test.bodybank.fit') AND (LOWER(first_name) NOT LIKE '%e2e%') ORDER BY first_name, last_name"
    );
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ ADMIN: PERFORMANCE INSIGHTS ============
app.get('/api/admin/performance-insights', async (req, res) => {
  try {
    const { source = 'all', from: dateFrom, to: dateTo, user_id: filterUserId } = req.query || {};
    const hasDate = dateFrom || dateTo;
    const dateParams = [dateFrom, dateTo].filter(Boolean);

    const summary = {};
    const tables = [
      { key: 'workouts', table: 'workout_logs', countSql: 'SELECT COUNT(*) as c FROM workout_logs w', dateCol: 'w.created_at', userCol: 'w.user_id' },
      { key: 'sunday_checkin', table: 'sunday_checkins', countSql: 'SELECT COUNT(*) as c FROM sunday_checkins', dateCol: 'created_at', userCol: 'user_id' },
      { key: 'audit', table: 'audit_requests', countSql: 'SELECT COUNT(*) as c FROM audit_requests', dateCol: 'created_at', userCol: null },
      { key: 'part2', table: 'part2_audit', countSql: 'SELECT COUNT(*) as c FROM part2_audit', dateCol: 'created_at', userCol: null },
      { key: 'meetings', table: 'meetings', countSql: "SELECT COUNT(*) as c FROM meetings WHERE status='scheduled'", dateCol: 'created_at', userCol: 'user_id' },
      { key: 'messages', table: 'contact_messages', countSql: 'SELECT COUNT(*) as c FROM contact_messages', dateCol: 'created_at', userCol: 'user_id' }
    ];
    const usersApproved = await queryOne("SELECT COUNT(*) as c FROM users WHERE role='user' AND (approval_status IS NULL OR approval_status = 'approved')");
    summary.users_approved = usersApproved?.c ?? 0;

    for (const { key, countSql, dateCol, userCol } of tables) {
      let sql = countSql;
      const params = [];
      const conditions = [];
      if (hasDate && dateCol) {
        if (dateFrom) conditions.push(`date(${dateCol}) >= date(?)`);
        if (dateTo) conditions.push(`date(${dateCol}) <= date(?)`);
        params.push(...dateParams);
      }
      if (filterUserId && userCol) {
        conditions.push(`${userCol} = ?`);
        params.push(filterUserId);
      }
      if (conditions.length) sql += (countSql.toLowerCase().includes(' where ') ? ' AND ' : ' WHERE ') + conditions.join(' AND ');
      const row = await queryOne(sql, params);
      summary[key] = row?.c ?? 0;
    }

    let data = [];
    const pickSource = source.toLowerCase();

    async function runQuery(sql, params = []) {
      return queryAll(sql, params);
    }

    if (pickSource === 'all' || pickSource === 'overview') {
      const limit = 80;
      const w = (await runQuery(`SELECT w.id, w.user_id, w.workout_name, w.duration_seconds, w.created_at, u.first_name, u.last_name FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 200`)).map(r => ({ ...r, _source: 'workouts', _date: r.created_at }));
      const sc = (await runQuery('SELECT id, user_id, full_name, reply_email, created_at FROM sunday_checkins ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'sunday_checkin', _date: r.created_at }));
      const ar = (await runQuery('SELECT id, first_name, last_name, email, created_at FROM audit_requests ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'audit', _date: r.created_at }));
      const p2 = (await runQuery('SELECT id, name, email, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'part2', _date: r.created_at }));
      const meet = (await runQuery("SELECT id, user_id, user_name, user_email, meeting_date, time_slot, created_at FROM meetings ORDER BY created_at DESC LIMIT 200")).map(r => ({ ...r, _source: 'meetings', _date: r.created_at }));
      const msg = (await runQuery('SELECT id, user_id, name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 200')).map(r => ({ ...r, _source: 'messages', _date: r.created_at }));
      data = [...w, ...sc, ...ar, ...p2, ...meet, ...msg];
      if (hasDate) data = data.filter(r => { const d = (r._date || r.created_at || '').toString().slice(0, 10); return (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo); });
      if (filterUserId) data = data.filter(r => r.user_id === filterUserId);
      data.sort((a, b) => new Date(b._date || b.created_at) - new Date(a._date || a.created_at));
      data = data.slice(0, limit);
    } else {
      const limit = 500;
      let sql, params = [];
      const uidCol = { workouts: 'w.user_id', sunday_checkin: 'user_id', meetings: 'user_id' }[pickSource];
      if (pickSource === 'workouts') {
        sql = `SELECT w.id, w.user_id, w.workout_name, w.duration_seconds, w.feedback, w.created_at, u.first_name, u.last_name, u.email FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(w.created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(w.created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('w.user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY w.created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'sunday_checkin') {
        sql = `SELECT id, user_id, full_name, reply_email, plan, total_weight_loss, created_at FROM sunday_checkins`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'audit') {
        sql = `SELECT id, first_name, last_name, email, city, goals, status, created_at FROM audit_requests`;
        if (hasDate) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'part2') {
        sql = `SELECT id, name, email, mobile, activity_level, created_at FROM part2_audit`;
        if (hasDate) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'meetings') {
        sql = `SELECT id, user_id, user_name, user_email, user_phone, meeting_date, time_slot, status, created_at FROM meetings`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      } else if (pickSource === 'messages') {
        sql = `SELECT id, user_id, name, email, phone, message, created_at FROM contact_messages`;
        if (hasDate || filterUserId) { sql += ' WHERE '; const c = []; if (dateFrom) { c.push('date(created_at) >= date(?)'); params.push(dateFrom); } if (dateTo) { c.push('date(created_at) <= date(?)'); params.push(dateTo); } if (filterUserId) { c.push('user_id = ?'); params.push(filterUserId); } sql += c.join(' AND '); }
        sql += ' ORDER BY created_at DESC LIMIT ' + limit;
        data = await runQuery(sql, params);
      }
    }

    res.json({ summary, data, filters: { source: pickSource, dateFrom: dateFrom || null, dateTo: dateTo || null, user_id: filterUserId || null } });
  } catch (e) {
    console.error('Performance insights error:', e.message);
    res.status(500).json({ error: e.message, summary: {}, data: [] });
  }
});

// ============ ADMIN: VIEW DATABASE ============
app.get('/api/admin/db-view', async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const tables = ['users', 'audit_requests', 'tribe_members', 'workout_logs', 'contact_messages', 'meetings', 'part2_audit', 'hydration_logs', 'weight_logs', 'sunday_checkins'];
    const result = {};
    
    for (const table of tables) {
      try {
        const rows = await queryAll(`SELECT * FROM ${table}`);
        result[table] = rows;
      } catch (e) {
        result[table] = { error: e.message };
      }
    }
    
    res.json({
      db: 'postgresql',
      tables: result,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('DB view error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ CLIENT PROGRESS ANALYTICS (JWT-protected) ============
app.use('/api/progress', progressRoutes);
app.get('/api/admin/user-progress/:userId', (req, res, next) => {
  if (NODE_ENV === 'development' && (!req.headers.authorization || !String(req.headers.authorization).startsWith('Bearer '))) {
    return progressService.getAdminUserProgress(req.params.userId)
      .then((data) => res.json(data))
      .catch((e) => { console.error('[admin user-progress]', e.message); res.status(500).json({ error: e.message }); });
  }
  next();
}, verifyToken, requireAdmin, (req, res) => {
  getAdminUserProgress(req, res).catch((e) => {
    console.error('[admin user-progress]', e.message);
    res.status(500).json({ error: e.message });
  });
});

// Progress report: shareable link (token in query – no login required)
app.get('/api/progress-report', async (req, res) => {
  try {
    const token = req.query.token || req.query.t;
    const userId = verifyProgressReportToken(token);
    if (!userId) return res.status(401).json({ error: 'Invalid or expired link' });
    const data = await progressService.getAdminUserProgress(userId);
    res.json(data);
  } catch (e) {
    console.error('[progress-report]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: get shareable progress report link for a user
app.get('/api/admin/progress-report-link/:userId', verifyToken, requireAdmin, (req, res) => {
  try {
    const userId = req.params.userId;
    const token = signProgressReportToken(userId);
    const baseUrl = (req.protocol + '://' + req.get('host')).replace(/\/$/, '');
    const url = baseUrl + '/progress-report.html?t=' + encodeURIComponent(token);
    res.json({ url, token });
  } catch (e) {
    console.error('[progress-report-link]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ SERVE FRONTEND ============
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '7d' : 0
}));
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ============ START ============
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏋️ BodyBank Server running on port ${PORT}`);
    console.log(`📧 Admin: ${ADMIN_EMAIL}`);
    console.log(`🌍 Environment: ${NODE_ENV}\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
