'use strict';

/**
 * BodyBank Challenges API — mounted at /api/challenges (see services/challengeService.js
 * for the rules and services/challengeEngine.js for the DB side).
 *
 * Public (no auth; only when CHALLENGES_ENABLED=all; cached 5 min):
 *   GET  /public                          published challenges + rounded participant counts
 *   GET  /share/:token.png?format=story|square   share card image
 *   GET  /certificate/:token.pdf          certificate via a 10-minute signed link
 *
 * Member (verifyToken; 404 when the flag is off for the caller):
 *   GET  /flags                           { enabled } — always answers
 *   GET  /                                list + my status per challenge
 *   GET  /me/active?day=n                 day view (tasks, live progress, days strip)
 *   POST /me/active/leave
 *   PUT  /me/leaderboard                  { opt_out?, share_results? }
 *   GET  /me/rewards                      badges, certificates, discounts, call offers
 *   GET  /me/history                      past enrollments
 *   GET  /me/results/:enrollmentId        completion screen data
 *   GET  /me/certificate/:enrollmentId    { url } signed PDF link (works in the apps)
 *   POST /me/lm-call                      { enrollment_id, preferred_slot, phone? } (one per enrollment)
 *   GET  /:id                             detail (days, rewards, my status)
 *   POST /:id/join                        { client_uuid, utm?, referral_code?, source?, leaderboard_opt_out? }
 *   GET  /:id/leaderboard?limit=50
 *
 * Staff (admin / superadmin; not flag-gated so a challenge can be built and
 * reviewed before rollout): /admin/* — CRUD, publish/archive, tasks, enrollments,
 * void, manual task ticks, staff enrol, stats, LM call queue, CSV export.
 *
 * The member id always comes from the token. Apps never see a price: discounts are
 * applied server side on the web checkout only (services/payments.js).
 */

const express = require('express');
const crypto = require('crypto');
const C = require('../services/challengeService');
const { renderCertificate } = require('../services/challengeCertificate');
const shareCard = require('../services/challengeShareCard');

function createChallengesRouter(deps) {
  const {
    verifyToken, requireAdminOrSuperadmin, rateLimiter,
    queryAll, queryOne, run,
    engine, plans,
    signPdfAccessToken, verifyPdfAccessToken,
    env
  } = deps;
  const router = express.Router();
  const flagCfg = () => C.flagConfig(env || process.env);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
  const limit = typeof rateLimiter === 'function' ? rateLimiter : () => (req, res, next) => next();

  function fail(res, where, e) {
    console.error('[challenges]', where, e && e.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  function memberGate(req, res, next) {
    if (!C.isEnabledFor(req.user, flagCfg())) return res.status(404).json({ error: 'Not found' });
    return next();
  }
  function memberOnly(req, res, next) {
    if (!req.user || req.user.role !== C.MEMBER_ROLE) return res.status(403).json({ error: 'members_only', message: 'Challenges are for member accounts.' });
    return next();
  }
  function publicGate(req, res, next) {
    if (!C.isPublicEnabled(flagCfg())) return res.status(404).json({ error: 'Not found' });
    return next();
  }
  const member = [verifyToken, memberGate];
  const memberW = [verifyToken, memberGate, memberOnly];

  async function participantCounts() {
    const rows = await queryAll(
      `SELECT e.challenge_id, COUNT(*)::int AS n FROM challenge_enrollments e JOIN users u ON u.id = e.user_id
        WHERE e.status <> 'void' AND u.role = 'user' GROUP BY e.challenge_id`);
    const out = {};
    rows.forEach((r) => { out[r.challenge_id] = r.n; });
    return out;
  }
  async function monthlyJoins() {
    const r = await queryOne(
      `SELECT COUNT(*)::int AS n FROM challenge_enrollments e JOIN users u ON u.id = e.user_id
        WHERE e.status <> 'void' AND u.role = 'user' AND e.created_at > NOW() - INTERVAL '30 days'`);
    return r ? r.n : 0;
  }
  // Members who finished any challenge (staff and automated test accounts excluded).
  async function finishedMembers() {
    const r = await queryOne(
      `SELECT COUNT(DISTINCT e.user_id)::int AS n FROM challenge_enrollments e JOIN users u ON u.id = e.user_id
        WHERE e.status = 'completed' AND u.role = 'user' AND COALESCE(u.email, '') NOT ILIKE '%@test.bodybank.fit'`);
    return r ? r.n : 0;
  }
  async function publishedList() {
    const rows = await queryAll("SELECT * FROM challenges WHERE status = 'published' ORDER BY sort_order, created_at");
    return rows.map((r) => Object.assign({}, r, { rewards: typeof r.rewards === 'string' ? JSON.parse(r.rewards) : r.rewards }));
  }

  /* ------------------------------------------------------------ public */

  let publicCache = { at: 0, body: null };
  router.get('/public', publicGate, limit(60, 60000), async (req, res) => {
    try {
      if (!publicCache.body || Date.now() - publicCache.at > 5 * 60 * 1000) {
        const counts = await participantCounts();
        const list = (await publishedList()).map((r) => {
          const p = C.publicChallenge(r);
          p.joined = C.publicCount(counts[r.id]);
          return p;
        });
        publicCache = { at: Date.now(), body: { challenges: list, joined_this_month: C.publicCount(await monthlyJoins()), finished: C.proofCount(await finishedMembers(), env || process.env) } };
      }
      res.set('Cache-Control', 'public, max-age=300');
      res.json(publicCache.body);
    } catch (e) { return fail(res, 'public', e); }
  });

  async function shareData(token) {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(String(token || ''))) return null;
    const e = await queryOne(
      `SELECT e.id, e.status, e.days_done, e.share_results, e.display_name, e.start_date::text AS start_date, c.title, c.length_days, c.id AS challenge_id
         FROM challenge_enrollments e JOIN challenges c ON c.id = e.challenge_id WHERE e.share_token = ?`, [token]);
    if (!e || e.status === 'void') return null;
    return e;
  }

  router.get('/share/:file', publicGate, limit(60, 60000), async (req, res) => {
    try {
      const token = String(req.params.file || '').replace(/\.(png|svg)$/i, '');
      const e = await shareData(token);
      if (!e) return res.status(404).send('Not found');
      const r = await engine.results(e.id);
      const done = e.status === 'completed';
      const card = await shareCard.render({
        name: e.display_name || 'BodyBank member',
        challenge: e.title,
        day: done ? e.length_days : Math.max(1, Number(e.days_done) || 1),
        length: e.length_days,
        done: true,
        include_results: !!e.share_results,
        stats: { checkins: r.stats.checkins, workouts: r.stats.workouts, protein_days: r.stats.protein_days },
        url: 'bodybank.fit/challenge'
      }, req.query.format === 'square' ? 'square' : 'story');
      res.set('Content-Type', card.type);
      res.set('Cache-Control', 'public, max-age=600');
      res.send(card.body);
    } catch (e) { return fail(res, 'share', e); }
  });

  // Open Graph image for the /challenge landing page (no member data).
  router.get('/og.png', publicGate, limit(60, 60000), async (req, res) => {
    try {
      const card = await shareCard.render({ challenge: 'Free 7 Day Challenge', day: 7, done: true, url: 'bodybank.fit/challenge' }, req.query.format === 'story' ? 'story' : 'square');
      res.set('Content-Type', card.type);
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(card.body);
    } catch (e) { return fail(res, 'og', e); }
  });

  // Signed, 10-minute certificate link (the apps open it in the system viewer).
  router.get('/certificate/:file', limit(30, 60000), async (req, res) => {
    try {
      const token = String(req.params.file || '').replace(/\.pdf$/i, '');
      const v = typeof verifyPdfAccessToken === 'function' ? verifyPdfAccessToken(token) : null;
      if (!v || !String(v.programId).startsWith('challenge-cert:')) return res.status(403).send('This link has expired. Open the certificate again from the app.');
      return sendCertificate(res, String(v.programId).slice('challenge-cert:'.length), String(v.userId));
    } catch (e) { return fail(res, 'certificate:link', e); }
  });

  async function sendCertificate(res, enrollmentId, userId) {
    const e = await queryOne('SELECT id, user_id, status, share_token FROM challenge_enrollments WHERE id = ? AND user_id = ?', [enrollmentId, userId]);
    if (!e) return res.status(404).json({ error: 'Not found' });
    const cert = await queryOne("SELECT 1 AS ok FROM challenge_rewards WHERE enrollment_id = ? AND kind = 'certificate'", [e.id]);
    if (e.status !== 'completed' || !cert) return res.status(409).json({ error: 'not_ready', message: 'Your certificate unlocks when you finish the challenge.' });
    const r = await engine.results(e.id);
    const pdf = await renderCertificate({
      name: r.name,
      challenge: r.challenge.title,
      length: r.length,
      days_done: r.days_done,
      start_date: r.start_date,
      end_date: r.end_date,
      coach: 'Coach Kling',
      stats: r.stats,
      verify_url: `${engine.origin()}/c/${e.share_token}`
    });
    const fname = `BodyBank-${String(r.challenge.title).replace(/[^A-Za-z0-9]+/g, '-')}-certificate.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${fname}"`);
    res.set('Cache-Control', 'private, no-store');
    return res.send(pdf);
  }

  /* ------------------------------------------------------------ member */

  router.get('/flags', verifyToken, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: C.isEnabledFor(req.user, flagCfg()) });
  });

  async function myUser(id) {
    return queryOne('SELECT id, role, email, first_name, last_name, plan_tier, subscription_status, access_expires_at, created_at FROM users WHERE id = ?', [id]);
  }

  router.get('/', ...member, async (req, res) => {
    try {
      const u = await myUser(req.user.id);
      const counts = await participantCounts();
      const mine = await queryAll(
        `SELECT id, challenge_id, status, days_done, created_at, completed_at FROM challenge_enrollments
          WHERE user_id = ? AND status <> 'void' ORDER BY created_at DESC`, [req.user.id]);
      const active = mine.find((m) => m.status === 'active') || null;
      const list = (await publishedList()).map((r) => {
        const p = C.publicChallenge(r, counts);
        const acc = engine.accessFor(u, r);
        const last = mine.find((m) => m.challenge_id === r.id) || null;
        p.my = {
          status: last ? last.status : null,
          enrollment_id: last ? last.id : null,
          days_done: last ? Number(last.days_done) || 0 : 0,
          locked: !acc.ok,
          locked_message: acc.ok ? '' : (acc.message || '')
        };
        return p;
      });
      res.set('Cache-Control', 'no-store');
      res.json({ challenges: list, active: active ? { enrollment_id: active.id, challenge_id: active.challenge_id } : null });
    } catch (e) { return fail(res, 'list', e); }
  });

  router.get('/me/active', ...memberW, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const a = await queryOne("SELECT id FROM challenge_enrollments WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", [req.user.id]);
      if (a) {
        const v = await engine.dayView(a.id, { day: req.query.day });
        return res.json({ active: v });
      }
      // No active run: hand back the latest finished one (certificate / restart screen).
      const last = await queryOne(
        `SELECT id, status FROM challenge_enrollments WHERE user_id = ? AND status IN ('completed','failed')
           AND COALESCE(ended_at, created_at) > NOW() - INTERVAL '30 days' ORDER BY COALESCE(ended_at, created_at) DESC LIMIT 1`, [req.user.id]);
      return res.json({ active: null, last: last ? await engine.dayView(last.id, { day: req.query.day }) : null });
    } catch (e) { return fail(res, 'me:active', e); }
  });

  router.post('/me/active/leave', ...memberW, limit(10, 60000), async (req, res) => {
    try {
      const r = await engine.leave(String(req.user.id));
      if (!r) return res.status(404).json({ error: 'No active challenge' });
      res.json({ left: true, enrollment_id: r.id });
    } catch (e) { return fail(res, 'me:leave', e); }
  });

  router.put('/me/leaderboard', ...memberW, limit(20, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [];
      const vals = [];
      if (Object.prototype.hasOwnProperty.call(b, 'opt_out')) { sets.push('leaderboard_opt_out = ?'); vals.push(!!b.opt_out); }
      if (Object.prototype.hasOwnProperty.call(b, 'share_results')) { sets.push('share_results = ?'); vals.push(!!b.share_results); }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to change', errors: { opt_out: 'boolean' } });
      // Applies to the member's current and future-visible runs (active + completed).
      const r = await run(`UPDATE challenge_enrollments SET ${sets.join(', ')} WHERE user_id = ? AND status IN ('active','completed')`, [...vals, req.user.id]);
      res.json({ updated: r ? r.rowCount : 0, opt_out: b.opt_out, share_results: b.share_results });
    } catch (e) { return fail(res, 'me:leaderboard', e); }
  });

  router.get('/me/rewards', ...memberW, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const r = await engine.rewardsOf(String(req.user.id));
      // Apps never show a price or a pay link: the discount is a fact, not an offer.
      r.discounts = r.discounts.map((d) => ({ pct: d.pct, usable: d.usable, used: d.used, expires_at: d.expires_at, enrollment_id: d.enrollment_id }));
      res.json(r);
    } catch (e) { return fail(res, 'me:rewards', e); }
  });

  router.get('/me/history', ...memberW, async (req, res) => {
    try {
      const rows = await queryAll(
        `SELECT e.id, e.challenge_id, c.title, c.length_days, e.status, e.days_done, e.points, e.start_date::text AS start_date, e.completed_at
           FROM challenge_enrollments e JOIN challenges c ON c.id = e.challenge_id
          WHERE e.user_id = ? AND e.status <> 'void' ORDER BY e.created_at DESC LIMIT 50`, [req.user.id]);
      res.json({ history: rows });
    } catch (e) { return fail(res, 'me:history', e); }
  });

  router.get('/me/results/:enrollmentId', ...memberW, async (req, res) => {
    try {
      const e = await queryOne('SELECT id, user_id, status, share_token, share_results FROM challenge_enrollments WHERE id = ? AND user_id = ?', [String(req.params.enrollmentId), req.user.id]);
      if (!e) return res.status(404).json({ error: 'Not found' });
      const r = await engine.results(e.id);
      const rw = await queryAll('SELECT kind, payload FROM challenge_rewards WHERE enrollment_id = ?', [e.id]);
      const disc = await queryOne('SELECT pct, expires_at, used_at FROM challenge_discounts WHERE enrollment_id = ?', [e.id]);
      const lm = await queryOne('SELECT status, preferred_slot FROM challenge_lm_requests WHERE enrollment_id = ?', [e.id]);
      res.set('Cache-Control', 'no-store');
      res.json({
        enrollment_id: e.id,
        status: e.status,
        challenge: { id: r.challenge.id, title: r.challenge.title, length_days: r.length },
        name: r.name,
        display_name: r.display_name,
        start_date: r.start_date,
        end_date: r.end_date,
        days_done: r.days_done,
        points: r.points,
        stats: r.stats,
        coach: 'Coach Kling',
        rewards: rw.map((x) => x.kind),
        discount: disc ? { pct: disc.pct, expires_at: disc.expires_at, used: !!disc.used_at } : null,
        lm_call: rw.some((x) => x.kind === 'lm_call') ? (lm ? { requested: true, status: lm.status, preferred_slot: lm.preferred_slot } : { requested: false }) : null,
        share: e.share_token ? {
          page: `/c/${e.share_token}`,
          image: `/api/challenges/share/${e.share_token}.png`,
          public: C.isPublicEnabled(flagCfg()),
          include_results: !!e.share_results
        } : null
      });
    } catch (err) { return fail(res, 'me:results', err); }
  });

  router.get('/me/certificate/:enrollmentId', ...memberW, limit(20, 60000), async (req, res) => {
    try {
      const id = String(req.params.enrollmentId).replace(/\.pdf$/i, '');
      // With ?download=1 the PDF streams straight back on the authenticated request.
      if (req.query.download === '1') return sendCertificate(res, id, String(req.user.id));
      const e = await queryOne("SELECT id FROM challenge_enrollments WHERE id = ? AND user_id = ? AND status = 'completed'", [id, req.user.id]);
      if (!e) return res.status(409).json({ error: 'not_ready', message: 'Your certificate unlocks when you finish the challenge.' });
      const token = signPdfAccessToken('challenge-cert:' + e.id, String(req.user.id));
      res.set('Cache-Control', 'no-store');
      res.json({ url: `/api/challenges/certificate/${token}.pdf`, expires_in: 600 });
    } catch (err) { return fail(res, 'me:certificate', err); }
  });

  router.post('/me/lm-call', ...memberW, limit(3, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const r = await engine.requestLmCall(String(req.user.id), String(b.enrollment_id || ''), b);
      const status = r.status || 200;
      delete r.status;
      res.status(status).json(r);
    } catch (e) { return fail(res, 'me:lm-call', e); }
  });

  router.get('/:id', ...member, async (req, res) => {
    try {
      const ch = await engine.loadChallenge(String(req.params.id));
      if (!ch || ch.status !== 'published') return res.status(404).json({ error: 'Challenge not found' });
      const u = await myUser(req.user.id);
      const counts = await participantCounts();
      const p = C.publicChallenge(ch, counts);
      const acc = engine.accessFor(u, ch);
      const mine = await queryOne(
        `SELECT id, status, days_done FROM challenge_enrollments WHERE user_id = ? AND challenge_id = ? AND status <> 'void' ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, ch.id]);
      const otherActive = await queryOne("SELECT e.id, c.title FROM challenge_enrollments e JOIN challenges c ON c.id = e.challenge_id WHERE e.user_id = ? AND e.status = 'active' AND e.challenge_id <> ?", [req.user.id, ch.id]);
      const days = [];
      for (let d = 1; d <= ch.length_days; d++) {
        days.push({ day: d, title: ch.day_titles[d - 1] || ch.tasks.filter((t) => t.day_number === d).map((t) => t.title).join(' + ') });
      }
      res.set('Cache-Control', 'no-store');
      res.json(Object.assign(p, {
        days,
        tasks_per_day: Math.max(...days.map((d) => ch.tasks.filter((t) => t.day_number === d.day).length), 0),
        my: {
          status: mine ? mine.status : null,
          enrollment_id: mine ? mine.id : null,
          locked: !acc.ok,
          locked_message: acc.ok ? '' : (acc.message || ''),
          other_active: otherActive ? { enrollment_id: otherActive.id, title: otherActive.title } : null
        }
      }));
    } catch (e) { return fail(res, 'detail', e); }
  });

  router.post('/:id/join', ...memberW, limit(10, 60000), async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const r = await engine.join(String(req.user.id), String(req.params.id), req.body || {}, { ip });
      const status = r.status || 200;
      delete r.status;
      res.status(status).json(r);
    } catch (e) { return fail(res, 'join', e); }
  });

  router.get('/:id/leaderboard', ...memberW, async (req, res) => {
    try {
      const b = await engine.leaderboard(String(req.params.id), String(req.user.id), req.query.limit);
      if (!b) return res.status(404).json({ error: 'Challenge not found' });
      res.set('Cache-Control', 'no-store');
      res.json(b);
    } catch (e) { return fail(res, 'leaderboard', e); }
  });

  /* ------------------------------------------------------------- admin */

  const staff = [verifyToken, requireAdminOrSuperadmin];
  const parse = (v, d) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return d; } };
  function adminChallenge(r, tasks, stats) {
    return Object.assign({}, r, {
      rewards: parse(r.rewards, {}),
      day_titles: C.asArray(parse(r.day_titles, [])),
      included_tiers: C.asArray(r.included_tiers),
      min_days_effective: C.minDaysFor(r),
      tasks: tasks ? tasks.map((t) => Object.assign({}, t, { params: parse(t.params, {}) })) : undefined,
      stats: stats || undefined,
      flag: flagCfg().mode
    });
  }

  router.get('/admin/challenges', ...staff, async (req, res) => {
    try {
      const rows = await queryAll('SELECT * FROM challenges ORDER BY sort_order, created_at');
      const st = await queryAll(
        `SELECT challenge_id,
                COUNT(*) FILTER (WHERE status <> 'void')::int AS joined,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'left')::int AS left_count
           FROM challenge_enrollments GROUP BY challenge_id`);
      const byId = {};
      st.forEach((s) => { byId[s.challenge_id] = s; });
      const tc = await queryAll('SELECT challenge_id, COUNT(*)::int AS n FROM challenge_tasks GROUP BY challenge_id');
      const tcBy = {};
      tc.forEach((t) => { tcBy[t.challenge_id] = t.n; });
      const lm = await queryOne("SELECT COUNT(*)::int AS n FROM challenge_lm_requests WHERE status = 'requested'");
      res.set('Cache-Control', 'no-store');
      res.json({
        flag: flagCfg().mode,
        open_lm_calls: lm ? lm.n : 0,
        challenges: rows.map((r) => Object.assign(adminChallenge(r), { task_count: tcBy[r.id] || 0, counts: byId[r.id] || { joined: 0, active: 0, completed: 0, failed: 0, left_count: 0 } }))
      });
    } catch (e) { return fail(res, 'admin:list', e); }
  });

  router.get('/admin/challenges/:id', ...staff, async (req, res) => {
    try {
      const r = await queryOne('SELECT * FROM challenges WHERE id = ?', [String(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Challenge not found' });
      const tasks = await queryAll('SELECT * FROM challenge_tasks WHERE challenge_id = ? ORDER BY day_number, position', [r.id]);
      res.json(adminChallenge(r, tasks));
    } catch (e) { return fail(res, 'admin:get', e); }
  });

  router.post('/admin/challenges', ...staff, async (req, res) => {
    try {
      const v = C.validateChallengeInput(req.body, { create: true });
      if (v.errors) return res.status(400).json({ error: 'Please fix the highlighted fields', errors: v.errors });
      const p = v.patch;
      const exists = await queryOne('SELECT 1 AS x FROM challenges WHERE id = ? OR slug = ?', [p.id, p.slug]);
      if (exists) return res.status(409).json({ error: 'A challenge with that id or slug already exists', errors: { id: 'taken' } });
      await run(
        `INSERT INTO challenges (id, slug, title, subtitle, description, length_days, min_days, day_titles, access, included_tiers, rewards, sort_order, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::text[], ?::jsonb, ?, 'draft', ?)`,
        [p.id, p.slug, p.title, p.subtitle || '', p.description || '', p.length_days, p.min_days == null ? null : p.min_days,
          JSON.stringify(p.day_titles || []), p.access, p.included_tiers || [], JSON.stringify(p.rewards || {}), p.sort_order == null ? 100 : p.sort_order, String(req.user.id)]
      );
      await engine.audit(null, p.id, req.user.id, 'challenge_created', p.title);
      const r = await queryOne('SELECT * FROM challenges WHERE id = ?', [p.id]);
      res.status(201).json(adminChallenge(r, []));
    } catch (e) { return fail(res, 'admin:create', e); }
  });

  router.put('/admin/challenges/:id', ...staff, async (req, res) => {
    try {
      const id = String(req.params.id);
      const cur = await queryOne('SELECT * FROM challenges WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'Challenge not found' });
      const body = Object.assign({}, req.body || {});
      delete body.id; delete body.status;
      const v = C.validateChallengeInput(body, { lengthDays: cur.length_days });
      if (v.errors) return res.status(400).json({ error: 'Please fix the highlighted fields', errors: v.errors });
      const keys = Object.keys(v.patch);
      if (!keys.length) return res.json(adminChallenge(cur));
      if (keys.includes('length_days') && Number(v.patch.length_days) !== Number(cur.length_days)) {
        const n = await queryOne("SELECT COUNT(*)::int AS n FROM challenge_enrollments WHERE challenge_id = ? AND status <> 'void'", [id]);
        if (n && n.n > 0) return res.status(409).json({ error: 'People have joined: the length cannot change. Create a new challenge instead.', errors: { length_days: 'locked' } });
      }
      const cast = { day_titles: '::jsonb', rewards: '::jsonb', included_tiers: '::text[]' };
      const sets = keys.map((k) => `${k} = ?${cast[k] || ''}`);
      const vals = keys.map((k) => (k === 'day_titles' || k === 'rewards' ? JSON.stringify(v.patch[k]) : v.patch[k]));
      await run(`UPDATE challenges SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [...vals, id]);
      await engine.audit(null, id, req.user.id, 'challenge_edited', keys.join(', '));
      const tasks = await queryAll('SELECT * FROM challenge_tasks WHERE challenge_id = ? ORDER BY day_number, position', [id]);
      res.json(adminChallenge(await queryOne('SELECT * FROM challenges WHERE id = ?', [id]), tasks));
    } catch (e) { return fail(res, 'admin:put', e); }
  });

  router.put('/admin/challenges/:id/tasks', ...staff, async (req, res) => {
    try {
      const id = String(req.params.id);
      const cur = await queryOne('SELECT * FROM challenges WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'Challenge not found' });
      const list = Array.isArray(req.body && req.body.tasks) ? req.body.tasks : null;
      if (!list || !list.length) return res.status(400).json({ error: 'Send the full task list', errors: { tasks: 'required' } });
      const errs = {};
      const seen = new Set();
      list.forEach((t, i) => {
        const e = C.validateTaskInput(t, cur.length_days);
        const k = `${t.day_number}:${t.position}`;
        if (seen.has(k)) e.push('duplicate day/position');
        seen.add(k);
        if (e.length) errs[`tasks[${i}]`] = e.join('; ');
      });
      for (let d = 1; d <= cur.length_days; d++) if (!list.some((t) => Number(t.day_number) === d)) errs[`day_${d}`] = 'every day needs at least one task';
      if (Object.keys(errs).length) return res.status(400).json({ error: 'Please fix the task list', errors: errs });
      const joined = await queryOne("SELECT COUNT(*)::int AS n FROM challenge_enrollments WHERE challenge_id = ? AND status <> 'void'", [id]);
      const existing = await queryAll('SELECT id, kind, params FROM challenge_tasks WHERE challenge_id = ?', [id]);
      const exBy = new Map(existing.map((t) => [t.id, t]));
      if (joined && joined.n > 0) {
        // Members are mid-run: only titles and points may change; the rules stay put.
        const changed = list.some((t) => {
          const tid = C.taskId(id, Number(t.day_number), Number(t.position));
          const ex = exBy.get(tid);
          return !ex || ex.kind !== t.kind || JSON.stringify(parse(ex.params, {})) !== JSON.stringify(t.params || {});
        }) || list.length !== existing.length;
        if (changed) return res.status(409).json({ error: 'People have joined: only task titles and points can change.', errors: { tasks: 'locked' } });
        for (const t of list) {
          await run('UPDATE challenge_tasks SET title = ?, points = ? WHERE id = ?', [String(t.title).trim(), t.points == null ? 100 : Number(t.points), C.taskId(id, Number(t.day_number), Number(t.position))]);
        }
      } else {
        await run('DELETE FROM challenge_tasks WHERE challenge_id = ?', [id]);
        for (const t of list) {
          await run(
            'INSERT INTO challenge_tasks (id, challenge_id, day_number, position, kind, params, title, points) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)',
            [C.taskId(id, Number(t.day_number), Number(t.position)), id, Number(t.day_number), Number(t.position), t.kind, JSON.stringify(t.params || {}), String(t.title).trim(), t.points == null ? 100 : Number(t.points)]
          );
        }
      }
      await engine.audit(null, id, req.user.id, 'tasks_saved', `${list.length} tasks`);
      const tasks = await queryAll('SELECT * FROM challenge_tasks WHERE challenge_id = ? ORDER BY day_number, position', [id]);
      res.json(adminChallenge(await queryOne('SELECT * FROM challenges WHERE id = ?', [id]), tasks));
    } catch (e) { return fail(res, 'admin:tasks', e); }
  });

  async function setStatus(req, res, status) {
    try {
      const id = String(req.params.id);
      const cur = await queryOne('SELECT * FROM challenges WHERE id = ?', [id]);
      if (!cur) return res.status(404).json({ error: 'Challenge not found' });
      if (status === 'published') {
        const n = await queryOne('SELECT COUNT(*)::int AS n FROM challenge_tasks WHERE challenge_id = ?', [id]);
        const days = await queryOne('SELECT COUNT(DISTINCT day_number)::int AS n FROM challenge_tasks WHERE challenge_id = ?', [id]);
        if (!n || !n.n || !days || days.n < cur.length_days) return res.status(400).json({ error: 'Cannot publish: every day needs at least one task.', errors: { publish: 'tasks' } });
        const text = [cur.title, cur.subtitle, cur.description].concat(C.asArray(parse(cur.day_titles, []))).join(' ');
        if (C.forbiddenText(text)) return res.status(400).json({ error: 'Cannot publish: remove prices, blood data or medical claims from the text first.', errors: { publish: 'wording' } });
      }
      await run(
        `UPDATE challenges SET status = ?, updated_at = NOW(), published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END WHERE id = ?`,
        [status, status, id]
      );
      publicCache = { at: 0, body: null };
      await engine.audit(null, id, req.user.id, 'status_' + status, '');
      res.json(adminChallenge(await queryOne('SELECT * FROM challenges WHERE id = ?', [id])));
    } catch (e) { return fail(res, 'admin:' + status, e); }
  }
  router.post('/admin/challenges/:id/publish', ...staff, (req, res) => setStatus(req, res, 'published'));
  router.post('/admin/challenges/:id/archive', ...staff, (req, res) => setStatus(req, res, 'archived'));
  router.post('/admin/challenges/:id/draft', ...staff, (req, res) => setStatus(req, res, 'draft'));

  router.get('/admin/enrollments', ...staff, async (req, res) => {
    try {
      const where = [];
      const params = [];
      const cid = String(req.query.challenge_id || '');
      const status = String(req.query.status || '');
      const q = String(req.query.q || '').trim();
      if (cid) { where.push('e.challenge_id = ?'); params.push(cid); }
      if (['active', 'completed', 'failed', 'left', 'void'].includes(status)) { where.push('e.status = ?'); params.push(status); }
      if (q.length >= 2) { where.push("(u.email ILIKE ? OR u.first_name ILIKE ? OR u.last_name ILIKE ? OR u.phone ILIKE ?)"); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%'); }
      const rows = await queryAll(
        `SELECT e.id, e.challenge_id, c.title, c.length_days, e.user_id, u.first_name, u.last_name, u.email, u.phone, u.plan_tier,
                e.status, e.days_done, e.points, e.start_date::text AS start_date, e.tz, e.source, e.utm, e.referral_code,
                e.leaderboard_opt_out, e.created_at, e.completed_at, e.void_reason,
                (SELECT status FROM challenge_lm_requests l WHERE l.enrollment_id = e.id) AS lm_status
           FROM challenge_enrollments e JOIN users u ON u.id = e.user_id JOIN challenges c ON c.id = e.challenge_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY e.created_at DESC LIMIT 500`, params);
      res.set('Cache-Control', 'no-store');
      res.json({ enrollments: rows });
    } catch (e) { return fail(res, 'admin:enrollments', e); }
  });

  router.get('/admin/enrollments/:id', ...staff, async (req, res) => {
    try {
      const v = await engine.dayView(String(req.params.id), { day: req.query.day });
      if (!v) return res.status(404).json({ error: 'Not found' });
      const log = await queryAll('SELECT action, notes, actor_id, created_at FROM challenge_audit WHERE enrollment_id = ? ORDER BY created_at DESC LIMIT 50', [String(req.params.id)]);
      res.json(Object.assign(v, { audit: log }));
    } catch (e) { return fail(res, 'admin:enrollment', e); }
  });

  router.post('/admin/enrollments/:id/void', ...staff, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
      if (!reason) return res.status(400).json({ error: 'Write a reason', errors: { reason: 'required' } });
      const r = await queryOne("UPDATE challenge_enrollments SET status = 'void', void_reason = ?, ended_at = COALESCE(ended_at, NOW()) WHERE id = ? AND status <> 'void' RETURNING id, challenge_id", [reason, String(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Not found or already void' });
      // Voiding reverses nothing automatically (coins, rewards): it is logged for staff.
      await engine.audit(r.id, r.challenge_id, req.user.id, 'voided', reason);
      res.json({ voided: true, id: r.id });
    } catch (e) { return fail(res, 'admin:void', e); }
  });

  router.post('/admin/enrollments/:id/tasks/:taskId/complete', ...staff, async (req, res) => {
    try {
      const e = await queryOne("SELECT id, user_id, challenge_id, status, start_date::text AS start_date FROM challenge_enrollments WHERE id = ?", [String(req.params.id)]);
      if (!e || e.status !== 'active') return res.status(404).json({ error: 'Active enrollment not found' });
      const t = await queryOne('SELECT * FROM challenge_tasks WHERE id = ? AND challenge_id = ?', [String(req.params.taskId), e.challenge_id]);
      if (!t) return res.status(404).json({ error: 'Task not found' });
      if (t.kind !== 'manual') return res.status(400).json({ error: 'Only manual tasks are ticked by staff. Other tasks follow the member\'s own data.' });
      await run(
        `INSERT INTO challenge_task_completions (id, enrollment_id, task_id, user_id, day_number, local_date, evidence)
         VALUES (?, ?, ?, ?, ?, ?::date, ?::jsonb) ON CONFLICT (enrollment_id, task_id) DO NOTHING`,
        [uuid(), e.id, t.id, e.user_id, t.day_number, C.dateOfDay(e.start_date, Number(t.day_number)), JSON.stringify({ at: Date.now(), kind: 'manual', by: String(req.user.id) })]
      );
      await engine.audit(e.id, e.challenge_id, req.user.id, 'manual_task', t.title);
      await engine.sync(e.id);
      res.json({ ok: true });
    } catch (err) { return fail(res, 'admin:manual', err); }
  });

  router.post('/admin/enroll', ...staff, async (req, res) => {
    try {
      const b = req.body || {};
      const u = await queryOne("SELECT id FROM users WHERE id = ? AND role = 'user'", [String(b.user_id || '')]);
      if (!u) return res.status(404).json({ error: 'Member not found' });
      const r = await engine.join(u.id, String(b.challenge_id || ''), { client_uuid: 'staff-' + uuid(), source: 'staff' }, { force: true, actorId: String(req.user.id) });
      const status = r.status || 200;
      delete r.status;
      res.status(status).json(r);
    } catch (e) { return fail(res, 'admin:enroll', e); }
  });

  router.post('/admin/enrollments/:id/sync', ...staff, async (req, res) => {
    try {
      const out = await engine.sync(String(req.params.id));
      if (!out) return res.status(404).json({ error: 'Not found' });
      res.json({ status: out.enrollment.status, days_done: out.enrollment.days_done, points: out.enrollment.points });
    } catch (e) { return fail(res, 'admin:sync', e); }
  });

  router.get('/admin/stats/:id', ...staff, async (req, res) => {
    try {
      const ch = await engine.loadChallenge(String(req.params.id));
      if (!ch) return res.status(404).json({ error: 'Challenge not found' });
      const counts = await queryOne(
        `SELECT COUNT(*) FILTER (WHERE status <> 'void')::int AS joined,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'left')::int AS left_count,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND status <> 'void')::int AS joined_7d
           FROM challenge_enrollments WHERE challenge_id = ?`, [ch.id]);
      // Day retention: share of joiners whose day n is fully done.
      const perDay = await queryAll(
        `SELECT x.day_number, COUNT(*)::int AS n FROM (
            SELECT k.enrollment_id, k.day_number, COUNT(*) AS done
              FROM challenge_task_completions k JOIN challenge_enrollments e ON e.id = k.enrollment_id
             WHERE e.challenge_id = ? AND e.status <> 'void'
             GROUP BY k.enrollment_id, k.day_number) x
          JOIN (SELECT day_number, COUNT(*) AS total FROM challenge_tasks WHERE challenge_id = ? GROUP BY day_number) t
            ON t.day_number = x.day_number AND x.done >= t.total
          GROUP BY x.day_number ORDER BY x.day_number`, [ch.id, ch.id]);
      const joined = counts ? counts.joined : 0;
      const curve = [];
      for (let d = 1; d <= ch.length_days; d++) {
        const row = perDay.find((p) => Number(p.day_number) === d);
        curve.push({ day: d, done: row ? row.n : 0, pct: joined ? Math.round(((row ? row.n : 0) / joined) * 100) : 0 });
      }
      const finished = (counts ? counts.completed + counts.failed : 0);
      const upgrades = await queryOne(
        `SELECT COUNT(*) FILTER (WHERE d.used_at IS NOT NULL)::int AS used, COUNT(*)::int AS issued
           FROM challenge_discounts d JOIN challenge_enrollments e ON e.id = d.enrollment_id WHERE e.challenge_id = ?`, [ch.id]);
      const sources = await queryAll(
        `SELECT COALESCE(NULLIF(utm->>'utm_source',''), source, 'app') AS src, COUNT(*)::int AS n
           FROM challenge_enrollments WHERE challenge_id = ? AND status <> 'void' GROUP BY 1 ORDER BY n DESC LIMIT 10`, [ch.id]);
      res.json({
        challenge_id: ch.id,
        counts,
        completion_pct: finished ? Math.round((counts.completed / finished) * 100) : null,
        retention: curve,
        upgrades: upgrades || { used: 0, issued: 0 },
        sources
      });
    } catch (e) { return fail(res, 'admin:stats', e); }
  });

  router.get('/admin/lm-calls', ...staff, async (req, res) => {
    try {
      const st = String(req.query.status || '');
      const rows = await queryAll(
        `SELECT l.id, l.enrollment_id, l.user_id, l.phone, l.preferred_slot, l.status, l.notes, l.created_at, l.updated_at,
                u.first_name, u.last_name, u.email, u.phone AS user_phone, c.title
           FROM challenge_lm_requests l JOIN users u ON u.id = l.user_id
           JOIN challenge_enrollments e ON e.id = l.enrollment_id JOIN challenges c ON c.id = e.challenge_id
          ${['requested', 'scheduled', 'done', 'cancelled'].includes(st) ? 'WHERE l.status = ?' : ''}
          ORDER BY (l.status = 'requested') DESC, l.created_at DESC LIMIT 300`,
        ['requested', 'scheduled', 'done', 'cancelled'].includes(st) ? [st] : []);
      res.json({ calls: rows });
    } catch (e) { return fail(res, 'admin:lm', e); }
  });

  router.put('/admin/lm-calls/:id', ...staff, async (req, res) => {
    try {
      const b = req.body || {};
      if (!['requested', 'scheduled', 'done', 'cancelled'].includes(b.status)) return res.status(400).json({ error: 'Pick a status', errors: { status: 'requested, scheduled, done or cancelled' } });
      const r = await queryOne(
        'UPDATE challenge_lm_requests SET status = ?, notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ? RETURNING id, enrollment_id, status',
        [b.status, b.notes == null ? null : String(b.notes).slice(0, 1000), String(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Not found' });
      await engine.audit(r.enrollment_id, null, req.user.id, 'lm_call_' + b.status, b.notes ? String(b.notes).slice(0, 200) : '');
      res.json(r);
    } catch (e) { return fail(res, 'admin:lm:put', e); }
  });

  router.get('/admin/export.csv', ...staff, async (req, res) => {
    try {
      const cid = String(req.query.challenge_id || '');
      const rows = await queryAll(
        `SELECT e.id, c.title, u.first_name, u.last_name, u.email, u.phone, u.plan_tier, e.status, e.days_done, e.points,
                e.start_date::text AS start_date, e.completed_at, e.source, e.utm->>'utm_source' AS utm_source,
                e.utm->>'utm_campaign' AS utm_campaign, e.referral_code, e.created_at
           FROM challenge_enrollments e JOIN users u ON u.id = e.user_id JOIN challenges c ON c.id = e.challenge_id
          ${cid ? 'WHERE e.challenge_id = ?' : ''} ORDER BY e.created_at DESC`, cid ? [cid] : []);
      const cols = ['id', 'title', 'first_name', 'last_name', 'email', 'phone', 'plan_tier', 'status', 'days_done', 'points', 'start_date', 'completed_at', 'source', 'utm_source', 'utm_campaign', 'referral_code', 'created_at'];
      const cell = (v) => {
        let s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
        if (/^[=+\-@]/.test(s)) s = "'" + s; // no formula injection in Excel
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\n');
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="challenges-${cid || 'all'}.csv"`);
      res.send('﻿' + csv);
    } catch (e) { return fail(res, 'admin:csv', e); }
  });

  router.get('/admin/members', ...staff, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ users: [] });
      const rows = await queryAll(
        `SELECT id, first_name, last_name, email, plan_tier FROM users
          WHERE role = 'user' AND (email ILIKE ? OR first_name ILIKE ? OR last_name ILIKE ? OR (first_name || ' ' || COALESCE(last_name,'')) ILIKE ?)
          ORDER BY first_name LIMIT 15`, ['%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%']);
      res.json({ users: rows });
    } catch (e) { return fail(res, 'admin:members', e); }
  });

  return router;
}

/**
 * Public share page /c/:token (Open Graph tags for WhatsApp / Instagram previews).
 * Not under /api so link previews read a normal HTML page.
 */
function createChallengeSharePage(deps) {
  const { queryOne, env } = deps;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return async function sharePage(req, res) {
    try {
      if (!C.isPublicEnabled(C.flagConfig(env || process.env))) return res.redirect(302, '/');
      const token = String(req.params.token || '');
      if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) return res.status(404).send('Not found');
      const e = await queryOne(
        `SELECT e.status, e.days_done, e.display_name, e.start_date::text AS start_date, c.title, c.length_days
           FROM challenge_enrollments e JOIN challenges c ON c.id = e.challenge_id WHERE e.share_token = ?`, [token]);
      if (!e || e.status === 'void') return res.status(404).send('Not found');
      const origin = `${req.protocol}://${req.get('host')}`;
      const done = e.status === 'completed';
      const title = done ? `${e.display_name} finished the BodyBank ${e.title}` : `${e.display_name} is on the BodyBank ${e.title}`;
      const desc = done ? `${e.days_done} of ${e.length_days} days done. Join the free 7 day challenge with real coaches.` : 'Daily tasks, real coaching, real rewards. Join the free 7 day challenge.';
      const img = `${origin}/api/challenges/share/${token}.png?format=square`;
      res.set('Cache-Control', 'public, max-age=600');
      res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · BodyBank</title><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1080">
<meta property="og:url" content="${esc(origin + '/c/' + token)}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<meta name="robots" content="noindex"><link rel="canonical" href="${esc(origin + '/challenge')}">
<style>:root{color-scheme:dark}body{margin:0;background:radial-gradient(120% 50% at 50% -5%,rgba(201,160,64,.14),transparent 60%),#0b0b0c;color:#f5f1e8;font-family:'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;min-height:100vh;justify-content:center;padding:20px 16px 32px;box-sizing:border-box}
main{max-width:440px;width:100%;text-align:center}
.top{display:flex;align-items:center;gap:12px;margin:0 0 22px}
.back{width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.1);background:#1b1b1e;color:#f5f1e8;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;flex:0 0 auto}
.back svg{width:18px;height:18px}
.brand{line-height:0;text-decoration:none}.brand img{height:42px;width:auto;display:block}
.back:focus-visible,.brand:focus-visible{outline:2px solid #e3c274;outline-offset:3px}main>img{width:100%;height:auto;border-radius:22px;border:1px solid rgba(201,160,64,.38)}
h1{font-size:22px;margin:20px 0 6px}p{color:#a49f95;margin:0 0 20px;line-height:1.5}
a.cta{display:block;min-height:52px;line-height:52px;border-radius:16px;background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);color:#17120a;font-weight:800;text-decoration:none;font-size:16px}
a.cta:focus-visible{outline:2px solid #e3c274;outline-offset:3px}</style></head>
<body><main><div class="top"><a class="back" href="/" aria-label="Back to BodyBank" onclick="if(document.referrer&&document.referrer.indexOf(location.origin)===0&&history.length>1){history.back();return false}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></a>
<a class="brand" href="/" aria-label="BodyBank home"><img src="/img/bodybank-logo-gold-360.png" alt="BodyBank" width="360" height="138"></a></div><img src="${esc(img)}" width="1080" height="1080" alt="${esc(title)}"><h1>${esc(title)}</h1><p>${esc(desc)}</p><a class="cta" href="/challenge?utm_source=share&amp;utm_medium=certificate">Join the free 7 day challenge</a></main></body></html>`);
    } catch (err) {
      console.error('[challenges] share page', err && err.message);
      res.status(500).send('Something went wrong');
    }
  };
}

module.exports = { createChallengesRouter, createChallengeSharePage };
