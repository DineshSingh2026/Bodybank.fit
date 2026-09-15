/* ==========================================================================
   ADMIN . REPORTS ("bbrep") -- weekly / monthly client progress reports
   Backend: routes/reports.js mounted at /api/admin/reports (requireAdmin:
   role === 'admin' exactly, so superadmin gets a friendly notice).
   Globals used from index.html: apiCall, escapeHtml, window.currentUser, API.
   Entry point: loadAdminReports() -- called by switchTab('reports').
   ========================================================================== */
(function () {
  'use strict';

  var LIMITS = { summary: 150, closing: 650, target: 120 };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var PAGE_PX = 794; // 210mm at 96dpi

  var S = {
    built: false,
    type: 'weekly',
    client: null,
    weekStart: null,
    month: null,
    custom: false,
    clients: [],
    activeIdx: -1,
    clientReq: 0,
    clientTimer: null,
    previewReq: 0,
    preview: null,   // last preview JSON
    ctx: null,       // { userId, type, start, end, label, clientName } of the preview
    aiDraft: null,   // draft from the last fresh (non-edited) preview
    stale: false,
    dirty: false,
    busy: false,
    generated: null,
    history: [],
    historyById: {},
    historyReq: 0,
    send: {},        // containerId -> send block state
    bulkJob: null,
    bulkTimer: null,
    bulkFails: 0,
    resizeTimer: null,
    lastFrameW: 0
  };

  /* ---------------- helpers ---------------- */
  function esc(v) {
    if (typeof escapeHtml === 'function') return escapeHtml(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }
  function root() { return $('tab-reports'); }

  function dayNum(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return NaN;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  }
  function fromDay(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function addDays(ymd, d) { return fromDay(dayNum(ymd) + d); }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a) + 1; }
  function todayIST() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function thisMonday() {
    var t = todayIST();
    var dow = new Date(dayNum(t) * 86400000).getUTCDay();
    return addDays(t, -((dow + 6) % 7));
  }
  function lastCompletedWeekStart() { return addDays(thisMonday(), -7); }
  function lastCompletedMonth() {
    var p = todayIST().split('-').map(Number);
    var y = p[1] === 1 ? p[0] - 1 : p[0];
    var m = p[1] === 1 ? 12 : p[1] - 1;
    return y + '-' + (m < 10 ? '0' : '') + m;
  }
  function monthRange(ym) {
    var p = String(ym || '').split('-').map(Number);
    if (!p[0] || !p[1]) return null;
    var last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    var mm = (p[1] < 10 ? '0' : '') + p[1];
    return { start: p[0] + '-' + mm + '-01', end: p[0] + '-' + mm + '-' + (last < 10 ? '0' : '') + last };
  }
  function periodLabel(type, start, end) {
    var a = new Date(dayNum(start) * 86400000), b = new Date(dayNum(end) * 86400000);
    var whole = a.getUTCDate() === 1 && addDays(end, 1).slice(8, 10) === '01' && a.getUTCMonth() === b.getUTCMonth();
    if (type === 'monthly' && whole) return MON_LONG[a.getUTCMonth()] + ' ' + a.getUTCFullYear();
    var same = a.getUTCFullYear() === b.getUTCFullYear();
    return a.getUTCDate() + ' ' + MON[a.getUTCMonth()] + (same ? '' : ' ' + a.getUTCFullYear())
      + ' – ' + b.getUTCDate() + ' ' + MON[b.getUTCMonth()] + ' ' + b.getUTCFullYear();
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function typeName(t) { return t === 'monthly' ? 'Monthly' : 'Weekly'; }
  function gradeClass(g) {
    var s = String(g || '').toUpperCase();
    if (s === 'A+' || s === 'A') return 'is-good';
    if (s === 'B' || s === 'C') return 'is-mid';
    if (s === 'D' || s === 'E' || s === 'F') return 'is-low';
    return 'is-none';
  }
  function scoreBadge(score, grade) {
    if (score == null && !grade) return '<span class="bbrep-muted">—</span>';
    return '<span class="bbrep-score">' + (score == null ? '—' : esc(Math.round(Number(score)))) + '</span>'
      + (grade ? ' <span class="bbrep-grade ' + gradeClass(grade) + '">' + esc(grade) + '</span>' : '');
  }
  function isAdmin() { return !!(window.currentUser && window.currentUser.role === 'admin'); }
  function isForbidden(err) { return /admin access|forbidden|403|not authori[sz]ed|permission/i.test(String(err || '')); }
  function errText(data, fallback) {
    // Report-engine problems come with a plain-language hint (the error text
    // itself is redacted by the server in production).
    if (data && /^(engine_|client_timeout)/.test(String(data.code || '')) && data.hint) return data.hint;
    var e = (data && (data.error || data.message)) || fallback || 'Something went wrong';
    if (isForbidden(e)) return 'Reports are available to admin accounts only.';
    if (data && data.ref && /^Server error/.test(e)) e += ' (ref ' + data.ref + ')';
    return e;
  }

  /* Long server calls (preview / generate): live elapsed time, a hint when it
     runs long, and a hard client timeout so the screen never spins forever. */
  var LONG_NOTE_AFTER_S = 25;
  function longCall(method, url, body, label, timeoutMs) {
    var started = Date.now();
    setStatus(label + '…', 'busy');
    var tick = setInterval(function () {
      var sec = Math.round((Date.now() - started) / 1000);
      setStatus(label + '… ' + sec + ' s' + (sec >= LONG_NOTE_AFTER_S
        ? ' — the first report after a server restart prepares the PDF engine and can take about a minute'
        : ''), 'busy');
    }, 1000);
    var timer;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () {
        resolve({
          success: false,
          code: 'client_timeout',
          hint: 'This is taking much longer than expected (over ' + Math.round(timeoutMs / 1000) + ' s). The server may still be preparing the PDF engine — use "Check report engine", then try again.'
        });
      }, timeoutMs);
    });
    return Promise.race([apiCall(method, url, body), timeout]).then(function (data) {
      clearInterval(tick);
      clearTimeout(timer);
      return data;
    });
  }

  function showEngineBtn(data) {
    var b = $('bbrepEngineBtn');
    if (b) b.hidden = !(data && /^(engine_|client_timeout)/.test(String(data.code || '')));
  }

  function engineCheck() {
    var b = $('bbrepEngineBtn');
    if (b) b.disabled = true;
    setStatus('Checking the report engine (runs a one-page test print)…', 'busy');
    apiCall('GET', '/api/admin/reports/diagnostics?test=1').then(function (d) {
      if (b) b.disabled = false;
      if (!d || !d.success) { setStatus(errText(d, 'Engine check failed'), 'error'); return; }
      var eng = d.engine || {};
      var parts = ['Report engine: ' + (eng.status || 'unknown')];
      if (eng.progress && eng.status === 'installing') {
        var pr = eng.progress;
        parts.push(pr.phase === 'extracting'
          ? 'unpacking Chrome'
          : 'downloading Chrome ' + (pr.totalMb ? pr.downloadedMb + ' of ' + pr.totalMb + ' MB (' + pr.pct + '%)' : (pr.downloadedMb || 0) + ' MB'));
      }
      var bi = d.buildInstall;
      parts.push('build install: ' + (!bi ? 'no record' : (bi.ok ? bi.status : bi.status + (bi.error ? ' — ' + bi.error : ''))));
      if (d.deploy) parts.push('deploy ' + d.deploy);
      if (d.test) {
        parts.push(d.test.ok
          ? 'test print OK in ' + (Math.round(d.test.ms / 100) / 10) + ' s'
          : 'test print failed: ' + (d.test.error || d.test.code || 'unknown'));
      }
      if (eng.error) parts.push('last error: ' + eng.error);
      if (d.memoryMb) parts.push('memory ' + d.memoryMb.rss + ' MB' + (d.memoryMb.containerLimit ? ' of ' + d.memoryMb.containerLimit + ' MB' : ''));
      if (eng.lastRender && !eng.lastRender.ok) parts.push('last report failed at "' + eng.lastRender.stage + '"');
      setStatus(parts.join(' · '), d.test && d.test.ok ? 'ok' : 'error');
    });
  }
  function setStatus(msg, kind) {
    var el = $('bbrepStatus');
    if (!el) return;
    el.className = 'bbrep-status' + (kind ? ' is-' + kind : '');
    el.textContent = msg || '';
  }
  function warningText(w) {
    if (w == null) return '';
    if (typeof w === 'string') return w;
    return w.message || w.text || w.code || JSON.stringify(w);
  }

  /* ---------------- period ---------------- */
  function currentPeriod() {
    var start, end;
    if (S.custom) {
      start = ($('bbrepStart') || {}).value || '';
      end = ($('bbrepEnd') || {}).value || '';
      if (!start || !end) return { error: 'Choose a start and end date.' };
    } else if (S.type === 'weekly') {
      start = S.weekStart; end = addDays(S.weekStart, 6);
    } else {
      var r = monthRange(S.month);
      if (!r) return { error: 'Choose a month.' };
      start = r.start; end = r.end;
    }
    if (isNaN(dayNum(start)) || isNaN(dayNum(end))) return { error: 'Dates must be valid.' };
    var days = daysBetween(start, end);
    if (days < 1) return { error: 'End date must be on or after the start date.' };
    if (S.type === 'weekly' && days > 14) return { error: 'A weekly report covers at most 14 days (this range is ' + days + ').' };
    if (S.type === 'monthly' && (days < 20 || days > 35)) return { error: 'A monthly report covers 20–35 days (this range is ' + days + ').' };
    return { start: start, end: end, days: days, label: periodLabel(S.type, start, end) };
  }

  function renderPeriod() {
    var wk = $('bbrepWeekPicker'), mo = $('bbrepMonthPicker'), cu = $('bbrepCustom');
    if (!wk) return;
    wk.hidden = S.custom || S.type !== 'weekly';
    mo.hidden = S.custom || S.type !== 'monthly';
    cu.hidden = !S.custom;
    var lbl = $('bbrepWeekLabel');
    if (lbl && S.weekStart) lbl.textContent = periodLabel('weekly', S.weekStart, addDays(S.weekStart, 6));
    var next = $('bbrepWeekNext');
    if (next) next.disabled = dayNum(S.weekStart) >= dayNum(lastCompletedWeekStart());
    var mInput = $('bbrepMonth');
    if (mInput) { mInput.max = lastCompletedMonth(); if (mInput.value !== S.month) mInput.value = S.month; }
    var p = currentPeriod();
    var note = $('bbrepPeriodNote');
    if (note) {
      note.className = 'bbrep-period-note' + (p.error ? ' is-error' : '');
      note.textContent = p.error ? p.error : (p.label + ' · ' + p.days + ' day' + (p.days === 1 ? '' : 's'));
    }
    syncButtons();
  }

  function syncButtons() {
    var p = currentPeriod();
    var pv = $('bbrepPreviewBtn');
    if (pv) pv.disabled = S.busy || !S.client || !!p.error;
    var hint = $('bbrepPreviewHint');
    if (hint) {
      hint.textContent = !S.client ? 'Pick a client to preview a report.'
        : (p.error ? '' : 'Preview drafts the coach narrative with AI (3–10 s).');
    }
    var bulk = $('bbrepBulkBtn');
    if (bulk) bulk.disabled = !!p.error || !!(S.bulkJob && S.bulkJob.status === 'running');
    var gen = $('bbrepGenerateBtn');
    if (gen) gen.disabled = S.busy || !S.preview || S.stale;
    var upd = $('bbrepUpdateBtn');
    if (upd) upd.disabled = S.busy || !S.preview || S.stale;
    var rst = $('bbrepResetBtn');
    if (rst) rst.disabled = S.busy || !S.aiDraft || S.stale;
  }

  function markStale() {
    if (!S.preview) return;
    S.stale = true;
    S.generated = null;
    renderGenerated();
    renderMeta();
    syncButtons();
  }

  /* ---------------- shell ---------------- */
  function buildShell() {
    var el = root();
    if (!el) return false;
    var sum = '', tg = '';
    for (var i = 0; i < 3; i++) {
      sum += '<div class="bbrep-ed-row"><label class="bbrep-ed-lbl" for="bbrepSum' + i + '">Summary line ' + (i + 1)
        + ' <span class="bbrep-count" id="bbrepSum' + i + 'Count" aria-live="off"></span></label>'
        + '<input type="text" class="bbrep-input" id="bbrepSum' + i + '" maxlength="' + LIMITS.summary + '" data-bbrep-edit="1" data-limit="' + LIMITS.summary + '"></div>';
      tg += '<div class="bbrep-ed-row"><label class="bbrep-ed-lbl" for="bbrepTgt' + i + '">Target ' + (i + 1)
        + ' <span class="bbrep-count" id="bbrepTgt' + i + 'Count" aria-live="off"></span></label>'
        + '<input type="text" class="bbrep-input" id="bbrepTgt' + i + '" maxlength="' + LIMITS.target + '" data-bbrep-edit="1" data-limit="' + LIMITS.target + '"></div>';
    }
    el.innerHTML = ''
      + '<div class="admin-subsection-wrap bbrep">'
      + '<div class="bbrep-head">'
      + '  <div class="bbrep-head-text"><h3 class="admin-subsection-title bbrep-title">Reports</h3>'
      + '  <p class="form-hint bbrep-sub">Branded progress reports for clients — preview, edit the coach narrative, generate the PDF and send it.</p></div>'
      + '  <button type="button" class="bbrep-btn bbrep-btn-ghost" id="bbrepBulkBtn" data-bbrep-act="bulk-open">Bulk generate</button>'
      + '</div>'
      + '<div id="bbrepGate"></div>'
      + '<div class="bbrep-types" role="radiogroup" aria-label="Report type">'
      + '  <button type="button" class="bbrep-type" role="radio" data-bbrep-type="weekly"><span class="bbrep-type-ico" aria-hidden="true">&#128197;</span><span class="bbrep-type-txt"><b>Weekly report</b><small>Monday–Sunday · last completed week</small></span></button>'
      + '  <button type="button" class="bbrep-type" role="radio" data-bbrep-type="monthly"><span class="bbrep-type-ico" aria-hidden="true">&#128198;</span><span class="bbrep-type-txt"><b>Monthly report</b><small>Calendar month · last completed month</small></span></button>'
      + '</div>'
      + '<div id="bbrepBulk" class="bbrep-bulk" aria-live="polite"></div>'
      + '<div class="bbrep-card bbrep-setup">'
      + '  <div class="bbrep-field">'
      + '    <label class="bbrep-lbl" for="bbrepClientQ">Client</label>'
      + '    <div class="bbrep-ta" id="bbrepTa">'
      + '      <input type="search" class="bbrep-input" id="bbrepClientQ" placeholder="Search name, email or phone" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bbrepClientList">'
      + '      <ul class="bbrep-ta-list" id="bbrepClientList" role="listbox" aria-label="Clients" hidden></ul>'
      + '    </div>'
      + '    <div id="bbrepClientChip"></div>'
      + '    <p class="bbrep-hint">Auto: weekly report every Monday 06:00 IST and monthly on the 1st, sent by email + WhatsApp</p>'
      + '  </div>'
      + '  <div class="bbrep-field">'
      + '    <span class="bbrep-lbl" id="bbrepPeriodLbl">Period</span>'
      + '    <div class="bbrep-week" id="bbrepWeekPicker" role="group" aria-labelledby="bbrepPeriodLbl">'
      + '      <button type="button" class="bbrep-arrow" id="bbrepWeekPrev" data-bbrep-act="week-prev" aria-label="Previous week">&#8249;</button>'
      + '      <span class="bbrep-week-lbl" id="bbrepWeekLabel" aria-live="polite"></span>'
      + '      <button type="button" class="bbrep-arrow" id="bbrepWeekNext" data-bbrep-act="week-next" aria-label="Next week">&#8250;</button>'
      + '    </div>'
      + '    <div id="bbrepMonthPicker" hidden><input type="month" class="bbrep-input" id="bbrepMonth" aria-label="Report month"></div>'
      + '    <label class="bbrep-check"><input type="checkbox" id="bbrepCustomToggle"> Custom range</label>'
      + '    <div class="bbrep-custom" id="bbrepCustom" hidden>'
      + '      <label class="bbrep-mini">Start<input type="date" class="bbrep-input" id="bbrepStart"></label>'
      + '      <label class="bbrep-mini">End<input type="date" class="bbrep-input" id="bbrepEnd"></label>'
      + '    </div>'
      + '    <p class="bbrep-period-note" id="bbrepPeriodNote" aria-live="polite"></p>'
      + '  </div>'
      + '  <div class="bbrep-setup-actions">'
      + '    <button type="button" class="bbrep-btn bbrep-btn-primary" id="bbrepPreviewBtn" data-bbrep-act="preview">Preview</button>'
      + '    <span class="bbrep-hint" id="bbrepPreviewHint"></span>'
      + '    <span class="bbrep-status" id="bbrepStatus" role="status" aria-live="polite"></span>'
      + '    <button type="button" class="bbrep-btn bbrep-btn-sm bbrep-btn-ghost" id="bbrepEngineBtn" data-bbrep-act="engine-check" hidden>Check report engine</button>'
      + '  </div>'
      + '</div>'
      + '<div class="bbrep-work" id="bbrepWork" hidden>'
      + '  <div class="bbrep-col bbrep-col-preview">'
      + '    <div class="bbrep-meta" id="bbrepMeta"></div>'
      + '    <div class="bbrep-frame-wrap" id="bbrepFrameWrap">'
      + '      <iframe id="bbrepFrame" class="bbrep-frame" sandbox="allow-same-origin" title="Report preview"></iframe>'
      + '      <div class="bbrep-frame-loading" id="bbrepFrameLoading" hidden><span class="bbrep-spin" aria-hidden="true"></span><span>Building preview…</span></div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="bbrep-col bbrep-col-editor">'
      + '    <div class="bbrep-card">'
      + '      <h4 class="bbrep-h4">Coach narrative</h4>'
      + '      <p class="bbrep-hint" id="bbrepDirty" aria-live="polite"></p>'
      + '      <fieldset class="bbrep-fs"><legend class="bbrep-legend">Summary (3 lines)</legend>' + sum + '</fieldset>'
      + '      <fieldset class="bbrep-fs"><legend class="bbrep-legend">Closing coach note</legend>'
      + '        <div class="bbrep-ed-row"><label class="bbrep-ed-lbl" for="bbrepClosing">Note <span class="bbrep-count" id="bbrepClosingCount"></span></label>'
      + '        <textarea class="bbrep-input bbrep-textarea" id="bbrepClosing" rows="6" maxlength="' + LIMITS.closing + '" data-bbrep-edit="1" data-limit="' + LIMITS.closing + '"></textarea></div>'
      + '      </fieldset>'
      + '      <fieldset class="bbrep-fs"><legend class="bbrep-legend">Targets (3)</legend>' + tg + '</fieldset>'
      + '      <div class="bbrep-ed-actions">'
      + '        <button type="button" class="bbrep-btn" id="bbrepUpdateBtn" data-bbrep-act="update">Update preview</button>'
      + '        <button type="button" class="bbrep-btn bbrep-btn-ghost" id="bbrepResetBtn" data-bbrep-act="reset">Reset to AI draft</button>'
      + '      </div>'
      + '      <p class="bbrep-hint">Update preview re-renders with your edits — no AI cost.</p>'
      + '    </div>'
      + '    <div class="bbrep-card">'
      + '      <button type="button" class="bbrep-btn bbrep-btn-primary bbrep-btn-block" id="bbrepGenerateBtn" data-bbrep-act="generate">Generate PDF</button>'
      + '      <div id="bbrepGenerated" aria-live="polite"></div>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '<div class="bbrep-history">'
      + '  <div class="bbrep-hist-head"><h4 class="bbrep-h4">History <span class="bbrep-muted" id="bbrepHistScope"></span></h4>'
      + '  <button type="button" class="bbrep-btn bbrep-btn-ghost bbrep-btn-sm" data-bbrep-act="history-refresh">Refresh</button></div>'
      + '  <div id="bbrepHistSend" aria-live="polite"></div>'
      + '  <div id="bbrepHistory"></div>'
      + '</div>'
      + '</div>';

    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('mousedown', onMousedown);
    var q = $('bbrepClientQ');
    q.addEventListener('focus', function () { queueClientSearch(0); });
    q.addEventListener('blur', function () { setTimeout(closeList, 120); });
    $('bbrepFrame').addEventListener('load', function () { scaleFrame(true); });
    window.addEventListener('resize', function () {
      clearTimeout(S.resizeTimer);
      S.resizeTimer = setTimeout(function () { scaleFrame(false); }, 120);
    });
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(function () { requestAnimationFrame(function () { scaleFrame(false); }); }).observe($('bbrepFrameWrap')); } catch (e) { /* ignore */ }
    }
    S.built = true;
    return true;
  }

  function renderTypes() {
    var btns = root().querySelectorAll('[data-bbrep-type]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-bbrep-type') === S.type;
      btns[i].classList.toggle('is-active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      btns[i].tabIndex = on ? 0 : -1;
    }
  }

  /* ---------------- client typeahead ---------------- */
  function queueClientSearch(delay) {
    clearTimeout(S.clientTimer);
    S.searchPending = true;
    S.clientTimer = setTimeout(searchClients, delay == null ? 250 : delay);
  }
  function searchClients() {
    var input = $('bbrepClientQ');
    S.searchPending = false;
    if (!input || document.activeElement !== input) { S.enterQueued = false; return; }
    var q = input.value.trim();
    var req = ++S.clientReq;
    var list = $('bbrepClientList');
    list.innerHTML = '<li class="bbrep-ta-empty">Searching…</li>';
    openList();
    apiCall('GET', '/api/admin/reports/clients?q=' + encodeURIComponent(q) + '&limit=14').then(function (data) {
      if (req !== S.clientReq) return;
      if (!data || !data.success) {
        S.clients = [];
        list.innerHTML = '<li class="bbrep-ta-empty is-error">' + esc(errText(data, 'Could not load clients')) + '</li>';
        return;
      }
      S.clients = (data.clients || []).slice(0, 14);
      S.activeIdx = S.clients.length ? 0 : -1;
      S.shownReq = req;
      renderClientList();
      // Enter pressed while this search was still on its way: apply it to these
      // results, never to the stale list that was on screen at the time.
      if (S.enterQueued) {
        S.enterQueued = false;
        if (S.activeIdx >= 0) selectClient(S.activeIdx);
      }
    });
  }
  function renderClientList() {
    var list = $('bbrepClientList');
    if (!S.clients.length) {
      list.innerHTML = '<li class="bbrep-ta-empty">No active clients match.</li>';
      $('bbrepClientQ').removeAttribute('aria-activedescendant');
      return;
    }
    list.innerHTML = S.clients.map(function (c, i) {
      return '<li class="bbrep-ta-opt' + (i === S.activeIdx ? ' is-active' : '') + '" role="option" id="bbrepOpt' + i + '" data-idx="' + i + '" aria-selected="' + (i === S.activeIdx) + '">'
        + '<span class="bbrep-ta-name">' + esc(c.name || 'Unnamed') + (c.autoReports ? ' <span class="bbrep-pill">Auto</span>' : '') + '</span>'
        + '<span class="bbrep-ta-mail">' + esc(c.email || c.phone || '') + '</span></li>';
    }).join('');
    var q = $('bbrepClientQ');
    if (S.activeIdx >= 0) q.setAttribute('aria-activedescendant', 'bbrepOpt' + S.activeIdx);
    var act = $('bbrepOpt' + S.activeIdx);
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  }
  function openList() { var l = $('bbrepClientList'); if (l) { l.hidden = false; $('bbrepClientQ').setAttribute('aria-expanded', 'true'); } }
  function closeList() {
    var l = $('bbrepClientList');
    if (l) { l.hidden = true; $('bbrepClientQ').setAttribute('aria-expanded', 'false'); $('bbrepClientQ').removeAttribute('aria-activedescendant'); }
  }
  function selectClient(idx) {
    var c = S.clients[idx];
    if (!c) return;
    var changed = !S.client || S.client.id !== c.id;
    S.client = c;
    $('bbrepClientQ').value = '';
    closeList();
    renderChip();
    if (changed) { markStale(); loadHistory(); }
    syncButtons();
  }
  function renderChip() {
    var el = $('bbrepClientChip');
    var ta = $('bbrepTa');
    if (!S.client) { el.innerHTML = ''; ta.hidden = false; return; }
    ta.hidden = true;
    var c = S.client;
    el.innerHTML = '<div class="bbrep-chip">'
      + '<div class="bbrep-chip-main"><b>' + esc(c.name || 'Unnamed') + '</b><span>' + esc([c.email, c.phone].filter(Boolean).join(' · ')) + '</span>'
      + (c.lastReportAt ? '<span class="bbrep-muted">Last report ' + esc(fmtDateTime(c.lastReportAt)) + '</span>' : '') + '</div>'
      + '<div class="bbrep-chip-side">'
      + '<button type="button" class="bbrep-switch' + (c.autoReports ? ' is-on' : '') + '" role="switch" aria-checked="' + (c.autoReports ? 'true' : 'false') + '" data-bbrep-act="auto-toggle"><span class="bbrep-switch-track" aria-hidden="true"><span class="bbrep-switch-dot"></span></span>Auto reports</button>'
      + '<button type="button" class="bbrep-chip-x" data-bbrep-act="client-clear" aria-label="Change client">&times;</button>'
      + '</div></div>';
  }
  function toggleAuto() {
    if (!S.client) return;
    var c = S.client, next = !c.autoReports;
    c.autoReports = next;
    renderChip();
    apiCall('PUT', '/api/admin/reports/clients/' + encodeURIComponent(c.id) + '/auto', { enabled: next }).then(function (data) {
      if (!data || !data.success) {
        c.autoReports = !next;
        if (S.client === c) renderChip();
        setStatus(errText(data, 'Could not update auto reports'), 'error');
        return;
      }
      c.autoReports = !!data.autoReports;
      if (S.client === c) renderChip();
      setStatus('Auto reports ' + (c.autoReports ? 'on' : 'off') + ' for ' + (c.name || 'client') + '.', 'ok');
    });
  }

  /* ---------------- editor ---------------- */
  function readEdits() {
    var summary = [], targets = [];
    for (var i = 0; i < 3; i++) {
      summary.push(($('bbrepSum' + i).value || '').trim().slice(0, LIMITS.summary));
      targets.push(($('bbrepTgt' + i).value || '').trim().slice(0, LIMITS.target));
    }
    return { summary: summary, closingNote: ($('bbrepClosing').value || '').trim().slice(0, LIMITS.closing), targets: targets };
  }
  function fillEditor(d) {
    d = d || {};
    for (var i = 0; i < 3; i++) {
      $('bbrepSum' + i).value = ((d.summary || [])[i] || '').slice(0, LIMITS.summary);
      $('bbrepTgt' + i).value = ((d.targets || [])[i] || '').slice(0, LIMITS.target);
    }
    $('bbrepClosing').value = String(d.closingNote || '').slice(0, LIMITS.closing);
    updateCounters();
  }
  function updateCounter(input) {
    var c = $(input.id + 'Count');
    if (!c) return;
    var lim = Number(input.getAttribute('data-limit')) || 0, n = input.value.length;
    c.textContent = n + '/' + lim;
    c.className = 'bbrep-count' + (n >= lim ? ' is-max' : (n >= lim * 0.9 ? ' is-near' : ''));
  }
  function updateCounters() {
    var inputs = root().querySelectorAll('[data-bbrep-edit]');
    for (var i = 0; i < inputs.length; i++) updateCounter(inputs[i]);
  }
  function setDirty(on) {
    S.dirty = on;
    var el = $('bbrepDirty');
    if (el) el.textContent = on ? 'You have edits not yet shown in the preview — Update preview to see them.' : '';
  }

  /* ---------------- preview ---------------- */
  function doPreview(withEdits) {
    var p = currentPeriod();
    var body;
    if (withEdits) {
      if (!S.ctx) return;
      body = { userId: S.ctx.userId, type: S.ctx.type, startDate: S.ctx.start, endDate: S.ctx.end, edits: readEdits() };
    } else {
      if (!S.client || p.error) return;
      body = { userId: S.client.id, type: S.type, startDate: p.start, endDate: p.end };
    }
    var req = ++S.previewReq;
    S.busy = true;
    syncButtons();
    $('bbrepWork').hidden = false;
    $('bbrepFrameLoading').hidden = false;
    var ctx = withEdits ? S.ctx : { userId: S.client.id, type: S.type, start: p.start, end: p.end, label: p.label, clientName: S.client.name || '' };
    showEngineBtn(null);
    longCall('POST', '/api/admin/reports/preview?format=json', body, withEdits ? 'Updating preview' : 'Building preview', 150000).then(function (data) {
      if (req !== S.previewReq) return;
      S.busy = false;
      $('bbrepFrameLoading').hidden = true;
      if (!data || !data.success) {
        setStatus(errText(data, 'Preview failed'), 'error');
        showEngineBtn(data);
        if (!S.preview) $('bbrepWork').hidden = true;
        syncButtons();
        return;
      }
      S.preview = data;
      S.ctx = ctx;
      if (data.period && data.period.label) S.ctx.label = data.period.label;
      if (data.client && data.client.name) S.ctx.clientName = data.client.name;
      S.stale = false;
      S.generated = null;
      if (!withEdits) {
        S.aiDraft = data.draft || null;
        fillEditor(data.draft);
      }
      setDirty(false);
      $('bbrepFrame').srcdoc = data.html || '<p style="font-family:sans-serif;padding:20px">Empty preview.</p>';
      renderMeta();
      renderGenerated();
      setStatus('Preview ready' + (data.ms ? ' in ' + (Math.round(data.ms / 100) / 10) + ' s' : '') + '.', 'ok');
      syncButtons();
    });
  }

  function renderMeta() {
    var el = $('bbrepMeta');
    if (!el) return;
    var d = S.preview;
    if (!d) { el.innerHTML = ''; return; }
    var draft = d.draft || {};
    var src = draft.source === 'ai'
      ? '<span class="bbrep-chipsm is-ai">AI narrative</span>'
      : '<span class="bbrep-chipsm is-rules"' + (draft.aiError ? ' title="' + esc(draft.aiError) + '"' : '') + '>Rules narrative' + (draft.aiError ? ' (AI unavailable)' : '') + '</span>';
    var warns = (d.warnings || []).map(warningText).filter(Boolean);
    el.innerHTML = '<div class="bbrep-meta-top">'
      + '<div class="bbrep-meta-who"><b>' + esc((S.ctx && S.ctx.clientName) || '') + '</b><span>' + esc(typeName(S.ctx && S.ctx.type)) + ' · ' + esc((S.ctx && S.ctx.label) || '') + '</span></div>'
      + '<div class="bbrep-meta-chips">' + scoreBadge(d.score, d.grade)
      + '<span class="bbrep-chipsm">' + esc(d.pages || 0) + ' page' + (d.pages === 1 ? '' : 's') + '</span>' + src + '</div></div>'
      + (S.stale ? '<p class="bbrep-banner is-warn">Client or period changed — press Preview to rebuild before generating.</p>' : '')
      + (warns.length ? '<ul class="bbrep-warns">' + warns.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '');
  }

  // force=false (resize/observer): only re-scale when the panel WIDTH changed,
  // so setting the iframe height cannot feed back into the observer.
  function scaleFrame(force) {
    var frame = $('bbrepFrame'), wrap = $('bbrepFrameWrap');
    if (!frame || !wrap || $('bbrepWork').hidden) return;
    var w = wrap.clientWidth;
    if (!w) return;
    if (force !== true && w === S.lastFrameW) return;
    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body) return;
    var z = Math.min(1.5, w / PAGE_PX);
    // Measure the content at zoom 1, then scale the number ourselves: browsers
    // disagree on whether scrollHeight inside a zoomed body is zoomed, and the
    // root's scrollHeight never drops below the iframe's current height.
    doc.documentElement.style.overflow = 'hidden';
    doc.body.style.zoom = '1';
    var h = Math.max(doc.body.scrollHeight, doc.body.offsetHeight);
    doc.body.style.zoom = String(z);
    frame.style.height = Math.ceil(h * z) + 'px';
    S.lastFrameW = w;
  }

  /* ---------------- generate + file actions ---------------- */
  function doGenerate() {
    if (!S.ctx || S.stale || S.busy) return;
    S.busy = true;
    syncButtons();
    var el = $('bbrepGenerated');
    el.innerHTML = '<p class="bbrep-loading"><span class="bbrep-spin" aria-hidden="true"></span> Generating PDF…</p>';
    var body = { userId: S.ctx.userId, type: S.ctx.type, startDate: S.ctx.start, endDate: S.ctx.end, edits: readEdits() };
    showEngineBtn(null);
    longCall('POST', '/api/admin/reports/generate', body, 'Generating PDF', 180000).then(function (data) {
      S.busy = false;
      if (!data || !data.success) {
        el.innerHTML = '<p class="bbrep-banner is-error">' + esc(errText(data, 'Report generation failed')) + '</p>';
        setStatus(errText(data, 'Report generation failed'), 'error');
        showEngineBtn(data);
        // A generate that outlived the client timeout may still finish on the server.
        if (data && data.code === 'client_timeout') setTimeout(loadHistory, 45000);
        syncButtons();
        return;
      }
      S.generated = {
        reportId: data.reportId, url: data.url, score: data.score, grade: data.grade, pages: data.pages,
        warnings: data.warnings, clientName: S.ctx.clientName, label: S.ctx.label, type: S.ctx.type, start: S.ctx.start
      };
      delete S.send.bbrepGenSend;
      renderGenerated();
      setStatus('PDF generated.', 'ok');
      syncButtons();
      loadHistory();
    });
  }

  function renderGenerated() {
    var el = $('bbrepGenerated');
    if (!el) return;
    var g = S.generated;
    if (!g) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="bbrep-gen">'
      + '<p class="bbrep-gen-ok">PDF ready · ' + scoreBadge(g.score, g.grade) + ' · ' + esc(g.pages || 0) + ' pages</p>'
      + '<div class="bbrep-btnrow">'
      + '<button type="button" class="bbrep-btn" data-bbrep-act="download" data-id="' + esc(g.reportId) + '">Download PDF</button>'
      + '<button type="button" class="bbrep-btn bbrep-btn-ghost" data-bbrep-act="open" data-id="' + esc(g.reportId) + '">Open</button>'
      + '</div>'
      + '<div id="bbrepGenSend"></div>'
      + '</div>';
    openSend('bbrepGenSend', { reportId: g.reportId, clientName: g.clientName, label: g.label, type: g.type }, true);
  }

  function pdfFetch(id, inline) {
    var url = apiBase() + '/api/admin/reports/' + encodeURIComponent(id) + '/pdf' + (inline ? '?inline=1' : '');
    var token = window.currentUser && window.currentUser.token;
    return fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(errText(j, 'PDF not available (' + r.status + ')'));
        });
      }
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="?([^";]+)"?/i.exec(cd);
      return r.blob().then(function (b) { return { blob: b, name: m ? m[1] : 'BodyBank_Report.pdf' }; });
    });
  }
  function fileError(err) {
    var msg = (err && err.message) || 'PDF not available.';
    if (typeof showPopup === 'function') showPopup('Report PDF', msg, '', 'OK', null, 'error');
    else setStatus(msg, 'error');
  }
  function downloadPdf(id) {
    setStatus('Preparing download…', 'busy');
    pdfFetch(id, false).then(function (f) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(f.blob);
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      setStatus('Downloaded.', 'ok');
    }).catch(function (e) { setStatus('', ''); fileError(e); });
  }
  function openPdf(id) {
    var win = null;
    try { win = window.open('', '_blank'); } catch (e) { win = null; }
    setStatus('Opening PDF…', 'busy');
    pdfFetch(id, true).then(function (f) {
      var u = URL.createObjectURL(new Blob([f.blob], { type: 'application/pdf' }));
      if (win && !win.closed) { win.location.href = u; }
      else {
        var a = document.createElement('a');
        a.href = u; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
      setStatus('', '');
    }).catch(function (e) {
      if (win && !win.closed) win.close();
      setStatus('', '');
      fileError(e);
    });
  }

  /* ---------------- send ---------------- */
  // stage: choose -> confirm -> sending -> done
  function openSend(containerId, info, embedded) {
    S.send[containerId] = S.send[containerId] && S.send[containerId].reportId === info.reportId
      ? S.send[containerId]
      : { reportId: info.reportId, clientName: info.clientName, label: info.label, type: info.type, email: true, whatsapp: true, stage: 'choose', results: null, embedded: !!embedded };
    renderSend(containerId);
  }
  function renderSend(cid) {
    var el = $(cid), st = S.send[cid];
    if (!el || !st) return;
    var chans = [];
    if (st.email) chans.push('Email');
    if (st.whatsapp) chans.push('WhatsApp');
    var head = st.embedded ? '<h5 class="bbrep-h5">Send to client</h5>'
      : '<div class="bbrep-send-head"><h5 class="bbrep-h5">Send ' + esc(typeName(st.type)) + ' report · ' + esc(st.label || '') + '</h5>'
        + '<button type="button" class="bbrep-chip-x" data-bbrep-act="send-close" data-cid="' + cid + '" aria-label="Close">&times;</button></div>';
    var html = '<div class="bbrep-send' + (st.embedded ? '' : ' bbrep-card') + '">' + head;
    if (st.stage === 'choose') {
      html += '<div class="bbrep-send-opts" role="group" aria-label="Channels">'
        + '<label class="bbrep-check"><input type="checkbox" data-bbrep-chan="email" data-cid="' + cid + '"' + (st.email ? ' checked' : '') + '> Email</label>'
        + '<label class="bbrep-check"><input type="checkbox" data-bbrep-chan="whatsapp" data-cid="' + cid + '"' + (st.whatsapp ? ' checked' : '') + '> WhatsApp</label>'
        + '</div>'
        + '<button type="button" class="bbrep-btn" data-bbrep-act="send-ask" data-cid="' + cid + '"' + (chans.length ? '' : ' disabled') + '>Send…</button>';
    } else if (st.stage === 'confirm') {
      html += '<p class="bbrep-confirm">Send this report to <b>' + esc(st.clientName || 'this client') + '</b> by ' + esc(chans.join(' + ')) + '?</p>'
        + '<div class="bbrep-btnrow">'
        + '<button type="button" class="bbrep-btn bbrep-btn-primary" data-bbrep-act="send-go" data-cid="' + cid + '">Confirm send</button>'
        + '<button type="button" class="bbrep-btn bbrep-btn-ghost" data-bbrep-act="send-cancel" data-cid="' + cid + '">Cancel</button></div>';
    } else if (st.stage === 'sending') {
      html += '<p class="bbrep-loading"><span class="bbrep-spin" aria-hidden="true"></span> Sending to ' + esc(st.clientName || 'client') + '…</p>';
    } else {
      var r = st.results || {};
      var rows = Object.keys(r).map(function (k) {
        var x = r[k] || {};
        var name = k === 'whatsapp' ? 'WhatsApp' : (k === 'email' ? 'Email' : k);
        var reason = x.reason ? String(x.reason).replace(/_/g, ' ') : '';
        return '<li class="' + (x.ok ? 'is-ok' : 'is-fail') + '"><b>' + esc(name) + '</b> ' + (x.ok ? 'sent' : 'failed' + (reason ? ' — ' + esc(reason) : '')) + '</li>';
      }).join('');
      html += (st.error ? '<p class="bbrep-banner is-error">' + esc(st.error) + '</p>' : '')
        + (rows ? '<ul class="bbrep-results">' + rows + '</ul>' : '')
        + '<button type="button" class="bbrep-btn bbrep-btn-ghost bbrep-btn-sm" data-bbrep-act="send-cancel" data-cid="' + cid + '">Send again</button>';
    }
    el.innerHTML = html + '</div>';
  }
  function sendGo(cid) {
    var st = S.send[cid];
    if (!st) return;
    var channels = [];
    if (st.email) channels.push('email');
    if (st.whatsapp) channels.push('whatsapp');
    if (!channels.length) return;
    st.stage = 'sending';
    renderSend(cid);
    apiCall('POST', '/api/admin/reports/' + encodeURIComponent(st.reportId) + '/send', { channels: channels }).then(function (data) {
      st.stage = 'done';
      st.results = (data && data.results) || null;
      st.error = (data && data.success) ? '' : errText(data, 'Send failed');
      if (st.results && st.error === 'No channel could be delivered') st.error = 'No channel could be delivered.';
      renderSend(cid);
      loadHistory();
    });
  }

  /* ---------------- history ---------------- */
  function loadHistory() {
    var el = $('bbrepHistory');
    if (!el) return;
    var req = ++S.historyReq;
    var scope = $('bbrepHistScope');
    if (scope) scope.textContent = S.client ? '· ' + (S.client.name || 'client') : '· all clients';
    if (!S.history.length) el.innerHTML = '<p class="bbrep-empty">Loading reports…</p>';
    var url = '/api/admin/reports?limit=50' + (S.client ? '&userId=' + encodeURIComponent(S.client.id) : '');
    apiCall('GET', url).then(function (data) {
      if (req !== S.historyReq) return;
      if (!data || !data.success) {
        el.innerHTML = '<p class="bbrep-empty is-error">' + esc(errText(data, 'Could not load reports')) + '</p>';
        return;
      }
      S.history = data.reports || [];
      S.historyById = {};
      S.history.forEach(function (r) { S.historyById[r.id] = r; });
      renderHistory();
    });
  }
  function renderHistory() {
    var el = $('bbrepHistory');
    if (!S.history.length) {
      el.innerHTML = '<p class="bbrep-empty">' + (S.client ? 'No reports for ' + esc(S.client.name || 'this client') + ' yet.' : 'No reports generated yet.') + '</p>';
      return;
    }
    var showClient = !S.client;
    var rows = S.history.map(function (r) {
      var sent = (r.sentChannels && r.sentChannels.length)
        ? '<span class="bbrep-sent">' + esc(r.sentChannels.map(function (c) { return c === 'whatsapp' ? 'WhatsApp' : (c === 'email' ? 'Email' : c); }).join(' · ')) + '</span>'
          + (r.sentAt ? '<br><span class="bbrep-muted">' + esc(fmtDateTime(r.sentAt)) + '</span>' : '')
        : '<span class="bbrep-muted">Not sent</span>';
      var period = (r.periodStart && r.periodEnd) ? periodLabel(r.type, r.periodStart, r.periodEnd) : '';
      return '<tr>'
        + '<td data-label="Date">' + esc(fmtDateTime(r.generatedAt)) + (r.source && r.source !== 'manual' ? ' <span class="bbrep-chipsm">' + esc(r.source) + '</span>' : '') + '</td>'
        + (showClient ? '<td data-label="Client">' + esc(r.clientName || '—') + '</td>' : '')
        + '<td data-label="Type">' + esc(typeName(r.type)) + (period ? '<br><span class="bbrep-muted">' + esc(period) + '</span>' : '') + '</td>'
        + '<td data-label="Score">' + scoreBadge(r.score, r.grade) + '</td>'
        + '<td data-label="Sent">' + sent + '</td>'
        + '<td data-label="Actions"><div class="bbrep-btnrow">'
        + '<button type="button" class="bbrep-btn bbrep-btn-sm bbrep-btn-ghost" data-bbrep-act="open" data-id="' + esc(r.id) + '">Open</button>'
        + '<button type="button" class="bbrep-btn bbrep-btn-sm bbrep-btn-ghost" data-bbrep-act="download" data-id="' + esc(r.id) + '">Download</button>'
        + '<button type="button" class="bbrep-btn bbrep-btn-sm" data-bbrep-act="hist-send" data-id="' + esc(r.id) + '">Send</button>'
        + '</div></td></tr>';
    }).join('');
    el.innerHTML = '<div class="admin-table-wrap"><table class="admin-table bbrep-table"><thead><tr>'
      + '<th>Date</th>' + (showClient ? '<th>Client</th>' : '') + '<th>Type</th><th>Score</th><th>Sent</th><th>Actions</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* ---------------- bulk ---------------- */
  function renderBulkConfirm() {
    var el = $('bbrepBulk');
    var p = currentPeriod();
    if (p.error) { el.innerHTML = '<p class="bbrep-banner is-error">' + esc(p.error) + '</p>'; return; }
    el.innerHTML = '<div class="bbrep-card bbrep-bulk-card" role="dialog" aria-label="Bulk generate">'
      + '<h4 class="bbrep-h4">Bulk generate ' + esc(typeName(S.type).toLowerCase()) + ' reports</h4>'
      + '<p class="bbrep-confirm">Generate a ' + esc(typeName(S.type).toLowerCase()) + ' report for <b>' + esc(p.label) + '</b> for every active client. Reports are generated only — nothing is sent.</p>'
      + '<label class="bbrep-check"><input type="checkbox" id="bbrepBulkOnlyAuto"> Only clients with Auto reports on</label>'
      + '<div class="bbrep-btnrow">'
      + '<button type="button" class="bbrep-btn bbrep-btn-primary" data-bbrep-act="bulk-go">Start bulk generate</button>'
      + '<button type="button" class="bbrep-btn bbrep-btn-ghost" data-bbrep-act="bulk-close">Cancel</button></div></div>';
  }
  function bulkGo() {
    var p = currentPeriod();
    if (p.error) return;
    var onlyAuto = !!($('bbrepBulkOnlyAuto') && $('bbrepBulkOnlyAuto').checked);
    $('bbrepBulk').innerHTML = '<div class="bbrep-card"><p class="bbrep-loading"><span class="bbrep-spin" aria-hidden="true"></span> Starting bulk job…</p></div>';
    apiCall('POST', '/api/admin/reports/bulk', { type: S.type, period: { start: p.start, end: p.end }, onlyAuto: onlyAuto }).then(function (data) {
      if (data && data.jobId) {
        S.bulkJob = { jobId: data.jobId, status: data.status || 'running', total: data.total || 0, done: data.done || 0, failed: data.failed || 0, progressPct: data.progressPct || 0, results: [], label: p.label, type: S.type, note: data.success ? '' : 'A bulk job is already running — showing its progress.' };
        S.bulkFails = 0;
        renderBulkProgress();
        syncButtons();
        clearTimeout(S.bulkTimer);
        S.bulkTimer = setTimeout(pollBulk, 2000);
        return;
      }
      $('bbrepBulk').innerHTML = '<p class="bbrep-banner is-error">' + esc(errText(data, 'Bulk generation failed')) + ' <button type="button" class="bbrep-btn bbrep-btn-sm bbrep-btn-ghost" data-bbrep-act="bulk-close">Dismiss</button></p>';
    });
  }
  function pollBulk() {
    var job = S.bulkJob;
    if (!job) return;
    apiCall('GET', '/api/admin/reports/bulk/' + encodeURIComponent(job.jobId)).then(function (data) {
      if (S.bulkJob !== job) return;
      if (!data || !data.success) {
        S.bulkFails++;
        if (S.bulkFails >= 5 || /not found/i.test((data && data.error) || '')) {
          job.status = 'error';
          job.note = errText(data, 'Lost track of the bulk job');
          renderBulkProgress();
          syncButtons();
          return;
        }
        S.bulkTimer = setTimeout(pollBulk, 2000);
        return;
      }
      S.bulkFails = 0;
      ['status', 'total', 'done', 'failed', 'progressPct', 'results'].forEach(function (k) { if (data[k] !== undefined) job[k] = data[k]; });
      if (job.status === 'running') job.note = job.note && /already running/.test(job.note) ? job.note : '';
      renderBulkProgress();
      if (job.status === 'running') S.bulkTimer = setTimeout(pollBulk, 2000);
      else { syncButtons(); loadHistory(); }
    });
  }
  function renderBulkProgress() {
    var job = S.bulkJob, el = $('bbrepBulk');
    if (!job || !el) return;
    var pct = Math.max(0, Math.min(100, Math.round(Number(job.progressPct) || (job.total ? ((job.done + job.failed) / job.total) * 100 : 0))));
    var running = job.status === 'running';
    var fails = (job.results || []).filter(function (r) { return r && !r.ok; });
    var title = running ? 'Bulk generate running' : (job.status === 'done' ? 'Bulk generate finished' : 'Bulk generate stopped');
    el.innerHTML = '<div class="bbrep-card bbrep-bulk-card">'
      + '<div class="bbrep-send-head"><h4 class="bbrep-h4">' + esc(title) + (job.label ? ' · ' + esc(job.label) : '') + '</h4>'
      + (running ? '' : '<button type="button" class="bbrep-chip-x" data-bbrep-act="bulk-dismiss" aria-label="Dismiss">&times;</button>') + '</div>'
      + (job.note ? '<p class="bbrep-hint">' + esc(job.note) + '</p>' : '')
      + '<div class="bbrep-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Bulk progress"><span style="width:' + pct + '%"></span></div>'
      + '<p class="bbrep-progress-txt">' + esc(job.done || 0) + ' done · ' + esc(job.failed || 0) + ' failed · ' + esc(job.total || 0) + ' total · ' + pct + '%</p>'
      + (fails.length ? '<h5 class="bbrep-h5">Failures</h5><ul class="bbrep-results">' + fails.map(function (f) {
        return '<li class="is-fail"><b>' + esc(f.name || 'Client') + '</b> — ' + esc(f.error || 'failed') + '</li>';
      }).join('') + '</ul>' : (!running && job.status === 'done' ? '<p class="bbrep-gen-ok">All reports generated.</p>' : ''))
      + '</div>';
  }

  /* ---------------- events ---------------- */
  function onMousedown(e) {
    var opt = e.target.closest && e.target.closest('.bbrep-ta-opt');
    if (opt) { e.preventDefault(); selectClient(Number(opt.getAttribute('data-idx'))); }
  }
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-bbrep-type],[data-bbrep-act]') : null;
    if (!t || !root().contains(t)) return;
    var type = t.getAttribute('data-bbrep-type');
    if (type) { setType(type); return; }
    var act = t.getAttribute('data-bbrep-act'), id = t.getAttribute('data-id'), cid = t.getAttribute('data-cid');
    switch (act) {
      case 'week-prev': S.weekStart = addDays(S.weekStart, -7); markStale(); renderPeriod(); break;
      case 'week-next':
        if (dayNum(S.weekStart) < dayNum(lastCompletedWeekStart())) { S.weekStart = addDays(S.weekStart, 7); markStale(); renderPeriod(); }
        break;
      case 'preview': doPreview(false); break;
      case 'update': doPreview(true); break;
      case 'reset':
        if (S.aiDraft) { fillEditor(S.aiDraft); doPreview(true); }
        break;
      case 'generate': doGenerate(); break;
      case 'download': if (id) downloadPdf(id); break;
      case 'open': if (id) openPdf(id); break;
      case 'auto-toggle': toggleAuto(); break;
      case 'client-clear':
        S.client = null; renderChip(); markStale(); loadHistory(); syncButtons();
        setTimeout(function () { var q = $('bbrepClientQ'); if (q) q.focus(); }, 0);
        break;
      case 'send-ask': if (S.send[cid]) { S.send[cid].stage = 'confirm'; renderSend(cid); } break;
      case 'send-cancel': if (S.send[cid]) { S.send[cid].stage = 'choose'; S.send[cid].results = null; S.send[cid].error = ''; renderSend(cid); } break;
      case 'send-go': sendGo(cid); break;
      case 'send-close': delete S.send[cid]; $(cid).innerHTML = ''; break;
      case 'hist-send': {
        var r = S.historyById[id];
        if (!r) break;
        delete S.send.bbrepHistSend;
        openSend('bbrepHistSend', { reportId: r.id, clientName: r.clientName || (S.client && S.client.name) || '', type: r.type, label: (r.periodStart && r.periodEnd) ? periodLabel(r.type, r.periodStart, r.periodEnd) : '' }, false);
        var box = $('bbrepHistSend');
        if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        break;
      }
      case 'history-refresh': loadHistory(); break;
      case 'engine-check': engineCheck(); break;
      case 'bulk-open': renderBulkConfirm(); break;
      case 'bulk-close': $('bbrepBulk').innerHTML = ''; break;
      case 'bulk-go': bulkGo(); break;
      case 'bulk-dismiss': S.bulkJob = null; $('bbrepBulk').innerHTML = ''; syncButtons(); break;
    }
  }
  function setType(type) {
    if (type !== 'weekly' && type !== 'monthly') return;
    if (S.type === type) return;
    S.type = type;
    if (S.custom) {
      var p = type === 'weekly' ? { start: S.weekStart, end: addDays(S.weekStart, 6) } : monthRange(S.month);
      $('bbrepStart').value = p.start; $('bbrepEnd').value = p.end;
    }
    renderTypes();
    markStale();
    renderPeriod();
    var bulk = $('bbrepBulk');
    if (bulk && bulk.querySelector('[data-bbrep-act="bulk-go"]')) renderBulkConfirm();
  }
  function onInput(e) {
    var t = e.target;
    if (t.id === 'bbrepClientQ') { queueClientSearch(); return; }
    if (t.hasAttribute && t.hasAttribute('data-bbrep-edit')) {
      updateCounter(t);
      if (S.preview && !S.stale) setDirty(true);
      return;
    }
    if (t.id === 'bbrepStart' || t.id === 'bbrepEnd') { markStale(); renderPeriod(); }
  }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'bbrepMonth') {
      var v = t.value;
      if (v && v > lastCompletedMonth()) { v = lastCompletedMonth(); t.value = v; }
      if (v) S.month = v;
      markStale(); renderPeriod();
    } else if (t.id === 'bbrepCustomToggle') {
      S.custom = !!t.checked;
      if (S.custom) {
        var p = S.type === 'weekly' ? { start: S.weekStart, end: addDays(S.weekStart, 6) } : monthRange(S.month);
        $('bbrepStart').value = p.start; $('bbrepEnd').value = p.end;
      }
      markStale(); renderPeriod();
    } else if (t.id === 'bbrepStart' || t.id === 'bbrepEnd') {
      markStale(); renderPeriod();
    } else if (t.hasAttribute && t.hasAttribute('data-bbrep-chan')) {
      var st = S.send[t.getAttribute('data-cid')];
      if (st) { st[t.getAttribute('data-bbrep-chan')] = !!t.checked; renderSend(t.getAttribute('data-cid')); }
    }
  }
  function onKeydown(e) {
    var t = e.target;
    if (t.id === 'bbrepClientQ') {
      var list = $('bbrepClientList');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { queueClientSearch(0); return; }
        if (!S.clients.length) return;
        S.activeIdx = (S.activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + S.clients.length) % S.clients.length;
        renderClientList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (S.searchPending || S.shownReq !== S.clientReq) { S.enterQueued = true; return; }
        if (!list.hidden && S.activeIdx >= 0) selectClient(S.activeIdx);
      } else if (e.key === 'Escape') {
        closeList();
      }
      return;
    }
    if (t.hasAttribute && t.hasAttribute('data-bbrep-type') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setType(S.type === 'weekly' ? 'monthly' : 'weekly');
      var btn = root().querySelector('[data-bbrep-type="' + S.type + '"]');
      if (btn) btn.focus();
    }
  }

  /* ---------------- entry ---------------- */
  function loadAdminReports() {
    var el = root();
    if (!el) return;
    var role = window.currentUser && window.currentUser.role;
    if (role !== 'admin' && role !== 'superadmin') return;
    if (!S.built) {
      S.weekStart = lastCompletedWeekStart();
      S.month = lastCompletedMonth();
      if (!buildShell()) return;
      renderTypes();
      renderPeriod();
      renderChip();
    }
    if (!isAdmin()) {
      $('bbrepGate').innerHTML = '<p class="bbrep-banner is-warn">Reports are available to admin accounts only. Sign in with an admin account to preview, generate and send client reports.</p>';
      var parts = el.querySelectorAll('.bbrep-types,.bbrep-setup,.bbrep-work,.bbrep-history,#bbrepBulkBtn');
      for (var i = 0; i < parts.length; i++) parts[i].hidden = true;
      return;
    }
    loadHistory();
    scaleFrame(true);
    syncButtons();
  }

  window.loadAdminReports = loadAdminReports;
})();
