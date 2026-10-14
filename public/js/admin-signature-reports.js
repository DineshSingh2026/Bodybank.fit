/* ==========================================================================
   ADMIN . SIGNATURE REPORTS ("bbsig") -- the new weekly / monthly templates
   Backend: routes/signatureReports.js at /api/admin/signature-reports.
   Lives inside the Reports tab next to the classic reports: a switch at the top
   of #tab-reports chooses "Signature" or "Classic". The classic screen
   (js/admin-reports.js) is not modified — it is only hidden while Signature is
   showing. Workflow: build draft -> review flags + edit -> approve -> send.
   Nothing reaches a client until an admin presses Send.
   Globals used from index.html: apiCall, window.currentUser, API, showPopup.
   ========================================================================== */
(function () {
  'use strict';

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var PAGE_PX = 794;
  var PREF_KEY = 'bb_reports_template';
  var LIM = { headline: 110, letter: 760, chapter: 46, ps: 180, target: 110 };

  var S = {
    mounted: false, tpl: 'signature', type: 'weekly', tab: 'draft',
    client: null, clients: [], clientTimer: null, clientReq: 0,
    weekStart: null, month: null,
    list: [], counts: { draft: 0, approved: 0, sent: 0 }, listReq: 0,
    report: null, busy: false, dirty: false, frameW: 0, job: null, jobTimer: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }
  function token() { return window.currentUser && window.currentUser.token; }
  function isAdmin() { return !!(window.currentUser && window.currentUser.role === 'admin'); }
  function errOf(d, fb) { return (d && (d.error || d.message)) || fb; }
  function pref(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }

  /* ---------- dates (IST) ---------- */
  function dayNum(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN; }
  function fromDay(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function addDays(s, d) { return fromDay(dayNum(s) + d); }
  function todayIST() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function lastWeekStart() { var t = todayIST(); var dow = new Date(dayNum(t) * 86400000).getUTCDay(); return addDays(addDays(t, -((dow + 6) % 7)), -7); }
  function lastMonth() { var t = todayIST(); var y = +t.slice(0, 4), m = +t.slice(5, 7); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); }
  function monthRange(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); var last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { start: ym + '-01', end: ym + '-' + String(last).padStart(2, '0') }; }
  function short(s) { var d = new Date(dayNum(s) * 86400000); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function period() {
    if (S.type === 'weekly') return { start: S.weekStart, end: addDays(S.weekStart, 6), label: short(S.weekStart) + ' – ' + short(addDays(S.weekStart, 6)) };
    var r = monthRange(S.month); var d = new Date(dayNum(r.start) * 86400000);
    return { start: r.start, end: r.end, label: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()] + ' ' + d.getUTCFullYear() };
  }
  function when(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function gradeCls(g) { return g === 'A+' || g === 'A' ? 'g-good' : (g === 'B' || g === 'C' ? 'g-warn' : (g ? 'g-flag' : '')); }

  /* ---------- template switch (Signature | Classic) ---------- */
  function mountSwitch() {
    var tab = $('tab-reports');
    if (!tab || $('bbsigSwitch')) return !!tab;
    var bar = document.createElement('div');
    bar.id = 'bbsigSwitch';
    bar.className = 'bbsig-switch';
    bar.setAttribute('role', 'radiogroup');
    bar.setAttribute('aria-label', 'Report template');
    bar.innerHTML = '<span class="bbsig-switch-lbl">Template</span>'
      + '<button type="button" role="radio" data-bbsig-tpl="signature"><b>Signature</b><small>New · coach-approved</small><i class="bbsig-newtag">NEW</i></button>'
      + '<button type="button" role="radio" data-bbsig-tpl="classic"><b>Classic</b><small>Current reports</small></button>';
    tab.insertBefore(bar, tab.firstChild);
    var host = document.createElement('div');
    host.id = 'bbsig';
    host.className = 'bbsig';
    bar.parentNode.insertBefore(host, bar.nextSibling);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bbsig-tpl]');
      if (b) setTpl(b.getAttribute('data-bbsig-tpl'));
    });
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    if (!S.resizeBound) { window.addEventListener('resize', function () { scaleFrame(false); }); S.resizeBound = true; }
    S.mounted = true;
    return true;
  }

  function setTpl(t) {
    S.tpl = t === 'classic' ? 'classic' : 'signature';
    pref(PREF_KEY, S.tpl);
    var btns = document.querySelectorAll('#bbsigSwitch [data-bbsig-tpl]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-bbsig-tpl') === S.tpl;
      btns[i].classList.toggle('is-active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    var classic = document.querySelector('#tab-reports > .bbrep, #tab-reports .admin-subsection-wrap.bbrep');
    if (classic) classic.hidden = S.tpl !== 'classic';
    $('bbsig').hidden = S.tpl !== 'signature';
    if (S.tpl === 'signature') { if (!$('bbsigRoot')) { buildShell(); renderChip(); } loadList(); }
  }

  /* ---------- shell ---------- */
  function buildShell() {
    var p = period();
    $('bbsig').innerHTML = ''
      + '<div id="bbsigRoot">'
      + '<div class="bbsig-head"><div><h3 class="admin-subsection-title">Signature reports</h3>'
      + '<p class="bbsig-sub">Draft → review → approve → send. Nothing reaches a client until you press Send. No automatic sending.</p></div>'
      + '<a class="bbsig-sample" href="#" data-bbsig-act="how">How it works</a></div>'
      + '<div class="bbsig-card bbsig-new">'
      + '  <div class="bbsig-seg" role="radiogroup" aria-label="Report type"><button type="button" data-bbsig-type="weekly" class="is-active">Weekly</button><button type="button" data-bbsig-type="monthly">Monthly</button></div>'
      + '  <div class="bbsig-field bbsig-client"><label class="bbsig-lbl" for="bbsigQ">Client</label>'
      + '    <input id="bbsigQ" class="bbsig-input" type="search" placeholder="Type a client name, email or phone" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="bbsigList">'
      + '    <ul id="bbsigList" class="bbsig-ta" role="listbox" aria-label="Clients" hidden></ul><div id="bbsigChip"></div></div>'
      + '  <div class="bbsig-field"><span class="bbsig-lbl">Period</span>'
      + '    <div id="bbsigWeek" class="bbsig-week"><button type="button" data-bbsig-act="wk-prev" aria-label="Previous week">‹</button><span id="bbsigWeekLbl">' + esc(p.label) + '</span><button type="button" data-bbsig-act="wk-next" aria-label="Next week">›</button></div>'
      + '    <input id="bbsigMonth" class="bbsig-input" type="month" hidden></div>'
      + '  <div class="bbsig-actions"><button type="button" class="bbsig-btn bbsig-btn-primary" data-bbsig-act="draft" id="bbsigDraftBtn" disabled>Build draft</button>'
      + '    <button type="button" class="bbsig-btn bbsig-btn-ghost" data-bbsig-act="bulk" id="bbsigBulkBtn">Draft all active clients</button>'
      + '    <span class="bbsig-status" id="bbsigStatus" role="status" aria-live="polite"></span></div>'
      + '  <div id="bbsigJob" aria-live="polite"></div>'
      + '</div>'
      + '<div class="bbsig-tabs" role="tablist">'
      + '  <button type="button" role="tab" data-bbsig-tab="draft" class="is-active">To review <span id="bbsigCntDraft">0</span></button>'
      + '  <button type="button" role="tab" data-bbsig-tab="approved">Approved, not sent <span id="bbsigCntApproved">0</span></button>'
      + '  <button type="button" role="tab" data-bbsig-tab="sent">Sent <span id="bbsigCntSent">0</span></button>'
      + '</div>'
      + '<div id="bbsigQueue" class="bbsig-queue"></div>'
      + '<div id="bbsigWork" class="bbsig-work" hidden>'
      + '  <div class="bbsig-preview"><div class="bbsig-meta" id="bbsigMeta"></div><div class="bbsig-frame-wrap" id="bbsigFrameWrap"><iframe id="bbsigFrame" sandbox="allow-same-origin" title="Report preview"></iframe><div class="bbsig-loading" id="bbsigLoading" hidden>Rendering preview…</div></div></div>'
      + '  <div class="bbsig-side" id="bbsigSide"></div>'
      + '</div>'
      + '</div>';
    $('bbsigQ').addEventListener('focus', function () { if (($('bbsigQ').value || '').trim().length >= 2) queueSearch(0); });
    $('bbsigQ').addEventListener('blur', function () { setTimeout(closeList, 250); });
    $('bbsigQ').addEventListener('keydown', onSearchKey);
    $('bbsigList').addEventListener('mousedown', function (e) { var i = pickTarget(e); if (i != null) { e.preventDefault(); pickClient(i); } });
    $('bbsigList').addEventListener('touchend', function (e) { var i = pickTarget(e); if (i != null) { e.preventDefault(); pickClient(i); } });
    $('bbsigFrame').addEventListener('load', function () { scaleFrame(true); });
    $('bbsigMonth').value = S.month;
    $('bbsigMonth').max = lastMonth();
  }

  function setStatus(msg, kind) { var el = $('bbsigStatus'); if (el) { el.textContent = msg || ''; el.className = 'bbsig-status' + (kind ? ' is-' + kind : ''); } }
  function renderPeriod() {
    var p = period();
    $('bbsigWeek').hidden = S.type !== 'weekly';
    $('bbsigMonth').hidden = S.type !== 'monthly';
    $('bbsigWeekLbl').textContent = p.label;
    var segs = document.querySelectorAll('#bbsig [data-bbsig-type]');
    for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('is-active', segs[i].getAttribute('data-bbsig-type') === S.type);
    $('bbsigDraftBtn').disabled = S.busy || !S.client;
    $('bbsigDraftBtn').textContent = S.client ? 'Build ' + S.type + ' draft for ' + S.client.name.split(' ')[0] : 'Pick a client first';
    $('bbsigBulkBtn').textContent = 'Draft all active clients · ' + p.label;
  }

  /* ---------- client search ---------- */
  // Results are picked on mousedown / touchend (with preventDefault) so the search
  // box never loses focus mid-click: a blur-then-hide used to remove the list before
  // a normal-speed mouse click landed, so no client could be chosen.
  function queueSearch(delay) { clearTimeout(S.clientTimer); S.clientTimer = setTimeout(searchClients, delay == null ? 200 : delay); }
  function closeList() { var l = $('bbsigList'); if (l) l.hidden = true; S.activeIdx = -1; var q = $('bbsigQ'); if (q) q.setAttribute('aria-expanded', 'false'); }
  function stCls(st) { return 'is-' + String(st || '').toLowerCase().replace(/\s+/g, '-'); }
  function searchClients() {
    var q = ($('bbsigQ').value || '').trim();
    var l = $('bbsigList');
    if (q.length < 2) {
      S.clients = [];
      l.innerHTML = '<li class="bbsig-none">Type at least 2 letters of a name, email or phone number</li>';
      l.hidden = false; return;
    }
    var req = ++S.clientReq;
    l.innerHTML = '<li class="bbsig-none">Searching…</li>'; l.hidden = false;
    apiCall('GET', '/api/admin/signature-reports/clients?q=' + encodeURIComponent(q) + '&limit=20').then(function (d) {
      if (req !== S.clientReq) return;
      if (!d || d.error) { l.innerHTML = '<li class="bbsig-none is-error">' + esc(errOf(d, 'Search failed')) + '</li>'; return; }
      S.clients = d.clients || [];
      S.activeIdx = S.clients.length ? 0 : -1;
      renderClientList(q);
    });
  }
  function renderClientList(q) {
    var l = $('bbsigList');
    l.innerHTML = S.clients.length ? S.clients.map(function (c, i) {
      var meta = [c.email, c.phone].filter(Boolean).join(' · ');
      var last = c.lastCheckin ? 'Last check-in ' + short(c.lastCheckin) : 'No check-ins yet';
      return '<li role="option" aria-selected="' + (i === S.activeIdx) + '"><button type="button" tabindex="-1" class="' + (i === S.activeIdx ? 'is-active' : '') + '" data-bbsig-pick="' + i + '">'
        + '<span class="bbsig-ta-main"><b>' + esc(c.name) + '</b><small>' + esc(meta) + '</small></span>'
        + '<span class="bbsig-ta-side"><i class="bbsig-st ' + stCls(c.status) + '">' + esc(c.status) + '</i><small>' + esc(last) + '</small></span></button></li>';
    }).join('') : '<li class="bbsig-none">No client matches “' + esc(q) + '”. Try part of the first name, the email or the phone number.</li>';
    l.hidden = false;
    $('bbsigQ').setAttribute('aria-expanded', 'true');
  }
  function pickClient(i) {
    var c = S.clients[i]; if (!c) return;
    S.client = c; $('bbsigQ').value = ''; closeList(); renderChip();
    setStatus('');
  }
  function onSearchKey(e) {
    var l = $('bbsigList');
    if (e.key === 'Escape') { closeList(); return; }
    if (!S.clients.length || l.hidden) { if (e.key === 'ArrowDown') queueSearch(0); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.activeIdx = (S.activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + S.clients.length) % S.clients.length;
      renderClientList(($('bbsigQ').value || '').trim());
    } else if (e.key === 'Enter') { e.preventDefault(); if (S.activeIdx >= 0) pickClient(S.activeIdx); }
  }
  function pickTarget(e) { var b = e.target && e.target.closest && e.target.closest('[data-bbsig-pick]'); return b ? +b.getAttribute('data-bbsig-pick') : null; }
  function renderChip() {
    var c = S.client;
    $('bbsigChip').innerHTML = c ? '<span class="bbsig-chip">' + esc(c.name) + (c.status && c.status !== 'Active' ? ' <i class="bbsig-st ' + stCls(c.status) + '">' + esc(c.status) + '</i>' : '') + '<button type="button" data-bbsig-act="unpick" aria-label="Clear client">×</button></span>' : '';
    renderPeriod();
  }

  /* ---------- queue ---------- */
  function loadList() {
    var req = ++S.listReq;
    apiCall('GET', '/api/admin/signature-reports?status=' + S.tab + '&limit=150').then(function (d) {
      if (req !== S.listReq) return;
      if (!d || d.error) { $('bbsigQueue').innerHTML = '<p class="bbsig-empty is-error">' + esc(errOf(d, 'Could not load reports')) + '</p>'; return; }
      S.list = d.reports || []; S.counts = d.counts || S.counts;
      $('bbsigCntDraft').textContent = S.counts.draft || 0;
      $('bbsigCntApproved').textContent = S.counts.approved || 0;
      $('bbsigCntSent').textContent = S.counts.sent || 0;
      renderQueue();
    });
  }
  function flagDots(flags) {
    var red = flags.filter(function (f) { return f === 'red'; }).length;
    var amber = flags.filter(function (f) { return f === 'amber'; }).length;
    var out = '';
    if (red) out += '<span class="bbsig-flag is-red" title="Needs a look">' + red + ' to check</span>';
    if (amber) out += '<span class="bbsig-flag is-amber">' + amber + ' note' + (amber === 1 ? '' : 's') + '</span>';
    return out || '<span class="bbsig-flag is-green">Ready</span>';
  }
  function renderQueue() {
    var el = $('bbsigQueue');
    var tabs = document.querySelectorAll('#bbsig [data-bbsig-tab]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-bbsig-tab') === S.tab);
    if (!S.list.length) {
      el.innerHTML = '<p class="bbsig-empty">' + (S.tab === 'draft' ? 'No drafts waiting. Build one above, or draft every active client for the period in one go.' : (S.tab === 'approved' ? 'Nothing approved and waiting to send.' : 'No Signature reports sent yet.')) + '</p>';
      return;
    }
    el.innerHTML = '<div class="bbsig-rows">' + S.list.map(function (r) {
      var on = S.report && S.report.id === r.id;
      return '<button type="button" class="bbsig-row' + (on ? ' is-open' : '') + '" data-bbsig-open="' + esc(r.id) + '">'
        + '<span class="bbsig-row-who"><b>' + esc(r.clientName || 'Client') + '</b><small>' + (r.type === 'monthly' ? 'Monthly' : 'Weekly') + ' · ' + esc(r.periodLabel) + '</small></span>'
        + '<span class="bbsig-score ' + gradeCls(r.grade) + '">' + esc(r.score == null ? '—' : r.score) + '<i>' + esc(r.grade || '') + '</i></span>'
        + '<span class="bbsig-row-flags">' + (r.status === 'draft' ? flagDots(r.flags || []) : (r.status === 'sent' ? '<span class="bbsig-flag is-sent">Sent ' + esc(when(r.sentAt)) + '</span>' : '<span class="bbsig-flag is-green">Approved</span>')) + '</span>'
        + '<span class="bbsig-row-when">' + esc(when(r.updatedAt)) + '</span></button>';
    }).join('') + '</div>';
  }

  /* ---------- workspace ---------- */
  function openReport(id) {
    setStatus('Loading report…');
    apiCall('GET', '/api/admin/signature-reports/' + encodeURIComponent(id)).then(function (d) {
      if (!d || !d.report) { setStatus(errOf(d, 'Could not load the report'), 'error'); return; }
      setStatus('');
      showReport(d.report);
    });
  }

  function showReport(r) {
    S.report = r; S.dirty = false;
    $('bbsigWork').hidden = false;
    renderMeta(); renderSide(); renderQueue(); loadPreview();
    try { $('bbsigWork').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ }
  }

  function renderMeta() {
    var r = S.report; if (!r) return;
    var st = { draft: 'Draft — not visible to the client', approved: 'Approved — ready to send', sent: 'Sent' + (r.sentAt ? ' ' + when(r.sentAt) : '') + (r.sentChannels && r.sentChannels.length ? ' via ' + r.sentChannels.join(' + ') : '') }[r.status] || r.status;
    $('bbsigMeta').innerHTML = '<div><b>' + esc(r.clientName) + '</b><span>' + (r.type === 'monthly' ? 'Monthly' : 'Weekly') + ' Signature · ' + esc(r.periodLabel) + '</span></div>'
      + '<div class="bbsig-meta-chips"><span class="bbsig-score ' + gradeCls(r.grade) + '">' + esc(r.score) + '<i>' + esc(r.grade) + '</i></span>'
      + '<span class="bbsig-pill is-' + esc(r.status) + '">' + esc(st) + '</span>'
      + '<span class="bbsig-pill">' + (r.aiSource === 'ai' ? 'AI draft' : 'Rules draft' + (r.aiError ? ' (AI unavailable)' : '')) + '</span></div>';
  }

  function counter(id, max) { var el = $(id); return el ? '<span class="bbsig-count" data-for="' + id + '">' + (el.value || '').length + '/' + max + '</span>' : ''; }

  function renderSide() {
    var r = S.report; if (!r) return;
    var locked = r.status === 'sent';
    var flags = (r.review || []).map(function (f) { return '<li class="is-' + esc(f.level) + '">' + esc(f.text) + '</li>'; }).join('');
    var tg = (r.targets || []).map(function (t, i) {
      var val = t.custom || !t.metric ? '' : '<label class="bbsig-mini">Goal<input type="number" min="1" max="999" class="bbsig-input" data-bbsig-tv="' + i + '" value="' + esc(t.value) + '"' + (locked ? ' disabled' : '') + '></label>';
      var base = t.baseline == null ? 'Coach target' : 'This period: ' + t.baseline + ' / ' + t.baselineOf + (t.points ? ' · +' + t.points + ' pts' : '');
      return '<div class="bbsig-tgt"><div class="bbsig-tgt-top"><span class="bbsig-tgt-n">' + (i + 1) + '</span><input type="text" maxlength="' + LIM.target + '" class="bbsig-input" data-bbsig-tl="' + i + '" value="' + esc(t.label) + '"' + (locked ? ' disabled' : '') + '>' + val + '</div><small>' + esc(base) + '</small></div>';
    }).join('');
    var n = r.narrative || {};
    var pats = (r.patterns || []).map(function (p) { return '<li><b>' + esc(p.title) + '.</b> ' + esc(p.text) + '</li>'; }).join('');
    var sendBox = r.status === 'approved' || r.status === 'sent'
      ? '<div class="bbsig-card"><h4 class="bbsig-h4">' + (r.status === 'sent' ? 'Send again' : 'Send to ' + esc(r.clientName)) + '</h4>'
        + '<label class="bbsig-check"><input type="checkbox" id="bbsigChEmail" checked> Email with PDF' + (r.clientEmail ? ' · ' + esc(r.clientEmail) : ' · <em>no email on file</em>') + '</label>'
        + '<label class="bbsig-check"><input type="checkbox" id="bbsigChWa" checked> WhatsApp link' + (r.clientPhone ? ' · ' + esc(r.clientPhone) : ' · <em>no phone on file</em>') + '</label>'
        + '<div class="bbsig-btnrow"><button type="button" class="bbsig-btn bbsig-btn-primary" data-bbsig-act="send">' + (r.status === 'sent' ? 'Send again' : 'Send now') + '</button>'
        + '<button type="button" class="bbsig-btn bbsig-btn-ghost" data-bbsig-act="pdf">Download PDF</button></div><div id="bbsigSendOut"></div></div>'
      : '';
    $('bbsigSide').innerHTML = ''
      + (flags ? '<div class="bbsig-card"><h4 class="bbsig-h4">Before you send</h4><ul class="bbsig-review">' + flags + '</ul></div>' : '')
      + '<div class="bbsig-card"><h4 class="bbsig-h4">Coach words' + (locked ? ' · locked (sent)' : '') + '</h4>'
      + '<label class="bbsig-lbl" for="bbsigHeadline">Headline (cover) ' + '<span class="bbsig-count" id="bbsigHeadlineC"></span></label><textarea id="bbsigHeadline" rows="2" maxlength="' + LIM.headline + '" class="bbsig-input"' + (locked ? ' disabled' : '') + '>' + esc(n.headline) + '</textarea>'
      + (r.type === 'monthly' ? '<label class="bbsig-lbl" for="bbsigChapter">Chapter title (cover) <span class="bbsig-count" id="bbsigChapterC"></span></label><input id="bbsigChapter" maxlength="' + LIM.chapter + '" class="bbsig-input" value="' + esc(n.chapter) + '"' + (locked ? ' disabled' : '') + '>' : '')
      + '<label class="bbsig-lbl" for="bbsigLetter">Letter from the coach <span class="bbsig-count" id="bbsigLetterC"></span></label><textarea id="bbsigLetter" rows="7" maxlength="' + LIM.letter + '" class="bbsig-input"' + (locked ? ' disabled' : '') + '>' + esc(n.letter) + '</textarea>'
      + '<label class="bbsig-lbl" for="bbsigPs">P.S. — one personal line (optional) <span class="bbsig-count" id="bbsigPsC"></span></label><input id="bbsigPs" maxlength="' + LIM.ps + '" class="bbsig-input" value="' + esc(n.ps) + '" placeholder="e.g. Proud of you for showing up on the travel days."' + (locked ? ' disabled' : '') + '>'
      + '<h4 class="bbsig-h4" style="margin-top:14px">Next ' + (r.type === 'monthly' ? 'month' : 'week') + "'s three targets</h4>" + tg
      + '<p class="bbsig-hint">Projected score if all three are hit: <b>' + esc(r.projection ? r.projection.projected : '—') + '</b> (now ' + esc(r.score) + '). Targets keep their measure, so the next report scores them automatically.</p>'
      + (locked ? '' : '<div class="bbsig-btnrow"><button type="button" class="bbsig-btn" data-bbsig-act="save" id="bbsigSaveBtn">Save &amp; update preview</button>'
        + '<button type="button" class="bbsig-btn bbsig-btn-ghost" data-bbsig-act="reset">Reset to draft words</button>'
        + '<button type="button" class="bbsig-btn bbsig-btn-ghost" data-bbsig-act="refresh">Refresh data</button></div>')
      + '</div>'
      + (pats ? '<div class="bbsig-card"><h4 class="bbsig-h4">Patterns found</h4><ul class="bbsig-pats">' + pats + '</ul></div>' : '')
      + (r.status === 'draft' ? '<div class="bbsig-card bbsig-approve"><p>Approving locks the PDF. The client still sees nothing until you send it.</p><div class="bbsig-btnrow"><button type="button" class="bbsig-btn bbsig-btn-primary" data-bbsig-act="approve" id="bbsigApproveBtn">Approve report</button><button type="button" class="bbsig-btn bbsig-btn-danger" data-bbsig-act="discard">Discard</button></div></div>' : '')
      + sendBox;
    updateCounters();
  }

  function updateCounters() {
    [['bbsigHeadline', LIM.headline], ['bbsigChapter', LIM.chapter], ['bbsigLetter', LIM.letter], ['bbsigPs', LIM.ps]].forEach(function (p) {
      var el = $(p[0]); var c = $(p[0] + 'C');
      if (el && c) c.textContent = (el.value || '').length + '/' + p[1];
    });
  }

  function readEdits() {
    var r = S.report;
    var e = { headline: ($('bbsigHeadline') || {}).value || '', letter: ($('bbsigLetter') || {}).value || '', ps: ($('bbsigPs') || {}).value || '' };
    if ($('bbsigChapter')) e.chapter = $('bbsigChapter').value || '';
    e.targets = (r.targets || []).map(function (t, i) {
      var lblEl = document.querySelector('#bbsig [data-bbsig-tl="' + i + '"]');
      var valEl = document.querySelector('#bbsig [data-bbsig-tv="' + i + '"]');
      var out = {};
      var lbl = lblEl ? lblEl.value.trim() : '';
      if (t.custom || !t.metric) { out.custom = true; out.label = lbl; return out; }
      var v = valEl ? Number(valEl.value) : NaN;
      if (isFinite(v) && v !== t.value) out.value = v;
      if (lbl && lbl !== t.label) out.label = lbl;
      return out;
    });
    // Keep earlier target edits the coach already saved.
    var prev = (r.edits && r.edits.targets) || [];
    e.targets = e.targets.map(function (t, i) { return Object.keys(t).length ? t : (prev[i] || {}); });
    return e;
  }

  function loadPreview() {
    var r = S.report; if (!r) return;
    $('bbsigLoading').hidden = false;
    var t = token();
    fetch(apiBase() + '/api/admin/signature-reports/' + encodeURIComponent(r.id) + '/preview', { headers: t ? { Authorization: 'Bearer ' + t } : {} })
      .then(function (res) { return res.text().then(function (txt) { return { ok: res.ok, txt: txt }; }); })
      .then(function (o) {
        $('bbsigLoading').hidden = true;
        if (!o.ok) { var j = {}; try { j = JSON.parse(o.txt); } catch (e) { /* ignore */ } setStatus(errOf(j, 'Preview failed'), 'error'); return; }
        $('bbsigFrame').srcdoc = o.txt;
      }).catch(function () { $('bbsigLoading').hidden = true; setStatus('Preview failed — check your connection.', 'error'); });
  }

  function scaleFrame(force) {
    var frame = $('bbsigFrame'), wrap = $('bbsigFrameWrap');
    if (!frame || !wrap || $('bbsigWork').hidden) return;
    var w = wrap.clientWidth; if (!w) return;
    if (force !== true && w === S.frameW) return;
    var doc; try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body) return;
    var z = Math.min(1.4, (w - 4) / PAGE_PX);
    doc.documentElement.style.overflow = 'hidden';
    doc.documentElement.style.background = 'transparent';
    doc.body.style.background = 'transparent';
    doc.body.style.zoom = '1';
    var h = Math.max(doc.body.scrollHeight, doc.body.offsetHeight);
    doc.body.style.zoom = String(z);
    frame.style.height = Math.ceil(h * z) + 'px';
    S.frameW = w;
  }

  function act(method, path, body, busyMsg, okMsg) {
    S.busy = true; setStatus(busyMsg);
    return apiCall(method, '/api/admin/signature-reports' + path, body).then(function (d) {
      S.busy = false;
      if (!d || d.success === false || d.error) { setStatus(errOf(d, 'Something went wrong'), 'error'); if (d && d.hint) setStatus(d.hint, 'error'); return null; }
      setStatus(okMsg || '', 'ok');
      return d;
    });
  }

  /* ---------- events ---------- */
  function onClick(e) {
    var b = e.target.closest('button, a, [data-bbsig-open]');
    if (!b) return;
    var pick = b.getAttribute('data-bbsig-pick');
    if (pick != null) { pickClient(+pick); return; }
    var type = b.getAttribute('data-bbsig-type');
    if (type) { S.type = type; renderPeriod(); return; }
    var tab = b.getAttribute('data-bbsig-tab');
    if (tab) { S.tab = tab; loadList(); return; }
    var open = b.getAttribute('data-bbsig-open');
    if (open) { openReport(open); return; }
    var a = b.getAttribute('data-bbsig-act');
    if (!a) return;
    if (a === 'how') {
      e.preventDefault();
      if (typeof showPopup === 'function') showPopup('Signature reports', '1. Build a draft for one client, or draft every active client for the period.\n2. Read the "Before you send" notes: score drops, missing data, renewal dates and the client\'s own Sunday questions.\n3. Edit the headline, letter and targets — the preview updates.\n4. Approve to lock the PDF, then Send by email and/or WhatsApp.\n\nThe client sees nothing until you press Send. Targets you set are scored automatically at the top of the next report ("Promise check").', '', 'OK', null, 'info');
      return;
    }
    if (a === 'unpick') { S.client = null; renderChip(); return; }
    if (a === 'wk-prev') { S.weekStart = addDays(S.weekStart, -7); renderPeriod(); return; }
    if (a === 'wk-next') { if (dayNum(S.weekStart) < dayNum(lastWeekStart())) S.weekStart = addDays(S.weekStart, 7); renderPeriod(); return; }
    if (a === 'draft') {
      if (!S.client) return;
      var p = period();
      $('bbsigDraftBtn').disabled = true;
      act('POST', '/draft', { userId: S.client.id, type: S.type, startDate: p.start, endDate: p.end }, 'Building the draft (reading data and writing the coach words, 5–20 s)…', 'Draft ready — review it below.').then(function (d) {
        renderPeriod();
        if (d && d.report) { S.tab = 'draft'; loadList(); showReport(d.report); }
      });
      return;
    }
    if (a === 'bulk') {
      var pp = period();
      var go = function () {
        act('POST', '/bulk-draft', { type: S.type, startDate: pp.start, endDate: pp.end }, 'Starting…', 'Drafting in the background. Nothing is sent.').then(function (d) { if (d) { S.job = d; pollJob(); } });
      };
      if (typeof showPopup === 'function') showPopup('Draft all active clients', 'Build a ' + S.type + ' Signature draft for every active client for ' + pp.label + '? Clients who already have a report for this period are skipped. Nothing is sent.', 'Draft all', 'Cancel', go, 'info');
      else go();
      return;
    }
    var r = S.report; if (!r) return;
    if (a === 'save') {
      act('PUT', '/' + encodeURIComponent(r.id) + '/edits', readEdits(), 'Saving…', 'Saved. Preview updated.').then(function (d) { if (d && d.report) { showReport(d.report); loadList(); } });
      return;
    }
    if (a === 'reset') {
      act('PUT', '/' + encodeURIComponent(r.id) + '/edits', {}, 'Resetting…', 'Back to the draft words.').then(function (d) { if (d && d.report) showReport(d.report); });
      return;
    }
    if (a === 'refresh') {
      act('POST', '/' + encodeURIComponent(r.id) + '/refresh', {}, 'Re-reading the latest data…', 'Data refreshed. Your edits were kept.').then(function (d) { if (d && d.report) { showReport(d.report); loadList(); } });
      return;
    }
    if (a === 'approve') {
      var doApprove = function () {
        act('POST', '/' + encodeURIComponent(r.id) + '/approve', S.dirty ? undefined : {}, 'Approving and rendering the PDF…', 'Approved. Send it when you are ready.').then(function (d) { if (d && d.report) { showReport(d.report); loadList(); } });
      };
      if (S.dirty) {
        act('PUT', '/' + encodeURIComponent(r.id) + '/edits', readEdits(), 'Saving your edits first…', '').then(function (d) { if (d) { S.report = d.report; S.dirty = false; doApprove(); } });
      } else doApprove();
      return;
    }
    if (a === 'discard') {
      var doDiscard = function () {
        act('DELETE', '/' + encodeURIComponent(r.id), undefined, 'Discarding…', 'Draft discarded.').then(function (d) { if (d) { S.report = null; $('bbsigWork').hidden = true; loadList(); } });
      };
      if (typeof showPopup === 'function') showPopup('Discard draft', 'Discard this draft? You can build a new one any time.', 'Discard', 'Cancel', doDiscard, 'error'); else doDiscard();
      return;
    }
    if (a === 'send') {
      var ch = [];
      if ($('bbsigChEmail') && $('bbsigChEmail').checked) ch.push('email');
      if ($('bbsigChWa') && $('bbsigChWa').checked) ch.push('whatsapp');
      if (!ch.length) { setStatus('Choose email and/or WhatsApp.', 'error'); return; }
      var doSend = function () {
        S.busy = true; setStatus('Sending…');
        apiCall('POST', '/api/admin/signature-reports/' + encodeURIComponent(r.id) + '/send', { channels: ch }).then(function (d) {
          S.busy = false;
          var res = (d && d.results) || {};
          var lines = Object.keys(res).map(function (k) { return (k === 'whatsapp' ? 'WhatsApp' : 'Email') + ': ' + (res[k].ok ? 'sent' : 'failed (' + (res[k].reason || 'error') + ')'); });
          if (d && d.success) { setStatus('Sent. ' + lines.join(' · '), 'ok'); openReport(r.id); loadList(); }
          else setStatus(errOf(d, 'Send failed') + (lines.length ? ' — ' + lines.join(' · ') : ''), 'error');
        });
      };
      if (typeof showPopup === 'function') showPopup('Send report', 'Send this report to ' + r.clientName + ' by ' + ch.join(' and ') + '?', 'Send', 'Cancel', doSend, 'info'); else doSend();
      return;
    }
    if (a === 'pdf') {
      var t = token();
      fetch(apiBase() + '/api/admin/signature-reports/' + encodeURIComponent(r.id) + '/pdf', { headers: t ? { Authorization: 'Bearer ' + t } : {} }).then(function (res) {
        if (!res.ok) throw new Error('PDF not available (' + res.status + ')');
        var cd = res.headers.get('Content-Disposition') || ''; var m = /filename="?([^";]+)"?/i.exec(cd);
        return res.blob().then(function (bl) { var u = URL.createObjectURL(bl); var aEl = document.createElement('a'); aEl.href = u; aEl.download = m ? m[1] : 'BodyBank_Signature_Report.pdf'; document.body.appendChild(aEl); aEl.click(); aEl.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); });
      }).catch(function (err) { setStatus(err.message, 'error'); });
    }
  }

  function onInput(e) {
    if (e.target.id === 'bbsigQ') { queueSearch(); return; }
    if (e.target.closest('#bbsigSide')) { S.dirty = true; updateCounters(); }
  }
  function onChange(e) {
    if (e.target.id === 'bbsigMonth' && e.target.value) { S.month = e.target.value; renderPeriod(); }
  }

  function pollJob() {
    clearTimeout(S.jobTimer);
    var j = S.job; if (!j) return;
    var el = $('bbsigJob');
    el.innerHTML = '<div class="bbsig-job"><div class="bbsig-job-bar"><i style="width:' + (j.progressPct || 0) + '%"></i></div><span>' + esc(j.done || 0) + ' drafted · ' + esc(j.skipped || 0) + ' already had one · ' + esc(j.failed || 0) + ' failed · ' + esc(j.total || 0) + ' clients</span></div>';
    if (j.status !== 'running') { setStatus('Bulk drafting finished. Review the drafts below.', 'ok'); S.tab = 'draft'; loadList(); return; }
    S.jobTimer = setTimeout(function () {
      apiCall('GET', '/api/admin/signature-reports/bulk/' + encodeURIComponent(j.jobId)).then(function (d) { if (d && d.jobId) S.job = d; if (S.job.status === 'running' && S.tab === 'draft') loadList(); pollJob(); });
    }, 3000);
  }

  /* ---------- entry: wraps the Reports tab loader ---------- */
  function enhance() {
    var role = window.currentUser && window.currentUser.role;
    if (role !== 'admin' && role !== 'superadmin') return;
    if (!isAdmin()) return; // the API is admin-only; superadmin keeps the classic notice
    if (!S.weekStart) {
      S.weekStart = lastWeekStart(); S.month = lastMonth();
      S.tpl = pref(PREF_KEY) === 'classic' ? 'classic' : 'signature';
    }
    // Idempotent: re-attaches if the admin shell rebuilt the tab's content.
    if (!mountSwitch()) return;
    setTpl(S.tpl);
    if (S.report && $('bbsigWork') && $('bbsigWork').hidden) showReport(S.report);
  }

  var original = window.loadAdminReports;
  window.loadAdminReports = function () {
    var out = typeof original === 'function' ? original.apply(this, arguments) : undefined;
    try { enhance(); } catch (err) { try { console.error('[bbsig]', err); } catch (_) { /* ignore */ } }
    return out;
  };
})();
