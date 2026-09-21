/* ============================================================================
   BodyBank — Admin landing ("Dashboard")
   ----------------------------------------------------------------------------
   One screen that answers, in order: is the roster showing up, what is waiting
   on me, what do the numbers say, and what just happened. Every figure comes
   from a single read (/api/admin/overview) so nothing on the page can disagree
   with anything else on it, and every tile is a way INTO the section that owns
   that number rather than a figure to read and then go hunting for.

   Rebuilt 2026-09-21. What changed and why:
   - The 14-day activity chart is an SVG area path instead of fourteen blocks.
     At fourteen points a bar chart is mostly gaps, and a week of zeros rendered
     as a row of stubs that read like a broken widget. A path keeps its baseline,
     so a quiet week reads as a flat line - which is the truth.
   - Fourteen KPI tiles became three switchable groups, and tiles reading zero
     are folded away behind one toggle. Eleven zeros is not a dashboard.
   - The action queue is one line per job. It used to be a card per job, each
     carrying its own "Open X" link, which cost ~96px to say "4 audits".
   - Quick access is a two-row side-scrolling rail instead of a seventeen-box
     grid that ran ~600px down the page.

   The same component serves desktop and phone - the admin shell supplies the
   sidebar and the bottom bar around it.

   Depends on globals from index.html: apiCall, escapeHtml, switchTab,
   switchToSection, openAdminEscalations.
   ========================================================================== */

var ahState = window.ahState || (window.ahState = {
  data: null, loading: false, seg: 'roster', showZeros: false
});

function ahEl(id) { return document.getElementById(id); }
function ahEsc(v) { return escapeHtml(v == null ? '' : String(v)); }
function ahNum(n) { return Number(n || 0).toLocaleString(); }
function ahPlural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

/** Subtitle for the Part 2 tile: how many of the Part 1s came back. */
function part2Sub(na) {
  var p1 = Number(na && na.part1_submitted) || 0;
  var p2 = Number(na && na.part2_submitted) || 0;
  if (!p1) return 'none yet';
  var waiting = Math.max(0, p1 - p2);
  return waiting ? waiting + ' still to send' : 'all caught up';
}

/**
 * Subtitle for the watch-data tile: how many members, on which devices.
 * Screenshot- and manually-sourced members are called out, because a figure an AI
 * read off a photo is not the same evidence as one parsed from a device export.
 */
function deviceSummary(w) {
  var mix = (w && Array.isArray(w.by_device)) ? w.by_device : [];
  if (!mix.length) return 'none imported yet';
  var names = mix.slice(0, 2).map(function (d) {
    return String(d.provider || '').replace(/_/g, ' ');
  }).join(', ');
  var extra = mix.length > 2 ? ' +' + (mix.length - 2) : '';
  var lowTrust = mix.some(function (d) { return d.provider === 'screenshot' || d.provider === 'manual'; });
  return names + extra + (lowTrust ? ' · some lower confidence' : '');
}

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
    else if (kind === 'fn' && typeof window[name] === 'function') window[name]();
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

/* ------------------------------------------------------------------- chart */
/**
 * A 14-day area chart as one SVG path.
 *
 * Drawn in a 0..100 x 0..100 box with preserveAspectRatio="none", so it fills
 * whatever width the card has without any measuring in script. The fill path
 * closes down to the baseline, which is what keeps a flat week legible: the
 * shape is still there, it is simply flat.
 */
function ahChartSvg(series, labels) {
  var n = series.length;
  if (!n) return '';
  var peak = Math.max.apply(null, series.concat([1]));
  var x = function (i) { return n === 1 ? 50 : (i / (n - 1)) * 100; };
  // 6 and 94 leave room for the stroke and the end dot to sit inside the box.
  var y = function (v) { return 94 - (v / peak) * 88; };

  var line = series.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2); }).join(' ');
  var area = line + ' L100 100 L0 100 Z';
  var lastX = x(n - 1), lastY = y(series[n - 1]);

  var ticks = series.map(function (v, i) {
    var when = labels[labels.length - n + i] || '';
    var day = when ? new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    // An invisible wide rect per point so a tap/hover anywhere in that column
    // gets the tooltip, rather than only the 1px line itself.
    return '<rect x="' + Math.max(0, x(i) - (50 / n)).toFixed(2) + '" y="0" width="' + (100 / n).toFixed(2) + '" height="100" fill="transparent">'
      + '<title>' + ahEsc(day) + (day ? ': ' : '') + ahEsc(ahPlural(v, 'active member')) + '</title></rect>';
  }).join('');

  return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
    + '<defs><linearGradient id="ahFill" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="#E0BE6E" stop-opacity=".36"/>'
    + '<stop offset="100%" stop-color="#E0BE6E" stop-opacity="0"/>'
    + '</linearGradient></defs>'
    + '<path d="' + area + '" fill="url(#ahFill)"/>'
    + '<path d="' + line + '" fill="none" stroke="#E0BE6E" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
    + ticks
    + '</svg>'
    + '<span class="ah-chart-dot" style="left:' + lastX.toFixed(2) + '%;top:' + lastY.toFixed(2) + '%"></span>';
}

/* ----------------------------------------------------------------- metrics */
function ahMetric(n, label, sub, tone, kind, to) {
  var v = Number(n || 0);
  return '<button type="button" class="ah-metric' + (tone ? ' ' + tone : '') + (v ? '' : ' zero') + '"'
    + ' onclick="ahGo(\'' + kind + '\',\'' + to + '\')">'
    + '<span class="ah-metric-n">' + ahNum(n) + '</span>'
    + '<span class="ah-metric-l">' + ahEsc(label) + '</span>'
    + '<span class="ah-metric-s">' + ahEsc(sub) + '</span></button>';
}

/** The three metric groups, built from the one overview payload. */
function ahMetricGroups(d) {
  var r = d.roster || {}, p = d.pipeline || {};
  var na = d.nutritionAssessments || {}, w = d.wearables || {};
  var members = r.members || 0;
  var ofMembers = function (n) { return (members ? n + ' of ' + members + ' members' : 'no members yet') + ' today'; };
  return {
    roster: [
      ahMetric(r.members, 'Members', 'on the roster', 'gold', 'tab', 'tribe'),
      ahMetric(r.active_7d, 'Active', 'last 7 days', 'ok', 'tab', 'dailycompliance'),
      ahMetric(r.inactive_7d, 'Inactive', 'nothing logged in 7 days', 'bad', 'tab', 'dailycompliance'),
      ahMetric(r.checked_in_today, 'Checked in', ofMembers(r.checked_in_today), 'amber', 'tab', 'dailycheckin'),
      ahMetric(r.trained_today, 'Trained', ofMembers(r.trained_today), 'amber', 'tab', 'workouts'),
      ahMetric(r.ate_today, 'Logged a meal', ofMembers(r.ate_today), 'amber', 'tab', 'nutrition')
    ],
    pipeline: [
      ahMetric(p.audits_today, 'Audits today', (p.audits_7d || 0) + ' this week', 'info', 'tab', 'leads'),
      ahMetric(p.pending_audits, 'Awaiting review', 'body audits', 'warn', 'tab', 'leads'),
      ahMetric(p.audits_no_account, 'Never signed up', 'audited in last 30 days', 'bad', 'tab', 'leads'),
      ahMetric(p.part2_today, 'Part-2 today', (p.part2_7d || 0) + ' this week', 'info', 'tab', 'part2'),
      ahMetric(r.trials, 'On trial', (r.trials_expiring || 0) + ' ending soon', 'amber', 'tab', 'memberships'),
      ahMetric(r.new_members_7d, 'New members', 'joined this week', 'ok', 'tab', 'tribe')
    ],
    // Nutrition assessments and watch data. Split into the two parts, because
    // "12 assessments" hides the fact that only 4 came back for part 2 - which
    // is the number to act on.
    intake: [
      ahMetric(na.part1_submitted, 'FitChef Part 1', 'submitted', 'info', 'tab', 'nutritionassessment'),
      ahMetric(na.part2_submitted, 'FitChef Part 2', part2Sub(na), 'ok', 'tab', 'nutritionassessment'),
      // Flagged submissions are a safety gate a human has to clear (clinician
      // referral, pregnancy, disordered-eating signal), so this goes red the
      // moment there is one.
      ahMetric(na.needs_review, 'Need review', 'before a plan goes out',
        (na.needs_review || 0) > 0 ? 'bad' : 'ok', 'tab', 'nutritionassessment'),
      ahMetric(w.members, 'Watch data', deviceSummary(w), 'info', 'tab', 'clientprogress')
    ]
  };
}

function ahRenderMetrics() {
  var host = ahEl('ahMetrics');
  if (!host || !ahState.data) return;
  var groups = ahMetricGroups(ahState.data);
  var cards = groups[ahState.seg] || groups.roster;
  var zeros = cards.filter(function (h) { return h.indexOf(' zero"') !== -1; }).length;

  host.className = 'ah-metrics' + (ahState.showZeros ? '' : ' hide-zero');
  host.innerHTML = cards.join('')
    + (!ahState.showZeros && zeros === cards.length
      ? '<div class="ah-allzero">Nothing recorded here yet.</div>' : '');

  var tog = ahEl('ahZeroToggle');
  if (tog) {
    if (!zeros) { tog.style.display = 'none'; }
    else {
      tog.style.display = '';
      tog.textContent = ahState.showZeros ? 'Hide empty' : 'Show ' + zeros + ' empty';
    }
  }
  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('.ah-seg[data-seg]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-seg') === ahState.seg);
    });
  }
}
function ahSetSeg(seg) { ahState.seg = seg; ahRenderMetrics(); return false; }
function ahToggleZeros() { ahState.showZeros = !ahState.showZeros; ahRenderMetrics(); return false; }

/* ---------------------------------------------------------------- render */
function renderAdminHome() {
  var d = ahState.data;
  if (!d || !ahEl('adminHome')) return;
  var r = d.roster || {}, p = d.pipeline || {}, ib = d.inbox || {}, t = d.trends || {};

  // ---- top strip -----------------------------------------------------------
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

  // ---- hero: is the roster showing up, and is that better than last week? --
  var members = r.members || 0, active = r.active_7d || 0;
  ahEl('ahActiveN') && (ahEl('ahActiveN').textContent = members ? ahNum(active) : '–');
  ahEl('ahActiveOf') && (ahEl('ahActiveOf').textContent = members
    ? 'of ' + ahNum(members) + ' members'
    : 'no members yet');

  var series = (t.active || []).slice(-14);
  var dEl = ahEl('ahDelta');
  if (dEl) {
    if (series.length >= 14) {
      var avg = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
      var thisWk = avg(series.slice(7)), lastWk = avg(series.slice(0, 7));
      var diff = Math.round((thisWk - lastWk) * 10) / 10;
      if (!thisWk && !lastWk) { dEl.textContent = 'quiet both weeks'; dEl.className = 'ah-delta'; }
      else if (diff > 0) { dEl.textContent = '▲ ' + diff + '/day'; dEl.className = 'ah-delta up'; }
      else if (diff < 0) { dEl.textContent = '▼ ' + Math.abs(diff) + '/day'; dEl.className = 'ah-delta down'; }
      else { dEl.textContent = 'level'; dEl.className = 'ah-delta'; }
    } else { dEl.textContent = ''; dEl.className = 'ah-delta'; }
  }

  var chart = ahEl('ahChart');
  if (chart) {
    if (!series.length) {
      chart.innerHTML = '<div class="ah-chart-empty">Daily activity appears here once members start logging.</div>';
      ahEl('ahSparkPeak') && (ahEl('ahSparkPeak').textContent = '');
    } else {
      var peak = Math.max.apply(null, series.concat([0]));
      chart.innerHTML = peak
        ? ahChartSvg(series, t.labels || [])
        : '<div class="ah-chart-empty">No member activity in the last 14 days.</div>';
      ahEl('ahSparkPeak') && (ahEl('ahSparkPeak').textContent = peak ? 'peak ' + peak : '');
    }
  }

  var hs = ahEl('ahHeroStats');
  if (hs) {
    // These read "N of members", so they have to be counts of PEOPLE, not of
    // sessions — a session count against a member denominator can exceed the
    // roster and means nothing as a fraction.
    var mini = function (n, label, tab) {
      var v = Number(n || 0);
      var pct = members ? Math.min(100, Math.round((v / members) * 100)) : 0;
      return '<button type="button" class="ah-hstat' + (v ? '' : ' nil') + '" onclick="ahGo(\'tab\',\'' + tab + '\')">'
        + '<span class="ah-hstat-n"><b>' + ahNum(v) + '</b><i>/' + ahNum(members) + '</i></span>'
        + '<span class="ah-hstat-m"><span style="width:' + pct + '%"></span></span>'
        + '<span class="ah-hstat-l">' + ahEsc(label) + '</span></button>';
    };
    hs.innerHTML = members
      ? mini(r.checked_in_today, 'Checked in', 'dailycheckin')
        + mini(r.trained_today, 'Trained', 'workouts')
        + mini(r.ate_today, 'Ate', 'nutrition')
      : '';
    hs.style.display = members ? '' : 'none';
  }

  // ---- what is actually waiting on the admin -------------------------------
  var queue = [
    { n: ib.unread_threads, one: 'member waiting on a reply', many: 'members waiting on a reply',
      kind: 'tab', to: 'messages', tone: 'bad', icon: '\u{1F4AC}' },
    { n: p.pending_audits, one: 'body audit to review', many: 'body audits to review',
      kind: 'tab', to: 'leads', tone: 'warn', icon: '\u{1F3AF}' },
    { n: ib.escalations, one: 'client escalated by an operator', many: 'clients escalated by operators',
      kind: 'modal', to: 'escalations', tone: 'info', icon: '\u{1F6F0}️' },
    { n: ib.blood_unsent, one: 'blood report ready to send', many: 'blood reports ready to send',
      kind: 'tab', to: 'blood', tone: 'warn', icon: '\u{1FA7A}' },
    { n: r.trials_expiring, one: 'trial ends within 3 days', many: 'trials end within 3 days',
      kind: 'tab', to: 'memberships', tone: 'bad', icon: '⏳' },
    { n: r.trials_ended, one: 'trial has ended', many: 'trials have ended',
      kind: 'tab', to: 'memberships', tone: 'warn', icon: '\u{1F514}' },
    { n: ib.blood_pending, one: 'blood report still processing', many: 'blood reports still processing',
      kind: 'tab', to: 'blood', tone: 'info', icon: '⚗️' }
  ].filter(function (x) { return (x.n || 0) > 0; });

  var qEl = ahEl('ahQueue');
  if (qEl) {
    qEl.innerHTML = queue.length
      ? queue.map(function (x) {
          return '<button type="button" class="ah-task ' + x.tone + '" onclick="ahGo(\'' + x.kind + '\',\'' + x.to + '\')">'
            + '<span class="ah-task-ico" aria-hidden="true">' + x.icon + '</span>'
            + '<span class="ah-task-n">' + ahNum(x.n) + '</span>'
            + '<span class="ah-task-main">' + ahEsc(x.n === 1 ? x.one : x.many) + '</span>'
            + '<span class="ah-task-go" aria-hidden="true">›</span></button>';
        }).join('')
      : '<div class="ah-clear"><span aria-hidden="true">✓</span><div><b>Nothing is waiting on you.</b>'
        + '<i>No unread messages, no audits to review, no reports to send.</i></div></div>';
  }
  var qc = ahEl('ahQueueCount');
  if (qc) {
    var totalTasks = queue.reduce(function (a, x) { return a + (x.n || 0); }, 0);
    qc.textContent = totalTasks ? ahPlural(totalTasks, 'item') : 'all clear';
    qc.className = 'ah-count' + (totalTasks ? '' : ' clear');
  }

  // ---- the numbers ---------------------------------------------------------
  ahRenderMetrics();

  // ---- what just happened --------------------------------------------------
  var feedEl = ahEl('ahFeed');
  if (feedEl) {
    var items = (d.feed || []).slice(0, 6);
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

/* Quick access — the shortcuts the old dashboard carried, unchanged in
   destination and order, as a side-scrolling rail rather than a seventeen-box
   grid that ran ~600px down the page. */
var AH_QUICK = [
  { icon: '\u{1F3AF}', label: 'Leads', kind: 'tab', to: 'leads' },
  { icon: '\u{1F465}', label: 'Client Board', kind: 'tab', to: 'tribe' },
  { icon: '\u{1F4CB}', label: 'Audit Forms', kind: 'tab', to: 'requests' },
  // Sits next to Audit Forms because it is the same job — an intake form staff
  // read and action — rather than buried under Analytics.
  { icon: '\u{1F37D}️', label: 'FitChef Assessment', kind: 'tab', to: 'nutritionassessment' },
  // No dedicated tab: watch data is read per member, and Client Progress is where
  // the Readiness sub-tab lives.
  { icon: '⌚', label: 'Watch Data', kind: 'tab', to: 'clientprogress' },
  { icon: '\u{1F4C5}', label: 'Daily Check-ins', kind: 'tab', to: 'dailycheckin' },
  { icon: '\u{1F3CB}️', label: 'Workouts', kind: 'tab', to: 'workouts' },
  { icon: '\u{1F5C2}️', label: 'Programs', kind: 'tab', to: 'programs' },
  { icon: '\u{1F4F8}', label: 'Transformations', kind: 'tab', to: 'transformations' },
  { icon: '\u{1F3C6}', label: 'Leader Boards', kind: 'tab', to: 'leaderboards' },
  { icon: '\u{1F957}', label: 'Nutrition AI', kind: 'tab', to: 'nutrition' },
  { icon: '\u{1FA7A}', label: 'Blood Reports', kind: 'tab', to: 'blood' },
  { icon: '\u{1F4B3}', label: 'Members', kind: 'tab', to: 'memberships' },
  { icon: '\u{1F4C8}', label: 'Analytics', kind: 'section', to: 'analytics' },
  { icon: '\u{1FA99}', label: 'Tokens', kind: 'tab', to: 'tokens' },
  { icon: '\u{1F4D1}', label: 'Reports', kind: 'tab', to: 'reports' },
  { icon: '\u{1F4A1}', label: 'AI Assist', kind: 'fn', to: 'toggleAdminAiAssistPanel' }
];
function renderAdminQuick() {
  var el = ahEl('ahQuick');
  if (!el) return;
  el.innerHTML = AH_QUICK.map(function (q) {
    return '<button type="button" class="ah-quick" onclick="ahGo(&quot;' + q.kind + '&quot;,&quot;' + q.to + '&quot;)">'
      + '<span class="ah-quick-ico" aria-hidden="true">' + q.icon + '</span>'
      + '<span class="ah-quick-l">' + ahEsc(q.label) + '</span></button>';
  }).join('');
}

// The admin shell calls this after its own loaders finish.
function ahBoot() {
  if (!ahEl('adminHome')) return;
  renderAdminQuick();
  loadAdminHome();
  if (window._ahPoll) clearInterval(window._ahPoll);
  window._ahPoll = setInterval(function () {
    var panel = document.getElementById('adminPanel');
    if (panel && panel.classList.contains('open')) loadAdminHome(true);
  }, 120000);
}
