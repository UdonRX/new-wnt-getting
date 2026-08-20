const CACHE_NAME = 'personal-dashboard-v2-14-15';

/*
 * v2.14.15
 * 追加CSS/補助moduleの1ファイル404だけでService Worker install全体が失敗しないよう、
 * cache.addAll()の一括失敗方式をやめる。
 */
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/src/styles/tokens.css',
  '/src/styles/base.css',
  '/src/styles/navigation.css',
  '/src/styles/screens.css',
  '/src/styles/v2141.css',
  '/src/styles/v21410.css',
  '/src/styles/v21411.css',
  '/src/styles/v21412.css',
  '/src/styles/v21413.css',
  '/src/styles/v21415.css',
  '/src/main.js',
  '/src/shared/icons.js',
  '/shared/paper-creative-keywords.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

async function precacheIndividually() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(APP_SHELL.map(async url => {
    try {
      const request = new Request(url, { cache: 'reload' });
      const response = await fetch(request);
      if (response?.ok) await cache.put(request, response.clone());
    } catch (error) {
      console.warn('[sw precache skip]', url, error?.message || error);
    }
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(
    precacheIndividually().finally(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.allSettled(
        keys
          .filter(key => key.startsWith('personal-dashboard-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request) {
  try {
    // Safari/PWAのHTTP cacheに古いmoduleが残るケースも避ける。
    const freshRequest = new Request(request, { cache: 'no-store' });
    const response = await fetch(freshRequest);
    if (response?.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    return (await caches.match(request)) ||
      (request.mode === 'navigate' ? caches.match('/index.html') : Response.error());
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API/外部通信はService Workerへ保存しない。
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => new Response('', {
        status: 503,
        statusText: 'Service Unavailable'
      }))
    );
    return;
  }

  // HTML/JS/CSSは常にネットワークを先に確認して新旧混在を防ぐ。
  if (
    request.mode === 'navigate' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.mjs') ||
    url.pathname.endsWith('.css') ||
    url.pathname === '/index.html' ||
    url.pathname === '/'
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 画像/manifest等はキャッシュ優先、無ければネットワーク。
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response?.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
      }
      return response;
    }))
  );
});
