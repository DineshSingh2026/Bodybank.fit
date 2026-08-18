'use strict';

const fs = require('fs');
const path = require('path');

const {
  parseAnthropicJson,
  formatAnthropicApiError,
  computeNutritionSummaryForUserWindow
} = require('./nutritionService');
const { generateHealthReportPdfWithFallback } = require('./pdfService');

function parseDbJsonColumn(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) {
    try {
      return JSON.parse(v.toString('utf8'));
    } catch (_) {
      return null;
    }
  }
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function anthropicTextFromMessage(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  return blocks.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('');
}

function parseAnyJsonBlock(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  try {
    return JSON.parse(t);
  } catch (_) {}

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(t))) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    try {
      return JSON.parse(body);
    } catch (_) {}
  }

  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < t.length; j += 1) {
      const ch = t[j];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth === 0) {
        const candidate = t.slice(i, j + 1);
        try {
          return JSON.parse(candidate);
        } catch (_) {
          break;
        }
      }
    }
  }
  return null;
}

function unwrapExtractionRoot(extracted) {
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) return null;
  if (extracted.panels || extracted.Panels || extracted.markers) return extracted;
  const maybe =
    extracted.result ||
    extracted.results ||
    extracted.report ||
    extracted.data ||
    extracted.payload ||
    null;
  if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
    if (maybe.panels || maybe.Panels || maybe.markers) return maybe;
  }
  return extracted;
}

async function callAnthropicMessages({ apiKey, model, maxTokens, system, userContent }) {
  const timeoutMs = Math.max(30000, parseInt(process.env.ANTHROPIC_BLOOD_REQUEST_TIMEOUT_MS || '300000', 10) || 300000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Anthropic request timed out after ${timeoutMs}ms`)), timeoutMs);
  const messages = [{ role: 'user', content: userContent }];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages
    })
  }).finally(() => clearTimeout(timer));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = formatAnthropicApiError(res.status, data);
    throw new Error(msg);
  }
  return data;
}

/**
 * Runs a JSON-producing pass (extraction OR clinical analysis) robustly:
 * parses defensively (```json fences, prose preambles, trailing text), and if the
 * first attempt is truncated (stop_reason: max_tokens) or unparseable, retries once
 * with a much larger token budget so big reports never fail on truncation. Sums
 * token usage across attempts. `coerce(parsed)` returns the accepted result or null
 * (used to require valid panels for extraction / an object for analysis).
 * No assistant prefill — some models 400 on it; robust parsing covers the cases.
 */
async function runJsonPass({ apiKey, model, maxTokens, system, userContent, coerce, maxRetryTokens }) {
  let inputTokens = 0;
  let outputTokens = 0;
  let lastData = null;
  const bumped = Math.min(maxRetryTokens || 32000, Math.max(maxTokens + 4000, Math.floor(maxTokens * 1.8)));
  const attempts = maxTokens >= bumped ? [maxTokens] : [maxTokens, bumped];
  for (let i = 0; i < attempts.length; i += 1) {
    const data = await callAnthropicMessages({ apiKey, model, maxTokens: attempts[i], system, userContent });
    lastData = data;
    inputTokens += toNumber(data && data.usage && data.usage.input_tokens, 0);
    outputTokens += toNumber(data && data.usage && data.usage.output_tokens, 0);
    const text = anthropicTextFromMessage(data);
    const parsed = parseAnyJsonBlock(text) || parseAnthropicJson(text);
    const result = coerce ? coerce(parsed) : parsed;
    if (result) {
      return { result, usage: buildUsage(model, inputTokens, outputTokens), stopReason: data && data.stop_reason };
    }
    // Only worth retrying when we ran out of room; other stop reasons won't improve.
    if (data && data.stop_reason && data.stop_reason !== 'max_tokens') break;
  }
  return { result: null, usage: buildUsage(model, inputTokens, outputTokens), stopReason: (lastData && lastData.stop_reason) || 'unknown' };
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// Pricing is owned by services/aiUsageLedger.js so every feature's cost figure
// and the admin Tokens ledger can never disagree. Re-exported locally to keep
// the existing call sites in this file unchanged.
const { modelPricing, estimateAnthropicUsageCost, recordAiUsage } = require('./aiUsageLedger');


function buildUsage(model, inputTokens, outputTokens) {
  return {
    provider: 'anthropic',
    model: String(model || ''),
    input_tokens: toNumber(inputTokens, 0),
    output_tokens: toNumber(outputTokens, 0),
    total_tokens: toNumber(inputTokens, 0) + toNumber(outputTokens, 0),
    ...estimateAnthropicUsageCost(inputTokens, outputTokens, model)
  };
}

function usageFromAnthropicResponse(data, model) {
  return buildUsage(model, toNumber(data && data.usage && data.usage.input_tokens, 0), toNumber(data && data.usage && data.usage.output_tokens, 0));
}

function bloodMediaBlock(imageBase64, mimeType) {
  const mime = String(mimeType || 'image/jpeg').toLowerCase();
  const data = String(imageBase64 || '').replace(/\s/g, '');
  if (mime.includes('pdf')) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data }
    };
  }
  const mt = /^image\/(jpeg|png|gif|webp)$/i.test(mime) ? mime : 'image/jpeg';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mt, data }
  };
}

async function validateBloodReportInput({ apiKey, model, imageBase64, mimeType }) {
  const validationModel =
    (process.env.ANTHROPIC_MODEL_BLOOD_VALIDATOR || model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim();
  try {
    const resp = await callAnthropicMessages({
      apiKey,
      model: validationModel,
      maxTokens: 120,
      system: `You are a strict validator for uploaded blood lab reports.
Return ONLY valid JSON:
{
  "is_blood_report": true,
  "confidence": "high|medium|low",
  "reason": "short reason"
}
Set is_blood_report=false when the file is not a blood lab report (e.g. nutrition chart, xray, prescription, invoice, random image, selfie, other document type).`,
      userContent: [
        bloodMediaBlock(imageBase64, mimeType),
        {
          type: 'text',
          text: 'Decide if this is a blood test laboratory report that can be clinically analyzed into blood markers.'
        }
      ]
    });
    // Cheap, but not free — a rejected upload still costs a Haiku call, so it
    // belongs in the ledger like every other spend.
    recordAiUsage({
      scope: 'blood_validation',
      usage: usageFromAnthropicResponse(resp, validationModel)
    });
    const text = anthropicTextFromMessage(resp);
    const parsed = parseAnyJsonBlock(text) || parseAnthropicJson(text);
    const isBlood = !!(parsed && parsed.is_blood_report === true);
    const confidence = String((parsed && parsed.confidence) || 'low').toLowerCase();
    const reason = String((parsed && parsed.reason) || '').trim().slice(0, 220);
    return {
      isBloodReport: isBlood,
      confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
      reason: reason || (isBlood ? 'Appears to be a blood lab report.' : 'Not recognized as a blood lab report.')
    };
  } catch (_) {
    // Fail-open to avoid blocking valid users during temporary API/validator issues.
    return { isBloodReport: true, confidence: 'low', reason: 'Validation unavailable; allowed.' };
  }
}

/**
 * Try stored path as-is, then relative to process.cwd() (handles moved servers / ephemeral disks).
 */
function resolveStoredPdfPath(pdfPath) {
  if (pdfPath == null) return null;
  const s = String(pdfPath).trim();
  if (!s) return null;
  if (fs.existsSync(s)) return s;
  const normalized = s.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const fromCwd = path.resolve(process.cwd(), normalized);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return null;
}

/** Normalize extraction JSON so PDF regeneration tolerates minor model/schema drift. */
function coerceExtractedForPdf(extracted) {
  extracted = unwrapExtractionRoot(extracted);
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) return null;
  let panels = extracted.panels;
  if (!Array.isArray(panels) && Array.isArray(extracted.Panels)) {
    panels = extracted.Panels;
  }
  if (!Array.isArray(panels) && panels && typeof panels === 'object') {
    panels = [panels];
  }
  if (!Array.isArray(panels) || panels.length === 0) {
    if (Array.isArray(extracted.tests) && extracted.tests.length) {
      panels = [{ name: extracted.lab_name || 'Lab results', markers: extracted.tests }];
    } else if (Array.isArray(extracted.results) && extracted.results.length) {
      panels = [{ name: extracted.lab_name || 'Lab results', markers: extracted.results }];
    }
  }
  if (!Array.isArray(panels) || panels.length === 0) {
    if (Array.isArray(extracted.markers) && extracted.markers.length) {
      panels = [
        {
          name: extracted.lab_name || 'Lab results',
          markers: extracted.markers
        }
      ];
    } else {
      return null;
    }
  }
  return { ...extracted, panels };
}

/** Normalize analysis JSON for PDF (wrapped array or nested object). */
function coerceAiReportForPdf(aiReport) {
  if (aiReport == null) return null;
  let r = aiReport;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch (_) {
      return null;
    }
  }
  if (!r || typeof r !== 'object') return null;
  if (Array.isArray(r)) {
    if (r.length === 1 && r[0] && typeof r[0] === 'object' && !Array.isArray(r[0])) return r[0];
    return null;
  }
  if (r.report && typeof r.report === 'object' && !Array.isArray(r.report)) {
    const inner = r.report;
    if (
      inner.overall_status != null ||
      inner.overall_summary_short != null ||
      (Array.isArray(inner.key_findings) && inner.key_findings.length)
    ) {
      return inner;
    }
  }
  return r;
}

function normalizePanelsForPdf(extracted) {
  const panels = (extracted && extracted.panels) || [];
  return panels.map((panel) => ({
    name: String(panel.name || 'Panel'),
    markers: (panel.markers || []).map((m) => ({
      name: String(m.name || ''),
      value: String(m.value != null ? m.value : ''),
      unit: String(m.unit || ''),
      reference: String(m.reference_range != null ? m.reference_range : m.reference || '—'),
      status: String(m.status || 'Normal')
    }))
  }));
}

/**
 * @param {object} db { run, queryOne, queryAll }
 * @param {string} reportId
 * @param {string} imageBase64
 * @param {string} mimeType
 * @param {string} userId
 */
async function triggerBloodAnalysis(db, reportId, imageBase64, mimeType, userId) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // Extraction = mechanically reading values off every page → cheap Haiku, which
  // also ingests the large document input economically.
  const extractionModel =
    (process.env.ANTHROPIC_MODEL_BLOOD || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim();
  // Clinical analysis = the medical-officer evaluation → default to Opus 4.8 for the
  // deepest, most accurate reasoning (override with ANTHROPIC_MODEL_BLOOD_ANALYSIS,
  // e.g. claude-sonnet-5 or claude-haiku-4-5 for lower cost).
  const analysisModel = (process.env.ANTHROPIC_MODEL_BLOOD_ANALYSIS || 'claude-opus-4-8').trim();
  // Generous budgets so long, many-marker reports never truncate; runJsonPass
  // retries at a much larger budget if the first pass hits max_tokens.
  const extractionMaxTokens = Math.max(2000, parseInt(process.env.ANTHROPIC_BLOOD_EXTRACT_MAX_TOKENS || '12000', 10) || 12000);
  const analysisMaxTokens = Math.max(4000, parseInt(process.env.ANTHROPIC_BLOOD_ANALYSIS_MAX_TOKENS || '12000', 10) || 12000);

  const { run, queryOne, queryAll } = db;

  try {
    // Reuse a prior successful extraction (e.g. a retry after an analysis-only
    // failure) so we never re-burn the large extraction cost. Extraction is only
    // ever persisted once its panels are valid, so a saved value is safe to trust.
    const prior = await queryOne(
      `SELECT extracted_blood_data, extraction_ai_usage FROM blood_analysis_reports WHERE id = ?`,
      [reportId]
    );
    let extractedBloodData = coerceExtractedForPdf(parseDbJsonColumn(prior && prior.extracted_blood_data));
    let extractionUsage;

    if (extractedBloodData && Array.isArray(extractedBloodData.panels) && extractedBloodData.panels.length > 0) {
      extractionUsage =
        parseDbJsonColumn(prior && prior.extraction_ai_usage) || buildUsage(extractionModel, 0, 0);
      await run(`UPDATE blood_analysis_reports SET status = 'analysing' WHERE id = ?`, [reportId]);
    } else {
      await run(`UPDATE blood_analysis_reports SET status = 'extracting' WHERE id = ?`, [reportId]);

      const extractPass = await runJsonPass({
        apiKey,
        model: extractionModel,
        maxTokens: extractionMaxTokens,
        maxRetryTokens: 40000,
        system: `You are a meticulous medical laboratory data-extraction specialist. The uploaded report may be 1 to 100+ pages. Read EVERY page and extract EVERY test result — never skip a panel, section, or marker, even in long reports or where headers repeat across pages.

Return ONLY valid JSON, no markdown:
{
  "lab_name": "name if visible",
  "report_date": "collection/report date if visible",
  "patient_age": "age if visible",
  "patient_sex": "sex if visible",
  "panels": [
    {
      "name": "Panel name e.g. Complete Blood Count",
      "markers": [
        {
          "name": "Full marker name",
          "value": "value exactly as printed",
          "unit": "unit",
          "reference_range": "range as shown e.g. 13.5-17.5",
          "status": "Normal|Low|High|Critical|Deficient|Elevated|Borderline|Optimal",
          "flag": "H or L or empty string"
        }
      ]
    }
  ],
  "confidence": "high|medium|low"
}

Rules:
- Include ALL panels present: CBC + differential, metabolic / liver / kidney panels, lipid profile, glucose & HbA1c, thyroid, hormones, vitamins, minerals, iron studies, inflammatory markers, urinalysis, and anything else on the report.
- Decide "status" by comparing each value to its reference range. If a range isn't printed, use standard adult clinical ranges.
- Preserve exact values and units. NEVER invent markers that are not in the report.`,
        userContent: [
          bloodMediaBlock(imageBase64, mimeType),
          { type: 'text', text: 'Extract every blood test marker from every page of this lab report. Return complete JSON with all panels.' }
        ],
        coerce: (parsed) => {
          const e = coerceExtractedForPdf(parsed);
          return (e && Array.isArray(e.panels) && e.panels.length > 0) ? e : null;
        }
      });
      extractionUsage = extractPass.usage;
      recordAiUsage({
        scope: 'blood_extraction',
        usage: extractionUsage,
        userId,
        refType: 'blood_report',
        refId: reportId
      });
      await run(`UPDATE blood_analysis_reports SET extraction_ai_usage = ?::jsonb WHERE id = ?`, [
        JSON.stringify(extractionUsage),
        reportId
      ]).catch(() => {});

      extractedBloodData = extractPass.result;
      if (!extractedBloodData) {
        throw new Error(`Extraction did not return valid panels JSON (stop_reason: ${extractPass.stopReason || 'unknown'})`);
      }

      await run(
        `UPDATE blood_analysis_reports SET extracted_blood_data = ?::jsonb, status = 'analysing' WHERE id = ?`,
        [JSON.stringify(extractedBloodData), reportId]
      );
    }

    const today = new Date().toISOString().split('T')[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const nutritionSummary = await computeNutritionSummaryForUserWindow(db, userId, sevenDaysAgo, today);

    const weeklyStats = await queryAll(
      `SELECT energy_difference FROM nutrition_daily_stats
       WHERE user_id = ? AND stat_date >= ?::date AND stat_date <= ?::date`,
      [userId, sevenDaysAgo, today]
    );
    const avgEnergyDiff =
      weeklyStats && weeklyStats.length
        ? Math.round(
            weeklyStats.reduce((s, d) => s + (parseInt(d.energy_difference, 10) || 0), 0) / weeklyStats.length
          )
        : null;

    const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
    const user = await queryOne(
      `SELECT id, first_name, last_name, email FROM users WHERE id = ?`,
      [userId]
    );
    if (!user) throw new Error('User not found');

    let symptoms = report.symptoms;
    if (symptoms == null) symptoms = [];
    else if (typeof symptoms === 'string') {
      try {
        symptoms = JSON.parse(symptoms);
      } catch (_) {
        symptoms = [];
      }
    }
    if (!Array.isArray(symptoms)) symptoms = [];
    const symptomsText = symptoms.length ? symptoms.join(', ') : 'None reported';

    const userName =
      [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.email || 'Member';

    const { result: aiReport, usage: analysisUsage, stopReason: analysisStopReason } = await runJsonPass({
      apiKey,
      model: analysisModel,
      maxTokens: analysisMaxTokens,
      maxRetryTokens: 24000,
      coerce: (parsed) => (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null,
      system: `You are the Reviewing Medical Officer — a Senior Consultant Physician and Sports Nutritionist with 20 years' experience in metabolic health, micronutrient deficiencies, and performance nutrition. You have the patient's COMPLETE extracted blood panel plus their recent nutrition data. Evaluate it exactly as a doctor reviewing results WITH the patient: assess every value, identify what is abnormal and why, connect the findings into one clear clinical picture, and inform the patient plainly of their situation and what to do about it.

RULES:
1. Evaluate EVERY marker. Address EVERY out-of-range value — do not omit any abnormal finding. Emit a key finding for each clinically significant abnormality (there may be many on a large, multi-panel report).
2. For each abnormality explain, in plain and honest but reassuring language: what the marker is, what this value indicates, the likely cause, and its clinical significance for this patient.
3. Look for PATTERNS across markers (e.g. low Hb + low MCV + low ferritin = iron-deficiency anaemia) and state them explicitly.
4. Cross-reference blood markers with the nutrition data to pinpoint dietary causes and fixes.
5. Consider patient-reported symptoms in the context of the findings.
6. Food recommendations MUST include Indian cuisine options where relevant.
7. Supplement doses must be THERAPEUTIC (not maintenance) for the deficiency levels seen.
8. The weekly meal plan MUST hit the protein/calorie targets for the stated fitness goal.
9. Risk grades Low/Medium/High from clinical evidence; retest timelines evidence-based.
10. clinical_interpretation must be THOROUGH and scale with the report — for a comprehensive panel write 6+ paragraphs covering the overall picture, each key abnormality and what it means for this patient, the connections between findings, nutrition's role, consequences if untreated, and the expected outcome with intervention. Never gloss over abnormal values.

Return ONLY valid JSON:
{
  "overall_status": "Excellent|Good|Fair|Poor|Critical",
  "overall_summary_short": "2-3 sentence executive summary of the patient's situation",
  "clinical_interpretation": "Thorough clinical narrative (6+ paragraphs for a comprehensive panel) evaluating every significant finding, the connections between them, how nutrition explains them, consequences if untreated, and expected outcome with intervention",
  "key_findings": [
    { "severity": "critical|info|good", "icon": "! or ✓", "title": "Short title", "detail": "1-2 sentence clinical detail — include one finding per significant abnormality" }
  ],
  "risks": [
    { "area": "Condition", "level": "High|Medium|Low", "factors": "Specific markers and dietary factors" }
  ],
  "foods_include_intro": "2 sentence intro explaining why these foods were chosen",
  "foods_include": [ { "name": "Food name", "reason": "Specific nutrient and amount" } ],
  "foods_avoid_intro": "1-2 sentence intro",
  "foods_avoid": [ { "name": "Food", "reason": "Specific mechanism" } ],
  "meal_plan_intro": "Calorie and protein targets with reasoning",
  "weekly_meal_plan": [
    {
      "day": "Monday", "total_calories": 2200, "total_protein": 145,
      "meals": [ { "type": "Breakfast", "meal": "specific meal", "calories": 420 } ]
    }
  ],
  "supplement_intro": "1 sentence intro",
  "supplements": [ { "name": "Name", "dose": "Therapeutic dose", "timing": "When and with what", "reason": "Specific deficiency value" } ],
  "lifestyle": {
    "sleep": "specific advice linked to blood findings",
    "stress": "specific advice",
    "exercise": "specific advice considering blood markers",
    "hydration": "specific target",
    "recovery": "post-workout nutrition advice"
  },
  "progress_intro": "1-2 sentences on importance of retesting",
  "retest_schedule": [ { "test": "Test name", "when": "Timeframe", "reason": "Specific reason" } ]
}`,
      userContent: [
        {
          type: 'text',
          text: `PATIENT PROFILE:
Name: ${userName}
Age: ${report.user_age || 'Not provided'}
Gender: ${report.user_gender || 'Not provided'}
Fitness Goal: ${report.user_goal || 'General health'}
Reported Symptoms: ${symptomsText}

BLOOD TEST RESULTS (extracted):
${JSON.stringify(extractedBloodData, null, 2)}

NUTRITION TRACKING (last 7 days from BodyBank):
${JSON.stringify(nutritionSummary, null, 2)}

Average Energy Difference (burned - consumed): ${avgEnergyDiff !== null ? `${avgEnergyDiff} kcal/day` : 'No workout data'}

Provide complete clinical analysis as JSON.`
        }
      ]
    });
    if (!aiReport || typeof aiReport !== 'object') {
      // Persist the analysis-pass usage even on failure so the cost is auditable,
      // then fail with the stop reason (truncation shows as 'max_tokens').
      recordAiUsage({
        scope: 'blood_analysis',
        usage: analysisUsage,
        userId,
        refType: 'blood_report',
        refId: reportId
      });
      await run(`UPDATE blood_analysis_reports SET analysis_ai_usage = ?::jsonb WHERE id = ?`, [
        JSON.stringify(analysisUsage),
        reportId
      ]).catch(() => {});
      throw new Error(
        `Analysis pass did not return valid JSON (stop_reason: ${analysisStopReason || 'unknown'})`
      );
    }
    recordAiUsage({
      scope: 'blood_analysis',
      usage: analysisUsage,
      userId,
      refType: 'blood_report',
      refId: reportId
    });
    const totalUsage = {
      provider: 'anthropic',
      model: `${extractionModel} + ${analysisModel}`,
      input_tokens: toNumber(extractionUsage.input_tokens) + toNumber(analysisUsage.input_tokens),
      output_tokens: toNumber(extractionUsage.output_tokens) + toNumber(analysisUsage.output_tokens),
      total_tokens: toNumber(extractionUsage.total_tokens) + toNumber(analysisUsage.total_tokens),
      estimated_cost_usd:
        Number((toNumber(extractionUsage.estimated_cost_usd) + toNumber(analysisUsage.estimated_cost_usd)).toFixed(6)),
      estimated_cost_inr:
        Number((toNumber(extractionUsage.estimated_cost_inr) + toNumber(analysisUsage.estimated_cost_inr)).toFixed(4))
    };

    await run(
      `UPDATE blood_analysis_reports
       SET ai_report = ?::jsonb, nutrition_snapshot = ?::jsonb, analysis_ai_usage = ?::jsonb, total_ai_usage = ?::jsonb, status = 'generating_pdf'
       WHERE id = ?`,
      [JSON.stringify(aiReport), JSON.stringify(nutritionSummary || {}), JSON.stringify(analysisUsage), JSON.stringify(totalUsage), reportId]
    );

    const bloodForPdf = { panels: normalizePanelsForPdf(extractedBloodData) };
    const pdfPath = await generateHealthReportPdfWithFallback({
      reportId,
      user: {
        name: userName,
        age: report.user_age || '—',
        gender: report.user_gender || '—',
        goal: report.user_goal || '—'
      },
      blood_analysis: bloodForPdf,
      nutrition_analysis: nutritionSummary || {},
      ai_report: aiReport
    });

    await run(
      `UPDATE blood_analysis_reports SET pdf_path = ?, status = 'complete', analysis_last_error = NULL WHERE id = ?`,
      [pdfPath, reportId]
    );
    console.log(`[BodyBank] Blood analysis complete: user=${userId} report=${reportId}`);
    return pdfPath;
  } catch (err) {
    console.error('[BodyBank] Blood analysis failed:', err);
    const errMsg = String((err && err.message) || err || 'Unknown error').slice(0, 4000);
    await run(`UPDATE blood_analysis_reports SET status = 'failed', analysis_last_error = ? WHERE id = ?`, [
      errMsg,
      reportId
    ]).catch(() => {});
    throw err;
  }
}

/**
 * Returns an absolute path to the report PDF, generating it from DB fields if the file is missing
 * (e.g. PDF step failed earlier, file deleted, or server path changed).
 */
async function ensureHealthReportPdf(db, reportId) {
  const { run, queryOne } = db;
  try {
    const report = await queryOne(`SELECT * FROM blood_analysis_reports WHERE id = ?`, [reportId]);
    if (!report) return null;
    const existingPdf = report.pdf_path ? resolveStoredPdfPath(report.pdf_path) : null;
    if (existingPdf) {
      if (existingPdf !== String(report.pdf_path || '').trim()) {
        await run(`UPDATE blood_analysis_reports SET pdf_path = ? WHERE id = ?`, [existingPdf, reportId]).catch(() => {});
      }
      return existingPdf;
    }

    let extracted = coerceExtractedForPdf(parseDbJsonColumn(report.extracted_blood_data));
    let aiReport = coerceAiReportForPdf(parseDbJsonColumn(report.ai_report));
    let nutritionSnapshot = parseDbJsonColumn(report.nutrition_snapshot);
    if (nutritionSnapshot == null || typeof nutritionSnapshot !== 'object' || Array.isArray(nutritionSnapshot)) {
      nutritionSnapshot = {};
    }

    if (!extracted || !Array.isArray(extracted.panels) || !aiReport || typeof aiReport !== 'object' || Array.isArray(aiReport)) {
      return null;
    }

    const user = await queryOne(`SELECT id, first_name, last_name, email FROM users WHERE id = ?`, [report.user_id]);
    if (!user) return null;
    const userName =
      [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.email || 'Member';

    const bloodForPdf = { panels: normalizePanelsForPdf(extracted) };
    const pdfPath = await generateHealthReportPdfWithFallback({
      reportId,
      user: {
        name: userName,
        age: report.user_age || '—',
        gender: report.user_gender || '—',
        goal: report.user_goal || '—'
      },
      blood_analysis: bloodForPdf,
      nutrition_analysis: nutritionSnapshot || {},
      ai_report: aiReport
    });

    await run(
      `UPDATE blood_analysis_reports SET pdf_path = ?, status = 'complete', analysis_last_error = NULL WHERE id = ?`,
      [pdfPath, reportId]
    );
    return pdfPath;
  } catch (err) {
    console.error('[BodyBank] ensureHealthReportPdf failed:', err && err.message);
    return null;
  }
}

module.exports = {
  triggerBloodAnalysis,
  ensureHealthReportPdf,
  validateBloodReportInput,
  resolveStoredUploadPath: resolveStoredPdfPath
};
