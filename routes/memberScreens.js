'use strict';

/**
 * Member screens API — mounted at /api/me/screens.
 *
 *   GET  /streak?month=YYYY-MM   Daily Streak screen
 *   GET  /mind                   Mind check-in (co-powered by Beyond The Body)
 *   POST /mind/mood              save today's mood and/or stress (1-5 each)
 *   GET  /performance?end=YMD    two-week performance report
 *   GET  /blood/:reportId        graded view of one blood report
 *   GET  /membership             My Membership (plan, term, included, allowances, care team)
 *
 * Read-only apart from /mind/mood. Every route is the member's own data
 * (req.user.id); nothing here takes a user id from the client. The pure logic
 * lives in services/memberScreens.js.
 */

const express = require('express');
const S = require('../services/memberScreens');
const plans = require('../services/plans');
const coinService = require('../services/coinService');
const grading = require('../services/grading');

const MIND_EXERCISES = [
  { key: 'box_breathing', title: 'Box Breathing', sub: 'Inhale 4s, hold 4s, exhale 4s', icon: 'breath' },
  { key: 'yoga_flow', title: 'Morning Yoga Flow', sub: '15 min · mobility and breath', icon: 'yoga', feature: 'ai_trainer' },
  { key: 'body_scan', title: 'Body Scan', sub: 'Notice sensations head to toe', icon: 'scan' },
  { key: 'grounding_54321', title: '5 4 3 2 1 Grounding', sub: 'See, touch, hear, smell, taste', icon: 'ground' }
];

function num(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; }
function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function createMemberScreensRouter(deps) {
  const { queryOne, queryAll, run, verifyToken, rateLimiter, todayInTz, defaultTz } = deps;
  const router = express.Router();
  router.use(verifyToken);

  async function userContext(userId) {
    const u = await queryOne(
      'SELECT id, role, first_name, gender, timezone, created_at, plan_tier, subscription_status, access_expires_at, goal_sleep_hours, fortnight_report_enabled FROM users WHERE id = ?',
      [userId]
    );
    if (!u) return null;
    const tz = u.timezone || defaultTz;
    const today = todayInTz(tz) || new Date().toISOString().slice(0, 10);
    return { u, tz, today };
  }

  // ── Daily Streak ───────────────────────────────────────────────────────────
  router.get('/streak', async (req, res) => {
    try {
      const ctx = await userContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const { u, today } = ctx;
      const rows = await queryAll(
        `SELECT checkin_date, COALESCE(is_freeze, FALSE) AS is_freeze
           FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 800`,
        [u.id]
      );
      const all = new Set(); const freezes = new Set(); const real = new Set();
      (rows || []).forEach((r) => {
        const d = S.toYmd(r.checkin_date);
        if (!d) return;
        all.add(d);
        if (r.is_freeze === true || r.is_freeze === 't') freezes.add(d); else real.add(d);
      });
      const runNow = S.currentRun(all, today);
      const best = Math.max(S.bestRun(all), runNow.length);
      const ym = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : today.slice(0, 7);
      const joined = S.toYmd(u.created_at);
      const cal = S.monthCalendar(ym, real, freezes, today, joined);
      const thisMonth = today.slice(0, 7);
      const usedThisMonth = Array.from(freezes).filter((d) => d.slice(0, 7) === thisMonth).length;
      let coins = null;
      try {
        const cs = await coinService.getCoinSummary({ run, queryOne, queryAll }, u.id);
        coins = cs && cs.balance != null ? Number(cs.balance) : null;
      } catch (_) { coins = null; }
      const ms = S.milestonesFor(runNow.length);
      res.json({
        first_name: u.first_name || '',
        today,
        streak: runNow.length,
        today_saved: runNow.todaySaved,
        at_risk: !runNow.todaySaved && runNow.length > 0,
        best,
        is_personal_best: runNow.length > 0 && runNow.length >= best,
        freezes: { per_month: S.FREEZES_PER_MONTH, used: usedThisMonth, left: Math.max(0, S.FREEZES_PER_MONTH - usedThisMonth) },
        coins,
        milestones: ms.items,
        next_milestone: ms.next,
        coins_unlocked_this_run: ms.items.filter((m) => m.reached).reduce((s, m) => s + m.coins, 0),
        calendar: cal,
        can_go_next: cal ? cal.next <= thisMonth : false,
        can_go_prev: cal && joined ? cal.prev >= joined.slice(0, 7) : true
      });
    } catch (e) {
      console.error('[screens streak]', e.message);
      res.status(500).json({ error: 'Could not load your streak' });
    }
  });

  // ── Mind check-in ──────────────────────────────────────────────────────────
  router.get('/mind', async (req, res) => {
    try {
      const ctx = await userContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const { u, today } = ctx;
      const since = S.addDays(today, -90);
      const [mindRows, moodRow, sleepRows, readiness] = await Promise.all([
        queryAll('SELECT exercise_key, checkin_date FROM mind_checkins WHERE user_id = ? AND checkin_date >= ?::date', [u.id, since]),
        queryOne('SELECT mood, stress FROM mind_moods WHERE user_id = ? AND mood_date = ?::date', [u.id, today]).catch(() => null),
        queryAll(
          `SELECT checkin_date, sleep_hours FROM daily_checkins
            WHERE user_id = ? AND checkin_date >= ?::date AND COALESCE(is_freeze, FALSE) = FALSE AND sleep_hours IS NOT NULL`,
          [u.id, S.addDays(today, -6)]
        ),
        queryOne(
          `SELECT date, sleep_hours, sleep_performance_pct, sleep_efficiency_pct FROM readiness_daily
            WHERE user_id = ? AND date >= ?::date AND (sleep_performance_pct IS NOT NULL OR sleep_efficiency_pct IS NOT NULL)
            ORDER BY date DESC LIMIT 1`,
          [u.id, S.addDays(today, -2)]
        ).catch(() => null)
      ]);
      const mindDates = new Set(); const doneToday = new Set();
      (mindRows || []).forEach((r) => {
        const d = S.toYmd(r.checkin_date);
        if (!d) return;
        mindDates.add(d);
        if (d === today) doneToday.add(r.exercise_key);
      });
      // Today's mood or stress answer counts as a mindful moment too.
      if (moodRow && (moodRow.mood != null || moodRow.stress != null)) mindDates.add(today);
      const sleepByDate = new Map();
      (sleepRows || []).forEach((r) => { const d = S.toYmd(r.checkin_date); const h = num(r.sleep_hours); if (d && h != null) sleepByDate.set(d, h); });
      const sleep = S.sleepWeek(sleepByDate, today);
      const tier = plans.tierOf(u);
      const quality = readiness && plans.tierHasFeature(tier, 'wearables')
        ? Math.round(num(readiness.sleep_performance_pct) != null ? num(readiness.sleep_performance_pct) : num(readiness.sleep_efficiency_pct))
        : null;
      const mood = moodRow ? S.validMood(moodRow.mood) : null;
      const stress = moodRow ? S.validMood(moodRow.stress) : null;
      res.json({
        first_name: u.first_name || '',
        today,
        mood,
        mood_label: mood ? S.moodLabel(mood) : null,
        stress,
        stress_label: stress ? S.stressLabel(stress) : null,
        moods: S.MOODS,
        stress_levels: S.STRESS,
        sleep: Object.assign({}, sleep, { quality_pct: Number.isFinite(quality) ? quality : null }),
        mind_streak: S.mindStreak(mindDates, today),
        exercises: MIND_EXERCISES.map((x) => ({
          key: x.key,
          title: x.title,
          sub: x.sub,
          icon: x.icon,
          feature: x.feature || null,
          locked: x.feature ? !plans.tierHasFeature(tier, x.feature) : false,
          done_today: doneToday.has(x.key)
        }))
      });
    } catch (e) {
      console.error('[screens mind]', e.message);
      res.status(500).json({ error: 'Could not load your mind check-in' });
    }
  });

  router.post('/mind/mood', rateLimiter(30, 60000), async (req, res) => {
    try {
      const b = req.body || {};
      const hasMood = b.mood !== undefined && b.mood !== null;
      const hasStress = b.stress !== undefined && b.stress !== null;
      const mood = hasMood ? S.validMood(b.mood) : null;
      const stress = hasStress ? S.validMood(b.stress) : null;
      if ((hasMood && !mood) || (hasStress && !stress) || (!hasMood && !hasStress)) {
        return res.status(400).json({ error: 'Pick a mood or stress level from 1 to 5.' });
      }
      const ctx = await userContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const { u, today } = ctx;
      await run(
        `INSERT INTO mind_moods (user_id, mood_date, mood, stress, updated_at)
         VALUES (?, ?::date, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, mood_date) DO UPDATE SET
           mood = COALESCE(EXCLUDED.mood, mind_moods.mood),
           stress = COALESCE(EXCLUDED.stress, mind_moods.stress),
           updated_at = CURRENT_TIMESTAMP`,
        [u.id, today, mood, stress]
      );
      const row = await queryOne('SELECT mood, stress FROM mind_moods WHERE user_id = ? AND mood_date = ?::date', [u.id, today]);
      const m = row ? S.validMood(row.mood) : null;
      const s = row ? S.validMood(row.stress) : null;
      res.json({ mood: m, mood_label: m ? S.moodLabel(m) : null, stress: s, stress_label: s ? S.stressLabel(s) : null });
    } catch (e) {
      console.error('[screens mood]', e.message);
      res.status(500).json({ error: 'Could not save that. Please try again.' });
    }
  });

  // ── Two-week performance report ────────────────────────────────────────────
  // Members see it only once their coach has switched it on
  // (users.fortnight_report_enabled). Staff can open any member's report with
  // ?user=<id> — that is the admin "Preview" before switching it on.
  router.get('/performance', async (req, res) => {
    try {
      const isStaff = ['admin', 'superadmin', 'operator'].includes(req.user.role);
      const targetId = isStaff && req.query.user ? String(req.query.user) : req.user.id;
      const ctx = await userContext(targetId);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const { u, today } = ctx;
      if (!isStaff && !(u.fortnight_report_enabled === true || u.fortnight_report_enabled === 't')) {
        return res.status(403).json({ error: 'report_locked', message: 'Your coach will switch on your 2-week report.' });
      }
      let end = S.isYmd(req.query.end) ? String(req.query.end) : today;
      if (S.dayNum(end) > S.dayNum(today)) end = today;
      const joined = S.toYmd(u.created_at);
      const start = S.addDays(end, -13);
      const reportData = require('../services/reportData');
      const reportScore = require('../services/reportScore');
      const bundle = await reportData.loadReportBundle(u.id, start, end, 'weekly');
      const score = reportScore.scoreDataset(bundle.current, bundle.previous, bundle.previous2, 'weekly');
      const out = S.performanceView({ bundle, score, start, end, goalSleep: num(u.goal_sleep_hours) });

      // Mind: mood + stress answers and mind-exercise days inside the fortnight.
      const [moodRows, mindRows] = await Promise.all([
        queryAll('SELECT mood_date, mood, stress FROM mind_moods WHERE user_id = ? AND mood_date BETWEEN ?::date AND ?::date', [u.id, start, end]).catch(() => []),
        queryAll('SELECT DISTINCT checkin_date FROM mind_checkins WHERE user_id = ? AND checkin_date BETWEEN ?::date AND ?::date', [u.id, start, end]).catch(() => [])
      ]);
      out.mind = S.mindSummary(moodRows || [], (mindRows || []).length);

      // Recovery from a wearable — Tribe Elite only, and only when measured.
      if (!plans.tierHasFeature(plans.tierOf(u), 'wearables')) out.recovery = null;

      // Coach note: the closing note of the latest report staff actually SENT that
      // covers this fortnight — never an unsent draft.
      out.coach_note = null;
      try {
        const rep = await queryOne(
          `SELECT edits_json, insights_json FROM reports
            WHERE user_id = ? AND sent_at IS NOT NULL AND period_end >= ?::date AND period_start <= ?::date
            ORDER BY period_end DESC, generated_at DESC LIMIT 1`,
          [u.id, S.addDays(start, -3), end]
        );
        if (rep) {
          const ed = parseJson(rep.edits_json) || {};
          const ins = parseJson(rep.insights_json) || {};
          const note = String(ed.closingNote || ins.closingNote || '').trim();
          if (note) out.coach_note = note.length > 500 ? note.slice(0, 497) + '…' : note;
        }
      } catch (_) { out.coach_note = null; }

      out.first_name = u.first_name || '';
      out.can_go_back = !joined || S.dayNum(start) > S.dayNum(joined);
      out.preview = isStaff && targetId !== req.user.id;
      res.json(out);
    } catch (e) {
      console.error('[screens performance]', e.message);
      res.status(500).json({ error: 'Could not build your report' });
    }
  });

  // ── My Membership ──────────────────────────────────────────────────────────
  // Plan, term, what is included, allowances and the care team. No prices and no
  // purchase links: this payload reaches the iOS / Android apps (store rules).
  router.get('/membership', async (req, res) => {
    try {
      const ctx = await userContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const { u, today } = ctx;
      const full = await queryOne(
        `SELECT plan_label, activated_at,
                COALESCE(nutrition_ai_unlimited, TRUE) AS nut_unlimited,
                COALESCE(nutrition_ai_meal_limit, 0)::int AS nut_limit,
                COALESCE(nutrition_ai_meal_used, 0)::int AS nut_used,
                COALESCE(ai_trainer_unlimited, TRUE) AS trn_unlimited,
                COALESCE(ai_trainer_trial_limit, 0)::int AS trn_limit,
                COALESCE(ai_trainer_trial_used, 0)::int AS trn_used
           FROM users WHERE id = ?`, [u.id]);
      const plan = plans.planForUser(u);
      const catalog = plans.featureCatalog();
      const rank = plans.tierRank(plan.tier);

      // Term: from activation (or joining, for a first trial) to the expiry date.
      const startYmd = S.toYmd(full && full.activated_at) || S.toYmd(u.created_at);
      const endYmd = plan.expires_at ? plan.expires_at.slice(0, 10) : null;
      let term = null;
      // A trial has no recorded start (it can be extended from the admin console),
      // so it gets its end date and days left — never a guessed progress bar.
      if (plan.state !== 'trialing' && startYmd && endYmd && S.dayNum(endYmd) > S.dayNum(startYmd)) {
        const total = S.dayNum(endYmd) - S.dayNum(startYmd);
        const day = Math.max(1, Math.min(total, S.dayNum(today) - S.dayNum(startYmd) + 1));
        term = { start: startYmd, end: endYmd, total_days: total, day };
      }

      // Features grouped by the plan that first includes them.
      const groups = catalog.order.map((t) => ({
        tier: t,
        name: catalog.tiers[t],
        included: plans.tierRank(t) <= rank,
        features: Object.keys(catalog.features).filter((f) => catalog.features[f].tier === t).map((f) => ({ key: f, label: catalog.features[f].label }))
      }));

      // Allowances: only for features this plan actually has.
      const bloodCount = await queryOne('SELECT COUNT(*)::int AS c FROM blood_analysis_reports WHERE user_id = ?', [u.id]).catch(() => ({ c: 0 }));
      const allowances = [];
      if (plan.features.includes('blood_reports')) allowances.push({ key: 'blood_reports', label: 'Blood reports', used: bloodCount ? bloodCount.c : 0, limit: 3, unlimited: false });
      if (full) {
        allowances.push({ key: 'meal_snap', label: 'AI meal snaps', used: full.nut_used, limit: full.nut_limit, unlimited: !!full.nut_unlimited });
        if (plan.features.includes('ai_trainer')) allowances.push({ key: 'ai_trainer', label: 'AI Trainer sessions', used: full.trn_used, limit: full.trn_limit, unlimited: !!full.trn_unlimited });
      }

      // Care team: the people in the member's care group.
      let care = { group_id: null, people: [] };
      try {
        const g = await queryOne(
          `SELECT id FROM chat_groups WHERE client_id = ? AND COALESCE(archived, FALSE) = FALSE ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [u.id]);
        if (g) {
          const ppl = await queryAll(
            `SELECT m.group_role, u2.first_name, u2.last_name
               FROM chat_group_members m JOIN users u2 ON u2.id = m.user_id
              WHERE m.group_id = ? AND m.removed_at IS NULL AND m.group_role IN ('doctor', 'lifestyle_manager')
              ORDER BY CASE m.group_role WHEN 'lifestyle_manager' THEN 0 ELSE 1 END, u2.first_name`, [g.id]);
          const ROLE = { lifestyle_manager: 'Lifestyle Manager', doctor: 'Doctor' };
          care = {
            group_id: g.id,
            people: (ppl || []).map((p) => ({
              role: ROLE[p.group_role] || 'Coach',
              name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || ROLE[p.group_role] || 'Coach'
            }))
          };
        }
      } catch (_) { /* chat tables are optional on older installs */ }

      res.json({
        first_name: u.first_name || '',
        member_since: S.toYmd(u.created_at),
        today,
        plan: Object.assign({}, plan, { label: (full && full.plan_label) || '' }),
        term,
        groups,
        allowances,
        care,
        can_message: plan.features.includes('coach_chat')
      });
    } catch (e) {
      console.error('[screens membership]', e.message);
      res.status(500).json({ error: 'Could not load your membership' });
    }
  });

  // ── Blood grades ───────────────────────────────────────────────────────────
  router.get('/blood/:reportId', async (req, res) => {
    try {
      const ctx = await userContext(req.user.id);
      if (!ctx) return res.status(404).json({ error: 'User not found' });
      const { u } = ctx;
      const isStaff = ['admin', 'superadmin', 'operator'].includes(req.user.role);
      const row = await queryOne('SELECT * FROM blood_analysis_reports WHERE id = ?', [String(req.params.reportId || '')]);
      if (!row || (!isStaff && String(row.user_id) !== String(u.id))) return res.status(404).json({ error: 'Report not found' });
      // Members see grades only once their coach has reviewed and sent the report.
      if (!isStaff && (!(row.sent_to_user === true || row.sent_to_user === 't') || String(row.status || '').toLowerCase() !== 'complete')) {
        return res.status(409).json({ error: 'in_review', message: 'Your coach is reviewing this report. You will get a notification when it is ready.' });
      }
      const extracted = parseJson(row.extracted_blood_data);
      if (!extracted || !Array.isArray(extracted.panels) || !extracted.panels.length) {
        return res.status(409).json({ error: 'not_ready', message: 'This report is still being processed.' });
      }
      const client = await queryOne('SELECT gender FROM users WHERE id = ?', [row.user_id]);
      const graded = grading.gradeExtractedReport(extracted, { sex: (client && client.gender) || '' });
      const view = S.bloodGradesView(graded);

      // "Blood Report N": its position on the member's own timeline.
      const list = await queryAll(
        `SELECT id FROM blood_analysis_reports WHERE user_id = ?
          ORDER BY COALESCE(report_date, created_at::date) ASC, created_at ASC`,
        [row.user_id]
      );
      const idx = (list || []).findIndex((r) => String(r.id) === String(row.id));

      // Who "Talk to a Doctor / Nutritionist" can reach: the member's care group.
      let care = { group_id: null, has_doctor: false, has_nutritionist: false };
      try {
        const g = await queryOne(
          `SELECT g.id,
                  BOOL_OR(m.group_role = 'doctor' AND m.removed_at IS NULL) AS has_doctor,
                  BOOL_OR(m.group_role = 'lifestyle_manager' AND m.removed_at IS NULL) AS has_lm
             FROM chat_groups g
             JOIN chat_group_members m ON m.group_id = g.id
            WHERE g.client_id = ? AND COALESCE(g.archived, FALSE) = FALSE
            GROUP BY g.id, g.last_message_at
            ORDER BY g.last_message_at DESC NULLS LAST LIMIT 1`,
          [row.user_id]
        );
        if (g) care = { group_id: g.id, has_doctor: !!g.has_doctor, has_nutritionist: !!g.has_lm };
      } catch (_) { /* chat tables are optional on older installs */ }

      res.json(Object.assign({
        report_id: row.id,
        title: 'Blood Report ' + (idx >= 0 ? idx + 1 : ''),
        report_date: S.toYmd(row.report_date) || S.toYmd(row.created_at),
        care
      }, view));
    } catch (e) {
      console.error('[screens blood]', e.message);
      res.status(500).json({ error: 'Could not load this report' });
    }
  });

  return router;
}

module.exports = { createMemberScreensRouter, momentumLine: S.momentumLine, MIND_EXERCISES };
