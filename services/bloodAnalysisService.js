'use strict';

const fs = require('fs');

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

async function callAnthropicMessages({ apiKey, model, maxTokens, system, userContent }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = formatAnthropicApiError(res.status, data);
    throw new Error(msg);
  }
  return data;
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

  const model =
    (process.env.ANTHROPIC_MODEL_BLOOD || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514').trim();

  const { run, queryOne, queryAll } = db;

  try {
    await run(`UPDATE blood_analysis_reports SET status = 'extracting' WHERE id = ?`, [reportId]);

    const extractRes = await callAnthropicMessages({
      apiKey,
      model,
      maxTokens: 4000,
      system: `You are a medical data extraction specialist. Extract ALL blood test markers from the lab report.

Return ONLY valid JSON, no markdown:
{
  "lab_name": "name if visible",
  "report_date": "date if visible",
  "panels": [
    {
      "name": "Panel name e.g. Complete Blood Count",
      "markers": [
        {
          "name": "Full marker name",
          "value": "numeric value as string",
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
Extract EVERY visible marker. Use standard clinical ranges if reference range is not printed.`,
      userContent: [
        bloodMediaBlock(imageBase64, mimeType),
        { type: 'text', text: 'Extract all blood test markers from this lab report. Return complete JSON.' }
      ]
    });

    const extractText = anthropicTextFromMessage(extractRes);
    const extractedBloodData = parseAnthropicJson(extractText);
    if (!extractedBloodData || !Array.isArray(extractedBloodData.panels)) {
      throw new Error('Extraction did not return valid panels JSON');
    }

    await run(
      `UPDATE blood_analysis_reports SET extracted_blood_data = ?::jsonb, status = 'analysing' WHERE id = ?`,
      [JSON.stringify(extractedBloodData), reportId]
    );

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

    const analysisRes = await callAnthropicMessages({
      apiKey,
      model,
      maxTokens: 8000,
      system: `You are a Senior Consultant Physician and Sports Nutritionist with 20 years of clinical experience specialising in metabolic health, micronutrient deficiencies, and performance nutrition.

Analyse the blood report data and nutrition tracking data. Produce a comprehensive, clinically accurate report.

RULES:
1. Treat every out-of-range marker as clinically significant
2. Look for PATTERNS across markers (e.g. low Hb + low MCV + low ferritin = iron deficiency anaemia — state this explicitly)
3. Cross-reference blood markers with nutrition data to identify dietary causes
4. Consider patient-reported symptoms in context of blood findings
5. Food recommendations MUST include Indian cuisine options where relevant
6. Supplement doses must be THERAPEUTIC (not maintenance) given deficiency levels
7. Meal plan MUST achieve the protein/calorie targets for the stated fitness goal
8. Risk grades: Low / Medium / High based on clinical evidence
9. Retest timelines must be evidence-based

Return ONLY valid JSON:
{
  "overall_status": "Excellent|Good|Fair|Poor|Critical",
  "overall_summary_short": "2-3 sentence executive summary",
  "clinical_interpretation": "4-6 paragraph detailed clinical narrative covering: primary findings, connection to symptoms, how nutrition explains findings, consequences if untreated, expected outcome with intervention",
  "key_findings": [
    { "severity": "critical|info|good", "icon": "! or ✓", "title": "Short title", "detail": "1-2 sentence clinical detail" }
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

    const analysisText = anthropicTextFromMessage(analysisRes);
    const aiReport = parseAnthropicJson(analysisText);
    if (!aiReport || typeof aiReport !== 'object') {
      throw new Error('Analysis pass did not return valid JSON');
    }

    await run(
      `UPDATE blood_analysis_reports SET ai_report = ?::jsonb, nutrition_snapshot = ?::jsonb, status = 'generating_pdf' WHERE id = ?`,
      [JSON.stringify(aiReport), JSON.stringify(nutritionSummary || {}), reportId]
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

    await run(`UPDATE blood_analysis_reports SET pdf_path = ?, status = 'complete' WHERE id = ?`, [
      pdfPath,
      reportId
    ]);
    console.log(`[BodyBank] Blood analysis complete: user=${userId} report=${reportId}`);
    return pdfPath;
  } catch (err) {
    console.error('[BodyBank] Blood analysis failed:', err);
    await run(`UPDATE blood_analysis_reports SET status = 'failed' WHERE id = ?`, [reportId]).catch(() => {});
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
    if (report.pdf_path && fs.existsSync(report.pdf_path)) {
      return report.pdf_path;
    }

    let extracted = parseDbJsonColumn(report.extracted_blood_data);
    let aiReport = parseDbJsonColumn(report.ai_report);
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

    await run(`UPDATE blood_analysis_reports SET pdf_path = ?, status = 'complete' WHERE id = ?`, [pdfPath, reportId]);
    return pdfPath;
  } catch (err) {
    console.error('[BodyBank] ensureHealthReportPdf failed:', err && err.message);
    return null;
  }
}

module.exports = { triggerBloodAnalysis, ensureHealthReportPdf };
