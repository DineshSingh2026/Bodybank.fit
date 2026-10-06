'use strict';

/**
 * BodyBank — HEALTH MAP 360: THE PERSONAL LAYER.
 *
 * Everything in the standard Health Map follows from the lab numbers alone, so
 * two people with the same numbers get the same pages. This module is what makes
 * the 360 edition about ONE person: it reads what the client told us (goal,
 * medicines, conditions, diet, lifestyle, family history) against their results.
 *
 * Pure and deterministic, like the rest of the report engines: no I/O, no AI.
 * Every sentence below is a fixed, reviewable piece of copy chosen by a rule, so
 * a clinician can audit exactly what the report is able to say.
 *
 * Two boundaries are kept throughout:
 *   • No doses and no medicine changes. The report says what to DISCUSS; the
 *     doctor decides what to take. Supplements are listed "to discuss".
 *   • Everything produced here is a DRAFT for the doctor and the nutritionist.
 *     They can rewrite or remove any line in the editor before a client sees it.
 */

const { LEVEL, indexMarkers, isLow, isHigh, ageOf, sexOf } = require('./insights');
const { formatDate } = require('../gradedReportDocument');

function clean(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > (max || 400) ? s.slice(0, max || 400) : s;
}
function pickOne(v, allowed) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return allowed.indexOf(s) >= 0 ? s : '';
}
function pickMany(v, allowed) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  list.forEach((x) => {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    if (allowed.indexOf(s) >= 0 && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

const DIETS = ['veg', 'egg', 'nonveg', 'vegan'];
const DIET_LABEL = { veg: 'Vegetarian', egg: 'Vegetarian with eggs', nonveg: 'Non-vegetarian', vegan: 'Vegan' };
const ACTIVITY = ['sedentary', 'light', 'moderate', 'active', 'athlete'];
const ACTIVITY_LABEL = {
  sedentary: 'Mostly sitting', light: 'Light activity, 1 to 2 days a week', moderate: 'Exercise 3 to 4 days a week',
  active: 'Exercise 5 or more days a week', athlete: 'Competitive or twice-a-day training'
};
const ALCOHOL = ['never', 'occasional', 'weekly', 'daily'];
const ALCOHOL_LABEL = { never: 'None', occasional: 'Occasional', weekly: 'Most weeks', daily: 'Most days' };
const SMOKING = ['never', 'former', 'current'];
const SMOKING_LABEL = { never: 'Never', former: 'Stopped', current: 'Currently' };
const FASTING = ['yes', 'no', 'unsure'];
const FAMILY = ['diabetes', 'heart', 'bp', 'cholesterol', 'thyroid', 'kidney', 'none'];
const FAMILY_LABEL = {
  diabetes: 'diabetes', heart: 'heart disease or stroke', bp: 'high blood pressure',
  cholesterol: 'high cholesterol', thyroid: 'thyroid disease', kidney: 'kidney disease'
};
const SYMPTOMS = ['fatigue', 'hairfall', 'sleep', 'weight', 'digestion', 'joints', 'mood', 'illness', 'none'];
const SYMPTOM_LABEL = {
  fatigue: 'tiredness', hairfall: 'hair fall', sleep: 'poor sleep', weight: 'difficulty losing weight',
  digestion: 'digestive trouble', joints: 'joint or muscle pain', mood: 'low mood or anxiety', illness: 'falling ill often'
};

/** Medicines and supplements we can say something useful about. */
const MEDICINE_RULES = [
  { key: 'THYROID_MED', re: /thyrox|levothyrox|eltroxin|thyronorm|thyroid (tab|med|pill)|\bt4\b/i, name: 'thyroid medicine', markers: ['TSH', 'FREE_T4'],
    note: 'You take thyroid medicine, so your TSH shows how well the current dose suits you rather than how your thyroid behaves on its own. Take the tablet on an empty stomach at the same time each day, and have blood drawn before that day\'s dose.' },
  { key: 'DIABETES_MED', re: /metformin|glycomet|glimepiride|gliclazide|sitagliptin|vildagliptin|dapagliflozin|empagliflozin|insulin|semaglutide|ozempic|rybelsus|mounjaro|tirzepatide/i, name: 'diabetes medicine', markers: ['HBA1C', 'FASTING_GLUCOSE', 'VITAMIN_B12'],
    note: 'You take diabetes medicine, so your sugar results reflect your control on treatment. Long-term metformin commonly lowers vitamin B12, so B12 is worth checking once a year.' },
  { key: 'STATIN', re: /statin|atorva|rosuva|rosuvas|lipitor|crestor|simva|pitava|ezetim|fenofib/i, name: 'cholesterol medicine', markers: ['LDL_C', 'ALT', 'AST'],
    note: 'You take cholesterol medicine, so your LDL shows how well it is working rather than your natural level. Statins can nudge liver enzymes up slightly, which your doctor checks from time to time. Muscle pain on a statin is worth mentioning on your call.' },
  { key: 'BP_MED', re: /telmi|amlodip|losartan|ramipril|enalapril|olmesartan|metoprolol|atenolol|bisoprolol|hydrochlorothiazide|chlorthalidone|\bbp (tab|med|pill)/i, name: 'blood pressure medicine', markers: ['POTASSIUM', 'SODIUM', 'CREATININE', 'URIC_ACID'],
    note: 'You take blood pressure medicine. Some of these change potassium, sodium, creatinine or uric acid slightly, so your doctor reads those results with your prescription in mind.' },
  { key: 'BIOTIN', re: /biotin|hair (vitamin|supplement|gumm)|hair skin nail/i, name: 'biotin', markers: ['TSH', 'FREE_T4', 'FREE_T3'],
    note: 'You take biotin. High-dose biotin interferes with the laboratory method used for thyroid tests and can make a normal thyroid look abnormal. Stop biotin for three days before any thyroid test.' },
  { key: 'CREATINE', re: /creatin/i, name: 'creatine', markers: ['CREATININE', 'EGFR'],
    note: 'You take creatine. It raises creatinine in the blood without harming the kidneys, which makes kidney filtration (eGFR) read lower than it truly is. Tell any doctor reading your kidney results that you use it.' },
  { key: 'PROTEIN', re: /whey|protein (powder|shake|supplement)|mass gainer|\bbcaa|\beaa\b|isolate/i, name: 'protein supplements', markers: ['UREA', 'BUN', 'CREATININE', 'URIC_ACID'],
    note: 'You use protein supplements. A high protein intake raises urea and can raise creatinine a little. On its own, with normal kidney filtration, that is expected and not a sign of damage.' },
  { key: 'IRON_SUPP', re: /\biron\b|ferrous|orofer|livogen|dexorange|autrin|fefol/i, name: 'iron supplement', markers: ['FERRITIN', 'HEMOGLOBIN', 'SERUM_IRON'],
    note: 'You take an iron supplement, so your iron results reflect that. Iron absorbs best away from tea, coffee, milk and calcium tablets, and with a source of vitamin C.' },
  { key: 'VITD_SUPP', re: /vitamin ?d|\bd3\b|cholecalciferol|calcirol|uprise|d-?rise|tayo/i, name: 'vitamin D supplement', markers: ['VITAMIN_D', 'CALCIUM'],
    note: 'You take vitamin D. Your result shows where the supplement has brought you. If it is still low, the dose or how you take it (with a meal that contains fat) may need changing.' },
  { key: 'B12_SUPP', re: /\bb ?12\b|methylcobal|mecobal|neurobion|cobadex|nurokind/i, name: 'vitamin B12 supplement', markers: ['VITAMIN_B12'],
    note: 'You take B12. A very high B12 reading on a supplement is expected and not harmful.' },
  { key: 'ACID_MED', re: /pantop|omepra|rabepra|esomepra|\bpan ?d?\b ?40|\bppi\b|acidity (tab|med)|antacid/i, name: 'acidity medicine', markers: ['VITAMIN_B12', 'MAGNESIUM', 'FERRITIN'],
    note: 'You take acidity medicine. Used for many months, these reduce the absorption of vitamin B12, iron and magnesium, so those results are worth watching.' },
  { key: 'STEROID', re: /prednis|dexameth|deflazacort|steroid|betnesol|wysolone/i, name: 'steroid medicine', markers: ['FASTING_GLUCOSE', 'HBA1C', 'WBC'],
    note: 'You take a steroid medicine. Steroids raise blood sugar and the white cell count for as long as you take them, so those results are read differently.' },
  { key: 'HORMONE', re: /contracept|\bocp\b|birth control|the pill|\bhrt\b|estrogen|oestrogen|testosterone|\btrt\b|anabolic|anavar|dianabol|trenbol|nandrol|clomid|hcg/i, name: 'hormone therapy', markers: ['HDL_C', 'LDL_C', 'ALT', 'HEMOGLOBIN', 'HEMATOCRIT'],
    note: 'You use a hormone medicine. Depending on the type, these can shift cholesterol, liver enzymes and the red cell count, so tell your doctor exactly what you take and the dose.' },
  { key: 'OMEGA3', re: /omega|fish oil/i, name: 'omega-3', markers: ['TRIGLYCERIDES'],
    note: 'You take omega-3, which lowers triglycerides. Your result already includes that effect.' },
  { key: 'PREWORKOUT', re: /pre.?workout|fat burner|thermogenic|ashwagandha|\bsarm/i, name: 'performance supplements', markers: ['ALT', 'AST', 'TSH'],
    note: 'You use performance or herbal supplements. Some of these raise liver enzymes or affect thyroid results. Bring the labels to your call so your doctor can check the ingredients.' }
];

const CONDITION_RULES = [
  { key: 'DIABETES', re: /diabet|sugar|prediabet|insulin resist/i, name: 'diabetes or raised sugar',
    note: 'With a history of raised sugar, the results that matter most are HbA1c, kidney filtration and cholesterol, because sugar affects the kidneys and arteries over time.' },
  { key: 'THYROID', re: /thyroid|hashimoto|graves|goit/i, name: 'a thyroid condition',
    note: 'With a thyroid condition, TSH is the result to track. An untreated or under-treated thyroid also pushes cholesterol up and can cause tiredness and weight gain, so those results are read together.' },
  { key: 'PCOS', re: /pcos|pcod|polycystic/i, name: 'PCOS',
    note: 'PCOS is closely tied to insulin resistance, so triglycerides, HDL, fasting sugar and insulin deserve the most attention, even when periods are the main concern.' },
  { key: 'BP', re: /\bbp\b|hypertens|blood pressure/i, name: 'high blood pressure',
    note: 'With high blood pressure, kidney markers and cholesterol matter more than usual, because the three together decide heart and kidney risk.' },
  { key: 'FATTY_LIVER', re: /fatty liver|nafld|masld|liver/i, name: 'a liver condition',
    note: 'With a known liver condition, ALT, AST and GGT are the results to follow, along with triglycerides and sugar, which usually drive fat in the liver.' },
  { key: 'CHOLESTEROL', re: /cholesterol|lipid|triglycerid/i, name: 'high cholesterol',
    note: 'With a history of high cholesterol, LDL and non-HDL cholesterol are the results your doctor will track against a target set for your personal risk.' },
  { key: 'ANAEMIA', re: /an[ae]+mi|low h[ae]moglobin|thalass|iron defic/i, name: 'anaemia',
    note: 'With a history of anaemia, haemoglobin, red cell size and ferritin are read together to tell low iron from other causes.' },
  { key: 'KIDNEY', re: /kidney|renal|ckd|stone/i, name: 'a kidney condition',
    note: 'With a kidney history, creatinine, eGFR, urea and uric acid are the key results, and protein intake and supplements should be agreed with your doctor.' },
  { key: 'HEART', re: /heart|cardiac|angio|stent|bypass|stroke/i, name: 'a heart condition',
    note: 'With a heart history, cholesterol targets are stricter than the standard ranges printed on a lab report. Your doctor will judge LDL against that stricter target.' },
  { key: 'GOUT', re: /gout|uric/i, name: 'gout or raised uric acid',
    note: 'With gout or raised uric acid, the uric acid result is the one to bring down, and alcohol, sugary drinks and dehydration are the main triggers.' },
  { key: 'PREGNANCY', re: /pregnan|breast ?feed|lactat|postpartum/i, name: 'pregnancy or breastfeeding',
    note: 'Pregnancy and breastfeeding change many normal ranges (haemoglobin, thyroid, cholesterol and others). This report uses standard adult ranges, so please go through it with your obstetrician.' }
];

const RELATIVE_RE = /\b(father|mother|dad|mom|mum|papa|mummy|parent|parents|brother|sister|sibling|grand(father|mother|parents?)|uncle|aunt|family|hereditary|runs in)\b/i;

const GOALS = [
  { key: 'FAT_LOSS', re: /fat|weight ?loss|lose|slim|lean|reduce|belly|obes/i, label: 'losing fat' },
  { key: 'MUSCLE', re: /muscle|bulk|gain|mass|strength|physique|bodybuild|tone/i, label: 'building muscle and strength' },
  { key: 'PERFORMANCE', re: /perform|endur|marathon|run|cycl|triath|sport|athlet|stamina|fitness|crossfit|hyrox/i, label: 'sports performance' },
  { key: 'ENERGY', re: /energy|tired|fatigue|sleep|stress|mood|focus|hair/i, label: 'more energy' },
  { key: 'HEART', re: /cholest|heart|lipid|bp|pressure/i, label: 'a healthier heart' },
  { key: 'SUGAR', re: /sugar|diabet|insulin|pcos|pcod/i, label: 'better blood sugar' }
];

/**
 * Normalise everything the client told us into one context object.
 * Unknown or missing answers stay empty; nothing is assumed.
 */
function normalizeContext(raw) {
  const r = raw || {};
  const medicinesText = clean(r.medicines, 400);
  const conditionsText = clean(r.conditions, 400);
  const goalText = clean(r.goal, 200);
  const none = (s) => !s || /^(no|none|nil|na|n\/a|nothing|-)$/i.test(s);
  const medicines = none(medicinesText) ? [] : MEDICINE_RULES.filter((m) => m.re.test(medicinesText)).map((m) => m.key);
  // "Thyroid, father has diabetes" is one condition and one piece of family history.
  // Each clause is read on its own, and a clause that names a relative is never
  // counted as the client's own condition.
  const clauses = none(conditionsText) ? [] : conditionsText.split(/[,;.\n]|\band\b/i).map((x) => x.trim()).filter(Boolean);
  const own = clauses.filter((x) => !RELATIVE_RE.test(x)).join(', ');
  const relatives = clauses.filter((x) => RELATIVE_RE.test(x)).join(', ');
  const conditions = own ? CONDITION_RULES.filter((m) => m.re.test(own)).map((m) => m.key) : [];
  const familyFromText = [];
  if (/diabet|sugar/i.test(relatives)) familyFromText.push('diabetes');
  if (/heart|cardiac|stroke|attack|bypass|stent/i.test(relatives)) familyFromText.push('heart');
  if (/\bbp\b|pressure|hypertens/i.test(relatives)) familyFromText.push('bp');
  if (/cholest/i.test(relatives)) familyFromText.push('cholesterol');
  if (/thyroid/i.test(relatives)) familyFromText.push('thyroid');
  if (/kidney|renal/i.test(relatives)) familyFromText.push('kidney');
  const goal = GOALS.filter((g) => g.re.test(goalText))[0] || null;
  const h = Number(r.heightCm), w = Number(r.weightKg);
  return {
    age: ageOf(r.age),
    sex: sexOf(r.sex),
    goalText,
    goalKey: goal ? goal.key : 'GENERAL',
    goalLabel: goal ? goal.label : 'staying healthy',
    medicinesText: none(medicinesText) ? '' : medicinesText,
    conditionsText: none(conditionsText) ? '' : own,
    medicines,
    conditions,
    diet: pickOne(r.diet, DIETS),
    activity: pickOne(r.activity, ACTIVITY),
    alcohol: pickOne(r.alcohol, ALCOHOL),
    smoking: pickOne(r.smoking, SMOKING),
    fasting: pickOne(r.fasting, FASTING),
    familyHistory: pickMany(pickMany(r.familyHistory, FAMILY).concat(familyFromText), FAMILY).filter((x) => x !== 'none'),
    symptoms: pickMany(r.symptoms, SYMPTOMS).filter((x) => x !== 'none'),
    heightCm: h >= 120 && h <= 230 ? Math.round(h) : null,
    weightKg: w >= 30 && w <= 250 ? Math.round(w * 10) / 10 : null
  };
}

/** Has the client told us anything beyond age and sex? */
function hasPersonalDetail(ctx) {
  const c = ctx || {};
  return !!(c.goalText || c.medicinesText || c.conditionsText || c.diet || c.activity || c.alcohol || c.smoking ||
    c.fasting || (c.familyHistory || []).length || (c.symptoms || []).length || c.heightCm || c.weightKg);
}

// ---------------------------------------------------------------------------
// For your goal
// ---------------------------------------------------------------------------

/** What each health area means for each goal, when it is fine and when it is not. */
const GOAL_AREA = {
  FAT_LOSS: {
    METABOLIC: ['Your blood sugar markers are in range, so your body is responding normally to food. Fat loss should follow a steady calorie deficit.',
      'Your blood sugar markers are off. When the body resists insulin it stores fat more easily and makes you hungrier, so fixing this is the fastest way to make fat loss easier.'],
    THYROID: ['Your thyroid is working normally, so it is not slowing your metabolism.',
      'Your thyroid result is off. An underactive thyroid slows metabolism and makes weight loss noticeably harder until it is corrected.'],
    LIVER: ['Your liver markers are in range, so your liver is processing fat normally.',
      'Your liver markers are raised. The liver is where fat is processed, and fat stored in the liver usually clears as weight comes down.'],
    CARDIOVASCULAR: ['Your cholesterol picture is healthy. Losing fat will help keep it that way.',
      'Your cholesterol picture needs work. The good news is that it usually improves alongside fat loss, especially triglycerides and HDL.'],
    NUTRITIONAL: ['Your vitamin and mineral levels are adequate, so a calorie deficit is unlikely to leave you depleted.',
      'Some vitamin or mineral levels are low. Eating less on top of a shortage worsens tiredness and cravings, so correct these before cutting calories hard.'],
    BLOOD: ['Your blood count is healthy, so you have the oxygen-carrying capacity to train well.',
      'Your blood count is low. That limits how hard you can train and how well you recover, so avoid aggressive dieting until it is corrected.']
  },
  MUSCLE: {
    BLOOD: ['Your blood count is healthy, so your muscles are getting the oxygen they need to train and recover.',
      'Your blood count is low. Muscles that are short of oxygen tire early and recover slowly, which caps your progress in the gym.'],
    NUTRITIONAL: ['Your vitamin D, B12 and iron levels support muscle function and recovery.',
      'Low vitamin D, B12 or iron weakens muscle contraction and slows recovery. Correcting these often lifts strength within weeks.'],
    KIDNEY: ['Your kidney markers are healthy, so a higher protein intake is safe for you.',
      'Your kidney markers need a second look before you raise protein further or add creatine. Often it is only the effect of muscle and supplements, but confirm it first.'],
    LIVER: ['Your liver markers are in range. Hard training and supplements are not straining your liver.',
      'Your liver markers are raised. Heavy lifting in the two days before a test can do this, and so can some supplements. Review what you take.'],
    METABOLIC: ['Your blood sugar control is good, so the carbohydrates you eat are being used to fuel and rebuild muscle.',
      'Your blood sugar control is off. That steers the food you eat towards fat storage rather than muscle, so tighten this up before a bulking phase.'],
    THYROID: ['Your thyroid is normal, so it is supporting normal muscle repair.',
      'Your thyroid result is off. Thyroid hormone drives muscle repair and energy, so this is worth sorting out first.']
  },
  PERFORMANCE: {
    BLOOD: ['Your haemoglobin is healthy, which is the foundation of endurance: it sets how much oxygen reaches working muscle.',
      'Your blood count is low. This is the most direct limit on endurance, since it reduces the oxygen your muscles receive at every effort level.'],
    NUTRITIONAL: ['Your iron stores, B12 and vitamin D are adequate for the demands of training.',
      'Iron, B12 or vitamin D is low. Athletes lose more iron than most people, and low stores cut performance well before anaemia shows up.'],
    INFLAMMATION: ['Your inflammation markers are settled, which suggests you are recovering well between sessions.',
      'Your inflammation markers are raised. Outside of illness or injury, that usually means training load is ahead of recovery.'],
    KIDNEY: ['Your kidney markers and electrolytes are in range, so hydration and recovery look sound.',
      'Your kidney markers are off. In athletes this is often dehydration or hard training before the test, but it needs confirming.'],
    METABOLIC: ['Your blood sugar control is good, so you can fuel long efforts reliably.',
      'Your blood sugar control is off, which affects how steadily you can fuel long or repeated efforts.'],
    THYROID: ['Your thyroid is normal, so it is not holding back your energy or recovery.',
      'Your thyroid result is off, which commonly shows up as flat training, slow recovery and heavy legs.']
  },
  ENERGY: {
    BLOOD: ['Your blood count is healthy, so low oxygen delivery is not the reason for tiredness.',
      'Your blood count is low. This is one of the most common and most fixable causes of constant tiredness.'],
    THYROID: ['Your thyroid is normal, which rules out a common cause of low energy.',
      'Your thyroid result is off. Thyroid problems are a classic cause of tiredness, low mood and feeling cold.'],
    NUTRITIONAL: ['Your vitamin D, B12 and iron levels are adequate.',
      'Vitamin D, B12 or iron is low. Each of these on its own can cause tiredness, poor concentration and hair fall, and they are straightforward to correct.'],
    METABOLIC: ['Your blood sugar is steady, so energy dips after meals are unlikely to come from sugar swings.',
      'Your blood sugar control is off. Swings in blood sugar cause the after-meal slump and the mid-afternoon crash.'],
    INFLAMMATION: ['Your inflammation markers are settled.',
      'Your inflammation markers are raised, and ongoing inflammation is tiring in itself.'],
    LIVER: ['Your liver markers are in range.', 'Your liver markers are raised, which can come with a general feeling of sluggishness.']
  },
  HEART: {
    CARDIOVASCULAR: ['Your cholesterol picture is healthy. Keep doing what you are doing.',
      'Your cholesterol picture is the main thing standing between you and this goal, and it is the area where food and activity changes show up most clearly on the next test.'],
    METABOLIC: ['Your blood sugar is in range, which protects your arteries.',
      'Your blood sugar is off. Raised sugar damages artery walls, so it counts towards heart risk as much as cholesterol does.'],
    INFLAMMATION: ['Your inflammation markers are settled, which is good for your arteries.',
      'Your inflammation markers are raised. Inflammation is part of how artery disease develops.'],
    KIDNEY: ['Your kidney markers are healthy. Kidneys and heart share the same risks, so this is a good sign.',
      'Your kidney markers are off. Kidney and heart health are closely linked, so mention this to your doctor.'],
    THYROID: ['Your thyroid is normal, so it is not pushing your cholesterol up.',
      'Your thyroid result is off. An underactive thyroid raises LDL cholesterol, and treating it can bring cholesterol down without any other change.'],
    LIVER: ['Your liver markers are in range.', 'Your liver markers are raised. Fat in the liver travels with the same risks as heart disease.']
  },
  SUGAR: {
    METABOLIC: ['Your blood sugar markers are in range. The aim now is to keep them there.',
      'Your blood sugar markers are the centre of this goal. At this level, food, movement and weight changes usually show a clear improvement by the next test.'],
    CARDIOVASCULAR: ['Your cholesterol picture is healthy, which matters because sugar and cholesterol together decide heart risk.',
      'Your triglycerides and HDL move with insulin, so improving your sugar control should improve these as well.'],
    LIVER: ['Your liver markers are in range.', 'Your liver markers are raised. Fat in the liver and insulin resistance feed each other, so they are treated together.'],
    KIDNEY: ['Your kidney markers are healthy. Raised sugar affects the kidneys first, so this is reassuring.',
      'Your kidney markers are off. Kidneys are sensitive to long-term raised sugar, so mention this to your doctor.'],
    NUTRITIONAL: ['Your vitamin levels are adequate.', 'Some vitamin levels are low. Low vitamin D and B12 are common alongside insulin resistance and its treatment.'],
    THYROID: ['Your thyroid is normal.', 'Your thyroid result is off, which can make weight and sugar harder to manage.']
  },
  GENERAL: {
    CARDIOVASCULAR: ['Your cholesterol picture is healthy.', 'Your cholesterol picture needs attention. It causes no symptoms, so the blood test is the only warning you get.'],
    METABOLIC: ['Your blood sugar is in range.', 'Your blood sugar is off. Caught at this stage it is usually reversible.'],
    BLOOD: ['Your blood count is healthy.', 'Your blood count is low and needs a cause found.'],
    NUTRITIONAL: ['Your vitamin and mineral levels are adequate.', 'Some vitamin or mineral levels are low and are straightforward to correct.'],
    LIVER: ['Your liver markers are in range.', 'Your liver markers are raised and worth rechecking.'],
    KIDNEY: ['Your kidney markers are healthy.', 'Your kidney markers need a closer look.'],
    THYROID: ['Your thyroid is normal.', 'Your thyroid result is off and worth following up.']
  }
};

/**
 * @returns {{ title, subtitle, items: Array<{text, requiresProfessional}> }|null}
 */
function buildGoalSection(report, ctx) {
  const c = ctx || {};
  const table = GOAL_AREA[c.goalKey] || GOAL_AREA.GENERAL;
  const areas = (report && report.areas) || [];
  const holding = [], helping = [];
  Object.keys(table).forEach((areaId) => {
    const a = areas.filter((x) => x.areaId === areaId)[0];
    if (!a || a.grade === 'NOT_ASSESSED') return;
    if (a.grade === 'A' || a.grade === 'B') helping.push({ text: `${a.label}: ${table[areaId][0]}`, requiresProfessional: false });
    else holding.push({ text: `${a.label} (grade ${a.grade}): ${table[areaId][1]}`, requiresProfessional: a.grade === 'D', grade: a.grade });
  });
  if (!holding.length && !helping.length) return null;
  holding.sort((x, y) => (x.grade === y.grade ? 0 : x.grade === 'D' ? -1 : 1));
  const goalName = c.goalText ? `"${c.goalText}"` : 'staying healthy';
  return {
    title: 'What This Means for Your Goal',
    subtitle: c.goalText
      ? `You told us your goal is ${goalName}. This is how your results line up with it, starting with what is holding you back.`
      : 'You did not give us a specific goal, so this reads your results against staying healthy for the long term.',
    items: holding.map((h) => ({ text: h.text, requiresProfessional: h.requiresProfessional })).concat(helping).slice(0, 8)
  };
}

// ---------------------------------------------------------------------------
// What you told us, and how it changes the reading
// ---------------------------------------------------------------------------

/** One line summarising the client's own answers, for the top of the section. */
function profileLine(ctx) {
  const c = ctx || {};
  const bits = [];
  if (c.diet) bits.push(DIET_LABEL[c.diet]);
  if (c.activity) bits.push(ACTIVITY_LABEL[c.activity]);
  if (c.heightCm && c.weightKg) bits.push(`${c.heightCm} cm, ${c.weightKg} kg`);
  if (c.alcohol) bits.push(`Alcohol: ${ALCOHOL_LABEL[c.alcohol].toLowerCase()}`);
  if (c.smoking) bits.push(`Smoking: ${SMOKING_LABEL[c.smoking].toLowerCase()}`);
  if (c.fasting) bits.push(c.fasting === 'yes' ? 'Fasting sample' : c.fasting === 'no' ? 'Non-fasting sample' : 'Fasting status not known');
  return bits.join('  ·  ');
}

/**
 * @returns {{ title, subtitle, items: Array<{text, requiresProfessional}> }|null}
 */
function buildContextNotes(report, ctx) {
  const c = ctx || {};
  if (!hasPersonalDetail(c)) return null;
  const M = indexMarkers(report);
  const st = (id) => (M.has(id) ? M.get(id).status : '');
  const items = [];
  const add = (text, pro) => { if (text) items.push({ text, requiresProfessional: !!pro }); };

  MEDICINE_RULES.filter((m) => c.medicines.indexOf(m.key) >= 0).forEach((m) => add(m.note));
  if (c.medicinesText && !c.medicines.length) {
    add(`You told us you take: ${c.medicinesText}. Mention these on your doctor call so the results can be read with them in mind.`);
  }
  CONDITION_RULES.filter((m) => c.conditions.indexOf(m.key) >= 0).forEach((m) => add(m.note, m.key === 'PREGNANCY'));
  if (c.conditionsText && !c.conditions.length) {
    add(`You told us about: ${c.conditionsText}. Your doctor will read your results with this in mind.`);
  }

  if (c.fasting === 'no') {
    add('Your sample was not taken fasting. Triglycerides and blood glucose read higher after food, so those two results may look worse than they are. HbA1c and cholesterol are not affected.');
  } else if (c.fasting === 'unsure' && (isHigh(st('TRIGLYCERIDES')) || isHigh(st('FASTING_GLUCOSE')))) {
    add('You were not sure whether the sample was fasting. If you had eaten within 8 hours, raised triglycerides or glucose may simply reflect that, and are worth repeating fasting.');
  }

  if (c.alcohol === 'weekly' || c.alcohol === 'daily') {
    const hit = ['GGT', 'TRIGLYCERIDES', 'URIC_ACID', 'ALT', 'AST'].filter((id) => isHigh(st(id))).map((id) => M.get(id).name);
    add(hit.length
      ? `You drink alcohol regularly. Alcohol directly raises ${hit.join(', ')}, which ${hit.length === 1 ? 'is' : 'are'} above range on this report. Three alcohol-free weeks before a retest will show how much of this is alcohol.`
      : 'You drink alcohol regularly. On this report the markers alcohol usually raises (GGT, triglycerides, uric acid) are not above range.');
  }
  if (c.smoking === 'current') {
    add('You smoke. Smoking lowers protective HDL cholesterol, raises inflammation and multiplies the risk carried by every cholesterol result on this report. Stopping changes your heart risk more than any single number here.');
  }
  if (c.activity === 'athlete' || c.activity === 'active') {
    add('You train hard and often. Heavy training in the two days before a blood test can raise AST, ALT, creatinine and inflammation markers and lower white cells for a short time. For a clean baseline, test after two easy days.');
  } else if (c.activity === 'sedentary') {
    add('You are mostly inactive at the moment. Regular movement is the single change that improves the most results at once: triglycerides, HDL, blood sugar and liver markers all respond to it.');
  }
  if (c.diet === 'veg' || c.diet === 'vegan') {
    const b12 = M.has('VITAMIN_B12') ? `Your B12 is ${M.get('VITAMIN_B12').result}.` : 'B12 was not measured on this report and is worth adding.';
    add(`You eat ${c.diet === 'vegan' ? 'a vegan' : 'a vegetarian'} diet. Vitamin B12 comes almost entirely from animal foods, and plant iron is absorbed less well, so B12 and ferritin are the two results to keep an eye on. ${b12}`);
  }
  if ((c.familyHistory || []).length) {
    const names = c.familyHistory.map((k) => FAMILY_LABEL[k]).filter(Boolean);
    add(`You have a family history of ${names.join(', ')}. This raises your own risk, so results in ${c.familyHistory.indexOf('diabetes') >= 0 ? 'blood sugar' : 'these areas'} deserve earlier action than they would in someone without that history, even when they are only borderline.`);
  }
  if ((c.symptoms || []).length) {
    const sy = c.symptoms.map((k) => SYMPTOM_LABEL[k]).filter(Boolean);
    const leads = [];
    if (isLow(st('HEMOGLOBIN')) || isLow(st('FERRITIN'))) leads.push('low haemoglobin or iron');
    if (isLow(st('VITAMIN_B12'))) leads.push('low B12');
    if (isLow(st('VITAMIN_D'))) leads.push('low vitamin D');
    if (isHigh(st('TSH')) || isLow(st('TSH'))) leads.push('your thyroid result');
    add(leads.length
      ? `You told us about ${sy.join(', ')}. On this report, ${leads.join(', ')} could each contribute to how you feel, and all are treatable.`
      : `You told us about ${sy.join(', ')}. Nothing on this blood report clearly explains ${sy.length === 1 ? 'it' : 'these'}, which is useful to know: raise ${sy.length === 1 ? 'it' : 'them'} on your doctor call so other causes can be considered.`);
  }

  if (!items.length) return null;
  return {
    title: 'What You Told Us, and How It Changes the Reading',
    subtitle: profileLine(c),
    items: items.slice(0, 12)
  };
}

// ---------------------------------------------------------------------------
// Nutrition plan
// ---------------------------------------------------------------------------

/** Which nutrition themes this report calls for, most important first. */
function focusAreas(report, patterns) {
  const order = [];
  const add = (f) => { if (f && order.indexOf(f) < 0) order.push(f); };
  (patterns || []).slice().sort((a, b) => b.level - a.level).forEach((p) => (p.focus || []).forEach(add));
  const M = indexMarkers(report);
  const st = (id) => (M.has(id) ? M.get(id).status : '');
  if (isHigh(st('TRIGLYCERIDES'))) add('TRIGLYCERIDES');
  if (isLow(st('HDL_C'))) add('HDL');
  if (isHigh(st('LDL_C'))) add('LDL');
  if (isLow(st('VITAMIN_D'))) add('VITAMIN_D');
  if (isLow(st('VITAMIN_B12'))) add('B12');
  return order;
}

const isVeg = (d) => d === 'veg' || d === 'vegan';
const noEgg = (d) => d === 'veg' || d === 'vegan';
const noDairy = (d) => d === 'vegan';

/** Foods to add, by theme. Each function returns one sentence for the diet type. */
const ADD = {
  IRON: (d) => (isVeg(d)
    ? 'For iron: rajma, chana, masoor dal, soybean, spinach, methi, beetroot, dates, jaggery, sesame and ragi. Squeeze lemon over them or add amla, since vitamin C doubles how much plant iron you absorb.'
    : 'For iron: chicken liver once a week, red meat or mutton twice a week, eggs and fish, plus rajma, chana, spinach and ragi. Add lemon or amla to plant sources to absorb more.'),
  B12: (d) => (d === 'vegan'
    ? 'For B12: fortified soy milk, fortified cereals and nutritional yeast every day. On a vegan diet a supplement is almost always needed as well.'
    : d === 'veg'
      ? 'For B12: curd, milk, paneer and cheese every day, and fortified cereals. On a vegetarian diet food alone often does not correct a low level.'
      : 'For B12: eggs, fish, chicken, curd and milk. Two eggs and a serving of curd a day cover most of the daily need.'),
  LDL: (d) => `For LDL: oats or barley for breakfast, a daily bowl of dal or beans, a fruit with skin (apple, guava, pear), a handful of almonds or walnuts, and 1 to 2 teaspoons of soaked isabgol or ground flaxseed.${isVeg(d) ? '' : ' Choose fish over red meat twice a week.'}`,
  TRIGLYCERIDES: (d) => (isVeg(d)
    ? 'For triglycerides: walnuts, ground flaxseed and chia daily for plant omega-3, and build meals around dal, vegetables and whole grains instead of rice, maida and sweets.'
    : 'For triglycerides: oily fish (rawas, bangda, sardine, salmon) twice a week, plus walnuts and ground flaxseed, and build meals around protein and vegetables instead of rice, maida and sweets.'),
  HDL: () => 'For HDL: a small handful of nuts daily, and cook with mustard, groundnut or olive oil rather than refined or reheated oil. Activity raises HDL more than any food.',
  GLUCOSE: (d) => `For blood sugar: start each meal with salad or vegetables, then protein (${isVeg(d) ? (noDairy(d) ? 'dal, tofu, soy chunks, sprouts' : 'dal, paneer, curd, sprouts') : 'eggs, chicken, fish, dal, curd'}), then the roti or rice. Swap white rice and maida for millets, hand-pounded rice or whole wheat in smaller portions.`,
  LIVER: () => 'For your liver: plenty of vegetables, especially cabbage, cauliflower, broccoli and leafy greens, two cups of black coffee or green tea a day if you tolerate them, and enough protein at each meal.',
  VITAMIN_D: (d) => `For vitamin D: 15 to 20 minutes of midday sun on bare arms and legs most days, plus ${noDairy(d) ? 'fortified soy milk and mushrooms left in the sun' : noEgg(d) ? 'fortified milk, curd and mushrooms left in the sun' : 'egg yolks, oily fish and fortified milk'}. Food and sun rarely correct a low level alone.`,
  THYROID: (d) => `For your thyroid: use iodised salt, and include ${noDairy(d) ? 'Brazil nuts, sunflower seeds and whole grains' : isVeg(d) ? 'curd, milk, Brazil nuts and sunflower seeds' : 'eggs, fish, curd and Brazil nuts'} for selenium and iodine. Cooked cabbage and cauliflower are fine.`,
  URIC_ACID: (d) => `For uric acid: 3 litres of water a day, cherries or other sour fruit, ${noDairy(d) ? 'plenty of vegetables' : 'low-fat curd and milk'}, and vitamin C from amla, guava and lemon.`,
  KIDNEY: () => 'For your kidneys: steady water through the day so urine stays pale, plenty of vegetables and fruit, and home-cooked food with measured salt.',
  INFLAMMATION: (d) => `For inflammation: turmeric with black pepper in cooking, ginger, garlic, berries, leafy greens, nuts${isVeg(d) ? ' and ground flaxseed' : ' and oily fish'}. Seven to eight hours of sleep lowers inflammation as much as food does.`
};

const LIMIT = {
  IRON: () => 'Tea and coffee within an hour of meals. They block iron absorption by more than half. Keep calcium tablets away from iron-rich meals too.',
  B12: () => 'Relying on food alone if your level is clearly low. Alcohol also interferes with B12 absorption.',
  LDL: (d) => (noDairy(d)
    ? 'Coconut oil, coconut cream and palm oil to small amounts. Avoid vanaspati, bakery biscuits, puffs and namkeen, which carry trans fats.'
    : `Ghee, butter, cream, coconut oil and ${isVeg(d) ? 'full-fat paneer and cheese' : 'fatty red meat and skin-on chicken'} to small amounts. Avoid vanaspati, bakery biscuits, puffs and namkeen, which carry trans fats.`),
  TRIGLYCERIDES: () => 'Sugar, sweets, fruit juice, soft drinks, white bread, maida and large rice portions. Alcohol raises triglycerides sharply, so cut it out completely for four weeks.',
  HDL: () => 'Deep-fried food and reheated oil. Smoking lowers HDL directly.',
  GLUCOSE: () => 'Sugary tea and coffee, juices, biscuits and bakery items, and eating carbohydrates alone. Avoid long gaps followed by one very large meal.',
  LIVER: () => 'Alcohol completely for at least four weeks, plus sugary drinks, fruit juice and fried snacks. Fructose in sweet drinks is turned straight into liver fat.',
  VITAMIN_D: () => 'Nothing specific to avoid. Sunscreen and full sleeves block vitamin D production, so get your sun before applying them.',
  THYROID: (d) => `Raw cabbage, cauliflower and soy in very large amounts. Take thyroid medicine at least 30 to 60 minutes before tea, coffee, ${noDairy(d) ? 'soy milk' : 'milk'}, calcium or iron.`,
  URIC_ACID: (d) => `Beer and spirits, sugary drinks and fruit juice${isVeg(d) ? '' : ', organ meats, red meat and shellfish'}. Avoid crash dieting and fasting, which push uric acid up.`,
  KIDNEY: () => 'Pain-killers such as ibuprofen and diclofenac unless prescribed, excess salt and packaged food. Do not raise protein or add creatine until your doctor has reviewed the kidney results.',
  INFLAMMATION: (d) => `Sugar, deep-fried food, ${isVeg(d) ? 'packaged snacks' : 'processed meat'} and alcohol. Hard training on poor sleep adds to inflammation.`
};

const SUPPLEMENTS = {
  IRON: 'Iron: only after your doctor confirms low iron stores and finds the cause. The form and dose matter, and iron taken without need can be harmful.',
  B12: 'Vitamin B12: tablets, sublingual or injections depending on how low you are and why.',
  VITAMIN_D: 'Vitamin D3: the dose and duration depend on your level. It is taken with a meal that contains fat.',
  TRIGLYCERIDES: (d) => `Omega-3 (${isVeg(d) ? 'algae oil' : 'fish oil or algae oil'}): useful when triglycerides stay raised despite food changes.`,
  LDL: 'Psyllium husk (isabgol): a food-grade fibre that lowers LDL modestly. Ask whether it suits your medicines.',
  GLUCOSE: 'No supplement replaces food and activity for blood sugar. Ask before taking anything sold for "sugar control".',
  THYROID: 'Avoid iodine or kelp supplements unless prescribed. Selenium only if your doctor recommends it.',
  INFLAMMATION: 'Omega-3 and curcumin are sometimes suggested. Ask whether they are worthwhile for you.'
};

const WEEK_FOCUS = {
  IRON: 'Add one iron-rich food with lemon or amla to two meals a day, and move tea and coffee to at least an hour away from meals.',
  B12: 'Get B12 into every day through the foods listed, and start the supplement your doctor recommends.',
  LDL: 'Switch breakfast to oats, barley or a high-fibre option, add a daily bowl of dal or beans, and replace fried snacks with nuts or fruit.',
  TRIGLYCERIDES: 'Cut sugar, sweets, juice and alcohol completely, and halve your rice or roti portion at dinner.',
  HDL: 'Walk briskly for 30 minutes on five days and add two strength sessions. This is what moves HDL.',
  GLUCOSE: 'Eat vegetables and protein before carbohydrates at every meal, and walk for 10 to 15 minutes after lunch and dinner.',
  LIVER: 'Go alcohol-free and cut all sweet drinks. Aim to lose half a kilo a week if you carry extra weight.',
  VITAMIN_D: 'Get midday sun on most days and start the vitamin D dose your doctor recommends.',
  THYROID: 'Take thyroid medicine correctly every day if you are on it, and book the follow-up test your doctor advises.',
  URIC_ACID: 'Reach 3 litres of water a day and remove alcohol and sugary drinks.',
  KIDNEY: 'Keep protein and supplements steady, hydrate well, and book the repeat test your doctor asks for.',
  INFLAMMATION: 'Protect 7 to 8 hours of sleep and take two full rest days a week.'
};

function sampleDay(diet, focus) {
  const d = diet || 'veg';
  const sugarAware = focus.indexOf('GLUCOSE') >= 0 || focus.indexOf('TRIGLYCERIDES') >= 0;
  const iron = focus.indexOf('IRON') >= 0;
  const breakfast = {
    veg: 'Vegetable oats upma or moong chilla with curd, plus a handful of almonds and walnuts.',
    egg: 'Two-egg vegetable omelette with one multigrain toast or a small bowl of oats, plus a few nuts.',
    nonveg: 'Two-egg vegetable omelette with one multigrain toast or a small bowl of oats, plus a few nuts.',
    vegan: 'Moong chilla or vegetable oats upma with a tofu scramble, plus almonds and walnuts.'
  }[d];
  const lunch = {
    veg: `Salad first, then dal or rajma, a sabzi, curd and ${sugarAware ? 'one or two rotis or a small portion of rice' : 'two rotis or a cup of rice'}.`,
    egg: `Salad first, then dal or egg curry, a sabzi, curd and ${sugarAware ? 'one or two rotis or a small portion of rice' : 'two rotis or a cup of rice'}.`,
    nonveg: `Salad first, then grilled or curried chicken or fish, dal, a sabzi and ${sugarAware ? 'one or two rotis or a small portion of rice' : 'two rotis or a cup of rice'}.`,
    vegan: `Salad first, then dal or chana, a tofu or soy sabzi and ${sugarAware ? 'one or two rotis or a small portion of rice' : 'two rotis or a cup of rice'}.`
  }[d];
  const snack = {
    veg: `Roasted chana or sprouts chaat with lemon, or a fruit with a handful of peanuts${iron ? ', plus two dates' : ''}.`,
    egg: `A boiled egg or roasted chana, with a fruit${iron ? ' and two dates' : ''}.`,
    nonveg: `A boiled egg or roasted chana, with a fruit${iron ? ' and two dates' : ''}.`,
    vegan: `Roasted chana, sprouts chaat with lemon, or a fruit with peanuts${iron ? ', plus two dates' : ''}.`
  }[d];
  const dinner = {
    veg: 'A lighter plate, eaten two to three hours before bed: paneer or dal, a large serving of vegetables and one roti or a small bowl of millet khichdi.',
    egg: 'A lighter plate, eaten two to three hours before bed: egg bhurji or dal, a large serving of vegetables and one roti.',
    nonveg: 'A lighter plate, eaten two to three hours before bed: fish or chicken, a large serving of vegetables and one roti or a small portion of rice.',
    vegan: 'A lighter plate, eaten two to three hours before bed: tofu or dal, a large serving of vegetables and one roti or a small bowl of millet khichdi.'
  }[d];
  return [
    'On waking: a large glass of water. Tea or coffee without sugar, at least an hour away from iron-rich meals.',
    'Breakfast: ' + breakfast,
    'Lunch: ' + lunch,
    'Evening: ' + snack,
    'Dinner: ' + dinner,
    'Through the day: 2.5 to 3 litres of water, and a 10 to 15 minute walk after your two largest meals.'
  ];
}

/**
 * @returns {{ intro, add:[], limit:[], day:[], weeks:[], supplements:[] }|null}
 */
function buildNutritionPlan(report, ctx, patterns) {
  const c = ctx || {};
  const focus = focusAreas(report, patterns);
  const diet = c.diet || '';
  const top = focus.slice(0, 5);
  const dietNote = diet ? `It is written for a ${DIET_LABEL[diet].toLowerCase()} diet.`
    : 'You did not tell us your diet type, so it lists vegetarian options first.';

  if (!top.length) {
    return {
      intro: `Your results do not call for a corrective diet. This plan is about keeping them where they are. ${dietNote}`,
      add: ['A source of protein at every meal, vegetables at lunch and dinner, a fruit or two a day, and a small handful of nuts.',
        'Whole grains and millets in place of maida and polished rice for most meals.'],
      limit: ['Sugar, sweet drinks and fried snacks to occasional treats.', 'Alcohol to within low-risk limits, with several alcohol-free days each week.'],
      day: sampleDay(diet, []),
      weeks: [
        'Week 1: Write down what you eat for three days. It shows where the easy wins are.',
        'Week 2: Make sure every meal has a clear source of protein and a serving of vegetables.',
        'Week 3: Settle into a routine of 30 minutes of movement on five days.',
        'Week 4: Fix a regular sleep time. Then keep all four habits going.'
      ],
      supplements: []
    };
  }

  const weeks = [];
  const pool = top.map((f) => WEEK_FOCUS[f]).filter(Boolean);
  ['Week 1', 'Week 2', 'Week 3'].forEach((w, i) => {
    weeks.push(`${w}: ${pool[i] || ['Make sure every meal has a clear source of protein and a serving of vegetables.',
      'Build up to 30 minutes of brisk walking on five days and two strength sessions.',
      'Fix a regular sleep time and protect 7 to 8 hours.'][i]}`);
  });
  weeks.push('Week 4: Keep every change from the first three weeks going together, and note how you feel: energy, sleep, digestion and training. Bring these notes to your follow-up.');

  return {
    intro: `This plan is built from the findings on this report, in order of importance. ${dietNote} Your sports nutritionist will adjust the portions and foods to your routine on your call.`,
    add: top.map((f) => (ADD[f] ? ADD[f](diet) : '')).filter(Boolean),
    limit: top.map((f) => (LIMIT[f] ? LIMIT[f](diet) : '')).filter(Boolean),
    day: sampleDay(diet, top),
    weeks,
    supplements: top.map((f) => (typeof SUPPLEMENTS[f] === 'function' ? SUPPLEMENTS[f](diet) : SUPPLEMENTS[f])).filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// Retest plan
// ---------------------------------------------------------------------------

/**
 * @returns {{ title, subtitle, items: Array<{text}> }}
 */
function buildRetestPlan(report, ctx, patterns) {
  const c = ctx || {};
  const M = indexMarkers(report);
  const has = (id) => M.has(id);
  const keys = (patterns || []).map((p) => p.key);
  const any = (...k) => k.some((x) => keys.indexOf(x) >= 0);
  const items = [];
  const add = (text) => { if (text && items.length < 10) items.push({ text }); };

  if (any('KIDNEY')) add('Kidney panel (creatinine, eGFR, urea) with a urine test for protein: within 2 to 4 weeks, after two rest days and good hydration.');
  if (any('DIABETES_RANGE')) add('Fasting glucose and HbA1c: as your doctor advises, usually within a few weeks to confirm.');
  if (any('IRON_DEFICIENCY', 'ANAEMIA', 'MACROCYTIC')) add('Complete blood count: 6 to 8 weeks after starting treatment, to check haemoglobin is rising.');
  if (any('THYROID')) add('Thyroid profile: in 6 to 8 weeks, or as your doctor advises. Stop biotin three days before.');
  if (any('LIVER_ENZYMES')) add('Liver enzymes: in 2 to 4 weeks, after three days without hard training or alcohol.');
  if (any('FATTY_LIVER_TYPE')) add('Liver enzymes and triglycerides: in 12 weeks, to see the effect of the food and weight changes.');
  if (any('ATHEROGENIC_LIPIDS', 'HIGH_TG', 'INSULIN_RESISTANCE')) add('Lipid profile: in 12 weeks, after a 10 to 12 hour fast. Cholesterol needs about three months to show the effect of changes.');
  if (any('PREDIABETES_RANGE', 'INSULIN_RESISTANCE')) add('HbA1c and fasting glucose: in 12 weeks. HbA1c reflects three months, so testing earlier shows little.');
  if (any('LOW_VITAMIN_D')) add('Vitamin D: 12 weeks after starting a supplement.');
  if (any('LOW_B12', 'LOW_IRON_STORES')) add('Vitamin B12 and ferritin: in 12 weeks.');
  if (any('URIC_ACID')) add('Uric acid: in 12 weeks.');
  if (any('INFLAMMATION')) add('Inflammation markers (hs-CRP or ESR): in 2 to 3 weeks if you were unwell or training hard around this test.');

  // Tests this report did not include and the findings make worth adding.
  const addTests = [];
  if (any('IRON_DEFICIENCY', 'ANAEMIA', 'LOW_IRON_STORES') && !has('FERRITIN')) addTests.push('ferritin and iron studies');
  if (any('IRON_DEFICIENCY', 'ANAEMIA', 'MACROCYTIC') && !has('VITAMIN_B12')) addTests.push('vitamin B12 and folate');
  if (any('PREDIABETES_RANGE', 'INSULIN_RESISTANCE') && !has('FASTING_INSULIN')) addTests.push('fasting insulin');
  if (any('PREDIABETES_RANGE', 'INSULIN_RESISTANCE', 'DIABETES_RANGE') && !has('HBA1C')) addTests.push('HbA1c');
  if (any('ATHEROGENIC_LIPIDS') && !has('APO_B')) addTests.push('ApoB');
  if ((any('ATHEROGENIC_LIPIDS') || (c.familyHistory || []).indexOf('heart') >= 0) && !has('LP_A')) addTests.push('lipoprotein(a), which is inherited and only needs testing once in a lifetime');
  if (any('THYROID') && !has('FREE_T4')) addTests.push('free T4');
  if (any('THYROID') && !has('ANTI_TPO')) addTests.push('thyroid antibodies (anti-TPO)');
  if (!has('VITAMIN_D')) addTests.push('vitamin D');
  if (!has('VITAMIN_B12') && addTests.indexOf('vitamin B12 and folate') < 0) addTests.push('vitamin B12');
  if (!has('HS_CRP') && !has('CRP') && (any('ATHEROGENIC_LIPIDS', 'INSULIN_RESISTANCE'))) addTests.push('hs-CRP');
  if (addTests.length) add(`Worth adding next time: ${addTests.slice(0, 6).join('; ')}.`);

  if (!items.length || (items.length === 1 && addTests.length)) {
    add('Full panel: once a year, at the same lab if possible, so results are comparable.');
  } else {
    add('Full panel: in 12 weeks alongside the tests above, then yearly once results are stable. Use the same lab and the same fasting routine so the comparison is fair.');
  }
  return {
    title: 'Your Retest Plan',
    subtitle: 'What to test again, when, and why. Upload the new report and we will show you exactly what changed.',
    items
  };
}

// ---------------------------------------------------------------------------
// Questions for the doctor call
// ---------------------------------------------------------------------------

function buildQuestions(report, ctx, patterns) {
  const c = ctx || {};
  const items = [];
  const add = (text) => { if (text && items.length < 8 && !items.some((i) => i.text === text)) items.push({ text }); };

  ((report && report.priorities) || []).slice(0, 2).forEach((p) => {
    add(`My ${String(p.markerName || p.title || '').replace(/^Bring\s+/i, '').replace(/\s+(into range|down|up)$/i, '')} is ${p.result}. What is the most likely cause in my case, and do I need any further test?`);
  });
  (patterns || []).filter((p) => p.requiresProfessional).slice(0, 2).forEach((p) => {
    add(`The report notes "${p.title.toLowerCase()}". Does this need treatment, or can we watch it?`);
  });
  if (c.medicinesText) add('Should any of the medicines or supplements I take be changed, stopped or timed differently, given these results?');
  if ((c.familyHistory || []).length) add('With my family history, do I need any screening or targets that are stricter than the standard ranges?');
  if ((c.symptoms || []).length) add(`Could these results explain my ${c.symptoms.map((k) => SYMPTOM_LABEL[k]).filter(Boolean).slice(0, 2).join(' and ')}?`);
  add('Which single result on this report matters most for my long-term health?');
  add('Which supplements, if any, should I take, at what dose and for how long?');
  add('When exactly should I retest, and what improvement should I expect by then?');
  if (c.activity === 'athlete' || c.activity === 'active') add('Is my current training load safe to continue while we correct these results?');

  return {
    title: 'Questions for Your Doctor Call',
    subtitle: 'Bring this page to your call. Tick what you want answered and add your own.',
    items
  };
}

// ---------------------------------------------------------------------------
// Draft of the doctor's summary
// ---------------------------------------------------------------------------

/**
 * A starting draft the doctor rewrites. It only restates what the engines found;
 * the judgement, the cause and the advice are the doctor's to add.
 */
function buildSummaryDraft(report, ctx, patterns) {
  const R = report || {};
  const c = ctx || {};
  const sum = R.healthMapSummary || {};
  const paras = [];
  const first = String((R.client && R.client.name) || '').trim().split(/\s+/)[0];

  const good = (R.areas || []).filter((a) => a.grade === 'A').map((a) => a.label);
  const bad = (R.areas || []).filter((a) => a.grade === 'C' || a.grade === 'D').map((a) => `${a.label} (${a.grade})`);
  let open = `${first ? first + ', I' : 'I'} have reviewed your blood report dated ${R.screeningDate ? formatDate(R.screeningDate) : 'as shown'}, covering ${R.markerCount || 0} markers across ${sum.assessed || 0} health areas.`;
  if (!bad.length) open += ' Your results are reassuring overall.';
  paras.push(open);

  if (bad.length) paras.push(`The areas that need attention are ${bad.join(', ')}.` + (good.length ? ` ${good.join(', ')} ${good.length === 1 ? 'is' : 'are'} healthy.` : ''));
  else if (good.length) paras.push(`${good.join(', ')} ${good.length === 1 ? 'is' : 'are'} all healthy.`);

  const flagged = (patterns || []).filter((p) => p.level >= LEVEL.WATCH).slice(0, 3);
  if (flagged.length) {
    paras.push('Reading the results together: ' + flagged.map((p) => p.meaning).join(' '));
  }
  if (c.medicinesText || c.conditionsText) {
    paras.push('I have read these results in the light of ' +
      [c.conditionsText ? `your history (${c.conditionsText})` : '', c.medicinesText ? `what you take (${c.medicinesText})` : ''].filter(Boolean).join(' and ') + '.');
  }
  const pro = (patterns || []).filter((p) => p.requiresProfessional);
  paras.push(pro.length
    ? 'We will go through the cause and the next steps for these findings on our call. Please do not start or stop any medicine before then.'
    : 'None of these findings is urgent. We will go through what to change and when to retest on our call.');
  return paras.join('\n\n');
}

module.exports = {
  DIETS, ACTIVITY, ALCOHOL, SMOKING, FASTING, FAMILY, SYMPTOMS,
  DIET_LABEL, ACTIVITY_LABEL, MEDICINE_RULES, CONDITION_RULES, GOALS,
  normalizeContext, hasPersonalDetail, profileLine,
  buildGoalSection, buildContextNotes, focusAreas, buildNutritionPlan,
  buildRetestPlan, buildQuestions, buildSummaryDraft
};
