'use strict';

/**
 * BodyBank — HEALTH MAP 360: CALCULATED INDICES AND CROSS-MARKER PATTERNS.
 *
 * The Health Map grades each area on its own. This module does the next thing a
 * doctor does: it reads the results TOGETHER. Two outputs, both deterministic:
 *
 *   indices   numbers worked out from two or more results (triglyceride/HDL
 *             ratio, non-HDL cholesterol, estimated kidney filtration ...)
 *   patterns  findings that only exist as a combination (low haemoglobin WITH
 *             small red cells; raised triglycerides WITH low HDL ...)
 *
 * ─── RULES THIS FILE KEEPS ────────────────────────────────────────────────────
 *  1. Pure. No I/O, no clock, no AI. Same report in, same reading out.
 *  2. Standard arithmetic only. Every index here is a published, widely used
 *     calculation. There is no BodyBank "score", "age" or composite of our own.
 *  3. Never guess a unit. A value takes part in a calculation only after the
 *     marker registry has converted it to its canonical unit; a result printed in
 *     a unit the registry does not know is left out, not assumed.
 *  4. A pattern is a reason to look, never a diagnosis. The wording says what a
 *     combination "points to" and what would confirm it.
 *
 * Input is the stored HealthReport (services/gradedHealthReport.js), so this
 * costs nothing to run and can be rebuilt at any time.
 */

const { getMarker, toCanonicalUnit } = require('../grading/markerRegistry');

const LEVEL = { OK: 0, WATCH: 1, FLAG: 2, INFO: -1 };

function isLow(status) { return /LOW$/.test(String(status || '')); }
function isHigh(status) { return /HIGH$/.test(String(status || '')); }
/** Clearly outside range, not merely in the borderline band. */
function isAbnormalLow(status) { return status === 'LOW' || status === 'CRITICAL_LOW'; }
function isAbnormalHigh(status) { return status === 'HIGH' || status === 'CRITICAL_HIGH'; }

function fmt(n, dp) {
  if (!Number.isFinite(n)) return '';
  return Number(n).toFixed(dp == null ? 1 : dp);
}

/**
 * Index the report's markers by canonical id.
 * @returns {Map<string, {id, name, result, status, value:number|null}>}
 *          `value` is in the registry's canonical unit, or null when it could
 *          not be converted with certainty.
 */
function indexMarkers(report) {
  const map = new Map();
  ((report && report.markerGroups) || []).forEach((g) => {
    (g.markers || []).forEach((m) => {
      if (!m || !m.markerId || m.duplicate || map.has(m.markerId)) return;
      const reg = getMarker(m.markerId);
      const num = typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
      const conv = reg && num != null ? toCanonicalUnit(reg, num, m.unit) : null;
      map.set(m.markerId, {
        id: m.markerId,
        name: m.displayName || (reg && reg.display) || m.markerId,
        result: m.result || '',
        status: m.status || 'NOT_AVAILABLE',
        value: conv ? conv.value : null
      });
    });
  });
  return map;
}

function sexOf(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s.startsWith('m')) return 'male';
  if (s.startsWith('f')) return 'female';
  return '';
}

function ageOf(v) {
  const n = parseInt(String(v == null ? '' : v), 10);
  return n >= 5 && n <= 110 ? n : null;
}

// ---------------------------------------------------------------------------
// Calculated indices
// ---------------------------------------------------------------------------

/**
 * @param {object} report HealthReport
 * @param {object} [ctx]  { age, sex, fasting: 'yes'|'no'|'unsure'|'', heightCm, weightKg }
 * @returns {Array<{key,label,result,range,status,level,note,basis}>}
 */
function buildIndices(report, ctx) {
  const c = ctx || {};
  const M = indexMarkers(report);
  const v = (id) => (M.has(id) ? M.get(id).value : null);
  const has = (id) => v(id) != null;
  const out = [];
  const push = (o) => out.push(Object.assign({ range: '', level: LEVEL.INFO, note: '', basis: '' }, o));

  const tg = v('TRIGLYCERIDES'), hdl = v('HDL_C'), ldl = v('LDL_C'), tc = v('TOTAL_CHOL');

  if (tg != null && hdl != null && hdl > 0) {
    const r = tg / hdl;
    const level = r > 3 ? LEVEL.FLAG : r > 2 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'TG_HDL', label: 'Triglyceride / HDL ratio', result: fmt(r, 1), range: 'preferred below 2.0',
      status: level === LEVEL.FLAG ? 'Raised' : level === LEVEL.WATCH ? 'Borderline' : 'Favourable', level,
      basis: `Triglycerides ${fmt(tg, 0)} / HDL ${fmt(hdl, 0)} mg/dL`,
      note: level === LEVEL.OK
        ? 'A low ratio suggests your body is handling fats and sugars efficiently.'
        : 'This ratio rises when the body is becoming resistant to insulin, often years before blood sugar itself moves. It responds well to fewer refined carbohydrates, less alcohol and regular activity.'
    });
  }

  if (tc != null && hdl != null && !M.has('NON_HDL_C')) {
    const r = tc - hdl;
    const level = r >= 160 ? LEVEL.FLAG : r >= 130 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'NON_HDL', label: 'Non-HDL cholesterol', result: `${fmt(r, 0)} mg/dL`, range: 'preferred below 130',
      status: level === LEVEL.FLAG ? 'Raised' : level === LEVEL.WATCH ? 'Borderline' : 'Favourable', level,
      basis: `Total cholesterol ${fmt(tc, 0)} minus HDL ${fmt(hdl, 0)}`,
      note: 'Non-HDL adds up every cholesterol particle that can deposit in artery walls, so it is a steadier guide than LDL alone, especially when triglycerides are raised.'
    });
  }

  if (tc != null && hdl != null && hdl > 0 && !M.has('CHOL_HDL_RATIO')) {
    const r = tc / hdl;
    const level = r > 5 ? LEVEL.FLAG : r > 3.5 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'TC_HDL', label: 'Total cholesterol / HDL ratio', result: fmt(r, 1), range: 'preferred below 3.5',
      status: level === LEVEL.FLAG ? 'Raised' : level === LEVEL.WATCH ? 'Acceptable' : 'Favourable', level,
      basis: `Total cholesterol ${fmt(tc, 0)} / HDL ${fmt(hdl, 0)}`,
      note: 'This compares all cholesterol with the protective fraction. A lower number means a larger share of your cholesterol is the protective kind.'
    });
  }

  if (tc != null && hdl != null && ldl != null) {
    const r = tc - hdl - ldl;
    if (r >= 0) {
      const level = r > 30 ? LEVEL.WATCH : LEVEL.OK;
      push({
        key: 'REMNANT', label: 'Remnant cholesterol', result: `${fmt(r, 0)} mg/dL`, range: 'preferred below 30',
        status: level === LEVEL.WATCH ? 'Raised' : 'Favourable', level,
        basis: `Total ${fmt(tc, 0)} minus HDL ${fmt(hdl, 0)} minus LDL ${fmt(ldl, 0)}`,
        note: 'Remnant cholesterol travels with triglycerides. It tends to fall when triglycerides fall.'
      });
    }
  }

  const a1c = v('HBA1C');
  if (a1c != null && a1c >= 3 && a1c <= 20) {
    push({
      key: 'EAG', label: 'Estimated average glucose', result: `${fmt(28.7 * a1c - 46.7, 0)} mg/dL`, range: '',
      status: 'For reference', level: LEVEL.INFO,
      basis: `From HbA1c ${fmt(a1c, 1)} %`,
      note: 'HbA1c reflects about three months of blood sugar. This is the same result expressed as an average glucose reading, the number a home glucose meter shows.'
    });
  }

  const glu = v('FASTING_GLUCOSE'), ins = v('FASTING_INSULIN');
  if (glu != null && ins != null && !M.has('HOMA_IR') && c.fasting !== 'no') {
    const r = (glu * ins) / 405;
    const level = r > 2.5 ? LEVEL.FLAG : r >= 2 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'HOMA_IR', label: 'HOMA-IR (insulin resistance index)', result: fmt(r, 1), range: 'preferred below 2.0',
      status: level === LEVEL.FLAG ? 'Raised' : level === LEVEL.WATCH ? 'Borderline' : 'Favourable', level,
      basis: `Fasting glucose ${fmt(glu, 0)} mg/dL x fasting insulin ${fmt(ins, 1)} / 405`,
      note: 'HOMA-IR estimates how hard your body has to work to keep blood sugar normal. It is only valid on a fasting sample.'
    });
  }

  const cr = v('CREATININE');
  const age = ageOf(c.age), sex = sexOf(c.sex);
  if (cr != null && cr > 0 && age != null && age >= 18 && sex && !M.has('EGFR')) {
    // CKD-EPI 2021 creatinine equation (race-free).
    const k = sex === 'female' ? 0.7 : 0.9;
    const a = sex === 'female' ? -0.241 : -0.302;
    const egfr = 142 * Math.pow(Math.min(cr / k, 1), a) * Math.pow(Math.max(cr / k, 1), -1.2)
      * Math.pow(0.9938, age) * (sex === 'female' ? 1.012 : 1);
    const level = egfr < 60 ? LEVEL.FLAG : egfr < 90 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'EGFR', label: 'Estimated kidney filtration (eGFR)', result: `${fmt(egfr, 0)} mL/min/1.73m2`, range: '90 or above',
      status: level === LEVEL.FLAG ? 'Reduced' : level === LEVEL.WATCH ? 'Mildly reduced' : 'Normal', level,
      basis: `From creatinine ${fmt(cr, 2)} mg/dL, age ${age}, ${sex} (CKD-EPI 2021)`,
      note: level === LEVEL.OK
        ? 'Your kidneys are filtering at a normal rate.'
        : 'eGFR is worked out from creatinine, which also rises with high muscle mass, a high-protein diet, creatine supplements and hard training the day before. A repeat test after two rest days gives a truer picture.'
    });
  }

  const alt = v('ALT'), ast = v('AST'), plt = v('PLATELETS');
  const liverOff = ['ALT', 'AST', 'GGT'].some((id) => M.has(id) && isHigh(M.get(id).status));
  if (alt != null && ast != null && alt > 0 && liverOff) {
    push({
      key: 'AST_ALT', label: 'AST / ALT ratio', result: fmt(ast / alt, 2), range: '',
      status: 'For your doctor', level: LEVEL.INFO,
      basis: `AST ${fmt(ast, 0)} / ALT ${fmt(alt, 0)} U/L`,
      note: 'When liver enzymes are raised, which one leads helps your doctor judge the likely cause. A ratio below 1 is the usual picture with fat in the liver.'
    });
    if (plt != null && plt > 0 && age != null && age >= 35 && age <= 65) {
      const fib = (age * ast) / (plt * Math.sqrt(alt));
      const level = fib > 2.67 ? LEVEL.FLAG : fib >= 1.3 ? LEVEL.WATCH : LEVEL.OK;
      push({
        key: 'FIB4', label: 'FIB-4 index', result: fmt(fib, 2), range: 'below 1.3',
        status: level === LEVEL.FLAG ? 'Needs review' : level === LEVEL.WATCH ? 'Indeterminate' : 'Low', level,
        basis: `Age ${age}, AST ${fmt(ast, 0)}, ALT ${fmt(alt, 0)}, platelets ${fmt(plt, 0)}`,
        note: 'FIB-4 is a screening calculation doctors use to decide whether a liver scan is worth doing. It cannot diagnose anything on its own.'
      });
    }
  }

  const neut = v('NEUTROPHILS'), lymph = v('LYMPHOCYTES');
  if (neut != null && lymph != null && lymph > 0) {
    const r = neut / lymph;
    const level = r > 3 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'NLR', label: 'Neutrophil / lymphocyte ratio', result: fmt(r, 1), range: 'typically 1 to 3',
      status: level === LEVEL.WATCH ? 'Raised' : 'Typical', level,
      basis: `Neutrophils ${fmt(neut, 0)} % / lymphocytes ${fmt(lymph, 0)} %`,
      note: 'This ratio rises with physical stress on the body: a recent infection, very hard training, poor sleep or ongoing inflammation. It is non-specific and best read with how you have been feeling.'
    });
  }

  const mcv = v('MCV'), rbc = v('RBC');
  if (mcv != null && rbc != null && rbc > 0 && M.has('MCV') && isLow(M.get('MCV').status)) {
    const r = mcv / rbc;
    push({
      key: 'MENTZER', label: 'Mentzer index', result: fmt(r, 1), range: '',
      status: r < 13 ? 'Below 13' : 'Above 13', level: LEVEL.INFO,
      basis: `MCV ${fmt(mcv, 0)} fL / RBC ${fmt(rbc, 2)} million`,
      note: r < 13
        ? 'With small red cells, a value below 13 makes an inherited trait such as thalassaemia more likely than iron deficiency. A haemoglobin electrophoresis test settles it. This matters because iron tablets do not help a trait.'
        : 'With small red cells, a value above 13 points towards iron deficiency rather than an inherited trait. Ferritin confirms it.'
    });
  }

  const ca = v('CALCIUM'), alb = v('ALBUMIN');
  if (ca != null && alb != null && alb < 4) {
    push({
      key: 'CORR_CA', label: 'Albumin-corrected calcium', result: `${fmt(ca + 0.8 * (4 - alb), 1)} mg/dL`, range: '',
      status: 'For reference', level: LEVEL.INFO,
      basis: `Calcium ${fmt(ca, 1)} mg/dL adjusted for albumin ${fmt(alb, 1)} g/dL`,
      note: 'Calcium travels bound to albumin, so a low albumin makes calcium read lower than it really is. This is the adjusted figure.'
    });
  }

  const h = Number(c.heightCm), w = Number(c.weightKg);
  if (h >= 120 && h <= 230 && w >= 30 && w <= 250) {
    const bmi = w / Math.pow(h / 100, 2);
    const level = bmi >= 25 ? LEVEL.FLAG : bmi >= 23 || bmi < 18.5 ? LEVEL.WATCH : LEVEL.OK;
    push({
      key: 'BMI', label: 'Body mass index', result: fmt(bmi, 1), range: '18.5 to 22.9 (Asian Indian range)',
      status: bmi < 18.5 ? 'Below range' : bmi < 23 ? 'In range' : bmi < 25 ? 'Above range' : 'Well above range', level,
      basis: `${fmt(w, 0)} kg at ${fmt(h, 0)} cm`,
      note: 'For people of Indian origin, health risk starts rising at a lower BMI than the international cut-offs, so the Indian range is used here. BMI cannot tell muscle from fat: if you carry a lot of muscle, waist size is the better guide.'
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cross-marker patterns
// ---------------------------------------------------------------------------

/**
 * @param {object} report HealthReport
 * @param {object} [ctx]  { age, sex, medicines:[keys], conditions:[keys] } — see personal.js
 * @param {Array}  [indices] output of buildIndices, so patterns can cite them
 * @returns {Array<{key,title,evidence:string[],meaning,action,level,requiresProfessional,focus:string[]}>}
 */
function buildPatterns(report, ctx, indices) {
  const c = ctx || {};
  const M = indexMarkers(report);
  const st = (id) => (M.has(id) ? M.get(id).status : '');
  const v = (id) => (M.has(id) ? M.get(id).value : null);
  const ev = (...ids) => ids.filter((id) => M.has(id)).map((id) => `${M.get(id).name} ${M.get(id).result}`);
  const idx = (key) => (indices || []).filter((i) => i.key === key)[0] || null;
  const meds = new Set(c.medicines || []);
  const out = [];
  const push = (o) => out.push(Object.assign({ level: LEVEL.WATCH, requiresProfessional: false, focus: [] }, o));

  // ── red cells ────────────────────────────────────────────────────────────
  const hbLow = isLow(st('HEMOGLOBIN'));
  const smallCells = isLow(st('MCV')) || isLow(st('MCH'));
  const largeCells = isHigh(st('MCV'));
  const ferrLow = isLow(st('FERRITIN'));
  if (hbLow && smallCells) {
    push({
      key: 'IRON_DEFICIENCY', title: 'Low haemoglobin with small red cells',
      evidence: ev('HEMOGLOBIN', 'MCV', 'MCH', 'FERRITIN', 'RDW'),
      meaning: ferrLow
        ? 'Low haemoglobin, small red cells and low iron stores together are the classic picture of iron-deficiency anaemia.'
        : 'Low haemoglobin with small red cells most often comes from low iron. An inherited trait such as thalassaemia can look the same, which is why iron stores need to be checked before treating.',
      action: M.has('FERRITIN')
        ? 'Ask your doctor what is causing the iron loss or low intake, and whether you need iron treatment.'
        : 'Ask your doctor for ferritin and iron studies before starting any iron supplement.',
      level: LEVEL.FLAG, requiresProfessional: true, focus: ['IRON']
    });
  } else if (hbLow && largeCells) {
    push({
      key: 'MACROCYTIC', title: 'Low haemoglobin with large red cells',
      evidence: ev('HEMOGLOBIN', 'MCV', 'VITAMIN_B12', 'FOLATE'),
      meaning: 'Low haemoglobin with larger-than-usual red cells points towards a shortage of vitamin B12 or folate, which the body needs to build red cells.',
      action: 'Ask your doctor to confirm B12 and folate levels and the reason they are low.',
      level: LEVEL.FLAG, requiresProfessional: true, focus: ['B12']
    });
  } else if (hbLow) {
    push({
      key: 'ANAEMIA', title: 'Low haemoglobin',
      evidence: ev('HEMOGLOBIN', 'MCV', 'RBC', 'HEMATOCRIT'),
      meaning: 'Your haemoglobin is below range while red cell size is normal. This has several possible causes, so it needs a doctor to work through them.',
      action: 'Ask your doctor which further tests are needed to find the cause.',
      level: LEVEL.FLAG, requiresProfessional: true, focus: ['IRON']
    });
  } else if (ferrLow) {
    push({
      key: 'LOW_IRON_STORES', title: 'Low iron stores, haemoglobin still normal',
      evidence: ev('FERRITIN', 'HEMOGLOBIN'),
      meaning: 'Your iron reserve is low although haemoglobin has not dropped yet. This is the stage before anaemia, and it can already cause tiredness, hair fall and poor training recovery.',
      action: 'Raise iron intake through food, and ask your doctor whether a supplement is appropriate.',
      level: LEVEL.WATCH, focus: ['IRON']
    });
  }

  if (isLow(st('VITAMIN_B12')) && !out.some((p) => p.key === 'MACROCYTIC')) {
    push({
      key: 'LOW_B12', title: 'Low vitamin B12',
      evidence: ev('VITAMIN_B12', 'MCV', 'HEMOGLOBIN'),
      meaning: 'B12 is low. It is needed for nerves and red cells, and low levels are very common on vegetarian diets and with long-term acidity or metformin medicines.',
      action: 'B12 usually needs a supplement or injections rather than food alone. Ask your doctor which is right for you.',
      level: LEVEL.WATCH, focus: ['B12']
    });
  }

  // ── sugar and insulin ────────────────────────────────────────────────────
  const a1c = v('HBA1C');
  const fg = v('FASTING_GLUCOSE');
  const sugarUp = (a1c != null && a1c >= 5.7) || (fg != null && fg >= 100) || isHigh(st('HBA1C')) || isHigh(st('FASTING_GLUCOSE'));
  const tgHigh = isHigh(st('TRIGLYCERIDES'));
  const hdlLow = isLow(st('HDL_C'));
  const tgHdl = idx('TG_HDL');
  if ((a1c != null && a1c >= 6.5) || (fg != null && fg >= 126)) {
    push({
      key: 'DIABETES_RANGE', title: 'Blood sugar in the diabetes range',
      evidence: ev('HBA1C', 'FASTING_GLUCOSE', 'POST_PRANDIAL_GLUCOSE'),
      meaning: meds.has('DIABETES_MED')
        ? 'Your sugar results sit in the diabetes range while on treatment. This tells your doctor how well the current plan is controlling it.'
        : 'Your sugar results sit in the range used to diagnose diabetes. One report is not a diagnosis, but it must be confirmed.',
      action: 'See your doctor soon to confirm this and agree a plan.',
      level: LEVEL.FLAG, requiresProfessional: true, focus: ['GLUCOSE']
    });
  } else if ((a1c != null && a1c >= 5.7) || (fg != null && fg >= 100)) {
    push({
      key: 'PREDIABETES_RANGE', title: 'Blood sugar above the healthy range',
      evidence: ev('HBA1C', 'FASTING_GLUCOSE'),
      meaning: 'Your sugar results are above the healthy range but below the diabetes range. This stage is usually reversible with food, activity and weight changes.',
      action: 'Act on this now and recheck in three months.',
      level: LEVEL.WATCH, focus: ['GLUCOSE']
    });
  }

  const irSigns = [tgHigh, hdlLow, sugarUp, isHigh(st('ALT')), isHigh(st('URIC_ACID')), !!(tgHdl && tgHdl.level === LEVEL.FLAG)]
    .filter(Boolean).length;
  if (irSigns >= 2 && (tgHigh || hdlLow || (tgHdl && tgHdl.level === LEVEL.FLAG))) {
    push({
      key: 'INSULIN_RESISTANCE', title: 'Signs that point to insulin resistance',
      evidence: ev('TRIGLYCERIDES', 'HDL_C', 'HBA1C', 'FASTING_GLUCOSE', 'ALT', 'URIC_ACID')
        .concat(tgHdl ? [`Triglyceride/HDL ratio ${tgHdl.result}`] : []),
      meaning: 'Raised triglycerides, low HDL and the other results listed tend to move together when the body stops responding well to insulin. It often shows here before blood sugar itself rises.',
      action: 'This pattern responds strongly to cutting refined carbohydrates and sugar, strength training, daily walking and losing fat around the waist.',
      level: LEVEL.WATCH, focus: ['GLUCOSE', 'TRIGLYCERIDES']
    });
  }

  // ── lipids ───────────────────────────────────────────────────────────────
  const ldlHigh = isHigh(st('LDL_C')) || isHigh(st('NON_HDL_C')) || isHigh(st('APO_B'));
  if (ldlHigh) {
    const ldl = v('LDL_C');
    const severe = ldl != null && ldl >= 190;
    push({
      key: 'ATHEROGENIC_LIPIDS', title: severe ? 'Very high LDL cholesterol' : 'Raised artery-clogging cholesterol',
      evidence: ev('LDL_C', 'NON_HDL_C', 'APO_B', 'TOTAL_CHOL', 'HDL_C', 'TRIGLYCERIDES'),
      meaning: severe
        ? 'LDL at this level is often inherited rather than caused by food alone, and usually needs treatment as well as diet.'
        : 'LDL and related particles are the ones that build up in artery walls over years. How much this matters for you depends on your age, blood pressure, smoking and family history.',
      action: severe
        ? 'See your doctor about this result, and tell them about any heart disease or high cholesterol in your family.'
        : 'Ask your doctor to assess your overall heart risk, and start the food changes in your plan.',
      level: severe ? LEVEL.FLAG : LEVEL.WATCH, requiresProfessional: severe, focus: ['LDL']
    });
  }
  if (tgHigh && !ldlHigh && irSigns < 2) {
    push({
      key: 'HIGH_TG', title: 'Raised triglycerides',
      evidence: ev('TRIGLYCERIDES', 'VLDL_C', 'HDL_C'),
      meaning: 'Triglycerides rise with sugar, refined carbohydrates, alcohol and excess calories. They also read high if the sample was not taken fasting.',
      action: 'Reduce sugar, sweets and alcohol, and repeat the test after a 10 to 12 hour fast.',
      level: LEVEL.WATCH, focus: ['TRIGLYCERIDES']
    });
  }

  // ── liver ────────────────────────────────────────────────────────────────
  const altV = v('ALT'), astV = v('AST');
  if (isHigh(st('ALT')) && (tgHigh || isHigh(st('GGT')) || sugarUp) && (astV == null || altV == null || altV >= astV)) {
    push({
      key: 'FATTY_LIVER_TYPE', title: 'Liver enzymes raised alongside fat and sugar markers',
      evidence: ev('ALT', 'AST', 'GGT', 'TRIGLYCERIDES'),
      meaning: 'ALT leading AST, together with raised triglycerides or sugar, is the picture most often seen when fat builds up in the liver. Only an ultrasound can confirm it.',
      action: 'Ask your doctor whether a liver ultrasound is worthwhile. Fat in the liver is reversible with weight loss, less sugar and less alcohol.',
      level: LEVEL.WATCH, focus: ['LIVER']
    });
  } else if (isAbnormalHigh(st('ALT')) || isAbnormalHigh(st('AST')) || isAbnormalHigh(st('GGT'))) {
    push({
      key: 'LIVER_ENZYMES', title: 'Raised liver enzymes',
      evidence: ev('ALT', 'AST', 'GGT', 'ALP', 'BILIRUBIN_TOTAL'),
      meaning: 'One or more liver enzymes are above range. Common harmless causes include a hard workout in the two days before the test, alcohol, and some medicines and supplements.',
      action: 'Repeat the test after three days without hard training or alcohol. If it is still raised, see your doctor.',
      level: LEVEL.WATCH, focus: ['LIVER']
    });
  }

  // ── thyroid ──────────────────────────────────────────────────────────────
  const tshHigh = isHigh(st('TSH')), tshLow = isLow(st('TSH'));
  const t4Low = isLow(st('FREE_T4')) || isLow(st('TOTAL_T4'));
  const t4High = isHigh(st('FREE_T4')) || isHigh(st('TOTAL_T4')) || isHigh(st('FREE_T3')) || isHigh(st('TOTAL_T3'));
  const hasT4 = M.has('FREE_T4') || M.has('TOTAL_T4');
  if (tshHigh || tshLow) {
    const onThyroid = meds.has('THYROID_MED');
    let title, meaning;
    if (tshHigh && t4Low) {
      title = 'Underactive thyroid pattern';
      meaning = 'TSH is raised and thyroid hormone is low. Together these mean the thyroid is not making enough hormone.';
    } else if (tshHigh) {
      title = 'TSH raised, thyroid hormone ' + (hasT4 ? 'still normal' : 'not measured');
      meaning = hasT4
        ? 'The brain is asking the thyroid to work harder (raised TSH) and the thyroid is still keeping up. This early stage often needs watching rather than treatment.'
        : 'TSH is raised but thyroid hormone itself was not measured, so the picture is incomplete.';
    } else if (t4High) {
      title = 'Overactive thyroid pattern';
      meaning = 'TSH is low and thyroid hormone is raised. Together these mean the thyroid is making too much hormone.';
    } else {
      title = 'TSH below range';
      meaning = 'TSH is low while thyroid hormone is ' + (hasT4 ? 'normal' : 'not measured') + '. This can be an early overactive thyroid, or simply the effect of thyroid medicine or high-dose biotin supplements.';
    }
    push({
      key: 'THYROID', title,
      evidence: ev('TSH', 'FREE_T4', 'FREE_T3', 'TOTAL_T4', 'TOTAL_T3', 'ANTI_TPO'),
      meaning: onThyroid ? meaning + ' Because you take thyroid medicine, this result is mainly a guide to whether your dose is right.' : meaning,
      action: onThyroid
        ? 'Show this result to the doctor who prescribes your thyroid medicine. Do not change the dose yourself.'
        : 'Ask your doctor whether to repeat the thyroid tests in 6 to 8 weeks or to add thyroid antibodies.',
      level: (tshHigh && t4Low) || t4High ? LEVEL.FLAG : LEVEL.WATCH,
      requiresProfessional: (tshHigh && t4Low) || t4High, focus: ['THYROID']
    });
  }

  // ── vitamin D ────────────────────────────────────────────────────────────
  const vd = v('VITAMIN_D');
  if ((vd != null && vd < 30) || isLow(st('VITAMIN_D'))) {
    const deficient = vd != null && vd < 20;
    push({
      key: 'LOW_VITAMIN_D', title: deficient ? 'Vitamin D deficiency' : 'Vitamin D below the preferred level',
      evidence: ev('VITAMIN_D', 'CALCIUM', 'ALP'),
      meaning: 'Vitamin D supports bones, muscle strength and immunity. Low levels are extremely common in India, even with plenty of sun, and food alone rarely corrects them.',
      action: 'Ask your doctor for the right supplement dose and how long to take it, then recheck in three months.',
      level: deficient ? LEVEL.WATCH : LEVEL.OK, focus: ['VITAMIN_D']
    });
  }

  // ── kidney ───────────────────────────────────────────────────────────────
  const egfrRow = v('EGFR');
  const egfrIdx = idx('EGFR');
  const egfrLow = (egfrRow != null && egfrRow < 60) || !!(egfrIdx && egfrIdx.level === LEVEL.FLAG) || isAbnormalLow(st('EGFR'));
  if (egfrLow || (isAbnormalHigh(st('CREATININE')) && (isHigh(st('UREA')) || isHigh(st('BUN'))))) {
    push({
      key: 'KIDNEY', title: 'Kidney markers need a closer look',
      evidence: ev('CREATININE', 'EGFR', 'UREA', 'BUN', 'URIC_ACID').concat(egfrIdx ? [`Estimated eGFR ${egfrIdx.result}`] : []),
      meaning: 'Kidney filtration reads lower than expected. Creatinine can be pushed up by high muscle mass, creatine, a high-protein diet, dehydration or hard training, so a single result needs confirming.',
      action: 'See your doctor. Expect a repeat test after rest and good hydration, and a urine test for protein.',
      level: LEVEL.FLAG, requiresProfessional: true, focus: ['KIDNEY']
    });
  }

  if (isHigh(st('URIC_ACID'))) {
    push({
      key: 'URIC_ACID', title: 'Raised uric acid',
      evidence: ev('URIC_ACID', 'CREATININE', 'TRIGLYCERIDES'),
      meaning: 'Uric acid rises with alcohol (beer most of all), sugary drinks, red meat and organ meats, dehydration and extra body fat. Very high levels can cause gout or kidney stones.',
      action: 'Drink more water, cut sugary drinks and alcohol, and recheck in three months.',
      level: LEVEL.WATCH, focus: ['URIC_ACID']
    });
  }

  // ── inflammation ─────────────────────────────────────────────────────────
  if (isHigh(st('HS_CRP')) || isHigh(st('CRP')) || isHigh(st('ESR'))) {
    push({
      key: 'INFLAMMATION', title: 'Raised inflammation markers',
      evidence: ev('HS_CRP', 'CRP', 'ESR', 'WBC', 'FERRITIN'),
      meaning: 'Inflammation markers are above range. They rise for days after an infection, an injury or a very hard training block, and stay raised with excess body fat, poor sleep or a chronic condition.',
      action: 'If you were unwell or training hard around the test, repeat it in two to three weeks. If it stays raised without a reason, see your doctor.',
      level: LEVEL.WATCH, focus: ['INFLAMMATION']
    });
  }

  return out;
}

/** Both outputs in one call. */
function buildInsights(report, ctx) {
  const indices = buildIndices(report, ctx);
  const patterns = buildPatterns(report, ctx, indices);
  return { indices, patterns };
}

module.exports = { LEVEL, indexMarkers, buildIndices, buildPatterns, buildInsights, isLow, isHigh, ageOf, sexOf };
