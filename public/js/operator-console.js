/* ============================================================================
   BodyBank — Operator Console
   ----------------------------------------------------------------------------
   A monitoring console for the operator role. Five destinations (Today, Clients,
   Blood, Leads, Inbox), each of which fits one viewport: the shell is a fixed
   grid and every list, feed and profile scrolls inside its own pane.

   Reads are all GETs. The only writes an operator can make are the three the
   role was designed for: a reminder into a client's chat, an escalation to
   admin, and blood-report handling (upload / lab-date / delete / comparison),
   which mirrors the admin surface exactly.

   Depends on globals defined in index.html: apiCall, escapeHtml, showPopup,
   bbContactMatches, Chart, and the shared blood helpers (bbAskLabDate,
   bbFmtDay, bbLabDateLabel, bbLabDateEditor, bbLabFileBtn, bbDeleteReportBtn,
   adminBloodDownloadPdf, bbCmpUseHost, bbLoadClientComparisons,
   bbRenderComparison) plus the readiness/signal mounts (bbRdMountClient,
   bbRdSummarise, bbSigMountStaff).
   ========================================================================== */

var opState = window.opState || (window.opState = {
  screen: 'today',
  clients: [],
  complianceMap: {},
  complianceSummary: null,
  overview: null,
  leads: null,
  blood: null,
  bloodSummary: null,
  activityType: 'all',
  attentionFilter: 'all',
  clientsMode: 'roster',
  leadsView: 'audits',
  detailHost: 'clients',
  detailTab: 'profile',
  escId: null,
  omniIndex: -1,
  omniRows: []
});

window._opCharts = window._opCharts || {};

/* ------------------------------------------------------------------ utils */
function opEsc(v) { return escapeHtml(v == null ? '' : String(v)); }
function opSetTxt(id, v) { var e = document.getElementById(id); if (e) e.textContent = (v == null ? '–' : v); }
function opEl(id) { return document.getElementById(id); }
function opInitials(name) {
  var p = String(name || '').trim().split(/\s+/);
  return ((((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase()) || 'C';
}
function opFullName(u) {
  u = u || {};
  return ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.email || 'Client';
}
function opTimeAgo(ts) {
  if (!ts) return '';
  var d = new Date(ts); if (isNaN(d.getTime())) return '';
  var sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return 'just now';
  var m = Math.floor(sec / 60); if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  var dd = Math.floor(h / 24); if (dd < 7) return dd + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function opDate(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function opDayKey(ts) { var d = new Date(ts); return isNaN(d.getTime()) ? '' : d.toDateString(); }
function opDayLabel(ts) {
  var d = new Date(ts); if (isNaN(d.getTime())) return '';
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var t = new Date(d); t.setHours(0, 0, 0, 0);
  var diff = Math.round((today - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function opParse(v) { if (v && typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return {}; } } return v || {}; }
function opNum(n) { n = Number(n) || 0; return n >= 1000 ? Math.round(n).toLocaleString() : Math.round(n * 10) / 10; }
function opWa(phone) { var d = String(phone || '').replace(/[^0-9]/g, ''); return d.length >= 7 ? 'https://wa.me/' + d : ''; }
function opAge(dob) {
  if (!dob) return null;
  var t = new Date(dob).getTime(); if (isNaN(t)) return null;
  var a = Math.floor((Date.now() - t) / (365.25 * 86400000));
  return (a > 0 && a < 130) ? a : null;
}
function opAvatar(pic, name, cls) {
  return pic
    ? '<img class="op-avatar' + (cls ? ' ' + cls : '') + '" src="' + opEsc(pic) + '" alt="" loading="lazy">'
    : '<div class="op-avatar' + (cls ? ' ' + cls : '') + '">' + opEsc(opInitials(name)) + '</div>';
}
function opDaysUntil(ts) {
  if (!ts) return null;
  var t = new Date(ts).getTime(); if (isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}
function opAnimateBars(scope) {
  requestAnimationFrame(function () {
    (scope || document).querySelectorAll('[data-w]').forEach(function (f) {
      f.style.width = (f.getAttribute('data-w') || 0) + '%';
    });
  });
}
function opKillChart(key) {
  if (window._opCharts[key]) { try { window._opCharts[key].destroy(); } catch (e) { } window._opCharts[key] = null; }
}

/* ================================================================== shell */
function bbEnterOperatorShell() {
  var panel = opEl('operatorPanel');
  if (panel) panel.classList.add('open');
  document.body.classList.add('site-nav-hidden');
  document.body.classList.add('admin-dashboard-open');
  document.body.classList.add('operator-console-open');
  if (typeof lockBodyScroll === 'function') lockBodyScroll();
  if (typeof registerNativePush === 'function') registerNativePush();

  opBindShortcuts();
  opTickClock();
  if (window._opClockInterval) clearInterval(window._opClockInterval);
  window._opClockInterval = setInterval(opTickClock, 30000);

  opNav('today');
  loadOperatorDashboard();
  if (window._opNotifyInterval) clearInterval(window._opNotifyInterval);
  window._opNotifyInterval = setInterval(loadOperatorNotifications, 60000);
}

// The console's cold start: everything Today needs, plus the roster that the
// omnibox and the attention queue both read from.
function loadOperatorDashboard() {
  loadOperatorOverview();
  loadOperatorClients();
  loadOperatorCompliance();
  loadOperatorActivity();
  loadOperatorEscalations(true);
  loadOperatorNotifications();
}

function opTickClock() {
  var el = opEl('opSyncLabel');
  if (!el) return;
  var now = new Date();
  el.innerHTML = '<b>●</b> ' + opEsc(now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))
    + ' · ' + opEsc(now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
}

var OP_SCREENS = ['today', 'clients', 'blood', 'leads', 'inbox'];

function opNav(screen) {
  if (OP_SCREENS.indexOf(screen) === -1) screen = 'today';
  opState.screen = screen;
  document.querySelectorAll('#operatorPanel [data-opnav]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-opnav') === screen);
  });
  document.querySelectorAll('#operatorPanel .op-screen').forEach(function (s) { s.classList.remove('active'); });
  var el = opEl('opScreen-' + screen);
  if (el) el.classList.add('active');
  opCloseOmni();

  if (screen === 'clients') { if (!opState.clients.length) loadOperatorClients(); else renderOperatorClients(); }
  else if (screen === 'blood') loadOperatorBlood();
  else if (screen === 'leads') { if (!opState.leads) loadOperatorLeads(); }
  else if (screen === 'inbox') loadOperatorEscalations();
  else { opRenderAttention(); }
}
// Kept for callers that still speak the old tab vocabulary.
function switchOperatorTab(tab) {
  var map = { overview: 'today', clients: 'clients', leads: 'leads', activity: 'today', admin: 'inbox' };
  opNav(map[tab] || tab);
  if (tab === 'activity') opTodayPane('live');
}

// Refresh reloads exactly what the operator is looking at, plus notifications.
function refreshOperator(btn) {
  if (btn && btn.classList) btn.classList.add('is-spinning');
  try {
    var s = opState.screen;
    if (s === 'clients') { loadOperatorClients(); loadOperatorCompliance(); }
    else if (s === 'blood') loadOperatorBlood();
    else if (s === 'leads') loadOperatorLeads();
    else if (s === 'inbox') loadOperatorEscalations();
    else { loadOperatorOverview(); loadOperatorClients(); loadOperatorCompliance(); loadOperatorActivity(); }
    loadOperatorNotifications();
    opTickClock();
  } catch (e) { }
  setTimeout(function () { if (btn && btn.classList) btn.classList.remove('is-spinning'); }, 750);
}

function logoutOperator() {
  if (window._opNotifyInterval) { clearInterval(window._opNotifyInterval); window._opNotifyInterval = null; }
  if (window._opClockInterval) { clearInterval(window._opClockInterval); window._opClockInterval = null; }
  Object.keys(window._opCharts).forEach(opKillChart);
  if (typeof window.bbRdUnmount === 'function') window.bbRdUnmount('oprd');
  if (typeof window.bbSigUnmount === 'function') window.bbSigUnmount('opsig');
  if (typeof unregisterNativePush === 'function') unregisterNativePush();
  if (typeof bbNotifyResetSoundState === 'function') bbNotifyResetSoundState();
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () { });
  var p = opEl('operatorPanel'); if (p) p.classList.remove('open');
  document.body.classList.remove('site-nav-hidden');
  document.body.classList.remove('admin-dashboard-open');
  document.body.classList.remove('operator-console-open');
  if (typeof unlockBodyScroll === 'function') unlockBodyScroll();
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { }
  window.currentUser = null;
}

// Keyboard: 1–5 jump between destinations, "/" focuses the omnibox, Esc backs out.
function opBindShortcuts() {
  if (window._opKeysBound) return;
  window._opKeysBound = true;
  document.addEventListener('keydown', function (e) {
    var panel = opEl('operatorPanel');
    if (!panel || !panel.classList.contains('open')) return;
    var tag = (e.target && e.target.tagName ? e.target.tagName : '').toUpperCase();
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);

    if (e.key === 'Escape') {
      if (opEl('opOmniResults') && opEl('opOmniResults').classList.contains('open')) { opCloseOmni(); return; }
      var openModalEl = document.querySelector('#operatorPanel .op-cm-overlay.open');
      if (openModalEl) { openModalEl.classList.remove('open'); return; }
      var sheet = document.querySelector('#operatorPanel .op-detail.open');
      if (sheet) { sheet.classList.remove('open'); return; }
      return;
    }
    if (typing) {
      if (e.key === 'Enter' && e.target.id === 'opOmniInput') { e.preventDefault(); opOmniEnter(); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.id === 'opOmniInput') { e.preventDefault(); opOmniMove(e.key === 'ArrowDown' ? 1 : -1); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); var i = opEl('opOmniInput'); if (i) i.focus(); return; }
    var idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (idx > -1) { e.preventDefault(); opNav(OP_SCREENS[idx]); }
  });
}

/* =============================================================== omnibox */
// One search box for the whole console: clients first, then prospects.
function opOmniInput() {
  var q = (opEl('opOmniInput') || {}).value || '';
  q = q.trim();
  var box = opEl('opOmniResults');
  if (!box) return;
  if (q.length < 1) { opCloseOmni(); return; }

  var rows = [];
  (opState.clients || []).forEach(function (c) {
    if (!bbContactMatches(q, [c.first_name, c.last_name, c.email], [c.phone])) return;
    rows.push({
      kind: 'client', id: c.id, name: opFullName(c),
      sub: (c.email || '') + ((c.inactive_days != null) ? ' · ' + c.inactive_days + 'd idle' : ''),
      pic: c.profile_picture, tag: 'Client'
    });
  });
  var leads = opState.leads || {};
  (leads.audits || []).forEach(function (a) {
    if (!bbContactMatches(q, [a.first_name, a.last_name, a.email], [a.phone])) return;
    rows.push({ kind: 'audit', id: a.id, name: opFullName(a), sub: [a.email, a.phone].filter(Boolean).join(' · '), tag: 'Audit' });
  });
  (leads.part2 || []).forEach(function (p) {
    if (!bbContactMatches(q, [p.name, p.email], [p.mobile])) return;
    rows.push({ kind: 'part2', id: p.id, name: p.name || p.email || 'Prospect', sub: [p.email, p.mobile].filter(Boolean).join(' · '), tag: 'Part-2' });
  });

  rows = rows.slice(0, 14);
  opState.omniRows = rows;
  opState.omniIndex = rows.length ? 0 : -1;
  box.innerHTML = rows.length ? rows.map(function (r, i) {
    return '<div class="op-omni-item' + (i === 0 ? ' sel' : '') + '" data-oi="' + i + '" onclick="opOmniPick(' + i + ')">'
      + opAvatar(r.pic, r.name) + '<div class="op-omni-main"><div class="op-omni-name">' + opEsc(r.name) + '</div>'
      + '<div class="op-omni-sub">' + opEsc(r.sub) + '</div></div>'
      + '<span class="op-omni-tag">' + opEsc(r.tag) + '</span></div>';
  }).join('') : '<div class="op-omni-empty">Nothing matches “' + opEsc(q) + '”.</div>';
  box.classList.add('open');
}
function opOmniMove(dir) {
  var rows = opState.omniRows || [];
  if (!rows.length) return;
  opState.omniIndex = (opState.omniIndex + dir + rows.length) % rows.length;
  document.querySelectorAll('#opOmniResults .op-omni-item').forEach(function (el, i) {
    el.classList.toggle('sel', i === opState.omniIndex);
    if (i === opState.omniIndex && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  });
}
function opOmniEnter() { if (opState.omniIndex > -1) opOmniPick(opState.omniIndex); }
function opOmniPick(i) {
  var r = (opState.omniRows || [])[i];
  if (!r) return;
  opCloseOmni();
  var input = opEl('opOmniInput'); if (input) { input.value = ''; input.blur(); }
  if (r.kind === 'client') { opNav('clients'); openOperatorClient(r.id, 'clients', 'profile'); }
  else { opNav('leads'); opLeadsView(r.kind === 'part2' ? 'part2' : 'audits'); setTimeout(function () { opLeadOpen(r.kind, r.id); }, 30); }
}
function opCloseOmni() {
  var box = opEl('opOmniResults');
  if (box) { box.classList.remove('open'); }
  opState.omniIndex = -1;
}

/* ================================================================= TODAY */
function opTodayPane(pane) {
  document.querySelectorAll('#opTodaySeg .op-seg-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-pane') === pane);
  });
  ['attention', 'pulse', 'live'].forEach(function (p) {
    var el = opEl('opPane' + p.charAt(0).toUpperCase() + p.slice(1));
    if (el) el.classList.toggle('pane-active', p === pane);
  });
  if (pane === 'pulse') opDrawTrendChart(opState.overview && opState.overview.trends);
}

async function loadOperatorOverview() {
  try {
    var data = await apiCall('GET', '/api/operator/overview');
    if (!data || data.error) return;
    opState.overview = data;
    var s = data.stats || {};
    opSetTxt('opKpiClients', s.total_clients);
    opSetTxt('opKpiActive', s.active_today);
    opSetTxt('opKpiCheckin', s.checked_in_today);
    opSetTxt('opKpiWorkouts', s.workouts_today);
    opSetTxt('opKpiMeals', s.meals_today);
    opSetTxt('opKpiTrials', s.new_trials_7d);
    opSetTxt('opKpiExpiring', s.expiring_trials_3d);
    opSetTxt('opKpiRisk', (s.at_risk_p0 || 0) + (s.at_risk_p1 || 0));

    var eng = data.engagement || {};
    var meters = [
      { l: 'Active today', v: eng.active_rate || 0, sub: (s.active_today || 0) + '/' + (s.total_clients || 0), invert: false },
      { l: 'Checked in', v: eng.checkin_rate || 0, sub: (s.checked_in_today || 0) + '/' + (s.total_clients || 0), invert: false },
      { l: 'Avg consistency', v: eng.avg_consistency_pct || 0, sub: '7-day', invert: false },
      { l: 'At risk', v: eng.at_risk_rate || 0, sub: ((s.at_risk_p0 || 0) + (s.at_risk_p1 || 0)) + ' clients', invert: true }
    ];
    var mEl = opEl('opMeters');
    if (mEl) {
      mEl.innerHTML = meters.map(function (m) {
        var cls = m.invert ? (m.v >= 40 ? 'bad' : (m.v >= 20 ? 'warn' : 'ok'))
          : (m.v < 30 ? 'bad' : (m.v < 60 ? 'warn' : 'ok'));
        return '<div class="op-meter"><div class="op-meter-top"><span class="op-meter-l">' + opEsc(m.l) + '<br>' + opEsc(m.sub) + '</span>'
          + '<span class="op-meter-v">' + m.v + '%</span></div>'
          + '<div class="op-track"><div class="op-fill ' + cls + '" data-w="' + m.v + '"></div></div></div>';
      }).join('');
      opAnimateBars(mEl);
    }
    opDrawTrendChart(data.trends);
  } catch (e) { }
}

function opDrawTrendChart(trends) {
  if (typeof Chart === 'undefined' || !trends) return;
  var el = opEl('opTrendChart'); if (!el) return;
  opKillChart('trend');
  var tick = '#8d877a', grid = 'rgba(255,255,255,0.05)';
  var labels = (trends.labels || []).map(function (d) {
    var dt = new Date(d); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  window._opCharts.trend = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Check-ins', data: trends.checkins || [], backgroundColor: 'rgba(91,191,122,0.75)', borderRadius: 3, maxBarThickness: 12 },
        { label: 'Workouts', data: trends.workouts || [], backgroundColor: 'rgba(200,164,78,0.8)', borderRadius: 3, maxBarThickness: 12 },
        { label: 'Meals', data: trends.meals || [], backgroundColor: 'rgba(106,193,214,0.7)', borderRadius: 3, maxBarThickness: 12 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: tick, font: { size: 10 }, boxWidth: 10, padding: 9 } } },
      scales: {
        x: { stacked: true, ticks: { color: tick, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: tick, font: { size: 9 }, precision: 0 }, grid: { color: grid } }
      }
    }
  });
}

/* ------------------------------------------------------- attention queue */
// The console's reason for existing: one ranked list of who needs the operator
// today, and why. Derived from the roster + compliance reads already in memory,
// so it costs no extra request and always agrees with the other screens.
function opAttentionRows() {
  var comp = opState.complianceMap || {};
  var rows = [];
  (opState.clients || []).forEach(function (c) {
    var k = comp[c.id] || {};
    var flags = [], p = 9;
    var idle = c.inactive_days || 0;

    if (idle >= 5) { flags.push({ t: idle + 'd silent', p: 0, g: 'silent' }); p = Math.min(p, 0); }
    else if (idle >= 2) { flags.push({ t: idle + 'd silent', p: 1, g: 'silent' }); p = Math.min(p, 1); }

    if ((c.subscription_status || '') === 'trialing') {
      var left = opDaysUntil(c.access_expires_at);
      if (left != null && left <= 3) {
        flags.push({ t: left <= 0 ? 'Trial ended' : 'Trial ends in ' + left + 'd', p: 0, g: 'trial' });
        p = Math.min(p, 0);
      } else {
        flags.push({ t: 'On trial', p: 2, g: 'trial' });
        p = Math.min(p, 2);
      }
    }
    if ((c.workouts_7d || 0) === 0) { flags.push({ t: 'No workout · 7d', p: 1, g: 'compliance' }); p = Math.min(p, 1); }
    if (k.daily_today === 0) { flags.push({ t: 'No check-in today', p: 2, g: 'compliance' }); p = Math.min(p, 2); }
    if (k.sunday_week === 0) { flags.push({ t: 'Missed Sunday', p: 2, g: 'compliance' }); p = Math.min(p, 2); }

    if (flags.length) rows.push({ c: c, flags: flags, p: p, idle: idle });
  });
  rows.sort(function (a, b) { return (a.p - b.p) || (b.idle - a.idle) || (a.c.first_name || '').localeCompare(b.c.first_name || ''); });
  return rows;
}

function opRenderAttention() {
  var host = opEl('opAttentionList'); if (!host) return;
  if (!opState.clients.length) { host.innerHTML = '<div class="op-empty">Loading roster…</div>'; return; }
  var filter = opState.attentionFilter || 'all';
  var rows = opAttentionRows().filter(function (r) {
    if (filter === 'all') return true;
    if (filter === 'p0') return r.p === 0;
    return r.flags.some(function (f) { return f.g === filter; });
  });

  var cnt = opEl('opAttentionCount');
  if (cnt) cnt.textContent = rows.length;
  var badge = opEl('opRailBadgeToday');
  if (badge) {
    var p0 = opAttentionRows().filter(function (r) { return r.p === 0; }).length;
    badge.textContent = p0 > 99 ? '99+' : p0;
    badge.classList.toggle('on', p0 > 0);
  }

  host.innerHTML = rows.length ? rows.map(opAttentionRow).join('')
    : '<div class="op-empty pad">✓ Nobody needs chasing right now.<br>Every client is inside the check-in, workout and trial windows.</div>';
}

function opAttentionRow(r) {
  var c = r.c, name = opFullName(c);
  var colors = ['#e0785a', '#e0b24e', '#6ac1d6'];
  var pc = colors[Math.min(r.p, 2)];
  var wa = opWa(c.phone);
  var id = opEsc(String(c.id));
  return '<div class="op-att" style="--pc:' + pc + '" onclick="opAttentionOpen(\'' + id + '\')">'
    + opAvatar(c.profile_picture, name)
    + '<div class="op-att-main">'
    + '<div class="op-att-name">' + opEsc(name) + '</div>'
    + '<div class="op-att-why">' + r.flags.slice(0, 3).map(function (f) {
      return '<span class="op-flag p' + Math.min(f.p, 2) + '">' + opEsc(f.t) + '</span>';
    }).join('') + '</div>'
    + '<div class="op-att-num">' + (c.checkins_7d || 0) + '/7 check-ins · ' + (c.workouts_7d || 0) + ' workouts · last active ' + opEsc(opTimeAgo(c.last_checkin_date || c.last_workout_at || c.created_at) || '—') + '</div>'
    + '</div>'
    + '<div class="op-att-acts" onclick="event.stopPropagation()">'
    + (wa ? '<a class="op-mini-btn wa" href="' + wa + '" target="_blank" rel="noopener" title="WhatsApp">💬</a>' : '')
    + '<button type="button" class="op-mini-btn" title="Send a reminder" onclick="opComposeFor(\'' + id + '\',\'' + opEsc(name).replace(/'/g, "\\'") + '\',\'reminder\')">✉</button>'
    + '<button type="button" class="op-mini-btn" title="Open profile" onclick="opAttentionOpen(\'' + id + '\')">→</button>'
    + '</div></div>';
}
function opAttentionOpen(id) { opNav('clients'); openOperatorClient(id, 'clients', 'profile'); }
function opAttentionFilter(v) { opState.attentionFilter = v; opRenderAttention(); }

/* ------------------------------------------------------------- live feed */
function setOperatorActivityType(t) { opState.activityType = t; loadOperatorActivity(); }

async function loadOperatorActivity() {
  var el = opEl('opLiveList'); if (!el) return;
  var type = (opEl('opActivityType') || {}).value || opState.activityType || 'all';
  opState.activityType = type;
  var days = (opEl('opActivityDays') || {}).value || '7';
  el.innerHTML = '<div class="op-empty">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/activity?type=' + encodeURIComponent(type) + '&days=' + encodeURIComponent(days));
    if (!d || d.error) { el.innerHTML = '<div class="op-empty">' + opEsc((d && d.error) || 'Could not load activity.') + '</div>'; return; }
    var items = d.items || [];
    if (!items.length) { el.innerHTML = '<div class="op-empty">No activity in this period.</div>'; return; }
    var out = '', lastDay = null;
    items.forEach(function (f) {
      var k = opDayKey(f.created_at);
      if (k !== lastDay) { lastDay = k; out += '<div class="op-day-sep">' + opEsc(opDayLabel(f.created_at)) + '</div>'; }
      out += '<div class="op-feed-item"><span class="op-dot ' + opEsc(f.type || '') + '"></span>'
        + '<div class="op-feed-main"><div class="op-feed-name">' + opEsc(f.name || '') + '</div>'
        + '<div class="op-feed-label">' + opEsc(f.label || '') + (f.detail ? ' — ' + opEsc(f.detail) : '') + '</div></div>'
        + '<span class="op-feed-time">' + opEsc(opTimeAgo(f.created_at)) + '</span></div>';
    });
    el.innerHTML = out;
    var c = opEl('opLiveCount'); if (c) c.textContent = items.length;
  } catch (e) { el.innerHTML = '<div class="op-empty">Could not load activity.</div>'; }
}

/* =============================================================== CLIENTS */
async function loadOperatorClients() {
  var el = opEl('opClientList');
  try {
    var d = await apiCall('GET', '/api/operator/clients');
    if (!d || d.error) { if (el) el.innerHTML = '<div class="op-empty">' + opEsc((d && d.error) || 'Could not load clients.') + '</div>'; return; }
    opState.clients = d.rows || [];
    renderOperatorClients();
    opRenderAttention();
  } catch (e) { if (el) el.innerHTML = '<div class="op-empty">Could not load clients.</div>'; }
}

async function loadOperatorCompliance() {
  try {
    var d = await apiCall('GET', '/api/operator/compliance');
    if (!d || d.error) return;
    var map = {};
    (d.clients || []).forEach(function (r) { map[r.id] = r; });
    opState.complianceMap = map;
    opState.complianceSummary = d.summary || null;
    if (opState.clientsMode === 'compliance') renderOperatorClients();
    opRenderAttention();
  } catch (e) { }
}

function opClientsMode(mode) {
  opState.clientsMode = mode;
  document.querySelectorAll('#opClientsSeg .op-seg-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-cv') === mode);
  });
  var sortWrap = opEl('opClientSort');
  if (sortWrap) sortWrap.style.display = mode === 'compliance' ? 'none' : '';
  renderOperatorClients();
}

function renderOperatorClients() {
  var el = opEl('opClientList'); if (!el) return;
  var list = opState.clients || [];
  var q = ((opEl('opClientSearch') || {}).value || '').trim();
  var filter = (opEl('opClientFilter') || {}).value || 'all';
  var sort = (opEl('opClientSort') || {}).value || 'inactive';
  var comp = opState.complianceMap || {};

  var rows = list.filter(function (c) {
    if (q && !bbContactMatches(q, [c.first_name, c.last_name, c.email], [c.phone])) return false;
    var k = comp[c.id] || {};
    if (filter === 'risk') return (c.inactive_days || 0) >= 2;
    if (filter === 'active') return (c.inactive_days || 0) < 2;
    if (filter === 'trialing') return (c.subscription_status || '') === 'trialing';
    if (filter === 'nocheckin') return k.daily_today === 0;
    if (filter === 'noworkout') return (c.workouts_7d || 0) === 0;
    if (filter === 'nosunday') return k.sunday_week === 0;
    return true;
  });

  if (opState.clientsMode === 'compliance') {
    rows.sort(function (a, b) {
      var ka = comp[a.id] || {}, kb = comp[b.id] || {};
      var ma = (ka.daily_today > 0 ? 0 : 1) + ((a.workouts_7d || 0) > 0 ? 0 : 1) + (ka.sunday_week > 0 ? 0 : 1);
      var mb = (kb.daily_today > 0 ? 0 : 1) + ((b.workouts_7d || 0) > 0 ? 0 : 1) + (kb.sunday_week > 0 ? 0 : 1);
      return mb - ma;
    });
  } else {
    rows.sort(function (a, b) {
      if (sort === 'name') return opFullName(a).toLowerCase().localeCompare(opFullName(b).toLowerCase());
      if (sort === 'checkins') return (b.checkins_7d || 0) - (a.checkins_7d || 0);
      if (sort === 'workouts') return (b.workouts_7d || 0) - (a.workouts_7d || 0);
      return (b.inactive_days || 0) - (a.inactive_days || 0);
    });
  }

  var cnt = opEl('opClientCount');
  if (cnt) cnt.textContent = rows.length + (rows.length === list.length ? '' : ' / ' + list.length);

  var sum = opEl('opComplianceSummary');
  if (sum) {
    var s = opState.complianceSummary;
    if (opState.clientsMode === 'compliance' && s) {
      sum.style.display = '';
      sum.innerHTML = '<div class="op-meters" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 10px">'
        + opCompSum(s.missed_daily_today || 0, 'Missed daily today')
        + opCompSum(s.no_workout_week || 0, 'No workout · 7d')
        + opCompSum(s.missed_sunday || 0, 'Missed Sunday')
        + '</div>';
    } else { sum.style.display = 'none'; sum.innerHTML = ''; }
  }

  el.innerHTML = rows.length
    ? rows.map(opState.clientsMode === 'compliance' ? opComplianceRow : opClientRow).join('')
    : '<div class="op-empty">No clients match this view.</div>';
  opAnimateBars(el);
  opMarkSelectedClient();
}
function opCompSum(n, l) {
  return '<div class="op-meter" style="text-align:center;padding:9px 6px"><div style="font-family:Syne,sans-serif;font-size:19px;font-weight:700;color:' + (n ? '#e0785a' : '#5bbf7a') + ';line-height:1">' + n + '</div>'
    + '<div class="op-meter-l" style="margin-top:5px">' + opEsc(l) + '</div></div>';
}

function opClientRow(c) {
  var name = opFullName(c);
  var idle = c.inactive_days || 0;
  var pill = idle >= 5 ? '<span class="op-pill bad">' + idle + 'd idle</span>'
    : (idle >= 2 ? '<span class="op-pill warn">' + idle + 'd idle</span>' : '<span class="op-pill ok">Active</span>');
  var trial = (c.subscription_status === 'trialing') ? '<span class="op-pill gold">Trial</span>' : '';
  var consist = Math.max(0, Math.min(100, Math.round(((c.checkins_7d || 0) / 7) * 100)));
  return '<div class="op-row" data-cid="' + opEsc(String(c.id)) + '" onclick="openOperatorClient(\'' + opEsc(String(c.id)) + '\',\'clients\')">'
    + opAvatar(c.profile_picture, name)
    + '<div class="op-row-main"><div class="op-row-name">' + opEsc(name) + '</div>'
    + '<div class="op-row-sub">' + opEsc(c.email || '') + '</div>'
    + '<div class="op-spark" title="' + (c.checkins_7d || 0) + '/7 check-ins this week"><i data-w="' + consist + '"></i></div></div>'
    + '<div class="op-row-right">'
    + '<div class="op-row-stat"><div class="op-row-stat-v">' + (c.checkins_7d || 0) + '</div><div class="op-row-stat-l">chk</div></div>'
    + '<div class="op-row-stat"><div class="op-row-stat-v">' + (c.workouts_7d || 0) + '</div><div class="op-row-stat-l">wkt</div></div>'
    + trial + pill + '</div></div>';
}

function opComplianceRow(c) {
  var k = (opState.complianceMap || {})[c.id] || {};
  var name = opFullName(c);
  var dOk = (k.daily_today || 0) > 0, wOk = (c.workouts_7d || 0) > 0, sOk = (k.sunday_week || 0) > 0;
  var sub = 'Daily ' + (k.daily_7d || 0) + '/7 · last ' + (opTimeAgo(k.last_daily || k.last_workout || c.created_at) || '—');
  return '<div class="op-row" data-cid="' + opEsc(String(c.id)) + '" onclick="openOperatorClient(\'' + opEsc(String(c.id)) + '\',\'clients\')">'
    + opAvatar(c.profile_picture, name)
    + '<div class="op-row-main"><div class="op-row-name">' + opEsc(name) + '</div><div class="op-row-sub">' + opEsc(sub) + '</div></div>'
    + '<div class="op-c3">'
    + '<span class="' + (dOk ? 'ok' : 'miss') + '">DAY<b>' + (dOk ? '✓' : '✗') + '</b></span>'
    + '<span class="' + (wOk ? 'ok' : 'miss') + '">WKT<b>' + (wOk ? '✓' : '✗') + '</b></span>'
    + '<span class="' + (sOk ? 'ok' : 'miss') + '">SUN<b>' + (sOk ? '✓' : '✗') + '</b></span>'
    + '</div></div>';
}
function opMarkSelectedClient() {
  var id = window._opCurrentClient && window._opCurrentClient.id;
  document.querySelectorAll('#opClientList .op-row, #opBloodList .op-row').forEach(function (r) {
    r.classList.toggle('sel', !!id && r.getAttribute('data-cid') === String(id));
  });
}

/* ======================================================= CLIENT DRILLDOWN */
var OP_HOSTS = {
  clients: { root: 'opClientDetail', head: 'opClientDetailHead', body: 'opClientDetailBody' },
  blood: { root: 'opBloodDetail', head: 'opBloodDetailHead', body: 'opBloodDetailBody' }
};
var OP_DETAIL_TABS = ['profile', 'overview', 'nutrition', 'workouts', 'body', 'blood', 'readiness'];

// Only one host ever holds a rendered profile, so the ids inside it stay unique
// across the Clients and Blood screens.
function opClearDetailHosts(except) {
  Object.keys(OP_HOSTS).forEach(function (k) {
    if (k === except) return;
    var h = OP_HOSTS[k];
    var body = opEl(h.body), head = opEl(h.head), root = opEl(h.root);
    if (body) body.innerHTML = opDetailBlank(k);
    if (head) head.innerHTML = opDetailHeadBlank(k);
    if (root) root.classList.remove('open');
  });
}
function opDetailBlank(kind) {
  return '<div class="op-blank">'
    + '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>'
    + '<div class="op-blank-t">' + (kind === 'blood' ? 'Pick a client' : 'Pick a client') + '</div>'
    + '<div class="op-blank-s">' + (kind === 'blood'
      ? 'Select someone on the left to upload a lab report, download the generated PDF, correct a lab date or run a longitudinal comparison.'
      : 'Select someone on the left to see their profile, training, nutrition, body, bloods and readiness — and to reach them in one tap.') + '</div></div>';
}
function opDetailHeadBlank(kind) {
  return '<div style="min-width:0"><div class="op-detail-name">' + (kind === 'blood' ? 'Blood workspace' : 'Client profile') + '</div>'
    + '<div class="op-detail-sub">Nothing selected</div></div>';
}

async function openOperatorClient(id, hostKey, tab) {
  hostKey = (hostKey && OP_HOSTS[hostKey]) ? hostKey : 'clients';
  tab = tab || (hostKey === 'blood' ? 'blood' : 'profile');
  opState.detailHost = hostKey;
  opClearDetailHosts(hostKey);

  var h = OP_HOSTS[hostKey];
  var root = opEl(h.root), head = opEl(h.head), body = opEl(h.body);
  if (root) root.classList.add('open');
  if (body) body.innerHTML = '<div class="op-empty pad">Loading client…</div>';

  try {
    var d = await apiCall('GET', '/api/operator/clients/' + encodeURIComponent(id));
    if (!d || d.error) { if (body) body.innerHTML = '<div class="op-empty pad">' + opEsc((d && d.error) || 'Could not load client.') + '</div>'; return; }
    window._opClientData = d;
    var u = d.user || {};
    var name = opFullName(u);
    window._opCurrentClient = { id: id, name: name, phone: u.phone || '', email: u.email || '' };
    opMarkSelectedClient();

    if (head) head.innerHTML = opDetailHead(u, d, hostKey);

    // A previous client's readiness/signal charts point at canvases that are
    // about to be replaced — tear them down before the DOM under them goes.
    if (typeof window.bbRdUnmount === 'function') window.bbRdUnmount('oprd');
    if (typeof window.bbSigUnmount === 'function') window.bbSigUnmount('opsig');
    Object.keys(window._opCharts).forEach(function (k) { if (k !== 'trend') opKillChart(k); });

    if (body) {
      body.innerHTML = opDetailActions(u) + opDetailTabsHtml() + opDetailPanes(d);
      body.scrollTop = 0;
      window._opDetailDrawn = {};
      opDetailTab(tab);
      opLoadReadinessCard(id);
    }
  } catch (e) {
    if (body) body.innerHTML = '<div class="op-empty pad">Could not load client.</div>';
  }
}

function opDetailHead(u, d, hostKey) {
  var name = opFullName(u);
  var idle = null;
  var roster = (opState.clients || []).filter(function (c) { return String(c.id) === String(u.id); })[0];
  if (roster) idle = roster.inactive_days;
  var pills = '';
  if (idle != null) pills += idle >= 5 ? '<span class="op-pill bad">' + idle + 'd idle</span>'
    : (idle >= 2 ? '<span class="op-pill warn">' + idle + 'd idle</span>' : '<span class="op-pill ok">Active</span>');
  if ((u.subscription_status || '') === 'trialing') {
    var left = opDaysUntil(u.access_expires_at);
    pills += '<span class="op-pill ' + (left != null && left <= 3 ? 'bad' : 'gold') + '">Trial' + (left != null ? ' · ' + (left <= 0 ? 'ended' : left + 'd') : '') + '</span>';
  }
  return '<button type="button" class="op-icon-btn op-detail-back" onclick="opCloseDetail()" aria-label="Back">'
    + '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>'
    + opAvatar(u.profile_picture, name, 'lg')
    + '<div style="min-width:0;flex:1"><div class="op-detail-name">' + opEsc(name) + '</div>'
    + '<div class="op-detail-sub">' + opEsc(u.email || '') + (u.phone ? ' · ' + opEsc(u.phone) : '') + '</div></div>'
    + '<div class="op-row-right">' + pills + '</div>';
}
function opCloseDetail() {
  var root = opEl(OP_HOSTS[opState.detailHost] ? OP_HOSTS[opState.detailHost].root : 'opClientDetail');
  if (root) root.classList.remove('open');
}
// Old name kept so any lingering caller still closes the profile.
function closeOperatorClientModal() { opCloseDetail(); }

function opDetailActions(u) {
  u = u || {};
  var wa = opWa(u.phone);
  var first = String(u.first_name || '').trim();
  var msg = encodeURIComponent('Hi ' + (first || 'there') + ', quick follow-up on your training — ');
  var h = '<div class="op-actbar">';
  if (wa) h += '<a class="op-btn wa" href="' + wa + '?text=' + msg + '" target="_blank" rel="noopener">💬 WhatsApp</a>';
  if (u.phone) h += '<a class="op-btn quiet" href="tel:' + opEsc(String(u.phone).replace(/[^0-9+]/g, '')) + '">📞 Call</a>';
  if (u.email) h += '<a class="op-btn quiet" href="mailto:' + opEsc(u.email) + '">✉️ Email</a>';
  h += '<button type="button" class="op-btn primary" onclick="opComposeReminder()">Send reminder</button>';
  h += '<button type="button" class="op-btn ghost" onclick="opComposeShare()">Share to Admin</button>';
  h += '<button type="button" class="op-btn line" onclick="opUploadBlood()">🩸 Upload blood</button>';
  h += '<button type="button" class="op-btn line" onclick="opOpenEliteCard()" title="Preview or download this client\'s Elite card">🪪 Elite card</button>';
  h += '<input type="file" id="opBloodFileInput" accept=".pdf,image/*" style="display:none" onchange="opBloodFilePicked(event)">';
  h += '</div><div id="opBloodMsg" style="display:none;font-size:12px;margin:-8px 0 12px"></div>';
  return h;
}
function opDetailTabsHtml() {
  var labels = { profile: 'Profile', overview: 'Overview', nutrition: 'Nutrition', workouts: 'Workouts', body: 'Body', blood: 'Blood', readiness: 'Readiness' };
  return '<div class="op-dtabs" id="opDetailTabs">' + OP_DETAIL_TABS.map(function (t) {
    return '<button type="button" class="op-dtab" data-dtab="' + t + '" onclick="opDetailTab(\'' + t + '\')">' + labels[t] + '</button>';
  }).join('') + '</div>';
}
function opDetailPanes(d) {
  return '<div id="opDetail-profile">' + opBuildProfile(d) + '</div>'
    + '<div id="opDetail-overview" style="display:none">' + opBuildOverview(d) + '</div>'
    + '<div id="opDetail-nutrition" style="display:none">' + opBuildNutrition(d) + '</div>'
    + '<div id="opDetail-workouts" style="display:none">' + opBuildWorkouts(d) + '</div>'
    + '<div id="opDetail-body" style="display:none">' + opBuildBody(d) + '</div>'
    + '<div id="opDetail-blood" style="display:none">' + opBuildBlood(d) + '</div>'
    + '<div id="opDetail-readiness" style="display:none">' + opBuildReadiness() + '</div>';
}

function opDetailTab(tab) {
  if (OP_DETAIL_TABS.indexOf(tab) === -1) tab = 'profile';
  opState.detailTab = tab;
  document.querySelectorAll('#opDetailTabs .op-dtab').forEach(function (b) {
    var on = b.getAttribute('data-dtab') === tab;
    b.classList.toggle('active', on);
    // Opening straight onto Blood must not leave the strip scrolled to Profile.
    if (on && b.scrollIntoView) { try { b.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { } }
  });
  OP_DETAIL_TABS.forEach(function (t) {
    var el = opEl('opDetail-' + t); if (el) el.style.display = (t === tab) ? 'block' : 'none';
  });
  var host = OP_HOSTS[opState.detailHost] || OP_HOSTS.clients;
  var scroller = opEl(host.body); if (scroller) scroller.scrollTop = 0;

  window._opDetailDrawn = window._opDetailDrawn || {};
  if (window._opDetailDrawn[tab]) return;
  window._opDetailDrawn[tab] = true;

  if (tab === 'overview') {
    opAnimateBars(opEl('opDetail-overview'));
    if (window._opCurrentClient) opLoadWeekly(window._opCurrentClient.id);
  } else if (tab === 'nutrition') opDrawNutritionChart();
  else if (tab === 'workouts') opDrawStrengthChart();
  else if (tab === 'body') { opDrawBodyWeightChart(); opLoadMuscleRanking(); }
  else if (tab === 'blood') opMountBlood();
  else if (tab === 'readiness') opMountReadiness();
  else if (tab === 'profile') opAnimateBars(opEl('opDetail-profile'));
}

// Re-open the current client so an upload, lab-date edit or delete shows up
// without the operator having to close and re-pick them.
function opRefreshClient() {
  var c = window._opCurrentClient;
  if (!c || !c.id) return;
  openOperatorClient(c.id, opState.detailHost, opState.detailTab);
  if (opState.screen === 'blood') loadOperatorBlood();
}

/* --------------------------------------------------------- detail: panes */
function opMstat(v, l) { return '<div class="op-mstat"><div class="op-mstat-v">' + v + '</div><div class="op-mstat-l">' + opEsc(l) + '</div></div>'; }
function opKV(l, r) { return r ? '<div class="op-line"><span class="op-line-l">' + opEsc(l) + '</span><span class="op-line-r">' + r + '</span></div>' : ''; }
function opSection(title, arr, mapFn) {
  arr = arr || [];
  if (!arr.length) return '';
  var rows = arr.map(function (r) {
    var p = mapFn(r);
    return '<div class="op-line"><span class="op-line-l">' + p[0] + '</span><span class="op-line-r">' + p[1] + '</span></div>';
  }).join('');
  return '<div class="op-sub">' + opEsc(title) + '</div><div class="op-lines">' + rows + '</div>';
}
function opLiftLabel(k) { return String(k || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

function opBuildProfile(d) {
  var u = d.user || {}, wts = d.weights || [], str = d.strength || [], wo = d.workouts || [], now = Date.now();
  var lw = (wts.length && wts[0].weight_kg != null) ? wts[0].weight_kg
    : ((d.body_snapshots && d.body_snapshots[0] && d.body_snapshots[0].bodyweight_kg != null) ? d.body_snapshots[0].bodyweight_kg : null);
  var trend = '';
  if (wts.length >= 2 && wts[0].weight_kg != null && wts[1].weight_kg != null) {
    var diff = Math.round((wts[0].weight_kg - wts[1].weight_kg) * 10) / 10;
    if (diff !== 0) trend = (diff > 0 ? '▲ +' : '▼ ') + diff + 'kg';
  }
  var bf = null;
  for (var i = str.length - 1; i >= 0; i--) { if (str[i].body_fat != null) { bf = str[i].body_fat; break; } }
  var wo7 = wo.filter(function (w) {
    var t = new Date(w.session_date || w.created_at).getTime();
    return !isNaN(t) && t >= now - 7 * 86400000;
  }).length;

  var h = '<div class="op-mstat-grid">';
  h += opMstat(lw != null ? lw + 'kg' : '–', trend ? ('Weight ' + trend) : 'Latest weight');
  h += opMstat(u.height_cm ? u.height_cm + 'cm' : '–', 'Height');
  h += opMstat(bf != null ? bf + '%' : '–', 'Body-fat');
  h += opMstat(wo7, 'Workouts · 7d');
  h += '</div>';

  h += '<div class="op-sub">Snapshot</div><div class="op-lines">';
  h += opKV('Age / Gender', opEsc([opAge(u.dob) ? opAge(u.dob) + 'y' : '', u.gender || ''].filter(Boolean).join(' · ')));
  h += opKV('Location', opEsc([u.city, u.country].filter(Boolean).join(', ')));
  h += opKV('Goal', opEsc([u.goal_type, u.diet_type].filter(Boolean).join(' · ')));
  var exp = u.access_expires_at ? new Date(u.access_expires_at).toLocaleDateString() : '';
  h += opKV('Membership', opEsc((u.subscription_status || 'active') + (u.plan_label ? ' · ' + u.plan_label : '') + (exp ? ' · until ' + exp : '')));
  h += '</div>';

  var lastWo = wo[0], big3 = null;
  wo.some(function (w) { if (w.bench_kg || w.squat_kg || w.deadlift_kg) { big3 = { b: w.bench_kg, s: w.squat_kg, dl: w.deadlift_kg }; return true; } return false; });
  if (!big3) {
    for (var j = str.length - 1; j >= 0; j--) {
      var r = str[j];
      if (r.strength_bench || r.strength_squat || r.strength_deadlift) { big3 = { b: r.strength_bench, s: r.strength_squat, dl: r.strength_deadlift }; break; }
    }
  }
  if (lastWo || big3) {
    h += '<div class="op-sub">Training</div><div class="op-lines">';
    if (lastWo) h += opKV('Last workout', opEsc((lastWo.workout_name || 'Workout') + ' · ' + opDate(lastWo.session_date || lastWo.created_at)));
    if (big3) h += opKV('Big 3 (kg)', opEsc([big3.b ? 'Bench ' + big3.b : '', big3.s ? 'Squat ' + big3.s : '', big3.dl ? 'DL ' + big3.dl : ''].filter(Boolean).join(' · ')));
    h += '</div>';
  }

  var sc = (d.sunday_checkins || [])[0];
  if (sc) {
    h += '<div class="op-sub">Latest Sunday check-in · ' + opEsc(opDate(sc.created_at)) + '</div><div class="op-lines">';
    h += opKV('Total weight loss', opEsc(sc.total_weight_loss || '—'));
    h += opKV('Training / Nutrition', opEsc([sc.training_go, sc.nutrition_go].filter(Boolean).join(' · ') || '—'));
    if (sc.sleep) h += opKV('Sleep', opEsc(sc.sleep));
    h += '</div>';
  }

  var dc = (d.daily_checkins || [])[0];
  if (dc) {
    var dline = [dc.steps ? dc.steps + ' steps' : '', dc.water_ml ? dc.water_ml + 'ml' : '', dc.protein_g ? dc.protein_g + 'g P' : '', dc.sleep_hours ? dc.sleep_hours + 'h sleep' : ''].filter(Boolean).join(' · ');
    h += '<div class="op-sub">Latest daily · ' + opEsc(opDate(dc.checkin_date)) + '</div><div class="op-lines">' + opKV('Logged', opEsc(dline || '—')) + '</div>';
  }

  // Filled by opLoadReadinessCard once the profile is in the DOM — the client
  // payload carries no wearable data, so this is its own read.
  h += '<div class="op-sub">Readiness</div><div id="opRdProfileCard"><div class="op-empty">Loading readiness…</div></div>';

  var bloods = opBloodList(d);
  h += '<div class="op-sub">Blood reports</div>';
  if (bloods.length) {
    var latest = bloods[0];
    h += '<div class="op-lines">' + opKV('On file', opEsc(String(bloods.length)) + ' · latest ' + bbLabDateLabel({ reportDate: latest.report_date || null, createdAt: latest.created_at })) + '</div>';
  } else {
    h += '<div class="op-empty">No blood reports uploaded yet.</div>';
  }
  h += '<div style="margin-top:8px"><button type="button" class="op-btn line" onclick="opDetailTab(\'blood\')">🩸 Open blood reports'
    + (bloods.length >= 2 ? ' &amp; comparison' : '') + '</button></div>';
  return h;
}

function opBuildOverview(d) {
  var u = d.user || {};
  var latestWeight = (d.weights && d.weights[0]) ? d.weights[0].weight_kg : null;
  var h = '<div class="op-mstat-grid">';
  h += opMstat(latestWeight != null ? latestWeight + 'kg' : '–', 'Latest weight');
  h += opMstat((d.daily_checkins || []).length, 'Check-ins');
  h += opMstat((d.workouts || []).length, 'Workouts');
  h += opMstat((d.meals || []).length, 'Meals');
  h += '</div>';

  var now = Date.now();
  var last7 = (d.daily_checkins || []).filter(function (r) {
    var t = new Date(r.checkin_date).getTime();
    return !isNaN(t) && t >= now - 7 * 86400000 && !r.is_freeze;
  }).length;
  var cpct = Math.round((Math.min(last7, 7) / 7) * 100);
  h += '<div class="op-bar-row"><div class="op-bar-top"><span class="op-bar-label">7-day check-in consistency</span>'
    + '<span class="op-bar-val">' + last7 + '/7</span></div><div class="op-bar-track">'
    + '<div class="op-bar-fill' + (cpct < 30 ? ' bad' : (cpct < 60 ? ' warn' : '')) + '" data-w="' + cpct + '"></div></div></div>';

  h += '<div class="op-lines" style="margin-top:10px">';
  h += opKV('Membership', opEsc(u.subscription_status || 'active') + (u.plan_label ? ' · ' + opEsc(u.plan_label) : ''));
  h += opKV('Access expires', opEsc(u.access_expires_at ? new Date(u.access_expires_at).toLocaleDateString() : '–'));
  if (u.height_cm || u.goal_type) h += opKV('Height / Goal', opEsc((u.height_cm ? u.height_cm + 'cm' : '') + (u.goal_type ? (u.height_cm ? ' · ' : '') + u.goal_type : '')));
  if (u.nutrition_ai_last_used_at || u.ai_trainer_last_used_at) {
    h += opKV('AI last used', opEsc('Nutrition ' + (opTimeAgo(u.nutrition_ai_last_used_at) || 'never') + ' · Trainer ' + (opTimeAgo(u.ai_trainer_last_used_at) || 'never')));
  }
  h += '</div>';

  h += '<div id="opWeeklyWrap" style="margin-top:16px"></div>';
  h += opSection('Recent daily check-ins', d.daily_checkins, function (r) {
    return [opEsc(opDate(r.checkin_date)), opEsc([r.steps ? r.steps + ' steps' : '', r.water_ml ? r.water_ml + 'ml' : '', r.protein_g ? r.protein_g + 'g P' : '', r.sleep_hours ? r.sleep_hours + 'h sleep' : ''].filter(Boolean).join(' · ') || '—')];
  });
  h += opSection('Weekly (Sunday) check-ins', d.sunday_checkins, function (r) {
    return [opEsc(r.plan || 'Check-in'), opEsc(opDate(r.created_at))];
  });
  return h;
}

function opBuildNutrition(d) {
  var meals = d.meals || [], daily = d.nutrition || [];
  var h = '';
  if (daily.length) h += '<div class="op-chart-card" style="margin-bottom:12px"><div class="op-sub" style="margin:0 0 8px">Calories &amp; protein (daily)</div><div class="op-chart-wrap sm"><canvas id="opNutChart"></canvas></div></div>';
  var latest = daily[0];
  if (latest) {
    h += '<div class="op-mstat-grid">';
    h += opMstat((latest.total_calories || 0), 'kcal · ' + opDate(latest.stat_date));
    h += opMstat((latest.total_protein || 0) + 'g', 'Protein');
    h += opMstat((latest.total_carbs || 0) + 'g', 'Carbs');
    h += opMstat((latest.total_fat || 0) + 'g', 'Fat');
    h += '</div>';
  }
  h += '<div class="op-sub">Recent meals (' + meals.length + ')</div>';
  h += meals.length ? '<div class="op-card-grid">' + meals.map(opMealCard).join('') + '</div>' : '<div class="op-empty">No meals logged.</div>';
  return h;
}
function opMealCard(m) {
  var ar = opParse(m.ai_result);
  var dish = ar.dish || m.manual_note || (m.meal_type || 'Meal');
  var macros = [ar.calories != null ? ar.calories + ' kcal' : '', ar.protein != null ? ar.protein + 'g P' : '', ar.carbs != null ? ar.carbs + 'g C' : '', ar.fat != null ? ar.fat + 'g F' : '', ar.fiber != null ? ar.fiber + 'g fiber' : ''].filter(Boolean).join(' · ');
  var score = m.meal_score != null ? '<span class="op-pill gold">' + m.meal_score + '/10</span>' : '';
  var note = (m.manual_note && m.manual_note !== dish) ? '<div class="op-card-note">📝 ' + opEsc(m.manual_note) + '</div>' : '';
  return '<div class="op-card"><div class="op-card-top"><span class="op-card-kind">' + opEsc(m.meal_type || 'meal') + ' · ' + opEsc(opDate(m.log_date)) + (m.portion_size ? ' · ' + opEsc(m.portion_size) : '') + '</span>' + score + '</div>'
    + '<div class="op-card-title">' + opEsc(dish) + '</div><div class="op-card-macros">' + opEsc(macros || '—') + '</div>' + note + '</div>';
}

function opBuildWorkouts(d) {
  var wk = d.workouts || [], str = d.strength || [];
  var hasStrength = str.some(function (r) { return r.strength_bench || r.strength_squat || r.strength_deadlift; });
  var h = '';
  if (hasStrength) h += '<div class="op-chart-card" style="margin-bottom:12px"><div class="op-sub" style="margin:0 0 8px">Strength over time (kg)</div><div class="op-chart-wrap sm"><canvas id="opStrChart"></canvas></div></div>';
  h += '<div class="op-sub">Recent sessions (' + wk.length + ')</div>';
  h += wk.length ? '<div class="op-card-grid">' + wk.map(opWorkoutCard).join('') + '</div>' : '<div class="op-empty">No workouts logged.</div>';
  return h;
}
function opWorkoutCard(w) {
  var lifts = opParse(w.session_lifts), reps = opParse(w.session_reps);
  var exRows = '';
  Object.keys(lifts).forEach(function (k) {
    var wt = lifts[k], rp = reps[k];
    exRows += '<div class="op-ex-row"><span class="op-ex-name">' + opEsc(opLiftLabel(k)) + '</span>'
      + '<span class="op-ex-val">' + (wt != null ? wt + 'kg' : '') + (rp != null ? ' × ' + rp : '') + '</span></div>';
  });
  var meta = [w.workout_type ? opEsc(w.workout_type) : '', w.duration_seconds ? Math.round(w.duration_seconds / 60) + ' min' : '', w.intensity ? opEsc(w.intensity) + ' intensity' : '', w.energy_level ? 'energy ' + opEsc(w.energy_level) : ''].filter(Boolean).join(' · ');
  var big = [w.bench_kg ? 'Bench ' + w.bench_kg + 'kg' : '', w.squat_kg ? 'Squat ' + w.squat_kg + 'kg' : '', w.deadlift_kg ? 'DL ' + w.deadlift_kg + 'kg' : ''].filter(Boolean).join(' · ');
  var done = w.workout_completed ? '<span class="op-pill ok">done</span>' : '';
  return '<div class="op-card"><div class="op-card-top"><span class="op-card-kind">' + opEsc(w.workout_name || 'Workout') + ' · ' + opEsc(opDate(w.session_date || w.created_at)) + '</span>' + done + '</div>'
    + (meta ? '<div class="op-card-macros" style="color:var(--op-muted)">' + meta + '</div>' : '')
    + (big ? '<div style="font-size:12px;color:var(--op-cream);margin-top:4px;font-weight:600">' + big + '</div>' : '')
    + (exRows ? '<div class="op-ex-list">' + exRows + '</div>' : '')
    + (w.feedback ? '<div class="op-card-note">💬 ' + opEsc(w.feedback) + '</div>' : '') + '</div>';
}

function opBuildBody(d) {
  var wts = d.weights || [], snaps = d.body_snapshots || [];
  var h = '';
  if (wts.length >= 2) h += '<div class="op-chart-card" style="margin-bottom:12px"><div class="op-sub" style="margin:0 0 8px">Weight trend</div><div class="op-chart-wrap sm"><canvas id="opBodyWtChart"></canvas></div></div>';
  else h += opSection('Weight log', wts, function (r) { return [opEsc(r.weight_kg != null ? r.weight_kg + ' kg' : '–'), opEsc(opDate(r.created_at))]; });
  h += '<div id="opMuscleWrap"><div class="op-sub">Muscle ranking</div><div class="op-empty">Loading…</div></div>';
  h += '<div class="op-sub">Progress photos &amp; measurements (' + snaps.length + ')</div>';
  h += snaps.length ? '<div class="op-card-grid">' + snaps.map(opBodySnapCard).join('') + '</div>' : '<div class="op-empty">No shared body snapshots.</div>';
  return h;
}
function opBodySnapCard(s) {
  var photos = [s.photo_front, s.photo_side, s.photo_back].filter(Boolean);
  var imgs = photos.map(function (p) { return '<img class="op-photo" src="' + opEsc(p) + '" alt="" loading="lazy">'; }).join('');
  var meta = [s.bodyweight_kg ? s.bodyweight_kg + 'kg' : '', s.waist_cm ? 'waist ' + s.waist_cm + 'cm' : ''].filter(Boolean).join(' · ');
  return '<div class="op-card"><div class="op-card-top"><span class="op-card-kind">' + opEsc(opDate(s.snapshot_date || s.created_at)) + '</span>'
    + '<span class="op-card-macros">' + opEsc(meta) + '</span></div>'
    + (imgs ? '<div class="op-photos">' + imgs + '</div>' : '')
    + (s.notes ? '<div class="op-card-note">' + opEsc(s.notes) + '</div>' : '') + '</div>';
}

async function opLoadMuscleRanking() {
  var wrap = opEl('opMuscleWrap'); if (!wrap || wrap._loaded) return;
  wrap._loaded = true;
  var id = window._opCurrentClient && window._opCurrentClient.id; if (!id) return;
  try {
    var d = await apiCall('GET', '/api/operator/clients/' + encodeURIComponent(id) + '/muscle-ranking');
    if (!d || d.error || !d.regions || !d.regions.length) { wrap.innerHTML = '<div class="op-sub">Muscle ranking</div><div class="op-empty">Not enough workout data yet.</div>'; return; }
    var h = '<div class="op-sub">Muscle ranking</div>';
    h += '<div class="op-lines" style="margin-bottom:8px">' + opKV('Overall audit index', opEsc(String(d.audit_index != null ? d.audit_index : '—')) + (d.audit_index_delta ? ' (' + (d.audit_index_delta > 0 ? '+' : '') + d.audit_index_delta + ')' : '')) + '</div>';
    (d.regions || []).forEach(function (r) {
      var pct = Math.max(0, Math.min(100, Math.round(r.score || 0)));
      h += '<div class="op-bar-row"><div class="op-bar-top"><span class="op-bar-label">' + opEsc(r.label || r.key) + (r.tier ? ' · ' + opEsc(r.tier) : '') + '</span>'
        + '<span class="op-bar-val" style="font-size:12px">' + (r.best_lift_kg ? r.best_lift_kg + 'kg' : '') + '</span></div>'
        + '<div class="op-bar-track"><div class="op-bar-fill" data-w="' + pct + '"></div></div></div>';
    });
    wrap.innerHTML = h;
    opAnimateBars(wrap);
  } catch (e) { wrap.innerHTML = '<div class="op-sub">Muscle ranking</div><div class="op-empty">Could not load.</div>'; }
}

/* ------------------------------------------------------- detail: charts */
var OP_TICK = '#8d877a', OP_GRID = 'rgba(255,255,255,0.05)';
function opDrawNutritionChart() {
  var d = window._opClientData; if (!d || typeof Chart === 'undefined') return;
  var el = opEl('opNutChart'); if (!el) return;
  opKillChart('nut');
  var rows = (d.nutrition || []).slice().reverse();
  window._opCharts.nut = new Chart(el.getContext('2d'), {
    data: {
      labels: rows.map(function (r) { return opDate(r.stat_date); }),
      datasets: [
        { type: 'bar', label: 'Calories', data: rows.map(function (r) { return r.total_calories || 0; }), backgroundColor: 'rgba(246,167,64,0.55)', yAxisID: 'y', borderRadius: 3, maxBarThickness: 14 },
        { type: 'line', label: 'Protein (g)', data: rows.map(function (r) { return r.total_protein || 0; }), borderColor: '#5fc88a', backgroundColor: 'rgba(95,200,138,0.15)', yAxisID: 'y1', tension: 0.3, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: OP_TICK, font: { size: 10 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 9 }, maxTicksLimit: 7 }, grid: { display: false } },
        y: { position: 'left', ticks: { color: OP_TICK, font: { size: 9 } }, grid: { color: OP_GRID } },
        y1: { position: 'right', ticks: { color: '#5fc88a', font: { size: 9 } }, grid: { display: false } }
      }
    }
  });
}
function opDrawStrengthChart() {
  var d = window._opClientData; if (!d || typeof Chart === 'undefined') return;
  var el = opEl('opStrChart'); if (!el) return;
  opKillChart('str');
  var rows = d.strength || [];
  window._opCharts.str = new Chart(el.getContext('2d'), {
    type: 'line',
    data: {
      labels: rows.map(function (r) { return opDate(r.created_at); }),
      datasets: [
        { label: 'Bench', data: rows.map(function (r) { return r.strength_bench; }), borderColor: '#f6a740', tension: 0.3, pointRadius: 2, spanGaps: true },
        { label: 'Squat', data: rows.map(function (r) { return r.strength_squat; }), borderColor: '#4aa8e0', tension: 0.3, pointRadius: 2, spanGaps: true },
        { label: 'Deadlift', data: rows.map(function (r) { return r.strength_deadlift; }), borderColor: '#9b8cf0', tension: 0.3, pointRadius: 2, spanGaps: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: OP_TICK, font: { size: 10 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 9 }, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: OP_TICK, font: { size: 9 } }, grid: { color: OP_GRID } }
      }
    }
  });
}
function opDrawBodyWeightChart() {
  var d = window._opClientData; if (!d || typeof Chart === 'undefined') return;
  var el = opEl('opBodyWtChart'); if (!el) return;
  var weights = (d.weights || []).slice().reverse();
  if (weights.length < 2) return;
  opKillChart('bodywt');
  window._opCharts.bodywt = new Chart(el.getContext('2d'), {
    type: 'line',
    data: {
      labels: weights.map(function (r) { return opDate(r.created_at); }),
      datasets: [{ label: 'Weight', data: weights.map(function (r) { return r.weight_kg; }), borderColor: '#c8a44e', backgroundColor: 'rgba(200,164,78,0.15)', fill: true, tension: 0.3, pointRadius: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 9 }, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: OP_TICK, font: { size: 9 } }, grid: { color: OP_GRID } }
      }
    }
  });
}

/* ------------------------------------------------------ detail: weekly */
var OP_WK_FMT = {
  steps: { label: 'Steps', color: '#f6a740', unit: '', div: 1 },
  water: { label: 'Water', color: '#4aa8e0', unit: 'L', div: 1000 },
  protein: { label: 'Protein', color: '#5fc88a', unit: 'g', div: 1 },
  sleep: { label: 'Sleep', color: '#9b8cf0', unit: 'h', div: 1 }
};
async function opLoadWeekly(id) {
  var wrap = opEl('opWeeklyWrap'); if (!wrap) return;
  wrap.innerHTML = '<div class="op-sub" style="margin-top:0">Last week performance</div><div class="op-empty">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/clients/' + encodeURIComponent(id) + '/weekly-report');
    if (!d || d.error) { wrap.innerHTML = ''; return; }
    opRenderWeekly(wrap, d);
  } catch (e) { wrap.innerHTML = ''; }
}
function opRenderWeekly(wrap, d) {
  var range = opDate(d.weekStart) + ' – ' + opDate(d.weekEnd);
  var html = '<div class="op-sub" style="margin-top:0">Last week performance</div>';
  html += '<div class="op-wk-head"><div class="op-wk-score">' + (d.overallScore || 0) + '<small>score</small></div>'
    + '<div class="op-wk-meta"><b>' + opEsc(range) + '</b><br>' + (d.goalsHit || 0) + '/' + (d.goalsTotal || 4) + ' goals hit · ' + (d.streak || 0) + '-day streak</div></div>';
  html += '<div class="op-wk-grid">';
  ['steps', 'water', 'protein', 'sleep'].forEach(function (k) {
    var m = (d.metrics || {})[k]; if (!m) return;
    var cfg = OP_WK_FMT[k];
    var actual = (m.actual || 0) / cfg.div, target = (m.target || 0) / cfg.div;
    var pct = Math.round(m.achievementPct || 0);
    var pcolor = pct >= 90 ? '#5bbf7a' : (pct >= 60 ? '#e0b24e' : '#e0785a');
    html += '<div class="op-wk-card"><div class="op-wk-c-top"><span class="op-wk-c-label">' + cfg.label + '</span>'
      + '<span class="op-wk-c-pct" style="color:' + pcolor + '">' + pct + '%</span></div>'
      + '<div class="op-wk-c-sub">' + opNum(actual) + cfg.unit + ' / ' + opNum(target) + cfg.unit + '</div>'
      + '<div class="op-wk-c-chart"><canvas id="opWk_' + k + '"></canvas></div></div>';
  });
  html += '</div>';
  wrap.innerHTML = html;
  ['steps', 'water', 'protein', 'sleep'].forEach(function (k) {
    var m = (d.metrics || {})[k]; if (m) opDrawWeekBar('opWk_' + k, m, OP_WK_FMT[k]);
  });
}
function opDrawWeekBar(id, m, cfg) {
  if (typeof Chart === 'undefined') return;
  var el = opEl(id); if (!el) return;
  opKillChart(id);
  var days = m.days || [];
  var vals = days.map(function (x) { return (x.value || 0) / cfg.div; });
  var goal = (m.dailyGoal || 0) / cfg.div;
  window._opCharts[id] = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: days.map(function (x) { return (x.label || '').slice(0, 1); }),
      datasets: [{ data: vals, backgroundColor: days.map(function (x) { return x.hitGoal ? cfg.color : 'rgba(255,255,255,0.16)'; }), borderRadius: 3, maxBarThickness: 13 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 9 } }, grid: { display: false } },
        y: { display: false, beginAtZero: true, suggestedMax: Math.max(goal, Math.max.apply(null, vals.concat([1]))) }
      }
    }
  });
}

/* -------------------------------------------------- detail: readiness */
// Signal intelligence sits above the raw mirror: the risk flags, the rejected
// hypotheses and the bloodwork bridge are what monitoring is actually for. Both
// panels are pure reads on /api/wearables/operator/* — nothing here writes.
function opBuildReadiness() {
  return '<div class="op-sub" style="margin-top:0">✦ Signal intelligence</div>'
    + '<div id="opDetailSignalBody"><div class="op-empty">Loading…</div></div>'
    + '<div class="op-sub">⌚ Raw readiness &amp; recovery</div>'
    + '<div id="opDetailReadinessBody"><div class="op-empty">Loading…</div></div>';
}
function opMountReadiness() {
  var c = window._opCurrentClient;
  var host = opEl('opDetailReadinessBody'), sigHost = opEl('opDetailSignalBody');
  if (!host) return;
  if (!c || !c.id) {
    host.innerHTML = '<div class="op-empty">No client selected.</div>';
    if (sigHost) sigHost.innerHTML = '<div class="op-empty">No client selected.</div>';
    return;
  }
  if (sigHost) {
    if (typeof window.bbSigMountStaff === 'function') {
      window.bbSigMountStaff({ key: 'opsig', scope: 'operator', el: 'opDetailSignalBody', userId: c.id, name: c.name || '' });
    } else {
      sigHost.innerHTML = '<div class="op-empty">Signal view is unavailable on this build.</div>';
    }
  }
  if (typeof window.bbRdMountClient !== 'function') { host.innerHTML = '<div class="op-empty">Readiness view is unavailable on this build.</div>'; return; }
  window.bbRdMountClient({ key: 'oprd', scope: 'operator', el: 'opDetailReadinessBody', userId: c.id, name: c.name || '' });
}
// One compact readiness card for the profile tab — the latest day that actually
// carries a score, its headline numbers and the change since the previous scored
// day. The facts come from bbRdSummarise, so nothing is computed twice.
function opReadinessCard(s) {
  if (!s) return '<div class="op-empty">No readiness data in the last 14 days.</div>';
  var when = s.isToday ? 'Today' : opEsc(s.dayLabel);
  var h = '<div class="op-card">';
  h += '<div class="op-card-top"><span style="font-weight:700;font-size:13px">' + (s.isDerived ? 'Readiness' : 'Recovery') + ' ' + opEsc(s.scoreText) + ' · ' + when + '</span>'
    + '<button type="button" class="op-btn line" style="padding:6px 10px;font-size:11.5px" onclick="opDetailTab(\'readiness\')">📈 Open</button></div>';
  h += '<div class="op-mstat-grid" style="margin:10px 0 0">' + s.metrics.map(function (m) { return opMstat(opEsc(m.text), m.label); }).join('') + '</div>';
  h += '<div class="op-lines">';
  h += opKV('Source', s.isDerived ? 'Derived from check-ins' : opEsc(s.source));
  h += opKV('Change', s.delta == null ? '— no earlier scored day' : opEsc((s.delta >= 0 ? '+' : '') + s.delta + ' vs ' + s.prevLabel));
  if (s.isDerived && s.confidence != null) h += opKV('Confidence', opEsc(String(s.confidence)) + ' · not measured');
  h += '</div></div>';
  return h;
}
async function opLoadReadinessCard(id) {
  var host = opEl('opRdProfileCard');
  if (!host) return;
  if (typeof window.bbRdSummarise !== 'function') { host.innerHTML = '<div class="op-empty">Readiness view is unavailable on this build.</div>'; return; }
  var ymd = function (d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  };
  var to = new Date(), from = new Date();
  from.setDate(from.getDate() - 13);
  try {
    var r = await apiCall('GET', '/api/wearables/operator/' + encodeURIComponent(id) +
      '/readiness?from=' + ymd(from) + '&to=' + ymd(to));
    if (!r || r.error) { host.innerHTML = '<div class="op-empty">' + opEsc((r && r.error) || 'Could not load readiness.') + '</div>'; return; }
    host.innerHTML = opReadinessCard(window.bbRdSummarise(r.readiness || []));
  } catch (e) {
    host.innerHTML = '<div class="op-empty">Could not load readiness.</div>';
  }
}

/* ================================================== BLOOD (client + console) */
function opBloodList(d) {
  var b = d && d.blood;
  return Array.isArray(b) ? b : (b ? [b] : []);
}
function opBloodFlags(ex) {
  ex = opParse(ex);
  var out = [];
  if (ex && Array.isArray(ex.panels)) {
    ex.panels.forEach(function (p) {
      (Array.isArray(p.markers) ? p.markers : []).forEach(function (m) {
        var st = String(m.status || '').toLowerCase();
        var fl = String(m.flag || '').trim().toUpperCase();
        if ((st && st !== 'normal' && st !== 'optimal') || fl === 'H' || fl === 'L') out.push(m);
      });
    });
  }
  return out;
}

// Operator uploads a blood report for the open client; it auto-processes.
function opUploadBlood() {
  var c = window._opCurrentClient;
  if (!c || !c.id) { showPopup('Client required', 'Open a client first.', '', 'OK', null, 'error'); return; }
  var inp = opEl('opBloodFileInput');
  if (inp) { inp.value = ''; inp.click(); }
}
function opBloodFilePicked(ev) {
  var f = ev.target && ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  var c = window._opCurrentClient;
  var msg = opEl('opBloodMsg');
  var show = function (color, html) { if (msg) { msg.style.display = 'block'; msg.style.color = color; msg.innerHTML = html; } };
  if (!c || !c.id) { show('#ff8a8a', 'No client selected.'); return; }
  var name = c.name || 'client';
  // Capture the lab date first — it decides where this report sits on the trend.
  bbAskLabDate({ clientName: name, fileName: f.name }, function (labDate) {
    if (!labDate) { show('#8a8880', 'Upload cancelled.'); return; }
    show('#8a8880', 'Reading file…');
    var reader = new FileReader();
    reader.onload = function () {
      var s = String(reader.result || ''); var i = s.indexOf(','); var b64 = i >= 0 ? s.slice(i + 1) : s;
      show('#8a8880', 'Uploading &amp; analysing for ' + opEsc(name) + ' (lab date ' + opEsc(bbFmtDay(labDate)) + ')… this can take a minute.');
      apiCall('POST', '/api/blood/admin/upload/' + encodeURIComponent(c.id), { bloodReportBase64: b64, bloodReportMimeType: f.type, symptoms: [], reportDate: labDate })
        .then(function (res) {
          if (res && res.error) { show('#ff8a8a', opEsc(res.error)); return; }
          show('#3dd68c', 'Uploaded &amp; analysis started for ' + opEsc(name) + ' (lab date ' + opEsc(bbFmtDay(labDate)) + '). Refreshing…');
          setTimeout(function () { opRefreshClient(); }, 1200);
        })
        .catch(function () { show('#ff8a8a', 'Upload failed. Please try again.'); });
    };
    reader.readAsDataURL(f);
  });
}

// One blood-report card. Operators have full parity with admins here, so this
// carries the same controls: the original lab file, the generated PDF, an
// editable lab date, and delete.
function opBloodReportCard(b, n) {
  b = b || {};
  var flags = opBloodFlags(b.extracted_blood_data);
  var complete = String(b.status || '').toLowerCase() === 'complete';
  var rid = String(b.id || '').replace(/'/g, "\\'");
  var asReport = { id: b.id, reportDate: b.report_date || null, createdAt: b.created_at };
  var btnStyle = 'flex:1 1 auto;min-width:92px;padding:8px 10px;font-size:12px';
  var actions = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">'
    + bbLabFileBtn(rid, !!b.has_source_file, btnStyle)
    + (complete
      ? '<button type="button" class="op-btn line" style="' + btnStyle + '" onclick="adminBloodDownloadPdf(\'' + rid + '\')">⬇ Report PDF</button>'
      : '<button type="button" class="op-btn line" disabled title="Analysis is not complete yet" style="' + btnStyle + '">⬇ Report PDF</button>')
    + bbDeleteReportBtn(rid, btnStyle, 'opRefreshClient')
    + '</div>';
  var status = complete ? '<span class="op-pill ok">complete</span>' : '<span class="op-pill warn">' + opEsc(String(b.status || 'pending')) + '</span>';
  var meta = [b.overall_status ? 'Overall: ' + b.overall_status : '', b.sent_to_user ? 'Sent to user' : '', flags.length ? (flags.length + ' flagged') : 'All in range'].filter(Boolean).join(' · ');
  var h = '<div class="op-card">';
  h += '<div class="op-card-top"><span style="font-weight:700;font-size:13px">Blood report ' + n + '</span>' + status + '</div>';
  h += '<div style="font-size:12px;color:var(--op-cream)">' + bbLabDateLabel(asReport) + '</div>';
  h += '<div style="font-size:12px;color:var(--op-muted);margin-top:5px">' + opEsc(meta) + '</div>';
  h += bbLabDateEditor(rid, asReport, 'opRefreshClient');
  if (flags.length) {
    h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">';
    flags.slice(0, 6).forEach(function (m) {
      h += '<span style="font-size:11px;background:rgba(255,92,92,0.12);border:1px solid rgba(255,92,92,0.3);color:#ff8a8a;border-radius:6px;padding:3px 8px">'
        + opEsc(String(m.name || 'Marker') + ' ' + [m.value, m.unit].filter(Boolean).join(' ') + (m.status ? ' (' + m.status + ')' : '')) + '</span>';
    });
    h += '</div>';
  }
  h += actions + '</div>';
  return h;
}

// The Blood tab: reports + the longitudinal comparison workspace, scoped to the
// open client. Same capabilities as the admin Blood Reports tab.
function opBuildBlood(d) {
  var bloods = opBloodList(d);
  var h = '<div class="op-actbar"><button type="button" class="op-btn primary" onclick="opUploadBlood()">🩸 Upload a report</button></div>';
  h += '<div class="op-sub" style="margin-top:0">Reports on file (' + bloods.length + ')</div>';
  if (!bloods.length) {
    h += '<div class="op-empty">No blood reports yet. Upload one above — you\'ll be asked for the lab test date so it lands correctly on the trend.</div>';
    return h;
  }
  h += '<div class="op-card-grid">';
  bloods.forEach(function (b, i) { h += opBloodReportCard(b, i + 1); });
  h += '</div>';

  // Only reports with extracted panel data can be compared.
  var comparable = bloods.filter(function (b) {
    var ex = opParse(b.extracted_blood_data);
    return ex && ex.panels && ex.panels.length;
  });
  h += '<div class="op-sub">Progress comparison</div>';
  if (comparable.length < 2) {
    h += '<div class="op-empty">Two or more processed reports are needed to compare. '
      + comparable.length + ' of ' + bloods.length + ' ' + (comparable.length === 1 ? 'is' : 'are') + ' processed so far.</div>';
    return h;
  }
  var undated = 0;
  var chips = comparable.slice().sort(function (a, b) {
    return new Date(a.report_date || a.created_at) - new Date(b.report_date || b.created_at);
  }).map(function (r, i) {
    if (!r.report_date) undated++;
    var label = r.report_date ? bbFmtDay(r.report_date) : (bbFmtDay(r.created_at) + ' (upload date)');
    return '<label style="display:inline-flex;align-items:center;gap:8px;border:1px solid '
      + (r.report_date ? 'rgba(255,255,255,0.14)' : 'rgba(245,166,35,0.4)')
      + ';border-radius:10px;padding:8px 12px;margin:0 8px 8px 0;cursor:pointer;font-size:12px">'
      + '<input type="checkbox" class="op-cmp-report" value="' + opEsc(String(r.id)) + '" onchange="opCompareSelectionChanged()" style="accent-color:#3dd68c"> '
      + '<span><strong>Test ' + (i + 1) + '</strong> · ' + opEsc(label)
      + (r.overall_status ? ' · ' + opEsc(r.overall_status) : '') + '</span></label>';
  }).join('');
  h += '<div style="font-size:12px;color:var(--op-cream);margin-bottom:6px">Select 2–6 reports to compare (oldest → newest by lab date)</div>';
  if (undated) {
    h += '<div style="margin-bottom:8px;padding:8px 10px;border-radius:8px;background:rgba(245,166,35,0.1);border:1px solid rgba(245,166,35,0.35);color:#f5c26b;font-size:11px">'
      + undated + ' report' + (undated === 1 ? ' has' : 's have') + ' no lab date and sit by upload date. Set the lab date above for an accurate trend.</div>';
  }
  h += chips;
  h += '<div style="margin-top:6px"><button type="button" id="opCompareRunBtn" class="op-btn primary" disabled onclick="opRunComparison()">Generate comparison</button></div>';
  h += '<div id="opCmpSaved" style="margin-top:14px"></div>';
  h += '<div id="opCmpResult" style="margin-top:14px"></div>';
  return h;
}
// Point the shared comparison workspace at the operator containers, then load
// this client's saved comparisons.
function opMountBlood() {
  var c = window._opCurrentClient;
  if (!c || !c.id) return;
  if (!opEl('opCmpSaved')) return; // fewer than 2 comparable reports
  bbCmpUseHost('opCmpResult', 'opCmpSaved', c.id);
  bbLoadClientComparisons(c.id);
}
function opCompareSelectionChanged() {
  var n = document.querySelectorAll('.op-cmp-report:checked').length;
  var btn = opEl('opCompareRunBtn');
  if (!btn) return;
  var ok = n >= 2 && n <= 6;
  btn.disabled = !ok;
  btn.textContent = 'Generate comparison' + (n ? ' (' + n + ' selected)' : '');
}
function opRunComparison() {
  var c = window._opCurrentClient;
  var ids = Array.prototype.map.call(document.querySelectorAll('.op-cmp-report:checked'), function (el) { return el.value; });
  if (!c || !c.id || ids.length < 2) return;
  bbCmpUseHost('opCmpResult', 'opCmpSaved', c.id);
  var res = opEl('opCmpResult'), btn = opEl('opCompareRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analysing trajectory… (Claude)'; }
  if (res) res.innerHTML = '<div class="op-empty">Aligning markers and running the AI progress verdict… this can take up to a minute.</div>';
  apiCall('POST', '/api/blood/admin/compare', { userId: c.id, reportIds: ids })
    .then(function (d) {
      if (!d || d.success === false || d.error) {
        if (res) res.innerHTML = '<div class="op-empty" style="color:#ff8a8a">' + opEsc((d && (d.error || d.message)) || 'Comparison failed') + '</div>';
        return;
      }
      bbRenderComparison(d.comparison, res);
      bbLoadClientComparisons(c.id);
    })
    .catch(function () { if (res) res.innerHTML = '<div class="op-empty" style="color:#ff8a8a">Network error</div>'; })
    .then(function () { opCompareSelectionChanged(); });
}

/* ---------------------------------------------------------- blood console */
async function loadOperatorBlood() {
  var el = opEl('opBloodList'); if (!el) return;
  if (!opState.blood) el.innerHTML = '<div class="op-empty">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/blood');
    if (!d || d.error) { el.innerHTML = '<div class="op-empty">' + opEsc((d && d.error) || 'Could not load blood reports.') + '</div>'; return; }
    opState.blood = d.rows || [];
    opState.bloodSummary = d.summary || null;
    var s = d.summary || {};
    opSetTxt('opBloodKpiReports', s.reports || 0);
    opSetTxt('opBloodKpiPending', s.pending || 0);
    opSetTxt('opBloodKpiCompare', s.comparisons || 0);
    opSetTxt('opBloodKpiNone', s.none || 0);
    renderOperatorBlood();
  } catch (e) { el.innerHTML = '<div class="op-empty">Could not load blood reports.</div>'; }
}
function renderOperatorBlood() {
  var el = opEl('opBloodList'); if (!el) return;
  var q = ((opEl('opBloodSearch') || {}).value || '').trim();
  var filter = (opEl('opBloodFilter') || {}).value || 'all';
  var rows = (opState.blood || []).filter(function (r) {
    if (q && !bbContactMatches(q, [r.first_name, r.last_name, r.email], [])) return false;
    if (filter === 'has') return (r.reports || 0) > 0;
    if (filter === 'pending') return (r.pending || 0) > 0;
    if (filter === 'comparable') return (r.reports || 0) >= 2;
    if (filter === 'none') return (r.reports || 0) === 0;
    return true;
  });
  var cnt = opEl('opBloodCount'); if (cnt) cnt.textContent = rows.length;
  el.innerHTML = rows.length ? rows.map(opBloodClientRow).join('') : '<div class="op-empty">No clients match this view.</div>';
  opMarkSelectedClient();
}
function opBloodClientRow(r) {
  var name = opFullName(r);
  var n = r.reports || 0;
  var pills = '';
  if (!n) pills = '<span class="op-pill warn">No report</span>';
  else {
    if (r.pending) pills += '<span class="op-pill info">' + r.pending + ' processing</span>';
    if (n >= 2) pills += '<span class="op-pill gold">' + n + ' reports</span>';
    else pills += '<span class="op-pill ok">1 report</span>';
  }
  var sub = n
    ? ('Latest lab ' + (r.latest_lab_date ? opEsc(bbFmtDay(r.latest_lab_date)) : '—')
      + (r.latest_overall ? ' · ' + opEsc(r.latest_overall) : '')
      + (r.comparisons ? ' · ' + r.comparisons + ' comparison' + (r.comparisons === 1 ? '' : 's') : ''))
    : opEsc(r.email || '');
  return '<div class="op-row" data-cid="' + opEsc(String(r.id)) + '" onclick="openOperatorClient(\'' + opEsc(String(r.id)) + '\',\'blood\',\'blood\')">'
    + opAvatar(r.profile_picture, name)
    + '<div class="op-row-main"><div class="op-row-name">' + opEsc(name) + '</div>'
    + '<div class="op-row-sub">' + sub + '</div></div>'
    + '<div class="op-row-right">' + pills + '</div></div>';
}

/* ================================================================= LEADS */
async function loadOperatorLeads() {
  var aEl = opEl('opLeadList');
  var days = (opEl('opLeadsDays') || {}).value || '30';
  if (aEl && !opState.leads) aEl.innerHTML = '<div class="op-empty">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/leads?days=' + encodeURIComponent(days));
    if (!d || d.error) { if (aEl) aEl.innerHTML = '<div class="op-empty">' + opEsc((d && d.error) || 'Could not load leads.') + '</div>'; return; }
    opState.leads = d;
    var c = d.counts || {};
    opSetTxt('opLeadKpiToday', c.audits_today || 0);
    opSetTxt('opLeadKpi7d', c.audits_7d || 0);
    opSetTxt('opLeadKpiPart2', c.part2_today || 0);
    opSetTxt('opLeadKpiNoAcct', c.audits_no_account || 0);
    renderOperatorLeads();
  } catch (e) { if (aEl) aEl.innerHTML = '<div class="op-empty">Could not load leads.</div>'; }
}
function opLeadsView(view) {
  opState.leadsView = view;
  document.querySelectorAll('#opLeadsSeg .op-seg-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-lv') === view);
  });
  renderOperatorLeads();
}
function renderOperatorLeads() {
  var el = opEl('opLeadList'); if (!el) return;
  var d = opState.leads || {};
  var q = ((opEl('opLeadsSearch') || {}).value || '').trim();
  var rows;
  if (opState.leadsView === 'part2') {
    rows = (d.part2 || []).filter(function (p) { return bbContactMatches(q, [p.name, p.email], [p.mobile]); })
      .map(function (p) { return { kind: 'part2', id: p.id, raw: p, name: p.name || p.email || 'Prospect', when: p.created_at, badges: opPart2Badges(p) }; });
  } else {
    rows = (d.audits || []).filter(function (a) { return bbContactMatches(q, [a.first_name, a.last_name, a.email], [a.phone]); })
      .map(function (a) { return { kind: 'audit', id: a.id, raw: a, name: opFullName(a), when: a.created_at, badges: opAuditBadges(a) }; });
  }
  var cnt = opEl('opLeadCount'); if (cnt) cnt.textContent = rows.length;
  el.innerHTML = rows.length ? rows.map(opLeadRow).join('')
    : '<div class="op-empty">' + (q ? 'Nothing matches this search.' : 'No submissions in this period.') + '</div>';
}
function opAuditBadges(a) {
  return (a.has_account ? '<span class="op-pill ok">Signed up</span>' : '<span class="op-pill bad">No account</span>')
    + (a.has_part2 ? '<span class="op-pill ok">Part-2</span>' : '<span class="op-pill warn">No Part-2</span>')
    + (a.stage ? '<span class="op-pill info">' + opEsc(opLiftLabel(a.stage)) + '</span>' : '');
}
function opPart2Badges(p) {
  return (p.has_account ? '<span class="op-pill ok">Signed up</span>' : '<span class="op-pill bad">No account</span>')
    + (p.tier_label ? '<span class="op-pill info">' + opEsc(p.tier_label) + (p.score != null ? ' · ' + p.score : '') + '</span>' : '');
}
function opLeadRow(r) {
  var raw = r.raw;
  var contact = [raw.email, raw.phone || raw.mobile].filter(Boolean).join(' · ');
  return '<div class="op-row" data-lid="' + opEsc(String(r.id)) + '" onclick="opLeadOpen(\'' + r.kind + '\',\'' + opEsc(String(r.id)) + '\')">'
    + opAvatar(null, r.name)
    + '<div class="op-row-main"><div class="op-row-name">' + opEsc(r.name) + '</div>'
    + '<div class="op-row-sub">' + opEsc(contact) + '</div>'
    + '<div class="op-badges" style="margin:5px 0 0">' + r.badges + '</div></div>'
    + '<span class="op-feed-time">' + opEsc(opDate(r.when)) + '</span></div>';
}
function opLeadOpen(kind, id) {
  var d = opState.leads || {};
  var raw = null;
  if (kind === 'part2') raw = (d.part2 || []).filter(function (p) { return String(p.id) === String(id); })[0];
  else raw = (d.audits || []).filter(function (a) { return String(a.id) === String(id); })[0];
  var head = opEl('opLeadDetailHead'), body = opEl('opLeadDetailBody'), root = opEl('opLeadDetail');
  if (!body) return;
  if (!raw) { body.innerHTML = '<div class="op-empty pad">This prospect is no longer in the loaded window.</div>'; return; }
  if (root) root.classList.add('open');
  document.querySelectorAll('#opLeadList .op-row').forEach(function (el) {
    el.classList.toggle('sel', el.getAttribute('data-lid') === String(id));
  });

  var name = kind === 'part2' ? (raw.name || raw.email || 'Prospect') : opFullName(raw);
  var phone = raw.phone || raw.mobile || '';
  if (head) {
    head.innerHTML = '<button type="button" class="op-icon-btn op-detail-back" onclick="opCloseLeadDetail()" aria-label="Back">'
      + '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>'
      + opAvatar(null, name, 'lg')
      + '<div style="min-width:0;flex:1"><div class="op-detail-name">' + opEsc(name) + '</div>'
      + '<div class="op-detail-sub">' + opEsc([raw.email, phone].filter(Boolean).join(' · ')) + '</div></div>'
      + '<span class="op-pill gold">' + (kind === 'part2' ? 'Part-2' : 'Body audit') + '</span>';
  }

  var h = '<div class="op-actbar">';
  var wa = opWa(phone);
  if (wa) h += '<a class="op-btn wa" href="' + wa + '" target="_blank" rel="noopener">💬 WhatsApp</a>';
  if (phone) h += '<a class="op-btn quiet" href="tel:' + opEsc(String(phone).replace(/[^0-9+]/g, '')) + '">📞 Call</a>';
  if (raw.email) h += '<a class="op-btn quiet" href="mailto:' + opEsc(raw.email) + '">✉️ Email</a>';
  h += '</div>';
  h += '<div class="op-badges">' + (kind === 'part2' ? opPart2Badges(raw) : opAuditBadges(raw)) + '</div>';

  h += '<div class="op-sub">Submitted</div><div class="op-lines">';
  h += opKV('Received', opEsc(new Date(raw.created_at).toLocaleString()));
  if (kind === 'audit') {
    h += opKV('Age / Sex', opEsc([raw.age ? raw.age + 'y' : '', raw.sex || ''].filter(Boolean).join(' · ')));
    h += opKV('Location', opEsc([raw.city, raw.country].filter(Boolean).join(', ')));
    h += opKV('Occupation', opEsc(raw.occupation || ''));
    h += opKV('Experience', opEsc(raw.fitness_experience || ''));
    h += opKV('Goal', opEsc(raw.goals || ''));
    h += opKV('Status', opEsc(raw.status || ''));
  } else {
    h += opKV('Goal', opEsc(raw.goals || ''));
    h += opKV('Gym experience', opEsc(raw.gym_experience || ''));
    h += opKV('Activity level', opEsc(raw.activity_level || ''));
    h += opKV('Injuries', opEsc(raw.injuries || ''));
    h += opKV('Score', raw.score != null ? opEsc(String(raw.score)) : '');
  }
  h += '</div>';
  if (kind === 'audit' && raw.motivation) {
    h += '<div class="op-sub">Why they reached out</div><div class="op-card"><div class="op-lead-info">' + opEsc(raw.motivation) + '</div></div>';
  }
  body.innerHTML = h;
  body.scrollTop = 0;
}
function opCloseLeadDetail() { var r = opEl('opLeadDetail'); if (r) r.classList.remove('open'); }

/* ================================================================= INBOX */
async function loadOperatorEscalations(quiet) {
  var el = opEl('opEscList');
  if (el && !quiet) el.innerHTML = '<div class="op-empty">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/escalations');
    if (!d || d.error) { if (el) el.innerHTML = '<div class="op-empty">' + opEsc((d && d.error) || 'Could not load.') + '</div>'; return; }
    var rows = d.rows || [];
    opState.escalations = rows;
    var unread = rows.filter(function (e) { return (e.admin_replies || 0) > 0 && e.last_role === 'admin'; }).length;
    var badge = opEl('opRailBadgeInbox');
    if (badge) { badge.textContent = unread > 99 ? '99+' : unread; badge.classList.toggle('on', unread > 0); }
    var cnt = opEl('opEscCount'); if (cnt) cnt.textContent = rows.length;
    if (el) {
      el.innerHTML = rows.length ? rows.map(opEscRow).join('')
        : '<div class="op-empty pad">Nothing shared with Admin yet.<br>Open a client and tap “Share to Admin” to start a thread.</div>';
    }
  } catch (e) { if (el) el.innerHTML = '<div class="op-empty">Could not load.</div>'; }
}
function opEscRow(e) {
  var replied = (e.admin_replies || 0) > 0;
  var badge = replied ? '<span class="op-esc-badge">Admin replied</span>'
    : '<span class="op-esc-badge" style="background:rgba(224,178,78,0.15);color:#e0b24e">Awaiting admin</span>';
  return '<div class="op-esc-row" data-eid="' + opEsc(String(e.id)) + '" onclick="opEscOpen(\'' + opEsc(String(e.id)) + '\')">'
    + '<div class="op-esc-top"><span class="op-esc-name">' + opEsc(e.client_name || 'Client') + '</span>' + badge + '</div>'
    + '<div class="op-esc-sum">' + opEsc(e.summary || '') + '</div>'
    + '<div class="op-esc-last">' + opEsc((e.last_role === 'admin' ? 'Admin: ' : 'You: ') + (e.last_body || '')) + '</div></div>';
}
function opRenderEscMessages(el, msgs, myRole) {
  el.innerHTML = '<div class="op-chat">' + (msgs.length ? msgs.map(function (m) {
    var mine = m.sender_role === myRole;
    var who = m.sender_role === 'admin' ? 'Admin' : (m.sender_name || 'Operator');
    return '<div class="op-bubble ' + (mine ? 'me' : 'them') + '"><div class="op-bubble-who">' + opEsc(who) + ' · ' + opEsc(opTimeAgo(m.created_at)) + '</div>' + opEsc(m.body || '') + '</div>';
  }).join('') : '<div class="op-empty">No messages.</div>') + '</div>';
}
async function opEscOpen(eid) {
  opState.escId = eid;
  var root = opEl('opEscDetail'), head = opEl('opEscDetailHead'), body = opEl('opEscDetailBody');
  if (root) root.classList.add('open');
  document.querySelectorAll('#opEscList .op-esc-row').forEach(function (el) {
    el.classList.toggle('sel', el.getAttribute('data-eid') === String(eid));
  });
  if (body) body.innerHTML = '<div class="op-empty">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/escalations/' + encodeURIComponent(eid) + '/messages');
    if (!d || d.error) { if (body) body.innerHTML = '<div class="op-empty">Could not load.</div>'; return; }
    var e = d.escalation || {};
    if (head) {
      head.innerHTML = '<button type="button" class="op-icon-btn op-detail-back" onclick="opCloseEscDetail()" aria-label="Back">'
        + '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>'
        + '<div style="min-width:0;flex:1"><div class="op-detail-name">Re: ' + opEsc(e.client_name || 'Client') + '</div>'
        + '<div class="op-detail-sub">' + opEsc(e.summary || '') + '</div></div>'
        + (e.client_id ? '<button type="button" class="op-btn line" onclick="opAttentionOpen(\'' + opEsc(String(e.client_id)) + '\')">Open client</button>' : '');
    }
    body.innerHTML = '<div class="op-thread"><div class="op-chat-wrap" id="opEscMessages"></div>'
      + '<div class="op-reply-row"><textarea id="opEscReplyText" placeholder="Reply to admin…"></textarea>'
      + '<button type="button" onclick="opEscReply()">Send</button></div></div>';
    opRenderEscMessages(opEl('opEscMessages'), d.messages || [], 'operator');
    body.scrollTop = body.scrollHeight;
  } catch (e) { if (body) body.innerHTML = '<div class="op-empty">Could not load.</div>'; }
}
function opCloseEscDetail() { var r = opEl('opEscDetail'); if (r) r.classList.remove('open'); }
async function opEscReply() {
  var eid = opState.escId; if (!eid) return;
  var ta = opEl('opEscReplyText'); if (!ta) return;
  var txt = (ta.value || '').trim(); if (!txt) return;
  try {
    var r = await apiCall('POST', '/api/operator/escalations/' + encodeURIComponent(eid) + '/reply', { body: txt });
    if (r && r.error) { showPopup('Error', r.error, '', 'OK', null, 'error'); return; }
    ta.value = '';
    opEscOpen(eid);
    loadOperatorEscalations(true);
  } catch (e) { }
}
// Old modal entry point, kept so any lingering caller lands on the Inbox screen.
function closeOpEsc() { opCloseEscDetail(); }

/* =============================================================== COMPOSE */
function opComposeFor(id, name, mode) {
  window._opCurrentClient = window._opCurrentClient && String(window._opCurrentClient.id) === String(id)
    ? window._opCurrentClient : { id: id, name: name };
  window._opComposeMode = mode || 'reminder';
  var title = opEl('opCmTitle'), hint = opEl('opCmHint'), text = opEl('opCmText');
  if (mode === 'share') {
    if (title) title.textContent = 'Share ' + name + ' with Admin';
    if (hint) hint.textContent = 'Admin gets notified, can review this client, and reply to you. A snapshot of recent activity is attached automatically.';
  } else {
    if (title) title.textContent = 'Send reminder to ' + name;
    if (hint) hint.textContent = 'This appears in the client’s Messages as a coach message and sends them a push notification.';
  }
  if (text) text.value = '';
  var m = opEl('opComposeModal'); if (m) m.classList.add('open');
  setTimeout(function () { if (text) text.focus(); }, 60);
}
function opComposeReminder() {
  var c = window._opCurrentClient; if (!c) return;
  opComposeFor(c.id, c.name, 'reminder');
}
function opComposeShare() {
  var c = window._opCurrentClient; if (!c) return;
  opComposeFor(c.id, c.name, 'share');
}
function closeOpCompose() { var o = opEl('opComposeModal'); if (o) o.classList.remove('open'); }
async function opComposeSend() {
  var c = window._opCurrentClient; if (!c) return;
  var txt = ((opEl('opCmText') || {}).value || '').trim();
  if (!txt) return;
  var btn = opEl('opCmSend'); if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    var share = window._opComposeMode === 'share';
    var url = '/api/operator/clients/' + encodeURIComponent(c.id) + (share ? '/share-to-admin' : '/reminder');
    var r = await apiCall('POST', url, share ? { note: txt } : { body: txt });
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    if (r && r.error) { showPopup('Error', r.error, '', 'OK', null, 'error'); return; }
    closeOpCompose();
    if (share) {
      showPopup('Shared with Admin', 'Admin has been notified and can reply to you in the Inbox.', '', 'OK');
      loadOperatorEscalations(true);
    } else {
      showPopup('Reminder sent', 'The client received your message in their chat.', '', 'OK');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    showPopup('Error', 'Could not send. Please try again.', '', 'OK', null, 'error');
  }
}

/* ========================================================= NOTIFICATIONS */
function openOperatorAlerts() { var b = document.querySelector('#operatorPanel .admin-notify-btn'); if (b) b.click(); }

async function loadOperatorNotifications() {
  try {
    var list = await apiCall('GET', '/api/notifications');
    var el = opEl('opNotifyList'), countEl = opEl('opNotifyCount');
    if (!el) return;
    var cleared = (typeof getClearedNotifyIds === 'function') ? getClearedNotifyIds() : [];
    var filtered = Array.isArray(list) ? list.filter(function (n) { return n.id && cleared.indexOf(n.id) === -1; }) : [];
    window._opNotifyIds = filtered.map(function (n) { return n.id; });
    try {
      var skip = false;
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        skip = !!sub;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !skip && typeof showBrowserNotification === 'function') {
        var sent = (typeof getBrowserNotifiedIds === 'function') ? getBrowserNotifiedIds() : [];
        var fresh = [];
        filtered.forEach(function (n) { if (n.id && sent.indexOf(n.id) === -1) { showBrowserNotification(n); fresh.push(n.id); } });
        if (fresh.length && typeof setBrowserNotifiedIds === 'function') setBrowserNotifiedIds(sent.concat(fresh));
      }
    } catch (e) { }
    el.innerHTML = filtered.length ? filtered.map(function (n) {
      var time = n.time ? new Date(n.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return '<div class="admin-notify-item ' + opEsc(n.type || '') + '"><div class="n-body"><div class="n-title">' + opEsc(n.title || '') + '</div>'
        + '<div class="n-desc">' + opEsc(n.desc || '') + '</div><div class="n-time">' + opEsc(time) + '</div></div></div>';
    }).join('') : '<div class="admin-notify-empty">No notifications yet.</div>';
    if (countEl) {
      if (filtered.length) { countEl.textContent = filtered.length > 99 ? '99+' : filtered.length; countEl.classList.add('has-count'); }
      else countEl.classList.remove('has-count');
    }
    if (navigator.setAppBadge) {
      if (filtered.length) navigator.setAppBadge(Math.min(filtered.length, 99)).catch(function () { });
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () { });
    }
    if (typeof bbNotifyProcessNewSounds === 'function') bbNotifyProcessNewSounds(filtered, true);
    if (typeof bbNotifyRefreshSoundButtons === 'function') bbNotifyRefreshSoundButtons();
  } catch (e) {
    var elc = opEl('opNotifyList');
    if (elc) elc.innerHTML = '<div class="admin-notify-empty">Could not load notifications.</div>';
  }
}
function clearAllOperatorNotifications() {
  var ids = window._opNotifyIds || [];
  if (!ids.length) return;
  var cleared = (typeof getClearedNotifyIds === 'function') ? getClearedNotifyIds() : [];
  ids.forEach(function (id) { if (id && cleared.indexOf(id) === -1) cleared.push(id); });
  if (typeof setClearedNotifyIds === 'function') setClearedNotifyIds(cleared);
  var hasInbox = ids.some(function (id) { return id && String(id).indexOf('inbox-') === 0; });
  if (hasInbox && typeof apiCall === 'function') apiCall('DELETE', '/api/inbox').catch(function () { });
  loadOperatorNotifications();
}
