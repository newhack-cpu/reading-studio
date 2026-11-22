const CACHE_NAME = 'tablet-reading-pwa-v6';
const CORE_ASSETS = [
  './',
  './index.html',
  './reading.css',
  './reading.js',
  './reading-bank.js',
  './listening-bank.js',
  './listening.js',
  './manifest.webmanifest',
  './lib/favicon.svg',
  './lib/deck.js',
  './lib/lookup-model.js',
  './lib/sync-model.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache GitHub API or DeepSeek API requests
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
  );
});
