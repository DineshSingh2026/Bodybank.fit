/* ==========================================================================
   ADMIN · COACH MODE LIBRARY (window.bbCoachAdmin)
   Review queue for the Coach Mode exercise library: filter by area/status,
   side-by-side photos, edit steps / cues / mistakes / tags / logging setup,
   preview as a member, then Approve / Back to draft / Retire. Approve is gated
   by the coach checklist (docs: Coach Mode form review checklist) here and by
   the server's own rules (≥3 cues, ≥2 mistakes, ≥1 image, review note).
   Also: member care tags (recovery, kidney_gentle, …) — staff only.
   Backend: /api/coach/admin/* (routes/coachMode.js). Loaded by js/coach-loader.js.
   ========================================================================== */
(function () {
  'use strict';

  var AREAS = [['upper', 'Upper'], ['lower', 'Lower'], ['core', 'Core'], ['full', 'Full body']];
  var STATUS = [['draft', 'Draft'], ['approved', 'Approved'], ['retired', 'Retired'], ['', 'All']];
  var TAGS = [['knee', 'Knee'], ['lower_back', 'Lower back'], ['shoulder', 'Shoulder'], ['recovery', 'Recovery'], ['kidney_gentle', 'Kidney gentle'], ['pregnancy', 'Pregnancy']];
  var AI_KEYS = ['', 'squat', 'pushup', 'plank', 'jumpingjack', 'biccurl', 'shoulderpress', 'bentoverrow', 'lunge', 'calfraise', 'lateralraise', 'tricepsdip', 'frontraise'];
  var CHECKLIST = [
    ['Identity', ['Name is the common gym name clients will recognise', 'Area and equipment are right', 'Primary and secondary muscles are correct']],
    ['Photos', ['Both photos show the same exercise, correct start and end positions', 'Form in the photos is good (neutral spine, safe joint angles)', 'Clear, not cropped, no logo or text issues']],
    ['Steps and cues', ['Steps are in the right order and short (6 or fewer)', '3 to 5 cues, each simple and doable mid set', 'Depth / range of motion is correct and safe for beginners', 'Breathing cue included where it matters']],
    ['Common mistakes', ['At least 2 real mistakes clients make, with the fix']],
    ['Safety', ['Contraindication tags set (knee, lower back, shoulder, recovery, kidney gentle, pregnancy)', 'OK for recovery clients, or tagged recovery so they never see it', 'Gentle enough for kidney stone clients, or tagged kidney gentle', 'No medical claims, no prices, no supplement advice']],
    ['Logging setup', ['Unit right: reps or seconds; kg or bodyweight', 'Default sets/reps sensible; kg step right (2.5 barbell, 1 to 2 dumbbell)', 'AI trainer form check on only if the AI trainer can actually judge it']],
    ['Final', ['Previewed on a phone screen', 'Review note written (what you checked or changed)']]
  ];

  var S = { host: null, view: 'library', area: 'lower', status: 'draft', q: '', list: [], counts: null, sel: null, busy: false, msg: null, checks: {}, careQ: '', care: null, preview: false, req: 0 };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function apiBase() { return (typeof API !== 'undefined' ? API : ''); }
  async function api(method, path, body) {
    var h = { Accept: 'application/json' };
    var u = window.currentUser;
    if (u && u.token) h.Authorization = 'Bearer ' + u.token;
    if (body) h['Content-Type'] = 'application/json';
    try {
      var r = await fetch(apiBase() + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      var d = null; try { d = await r.json(); } catch (e) { d = null; }
      return { ok: r.ok, status: r.status, data: d };
    } catch (e) { return { ok: false, status: 0, data: { error: 'You are offline' } }; }
  }
  function lines(v) { return String(v || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }

  /* ------------------------------------------------------------ load */
  async function loadList() {
    var my = ++S.req;
    S.list = null; render();
    var qs = '?area=' + encodeURIComponent(S.area) + (S.status ? '&status=' + S.status : '') + (S.q ? '&q=' + encodeURIComponent(S.q) : '');
    var r = await api('GET', '/api/coach/admin/exercises' + qs);
    if (my !== S.req) return;
    if (!r.ok) { S.list = []; S.msg = { err: (r.data && r.data.error) || 'Could not load the library' }; return render(); }
    S.list = r.data.exercises || [];
    S.counts = r.data.counts;
    if (S.sel) {
      var still = S.list.filter(function (x) { return x.id === S.sel.id; })[0];
      if (still) S.sel = still;
    }
    render();
  }
  async function loadCare() {
    S.care = null; render();
    var r = await api('GET', '/api/coach/admin/care-tags' + (S.careQ.length >= 2 ? '?q=' + encodeURIComponent(S.careQ) : ''));
    S.care = r.ok ? r.data.users || [] : [];
    render();
  }

  /* ---------------------------------------------------------- render */
  function render() {
    if (!S.host) return;
    var h = '<div class="bbca"><div class="bbca-head"><div><h2>Coach Mode library</h2><p>Every exercise starts as a draft. Members only see approved ones. Target 60–80 approved per area.</p></div>' +
      '<div class="bbca-tabs" role="tablist"><button type="button" role="tab" aria-selected="' + (S.view === 'library') + '" data-a="view" data-v="library">Exercises</button>' +
      '<button type="button" role="tab" aria-selected="' + (S.view === 'care') + '" data-a="view" data-v="care">Member care tags</button></div></div>';
    if (S.msg) h += '<div class="bbca-msg ' + (S.msg.err ? 'is-err' : 'is-ok') + '" role="' + (S.msg.err ? 'alert' : 'status') + '">' + esc(S.msg.err || S.msg.ok) + '</div>';
    h += S.view === 'care' ? vCare() : vLibrary();
    h += '</div>';
    var scroller = S.host.querySelector('.bbca-editor');
    var y = scroller ? scroller.scrollTop : 0;
    var act = document.activeElement;
    var keep = act && S.host.contains(act) && act.getAttribute('data-a') && act.tagName === 'INPUT' && act.type === 'search' ? act.getAttribute('data-a') : null;
    var caret = keep ? act.selectionStart : 0;
    S.host.innerHTML = h;
    var ed = S.host.querySelector('.bbca-editor');
    if (ed && y) ed.scrollTop = y;
    if (keep) {
      var again = S.host.querySelector('input[data-a="' + keep + '"]');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
    }
  }

  function vLibrary() {
    var h = '<div class="bbca-counts">';
    AREAS.forEach(function (a) {
      var c = S.counts ? S.counts[a[0]] : null;
      var ap = c ? c.approved : 0;
      var pct = Math.min(100, Math.round(ap / 60 * 100));
      h += '<button type="button" class="bbca-count' + (S.area === a[0] ? ' is-on' : '') + '" data-a="area" data-v="' + a[0] + '" aria-pressed="' + (S.area === a[0]) + '">' +
        '<b>' + a[1] + '</b><span>' + (c ? ap + ' approved · ' + c.draft + ' draft' + (c.retired ? ' · ' + c.retired + ' retired' : '') : '…') + '</span>' +
        '<i class="bbca-bar"><i style="width:' + pct + '%"></i></i></button>';
    });
    h += '</div><div class="bbca-filters"><div class="bbca-chips" role="group" aria-label="Status">';
    STATUS.forEach(function (s) { h += '<button type="button" class="bbca-chip" data-a="status" data-v="' + s[0] + '" aria-pressed="' + (S.status === s[0]) + '">' + s[1] + '</button>'; });
    h += '</div><input type="search" class="bbca-input bbca-search" placeholder="Search name or id" value="' + esc(S.q) + '" data-a="q" aria-label="Search exercises"></div>';

    h += '<div class="bbca-grid' + (S.sel ? ' has-sel' : '') + '"><div class="bbca-list" role="list">';
    if (S.list == null) h += '<p class="bbca-dim">Loading…</p>';
    else if (!S.list.length) h += '<p class="bbca-dim">Nothing here. Run <code>node scripts/coach-seed.js</code> to load the drafts, or change the filters.</p>';
    else S.list.forEach(function (x) {
      var im = x.images && x.images[0];
      h += '<button type="button" role="listitem" class="bbca-item' + (S.sel && S.sel.id === x.id ? ' is-on' : '') + '" data-a="sel" data-v="' + esc(x.id) + '">' +
        (im ? '<img src="' + esc(im.src) + '" alt="" loading="lazy" width="56" height="40">' : '<span class="bbca-noimg"></span>') +
        '<span class="bbca-item-main"><b>' + esc(x.name) + '</b><span>' + esc(x.equipment || '') + ' · ' + esc((x.primary_muscles || []).join(', ')) + '</span></span>' +
        '<span class="bbca-st bbca-st-' + x.status + '">' + x.status + '</span></button>';
    });
    h += '</div>';
    h += S.sel ? vEditor(S.sel) : '<div class="bbca-editor bbca-empty"><p>Select an exercise to review it.</p></div>';
    h += '</div>';
    return h;
  }

  function field(label, html, hint) {
    return '<label class="bbca-field"><span>' + label + (hint ? ' <em>' + hint + '</em>' : '') + '</span>' + html + '</label>';
  }
  function counter(list, max) {
    var over = list.filter(function (s) { return s.length > max; }).length;
    return over ? '<em class="bbca-over">' + over + ' over ' + max + ' chars</em>' : '';
  }
  function vEditor(x) {
    var ck = S.checks[x.id] || {};
    var total = 0, ticked = 0;
    CHECKLIST.forEach(function (g, gi) { g[1].forEach(function (_, ii) { total++; if (ck[gi + '.' + ii]) ticked++; }); });
    var probs = x.approval_problems || [];
    var h = '<div class="bbca-editor" aria-label="Review ' + esc(x.name) + '">';
    h += '<div class="bbca-ed-top"><button type="button" class="bbca-btn is-ghost bbca-back" data-a="unsel">← List</button>' +
      '<span class="bbca-st bbca-st-' + x.status + '">' + x.status + '</span>' +
      (x.reviewed_at ? '<span class="bbca-dim">Reviewed ' + esc(new Date(x.reviewed_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</span>' : '') + '</div>';
    h += '<div class="bbca-photos">' + (x.images || []).map(function (im, i) {
      return '<figure><img src="' + esc(im.src) + '" srcset="' + esc(im.srcset || '') + '" sizes="300px" alt="' + esc(x.name) + (i ? ' end' : ' start') + '"><figcaption>' + (i + 1) + ' · ' + (i ? 'End' : 'Start') + '</figcaption></figure>';
    }).join('') + '</div>';
    h += '<p class="bbca-dim">Source: free-exercise-db · <code>' + esc(x.source_id || '') + '</code> · id <code>' + esc(x.id) + '</code></p>';

    h += '<form class="bbca-form" data-form="ex" autocomplete="off">';
    h += '<div class="bbca-row2">' + field('Name', '<input class="bbca-input" name="name" value="' + esc(x.name) + '" maxlength="80">') +
      field('Area', '<select class="bbca-input" name="area">' + AREAS.map(function (a) { return '<option value="' + a[0] + '"' + (x.area === a[0] ? ' selected' : '') + '>' + a[1] + '</option>'; }).join('') + '</select>') + '</div>';
    h += '<div class="bbca-row3">' + field('Equipment', '<input class="bbca-input" name="equipment" value="' + esc(x.equipment || '') + '">') +
      field('Level', '<select class="bbca-input" name="level">' + ['beginner', 'intermediate'].map(function (l) { return '<option' + (x.level === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select>') +
      field('Mechanic', '<select class="bbca-input" name="mechanic">' + ['compound', 'isolation'].map(function (l) { return '<option' + (x.mechanic === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select>') + '</div>';
    h += '<div class="bbca-row2">' + field('Primary muscles', '<input class="bbca-input" name="primary_muscles" value="' + esc((x.primary_muscles || []).join(', ')) + '">', 'comma separated') +
      field('Secondary muscles', '<input class="bbca-input" name="secondary_muscles" value="' + esc((x.secondary_muscles || []).join(', ')) + '">') + '</div>';
    h += field('Steps', '<textarea class="bbca-input" name="steps" rows="6">' + esc((x.steps || []).join('\n')) + '</textarea>', 'one per line · max 6 · ≤110 chars ' + counter(x.steps || [], 110));
    h += field('Posture checkpoints (cues)', '<textarea class="bbca-input" name="cues" rows="5">' + esc((x.cues || []).join('\n')) + '</textarea>', 'one per line · 3–5 · ≤60 chars ' + counter(x.cues || [], 60));
    h += '<fieldset class="bbca-fs"><legend>Common mistakes <em>mistake → fix · ≤90 chars each</em></legend>';
    var ms = (x.common_mistakes || []).slice();
    while (ms.length < 4) ms.push({ mistake: '', fix: '' });
    ms.slice(0, 5).forEach(function (m, i) {
      h += '<div class="bbca-row2"><input class="bbca-input" name="mk_' + i + '" value="' + esc(m.mistake || '') + '" placeholder="Mistake ' + (i + 1) + '" aria-label="Mistake ' + (i + 1) + '" maxlength="90">' +
        '<input class="bbca-input" name="fx_' + i + '" value="' + esc(m.fix || '') + '" placeholder="Fix" aria-label="Fix ' + (i + 1) + '" maxlength="90"></div>';
    });
    h += '</fieldset>';
    h += '<fieldset class="bbca-fs"><legend>Contraindication tags <em>tag = needs caution for that group · recovery and pregnancy hide the move for tagged members</em></legend><div class="bbca-tags">';
    TAGS.forEach(function (t) {
      h += '<label class="bbca-tag"><input type="checkbox" name="tag" value="' + t[0] + '"' + ((x.contraindications || []).indexOf(t[0]) >= 0 ? ' checked' : '') + '> ' + t[1] + '</label>';
    });
    h += '</div></fieldset>';
    h += '<fieldset class="bbca-fs"><legend>Logging setup</legend><div class="bbca-row3">' +
      field('Unit', '<select class="bbca-input" name="unit"><option value="reps"' + (x.unit === 'reps' ? ' selected' : '') + '>reps</option><option value="seconds"' + (x.unit === 'seconds' ? ' selected' : '') + '>seconds</option></select>') +
      field('Load', '<select class="bbca-input" name="load_type"><option value="kg"' + (x.load_type === 'kg' ? ' selected' : '') + '>kg</option><option value="bodyweight"' + (x.load_type === 'bodyweight' ? ' selected' : '') + '>bodyweight</option></select>') +
      field('kg step', '<input class="bbca-input" name="load_step_kg" type="number" step="0.25" min="0" max="20" value="' + esc(x.load_step_kg) + '">') + '</div><div class="bbca-row3">' +
      field('Default sets', '<input class="bbca-input" name="default_sets" type="number" min="1" max="10" value="' + esc(x.default_sets) + '">') +
      field(x.unit === 'seconds' ? 'Default seconds' : 'Default reps', '<input class="bbca-input" name="default_reps" type="number" min="1" max="3600" value="' + esc(x.default_reps) + '">') +
      field('Sort order', '<input class="bbca-input" name="sort_order" type="number" min="0" value="' + esc(x.sort_order) + '">') + '</div>' +
      '<label class="bbca-tag"><input type="checkbox" name="per_side"' + (x.per_side ? ' checked' : '') + '> Reps counted per side (each leg / arm)</label>' +
      '<div class="bbca-row2" style="margin-top:8px"><label class="bbca-tag"><input type="checkbox" name="ai_form_check"' + (x.ai_form_check ? ' checked' : '') + '> Show "Check my form with AI trainer"</label>' +
      field('AI Trainer move', '<select class="bbca-input" name="ai_trainer_key">' + AI_KEYS.map(function (k) { return '<option value="' + k + '"' + ((x.ai_trainer_key || '') === k ? ' selected' : '') + '>' + (k || '— none —') + '</option>'; }).join('') + '</select>') + '</div></fieldset>';
    h += field('Review note', '<textarea class="bbca-input" name="review_notes" rows="2" placeholder="What you checked or changed">' + esc(x.review_notes || '') + '</textarea>', 'required to approve');
    h += '</form>';

    h += '<details class="bbca-check"' + (x.status === 'draft' ? ' open' : '') + '><summary>Form review checklist · ' + ticked + '/' + total + '</summary>';
    CHECKLIST.forEach(function (g, gi) {
      h += '<div class="bbca-check-g"><b>' + g[0] + '</b>';
      g[1].forEach(function (t, ii) {
        var k = gi + '.' + ii;
        h += '<label><input type="checkbox" data-a="check" data-v="' + k + '"' + (ck[k] ? ' checked' : '') + '> ' + esc(t) + '</label>';
      });
      h += '</div>';
    });
    h += '<p class="bbca-dim">Anything unsure → leave it as draft with a note.</p></details>';

    if (probs.length) h += '<div class="bbca-msg is-err">Before approving: ' + esc(probs.join(' · ')) + '</div>';
    h += '<div class="bbca-actions">' +
      '<button type="button" class="bbca-btn" data-a="save"' + (S.busy ? ' disabled' : '') + '>Save changes</button>' +
      '<button type="button" class="bbca-btn" data-a="preview">' + (S.preview ? 'Hide preview' : 'Preview as member') + '</button>' +
      (x.status !== 'approved' ? '<button type="button" class="bbca-btn is-gold" data-a="approve"' + (S.busy || ticked < total ? ' disabled title="Tick every checklist item first"' : '') + '>Approve</button>' : '') +
      (x.status !== 'draft' ? '<button type="button" class="bbca-btn" data-a="draft"' + (S.busy ? ' disabled' : '') + '>Back to draft</button>' : '') +
      (x.status !== 'retired' ? '<button type="button" class="bbca-btn is-danger" data-a="retire"' + (S.busy ? ' disabled' : '') + '>Retire</button>' : '') +
      '</div>';
    if (S.preview) h += vPreview(x);
    return h + '</div>';
  }

  // Member view of the form guide, drawn with the member stylesheet at phone width.
  function vPreview(x) {
    var meta = [x.mechanic, x.force, x.equipment === 'body only' ? 'bodyweight' : x.equipment, x.level].filter(Boolean).map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); });
    var h = '<div class="bbca-phone"><div class="bbcm" style="padding:10px 0 16px;min-height:0;border-radius:28px"><div class="bbcm-screen">' +
      '<div class="bbcm-top"><span class="bbcm-icon-btn" aria-hidden="true">‹</span><div class="bbcm-top-title">Form guide</div><span style="width:44px"></span></div>' +
      '<h2 class="bbcm-h2">' + esc(x.name) + '</h2><div class="bbcm-sub">' + esc(meta.join(' · ')) + '</div><div class="bbcm-photos">' +
      (x.images || []).slice(0, 2).map(function (im, i) { return '<figure class="bbcm-photo"><img src="' + esc(im.src) + '" alt=""><figcaption>' + (i + 1) + ' · ' + (i ? 'End' : 'Start') + '</figcaption></figure>'; }).join('') + '</div>' +
      '<div class="bbcm-card"><div class="bbcm-sec-title">Posture checkpoints</div><ol class="bbcm-cues">' +
      (x.cues || []).map(function (c, i) { return '<li><span class="bbcm-num">' + (i + 1) + '</span><span>' + esc(c) + '</span></li>'; }).join('') + '</ol></div>' +
      '<div class="bbcm-card"><div class="bbcm-sec-title">Common mistakes</div><ul class="bbcm-mistakes">' +
      (x.common_mistakes || []).map(function (m) { return '<li><span class="bbcm-x">✕</span><span>' + esc(m.mistake) + (m.fix ? '<span class="bbcm-fix">' + esc(m.fix) + '</span>' : '') + '</span></li>'; }).join('') + '</ul></div>' +
      '<div class="bbcm-card"><div class="bbcm-sec-title">Step by step</div><ol class="bbcm-steps">' + (x.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' +
      (x.ai_form_check && x.ai_trainer_key ? '<button type="button" class="bbcm-cta" tabindex="-1">📹 Check my form with AI trainer</button>' : '') +
      '</div></div></div>';
    return h;
  }

  function vCare() {
    var h = '<div class="bbca-care"><p class="bbca-dim">Care tags tailor Coach Mode for a member. <b>Recovery</b> and <b>Pregnancy</b> hide every exercise carrying that tag; <b>Kidney gentle</b>, <b>Knee</b>, <b>Lower back</b> and <b>Shoulder</b> show a soft "go lighter" note. Only staff can set them.</p>' +
      '<input type="search" class="bbca-input bbca-search" placeholder="Search member by name or email (blank = everyone with tags)" value="' + esc(S.careQ) + '" data-a="careq" aria-label="Search members">';
    if (S.care == null) h += '<p class="bbca-dim">Loading…</p>';
    else if (!S.care.length) h += '<p class="bbca-dim">' + (S.careQ.length >= 2 ? 'No members match.' : 'No member has care tags yet. Search to add some.') + '</p>';
    else S.care.forEach(function (u) {
      h += '<div class="bbca-care-row" data-uid="' + esc(u.id) + '"><div><b>' + esc(((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.email) + '</b><span>' + esc(u.email || '') + '</span></div><div class="bbca-tags">';
      TAGS.forEach(function (t) { h += '<label class="bbca-tag"><input type="checkbox" value="' + t[0] + '"' + ((u.coach_care_tags || []).indexOf(t[0]) >= 0 ? ' checked' : '') + '> ' + t[1] + '</label>'; });
      h += '</div><button type="button" class="bbca-btn" data-a="savecare" data-v="' + esc(u.id) + '">Save</button></div>';
    });
    return h + '</div>';
  }

  /* ---------------------------------------------------------- actions */
  function collect() {
    var f = S.host.querySelector('[data-form="ex"]');
    if (!f) return null;
    var g = function (n) { var el = f.elements[n]; return el ? el.value : ''; };
    var mistakes = [];
    for (var i = 0; i < 5; i++) {
      var m = f.elements['mk_' + i], x = f.elements['fx_' + i];
      if (m && m.value.trim()) mistakes.push({ mistake: m.value.trim(), fix: x ? x.value.trim() : '' });
    }
    var tags = Array.prototype.filter.call(f.querySelectorAll('input[name="tag"]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
    return {
      name: g('name').trim(), area: g('area'), equipment: g('equipment').trim(), level: g('level'), mechanic: g('mechanic'),
      primary_muscles: g('primary_muscles').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      secondary_muscles: g('secondary_muscles').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      steps: lines(g('steps')), cues: lines(g('cues')), common_mistakes: mistakes, contraindications: tags,
      unit: g('unit'), load_type: g('load_type'), load_step_kg: Number(g('load_step_kg')), default_sets: Number(g('default_sets')),
      default_reps: Number(g('default_reps')), sort_order: Number(g('sort_order')), per_side: f.elements.per_side.checked,
      ai_form_check: f.elements.ai_form_check.checked, ai_trainer_key: g('ai_trainer_key') || null, review_notes: g('review_notes').trim()
    };
  }
  function errText(r, fb) {
    var d = r.data || {};
    var parts = d.errors && typeof d.errors === 'object' ? Object.keys(d.errors).map(function (k) { var v = d.errors[k]; return k + ': ' + (Array.isArray(v) ? v.join(', ') : v); }) : [];
    return (d.error || fb) + (parts.length && !/Cannot approve/.test(d.error || '') ? ' (' + parts.join('; ') + ')' : '');
  }
  async function save(silent) {
    var body = collect();
    if (!body || !S.sel) return false;
    S.busy = true; render();
    var r = await api('PUT', '/api/coach/admin/exercises/' + encodeURIComponent(S.sel.id), body);
    S.busy = false;
    if (!r.ok) { S.msg = { err: errText(r, 'Could not save') }; render(); return false; }
    S.sel = r.data;
    if (!silent) S.msg = { ok: 'Saved ' + r.data.name };
    render();
    return true;
  }
  async function setStatus(st) {
    if (!S.sel) return;
    if (!(await save(true))) return;
    S.busy = true; render();
    var r = await api('POST', '/api/coach/admin/exercises/' + encodeURIComponent(S.sel.id) + '/' + st, { review_notes: S.sel.review_notes });
    S.busy = false;
    if (!r.ok) { S.msg = { err: errText(r, 'Could not update') }; render(); return; }
    S.msg = { ok: r.data.name + ' → ' + r.data.status };
    var idx = -1;
    S.list.forEach(function (x, i) { if (x.id === r.data.id) idx = i; });
    // Move on to the next item in the queue after an approval.
    var next = st === 'approved' && S.status === 'draft' ? S.list[idx + 1] : null;
    S.sel = next || r.data;
    S.preview = false;
    await loadList();
  }

  function onClick(e) {
    var a = e.target.closest('[data-a]');
    if (!a || a.disabled) return;
    var k = a.getAttribute('data-a'), v = a.getAttribute('data-v');
    if (k === 'q' || k === 'careq') return;
    if (k === 'check') {
      if (!S.sel) return;
      S.checks[S.sel.id] = S.checks[S.sel.id] || {};
      S.checks[S.sel.id][v] = a.checked;
      // Update the counter + Approve button without losing form edits.
      var body = collect();
      if (body) Object.assign(S.sel, body);
      return render();
    }
    if (k === 'view') { S.view = v; S.msg = null; if (v === 'care' && S.care == null) loadCare(); return render(); }
    if (k === 'area') { S.area = v; S.sel = null; S.msg = null; return loadList(); }
    if (k === 'status') { S.status = v; S.sel = null; S.msg = null; return loadList(); }
    if (k === 'sel') { S.sel = S.list.filter(function (x) { return x.id === v; })[0] || null; S.msg = null; S.preview = false; render(); var ed = S.host.querySelector('.bbca-editor'); if (ed) ed.scrollTop = 0; return; }
    if (k === 'unsel') { S.sel = null; return render(); }
    if (k === 'save') return save(false);
    if (k === 'preview') { var b = collect(); if (b) Object.assign(S.sel, b); S.preview = !S.preview; return render(); }
    if (k === 'approve') return setStatus('approve');
    if (k === 'draft') return setStatus('draft');
    if (k === 'retire') { if (window.confirm('Retire ' + S.sel.name + '? Members stop seeing it; logged history stays.')) setStatus('retire'); return; }
    if (k === 'savecare') {
      var row = a.closest('.bbca-care-row');
      var tags = Array.prototype.filter.call(row.querySelectorAll('input[type="checkbox"]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
      a.disabled = true;
      api('PUT', '/api/coach/admin/care-tags/' + encodeURIComponent(v), { tags: tags }).then(function (r) {
        a.disabled = false;
        S.msg = r.ok ? { ok: 'Care tags saved' } : { err: errText(r, 'Could not save care tags') };
        render();
      });
    }
  }
  var qTimer = null;
  function onInput(e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-a');
    if (k === 'q') { clearTimeout(qTimer); var val = e.target.value; qTimer = setTimeout(function () { S.q = val.trim(); loadList(); }, 300); }
    if (k === 'careq') { clearTimeout(qTimer); var cv = e.target.value; qTimer = setTimeout(function () { S.careQ = cv.trim(); loadCare(); }, 300); }
  }

  window.bbCoachAdmin = {
    mount: function (host) {
      if (S.host !== host) {
        S.host = host;
        host.addEventListener('click', onClick);
        host.addEventListener('input', onInput);
      }
      S.msg = null;
      render();
      loadList();
    }
  };
})();
