const CACHE_NAME = 'syria-portal-v1';
const assets = ['/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(assets)));
});

self.addEventListener('fetch', canvasEvent => {
  canvasEvent.respondWith(
    caches.match(canvasEvent.request).then(res => res || fetch(canvasEvent.request))
  );
});
