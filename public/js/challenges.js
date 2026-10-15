/* ==========================================================================
   BODYBANK CHALLENGES — member screens (window.bbChallenges)
   Hub → detail / join → day view → leaderboard + share card → certificate.
   API: /api/challenges/* (routes/challenges.js). Loaded lazily by
   js/challenges-loader.js the first time the section opens. Renders only inside
   #usec-challenge.

   Tasks are never ticked here: the server reads the member's own check-ins, meals
   and workouts. Each task's button takes the member to the screen that does it.

   Storage (per user):
     bb_ch_day_v1     last day view (offline fallback)
     bb_ch_outbox_v1  joins made offline (server dedupes on client_uuid)

   Store policy: no prices, no purchase links, ever (the apps bundle this file).
   ========================================================================== */
(function () {
  'use strict';
  if (window.bbChallenges && window.bbChallenges.__v) return;

  var DAY_KEY = 'bb_ch_day_v1';
  var OUTBOX_KEY = 'bb_ch_outbox_v1';
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var REDUCED = false;
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* old webview */ }

  var S = {
    open: false, step: 'hub', params: {}, depth: 0, base: false,
    list: null, listErr: null, active: undefined, last: null, dayErr: null, dayLoading: false,
    detail: {}, detailErr: {}, board: {}, boardErr: {}, results: {}, resultsErr: {},
    joining: false, joinErr: null, optOut: false, backHandle: null, observer: null, prevDone: null, flushing: false
  };

  /* ---------------------------------------------------------------- utils */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function user() { return window.currentUser || null; }
  function uid() { var u = user(); return u && u.id != null ? String(u.id) : ''; }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function newUuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* insecure origin */ }
    var b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function platform() { try { if (window.Capacitor && Capacitor.getPlatform) return Capacitor.getPlatform(); } catch (e) { /* web */ } return 'web'; }
  function isApp() { return window.IS_BODYBANK_APP === true || platform() !== 'web'; }
  function isIOS() { return platform() === 'ios'; }
  function appPlugin() { try { return window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; } catch (e) { return null; } }
  function sharePlugin() { try { return window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Share; } catch (e) { return null; } }
  function publicOrigin() {
    var b = apiBase();
    if (/^https?:\/\//.test(b)) return b.replace(/\/$/, '');
    if (isApp() || !/^https?:/.test(location.protocol)) return 'https://www.bodybank.fit';
    return location.origin;
  }
  function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); }
  function fmtDay(ymd, year) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return '';
    return Number(m[3]) + ' ' + MONS[Number(m[2]) - 1] + (year ? ' ' + m[1] : '');
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONS[d.getMonth()];
  }
  function splitTitle(t) {
    // "Starter Challenge" → "Starter <em>Challenge</em>": the last word in gold italic.
    var s = String(t || '').trim();
    var i = s.lastIndexOf(' ');
    if (i <= 0) return '<em>' + esc(s) + '</em>';
    return esc(s.slice(0, i)) + ' <em>' + esc(s.slice(i + 1)) + '</em>';
  }

  async function api(method, path, body) {
    var headers = { Accept: 'application/json' };
    var u = user();
    if (u && u.token) headers.Authorization = 'Bearer ' + u.token;
    if (body) headers['Content-Type'] = 'application/json';
    var res;
    try {
      res = await fetch(apiBase() + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch (e) {
      return { ok: false, status: 0, network: true, data: null };
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, network: false, data: data };
  }
  function errText(r, fallback) {
    if (!r) return fallback;
    if (r.network) return 'You are offline. Check your connection and try again.';
    return (r.data && (r.data.message || (typeof r.data.error === 'string' && r.data.error.indexOf('_') === -1 && r.data.error))) || fallback;
  }

  function announce(msg) {
    var el = $('#bbchLive');
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  function ico(name) {
    var p = {
      back: '<path d="M15 18l-6-6 6-6"/>',
      users: '<path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="7.5" r="3.2"/><path d="M20 19v-1.4a3.3 3.3 0 0 0-2.4-3.2M15.5 4.6a3.2 3.2 0 0 1 0 6"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
      play: '<path d="M7 5v14l11-7z" fill="currentColor" stroke="none"/>',
      share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>',
      download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
      arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
      lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      x: '<path d="M18 6 6 18M6 6l12 12"/>'
    }[name] || '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  var CHIP_ICON = { coins: '<span class="bbch-coin" aria-hidden="true"></span>', badge: '🏅', certificate: '📜', discount: '🎟️', lm_call: '📞' };
  function chips(list, opts) {
    var o = opts || {};
    return '<ul class="bbch-chips" role="list">' + (list || []).map(function (c) {
      var label = c.key === 'lm_call' && o.freeCall ? 'Free lifestyle manager call' : c.label;
      return '<li class="bbch-chip"><span class="bbch-chip-ico" aria-hidden="true">' + (CHIP_ICON[c.key] || '•') + '</span>' + esc(label) + '</li>';
    }).join('') + '</ul>';
  }
  function joinedLine(n) {
    if (!n) return '';
    return '<span class="bbch-joined">' + ico('users') + fmtNum(n) + ' joined</span>';
  }

  /* ------------------------------------------------------------- routing */
  function root() { return document.getElementById('usec-challenge'); }
  function go(step, params, replace) {
    S.step = step;
    S.params = params || {};
    try {
      var st = { bbch: 1, step: step, params: S.params, depth: replace ? S.depth : S.depth + 1 };
      if (replace) history.replaceState(st, '');
      else { history.pushState(st, ''); S.depth += 1; }
    } catch (e) { /* sandboxed */ }
    render(true);
    load();
  }
  function back() {
    if (closeSheet()) return;
    if (S.depth > 0) { try { history.back(); return; } catch (e) { /* fall through */ } }
    close();
  }
  function onPop(e) {
    if (!S.open) return;
    var st = e.state;
    if (st && st.bbch) {
      closeSheet();
      S.depth = st.depth || 0;
      S.step = st.step;
      S.params = st.params || {};
      render(true);
      load();
      return;
    }
    S.depth = 0;
    close(true);
  }

  /* ------------------------------------------------------------- loading */
  async function loadList(force) {
    if (S.list && !force) return;
    var r = await api('GET', '/api/challenges/');
    if (r.ok && r.data) { S.list = r.data.challenges || []; S.listErr = null; }
    else if (!S.list) S.listErr = errText(r, 'Could not load challenges.');
  }
  async function loadDay(day) {
    S.dayLoading = true;
    var r = await api('GET', '/api/challenges/me/active' + (day ? '?day=' + encodeURIComponent(day) : ''));
    S.dayLoading = false;
    if (r.ok && r.data) {
      S.dayErr = null;
      S.active = r.data.active || null;
      S.last = r.data.last || null;
      if (S.active && !day) lsSet(DAY_KEY, { uid: uid(), at: Date.now(), data: S.active });
      if (!S.active && !day) lsSet(DAY_KEY, null);
      noticeProgress();
      if (typeof window.bbChallengeHomeUpdate === 'function' && !day) window.bbChallengeHomeUpdate(r.data);
      return true;
    }
    if (S.active === undefined) {
      var c = lsGet(DAY_KEY);
      if (c && c.uid === uid()) { S.active = c.data; S.offline = true; }
    }
    S.dayErr = errText(r, 'Could not load your challenge.');
    return false;
  }
  function noticeProgress() {
    var a = S.active;
    if (!a || !a.today) return;
    var key = a.enrollment.id + ':' + a.today.day;
    var done = a.today.tasks.filter(function (t) { return t.done; }).map(function (t) { return t.id; });
    if (S.prevDone && S.prevDone.key === key) {
      var fresh = a.today.tasks.filter(function (t) { return t.done && S.prevDone.ids.indexOf(t.id) === -1; });
      if (fresh.length) announce(fresh.map(function (t) { return t.title; }).join(', ') + ' done.' + (a.today.all_done ? ' Day ' + a.today.day + ' complete!' : ''));
    }
    S.prevDone = { key: key, ids: done };
  }
  async function loadDetail(id, force) {
    if (S.detail[id] && !force) return;
    var r = await api('GET', '/api/challenges/' + encodeURIComponent(id));
    if (r.ok) { S.detail[id] = r.data; S.detailErr[id] = null; }
    else S.detailErr[id] = r.status === 404 ? 'This challenge is not available.' : errText(r, 'Could not load the challenge.');
  }
  async function loadBoard(id) {
    var r = await api('GET', '/api/challenges/' + encodeURIComponent(id) + '/leaderboard?limit=50');
    if (r.ok) { S.board[id] = r.data; S.boardErr[id] = null; }
    else S.boardErr[id] = errText(r, 'Could not load the leaderboard.');
  }
  async function loadResults(eid) {
    var r = await api('GET', '/api/challenges/me/results/' + encodeURIComponent(eid));
    if (r.ok) { S.results[eid] = r.data; S.resultsErr[eid] = null; }
    else S.resultsErr[eid] = errText(r, 'Could not load your results.');
  }

  /** Load what the current step needs, then re-render. */
  async function load() {
    var step = S.step;
    var p = S.params;
    if (step === 'hub') {
      await Promise.all([loadList(true), S.active === undefined ? loadDay() : Promise.resolve()]);
    } else if (step === 'detail') {
      await loadDetail(p.id, true);
    } else if (step === 'day') {
      await loadDay(p.day);
    } else if (step === 'board') {
      var mine = myEnrollmentId();
      await Promise.all([loadBoard(p.id), mine && !S.results[mine] ? loadResults(mine) : Promise.resolve()]);
    } else if (step === 'done') {
      await loadResults(p.eid);
      if (!S.list) await loadList();
    }
    if (S.open && S.step === step) render();
  }
  function myEnrollmentId() {
    if (S.active && S.active.enrollment) return S.active.enrollment.id;
    if (S.last && S.last.enrollment) return S.last.enrollment.id;
    return null;
  }

  /* ------------------------------------------------------------- views */
  function shell(inner) {
    return '<div class="bbch" data-step="' + S.step + '">' + inner +
      '<div id="bbchLive" class="bbch-sr" aria-live="polite" aria-atomic="true"></div></div>';
  }
  function topBar(opts) {
    var o = opts || {};
    return '<div class="bbch-top">' +
      (o.back === false ? '<span></span>' : '<button type="button" class="bbch-icon-btn" data-a="back" aria-label="Back">' + ico('back') + '</button>') +
      (o.right || '') + '</div>';
  }
  function skeleton(n) {
    var h = '';
    for (var i = 0; i < (n || 3); i++) h += '<div class="bbch-skel" aria-hidden="true"><span></span><span></span><span></span></div>';
    return '<div aria-busy="true" aria-label="Loading">' + h + '</div>';
  }
  function errorBox(msg) {
    return '<div class="bbch-card bbch-error" role="alert"><p>' + esc(msg) + '</p><button type="button" class="bbch-btn" data-a="retry">Try again</button></div>';
  }

  function vHub() {
    var h = '<section class="bbch-screen" tabindex="-1" aria-labelledby="bbchH">' +
      '<p class="bbch-eyebrow">Challenges</p>' +
      '<h1 class="bbch-h1" id="bbchH">Prove it to <em>yourself</em></h1>' +
      '<p class="bbch-sub">Pick one. Daily tasks, real coaching, real rewards.</p>';
    var a = S.active;
    if (a && a.enrollment) {
      h += '<button type="button" class="bbch-card bbch-resume" data-a="day">' +
        '<span class="bbch-resume-day"><b>' + a.enrollment.day + '</b><i>/' + a.enrollment.length + '</i></span>' +
        '<span class="bbch-resume-main"><span class="bbch-eyebrow">Continue · day ' + a.enrollment.day + '</span><span class="bbch-resume-title">' + esc(a.challenge.title) + '</span>' +
        '<span class="bbch-muted">' + a.today.done + ' of ' + a.today.total + ' done today</span></span>' +
        '<span class="bbch-resume-go" aria-hidden="true">' + ico('arrow') + '</span></button>';
    }
    if (!S.list && !S.listErr) h += skeleton(3);
    else if (!S.list && S.listErr) h += errorBox(S.listErr);
    else if (!S.list.length) h += '<div class="bbch-card bbch-empty"><p class="bbch-empty-ico" aria-hidden="true">🏆</p><p><b>New challenges are on the way.</b></p><p class="bbch-muted">Your coach is preparing the next one. Check back soon.</p></div>';
    else h += '<div class="bbch-list">' + S.list.map(cardHtml).join('') + '</div>';
    if (S.last && S.last.enrollment && S.last.enrollment.status === 'completed' && !a) {
      h += '<button type="button" class="bbch-link-row" data-a="done" data-eid="' + esc(S.last.enrollment.id) + '">🏅 Your ' + esc(S.last.challenge.title) + ' certificate ' + ico('arrow') + '</button>';
    }
    return h + '</section>';
  }

  function cardHtml(c) {
    var my = c.my || {};
    var isActive = my.status === 'active';
    var free = c.access === 'free';
    var btn;
    if (isActive) btn = '<button type="button" class="bbch-btn is-gold" data-a="day">Continue</button>';
    else if (my.locked) btn = '<button type="button" class="bbch-btn is-ghost" data-a="detail" data-id="' + esc(c.id) + '" aria-label="' + esc(c.title) + ': locked, see details">' + ico('lock') + 'Details</button>';
    else btn = '<button type="button" class="bbch-btn ' + (free ? 'is-gold' : 'is-outline') + '" data-a="detail" data-id="' + esc(c.id) + '">' + (free ? 'Join free' : 'Join') + '</button>';
    return '<article class="bbch-card bbch-ccard' + (free ? ' is-featured' : '') + '" aria-label="' + esc(c.title) + '">' +
      '<span class="bbch-ccard-num" aria-hidden="true">' + c.length_days + '</span>' +
      '<p class="bbch-eyebrow">' + c.length_days + ' days</p>' +
      '<h2 class="bbch-ccard-title"><button type="button" class="bbch-plain" data-a="detail" data-id="' + esc(c.id) + '">' + esc(c.title) + '</button>' + (free ? ' <span class="bbch-free">Free</span>' : '') +
      (my.status === 'completed' ? ' <span class="bbch-done-pill">Done</span>' : '') + '</h2>' +
      '<p class="bbch-ccard-sub">' + esc(c.subtitle) + '</p>' +
      chips(c.rewards) +
      (my.locked && my.locked_message ? '<p class="bbch-lock-note">' + ico('lock') + esc(my.locked_message) + '</p>' : '') +
      '<div class="bbch-ccard-foot">' + (joinedLine(c.joined) || '<span></span>') + btn + '</div>' +
      '</article>';
  }

  function vDetail() {
    var id = S.params.id;
    var d = S.detail[id];
    var err = S.detailErr[id];
    var h = '<section class="bbch-screen" tabindex="-1" aria-labelledby="bbchH">';
    h += topBar({ right: d && d.joined ? '<span class="bbch-pill">' + ico('users') + fmtNum(d.joined) + ' joined</span>' : '' });
    if (!d && !err) return h + skeleton(4) + '</section>';
    if (!d) return h + errorBox(err) + '</section>';
    var my = d.my || {};
    h += '<p class="bbch-eyebrow">' + d.length_days + ' day challenge' + (d.access === 'free' ? ' · Free' : '') + '</p>' +
      '<h1 class="bbch-h1" id="bbchH">' + splitTitle(d.title) + '</h1>' +
      '<p class="bbch-sub">' + esc(d.description || d.subtitle) + '</p>' +
      '<ol class="bbch-card bbch-days" aria-label="Day by day">' + d.days.map(function (x) {
        return '<li><span class="bbch-days-n">Day ' + x.day + '</span><span class="bbch-days-t">' + esc(x.title) + '</span></li>';
      }).join('') + '</ol>' +
      '<div class="bbch-card"><p class="bbch-sec-title">Rewards when you finish</p>' + chips(d.rewards, { freeCall: true }) +
      '<p class="bbch-fine">Finish ' + d.min_days + ' of ' + d.length_days + ' days to complete.' + (d.length_days - d.min_days > 0 ? ' ' + (d.length_days - d.min_days === 1 ? 'One grace day' : (d.length_days - d.min_days) + ' grace days') + ' if life happens.' : '') + '</p></div>';
    var cta;
    if (my.status === 'active') cta = '<button type="button" class="bbch-cta" data-a="day">Go to today</button>';
    else if (my.locked) cta = '<div class="bbch-card bbch-locked" role="note">' + ico('lock') + '<p>' + esc(my.locked_message || 'This challenge is not included in your plan yet.') + '</p></div>';
    else if (my.other_active) cta = '<div class="bbch-card bbch-locked" role="note"><p>You are on the <b>' + esc(my.other_active.title) + '</b>. Finish or leave it first.</p><button type="button" class="bbch-btn" data-a="day">Open it</button></div>';
    else {
      h += '<label class="bbch-toggle"><input type="checkbox" data-a="optin" ' + (S.optOut ? '' : 'checked') + '><span class="bbch-toggle-ui" aria-hidden="true"></span><span>Show me on the leaderboard <small>First name and last initial only</small></span></label>' +
        (S.joinErr ? '<p class="bbch-err" role="alert">' + esc(S.joinErr) + '</p>' : '');
      cta = '<button type="button" class="bbch-cta" data-a="join" data-id="' + esc(d.id) + '"' + (S.joining ? ' disabled aria-busy="true"' : '') + '>' + (S.joining ? 'Joining…' : 'Join the challenge') + '</button>';
    }
    h += '<div class="bbch-cta-bar">' + cta + '</div>';
    return h + '</section>';
  }

  function ring(day, len) {
    var r = 46;
    var c = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(1, day / Math.max(1, len)));
    return '<div class="bbch-ring" role="img" aria-label="Day ' + day + ' of ' + len + '">' +
      '<svg viewBox="0 0 110 110" aria-hidden="true"><defs><linearGradient id="bbchRingG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F1D488"/><stop offset=".55" stop-color="#C9A040"/><stop offset="1" stop-color="#9E7A22"/></linearGradient></defs>' +
      '<circle cx="55" cy="55" r="' + r + '" class="bbch-ring-track"/>' +
      '<circle cx="55" cy="55" r="' + r + '" class="bbch-ring-fill" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - pct)).toFixed(1) + '"/></svg>' +
      '<span class="bbch-ring-c"><b>' + day + '</b><i>/' + len + '</i><small>days</small></span></div>';
  }

  function taskRow(t) {
    var act = '';
    if (!t.done && t.action) {
      var gold = t.action.type === 'coach' || t.action.type === 'workout';
      act = '<button type="button" class="bbch-task-act' + (gold ? ' is-gold' : '') + '" data-a="task" data-type="' + esc(t.action.type) + '" data-area="' + esc(t.action.area || '') + '" aria-label="' + esc(t.action.label + ': ' + t.title) + '">' +
        (gold ? ico('play') : '') + esc(t.action.label) + '</button>';
    }
    var sub = t.done ? t.done_label : (t.progress && t.progress.label ? t.progress.label : t.sub);
    if (!t.done && t.sub && t.progress && t.progress.label) sub = t.sub + ' · ' + t.progress.label;
    var bar = !t.done && t.progress && t.progress.pct > 0 ? '<span class="bbch-bar" aria-hidden="true"><span style="width:' + Math.round(t.progress.pct * 100) + '%"></span></span>' : '';
    return '<li class="bbch-task' + (t.done ? ' is-done' : '') + (t.kind === 'coach_workout' && !t.done ? ' is-hero' : '') + '">' +
      '<span class="bbch-check" aria-hidden="true">' + (t.done ? ico('check') : '') + '</span>' +
      '<span class="bbch-task-main"><span class="bbch-task-title">' + esc(t.title) + '<span class="bbch-sr">' + (t.done ? ', done' : ', not done yet') + '</span></span>' +
      (sub ? '<span class="bbch-task-sub">' + esc(sub) + '</span>' : '') + bar + '</span>' + act + '</li>';
  }

  function vDay() {
    var h = '<section class="bbch-screen" tabindex="-1" aria-labelledby="bbchH">';
    var a = S.active;
    if (a === undefined) return h + topBar() + skeleton(3) + '</section>';
    if (!a) {
      if (S.last && S.last.enrollment) {
        S.step = 'done'; S.params = { eid: S.last.enrollment.id };
        setTimeout(load, 0);
        return vDone();
      }
      if (S.dayErr) return h + topBar() + errorBox(S.dayErr) + '</section>';
      return h + topBar() + '<div class="bbch-card bbch-empty"><p class="bbch-empty-ico" aria-hidden="true">🏁</p><p><b>No challenge running.</b></p><p class="bbch-muted">Pick one to start today.</p><button type="button" class="bbch-btn is-gold" data-a="hub">See challenges</button></div></section>';
    }
    var en = a.enrollment;
    var t = a.today;
    var viewingToday = t.day === en.today_day || (en.today_day > en.length && t.day === en.length);
    var titleTail = t.all_done ? '<em>done</em>' : (t.day === 1 && viewingToday ? '<em>let’s go</em>' : '<em>keep going</em>');
    var past = !viewingToday && t.day < en.today_day;
    h += topBar({ right: '<button type="button" class="bbch-pill bbch-pill-btn" data-a="board" data-id="' + esc(a.challenge.id) + '">🏆 Leaderboard</button>' });
    h += '<p class="bbch-eyebrow">' + esc(a.challenge.title) + '</p>' +
      '<h1 class="bbch-h1" id="bbchH">Day ' + t.day + (past ? ' <em>' + (t.all_done ? 'done' : 'missed') + '</em>' : ', ' + titleTail) + '</h1>';
    if (S.offline) h += '<p class="bbch-offline" role="status">Offline · showing your last update</p>';
    h += '<div class="bbch-card bbch-today">' + ring(en.day, en.length) +
      '<div class="bbch-today-meta"><p class="bbch-eyebrow">' + (viewingToday ? 'Today' : 'Day ' + t.day) + '</p>' +
      '<p class="bbch-today-count">' + t.done + ' of ' + t.total + ' done</p>' +
      '<p class="bbch-pills-row"><span class="bbch-pill">🔥 ' + en.streak + ' day streak</span>' +
      '<span class="bbch-pill"><span class="bbch-coin" aria-hidden="true"></span>' + (t.all_done ? '+' + t.coins_on_done + ' today' : '+' + t.coins_on_done + ' when done') + '</span></p></div></div>';
    h += '<div class="bbch-strip" role="list" aria-label="Your days">' + a.days.map(function (d) {
      var cur = d.day === t.day;
      return '<button type="button" role="listitem" class="bbch-strip-d is-' + d.state + (cur ? ' is-cur' : '') + '" data-a="viewday" data-day="' + d.day + '" ' +
        (d.state === 'upcoming' ? 'disabled ' : '') + 'aria-label="Day ' + d.day + ': ' + d.state + (cur ? ', showing' : '') + '"' + (cur ? ' aria-current="true"' : '') + '>' + d.day + '</button>';
    }).join('') + '</div>';
    h += '<div class="bbch-card bbch-tasks-card"><p class="bbch-sec-title">' + (viewingToday ? 'Today’s tasks' : 'Day ' + t.day + ' tasks') + '</p>' +
      '<ul class="bbch-tasks" role="list">' + t.tasks.map(function (x) { return taskRow(past ? Object.assign({}, x, { action: null }) : x); }).join('') + '</ul></div>';
    if (viewingToday) {
      h += '<p class="bbch-foot-note">' + (t.all_done
        ? 'Day ' + t.day + ' complete. ' + (t.next_day_title ? 'Tomorrow: ' + esc(t.next_day_title) + '.' : 'That was the last day!')
        : 'Finish all ' + t.total + ' to complete Day ' + t.day) + '</p>';
    }
    if (en.grace_left >= 0 && en.length - en.min_days > 0) {
      h += '<p class="bbch-fine bbch-center">' + (en.grace_left === 0 ? 'No grace days left: every remaining day counts.' : en.grace_left + (en.grace_left === 1 ? ' grace day' : ' grace days') + ' left') + '</p>';
    }
    h += '<div class="bbch-row-links"><button type="button" class="bbch-link" data-a="hub">All challenges</button><button type="button" class="bbch-link is-quiet" data-a="leave">Leave challenge</button></div>';
    return h + '</section>';
  }

  function shareCardHtml(r) {
    var title = r ? r.challenge.title : '';
    var done = r && r.status === 'completed';
    var day = r ? (done ? r.challenge.length_days : Math.max(1, r.days_done)) : 1;
    var pl = function (n, one, many) { return n + ' ' + (Number(n) === 1 ? one : many); };
    var stats = r ? [pl(r.stats.checkins, 'check in', 'check ins'), pl(r.stats.workouts == null ? r.stats.sessions : r.stats.workouts, 'workout', 'workouts')]
      .concat(r.share && r.share.include_results ? [pl(r.stats.protein_days, 'protein day', 'protein days')] : []) : [];
    return '<div class="bbch-share" role="img" aria-label="Share card: day ' + day + ' done">' +
      '<img class="bbch-logo bbch-share-logo" src="img/bodybank-logo-gold-360.png" alt="BodyBank" width="360" height="138" decoding="async">' +
      '<p class="bbch-share-eye">' + esc(title) + '</p>' +
      '<p class="bbch-share-day">Day ' + day + '</p><p class="bbch-share-done">done.</p>' +
      '<p class="bbch-share-stats">' + stats.map(function (s) { var p = s.split(' '); return '<span><b>' + esc(p.shift()) + '</b> ' + esc(p.join(' ')) + '</span>'; }).join('') + '</p>' +
      '<p class="bbch-share-url">bodybank.fit/challenge</p></div>';
  }

  function vBoard() {
    var id = S.params.id;
    var b = S.board[id];
    var err = S.boardErr[id];
    var ch = (S.active && S.active.challenge && S.active.challenge.id === id) ? S.active.challenge : (S.last && S.last.challenge && S.last.challenge.id === id ? S.last.challenge : (S.detail[id] || null));
    var h = '<section class="bbch-screen" tabindex="-1" aria-labelledby="bbchH">' + topBar();
    h += '<p class="bbch-eyebrow">' + esc(ch ? ch.title : 'Challenge') + ' · ' + (ch && ch.length_days > 7 ? 'This cycle' : 'This week') + '</p>' +
      '<h1 class="bbch-h1" id="bbchH">Leader<em>board</em></h1>';
    if (!b && !err) return h + skeleton(4) + '</section>';
    if (!b) return h + errorBox(err) + '</section>';
    var rows = b.top.slice();
    var meIn = rows.some(function (x) { return x.me; });
    var row = function (x) {
      return '<li class="bbch-lb' + (x.me ? ' is-me' : '') + '"><span class="bbch-lb-rank">' + (x.rank || '—') + '</span>' +
        '<span class="bbch-lb-av" aria-hidden="true">' + esc(x.me ? 'ME' : x.initials) + '</span>' +
        '<span class="bbch-lb-name">' + esc(x.me ? 'You' : x.name) + '</span>' +
        '<span class="bbch-lb-pts">' + x.days_done + '/' + x.of + ' · ' + fmtNum(x.points) + ' pts</span></li>';
    };
    h += '<ol class="bbch-card bbch-board" aria-label="Leaderboard">' + (rows.length ? rows.map(row).join('') : '<li class="bbch-lb-empty">Be the first on the board this week.</li>') +
      (!meIn && b.me && !b.me.hidden ? row(b.me) : '') + '</ol>';
    if (b.me && b.me.hidden) {
      h += '<p class="bbch-fine bbch-center">' + (b.me.reason === 'opted_out' ? 'You are hidden from the board.' : 'New accounts appear on the board after 24 hours.') + '</p>';
    }
    if (b.me) {
      h += '<label class="bbch-toggle"><input type="checkbox" data-a="board-opt" ' + (b.me.reason === 'opted_out' ? '' : 'checked') + '><span class="bbch-toggle-ui" aria-hidden="true"></span><span>Show me on the leaderboard</span></label>';
    }
    var eid = myEnrollmentId();
    var r = eid ? S.results[eid] : null;
    if (r && r.share) {
      h += '<div class="bbch-card bbch-share-wrap">' + shareCardHtml(r) + '</div>' +
        '<label class="bbch-toggle"><input type="checkbox" data-a="share-results" ' + (r.share.include_results ? 'checked' : '') + '><span class="bbch-toggle-ui" aria-hidden="true"></span><span>Include my results <small>Adds your protein days. Never weight or body data.</small></span></label>' +
        '<div class="bbch-two"><button type="button" class="bbch-btn is-gold" data-a="share" data-eid="' + esc(eid) + '">' + ico('share') + 'Share to Instagram</button>' +
        '<button type="button" class="bbch-btn is-outline" data-a="whatsapp" data-eid="' + esc(eid) + '">WhatsApp</button></div>';
    }
    return h + '</section>';
  }

  function vDone() {
    var eid = S.params.eid;
    var r = S.results[eid];
    var err = S.resultsErr[eid];
    var h = '<section class="bbch-screen" tabindex="-1" aria-labelledby="bbchH">' + topBar();
    if (!r && !err) return h + skeleton(4) + '</section>';
    if (!r) return h + errorBox(err) + '</section>';
    var len = r.challenge.length_days;
    if (r.status !== 'completed') {
      h += '<p class="bbch-eyebrow">' + esc(r.challenge.title) + '</p><h1 class="bbch-h1" id="bbchH">So <em>close</em></h1>' +
        '<div class="bbch-card"><p>You finished <b>' + r.days_done + ' of ' + len + '</b> days. Every check in still counted for your streak and your coach saw the effort.</p></div>' +
        '<button type="button" class="bbch-cta" data-a="detail" data-id="' + esc(r.challenge.id) + '">Start again</button>';
      return h + '</section>';
    }
    h += '<div class="bbch-cert" role="group" aria-labelledby="bbchH">' +
      '<img class="bbch-logo bbch-cert-logo" src="img/bodybank-logo-gold-360.png" alt="BodyBank" width="360" height="138" decoding="async">' +
      '<span class="bbch-cert-rule" aria-hidden="true"><i></i></span>' +
      '<p class="bbch-cert-eye">Certificate of completion</p>' +
      '<h1 class="bbch-cert-name" id="bbchH">' + esc(r.name) + '</h1>' +
      '<p class="bbch-muted">completed the BodyBank</p>' +
      '<p class="bbch-cert-ch">' + (/^\d/.test(r.challenge.title) ? '' : len + ' Day ') + esc(r.challenge.title) + '</p>' +
      '<p class="bbch-cert-dates">' + fmtDay(r.start_date) + ' to ' + fmtDay(r.end_date) + ' · ' + esc(r.coach) + '</p></div>';
    var st = r.stats;
    var rows = [
      ['✅', 'Check ins', st.checkins + ' of ' + len + ' days'],
      ['🏋️', 'Coach Mode sessions', st.sessions + (st.sets ? ' · ' + st.sets + ' sets' : '')],
      ['🥚', 'Protein target hit', st.protein_days + ' of ' + len + ' days'],
      ['👣', 'Avg steps', fmtNum(st.avg_steps)],
      ['🪙', 'Coins earned', fmtNum(st.coins)]
    ];
    h += '<div class="bbch-card"><p class="bbch-sec-title">Your results</p><dl class="bbch-results">' + rows.map(function (x) {
      return '<div><dt><span aria-hidden="true">' + x[0] + '</span> ' + esc(x[1]) + '</dt><dd>' + esc(x[2]) + '</dd></div>';
    }).join('') + '</dl></div>';
    if (r.discount && !r.discount.used) {
      // A fact, never an offer: no price, no purchase link (store policy).
      var sub = r.lm_call ? (r.lm_call.requested ? 'Your lifestyle manager will call you' : 'Plus a free call with your lifestyle manager') : ('Valid until ' + fmtDate(r.discount.expires_at));
      h += '<button type="button" class="bbch-unlock" data-a="' + (r.lm_call && !r.lm_call.requested ? 'lm' : 'noop') + '" data-eid="' + esc(eid) + '">' +
        '<span class="bbch-unlock-ico" aria-hidden="true">🎟️</span><span class="bbch-unlock-main"><b>Upgrade discount unlocked · ' + r.discount.pct + '%</b>' +
        '<span>' + esc(sub) + (isIOS() ? '' : ' · use it on bodybank.fit') + '</span></span>' + (r.lm_call && !r.lm_call.requested ? '<span class="bbch-unlock-go" aria-hidden="true">' + ico('arrow') + '</span>' : '') + '</button>';
    } else if (r.lm_call) {
      h += '<button type="button" class="bbch-unlock" data-a="' + (r.lm_call.requested ? 'noop' : 'lm') + '" data-eid="' + esc(eid) + '"><span class="bbch-unlock-ico" aria-hidden="true">📞</span><span class="bbch-unlock-main"><b>' +
        (r.lm_call.requested ? 'Call requested' : 'Book your free lifestyle manager call') + '</b><span>' + (r.lm_call.requested ? 'We will call you within 72 hours.' : 'Within 72 hours, by WhatsApp or phone') + '</span></span></button>';
    }
    var next = (S.list || []).filter(function (c) { return c.id !== r.challenge.id && c.my && c.my.status !== 'active'; })[0];
    h += '<div class="bbch-two"><button type="button" class="bbch-btn is-outline" data-a="pdf" data-eid="' + esc(eid) + '">' + ico('download') + 'Download PDF</button>' +
      (next ? '<button type="button" class="bbch-btn is-outline" data-a="detail" data-id="' + esc(next.id) + '">Next: ' + esc(next.title) + '</button>' : '<button type="button" class="bbch-btn is-outline" data-a="hub">All challenges</button>') + '</div>';
    if (r.share) {
      h += '<div class="bbch-two"><button type="button" class="bbch-btn is-gold" data-a="share" data-eid="' + esc(eid) + '">' + ico('share') + 'Share</button>' +
        '<button type="button" class="bbch-btn is-outline" data-a="board" data-id="' + esc(r.challenge.id) + '">Leaderboard</button></div>';
    }
    return h + '</section>';
  }

  /* -------------------------------------------------------------- render */
  function render(focus) {
    var el = root();
    if (!el) return;
    var html;
    if (S.step === 'detail') html = vDetail();
    else if (S.step === 'day') html = vDay();
    else if (S.step === 'board') html = vBoard();
    else if (S.step === 'done') html = vDone();
    else html = vHub();
    // A data refresh re-paints the screen; keep focus inside it rather than
    // dropping screen-reader / keyboard users back to <body>.
    var act = document.activeElement;
    var hadFocus = !!(act && act !== document.body && el.contains(act));
    var refocus = hadFocus && act.getAttribute ? act.getAttribute('data-a') : null;
    el.innerHTML = shell(html);
    if (!focus && hadFocus) {
      var again = (refocus && el.querySelector('[data-a="' + refocus + '"]')) || el.querySelector('.bbch-screen');
      if (again) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
    }
    if (focus) {
      var scr = el.querySelector('.bbch-screen');
      if (scr) { try { scr.focus({ preventScroll: true }); } catch (e) { scr.focus(); } }
      scrollTop();
    }
  }
  function scrollTop() {
    var w = document.getElementById('userTabContentWrap');
    if (w) w.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- sheets */
  function closeSheet() {
    var v = document.querySelector('.bbch-veil');
    if (!v) return false;
    v.remove();
    if (S.sheetReturn) { try { S.sheetReturn.focus(); } catch (e) { /* gone */ } }
    return true;
  }
  function sheet(html, onAction) {
    closeSheet();
    S.sheetReturn = document.activeElement;
    var v = document.createElement('div');
    v.className = 'bbch-veil';
    v.innerHTML = '<div class="bbch-sheet" role="dialog" aria-modal="true" aria-labelledby="bbchSheetH">' + html + '</div>';
    v.addEventListener('click', function (e) {
      if (e.target === v) { closeSheet(); return; }
      var b = e.target.closest('[data-s]');
      if (b) onAction(b.getAttribute('data-s'), b, v);
    });
    v.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (e.key === 'Tab') {
        var f = v.querySelectorAll('button, input, [href], select, textarea');
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    document.body.appendChild(v);
    var first = v.querySelector('[data-first]') || v.querySelector('button');
    if (first) first.focus();
    return v;
  }

  function confirmLeave() {
    sheet('<h2 id="bbchSheetH">Leave the challenge?</h2><p>Your progress stops here and today’s tasks stop counting. Coins you already earned stay yours.</p>' +
      '<div class="bbch-two"><button type="button" class="bbch-btn is-outline" data-s="cancel" data-first>Keep going</button><button type="button" class="bbch-btn is-danger" data-s="leave">Leave</button></div>',
    async function (a, b) {
      if (a === 'cancel') { closeSheet(); return; }
      b.disabled = true;
      var r = await api('POST', '/api/challenges/me/active/leave');
      closeSheet();
      if (!r.ok) { toast(errText(r, 'Could not leave right now.')); return; }
      S.active = null; S.last = null; S.list = null;
      lsSet(DAY_KEY, null);
      if (typeof window.bbChallengeHomeUpdate === 'function') window.bbChallengeHomeUpdate({ active: null, last: null });
      go('hub', {}, true);
    });
  }

  function lmSheet(eid) {
    var u = user() || {};
    sheet('<h2 id="bbchSheetH">Your lifestyle manager call</h2><p>Free for finishers. We call within 72 hours by WhatsApp or phone.</p>' +
      '<fieldset class="bbch-slots"><legend>Best time of day</legend>' +
      ['morning', 'afternoon', 'evening'].map(function (s, i) {
        return '<label><input type="radio" name="bbchSlot" value="' + s + '"' + (i === 2 ? ' checked' : '') + (i === 0 ? ' data-first' : '') + '><span>' + s.charAt(0).toUpperCase() + s.slice(1) + '</span></label>';
      }).join('') + '</fieldset>' +
      '<label class="bbch-field"><span>Phone (optional)</span><input type="tel" inputmode="tel" autocomplete="tel" id="bbchPhone" placeholder="' + esc(u.phone || '+91') + '"></label>' +
      '<p class="bbch-err" id="bbchLmErr" role="alert" hidden></p>' +
      '<div class="bbch-two"><button type="button" class="bbch-btn is-outline" data-s="cancel">Not now</button><button type="button" class="bbch-btn is-gold" data-s="send">Request call</button></div>',
    async function (a, b, v) {
      if (a === 'cancel') { closeSheet(); return; }
      var slot = (v.querySelector('input[name=bbchSlot]:checked') || {}).value;
      var phone = (v.querySelector('#bbchPhone') || {}).value || '';
      b.disabled = true; b.textContent = 'Sending…';
      var r = await api('POST', '/api/challenges/me/lm-call', { enrollment_id: eid, preferred_slot: slot, phone: phone.trim() || null });
      if (!r.ok) {
        b.disabled = false; b.textContent = 'Request call';
        var e = v.querySelector('#bbchLmErr'); e.hidden = false; e.textContent = errText(r, 'Could not send. Try again.');
        return;
      }
      closeSheet();
      if (S.results[eid]) S.results[eid].lm_call = { requested: true, status: 'requested', preferred_slot: slot };
      render();
      announce('Call requested. Your lifestyle manager will reach out within 72 hours.');
      toast('Call requested. We will reach out within 72 hours.');
    });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'bbch-toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('is-out'); }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }

  /* -------------------------------------------------------------- actions */
  async function join(id) {
    if (S.joining) return;
    S.joining = true; S.joinErr = null; render();
    var body = { client_uuid: newUuid(), source: isApp() ? 'app' : 'web', leaderboard_opt_out: !!S.optOut };
    var r = await api('POST', '/api/challenges/' + encodeURIComponent(id) + '/join', body);
    if (r.network || r.status === 0 || r.status >= 500 || r.status === 429) {
      // Queue it: the server dedupes on client_uuid, so a retry can never double-join.
      var box = (lsGet(OUTBOX_KEY) || []).filter(function (x) { return x && x.uid === uid(); });
      box.push({ uid: uid(), challenge_id: id, body: body, at: Date.now() });
      lsSet(OUTBOX_KEY, box);
      S.joining = false;
      S.joinErr = 'You are offline. We saved your join and will finish it when you are back online.';
      render();
      return;
    }
    S.joining = false;
    if (!r.ok) { S.joinErr = errText(r, 'Could not join right now.'); render(); return; }
    S.list = null; S.detail = {};
    announce('You joined. Day 1 starts now.');
    await loadDay();
    go('day', {}, true);
  }
  async function flushOutbox() {
    if (S.flushing) return;
    var box = (lsGet(OUTBOX_KEY) || []);
    var mine = box.filter(function (x) { return x && x.uid === uid(); });
    if (!mine.length) return;
    S.flushing = true;
    var keep = box.filter(function (x) { return !x || x.uid !== uid(); });
    for (var i = 0; i < mine.length; i++) {
      var j = mine[i];
      var r = await api('POST', '/api/challenges/' + encodeURIComponent(j.challenge_id) + '/join', j.body);
      if (r.network || r.status >= 500 || r.status === 429) keep.push(j); // try again later; 4xx answers are final
    }
    lsSet(OUTBOX_KEY, keep);
    S.flushing = false;
    if (keep.length !== box.length) {
      S.list = null; S.active = undefined;
      if (S.open) { await loadDay(); render(); }
    }
  }

  function doTask(type, area) {
    var sw = typeof window.switchUserTab === 'function' ? window.switchUserTab : null;
    var sub = function (v) { if (typeof window.showCheckinSubView === 'function') window.showCheckinSubView(v); };
    if (type === 'coach') {
      if (typeof window.bbCoachOpen === 'function') { window.bbCoachOpen({ area: area || 'full', from: 'challenge' }); return; }
      if (sw) sw('workout');
      return;
    }
    if (type === 'workout') { if (sw) sw('workout'); return; }
    if (!sw) return;
    sw('checkin');
    if (type === 'meal') sub('meals');
    else if (type === 'sunday') sub('sunday');
    else sub('daily');
  }

  async function openPdf(eid) {
    var r = await api('GET', '/api/challenges/me/certificate/' + encodeURIComponent(eid));
    if (!r.ok || !r.data || !r.data.url) { toast(errText(r, 'Could not open the certificate.')); return; }
    var name = 'BodyBank certificate';
    // Same viewer the app uses for program PDFs (works on web, Android and iOS).
    window.location.href = '/program-viewer.html?url=' + encodeURIComponent(r.data.url) + '&name=' + encodeURIComponent(name);
  }

  async function share(eid, whatsapp) {
    var r = S.results[eid];
    if (!r) { await loadResults(eid); r = S.results[eid]; }
    if (!r || !r.share) { toast('Sharing is not available yet.'); return; }
    var done = r.status === 'completed';
    var text = done
      ? 'I finished the BodyBank ' + r.challenge.title + ': ' + r.days_done + ' of ' + r.challenge.length_days + ' days. Join the free 7 day challenge'
      : 'Day ' + Math.max(1, r.days_done) + ' of the BodyBank ' + r.challenge.title + ' done. Join me';
    var link = r.share.public ? publicOrigin() + r.share.page : '';
    var full = text + (link ? ': ' + link : '.');
    if (whatsapp) {
      window.open('https://wa.me/?text=' + encodeURIComponent(full), '_blank', 'noopener');
      return;
    }
    var P = sharePlugin();
    if (P && P.share) {
      try { await P.share({ title: 'BodyBank', text: text, url: link || undefined, dialogTitle: 'Share your progress' }); return; } catch (e) { /* cancelled */ return; }
    }
    // Web: share the card image itself where the browser can.
    try {
      var img = await fetch(apiBase() + r.share.image + '?format=story');
      if (img.ok && navigator.canShare) {
        var blob = await img.blob();
        var file = new File([blob], 'bodybank-challenge.' + (blob.type === 'image/png' ? 'png' : 'svg'), { type: blob.type });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: full }); return; }
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    if (navigator.share) { try { await navigator.share({ title: 'BodyBank', text: text, url: link || undefined }); return; } catch (e) { return; } }
    // Desktop fallback: save the image.
    var a = document.createElement('a');
    a.href = apiBase() + r.share.image + '?format=story';
    a.download = 'bodybank-challenge.png';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Card saved. Post it to your story.');
  }

  async function setBoardOpt(on) {
    var r = await api('PUT', '/api/challenges/me/leaderboard', { opt_out: !on });
    if (!r.ok) { toast(errText(r, 'Could not update.')); return; }
    announce(on ? 'You are on the leaderboard.' : 'You are hidden from the leaderboard.');
    await loadBoard(S.params.id);
    render();
  }
  async function setShareResults(on, eid) {
    var r = await api('PUT', '/api/challenges/me/leaderboard', { share_results: !!on });
    if (!r.ok) { toast(errText(r, 'Could not update.')); return; }
    if (S.results[eid] && S.results[eid].share) S.results[eid].share.include_results = !!on;
    render();
  }

  function onClick(e) {
    var b = e.target.closest('[data-a]');
    if (!b || !root() || !root().contains(b)) return;
    var a = b.getAttribute('data-a');
    if (b.tagName === 'INPUT') return; // handled on change
    if (a === 'back') { back(); return; }
    if (a === 'retry') { render(); load(); return; }
    if (a === 'hub') { go('hub'); return; }
    if (a === 'detail') { S.joinErr = null; go('detail', { id: b.getAttribute('data-id') }); return; }
    if (a === 'day') { go('day', {}); return; }
    if (a === 'viewday') { S.active = S.active; go('day', { day: Number(b.getAttribute('data-day')) }, true); return; }
    if (a === 'board') { go('board', { id: b.getAttribute('data-id') }); return; }
    if (a === 'done') { go('done', { eid: b.getAttribute('data-eid') }); return; }
    if (a === 'join') { join(b.getAttribute('data-id')); return; }
    if (a === 'task') { doTask(b.getAttribute('data-type'), b.getAttribute('data-area')); return; }
    if (a === 'leave') { confirmLeave(); return; }
    if (a === 'lm') { lmSheet(b.getAttribute('data-eid')); return; }
    if (a === 'pdf') { openPdf(b.getAttribute('data-eid')); return; }
    if (a === 'share') { share(b.getAttribute('data-eid'), false); return; }
    if (a === 'whatsapp') { share(b.getAttribute('data-eid'), true); }
  }
  function onChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute || !root() || !root().contains(t)) return;
    var a = t.getAttribute('data-a');
    if (a === 'optin') { S.optOut = !t.checked; return; }
    if (a === 'board-opt') { setBoardOpt(t.checked); return; }
    if (a === 'share-results') setShareResults(t.checked, myEnrollmentId());
  }

  /* -------------------------------------------------------- open / close */
  var bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    window.addEventListener('popstate', onPop);
    window.addEventListener('online', function () { flushOutbox(); if (S.open) { S.offline = false; load(); } });
    document.addEventListener('visibilitychange', function () {
      // Back from a check-in / meal / workout: refresh the day so ticks appear.
      if (document.visibilityState === 'visible' && S.open && (S.step === 'day' || S.step === 'hub')) load();
    });
  }
  function addBackButton() {
    var App = appPlugin();
    if (!App || !App.addListener || S.backHandle) return;
    try {
      var h = App.addListener('backButton', function () { if (S.open) back(); });
      if (h && typeof h.then === 'function') h.then(function (x) { S.backHandle = x; });
      else S.backHandle = h;
    } catch (e) { S.backHandle = null; }
  }
  function removeBackButton() {
    if (S.backHandle && S.backHandle.remove) try { S.backHandle.remove(); } catch (e) { /* ignore */ }
    S.backHandle = null;
  }
  function watchSection() {
    var el = root();
    if (!el || S.observer || !window.MutationObserver) return;
    S.observer = new MutationObserver(function () {
      var on = el.classList.contains('active');
      if (!on && S.open) {
        S.open = false;
        closeSheet();
        removeBackButton();
      }
    });
    S.observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  async function open(opts) {
    var o = opts || {};
    var el = root();
    if (!el) return;
    bind();
    watchSection();
    var wasOpen = S.open;
    S.open = true;
    addBackButton();
    flushOutbox();
    var urlId = null;
    try { urlId = new URLSearchParams(location.search).get('id'); } catch (e) { /* old browser */ }
    var wantId = o.id || (urlId && /^[a-z0-9-]{1,40}$/.test(urlId) ? urlId : null);
    if (urlId) { try { var p = new URLSearchParams(location.search); p.delete('id'); history.replaceState(history.state, '', location.pathname + (p.toString() ? '?' + p.toString() : '') + location.hash); } catch (e) { /* ignore */ } }
    if (wasOpen && !wantId) { render(); load(); return; }
    S.depth = 0;
    S.active = undefined; S.list = null; S.offline = false;
    // A base history entry, so a back press from the first screen returns to the app.
    try { history.pushState({ bbch: 1, step: 'hub', params: {}, depth: 0 }, ''); S.base = true; } catch (e) { S.base = false; }
    if (wantId) { S.step = 'detail'; S.params = { id: wantId }; render(true); await Promise.all([load(), loadDay()]); return; }
    S.step = 'hub'; S.params = {};
    render(true);
    await loadDay();
    if (!S.open) return;
    if (S.active) { S.step = 'day'; try { history.replaceState({ bbch: 1, step: 'day', params: {}, depth: 0 }, ''); } catch (e) { /* ignore */ } }
    else if (S.last && S.last.enrollment && S.last.enrollment.status === 'completed' && S.last.enrollment.completed_at &&
      Date.now() - new Date(S.last.enrollment.completed_at).getTime() < 3 * 86400000) {
      // Just finished: open on the certificate (the hub is one back press away).
      S.step = 'done'; S.params = { eid: S.last.enrollment.id };
      try { history.replaceState({ bbch: 1, step: 'hub', params: {}, depth: 0 }, ''); history.pushState({ bbch: 1, step: 'done', params: S.params, depth: 1 }, ''); S.depth = 1; } catch (e) { /* ignore */ }
    }
    render(true);
    await load();
  }
  function close(fromPop) {
    closeSheet();
    removeBackButton();
    S.open = false;
    if (!fromPop) {
      var n = S.depth + (S.base ? 1 : 0);
      if (n > 0) try { history.go(-n); } catch (e) { /* ignore */ }
    }
    S.depth = 0; S.base = false;
    if (typeof window.switchUserTab === 'function') window.switchUserTab('home');
  }

  window.bbChallenges = {
    __v: 1,
    open: open,
    close: close,
    flush: flushOutbox,
    // test hooks
    _state: S,
    _splitTitle: splitTitle
  };
  flushOutbox();
})();
