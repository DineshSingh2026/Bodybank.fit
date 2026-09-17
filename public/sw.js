/* BodyBank PWA Service Worker — bump CACHE_NAME on each deploy */
const CACHE_NAME = 'bodybank-v84';

self.addEventListener('install', () => {
  self.skipWaiting();
});

/* Push notifications — show banner even when app/website is closed */
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let title = 'BodyBank';
  let body = '';
  let data = {};
  try {
    const j = e.data.json();
    if (j) {
      title = j.title || title;
      body = j.body || j.desc || '';
      data = j;
    }
  } catch (_) {
    body = e.data.text() || '';
  }
  const opts = {
    body: (body || 'You have a new notification').substring(0, 200),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.id || 'bodybank-' + Date.now(),
    // A banner that replaces an earlier one with the same tag still alerts.
    renotify: !!data.id,
    timestamp: Date.now(),
    requireInteraction: false,
    data: { url: '/', ...data }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Tapping a banner lands on its screen. An open BodyBank tab is focused and told
// where to go (js/bb-notify.js routes it) — no reload, the session stays as is.
// With no tab open, the URL (/?open=… or /?group=…) carries the destination.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      const origin = self.location.origin;
      for (var i = 0; i < clientList.length; i++) {
        const c = clientList[i];
        if (c.url && c.url.indexOf(origin) === 0 && c.focus) {
          c.postMessage({ type: 'bb-open', link: data.link || '', url: url });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/reset-password') return;
  if (req.method !== 'GET') return;

  const isNavigation = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const isStaticCodeAsset = /\.(?:js|css)$/.test(url.pathname);

  if (isNavigation) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (!res || res.status !== 200 || res.type !== 'basic') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  if (isStaticCodeAsset) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (!res || res.status !== 200 || res.type !== 'basic') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || new Response('', { status: 503, statusText: 'Offline' }))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (!res || res.status !== 200 || res.type !== 'basic') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          return res;
        })
        .catch(() => new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
});
