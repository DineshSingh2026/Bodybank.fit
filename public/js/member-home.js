/* ============================================================================
   BodyBank — Member home
   ----------------------------------------------------------------------------
   The member's landing answers three questions in order, and nothing else:

     1. How am I doing?          — streak, week, today's numbers
     2. What should I do now?    — the daily loop, with what is already done
                                   marked done, so it never asks twice
     3. Where do I put things?   — one upload panel for a blood report and a
                                   Whoop export, both wired to the real endpoints

   Everything the old home carried still sits below this, untouched: scorecard,
   readiness, programs, charts and the explore cards. This is the layer
   that tells you where to go, not a replacement for what is there.

   Depends on globals from index.html: apiCall, escapeHtml, switchUserTab,
   showPopup, and (optionally) showCheckinSubView.
   ========================================================================== */

var mhState = window.mhState || (window.mhState = { data: null, loading: false, busy: '' });

function mhEl(id) { return document.getElementById(id); }
function mhEsc(v) { return escapeHtml(v == null ? '' : String(v)); }
function mhNum(n) { return Number(n || 0).toLocaleString(); }
function mhPlural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function mhGreeting() {
  var h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function mhDay(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
// Home has to reach tabs and, for check-in, a sub-view inside one.
/* ---- the day, as one instrument ------------------------------------------
   This used to be one full-height card per task, each with its own gold
   button. Four equal shouts, no sense of progress, and half a screen of
   scroll. Now: a rail that shows how far through the day you are, the ONE
   thing to do next given real weight, the remaining steps as one-line rows,
   and finished ones collapsed to a ledger that keeps the numbers you logged.
   Priority is visible, and the whole loop fits on a phone screen. */

function mhGoAttr(s) {
  return 'mhGo(&quot;' + s.tab + '&quot;' + (s.sub2 ? ',&quot;' + s.sub2 + '&quot;' : '') + ')';
}

function mhLoopCard(steps) {
  var done = steps.filter(function (s) { return s.done; });
  var open = steps.filter(function (s) { return !s.done; });
  // Never lead with something that is not actually due yet (the Sunday review
  // on a Tuesday) — it would send the member to a screen with nothing to do.
  // Which means "nothing due" is the finished state even while a soft step is
  // still on the list. `all` has to be read off `next`, not off `open`: tick
  // the last real task on a Tuesday and `open` still holds the weekly review,
  // so the old test said "not done" and then dereferenced a null `next`.
  var due = open.filter(function (s) { return !s.soft; });
  var next = due[0] || null;
  var rest = open.filter(function (s) { return s !== next; });
  var all = !next;

  // The rail measures the day, so it counts what the day actually asks for. A
  // Sunday review pending on a Tuesday is not a missing pip.
  var core = steps.filter(function (s) { return !s.soft; });
  var coreDone = core.filter(function (s) { return s.done; });
  var rail = '<div class="mh-rail" role="img" aria-label="' + coreDone.length + ' of ' + core.length
    + ' done today">' + core.map(function (s) {
      return '<i class="' + (s.done ? 'on' : '') + '"></i>';
    }).join('') + '</div>';

  var head = all
    ? '<div class="mh-alldone">'
      + '<span class="mh-alldone-ring" aria-hidden="true">✓</span>'
      + '<div class="mh-alldone-t"><b>Today is complete.</b>'
      + '<span>' + (rest.length
        ? 'Nothing else is due today — what is left below can wait for its day.'
        : 'Every box ticked. Rest up — the streak does the rest.') + '</span></div></div>'
    : '<div class="mh-next">'
      + '<span class="mh-next-ico" aria-hidden="true">' + next.icon + '</span>'
      + '<div class="mh-next-main">'
      + '<span class="mh-kicker">Do this next</span>'
      + '<div class="mh-next-title">' + mhEsc(next.title) + '</div>'
      + '<div class="mh-next-sub">' + mhEsc(next.sub) + '</div>'
      + '</div>'
      + '<button type="button" class="mh-next-cta" onclick="' + mhGoAttr(next) + '">'
      + mhEsc(next.cta) + '<em aria-hidden="true">\u2192</em></button>'
      + '</div>';

  var rows = rest.length
    ? '<div class="mh-rows">' + rest.map(function (s) {
        return '<button type="button" class="mh-row' + (s.soft ? ' soft' : '') + '" onclick="'
          + mhGoAttr(s) + '">'
          + '<span class="mh-row-ico" aria-hidden="true">' + s.icon + '</span>'
          + '<span class="mh-row-t">' + mhEsc(s.title) + '</span>'
          + '<span class="mh-row-note">' + mhEsc(s.sub) + '</span>'
          + '<span class="mh-row-go" aria-hidden="true">›</span>'
          + '</button>';
      }).join('') + '</div>'
    : '';

  var ledger = done.length
    ? '<div class="mh-ledger">' + done.map(function (s) {
        return '<button type="button" class="mh-led" onclick="' + mhGoAttr(s) + '">'
          + '<span class="mh-led-tick" aria-hidden="true">✓</span>'
          + '<span class="mh-led-t">' + mhEsc(s.doneTitle) + '</span>'
          + '<span class="mh-led-v">' + mhEsc(s.doneSub) + '</span>'
          + '</button>';
      }).join('') + '</div>'
    : '';

  return '<div class="mh-day-card' + (all ? ' is-done' : '') + '">' + rail + head + rows + ledger + '</div>';
}

function mhGo(tab, sub) {
  try {
    if (typeof switchUserTab === 'function') switchUserTab(tab);
    if (sub && typeof showCheckinSubView === 'function') setTimeout(function () { showCheckinSubView(sub); }, 240);
  } catch (e) { }
  return false;
}

async function loadMemberHome(silent) {
  if (!mhEl('memberHome')) return;
  if (mhState.loading) return;
  mhState.loading = true;
  var btn = mhEl('mhRefresh');
  if (btn) btn.classList.add('is-busy');
  try {
    var d;
    // The fetch and the draw get their own catch. They used to share one, so a
    // TypeError in the render told the member "Could not reach the server" —
    // pointing at the network while the real fault was three lines of markup.
    try {
      d = await apiCall('GET', '/api/member/home');
    } catch (netErr) {
      var h2 = mhEl('mhLoop');
      if (h2 && !silent) h2.innerHTML = '<div class="mh-empty">Could not reach the server. Pull to refresh.</div>';
      return;
    }
    if (!d || d.error) {
      if (!silent) {
        var host = mhEl('mhLoop');
        if (host) host.innerHTML = '<div class="mh-empty">' + mhEsc((d && d.error) || 'Could not load your home.') + '</div>';
      }
      return;
    }
    mhState.data = d;
    try {
      renderMemberHome();
    } catch (renderErr) {
      console.error('[member home] render failed', renderErr);
      var h3 = mhEl('mhLoop');
      if (h3) h3.innerHTML = '<div class="mh-empty">Your day could not be drawn. Pull to refresh.</div>';
    }
  } finally {
    mhState.loading = false;
    setTimeout(function () { if (btn) btn.classList.remove('is-busy'); }, 600);
  }
}

/* ---------------------------------------------------------------- render */
function renderMemberHome() {
  var d = mhState.data;
  if (!d || !mhEl('memberHome')) return;
  var u = d.user || {}, t = d.today || {}, w = d.whoop || {}, b = d.blood || {};

  // ---- who and when -------------------------------------------------------
  var name = String(u.first_name || '').trim();
  var greetEl = mhEl('mhGreet');
  if (greetEl) greetEl.textContent = mhGreeting() + (name ? ', ' + name : '');
  var dateEl = mhEl('mhDate');
  if (dateEl) {
    try { dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { }
  }
  var av = mhEl('mhAvatar');
  if (av) {
    if (u.profile_picture) { av.innerHTML = '<img src="' + mhEsc(u.profile_picture) + '" alt="">'; }
    else {
      var ini = ((String(u.first_name || '')[0] || '') + (String(u.last_name || '')[0] || '')).toUpperCase();
      av.textContent = ini || 'B';
    }
  }

  // ---- the daily loop, with what is done already marked done ---------------
  var steps = [
    {
      key: 'checkin', done: !!t.checked_in, icon: '✅',
      title: 'Daily check-in', doneTitle: 'Checked in today',
      sub: 'Steps, water, protein and sleep — takes a minute',
      doneSub: [t.steps ? mhNum(t.steps) + ' steps' : '', t.protein_g ? t.protein_g + 'g protein' : '',
        t.sleep_hours ? t.sleep_hours + 'h sleep' : ''].filter(Boolean).join(' · ') || 'Logged',
      cta: 'Check in now', tab: 'checkin', sub2: 'daily'
    },
    {
      key: 'workout', done: !!t.workout_logged, icon: '🏋️',
      title: 'Log your workout', doneTitle: 'Workout logged',
      sub: 'Record the session while it is fresh',
      doneSub: 'Nice work — that is today done',
      cta: 'Log workout', tab: 'workout'
    },
    {
      key: 'meal', done: (t.meals_logged || 0) > 0, icon: '🥗',
      title: 'Log a meal', doneTitle: mhPlural(t.meals_logged || 0, 'meal') + ' logged',
      sub: 'Photograph it and the AI does the macros',
      doneSub: 'Keep going through the day',
      cta: 'Log a meal', tab: 'checkin', sub2: 'nutrition'
    }
  ];
  // The Sunday review only belongs on the list when it is actually due.
  if (t.is_sunday || !t.sunday_done) {
    steps.push({
      key: 'sunday', done: !!t.sunday_done, icon: '📆',
      title: 'Weekly check-in', doneTitle: 'Weekly check-in done',
      sub: t.is_sunday ? 'Due today — how did the week go?' : 'Due on Sunday',
      doneSub: 'Submitted for this week',
      cta: 'Open weekly check-in', tab: 'checkin', sub2: 'sunday', soft: !t.is_sunday
    });
  }

  // Count only what is due TODAY, the same set the card's rail draws, or the
  // header reads "3 of 4 done" while the card says the day is complete.
  var core = steps.filter(function (s) { return !s.soft; });
  var due = core.filter(function (s) { return !s.done; });
  var loopEl = mhEl('mhLoop');
  if (loopEl) loopEl.innerHTML = mhLoopCard(steps);
  var lc = mhEl('mhLoopCount');
  if (lc) lc.textContent = (core.length - due.length) + ' of ' + core.length + ' done';
  var lineEl = mhEl('mhLine');
  if (lineEl) {
    lineEl.innerHTML = due.length
      ? 'You have <b>' + due.length + '</b> ' + (due.length === 1 ? 'thing' : 'things') + ' left today.'
      : '<b>Everything is done today.</b> Rest up — consistency is the whole game.';
  }

  // ---- streak and the week ------------------------------------------------
  var streak = d.streak || 0;
  mhEl('mhStreak') && (mhEl('mhStreak').textContent = streak);
  mhEl('mhStreakL') && (mhEl('mhStreakL').textContent = streak === 1 ? 'day streak' : 'day streak');
  // The strip reads Sunday -> Saturday, the way a calendar does. It used to be a
  // rolling seven days ending today, which meant the row started on a different
  // letter every morning and no one could read it at a glance. The server still
  // sends `week` as seven flags oldest -> newest ending today, so each calendar
  // day is looked up by how many days back it is.
  var strip = mhEl('mhWeek');
  if (strip) {
    var wk = String(d.week || '0000000');
    var noon = new Date(); noon.setHours(12, 0, 0, 0);   // noon anchor survives DST
    var sunday = new Date(noon.getTime() - noon.getDay() * 86400000);
    var out = '';
    for (var i = 0; i < 7; i++) {
      var dt = new Date(sunday.getTime() + i * 86400000);
      var back = Math.round((noon - dt) / 86400000);     // 0 = today, 6 = six days ago
      var ahead = back < 0;                              // rest of the week, not yet due
      var on = !ahead && wk.charAt(6 - back) === '1';
      var lbl = dt.toLocaleDateString(undefined, { weekday: 'narrow' });
      out += '<span class="mh-day' + (on ? ' on' : '') + (back === 0 ? ' today' : '')
        + (ahead ? ' ahead' : '') + '"'
        + ' title="' + mhEsc(dt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
          + (ahead ? '' : (on ? ' — checked in' : ' — no check-in'))) + '">'
        + '<i>' + mhEsc(lbl) + '</i></span>';
    }
    strip.innerHTML = out;
  }

  // ---- today's numbers against the member's own goals ---------------------
  var goals = mhEl('mhGoals');
  if (goals) {
    var rows = [
      { l: 'Steps', v: t.steps, g: u.goal_steps, unit: '' },
      { l: 'Water', v: t.water_ml || null, g: u.goal_water_ml, unit: 'ml' },
      { l: 'Protein', v: t.protein_g, g: u.goal_protein_g, unit: 'g' },
      { l: 'Sleep', v: t.sleep_hours, g: u.goal_sleep_hours, unit: 'h' }
    ];
    goals.innerHTML = rows.map(function (r) {
      var have = r.v != null && r.v !== '';
      var pct = (have && r.g) ? Math.min(100, Math.round((Number(r.v) / Number(r.g)) * 100)) : 0;
      var tone = pct >= 100 ? 'ok' : (pct >= 50 ? 'warn' : 'low');
      return '<div class="mh-goal">'
        + '<div class="mh-goal-top"><span>' + mhEsc(r.l) + '</span>'
        + '<b>' + (have ? mhNum(r.v) + r.unit : '—') + (r.g ? '<i>/' + mhNum(r.g) + r.unit + '</i>' : '') + '</b></div>'
        + '<div class="mh-goal-track"><span class="mh-goal-fill ' + tone + '" style="width:' + pct + '%"></span></div>'
        + '</div>';
    }).join('');
  }

  // ---- the upload panel ---------------------------------------------------
  var used = b.slots_used || 0, total = b.slots_total || 3;
  var bloodEl = mhEl('mhBloodState');
  if (bloodEl) {
    var latest = (b.reports || [])[0];
    var processing = (b.reports || []).filter(function (r) { return String(r.status || '') !== 'complete'; }).length;
    bloodEl.innerHTML = used
      ? '<span class="mh-tag ok">' + used + ' of ' + total + ' slots used</span>'
        + (processing ? '<span class="mh-tag warn">' + processing + ' analysing</span>' : '')
        + (latest ? '<span class="mh-tag">latest ' + mhEsc(mhDay(latest.report_date || latest.created_at)) + '</span>' : '')
      : '<span class="mh-tag warn">No report yet</span><span class="mh-tag">' + total + ' free slots</span>';
  }
  var bBtn = mhEl('mhBloodBtn');
  if (bBtn) {
    var full = used >= total;
    bBtn.disabled = full;
    bBtn.textContent = full ? 'All ' + total + ' slots used' : (used ? 'Upload another report' : 'Upload blood report');
  }
  var wEl = mhEl('mhWhoopState');
  if (wEl) {
    wEl.innerHTML = w.connected
      ? '<span class="mh-tag ok">' + mhPlural(w.days || 0, 'day') + ' of data</span>'
        + (w.last_sync ? '<span class="mh-tag">to ' + mhEsc(mhDay(w.last_sync)) + '</span>' : '')
      : '<span class="mh-tag warn">Not connected</span><span class="mh-tag">Upload your export</span>';
  }

  // ---- what else is waiting ----------------------------------------------
  var nav = mhEl('mhNav');
  if (nav) {
    var item = function (icon, label, sub, tab, badge) {
      return '<button type="button" class="mh-navtile" onclick="mhGo(\'' + tab + '\')">'
        + (badge ? '<span class="mh-navbadge">' + badge + '</span>' : '')
        + '<span class="mh-navico" aria-hidden="true">' + icon + '</span>'
        + '<span class="mh-navmain"><b>' + mhEsc(label) + '</b><i>' + mhEsc(sub) + '</i></span></button>';
    };
    nav.innerHTML =
      item('💬', 'Messages', d.unread_messages ? mhPlural(d.unread_messages, 'new reply', 'new replies') : 'Talk to your coach', 'messages', d.unread_messages || 0)
      + item('📋', 'My Programs', d.programs ? mhPlural(d.programs, 'program') : 'Your training plans', 'programs')
      + item('🏋️', 'My Workout', 'Log and review sessions', 'workout')
      + item('📸', 'My Body', 'Photos and measurements', 'body')
      + item('💪', 'Muscle Ranking', 'See where you stand', 'muscle')
      + item('🖼️', 'Elite Feed', 'The tribe', 'elitefeed')
      + item('👤', 'My Profile', 'Goals and details', 'profile')
      + item('✉️', 'Contact Us', 'We are here to help', 'contact')
      + '<button type="button" class="mh-navtile" onclick="mhOpenNutritionAssessment()">'
        + '<span class="mh-navico" aria-hidden="true">🥗</span>'
        + '<span class="mh-navmain"><b>Nutrition Assessment</b><i>Your FitChef plan starts here</i></span></button>';
  }
}

/* ---- FitChef nutrition assessment ----------------------------------------
   A one-off, not a daily task, so it never joins the day's loop and never
   costs a pip on the rail. It sits in the uploads block and states plainly
   where the member got to, because a 10-step form abandoned at step 4 is only
   resumable if the home screen says so. */

/**
 * Open the assessment at the part the member should actually be on. The server
 * works this out too; passing it explicitly means the tile and the form can
 * never disagree about which part is opening.
 */
function mhOpenNutritionAssessment(part) {
  var p = Number(part) === 2 ? 2 : 0;
  window.location.href = 'nutrition-assessment.html' + (p ? '?part=2' : '');
}

async function mhLoadNutritionAssessment() {
  var state = mhEl('mhNaState');
  var btn = mhEl('mhNaBtn');
  var hint = mhEl('mhNaHint');
  if (!state || !btn) return;
  var d;
  try { d = await apiCall('GET', '/api/nutrition-assessment/mine'); }
  catch (e) { d = null; }
  if (!d || d.error) {
    state.innerHTML = '';
    hint.textContent = 'About 5 minutes \u2014 we fill in everything we already know.';
    return;
  }
  // Both parts in.
  if (d.status === 'complete' || d.part2_done) {
    state.innerHTML = '<span class="mh-tag ok">Both parts submitted</span>';
    btn.textContent = 'View what you sent';
    btn.onclick = function () { mhOpenNutritionAssessment(); };
    hint.textContent = 'Your report is being built. We will message you when it is ready.';
    return;
  }
  // Part 1 in, Part 2 outstanding. The member can start it themselves rather than
  // waiting on the link — that is the point of surfacing it here.
  if (d.status === 'part1_complete' || (d.part1_done && !d.part2_done)) {
    state.innerHTML = '<span class="mh-tag ok">Part 1 submitted</span>'
      + '<span class="mh-tag warn">Part 2 to go</span>';
    btn.textContent = 'Continue with Part 2';
    btn.onclick = function () { mhOpenNutritionAssessment(2); };
    hint.textContent = 'Part 1 gave us your targets. Part 2 adds how you train, eat and cook.';
    return;
  }
  if (d.status === 'in_progress') {
    var partN = Number(d.part) || 1;
    state.innerHTML = '<span class="mh-tag warn">Part ' + partN + ' · step ' + d.last_step + ' of ' + d.total_steps + '</span>'
      + (d.step_title ? '<span class="mh-tag">' + mhEsc(d.step_title) + '</span>' : '');
    btn.textContent = 'Pick up where you left off';
    btn.onclick = function () { mhOpenNutritionAssessment(partN); };
    hint.textContent = 'Everything you have typed is saved.';
    return;
  }
  state.innerHTML = '<span class="mh-tag warn">Not started</span>';
  btn.textContent = 'Start Part 1';
  btn.onclick = function () { mhOpenNutritionAssessment(); };
  hint.textContent = 'Part 1 takes about 3-4 minutes \u2014 your profile, check-ins and blood report are already filled in for you to confirm. Part 2 comes later.';
}

/* ------------------------------------------------------------- uploads --- */
function mhPickBlood() {
  var inp = mhEl('mhBloodFile');
  if (inp) { inp.value = ''; inp.click(); }
}
function mhPickWhoop() {
  // Prefer the full device flow: it asks WHICH watch this is before reading the
  // file, and it shows the member every extracted number before anything is
  // saved. That review step matters most for the members this card used to serve
  // worst — anyone on a band with no export, whose figures are read off a
  // screenshot by AI and must be confirmed rather than trusted.
  if (typeof window !== 'undefined' && typeof window.bbOpenWhoop === 'function') {
    window.bbOpenWhoop();
    return;
  }
  // Fallback for any page that does not carry the modal: the original Whoop-only
  // path, which still works.
  var inp = mhEl('mhWhoopFile');
  if (inp) { inp.value = ''; inp.click(); }
}
function mhSay(host, tone, html) {
  var el = mhEl(host);
  if (!el) return;
  el.className = 'mh-say ' + (tone || '');
  el.innerHTML = html;
  el.style.display = 'block';
}
function mhReadBase64(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () {
      var s = String(r.result || ''); var i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = function () { reject(new Error('Could not read that file')); };
    r.readAsDataURL(file);
  });
}

async function mhBloodPicked(ev) {
  var f = ev.target && ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  if (mhState.busy) return;
  mhState.busy = 'blood';
  var btn = mhEl('mhBloodBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  mhSay('mhBloodSay', '', 'Reading <b>' + mhEsc(f.name) + '</b>…');
  try {
    var b64 = await mhReadBase64(f);
    mhSay('mhBloodSay', '', 'Uploading and analysing — this can take a minute. You can keep using the app.');
    var res = await apiCall('POST', '/api/blood/upload', {
      bloodReportBase64: b64, bloodReportMimeType: f.type || 'application/pdf', symptoms: []
    });
    if (!res || res.error || res.success === false) {
      mhSay('mhBloodSay', 'bad', mhEsc((res && (res.error || res.message)) || 'Upload failed. Please try again.'));
    } else {
      mhSay('mhBloodSay', 'ok', 'Uploaded. Your report is being analysed — we will let you know when it is ready.');
      setTimeout(function () { loadMemberHome(true); }, 1500);
    }
  } catch (e) {
    mhSay('mhBloodSay', 'bad', mhEsc(e.message || 'Upload failed.'));
  } finally {
    mhState.busy = '';
    renderMemberHome();
  }
}

async function mhWhoopPicked(ev) {
  var f = ev.target && ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  if (mhState.busy) return;
  mhState.busy = 'whoop';
  var btn = mhEl('mhWhoopBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  mhSay('mhWhoopSay', '', 'Reading <b>' + mhEsc(f.name) + '</b>…');
  try {
    var b64 = await mhReadBase64(f);
    mhSay('mhWhoopSay', '', 'Checking your export…');
    // Whoop lands in two steps: preview tells us what is in the file, commit
    // writes it. Showing the preview first means a wrong file never gets saved.
    var pre = await apiCall('POST', '/api/wearables/whoop/preview', { file_base64: b64, file_name: f.name });
    if (!pre || pre.error) {
      mhSay('mhWhoopSay', 'bad', mhEsc((pre && pre.error) || 'That did not look like a Whoop export.'));
      return;
    }
    var days = pre.preview && (pre.preview.days_new != null ? pre.preview.days_new : pre.preview.days);
    mhSay('mhWhoopSay', '', 'Found ' + mhPlural(Number(days || 0), 'day') + ' of data. Saving…');
    var com = await apiCall('POST', '/api/wearables/whoop/commit', { file_base64: b64, file_name: f.name });
    if (!com || com.error) {
      mhSay('mhWhoopSay', 'bad', mhEsc((com && com.error) || 'Could not save that export.'));
      return;
    }
    mhSay('mhWhoopSay', 'ok', 'Saved. Your readiness and recovery are up to date.');
    setTimeout(function () { loadMemberHome(true); }, 1200);
  } catch (e) {
    mhSay('mhWhoopSay', 'bad', mhEsc(e.message || 'Upload failed.'));
  } finally {
    mhState.busy = '';
    var b = mhEl('mhWhoopBtn');
    if (b) { b.disabled = false; b.textContent = 'Upload Whoop export'; }
  }
}


/* ---- one page, one sequence ---------------------------------------------
   The home used to be this block followed by the two legacy panes, which
   repeated the greeting, the streak, the habits and the navigation further
   down the page. Rather than rebuild widgets that already work, the real ones
   are MOVED into labelled slots here and the duplicates are hidden. Moving
   preserves each node and its id, so every existing loader and chart mount
   keeps writing to the same element it always did. */
var MH_MOVE = [
  { into: 'mhSlotPills',    take: ['.bb-today-stats'] },
  { into: 'mhSlotScore',    take: ['#bbScorecardDesktopWrap', '.bb-pulse-score'], sec: 'mhSecScore' },
  { into: 'mhSlotWeek',     take: ['#bbPulsePillars', '.bb-stat-grid'], sec: 'mhSecWeek' },
  { into: 'mhSlotBody',     take: ['#bbRdHomeSectionDesktop', '#bbRdHome'], sec: 'mhSecBody' },
  { into: 'mhSlotReports',  take: ['#myHealthReportsSectionDesktop', '#myHealthReportsSection'], sec: 'mhSlotReports' },
  { into: 'mhSlotTrends',   take: ['.bb-chart-grid'], sec: 'mhSecTrends' },
  { into: 'mhSlotActivity', take: ['.bb-table-card'], sec: 'mhSecActivity' },
  { into: 'mhSlotPush',     take: ['#pushEnableWrapDesktop', '#pushEnableWrap'], sec: 'mhSlotPush' }
];
// Duplicates of something the new page already says, better.
var MH_HIDE = [
  '.bb-today-top',          // greeting + avatar, twice
  '#bbTodayWeek',
  '#bbPulseHabits', '#bbPulseActions',
  '.bb-program-grid',       // today's steps/water/protein — the goals row covers it
  '.bb-quick-actions',      // the "Everything else" tiles cover every destination
  '.welcome-cards', '.welcome-explore-title',
  '.bb-body-home-prompt'    // re-added below the body tile instead
];

function mhSequence() {
  var home = mhEl('memberHome');
  if (!home) return;

  MH_MOVE.forEach(function (m) {
    var host = mhEl(m.into);
    if (!host) return;
    var got = 0;
    m.take.forEach(function (sel) {
      var el = document.querySelector(sel);
      // never re-move something already sitting in the sequence
      if (!el || home.contains(el)) return;
      host.appendChild(el);
      got++;
    });
    if (m.sec && (got || host.children.length)) {
      var sec = mhEl(m.sec);
      if (sec) sec.hidden = false;
    }
  });

  MH_HIDE.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) { el.classList.add('mh-gone'); });
  });

  // The desktop top bar carries coins, notifications and logout, so it stays —
  // but it belongs above the page, not halfway down it.
  var top = document.querySelector('.user-topbar');
  var homeSec = document.getElementById('usec-home');
  if (top && homeSec && top.parentNode !== homeSec) homeSec.insertBefore(top, homeSec.firstChild);

  // Whatever is left in the legacy panes is duplication; retire the shells.
  ['.user-welcome', '.bb-user-desktop-dashboard'].forEach(function (sel) {
    var el = document.querySelector(sel);
    if (el) el.classList.add('mh-gone');
  });
}

// The member shell calls this once its own loaders have run.
function mhBoot() {
  if (!mhEl('memberHome')) return;
  loadMemberHome();
  mhLoadNutritionAssessment();
  // The legacy widgets are built by the shell's own loaders, so sequence once
  // they exist, then once more in case a slow one arrives late.
  setTimeout(mhSequence, 400);
  setTimeout(mhSequence, 1800);
  setTimeout(mhSequence, 4000);
  if (window._mhPoll) clearInterval(window._mhPoll);
  window._mhPoll = setInterval(function () {
    var p = document.getElementById('userPanel');
    var home = document.getElementById('usec-home');
    if (p && p.classList.contains('open') && home && home.classList.contains('active')) loadMemberHome(true);
  }, 180000);
}
