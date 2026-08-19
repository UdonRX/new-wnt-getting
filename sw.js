const CACHE_NAME = 'personal-dashboard-v2-13';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/src/styles/tokens.css',
  '/src/styles/base.css',
  '/src/styles/navigation.css',
  '/src/styles/screens.css',
  '/src/main.js',
  '/shared/paper-creative-keywords.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API/外部通信は常にネットワーク。古いRSSやAI要約をService Workerに残さない。
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response('', { status:503, statusText:'Service Unavailable' })));
    return;
  }

  // HTML/JS/CSSはNetwork First。新しいデプロイを優先し、オフライン時だけキャッシュ。
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response?.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
  );
});
