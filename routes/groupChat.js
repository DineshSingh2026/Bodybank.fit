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
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  // Voice notes — covers the recorder/export format on every platform we ship
  // to: iOS voice memos (.m4a, sometimes reported as audio/mp4), Android's
  // built-in recorder (.3gp/.amr on older devices, .webm/.ogg on newer ones),
  // desktop browsers' MediaRecorder output, and plain .mp3/.wav files.
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/3gpp': '.3gp',
  'audio/amr': '.amr'
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
    sendPushToUser, notifyAgent, notifyHub
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
   * Fan a new message out to everyone else in the group, honouring each
   * member's mute flag. Routed through notificationHub (when available) so
   * every recipient — client, operator, doctor, whoever else is a member of
   * THIS group — gets both a push and a user_inbox/bell row; a member with no
   * live push subscription previously got nothing at all. Falls back to a raw
   * push if notifyHub was not wired in. Never throws into the send path — a
   * push provider outage must not fail the message that was already stored.
   */
  async function notifyGroup(group, members, senderId, senderName, preview) {
    const recipients = members
      .filter(m => String(m.userId) !== String(senderId) && !m.muted)
      .map(m => m.userId);
    if (!recipients.length) return;
    const body = senderName + ': ' + String(preview || '').slice(0, 90);

    if (notifyHub && typeof notifyHub.toUsers === 'function') {
      await notifyHub.toUsers(recipients, {
        title: group.name,
        body,
        type: 'group_message',
        link: 'messages',
        url: '/?group=' + group.id,
        tag: 'group-' + group.id
      }).catch(() => {});
      return;
    }

    if (typeof sendPushToUser !== 'function') return;
    const payload = JSON.stringify({
      type: 'group_message',
      title: group.name,
      body,
      id: 'group-' + group.id,
      link: 'messages',
      url: '/?group=' + group.id
    });
    for (const userId of recipients) {
      sendPushToUser(userId, payload).catch(() => {});
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

  // ══ INBOX ═════════════════════════════════════════════════════════════════
  // ONE round trip for the whole conversation list. The client used to call
  // /api/groups and /api/threads separately and merge them, which cost two
  // sequential-ish requests before anything could paint.
  //
  // Only ACTIVE conversations come back: care groups, plus 1-to-1 threads that
  // actually contain a message. A member additionally gets an empty placeholder
  // for their own coach chat so they have somewhere to start it.
  router.get('/inbox', verifyToken, async (req, res) => {
    try {
      const [groups, directs] = await Promise.all([
        svc.listGroupsForUser(db, req.user, { includeArchived: String(req.query.archived || '') === '1' }),
        svc.listDirectThreads(db, req.user, { limit: req.query.limit })
      ]);

      let rows = groups.concat(directs);
      if (!svc.isAdminRole(req.user.role) && !directs.length) {
        rows.push({
          id: 'dm:new',
          threadId: null,
          type: 'direct',
          name: 'Lifestyle Manager',
          subtitle: 'Private · just you and your coach',
          lastPreview: 'Start a private conversation',
          lastMessageAt: null,
          memberCount: 2,
          unread: 0,
          muted: false,
          archived: false
        });
      }

      rows.sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return tb - ta;
      });
      res.json({ conversations: rows });
    } catch (e) {
      console.error('[groupChat inbox]', e.message);
      fail(res, 500, 'Failed to load conversations');
    }
  });

  // ══ 1-TO-1 THREADS: paged read + live poll ════════════════════════════════
  // Two-segment literal paths, declared before every /:id route. Sending still
  // goes through the unchanged POST /api/threads/:id/messages, which owns the
  // client push and the coach-reply email.
  router.get('/dm/:threadId', verifyToken, async (req, res) => {
    try {
      const acc = await svc.resolveThread(db, req.params.threadId, req.user);
      if (!acc.found) return fail(res, 404, 'Conversation not found');
      if (!acc.ok) return fail(res, 403, 'Access denied');
      const page = await svc.loadDmPage(db, acc.thread.id, {
        staff: acc.staff,
        limit: req.query.limit,
        before: req.query.before ? { ts: req.query.before, id: req.query.beforeId } : null
      });
      res.json({
        thread: {
          id: acc.thread.id,
          clientId: acc.thread.user_id,
          clientName: svc.displayName(acc.thread),
          clientAvatar: acc.thread.profile_picture || ''
        },
        messages: page.messages,
        hasMore: page.hasMore
      });
    } catch (e) {
      console.error('[groupChat dm page]', e.message);
      fail(res, 500, 'Failed to load conversation');
    }
  });

  router.get('/dm/:threadId/updates', verifyToken, async (req, res) => {
    try {
      const messages = await svc.loadDmSince(db, req.params.threadId, req.user,
        { ts: req.query.after, id: req.query.afterId });
      res.json({ messages });
    } catch (e) {
      console.error('[groupChat dm updates]', e.message);
      fail(res, 500, 'Failed to sync');
    }
  });

  // ══ CLIENT SEARCH (admin: start a new 1-to-1) ═════════════════════════════
  // Deliberately search-only and capped. Dumping every client into the UI is
  // what the inbox is trying to avoid; the admin types a name and gets matches.
  router.get('/directory', verifyToken, requireAdminOrSuperadmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 12));
      // `%` and `_` in the query are escaped so they match literally instead of
      // acting as wildcards; the needle is always a bound parameter.
      const needle = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
      const match = `(first_name ILIKE ? ESCAPE '\\'
                     OR last_name ILIKE ? ESCAPE '\\'
                     OR email ILIKE ? ESCAPE '\\'
                     OR (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE ? ESCAPE '\\')`;
      const rows = await queryAll(
        `SELECT id, first_name, last_name, email, profile_picture
         FROM users
         WHERE role = 'user' AND COALESCE(suspended, FALSE) = FALSE
           ${q ? 'AND ' + match : ''}
         ORDER BY first_name ASC, last_name ASC
         LIMIT ?`,
        q ? [needle, needle, needle, needle, limit] : [limit]
      );
      res.json({
        clients: rows.map(u => ({
          id: u.id,
          name: svc.displayName(u),
          email: u.email || '',
          avatar: u.profile_picture || ''
        }))
      });
    } catch (e) {
      console.error('[groupChat directory]', e.message);
      fail(res, 500, 'Search failed');
    }
  });

  // ══ START / OPEN A 1-TO-1 WITH A CLIENT (admin) ═══════════════════════════
  // POST /api/threads is restricted to role 'user', so an admin cannot open a
  // conversation from their side. This is the staff equivalent: get-or-create,
  // returning the thread to open. It creates no message, so an abandoned search
  // does not litter the inbox — the empty thread stays invisible until someone
  // actually writes something.
  router.post('/direct', verifyToken, requireAdminOrSuperadmin, rateLimiter(30, 60000), async (req, res) => {
    try {
      const userId = String((req.body || {}).user_id || '');
      if (!userId) return fail(res, 400, 'Pick a client');
      const client = await queryOne(
        "SELECT id, first_name, last_name, email, profile_picture FROM users WHERE id = ? AND role = 'user'",
        [userId]
      );
      if (!client) return fail(res, 404, 'Client not found');

      let thread = await queryOne(
        'SELECT id FROM message_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
        [client.id]
      );
      if (!thread) {
        const tid = uuidv4();
        await run('INSERT INTO message_threads (id, user_id, subject) VALUES (?, ?, ?)', [tid, client.id, '']);
        thread = { id: tid };
      }
      res.json({
        conversation: {
          id: 'dm:' + thread.id,
          threadId: thread.id,
          type: 'direct',
          name: svc.displayName(client),
          clientName: svc.displayName(client),
          clientId: client.id,
          clientAvatar: client.profile_picture || '',
          avatarUrl: client.profile_picture || '',
          subtitle: 'Client · private thread',
          email: client.email || '',
          lastPreview: '',
          lastMessageAt: null,
          memberCount: 2,
          unread: 0,
          muted: false,
          archived: false
        }
      });
    } catch (e) {
      console.error('[groupChat direct]', e.message);
      fail(res, 500, 'Could not open that conversation');
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

  // ══ GROUP DETAIL + FIRST PAGE ═════════════════════════════════════════════
  // Opening a group is ONE request. It used to be two in series — detail, then
  // messages — so every open paid two round trips before a single bubble could
  // paint. The three queries below run in parallel, and `maxSeq` is derived from
  // the newest page instead of costing its own SELECT MAX.
  router.get('/:id', verifyToken, withAccess, async (req, res) => {
    try {
      const { group, membership, isAdmin, client } = req.access;
      // withAccess already fetched the group, the caller's membership and the
      // client in one query, so only the members and the page remain — and they
      // run in parallel. `hasMore` and `maxSeq` come out of the page query.
      const [members, page] = await Promise.all([
        svc.listMembers(db, group.id),
        svc.loadNewestPage(db, group.id, { viewerId: req.user.id, limit: svc.DEFAULT_PAGE_SIZE })
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
        rev: group.rev,
        maxSeq: page.maxSeq,
        messages: page.messages,
        hasMore: page.hasMore,
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
      sets.splice(sets.length - 1, 0, 'rev = COALESCE(rev, 0) + 1');
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
  router.get('/:id/updates', verifyToken, async (req, res) => {
    try {
      // One query answers the access check AND "has anything changed?".
      const st = await svc.pollState(db, req.params.id, req.user);
      if (!st.found) return fail(res, 404, 'Group not found');
      if (!st.ok) return fail(res, 403, 'You are not a member of this group');

      const since = Number(req.query.since);
      const clientRev = req.query.rev != null && req.query.rev !== '' ? Number(req.query.rev) : NaN;

      // The common case by far: nothing happened since the last poll. Read
      // receipts still ride along, because marking read does not bump `rev`
      // (it would make every idle poll look like a change).
      if (Number.isFinite(clientRev) && clientRev === st.rev && Number.isFinite(since) && since >= st.maxSeq) {
        return res.json({
          unchanged: true,
          rev: st.rev,
          maxSeq: st.maxSeq,
          archived: st.archived,
          readers: st.readers,
          memberCount: st.readers.length
        });
      }

      const groupId = String(req.params.id);
      const fromSeq = Number.isFinite(since) ? String(since) : '0';
      // Everything below runs in parallel, one query each.
      const [messages, recent, members] = await Promise.all([
        svc.loadMessages(db, groupId, { viewerId: req.user.id, since: fromSeq, limit: svc.MAX_PAGE_SIZE }),
        svc.recentState(db, groupId, req.user.id),
        svc.listMembers(db, groupId)
      ]);
      res.json({
        rev: st.rev,
        maxSeq: st.maxSeq,
        archived: st.archived,
        messages,
        recent,
        // Read receipts: the cursor each member has reached. The client turns
        // this into ticks by comparing against each of its own message seqs.
        readers: st.readers,
        members,
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
      const { group, membership, isAdmin, canPost, self } = req.access;
      if (!canPost) return fail(res, 403, 'This group is archived and read-only');
      const body = svc.clampBody((req.body || {}).body);
      const replyToId = String((req.body || {}).reply_to_id || '') || null;
      if (!body) return fail(res, 400, 'Message cannot be empty');

      // A reply must point at a message in THIS group — otherwise a crafted
      // reply_to_id would quote text out of a group the sender cannot read. The
      // same lookup yields the quote preview, so no second read is needed.
      let parent = null;
      if (replyToId) {
        parent = await queryOne(
          `SELECT m.id, m.seq, m.sender_id, m.sender_group_role, m.body, m.kind, m.deleted_at,
                  u.first_name, u.last_name, u.email
           FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
           WHERE m.id = ? AND m.group_id = ?`,
          [replyToId, group.id]
        );
        if (!parent) return fail(res, 400, 'The message you replied to is no longer available');
      }

      const senderRole = (membership && membership.group_role) || (isAdmin ? 'admin' : '');
      const ins = await svc.insertMessageFull(db, {
        groupId: group.id, senderId: req.user.id, senderGroupRole: senderRole, body, kind: 'text', replyToId
      });

      // Everything needed for the bubble is already known: build it here instead
      // of reading the row back.
      const message = svc.serializeMessage({
        id: ins.id,
        seq: ins.seq,
        group_id: group.id,
        sender_id: req.user.id,
        sender_group_role: senderRole,
        kind: 'text',
        body,
        reply_to_id: replyToId,
        edited_at: null,
        deleted_at: null,
        created_at: ins.createdAt,
        first_name: self && self.first_name,
        last_name: self && self.last_name,
        email: self && self.email,
        profile_picture: self && self.profile_picture
      }, { viewerId: req.user.id, replies: parent ? { [parent.id]: parent } : {} });

      res.status(201).json({ message, maxSeq: ins.seq, rev: ins.rev });

      // After the response: sending is an implicit read of everything before it,
      // and everyone else gets a push. Neither may slow the sender down.
      setImmediate(async () => {
        try {
          await svc.markRead(db, group.id, req.user.id, ins.seq);
          const members = await svc.listMembers(db, group.id);
          await notifyGroup(group, members, req.user.id, svc.displayName(self), body);
        } catch (e) {
          console.warn('[groupChat send/after]', e.message);
        }
      });
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
      const kind = mime.startsWith('image/') ? 'image' : (mime.startsWith('audio/') ? 'audio' : 'file');
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
      const preview = kind === 'image' ? '📷 Photo' : (kind === 'audio' ? '🎤 Voice note' : '📎 Attachment');
      await notifyGroup(group, members, req.user.id, (me && me.name) || 'BodyBank', preview);

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
      await Promise.all([
        run('UPDATE chat_messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?', [body, msg.id]),
        svc.bumpRev(db, group.id)
      ]);
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

      await Promise.all([
        run("UPDATE chat_messages SET deleted_at = CURRENT_TIMESTAMP, body = '' WHERE id = ?", [msg.id]),
        run('DELETE FROM chat_message_reactions WHERE message_id = ?', [msg.id]),
        svc.bumpRev(db, group.id)
      ]);
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

      // One reaction per member per message, WhatsApp-style. Clear whatever this
      // member had; if that WAS the tapped emoji the tap was a removal and we are
      // done, otherwise add the new one. Two statements at most, instead of a
      // lookup plus a delete plus an insert.
      const removed = await queryAll(
        'DELETE FROM chat_message_reactions WHERE message_id = ? AND user_id = ? RETURNING emoji',
        [msg.id, req.user.id]
      );
      const wasToggleOff = removed.some(x => x.emoji === emoji);
      if (!wasToggleOff) {
        await run(
          `INSERT INTO chat_message_reactions (id, message_id, group_id, user_id, emoji)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
          [uuidv4(), msg.id, group.id, req.user.id, emoji]
        );
      }
      const [map] = await Promise.all([
        svc.reactionsForMessages(db, [msg.id], req.user.id),
        svc.bumpRev(db, group.id)
      ]);
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
      if (deps.notifyHub) {
        deps.notifyHub.staff({
          title: '🚩 Message reported in ' + group.name,
          body: actor.name + (reason ? ': ' + reason : ' reported a message'),
          type: 'group_report', link: 'messages', url: '/?group=' + group.id
        }, { roles: ['admin', 'superadmin'], exclude: req.user.id });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[groupChat report]', e.message);
      fail(res, 500, 'Failed to report message');
    }
  });

  // ══ MARK READ ═════════════════════════════════════════════════════════════
  router.post('/:id/read', verifyToken, async (req, res) => {
    try {
      // No separate access check: the UPDATE is scoped to the caller's OWN live
      // membership row (user_id = req.user.id AND removed_at IS NULL), so a
      // non-member simply updates nothing. One query instead of three.
      await svc.markRead(db, String(req.params.id), req.user.id, (req.body || {}).seq);
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
