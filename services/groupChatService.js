'use strict';

/**
 * BodyBank — Care Group chat (data layer).
 *
 * Replaces the WhatsApp group a client shares with their doctor, lifestyle
 * manager and operator with a conversation that lives inside BodyBank. This is
 * ADDITIVE: the 1-to-1 `message_threads` / `thread_messages` chat is untouched
 * and keeps working exactly as before.
 *
 * ── Identity model ────────────────────────────────────────────────────────────
 * BodyBank has four ACCOUNT roles (user / admin / superadmin / operator) and no
 * `doctor` or `lifestyle_manager`. Rather than widen `users.role` — which would
 * mean auditing every guard in the app (requireOperator, requireSelfOrStaff,
 * requireAdminOrSuperadmin, routes/blood.js STAFF_ROLES, the push fan-out …) —
 * the care role is a property of the MEMBERSHIP, not of the account:
 *
 *     chat_group_members.group_role ∈ client | doctor | lifestyle_manager
 *                                     | operator | admin
 *
 * Admin picks any existing account for a slot and labels it. `users.role` is
 * never written by this module, so global access control is unchanged and real
 * doctor accounts can be layered on later without redoing any of this.
 *
 * ── Ordering and the poll cursor ──────────────────────────────────────────────
 * Every message gets a BIGSERIAL `seq`. It is the single source of truth for
 * ordering, pagination (`before=<seq>`) and the live cursor (`since=<seq>`).
 * Timestamps are for display only — two messages inserted in the same
 * millisecond, or a node with a skewed clock, would both corrupt a
 * created_at-ordered feed. Read receipts ride the same integer
 * (`last_read_seq`), which is why "who has read this" is a numeric compare
 * rather than a per-message-per-member table.
 */

const { v4: uuidv4 } = require('uuid');

/** Care roles a membership row may carry. Order is display order in the UI. */
const GROUP_ROLES = ['client', 'doctor', 'lifestyle_manager', 'operator', 'admin'];

const GROUP_ROLE_LABELS = {
  client: 'Client',
  doctor: 'Doctor',
  lifestyle_manager: 'Lifestyle Manager',
  operator: 'Operator',
  admin: 'Admin'
};

/** The reaction set offered by the picker. Anything else is rejected server-side. */
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Suffix every care group name carries, per the product spec. */
const GROUP_NAME_SUFFIX = ' - 2.0';

const MAX_BODY_CHARS = 5000;
const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
/**
 * How many of the newest messages a poll re-checks for mutable state (edits,
 * deletes, reactions). New messages arrive via the `seq` cursor, but an edit or
 * a reaction on an OLD message moves no cursor — so the poll re-reads a bounded
 * recent window instead. 60 rows keeps the payload small while covering more
 * than a screenful on any device.
 */
const RECENT_STATE_WINDOW = 60;

/** Edits are only allowed for a short while, like WhatsApp's 15-minute window. */
const EDIT_WINDOW_MS = 15 * 60 * 1000;

const ADMIN_ROLES = ['admin', 'superadmin'];

function isAdminRole(role) {
  return ADMIN_ROLES.includes(String(role || ''));
}

function displayName(u) {
  if (!u) return 'Unknown';
  const name = [(u.first_name || '').trim(), (u.last_name || '').trim()].filter(Boolean).join(' ');
  return name || String(u.email || '').split('@')[0] || 'Unknown';
}

function normalizeGroupRole(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return GROUP_ROLES.includes(s) ? s : null;
}

/**
 * Build the canonical group name for a client: `Mitul Nadendla - 2.0`.
 * The suffix is exact and is not user-editable at creation time; admin can
 * rename afterwards via updateGroup().
 */
function buildGroupName(clientUser) {
  return displayName(clientUser) + GROUP_NAME_SUFFIX;
}

function clampBody(v) {
  return String(v == null ? '' : v).trim().slice(0, MAX_BODY_CHARS);
}

/**
 * Create every table and index this feature owns. Safe to call on every boot —
 * each statement is IF NOT EXISTS and each post-release column is guarded on its
 * own so one failure cannot skip the rest.
 */
async function ensureGroupChatTables(db) {
  if (!db || typeof db.run !== 'function') return { ok: false, reason: 'invalid_db' };
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS chat_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      avatar_url TEXT DEFAULT '',
      created_by TEXT,
      archived BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      last_message_at TIMESTAMPTZ
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS chat_group_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_role TEXT NOT NULL DEFAULT 'client',
      muted BOOLEAN DEFAULT FALSE,
      last_read_seq BIGINT DEFAULT 0,
      joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      removed_at TIMESTAMPTZ
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      sender_id TEXT,
      sender_group_role TEXT DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'text',
      body TEXT DEFAULT '',
      reply_to_id TEXT,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS chat_message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS chat_message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      mime_type TEXT DEFAULT '',
      size_bytes BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS chat_group_audit (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      actor_id TEXT,
      actor_name TEXT DEFAULT '',
      action TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (e) {
    console.warn('[groupChat ensureTables]', e.message);
    return { ok: false, reason: 'create_failed' };
  }

  // One membership row per (group, user). Without this a double-click on
  // "Add member" silently doubles someone's unread maths and read receipts.
  try {
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_group_members
      ON chat_group_members(group_id, user_id)`);
  } catch (e) { /* ignore */ }
  // A member may hold one of each emoji, not two of the same.
  try {
    await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_reaction
      ON chat_message_reactions(message_id, user_id, emoji)`);
  } catch (e) { /* ignore */ }
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_chat_messages_group_seq
      ON chat_messages(group_id, seq DESC)`);
  } catch (e) { /* ignore */ }
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_chat_group_members_user
      ON chat_group_members(user_id) WHERE removed_at IS NULL`);
  } catch (e) { /* ignore */ }
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg
      ON chat_message_reactions(message_id)`);
  } catch (e) { /* ignore */ }
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_chat_groups_client
      ON chat_groups(client_id)`);
  } catch (e) { /* ignore */ }
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_chat_attachments_msg
      ON chat_message_attachments(message_id)`);
  } catch (e) { /* ignore */ }
  // A per-group revision counter, bumped by every mutation a poll must notice
  // (new message, edit, delete, reaction, rename, avatar). A poll that finds the
  // same `rev` it already has returns after ONE query instead of re-reading the
  // transcript, members and reactions. A counter rather than a timestamp, so two
  // writes in the same millisecond still register as two changes.
  try {
    await db.run(`ALTER TABLE chat_groups ADD COLUMN IF NOT EXISTS rev BIGINT DEFAULT 0`);
  } catch (e) { /* ignore */ }
  // The inbox pulls the newest message of every 1-to-1 thread through a LATERAL.
  // thread_messages only had a plain (thread_id) index, which makes that a sort
  // per thread; the composite turns each one into a single index seek. Adding an
  // index is the only thing this feature does to the legacy chat tables.
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created
      ON thread_messages(thread_id, created_at DESC)`);
  } catch (e) { /* ignore */ }
  await ensureAutomatedFlag(db);

  return { ok: true };
}

/**
 * Tell automated 1-to-1 messages apart from personal ones.
 *
 * The campaign scheduler posts ~22 nudges a week into EVERY client's
 * Lifestyle Manager thread, as sender_role 'admin' — row-for-row identical to a
 * real reply. Without a flag the admin inbox lists every client as an active
 * conversation, and each thread fills with months of nudges.
 *
 *   thread_messages.is_automated   FALSE for anything a person typed.
 *
 * The scheduler sets it on new rows. Existing rows are classified ONCE: a staff
 * message whose text is a known campaign/broadcast text, or that went to five
 * or more threads within the same minute (a broadcast by definition). The
 * column comment records that the pass ran, so later boots skip it — and a
 * person who deliberately repeats a campaign line later is never re-flagged.
 * This column and its index are the only changes to the legacy chat tables.
 */
const AUTOMATED_BACKFILL_MARK = 'bbg-automated-backfill-v1';

async function ensureAutomatedFlag(db) {
  try {
    await db.run(`ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT FALSE`);
  } catch (e) {
    console.warn('[groupChat automated column]', e.message);
    return;
  }
  // Only personal messages are indexed, so an inbox lookup for a thread that
  // holds nothing but nudges is an immediate empty seek.
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_thread_messages_personal
      ON thread_messages(thread_id, created_at DESC) WHERE is_automated = FALSE`);
  } catch (e) { /* ignore */ }

  try {
    const mark = await db.queryOne(
      `SELECT col_description(a.attrelid, a.attnum) AS d
       FROM pg_attribute a
       WHERE a.attrelid = 'thread_messages'::regclass AND a.attname = 'is_automated'`
    );
    if (mark && mark.d === AUTOMATED_BACKFILL_MARK) return;

    await db.run(
      `UPDATE thread_messages m SET is_automated = TRUE
       WHERE m.is_automated = FALSE
         AND m.sender_role IN ('admin', 'superadmin')
         AND (
           btrim(m.body) IN (
             SELECT btrim(message) FROM campaign_messages
             UNION
             SELECT btrim(message) FROM campaign_send_log
           )
           OR (m.body, date_trunc('minute', m.created_at)) IN (
             SELECT body, date_trunc('minute', created_at)
             FROM thread_messages
             WHERE sender_role IN ('admin', 'superadmin')
             GROUP BY 1, 2
             HAVING COUNT(DISTINCT thread_id) >= 5
           )
         )`
    );
    await db.run(`COMMENT ON COLUMN thread_messages.is_automated IS '${AUTOMATED_BACKFILL_MARK}'`);
  } catch (e) {
    // Retried on the next boot; the inbox still works, it just lists more.
    console.warn('[groupChat automated backfill]', e.message);
  }
}

/**
 * The caller's relationship to a group.
 *
 * Admin/superadmin are admitted to every group without a membership row — they
 * own the platform and the spec gives them full group management. That mirrors
 * the existing 1-to-1 thread routes, where an admin can read and reply to any
 * client's thread. Everyone else needs a live (non-removed) membership row;
 * in particular a client can never reach another client's care group.
 *
 * @returns {{ok: boolean, group: object|null, membership: object|null,
 *            isAdmin: boolean, canPost: boolean, canManage: boolean}}
 */
async function resolveAccess(db, groupId, user) {
  const uid = String((user && user.id) || '');
  // ONE round trip: the group, the caller's live membership, the group's client
  // and the caller's own profile. Every /:id route runs this first; it used to be
  // two sequential queries before any real work could start, and the route then
  // looked the client and the caller up again on its own.
  //
  // Placeholders are positional in TEXT order: m.user_id, su.id, g.id.
  const row = await db.queryOne(
    `SELECT g.*,
            m.id AS m_id, m.group_role AS m_group_role, m.muted AS m_muted,
            m.last_read_seq AS m_last_read_seq,
            cu.first_name AS c_first_name, cu.last_name AS c_last_name,
            cu.email AS c_email, cu.profile_picture AS c_profile_picture,
            su.first_name AS s_first_name, su.last_name AS s_last_name,
            su.email AS s_email, su.profile_picture AS s_profile_picture
     FROM chat_groups g
     LEFT JOIN chat_group_members m
            ON m.group_id = g.id AND m.user_id = ? AND m.removed_at IS NULL
     LEFT JOIN users cu ON cu.id = g.client_id
     LEFT JOIN users su ON su.id = ?
     WHERE g.id = ?`,
    [uid, uid, String(groupId || '')]
  );
  if (!row) {
    return { ok: false, group: null, membership: null, client: null, self: null, isAdmin: false, canPost: false, canManage: false };
  }

  const group = {};
  for (const k of Object.keys(row)) {
    if (!/^(m|c|s)_/.test(k)) group[k] = row[k];
  }
  group.rev = Number(row.rev || 0);

  const membership = row.m_id
    ? { id: row.m_id, group_id: group.id, user_id: uid, group_role: row.m_group_role,
        muted: !!row.m_muted, last_read_seq: row.m_last_read_seq }
    : null;
  const client = { id: group.client_id, first_name: row.c_first_name, last_name: row.c_last_name,
                   email: row.c_email, profile_picture: row.c_profile_picture };
  const self = { id: uid, first_name: row.s_first_name, last_name: row.s_last_name,
                 email: row.s_email, profile_picture: row.s_profile_picture };

  const admin = isAdminRole(user && user.role);
  const ok = admin || !!membership;
  return {
    ok,
    group,
    membership,
    client,
    self,
    isAdmin: admin,
    // An archived group is read-only for everyone; admin unarchives to reopen it.
    canPost: ok && !group.archived,
    canManage: admin
  };
}

/** Live members of a group, joined to their user record, in care-role order. */
async function listMembers(db, groupId) {
  const rows = await db.queryAll(
    `SELECT m.id, m.group_id, m.user_id, m.group_role, m.muted, m.last_read_seq,
            m.joined_at, u.first_name, u.last_name, u.email, u.profile_picture, u.role AS account_role
     FROM chat_group_members m
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? AND m.removed_at IS NULL
     ORDER BY m.joined_at ASC`,
    [String(groupId || '')]
  );
  const order = new Map(GROUP_ROLES.map((r, i) => [r, i]));
  return rows
    .map(r => ({
      id: r.id,
      userId: r.user_id,
      groupRole: r.group_role,
      roleLabel: GROUP_ROLE_LABELS[r.group_role] || 'Member',
      accountRole: r.account_role || '',
      name: displayName(r),
      email: r.email || '',
      avatar: r.profile_picture || '',
      muted: !!r.muted,
      lastReadSeq: Number(r.last_read_seq || 0),
      joinedAt: r.joined_at
    }))
    .sort((a, b) => {
      const d = (order.get(a.groupRole) ?? 99) - (order.get(b.groupRole) ?? 99);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
}

/** Reaction rows for a set of message ids, folded into per-emoji buckets. */
async function reactionsForMessages(db, messageIds, viewerId) {
  if (!messageIds || messageIds.length === 0) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await db.queryAll(
    `SELECT r.message_id, r.emoji, r.user_id, u.first_name, u.last_name, u.email
     FROM chat_message_reactions r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.message_id IN (${placeholders})
     ORDER BY r.created_at ASC`,
    messageIds
  );
  const out = {};
  for (const r of rows) {
    const bucket = (out[r.message_id] = out[r.message_id] || {});
    const entry = (bucket[r.emoji] = bucket[r.emoji] || { emoji: r.emoji, count: 0, mine: false, names: [] });
    entry.count += 1;
    if (String(r.user_id) === String(viewerId)) entry.mine = true;
    if (entry.names.length < 8) entry.names.push(displayName(r));
  }
  // Collapse to arrays ordered by popularity so the densest reaction reads first.
  const collapsed = {};
  for (const [mid, bucket] of Object.entries(out)) {
    collapsed[mid] = Object.values(bucket).sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }
  return collapsed;
}

/** True for anything the chat treats as playable audio (see routes/groupChat.js's isAudioMime). */
function isAudioAttachment(mimeType) {
  const mt = String(mimeType || '');
  return mt.startsWith('audio/') || mt === 'video/mp4';
}

/**
 * Attachment rows for a set of message ids, keyed by message id.
 *
 * `sign(attachmentId)` mints the short-lived, attachment-scoped token the
 * download route accepts in `?token=` — the caller supplies it (bound to the
 * viewer making this request) because signing is an auth concern that lives
 * in middleware/auth.js, not in this DB-only service. Without it the plain
 * URL is still returned, unauthenticated, which is why every caller upstream
 * of this must pass one: an <img>/<audio> tag cannot carry an Authorization
 * header, so a caller-less URL 401s the moment the browser requests it.
 */
async function attachmentsForMessages(db, messageIds, sign) {
  if (!messageIds || messageIds.length === 0) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await db.queryAll(
    `SELECT id, message_id, original_name, mime_type, size_bytes
     FROM chat_message_attachments
     WHERE message_id IN (${placeholders})
     ORDER BY created_at ASC`,
    messageIds
  );
  const out = {};
  for (const r of rows) {
    const base = '/api/groups/attachments/' + r.id;
    const token = typeof sign === 'function' ? sign(r.id) : null;
    (out[r.message_id] = out[r.message_id] || []).push({
      id: r.id,
      name: r.original_name || 'Attachment',
      mimeType: r.mime_type || '',
      size: Number(r.size_bytes || 0),
      isImage: String(r.mime_type || '').startsWith('image/'),
      isAudio: isAudioAttachment(r.mime_type),
      // Always an authenticated route — never a /uploads URL. The uploads mount
      // is public, so a direct path would make every chat attachment readable
      // by anyone who guessed or was forwarded the link.
      url: token ? base + '?token=' + encodeURIComponent(token) : base
    });
  }
  return out;
}

/**
 * Shape a raw chat_messages row for the wire, attaching its reply preview,
 * reactions and attachments.
 *
 * A soft-deleted message keeps its row (so replies pointing at it still
 * resolve, and so the audit trail is intact) but its body never leaves the
 * server.
 */
function serializeMessage(row, ctx) {
  const deleted = !!row.deleted_at;
  const senderName = row.sender_id ? displayName(row) : 'BodyBank';
  const out = {
    id: row.id,
    seq: Number(row.seq),
    groupId: row.group_id,
    senderId: row.sender_id,
    senderName,
    senderAvatar: row.profile_picture || '',
    senderRole: row.sender_group_role || '',
    senderRoleLabel: GROUP_ROLE_LABELS[row.sender_group_role] || '',
    kind: deleted ? 'deleted' : (row.kind || 'text'),
    body: deleted ? '' : (row.body || ''),
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    deleted,
    mine: String(row.sender_id || '') === String((ctx && ctx.viewerId) || ' '),
    reactions: (ctx && ctx.reactions && ctx.reactions[row.id]) || [],
    attachments: deleted ? [] : ((ctx && ctx.attachments && ctx.attachments[row.id]) || []),
    replyTo: null
  };
  const parent = ctx && ctx.replies && ctx.replies[row.reply_to_id];
  if (row.reply_to_id && parent) {
    out.replyTo = {
      id: parent.id,
      seq: Number(parent.seq),
      senderName: parent.sender_id ? displayName(parent) : 'BodyBank',
      senderRoleLabel: GROUP_ROLE_LABELS[parent.sender_group_role] || '',
      // A reply to a since-deleted message shows the tombstone, not the old text.
      body: parent.deleted_at ? 'This message was deleted' : String(parent.body || '').slice(0, 220),
      kind: parent.deleted_at ? 'deleted' : (parent.kind || 'text')
    };
  } else if (row.reply_to_id) {
    // Parent row is gone entirely (hard delete / cascade). Keep the quote slot so
    // the bubble still renders instead of throwing away the reply.
    out.replyTo = { id: row.reply_to_id, seq: 0, senderName: '', senderRoleLabel: '', body: 'Message unavailable', kind: 'deleted' };
  }
  return out;
}

/**
 * Load messages with everything the bubble needs. `before` pages backwards for
 * lazy-loading history; `since` streams forward for the live cursor.
 *
 * Rows are always returned oldest-first regardless of which direction the query
 * ran, because that is the order the transcript renders in.
 */
/**
 * One SELECT that returns each message WITH its reactions (json-aggregated in a
 * lateral) and its reply preview (a self-join). Reactions and replies used to be
 * two more round trips per page; now a page is one query, plus an attachments
 * lookup only when a row actually carries a file.
 *
 * The reply join also requires `p.group_id = m.group_id`, so even a corrupted
 * reply_to_id can never quote text out of another group.
 */
const HYDRATED_FROM = `
  SELECT m.id, m.seq, m.group_id, m.sender_id, m.sender_group_role, m.kind, m.body,
         m.reply_to_id, m.edited_at, m.deleted_at, m.created_at,
         u.first_name, u.last_name, u.email, u.profile_picture,
         rx.reactions AS rx_reactions,
         p.id AS p_id, p.seq AS p_seq, p.sender_id AS p_sender_id,
         p.sender_group_role AS p_sender_group_role, p.body AS p_body, p.kind AS p_kind,
         p.deleted_at AS p_deleted_at,
         pu.first_name AS p_first_name, pu.last_name AS p_last_name, pu.email AS p_email
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.sender_id
  LEFT JOIN chat_messages p ON p.id = m.reply_to_id AND p.group_id = m.group_id
  LEFT JOIN users pu ON pu.id = p.sender_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'emoji', r.emoji, 'user_id', r.user_id,
             'first_name', ru.first_name, 'last_name', ru.last_name, 'email', ru.email
           ) ORDER BY r.created_at) AS reactions
    FROM chat_message_reactions r
    LEFT JOIN users ru ON ru.id = r.user_id
    WHERE r.message_id = m.id
  ) rx ON TRUE`;

function asJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/** Fold raw reaction rows into per-emoji buckets — same shape as reactionsForMessages. */
function foldReactions(list, viewerId) {
  const bucket = {};
  for (const r of list || []) {
    if (!r || !r.emoji) continue;
    const e = (bucket[r.emoji] = bucket[r.emoji] || { emoji: r.emoji, count: 0, mine: false, names: [] });
    e.count += 1;
    if (String(r.user_id) === String(viewerId)) e.mine = true;
    if (e.names.length < 8) e.names.push(displayName(r));
  }
  return Object.values(bucket).sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

/** Turn hydrated rows into wire messages. `sign` — see attachmentsForMessages(). */
async function finishRows(db, rows, viewerId, sign) {
  if (!rows.length) return [];
  const reactions = {};
  const replies = {};
  for (const r of rows) {
    reactions[r.id] = foldReactions(asJson(r.rx_reactions), viewerId);
    if (r.p_id) {
      replies[r.p_id] = {
        id: r.p_id, seq: r.p_seq, sender_id: r.p_sender_id, sender_group_role: r.p_sender_group_role,
        body: r.p_body, kind: r.p_kind, deleted_at: r.p_deleted_at,
        first_name: r.p_first_name, last_name: r.p_last_name, email: r.p_email
      };
    }
  }
  const hasAttachments = rows.some(r => r.kind === 'image' || r.kind === 'file' || r.kind === 'audio');
  const attachments = hasAttachments ? await attachmentsForMessages(db, rows.map(r => r.id), sign) : {};
  return rows.map(r => serializeMessage(r, { viewerId, reactions, attachments, replies }));
}

/** Kept for callers that already hold plain rows (e.g. the attachment route). */
async function hydrateRows(db, rows, viewerId) {
  if (!rows.length) return [];
  const full = await db.queryAll(
    `${HYDRATED_FROM} WHERE m.id IN (${rows.map(() => '?').join(',')}) ORDER BY m.seq ASC`,
    rows.map(r => r.id)
  );
  return finishRows(db, full, viewerId);
}

/**
 * Load messages with everything the bubble needs. `before` pages backwards for
 * lazy-loading history; `since` streams forward for the live cursor.
 *
 * Rows are always returned oldest-first regardless of which direction the query
 * ran, because that is the order the transcript renders in.
 */
const MESSAGE_COLS = `m.id, m.seq, m.group_id, m.sender_id, m.sender_group_role, m.kind, m.body,
                m.reply_to_id, m.edited_at, m.deleted_at, m.created_at,
                u.first_name, u.last_name, u.email, u.profile_picture`;

/**
 * Attach reactions, attachments and reply previews to raw message rows.
 * The three lookups run in parallel, and the two optional ones are skipped
 * entirely when no row needs them — which is almost every page.
 */
async function hydrateRows(db, rows, viewerId, sign) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const replyIds = [...new Set(rows.map(r => r.reply_to_id).filter(Boolean))];
  const hasAttachments = rows.some(r => r.kind === 'image' || r.kind === 'file' || r.kind === 'audio');
  const [reactions, attachments, replyRows] = await Promise.all([
    reactionsForMessages(db, ids, viewerId),
    hasAttachments ? attachmentsForMessages(db, ids, sign) : Promise.resolve({}),
    replyIds.length
      ? db.queryAll(
          `SELECT m.id, m.seq, m.sender_id, m.sender_group_role, m.body, m.kind, m.deleted_at,
                  u.first_name, u.last_name, u.email
           FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.id IN (${replyIds.map(() => '?').join(',')})`,
          replyIds
        )
      : Promise.resolve([])
  ]);
  const replies = {};
  for (const r of replyRows) replies[r.id] = r;
  return rows.map(r => serializeMessage(r, { viewerId, reactions, attachments, replies }));
}

/**
 * Load messages with everything the bubble needs. `before` pages backwards for
 * lazy-loading history; `since` streams forward for the live cursor.
 *
 * Rows are always returned oldest-first regardless of which direction the query
 * ran, because that is the order the transcript renders in.
 */
async function loadMessages(db, groupId, opts = {}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(opts.limit, 10) || DEFAULT_PAGE_SIZE));
  let rows;
  if (opts.since != null) {
    rows = await db.queryAll(
      `${HYDRATED_FROM} WHERE m.group_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`,
      [groupId, String(opts.since), limit]
    );
  } else if (opts.before != null) {
    rows = await db.queryAll(
      `${HYDRATED_FROM} WHERE m.group_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
      [groupId, String(opts.before), limit]
    );
    rows.reverse();
  } else {
    rows = await db.queryAll(
      `${HYDRATED_FROM} WHERE m.group_id = ? ORDER BY m.seq DESC LIMIT ?`,
      [groupId, limit]
    );
    rows.reverse();
  }
  return finishRows(db, rows, opts.viewerId, opts.sign);
}

/**
 * The newest page plus whether anything older exists — in the SAME query.
 * Fetching `limit + 1` rows answers "is there more?" without the separate
 * existence check that used to add a round trip to every open.
 */
async function loadNewestPage(db, groupId, opts = {}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(opts.limit, 10) || DEFAULT_PAGE_SIZE));
  const rows = await db.queryAll(
    `${HYDRATED_FROM} WHERE m.group_id = ? ORDER BY m.seq DESC LIMIT ?`,
    [groupId, limit + 1]
  );
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  rows.reverse();
  const messages = await finishRows(db, rows, opts.viewerId, opts.sign);
  const maxSeq = messages.length ? Number(messages[messages.length - 1].seq) : 0;
  return { messages, hasMore, maxSeq };
}

/** Highest seq in a group — the cursor a client polls against. 0 when empty. */
async function groupMaxSeq(db, groupId) {
  const row = await db.queryOne('SELECT COALESCE(MAX(seq), 0) AS s FROM chat_messages WHERE group_id = ?', [groupId]);
  return Number((row && row.s) || 0);
}

/**
 * Conversation-list rows for one viewer: every group they can see, with the
 * last-message preview and their own unread count.
 *
 * Unread counts only messages someone ELSE sent above the viewer's read cursor,
 * so your own sends never make your own list look unread. Admins see every
 * group; because an admin has no membership row their cursor is 0, which would
 * read as "everything unread" — so unread is reported as 0 for a non-member
 * admin and only becomes meaningful once they join a group.
 */
async function listGroupsForUser(db, user, opts = {}) {
  const admin = isAdminRole(user && user.role);
  const userId = String((user && user.id) || '');
  const includeArchived = !!opts.includeArchived;

  // Placeholders are positional: `?` is rewritten to $1, $2, … in the order the
  // text is read, so `params` must follow the order the `?`s APPEAR in the query
  // below, not the order the clauses are assembled here. The query reads:
  //   1. cm.sender_id IS DISTINCT FROM ?   (the unread sub-select)
  //   2. me.user_id = ?                    (the LEFT JOIN onto my membership)
  //   3. user_id = ?                       (the WHERE, non-admin only)
  // All three are the same id; getting the COUNT wrong is what breaks it.
  const where = [];
  const params = [userId, userId];
  if (!admin) {
    where.push(`g.id IN (SELECT group_id FROM chat_group_members WHERE user_id = ? AND removed_at IS NULL)`);
    params.push(userId);
  }
  if (!includeArchived) where.push('g.archived = FALSE');

  const rows = await db.queryAll(
    `SELECT g.*,
            cu.first_name AS client_first, cu.last_name AS client_last,
            cu.email AS client_email, cu.profile_picture AS client_avatar,
            me.last_read_seq, me.muted, me.group_role AS my_group_role,
            (SELECT COUNT(*) FROM chat_group_members mm
              WHERE mm.group_id = g.id AND mm.removed_at IS NULL) AS member_count,
            (SELECT COUNT(*) FROM chat_messages cm
              WHERE cm.group_id = g.id
                AND cm.seq > COALESCE(me.last_read_seq, 0)
                AND cm.sender_id IS DISTINCT FROM ?
                AND cm.deleted_at IS NULL) AS unread_count,
            lm.body AS last_body, lm.kind AS last_kind, lm.seq AS last_seq,
            lm.created_at AS last_at, lm.deleted_at AS last_deleted,
            lu.first_name AS last_first, lu.last_name AS last_last, lu.email AS last_email,
            lm.sender_group_role AS last_role
     FROM chat_groups g
     LEFT JOIN users cu ON cu.id = g.client_id
     LEFT JOIN chat_group_members me ON me.group_id = g.id AND me.user_id = ? AND me.removed_at IS NULL
     LEFT JOIN LATERAL (
       SELECT * FROM chat_messages x WHERE x.group_id = g.id ORDER BY x.seq DESC LIMIT 1
     ) lm ON TRUE
     LEFT JOIN users lu ON lu.id = lm.sender_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY COALESCE(g.last_message_at, g.created_at) DESC`,
    params
  );

  return rows.map(r => {
    const isMember = r.my_group_role != null;
    let preview = '';
    if (r.last_seq) {
      if (r.last_deleted) preview = 'This message was deleted';
      else if (r.last_kind === 'image') preview = '📷 Photo';
      else if (r.last_kind === 'audio') preview = '🎤 Voice note';
      else if (r.last_kind === 'file') preview = '📎 Attachment';
      else if (r.last_kind === 'system') preview = String(r.last_body || '');
      else preview = String(r.last_body || '');
    }
    const lastSenderName = r.last_seq
      ? (r.last_email || r.last_first || r.last_last
          ? displayName({ first_name: r.last_first, last_name: r.last_last, email: r.last_email })
          : 'BodyBank')
      : '';
    return {
      id: r.id,
      name: r.name,
      type: 'group',
      clientId: r.client_id,
      clientName: displayName({ first_name: r.client_first, last_name: r.client_last, email: r.client_email }),
      clientAvatar: r.client_avatar || '',
      avatarUrl: r.avatar_url || '',
      archived: !!r.archived,
      memberCount: Number(r.member_count || 0),
      createdAt: r.created_at,
      lastMessageAt: r.last_message_at || r.created_at,
      lastSeq: Number(r.last_seq || 0),
      lastPreview: preview,
      lastSenderName,
      lastSenderRoleLabel: GROUP_ROLE_LABELS[r.last_role] || '',
      lastKind: r.last_deleted ? 'deleted' : (r.last_kind || ''),
      isMember,
      myGroupRole: r.my_group_role || '',
      muted: !!r.muted,
      // A non-member admin has no read cursor; reporting their unread as the
      // whole transcript would light every group up permanently.
      unread: isMember ? Number(r.unread_count || 0) : 0
    };
  });
}

/**
 * Active 1-to-1 threads for the inbox.
 *
 * `JOIN LATERAL` (not LEFT JOIN) is doing real work here: it drops any thread
 * that has no messages, which is exactly what the admin asked for — the inbox
 * should list people they have actually talked to, not every client who happens
 * to have an empty thread row. A member always gets their own thread back, even
 * empty, because it is how they start the conversation.
 *
 * One query, no per-row subselects, ordered by the newest message.
 */
async function listDirectThreads(db, user, opts = {}) {
  const admin = isAdminRole(user && user.role);
  const userId = String((user && user.id) || '');
  const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 100));

  // Staff see only threads with a PERSONAL message — something the client wrote
  // or a person on the team typed. Campaign nudges do not count, so a client who
  // has only ever received automated check-ins does not appear. The member sees
  // their own thread including nudges: those are real messages to them.
  // `m.is_automated = FALSE` matches the partial index's predicate exactly.
  const rows = await db.queryAll(
    `SELECT t.id, t.user_id, t.created_at, t.updated_at,
            u.first_name, u.last_name, u.email, u.profile_picture,
            lm.body AS last_body, lm.created_at AS last_at, lm.sender_role AS last_role
     FROM message_threads t
     JOIN users u ON u.id = t.user_id
     JOIN LATERAL (
       SELECT m.body, m.created_at, m.sender_role
       FROM thread_messages m
       WHERE m.thread_id = t.id ${admin ? 'AND m.is_automated = FALSE' : ''}
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON TRUE
     ${admin ? '' : 'WHERE t.user_id = ?'}
     ORDER BY lm.created_at DESC
     LIMIT ?`,
    admin ? [limit] : [userId, limit]
  );

  return rows.map(r => {
    const clientName = displayName(r);
    const fromStaff = r.last_role === 'admin' || r.last_role === 'superadmin';
    return {
      id: 'dm:' + r.id,
      threadId: r.id,
      type: 'direct',
      // The member always sees their coach; the admin sees the client.
      name: admin ? clientName : 'Lifestyle Manager',
      clientName,
      clientId: r.user_id,
      clientAvatar: admin ? (r.profile_picture || '') : '',
      avatarUrl: admin ? (r.profile_picture || '') : '',
      subtitle: admin ? 'Client · private chat' : 'Private · just you and your coach',
      email: admin ? (r.email || '') : '',
      lastPreview: r.last_body || '',
      lastFromStaff: fromStaff,
      lastSenderName: '',
      lastMessageAt: r.last_at || r.updated_at || r.created_at,
      memberCount: 2,
      unread: 0,
      muted: false,
      archived: false
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1-TO-1 THREADS — paged reads
// ════════════════════════════════════════════════════════════════════════════
//
// The legacy GET /api/threads/:id/messages returns the WHOLE transcript. Months
// of campaign nudges make that hundreds of rows, and the client re-fetched it
// on every open and every poll. These readers page it and stream only what is
// new. thread_messages has no sequence column, so the cursor is
// (created_at, id), carried as the column's exact text rendering — a JS Date
// would drop the microseconds and shift TIMESTAMP WITHOUT TIME ZONE by the
// server's local offset.

const DM_CURSOR_SQL = `to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const DM_COLS = `m.id, m.thread_id, m.sender_id, m.sender_role, m.body, m.created_at,
                 m.is_automated, ${DM_CURSOR_SQL} AS cur`;

/** Validate a cursor from the client: exact text we produced, and a message id. */
function dmCursor(ts, id) {
  const t = String(ts == null ? '' : ts);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(t)) return null;
  return { ts: t, id: String(id == null ? '' : id) };
}

/**
 * Serialise a thread message. `automated` is a STAFF-only field: a member sees
 * nudges exactly as before, as ordinary Lifestyle Manager messages.
 */
function serializeDm(r, staff) {
  const out = {
    id: r.id,
    threadId: r.thread_id,
    sender_id: r.sender_id,
    sender_role: r.sender_role,
    body: r.body || '',
    created_at: r.created_at,
    cursor: r.cur
  };
  if (staff) out.automated = !!r.is_automated;
  return out;
}

/**
 * The thread plus the caller's right to read it, in one query. Mirrors the
 * legacy rule exactly: admins and superadmins read any thread, anyone else
 * only their own.
 */
async function resolveThread(db, threadId, user) {
  const t = await db.queryOne(
    `SELECT t.id, t.user_id, u.first_name, u.last_name, u.email, u.profile_picture
     FROM message_threads t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.id = ?`,
    [String(threadId || '')]
  );
  if (!t) return { found: false, ok: false };
  const staff = isAdminRole(user && user.role);
  return {
    found: true,
    ok: staff || String(t.user_id) === String((user && user.id) || ''),
    staff,
    thread: t
  };
}

/** The newest page of a thread (or the page before `before`), oldest-first. */
async function loadDmPage(db, threadId, opts = {}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(opts.limit, 10) || DEFAULT_PAGE_SIZE));
  const before = opts.before ? dmCursor(opts.before.ts, opts.before.id) : null;
  const rows = await db.queryAll(
    `SELECT ${DM_COLS} FROM thread_messages m
     WHERE m.thread_id = ?
       ${before ? 'AND (m.created_at, m.id) < (?::timestamp, ?)' : ''}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?`,
    before ? [threadId, before.ts, before.id, limit + 1] : [threadId, limit + 1]
  );
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  rows.reverse();
  return { messages: rows.map(r => serializeDm(r, !!opts.staff)), hasMore };
}

/**
 * Messages after the cursor — the live poll. ONE query, with the access rule
 * inside it: a caller who may not read the thread simply gets nothing back.
 * Placeholders in TEXT order: thread id, caller id, staff flag, cursor ts, id.
 */
async function loadDmSince(db, threadId, user, after) {
  const cur = dmCursor(after && after.ts, after && after.id);
  if (!cur) return [];
  const staff = isAdminRole(user && user.role);
  const rows = await db.queryAll(
    `SELECT ${DM_COLS} FROM thread_messages m
     JOIN message_threads t ON t.id = m.thread_id
     WHERE m.thread_id = ?
       AND (t.user_id = ? OR ?::boolean)
       AND (m.created_at, m.id) > (?::timestamp, ?)
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT ?`,
    [String(threadId || ''), String((user && user.id) || ''), staff, cur.ts, cur.id, MAX_PAGE_SIZE]
  );
  return rows.map(r => serializeDm(r, staff));
}

/**
 * Insert a message and move the group's activity clock.
 *
 * `senderGroupRole` is snapshotted onto the row so an old message keeps showing
 * the role its author held at the time — re-labelling someone from Doctor to
 * Lifestyle Manager must not rewrite history.
 */
async function insertMessageFull(db, { groupId, senderId, senderGroupRole, body, kind, replyToId }) {
  const id = uuidv4();
  // ONE statement: insert the message, move the group's activity clock and bump
  // its revision, returning the assigned seq. It used to be an INSERT, an UPDATE
  // and then a separate SELECT MAX(seq) to find out what had just been written.
  const row = await db.queryOne(
    `WITH ins AS (
       INSERT INTO chat_messages (id, group_id, sender_id, sender_group_role, kind, body, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, seq, created_at
     ), upd AS (
       UPDATE chat_groups
          SET last_message_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP,
              rev = COALESCE(rev, 0) + 1
        WHERE id = ?
       RETURNING rev
     )
     SELECT ins.id, ins.seq, ins.created_at, upd.rev FROM ins LEFT JOIN upd ON TRUE`,
    [id, groupId, senderId || null, senderGroupRole || '', kind || 'text', clampBody(body), replyToId || null, groupId]
  );
  return {
    id,
    seq: Number((row && row.seq) || 0),
    createdAt: row ? row.created_at : new Date().toISOString(),
    rev: Number((row && row.rev) || 0)
  };
}

/** Back-compatible wrapper: callers that only need the new message's id. */
async function insertMessage(db, fields) {
  return (await insertMessageFull(db, fields)).id;
}

/**
 * Bump a group's revision so open chats pick up a change that did not insert a
 * message (edit, delete, reaction, avatar). Never throws into the caller.
 */
async function bumpRev(db, groupId) {
  try {
    await db.run(
      'UPDATE chat_groups SET rev = COALESCE(rev, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [groupId]
    );
  } catch (e) { /* a missed bump only delays a UI refresh to the next change */ }
}

/**
 * Mutable state (body, edit/delete marks, reactions) of the newest messages,
 * reactions included — one query. A poll that saw a `rev` change reconciles
 * edits, deletes and reactions on already-rendered messages from this.
 */
async function recentState(db, groupId, viewerId, limit) {
  const rows = await db.queryAll(
    `SELECT m.id, m.seq, m.body, m.kind, m.edited_at, m.deleted_at, rx.reactions AS rx_reactions
     FROM chat_messages m
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
                'emoji', r.emoji, 'user_id', r.user_id,
                'first_name', ru.first_name, 'last_name', ru.last_name, 'email', ru.email
              ) ORDER BY r.created_at) AS reactions
       FROM chat_message_reactions r
       LEFT JOIN users ru ON ru.id = r.user_id
       WHERE r.message_id = m.id
     ) rx ON TRUE
     WHERE m.group_id = ?
     ORDER BY m.seq DESC
     LIMIT ?`,
    [groupId, limit || RECENT_STATE_WINDOW]
  );
  return rows.map(x => ({
    id: x.id,
    seq: Number(x.seq),
    body: x.deleted_at ? '' : (x.body || ''),
    kind: x.deleted_at ? 'deleted' : (x.kind || 'text'),
    editedAt: x.edited_at || null,
    deleted: !!x.deleted_at,
    reactions: x.deleted_at ? [] : foldReactions(asJson(x.rx_reactions), viewerId)
  }));
}

/**
 * Everything a poll needs to decide whether anything happened — in ONE query,
 * including the access check. When the caller's `rev` and `since` both match,
 * the route answers from this alone.
 *
 * Placeholders in TEXT order: m.user_id, g.id.
 */
async function pollState(db, groupId, user) {
  const uid = String((user && user.id) || '');
  const row = await db.queryOne(
    `SELECT g.id, g.archived, COALESCE(g.rev, 0) AS rev,
            (m.id IS NOT NULL) AS is_member,
            (SELECT COALESCE(MAX(x.seq), 0) FROM chat_messages x WHERE x.group_id = g.id) AS max_seq,
            (SELECT COALESCE(json_agg(json_build_object('userId', r.user_id, 'lastReadSeq', r.last_read_seq)), '[]'::json)
               FROM chat_group_members r
              WHERE r.group_id = g.id AND r.removed_at IS NULL) AS readers
     FROM chat_groups g
     LEFT JOIN chat_group_members m
            ON m.group_id = g.id AND m.user_id = ? AND m.removed_at IS NULL
     WHERE g.id = ?`,
    [uid, String(groupId || '')]
  );
  if (!row) return { found: false, ok: false };
  const admin = isAdminRole(user && user.role);
  let readers = row.readers;
  if (typeof readers === 'string') { try { readers = JSON.parse(readers); } catch (e) { readers = []; } }
  return {
    found: true,
    ok: admin || !!row.is_member,
    archived: !!row.archived,
    rev: Number(row.rev || 0),
    maxSeq: Number(row.max_seq || 0),
    readers: (readers || []).map(r => ({ userId: r.userId, lastReadSeq: Number(r.lastReadSeq || 0) }))
  };
}

/** Append a system line ("X added Y", "renamed to …") to the transcript. */
async function insertSystemMessage(db, groupId, text) {
  return insertMessage(db, { groupId, senderId: null, senderGroupRole: '', body: text, kind: 'system', replyToId: null });
}

/** Write an audit row. Never throws into the caller's path. */
async function audit(db, { groupId, actor, action, detail }) {
  try {
    await db.run(
      `INSERT INTO chat_group_audit (id, group_id, actor_id, actor_name, action, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), groupId || null, (actor && actor.id) || null, (actor && actor.name) || '', String(action || ''), String(detail || '').slice(0, 1000)]
    );
  } catch (e) { /* auditing must never break the action it records */ }
}

/**
 * Advance a member's read cursor. Monotonic — a late-arriving poll carrying an
 * older seq must never walk the cursor backwards and resurrect read messages.
 */
async function markRead(db, groupId, userId, seq) {
  const n = Number(seq);
  if (!Number.isFinite(n) || n < 0) return;
  await db.run(
    `UPDATE chat_group_members SET last_read_seq = ?
     WHERE group_id = ? AND user_id = ? AND removed_at IS NULL AND last_read_seq < ?`,
    [String(Math.floor(n)), groupId, userId, String(Math.floor(n))]
  );
}

module.exports = {
  GROUP_ROLES,
  GROUP_ROLE_LABELS,
  ALLOWED_REACTIONS,
  GROUP_NAME_SUFFIX,
  MAX_BODY_CHARS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RECENT_STATE_WINDOW,
  EDIT_WINDOW_MS,
  ensureGroupChatTables,
  resolveAccess,
  listMembers,
  listGroupsForUser,
  listDirectThreads,
  resolveThread,
  loadDmPage,
  loadDmSince,
  dmCursor,
  ensureAutomatedFlag,
  loadMessages,
  loadNewestPage,
  hydrateRows,
  insertMessageFull,
  bumpRev,
  pollState,
  recentState,
  foldReactions,
  groupMaxSeq,
  reactionsForMessages,
  attachmentsForMessages,
  serializeMessage,
  insertMessage,
  insertSystemMessage,
  audit,
  markRead,
  buildGroupName,
  normalizeGroupRole,
  displayName,
  isAdminRole,
  clampBody
};
