/* ==========================================================================
   ADMIN . APP VERSION (store update alert for the Android / iOS apps)
   Fed by /api/admin/app-version (routes/appVersion.js, admin + superadmin).
   Two columns, iOS and Android: latest store version, minimum supported version
   (anything below is blocked until it updates), a force toggle, release notes,
   Save, and a one-time "Notify app users" push per version.
   Opened from switchTab('appversion') in index.html.
   ========================================================================== */
(function () {
  'use strict';

  // No store names here: this file also ships in the iOS bundle, where
  // bodybank-app/scripts/ios-strip-store-refs.js fails the build on any Play reference.
  var PLAT = [['ios', 'iOS'], ['android', 'Android']];
  var S = { host: null, data: null, busy: {}, msg: {}, err: {}, loading: false };

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
      var r = await fetch(apiBase() + '/api/admin/app-version' + path, { method: method, headers: hdr(!!body), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      var d = null; try { d = await r.json(); } catch (e) { d = null; }
      return { ok: r.ok, status: r.status, data: d };
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'Network error. Check your connection.' } };
    }
  }
  function when(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function injectStyles() {
    if (document.getElementById('bbav-styles')) return;
    var s = document.createElement('style');
    s.id = 'bbav-styles';
    s.textContent =
      '.bbav{max-width:980px}' +
      '.bbav-head h2{margin:0 0 4px;font-size:20px;color:var(--cream,#f5f5f5)}' +
      '.bbav-head p{margin:0 0 16px;color:var(--muted,#aaa);font-size:13px;line-height:1.5}' +
      '.bbav-mode{display:inline-flex;align-items:center;gap:8px;margin:0 0 16px;padding:7px 12px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid rgba(200,164,78,.35);color:#e4bb5a;background:rgba(200,164,78,.08)}' +
      '.bbav-mode.is-off{color:#f0a3a3;border-color:rgba(240,120,120,.4);background:rgba(240,120,120,.08)}' +
      '.bbav-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}' +
      '@media (max-width:760px){.bbav-grid{grid-template-columns:1fr}}' +
      '.bbav-card{background:#141414;border:1px solid rgba(200,164,78,.35);border-radius:14px;padding:18px;box-sizing:border-box;min-width:0}' +
      '.bbav-card h3{margin:0 0 2px;font-size:16px;color:#e4bb5a;display:flex;align-items:center;gap:8px}' +
      '.bbav-sub{margin:0 0 14px;font-size:12px;color:#aaa}' +
      '.bbav-field{margin:0 0 14px}' +
      '.bbav-field label{display:block;font-size:12px;font-weight:700;color:#ddd;margin:0 0 6px;letter-spacing:.02em}' +
      '.bbav-field input[type=text],.bbav-field textarea{width:100%;box-sizing:border-box;background:#0a0a0a;border:1px solid #333;border-radius:10px;color:#f5f5f5;padding:10px 12px;font:inherit;font-size:14px}' +
      '.bbav-field textarea{min-height:76px;resize:vertical}' +
      '.bbav-field input:focus,.bbav-field textarea:focus{outline:none;border-color:#c8a44e}' +
      '.bbav-field.has-err input,.bbav-field.has-err textarea{border-color:#d66}' +
      '.bbav-hint{font-size:11.5px;color:#aaa;margin-top:5px;line-height:1.4}' +
      '.bbav-hint.is-warn{color:#e4bb5a}' +
      '.bbav-ferr{font-size:11.5px;color:#f0a3a3;margin-top:5px}' +
      '.bbav-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #2a2a2a;border-radius:10px;background:#0f0f0f}' +
      '.bbav-toggle span{font-size:13px;color:#ddd;font-weight:600}' +
      '.bbav-toggle small{display:block;font-weight:400;color:#aaa;font-size:11.5px;margin-top:2px}' +
      '.bbav-switch{position:relative;width:46px;height:26px;flex-shrink:0}' +
      '.bbav-switch input{opacity:0;width:100%;height:100%;margin:0;position:absolute;inset:0;cursor:pointer;z-index:1}' +
      '.bbav-switch i{position:absolute;inset:0;border-radius:999px;background:#333;transition:background .2s}' +
      '.bbav-switch i::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#f5f5f5;transition:transform .2s}' +
      '.bbav-switch input:checked + i{background:linear-gradient(180deg,#e4bb5a,#c8a44e)}' +
      '.bbav-switch input:checked + i::after{transform:translateX(20px);background:#111}' +
      '.bbav-switch input:focus-visible + i{box-shadow:0 0 0 2px #e4bb5a}' +
      '.bbav-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}' +
      '.bbav-btn{border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:14px;border:none;font-family:inherit;display:inline-flex;align-items:center;gap:8px;min-height:44px}' +
      '.bbav-btn[disabled]{opacity:.55;cursor:default}' +
      '.bbav-primary{background:linear-gradient(180deg,#e4bb5a,#c8a44e);color:#111}' +
      '.bbav-secondary{background:transparent;border:1px solid #444;color:#ccc}' +
      '.bbav-meta{margin-top:12px;font-size:11.5px;color:#888;line-height:1.5}' +
      '.bbav-msg{margin-top:10px;font-size:12.5px;color:#9fd8b0}' +
      '.bbav-msg.is-err{color:#f0a3a3}' +
      '.bbav-src{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid #333;color:#aaa}' +
      '.bbav-src.is-db{border-color:rgba(200,164,78,.45);color:#e4bb5a}';
    document.head.appendChild(s);
  }

  var ICON_SAVE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  var ICON_DL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

  function modeLine(mode) {
    if (mode === 'off') return '<div class="bbav-mode is-off">Alerts are switched off on the server (APP_UPDATE_ALERT_ENABLED=off). Nothing shows in the apps.</div>';
    if (mode === 'staff') return '<div class="bbav-mode">Staff only: alerts show for admin, superadmin and operator accounts.</div>';
    return '<div class="bbav-mode">Live for every app user</div>';
  }

  function card(p) {
    var key = p[0];
    var d = S.data && S.data.platforms && S.data.platforms[key];
    if (!d) return '';
    var e = d.effective || {};
    var o = d.override;
    var err = S.err[key] || {};
    var msg = S.msg[key];
    var busy = !!S.busy[key];
    var notified = d.notified_version && d.notified_version === e.latest_version;
    var f = function (name, label, hint, warn) {
      return '<div class="bbav-field' + (err[name] ? ' has-err' : '') + '">' +
        '<label for="bbav_' + key + '_' + name + '">' + label + '</label>' +
        '<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" id="bbav_' + key + '_' + name + '" data-k="' + name + '" value="' + esc(e[name]) + '" placeholder="1.0.0">' +
        (hint ? '<div class="bbav-hint' + (warn ? ' is-warn' : '') + '">' + hint + '</div>' : '') +
        (err[name] ? '<div class="bbav-ferr">' + esc(err[name]) + '</div>' : '') + '</div>';
    };
    return '<section class="bbav-card" data-plat="' + key + '" aria-labelledby="bbav_' + key + '_t">' +
      '<h3 id="bbav_' + key + '_t">' + ICON_DL + esc(p[1]) + ' <span class="bbav-src' + (o ? ' is-db' : '') + '">' + (o ? 'Saved here' : 'Server default') + '</span></h3>' +
      '<p class="bbav-sub"><a href="' + esc(e.store_url) + '" target="_blank" rel="noopener" style="color:#c8a44e">Open the store page</a></p>' +
      f('latest_version', 'Latest version', 'The newest build live in the store. Older builds see a dismissible update card.') +
      f('min_supported_version', 'Minimum supported version', 'Users below minimum will be blocked until they update.', true) +
      '<div class="bbav-field"><div class="bbav-toggle"><span>Force update<small>Block every build below latest, not only below minimum.</small></span>' +
      '<label class="bbav-switch"><input type="checkbox" data-k="force" aria-label="Force update on ' + esc(p[1]) + '"' + (e.force ? ' checked' : '') + '><i></i></label></div></div>' +
      '<div class="bbav-field' + (err.release_notes ? ' has-err' : '') + '"><label for="bbav_' + key + '_notes">Release notes</label>' +
      '<textarea id="bbav_' + key + '_notes" data-k="release_notes" maxlength="500" placeholder="Shown on the update card and in the push. Leave empty for the default text.">' + esc(e.release_notes) + '</textarea>' +
      (err.release_notes ? '<div class="bbav-ferr">' + esc(err.release_notes) + '</div>' : '') + '</div>' +
      '<div class="bbav-actions">' +
      '<button type="button" class="bbav-btn bbav-primary" data-act="save"' + (busy ? ' disabled' : '') + '>' + ICON_SAVE + (busy === 'save' ? 'Saving…' : 'Save') + '</button>' +
      '<button type="button" class="bbav-btn bbav-secondary" data-act="notify"' + (busy || notified ? ' disabled' : '') + ' title="' + (notified ? 'Already sent for ' + esc(e.latest_version) : 'One push to every ' + esc(p[1]) + ' device') + '">' + ICON_BELL + (busy === 'notify' ? 'Sending…' : (notified ? 'Notified for ' + esc(e.latest_version) : 'Notify app users')) + '</button>' +
      '</div>' +
      (msg ? '<div class="bbav-msg' + (msg.err ? ' is-err' : '') + '" role="status">' + esc(msg.text) + '</div>' : '') +
      '<div class="bbav-meta">' +
      (o && o.updated_at ? 'Last saved ' + esc(when(o.updated_at)) + (o.updated_by ? ' by ' + esc(o.updated_by) : '') + '<br>' : 'Using server values from the environment.<br>') +
      (d.notified_version ? 'Push sent for ' + esc(d.notified_version) + (d.notified_at ? ' on ' + esc(when(d.notified_at)) : '') : 'No update push sent yet.') +
      '</div></section>';
  }

  function render() {
    if (!S.host) return;
    injectStyles();
    var h = '<div class="bbav"><div class="bbav-head"><h2>App Version</h2>' +
      '<p>Tell app users when a newer store build is out, and block builds that are too old. Changes reach the apps within about five minutes. A soft card can be dismissed for three days; a blocked build sees a full screen with an Update now button.</p></div>';
    if (S.loading && !S.data) h += '<p class="form-hint" style="padding:24px 0;margin:0">Loading…</p>';
    else if (!S.data) h += '<p class="form-hint" style="padding:24px 0;margin:0;color:#f0a3a3">' + esc(S.loadErr || 'Could not load the app version settings.') + ' <button type="button" class="bbav-btn bbav-secondary" data-act="reload" style="margin-left:8px">Try again</button></p>';
    else h += modeLine(S.data.mode) + '<div class="bbav-grid">' + PLAT.map(card).join('') + '</div>';
    h += '</div>';
    S.host.innerHTML = h;
  }

  function readForm(key) {
    var c = S.host.querySelector('.bbav-card[data-plat="' + key + '"]');
    if (!c) return null;
    var v = function (k) { var el = c.querySelector('[data-k="' + k + '"]'); return el ? el : null; };
    return {
      latest_version: v('latest_version').value.trim(),
      min_supported_version: v('min_supported_version').value.trim(),
      force: !!v('force').checked,
      release_notes: v('release_notes').value.trim()
    };
  }

  async function load() {
    S.loading = true; render();
    var r = await api('GET', '/');
    S.loading = false;
    if (r.ok && r.data && r.data.platforms) { S.data = r.data; S.loadErr = ''; }
    else S.loadErr = (r.data && r.data.error) || 'Could not load the app version settings.';
    render();
  }

  async function save(key) {
    var body = readForm(key);
    if (!body) return;
    S.busy[key] = 'save'; S.err[key] = {}; S.msg[key] = null; render();
    var r = await api('PUT', '/' + key, body);
    S.busy[key] = false;
    if (r.ok && r.data && r.data.platforms) {
      S.data = r.data;
      S.msg[key] = { text: 'Saved. Apps pick this up within five minutes.' };
    } else {
      S.err[key] = (r.data && r.data.fields) || {};
      S.msg[key] = { err: true, text: (r.data && r.data.error) || 'Could not save. Please try again.' };
      render();
      // Keep what the admin typed after a failed save.
      var c = S.host.querySelector('.bbav-card[data-plat="' + key + '"]');
      if (c) {
        c.querySelector('[data-k="latest_version"]').value = body.latest_version;
        c.querySelector('[data-k="min_supported_version"]').value = body.min_supported_version;
        c.querySelector('[data-k="force"]').checked = body.force;
        c.querySelector('[data-k="release_notes"]').value = body.release_notes;
      }
      return;
    }
    render();
  }

  async function notify(key) {
    var d = S.data && S.data.platforms[key];
    var label = key === 'ios' ? 'iOS' : 'Android';
    var ver = d && d.effective && d.effective.latest_version;
    if (!window.confirm('Send one push to every ' + label + ' app user about version ' + ver + '?\n\nThis can only be sent once per version.')) return;
    S.busy[key] = 'notify'; S.msg[key] = null; render();
    var r = await api('POST', '/' + key + '/notify');
    S.busy[key] = false;
    if (r.ok && r.data) S.msg[key] = { text: 'Push sent to ' + r.data.sent + ' of ' + r.data.users + ' ' + label + ' users.' };
    else S.msg[key] = { err: true, text: (r.data && r.data.error) || 'Could not send. Please try again.' };
    var g = await api('GET', '/');
    if (g.ok && g.data && g.data.platforms) S.data = g.data;
    render();
  }

  function bind() {
    if (S.host.getAttribute('data-bbav-bound')) return;
    S.host.setAttribute('data-bbav-bound', '1');
    S.host.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-act]');
      if (!b || b.disabled) return;
      var c = b.closest('.bbav-card');
      var key = c && c.getAttribute('data-plat');
      var act = b.getAttribute('data-act');
      if (act === 'reload') load();
      else if (act === 'save' && key) save(key);
      else if (act === 'notify' && key) notify(key);
    });
    S.host.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || t.getAttribute('data-k') !== 'force' || !t.checked) return;
      var c = t.closest('.bbav-card');
      var label = c && c.getAttribute('data-plat') === 'ios' ? 'iOS' : 'Android';
      var ok = window.confirm('Turn on Force update for ' + label + '?\n\nAfter you save, every ' + label + ' build below the latest version is blocked by a full screen until the user updates from the store.');
      if (!ok) t.checked = false;
    });
  }

  window.bbAppVersionAdminOpen = function () {
    S.host = document.getElementById('tab-appversion');
    if (!S.host) return;
    bind();
    S.msg = {}; S.err = {};
    load();
  };
})();
