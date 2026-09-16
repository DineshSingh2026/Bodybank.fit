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

  return { ok: true };
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
  const group = await db.queryOne('SELECT * FROM chat_groups WHERE id = ?', [String(groupId || '')]);
  if (!group) return { ok: false, group: null, membership: null, isAdmin: false, canPost: false, canManage: false };
  const admin = isAdminRole(user && user.role);
  const membership = await db.queryOne(
    'SELECT * FROM chat_group_members WHERE group_id = ? AND user_id = ? AND removed_at IS NULL',
    [group.id, String((user && user.id) || '')]
  );
  const ok = admin || !!membership;
  return {
    ok,
    group,
    membership: membership || null,
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

/** Attachment rows for a set of message ids, keyed by message id. */
async function attachmentsForMessages(db, messageIds) {
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
    (out[r.message_id] = out[r.message_id] || []).push({
      id: r.id,
      name: r.original_name || 'Attachment',
      mimeType: r.mime_type || '',
      size: Number(r.size_bytes || 0),
      isImage: String(r.mime_type || '').startsWith('image/'),
      // Always an authenticated route — never a /uploads URL. The uploads mount
      // is public, so a direct path would make every chat attachment readable
      // by anyone who guessed or was forwarded the link.
      url: '/api/groups/attachments/' + r.id
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
async function loadMessages(db, groupId, opts = {}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(opts.limit, 10) || DEFAULT_PAGE_SIZE));
  const viewerId = opts.viewerId;
  const cols = `m.id, m.seq, m.group_id, m.sender_id, m.sender_group_role, m.kind, m.body,
                m.reply_to_id, m.edited_at, m.deleted_at, m.created_at,
                u.first_name, u.last_name, u.email, u.profile_picture`;

  let rows;
  if (opts.since != null) {
    rows = await db.queryAll(
      `SELECT ${cols} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`,
      [groupId, String(opts.since), limit]
    );
  } else if (opts.before != null) {
    rows = await db.queryAll(
      `SELECT ${cols} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
      [groupId, String(opts.before), limit]
    );
    rows.reverse();
  } else {
    rows = await db.queryAll(
      `SELECT ${cols} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? ORDER BY m.seq DESC LIMIT ?`,
      [groupId, limit]
    );
    rows.reverse();
  }
  if (rows.length === 0) return [];

  const ids = rows.map(r => r.id);
  const replyIds = [...new Set(rows.map(r => r.reply_to_id).filter(Boolean))];
  const [reactions, attachments, replyRows] = await Promise.all([
    reactionsForMessages(db, ids, viewerId),
    attachmentsForMessages(db, ids),
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
 * Insert a message and move the group's activity clock.
 *
 * `senderGroupRole` is snapshotted onto the row so an old message keeps showing
 * the role its author held at the time — re-labelling someone from Doctor to
 * Lifestyle Manager must not rewrite history.
 */
async function insertMessage(db, { groupId, senderId, senderGroupRole, body, kind, replyToId }) {
  const id = uuidv4();
  await db.run(
    `INSERT INTO chat_messages (id, group_id, sender_id, sender_group_role, kind, body, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, groupId, senderId || null, senderGroupRole || '', kind || 'text', clampBody(body), replyToId || null]
  );
  await db.run(
    'UPDATE chat_groups SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [groupId]
  );
  return id;
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
  loadMessages,
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
