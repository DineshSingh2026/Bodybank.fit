require('dotenv').config();
const express = require('express');
const compression = require('compression');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@bodybank.fit';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bodybank.db');
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

let db;
/** Actual file path used for DB read/write (may differ from DB_PATH if DB_PATH is a directory) */
let dbFilePath = DB_PATH;

// ============ DATABASE ============
async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const stat = fs.statSync(DB_PATH);
    if (stat.isDirectory()) {
      console.warn('⚠️ DB_PATH points to a directory; using a file inside it (no delete, avoids permission errors).');
      dbFilePath = path.join(DB_PATH, 'data.db');
    } else {
      dbFilePath = DB_PATH;
    }
  } else {
    dbFilePath = DB_PATH;
  }

  const dataDir = path.dirname(dbFilePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (fs.existsSync(dbFilePath)) {
    const stat = fs.statSync(dbFilePath);
    if (stat.isDirectory()) {
      db = new SQL.Database();
      console.log('✅ Created new database');
    } else {
      const buffer = fs.readFileSync(dbFilePath);
      db = new SQL.Database(buffer);
      console.log('✅ Loaded existing database');
    }
  } else {
    db = new SQL.Database();
    console.log('✅ Created new database');
  }

  // Create tables
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    profile_picture TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_requests (
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tribe_members (
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS workout_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workout_name TEXT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    feedback TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    message TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    user_phone TEXT DEFAULT '',
    meeting_date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    status TEXT DEFAULT 'scheduled',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS part2_audit (
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Create admin (in production, require ADMIN_PASS to be set and not default)
  if (NODE_ENV === 'production' && (!process.env.ADMIN_PASS || ADMIN_PASS === 'admin123')) {
    console.warn('⚠️ Production: set ADMIN_PASS in .env to a strong password. Default admin password is not allowed.');
  }
  const adminResult = db.exec("SELECT id FROM users WHERE role='admin' LIMIT 1");
  const hasAdmin = adminResult.length > 0 && adminResult[0].values && adminResult[0].values.length > 0;
  if (!hasAdmin) {
    if (NODE_ENV === 'production' && ADMIN_PASS === 'admin123') {
      console.error('❌ Refusing to create admin with default password in production. Set ADMIN_PASS in .env and restart.');
    } else {
      const hash = bcrypt.hashSync(ADMIN_PASS, 10);
      const adminEmailNorm = String(ADMIN_EMAIL).trim().toLowerCase();
      db.run("INSERT INTO users (id, email, password, first_name, last_name, role) VALUES (?, ?, ?, ?, ?, ?)",
        [uuidv4(), adminEmailNorm, hash, 'Body', 'Bank', 'admin']);
      console.log(`✅ Admin created: ${ADMIN_EMAIL}`);
    }
  }

  // Seed sample data if empty
  try {
    const tribe = db.exec("SELECT COUNT(*) FROM tribe_members");
    const tribeCount = tribe?.[0]?.values?.[0]?.[0] ?? 0;
    if (tribeCount === 0) {
      seedData();
      console.log('✅ Sample data seeded');
    }
  } catch (e) {
    console.error('Seed check error:', e.message);
  }

  saveDB();
}

function saveDB() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbFilePath, Buffer.from(data));
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

// Auto-save every 30 seconds
setInterval(saveDB, 30000);

// Graceful shutdown: save DB on exit
function shutdown() {
  console.log('\nShutting down...');
  if (typeof saveDB === 'function') saveDB();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function seedData() {
  const members = [
    ['Arjun', 'Sharma', 'arjun.s@gmail.com', '9876543210', 'Mumbai', 2, '2024-12-20', 5, 78, 72, 68, '2026-02-16', 'Strong progress'],
    ['Neha', 'Kapoor', 'neha.k@gmail.com', '9876543211', 'Delhi', 1, '2026-01-30', 4, 65, 64, 58, '2026-02-18', 'Just started'],
    ['Vikram', 'Rao', 'vikram.r@gmail.com', '9876543212', 'Hyderabad', 3, '2024-11-08', 6, 90, 76, 74, '2026-02-15', 'Almost done'],
    ['Sneha', 'Pillai', 'sneha.p@gmail.com', '9876543213', 'Bangalore', 2, '2025-01-03', 4, 58, 54, 52, '2026-02-17', 'Great commitment'],
    ['Rohan', 'Joshi', 'rohan.j@gmail.com', '9876543214', 'Pune', 1, '2026-02-06', 3, 85, 85, 75, '2026-02-20', 'Week 1'],
  ];
  members.forEach(m => {
    db.run(`INSERT INTO tribe_members (id, first_name, last_name, email, phone, city, phase, start_date, activity_per_week, starting_weight, current_weight, target_weight, next_checkin, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), ...m]);
  });

  const requests = [
    ['Priya', 'Sharma', 28, 'Female', 'priya.s@gmail.com', '9876543220', 'India', 'Mumbai', 'Marketing Manager', 'Sedentary', 'Some experience', 'Fat loss & toning', 'Want to feel confident'],
    ['Rahul', 'Mehra', 32, 'Male', 'rahul.m@outlook.com', '9876543221', 'India', 'Delhi', 'Software Engineer', 'Sedentary', 'Regular gym-goer', 'Muscle gain', 'Health scare from doctor'],
    ['Ananya', 'Reddy', 25, 'Female', 'ananya.r@yahoo.com', '9876543222', 'India', 'Hyderabad', 'Student', 'Light', 'Complete beginner', 'Overall wellness', 'Tired of feeling tired'],
    ['Karan', 'Singh', 29, 'Male', 'karan.s@gmail.com', '9876543223', 'India', 'Bangalore', 'Consultant', 'Moderate', 'Some experience', 'Body recomposition', 'Getting married soon'],
    ['Meera', 'Patel', 34, 'Female', 'meera.p@gmail.com', '9876543224', 'India', 'Pune', 'Business Owner', 'Heavy', 'Complete beginner', 'Lifestyle change', 'Burnout from work'],
  ];
  requests.forEach(r => {
    db.run(`INSERT INTO audit_requests (id, first_name, last_name, age, sex, email, phone, country, city, occupation, work_intensity, fitness_experience, goals, motivation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), ...r]);
  });
}

function queryAll(sql, params = []) {
  if (!params || params.length === 0) {
    const result = db.exec(sql);
    if (!result || result.length === 0) return [];
    return result[0].values.map(row => {
      const obj = {};
      result[0].columns.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  }
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ============ CONFIG ============
app.get('/api/config', (req, res) => {
  res.json({
    google_client_id: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com'
  });
});

// Health check: API + DB connection test
app.get('/api/health', (req, res) => {
  try {
    const adminCheck = queryOne("SELECT email FROM users WHERE role='admin' LIMIT 1");
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
app.post('/api/auth/login', rateLimiter(20, 60000), (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const emailNorm = String(email).trim().toLowerCase();
    const user = queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      if (NODE_ENV !== 'production') console.log('[Login] User not found:', emailNorm);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.password || !bcrypt.compareSync(String(password), user.password)) {
      if (NODE_ENV !== 'production') console.log('[Login] Password mismatch for:', emailNorm);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({ id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, profile_picture: user.profile_picture || '', role: user.role });
  } catch (e) {
    console.error('[Login] Error:', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Google Auth (auto signup/login)
app.post('/api/auth/google', (req, res) => {
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
    let user = queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (!user) {
      // Auto-create account (store normalized email)
      const id = uuidv4();
      const hash = bcrypt.hashSync('google_' + google_id, 10);
      db.run("INSERT INTO users (id, email, password, first_name, last_name, profile_picture, role) VALUES (?,?,?,?,?,?,?)",
        [id, emailNorm, hash, given_name || '', family_name || '', picture || '', 'user']);
      saveDB();
      user = { id, email: emailNorm, first_name: given_name || '', last_name: family_name || '', profile_picture: picture || '', role: 'user' };
    } else if (picture && !user.profile_picture) {
      // Update profile picture if available and not set
      db.run("UPDATE users SET profile_picture = ? WHERE id = ?", [picture, user.id]);
      saveDB();
      user.profile_picture = picture;
    }
    res.json({ id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '', profile_picture: user.profile_picture || '', role: user.role });
  } catch (e) {
    console.error('Google auth error:', e);
    res.status(500).json({ error: 'Google auth failed' });
  }
});

app.post('/api/auth/signup', rateLimiter(5, 60000), (req, res) => {
  try {
    const { email, password, first_name, last_name, phone } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const emailNorm = String(email).trim().toLowerCase();
    const existing = queryOne("SELECT id FROM users WHERE LOWER(email) = ?", [emailNorm]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (id, email, password, first_name, last_name, phone) VALUES (?,?,?,?,?,?)",
      [id, emailNorm, hash, first_name || '', last_name || '', phone || '']);
    saveDB();
    res.json({ id, email: emailNorm, first_name: first_name || '', last_name: last_name || '', role: 'user' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ AUDIT REQUESTS ============
app.post('/api/audit', rateLimiter(5, 60000), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name || !b.email) return res.status(400).json({ error: 'Name and email required' });

    const id = uuidv4();
    db.run(`INSERT INTO audit_requests (id,first_name,last_name,age,sex,email,phone,country,city,occupation,work_intensity,fitness_experience,goals,motivation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.first_name, b.last_name||'', b.age||null, b.sex||'', b.email, b.phone||'', b.country||'', b.city||'', b.occupation||'', b.work_intensity||'', b.fitness_experience||'', b.goals||'', b.motivation||'']);
    saveDB();
    res.json({ id, message: 'Request submitted successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/audit', (req, res) => {
  res.json(queryAll("SELECT * FROM audit_requests ORDER BY created_at DESC"));
});

app.get('/api/audit/:id', (req, res) => {
  const row = queryOne("SELECT * FROM audit_requests WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.put('/api/audit/:id', (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.run("UPDATE audit_requests SET status = ? WHERE id = ?", [status, req.params.id]);
  saveDB();
  res.json({ message: 'Updated' });
});

app.delete('/api/audit/:id', (req, res) => {
  db.run("DELETE FROM audit_requests WHERE id = ?", [req.params.id]);
  saveDB();
  res.json({ message: 'Deleted' });
});

// ============ PART-2 BODY AUDIT FORM (Shareable) ============
app.post('/api/part2', rateLimiter(5, 60000), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.email) return res.status(400).json({ error: 'Name and email required' });

    const id = uuidv4();
    db.run(`INSERT INTO part2_audit (id, name, email, mobile, sports_history, injuries, mental_health, gym_experience, food_choices, vices_addictions, goals, what_compelled, activity_level) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name || '', b.email || '', b.mobile || '', b.sports_history || '', b.injuries || '', b.mental_health || '', b.gym_experience || '', b.food_choices || '', b.vices_addictions || '', b.goals || '', b.what_compelled || '', b.activity_level || '']);
    saveDB();
    res.json({ id, message: 'Form submitted successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Submission failed' });
  }
});

app.get('/api/part2', (req, res) => {
  res.json(queryAll("SELECT * FROM part2_audit ORDER BY created_at DESC"));
});

app.get('/api/part2/:id', (req, res) => {
  const row = queryOne("SELECT * FROM part2_audit WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ============ MEETINGS (Schedule a Call) ============
app.post('/api/meetings', rateLimiter(10, 60000), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.user_id || !b.meeting_date || !b.time_slot) {
      return res.status(400).json({ error: 'User, date and time slot required' });
    }

    const id = uuidv4();
    db.run(`INSERT INTO meetings (id, user_id, user_name, user_email, user_phone, meeting_date, time_slot, status, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, b.user_id, b.user_name||'', b.user_email||'', b.user_phone||'', b.meeting_date, b.time_slot, 'scheduled', b.notes||'']);
    saveDB();
    res.json({ id, message: 'Call scheduled successfully' });
  } catch (e) {
    console.error('[meetings] POST error:', e.message);
    res.status(500).json({ error: e.message || 'Failed to schedule call' });
  }
});

app.get('/api/meetings', (req, res) => {
  const rows = queryAll("SELECT * FROM meetings WHERE status='scheduled' ORDER BY meeting_date ASC, time_slot ASC");
  res.json(rows);
});

app.get('/api/meetings/user/:userId', (req, res) => {
  const rows = queryAll("SELECT * FROM meetings WHERE user_id = ? ORDER BY meeting_date DESC, created_at DESC", [req.params.userId]);
  res.json(rows);
});

app.put('/api/meetings/:id', (req, res) => {
  const { meeting_date, time_slot, status } = req.body || {};
  const row = queryOne("SELECT * FROM meetings WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const values = [];
  if (meeting_date !== undefined) { updates.push('meeting_date=?'); values.push(meeting_date); }
  if (time_slot !== undefined) { updates.push('time_slot=?'); values.push(time_slot); }
  if (status !== undefined) { updates.push('status=?'); values.push(status); }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });

  values.push(req.params.id);
  db.run(`UPDATE meetings SET ${updates.join(',')} WHERE id=?`, values);
  saveDB();
  res.json({ message: 'Updated' });
});

// ============ TRIBE MEMBERS ============
app.get('/api/tribe', (req, res) => {
  res.json(queryAll("SELECT * FROM tribe_members WHERE status='active' ORDER BY phase DESC, start_date ASC"));
});

app.get('/api/tribe/:id', (req, res) => {
  const row = queryOne("SELECT * FROM tribe_members WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/tribe', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.first_name) return res.status(400).json({ error: 'Name required' });

    const id = uuidv4();
    db.run(`INSERT INTO tribe_members (id,first_name,last_name,email,phone,city,phase,start_date,activity_per_week,starting_weight,current_weight,target_weight,next_checkin,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.first_name, b.last_name||'', b.email||'', b.phone||'', b.city||'', b.phase||1, b.start_date||new Date().toISOString().split('T')[0], b.activity_per_week||0, b.starting_weight||null, b.current_weight||null, b.target_weight||null, b.next_checkin||'', b.notes||'']);
    saveDB();
    res.json({ id, message: 'Member added' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

app.put('/api/tribe/:id', (req, res) => {
  const allowed = ['first_name','last_name','email','phone','city','phase','activity_per_week','starting_weight','current_weight','target_weight','next_checkin','notes','status'];
  const updates = [], values = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.includes(k)) { updates.push(`${k}=?`); values.push(v); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields' });
  values.push(req.params.id);
  db.run(`UPDATE tribe_members SET ${updates.join(',')} WHERE id=?`, values);
  saveDB();
  res.json({ message: 'Updated' });
});

app.delete('/api/tribe/:id', (req, res) => {
  db.run("DELETE FROM tribe_members WHERE id = ?", [req.params.id]);
  saveDB();
  res.json({ message: 'Deleted' });
});

// ============ USER PROFILE ============
app.get('/api/profile/:id', (req, res) => {
  const user = queryOne("SELECT id,email,first_name,last_name,phone,profile_picture,role,created_at FROM users WHERE id=?", [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.put('/api/profile/:id', (req, res) => {
  const { first_name, last_name, phone, email, profile_picture } = req.body || {};
  const updates = [], values = [];
  if (first_name !== undefined) { updates.push('first_name=?'); values.push(first_name); }
  if (last_name !== undefined) { updates.push('last_name=?'); values.push(last_name); }
  if (phone !== undefined) { updates.push('phone=?'); values.push(phone); }
  if (email !== undefined) {
    const emailNorm = String(email).trim().toLowerCase();
    const other = queryOne("SELECT id FROM users WHERE LOWER(email) = ? AND id != ?", [emailNorm, req.params.id]);
    if (other) return res.status(409).json({ error: 'Email already in use' });
    updates.push('email=?');
    values.push(emailNorm);
  }
  if (profile_picture !== undefined) { updates.push('profile_picture=?'); values.push(profile_picture); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  try {
    db.run(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);
    saveDB();
    res.json({ message: 'Profile updated' });
  } catch (e) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ============ WORKOUT LOGS ============
app.post('/api/workouts', (req, res) => {
  try {
    const { user_id, workout_name, duration_seconds, feedback } = req.body || {};
    if (!user_id || !workout_name) return res.status(400).json({ error: 'User and workout name required' });
    const id = uuidv4();
    db.run("INSERT INTO workout_logs (id,user_id,workout_name,duration_seconds,feedback) VALUES (?,?,?,?,?)",
      [id, user_id, workout_name, duration_seconds || 0, feedback || '']);
    saveDB();
    res.json({ id, message: 'Workout logged' });
  } catch (e) {
    console.error('Workout error:', e.message);
    res.status(500).json({ error: 'Failed to log workout' });
  }
});

// Admin: get all workouts (must be before :userId to avoid conflict)
app.get('/api/workouts', (req, res) => {
  res.json(queryAll(`SELECT w.*, u.first_name, u.last_name, u.email 
    FROM workout_logs w JOIN users u ON w.user_id = u.id 
    ORDER BY w.created_at DESC LIMIT 100`));
});

app.get('/api/workouts/:userId', (req, res) => {
  res.json(queryAll("SELECT * FROM workout_logs WHERE user_id=? ORDER BY created_at DESC", [req.params.userId]));
});

// ============ CONTACT MESSAGES ============
app.post('/api/contact', rateLimiter(5, 60000), (req, res) => {
  try {
    const { user_id, name, phone, email, message } = req.body || {};
    if (!name || !message) return res.status(400).json({ error: 'Name and message required' });
    const id = uuidv4();
    db.run("INSERT INTO contact_messages (id,user_id,name,phone,email,message) VALUES (?,?,?,?,?,?)",
      [id, user_id || null, name, phone || '', email || '', message]);
    saveDB();
    res.json({ id, message: 'Message sent' });
  } catch (e) {
    console.error('Contact error:', e.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/api/contact', (req, res) => {
  res.json(queryAll("SELECT * FROM contact_messages ORDER BY created_at DESC"));
});

// ============ NOTIFICATIONS (Admin) ============
app.get('/api/notifications', (req, res) => {
  try {
    const notifications = [];
    const pending = queryAll("SELECT id, first_name, last_name, email, created_at FROM audit_requests WHERE status='pending' ORDER BY created_at DESC LIMIT 10");
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
    const messages = queryAll("SELECT id, name, email, message, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 10");
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
    const tribe = queryAll("SELECT id, first_name, last_name, created_at FROM tribe_members WHERE status='active' ORDER BY created_at DESC LIMIT 5");
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
    const workouts = queryAll("SELECT w.id, w.workout_name, w.duration_seconds, w.created_at, u.first_name, u.last_name FROM workout_logs w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC LIMIT 5");
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
    const signups = queryAll("SELECT id, email, first_name, last_name, created_at FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 5");
    signups.forEach(u => {
      notifications.push({
        id: 'user-' + u.id,
        type: 'user',
        title: 'New User Signup',
        desc: `${u.first_name || ''} ${u.last_name || ''} (${u.email})`,
        time: u.created_at,
        link: 'tribe'
      });
    });
    const part2Subs = queryAll("SELECT id, name, email, created_at FROM part2_audit ORDER BY created_at DESC LIMIT 5");
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
    const meetReqs = queryAll("SELECT id, user_name, user_email, meeting_date, time_slot, created_at FROM meetings WHERE status='scheduled' ORDER BY created_at DESC LIMIT 5");
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
app.get('/api/stats', (req, res) => {
  const pending = queryAll("SELECT COUNT(*) as c FROM audit_requests WHERE status='pending'");
  const active = queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='active'");
  const completed = queryAll("SELECT COUNT(*) as c FROM tribe_members WHERE status='completed'");
  const total = queryAll("SELECT COUNT(*) as c FROM tribe_members");

  res.json({
    pending_requests: pending[0]?.c || 0,
    active_members: active[0]?.c || 0,
    completed: completed[0]?.c || 0,
    total_members: total[0]?.c || 0,
    success_rate: 92
  });
});

// ============ SERVE FRONTEND ============
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '7d' : 0
}));
app.use((req, res) => {
  if (req.method === 'GET') {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
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
