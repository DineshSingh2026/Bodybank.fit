/* ==========================================================================
   COACH MODE — member guided gym logger (window.bbCoach)
   Flow: area → exercises → form guide → log sets → next → summary → save.
   API: /api/coach/* (routes/coachMode.js). Loaded lazily by js/coach-loader.js
   the first time the section opens (or when the offline outbox has work).
   Renders only inside #usec-coach; never touches My Workout.

   Storage (per user, survives an app kill):
     bb_coach_draft_v1   the workout in progress (client_uuid is made at Start)
     bb_coach_outbox_v1  finished workouts waiting to sync (server dedupes on client_uuid)
     bb_coach_plan_v1    last chosen exercise ids per area
   ========================================================================== */
(function () {
  'use strict';
  if (window.bbCoach && window.bbCoach.__v) return;

  var DRAFT_KEY = 'bb_coach_draft_v1';
  var OUTBOX_KEY = 'bb_coach_outbox_v1';
  var PLAN_KEY = 'bb_coach_plan_v1';
  var AREAS = [
    { key: 'upper', label: 'Upper', long: 'Upper body', icon: '💪' },
    { key: 'lower', label: 'Lower', long: 'Lower body', icon: '🏋️' },
    { key: 'core', label: 'Core', long: 'Core', icon: '🔥' },
    { key: 'full', label: 'Full', long: 'Full body', icon: '⚡' }
  ];
  var MAX_EX = 12, MAX_SETS = 10;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EQUIP = [
    { key: '', label: 'All' }, { key: 'barbell', label: 'Barbell' }, { key: 'dumbbell', label: 'Dumbbell' },
    { key: 'machine', label: 'Machine' }, { key: 'cable', label: 'Cable' }, { key: 'body only', label: 'Bodyweight' },
    { key: 'kettlebell', label: 'Kettlebell' }, { key: 'other', label: 'Other' }
  ];
  var REDUCED = false;
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* old webview */ }

  var S = {
    step: 'home', params: {}, depth: 0,
    area: null, home: null, homeErr: null,
    lists: {}, listErr: {}, guides: {}, last: {}, lastLoaded: {},
    pick: null, // { ids:[], q:'', equip:'' } while picking
    tick: null, rest: null, restTick: null, watchTimer: null, hold: null,
    saving: false, saveResult: null, saveErr: null, flushing: false, flushTimer: null,
    backHandle: null, observer: null, open: false
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
  function localYmd(d) { var x = d ? new Date(d) : new Date(); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  function fmtKg(n) { if (n == null || n === '') return '0'; var v = Math.round(Number(n) * 100) / 100; return String(v); }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + s).slice(-2);
  }
  function areaOf(k) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].key === k) return AREAS[i]; return AREAS[1]; }
  function platform() {
    try { if (window.Capacitor && Capacitor.getPlatform) return Capacitor.getPlatform(); } catch (e) { /* web */ }
    return 'web';
  }
  function appPlugin() { try { return window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; } catch (e) { return null; } }

  async function api(method, path, body) {
    var headers = { 'Accept': 'application/json' };
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

  function announce(msg) {
    var el = $('#bbcmLive');
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  function svg(name) {
    var p = {
      down: '<path d="M6 9l6 6 6-6"/>',
      left: '<path d="M15 18l-6-6 6-6"/>',
      x: '<path d="M18 6 6 18M6 6l12 12"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
      up: '<path d="M18 15l-6-6-6 6"/>',
      dumbbell: '<path d="M1.5 12h2M20.5 12h2"/><rect x="3.5" y="8" width="3.2" height="8" rx="1.1"/><rect x="17.3" y="8" width="3.2" height="8" rx="1.1"/><path d="M6.7 12h10.6"/>'
    }[name] || '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  /* Small front-body silhouette: primary muscles gold, secondary dim gold. */
  var MAP_REGIONS = {
    shoulders: ['<circle cx="9" cy="23" r="4"/>', '<circle cx="31" cy="23" r="4"/>'],
    traps: ['<path d="M14 18h12l-3 4h-6z"/>'],
    neck: ['<rect x="17" y="13" width="6" height="5" rx="2"/>'],
    chest: ['<rect x="12" y="21" width="16" height="9" rx="3"/>'],
    lats: ['<rect x="12" y="29" width="3" height="10" rx="1.5"/>', '<rect x="25" y="29" width="3" height="10" rx="1.5"/>'],
    'middle back': ['<rect x="15" y="29" width="10" height="4" rx="2"/>'],
    biceps: ['<rect x="4" y="27" width="5" height="11" rx="2.5"/>', '<rect x="31" y="27" width="5" height="11" rx="2.5"/>'],
    triceps: ['<rect x="4" y="27" width="5" height="11" rx="2.5"/>', '<rect x="31" y="27" width="5" height="11" rx="2.5"/>'],
    forearms: ['<rect x="3" y="39" width="5" height="11" rx="2.5"/>', '<rect x="32" y="39" width="5" height="11" rx="2.5"/>'],
    abdominals: ['<rect x="15" y="31" width="10" height="14" rx="3"/>'],
    'lower back': ['<rect x="15" y="40" width="10" height="5" rx="2"/>'],
    glutes: ['<rect x="13" y="46" width="14" height="7" rx="3"/>'],
    abductors: ['<rect x="12" y="50" width="4" height="8" rx="2"/>', '<rect x="24" y="50" width="4" height="8" rx="2"/>'],
    adductors: ['<rect x="17" y="53" width="6" height="9" rx="2"/>'],
    quadriceps: ['<rect x="12" y="53" width="7" height="17" rx="3.5"/>', '<rect x="21" y="53" width="7" height="17" rx="3.5"/>'],
    hamstrings: ['<rect x="12" y="55" width="7" height="15" rx="3.5"/>', '<rect x="21" y="55" width="7" height="15" rx="3.5"/>'],
    calves: ['<rect x="13" y="72" width="5" height="14" rx="2.5"/>', '<rect x="22" y="72" width="5" height="14" rx="2.5"/>']
  };
  function muscleMap(primary, secondary) {
    var base = '<g fill="#3a3a3f"><circle cx="20" cy="7" r="5"/><rect x="17" y="12" width="6" height="5" rx="2"/>' +
      '<rect x="11" y="18" width="18" height="28" rx="5"/><circle cx="9" cy="23" r="4"/><circle cx="31" cy="23" r="4"/>' +
      '<rect x="4" y="25" width="5" height="25" rx="2.5"/><rect x="31" y="25" width="5" height="25" rx="2.5"/>' +
      '<rect x="12" y="45" width="16" height="8" rx="3"/><rect x="12" y="52" width="7" height="34" rx="3.5"/><rect x="21" y="52" width="7" height="34" rx="3.5"/></g>';
    var sec = (secondary || []).map(function (m) { return (MAP_REGIONS[m] || []).join(''); }).join('');
    var pri = (primary || []).map(function (m) { return (MAP_REGIONS[m] || []).join(''); }).join('');
    return '<svg viewBox="0 0 40 88" aria-hidden="true">' + base + '<g fill="#C9A040" opacity=".45">' + sec + '</g><g fill="#E8C66F">' + pri + '</g></svg>';
  }

  function img(i, cls, sizes, alt) {
    if (!i) return '<div class="' + cls + '" aria-hidden="true"></div>';
    return '<img class="' + cls + '" src="' + esc(i.src) + '"' + (i.srcset ? ' srcset="' + esc(i.srcset) + '" sizes="' + (sizes || '120px') + '"' : '') +
      (i.w ? ' width="' + i.w + '" height="' + i.h + '"' : '') + ' loading="lazy" decoding="async" alt="' + esc(alt || '') + '">';
  }

  /* ------------------------------------------------------------- draft */
  function getDraft() {
    var d = lsGet(DRAFT_KEY);
    if (!d || d.v !== 1 || d.uid !== uid()) return null;
    return d;
  }
  function setDraft(d) { lsSet(DRAFT_KEY, d); }
  function doneSets(item) { return (item.sets || []).filter(function (s) { return s.done; }); }
  function totalDone(d) { var n = 0; (d.items || []).forEach(function (it) { n += doneSets(it).length; }); return n; }
  function totalPlanned(d) { var n = 0; (d.items || []).forEach(function (it) { n += (it.sets || []).length; }); return n; }
  function curSetIndex(item) {
    for (var i = 0; i < item.sets.length; i++) if (!item.sets[i].done) return i;
    return -1;
  }

  function itemFromList(x) {
    return {
      id: x.id, name: x.name, unit: x.unit, load_type: x.load_type, per_side: !!x.per_side,
      step: x.load_step_kg != null && x.load_step_kg > 0 ? x.load_step_kg : 2.5,
      default_sets: x.default_sets || 3, default_reps: x.default_reps || 10,
      thumb: x.thumb, primary: x.primary_muscles || [], secondary: x.secondary_muscles || [],
      mechanic: x.mechanic || '', sets: []
    };
  }

  function seedSets(item, last) {
    var prev = last && last.sets && last.sets.length ? last.sets : null;
    var n = Math.min(MAX_SETS, Math.max(1, prev ? Math.max(item.default_sets, prev.length) : item.default_sets));
    var sets = [];
    for (var i = 0; i < n; i++) {
      var p = prev ? (prev[i] || prev[prev.length - 1]) : null;
      sets.push({
        load_kg: item.load_type === 'kg' ? (p && p.load_kg != null ? Number(p.load_kg) : 0) : null,
        reps: item.unit === 'reps' ? (p && p.reps != null ? p.reps : item.default_reps) : null,
        seconds: item.unit === 'seconds' ? (p && p.seconds != null ? p.seconds : item.default_reps) : null,
        done: false
      });
    }
    item.sets = sets;
    return item;
  }

  /* ------------------------------------------------------------ outbox */
  function outbox() { var o = lsGet(OUTBOX_KEY); return Array.isArray(o) ? o : []; }
  function myOutbox() { var me = uid(); return outbox().filter(function (x) { return x.uid === me; }); }
  function setOutbox(list) { lsSet(OUTBOX_KEY, list && list.length ? list : null); }
  function queue(body) {
    var list = outbox().filter(function (x) { return x.body.client_uuid !== body.client_uuid; });
    list.push({ uid: uid(), body: body, tries: 0, next_at: Date.now() + 5000, queued_at: Date.now() });
    setOutbox(list);
    scheduleFlush();
  }
  function scheduleFlush() {
    clearTimeout(S.flushTimer);
    var mine = myOutbox();
    if (!mine.length) return;
    var next = Math.min.apply(null, mine.map(function (x) { return x.next_at || 0; }));
    S.flushTimer = setTimeout(flush, Math.max(1000, next - Date.now()));
  }
  async function flush(force) {
    if (S.flushing || !uid()) return;
    var mine = myOutbox();
    if (!mine.length) return;
    S.flushing = true;
    var changed = false;
    try {
      for (var i = 0; i < mine.length; i++) {
        var it = mine[i];
        if (!force && it.next_at && it.next_at > Date.now()) continue;
        var r = await api('POST', '/api/coach/workouts', it.body);
        var list = outbox();
        var idx = -1;
        list.forEach(function (x, j) { if (x.body.client_uuid === it.body.client_uuid) idx = j; });
        if (idx < 0) continue;
        if (r.ok) {
          list.splice(idx, 1);
          changed = true;
          if (S.saveResult && S.saveResult.queued && S.saveResult.client_uuid === it.body.client_uuid) {
            S.saveResult = { queued: false, synced: true, data: r.data };
          }
        } else if (!r.network && r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 401) {
          // The server refused it for good (validation). Keep it visible, stop retrying.
          list[idx].failed = (r.data && r.data.error) || 'Could not sync this workout';
          list[idx].next_at = Date.now() + 365 * 86400000;
          changed = true;
        } else {
          list[idx].tries = (list[idx].tries || 0) + 1;
          list[idx].next_at = Date.now() + Math.min(10 * 60000, 5000 * Math.pow(2, list[idx].tries));
        }
        setOutbox(list);
      }
    } finally {
      S.flushing = false;
      scheduleFlush();
      if (changed && S.open && (S.step === 'home' || S.step === 'summary')) render();
    }
  }

  /* -------------------------------------------------------------- data */
  async function loadHome() {
    var r = await api('GET', '/api/coach/home');
    if (r.ok) { S.home = r.data; S.homeErr = null; }
    else S.homeErr = r.network ? 'offline' : ((r.data && r.data.error) || 'Could not load Coach Mode');
  }
  async function loadList(area, force) {
    if (S.lists[area] && !force) return S.lists[area];
    var r = await api('GET', '/api/coach/exercises?area=' + encodeURIComponent(area));
    if (r.ok) { S.lists[area] = r.data.exercises || []; S.listErr[area] = null; }
    else S.listErr[area] = r.network ? 'offline' : ((r.data && r.data.error) || 'Could not load exercises');
    return S.lists[area];
  }
  async function loadGuide(id) {
    if (S.guides[id]) return S.guides[id];
    var r = await api('GET', '/api/coach/exercises/' + encodeURIComponent(id));
    if (r.ok) S.guides[id] = r.data;
    else return { __err: r.network ? 'offline' : ((r.data && r.data.error) || 'Could not load the form guide') };
    return S.guides[id];
  }
  async function loadLast(ids) {
    var need = ids.filter(function (id) { return !S.lastLoaded[id]; });
    if (!need.length) return;
    var r = await api('GET', '/api/coach/last?exercise_ids=' + encodeURIComponent(need.join(',')));
    if (!r.ok) return;
    need.forEach(function (id) { S.lastLoaded[id] = true; S.last[id] = (r.data.last || {})[id] || null; });
  }
  async function loadHistory() {
    var r = await api('GET', '/api/coach/workouts?limit=5');
    S.history = r.ok ? (r.data.workouts || []) : null;
  }

  function planIds(area) {
    var all = lsGet(PLAN_KEY) || {};
    var mine = all[uid()] || {};
    return Array.isArray(mine[area]) ? mine[area] : null;
  }
  function savePlanIds(area, ids) {
    var all = lsGet(PLAN_KEY) || {};
    all[uid()] = all[uid()] || {};
    all[uid()][area] = ids.slice(0, MAX_EX);
    lsSet(PLAN_KEY, all);
  }
  function planFor(area) {
    var list = S.lists[area] || [];
    var byId = {};
    list.forEach(function (x) { byId[x.id] = x; });
    var ids = planIds(area);
    var out = (ids || []).map(function (id) { return byId[id]; }).filter(Boolean);
    if (!ids) out = starterPlan(list);
    return out;
  }
  // Starter plan: the most foundational move for each of four different primary
  // muscles (list is already in the coach's sort order), topped up if needed.
  function starterPlan(list) {
    var seen = {}, out = [];
    list.forEach(function (x) {
      var m = (x.primary_muscles || [])[0] || x.id;
      if (out.length < 4 && !seen[m]) { seen[m] = 1; out.push(x); }
    });
    for (var i = 0; out.length < 4 && i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }

  /* ------------------------------------------------------------ router */
  function root() { return document.getElementById('usec-coach'); }
  function go(step, params, replace) {
    stopTimers();
    S.step = step;
    S.params = params || {};
    try {
      var st = { bbcm: 1, step: step, params: S.params, depth: replace ? S.depth : S.depth + 1 };
      if (replace) history.replaceState(st, '');
      else { history.pushState(st, ''); S.depth += 1; }
    } catch (e) { /* sandboxed */ }
    render(true);
  }
  function back() {
    if (closeDialog()) return;
    if (S.depth > 0) { try { history.back(); return; } catch (e) { /* fall through */ } }
    leave();
  }
  function onPop(e) {
    if (!S.open) return;
    var st = e.state;
    if (st && st.bbcm) {
      closeDialog();
      stopTimers();
      S.depth = st.depth || 0;
      S.step = st.step;
      S.params = st.params || {};
      render(true);
      return;
    }
    // Popped past Coach Mode's first screen: hand back to the Train tab.
    S.depth = 0;
    close(true);
  }
  function leave() {
    var d = getDraft();
    if (d && totalDone(d) > 0 && S.step !== 'summary') {
      confirmDialog('Leave workout?', 'It stays saved as a draft on this phone. Open Coach Mode again to carry on.', 'Leave', 'Keep training', function () { close(); });
      return;
    }
    close();
  }

  /* ----------------------------------------------------------- dialogs */
  function closeDialog() {
    var v = $('.bbcm-veil');
    if (!v) return false;
    v.remove();
    if (S.dialogReturn && S.dialogReturn.focus) try { S.dialogReturn.focus(); } catch (e) { /* gone */ }
    return true;
  }
  function confirmDialog(title, text, okLabel, cancelLabel, onOk, danger) {
    closeDialog();
    S.dialogReturn = document.activeElement;
    var v = document.createElement('div');
    v.className = 'bbcm-veil';
    v.innerHTML = '<div class="bbcm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="bbcmDlgT" aria-describedby="bbcmDlgD">' +
      '<h3 id="bbcmDlgT">' + esc(title) + '</h3><p id="bbcmDlgD">' + esc(text) + '</p>' +
      '<div class="bbcm-dialog-btns"><button type="button" class="bbcm-cta" data-a="cancel">' + esc(cancelLabel) + '</button>' +
      '<button type="button" class="bbcm-btn' + (danger ? ' is-danger' : ' is-ghost') + '" data-a="ok">' + esc(okLabel) + '</button></div></div>';
    v.addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]');
      if (e.target === v || (a && a.getAttribute('data-a') === 'cancel')) { closeDialog(); return; }
      if (a && a.getAttribute('data-a') === 'ok') { closeDialog(); onOk(); }
    });
    v.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      if (e.key === 'Tab') {
        var f = v.querySelectorAll('button');
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    document.body.appendChild(v);
    v.querySelector('[data-a="cancel"]').focus();
  }

  /* ------------------------------------------------------------ render */
  function stopTimers() {
    clearInterval(S.tick); S.tick = null;
    clearInterval(S.watchTimer); S.watchTimer = null;
    if (S.hold) { clearInterval(S.hold.t); S.hold = null; }
  }

  function shell(inner) {
    return '<div class="bbcm" data-step="' + S.step + '">' + inner +
      '<div id="bbcmLive" class="bbcm-sr" aria-live="polite" aria-atomic="true"></div></div>';
  }

  function render(focus) {
    var el = root();
    if (!el) return;
    var html = '';
    if (S.step === 'picker') html = vPicker();
    else if (S.step === 'guide') html = vGuide();
    else if (S.step === 'log') html = vLog();
    else if (S.step === 'summary') html = vSummary();
    else html = vHome();
    el.innerHTML = shell(html);
    after();
    if (focus) {
      var scr = el.querySelector('.bbcm-screen');
      if (scr) { try { scr.focus({ preventScroll: true }); } catch (e) { scr.focus(); } }
      scrollTop();
    }
  }
  function scrollTop() {
    var w = document.getElementById('userTabContentWrap');
    if (w) w.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    var el = root();
    var p = el && el.parentElement;
    while (p && p !== document.body) {
      var cs = getComputedStyle(p);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) p.scrollTop = 0;
      p = p.parentElement;
    }
  }
  function after() {
    if (S.step === 'log') startLogTick();
    if (S.step === 'log' && S.params.watch) startWatch();
  }

  function offlineBanner() {
    var mine = myOutbox();
    var failed = mine.filter(function (x) { return x.failed; });
    var pending = mine.length - failed.length;
    var out = '';
    if (pending) {
      out += '<div class="bbcm-banner is-offline" role="status"><span aria-hidden="true">☁️</span><span><b>' + pending + ' workout' + (pending > 1 ? 's' : '') +
        ' saved on this phone,</b> will sync when you are back online.</span><button type="button" class="bbcm-link" data-act="sync">Sync now</button></div>';
    }
    if (failed.length) {
      out += '<div class="bbcm-banner is-warn" role="alert"><span aria-hidden="true">⚠️</span><span>' + failed.length + ' workout' + (failed.length > 1 ? 's' : '') +
        ' could not sync: ' + esc(failed[0].failed) + '</span><button type="button" class="bbcm-link" data-act="dropfailed">Dismiss</button></div>';
    }
    return out;
  }

  /* ---- home ---- */
  function vHome() {
    var d = getDraft();
    var area = d ? d.area : (S.area || 'lower');
    var now = new Date();
    var first = (S.home && S.home.first_name) || '';
    var h = '<div class="bbcm-screen" tabindex="-1" aria-labelledby="bbcmTitle">';
    h += '<div class="bbcm-tools" style="margin:0"><div class="bbcm-eyebrow">' + DAYS[now.getDay()] + ' · ' + now.getDate() + ' ' + MONS[now.getMonth()] + '</div>' +
      '<button type="button" class="bbcm-icon-btn" data-act="close" aria-label="Close Coach Mode">' + svg('x') + '</button></div>';
    h += '<h2 class="bbcm-h1" id="bbcmTitle">Today\'s <span class="bbcm-it">workout</span></h2>';
    h += offlineBanner();

    if (S.homeErr && !S.home) {
      return h + errBox(S.homeErr === 'offline' ? 'You are offline. Coach Mode needs a connection to load exercises.' : S.homeErr, 'retryhome') + '</div>';
    }
    if (!S.home) return h + skel([52, 120, 86, 76, 76, 76]) + '</div>';

    // Area chooser (locked while a workout is in progress).
    h += '<div class="bbcm-areas" role="group" aria-label="Body area">';
    AREAS.forEach(function (a) {
      var n = S.home.area_counts ? S.home.area_counts[a.key] : null;
      h += '<button type="button" class="bbcm-area" data-act="area" data-area="' + a.key + '" aria-pressed="' + (a.key === area) + '"' +
        (d && a.key !== area ? ' disabled title="Finish or discard the current workout first"' : '') + '>' + a.label +
        (n === 0 ? '<span class="bbcm-sr"> (no exercises yet)</span>' : '') + '</button>';
    });
    h += '</div>';

    var listErr = S.listErr[area];
    var list = S.lists[area];
    if (!d && !list && !listErr) return h + skel([110, 76, 76, 76]) + '</div>';
    if (!d && listErr && !list) return h + errBox(listErr === 'offline' ? 'You are offline. Connect to load ' + areaOf(area).long.toLowerCase() + ' exercises.' : listErr, 'retrylist') + '</div>';
    if (!d && list && !list.length) {
      return h + '<div class="bbcm-card"><div class="bbcm-empty"><b>No approved exercises yet in this area</b>Your coach is still reviewing the ' +
        esc(areaOf(area).long.toLowerCase()) + ' library. Try another area.</div></div></div>';
    }

    var items = d ? d.items : planFor(area).map(function (x) { return itemFromList(x); });
    var setsPlanned = 0;
    items.forEach(function (it) { setsPlanned += d ? it.sets.length : it.default_sets; });
    var mins = Math.max(10, Math.round(items.reduce(function (s, it) { return s + (d ? it.sets.length : it.default_sets) * 2.6; }, 0) / 5) * 5);
    var lvl = levelOf(items, area);

    h += '<div class="bbcm-card is-gold"><div class="bbcm-plan"><div class="bbcm-plan-main">' +
      '<div class="bbcm-plan-tag"><span class="bbcm-eyebrow">' + esc(areaOf(area).long) + '</span>' + (d ? '<span class="bbcm-pill">In progress</span>' : '') + '</div>' +
      '<div class="bbcm-plan-title">' + items.length + ' exercise' + (items.length === 1 ? '' : 's') + ' · ' + setsPlanned + ' sets</div>' +
      '<div class="bbcm-sub">' + (d ? totalDone(d) + ' of ' + totalPlanned(d) + ' sets done · started ' + clock((Date.now() - Date.parse(d.started_at)) / 1000) + ' ago' : 'About ' + mins + ' min' + (lvl ? ' · ' + lvl + ' level' : '')) + '</div>' +
      '</div><div class="bbcm-plan-icon" aria-hidden="true">' + areaOf(area).icon + '</div></div></div>';

    // Context card (real data, never invented).
    var n14 = S.home.workouts_14d || 0;
    h += '<div class="bbcm-card"><div class="bbcm-focus"><span class="bbcm-focus-ico" aria-hidden="true">🎯</span><span>' +
      (n14 === 0 ? '<b>Fresh start.</b> 0 workouts logged in the last 14 days, today is a good day to begin.'
        : '<b>' + n14 + ' workout' + (n14 === 1 ? '' : 's') + '</b> logged in the last 14 days. Keep the rhythm going.') +
      (S.home.has_care_tags ? ' Your coach has tailored this list for you.' : '') + '</span></div></div>';

    h += '<div class="bbcm-tools"><span class="bbcm-sec-title" style="margin:0">' + (d ? 'Your workout' : 'Plan') + '</span>' +
      '<button type="button" class="bbcm-link" data-act="pick">' + (d ? '+ Add exercise' : 'Edit exercises') + '</button></div>';

    if (!items.length) {
      h += '<div class="bbcm-card"><div class="bbcm-empty"><b>No exercises chosen</b>Pick the moves you want to do today.<br><button type="button" class="bbcm-btn" data-act="pick">Choose exercises</button></div></div>';
    }
    var curIdx = d ? (typeof d.cur === 'number' ? d.cur : 0) : 0;
    items.forEach(function (it, i) {
      var done = d ? doneSets(it).length : 0;
      var total = d ? it.sets.length : it.default_sets;
      var isCur = i === curIdx && (!d || done < total);
      var meta = d ? (done + ' of ' + total + ' sets done') : (total + ' × ' + it.default_reps + (it.unit === 'seconds' ? ' s' : '') + (it.per_side ? ' each' + (/(lunge|leg|squat|step|calf|glute|kick)/i.test(it.name) ? ' leg' : ' side') : ''));
      meta += it.primary && it.primary[0] ? ' · ' + it.primary[0] : '';
      var listItem = !d && list ? findIn(list, it.id) : null;
      h += '<button type="button" class="bbcm-row' + (isCur ? ' is-current' : '') + (d && done === total ? ' is-done' : '') + '" data-act="' + (d ? 'jump' : 'guide') + '" data-i="' + i + '" data-id="' + esc(it.id) + '">' +
        img(it.thumb, 'bbcm-thumb', '64px', '') +
        '<span class="bbcm-row-main"><span class="bbcm-row-name">' + esc(it.name) + '</span><span class="bbcm-row-meta">' + esc(meta) + '</span>' +
        (listItem && listItem.care_notes && listItem.care_notes.length ? '<span class="bbcm-row-care">' + esc(listItem.care_notes[0]) + '</span>' : '') + '</span>' +
        (isCur ? '<span class="bbcm-row-go">' + (d ? (done ? 'Continue' : 'Start') : 'Start') + ' →</span>' : (d && done === total ? '<span class="bbcm-row-go" aria-label="done">✓</span>' : '<span class="bbcm-row-chev" aria-hidden="true">›</span>')) +
        '</button>';
    });

    if (d && totalDone(d) > 0) {
      h += '<div class="bbcm-tools" style="justify-content:center;gap:18px"><button type="button" class="bbcm-link" data-act="finish">Finish &amp; review</button>' +
        '<button type="button" class="bbcm-link" style="color:#f0a597" data-act="discard">Discard workout</button></div>';
    } else if (d) {
      h += '<div class="bbcm-tools" style="justify-content:center"><button type="button" class="bbcm-link" style="color:#f0a597" data-act="discard">Discard workout</button></div>';
    }

    if (S.history && S.history.length && !d) {
      h += '<div class="bbcm-card bbcm-hist" style="margin-top:6px"><div class="bbcm-sec-title">Recent Coach Mode workouts</div>';
      S.history.slice(0, 3).forEach(function (w) {
        h += '<div class="bbcm-hist-row"><span><b>' + esc(areaOf(w.area).long) + '</b> · ' + esc(w.local_date) + '</span><span>' + w.total_sets + ' sets' +
          (w.total_volume_kg ? ' · ' + fmtVol(w.total_volume_kg) : '') + '</span></div>';
      });
      h += '</div>';
    }
    h += '<p class="bbcm-about">Exercise photos: free-exercise-db (public domain). Steps and cues reviewed by your BodyBank coach.</p>';

    h += '<div class="bbcm-cta-bar"><button type="button" class="bbcm-cta" data-act="' + (d ? 'resume' : 'start') + '"' + (items.length ? '' : ' disabled') + '>' +
      '<span aria-hidden="true">▶</span> ' + (d ? 'Resume workout' : 'Start workout') + '</button></div>';
    return h + '</div>';
  }
  function findIn(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function levelOf(items, area) {
    var list = S.lists[area] || [];
    var lv = items.map(function (it) { var x = findIn(list, it.id); return x && x.level; }).filter(Boolean);
    if (!lv.length) return '';
    return lv.indexOf('intermediate') >= 0 ? 'intermediate' : 'beginner';
  }
  function fmtVol(kg) { return kg >= 1000 ? (Math.round(kg / 100) / 10) + ' t' : Math.round(kg) + ' kg'; }
  function skel(hs) { return hs.map(function (h) { return '<div class="bbcm-skel" style="height:' + h + 'px" aria-hidden="true"></div>'; }).join('') + '<span class="bbcm-sr" role="status">Loading</span>'; }
  function errBox(msg, act) {
    return '<div class="bbcm-card" role="alert"><div class="bbcm-empty"><b>Couldn\'t load this</b>' + esc(msg) +
      '<br><button type="button" class="bbcm-btn" data-act="' + act + '">Try again</button></div></div>';
  }

  /* ---- picker ---- */
  function vPicker() {
    var area = S.params.area;
    var list = S.lists[area];
    var P = S.pick || { ids: [], q: '', equip: '' };
    var d = getDraft();
    var h = '<div class="bbcm-screen" tabindex="-1" aria-labelledby="bbcmTitle">';
    h += '<div class="bbcm-top"><button type="button" class="bbcm-icon-btn" data-act="back" aria-label="Back">' + svg('left') + '</button>' +
      '<div class="bbcm-top-title" id="bbcmTitle">' + esc(areaOf(area).long) + ' · choose</div><span style="width:44px"></span></div>';
    if (!list) return h + (S.listErr[area] ? errBox(S.listErr[area] === 'offline' ? 'You are offline.' : S.listErr[area], 'retrylist') : skel([46, 64, 64, 64, 64])) + '</div>';
    if (!list.length) return h + '<div class="bbcm-card"><div class="bbcm-empty"><b>No approved exercises yet in this area</b>Try another area.</div></div></div>';

    if (P.ids.length) {
      h += '<div class="bbcm-tray" aria-label="Your order"><div class="bbcm-sec-title" style="margin-bottom:6px">Your order · ' + P.ids.length + '/' + MAX_EX + '</div>';
      P.ids.forEach(function (id, i) {
        var x = findIn(list, id) || (d && d.items.filter(function (it) { return it.id === id; })[0]) || { name: id };
        var locked = d && d.items.some(function (it) { return it.id === id && doneSets(it).length; });
        h += '<div class="bbcm-tray-row"><span class="bbcm-tray-n">' + (i + 1) + '</span><span>' + esc(x.name) + '</span>' +
          '<button type="button" class="bbcm-icon-btn" data-act="mv" data-id="' + esc(id) + '" data-d="-1" aria-label="Move ' + esc(x.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + svg('up') + '</button>' +
          '<button type="button" class="bbcm-icon-btn" data-act="mv" data-id="' + esc(id) + '" data-d="1" aria-label="Move ' + esc(x.name) + ' down"' + (i === P.ids.length - 1 ? ' disabled' : '') + '>' + svg('down') + '</button>' +
          (locked ? '' : '<button type="button" class="bbcm-icon-btn" data-act="tog" data-id="' + esc(id) + '" aria-label="Remove ' + esc(x.name) + '">' + svg('x') + '</button>') + '</div>';
      });
      h += '</div>';
    }

    h += '<label class="bbcm-sr" for="bbcmSearch">Search exercises</label><input id="bbcmSearch" class="bbcm-search" type="search" placeholder="Search by name or muscle" value="' + esc(P.q) + '" autocomplete="off">';
    var present = {};
    list.forEach(function (x) { present[EQUIP.some(function (e) { return e.key === x.equipment; }) ? x.equipment : 'other'] = 1; });
    h += '<div class="bbcm-chips" role="group" aria-label="Equipment">';
    EQUIP.forEach(function (e) {
      if (e.key && !present[e.key]) return;
      h += '<button type="button" class="bbcm-chip" data-act="eq" data-eq="' + esc(e.key) + '" aria-pressed="' + (P.equip === e.key) + '">' + e.label + '</button>';
    });
    h += '</div><div id="bbcmPickList">' + pickRows(list, P) + '</div>';
    h += '<div class="bbcm-cta-bar"><button type="button" class="bbcm-cta" data-act="pickdone"' + (P.ids.length ? '' : ' disabled') + '>' +
      (d ? 'Update workout' : 'Use ' + P.ids.length + ' exercise' + (P.ids.length === 1 ? '' : 's')) + '</button></div>';
    return h + '</div>';
  }
  function pickRows(list, P) {
    var q = (P.q || '').trim().toLowerCase();
    var rows = list.filter(function (x) {
      var eq = EQUIP.some(function (e) { return e.key === x.equipment; }) ? x.equipment : 'other';
      if (P.equip && eq !== P.equip) return false;
      if (!q) return true;
      return (x.name + ' ' + (x.primary_muscles || []).join(' ') + ' ' + (x.secondary_muscles || []).join(' ') + ' ' + x.equipment).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) return '<div class="bbcm-empty"><b>No matches</b>Try a different search.</div>';
    return rows.map(function (x) {
      var on = P.ids.indexOf(x.id) >= 0;
      return '<div class="bbcm-pick' + (on ? ' is-on' : '') + '">' + img(x.thumb, 'bbcm-thumb', '56px', '') +
        '<button type="button" class="bbcm-pick-main" data-act="guide" data-id="' + esc(x.id) + '" aria-label="Form guide: ' + esc(x.name) + '">' +
        '<span class="bbcm-row-name" style="display:block">' + esc(x.name) + '</span><span class="bbcm-row-meta" style="display:block">' +
        esc([(x.primary_muscles || [])[0], x.equipment === 'body only' ? 'bodyweight' : x.equipment].filter(Boolean).join(' · ')) + '</span>' +
        (x.care_notes && x.care_notes.length ? '<span class="bbcm-row-care" style="display:block">' + esc(x.care_notes[0]) + '</span>' : '') + '</button>' +
        '<button type="button" class="bbcm-check" data-act="tog" data-id="' + esc(x.id) + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Remove ' : 'Add ') + esc(x.name) + '">' + (on ? '✓' : '+') + '</button></div>';
    }).join('');
  }

  /* ---- form guide ---- */
  function vGuide() {
    var id = S.params.id;
    var g = S.guides[id];
    var h = '<div class="bbcm-screen" tabindex="-1" aria-labelledby="bbcmTitle">';
    h += '<div class="bbcm-top"><button type="button" class="bbcm-icon-btn" data-act="back" aria-label="Back">' + svg('left') + '</button>' +
      '<div class="bbcm-top-title">Form guide</div><span style="width:44px"></span></div>';
    if (!g) return h + skel([60, 150, 200, 150]) + '</div>';
    if (g.__err) return h + errBox(g.__err === 'offline' ? 'You are offline.' : g.__err, 'retryguide') + '</div>';
    var meta = [g.mechanic, g.force, g.equipment === 'body only' ? 'bodyweight' : g.equipment, g.level].filter(Boolean).map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); });
    h += '<h2 class="bbcm-h2" id="bbcmTitle">' + esc(g.name) + '</h2><div class="bbcm-sub">' + esc(meta.join(' · ')) + '</div>';
    var ims = g.images || [];
    if (ims.length) {
      h += '<div class="bbcm-photos">' + ims.slice(0, 2).map(function (im, i) {
        return '<figure class="bbcm-photo">' + img(im, '', '(min-width:600px) 260px, 45vw', g.name + (i === 0 ? ' start position' : ' end position')) +
          '<figcaption>' + (i + 1) + ' · ' + (i === 0 ? 'Start' : 'End') + '</figcaption></figure>';
      }).join('') + '</div>';
    }
    (g.care_notes || []).forEach(function (n) { h += '<div class="bbcm-banner is-note"><span aria-hidden="true">💧</span><span>' + esc(n) + '</span></div>'; });
    h += '<div class="bbcm-card"><div class="bbcm-sec-title">Posture checkpoints</div><ol class="bbcm-cues">' +
      (g.cues || []).map(function (c, i) { return '<li><span class="bbcm-num" aria-hidden="true">' + (i + 1) + '</span><span>' + esc(c) + '</span></li>'; }).join('') + '</ol></div>';
    if ((g.common_mistakes || []).length) {
      h += '<div class="bbcm-card"><div class="bbcm-sec-title">Common mistakes</div><ul class="bbcm-mistakes">' +
        g.common_mistakes.map(function (m) { return '<li><span class="bbcm-x" aria-hidden="true">✕</span><span>' + esc(m.mistake) + (m.fix ? '<span class="bbcm-fix">' + esc(m.fix) + '</span>' : '') + '</span></li>'; }).join('') + '</ul></div>';
    }
    if ((g.steps || []).length) {
      h += '<div class="bbcm-card"><div class="bbcm-sec-title">Step by step</div><ol class="bbcm-steps">' + g.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
    }
    var d = getDraft();
    var inDraft = d && d.items.some(function (it) { return it.id === id; });
    h += '<div class="bbcm-cta-bar">';
    if (g.ai_form_check && g.ai_form_check_url) {
      h += '<button type="button" class="bbcm-cta" data-act="ai" data-url="' + esc(g.ai_form_check_url) + '"><span aria-hidden="true">📹</span> Check my form with AI trainer</button>';
    } else if (S.params.from === 'log' || inDraft) {
      h += '<button type="button" class="bbcm-cta" data-act="back">Back to workout</button>';
    } else {
      h += '<button type="button" class="bbcm-cta" data-act="back">Back</button>';
    }
    return h + '</div></div>';
  }

  /* ---- logger ---- */
  function vLog() {
    var d = getDraft();
    if (!d || !d.items.length) { S.step = 'home'; return vHome(); }
    var i = Math.min(d.items.length - 1, Math.max(0, d.cur || 0));
    var it = d.items[i];
    var si = typeof S.params.edit === 'number' ? S.params.edit : curSetIndex(it);
    var allDone = si < 0;
    var set = allDone ? null : it.sets[si];
    var guide = S.guides[it.id];
    var ims = (guide && guide.images) || (it.thumb ? [it.thumb] : []);
    var showImg = ims[S.params.frame || 0] || ims[0];
    var pct = totalPlanned(d) ? Math.round(totalDone(d) / totalPlanned(d) * 100) : 0;

    var h = '<div class="bbcm-screen" tabindex="-1" aria-labelledby="bbcmTitle">';
    h += '<div class="bbcm-top"><button type="button" class="bbcm-icon-btn" data-act="tohome" aria-label="Show workout plan">' + svg('down') + '</button>' +
      '<span class="bbcm-timer" role="timer" aria-label="Workout time"><i aria-hidden="true"></i><span id="bbcmClock">' + clock((Date.now() - Date.parse(d.started_at)) / 1000) + '</span></span>' +
      '<button type="button" class="bbcm-icon-btn" data-act="leave" aria-label="Leave workout">' + svg('x') + '</button></div>';
    h += '<div class="bbcm-progress" role="progressbar" aria-label="Sets done" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>';
    h += '<div class="bbcm-eyebrow">Exercise ' + (i + 1) + ' of ' + d.items.length + '</div><h2 class="bbcm-h2" id="bbcmTitle">' + esc(it.name) + '</h2>';

    h += '<div class="bbcm-hero">' + (showImg ? img(showImg, '', '(min-width:600px) 540px, 92vw', it.name) : '<div style="aspect-ratio:16/10"></div>') +
      '<div class="bbcm-hero-map" title="Muscles worked">' + muscleMap(it.primary, it.secondary) + '</div>' +
      (ims.length > 1 ? '<button type="button" class="bbcm-watch" data-act="watch" aria-pressed="' + (!!S.params.watch) + '">' + (S.params.watch ? '❚❚ STOP' : '▶ WATCH FORM') + '</button>' : '') +
      '</div>';
    h += '<div class="bbcm-muscles">' + it.primary.map(function (m) { return '<span class="bbcm-muscle is-primary">' + esc(m) + '</span>'; }).join('') +
      it.secondary.slice(0, 4).map(function (m) { return '<span class="bbcm-muscle">' + esc(m) + '</span>'; }).join('') +
      '<button type="button" class="bbcm-link" data-act="guide" data-id="' + esc(it.id) + '" style="min-height:32px;padding:4px 6px">Form guide ›</button></div>';

    var last = S.last[it.id];
    var lastTxt = '';
    if (last && last.sets && last.sets.length) {
      var ls = last.sets[Math.min(si < 0 ? 0 : si, last.sets.length - 1)];
      lastTxt = 'Last time ' + (it.unit === 'seconds' ? (ls.seconds || 0) + ' s' : (it.load_type === 'kg' && ls.load_kg != null ? fmtKg(ls.load_kg) + ' kg × ' : '') + (ls.reps || 0));
    }
    h += '<div class="bbcm-sethead"><span class="bbcm-eyebrow">' + (allDone ? 'All sets done' : (typeof S.params.edit === 'number' ? 'Edit set ' : 'Set ') + (si + 1) + ' of ' + it.sets.length) + '</span>' +
      '<span class="bbcm-last">' + esc(lastTxt) + '</span></div>';

    if (!allDone) {
      var steppers = [];
      if (it.load_type === 'kg') steppers.push(stepper('load', 'Load', fmtKg(set.load_kg), 'kg', it.step));
      if (it.unit === 'seconds') steppers.push(stepper('seconds', 'Time', set.seconds || 0, 's', 5));
      else steppers.push(stepper('reps', it.per_side ? 'Reps each side' : 'Reps', set.reps || 0, 'reps', 1));
      h += '<div class="bbcm-steppers' + (steppers.length === 1 ? ' is-single' : '') + '">' + steppers.join('') + '</div>';
      if (it.load_type === 'bodyweight') h += '<div class="bbcm-bw" style="margin-top:-6px">Bodyweight move, no load to log.</div>';
      if (it.unit === 'seconds') {
        h += '<button type="button" class="bbcm-btn bbcm-holdbtn" data-act="hold" aria-pressed="' + !!S.hold + '">' + (S.hold ? '■ Stop timer' : '▶ Time this hold') + '</button>';
      }
    }

    h += '<div class="bbcm-setchips" role="group" aria-label="Sets">';
    it.sets.forEach(function (s, k) {
      var label = s.done ? '✓ ' + setLabel(it, s) : (k === si ? 'SET ' + (k + 1) : String(k + 1));
      h += '<button type="button" class="bbcm-setchip' + (s.done ? ' is-done' : '') + (k === si ? ' is-cur' : '') + '" data-act="setchip" data-k="' + k + '" aria-label="Set ' + (k + 1) + (s.done ? ', done, ' + setLabel(it, s) + '. Tap to edit' : '') + '">' + esc(label) + '</button>';
    });
    if (it.sets.length < MAX_SETS) h += '<button type="button" class="bbcm-setchip is-add" data-act="addset" aria-label="Add a set">+</button>';
    h += '</div>';
    if (!allDone && it.sets.length > 1 && typeof S.params.edit !== 'number' && !it.sets[it.sets.length - 1].done) {
      h += '<div style="display:flex;justify-content:flex-end;margin:-8px 0 6px"><button type="button" class="bbcm-link" data-act="rmset" style="min-height:36px;padding:4px 2px;font-size:12px;color:var(--cm-muted)">Remove last set</button></div>';
    }

    if (d.rest_until && d.rest_until > Date.now()) {
      h += '<div class="bbcm-rest" role="timer" aria-label="Rest timer"><b id="bbcmRest">' + clock((d.rest_until - Date.now()) / 1000) + '</b><span>Rest</span>' +
        '<button type="button" class="bbcm-btn" data-act="rest15">+15 s</button><button type="button" class="bbcm-btn" data-act="restskip">Skip</button></div>';
    }

    var ctaLabel, ctaAct;
    if (typeof S.params.edit === 'number') { ctaLabel = '✓ Update set ' + (si + 1); ctaAct = 'saveset'; }
    else if (!allDone) { ctaLabel = '✓ Finish set ' + (si + 1); ctaAct = 'saveset'; }
    else if (i < d.items.length - 1) { ctaLabel = 'Next exercise →'; ctaAct = 'nextex'; }
    else { ctaLabel = 'Finish workout'; ctaAct = 'finish'; }
    h += '<div class="bbcm-cta-bar">';
    h += '<button type="button" class="bbcm-cta" data-act="' + ctaAct + '">' + ctaLabel + '</button></div>';
    return h + '</div>';
  }
  function setLabel(it, s) {
    if (it.unit === 'seconds') return (s.seconds || 0) + 's';
    return (it.load_type === 'kg' ? fmtKg(s.load_kg) + '×' : '') + (s.reps || 0);
  }
  function stepper(field, label, val, unit, step) {
    var nice = field === 'load' ? 'load' : field;
    var stepTxt = field === 'load' ? step + ' kg' : (field === 'seconds' ? step + ' seconds' : '1 rep');
    return '<div class="bbcm-stepper"><div class="bbcm-stepper-label" id="bbcmL_' + field + '">' + esc(label) + '</div>' +
      '<div class="bbcm-stepper-val"><input id="bbcmIn_' + field + '" data-field="' + field + '" inputmode="' + (field === 'load' ? 'decimal' : 'numeric') + '" type="text" value="' + esc(val) + '" aria-labelledby="bbcmL_' + field + '" autocomplete="off"><small>' + unit + '</small></div>' +
      '<div class="bbcm-stepper-btns"><button type="button" class="bbcm-step" data-step="' + field + '" data-dir="-1" aria-label="Decrease ' + nice + ' by ' + stepTxt + '">−</button>' +
      '<button type="button" class="bbcm-step" data-step="' + field + '" data-dir="1" aria-label="Increase ' + nice + ' by ' + stepTxt + '">+</button></div></div>';
  }

  /* ---- summary ---- */
  function vSummary() {
    var d = getDraft();
    var R = S.saveResult;
    var snap = d || (R && R.snapshot);
    var h = '<div class="bbcm-screen bbcm-center" tabindex="-1" aria-labelledby="bbcmTitle">';
    if (!snap) { S.step = 'home'; return vHome(); }
    var items = snap.items.filter(function (it) { return doneSets(it).length; });
    var sets = 0, vol = 0;
    items.forEach(function (it) { doneSets(it).forEach(function (s) { sets++; if (it.load_type === 'kg' && s.load_kg && s.reps) vol += s.load_kg * s.reps; }); });
    var dur = Math.round(((snap.finished_at ? Date.parse(snap.finished_at) : Date.now()) - Date.parse(snap.started_at)) / 1000);
    var first = (S.home && S.home.first_name) || (user() && user().first_name) || '';
    var n14 = S.home ? S.home.workouts_14d : null;

    h += '<div class="bbcm-done-ring" aria-hidden="true">' + svg('check') + '</div>';
    h += '<div class="bbcm-eyebrow">Workout complete</div>';
    h += '<h2 class="bbcm-h1" id="bbcmTitle" style="margin:8px 0 6px">Strong work' + (first ? ', <span class="bbcm-it">' + esc(first) + '</span>' : '') + '</h2>';
    h += '<div class="bbcm-sub">' + (n14 === 0 ? 'First workout logged in 14+ days 🔥' : 'Every set logged counts.') + '</div>';
    h += '<div class="bbcm-stats"><div class="bbcm-stat"><b>' + Math.max(1, Math.round(dur / 60)) + '<small>min</small></b><span>duration</span></div>' +
      '<div class="bbcm-stat"><b>' + sets + '</b><span>sets</span></div>' +
      '<div class="bbcm-stat"><b>' + (vol >= 1000 ? (Math.round(vol / 100) / 10) + '<small>t</small>' : Math.round(vol) + '<small>kg</small>') + '</b><span>volume</span></div></div>';

    h += '<div class="bbcm-card" style="text-align:left"><div class="bbcm-sec-title">Sets logged</div>';
    var prs = [];
    items.forEach(function (it) {
      var ds = doneSets(it);
      h += '<div class="bbcm-logged-row"><span>' + esc(it.name) + '</span><span>' + esc(setsLine(it, ds)) + '</span></div>';
      var last = S.last[it.id];
      if (it.load_type === 'kg' && last && last.best_load_kg != null) {
        var top = Math.max.apply(null, ds.map(function (s) { return Number(s.load_kg) || 0; }));
        if (top > last.best_load_kg) prs.push(it.name.split(' ').slice(-2).join(' ').toLowerCase() + ' ' + fmtKg(top) + ' kg');
      }
    });
    if (prs.length) h += '<div class="bbcm-pr">🏆 New best: ' + esc(prs.join(', ')) + '</div>';
    h += '</div>';

    if (!R || R.error) {
      h += '<div class="bbcm-card" style="text-align:left"><label class="bbcm-sec-title" for="bbcmNotes" style="display:block">How did it feel? (optional)</label>' +
        '<textarea id="bbcmNotes" class="bbcm-notes" maxlength="500" placeholder="Energy, anything that felt off, what to change next time">' + esc((d && d.notes) || '') + '</textarea></div>';
    }

    // Coins / sync state
    var coinsTxt, coinsSub;
    if (R && R.data && R.data.coins) {
      var c = R.data.coins;
      coinsTxt = 'Coins balance ' + (c.balance != null ? c.balance : '—');
      coinsSub = c.awarded ? '+' + c.delta + ' coins for today\'s workout' : (R.data.duplicate ? 'Already saved earlier' : 'Workout reward already earned today');
      if (R.data.streak > 0) coinsSub += ' · check-in streak ' + R.data.streak + ' day' + (R.data.streak === 1 ? '' : 's');
    } else if (R && R.queued) {
      coinsTxt = 'Saved on this phone';
      coinsSub = 'It will sync and pay the workout reward when you are back online';
    } else {
      coinsTxt = 'Coins balance ' + (S.coinBalance != null ? S.coinBalance : '…');
      coinsSub = 'workout reward shown after save';
    }
    h += '<div class="bbcm-card" style="text-align:left"><div class="bbcm-coins"><span class="bbcm-coin" aria-hidden="true"></span><span><b style="display:block;font-size:16px">' + esc(coinsTxt) + '</b>' +
      '<span class="bbcm-sub" style="display:block;font-size:12px;line-height:1.4;margin-top:2px">' + esc(coinsSub) + '</span></span></div></div>';

    if (R && R.error) {
      h += '<div class="bbcm-banner is-warn" role="alert" style="text-align:left"><span aria-hidden="true">⚠️</span><span>' + esc(R.error) +
        (R.fields && R.fields.length ? '<ul class="bbcm-errors">' + R.fields.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '') + '</span></div>';
    }
    if (R && R.queued) h += '<div class="bbcm-banner is-offline" role="status" style="text-align:left"><span aria-hidden="true">☁️</span><span><b>Saved on this phone,</b> will sync.</span></div>';

    h += '<div class="bbcm-cta-bar">';
    if (R && (R.data || R.queued || R.synced)) h += '<button type="button" class="bbcm-cta" data-act="done">Done</button>';
    else h += '<button type="button" class="bbcm-cta" data-act="save"' + (S.saving ? ' disabled' : '') + '>' + (S.saving ? 'Saving…' : 'Save workout') + '</button>' +
      '<div style="display:flex;justify-content:center"><button type="button" class="bbcm-link" data-act="tohome">Back to workout</button></div>';
    return h + '</div></div>';
  }
  function setsLine(it, ds) {
    var each = it.per_side ? ' each' : '';
    if (it.unit === 'seconds') return ds.map(function (s) { return s.seconds || 0; }).join(' · ') + ' s';
    var reps = ds.map(function (s) { return s.reps || 0; });
    var sameReps = reps.every(function (r) { return r === reps[0]; });
    if (it.load_type !== 'kg') return reps.join(' · ') + each;
    var loads = ds.map(function (s) { return Number(s.load_kg) || 0; });
    if (sameReps) return loads.map(fmtKg).join(' · ') + ' kg × ' + reps[0] + each;
    return ds.map(function (s) { return fmtKg(s.load_kg) + '×' + (s.reps || 0); }).join(' · ') + ' kg' + each;
  }

  /* ------------------------------------------------------------ actions */
  async function startWorkout() {
    var area = S.area || 'lower';
    var plan = planFor(area);
    if (!plan.length) return;
    var d = {
      v: 1, uid: uid(), client_uuid: newUuid(), area: area, started_at: new Date().toISOString(),
      items: plan.map(function (x) { return itemFromList(x); }), cur: 0, notes: '', finished_at: null, rest_until: null
    };
    await loadLast(d.items.map(function (it) { return it.id; }));
    d.items.forEach(function (it) { seedSets(it, S.last[it.id]); });
    setDraft(d);
    announce('Workout started');
    loadGuide(d.items[0].id).then(function () { if (S.step === 'log') render(); });
    go('log', {});
  }

  function curItem() { var d = getDraft(); return d ? { d: d, it: d.items[d.cur || 0] } : null; }

  function readInputs(it, s) {
    var root = document.querySelector('#usec-coach');
    ['load', 'reps', 'seconds'].forEach(function (f) {
      var el = root && root.querySelector('#bbcmIn_' + f);
      if (!el) return;
      applyValue(it, s, f, el.value);
    });
  }
  function applyValue(it, s, f, raw) {
    var n = parseFloat(String(raw).replace(',', '.'));
    if (!isFinite(n) || n < 0) n = 0;
    if (f === 'load') { n = Math.min(500, Math.round(n * 4) / 4); s.load_kg = n; }
    else if (f === 'reps') s.reps = Math.min(100, Math.round(n));
    else if (f === 'seconds') s.seconds = Math.min(3600, Math.round(n));
  }
  function bump(field, dir) {
    var c = curItem(); if (!c) return;
    var it = c.it;
    var si = typeof S.params.edit === 'number' ? S.params.edit : curSetIndex(it);
    if (si < 0) return;
    var s = it.sets[si];
    var input = document.getElementById('bbcmIn_' + field);
    if (input) applyValue(it, s, field, input.value);
    s.touched = true;
    if (field === 'load') s.load_kg = Math.max(0, Math.min(500, Math.round(((s.load_kg || 0) + dir * it.step) * 4) / 4));
    if (field === 'reps') s.reps = Math.max(0, Math.min(100, (s.reps || 0) + dir));
    if (field === 'seconds') s.seconds = Math.max(0, Math.min(3600, (s.seconds || 0) + dir * 5));
    setDraft(c.d);
    if (input) input.value = field === 'load' ? fmtKg(s.load_kg) : (field === 'reps' ? s.reps : s.seconds);
  }

  function saveSet() {
    var c = curItem(); if (!c) return;
    var d = c.d, it = c.it;
    var editing = typeof S.params.edit === 'number';
    var si = editing ? S.params.edit : curSetIndex(it);
    if (si < 0) return;
    var s = it.sets[si];
    readInputs(it, s);
    if (it.unit === 'reps' && !(s.reps > 0)) { announce('Enter your reps first'); var r = document.getElementById('bbcmIn_reps'); if (r) r.focus(); return; }
    if (it.unit === 'seconds' && !(s.seconds > 0)) { announce('Enter the time first'); return; }
    if (it.load_type === 'kg' && !(s.load_kg > 0)) {
      announce('Enter the load first');
      var li = document.getElementById('bbcmIn_load');
      if (li) { li.focus(); var card = li.closest('.bbcm-stepper'); if (card) { card.style.borderColor = 'var(--cm-gold-t)'; } }
      return;
    }
    s.done = true;
    // Carry the load forward so the next set starts where this one ended,
    // unless the member already set that next set by hand.
    for (var k = si + 1; k < it.sets.length; k++) {
      if (!it.sets[k].done) {
        if (it.load_type === 'kg' && !it.sets[k].touched) it.sets[k].load_kg = s.load_kg;
        break;
      }
    }
    if (!editing) {
      var rest = it.unit === 'seconds' ? 45 : (it.mechanic === 'isolation' ? 60 : 90);
      var g = S.guides[it.id];
      if (g && g.mechanic === 'isolation' && it.unit !== 'seconds') rest = 60;
      d.rest_until = curSetIndex(it) >= 0 ? Date.now() + rest * 1000 : null;
    }
    setDraft(d);
    announce('Set ' + (si + 1) + ' saved: ' + setLabel(it, s) + (curSetIndex(it) < 0 ? '. All sets done for ' + it.name : ''));
    if (navigator.vibrate) try { navigator.vibrate(15); } catch (e) { /* ignore */ }
    S.params = { frame: 0 };
    replaceState();
    render();
    var cta = document.querySelector('#usec-coach .bbcm-cta');
    if (cta) try { cta.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function replaceState() { try { history.replaceState({ bbcm: 1, step: S.step, params: S.params, depth: S.depth }, ''); } catch (e) { /* ignore */ } }

  function nextExercise(i) {
    var d = getDraft(); if (!d) return;
    d.cur = typeof i === 'number' ? i : Math.min(d.items.length - 1, (d.cur || 0) + 1);
    d.rest_until = null;
    setDraft(d);
    var it = d.items[d.cur];
    loadGuide(it.id).then(function () { if (S.step === 'log') render(); });
    var nx = d.items[d.cur + 1];
    if (nx) loadGuide(nx.id).then(function (g) { prefetch(g); });
    S.params = {};
    replaceState();
    render(true);
    announce('Exercise ' + (d.cur + 1) + ': ' + it.name);
  }
  function prefetch(g) {
    if (!g || !g.images || !g.images[0]) return;
    var i = new Image();
    i.decoding = 'async';
    if (g.images[0].srcset) { i.sizes = '92vw'; i.srcset = g.images[0].srcset; }
    i.src = g.images[0].src;
  }

  function finishWorkout() {
    var d = getDraft(); if (!d) return;
    if (!totalDone(d)) { announce('Log at least one set first'); return; }
    d.finished_at = new Date().toISOString();
    d.rest_until = null;
    setDraft(d);
    S.saveResult = null;
    if (S.coinBalance == null) {
      api('GET', '/api/coins/summary').then(function (r) { if (r.ok && r.data) { S.coinBalance = Number(r.data.balance); if (S.step === 'summary') render(); } });
    }
    go('summary', {});
  }

  function buildBody(d) {
    var exercises = [];
    d.items.forEach(function (it) {
      var ds = doneSets(it);
      if (!ds.length) return;
      exercises.push({
        exercise_id: it.id,
        order: exercises.length,
        sets: ds.map(function (s, k) {
          return {
            set_number: k + 1,
            load_kg: it.load_type === 'kg' ? (Number(s.load_kg) || 0) : null,
            reps: it.unit === 'reps' ? (s.reps || 0) : null,
            seconds: it.unit === 'seconds' ? (s.seconds || 0) : null
          };
        })
      });
    });
    return {
      client_uuid: d.client_uuid, area: d.area, started_at: d.started_at,
      finished_at: d.finished_at || new Date().toISOString(), local_date: localYmd(d.started_at),
      notes: (d.notes || '').slice(0, 500), app_platform: platform(), exercises: exercises
    };
  }

  async function saveWorkout() {
    var d = getDraft(); if (!d || S.saving) return;
    var notes = document.getElementById('bbcmNotes');
    if (notes) { d.notes = notes.value.slice(0, 500); setDraft(d); }
    var body = buildBody(d);
    S.saving = true; render();
    var r = await api('POST', '/api/coach/workouts', body);
    S.saving = false;
    var snapshot = JSON.parse(JSON.stringify(d));
    if (r.ok) {
      setDraft(null);
      setOutbox(outbox().filter(function (x) { return x.body.client_uuid !== body.client_uuid; }));
      S.saveResult = { data: r.data, snapshot: snapshot };
      S.history = null; S.home = null;
      announce('Workout saved' + (r.data.coins && r.data.coins.awarded ? ', plus ' + r.data.coins.delta + ' coins' : ''));
      if (typeof window.bbLoadCoinSummary === 'function') try { window.bbLoadCoinSummary(true); } catch (e) { /* ignore */ }
      if (typeof window.loadWorkoutHistory === 'function') try { window.loadWorkoutHistory(); } catch (e) { /* ignore */ }
    } else if (r.network || r.status >= 500 || r.status === 429) {
      queue(body);
      setDraft(null);
      S.saveResult = { queued: true, client_uuid: body.client_uuid, snapshot: snapshot };
      announce('Saved on this phone, will sync');
    } else if (r.status === 401) {
      S.saveResult = { error: 'Your session expired. Sign in again, your workout stays saved on this phone.', snapshot: snapshot };
    } else {
      var errs = r.data && r.data.errors ? Object.keys(r.data.errors).map(function (k) { return r.data.errors[k]; }) : [];
      S.saveResult = { error: (r.data && r.data.error) || 'Could not save the workout', fields: errs.slice(0, 5), snapshot: snapshot };
    }
    render();
  }

  /* ---------------------------------------------------------- timers */
  function startLogTick() {
    clearInterval(S.tick);
    S.tick = setInterval(function () {
      var d = getDraft();
      if (!d || S.step !== 'log' || !document.getElementById('bbcmClock')) { clearInterval(S.tick); return; }
      document.getElementById('bbcmClock').textContent = clock((Date.now() - Date.parse(d.started_at)) / 1000);
      var r = document.getElementById('bbcmRest');
      if (r) {
        var left = (d.rest_until || 0) - Date.now();
        if (left <= 0) {
          d.rest_until = null; setDraft(d);
          if (navigator.vibrate) try { navigator.vibrate([60, 60, 60]); } catch (e) { /* ignore */ }
          announce('Rest over. Next set.');
          var box = r.closest('.bbcm-rest'); if (box) box.remove();
        } else r.textContent = clock(left / 1000);
      }
      if (S.hold) {
        var el = document.getElementById('bbcmIn_seconds');
        if (el) el.value = Math.round((Date.now() - S.hold.at) / 1000);
      }
    }, 1000);
  }
  function startWatch() {
    clearInterval(S.watchTimer);
    if (REDUCED) return;
    S.watchTimer = setInterval(function () {
      var hero = document.querySelector('#usec-coach .bbcm-hero img');
      var c = curItem();
      var g = c && S.guides[c.it.id];
      if (!hero || !g || !g.images || g.images.length < 2) return;
      S.params.frame = S.params.frame ? 0 : 1;
      var im = g.images[S.params.frame];
      hero.src = im.src;
      if (im.srcset) hero.srcset = im.srcset;
    }, 900);
  }

  /* ---- long-press steppers ---- */
  var press = null;
  function pressStart(btn) {
    pressEnd();
    var f = btn.getAttribute('data-step'), dir = Number(btn.getAttribute('data-dir'));
    bump(f, dir);
    var n = 0;
    press = { t: setTimeout(function rep() { bump(f, dir); n++; press.t = setTimeout(rep, n > 8 ? 55 : 110); }, 420) };
  }
  function pressEnd() { if (press) { clearTimeout(press.t); press = null; } }

  /* ----------------------------------------------------------- events */
  function bind() {
    var el = root();
    if (!el || el.__bbcmBound) return;
    el.__bbcmBound = true;

    el.addEventListener('pointerdown', function (e) {
      var b = e.target.closest('.bbcm-step');
      if (!b) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      pressStart(b);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(function (t) { el.addEventListener(t, pressEnd); });
    el.addEventListener('contextmenu', function (e) { if (e.target.closest('.bbcm-step')) e.preventDefault(); });

    el.addEventListener('click', function (e) {
      var st = e.target.closest('.bbcm-step');
      if (st) { if (e.detail === 0) bump(st.getAttribute('data-step'), Number(st.getAttribute('data-dir'))); return; }
      var a = e.target.closest('[data-act]');
      if (!a || a.disabled) return;
      act(a.getAttribute('data-act'), a, e);
    });
    el.addEventListener('input', function (e) {
      if (e.target.id === 'bbcmSearch') {
        S.pick.q = e.target.value;
        var box = document.getElementById('bbcmPickList');
        if (box) box.innerHTML = pickRows(S.lists[S.params.area] || [], S.pick);
      }
    });
    el.addEventListener('change', function (e) {
      var f = e.target.getAttribute && e.target.getAttribute('data-field');
      if (!f) return;
      var c = curItem(); if (!c) return;
      var si = typeof S.params.edit === 'number' ? S.params.edit : curSetIndex(c.it);
      if (si < 0) return;
      applyValue(c.it, c.it.sets[si], f, e.target.value);
      c.it.sets[si].touched = true;
      setDraft(c.d);
      var s = c.it.sets[si];
      e.target.value = f === 'load' ? fmtKg(s.load_kg) : (f === 'reps' ? s.reps : s.seconds);
    });
    el.addEventListener('focusin', function (e) { if (e.target.matches && e.target.matches('.bbcm-stepper-val input')) try { e.target.select(); } catch (x) { /* ignore */ } });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches && e.target.matches('.bbcm-stepper-val input')) { e.preventDefault(); e.target.blur(); }
    });
  }

  async function act(name, a) {
    var d = getDraft();
    switch (name) {
      case 'close': return leave();
      case 'back': return back();
      case 'leave': return leave();
      case 'retryhome': S.homeErr = null; render(); await loadHome(); await loadList(S.area, true); return render();
      case 'retrylist': S.listErr[S.params.area || S.area] = null; render(); await loadList(S.params.area || S.area, true); return render();
      case 'retryguide': delete S.guides[S.params.id]; render(); await loadGuide(S.params.id); return render();
      case 'sync': await flush(true); return render();
      case 'dropfailed': setOutbox(outbox().filter(function (x) { return !(x.uid === uid() && x.failed); })); return render();
      case 'area':
        if (d) return;
        S.area = a.getAttribute('data-area');
        try { localStorage.setItem('bb_coach_area', S.area); } catch (e) { /* ignore */ }
        render();
        await loadList(S.area);
        return render();
      case 'pick': {
        var area = d ? d.area : S.area;
        S.pick = { ids: d ? d.items.map(function (it) { return it.id; }) : planFor(area).map(function (x) { return x.id; }), q: '', equip: '' };
        go('picker', { area: area });
        if (!S.lists[area]) { await loadList(area); render(); }
        return;
      }
      case 'tog': {
        var id = a.getAttribute('data-id');
        var i = S.pick.ids.indexOf(id);
        if (i >= 0) {
          if (d && d.items.some(function (it) { return it.id === id && doneSets(it).length; })) return;
          S.pick.ids.splice(i, 1);
        } else {
          if (S.pick.ids.length >= MAX_EX) { announce('Up to ' + MAX_EX + ' exercises per workout'); return; }
          S.pick.ids.push(id);
        }
        renderKeepScroll();
        return announce((i >= 0 ? 'Removed. ' : 'Added. ') + S.pick.ids.length + ' selected');
      }
      case 'mv': {
        var id2 = a.getAttribute('data-id'), dir = Number(a.getAttribute('data-d'));
        var j = S.pick.ids.indexOf(id2), k = j + dir;
        if (j < 0 || k < 0 || k >= S.pick.ids.length) return;
        S.pick.ids.splice(k, 0, S.pick.ids.splice(j, 1)[0]);
        return renderKeepScroll();
      }
      case 'eq': S.pick.equip = a.getAttribute('data-eq'); return renderKeepScroll();
      case 'pickdone': return pickDone();
      case 'guide': {
        var gid = a.getAttribute('data-id');
        go('guide', { id: gid, from: S.step });
        if (!S.guides[gid]) { await loadGuide(gid); if (S.step === 'guide' && S.params.id === gid) render(); }
        return;
      }
      case 'ai': {
        var url = a.getAttribute('data-url');
        if (url) window.location.href = url;
        return;
      }
      case 'start': return startWorkout();
      case 'resume': {
        if (!d) return;
        loadLast(d.items.map(function (it) { return it.id; }));
        loadGuide(d.items[d.cur || 0].id).then(function () { if (S.step === 'log') render(); });
        return go('log', {});
      }
      case 'jump': {
        if (!d) return;
        var ji = Number(a.getAttribute('data-i'));
        d.cur = ji; setDraft(d);
        loadGuide(d.items[ji].id).then(function () { if (S.step === 'log') render(); });
        return go('log', {});
      }
      case 'tohome': return S.depth > 0 ? back() : go('home', {}, true);
      case 'discard':
        return confirmDialog('Discard this workout?', 'The sets you logged in this workout will be deleted from this phone.', 'Discard', 'Keep it', function () {
          setDraft(null); S.params = {}; render(true); announce('Workout discarded');
        }, true);
      case 'watch':
        S.params.watch = !S.params.watch;
        if (!S.params.watch) { clearInterval(S.watchTimer); }
        else if (REDUCED) { S.params.frame = S.params.frame ? 0 : 1; S.params.watch = false; }
        replaceState();
        return render();
      case 'setchip': {
        var c = curItem(); if (!c) return;
        var kk = Number(a.getAttribute('data-k'));
        if (c.it.sets[kk].done) { S.params.edit = kk; }
        else { delete S.params.edit; }
        replaceState();
        return render();
      }
      case 'addset': {
        var c2 = curItem(); if (!c2 || c2.it.sets.length >= MAX_SETS) return;
        var lastS = c2.it.sets[c2.it.sets.length - 1];
        c2.it.sets.push({ load_kg: lastS ? lastS.load_kg : 0, reps: lastS ? lastS.reps : c2.it.default_reps, seconds: lastS ? lastS.seconds : null, done: false });
        setDraft(c2.d); delete S.params.edit; replaceState();
        render(); return announce('Set added. ' + c2.it.sets.length + ' sets');
      }
      case 'rmset': {
        var c3 = curItem(); if (!c3) return;
        var lst = c3.it.sets[c3.it.sets.length - 1];
        if (c3.it.sets.length <= 1 || lst.done) return;
        c3.it.sets.pop(); setDraft(c3.d); render(); return announce('Set removed');
      }
      case 'saveset': return saveSet();
      case 'rest15': if (d && d.rest_until) { d.rest_until += 15000; setDraft(d); render(); } return;
      case 'restskip': if (d) { d.rest_until = null; setDraft(d); render(); } return;
      case 'hold': {
        if (S.hold) {
          var secs = Math.round((Date.now() - S.hold.at) / 1000);
          S.hold = null;
          var c4 = curItem();
          if (c4) { var si4 = curSetIndex(c4.it); if (si4 >= 0) { c4.it.sets[si4].seconds = Math.min(3600, secs); setDraft(c4.d); } }
          render(); return announce('Timer stopped at ' + secs + ' seconds');
        }
        S.hold = { at: Date.now() };
        render(); return announce('Timer started');
      }
      case 'nextex': return nextExercise();
      case 'finish': return finishWorkout();
      case 'save': return saveWorkout();
      case 'done':
        S.saveResult = null; S.params = {};
        S.home = null; S.history = null;
        go('home', {}, true);
        loadHome().then(function () { return loadHistory(); }).then(function () { if (S.step === 'home') render(); });
        return;
    }
  }
  function renderKeepScroll() {
    var w = scrollerOf(root());
    var y = w ? w.scrollTop : 0;
    var focusId = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-id');
    var focusAct = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-act');
    render();
    if (w) w.scrollTop = y;
    if (focusId && focusAct) {
      var f = root().querySelector('[data-act="' + focusAct + '"][data-id="' + focusId.replace(/"/g, '') + '"]');
      if (f) try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  function scrollerOf(el) {
    var p = el && el.parentElement;
    while (p && p !== document.body) {
      var cs = getComputedStyle(p);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return document.scrollingElement;
  }
  function pickDone() {
    var area = S.params.area;
    var ids = S.pick.ids.slice(0, MAX_EX);
    var d = getDraft();
    if (d) {
      var byId = {};
      d.items.forEach(function (it) { byId[it.id] = it; });
      var list = S.lists[area] || [];
      var cur = d.items[d.cur || 0];
      var added = [];
      d.items = ids.map(function (id) {
        if (byId[id]) return byId[id];
        var x = findIn(list, id);
        if (!x) return null;
        added.push(id);
        return seedSets(itemFromList(x), S.last[id]);
      }).filter(Boolean);
      var ci = cur ? d.items.indexOf(cur) : 0;
      d.cur = ci >= 0 ? ci : 0;
      setDraft(d);
      if (added.length) loadLast(added);
    } else {
      savePlanIds(area, ids);
    }
    S.pick = null;
    back();
  }

  /* -------------------------------------------------------- open/close */
  function setBottomNavTrain() {
    // Coach Mode lives inside Train: keep that tab lit. (Visual only — the nav markup is untouched.)
    document.querySelectorAll('.user-bottom-nav-item[data-tab="workout"]').forEach(function (b) { b.classList.add('active'); });
  }
  function addBackButton() {
    var App = appPlugin();
    if (!App || !App.addListener || S.backHandle) return;
    try {
      var h = App.addListener('backButton', function () { back(); });
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
        stopTimers();
        closeDialog();
        removeBackButton();
      }
    });
    S.observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  async function open() {
    var el = root();
    if (!el) return;
    bind();
    watchSection();
    var wasOpen = S.open;
    S.open = true;
    setBottomNavTrain();
    addBackButton();
    if (!wasOpen) {
      S.depth = 0;
      var d = getDraft();
      if (!S.area) { try { S.area = localStorage.getItem('bb_coach_area') || 'lower'; } catch (e) { S.area = 'lower'; } }
      if (d) S.area = d.area;
      S.step = d && d.finished_at ? 'summary' : (d ? 'log' : 'home');
      // Coach Mode's first screen gets its own history entry (depth 0) so a browser /
      // Android back press from it lands back on the Train tab.
      try { history.pushState({ bbcm: 1, step: 'home', params: {}, depth: 0 }, ''); S.base = true; } catch (e) { S.base = false; }
      if (S.step === 'log' || S.step === 'summary') {
        // Resume straight into the workout; the plan sits one back-press behind it.
        S.params = {};
        go(S.step, {});
        loadLast(d.items.map(function (it) { return it.id; })).then(function () { if (S.open) render(); });
        loadGuide(d.items[d.cur || 0].id).then(function () { if (S.open && S.step === 'log') render(); });
      } else {
        S.params = {};
        render(true);
      }
    } else {
      render();
    }
    flush();
    await loadHome();
    if (!S.home && S.homeErr) { if (S.step === 'home') render(); return; }
    if (S.home && S.home.area_counts && !getDraft() && !S.home.area_counts[S.area]) {
      var firstWith = AREAS.filter(function (a) { return S.home.area_counts[a.key] > 0; })[0];
      if (firstWith) S.area = firstWith.key;
    }
    if (S.step === 'home') render();
    await loadList(S.area);
    if (S.step === 'home') render();
    loadHistory().then(function () { if (S.step === 'home') render(); });
  }
  function close(fromPop) {
    stopTimers();
    closeDialog();
    removeBackButton();
    S.open = false;
    if (!fromPop) {
      // Drop Coach Mode's history entries so the browser back button stays sane.
      var n = S.depth + (S.base ? 1 : 0);
      if (n > 0) try { history.go(-n); } catch (e) { /* ignore */ }
    }
    S.depth = 0; S.base = false;
    if (typeof window.switchUserTab === 'function') window.switchUserTab('workout');
  }

  window.addEventListener('popstate', onPop);
  window.addEventListener('online', function () { flush(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') flush(); });
  (function () {
    var App = appPlugin();
    if (App && App.addListener) try { App.addListener('resume', function () { flush(); }); } catch (e) { /* ignore */ }
  })();

  window.bbCoach = {
    __v: 1,
    open: open,
    close: close,
    flush: flush,
    hasDraft: function () { return !!getDraft(); },
    pendingCount: function () { return myOutbox().length; },
    // test hooks
    _buildBody: buildBody,
    _setsLine: setsLine
  };
  flush();
})();
