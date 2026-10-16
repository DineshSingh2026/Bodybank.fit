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
  var state = { token: null, decidedFor: null, flagReady: null, enabled: false, cssLoaded: false, jsPromise: null, adminPromise: null, home: null, homeAt: 0, homeBusy: false };

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
    if (!state.enabled) {
      // A deep link (/?open=challenge) can arrive before the flag check has answered.
      // Wait for that answer instead of bouncing the member to Home.
      var u0 = user();
      if (u0 && u0.token && state.decidedFor !== u0.token) {
        if (state.token !== u0.token) check();
        var sec0 = document.getElementById('usec-challenge');
        if (sec0 && !sec0.innerHTML) sec0.innerHTML = '<div style="padding:28px;color:#a49f95;text-align:center">Loading challenges…</div>';
        (state.flagReady || Promise.resolve()).then(function () {
          if (state.enabled) window.bbChallengeOpen(opts);
          else if (typeof window.switchUserTab === 'function') window.switchUserTab('home');
        });
        return;
      }
      if (typeof window.switchUserTab === 'function') window.switchUserTab('home');
      return;
    }
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

  /* ---- marketing home (web visitors only; never inside the apps) ----
     The home-page band uses the same design as /challenge: "Seven days. Start strong."
     with the 7 day tiles and two phone illustrations (desktop), swipe cards (mobile). */
  var MKT_CSS = [
    // Announcement pill: same family, size and glass finish as the "Now live on the App Store" pill.
    '.bbch-mkt-pill{display:inline-flex;align-items:center;gap:10px;margin:24px 8px 0;padding:6px 16px 6px 6px;min-height:40px;border:1px solid rgba(200,164,78,.34);border-radius:999px;background:rgba(8,8,8,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:#d8d2c4;font-family:"Outfit",sans-serif;font-size:13px;font-weight:500;letter-spacing:.03em;text-decoration:none;vertical-align:middle;transition:border-color .3s,background .3s,color .3s}',
    '.bbch-mkt-pills{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:12px;margin:24px auto 0}.bbch-mkt-pills>a{margin:0!important}',
    '.bbch-mkt-pill:hover{border-color:rgba(200,164,78,.7);background:rgba(200,164,78,.08);color:#f4f0e8}',
    '.bbch-mkt-pill b{color:#f4f0e8;font-weight:600}',
    '.bbch-mkt-tag{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:999px;background:linear-gradient(135deg,#F1D488,#C9A040 55%,#9E7A22);color:#17120a;font-size:10.5px;font-weight:700;letter-spacing:.14em}',
    '.bbch-mkt-pill .arw{color:#c8a44e;transition:transform .3s}.bbch-mkt-pill:hover .arw{transform:translateX(3px)}',
    // Band
    '.bbch-mkt{--g:linear-gradient(135deg,#F1D488 0%,#C9A040 55%,#9E7A22 100%);--gl:rgba(201,160,64,.42);--line:rgba(255,255,255,.08);position:relative;overflow:hidden;padding:96px 24px;background:radial-gradient(60% 70% at 85% 30%,rgba(201,160,64,.13),transparent 65%),#0b0b0c;border-top:1px solid rgba(200,164,78,.18);border-bottom:1px solid rgba(200,164,78,.18);color:#f5f1e8;font-family:"Plus Jakarta Sans","Outfit",system-ui,sans-serif;line-height:1.5}',
    '.bbch-mkt *{box-sizing:border-box}',
    '.bbch-mkt-wrap{max-width:1240px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,520px);gap:32px;align-items:center}',
    '.bbch-mkt-copy{min-width:0;position:relative}',
    '.bbch-mkt .it{font-family:"Playfair Display",Georgia,serif;font-style:italic;font-weight:500;background:var(--g);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;padding-right:.06em}',
    '.bbch-mkt-eye{display:flex;align-items:center;gap:14px;margin:0 0 26px;font-size:12px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:#d9b45a}',
    '.bbch-mkt-eye::before{content:"";width:28px;height:1px;background:#d9b45a;opacity:.8}',
    '.bbch-mkt h2.bbch-mkt-h{margin:0 0 22px;font-family:"Plus Jakarta Sans","Outfit",sans-serif;font-size:clamp(46px,6.2vw,88px);line-height:.98;font-weight:800;letter-spacing:-.035em;text-transform:none;color:#f5f1e8}',
    '.bbch-mkt-h .l1,.bbch-mkt-h .it{display:block}.bbch-mkt-h .it{font-size:1.02em;letter-spacing:-.01em;margin-top:.06em}',
    '.bbch-mkt-lede{margin:0 0 28px;font-size:20px;color:#cfc8ba;max-width:560px}',
    '.bbch-mkt-feats{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 34px;padding:0}',
    '.bbch-mkt-feats li{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:7px 13px;border-radius:999px;border:1px solid var(--gl);background:rgba(201,160,64,.06);font-size:14px;font-weight:600;color:#efe9dc;white-space:nowrap}',
    '.bbch-mkt-sub,.bbch-mkt-swipe,.bbch-mkt-dots,.bbch-mkt-tiles,.bbch-mkt-day .num,.bbch-mkt-day .lico,.bbch-mkt-lede .m{display:none}',
    '.bbch-mkt-days{list-style:none;margin:0 0 40px;padding:0;display:grid;grid-template-columns:repeat(7,76px);gap:11px}',
    '.bbch-mkt-day{display:flex;flex-direction:column;align-items:center;text-align:center}',
    '.bbch-mkt-day .ico{width:76px;height:66px;border-radius:14px;border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0)),#141416;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1}',
    '.bbch-mkt-day .ico svg{width:20px;height:20px;color:#f5f1e8}',
    '.bbch-mkt-day .dn{margin-top:13px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#a49f95}',
    '.bbch-mkt-day b{font-size:13px;font-weight:600;color:#ece6da;margin-top:2px;white-space:nowrap}',
    '.bbch-mkt-ctas{display:flex;align-items:center;gap:28px;flex-wrap:wrap}',
    '.bbch-mkt a.bbch-mkt-cta{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:60px;padding:0 36px;border-radius:16px;background:var(--g);color:#17120a;font-size:18px;font-weight:700;text-decoration:none;box-shadow:0 16px 36px rgba(201,160,64,.26),inset 0 1px 0 rgba(255,255,255,.4);transition:transform .2s,box-shadow .2s}',
    '.bbch-mkt a.bbch-mkt-cta:hover{transform:translateY(-1px);box-shadow:0 20px 44px rgba(201,160,64,.34)}',
    '.bbch-mkt a.bbch-mkt-cta svg{width:17px;height:17px}',
    '.bbch-mkt a.bbch-mkt-link{color:#e8c97a;font-size:16.5px;font-weight:600;text-decoration:none;border-bottom:1px solid rgba(232,201,122,.45);padding-bottom:3px}',
    '.bbch-mkt-proof{display:flex;align-items:center;gap:10px;margin:22px 0 0;font-size:15px;color:#a49f95}.bbch-mkt-proof svg{width:20px;height:20px;color:#d9b45a;flex:0 0 auto}.bbch-mkt-proof b{color:#f5f1e8;font-weight:800}',
    '.bbch-mkt-note{margin:22px 0 0;font-size:14px;color:#7d786f}.bbch-mkt-note b{color:#d9b45a;font-weight:700}',
    '.bbch-mkt a:focus-visible,.bbch-mkt-pill:focus-visible{outline:2px solid #e3c274;outline-offset:4px}',
    // Phones (illustration)
    '.bbch-mkt-phones{position:relative;height:640px}',
    '.bbch-mkt .phone{position:absolute;width:300px;height:620px;border-radius:52px;padding:11px;background:linear-gradient(145deg,#4a4434,#26231c 40%,#1a1813);box-shadow:0 40px 90px rgba(0,0,0,.6),inset 0 0 0 1.5px rgba(255,255,255,.08)}',
    '.bbch-mkt .scr{position:relative;height:100%;border-radius:42px;overflow:hidden;background:radial-gradient(120% 50% at 70% 20%,rgba(201,160,64,.12),transparent 60%),#0d0d0f;padding:16px 18px 0;font-size:11px;color:#f5f1e8;text-align:left}',
    '.bbch-mkt .island{position:absolute;top:12px;left:50%;transform:translateX(-50%);width:96px;height:28px;border-radius:20px;background:#000}',
    '.bbch-mkt .sb{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;padding:2px 10px 0}.bbch-mkt .sb i{font-style:normal;font-size:10px;letter-spacing:1px}',
    '.bbch-mkt .p1{left:0;top:30px;transform:rotate(-6deg);z-index:2}.bbch-mkt .p2{right:-10px;top:0;transform:rotate(7deg)}',
    '.bbch-mkt .ph-top{display:flex;justify-content:space-between;align-items:center;margin:22px 0 18px}.bbch-mkt .ph-top img{height:22px;width:auto}',
    '.bbch-mkt .ph-burger{width:16px}.bbch-mkt .ph-burger i{display:block;height:1.4px;background:#d9b45a;margin:3px 0}',
    '.bbch-mkt .ph-eye{font-size:7.5px;letter-spacing:.22em;text-transform:uppercase;color:#d9b45a;margin:0 0 8px}',
    '.bbch-mkt .ph-h{font-size:24px;line-height:1.02;font-weight:800;letter-spacing:-.03em;margin:0 0 6px}.bbch-mkt .ph-h .it{display:block;font-size:1.04em}',
    '.bbch-mkt .ph-p{font-size:10px;color:#bfb8aa;margin:0 0 10px}',
    '.bbch-mkt .ph-pill{display:inline-flex;gap:4px;align-items:center;font-size:8.5px;font-weight:600;border:1px solid var(--gl);border-radius:999px;padding:3px 8px;margin:0 0 5px}',
    '.bbch-mkt .ph-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 12px}',
    '.bbch-mkt .ph-grid div{border:1px solid var(--line);border-radius:9px;padding:7px 4px;text-align:center;font-size:8.5px;font-weight:600;background:#151517}',
    '.bbch-mkt .ph-grid div small{display:block;font-size:6px;letter-spacing:.14em;color:#a49f95;margin-bottom:2px}',
    '.bbch-mkt .ph-grid .fin{background:var(--g);color:#17120a}.bbch-mkt .ph-grid .fin small{color:#5a4618}',
    '.bbch-mkt .ph-cta{display:block;text-align:center;border-radius:10px;background:var(--g);color:#17120a;font-weight:700;font-size:11px;padding:10px;margin:0 0 6px}',
    '.bbch-mkt .ph-fine{text-align:center;font-size:7.5px;color:#7d786f;margin:0}.bbch-mkt .ph-fine b{color:#d9b45a}',
    '.bbch-mkt .ph-url{position:absolute;left:0;right:0;bottom:0;background:#18181b;border-top:1px solid var(--line);text-align:center;font-size:8px;color:#d7d1c4;padding:9px 0 16px}',
    '.bbch-mkt .ph-coin{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;border:1px solid var(--gl);border-radius:999px;padding:3px 8px}',
    '.bbch-mkt .ph-coin::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--g)}',
    '.bbch-mkt .ph-ring{position:relative;width:118px;height:118px;margin:4px auto 10px}.bbch-mkt .ph-ring svg{width:100%;height:100%;transform:rotate(-90deg)}',
    '.bbch-mkt .ph-ring b{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;font-size:30px;font-weight:800;line-height:1}',
    '.bbch-mkt .ph-ring b i{font-style:normal;font-size:9px;color:#a49f95;letter-spacing:.18em;margin-top:5px}',
    '.bbch-mkt .ph-chips{display:flex;justify-content:center;gap:6px;margin:0 0 10px}',
    '.bbch-mkt .ph-chips span{font-size:8.5px;font-weight:600;border:1px solid var(--gl);border-radius:999px;padding:3px 8px;color:#e8c97a}',
    '.bbch-mkt .ph-task{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid rgba(255,255,255,.05);background:#161618;border-radius:11px;padding:8px 10px;margin:0 0 6px}',
    '.bbch-mkt .ph-task b{display:block;font-size:10px}.bbch-mkt .ph-task small{font-size:7.5px;color:#a49f95}',
    '.bbch-mkt .ph-task .go{font-size:8px;font-weight:700;border-radius:7px;padding:4px 8px;border:1px solid var(--gl);color:#e8c97a}',
    '.bbch-mkt .ph-task .go.g{background:var(--g);color:#17120a;border-color:transparent}.bbch-mkt .ph-task.ph-hot{border-color:var(--gl)}',
    '.bbch-mkt .ph-ex{display:block;width:max-content;margin:6px auto 0;font-size:6.5px;font-weight:700;letter-spacing:.14em;color:#d9b45a;border:1px dashed var(--gl);border-radius:4px;padding:2px 6px}',
    '.bbch-mkt .ph-tabs{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-around;background:#121214;border-top:1px solid var(--line);padding:9px 6px 18px;font-size:7.5px;color:#a49f95;text-align:center}',
    '.bbch-mkt .ph-tabs span{display:flex;flex-direction:column;align-items:center;gap:2px}.bbch-mkt .ph-tabs .on{color:#d9b45a}',
    '@media (prefers-reduced-motion:no-preference){.bbch-mkt .phone{animation:bbchFloat 7s ease-in-out infinite}.bbch-mkt .p2{animation-delay:-3.5s}@keyframes bbchFloat{0%,100%{translate:0 0}50%{translate:0 -8px}}}',
    // Tablet
    '@media (max-width:1100px){.bbch-mkt-wrap{grid-template-columns:minmax(0,1fr);gap:20px}.bbch-mkt-phones{width:600px;max-width:100%;margin:0 auto}}',
    // Mobile: the minimal layout. Label, headline, one line, a row of numbered day
    // cards with thin gold line icons, a flat gold button and a muted note.
    '@media (max-width:760px){' +
      '.bbch-mkt{padding:38px 24px 44px;background:#0b0b0c}' +
      '.bbch-mkt-pills{flex-direction:column;gap:10px;margin-top:18px}' +
      '.bbch-mkt-eye{font-size:11.5px;letter-spacing:.3em;margin-bottom:20px;gap:0}.bbch-mkt-eye::before{display:none}' +
      '.bbch-mkt-eye .x{display:none}' +
      '.bbch-mkt h2.bbch-mkt-h{font-size:46px;margin-bottom:16px}' +
      '.bbch-mkt-lede{font-size:17px;margin-bottom:34px;max-width:none;color:#bdb6a8}' +
      '.bbch-mkt-lede .d{display:none}.bbch-mkt-lede .m{display:inline}' +
      '.bbch-mkt-feats,.bbch-mkt-sub,.bbch-mkt-swipe,.bbch-mkt-dots,.bbch-mkt-tiles,.bbch-mkt-phones{display:none}' +
      '.bbch-mkt-dw{margin:0 -24px}' +
      '.bbch-mkt-days{display:flex;gap:9px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding:0 24px;padding:0 24px 2px;margin:0 0 32px;scrollbar-width:none;-webkit-overflow-scrolling:touch}.bbch-mkt-days::-webkit-scrollbar{display:none}' +
      '.bbch-mkt-day{flex:0 0 81px;height:104px;scroll-snap-align:start;align-items:flex-start;text-align:left;border:1px solid rgba(255,255,255,.13);border-radius:16px;padding:12px 11px 11px;background:#111113}' +
      '.bbch-mkt-day .ico,.bbch-mkt-day .dn{display:none}' +
      '.bbch-mkt-day .num{display:block;font-size:12.5px;font-weight:500;letter-spacing:.1em;color:#8a857c;line-height:1}' +
      '.bbch-mkt-day .lico{display:block;margin:12px 0 auto;color:#d4af37;line-height:0}.bbch-mkt-day .lico svg{width:21px;height:21px}' +
      '.bbch-mkt-day b{font-size:15.5px;font-weight:500;color:#f5f1e8;margin-top:0}' +
      '.bbch-mkt-ctas{display:block}' +
      '.bbch-mkt a.bbch-mkt-cta{width:100%;min-height:55px;font-size:18.5px;font-weight:600;border-radius:16px;background:#d4af37;box-shadow:none;letter-spacing:0}' +
      '.bbch-mkt a.bbch-mkt-cta:hover{transform:none;box-shadow:none;background:#dcb948}' +
      '.bbch-mkt a.bbch-mkt-link{display:none}' +
      '.bbch-mkt-proof{justify-content:center;margin-top:18px;font-size:14px;color:#8a857c}' +
      '.bbch-mkt-note{text-align:center;margin-top:18px;font-size:14.5px;color:#7d786f}.bbch-mkt-note b{color:inherit;font-weight:400}' +
    '}'
  ].join('');

  var MKT_DAYS = [['Check in', ''], ['Meals', '🍽️'], ['Train', '🏋️'], ['Protein', '🥚'], ['Steps', '👣'], ['Mind', '🧠'], ['Weigh in', '⚖️']];
  // Thin gold line icons for the minimal mobile cards (same order as MKT_DAYS).
  var MKT_LINE = [
    '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.4l2.6 2.6 4.9-5.4"/>',
    '<path d="M6.5 3v6a2 2 0 0 0 4 0V3M8.5 9v12"/><path d="M17.5 21V3c-2.2 1.2-3.3 3.7-3.3 7v3h3.3"/>',
    '<path d="M2.5 12h2M19.5 12h2"/><rect x="4.5" y="8" width="3.2" height="8" rx="1.1"/><rect x="16.3" y="8" width="3.2" height="8" rx="1.1"/><path d="M7.7 12h8.6"/>',
    '<path d="M12 3.5c3 3.8 5.5 6.9 5.5 10a5.5 5.5 0 0 1-11 0c0-3.1 2.5-6.2 5.5-10z"/>',
    '<path d="M7.5 3.5c-1.7 0-2.6 2-2.6 4.6s1 4.4 2.6 4.4 2.5-1.7 2.5-4.4-.8-4.6-2.5-4.6zM5.6 15.6c0 1.9.8 3 2 3s1.8-1.1 1.8-3"/><path d="M16.5 6.5c1.7 0 2.6 2 2.6 4.6s-1 4.4-2.6 4.4-2.5-1.7-2.5-4.4.8-4.6 2.5-4.6zM14.6 18.6c0 1.3.7 2 1.8 2s1.8-.7 1.8-2"/>',
    '<path d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1z"/>',
    '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.8 9.6a4.4 4.4 0 0 1 6.4 0"/><path d="M12 9.4l1-1.5"/>'
  ];
  function mktLine(i) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MKT_LINE[i] + '</svg>'; }
  var MKT_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var MKT_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var MKT_LOGO = '/img/bodybank-logo-gold-360.png';
  var MKT_MEDAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="5.5"/><path d="M9 13.8 7.5 21l4.5-2.6L16.5 21 15 13.8"/></svg>';

  function mktPhones() {
    return '<div class="bbch-mkt-phones" aria-hidden="true">' +
      '<div class="phone p1"><div class="scr"><div class="island"></div><div class="sb"><span>9:41</span><i>▂▄▆ ◔ ▭</i></div>' +
        '<div class="ph-top"><img src="' + MKT_LOGO + '" alt="" width="360" height="138"><span class="ph-burger"><i></i><i></i><i></i></span></div>' +
        '<p class="ph-eye">— The 7 day challenge</p><p class="ph-h">Seven days.<span class="it">Start strong.</span></p>' +
        '<p class="ph-p">Three small wins a day, coached and tracked for you.</p>' +
        '<span class="ph-pill">⏱️ 2 minute check ins</span><br><span class="ph-pill">🏋️ Guided 20 min workouts</span><br><span class="ph-pill">🏅 Certificate and badge</span>' +
        '<div class="ph-grid"><div><small>DAY 1</small>Check in</div><div><small>DAY 2</small>Meals</div><div><small>DAY 3</small>Train</div><div><small>DAY 4</small>Protein</div>' +
        '<div><small>DAY 5</small>Steps</div><div><small>DAY 6</small>Mind</div><div><small>DAY 7</small>Weigh in</div><div class="fin"><small>FINISH</small>Certificate</div></div>' +
        '<span class="ph-cta">Take the challenge →</span><div class="ph-url">🔒 bodybank.fit/challenge</div></div></div>' +
      '<div class="phone p2"><div class="scr"><div class="island"></div><div class="sb"><span>9:41</span><i>▂▄▆ ◔ ▭</i></div>' +
        '<div class="ph-top"><img src="' + MKT_LOGO + '" alt="" width="360" height="138" style="height:20px"><span class="ph-coin">140</span></div>' +
        '<p class="ph-eye">— Starter challenge</p><p class="ph-h" style="font-size:19px">Day 4, <span class="it" style="display:inline">keep going</span></p>' +
        '<div class="ph-ring"><svg viewBox="0 0 120 120"><defs><linearGradient id="bbchMktG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F1D488"/><stop offset=".55" stop-color="#C9A040"/><stop offset="1" stop-color="#9E7A22"/></linearGradient></defs>' +
        '<circle cx="60" cy="60" r="50" fill="none" stroke="#242428" stroke-width="10"/><circle cx="60" cy="60" r="50" fill="none" stroke="url(#bbchMktG)" stroke-width="10" stroke-linecap="round" stroke-dasharray="314" stroke-dashoffset="135"/></svg><b>4<i>DAYS</i></b></div>' +
        '<div class="ph-chips"><span>🔥 4 day streak</span><span>1 of 3 done</span></div>' +
        '<div class="ph-task"><span><b>Daily check in</b><small>Done 8:12 am</small></span></div>' +
        '<div class="ph-task"><span><b>Protein target</b><small>62 of 120 g</small></span><span class="go">Log meal</span></div>' +
        '<div class="ph-task ph-hot"><span><b>20 min Coach Mode</b><small>Lower body</small></span><span class="go g">Start</span></div>' +
        '<span class="ph-ex">EXAMPLE</span><div class="ph-tabs"><span class="on">🏆<br>Challenge</span><span>🏋️<br>Train</span><span>🍽️<br>Meals</span><span>👤<br>Me</span></div></div></div>' +
      '</div>';
  }

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
      if (!document.querySelector('link[data-bbch-mkt-font]')) {
        var fl = document.createElement('link');
        fl.rel = 'stylesheet';
        fl.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Playfair+Display:ital,wght@1,500&display=swap';
        fl.setAttribute('data-bbch-mkt-font', '1');
        document.head.appendChild(fl);
      }
      var len = Number(free.length_days) || 7;
      var finished = d.finished && d.finished.n > 0 ? d.finished : null; // real count, hidden below the threshold

      // Hero announcement, set beside the App Store pill (both share one centred row).
      var store = hero.querySelector('.hero-store');
      var btns = hero.querySelector('.hero-btns');
      var pill = document.createElement('a');
      pill.className = 'bbch-mkt-pill';
      pill.href = '/challenge?utm_source=home&utm_medium=hero';
      pill.innerHTML = '<span class="bbch-mkt-tag">NEW</span><span>The <b>' + len + '-Day Starter Challenge</b> · join free</span><span class="arw" aria-hidden="true">&rsaquo;</span>';
      var row = document.createElement('div');
      row.className = 'bbch-mkt-pills';
      if (store && store.parentNode) { store.parentNode.insertBefore(row, store); row.appendChild(pill); row.appendChild(store); }
      else if (btns) { btns.parentNode.insertBefore(row, btns.nextSibling); row.appendChild(pill); }

      // The band under the hero: same design as /challenge.
      var href = '/challenge?utm_source=home&amp;utm_medium=section';
      var sec = document.createElement('section');
      sec.id = 'bbChMkt';
      sec.className = 'bbch-mkt';
      sec.setAttribute('aria-labelledby', 'bbChMktH');
      sec.innerHTML = '<div class="bbch-mkt-wrap"><div class="bbch-mkt-copy">' +
        '<p class="bbch-mkt-eye"><span><span class="x">The BodyBank </span>7 day challenge</span></p>' +
        '<h2 class="bbch-mkt-h" id="bbChMktH"><span class="l1">Seven days.</span><span class="it">Start strong.</span></h2>' +
        '<p class="bbch-mkt-lede"><span class="d">Three small wins a day, coached and tracked for you.</span><span class="m">One small win a day, coached for you.</span></p>' +
        '<ul class="bbch-mkt-feats" aria-label="What is included"><li><span aria-hidden="true">⏱️</span>2 minute check ins</li><li><span aria-hidden="true">🏋️</span>Guided 20 min workouts</li><li><span aria-hidden="true">🏅</span>Certificate and badge</li></ul>' +
        '<div class="bbch-mkt-dw"><p class="bbch-mkt-sub">Your 7 days</p><span class="bbch-mkt-swipe" aria-hidden="true">Swipe →</span>' +
        '<ol class="bbch-mkt-days" aria-label="Your 7 days">' + MKT_DAYS.map(function (x, i) {
          return '<li class="bbch-mkt-day' + (i === 0 ? ' on' : '') + '"><span class="ico" aria-hidden="true">' + (x[1] || MKT_CHECK) + '</span><span class="num">0' + (i + 1) + '</span><span class="lico">' + mktLine(i) + '</span><span class="dn">Day ' + (i + 1) + '</span><b>' + x[0] + '</b></li>';
        }).join('') + '</ol>' +
        '<div class="bbch-mkt-dots" aria-hidden="true">' + MKT_DAYS.map(function (x, i) { return '<i' + (i === 0 ? ' class="on"' : '') + '></i>'; }).join('') + '</div></div>' +
        '<div class="bbch-mkt-tiles" aria-hidden="true"><div><i>⏱️</i>2 minute check ins</div><div><i>🏋️</i>Guided 20 min workouts</div><div><i>🏅</i>Certificate and badge</div></div>' +
        '<div class="bbch-mkt-ctas"><a class="bbch-mkt-cta" href="' + href + '">Take the challenge ' + MKT_ARROW + '</a>' +
        '<a class="bbch-mkt-link" href="/challenge?utm_source=home&amp;utm_medium=section_link#plan">See the 7 day plan</a></div>' +
        (finished ? '<p class="bbch-mkt-proof">' + MKT_MEDAL + '<span><b>' + finished.label + '</b> ' + (finished.n === 1 ? 'member has' : 'members have') + ' finished a BodyBank challenge</span></p>' : '') +
        '</div>' +
        mktPhones() + '</div>';
      hero.parentNode.insertBefore(sec, hero.nextSibling);

      // Mobile swipe: the card at the left edge turns gold and the dots follow.
      var days = sec.querySelector('.bbch-mkt-days');
      var dots = sec.querySelector('.bbch-mkt-dots').children;
      var raf = 0;
      days.addEventListener('scroll', function () {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          var items = days.children, left = days.getBoundingClientRect().left, best = 0, bestD = Infinity;
          for (var i = 0; i < items.length; i++) { var dd = Math.abs(items[i].getBoundingClientRect().left - left - 20); if (dd < bestD) { bestD = dd; best = i; } }
          for (var j = 0; j < items.length; j++) { items[j].classList.toggle('on', j === best); if (dots[j]) dots[j].classList.toggle('on', j === best); }
        });
      }, { passive: true });
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
    state.flagReady = fetch(apiBase() + '/api/challenges/flags', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) { if (state.token === tok) { state.decidedFor = tok; show(!!(j && j.enabled)); } })
      .catch(function () {
        // Offline at boot: keep it reachable if this member has a challenge cached here.
        if (state.token !== tok) return;
        state.decidedFor = tok;
        show(!!lastDayCache(String(u.id)));
      });
  }

  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { state.homeAt = 0; check(); } });
  window.addEventListener('online', function () { state.token = null; check(); });
  setInterval(check, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', marketingBanner); else marketingBanner();
})();
