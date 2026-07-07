'use strict';

/**
 * Delivery Router — sends a generated message and records full provenance.
 *
 * Primary channel = the existing in-app "Lifestyle Manager" thread (thread_messages,
 * sender_role='admin' so it renders exactly like a human coach note) + the inbox bell +
 * Web/FCM push. This reuses the surface the app already renders, so the AI coach becomes
 * the automated voice of the Lifestyle Manager with NO new chat UI.
 *
 * WhatsApp is intentionally NOT the primary AI channel (24h-window + sandbox constraints);
 * when whatsapp_opt_in is set and a sender is configured it is best-effort only.
 */

const { tzNow } = require('./util');
const { sendWhatsAppWithFallback } = require('../whatsapp');

const PUSH_TITLES = {
  weeklySummary: '🎯 Your weekly recap',
  comeback: '💬 Your Lifestyle Manager',
  reply: '💬 Your Lifestyle Manager replied',
  default: '💬 Your Lifestyle Manager'
};

async function getOrCreateThread(ctx, userId) {
  const existing = await ctx.queryOne(
    'SELECT id FROM message_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [userId]
  );
  if (existing) return existing.id;
  const id = ctx.uuidv4();
  await ctx.run('INSERT INTO message_threads (id, user_id, subject) VALUES (?, ?, ?)', [id, userId, '']);
  return id;
}

async function spendBudget(ctx, userId, tz) {
  const ymd = tzNow(tz).ymd;
  await ctx.run(
    `INSERT INTO coach_budget_ledger (user_id, ymd, spent) VALUES (?, ?::date, 1)
     ON CONFLICT (user_id, ymd) DO UPDATE SET spent = coach_budget_ledger.spent + 1`,
    [userId, ymd]
  );
}

/**
 * @param {object} ctx  { run, queryOne, uuidv4, sendPushToUser }
 * @param {object} m    { userId, eventId, type, body, personality, promptVersion, model,
 *                        usage, templateId, settings, countsBudget, abVariant }
 * @returns {Promise<{ ok, messageId, threadId }>}
 */
async function deliver(ctx, m) {
  const userId = m.userId;
  const body = String(m.body || '').trim().slice(0, 5000);
  if (!userId || !body) return { ok: false, reason: 'empty' };

  const threadId = await getOrCreateThread(ctx, userId);
  const msgId = ctx.uuidv4();
  const coachSenderId = ctx.coachSenderId || userId; // audit sender; renders as "admin"/Lifestyle Manager

  await ctx.run(
    'INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
    [msgId, threadId, coachSenderId, 'admin', body]
  );
  await ctx.run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);

  // Bell inbox entry (best-effort — mirrors campaignScheduler).
  try {
    await ctx.run(
      'INSERT INTO user_inbox (id, user_id, title, body, type, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [ctx.uuidv4(), userId, 'BodyBank', body, 'coach']
    );
  } catch (_) { /* inbox is non-critical */ }

  // Push (best-effort).
  try {
    const title = PUSH_TITLES[m.templateId] || PUSH_TITLES[m.type] || PUSH_TITLES.default;
    await ctx.sendPushToUser(userId, JSON.stringify({
      type: 'coach_reply', title, body: body.slice(0, 140), id: 'chat-' + msgId
    }));
  } catch (_) { /* users without a push subscription */ }

  // WhatsApp (opt-in, best-effort). Freeform reaches the client only within the 24h
  // window; outside it, Twilio returns 63016 and we fall back to the approved coach
  // template (TWILIO_COACH_TEMPLATE_SID) carrying the message as variable {{1}}.
  if (m.whatsappTo) {
    try {
      const tplSid = process.env.TWILIO_COACH_TEMPLATE_SID || '';
      await sendWhatsAppWithFallback(body, {
        to: m.whatsappTo,
        templateSid: tplSid,
        preferTemplate: !!tplSid // template-first when configured → works out-of-window
      });
    } catch (_) { /* WhatsApp is best-effort; in-app + push already delivered */ }
  }

  // Provenance row.
  const usage = m.usage || {};
  await ctx.run(
    `INSERT INTO coach_messages
       (id, user_id, event_id, type, channel, personality, prompt_version, model, body,
        ab_variant, tokens_in, tokens_out, cost_usd, sent_at)
     VALUES (?, ?, ?, ?, 'in_app', ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      msgId, userId, m.eventId || null, m.type, m.personality || null,
      m.promptVersion || null, m.model || null, body, m.abVariant || null,
      Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0,
      Number(usage.cost_usd) || 0
    ]
  );

  if (m.countsBudget) {
    const tz = (m.settings && m.settings.timezone) || 'Asia/Kolkata';
    await spendBudget(ctx, userId, tz).catch(() => {});
  }

  return { ok: true, messageId: msgId, threadId };
}

module.exports = { deliver, getOrCreateThread, spendBudget };
