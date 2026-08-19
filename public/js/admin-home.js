/* ============================================================================
   BodyBank — Admin landing ("Dashboard")
   ----------------------------------------------------------------------------
   One screen that answers, in order: is the business moving, what is waiting on
   me, and what do the numbers look like. Every figure comes from a single read
   (/api/admin/overview) so nothing on the page can disagree with anything else
   on it, and every tile is a way INTO the section that owns that number rather
   than a figure to read and then go hunting for.

   The same component serves desktop and phone — the admin shell supplies the
   sidebar and the bottom bar around it.

   Depends on globals from index.html: apiCall, escapeHtml, switchTab,
   switchToSection, openAdminEscalations.
   ========================================================================== */

var ahState = window.ahState || (window.ahState = { data: null, loading: false });

function ahEl(id) { return document.getElementById(id); }
function ahEsc(v) { return escapeHtml(v == null ? '' : String(v)); }
function ahNum(n) { return Number(n || 0).toLocaleString(); }
function ahPlural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function ahGreeting() {
  var h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function ahTimeAgo(ts) {
  if (!ts) return '';
  var d = new Date(ts); if (isNaN(d.getTime())) return '';
  var sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return 'just now';
  var m = Math.floor(sec / 60); if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  var dd = Math.floor(h / 24); if (dd < 7) return dd + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function ahDayLabel(ts) {
  var d = new Date(ts); if (isNaN(d.getTime())) return '';
  var t0 = new Date(); t0.setHours(0, 0, 0, 0);
  var t = new Date(d); t.setHours(0, 0, 0, 0);
  var diff = Math.round((t0 - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
// Navigation targets differ: some are tabs, some are sections, one is a modal.
function ahGo(kind, name) {
  try {
    if (kind === 'section' && typeof switchToSection === 'function') switchToSection(name);
    else if (kind === 'modal' && name === 'escalations' && typeof openAdminEscalations === 'function') openAdminEscalations();
    else if (typeof switchTab === 'function') switchTab(name);
  } catch (e) { }
  return false;
}

async function loadAdminHome(silent) {
  if (!ahEl('adminHome')) return;
  if (ahState.loading) return;
  ahState.loading = true;
  var btn = ahEl('ahRefresh');
  if (btn) btn.classList.add('is-busy');
  try {
    var d = await apiCall('GET', '/api/admin/overview');
    if (!d || d.error) {
      if (!silent) {
        var host = ahEl('ahQueue');
        if (host) host.innerHTML = '<div class="ah-empty">' + ahEsc((d && d.error) || 'Could not load the dashboard.') + '</div>';
      }
      return;
    }
    ahState.data = d;
    renderAdminHome();
  } catch (e) {
    var host2 = ahEl('ahQueue');
    if (host2) host2.innerHTML = '<div class="ah-empty">Could not reach the server.</div>';
  } finally {
    ahState.loading = false;
    setTimeout(function () { if (btn) btn.classList.remove('is-busy'); }, 600);
  }
}

/* ---------------------------------------------------------------- render */
function renderAdminHome() {
  var d = ahState.data;
  if (!d || !ahEl('adminHome')) return;
  var r = d.roster || {}, p = d.pipeline || {}, ib = d.inbox || {}, t = d.trends || {};

  // ---- hero: is the roster showing up, and is that better than last week? --
  var dateEl = ahEl('ahDate');
  if (dateEl) {
    try { dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { }
  }
  var greetEl = ahEl('ahGreet');
  if (greetEl) {
    var who = '';
    try { who = String((window.currentUser || {}).first_name || '').trim(); } catch (e) { }
    greetEl.textContent = ahGreeting() + (who ? ', ' + who : '');
  }

  var members = r.members || 0, active = r.active_7d || 0;
  var pct = members ? Math.round((active / members) * 100) : 0;
  ahEl('ahActiveN') && (ahEl('ahActiveN').textContent = members ? active : '–');
  ahEl('ahActiveOf') && (ahEl('ahActiveOf').textContent = members
    ? ' of ' + members + ' active in the last 7 days'
    : ' no members yet');
  var fill = ahEl('ahActiveFill');
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = 'ah-bar-fill ' + (pct >= 60 ? 'ok' : (pct >= 25 ? 'warn' : 'bad'));
  }

  var series = (t.active || []).slice(-14);
  var dEl = ahEl('ahDelta');
  if (dEl) {
    if (series.length >= 14) {
      var avg = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
      var thisWk = avg(series.slice(7)), lastWk = avg(series.slice(0, 7));
      var diff = Math.round((thisWk - lastWk) * 10) / 10;
      if (!thisWk && !lastWk) { dEl.textContent = 'no activity either week'; dEl.className = 'ah-delta flat'; }
      else if (diff > 0) { dEl.textContent = '▲ ' + diff + '/day vs last week'; dEl.className = 'ah-delta up'; }
      else if (diff < 0) { dEl.textContent = '▼ ' + Math.abs(diff) + '/day vs last week'; dEl.className = 'ah-delta down'; }
      else { dEl.textContent = 'level with last week'; dEl.className = 'ah-delta flat'; }
    } else { dEl.textContent = ''; dEl.className = 'ah-delta'; }
  }

  var spark = ahEl('ahSpark');
  if (spark) {
    if (!series.length) {
      spark.innerHTML = '<div class="ah-spark-empty">Daily activity appears here once members start logging.</div>';
      ahEl('ahSparkPeak') && (ahEl('ahSparkPeak').textContent = '');
    } else {
      var peak = Math.max.apply(null, series.concat([1]));
      var labels = t.labels || [];
      spark.innerHTML = series.map(function (v, i) {
        var h = Math.max(3, Math.round((v / peak) * 100));
        var when = labels[labels.length - series.length + i] || '';
        var day = when ? new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
        return '<span class="ah-spark-b' + (i === series.length - 1 ? ' now' : '') + (v ? '' : ' nil') + '"'
          + ' style="height:' + h + '%" title="' + ahEsc(day) + ': ' + ahPlural(v, 'active member') + '"></span>';
      }).join('');
      ahEl('ahSparkPeak') && (ahEl('ahSparkPeak').textContent = 'peak ' + peak);
    }
  }

  var hs = ahEl('ahHeroStats');
  if (hs) {
    var mini = function (n, label, tab) {
      return '<button type="button" class="ah-hstat' + (n ? '' : ' nil') + '" onclick="ahGo(\'tab\',\'' + tab + '\')">'
        + '<b>' + ahNum(n) + '</b><i>/' + members + '</i><span>' + ahEsc(label) + '</span></button>';
    };
    hs.innerHTML = members
      ? mini(r.checked_in_today, 'checked in today', 'dailycheckin')
        + mini(r.workouts_today, 'workouts logged', 'workouts')
        + mini(r.meals_today, 'meals logged', 'nutrition')
      : '';
  }

  // ---- what is actually waiting on the admin -------------------------------
  var queue = [
    { n: ib.unread_threads, one: 'member is waiting on a reply', many: 'members are waiting on a reply',
      cta: 'Open messages', kind: 'tab', to: 'messages', tone: 'bad', icon: '💬' },
    { n: p.pending_audits, one: 'body audit needs reviewing', many: 'body audits need reviewing',
      cta: 'Open leads', kind: 'tab', to: 'leads', tone: 'warn', icon: '🎯' },
    { n: ib.escalations, one: 'client escalated by an operator', many: 'clients escalated by operators',
      cta: 'Open escalations', kind: 'modal', to: 'escalations', tone: 'info', icon: '🛰️' },
    { n: ib.blood_unsent, one: 'blood report is ready to send', many: 'blood reports are ready to send',
      cta: 'Open blood reports', kind: 'tab', to: 'blood', tone: 'warn', icon: '🩺' },
    { n: r.trials_expiring, one: 'trial ends within 3 days', many: 'trials end within 3 days',
      cta: 'Open memberships', kind: 'tab', to: 'memberships', tone: 'bad', icon: '⏳' },
    { n: r.trials_ended, one: 'trial has ended', many: 'trials have ended',
      cta: 'Open memberships', kind: 'tab', to: 'memberships', tone: 'warn', icon: '🔔' },
    { n: ib.blood_pending, one: 'blood report is still processing', many: 'blood reports are still processing',
      cta: 'Open blood reports', kind: 'tab', to: 'blood', tone: 'info', icon: '⚗️' }
  ].filter(function (x) { return (x.n || 0) > 0; });

  var qEl = ahEl('ahQueue');
  if (qEl) {
    qEl.innerHTML = queue.length
      ? queue.map(function (x) {
          return '<button type="button" class="ah-task ' + x.tone + '" onclick="ahGo(\'' + x.kind + '\',\'' + x.to + '\')">'
            + '<span class="ah-task-ico" aria-hidden="true">' + x.icon + '</span>'
            + '<span class="ah-task-main"><b>' + ahNum(x.n) + '</b> ' + ahEsc(x.n === 1 ? x.one : x.many) + '</span>'
            + '<span class="ah-task-cta">' + ahEsc(x.cta) + ' →</span></button>';
        }).join('')
      : '<div class="ah-clear"><span aria-hidden="true">✓</span><div><b>Nothing is waiting on you.</b>'
        + '<i>No unread messages, no audits to review, no reports to send.</i></div></div>';
  }
  var qc = ahEl('ahQueueCount');
  if (qc) {
    var totalTasks = queue.reduce(function (a, x) { return a + (x.n || 0); }, 0);
    qc.textContent = totalTasks ? ahPlural(totalTasks, 'item') : 'all clear';
  }

  // ---- the numbers ---------------------------------------------------------
  var tile = function (n, label, sub, tone, kind, to) {
    return '<button type="button" class="ah-tile' + (tone ? ' ' + tone : '') + ((n || 0) ? '' : ' zero') + '"'
      + ' onclick="ahGo(\'' + kind + '\',\'' + to + '\')">'
      + '<span class="ah-tile-n">' + ahNum(n) + '</span>'
      + '<span class="ah-tile-l">' + ahEsc(label) + '</span>'
      + '<span class="ah-tile-s">' + ahEsc(sub) + '</span></button>';
  };

  var rosterEl = ahEl('ahTilesRoster');
  if (rosterEl) {
    rosterEl.innerHTML =
      tile(r.members, 'Members', 'on the roster', 'gold', 'tab', 'tribe')
      + tile(r.active_7d, 'Active', 'last 7 days', 'ok', 'tab', 'dailycompliance')
      + tile(r.inactive_7d, 'Inactive', 'nothing logged in 7 days', 'bad', 'tab', 'dailycompliance')
      + tile(r.checked_in_today, 'Daily check-ins', 'today', 'amber', 'tab', 'dailycheckin')
      + tile(r.workouts_today, 'Workouts', 'logged today', 'amber', 'tab', 'workouts')
      + tile(r.meals_today, 'Meals', 'logged today', 'amber', 'tab', 'nutrition');
  }

  var pipeEl = ahEl('ahTilesPipeline');
  if (pipeEl) {
    pipeEl.innerHTML =
      tile(p.audits_today, 'Audits today', ahPlural(p.audits_7d || 0, 'this week', 'this week'), 'info', 'tab', 'leads')
      + tile(p.pending_audits, 'Awaiting review', 'body audits', 'warn', 'tab', 'leads')
      + tile(p.audits_no_account, 'Never signed up', 'audited in last 30 days', 'bad', 'tab', 'leads')
      + tile(p.part2_today, 'Part-2 today', (p.part2_7d || 0) + ' this week', 'info', 'tab', 'part2')
      + tile(r.trials, 'On trial', (r.trials_expiring || 0) + ' ending soon', 'amber', 'tab', 'memberships')
      + tile(r.new_members_7d, 'New members', 'joined this week', 'ok', 'tab', 'tribe');
  }

  // ---- what just happened --------------------------------------------------
  var feedEl = ahEl('ahFeed');
  if (feedEl) {
    var items = (d.feed || []).slice(0, 8);
    if (!items.length) feedEl.innerHTML = '<div class="ah-empty">Nothing logged recently.</div>';
    else {
      var out = '', lastDay = null;
      items.forEach(function (f) {
        var key = new Date(f.created_at).toDateString();
        if (key !== lastDay) { lastDay = key; out += '<div class="ah-day">' + ahEsc(ahDayLabel(f.created_at)) + '</div>'; }
        out += '<div class="ah-feed-row"><span class="ah-dot ' + ahEsc(f.type || '') + '"></span>'
          + '<span class="ah-feed-main"><b>' + ahEsc(f.name || '') + '</b><i>' + ahEsc(f.label || '') + '</i></span>'
          + '<span class="ah-feed-time">' + ahEsc(ahTimeAgo(f.created_at)) + '</span></div>';
      });
      feedEl.innerHTML = out;
    }
  }
}

// The admin shell calls this after its own loaders finish.
function ahBoot() {
  if (!ahEl('adminHome')) return;
  loadAdminHome();
  if (window._ahPoll) clearInterval(window._ahPoll);
  window._ahPoll = setInterval(function () {
    var panel = document.getElementById('adminPanel');
    if (panel && panel.classList.contains('open')) loadAdminHome(true);
  }, 120000);
}
