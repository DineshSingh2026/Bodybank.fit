'use strict';

/**
 * BodyBank — REPORT COPY.
 *
 * Every client-facing sentence in the graded report is produced here, from a
 * template, deterministically. No model writes any of this by default.
 *
 * ─── THE RULES THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 * A blood report is read by someone who is worried. Copy is therefore constrained:
 *
 *   • Never name a condition, and never say a result "indicates" a disease.
 *   • Never state the absence of disease. "Your liver is healthy" is not something
 *     a lipid panel can support, so this file cannot produce that sentence.
 *   • Never use "critical", "dangerous" or "nothing to worry about" as a label.
 *     A panic-level result is described as "well outside the preferred range" and
 *     routed to a professional — the urgency is in the action, not the adjective.
 *   • Say "above / below the preferred range", not "abnormal".
 *   • Two sentences maximum per insight. One idea per sentence.
 *
 * tests/graded-safety.js scans every string this module can emit against the
 * prohibited-phrase list, so a careless edit here fails the build rather than
 * reaching a client.
 *
 * ─── WHY TEMPLATES RATHER THAN A MODEL ────────────────────────────────────────
 * The grade is arithmetic and reproducible; the sentence next to it should be too.
 * A model may optionally rewrite an insight for readability (see the copy pass in
 * the report builder), but it only ever paraphrases the structured rationale, it is
 * screened against the same prohibited list, and any failure falls back to exactly
 * these strings. The report is therefore complete and safe with the model switched
 * off entirely.
 */

const { STATUS } = require('./classify');

/** How each status is named to the client. Note: no "critical", no "abnormal". */
const STATUS_LABEL = {
  WITHIN_RANGE: 'Within range',
  BORDERLINE_LOW: 'Low end of range',
  BORDERLINE_HIGH: 'High end of range',
  LOW: 'Below range',
  HIGH: 'Above range',
  CRITICAL_LOW: 'Well below range',
  CRITICAL_HIGH: 'Well above range',
  NOT_AVAILABLE: 'Not measured'
};

/** A short, non-colour cue so status survives greyscale and colour-blind reading. */
const STATUS_MARK = {
  WITHIN_RANGE: '=',
  BORDERLINE_LOW: 'v',
  BORDERLINE_HIGH: '^',
  LOW: 'vv',
  HIGH: '^^',
  CRITICAL_LOW: 'vvv',
  CRITICAL_HIGH: '^^^',
  NOT_AVAILABLE: '-'
};

const TREND_LABEL = {
  IMPROVED: 'Improved',
  STABLE: 'Stable',
  NEEDS_ATTENTION: 'Needs Attention',
  NEW_FINDING: 'New Finding',
  RESOLVED: 'Resolved',
  NO_SIGNIFICANT_CHANGE: 'No Significant Change',
  NOT_COMPARABLE: 'No comparison available'
};

const TREND_MARK = {
  IMPROVED: 'up',
  STABLE: 'flat',
  NEEDS_ATTENTION: 'down',
  NEW_FINDING: 'new',
  RESOLVED: 'resolved',
  NO_SIGNIFICANT_CHANGE: 'flat',
  NOT_COMPARABLE: ''
};

const PROFESSIONAL_LINE = 'Discuss this result with your healthcare professional.';

const DISCLAIMER =
  'This BodyBank Health Report provides an informational interpretation of your laboratory results to ' +
  'support healthier decisions. Grades and insights are a BodyBank framework, not a medical diagnosis. ' +
  'They do not replace consultation with a qualified healthcare professional. If any result is marked ' +
  '"Further Evaluation", or if you have symptoms or concerns, please consult your doctor.';

// ---------------------------------------------------------------------------
// Per-marker copy
// ---------------------------------------------------------------------------
//
//   what  one clause naming what the marker measures (never a diagnosis)
//   high  what a raised result can reflect
//   low   what a reduced result can reflect
//   act   the lifestyle or follow-up action, phrased as an option
//
// A marker without an entry falls back to GENERIC, which is still specific enough
// to be useful because it names the marker and the direction.

const MARKER_COPY = {
  LDL_C: {
    what: 'LDL carries cholesterol into the artery wall, which is why it is the lipid most closely tracked for heart health',
    high: 'Above the preferred range, LDL contributes to cholesterol build-up in the arteries over time',
    low: 'A lower LDL is generally favourable for cardiovascular health',
    act: 'Soluble fibre (oats, barley, beans, apples), less saturated fat, and regular aerobic activity are the strongest dietary levers on LDL'
  },
  NON_HDL_C: {
    what: 'Non-HDL captures every cholesterol particle that can contribute to artery build-up, not only LDL',
    high: 'A raised non-HDL suggests more cholesterol-carrying particles in circulation than preferred',
    low: 'A lower non-HDL is generally favourable',
    act: 'The same levers as LDL apply: more soluble fibre, less saturated and trans fat, and regular activity'
  },
  APO_B: {
    what: 'ApoB counts the actual number of cholesterol particles that can enter an artery wall',
    high: 'A raised ApoB means more of these particles are circulating than preferred',
    low: 'A lower ApoB is generally favourable',
    act: 'Dietary fat quality and consistent aerobic exercise move ApoB alongside LDL'
  },
  LP_A: {
    what: 'Lipoprotein(a) is largely set by genetics and stays fairly stable through life',
    high: 'A raised Lp(a) is an inherited pattern rather than something diet created',
    low: 'A lower Lp(a) is generally favourable',
    act: 'Because it is inherited, the usual approach is to manage the other cardiovascular markers more tightly'
  },
  TRIGLYCERIDES: {
    what: 'Triglycerides are the fats carried in the blood after meals and made from surplus carbohydrate and alcohol',
    high: 'Above the preferred range, triglycerides commonly reflect refined carbohydrate, alcohol intake or surplus calories',
    low: 'A lower triglyceride level is generally favourable',
    act: 'Reducing sugary drinks, refined carbohydrate and alcohol, and adding oily fish or omega-3, moves this marker quickly'
  },
  HDL_C: {
    what: 'HDL helps carry cholesterol away from the artery wall, so a higher result is the favourable direction here',
    high: 'A higher HDL is generally favourable',
    low: 'Below the preferred range, HDL offers less of this protective transport',
    act: 'Regular aerobic exercise, olive oil and nuts, and avoiding smoking are the main levers that raise HDL'
  },
  TOTAL_CHOL: {
    what: 'Total cholesterol adds together every cholesterol fraction, including the protective HDL',
    high: 'A raised total is worth reading alongside LDL and HDL rather than on its own',
    low: 'A lower total cholesterol is generally favourable',
    act: 'Interpret this alongside LDL and HDL — the split matters more than the total'
  },
  VLDL_C: {
    what: 'VLDL is the cholesterol fraction that carries triglycerides, so it tends to move with them',
    high: 'A raised VLDL usually accompanies raised triglycerides',
    low: 'A lower VLDL is generally favourable',
    act: 'The triglyceride levers apply here: less refined carbohydrate, less alcohol'
  },
  CHOL_HDL_RATIO: {
    what: 'This ratio compares total cholesterol against the protective HDL fraction',
    high: 'A higher ratio means proportionally less of the protective fraction',
    low: 'A lower ratio is generally favourable',
    act: 'Raising HDL through aerobic exercise improves this ratio as much as lowering total cholesterol does'
  },
  HBA1C: {
    what: 'HbA1c reflects your average blood sugar over roughly the past three months, so it is not affected by one meal',
    high: 'Above the preferred range, HbA1c indicates blood sugar has been running higher than preferred over that window',
    low: 'A lower HbA1c is generally favourable',
    act: 'Walking for 10–15 minutes after meals, reducing refined carbohydrate, and resistance training all lower HbA1c over a few months'
  },
  FASTING_GLUCOSE: {
    what: 'Fasting glucose is a single snapshot of blood sugar after an overnight fast',
    high: 'A raised fasting glucose is one reading and is best read alongside HbA1c',
    low: 'A low fasting glucose reading is worth confirming, especially if you felt unwell before the test',
    act: 'Pair this with HbA1c for the fuller picture; post-meal walking and lower refined carbohydrate help both'
  },
  POST_PRANDIAL_GLUCOSE: {
    what: 'This measures how far blood sugar rises after a meal',
    high: 'A raised post-meal reading suggests the body is clearing sugar more slowly than preferred',
    low: 'A lower post-meal reading is generally favourable',
    act: 'Adding protein and fibre to meals, and walking afterwards, blunts the post-meal rise'
  },
  FASTING_INSULIN: {
    what: 'Fasting insulin shows how much insulin the body needs to hold blood sugar steady',
    high: 'A raised fasting insulin can appear years before blood sugar itself changes',
    low: 'A lower fasting insulin is generally favourable',
    act: 'Resistance training and reduced refined carbohydrate are the most reliable levers'
  },
  HOMA_IR: {
    what: 'HOMA-IR combines fasting glucose and insulin into a single insulin-sensitivity index',
    high: 'A raised index suggests the body is working harder to keep blood sugar steady',
    low: 'A lower index is generally favourable',
    act: 'Regular resistance training, adequate sleep and reduced refined carbohydrate move this index'
  },
  ALT: {
    what: 'ALT is an enzyme concentrated in liver cells and released when they are under strain',
    high: 'Above the preferred range, ALT indicates the liver is under some strain — commonly from stored fat, alcohol, medication or a recent infection',
    low: 'A low ALT is not generally a concern',
    act: 'Reducing alcohol, added sugar and ultra-processed food, plus gradual weight loss if applicable, lowers ALT'
  },
  AST: {
    what: 'AST is found in the liver and also in muscle, so intense exercise before a test can raise it',
    high: 'A raised AST is read alongside ALT; a recent hard workout can lift it on its own',
    low: 'A low AST is not generally a concern',
    act: 'If you trained hard in the 48 hours before the draw, a retest after rest gives a cleaner reading'
  },
  GGT: {
    what: 'GGT responds to alcohol, certain medications and bile flow',
    high: 'A raised GGT most often reflects alcohol intake or medication rather than the liver cells themselves',
    low: 'A low GGT is not generally a concern',
    act: 'A period without alcohol, and a medication review with your doctor, usually clarifies this result'
  },
  ALP: {
    what: 'ALP comes from bile ducts and bone, so it can move for reasons outside the liver',
    high: 'A raised ALP is read alongside GGT to separate a liver cause from a bone one',
    low: 'A low ALP is uncommon and rarely significant on its own',
    act: 'This is best interpreted alongside GGT and calcium'
  },
  BILIRUBIN_TOTAL: {
    what: 'Bilirubin is the pigment produced as old red blood cells are recycled',
    high: 'A modest rise is common and is often an inherited, harmless variant, particularly after fasting',
    low: 'A low bilirubin is not generally a concern',
    act: 'Worth tracking on your next screening, particularly alongside the liver enzymes'
  },
  ALBUMIN: {
    what: 'Albumin is the main protein the liver makes, and it reflects both liver function and protein nutrition',
    high: 'A high albumin most often reflects dehydration at the time of the draw',
    low: 'A low albumin can reflect protein intake, inflammation or liver function',
    act: 'Adequate protein at each meal, and steady hydration before a blood draw, both matter here'
  },
  TOTAL_PROTEIN: {
    what: 'Total protein adds albumin and globulin together',
    high: 'A high total protein is read alongside the albumin and globulin split',
    low: 'A low total protein is read alongside albumin',
    act: 'Interpret with albumin rather than on its own'
  },
  EGFR: {
    what: 'eGFR estimates how much blood the kidneys filter each minute, and it is the single best summary of kidney function',
    high: 'A higher eGFR is the favourable direction',
    low: 'A reduced eGFR means the kidneys are filtering more slowly than preferred',
    act: 'Steady hydration, moderate salt and protein, and keeping blood pressure and blood sugar in range protect filtration'
  },
  CREATININE: {
    what: 'Creatinine is a muscle waste product the kidneys clear, so muscle mass and protein intake affect it',
    high: 'A raised creatinine can reflect filtration, but also high muscle mass, a heavy protein intake or dehydration',
    low: 'A low creatinine often simply reflects lower muscle mass',
    act: 'Read this alongside eGFR; hydrate normally in the days before a retest'
  },
  UREA: {
    what: 'Urea is a protein waste product the kidneys clear',
    high: 'A raised urea can reflect dehydration or a high protein intake as readily as filtration',
    low: 'A low urea can reflect a low protein intake',
    act: 'Steady hydration in the days before a retest gives a cleaner reading'
  },
  BUN: {
    what: 'Blood urea nitrogen is a protein waste product the kidneys clear',
    high: 'A raised BUN can reflect dehydration or a high protein intake as readily as filtration',
    low: 'A low BUN can reflect a low protein intake',
    act: 'Steady hydration in the days before a retest gives a cleaner reading'
  },
  URIC_ACID: {
    what: 'Uric acid is produced as the body breaks down purines from food and from its own cells',
    high: 'A raised uric acid is linked to red meat, seafood, alcohol and sugary drinks, and can affect joints',
    low: 'A low uric acid is not generally a concern',
    act: 'Less alcohol (especially beer), fewer sugary drinks, more water, and moderating red meat and shellfish'
  },
  POTASSIUM: {
    what: 'Potassium keeps nerve and heart-muscle signalling steady, and its safe band is narrow',
    high: 'A raised potassium is worth confirming, as a delayed or difficult sample can raise it artificially',
    low: 'A low potassium can follow fluid loss or certain medications',
    act: PROFESSIONAL_LINE
  },
  SODIUM: {
    what: 'Sodium reflects the balance between salt and water in the body',
    high: 'A raised sodium usually reflects hydration status',
    low: 'A low sodium can reflect fluid balance or medication',
    act: 'Steady hydration; a repeat sample confirms an unexpected result'
  },
  TSH: {
    what: 'TSH is the signal the brain sends to the thyroid, so it rises when the thyroid is under-responding and falls when it is over-responding',
    high: 'A raised TSH means the body is signalling harder for thyroid hormone',
    low: 'A reduced TSH means less signalling is needed',
    act: 'This is best read with Free T4. Any medication change is a decision for your doctor'
  },
  FREE_T4: {
    what: 'Free T4 is the circulating thyroid hormone available to your tissues',
    high: 'A raised Free T4 is read together with TSH',
    low: 'A reduced Free T4 is read together with TSH',
    act: 'Interpret alongside TSH rather than on its own'
  },
  FREE_T3: {
    what: 'Free T3 is the more active thyroid hormone, converted from T4',
    high: 'A raised Free T3 is read together with TSH and Free T4',
    low: 'A reduced Free T3 is read together with TSH and Free T4',
    act: 'Adequate selenium, zinc and calorie intake support the conversion of T4 to T3'
  },
  ANTI_TPO: {
    what: 'Anti-TPO is an antibody directed at the thyroid, and it can be present without any change in thyroid hormones',
    high: 'A raised anti-TPO indicates thyroid-directed antibody activity',
    low: 'A low anti-TPO is the expected result',
    act: PROFESSIONAL_LINE
  },
  HEMOGLOBIN: {
    what: 'Haemoglobin is the protein in red cells that carries oxygen to your tissues',
    high: 'A raised haemoglobin can reflect dehydration, altitude or smoking',
    low: 'Below the preferred range, haemoglobin means less oxygen-carrying capacity, which often shows up as fatigue or breathlessness on exertion',
    act: 'Iron-rich foods with a vitamin C source at the same meal, and adequate B12 and folate, support haemoglobin'
  },
  HEMATOCRIT: {
    what: 'Haematocrit is the share of your blood volume made up of red cells, and it moves with haemoglobin',
    high: 'A raised haematocrit often reflects hydration at the time of the draw',
    low: 'A reduced haematocrit accompanies reduced haemoglobin',
    act: 'Read alongside haemoglobin rather than on its own'
  },
  RBC: {
    what: 'The red cell count is the number of oxygen-carrying cells, and it moves with haemoglobin',
    high: 'A raised count is read alongside haemoglobin and haematocrit',
    low: 'A reduced count is read alongside haemoglobin and haematocrit',
    act: 'Read alongside haemoglobin rather than on its own'
  },
  MCV: {
    what: 'MCV is the average size of your red cells, and its direction points to different causes',
    high: 'Larger-than-preferred red cells are commonly linked to B12 or folate status, or to alcohol intake',
    low: 'Smaller-than-preferred red cells are commonly linked to iron availability',
    act: 'The useful next step is checking ferritin, B12 and folate together'
  },
  RDW: {
    what: 'RDW measures how much your red cells vary in size, and it often shifts before other red-cell markers do',
    high: 'A raised RDW means the cells vary more in size than preferred, which can be an early sign of a nutrient shortfall',
    low: 'A low RDW is not a concern',
    act: 'Worth reading together with MCV, ferritin and B12'
  },
  WBC: {
    what: 'The white cell count reflects immune activity',
    high: 'A raised count commonly follows a recent infection, injury or physical stress',
    low: 'A reduced count can follow a recent viral infection or reflect certain medications',
    act: 'A repeat count once you are well gives a cleaner picture'
  },
  PLATELETS: {
    what: 'Platelets are the cells that let blood clot',
    high: 'A raised platelet count often accompanies inflammation or a recent infection',
    low: 'A reduced platelet count is worth confirming with a repeat sample',
    act: PROFESSIONAL_LINE
  },
  VITAMIN_D: {
    what: 'Vitamin D comes mostly from sunlight on skin, with a small contribution from food, and it supports bone, muscle and immune function',
    high: 'A high vitamin D is almost always from supplementation and is worth reviewing',
    low: 'Below the preferred range, vitamin D is very common in people who work indoors or cover up outdoors',
    act: 'Regular midday sun exposure where practical, and a supplement dose set by your healthcare professional, with a retest after about three months'
  },
  VITAMIN_B12: {
    what: 'B12 comes almost entirely from animal foods and is essential for nerves and red cell formation',
    high: 'A high B12 usually reflects recent supplementation or injections',
    low: 'Below the preferred range, B12 is common on vegetarian and vegan diets, and with long-term acid-reducing medication',
    act: 'Dairy, eggs, fish and meat are the food sources; a fortified food or supplement covers a plant-based diet'
  },
  FOLATE: {
    what: 'Folate works alongside B12 in red cell formation and comes from leafy greens, legumes and fortified grains',
    high: 'A high folate is not generally a concern',
    low: 'Below the preferred range, folate limits healthy red cell formation',
    act: 'Leafy greens, legumes, citrus and fortified grains raise folate reliably'
  },
  FERRITIN: {
    what: 'Ferritin is the stored form of iron and is the earliest marker to fall when iron runs short',
    high: 'A raised ferritin can reflect iron stores, but inflammation and alcohol also lift it',
    low: 'Below the preferred range, ferritin means iron stores are running low, often before haemoglobin changes at all',
    act: 'Iron-rich foods with vitamin C at the same meal; tea and coffee at meals reduce absorption. Supplement doses should be set by your healthcare professional'
  },
  SERUM_IRON: {
    what: 'Serum iron is the iron circulating right now, and it swings through the day and with recent meals',
    high: 'A raised serum iron is best read with ferritin and transferrin saturation',
    low: 'A reduced serum iron is best read with ferritin, which reflects stores rather than the moment',
    act: 'Ferritin is the more stable marker of iron status'
  },
  TRANSFERRIN_SAT: {
    what: 'Transferrin saturation shows how much of your iron-transport capacity is currently carrying iron',
    high: 'A raised saturation is read alongside ferritin',
    low: 'A reduced saturation supports a picture of limited iron availability',
    act: 'Read alongside ferritin for iron status'
  },
  CALCIUM: {
    what: 'Blood calcium is tightly regulated and reflects the balance between bone, gut and kidney rather than recent diet',
    high: 'A raised calcium is worth confirming with a repeat sample',
    low: 'A reduced calcium is often linked to vitamin D status',
    act: 'Read alongside vitamin D; an unexpected result is worth repeating'
  },
  MAGNESIUM: {
    what: 'Magnesium supports muscle and nerve function and sleep quality',
    high: 'A raised magnesium usually reflects supplementation',
    low: 'A reduced magnesium can follow a diet low in nuts, seeds, legumes and greens',
    act: 'Nuts, seeds, legumes, whole grains and leafy greens are the main food sources'
  },
  ZINC: {
    what: 'Zinc supports immune function, wound healing and taste',
    high: 'A raised zinc usually reflects supplementation',
    low: 'A reduced zinc can follow a diet low in meat, shellfish, legumes and seeds',
    act: 'Meat, shellfish, legumes, seeds and whole grains supply zinc'
  },
  HS_CRP: {
    what: 'hs-CRP measures low-grade inflammation across the body and is sensitive enough to pick up small changes',
    high: 'A raised hs-CRP indicates inflammation somewhere in the body; a recent infection, injury or hard training session can raise it temporarily',
    low: 'A low hs-CRP is the favourable direction',
    act: 'A retest once any recent infection has cleared separates a temporary rise from a persistent one'
  },
  CRP: {
    what: 'CRP is a general marker of inflammation',
    high: 'A raised CRP indicates active inflammation, commonly from a recent infection or injury',
    low: 'A low CRP is the favourable direction',
    act: 'A retest once you are well separates a temporary rise from a persistent one'
  },
  ESR: {
    what: 'ESR is a slower-moving general marker of inflammation',
    high: 'A raised ESR indicates inflammation and changes more slowly than CRP',
    low: 'A low ESR is the favourable direction',
    act: 'Read alongside CRP; a retest after recovery is informative'
  }
};

const GENERIC = {
  high: 'This result sits above its preferred range.',
  low: 'This result sits below its preferred range.',
  within: 'This result sits within its preferred range.',
  act: 'Worth tracking on your next screening.'
};

// ---------------------------------------------------------------------------
// Sentence builders
// ---------------------------------------------------------------------------

function cap(s) {
  const t = String(s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** Ensure a sentence ends in exactly one full stop. */
function sentence(s) {
  const t = String(s || '').trim().replace(/[.\s]+$/, '');
  return t ? t + '.' : '';
}

function isHigh(status) {
  return status === STATUS.HIGH || status === STATUS.BORDERLINE_HIGH || status === STATUS.CRITICAL_HIGH;
}
function isLow(status) {
  return status === STATUS.LOW || status === STATUS.BORDERLINE_LOW || status === STATUS.CRITICAL_LOW;
}

/**
 * The BODYBANK INSIGHT line for one marker. Two sentences at most:
 * what the marker is, then what this particular result reflects.
 * @param {object} marker MarkerResult
 * @returns {string}
 */
function markerInsight(marker) {
  if (!marker) return '';
  const c = MARKER_COPY[marker.markerId];
  const st = marker.status;

  if (st === STATUS.NOT_AVAILABLE) return '';

  if (!c) {
    if (isHigh(st)) return GENERIC.high;
    if (isLow(st)) return GENERIC.low;
    return GENERIC.within;
  }

  if (st === STATUS.WITHIN_RANGE) {
    return sentence(cap(c.what));
  }

  const detail = isHigh(st) ? c.high : c.low;
  const borderline = st === STATUS.BORDERLINE_HIGH || st === STATUS.BORDERLINE_LOW;

  let second = sentence(cap(detail));
  if (borderline) {
    second = second.replace(/\.$/, ', and this result sits just inside the boundary.');
  }
  return sentence(cap(c.what)) + ' ' + second;
}

/** The NEXT STEP line for one marker. */
function markerNextStep(marker) {
  if (!marker) return '';
  const c = MARKER_COPY[marker.markerId];
  if (marker.severity >= 3) return PROFESSIONAL_LINE;
  if (!c || !c.act) return GENERIC.act;
  return sentence(cap(c.act));
}

/**
 * The one- or two-sentence summary at the top of a health-area card.
 * It states what was measured and what stood out — never an organ-level verdict.
 */
function areaSummary(area, areaMeta) {
  const label = (areaMeta && areaMeta.label) || 'This area';
  const n = area.markersEvaluated.length;
  const flagged = (area.keyFindings || []).filter((m) => m.severity > 0);

  if (area.grade === 'NOT_ASSESSED') {
    return sentence(
      `This screening did not include enough tests to assess ${label.toLowerCase()} responsibly`
    );
  }

  if (!flagged.length) {
    return n === 1
      ? 'The one marker measured in this area sits within its preferred range.'
      : `All ${n} markers measured in this area sit within their preferred range.`;
  }

  // Name up to three, then count the rest, so the sentence stays readable on a
  // long panel without hiding anything — the full list is in the findings below.
  const shown = flagged.slice(0, 3).map((m) => m.displayName);
  const rest = flagged.length - shown.length;
  // Build the list in one pass so "A, B and C" and "A, B, C and 2 others" both
  // read correctly — appending the overflow separately produced "C and 2 others".
  const parts = rest > 0 ? shown.concat([`${rest} other${rest === 1 ? '' : 's'}`]) : shown;
  const list = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];

  const plural = flagged.length > 1;
  const measured = n === 1
    ? 'One marker was measured in this area'
    : `${n} markers were measured in this area`;

  return sentence(measured) + ' ' +
    sentence(`${list} ${plural ? 'sit outside their' : 'sits outside its'} preferred range`);
}

/** The "What to focus on" line for a health-area card. */
function areaFocus(area, areaMeta) {
  const flagged = (area.keyFindings || []).filter((m) => m.severity > 0);
  // Prefer the action attached to the most important flagged marker; fall back to
  // the area's standing guidance so the card is never empty.
  const lead = flagged[0];
  if (lead) {
    const c = MARKER_COPY[lead.markerId];
    if (c && c.act) return sentence(cap(c.act));
  }
  return sentence(cap((areaMeta && areaMeta.focusDefault) || GENERIC.act));
}

/**
 * The single framing sentence under the Health Map.
 * Neutral by design: it counts, it never praises or alarms.
 */
function keyMessage(areas) {
  const assessed = areas.filter((a) => a.grade !== 'NOT_ASSESSED');
  if (!assessed.length) {
    return 'This screening did not include enough tests to grade any health area. The detailed results below show everything that was measured.';
  }
  const d = assessed.filter((a) => a.grade === 'D').length;
  const c = assessed.filter((a) => a.grade === 'C').length;
  const b = assessed.filter((a) => a.grade === 'B').length;
  const a = assessed.filter((a2) => a2.grade === 'A').length;
  const total = assessed.length;

  if (d > 0) {
    return `Of the ${total} health ${total === 1 ? 'area' : 'areas'} this screening could assess, ` +
      `${d} ${d === 1 ? 'needs' : 'need'} review with a healthcare professional. ` +
      'Your top priorities are listed below.';
  }
  if (c > 0) {
    return `Of the ${total} health ${total === 1 ? 'area' : 'areas'} this screening could assess, ` +
      `${c} ${c === 1 ? 'would benefit' : 'would benefit'} from focused attention, and ` +
      `${a + b} ${a + b === 1 ? 'is' : 'are'} on track. Your top priorities are listed below.`;
  }
  if (b > 0) {
    return `All ${total} assessed health ${total === 1 ? 'area sits' : 'areas sit'} at Monitor or better, ` +
      `with ${b} worth tracking on your next screening.`;
  }
  return `All ${total} assessed health ${total === 1 ? 'area shows' : 'areas show'} every measured marker ` +
    'within its preferred range.';
}

/**
 * The trend line on a health-area card.
 *
 * A grade can hold steady while the markers underneath it move a long way, so this
 * reports both: what the grade did, and what actually changed. Reporting only the
 * grade would tell a client whose LDL fell 24 mg/dL that nothing happened.
 */
function areaTrendLine(area) {
  if (!area || area.trend === 'NOT_COMPARABLE' || !area.previousGrade) return '';

  const mv = area.movement || { improved: 0, needsAttention: 0, resolved: 0, newFindings: 0 };
  const named = (list, trend, limit) => list
    .filter((m) => m.trend === trend)
    .slice(0, limit || 2)
    .map((m) => m.displayName)
    .join(' and ');
  const moved = area.movedMarkers || [];

  const headline = area.trend === 'IMPROVED'
    ? `This area moved from ${area.previousGrade} to ${area.grade} since your last screening`
    : area.trend === 'NEEDS_ATTENTION'
      ? `This area moved from ${area.previousGrade} to ${area.grade} since your last screening`
      : `This area is unchanged at ${area.grade} since your last screening`;

  const parts = [];
  if (mv.improved) {
    const who = named(moved, 'IMPROVED');
    parts.push(`${who || `${mv.improved} marker${mv.improved === 1 ? '' : 's'}`} improved`);
  }
  if (mv.resolved) {
    const who = named(moved, 'RESOLVED');
    parts.push(`${who || `${mv.resolved} marker${mv.resolved === 1 ? '' : 's'}`} returned to range`);
  }
  if (mv.needsAttention) {
    const who = named(moved, 'NEEDS_ATTENTION');
    parts.push(`${who || `${mv.needsAttention} marker${mv.needsAttention === 1 ? '' : 's'}`} moved the wrong way`);
  }
  if (mv.newFindings) {
    const who = named(moved, 'NEW_FINDING');
    parts.push(`${who || `${mv.newFindings} marker${mv.newFindings === 1 ? '' : 's'}`} is newly outside range`);
  }

  if (!parts.length) return sentence(headline) + ' No individual marker moved by a meaningful amount.';

  const list = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
  return sentence(headline) + ' ' + sentence(cap(list));
}

/** Why a priority matters, in one sentence. */
function priorityWhy(marker) {
  const c = MARKER_COPY[marker.markerId];
  if (!c) return isHigh(marker.status) ? GENERIC.high : GENERIC.low;
  return sentence(cap(isHigh(marker.status) ? c.high : c.low));
}

module.exports = {
  STATUS_LABEL,
  STATUS_MARK,
  TREND_LABEL,
  TREND_MARK,
  PROFESSIONAL_LINE,
  DISCLAIMER,
  MARKER_COPY,
  GENERIC,
  sentence,
  cap,
  markerInsight,
  markerNextStep,
  areaSummary,
  areaFocus,
  areaTrendLine,
  keyMessage,
  priorityWhy
};
