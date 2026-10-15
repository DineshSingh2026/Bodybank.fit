/* ==========================================================================
   CHALLENGES loader (tiny, always loaded). Everything heavy is lazy:
   - members: asks /api/challenges/flags once per sign-in; when enabled it reveals
     the sidebar link and injects the Challenges card on the member home (top,
     right under the Today hero — one card serves the mobile and desktop panes),
     then loads js/challenges.js + css/challenges.css the first time the section
     opens;
   - admins: loads js/challenges-admin.js the first time the "Challenges" tab opens.
   Flag off → nothing shows and nothing heavy loads. The bottom navigation is
   never changed. Deep links: /?open=challenge  (and &id=starter-7).
   ========================================================================== */
(function () {
  'use strict';
  var V = '1';
  var state = { token: null, enabled: false, cssLoaded: false, jsPromise: null, adminPromise: null, home: null, homeAt: 0, homeBusy: false };

  function user() { return window.currentUser || null; }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function loadCss(href) {
    if (document.querySelector('link[data-bbch="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.setAttribute('data-bbch', href);
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
    loadCss('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@1,400;1,500&display=swap');
    loadCss('css/challenges.css?v=' + V);
  }
  function ensureModule() {
    ensureStyles();
    if (window.bbChallenges) return Promise.resolve(window.bbChallenges);
    if (!state.jsPromise) {
      state.jsPromise = loadJs('js/challenges.js?v=' + V).then(function () { return window.bbChallenges; })
        .catch(function (e) { state.jsPromise = null; throw e; });
    }
    return state.jsPromise;
  }

  /* ---- home card ---- */
  function lastDayCache(uid) {
    try { var c = JSON.parse(localStorage.getItem('bb_ch_day_v1') || 'null'); return c && c.uid === uid ? c.data : null; } catch (e) { return null; }
  }
  function homeCard() { return document.getElementById('bbChallengeHome'); }

  function renderHome() {
    var host = document.getElementById('memberHome');
    if (!host) return;
    var card = homeCard();
    if (!card) {
      card = document.createElement('section');
      card.id = 'bbChallengeHome';
      card.className = 'bbch-home';
      card.setAttribute('aria-label', 'Challenges');
      var hero = host.querySelector('.mh-hero');
      if (hero && hero.nextSibling) host.insertBefore(card, hero.nextSibling); else host.insertBefore(card, host.firstChild);
      card.addEventListener('click', function (e) {
        var b = e.target.closest('[data-bbch-home]');
        if (!b) return;
        if (typeof window.switchUserTab === 'function') window.switchUserTab('challenge');
      });
    }
    var h = state.home;
    var a = h && h.active;
    var html;
    if (a) {
      var en = a.enrollment;
      var t = a.today;
      var pct = Math.round((en.day / Math.max(1, en.length)) * 100);
      html = '<button type="button" class="bbch-home-btn" data-bbch-home="day" aria-label="Open your challenge: day ' + en.day + ' of ' + en.length + ', ' + t.done + ' of ' + t.total + ' tasks done">' +
        '<span class="bbch-home-ring" style="--p:' + pct + '"><b>' + en.day + '</b><i>/' + en.length + '</i></span>' +
        '<span class="bbch-home-main"><span class="bbch-home-eye">' + esc(a.challenge.title) + '</span>' +
        '<span class="bbch-home-title">' + (t.all_done ? 'Day ' + en.day + ' <em>done</em>' : 'Day ' + en.day + ', <em>keep going</em>') + '</span>' +
        '<span class="bbch-home-sub">' + (t.all_done ? 'All ' + t.total + ' tasks done. See you tomorrow.' : t.done + ' of ' + t.total + ' tasks done today') + '</span></span>' +
        '<span class="bbch-home-go" aria-hidden="true">›</span></button>';
    } else if (h && h.last && h.last.enrollment && h.last.enrollment.status === 'completed') {
      html = '<button type="button" class="bbch-home-btn" data-bbch-home="done"><span class="bbch-home-medal" aria-hidden="true">🏅</span>' +
        '<span class="bbch-home-main"><span class="bbch-home-eye">Challenge complete</span><span class="bbch-home-title">' + esc(h.last.challenge.title) + ' <em>done</em></span>' +
        '<span class="bbch-home-sub">Your certificate and badge are ready.</span></span><span class="bbch-home-go" aria-hidden="true">›</span></button>';
    } else {
      html = '<button type="button" class="bbch-home-btn" data-bbch-home="hub"><span class="bbch-home-medal" aria-hidden="true">🏆</span>' +
        '<span class="bbch-home-main"><span class="bbch-home-eye">New · Challenges</span><span class="bbch-home-title">Prove it to <em>yourself</em></span>' +
        '<span class="bbch-home-sub">Join the free 7 day challenge: 3 small tasks a day.</span></span><span class="bbch-home-go" aria-hidden="true">›</span></button>';
    }
    card.innerHTML = html;
    card.hidden = false;
    card.style.display = '';
  }

  function loadHome(force) {
    var u = user();
    if (!state.enabled || !u || !u.token || state.homeBusy) return;
    if (!force && state.home && Date.now() - state.homeAt < 60000) { renderHome(); return; }
    state.homeBusy = true;
    fetch(apiBase() + '/api/challenges/me/active', { headers: { Authorization: 'Bearer ' + u.token }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        state.homeBusy = false;
        if (!j) return;
        state.home = j; state.homeAt = Date.now();
        renderHome();
      })
      .catch(function () {
        state.homeBusy = false;
        var c = lastDayCache(String(u.id));
        if (c) { state.home = { active: c }; renderHome(); }
      });
  }

  /* ---- entry points ---- */
  function sidebarLink() { return document.getElementById('bbChallengeSidebarLink'); }

  function show(on) {
    state.enabled = on;
    var link = sidebarLink();
    if (link) link.style.display = on ? '' : 'none';
    var card = homeCard();
    if (!on) { if (card) card.style.display = 'none'; return; }
    ensureStyles();
    renderHome();
    loadHome(true);
  }

  // switchUserTab('challenge') activates #usec-challenge and then calls this hook.
  window.bbChallengeOpen = function (opts) {
    if (!state.enabled) { if (typeof window.switchUserTab === 'function') window.switchUserTab('home'); return; }
    var sec = document.getElementById('usec-challenge');
    if (sec && !window.bbChallenges) sec.innerHTML = '<div class="bbch" style="padding:28px;color:#a49f95;text-align:center">Loading challenges…</div>';
    ensureModule().then(function (m) { if (m) m.open(opts || {}); }).catch(function () {
      if (sec) sec.innerHTML = '<div class="bbch" style="padding:28px;text-align:center"><p style="color:#a49f95">Challenges could not load. Check your connection.</p>' +
        '<button type="button" class="bbch-btn" onclick="window.bbChallengeOpen()">Try again</button></div>';
    });
  };
  // The challenge module tells the loader when progress changed, so Home stays fresh.
  window.bbChallengeHomeUpdate = function (data) {
    if (data) { state.home = data; state.homeAt = Date.now(); }
    if (state.enabled) renderHome();
  };

  /* ---- admin ---- */
  window.bbChallengesAdminOpen = function () {
    var host = document.getElementById('tab-challenges');
    if (!host) return;
    ensureStyles();
    loadCss('css/challenges-admin.css?v=' + V);
    if (!state.adminPromise) {
      state.adminPromise = loadJs('js/challenges-admin.js?v=' + V).catch(function (e) { state.adminPromise = null; throw e; });
    }
    state.adminPromise.then(function () { if (window.bbChallengesAdmin) window.bbChallengesAdmin.mount(host); })
      .catch(function () { host.innerHTML = '<p style="padding:24px">Could not load Challenges. Refresh and try again.</p>'; });
  };

  /* ---- marketing home (web visitors only; never inside the apps) ---- */
  function marketingBanner() {
    var hero = document.getElementById('hero');
    if (!hero || window.IS_BODYBANK_APP === true || document.getElementById('bbChMkt')) return;
    try { if (window.Capacitor && Capacitor.getPlatform && Capacitor.getPlatform() !== 'web') return; } catch (e) { /* web */ }
    // /api/challenges/public answers only while CHALLENGES_ENABLED=all.
    fetch(apiBase() + '/api/challenges/public').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var free = d && d.challenges && d.challenges.filter(function (c) { return c.access === 'free'; })[0];
      if (!free || document.getElementById('bbChMkt')) return;
      var st = document.createElement('style');
      st.textContent = '.bbch-mkt-pill{display:inline-flex;align-items:center;gap:8px;margin-top:16px;min-height:44px;padding:8px 16px;border-radius:999px;border:1px solid rgba(201,160,64,.5);background:rgba(201,160,64,.1);color:#e8c97a;font-weight:700;font-size:14px;text-decoration:none}' +
        '.bbch-mkt-pill:focus-visible,.bbch-mkt a:focus-visible{outline:2px solid #e8c97a;outline-offset:3px}' +
        '.bbch-mkt{max-width:960px;margin:32px auto;padding:0 16px}' +
        '.bbch-mkt-in{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:22px;border-radius:22px;border:1px solid rgba(201,160,64,.42);background:radial-gradient(120% 120% at 0 0,rgba(201,160,64,.16),transparent 60%),#121214;color:#f5f1e8}' +
        '.bbch-mkt-in p{margin:0}.bbch-mkt-eye{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#d9b45a}' +
        '.bbch-mkt-t{font-size:24px;font-weight:800;margin:6px 0 4px!important}.bbch-mkt-t em{font-family:"Playfair Display",Georgia,serif;font-weight:400;color:#e8c97a}' +
        '.bbch-mkt-s{color:#a49f95;font-size:14px}' +
        '.bbch-mkt a.bbch-mkt-cta{display:inline-flex;align-items:center;min-height:52px;padding:0 24px;border-radius:16px;background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);color:#17120a;font-weight:800;text-decoration:none}';
      document.head.appendChild(st);
      var btns = hero.querySelector('.hero-btns');
      if (btns) {
        var pill = document.createElement('a');
        pill.className = 'bbch-mkt-pill';
        pill.href = '/challenge?utm_source=home&utm_medium=hero';
        pill.innerHTML = '<span aria-hidden="true">🏆</span> New: join the free 7 day challenge <span aria-hidden="true">›</span>';
        btns.parentNode.insertBefore(pill, btns.nextSibling);
      }
      var sec = document.createElement('section');
      sec.id = 'bbChMkt';
      sec.className = 'bbch-mkt';
      sec.setAttribute('aria-label', 'Free 7 day challenge');
      sec.innerHTML = '<div class="bbch-mkt-in"><div><p class="bbch-mkt-eye">New · Challenges</p><p class="bbch-mkt-t">Prove it to <em>yourself</em> in 7 days</p>' +
        '<p class="bbch-mkt-s">3 small tasks a day with real coaches. Certificate, badge and a lifestyle manager call when you finish.</p></div>' +
        '<a class="bbch-mkt-cta" href="/challenge?utm_source=home&amp;utm_medium=section">Start free today</a></div>';
      hero.parentNode.insertBefore(sec, hero.nextSibling);
    }).catch(function () { /* banner is optional */ });
  }

  /* ---- session watch ---- */
  function labels() {
    try {
      if (typeof USER_TAB_LABELS !== 'undefined' && !USER_TAB_LABELS.challenge) USER_TAB_LABELS.challenge = 'Challenges';
      if (typeof USER_TAB_SUBTITLES !== 'undefined' && !USER_TAB_SUBTITLES.challenge) USER_TAB_SUBTITLES.challenge = 'Daily tasks, real coaching, real rewards.';
      if (typeof ADMIN_SECTION_LABELS !== 'undefined' && !ADMIN_SECTION_LABELS.challenges) ADMIN_SECTION_LABELS.challenges = 'Challenges';
      if (typeof TAB_TO_SECTION !== 'undefined' && !TAB_TO_SECTION.challenges) TAB_TO_SECTION.challenges = 'programs';
    } catch (e) { /* globals not ready */ }
  }

  function homeVisible() {
    var s = document.getElementById('usec-home');
    return !!(s && s.classList.contains('active'));
  }

  function check() {
    labels();
    var u = user();
    var tok = u && u.token ? u.token : null;
    if (tok === state.token) {
      // Home can be re-rendered by other code; keep the card in place and fresh.
      if (state.enabled && homeVisible()) {
        if (!homeCard()) renderHome();
        loadHome(false);
      }
      return;
    }
    state.token = tok;
    state.home = null;
    if (!tok || !u || u.role !== 'user') { show(false); return; }
    fetch(apiBase() + '/api/challenges/flags', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) { if (state.token === tok) show(!!(j && j.enabled)); })
      .catch(function () {
        // Offline at boot: keep it reachable if this member has a challenge cached here.
        if (state.token !== tok) return;
        show(!!lastDayCache(String(u.id)));
      });
  }

  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { state.homeAt = 0; check(); } });
  window.addEventListener('online', function () { state.token = null; check(); });
  setInterval(check, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', marketingBanner); else marketingBanner();
})();
