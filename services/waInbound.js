'use strict';

/**
 * Inbound WhatsApp mirroring (Phase 2 — draft / review).
 *
 * Receives Twilio WhatsApp POSTs, stores them, drafts as Kling via xAI, and
 * holds every client-facing send until a human approves. Does not replace
 * utils/notify.js staff alerts.
 */

const crypto = require('crypto');
const { localDateTimeToUtcIso, addDaysToDateString } = require('../utils/timezone');
const { buildSystemPrompt, buildUserPayload } = require('./waKlingPrompt');

const IST = 'Asia/Kolkata';
const QUIET_START_MIN = 21 * 60 + 30;
const QUIET_END_MIN = 8 * 60;
const APPROVE_TOKEN_RE = /^\s*(APPROVE|REJECT|YES|NO)\s+([A-Za-z0-9]{6,12})\s*$/i;
const AI_MENTION_RE = /\b(ai|artificial intelligence|chatbot|language model|\bllm\b|chatgpt|grok|as an? (ai|bot)|i('m| am) an? (ai|bot))\b/i;
const PROGRESS_CLAIM_RE = /(\d+(?:\.\d+)?)\s*(kg|kgs|lbs|lb|cm|mm|%|kcal|cal|g)\b/gi;

const HANDOFF_PATTERNS = [
  /\bblood\s*(report|test|work|panel|labs?)\b/i,
  /\b(lab|pathology)\s*report\b/i,
  /\binterpret\b/i,
  /\bpregnan/i,
  /\b(injury|injured|sprain|fracture|surgery)\b/i,
  /\b(illness|unwell|fever|hospital|chest pain|dizzy)\b/i,
  /\b(doctor|medicin|medication|prescrib|diagnos)\b/i,
  /\brefund\b/i,
  /\b(cancel\w*\s+(my\s+)?(membership|subscription|plan)|chargeback)\b/i,
  /\b(upset|angry|furious|disappointed|frustrated|scam|waste of (money|time))\b/i,
  /\b(change|edit|redo)\s+(my\s+)?(nutrition|diet|meal)\s+plan\b/i,
  /\bmacros?\b.*\b(change|increase|decrease|adjust)\b/i
];

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function isInboundEnabled(config) {
  if (config && Object.prototype.hasOwnProperty.call(config, 'inboundEnabled')) {
    return Boolean(config.inboundEnabled);
  }
  return envFlag('WA_INBOUND_ENABLED', false);
}

function isDraftMode(config) {
  if (config && Object.prototype.hasOwnProperty.call(config, 'draftMode')) {
    return Boolean(config.draftMode);
  }
  return envFlag('WA_DRAFT_MODE', true);
}

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function last10(phone) {
  const d = digitsOnly(phone);
  return d.length >= 10 ? d.slice(-10) : d;
}

function canonicalPhone(raw) {
  let d = digitsOnly(raw);
  if (d.length === 10) d = '91' + d;
  return d;
}

function phoneMatchKeys(phone) {
  const d = digitsOnly(phone);
  const keys = new Set();
  if (d) keys.add(d);
  if (d.length >= 10) keys.add(d.slice(-10));
  if (d.length === 10) keys.add('91' + d);
  if (d.startsWith('91') && d.length === 12) keys.add(d.slice(2));
  return [...keys].filter(Boolean);
}

function phonesOverlap(a, b) {
  const left = new Set(phoneMatchKeys(a));
  return phoneMatchKeys(b).some((k) => left.has(k));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getIstParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const result = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }
  let hour = Number(result.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour,
    minute: Number(result.minute)
  };
}

function isQuietHours(date, nowFn) {
  const d = date || (nowFn ? nowFn() : new Date());
  const p = getIstParts(d);
  const mins = p.hour * 60 + p.minute;
  return mins >= QUIET_START_MIN || mins < QUIET_END_MIN;
}

function nextAllowedSendAt(date, nowFn) {
  const d = date || (nowFn ? nowFn() : new Date());
  if (!isQuietHours(d, nowFn)) return d;
  const p = getIstParts(d);
  const mins = p.hour * 60 + p.minute;
  const ymd = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  const targetYmd = mins >= QUIET_START_MIN ? addDaysToDateString(ymd, 1) : ymd;
  return new Date(localDateTimeToUtcIso(targetYmd, '08:00', IST));
}

function detectInboundHandoff(text) {
  const raw = String(text || '');
  for (const re of HANDOFF_PATTERNS) {
    if (re.test(raw)) {
      return { handoff: true, reason: `inbound matched safety rule: ${re.source}` };
    }
  }
  return { handoff: false, reason: '' };
}

function hasInventedProgress(message, contextText) {
  const ctx = String(contextText || '');
  const re = new RegExp(PROGRESS_CLAIM_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(message || '')))) {
    const token = m[1];
    if (token && !ctx.includes(token)) return true;
  }
  return false;
}

function mentionsAi(message) {
  return AI_MENTION_RE.test(String(message || ''));
}

function tooManyIdeas(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  const questions = (text.match(/\?/g) || []).length;
  if (questions >= 3) return true;
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  return sentences.length > 4;
}

function firstIdea(message) {
  const text = String(message || '').trim();
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length <= 2) return text;
  return parts.slice(0, 2).join(' ').trim();
}

function parseAdminCommand(body) {
  const m = String(body || '').trim().match(APPROVE_TOKEN_RE);
  if (!m) return null;
  const action = /^(APPROVE|YES)$/i.test(m[1]) ? 'approve' : 'reject';
  return { action, token: String(m[2]).toLowerCase() };
}

function parseAgentJson(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  return {
    message: String(obj.message == null ? '' : obj.message).trim(),
    handoff: Boolean(obj.handoff),
    handoff_reason: String(obj.handoff_reason == null ? '' : obj.handoff_reason).trim(),
    send_at: obj.send_at == null || obj.send_at === '' ? null : obj.send_at,
    client_state_update: String(obj.client_state_update == null ? '' : obj.client_state_update).trim(),
    internal_note: String(obj.internal_note == null ? '' : obj.internal_note).trim()
  };
}

function applyGuards(draft, { inboundBody, contextText, consecutiveOutbound }) {
  const out = {
    message: String((draft && draft.message) || '').trim(),
    handoff: Boolean(draft && draft.handoff),
    handoff_reason: String((draft && draft.handoff_reason) || '').trim(),
    send_at: draft && draft.send_at != null ? draft.send_at : null,
    client_state_update: String((draft && draft.client_state_update) || '').trim(),
    internal_note: String((draft && draft.internal_note) || '').trim()
  };

  const inboundHit = detectInboundHandoff(inboundBody);
  if (inboundHit.handoff) {
    out.handoff = true;
    out.handoff_reason = out.handoff_reason || inboundHit.reason;
  }

  if (Number(consecutiveOutbound) >= 3) {
    out.handoff = true;
    out.handoff_reason = out.handoff_reason || '3 agent WhatsApp messages with no client reply';
  }

  if (mentionsAi(out.message)) {
    out.handoff = true;
    out.handoff_reason = out.handoff_reason || 'draft mentioned AI/bots';
    out.message = '';
  }

  if (!out.handoff && hasInventedProgress(out.message, contextText)) {
    out.handoff = true;
    out.handoff_reason = out.handoff_reason || 'draft invented a progress number that is not in context';
    out.message = '';
  }

  if (!out.handoff && tooManyIdeas(out.message)) {
    out.message = firstIdea(out.message);
    out.internal_note = [out.internal_note, 'trimmed to one idea'].filter(Boolean).join('; ');
  }

  if (out.handoff) {
    // Client must receive nothing on a handoff path.
    out.message = out.message || '';
  }

  return out;
}

function resolveSendAt(requested, nowFn) {
  const now = nowFn ? nowFn() : new Date();
  let candidate = now;
  if (requested) {
    const parsed = new Date(requested);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      candidate = parsed;
    }
  }
  return nextAllowedSendAt(candidate, nowFn);
}

function twilioSignature(authToken, url, params) {
  const data = Object.keys(params || {})
    .sort()
    .reduce((acc, key) => acc + key + String(params[key] == null ? '' : params[key]), String(url || ''));
  return crypto.createHmac('sha1', String(authToken || '')).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function webhookUrlFromReq(req, config) {
  if (config && config.webhookUrl) return String(config.webhookUrl).trim();
  const override = String(process.env.WA_INBOUND_WEBHOOK_URL || '').trim();
  if (override) return override;
  const base = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
  if (base) return `${base}/wa/inbound`;
  if (req) {
    const host = req.get && req.get('host');
    const proto = req.protocol || 'https';
    if (host) return `${proto}://${host}/wa/inbound`;
  }
  return '';
}

function verifyTwilioSignature(req, config) {
  const auth = (config && config.twilioAuth != null)
    ? String(config.twilioAuth)
    : String(process.env.TWILIO_AUTH || '');
  if (!auth) return false;
  const header = req && (req.get ? req.get('X-Twilio-Signature') : (req.headers && (req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature'])));
  const signature = String(header || '');
  if (!signature) return false;
  const url = webhookUrlFromReq(req, config);
  if (!url) return false;
  const params = (req && req.body && typeof req.body === 'object') ? req.body : {};
  try {
    const twilio = require('twilio');
    if (twilio && typeof twilio.validateRequest === 'function') {
      return Boolean(twilio.validateRequest(auth, signature, url, params));
    }
  } catch (_) { /* use local HMAC */ }
  return twilioSignature(auth, url, params) === signature;
}

function newApproveToken() {
  return crypto.randomBytes(4).toString('hex');
}

function emptyTwiML() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function clientLabel(user, phone) {
  if (!user) return phone || 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.email || phone;
}

function buildClientProfile(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ').trim(),
    email: user.email || '',
    phone: user.phone || '',
    country: user.country || '',
    city: user.city || '',
    goal_type: user.goal_type || '',
    diet_type: user.diet_type || '',
    injury_limitations: user.injury_limitations || '',
    subscription_status: user.subscription_status || '',
    plan_label: user.plan_label || '',
    access_expires_at: user.access_expires_at || null,
    height_cm: user.height_cm == null ? '' : user.height_cm,
    gender: user.gender || ''
  };
}

async function defaultCallAgent({ systemPrompt, userPayload, config }) {
  const key = (config && config.xaiApiKey != null)
    ? String(config.xaiApiKey)
    : String(process.env.XAI_API_KEY || '').trim();
  if (!key) {
    return {
      message: '',
      handoff: true,
      handoff_reason: 'XAI_API_KEY not set — Kling should reply manually',
      send_at: null,
      client_state_update: '',
      internal_note: 'agent skipped'
    };
  }
  const model = String((config && config.xaiModel) || process.env.XAI_MODEL || 'grok-3-mini').trim();
  const endpoint = String((config && config.xaiUrl) || process.env.XAI_API_URL || 'https://api.x.ai/v1/chat/completions').trim();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(userPayload) }
        ]
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        message: '',
        handoff: true,
        handoff_reason: `xAI error ${res.status} — review inbound manually`,
        send_at: null,
        client_state_update: '',
        internal_note: (json && json.error && json.error.message) || ''
      };
    }
    const text = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : '';
    const parsed = parseAgentJson(text);
    if (!parsed) {
      return {
        message: '',
        handoff: true,
        handoff_reason: 'agent returned non-JSON — review inbound manually',
        send_at: null,
        client_state_update: '',
        internal_note: String(text || '').slice(0, 400)
      };
    }
    return parsed;
  } catch (err) {
    return {
      message: '',
      handoff: true,
      handoff_reason: `agent call failed: ${err && err.message ? err.message : 'error'}`,
      send_at: null,
      client_state_update: '',
      internal_note: ''
    };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureWaTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_messages (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    phone TEXT NOT NULL,
    direction TEXT NOT NULL,
    body TEXT NOT NULL,
    twilio_sid TEXT DEFAULT '',
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    draft_id TEXT,
    unmatched BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_drafts (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    phone TEXT NOT NULL,
    inbound_message_id TEXT,
    trigger TEXT DEFAULT 'client_replied',
    draft_body TEXT NOT NULL DEFAULT '',
    handoff BOOLEAN DEFAULT FALSE,
    handoff_reason TEXT DEFAULT '',
    send_at TIMESTAMP,
    client_state_update TEXT DEFAULT '',
    internal_note TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    approve_token TEXT DEFAULT '',
    reviewed_by TEXT DEFAULT '',
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_trigger_runs (
    id TEXT PRIMARY KEY,
    trigger_name TEXT NOT NULL,
    client_id TEXT,
    ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    result TEXT DEFAULT ''
  )`);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_client ON wa_messages(client_id, ts DESC)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_twilio_sid ON wa_messages(twilio_sid) WHERE twilio_sid IS NOT NULL AND twilio_sid <> ''`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_drafts_status ON wa_drafts(status, send_at)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_drafts_token ON wa_drafts(approve_token)`); } catch (e) { /* ignore */ }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_trigger_runs_name ON wa_trigger_runs(trigger_name, ran_at DESC)`); } catch (e) { /* ignore */ }
}

function createPgStore({ queryAll, queryOne, run, uuidv4 }) {
  return {
    async findMessageByTwilioSid(sid) {
      if (!sid) return null;
      return queryOne('SELECT * FROM wa_messages WHERE twilio_sid = ? LIMIT 1', [sid]);
    },
    async insertMessage(row) {
      const id = row.id || uuidv4();
      await run(
        `INSERT INTO wa_messages (id, client_id, phone, direction, body, twilio_sid, ts, draft_id, unmatched)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE(?::timestamp, CURRENT_TIMESTAMP), ?, ?)`,
        [
          id,
          row.client_id || null,
          row.phone,
          row.direction,
          row.body,
          row.twilio_sid || '',
          row.ts || null,
          row.draft_id || null,
          row.unmatched ? true : false
        ]
      );
      return queryOne('SELECT * FROM wa_messages WHERE id = ?', [id]);
    },
    async listMessagesByPhone(phone, limit) {
      const key = last10(phone);
      return queryAll(
        `SELECT * FROM wa_messages
         WHERE RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ?
         ORDER BY ts ASC
         LIMIT ?`,
        [key, limit || 30]
      );
    },
    async findUsersByPhone(phone) {
      const key = last10(phone);
      if (!key) return [];
      return queryAll(
        `SELECT id, first_name, last_name, email, phone, country, city, goal_type, diet_type,
                injury_limitations, subscription_status, plan_label, access_expires_at,
                height_cm, gender, role
         FROM users
         WHERE RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = ?
         LIMIT 5`,
        [key]
      );
    },
    async insertDraft(row) {
      const id = row.id || uuidv4();
      await run(
        `INSERT INTO wa_drafts (
           id, client_id, phone, inbound_message_id, trigger, draft_body, handoff, handoff_reason,
           send_at, client_state_update, internal_note, status, approve_token
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          row.client_id || null,
          row.phone,
          row.inbound_message_id || null,
          row.trigger || 'client_replied',
          row.draft_body || '',
          row.handoff ? true : false,
          row.handoff_reason || '',
          row.send_at || null,
          row.client_state_update || '',
          row.internal_note || '',
          row.status || 'pending',
          row.approve_token || newApproveToken()
        ]
      );
      return queryOne('SELECT * FROM wa_drafts WHERE id = ?', [id]);
    },
    async getDraftById(id) {
      return queryOne('SELECT * FROM wa_drafts WHERE id = ?', [id]);
    },
    async getDraftByToken(token) {
      return queryOne('SELECT * FROM wa_drafts WHERE LOWER(approve_token) = LOWER(?) LIMIT 1', [token]);
    },
    async updateDraft(id, fields) {
      const allowed = [
        'draft_body', 'handoff', 'handoff_reason', 'send_at', 'client_state_update',
        'internal_note', 'status', 'reviewed_by', 'reviewed_at'
      ];
      const sets = [];
      const params = [];
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          sets.push(`${key} = ?`);
          params.push(fields[key]);
        }
      }
      if (!sets.length) return queryOne('SELECT * FROM wa_drafts WHERE id = ?', [id]);
      params.push(id);
      await run(`UPDATE wa_drafts SET ${sets.join(', ')} WHERE id = ?`, params);
      return queryOne('SELECT * FROM wa_drafts WHERE id = ?', [id]);
    },
    async listDrafts(status) {
      if (status) {
        return queryAll(
          `SELECT d.*, u.first_name, u.last_name, u.email
           FROM wa_drafts d
           LEFT JOIN users u ON u.id = d.client_id
           WHERE d.status = ?
           ORDER BY d.created_at DESC
           LIMIT 100`,
          [status]
        );
      }
      return queryAll(
        `SELECT d.*, u.first_name, u.last_name, u.email
         FROM wa_drafts d
         LEFT JOIN users u ON u.id = d.client_id
         ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, d.created_at DESC
         LIMIT 100`
      );
    },
    async listApprovedDue(now) {
      return queryAll(
        `SELECT * FROM wa_drafts
         WHERE status = 'approved'
           AND handoff = FALSE
           AND (send_at IS NULL OR send_at <= ?)
         ORDER BY send_at ASC NULLS FIRST
         LIMIT 20`,
        [now]
      );
    },
    async hasPendingDraft(clientId, trigger) {
      if (!clientId) return false;
      const row = await queryOne(
        `SELECT id FROM wa_drafts
         WHERE client_id = ? AND status IN ('pending','approved')
           AND (?::text IS NULL OR trigger = ?)
         LIMIT 1`,
        [clientId, trigger || null, trigger || null]
      );
      return Boolean(row);
    },
    async recentTriggerRun(trigger, clientId, since) {
      return queryOne(
        `SELECT * FROM wa_trigger_runs
         WHERE trigger_name = ?
           AND (client_id = ? OR (?::text IS NULL AND client_id IS NULL))
           AND ran_at >= ?
         ORDER BY ran_at DESC
         LIMIT 1`,
        [trigger, clientId || null, clientId || null, since]
      );
    },
    async insertTriggerRun(row) {
      const id = row.id || uuidv4();
      await run(
        'INSERT INTO wa_trigger_runs (id, trigger_name, client_id, ran_at, result) VALUES (?, ?, ?, COALESCE(?::timestamp, CURRENT_TIMESTAMP), ?)',
        [id, row.trigger_name, row.client_id || null, row.ran_at || null, row.result || '']
      );
      return { id };
    },
    async findNoActivityCandidates(limit) {
      try {
        return await queryAll(
          `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.country, u.city,
                  u.goal_type, u.diet_type, u.injury_limitations, u.subscription_status,
                  u.plan_label, u.access_expires_at, u.height_cm, u.gender
           FROM users u
           WHERE u.role = 'user'
             AND COALESCE(u.approval_status, 'approved') = 'approved'
             AND COALESCE(u.suspended, FALSE) = FALSE
             AND COALESCE(TRIM(u.phone), '') <> ''
             AND NOT EXISTS (
               SELECT 1 FROM daily_checkins d
               WHERE d.user_id = u.id AND d.checkin_date >= (CURRENT_DATE - INTERVAL '3 days')
             )
             AND NOT EXISTS (
               SELECT 1 FROM workout_logs w
               WHERE w.user_id = u.id AND w.created_at >= NOW() - INTERVAL '3 days'
             )
             AND NOT EXISTS (
               SELECT 1 FROM wa_messages m
               WHERE m.client_id = u.id AND m.ts >= NOW() - INTERVAL '3 days'
             )
             AND NOT EXISTS (
               SELECT 1 FROM wa_drafts d
               WHERE d.client_id = u.id AND d.status IN ('pending','approved')
             )
           ORDER BY u.created_at ASC
           LIMIT ?`,
          [limit || 3]
        );
      } catch (e) {
        console.warn('[wa-inbound] no_activity_3d candidate query failed:', e.message);
        return [];
      }
    },
    async listRecentActivity(clientId, limit) {
      if (!clientId) return [];
      const events = [];
      const pulls = [
        ['SELECT \'daily_checkin\' AS kind, (\'steps=\' || COALESCE(steps::text,\'—\')) AS detail, created_at AS ts FROM daily_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'],
        ['SELECT \'workout\' AS kind, COALESCE(workout_name,\'workout\') AS detail, created_at AS ts FROM workout_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'],
        ['SELECT \'nutrition\' AS kind, COALESCE(meal_type,\'meal\') AS detail, submitted_at AS ts FROM nutrition_meal_logs WHERE user_id = ? ORDER BY submitted_at DESC LIMIT ?'],
        ['SELECT \'sunday_checkin\' AS kind, \'submitted\' AS detail, created_at AS ts FROM sunday_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'],
        ['SELECT \'blood_report\' AS kind, \'uploaded\' AS detail, created_at AS ts FROM blood_analysis_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?']
      ];
      for (const [sql] of pulls) {
        try {
          const rows = await queryAll(sql, [clientId, limit || 10]);
          events.push(...(rows || []));
        } catch (_) { /* table may not exist yet */ }
      }
      events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return events.slice(0, limit || 10);
    },
    async unlinkClient(clientId) {
      if (!clientId) return;
      await run('UPDATE wa_messages SET client_id = NULL WHERE client_id = ?', [clientId]).catch(() => {});
      await run('UPDATE wa_drafts SET client_id = NULL WHERE client_id = ?', [clientId]).catch(() => {});
    }
  };
}

function createWaInbound(deps) {
  const store = deps.store;
  const uuidv4 = deps.uuidv4 || (() => crypto.randomUUID());
  const notify = deps.notify || (async () => ({ ok: false, reason: 'notify_not_injected' }));
  const sendWhatsApp = deps.sendWhatsApp || (async () => ({ ok: false, reason: 'send_not_injected' }));
  const callAgent = deps.callAgent || defaultCallAgent;
  const nowFn = deps.now || (() => new Date());
  const config = deps.config || {};

  function adminPhones() {
    if (Array.isArray(config.adminPhones) && config.adminPhones.length) return config.adminPhones;
    try {
      const wa = require('./whatsapp');
      if (typeof wa.getAdminRecipients === 'function') return wa.getAdminRecipients();
    } catch (_) { /* ignore */ }
    const list = String(process.env.ADMIN_WHATSAPP_LIST || '').trim();
    if (list) return list.split(',').map((s) => s.trim()).filter(Boolean);
    const one = String(process.env.ADMIN_WHATSAPP || '').trim();
    return one ? [one] : [];
  }

  function isAdminPhone(phone) {
    return adminPhones().some((a) => phonesOverlap(a, phone));
  }

  async function notifyStaff(eventType, payload) {
    try {
      return await notify(eventType, payload, { noDedup: true });
    } catch (err) {
      console.error('[wa-inbound] staff notify failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  async function sendToClient(phone, body, draftId, clientId) {
    const text = String(body || '').trim();
    if (!text) return { ok: false, reason: 'empty_message' };
    const result = await sendWhatsApp(text, { to: phone });
    if (result && result.ok) {
      await store.insertMessage({
        id: uuidv4(),
        client_id: clientId || null,
        phone: canonicalPhone(phone),
        direction: 'outbound',
        body: text,
        twilio_sid: result.sid || '',
        draft_id: draftId || null,
        unmatched: false
      });
    }
    return result;
  }

  async function flushDraftToClient(draft, reviewedBy) {
    if (!draft || draft.handoff) {
      return { ok: false, reason: 'handoff_no_client_send' };
    }
    if (draft.status === 'sent') return { ok: true, reason: 'already_sent' };
    if (draft.status === 'rejected') return { ok: false, reason: 'rejected' };

    const when = resolveSendAt(draft.send_at, nowFn);
    const now = nowFn();
    if (when.getTime() > now.getTime() + 1000) {
      await store.updateDraft(draft.id, {
        status: 'approved',
        send_at: when.toISOString(),
        reviewed_by: reviewedBy || draft.reviewed_by || '',
        reviewed_at: now.toISOString()
      });
      return { ok: true, scheduled: true, send_at: when.toISOString() };
    }

    const sent = await sendToClient(draft.phone, draft.draft_body, draft.id, draft.client_id);
    if (!sent || !sent.ok) {
      await store.updateDraft(draft.id, {
        status: 'approved',
        send_at: when.toISOString(),
        reviewed_by: reviewedBy || draft.reviewed_by || '',
        reviewed_at: now.toISOString()
      });
      return { ok: false, reason: (sent && sent.reason) || 'send_failed', send };
    }

    await store.updateDraft(draft.id, {
      status: 'sent',
      send_at: now.toISOString(),
      reviewed_by: reviewedBy || draft.reviewed_by || '',
      reviewed_at: now.toISOString()
    });
    await notifyStaff('WA_DRAFT_SENT', {
      name: clientLabel(null, draft.phone),
      phone: draft.phone,
      draft_id: draft.id
    });
    return { ok: true, sent: true, sid: sent.sid };
  }

  async function approveDraft(idOrToken, opts) {
    const optsSafe = opts || {};
    const draft = optsSafe.byToken
      ? await store.getDraftByToken(idOrToken)
      : await store.getDraftById(idOrToken);
    if (!draft) return { ok: false, reason: 'not_found' };
    if (draft.status === 'sent') return { ok: true, reason: 'already_sent' };
    if (draft.status === 'rejected') return { ok: false, reason: 'rejected' };
    if (draft.handoff) {
      return { ok: false, reason: 'handoff_no_client_send' };
    }
    const edited = optsSafe.body != null ? String(optsSafe.body).trim() : '';
    if (edited) {
      await store.updateDraft(draft.id, { draft_body: edited.slice(0, 2000) });
      draft.draft_body = edited.slice(0, 2000);
    }
    return flushDraftToClient(draft, optsSafe.reviewedBy || '');
  }

  async function rejectDraft(idOrToken, opts) {
    const optsSafe = opts || {};
    const draft = optsSafe.byToken
      ? await store.getDraftByToken(idOrToken)
      : await store.getDraftById(idOrToken);
    if (!draft) return { ok: false, reason: 'not_found' };
    if (draft.status === 'sent') return { ok: false, reason: 'already_sent' };
    await store.updateDraft(draft.id, {
      status: 'rejected',
      reviewed_by: optsSafe.reviewedBy || '',
      reviewed_at: nowFn().toISOString()
    });
    await notifyStaff('WA_DRAFT_REJECTED', {
      name: clientLabel(null, draft.phone),
      phone: draft.phone,
      draft_id: draft.id
    });
    return { ok: true, rejected: true };
  }

  async function handleAdminCommand(cmd, fromPhone) {
    if (cmd.action === 'approve') {
      return approveDraft(cmd.token, { byToken: true, reviewedBy: fromPhone });
    }
    return rejectDraft(cmd.token, { byToken: true, reviewedBy: fromPhone });
  }

  async function matchClient(phone) {
    const users = await store.findUsersByPhone(phone);
    const clients = (users || []).filter((u) => !u.role || u.role === 'user');
    if (clients.length === 1) return { user: clients[0], unmatched: false };
    return { user: null, unmatched: true, ambiguous: clients.length > 1 };
  }

  async function consecutiveOutboundCount(phone) {
    const rows = await store.listMessagesByPhone(phone, 30);
    let n = 0;
    for (let i = (rows || []).length - 1; i >= 0; i--) {
      if (rows[i].direction === 'outbound') n += 1;
      else if (rows[i].direction === 'inbound') break;
    }
    return n;
  }

  async function createAndNotifyDraft({
    user, phone, inboundId, trigger, inboundBody, forcedHandoff, forcedReason
  }) {
    const profile = buildClientProfile(user);
    const events = user ? await store.listRecentActivity(user.id, 10) : [];
    const history = await store.listMessagesByPhone(phone, 30);
    const consecutiveOutbound = await consecutiveOutboundCount(phone);
    const contextText = JSON.stringify({ profile, events, history, inboundBody });

    let agent = {
      message: '',
      handoff: Boolean(forcedHandoff),
      handoff_reason: forcedReason || '',
      send_at: null,
      client_state_update: '',
      internal_note: ''
    };

    if (!forcedHandoff) {
      const payload = buildUserPayload({
        trigger,
        profile,
        events,
        messages: (history || []).slice(-30).map((m) => ({
          direction: m.direction,
          body: m.body,
          ts: m.ts
        })),
        inboundBody
      });
      agent = await callAgent({
        systemPrompt: buildSystemPrompt(),
        userPayload: payload,
        config
      });
    }

    const guarded = applyGuards(agent, {
      inboundBody,
      contextText,
      consecutiveOutbound
    });
    const sendAt = resolveSendAt(guarded.send_at, nowFn);

    const draft = await store.insertDraft({
      id: uuidv4(),
      client_id: user ? user.id : null,
      phone: canonicalPhone(phone),
      inbound_message_id: inboundId || null,
      trigger: trigger || 'client_replied',
      draft_body: guarded.handoff ? '' : guarded.message,
      handoff: guarded.handoff,
      handoff_reason: guarded.handoff_reason,
      send_at: sendAt.toISOString(),
      client_state_update: guarded.client_state_update,
      internal_note: guarded.internal_note,
      status: 'pending',
      approve_token: newApproveToken()
    });

    // Draft / review kill switch: never send to the client from this path.
    if (!isDraftMode(config)) {
      console.warn('[wa-inbound] WA_DRAFT_MODE=false is not implemented; holding for approval');
    }

    const name = clientLabel(user, phone);
    if (guarded.handoff) {
      await notifyStaff('WA_INBOUND_HANDOFF', {
        name,
        phone,
        email: user && user.email,
        reason: guarded.handoff_reason,
        inbound: String(inboundBody || '').slice(0, 280),
        token: draft.approve_token,
        trigger: trigger || 'client_replied'
      });
    } else {
      await notifyStaff('WA_INBOUND_DRAFT', {
        name,
        phone,
        email: user && user.email,
        draft: guarded.message,
        token: draft.approve_token,
        send_at: sendAt.toISOString(),
        trigger: trigger || 'client_replied',
        inbound: String(inboundBody || '').slice(0, 180)
      });
    }

    return { draft, guarded, clientSent: false };
  }

  async function processInbound(body) {
    const from = String((body && (body.From || body.from)) || '').trim();
    const text = String((body && (body.Body || body.body)) || '').trim();
    const sid = String((body && (body.MessageSid || body.SmsSid || body.MessageSid)) || '').trim();
    const numMedia = parseInt(body && (body.NumMedia || body.numMedia), 10) || 0;
    let inboundText = text;
    if (numMedia > 0) {
      const urls = [];
      for (let i = 0; i < numMedia; i++) {
        const u = body[`MediaUrl${i}`] || body[`mediaUrl${i}`];
        if (u) urls.push(String(u));
      }
      if (urls.length) inboundText = [text, urls.map((u) => `[media: ${u}]`).join(' ')].filter(Boolean).join('\n');
    }

    const phone = canonicalPhone(from);
    if (!phone) return { ok: false, reason: 'missing_from' };

    if (isAdminPhone(from)) {
      const cmd = parseAdminCommand(text);
      if (cmd) {
        const result = await handleAdminCommand(cmd, from);
        return { ok: true, kind: 'admin_command', result };
      }
      return { ok: true, kind: 'admin_ignored' };
    }

    if (sid) {
      const dup = await store.findMessageByTwilioSid(sid);
      if (dup) return { ok: true, kind: 'duplicate', id: dup.id };
    }

    const match = await matchClient(from);
    const user = match.user;
    const unmatched = !user;

    const stored = await store.insertMessage({
      id: uuidv4(),
      client_id: user ? user.id : null,
      phone,
      direction: 'inbound',
      body: inboundText.slice(0, 8000),
      twilio_sid: sid,
      unmatched
    });

    if (unmatched) {
      await notifyStaff('WA_UNMATCHED', {
        name: 'Unmatched WhatsApp',
        phone,
        inbound: inboundText.slice(0, 280),
        reason: match.ambiguous ? 'multiple users share this number' : 'no user with this phone'
      });
      return {
        ok: true,
        kind: 'unmatched',
        message: stored,
        clientSent: false
      };
    }

    const inboundHit = detectInboundHandoff(inboundText);
    const created = await createAndNotifyDraft({
      user,
      phone,
      inboundId: stored.id,
      trigger: 'client_replied',
      inboundBody: inboundText,
      forcedHandoff: inboundHit.handoff,
      forcedReason: inboundHit.reason
    });

    return {
      ok: true,
      kind: created.guarded.handoff ? 'handoff' : 'draft',
      message: stored,
      draft: created.draft,
      clientSent: false
    };
  }

  async function handleWebhook(req, res) {
    if (!isInboundEnabled(config)) {
      return res.status(503).json({ ok: false, error: 'disabled' });
    }
    if (!verifyTwilioSignature(req, config)) {
      return res.status(403).send('Invalid signature');
    }
    try {
      await processInbound(req.body || {});
      return res.status(200).type('text/xml').send(emptyTwiML());
    } catch (err) {
      console.error('[wa-inbound] webhook error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'processing_failed' });
    }
  }

  async function runTrigger(triggerName, opts) {
    const optsSafe = opts || {};
    if (triggerName === 'no_activity_3d') {
      return runNoActivity3d(optsSafe);
    }
    console.log('[wa-inbound] trigger stub not implemented:', triggerName);
    return { ok: true, skipped: true, trigger: triggerName };
  }

  async function runNoActivity3d() {
    const since = new Date(nowFn().getTime() - 3 * 24 * 60 * 60 * 1000);
    const globalRun = await store.recentTriggerRun('no_activity_3d', null, since);
    if (globalRun) {
      return { ok: true, skipped: true, reason: 'ran_within_3d' };
    }

    const candidates = await store.findNoActivityCandidates(3);
    let drafted = 0;
    for (const user of candidates || []) {
      if (!user.phone) continue;
      if (await store.hasPendingDraft(user.id, 'no_activity_3d')) continue;
      const recent = await store.recentTriggerRun('no_activity_3d', user.id, since);
      if (recent) continue;
      await createAndNotifyDraft({
        user,
        phone: user.phone,
        inboundId: null,
        trigger: 'no_activity_3d',
        inboundBody: '',
        forcedHandoff: false,
        forcedReason: ''
      });
      await store.insertTriggerRun({
        id: uuidv4(),
        trigger_name: 'no_activity_3d',
        client_id: user.id,
        result: 'drafted'
      });
      drafted += 1;
    }
    await store.insertTriggerRun({
      id: uuidv4(),
      trigger_name: 'no_activity_3d',
      client_id: null,
      result: `drafted:${drafted}`
    });
    return { ok: true, drafted };
  }

  async function runSchedulerTick() {
    if (!isInboundEnabled(config)) return { ok: true, disabled: true };
    const now = nowFn();
    const due = await store.listApprovedDue(now.toISOString());
    const flushed = [];
    for (const draft of due || []) {
      flushed.push(await flushDraftToClient(draft, 'scheduler'));
    }

    const ist = getIstParts(now);
    let trigger = null;
    if (ist.hour === 10 && ist.minute < 15) {
      trigger = await runTrigger('no_activity_3d');
    }
    return { ok: true, flushed: flushed.length, trigger };
  }

  return {
    handleWebhook,
    processInbound,
    approveDraft,
    rejectDraft,
    listDrafts: (status) => store.listDrafts(status),
    runSchedulerTick,
    runTrigger,
    runNoActivity3d,
    unlinkClient: (id) => store.unlinkClient(id)
  };
}

module.exports = {
  createWaInbound,
  createPgStore,
  ensureWaTables,
  isInboundEnabled,
  isDraftMode,
  digitsOnly,
  last10,
  canonicalPhone,
  phoneMatchKeys,
  phonesOverlap,
  isQuietHours,
  nextAllowedSendAt,
  detectInboundHandoff,
  applyGuards,
  parseAdminCommand,
  parseAgentJson,
  verifyTwilioSignature,
  twilioSignature,
  webhookUrlFromReq,
  resolveSendAt,
  buildClientProfile,
  HANDOFF_PATTERNS
};
