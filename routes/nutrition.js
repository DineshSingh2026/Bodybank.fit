'use strict';

const { v4: uuidv4 } = require('uuid');
const userEmail = require('../services/userEmailService');
const nutritionService = require('../services/nutritionService');

const {
  MEAL_TYPES,
  computeMealScore,
  callClaudeNutrition,
  normalizeAiResult,
  classifyMealConfidence,
  summarizeDailyConfidence,
  recomputeDailyStats,
  countMealsForDay,
  nutritionLoggingStreak,
  todayYmdInTz,
  STREAK_TZ
} = nutritionService;

const MAX_B64_CHARS = 6 * 1024 * 1024;

function ymdOrToday(body, query) {
  const raw = (body && body.date) || (query && query.date) || '';
  const s = String(raw).trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
}

async function buildWeeklyNutritionSummary(db, userId, endYmd) {
  const rows = await db.queryAll(
    `SELECT stat_date, total_calories, total_protein, meal_quality_score, energy_difference
     FROM nutrition_daily_stats
     WHERE user_id = ? AND stat_date >= (?::date - INTERVAL '6 days') AND stat_date <= ?::date
     ORDER BY stat_date ASC`,
    [userId, endYmd, endYmd]
  );
  const list = rows || [];
  const len = list.length;
  const avgCal = len ? Math.round(list.reduce((s, r) => s + (parseInt(r.total_calories, 10) || 0), 0) / len) : 0;
  const avgPro = len ? Math.round(list.reduce((s, r) => s + (parseInt(r.total_protein, 10) || 0), 0) / len) : 0;
  const avgScore = len
    ? (list.reduce((s, r) => s + (parseFloat(r.meal_quality_score) || 0), 0) / len).toFixed(1)
    : '0.0';
  const avgEn = len ? Math.round(list.reduce((s, r) => s + (parseInt(r.energy_difference, 10) || 0), 0) / len) : 0;
  return {
    rows: list,
    report: { avgCalories: avgCal, avgProtein: avgPro, avgScore, avgEnergyDiff: avgEn, daysLogged: len }
  };
}

async function alreadyNotifiedToday(db, userId, ymd) {
  const row = await db.queryOne(
    'SELECT 1 AS x FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date AND notified_at IS NOT NULL LIMIT 1',
    [userId, ymd]
  );
  return !!row;
}

async function sendNutritionNotifications(db, { userId, ymd, userRow, channel }) {
  const meals = await db.queryAll(
    `SELECT meal_type, ai_result, meal_score, portion_size, manual_note
     FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date ORDER BY meal_type`,
    [userId, ymd]
  );
  if (!meals || !meals.length) return { email: false, inbox: false };

  const statsRow = await db.queryOne(
    'SELECT * FROM nutrition_daily_stats WHERE user_id = ? AND stat_date = ?::date',
    [userId, ymd]
  );
  const stats = statsRow || {};

  const ch = channel || 'both';
  const doEmail = ch === 'both' || ch === 'email';
  const doInbox = ch === 'both' || ch === 'message';

  let emailOk = false;
  let inboxOk = false;

  const formattedDate = ymd;
  const energyDiff = stats.energy_difference != null ? Number(stats.energy_difference) : null;

  const mealList = (meals || []).map((m) => {
    let ar = m.ai_result;
    if (typeof ar === 'string') {
      try {
        ar = JSON.parse(ar);
      } catch {
        ar = {};
      }
    }
    return { mealType: m.meal_type, aiResult: ar, mealScore: m.meal_score };
  });

  if (doEmail && userRow && userRow.email) {
    emailOk = await userEmail.emailNutritionDayReport(userRow.email, userRow.first_name || 'there', {
      formattedDate,
      stats: {
        totalCalories: stats.total_calories,
        totalProtein: stats.total_protein,
        totalCarbs: stats.total_carbs,
        totalFat: stats.total_fat,
        mealQualityScore: stats.meal_quality_score
      },
      meals: mealList,
      energyDiff
    });
  }

  if (doInbox) {
    const lines = [];
    lines.push(`Calories: ${stats.total_calories || 0} kcal | Protein: ${stats.total_protein || 0}g`);
    if (energyDiff != null) lines.push(`Energy (burn − intake): ${energyDiff >= 0 ? '+' : ''}${energyDiff} kcal`);
    mealList.forEach((x) => {
      const d = x.aiResult && x.aiResult.dish ? x.aiResult.dish : x.mealType;
      const cal = x.aiResult && x.aiResult.calories != null ? x.aiResult.calories : '—';
      lines.push(`${x.mealType}: ${d} — ${cal} kcal (score ${x.mealScore}/10)`);
    });
    const bodyText = lines.join('\n');
    try {
      await db.run('INSERT INTO user_inbox (id, user_id, title, body, type, is_read) VALUES (?, ?, ?, ?, ?, FALSE)', [
        uuidv4(),
        userId,
        `Your Bodybank X Fitchef Nutrition report — ${formattedDate}`,
        bodyText,
        'nutrition_report'
      ]);
      inboxOk = true;
    } catch (e) {
      console.warn('[nutrition] inbox insert failed', e.message);
    }
  }

  if (emailOk || inboxOk) {
    await db.run(
      'UPDATE nutrition_meal_logs SET notified_at = CURRENT_TIMESTAMP WHERE user_id = ? AND log_date = ?::date AND notified_at IS NULL',
      [userId, ymd]
    );
  }

  return { email: emailOk, inbox: inboxOk };
}

function createNutritionRouter(deps) {
  const { run, queryOne, queryAll, verifyToken, requireAdminOrSuperadmin, rateLimiter } = deps;
  const db = { run, queryOne, queryAll };

  const router = require('express').Router();
  router.use(verifyToken);
  const adminOnly = requireAdminOrSuperadmin;

  router.post('/analyze', rateLimiter(20, 60000), async (req, res) => {
    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) return res.status(503).json({ error: 'Nutrition AI is not configured (ANTHROPIC_API_KEY).' });

      const model =
        (process.env.ANTHROPIC_MODEL_NUTRITION || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514').trim();

      const userId = req.user.id;
      const {
        imageBase64,
        mimeType,
        mealType,
        portionSize = 'medium',
        manualNote = '',
        triggerNotify,
        autoNotifyOnComplete
      } = req.body || {};
      const autoDefault = autoNotifyOnComplete === undefined ? true : !!autoNotifyOnComplete;

      const mt = String(mealType || '').toLowerCase();
      if (!MEAL_TYPES.has(mt)) return res.status(400).json({ error: 'Invalid mealType' });

      const ps = String(portionSize || 'medium').toLowerCase();
      const portion = ['small', 'medium', 'large'].includes(ps) ? ps : 'medium';
      const note = String(manualNote || '').trim();

      const img = imageBase64 ? String(imageBase64).replace(/\s/g, '') : '';
      if (!note) return res.status(400).json({ error: 'Please add meal details in text. This is required for analysis.' });
      if (!img && !note) return res.status(400).json({ error: 'Provide a photo or a text description.' });
      if (img && img.length > MAX_B64_CHARS) return res.status(400).json({ error: 'Image too large.' });

      const ymd = ymdOrToday(req.body, req.query);
      if (img) {
        const dayPhotoRow = await queryOne(
          `SELECT COALESCE(SUM(photo_upload_count), 0)::int AS n
           FROM nutrition_meal_logs
           WHERE user_id = ? AND log_date = ?::date`,
          [userId, ymd]
        );
        const dayPhotoCount = parseInt(dayPhotoRow && dayPhotoRow.n, 10) || 0;
        if (dayPhotoCount >= 4) {
          return res.status(429).json({ error: 'Daily photo upload limit reached (4). Try again tomorrow.' });
        }
      }

      const { aiResult, usage } = await callClaudeNutrition({
        apiKey,
        model,
        imageBase64: img || null,
        mimeType: mimeType || 'image/jpeg',
        mealType: mt,
        portionSize: portion,
        manualNote: note
      });

      const mealScore = computeMealScore(aiResult);
      const mealConfidence = classifyMealConfidence({
        aiResult,
        hasImage: !!img,
        hasManualNote: !!note,
        source: 'ai'
      });
      const id = uuidv4();

      const photoStore = img ? img.slice(0, MAX_B64_CHARS) : null;
      const photoMime = img ? String(mimeType || 'image/jpeg').slice(0, 40) : null;

      await run(
        `INSERT INTO nutrition_meal_logs (
          id, user_id, log_date, meal_type, photo_data, photo_mime, manual_note, portion_size, ai_result, ai_usage, photo_upload_count, meal_score, submitted_at
        ) VALUES (?, ?, ?::date, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, log_date, meal_type) DO UPDATE SET
          photo_data = COALESCE(EXCLUDED.photo_data, nutrition_meal_logs.photo_data),
          photo_mime = COALESCE(EXCLUDED.photo_mime, nutrition_meal_logs.photo_mime),
          manual_note = EXCLUDED.manual_note,
          portion_size = EXCLUDED.portion_size,
          ai_result = EXCLUDED.ai_result,
          ai_usage = EXCLUDED.ai_usage,
          photo_upload_count = nutrition_meal_logs.photo_upload_count + CASE WHEN EXCLUDED.photo_data IS NOT NULL THEN 1 ELSE 0 END,
          meal_score = EXCLUDED.meal_score,
          submitted_at = CURRENT_TIMESTAMP,
          notified_at = NULL`,
        [
          id,
          userId,
          ymd,
          mt,
          photoStore,
          photoMime,
          note,
          portion,
          JSON.stringify(aiResult),
          JSON.stringify(usage || {}),
          img ? 1 : 0,
          mealScore
        ]
      );

      const dailyStats = await recomputeDailyStats(db, userId, ymd);
      const nMeals = await countMealsForDay(db, userId, ymd);
      const streak = await nutritionLoggingStreak(db, userId);
      const dailyRows = await queryAll(
        `SELECT photo_data, manual_note, ai_result
         FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date`,
        [userId, ymd]
      );
      const dailyConfidence = summarizeDailyConfidence(
        (dailyRows || []).map((r) => {
          let ar = r.ai_result;
          if (typeof ar === 'string') {
            try { ar = JSON.parse(ar); } catch (_) { ar = null; }
          }
          return classifyMealConfidence({
            aiResult: ar || {},
            hasImage: !!(r.photo_data && String(r.photo_data).trim()),
            hasManualNote: !!(r.manual_note && String(r.manual_note).trim()),
            source: 'ai'
          });
        })
      );

      let notifyResult = null;
      const forceNotify = triggerNotify === true || triggerNotify === 'true';
      const sentBefore = await alreadyNotifiedToday(db, userId, ymd);
      const shouldAuto = forceNotify || (autoDefault && nMeals >= 4 && !sentBefore);
      if (shouldAuto) {
        const u = await queryOne('SELECT id, email, first_name FROM users WHERE id = ?', [userId]);
        notifyResult = await sendNutritionNotifications(db, { userId, ymd, userRow: u, channel: 'both' });
      }

      res.json({
        aiResult,
        usage,
        mealScore,
        mealConfidence,
        dailyConfidence,
        date: ymd,
        dailyStats,
        mealsLoggedToday: nMeals,
        notifySent: !!(notifyResult && (notifyResult.email || notifyResult.inbox)),
        notifyResult,
        streak
      });
    } catch (e) {
      console.error('[nutrition analyze]', e.message);
      res.status(500).json({ error: e.message || 'Analysis failed' });
    }
  });

  /** Manual macro entry without new AI call */
  router.post('/log', rateLimiter(30, 60000), async (req, res) => {
    try {
      const userId = req.user.id;
      const { mealType, portionSize = 'medium', manualNote = '', macros, date: dateBody } = req.body || {};
      const mt = String(mealType || '').toLowerCase();
      if (!MEAL_TYPES.has(mt)) return res.status(400).json({ error: 'Invalid mealType' });
      const m = macros && typeof macros === 'object' ? macros : {};
      const aiResult = normalizeAiResult({
        dish: m.dish || 'Manual entry',
        description: String(manualNote || '').slice(0, 500),
        serving: m.serving || '',
        weight: m.weight,
        calories: m.calories,
        protein: m.protein,
        carbs: m.carbs,
        fat: m.fat,
        fiber: m.fiber,
        sodium: m.sodium,
        confidence: 'high',
        tips: m.tips || ''
      });
      if (!aiResult) return res.status(400).json({ error: 'Invalid macros' });

      const mealScore = computeMealScore(aiResult);
      const ymd = ymdOrToday({ date: dateBody }, req.query);
      const id = uuidv4();
      const ps = String(portionSize || 'medium').toLowerCase();
      const portion = ['small', 'medium', 'large'].includes(ps) ? ps : 'medium';
      const note = String(manualNote || '').trim();
      const mealConfidence = classifyMealConfidence({
        aiResult,
        hasImage: false,
        hasManualNote: !!note,
        source: 'manual'
      });

      await run(
        `INSERT INTO nutrition_meal_logs (
          id, user_id, log_date, meal_type, photo_data, photo_mime, manual_note, portion_size, ai_result, meal_score, submitted_at
        ) VALUES (?, ?, ?::date, ?, NULL, NULL, ?, ?, ?::jsonb, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, log_date, meal_type) DO UPDATE SET
          manual_note = EXCLUDED.manual_note,
          portion_size = EXCLUDED.portion_size,
          ai_result = EXCLUDED.ai_result,
          meal_score = EXCLUDED.meal_score,
          submitted_at = CURRENT_TIMESTAMP,
          notified_at = NULL`,
        [id, userId, ymd, mt, note, portion, JSON.stringify(aiResult), mealScore]
      );

      const dailyStats = await recomputeDailyStats(db, userId, ymd);
      const nMeals = await countMealsForDay(db, userId, ymd);
      const streak = await nutritionLoggingStreak(db, userId);
      const dailyRows = await queryAll(
        `SELECT photo_data, manual_note, ai_result
         FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date`,
        [userId, ymd]
      );
      const dailyConfidence = summarizeDailyConfidence(
        (dailyRows || []).map((r) => {
          let ar = r.ai_result;
          if (typeof ar === 'string') {
            try { ar = JSON.parse(ar); } catch (_) { ar = null; }
          }
          return classifyMealConfidence({
            aiResult: ar || {},
            hasImage: !!(r.photo_data && String(r.photo_data).trim()),
            hasManualNote: !!(r.manual_note && String(r.manual_note).trim()),
            source: r.photo_data ? 'ai' : 'manual'
          });
        })
      );
      res.json({ aiResult, mealScore, mealConfidence, dailyConfidence, date: ymd, dailyStats, mealsLoggedToday: nMeals, streak });
    } catch (e) {
      console.error('[nutrition log]', e.message);
      res.status(500).json({ error: e.message || 'Save failed' });
    }
  });

  router.get('/log/:userId/:date', async (req, res) => {
    try {
      const { userId, date } = req.params;
      const uid = String(userId);
      const d = String(date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Invalid date' });
      const role = req.user.role;
      if (uid !== req.user.id && role !== 'admin' && role !== 'superadmin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const meals = await queryAll(
        `SELECT id, meal_type, photo_data, photo_mime, manual_note, portion_size, ai_result, ai_usage, meal_score, submitted_at, notified_at
         FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date ORDER BY meal_type`,
        [uid, d]
      );
      const stats = await queryOne(
        'SELECT * FROM nutrition_daily_stats WHERE user_id = ? AND stat_date = ?::date',
        [uid, d]
      );
      const streak = uid === req.user.id ? await nutritionLoggingStreak(db, uid) : null;
      const mealsWithConfidence = (meals || []).map((m) => {
        let ar = m.ai_result;
        if (typeof ar === 'string') {
          try { ar = JSON.parse(ar); } catch (_) { ar = null; }
        }
        const mc = classifyMealConfidence({
          aiResult: ar || {},
          hasImage: !!(m.photo_data && String(m.photo_data).trim()),
          hasManualNote: !!(m.manual_note && String(m.manual_note).trim()),
          source: m.photo_data ? 'ai' : 'manual'
        });
        return { ...m, meal_confidence: mc };
      });
      const dailyConfidence = summarizeDailyConfidence(mealsWithConfidence.map((m) => m.meal_confidence));
      res.json({ date: d, userId: uid, meals: mealsWithConfidence, dailyConfidence, dailyStats: stats || null, streak });
    } catch (e) {
      console.error('[nutrition get log]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/report/:userId', async (req, res) => {
    try {
      const uid = String(req.params.userId);
      if (uid !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const end = ymdOrToday({}, req.query);
      const rows = await queryAll(
        `SELECT stat_date, total_calories, total_protein, total_carbs, total_fat, meal_quality_score, energy_difference, meals_logged
         FROM nutrition_daily_stats
         WHERE user_id = ? AND stat_date >= (?::date - INTERVAL '6 days') AND stat_date <= ?::date
         ORDER BY stat_date ASC`,
        [uid, end, end]
      );
      res.json({ userId: uid, endDate: end, days: rows || [] });
    } catch (e) {
      console.error('[nutrition report]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /** Admin: re-run Claude for every meal row on a date that has a photo or manual note */
  router.post('/analyze-all/:userId', adminOnly, rateLimiter(3, 120000), async (req, res) => {
    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) return res.status(503).json({ error: 'Nutrition AI is not configured (ANTHROPIC_API_KEY).' });

      const model =
        (process.env.ANTHROPIC_MODEL_NUTRITION || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514').trim();

      const targetUserId = String(req.params.userId || '').trim();
      if (!targetUserId) return res.status(400).json({ error: 'Invalid userId' });

      const u = await queryOne('SELECT id FROM users WHERE id = ?', [targetUserId]);
      if (!u) return res.status(404).json({ error: 'User not found' });

      const ymd = ymdOrToday(req.body, req.query);

      const rows = await queryAll(
        `SELECT meal_type, photo_data, photo_mime, manual_note, portion_size
         FROM nutrition_meal_logs
         WHERE user_id = ? AND log_date = ?::date`,
        [targetUserId, ymd]
      );

      const results = [];
      const errors = [];

      for (const row of rows || []) {
        const mt = String(row.meal_type || '').toLowerCase();
        if (!MEAL_TYPES.has(mt)) continue;

        const img = row.photo_data ? String(row.photo_data).replace(/\s/g, '') : '';
        const note = String(row.manual_note || '').trim();
        if (!note) {
          errors.push({ mealType: mt, error: 'Text meal details are required for re-analysis.' });
          continue;
        }
        if (!img && !note) continue;
        if (img.length > MAX_B64_CHARS) {
          errors.push({ mealType: mt, error: 'Image too large' });
          continue;
        }

        const ps = String(row.portion_size || 'medium').toLowerCase();
        const portion = ['small', 'medium', 'large'].includes(ps) ? ps : 'medium';

        try {
          const { aiResult, usage } = await callClaudeNutrition({
            apiKey,
            model,
            imageBase64: img || null,
            mimeType: row.photo_mime || 'image/jpeg',
            mealType: mt,
            portionSize: portion,
            manualNote: note
          });
          const mealScore = computeMealScore(aiResult);

          await run(
            `UPDATE nutrition_meal_logs
             SET ai_result = ?::jsonb, ai_usage = ?::jsonb, meal_score = ?, submitted_at = CURRENT_TIMESTAMP, notified_at = NULL
             WHERE user_id = ? AND log_date = ?::date AND meal_type = ?`,
            [JSON.stringify(aiResult), JSON.stringify(usage || {}), mealScore, targetUserId, ymd, mt]
          );
          results.push({ mealType: mt, mealScore, usage });
        } catch (e) {
          errors.push({ mealType: mt, error: e.message || 'Analysis failed' });
        }
      }

      await recomputeDailyStats(db, targetUserId, ymd);

      res.json({
        ok: true,
        date: ymd,
        userId: targetUserId,
        analyzed: results.length,
        results,
        errors
      });
    } catch (e) {
      console.error('[nutrition analyze-all]', e.message);
      res.status(500).json({ error: e.message || 'analyze-all failed' });
    }
  });

  router.post('/notify', rateLimiter(15, 60000), async (req, res) => {
    try {
      const { userId, date, channel } = req.body || {};
      const uid = String(userId || req.user.id);
      if (uid !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const ymd = ymdOrToday({ date }, req.query);
      const u = await queryOne('SELECT id, email, first_name FROM users WHERE id = ?', [uid]);
      if (!u) return res.status(404).json({ error: 'User not found' });
      const result = await sendNutritionNotifications(db, { userId: uid, ymd, userRow: u, channel });
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[nutrition notify]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/all', adminOnly, async (req, res) => {
    try {
      const ymd = ymdOrToday({}, req.query);
      const rows = await queryAll(
        `SELECT u.id, u.first_name, u.last_name, u.email,
                COUNT(n.id)::int AS meal_count,
                COALESCE(SUM((n.ai_result->>'calories')::int), 0)::int AS total_calories,
                COALESCE(SUM((n.ai_result->>'protein')::int), 0)::int AS total_protein
         FROM users u
         INNER JOIN nutrition_meal_logs n ON n.user_id = u.id AND n.log_date = ?::date
         WHERE u.role = 'user'
         GROUP BY u.id, u.first_name, u.last_name, u.email
         ORDER BY u.first_name, u.last_name`,
        [ymd]
      );
      res.json({ date: ymd, users: rows || [] });
    } catch (e) {
      console.error('[nutrition admin all]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/report', adminOnly, async (req, res) => {
    try {
      const ymd = ymdOrToday({}, req.query);
      const userRows = await queryAll(
        `SELECT DISTINCT user_id FROM nutrition_meal_logs WHERE log_date = ?::date`,
        [ymd]
      );
      const uids = (userRows || []).map((r) => r.user_id);
      const clients = [];
      let sumCal = 0;
      let sumScore = 0;
      let scoreN = 0;
      let sumEnergy = 0;
      let energyN = 0;
      let totalMeals = 0;

      for (const uid of uids) {
        const u = await queryOne(
          'SELECT id, first_name, last_name, email FROM users WHERE id = ?',
          [uid]
        );
        if (!u) continue;
        const meals = await queryAll(
          `SELECT meal_type, photo_data, photo_mime, ai_result, ai_usage, meal_score, manual_note, notified_at
           FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date`,
          [uid, ymd]
        );
        const stats = await queryOne(
          'SELECT * FROM nutrition_daily_stats WHERE user_id = ? AND stat_date = ?::date',
          [uid, ymd]
        );
        const weekly = await buildWeeklyNutritionSummary(db, uid, ymd);
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email;
        const notified = (meals || []).some((m) => m.notified_at != null);
        clients.push({
          userId: u.id,
          userName: name,
          userEmail: u.email,
          userGoal: null,
          meals: meals || [],
          dailyStats: stats || null,
          weekly: {
            avgProtein: weekly.report.avgProtein,
            daysLogged: weekly.report.daysLogged,
            trend: weekly.rows.map((r) => ({
              date: String(r.stat_date || '').slice(0, 10),
              protein: parseInt(r.total_protein, 10) || 0
            }))
          },
          notified
        });
        totalMeals += (meals || []).length;
        if (stats && stats.total_calories != null) sumCal += Number(stats.total_calories);
        if (stats && stats.meal_quality_score != null) {
          sumScore += Number(stats.meal_quality_score);
          scoreN += 1;
        }
        if (stats && stats.energy_difference != null) {
          sumEnergy += Number(stats.energy_difference);
          energyN += 1;
        }
      }

      const clientsLogged = clients.length;
      const aggregate = {
        totalMeals,
        clientsLogged,
        avgCalories: clientsLogged ? Math.round(sumCal / clientsLogged) : 0,
        avgMealScore: scoreN ? Math.round((sumScore / scoreN) * 10) / 10 : 0,
        avgEnergyDiff: energyN ? Math.round(sumEnergy / energyN) : 0
      };

      res.json({ date: ymd, aggregate, clients });
    } catch (e) {
      console.error('[nutrition admin report]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/admin/export', adminOnly, async (req, res) => {
    try {
      const ymd = ymdOrToday({}, req.query);
      const rows = await queryAll(
        `SELECT u.email, u.first_name, u.last_name, n.meal_type, n.meal_score,
                n.ai_result->>'dish' AS dish,
                n.ai_result->>'calories' AS calories,
                n.ai_result->>'protein' AS protein
         FROM nutrition_meal_logs n
         JOIN users u ON u.id = n.user_id
         WHERE n.log_date = ?::date
         ORDER BY u.email, n.meal_type`,
        [ymd]
      );
      const esc = (v) => {
        const s = String(v == null ? '' : v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const header = ['email', 'first_name', 'last_name', 'meal_type', 'dish', 'calories', 'protein', 'meal_score'];
      const lines = [header.join(',')];
      (rows || []).forEach((r) => {
        lines.push(
          [r.email, r.first_name, r.last_name, r.meal_type, r.dish, r.calories, r.protein, r.meal_score]
            .map(esc)
            .join(',')
        );
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="nutrition-${ymd}.csv"`);
      res.send(lines.join('\n'));
    } catch (e) {
      console.error('[nutrition export]', e.message);
      res.status(500).send('Export failed');
    }
  });

  router.post('/admin/share-weekly/:userId', adminOnly, rateLimiter(10, 60000), async (req, res) => {
    try {
      const uid = String(req.params.userId || '').trim();
      if (!uid) return res.status(400).json({ error: 'Invalid userId' });
      const ymd = ymdOrToday(req.body, req.query);
      const userRow = await queryOne('SELECT id, email, first_name FROM users WHERE id = ?', [uid]);
      if (!userRow) return res.status(404).json({ error: 'User not found' });
      if (!userRow.email) return res.status(400).json({ error: 'User email missing' });

      const weekly = await buildWeeklyNutritionSummary(db, uid, ymd);
      if (!weekly.report.daysLogged) {
        return res.status(400).json({ error: 'No nutrition data in the last 7 days for this user.' });
      }

      const emailed = await userEmail.emailNutritionWeeklySummary(userRow.email, userRow.first_name || 'there', weekly.report);
      if (!emailed) {
        if (!userEmail.isConfigured()) {
          return res.status(503).json({ error: 'Email is not configured (SMTP).' });
        }
        return res.status(500).json({ error: 'Failed to send weekly nutrition report email.' });
      }

      await run('INSERT INTO user_inbox (id, user_id, title, body, type, is_read) VALUES (?, ?, ?, ?, ?, FALSE)', [
        uuidv4(),
        uid,
        'Fitchef Nutrition weekly summary',
        `Avg ${weekly.report.avgCalories} kcal/day · ${weekly.report.avgProtein}g protein · score ${weekly.report.avgScore}/10 · energy diff ${weekly.report.avgEnergyDiff} kcal (${weekly.report.daysLogged} days).`,
        'nutrition_weekly'
      ]);

      res.json({ ok: true });
    } catch (e) {
      console.error('[nutrition share-weekly]', e.message);
      res.status(500).json({ error: e.message || 'share-weekly failed' });
    }
  });

  return router;
}

async function runWeeklyNutritionEmailJob({ queryAll, queryOne, run }) {
  const end = todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
  const users = await queryAll(
    `SELECT id, email, first_name FROM users WHERE role = 'user'
     AND (approval_status IS NULL OR approval_status = 'approved')
     AND COALESCE(suspended, FALSE) = FALSE`
  );
  let n = 0;
  for (const u of users || []) {
    const rows = await queryAll(
      `SELECT total_calories, total_protein, meal_quality_score, energy_difference
       FROM nutrition_daily_stats
       WHERE user_id = ? AND stat_date >= (?::date - INTERVAL '6 days') AND stat_date <= ?::date`,
      [u.id, end, end]
    );
    if (!rows || !rows.length) continue;
    const len = rows.length;
    const avgCal = Math.round(rows.reduce((s, r) => s + (parseInt(r.total_calories, 10) || 0), 0) / len);
    const avgPro = Math.round(rows.reduce((s, r) => s + (parseInt(r.total_protein, 10) || 0), 0) / len);
    const avgScore = (rows.reduce((s, r) => s + (parseFloat(r.meal_quality_score) || 0), 0) / len).toFixed(1);
    const avgEn = Math.round(rows.reduce((s, r) => s + (parseInt(r.energy_difference, 10) || 0), 0) / len);
    const report = { avgCalories: avgCal, avgProtein: avgPro, avgScore, avgEnergyDiff: avgEn, daysLogged: len };
    await userEmail.emailNutritionWeeklySummary(u.email, u.first_name, report);
    try {
      await run('INSERT INTO user_inbox (id, user_id, title, body, type, is_read) VALUES (?, ?, ?, ?, ?, FALSE)', [
        uuidv4(),
        u.id,
        'Weekly nutrition summary',
        `Avg ${avgCal} kcal/day · ${avgPro}g protein · score ${avgScore}/10 · energy diff ${avgEn} kcal (${len} days).`,
        'nutrition_weekly'
      ]);
    } catch (e) {
      console.warn('[nutrition weekly inbox]', e.message);
    }
    n += 1;
  }
  console.log(`[nutrition] Weekly job: ${n} user(s) with stats emailed.`);
}

module.exports = { createNutritionRouter, sendNutritionNotifications, runWeeklyNutritionEmailJob };
