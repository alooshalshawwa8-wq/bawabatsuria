const CACHE_NAME = 'syria-portal-v6';
const APP_BASE = new URL('./', self.location.href);
const APP_SHELL = ['', 'index.html', 'manifest.json', 'icon.svg', 'football.css', 'football.js',
  'assets/football/live.svg','assets/football/competitions.svg','assets/football/leaders.svg',
  'assets/football/clubs.svg','assets/football/players.svg','assets/football/match.svg',
  'assets/football/predict.svg','assets/football/tactics.svg','assets/football/dna.svg',
  'assets/football/moments.svg','assets/football/passport.svg','assets/football/academy.svg',
  'assets/football/derby.svg'
].map(path => new URL(path, APP_BASE).toString());

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
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
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return (await cache.match(new URL('index.html', self.registration.scope).toString())) || Response.error();
      }
      return Response.error();
    }
  })());
});