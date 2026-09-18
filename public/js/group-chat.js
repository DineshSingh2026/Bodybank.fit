/* ============================================================================
   BodyBank — Messages (full screen)
   ----------------------------------------------------------------------------
   ONE inbox, two kinds of conversation:

     • group  — care groups (client + doctor + lifestyle manager + operator),
                /api/groups
     • direct — the 1-to-1 client ↔ lifestyle-manager chat. Read through the
                paged /api/groups/dm endpoints; sent through the UNCHANGED
                POST /api/threads/:id/messages (it owns push + email).

   The surface is full screen, like WhatsApp. It is a single element appended
   to <body>, above the app chrome, so nothing in the dashboard layout can
   squeeze it:  phone → list / chat / info slide in turn;  desktop → side by
   side. Back (button, browser, Android) walks info → chat → list → dashboard.

   Why it feels instant:
     • the inbox is fetched and the surface built as soon as a dashboard opens
     • recent conversations are kept on the device and paint before the network
     • your own message and reactions appear in the same frame as the tap
     • an idle poll costs the server a single query (see /updates `rev`, and the
       1-to-1 `after` cursor) and downloads nothing

   Automated campaign nudges live in the 1-to-1 threads. Staff see them
   collapsed ("12 automated check-ins"); the admin inbox never lists a client
   for them. Members see them unchanged, as ordinary coach messages.

   Depends on globals from index.html: apiCall, escapeHtml, API,
   window.currentUser, switchUserTab, switchToSection. No <nav> element is used
   (index.html's bare nav{} rule would hijack it).
   ========================================================================== */

(function () {
  'use strict';

  // An idle poll is a single query on the server, so the active cadence can be
  // tight without adding load.
  var POLL_ACTIVE_MS = 2500;
  var POLL_IDLE_MS = 15000;
  var POLL_HIDDEN_MS = 45000;
  var LIST_POLL_MS = 20000;
  var STICK_PX = 140;
  var EDIT_WINDOW_MS = 15 * 60 * 1000;
  /** localStorage key prefix for a direct thread's per-device read mark. */
  var DM_SEEN = 'bb_dm_seen_';
  /**
   * On-device store: the inbox plus the newest page of recent conversations,
   * one localStorage entry per account. Bounded, never holds unsent messages,
   * wiped on logout (BBG.forget). v2: 1-to-1 messages carry a paging cursor.
   */
  var STORE_PREFIX = 'bbg_v2_';
  var STORE_OLD = ['bbg_v1_'];
  var STORE_MAX_CONVS = 15;
  var STORE_MAX_MSGS = 40;
  /** "Before everything" cursor for a 1-to-1 thread with no messages yet. */
  var DM_EPOCH = { ts: '1970-01-01T00:00:00.000000', id: '' };

  var EMOJI_SET = [
    '😀','😃','😄','😁','😆','😅','😂','🙂','😉','😊','😇','🥰','😍','😘','😋','😎',
    '🤩','🥳','🤔','🤨','😐','😴','😪','😮','😲','😢','😭','😤','😠','🥺','😳','🤗',
    '👍','👎','👏','🙌','🤝','🙏','💪','✌️','👌','🤞','❤️','🔥','⭐','✨','🎯','🏆',
    '💯','✅','❌','⚠️','📈','📉','💊','🩺','🥗','🍎','💧','🏃','🧘','🏋️','⏰','📅'
  ];

  var S = {
    mode: 'member',        // 'member' | 'admin'
    view: 'list',          // 'list' | 'chat' | 'info'
    conversations: [],
    filter: 'all',
    listQuery: '',

    kind: null,            // 'group' | 'direct'
    convId: null,          // group id, or thread id ('' before the first send)
    conv: null,            // the list row of the open conversation
    groupId: null,

    group: null,
    members: [],
    me: null,
    messages: [],
    maxSeq: 0,
    hasMore: false,
    rev: 0,
    reactionChoices: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
    replyTo: null,
    pendingFile: null,
    sending: false,
    stick: true,
    newWhileAway: 0,
    unreadFrom: null,
    unreadCount: 0,
    autoOpen: {},
    pollTimer: null,
    listTimer: null,
    opening: null,
    infoOpen: false,
    searchOpen: false,
    emojiOpen: false,
    media: null,
    drafts: {},
    cache: {},
    prefetching: {},
    listLoaded: false,
    listAt: 0,
    hydratedFor: null,
    // Sends and reactions on the wire. Polls stand down while any are, so a
    // poll can never race an optimistic bubble into a duplicate.
    inflight: 0,
    // Sends go out one after another, so the server stores them in typed order.
    sendChain: Promise.resolve()
  };

  window.BBGroupChat = window.BBGroupChat || {};
  var BBG = window.BBGroupChat;
  BBG.state = S;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

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
  function modeFromUser() { return isStaff() ? 'admin' : 'member'; }
  function enc(v) { return encodeURIComponent(v == null ? '' : v); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* blocked */ } }

  function isDesktop() {
    try { return window.matchMedia('(min-width:900px)').matches; }
    catch (e) { return (window.innerWidth || 0) >= 900; }
  }
  var isDirect = function () { return S.kind === 'direct'; };

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] || '') + (parts[parts.length - 1][0] || '');
  }
  function firstName(n) { return String(n || '').split(' ')[0] || ''; }

  function avatarHtml(name, url, cls) {
    var k = 'bbg-av' + (cls ? ' ' + cls : '');
    if (url) return '<div class="' + k + '"><img src="' + esc(url) + '" alt="" loading="lazy"></div>';
    return '<div class="' + k + '">' + esc(initials(name)) + '</div>';
  }

  function toDate(iso) { var d = new Date(iso); return isNaN(d) ? null : d; }
  function fmtTime(iso) {
    var d = toDate(iso);
    return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }
  function dayKey(iso) { var d = toDate(iso); return d ? d.toDateString() : ''; }
  function fmtListTime(iso) {
    var d = toDate(iso);
    if (!d) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(iso);
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
  }
  function fmtDay(iso) {
    var d = toDate(iso);
    if (!d) return '';
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function fmtShortDay(iso) {
    var d = toDate(iso);
    return d ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /**
   * Escape, then linkify. Order matters: escaping AFTER linkifying would mangle
   * the anchors, and linkifying raw input would let a crafted URL inject markup.
   * The `https?://` requirement also keeps `javascript:` out.
   */
  function richText(s) {
    var safe = esc(s);
    return safe.replace(/(https?:\/\/[^\s<]+)/g, function (m) {
      return '<a href="' + m + '" target="_blank" rel="noopener noreferrer">' + m + '</a>';
    });
  }

  var ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L13 5a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    forward: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5v4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    belloff: '<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8"/><path d="M10 20a2 2 0 0 0 4 0M3 3l18 18"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M16 5.4a3 3 0 0 1 0 5.4M18 14.6c1.3.6 2.2 1.9 2.5 4.4"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    leave: '<path d="M15 12H3M11 8l-4 4 4 4"/><path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
    chat: '<path d="M4 18l1.4-3.6A7.5 7.5 0 1 1 8.6 17.6z"/>',
    retry: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/>',
    spin: '<path d="M12 3a9 9 0 1 0 9 9"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }
  var SEND_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.2L4.3 12l-2.3 7.2a1 1 0 0 0 1.4 1.2z"/></svg>';

  function tickHtml(read) {
    var p = read
      ? '<path d="M1.5 6.5l3 3 6-7"/><path d="M7 9.5l1.4 1.3L15 3.5"/>'
      : '<path d="M3 6.5l3.5 3.5L13 3"/>';
    return '<span class="bbg-tick' + (read ? ' is-read' : '') + '" title="' + (read ? 'Read' : 'Sent') + '">'
      + '<svg viewBox="0 0 16 12" aria-hidden="true">' + p + '</svg></span>';
  }

  var _toastTimer = null;
  function toast(msg, isError) {
    var t = el('bbgToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'bbgToast';
      t.className = 'bbg bbg-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle('is-err', !!isError);
    requestAnimationFrame(function () { t.classList.add('is-on'); });
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 2600);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // THE SURFACE
  // ══════════════════════════════════════════════════════════════════════════

  function root() { return el('bbgApp'); }
  function isOpen() { var r = root(); return !!(r && !r.hidden); }

  /** Build the surface once (hidden). Rebuilt only after logout. */
  function ensureRoot() {
    var r = root();
    if (r) return r;
    r = document.createElement('div');
    r.id = 'bbgApp';
    r.className = 'bbg bbg-app';
    r.hidden = true;
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', 'Messages');
    r.setAttribute('data-view', 'list');
    r.innerHTML = ''
      + '<div class="bbg-grid">'
      // ── list ──
      +   '<section class="bbg-col bbg-col--list" role="navigation" aria-label="Conversations">'
      +     '<div class="bbg-bar" id="bbgListBar"></div>'
      +     '<div class="bbg-searchwrap"><label class="bbg-searchbox">' + icon('search')
      +       '<input type="search" id="bbgListSearch" placeholder="Search" autocomplete="off" enterkeyhint="search"></label></div>'
      +     '<div class="bbg-tabs" id="bbgTabs" role="tablist"></div>'
      +     '<div class="bbg-scroll" id="bbgList"></div>'
      +   '</section>'
      // ── chat ──
      +   '<section class="bbg-col bbg-col--chat" aria-label="Conversation">'
      +     '<div class="bbg-bar" id="bbgChatBar"></div>'
      +     '<div class="bbg-thread-wrap" id="bbgChatBody"></div>'
      +     '<div id="bbgCmpHost"></div>'
      +   '</section>'
      // ── info ──
      +   '<aside class="bbg-col bbg-col--info" aria-label="Conversation info">'
      +     '<div class="bbg-bar">'
      +       '<button type="button" class="bbg-ib" id="bbgInfoClose" aria-label="Close info">' + icon('close') + '</button>'
      +       '<div class="bbg-bar-title" id="bbgInfoTitle" style="font-size:19px">Info</div>'
      +     '</div>'
      +     '<div class="bbg-scroll" id="bbgInfo"></div>'
      +   '</aside>'
      + '</div>';
    document.body.appendChild(r);

    el('bbgInfoClose').onclick = function () { goBack(); };
    el('bbgListSearch').oninput = function () {
      S.listQuery = this.value.trim().toLowerCase();
      renderList();
    };
    renderListBar();
    renderIdle();
    bindGlobals();
    return r;
  }

  function renderListBar() {
    var bar = el('bbgListBar');
    if (!bar) return;
    var admin = S.mode === 'admin';
    bar.innerHTML = ''
      + '<button type="button" class="bbg-ib" id="bbgExit" aria-label="Back to dashboard">' + icon('back') + '</button>'
      + '<div class="bbg-bar-title">Messages<small id="bbgListSub"></small></div>'
      + (admin
          ? '<button type="button" class="bbg-ib is-gold" id="bbgNewDmBtn" title="Message a client" aria-label="Message a client">' + icon('compose') + '</button>'
            + '<button type="button" class="bbg-pill-btn" id="bbgNewGroupBtn" title="Create a care group">' + icon('plus') + '<span>New group</span></button>'
            + '<button type="button" class="bbg-ib" id="bbgListMore" aria-label="More">' + icon('more') + '</button>'
          : '');
    el('bbgExit').onclick = function () { goBack(); };
    if (admin) {
      el('bbgNewDmBtn').onclick = function () { BBG.openNewMessage(); };
      el('bbgNewGroupBtn').onclick = function () { BBG.openCreateGroup(); };
      el('bbgListMore').onclick = function () {
        var s = sheet(
          sheetItem('contact', 'mail', 'Contact form messages')
          + sheetItem('wa', 'phone', 'WhatsApp drafts'));
        wireSheet(s, function (act) { openAdminDrawer(act === 'wa' ? 'bbAdminWaDrawer' : 'bbAdminContactDrawer'); });
      };
    }
    updateListSub();
  }

  /** Close messaging and show one of the admin page's secondary drawers. */
  function openAdminDrawer(id) {
    BBG.close();
    var d = el(id);
    if (!d) return;
    d.open = true;
    setTimeout(function () { try { d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* old webview */ } }, 60);
  }

  function renderIdle() {
    var body = el('bbgChatBody');
    if (!body) return;
    el('bbgChatBar').innerHTML = '';
    el('bbgCmpHost').innerHTML = '';
    body.innerHTML = '<div class="bbg-idle">'
      + '<div class="bbg-idle-mark">' + icon('chat') + '</div>'
      + '<div><b>BodyBank Messages</b>'
      + (S.mode === 'admin'
          ? 'Pick a conversation, message a client, or start a care group.'
          : 'Your care team and your Lifestyle Manager, in one place.')
      + '</div></div>';
  }

  function setView(v) {
    S.view = v;
    var r = root();
    if (r) r.setAttribute('data-view', v);
  }

  // ── keyboard-safe height (iOS / Android) ────────────────────────────────
  // Reading visualViewport forces a full layout, so this never runs inside the
  // click that opens messaging (it cost ~37 ms there) — only after a paint, or
  // from the viewport's own resize events. With no keyboard up, CSS 100dvh is
  // already right and the inline override is cleared.
  function syncViewport() {
    var r = root();
    if (!r || r.hidden) return;
    var vv = window.visualViewport;
    if (!vv) return;
    var h = Math.round(vv.height);
    var top = Math.round(vv.offsetTop || 0);
    if (Math.abs(h - window.innerHeight) < 2 && !top) {
      r.style.height = '';
      r.style.transform = '';
    } else {
      r.style.height = h + 'px';
      r.style.transform = top ? 'translateY(' + top + 'px)' : '';
    }
    if (S.stick) scrollToBottom();
  }

  function bindGlobals() {
    if (BBG._globalsBound) return;
    BBG._globalsBound = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    window.addEventListener('popstate', onPopState);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isOpen()) return;
      if (document.querySelector('.bbg-veil, .bbg-modal-veil, .bbg-lightbox')) return;
      goBack();
    });
  }

  // ── back navigation ─────────────────────────────────────────────────────
  // One history entry per level (list, chat on a phone, info), so the browser
  // and Android back buttons walk the same path as the on-screen arrows.
  var NAV = { depth: 0, skip: 0 };
  function navPush(level) {
    try { history.pushState({ bbg: level }, ''); NAV.depth++; } catch (e) { /* sandboxed */ }
  }
  function goBack() {
    if (NAV.depth > 0) { history.back(); return; }
    applyBack();
  }
  function onPopState() {
    if (NAV.skip > 0) { NAV.skip--; return; }
    if (!isOpen()) return;
    NAV.depth = Math.max(0, NAV.depth - 1);
    applyBack();
  }
  function applyBack() {
    closeTransients();
    if (S.infoOpen) { hideInfo(); return; }
    if (S.view === 'chat' && !isDesktop()) { leaveChat(); return; }
    exitMessaging();
  }
  try { if (history.state && history.state.bbg) history.replaceState(null, ''); } catch (e) { /* ignore */ }

  // ══════════════════════════════════════════════════════════════════════════
  // OPEN / CLOSE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Show messaging. `opts.groupId` jumps straight into a group (push links).
   */
  BBG.open = function (opts) {
    opts = opts || {};
    var mode = opts.mode || modeFromUser();
    if (S.mode !== mode) { S.mode = mode; renderListBar(); }
    var r = ensureRoot();
    if (r.hidden) {
      r.hidden = false;
      document.documentElement.classList.add('bbg-lock');
      setView('list');
      navPush('list');
      // Only touch devices have an on-screen keyboard to make room for.
      if (('ontouchstart' in window) || navigator.maxTouchPoints > 0) {
        requestAnimationFrame(function () { setTimeout(syncViewport, 0); });
      }
    }
    startListPoll();
    BBG.refreshList(!opts.groupId);
    if (opts.groupId) BBG.openGroup(opts.groupId);
  };

  /**
   * Hide messaging without navigating anywhere. Used when the app itself moves
   * to another tab, at logout, and for the admin's drawers.
   */
  BBG.close = function () {
    var r = root();
    if (!r || r.hidden) return;
    saveDraft();
    stopPoll();
    stopListPoll();
    closeTransients();
    r.hidden = true;
    r.style.height = '';
    r.style.transform = '';
    document.documentElement.classList.remove('bbg-lock');
    resetConversation();
    hideInfo(true);
    setView('list');
    renderIdle();
    renderList();
    // Drop the history entries messaging added, without reacting to them.
    if (NAV.depth > 0) {
      NAV.skip++;
      var n = NAV.depth;
      NAV.depth = 0;
      try { history.go(-n); } catch (e) { NAV.skip = 0; }
    }
  };

  /** The back arrow on the list: leave messaging for the dashboard. */
  function exitMessaging() {
    BBG.close();
    if (S.mode === 'admin') {
      if (typeof window.switchToSection === 'function') window.switchToSection('dashboard');
    } else if (typeof window.switchUserTab === 'function') {
      window.switchUserTab('home');
    }
  }

  function closeTransients() {
    each(document.querySelectorAll('.bbg-veil, .bbg-modal-veil, .bbg-lightbox'), function (n) { n.remove(); });
  }

  function resetConversation() {
    S.opening = null;
    S.conv = null; S.convId = null; S.groupId = null; S.kind = null;
    S.messages = []; S.group = null; S.members = []; S.me = null;
    S.replyTo = null; S.pendingFile = null; S.searchOpen = false; S.emojiOpen = false;
    S.unreadFrom = null; S.unreadCount = 0; S.newWhileAway = 0;
  }

  function leaveChat() {
    saveDraft();
    stopPoll();
    resetConversation();
    setView('list');
    renderList();
    // Let the slide-out finish before emptying the chat column.
    setTimeout(function () { if (!S.conv) renderIdle(); }, 320);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ON-DEVICE STORE
  // ══════════════════════════════════════════════════════════════════════════

  function storeKey() { return STORE_PREFIX + myId(); }

  function loadStore() {
    var uid = myId();
    if (!uid || S.hydratedFor === uid) return;
    S.hydratedFor = uid;
    STORE_OLD.forEach(function (p) { lsDel(p + uid); });
    var raw = lsGet(storeKey());
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      if (!saved || saved.v !== 2) return;
      if (Array.isArray(saved.rows) && !S.conversations.length) S.conversations = saved.rows;
      var convs = saved.convs || {};
      Object.keys(convs).forEach(function (k) { if (!S.cache[k]) S.cache[k] = convs[k]; });
    } catch (e) { /* a corrupt entry is ignored and overwritten */ }
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
    var rows = S.conversations.filter(function (r) { return r.id !== 'dm:new'; }).slice(0, 80);
    var payload = JSON.stringify({ v: 2, at: Date.now(), rows: rows, convs: convs });
    try { localStorage.setItem(storeKey(), payload); }
    catch (e) { lsDel(storeKey()); /* over quota: drop rather than keep a half write */ }
  }

  function cachePut(id, entry) {
    if (!id || !entry) return;
    entry.at = Date.now();
    S.cache[id] = entry;
    persist();
  }

  function snapshot() {
    if (isDirect()) return { kind: 'direct', messages: S.messages, hasMore: S.hasMore };
    return {
      kind: 'group', group: S.group, members: S.members, me: S.me,
      messages: S.messages, maxSeq: S.maxSeq, hasMore: S.hasMore,
      rev: S.rev, reactionChoices: S.reactionChoices
    };
  }
  function snapshotOpen() { if (S.conv) cachePut(S.conv.id, snapshot()); }

  /**
   * Forget everything this account had on the device. Called at logout BEFORE
   * the session is cleared. The engine lives for the life of the page, so it is
   * reset too — the next account on the same tab must see nothing of this one.
   */
  BBG.forget = function () {
    var uid = myId();
    BBG.close();
    stopPoll();
    stopListPoll();
    clearTimeout(_persistTimer);
    if (uid) {
      lsDel(STORE_PREFIX + uid);
      STORE_OLD.forEach(function (p) { lsDel(p + uid); });
      try { sessionStorage.removeItem('bb_inbox_' + uid); } catch (e) { /* an older build's key */ }
    }
    S.conversations = []; S.cache = {}; S.prefetching = {};
    S.listLoaded = false; S.listAt = 0; S.hydratedFor = null; S._warming = false;
    resetConversation();
    S.drafts = {}; S.rev = 0; S.maxSeq = 0; S.inflight = 0; S.sendChain = Promise.resolve();
    S.autoOpen = {}; S.filter = 'all'; S.listQuery = '';
    var r = root();
    if (r) r.remove();
    NAV.depth = 0;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // CONVERSATION LIST
  // ══════════════════════════════════════════════════════════════════════════

  function paintCachedList() {
    loadStore();
    if (!S.conversations.length) return false;
    renderTabs(); renderList(); updateListSub();
    return true;
  }

  /**
   * "New activity" dot for a 1-to-1 row. thread_messages has no read column, so
   * this is a per-device mark keyed off the sender of the last PERSONAL message:
   * your own reply never flags the row.
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
    // A chat opened from "Message a client" has no messages yet, so the server
    // does not list it. Keep it until it does.
    var local = S.conversations.filter(function (c) {
      return c.type === 'direct' && c.threadId && !c.lastMessageAt
        && !rows.some(function (r) { return r.id === c.id; });
    });
    rows.forEach(function (r) {
      if (r.type === 'direct') r.unreadDot = directDot(r);
      var old = S.conversations.find(function (c) { return c.id === r.id; });
      if (old && old.lastFailed && old.lastPreview === r.lastPreview) r.lastFailed = true;
    });
    S.conversations = rows.concat(local).sort(byRecency);
    // Keep the open conversation's row object stable for identity checks.
    if (S.conv) {
      var fresh = S.conversations.find(function (c) { return c.id === S.conv.id; });
      if (fresh) Object.keys(fresh).forEach(function (k) { S.conv[k] = fresh[k]; });
      S.conversations = S.conversations.map(function (c) { return c.id === S.conv.id ? S.conv : c; });
    }
    S.listLoaded = true;
    S.listAt = Date.now();
    persist();
  }

  function prefetchTop() { S.conversations.slice(0, 4).forEach(prefetch); }

  /**
   * Desktop opens the newest conversation on arrival — after the list has
   * painted, so rendering a transcript never delays the list.
   */
  var _openAfterPaint = false;
  function openAfterPaint(row) {
    if (_openAfterPaint) return;
    _openAfterPaint = true;
    var go = function () {
      _openAfterPaint = false;
      if (isOpen() && S.convId == null && row && isDesktop()) openConversation(row, { noHistory: true });
    };
    requestAnimationFrame(function () { setTimeout(go, 0); });
  }

  BBG.refreshList = async function (autoOpenFirst) {
    var box = el('bbgList');
    if (!box) return;
    var painted = paintCachedList();
    if (!painted) box.innerHTML = skeletonRows();
    if (autoOpenFirst && painted && S.conversations.length) openAfterPaint(S.conversations[0]);
    // Just warmed: no need for a second identical request.
    if (autoOpenFirst && S.listAt && Date.now() - S.listAt < 6000) { prefetchTop(); return; }
    try {
      var res = await api('GET', '/api/groups/inbox');
      if (!res || res.error || !Array.isArray(res.conversations)) {
        if (!S.conversations.length) box.innerHTML = emptyHtml('⚠️', 'Could not load conversations', 'Check your connection and try again.');
        return;
      }
      applyInbox(res.conversations);
      renderTabs(); renderList(); updateListSub(); publishUnread();
      if (autoOpenFirst && S.conversations.length) openAfterPaint(S.conversations[0]);
      prefetchTop();
    } catch (e) {
      if (!S.conversations.length) box.innerHTML = emptyHtml('⚠️', 'Could not load conversations', 'Check your connection and try again.');
    }
  };

  /** Fetch a conversation into the cache without opening it. */
  function prefetch(row) {
    if (!row || S.prefetching[row.id]) return;
    var c = S.cache[row.id];
    if (c && c.at && Date.now() - c.at < 60000) return;
    if (row.type === 'direct' && !row.threadId) return;
    S.prefetching[row.id] = true;
    var done = function () { delete S.prefetching[row.id]; };
    var notOpen = function () { return !(S.conv && S.conv.id === row.id); };
    if (row.type === 'group') {
      api('GET', '/api/groups/' + enc(row.id))
        .then(function (d) { if (d && !d.error && d.group && notOpen()) cachePut(row.id, shapeGroup(d)); })
        .catch(function () {}).then(done, done);
    } else {
      api('GET', '/api/groups/dm/' + enc(row.threadId))
        .then(function (d) {
          if (d && Array.isArray(d.messages) && notOpen()) {
            cachePut(row.id, { kind: 'direct', messages: mapDirect(d.messages, row), hasMore: !!d.hasMore });
          }
        })
        .catch(function () {}).then(done, done);
    }
  }

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
   * Warm messaging before it is asked for: as soon as a dashboard is up, fetch
   * the inbox, build the (hidden) surface, prefetch the newest conversations.
   * Nothing is opened, so nothing is marked read.
   */
  BBG.warm = function () {
    if (!window.currentUser || !window.currentUser.token) return;
    var mode = modeFromUser();
    if (S.mode !== mode) { S.mode = mode; renderListBar(); }
    loadStore();
    ensureRoot();
    if (!isOpen() && S.conversations.length) { renderTabs(); renderList(); updateListSub(); }
    var deep = null;
    try { deep = new URLSearchParams(location.search).get('group'); } catch (e) { /* old browser */ }
    if (deep) {
      try { history.replaceState(history.state, '', location.pathname); } catch (e) { /* ignore */ }
      BBG.open({ mode: mode, groupId: deep });
      return;
    }
    if (S._warming || (S.listAt && Date.now() - S.listAt < 6000)) return;
    S._warming = true;
    api('GET', '/api/groups/inbox')
      .then(function (res) {
        if (!res || res.error || !Array.isArray(res.conversations)) return;
        applyInbox(res.conversations);
        publishUnread();
        renderTabs(); renderList(); updateListSub();
        prefetchTop();
      })
      .catch(function () {})
      .then(function () { S._warming = false; }, function () { S._warming = false; });
  };

  function isUnread(c) { return Number(c.unread || 0) > 0 || !!c.unreadDot; }

  function filtered() {
    var q = S.listQuery;
    return S.conversations.filter(function (c) {
      if (S.filter === 'unread' && !isUnread(c)) return false;
      if (S.filter === 'group' && c.type !== 'group') return false;
      if (S.filter === 'direct' && c.type !== 'direct') return false;
      if (!q) return true;
      return [c.name, c.lastPreview, c.clientName, c.email].some(function (v) {
        return String(v || '').toLowerCase().indexOf(q) >= 0;
      });
    });
  }

  function renderTabs() {
    var host = el('bbgTabs');
    if (!host) return;
    var unread = S.conversations.filter(isUnread).length;
    var defs = [
      { k: 'all', label: 'All' },
      { k: 'unread', label: 'Unread', n: unread },
      { k: 'group', label: 'Groups' },
      { k: 'direct', label: S.mode === 'admin' ? 'Clients' : 'Coach' }
    ];
    host.innerHTML = defs.map(function (d) {
      return '<button type="button" role="tab" class="bbg-tab' + (S.filter === d.k ? ' is-on' : '') + '" data-f="' + d.k + '"'
        + ' aria-selected="' + (S.filter === d.k) + '">' + esc(d.label) + (d.n ? '<i>' + d.n + '</i>' : '') + '</button>';
    }).join('');
    each(host.querySelectorAll('.bbg-tab'), function (b) {
      b.onclick = function () { S.filter = b.getAttribute('data-f'); renderTabs(); renderList(); };
    });
  }

  function skeletonRows() {
    var one = '<div class="bbg-skel"><i style="width:50px;height:50px;border-radius:50%"></i>'
      + '<div style="flex:1"><i style="width:45%;height:13px;margin-bottom:9px"></i><i style="width:75%;height:11px"></i></div></div>';
    return new Array(7).join(one);
  }

  function emptyHtml(ic, title, text) {
    return '<div class="bbg-empty"><span class="bbg-empty-i">' + ic + '</span><b>' + esc(title) + '</b>' + esc(text) + '</div>';
  }

  function renderList() {
    var box = el('bbgList');
    if (!box) return;
    var rows = filtered();
    var foot = '';
    if (S.mode === 'admin') {
      foot = '<div class="bbg-listfoot">Only clients you have talked with personally appear here — automated check-ins are hidden.'
        + '<br><button type="button" id="bbgFootDm">Message a client</button></div>';
    }
    if (!rows.length) {
      var title = S.listQuery ? 'No matches'
        : (S.filter === 'unread' ? 'You\'re all caught up' : 'No conversations yet');
      var text = S.listQuery ? 'Try a different name or word.'
        : (S.mode === 'admin' ? 'Create a care group, or message a client to start.' : 'Messages from your care team will appear here.');
      box.innerHTML = emptyHtml(S.filter === 'unread' ? '✓' : '💬', title, text) + foot;
    } else {
      box.innerHTML = rows.map(convHtml).join('') + foot;
    }
    var fd = el('bbgFootDm');
    if (fd) fd.onclick = function () { BBG.openNewMessage(); };
    each(box.querySelectorAll('.bbg-conv'), function (b) {
      var find = function () {
        var id = b.getAttribute('data-id');
        return S.conversations.find(function (c) { return String(c.id) === id; });
      };
      b.onclick = function () { var row = find(); if (row) openConversation(row); };
      // Start fetching as soon as a pointer lands on the row.
      var warm = function () { var row = find(); if (row) prefetch(row); };
      b.addEventListener('pointerenter', warm);
      b.addEventListener('touchstart', warm, { passive: true });
    });
  }

  function convHtml(c) {
    var group = c.type === 'group';
    var unread = Number(c.unread || 0);
    var hot = unread > 0 || !!c.unreadDot;
    var prefix = '';
    if (group && c.lastSenderName && c.lastKind !== 'system') {
      prefix = '<b>' + esc(c.lastSenderName === 'You' ? 'You' : firstName(c.lastSenderName)) + ': </b>';
    } else if (!group && c.lastMessageAt) {
      var mine = S.mode === 'admin' ? !!c.lastFromStaff : !c.lastFromStaff;
      if (mine) prefix = '<b>You: </b>';
    }
    var prev = c.lastFailed
      ? '<span class="bbg-fail">Not sent: </span>' + esc(c.lastPreview || '')
      : prefix + esc(c.lastPreview || (group ? 'No messages yet' : 'Start a conversation'));
    return ''
      + '<button type="button" class="bbg-conv' + (hot ? ' is-unread' : '')
      +   (S.conv && String(S.conv.id) === String(c.id) ? ' is-open' : '') + '" data-id="' + esc(c.id) + '">'
      +   avatarHtml(group ? (c.clientName || c.name) : c.name, c.avatarUrl || c.clientAvatar, group ? 'bbg-av--g' : '')
      +   '<div class="bbg-conv-main">'
      +     '<div class="bbg-conv-l1"><span class="bbg-conv-name">' + esc(c.name) + '</span>'
      +       '<span class="bbg-conv-time">' + esc(fmtListTime(c.lastMessageAt)) + '</span></div>'
      +     '<div class="bbg-conv-l2"><span class="bbg-conv-prev">' + prev + '</span>'
      +       (c.muted ? '<span class="bbg-flag" title="Muted">🔕</span>' : '')
      +       (c.archived ? '<span class="bbg-conv-kind">Archived</span>' : '')
      +       (unread ? '<span class="bbg-count">' + (unread > 99 ? '99+' : unread) + '</span>'
                : (c.unreadDot ? '<span class="bbg-dot" title="New"></span>' : ''))
      +     '</div>'
      +   '</div>'
      + '</button>';
  }

  function unreadTotal() {
    return S.conversations.reduce(function (a, c) { return a + (Number(c.unread || 0) || (c.unreadDot ? 1 : 0)); }, 0);
  }
  function updateListSub() {
    var sub = el('bbgListSub');
    if (!sub) return;
    var n = unreadTotal();
    sub.textContent = n ? n + ' unread' : '';
  }
  function publishUnread() {
    var total = unreadTotal();
    window.bbGroupUnread = total;
    try { window.dispatchEvent(new CustomEvent('bb:group-unread', { detail: { total: total } })); } catch (e) { /* old webview */ }
  }
  function refreshListRow() { renderTabs(); renderList(); updateListSub(); publishUnread(); }

  function openConversation(row, opts) {
    if (!row) return;
    if (row.type === 'group') return BBG.openGroup(row.id, { row: row, noHistory: opts && opts.noHistory });
    return openDirect(row, opts);
  }
  BBG.openConversation = openConversation;

  // ══════════════════════════════════════════════════════════════════════════
  // OPENING A CONVERSATION
  // ══════════════════════════════════════════════════════════════════════════

  function beginOpen(row, kind, convId, opts) {
    stopPoll();
    saveDraft();
    closeFind();
    S.opening = String(row.id);
    S.conv = row;
    S.kind = kind;
    S.convId = convId;
    S.groupId = kind === 'group' ? convId : null;
    S.messages = [];
    S.maxSeq = 0;
    S.rev = 0;
    S.hasMore = false;
    S.replyTo = null;
    S.pendingFile = null;
    S.stick = true;
    S.newWhileAway = 0;
    S.unreadFrom = null;
    S.unreadCount = 0;
    S.emojiOpen = false;
    S.media = null;
    if (S.infoOpen && !isDesktop()) hideInfo(true);
    if (!isDesktop() && S.view !== 'chat') {
      setView('chat');
      if (!(opts && opts.noHistory)) navPush('chat');
    }
    renderList();
    renderChatFrame();
    loadStore();
    if (!S.cache[row.id]) {
      el('bbgThread').innerHTML = '<div class="bbg-empty"><span class="bbg-empty-i">💬</span>Opening…</div>';
    }
  }

  function stillOpening(row) { return S.opening === String(row.id); }

  /** The chat column's skeleton: header, thread, jump button, composer host. */
  function renderChatFrame() {
    el('bbgChatBody').innerHTML = '<div class="bbg-thread" id="bbgThread" aria-live="polite"></div>'
      + '<button type="button" class="bbg-jump" id="bbgJump" aria-label="Scroll to latest">' + icon('down') + '<b></b></button>';
    el('bbgJump').onclick = function () { S.stick = true; S.newWhileAway = 0; scrollToBottom(); markRead(); renderJump(); };
    el('bbgThread').onscroll = onThreadScroll;
    renderHeader();
    renderComposer();
  }

  // ── group ───────────────────────────────────────────────────────────────
  BBG.openGroup = async function (groupId, opts) {
    opts = opts || {};
    if (!groupId) return;
    if (!isOpen()) { BBG.open({ groupId: groupId }); return; }
    var row = opts.row
      || S.conversations.find(function (c) { return c.type === 'group' && c.id === groupId; })
      || { id: groupId, type: 'group', name: 'Group' };
    beginOpen(row, 'group', groupId, opts);

    var cached = S.cache[row.id];
    var painted = false;
    if (cached && cached.kind === 'group') { applyGroup(cached, false); painted = true; }

    try {
      // ONE request: detail + members + the newest page.
      var d = await api('GET', '/api/groups/' + enc(groupId));
      if (!stillOpening(row)) return;
      if (!d || d.error || !d.group) {
        if (!painted) el('bbgThread').innerHTML = emptyHtml('⚠️', (d && d.error) || 'Could not open this conversation', 'Try again in a moment.');
        return;
      }
      if (row.name === 'Group') { row.name = d.group.name; }
      applyGroup(shapeGroup(d), painted);
      snapshotOpen();
      markRead();
      startPoll();
      if (S.infoOpen) renderInfo();
    } catch (e) {
      if (!painted && stillOpening(row)) el('bbgThread').innerHTML = emptyHtml('⚠️', 'Could not open this conversation', 'Check your connection.');
      else if (painted) startPoll();
    }
  };

  function applyGroup(d, refresh) {
    var firstApply = !refresh;
    S.group = d.group;
    S.members = d.members;
    S.me = d.me;
    // A bubble typed while this refresh was in flight must survive it.
    S.messages = withPending(d.messages.slice());
    S.maxSeq = d.maxSeq;
    S.hasMore = d.hasMore;
    S.rev = Number(d.rev || 0);
    if (d.reactionChoices) S.reactionChoices = d.reactionChoices;
    if (!S.unreadFrom) computeUnreadGroup();
    renderHeader();
    // Only rebuild the composer when postability changed — never under a
    // person who is typing.
    var canPost = !!(S.me && S.me.canPost);
    if (!refresh || canPost !== !!el('bbgInput')) renderComposer();
    renderTranscript();
    if (firstApply || S.stick) landScroll();
  }

  /** Where the reader left off: the first message someone else sent since. */
  function computeUnreadGroup() {
    var last = Number((S.me && S.me.lastReadSeq) || 0);
    if (!last) return;
    var fresh = S.messages.filter(function (m) {
      return !m.mine && m.kind !== 'system' && !m.pending && Number(m.seq) > last;
    });
    if (fresh.length) { S.unreadFrom = fresh[0].id; S.unreadCount = fresh.length; }
  }

  // ── direct (1-to-1) ─────────────────────────────────────────────────────
  async function openDirect(row, opts) {
    if (!isOpen()) BBG.open({ mode: S.mode });
    beginOpen(row, 'direct', row.threadId || '', opts);
    S.group = null;
    S.members = [];
    S.me = { userId: myId(), isAdmin: isStaff(), isMember: true, canPost: true, canManage: false, muted: false };
    renderHeader();
    renderComposer();

    if (!row.threadId) { renderTranscript(); startPoll(); return; }

    var seenBefore = lsGet(DM_SEEN + row.threadId);
    var cached = S.cache[row.id];
    var painted = false;
    if (cached && cached.kind === 'direct') {
      S.messages = cached.messages.slice();
      S.hasMore = !!cached.hasMore;
      computeUnreadDirect(seenBefore);
      renderTranscript();
      landScroll();
      painted = true;
    }
    try {
      var d = await api('GET', '/api/groups/dm/' + enc(row.threadId));
      if (!stillOpening(row)) return;
      if (!d || d.error || !Array.isArray(d.messages)) {
        if (!painted) el('bbgThread').innerHTML = emptyHtml('⚠️', (d && d.error) || 'Could not open this conversation', 'Try again in a moment.');
        return;
      }
      var mapped = withPending(mapDirect(d.messages, row));
      var changed = !painted || sig(mapped) !== sig(S.messages);
      S.messages = mapped;
      S.hasMore = !!d.hasMore;
      if (changed) {
        if (!S.unreadFrom) computeUnreadDirect(seenBefore);
        renderTranscript();
        if (!painted || S.stick) landScroll();
      }
      snapshotOpen();
      markRead();
      startPoll();
    } catch (e) {
      if (!painted && stillOpening(row)) el('bbgThread').innerHTML = emptyHtml('⚠️', 'Could not open this conversation', 'Check your connection.');
      else if (painted) startPoll();
    }
  }

  function sig(list) {
    return list.length + ':' + (list.length ? list[list.length - 1].id : '');
  }

  function computeUnreadDirect(seenIso) {
    var seen = seenIso ? new Date(seenIso).getTime() : 0;
    if (!seen) return;
    var fresh = S.messages.filter(function (m) {
      return !m.mine && !m.automated && !m.pending && new Date(m.createdAt).getTime() > seen;
    });
    if (fresh.length) { S.unreadFrom = fresh[0].id; S.unreadCount = fresh.length; }
  }

  /**
   * Map 1-to-1 rows onto the bubble shape. "Mine" is decided by ROLE for staff:
   * any admin replying is the same Lifestyle Manager voice to the client, and a
   * second admin must not see a colleague's reply as incoming. `automated` only
   * ever arrives for staff (the server whitelists it).
   */
  function mapDirect(rows, conv) {
    var staff = isStaff();
    return rows.map(function (m, i) {
      var fromStaff = m.sender_role === 'admin' || m.sender_role === 'superadmin';
      var mine = staff ? fromStaff : String(m.sender_id) === myId();
      var name = mine ? 'You' : (fromStaff ? 'Lifestyle Manager' : ((conv && conv.clientName) || 'Client'));
      return {
        id: m.id,
        seq: i + 1,
        senderId: m.sender_id,
        senderName: name,
        senderAvatar: (!fromStaff && conv && conv.clientAvatar) || '',
        senderRole: fromStaff ? 'lifestyle_manager' : 'client',
        senderRoleLabel: fromStaff ? 'Lifestyle Manager' : 'Client',
        kind: 'text',
        body: m.body || '',
        createdAt: m.created_at,
        editedAt: null,
        deleted: false,
        mine: mine,
        automated: staff && !!m.automated,
        cursor: m.cursor || null,
        reactions: [],
        attachments: [],
        replyTo: null
      };
    });
  }

  /** The newest confirmed message's paging cursor. */
  function dmCursorNow() {
    for (var i = S.messages.length - 1; i >= 0; i--) {
      var m = S.messages[i];
      if (!m.pending && !m.failed && m.cursor) return { ts: m.cursor, id: m.id };
    }
    return DM_EPOCH;
  }

  /** Append the open conversation's unconfirmed bubbles to a fresh list. */
  function withPending(list) {
    S.messages.forEach(function (m) {
      if ((m.pending || m.failed) && list.indexOf(m) < 0) list.push(m);
    });
    return list;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HEADER + TRANSCRIPT
  // ══════════════════════════════════════════════════════════════════════════

  function renderHeader() {
    var bar = el('bbgChatBar');
    if (!bar || !S.conv) return;
    var title, sub, av;
    if (isDirect()) {
      var c = S.conv;
      title = c.name || 'Chat';
      sub = S.mode === 'admin' ? ((c.email || 'Client') + ' · private chat') : 'Your Lifestyle Manager';
      av = avatarHtml(c.name, c.avatarUrl, 'bbg-av--sm');
    } else {
      var g = S.group || S.conv;
      title = g.name || 'Group';
      var names = S.members.map(function (m) {
        return String(m.userId) === myId() ? null : firstName(m.name);
      }).filter(Boolean);
      if (S.members.some(function (m) { return String(m.userId) === myId(); })) names.push('You');
      sub = names.length ? names.join(', ') : 'Tap for group info';
      if (S.group && S.group.archived) sub = 'Archived · read only';
      av = avatarHtml(g.clientName || g.name, g.avatarUrl || g.clientAvatar, 'bbg-av--sm bbg-av--g');
    }
    bar.innerHTML = ''
      + '<button type="button" class="bbg-ib bbg-only-phone" id="bbgChatBack" aria-label="Back">' + icon('back') + '</button>'
      + '<button type="button" class="bbg-who" id="bbgWho">' + av
      +   '<div class="bbg-who-txt"><div class="bbg-who-name">' + esc(title) + '</div>'
      +   '<div class="bbg-who-sub">' + esc(sub) + '</div></div></button>'
      + '<button type="button" class="bbg-ib" id="bbgFindBtn" aria-label="Search messages">' + icon('search') + '</button>'
      + '<button type="button" class="bbg-ib" id="bbgChatMore" aria-label="More options">' + icon('more') + '</button>'
      + '<div id="bbgFindHost"></div>';
    el('bbgChatBack').onclick = function () { goBack(); };
    el('bbgWho').onclick = function () { openInfo(); };
    el('bbgFindBtn').onclick = function () { toggleFind(); };
    el('bbgChatMore').onclick = function () { openChatMenu(); };
  }

  function atBottom() {
    var t = el('bbgThread');
    return !t || (t.scrollHeight - t.scrollTop - t.clientHeight) < STICK_PX;
  }

  function scrollToBottom(instant) {
    var t = el('bbgThread');
    if (!t) return;
    requestAnimationFrame(function () {
      t.scrollTop = t.scrollHeight;
      if (instant) setTimeout(function () { t.scrollTop = t.scrollHeight; }, 50);
    });
  }

  /** On open: land on the first unread message if there is one, else the end. */
  function landScroll() {
    var t = el('bbgThread');
    if (!t) return;
    var bar = S.unreadFrom ? t.querySelector('.bbg-unreadbar') : null;
    if (!bar) { S.stick = true; scrollToBottom(true); return; }
    requestAnimationFrame(function () {
      t.scrollTop = Math.max(0, bar.offsetTop - 60);
      S.stick = atBottom();
      renderJump();
    });
  }

  function onThreadScroll() {
    var was = S.stick;
    S.stick = atBottom();
    if (S.stick && (!was || S.newWhileAway)) { S.newWhileAway = 0; markRead(); }
    renderJump();
    var t = el('bbgThread');
    // Near the top: fetch older messages without a click.
    if (t && t.scrollTop < 80 && S.hasMore && !S._loadingOlder) loadOlder();
  }

  function renderJump() {
    var j = el('bbgJump');
    if (!j) return;
    j.classList.toggle('is-on', !S.stick);
    j.querySelector('b').textContent = S.newWhileAway ? String(S.newWhileAway) : '';
  }

  function renderTranscript() {
    var t = el('bbgThread');
    if (!t) return;
    if (!S.messages.length) {
      t.innerHTML = emptyHtml('👋', 'No messages yet',
        isDirect()
          ? (S.mode === 'admin' ? 'Say hello — only this client and the coaching team see this chat.'
                                : 'Send the first message — only you and your coach can see this chat.')
          : 'Say hello to the care team — everyone in this group will see it.');
      return;
    }
    var h = '';
    if (S.hasMore) h += '<div class="bbg-loadmore"><button type="button" id="bbgLoadMore">Load earlier messages</button></div>';
    var lastDay = '';
    var prev = null;
    var msgs = S.messages;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      // Automated nudges (staff view): one collapsible row per run, dates included.
      if (m.automated && !m.pending) {
        var run = [m];
        var j = i + 1;
        while (j < msgs.length && msgs[j].automated && !msgs[j].pending) { run.push(msgs[j]); j++; }
        h += autoRunHtml(run);
        i = j - 1;
        lastDay = '';
        prev = null;
        continue;
      }
      var day = dayKey(m.createdAt);
      if (day !== lastDay) {
        h += '<div class="bbg-day"><span>' + esc(fmtDay(m.createdAt)) + '</span></div>';
        lastDay = day;
        prev = null;
      }
      if (S.unreadFrom && m.id === S.unreadFrom) {
        h += '<div class="bbg-unreadbar"><span>' + S.unreadCount + ' unread message' + (S.unreadCount === 1 ? '' : 's') + '</span></div>';
        prev = null;
      }
      h += messageHtml(m, prev);
      prev = m;
    }
    t.innerHTML = h;
    bindTranscript();
    renderJump();
  }

  function autoRunHtml(run) {
    var key = run[0].id;
    var open = !!S.autoOpen[key];
    var first = run[0].createdAt;
    var last = run[run.length - 1].createdAt;
    var range = fmtShortDay(first) === fmtShortDay(last) ? fmtShortDay(first) : fmtShortDay(first) + ' – ' + fmtShortDay(last);
    var label = run.length === 1 ? '1 automated check-in' : run.length + ' automated check-ins';
    var h = '<div class="bbg-auto"><button type="button" data-auto="' + esc(key) + '">' + icon('bot')
      + '<span>' + (open ? 'Hide ' + label : label + ' · ' + esc(range)) + '</span></button></div>';
    if (open) {
      h += '<div class="bbg-auto-list">' + run.map(function (m) {
        return '<div class="bbg-auto-line" data-auto-id="' + esc(m.id) + '">' + esc(m.body)
          + '<time>' + esc(fmtShortDay(m.createdAt) + ' ' + fmtTime(m.createdAt)) + '</time></div>';
      }).join('') + '</div>';
    }
    return h;
  }

  function isGrouped(m, prev) {
    if (!prev || m.kind === 'system' || prev.kind === 'system') return false;
    if (String(prev.senderId) !== String(m.senderId) || !!prev.mine !== !!m.mine) return false;
    return (new Date(m.createdAt) - new Date(prev.createdAt)) < 5 * 60 * 1000;
  }

  function messageHtml(m, prev) {
    if (m.kind === 'system') {
      return '<div class="bbg-sys" data-seq="' + m.seq + '"><span>' + esc(m.body) + '</span></div>';
    }
    var out = !!m.mine;
    var first = !isGrouped(m, prev);
    var group = !isDirect();
    var rxCount = (m.reactions || []).reduce(function (a, r) { return a + r.count; }, 0);
    var cls = 'bbg-m ' + (out ? 'out' : 'in') + (first ? ' is-first' : '') + (rxCount ? ' has-rx' : '')
      + (m.pending ? ' is-pending' : '') + (m.failed ? ' is-failed' : '');
    var h = '<div class="' + cls + '" data-id="' + esc(m.id) + '" data-seq="' + m.seq + '">';
    if (!out && group) h += '<div class="bbg-m-av">' + avatarHtml(m.senderName, m.senderAvatar, 'bbg-av--xs') + '</div>';
    h += '<div class="bbg-b' + (m.deleted ? ' is-deleted' : '') + '">';
    if (group && !out && first) {
      h += '<div class="bbg-name r-' + esc(m.senderRole || 'client') + '">' + esc(m.senderName)
        + (m.senderRoleLabel ? '<em>' + esc(m.senderRoleLabel) + '</em>' : '') + '</div>';
    }
    if (m.replyTo) {
      h += '<button type="button" class="bbg-quote" data-goto="' + esc(m.replyTo.id) + '">'
        + '<b>' + esc(m.replyTo.senderName || 'Message') + '</b><span>' + esc(m.replyTo.body) + '</span></button>';
    }
    (m.attachments || []).forEach(function (a) {
      if (a.isImage) {
        h += '<img class="bbg-img" src="' + esc(a.url) + '" alt="' + esc(a.name) + '" loading="lazy" data-full="' + esc(a.url) + '">';
      } else if (a.isAudio) {
        h += '<div class="bbg-audio"><span class="bbg-file-ic">🎤</span>'
          + '<audio controls preload="metadata" src="' + esc(a.url) + '"></audio></div>';
      } else {
        h += '<a class="bbg-file" href="' + esc(a.url) + '" target="_blank" rel="noopener"><span class="bbg-file-ic">📄</span>'
          + '<span class="bbg-file-t"><b>' + esc(a.name) + '</b><span>' + esc(fmtBytes(a.size)) + '</span></span></a>';
      }
    });

    var status = '';
    if (m.pending) status = '<span class="bbg-clock" title="Sending">' + icon('spin') + '</span>';
    else if (out && !m.deleted && !m.failed) status = tickHtml(isDirect() ? false : readByAll(m));
    var time = fmtTime(m.createdAt);
    // Room the time (and tick / "edited") needs on the last line of text.
    var spW = 14 + time.length * 6.4 + (out ? 20 : 0) + (m.editedAt ? 40 : 0);
    var text = m.deleted ? '🚫 This message was deleted' : (m.body ? richText(m.body) : '');
    h += '<div class="bbg-txt">' + text + '<span class="bbg-sp" style="width:' + Math.round(spW) + 'px"></span></div>';
    h += '<span class="bbg-meta">' + (m.editedAt ? '<i>edited</i>' : '') + esc(time) + status + '</span>';
    if (m.failed) h += '<button type="button" class="bbg-retry" data-retry="' + esc(m.id) + '">Not sent · Tap to retry</button>';
    if (!m.deleted && !m.pending) h += '<button type="button" class="bbg-more" aria-label="Message options">' + icon('chev') + '</button>';
    if (rxCount) {
      h += '<div class="bbg-rx">' + m.reactions.map(function (r) {
        return '<button type="button" class="' + (r.mine ? 'is-mine' : '') + '" data-emoji="' + esc(r.emoji)
          + '" title="' + esc((r.names || []).join(', ')) + '">' + esc(r.emoji) + '</button>';
      }).join('') + (rxCount > 1 ? '<b>' + rxCount + '</b>' : '') + '</div>';
    }
    if (group && !m.deleted && !m.pending) h += '<span class="bbg-swipe-cue">' + icon('reply') + '</span>';
    h += '</div></div>';
    return h;
  }

  function readByAll(m) {
    var others = S.members.filter(function (x) { return String(x.userId) !== String(m.senderId); });
    if (!others.length) return false;
    return others.every(function (x) { return Number(x.lastReadSeq || 0) >= Number(m.seq); });
  }

  function bindTranscript() {
    var t = el('bbgThread');
    if (!t) return;
    var lm = el('bbgLoadMore');
    if (lm) lm.onclick = loadOlder;
    each(t.querySelectorAll('[data-auto]'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-auto');
        S.autoOpen[k] = !S.autoOpen[k];
        var keep = t.scrollHeight - t.scrollTop;
        renderTranscript();
        t.scrollTop = t.scrollHeight - keep;
      };
    });
    each(t.querySelectorAll('.bbg-retry'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); retrySend(b.getAttribute('data-retry')); };
    });
    each(t.querySelectorAll('.bbg-quote'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); gotoMessage(b.getAttribute('data-goto')); };
    });
    each(t.querySelectorAll('.bbg-rx button'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        toggleReaction(b.closest('.bbg-m').getAttribute('data-id'), b.getAttribute('data-emoji'));
      };
    });
    each(t.querySelectorAll('.bbg-img'), function (img) {
      img.onclick = function () { lightbox(img.getAttribute('data-full')); };
      img.onload = function () { if (S.stick) scrollToBottom(); };
    });
    each(t.querySelectorAll('.bbg-more'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); openMessageActions(b.closest('.bbg-m').getAttribute('data-id')); };
    });
    each(t.querySelectorAll('.bbg-m'), bindTouch);
    each(t.querySelectorAll('.bbg-b'), function (b) {
      b.ondblclick = function () {
        var m = findMsg(b.closest('.bbg-m').getAttribute('data-id'));
        if (m && !isDirect() && !m.pending && !m.deleted) setReply(m);
      };
    });
  }

  function findMsg(id) { return S.messages.find(function (x) { return x.id === id; }); }

  /**
   * Touch: long-press opens the actions sheet; swiping a group message to the
   * right starts a reply, as in WhatsApp. The swipe only engages once the
   * gesture is clearly horizontal, so vertical scrolling is never hijacked.
   */
  function bindTouch(row) {
    var bubble = row.querySelector('.bbg-b');
    var cue = row.querySelector('.bbg-swipe-cue');
    var sx = 0, sy = 0, dx = 0, mode = null, timer = null;
    row.addEventListener('touchstart', function (e) {
      var p = e.touches[0];
      sx = p.clientX; sy = p.clientY; dx = 0; mode = null;
      timer = setTimeout(function () {
        if (!mode) { mode = 'press'; openMessageActions(row.getAttribute('data-id')); }
      }, 480);
    }, { passive: true });
    row.addEventListener('touchmove', function (e) {
      var p = e.touches[0];
      var mx = p.clientX - sx, my = p.clientY - sy;
      if (!mode) {
        if (Math.abs(my) > 10) { mode = 'scroll'; clearTimeout(timer); return; }
        if (mx > 12 && cue) { mode = 'swipe'; clearTimeout(timer); }
        else if (Math.abs(mx) > 10) { mode = 'scroll'; clearTimeout(timer); return; }
      }
      if (mode !== 'swipe') return;
      dx = Math.max(0, Math.min(mx, 80));
      bubble.style.transition = 'none';
      bubble.style.transform = 'translateX(' + dx + 'px)';
      cue.style.opacity = String(Math.min(1, dx / 56));
      cue.style.transform = 'scale(' + (0.6 + Math.min(0.4, dx / 140)) + ')';
    }, { passive: true });
    var end = function () {
      clearTimeout(timer);
      if (mode === 'swipe') {
        bubble.style.transition = '';
        bubble.style.transform = '';
        cue.style.opacity = '';
        cue.style.transform = '';
        if (dx > 56) {
          var m = findMsg(row.getAttribute('data-id'));
          if (m) setReply(m);
        }
      }
      mode = null;
    };
    row.addEventListener('touchend', end, { passive: true });
    row.addEventListener('touchcancel', end, { passive: true });
  }

  async function loadOlder() {
    if (!S.messages.length || S._loadingOlder || !S.hasMore) return;
    S._loadingOlder = true;
    var btn = el('bbgLoadMore');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    var t = el('bbgThread');
    var anchor = t.scrollHeight - t.scrollTop;
    var convAt = S.conv;
    try {
      var older = [];
      var more = false;
      if (isDirect()) {
        var first = S.messages.find(function (m) { return m.cursor; });
        if (!first) { S.hasMore = false; return; }
        var d = await api('GET', '/api/groups/dm/' + enc(S.convId) + '?before=' + enc(first.cursor) + '&beforeId=' + enc(first.id));
        older = (d && Array.isArray(d.messages)) ? mapDirect(d.messages, S.conv) : [];
        more = !!(d && d.hasMore);
      } else {
        var res = await api('GET', '/api/groups/' + enc(S.groupId) + '/messages?limit=40&before=' + enc(S.messages[0].seq));
        older = (res && res.messages) || [];
        more = !!(res && res.hasMore);
      }
      if (S.conv !== convAt) return;
      var known = {};
      S.messages.forEach(function (m) { known[m.id] = true; });
      S.messages = older.filter(function (m) { return !known[m.id]; }).concat(S.messages);
      if (isDirect()) S.messages.forEach(function (m, i) { m.seq = i + 1; });
      S.hasMore = more;
      renderTranscript();
      t.scrollTop = t.scrollHeight - anchor;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Load earlier messages'; }
    } finally {
      S._loadingOlder = false;
    }
  }

  async function gotoMessage(id) {
    var sel = '[data-id="' + cssEsc(id) + '"], [data-auto-id="' + cssEsc(id) + '"]';
    var target = findMsg(id);
    // A nudge lives inside a collapsed run: open that run first.
    if (target && target.automated) {
      var idx = S.messages.indexOf(target);
      var k = idx;
      while (k > 0 && S.messages[k - 1].automated) k--;
      S.autoOpen[S.messages[k].id] = true;
      renderTranscript();
    }
    var row = document.querySelector('#bbgThread ' + sel.split(', ').join(', #bbgThread '));
    for (var i = 0; !row && i < 8 && S.hasMore; i++) {
      await loadOlder();
      row = document.querySelector('#bbgThread ' + sel.split(', ').join(', #bbgThread '));
    }
    if (!row) { toast('That message is further back in the conversation.'); return; }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var b = row.querySelector('.bbg-b') || row;
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
    var host = el('bbgCmpHost');
    if (!host || !S.conv) return;
    if (S.me && !S.me.canPost) {
      host.innerHTML = '<div class="bbg-cmp"><div class="bbg-cmp-locked">'
        + (S.group && S.group.archived ? 'This group is archived — reopen it from group info to send messages.'
                                       : 'You can\'t send messages in this conversation.')
        + '</div></div>';
      return;
    }
    var direct = isDirect();
    host.innerHTML = '<div class="bbg-cmp">'
      + '<div id="bbgCmpTop"></div>'
      + '<div class="bbg-cmp-row">'
      +   '<div class="bbg-field">'
      +     '<button type="button" class="bbg-ib" id="bbgEmojiBtn" aria-label="Emoji" aria-expanded="false">' + icon('smile') + '</button>'
      +     '<textarea class="bbg-input" id="bbgInput" rows="1" placeholder="Message" maxlength="5000" enterkeyhint="send"></textarea>'
      // The legacy thread table has no attachment column, so a 1-to-1 has no clip.
      +     (direct ? '' : '<button type="button" class="bbg-ib" id="bbgAttachBtn" aria-label="Attach a file">' + icon('clip') + '</button>')
      +   '</div>'
      +   '<button type="button" class="bbg-send" id="bbgSend" aria-label="Send" disabled>' + SEND_SVG + '</button>'
      + '</div>'
      + (direct ? '' : '<input type="file" id="bbgFile" hidden accept="image/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt">')
      + '<div id="bbgCmpErr"></div>'
      + '</div>';
    bindComposer();
    restoreDraft();
  }

  function bindComposer() {
    var input = el('bbgInput');
    var send = el('bbgSend');
    function sync() {
      // Reading scrollHeight forces a full layout. An empty box — every freshly
      // opened conversation — has nothing to measure.
      if (input.value) {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      } else {
        input.style.height = '';
      }
      send.disabled = (S.sending && !!S.pendingFile) || (!input.value.trim() && !S.pendingFile);
      if (S.conv) S.drafts[S.conv.id] = input.value;
    }
    input.oninput = sync;
    input.onkeydown = function (e) {
      // Enter sends on a keyboard; Shift+Enter is a newline. On a phone Enter
      // stays a newline — the send button is right there.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && isDesktop()) { e.preventDefault(); doSend(); }
    };
    input.onfocus = function () { if (S.stick) setTimeout(scrollToBottom, 250); };
    // Keep the keyboard up on a phone: the tap must not blur the input.
    send.addEventListener('mousedown', function (e) { e.preventDefault(); });
    send.onclick = function () { doSend(); };
    el('bbgEmojiBtn').onclick = function (e) { e.stopPropagation(); toggleEmoji(); };
    var ab = el('bbgAttachBtn');
    if (ab) {
      ab.onclick = function () { el('bbgFile').click(); };
      el('bbgFile').onchange = function () {
        var f = this.files && this.files[0];
        if (f) pickFile(f);
        this.value = '';
      };
    }
    sync();
  }

  function saveDraft() {
    var input = el('bbgInput');
    if (input && S.conv) S.drafts[S.conv.id] = input.value;
  }
  function restoreDraft() {
    var input = el('bbgInput');
    if (!input || !S.conv) return;
    var d = S.drafts[S.conv.id];
    if (d) { input.value = d; input.dispatchEvent(new Event('input')); }
  }

  function setComposerError(msg) {
    var b = el('bbgCmpErr');
    if (b) b.innerHTML = msg ? '<div class="bbg-cmp-err">' + esc(msg) + '</div>' : '';
  }

  /** The strip above the input: emoji panel, reply preview or attachment. */
  function renderCmpTop() {
    var top = el('bbgCmpTop');
    if (!top) return;
    var h = '';
    if (S.emojiOpen) {
      h += '<div class="bbg-emoji">' + EMOJI_SET.map(function (e) { return '<button type="button">' + e + '</button>'; }).join('') + '</div>';
    }
    if (S.pendingFile) {
      var f = S.pendingFile;
      h += '<div class="bbg-cmp-bar">' + (/^image\//.test(f.type) ? '<img id="bbgAttThumb" alt="">' : '<span class="bbg-file-ic">📄</span>')
        + '<div class="bbg-cmp-bar-t"><b>' + esc(f.name) + '</b><span>' + esc(fmtBytes(f.size)) + ' · add a caption or send</span></div>'
        + '<button type="button" class="bbg-ib" id="bbgAttCancel" aria-label="Remove attachment">' + icon('close') + '</button></div>';
    }
    if (S.replyTo) {
      var m = S.replyTo;
      h += '<div class="bbg-cmp-bar"><div class="bbg-cmp-bar-t"><b>' + esc(m.mine ? 'You' : m.senderName) + '</b>'
        + '<span>' + esc(m.deleted ? 'Deleted message' : (m.body || 'Attachment')) + '</span></div>'
        + '<button type="button" class="bbg-ib" id="bbgReplyCancel" aria-label="Cancel reply">' + icon('close') + '</button></div>';
    }
    top.innerHTML = h;
    each(top.querySelectorAll('.bbg-emoji button'), function (b) {
      b.onclick = function () {
        var input = el('bbgInput');
        var pos = input.selectionStart != null ? input.selectionStart : input.value.length;
        input.value = input.value.slice(0, pos) + b.textContent + input.value.slice(pos);
        input.dispatchEvent(new Event('input'));
        if (isDesktop()) input.focus();
      };
    });
    var thumb = el('bbgAttThumb');
    if (thumb && S.pendingFile) {
      var url = URL.createObjectURL(S.pendingFile);
      thumb.src = url;
      thumb.onload = function () { URL.revokeObjectURL(url); };
    }
    var ac = el('bbgAttCancel');
    if (ac) ac.onclick = clearFile;
    var rc = el('bbgReplyCancel');
    if (rc) rc.onclick = function () { setReply(null); };
    var eb = el('bbgEmojiBtn');
    if (eb) eb.setAttribute('aria-expanded', String(!!S.emojiOpen));
    if (S.stick) scrollToBottom();
  }

  function toggleEmoji() { S.emojiOpen = !S.emojiOpen; renderCmpTop(); }

  function pickFile(f) {
    if (f.size > 12 * 1024 * 1024) { setComposerError('That file is larger than 12 MB.'); return; }
    S.pendingFile = f;
    setComposerError('');
    renderCmpTop();
    var input = el('bbgInput');
    if (input) input.dispatchEvent(new Event('input'));
  }

  function clearFile() {
    S.pendingFile = null;
    renderCmpTop();
    var input = el('bbgInput');
    if (input) input.dispatchEvent(new Event('input'));
  }

  function setReply(m) {
    S.replyTo = m;
    renderCmpTop();
    var input = el('bbgInput');
    if (m && input) input.focus();
  }

  /**
   * Send. Text goes out OPTIMISTICALLY: the bubble is on screen in the same
   * frame as the tap, with a clock, and becomes a tick when the server confirms.
   * The input is cleared synchronously, which is also the double-send guard — a
   * second Enter finds nothing to send. Attachments keep a blocking path: the
   * upload itself is the wait.
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
        senderName: S.replyTo.mine ? 'You' : S.replyTo.senderName,
        senderRoleLabel: S.replyTo.senderRoleLabel || '',
        body: S.replyTo.deleted ? 'This message was deleted' : String(S.replyTo.body || '').slice(0, 220),
        kind: S.replyTo.kind
      } : null,
      pending: true
    };

    input.value = '';
    input.dispatchEvent(new Event('input'));
    S.replyTo = null;
    S.emojiOpen = false;
    renderCmpTop();
    setComposerError('');
    if (S.conv) delete S.drafts[S.conv.id];

    // Your own message ends the "unread" marker, as in WhatsApp.
    S.unreadFrom = null;
    S.messages.push(temp);
    S.stick = true;
    S.newWhileAway = 0;
    renderTranscript();
    scrollToBottom();
    bumpListPreview(body);
    queueDeliver(temp);
  }

  function retrySend(id) {
    var temp = findMsg(id);
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
        var res = await api('POST', '/api/groups/' + enc(ctx.groupId) + '/messages', {
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
   * Post into the 1-to-1 thread through the legacy endpoint (which owns the
   * push and the coach-reply email). A member with no thread yet gets one
   * created by the call that carries their first message.
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
    var res = await api('POST', '/api/threads/' + enc(conv.threadId) + '/messages', { body: temp.body });
    if (!res || res.error || !res.id) throw new Error((res && res.error) || 'Message not sent');
    return mapDirect([res], conv)[0];
  }

  /**
   * The list preview is bumped the moment a message is typed. If delivery then
   * fails, the preview must not keep claiming it was sent.
   */
  function setPreviewState(conv, body, failed) {
    if (!conv) return;
    var row = S.conversations.find(function (c) { return c === conv || c.id === conv.id; });
    if (!row || row.lastPreview !== body) return;
    if (!!row.lastFailed === !!failed) return;
    row.lastFailed = !!failed;
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
      // Fast-forward our cursors ONLY when our message was the one change since
      // the last sync (every change bumps rev by one). seq is a global sequence,
      // so a gap is normal; anything else is left for the next poll.
      if (Number(res.rev) === Number(S.rev) + 1) {
        S.rev = Number(res.rev);
        S.maxSeq = Math.max(Number(S.maxSeq || 0), Number(res.maxSeq || 0));
        if (S.me) S.me.lastReadSeq = Math.max(Number(S.me.lastReadSeq || 0), Number(res.maxSeq || 0));
      }
    }
    if (open) {
      if (isDirect()) S.messages.forEach(function (m, i) { m.seq = i + 1; });
      renderTranscript();
      if (S.stick) scrollToBottom();
      snapshotOpen();
      if (!real && ctx.kind === 'direct') setTimeout(function () { poll(); }, 50);
    }
  }

  function bumpListPreview(body) {
    if (!S.conv) return;
    var row = S.conversations.find(function (c) { return c === S.conv || c.id === S.conv.id; });
    if (!row) { S.conversations.unshift(S.conv); row = S.conv; }
    row.lastPreview = body;
    row.lastFailed = false;
    row.lastMessageAt = new Date().toISOString();
    if (row.type === 'group') { row.lastSenderName = 'You'; row.lastKind = 'text'; }
    else { row.lastFromStaff = S.mode === 'admin'; row.unreadDot = false; }
    S.conversations.sort(byRecency);
    renderList();
    persist();
  }

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
      S.pendingFile = null;
      S.replyTo = null;
      renderCmpTop();
      if (S.conv) delete S.drafts[S.conv.id];
      S.stick = true;
      if (res && res.message) {
        if (!S.messages.some(function (m) { return m.id === res.message.id; })) S.messages.push(res.message);
        renderTranscript();
        scrollToBottom(true);
        bumpListPreview(res.message.kind === 'image' ? '📷 Photo' : (res.message.kind === 'audio' ? '🎤 Voice note' : '📎 Attachment'));
        snapshotOpen();
      }
    } catch (e) {
      setComposerError(e && e.message ? e.message : 'Attachment not sent. Check your connection and try again.');
    } finally {
      S.sending = false;
      S.inflight = Math.max(0, S.inflight - 1);
      send.classList.remove('is-busy');
      send.innerHTML = SEND_SVG;
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
    // `API` is a top-level const in index.html — global lexical scope, not window.
    var base = (typeof API !== 'undefined' && API) ? API : '';
    var res = await fetch(base + '/api/groups/' + enc(S.groupId) + '/attachments', { method: 'POST', headers: headers, body: fd });
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
      poll().then(function () {
        if (S.convId != null && isOpen()) S.pollTimer = setTimeout(tick, pollDelay());
      });
    }, pollDelay());
  }
  function stopPoll() { if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; } }

  function startListPoll() {
    stopListPoll();
    S.listTimer = setInterval(function () {
      if (!document.hidden && isOpen()) BBG.refreshList();
    }, LIST_POLL_MS);
  }
  function stopListPoll() { if (S.listTimer) { clearInterval(S.listTimer); S.listTimer = null; } }

  function onVisibility() {
    if (document.hidden || !isOpen()) return;
    if (S.convId != null) { poll(); startPoll(); }
    BBG.refreshList();
  }

  async function poll(force) {
    if (S.conv == null) return;
    // Never race an optimistic send or reaction; the next tick catches up.
    if (S.inflight > 0 && !force) return;
    try {
      if (isDirect()) await pollDirect();
      else await pollGroup();
    } catch (e) { /* a dropped poll is recovered by the next one */ }
  }

  /** Arrivals while the reader is scrolled up: count them, don't yank. */
  function afterArrivals(n, wasBottom) {
    if (wasBottom) { scrollToBottom(); markRead(); }
    else { S.newWhileAway += n; renderJump(); }
  }

  async function pollGroup() {
    var gid = S.groupId;
    if (!gid) return;
    var res = await api('GET', '/api/groups/' + enc(gid) + '/updates?since=' + enc(S.maxSeq) + '&rev=' + enc(S.rev));
    if (S.groupId !== gid || !res || res.error || S.inflight > 0) return;

    var wasBottom = S.stick, changed = false, arrived = 0;

    if (res.archived != null && S.group && !!res.archived !== !!S.group.archived) {
      S.group.archived = !!res.archived;
      if (S.me) S.me.canPost = !res.archived;
      renderComposer();
      renderHeader();
    }
    // Nothing happened — the server answered from one query. Only read
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
        if (S.infoOpen) renderInfo();
        changed = true;
      }
    }

    if (res.messages && res.messages.length) {
      var known = {};
      S.messages.forEach(function (m) { known[m.id] = true; });
      var fresh = res.messages.filter(function (m) { return !known[m.id]; });
      if (fresh.length) {
        S.messages = S.messages.concat(fresh);
        // Server order; unconfirmed bubbles (seq = MAX) stay at the end.
        S.messages.sort(function (a, b) { return Number(a.seq) - Number(b.seq); });
        arrived = fresh.filter(function (m) { return !m.mine; }).length;
        changed = true;
      }
    }
    S.maxSeq = Math.max(S.maxSeq, Number(res.maxSeq || 0));

    if (res.recent && res.recent.length) {
      var byId = {};
      S.messages.forEach(function (m) { byId[m.id] = m; });
      res.recent.forEach(function (r) {
        var m = byId[r.id];
        if (!m) return;
        if (JSON.stringify(m.reactions || []) !== JSON.stringify(r.reactions || [])) { m.reactions = r.reactions; changed = true; }
        if (!!m.deleted !== !!r.deleted) { m.deleted = r.deleted; m.kind = r.kind; m.body = ''; changed = true; }
        if (!m.deleted && m.body !== r.body) { m.body = r.body; changed = true; }
        if (m.editedAt !== r.editedAt) { m.editedAt = r.editedAt; changed = true; }
      });
    }
    if (applyReaders(res.readers)) changed = true;

    if (changed) {
      snapshotOpen();
      renderTranscript();
      afterArrivals(arrived, wasBottom);
    }
  }

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
   * Only what is new since the newest confirmed message — usually nothing, and
   * the server answers that from one indexed query.
   */
  async function pollDirect() {
    var tid = S.convId;
    if (!tid) return;
    var cur = dmCursorNow();
    var res = await api('GET', '/api/groups/dm/' + enc(tid) + '/updates?after=' + enc(cur.ts) + '&afterId=' + enc(cur.id));
    if (S.convId !== tid || !res || !Array.isArray(res.messages) || S.inflight > 0) return;
    if (!res.messages.length) return;
    var byId = {};
    S.messages.forEach(function (m) { byId[m.id] = m; });
    var mapped = mapDirect(res.messages, S.conv);
    var fresh = [];
    mapped.forEach(function (m) {
      // Our own send is already on screen under its real id: adopt the cursor.
      if (byId[m.id]) { byId[m.id].cursor = m.cursor; return; }
      fresh.push(m);
    });
    if (!fresh.length) return;
    var wasBottom = S.stick;
    var confirmed = S.messages.filter(function (m) { return !m.pending && !m.failed; });
    var pending = S.messages.filter(function (m) { return m.pending || m.failed; });
    S.messages = confirmed.concat(fresh, pending);
    S.messages.forEach(function (m, i) { m.seq = i + 1; });
    snapshotOpen();
    renderTranscript();
    afterArrivals(fresh.filter(function (m) { return !m.mine && !m.automated; }).length, wasBottom);
    // Keep the list row current without waiting for the list poll.
    var lastReal = fresh.filter(function (m) { return !m.automated; }).pop();
    if (lastReal && S.conv) {
      S.conv.lastPreview = lastReal.body;
      S.conv.lastMessageAt = lastReal.createdAt;
      S.conv.lastFromStaff = lastReal.senderRole === 'lifestyle_manager';
      S.conversations.sort(byRecency);
      renderList();
    }
  }

  /**
   * Move our read mark forward. Groups have a server cursor; 1-to-1 threads have
   * no column for one, so they use a per-device mark (as the coach badge does).
   */
  function markRead() {
    if (S.conv == null || !isOpen()) return;
    if (isDirect()) {
      if (!S.convId) return;
      lsSet(DM_SEEN + S.convId, new Date().toISOString());
      if (S.conv.unread || S.conv.unreadDot) {
        S.conv.unread = 0;
        S.conv.unreadDot = false;
        refreshListRow();
      }
      return;
    }
    if (!S.me || !S.me.isMember || !S.maxSeq) return;
    if (Number(S.me.lastReadSeq || 0) >= Number(S.maxSeq)) return;
    S.me.lastReadSeq = S.maxSeq;
    var gid = S.groupId;
    api('POST', '/api/groups/' + enc(gid) + '/read', { seq: S.maxSeq })
      .then(function () {
        var c = S.conversations.find(function (x) { return x.id === gid; });
        if (c && c.unread) { c.unread = 0; refreshListRow(); }
      })
      .catch(function () { /* retried on the next scroll or poll */ });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE ACTIONS
  // ══════════════════════════════════════════════════════════════════════════

  function localToggle(list, emoji) {
    var hadThis = list.some(function (r) { return r.emoji === emoji && r.mine; });
    var out = [];
    list.forEach(function (r) {
      var c = { emoji: r.emoji, count: r.count, mine: r.mine, names: (r.names || []).slice() };
      if (c.mine) { c.count -= 1; c.mine = false; }   // one reaction per member
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
    var m = findMsg(messageId);
    if (!m || m.pending || m.failed) return;
    var before = m.reactions || [];
    var gid = S.groupId;
    m.reactions = localToggle(before, emoji);
    renderTranscript();
    S.inflight++;
    try {
      var res = await api('POST', '/api/groups/' + enc(gid) + '/messages/' + enc(messageId) + '/reactions', { emoji: emoji });
      if (res && res.error) { m.reactions = before; toast(res.error, true); }
      else if (res && Array.isArray(res.reactions)) m.reactions = res.reactions;
    } catch (e) {
      m.reactions = before;
      toast('Could not save that reaction.', true);
    } finally {
      S.inflight = Math.max(0, S.inflight - 1);
      if (S.groupId === gid) { renderTranscript(); snapshotOpen(); }
    }
  }

  function sheetItem(act, ic, label, danger) {
    return '<button type="button" class="bbg-sheet-item' + (danger ? ' is-danger' : '') + '" data-act="' + act + '">'
      + icon(ic) + '<span>' + esc(label) + '</span></button>';
  }

  function sheet(bodyHtml) {
    closeTransients();
    var wrap = document.createElement('div');
    wrap.className = 'bbg bbg-veil';
    wrap.innerHTML = '<div class="bbg-sheet" role="menu"><div class="bbg-grip"></div>' + bodyHtml + '</div>';
    document.body.appendChild(wrap);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    return wrap;
  }

  function wireSheet(s, onAct) {
    each(s.querySelectorAll('.bbg-sheet-item'), function (b) {
      b.onclick = function () { var a = b.getAttribute('data-act'); s.remove(); onAct(a); };
    });
  }

  function openMessageActions(messageId) {
    var m = findMsg(messageId);
    if (!m || m.deleted || m.pending) return;

    if (m.failed) {
      wireSheet(sheet(sheetItem('retry', 'retry', 'Try again') + sheetItem('discard', 'trash', 'Discard', true)), function (act) {
        if (act === 'retry') retrySend(m.id);
        else { S.messages = S.messages.filter(function (x) { return x !== m; }); renderTranscript(); }
      });
      return;
    }

    // A 1-to-1 thread stores only id/sender/body/time — offer what it can do.
    if (isDirect()) {
      if (m.body) wireSheet(sheet(sheetItem('copy', 'copy', 'Copy')), function () { copyText(m.body); });
      return;
    }

    var own = !!m.mine;
    var canEdit = own && m.kind === 'text' && (Date.now() - new Date(m.createdAt).getTime()) < EDIT_WINDOW_MS;
    var canDelete = own || (S.me && S.me.canManage);
    var mine = (m.reactions || []).filter(function (r) { return r.mine; }).map(function (r) { return r.emoji; });
    var body = '<div class="bbg-sheet-rx">' + S.reactionChoices.map(function (e) {
        return '<button type="button" data-emoji="' + esc(e) + '"' + (mine.indexOf(e) >= 0 ? ' class="is-mine"' : '') + '>' + e + '</button>';
      }).join('') + '</div>'
      + sheetItem('reply', 'reply', 'Reply')
      + (m.body ? sheetItem('copy', 'copy', 'Copy') : '')
      + (canEdit ? sheetItem('edit', 'edit', 'Edit') : '')
      + sheetItem('forward', 'forward', 'Forward')
      + sheetItem('info', 'info', 'Info')
      + (own ? '' : sheetItem('report', 'flag', 'Report'))
      + (canDelete ? sheetItem('delete', 'trash', own ? 'Delete' : 'Remove message', true) : '');
    var s = sheet(body);
    each(s.querySelectorAll('.bbg-sheet-rx button'), function (b) {
      b.onclick = function () { s.remove(); toggleReaction(m.id, b.getAttribute('data-emoji')); };
    });
    wireSheet(s, function (act) {
      if (act === 'reply') setReply(m);
      else if (act === 'copy') copyText(m.body);
      else if (act === 'edit') editMessage(m);
      else if (act === 'delete') deleteMessage(m);
      else if (act === 'info') messageInfo(m);
      else if (act === 'report') reportMessage(m);
      else if (act === 'forward') forwardMessage(m);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text || '').then(function () { toast('Copied'); }, function () { toast('Could not copy', true); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text || '';
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Could not copy', true); }
    ta.remove();
  }

  function editMessage(m) {
    promptModal('Edit message', m.body, 'Save', async function (val) {
      if (!val.trim()) return 'Message cannot be empty.';
      var res = await api('PATCH', '/api/groups/' + enc(S.groupId) + '/messages/' + enc(m.id), { body: val.trim() });
      if (res && res.error) return res.error;
      m.body = val.trim();
      m.editedAt = new Date().toISOString();
      renderTranscript();
      snapshotOpen();
      return null;
    });
  }

  function deleteMessage(m) {
    confirmModal('Delete message?', 'It will be removed for everyone in this group.', 'Delete', async function () {
      var res = await api('DELETE', '/api/groups/' + enc(S.groupId) + '/messages/' + enc(m.id));
      if (res && res.error) { toast(res.error, true); return; }
      m.deleted = true; m.body = ''; m.reactions = [];
      renderTranscript();
      snapshotOpen();
      BBG.refreshList();
    });
  }

  async function messageInfo(m) {
    try {
      var res = await api('GET', '/api/groups/' + enc(S.groupId) + '/messages/' + enc(m.id) + '/info');
      if (res && res.error) { toast(res.error, true); return; }
      var person = function (r) {
        return '<div class="bbg-person"><div class="bbg-person-t"><b>' + esc(r.name) + '</b></div><span class="bbg-role">' + esc(r.roleLabel) + '</span></div>';
      };
      infoModal('Message info',
        '<div class="bbg-fieldset"><span class="bbg-field-l">Sent</span><div>' + esc(new Date(res.sentAt).toLocaleString()) + '</div></div>'
        + '<div class="bbg-fieldset"><span class="bbg-field-l">Read by ' + res.readBy.length + '</span>'
        + (res.readBy.length ? res.readBy.map(person).join('') : '<div class="bbg-hint">Nobody has opened it yet.</div>') + '</div>'
        + (res.pending.length ? '<div class="bbg-fieldset"><span class="bbg-field-l">Delivered</span>' + res.pending.map(person).join('') + '</div>' : ''));
    } catch (e) { toast('Could not load message info', true); }
  }

  function reportMessage(m) {
    promptModal('Report message', '', 'Send report', async function (val) {
      var res = await api('POST', '/api/groups/' + enc(S.groupId) + '/messages/' + enc(m.id) + '/report', { reason: val.trim() });
      if (res && res.error) return res.error;
      toast('Reported — an admin will review it');
      return null;
    }, 'What is wrong with this message? (optional)');
  }

  function forwardMessage(m) {
    var targets = S.conversations.filter(function (c) { return c.type === 'group' && c.id !== S.groupId && !c.archived; });
    if (!targets.length) { toast('There is no other group to forward to'); return; }
    if (!m.body) { toast('Only text messages can be forwarded'); return; }
    var modal = infoModal('Forward to…', '<div class="bbg-pick-list">' + targets.map(function (c) {
      return '<button type="button" class="bbg-pick" data-id="' + esc(c.id) + '">'
        + avatarHtml(c.clientName || c.name, c.avatarUrl || c.clientAvatar, 'bbg-av--sm bbg-av--g')
        + '<div class="bbg-pick-t"><b>' + esc(c.name) + '</b><span>' + esc(c.memberCount + ' members') + '</span></div></button>';
    }).join('') + '</div>');
    each(modal.querySelectorAll('.bbg-pick'), function (b) {
      b.onclick = async function () {
        b.disabled = true;
        var res = await api('POST', '/api/groups/' + enc(b.getAttribute('data-id')) + '/messages', { body: m.body });
        closeModal(modal);
        if (res && res.error) { toast(res.error, true); return; }
        toast('Forwarded');
        BBG.refreshList();
      };
    });
  }

  function lightbox(src) {
    var d = document.createElement('div');
    d.className = 'bbg bbg-lightbox';
    d.innerHTML = '<img src="' + esc(src) + '" alt="">';
    d.onclick = function () { d.remove(); };
    document.body.appendChild(d);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SEARCH IN A CONVERSATION
  // ══════════════════════════════════════════════════════════════════════════

  function closeFind() { var h = el('bbgFindHost'); if (h) h.innerHTML = ''; S.searchOpen = false; }

  function toggleFind() {
    var host = el('bbgFindHost');
    if (!host) return;
    if (S.searchOpen) { closeFind(); return; }
    S.searchOpen = true;
    host.innerHTML = '<div class="bbg-find"><div class="bbg-find-in"><label class="bbg-searchbox">' + icon('search')
      + '<input type="search" id="bbgFindInput" placeholder="Search this chat" autocomplete="off"></label></div>'
      + '<div id="bbgFindList"></div></div>';
    var inp = el('bbgFindInput');
    inp.focus();
    var t = null;
    inp.oninput = function () {
      clearTimeout(t);
      var q = inp.value.trim();
      t = setTimeout(function () { runFind(q); }, 220);
    };
  }

  async function runFind(q) {
    var list = el('bbgFindList');
    if (!list) return;
    var note = function (s) { list.innerHTML = '<div class="bbg-find-note">' + esc(s) + '</div>'; };
    if (q.length < 2) { note('Type at least 2 characters.'); return; }
    try {
      var rows;
      if (isDirect()) {
        // Searches the messages loaded so far (scroll up to load older ones).
        var needle = q.toLowerCase();
        rows = S.messages.filter(function (m) { return String(m.body || '').toLowerCase().indexOf(needle) >= 0; })
          .slice(-50).reverse()
          .map(function (m) { return { id: m.id, body: m.body, createdAt: m.createdAt, senderName: m.automated ? 'Automated' : m.senderName }; });
      } else {
        var res = await api('GET', '/api/groups/' + enc(S.groupId) + '/search?q=' + enc(q));
        rows = (res && res.results) || [];
      }
      if (!rows.length) { note('No messages found.'); return; }
      list.innerHTML = rows.map(function (r) {
        return '<button type="button" class="bbg-find-row" data-id="' + esc(r.id) + '"><b>' + esc(r.senderName)
          + ' · ' + esc(fmtListTime(r.createdAt)) + '</b><span>' + mark(r.body, q) + '</span></button>';
      }).join('');
      each(list.querySelectorAll('.bbg-find-row'), function (b) {
        b.onclick = function () { var id = b.getAttribute('data-id'); closeFind(); gotoMessage(id); };
      });
    } catch (e) { note('Search failed.'); }
  }

  /** Highlight the needle inside already-escaped text. */
  function mark(body, q) {
    var safe = esc(body);
    var needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return safe.replace(new RegExp('(' + needle + ')', 'ig'), '<mark>$1</mark>'); }
    catch (e) { return safe; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CHAT MENU + INFO PANEL
  // ══════════════════════════════════════════════════════════════════════════

  function openChatMenu() {
    if (!S.conv) return;
    var h = sheetItem('info', 'info', isDirect() ? 'Contact info' : 'Group info')
      + sheetItem('search', 'search', 'Search');
    if (!isDirect()) {
      if (S.me && S.me.isMember) h += sheetItem('mute', S.me.muted ? 'bell' : 'belloff', S.me.muted ? 'Unmute notifications' : 'Mute notifications');
      if (S.me && S.me.canManage) {
        h += sheetItem('add', 'users', 'Add member');
        h += sheetItem('rename', 'edit', 'Edit group name');
        h += sheetItem('archive', 'archive', S.group && S.group.archived ? 'Reopen group' : 'Archive group');
        h += sheetItem('activity', 'list', 'Group activity');
      }
      if (S.me && S.me.isMember && S.group && String(S.me.userId) !== String(S.group.clientId)) h += sheetItem('leave', 'leave', 'Leave group', true);
    }
    wireSheet(sheet(h), function (act) {
      if (act === 'info') openInfo();
      else if (act === 'search') toggleFind();
      else if (act === 'mute') toggleMute();
      else if (act === 'add') openAddMember();
      else if (act === 'rename') renameGroup();
      else if (act === 'archive') toggleArchive();
      else if (act === 'activity') showActivity();
      else if (act === 'leave') leaveGroup();
    });
  }

  function openInfo() {
    if (!S.conv || S.infoOpen) return;
    S.infoOpen = true;
    root().classList.add('has-info');
    if (!isDesktop()) setView('info');
    navPush('info');
    el('bbgInfoTitle').textContent = isDirect() ? 'Contact info' : 'Group info';
    el('bbgInfoClose').innerHTML = isDesktop() ? icon('close') : icon('back');
    renderInfo();
    if (!isDirect()) {
      api('GET', '/api/groups/' + enc(S.groupId) + '/media')
        .then(function (m) { if (S.infoOpen && m && !m.error) { S.media = m; renderInfo(); } })
        .catch(function () {});
    }
  }

  function hideInfo(silent) {
    if (!S.infoOpen) return;
    S.infoOpen = false;
    var r = root();
    if (r) r.classList.remove('has-info');
    if (S.view === 'info') setView(S.conv ? 'chat' : 'list');
    if (!silent && S.stick) scrollToBottom();
  }

  function renderInfo() {
    var box = el('bbgInfo');
    if (!box || !S.conv) return;
    if (isDirect()) {
      var c = S.conv;
      box.innerHTML = '<div class="bbg-info-hero">' + avatarHtml(c.name, c.avatarUrl, 'bbg-av--xl')
        + '<div class="bbg-info-name">' + esc(c.name) + '</div>'
        + '<div class="bbg-info-meta">' + esc(S.mode === 'admin' ? (c.email || 'Client') : 'Your Lifestyle Manager') + '</div></div>'
        + '<div class="bbg-sec"><div class="bbg-sec-h">About this chat</div><div class="bbg-sec-note">'
        + (S.mode === 'admin'
            ? 'A private chat between this client and the coaching team. The care group cannot see it. Automated check-ins sent to the client appear here collapsed.'
            : 'A private chat between you and your Lifestyle Manager. Nobody in your care group can see it.')
        + '</div></div>'
        + '<div class="bbg-sec">' + actHtml('search', 'search', 'Search messages') + '</div>';
      bindInfoActs(box);
      return;
    }
    if (!S.group) return;
    var g = S.group;
    var canManage = !!(S.me && S.me.canManage);
    var h = '<div class="bbg-info-hero">'
      + avatarHtml(g.clientName || g.name, g.avatarUrl || g.clientAvatar, 'bbg-av--xl bbg-av--g')
      + '<div class="bbg-info-name">' + esc(g.name) + '</div>'
      + '<div class="bbg-info-meta">Care group · ' + S.members.length + ' members<br>Created '
      + esc(new Date(g.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))
      + (g.archived ? '<br><span style="color:#d9b85f">Archived — read only</span>' : '') + '</div></div>';

    var media = S.media || { files: [], links: [] };
    var images = (media.files || []).filter(function (f) { return f.isImage; });
    var docs = (media.files || []).filter(function (f) { return !f.isImage; });
    if (images.length || docs.length || (media.links || []).length) {
      h += '<div class="bbg-sec"><div class="bbg-sec-h">Media, docs and links</div>';
      if (images.length) {
        h += '<div class="bbg-media">' + images.slice(0, 9).map(function (f) {
          return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener"><img src="' + esc(f.url) + '" alt="" loading="lazy"></a>';
        }).join('') + '</div>';
      }
      docs.slice(0, 6).forEach(function (f) {
        h += '<a class="bbg-file" style="margin-top:8px" href="' + esc(f.url) + '" target="_blank" rel="noopener"><span class="bbg-file-ic">📄</span>'
          + '<span class="bbg-file-t"><b>' + esc(f.name) + '</b><span>' + esc(fmtBytes(f.size) + ' · ' + f.senderName) + '</span></span></a>';
      });
      if ((media.links || []).length) {
        h += '<div class="bbg-links" style="margin-top:8px">' + media.links.slice(0, 6).map(function (l) {
          return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.url) + '</a>';
        }).join('') + '</div>';
      }
      h += '</div>';
    }

    h += '<div class="bbg-sec"><div class="bbg-sec-h">' + S.members.length + ' members</div>'
      + (canManage ? actHtml('add', 'users', 'Add member') : '')
      + S.members.map(function (m) {
          var you = String(m.userId) === myId();
          return '<div class="bbg-person">' + avatarHtml(m.name, m.avatar, 'bbg-av--sm')
            + '<div class="bbg-person-t"><b>' + esc(you ? 'You' : m.name) + '</b><span>' + esc(m.email || '') + '</span></div>'
            + '<span class="bbg-role">' + esc(m.roleLabel) + '</span>'
            + (canManage && !you && String(m.userId) !== String(g.clientId)
                ? '<button type="button" class="bbg-ib" data-remove="' + esc(m.userId) + '" aria-label="Remove ' + esc(m.name) + '">' + icon('close') + '</button>'
                : '')
            + '</div>';
        }).join('')
      + '</div>';

    h += '<div class="bbg-sec">'
      + actHtml('search', 'search', 'Search messages')
      + (S.me.isMember ? actHtml('mute', S.me.muted ? 'belloff' : 'bell', 'Notifications', false, S.me.muted ? 'Muted' : 'On') : '')
      + (canManage ? actHtml('rename', 'edit', 'Edit group name') : '')
      + (canManage ? actHtml('avatar', 'image', 'Change group photo') : '')
      + (canManage ? actHtml('activity', 'list', 'Group activity') : '')
      + (canManage ? actHtml('archive', 'archive', g.archived ? 'Reopen group' : 'Archive group') : '')
      + (S.me.isMember && String(S.me.userId) !== String(g.clientId) ? actHtml('leave', 'leave', 'Leave group', true) : '')
      + '</div>';
    box.innerHTML = h;
    bindInfoActs(box);
    each(box.querySelectorAll('[data-remove]'), function (b) {
      b.onclick = function () { removeMember(b.getAttribute('data-remove')); };
    });
  }

  function actHtml(act, ic, label, danger, trail) {
    return '<button type="button" class="bbg-act' + (danger ? ' is-danger' : '') + '" data-act="' + act + '">'
      + icon(ic) + '<span>' + esc(label) + '</span>' + (trail ? '<span class="bbg-act-trail">' + esc(trail) + '</span>' : '') + '</button>';
  }

  function bindInfoActs(box) {
    each(box.querySelectorAll('.bbg-act'), function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-act');
        if (act === 'search') {
          if (isDesktop()) { toggleFind(); return; }
          goBack();
          setTimeout(toggleFind, 340);
        }
        else if (act === 'mute') toggleMute();
        else if (act === 'add') openAddMember();
        else if (act === 'rename') renameGroup();
        else if (act === 'avatar') changeAvatar();
        else if (act === 'activity') showActivity();
        else if (act === 'archive') toggleArchive();
        else if (act === 'leave') leaveGroup();
      };
    });
  }

  async function toggleMute() {
    var next = !S.me.muted;
    var res = await api('POST', '/api/groups/' + enc(S.groupId) + '/mute', { muted: next });
    if (res && res.error) { toast(res.error, true); return; }
    S.me.muted = next;
    if (S.conv) S.conv.muted = next;
    toast(next ? 'Notifications muted' : 'Notifications on');
    if (S.infoOpen) renderInfo();
    renderList();
  }

  function renameGroup() {
    promptModal('Group name', S.group.name, 'Save', async function (val) {
      if (!val.trim()) return 'Group name cannot be empty.';
      var res = await api('PATCH', '/api/groups/' + enc(S.groupId), { name: val.trim() });
      if (res && res.error) return res.error;
      S.group.name = val.trim();
      if (S.conv) S.conv.name = val.trim();
      renderHeader();
      if (S.infoOpen) renderInfo();
      BBG.refreshList();
      return null;
    });
  }

  function changeAvatar() {
    promptModal('Group photo', S.group.avatarUrl || '', 'Save', async function (val) {
      var res = await api('PATCH', '/api/groups/' + enc(S.groupId), { avatar_url: val.trim() });
      if (res && res.error) return res.error;
      S.group.avatarUrl = val.trim();
      renderHeader();
      if (S.infoOpen) renderInfo();
      BBG.refreshList();
      return null;
    }, 'Paste an image link, or leave it blank to use the client\'s initials.');
  }

  function toggleArchive() {
    var next = !S.group.archived;
    confirmModal(next ? 'Archive this group?' : 'Reopen this group?',
      next ? 'Everyone can still read it, but nobody can send messages until it is reopened.'
           : 'Members will be able to send messages again.',
      next ? 'Archive' : 'Reopen',
      async function () {
        var res = await api('PATCH', '/api/groups/' + enc(S.groupId), { archived: next });
        if (res && res.error) { toast(res.error, true); return; }
        S.group.archived = next;
        S.me.canPost = !next;
        renderHeader();
        renderComposer();
        if (S.infoOpen) renderInfo();
        BBG.refreshList();
      });
  }

  function leaveGroup() {
    confirmModal('Leave this group?', 'You will stop receiving messages from this care team.', 'Leave', async function () {
      var res = await api('DELETE', '/api/groups/' + enc(S.groupId) + '/members/' + enc(S.me.userId));
      if (res && res.error) { toast(res.error, true); return; }
      hideInfo(true);
      leaveChat();
      BBG.refreshList();
    });
  }

  function removeMember(uid) {
    var m = S.members.find(function (x) { return String(x.userId) === String(uid); });
    confirmModal('Remove ' + (m ? m.name : 'this member') + '?',
      'They lose access to this group. Their past messages stay.', 'Remove', async function () {
        var res = await api('DELETE', '/api/groups/' + enc(S.groupId) + '/members/' + enc(uid));
        if (res && res.error) { toast(res.error, true); return; }
        S.members = res.members || S.members;
        renderHeader();
        renderInfo();
        poll(true);
      });
  }

  async function showActivity() {
    try {
      var res = await api('GET', '/api/groups/' + enc(S.groupId) + '/audit');
      if (res && res.error) { toast(res.error, true); return; }
      var rows = res.events || [];
      infoModal('Group activity', rows.length
        ? rows.map(function (e) {
            return '<div class="bbg-person"><div class="bbg-person-t"><b style="white-space:normal">' + esc(e.detail || e.action) + '</b>'
              + '<span>' + esc((e.actor_name || 'System') + ' · ' + new Date(e.created_at).toLocaleString()) + '</span></div></div>';
          }).join('')
        : '<div class="bbg-hint">No activity recorded yet.</div>');
    } catch (e) { toast('Could not load activity', true); }
  }

  async function openAddMember() {
    try {
      var data = await api('GET', '/api/groups/candidates');
      if (data && data.error) { toast(data.error, true); return; }
      var inGroup = {};
      S.members.forEach(function (m) { inGroup[String(m.userId)] = true; });
      var pool = (data.staff || []).concat(data.clients || []).filter(function (p) { return !inGroup[String(p.id)]; });
      if (!pool.length) { toast('Everyone available is already in this group'); return; }
      var roleOpts = (data.roles || []).filter(function (r) { return r.value !== 'client'; });
      var modal = infoModal('Add member',
        '<div class="bbg-fieldset"><span class="bbg-field-l">Role in this group</span><select id="bbgAddRole">'
        + roleOpts.map(function (r) { return '<option value="' + esc(r.value) + '">' + esc(r.label) + '</option>'; }).join('')
        + '</select><div class="bbg-hint">Applies inside this group only — it does not change their BodyBank account.</div></div>'
        + '<div class="bbg-fieldset"><input type="search" id="bbgAddSearch" placeholder="Search by name or email" autocomplete="off"></div>'
        + '<div class="bbg-pick-list" id="bbgAddList"></div>');
      var draw = function (q) {
        q = (q || '').toLowerCase();
        var rows = pool.filter(function (p) {
          return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.email.toLowerCase().indexOf(q) >= 0;
        }).slice(0, 60);
        el('bbgAddList').innerHTML = rows.length ? rows.map(function (p) {
          return '<button type="button" class="bbg-pick" data-id="' + esc(p.id) + '">' + avatarHtml(p.name, p.avatar, 'bbg-av--sm')
            + '<div class="bbg-pick-t"><b>' + esc(p.name) + '</b><span>' + esc(p.email + ' · ' + p.accountRole) + '</span></div></button>';
        }).join('') : '<div class="bbg-find-note">No matches.</div>';
        each(el('bbgAddList').querySelectorAll('.bbg-pick'), function (b) {
          b.onclick = async function () {
            b.disabled = true;
            var res = await api('POST', '/api/groups/' + enc(S.groupId) + '/members', {
              user_id: b.getAttribute('data-id'), group_role: el('bbgAddRole').value
            });
            closeModal(modal);
            if (res && res.error) { toast(res.error, true); return; }
            S.members = res.members || S.members;
            renderHeader();
            if (S.infoOpen) renderInfo();
            poll(true);
            toast('Member added');
          };
        });
      };
      el('bbgAddSearch').oninput = function () { draw(this.value); };
      draw('');
    } catch (e) { toast('Could not load people', true); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODALS
  // ══════════════════════════════════════════════════════════════════════════

  function baseModal(title, bodyHtml, footHtml) {
    var wrap = document.createElement('div');
    wrap.className = 'bbg bbg-modal-veil';
    wrap.innerHTML = '<div class="bbg-modal" role="dialog" aria-label="' + esc(title) + '">'
      + '<div class="bbg-modal-h"><div class="bbg-modal-title">' + esc(title) + '</div>'
      + '<button type="button" class="bbg-ib" data-close="1" aria-label="Close">' + icon('close') + '</button></div>'
      + '<div class="bbg-modal-b">' + bodyHtml + '</div>'
      + (footHtml ? '<div class="bbg-modal-f">' + footHtml + '</div>' : '')
      + '</div>';
    document.body.appendChild(wrap);
    wrap.onclick = function (e) { if (e.target === wrap) closeModal(wrap); };
    wrap.querySelector('[data-close]').onclick = function () { closeModal(wrap); };
    return wrap;
  }
  function closeModal(m) { if (m && m.parentNode) m.parentNode.removeChild(m); }
  function infoModal(title, bodyHtml) { return baseModal(title, bodyHtml, ''); }

  /** `onOk(value)` returns an error string to keep the modal open, or null. */
  function promptModal(title, initial, okLabel, onOk, hint) {
    var m = baseModal(title,
      '<div class="bbg-fieldset"><textarea id="bbgPromptInput" rows="3">' + esc(initial || '') + '</textarea>'
      + (hint ? '<div class="bbg-hint">' + esc(hint) + '</div>' : '')
      + '<div class="bbg-hint is-err" id="bbgPromptErr"></div></div>',
      '<button type="button" class="bbg-btn" data-x>Cancel</button><button type="button" class="bbg-btn bbg-btn--gold" data-ok>' + esc(okLabel) + '</button>');
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
    var m = baseModal(title, '<div class="bbg-sec-note">' + esc(text) + '</div>',
      '<button type="button" class="bbg-btn" data-x>Cancel</button><button type="button" class="bbg-btn bbg-btn--gold" data-ok>' + esc(okLabel) + '</button>');
    m.querySelector('[data-x]').onclick = function () { closeModal(m); };
    var ok = m.querySelector('[data-ok]');
    ok.onclick = async function () { ok.disabled = true; await onOk(); closeModal(m); };
    return m;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — MESSAGE A CLIENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Search for a client and open a private chat. Search-only on purpose: the
   * inbox lists just the people the admin has actually talked to, so this is
   * how to reach anyone else without dumping the roster into the UI.
   */
  BBG.openNewMessage = function () {
    var modal = infoModal('Message a client',
      '<div class="bbg-fieldset"><label class="bbg-searchbox">' + icon('search')
      + '<input type="search" id="bbgDmSearch" placeholder="Search by name or email" autocomplete="off"></label>'
      + '<div class="bbg-hint">Nothing is sent until you type a message.</div></div>'
      + '<div class="bbg-pick-list" id="bbgDmList"></div>');
    var input = modal.querySelector('#bbgDmSearch');
    var list = modal.querySelector('#bbgDmList');
    var timer = null;
    var reqId = 0;
    var note = function (t) { list.innerHTML = '<div class="bbg-find-note">' + esc(t) + '</div>'; };

    async function run(q) {
      var mine = ++reqId;
      try {
        var res = await api('GET', '/api/groups/directory?q=' + enc(q));
        if (mine !== reqId) return;   // a slower, older search must not win
        var rows = (res && res.clients) || [];
        if (!rows.length) { note(q ? 'No client matches that.' : 'No clients yet.'); return; }
        list.innerHTML = rows.map(function (c) {
          return '<button type="button" class="bbg-pick" data-id="' + esc(c.id) + '">' + avatarHtml(c.name, c.avatar, 'bbg-av--sm')
            + '<div class="bbg-pick-t"><b>' + esc(c.name) + '</b><span>' + esc(c.email) + '</span></div></button>';
        }).join('');
        each(list.querySelectorAll('.bbg-pick'), function (b) {
          b.onclick = function () { start(b.getAttribute('data-id'), b); };
        });
      } catch (e) {
        if (mine === reqId) note('Search failed.');
      }
    }

    async function start(userId, btn) {
      btn.disabled = true;
      try {
        var res = await api('POST', '/api/groups/direct', { user_id: userId });
        if (!res || res.error || !res.conversation) { toast((res && res.error) || 'Could not open that chat', true); btn.disabled = false; return; }
        closeModal(modal);
        var conv = res.conversation;
        var existing = S.conversations.find(function (c) { return c.id === conv.id; });
        if (!existing) { S.conversations.unshift(conv); renderList(); }
        if (!isOpen()) BBG.open({ mode: 'admin' });
        openConversation(existing || conv);
      } catch (e) {
        toast('Could not open that chat', true);
        btn.disabled = false;
      }
    }

    input.oninput = function () {
      clearTimeout(timer);
      var q = this.value.trim();
      timer = setTimeout(function () { run(q); }, 200);
    };
    input.focus();
    run('');
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN — CREATE A CARE GROUP
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Three steps: pick the client (which fixes the name), staff the care team,
   * review. The review step is where the duplicate warning surfaces.
   */
  BBG.openCreateGroup = async function () {
    var data;
    try {
      data = await api('GET', '/api/groups/candidates');
      if (data && data.error) { toast(data.error, true); return; }
    } catch (e) { toast('Could not load clients', true); return; }

    var W = { step: 1, client: null, picked: [], name: '', force: false };
    var modal = baseModal('New care group', '<div id="bbgWiz"></div>',
      '<button type="button" class="bbg-btn" data-back style="margin-right:auto">Back</button>'
      + '<button type="button" class="bbg-btn bbg-btn--gold" data-next>Next</button>');
    var backBtn = modal.querySelector('[data-back]');
    var nextBtn = modal.querySelector('[data-next]');
    backBtn.onclick = function () { if (W.step > 1) { W.step--; draw(); } };
    nextBtn.onclick = function () { advance(); };
    var titleEl = modal.querySelector('.bbg-modal-title');

    function draw() {
      var b = modal.querySelector('#bbgWiz');
      backBtn.style.visibility = W.step === 1 ? 'hidden' : 'visible';
      nextBtn.textContent = W.step === 3 ? 'Create group' : 'Next';

      if (W.step === 1) {
        titleEl.textContent = 'New group · 1 of 3';
        b.innerHTML = '<div class="bbg-fieldset"><span class="bbg-field-l">Who is this group for?</span>'
          + '<label class="bbg-searchbox">' + icon('search') + '<input type="search" id="bbgWizSearch" placeholder="Search clients" autocomplete="off"></label></div>'
          + '<div class="bbg-pick-list" id="bbgWizList"></div>';
        var drawClients = function (q) {
          q = (q || '').toLowerCase();
          var rows = (data.clients || []).filter(function (c) {
            return !q || c.name.toLowerCase().indexOf(q) >= 0 || c.email.toLowerCase().indexOf(q) >= 0;
          }).slice(0, 80);
          el('bbgWizList').innerHTML = rows.length ? rows.map(function (c) {
            var active = ((data.existingByClient || {})[c.id] || []).filter(function (d) { return !d.archived; });
            return '<button type="button" class="bbg-pick' + (W.client && W.client.id === c.id ? ' is-on' : '') + '" data-id="' + esc(c.id) + '">'
              + avatarHtml(c.name, c.avatar, 'bbg-av--sm')
              + '<div class="bbg-pick-t"><b>' + esc(c.name) + '</b><span>' + esc(c.email)
              + (active.length ? ' · already has a group' : '') + '</span></div><span class="bbg-check">✓</span></button>';
          }).join('') : '<div class="bbg-find-note">No clients found.</div>';
          each(el('bbgWizList').querySelectorAll('.bbg-pick'), function (btn) {
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
        titleEl.textContent = 'New group · 2 of 3';
        var roleOpts = (data.roles || []).filter(function (r) { return r.value !== 'client'; });
        b.innerHTML = '<div class="bbg-review" style="margin-bottom:16px"><h4>' + esc(W.name) + '</h4>'
          + '<p>' + esc(W.client.name) + '<span>Client</span></p></div>'
          + '<div class="bbg-fieldset"><span class="bbg-field-l">Add the care team</span>'
          + '<label class="bbg-searchbox">' + icon('search') + '<input type="search" id="bbgWizStaffSearch" placeholder="Search people" autocomplete="off"></label>'
          + '<div class="bbg-hint">Choose each person\'s role. It applies in this group only.</div></div>'
          + '<div class="bbg-pick-list" id="bbgWizStaff"></div>';
        var pool = (data.staff || []).concat((data.clients || []).filter(function (c) { return c.id !== W.client.id; }));
        var drawStaff = function (q) {
          q = (q || '').toLowerCase();
          var rows = pool.filter(function (p) {
            return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.email.toLowerCase().indexOf(q) >= 0;
          }).slice(0, 60);
          el('bbgWizStaff').innerHTML = rows.length ? rows.map(function (p) {
            var pick = W.picked.find(function (x) { return x.user_id === p.id; });
            return '<div class="bbg-pick' + (pick ? ' is-on' : '') + '">' + avatarHtml(p.name, p.avatar, 'bbg-av--sm')
              + '<div class="bbg-pick-t"><b>' + esc(p.name) + '</b><span>' + esc(p.email + ' · ' + p.accountRole) + '</span></div>'
              + '<select data-role-for="' + esc(p.id) + '" aria-label="Role for ' + esc(p.name) + '"><option value="">Not in group</option>'
              + roleOpts.map(function (r) {
                  return '<option value="' + esc(r.value) + '"' + (pick && pick.group_role === r.value ? ' selected' : '') + '>' + esc(r.label) + '</option>';
                }).join('') + '</select></div>';
          }).join('') : '<div class="bbg-find-note">No people found.</div>';
          each(el('bbgWizStaff').querySelectorAll('[data-role-for]'), function (sel) {
            sel.onchange = function () {
              var uid = sel.getAttribute('data-role-for');
              W.picked = W.picked.filter(function (x) { return x.user_id !== uid; });
              if (sel.value) W.picked.push({ user_id: uid, group_role: sel.value });
              sel.closest('.bbg-pick').classList.toggle('is-on', !!sel.value);
            };
          });
        };
        el('bbgWizStaffSearch').oninput = function () { drawStaff(this.value); };
        drawStaff('');
        return;
      }

      titleEl.textContent = 'New group · 3 of 3';
      var byId = {};
      (data.staff || []).concat(data.clients || []).forEach(function (p) { byId[p.id] = p; });
      var label = {};
      (data.roles || []).forEach(function (r) { label[r.value] = r.label; });
      b.innerHTML = '<div class="bbg-fieldset"><span class="bbg-field-l">Group name</span>'
        + '<input type="text" id="bbgWizName" value="' + esc(W.name) + '" maxlength="160">'
        + '<div class="bbg-hint">Named <b>Client Name - 2.0</b> by default. You can rename it later.</div></div>'
        + '<div class="bbg-review"><h4>' + (W.picked.length + 1) + ' members</h4>'
        + '<p>' + esc(W.client.name) + '<span>Client</span></p>'
        + W.picked.map(function (p) {
            var u = byId[p.user_id];
            return '<p>' + esc(u ? u.name : p.user_id) + '<span>' + esc(label[p.group_role] || p.group_role) + '</span></p>';
          }).join('')
        + '</div><div class="bbg-hint is-err" id="bbgWizErr" style="margin-top:12px"></div>';
      el('bbgWizName').oninput = function () { W.name = this.value; };
    }

    async function advance() {
      if (W.step === 1) { if (!W.client) { toast('Pick a client first'); return; } W.step = 2; draw(); return; }
      if (W.step === 2) { W.step = 3; draw(); return; }
      nextBtn.disabled = true;
      var err = el('bbgWizErr');
      try {
        var res = await api('POST', '/api/groups', { client_id: W.client.id, name: W.name.trim(), members: W.picked, force: W.force });
        if (res && res.error) {
          err.textContent = res.error + ' ';
          if (res.existing && !W.force) {
            var again = document.createElement('button');
            again.type = 'button';
            again.className = 'bbg-btn';
            again.style.marginTop = '10px';
            again.textContent = 'Create a second group anyway';
            again.onclick = function () { W.force = true; advance(); };
            err.appendChild(document.createElement('br'));
            err.appendChild(again);
          }
          nextBtn.disabled = false;
          return;
        }
        closeModal(modal);
        toast('Group "' + (res.group && res.group.name) + '" created');
        await BBG.refreshList();
        if (res.group) {
          if (!isOpen()) BBG.open({ mode: 'admin', groupId: res.group.id });
          else BBG.openGroup(res.group.id);
        }
      } catch (e) {
        err.textContent = 'Could not create the group. Try again.';
        nextBtn.disabled = false;
      }
    }

    draw();
  };
})();
