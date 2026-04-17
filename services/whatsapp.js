'use strict';

// BodyBank — WhatsApp alert service via Twilio Sandbox
// All errors are swallowed; the app NEVER crashes due to this module.

const TWILIO_SID        = process.env.TWILIO_SID        || '';
const TWILIO_AUTH       = process.env.TWILIO_AUTH       || '';
const ADMIN_WHATSAPP    = process.env.ADMIN_WHATSAPP    || ''; // e.g. +91XXXXXXXXXX or whatsapp:+91XXXXXXXXXX
const SANDBOX_FROM      = 'whatsapp:+14155238886';             // Twilio sandbox number

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
      from : SANDBOX_FROM,
      to   : toWaAddr(ADMIN_WHATSAPP),
      body,
      ...(mediaUrl.length ? { mediaUrl } : {})
    });
    console.log('[whatsapp] sent OK → sid:', result.sid, '| to:', toWaAddr(ADMIN_WHATSAPP));
    return { ok: true, sid: result.sid };
  } catch (err) {
    console.error('[whatsapp] SEND FAILED →', err.message, { code: err.code, status: err.status, to: toWaAddr(ADMIN_WHATSAPP) });
    return { ok: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = { sendWhatsApp, isConfigured };
