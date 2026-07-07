'use strict';

/**
 * Event Engine — the single integration point between the app and the coach.
 * emitCoachEvent(userId, type, payload) is fire-and-forget and NEVER throws (same
 * contract as notifyAsync). It dedups, then inserts a durable row into coach_events
 * that a worker later drains. A Postgres table (not an in-memory queue) so events
 * survive Render deploy restarts and give a free audit trail.
 */

const { metaFor, isKnownEvent } = require('./taxonomy');

/** Stable dedup fingerprint. Same type same day (or same explicit key) collapses. */
function dedupKey(type, payload) {
  const p = payload || {};
  const disc = p.dedupKey || p.date || p.ymd || '';
  return disc ? `${type}:${disc}` : type;
}

async function ingest(ctx, userId, type, payload = {}) {
  if (!userId || !isKnownEvent(type)) return { ok: false, reason: 'unknown_event' };
  const meta = metaFor(type);
  const key = dedupKey(type, payload);

  // Persistent dedup: same user + key inside the TTL window → drop.
  if (meta.dedup_ttl > 0) {
    const seconds = Math.round(meta.dedup_ttl / 1000);
    const recent = await ctx.queryOne(
      `SELECT id FROM coach_events
       WHERE user_id = ? AND dedup_key = ?
         AND created_at >= NOW() - (? || ' seconds')::interval
       ORDER BY created_at DESC LIMIT 1`,
      [userId, key, String(seconds)]
    );
    if (recent) return { ok: false, reason: 'deduped', id: recent.id };
  }

  const id = ctx.uuidv4();
  await ctx.run(
    `INSERT INTO coach_events
       (id, user_id, type, category, payload, priority, dedup_key, status, scheduled_for, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, 'pending', NOW(), NOW(), NOW())`,
    [id, userId, type, meta.category, JSON.stringify(payload || {}), meta.base_priority, key]
  );
  return { ok: true, id };
}

/** Fire-and-forget wrapper: never throws, never blocks the caller. */
function emit(ctx, userId, type, payload) {
  Promise.resolve()
    .then(() => ingest(ctx, userId, type, payload))
    .catch((e) => { try { console.warn('[coach] emit failed:', type, e.message); } catch (_) {} });
}

/** Claim a batch of events that are due for evaluation now. */
async function claimDue(ctx, limit = 25) {
  const rows = await ctx.queryAll(
    `SELECT * FROM coach_events
     WHERE status IN ('pending', 'scheduled')
       AND scheduled_for <= NOW()
     ORDER BY priority DESC, created_at ASC
     LIMIT ?`,
    [limit]
  );
  return rows || [];
}

async function setStatus(ctx, eventId, status, extra = {}) {
  const sets = ['status = ?', 'updated_at = NOW()'];
  const params = [status];
  if ('suppress_reason' in extra) { sets.push('suppress_reason = ?'); params.push(extra.suppress_reason); }
  if ('scheduled_for' in extra) { sets.push('scheduled_for = ?'); params.push(extra.scheduled_for); }
  params.push(eventId);
  await ctx.run(`UPDATE coach_events SET ${sets.join(', ')} WHERE id = ?`, params);
}

module.exports = { ingest, emit, claimDue, setStatus, dedupKey };
