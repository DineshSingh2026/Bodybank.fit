/* BodyBank PWA Service Worker — bump CACHE_NAME on each deploy */
const CACHE_NAME = 'bodybank-v43';

self.addEventListener('install', () => {
  self.skipWaiting();
});

/* Push notifications — show banner even when app/website is closed */
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let title = 'Body Bank';
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
    requireInteraction: false,
    data: { url: '/', ...data }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url && clientList[i].focus) {
          clientList[i].navigate(url);
          return clientList[i].focus();
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
