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
  var V = '2';
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
  var MKT_CSS = [
    // Announcement pill: same family, size and glass finish as the "Now live on the App Store" pill.
    '.bbch-mkt-pill{display:inline-flex;align-items:center;gap:10px;margin:24px 8px 0;padding:6px 16px 6px 6px;min-height:40px;border:1px solid rgba(200,164,78,.34);border-radius:999px;background:rgba(8,8,8,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:#d8d2c4;font-family:"Outfit",sans-serif;font-size:13px;font-weight:500;letter-spacing:.03em;text-decoration:none;vertical-align:middle;transition:border-color .3s,background .3s,color .3s}',
    '.bbch-mkt-pill:hover{border-color:rgba(200,164,78,.7);background:rgba(200,164,78,.08);color:#f4f0e8}',
    '.bbch-mkt-pill b{color:#f4f0e8;font-weight:600}',
    '.bbch-mkt-tag{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:999px;background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);color:#17120a;font-size:10.5px;font-weight:700;letter-spacing:.14em}',
    '.bbch-mkt-pills{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:12px;margin:24px auto 0}.bbch-mkt-pills>a{margin:0!important}',
    '.bbch-mkt-pill .arw{color:#c8a44e;transition:transform .3s}.bbch-mkt-pill:hover .arw{transform:translateX(3px)}',
    // Feature band
    '.bbch-mkt{position:relative;padding:88px 24px;background:radial-gradient(60% 80% at 15% 0%,rgba(200,164,78,.10),transparent 70%),#0b0b0c;border-top:1px solid rgba(200,164,78,.18);border-bottom:1px solid rgba(200,164,78,.18);color:#f4f0e8;font-family:"Outfit",sans-serif}',
    '.bbch-mkt *{box-sizing:border-box}',
    '.bbch-mkt-wrap{max-width:1160px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:64px;align-items:center}',
    '.bbch-mkt-eye{display:flex;align-items:center;gap:14px;margin:0 0 22px;font-size:12px;font-weight:600;letter-spacing:.32em;text-transform:uppercase;color:#c8a44e}',
    '.bbch-mkt-eye::before{content:"";width:36px;height:1px;background:linear-gradient(90deg,transparent,#c8a44e)}',
    '.bbch-mkt h2.bbch-mkt-h{margin:0 0 20px;font-family:"Outfit",sans-serif;font-size:clamp(34px,4.4vw,54px);line-height:1.08;font-weight:600;letter-spacing:-.02em;text-transform:none;color:#f4f0e8}',
    '.bbch-mkt-h em{font-family:"Playfair Display",Georgia,serif;font-style:italic;font-weight:400;background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;padding-right:.04em}',
    '.bbch-mkt-lead{margin:0 0 34px;max-width:560px;font-size:17px;line-height:1.7;font-weight:300;color:rgba(244,240,232,.72)}',
    '.bbch-mkt-pts{list-style:none;margin:0 0 38px;padding:0;display:grid;gap:22px}',
    '.bbch-mkt-pts li{display:grid;grid-template-columns:44px 1fr;gap:16px;align-items:start}',
    '.bbch-mkt-ico{width:44px;height:44px;border-radius:50%;border:1px solid rgba(200,164,78,.4);display:flex;align-items:center;justify-content:center;color:#d9b45a;background:rgba(200,164,78,.06)}',
    '.bbch-mkt-ico svg{width:20px;height:20px}',
    '.bbch-mkt-pts b{display:block;font-size:16px;font-weight:600;color:#f4f0e8;margin:2px 0 4px;letter-spacing:.01em}',
    '.bbch-mkt-pts span{font-size:14.5px;line-height:1.6;color:rgba(244,240,232,.6);font-weight:300}',
    '.bbch-mkt-ctas{display:flex;align-items:center;gap:28px;flex-wrap:wrap}',
    '.bbch-mkt a.bbch-mkt-cta{display:inline-flex;align-items:center;gap:12px;min-height:56px;padding:0 30px;border-radius:999px;background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);color:#17120a;font-size:15px;font-weight:600;letter-spacing:.04em;text-decoration:none;box-shadow:0 14px 34px rgba(200,164,78,.22);transition:transform .25s,box-shadow .25s}',
    '.bbch-mkt a.bbch-mkt-cta:hover{transform:translateY(-1px);box-shadow:0 18px 40px rgba(200,164,78,.32)}',
    '.bbch-mkt a.bbch-mkt-link{color:#e3c274;font-size:14px;font-weight:500;letter-spacing:.04em;text-decoration:none;border-bottom:1px solid rgba(227,194,116,.35);padding-bottom:3px}',
    '.bbch-mkt a.bbch-mkt-link:hover{border-bottom-color:#e3c274}',
    '.bbch-mkt-fine{margin:18px 0 0;font-size:12.5px;letter-spacing:.06em;color:rgba(244,240,232,.45)}',
    '.bbch-mkt a:focus-visible,.bbch-mkt-pill:focus-visible{outline:2px solid #e3c274;outline-offset:4px}',
    // Plan card
    '.bbch-mkt-card{position:relative;padding:30px 28px 26px;border-radius:24px;border:1px solid rgba(200,164,78,.32);background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0)),#121214;box-shadow:0 30px 70px rgba(0,0,0,.45)}',
    '.bbch-mkt-card-top{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 20px}',
    '.bbch-mkt-card-top p{margin:0;font-size:11.5px;font-weight:600;letter-spacing:.26em;text-transform:uppercase;color:#c8a44e}',
    '.bbch-mkt-card-top span{font-family:"Playfair Display",Georgia,serif;font-style:italic;font-size:15px;color:rgba(244,240,232,.55)}',
    '.bbch-mkt-days{list-style:none;margin:0;padding:0;counter-reset:d}',
    '.bbch-mkt-days li{display:grid;grid-template-columns:34px 1fr;gap:14px;align-items:center;padding:11px 0;border-top:1px solid rgba(255,255,255,.06);font-size:14.5px;color:rgba(244,240,232,.86)}',
    '.bbch-mkt-days li:first-child{border-top:0}',
    '.bbch-mkt-days li::before{counter-increment:d;content:counter(d);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:600;color:#d9b45a;border:1px solid rgba(200,164,78,.38)}',
    '.bbch-mkt-days li:last-child::before{background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);color:#17120a;border-color:transparent}',
    '.bbch-mkt-card-foot{margin:18px 0 0;padding-top:16px;border-top:1px solid rgba(200,164,78,.2);font-size:13px;line-height:1.55;color:rgba(244,240,232,.6)}',
    '.bbch-mkt-card-foot b{color:#e3c274;font-weight:600}',
    '@media (max-width:900px){.bbch-mkt{padding:64px 20px}.bbch-mkt-wrap{grid-template-columns:1fr;gap:44px}.bbch-mkt-lead{font-size:16px}}',
    '@media (max-width:520px){.bbch-mkt{padding:56px 16px}.bbch-mkt-ctas{gap:18px}.bbch-mkt a.bbch-mkt-cta{width:100%;justify-content:center}.bbch-mkt-card{padding:24px 18px 20px}.bbch-mkt-pills{flex-direction:column;gap:10px;margin-top:18px}.bbch-mkt-eye{letter-spacing:.2em;font-size:11px;gap:10px}.bbch-mkt-eye::before{width:22px}}'
  ].join('');

  var MKT_ICONS = {
    plan: '<path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9.5 8.5l1.2 1.2 2.3-2.4M9.5 13.5l1.2 1.2 2.3-2.4"/>',
    track: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    award: '<circle cx="12" cy="9" r="5.5"/><path d="M9 13.8 7.5 21l4.5-2.6L16.5 21 15 13.8"/>'
  };
  function mktIcon(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MKT_ICONS[k] + '</svg>'; }

  function marketingBanner() {
    var hero = document.getElementById('hero');
    if (!hero || window.IS_BODYBANK_APP === true || document.getElementById('bbChMkt')) return;
    try { if (window.Capacitor && Capacitor.getPlatform && Capacitor.getPlatform() !== 'web') return; } catch (e) { /* web */ }
    // /api/challenges/public answers only while CHALLENGES_ENABLED=all.
    fetch(apiBase() + '/api/challenges/public').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var free = d && d.challenges && d.challenges.filter(function (c) { return c.access === 'free'; })[0];
      if (!free || document.getElementById('bbChMkt')) return;
      var st = document.createElement('style');
      st.textContent = MKT_CSS;
      document.head.appendChild(st);
      var len = Number(free.length_days) || 7;
      var minDays = Number(free.min_days) || len;
      var grace = len - minDays;

      // Hero announcement, set beside the App Store pill.
      var store = hero.querySelector('.hero-store');
      var btns = hero.querySelector('.hero-btns');
      var pill = document.createElement('a');
      pill.className = 'bbch-mkt-pill';
      pill.href = '/challenge?utm_source=home&utm_medium=hero';
      pill.innerHTML = '<span class="bbch-mkt-tag">NEW</span><span>The <b>' + len + '-Day Starter Challenge</b> · join free</span><span class="arw" aria-hidden="true">&rsaquo;</span>';
      // Both pills share one centred row so they always line up.
      var row = document.createElement('div');
      row.className = 'bbch-mkt-pills';
      if (store && store.parentNode) { store.parentNode.insertBefore(row, store); row.appendChild(pill); row.appendChild(store); }
      else if (btns) { btns.parentNode.insertBefore(row, btns.nextSibling); row.appendChild(pill); }

      // Feature band under the hero. The day plan comes from the published challenge.
      var days = (free.day_titles || []).slice(0, len);
      var sec = document.createElement('section');
      sec.id = 'bbChMkt';
      sec.className = 'bbch-mkt';
      sec.setAttribute('aria-labelledby', 'bbChMktH');
      sec.innerHTML = '<div class="bbch-mkt-wrap"><div>' +
        '<p class="bbch-mkt-eye">The BodyBank ' + len + '-Day Challenge</p>' +
        '<h2 class="bbch-mkt-h" id="bbChMktH">' + (len === 7 ? 'Seven' : len) + ' days to build <em>habits that last.</em></h2>' +
        '<p class="bbch-mkt-lead">A coach-designed programme that turns intention into routine. Three focused actions each day, a two-minute check-in, a protein target and a short guided workout, tracked for you in the BodyBank app.</p>' +
        '<ul class="bbch-mkt-pts">' +
        '<li><span class="bbch-mkt-ico">' + mktIcon('plan') + '</span><div><b>A clear daily plan</b><span>Achievable actions curated by the BodyBank coaching team, about thirty minutes a day.</span></div></li>' +
        '<li><span class="bbch-mkt-ico">' + mktIcon('track') + '</span><div><b>Progress tracked automatically</b><span>Your check-ins, meals and workouts are recognised as you log them. Nothing to tick by hand.</span></div></li>' +
        '<li><span class="bbch-mkt-ico">' + mktIcon('award') + '</span><div><b>Recognition when you finish</b><span>A certificate of completion, your Starter badge, reward coins and a complimentary lifestyle consultation.</span></div></li>' +
        '</ul>' +
        '<div class="bbch-mkt-ctas"><a class="bbch-mkt-cta" href="/challenge?utm_source=home&amp;utm_medium=section">Begin the free challenge <span aria-hidden="true">&rarr;</span></a>' +
        '<a class="bbch-mkt-link" href="/challenge?utm_source=home&amp;utm_medium=section_link">See how it works</a></div>' +
        '<p class="bbch-mkt-fine">Complimentary · No card required · iPhone, Android and web</p></div>' +
        (days.length ? '<aside class="bbch-mkt-card" aria-label="The ' + len + '-day plan"><div class="bbch-mkt-card-top"><p>Your ' + len + '-day plan</p><span>day by day</span></div>' +
          '<ol class="bbch-mkt-days">' + days.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>' +
          '<p class="bbch-mkt-card-foot">Complete <b>' + minDays + ' of ' + len + ' days</b> to earn your certificate.' + (grace > 0 ? (grace === 1 ? ' One grace day is built in.' : ' ' + grace + ' grace days are built in.') : '') + '</p></aside>' : '') +
        '</div>';
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
