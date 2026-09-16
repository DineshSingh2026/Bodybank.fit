/**
 * Seed a demo care group for local testing of the in-app group messaging.
 *
 *   node scripts/seed-care-group-demo.js          create / refresh the demo
 *   node scripts/seed-care-group-demo.js --clean  remove everything it created
 *
 * Creates five accounts under the @caredemo.local domain and one populated
 * group, so the feature can be exercised from every role without touching any
 * real account or client record. Everything it writes is addressable by that
 * email domain, which is what --clean deletes.
 *
 * Local development only — never run this against production data.
 */
'use strict';

require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const DOMAIN = '@caredemo.local';
const PASSWORD = process.env.CARE_DEMO_PASS || 'Demo1234!';

/**
 * Hard stop in production.
 *
 * This script creates five working logins with a documented password. That is
 * fine on a laptop and a account-takeover vector on a live service, so it
 * refuses to run there. `--clean` is always allowed: removing the demo must
 * never be blocked, including if it somehow reached a real environment.
 */
function refuseInProduction() {
  if (process.argv.includes('--clean')) return;
  const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
  const url = String(process.env.DATABASE_URL || '');
  const looksRemote = /render\.com|amazonaws|neon\.tech|supabase|railway|\.rds\./i.test(url);
  const localish = /localhost|127\.0\.0\.1|::1/i.test(url);
  if ((env === 'production' || (looksRemote && !localish)) && !process.argv.includes('--i-really-mean-it')) {
    console.error(
      'Refusing to seed demo accounts: this looks like a production database.\n' +
      'These accounts have a published password and would be a live login.\n' +
      'Local development only. (--clean always works.)'
    );
    process.exit(1);
  }
}

const PEOPLE = [
  { key: 'admin',  email: 'admin' + DOMAIN,  role: 'admin',    first: 'Ava',   last: 'Admin',     groupRole: null },
  { key: 'client', email: 'client' + DOMAIN, role: 'user',     first: 'Mitul', last: 'Nadendla',  groupRole: 'client' },
  { key: 'doctor', email: 'doctor' + DOMAIN, role: 'operator', first: 'Dr',    last: 'Sharma',    groupRole: 'doctor' },
  { key: 'lm',     email: 'coach' + DOMAIN,  role: 'operator', first: 'Priya', last: 'Singh',     groupRole: 'lifestyle_manager' },
  { key: 'op',     email: 'ops' + DOMAIN,    role: 'operator', first: 'Rohit', last: 'Mehta',     groupRole: 'operator' }
];

const SCRIPT = [
  ['lm',     'Morning Mitul — week 6 plan is up. Three lifting days, two Zone 2 walks.'],
  ['client', 'Got it. Knee was sore after Tuesday\'s squats, is that expected?'],
  ['doctor', 'Some soreness is normal at this load. Any swelling or clicking?', 1],
  ['client', 'No swelling. Just stiff first thing in the morning.'],
  ['doctor', 'That reads as normal adaptation. Keep the load, add 5 min of mobility before you lift.'],
  ['op',     'Logged — I have flagged the knee note on his chart so it shows in next week\'s review.'],
  ['lm',     'Great progress today! Down 1.2kg and your step count is the best it has been.'],
  ['client', 'Thanks team 🙏'],
  ['doctor', 'One more thing — bring the latest bloodwork to Friday\'s call.'],
  ['lm',     'And your Sunday check-in is open now.']
];

const REACTIONS = [
  { on: 6, by: 'client', emoji: '❤️' },
  { on: 6, by: 'doctor', emoji: '👍' },
  { on: 4, by: 'client', emoji: '🙏' },
  { on: 0, by: 'op',     emoji: '👍' }
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql, params) => pool.query(sql, params);

async function clean() {
  // chat_groups cascades to members / messages / reactions / attachments.
  await q("DELETE FROM chat_groups WHERE client_id IN (SELECT id FROM users WHERE email LIKE $1)", ['%' + DOMAIN]);
  await q("DELETE FROM chat_group_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", ['%' + DOMAIN]);
  // message_threads / thread_messages predate foreign keys — deleting the user
  // would otherwise strand the thread, which then shows up in the admin inbox
  // as a nameless "Client" row forever.
  await q(
    `DELETE FROM thread_messages WHERE thread_id IN (
       SELECT t.id FROM message_threads t
       JOIN users u ON u.id = t.user_id WHERE u.email LIKE $1)`,
    ['%' + DOMAIN]
  );
  await q("DELETE FROM message_threads WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", ['%' + DOMAIN]);
  const r = await q("DELETE FROM users WHERE email LIKE $1", ['%' + DOMAIN]);
  console.log(`Removed the demo: ${r.rowCount} account(s), their care group and direct thread.`);
}

async function main() {
  refuseInProduction();
  if (process.argv.includes('--clean')) { await clean(); return; }

  await clean(); // idempotent: re-running gives a fresh, identical demo
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const ids = {};

  for (const p of PEOPLE) {
    ids[p.key] = uuid();
    await q(
      `INSERT INTO users (id, email, password, first_name, last_name, role,
                          approval_status, subscription_status, suspended,
                          height_cm, onboarded_at, guide_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,'approved','active',FALSE,178,NOW(),NOW())`,
      [ids[p.key], p.email, hash, p.first, p.last, p.role]
    );
  }

  const groupId = uuid();
  await q(
    `INSERT INTO chat_groups (id, name, client_id, created_by) VALUES ($1,$2,$3,$4)`,
    [groupId, 'Mitul Nadendla - 2.0', ids.client, ids.admin]
  );
  for (const p of PEOPLE.filter(x => x.groupRole)) {
    await q(
      `INSERT INTO chat_group_members (id, group_id, user_id, group_role) VALUES ($1,$2,$3,$4)`,
      [uuid(), groupId, ids[p.key], p.groupRole]
    );
  }

  await q(
    `INSERT INTO chat_messages (id, group_id, sender_id, sender_group_role, kind, body)
     VALUES ($1,$2,NULL,'','system','Ava Admin created this care group')`,
    [uuid(), groupId]
  );

  const msgIds = [];
  for (const [who, body, replyIdx] of SCRIPT) {
    const id = uuid();
    const role = PEOPLE.find(p => p.key === who).groupRole;
    await q(
      `INSERT INTO chat_messages (id, group_id, sender_id, sender_group_role, kind, body, reply_to_id)
       VALUES ($1,$2,$3,$4,'text',$5,$6)`,
      [id, groupId, ids[who], role, body, replyIdx == null ? null : msgIds[replyIdx]]
    );
    msgIds.push(id);
  }
  for (const r of REACTIONS) {
    await q(
      `INSERT INTO chat_message_reactions (id, message_id, group_id, user_id, emoji)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuid(), msgIds[r.on], groupId, ids[r.by], r.emoji]
    );
  }
  await q('UPDATE chat_groups SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1', [groupId]);

  // Care team is caught up; the client is two behind, so the unread badge and
  // the read-receipt ticks both have something to show on first load.
  const { rows } = await q('SELECT MAX(seq) AS s FROM chat_messages WHERE group_id = $1', [groupId]);
  const maxSeq = rows[0].s;
  for (const k of ['doctor', 'lm', 'op']) {
    await q('UPDATE chat_group_members SET last_read_seq = $1 WHERE group_id = $2 AND user_id = $3',
      [maxSeq, groupId, ids[k]]);
  }
  await q('UPDATE chat_group_members SET last_read_seq = $1 WHERE group_id = $2 AND user_id = $3',
    [Number(maxSeq) - 2, groupId, ids.client]);

  console.log('Demo care group ready: "Mitul Nadendla - 2.0"\n');
  console.log('  Sign in with any of these — password: ' + PASSWORD + '\n');
  for (const p of PEOPLE) {
    const label = p.groupRole
      ? p.groupRole.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : 'Admin (creates groups)';
    console.log('   ' + p.email.padEnd(24) + label);
  }
  console.log('\n  Remove it again with: node scripts/seed-care-group-demo.js --clean');
}

main()
  .then(() => pool.end())
  .catch(e => { console.error('Seed failed:', e.message); pool.end(); process.exit(1); });
