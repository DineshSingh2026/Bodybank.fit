/* BodyBank — member plan (Core · Guided · Tribe Elite) on the client.
 *
 * The server is the authority (services/plans.js gates every paid endpoint).
 * This file only mirrors the plan so the app can lock screens up front instead of
 * letting a member walk into an error:
 *   bbLoadPlan()          fetch /api/me/plan and apply locks
 *   bbSetPlan(plan)       accept a plan that arrived in another payload (member home)
 *   bbHasFeature(f)       true when unlocked (and while the plan is still loading)
 *   bbPlanGuard(f)        true to proceed; otherwise shows the lock sheet
 *   bbPlanGuardTab(tab)   same, keyed by member tab id (used by switchUserTab)
 *
 * Store policy: inside the iOS / Android apps the lock sheet names the plan and
 * nothing else — no price, no buy button, no link to a payment page (App Store
 * 3.1.1 and the Android store's payments policy). The website adds "Talk to your coach" and
 * "See plans". bbPlanIsNativeApp() decides which.
 */
(function () {
  'use strict';

  var COACH_WA = '919502575669';
  var TAB_FEATURE = { programs: 'workout_program', messages: 'coach_chat' };

  // Fallback copy until /api/me/plan answers (kept in step with services/plans.js).
  var CATALOG = {
    features: {
      blood_reports: { tier: 'guided', label: 'Blood report analysis' },
      nutrition_advice: { tier: 'guided', label: 'In-depth nutritional advice' },
      workout_program: { tier: 'guided', label: 'Custom workout program' },
      ai_trainer: { tier: 'guided', label: 'AI Trainer' },
      coach_chat: { tier: 'guided', label: 'Chat with your coach' },
      lifestyle_management: { tier: 'tribe_elite', label: 'Complete lifestyle management' },
      wearables: { tier: 'tribe_elite', label: 'Wearable insights (Whoop, Apple Health & more)' },
      progress_reports: { tier: 'tribe_elite', label: 'Progress reports' }
    },
    tiers: { core: 'Core', guided: 'Guided', tribe_elite: 'Tribe Elite' },
    order: ['core', 'guided', 'tribe_elite']
  };

  var state = { plan: null, loading: null };

  function isNativeApp() {
    try {
      if (window.IS_BODYBANK_APP === true) return true;
      var C = window.Capacitor;
      if (!C) return false;
      if (typeof C.isNativePlatform === 'function') return !!C.isNativePlatform();
      return !!(C.getPlatform && C.getPlatform() !== 'web');
    } catch (e) { return false; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isMember() {
    var u = window.currentUser;
    return !!(u && u.role === 'user');
  }

  function hasFeature(f) {
    if (!isMember()) return true;          // staff are never gated
    var p = state.plan;
    if (!p || !Array.isArray(p.features)) return true; // unknown yet: server still enforces
    return p.features.indexOf(f) !== -1;
  }

  function tierName(t) { return CATALOG.tiers[t] || 'Tribe Elite'; }

  function featureInfo(f) {
    return CATALOG.features[f] || { tier: 'guided', label: 'This feature' };
  }

  function setPlan(plan, catalog) {
    if (catalog && catalog.features && catalog.tiers) CATALOG = catalog;
    if (!plan || typeof plan !== 'object') return;
    var before = state.plan ? (state.plan.features || []).join(',') : null;
    state.plan = plan;
    try { if (window.currentUser) window.currentUser.plan = plan; } catch (e) { /* ignore */ }
    apply();
    // Cards drawn before the plan was known (or before an admin changed it) are
    // redrawn once, so a lock or unlock shows without a manual refresh.
    var after = (plan.features || []).join(',');
    if (before !== after) {
      try { if (typeof window.bbRdHomeLoad === 'function') window.bbRdHomeLoad(true); } catch (e) { /* ignore */ }
      try { if (typeof window.loadMyHealthReports === 'function') window.loadMyHealthReports(); } catch (e) { /* ignore */ }
      try { if (typeof window.renderMemberHome === 'function' && window.mhState && window.mhState.data) window.renderMemberHome(); } catch (e) { /* ignore */ }
    }
  }

  function loadPlan(force) {
    if (!isMember() || typeof window.apiCall !== 'function') return Promise.resolve(null);
    if (state.loading && !force) return state.loading;
    state.loading = window.apiCall('GET', '/api/me/plan').then(function (r) {
      if (r && r.plan) setPlan(r.plan, r.catalog);
      return state.plan;
    }).catch(function () { return state.plan; }).then(function (p) {
      state.loading = null;
      return p;
    });
    return state.loading;
  }

  // ── Visible state ──────────────────────────────────────────────────────────
  function apply() {
    if (!isMember()) return;
    Object.keys(TAB_FEATURE).forEach(function (tab) {
      var locked = !hasFeature(TAB_FEATURE[tab]);
      document.querySelectorAll('.user-sidebar-link[data-tab="' + tab + '"], .user-bottom-nav-item[data-tab="' + tab + '"]').forEach(function (el) {
        el.classList.toggle('bb-plan-locked', locked);
      });
    });
    var trainerLocked = !hasFeature('ai_trainer');
    document.querySelectorAll('#userPanel a[href*="ai-trainer.html"]').forEach(function (el) {
      el.classList.toggle('bb-plan-locked', trainerLocked);
    });
    document.querySelectorAll('[data-bb-plan-feature]').forEach(function (el) {
      el.classList.toggle('bb-plan-locked', !hasFeature(el.getAttribute('data-bb-plan-feature')));
    });
    var p = state.plan;
    document.querySelectorAll('[data-bb-plan-name]').forEach(function (el) {
      el.textContent = p ? p.name + ' Member' : '';
      el.hidden = !p;
    });
    document.querySelectorAll('[data-bb-plan-chip]').forEach(function (el) {
      el.innerHTML = p ? chipHtml(p) : '';
      el.hidden = !p;
    });
    // "Guided · renews in 12d" under the Profile's My Membership row.
    document.querySelectorAll('[data-bb-plan-summary]').forEach(function (el) {
      el.textContent = p ? summaryText(p) : 'Your plan and what it includes';
    });
  }

  function summaryText(p) {
    if (p.trial && p.days_left != null) return p.name + ' \u00B7 Trial \u00B7 ' + (p.days_left <= 0 ? 'ends today' : p.days_left + (p.days_left === 1 ? ' day left' : ' days left'));
    if (p.state === 'expired' || p.state === 'canceled') return p.name + ' \u00B7 ended';
    if (p.days_left != null) return p.name + ' \u00B7 ' + (p.days_left <= 0 ? 'ends today' : (p.days_left <= 7 ? 'ends in ' + p.days_left + (p.days_left === 1 ? ' day' : ' days') : 'active'));
    return p.name + ' \u00B7 active';
  }

  function chipHtml(p) {
    var extra = '';
    var ending = false;
    if (p.trial && p.days_left != null) {
      extra = ' · Trial · ' + (p.days_left <= 0 ? 'ends today' : p.days_left + (p.days_left === 1 ? ' day left' : ' days left'));
      ending = p.days_left <= 3;
    } else if ((p.state === 'active') && p.days_left != null && p.days_left <= 7) {
      extra = ' · ' + (p.days_left <= 0 ? 'ends today' : 'ends in ' + p.days_left + (p.days_left === 1 ? ' day' : ' days'));
      ending = true;
    }
    // A button: tapping the chip opens My Membership (js/member-screens.js).
    return '<button type="button" class="bb-plan-chip bb-plan-chip--' + esc(p.tier) + (ending ? ' bb-plan-chip--ending' : '') + '"' +
      ' onclick="if(window.bbxOpenMembership)bbxOpenMembership()" aria-label="' + esc(p.name + extra) + '. Open my membership">' +
      '<span class="bb-plan-chip-dot" aria-hidden="true"></span>' +
      esc(p.name) + esc(extra) +
      '<svg class="bb-plan-chip-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></button>';
  }

  // ── Lock sheet ─────────────────────────────────────────────────────────────
  function closeSheet() {
    var el = document.getElementById('bbPlanSheet');
    if (el) el.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }

  function showSheet(feature) {
    closeSheet();
    var info = featureInfo(feature);
    var need = tierName(info.tier);
    var cur = state.plan ? state.plan.name : null;
    var adds = Object.keys(CATALOG.features)
      .filter(function (k) { return CATALOG.features[k].tier === info.tier; })
      .map(function (k) { return CATALOG.features[k].label; });
    var native = isNativeApp();
    var waText = 'Hi BodyBank team, I would like to move to the ' + need + ' plan.';
    var actions = native
      ? '<button type="button" class="bb-plan-btn bb-plan-btn--primary" data-bb-plan-close>Got it</button>'
      : '<a class="bb-plan-btn bb-plan-btn--primary" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + COACH_WA + '?text=' + encodeURIComponent(waText) + '">Talk to your coach</a>' +
        '<a class="bb-plan-btn" href="/pricing.html" target="_blank" rel="noopener">See plans</a>' +
        '<button type="button" class="bb-plan-btn bb-plan-btn--ghost" data-bb-plan-close>Not now</button>';

    var wrap = document.createElement('div');
    wrap.id = 'bbPlanSheet';
    wrap.className = 'bb-plan-sheet-backdrop';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'bbPlanSheetTitle');
    wrap.innerHTML =
      '<div class="bb-plan-sheet">' +
        '<div class="bb-plan-sheet-icon" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
        '</div>' +
        '<p class="bb-plan-sheet-eyebrow">' + esc(need) + ' plan</p>' +
        '<h3 class="bb-plan-sheet-title" id="bbPlanSheetTitle">' + esc(info.label) + '</h3>' +
        '<p class="bb-plan-sheet-text">' + esc(info.label) + ' is part of the ' + esc(need) + ' plan' +
          (cur ? '. You’re on ' + esc(cur) + '.' : '.') + '</p>' +
        (adds.length ? '<ul class="bb-plan-sheet-list">' + adds.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="bb-plan-sheet-actions">' + actions + '</div>' +
      '</div>';
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || (e.target.closest && e.target.closest('[data-bb-plan-close]'))) closeSheet();
    });
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onKey, true);
    var first = wrap.querySelector('.bb-plan-btn');
    if (first) try { first.focus(); } catch (e) { /* ignore */ }
  }

  // A compact "this unlocks on <plan>" card, for home tiles whose feature is locked.
  function lockedCardHtml(feature, title, sub) {
    var info = featureInfo(feature);
    return '<div class="bb-plan-teaser">' +
      '<span class="bb-plan-teaser-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>' +
      '<span class="bb-plan-teaser-main"><b>' + esc(title || info.label) + '</b>' +
      '<i>' + esc(sub || info.label) + '</i></span>' +
      '<span class="bb-plan-teaser-tag">' + esc(tierName(info.tier)) + '</span></div>';
  }

  function guard(feature) {
    if (hasFeature(feature)) return true;
    showSheet(feature);
    return false;
  }

  function guardTab(tab) {
    var f = TAB_FEATURE[tab];
    return f ? guard(f) : true;
  }

  // A server 403 upgrade_required means our copy of the plan is stale (an admin
  // just changed it): refresh quietly. Callers that acted on a tap show the sheet.
  function noteUpgradeRequired(data) {
    if (!data || data.error !== 'upgrade_required') return false;
    if (state.plan && Array.isArray(state.plan.features) && data.feature) {
      state.plan.features = state.plan.features.filter(function (f) { return f !== data.feature; });
      apply();
    }
    loadPlan(true);
    return true;
  }

  // AI Trainer is a plain link in several places (sidebar, quick actions, home
  // tiles); one capturing listener covers them all.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="ai-trainer.html"]') : null;
    if (!a || !isMember()) return;
    if (!hasFeature('ai_trainer')) {
      e.preventDefault();
      e.stopPropagation();
      showSheet('ai_trainer');
    }
  }, true);

  // Coming back to the app (e.g. after an admin changed the plan) re-checks it.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && isMember() && state.plan) loadPlan(true);
  });

  // ── Styles (self-contained so every surface that loads this file gets them) ──
  var css =
    '.bb-plan-locked{position:relative}' +
    '.user-sidebar-link.bb-plan-locked,.bb-quick-btn.bb-plan-locked{opacity:.62}' +
    '.user-sidebar-link.bb-plan-locked::after,.bb-quick-btn.bb-plan-locked::after{content:"";display:inline-block;width:12px;height:12px;margin-left:auto;flex:0 0 auto;background:currentColor;opacity:.8;' +
      '-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27black%27 stroke-width=%272.2%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Crect x=%275%27 y=%2711%27 width=%2714%27 height=%2710%27 rx=%272%27/%3E%3Cpath d=%27M8 11V7a4 4 0 0 1 8 0v4%27/%3E%3C/svg%3E") center/contain no-repeat;' +
      'mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27black%27 stroke-width=%272.2%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Crect x=%275%27 y=%2711%27 width=%2714%27 height=%2710%27 rx=%272%27/%3E%3Cpath d=%27M8 11V7a4 4 0 0 1 8 0v4%27/%3E%3C/svg%3E") center/contain no-repeat}' +
    '.user-bottom-nav-item.bb-plan-locked .user-bottom-nav-icon{opacity:.55}' +
    '.user-bottom-nav-item.bb-plan-locked .user-bottom-nav-icon::after{content:"";position:absolute;right:-5px;bottom:-3px;width:11px;height:11px;border-radius:50%;background:#c8a44e;box-shadow:0 0 0 2px #0a0a0a}' +
    '.user-bottom-nav-item .user-bottom-nav-icon{position:relative}' +
    '.bb-plan-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.04em;line-height:1.3;border:1px solid rgba(200,164,78,.45);color:#d0b058;background:rgba(200,164,78,.08);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}' +
    '.bb-plan-chip-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}' +
    'button.bb-plan-chip{font-family:inherit;cursor:pointer;-webkit-appearance:none;appearance:none}' +
    'button.bb-plan-chip:focus-visible{outline:2px solid #f0d690;outline-offset:2px}' +
    '.bb-plan-chip-go{width:11px;height:11px;flex:0 0 auto;opacity:.75;margin-left:-1px}' +
    '.bb-plan-chip--ending{color:#f1b54b!important;border-color:rgba(241,181,75,.5)!important;background:rgba(241,181,75,.1)!important}' +
    '.bb-plan-chip--core{color:#bfb9ab;border-color:rgba(191,185,171,.35);background:rgba(191,185,171,.06)}' +
    '.bb-plan-chip--guided{color:#8fc7b0;border-color:rgba(143,199,176,.4);background:rgba(143,199,176,.07)}' +
    '.bb-plan-sheet-backdrop{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.62);display:flex;align-items:flex-end;justify-content:center;padding:16px;padding-bottom:max(16px,env(safe-area-inset-bottom));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}' +
    '@media (min-width:640px){.bb-plan-sheet-backdrop{align-items:center}}' +
    '.bb-plan-sheet{width:100%;max-width:420px;background:#141311;border:1px solid rgba(200,164,78,.28);border-radius:20px;padding:24px 20px 18px;color:#f2ece0;box-shadow:0 24px 60px rgba(0,0,0,.55);text-align:center;font-family:inherit}' +
    '.bb-plan-sheet-icon{width:44px;height:44px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#c8a44e;background:rgba(200,164,78,.12)}' +
    '.bb-plan-sheet-icon svg{width:22px;height:22px}' +
    '.bb-plan-sheet-eyebrow{margin:0 0 4px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#c8a44e;font-weight:600}' +
    '.bb-plan-sheet-title{margin:0 0 8px;font-size:20px;font-weight:600;color:#f2ece0}' +
    '.bb-plan-sheet-text{margin:0 0 14px;font-size:14px;line-height:1.5;color:#bfb9ab}' +
    '.bb-plan-sheet-list{list-style:none;margin:0 0 18px;padding:12px 14px;text-align:left;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}' +
    '.bb-plan-sheet-list li{position:relative;padding:5px 0 5px 22px;font-size:13.5px;color:#e6dfd1}' +
    '.bb-plan-sheet-list li::before{content:"";position:absolute;left:2px;top:10px;width:10px;height:6px;border-left:2px solid #c8a44e;border-bottom:2px solid #c8a44e;transform:rotate(-45deg)}' +
    '.bb-plan-sheet-actions{display:flex;flex-direction:column;gap:8px}' +
    '.bb-plan-btn{display:block;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:12px;font:inherit;font-size:14.5px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;border:1px solid rgba(200,164,78,.45);background:transparent;color:#d0b058}' +
    '.bb-plan-btn--primary{background:#c8a44e;border-color:#c8a44e;color:#141311}' +
    '.bb-plan-btn--ghost{border-color:transparent;color:#8a857a}' +
    '.bb-plan-btn:focus-visible{outline:2px solid #f2ece0;outline-offset:2px}' +
    '.mh-plan{margin-top:6px;min-width:0}' +
    '.mh-plan[hidden]{display:none}' +
    '.bb-plan-teaser{display:flex;align-items:center;gap:12px;padding:14px;text-align:left;min-width:0}' +
    '.bb-plan-teaser-ico{flex:0 0 auto;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#c8a44e;background:rgba(200,164,78,.12)}' +
    '.bb-plan-teaser-ico svg{width:17px;height:17px}' +
    '.bb-plan-teaser-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}' +
    '.bb-plan-teaser-main b{font-size:14px;font-weight:600;color:#f2ece0}' +
    '.bb-plan-teaser-main i{font-style:normal;font-size:12.5px;color:#8a857a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.bb-plan-teaser-tag{flex:0 0 auto;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#c8a44e;border:1px solid rgba(200,164,78,.4);border-radius:999px;padding:3px 8px}' +
    '.mh-navtile.bb-plan-locked{opacity:.7}' +
    '.mh-navtile.bb-plan-locked .mh-navmain i::before{content:"🔒  "}';
  try {
    var st = document.createElement('style');
    st.id = 'bbPlansCss';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  } catch (e) { /* ignore */ }

  window.bbPlanIsNativeApp = isNativeApp;
  window.bbLoadPlan = loadPlan;
  window.bbSetPlan = setPlan;
  window.bbGetPlan = function () { return state.plan; };
  window.bbHasFeature = hasFeature;
  window.bbPlanGuard = guard;
  window.bbPlanGuardTab = guardTab;
  // Label printed on share images under a member's name: "GUIDED MEMBER".
  // Member: their own plan. Staff: the client's plan from the loaded Memberships
  // list when it is there. Otherwise a neutral label — never a tier we can't vouch for.
  window.bbPlanCardLabel = function (userId) {
    var name = null;
    if (isMember()) {
      name = state.plan ? state.plan.name : null;
    } else if (userId != null && Array.isArray(window._bbMemberships)) {
      var row = window._bbMemberships.find(function (u) { return String(u.id) === String(userId); });
      if (row && row.plan_name) name = row.plan_name;
    }
    return (name ? name + ' Member' : 'BodyBank Member').toUpperCase();
  };
  window.bbPlanShowLock = showSheet;
  window.bbPlanLockedCardHtml = lockedCardHtml;
  window.bbPlanNoteUpgradeRequired = noteUpgradeRequired;
  window.bbApplyPlanLocks = apply;
  window.bbPlanReset = function () { state.plan = null; state.loading = null; closeSheet(); };
})();
