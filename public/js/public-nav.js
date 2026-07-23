/* ╔══════════════════════════════════════════════════════════════╗
   ║  PUBLIC FLOATING PILL BOTTOM NAV  (WhatsApp-style) — mobile   ║
   ║  Self-contained: injects its own <style> + markup.           ║
   ║  Shows on mobile (<=900px) for logged-out visitors browsing   ║
   ║  the marketing pages. Hides automatically inside any          ║
   ║  dashboard (body.site-nav-hidden).                            ║
   ║                                                               ║
   ║  To revert: delete this file + remove the one <script> line   ║
   ║  from each public page.                                        ║
   ║  To change tabs: edit the ITEMS array below.                   ║
   ╚══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  // ── The 4 destinations. Edit labels/href/match here to taste. ──────────────
  // match: substring tested against the current filename to set .active
  // action: optional; runs instead of navigating (return false to block nav)
  var ICONS = {
    home:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h3.5v-6h5v6H18a1 1 0 0 0 1-1V9.5"/></svg>',
    stories: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17.5" cy="9" r="2.2"/><path d="M16 14.5a4.5 4.5 0 0 1 4.5 5"/></svg>',
    blog:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a2 2 0 0 1 2 2v14l-3-2-3 2-3-2-3 2V6a2 2 0 0 1 2-2z" transform="translate(1 0)"/><path d="M9 8h6M9 12h6"/></svg>',
    about:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5.5 8 5 5 5.2v12C8 17 10.5 17.5 12 18.5"/><path d="M12 6.5C13.5 5.5 16 5 19 5.2v12C16 17 13.5 17.5 12 18.5"/><path d="M12 6.5v12"/></svg>',
    join:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3.2"/><path d="M4 20a6 6 0 0 1 12 0"/><path d="M19 8v6M22 11h-6"/></svg>'
  };

  var ITEMS = [
    { key: 'home',    label: 'Home',    icon: ICONS.home,    href: 'index.html#hero',     match: ['index.html', '/'] },
    { key: 'stories', label: 'Stories', icon: ICONS.stories, href: 'tribe-stories.html',  match: ['tribe-stories.html'] },
    { key: 'blog',    label: 'Blog',    icon: ICONS.blog,    href: 'blog.html',           match: ['blog.html'] },
    { key: 'about',   label: 'About',   icon: ICONS.about,   href: 'our-story.html',      match: ['our-story.html'] },
    {
      key: 'join', label: 'Join', icon: ICONS.join, href: '/signin', match: ['signin.html', 'signup.html'],
      action: function () {
        // Prefer the in-page login modal when it exists (index.html); on every
        // other page fall through to the standalone /signin page.
        if (typeof window.openModal === 'function' && document.getElementById('loginModal')) {
          window.openModal('loginModal');
          return false;
        }
        return true;
      }
    }
  ];

  // ── Styles ─────────────────────────────────────────────────────────────────
  var CSS = [
    '.pub-bottom-nav{display:none}',
    '@media(max-width:900px){',
    '  body:not(.site-nav-hidden) .pub-bottom-nav{',
    '    display:flex;position:fixed;left:0;right:0;',
    /* the site has a bare `nav{position:fixed;top:0}` rule — neutralise it so we anchor to the BOTTOM */
    '    top:auto!important;',
    '    width:calc(100% - 24px);max-width:460px;margin:0 auto;',
    '    bottom:calc(12px + max(0px,env(safe-area-inset-bottom,0px)))!important;',
    '    height:68px;z-index:9100;',
    /* BodyBank brand: site-black surface + gold hairline (matches the dashboard bottom nav) */
    '    background:#0d0d0d;',
    '    border:1px solid rgba(200,164,78,0.28);border-radius:34px;',
    '    box-shadow:0 14px 36px rgba(0,0,0,0.6),0 4px 12px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.04);',
    '    box-sizing:border-box;padding:8px 10px;',
    '  }',
    /* lift the green WhatsApp FAB above the pill so they don't collide */
    '  body:not(.site-nav-hidden) .wa-public-fab{bottom:calc(88px + env(safe-area-inset-bottom,0px))!important}',
    /* breathing room so the footer never hides permanently behind the pill */
    '  body:not(.site-nav-hidden){padding-bottom:calc(88px + env(safe-area-inset-bottom,0px))!important}',
    '}',
    '.pub-bottom-nav-inner{display:grid;grid-template-columns:repeat(5,1fr);align-items:stretch;width:100%;height:100%;column-gap:0}',
    '.pub-bottom-nav-item{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;',
    '  min-width:0;padding:0 2px;background:none;border:none;cursor:pointer;text-decoration:none;',
    "  color:#bfb9ab;font-family:'Outfit',-apple-system,sans-serif;font-size:11px;font-weight:600;letter-spacing:.2px;",
    '  -webkit-tap-highlight-color:transparent;transition:color .2s}',
    '.pub-bottom-nav-item:hover,.pub-bottom-nav-item:focus{color:#f2ece0;outline:none}',
    '.pub-bottom-nav-item.active{color:#c8a44e}',
    /* active state = soft gold chip behind the ICON only (the reference detail) */
    '.pub-bottom-nav-icon{display:flex;align-items:center;justify-content:center;min-width:50px;height:30px;border-radius:16px;transition:background .2s}',
    '.pub-bottom-nav-item.active .pub-bottom-nav-icon{background:rgba(200,164,78,0.16);border:1px solid rgba(200,164,78,0.30)}',
    '.pub-bottom-nav-icon svg{width:23px;height:23px;display:block}',
    '.pub-bottom-nav-label{line-height:1.1;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}'
  ].join('\n');

  function build() {
    if (document.querySelector('.pub-bottom-nav')) return; // guard against double-inject

    var style = document.createElement('style');
    style.id = 'pub-bottom-nav-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    var isRoot = page === '' || location.pathname === '/' || location.pathname.endsWith('/');

    // IMPORTANT: a <div>, NOT a <nav> — the site has aggressive bare-tag `nav{}`
    // rules (top:0, padding, align, background) that would hijack this element.
    var nav = document.createElement('div');
    nav.className = 'pub-bottom-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Primary');
    var inner = document.createElement('div');
    inner.className = 'pub-bottom-nav-inner';

    ITEMS.forEach(function (item) {
      var a = document.createElement('a');
      a.className = 'pub-bottom-nav-item';
      a.href = item.href;
      a.setAttribute('aria-label', item.label);

      var active = item.match.some(function (m) {
        if (m === '/') return isRoot;
        return page === m;
      });
      if (active) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }

      a.innerHTML =
        '<span class="pub-bottom-nav-icon">' + item.icon + '</span>' +
        '<span class="pub-bottom-nav-label">' + item.label + '</span>';

      if (item.action) {
        a.addEventListener('click', function (e) {
          if (item.action() === false) e.preventDefault();
        });
      }
      inner.appendChild(a);
    });

    nav.appendChild(inner);
    document.body.appendChild(nav);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
