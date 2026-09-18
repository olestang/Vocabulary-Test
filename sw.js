const CACHE = 'vg1-vocab-static-v12';
const ASSETS = [
  './', './index.html', './become-teacher/', './become-teacher/index.html', './submit/', './submit/index.html', './teacher/', './teacher/index.html', './results/', './results/index.html', './history/', './history/index.html', './diagnostics/', './diagnostics/index.html',
  './styles/main.css', './assets/logo.svg',
  './config/class-roster.json', './config/vocabulary.json', './config/tests.json', './config/public-security.js',
  './scripts/config.js', './scripts/header.js', './scripts/submission-router.js', './scripts/unlock-codes.js', './scripts/page-become-teacher.js', './scripts/utilities.js', './scripts/data.js', './scripts/grading.js', './scripts/cryptography.js', './scripts/storage.js',
  './scripts/page-test.js', './scripts/page-submit.js', './scripts/page-teacher.js', './scripts/page-results.js', './scripts/page-history.js', './scripts/page-diagnostics.js', './scripts/register-service-worker.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    })
  );
});
