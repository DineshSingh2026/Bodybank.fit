'use strict';

/**
 * FitChef Nutrition Assessment — prefill.
 *
 * The point of this file: a BodyBank member has already told us their height,
 * their diet type, their injuries, their smoking and drinking, and they log
 * steps, water and sleep every single day. Asking again is not "thorough", it
 * is the reason long forms get abandoned. So every answer we can already
 * evidence is looked up here, tagged with WHERE it came from and HOW OLD it is,
 * and shown to the member as something to confirm rather than something to type.
 *
 * Each returned entry is { value, source, at } where `source` is the sentence
 * shown under the field ("from your daily check-ins — 30-day average"). If we
 * cannot evidence a value we simply omit the key; the field renders empty.
 *
 * Nothing here throws. A prefill that fails is a slower form, not a broken one,
 * so every lookup is wrapped and the caller always gets an object.
 */

const SRC = {
  profile: 'from your BodyBank profile',
  daily: 'from your daily check-ins',
  sunday: 'from your Sunday check-in',
  part2: 'from your Part-2 form',
  blood: 'from your latest blood report',
  body: 'from your body log',
  goals: 'from your goal settings',
  audit: 'from your audit form',
  invite: 'from the invite we sent you'
};

function put(out, key, value, source, at) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' && !value.trim()) return;
  if (Array.isArray(value) && !value.length) return;
  if (out[key]) return; // first writer wins — sources are consulted best-first
  out[key] = { value, source: source || '', at: at || null };
}

/** Band helpers — the form asks for bands, the DB stores numbers. */
function stepsBand(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 3000) return '<3k';
  if (n < 5000) return '3–5k';
  if (n < 8000) return '5–8k';
  if (n < 12000) return '8–12k';
  return '12k+';
}
function waterBand(ml) {
  if (!Number.isFinite(ml)) return null;
  const l = ml / 1000;
  if (l < 1) return '<1';
  if (l < 2) return '1–2';
  if (l < 3) return '2–3';
  if (l < 4) return '3–4';
  return '4+';
}
function sleepBand(h) {
  if (!Number.isFinite(h)) return null;
  if (h < 5) return '<5';
  if (h < 6) return '5–6';
  if (h < 7) return '6–7';
  if (h < 8) return '7–8';
  return '8+';
}
function trainsBand(daysPerWeek) {
  const n = Number(daysPerWeek);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 'Not currently';
  if (n <= 2) return '1–2× week';
  if (n <= 4) return '3–4× week';
  if (n <= 6) return '5–6× week';
  return 'Daily';
}

/** A 1–10 answer, or nothing. A stored 0 is "never set", not "completely calm". */
function inScale(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : null;
}

/** Body-fat percentages outside human range are junk rows, not answers. */
function plausibleBodyFat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 5 && n <= 70 ? Math.round(n * 10) / 10 : null;
}

/** Free-text answers from older forms only prefill when they map cleanly. */
function mapSex(gender) {
  const g = String(gender || '').trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'Male';
  if (g === 'female' || g === 'f') return 'Female';
  if (g) return 'Prefer to self-describe';
  return null;
}

const GOAL_MAP = [
  [/fat.?loss|weight.?loss|lose/i, 'Fat loss'],
  [/muscle|bulk|mass|gain/i, 'Muscle gain'],
  [/recomp/i, 'Body recomposition'],
  [/maintain|clean/i, 'Maintain & eat cleaner'],
  [/sport|endurance|performance|marathon/i, 'Sports or endurance performance'],
  [/diabet|thyroid|pcos|medical|condition|cholesterol/i, 'Manage a medical condition'],
  [/energy|digest|gut|bloat/i, 'Fix energy & digestion']
];
function mapGoal(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [re, label] of GOAL_MAP) if (re.test(t)) return label;
  return null;
}

const DIET_MAP = [
  [/^\s*vegan/i, 'Vegan'],
  [/eggetarian|egg.?eating|ovo/i, 'Eggetarian'],
  [/jain/i, 'Jain'],
  [/satvik|sattvic|no onion/i, 'Satvik (no onion-garlic)'],
  [/keto/i, 'Keto'],
  [/non.?veg|nonveg|omnivore|chicken|meat/i, 'Non-vegetarian'],
  [/veg/i, 'Vegetarian']
];
function mapDiet(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [re, label] of DIET_MAP) if (re.test(t)) return label;
  return null;
}

const SMOKING_MAP = [[/never|non.?smok|no\b/i, 'Never'], [/daily|every ?day|regular|pack/i, 'Daily'], [/occasion|social|sometimes|rare/i, 'Occasionally']];
function mapSmoking(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [re, label] of SMOKING_MAP) if (re.test(t)) return label;
  return null;
}

const ALCOHOL_MAP = [
  [/never|teetotal|don'?t drink|no\b/i, 'Never'],
  [/most days|daily|every ?day/i, 'Most days'],
  [/2.?3|twice|thrice|couple times a week/i, '2–3× a week'],
  [/week/i, 'Weekly'],
  [/month/i, 'Monthly'],
  [/year|occasion|rare|social/i, 'Few times a year']
];
function mapAlcohol(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [re, label] of ALCOHOL_MAP) if (re.test(t)) return label;
  return null;
}

const OCCUPATION_MAP = [
  [/desk|it |software|office|seated|sedentary/i, 'Desk'],
  [/field|sales|travel/i, 'Field or travel-heavy'],
  [/labour|labor|construction|manual|physical/i, 'Physical labour'],
  [/shift|night/i, 'Shift or night work'],
  [/student|college|school/i, 'Student'],
  [/homemaker|housewife/i, 'Homemaker'],
  [/unemploy|between jobs|not working/i, 'Between jobs']
];
function mapOccupation(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [re, label] of OCCUPATION_MAP) if (re.test(t)) return label;
  return null;
}

/** Pull the labs the assessment asks for out of an extracted blood report. */
const LAB_PATTERNS = {
  hba1c: /hba1c|glycated|glycosylated/i,
  fasting_glucose: /fasting.*(glucose|sugar)|glucose.*fasting|\bfbs\b/i,
  tsh: /\btsh\b|thyroid stimulating/i,
  vitamin_d: /vitamin\s*d|25.?oh|cholecalciferol/i,
  b12: /b\s*-?\s*12|cobalamin/i,
  ferritin: /ferritin/i,
  haemoglobin: /h(a)?emoglobin|\bhb\b/i,
  ldl: /\bldl\b/i,
  hdl: /\bhdl\b/i,
  triglycerides: /triglyceride/i,
  alt: /\balt\b|sgpt/i,
  uric_acid: /uric acid/i,
  creatinine: /creatinine/i
};

function labsFromExtract(extracted) {
  const labs = {};
  if (!extracted) return labs;
  let panels = extracted.panels || extracted.Panels || null;
  if (!Array.isArray(panels)) {
    if (Array.isArray(extracted.markers)) panels = [{ markers: extracted.markers }];
    else return labs;
  }
  panels.forEach((p) => {
    (p && Array.isArray(p.markers) ? p.markers : []).forEach((m) => {
      const name = String((m && m.name) || '');
      if (!name) return;
      const num = parseFloat(String((m && m.value) || '').replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(num)) return;
      Object.keys(LAB_PATTERNS).forEach((key) => {
        // LDL/HDL both match "cholesterol" rows loosely, so the first clean hit wins.
        if (labs[key] === undefined && LAB_PATTERNS[key].test(name)) labs[key] = num;
      });
    });
  });
  return labs;
}

/**
 * pg hands a DATE column back as a JS Date, and String(new Date()) is
 * "Mon Aug 26 2002 ..." — slicing ten characters off that produced "Mon Aug 26"
 * and an <input type="date"> silently refused it. Always go through here.
 */
function isoDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/**
 * Build the prefill payload.
 *
 * @param {object} db      { queryOne, queryAll }
 * @param {object} who     { userId, email, name, mobile } — userId optional (cold/invited lead)
 * @returns {Promise<{ known: object, isMember: boolean, sources: string[] }>}
 */
async function buildPrefill(db, who = {}) {
  const out = {};
  const sources = new Set();
  const userId = who.userId ? String(who.userId) : '';
  let email = who.email ? String(who.email).trim() : '';

  const safe = async (label, fn) => {
    try { const touched = await fn(); if (touched) sources.add(label); }
    catch (e) { /* a missing table or column must never break the form */ }
  };

  // ── 1. The member record: the widest single source ────────────────────────
  let user = null;
  if (userId) {
    await safe(SRC.profile, async () => {
      user = await db.queryOne(
        `SELECT id, first_name, last_name, email, phone, city, dob, gender, height_cm,
                goal_type, primary_training_days_per_week, diet_type, injury_limitations,
                stress_level_baseline, created_at
         FROM users WHERE id = ?`, [userId]
      );
      if (!user) return false;
      email = email || String(user.email || '');
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
      put(out, 'full_name', name, SRC.profile);
      put(out, 'email', user.email, SRC.profile);
      put(out, 'mobile', user.phone, SRC.profile);
      put(out, 'city', user.city, SRC.profile);
      put(out, 'dob', isoDate(user.dob), SRC.profile);
      put(out, 'sex', mapSex(user.gender), SRC.profile);
      if (Number.isFinite(Number(user.height_cm)) && Number(user.height_cm) > 0) {
        put(out, 'height_cm', Number(user.height_cm), SRC.profile);
      }
      put(out, 'goal_primary', mapGoal(user.goal_type), SRC.profile);
      put(out, 'diet_type', mapDiet(user.diet_type), SRC.profile);
      put(out, 'injuries', user.injury_limitations, SRC.profile);
      // A NULL training-days column reads as "not currently", which is a real
      // answer we have not earned — only band an actual number.
      if (user.primary_training_days_per_week != null) {
        put(out, 'trains', trainsBand(user.primary_training_days_per_week), SRC.profile);
      }
      put(out, 'stress_level', inScale(user.stress_level_baseline), SRC.profile);
      return true;
    });
  }

  // Invited-but-not-a-member: the admin already typed these into the invite.
  put(out, 'full_name', who.name, SRC.invite);
  put(out, 'email', who.email, SRC.invite);
  put(out, 'mobile', who.mobile, SRC.invite);

  // ── 2. Body numbers — newest wins across the three places we record them ──
  if (userId) {
    await safe(SRC.body, async () => {
      const snap = await db.queryOne(
        `SELECT bodyweight_kg, waist_cm, snapshot_date, created_at
         FROM body_snapshots WHERE user_id = ?
         ORDER BY COALESCE(snapshot_date, created_at::text) DESC LIMIT 1`, [userId]
      );
      const wlog = await db.queryOne(
        `SELECT weight_kg, created_at FROM weight_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]
      );
      const plog = await db.queryOne(
        `SELECT weight, body_fat, created_at FROM progress_logs WHERE user_id = ? AND weight IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`, [userId]
      );

      const candidates = [
        snap && snap.bodyweight_kg != null ? { w: Number(snap.bodyweight_kg), at: snap.created_at } : null,
        wlog ? { w: Number(wlog.weight_kg), at: wlog.created_at } : null,
        plog ? { w: Number(plog.weight), at: plog.created_at } : null
      ].filter((c) => c && Number.isFinite(c.w) && c.w > 0);
      candidates.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
      if (candidates[0]) put(out, 'weight_kg', Math.round(candidates[0].w * 10) / 10, SRC.body, candidates[0].at);

      if (snap && snap.waist_cm != null && Number(snap.waist_cm) > 0) {
        put(out, 'waist_cm', Number(snap.waist_cm), SRC.body, snap.created_at);
      }
      if (plog) put(out, 'body_fat_pct', plausibleBodyFat(plog.body_fat), SRC.body, plog.created_at);

      // Six months back, for the trajectory question the spec asks for.
      const old = await db.queryOne(
        `SELECT weight_kg, created_at FROM weight_logs
         WHERE user_id = ? AND created_at <= NOW() - INTERVAL '5 months'
         ORDER BY created_at DESC LIMIT 1`, [userId]
      );
      if (old && Number(old.weight_kg) > 0) {
        put(out, 'weight_6mo', Math.round(Number(old.weight_kg) * 10) / 10, SRC.body, old.created_at);
      }
      return !!(candidates[0] || (snap && snap.waist_cm));
    });

    // ── 3. Daily check-ins — the member logs these every day, so a 30-day
    //       average is a far better answer than whatever they'd type today. ──
    await safe(SRC.daily, async () => {
      const avg = await db.queryOne(
        `SELECT AVG(NULLIF(steps,0))::numeric      AS steps,
                AVG(NULLIF(water_ml,0))::numeric   AS water_ml,
                AVG(NULLIF(sleep_hours,0))::numeric AS sleep_hours,
                COUNT(*)::int                       AS n
         FROM daily_checkins
         WHERE user_id = ? AND checkin_date >= CURRENT_DATE - INTERVAL '30 days'
           AND COALESCE(is_freeze, FALSE) = FALSE`, [userId]
      );
      if (!avg || !Number(avg.n)) return false;
      const label = SRC.daily + ' — ' + avg.n + '-day average';
      put(out, 'daily_steps', stepsBand(Number(avg.steps)), label);
      put(out, 'water_litres', waterBand(Number(avg.water_ml)), label);
      put(out, 'sleep_hours', sleepBand(Number(avg.sleep_hours)), label);
      return true;
    });

    // ── 4. Sunday check-in — stress, and a waist number if the body log had none
    await safe(SRC.sunday, async () => {
      const s = await db.queryOne(
        `SELECT occupation_stress, sleep, body_fat_percent, created_at
         FROM sunday_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]
      );
      if (!s) return false;
      put(out, 'body_fat_pct', plausibleBodyFat(s.body_fat_percent), SRC.sunday, s.created_at);
      put(out, 'stress_level', inScale(String(s.occupation_stress || '').replace(/[^0-9]/g, '')), SRC.sunday, s.created_at);
      return true;
    });

    // ── 5. Goals
    await safe(SRC.goals, async () => {
      const g = await db.queryOne(
        `SELECT target_weight, created_at FROM user_goals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]
      );
      if (!g || g.target_weight == null) return false;
      put(out, 'target_weight', Number(g.target_weight), SRC.goals, g.created_at);
      return true;
    });

    // ── 6. Latest blood report — the labs step is the slowest one to type ────
    await safe(SRC.blood, async () => {
      const r = await db.queryOne(
        `SELECT extracted_blood_data, COALESCE(report_date, created_at::date) AS lab_date, created_at
         FROM blood_analysis_reports
         WHERE user_id = ? AND extracted_blood_data IS NOT NULL
         ORDER BY COALESCE(report_date, created_at::date) DESC LIMIT 1`, [userId]
      );
      if (!r) return false;
      const labs = labsFromExtract(parseJson(r.extracted_blood_data));
      if (!Object.keys(labs).length) return false;
      const when = r.lab_date ? String(r.lab_date).slice(0, 10) : '';
      const label = SRC.blood + (when ? ' (' + when + ')' : '');
      put(out, 'has_bloodwork', 'Yes', label, r.created_at);
      put(out, 'labs', labs, label, r.created_at);
      // The condition follow-ups ask for three of these individually.
      if (labs.hba1c != null) put(out, 'hba1c_value', labs.hba1c, label, r.created_at);
      if (labs.tsh != null) put(out, 'tsh_value', labs.tsh, label, r.created_at);
      if (labs.uric_acid != null) put(out, 'uric_acid_value', labs.uric_acid, label, r.created_at);
      return true;
    });
  }

  // ── 7. Part-2 form — matched on email so it works for leads too ───────────
  if (email) {
    await safe(SRC.part2, async () => {
      const p = await db.queryOne(
        `SELECT name, mobile, injuries, food_choices, vices_addictions, activity_level,
                workouts_per_week, sleep_hours, stress_level, smoking, alcohol,
                height_cm, bodyweight_kg, created_at
         FROM part2_audit WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1`, [email]
      );
      if (!p) return false;
      put(out, 'full_name', p.name, SRC.part2, p.created_at);
      put(out, 'mobile', p.mobile, SRC.part2, p.created_at);
      put(out, 'injuries', p.injuries, SRC.part2, p.created_at);
      put(out, 'diet_type', mapDiet(p.food_choices), SRC.part2, p.created_at);
      put(out, 'smoking', mapSmoking(p.smoking || p.vices_addictions), SRC.part2, p.created_at);
      put(out, 'alcohol_frequency', mapAlcohol(p.alcohol || p.vices_addictions), SRC.part2, p.created_at);
      put(out, 'trains', trainsBand(String(p.workouts_per_week || '').replace(/[^0-9]/g, '')), SRC.part2, p.created_at);
      put(out, 'sleep_hours', sleepBand(parseFloat(String(p.sleep_hours || '').replace(/[^0-9.]/g, ''))), SRC.part2, p.created_at);
      put(out, 'stress_level', inScale(p.stress_level), SRC.part2, p.created_at);
      if (Number.isFinite(Number(p.height_cm)) && Number(p.height_cm) > 0) {
        put(out, 'height_cm', Number(p.height_cm), SRC.part2, p.created_at);
      }
      if (Number.isFinite(Number(p.bodyweight_kg)) && Number(p.bodyweight_kg) > 0) {
        put(out, 'weight_kg', Number(p.bodyweight_kg), SRC.part2, p.created_at);
      }
      return true;
    });

    // ── 8. Audit form — the oldest source, so it fills only what is still blank
    await safe(SRC.audit, async () => {
      const a = await db.queryOne(
        `SELECT first_name, last_name, age, sex, phone, city, occupation, work_intensity, goals, created_at
         FROM audit_requests WHERE LOWER(email) = LOWER(?) ORDER BY created_at DESC LIMIT 1`, [email]
      );
      if (!a) return false;
      put(out, 'full_name', [a.first_name, a.last_name].filter(Boolean).join(' ').trim(), SRC.audit, a.created_at);
      put(out, 'mobile', a.phone, SRC.audit, a.created_at);
      put(out, 'city', a.city, SRC.audit, a.created_at);
      put(out, 'sex', mapSex(a.sex), SRC.audit, a.created_at);
      put(out, 'occupation_type', mapOccupation([a.occupation, a.work_intensity].filter(Boolean).join(' ')), SRC.audit, a.created_at);
      put(out, 'goal_primary', mapGoal(a.goals), SRC.audit, a.created_at);
      return true;
    });
  }

  return { known: out, isMember: !!userId, sources: Array.from(sources) };
}

module.exports = { buildPrefill, labsFromExtract, stepsBand, waterBand, sleepBand, trainsBand };
