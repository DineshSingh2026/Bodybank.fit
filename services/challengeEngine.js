'use strict';

/**
 * BodyBank Challenges — the DB side (single source of truth for task progress).
 *
 *   sync(enrollmentId)  read existing member data for every elapsed day, record task
 *                       completions, pay day coins, finish or fail the enrollment.
 *   onActivity(userId)  debounced sync for a member, fired after check-ins, meal logs,
 *                       workouts (server.js hook), on GET /me/active and from the cron.
 *
 * Nothing here writes to an existing table except coin_ledger / coin_wallet through
 * coinService.awardCoins (idempotent on event_key). Every write is idempotent:
 * completions UNIQUE(enrollment_id, task_id), rewards UNIQUE(reward_key),
 * discounts UNIQUE(enrollment_id), LM calls UNIQUE(enrollment_id).
 *
 * Pure rules live in services/challengeService.js.
 */

const crypto = require('crypto');
const C = require('./challengeService');

function createChallengeEngine(deps) {
  const {
    queryAll, queryOne, run, getPool,
    coinService, plans,
    notifyAgent = () => {}, notifyHub = null,
    env = process.env,
    defaultTz = C.DEFAULT_TZ,
    publicOrigin = ''
  } = deps;
  const log = deps.logger || console;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
  const flagCfg = () => C.flagConfig(env);
  const origin = () => String(publicOrigin || env.PUBLIC_URL || env.APP_ORIGIN || env.SITE_URL || 'https://www.bodybank.fit').replace(/\/$/, '');

  /* ---------------------------------------------------------- helpers */

  let zoneCache = null;
  /** The DB session's TimeZone: how naive `timestamp` columns were written. */
  async function naiveZone() {
    if (zoneCache) return zoneCache;
    try {
      const r = await queryOne("SELECT current_setting('TimeZone') AS tz");
      zoneCache = C.resolveTz(r && r.tz, 'UTC');
    } catch (_) { zoneCache = 'UTC'; }
    return zoneCache;
  }

  async function safeAll(sql, params) {
    try { return await queryAll(sql, params); } catch (e) { log.warn('[challenges] query skipped:', e.message); return []; }
  }

  function parseJson(v, dflt) {
    if (v == null) return dflt;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (_) { return dflt; }
  }

  function normChallenge(row) {
    if (!row) return null;
    return Object.assign({}, row, {
      rewards: parseJson(row.rewards, {}),
      included_tiers: C.asArray(row.included_tiers),
      day_titles: C.asArray(parseJson(row.day_titles, []))
    });
  }
  function normTask(t) {
    return Object.assign({}, t, { params: parseJson(t.params, {}), day_number: Number(t.day_number), position: Number(t.position), points: Number(t.points) || 0 });
  }

  async function loadChallenge(id) {
    const ch = normChallenge(await queryOne('SELECT * FROM challenges WHERE id = ?', [String(id)]));
    if (!ch) return null;
    const tasks = (await queryAll('SELECT * FROM challenge_tasks WHERE challenge_id = ? ORDER BY day_number, position', [ch.id])).map(normTask);
    ch.tasks = tasks;
    return ch;
  }
  function tasksOfDay(ch, day) { return ch.tasks.filter((t) => t.day_number === day); }

  /** Raw evidence rows for a member between two dates (inclusive), with margins for tz. */
  async function fetchRows(userId, fromYmd, toYmd) {
    const lo = C.addDays(fromYmd, -2);
    const hi = C.addDays(toYmd, 2);
    const [checkins, meals, coach, workouts, mind, sunday] = await Promise.all([
      safeAll(
        `SELECT checkin_date::text AS checkin_date, created_at::text AS created_at, updated_at::text AS updated_at,
                COALESCE(is_freeze, FALSE) AS is_freeze, steps, water_ml, protein_g, sleep_hours
           FROM daily_checkins WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date`,
        [userId, fromYmd, toYmd]),
      safeAll(
        `SELECT log_date::text AS log_date,
                (EXTRACT(EPOCH FROM submitted_at) * 1000)::float8 AS submitted_ms,
                CASE WHEN (ai_result->>'protein') ~ '^[0-9]+(\\.[0-9]+){0,1}$' THEN (ai_result->>'protein')::float8 ELSE 0 END AS protein
           FROM nutrition_meal_logs WHERE user_id = ? AND log_date BETWEEN ?::date AND ?::date`,
        [userId, fromYmd, toYmd]),
      safeAll(
        `SELECT local_date::text AS local_date, (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS created_ms,
                duration_seconds, total_sets, area
           FROM coach_workouts WHERE user_id = ? AND local_date BETWEEN ?::date AND ?::date`,
        [userId, fromYmd, toYmd]),
      safeAll(
        `SELECT session_date::text AS session_date, created_at::text AS created_at, duration_seconds, workout_type
           FROM workout_logs WHERE user_id = ? AND created_at >= ?::date AND created_at < ?::date`,
        [userId, lo, hi]),
      safeAll(
        `SELECT checkin_date::text AS checkin_date, created_at::text AS created_at
           FROM mind_checkins WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date`,
        [userId, fromYmd, toYmd]),
      safeAll(
        `SELECT created_at::text AS created_at FROM sunday_checkins
          WHERE user_id = ? AND created_at >= ?::date AND created_at < ?::date`,
        [userId, lo, hi])
    ]);
    return { checkins, meals, coach, workouts, mind, sunday };
  }

  async function goalsFor(userId) {
    const u = await queryOne('SELECT goal_protein_g FROM users WHERE id = ?', [userId]).catch(() => null);
    return { goal_protein_g: u && Number(u.goal_protein_g) > 0 ? Number(u.goal_protein_g) : C.DEFAULT_PROTEIN_G };
  }

  async function completionsOf(enrollmentId) {
    return queryAll(
      `SELECT task_id, day_number, local_date::text AS local_date, evidence, completed_at
         FROM challenge_task_completions WHERE enrollment_id = ?`,
      [enrollmentId]
    );
  }

  function doneDaysFrom(ch, completions) {
    const byDay = new Map();
    completions.forEach((c) => {
      const d = Number(c.day_number);
      if (!byDay.has(d)) byDay.set(d, new Set());
      byDay.get(d).add(c.task_id);
    });
    const done = new Set();
    let points = 0;
    for (let d = 1; d <= ch.length_days; d++) {
      const tasks = tasksOfDay(ch, d);
      const ids = byDay.get(d) || new Set();
      points += C.dayPoints(tasks, [...ids]);
      if (tasks.length && tasks.every((t) => ids.has(t.id))) done.add(d);
    }
    return { doneDays: done, points, byDay };
  }

  async function userBrief(userId) {
    return queryOne('SELECT id, email, first_name, last_name, phone, role, timezone, plan_tier, created_at FROM users WHERE id = ?', [userId]).catch(() => null);
  }
  function agentWho(u) {
    return { name: `${(u && u.first_name) || ''} ${(u && u.last_name) || ''}`.trim(), email: (u && u.email) || '', mobile: (u && u.phone) || '—' };
  }

  async function award(userId, eventKey, delta, ymd, meta) {
    if (!coinService || !(delta > 0)) return { applied: false };
    try {
      return await coinService.awardCoins(
        { run, queryOne, queryAll },
        { userId, eventType: 'challenge', eventKey, coinsDelta: delta, meta: meta || {}, createdAtYmd: ymd }
      );
    } catch (e) { log.warn('[challenges] coins:', e.message); return { applied: false }; }
  }

  async function grantReward(e, kind, key, payload) {
    const r = await run(
      `INSERT INTO challenge_rewards (id, enrollment_id, user_id, kind, reward_key, payload)
       VALUES (?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (reward_key) DO NOTHING`,
      [uuid(), e.id, e.user_id, kind, key, JSON.stringify(payload || {})]
    );
    return !!(r && r.rowCount);
  }

  /* ------------------------------------------------------------- sync */

  const locks = new Map();
  /** Serialise work per enrollment inside this process (DB keys guard across processes). */
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {}); // the queue never rejects; the caller still sees errors
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return next;
  }

  function sync(enrollmentId, opts) {
    return withLock('e:' + enrollmentId, () => syncNow(enrollmentId, opts || {}));
  }

  async function syncNow(enrollmentId, opts) {
    const e = await queryOne('SELECT *, start_date::text AS start_date FROM challenge_enrollments WHERE id = ?', [enrollmentId]);
    if (!e) return null;
    const ch = await loadChallenge(e.challenge_id);
    if (!ch) return null;
    if (e.status !== 'active') return { enrollment: e, challenge: ch, newlyDoneDays: [] };

    const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;
    const tz = C.resolveTz(e.tz, defaultTz);
    const today = C.todayIn(tz, nowMs);
    const todayDay = C.dayNumberOf(e.start_date, today);
    const len = ch.length_days;
    const lastDay = Math.min(todayDay, len);

    let comps = await completionsOf(e.id);
    let state = doneDaysFrom(ch, comps);

    // Days still open for evidence: elapsed, not fully done.
    const open = [];
    for (let d = 1; d <= lastDay; d++) if (!state.doneDays.has(d)) open.push(d);
    if (open.length) {
      const zone = await naiveZone();
      const rows = await fetchRows(e.user_id, C.dateOfDay(e.start_date, open[0]), C.dateOfDay(e.start_date, open[open.length - 1]));
      const goals = await goalsFor(e.user_id);
      let wrote = false;
      for (const d of open) {
        const ymd = C.dateOfDay(e.start_date, d);
        const ev = C.dayEvidence(rows, ymd, tz, zone);
        const res = C.evaluateDay(tasksOfDay(ch, d), ev, goals);
        const have = state.byDay.get(d) || new Set();
        for (const r of res.results) {
          if (!r.done || have.has(r.task.id)) continue;
          const ins = await run(
            `INSERT INTO challenge_task_completions (id, enrollment_id, task_id, user_id, day_number, local_date, evidence)
             VALUES (?, ?, ?, ?, ?, ?::date, ?::jsonb) ON CONFLICT (enrollment_id, task_id) DO NOTHING`,
            [uuid(), e.id, r.task.id, e.user_id, d, ymd, JSON.stringify(Object.assign({ at: r.at, kind: r.task.kind }, r.evidence))]
          );
          if (ins && ins.rowCount) wrote = true;
        }
      }
      if (wrote) {
        comps = await completionsOf(e.id);
        state = doneDaysFrom(ch, comps);
      }
    }

    await run('UPDATE challenge_enrollments SET days_done = ?, points = ?, evaluated_at = NOW() WHERE id = ? AND status = ?',
      [state.doneDays.size, state.points, e.id, 'active']);
    e.days_done = state.doneDays.size;
    e.points = state.points;

    // Day coins + agent event, once per day (reward_key guards both).
    const newlyDoneDays = [];
    const u = state.doneDays.size ? await userBrief(e.user_id) : null;
    for (const d of [...state.doneDays].sort((a, b) => a - b)) {
      const key = C.rewardKey(e.id, 'day', d);
      const ymd = C.dateOfDay(e.start_date, d);
      const first = await grantReward(e, 'coins_day', key, { day: d, coins: C.COIN_RULES.CHALLENGE_DAY });
      if (!first) continue;
      newlyDoneDays.push(d);
      await award(e.user_id, C.coinEventKey(e.id, 'day', d), C.COIN_RULES.CHALLENGE_DAY, ymd, { challenge_id: ch.id, enrollment_id: e.id, day: d });
      try {
        notifyAgent('CHALLENGE_DAY_DONE', Object.assign(agentWho(u), {
          challenge: ch.title, challenge_id: ch.id, day: d, of: len,
          tasks_done: tasksOfDay(ch, d).length, points: state.points
        }));
      } catch (_) { /* never blocks */ }
    }

    const verdict = C.completionState({
      length: len, minDays: C.minDaysFor(ch), todayDay, doneDays: state.doneDays
    });
    if (verdict === 'completed') await finishCompleted(e, ch, state, today);
    else if (verdict === 'failed') {
      const r = await run("UPDATE challenge_enrollments SET status = 'failed', ended_at = NOW() WHERE id = ? AND status = 'active'", [e.id]);
      if (r && r.rowCount) {
        e.status = 'failed';
        await audit(e.id, ch.id, null, 'failed', `${state.doneDays.size} of ${len} days done`);
      }
    }
    return { enrollment: e, challenge: ch, newlyDoneDays, verdict };
  }

  async function finishCompleted(e, ch, state, today) {
    const r = await queryOne(
      "UPDATE challenge_enrollments SET status = 'completed', completed_at = NOW(), ended_at = NOW() WHERE id = ? AND status = 'active' RETURNING id, share_token",
      [e.id]
    );
    if (!r) return false;
    e.status = 'completed';
    const rw = ch.rewards || {};
    const coins = C.completionCoins(ch);
    if (await grantReward(e, 'coins_complete', C.rewardKey(e.id, 'complete'), { coins })) {
      await award(e.user_id, C.coinEventKey(e.id, 'complete'), coins, today, { challenge_id: ch.id, enrollment_id: e.id, completed: true });
    }
    if (rw.badge_key) await grantReward(e, 'badge', C.rewardKey(e.id, 'badge'), { badge_key: rw.badge_key, label: rw.badge_label || 'Badge', challenge: ch.title });
    if (rw.certificate) await grantReward(e, 'certificate', C.rewardKey(e.id, 'certificate'), { challenge: ch.title });
    if (rw.discount) {
      const pct = C.discountPct(env);
      await run(
        `INSERT INTO challenge_discounts (id, user_id, enrollment_id, pct, applies_to, expires_at)
         VALUES (?, ?, ?, ?, ?::text[], NOW() + (? || ' days')::interval) ON CONFLICT (enrollment_id) DO NOTHING`,
        [uuid(), e.user_id, e.id, pct, C.DISCOUNT_TIERS, String(C.DISCOUNT_DAYS)]
      );
      await grantReward(e, 'discount', C.rewardKey(e.id, 'discount'), { pct, applies_to: C.DISCOUNT_TIERS, days: C.DISCOUNT_DAYS });
    }
    if (rw.lm_call) await grantReward(e, 'lm_call', C.rewardKey(e.id, 'lm_call'), { offered: true });
    await audit(e.id, ch.id, null, 'completed', `${state.doneDays.size} of ${ch.length_days} days, ${state.points} points`);

    const u = await userBrief(e.user_id);
    try {
      notifyAgent('CHALLENGE_COMPLETED', Object.assign(agentWho(u), {
        challenge: ch.title, challenge_id: ch.id, days_done: state.doneDays.size, of: ch.length_days, points: state.points,
        certificate_url: r.share_token ? `${origin()}/c/${r.share_token}` : ''
      }));
    } catch (_) { /* never blocks */ }
    if (notifyHub && C.isEnabledFor(u, flagCfg())) {
      notifyHub.user(e.user_id, {
        title: `🏆 ${ch.title} complete`,
        body: `You finished ${state.doneDays.size} of ${ch.length_days} days. Your certificate and badge are ready.`,
        type: 'challenge', link: 'challenge', tag: 'challenge-' + e.id + '-done'
      });
    }
    return true;
  }

  async function audit(enrollmentId, challengeId, actorId, action, notes) {
    try {
      await run('INSERT INTO challenge_audit (id, enrollment_id, challenge_id, actor_id, action, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), enrollmentId || null, challengeId || null, actorId || null, action, String(notes || '').slice(0, 500)]);
    } catch (e) { log.warn('[challenges] audit:', e.message); }
  }

  /* ---------------------------------------------------- activity + cron */

  const pending = new Map();
  /** Debounced: several saves in a burst cost one sync. Resolves when done. */
  function onActivity(userId, opts) {
    const id = String(userId || '');
    if (!id) return Promise.resolve();
    const delay = opts && opts.immediate ? 0 : 1500;
    if (pending.has(id)) return pending.get(id).promise;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pending.set(id, { promise });
    setTimeout(async () => {
      pending.delete(id);
      try {
        const rows = await queryAll("SELECT id FROM challenge_enrollments WHERE user_id = ? AND status = 'active'", [id]);
        for (const r of rows) await sync(r.id);
      } catch (e) { log.warn('[challenges] activity sync:', e.message); }
      resolve();
    }, delay);
    return promise;
  }

  async function syncUser(userId) {
    const rows = await queryAll("SELECT id FROM challenge_enrollments WHERE user_id = ? AND status = 'active'", [String(userId)]);
    for (const r of rows) await sync(r.id);
  }

  /** Every 30 min: close days, finish/fail runs, send at most two reminders a day. */
  async function runCron(opts) {
    const cfg = flagCfg();
    if (cfg.mode === 'off') return { skipped: 'flag off' };
    const nowMs = (opts && opts.nowMs) || Date.now();
    const rows = await safeAll(
      `SELECT e.id, e.user_id, e.tz, e.challenge_id, e.start_date::text AS start_date, u.role, u.email
         FROM challenge_enrollments e JOIN users u ON u.id = e.user_id
        WHERE e.status = 'active' ORDER BY e.created_at LIMIT 5000`, []);
    let synced = 0;
    let pushed = 0;
    for (const r of rows) {
      try {
        const out = await sync(r.id, { nowMs });
        synced += 1;
        if (out && out.enrollment && out.enrollment.status === 'active' && C.isEnabledFor({ id: r.user_id, role: r.role, email: r.email }, cfg)) {
          if (await maybeRemind(out, nowMs)) pushed += 1;
        }
      } catch (e) { log.warn('[challenges] cron sync', r.id, e.message); }
    }
    return { synced, pushed };
  }

  async function usualCheckinHour(userId, tz) {
    const zone = await naiveZone();
    const rows = await safeAll(
      'SELECT created_at::text AS created_at FROM daily_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 14', [userId]);
    const counts = {};
    rows.forEach((x) => {
      const ms = C.instantOf(x.created_at, true, zone);
      if (ms == null) return;
      const h = C.localHourOf(ms, tz);
      if (!C.inQuietHours(h)) counts[h] = (counts[h] || 0) + 1;
    });
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a - b)[0];
    return best == null ? 8 : Number(best);
  }

  async function maybeRemind(out, nowMs) {
    if (!notifyHub) return false;
    const e = out.enrollment;
    const ch = out.challenge;
    const tz = C.resolveTz(e.tz, defaultTz);
    const hour = C.localHourOf(nowMs, tz);
    if (C.inQuietHours(hour)) return false;
    const today = C.todayIn(tz, nowMs);
    const day = C.dayNumberOf(e.start_date, today);
    if (day < 1 || day > ch.length_days) return false;
    const comps = await queryAll('SELECT task_id FROM challenge_task_completions WHERE enrollment_id = ? AND day_number = ?', [e.id, day]);
    const doneIds = new Set(comps.map((c) => c.task_id));
    const tasks = tasksOfDay(ch, day);
    const left = tasks.filter((t) => !doneIds.has(t.id));
    if (!left.length) return false;

    let slot = null;
    if (hour === 19) slot = 'evening';
    else if (hour === await usualCheckinHour(e.user_id, tz) && left.length === tasks.length) slot = 'morning';
    if (!slot) return false;
    const claim = await run(
      'INSERT INTO challenge_push_log (id, enrollment_id, user_id, local_date, slot) VALUES (?, ?, ?, ?::date, ?) ON CONFLICT (enrollment_id, local_date, slot) DO NOTHING',
      [uuid(), e.id, e.user_id, today, slot]
    );
    if (!claim || !claim.rowCount) return false;
    // Hard cap: two challenge pushes per member per local day.
    const sent = await queryOne('SELECT COUNT(*)::int AS n FROM challenge_push_log WHERE user_id = ? AND local_date = ?::date', [e.user_id, today]);
    if (sent && sent.n > 2) return false;
    const msg = slot === 'morning'
      ? { title: `Day ${day} of ${ch.title}`, body: `${tasks.length} small tasks today: ${tasks.map((t) => t.title).join(', ')}.` }
      : { title: left.length === 1 ? '1 task left today' : `${left.length} tasks left today`, body: `${left.map((t) => t.title).join(', ')} — finish Day ${day} before midnight.` };
    notifyHub.user(e.user_id, Object.assign(msg, { type: 'challenge', link: 'challenge', tag: `challenge-${e.id}-${slot}`, inbox: false }));
    return true;
  }

  /* ------------------------------------------------------------- joins */

  function referralLookup(code) {
    const c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    if (!c) return Promise.resolve(null);
    return queryOne('SELECT user_id FROM referral_codes WHERE UPPER(code) = ?', [c]).then((r) => (r ? { code: c, user_id: r.user_id } : { code: c, user_id: null })).catch(() => ({ code: c, user_id: null }));
  }

  /** Can this member join (ignoring repeats)? */
  function accessFor(user, ch) {
    if (!user || user.role !== C.MEMBER_ROLE) return { ok: false, reason: 'members_only' };
    if (ch.access === 'free') return { ok: true };
    const tier = plans ? plans.tierOf(user) : null;
    if (ch.access === 'plan' && tier && C.asArray(ch.included_tiers).includes(tier)) return { ok: true };
    const names = C.asArray(ch.included_tiers).map((t) => (plans ? plans.tierName(t) : t));
    return {
      ok: false,
      reason: 'not_included',
      message: names.length
        ? `Included with ${names.join(' and ')}. Your lifestyle manager can unlock it for you.`
        : 'Your lifestyle manager can unlock this challenge for you.'
    };
  }

  function cleanUtm(u) {
    const out = {};
    if (!u || typeof u !== 'object') return out;
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      if (u[k] != null && String(u[k]).trim()) out[k] = String(u[k]).trim().slice(0, 80);
    }
    return out;
  }

  /**
   * Join. Idempotent on (user, client_uuid). `force` (staff enrol) skips access and
   * repeat rules but never the one-active rule.
   */
  async function join(userId, challengeId, body, meta) {
    const b = body || {};
    const m = meta || {};
    const clientUuid = String(b.client_uuid || '').trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientUuid)) return { status: 400, error: 'client_uuid must be 8–64 letters, digits or dashes' };

    const existing = await queryOne('SELECT id, challenge_id FROM challenge_enrollments WHERE user_id = ? AND client_uuid = ?', [userId, clientUuid]);
    if (existing) return { status: 200, duplicate: true, enrollment_id: existing.id, challenge_id: existing.challenge_id };

    const ch = await loadChallenge(challengeId);
    if (!ch || (ch.status !== 'published' && !m.force)) return { status: 404, error: 'Challenge not found' };
    if (!ch.tasks.length) return { status: 409, error: 'This challenge has no tasks yet' };
    const user = await userBrief(userId);
    if (!user) return { status: 404, error: 'User not found' };
    if (user.role !== C.MEMBER_ROLE) return { status: 403, error: 'members_only', message: 'Challenges are for member accounts.' };
    if (!m.force) {
      const acc = accessFor(user, ch);
      if (!acc.ok) return { status: 403, error: acc.reason, message: acc.message };
    }

    const tz = C.resolveTz(user.timezone, defaultTz);
    const today = C.todayIn(tz);
    const ref = await referralLookup(b.referral_code);
    const display = C.displayName(user.first_name, user.last_name);
    const ipHash = m.ip ? crypto.createHash('sha256').update('ch:' + m.ip).digest('hex').slice(0, 32) : null;

    // One transaction, one connection, always released (early answers included).
    const id = uuid();
    const shareToken = crypto.randomBytes(12).toString('base64url');
    let early = null;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['challenge-join:' + userId]);
      const dup = await client.query('SELECT id, challenge_id FROM challenge_enrollments WHERE user_id = $1 AND client_uuid = $2', [userId, clientUuid]);
      const act = dup.rows[0] ? { rows: [] } : await client.query("SELECT id, challenge_id FROM challenge_enrollments WHERE user_id = $1 AND status = 'active' LIMIT 1", [userId]);
      if (dup.rows[0]) {
        early = { status: 200, duplicate: true, enrollment_id: dup.rows[0].id, challenge_id: dup.rows[0].challenge_id };
      } else if (act.rows[0]) {
        early = act.rows[0].challenge_id === ch.id
          ? { status: 200, already: true, enrollment_id: act.rows[0].id, challenge_id: ch.id }
          : { status: 409, error: 'already_active', message: 'Finish or leave your current challenge first.', enrollment_id: act.rows[0].id };
      }
      if (!early && !m.force && ch.access === 'free') {
        const rep = await client.query(
          `SELECT (MAX(created_at) + INTERVAL '90 days') AS next_at FROM challenge_enrollments
            WHERE user_id = $1 AND challenge_id = $2 AND status <> 'void' AND created_at > NOW() - INTERVAL '90 days'`,
          [userId, ch.id]);
        if (rep.rows[0] && rep.rows[0].next_at) {
          const nx = new Date(rep.rows[0].next_at);
          early = { status: 409, error: 'repeat_too_soon', message: `You can take the ${ch.title} again from ${nx.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: tz })}.`, available_on: nx.toISOString() };
        }
      }
      if (!early && !m.force && ipHash) {
        const n = await client.query("SELECT COUNT(*)::int AS n FROM challenge_enrollments WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '1 day'", [ipHash]);
        if (n.rows[0] && n.rows[0].n >= 8) early = { status: 429, error: 'too_many_joins', message: 'Too many joins from this network today. Try again tomorrow.' };
      }
      if (early) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          `INSERT INTO challenge_enrollments (id, challenge_id, user_id, client_uuid, start_date, tz, display_name, leaderboard_opt_out,
              source, utm, referral_code, invited_by, share_token, ip_hash)
           VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
          [id, ch.id, userId, clientUuid, today, tz, display, !!b.leaderboard_opt_out,
            String(b.source || m.source || 'app').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'app',
            JSON.stringify(cleanUtm(b.utm)), ref ? ref.code : null,
            ref && ref.user_id && String(ref.user_id) !== String(userId) ? String(ref.user_id) : null,
            shareToken, ipHash]
        );
        await client.query('COMMIT');
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      if (err && err.code === '23505') {
        early = { retry: true };
      } else {
        client.release();
        throw err;
      }
    }
    client.release();
    if (early && early.retry) {
      const again = await queryOne('SELECT id, challenge_id FROM challenge_enrollments WHERE user_id = ? AND (client_uuid = ? OR (challenge_id = ? AND status = ?)) LIMIT 1', [userId, clientUuid, ch.id, 'active']);
      if (again) return { status: 200, duplicate: true, enrollment_id: again.id, challenge_id: again.challenge_id };
      return { status: 409, error: 'Could not join right now. Please try again.' };
    }
    if (early) return early;

    await audit(id, ch.id, m.actorId || userId, m.force ? 'staff_enrolled' : 'joined', m.force ? 'Enrolled by staff' : '');
    try {
      notifyAgent('CHALLENGE_JOINED', Object.assign(agentWho(user), {
        challenge: ch.title, challenge_id: ch.id, start_date: today,
        source: String(b.source || m.source || 'app').slice(0, 30), utm: cleanUtm(b.utm), referral_code: ref ? ref.code : ''
      }));
    } catch (_) { /* never blocks */ }
    // Evidence from earlier today (a check-in before joining) counts for Day 1.
    try { await sync(id); } catch (e2) { log.warn('[challenges] first sync:', e2.message); }
    return { status: 201, created: true, enrollment_id: id, challenge_id: ch.id };
  }

  async function leave(userId) {
    const r = await queryOne("UPDATE challenge_enrollments SET status = 'left', ended_at = NOW() WHERE user_id = ? AND status = 'active' RETURNING id, challenge_id", [userId]);
    if (r) await audit(r.id, r.challenge_id, userId, 'left', '');
    return r;
  }

  /* ------------------------------------------------------------- views */

  function taskAction(t) {
    const p = t.params || {};
    switch (t.kind) {
      case 'daily_checkin': case 'steps': case 'water': case 'sleep': return { type: 'checkin', label: 'Check in' };
      case 'protein_target': case 'meals_logged': return { type: 'meal', label: 'Log meal' };
      case 'coach_workout': return { type: 'coach', label: 'Start', area: p.area || 'full' };
      case 'workout_any': return { type: 'workout', label: 'Start' };
      case 'mind_checkin': return { type: 'mind', label: 'Open' };
      case 'sunday_checkin': return { type: 'sunday', label: 'Open' };
      default: return null;
    }
  }
  const AREA_LONG = { upper: 'Upper body', lower: 'Lower body', core: 'Core', full: 'Full body' };
  function taskSub(t) {
    const p = t.params || {};
    if (t.kind === 'coach_workout') return `${AREA_LONG[p.area] || 'Full body'}${p.exercises ? ' · ' + p.exercises + ' exercises' : ''}`;
    return '';
  }
  function progressLabel(kind, pr) {
    if (!pr) return '';
    if (kind === 'protein_target') return `${pr.value} of ${pr.target} g so far`;
    if (kind === 'meals_logged') return `${pr.value} of ${pr.target} meals`;
    if (kind === 'steps') return `${Number(pr.value).toLocaleString('en-IN')} of ${Number(pr.target).toLocaleString('en-IN')} steps`;
    if (kind === 'water') return `${(pr.value / 1000).toFixed(1)} of ${(pr.target / 1000).toFixed(1)} L`;
    if (kind === 'sleep') return `${pr.value || 0} of ${pr.target} h`;
    if (kind === 'coach_workout' || kind === 'workout_any') return pr.value ? `${pr.value} of ${pr.target} min` : '';
    return '';
  }

  /** Day view for the member (live progress for today, stored state for other days). */
  async function dayView(enrollmentId, opts) {
    const o = opts || {};
    const out = await sync(enrollmentId, o);
    if (!out) return null;
    const e = out.enrollment;
    const ch = out.challenge;
    const tz = C.resolveTz(e.tz, defaultTz);
    const nowMs = o.nowMs == null ? Date.now() : o.nowMs;
    const today = C.todayIn(tz, nowMs);
    const todayDay = C.dayNumberOf(e.start_date, today);
    const len = ch.length_days;
    const comps = await completionsOf(e.id);
    const st = doneDaysFrom(ch, comps);
    const viewDay = Math.max(1, Math.min(len, Number(o.day) || Math.min(todayDay, len)));
    const ymd = C.dateOfDay(e.start_date, viewDay);
    const compByTask = new Map(comps.map((c) => [c.task_id, c]));

    // Live evidence only for the open day being viewed (progress bars).
    let live = null;
    if (e.status === 'active' && viewDay === todayDay) {
      const zone = await naiveZone();
      const rows = await fetchRows(e.user_id, ymd, ymd);
      live = C.evaluateDay(tasksOfDay(ch, viewDay), C.dayEvidence(rows, ymd, tz, zone), await goalsFor(e.user_id));
    }
    const liveBy = new Map(live ? live.results.map((r) => [r.task.id, r]) : []);

    const tasks = tasksOfDay(ch, viewDay).map((t) => {
      const c = compByTask.get(t.id);
      const ev = c ? parseJson(c.evidence, {}) : {};
      const lr = liveBy.get(t.id);
      const pr = lr && lr.progress ? lr.progress : null;
      return {
        id: t.id, kind: t.kind, title: t.title, sub: taskSub(t), points: t.points,
        done: !!c,
        done_label: c ? `Done ${C.localTimeLabel(ev.at != null ? Number(ev.at) : Date.parse(c.completed_at), tz)}` : '',
        progress: pr ? { value: pr.value, target: pr.target, unit: pr.unit, pct: pr.target > 0 ? Math.max(0, Math.min(1, pr.value / pr.target)) : 0, label: progressLabel(t.kind, pr) } : null,
        action: c ? null : taskAction(t)
      };
    });
    const days = [];
    for (let d = 1; d <= len; d++) {
      let s = 'upcoming';
      if (st.doneDays.has(d)) s = 'done';
      else if (d < todayDay || e.status !== 'active') s = d <= Math.min(todayDay, len) ? 'missed' : 'upcoming';
      else if (d === todayDay) s = (st.byDay.get(d) || new Set()).size ? 'partial' : 'today';
      days.push({ day: d, date: C.dateOfDay(e.start_date, d), state: s, title: ch.day_titles[d - 1] || '' });
    }
    const minDays = C.minDaysFor(ch);
    const doneToday = tasks.filter((t) => t.done).length;
    return {
      enrollment: {
        id: e.id, status: e.status, start_date: e.start_date, end_date: C.dateOfDay(e.start_date, len), tz,
        day: Math.max(1, Math.min(todayDay, len)), today_day: todayDay, view_day: viewDay, length: len,
        days_done: st.doneDays.size, points: st.points, min_days: minDays,
        grace_left: C.graceLeft({ length: len, minDays, todayDay, doneDays: st.doneDays }),
        streak: C.challengeStreak(st.doneDays, Math.min(todayDay, len)),
        leaderboard_opt_out: !!e.leaderboard_opt_out, share_results: !!e.share_results,
        completed_at: e.completed_at || null
      },
      challenge: C.publicChallenge(ch),
      today: {
        day: viewDay, date: ymd, tasks, done: doneToday, total: tasks.length,
        all_done: tasks.length > 0 && doneToday === tasks.length,
        coins_on_done: C.COIN_RULES.CHALLENGE_DAY,
        next_day_title: viewDay < len ? (ch.day_titles[viewDay] || '') : ''
      },
      days,
      newly_done_days: out.newlyDoneDays || []
    };
  }

  /* ------------------------------------------------------------- board */

  async function leaderboard(challengeId, userId, limit) {
    const ch = await queryOne('SELECT id, length_days FROM challenges WHERE id = ?', [String(challengeId)]);
    if (!ch) return null;
    const windowDays = Number(ch.length_days) + 7;
    const rows = await queryAll(
      `SELECT e.id, e.user_id, e.status, e.points, e.days_done, e.completed_at, e.created_at, e.display_name,
              e.leaderboard_opt_out, u.role, (EXTRACT(EPOCH FROM u.created_at AT TIME ZONE current_setting('TimeZone')) * 1000)::float8 AS user_created_ms,
              u.first_name, u.last_name
         FROM challenge_enrollments e JOIN users u ON u.id = e.user_id
        WHERE e.challenge_id = ? AND e.status IN ('active','completed')
          AND e.start_date >= (CURRENT_DATE - ?::int)
        ORDER BY e.points DESC LIMIT 2000`,
      [ch.id, windowDays]
    );
    const ranked = C.rankBoard(rows);
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const shape = (r) => {
      const name = r.display_name || C.displayName(r.first_name, r.last_name);
      return { rank: r.rank, name, initials: C.initials(name), days_done: Number(r.days_done) || 0, of: Number(ch.length_days), points: Number(r.points) || 0, me: String(r.user_id) === String(userId), completed: r.status === 'completed' };
    };
    const top = ranked.slice(0, lim).map(shape);
    let me = null;
    const mine = rows.filter((r) => String(r.user_id) === String(userId)).sort((a, b) => (b.status === 'active') - (a.status === 'active'))[0];
    if (mine) {
      const r = ranked.find((x) => x.id === mine.id);
      if (r) me = shape(r);
      else me = { rank: null, name: 'You', initials: 'ME', days_done: Number(mine.days_done) || 0, of: Number(ch.length_days), points: Number(mine.points) || 0, me: true, hidden: true, reason: mine.leaderboard_opt_out ? 'opted_out' : 'new_account' };
    }
    return { challenge_id: ch.id, total: ranked.length, top, me };
  }

  /* ------------------------------------------------------------- results */

  /** Results for the certificate, share card and completion screen. */
  async function results(enrollmentId) {
    const e = await queryOne('SELECT *, start_date::text AS start_date FROM challenge_enrollments WHERE id = ?', [enrollmentId]);
    if (!e) return null;
    const ch = await loadChallenge(e.challenge_id);
    const tz = C.resolveTz(e.tz, defaultTz);
    const len = ch.length_days;
    const endYmd = C.dateOfDay(e.start_date, len);
    const zone = await naiveZone();
    const rows = await fetchRows(e.user_id, e.start_date, endYmd);
    const goals = await goalsFor(e.user_id);
    let checkins = 0;
    let sessions = 0;
    let sets = 0;
    let otherWorkouts = 0;
    let proteinDays = 0;
    const steps = [];
    for (let d = 1; d <= len; d++) {
      const ymd = C.dateOfDay(e.start_date, d);
      const ev = C.dayEvidence(rows, ymd, tz, zone);
      if (ev.checkin) checkins += 1;
      if (ev.checkin && ev.checkin.steps != null && ev.checkin.steps > 0) steps.push(ev.checkin.steps);
      ev.coach.forEach((w) => { sessions += 1; sets += w.total_sets || 0; });
      // My Workout sessions (Coach Mode mirrors excluded: they are counted above).
      otherWorkouts += ev.workouts.filter((w) => w.type !== 'coach_mode' && w.duration_seconds >= C.MIN_WORKOUT_SECONDS).length;
      if (C.evaluateTask({ kind: 'protein_target', params: { pct: 90 } }, ev, goals).done) proteinDays += 1;
    }
    const coinRow = await queryOne(
      "SELECT COALESCE(SUM(coins_delta), 0)::int AS n FROM coin_ledger WHERE user_id = ? AND event_key LIKE ?",
      [e.user_id, `coins:challenge:${e.id}:%`]
    ).catch(() => ({ n: 0 }));
    const u = await userBrief(e.user_id);
    return {
      enrollment: e,
      challenge: ch,
      name: `${(u && u.first_name) || ''} ${(u && u.last_name) || ''}`.trim() || e.display_name || 'Member',
      display_name: e.display_name || C.displayName(u && u.first_name, u && u.last_name),
      start_date: e.start_date,
      end_date: endYmd,
      days_done: Number(e.days_done) || 0,
      length: len,
      points: Number(e.points) || 0,
      stats: {
        checkins, sessions, sets, workouts: sessions + otherWorkouts, protein_days: proteinDays,
        avg_steps: steps.length ? Math.round(steps.reduce((a, b) => a + b, 0) / steps.length) : null,
        coins: coinRow ? Number(coinRow.n) || 0 : 0
      }
    };
  }

  async function rewardsOf(userId) {
    const rows = await queryAll(
      `SELECT r.kind, r.reward_key, r.payload, r.created_at, r.enrollment_id, e.challenge_id, c.title
         FROM challenge_rewards r JOIN challenge_enrollments e ON e.id = r.enrollment_id JOIN challenges c ON c.id = e.challenge_id
        WHERE r.user_id = ? AND r.status = 'granted' ORDER BY r.created_at DESC LIMIT 200`, [userId]);
    const disc = await queryAll('SELECT id, enrollment_id, pct, applies_to, expires_at, used_at FROM challenge_discounts WHERE user_id = ? ORDER BY expires_at DESC', [userId]);
    const lm = await queryAll('SELECT enrollment_id, status, preferred_slot, created_at FROM challenge_lm_requests WHERE user_id = ?', [userId]);
    return {
      badges: rows.filter((r) => r.kind === 'badge').map((r) => Object.assign({ challenge: r.title, enrollment_id: r.enrollment_id, at: r.created_at }, parseJson(r.payload, {}))),
      certificates: rows.filter((r) => r.kind === 'certificate').map((r) => ({ challenge: r.title, enrollment_id: r.enrollment_id, at: r.created_at })),
      coins: rows.filter((r) => r.kind === 'coins_day' || r.kind === 'coins_complete').reduce((a, r) => a + (Number(parseJson(r.payload, {}).coins) || 0), 0),
      discounts: disc.map((d) => ({ enrollment_id: d.enrollment_id, pct: d.pct, applies_to: C.asArray(d.applies_to), expires_at: d.expires_at, used: !!d.used_at, usable: !d.used_at && new Date(d.expires_at).getTime() > Date.now() })),
      lm_calls: lm,
      lm_offers: rows.filter((r) => r.kind === 'lm_call').map((r) => r.enrollment_id)
    };
  }

  /* ------------------------------------------------------------- LM call */

  async function requestLmCall(userId, enrollmentId, body) {
    const b = body || {};
    const e = await queryOne("SELECT e.id, e.user_id, e.challenge_id, e.status, c.title FROM challenge_enrollments e JOIN challenges c ON c.id = e.challenge_id WHERE e.id = ? AND e.user_id = ?", [enrollmentId, userId]);
    if (!e) return { status: 404, error: 'Challenge not found' };
    const offer = await queryOne("SELECT 1 AS ok FROM challenge_rewards WHERE enrollment_id = ? AND kind = 'lm_call'", [e.id]);
    if (e.status !== 'completed' || !offer) return { status: 409, error: 'not_eligible', message: 'The lifestyle manager call unlocks when you finish the challenge.' };
    const slot = String(b.preferred_slot || '').trim().slice(0, 60);
    if (!['morning', 'afternoon', 'evening'].includes(slot)) return { status: 400, error: 'Pick a time of day', errors: { preferred_slot: 'morning, afternoon or evening' } };
    const phone = b.phone == null ? null : String(b.phone).replace(/[^\d+]/g, '').slice(0, 16);
    if (phone && phone.replace(/\D/g, '').length < 8) return { status: 400, error: 'Enter a valid phone number', errors: { phone: 'too short' } };
    const ins = await run(
      'INSERT INTO challenge_lm_requests (id, enrollment_id, user_id, phone, preferred_slot) VALUES (?, ?, ?, ?, ?) ON CONFLICT (enrollment_id) DO NOTHING',
      [uuid(), e.id, userId, phone, slot]
    );
    const row = await queryOne('SELECT status, preferred_slot, created_at FROM challenge_lm_requests WHERE enrollment_id = ?', [e.id]);
    if (ins && ins.rowCount) {
      const u = await userBrief(userId);
      try { notifyAgent('CHALLENGE_LM_CALL_REQUESTED', Object.assign(agentWho(u), { mobile: phone || (u && u.phone) || '—', challenge: e.title, challenge_id: e.challenge_id, preferred_slot: slot })); } catch (_) { /* ignore */ }
      if (notifyHub) {
        notifyHub.staff({
          title: '📞 Challenge call requested',
          body: `${agentWho(u).name || 'A member'} finished the ${e.title} and wants a call (${slot}).`,
          type: 'challenge', link: 'challenges', tag: 'challenge-lm-' + e.id
        });
      }
      await audit(e.id, e.challenge_id, userId, 'lm_call_requested', slot);
      return { status: 201, created: true, request: row };
    }
    return { status: 200, duplicate: true, request: row };
  }

  /* ------------------------------------------------- discounts (web checkout) */

  /** The member's usable discount for a tier, or null. Payments call this. */
  async function discountFor(user, tier) {
    if (!user || user.role !== C.MEMBER_ROLE) return null;
    if (flagCfg().mode === 'off') return null;
    const rows = await safeAll(
      'SELECT * FROM challenge_discounts WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY pct DESC, expires_at ASC', [String(user.id)]);
    return rows.find((d) => C.discountUsable(d, tier)) || null;
  }
  async function attachOrder(orderId, discount, userId, originalPaise, discountedPaise) {
    await run(
      'INSERT INTO challenge_discount_orders (order_id, discount_id, user_id, original_paise, discounted_paise) VALUES (?, ?, ?, ?, ?) ON CONFLICT (order_id) DO NOTHING',
      [orderId, discount.id, String(userId), originalPaise, discountedPaise]
    );
  }
  /** After a verified, fulfilled payment. Idempotent on the discount (first paid order wins). */
  async function markOrderPaid(orderId, paymentId) {
    const o = await queryOne('SELECT discount_id FROM challenge_discount_orders WHERE order_id = ?', [String(orderId)]).catch(() => null);
    if (!o) return false;
    const r = await run('UPDATE challenge_discounts SET used_at = NOW(), used_payment_id = ? WHERE id = ? AND used_at IS NULL', [paymentId || null, o.discount_id]);
    return !!(r && r.rowCount);
  }

  return {
    naiveZone,
    loadChallenge,
    fetchRows,
    sync,
    onActivity,
    syncUser,
    runCron,
    maybeRemind,
    accessFor,
    join,
    leave,
    dayView,
    leaderboard,
    results,
    rewardsOf,
    requestLmCall,
    discountFor,
    attachOrder,
    markOrderPaid,
    audit,
    origin
  };
}

module.exports = { createChallengeEngine };
