'use strict';

/**
 * Reads a smart scale / decades-scan report (InBody, Withings, Renpho, FITTR-branded
 * scale, etc.) and extracts every metric it prints into a generic {sections:[...]}
 * shape — deliberately NOT a fixed column list, because every brand names and groups
 * these rows differently (see routes/smartScale.js upload). Mirrors the extraction
 * half of services/bloodAnalysisService.js (same Anthropic call shape, same
 * defensive JSON parsing), minus the clinical-analysis and PDF-generation steps
 * smart scale data doesn't need.
 */

const { parseAnthropicJson, formatAnthropicApiError } = require('./nutritionService');
const { recordAiUsage, buildUsage } = require('./aiUsageLedger');

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
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth === 0) {
        const candidate = t.slice(i, j + 1);
        try { return JSON.parse(candidate); } catch (_) { break; }
      }
    }
  }
  return null;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function mediaBlock(base64, mimeType) {
  const mime = String(mimeType || 'image/jpeg').toLowerCase();
  const data = String(base64 || '').replace(/\s/g, '');
  if (mime.includes('pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const mt = /^image\/(jpeg|png|gif|webp)$/i.test(mime) ? mime : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mt, data } };
}

async function callAnthropicMessages({ apiKey, model, maxTokens, system, userContent }) {
  const timeoutMs = Math.max(30000, parseInt(process.env.ANTHROPIC_BLOOD_REQUEST_TIMEOUT_MS || '180000', 10) || 180000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Anthropic request timed out after ${timeoutMs}ms`)), timeoutMs);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] })
  }).finally(() => clearTimeout(timer));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(formatAnthropicApiError(res.status, data));
  return data;
}

const EXTRACTION_SYSTEM = `You read smart weighing scale / body composition reports (InBody, Withings, Renpho,
decades scan, or similar bioimpedance devices). These reports list dozens of metrics
grouped into sections (e.g. "Overall Body Composition", "Fat Distribution", "Muscle Mass",
"Body Water", "Vital Signs"), each row usually having a name, a numeric value, a unit,
and sometimes a status word (e.g. "Overweight", "Normal", "High", "Low").

Extract EVERY metric row you can find into this exact JSON shape and return ONLY the JSON:
{
  "isScaleReport": true,
  "reportDate": "YYYY-MM-DD or null if not printed on the report",
  "deviceBrand": "brand/app name shown on the report, or null",
  "sections": [
    {
      "title": "section heading as printed (or your best grouping if untitled)",
      "metrics": [
        { "name": "metric name as printed", "value": "value as printed (string)", "unit": "unit or empty string", "status": "status word or empty string" }
      ]
    }
  ]
}

Do not invent metrics that are not on the report. Do not compute or normalise values —
copy them as printed. If the file is not a smart scale / body composition report at all
(e.g. it's a blood test, a random photo, a prescription), return exactly:
{ "isScaleReport": false, "reportDate": null, "deviceBrand": null, "sections": [] }`;

function coerceExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const cleanSections = sections
    .map((s) => ({
      title: String((s && s.title) || '').slice(0, 120) || 'Metrics',
      metrics: Array.isArray(s && s.metrics)
        ? s.metrics
            .map((m) => ({
              name: String((m && m.name) || '').slice(0, 120),
              value: String((m && m.value) == null ? '' : m.value).slice(0, 60),
              unit: String((m && m.unit) || '').slice(0, 24),
              status: String((m && m.status) || '').slice(0, 40)
            }))
            .filter((m) => m.name && m.value)
        : []
    }))
    .filter((s) => s.metrics.length);
  if (parsed.isScaleReport === false) {
    return { isScaleReport: false, reportDate: null, deviceBrand: null, sections: [] };
  }
  if (!cleanSections.length) return null;
  return {
    isScaleReport: true,
    reportDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.reportDate || '')) ? parsed.reportDate : null,
    deviceBrand: parsed.deviceBrand ? String(parsed.deviceBrand).slice(0, 80) : null,
    sections: cleanSections
  };
}

/**
 * Runs the extraction pass, retrying once with more tokens on truncation — same
 * shape as bloodAnalysisService's runJsonPass, kept local since this is the only
 * caller.
 */
async function runExtraction({ apiKey, model, base64, mimeType }) {
  const system = EXTRACTION_SYSTEM;
  const userContent = [
    mediaBlock(base64, mimeType),
    { type: 'text', text: 'Extract every metric row from this smart scale report as instructed.' }
  ];
  const attempts = [4000, 8000];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastStopReason = 'unknown';
  for (let i = 0; i < attempts.length; i += 1) {
    const data = await callAnthropicMessages({ apiKey, model, maxTokens: attempts[i], system, userContent });
    inputTokens += toNumber(data && data.usage && data.usage.input_tokens);
    outputTokens += toNumber(data && data.usage && data.usage.output_tokens);
    lastStopReason = (data && data.stop_reason) || 'unknown';
    const text = anthropicTextFromMessage(data);
    const parsed = parseAnyJsonBlock(text) || parseAnthropicJson(text);
    const coerced = coerceExtraction(parsed);
    if (coerced) return { extracted: coerced, usage: buildUsage(model, inputTokens, outputTokens), stopReason: lastStopReason };
    if (lastStopReason !== 'max_tokens') break;
  }
  return { extracted: null, usage: buildUsage(model, inputTokens, outputTokens), stopReason: lastStopReason };
}

/**
 * Extracts one upload's metrics and writes the result back onto its row.
 * Fire-and-forget from the upload route — a failed/slow extraction never blocks
 * the upload response, it just leaves extraction_status='failed' for a retry.
 */
async function triggerSmartScaleExtraction(db, uploadId, base64, mimeType, userId) {
  const { run } = db;
  try {
    await run(`UPDATE smart_scale_uploads SET extraction_status = 'extracting' WHERE id = ?`, [uploadId]);
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) {
      await run(
        `UPDATE smart_scale_uploads SET extraction_status = 'failed', extraction_error = ? WHERE id = ?`,
        ['ANTHROPIC_API_KEY is not set on the server.', uploadId]
      );
      return;
    }
    const model = (process.env.ANTHROPIC_MODEL_SMART_SCALE || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5').trim();
    const { extracted, usage, stopReason } = await runExtraction({ apiKey, model, base64, mimeType });
    recordAiUsage({ scope: 'smart_scale_extraction', usage, userId, refType: 'smart_scale_upload', refId: uploadId });

    if (!extracted) {
      await run(
        `UPDATE smart_scale_uploads SET extraction_status = 'failed', extraction_error = ?, extraction_ai_usage = ?::jsonb WHERE id = ?`,
        [`Could not read structured metrics from this file (stop reason: ${stopReason}).`, JSON.stringify(usage), uploadId]
      );
      return;
    }
    if (!extracted.isScaleReport) {
      await run(
        `UPDATE smart_scale_uploads SET extraction_status = 'failed', extraction_error = ?, extraction_ai_usage = ?::jsonb WHERE id = ?`,
        ['This file does not look like a smart scale / body composition report.', JSON.stringify(usage), uploadId]
      );
      return;
    }
    await run(
      `UPDATE smart_scale_uploads
       SET extraction_status = 'complete', extracted_data = ?::jsonb, extraction_error = NULL,
           extraction_ai_usage = ?::jsonb, device_brand = ?, report_date = ?::date
       WHERE id = ?`,
      [JSON.stringify(extracted), JSON.stringify(usage), extracted.deviceBrand || null, extracted.reportDate || null, uploadId]
    );
  } catch (err) {
    console.error('[smart-scale extraction]', err && err.message);
    try {
      await run(
        `UPDATE smart_scale_uploads SET extraction_status = 'failed', extraction_error = ? WHERE id = ?`,
        [String((err && err.message) || 'Extraction failed').slice(0, 500), uploadId]
      );
    } catch (_) {}
  }
}

module.exports = { triggerSmartScaleExtraction };
