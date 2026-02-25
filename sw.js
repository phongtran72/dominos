// Service Worker — offline caching for Dominos PWA
var CACHE_NAME = 'dominos-v23';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './style-board.css',
  './game.js',
  './ai-old.js',
  './ai.js',
  './ai-worker.js',
  './ui.js',
  './ui-board.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './dominos_ai.js',
  './dominos_ai_bg.wasm',
  './dominos_ai_base64.js'
];

// Install: cache all assets
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
             .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first, fall back to cache (for offline support)
// This ensures users always get the latest version when online.
self.addEventListener('fetch', function (e) {
  e.respondWith(
    fetch(e.request).then(function (response) {
      // Update cache with fresh response
      var clone = response.clone();
      caches.open(CACHE_NAME).then(function (cache) {
        cache.put(e.request, clone);
      });
      return response;
    }).catch(function () {
      // Offline: serve from cache
      return caches.match(e.request);
    })
  );
});
