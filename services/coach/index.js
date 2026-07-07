'use strict';

/**
 * BodyBank AI Coach — public entry point + orchestration.
 *
 *   const coach = require('./services/coach');
 *   await coach.initCoach({ queryAll, queryOne, run, uuidv4, sendPushToUser });
 *   coach.emitCoachEvent(userId, 'WORKOUT_COMPLETED', { ... });   // fire-and-forget
 *   coach.startCoachWorkers();                                     // cron + drain loop
 *
 * The intelligence is the Decision Engine (should I speak / when / how loud) + Memory
 * (dossier). The LLM only renders once the engine has decided to speak.
 */

const cron = require('node-cron');

const taxonomy = require('./taxonomy');
const eventEngine = require('./eventEngine');
const decisionEngine = require('./decisionEngine');
const contextBuilder = require('./contextBuilder');
const messageGenerator = require('./messageGenerator');
const deliveryRouter = require('./deliveryRouter');
const memory = require('./memoryService');
const dossierService = require('./dossierService');
const experiments = require('./experiments');
const llm = require('./llm');
const { BASE_VOICE } = require('./prompts/base');
const { getPersonality } = require('./prompts/personalities');
const { getTemplate } = require('./prompts/templates');
const { gatherFacts, buildStatsString } = require('./facts');
const { getDossier } = require('./dossierService');
const { tzNow, DEFAULT_TZ } = require('./util');

let ctx = null;              // dependency-injected DB + push handle
let _workersStarted = false;
let _killed = false;         // admin kill-switch: pauses proactive sends (replies still work)
const _intervals = [];

// ─── Schema ──────────────────────────────────────────────────────────────────
async function ensureSchema(run) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS coach_events (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       type TEXT NOT NULL,
       category TEXT NOT NULL,
       payload JSONB NOT NULL DEFAULT '{}',
       priority INTEGER NOT NULL DEFAULT 0,
       dedup_key TEXT,
       status TEXT NOT NULL DEFAULT 'pending',
       suppress_reason TEXT,
       retry_count INTEGER NOT NULL DEFAULT 0,
       scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_coach_events_due ON coach_events(status, scheduled_for)`,
    `CREATE INDEX IF NOT EXISTS idx_coach_events_user ON coach_events(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_coach_events_dedup ON coach_events(user_id, dedup_key, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS coach_settings (
       user_id TEXT PRIMARY KEY,
       coach_enabled BOOLEAN NOT NULL DEFAULT TRUE,
       personality TEXT NOT NULL DEFAULT 'friendly',
       daily_budget INTEGER NOT NULL DEFAULT 2,
       min_send_threshold INTEGER NOT NULL DEFAULT 35,
       quiet_start TEXT NOT NULL DEFAULT '21:30',
       quiet_end TEXT NOT NULL DEFAULT '07:30',
       timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
       whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
       muted_categories JSONB NOT NULL DEFAULT '[]',
       language TEXT NOT NULL DEFAULT 'en',
       paused_until TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`,

    `CREATE TABLE IF NOT EXISTS coach_dossier (
       user_id TEXT PRIMARY KEY,
       summary TEXT NOT NULL DEFAULT '',
       facts JSONB NOT NULL DEFAULT '{}',
       version INTEGER NOT NULL DEFAULT 1,
       refreshed_at TIMESTAMP
     )`,

    `CREATE TABLE IF NOT EXISTS coach_user_profile (
       user_id TEXT PRIMARY KEY,
       health_score INTEGER,
       score_breakdown JSONB,
       streak_days INTEGER DEFAULT 0,
       longest_streak INTEGER DEFAULT 0,
       typical_active_hour INTEGER,
       active_hours JSONB,
       weak_dimension TEXT,
       engagement TEXT DEFAULT 'medium',
       last_active_at TIMESTAMP,
       recomputed_at TIMESTAMP
     )`,

    `CREATE TABLE IF NOT EXISTS coach_messages (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       event_id TEXT,
       type TEXT NOT NULL,
       channel TEXT NOT NULL DEFAULT 'in_app',
       personality TEXT,
       prompt_version TEXT,
       model TEXT,
       body TEXT NOT NULL,
       ab_variant TEXT,
       tokens_in INTEGER DEFAULT 0,
       tokens_out INTEGER DEFAULT 0,
       cost_usd NUMERIC(10,5) DEFAULT 0,
       sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       opened_at TIMESTAMP,
       replied_at TIMESTAMP,
       action_after TEXT,
       reaction TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_coach_messages_user ON coach_messages(user_id, sent_at DESC)`,

    `CREATE TABLE IF NOT EXISTS coach_budget_ledger (
       user_id TEXT NOT NULL,
       ymd DATE NOT NULL,
       spent INTEGER NOT NULL DEFAULT 0,
       borrowed INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (user_id, ymd)
     )`,

    `CREATE TABLE IF NOT EXISTS coach_cost_ledger (
       ymd DATE PRIMARY KEY,
       tokens_in BIGINT DEFAULT 0,
       tokens_out BIGINT DEFAULT 0,
       cost_usd NUMERIC(12,4) DEFAULT 0,
       message_count INTEGER DEFAULT 0
     )`,

    `CREATE TABLE IF NOT EXISTS coach_experiments (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       target_type TEXT NOT NULL DEFAULT 'all',
       metric TEXT NOT NULL DEFAULT 'reply_rate',
       variants JSONB NOT NULL DEFAULT '[]',
       status TEXT NOT NULL DEFAULT 'active',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     )`
  ];
  for (const s of stmts) {
    try { await run(s); } catch (e) { console.warn('[coach] schema stmt failed:', e.message); }
  }
  // Idempotent column adds for forward-compat.
  try { await run(`ALTER TABLE coach_user_profile ADD COLUMN IF NOT EXISTS engagement TEXT DEFAULT 'medium'`); } catch (_) {}
  try { await run(`ALTER TABLE coach_settings ADD COLUMN IF NOT EXISTS paused_until TIMESTAMP`); } catch (_) {}
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function initCoach(deps) {
  await ensureSchema(deps.run);
  let coachSenderId = null;
  try {
    const admin = await deps.queryOne("SELECT id FROM users WHERE role IN ('admin','superadmin') ORDER BY created_at ASC LIMIT 1");
    coachSenderId = admin ? admin.id : null;
  } catch (_) {}
  ctx = {
    queryAll: deps.queryAll,
    queryOne: deps.queryOne,
    run: deps.run,
    uuidv4: deps.uuidv4,
    sendPushToUser: deps.sendPushToUser || (async () => {}),
    coachSenderId,
    tzYmd: () => tzNow(DEFAULT_TZ).ymd
  };
  console.log('[coach] initialised' + (llm.hasApiKey() ? '' : ' (no ANTHROPIC_API_KEY — messages will use safe templates)'));
  return ctx;
}

function ready() { return !!ctx; }
function getCtx() { return ctx; }

// ─── Public: emit ────────────────────────────────────────────────────────────
function emitCoachEvent(userId, type, payload) {
  if (!ctx) return;
  eventEngine.emit(ctx, userId, type, payload);
}

// ─── Eligibility ─────────────────────────────────────────────────────────────
async function isEligible(userId) {
  const u = await ctx.queryOne(
    'SELECT id, role, suspended, subscription_status, access_expires_at FROM users WHERE id = ?',
    [userId]
  ).catch(() => null);
  if (!u || u.role !== 'user') return false;
  if (u.suspended) return false;
  if (String(u.subscription_status || 'active').toLowerCase() === 'canceled') return false;
  if (u.access_expires_at) {
    const exp = new Date(u.access_expires_at).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) return false;
  }
  return true;
}

// ─── Core: process one event ─────────────────────────────────────────────────
async function processEvent(event) {
  const userId = event.user_id;
  try {
    if (!(await isEligible(userId))) {
      await eventEngine.setStatus(ctx, event.id, 'suppressed', { suppress_reason: 'ineligible' });
      return { status: 'suppressed', reason: 'ineligible' };
    }

    const settings = await memory.getSettings(ctx, userId);
    const profile = (await memory.getProfile(ctx, userId)) || {};
    const recentTypes = await memory.recentMessageTypes(ctx, userId, 48);

    const decision = await decisionEngine.decide(ctx, event, {
      settings, profile, recentTypes, now: Date.now(),
      llmTieBreak: llm.hasApiKey() ? tieBreak : null
    });

    if (decision.action === 'suppress') {
      await eventEngine.setStatus(ctx, event.id, 'suppressed', { suppress_reason: decision.reason });
      return { status: 'suppressed', reason: decision.reason, score: decision.score };
    }
    if (decision.action === 'batch') {
      await eventEngine.setStatus(ctx, event.id, 'batched', { suppress_reason: decision.reason });
      return { status: 'batched', reason: decision.reason, score: decision.score };
    }
    if (decision.action === 'defer') {
      await eventEngine.setStatus(ctx, event.id, 'scheduled', { scheduled_for: decision.at });
      return { status: 'deferred', reason: decision.reason, at: decision.at, score: decision.score };
    }

    // SEND
    await eventEngine.setStatus(ctx, event.id, 'generating');
    // A/B: pick a variant (deterministic per user) — may override personality / append.
    const variant = await experiments.assign(ctx, userId, event.type).catch(() => null);
    const plan = await contextBuilder.buildContext(ctx, userId, event, settings, profile, {
      personalityOverride: variant && variant.personality,
      variantAppend: variant && variant.append
    });
    plan.factsName = (plan.statsString || '').split('\n')[0] || '';
    const gen = await messageGenerator.generateMessage(ctx, plan, { tier: 'generate', maxTokens: 350 });
    if (!gen.ok || !gen.text) {
      await eventEngine.setStatus(ctx, event.id, 'suppressed', { suppress_reason: 'no_message' });
      return { status: 'suppressed', reason: 'no_message', score: decision.score };
    }

    const countsBudget = !taxonomy.BUDGET_EXEMPT.has(event.type) && !decision.bypassBudget;
    const promptVersion = plan.template ? `${plan.template.id}:${plan.template.version}` : null;
    await deliveryRouter.deliver(ctx, {
      userId,
      eventId: event.id,
      type: event.type,
      templateId: plan.template && plan.template.id,
      body: gen.text,
      personality: (variant && variant.personality) || settings.personality,
      promptVersion: variant ? `${promptVersion}|${variant.abVariant}` : promptVersion,
      abVariant: variant ? variant.abVariant : null,
      model: gen.model,
      usage: gen.usage,
      settings,
      countsBudget
    });
    await eventEngine.setStatus(ctx, event.id, 'sent');

    // Light coalescing: once we've spoken this window, fold other pending deferrable
    // events for this user into this one (suppress as 'coalesced') so we don't double-ping.
    await ctx.run(
      `UPDATE coach_events SET status = 'suppressed', suppress_reason = 'coalesced', updated_at = NOW()
       WHERE user_id = ? AND id <> ? AND status IN ('pending','batched','scheduled')
         AND category <> 'conversational'
         AND created_at >= NOW() - INTERVAL '4 hours'`,
      [userId, event.id]
    ).catch(() => {});

    return { status: 'sent', score: decision.score, source: gen.source, model: gen.model };
  } catch (e) {
    console.warn('[coach] processEvent error:', event.type, e.message);
    const attempts = (Number(event.retry_count) || 0) + 1;
    const nextStatus = attempts >= 3 ? 'dead_letter' : 'failed';
    await ctx.run(
      `UPDATE coach_events SET status = ?, retry_count = ?, scheduled_for = NOW() + INTERVAL '10 minutes', updated_at = NOW() WHERE id = ?`,
      [nextStatus, attempts, event.id]
    ).catch(() => {});
    return { status: nextStatus, error: e.message };
  }
}

/** Cheap Haiku tie-break for ambiguous mid-score events. Defaults to send on error. */
async function tieBreak(event, info) {
  const out = await llm.generate(ctx, {
    tier: 'decide',
    system: [{ text: 'You are a strict notification gatekeeper for a fitness coaching app. Reply with ONLY "SEND" or "SKIP". Prefer SKIP unless the message is clearly worth interrupting the user right now.', cache: true }],
    userText: `Event: ${event.type}. Value score: ${info.score}/100. Should the coach send a message about this now? Answer SEND or SKIP.`,
    maxTokens: 8
  });
  if (!out.ok) return { send: true };
  return { send: /send/i.test(out.text) };
}

// ─── Drain worker ────────────────────────────────────────────────────────────
async function drainOnce(limit = 25) {
  if (!ctx) return { processed: 0 };
  if (_killed) return { processed: 0, killed: true };
  const due = await eventEngine.claimDue(ctx, limit).catch(() => []);
  const results = [];
  for (const ev of due) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await processEvent(ev));
  }
  return { processed: due.length, results };
}

async function dlqRetry() {
  if (!ctx) return;
  await ctx.run(
    `UPDATE coach_events SET status = 'pending', updated_at = NOW()
     WHERE status = 'failed' AND retry_count < 3 AND scheduled_for <= NOW()`
  ).catch(() => {});
}

// ─── Synchronous user reply (conversational, bypasses budget) ────────────────
/**
 * Answer a user's chat message immediately. The caller (routes/coach.js) has already
 * stored the user's message as a thread_message (sender_role='user'); this generates and
 * delivers the coach's reply. Returns the reply text.
 */
async function handleUserReply(userId, text) {
  if (!ctx) return { ok: false, reason: 'not_ready' };
  emitCoachEvent(userId, 'USER_REPLIED', { text: String(text || '').slice(0, 500) });

  // Persist the incoming user message into the Lifestyle Manager thread first, so the
  // reply generation sees it as the latest turn (and it shows in the Coach tab).
  try {
    const threadId = await deliveryRouter.getOrCreateThread(ctx, userId);
    await ctx.run(
      'INSERT INTO thread_messages (id, thread_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?, ?)',
      [ctx.uuidv4(), threadId, userId, 'user', String(text || '').slice(0, 2000)]
    );
    await ctx.run('UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);
  } catch (_) { /* non-fatal */ }

  const settings = await memory.getSettings(ctx, userId);
  const profile = (await memory.getProfile(ctx, userId)) || {};
  const personality = getPersonality(settings.personality);
  const template = getTemplate('reply');

  const [facts, dossier, history] = await Promise.all([
    gatherFacts(ctx, userId, settings.timezone),
    getDossier(ctx, userId),
    conversationHistory(userId, 10)
  ]);
  const statsString = buildStatsString(facts);
  const dossierText = dossier && dossier.summary ? dossier.summary : `(${facts.name}: no dossier yet.)`;

  const prefix = `${BASE_VOICE}

ACTIVE PERSONALITY: ${personality.label}
${personality.voice}
Hard limit: at most ${(personality.maxWords || 90) + 30} words.`;

  const contextBlock = `DOSSIER:\n${dossierText}\n\nSTATS (real data — invent nothing):\n${statsString}\n\n${template.build({ event: { type: 'USER_REPLIED' }, stats: statsString, personality })}`;

  const messages = history.length ? history : [{ role: 'user', content: String(text || '') }];

  const plan = {
    system: [{ text: prefix, cache: true }, { text: contextBlock }],
    messages,
    maxWords: (personality.maxWords || 90) + 30,
    recentBodies: [],
    personality,
    factsName: facts.name
  };

  const gen = await messageGenerator.generateMessage(ctx, plan, {
    tier: 'generate', maxTokens: 400,
    fallbackText: `Thanks for the message${facts.name && facts.name !== 'there' ? ', ' + facts.name : ''}. I'll take a proper look at your numbers and get back to you.`
  });

  const del = await deliveryRouter.deliver(ctx, {
    userId, type: 'USER_REPLIED', templateId: 'reply',
    body: gen.text, personality: settings.personality,
    promptVersion: 'reply:1', model: gen.model, usage: gen.usage,
    settings, countsBudget: false
  });

  return { ok: true, reply: gen.text, messageId: del.messageId, source: gen.source };
}

/** Recent thread messages mapped to Anthropic roles, starting with a user turn. */
async function conversationHistory(userId, limit) {
  const rows = await ctx.queryAll(
    `SELECT tm.sender_role, tm.body
     FROM thread_messages tm JOIN message_threads mt ON tm.thread_id = mt.id
     WHERE mt.user_id = ? ORDER BY tm.created_at DESC LIMIT ?`,
    [userId, limit]
  ).catch(() => []);
  let msgs = (rows || []).reverse().map((r) => ({
    role: r.sender_role === 'user' ? 'user' : 'assistant',
    content: String(r.body || '').slice(0, 2000)
  }));
  // Anthropic requires the first message to be a user turn.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

// ─── Batch maintenance jobs ──────────────────────────────────────────────────
async function activeUserIds(days = 3, limit = 500) {
  const rows = await ctx.queryAll(
    `SELECT DISTINCT u.id
     FROM users u
     WHERE u.role = 'user' AND COALESCE(u.suspended, FALSE) = FALSE
       AND (
         EXISTS (SELECT 1 FROM daily_checkins d WHERE d.user_id = u.id AND d.checkin_date >= CURRENT_DATE - (? || ' days')::interval)
         OR EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.id AND w.created_at >= CURRENT_DATE - (? || ' days')::interval)
         OR EXISTS (SELECT 1 FROM nutrition_meal_logs m WHERE m.user_id = u.id AND m.log_date >= CURRENT_DATE - (? || ' days')::interval)
       )
     LIMIT ?`,
    [String(days), String(days), String(days), limit]
  ).catch(() => []);
  return (rows || []).map((r) => r.id);
}

async function recomputeProfiles() {
  if (!ctx) return { count: 0 };
  const ids = await activeUserIds(7, 1000);
  let n = 0;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await memory.recomputeProfile(ctx, id).then(() => n++).catch(() => {});
  }
  console.log(`[coach] recomputed ${n} profiles`);
  return { count: n };
}

async function refreshDossiers(limit) {
  if (!ctx) return { count: 0 };
  const cap = limit || Number(process.env.COACH_DOSSIER_BATCH || 50);
  const ids = (await activeUserIds(2, cap));
  let n = 0;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await dossierService.regenerate(ctx, id).then(() => n++).catch(() => {});
  }
  console.log(`[coach] refreshed ${n} dossiers`);
  return { count: n };
}

async function inactivitySweep() {
  if (!ctx) return { emitted: 0 };
  // Emit NO_ACTIVITY_{1,3,7}D based on last_active_at from the profile.
  const rows = await ctx.queryAll(
    `SELECT p.user_id, p.last_active_at
     FROM coach_user_profile p
     JOIN users u ON u.id = p.user_id
     WHERE u.role = 'user' AND COALESCE(u.suspended, FALSE) = FALSE AND p.last_active_at IS NOT NULL`
  ).catch(() => []);
  let emitted = 0;
  const now = Date.now();
  for (const r of rows) {
    const days = Math.floor((now - new Date(r.last_active_at).getTime()) / 86400000);
    let type = null;
    if (days === 7) type = 'NO_ACTIVITY_7D';
    else if (days === 3) type = 'NO_ACTIVITY_3D';
    else if (days === 1) type = 'NO_ACTIVITY_1D';
    if (type) { emitCoachEvent(r.user_id, type, { days, ymd: tzNow(DEFAULT_TZ).ymd }); emitted++; }
  }
  console.log(`[coach] inactivity sweep emitted ${emitted}`);
  return { emitted };
}

async function emitWeeklySummaries() {
  if (!ctx) return { emitted: 0 };
  const ids = await activeUserIds(7, 1000);
  ids.forEach((id) => emitCoachEvent(id, 'WEEKLY_SUMMARY', { ymd: tzNow(DEFAULT_TZ).ymd }));
  console.log(`[coach] emitted ${ids.length} weekly summaries`);
  return { emitted: ids.length };
}

// ─── Workers ─────────────────────────────────────────────────────────────────
function startCoachWorkers() {
  if (_workersStarted) return;
  if (!ctx) { console.warn('[coach] startCoachWorkers called before initCoach'); return; }
  if (String(process.env.COACH_WORKERS_ENABLED || '').toLowerCase() !== 'true') {
    console.log('[coach] workers ON HOLD (set COACH_WORKERS_ENABLED=true to start sending)');
    return;
  }
  _workersStarted = true;
  const tz = DEFAULT_TZ;

  // Drain queue every ~60s.
  const drainMs = Math.max(15000, Number(process.env.COACH_DRAIN_INTERVAL_MS || 60000));
  _intervals.push(setInterval(() => { drainOnce(25).catch(() => {}); }, drainMs));

  // DLQ retry every 10 min.
  cron.schedule('*/10 * * * *', () => { dlqRetry().catch(() => {}); }, { timezone: tz });

  // Nightly memory refresh (00:20) — profiles then dossiers.
  cron.schedule('20 0 * * *', async () => {
    await recomputeProfiles().catch(() => {});
    await refreshDossiers().catch(() => {});
  }, { timezone: tz });

  // Inactivity sweep (00:40).
  cron.schedule('40 0 * * *', () => { inactivitySweep().catch(() => {}); }, { timezone: tz });

  // Weekly summaries — Sunday 09:00 IST.
  cron.schedule('0 9 * * 0', () => { emitWeeklySummaries().catch(() => {}); }, { timezone: tz });

  // Optional daily rituals (behind a flag to avoid over-messaging).
  if (String(process.env.COACH_RITUALS_ENABLED || '').toLowerCase() === 'true') {
    cron.schedule('30 19 * * *', () => {
      activeUserIds(1, 1000).then((ids) => ids.forEach((id) => emitCoachEvent(id, 'EVENING_REFLECTION', { ymd: tzNow(tz).ymd }))).catch(() => {});
    }, { timezone: tz });
  }

  console.log(`[coach] workers started (drain every ${drainMs}ms, IST cron jobs armed)`);
}

function stopCoachWorkers() {
  _intervals.forEach((i) => clearInterval(i));
  _intervals.length = 0;
  _workersStarted = false;
}

function setKillSwitch(on) { _killed = !!on; return _killed; }
function isKilled() { return _killed; }

// ─── Thin API used by routes/coach.js (all operate through the injected ctx) ──
const api = {
  async getSettings(userId) { return memory.getSettings(ctx, userId); },
  async updateSettings(userId, patch) { return memory.updateSettings(ctx, userId, patch); },
  async getScore(userId) {
    let p = await memory.getProfile(ctx, userId);
    if (!p) p = await memory.recomputeProfile(ctx, userId).catch(() => null);
    if (!p) return { score: null, breakdown: {}, streak: 0, weak_dimension: null };
    return {
      score: p.health_score,
      breakdown: p.score_breakdown || {},
      streak: p.streak_days || 0,
      longest_streak: p.longest_streak || 0,
      weak_dimension: p.weak_dimension,
      recomputed_at: p.recomputed_at
    };
  },
  async pause(userId, days) {
    const d = Math.max(0, parseInt(days, 10) || 0);
    const until = d > 0 ? new Date(Date.now() + d * 86400000).toISOString() : null;
    await memory.getSettings(ctx, userId); // ensure the settings row exists first
    await ctx.run('UPDATE coach_settings SET paused_until = ?, updated_at = NOW() WHERE user_id = ?', [until, userId]);
    return { paused_until: until };
  },
  async listMessages(userId, limit = 30) {
    const rows = await ctx.queryAll(
      `SELECT id, type, personality, model, body, sent_at, opened_at, replied_at, reaction
       FROM coach_messages WHERE user_id = ? ORDER BY sent_at DESC LIMIT ?`,
      [userId, Math.min(100, Math.max(1, parseInt(limit, 10) || 30))]
    ).catch(() => []);
    return rows || [];
  },
  async feedback(userId, messageId, reaction) {
    const r = String(reaction || '').slice(0, 40);
    await ctx.run('UPDATE coach_messages SET reaction = ? WHERE id = ? AND user_id = ?', [r, messageId, userId]);
    return { ok: true };
  },
  async markOpened(userId) {
    await ctx.run(
      `UPDATE coach_messages SET opened_at = NOW()
       WHERE user_id = ? AND opened_at IS NULL AND channel = 'in_app'`,
      [userId]
    ).catch(() => {});
    return { ok: true };
  },
  async adminInspect(userId) {
    const [settings, profile, dossier, events, messages] = await Promise.all([
      memory.getSettings(ctx, userId),
      memory.getProfile(ctx, userId),
      dossierService.getDossier(ctx, userId),
      ctx.queryAll(`SELECT id, type, status, suppress_reason, priority, created_at, scheduled_for
                    FROM coach_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`, [userId]).catch(() => []),
      ctx.queryAll(`SELECT id, type, model, body, sent_at, reaction FROM coach_messages
                    WHERE user_id = ? ORDER BY sent_at DESC LIMIT 15`, [userId]).catch(() => [])
    ]);
    return { settings, profile, dossier, events, messages };
  },
  async adminMetrics() {
    const q = (sql, p) => ctx.queryOne(sql, p).catch(() => null);
    const [sends, suppress, opens, replies, cost] = await Promise.all([
      q(`SELECT COUNT(*)::int AS n FROM coach_messages WHERE sent_at >= CURRENT_DATE - INTERVAL '7 days'`),
      ctx.queryAll(`SELECT suppress_reason, COUNT(*)::int AS n FROM coach_events
                    WHERE status = 'suppressed' AND created_at >= CURRENT_DATE - INTERVAL '7 days'
                    GROUP BY suppress_reason ORDER BY n DESC`).catch(() => []),
      q(`SELECT COUNT(*)::int AS n FROM coach_messages WHERE opened_at IS NOT NULL AND sent_at >= CURRENT_DATE - INTERVAL '7 days'`),
      q(`SELECT COUNT(*)::int AS n FROM coach_messages WHERE replied_at IS NOT NULL AND sent_at >= CURRENT_DATE - INTERVAL '7 days'`),
      q(`SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(message_count),0) AS m FROM coach_cost_ledger WHERE ymd >= date_trunc('month', CURRENT_DATE)`)
    ]);
    return {
      window_days: 7,
      sends_7d: sends ? sends.n : 0,
      opens_7d: opens ? opens.n : 0,
      replies_7d: replies ? replies.n : 0,
      suppression_breakdown: suppress || [],
      month_cost_usd: cost ? Number(cost.c) : 0,
      month_llm_calls: cost ? Number(cost.m) : 0,
      killed: _killed,
      has_api_key: llm.hasApiKey()
    };
  },
  killSwitch(on) { return setKillSwitch(on); },
  async createExperiment(spec) { return experiments.create(ctx, spec || {}); },
  async listExperiments() {
    const [active, readout] = await Promise.all([
      experiments.listActive(ctx),
      experiments.readout(ctx)
    ]);
    return { active, readout };
  }
};

module.exports = {
  initCoach,
  ready,
  getCtx,
  ensureSchema,
  emitCoachEvent,
  handleUserReply,
  processEvent,
  drainOnce,
  dlqRetry,
  recomputeProfiles,
  refreshDossiers,
  inactivitySweep,
  emitWeeklySummaries,
  startCoachWorkers,
  stopCoachWorkers,
  setKillSwitch,
  isKilled,
  api,
  // re-exports for routes/tests
  memory,
  dossierService,
  experiments,
  llm,
  taxonomy,
  eventEngine,
  decisionEngine
};
