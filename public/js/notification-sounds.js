/**
 * In-app notification sounds (Web Audio). User: default chime; water-related: drip;
 * Admin: brighter chime.
 * Sounds are ON by default (localStorage bb_notify_sounds_on unset or '1'). Mute via bell 🔊 only.
 * Skipped when prefers-reduced-motion: reduce (accessibility).
 */
(function (w) {
  'use strict';

  var STORAGE = 'bb_notify_sounds_on';
  var HINT_SESSION_KEY = 'bb_sound_unlock_hint_dismissed_v1';
  var MAX_SEEN = 450;
  var ctx = null;

  function hintDismissedThisSession() {
    try {
      return sessionStorage.getItem(HINT_SESSION_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function markHintDismissed() {
    try {
      sessionStorage.setItem(HINT_SESSION_KEY, '1');
    } catch (e) {}
  }

  function isAudioRunning() {
    var c = getCtx();
    return !!(c && c.state === 'running');
  }

  function hideUnlockHintBar() {
    var el = document.getElementById('bbSoundUnlockHint');
    if (el) el.hidden = true;
  }

  function ensureUnlockHintEl() {
    var el = document.getElementById('bbSoundUnlockHint');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bbSoundUnlockHint';
    el.className = 'bb-sound-unlock-hint';
    el.setAttribute('role', 'status');
    el.hidden = true;
    el.innerHTML =
      '<div class="bb-sound-unlock-inner">' +
      '<p class="bb-sound-unlock-txt"><strong>In-app notification sounds</strong> — Your browser asks for <strong>one tap</strong> on this visit to unlock audio. After that, chimes work automatically. Tap <strong>Unlock sounds</strong> or tap anywhere on the app.</p>' +
      '<div class="bb-sound-unlock-actions">' +
      '<button type="button" class="bb-sound-unlock-btn bb-sound-unlock-primary">Unlock sounds</button>' +
      '<button type="button" class="bb-sound-unlock-btn bb-sound-unlock-secondary">Dismiss</button>' +
      '</div></div>';
    document.body.appendChild(el);
    el.querySelector('.bb-sound-unlock-primary').addEventListener('click', function (e) {
      e.stopPropagation();
      w.bbNotifyPrimeAudio();
    });
    el.querySelector('.bb-sound-unlock-secondary').addEventListener('click', function (e) {
      e.stopPropagation();
      markHintDismissed();
      hideUnlockHintBar();
    });
    return el;
  }

  /**
   * One short gesture unlocks Web Audio for this tab (browser policy). Shows a bar until dismissed or unlocked.
   */
  w.bbNotifyTryShowUnlockHint = function () {
    if (!w.currentUser) return;
    if (hintDismissedThisSession()) return;
    if (!w.bbNotifySoundsEnabled()) return;
    if (w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (isAudioRunning()) {
      markHintDismissed();
      return;
    }
    var el = ensureUnlockHintEl();
    el.hidden = false;
  };

  /** Call after a deliberate tap — unlocks audio and plays a sample chime. */
  w.bbNotifyPrimeAudio = function () {
    if (!w.bbNotifySoundsEnabled()) return;
    resume();
    var isAd = w.currentUser && (w.currentUser.role === 'admin' || w.currentUser.role === 'superadmin');
    w.bbNotifyPlayKind(isAd ? 'admin' : 'default');
    markHintDismissed();
    hideUnlockHintBar();
  };

  function getCtx() {
    var C = w.AudioContext || w.webkitAudioContext;
    if (!C) return null;
    if (!ctx) ctx = new C();
    return ctx;
  }

  function resume() {
    var c = getCtx();
    if (c && c.state === 'suspended') {
      var p = c.resume();
      if (p && typeof p.then === 'function') p.catch(function () {});
    }
    return c;
  }

  function playTone(freq, dur, vol, type, delayMs) {
    var c = resume();
    if (!c) return;
    var t0 = c.currentTime + (delayMs || 0) / 1000;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.025);
  }

  function playDefault() {
    playTone(880, 0.075, 0.048, 'sine', 0);
    playTone(1318, 0.095, 0.038, 'sine', 58);
  }

  function playAdmin() {
    playTone(1046, 0.06, 0.052, 'sine', 0);
    playTone(1568, 0.09, 0.044, 'sine', 48);
  }

  function playWater() {
    var c = resume();
    if (!c) return;
    var t0 = c.currentTime;
    for (var i = 0; i < 3; i++) {
      (function (idx) {
        var base = t0 + idx * 0.075;
        var osc = c.createOscillator();
        var g = c.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(720 + idx * 160, base);
        osc.frequency.exponentialRampToValueAtTime(320, base + 0.08);
        g.gain.setValueAtTime(0.0001, base);
        g.gain.exponentialRampToValueAtTime(0.052, base + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, base + 0.11);
        osc.connect(g);
        g.connect(c.destination);
        osc.start(base);
        osc.stop(base + 0.14);
      })(i);
    }
  }

  w.bbNotifySoundsEnabled = function () {
    try {
      var v = localStorage.getItem(STORAGE);
      if (v === null || v === undefined) return true;
      return v === '1';
    } catch (e) {
      return true;
    }
  };

  w.bbNotifySetSoundsEnabled = function (on) {
    try {
      localStorage.setItem(STORAGE, on ? '1' : '0');
    } catch (e) {}
    if (typeof w.bbNotifyRefreshSoundButtons === 'function') w.bbNotifyRefreshSoundButtons();
  };

  w.bbNotifyPlayKind = function (kind) {
    if (!w.bbNotifySoundsEnabled()) return;
    if (w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    try {
      resume();
      if (kind === 'water') playWater();
      else if (kind === 'admin') playAdmin();
      else playDefault();
    } catch (e) {}
  };

  w.toggleNotifySoundsUI = function (ev) {
    if (ev) {
      ev.stopPropagation();
      ev.preventDefault();
    }
    var next = !w.bbNotifySoundsEnabled();
    w.bbNotifySetSoundsEnabled(next);
    resume();
    if (next) {
      var isAd = w.currentUser && (w.currentUser.role === 'admin' || w.currentUser.role === 'superadmin');
      w.bbNotifyPlayKind(isAd ? 'admin' : 'default');
    }
  };

  w.bbNotifyRefreshSoundButtons = function () {
    var on = w.bbNotifySoundsEnabled();
    document.querySelectorAll('.bb-notify-sound-btn').forEach(function (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? '\uD83D\uDD0A' : '\uD83D\uDD07';
      btn.title = on ? 'Notification sounds on (click to mute)' : 'Notification sounds off (click to unmute)';
    });
  };

  function classify(n, isAdmin) {
    var id = String(n.id || '');
    var title = String(n.title || '');
    var desc = String(n.desc || '');
    var blob = (title + ' ' + desc).toLowerCase();
    if (id.indexOf('hyd-') === 0) return 'water';
    if (
      /\bwater\b|hydrat|h2o|💧|\d[\d.,]*\s*l\s+water|water\s*[\d.,]*\s*l|\d+\s*ml\s+water|water\s+\d|litres?\s+of\s+water|liters?\s+of\s+water|glasses?\s+of\s+water|hydration/i.test(
        blob
      )
    ) {
      return 'water';
    }
    if (isAdmin) return 'admin';
    return 'default';
  }

  function stateKey() {
    var u = w.currentUser || {};
    return String(u.id || 'anon') + ':' + String(u.role || '');
  }

  w.bbNotifyResetSoundState = function () {
    w._bbNotifySoundState = null;
    try {
      sessionStorage.removeItem(HINT_SESSION_KEY);
    } catch (e) {}
    hideUnlockHintBar();
  };

  function trimSet(s) {
    if (s.size <= MAX_SEEN) return;
    var arr = Array.from(s);
    var drop = arr.slice(0, arr.length - MAX_SEEN);
    drop.forEach(function (id) {
      s.delete(id);
    });
  }

  /**
   * Call after building the same `filtered` list as the bell (respects cleared ids).
   * First successful load per session seeds seen ids without playing. Later loads play for each new id.
   */
  w.bbNotifyProcessNewSounds = function (filtered, isAdmin) {
    filtered = Array.isArray(filtered) ? filtered : [];
    if (!w.bbNotifySoundsEnabled()) return;
    if (w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var key = stateKey();
    if (!w._bbNotifySoundState || w._bbNotifySoundState.key !== key) {
      w._bbNotifySoundState = { key: key, seen: new Set(), initialized: false };
    }
    var st = w._bbNotifySoundState;

    if (!st.initialized) {
      filtered.forEach(function (n) {
        if (n.id) st.seen.add(n.id);
      });
      st.initialized = true;
      trimSet(st.seen);
      return;
    }

    var newItems = filtered.filter(function (n) {
      return n.id && !st.seen.has(n.id);
    });
    filtered.forEach(function (n) {
      if (n.id) st.seen.add(n.id);
    });
    trimSet(st.seen);

    var maxPlay = isAdmin ? 12 : 6;
    newItems.sort(function (a, b) {
      return new Date(a.time) - new Date(b.time);
    });
    var slice = newItems.slice(-maxPlay);

    slice.forEach(function (n, i) {
      var kind = classify(n, isAdmin);
      setTimeout(function () {
        w.bbNotifyPlayKind(kind);
      }, i * 112);
    });
  };

  function unlockFromGesture() {
    resume();
    if (isAudioRunning()) {
      markHintDismissed();
      hideUnlockHintBar();
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener(
      'DOMContentLoaded',
      function () {
        ['click', 'touchstart'].forEach(function (evName) {
          document.body.addEventListener(evName, unlockFromGesture, { once: true, passive: true });
        });
      },
      { once: true }
    );
  }
})(window);
