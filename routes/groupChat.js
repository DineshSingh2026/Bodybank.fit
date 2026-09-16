'use strict';

/**
 * BodyBank — Care Group chat API.
 *
 * Mounted at /api/groups. Every route is authenticated and every route that
 * touches a group resolves access through groupChatService.resolveAccess()
 * first, so there is no path by which one client reaches another client's care
 * group. See services/groupChatService.js for the identity and cursor model.
 *
 * Route ordering note: the literal /attachments/:attachmentId route is declared
 * BEFORE the parameterised /:id routes. Express matches in declaration order,
 * so a later declaration would be shadowed by /:id with id === 'attachments'.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const svc = require('../services/groupChatService');

const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/**
 * Attachment types accepted from the composer, mapped to the extension we store
 * under. An allowlist, not a blocklist: the stored extension comes from this
 * table and never from the client's filename, so a `report.pdf.html` upload
 * cannot land as servable HTML.
 */
const ALLOWED_ATTACHMENT_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
};

function safeOriginalName(name) {
  return String(name || 'attachment')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 180) || 'attachment';
}

/**
 * @param {object} deps
 * @param {function} deps.run            parameterised write  (`?` placeholders)
 * @param {function} deps.queryOne
 * @param {function} deps.queryAll
 * @param {function} deps.verifyToken    JWT middleware
 * @param {function} deps.requireAdminOrSuperadmin
 * @param {function} deps.rateLimiter    (limit, windowMs) => middleware
 * @param {object}   deps.multer         multer module, or null when unavailable
 * @param {string}   deps.uploadsDir     root uploads directory
 * @param {function} [deps.sendPushToUser]
 * @param {function} [deps.notifyAgent]
 */
function createGroupChatRouter(deps) {
  const {
    run, queryOne, queryAll,
    verifyToken, requireAdminOrSuperadmin, rateLimiter,
    multer, uploadsDir,
    sendPushToUser, notifyAgent
  } = deps;

  const db = { run, queryOne, queryAll };
  const router = express.Router();

  // Attachments live in their own directory, and server.js 404s it off the public
  // /uploads static mount. They are reachable ONLY through the membership-checked
  // download route below.
  const ATTACH_DIR = path.join(uploadsDir, 'group-chat');

  const upload = multer
    ? multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } })
    : null;
  const singleFile = upload
    ? upload.single('file')
    : (req, _res, next) => next();

  // ── helpers ────────────────────────────────────────────────────────────────

  const fail = (res, code, error) => res.status(code).json({ error });

  /** Load the actor's display name once per mutating request, for audit rows. */
  async function actorOf(req) {
    const u = await queryOne('SELECT id, first_name, last_name, email FROM users WHERE id = ?', [req.user.id]).catch(() => null);
    return { id: req.user.id, name: svc.displayName(u) };
  }

  /**
   * Gate every /:id route. Attaches req.access and 403s anyone who is neither an
   * admin nor a live member. A missing group is reported as 404 to a member and
   * as 404 to everyone else too — there is nothing to leak either way, since the
   * id is a uuid.
   */
  async function withAccess(req, res, next) {
    try {
      const access = await svc.resolveAccess(db, req.params.id, req.user);
      if (!access.group) return fail(res, 404, 'Group not found');
      if (!access.ok) return fail(res, 403, 'You are not a member of this group');
      req.access = access;
      next();
    } catch (e) {
      console.error('[groupChat access]', e.message);
      fail(res, 500, 'Failed to open group');
    }
  }

  const requireManage = (req, res, next) =>
    req.access && req.access.canManage ? next() : fail(res, 403, 'Admin access required');

  /**
   * Fan a new message out to everyone else in the group as a push notification,
   * honouring each member's mute flag. Never throws into the send path — a push
   * provider outage must not fail the message that was already stored.
   */
  async function notifyGroup(group, members, senderId, senderName, preview) {
    if (typeof sendPushToUser !== 'function') return;
    const payload = JSON.stringify({
      type: 'group_message',
      title: group.name,
      body: senderName + ': ' + String(preview || '').slice(0, 90),
      id: 'group-' + group.id,
      url: '/?group=' + group.id
    });
    for (const m of members) {
      if (String(m.userId) === String(senderId)) continue;
      if (m.muted) continue;
      sendPushToUser(m.userId, payload).catch(() => {});
    }
  }

  // ══ ATTACHMENT DOWNLOAD ═══════════════════════════════════════════════════
  // Declared first so /:id never shadows it. The membership check is the whole
  // point of this route: /uploads is a public static mount, so an attachment
  // served from there would be readable by anyone holding the URL.
  router.get('/attachments/:attachmentId', verifyToken, async (req, res) => {
    try {
      const att = await queryOne(
        'SELECT * FROM chat_message_attachments WHERE id = ?',
        [String(req.params.attachmentId || '')]
      );
      if (!att) return fail(res, 404, 'Attachment not found');
      const access = await svc.resolveAccess(db, att.group_id, req.user);
      if (!access.ok) return fail(res, 403, 'Access denied');

      // Re-resolve under the attachments root and confirm containment, so a
      // traversal sequence that ever reached the column cannot escape it.
      const abs = path.resolve(ATTACH_DIR, att.file_path);
      if (abs !== ATTACH_DIR && !abs.startsWith(ATTACH_DIR + path.sep)) return fail(res, 404, 'Attachment not found');
      if (!fs.existsSync(abs)) return fail(res, 404, 'File is no longer available');

      res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=300');
      // Images render inline in a bubble; everything else downloads.
      const inline = String(att.mime_type || '').startsWith('image/');
      const name = safeOriginalName(att.original_name).replace(/"/g, '');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      console.error('[groupChat attachment]', e.message);
      fail(res, 500, 'Failed to load attachment');
    }
  });

  // ══ CONVERSATION LIST ═════════════════════════════════════════════════════
  router.get('/', verifyToken, async (req, res) => {
    try {
      const groups = await svc.listGroupsForUser(db, req.user, {
        includeArchived: String(req.query.archived || '') === '1'
      });
      res.json({ groups });
    } catch (e) {
      console.error('[groupChat list]', e.message);
      fail(res, 500, 'Failed to load conversations');
    }
  });

  // ══ MEMBER CANDIDATES (admin group builder) ═══════════════════════════════
  // Clients to own a group, and every account that can fill a care-team slot.
  router.get('/candidates', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const [clients, staff] = await Promise.all([
        queryAll(
          `SELECT id, first_name, last_name, email, profile_picture, role
           FROM users WHERE role = 'user' AND COALESCE(suspended, FALSE) = FALSE
           ORDER BY first_name ASC, last_name ASC`
        ),
        queryAll(
          `SELECT id, first_name, last_name, email, profile_picture, role
           FROM users WHERE role IN ('admin','superadmin','operator')
             AND COALESCE(suspended, FALSE) = FALSE
           ORDER BY first_name ASC, last_name ASC`
        )
      ]);
      const shape = u => ({
        id: u.id,
        name: svc.displayName(u),
        email: u.email || '',
        avatar: u.profile_picture || '',
        accountRole: u.role || ''
      });
      // Existing client groups, so the builder can warn before making a duplicate.
      const existing = await queryAll(
        'SELECT id, name, client_id, archived FROM chat_groups'
      );
      res.json({
        clients: clients.map(shape),
        // Staff can fill any slot; a client account can be a care-team member of
        // someone else's group too (rare, but the admin decides — not us).
        staff: staff.map(shape),
        roles: svc.GROUP_ROLES.map(r => ({ value: r, label: svc.GROUP_ROLE_LABELS[r] })),
        existingByClient: existing.reduce((acc, g) => {
          (acc[g.client_id] = acc[g.client_id] || []).push({ id: g.id, name: g.name, archived: !!g.archived });
          return acc;
        }, {})
      });
    } catch (e) {
      console.error('[groupChat candidates]', e.message);
      fail(res, 500, 'Failed to load people');
    }
  });

  // ══ CREATE GROUP (admin) ══════════════════════════════════════════════════
  router.post('/', verifyToken, requireAdminOrSuperadmin, rateLimiter(20, 60000), async (req, res) => {
    try {
      const { client_id: clientId, members, name: nameOverride, force } = req.body || {};
      if (!clientId) return fail(res, 400, 'Select a client for this group');

      const client = await queryOne(
        'SELECT id, first_name, last_name, email, profile_picture FROM users WHERE id = ?',
        [String(clientId)]
      );
      if (!client) return fail(res, 400, 'That client no longer exists');

      // Duplicate guard. The spec forbids silently creating a second care group
      // for a client, but an admin who genuinely wants one can pass force.
      if (!force) {
        const dupe = await queryOne(
          'SELECT id, name FROM chat_groups WHERE client_id = ? AND archived = FALSE LIMIT 1',
          [client.id]
        );
        if (dupe) {
          return res.status(409).json({
            error: 'This client already has an active care group.',
            existing: { id: dupe.id, name: dupe.name },
            hint: 'Open the existing group, or re-submit with force to create a second one.'
          });
        }
      }

      const name = String(nameOverride || '').trim() || svc.buildGroupName(client);
      const groupId = uuidv4();
      await run(
        'INSERT INTO chat_groups (id, name, client_id, created_by) VALUES (?, ?, ?, ?)',
        [groupId, name.slice(0, 160), client.id, req.user.id]
      );

      // The client always holds the `client` slot, whatever the request said.
      const requested = Array.isArray(members) ? members : [];
      const seen = new Set();
      const toAdd = [{ user_id: client.id, group_role: 'client' }];
      seen.add(String(client.id));
      for (const m of requested) {
        const uid = String((m && m.user_id) || '');
        const role = svc.normalizeGroupRole(m && m.group_role);
        if (!uid || !role || seen.has(uid)) continue;
        // Only the group's own client may hold the client slot.
        if (role === 'client' && uid !== String(client.id)) continue;
        seen.add(uid);
        toAdd.push({ user_id: uid, group_role: role });
      }

      const valid = await queryAll(
        `SELECT id FROM users WHERE id IN (${toAdd.map(() => '?').join(',')})`,
        toAdd.map(m => m.user_id)
      );
      const validIds = new Set(valid.map(v => String(v.id)));
      for (const m of toAdd) {
        if (!validIds.has(String(m.user_id))) continue;
        await run(
          `INSERT INTO chat_group_members (id, group_id, user_id, group_role)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (group_id, user_id)
           DO UPDATE SET group_role = EXCLUDED.group_role, removed_at = NULL`,
          [uuidv4(), groupId, m.user_id, m.group_role]
        );
      }

      const actor = await actorOf(req);
      await svc.insertSystemMessage(db, groupId, `${actor.name} created this care group`);
      await svc.audit(db, { groupId, actor, action: 'group_created', detail: name });
      if (typeof notifyAgent === 'function') {
        // notifyAgent is synchronous fire-and-forget and swallows its own errors —
        // it returns undefined, so it must not be chained with .catch().
        notifyAgent('GROUP_CREATED', { groupId, name, clientId: client.id });
      }

      const memberList = await svc.listMembers(db, groupId);
      await notifyGroup(
        { id: groupId, name },
        memberList,
        req.user.id,
        'BodyBank',
        'You were added to ' + name
      );

      const group = await queryOne('SELECT * FROM chat_groups WHERE id = ?', [groupId]);
      res.status(201).json({ group, members: memberList });
    } catch (e) {
      console.error('[groupChat create]', e.message);
      fail(res, 500, 'Failed to create group');
    }
  });

  // ══ GROUP DETAIL ══════════════════════════════════════════════════════════
  router.get('/:id', verifyToken, withAccess, async (req, res) => {
    try {
      const { group, membership, isAdmin } = req.access;
      const [members, client, maxSeq] = await Promise.all([
        svc.listMembers(db, group.id),
        queryOne('SELECT id, first_name, last_name, email, profile_picture FROM users WHERE id = ?', [group.client_id]),
        svc.groupMaxSeq(db, group.id)
      ]);
      res.json({
        group: {
          id: group.id,
          name: group.name,
          clientId: group.client_id,
          clientName: svc.displayName(client),
          clientAvatar: (client && client.profile_picture) || '',
          avatarUrl: group.avatar_url || '',
          archived: !!group.archived,
          createdAt: group.created_at,
          lastMessageAt: group.last_message_at,
          memberCount: members.length
        },
        members,
        me: {
          userId: req.user.id,
          isAdmin,
          isMember: !!membership,
          groupRole: (membership && membership.group_role) || (isAdmin ? 'admin' : ''),
          muted: !!(membership && membership.muted),
          lastReadSeq: Number((membership && membership.last_read_seq) || 0),
          canPost: req.access.canPost,
          canManage: req.access.canManage
        },
        maxSeq,
        reactionChoices: svc.ALLOWED_REACTIONS
      });
    } catch (e) {
      console.error('[groupChat detail]', e.message);
      fail(res, 500, 'Failed to load group');
    }
  });

  // ══ UPDATE GROUP (rename / avatar / archive) ══════════════════════════════
  router.patch('/:id', verifyToken, withAccess, requireManage, async (req, res) => {
    try {
      const { group } = req.access;
      const actor = await actorOf(req);
      const sets = [];
      const params = [];
      const notes = [];

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
        const name = String(req.body.name || '').trim().slice(0, 160);
        if (!name) return fail(res, 400, 'Group name cannot be empty');
        if (name !== group.name) {
          sets.push('name = ?'); params.push(name);
          notes.push(`${actor.name} renamed the group to "${name}"`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'avatar_url')) {
        sets.push('avatar_url = ?'); params.push(String(req.body.avatar_url || '').trim().slice(0, 500));
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'archived')) {
        const archived = !!req.body.archived;
        if (archived !== !!group.archived) {
          sets.push('archived = ?'); params.push(archived);
          notes.push(`${actor.name} ${archived ? 'archived' : 'reopened'} this group`);
        }
      }
      if (!sets.length) return res.json({ ok: true, unchanged: true });

      sets.push('updated_at = CURRENT_TIMESTAMP');
      params.push(group.id);
      await run(`UPDATE chat_groups SET ${sets.join(', ')} WHERE id = ?`, params);
      for (const n of notes) await svc.insertSystemMessage(db, group.id, n);
      await svc.audit(db, { groupId: group.id, actor, action: 'group_updated', detail: notes.join(' | ') || 'metadata' });

      const updated = await queryOne('SELECT * FROM chat_groups WHERE id = ?', [group.id]);
      res.json({ ok: true, group: updated });
    } catch (e) {
      console.error('[groupChat update]', e.message);
      fail(res, 500, 'Failed to update group');
    }
  });

  // ══ MESSAGE HISTORY (lazy-loaded backwards) ═══════════════════════════════
  router.get('/:id/messages', verifyToken, withAccess, async (req, res) => {
    try {
      const before = req.query.before != null && req.query.before !== '' ? req.query.before : null;
      const messages = await svc.loadMessages(db, req.access.group.id, {
        viewerId: req.user.id,
        before,
        limit: req.query.limit
      });
      const maxSeq = await svc.groupMaxSeq(db, req.access.group.id);
      // `hasMore` asks whether anything exists below the oldest row we returned.
      let hasMore = false;
      if (messages.length) {
        const older = await queryOne(
          'SELECT 1 AS x FROM chat_messages WHERE group_id = ? AND seq < ? LIMIT 1',
          [req.access.group.id, String(messages[0].seq)]
        );
        hasMore = !!older;
      }
      res.json({ messages, maxSeq, hasMore });
    } catch (e) {
      console.error('[groupChat messages]', e.message);
      fail(res, 500, 'Failed to load messages');
    }
  });

  // ══ LIVE POLL ═════════════════════════════════════════════════════════════
  // New messages arrive on the `since` cursor. Edits, deletes and reactions move
  // no cursor, so a bounded window of the newest messages is re-read each poll
  // and returned as `recent`; the client reconciles those in place.
  router.get('/:id/updates', verifyToken, withAccess, async (req, res) => {
    try {
      const groupId = req.access.group.id;
      const since = req.query.since != null && req.query.since !== '' ? req.query.since : '0';
      const messages = await svc.loadMessages(db, groupId, { viewerId: req.user.id, since, limit: svc.MAX_PAGE_SIZE });

      const recentRows = await queryAll(
        `SELECT id, seq, body, kind, edited_at, deleted_at
         FROM chat_messages WHERE group_id = ? ORDER BY seq DESC LIMIT ?`,
        [groupId, svc.RECENT_STATE_WINDOW]
      );
      const recentIds = recentRows.map(r => r.id);
      const reactions = await svc.reactionsForMessages(db, recentIds, req.user.id);
      const recent = recentRows.map(r => ({
        id: r.id,
        seq: Number(r.seq),
        body: r.deleted_at ? '' : (r.body || ''),
        kind: r.deleted_at ? 'deleted' : (r.kind || 'text'),
        editedAt: r.edited_at || null,
        deleted: !!r.deleted_at,
        reactions: reactions[r.id] || []
      }));

      const members = await svc.listMembers(db, groupId);
      const maxSeq = await svc.groupMaxSeq(db, groupId);
      res.json({
        maxSeq,
        messages,
        recent,
        // Read receipts: the cursor each member has reached. The client turns
        // this into ticks by comparing against each of its own message seqs.
        readers: members.map(m => ({ userId: m.userId, name: m.name, lastReadSeq: m.lastReadSeq })),
        memberCount: members.length
      });
    } catch (e) {
      console.error('[groupChat updates]', e.message);
      fail(res, 500, 'Failed to sync');
    }
  });

  // ══ SEND MESSAGE ══════════════════════════════════════════════════════════
  router.post('/:id/messages', verifyToken, withAccess, rateLimiter(60, 60000), async (req, res) => {
    try {
      const { group, membership, isAdmin, canPost } = req.access;
      if (!canPost) return fail(res, 403, 'This group is archived and read-only');
      const body = svc.clampBody((req.body || {}).body);
      const replyToId = String((req.body || {}).reply_to_id || '') || null;
      if (!body) return fail(res, 400, 'Message cannot be empty');

      // A reply must point at a message in THIS group — otherwise a crafted
      // reply_to_id would quote text out of a group the sender cannot read.
      if (replyToId) {
        const parent = await queryOne('SELECT id FROM chat_messages WHERE id = ? AND group_id = ?', [replyToId, group.id]);
        if (!parent) return fail(res, 400, 'The message you replied to is no longer available');
      }

      const senderRole = (membership && membership.group_role) || (isAdmin ? 'admin' : '');
      const msgId = await svc.insertMessage(db, {
        groupId: group.id, senderId: req.user.id, senderGroupRole: senderRole, body, kind: 'text', replyToId
      });

      // Sending is an implicit read of everything before it.
      const maxSeq = await svc.groupMaxSeq(db, group.id);
      await svc.markRead(db, group.id, req.user.id, maxSeq);

      const [message] = await svc.loadMessages(db, group.id, { viewerId: req.user.id, since: String(Number(maxSeq) - 1), limit: 1 });
      const members = await svc.listMembers(db, group.id);
      const me = members.find(m => String(m.userId) === String(req.user.id));
      await notifyGroup(group, members, req.user.id, (me && me.name) || 'BodyBank', body);

      res.status(201).json({ message: message || { id: msgId }, maxSeq });
    } catch (e) {
      console.error('[groupChat send]', e.message);
      fail(res, 500, 'Failed to send message');
    }
  });

  // ══ SEND ATTACHMENT ═══════════════════════════════════════════════════════
  router.post('/:id/attachments', verifyToken, withAccess, rateLimiter(20, 60000), singleFile, async (req, res) => {
    try {
      if (!multer) return fail(res, 503, 'File uploads are unavailable on this server');
      const { group, membership, isAdmin, canPost } = req.access;
      if (!canPost) return fail(res, 403, 'This group is archived and read-only');
      if (!req.file || !req.file.buffer || !req.file.buffer.length) return fail(res, 400, 'No file received');

      const mime = String(req.file.mimetype || '').toLowerCase();
      const ext = ALLOWED_ATTACHMENT_TYPES[mime];
      if (!ext) return fail(res, 415, 'That file type is not supported here');
      if (req.file.buffer.length > MAX_ATTACHMENT_BYTES) return fail(res, 413, 'File is too large (max 12 MB)');

      const dir = path.join(ATTACH_DIR, group.id);
      fs.mkdirSync(dir, { recursive: true });
      // Filename is entirely server-generated; the client's name is metadata only.
      const stored = uuidv4() + ext;
      fs.writeFileSync(path.join(dir, stored), req.file.buffer);
      const relPath = path.join(group.id, stored);

      const caption = svc.clampBody((req.body || {}).body);
      const replyToId = String((req.body || {}).reply_to_id || '') || null;
      if (replyToId) {
        const parent = await queryOne('SELECT id FROM chat_messages WHERE id = ? AND group_id = ?', [replyToId, group.id]);
        if (!parent) return fail(res, 400, 'The message you replied to is no longer available');
      }

      const senderRole = (membership && membership.group_role) || (isAdmin ? 'admin' : '');
      const kind = mime.startsWith('image/') ? 'image' : 'file';
      const msgId = await svc.insertMessage(db, {
        groupId: group.id, senderId: req.user.id, senderGroupRole: senderRole, body: caption, kind, replyToId
      });
      await run(
        `INSERT INTO chat_message_attachments (id, message_id, group_id, file_path, original_name, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), msgId, group.id, relPath, safeOriginalName(req.file.originalname), mime, req.file.buffer.length]
      );

      const maxSeq = await svc.groupMaxSeq(db, group.id);
      await svc.markRead(db, group.id, req.user.id, maxSeq);
      const [message] = await svc.loadMessages(db, group.id, { viewerId: req.user.id, since: String(Number(maxSeq) - 1), limit: 1 });
      const members = await svc.listMembers(db, group.id);
      const me = members.find(m => String(m.userId) === String(req.user.id));
      await notifyGroup(group, members, req.user.id, (me && me.name) || 'BodyBank', kind === 'image' ? '📷 Photo' : '📎 Attachment');

      res.status(201).json({ message: message || { id: msgId }, maxSeq });
    } catch (e) {
      console.error('[groupChat attach]', e.message);
      if (e && e.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'File is too large (max 12 MB)');
      fail(res, 500, 'Failed to send attachment');
    }
  });

  // ══ EDIT OWN MESSAGE ══════════════════════════════════════════════════════
  router.patch('/:id/messages/:messageId', verifyToken, withAccess, rateLimiter(30, 60000), async (req, res) => {
    try {
      const { group } = req.access;
      const msg = await queryOne('SELECT * FROM chat_messages WHERE id = ? AND group_id = ?', [String(req.params.messageId), group.id]);
      if (!msg) return fail(res, 404, 'Message not found');
      if (String(msg.sender_id) !== String(req.user.id)) return fail(res, 403, 'You can only edit your own messages');
      if (msg.deleted_at) return fail(res, 400, 'That message was deleted');
      if (msg.kind !== 'text') return fail(res, 400, 'Only text messages can be edited');
      const age = Date.now() - new Date(msg.created_at).getTime();
      if (age > svc.EDIT_WINDOW_MS) return fail(res, 400, 'This message is too old to edit');

      const body = svc.clampBody((req.body || {}).body);
      if (!body) return fail(res, 400, 'Message cannot be empty');
      await run('UPDATE chat_messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?', [body, msg.id]);
      res.json({ ok: true, id: msg.id, body, edited: true });
    } catch (e) {
      console.error('[groupChat edit]', e.message);
      fail(res, 500, 'Failed to edit message');
    }
  });

  // ══ DELETE MESSAGE (own, or any as admin) ═════════════════════════════════
  // Soft delete: the row stays so replies still resolve and the audit trail is
  // intact, but the body is cleared and never serialised again.
  router.delete('/:id/messages/:messageId', verifyToken, withAccess, async (req, res) => {
    try {
      const { group, canManage } = req.access;
      const msg = await queryOne('SELECT * FROM chat_messages WHERE id = ? AND group_id = ?', [String(req.params.messageId), group.id]);
      if (!msg) return fail(res, 404, 'Message not found');
      const own = String(msg.sender_id) === String(req.user.id);
      if (!own && !canManage) return fail(res, 403, 'You can only delete your own messages');
      if (msg.deleted_at) return res.json({ ok: true, id: msg.id, alreadyDeleted: true });

      await run("UPDATE chat_messages SET deleted_at = CURRENT_TIMESTAMP, body = '' WHERE id = ?", [msg.id]);
      await run('DELETE FROM chat_message_reactions WHERE message_id = ?', [msg.id]);
      if (!own) {
        const actor = await actorOf(req);
        await svc.audit(db, { groupId: group.id, actor, action: 'message_removed', detail: 'message ' + msg.id });
      }
      res.json({ ok: true, id: msg.id });
    } catch (e) {
      console.error('[groupChat delete]', e.message);
      fail(res, 500, 'Failed to delete message');
    }
  });

  // ══ TOGGLE REACTION ═══════════════════════════════════════════════════════
  router.post('/:id/messages/:messageId/reactions', verifyToken, withAccess, rateLimiter(90, 60000), async (req, res) => {
    try {
      const { group, canPost } = req.access;
      if (!canPost) return fail(res, 403, 'This group is archived and read-only');
      const emoji = String((req.body || {}).emoji || '');
      if (!svc.ALLOWED_REACTIONS.includes(emoji)) return fail(res, 400, 'Unsupported reaction');

      const msg = await queryOne('SELECT id, deleted_at FROM chat_messages WHERE id = ? AND group_id = ?', [String(req.params.messageId), group.id]);
      if (!msg) return fail(res, 404, 'Message not found');
      if (msg.deleted_at) return fail(res, 400, 'That message was deleted');

      const existing = await queryOne(
        'SELECT id FROM chat_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [msg.id, req.user.id, emoji]
      );
      if (existing) {
        await run('DELETE FROM chat_message_reactions WHERE id = ?', [existing.id]);
      } else {
        // One reaction per member per message, WhatsApp-style: switching emoji
        // replaces the previous one rather than stacking.
        await run('DELETE FROM chat_message_reactions WHERE message_id = ? AND user_id = ?', [msg.id, req.user.id]);
        await run(
          `INSERT INTO chat_message_reactions (id, message_id, group_id, user_id, emoji)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
          [uuidv4(), msg.id, group.id, req.user.id, emoji]
        );
      }
      const map = await svc.reactionsForMessages(db, [msg.id], req.user.id);
      res.json({ ok: true, id: msg.id, reactions: map[msg.id] || [] });
    } catch (e) {
      console.error('[groupChat react]', e.message);
      fail(res, 500, 'Failed to react');
    }
  });

  // ══ MESSAGE INFO (delivered / read by) ════════════════════════════════════
  router.get('/:id/messages/:messageId/info', verifyToken, withAccess, async (req, res) => {
    try {
      const { group } = req.access;
      const msg = await queryOne('SELECT id, seq, sender_id, created_at FROM chat_messages WHERE id = ? AND group_id = ?', [String(req.params.messageId), group.id]);
      if (!msg) return fail(res, 404, 'Message not found');
      const members = await svc.listMembers(db, group.id);
      const seq = Number(msg.seq);
      const others = members.filter(m => String(m.userId) !== String(msg.sender_id));
      res.json({
        id: msg.id,
        sentAt: msg.created_at,
        readBy: others.filter(m => m.lastReadSeq >= seq).map(m => ({ name: m.name, roleLabel: m.roleLabel })),
        pending: others.filter(m => m.lastReadSeq < seq).map(m => ({ name: m.name, roleLabel: m.roleLabel }))
      });
    } catch (e) {
      console.error('[groupChat msginfo]', e.message);
      fail(res, 500, 'Failed to load message info');
    }
  });

  // ══ REPORT A MESSAGE ══════════════════════════════════════════════════════
  router.post('/:id/messages/:messageId/report', verifyToken, withAccess, rateLimiter(10, 60000), async (req, res) => {
    try {
      const { group } = req.access;
      const msg = await queryOne('SELECT id FROM chat_messages WHERE id = ? AND group_id = ?', [String(req.params.messageId), group.id]);
      if (!msg) return fail(res, 404, 'Message not found');
      const actor = await actorOf(req);
      const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
      await svc.audit(db, {
        groupId: group.id, actor, action: 'message_reported',
        detail: `message ${msg.id}${reason ? ' — ' + reason : ''}`
      });
      if (typeof notifyAgent === 'function') {
        notifyAgent('GROUP_MESSAGE_REPORTED', { groupId: group.id, messageId: msg.id, reporter: actor.name, reason });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[groupChat report]', e.message);
      fail(res, 500, 'Failed to report message');
    }
  });

  // ══ MARK READ ═════════════════════════════════════════════════════════════
  router.post('/:id/read', verifyToken, withAccess, async (req, res) => {
    try {
      const seq = (req.body || {}).seq;
      await svc.markRead(db, req.access.group.id, req.user.id, seq);
      res.json({ ok: true });
    } catch (e) {
      console.error('[groupChat read]', e.message);
      fail(res, 500, 'Failed to update read state');
    }
  });

  // ══ MUTE / UNMUTE (own membership) ════════════════════════════════════════
  router.post('/:id/mute', verifyToken, withAccess, async (req, res) => {
    try {
      if (!req.access.membership) return fail(res, 400, 'You are not a member of this group');
      const muted = !!(req.body || {}).muted;
      await run('UPDATE chat_group_members SET muted = ? WHERE group_id = ? AND user_id = ?', [muted, req.access.group.id, req.user.id]);
      res.json({ ok: true, muted });
    } catch (e) {
      console.error('[groupChat mute]', e.message);
      fail(res, 500, 'Failed to update notifications');
    }
  });

  // ══ ADD MEMBER (admin) ════════════════════════════════════════════════════
  router.post('/:id/members', verifyToken, withAccess, requireManage, async (req, res) => {
    try {
      const { group } = req.access;
      const userId = String((req.body || {}).user_id || '');
      const role = svc.normalizeGroupRole((req.body || {}).group_role);
      if (!userId || !role) return fail(res, 400, 'Pick a person and a role');
      // The client slot belongs to the group's client and nobody else.
      if (role === 'client' && userId !== String(group.client_id)) {
        return fail(res, 400, 'Only this group\'s client can hold the Client role');
      }
      const user = await queryOne('SELECT id, first_name, last_name, email FROM users WHERE id = ?', [userId]);
      if (!user) return fail(res, 400, 'That person no longer exists');

      await run(
        `INSERT INTO chat_group_members (id, group_id, user_id, group_role)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (group_id, user_id)
         DO UPDATE SET group_role = EXCLUDED.group_role, removed_at = NULL`,
        [uuidv4(), group.id, userId, role]
      );
      const actor = await actorOf(req);
      await svc.insertSystemMessage(db, group.id, `${actor.name} added ${svc.displayName(user)} as ${svc.GROUP_ROLE_LABELS[role]}`);
      await svc.audit(db, { groupId: group.id, actor, action: 'member_added', detail: `${svc.displayName(user)} (${role})` });
      if (typeof sendPushToUser === 'function') {
        sendPushToUser(userId, JSON.stringify({
          type: 'group_added', title: 'Added to ' + group.name,
          body: 'You were added to a BodyBank care group', id: 'group-' + group.id, url: '/?group=' + group.id
        })).catch(() => {});
      }
      res.status(201).json({ ok: true, members: await svc.listMembers(db, group.id) });
    } catch (e) {
      console.error('[groupChat addmember]', e.message);
      fail(res, 500, 'Failed to add member');
    }
  });

  // ══ REMOVE MEMBER (admin), or LEAVE (self) ════════════════════════════════
  router.delete('/:id/members/:userId', verifyToken, withAccess, async (req, res) => {
    try {
      const { group, canManage } = req.access;
      const target = String(req.params.userId);
      const self = target === String(req.user.id);
      if (!self && !canManage) return fail(res, 403, 'Admin access required');
      // Removing the client would leave a care group with nobody to care for.
      if (target === String(group.client_id)) return fail(res, 400, 'The client cannot be removed from their own care group');

      const member = await queryOne(
        'SELECT * FROM chat_group_members WHERE group_id = ? AND user_id = ? AND removed_at IS NULL',
        [group.id, target]
      );
      if (!member) return fail(res, 404, 'That person is not in this group');

      // Soft removal: the row is kept so past messages still attribute correctly.
      await run('UPDATE chat_group_members SET removed_at = CURRENT_TIMESTAMP WHERE id = ?', [member.id]);
      const user = await queryOne('SELECT first_name, last_name, email FROM users WHERE id = ?', [target]);
      const actor = await actorOf(req);
      await svc.insertSystemMessage(
        db, group.id,
        self ? `${actor.name} left the group` : `${actor.name} removed ${svc.displayName(user)}`
      );
      await svc.audit(db, { groupId: group.id, actor, action: self ? 'member_left' : 'member_removed', detail: svc.displayName(user) });
      res.json({ ok: true, members: await svc.listMembers(db, group.id) });
    } catch (e) {
      console.error('[groupChat removemember]', e.message);
      fail(res, 500, 'Failed to remove member');
    }
  });

  // ══ SEARCH MESSAGES ═══════════════════════════════════════════════════════
  router.get('/:id/search', verifyToken, withAccess, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ results: [] });
      // ILIKE with the wildcards supplied as part of the PARAMETER, never
      // concatenated into the SQL. `%` and `_` in the user's text are escaped so
      // a query of "100%" searches for that string instead of matching everything.
      const needle = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
      const rows = await queryAll(
        `SELECT m.id, m.seq, m.body, m.created_at, m.sender_group_role,
                u.first_name, u.last_name, u.email
         FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.group_id = ? AND m.deleted_at IS NULL AND m.kind = 'text'
           AND m.body ILIKE ? ESCAPE '\\'
         ORDER BY m.seq DESC LIMIT 50`,
        [req.access.group.id, needle]
      );
      res.json({
        results: rows.map(r => ({
          id: r.id,
          seq: Number(r.seq),
          body: r.body || '',
          createdAt: r.created_at,
          senderName: r.sender_id === null ? 'BodyBank' : svc.displayName(r),
          roleLabel: svc.GROUP_ROLE_LABELS[r.sender_group_role] || ''
        }))
      });
    } catch (e) {
      console.error('[groupChat search]', e.message);
      fail(res, 500, 'Search failed');
    }
  });

  // ══ SHARED MEDIA & LINKS ══════════════════════════════════════════════════
  router.get('/:id/media', verifyToken, withAccess, async (req, res) => {
    try {
      const groupId = req.access.group.id;
      const files = await queryAll(
        `SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.created_at,
                u.first_name, u.last_name, u.email
         FROM chat_message_attachments a
         JOIN chat_messages m ON m.id = a.message_id AND m.deleted_at IS NULL
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE a.group_id = ? ORDER BY a.created_at DESC LIMIT 100`,
        [groupId]
      );
      const linkRows = await queryAll(
        `SELECT id, body, created_at FROM chat_messages
         WHERE group_id = ? AND deleted_at IS NULL AND body ILIKE '%http%'
         ORDER BY seq DESC LIMIT 100`,
        [groupId]
      );
      const links = [];
      const seen = new Set();
      for (const r of linkRows) {
        const found = String(r.body || '').match(/https?:\/\/[^\s<>"']+/g) || [];
        for (const url of found) {
          if (seen.has(url)) continue;
          seen.add(url);
          links.push({ url, messageId: r.id, createdAt: r.created_at });
        }
      }
      res.json({
        files: files.map(f => ({
          id: f.id,
          name: f.original_name || 'Attachment',
          mimeType: f.mime_type || '',
          size: Number(f.size_bytes || 0),
          isImage: String(f.mime_type || '').startsWith('image/'),
          url: '/api/groups/attachments/' + f.id,
          createdAt: f.created_at,
          senderName: svc.displayName(f)
        })),
        links: links.slice(0, 60)
      });
    } catch (e) {
      console.error('[groupChat media]', e.message);
      fail(res, 500, 'Failed to load shared files');
    }
  });

  // ══ GROUP ACTIVITY LOG (admin) ════════════════════════════════════════════
  router.get('/:id/audit', verifyToken, withAccess, requireManage, async (req, res) => {
    try {
      const rows = await queryAll(
        'SELECT id, actor_name, action, detail, created_at FROM chat_group_audit WHERE group_id = ? ORDER BY created_at DESC LIMIT 100',
        [req.access.group.id]
      );
      res.json({ events: rows });
    } catch (e) {
      console.error('[groupChat audit]', e.message);
      fail(res, 500, 'Failed to load activity');
    }
  });

  return router;
}

module.exports = { createGroupChatRouter, ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES };
