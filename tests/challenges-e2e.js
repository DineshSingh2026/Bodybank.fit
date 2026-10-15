/**
 * End-to-end browser test: BodyBank Challenges, against a RUNNING server.
 * Run:  BASE_URL=http://localhost:3000 npm run test:challenges-e2e
 *
 * Needs: the server started with CHALLENGES_ENABLED=all, a published free
 * challenge (Admin → Challenges → Publish, or `node scripts/challenges-seed.js
 * --publish starter-7` locally), and the same DATABASE_URL as the server.
 * Uses puppeteer (already a dependency) with the system Chrome when present.
 *
 * Creates one throwaway member (signs in through the real /api/auth/login) and
 * deletes everything it created. Writes the test check-in straight to the DB so no
 * check-in email or staff alert is sent.
 *
 * Covers, on iPhone 13 (390×844), Pixel 7 (412×915) and desktop (1366×900):
 *  - /challenge for a visitor: CTA, JSON-LD, Start → /signup?next=…;
 *  - /challenge?join=1 for a member → joined → /?open=challenge → day view;
 *  - a same-day check-in ticks the task after a refresh;
 *  - back navigation (leaderboard → back → day view);
 *  - offline join: queued in localStorage, finished when back online;
 *  - basic a11y: every button has a name, focus moves to the new screen,
 *    no horizontal overflow at phone widths.
 */
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql, p) => pool.query(sql, p || []);

const failures = [];
let checks = 0;
function assert(ok, msg) { checks += 1; if (!ok) failures.push(msg); console.log((ok ? '  ok   ' : '  FAIL ') + msg); return ok; }

const TAG = 'zzche2e' + crypto.randomBytes(3).toString('hex');
const USER = { id: TAG, email: TAG + '@test.bodybank.fit', password: 'E2e-' + crypto.randomBytes(6).toString('hex') };
const DEVICES = [
  { name: 'iPhone 13', viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  { name: 'Pixel 7', viewport: { width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true } },
  { name: 'Desktop', viewport: { width: 1366, height: 900, deviceScaleFactor: 1 } }
];

async function cleanup() {
  const id = USER.id;
  for (const t of ['challenge_discount_orders', 'challenge_discounts', 'challenge_lm_requests', 'challenge_rewards', 'challenge_push_log', 'challenge_task_completions']) await q(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  await q('DELETE FROM challenge_audit WHERE enrollment_id IN (SELECT id FROM challenge_enrollments WHERE user_id = $1)', [id]).catch(() => {});
  await q('DELETE FROM challenge_enrollments WHERE user_id = $1', [id]).catch(() => {});
  for (const t of ['daily_checkins', 'coin_ledger', 'coin_wallet', 'user_inbox', 'referral_codes']) await q(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  await q('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

async function api(method, path, token, body) {
  const r = await fetch(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function a11y(page, label) {
  const r = await page.evaluate(() => {
    const unnamed = Array.from(document.querySelectorAll('.bbch button, .bbch-home button')).filter((b) => b.offsetParent !== null && !(b.getAttribute('aria-label') || b.textContent.trim())).length;
    const vw = document.documentElement.clientWidth;
    const wide = Array.from(document.querySelectorAll('.bbch *')).filter((el) => el.getBoundingClientRect().right > vw + 1).length;
    return { unnamed, wide };
  });
  assert(r.unnamed === 0, `${label}: every visible button has a name`);
  assert(r.wide === 0, `${label}: no horizontal overflow`);
}

async function main() {
  const pub = await api('GET', '/api/challenges/public');
  if (pub.status !== 200) { console.log(`SKIP: ${BASE}/api/challenges/public answered ${pub.status}. Start the server with CHALLENGES_ENABLED=all.`); await pool.end(); return; }
  const free = (pub.data.challenges || []).find((c) => c.access === 'free');
  if (!free) { console.log('SKIP: no published free challenge. Publish starter-7 first.'); await pool.end(); return; }

  await cleanup();
  await q(`INSERT INTO users (id, email, password, first_name, last_name, role, timezone, plan_tier, approval_status, subscription_status, access_expires_at, onboarded_at, guide_seen_at, created_at)
           VALUES ($1,$2,$3,'Eetu','Tester','user','Asia/Kolkata','core','approved','active', NOW() + interval '30 days', NOW(), NOW(), NOW() - interval '3 days')`,
  [USER.id, USER.email, bcrypt.hashSync(USER.password, 8)]);
  const login = await api('POST', '/api/auth/login', null, { email: USER.email, password: USER.password });
  if (!assert(login.status === 200 && login.data && login.data.token, 'member signs in through /api/auth/login')) throw new Error('login failed: ' + JSON.stringify(login.data));
  const session = login.data;

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    for (const dev of DEVICES) {
      console.log(`\n— ${dev.name}`);
      await cleanupEnrollment();
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewport(dev.viewport);

      // Visitor landing page.
      await page.goto(BASE + '/signin.html', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASE + '/challenge?utm_source=e2e', { waitUntil: 'networkidle2' });
      assert(await page.$eval('h1', (h) => /7 day/i.test(h.textContent)), `${dev.name}: landing headline`);
      const ld = await page.$eval('script[type="application/ld+json"]', (s) => JSON.parse(s.textContent)['@graph'].map((x) => x['@type']).join(','));
      assert(ld === 'Organization,Course,FAQPage', `${dev.name}: JSON-LD parses (${ld})`);
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#start')]);
      assert(/\/signup\?next=%2Fchallenge%3Fjoin%3D1/.test(page.url()), `${dev.name}: Start free today → sign up with next`);

      // Member: auto join from the landing page.
      await page.evaluate((s) => {
        localStorage.setItem('bodybank_session', JSON.stringify(s));
        localStorage.setItem('bb_today_pop_last_shown', String(Date.now()));
        localStorage.setItem('bb_notify_card_dismissed_at', String(Date.now()));
      }, session);
      await page.goto(BASE + '/challenge?join=1', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => location.pathname === '/' || location.pathname === '/index.html', { timeout: 20000 });
      await page.waitForSelector('.bbch .bbch-today', { timeout: 25000 });
      assert(true, `${dev.name}: joined and landed on the day view`);
      const en = await q("SELECT id, source, utm FROM challenge_enrollments WHERE user_id = $1 AND status = 'active'", [USER.id]);
      assert(en.rows.length === 1, `${dev.name}: exactly one active enrollment`);
      assert(en.rows[0] && en.rows[0].source === 'web_landing' && en.rows[0].utm && en.rows[0].utm.utm_source === 'e2e', `${dev.name}: source + UTM stored`);
      assert(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('bbch-screen')), `${dev.name}: focus moved to the screen`);
      const ciBefore = await page.$eval('.bbch-task', (li) => li.classList.contains('is-done'));
      assert(!ciBefore, `${dev.name}: check-in task starts open`);
      await a11y(page, `${dev.name} day view`);

      // A same-day check-in (written directly: no emails) ticks the task.
      await q(`INSERT INTO daily_checkins (id, user_id, checkin_date, steps, water_ml, protein_g, sleep_hours)
               VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 9000, 3000, 40, 7) ON CONFLICT DO NOTHING`, [crypto.randomUUID(), USER.id]);
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => { const li = document.querySelector('.bbch-task'); return li && li.classList.contains('is-done'); }, { timeout: 15000 });
      assert(true, `${dev.name}: check-in task ticks after the member checks in`);

      // Back navigation.
      await page.evaluate(() => document.querySelector('[data-a="board"]').click());
      await page.waitForSelector('.bbch-board', { timeout: 15000 });
      await page.goBack();
      await page.waitForSelector('.bbch .bbch-today', { timeout: 15000 });
      assert(true, `${dev.name}: back from the leaderboard returns to the day view`);

      // Offline join queue.
      await api('POST', '/api/challenges/me/active/leave', session.token);
      await q("UPDATE challenge_enrollments SET created_at = NOW() - interval '200 days' WHERE user_id = $1", [USER.id]); // lift the 90-day repeat rule for the test
      await page.goto(BASE + '/?open=challenge&id=' + free.id, { waitUntil: 'networkidle2' });
      await page.waitForSelector('[data-a="join"]', { timeout: 20000 });
      await page.setOfflineMode(true);
      await page.evaluate(() => document.querySelector('[data-a="join"]').click());
      await page.waitForFunction(() => /offline/i.test((document.querySelector('.bbch-err') || {}).textContent || ''), { timeout: 15000 });
      const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('bb_ch_outbox_v1') || '[]').length);
      assert(queued === 1, `${dev.name}: offline join queued`);
      await page.setOfflineMode(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      let joined = false;
      for (let i = 0; i < 30 && !joined; i++) {
        const r = await q("SELECT 1 FROM challenge_enrollments WHERE user_id = $1 AND status = 'active'", [USER.id]);
        joined = r.rows.length === 1;
        if (!joined) await new Promise((res) => setTimeout(res, 500));
      }
      assert(joined, `${dev.name}: queued join completes when back online`);
      assert(await page.evaluate(() => JSON.parse(localStorage.getItem('bb_ch_outbox_v1') || '[]').length === 0), `${dev.name}: outbox emptied`);
      assert(errors.filter((e) => /challenge|bbch/i.test(e)).length === 0, `${dev.name}: no page errors from Challenges${errors.length ? ' (' + errors.join(' | ') + ')' : ''}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function cleanupEnrollment() {
  for (const t of ['challenge_rewards', 'challenge_push_log', 'challenge_task_completions', 'challenge_discounts']) await q(`DELETE FROM ${t} WHERE user_id = $1`, [USER.id]).catch(() => {});
  await q('DELETE FROM challenge_audit WHERE enrollment_id IN (SELECT id FROM challenge_enrollments WHERE user_id = $1)', [USER.id]).catch(() => {});
  await q('DELETE FROM challenge_enrollments WHERE user_id = $1', [USER.id]);
  await q('DELETE FROM daily_checkins WHERE user_id = $1', [USER.id]);
}

main()
  .catch((e) => { failures.push('crashed: ' + (e && e.message)); console.error(e); })
  .finally(async () => {
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    if (failures.length) {
      console.error(`\nchallenges-e2e: ${failures.length} of ${checks} checks FAILED`);
      failures.forEach((f) => console.error('  ✗ ' + f));
      process.exit(1);
    }
    if (checks) console.log(`\nchallenges-e2e: ${checks} passed, 0 failed`);
  });
