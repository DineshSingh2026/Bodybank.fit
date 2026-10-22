'use strict';

/**
 * Audit lead email sequence: tables, queueing, the send job and unsubscribe.
 * Templates and pure rules are in services/auditLeadEmails.js.
 *
 * Flow
 *   admin "Send welcome email" → queue(ids) creates one sequence per email with
 *   next_send_at = now (pushed to 09:00 IST in quiet hours). The cron job (every
 *   5 min, Asia/Kolkata) claims due sequences and sends, throttled by batch size,
 *   a gap between emails and a daily cap. Nothing is sent by the admin request.
 *
 * Guarantees
 *   - one sequence per email (email_norm UNIQUE), whatever the case or duplicates;
 *   - one log row per email and step (UNIQUE), inserted as 'sending' BEFORE the SMTP
 *     call, so no step is ever sent twice, even across instances or after a crash;
 *   - stop rules are re-checked right before every send;
 *   - a failed send is retried once (2 attempts in total), then the sequence fails;
 *   - due rows are claimed with FOR UPDATE SKIP LOCKED plus a 15 minute lease, and an
 *     in-process flag stops overlapping runs, so two instances never pick the same row.
 *
 * Timestamps are TIMESTAMPTZ: the server runs in UTC on Render but in IST locally, and
 * the quiet hours and daily cap are IST wall clock, so the instant must be unambiguous.
 */

const crypto = require('crypto');
const L = require('./auditLeadEmails');

const LEASE_MS = 15 * 60000;
const RETRY_DELAY_MS = 30 * 60000;
const STUCK_SENDING_MS = 15 * 60000;
const MAX_ATTEMPTS = 2;
const MAX_QUEUE_IDS = 200;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS audit_lead_email_sequences (
    id TEXT PRIMARY KEY,
    email_norm TEXT NOT NULL UNIQUE,
    audit_request_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    next_step INTEGER NOT NULL DEFAULT 1,
    next_send_at TIMESTAMPTZ,
    first_sent_at TIMESTAMPTZ,
    started_by TEXT DEFAULT '',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    stopped_reason TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_lead_seq_due ON audit_lead_email_sequences(status, next_send_at)`,
  `CREATE TABLE IF NOT EXISTS audit_lead_email_log (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL,
    audit_request_id TEXT NOT NULL,
    email_norm TEXT NOT NULL,
    step INTEGER NOT NULL,
    cc TEXT DEFAULT '',
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    message_id TEXT DEFAULT '',
    error TEXT DEFAULT '',
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (email_norm, step)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_lead_log_seq ON audit_lead_email_log(sequence_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_lead_log_sent ON audit_lead_email_log(status, sent_at)`,
  `CREATE TABLE IF NOT EXISTS email_unsubscribes (
    email_norm TEXT PRIMARY KEY,
    source TEXT DEFAULT 'audit_lead',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`
];

async function ensureAuditLeadEmailSchema(pool) {
  for (const sql of SCHEMA_SQL) await pool.query(sql);
}

const STOP_LABELS = {
  stopped_replied: 'Lead replied or was contacted',
  stopped_signed_up: 'Lead signed up',
  stopped_unsubscribed: 'Lead unsubscribed',
  stopped_manual: 'Stopped by admin',
  failed: 'Invalid email address'
};

/**
 * deps: { queryAll, queryOne, run, sendMail({to,cc,replyTo,subject,html,text,headers}) → {ok,messageId,error},
 *         isConfigured(), env?, now?(), sleep?(ms), log? }
 */
function createAuditLeadEmailSequence(deps) {
  const { queryAll, queryOne, run } = deps;
  const sendMail = deps.sendMail;
  const isConfigured = deps.isConfigured || (() => true);
  const now = deps.now || (() => new Date());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || console;
  const cfg = () => L.configFromEnv(deps.env || process.env);
  let running = false;

  // ── facts about one email, used by queue() and right before each send ─────
  async function factsFor(emails) {
    const list = Array.from(new Set(emails.filter(Boolean)));
    const out = new Map(list.map((e) => [e, { email: e, unsubscribed: false, hasUser: false, linkedUser: false, stages: [], lastContactAt: null, sequence: null }]));
    if (!list.length) return out;
    const [unsubs, users, audits, seqs] = await Promise.all([
      queryAll('SELECT email_norm FROM email_unsubscribes WHERE email_norm = ANY(?)', [list]),
      queryAll('SELECT LOWER(TRIM(email)) AS e FROM users WHERE LOWER(TRIM(email)) = ANY(?)', [list]),
      queryAll(
        `SELECT LOWER(TRIM(email)) AS e, COALESCE(NULLIF(TRIM(stage), ''), 'new_audit') AS stage,
                COALESCE(linked_user_id, '') AS linked_user_id, last_contact_at
           FROM audit_requests WHERE LOWER(TRIM(email)) = ANY(?)`, [list]),
      queryAll('SELECT * FROM audit_lead_email_sequences WHERE email_norm = ANY(?)', [list])
    ]);
    unsubs.forEach((r) => { if (out.has(r.email_norm)) out.get(r.email_norm).unsubscribed = true; });
    users.forEach((r) => { if (out.has(r.e)) out.get(r.e).hasUser = true; });
    audits.forEach((r) => {
      const f = out.get(r.e);
      if (!f) return;
      f.stages.push(r.stage);
      if (String(r.linked_user_id || '').trim()) f.linkedUser = true;
      if (r.last_contact_at && (!f.lastContactAt || new Date(r.last_contact_at) > new Date(f.lastContactAt))) f.lastContactAt = r.last_contact_at;
    });
    seqs.forEach((r) => { if (out.has(r.email_norm)) out.get(r.email_norm).sequence = r; });
    return out;
  }

  /** Name and goal for rendering: the sequence's own row first, any filled-in goal as a fallback. */
  async function leadFor(emailNorm, auditId) {
    const rows = await queryAll(
      `SELECT id, first_name, last_name, email, goals FROM audit_requests
        WHERE LOWER(TRIM(email)) = ? ORDER BY (id = ?) DESC, created_at DESC LIMIT 20`,
      [emailNorm, auditId || '']
    );
    if (!rows.length) return null;
    const lead = Object.assign({}, rows[0]);
    if (!String(lead.goals || '').trim()) {
      const withGoal = rows.find((r) => String(r.goals || '').trim());
      if (withGoal) lead.goals = withGoal.goals;
    }
    return lead;
  }

  function renderFor(step, lead, emailNorm) {
    const c = cfg();
    return L.render(step, lead, {
      unsubscribeUrl: c.unsubSecret ? L.unsubUrl(emailNorm, c) : c.publicUrl + '/api/email/unsubscribe',
      whatsappNumber: c.whatsappNumber
    });
  }

  // ── admin: queue Email 1 ──────────────────────────────────────────────────
  async function queue({ ids, dryRun, startedBy, immediate } = {}) {
    const wanted = Array.from(new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean)));
    if (wanted.length > MAX_QUEUE_IDS) throw Object.assign(new Error(`Select at most ${MAX_QUEUE_IDS} leads at a time`), { status: 400 });
    const rows = wanted.length
      ? await queryAll('SELECT id, first_name, last_name, email, goals FROM audit_requests WHERE id = ANY(?)', [wanted])
      : [];
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const facts = await factsFor(rows.map((r) => L.normEmail(r.email)).filter(L.isValidEmail));

    const skipped = [];
    const accepted = [];
    const seen = new Set();
    for (const id of wanted) {
      const r = byId.get(id);
      if (!r) { skipped.push({ id, email: '', reason: 'Lead not found' }); continue; }
      const email = L.normEmail(r.email);
      const skip = (reason) => skipped.push({ id, email: r.email || '', reason });
      if (!L.isValidEmail(email)) { skip('Invalid email'); continue; }
      if (seen.has(email)) { skip('Same email as another selected lead'); continue; }
      seen.add(email);
      const f = facts.get(email);
      if (f.sequence) { skip('Already in sequence'); continue; }
      if (f.unsubscribed) { skip('Unsubscribed'); continue; }
      if (f.hasUser || f.linkedUser) { skip('Already signed up'); continue; }
      if (f.stages.some((s) => s !== 'new_audit')) { skip('Already contacted (lead stage moved on)'); continue; }
      accepted.push({ id, email, row: r });
    }

    const result = { queued: 0, skipped, dryRun: !!dryRun };
    if (dryRun) {
      result.queued = accepted.length;
      const sample = accepted[0] || (rows[0] ? { row: rows[0], email: L.normEmail(rows[0].email) } : null);
      if (sample) {
        const lead = (await leadFor(sample.email, sample.row.id)) || sample.row;
        const r = renderFor(1, lead, sample.email);
        result.preview = { audit_request_id: sample.row.id, email: sample.row.email, subject: r.subject, html: r.html };
      }
      return result;
    }

    const t = now();
    // Sent right away (immediate) waits for nothing; a queued send respects quiet hours.
    const sendAt = immediate ? t : L.applyQuietHours(t);
    result.sequence_ids = [];
    for (const a of accepted) {
      const ins = await queryOne(
        `INSERT INTO audit_lead_email_sequences (id, email_norm, audit_request_id, status, next_step, next_send_at, started_by, started_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?)
         ON CONFLICT (email_norm) DO NOTHING RETURNING id`,
        [crypto.randomUUID(), a.email, a.id, sendAt, String(startedBy || ''), t, t]
      );
      if (ins) { result.queued += 1; result.sequence_ids.push(ins.id); }
      else skipped.push({ id: a.id, email: a.row.email || '', reason: 'Already in sequence' });
    }
    result.next_send_at = result.queued ? sendAt.toISOString() : null;
    return result;
  }

  // ── job ───────────────────────────────────────────────────────────────────
  async function sentTodayCount() {
    const r = await queryOne(
      `SELECT COUNT(*)::int AS n FROM audit_lead_email_log WHERE status IN ('sent','sending') AND sent_at >= ?`,
      [L.startOfIstDay(now())]
    );
    return r ? Number(r.n) || 0 : 0;
  }

  async function setSeq(id, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await run(`UPDATE audit_lead_email_sequences SET ${sets}, updated_at = ? WHERE id = ?`, [...keys.map((k) => fields[k]), now(), id]);
  }

  async function stopSeq(seq, status, reason) {
    await setSeq(seq.id, { status, stopped_reason: reason || STOP_LABELS[status] || status, next_send_at: null });
  }

  async function advance(seq, step, sentAt) {
    const first = step === 1 ? sentAt : (seq.first_sent_at || sentAt);
    const nx = L.nextAfterSend(step, sentAt, first);
    if (nx.nextStep > 3) await setSeq(seq.id, { status: 'completed', next_step: 4, next_send_at: null, first_sent_at: first });
    else await setSeq(seq.id, { status: 'active', next_step: nx.nextStep, next_send_at: nx.nextSendAt, first_sent_at: first });
  }

  /** One due sequence. → 'sent' | 'failed' | 'stopped' | 'skipped' */
  async function processOne(seq) {
    const step = Number(seq.next_step);
    if (!(step >= 1 && step <= 3)) { await setSeq(seq.id, { status: 'completed', next_send_at: null }); return 'skipped'; }

    const facts = (await factsFor([seq.email_norm])).get(seq.email_norm) ||
      { email: seq.email_norm, stages: [] };
    facts.startedAt = seq.started_at;
    const reason = L.stopReason(facts);
    if (reason) {
      await stopSeq(seq, reason);
      await run(
        `INSERT INTO audit_lead_email_log (id, sequence_id, audit_request_id, email_norm, step, status, error, sent_at)
         VALUES (?, ?, ?, ?, ?, 'skipped', ?, ?) ON CONFLICT (email_norm, step) DO NOTHING`,
        [crypto.randomUUID(), seq.id, seq.audit_request_id, seq.email_norm, step, STOP_LABELS[reason] || reason, now()]
      );
      return 'stopped';
    }

    const c = cfg();
    const cc = c.cc && L.normEmail(c.cc) !== seq.email_norm ? c.cc : '';

    // Claim the (email, step) slot before talking to SMTP. This row is the hard
    // guarantee that a step is never sent twice.
    let logRow = await queryOne(
      `INSERT INTO audit_lead_email_log (id, sequence_id, audit_request_id, email_norm, step, cc, status, attempts, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', 1, ?) ON CONFLICT (email_norm, step) DO NOTHING RETURNING id, attempts`,
      [crypto.randomUUID(), seq.id, seq.audit_request_id, seq.email_norm, step, cc, now()]
    );
    if (!logRow) {
      const existing = await queryOne('SELECT * FROM audit_lead_email_log WHERE email_norm = ? AND step = ?', [seq.email_norm, step]);
      if (!existing) return 'skipped';
      if (existing.status === 'sent') { await advance(seq, step, new Date(existing.sent_at)); return 'skipped'; }
      if (existing.status === 'failed' && Number(existing.attempts) < MAX_ATTEMPTS) {
        logRow = await queryOne(
          `UPDATE audit_lead_email_log SET status = 'sending', attempts = attempts + 1, error = '', cc = ?, sent_at = ?
            WHERE id = ? AND status = 'failed' AND attempts < ? RETURNING id, attempts`,
          [cc, now(), existing.id, MAX_ATTEMPTS]
        );
        if (!logRow) return 'skipped';
      } else if (existing.status === 'failed') {
        await stopSeq(seq, 'failed', existing.error || 'Send failed');
        return 'failed';
      } else if (existing.status === 'sending') {
        // Another worker has it, or a process died mid-send. Never guess: a resend
        // could deliver twice, so after the lease the sequence fails for a human to check.
        if (now().getTime() - new Date(existing.sent_at).getTime() > STUCK_SENDING_MS) {
          await stopSeq(seq, 'failed', 'Send outcome unknown (process stopped mid-send). Check the inbox before resending.');
          return 'failed';
        }
        return 'skipped';
      } else {
        await stopSeq(seq, 'failed', 'Step already logged as ' + existing.status);
        return 'failed';
      }
    }

    let res;
    try {
      const lead = (await leadFor(seq.email_norm, seq.audit_request_id)) || { first_name: '', goals: '' };
      const r = renderFor(step, lead, seq.email_norm);
      const unsub = c.unsubSecret ? L.unsubUrl(seq.email_norm, c) : '';
      res = await sendMail({
        to: seq.email_norm,
        cc: cc || undefined,
        replyTo: c.replyTo || undefined,
        subject: r.subject,
        html: r.html,
        text: r.text,
        headers: unsub ? L.listUnsubscribeHeaders(unsub, c.smtpUser) : undefined
      });
    } catch (e) {
      res = { ok: false, messageId: '', error: String((e && e.message) || e) };
    }
    res = res || { ok: false, error: 'No result from mailer' };

    const t = now();
    if (res.ok) {
      await run(`UPDATE audit_lead_email_log SET status = 'sent', message_id = ?, error = '', sent_at = ? WHERE id = ?`,
        [String(res.messageId || ''), t, logRow.id]);
      await advance(seq, step, t);
      return 'sent';
    }
    const err = String(res.error || 'Send failed').slice(0, 500);
    await run(`UPDATE audit_lead_email_log SET status = 'failed', error = ? WHERE id = ?`, [err, logRow.id]);
    if (Number(logRow.attempts) >= MAX_ATTEMPTS) await stopSeq(seq, 'failed', err);
    else await setSeq(seq.id, { next_send_at: L.applyQuietHours(new Date(t.getTime() + RETRY_DELAY_MS)) });
    return 'failed';
  }

  /** The cron body. Safe to call at any time; it decides whether to send. */
  async function runDue() {
    const c = cfg();
    if (!c.enabled) return { ran: false, reason: 'disabled' };
    if (!isConfigured()) return { ran: false, reason: 'smtp_not_configured' };
    if (running) return { ran: false, reason: 'busy' };
    if (!L.inSendWindow(now())) return { ran: false, reason: 'quiet_hours' };
    running = true;
    const counts = { sent: 0, failed: 0, stopped: 0, skipped: 0 };
    try {
      const sentToday = await sentTodayCount();
      const allowance = L.batchAllowance({ due: c.batchSize, sentToday, batchSize: c.batchSize, dailyCap: c.dailyCap });
      if (allowance <= 0) return { ran: false, reason: 'daily_cap', sentToday };
      const t = now();
      const claimed = await queryAll(
        `WITH due AS (
           SELECT id, next_send_at AS due_at FROM audit_lead_email_sequences
            WHERE status = 'active' AND next_send_at <= ?
            ORDER BY next_send_at ASC LIMIT ?
            FOR UPDATE SKIP LOCKED
         )
         UPDATE audit_lead_email_sequences s SET next_send_at = ?, updated_at = ?
           FROM due WHERE s.id = due.id
         RETURNING s.*, due.due_at`,
        [t, allowance, new Date(t.getTime() + LEASE_MS), t]
      );
      claimed.sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
      for (let i = 0; i < claimed.length; i++) {
        if (i > 0 && c.gapMs > 0) await sleep(c.gapMs);
        try {
          counts[await processOne(claimed[i])] += 1;
        } catch (e) {
          counts.failed += 1;
          log.warn('[auditLeadEmails] sequence', claimed[i].id, e.message);
        }
      }
      if (claimed.length) log.log(`[auditLeadEmails] run: ${JSON.stringify(counts)} (sent today before run: ${sentToday})`);
      return { ran: true, claimed: claimed.length, ...counts };
    } finally {
      running = false;
    }
  }

  // ── admin: stop, list, preview, test ─────────────────────────────────────
  async function stop(id, reason) {
    const status = reason === 'replied' ? 'stopped_replied' : 'stopped_manual';
    const row = await queryOne(
      `UPDATE audit_lead_email_sequences SET status = ?, stopped_reason = ?, next_send_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'active' RETURNING *`,
      [status, reason === 'replied' ? 'Marked replied by admin' : 'Stopped by admin', now(), String(id || '')]
    );
    if (row) return row;
    return queryOne('SELECT * FROM audit_lead_email_sequences WHERE id = ?', [String(id || '')]);
  }

  async function list({ status } = {}) {
    const st = String(status || '').trim();
    return queryAll(
      `SELECT s.*, a.first_name, a.last_name, a.email,
              l.step AS last_step, l.status AS last_status, l.sent_at AS last_sent_at, l.error AS last_error, l.cc AS last_cc,
              (SELECT MAX(x.step) FROM audit_lead_email_log x WHERE x.sequence_id = s.id AND x.status = 'sent') AS sent_step
         FROM audit_lead_email_sequences s
         LEFT JOIN audit_requests a ON a.id = s.audit_request_id
         LEFT JOIN LATERAL (
           SELECT * FROM audit_lead_email_log x WHERE x.sequence_id = s.id ORDER BY x.step DESC, x.sent_at DESC LIMIT 1
         ) l ON TRUE
        WHERE (? = '' OR s.status = ?)
        ORDER BY s.updated_at DESC
        LIMIT 500`,
      [st, st]
    );
  }

  async function preview(auditId, step) {
    const row = await queryOne('SELECT id, first_name, last_name, email, goals FROM audit_requests WHERE id = ?', [String(auditId || '')]);
    if (!row) return null;
    const email = L.normEmail(row.email);
    const lead = (await leadFor(email, row.id)) || row;
    return renderFor(step, lead, email);
  }

  /** One rendered email to a staff address. No sequence, no log row. */
  async function sendTest({ to, step, lead }) {
    const c = cfg();
    const email = L.normEmail(to);
    const r = renderFor(step, lead || { first_name: 'there', goals: '' }, email);
    const cc = c.cc && L.normEmail(c.cc) !== email ? c.cc : '';
    const unsub = c.unsubSecret ? L.unsubUrl(email, c) : '';
    return sendMail({
      to: email,
      cc: cc || undefined,
      replyTo: c.replyTo || undefined,
      subject: r.subject,
      html: r.html,
      text: r.text,
      headers: unsub ? L.listUnsubscribeHeaders(unsub, c.smtpUser) : undefined
    });
  }

  // ── public: unsubscribe ─────────────────────────────────────────────────
  async function unsubscribe(email, source) {
    const e = L.normEmail(email);
    await run(`INSERT INTO email_unsubscribes (email_norm, source, created_at) VALUES (?, ?, ?) ON CONFLICT (email_norm) DO NOTHING`,
      [e, source || 'audit_lead', now()]);
    await run(
      `UPDATE audit_lead_email_sequences SET status = 'stopped_unsubscribed', stopped_reason = ?, next_send_at = NULL, updated_at = ?
        WHERE email_norm = ? AND status = 'active'`,
      [STOP_LABELS.stopped_unsubscribed, now(), e]
    );
    return e;
  }

  /**
   * Send Email 1 for these sequences now, without waiting for the job. Quiet hours do
   * not apply (the lead just asked, or an admin pressed send); the enabled flag, SMTP
   * and the daily cap still do. Each sequence is claimed with the same lease as the
   * job, so the two can never both send it.
   * → { sent, failed, stopped, waiting, reason? }  (waiting = left for the job)
   */
  async function sendNow(sequenceIds, opts) {
    const o = opts || {};
    const ids = (sequenceIds || []).filter(Boolean);
    const out = { sent: 0, failed: 0, stopped: 0, waiting: 0 };
    if (!ids.length) return out;
    const c = cfg();
    if (!c.enabled) return Object.assign(out, { waiting: ids.length, reason: 'disabled' });
    if (!isConfigured()) return Object.assign(out, { waiting: ids.length, reason: 'smtp_not_configured' });
    let room = Math.max(0, c.dailyCap - (await sentTodayCount()));
    for (let i = 0; i < ids.length; i++) {
      if (room <= 0) { out.waiting += ids.length - i; out.reason = 'daily_cap'; break; }
      if (i > 0 && o.gapMs) await sleep(o.gapMs);
      const t = now();
      const seq = await queryOne(
        `UPDATE audit_lead_email_sequences SET next_send_at = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND next_step = 1 RETURNING *`,
        [new Date(t.getTime() + LEASE_MS), t, ids[i]]
      );
      if (!seq) continue;
      let r;
      try { r = await processOne(seq); } catch (e) { r = 'failed'; log.warn('[auditLeadEmails] send now', ids[i], e.message); }
      if (r === 'sent') { out.sent += 1; room -= 1; }
      else if (r === 'stopped') out.stopped += 1;
      else if (r === 'failed') out.failed += 1;
    }
    return out;
  }

  /**
   * Called right after an audit is submitted: start the sequence and send Email 1 now.
   * → { sent: true } or { sent: false, reason } (the caller then sends the plain receipt).
   */
  async function autoWelcome(auditId) {
    const c = cfg();
    if (!c.autoSend) return { sent: false, reason: 'auto_send_off' };
    if (!c.enabled) return { sent: false, reason: 'disabled' };
    if (!isConfigured()) return { sent: false, reason: 'smtp_not_configured' };
    const q = await queue({ ids: [auditId], startedBy: 'auto:audit_submit', immediate: true });
    if (!q.queued) return { sent: false, reason: (q.skipped[0] && q.skipped[0].reason) || 'skipped' };
    const r = await sendNow(q.sequence_ids);
    return r.sent ? { sent: true } : { sent: false, reason: r.reason || (r.failed ? 'send_failed' : 'not_sent') };
  }

  return { queue, sendNow, autoWelcome, runDue, processOne, stop, list, preview, sendTest, unsubscribe, config: cfg, MAX_QUEUE_IDS };
}

/** Every 5 minutes, Asia/Kolkata. The run itself checks the flag, SMTP and quiet hours. */
function startAuditLeadEmailJob(engine) {
  const cron = require('node-cron');
  const job = cron.schedule('*/5 * * * *', () => {
    engine.runDue().catch((e) => console.warn('[auditLeadEmails] job:', e.message));
  }, { timezone: 'Asia/Kolkata' });
  const c = engine.config();
  console.log(`[auditLeadEmails] sequence job started (every 5 min IST, ${c.enabled ? 'enabled' : 'DISABLED by AUDIT_LEAD_EMAILS_ENABLED'}, batch ${c.batchSize}, cap ${c.dailyCap}/day)`);
  return job;
}

module.exports = {
  SCHEMA_SQL,
  ensureAuditLeadEmailSchema,
  createAuditLeadEmailSequence,
  startAuditLeadEmailJob,
  MAX_QUEUE_IDS
};
