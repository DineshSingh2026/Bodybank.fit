/* BodyBank — member screens.
 *
 *   bbxOpenStreak()          Daily Streak (tap the streak on Home)
 *   bbxOpenReport(end?)      two-week performance report
 *   bbxOpenBlood(reportId)   graded view of one blood report
 *   bbxRenderMind()          Mind check-in, drawn into Check-in → Mind
 *   bbxOpenMembership()      My Membership (plan chip on Home, Profile row)
 *
 * Data: /api/me/screens/* (routes/memberScreens.js). Styles: css/member-screens.css.
 * Full-screen views are a CSS overlay (never the Fullscreen API — see the WebView
 * fullscreen trap), with one history entry so the Android / browser back button
 * closes them. Nothing here shows a price or a purchase link: this file ships in
 * the iOS and Android apps.
 */
(function () {
  'use strict';

  var API = '/api/me/screens';

  // ── helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, url, body) {
    if (typeof window.apiCall !== 'function') return Promise.resolve({ error: 'Not ready' });
    return window.apiCall(method, url, body);
  }
  function fmtNum(n) { return Number(n).toLocaleString('en-IN'); }
  function monthName(ym) {
    var p = String(ym || '').split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, 1));
    try { return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return ym; }
  }
  function shortDate(ymd) {
    var d = new Date(String(ymd) + 'T00:00:00Z');
    try { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch (e) { return ymd; }
  }
  function hm(hours) {
    if (hours == null) return '—';
    var h = Math.floor(hours); var m = Math.round((hours - h) * 60);
    if (m === 60) { h += 1; m = 0; }
    return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  }
  function isMember() { return !!(window.currentUser && window.currentUser.role === 'user'); }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    steth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v2a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="11" r="2"/></svg>',
    apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7c-1.5-1-5-1.3-6.3 1.6C4.5 11.2 6 17 8.6 19.4c1.1 1 2.2.7 3.4.2 1.2.5 2.3.8 3.4-.2C18 17 19.5 11.2 18.3 8.6 17 5.7 13.5 6 12 7z"/><path d="M12 7c0-2 1-3.5 3-4"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    breath: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12h7"/></svg>',
    yoga: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="1.8"/><path d="M12 7.5v6M6 10.5l6 2 6-2M9 20l3-6.5 3 6.5"/></svg>',
    scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M7.5 12h9"/></svg>',
    ground: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/></svg>'
  };

  // Five faces, Low → Great: brows/mouth drawn so each reads at 28px.
  function faceSvg(v) {
    var mouth = {
      1: '<path d="M8.5 16.2c1.9-1.6 5.1-1.6 7 0"/>',
      2: '<path d="M8.8 15.5h6.4"/>',
      3: '<path d="M8.8 14.9c1.8.9 4.6.9 6.4 0"/>',
      4: '<path d="M8.3 14.2c1.9 2 5.5 2 7.4 0"/>',
      5: '<path d="M7.8 13.6h8.4c-.4 2.7-2.2 4-4.2 4s-3.8-1.3-4.2-4z" fill="currentColor" fill-opacity=".25"/>'
    }[v];
    var eyes = v === 1
      ? '<path d="M8.4 9.6l1.6.8M15.6 9.6l-1.6.8"/><circle cx="9.3" cy="11" r=".7" fill="currentColor"/><circle cx="14.7" cy="11" r=".7" fill="currentColor"/>'
      : '<circle cx="9.3" cy="10.2" r=".8" fill="currentColor"/><circle cx="14.7" cy="10.2" r=".8" fill="currentColor"/>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/>' + eyes + mouth + '</svg>';
  }

  // ── full-screen shell ──────────────────────────────────────────────────────
  var shell = { el: null, pushed: false, closing: false, onKey: null, token: 0 };

  function openShell(opts) {
    closeShell(true);
    var root = document.createElement('div');
    root.className = 'bbx-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'bbxTitle');
    root.innerHTML =
      '<div class="bbx-sheet" tabindex="-1">' +
        '<div class="bbx-bar">' +
          '<button type="button" class="bbx-back" aria-label="Back" data-bbx-close>' + ICON.back + '</button>' +
          '<div class="bbx-titles"><p class="bbx-eyebrow">' + esc(opts.eyebrow || '') + '</p><h2 class="bbx-title" id="bbxTitle">' + esc(opts.title || '') + '</h2></div>' +
          '<div class="bbx-bar-right" id="bbxBarRight"></div>' +
        '</div>' +
        '<div class="bbx-scroll" id="bbxScroll">' + (opts.body || '') + '</div>' +
      '</div>';
    root.addEventListener('click', function (e) {
      if (e.target === root) { requestClose(); return; }
      if (e.target.closest && e.target.closest('[data-bbx-close]')) requestClose();
    });
    document.body.appendChild(root);
    shell.el = root;
    shell.token += 1;
    try { history.pushState({ bbx: 1 }, ''); shell.pushed = true; } catch (e) { shell.pushed = false; }
    shell.onKey = function (e) { if (e.key === 'Escape' && !document.getElementById('bbPlanSheet')) requestClose(); };
    document.addEventListener('keydown', shell.onKey);
    document.body.classList.add('bbx-open');
    requestAnimationFrame(function () { root.classList.add('is-in'); });
    // Focus the dialog itself (not the back button) so no focus ring flashes on open.
    var sheet = root.querySelector('.bbx-sheet');
    if (sheet) try { sheet.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return shell.token;
  }

  function setTitle(eyebrow, title) {
    if (!shell.el) return;
    var e = shell.el.querySelector('.bbx-eyebrow'); if (e) e.textContent = eyebrow || '';
    var t = shell.el.querySelector('.bbx-title'); if (t) t.textContent = title || '';
  }
  function setBody(html) { var s = document.getElementById('bbxScroll'); if (s) s.innerHTML = html; }
  function setRight(html) { var r = document.getElementById('bbxBarRight'); if (r) r.innerHTML = html || ''; }

  // Closing goes through history so the back stack stays in step.
  function requestClose() {
    if (!shell.el) return;
    if (shell.pushed) { shell.pushed = false; shell.closing = true; try { history.back(); return; } catch (e) { /* fall through */ } }
    closeShell(false);
  }
  function closeShell(silent) {
    var el = shell.el;
    if (!el) return;
    shell.el = null;
    document.body.classList.remove('bbx-open');
    if (shell.onKey) document.removeEventListener('keydown', shell.onKey);
    shell.onKey = null;
    if (silent) { el.remove(); if (shell.pushed) { shell.pushed = false; try { history.back(); } catch (e) { /* ignore */ } } return; }
    el.classList.remove('is-in');
    setTimeout(function () { el.remove(); }, 230);
  }
  window.addEventListener('popstate', function () {
    if (shell.closing) { shell.closing = false; closeShell(false); return; }
    if (shell.el) { shell.pushed = false; closeShell(false); }
  });

  function skeleton(heights) {
    return heights.map(function (h) { return '<div class="bbx-skel" style="height:' + h + 'px"></div>'; }).join('');
  }
  function errorBox(msg, retry) {
    return '<div class="bbx-empty"><b>Something went wrong</b>' + esc(msg || 'Please try again.') +
      (retry ? '<div style="margin-top:16px"><button type="button" class="bbx-btn" onclick="' + retry + '">Try again</button></div>' : '') + '</div>';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DAILY STREAK
  // ══════════════════════════════════════════════════════════════════════════
  var streakState = { month: null };

  function openStreak() {
    streakState.month = null;
    openShell({ eyebrow: 'Daily streak', title: 'Your streak', body: skeleton([220, 330, 150]) });
    loadStreak();
  }

  function loadStreak(month) {
    var tok = shell.token;
    var url = API + '/streak' + (month ? '?month=' + encodeURIComponent(month) : '');
    return api('GET', url).then(function (d) {
      if (tok !== shell.token || !shell.el) return;
      if (!d || d.error) { setBody(errorBox(d && d.error, 'bbxOpenStreak()')); return; }
      streakState.month = d.calendar ? d.calendar.ym : null;
      renderStreak(d);
    });
  }

  function renderStreak(d) {
    var name = d.first_name ? d.first_name : '';
    setTitle('Daily streak', d.streak > 0
      ? (d.today_saved ? 'Keep it going' + (name ? ', ' + name : '') : 'Check in to keep it')
      : 'Start your streak' + (name ? ', ' + name : ''));
    setRight(d.coins != null
      ? '<span class="bbx-pill" title="Your coins"><span class="bbx-coin" aria-hidden="true"></span>' + fmtNum(d.coins) + '<span class="sr-only" style="position:absolute;left:-9999px"> coins</span></span>'
      : '');

    var freezeTxt = d.freezes.left + (d.freezes.left === 1 ? ' streak freeze left' : ' streak freezes left');
    var subPill;
    if (d.streak > 0 && d.is_personal_best) subPill = '<span class="bbx-pill bbx-pill--green">Personal best · ' + freezeTxt + '</span>';
    else if (d.streak > 0) subPill = '<span class="bbx-pill">Best ' + d.best + ' days · ' + freezeTxt + '</span>';
    else subPill = '<span class="bbx-pill">' + (d.best ? 'Best ' + d.best + ' days · ' : '') + freezeTxt + '</span>';

    var hero =
      '<div class="bbx-flame-wrap">' +
        '<div class="bbx-flame' + (d.streak > 0 ? '' : ' is-out') + '" aria-hidden="true">🔥</div>' +
        '<div class="bbx-streak-num"><b>' + d.streak + '</b><span>day streak</span></div>' +
        '<div class="bbx-streak-sub">' + subPill + '</div>' +
      '</div>';

    var cta = !d.today_saved
      ? '<div class="bbx-cta"><button type="button" class="bbx-btn bbx-btn--gold" onclick="bbxGoCheckin()">' +
          (d.streak > 0 ? 'Check in now to keep your ' + d.streak + '-day streak' : 'Do today’s check-in') + '</button></div><div style="height:12px"></div>'
      : '';

    setBody(hero + cta + calendarCard(d) + rewardsCard(d) +
      '<p class="bbx-foot">One check-in a day keeps the fire burning. A streak freeze protects one missed day each month.</p>');
  }

  function calendarCard(d) {
    var c = d.calendar;
    if (!c) return '';
    var wd = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (x) { return '<div class="bbx-cal-wd" aria-hidden="true">' + x + '</div>'; }).join('');
    var cells = '';
    for (var i = 0; i < c.first_weekday; i++) cells += '<div aria-hidden="true"></div>';
    var LABEL = { done: 'checked in', freeze: 'protected by a streak freeze', missed: 'missed', today: 'today, not checked in yet', future: 'upcoming', before: 'before you joined' };
    c.days.forEach(function (x) {
      var isToday = x.date === d.today;
      cells += '<div class="bbx-day bbx-day--' + x.state + (isToday ? ' is-today' : '') + '" role="img" aria-label="' +
        esc(shortDate(x.date) + ': ' + LABEL[x.state]) + '">' + (x.state === 'freeze' ? '❄' : x.day) + '</div>';
    });
    var countTxt = c.elapsed ? (c.done + ' of ' + c.elapsed + ' days') : '';
    return '<div class="bbx-card">' +
      '<div class="bbx-cal-head">' +
        '<button type="button" class="bbx-cal-nav" aria-label="Previous month" ' + (d.can_go_prev ? '' : 'disabled') + ' onclick="bbxStreakMonth(\'' + c.prev + '\')">' + ICON.left + '</button>' +
        '<h3>' + esc(monthName(c.ym)) + '</h3>' +
        '<span class="bbx-cal-count">' + esc(countTxt) + '</span>' +
        '<button type="button" class="bbx-cal-nav" aria-label="Next month" ' + (d.can_go_next ? '' : 'disabled') + ' onclick="bbxStreakMonth(\'' + c.next + '\')">' + ICON.right + '</button>' +
      '</div>' +
      '<div class="bbx-cal">' + wd + cells + '</div>' +
      '<div class="bbx-cal-key" aria-hidden="true">' +
        '<span><i style="background:linear-gradient(145deg,#f3dc9c,#b88f3f)"></i>Checked in</span>' +
        '<span><i style="background:#8fc9f0"></i>Freeze</span>' +
        '<span><i style="border:1.5px dashed #ec7560"></i>Missed</span>' +
      '</div>' +
    '</div>';
  }

  function rewardsCard(d) {
    var items = d.milestones || [];
    var reached = items.filter(function (m) { return m.reached; });
    var latest = reached.length ? reached[reached.length - 1].days : null;
    var idx = reached.length ? reached.length - 1 : -1;
    var fillPct = idx <= 0 ? 0 : (idx / (items.length - 1)) * 100;
    var nodes = items.map(function (m) {
      var isLatest = m.days === latest;
      var cls = 'bbx-ms' + (m.reached ? ' is-reached' : '') + (isLatest ? ' is-latest' : '');
      var dot = m.reached && !isLatest ? ICON.check : String(m.days);
      return '<div class="' + cls + '" role="listitem" aria-label="' + m.days + ' days, ' + esc(m.label) + ', ' + m.coins + ' coins' + (m.reached ? ', unlocked' : '') + '">' +
        '<div class="bbx-ms-dot">' + dot + '</div><b>' + m.days + ' days</b><i>' + esc(m.label) + '</i>' +
        '<span class="bbx-ms-coins">+' + fmtNum(m.coins) + '</span></div>';
    }).join('');
    var next = d.next_milestone
      ? '<div class="bbx-next">' + d.next_milestone.in_days + (d.next_milestone.in_days === 1 ? ' more day' : ' more days') +
        ' to <b>' + esc(d.next_milestone.label) + '</b> and <b>+' + fmtNum(d.next_milestone.coins) + ' coins</b></div>'
      : '<div class="bbx-next"><b>Legend status.</b> Every milestone unlocked on this streak.</div>';
    return '<div class="bbx-card">' +
      '<div class="bbx-rewards-head"><p class="bbx-label">Streak rewards</p>' +
        (d.coins_unlocked_this_run ? '<span class="bbx-rewards-got">+' + fmtNum(d.coins_unlocked_this_run) + ' coins unlocked</span>' : '') + '</div>' +
      '<div class="bbx-track" role="list">' +
        '<div class="bbx-track-line" aria-hidden="true"><div class="bbx-track-fill" style="width:' + fillPct + '%"></div></div>' + nodes +
      '</div>' + next +
    '</div>';
  }

  window.bbxStreakMonth = function (ym) {
    if (!/^\d{4}-\d{2}$/.test(String(ym))) return;
    loadStreak(ym);
  };
  window.bbxGoCheckin = function () {
    requestClose();
    setTimeout(function () {
      if (typeof window.switchUserTab === 'function') window.switchUserTab('checkin');
      setTimeout(function () { if (typeof window.showCheckinSubView === 'function') window.showCheckinSubView('daily'); }, 200);
    }, 260);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // TWO-WEEK PERFORMANCE REPORT
  // ══════════════════════════════════════════════════════════════════════════
  // Members open their own report once their coach has switched it on. Staff
  // pass a userId to preview a member's report (Members tab → Preview report).
  var reportState = { end: null, today: null, data: null, user: null };

  function openReport(end, userId) {
    reportState = { end: end || null, today: null, data: null, user: userId || null };
    openShell({ eyebrow: '2 week performance report', title: 'Your fortnight', body: skeleton([140, 120, 180, 160, 110]) });
    loadReport(end);
  }

  function loadReport(end) {
    var tok = shell.token;
    var q = [];
    if (end) q.push('end=' + encodeURIComponent(end));
    if (reportState.user) q.push('user=' + encodeURIComponent(reportState.user));
    return api('GET', API + '/performance' + (q.length ? '?' + q.join('&') : '')).then(function (d) {
      if (tok !== shell.token || !shell.el) return;
      if (d && d.error === 'report_locked') {
        setBody('<div class="bbx-empty"><b>Coming soon</b>' + esc(d.message || 'Your coach will switch on your 2-week report.') + '</div>');
        return;
      }
      if (!d || d.error) { setBody(errorBox(d && (d.message || d.error), 'bbxOpenReport()')); return; }
      reportState.data = d;
      reportState.end = d.period.end;
      if (!reportState.today) reportState.today = d.period.end;
      renderReport(d);
    });
  }

  function ringSvg(score) {
    var r = 40; var c = 2 * Math.PI * r;
    var off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
    return '<svg viewBox="0 0 92 92" aria-hidden="true"><defs><linearGradient id="bbxRingG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3dc9c"/><stop offset="1" stop-color="#b88f3f"/></linearGradient></defs>' +
      '<circle cx="46" cy="46" r="' + r + '" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7"/>' +
      '<circle cx="46" cy="46" r="' + r + '" fill="none" stroke="url(#bbxRingG)" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"/></svg>';
  }

  function weightChart(points) {
    if (!points || points.length < 2) return '';
    var W = 300; var H = 90; var pad = 6;
    var vals = points.map(function (p) { return p.kg; });
    var lo = Math.min.apply(null, vals); var hi = Math.max.apply(null, vals);
    if (hi - lo < 0.6) { var mid = (hi + lo) / 2; lo = mid - 0.3; hi = mid + 0.3; }
    var xs = function (i) { return pad + (i / (points.length - 1)) * (W - pad * 2); };
    var ys = function (v) { return pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2); };
    var line = points.map(function (p, i) { return (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(p.kg).toFixed(1); }).join(' ');
    var area = line + ' L' + xs(points.length - 1).toFixed(1) + ' ' + H + ' L' + xs(0).toFixed(1) + ' ' + H + ' Z';
    var last = points[points.length - 1];
    return '<svg class="bbx-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Weight across the fortnight">' +
      '<defs><linearGradient id="bbxWG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d6b25e" stop-opacity=".32"/><stop offset="1" stop-color="#d6b25e" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#bbxWG)"/>' +
      '<path d="' + line + '" fill="none" stroke="#e2c275" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + xs(points.length - 1).toFixed(1) + '" cy="' + ys(last.kg).toFixed(1) + '" r="3.2" fill="#f4efe6"/></svg>';
  }

  function deltaChip(delta, unit) {
    if (delta == null || delta === 0) return '';
    var up = delta > 0;
    return '<span class="bbx-dchip ' + (up ? 'is-up' : 'is-down') + '">' + (up ? '▲' : '▼') + ' ' + Math.abs(delta) + (unit || '') + '</span>';
  }

  // A habit row: label, average against goal, and how many days hit it.
  function habitRow(label, h, fmt, unit) {
    if (!h) return '';
    var pct = h.goal ? Math.max(4, Math.min(100, Math.round((h.avg / h.goal) * 100))) : 100;
    var met = h.goal && h.avg >= h.goal;
    return '<div class="bbx-habit">' +
      '<div class="bbx-habit-top"><span>' + esc(label) + '</span><b>' + esc(fmt(h.avg)) + (unit ? '<small> ' + esc(unit) + '</small>' : '') +
        (h.goal ? '<small> / ' + esc(fmt(h.goal)) + '</small>' : '') + '</b></div>' +
      '<div class="bbx-hbar" aria-hidden="true"><i class="' + (met ? 'is-met' : '') + '" style="width:' + pct + '%"></i></div>' +
      '<div class="bbx-habit-sub">' + (h.goal ? 'Goal hit ' + h.days_hit + ' of ' + h.days_logged + ' logged days' : h.days_logged + ' days logged') + '</div>' +
    '</div>';
  }

  function renderReport(d) {
    var preview = !!d.preview;
    setTitle(preview ? 'Preview · ' + (d.first_name || 'member') + '’s 2 week report' : '2 week performance report',
      shortDate(d.period.start) + ' to ' + shortDate(d.period.end));
    setRight(!preview && canShare() && d.has_data ? '<button type="button" class="bbx-icon-btn" aria-label="Share your report" onclick="bbxShareReport()">' + ICON.share + '</button>' : '');

    var atLatest = reportState.today && d.period.end >= reportState.today;
    var nav = '<div class="bbx-period-nav">' +
      '<button type="button" ' + (d.can_go_back === false ? 'disabled' : '') + ' onclick="bbxReportShift(-14)">‹ Previous fortnight</button>' +
      '<button type="button" ' + (atLatest ? 'disabled' : '') + ' onclick="bbxReportShift(14)">Next ›</button></div>';
    var previewNote = preview ? '<div class="bbx-card bbx-preview-note">Admin preview. The member sees this only when “2-week report visible to member” is switched on.</div>' : '';

    if (!d.has_data) {
      setBody(nav + previewNote + '<div class="bbx-empty"><b>Nothing logged this fortnight yet</b>Check in daily, log meals and workouts, and your two-week report builds itself.</div>');
      return;
    }

    // ── score ──
    var s = d.score;
    var delta = s.delta == null ? '' : (s.delta >= 0
      ? '<span class="bbx-pill bbx-pill--green">▲ ' + s.delta + (s.delta === 1 ? ' point' : ' points') + ' vs last report</span>'
      : '<span class="bbx-pill bbx-pill--red">▼ ' + Math.abs(s.delta) + (s.delta === -1 ? ' point' : ' points') + ' vs last report</span>');
    var scoreCard = '<div class="bbx-card bbx-card--gold"><div class="bbx-score">' +
      '<div class="bbx-ring">' + ringSvg(s.total) + '<div class="bbx-ring-num"><b>' + s.total + '</b><span>SCORE</span></div></div>' +
      '<div class="bbx-score-main"><h3>Momentum: ' + esc(s.momentum) + '</h3><p>' + esc(s.line) + '</p>' + delta + '</div>' +
    '</div></div>';

    // ── highlights ──
    var hl = (d.highlights || []).length
      ? '<div class="bbx-card"><p class="bbx-label">Highlights</p><ul class="bbx-hl">' + d.highlights.map(function (h) {
          return '<li><span class="bbx-hl-ico" aria-hidden="true">' + ICON.check + '</span>' + esc(h) + '</li>';
        }).join('') + '</ul></div>'
      : '';

    // ── score breakdown ──
    var pillars = (d.pillars || []).length
      ? '<div class="bbx-card"><p class="bbx-label">Score breakdown</p>' + d.pillars.map(function (p) {
          return '<div class="bbx-pillar"><div class="bbx-pillar-top"><span>' + esc(p.label) + '</span><b>' + p.score + deltaChip(p.delta) + '</b></div>' +
            '<div class="bbx-hbar" aria-hidden="true"><i style="width:' + Math.max(3, p.score) + '%"></i></div></div>';
        }).join('') + '</div>'
      : '';

    // ── weight ──
    var w = d.weight;
    var weightCard = '';
    if (w) {
      var ch = w.change;
      var good = ch != null && ((ch < 0 && w.goal_direction !== 'gain') || (ch > 0 && w.goal_direction === 'gain'));
      var chTxt = ch == null || ch === 0 ? '' : '<span class="bbx-delta-txt"' + (good ? '' : ' style="color:var(--bbx-sub)"') + '>' + Math.abs(ch) + ' kg ' + (ch < 0 ? 'down' : 'up') + '</span>';
      var waist = w.waist ? '<p class="bbx-mini">Waist ' + w.waist.current + ' cm · ' + (w.waist.change < 0 ? Math.abs(w.waist.change) + ' cm down' : w.waist.change + ' cm up') + '</p>' : '';
      weightCard = '<div class="bbx-card"><div class="bbx-row"><p class="bbx-label" style="margin:0">Weight</p>' + chTxt + '</div>' +
        '<div class="bbx-weight-top"><b>' + w.current + '</b><span>kg' + (w.from != null && w.from !== w.current ? ' · from ' + w.from : '') + '</span></div>' +
        (weightChart(w.points) || '<p class="bbx-mini">Weigh in again next Sunday to see your trend line.</p>') + waist + '</div>';
    }

    // ── protein + workouts ──
    var p = d.protein;
    var maxG = Math.max.apply(null, p.days.map(function (x) { return x.grams || 0; }).concat([p.target || 0, 1]));
    var bars = p.days.map(function (x) {
      if (x.grams == null) return '<i class="is-none" style="height:6%"></i>';
      var low = p.target && x.grams < p.target * 0.9;
      return '<i class="' + (low ? 'is-low' : '') + '" style="height:' + Math.max(6, Math.round((x.grams / maxG) * 100)) + '%"></i>';
    }).join('');
    var tgtLine = p.target ? '<span class="bbx-bars-target" style="bottom:' + Math.round((p.target / maxG) * 100) + '%" aria-hidden="true"></span>' : '';
    var proteinCard = '<div class="bbx-card"><p class="bbx-label">Protein avg</p>' +
      '<div class="bbx-stat-big"><b>' + (p.avg != null ? p.avg : '—') + '</b><span>g / day</span></div>' +
      '<div class="bbx-bars" role="img" aria-label="Protein per day for 14 days">' + tgtLine + bars + '</div>' +
      '<p class="bbx-mini">' + (p.target ? 'Target ' + p.target + ' g' + (p.days_hit != null ? ' · hit ' + p.days_hit + ' days' : '') : 'Log protein to see your trend') + '</p></div>';

    var wk = d.workouts;
    var planned = wk.planned || 0;
    var cellsN = Math.min(20, Math.max(planned, wk.done, 5));
    var sq = '';
    for (var i = 0; i < cellsN; i++) sq += '<i class="' + (i < Math.min(wk.done, planned || wk.done) ? 'is-done' : (i < wk.done ? 'is-extra' : '')) + '"></i>';
    var wkNote = !planned ? 'Keep logging sessions' : (wk.done >= planned ? (wk.done > planned ? (wk.done - planned) + ' extra session' + (wk.done - planned === 1 ? '' : 's') : 'Every planned session done') : (planned - wk.done) + ' short of plan');
    var workoutCard = '<div class="bbx-card"><p class="bbx-label">Workouts</p>' +
      '<div class="bbx-stat-big"><b>' + wk.done + '</b><span>' + (planned ? 'of ' + planned + ' planned' : 'sessions') + '</span></div>' +
      '<div class="bbx-squares" role="img" aria-label="' + wk.done + ' workouts' + (planned ? ' of ' + planned + ' planned' : '') + '">' + sq + '</div>' +
      '<p class="bbx-mini">' + esc(wkNote) + '</p></div>';

    var training = '';
    if (wk.minutes || (wk.personal_bests && wk.personal_bests.length)) {
      var hrs = wk.minutes ? (wk.minutes >= 60 ? Math.floor(wk.minutes / 60) + 'h ' + (wk.minutes % 60) + 'm' : wk.minutes + 'm') : '—';
      var pbN = wk.personal_bests ? wk.personal_bests.length : 0;
      training = '<div class="bbx-card"><p class="bbx-label">Training</p><div class="bbx-kv3">' +
        '<div><b>' + hrs + '</b><span>time trained</span></div>' +
        '<div><b>' + wk.days_trained + '</b><span>days trained</span></div>' +
        (pbN ? '<div><b>' + pbN + '</b><span>personal best' + (pbN === 1 ? '' : 's') + '</span></div>' : '') + '</div>' +
        (wk.personal_bests && wk.personal_bests.length ? '<ul class="bbx-pr">' + wk.personal_bests.map(function (b) {
          return '<li><span>' + esc(b.label) + '</span><b>' + esc(b.kg) + ' kg</b>' + (b.previous_kg ? '<small>from ' + esc(b.previous_kg) + ' kg</small>' : '') + '</li>';
        }).join('') + '</ul>' : '') + '</div>';
    }

    // ── nutrition ──
    var n = d.nutrition;
    var nutrition = n
      ? '<div class="bbx-card"><div class="bbx-row"><p class="bbx-label" style="margin:0">Nutrition</p><span class="bbx-mini" style="margin:0">' + n.days_logged + ' of 14 days logged</span></div>' +
          '<div class="bbx-stat-big" style="margin-top:8px"><b>' + fmtNum(n.calories) + '</b><span>kcal / day' + (n.calorie_target ? ' · target ' + fmtNum(n.calorie_target) : '') + '</span></div>' +
          '<div class="bbx-macros">' +
            '<div><i style="background:#e2c275"></i><b>' + n.protein + ' g</b><span>Protein</span></div>' +
            '<div><i style="background:#8fc9f0"></i><b>' + n.carbs + ' g</b><span>Carbs</span></div>' +
            '<div><i style="background:#ec9a7a"></i><b>' + n.fat + ' g</b><span>Fat</span></div>' +
          '</div><p class="bbx-mini">' + fmtNum(n.meals_logged) + ' meals logged</p></div>'
      : '';

    // ── daily habits ──
    var hb = d.habits;
    var habits = hb
      ? '<div class="bbx-card"><p class="bbx-label">Daily habits</p>' +
          habitRow('Steps', hb.steps, function (v) { return fmtNum(Math.round(v)); }, '') +
          habitRow('Water', hb.water, function (v) { return String(v); }, 'L') +
          habitRow('Sleep', hb.sleep, function (v) { return String(v); }, 'h') +
        '</div>'
      : '';

    // ── check-ins ──
    var ci = d.checkins;
    var strip = ci.strip.map(function (on) { return '<i class="' + (on ? 'is-on' : '') + '"></i>'; }).join('');
    var sleepTxt = d.avg_sleep ? d.avg_sleep.hours + 'h ' + (d.avg_sleep.minutes < 10 ? '0' : '') + d.avg_sleep.minutes + 'm' : '—';
    var checkCard = '<div class="bbx-card"><div class="bbx-row"><p class="bbx-label" style="margin:0">Check-in streak</p>' +
      '<span class="bbx-delta-txt">' + ci.days + ' / ' + ci.of + ' days</span></div>' +
      '<div class="bbx-strip" role="img" aria-label="' + ci.days + ' of 14 days checked in">' + strip + '</div>' +
      '<div class="bbx-facts"><span>Meals logged <b>' + fmtNum(d.meals_logged) + '</b></span><span>Avg sleep <b>' + sleepTxt + '</b></span></div></div>';

    // ── mind + recovery ──
    var m = d.mind;
    var mindCard = m && (m.mood_label || m.stress_label || m.exercise_days)
      ? '<div class="bbx-card"><p class="bbx-label">Mind</p><div class="bbx-kv3">' +
          '<div><b>' + esc(m.mood_label || '—') + '</b><span>' + (m.mood_days ? 'avg mood · ' + m.mood_days + ' days' : 'mood') + '</span></div>' +
          '<div><b>' + esc(m.stress_label || '—') + '</b><span>' + (m.stress_days ? 'avg stress · ' + m.stress_days + ' days' : 'stress') + '</span></div>' +
          (m.exercise_days ? '<div><b>' + m.exercise_days + '</b><span>mindful days</span></div>' : '') + '</div></div>'
      : '';
    var recovery = d.recovery
      ? '<div class="bbx-card"><div class="bbx-row"><p class="bbx-label" style="margin:0">Recovery</p><span class="bbx-mini" style="margin:0">' + d.recovery.days + ' days measured</span></div>' +
          '<div class="bbx-stat-big" style="margin-top:8px"><b>' + d.recovery.avg + '</b><span>average readiness</span></div></div>'
      : '';

    // ── the member's own words ──
    var wins = (d.wins && d.wins.length) || d.focus
      ? '<div class="bbx-card"><p class="bbx-label">From your Sunday reviews</p>' +
          (d.wins || []).map(function (x) { return '<p class="bbx-quote">“' + esc(x) + '”</p>'; }).join('') +
          (d.focus ? '<p class="bbx-focus"><b>Next focus:</b> ' + esc(d.focus) + '</p>' : '') + '</div>'
      : '';

    var note = d.coach_note
      ? '<div class="bbx-card"><div class="bbx-note"><div class="bbx-note-av" aria-hidden="true">C</div><p><b>Coach note:</b> ' + esc(d.coach_note) + '</p></div></div>'
      : '';

    setBody(nav + previewNote + scoreCard + hl + pillars + weightCard +
      '<div class="bbx-grid2">' + proteinCard + workoutCard + '</div>' +
      training + nutrition + habits + checkCard + mindCard + recovery + wins + note +
      '<p class="bbx-foot">Your BodyBank Score weighs workouts, nutrition, check-ins and consistency across these 14 days.</p>');
  }

  function canShare() {
    try {
      var C = window.Capacitor;
      if (C && C.Plugins && C.Plugins.Share && C.isNativePlatform && C.isNativePlatform()) return true;
    } catch (e) { /* ignore */ }
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  }
  window.bbxShareReport = function () {
    var d = reportState.data;
    if (!d || d.preview) return;
    var lines = ['My BodyBank fortnight (' + shortDate(d.period.start) + ' to ' + shortDate(d.period.end) + ')',
      'Score ' + d.score.total + (d.score.delta != null && d.score.delta > 0 ? ' (+' + d.score.delta + ')' : '') + ' · Momentum: ' + d.score.momentum];
    (d.highlights || []).forEach(function (h) { lines.push('• ' + h); });
    var text = lines.join('\n');
    try {
      var C = window.Capacitor;
      if (C && C.Plugins && C.Plugins.Share && C.isNativePlatform && C.isNativePlatform()) { C.Plugins.Share.share({ title: 'My BodyBank fortnight', text: text }).catch(function () {}); return; }
    } catch (e) { /* fall through */ }
    if (navigator.share) navigator.share({ title: 'My BodyBank fortnight', text: text }).catch(function () {});
  };
  window.bbxReportShift = function (days) {
    var cur = reportState.end;
    if (!cur) return;
    var d = new Date(cur + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    var next = d.toISOString().slice(0, 10);
    if (reportState.today && next > reportState.today) next = reportState.today;
    setBody(skeleton([40, 140, 120, 180, 160]));
    loadReport(next);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // BLOOD GRADES
  // ══════════════════════════════════════════════════════════════════════════
  var bloodState = { data: null };

  function openBlood(reportId) {
    if (!reportId) return;
    bloodState.data = null;
    openShell({ eyebrow: 'My health reports', title: 'Blood report', body: skeleton([110, 44, 420, 120]) });
    var tok = shell.token;
    api('GET', API + '/blood/' + encodeURIComponent(reportId)).then(function (d) {
      if (tok !== shell.token || !shell.el) return;
      if (!d || d.error) {
        var msg = d && (d.message || d.error);
        setBody('<div class="bbx-empty"><b>' + (d && d.error === 'in_review' ? 'With your coach' : 'Not ready yet') + '</b>' + esc(msg || 'Please try again shortly.') + '</div>');
        return;
      }
      bloodState.data = d;
      renderBlood(d);
    });
  }

  function renderBlood(d) {
    setTitle('My health reports', d.title || 'Blood report');
    setRight(d.report_date ? '<span class="bbx-pill">' + esc(shortDate(d.report_date)) + '</span>' : '');
    if (!d.total) {
      setBody('<div class="bbx-empty"><b>No gradable markers</b>We could not match the markers on this report to reference ranges. Your coach can still review it with you.</div>' + careButtons(d));
      return;
    }
    var share = d.optimal_or_good / d.total;
    var tone = share >= 0.8 ? '' : (share >= 0.6 ? ' is-amber' : ' is-red');
    var headline = share >= 0.85 ? 'Looking strong' : (share >= 0.6 ? 'Mostly on track' : 'A few things to work on');
    var worst = d.counts.D ? d.counts.D + ' need' + (d.counts.D === 1 ? 's' : '') + ' attention' : (d.counts.C ? d.counts.C + ' borderline' : 'nothing flagged');
    var summary = '<div class="bbx-card bbx-card--gold"><div class="bbx-bsum">' +
      '<div class="bbx-bbadge' + tone + '"><b>' + d.optimal_or_good + '/' + d.total + '</b><span>MARKERS</span></div>' +
      '<div class="bbx-bsum-main"><p class="bbx-label" style="margin-bottom:4px">Overall health</p><h3>' + esc(headline) + '</h3>' +
        '<p>' + d.optimal_or_good + ' of ' + d.total + ' markers Optimal or Good · ' + esc(worst) + '</p></div>' +
    '</div></div>';

    var legend = '<div class="bbx-legend" aria-hidden="true">' + ['A', 'B', 'C', 'D'].map(function (g) {
      return '<span><i class="bbx-g bbx-g--' + g + '">' + g + '</i>' + esc(d.legend[g]) + '</span>';
    }).join('') + '</div>';

    var rows = d.markers.map(function (m) {
      var bar = m.bar
        ? '<div class="bbx-mbar" aria-hidden="true"><span class="bbx-mbar-band" style="left:' + (m.bar.band_start * 100).toFixed(1) + '%;right:' + ((1 - m.bar.band_end) * 100).toFixed(1) + '%"></span>' +
          '<span class="bbx-mbar-dot bbx-tone--' + m.grade + '" style="left:' + (m.bar.value * 100).toFixed(1) + '%"></span></div>'
        : '<div class="bbx-mbar" aria-hidden="true"></div>';
      return '<div class="bbx-marker" role="listitem" aria-label="' + esc(m.name + ': ' + m.value + ' ' + m.unit + ', ' + m.grade_label + (m.range ? ', range ' + m.range : '')) + '">' +
        '<i class="bbx-g bbx-g--' + m.grade + '" aria-hidden="true">' + m.grade + '</i>' +
        '<div class="bbx-marker-main"><div class="bbx-marker-top"><span class="bbx-marker-name">' + esc(m.name) + '</span>' +
          '<span class="bbx-marker-val">' + esc(m.value) + '<small>' + esc(m.unit) + '</small></span></div>' +
          '<div class="bbx-marker-bottom">' + bar + '<span class="bbx-marker-lbl bbx-tone--' + m.grade + '">' + esc(m.grade_label) + '</span></div></div></div>';
    }).join('');
    var list = '<div class="bbx-card bbx-markers" role="list">' + rows + '</div>';

    var areas = d.areas && d.areas.length
      ? '<div class="bbx-card"><p class="bbx-label">Health areas</p><div class="bbx-areas">' + d.areas.map(function (a) {
          return '<div class="bbx-area"><i class="bbx-g bbx-g--' + esc(a.grade) + '">' + esc(a.grade) + '</i><span>' + esc(a.label) + '<small>' + esc(a.grade_label) + '</small></span></div>';
        }).join('') + '</div></div>'
      : '';

    setBody(summary + legend + list + areas + careButtons(d) +
      '<p class="bbx-foot">Each marker is compared with the reference range printed by your lab. Grades are a guide, not a diagnosis. Talk them through with your doctor.</p>');
  }

  function careButtons(d) {
    var focus = (d.markers || []).filter(function (m) { return m.grade === 'D' || m.grade === 'C'; }).slice(0, 2).map(function (m) { return m.name; });
    var nutSub = focus.length ? 'Work on ' + focus.join(' and ') + ' with food' : 'Build your plan around these results';
    return '<button type="button" class="bbx-cta-row bbx-cta-row--gold" onclick="bbxTalkCare(\'doctor\')">' +
        '<span class="bbx-cta-ico" aria-hidden="true">' + ICON.steth + '</span><span><b>Talk to a Doctor</b><small>Review your report together</small></span>' + ICON.chev + '</button>' +
      '<button type="button" class="bbx-cta-row" onclick="bbxTalkCare(\'nutrition\')">' +
        '<span class="bbx-cta-ico" aria-hidden="true">' + ICON.apple + '</span><span><b>Talk to a Sports Nutritionist</b><small>' + esc(nutSub) + '</small></span>' + ICON.chev + '</button>';
  }

  // Doctor / nutritionist live in the member's care group; without one, the coach chat.
  window.bbxTalkCare = function () {
    if (typeof window.bbPlanGuard === 'function' && !window.bbPlanGuard('coach_chat')) return;
    var d = bloodState.data || {};
    var gid = d.care && d.care.group_id;
    requestClose();
    setTimeout(function () {
      if (gid && window.BBGroupChat && typeof window.BBGroupChat.open === 'function') {
        if (typeof window.switchUserTab === 'function') window.switchUserTab('messages');
        setTimeout(function () { window.BBGroupChat.open({ mode: 'member', groupId: gid }); }, 60);
      } else if (typeof window.switchUserTab === 'function') {
        window.switchUserTab('messages');
      }
    }, 260);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MIND CHECK-IN (inside Check-in → Mind; not an overlay)
  // ══════════════════════════════════════════════════════════════════════════
  var mind = { data: null, saving: false };

  function renderMind() {
    var host = document.getElementById('bbxMindHost');
    if (!host || !isMember()) return;
    if (!mind.data) host.innerHTML = '<div class="bbm">' + skeleton([28, 120, 170, 240]) + '</div>';
    api('GET', API + '/mind').then(function (d) {
      if (!d || d.error) {
        if (!mind.data) host.innerHTML = '<div class="bbm">' + errorBox(d && d.error, 'bbxRenderMind()') + '</div>';
        return;
      }
      mind.data = d;
      drawMind(host, d);
    });
  }

  function drawMind(host, d) {
    var name = d.first_name ? ', ' + d.first_name : '';
    var faces = d.moods.map(function (m) {
      var on = d.mood === m.value;
      return '<button type="button" class="bbm-face' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" onclick="bbxSetMood(' + m.value + ')">' +
        faceSvg(m.value) + '<span>' + esc(m.label) + '</span></button>';
    }).join('');

    var sl = d.sleep;
    var maxH = Math.max.apply(null, sl.days.map(function (x) { return x.hours || 0; }).concat([9]));
    var lastIdx = -1;
    sl.days.forEach(function (x, i) { if (x.hours != null) lastIdx = i; });
    var bars = sl.days.map(function (x, i) {
      if (x.hours == null) return '<i class="is-none" title="' + esc(shortDate(x.date)) + ': not logged"></i>';
      return '<i class="' + (i === lastIdx ? 'is-last' : '') + '" style="height:' + Math.max(8, Math.round((x.hours / maxH) * 100)) + '%" title="' + esc(shortDate(x.date) + ': ' + hm(x.hours)) + '"></i>';
    }).join('');
    var wds = sl.days.map(function (x) { return '<span>' + esc(x.weekday) + '</span>'; }).join('');
    var sleepSub = sl.quality_pct != null
      ? '<p class="bbm-small">Quality ' + sl.quality_pct + '%</p>'
      : (sl.avg != null ? '<p class="bbm-small is-muted">Week avg ' + hm(sl.avg) + '</p>' : '<p class="bbm-small is-muted">Log sleep in your daily check-in</p>');

    var st = d.stress;
    var knobPct = st ? ((st - 1) / 4) * 100 : 50;
    var stressCard = '<div class="bbm-card"><p class="bbm-lbl">Stress</p>' +
      '<p class="bbm-big' + (d.stress_label ? '' : '" style="color:var(--bbx-muted)') + '">' + esc(d.stress_label || 'Not set') + '</p>' +
      '<button type="button" class="bbm-stress' + (st ? '' : ' is-unset') + '" id="bbmStress" aria-label="Set your stress level. Currently ' + esc(d.stress_label || 'not set') + '. Tap along the bar, or use arrow keys." onclick="bbxStressTap(event)" onkeydown="bbxStressKey(event)">' +
        '<span class="bbm-stress-track" aria-hidden="true"></span><span class="bbm-stress-knob" style="left:' + knobPct + '%" aria-hidden="true"></span></button>' +
      (st ? '' : '<p class="bbm-stress-hint">Tap the bar to set it</p>') + '</div>';

    var tips = d.exercises.map(function (x) {
      var right = '<span class="bbm-tip-state"><span class="bbm-tip-done">✓ Done today</span><span class="bbm-tip-go">' + (x.locked ? 'Guided →' : 'Start →') + '</span></span>';
      var inner = '<span class="bbm-tip-ico" aria-hidden="true">' + (ICON[x.icon] || ICON.breath) + '</span>' +
        '<span class="bbm-tip-main"><b>' + esc(x.title) + '</b><small>' + esc(x.sub) + '</small></span>' + right;
      var cls = 'bbm-tip' + (x.done_today ? ' done' : '') + (x.locked ? ' is-locked' : '');
      if (x.key === 'yoga_flow') {
        // A plain link: bb-plans.js intercepts it for Core members (AI Trainer is Guided).
        return '<a class="' + cls + '" href="/ai-trainer.html?v=2&pose=surya">' + inner + '</a>';
      }
      return '<button type="button" class="' + cls + '" id="mindCard-' + esc(x.key) + '" onclick="mindStartExercise(\'' + esc(x.key) + '\')">' + inner + '</button>';
    }).join('');

    host.innerHTML =
      '<div class="bbm">' +
        '<div class="bbm-head"><div><p class="bbm-co">Co powered by<br>Beyond The Body</p><h3 class="bbm-title">Mind check in</h3></div>' +
          '<a class="bbm-logo" href="https://beyondthebody.fit" target="_blank" rel="noopener" aria-label="Beyond The Body"><img src="/img/btb-logo.png" alt="Beyond The Body" loading="lazy" decoding="async"></a></div>' +
        '<div class="bbm-card"><p class="bbm-q">How are you feeling today' + esc(name) + '?</p><div class="bbm-faces" role="group" aria-label="Your mood today">' + faces + '</div></div>' +
        '<div class="bbm-grid">' +
          '<div class="bbm-card"><p class="bbm-lbl">Sleep</p><p class="bbm-big">' + (sl.latest ? hm(sl.latest.hours) : '—') + '</p>' + sleepSub +
            '<div class="bbm-sleep-bars" role="img" aria-label="Sleep over the last 7 days">' + bars + '</div><div class="bbm-sleep-wd" aria-hidden="true">' + wds + '</div></div>' +
          '<div class="bbm-col">' + stressCard +
            '<div class="bbm-card"><p class="bbm-lbl">Mind streak</p><p class="bbm-big">' + d.mind_streak + (d.mind_streak === 1 ? ' day' : ' days') + '</p></div>' +
          '</div>' +
        '</div>' +
        '<p class="bbm-sec">Evidence based brain tips</p>' +
        '<div class="bbm-tips">' + tips + '</div>' +
        '<p class="bbm-err" id="bbmErr" hidden></p>' +
      '</div>';
  }

  function saveMood(patch) {
    if (!mind.data) return;
    var prev = { mood: mind.data.mood, stress: mind.data.stress, mood_label: mind.data.mood_label, stress_label: mind.data.stress_label };
    if (patch.mood) { mind.data.mood = patch.mood; mind.data.mood_label = labelFor(mind.data.moods, patch.mood); }
    if (patch.stress) { mind.data.stress = patch.stress; mind.data.stress_label = labelFor(mind.data.stress_levels, patch.stress); }
    var host = document.getElementById('bbxMindHost');
    if (host) drawMind(host, mind.data);
    api('POST', API + '/mind/mood', patch).then(function (r) {
      if (!r || r.error) {
        Object.assign(mind.data, prev);
        if (host) drawMind(host, mind.data);
        var e = document.getElementById('bbmErr');
        if (e) { e.textContent = (r && r.error) || 'Could not save that. Please try again.'; e.hidden = false; }
        return;
      }
      // First answer of the day can start the mind streak — refresh quietly.
      if (!prev.mood && !prev.stress) renderMind();
    });
  }
  function labelFor(list, v) { var x = (list || []).filter(function (i) { return i.value === v; })[0]; return x ? x.label : null; }

  window.bbxSetMood = function (v) { saveMood({ mood: v }); };
  window.bbxStressTap = function (e) {
    var el = e.currentTarget;
    var r = el.getBoundingClientRect();
    var x = (e.clientX != null && e.clientX > 0) ? e.clientX : r.left + r.width / 2;
    var frac = Math.max(0, Math.min(1, (x - r.left) / r.width));
    saveMood({ stress: Math.max(1, Math.min(5, Math.round(frac * 4) + 1)) });
  };
  window.bbxStressKey = function (e) {
    if (!mind.data) return;
    var cur = mind.data.stress || 3;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); saveMood({ stress: Math.min(5, cur + (mind.data.stress ? 1 : 0)) }); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); saveMood({ stress: Math.max(1, cur - (mind.data.stress ? 1 : 0)) }); }
  };

  // The existing exercise player marks a card done by id (mindCard-<key>); our
  // rows carry the same ids, so completion lights up here too. Refresh the mind
  // streak once the server confirms.
  var baseComplete = window.mindCompleteExercise;
  if (typeof baseComplete === 'function' && !baseComplete.__bbx) {
    window.mindCompleteExercise = function (key) {
      var p = baseComplete.apply(this, arguments);
      Promise.resolve(p).then(function () { if (document.getElementById('bbxMindHost')) renderMind(); });
      return p;
    };
    window.mindCompleteExercise.__bbx = true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MY MEMBERSHIP
  // ══════════════════════════════════════════════════════════════════════════
  // Store rules: inside the iOS / Android apps there is no price, no renew button
  // and no link to an outside payment page — only a neutral line. The website
  // version adds "Talk to your coach" and "See plans".
  var memState = { data: null };
  var COACH_WA = '919502575669';

  function isNativeApp() {
    if (typeof window.bbPlanIsNativeApp === 'function') return window.bbPlanIsNativeApp();
    return window.IS_BODYBANK_APP === true;
  }

  function openMembership() {
    memState.data = null;
    openShell({ eyebrow: 'My membership', title: 'Your plan', body: skeleton([190, 260, 150, 120]) });
    var tok = shell.token;
    api('GET', API + '/membership').then(function (d) {
      if (tok !== shell.token || !shell.el) return;
      if (!d || d.error) { setBody(errorBox(d && d.error, 'bbxOpenMembership()')); return; }
      memState.data = d;
      renderMembership(d);
    });
  }

  function longDate(ymd) {
    var d = new Date(String(ymd) + 'T00:00:00Z');
    try { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return ymd; }
  }

  function renderMembership(d) {
    var p = d.plan;
    setTitle('My membership', p.name + ' plan');
    setRight('');

    // ── status ──
    var st = p.state; var dl = p.days_left;
    var status;
    if (st === 'trialing') status = { cls: 'is-trial', txt: 'Free trial' + (dl != null ? ' · ' + (dl <= 0 ? 'ends today' : dl + (dl === 1 ? ' day left' : ' days left')) : '') };
    else if (st === 'expired' || st === 'canceled') status = { cls: 'is-ended', txt: st === 'canceled' ? 'Paused' : 'Ended' };
    else if (dl != null && dl <= 7) status = { cls: 'is-ending', txt: 'Active · ' + (dl <= 0 ? 'ends today' : 'ends in ' + dl + (dl === 1 ? ' day' : ' days')) };
    else status = { cls: 'is-active', txt: 'Active' };

    var t = d.term;
    var termBar = t
      ? '<div class="bbx-term"><div class="bbx-row"><span>Day ' + t.day + ' of ' + t.total_days + '</span><span>' + Math.round((t.day / t.total_days) * 100) + '%</span></div>' +
          '<div class="bbx-hbar" aria-hidden="true"><i style="width:' + Math.max(3, Math.round((t.day / t.total_days) * 100)) + '%"></i></div></div>'
      : '';
    var dates =
      '<div class="bbx-mdates">' +
        (t ? '<div><span>Started</span><b>' + esc(longDate(t.start)) + '</b></div>' : '') +
        '<div><span>' + (p.expires_at ? (st === 'trialing' ? 'Trial ends' : (st === 'expired' ? 'Ended' : 'Renews / ends')) : 'Term') + '</span><b>' + (p.expires_at ? esc(longDate(p.expires_at.slice(0, 10))) : 'No end date') + '</b></div>' +
        (d.member_since ? '<div><span>Member since</span><b>' + esc(longDate(d.member_since)) + '</b></div>' : '') +
      '</div>';
    var planCard = '<div class="bbx-card bbx-card--gold bbx-mplan bbx-mplan--' + esc(p.tier) + '">' +
      '<div class="bbx-row" style="align-items:flex-start"><div><p class="bbx-label" style="margin-bottom:4px">Your plan</p><h3 class="bbx-mplan-name">' + esc(p.name) + '</h3>' +
        (p.label && p.label !== p.name && p.label !== 'Trial' ? '<p class="bbx-mini" style="margin:2px 0 0">' + esc(p.label) + '</p>' : '') + '</div>' +
        '<span class="bbx-mstatus ' + status.cls + '">' + esc(status.txt) + '</span></div>' +
      termBar + dates + '</div>';

    // ── what's included / more with higher plans ──
    var incl = d.groups.filter(function (g) { return g.included; });
    var more = d.groups.filter(function (g) { return !g.included; });
    var includedCard = '<div class="bbx-card"><p class="bbx-label">What’s included</p><ul class="bbx-flist">' +
      incl.map(function (g) {
        return g.features.map(function (f) { return '<li><span class="bbx-fi is-on" aria-hidden="true">' + ICON.check + '</span>' + esc(f.label) + '</li>'; }).join('');
      }).join('') + '</ul></div>';
    var moreCard = more.length
      ? '<div class="bbx-card"><p class="bbx-label">More with a higher plan</p>' + more.map(function (g) {
          return '<p class="bbx-fgroup">' + esc(g.name) + '</p><ul class="bbx-flist is-off">' +
            g.features.map(function (f) { return '<li><span class="bbx-fi" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>' + esc(f.label) + '</li>'; }).join('') + '</ul>';
        }).join('') + '</div>'
      : '';

    // ── allowances ──
    var allow = (d.allowances || []).length
      ? '<div class="bbx-card"><p class="bbx-label">Your allowances</p>' + d.allowances.map(function (a) {
          if (a.unlimited) return '<div class="bbx-allow bbx-allow--unl"><span>' + esc(a.label) + '</span><b class="is-unl">Unlimited</b></div>';
          var pct = a.limit ? Math.min(100, Math.round((a.used / a.limit) * 100)) : 100;
          var left = Math.max(0, (a.limit || 0) - a.used);
          return '<div class="bbx-allow"><div class="bbx-row"><span>' + esc(a.label) + '</span><b>' + a.used + ' of ' + a.limit + ' used</b></div>' +
            '<div class="bbx-hbar" aria-hidden="true"><i class="' + (left === 0 ? 'is-full' : '') + '" style="width:' + Math.max(3, pct) + '%"></i></div>' +
            '<p class="bbx-mini">' + (left === 0 ? 'All used. Your coach can add more.' : left + ' left') + '</p></div>';
        }).join('') + '</div>'
      : '';

    // ── care team ──
    var people = (d.care && d.care.people) || [];
    var care = '<div class="bbx-card"><p class="bbx-label">Your care team</p>' +
      (people.length
        ? '<ul class="bbx-team">' + people.map(function (x) {
            var ini = x.name.split(' ').map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
            return '<li><span class="bbx-team-av" aria-hidden="true">' + esc(ini) + '</span><span><b>' + esc(x.name) + '</b><small>' + esc(x.role) + '</small></span></li>';
          }).join('') + '</ul>'
        : '<p class="bbx-mini" style="margin:0">Your BodyBank coaching team looks after your plan.</p>') +
      (d.can_message ? '<button type="button" class="bbx-btn" style="margin-top:14px" onclick="bbxMessageTeam()">Message your team</button>' : '') +
    '</div>';

    // ── renewal (store-safe inside the apps) ──
    var renew;
    if (isNativeApp()) {
      renew = '<div class="bbx-card bbx-renew"><p class="bbx-label">Renewal</p><p class="bbx-renew-txt">' +
        (st === 'trialing' ? 'Your coach will be in touch before your trial ends.' : 'Your coach will contact you before your plan renews.') + '</p></div>';
    } else {
      var waText = 'Hi BodyBank team, I would like to ' + (st === 'trialing' ? 'continue after my trial' : 'renew or change my ' + p.name + ' plan') + '.';
      renew = '<div class="bbx-card bbx-renew"><p class="bbx-label">Renewal</p><p class="bbx-renew-txt">' +
        (st === 'trialing' ? 'Your coach will be in touch before your trial ends. You can also reach out any time.' : 'Your coach will contact you before your plan renews. Want to change plan? Reach out any time.') + '</p>' +
        '<div class="bbx-renew-actions">' +
          '<a class="bbx-btn bbx-btn--gold" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + COACH_WA + '?text=' + encodeURIComponent(waText) + '">Talk to your coach</a>' +
          '<a class="bbx-btn" href="/pricing.html" target="_blank" rel="noopener">See plans</a>' +
        '</div></div>';
    }

    setBody(planCard + includedCard + allow + care + moreCard + renew +
      '<p class="bbx-foot">Reminders go out two days before your plan ends and on the last day.</p>');
  }

  window.bbxMessageTeam = function () {
    if (typeof window.bbPlanGuard === 'function' && !window.bbPlanGuard('coach_chat')) return;
    var d = memState.data || {};
    var gid = d.care && d.care.group_id;
    requestClose();
    setTimeout(function () {
      if (typeof window.switchUserTab === 'function') window.switchUserTab('messages');
      if (gid && window.BBGroupChat && typeof window.BBGroupChat.open === 'function') {
        setTimeout(function () { window.BBGroupChat.open({ mode: 'member', groupId: gid }); }, 60);
      }
    }, 260);
  };

  // ── Home: the streak in the hero opens the Daily Streak screen ────────────
  function bindHomeStreak() {
    var el = document.querySelector('#memberHome .mh-streak');
    if (!el || el.__bbx) return;
    el.__bbx = true;
    el.classList.add('bbx-tappable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Open your daily streak');
    el.addEventListener('click', openStreak);
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStreak(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindHomeStreak);
  else bindHomeStreak();

  // Logging out must never leave a member's screen open for the next account.
  var baseLogout = window.logoutUser;
  if (typeof baseLogout === 'function' && !baseLogout.__bbx) {
    window.logoutUser = function () {
      closeShell(true);
      mind.data = null;
      return baseLogout.apply(this, arguments);
    };
    window.logoutUser.__bbx = true;
  }

  window.bbxOpenStreak = openStreak;
  window.bbxOpenReport = openReport;
  window.bbxOpenBlood = openBlood;
  window.bbxOpenMembership = openMembership;
  window.bbxRenderMind = renderMind;
  window.bbxClose = requestClose;
})();
