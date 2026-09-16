/* ============================================================================
   BodyBank — Messages (client)
   ----------------------------------------------------------------------------
   ONE inbox, two kinds of conversation:

     • group  — care groups (client + doctor + lifestyle manager + operator),
                backed by /api/groups
     • direct — the 1-to-1 client ↔ lifestyle-manager chat, backed by the
                original /api/threads endpoints, which are UNCHANGED

   Both render through the same list, the same bubbles and the same composer, so
   a member and an admin see one consistent WhatsApp-like surface instead of two
   different chat UIs. Everything a direct thread cannot do (reactions, replies,
   read receipts, attachments — its table has no columns for them) is hidden for
   that conversation rather than faked.

   Depends on globals from index.html: apiCall, escapeHtml, API,
   window.currentUser. Namespaced under window.BBGroupChat.

   ── Why polling ──────────────────────────────────────────────────────────────
   BodyBank has no WebSocket or SSE transport, and adding one would only work
   within a single instance (there is no pub/sub between Render instances). The
   live feel comes from an adaptive poll: fast while the reader is looking at the
   chat, slow when the tab is hidden, immediate on focus. Cheap, survives a
   dropped connection with no reconnect logic, needs no new infrastructure.
   ========================================================================== */

(function () {
  'use strict';

  // An idle poll is now a single query on the server (see /updates `rev`), so
  // the active cadence can be tighter without adding load.
  var POLL_ACTIVE_MS = 2500;
  var POLL_IDLE_MS = 15000;
  var POLL_HIDDEN_MS = 45000;
  var LIST_POLL_MS = 20000;
  /** Scrolled within this many px of the bottom counts as "at the bottom". */
  var STICK_PX = 120;
  var EDIT_WINDOW_MS = 15 * 60 * 1000;
  /** localStorage key prefix for a direct thread's per-device read mark. */
  var DM_SEEN = 'bb_dm_seen_';
  /**
   * On-device store: the inbox plus the newest page of recent conversations,
   * one localStorage entry per account. It is what lets every open paint before
   * the network answers — including after a reload or an app restart. It is
   * bounded, never holds unsent drafts, and is wiped on logout (BBG.forget).
   */
  var STORE_PREFIX = 'bbg_v1_';
  var STORE_MAX_CONVS = 15;
  var STORE_MAX_MSGS = 30;

  var EMOJI_SET = [
    '😀','😃','😄','😁','😆','😅','😂','🙂','😉','😊','😇','🥰','😍','😘','😋','😎',
    '🤩','🥳','🤔','🤨','😐','😴','😪','😮','😲','😢','😭','😤','😠','🥺','😳','🤗',
    '👍','👎','👏','🙌','🤝','🙏','💪','✌️','👌','🤞','❤️','🔥','⭐','✨','🎯','🏆',
    '💯','✅','❌','⚠️','📈','📉','💊','🩺','🥗','🍎','💧','😴','🏃','🧘','🏋️','⏰'
  ];

  // ── State ────────────────────────────────────────────────────────────────
  var S = {
    host: null,
    mode: 'member',        // 'member' | 'admin'
    conversations: [],
    filter: 'all',
    listQuery: '',

    kind: null,            // 'group' | 'direct' — what is open right now
    convId: null,          // group id, or thread id ('' before the first send)
    conv: null,            // the list row for the open conversation
    groupId: null,         // group-only convenience (null in direct mode)

    group: null,
    members: [],
    me: null,
    messages: [],
    maxSeq: 0,
    hasMore: false,
    reactionChoices: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
    replyTo: null,
    pendingFile: null,
    sending: false,
    stick: true,
    pollTimer: null,
    listTimer: null,
    opening: null,
    detailsOpen: false,
    searchOpen: false,
    media: null,
    drafts: {},
    // Opened conversations are kept so re-opening one paints from memory with
    // zero latency; the network refresh then reconciles in the background.
    cache: {},
    prefetching: {},
    listLoaded: false,
    listAt: 0,
    hydratedFor: null,
    // Group revision last seen; the server answers an unchanged poll from it.
    rev: 0,
    // Sends and reactions currently on the wire. Polls wait while any are, so a
    // poll can never race an optimistic bubble into a duplicate.
    inflight: 0,
    // Sends are delivered one after another so the server stores them in the
    // order they were typed, while every bubble still appears immediately.
    sendChain: Promise.resolve()
  };

  window.BBGroupChat = window.BBGroupChat || {};
  var BBG = window.BBGroupChat;

  // ── Small helpers ────────────────────────────────────────────────────────
  function esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s == null ? '' : String(s));
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function el(id) { return document.getElementById(id); }
  function api(method, url, body) { return window.apiCall(method, url, body); }
  function me() { return window.currentUser || {}; }
  function myId() { return String(me().id || ''); }
  function isStaff() {
    var r = String(me().role || '');
    return r === 'admin' || r === 'superadmin';
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] || '') + (parts[parts.length - 1][0] || '');
  }

  function avatarHtml(name, url, cls) {
    var klass = 'bbg-avatar' + (cls ? ' ' + cls : '');
    if (url) return '<div class="' + klass + '"><img src="' + esc(url) + '" alt="" loading="lazy"></div>';
    return '<div class="' + klass + '">' + esc(initials(name)) + '</div>';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtListTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(iso);
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    if (now - d < 7 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function fmtDayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /**
   * Escape, then linkify. Order matters: escaping AFTER linkifying would mangle
   * the anchors we just inserted, and linkifying raw input would let a crafted
   * URL inject markup. The `https?://` requirement also blocks `javascript:`.
   */
  function richText(s) {
    var safe = esc(s);
    return safe.replace(/(https?:\/\/[^\s<]+)/g, function (m) {
      return '<a href="' + m + '" target="_blank" rel="noopener noreferrer">' + m + '</a>';
    });
  }

  function icon(name) {
    var P = {
      back: '<path d="M15 18l-6-6 6-6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
      more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
      // Paper plane pointing RIGHT — tip at x=20, notch at x=4.
      send: '<path d="M20 12L4 4l3 8-3 8z"/>',
      spin: '<path d="M12 3a9 9 0 1 0 9 9"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L13 5a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/>',
      smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
      down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      chev: '<path d="M9 6l6 6-6 6"/>',
      clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
      compose: '<path d="M4 20h16"/><path d="M14.5 4.5l5 5L9 20H4v-5z"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || '') + '</svg>';
  }

  function tickHtml(read) {
    var p = read
      ? '<path d="M1 6.5l3 3 6.5-7"/><path d="M6.5 9.5l1.5 1.5L15 3.5"/>'
      : '<path d="M2 6.5l3.5 3.5L13 2.5"/>';
    return '<span class="bbg-ticks' + (read ? ' is-read' : '') + '" title="' + (read ? 'Read by everyone' : 'Sent') + '">'
      + '<svg viewBox="0 0 16 12" aria-hidden="true">' + p + '</svg></span>';
  }

  function toast(msg, isError) {
    if (typeof window.showPopup === 'function') {
      window.showPopup(isError ? 'Something went wrong' : 'BodyBank', msg);
      return;
    }
    alert(msg);
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ══════════════════════════════════════════════════════════════════════════
  // SHELL
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Mount the inbox into `host`.
   * @param {HTMLElement} host
   * @param {{mode?: 'member'|'admin'}} opts
   */
  BBG.mount = function (host, opts) {
    opts = opts || {};
    if (!host) return;
    S.host = host;
    S.mode = opts.mode || 'member';
    host.classList.add('bbg', 'bbg-host');
    host.innerHTML = shellHtml();
    bindShell();
    if (opts.background) {
      // Built ahead of time while the tab is hidden. Paint the list only: no
      // conversation is opened (that would mark it read unseen) and no polling
      // starts until the user actually arrives — see BBG.enter().
      paintCachedList();
      return;
    }
    BBG.refreshList(true);
    startListPoll();
  };

  /**
   * The user has arrived on an ALREADY-built inbox. Everything that a visible
   * inbox does — sizing, the list poll, opening the newest conversation on a
   * desktop — starts here rather than at build time.
   */
  BBG.enter = function () {
    startListPoll();
    sizeShell();
    BBG.refreshList(true);
  };

  /**
   * Build the inbox shell in the background as soon as the data is warm.
   * Building it (and the first layout of a large admin page) was most of what a
   * first click on Messages cost; afterwards that click only has to show it.
   */
  function premount() {
    var id = S.mode === 'admin' ? 'bbAdminInboxHost' : 'bbGroupChatHost';
    var host = el(id);
    if (!host || (host.dataset.mounted && host.children.length)) return;
    BBG.mount(host, { mode: S.mode, background: true });
    host.dataset.mounted = '1';
  }

  function shellHtml() {
    return ''
      + '<div class="bbg-shell" id="bbgShell" data-pane="list">'
      + '<div class="bbg-pane bbg-pane--list" role="navigation" aria-label="Conversations">'
      +   '<div class="bbg-panehead">'
      +     '<div class="bbg-panehead-main">'
      +       '<div class="bbg-panehead-title">Messages</div>'
      +       '<div class="bbg-panehead-sub" id="bbgListSub">Your conversations</div>'
      +     '</div>'
      +     (S.mode === 'admin'
            ? '<button type="button" class="bbg-iconbtn" id="bbgNewDmBtn" title="Message a client" aria-label="Message a client">'
              + icon('compose') + '</button>'
              + '<button type="button" class="bbg-newbtn" id="bbgNewGroupBtn" title="Create a care group">'
              + icon('plus') + '<span>New group</span></button>'
            : '')
      +   '</div>'
      +   '<div class="bbg-filters" id="bbgFilters"></div>'
      +   '<div class="bbg-search"><input type="search" id="bbgListSearch" placeholder="Search conversations" autocomplete="off"></div>'
      +   '<div class="bbg-scroll" id="bbgConvList"></div>'
      + '</div>'
      + '<div class="bbg-pane bbg-pane--chat">'
      +   '<div class="bbg-panehead" id="bbgChatHead" style="position:relative">'
      +     '<button type="button" class="bbg-iconbtn bbg-back" id="bbgBackBtn" aria-label="Back to conversations">' + icon('back') + '</button>'
      +     '<div id="bbgHeadAvatar"></div>'
      +     '<button type="button" class="bbg-panehead-main" id="bbgHeadOpen" style="background:none;border:none;text-align:left;cursor:pointer;padding:0">'
      +       '<div class="bbg-panehead-title" id="bbgHeadTitle">Select a conversation</div>'
      +       '<div class="bbg-panehead-sub" id="bbgHeadSub"></div>'
      +     '</button>'
      +     '<button type="button" class="bbg-iconbtn" id="bbgSearchBtn" title="Search messages" aria-label="Search messages">' + icon('search') + '</button>'
      +     '<button type="button" class="bbg-iconbtn" id="bbgInfoBtn" title="Conversation info" aria-label="Conversation info">' + icon('info') + '</button>'
      +     '<button type="button" class="bbg-iconbtn" id="bbgMoreBtn" title="More options" aria-label="More options">' + icon('more') + '</button>'
      +     '<div id="bbgSearchHost"></div>'
      +   '</div>'
      +   '<div class="bbg-transcript" id="bbgTranscript"></div>'
      +   '<div id="bbgComposerHost"></div>'
      + '</div>'
      + '<div class="bbg-pane bbg-pane--details">'
      +   '<div class="bbg-panehead">'
      +     '<button type="button" class="bbg-iconbtn bbg-back" id="bbgDetailsBack" aria-label="Back to chat">' + icon('back') + '</button>'
      +     '<div class="bbg-panehead-main"><div class="bbg-panehead-title" id="bbgDetailsTitle">Info</div></div>'
      +     '<button type="button" class="bbg-iconbtn" id="bbgDetailsClose" aria-label="Close info">' + icon('close') + '</button>'
      +   '</div>'
      +   '<div class="bbg-scroll" id="bbgDetailsBody"></div>'
      + '</div>'
      + '</div>';
  }

  function bindShell() {
    el('bbgBackBtn').onclick = function () { setPane('list'); };
    el('bbgDetailsBack').onclick = function () { closeDetails(); };
    el('bbgDetailsClose').onclick = function () { closeDetails(); };
    el('bbgHeadOpen').onclick = function () { if (S.convId != null) openDetails(); };
    el('bbgInfoBtn').onclick = function () { if (S.convId != null) toggleDetails(); };
    el('bbgSearchBtn').onclick = function () { toggleSearch(); };
    el('bbgMoreBtn').onclick = function (e) { e.stopPropagation(); openConvMenu(); };
    var nb = el('bbgNewGroupBtn');
    if (nb) nb.onclick = function () { BBG.openCreateGroup(); };
    var dm = el('bbgNewDmBtn');
    if (dm) dm.onclick = function () { BBG.openNewMessage(); };

    el('bbgListSearch').oninput = function () {
      S.listQuery = this.value.trim().toLowerCase();
      renderList();
    };

    // Window-level listeners are bound ONCE. mount() runs again whenever the
    // host is re-created, and re-binding here would stack a duplicate
    // poll-on-focus and resize handler on every remount.
    if (!BBG._globalsBound) {
      BBG._globalsBound = true;
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onVisibility);
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
    }
    sizeShell();
    setTimeout(sizeShell, 260);
  }

  function setPane(p) {
    var shell = el('bbgShell');
    if (shell) shell.setAttribute('data-pane', p);
  }

  /**
   * Size the shell to the space actually left on screen.
   *
   * A CSS `calc(100dvh - <magic>)` cannot know how tall the page chrome above
   * the shell is, and it guessed wrong: the composer ended up underneath the
   * fixed bottom nav, so the send button was unreachable on a phone.
   */
  function sizeShell() {
    var shell = el('bbgShell');
    if (!shell || !shell.offsetParent) return;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var top = shell.getBoundingClientRect().top;
    if (!(top > 0 && top < vh)) return;

    var reserve = 0;
    ['#userBottomNav', '#adminBottomNav'].forEach(function (sel) {
      var n = document.querySelector(sel);
      if (!n) return;
      var cs = window.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = n.getBoundingClientRect();
      if (!r.height) return;
      // Testing `bottom >= innerHeight` is too strict: the member nav is a
      // floating pill that stops a few px short of the edge.
      if (cs.position === 'fixed' && r.top > vh * 0.6) reserve = Math.max(reserve, vh - r.top);
    });

    shell.style.height = Math.max(360, Math.round(vh - top - reserve - 12)) + 'px';

    // The admin panel parks a floating AI/WhatsApp button in the bottom-right
    // corner at a higher z-index than the shell, and it landed exactly on top of
    // the send button. Measure any fixed element overlapping the shell's
    // bottom-right corner and reserve a gutter for it.
    var rect = shell.getBoundingClientRect();
    var gutter = 0;
    ['.admin-ai-wa-fab-wrap', '.wa-public-fab'].forEach(function (sel) {
      var f = document.querySelector(sel);
      if (!f) return;
      var cs = window.getComputedStyle(f);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var fr = f.getBoundingClientRect();
      if (!fr.width || !fr.height) return;
      var overlaps = fr.right > rect.left && fr.left < rect.right
        && fr.bottom > rect.bottom - 90 && fr.top < rect.bottom;
      if (overlaps) gutter = Math.max(gutter, Math.round(rect.right - fr.left) + 12);
    });
    shell.style.setProperty('--bbg-fab-gutter', gutter + 'px');
  }
  BBG.sizeShell = sizeShell;

  var _resizeTimer = null;
  function onResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function () {
      sizeShell();
      if (S.stick) scrollToBottom();
    }, 120);
  }

  function isDesktop() {
    try { return window.matchMedia('(min-width:1024px)').matches; }
    catch (e) { return (window.innerWidth || 0) >= 1024; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONVERSATION LIST
  // ══════════════════════════════════════════════════════════════════════════

  // ── On-device store ──────────────────────────────────────────────────────

  function storeKey() { return STORE_PREFIX + myId(); }

  /** Load this account's saved inbox and conversations into memory, once. */
  function loadStore() {
    var uid = myId();
    if (!uid || S.hydratedFor === uid) return;
    S.hydratedFor = uid;
    var raw = lsGet(storeKey());
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      if (!saved || saved.v !== 1) return;
      if (Array.isArray(saved.rows) && !S.conversations.length) S.conversations = saved.rows;
      var convs = saved.convs || {};
      Object.keys(convs).forEach(function (k) { if (!S.cache[k]) S.cache[k] = convs[k]; });
    } catch (e) { /* a corrupt entry is simply ignored and overwritten */ }
  }

  var _persistTimer = null;
  function persist() {
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(writeStore, 400);
  }

  function writeStore() {
    if (!myId()) return;
    var convs = {};
    Object.keys(S.cache)
      .map(function (k) { return [k, S.cache[k]]; })
      .sort(function (a, b) { return (b[1].at || 0) - (a[1].at || 0); })
      .slice(0, STORE_MAX_CONVS)
      .forEach(function (pair) {
        var c = pair[1];
        // Never persist a message the server has not confirmed.
        var msgs = (c.messages || []).filter(function (m) { return !m.pending && !m.failed; });
        var copy = {};
        Object.keys(c).forEach(function (k) { copy[k] = c[k]; });
        copy.messages = msgs.slice(-STORE_MAX_MSGS);
        copy.hasMore = !!c.hasMore || msgs.length > STORE_MAX_MSGS;
        convs[pair[0]] = copy;
      });
    var payload = JSON.stringify({ v: 1, at: Date.now(), rows: S.conversations.slice(0, 60), convs: convs });
    try { localStorage.setItem(storeKey(), payload); }
    catch (e) {
      // Over quota: drop the entry rather than leave a half-written one behind.
      try { localStorage.removeItem(storeKey()); } catch (_) { /* blocked */ }
    }
  }

  function cachePut(id, entry) {
    if (!id || !entry) return;
    entry.at = Date.now();
    S.cache[id] = entry;
    persist();
  }

  /** The open conversation, in the shape the cache stores. */
  function snapshot() {
    if (isDirect()) return { kind: 'direct', messages: S.messages };
    return {
      kind: 'group', group: S.group, members: S.members, me: S.me,
      messages: S.messages, maxSeq: S.maxSeq, hasMore: S.hasMore,
      rev: S.rev, reactionChoices: S.reactionChoices
    };
  }

  /**
   * Forget everything this account had on the device. Called at logout BEFORE
   * the session is cleared. Also resets the in-memory engine: it lives for the
   * life of the page, so without this the next account to sign in on the same
   * tab would briefly see the previous account's conversations.
   */
  BBG.forget = function () {
    var uid = myId();
    stopPoll();
    if (S.listTimer) { clearInterval(S.listTimer); S.listTimer = null; }
    clearTimeout(_persistTimer);
    if (uid) {
      try { localStorage.removeItem(STORE_PREFIX + uid); } catch (e) { /* blocked */ }
      try { sessionStorage.removeItem('bb_inbox_' + uid); } catch (e) { /* previous build's key */ }
    }
    S.conversations = []; S.cache = {}; S.prefetching = {};
    S.listLoaded = false; S.listAt = 0; S.hydratedFor = null; S._warming = false;
    S.conv = null; S.convId = null; S.groupId = null; S.kind = null; S.opening = null;
    S.messages = []; S.group = null; S.members = []; S.me = null;
    S.drafts = {}; S.rev = 0; S.maxSeq = 0; S.inflight = 0; S.sendChain = Promise.resolve();
    ['bbGroupChatHost', 'bbAdminInboxHost'].forEach(function (id) {
      var h = el(id);
      if (h) { h.innerHTML = ''; delete h.dataset.mounted; }
    });
  };

  /** Paint the inbox from memory or the device store before the network answers. */
  function paintCachedList() {
    loadStore();
    if (!S.conversations.length) return false;
    renderFilters(); renderList(); updateListSub();
    return true;
  }

  /**
   * Should a 1-to-1 row show its "new activity" dot?
   *
   * thread_messages has no read column, so this is a per-device mark. Keying off
   * the sender of the LAST message (which the inbox returns) keeps it honest:
   * your own reply never re-flags the row as unread.
   */
  function directDot(row) {
    if (!row.threadId || !row.lastMessageAt) return false;
    var mineWasLast = S.mode === 'admin' ? !!row.lastFromStaff : !row.lastFromStaff;
    if (mineWasLast) return false;
    var seen = lsGet(DM_SEEN + row.threadId);
    if (!seen) return true;
    var a = new Date(row.lastMessageAt).getTime();
    var b = new Date(seen).getTime();
    return isFinite(a) && isFinite(b) ? a > b : false;
  }

  function byRecency(a, b) {
    var ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    var tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return tb - ta;
  }

  function applyInbox(rows) {
    // An admin who just opened a brand-new 1-to-1 from search has a row the
    // server does not return yet (no messages). Keep it until it has some.
    var local = S.conversations.filter(function (c) {
      return c.type === 'direct' && c.threadId && !c.lastMessageAt
        && !rows.some(function (r) { return r.id === c.id; });
    });
    rows.forEach(function (r) { if (r.type === 'direct') r.unreadDot = directDot(r); });
    S.conversations = rows.concat(local).sort(byRecency);
    S.listLoaded = true;
    S.listAt = Date.now();
    persist();
  }

  /**
   * Desktop opens the newest conversation on arrival. Rendering a whole
   * transcript inside the same task meant the list could not paint until it
   * finished; yielding one frame puts the list on screen first.
   */
  var _openAfterPaint = false;
  function openAfterPaint(row) {
    if (_openAfterPaint) return;
    _openAfterPaint = true;
    var go = function () {
      _openAfterPaint = false;
      if (S.convId == null && row) openConversation(row);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(go, 0); });
    else setTimeout(go, 0);
  }

  /** Warm the few most recent conversations so opening them costs nothing. */
  function prefetchTop() {
    S.conversations.slice(0, 3).forEach(prefetch);
  }

  BBG.refreshList = async function (autoOpenFirst) {
    var box = el('bbgConvList');
    if (!box) return;
    var painted = paintCachedList();
    if (!painted) {
      box.innerHTML = '<div class="bbg-empty"><span class="bbg-empty-icon">&#128172;</span>Loading conversations&hellip;</div>';
    }
    if (autoOpenFirst && painted && isDesktop() && S.convId == null && S.conversations.length) {
      openAfterPaint(S.conversations[0]);
    }
    // A mount right after the warm-up does not need a second identical request.
    if (autoOpenFirst && S.listAt && Date.now() - S.listAt < 6000) { prefetchTop(); return; }
    try {
      // ONE round trip. The server merges care groups with the 1-to-1 threads
      // that actually have messages, already filtered and sorted.
      var res = await api('GET', '/api/groups/inbox');
      if (!res || res.error || !Array.isArray(res.conversations)) {
        if (!S.conversations.length) {
          box.innerHTML = '<div class="bbg-empty"><span class="bbg-empty-icon">&#9888;&#65039;</span>'
            + '<b>Could not load conversations</b>Check your connection and try again.</div>';
        }
        return;
      }
      applyInbox(res.conversations);
      renderFilters();
      renderList();
      updateListSub();
      publishUnread();
      if (autoOpenFirst && isDesktop() && S.convId == null && S.conversations.length) {
        openAfterPaint(S.conversations[0]);
      }
      prefetchTop();
    } catch (e) {
      if (!S.conversations.length) {
        box.innerHTML = '<div class="bbg-empty"><span class="bbg-empty-icon">&#9888;&#65039;</span>'
          + '<b>Could not load conversations</b>Check your connection and try again.</div>';
      }
    }
  };

  /**
   * Fetch a conversation into the cache without opening it — on boot for the
   * newest rows, and on hover/touch for whatever is about to be tapped. A row
   * already cached this minute is left alone.
   */
  function prefetch(row) {
    if (!row || S.prefetching[row.id]) return;
    var c = S.cache[row.id];
    if (c && c.at && Date.now() - c.at < 60000) return;
    if (row.type === 'direct' && !row.threadId) return;
    S.prefetching[row.id] = true;
    var done = function () { delete S.prefetching[row.id]; };
    if (row.type === 'group') {
      api('GET', '/api/groups/' + encodeURIComponent(row.id))
        .then(function (d) {
          // Never overwrite the conversation that is open — it has live state.
          if (d && !d.error && d.group && !(S.conv && S.conv.id === row.id)) cachePut(row.id, shapeGroup(d));
        })
        .catch(function () {})
        .then(done, done);
    } else {
      api('GET', '/api/threads/' + encodeURIComponent(row.threadId) + '/messages')
        .then(function (m) {
          if (Array.isArray(m) && !(S.conv && S.conv.id === row.id)) cachePut(row.id, { kind: 'direct', messages: mapDirect(m, row) });
        })
        .catch(function () {})
        .then(done, done);
    }
  }

  /** Normalise a group detail response into the shape the renderer consumes. */
  function shapeGroup(d) {
    return {
      kind: 'group',
      group: d.group,
      members: d.members || [],
      me: d.me || {},
      messages: d.messages || [],
      maxSeq: Number(d.maxSeq || 0),
      hasMore: !!d.hasMore,
      rev: Number(d.rev || 0),
      reactionChoices: d.reactionChoices
    };
  }

  /**
   * Warm the inbox before the user asks for it — as soon as a dashboard is up.
   * The device store paints first; the network refresh follows.
   */
  BBG.warm = function () {
    if (!window.currentUser || !window.currentUser.token) return;
    var role = String((window.currentUser && window.currentUser.role) || '');
    S.mode = (role === 'admin' || role === 'superadmin') ? 'admin' : 'member';
    loadStore();
    if (S._warming || (S.listAt && Date.now() - S.listAt < 6000)) return;
    S._warming = true;
    api('GET', '/api/groups/inbox')
      .then(function (res) {
        if (!res || res.error || !Array.isArray(res.conversations)) return;
        applyInbox(res.conversations);
        publishUnread();
        premount();
        if (el('bbgConvList')) { renderFilters(); renderList(); updateListSub(); }
        prefetchTop();
      })
      .catch(function () {})
      .then(function () { S._warming = false; }, function () { S._warming = false; });
  };

  function filtered() {
    var q = S.listQuery;
    return S.conversations.filter(function (c) {
      if (S.filter === 'direct' && c.type !== 'direct') return false;
      if (S.filter === 'group' && c.type !== 'group') return false;
      if (!q) return true;
      return String(c.name || '').toLowerCase().indexOf(q) >= 0
        || String(c.lastPreview || '').toLowerCase().indexOf(q) >= 0
        || String(c.clientName || '').toLowerCase().indexOf(q) >= 0
        || String(c.email || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderFilters() {
    var host = el('bbgFilters');
    if (!host) return;
    var nG = S.conversations.filter(function (c) { return c.type === 'group'; }).length;
    var nD = S.conversations.filter(function (c) { return c.type === 'direct'; }).length;
    var defs = [
      { k: 'all', label: 'All', n: S.conversations.length },
      { k: 'group', label: 'Groups', n: nG },
      { k: 'direct', label: 'One-to-One', n: nD }
    ];
    host.innerHTML = defs.map(function (d) {
      return '<button type="button" class="bbg-chip' + (S.filter === d.k ? ' is-active' : '') + '" data-f="' + d.k + '">'
        + esc(d.label) + '<span class="bbg-chip-count">' + d.n + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.bbg-chip'), function (b) {
      b.onclick = function () { S.filter = b.getAttribute('data-f'); renderFilters(); renderList(); };
    });
  }

  function renderList() {
    var box = el('bbgConvList');
    if (!box) return;
    var rows = filtered();
    if (!rows.length) {
      box.innerHTML = '<div class="bbg-empty"><span class="bbg-empty-icon">🗂️</span>'
        + '<b>' + (S.listQuery ? 'No matches' : 'No conversations yet') + '</b>'
        + (S.mode === 'admin'
            ? 'Create a care group, or wait for a client to start a direct chat.'
            : 'Your care team conversations will appear here.')
        + '</div>';
      return;
    }
    box.innerHTML = rows.map(convHtml).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.bbg-conv'), function (b) {
      var find = function () {
        return S.conversations.find(function (c) { return String(c.id) === b.getAttribute('data-id'); });
      };
      b.onclick = function () { var row = find(); if (row) openConversation(row); };
      // Start fetching the moment the pointer lands on a row — by the time the
      // click registers the conversation is usually already in the cache.
      var warm = function () { var row = find(); if (row) prefetch(row); };
      b.addEventListener('pointerenter', warm);
      b.addEventListener('touchstart', warm, { passive: true });
    });
  }

  function convHtml(c) {
    var unread = Number(c.unread || 0);
    var dot = !unread && !!c.unreadDot;
    var isGroup = c.type === 'group';
    var who = (isGroup && c.lastSenderName && c.lastKind !== 'system')
      ? '<i>' + esc(c.lastSenderName) + ': </i>' : '';
    return ''
      + '<button type="button" class="bbg-conv' + (unread || dot ? ' has-unread' : '')
      +   (String(S.conv && S.conv.id) === String(c.id) ? ' is-active' : '') + '" data-id="' + esc(c.id) + '">'
      +   avatarHtml(isGroup ? (c.clientName || c.name) : c.name, c.avatarUrl || c.clientAvatar, isGroup ? 'bbg-avatar--group' : '')
      +   '<div class="bbg-conv-body">'
      +     '<div class="bbg-conv-top">'
      +       '<span class="bbg-conv-name">' + esc(c.name) + '</span>'
      +       '<span class="bbg-conv-time">' + esc(fmtListTime(c.lastMessageAt)) + '</span>'
      +     '</div>'
      +     '<div class="bbg-conv-bottom">'
      +       '<span class="bbg-conv-preview">' + who + esc(c.lastPreview || 'No messages yet') + '</span>'
      +       '<span class="bbg-conv-tag">' + (isGroup ? 'Group' : '1:1') + '</span>'
      +       (c.muted ? '<span class="bbg-conv-flag" title="Muted">🔕</span>' : '')
      +       (c.archived ? '<span class="bbg-conv-flag" title="Archived">📦</span>' : '')
      +       (unread ? '<span class="bbg-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '')
      +       (dot ? '<span class="bbg-badge bbg-badge--dot" title="New activity"></span>' : '')
      +     '</div>'
      +   '</div>'
      + '</button>';
  }

  /** A direct row has no countable unread, so its dot counts as one. */
  function unreadTotal() {
    return S.conversations.reduce(function (a, c) {
      return a + (Number(c.unread || 0) || (c.unreadDot ? 1 : 0));
    }, 0);
  }

  function updateListSub() {
    var sub = el('bbgListSub');
    if (!sub) return;
    var total = unreadTotal();
    sub.innerHTML = total
      ? '<b>' + total + ' unread</b>'
      : esc(S.conversations.length + ' conversation' + (S.conversations.length === 1 ? '' : 's'));
  }

  function publishUnread() {
    var total = unreadTotal();
    window.bbGroupUnread = total;
    try { window.dispatchEvent(new CustomEvent('bb:group-unread', { detail: { total: total } })); }
    catch (e) { /* older webviews */ }
  }

  function openConversation(row) {
    if (!row) return;
    if (row.type === 'group') return BBG.openGroup(row.id, { row: row });
    return openDirect(row);
  }
  BBG.openConversation = openConversation;

  // ══════════════════════════════════════════════════════════════════════════
  // OPEN — shared prologue
  // ══════════════════════════════════════════════════════════════════════════

  function beginOpen(row, kind, convId) {
    stopPoll();
    saveDraft();
    S.opening = String(row.id);
    S.conv = row;
    S.kind = kind;
    S.convId = convId;
    S.groupId = kind === 'group' ? convId : null;
    S.messages = [];
    S.maxSeq = 0;
    S.hasMore = false;
    S.replyTo = null;
    S.pendingFile = null;
    S.stick = true;
    S.searchOpen = false;
    S.media = null;
    el('bbgSearchHost').innerHTML = '';
    setPane('chat');
    renderList();
    S.rev = 0;
    // Only show the spinner when there is nothing cached to paint instead.
    loadStore();
    if (!S.cache[row.id]) {
      el('bbgTranscript').innerHTML = '<div class="bbg-empty"><span class="bbg-empty-icon">&#128172;</span>Opening&hellip;</div>';
      el('bbgComposerHost').innerHTML = '';
    }
  }

  function stillOpening(row) { return S.opening === String(row.id); }

  function errBox(msg) {
    return '<div class="bbg-empty"><span class="bbg-empty-icon">⚠️</span><b>' + esc(msg) + '</b>Try again in a moment.</div>';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP CONVERSATION
  // ══════════════════════════════════════════════════════════════════════════

  BBG.openGroup = async function (groupId, opts) {
    opts = opts || {};
    if (!groupId) return;
    var row = opts.row
      || S.conversations.find(function (c) { return c.type === 'group' && c.id === groupId; })
      || { id: groupId, type: 'group', name: 'Group' };
    beginOpen(row, 'group', groupId);

    // Cached (or prefetched) — paint immediately, then reconcile in the
    // background. This is the difference between an open that feels instant and
    // one that waits on a round trip.
    var cached = S.cache[row.id];
    var painted = false;
    if (cached && cached.kind === 'group') {
      applyGroup(cached);
      painted = true;
    }

    try {
      // ONE request: detail + members + the newest page all arrive together.
      var d = await api('GET', '/api/groups/' + encodeURIComponent(groupId));
      if (!stillOpening(row)) return;
      if (!d || d.error || !d.group) {
        if (!painted) el('bbgTranscript').innerHTML = errBox((d && d.error) || 'Could not open this conversation.');
        return;
      }
      var shaped = shapeGroup(d);
      applyGroup(shaped, painted);
      cachePut(row.id, snapshot());
      markRead();
      startPoll();
      if (S.detailsOpen) openDetails();
    } catch (e) {
      if (!painted && stillOpening(row)) el('bbgTranscript').innerHTML = errBox('Could not open this conversation.');
      else if (painted) startPoll();
    }
  };

  /**
   * Render a group payload. `keepScroll` is set on the background refresh that
   * follows a cached paint, so a reader who has already scrolled up is not
   * yanked back to the bottom by data they were already looking at.
   */
  function applyGroup(d, keepScroll) {
    S.group = d.group;
    S.members = d.members;
    S.me = d.me;
    // A bubble sent while this refresh was in flight must survive it.
    S.messages = withPending(d.messages.slice());
    S.maxSeq = d.maxSeq;
    S.hasMore = d.hasMore;
    S.rev = Number(d.rev || 0);
    if (d.reactionChoices) S.reactionChoices = d.reactionChoices;
    renderHeader();
    renderTranscript();
    renderComposer();
    // No sizeShell() here: opening a conversation does not move the shell or
    // the page around it (it was sized on entering the inbox), and measuring
    // would force a layout in the middle of the render.
    if (!keepScroll || S.stick) scrollToBottom(true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DIRECT CONVERSATION (legacy /api/threads, unchanged server-side)
  // ══════════════════════════════════════════════════════════════════════════

  async function openDirect(row) {
    beginOpen(row, 'direct', row.threadId || '');
    S.group = null;
    S.members = [];
    S.me = { userId: myId(), isAdmin: isStaff(), isMember: true, canPost: true, canManage: false, muted: false };

    renderHeader();
    renderComposer();

    // A thread with no messages yet (member placeholder, or an admin opening a
    // client they have never written to) has nothing to fetch.
    if (!row.threadId) {
      S.messages = [];
      renderTranscript();
      startPoll();
      return;
    }

    var cached = S.cache[row.id];
    var painted = false;
    if (cached && cached.kind === 'direct') {
      S.messages = cached.messages.slice();
      S.maxSeq = cached.messages.length;
      renderTranscript();
      scrollToBottom(true);
      painted = true;
    }

    try {
      var msgs = await api('GET', '/api/threads/' + encodeURIComponent(row.threadId) + '/messages');
      if (!stillOpening(row)) return;
      if (!Array.isArray(msgs)) {
        if (!painted) el('bbgTranscript').innerHTML = errBox((msgs && msgs.error) || 'Could not open this conversation.');
        return;
      }
      var mapped = withPending(mapDirect(msgs, row));
      var changed = !painted || mapped.length !== S.messages.length
        || (mapped.length && S.messages.length && mapped[mapped.length - 1].id !== S.messages[S.messages.length - 1].id);
      S.messages = mapped;
      S.maxSeq = mapped.length;
      cachePut(row.id, snapshot());
      if (changed) {
        renderTranscript();
        if (!painted || S.stick) scrollToBottom(true);
      }
      markRead();
      startPoll();
    } catch (e) {
      if (!painted && stillOpening(row)) el('bbgTranscript').innerHTML = errBox('Could not open this conversation.');
      else if (painted) startPoll();
    }
  }

  /**
   * Map a legacy thread_messages row onto the shape the bubble renderer uses.
   *
   * `seq` is the array index: the legacy table has no sequence column, and the
   * value is only used here for ordering and grouping, never sent to a server.
   *
   * "Mine" is decided by ROLE for staff, not by user id — any admin replying in
   * a client's thread is the same "Lifestyle Manager" voice to the client, and a
   * second admin must not see their colleague's replies as incoming.
   */
  function mapDirect(rows, row) {
    var staff = isStaff();
    return rows.map(function (m, i) {
      var fromStaff = m.sender_role === 'admin' || m.sender_role === 'superadmin';
      var mine = staff ? fromStaff : String(m.sender_id) === myId();
      var name;
      if (mine) name = 'You';
      else if (fromStaff) name = 'Lifestyle Manager';
      else name = (row && row.clientName) || 'Client';
      return {
        id: m.id,
        seq: i + 1,
        senderId: m.sender_id,
        senderName: name,
        senderAvatar: (!fromStaff && row && row.clientAvatar) || '',
        senderRole: fromStaff ? 'lifestyle_manager' : 'client',
        senderRoleLabel: fromStaff ? 'Lifestyle Manager' : 'Client',
        kind: 'text',
        body: m.body || '',
        createdAt: m.created_at,
        editedAt: null,
        deleted: false,
        mine: mine,
        reactions: [],
        attachments: [],
        replyTo: null
      };
    });
  }

  var isDirect = function () { return S.kind === 'direct'; };

  /**
   * Append the open conversation's unconfirmed bubbles (sending or failed) to a
   * fresh server list, so a refresh can never make a just-typed message vanish.
   */
  function withPending(list) {
    S.messages.forEach(function (m) {
      if ((m.pending || m.failed) && list.indexOf(m) < 0) list.push(m);
    });
    return list;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HEADER / TRANSCRIPT
  // ══════════════════════════════════════════════════════════════════════════

  function renderHeader() {
    if (isDirect()) {
      var c = S.conv || {};
      el('bbgHeadAvatar').innerHTML = avatarHtml(c.name, c.avatarUrl, 'bbg-avatar--sm');
      el('bbgHeadTitle').textContent = c.name || 'Direct message';
      el('bbgHeadSub').innerHTML = '<b>1:1</b> · ' + esc(c.subtitle || 'Direct message');
      return;
    }
    var g = S.group || {};
    el('bbgHeadAvatar').innerHTML = avatarHtml(g.clientName || g.name, g.avatarUrl || g.clientAvatar, 'bbg-avatar--sm bbg-avatar--group');
    el('bbgHeadTitle').textContent = g.name || '';
    var names = S.members.slice(0, 4).map(function (m) { return m.name.split(' ')[0]; }).join(', ');
    var more = S.members.length > 4 ? ' +' + (S.members.length - 4) : '';
    el('bbgHeadSub').innerHTML = '<b>' + S.members.length + ' member' + (S.members.length === 1 ? '' : 's') + '</b>'
      + (names ? ' · ' + esc(names + more) : '');
  }

  function atBottom() {
    var t = el('bbgTranscript');
    if (!t) return true;
    return (t.scrollHeight - t.scrollTop - t.clientHeight) < STICK_PX;
  }

  function scrollToBottom(instant) {
    var t = el('bbgTranscript');
    if (!t) return;
    requestAnimationFrame(function () {
      t.scrollTop = t.scrollHeight;
      if (!instant) return;
      setTimeout(function () { t.scrollTop = t.scrollHeight; }, 60);
    });
  }

  function renderTranscript() {
    var t = el('bbgTranscript');
    if (!t) return;
    if (!S.messages.length) {
      t.innerHTML = '<div class="bbg-empty"><span class="bbg-empty-icon">👋</span>'
        + '<b>No messages yet</b>'
        + (isDirect()
            ? 'Send the first message — only you and your coach can see this chat.'
            : 'Say hello to the care team — everyone in this group will see it.')
        + '</div>';
      return;
    }
    var html = '';
    if (S.hasMore) html += '<div class="bbg-loadmore"><button type="button" id="bbgLoadMore">Load earlier messages</button></div>';
    var lastDay = '';
    var prev = null;
    for (var i = 0; i < S.messages.length; i++) {
      var m = S.messages[i];
      var day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) {
        html += '<div class="bbg-daysep"><span>' + esc(fmtDayLabel(m.createdAt)) + '</span></div>';
        lastDay = day;
        prev = null;
      }
      html += messageHtml(m, prev);
      prev = m;
    }
    t.innerHTML = html;
    bindTranscript();
    renderJumpPill();
  }

  function isGrouped(m, prev) {
    if (!prev || m.kind === 'system' || prev.kind === 'system') return false;
    if (String(prev.senderId) !== String(m.senderId)) return false;
    return (new Date(m.createdAt) - new Date(prev.createdAt)) < 5 * 60 * 1000;
  }

  function messageHtml(m, prev) {
    if (m.kind === 'system') {
      return '<div class="bbg-sysmsg" data-seq="' + m.seq + '"><span>' + esc(m.body) + '</span></div>';
    }
    var out = !!m.mine;
    var grouped = isGrouped(m, prev);
    var h = '<div class="bbg-row bbg-row--' + (out ? 'out' : 'in') + (grouped ? ' is-grouped' : '')
      + (m.pending ? ' is-pending' : '') + (m.failed ? ' is-failed' : '')
      + '" data-id="' + esc(m.id) + '" data-seq="' + m.seq + '">';

    // In a 1:1 chat the header already names the other person, so repeating it
    // (and their role) above every bubble is noise — WhatsApp shows neither the
    // name nor a per-message avatar in a direct thread. Groups need both,
    // because four people share the transcript.
    var direct = isDirect();
    if (!out && !direct) {
      h += '<div class="bbg-row-avatar">' + avatarHtml(m.senderName, m.senderAvatar, 'bbg-avatar--sm') + '</div>';
    }
    h += '<div class="bbg-bubble' + (m.deleted ? ' is-deleted' : '') + '">';

    if (!out && !grouped && !direct) {
      h += '<div class="bbg-sender">' + esc(m.senderName)
        + (m.senderRoleLabel ? '<span class="bbg-rolechip">' + esc(m.senderRoleLabel) + '</span>' : '')
        + '</div>';
    }

    if (m.replyTo) {
      h += '<button type="button" class="bbg-quote" data-goto="' + esc(m.replyTo.id) + '">'
        + '<div class="bbg-quote-who">' + esc(m.replyTo.senderName || 'Message')
        + (m.replyTo.senderRoleLabel ? ' · ' + esc(m.replyTo.senderRoleLabel) : '') + '</div>'
        + '<div class="bbg-quote-body">' + esc(m.replyTo.body) + '</div></button>';
    }

    (m.attachments || []).forEach(function (a) {
      if (a.isImage) {
        h += '<img class="bbg-att-img" src="' + esc(a.url) + '" alt="' + esc(a.name) + '" loading="lazy" data-full="' + esc(a.url) + '">';
      } else {
        h += '<a class="bbg-att-file" href="' + esc(a.url) + '" target="_blank" rel="noopener">'
          + '<span class="bbg-att-icon">📄</span><span class="bbg-att-meta">'
          + '<span class="bbg-att-name">' + esc(a.name) + '</span>'
          + '<span class="bbg-att-size">' + esc(fmtBytes(a.size)) + '</span></span></a>';
      }
    });

    if (m.deleted) h += '<div class="bbg-text">This message was deleted</div>';
    else if (m.body) h += '<div class="bbg-text">' + richText(m.body) + '</div>';

    var status = '';
    if (m.failed) {
      status = '<button type="button" class="bbg-retry" data-retry="' + esc(m.id) + '">Not sent &middot; Tap to retry</button>';
    } else if (m.pending) {
      status = '<span class="bbg-clock" title="Sending">' + icon('clock') + '</span>';
    } else if (out && !m.deleted) {
      // A direct thread has no read cursor in its table, so it shows the
      // delivered tick only rather than inventing a read state.
      status = tickHtml(isDirect() ? false : readByAll(m));
    }
    h += '<div class="bbg-meta">'
      + (m.editedAt ? '<span class="bbg-edited">edited</span>' : '')
      + '<span>' + esc(fmtTime(m.createdAt)) + '</span>'
      + status
      + '</div>';

    if (m.reactions && m.reactions.length) {
      h += '<div class="bbg-reacts">' + m.reactions.map(function (r) {
        return '<button type="button" class="bbg-react' + (r.mine ? ' is-mine' : '') + '" data-emoji="' + esc(r.emoji)
          + '" title="' + esc((r.names || []).join(', ')) + '">'
          + esc(r.emoji) + '<span class="bbg-react-n">' + r.count + '</span></button>';
      }).join('') + '</div>';
    }

    h += '</div>';
    if (!m.deleted && !m.pending) h += '<button type="button" class="bbg-rowbtn" aria-label="Message actions">' + icon('chev') + '</button>';
    h += '</div>';
    return h;
  }

  function readByAll(m) {
    var others = S.members.filter(function (x) { return String(x.userId) !== String(m.senderId); });
    if (!others.length) return false;
    return others.every(function (x) { return Number(x.lastReadSeq || 0) >= Number(m.seq); });
  }

  function bindTranscript() {
    var t = el('bbgTranscript');
    if (!t) return;

    var lm = el('bbgLoadMore');
    if (lm) lm.onclick = loadOlder;

    Array.prototype.forEach.call(t.querySelectorAll('.bbg-retry'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); retrySend(b.getAttribute('data-retry')); };
    });

    Array.prototype.forEach.call(t.querySelectorAll('.bbg-quote'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); gotoMessage(b.getAttribute('data-goto')); };
    });
    Array.prototype.forEach.call(t.querySelectorAll('.bbg-react'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        toggleReaction(b.closest('.bbg-row').getAttribute('data-id'), b.getAttribute('data-emoji'));
      };
    });
    Array.prototype.forEach.call(t.querySelectorAll('.bbg-att-img'), function (img) {
      img.onclick = function () { lightbox(img.getAttribute('data-full')); };
      img.onload = function () { if (S.stick) scrollToBottom(); };
    });
    Array.prototype.forEach.call(t.querySelectorAll('.bbg-rowbtn'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        openMessageActions(b.closest('.bbg-row').getAttribute('data-id'));
      };
    });

    Array.prototype.forEach.call(t.querySelectorAll('.bbg-row'), function (row) {
      var timer = null, moved = false;
      row.addEventListener('touchstart', function () {
        moved = false;
        timer = setTimeout(function () { if (!moved) openMessageActions(row.getAttribute('data-id')); }, 480);
      }, { passive: true });
      row.addEventListener('touchmove', function () { moved = true; clearTimeout(timer); }, { passive: true });
      row.addEventListener('touchend', function () { clearTimeout(timer); }, { passive: true });
      row.addEventListener('touchcancel', function () { clearTimeout(timer); }, { passive: true });
    });

    t.onscroll = function () {
      S.stick = atBottom();
      renderJumpPill();
      if (S.stick) markRead();
    };
  }

  function renderJumpPill() {
    var host = el('bbgComposerHost');
    if (!host) return;
    var pill = host.querySelector('.bbg-jump');
    if (!pill) return;
    var behind = S.messages.filter(function (m) {
      return !m.mine && Number(m.seq) > Number((S.me && S.me.lastReadSeq) || 0);
    }).length;
    pill.classList.toggle('is-shown', !S.stick);
    pill.querySelector('span').textContent = (!isDirect() && behind) ? behind + ' new' : 'Latest';
  }

  async function loadOlder() {
    if (isDirect() || !S.messages.length) return;
    var btn = el('bbgLoadMore');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    var t = el('bbgTranscript');
    var anchorH = t.scrollHeight, anchorTop = t.scrollTop;
    try {
      var res = await api('GET', '/api/groups/' + encodeURIComponent(S.groupId)
        + '/messages?limit=40&before=' + encodeURIComponent(S.messages[0].seq));
      var older = (res && res.messages) || [];
      if (older.length) {
        S.messages = older.concat(S.messages);
        S.hasMore = !!res.hasMore;
        renderTranscript();
        requestAnimationFrame(function () { t.scrollTop = t.scrollHeight - anchorH + anchorTop; });
      } else {
        S.hasMore = false;
        renderTranscript();
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load earlier messages'; }
    }
  }

  async function gotoMessage(id) {
    var row = document.querySelector('.bbg-row[data-id="' + cssEsc(id) + '"]');
    if (row) { focusRow(row); return; }
    for (var i = 0; i < 6 && S.hasMore; i++) {
      await loadOlder();
      row = document.querySelector('.bbg-row[data-id="' + cssEsc(id) + '"]');
      if (row) { focusRow(row); return; }
    }
    toast('That message is further back in the conversation.');
  }

  function focusRow(row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var b = row.querySelector('.bbg-bubble');
    if (!b) return;
    b.classList.remove('is-hit');
    void b.offsetWidth;
    b.classList.add('is-hit');
  }

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(String(s));
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPOSER
  // ══════════════════════════════════════════════════════════════════════════

  function renderComposer() {
    var host = el('bbgComposerHost');
    if (!host) return;
    if (!S.me || !S.me.canPost) {
      host.innerHTML = '<div class="bbg-composer"><div class="bbg-composer-locked">'
        + (S.group && S.group.archived
            ? 'This group is archived. Reopen it from Group info to send messages.'
            : 'You do not have permission to post in this conversation.')
        + '</div></div>';
      return;
    }
    var direct = isDirect();
    // The admin IS the coach, so "Message your Lifestyle Manager" would be
    // nonsense on their side of the same thread.
    var placeholder;
    if (!direct) placeholder = 'Message the care team…';
    else if (S.mode === 'admin') {
      var who = String((S.conv && S.conv.name) || '').split(' ')[0];
      placeholder = who ? 'Reply to ' + who + '…' : 'Reply…';
    } else placeholder = 'Message your Lifestyle Manager…';

    host.innerHTML = ''
      + '<div class="bbg-composer">'
      +   '<button type="button" class="bbg-jump" id="bbgJump">' + icon('down') + '<span>Latest</span></button>'
      +   '<div id="bbgReplyHost"></div>'
      +   '<div id="bbgAttachHost"></div>'
      +   '<div id="bbgEmojiHost"></div>'
      +   '<div class="bbg-inputrow">'
      +     '<button type="button" class="bbg-iconbtn" id="bbgEmojiBtn" aria-label="Emoji" aria-expanded="false">' + icon('smile') + '</button>'
      // The legacy thread_messages table has no attachment support, so the clip
      // is simply absent in a direct chat rather than present and broken.
      +     (direct ? '' : '<button type="button" class="bbg-iconbtn" id="bbgAttachBtn" aria-label="Attach a file">' + icon('clip') + '</button>')
      +     '<div class="bbg-inputwrap">'
      +       '<textarea class="bbg-input" id="bbgInput" rows="1" placeholder="'
      +         esc(placeholder) + '" maxlength="5000"></textarea>'
      +     '</div>'
      +     '<button type="button" class="bbg-send" id="bbgSend" aria-label="Send" disabled>' + icon('send') + '</button>'
      +   '</div>'
      +   (direct ? '' : '<input type="file" id="bbgFileInput" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt">')
      +   '<div id="bbgComposerErr"></div>'
      + '</div>';
    bindComposer();
    restoreDraft();
  }

  function bindComposer() {
    var input = el('bbgInput');
    var send = el('bbgSend');

    function sync() {
      // Reading scrollHeight forces a full layout. On an empty box — which is
      // what every freshly opened conversation has — there is nothing to
      // measure, and that read alone cost ~90 ms on the admin page.
      if (input.value) {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 132) + 'px';
      } else {
        input.style.height = '';
      }
      send.disabled = (S.sending && !!S.pendingFile) || (!input.value.trim() && !S.pendingFile);
      S.drafts[S.conv ? S.conv.id : '_'] = input.value;
    }
    input.oninput = sync;
    input.onkeydown = function (e) {
      // Enter sends on desktop; Shift+Enter is a newline. On a touch keyboard
      // Enter stays a newline — there is a dedicated send button there.
      if (e.key === 'Enter' && !e.shiftKey && isDesktop()) { e.preventDefault(); doSend(); }
    };
    send.onclick = doSend;

    el('bbgEmojiBtn').onclick = function (e) { e.stopPropagation(); toggleEmoji(); };
    var ab = el('bbgAttachBtn');
    if (ab) {
      ab.onclick = function () { el('bbgFileInput').click(); };
      el('bbgFileInput').onchange = function () {
        var f = this.files && this.files[0];
        if (f) pickFile(f);
        this.value = '';
      };
    }
    el('bbgJump').onclick = function () { S.stick = true; scrollToBottom(); markRead(); renderJumpPill(); };
    sync();
  }

  function draftKey() { return S.conv ? S.conv.id : '_'; }
  function saveDraft() {
    var input = el('bbgInput');
    if (input && S.conv) S.drafts[draftKey()] = input.value;
  }
  function restoreDraft() {
    var input = el('bbgInput');
    if (!input) return;
    var d = S.drafts[draftKey()];
    if (d) { input.value = d; input.dispatchEvent(new Event('input')); }
  }

  function setComposerError(msg) {
    var box = el('bbgComposerErr');
    if (box) box.innerHTML = msg ? '<div class="bbg-composer-err">⚠️ ' + esc(msg) + '</div>' : '';
  }

  function pickFile(f) {
    var MAX = 12 * 1024 * 1024;
    if (f.size > MAX) { setComposerError('That file is larger than 12 MB.'); return; }
    S.pendingFile = f;
    setComposerError('');
    var host = el('bbgAttachHost');
    var isImg = /^image\//.test(f.type);
    var thumb = isImg ? '<img class="bbg-attachbar-thumb" id="bbgAttachThumb" alt="">' : '<div class="bbg-attachbar-thumb">📄</div>';
    host.innerHTML = '<div class="bbg-attachbar">' + thumb
      + '<div class="bbg-attachbar-body">'
      + '<div class="bbg-attachbar-name">' + esc(f.name) + '</div>'
      + '<div class="bbg-attachbar-size">' + esc(fmtBytes(f.size)) + '</div></div>'
      + '<button type="button" class="bbg-iconbtn" id="bbgAttachCancel" aria-label="Remove attachment">' + icon('close') + '</button></div>';
    if (isImg) {
      var url = URL.createObjectURL(f);
      var img = el('bbgAttachThumb');
      img.src = url;
      img.onload = function () { URL.revokeObjectURL(url); };
    }
    el('bbgAttachCancel').onclick = clearFile;
    el('bbgSend').disabled = false;
  }

  function clearFile() {
    S.pendingFile = null;
    var h = el('bbgAttachHost');
    if (h) h.innerHTML = '';
    var input = el('bbgInput');
    if (input) input.dispatchEvent(new Event('input'));
  }

  function setReply(m) {
    S.replyTo = m;
    var host = el('bbgReplyHost');
    if (!host) return;
    if (!m) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="bbg-replybar">'
      + '<div class="bbg-replybar-body">'
      + '<div class="bbg-replybar-who">Replying to ' + esc(m.senderName) + '</div>'
      + '<div class="bbg-replybar-text">' + esc(m.deleted ? 'Deleted message' : (m.body || 'Attachment')) + '</div>'
      + '</div>'
      + '<button type="button" class="bbg-iconbtn" id="bbgReplyCancel" aria-label="Cancel reply">' + icon('close') + '</button></div>';
    el('bbgReplyCancel').onclick = function () { setReply(null); };
    var input = el('bbgInput');
    if (input) input.focus();
  }

  function toggleEmoji() {
    var host = el('bbgEmojiHost');
    var btn = el('bbgEmojiBtn');
    if (host.innerHTML) { host.innerHTML = ''; btn.setAttribute('aria-expanded', 'false'); return; }
    host.innerHTML = '<div class="bbg-pop bbg-pop--emoji">'
      + EMOJI_SET.map(function (e) { return '<button type="button">' + e + '</button>'; }).join('') + '</div>';
    btn.setAttribute('aria-expanded', 'true');
    Array.prototype.forEach.call(host.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        var input = el('bbgInput');
        input.value += b.textContent;
        input.dispatchEvent(new Event('input'));
        input.focus();
      };
    });
    setTimeout(function () {
      document.addEventListener('click', function close(ev) {
        if (host.contains(ev.target)) return;
        host.innerHTML = '';
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', close);
      });
    }, 0);
  }

  /**
   * Send.
   *
   * Text goes out OPTIMISTICALLY: the bubble is on screen in the same frame as
   * the tap, with a clock, and turns into a tick when the server confirms. The
   * input is cleared synchronously, which is also the double-send guard — a
   * second Enter finds nothing to send. Attachments keep the blocking path,
   * because the upload itself is the wait.
   */
  function doSend() {
    var input = el('bbgInput');
    if (!input) return;
    if (S.pendingFile) { sendFile(); return; }
    var body = (input.value || '').trim();
    if (!body) return;

    var temp = {
      id: 'tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      seq: Number.MAX_SAFE_INTEGER,
      senderId: myId(),
      senderName: 'You',
      senderAvatar: '',
      senderRole: '',
      senderRoleLabel: '',
      kind: 'text',
      body: body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deleted: false,
      mine: true,
      reactions: [],
      attachments: [],
      replyTo: S.replyTo && !isDirect() ? {
        id: S.replyTo.id,
        seq: S.replyTo.seq,
        senderName: S.replyTo.senderName,
        senderRoleLabel: S.replyTo.senderRoleLabel || '',
        body: S.replyTo.deleted ? 'This message was deleted' : String(S.replyTo.body || '').slice(0, 220),
        kind: S.replyTo.kind
      } : null,
      pending: true
    };

    input.value = '';
    input.dispatchEvent(new Event('input'));
    setReply(null);
    setComposerError('');
    delete S.drafts[draftKey()];

    S.messages.push(temp);
    S.stick = true;
    renderTranscript();
    scrollToBottom();
    bumpListPreview(body);
    queueDeliver(temp);
    if (input.focus) input.focus();
  }

  function retrySend(id) {
    var temp = S.messages.find(function (m) { return m.id === id; });
    if (!temp || !temp.failed) return;
    temp.failed = false;
    temp.pending = true;
    temp.error = '';
    renderTranscript();
    queueDeliver(temp);
  }

  function queueDeliver(temp) {
    var ctx = { kind: S.kind, conv: S.conv, groupId: S.groupId };
    S.inflight++;
    var go = function () { return deliver(temp, ctx); };
    S.sendChain = S.sendChain.then(go, go);
  }

  async function deliver(temp, ctx) {
    try {
      if (ctx.kind === 'direct') {
        var real = await deliverDirect(temp, ctx);
        settle(temp, real, ctx, null);
      } else {
        var res = await api('POST', '/api/groups/' + encodeURIComponent(ctx.groupId) + '/messages', {
          body: temp.body,
          reply_to_id: temp.replyTo ? temp.replyTo.id : null
        });
        if (!res || res.error || !res.message) throw new Error((res && res.error) || 'Message not sent');
        settle(temp, res.message, ctx, res);
      }
    } catch (e) {
      temp.pending = false;
      temp.failed = true;
      temp.error = (e && e.message) || 'Not sent';
      setPreviewState(ctx.conv, temp.body, true);
      if (S.conv === ctx.conv) renderTranscript();
    } finally {
      S.inflight = Math.max(0, S.inflight - 1);
    }
  }

  /**
   * Post into the legacy 1-to-1 thread. A member with no thread yet gets one
   * created by the same call that carries their first message; that call does
   * not return the row, so the next poll brings the confirmed copy in.
   */
  async function deliverDirect(temp, ctx) {
    var conv = ctx.conv;
    if (!conv.threadId) {
      var created = await api('POST', '/api/threads', { first_message: temp.body });
      if (!created || created.error || !created.id) throw new Error((created && created.error) || 'Could not start the conversation.');
      conv.threadId = created.id;
      conv.id = 'dm:' + created.id;
      if (S.conv === conv) S.convId = created.id;
      return null;
    }
    var res = await api('POST', '/api/threads/' + encodeURIComponent(conv.threadId) + '/messages', { body: temp.body });
    if (!res || res.error || !res.id) throw new Error((res && res.error) || 'Message not sent');
    return mapDirect([res], conv)[0];
  }

  /**
   * The list preview is bumped the moment a message is typed. If delivery then
   * fails, the preview must not keep claiming it was sent.
   */
  var NOT_SENT = 'Not sent: ';
  function setPreviewState(conv, body, failed) {
    if (!conv) return;
    var row = S.conversations.find(function (c) { return c === conv || c.id === conv.id; });
    if (!row) return;
    if (failed && row.lastPreview === body) row.lastPreview = NOT_SENT + body;
    else if (!failed && row.lastPreview === NOT_SENT + body) row.lastPreview = body;
    else return;
    renderList();
    persist();
  }

  /** Swap a confirmed message in for its optimistic bubble. */
  function settle(temp, real, ctx, res) {
    setPreviewState(ctx.conv, temp.body, false);
    var open = S.conv === ctx.conv;
    var list = open ? S.messages : ((S.cache[ctx.conv && ctx.conv.id] || {}).messages || []);
    var at = list.indexOf(temp);
    if (real) {
      real.mine = true;
      var dup = list.some(function (m) { return m.id === real.id; });
      if (at >= 0) { if (dup) list.splice(at, 1); else list[at] = real; }
      else if (!dup) list.push(real);
    } else {
      temp.pending = false;
    }

    if (open && res && ctx.kind === 'group') {
      // Fast-forward our cursors ONLY when our message was the one and only
      // change since the last sync (every change bumps rev by one). Otherwise a
      // message someone else sent meanwhile would be skipped, so leave the
      // cursors alone and let the next poll reconcile the gap.
      if (Number(res.rev) === Number(S.rev) + 1) {
        S.rev = Number(res.rev);
        S.maxSeq = Math.max(Number(S.maxSeq || 0), Number(res.maxSeq || 0));
        if (S.me) S.me.lastReadSeq = Math.max(Number(S.me.lastReadSeq || 0), Number(res.maxSeq || 0));
      }
    }

    if (open) {
      renderTranscript();
      if (S.stick) scrollToBottom();
      cachePut(S.conv.id, snapshot());
      // A brand-new thread: pull in the confirmed first message.
      if (!real && ctx.kind === 'direct') setTimeout(function () { poll(); }, 50);
    }
  }

  /** Move the open conversation to the top of the list with its new preview. */
  function bumpListPreview(body) {
    if (!S.conv) return;
    var row = S.conversations.find(function (c) { return c === S.conv || c.id === S.conv.id; });
    if (!row) return;
    row.lastPreview = body;
    row.lastMessageAt = new Date().toISOString();
    if (row.type === 'group') { row.lastSenderName = 'You'; row.lastKind = 'text'; }
    else { row.lastFromStaff = S.mode === 'admin'; row.unreadDot = false; }
    S.conversations.sort(byRecency);
    renderList();
    persist();
  }

  /** Attachments: the upload is the wait, so this path blocks the button. */
  async function sendFile() {
    if (S.sending) return;
    var input = el('bbgInput');
    var caption = (input.value || '').trim();
    var file = S.pendingFile;
    var replyId = S.replyTo ? S.replyTo.id : null;
    var send = el('bbgSend');
    S.sending = true;
    S.inflight++;
    send.disabled = true;
    send.classList.add('is-busy');
    send.innerHTML = icon('spin');
    setComposerError('');
    try {
      var res = await uploadAttachment(file, caption, replyId);
      if (res && res.error) throw new Error(res.error);
      input.value = '';
      clearFile();
      setReply(null);
      delete S.drafts[draftKey()];
      S.stick = true;
      if (res && res.message) {
        if (!S.messages.some(function (m) { return m.id === res.message.id; })) S.messages.push(res.message);
        renderTranscript();
        scrollToBottom(true);
        bumpListPreview(res.message.kind === 'image' ? 'Photo' : 'Attachment');
        cachePut(S.conv.id, snapshot());
      }
    } catch (e) {
      setComposerError(e && e.message ? e.message : 'Attachment not sent. Check your connection and try again.');
    } finally {
      S.sending = false;
      S.inflight = Math.max(0, S.inflight - 1);
      send.classList.remove('is-busy');
      send.innerHTML = icon('send');
      var i2 = el('bbgInput');
      if (i2) i2.dispatchEvent(new Event('input'));
    }
  }

  async function uploadAttachment(file, caption, replyId) {
    var fd = new FormData();
    fd.append('file', file);
    if (caption) fd.append('body', caption);
    if (replyId) fd.append('reply_to_id', replyId);
    var headers = {};
    if (window.currentUser && window.currentUser.token) headers.Authorization = 'Bearer ' + window.currentUser.token;
    // `API` is a top-level `const` in index.html: it lives in the global lexical
    // environment shared by classic scripts, not on `window`, so read it directly.
    var base = (typeof API !== 'undefined' && API) ? API : '';
    var res = await fetch(base + '/api/groups/' + encodeURIComponent(S.groupId) + '/attachments', {
      method: 'POST', headers: headers, body: fd
    });
    var text = await res.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Upload failed (' + res.status + ')');
    return data;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE POLL
  // ══════════════════════════════════════════════════════════════════════════

  function pollDelay() {
    if (document.hidden) return POLL_HIDDEN_MS;
    return document.hasFocus() ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  }

  function startPoll() {
    stopPoll();
    S.pollTimer = setTimeout(function tick() {
      poll().finally(function () {
        if (S.convId != null) S.pollTimer = setTimeout(tick, pollDelay());
      });
    }, pollDelay());
  }

  function stopPoll() {
    if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
  }

  function startListPoll() {
    if (S.listTimer) clearInterval(S.listTimer);
    S.listTimer = setInterval(function () {
      if (document.hidden) return;
      BBG.refreshList();
    }, LIST_POLL_MS);
  }

  BBG.stop = function () {
    stopPoll();
    if (S.listTimer) { clearInterval(S.listTimer); S.listTimer = null; }
  };

  function onVisibility() {
    if (document.hidden) return;
    if (S.convId != null) { poll(); startPoll(); }
    BBG.refreshList();
  }

  async function poll(force) {
    if (S.conv == null) return;
    // Never race an optimistic send or reaction; the next tick catches up.
    if (S.inflight > 0 && !force) return;
    return isDirect() ? pollDirect() : pollGroup();
  }

  /**
   * One group sync round. New messages ride the `seq` cursor; edits, deletes and
   * reactions move no cursor, so a bounded recent window is re-read and
   * reconciled in place.
   */
  async function pollGroup() {
    var gid = S.groupId;
    if (!gid) return;
    try {
      var res = await api('GET', '/api/groups/' + encodeURIComponent(gid)
        + '/updates?since=' + encodeURIComponent(S.maxSeq) + '&rev=' + encodeURIComponent(S.rev));
      if (S.groupId !== gid || !res || res.error) return;
      // A send or reaction started while this poll was on the wire; its own
      // settle() owns the next render, and this stale answer must not clobber it.
      if (S.inflight > 0) return;

      var wasBottom = S.stick, changed = false;

      if (res.archived != null && S.group && !!res.archived !== !!S.group.archived) {
        S.group.archived = !!res.archived;
        if (S.me) S.me.canPost = !res.archived;
        renderComposer();
      }

      // Nothing happened — the server answered from a single query. Only read
      // receipts can have moved.
      if (res.unchanged) {
        if (applyReaders(res.readers)) renderTranscript();
        return;
      }
      S.rev = Number(res.rev || S.rev);

      if (Array.isArray(res.members) && res.members.length) {
        var before = S.members.map(function (m) { return m.userId + ':' + m.groupRole; }).join('|');
        var after = res.members.map(function (m) { return m.userId + ':' + m.groupRole; }).join('|');
        if (before !== after) {
          S.members = res.members;
          renderHeader();
          if (S.detailsOpen) renderDetails();
          changed = true;
        }
      }

      if (res.messages && res.messages.length) {
        var known = {};
        S.messages.forEach(function (m) { known[m.id] = true; });
        var fresh = res.messages.filter(function (m) { return !known[m.id]; });
        if (fresh.length) {
          S.messages = S.messages.concat(fresh);
          // Keep server order; unconfirmed bubbles (seq = MAX) stay at the end.
          S.messages.sort(function (a, b) { return Number(a.seq) - Number(b.seq); });
          changed = true;
        }
        S.maxSeq = Math.max(S.maxSeq, Number(res.maxSeq || 0));
      } else if (res.maxSeq != null) {
        S.maxSeq = Math.max(S.maxSeq, Number(res.maxSeq));
      }

      if (res.recent && res.recent.length) {
        var byId = {};
        S.messages.forEach(function (m) { byId[m.id] = m; });
        res.recent.forEach(function (r) {
          var m = byId[r.id];
          if (!m) return;
          if (JSON.stringify(m.reactions || []) !== JSON.stringify(r.reactions || [])) { m.reactions = r.reactions; changed = true; }
          if (!!m.deleted !== !!r.deleted) { m.deleted = r.deleted; m.kind = r.kind; m.body = ''; changed = true; }
          if (!m.deleted && m.body !== r.body) { m.body = r.body; m.editedAt = r.editedAt; changed = true; }
          if (m.editedAt !== r.editedAt) { m.editedAt = r.editedAt; changed = true; }
        });
      }

      if (applyReaders(res.readers)) changed = true;

      if (changed) {
        cachePut(S.conv.id, snapshot());
        renderTranscript();
        if (wasBottom) { scrollToBottom(); markRead(); }
        else renderJumpPill();
      }
    } catch (e) { /* a dropped poll is recovered by the next one */ }
  }

  /** Update members' read cursors; true when any moved (ticks need a redraw). */
  function applyReaders(readers) {
    if (!Array.isArray(readers)) return false;
    var moved = false;
    readers.forEach(function (r) {
      var m = S.members.find(function (x) { return String(x.userId) === String(r.userId); });
      if (m && Number(m.lastReadSeq || 0) !== Number(r.lastReadSeq || 0)) {
        m.lastReadSeq = Number(r.lastReadSeq || 0);
        moved = true;
      }
    });
    return moved;
  }

  /**
   * Direct threads have no cursor endpoint, so the whole (small) transcript is
   * re-fetched and compared. Re-rendering only on a real change keeps the
   * reader's scroll position and selection intact.
   */
  async function pollDirect() {
    var tid = S.convId;
    if (!tid) return;
    try {
      var msgs = await api('GET', '/api/threads/' + encodeURIComponent(tid) + '/messages');
      if (S.convId !== tid || !Array.isArray(msgs) || S.inflight > 0) return;
      var mapped = withPending(mapDirect(msgs, S.conv));
      var same = mapped.length === S.messages.length
        && (!mapped.length || mapped[mapped.length - 1].id === S.messages[S.messages.length - 1].id);
      if (same) return;
      var wasBottom = S.stick;
      S.messages = mapped;
      S.maxSeq = mapped.length;
      cachePut(S.conv.id, snapshot());
      renderTranscript();
      if (wasBottom) { scrollToBottom(); markRead(); }
      else renderJumpPill();
    } catch (e) { /* recovered by the next poll */ }
  }

  /**
   * Move our read mark forward. Groups have a server-side cursor; direct threads
   * have no column for one, so they use a per-device localStorage mark — the
   * same approach the app already uses for its coach badge.
   */
  function markRead() {
    if (S.conv == null) return;
    if (isDirect()) {
      if (!S.convId) return;
      lsSet(DM_SEEN + S.convId, new Date().toISOString());
      var row = S.conversations.find(function (c) { return c.id === S.conv.id; });
      if (row && (row.unread || row.unreadDot)) {
        row.unread = 0;
        row.unreadDot = false;
        renderList(); updateListSub(); publishUnread();
      }
      return;
    }
    if (!S.me || !S.me.isMember || !S.maxSeq) return;
    if (Number(S.me.lastReadSeq || 0) >= Number(S.maxSeq)) return;
    S.me.lastReadSeq = S.maxSeq;
    api('POST', '/api/groups/' + encodeURIComponent(S.groupId) + '/read', { seq: S.maxSeq })
      .then(function () {
        var c = S.conversations.find(function (x) { return x.id === S.groupId; });
        if (c) { c.unread = 0; renderList(); updateListSub(); publishUnread(); }
      })
      .catch(function () { /* retried on the next scroll or poll */ });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE ACTIONS
  // ══════════════════════════════════════════════════════════════════════════

  /** The reaction list as it will look after this member taps `emoji`. */
  function localToggle(list, emoji) {
    var hadThis = list.some(function (r) { return r.emoji === emoji && r.mine; });
    var out = [];
    list.forEach(function (r) {
      var c = { emoji: r.emoji, count: r.count, mine: r.mine, names: (r.names || []).slice() };
      // One reaction per member: whatever was mine goes first.
      if (c.mine) { c.count -= 1; c.mine = false; }
      if (c.count > 0) out.push(c);
    });
    if (!hadThis) {
      var ex = out.find(function (r) { return r.emoji === emoji; });
      if (ex) { ex.count += 1; ex.mine = true; }
      else out.push({ emoji: emoji, count: 1, mine: true, names: [] });
    }
    return out.sort(function (a, b) { return b.count - a.count || a.emoji.localeCompare(b.emoji); });
  }

  /** Reactions flip on screen immediately; the server's answer reconciles. */
  async function toggleReaction(messageId, emoji) {
    if (isDirect()) return;
    var m = S.messages.find(function (x) { return x.id === messageId; });
    if (!m || m.pending || m.failed) return;
    var before = m.reactions || [];
    var gid = S.groupId;
    m.reactions = localToggle(before, emoji);
    renderTranscript();
    S.inflight++;
    try {
      var res = await api('POST', '/api/groups/' + encodeURIComponent(gid)
        + '/messages/' + encodeURIComponent(messageId) + '/reactions', { emoji: emoji });
      if (res && res.error) { m.reactions = before; toast(res.error, true); }
      else if (res && Array.isArray(res.reactions)) m.reactions = res.reactions;
    } catch (e) {
      m.reactions = before;
      toast('Could not save that reaction.', true);
    } finally {
      S.inflight = Math.max(0, S.inflight - 1);
      if (S.groupId === gid) {
        renderTranscript();
        cachePut(S.conv.id, snapshot());
      }
    }
  }

  function openMessageActions(messageId) {
    var m = S.messages.find(function (x) { return x.id === messageId; });
    if (!m || m.deleted || m.pending) return;

    if (m.failed) {
      var fs = sheet(
        '<button type="button" class="bbg-sheet-item" data-act="retry"><span>&#8635;</span><span>Try again</span></button>'
        + '<button type="button" class="bbg-sheet-item is-danger" data-act="discard"><span>&#128465;</span><span>Discard</span></button>');
      Array.prototype.forEach.call(fs.querySelectorAll('.bbg-sheet-item'), function (b) {
        b.onclick = function () {
          fs.remove();
          if (b.getAttribute('data-act') === 'retry') retrySend(m.id);
          else { S.messages = S.messages.filter(function (x) { return x !== m; }); renderTranscript(); }
        };
      });
      return;
    }

    // A direct thread's table stores only id/sender/body/time — no reactions,
    // replies, edits or deletes. Offer only what it can actually do.
    if (isDirect()) {
      if (!m.body) return;
      var sheetD = sheet('<button type="button" class="bbg-sheet-item" data-act="copy"><span>⧉</span><span>Copy text</span></button>');
      wire(sheetD, m);
      return;
    }

    var own = !!m.mine;
    var canEdit = own && m.kind === 'text' && (Date.now() - new Date(m.createdAt).getTime()) < EDIT_WINDOW_MS;
    var canDelete = own || (S.me && S.me.canManage);
    var mine = (m.reactions || []).filter(function (r) { return r.mine; }).map(function (r) { return r.emoji; });

    function item(act, ico, label, danger) {
      return '<button type="button" class="bbg-sheet-item' + (danger ? ' is-danger' : '') + '" data-act="' + act + '">'
        + '<span>' + ico + '</span><span>' + esc(label) + '</span></button>';
    }
    var body = '<div class="bbg-sheet-reacts">'
      + S.reactionChoices.map(function (e) {
          return '<button type="button" data-emoji="' + esc(e) + '"'
            + (mine.indexOf(e) >= 0 ? ' class="is-mine"' : '') + '>' + e + '</button>';
        }).join('')
      + '</div>'
      + item('reply', '↩', 'Reply')
      + (m.body ? item('copy', '⧉', 'Copy text') : '')
      + (canEdit ? item('edit', '✎', 'Edit message') : '')
      + item('forward', '⇪', 'Forward to another group')
      + item('info', 'ⓘ', 'Message info')
      + (own ? '' : item('report', '⚑', 'Report message'))
      + (canDelete ? item('delete', '🗑', own ? 'Delete message' : 'Remove message', true) : '');
    wire(sheet(body), m);
  }

  function sheet(bodyHtml) {
    var wrap = document.createElement('div');
    wrap.className = 'bbg-sheet-backdrop bbg';
    wrap.innerHTML = '<div class="bbg-sheet"><div class="bbg-sheet-grip"></div>' + bodyHtml + '</div>';
    document.body.appendChild(wrap);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    return wrap;
  }

  function wire(sheetEl, m) {
    Array.prototype.forEach.call(sheetEl.querySelectorAll('.bbg-sheet-reacts button'), function (b) {
      b.onclick = function () { sheetEl.remove(); toggleReaction(m.id, b.getAttribute('data-emoji')); };
    });
    Array.prototype.forEach.call(sheetEl.querySelectorAll('.bbg-sheet-item'), function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-act');
        sheetEl.remove();
        runAction(act, m);
      };
    });
  }

  async function runAction(act, m) {
    if (act === 'reply') return setReply(m);
    if (act === 'copy') return copyText(m.body);
    if (act === 'edit') return editMessage(m);
    if (act === 'delete') return deleteMessage(m);
    if (act === 'info') return messageInfo(m);
    if (act === 'report') return reportMessage(m);
    if (act === 'forward') return forwardMessage(m);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text || '')
        .then(function () { toast('Copied to clipboard.'); })
        .catch(function () { toast('Could not copy.', true); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text || '';
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard.'); }
    catch (e) { toast('Could not copy.', true); }
    document.body.removeChild(ta);
  }

  function editMessage(m) {
    promptModal('Edit message', m.body, 'Save', async function (val) {
      if (!val.trim()) return 'Message cannot be empty.';
      var res = await api('PATCH', '/api/groups/' + encodeURIComponent(S.groupId)
        + '/messages/' + encodeURIComponent(m.id), { body: val.trim() });
      if (res && res.error) return res.error;
      m.body = val.trim();
      m.editedAt = new Date().toISOString();
      renderTranscript();
      cachePut(S.conv.id, snapshot());
      return null;
    });
  }

  function deleteMessage(m) {
    confirmModal('Delete message?', 'This removes it for everyone in the group. It cannot be undone.', 'Delete', async function () {
      var res = await api('DELETE', '/api/groups/' + encodeURIComponent(S.groupId)
        + '/messages/' + encodeURIComponent(m.id));
      if (res && res.error) { toast(res.error, true); return; }
      m.deleted = true; m.body = ''; m.reactions = [];
      renderTranscript();
      cachePut(S.conv.id, snapshot());
      BBG.refreshList();
    });
  }

  async function messageInfo(m) {
    try {
      var res = await api('GET', '/api/groups/' + encodeURIComponent(S.groupId)
        + '/messages/' + encodeURIComponent(m.id) + '/info');
      if (res && res.error) { toast(res.error, true); return; }
      var body = '<div class="bbg-field"><span class="bbg-field-label">Sent</span>'
        + '<div style="font-size:13.5px">' + esc(new Date(res.sentAt).toLocaleString()) + '</div></div>'
        + '<div class="bbg-field"><span class="bbg-field-label">Read by ' + res.readBy.length + '</span>'
        + (res.readBy.length
            ? res.readBy.map(function (r) { return '<div class="bbg-review-row">' + esc(r.name) + '<b>' + esc(r.roleLabel) + '</b></div>'; }).join('')
            : '<div class="bbg-field-hint">Nobody has opened it yet.</div>')
        + '</div>';
      if (res.pending.length) {
        body += '<div class="bbg-field"><span class="bbg-field-label">Delivered, not yet read</span>'
          + res.pending.map(function (r) { return '<div class="bbg-review-row">' + esc(r.name) + '<b>' + esc(r.roleLabel) + '</b></div>'; }).join('')
          + '</div>';
      }
      infoModal('Message info', body);
    } catch (e) { toast('Could not load message info.', true); }
  }

  function reportMessage(m) {
    promptModal('Report message', '', 'Send report', async function (val) {
      var res = await api('POST', '/api/groups/' + encodeURIComponent(S.groupId)
        + '/messages/' + encodeURIComponent(m.id) + '/report', { reason: val.trim() });
      if (res && res.error) return res.error;
      toast('Reported. An admin will review this message.');
      return null;
    }, 'Tell us what is wrong with this message (optional)');
  }

  function forwardMessage(m) {
    var targets = S.conversations.filter(function (c) {
      return c.type === 'group' && c.id !== S.groupId && !c.archived;
    });
    if (!targets.length) { toast('There is no other group to forward this to.'); return; }
    var body = '<div class="bbg-picker">' + targets.map(function (c) {
      return '<button type="button" class="bbg-pick" data-id="' + esc(c.id) + '">'
        + avatarHtml(c.clientName || c.name, c.avatarUrl || c.clientAvatar, 'bbg-avatar--sm bbg-avatar--group')
        + '<div class="bbg-pick-body"><div class="bbg-pick-name">' + esc(c.name) + '</div>'
        + '<div class="bbg-pick-sub">' + esc(c.memberCount + ' members') + '</div></div></button>';
    }).join('') + '</div>';
    var modal = infoModal('Forward message', body);
    Array.prototype.forEach.call(modal.querySelectorAll('.bbg-pick'), function (b) {
      b.onclick = async function () {
        if (!m.body) { toast('Only text messages can be forwarded.'); return; }
        var res = await api('POST', '/api/groups/' + encodeURIComponent(b.getAttribute('data-id')) + '/messages', { body: m.body });
        closeModal(modal);
        if (res && res.error) { toast(res.error, true); return; }
        toast('Message forwarded.');
        BBG.refreshList();
      };
    });
  }

  function lightbox(src) {
    var d = document.createElement('div');
    d.className = 'bbg-lightbox bbg';
    d.innerHTML = '<img src="' + esc(src) + '" alt="">';
    d.onclick = function () { d.remove(); };
    document.body.appendChild(d);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SEARCH
  // ══════════════════════════════════════════════════════════════════════════

  function toggleSearch() {
    var host = el('bbgSearchHost');
    if (S.searchOpen) { host.innerHTML = ''; S.searchOpen = false; return; }
    if (S.convId == null) return;
    S.searchOpen = true;
    host.innerHTML = '<div class="bbg-searchres" id="bbgSearchRes">'
      + '<div style="padding:12px 16px"><input type="search" id="bbgMsgSearch" placeholder="Search in this conversation" '
      + 'style="width:100%;padding:10px 13px;border-radius:11px;background:#141414;border:1px solid rgba(255,255,255,.1);color:#f4f1ea;font-family:Outfit,sans-serif;font-size:14px" autocomplete="off"></div>'
      + '<div id="bbgSearchList"></div></div>';
    var inp = el('bbgMsgSearch');
    inp.focus();
    var t = null;
    inp.oninput = function () {
      clearTimeout(t);
      var q = inp.value.trim();
      t = setTimeout(function () { runSearch(q); }, 260);
    };
  }

  async function runSearch(q) {
    var list = el('bbgSearchList');
    if (!list) return;
    if (q.length < 2) { list.innerHTML = hint('Type at least 2 characters.'); return; }
    try {
      var rows;
      if (isDirect()) {
        // The whole direct transcript is already loaded, so filter locally
        // rather than adding a search endpoint to the legacy thread API.
        var needle = q.toLowerCase();
        rows = S.messages.filter(function (m) { return String(m.body || '').toLowerCase().indexOf(needle) >= 0; })
          .slice(-50).reverse()
          .map(function (m) { return { id: m.id, body: m.body, createdAt: m.createdAt, senderName: m.senderName, roleLabel: m.senderRoleLabel }; });
      } else {
        var res = await api('GET', '/api/groups/' + encodeURIComponent(S.groupId) + '/search?q=' + encodeURIComponent(q));
        rows = (res && res.results) || [];
      }
      if (!rows.length) { list.innerHTML = hint('No messages found.'); return; }
      list.innerHTML = rows.map(function (r) {
        return '<button type="button" data-id="' + esc(r.id) + '">'
          + '<div class="bbg-searchres-who">' + esc(r.senderName) + (r.roleLabel ? ' · ' + esc(r.roleLabel) : '')
          + ' <span style="color:#6b6760;font-weight:400">' + esc(fmtListTime(r.createdAt)) + '</span></div>'
          + '<div class="bbg-searchres-body">' + mark(r.body, q) + '</div></button>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('button'), function (b) {
        b.onclick = function () { toggleSearch(); gotoMessage(b.getAttribute('data-id')); };
      });
    } catch (e) {
      list.innerHTML = '<div style="padding:14px 16px;color:#e8836f;font-size:12.5px">Search failed.</div>';
    }
    function hint(t) { return '<div style="padding:14px 16px;color:#6b6760;font-size:12.5px">' + t + '</div>'; }
  }

  /** Highlight the needle inside already-escaped text. */
  function mark(body, q) {
    var safe = esc(body);
    var needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return safe.replace(new RegExp('(' + needle + ')', 'ig'), '<mark>$1</mark>'); }
    catch (e) { return safe; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONVERSATION MENU + DETAILS
  // ══════════════════════════════════════════════════════════════════════════

  function openConvMenu() {
    if (S.conv == null) return;
    var rows = [['info', 'ⓘ', isDirect() ? 'Conversation info' : 'Group info'], ['search', '🔍', 'Search messages']];
    if (!isDirect()) {
      if (S.me && S.me.isMember) rows.push(['mute', S.me.muted ? '🔕' : '🔔', S.me.muted ? 'Unmute notifications' : 'Mute notifications']);
      if (S.me && S.me.canManage) {
        rows.push(['rename', '✎', 'Edit group name']);
        rows.push(['archive', '📦', S.group.archived ? 'Reopen group' : 'Archive group']);
        rows.push(['activity', '📋', 'View group activity']);
      }
      if (S.me && S.me.isMember && String(S.me.userId) !== String(S.group.clientId)) {
        rows.push(['leave', '↩', 'Leave group', true]);
      }
    }
    var s = sheet(rows.map(function (r) {
      return '<button type="button" class="bbg-sheet-item' + (r[3] ? ' is-danger' : '') + '" data-act="' + r[0] + '">'
        + '<span>' + r[1] + '</span><span>' + esc(r[2]) + '</span></button>';
    }).join(''));
    Array.prototype.forEach.call(s.querySelectorAll('.bbg-sheet-item'), function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-act');
        s.remove();
        if (act === 'search') { toggleSearch(); return; }
        if (act === 'info') { openDetails(); return; }
        // Group info owns the implementation of each remaining action; open it
        // and click the matching row so there is one code path per action.
        openDetails();
        setTimeout(function () {
          var map = { mute: 'bbgMute', rename: 'bbgRename', archive: 'bbgArchive', activity: 'bbgActivity', leave: 'bbgLeave' };
          var target = el(map[act]);
          if (target) target.click();
        }, 40);
      };
    });
  }

  function toggleDetails() { S.detailsOpen ? closeDetails() : openDetails(); }

  /**
   * On desktop, showing/hiding the details column resizes the chat column, which
   * reflows the transcript and silently moves the reader off the newest message.
   */
  function restickAfterLayout() {
    if (!S.stick) return;
    requestAnimationFrame(function () { scrollToBottom(); });
    setTimeout(function () { if (S.stick) scrollToBottom(); }, 180);
  }

  function closeDetails() {
    S.detailsOpen = false;
    var shell = el('bbgShell');
    if (shell) shell.classList.remove('has-details');
    setPane('chat');
    restickAfterLayout();
  }

  async function openDetails() {
    if (S.conv == null) return;
    S.detailsOpen = true;
    var shell = el('bbgShell');
    if (shell) shell.classList.add('has-details');
    if (!isDesktop()) setPane('details');
    el('bbgDetailsTitle').textContent = isDirect() ? 'Conversation info' : 'Group info';
    renderDetails();
    restickAfterLayout();
    if (isDirect()) return;
    try {
      S.media = await api('GET', '/api/groups/' + encodeURIComponent(S.groupId) + '/media');
      if (S.detailsOpen) renderDetails();
    } catch (e) { /* media is a nice-to-have */ }
  }

  function renderDetails() {
    var box = el('bbgDetailsBody');
    if (!box) return;
    if (isDirect()) { renderDirectDetails(box); return; }
    if (!S.group) return;

    var g = S.group;
    var canManage = !!(S.me && S.me.canManage);

    var h = '<div class="bbg-details-hero">'
      + avatarHtml(g.clientName || g.name, g.avatarUrl || g.clientAvatar, 'bbg-avatar--lg bbg-avatar--group')
      + '<div class="bbg-details-name">' + esc(g.name) + '</div>'
      + '<div class="bbg-details-meta">'
      +   esc(g.clientName) + ' · Client Care Team<br>'
      +   S.members.length + ' member' + (S.members.length === 1 ? '' : 's')
      +   ' · created ' + esc(new Date(g.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))
      +   (g.archived ? '<br><span style="color:#c8a44e">Archived — read only</span>' : '')
      + '</div></div>';

    h += '<div class="bbg-details-sec"><div class="bbg-details-label">Participants</div>'
      + S.members.map(function (m) {
          return '<div class="bbg-member">' + avatarHtml(m.name, m.avatar, 'bbg-avatar--sm')
            + '<div class="bbg-member-body"><div class="bbg-member-name">' + esc(m.name)
            + (String(m.userId) === String(S.me.userId) ? ' <span style="color:#6b6760;font-weight:400">(you)</span>' : '')
            + '</div><div class="bbg-member-role"><b>' + esc(m.roleLabel) + '</b>'
            + (m.email ? ' · ' + esc(m.email) : '') + '</div></div>'
            + (canManage && String(m.userId) !== String(g.clientId)
                ? '<button type="button" class="bbg-iconbtn" data-remove="' + esc(m.userId) + '" title="Remove from group" aria-label="Remove ' + esc(m.name) + '">' + icon('close') + '</button>'
                : '')
            + '</div>';
        }).join('')
      + (canManage ? '<button type="button" class="bbg-action" id="bbgAddMember"><span>＋</span>Add member</button>' : '')
      + '</div>';

    var media = S.media || { files: [], links: [] };
    var images = (media.files || []).filter(function (f) { return f.isImage; });
    var docs = (media.files || []).filter(function (f) { return !f.isImage; });
    h += '<div class="bbg-details-sec"><div class="bbg-details-label">Shared files &amp; links</div>';
    if (!media.files.length && !(media.links || []).length) {
      h += '<div class="bbg-field-hint" style="margin:0">Nothing shared in this group yet.</div>';
    } else {
      if (images.length) {
        h += '<div class="bbg-media-grid">' + images.slice(0, 12).map(function (f) {
          return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener"><img src="' + esc(f.url) + '" alt="' + esc(f.name) + '" loading="lazy"></a>';
        }).join('') + '</div>';
      }
      if (docs.length) {
        h += '<div style="margin-top:10px">' + docs.slice(0, 8).map(function (f) {
          return '<a class="bbg-att-file" href="' + esc(f.url) + '" target="_blank" rel="noopener" style="margin-bottom:6px">'
            + '<span class="bbg-att-icon">📄</span><span class="bbg-att-meta">'
            + '<span class="bbg-att-name">' + esc(f.name) + '</span>'
            + '<span class="bbg-att-size">' + esc(fmtBytes(f.size)) + ' · ' + esc(f.senderName) + '</span></span></a>';
        }).join('') + '</div>';
      }
      if ((media.links || []).length) {
        h += '<div class="bbg-linklist" style="margin-top:8px">' + media.links.slice(0, 8).map(function (l) {
          return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.url) + '</a>';
        }).join('') + '</div>';
      }
    }
    h += '</div>';

    h += '<div class="bbg-details-sec"><div class="bbg-details-label">Actions</div>'
      + '<button type="button" class="bbg-action" id="bbgDetailSearch"><span>🔍</span>Search messages</button>'
      + (S.me.isMember
          ? '<button type="button" class="bbg-action" id="bbgMute"><span>' + (S.me.muted ? '🔕' : '🔔') + '</span>'
            + 'Notifications<span class="bbg-action-toggle">' + (S.me.muted ? 'Muted' : 'On') + '</span></button>'
          : '')
      + (canManage ? '<button type="button" class="bbg-action" id="bbgRename"><span>✎</span>Edit group name</button>' : '')
      + (canManage ? '<button type="button" class="bbg-action" id="bbgAvatar"><span>🖼</span>Change group avatar</button>' : '')
      + (canManage ? '<button type="button" class="bbg-action" id="bbgArchive"><span>📦</span>'
            + (g.archived ? 'Reopen group' : 'Archive group') + '</button>' : '')
      + (canManage ? '<button type="button" class="bbg-action" id="bbgActivity"><span>📋</span>View group activity</button>' : '')
      + (S.me.isMember && String(S.me.userId) !== String(g.clientId)
          ? '<button type="button" class="bbg-action is-danger" id="bbgLeave"><span>↩</span>Leave group</button>' : '')
      + '</div>';

    box.innerHTML = h;
    bindDetails();
  }

  /** A direct thread has no members table — show who is in it and little else. */
  function renderDirectDetails(box) {
    var c = S.conv || {};
    box.innerHTML = '<div class="bbg-details-hero">'
      + avatarHtml(c.name, c.avatarUrl, 'bbg-avatar--lg')
      + '<div class="bbg-details-name">' + esc(c.name) + '</div>'
      + '<div class="bbg-details-meta">' + esc(c.subtitle || 'Direct message')
      + (c.email ? '<br>' + esc(c.email) : '') + '</div></div>'
      + '<div class="bbg-details-sec"><div class="bbg-details-label">About this chat</div>'
      + '<div class="bbg-field-hint" style="margin:0">'
      + (S.mode === 'admin'
          ? 'A private thread between this client and the coaching team. Care-team members cannot see it — use the client\'s care group for anything the doctor, lifestyle manager or operator should also read.'
          : 'A private thread between you and your Lifestyle Manager. Nobody in your care group can see it.')
      + '</div></div>'
      + '<div class="bbg-details-sec"><div class="bbg-details-label">Actions</div>'
      + '<button type="button" class="bbg-action" id="bbgDetailSearch"><span>🔍</span>Search messages</button></div>';
    var s = el('bbgDetailSearch');
    if (s) s.onclick = function () { if (!isDesktop()) setPane('chat'); toggleSearch(); };
  }

  function bindDetails() {
    var box = el('bbgDetailsBody');
    var on = function (id, fn) { var e = el(id); if (e) e.onclick = fn; };

    on('bbgDetailSearch', function () { if (!isDesktop()) setPane('chat'); toggleSearch(); });
    on('bbgMute', async function () {
      var next = !S.me.muted;
      var res = await api('POST', '/api/groups/' + encodeURIComponent(S.groupId) + '/mute', { muted: next });
      if (res && res.error) { toast(res.error, true); return; }
      S.me.muted = next;
      renderDetails();
      BBG.refreshList();
    });
    on('bbgRename', function () {
      promptModal('Edit group name', S.group.name, 'Save', async function (val) {
        if (!val.trim()) return 'Group name cannot be empty.';
        var res = await api('PATCH', '/api/groups/' + encodeURIComponent(S.groupId), { name: val.trim() });
        if (res && res.error) return res.error;
        S.group.name = val.trim();
        renderHeader(); renderDetails(); BBG.refreshList();
        return null;
      });
    });
    on('bbgAvatar', function () {
      promptModal('Group avatar', S.group.avatarUrl || '', 'Save', async function (val) {
        var res = await api('PATCH', '/api/groups/' + encodeURIComponent(S.groupId), { avatar_url: val.trim() });
        if (res && res.error) return res.error;
        S.group.avatarUrl = val.trim();
        renderHeader(); renderDetails(); BBG.refreshList();
        return null;
      }, 'Paste an image URL, or leave blank to use the client\'s initials');
    });
    on('bbgArchive', function () {
      var next = !S.group.archived;
      confirmModal(
        next ? 'Archive this group?' : 'Reopen this group?',
        next ? 'The conversation stays readable but nobody can send new messages until it is reopened.'
             : 'Members will be able to send messages again.',
        next ? 'Archive' : 'Reopen',
        async function () {
          var res = await api('PATCH', '/api/groups/' + encodeURIComponent(S.groupId), { archived: next });
          if (res && res.error) { toast(res.error, true); return; }
          S.group.archived = next;
          S.me.canPost = !next;
          renderComposer(); renderDetails(); BBG.refreshList();
        }
      );
    });
    on('bbgActivity', showActivity);
    on('bbgAddMember', openAddMember);
    on('bbgLeave', function () {
      confirmModal('Leave this group?', 'You will stop receiving messages from this care team.', 'Leave', async function () {
        var res = await api('DELETE', '/api/groups/' + encodeURIComponent(S.groupId) + '/members/' + encodeURIComponent(S.me.userId));
        if (res && res.error) { toast(res.error, true); return; }
        S.conv = null; S.convId = null; S.groupId = null; S.kind = null;
        stopPoll(); closeDetails(); setPane('list'); BBG.refreshList();
      });
    });

    Array.prototype.forEach.call(box.querySelectorAll('[data-remove]'), function (b) {
      b.onclick = function () {
        var uid = b.getAttribute('data-remove');
        var m = S.members.find(function (x) { return String(x.userId) === String(uid); });
        confirmModal('Remove ' + (m ? m.name : 'this member') + '?',
          'They will lose access to this conversation. Past messages stay in the transcript.',
          'Remove', async function () {
            var res = await api('DELETE', '/api/groups/' + encodeURIComponent(S.groupId) + '/members/' + encodeURIComponent(uid));
            if (res && res.error) { toast(res.error, true); return; }
            S.members = res.members || S.members;
            renderHeader(); renderDetails(); poll(true);
          });
      };
    });
  }

  async function showActivity() {
    try {
      var res = await api('GET', '/api/groups/' + encodeURIComponent(S.groupId) + '/audit');
      if (res && res.error) { toast(res.error, true); return; }
      var rows = res.events || [];
      infoModal('Group activity', rows.length
        ? rows.map(function (e) {
            return '<div class="bbg-review-row" style="align-items:flex-start">'
              + '<div><div style="font-size:13.5px">' + esc(e.detail || e.action) + '</div>'
              + '<div style="font-size:11.5px;color:#6b6760">' + esc(e.actor_name || 'System') + ' · '
              + esc(new Date(e.created_at).toLocaleString()) + '</div></div></div>';
          }).join('')
        : '<div class="bbg-field-hint">No activity recorded yet.</div>');
    } catch (e) { toast('Could not load activity.', true); }
  }

  async function openAddMember() {
    try {
      var data = await api('GET', '/api/groups/candidates');
      if (data && data.error) { toast(data.error, true); return; }
      var inGroup = {};
      S.members.forEach(function (m) { inGroup[String(m.userId)] = true; });
      var pool = (data.staff || []).concat(data.clients || []).filter(function (p) { return !inGroup[String(p.id)]; });
      if (!pool.length) { toast('Everyone available is already in this group.'); return; }

      var roleOpts = (data.roles || []).filter(function (r) { return r.value !== 'client'; });
      var modal = infoModal('Add member',
        '<div class="bbg-field"><span class="bbg-field-label">Search</span>'
        + '<input type="search" id="bbgAddSearch" placeholder="Search by name or email" autocomplete="off"></div>'
        + '<div class="bbg-field"><span class="bbg-field-label">Role in this group</span>'
        + '<select id="bbgAddRole">' + roleOpts.map(function (r) {
            return '<option value="' + esc(r.value) + '">' + esc(r.label) + '</option>';
          }).join('') + '</select>'
        + '<div class="bbg-field-hint">This label applies inside this group only — it does not change the person\'s BodyBank account role.</div></div>'
        + '<div class="bbg-picker" id="bbgAddList"></div>');

      function draw(q) {
        q = (q || '').toLowerCase();
        var rows = pool.filter(function (p) {
          return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.email.toLowerCase().indexOf(q) >= 0;
        }).slice(0, 60);
        el('bbgAddList').innerHTML = rows.length ? rows.map(function (p) {
          return '<button type="button" class="bbg-pick" data-id="' + esc(p.id) + '">'
            + avatarHtml(p.name, p.avatar, 'bbg-avatar--sm')
            + '<div class="bbg-pick-body"><div class="bbg-pick-name">' + esc(p.name) + '</div>'
            + '<div class="bbg-pick-sub">' + esc(p.email) + ' · ' + esc(p.accountRole) + '</div></div></button>';
        }).join('') : '<div style="padding:14px;color:#6b6760;font-size:12.5px">No matches.</div>';
        Array.prototype.forEach.call(el('bbgAddList').querySelectorAll('.bbg-pick'), function (b) {
          b.onclick = async function () {
            var res = await api('POST', '/api/groups/' + encodeURIComponent(S.groupId) + '/members', {
              user_id: b.getAttribute('data-id'), group_role: el('bbgAddRole').value
            });
            closeModal(modal);
            if (res && res.error) { toast(res.error, true); return; }
            S.members = res.members || S.members;
            renderHeader(); renderDetails(); poll(true);
          };
        });
      }
      el('bbgAddSearch').oninput = function () { draw(this.value); };
      draw('');
    } catch (e) { toast('Could not load people.', true); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODALS
  // ══════════════════════════════════════════════════════════════════════════

  function baseModal(title, bodyHtml, footHtml) {
    var wrap = document.createElement('div');
    wrap.className = 'bbg-modal-backdrop bbg';
    wrap.innerHTML = '<div class="bbg-modal">'
      + '<div class="bbg-modal-head"><div class="bbg-modal-title">' + esc(title) + '</div>'
      + '<button type="button" class="bbg-iconbtn" data-close="1" aria-label="Close">' + icon('close') + '</button></div>'
      + '<div class="bbg-modal-body">' + bodyHtml + '</div>'
      + (footHtml ? '<div class="bbg-modal-foot">' + footHtml + '</div>' : '')
      + '</div>';
    document.body.appendChild(wrap);
    wrap.onclick = function (e) { if (e.target === wrap) closeModal(wrap); };
    var x = wrap.querySelector('[data-close]');
    if (x) x.onclick = function () { closeModal(wrap); };
    return wrap;
  }
  function closeModal(m) { if (m && m.parentNode) m.parentNode.removeChild(m); }
  function infoModal(title, bodyHtml) { return baseModal(title, bodyHtml, ''); }

  /** `onOk(value)` returns an error string to keep the modal open, or null. */
  function promptModal(title, initial, okLabel, onOk, hint) {
    var m = baseModal(title,
      '<div class="bbg-field">'
      + '<textarea id="bbgPromptInput" rows="3" style="width:100%;padding:11px 13px;border-radius:11px;background:#141414;border:1px solid rgba(255,255,255,.1);color:#f4f1ea;font-family:Outfit,sans-serif;font-size:14.5px;resize:vertical">'
      + esc(initial || '') + '</textarea>'
      + (hint ? '<div class="bbg-field-hint">' + esc(hint) + '</div>' : '')
      + '<div class="bbg-field-hint" id="bbgPromptErr" style="color:#e8836f"></div></div>',
      '<button type="button" class="bbg-btn" data-x>Cancel</button>'
      + '<button type="button" class="bbg-btn bbg-btn--primary" data-ok>' + esc(okLabel) + '</button>');
    m.querySelector('[data-x]').onclick = function () { closeModal(m); };
    var ok = m.querySelector('[data-ok]');
    ok.onclick = async function () {
      ok.disabled = true;
      var err = await onOk(m.querySelector('#bbgPromptInput').value);
      if (err) { m.querySelector('#bbgPromptErr').textContent = err; ok.disabled = false; return; }
      closeModal(m);
    };
    var input = m.querySelector('#bbgPromptInput');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return m;
  }

  function confirmModal(title, text, okLabel, onOk) {
    var m = baseModal(title, '<div style="font-size:14px;line-height:1.6;color:#9a958c">' + esc(text) + '</div>',
      '<button type="button" class="bbg-btn" data-x>Cancel</button>'
      + '<button type="button" class="bbg-btn bbg-btn--primary" data-ok>' + esc(okLabel) + '</button>');
    m.querySelector('[data-x]').onclick = function () { closeModal(m); };
    var ok = m.querySelector('[data-ok]');
    ok.onclick = async function () { ok.disabled = true; await onOk(); closeModal(m); };
    return m;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — START A 1-TO-1 WITH A CLIENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Search for a client and open a private chat with them.
   *
   * Search-only on purpose: the inbox deliberately lists just the people the
   * admin has actually talked to, so this is the way to reach everyone else
   * without dumping the whole roster into the UI. The server caps results and
   * matches on name or email.
   */
  BBG.openNewMessage = function () {
    var modal = infoModal('Message a client',
      '<div class="bbg-field"><span class="bbg-field-label">Find a client</span>'
      + '<input type="search" id="bbgDmSearch" placeholder="Search by name or email" autocomplete="off">'
      + '<div class="bbg-field-hint">Opening a chat does not notify anyone — they only hear from you once you send a message.</div></div>'
      + '<div class="bbg-picker" id="bbgDmList"></div>');

    var input = modal.querySelector('#bbgDmSearch');
    var list = modal.querySelector('#bbgDmList');
    var timer = null;
    var reqId = 0;

    function note(t) { list.innerHTML = '<div style="padding:14px;color:#6b6760;font-size:12.5px">' + esc(t) + '</div>'; }

    async function run(q) {
      var mine = ++reqId;
      try {
        var res = await api('GET', '/api/groups/directory?q=' + encodeURIComponent(q));
        // A slower earlier request must not overwrite a newer result.
        if (mine !== reqId) return;
        var rows = (res && res.clients) || [];
        if (!rows.length) { note(q ? 'No client matches that.' : 'No clients yet.'); return; }
        list.innerHTML = rows.map(function (c) {
          return '<button type="button" class="bbg-pick" data-id="' + esc(c.id) + '">'
            + avatarHtml(c.name, c.avatar, 'bbg-avatar--sm')
            + '<div class="bbg-pick-body"><div class="bbg-pick-name">' + esc(c.name) + '</div>'
            + '<div class="bbg-pick-sub">' + esc(c.email) + '</div></div></button>';
        }).join('');
        Array.prototype.forEach.call(list.querySelectorAll('.bbg-pick'), function (b) {
          b.onclick = function () { start(b.getAttribute('data-id'), b); };
        });
      } catch (e) {
        if (mine === reqId) note('Search failed.');
      }
    }

    async function start(userId, btn) {
      if (btn) btn.disabled = true;
      try {
        var res = await api('POST', '/api/groups/direct', { user_id: userId });
        if (!res || res.error || !res.conversation) { toast((res && res.error) || 'Could not open that chat.', true); return; }
        closeModal(modal);
        var conv = res.conversation;
        // Show it in the list straight away. It has no messages yet, so the
        // server will not return it from /inbox until something is sent.
        if (!S.conversations.some(function (c) { return c.id === conv.id; })) {
          S.conversations.unshift(conv);
          renderFilters(); renderList(); updateListSub();
        }
        openConversation(conv);
      } catch (e) {
        toast('Could not open that chat.', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    input.oninput = function () {
      clearTimeout(timer);
      var q = this.value.trim();
      timer = setTimeout(function () { run(q); }, 220);
    };
    input.focus();
    run('');
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — CREATE GROUP WIZARD
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Three steps: pick the client (which fixes the name), staff the care team,
   * then review. The review step is also where the duplicate warning surfaces.
   */
  BBG.openCreateGroup = async function () {
    var data;
    try {
      data = await api('GET', '/api/groups/candidates');
      if (data && data.error) { toast(data.error, true); return; }
    } catch (e) { toast('Could not load clients.', true); return; }

    var W = { step: 1, client: null, picked: [], name: '', force: false };
    var modal = baseModal('Create care group', '<div id="bbgWizBody"></div>',
      '<button type="button" class="bbg-btn" data-back style="margin-right:auto">Back</button>'
      + '<button type="button" class="bbg-btn" data-x>Cancel</button>'
      + '<button type="button" class="bbg-btn bbg-btn--primary" data-next>Next</button>');

    var backBtn = modal.querySelector('[data-back]');
    var nextBtn = modal.querySelector('[data-next]');
    modal.querySelector('[data-x]').onclick = function () { closeModal(modal); };
    backBtn.onclick = function () { if (W.step > 1) { W.step--; draw(); } };
    nextBtn.onclick = function () { advance(); };

    function draw() {
      var b = modal.querySelector('#bbgWizBody');
      backBtn.style.visibility = W.step === 1 ? 'hidden' : 'visible';
      nextBtn.textContent = W.step === 3 ? 'Create group' : 'Next';

      if (W.step === 1) {
        modal.querySelector('.bbg-modal-title').textContent = 'Step 1 — Choose the client';
        b.innerHTML = '<div class="bbg-field"><span class="bbg-field-label">Client</span>'
          + '<input type="search" id="bbgWizSearch" placeholder="Search clients by name or email" autocomplete="off"></div>'
          + '<div class="bbg-picker" id="bbgWizList"></div>';
        var drawClients = function (q) {
          q = (q || '').toLowerCase();
          var rows = (data.clients || []).filter(function (c) {
            return !q || c.name.toLowerCase().indexOf(q) >= 0 || c.email.toLowerCase().indexOf(q) >= 0;
          }).slice(0, 80);
          el('bbgWizList').innerHTML = rows.length ? rows.map(function (c) {
            var active = ((data.existingByClient || {})[c.id] || []).filter(function (d) { return !d.archived; });
            return '<button type="button" class="bbg-pick' + (W.client && W.client.id === c.id ? ' is-picked' : '') + '" data-id="' + esc(c.id) + '">'
              + avatarHtml(c.name, c.avatar, 'bbg-avatar--sm')
              + '<div class="bbg-pick-body"><div class="bbg-pick-name">' + esc(c.name) + '</div>'
              + '<div class="bbg-pick-sub">' + esc(c.email)
              + (active.length ? ' · <span style="color:#c8a44e">already has a group</span>' : '') + '</div></div>'
              + '<div class="bbg-pick-check">✓</div></button>';
          }).join('') : '<div style="padding:14px;color:#6b6760;font-size:12.5px">No clients found.</div>';
          Array.prototype.forEach.call(el('bbgWizList').querySelectorAll('.bbg-pick'), function (btn) {
            btn.onclick = function () {
              W.client = (data.clients || []).find(function (c) { return c.id === btn.getAttribute('data-id'); });
              W.name = W.client ? W.client.name + ' - 2.0' : '';
              W.force = false;
              drawClients(el('bbgWizSearch').value);
            };
          });
        };
        el('bbgWizSearch').oninput = function () { drawClients(this.value); };
        drawClients('');
        return;
      }

      if (W.step === 2) {
        modal.querySelector('.bbg-modal-title').textContent = 'Step 2 — Build the care team';
        var roleOpts = (data.roles || []).filter(function (r) { return r.value !== 'client'; });
        b.innerHTML = '<div class="bbg-review" style="margin-bottom:16px">'
          + '<div class="bbg-review-name">' + esc(W.name) + '</div>'
          + '<div class="bbg-review-row">' + esc(W.client.name) + '<b>Client</b></div></div>'
          + '<div class="bbg-field"><span class="bbg-field-label">Add to the care team</span>'
          + '<input type="search" id="bbgWizStaffSearch" placeholder="Search staff and members" autocomplete="off">'
          + '<div class="bbg-field-hint">Pick a role for each person. The role applies inside this group only — '
          + 'it does not change their BodyBank account role.</div></div>'
          + '<div class="bbg-picker" id="bbgWizStaff"></div>';

        var pool = (data.staff || []).concat((data.clients || []).filter(function (c) { return c.id !== W.client.id; }));
        var drawStaff = function (q) {
          q = (q || '').toLowerCase();
          var rows = pool.filter(function (p) {
            return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.email.toLowerCase().indexOf(q) >= 0;
          }).slice(0, 60);
          el('bbgWizStaff').innerHTML = rows.length ? rows.map(function (p) {
            var pick = W.picked.find(function (x) { return x.user_id === p.id; });
            return '<div class="bbg-pick' + (pick ? ' is-picked' : '') + '" data-id="' + esc(p.id) + '">'
              + avatarHtml(p.name, p.avatar, 'bbg-avatar--sm')
              + '<div class="bbg-pick-body"><div class="bbg-pick-name">' + esc(p.name) + '</div>'
              + '<div class="bbg-pick-sub">' + esc(p.email) + ' · ' + esc(p.accountRole) + '</div></div>'
              + '<select class="bbg-pick-role" data-role-for="' + esc(p.id) + '">'
              + '<option value="">Not in group</option>'
              + roleOpts.map(function (r) {
                  return '<option value="' + esc(r.value) + '"' + (pick && pick.group_role === r.value ? ' selected' : '') + '>'
                    + esc(r.label) + '</option>';
                }).join('') + '</select></div>';
          }).join('') : '<div style="padding:14px;color:#6b6760;font-size:12.5px">No people found.</div>';
          Array.prototype.forEach.call(el('bbgWizStaff').querySelectorAll('[data-role-for]'), function (sel) {
            sel.onchange = function () {
              var uid = sel.getAttribute('data-role-for');
              W.picked = W.picked.filter(function (x) { return x.user_id !== uid; });
              if (sel.value) W.picked.push({ user_id: uid, group_role: sel.value });
              var row = sel.closest('.bbg-pick');
              if (row) row.classList.toggle('is-picked', !!sel.value);
            };
          });
        };
        el('bbgWizStaffSearch').oninput = function () { drawStaff(this.value); };
        drawStaff('');
        return;
      }

      modal.querySelector('.bbg-modal-title').textContent = 'Step 3 — Review and create';
      var nameById = {};
      (data.staff || []).concat(data.clients || []).forEach(function (p) { nameById[p.id] = p; });
      var roleLabel = {};
      (data.roles || []).forEach(function (r) { roleLabel[r.value] = r.label; });

      b.innerHTML = '<div class="bbg-field"><span class="bbg-field-label">Group name</span>'
        + '<input type="text" id="bbgWizName" value="' + esc(W.name) + '" maxlength="160">'
        + '<div class="bbg-field-hint">Generated as <strong>Client Name - 2.0</strong>. You can adjust it here or rename later.</div></div>'
        + '<div class="bbg-review">'
        + '<div class="bbg-review-name">' + esc(W.name) + '</div>'
        + '<div class="bbg-review-row">' + esc(W.client.name) + '<b>Client</b></div>'
        + W.picked.map(function (p) {
            var u = nameById[p.user_id];
            return '<div class="bbg-review-row">' + esc(u ? u.name : p.user_id) + '<b>' + esc(roleLabel[p.group_role] || p.group_role) + '</b></div>';
          }).join('')
        + '<div class="bbg-review-row" style="margin-top:8px;border-top:1px solid rgba(255,255,255,.07);padding-top:9px">'
        + '<span style="color:#9a958c;font-size:12.5px">' + (W.picked.length + 1) + ' members total</span></div></div>'
        + '<div class="bbg-field-hint" id="bbgWizErr" style="color:#e8836f;margin-top:12px"></div>';
      el('bbgWizName').oninput = function () { W.name = this.value; };
    }

    async function advance() {
      if (W.step === 1) {
        if (!W.client) { toast('Pick a client first.'); return; }
        W.step = 2; draw(); return;
      }
      if (W.step === 2) { W.step = 3; draw(); return; }

      nextBtn.disabled = true;
      var errBoxEl = el('bbgWizErr');
      try {
        var res = await api('POST', '/api/groups', {
          client_id: W.client.id, name: W.name.trim(), members: W.picked, force: W.force
        });
        if (res && res.error) {
          if (res.existing && !W.force) {
            errBoxEl.innerHTML = esc(res.error) + ' ';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'bbg-btn';
            btn.style.cssText = 'margin-top:8px;padding:7px 14px;font-size:12.5px';
            btn.textContent = 'Create a second group anyway';
            btn.onclick = function () { W.force = true; nextBtn.disabled = false; advance(); };
            errBoxEl.appendChild(document.createElement('br'));
            errBoxEl.appendChild(btn);
          } else {
            errBoxEl.textContent = res.error;
          }
          nextBtn.disabled = false;
          return;
        }
        closeModal(modal);
        toast('Care group "' + (res.group && res.group.name) + '" created.');
        await BBG.refreshList();
        if (res.group) BBG.openGroup(res.group.id);
      } catch (e) {
        errBoxEl.textContent = 'Could not create the group. Try again.';
        nextBtn.disabled = false;
      }
    }

    draw();
  };

  BBG.setPane = setPane;
  BBG.state = S;
})();
