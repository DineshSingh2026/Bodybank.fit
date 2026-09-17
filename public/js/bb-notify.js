/* BodyBank notifications — one client-side piece for every role and platform.
 *
 *  - Turns notifications on: web push (browsers, installed PWA incl. iOS 16.4+
 *    home-screen apps) or FCM (the Android / iOS apps, via registerNativePush in
 *    index.html). A granted browser re-subscribes silently on every dashboard
 *    open, so a cleared subscription heals itself; an undecided one gets a single
 *    friendly card instead of nothing.
 *  - Routes a tapped notification to its screen. The server sends
 *    `link` (screen name) and `url` (/?open=<link> or /?group=<id>) on every push:
 *      · page opened from a banner      → ?open= / ?group= on load
 *      · page already open (web)        → service worker posts { type: 'bb-open' }
 *      · native app                     → FirebaseMessaging notificationActionPerformed
 *  - Adds an on/off status row with "Send test" to every bell panel.
 *
 * Public: window.BBNotify = { ensure, route, test, status }
 */
(function () {
  'use strict';
  if (window.BBNotify) return;

  var DISMISS_KEY = 'bb_notify_card_dismissed_at';
  var IOS_HINT_KEY = 'bb_notify_ios_hint_at';
  var state = { pending: null, nativeBound: false, swBound: false, lastEnsure: 0, status: null };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function user() { return window.currentUser || null; }
  function role() { var u = user(); return (u && u.role) || ''; }
  function isStaff() { var r = role(); return r === 'admin' || r === 'superadmin' || r === 'operator'; }
  function isApp() { return !!window.IS_BODYBANK_APP; }
  function api(method, path, body) {
    if (typeof window.apiCall !== 'function') return Promise.reject(new Error('api unavailable'));
    return window.apiCall(method, path, body);
  }
  function isOpen(id) { var el = document.getElementById(id); return !!(el && el.classList.contains('open')); }

  function webSupported() {
    return !isApp() && typeof window.Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  }
  function isIos() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    try { if (window.matchMedia('(display-mode: standalone)').matches) return true; } catch (e) { /* old browser */ }
    return window.navigator.standalone === true;
  }

  function b64ToBytes(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* ───────────────────────────── web push ───────────────────────────── */
  function subscribeWeb() {
    var key;
    return api('GET', '/api/push/vapid-public').then(function (res) {
      key = res && res.publicKey;
      if (!key) throw new Error('Notifications are not configured on the server yet.');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      });
    }).then(function (sub) {
      var j = sub.toJSON ? sub.toJSON() : { endpoint: sub.endpoint, keys: {} };
      return api('POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys || {} });
    });
  }

  /** Ask (must run from a tap on Safari) and subscribe. Resolves true when on. */
  function turnOn() {
    if (isApp()) {
      if (typeof window.registerNativePush === 'function') window.registerNativePush();
      return Promise.resolve(true);
    }
    if (!webSupported()) {
      if (isIos() && !isStandalone()) showIosHint(true);
      return Promise.resolve(false);
    }
    return Promise.resolve(Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission)
      .then(function (perm) {
        if (perm !== 'granted') return false;
        return subscribeWeb().then(function () { return true; });
      })
      .catch(function (e) { toast('Could not turn on notifications', e && e.message); return false; })
      .then(function (on) { hideCard(); refreshStatus(); syncLegacyButtons(); return on; });
  }

  function syncLegacyButtons() {
    try { if (typeof window.checkUserPushStatus === 'function') window.checkUserPushStatus(); } catch (e) { /* optional */ }
    try {
      if (typeof window.updateNotifyPermissionUI === 'function' && typeof Notification !== 'undefined') {
        window.updateNotifyPermissionUI(Notification.permission === 'granted');
      }
    } catch (e) { /* optional */ }
  }

  /* ───────────────────────────── native app ───────────────────────────── */
  function nativePlugin() {
    var Cap = window.Capacitor;
    return (Cap && Cap.Plugins && Cap.Plugins.FirebaseMessaging) || null;
  }
  function bindNative() {
    if (state.nativeBound || !isApp()) return;
    var FM = nativePlugin();
    if (!FM || typeof FM.addListener !== 'function') return;
    state.nativeBound = true;
    try {
      FM.addListener('notificationActionPerformed', function (ev) {
        var d = (ev && ev.notification && ev.notification.data) || {};
        route(d.link, d.url);
      });
    } catch (e) { /* older plugin */ }
    try {
      // App in the foreground: the OS shows nothing on Android, so the app does.
      FM.addListener('notificationReceived', function (ev) {
        var n = (ev && ev.notification) || {};
        var d = n.data || {};
        refreshBell();
        toast(n.title || 'BodyBank', n.body || '', function () { route(d.link, d.url); });
      });
    } catch (e) { /* older plugin */ }
  }

  /* ───────────────────────────── routing ───────────────────────────── */
  function parseTarget(link, url) {
    var t = { link: link ? String(link) : '', group: '' };
    if (url) {
      try {
        var u = new URL(String(url), location.origin);
        t.link = t.link || u.searchParams.get('open') || '';
        t.group = u.searchParams.get('group') || '';
      } catch (e) { /* not a URL */ }
    }
    if (t.group && !t.link) t.link = 'messages';
    t.link = t.link.replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    t.group = t.group.replace(/[^a-z0-9-]/gi, '').slice(0, 64);
    return t;
  }

  function ready() {
    var r = role();
    if (!r) return false;
    if (r === 'user') return isOpen('userPanel');
    if (r === 'operator') return isOpen('operatorPanel');
    return isOpen('adminPanel') || isOpen('superadminPanel');
  }

  function route(link, url) {
    var t = parseTarget(link, url);
    if (!t.link && !t.group) return;
    if (!ready()) { state.pending = t; waitAndRoute(); return; }
    try { go(t); } catch (e) { console.warn('[bb-notify] route failed', e); }
  }

  var waitTimer = null;
  function waitAndRoute() {
    if (waitTimer) return;
    var started = Date.now();
    waitTimer = setInterval(function () {
      if (!state.pending) { clearInterval(waitTimer); waitTimer = null; return; }
      if (ready()) {
        var t = state.pending; state.pending = null;
        clearInterval(waitTimer); waitTimer = null;
        // Let the dashboard finish its own first paint.
        setTimeout(function () { try { go(t); } catch (e) { /* ignore */ } }, 350);
      } else if (Date.now() - started > 30000) {
        clearInterval(waitTimer); waitTimer = null;
      }
    }, 250);
  }

  function openChat(mode, groupId) {
    if (!window.BBGroupChat || typeof window.BBGroupChat.open !== 'function') return false;
    window.BBGroupChat.open(groupId ? { mode: mode, groupId: groupId } : { mode: mode });
    return true;
  }

  // Staff screen names → the operator console's screens. Anything else (WhatsApp
  // drafts, 1-to-1 messages) has no operator screen.
  var OP_SCREEN = {
    inbox: 'inbox', escalations: 'inbox', blood: 'blood', smartscale: 'smartscale',
    clientprogress: 'clients', memberships: 'clients', clients: 'clients', tribe: 'clients', reports: 'clients',
    dailycheckin: 'pulse', sundaycheckin: 'pulse', workouts: 'pulse', nutrition: 'pulse', dailycompliance: 'pulse',
    requests: 'prospects', leads: 'prospects', part2: 'prospects', nutritionassessment: 'prospects',
    home: 'home', meetings: 'home'
  };
  function operatorScreen(link) { return OP_SCREEN[String(link || '')] || null; }

  function go(t) {
    var r = role();
    var link = t.link;
    if (r === 'user') {
      if (link === 'messages') {
        if (typeof window.switchUserTab === 'function') window.switchUserTab('messages');
        if (t.group) openChat('member', t.group);
        return;
      }
      var tab = document.getElementById('usec-' + link) ? link : 'home';
      if (typeof window.switchUserTab === 'function') window.switchUserTab(tab);
      return;
    }
    if (r === 'operator') {
      if (link === 'messages' && t.group && openChat('admin', t.group)) return;
      var screen = operatorScreen(link);
      if (typeof window.opNav === 'function') window.opNav(screen || 'home');
      // No screen for it (a WhatsApp alert): show the alert list, where it is.
      if (!screen && typeof window.openOperatorAlerts === 'function') {
        var panel = document.getElementById('opNotifyPanel');
        if (!panel || !panel.classList.contains('open')) setTimeout(window.openOperatorAlerts, 200);
      }
      return;
    }
    // admin / superadmin
    if (!isOpen('adminPanel')) return; // the superadmin analytics panel has no screens to open
    if (link === 'escalations' && typeof window.openAdminEscalations === 'function') { window.openAdminEscalations(); return; }
    if (link === 'wa') { openWaDrafts(); return; }
    if (link === 'messages') {
      if (t.group) { openChat('admin', t.group); return; }
      if (typeof window.switchTab === 'function') window.switchTab('messages');
      return;
    }
    if (link && document.getElementById('tab-' + link) && typeof window.switchTab === 'function') { window.switchTab(link); return; }
    if (link && typeof window.switchToSection === 'function') { window.switchToSection(link); }
  }

  // WhatsApp drafts live in a drawer on the Messages tab, under the full-screen chat.
  function openWaDrafts() {
    if (typeof window.switchTab === 'function') window.switchTab('messages');
    setTimeout(function () {
      if (window.BBGroupChat && typeof window.BBGroupChat.close === 'function') window.BBGroupChat.close();
      var d = document.getElementById('bbAdminWaDrawer');
      if (d) {
        d.open = true;
        if (typeof window.loadWaDrafts === 'function') window.loadWaDrafts();
        try { d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { d.scrollIntoView(); }
      }
    }, 60);
  }

  function readUrlOnce() {
    try {
      var p = new URLSearchParams(location.search);
      var open = p.get('open');
      if (!open) return;
      p.delete('open');
      var q = p.toString();
      history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
      state.pending = parseTarget(open, null);
      waitAndRoute();
    } catch (e) { /* old browser */ }
  }

  function bindServiceWorker() {
    if (state.swBound || !('serviceWorker' in navigator)) return;
    state.swBound = true;
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== 'bb-open') return;
      refreshBell();
      route(d.link, d.url);
    });
  }

  /* ───────────────────────────── UI ───────────────────────────── */
  function injectStyles() {
    if (document.getElementById('bbNotifyStyles')) return;
    var css = ''
      + '.bbn-card{position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:10025;'
      + 'width:min(420px,calc(100vw - 32px));background:#15130f;color:#f3ede0;border:1px solid rgba(201,168,76,.45);border-radius:16px;'
      + 'box-shadow:0 18px 50px rgba(0,0,0,.45);padding:16px 16px 14px;display:flex;gap:12px;align-items:flex-start;font-size:14px;line-height:1.4;'
      + 'animation:bbnIn .28s ease-out}'
      + '@keyframes bbnIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}'
      + '.bbn-card .bbn-ic{font-size:24px;line-height:1}'
      + '.bbn-card h4{margin:0 0 4px;font-size:15px;color:#e8c872}'
      + '.bbn-card p{margin:0 0 10px;color:#cfc6b4}'
      + '.bbn-btns{display:flex;gap:8px;flex-wrap:wrap}'
      + '.bbn-btn{border:0;border-radius:999px;padding:8px 14px;font:600 13px/1 inherit;cursor:pointer}'
      + '.bbn-btn--on{background:linear-gradient(135deg,#e8c872,#b8923a);color:#16130c}'
      + '.bbn-btn--ghost{background:transparent;color:#cfc6b4;border:1px solid rgba(255,255,255,.18)}'
      + '.bbn-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:#bdb4a2}'
      + '.bbn-row b{color:#e8c872;font-weight:600}'
      + '.bbn-row button{background:transparent;border:1px solid rgba(201,168,76,.5);color:#e8c872;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap}'
      + '.bbn-toast{position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:10045;'
      + 'width:min(420px,calc(100vw - 24px));background:#1b1812;color:#f3ede0;border:1px solid rgba(201,168,76,.4);border-radius:14px;'
      + 'padding:12px 14px;box-shadow:0 12px 36px rgba(0,0,0,.45);cursor:pointer;animation:bbnDrop .25s ease-out;font-size:13px}'
      + '@keyframes bbnDrop{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}'
      + '.bbn-toast strong{display:block;color:#e8c872;margin-bottom:2px;font-size:14px}';
    var st = document.createElement('style');
    st.id = 'bbNotifyStyles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(title, body, onTap) {
    injectStyles();
    var old = document.getElementById('bbnToast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'bbnToast';
    el.className = 'bbn-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<strong>' + esc(title) + '</strong>' + (body ? '<span>' + esc(body) + '</span>' : '');
    el.addEventListener('click', function () { el.remove(); if (onTap) onTap(); });
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (el.parentNode) el.remove(); }, 6000);
  }

  function cardCopy() {
    var r = role();
    if (r === 'operator') return 'Get an alert when a client needs attention — check-ins, inactivity, blood reports and admin replies.';
    if (r === 'admin' || r === 'superadmin') return 'Get an alert for client messages, WhatsApp replies from Kling, check-ins, sign-ups and reports.';
    return 'Get a heads-up when your Lifestyle Manager replies, a report is ready, or a check-in is due.';
  }

  function hideCard() { var c = document.getElementById('bbnCard'); if (c) c.remove(); }

  // Another popup (profile photo, program assigned …) goes first; the card waits.
  function popupOpen() {
    return !!document.querySelector('.modal-overlay.open, .modal-overlay.show, .popup-overlay.show, .popup-overlay.open, #bb-update-modal:not(.bb-pwa-modal-hidden)')
      || (window.BBGroupChat && window.BBGroupChat.state && document.getElementById('bbgApp') && !document.getElementById('bbgApp').hidden);
  }
  function showCard(attempt) {
    if (document.getElementById('bbnCard')) return;
    var at = Number(lsGet(DISMISS_KEY) || 0);
    if (at && Date.now() - at < 3 * 86400000) return;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') return;
    if (popupOpen()) {
      if ((attempt || 0) < 20) setTimeout(function () { showCard((attempt || 0) + 1); }, 3000);
      return;
    }
    injectStyles();
    var el = document.createElement('div');
    el.id = 'bbnCard';
    el.className = 'bbn-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Turn on notifications');
    el.innerHTML = '<div class="bbn-ic" aria-hidden="true">🔔</div><div><h4>Turn on notifications</h4><p>' + esc(cardCopy())
      + '</p><div class="bbn-btns"><button type="button" class="bbn-btn bbn-btn--on">Turn on</button>'
      + '<button type="button" class="bbn-btn bbn-btn--ghost">Not now</button></div></div>';
    el.querySelector('.bbn-btn--on').addEventListener('click', function () { turnOn(); });
    el.querySelector('.bbn-btn--ghost').addEventListener('click', function () { lsSet(DISMISS_KEY, String(Date.now())); hideCard(); });
    document.body.appendChild(el);
  }

  function showIosHint(force) {
    var at = Number(lsGet(IOS_HINT_KEY) || 0);
    if (!force && at && Date.now() - at < 14 * 86400000) return;
    lsSet(IOS_HINT_KEY, String(Date.now()));
    if (typeof window.showPopup === 'function') {
      window.showPopup('Notifications on iPhone',
        'iPhone only delivers website notifications to apps on your Home Screen. In Safari tap Share → Add to Home Screen, open BodyBank from there, then tap Turn on. Or install the BodyBank app from the App Store.',
        '', 'OK');
    }
  }

  function statusText(st) {
    if (isApp()) {
      var n = st && st.mine ? (st.mine.android + st.mine.ios) : 0;
      if (st && st.server && !st.server.nativePush) return { on: false, text: 'App notifications are not set up on the server yet' };
      return n ? { on: true, text: 'Notifications <b>on</b> for this phone' } : { on: false, text: 'Notifications are <b>off</b> on this phone' };
    }
    if (!webSupported()) {
      if (isIos() && !isStandalone()) return { on: false, text: 'Add BodyBank to your Home Screen for notifications', ios: true };
      return { on: false, text: 'This browser cannot show notifications' };
    }
    if (Notification.permission === 'denied') return { on: false, text: 'Notifications are blocked — allow them in browser settings', blocked: true };
    if (Notification.permission === 'granted' && st && st.mine && st.mine.browsers > 0) return { on: true, text: 'Notifications <b>on</b> in this browser' };
    return { on: false, text: 'Notifications are <b>off</b> in this browser' };
  }

  function renderRows() {
    var st = statusText(state.status);
    ['notifyPanel', 'userNotifyPanel', 'opNotifyPanel'].forEach(function (id) {
      var panel = document.getElementById(id);
      if (!panel) return;
      var row = panel.querySelector('.bbn-row');
      if (!row) {
        injectStyles();
        row = document.createElement('div');
        row.className = 'bbn-row';
        var footer = panel.querySelector('.admin-notify-footer');
        panel.insertBefore(row, footer || null);
        row.addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (!b) return;
          e.stopPropagation();
          if (b.getAttribute('data-act') === 'test') test();
          else if (b.getAttribute('data-act') === 'ios') showIosHint(true);
          else turnOn();
        });
      }
      var btn = st.on ? '<button type="button" data-act="test">Send test</button>'
        : st.ios ? '<button type="button" data-act="ios">How?</button>'
        : st.blocked ? '' : '<button type="button" data-act="on">Turn on</button>';
      row.innerHTML = '<span>' + st.text + '</span>' + btn;
    });
  }

  function refreshStatus() {
    if (!user()) return Promise.resolve(null);
    return api('GET', '/api/push/status').then(function (st) {
      state.status = st && st.mine ? st : null;
      renderRows();
      return state.status;
    }).catch(function () { renderRows(); return null; });
  }

  function refreshBell() {
    try {
      if (role() === 'operator' && typeof window.loadOperatorNotifications === 'function') window.loadOperatorNotifications();
      else if (typeof window.loadNotifications === 'function') window.loadNotifications();
    } catch (e) { /* ignore */ }
  }

  function test() {
    return api('POST', '/api/push/test', {}).then(function () {
      toast('Test sent', 'It should appear on this device within a few seconds.');
    }).catch(function (e) { toast('Test failed', e && e.message); });
  }

  /* ───────────────────────────── entry ───────────────────────────── */
  /** Call whenever a dashboard opens (any role). Safe to call repeatedly. */
  function ensure() {
    if (!user()) return;
    var now = Date.now();
    if (now - state.lastEnsure < 4000) return;
    state.lastEnsure = now;
    bindNative();
    bindServiceWorker();
    if (isApp()) {
      if (typeof window.registerNativePush === 'function') window.registerNativePush();
      setTimeout(refreshStatus, 2500);
      return;
    }
    if (!webSupported()) {
      refreshStatus();
      if (isIos() && !isStandalone() && isStaff()) setTimeout(function () { showIosHint(false); }, 4000);
      return;
    }
    if (Notification.permission === 'granted') {
      // Heals a subscription the browser dropped, and re-attaches it to this account.
      subscribeWeb().catch(function () { /* status row shows it */ }).then(refreshStatus);
    } else {
      refreshStatus();
      if (Notification.permission === 'default') setTimeout(showCard, 2500);
    }
  }

  window.BBNotify = { ensure: ensure, route: route, test: test, status: refreshStatus, turnOn: turnOn, operatorScreen: operatorScreen };

  bindNative();
  bindServiceWorker();
  readUrlOnce();
})();
