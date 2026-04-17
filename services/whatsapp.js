'use strict';

// BodyBank — WhatsApp alert service via Twilio Sandbox
// All errors are swallowed; the app NEVER crashes due to this module.

const TWILIO_SID        = process.env.TWILIO_SID        || '';
const TWILIO_AUTH       = process.env.TWILIO_AUTH       || '';
const ADMIN_WHATSAPP    = process.env.ADMIN_WHATSAPP    || ''; // e.g. +91XXXXXXXXXX or whatsapp:+91XXXXXXXXXX
const WHATSAPP_FROM     = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const GENERIC_TEMPLATE_SID = process.env.TWILIO_WHATSAPP_TEMPLATE_SID || '';

let _client = null;

function isConfigured() {
  return Boolean(TWILIO_SID && TWILIO_AUTH && ADMIN_WHATSAPP);
}

function toWaAddr(raw) {
  const v = String(raw || '').trim();
  return v.startsWith('whatsapp:') ? v : `whatsapp:${v}`;
}

function getClient() {
  if (!_client) {
    const twilio = require('twilio');
    _client = twilio(TWILIO_SID, TWILIO_AUTH);
  }
  return _client;
}

function cleanTemplateVars(vars = {}) {
  const out = {};
  Object.keys(vars || {}).forEach((key) => {
    const raw = vars[key];
    out[String(key)] = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim();
  });
  return out;
}

function flattenTemplateText(message) {
  return String(message == null ? '' : message)
    .replace(/\s*\n+\s*/g, ' | ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * sendWhatsApp(message, opts?)
 * opts.mediaUrl: string | string[]
 * Fire-and-forget safe. Returns { ok, sid? } or { ok:false, reason }.
 */
async function sendWhatsApp(message, opts = {}) {
  const body = String(message || '').trim();
  if (!body) return { ok: false, reason: 'empty_message' };

  if (!isConfigured()) {
    const missing = ['TWILIO_SID', 'TWILIO_AUTH', 'ADMIN_WHATSAPP'].filter(k => !process.env[k]);
    console.warn('[whatsapp] SKIPPED — missing env vars:', missing.join(', '));
    return { ok: false, reason: 'not_configured', missing };
  }

  try {
    const mediaRaw = opts && opts.mediaUrl != null ? opts.mediaUrl : null;
    const mediaList = Array.isArray(mediaRaw) ? mediaRaw : (mediaRaw ? [mediaRaw] : []);
    const mediaUrl = mediaList
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 10);

    const result = await getClient().messages.create({
      from : WHATSAPP_FROM,
      to   : toWaAddr(ADMIN_WHATSAPP),
      body,
      ...(mediaUrl.length ? { mediaUrl } : {})
    });
    console.log('[whatsapp] sent OK → sid:', result.sid, '| to:', toWaAddr(ADMIN_WHATSAPP));
    return { ok: true, sid: result.sid };
  } catch (err) {
    console.error('[whatsapp] SEND FAILED →', err.message, { code: err.code, status: err.status, to: toWaAddr(ADMIN_WHATSAPP) });
    return { ok: false, reason: 'send_failed', error: err.message, code: err.code, status: err.status };
  }
}

async function sendWhatsAppTemplate(templateSid, variables = {}, opts = {}) {
  const sid = String(templateSid || '').trim();
  if (!sid) return { ok: false, reason: 'missing_template_sid' };

  if (!isConfigured()) {
    const missing = ['TWILIO_SID', 'TWILIO_AUTH', 'ADMIN_WHATSAPP'].filter(k => !process.env[k]);
    console.warn('[whatsapp] TEMPLATE SKIPPED — missing env vars:', missing.join(', '));
    return { ok: false, reason: 'not_configured', missing };
  }

  try {
    const result = await getClient().messages.create({
      from: WHATSAPP_FROM,
      to: toWaAddr(opts.to || ADMIN_WHATSAPP),
      contentSid: sid,
      contentVariables: JSON.stringify(cleanTemplateVars(variables))
    });
    console.log('[whatsapp] template sent OK → sid:', result.sid, '| template:', sid, '| to:', toWaAddr(opts.to || ADMIN_WHATSAPP));
    return { ok: true, sid: result.sid };
  } catch (err) {
    console.error('[whatsapp] TEMPLATE SEND FAILED →', err.message, { code: err.code, status: err.status, templateSid: sid, to: toWaAddr(opts.to || ADMIN_WHATSAPP) });
    return { ok: false, reason: 'template_send_failed', error: err.message, code: err.code, status: err.status };
  }
}

async function sendWhatsAppWithFallback(message, opts = {}) {
  const templateSid = String(opts.templateSid || GENERIC_TEMPLATE_SID || '').trim();
  const shouldPreferTemplate = Boolean(opts.forceTemplate || (opts.preferTemplate && templateSid));

  if (shouldPreferTemplate) {
    const templateResult = await sendWhatsAppTemplate(templateSid, { 1: flattenTemplateText(message) }, opts);
    if (templateResult.ok || opts.forceTemplate) return templateResult;

    console.warn('[whatsapp] template-first send failed, trying plain text fallback');
    const plainFallback = await sendWhatsApp(message, opts);
    if (plainFallback.ok) return plainFallback;
    return Number(plainFallback.code) === 63016 ? templateResult : plainFallback;
  }

  const firstAttempt = await sendWhatsApp(message, opts);
  if (firstAttempt.ok) return firstAttempt;

  const shouldRetryAsTemplate = Number(firstAttempt.code) === 63016;
  if (!shouldRetryAsTemplate) return firstAttempt;
  if (!templateSid) {
    return {
      ok: false,
      reason: 'missing_template_sid',
      error: firstAttempt.error || 'Template SID required for WhatsApp outside window',
      code: firstAttempt.code,
      status: firstAttempt.status
    };
  }

  console.warn('[whatsapp] retrying with template sender');
  return sendWhatsAppTemplate(templateSid, { 1: flattenTemplateText(message) }, opts);
}

module.exports = { sendWhatsApp, sendWhatsAppTemplate, sendWhatsAppWithFallback, isConfigured };
