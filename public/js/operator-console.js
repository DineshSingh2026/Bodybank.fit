/* ============================================================================
   BodyBank — Operator Console (client-first workspace)
   ----------------------------------------------------------------------------
   This roster is small and high-touch: a handful of clients, most of whom log
   very little. A wall of live metrics reads as failure against that data, so
   the clients themselves are the dashboard. Each one is a card carrying the
   one thing worth doing next; opening a card gives their whole story
   full-width. Aggregate monitoring still exists, on its own Pulse screen.

   Five destinations: Clients (home) · Blood · Prospects · Inbox · Pulse.

   Layout rules that keep it usable on a phone and a desktop alike:
     - the shell is a fixed-height grid; nothing scrolls the page itself
     - exactly ONE story overlay hosts every drill-down, so the ids inside it
       are never duplicated and mobile/desktop share one code path
     - the rail is a div[role=navigation]: index.html carries a global bare
       `nav{position:fixed;z-index:10010}` rule that hijacks every <nav>

   Depends on globals from index.html: apiCall, escapeHtml, showPopup,
   bbContactMatches, Chart, the shared blood helpers (bbAskLabDate, bbFmtDay,
   bbLabDateLabel, bbLabDateEditor, bbLabFileBtn, bbDeleteReportBtn,
   adminBloodDownloadPdf, bbCmpUseHost, bbLoadClientComparisons,
   bbRenderComparison) and the readiness mount (bbRdMountClient,
   bbRdSummarise).
   ========================================================================== */

var opState = window.opState || (window.opState = {
  screen: 'home',
  clients: [],
  complianceMap: {},
  complianceSummary: null,
  overview: null,
  leads: null,
  clientFilter: 'all',
  leadsView: 'audits',
  activityType: 'all',
  detailTab: 'profile',
  story: null,
  escId: null,
  omniRows: [],
  omniIndex: -1
});

window._opCharts = window._opCharts || {};

/* ------------------------------------------------------------------ utils */
function opEsc(v) { return escapeHtml(v == null ? '' : String(v)); }
function opAttr(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function opEl(id) { return document.getElementById(id); }
function opSetTxt(id, v) { var e = opEl(id); if (e) e.textContent = (v == null ? '–' : v); }
function opInitials(name) {
  var p = String(name || '').trim().split(/\s+/);
  return ((((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase()) || 'C';
}
function opFullName(u) {
  u = u || {};
  return ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.name || u.email || 'Client';
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
function opPlural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

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
  opNav('home');
  loadOperatorDashboard();
  if (window._opNotifyInterval) clearInterval(window._opNotifyInterval);
  window._opNotifyInterval = setInterval(loadOperatorNotifications, 60000);
}

function loadOperatorDashboard() {
  loadOperatorClients();
  loadOperatorCompliance();
  loadOperatorEscalations(true);
  loadOperatorOverview();
  loadOperatorActivity();
  loadOperatorNotifications();
}

var OP_SCREENS = ['home', 'clients', 'blood', 'prospects', 'inbox', 'pulse'];

function opNav(screen) {
  if (OP_SCREENS.indexOf(screen) === -1) screen = 'home';
  opState.screen = screen;
  opStoryClose(true);
  document.querySelectorAll('#operatorPanel [data-opnav]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-opnav') === screen);
  });
  document.querySelectorAll('#operatorPanel .op-screen').forEach(function (s) { s.classList.remove('active'); });
  var el = opEl('opScreen-' + screen);
  if (el) el.classList.add('active');
  opCloseOmni();

  if (screen === 'home') { renderOperatorHome(); loadOperatorOverview(); loadOperatorActivity(); }
  else if (screen === 'clients') { if (opState.clients.length) renderOperatorClients(); else loadOperatorClients(); }
  else if (screen === 'blood') { if (opState.clients.length) renderOperatorBlood(); else loadOperatorClients(); }
  else if (screen === 'prospects') { if (!opState.leads) loadOperatorLeads(); else renderOperatorLeads(); }
  else if (screen === 'inbox') loadOperatorEscalations();
  else if (screen === 'pulse') { loadOperatorOverview(); loadOperatorActivity(); renderOperatorCompliance(); }
}
// Old tab vocabulary, kept for any caller that still speaks it.
function switchOperatorTab(tab) {
  var map = { overview: 'home', clients: 'clients', leads: 'prospects', activity: 'pulse', admin: 'inbox', today: 'home' };
  opNav(map[tab] || 'home');
}

function refreshOperator(btn) {
  if (btn && btn.classList) btn.classList.add('is-spinning');
  try {
    loadOperatorClients();
    loadOperatorCompliance();
    if (opState.screen === 'home') { loadOperatorOverview(); loadOperatorActivity(); }
    else if (opState.screen === 'prospects') loadOperatorLeads();
    else if (opState.screen === 'inbox') loadOperatorEscalations();
    else if (opState.screen === 'pulse') { loadOperatorOverview(); loadOperatorActivity(); }
    loadOperatorNotifications();
  } catch (e) { }
  setTimeout(function () { if (btn && btn.classList) btn.classList.remove('is-spinning'); }, 750);
}

function logoutOperator() {
  if (window._opNotifyInterval) { clearInterval(window._opNotifyInterval); window._opNotifyInterval = null; }
  Object.keys(window._opCharts).forEach(opKillChart);
  if (typeof window.bbRdUnmount === 'function') window.bbRdUnmount('oprd');
  if (typeof unregisterNativePush === 'function') unregisterNativePush();
  if (typeof bbNotifyResetSoundState === 'function') bbNotifyResetSoundState();
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () { });
  var p = opEl('operatorPanel'); if (p) p.classList.remove('open');
  document.body.classList.remove('site-nav-hidden');
  document.body.classList.remove('admin-dashboard-open');
  document.body.classList.remove('operator-console-open');
  document.body.classList.remove('op-story-open');
  if (typeof unlockBodyScroll === 'function') unlockBodyScroll();
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { }
  window.currentUser = null;
}

// 1–5 jump between destinations, "/" focuses search, Esc backs out of a story.
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
      var modal = document.querySelector('#operatorPanel .op-cm-overlay.open');
      if (modal) { modal.classList.remove('open'); return; }
      if (opEl('opStory') && opEl('opStory').classList.contains('open')) { opStoryClose(); return; }
      return;
    }
    if (typing) {
      if (e.target.id === 'opOmniInput') {
        if (e.key === 'Enter') { e.preventDefault(); opOmniEnter(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); opOmniMove(e.key === 'ArrowDown' ? 1 : -1); }
      }
      return;
    }
    if (e.key === '/') { e.preventDefault(); var i = opEl('opOmniInput'); if (i) i.focus(); return; }
    var idx = ['1', '2', '3', '4', '5', '6'].indexOf(e.key);
    if (idx > -1) { e.preventDefault(); opNav(OP_SCREENS[idx]); }
  });
}

/* ==================================================== the story overlay */
/* Every drill-down — a client, a prospect, an admin thread — renders into the
   single #opStory host. One host means the ids inside it are unique by
   construction, and the phone and the desktop run the same code path. */
function opStoryOpen(headHtml, bodyHtml) {
  var story = opEl('opStory'), head = opEl('opStoryHead'), body = opEl('opStoryBody');
  if (!story) return;
  if (head) head.innerHTML = headHtml || '';
  if (body) { body.innerHTML = bodyHtml || ''; body.scrollTop = 0; }
  story.classList.add('open');
  document.body.classList.add('op-story-open');
}
function opStoryClose() {
  var story = opEl('opStory');
  if (story) story.classList.remove('open');
  document.body.classList.remove('op-story-open');
  if (typeof window.bbRdUnmount === 'function') window.bbRdUnmount('oprd');
  Object.keys(window._opCharts).forEach(function (k) { if (k !== 'trend') opKillChart(k); });
  opState.story = null;
}
function opStoryBackBtn() {
  return '<button type="button" class="op-icon-btn op-story-back" onclick="opStoryClose()" aria-label="Back">'
    + '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>';
}
// Old entry points, so nothing that still calls them breaks.
function closeOperatorClientModal() { opStoryClose(); }
function closeOpEsc() { opStoryClose(); }

/* =============================================================== omnibox */
function opOmniInput() {
  var q = ((opEl('opOmniInput') || {}).value || '').trim();
  var box = opEl('opOmniResults');
  if (!box) return;
  if (!q) { opCloseOmni(); return; }

  var rows = [];
  (opState.clients || []).forEach(function (c) {
    if (!bbContactMatches(q, [c.first_name, c.last_name, c.email], [c.phone])) return;
    rows.push({
      kind: 'client', id: c.id, name: opFullName(c), pic: c.profile_picture, tag: 'Client',
      sub: (c.email || '') + (c.inactive_days != null ? ' · silent ' + c.inactive_days + 'd' : '')
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
    return '<div class="op-omni-item' + (i === 0 ? ' sel' : '') + '" onclick="opOmniPick(' + i + ')">'
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
  if (r.kind === 'client') { opNav('clients'); openOperatorClient(r.id, 'profile'); }
  else { opNav('prospects'); opLeadsView(r.kind === 'part2' ? 'part2' : 'audits'); setTimeout(function () { opLeadOpen(r.kind, r.id); }, 40); }
}
function opCloseOmni() {
  var box = opEl('opOmniResults');
  if (box) box.classList.remove('open');
  opState.omniIndex = -1;
}

/* ======================================================= CLIENTS (home) */
async function loadOperatorClients() {
  try {
    var d = await apiCall('GET', '/api/operator/clients');
    if (!d || d.error) {
      var el = opEl('opClientCards');
      if (el) el.innerHTML = '<div class="op-empty pad">' + opEsc((d && d.error) || 'Could not load clients.') + '</div>';
      return;
    }
    opState.clients = d.rows || [];
    renderOperatorClients();
    renderOperatorBlood();
    renderOperatorHome();
  } catch (e) {
    var el2 = opEl('opClientCards');
    if (el2) el2.innerHTML = '<div class="op-empty pad">Could not load clients.</div>';
  }
}

async function loadOperatorCompliance() {
  try {
    var d = await apiCall('GET', '/api/operator/compliance');
    if (!d || d.error) return;
    var map = {};
    (d.clients || []).forEach(function (r) { map[r.id] = r; });
    opState.complianceMap = map;
    opState.complianceSummary = d.summary || null;
    renderOperatorClients();
    renderOperatorCompliance();
    renderOperatorHome();
  } catch (e) { }
}

/* The single most useful next step for one client. This is the whole point of
   the card: not "here are numbers", but "here is what to do". */
function opNextAction(c) {
  var idle = c.inactive_days || 0;
  var trialLeft = (c.subscription_status === 'trialing') ? opDaysUntil(c.access_expires_at) : null;
  var bloods = c.blood_reports || 0;

  if (trialLeft != null && trialLeft <= 0) {
    return { key: 'trial', tone: 'bad', label: 'Trial ended — win them back' };
  }
  if (trialLeft != null && trialLeft <= 3) {
    return { key: 'trial', tone: 'warn', label: 'Trial ends in ' + opPlural(trialLeft, 'day') };
  }
  if (idle >= 5) {
    return { key: 'chase', tone: 'bad', label: 'Chase — silent ' + opPlural(idle, 'day') };
  }
  if (idle >= 2) {
    return { key: 'chase', tone: 'warn', label: 'Nudge — quiet ' + opPlural(idle, 'day') };
  }
  if (!bloods) {
    return { key: 'blood', tone: 'info', label: 'Upload their first blood report' };
  }
  if (bloods >= 2 && !(c.blood_comparisons || 0)) {
    return { key: 'compare', tone: 'info', label: 'Run their progress comparison' };
  }
  if ((c.workouts_7d || 0) === 0) {
    return { key: 'chase', tone: 'warn', label: 'No training logged this week' };
  }
  return { key: 'ok', tone: 'ok', label: 'On track — open their profile' };
}
function opNeedsAttention(c) { return opNextAction(c).key !== 'ok'; }

/* Active = they did SOMETHING in the last 7 days — a check-in, a workout, a
   meal or a weigh-in. The server computes it across all four; this is the one
   place the front end asks the question, so every tile, chip and card agrees. */
function opIsActive(c) {
  if (c.active_7d != null) return !!c.active_7d;
  return (c.inactive_days || 0) < 7;               // older payloads
}
var OP_FILTERS = {
  all: function () { return true; },
  active: opIsActive,
  inactive: function (c) { return !opIsActive(c); },
  checkin: function (c) { return !!c.checkin_today; },
  workout: function (c) { return !!c.workout_today; },
  meal: function (c) { return !!c.meal_today; },
  attention: opNeedsAttention,
  ok: function (c) { return !opNeedsAttention(c); },
  trial: function (c) { return (c.subscription_status || '') === 'trialing'; },
  expiring: function (c) {
    if ((c.subscription_status || '') !== 'trialing') return false;
    var l = opDaysUntil(c.access_expires_at);
    return l != null && l <= 3;
  },
  noblood: function (c) { return !(c.blood_reports || 0); },
  nosunday: function (c) { return ((opState.complianceMap || {})[c.id] || {}).sunday_week === 0; },
  newthisweek: function (c) {
    var t = new Date(c.created_at).getTime();
    return !isNaN(t) && t >= Date.now() - 7 * 86400000;
  }
};
var OP_FILTER_LABEL = {
  all: 'Everyone', active: 'Active', inactive: 'Inactive', checkin: 'Checked in today',
  workout: 'Trained today', meal: 'Logged a meal today', attention: 'Needs me', ok: 'On track',
  trial: 'On trial', expiring: 'Trial ending', noblood: 'No blood report',
  nosunday: 'Missed Sunday check-in', newthisweek: 'New this week'
};
function opCount(key) { return (opState.clients || []).filter(OP_FILTERS[key] || OP_FILTERS.all).length; }

// Seven dots, oldest -> newest. A count cannot say WHICH days were missed.
function opWeekStrip(week) {
  var s = String(week || '0000000');
  var out = '<div class="op-week" title="Daily check-ins, last 7 days">';
  for (var j = 0; j < 7; j++) {
    var d = new Date(Date.now() - (6 - j) * 86400000);
    var label = d.toLocaleDateString(undefined, { weekday: 'short' });
    var on = s.charAt(j) === '1';
    out += '<span class="op-week-d' + (on ? ' on' : '') + '" title="' + opEsc(label) + (on ? ': checked in' : ': no check-in') + '"></span>';
  }
  return out + '</div>';
}

function opClientCard(c) {
  var name = opFullName(c);
  var id = opAttr(c.id);
  var act = opNextAction(c);
  var wa = opWa(c.phone);
  var idle = c.inactive_days || 0;

  var status = idle === 0 ? '<span class="op-status ok">Active today</span>'
    : (idle === 1 ? '<span class="op-status ok">Active yesterday</span>'
      : '<span class="op-status ' + (idle >= 5 ? 'bad' : 'warn') + '">Silent ' + opPlural(idle, 'day') + '</span>');

  var tags = '';
  if (c.subscription_status === 'trialing') {
    var left = opDaysUntil(c.access_expires_at);
    tags += '<span class="op-tag ' + (left != null && left <= 3 ? 'warn' : '') + '">'
      + (left == null ? 'Trial' : (left <= 0 ? 'Trial ended' : 'Trial · ' + left + 'd')) + '</span>';
  }
  if (c.blood_pending) tags += '<span class="op-tag info">' + c.blood_pending + ' processing</span>';

  var bloodLine = (c.blood_reports || 0)
    ? opPlural(c.blood_reports, 'blood report') + (c.blood_latest ? ' · latest ' + opEsc(bbFmtDay(c.blood_latest)) : '')
    : 'No blood report yet';

  var actions = '<div class="op-card-actions">';
  if (wa) actions += '<a class="op-qa wa" href="' + wa + '" target="_blank" rel="noopener" title="WhatsApp" onclick="event.stopPropagation()">'
    + '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.2-5.2A8.5 8.5 0 1 1 21 11.5Z"/></svg></a>';
  actions += '<button type="button" class="op-qa" title="Send a reminder" onclick="event.stopPropagation();opComposeFor(\'' + id + '\',\'' + opAttr(name) + '\',\'reminder\')">'
    + '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg></button>';
  actions += '<button type="button" class="op-qa" title="Share with Admin" onclick="event.stopPropagation();opComposeFor(\'' + id + '\',\'' + opAttr(name) + '\',\'share\')">'
    + '<svg viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg></button>';
  actions += '<button type="button" class="op-qa" title="Blood reports" onclick="event.stopPropagation();openOperatorClient(\'' + id + '\',\'blood\')">'
    + '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.3 6 10.2A6 6 0 0 1 6 13.2C6 9.3 12 3 12 3Z"/></svg></button>';
  actions += '</div>';

  return '<article class="op-card' + (act.key === 'ok' ? '' : ' flag') + '" data-cid="' + id + '" onclick="openOperatorClient(\'' + id + '\')">'
    + '<div class="op-card-top">'
    + opAvatar(c.profile_picture, name, 'lg')
    + '<div class="op-card-id"><div class="op-card-name">' + opEsc(name) + '</div>'
    + '<div class="op-card-mail">' + opEsc(c.email || '') + '</div>'
    + '<div class="op-card-tags">' + status + tags + '</div></div>'
    + '</div>'
    + opWeekStrip(c.checkin_week)
    + '<div class="op-card-facts">'
    + '<span><b>' + (c.checkins_7d || 0) + '</b>/7 check-ins</span>'
    + '<span><b>' + (c.workouts_7d || 0) + '</b> workouts</span>'
    + '</div>'
    + '<div class="op-card-blood">' + bloodLine + '</div>'
    + '<button type="button" class="op-next ' + act.tone + '" onclick="event.stopPropagation();opDoAction(\'' + id + '\',\'' + act.key + '\')">'
    + '<span>' + opEsc(act.label) + '</span>'
    + '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>'
    + actions
    + '</article>';
}

function opDoAction(id, key) {
  var c = (opState.clients || []).filter(function (x) { return String(x.id) === String(id); })[0];
  var name = c ? opFullName(c) : 'Client';
  if (key === 'chase' || key === 'trial') { opComposeFor(id, name, 'reminder'); return; }
  if (key === 'blood' || key === 'compare') { openOperatorClient(id, 'blood'); return; }
  openOperatorClient(id, 'profile');
}

function opClientFilter(f) {
  if (!OP_FILTERS[f]) f = 'all';
  opState.clientFilter = f;
  var matched = false;
  document.querySelectorAll('#opClientChips .op-chip[data-cf]').forEach(function (b) {
    var on = b.getAttribute('data-cf') === f;
    if (on) matched = true;
    b.classList.toggle('active', on);
  });
  // Tiles can select a lens that has no permanent chip (trial ending, missed
  // Sunday, new this week). Show it as a removable chip so the roster never
  // looks filtered for no visible reason.
  var extra = opEl('opChipExtra');
  if (extra) extra.remove();
  if (!matched && f !== 'all') {
    var host = opEl('opClientChips');
    if (host) {
      var b = document.createElement('button');
      b.type = 'button'; b.id = 'opChipExtra'; b.className = 'op-chip active';
      b.innerHTML = opEsc(OP_FILTER_LABEL[f] || f) + ' <span aria-hidden="true">×</span>';
      b.setAttribute('aria-label', 'Clear filter: ' + (OP_FILTER_LABEL[f] || f));
      b.onclick = function () { opClientFilter('all'); };
      host.appendChild(b);
    }
  }
  renderOperatorClients();
}
// Jump straight from a landing tile into the matching roster view.
function opMonitor(f) { opNav('clients'); opClientFilter(f); }

function renderOperatorClients() {
  var el = opEl('opClientCards');
  if (!el) return;
  var list = opState.clients || [];
  var q = ((opEl('opClientSearch') || {}).value || '').trim();
  var sort = (opEl('opClientSort') || {}).value || 'action';
  var f = opState.clientFilter || 'all';

  var test = OP_FILTERS[f] || OP_FILTERS.all;
  var rows = list.filter(function (c) {
    if (q && !bbContactMatches(q, [c.first_name, c.last_name, c.email], [c.phone])) return false;
    return test(c);
  });

  var TONE = { bad: 0, warn: 1, info: 2, ok: 3 };
  rows.sort(function (a, b) {
    if (sort === 'name') return opFullName(a).toLowerCase().localeCompare(opFullName(b).toLowerCase());
    if (sort === 'recent') return (a.inactive_days || 0) - (b.inactive_days || 0);
    if (sort === 'blood') return (b.blood_reports || 0) - (a.blood_reports || 0);
    var ta = TONE[opNextAction(a).tone], tb = TONE[opNextAction(b).tone];
    return (ta - tb) || ((b.inactive_days || 0) - (a.inactive_days || 0));
  });

  // The standfirst: one sentence of truth instead of a wall of zeros.
  var need = list.filter(opNeedsAttention).length;
  var inToday = list.filter(function (c) { return (c.inactive_days || 0) === 0; }).length;
  var noBlood = list.filter(function (c) { return !(c.blood_reports || 0); }).length;
  var line = opEl('opSfLine'), sub = opEl('opSfSub');
  if (line) {
    line.innerHTML = list.length
      ? (need ? '<b>' + need + '</b> of ' + list.length + ' ' + (need === 1 ? 'client needs' : 'clients need') + ' you today'
        : 'All ' + opPlural(list.length, 'client') + ' are on track')
      : 'No clients yet';
  }
  if (sub) {
    sub.textContent = list.length
      ? [inToday + ' active today', noBlood ? noBlood + ' without a blood report' : 'everyone has bloods'].join(' · ')
      : 'Clients appear here once they sign up.';
  }
  var badge = opEl('opRailBadgeClients');
  if (badge) { badge.textContent = need > 99 ? '99+' : need; badge.classList.toggle('on', need > 0); }

  el.innerHTML = rows.length ? rows.map(opClientCard).join('')
    : '<div class="op-empty pad">' + (q || f !== 'all' ? 'No clients match this view.' : 'No clients yet.') + '</div>';
}

/* ------------------------------------------------ compliance (on Pulse) */
function renderOperatorCompliance() {
  var el = opEl('opComplianceList');
  if (!el) return;
  var list = opState.clients || [];
  var comp = opState.complianceMap || {};
  if (!list.length) { el.innerHTML = '<div class="op-empty">No clients yet.</div>'; return; }
  var rows = list.slice().sort(function (a, b) {
    var ka = comp[a.id] || {}, kb = comp[b.id] || {};
    var ma = (ka.daily_today > 0 ? 0 : 1) + ((a.workouts_7d || 0) > 0 ? 0 : 1) + (ka.sunday_week > 0 ? 0 : 1);
    var mb = (kb.daily_today > 0 ? 0 : 1) + ((b.workouts_7d || 0) > 0 ? 0 : 1) + (kb.sunday_week > 0 ? 0 : 1);
    return mb - ma;
  });
  el.innerHTML = rows.map(function (c) {
    var k = comp[c.id] || {};
    var d = (k.daily_today || 0) > 0, w = (c.workouts_7d || 0) > 0, s = (k.sunday_week || 0) > 0;
    return '<div class="op-comp" onclick="openOperatorClient(\'' + opAttr(c.id) + '\')">'
      + opAvatar(c.profile_picture, opFullName(c))
      + '<div class="op-comp-main"><div class="op-comp-name">' + opEsc(opFullName(c)) + '</div>'
      + '<div class="op-comp-sub">Daily ' + (k.daily_7d || 0) + '/7 · last ' + opEsc(opTimeAgo(k.last_daily || k.last_workout || c.created_at) || '—') + '</div></div>'
      + '<div class="op-c3">'
      + '<span class="' + (d ? 'ok' : 'miss') + '">DAY<b>' + (d ? '✓' : '✗') + '</b></span>'
      + '<span class="' + (w ? 'ok' : 'miss') + '">WKT<b>' + (w ? '✓' : '✗') + '</b></span>'
      + '<span class="' + (s ? 'ok' : 'miss') + '">SUN<b>' + (s ? '✓' : '✗') + '</b></span>'
      + '</div></div>';
  }).join('');
}

/* ================================================================= BLOOD */
function renderOperatorBlood() {
  var el = opEl('opBloodCards');
  if (!el) return;
  var list = opState.clients || [];
  var q = ((opEl('opBloodSearch') || {}).value || '').trim();
  var f = (opEl('opBloodFilter') || {}).value || 'all';
  var rows = list.filter(function (c) {
    if (q && !bbContactMatches(q, [c.first_name, c.last_name, c.email], [c.phone])) return false;
    var n = c.blood_reports || 0;
    if (f === 'none') return n === 0;
    if (f === 'has') return n > 0;
    if (f === 'pending') return (c.blood_pending || 0) > 0;
    if (f === 'comparable') return n >= 2;
    return true;
  }).sort(function (a, b) { return (b.blood_reports || 0) - (a.blood_reports || 0); });

  var total = list.reduce(function (n, c) { return n + (c.blood_reports || 0); }, 0);
  var pending = list.reduce(function (n, c) { return n + (c.blood_pending || 0); }, 0);
  var none = list.filter(function (c) { return !(c.blood_reports || 0); }).length;
  var line = opEl('opBloodLine'), sub = opEl('opBloodSub');
  if (line) line.innerHTML = '<b>' + total + '</b> ' + (total === 1 ? 'report' : 'reports') + ' across ' + opPlural(list.length, 'client');
  if (sub) sub.textContent = [
    pending ? pending + ' still processing' : 'nothing processing',
    none ? none + ' with no report yet' : 'everyone has at least one'
  ].join(' · ');

  el.innerHTML = rows.length ? rows.map(opBloodCard).join('')
    : '<div class="op-empty pad">No clients match this view.</div>';
}

function opBloodCard(c) {
  var name = opFullName(c);
  var id = opAttr(c.id);
  var n = c.blood_reports || 0;
  var head = n
    ? '<span class="op-status ok">' + opPlural(n, 'report') + '</span>'
    : '<span class="op-status warn">No report yet</span>';
  if (c.blood_pending) head += '<span class="op-tag info">' + c.blood_pending + ' processing</span>';
  if (n >= 2) head += '<span class="op-tag">' + (c.blood_comparisons ? opPlural(c.blood_comparisons, 'comparison') : 'ready to compare') + '</span>';

  var sub = n && c.blood_latest ? 'Latest lab test ' + opEsc(bbFmtDay(c.blood_latest)) : 'Nothing on file';
  var cta = n
    ? (n >= 2 && !(c.blood_comparisons || 0) ? 'Run progress comparison' : 'Open blood workspace')
    : 'Upload their first report';

  return '<article class="op-card' + (n ? '' : ' flag') + '" data-cid="' + id + '" onclick="openOperatorClient(\'' + id + '\',\'blood\')">'
    + '<div class="op-card-top">' + opAvatar(c.profile_picture, name, 'lg')
    + '<div class="op-card-id"><div class="op-card-name">' + opEsc(name) + '</div>'
    + '<div class="op-card-mail">' + opEsc(sub) + '</div>'
    + '<div class="op-card-tags">' + head + '</div></div></div>'
    + '<button type="button" class="op-next ' + (n ? 'info' : 'warn') + '" onclick="event.stopPropagation();openOperatorClient(\'' + id + '\',\'blood\')">'
    + '<span>' + cta + '</span><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>'
    + '</article>';
}

/* ======================================================= CLIENT STORY === */
var OP_DETAIL_TABS = ['profile', 'overview', 'nutrition', 'workouts', 'body', 'blood', 'readiness'];

async function openOperatorClient(id, tab) {
  tab = OP_DETAIL_TABS.indexOf(tab) > -1 ? tab : 'profile';
  opState.story = { kind: 'client', id: id };
  opStoryOpen(opStoryBackBtn() + '<div class="op-story-id"><div class="op-story-title">Loading…</div></div>',
    '<div class="op-empty pad">Loading client…</div>');
  try {
    var d = await apiCall('GET', '/api/operator/clients/' + encodeURIComponent(id));
    if (!d || d.error) {
      opStoryOpen(opStoryBackBtn() + '<div class="op-story-id"><div class="op-story-title">Client</div></div>',
        '<div class="op-empty pad">' + opEsc((d && d.error) || 'Could not load client.') + '</div>');
      return;
    }
    window._opClientData = d;
    var u = d.user || {};
    var name = opFullName(u);
    window._opCurrentClient = { id: id, name: name, phone: u.phone || '', email: u.email || '' };

    if (typeof window.bbRdUnmount === 'function') window.bbRdUnmount('oprd');
    Object.keys(window._opCharts).forEach(function (k) { if (k !== 'trend') opKillChart(k); });

    opStoryOpen(opClientStoryHead(u), opDetailActions(u) + opDetailTabsHtml() + opDetailPanes(d));
    window._opDetailDrawn = {};
    opDetailTab(tab);
    opLoadReadinessCard(id);
  } catch (e) {
    opStoryOpen(opStoryBackBtn() + '<div class="op-story-id"><div class="op-story-title">Client</div></div>',
      '<div class="op-empty pad">Could not load client.</div>');
  }
}

function opClientStoryHead(u) {
  var name = opFullName(u);
  var roster = (opState.clients || []).filter(function (c) { return String(c.id) === String(u.id); })[0];
  var pills = '';
  if (roster) {
    var idle = roster.inactive_days || 0;
    pills += idle === 0 ? '<span class="op-status ok">Active today</span>'
      : '<span class="op-status ' + (idle >= 5 ? 'bad' : (idle >= 2 ? 'warn' : 'ok')) + '">Silent ' + opPlural(idle, 'day') + '</span>';
  }
  if ((u.subscription_status || '') === 'trialing') {
    var left = opDaysUntil(u.access_expires_at);
    pills += '<span class="op-tag ' + (left != null && left <= 3 ? 'warn' : '') + '">'
      + (left == null ? 'Trial' : (left <= 0 ? 'Trial ended' : 'Trial · ' + left + 'd')) + '</span>';
  }
  return opStoryBackBtn()
    + opAvatar(u.profile_picture, name, 'xl')
    + '<div class="op-story-id"><div class="op-story-title">' + opEsc(name) + '</div>'
    + '<div class="op-story-sub">' + opEsc([u.email, u.phone].filter(Boolean).join(' · ')) + '</div></div>'
    + '<div class="op-story-pills">' + pills + '</div>';
}

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
  h += '</div><div id="opBloodMsg" style="display:none;font-size:12.5px;margin:-6px 0 12px"></div>';
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
    if (on && b.scrollIntoView) { try { b.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { } }
  });
  OP_DETAIL_TABS.forEach(function (t) {
    var el = opEl('opDetail-' + t); if (el) el.style.display = (t === tab) ? 'block' : 'none';
  });
  var body = opEl('opStoryBody'); if (body) body.scrollTop = 0;

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
  openOperatorClient(c.id, opState.detailTab);
  loadOperatorClients();
}

/* --------------------------------------------------------- story: panes */
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

  h += '<div class="op-sub">Readiness</div><div id="opRdProfileCard"><div class="op-empty">Loading readiness…</div></div>';

  var bloods = opBloodList(d);
  h += '<div class="op-sub">Blood reports</div>';
  if (bloods.length) {
    var latest = bloods[0];
    h += '<div class="op-lines">' + opKV('On file', opEsc(String(bloods.length)) + ' · latest ' + bbLabDateLabel({ reportDate: latest.report_date || null, createdAt: latest.created_at })) + '</div>';
  } else {
    h += '<div class="op-empty">No blood reports uploaded yet.</div>';
  }
  h += '<div style="margin-top:10px"><button type="button" class="op-btn line" onclick="opDetailTab(\'blood\')">🩸 Open blood reports'
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

  h += '<div class="op-lines" style="margin-top:12px">';
  h += opKV('Membership', opEsc(u.subscription_status || 'active') + (u.plan_label ? ' · ' + opEsc(u.plan_label) : ''));
  h += opKV('Access expires', opEsc(u.access_expires_at ? new Date(u.access_expires_at).toLocaleDateString() : '–'));
  if (u.height_cm || u.goal_type) h += opKV('Height / Goal', opEsc((u.height_cm ? u.height_cm + 'cm' : '') + (u.goal_type ? (u.height_cm ? ' · ' : '') + u.goal_type : '')));
  if (u.nutrition_ai_last_used_at || u.ai_trainer_last_used_at) {
    h += opKV('AI last used', opEsc('Nutrition ' + (opTimeAgo(u.nutrition_ai_last_used_at) || 'never') + ' · Trainer ' + (opTimeAgo(u.ai_trainer_last_used_at) || 'never')));
  }
  h += '</div>';

  h += '<div id="opWeeklyWrap" style="margin-top:18px"></div>';
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
  if (!meals.length && !daily.length) return '<div class="op-empty pad">Nothing logged in the nutrition tracker yet.</div>';
  var h = '';
  if (daily.length) h += '<div class="op-chart-card"><div class="op-sub" style="margin:0 0 10px">Calories &amp; protein (daily)</div><div class="op-chart-wrap sm"><canvas id="opNutChart"></canvas></div></div>';
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
  var score = m.meal_score != null ? '<span class="op-tag">' + m.meal_score + '/10</span>' : '';
  var note = (m.manual_note && m.manual_note !== dish) ? '<div class="op-card-note">📝 ' + opEsc(m.manual_note) + '</div>' : '';
  return '<div class="op-mini-card"><div class="op-mini-top"><span class="op-mini-kind">' + opEsc(m.meal_type || 'meal') + ' · ' + opEsc(opDate(m.log_date)) + (m.portion_size ? ' · ' + opEsc(m.portion_size) : '') + '</span>' + score + '</div>'
    + '<div class="op-mini-title">' + opEsc(dish) + '</div><div class="op-mini-macros">' + opEsc(macros || '—') + '</div>' + note + '</div>';
}

function opBuildWorkouts(d) {
  var wk = d.workouts || [], str = d.strength || [];
  if (!wk.length && !str.length) return '<div class="op-empty pad">No training logged yet.</div>';
  var hasStrength = str.some(function (r) { return r.strength_bench || r.strength_squat || r.strength_deadlift; });
  var h = '';
  if (hasStrength) h += '<div class="op-chart-card"><div class="op-sub" style="margin:0 0 10px">Strength over time (kg)</div><div class="op-chart-wrap sm"><canvas id="opStrChart"></canvas></div></div>';
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
  var done = w.workout_completed ? '<span class="op-tag ok">done</span>' : '';
  return '<div class="op-mini-card"><div class="op-mini-top"><span class="op-mini-kind">' + opEsc(w.workout_name || 'Workout') + ' · ' + opEsc(opDate(w.session_date || w.created_at)) + '</span>' + done + '</div>'
    + (meta ? '<div class="op-mini-macros" style="color:var(--op-muted)">' + meta + '</div>' : '')
    + (big ? '<div style="font-size:12.5px;color:var(--op-cream);margin-top:5px;font-weight:600">' + big + '</div>' : '')
    + (exRows ? '<div class="op-ex-list">' + exRows + '</div>' : '')
    + (w.feedback ? '<div class="op-card-note">💬 ' + opEsc(w.feedback) + '</div>' : '') + '</div>';
}

function opBuildBody(d) {
  var wts = d.weights || [], snaps = d.body_snapshots || [];
  var h = '';
  if (wts.length >= 2) h += '<div class="op-chart-card"><div class="op-sub" style="margin:0 0 10px">Weight trend</div><div class="op-chart-wrap sm"><canvas id="opBodyWtChart"></canvas></div></div>';
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
  return '<div class="op-mini-card"><div class="op-mini-top"><span class="op-mini-kind">' + opEsc(opDate(s.snapshot_date || s.created_at)) + '</span>'
    + '<span class="op-mini-macros">' + opEsc(meta) + '</span></div>'
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
    h += '<div class="op-lines" style="margin-bottom:10px">' + opKV('Overall audit index', opEsc(String(d.audit_index != null ? d.audit_index : '—')) + (d.audit_index_delta ? ' (' + (d.audit_index_delta > 0 ? '+' : '') + d.audit_index_delta + ')' : '')) + '</div>';
    (d.regions || []).forEach(function (r) {
      var pct = Math.max(0, Math.min(100, Math.round(r.score || 0)));
      h += '<div class="op-bar-row"><div class="op-bar-top"><span class="op-bar-label">' + opEsc(r.label || r.key) + (r.tier ? ' · ' + opEsc(r.tier) : '') + '</span>'
        + '<span class="op-bar-val" style="font-size:12.5px">' + (r.best_lift_kg ? r.best_lift_kg + 'kg' : '') + '</span></div>'
        + '<div class="op-bar-track"><div class="op-bar-fill" data-w="' + pct + '"></div></div></div>';
    });
    wrap.innerHTML = h;
    opAnimateBars(wrap);
  } catch (e) { wrap.innerHTML = '<div class="op-sub">Muscle ranking</div><div class="op-empty">Could not load.</div>'; }
}

/* ------------------------------------------------------- story: charts */
var OP_TICK = '#A9B2C4', OP_GRID = 'rgba(255,255,255,0.07)';
function opDrawNutritionChart() {
  var d = window._opClientData; if (!d || typeof Chart === 'undefined') return;
  var el = opEl('opNutChart'); if (!el) return;
  opKillChart('nut');
  var rows = (d.nutrition || []).slice().reverse();
  window._opCharts.nut = new Chart(el.getContext('2d'), {
    data: {
      labels: rows.map(function (r) { return opDate(r.stat_date); }),
      datasets: [
        { type: 'bar', label: 'Calories', data: rows.map(function (r) { return r.total_calories || 0; }), backgroundColor: 'rgba(240,178,94,0.6)', yAxisID: 'y', borderRadius: 3, maxBarThickness: 15 },
        { type: 'line', label: 'Protein (g)', data: rows.map(function (r) { return r.total_protein || 0; }), borderColor: '#46C4A6', backgroundColor: 'rgba(70,196,166,0.16)', yAxisID: 'y1', tension: 0.3, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: OP_TICK, font: { size: 11 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 10 }, maxTicksLimit: 7 }, grid: { display: false } },
        y: { position: 'left', ticks: { color: OP_TICK, font: { size: 10 } }, grid: { color: OP_GRID } },
        y1: { position: 'right', ticks: { color: '#46C4A6', font: { size: 10 } }, grid: { display: false } }
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
        { label: 'Bench', data: rows.map(function (r) { return r.strength_bench; }), borderColor: '#F0B25E', tension: 0.3, pointRadius: 2, spanGaps: true },
        { label: 'Squat', data: rows.map(function (r) { return r.strength_squat; }), borderColor: '#74D0E6', tension: 0.3, pointRadius: 2, spanGaps: true },
        { label: 'Deadlift', data: rows.map(function (r) { return r.strength_deadlift; }), borderColor: '#A79BF5', tension: 0.3, pointRadius: 2, spanGaps: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: OP_TICK, font: { size: 11 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 10 }, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: OP_TICK, font: { size: 10 } }, grid: { color: OP_GRID } }
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
      datasets: [{ label: 'Weight', data: weights.map(function (r) { return r.weight_kg; }), borderColor: '#F0B25E', backgroundColor: 'rgba(240,178,94,0.16)', fill: true, tension: 0.3, pointRadius: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 10 }, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: OP_TICK, font: { size: 10 } }, grid: { color: OP_GRID } }
      }
    }
  });
}

/* ------------------------------------------------------ story: weekly */
var OP_WK_FMT = {
  steps: { label: 'Steps', color: '#F0B25E', unit: '', div: 1 },
  water: { label: 'Water', color: '#74D0E6', unit: 'L', div: 1000 },
  protein: { label: 'Protein', color: '#46C4A6', unit: 'g', div: 1 },
  sleep: { label: 'Sleep', color: '#A79BF5', unit: 'h', div: 1 }
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
    var pcolor = pct >= 90 ? '#46C4A6' : (pct >= 60 ? '#F0B25E' : '#FF8A72');
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
      datasets: [{ data: vals, backgroundColor: days.map(function (x) { return x.hitGoal ? cfg.color : 'rgba(255,255,255,0.16)'; }), borderRadius: 3, maxBarThickness: 14 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: OP_TICK, font: { size: 10 } }, grid: { display: false } },
        y: { display: false, beginAtZero: true, suggestedMax: Math.max(goal, Math.max.apply(null, vals.concat([1]))) }
      }
    }
  });
}

/* --------------------------------------------------- story: readiness */
function opBuildReadiness() {
  return '<div class="op-sub" style="margin-top:0">⌚ Raw readiness &amp; recovery</div>'
    + '<div id="opDetailReadinessBody"><div class="op-empty">Loading…</div></div>';
}
function opMountReadiness() {
  var c = window._opCurrentClient;
  var host = opEl('opDetailReadinessBody');
  if (!host) return;
  if (!c || !c.id) {
    host.innerHTML = '<div class="op-empty">No client selected.</div>';
    return;
  }
  if (typeof window.bbRdMountClient !== 'function') { host.innerHTML = '<div class="op-empty">Readiness view is unavailable on this build.</div>'; return; }
  window.bbRdMountClient({ key: 'oprd', scope: 'operator', el: 'opDetailReadinessBody', userId: c.id, name: c.name || '' });
}
function opReadinessCard(s) {
  if (!s) return '<div class="op-empty">No readiness data in the last 14 days.</div>';
  var when = s.isToday ? 'Today' : opEsc(s.dayLabel);
  var h = '<div class="op-mini-card">';
  h += '<div class="op-mini-top"><span style="font-weight:700;font-size:13.5px">' + (s.isDerived ? 'Readiness' : 'Recovery') + ' ' + opEsc(s.scoreText) + ' · ' + when + '</span>'
    + '<button type="button" class="op-btn line" style="padding:6px 11px;font-size:12px" onclick="opDetailTab(\'readiness\')">📈 Open</button></div>';
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

/* ------------------------------------------------------- story: blood */
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
function opBloodReportCard(b, n) {
  b = b || {};
  var flags = opBloodFlags(b.extracted_blood_data);
  var complete = String(b.status || '').toLowerCase() === 'complete';
  var rid = String(b.id || '').replace(/'/g, "\\'");
  var asReport = { id: b.id, reportDate: b.report_date || null, createdAt: b.created_at };
  var btnStyle = 'flex:1 1 auto;min-width:92px;padding:8px 10px;font-size:12.5px';
  var actions = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">'
    + bbLabFileBtn(rid, !!b.has_source_file, btnStyle)
    + (complete
      ? '<button type="button" class="op-btn line" style="' + btnStyle + '" onclick="adminBloodDownloadPdf(\'' + rid + '\')">⬇ Report PDF</button>'
      : '<button type="button" class="op-btn line" disabled title="Analysis is not complete yet" style="' + btnStyle + '">⬇ Report PDF</button>')
    + bbDeleteReportBtn(rid, btnStyle, 'opRefreshClient')
    + '</div>';
  var status = complete ? '<span class="op-tag ok">complete</span>' : '<span class="op-tag warn">' + opEsc(String(b.status || 'pending')) + '</span>';
  var meta = [b.overall_status ? 'Overall: ' + b.overall_status : '', b.sent_to_user ? 'Sent to user' : '', flags.length ? (flags.length + ' flagged') : 'All in range'].filter(Boolean).join(' · ');
  var h = '<div class="op-mini-card">';
  h += '<div class="op-mini-top"><span style="font-weight:700;font-size:13.5px">Blood report ' + n + '</span>' + status + '</div>';
  h += '<div style="font-size:12.5px;color:var(--op-cream)">' + bbLabDateLabel(asReport) + '</div>';
  h += '<div style="font-size:12.5px;color:var(--op-muted);margin-top:5px">' + opEsc(meta) + '</div>';
  h += bbLabDateEditor(rid, asReport, 'opRefreshClient');
  if (flags.length) {
    h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">';
    flags.slice(0, 6).forEach(function (m) {
      h += '<span class="op-flagmark">'
        + opEsc(String(m.name || 'Marker') + ' ' + [m.value, m.unit].filter(Boolean).join(' ') + (m.status ? ' (' + m.status + ')' : '')) + '</span>';
    });
    h += '</div>';
  }
  h += actions + '</div>';
  return h;
}
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
    return '<label class="op-cmp-chip' + (r.report_date ? '' : ' undated') + '">'
      + '<input type="checkbox" class="op-cmp-report" value="' + opEsc(String(r.id)) + '" onchange="opCompareSelectionChanged()"> '
      + '<span><strong>Test ' + (i + 1) + '</strong> · ' + opEsc(label)
      + (r.overall_status ? ' · ' + opEsc(r.overall_status) : '') + '</span></label>';
  }).join('');
  h += '<div style="font-size:12.5px;color:var(--op-cream);margin-bottom:8px">Select 2–6 reports to compare (oldest → newest by lab date)</div>';
  if (undated) {
    h += '<div class="op-warn-note">' + undated + ' report' + (undated === 1 ? ' has' : 's have')
      + ' no lab date and sit by upload date. Set the lab date above for an accurate trend.</div>';
  }
  h += chips;
  h += '<div style="margin-top:8px"><button type="button" id="opCompareRunBtn" class="op-btn primary" disabled onclick="opRunComparison()">Generate comparison</button></div>';
  h += '<div id="opCmpSaved" style="margin-top:16px"></div>';
  h += '<div id="opCmpResult" style="margin-top:16px"></div>';
  return h;
}
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
      loadOperatorClients();
    })
    .catch(function () { if (res) res.innerHTML = '<div class="op-empty" style="color:#ff8a8a">Network error</div>'; })
    .then(function () { opCompareSelectionChanged(); });
}

/* ============================================================= PROSPECTS */
async function loadOperatorLeads() {
  var el = opEl('opLeadCards');
  var days = (opEl('opLeadsDays') || {}).value || '30';
  if (el && !opState.leads) el.innerHTML = '<div class="op-empty pad">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/leads?days=' + encodeURIComponent(days));
    if (!d || d.error) { if (el) el.innerHTML = '<div class="op-empty pad">' + opEsc((d && d.error) || 'Could not load prospects.') + '</div>'; return; }
    opState.leads = d;
    renderOperatorLeads();
  } catch (e) { if (el) el.innerHTML = '<div class="op-empty pad">Could not load prospects.</div>'; }
}
function opLeadsView(view) {
  opState.leadsView = view;
  document.querySelectorAll('#opLeadsSeg .op-chip').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-lv') === view);
  });
  // Nutrition assessments are their own endpoint, not part of /api/operator/leads,
  // so the first switch to that view fetches them and every later one is instant.
  if (view === 'nutrition' && !opState.na) { loadOperatorNutritionAssessments(); return; }
  renderOperatorLeads();
}

/* Read-only by design: an operator can see and chase an assessment, but the
   delete and the "mark reviewed" action stay on the admin console. */
async function loadOperatorNutritionAssessments() {
  var el = opEl('opLeadCards');
  if (el) el.innerHTML = '<div class="op-empty pad">Loading\u2026</div>';
  try {
    var d = await apiCall('GET', '/api/nutrition-assessment/list?sort=flagged');
    if (!d || d.error || !Array.isArray(d.rows)) {
      if (el) el.innerHTML = '<div class="op-empty pad">' + opEsc((d && d.error) || 'Could not load assessments.') + '</div>';
      return;
    }
    opState.na = d;
    renderOperatorLeads();
  } catch (e) {
    if (el) el.innerHTML = '<div class="op-empty pad">Could not load assessments.</div>';
  }
}

/**
 * Copy this person's Part 2 link.
 *
 * `mark_sent` is deliberately NOT set here: an operator copying a link to chase
 * someone must not silently record that the follow-up was done. Only the admin
 * action stamps part2_sent_at.
 */
/** Clipboard with an honest fallback when the browser blocks it. */
async function opCopyText(text, msg) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    alert(msg || 'Copied.');
  } catch (e) {
    window.prompt('Copy this link:', text);
  }
}

async function opNaPart2(id) {
  var row = ((opState.na || {}).rows || []).filter(function (r) { return r.id === id; })[0];
  var who = (row && row.name) || 'this person';
  var d;
  try {
    d = await apiCall('POST', '/api/nutrition-assessment/' + id + '/part2-link', {});
  } catch (e) { d = null; }
  if (!d || d.error || !d.url) {
    alert((d && d.error) || 'Could not create the Part 2 link.');
    return;
  }
  var copied = false;
  try { await navigator.clipboard.writeText(d.url); copied = true; } catch (e) { /* clipboard blocked */ }
  if (copied) alert('Part 2 link for ' + who + ' copied. It reopens their existing answers, so nothing is retyped.');
  else window.prompt('Part 2 link for ' + who + ':', d.url);
}

function opNaBadges(r) {
  // The assessment arrives in two parts. "Part 1 done" is the state an operator
  // actually chases — it means the person is usable but the detail is still
  // outstanding — so it gets its own badge rather than being lumped in with a
  // half-finished form.
  var progress;
  if (r.part2_done || r.status === 'complete') {
    progress = '<span class="op-tag ok">Both parts in</span>';
  } else if (r.part1_done) {
    progress = '<span class="op-tag warn"'
      + (r.part2_sent_at ? ' title="Part 2 link sent"' : ' title="Part 2 link not sent yet"')
      + '>Part 1 done' + (r.part2_sent_at ? '' : ' · not chased') + '</span>';
  } else {
    progress = '<span class="op-tag">Part 1 · step ' + r.last_step + '/' + r.total_steps + '</span>';
  }
  return (r.is_member ? '<span class="op-tag ok">Member</span>' : '<span class="op-tag warn">No account</span>')
    + progress
    + (r.flagged ? '<span class="op-tag warn" title="' + opEsc((r.flag_labels || []).join(', ')) + '">Needs review</span>' : '');
}

function opNaCard(r) {
  var phone = r.mobile || '';
  var wa = opWa(phone);
  var actions = '<div class="op-card-actions">';
  if (wa) actions += '<a class="op-qa wa" href="' + wa + '" target="_blank" rel="noopener" title="WhatsApp" onclick="event.stopPropagation()">'
    + '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.2-5.2A8.5 8.5 0 1 1 21 11.5Z"/></svg></a>';
  if (r.email) actions += '<a class="op-qa" href="mailto:' + opEsc(r.email) + '" title="Email" onclick="event.stopPropagation()">'
    + '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg></a>';
  // Only where it can be used: Part 1 in, Part 2 not. Operators are read-only on
  // the assessment itself, but chasing is exactly their job, so the link is theirs.
  if (r.awaiting_part2) {
    actions += '<button type="button" class="op-qa" title="Copy the Part 2 link"'
      + ' onclick="event.stopPropagation();opNaPart2(&quot;' + opAttr(r.id) + '&quot;)">'
      + '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/>'
      + '<path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg></button>';
  }
  actions += '</div>';

  return '<article class="op-card" onclick="opNaOpen(\'' + opAttr(r.id) + '\')">'
    + '<div class="op-card-top">' + opAvatar(null, r.name, 'lg')
    + '<div class="op-card-id"><div class="op-card-name">' + opEsc(r.name) + '</div>'
    + '<div class="op-card-mail">' + opEsc([r.email, phone].filter(Boolean).join(' \u00b7 ')) + '</div>'
    + '<div class="op-card-tags">' + opNaBadges(r) + '</div></div></div>'
    + '<div class="op-card-facts"><span>' + opEsc(opDate(r.submitted_at || r.updated_at || r.created_at)) + '</span>'
    + (r.goal ? '<span>Goal: <b>' + opEsc(r.goal) + '</b></span>' : '')
    + (r.tdee ? '<span>TDEE: <b>' + r.tdee + '</b></span>' : '') + '</div>'
    + actions + '</article>';
}

async function opNaOpen(id) {
  var row = ((opState.na || {}).rows || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (!row) return;
  opState.story = { kind: 'lead' };

  var head = opStoryBackBtn() + opAvatar(null, row.name, 'xl')
    + '<div class="op-story-id"><div class="op-story-title">' + opEsc(row.name) + '</div>'
    + '<div class="op-story-sub">' + opEsc([row.email, row.mobile].filter(Boolean).join(' \u00b7 ')) + '</div></div>'
    + '<div class="op-story-pills"><span class="op-tag">FitChef assessment</span></div>';

  var wa = opWa(row.mobile);
  var h = '<div class="op-actbar">';
  if (wa) h += '<a class="op-btn wa" href="' + wa + '" target="_blank" rel="noopener">\ud83d\udcac WhatsApp</a>';
  if (row.mobile) h += '<a class="op-btn quiet" href="tel:' + opEsc(String(row.mobile).replace(/[^0-9+]/g, '')) + '">\ud83d\udcde Call</a>';
  if (row.email) h += '<a class="op-btn quiet" href="mailto:' + opEsc(row.email) + '">\u2709\ufe0f Email</a>';
  h += '</div>';
  h += '<div class="op-card-tags" style="margin-bottom:18px">' + opNaBadges(row) + '</div>';
  h += '<div id="opNaDetail"><div class="op-empty">Loading the answers\u2026</div></div>';
  opStoryOpen(head, h);

  var d;
  try { d = await apiCall('GET', '/api/nutrition-assessment/' + id); }
  catch (e) { d = null; }
  var host = opEl('opNaDetail');
  if (!host) return;
  if (!d || d.error) { host.innerHTML = '<div class="op-empty">Could not load the answers.</div>'; return; }

  var out = '';
  if ((d.flags || []).length) {
    out += '<div class="op-sub" style="margin-top:0;color:#ff8a8a">Needs review before a plan goes out</div><div class="op-lines">'
      + d.flags.map(function (f) {
        return opKV(f.label + (f.clinician ? ' \u00b7 clinician' : ''), opEsc(f.detail));
      }).join('') + '</div>';
  }
  var dv = d.derived || {};
  if (dv.bmr) {
    out += '<div class="op-sub">The numbers</div><div class="op-lines">'
      + opKV('BMR', opEsc(String(dv.bmr)))
      + opKV('TDEE', dv.tdee ? opEsc(String(dv.tdee)) : '')
      + opKV('Calorie target', dv.calorie_target ? opEsc(String(dv.calorie_target)) : '')
      + opKV('Protein', dv.protein_target_g ? opEsc(dv.protein_target_g.low + '\u2013' + dv.protein_target_g.high + ' g') : '')
      + opKV('Waist-to-height', dv.whtr ? opEsc(String(dv.whtr)) : '')
      + '</div>';
  }
  (d.sections || []).forEach(function (sec) {
    out += '<div class="op-sub">' + opEsc(sec.title) + '</div><div class="op-lines">'
      + sec.rows.map(function (r) { return opKV(r.label, opEsc(opNaValue(r.value))); }).join('')
      + '</div>';
  });
  host.innerHTML = out || '<div class="op-empty">Nothing filled in yet.</div>';
}

function opNaValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    return Object.keys(v).map(function (k) {
      var inner = v[k];
      if (inner && typeof inner === 'object') return k + ': ' + [inner.at, inner.what].filter(Boolean).join(' ');
      return k + ': ' + inner;
    }).join(' \u00b7 ');
  }
  return String(v);
}
function renderOperatorLeads() {
  var el = opEl('opLeadCards'); if (!el) return;
  var d = opState.leads || {};
  var q = ((opEl('opLeadsSearch') || {}).value || '').trim();
  var rows;
  if (opState.leadsView === 'nutrition') {
    var na = ((opState.na || {}).rows || []).filter(function (p) { return bbContactMatches(q, [p.name, p.email], [p.mobile]); });
    var sm = (opState.na || {}).summary || {};
    var l0 = opEl('opLeadLine'), s0 = opEl('opLeadSub');
    if (l0) l0.innerHTML = '<b>' + na.length + '</b> FitChef assessment' + (na.length === 1 ? '' : 's');
    if (s0) s0.textContent = [
      (sm.part1_done || 0) + ' Part 1 in', (sm.complete || 0) + ' Part 2 in',
      (sm.awaiting_part2 || 0) + ' awaiting Part 2',
      (sm.flagged || 0) + ((sm.flagged || 0) === 1 ? ' needs review' : ' need review')
    ].join(' \u00b7 ');
    // Operators chase people, so they need the same two links the admin has.
    // Both are shareable: Part 2 asks which email was used for Part 1.
    var naData = opState.na || {};
    var origin = (window.BB_PUBLIC_ORIGIN || window.location.origin);
    var u1 = naData.part1_share_url || naData.share_url || (origin + '/nutrition-assessment.html');
    var u2 = naData.part2_share_url || (origin + '/nutrition-assessment.html?part=2');
    var links = '<div class="op-na-links">'
      + '<button type="button" class="op-bub more" onclick="opCopyText(&quot;' + opAttr(u1) + '&quot;,&quot;Part 1 link copied.&quot;)">Copy Part 1 link</button>'
      + '<button type="button" class="op-bub more" onclick="opCopyText(&quot;' + opAttr(u2) + '&quot;,&quot;Part 2 link copied. It asks which email they used for Part 1.&quot;)">Copy Part 2 link</button>'
      + '</div>';

    el.innerHTML = links + (na.length ? na.map(opNaCard).join('')
      : '<div class="op-empty pad">' + (q ? 'Nothing matches this search.' : 'No assessments yet.') + '</div>');
    return;
  }
  if (opState.leadsView === 'part2') {
    rows = (d.part2 || []).filter(function (p) { return bbContactMatches(q, [p.name, p.email], [p.mobile]); })
      .map(function (p) { return { kind: 'part2', id: p.id, raw: p }; });
  } else {
    rows = (d.audits || []).filter(function (a) { return bbContactMatches(q, [a.first_name, a.last_name, a.email], [a.phone]); })
      .map(function (a) { return { kind: 'audit', id: a.id, raw: a }; });
  }
  var c = d.counts || {};
  var line = opEl('opLeadLine'), sub = opEl('opLeadSub');
  if (line) line.innerHTML = '<b>' + rows.length + '</b> ' + (opState.leadsView === 'part2' ? 'Part-2 form' : 'body audit') + (rows.length === 1 ? '' : 's');
  if (sub) sub.textContent = [
    (c.audits_today || 0) + ' today', (c.audits_7d || 0) + ' this week',
    (c.audits_no_account || 0) + ' never signed up'
  ].join(' · ');

  el.innerHTML = rows.length ? rows.map(opLeadCard).join('')
    : '<div class="op-empty pad">' + (q ? 'Nothing matches this search.' : 'No submissions in this period.') + '</div>';
}
function opAuditBadges(a) {
  return (a.has_account ? '<span class="op-tag ok">Signed up</span>' : '<span class="op-tag warn">No account</span>')
    + (a.has_part2 ? '<span class="op-tag ok">Part-2 done</span>' : '<span class="op-tag">No Part-2</span>')
    + (a.stage ? '<span class="op-tag info">' + opEsc(opLiftLabel(a.stage)) + '</span>' : '');
}
function opPart2Badges(p) {
  return (p.has_account ? '<span class="op-tag ok">Signed up</span>' : '<span class="op-tag warn">No account</span>')
    + (p.tier_label ? '<span class="op-tag info">' + opEsc(p.tier_label) + (p.score != null ? ' · ' + p.score : '') + '</span>' : '');
}
function opLeadCard(r) {
  var raw = r.raw;
  var name = r.kind === 'part2' ? (raw.name || raw.email || 'Prospect') : opFullName(raw);
  var phone = raw.phone || raw.mobile || '';
  var wa = opWa(phone);
  var badges = r.kind === 'part2' ? opPart2Badges(raw) : opAuditBadges(raw);
  var actions = '<div class="op-card-actions">';
  if (wa) actions += '<a class="op-qa wa" href="' + wa + '" target="_blank" rel="noopener" title="WhatsApp" onclick="event.stopPropagation()">'
    + '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.2-5.2A8.5 8.5 0 1 1 21 11.5Z"/></svg></a>';
  if (phone) actions += '<a class="op-qa" href="tel:' + opEsc(String(phone).replace(/[^0-9+]/g, '')) + '" title="Call" onclick="event.stopPropagation()">'
    + '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg></a>';
  if (raw.email) actions += '<a class="op-qa" href="mailto:' + opEsc(raw.email) + '" title="Email" onclick="event.stopPropagation()">'
    + '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg></a>';
  actions += '</div>';

  return '<article class="op-card" onclick="opLeadOpen(\'' + r.kind + '\',\'' + opAttr(r.id) + '\')">'
    + '<div class="op-card-top">' + opAvatar(null, name, 'lg')
    + '<div class="op-card-id"><div class="op-card-name">' + opEsc(name) + '</div>'
    + '<div class="op-card-mail">' + opEsc([raw.email, phone].filter(Boolean).join(' · ')) + '</div>'
    + '<div class="op-card-tags">' + badges + '</div></div></div>'
    + '<div class="op-card-facts"><span>' + opEsc(opDate(raw.created_at)) + '</span>'
    + (raw.goals ? '<span>Goal: <b>' + opEsc(raw.goals) + '</b></span>' : '') + '</div>'
    + actions + '</article>';
}
function opLeadOpen(kind, id) {
  var d = opState.leads || {};
  var raw = kind === 'part2'
    ? (d.part2 || []).filter(function (p) { return String(p.id) === String(id); })[0]
    : (d.audits || []).filter(function (a) { return String(a.id) === String(id); })[0];
  if (!raw) return;
  opState.story = { kind: 'lead' };
  var name = kind === 'part2' ? (raw.name || raw.email || 'Prospect') : opFullName(raw);
  var phone = raw.phone || raw.mobile || '';

  var head = opStoryBackBtn() + opAvatar(null, name, 'xl')
    + '<div class="op-story-id"><div class="op-story-title">' + opEsc(name) + '</div>'
    + '<div class="op-story-sub">' + opEsc([raw.email, phone].filter(Boolean).join(' · ')) + '</div></div>'
    + '<div class="op-story-pills"><span class="op-tag">' + (kind === 'part2' ? 'Part-2 form' : 'Body audit') + '</span></div>';

  var wa = opWa(phone);
  var h = '<div class="op-actbar">';
  if (wa) h += '<a class="op-btn wa" href="' + wa + '" target="_blank" rel="noopener">💬 WhatsApp</a>';
  if (phone) h += '<a class="op-btn quiet" href="tel:' + opEsc(String(phone).replace(/[^0-9+]/g, '')) + '">📞 Call</a>';
  if (raw.email) h += '<a class="op-btn quiet" href="mailto:' + opEsc(raw.email) + '">✉️ Email</a>';
  h += '</div>';
  h += '<div class="op-card-tags" style="margin-bottom:18px">' + (kind === 'part2' ? opPart2Badges(raw) : opAuditBadges(raw)) + '</div>';
  h += '<div class="op-sub" style="margin-top:0">What they told us</div><div class="op-lines">';
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
    h += '<div class="op-sub">Why they reached out</div><div class="op-quote">' + opEsc(raw.motivation) + '</div>';
  }
  opStoryOpen(head, h);
}

/* ================================================================= INBOX */
async function loadOperatorEscalations(quiet) {
  var el = opEl('opEscCards');
  if (el && !quiet) el.innerHTML = '<div class="op-empty pad">Loading…</div>';
  try {
    var d = await apiCall('GET', '/api/operator/escalations');
    if (!d || d.error) { if (el) el.innerHTML = '<div class="op-empty pad">' + opEsc((d && d.error) || 'Could not load.') + '</div>'; return; }
    var rows = d.rows || [];
    opState.escalations = rows;
    var unread = rows.filter(function (e) { return (e.admin_replies || 0) > 0 && e.last_role === 'admin'; }).length;
    var badge = opEl('opRailBadgeInbox');
    if (badge) { badge.textContent = unread > 99 ? '99+' : unread; badge.classList.toggle('on', unread > 0); }
    renderOperatorHome();
    var line = opEl('opInboxLine');
    if (line) line.innerHTML = rows.length
      ? '<b>' + rows.length + '</b> ' + (rows.length === 1 ? 'thread' : 'threads') + (unread ? ' · ' + unread + ' with a new reply' : '')
      : 'Admin inbox';
    if (el) {
      el.innerHTML = rows.length ? rows.map(opEscCard).join('')
        : '<div class="op-empty pad">Nothing shared with Admin yet.<br>Open a client and tap “Share to Admin” to start a thread.</div>';
    }
  } catch (e) { if (el) el.innerHTML = '<div class="op-empty pad">Could not load.</div>'; }
}
function opEscCard(e) {
  var replied = (e.admin_replies || 0) > 0;
  var badge = replied ? '<span class="op-tag ok">Admin replied</span>' : '<span class="op-tag warn">Awaiting admin</span>';
  return '<article class="op-card" onclick="opEscOpen(\'' + opAttr(e.id) + '\')">'
    + '<div class="op-card-top">' + opAvatar(null, e.client_name || 'Client', 'lg')
    + '<div class="op-card-id"><div class="op-card-name">' + opEsc(e.client_name || 'Client') + '</div>'
    + '<div class="op-card-mail">' + opEsc(e.summary || '') + '</div>'
    + '<div class="op-card-tags">' + badge + '<span class="op-tag">' + opEsc(opTimeAgo(e.updated_at)) + '</span></div></div></div>'
    + '<div class="op-quote sm">' + opEsc((e.last_role === 'admin' ? 'Admin: ' : 'You: ') + (e.last_body || '')) + '</div>'
    + '</article>';
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
  opState.story = { kind: 'thread' };
  opStoryOpen(opStoryBackBtn() + '<div class="op-story-id"><div class="op-story-title">Loading…</div></div>', '<div class="op-empty pad">Loading…</div>');
  try {
    var d = await apiCall('GET', '/api/operator/escalations/' + encodeURIComponent(eid) + '/messages');
    if (!d || d.error) {
      opStoryOpen(opStoryBackBtn() + '<div class="op-story-id"><div class="op-story-title">Thread</div></div>', '<div class="op-empty pad">Could not load.</div>');
      return;
    }
    var e = d.escalation || {};
    var head = opStoryBackBtn() + opAvatar(null, e.client_name || 'Client', 'xl')
      + '<div class="op-story-id"><div class="op-story-title">' + opEsc(e.client_name || 'Client') + '</div>'
      + '<div class="op-story-sub">' + opEsc(e.summary || '') + '</div></div>'
      + '<div class="op-story-pills">'
      + (e.client_id ? '<button type="button" class="op-btn line" onclick="openOperatorClient(\'' + opAttr(e.client_id) + '\')">Open client</button>' : '')
      + '</div>';
    var body = '<div class="op-thread"><div class="op-chat-wrap" id="opEscMessages"></div>'
      + '<div class="op-reply-row"><textarea id="opEscReplyText" placeholder="Reply to admin…"></textarea>'
      + '<button type="button" onclick="opEscReply()">Send</button></div></div>';
    opStoryOpen(head, body);
    opRenderEscMessages(opEl('opEscMessages'), d.messages || [], 'operator');
    var sb = opEl('opStoryBody'); if (sb) sb.scrollTop = sb.scrollHeight;
  } catch (e) {
    opStoryOpen(opStoryBackBtn() + '<div class="op-story-id"><div class="op-story-title">Thread</div></div>', '<div class="op-empty pad">Could not load.</div>');
  }
}
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

/* ================================================================= PULSE */
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
      { l: 'Active today', v: eng.active_rate || 0, sub: (s.active_today || 0) + ' of ' + (s.total_clients || 0), invert: false },
      { l: 'Checked in', v: eng.checkin_rate || 0, sub: (s.checked_in_today || 0) + ' of ' + (s.total_clients || 0), invert: false },
      { l: 'Avg consistency', v: eng.avg_consistency_pct || 0, sub: 'over 7 days', invert: false },
      { l: 'Need chasing', v: eng.at_risk_rate || 0, sub: opPlural((s.at_risk_p0 || 0) + (s.at_risk_p1 || 0), 'client'), invert: true }
    ];
    var mEl = opEl('opMeters');
    if (mEl) {
      mEl.innerHTML = meters.map(function (m) {
        var cls = m.invert ? (m.v >= 40 ? 'bad' : (m.v >= 20 ? 'warn' : 'ok'))
          : (m.v < 30 ? 'bad' : (m.v < 60 ? 'warn' : 'ok'));
        return '<div class="op-meter"><div class="op-meter-top"><span class="op-meter-l">' + opEsc(m.l) + '<br><i>' + opEsc(m.sub) + '</i></span>'
          + '<span class="op-meter-v">' + m.v + '%</span></div>'
          + '<div class="op-track"><div class="op-fill ' + cls + '" data-w="' + m.v + '"></div></div></div>';
      }).join('');
      opAnimateBars(mEl);
    }
    opDrawTrendChart(data.trends);
    opRenderAssessmentsAndWearables(data);
    opRenderQuickAccess(data);
  } catch (e) { }
}

/**
 * Nutrition assessments and wearable adoption on the operator pulse screen.
 *
 * Read-only by design, matching the rest of this console: an operator can see
 * that six assessments need review and chase them, but clearing the flag stays on
 * the admin side.
 *
 * Renders into #opExtras when the markup provides it, and otherwise appends a
 * block after the meters, so this works whether or not index.html has been
 * updated to carry a dedicated container.
 */
function opRenderAssessmentsAndWearables(data) {
  var na = (data && data.nutritionAssessments) || null;
  var wr = (data && data.wearables) || null;
  // An older server build returns neither key. Render nothing rather than a row
  // of zeros, which would read as "nobody has done this" instead of "unknown".
  if (!na && !wr) return;

  var host = opEl('opExtras');
  if (!host) {
    var mEl = opEl('opMeters');
    if (!mEl || !mEl.parentNode) return;
    host = document.createElement('div');
    host.id = 'opExtras';
    host.style.marginTop = '18px';
    mEl.parentNode.insertBefore(host, mEl.nextSibling);
  }

  var h = '';

  if (na) {
    var needs = Number(na.needs_review) || 0;
    h += '<div class="op-sub">FitChef assessments</div>'
      + '<div class="op-kpi-row" style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px">'
      + opExtraStat('Part 1 in', Number(na.part1_submitted) || 0)
      + opExtraStat('Part 2 in', Number(na.part2_submitted) || 0, 'ok')
      + opExtraStat('Awaiting Part 2', Number(na.awaiting_part2) || 0,
        (Number(na.awaiting_part2) || 0) > 0 ? 'warn' : 'ok')
      + opExtraStat('New · 7d', Number(na.new_7d) || 0)
      + opExtraStat('Needs review', needs, needs > 0 ? 'warn' : 'ok')
      + '</div>';
    if (needs > 0) {
      // These are safety flags a human has to clear — a clinician referral, a
      // pregnancy, a disordered-eating signal — so they get a direct route.
      h += '<button type="button" class="op-bub more" onclick="opNav(\'prospects\');opLeadsView(\'nutrition\')">'
        + 'Review ' + needs + ' flagged FitChef assessment' + (needs === 1 ? '' : 's') + '</button>';
    }
  }

  if (wr) {
    var mix = Array.isArray(wr.by_device) ? wr.by_device : [];
    h += '<div class="op-sub" style="margin-top:14px">Watch data</div>'
      + '<div class="op-kpi-row" style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px">'
      + opExtraStat('Members', Number(wr.members) || 0)
      + opExtraStat('Adoption', (Number(wr.adoption_rate) || 0) + '%')
      + opExtraStat('Active · 7d', Number(wr.active_7d) || 0)
      + opExtraStat('Uploads · 7d', Number(wr.uploads_7d) || 0)
      + '</div>';
    if (mix.length) {
      h += '<div style="font-size:12.5px;opacity:.9">' + mix.slice(0, 8).map(function (d) {
        var name = String(d.provider || '').replace(/_/g, ' ');
        // Say it plainly: a figure an AI read off a screenshot is not the same
        // evidence as one parsed out of the device's own export.
        var low = (d.provider === 'screenshot' || d.provider === 'manual')
          ? ' <i style="opacity:.7">· lower confidence</i>' : '';
        return '<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0">'
          + '<span>' + opEsc(name.charAt(0).toUpperCase() + name.slice(1)) + low + '</span>'
          + '<span>' + (Number(d.members) || 0) + '</span></div>';
      }).join('') + '</div>';
    } else {
      h += '<div class="op-empty">No watch data imported yet.</div>';
    }
  }

  host.innerHTML = h;
}

/**
 * Quick access tiles on the operator home.
 *
 * Both destinations already existed but were effectively unreachable: the FitChef
 * assessments sat behind a chip inside Prospects, and watch data only appeared on
 * a member's own Readiness tab. These put a live count on the home screen and go
 * straight there.
 *
 * The whole block stays hidden against an older server payload — a tile reading 0
 * would claim "nobody has submitted one", which is a different statement from
 * "this server does not report it yet".
 */
function opRenderQuickAccess(data) {
  var block = opEl('opQuickBlock');
  var host = opEl('opQuickAccess');
  if (!block || !host) return;

  var na = (data && data.nutritionAssessments) || null;
  var wr = (data && data.wearables) || null;
  if (!na && !wr) { block.style.display = 'none'; return; }
  block.style.display = '';

  var tile = function (n, label, sub, tone, onclick) {
    return '<button type="button" class="op-mon-tile' + (tone ? ' ' + tone : '') + (Number(n) ? '' : ' zero') + '"'
      + ' onclick="' + onclick + '">'
      + '<span class="op-mon-n">' + (Number(n) || 0) + '</span>'
      + '<span class="op-mon-l">' + opEsc(label) + '</span>'
      + '<span class="op-mon-s">' + opEsc(sub) + '</span>'
      + '</button>';
  };

  var h = '';
  if (na) {
    var needs = Number(na.needs_review) || 0;
    var waiting = Number(na.awaiting_part2) || 0;
    h += tile(na.part1_submitted, 'FitChef Part 1', 'submitted', 'info',
      'opNav(&quot;prospects&quot;);opLeadsView(&quot;nutrition&quot;)');
    h += tile(na.part2_submitted, 'FitChef Part 2',
      waiting ? waiting + ' still to send' : 'all caught up', waiting ? 'warn' : 'ok',
      'opNav(&quot;prospects&quot;);opLeadsView(&quot;nutrition&quot;)');
    // Safety flags a human has to clear, so this one is red whenever it is non-zero.
    h += tile(needs, 'Need review', needs ? 'before a plan goes out' : 'all clear',
      needs > 0 ? 'bad' : 'ok',
      'opNav(&quot;prospects&quot;);opLeadsView(&quot;nutrition&quot;)');
  }
  if (wr) {
    var mix = Array.isArray(wr.by_device) ? wr.by_device : [];
    var sub = mix.length
      ? mix.slice(0, 2).map(function (d) { return String(d.provider || '').replace(/_/g, ' '); }).join(', ')
        + (mix.length > 2 ? ' +' + (mix.length - 2) : '')
      : 'none imported yet';
    h += tile(wr.members, 'Watch data', sub, 'info', 'opNav(&quot;clients&quot;)');
    h += tile(wr.uploads_7d, 'Imports', 'in the last 7 days', 'ok', 'opNav(&quot;pulse&quot;)');
  }
  host.innerHTML = h;
}

function opExtraStat(label, value, tone) {
  return '<div class="op-kv" style="min-width:96px">'
    + '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.65">' + opEsc(label) + '</div>'
    + '<div class="op-tag ' + (tone || '') + '" style="font-size:16px;font-weight:700;background:none;padding:0">'
    + opEsc(String(value)) + '</div></div>';
}

function opDrawTrendChart(trends) {
  if (typeof Chart === 'undefined' || !trends) return;
  var el = opEl('opTrendChart'); if (!el) return;
  opKillChart('trend');
  var labels = (trends.labels || []).map(function (d) {
    var dt = new Date(d); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  window._opCharts.trend = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Check-ins', data: trends.checkins || [], backgroundColor: 'rgba(70,196,166,0.85)', borderRadius: 3, maxBarThickness: 14 },
        { label: 'Workouts', data: trends.workouts || [], backgroundColor: 'rgba(240,178,94,0.9)', borderRadius: 3, maxBarThickness: 14 },
        { label: 'Meals', data: trends.meals || [], backgroundColor: 'rgba(116,208,230,0.8)', borderRadius: 3, maxBarThickness: 14 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: OP_TICK, font: { size: 11 }, boxWidth: 10, padding: 10 } } },
      scales: {
        x: { stacked: true, ticks: { color: OP_TICK, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: OP_TICK, font: { size: 10 }, precision: 0 }, grid: { color: OP_GRID } }
      }
    }
  });
}

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
    opState.activityItems = items;
    opRenderHomeFeed();
    var c = opEl('opLiveCount'); if (c) c.textContent = items.length;
    if (!items.length) { el.innerHTML = '<div class="op-empty">Nothing logged in this period.</div>'; return; }
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
  } catch (e) { el.innerHTML = '<div class="op-empty">Could not load activity.</div>'; }
}

/* ====================================================== OVERVIEW (landing) */
/* The briefing an operator sees the second they log in. Not a grid of metrics
   — a sentence about today, one ring for roster health, and the three things
   that actually need doing. Everything here is derived from reads the console
   already makes, so the landing costs no extra request. */

function opGreeting() {
  var h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function opOperatorName() {
  var u = window.currentUser || {};
  var n = String(u.first_name || '').trim();
  if (n) return n;
  var e = String(u.email || '').split('@')[0];
  return e ? e.charAt(0).toUpperCase() + e.slice(1) : '';
}

/* One ranked list of work across the whole business, not just clients. */
function opBriefPriorities() {
  var out = [];
  var TONE = { bad: 0, warn: 1, info: 2, ok: 3 };
  (opState.clients || []).forEach(function (c) {
    var a = opNextAction(c);
    if (a.key === 'ok') return;
    var idle = c.inactive_days || 0;
    var left = (c.subscription_status === 'trialing') ? opDaysUntil(c.access_expires_at) : null;
    var days = (left != null && left <= 3)
      ? (left <= 0 ? 'trial' : left + 'd left')
      : (idle >= 1 ? idle + 'd' : 'today');
    out.push({
      rank: TONE[a.tone], tone: a.tone, kind: 'client', id: c.id, days: days,
      name: opFullName(c), pic: c.profile_picture, label: a.label, actKey: a.key,
      meta: (c.checkins_7d || 0) + '/7 check-ins · ' + opPlural(c.workouts_7d || 0, 'workout')
    });
  });
  (opState.escalations || []).forEach(function (e) {
    if (!((e.admin_replies || 0) > 0 && e.last_role === 'admin')) return;
    out.push({
      rank: 0.5, tone: 'info', kind: 'thread', id: e.id, pic: null, days: 'reply',
      name: 'Admin replied about ' + (e.client_name || 'a client'),
      label: 'Read what Admin said', meta: String(e.last_body || '').slice(0, 70)
    });
  });
  out.sort(function (a, b) { return a.rank - b.rank; });
  return out;
}

/* One bubble in the attention reel: the face, and how long they have been
   quiet. Everything else — the stats, the action — lives one tap away inside
   the client, so the row itself stays scannable at a glance. */
function opPriorityBubble(p) {
  var open = p.kind === 'thread'
    ? "opEscOpen('" + opAttr(p.id) + "')"
    : "openOperatorClient('" + opAttr(p.id) + "')";
  var first = String(p.name || '').trim().split(/\s+/)[0] || '';
  return '<button type="button" class="op-bub ' + p.tone + '" onclick="' + open + '"'
    + ' title="' + opEsc(p.name + ' — ' + p.label) + '">'
    + '<span class="op-bub-ring">' + opAvatar(p.pic, p.name, 'bub') + '</span>'
    + '<span class="op-bub-days">' + opEsc(p.days) + '</span>'
    + '<span class="op-bub-name">' + opEsc(first) + '</span>'
    + '</button>';
}

function opMonTile(filter, label, sub, tone) {
  var n = opCount(filter);
  return '<button type="button" class="op-mon-tile' + (tone ? ' ' + tone : '') + (n ? '' : ' zero') + '"'
    + ' onclick="opMonitor(&quot;' + filter + '&quot;)">'
    + '<span class="op-mon-n">' + n + '</span>'
    + '<span class="op-mon-l">' + opEsc(label) + '</span>'
    + '<span class="op-mon-s">' + opEsc(sub) + '</span>'
    + '</button>';
}

function renderOperatorHome() {
  if (!opEl('opScreen-home')) return;
  var list = opState.clients || [];
  var total = list.length;
  var need = list.filter(opNeedsAttention).length;

  var dEl = opEl('opHeroDate');
  if (dEl) { try { dEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { } }
  var gEl = opEl('opHeroGreet');
  if (gEl) { var nm = opOperatorName(); gEl.textContent = opGreeting() + (nm ? ', ' + nm : ''); }

  // ---- the hero: is engagement climbing or sliding? -----------------------
  var trends = (opState.overview || {}).trends || {};
  var series = (trends.active || []).slice(-14);
  var activeNow = opCount('active');
  var pct = total ? Math.round((activeNow / total) * 100) : 0;

  opSetTxt('opActiveN', total ? activeNow : '–');
  var ofEl = opEl('opActiveOf');
  if (ofEl) ofEl.textContent = total ? ' of ' + total + ' active in the last 7 days' : ' no clients yet';
  var fill = opEl('opActiveFill');
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = 'op-pb-fill ' + (pct >= 60 ? 'ok' : (pct >= 25 ? 'warn' : 'bad'));
  }

  // this week against the one before it — the comparison that means "progress"
  var dEl = opEl('opActiveDelta');
  if (dEl) {
    if (series.length >= 14) {
      var avg = function (arr) { return arr.reduce(function (x, y) { return x + y; }, 0) / arr.length; };
      var thisWk = avg(series.slice(7)), lastWk = avg(series.slice(0, 7));
      var diff = Math.round((thisWk - lastWk) * 10) / 10;
      if (!lastWk && !thisWk) { dEl.textContent = 'no activity either week'; dEl.className = 'op-pb-delta flat'; }
      else if (diff > 0) { dEl.textContent = '▲ ' + diff + '/day vs last week'; dEl.className = 'op-pb-delta up'; }
      else if (diff < 0) { dEl.textContent = '▼ ' + Math.abs(diff) + '/day vs last week'; dEl.className = 'op-pb-delta down'; }
      else { dEl.textContent = 'level with last week'; dEl.className = 'op-pb-delta flat'; }
    } else { dEl.textContent = ''; dEl.className = 'op-pb-delta'; }
  }

  // 14 bars of daily active clients — the actual progress view
  var spark = opEl('opActiveSpark');
  if (spark) {
    if (!series.length) {
      spark.innerHTML = '<div class="op-spark-empty">Daily activity appears here once clients start logging.</div>';
      opSetTxt('opSparkPeak', '');
    } else {
      var peak = Math.max.apply(null, series.concat([1]));
      var labels = trends.labels || [];
      spark.innerHTML = series.map(function (v, i) {
        var h = Math.max(3, Math.round((v / peak) * 100));
        var when = labels[labels.length - series.length + i] || '';
        var day = when ? new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
        return '<span class="op-spark-b' + (i === series.length - 1 ? ' now' : '') + (v ? '' : ' nil') + '"'
          + ' style="height:' + h + '%" title="' + opEsc(day) + ': ' + opPlural(v, 'active client') + '"></span>';
      }).join('');
      opSetTxt('opSparkPeak', 'peak ' + peak);
    }
  }

  // today's logging, stated as a share of the roster and clickable
  var hs = opEl('opHeroStats');
  if (hs) {
    var mini = function (key, label) {
      var n = opCount(key);
      return '<button type="button" class="op-hstat' + (n ? '' : ' nil') + '" onclick="opMonitor(&quot;' + key + '&quot;)">'
        + '<b>' + n + '</b><i>/' + total + '</i><span>' + opEsc(label) + '</span></button>';
    };
    hs.innerHTML = total ? mini('checkin', 'checked in today') + mini('workout', 'trained today') + mini('meal', 'logged a meal') : '';
  }

  var hb = opEl('opRailBadgeHome');
  if (hb) { hb.textContent = need > 99 ? '99+' : need; hb.classList.toggle('on', need > 0); }

  // three is a plan; thirty is a wall
  var pEl = opEl('opPriorities');
  if (pEl) {
    var pri = opBriefPriorities();
    if (pri.length) {
      pEl.innerHTML = '<div class="op-reel">' + pri.slice(0, 12).map(opPriorityBubble).join('')
        + (pri.length > 12 ? '<button type="button" class="op-bub more" onclick="opNav(&quot;clients&quot;);opClientFilter(&quot;attention&quot;)">'
          + '<span class="op-bub-ring"><span class="op-avatar bub">+' + (pri.length - 12) + '</span></span>'
          + '<span class="op-bub-days">more</span><span class="op-bub-name">&nbsp;</span></button>' : '')
        + '</div>';
    } else {
      pEl.innerHTML = '<div class="op-allclear"><span>✓</span><div><b>Nothing needs chasing.</b>'
        + '<i>Every client is inside their check-in, training and trial windows.</i></div></div>';
    }
  }

  var of = function (n) { return total ? n + ' of ' + total : 'no clients yet'; };

  var todayEl = opEl('opMonToday');
  if (todayEl) {
    todayEl.innerHTML =
      opMonTile('active', 'Active clients', of(opCount('active')) + ' · last 7 days', 'ok')
      + opMonTile('inactive', 'Inactive clients', of(opCount('inactive')) + ' · nothing logged', 'bad')
      + opMonTile('checkin', 'Checked in', of(opCount('checkin')) + ' today', 'amber')
      + opMonTile('workout', 'Trained', of(opCount('workout')) + ' today', 'amber')
      + opMonTile('meal', 'Logged a meal', of(opCount('meal')) + ' today', 'amber');
  }

  var watchEl = opEl('opMonWatch');
  if (watchEl) {
    watchEl.innerHTML =
      opMonTile('noblood', 'No blood report', 'never uploaded one', 'bad')
      + opMonTile('expiring', 'Trials ending', 'within 3 days', 'bad')
      + opMonTile('nosunday', 'Missed Sunday', 'no weekly check-in', 'amber')
      + opMonTile('newthisweek', 'New this week', 'joined in 7 days', 'info');
  }

  // renderOperatorHome() is also called on its own (after a client action, on a
  // filter change), not only behind loadOperatorOverview(). Re-render the quick
  // access tiles from whatever overview we already hold so they do not blank out.
  opRenderQuickAccess(opState.overview);

  opRenderHomeFeed();
}

function opRenderHomeFeed() {
  var el = opEl('opHomeFeed'); if (!el) return;
  var items = opState.activityItems || [];
  if (!items.length) { el.innerHTML = '<div class="op-empty">Nothing logged in the last few days.</div>'; return; }
  el.innerHTML = items.slice(0, 7).map(function (f) {
    return '<div class="op-feed-item"><span class="op-dot ' + opEsc(f.type || '') + '"></span>'
      + '<div class="op-feed-main"><div class="op-feed-name">' + opEsc(f.name || '') + '</div>'
      + '<div class="op-feed-label">' + opEsc(f.label || '') + (f.detail ? ' — ' + opEsc(f.detail) : '') + '</div></div>'
      + '<span class="op-feed-time">' + opEsc(opTimeAgo(f.created_at)) + '</span></div>';
  }).join('');
}

/* =============================================================== COMPOSE */
function opComposeFor(id, name, mode) {
  window._opCurrentClient = (window._opCurrentClient && String(window._opCurrentClient.id) === String(id))
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
function opComposeReminder() { var c = window._opCurrentClient; if (c) opComposeFor(c.id, c.name, 'reminder'); }
function opComposeShare() { var c = window._opCurrentClient; if (c) opComposeFor(c.id, c.name, 'share'); }
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
