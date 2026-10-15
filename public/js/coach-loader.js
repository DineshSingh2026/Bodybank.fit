/* ==========================================================================
   COACH MODE loader (tiny, always loaded). Everything heavy is lazy:
   - members: asks /api/coach/flags once per sign-in; when enabled it reveals
     the sidebar link, adds the Coach Mode card at the top of the Train tab
     (injected, so the My Workout markup is untouched) and loads
     js/coach-mode.js + css/coach-mode.css the first time Coach Mode opens
     (or straight away when a finished workout is waiting to sync);
   - admins: loads js/coach-admin.js the first time the "Coach Mode library"
     tab opens.
   The bottom navigation is never changed: Coach Mode lives inside Train.
   ========================================================================== */
(function () {
  'use strict';
  var V = '1';
  var state = { token: null, enabled: false, cssLoaded: false, jsPromise: null, adminPromise: null };

  function user() { return window.currentUser || null; }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }

  function loadCss(href) {
    if (document.querySelector('link[data-bbcm="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.setAttribute('data-bbcm', href);
    document.head.appendChild(l);
  }
  function loadJs(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function ensureStyles() {
    if (state.cssLoaded) return;
    state.cssLoaded = true;
    loadCss('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');
    loadCss('css/coach-mode.css?v=' + V);
  }
  function ensureCoach() {
    ensureStyles();
    if (window.bbCoach) return Promise.resolve(window.bbCoach);
    if (!state.jsPromise) {
      state.jsPromise = loadJs('js/coach-mode.js?v=' + V).then(function () { return window.bbCoach; })
        .catch(function (e) { state.jsPromise = null; throw e; });
    }
    return state.jsPromise;
  }

  function outboxHasWork(uid) {
    try {
      var o = JSON.parse(localStorage.getItem('bb_coach_outbox_v1') || '[]');
      return Array.isArray(o) && o.some(function (x) { return x && x.uid === uid && !x.failed; });
    } catch (e) { return false; }
  }
  function hasDraft(uid) {
    try { var d = JSON.parse(localStorage.getItem('bb_coach_draft_v1') || 'null'); return !!(d && d.uid === uid); } catch (e) { return false; }
  }

  /* ---- entry points ---- */
  function sidebarLink() { return document.getElementById('bbCoachSidebarLink'); }
  function entryCard() { return document.getElementById('bbCoachEntry'); }

  function renderEntry() {
    var sec = document.getElementById('usec-workout');
    if (!sec) return;
    var u = user();
    var draft = !!(u && hasDraft(String(u.id)));
    state.draftShown = draft;
    var card = entryCard();
    if (!card) {
      card = document.createElement('button');
      card.type = 'button';
      card.id = 'bbCoachEntry';
      card.className = 'bbcm-entry';
      card.addEventListener('click', function () { if (typeof window.switchUserTab === 'function') window.switchUserTab('coach'); });
      var inner = sec.querySelector('.wk-session-inner');
      sec.insertBefore(card, inner || sec.firstChild);
    }
    card.setAttribute('aria-label', draft ? 'Coach Mode: resume your workout in progress' : 'Open Coach Mode, a guided workout with form guides and set logging');
    card.innerHTML =
      '<span class="bbcm-entry-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12h2M20.5 12h2"/><rect x="3.5" y="8" width="3.2" height="8" rx="1.1"/><rect x="17.3" y="8" width="3.2" height="8" rx="1.1"/><path d="M6.7 12h10.6"/></svg></span>' +
      '<span class="bbcm-entry-main"><span class="bbcm-entry-eyebrow">' + (draft ? 'Workout in progress' : 'New · Coach Mode') + '</span>' +
      '<span class="bbcm-entry-title" style="display:block">' + (draft ? 'Resume your <em>workout</em>' : 'Guided <em>workout</em>') + '</span>' +
      '<span class="bbcm-entry-sub" style="display:block">' + (draft ? 'Pick up at the set you left.' : 'Pick a body area, follow the form guide, log every set.') + '</span></span>' +
      '<span class="bbcm-entry-go" aria-hidden="true">›</span>';
    card.hidden = false;
    card.style.display = '';
  }

  function show(on) {
    state.enabled = on;
    var link = sidebarLink();
    if (link) link.style.display = on ? '' : 'none';
    var card = entryCard();
    if (!on) {
      if (card) card.style.display = 'none';
      return;
    }
    ensureStyles();
    renderEntry();
  }

  // switchUserTab('coach') activates #usec-coach (its generic usec- logic) and then
  // calls this hook.
  // Optional opts ({ area, from }) come from Challenges: preselect the body area,
  // then switch to the Coach tab (which calls this hook again without opts).
  // Called with no argument the behaviour is exactly as before.
  window.bbCoachOpen = function (opts) {
    if (!state.enabled) { if (typeof window.switchUserTab === 'function') window.switchUserTab('workout'); return; }
    if (opts && typeof opts === 'object') {
      var area = ['upper', 'lower', 'core', 'full'].indexOf(opts.area) >= 0 ? opts.area : null;
      var u0 = user();
      if (area && !(u0 && hasDraft(String(u0.id)))) { try { localStorage.setItem('bb_coach_area', area); } catch (e) { /* private mode */ } }
      var sec0 = document.getElementById('usec-coach');
      if (!(sec0 && sec0.classList.contains('active')) && typeof window.switchUserTab === 'function') { window.switchUserTab('coach'); return; }
    }
    var sec = document.getElementById('usec-coach');
    if (sec && !window.bbCoach) sec.innerHTML = '<div class="bbcm" style="padding:24px;color:#a49f95;text-align:center">Loading Coach Mode…</div>';
    ensureCoach().then(function (c) { if (c) c.open(); }).catch(function () {
      if (sec) sec.innerHTML = '<div class="bbcm" style="padding:24px;text-align:center"><p style="color:#a49f95">Coach Mode could not load. Check your connection.</p>' +
        '<button type="button" class="bbcm-btn" onclick="window.bbCoachOpen()">Try again</button></div>';
    });
  };
  // Refresh the Train card when the member comes back to it (draft started / saved).
  window.bbCoachRefreshEntry = function () { if (state.enabled) renderEntry(); };

  /* ---- admin library ---- */
  window.bbCoachAdminOpen = function () {
    var host = document.getElementById('tab-coachlib');
    if (!host) return;
    ensureStyles();
    loadCss('css/coach-admin.css?v=' + V);
    if (!state.adminPromise) {
      state.adminPromise = loadJs('js/coach-admin.js?v=' + V).catch(function (e) { state.adminPromise = null; throw e; });
    }
    state.adminPromise.then(function () { if (window.bbCoachAdmin) window.bbCoachAdmin.mount(host); })
      .catch(function () { host.innerHTML = '<p style="padding:24px">Could not load the Coach Mode library. Refresh and try again.</p>'; });
  };

  /* ---- session watch ---- */
  function labels() {
    try {
      if (typeof USER_TAB_LABELS !== 'undefined' && !USER_TAB_LABELS.coach) USER_TAB_LABELS.coach = 'Coach Mode';
      if (typeof USER_TAB_SUBTITLES !== 'undefined' && !USER_TAB_SUBTITLES.coach) USER_TAB_SUBTITLES.coach = 'Guided workout: choose, learn the form, log every set.';
      if (typeof ADMIN_SECTION_LABELS !== 'undefined' && !ADMIN_SECTION_LABELS.coachlib) ADMIN_SECTION_LABELS.coachlib = 'Coach Mode library';
      if (typeof TAB_TO_SECTION !== 'undefined' && !TAB_TO_SECTION.coachlib) TAB_TO_SECTION.coachlib = 'training';
    } catch (e) { /* globals not ready */ }
  }

  function check() {
    labels();
    var u = user();
    var tok = u && u.token ? u.token : null;
    if (tok === state.token) {
      // The Train section can be re-rendered by other code; keep the card in place.
      if (state.enabled) {
        var d = !!(u && hasDraft(String(u.id)));
        if (!entryCard() || d !== state.draftShown) renderEntry();
      }
      return;
    }
    state.token = tok;
    if (!tok || !u || u.role !== 'user') { show(false); return; }
    fetch(apiBase() + '/api/coach/flags', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        if (state.token !== tok) return;
        show(!!(j && j.enabled));
        if (j && j.enabled && outboxHasWork(String(u.id))) ensureCoach().catch(function () { /* retried next open */ });
      })
      .catch(function () {
        // Offline at boot: if this member has used Coach Mode on this phone, keep it reachable.
        if (state.token !== tok) return;
        var uid = String(u.id);
        show(hasDraft(uid) || outboxHasWork(uid)); // the 'online' listener asks again
      });
  }

  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('online', function () { state.token = null; check(); });
  setInterval(check, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
})();
