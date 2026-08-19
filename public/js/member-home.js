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
   readiness, Signal, programs, charts and the explore cards. This is the layer
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
    var d = await apiCall('GET', '/api/member/home');
    if (!d || d.error) {
      if (!silent) {
        var host = mhEl('mhLoop');
        if (host) host.innerHTML = '<div class="mh-empty">' + mhEsc((d && d.error) || 'Could not load your home.') + '</div>';
      }
      return;
    }
    mhState.data = d;
    renderMemberHome();
  } catch (e) {
    var h2 = mhEl('mhLoop');
    if (h2) h2.innerHTML = '<div class="mh-empty">Could not reach the server. Pull to refresh.</div>';
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

  var open = steps.filter(function (s) { return !s.done; });
  var loopEl = mhEl('mhLoop');
  if (loopEl) {
    loopEl.innerHTML = steps.map(function (s) {
      var sub2 = s.sub2 ? ",'" + s.sub2 + "'" : '';
      return '<div class="mh-step' + (s.done ? ' done' : '') + (s.soft ? ' soft' : '') + '">'
        + '<span class="mh-step-ico" aria-hidden="true">' + (s.done ? '✓' : s.icon) + '</span>'
        + '<div class="mh-step-main">'
        + '<div class="mh-step-title">' + mhEsc(s.done ? s.doneTitle : s.title) + '</div>'
        + '<div class="mh-step-sub">' + mhEsc(s.done ? s.doneSub : s.sub) + '</div>'
        + '</div>'
        + (s.done
          ? '<button type="button" class="mh-step-cta ghost" onclick="mhGo(\'' + s.tab + '\'' + sub2 + ')">View</button>'
          : '<button type="button" class="mh-step-cta" onclick="mhGo(\'' + s.tab + '\'' + sub2 + ')">' + mhEsc(s.cta) + '</button>')
        + '</div>';
    }).join('');
  }
  var lc = mhEl('mhLoopCount');
  if (lc) lc.textContent = open.length ? mhPlural(open.length, 'thing') + ' left' : 'all done today';
  var lineEl = mhEl('mhLine');
  if (lineEl) {
    lineEl.innerHTML = open.length
      ? 'You have <b>' + open.length + '</b> ' + (open.length === 1 ? 'thing' : 'things') + ' left today.'
      : '<b>Everything is done today.</b> Rest up — consistency is the whole game.';
  }

  // ---- streak and the week ------------------------------------------------
  var streak = d.streak || 0;
  mhEl('mhStreak') && (mhEl('mhStreak').textContent = streak);
  mhEl('mhStreakL') && (mhEl('mhStreakL').textContent = streak === 1 ? 'day streak' : 'day streak');
  var strip = mhEl('mhWeek');
  if (strip) {
    var wk = String(d.week || '0000000');
    var out = '';
    for (var i = 0; i < 7; i++) {
      var dt = new Date(Date.now() - (6 - i) * 86400000);
      var lbl = dt.toLocaleDateString(undefined, { weekday: 'narrow' });
      var on = wk.charAt(i) === '1';
      out += '<span class="mh-day' + (on ? ' on' : '') + (i === 6 ? ' today' : '') + '"'
        + ' title="' + mhEsc(dt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
          + (on ? ' — checked in' : ' — no check-in')) + '">'
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
      + item('✉️', 'Contact Us', 'We are here to help', 'contact');
  }
}

/* ------------------------------------------------------------- uploads --- */
function mhPickBlood() {
  var inp = mhEl('mhBloodFile');
  if (inp) { inp.value = ''; inp.click(); }
}
function mhPickWhoop() {
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

// The member shell calls this once its own loaders have run.
function mhBoot() {
  if (!mhEl('memberHome')) return;
  loadMemberHome();
  if (window._mhPoll) clearInterval(window._mhPoll);
  window._mhPoll = setInterval(function () {
    var p = document.getElementById('userPanel');
    var home = document.getElementById('usec-home');
    if (p && p.classList.contains('open') && home && home.classList.contains('active')) loadMemberHome(true);
  }, 180000);
}
