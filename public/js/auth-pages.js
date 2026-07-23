/* ===========================================================================
   BodyBank — shared logic for the standalone /signin and /signup pages.

   These pages are deliberately independent of index.html (which is a ~28k-line
   SPA). They talk to the same auth API, write the same `bodybank_session`
   localStorage key, and then hand off to /index.html, whose restoreSession()
   opens the right dashboard for the role (user / admin / superadmin / operator).
   =========================================================================== */
(function (window, document) {
  'use strict';

  var SESSION_KEY = 'bodybank_session';
  var PENDING_SOCIAL_KEY = 'bb_pending_social'; // handoff: signin page -> signup page
  var DEFAULT_NEXT = '/index.html';

  var BB = {};

  /* ---------------------------------------------------------------- network */

  // Same-origin JSON call. Never throws — always resolves to an object, and a
  // failure always carries `.error` so callers can render one message path.
  BB.api = function (method, url, body, token) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
        if (!data || typeof data !== 'object') data = {};
        if (!res.ok && !data.error) data.error = data.message || ('Request failed (' + res.status + ')');
        return data;
      });
    }).catch(function () {
      return { error: 'Network error. Please check your connection and try again.' };
    });
  };

  /* ---------------------------------------------------------------- session */

  BB.getSession = function () {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.id || !data.role) return null;
      return data;
    } catch (_) { return null; }
  };

  BB.saveSession = function (data) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (_) {}
  };

  BB.clearSession = function () {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  };

  // Where to land after a successful auth. `?next=` is honoured only for
  // same-origin relative paths (no "//host" or "/\host" open-redirects).
  BB.nextUrl = function () {
    try {
      var next = new URLSearchParams(window.location.search).get('next') || '';
      if (next && next.charAt(0) === '/' && next.charAt(1) !== '/' && next.charAt(1) !== '\\') return next;
    } catch (_) {}
    return DEFAULT_NEXT;
  };

  BB.go = function (url) { window.location.replace(url || BB.nextUrl()); };

  /* ------------------------------------------------------------------- UI */

  BB.msg = function (id, text, kind) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!text) { el.className = 'msg'; el.textContent = ''; return; }
    el.className = 'msg show ' + (kind || 'error');
    el.textContent = text;
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  };

  BB.msgHtml = function (id, html, kind) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'msg show ' + (kind || 'error');
    el.innerHTML = html;
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  };

  BB.busy = function (btn, isBusy, busyLabel) {
    if (!btn) return;
    if (isBusy) {
      if (btn.dataset.orig == null) btn.dataset.orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + (busyLabel || 'Please wait…');
    } else {
      btn.disabled = false;
      if (btn.dataset.orig != null) btn.innerHTML = btn.dataset.orig;
    }
  };

  BB.togglePw = function (inputId, toggleBtn) {
    var el = document.getElementById(inputId);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
    if (toggleBtn) toggleBtn.setAttribute('aria-label', el.type === 'password' ? 'Show password' : 'Hide password');
  };

  // Friendly copy for auth failures. Coded errors (pending_approval, rejected,
  // suspended, subscription_*) carry a human `message`; plain ones don't.
  BB.authErrorText = function (data) {
    if (!data) return 'Something went wrong. Please try again.';
    return data.message || data.error || 'Something went wrong. Please try again.';
  };

  /* ------------------------------------------------------------- timezones */

  // Kept in sync with the timezone list in the index.html signup modal.
  BB.TIMEZONES = [
    ['Asia', [
      ['Asia/Kolkata', 'India (IST, UTC+5:30)'],
      ['Asia/Dubai', 'UAE / Dubai (GST, UTC+4)'],
      ['Asia/Riyadh', 'Saudi Arabia (AST, UTC+3)'],
      ['Asia/Kuwait', 'Kuwait (AST, UTC+3)'],
      ['Asia/Qatar', 'Qatar (AST, UTC+3)'],
      ['Asia/Bahrain', 'Bahrain (AST, UTC+3)'],
      ['Asia/Muscat', 'Oman / Muscat (GST, UTC+4)'],
      ['Asia/Karachi', 'Pakistan (PKT, UTC+5)'],
      ['Asia/Dhaka', 'Bangladesh (BST, UTC+6)'],
      ['Asia/Kathmandu', 'Nepal (NPT, UTC+5:45)'],
      ['Asia/Colombo', 'Sri Lanka (SLST, UTC+5:30)'],
      ['Asia/Singapore', 'Singapore (SGT, UTC+8)'],
      ['Asia/Kuala_Lumpur', 'Malaysia (MYT, UTC+8)'],
      ['Asia/Jakarta', 'Indonesia / Jakarta (WIB, UTC+7)'],
      ['Asia/Manila', 'Philippines (PHT, UTC+8)'],
      ['Asia/Tokyo', 'Japan (JST, UTC+9)'],
      ['Asia/Seoul', 'South Korea (KST, UTC+9)'],
      ['Asia/Shanghai', 'China (CST, UTC+8)']
    ]],
    ['Europe', [
      ['Europe/London', 'UK / London (GMT/BST)'],
      ['Europe/Paris', 'France / Paris (CET, UTC+1)'],
      ['Europe/Berlin', 'Germany / Berlin (CET, UTC+1)'],
      ['Europe/Rome', 'Italy / Rome (CET, UTC+1)'],
      ['Europe/Amsterdam', 'Netherlands (CET, UTC+1)'],
      ['Europe/Oslo', 'Norway / Oslo (CET, UTC+1)'],
      ['Europe/Stockholm', 'Sweden / Stockholm (CET, UTC+1)'],
      ['Europe/Copenhagen', 'Denmark (CET, UTC+1)'],
      ['Europe/Helsinki', 'Finland (EET, UTC+2)'],
      ['Europe/Dublin', 'Ireland / Dublin (GMT/IST)']
    ]],
    ['Americas', [
      ['America/New_York', 'US — New York (ET, UTC-5/-4)'],
      ['America/Chicago', 'US — Chicago (CT, UTC-6/-5)'],
      ['America/Denver', 'US — Denver (MT, UTC-7/-6)'],
      ['America/Los_Angeles', 'US — Los Angeles (PT, UTC-8/-7)'],
      ['America/Phoenix', 'US — Phoenix (MST, UTC-7)'],
      ['America/Anchorage', 'US — Anchorage (AKST, UTC-9)'],
      ['Pacific/Honolulu', 'US — Hawaii (HST, UTC-10)'],
      ['America/Toronto', 'Canada / Toronto (ET, UTC-5/-4)'],
      ['America/Vancouver', 'Canada / Vancouver (PT, UTC-8/-7)'],
      ['America/Sao_Paulo', 'Brazil / São Paulo (BRT, UTC-3)'],
      ['America/Mexico_City', 'Mexico (CST, UTC-6)']
    ]],
    ['Oceania', [
      ['Australia/Sydney', 'Australia / Sydney (AEST, UTC+10/11)'],
      ['Australia/Brisbane', 'Australia / Brisbane (AEST, UTC+10)'],
      ['Australia/Perth', 'Australia / Perth (AWST, UTC+8)'],
      ['Pacific/Auckland', 'New Zealand (NZST, UTC+12/13)']
    ]],
    ['Africa', [
      ['Africa/Johannesburg', 'South Africa (SAST, UTC+2)'],
      ['Africa/Lagos', 'Nigeria (WAT, UTC+1)'],
      ['Africa/Nairobi', 'Kenya (EAT, UTC+3)']
    ]],
    ['UTC', [
      ['UTC', 'UTC (Coordinated Universal Time)']
    ]]
  ];

  // Browsers still report legacy zone ids (Chrome on Windows says
  // "Asia/Calcutta"); map them onto the canonical option we actually list.
  BB.TZ_ALIASES = {
    'Asia/Calcutta': 'Asia/Kolkata',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
    'Asia/Rangoon': 'Asia/Yangon',
    'Europe/Kiev': 'Europe/Kyiv',
    'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
    'Australia/Canberra': 'Australia/Sydney',
    'Australia/Melbourne': 'Australia/Sydney',
    'US/Pacific': 'America/Los_Angeles',
    'US/Eastern': 'America/New_York',
    'US/Central': 'America/Chicago',
    'US/Mountain': 'America/Denver',
    'Etc/UTC': 'UTC',
    'Etc/GMT': 'UTC'
  };

  // Fills a <select> with the grouped timezone list and pre-selects the
  // browser's zone (adding it if it isn't one of the curated options).
  BB.fillTimezoneSelect = function (selectId) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select your timezone';
    sel.appendChild(placeholder);

    BB.TIMEZONES.forEach(function (group) {
      var og = document.createElement('optgroup');
      og.label = group[0];
      group[1].forEach(function (tz) {
        var opt = document.createElement('option');
        opt.value = tz[0];
        opt.textContent = tz[1];
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });

    var detected = '';
    try { detected = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    if (!detected) return;
    detected = BB.TZ_ALIASES[detected] || detected;

    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === detected) { sel.value = detected; return; }
    }
    // Not one of the curated zones — offer it as its own entry. It must be
    // inserted as a DIRECT child of the select (options inside an optgroup are
    // not), so anchor on the first child element after the placeholder.
    var extra = document.createElement('option');
    extra.value = detected;
    extra.textContent = detected + ' (detected)';
    sel.insertBefore(extra, sel.children[1] || null);
    sel.value = detected;
  };

  // Country prefill derived from the DETECTED TIMEZONE (not the browser
  // locale) so the two fields can never disagree — an en-US browser in Mumbai
  // must not prefill "United States" next to an IST timezone.
  BB.TZ_COUNTRY = {
    'Asia/Kolkata': 'India', 'Asia/Dubai': 'United Arab Emirates', 'Asia/Riyadh': 'Saudi Arabia',
    'Asia/Kuwait': 'Kuwait', 'Asia/Qatar': 'Qatar', 'Asia/Bahrain': 'Bahrain', 'Asia/Muscat': 'Oman',
    'Asia/Karachi': 'Pakistan', 'Asia/Dhaka': 'Bangladesh', 'Asia/Kathmandu': 'Nepal',
    'Asia/Colombo': 'Sri Lanka', 'Asia/Singapore': 'Singapore', 'Asia/Kuala_Lumpur': 'Malaysia',
    'Asia/Jakarta': 'Indonesia', 'Asia/Manila': 'Philippines', 'Asia/Tokyo': 'Japan',
    'Asia/Seoul': 'South Korea', 'Asia/Shanghai': 'China',
    'Europe/London': 'United Kingdom', 'Europe/Paris': 'France', 'Europe/Berlin': 'Germany',
    'Europe/Rome': 'Italy', 'Europe/Amsterdam': 'Netherlands', 'Europe/Oslo': 'Norway',
    'Europe/Stockholm': 'Sweden', 'Europe/Copenhagen': 'Denmark', 'Europe/Helsinki': 'Finland',
    'Europe/Dublin': 'Ireland',
    'America/New_York': 'United States', 'America/Chicago': 'United States',
    'America/Denver': 'United States', 'America/Los_Angeles': 'United States',
    'America/Phoenix': 'United States', 'America/Anchorage': 'United States',
    'Pacific/Honolulu': 'United States', 'America/Toronto': 'Canada', 'America/Vancouver': 'Canada',
    'America/Sao_Paulo': 'Brazil', 'America/Mexico_City': 'Mexico',
    'Australia/Sydney': 'Australia', 'Australia/Brisbane': 'Australia', 'Australia/Perth': 'Australia',
    'Pacific/Auckland': 'New Zealand',
    'Africa/Johannesburg': 'South Africa', 'Africa/Lagos': 'Nigeria', 'Africa/Nairobi': 'Kenya'
  };

  BB.guessCountry = function () {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    if (!tz) return '';
    tz = BB.TZ_ALIASES[tz] || tz;
    return BB.TZ_COUNTRY[tz] || '';
  };

  /* ------------------------------------------------------------ app config */

  var _configPromise = null;
  BB.config = function () {
    if (!_configPromise) {
      _configPromise = BB.api('GET', '/api/config').then(function (c) { return c || {}; });
    }
    return _configPromise;
  };

  BB.isNativeIOS = function () {
    try { return !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'ios'); } catch (_) { return false; }
  };
  BB.isNativeAndroid = function () {
    try { return !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android'); } catch (_) { return false; }
  };
  BB.clientKind = function () { return window.IS_BODYBANK_APP ? 'app' : 'web'; };

  /* --------------------------------------------------------- Google Sign-In */

  var _gsiAttempts = 0;
  var _gsiRendered = false;

  // Renders the official Google button into `slotId`. Google Sign-In is
  // optional — if the client id isn't configured, or the script can't load,
  // the whole social block is hidden and email/password still works.
  BB.initGoogle = function (slotId, text, onCredential) {
    var slot = document.getElementById(slotId);
    if (!slot) return;

    BB.config().then(function (config) {
      var cid = (config && config.google_client_id) || '';
      if (!cid || cid.indexOf('YOUR_') === 0 || cid.indexOf('your_client_id') !== -1) {
        slot.classList.add('hidden');
        BB.refreshSocialVisibility();
        return;
      }

      function render() {
        if (_gsiRendered) return;
        if (!(window.google && window.google.accounts && window.google.accounts.id)) return;
        if (slot.querySelector('iframe')) { _gsiRendered = true; return; }
        try {
          window.google.accounts.id.initialize({ client_id: cid, callback: function (resp) {
            if (resp && resp.credential) onCredential(resp.credential);
          } });
          // Google renders a fixed-width iframe (and silently uses ~400px when
          // asked for 0), so measure the slot and clamp to its real width.
          var slotWidth = Math.round(slot.getBoundingClientRect().width ||
            (slot.parentElement ? slot.parentElement.getBoundingClientRect().width : 0) || 300);
          window.google.accounts.id.renderButton(slot, {
            theme: 'filled_black', size: 'large', type: 'standard',
            text: text || 'continue_with', shape: 'rectangular',
            width: Math.min(400, Math.max(slotWidth, 200))
          });
          _gsiRendered = true;
          BB.refreshSocialVisibility();
        } catch (e) { console.warn('[auth] Google renderButton:', e); }
      }

      function load() {
        if (window.google && window.google.accounts && window.google.accounts.id) { render(); return; }
        var existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
        if (existing && existing.getAttribute('data-bb-failed') !== '1') {
          existing.addEventListener('load', render);
          return;
        }
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = render;
        s.onerror = function () {
          s.setAttribute('data-bb-failed', '1');
          _gsiAttempts++;
          if (_gsiAttempts < 3) {
            setTimeout(load, 1500 * _gsiAttempts);
          } else {
            console.warn('[auth] Google Sign-In could not load; hiding the button.');
            slot.classList.add('hidden');
            BB.refreshSocialVisibility();
          }
        };
        document.head.appendChild(s);
      }
      load();
    });
  };

  /* ------------------------------------------------------ Sign in with Apple */

  var _appleConfig = null;
  var _appleReady = false;

  BB.initApple = function (btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    if (BB.isNativeAndroid()) { btn.style.display = 'none'; BB.refreshSocialVisibility(); return; }

    var nativeIOS = BB.isNativeIOS();
    if (nativeIOS) { btn.style.display = 'flex'; BB.refreshSocialVisibility(); }

    BB.config().then(function (config) {
      _appleConfig = config || {};
      var serviceId = _appleConfig.apple_client_id || '';
      if (!nativeIOS) {
        btn.style.display = serviceId ? 'flex' : 'none';
        if (serviceId) ensureAppleSdk(_appleConfig);
      }
      BB.refreshSocialVisibility();
    }).catch(function () {
      if (!nativeIOS) btn.style.display = 'none';
      BB.refreshSocialVisibility();
    });
  };

  function ensureAppleSdk(config) {
    function init() {
      if (_appleReady || !(window.AppleID && window.AppleID.auth)) return;
      try {
        window.AppleID.auth.init({
          clientId: config.apple_client_id,
          scope: 'name email',
          redirectURI: config.apple_redirect_uri || (window.location.origin + '/'),
          usePopup: true
        });
        _appleReady = true;
      } catch (e) { console.warn('[auth] AppleID init:', e); }
    }
    if (window.AppleID && window.AppleID.auth) { init(); return; }
    var existing = document.querySelector('script[src*="appleid.cdn-apple.com"]');
    if (existing) { existing.addEventListener('load', init); return; }
    var s = document.createElement('script');
    s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    s.async = true;
    s.onload = init;
    s.onerror = function () { console.warn('[auth] Apple JS SDK failed to load'); };
    document.head.appendChild(s);
  }

  // Runs the Apple flow (native plugin on iOS, popup elsewhere) and calls
  // onToken(idToken, userPayload). Returns silently on user cancellation.
  BB.appleSignIn = function (onToken, onError) {
    function fail(text) { if (onError) onError(text); }
    try {
      if (BB.isNativeIOS()) {
        var plugin = null;
        try { plugin = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SignInWithApple) || null; } catch (_) {}
        if (!plugin) { fail('Sign in with Apple is unavailable on this device.'); return; }
        var bundleId = (_appleConfig && _appleConfig.apple_bundle_id) || 'com.bodybank.app';
        plugin.authorize({
          clientId: bundleId,
          scopes: 'name email',
          redirectURI: (_appleConfig && _appleConfig.apple_redirect_uri) || (window.location.origin + '/')
        }).then(function (result) {
          var r = (result && result.response) || {};
          if (!r.identityToken) { fail('Apple sign-in was not completed.'); return; }
          onToken(r.identityToken, { name: { firstName: r.givenName || '', lastName: r.familyName || '' }, email: r.email || '' });
        }).catch(function (e) {
          if (isAppleCancel(e)) return;
          console.warn('[auth] Apple native error:', e);
          fail('Apple authentication failed. Please try again.');
        });
        return;
      }

      if (!_appleReady && _appleConfig) ensureAppleSdk(_appleConfig);
      if (!(window.AppleID && window.AppleID.auth)) {
        fail('Could not load Sign in with Apple. Check your connection and try again.');
        return;
      }
      window.AppleID.auth.signIn().then(function (data) {
        var idToken = data && data.authorization && data.authorization.id_token;
        if (!idToken) { fail('Apple sign-in failed. Please try again.'); return; }
        onToken(idToken, data.user || null);
      }).catch(function (e) {
        if (isAppleCancel(e)) return;
        console.warn('[auth] Apple sign-in error:', e);
        fail('Apple authentication failed. Please try again.');
      });
    } catch (e) {
      if (isAppleCancel(e)) return;
      fail('Apple authentication failed. Please try again.');
    }
  };

  function isAppleCancel(e) {
    var code = e && e.error;
    return code === 'popup_closed_by_user' || code === 'user_cancelled_authorize' || code === 'user_trigger_new_signin_flow';
  }

  // Hides the "or continue with" divider when neither social button is visible.
  BB.refreshSocialVisibility = function () {
    var divider = document.getElementById('socialDivider');
    if (!divider) return;
    var google = document.getElementById('googleSlot');
    var apple = document.getElementById('appleBtn');
    var googleShown = !!google && !google.classList.contains('hidden');
    var appleShown = !!apple && apple.style.display !== 'none';
    divider.classList.toggle('hidden', !googleShown && !appleShown);
  };

  /* -------------------------------------------- pending-social page handoff */

  BB.setPendingSocial = function (payload) {
    try { sessionStorage.setItem(PENDING_SOCIAL_KEY, JSON.stringify(payload)); } catch (_) {}
  };
  BB.takePendingSocial = function () {
    try {
      var raw = sessionStorage.getItem(PENDING_SOCIAL_KEY);
      sessionStorage.removeItem(PENDING_SOCIAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  };

  /* ------------------------------------------------------ already-signed-in */

  // Shows a "you're already signed in" banner instead of silently bouncing the
  // visitor away — so a shared link can still be used to switch accounts.
  BB.showExistingSession = function (bannerId) {
    var session = BB.getSession();
    var el = document.getElementById(bannerId);
    if (!session || !el) return;
    var name = (session.first_name || session.email || 'there');
    el.innerHTML =
      'You are already signed in as <strong>' + escapeHtml(name) + '</strong>.' +
      '<div class="actions">' +
      '<a class="go" href="' + escapeHtml(BB.nextUrl()) + '">Go to dashboard</a>' +
      '<button type="button" id="bbSwitchAccount">Use another account</button>' +
      '</div>';
    el.classList.add('show');
    var btn = document.getElementById('bbSwitchAccount');
    if (btn) btn.addEventListener('click', function () {
      BB.clearSession();
      el.classList.remove('show');
    });
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  BB.escapeHtml = escapeHtml;

  window.BBAuth = BB;
})(window, document);
