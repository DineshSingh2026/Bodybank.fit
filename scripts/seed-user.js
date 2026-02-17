#!/usr/bin/env node
/**
 * One-time script to add/update a user for testing.
 * Run: node scripts/seed-user.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const initSqlJs = require('sql.js');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bodybank.db');
const EMAIL = 'dineshkishoresingh@gmail.com';
const PASSWORD = 'Password@123';

async function main() {
  const SQL = await initSqlJs();
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  let db;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
    db.run(`CREATE TABLE users (
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
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const stmt = db.prepare("SELECT id FROM users WHERE LOWER(email) = ?");
  stmt.bind([EMAIL.toLowerCase()]);
  let existing = null;
  if (stmt.step()) existing = stmt.getAsObject();
  stmt.free();

  if (existing && existing.id) {
    db.run("UPDATE users SET password = ? WHERE LOWER(email) = ?", [hash, EMAIL.toLowerCase()]);
    console.log('✅ Updated password for', EMAIL);
  } else {
    const id = uuidv4();
    db.run("INSERT OR REPLACE INTO users (id, email, password, first_name, last_name, role) VALUES (?, ?, ?, ?, ?, ?)",
      [id, EMAIL, hash, 'Dinesh', 'Singh', 'user']);
    console.log('✅ Created user:', EMAIL);
  }

  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  db.close();
  console.log('Done. You can now login with:', EMAIL, '/', PASSWORD);
}

main().catch(e => { console.error(e); process.exit(1); });
