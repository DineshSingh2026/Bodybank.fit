'use strict';

const { v4: uuidv4 } = require('uuid');
const userEmail = require('../services/userEmailService');
const nutritionService = require('../services/nutritionService');
const coinService = require('../services/coinService');
const { notifyAsync } = require('../utils/notify');
const { buildSignedPhotoUrl } = require('../utils/nutritionPhotoLink');

const {
  MEAL_TYPES,
  computeMealScore,
  callClaudeNutrition,
  validateNutritionMealInput,
  normalizeAiResult,
  classifyMealConfidence,
  summarizeDailyConfidence,
  recomputeDailyStats,
  countMealsForDay,
  nutritionLoggingStreak,
  todayYmdInTz,
  STREAK_TZ
} = nutritionService;

/** ~10 MiB decoded image → base64 length cap (single-request analyze only; never persisted). */
const MAX_NUTRITION_IMAGE_B64_CHARS = 14 * 1024 * 1024;
/** Anthropic base64 images must decode to ≤ 5 MiB; stay under with margin. */
const NUTRITION_IMAGE_DECODE_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);
let _lastNutritionPhotoPurgeYmd = '';

function approxDecodedBytesFromBase64(b64) {
  const s = String(b64 || '').replace(/\s/g, '');
  if (!s.length) return 0;
  const pad = s.length >= 2 && s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

function userFacingNutritionAnalyzeError(err) {
  const m = String((err && err.message) || err || '');
  const low = m.toLowerCase();
  if (low.includes('exceeds 5 mb') || low.includes('5242880')) {
    return 'Photo is too large for analysis. Please choose a smaller image or retake the photo.';
  }
  if (low.includes('too large') && low.includes('photo')) return m;
  if (m.includes('messages.') && m.includes('base64')) {
    return 'Photo is too large for analysis. Please choose a smaller image or retake the photo.';
  }
  if (m.length > 220) return 'Analysis failed. Please try again with a smaller or clearer photo.';
  return m || 'Analysis failed';
}

function buildAiResultForStorage(baseAi, { analyzedWithPhoto, entrySource }) {
  if (!baseAi || typeof baseAi !== 'object') return baseAi;
  return {
    ...baseAi,
    _bbAnalyzedWithPhoto: !!analyzedWithPhoto,
    _bbEntrySource: entrySource === 'manual' ? 'manual' : 'ai'
  };
}

function parseAiResultRow(raw) {
  let ar = raw;
  if (typeof ar === 'string') {
    try {
      ar = JSON.parse(ar);
    } catch (_) {
      ar = null;
    }
  }
  return ar && typeof ar === 'object' ? ar : {};
}

function confidenceFromLogRow(r) {
  const ar = parseAiResultRow(r.ai_result);
  const hasImage = !!ar._bbAnalyzedWithPhoto || !!(r && r.photo_data && String(r.photo_data).trim());
  const hasManualNote = !!(r.manual_note && String(r.manual_note).trim());
  const source = ar._bbEntrySource === 'manual' ? 'manual' : 'ai';
  return classifyMealConfidence({ aiResult: ar, hasImage, hasManualNote, source });
}

async function purgeOldNutritionPhotos(db) {
  const todayYmd = todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
  if (_lastNutritionPhotoPurgeYmd === todayYmd) return;
  // Retain photos for 3 days (today + 2 previous days). Delete anything 3+ days old.
  await db.run(
    `UPDATE nutrition_meal_logs
     SET photo_data = NULL, photo_mime = NULL
     WHERE log_date <= (?::date - INTERVAL '3 days')
       AND (photo_data IS NOT NULL OR photo_mime IS NOT NULL)`,
    [todayYmd]
  );
  _lastNutritionPhotoPurgeYmd = todayYmd;
}

/**
 * Returns explicit date from body/query, or today in the user's timezone.
 * @param {object} body - request body
 * @param {object} query - request query
 * @param {string|null} userTz - IANA timezone string (from authenticated user); falls back to STREAK_TZ
 */
function ymdOrToday(body, query, userTz) {
  const raw = (body && body.date) || (query && query.date) || '';
  const s = String(raw).trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const tz = (userTz && typeof userTz === 'string' && userTz.trim()) ? userTz.trim() : STREAK_TZ;
  return todayYmdInTz(tz) || new Date().toISOString().slice(0, 10);
}

/** Fetch the authenticated user's IANA timezone from DB (falls back to STREAK_TZ) */
async function getUserTz(db, userId) {
  try {
    const r = await db.queryOne('SELECT timezone FROM users WHERE id = ?', [userId]);
    return (r && r.timezone && r.timezone.trim()) ? r.timezone.trim() : STREAK_TZ;
  } catch (_) { return STREAK_TZ; }
}

function appBaseUrlFromReq(req) {
  // RENDER_EXTERNAL_URL is auto-set by Render as https:// — highest priority for public media URLs
  const candidates = [
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.APP_BASE_URL,
    process.env.SITE_URL,
    process.env.RESET_BASE_URL,
    req ? (req.protocol + '://' + req.get('host')) : ''
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim() && c.includes('://')) {
      let url = String(c).trim().replace(/\/$/, '');
      // Always force HTTPS — Twilio and WhatsApp reject HTTP media URLs
      if (url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        url = 'https://' + url.slice(7);
      }
      return url;
    }
  }
  return '';
}

async function safeAwardCoins(db, userId, eventType, eventKey, coinsDelta, meta, createdAtYmd) {
  try {
    await coinService.awardCoins(db, {
      userId: String(userId),
      eventType,
      eventKey,
      coinsDelta,
      meta: meta || {},
      createdAtYmd
    });
  } catch (e) {
    console.warn('[coins award][nutrition]', e.message);
  }
}

async function safeApplyPenalties(db, userId, userTz) {
  try {
    const tz = (userTz && typeof userTz === 'string' && userTz.trim()) ? userTz.trim() : STREAK_TZ;
    const today = todayYmdInTz(tz) || new Date().toISOString().slice(0, 10);
    await coinService.applyMissedDailyPenaltiesForUser(db, String(userId), today);
  } catch (e) {
    console.warn('[coins penalty][nutrition]', e.message);
  }
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
  router.use(async (_req, _res, next) => {
    try { await purgeOldNutritionPhotos(db); } catch (_) {}
    next();
  });
  const adminOnly = requireAdminOrSuperadmin;

  /**
   * Returns the per-user Nutrition AI access state. Default = unlimited
   * (so existing accounts and any read failure fall open, never lock a paying user out).
   */
  async function getNutritionAccess(userId) {
    try {
      const r = await queryOne(
        `SELECT COALESCE(nutrition_ai_unlimited, TRUE)  AS unlimited,
                COALESCE(nutrition_ai_meal_limit, 0)::int  AS lim,
                COALESCE(nutrition_ai_meal_used, 0)::int   AS used
           FROM users WHERE id = ?`,
        [userId]
      );
      if (!r) return { unlimited: true, lim: 0, used: 0 };
      return { unlimited: !!r.unlimited, lim: Number(r.lim) || 0, used: Number(r.used) || 0 };
    } catch (_) { return { unlimited: true, lim: 0, used: 0 }; }
  }

  function buildNutritionLimitResponse(access) {
    return {
      error: 'limit_reached',
      feature: 'nutrition_ai',
      used: access.used,
      limit: access.lim,
      message: "You've reached your Nutrition AI trial limit. Please contact admin to continue."
    };
  }

  async function mealSlotExists(userId, ymd, mealType) {
    try {
      const r = await queryOne(
        `SELECT 1 AS x FROM nutrition_meal_logs
          WHERE user_id = ? AND log_date = ?::date AND meal_type = ?
          LIMIT 1`,
        [userId, ymd, mealType]
      );
      return !!r;
    } catch (_) { return false; }
  }

  router.post('/analyze', rateLimiter(20, 60000), async (req, res) => {
    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
      if (!apiKey) return res.status(503).json({ error: 'Nutrition AI is not configured (ANTHROPIC_API_KEY).' });

      const model =
        (process.env.ANTHROPIC_MODEL_NUTRITION || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim();

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
      if (img && img.length > MAX_NUTRITION_IMAGE_B64_CHARS) {
        return res.status(400).json({ error: 'Image too large (max 10 MB).' });
      }
      if (img && approxDecodedBytesFromBase64(img) > NUTRITION_IMAGE_DECODE_LIMIT_BYTES) {
        return res.status(400).json({
          error: 'This photo is too large to analyze. Please choose a smaller image or take a new photo.'
        });
      }
      const mealValidation = await validateNutritionMealInput({
        apiKey,
        model,
        imageBase64: img || null,
        mimeType: mimeType || 'image/jpeg',
        mealType: mt,
        manualNote: note
      });
      if (!mealValidation.isFoodMeal) {
        return res.status(400).json({
          error:
            'This does not look like a valid food meal upload. Please upload a meal photo and add meal details text.'
        });
      }

      const _userTz = await getUserTz(db, userId);
      const ymd = ymdOrToday(req.body, req.query, _userTz);
      // Trial-mode gate: only block when this would create a NEW meal slot. Re-analyses of an existing
      // slot don't consume quota, so trial users can still correct their already-logged meals.
      const isNewMealSlot = !(await mealSlotExists(userId, ymd, mt));
      const nutritionAccess = await getNutritionAccess(userId);
      if (isNewMealSlot && !nutritionAccess.unlimited && nutritionAccess.used >= nutritionAccess.lim) {
        return res.status(403).json(buildNutritionLimitResponse(nutritionAccess));
      }
      if (img) {
        // Enforce slot-based quota (max 4 meal slots/day), not retry-attempt quota.
        // Re-analyzing the same meal slot should not consume another daily slot.
        const existingMealRow = await queryOne(
          `SELECT COALESCE(photo_upload_count, 0)::int AS photo_upload_count
           FROM nutrition_meal_logs
           WHERE user_id = ? AND log_date = ?::date AND meal_type = ?
           LIMIT 1`,
          [userId, ymd, mt]
        );
        const mealHasPhotoSlot = (parseInt(existingMealRow && existingMealRow.photo_upload_count, 10) || 0) > 0;
        if (!mealHasPhotoSlot) {
          const dayPhotoSlotsRow = await queryOne(
            `SELECT COUNT(*)::int AS n
             FROM nutrition_meal_logs
             WHERE user_id = ? AND log_date = ?::date AND COALESCE(photo_upload_count, 0) > 0`,
            [userId, ymd]
          );
          const dayPhotoSlots = parseInt(dayPhotoSlotsRow && dayPhotoSlotsRow.n, 10) || 0;
          if (dayPhotoSlots >= 4) {
            return res.status(429).json({ error: 'Daily photo upload limit reached (4). Try again tomorrow.' });
          }
        }
      }

      const { aiResult: aiRaw, usage } = await callClaudeNutrition({
        apiKey,
        model,
        imageBase64: img || null,
        mimeType: mimeType || 'image/jpeg',
        mealType: mt,
        portionSize: portion,
        manualNote: note
      });

      const mealScore = computeMealScore(aiRaw);
      const aiResult = buildAiResultForStorage(aiRaw, { analyzedWithPhoto: !!img, entrySource: 'ai' });
      const mealConfidence = classifyMealConfidence({
        aiResult,
        hasImage: !!img,
        hasManualNote: !!note,
        source: 'ai'
      });
      const id = uuidv4();
      const photoUploadDelta = img ? 1 : 0;
      const photoStore = img ? img.slice(0, MAX_NUTRITION_IMAGE_B64_CHARS) : null;
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
          photo_upload_count = CASE
            WHEN EXCLUDED.photo_data IS NOT NULL THEN GREATEST(nutrition_meal_logs.photo_upload_count, 1)
            ELSE nutrition_meal_logs.photo_upload_count
          END,
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
          photoUploadDelta,
          mealScore
        ]
      );
      if (isNewMealSlot && !nutritionAccess.unlimited) {
        await run('UPDATE users SET nutrition_ai_meal_used = COALESCE(nutrition_ai_meal_used, 0) + 1, nutrition_ai_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
      } else {
        await run('UPDATE users SET nutrition_ai_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
      }
      const latestMealWithPhoto = await queryOne(
        `SELECT id, photo_data
         FROM nutrition_meal_logs
         WHERE user_id = ? AND log_date = ?::date AND meal_type = ?
         LIMIT 1`,
        [userId, ymd, mt]
      ).catch(() => null);
      const mealPhotoUrl = (() => {
        if (!latestMealWithPhoto || !latestMealWithPhoto.id || !latestMealWithPhoto.photo_data) return null;
        const baseUrl = appBaseUrlFromReq(req);
        if (!baseUrl) { console.warn('[nutrition] appBaseUrlFromReq returned empty — mediaUrl skipped'); return null; }
        // Guard: estimate binary size from base64 — skip if likely > 4.5 MB (WhatsApp hard limit 5 MB)
        const b64raw = String(latestMealWithPhoto.photo_data || '');
        const b64 = b64raw.includes(',') ? b64raw.slice(b64raw.indexOf(',') + 1) : b64raw;
        const approxBytes = Math.floor(b64.length * 0.75);
        if (approxBytes > 4.5 * 1024 * 1024) {
          console.warn('[nutrition] Photo too large for Twilio (%d approx bytes) — mediaUrl skipped', approxBytes);
          return null;
        }
        return buildSignedPhotoUrl(baseUrl, latestMealWithPhoto.id, 24 * 60 * 60 * 1000);
      })();

      const dailyStats = await recomputeDailyStats(db, userId, ymd);
      const nMeals = await countMealsForDay(db, userId, ymd);
      const streak = await nutritionLoggingStreak(db, userId);
      const dailyRows = await queryAll(
        `SELECT manual_note, ai_result
         FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date`,
        [userId, ymd]
      );
      const dailyConfidence = summarizeDailyConfidence((dailyRows || []).map((r) => confidenceFromLogRow(r)));

      let notifyResult = null;
      const forceNotify = triggerNotify === true || triggerNotify === 'true';
      const sentBefore = await alreadyNotifiedToday(db, userId, ymd);
      const shouldAuto = forceNotify || (autoDefault && nMeals >= 4 && !sentBefore);
      if (shouldAuto) {
        const u = await queryOne('SELECT id, email, first_name FROM users WHERE id = ?', [userId]);
        notifyResult = await sendNutritionNotifications(db, { userId, ymd, userRow: u, channel: 'both' });
      }

      await safeApplyPenalties(db, userId, _userTz);
      if (nMeals >= 4) {
        await safeAwardCoins(
          db,
          userId,
          'nutrition_day_complete',
          `coins:nutrition_day_complete:${userId}:${ymd}`,
          coinService.COIN_RULES.NUTRITION_DAY_COMPLETE,
          { date: ymd, mealsLogged: nMeals },
          ymd
        );
        const nuUser = await queryOne('SELECT email, first_name, last_name, phone FROM users WHERE id = ?', [userId]).catch(() => null);
        notifyAsync('NUTRITION_DAY_COMPLETE', { name: nuUser ? `${nuUser.first_name || ''} ${nuUser.last_name || ''}`.trim() : userId, email: nuUser ? nuUser.email : userId, mobile: nuUser ? (nuUser.phone || '—') : '—', date: ymd, meals: nMeals, mediaUrl: mealPhotoUrl });
      } else {
        const nuUser = await queryOne('SELECT email, first_name, last_name, phone FROM users WHERE id = ?', [userId]).catch(() => null);
        notifyAsync('NUTRITION_MEAL_LOGGED', { name: nuUser ? `${nuUser.first_name || ''} ${nuUser.last_name || ''}`.trim() : userId, email: nuUser ? nuUser.email : userId, mobile: nuUser ? (nuUser.phone || '—') : '—', mealType, date: ymd, score: mealScore || '—', calories: aiResult && aiResult.calories ? aiResult.calories : '—', protein: aiResult && aiResult.protein ? aiResult.protein + ' g' : '—', carbs: aiResult && aiResult.carbs ? aiResult.carbs + ' g' : '—', fat: aiResult && aiResult.fat ? aiResult.fat + ' g' : '—', mediaUrl: mealPhotoUrl });
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
      res.status(500).json({ error: userFacingNutritionAnalyzeError(e) });
    }
  });

  /** Manual macro entry without new AI call */
  router.post('/log', rateLimiter(30, 60000), async (req, res) => {
    try {
      const userId = req.user.id;
      const { mealType, portionSize = 'medium', manualNote = '', macros, date: dateBody } = req.body || {};
      const mt = String(mealType || '').toLowerCase();
      if (!MEAL_TYPES.has(mt)) return res.status(400).json({ error: 'Invalid mealType' });
      const _logTzForGate = await getUserTz(db, userId);
      const _ymdForGate = ymdOrToday({ date: dateBody }, req.query, _logTzForGate);
      const isNewMealSlot = !(await mealSlotExists(userId, _ymdForGate, mt));
      const nutritionAccess = await getNutritionAccess(userId);
      if (isNewMealSlot && !nutritionAccess.unlimited && nutritionAccess.used >= nutritionAccess.lim) {
        return res.status(403).json(buildNutritionLimitResponse(nutritionAccess));
      }
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
      const aiStored = buildAiResultForStorage(aiResult, { analyzedWithPhoto: false, entrySource: 'manual' });
      const _logUserTz = _logTzForGate;
      const ymd = _ymdForGate;
      const id = uuidv4();
      const ps = String(portionSize || 'medium').toLowerCase();
      const portion = ['small', 'medium', 'large'].includes(ps) ? ps : 'medium';
      const note = String(manualNote || '').trim();
      const mealConfidence = classifyMealConfidence({
        aiResult: aiStored,
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
        [id, userId, ymd, mt, note, portion, JSON.stringify(aiStored), mealScore]
      );
      if (isNewMealSlot && !nutritionAccess.unlimited) {
        await run('UPDATE users SET nutrition_ai_meal_used = COALESCE(nutrition_ai_meal_used, 0) + 1, nutrition_ai_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
      } else {
        await run('UPDATE users SET nutrition_ai_last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
      }
      const latestManualMeal = await queryOne(
        `SELECT id, photo_data
         FROM nutrition_meal_logs
         WHERE user_id = ? AND log_date = ?::date AND meal_type = ?
         LIMIT 1`,
        [userId, ymd, mt]
      ).catch(() => null);
      const manualMealPhotoUrl = (() => {
        if (!latestManualMeal || !latestManualMeal.id || !latestManualMeal.photo_data) return null;
        const baseUrl = appBaseUrlFromReq(req);
        if (!baseUrl) { console.warn('[nutrition/log] appBaseUrlFromReq returned empty — mediaUrl skipped'); return null; }
        const b64raw = String(latestManualMeal.photo_data || '');
        const b64 = b64raw.includes(',') ? b64raw.slice(b64raw.indexOf(',') + 1) : b64raw;
        const approxBytes = Math.floor(b64.length * 0.75);
        if (approxBytes > 4.5 * 1024 * 1024) {
          console.warn('[nutrition/log] Photo too large for Twilio (%d approx bytes) — mediaUrl skipped', approxBytes);
          return null;
        }
        return buildSignedPhotoUrl(baseUrl, latestManualMeal.id, 24 * 60 * 60 * 1000);
      })();

      const dailyStats = await recomputeDailyStats(db, userId, ymd);
      const nMeals = await countMealsForDay(db, userId, ymd);
      const streak = await nutritionLoggingStreak(db, userId);
      const dailyRows = await queryAll(
        `SELECT manual_note, ai_result
         FROM nutrition_meal_logs WHERE user_id = ? AND log_date = ?::date`,
        [userId, ymd]
      );
      const dailyConfidence = summarizeDailyConfidence((dailyRows || []).map((r) => confidenceFromLogRow(r)));
      await safeApplyPenalties(db, userId, _logUserTz);
      if (nMeals >= 4) {
        await safeAwardCoins(
          db,
          userId,
          'nutrition_day_complete',
          `coins:nutrition_day_complete:${userId}:${ymd}`,
          coinService.COIN_RULES.NUTRITION_DAY_COMPLETE,
          { date: ymd, mealsLogged: nMeals },
          ymd
        );
        const nlUser = await queryOne('SELECT email, first_name, last_name, phone FROM users WHERE id = ?', [userId]).catch(() => null);
        notifyAsync('NUTRITION_DAY_COMPLETE', { name: nlUser ? `${nlUser.first_name || ''} ${nlUser.last_name || ''}`.trim() : userId, email: nlUser ? nlUser.email : userId, mobile: nlUser ? (nlUser.phone || '—') : '—', date: ymd, meals: nMeals, mediaUrl: manualMealPhotoUrl });
      } else {
        const nlUser = await queryOne('SELECT email, first_name, last_name, phone FROM users WHERE id = ?', [userId]).catch(() => null);
        notifyAsync('NUTRITION_MEAL_LOGGED', { name: nlUser ? `${nlUser.first_name || ''} ${nlUser.last_name || ''}`.trim() : userId, email: nlUser ? nlUser.email : userId, mobile: nlUser ? (nlUser.phone || '—') : '—', mealType: mt, date: ymd, score: mealScore || '—', calories: aiStored && aiStored.calories ? aiStored.calories : '—', protein: aiStored && aiStored.protein ? aiStored.protein + ' g' : '—', carbs: aiStored && aiStored.carbs ? aiStored.carbs + ' g' : '—', fat: aiStored && aiStored.fat ? aiStored.fat + ' g' : '—', mediaUrl: manualMealPhotoUrl });
      }
      res.json({
        aiResult: aiStored,
        mealScore,
        mealConfidence,
        dailyConfidence,
        date: ymd,
        dailyStats,
        mealsLoggedToday: nMeals,
        streak
      });
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
      await recomputeDailyStats(db, uid, d);
      const stats = await queryOne(
        'SELECT * FROM nutrition_daily_stats WHERE user_id = ? AND stat_date = ?::date',
        [uid, d]
      );
      const streak = uid === req.user.id ? await nutritionLoggingStreak(db, uid) : null;
      // Signed, short-lived download URL per photographed meal. Navigating to this
      // triggers a real file download (server sets Content-Disposition) — reliable
      // on iOS Safari, unlike a client-side data: URI anchor.
      const baseUrl = appBaseUrlFromReq(req);
      const safeDate = d.replace(/[^\d-]/g, '');
      const mealsWithConfidence = (meals || []).map((m) => {
        let download_url = null;
        if (baseUrl && m.id && m.photo_data && String(m.photo_data).trim()) {
          const fnBase = ('nutrition-' + safeDate + '-' + String(m.meal_type || 'meal')).replace(/[^a-z0-9_-]/gi, '');
          const signed = buildSignedPhotoUrl(baseUrl, m.id, 60 * 60 * 1000);
          if (signed) download_url = signed + '&dl=1&fn=' + encodeURIComponent(fnBase);
        }
        return { ...m, meal_confidence: confidenceFromLogRow(m), download_url };
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
        (process.env.ANTHROPIC_MODEL_NUTRITION || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim();

      const targetUserId = String(req.params.userId || '').trim();
      if (!targetUserId) return res.status(400).json({ error: 'Invalid userId' });

      const u = await queryOne('SELECT id FROM users WHERE id = ?', [targetUserId]);
      if (!u) return res.status(404).json({ error: 'User not found' });

      const ymd = ymdOrToday(req.body, req.query);

      const rows = await queryAll(
        `SELECT meal_type, photo_data, photo_mime, manual_note, portion_size, ai_result
         FROM nutrition_meal_logs
         WHERE user_id = ? AND log_date = ?::date`,
        [targetUserId, ymd]
      );

      const results = [];
      const errors = [];

      for (const row of rows || []) {
        const mt = String(row.meal_type || '').toLowerCase();
        if (!MEAL_TYPES.has(mt)) continue;

        const note = String(row.manual_note || '').trim();
        const img = row.photo_data ? String(row.photo_data).replace(/\s/g, '') : '';
        if (!note) {
          errors.push({ mealType: mt, error: 'Text meal details are required for re-analysis.' });
          continue;
        }
        if (img && approxDecodedBytesFromBase64(img) > NUTRITION_IMAGE_DECODE_LIMIT_BYTES) {
          errors.push({
            mealType: mt,
            error:
              'Stored photo is too large for AI analysis (over 4.5 MB). Ask the user to re-log the meal with a smaller image.'
          });
          continue;
        }
        const prevAr = parseAiResultRow(row.ai_result);
        const entrySrc = prevAr._bbEntrySource === 'manual' ? 'manual' : 'ai';
        const mealValidation = await validateNutritionMealInput({
          apiKey,
          model,
          imageBase64: img || null,
          mimeType: row.photo_mime || 'image/jpeg',
          mealType: mt,
          manualNote: note
        });
        if (!mealValidation.isFoodMeal) {
          errors.push({ mealType: mt, error: 'Input does not look like a valid food meal.' });
          continue;
        }

        const ps = String(row.portion_size || 'medium').toLowerCase();
        const portion = ['small', 'medium', 'large'].includes(ps) ? ps : 'medium';

        try {
          const { aiResult: aiRaw, usage } = await callClaudeNutrition({
            apiKey,
            model,
            imageBase64: img || null,
            mimeType: row.photo_mime || 'image/jpeg',
            mealType: mt,
            portionSize: portion,
            manualNote: note
          });
          const mealScore = computeMealScore(aiRaw);
          const aiResult = buildAiResultForStorage(aiRaw, { analyzedWithPhoto: !!img, entrySource: entrySrc });

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
          'SELECT id, first_name, last_name, email, profile_picture FROM users WHERE id = ?',
          [uid]
        );
        if (!u) continue;
        await recomputeDailyStats(db, uid, ymd);
        const meals = await queryAll(
          `SELECT meal_type, photo_data, photo_mime, ai_result, ai_usage, meal_score, manual_note, notified_at, photo_upload_count
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
          profile_picture: u.profile_picture || '',
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

async function runAdminNutritionDailyEmailJob({ queryAll, reportDateYmd, adminEmail }) {
  if (!userEmail.isConfigured()) return false;
  const to = String(adminEmail || process.env.NUTRITION_ADMIN_REPORT_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!to) return false;

  const todayYmd = todayYmdInTz(STREAK_TZ) || new Date().toISOString().slice(0, 10);
  const targetYmd = String(reportDateYmd || '').trim() || String(
    new Date(new Date(todayYmd + 'T00:00:00Z').getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );

  const rows = await queryAll(
    `SELECT
       u.id AS user_id,
       u.first_name,
       u.last_name,
       u.email,
       COALESCE(ds.total_calories, 0) AS total_calories,
       COALESCE(ds.total_protein, 0) AS total_protein,
       ds.meal_quality_score,
       ds.energy_difference,
       COUNT(n.id)::int AS meals_logged,
       COUNT(*) FILTER (WHERE n.photo_upload_count > 0)::int AS meals_with_photo_uploads,
       COUNT(*) FILTER (WHERE n.photo_data IS NOT NULL)::int AS meals_with_photo_available
     FROM nutrition_meal_logs n
     JOIN users u ON u.id = n.user_id
     LEFT JOIN nutrition_daily_stats ds ON ds.user_id = n.user_id AND ds.stat_date = n.log_date
     WHERE n.log_date = ?::date
     GROUP BY
       u.id, u.first_name, u.last_name, u.email,
       ds.total_calories, ds.total_protein, ds.meal_quality_score, ds.energy_difference
     ORDER BY u.email ASC`,
    [targetYmd]
  );

  const users = rows || [];
  const totals = users.reduce(
    (acc, r) => {
      acc.users += 1;
      acc.meals += Number(r.meals_logged) || 0;
      acc.photosUploaded += Number(r.meals_with_photo_uploads) || 0;
      acc.photosAvailable += Number(r.meals_with_photo_available) || 0;
      acc.calories += Number(r.total_calories) || 0;
      if (r.meal_quality_score != null) {
        acc.scoreSum += Number(r.meal_quality_score) || 0;
        acc.scoreN += 1;
      }
      return acc;
    },
    { users: 0, meals: 0, photosUploaded: 0, photosAvailable: 0, calories: 0, scoreSum: 0, scoreN: 0 }
  );

  const avgScore = totals.scoreN ? (totals.scoreSum / totals.scoreN).toFixed(1) : '—';
  const adminNutritionUrl = `${(process.env.APP_BASE_URL || process.env.SITE_URL || 'https://bodybank.fit').replace(/\/$/, '')}/?adminNutrition=1`;
  const exportHint = `Use Admin > Nutrition > date ${targetYmd} > Export CSV / Download image in dashboard.`;

  const ok = await userEmail.emailAdminNutritionDailySummary(to, {
    date: targetYmd,
    aggregate: {
      users: totals.users,
      meals: totals.meals,
      photosUploaded: totals.photosUploaded,
      photosAvailable: totals.photosAvailable,
      avgScore,
      totalCalories: totals.calories
    },
    users: users.map((r) => ({
      userName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
      userEmail: r.email,
      mealsLogged: Number(r.meals_logged) || 0,
      photosUploaded: Number(r.meals_with_photo_uploads) || 0,
      photosAvailable: Number(r.meals_with_photo_available) || 0,
      photosExpired: Math.max(0, (Number(r.meals_with_photo_uploads) || 0) - (Number(r.meals_with_photo_available) || 0)),
      calories: Number(r.total_calories) || 0,
      protein: Number(r.total_protein) || 0,
      score: r.meal_quality_score != null ? Number(r.meal_quality_score).toFixed(1) : '—'
    })),
    adminNutritionUrl,
    exportHint
  });

  if (ok) {
    console.log(`[nutrition] Admin daily digest emailed to ${to} for ${targetYmd} (${totals.users} users).`);
  } else {
    console.warn(`[nutrition] Admin daily digest failed for ${to} (${targetYmd}).`);
  }
  return ok;
}

module.exports = { createNutritionRouter, sendNutritionNotifications, runWeeklyNutritionEmailJob, runAdminNutritionDailyEmailJob };
