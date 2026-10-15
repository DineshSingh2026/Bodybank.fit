/* ==========================================================================
   ADMIN · CHALLENGES (window.bbChallengesAdmin)
   Build a challenge (details, rewards, day titles, tasks per day), Publish it
   (the approval step: nothing reaches members before this), watch enrollments,
   void / enrol / re-sync members, see stats (joins, day-by-day retention,
   completion, upgrades, sources) and work the lifestyle manager call queue.
   Backend: /api/challenges/admin/* (routes/challenges.js). Loaded lazily by
   js/challenges-loader.js when the Challenges tab opens.
   ========================================================================== */
(function () {
  'use strict';

  var KINDS = [
    ['daily_checkin', 'Daily check in', ''],
    ['protein_target', 'Protein target', 'pct'],
    ['meals_logged', 'Meals logged', 'count'],
    ['coach_workout', 'Coach Mode workout', 'coach'],
    ['workout_any', 'Any workout', 'min_minutes'],
    ['steps', 'Steps', 'steps'],
    ['water', 'Water', 'ml'],
    ['sleep', 'Sleep', 'hours'],
    ['mind_checkin', 'Mind check in', ''],
    ['sunday_checkin', 'Sunday check in', ''],
    ['manual', 'Manual (staff ticks)', '']
  ];
  var TIERS = [['core', 'Core'], ['guided', 'Guided'], ['tribe_elite', 'Tribe Elite']];
  var STATUS_LABEL = { draft: 'Draft', published: 'Published', archived: 'Archived' };

  var S = { host: null, view: 'challenges', list: null, flag: '', openCalls: 0, sel: null, selId: null, tab: 'details', stats: null, msg: null, busy: false,
    en: null, enFilter: { challenge_id: '', status: '', q: '' }, enSel: null, calls: null, callStatus: 'requested', creating: false, memberQ: '', members: null, req: 0 };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }
  function hdr(json) {
    var h = { Accept: 'application/json' };
    var u = window.currentUser;
    if (u && u.token) h.Authorization = 'Bearer ' + u.token;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  async function api(method, path, body) {
    try {
      var r = await fetch(apiBase() + '/api/challenges/admin' + path, { method: method, headers: hdr(!!body), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      var d = null; try { d = await r.json(); } catch (e) { d = null; }
      return { ok: r.ok, status: r.status, data: d };
    } catch (e) { return { ok: false, status: 0, data: { error: 'You are offline' } }; }
  }
  function errOf(r, fb) {
    var d = r && r.data;
    if (!d) return fb;
    var extra = d.errors ? Object.keys(d.errors).map(function (k) { var v = d.errors[k]; return k + ': ' + (Array.isArray(v) ? v.join(', ') : v); }).slice(0, 6).join(' · ') : '';
    return (d.error || fb) + (extra ? ' — ' + extra : '');
  }
  function flash(ok, text) { S.msg = ok ? { ok: text } : { err: text }; render(); if (ok) setTimeout(function () { if (S.msg && S.msg.ok === text) { S.msg = null; render(); } }, 3500); }
  function dateShort(v) { if (!v) return '—'; var d = new Date(v); return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
  function kindMeta(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return KINDS[i]; return KINDS[0]; }

  /* ------------------------------------------------------------ load */
  async function loadList(keepSel) {
    var r = await api('GET', '/challenges');
    if (!r.ok) { S.list = []; flash(false, errOf(r, 'Could not load challenges')); return; }
    S.list = r.data.challenges || [];
    S.flag = r.data.flag;
    S.openCalls = r.data.open_lm_calls || 0;
    if (keepSel && S.selId) await loadOne(S.selId);
    render();
  }
  async function loadOne(id) {
    var r = await api('GET', '/challenges/' + encodeURIComponent(id));
    if (r.ok) { S.sel = r.data; S.selId = id; } else flash(false, errOf(r, 'Could not load the challenge'));
  }
  async function loadStats(id) {
    S.stats = null; render();
    var r = await api('GET', '/stats/' + encodeURIComponent(id));
    S.stats = r.ok ? r.data : { error: errOf(r, 'Could not load stats') };
    render();
  }
  async function loadEnrollments() {
    var my = ++S.req;
    S.en = null; render();
    var f = S.enFilter;
    var qs = '?challenge_id=' + encodeURIComponent(f.challenge_id) + '&status=' + encodeURIComponent(f.status) + (f.q.length >= 2 ? '&q=' + encodeURIComponent(f.q) : '');
    var r = await api('GET', '/enrollments' + qs);
    if (my !== S.req) return;
    S.en = r.ok ? r.data.enrollments || [] : [];
    if (!r.ok) S.msg = { err: errOf(r, 'Could not load members') };
    render();
  }
  async function loadEnrollment(id) {
    S.enSel = { loading: true, id: id }; render();
    var r = await api('GET', '/enrollments/' + encodeURIComponent(id));
    S.enSel = r.ok ? Object.assign({ id: id }, r.data) : { id: id, error: errOf(r, 'Could not load') };
    render();
  }
  async function loadCalls() {
    S.calls = null; render();
    var r = await api('GET', '/lm-calls' + (S.callStatus ? '?status=' + S.callStatus : ''));
    S.calls = r.ok ? r.data.calls || [] : [];
    render();
  }

  /* ---------------------------------------------------------- render */
  function render() {
    if (!S.host) return;
    var act = document.activeElement;
    var keepId = act && S.host.contains(act) && act.id ? act.id : null;
    var caret = keepId && typeof act.selectionStart === 'number' ? act.selectionStart : null;
    var flagNote = S.flag === 'all' ? '<span class="bbcx-flag is-on">Live for members</span>'
      : '<span class="bbcx-flag">Flag: ' + esc(S.flag || '…') + ' — ' + (S.flag === 'off' ? 'members see nothing yet' : S.flag === 'staff' ? 'staff only' : 'allowlist only') + '</span>';
    var h = '<div class="bbcx"><div class="bbcx-head"><div><h2>Challenges</h2><p>Build a challenge as a draft, check every day, then Publish. Members only ever see published challenges. ' + flagNote + '</p></div>' +
      '<div class="bbcx-tabs" role="tablist">' +
      tabBtn('challenges', 'Challenges') + tabBtn('members', 'Members') + tabBtn('calls', 'Call requests' + (S.openCalls ? ' (' + S.openCalls + ')' : '')) + '</div></div>';
    if (S.msg) h += '<div class="bbcx-msg ' + (S.msg.err ? 'is-err' : 'is-ok') + '" role="' + (S.msg.err ? 'alert' : 'status') + '">' + esc(S.msg.err || S.msg.ok) + '</div>';
    if (S.view === 'members') h += vMembers();
    else if (S.view === 'calls') h += vCalls();
    else h += vChallenges();
    S.host.innerHTML = h + '</div>';
    if (keepId) {
      var el = document.getElementById(keepId);
      if (el) { el.focus(); if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch (e) { /* not text */ } }
    }
  }
  function tabBtn(v, label) { return '<button type="button" role="tab" aria-selected="' + (S.view === v) + '" data-x="view" data-v="' + v + '">' + esc(label) + '</button>'; }

  function vChallenges() {
    if (!S.list) return '<p class="bbcx-muted">Loading…</p>';
    var h = '<div class="bbcx-grid' + (S.sel || S.creating ? ' has-sel' : '') + '"><div class="bbcx-list">';
    h += '<button type="button" class="bbcx-new" data-x="new">+ New challenge</button>';
    h += S.list.map(function (c) {
      var n = c.counts || {};
      return '<button type="button" class="bbcx-item' + (S.selId === c.id ? ' is-on' : '') + '" data-x="sel" data-id="' + esc(c.id) + '">' +
        '<span class="bbcx-item-top"><b>' + esc(c.title) + '</b><span class="bbcx-status is-' + esc(c.status) + '">' + esc(STATUS_LABEL[c.status] || c.status) + '</span></span>' +
        '<span class="bbcx-item-sub">' + c.length_days + ' days · ' + esc(c.access === 'free' ? 'Free' : c.access === 'plan' ? 'Included: ' + c.included_tiers.join(', ') : 'Staff enrol only') + ' · ' + c.task_count + ' tasks</span>' +
        '<span class="bbcx-item-sub">' + (n.joined || 0) + ' joined · ' + (n.active || 0) + ' active · ' + (n.completed || 0) + ' finished</span></button>';
    }).join('');
    h += '</div><div class="bbcx-editor">';
    if (S.creating) h += vCreate();
    else if (S.sel) h += vEditor();
    else h += '<div class="bbcx-empty"><p>Pick a challenge to edit it, or create a new one.</p><p class="bbcx-muted">Three launch challenges (Starter 7, Reset 15, Transformation 30) arrive as drafts. Check the copy and tasks, then Publish.</p></div>';
    return h + '</div></div>';
  }

  function vCreate() {
    return '<div class="bbcx-card"><button type="button" class="bbcx-back" data-x="unsel">← Back</button><h3>New challenge</h3>' +
      '<div class="bbcx-form">' +
      field('ncId', 'Id (kebab-case, e.g. summer-10)', '<input class="bbcx-input" id="ncId" maxlength="40">') +
      field('ncTitle', 'Title', '<input class="bbcx-input" id="ncTitle" maxlength="80">') +
      field('ncLen', 'Length (days)', '<input class="bbcx-input" id="ncLen" type="number" min="1" max="90" value="7">') +
      field('ncAccess', 'Access', '<select class="bbcx-input" id="ncAccess"><option value="free">Free for every member</option><option value="plan">Included in plans</option><option value="paid">Staff enrol only</option></select>') +
      '</div><div class="bbcx-actions"><button type="button" class="bbcx-btn is-gold" data-x="create"' + (S.busy ? ' disabled' : '') + '>Create draft</button></div></div>';
  }
  function field(id, label, input, hint) {
    return '<label class="bbcx-field" for="' + id + '"><span>' + esc(label) + '</span>' + input + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
  }

  function vEditor() {
    var c = S.sel;
    var rw = c.rewards || {};
    var joined = (S.list.filter(function (x) { return x.id === c.id; })[0] || {}).counts || {};
    var locked = (joined.joined || 0) > 0;
    var h = '<div class="bbcx-card"><button type="button" class="bbcx-back" data-x="unsel">← Back</button>' +
      '<div class="bbcx-ed-head"><div><h3>' + esc(c.title) + ' <span class="bbcx-status is-' + esc(c.status) + '">' + esc(STATUS_LABEL[c.status]) + '</span></h3>' +
      '<p class="bbcx-muted">' + esc(c.id) + ' · ' + c.length_days + ' days · finish ' + c.min_days_effective + ' of ' + c.length_days + (c.published_at ? ' · published ' + dateShort(c.published_at) : '') + '</p></div>' +
      '<div class="bbcx-actions">' +
      (c.status !== 'published' ? '<button type="button" class="bbcx-btn is-gold" data-x="publish">Publish</button>' : '<button type="button" class="bbcx-btn" data-x="draft">Back to draft</button>') +
      (c.status !== 'archived' ? '<button type="button" class="bbcx-btn is-quiet" data-x="archive">Archive</button>' : '') + '</div></div>' +
      '<div class="bbcx-subtabs" role="tablist">' + ['details', 'tasks', 'stats'].map(function (t) {
        return '<button type="button" role="tab" aria-selected="' + (S.tab === t) + '" data-x="tab" data-v="' + t + '">' + { details: 'Details & rewards', tasks: 'Days & tasks', stats: 'Stats' }[t] + '</button>';
      }).join('') + '</div>';
    if (S.tab === 'tasks') h += vTasks(c, locked);
    else if (S.tab === 'stats') h += vStats();
    else {
      h += '<div class="bbcx-form">' +
        field('cfTitle', 'Title', '<input class="bbcx-input" id="cfTitle" maxlength="80" value="' + esc(c.title) + '">') +
        field('cfSubtitle', 'Card line (hub)', '<input class="bbcx-input" id="cfSubtitle" maxlength="160" value="' + esc(c.subtitle) + '">') +
        field('cfDesc', 'Detail line', '<input class="bbcx-input" id="cfDesc" maxlength="300" value="' + esc(c.description) + '">') +
        field('cfLen', 'Length (days)', '<input class="bbcx-input" id="cfLen" type="number" min="1" max="90" value="' + c.length_days + '"' + (locked ? ' disabled' : '') + '>', locked ? 'Locked: members have joined' : '') +
        field('cfMin', 'Days needed to finish', '<input class="bbcx-input" id="cfMin" type="number" min="1" max="' + c.length_days + '" value="' + (c.min_days == null ? '' : c.min_days) + '" placeholder="' + c.min_days_effective + ' (default)">', 'Blank = 1 grace day for 7 days, 85% for longer') +
        field('cfAccess', 'Access', '<select class="bbcx-input" id="cfAccess">' + [['free', 'Free for every member'], ['plan', 'Included in plans'], ['paid', 'Staff enrol only']].map(function (o) { return '<option value="' + o[0] + '"' + (c.access === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>') +
        '<fieldset class="bbcx-field bbcx-checks"><legend>Included in</legend>' + TIERS.map(function (t) {
          return '<label><input type="checkbox" class="cfTier" value="' + t[0] + '"' + (c.included_tiers.indexOf(t[0]) >= 0 ? ' checked' : '') + '> ' + t[1] + '</label>';
        }).join('') + '</fieldset>' +
        field('cfSort', 'Sort order', '<input class="bbcx-input" id="cfSort" type="number" min="0" max="10000" value="' + (c.sort_order == null ? 100 : c.sort_order) + '">') +
        '</div><h4>Rewards</h4><div class="bbcx-form">' +
        field('rwCoins', 'Completion coins', '<input class="bbcx-input" id="rwCoins" type="number" min="0" max="5000" value="' + (rw.coins || 0) + '">', '+10 coins for every fully done day as well') +
        field('rwBadgeKey', 'Badge key', '<input class="bbcx-input" id="rwBadgeKey" maxlength="30" value="' + esc(rw.badge_key || '') + '">') +
        field('rwBadgeLabel', 'Badge label', '<input class="bbcx-input" id="rwBadgeLabel" maxlength="40" value="' + esc(rw.badge_label || '') + '">') +
        '<fieldset class="bbcx-field bbcx-checks"><legend>Also unlocks</legend>' +
        '<label><input type="checkbox" id="rwCert"' + (rw.certificate ? ' checked' : '') + '> Certificate</label>' +
        '<label><input type="checkbox" id="rwDisc"' + (rw.discount ? ' checked' : '') + '> Upgrade discount (web checkout)</label>' +
        '<label><input type="checkbox" id="rwLm"' + (rw.lm_call ? ' checked' : '') + '> Lifestyle manager call</label></fieldset></div>' +
        '<p class="bbcx-muted">No prices, blood data, meal scores or medical claims in any challenge text. Publishing checks this.</p>' +
        '<div class="bbcx-actions"><button type="button" class="bbcx-btn is-gold" data-x="save"' + (S.busy ? ' disabled' : '') + '>Save details</button></div>';
    }
    return h + '</div>';
  }

  function paramInputs(t, i) {
    var p = t.params || {};
    var m = kindMeta(t.kind)[2];
    var num = function (key, label, val, min, max) {
      return '<label class="bbcx-mini">' + label + '<input class="bbcx-input" type="number" data-ti="' + i + '" data-p="' + key + '" min="' + min + '" max="' + max + '" value="' + esc(val) + '"></label>';
    };
    if (m === 'pct') return num('pct', '% of goal', p.pct || 90, 10, 150);
    if (m === 'count') return num('count', 'Meals', p.count || 3, 1, 8);
    if (m === 'steps') return num('steps', 'Steps', p.steps || 8000, 1000, 50000);
    if (m === 'ml') return num('ml', 'ml', p.ml || 3000, 500, 8000);
    if (m === 'hours') return num('hours', 'Hours', p.hours || 7, 4, 12);
    if (m === 'min_minutes') return num('min_minutes', 'Min minutes', p.min_minutes || 20, 5, 180);
    if (m === 'coach') {
      return num('min_minutes', 'Min minutes', p.min_minutes || 20, 1, 180) +
        '<label class="bbcx-mini">Area<select class="bbcx-input" data-ti="' + i + '" data-p="area">' + ['full', 'upper', 'lower', 'core'].map(function (a) { return '<option' + ((p.area || 'full') === a ? ' selected' : '') + '>' + a + '</option>'; }).join('') + '</select></label>' +
        num('exercises', 'Exercises', p.exercises || 4, 1, 12) +
        '<label class="bbcx-mini bbcx-mini-check"><input type="checkbox" data-ti="' + i + '" data-p="allow_any"' + (p.allow_any ? ' checked' : '') + '> My Workout counts too</label>';
    }
    return '';
  }

  function vTasks(c, locked) {
    if (!S.draftTasks || S.draftTasksFor !== c.id) {
      S.draftTasks = (c.tasks || []).map(function (t) { return { day_number: t.day_number, position: t.position, kind: t.kind, title: t.title, points: t.points, params: Object.assign({}, t.params || {}) }; });
      S.draftTitles = (c.day_titles || []).slice();
      S.draftTasksFor = c.id;
    }
    var h = locked ? '<p class="bbcx-warn">Members have joined: you can change task titles, points and day titles. The rules (kind and targets) are locked so nobody’s progress changes mid-run.</p>' : '';
    for (var d = 1; d <= c.length_days; d++) {
      var list = S.draftTasks.map(function (t, i) { return { t: t, i: i }; }).filter(function (x) { return x.t.day_number === d; }).sort(function (a, b) { return a.t.position - b.t.position; });
      h += '<div class="bbcx-day"><div class="bbcx-day-head"><b>Day ' + d + '</b><input class="bbcx-input" id="dt' + d + '" data-dt="' + d + '" maxlength="60" placeholder="Day headline (shown on the detail screen)" value="' + esc(S.draftTitles[d - 1] || '') + '"></div>';
      h += list.map(function (x) {
        var t = x.t;
        return '<div class="bbcx-task"><select class="bbcx-input bbcx-kind" data-ti="' + x.i + '" data-f="kind"' + (locked ? ' disabled' : '') + '>' + KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (t.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select>' +
          '<input class="bbcx-input" id="tt' + x.i + '" data-ti="' + x.i + '" data-f="title" maxlength="80" value="' + esc(t.title) + '" aria-label="Task title">' +
          '<label class="bbcx-mini">Points<input class="bbcx-input" type="number" data-ti="' + x.i + '" data-f="points" min="0" max="1000" value="' + (t.points == null ? 100 : t.points) + '"></label>' +
          '<span class="bbcx-params"' + (locked ? ' inert' : '') + '>' + paramInputs(t, x.i) + '</span>' +
          (locked ? '' : '<button type="button" class="bbcx-icon" data-x="rmtask" data-ti="' + x.i + '" aria-label="Remove task">✕</button>') + '</div>';
      }).join('');
      if (!locked && list.length < 6) h += '<button type="button" class="bbcx-add" data-x="addtask" data-day="' + d + '">+ Add task to day ' + d + '</button>';
      h += '</div>';
    }
    return h + '<div class="bbcx-actions bbcx-sticky"><button type="button" class="bbcx-btn" data-x="resettasks">Undo changes</button><button type="button" class="bbcx-btn is-gold" data-x="savetasks"' + (S.busy ? ' disabled' : '') + '>Save days & tasks</button></div>';
  }

  function vStats() {
    var s = S.stats;
    if (!s) return '<p class="bbcx-muted">Loading…</p>';
    if (s.error) return '<p class="bbcx-msg is-err">' + esc(s.error) + '</p>';
    var c = s.counts || {};
    var tiles = [['Joined', c.joined], ['This week', c.joined_7d], ['Active', c.active], ['Finished', c.completed], ['Missed', c.failed], ['Left', c.left_count],
      ['Completion', s.completion_pct == null ? '—' : s.completion_pct + '%'], ['Upgrades', (s.upgrades.used || 0) + ' / ' + (s.upgrades.issued || 0)]];
    var h = '<div class="bbcx-tiles">' + tiles.map(function (t) { return '<div class="bbcx-tile"><b>' + esc(t[1] == null ? 0 : t[1]) + '</b><span>' + esc(t[0]) + '</span></div>'; }).join('') + '</div>';
    h += '<h4>Day by day: share of joiners who finished each day</h4><div class="bbcx-bars" role="img" aria-label="Retention by day">' + s.retention.map(function (r) {
      return '<div class="bbcx-barcol" title="Day ' + r.day + ': ' + r.done + ' members (' + r.pct + '%)"><span class="bbcx-barval">' + r.pct + '%</span><span class="bbcx-barfill" style="height:' + Math.max(2, r.pct) + '%"></span><span class="bbcx-barday">' + r.day + '</span></div>';
    }).join('') + '</div>';
    if (s.sources && s.sources.length) h += '<h4>Where joins came from</h4><ul class="bbcx-sources">' + s.sources.map(function (x) { return '<li><span>' + esc(x.src) + '</span><b>' + x.n + '</b></li>'; }).join('') + '</ul>';
    return h + '<div class="bbcx-actions"><button type="button" class="bbcx-btn" data-x="csv" data-id="' + esc(s.challenge_id) + '">Export CSV</button></div>';
  }

  function vMembers() {
    var f = S.enFilter;
    var h = '<div class="bbcx-filters">' +
      '<select class="bbcx-input bbcx-narrow" id="enCh" data-x="enfilter" aria-label="Challenge"><option value="">All challenges</option>' + (S.list || []).map(function (c) { return '<option value="' + esc(c.id) + '"' + (f.challenge_id === c.id ? ' selected' : '') + '>' + esc(c.title) + '</option>'; }).join('') + '</select>' +
      '<select class="bbcx-input bbcx-narrow" id="enSt" data-x="enfilter" aria-label="Status"><option value="">Any status</option>' + ['active', 'completed', 'failed', 'left', 'void'].map(function (s) { return '<option' + (f.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<input class="bbcx-input bbcx-search" id="enQ" type="search" placeholder="Search name, email, phone" value="' + esc(f.q) + '">' +
      '<button type="button" class="bbcx-btn" data-x="csv" data-id="' + esc(f.challenge_id) + '">Export CSV</button></div>';
    h += '<details class="bbcx-card bbcx-enrol"><summary>Enrol a member (for plan or staff-only challenges)</summary><div class="bbcx-filters">' +
      '<input class="bbcx-input bbcx-search" id="memQ" type="search" placeholder="Find a member" value="' + esc(S.memberQ) + '">' +
      '<select class="bbcx-input bbcx-narrow" id="memCh" aria-label="Challenge">' + (S.list || []).filter(function (c) { return c.status === 'published'; }).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>'; }).join('') + '</select></div>' +
      (S.members ? (S.members.length ? '<ul class="bbcx-mlist">' + S.members.map(function (m) {
        return '<li><span>' + esc((m.first_name || '') + ' ' + (m.last_name || '')) + ' <small>' + esc(m.email) + ' · ' + esc(m.plan_tier || 'legacy') + '</small></span><button type="button" class="bbcx-btn" data-x="enrol" data-uid="' + esc(m.id) + '">Enrol</button></li>';
      }).join('') + '</ul>' : '<p class="bbcx-muted">No members found.</p>') : '') + '</details>';
    if (!S.en) return h + '<p class="bbcx-muted">Loading…</p>';
    if (!S.en.length) return h + '<p class="bbcx-muted">No enrollments match.</p>';
    h += '<div class="bbcx-table-wrap"><table class="bbcx-table"><thead><tr><th>Member</th><th>Challenge</th><th>Status</th><th>Days</th><th>Points</th><th>Started</th><th>Source</th><th></th></tr></thead><tbody>' +
      S.en.map(function (e) {
        return '<tr><td><b>' + esc((e.first_name || '') + ' ' + (e.last_name || '')) + '</b><br><small>' + esc(e.email || '') + '</small></td><td>' + esc(e.title) + '</td>' +
          '<td><span class="bbcx-status is-' + esc(e.status) + '">' + esc(e.status) + '</span>' + (e.lm_status ? '<br><small>call: ' + esc(e.lm_status) + '</small>' : '') + '</td>' +
          '<td>' + e.days_done + '/' + e.length_days + '</td><td>' + e.points + '</td><td>' + esc(String(e.start_date || '').slice(0, 10)) + '</td>' +
          '<td>' + esc((e.utm && e.utm.utm_source) || e.source || '') + '</td>' +
          '<td class="bbcx-row-actions"><button type="button" class="bbcx-btn" data-x="enview" data-id="' + esc(e.id) + '">View</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    if (S.enSel) h += vEnrollment();
    return h;
  }

  function vEnrollment() {
    var e = S.enSel;
    var h = '<div class="bbcx-veil" data-x="enclose"><div class="bbcx-modal" role="dialog" aria-modal="true" aria-label="Enrollment">';
    if (e.loading) return h + '<p>Loading…</p></div></div>';
    if (e.error) return h + '<p class="bbcx-msg is-err">' + esc(e.error) + '</p><button type="button" class="bbcx-btn" data-x="enclose">Close</button></div></div>';
    var en = e.enrollment;
    h += '<div class="bbcx-ed-head"><div><h3>' + esc(e.challenge.title) + ' <span class="bbcx-status is-' + esc(en.status) + '">' + esc(en.status) + '</span></h3><p class="bbcx-muted">Day ' + en.day + ' of ' + en.length + ' · ' + en.days_done + ' days done · ' + en.points + ' points · ' + esc(en.tz) + '</p></div>' +
      '<button type="button" class="bbcx-icon" data-x="enclose" aria-label="Close">✕</button></div>';
    h += '<div class="bbcx-strip">' + e.days.map(function (d) { return '<span class="bbcx-dot is-' + d.state + '" title="Day ' + d.day + ': ' + d.state + '">' + d.day + '</span>'; }).join('') + '</div>';
    h += '<h4>Day ' + e.today.day + ' tasks</h4><ul class="bbcx-tlist">' + e.today.tasks.map(function (t) {
      return '<li><span>' + (t.done ? '✅' : '⬜') + ' ' + esc(t.title) + ' <small>' + esc(t.done ? t.done_label : (t.progress && t.progress.label) || '') + '</small></span>' +
        (!t.done && t.kind === 'manual' && en.status === 'active' ? '<button type="button" class="bbcx-btn" data-x="manual" data-eid="' + esc(en.id) + '" data-tid="' + esc(t.id) + '">Mark done</button>' : '') + '</li>';
    }).join('') + '</ul>';
    if (e.audit && e.audit.length) h += '<h4>History</h4><ul class="bbcx-audit">' + e.audit.map(function (a) { return '<li><small>' + esc(new Date(a.created_at).toLocaleString('en-IN')) + '</small> ' + esc(a.action) + (a.notes ? ' — ' + esc(a.notes) : '') + '</li>'; }).join('') + '</ul>';
    h += '<div class="bbcx-actions"><button type="button" class="bbcx-btn" data-x="ensync" data-id="' + esc(en.id) + '">Re-check now</button>' +
      (en.status !== 'void' ? '<button type="button" class="bbcx-btn is-danger" data-x="envoid" data-id="' + esc(en.id) + '">Void</button>' : '') + '</div>';
    return h + '</div></div>';
  }

  function vCalls() {
    var h = '<div class="bbcx-filters"><div class="bbcx-chips">' + [['requested', 'To call'], ['scheduled', 'Scheduled'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['', 'All']].map(function (x) {
      return '<button type="button" class="bbcx-chip" aria-pressed="' + (S.callStatus === x[0]) + '" data-x="callst" data-v="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</div></div>';
    if (!S.calls) return h + '<p class="bbcx-muted">Loading…</p>';
    if (!S.calls.length) return h + '<p class="bbcx-muted">Nothing here. Finishers who ask for a call show up in this list (and as a staff notification).</p>';
    return h + '<div class="bbcx-calls">' + S.calls.map(function (c) {
      var phone = c.phone || c.user_phone || '';
      return '<div class="bbcx-card bbcx-call"><div class="bbcx-call-top"><div><b>' + esc((c.first_name || '') + ' ' + (c.last_name || '')) + '</b> <span class="bbcx-status is-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
        '<p class="bbcx-muted">' + esc(c.title) + ' · prefers ' + esc(c.preferred_slot || 'any time') + ' · asked ' + dateShort(c.created_at) + '</p>' +
        '<p>' + (phone ? '<a href="tel:' + esc(phone) + '">' + esc(phone) + '</a> · <a href="https://wa.me/' + esc(phone.replace(/\D/g, '')) + '" target="_blank" rel="noopener">WhatsApp</a> · ' : '') + esc(c.email || '') + '</p></div></div>' +
        '<textarea class="bbcx-input" id="cn' + esc(c.id) + '" rows="2" placeholder="Notes">' + esc(c.notes || '') + '</textarea>' +
        '<div class="bbcx-actions">' + ['scheduled', 'done', 'cancelled'].map(function (s) { return '<button type="button" class="bbcx-btn' + (s === 'done' ? ' is-gold' : '') + '" data-x="callset" data-id="' + esc(c.id) + '" data-v="' + s + '">' + s.charAt(0).toUpperCase() + s.slice(1) + '</button>'; }).join('') + '</div></div>';
    }).join('') + '</div>';
  }

  /* --------------------------------------------------------- actions */
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }

  async function save() {
    var c = S.sel;
    var body = {
      title: val('cfTitle'), subtitle: val('cfSubtitle'), description: val('cfDesc'),
      min_days: val('cfMin') === '' ? null : Number(val('cfMin')), access: val('cfAccess'), sort_order: Number(val('cfSort') || 100),
      included_tiers: Array.prototype.map.call(S.host.querySelectorAll('.cfTier:checked'), function (x) { return x.value; }),
      rewards: { coins: Number(val('rwCoins') || 0), badge_key: val('rwBadgeKey') || null, badge_label: val('rwBadgeLabel') || null, certificate: checked('rwCert'), discount: checked('rwDisc'), lm_call: checked('rwLm') }
    };
    var len = document.getElementById('cfLen');
    if (len && !len.disabled) body.length_days = Number(len.value);
    S.busy = true; render();
    var r = await api('PUT', '/challenges/' + encodeURIComponent(c.id), body);
    S.busy = false;
    if (!r.ok) return flash(false, errOf(r, 'Could not save'));
    S.sel = r.data; S.draftTasksFor = null;
    await loadList(false);
    flash(true, 'Saved.');
  }
  async function saveTasks() {
    var c = S.sel;
    S.busy = true; render();
    var r1 = await api('PUT', '/challenges/' + encodeURIComponent(c.id), { day_titles: S.draftTitles.slice(0, c.length_days).map(function (s) { return s || ''; }) });
    if (!r1.ok) { S.busy = false; return flash(false, errOf(r1, 'Could not save day titles')); }
    // Positions are renumbered per day so gaps from removed rows never break the unique key.
    var byDay = {};
    S.draftTasks.forEach(function (t) { (byDay[t.day_number] = byDay[t.day_number] || []).push(t); });
    var out = [];
    Object.keys(byDay).forEach(function (d) { byDay[d].sort(function (a, b) { return a.position - b.position; }).forEach(function (t, i) { out.push(Object.assign({}, t, { position: i + 1 })); }); });
    var r = await api('PUT', '/challenges/' + encodeURIComponent(c.id) + '/tasks', { tasks: out });
    S.busy = false;
    if (!r.ok) return flash(false, errOf(r, 'Could not save tasks'));
    S.sel = r.data; S.draftTasksFor = null;
    await loadList(false);
    flash(true, 'Days and tasks saved.');
  }
  async function setStatus(action) {
    var c = S.sel;
    if (action === 'publish' && !window.confirm('Publish "' + c.title + '"? Members (as allowed by the rollout flag) can join it straight away.')) return;
    if (action === 'archive' && !window.confirm('Archive "' + c.title + '"? It disappears for members; people mid-run keep going.')) return;
    var r = await api('POST', '/challenges/' + encodeURIComponent(c.id) + '/' + action);
    if (!r.ok) return flash(false, errOf(r, 'Could not ' + action));
    S.sel = Object.assign({}, S.sel, r.data, { tasks: S.sel.tasks });
    await loadList(false);
    flash(true, action === 'publish' ? 'Published.' : action === 'archive' ? 'Archived.' : 'Moved back to draft.');
  }
  async function create() {
    var body = { id: val('ncId').trim(), slug: val('ncId').trim(), title: val('ncTitle').trim(), length_days: Number(val('ncLen')), access: val('ncAccess'), rewards: { coins: 100, certificate: true } };
    S.busy = true; render();
    var r = await api('POST', '/challenges', body);
    S.busy = false;
    if (!r.ok) return flash(false, errOf(r, 'Could not create'));
    S.creating = false;
    await loadList(false);
    await loadOne(r.data.id);
    S.tab = 'tasks';
    flash(true, 'Draft created. Add the tasks for every day, then Publish.');
  }
  async function csv(id) {
    try {
      var r = await fetch(apiBase() + '/api/challenges/admin/export.csv' + (id ? '?challenge_id=' + encodeURIComponent(id) : ''), { headers: hdr(false) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var blob = await r.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'challenges-' + (id || 'all') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    } catch (e) { flash(false, 'Could not export: ' + e.message); }
  }

  var memberTimer = null;
  function onInput(e) {
    var t = e.target;
    if (!S.host || !S.host.contains(t)) return;
    if (t.hasAttribute('data-dt')) { S.draftTitles[Number(t.getAttribute('data-dt')) - 1] = t.value; return; }
    if (t.hasAttribute('data-ti')) {
      var i = Number(t.getAttribute('data-ti'));
      var task = S.draftTasks && S.draftTasks[i];
      if (!task) return;
      var f = t.getAttribute('data-f');
      var p = t.getAttribute('data-p');
      if (f === 'title') task.title = t.value;
      else if (f === 'points') task.points = t.value === '' ? 100 : Number(t.value);
      else if (f === 'kind') { task.kind = t.value; task.params = {}; render(); }
      else if (p) {
        if (t.type === 'checkbox') { if (t.checked) task.params[p] = true; else delete task.params[p]; }
        else if (t.tagName === 'SELECT') task.params[p] = t.value;
        else task.params[p] = t.value === '' ? undefined : Number(t.value);
      }
      return;
    }
    if (t.id === 'enQ') { S.enFilter.q = t.value; clearTimeout(memberTimer); memberTimer = setTimeout(loadEnrollments, 350); return; }
    if (t.id === 'memQ') {
      S.memberQ = t.value;
      clearTimeout(memberTimer);
      memberTimer = setTimeout(async function () {
        if (S.memberQ.trim().length < 2) { S.members = null; render(); return; }
        var r = await api('GET', '/members?q=' + encodeURIComponent(S.memberQ.trim()));
        S.members = r.ok ? r.data.users || [] : [];
        render();
      }, 350);
    }
  }
  function onChange(e) {
    var t = e.target;
    if (!S.host || !S.host.contains(t)) return;
    if (t.getAttribute('data-x') === 'enfilter') {
      S.enFilter.challenge_id = val('enCh'); S.enFilter.status = val('enSt');
      loadEnrollments();
      return;
    }
    if (t.hasAttribute('data-ti') && (t.tagName === 'SELECT' || t.type === 'checkbox')) onInput(e);
  }
  async function onClick(e) {
    var b = e.target.closest('[data-x]');
    if (!b || !S.host || !S.host.contains(b)) return;
    var x = b.getAttribute('data-x');
    if (x === 'enclose' && e.target !== b && b.classList.contains('bbcx-veil')) return; // clicks inside the modal
    if (x === 'view') { S.view = b.getAttribute('data-v'); S.msg = null; render(); if (S.view === 'members') loadEnrollments(); if (S.view === 'calls') loadCalls(); return; }
    if (x === 'new') { S.creating = true; S.sel = null; S.selId = null; render(); var el = document.getElementById('ncId'); if (el) el.focus(); return; }
    if (x === 'create') { create(); return; }
    if (x === 'sel') { S.creating = false; S.tab = 'details'; S.stats = null; S.msg = null; await loadOne(b.getAttribute('data-id')); render(); return; }
    if (x === 'unsel') { S.sel = null; S.selId = null; S.creating = false; render(); return; }
    if (x === 'tab') { S.tab = b.getAttribute('data-v'); render(); if (S.tab === 'stats') loadStats(S.sel.id); return; }
    if (x === 'save') { save(); return; }
    if (x === 'savetasks') { saveTasks(); return; }
    if (x === 'resettasks') { S.draftTasksFor = null; render(); return; }
    if (x === 'addtask') {
      var d = Number(b.getAttribute('data-day'));
      var n = S.draftTasks.filter(function (t) { return t.day_number === d; }).length;
      S.draftTasks.push({ day_number: d, position: n + 1, kind: 'daily_checkin', title: 'Daily check in', points: 100, params: {} });
      render(); return;
    }
    if (x === 'rmtask') { S.draftTasks.splice(Number(b.getAttribute('data-ti')), 1); render(); return; }
    if (x === 'publish' || x === 'archive' || x === 'draft') { setStatus(x); return; }
    if (x === 'csv') { csv(b.getAttribute('data-id')); return; }
    if (x === 'enview') { loadEnrollment(b.getAttribute('data-id')); return; }
    if (x === 'enclose') { S.enSel = null; render(); return; }
    if (x === 'ensync') {
      var rs = await api('POST', '/enrollments/' + encodeURIComponent(b.getAttribute('data-id')) + '/sync');
      if (!rs.ok) return flash(false, errOf(rs, 'Could not re-check'));
      await loadEnrollment(b.getAttribute('data-id')); loadEnrollments(); return;
    }
    if (x === 'envoid') {
      var reason = window.prompt('Why are you voiding this enrollment? (shown in the history; coins are not taken back automatically)');
      if (!reason) return;
      var rv = await api('POST', '/enrollments/' + encodeURIComponent(b.getAttribute('data-id')) + '/void', { reason: reason });
      if (!rv.ok) return flash(false, errOf(rv, 'Could not void'));
      S.enSel = null; flash(true, 'Voided.'); loadEnrollments(); return;
    }
    if (x === 'manual') {
      var rm = await api('POST', '/enrollments/' + encodeURIComponent(b.getAttribute('data-eid')) + '/tasks/' + encodeURIComponent(b.getAttribute('data-tid')) + '/complete');
      if (!rm.ok) return flash(false, errOf(rm, 'Could not mark done'));
      await loadEnrollment(b.getAttribute('data-eid')); return;
    }
    if (x === 'enrol') {
      var ch = val('memCh');
      if (!ch) return flash(false, 'Publish a challenge first.');
      var re = await api('POST', '/enroll', { user_id: b.getAttribute('data-uid'), challenge_id: ch });
      if (!re.ok) return flash(false, errOf(re, 'Could not enrol'));
      flash(true, re.data.created ? 'Enrolled. Day 1 starts today in their time zone.' : 'Already enrolled.');
      loadEnrollments(); return;
    }
    if (x === 'callst') { S.callStatus = b.getAttribute('data-v'); loadCalls(); return; }
    if (x === 'callset') {
      var id = b.getAttribute('data-id');
      var rc = await api('PUT', '/lm-calls/' + encodeURIComponent(id), { status: b.getAttribute('data-v'), notes: val('cn' + id) });
      if (!rc.ok) return flash(false, errOf(rc, 'Could not update'));
      await loadList(false); loadCalls(); flash(true, 'Updated.');
    }
  }
  function onKey(e) {
    if (e.key === 'Escape' && S.enSel) { S.enSel = null; render(); }
  }

  var bound = false;
  window.bbChallengesAdmin = {
    mount: function (host) {
      S.host = host;
      if (!bound) {
        bound = true;
        host.addEventListener('click', onClick);
        host.addEventListener('input', onInput);
        host.addEventListener('change', onChange);
        document.addEventListener('keydown', onKey);
      }
      render();
      loadList(true);
    }
  };
})();
