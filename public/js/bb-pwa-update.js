/**
 * BodyBank PWA: service worker registration, update-available modal, refreshApp.
 * SW uses skipWaiting(); clients reload via modal or refresh button to pick up new assets.
 * Keep BUILD in sync with CACHE_NAME in /public/sw.js (bodybank-v43 → 43).
 */
(function () {
  'use strict';

  var BUILD = '43';
  var SW_URL = '/sw.js';

  function injectStyles() {
    if (document.getElementById('bb-pwa-update-styles')) return;
    var s = document.createElement('style');
    s.id = 'bb-pwa-update-styles';
    s.textContent =
      '#bb-update-modal.bb-pwa-modal-hidden{display:none!important}' +
      '#bb-update-modal{position:fixed;inset:0;z-index:100500;background:rgba(0,0,0,.82);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));box-sizing:border-box}' +
      '#bb-update-modal .bb-up-inner{max-width:380px;width:100%;background:#141414;border:1px solid rgba(200,164,78,.35);border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:center;font-family:inherit}' +
      '#bb-update-modal .bb-up-inner h3{margin:0 0 8px;color:#e4bb5a;font-size:1.15rem;font-weight:700}' +
      '#bb-update-modal .bb-up-inner p{margin:0 0 20px;color:#aaa;font-size:14px;line-height:1.45}' +
      '#bb-update-modal .bb-up-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}' +
      '#bb-update-modal button{border-radius:10px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:14px;border:none}' +
      '#bb-update-modal .bb-up-primary{background:linear-gradient(180deg,#e4bb5a,#c8a44e);color:#111}' +
      '#bb-update-modal .bb-up-secondary{background:transparent;border:1px solid #444!important;color:#ccc}';
    document.head.appendChild(s);
  }

  function ensureModal() {
    injectStyles();
    var el = document.getElementById('bb-update-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bb-update-modal';
    el.className = 'bb-pwa-modal-hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'bb-update-title');
    el.innerHTML =
      '<div class="bb-up-inner"><h3 id="bb-update-title">Update available</h3>' +
      '<p>A new version of BodyBank is ready. Refresh to get the latest fixes and features.</p>' +
      '<div class="bb-up-actions">' +
      '<button type="button" class="bb-up-primary" id="bb-update-apply">Refresh now</button>' +
      '<button type="button" class="bb-up-secondary" id="bb-update-later">Later</button>' +
      '</div></div>';
    document.body.appendChild(el);
    document.getElementById('bb-update-apply').addEventListener('click', function () {
      window.location.reload();
    });
    document.getElementById('bb-update-later').addEventListener('click', hideModal);
    return el;
  }

  function showModal() {
    ensureModal();
    var el = document.getElementById('bb-update-modal');
    if (el) {
      el.classList.remove('bb-pwa-modal-hidden');
      el.setAttribute('aria-hidden', 'false');
    }
  }

  function hideModal() {
    var el = document.getElementById('bb-update-modal');
    if (el) {
      el.classList.add('bb-pwa-modal-hidden');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  window.bbShowUpdateModal = function () {
    showModal();
  };

  /**
   * In-app / PWA header refresh: checks for a new service worker, then reloads.
   */
  window.refreshApp = async function (btn) {
    try {
      if (btn && btn.classList) btn.classList.add('is-spinning');
      if ('serviceWorker' in navigator) {
        var reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
    } catch (e) {
      /* ignore */
    }
    setTimeout(function () {
      window.location.reload();
    }, 120);
  };

  function onRegistration(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) {
      showModal();
    }
    reg.addEventListener('updatefound', function () {
      var w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', function () {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          showModal();
        }
      });
    });
    setInterval(function () {
      reg.update();
    }, 60 * 60 * 1000);
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      var reg = await navigator.serviceWorker.register(SW_URL + '?v=' + BUILD, { scope: '/' });
      onRegistration(reg);
    } catch (e) {
      /* ignore */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerSW);
  } else {
    registerSW();
  }
})();
