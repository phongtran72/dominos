// Service Worker for Dominos 3P — network-first strategy
var CACHE_NAME = 'dominos-3p-v5';
var URLS = [
    './',
    './index.html',
    './style.css',
    './style-board.css',
    './game.js',
    './ai.js',
    './ui-board.js'
];

self.addEventListener('install', function (e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(URLS);
        })
    );
});

self.addEventListener('fetch', function (e) {
    e.respondWith(
        fetch(e.request).then(function (response) {
            // Network succeeded — update cache and return
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
                cache.put(e.request, clone);
            });
            return response;
        }).catch(function () {
            // Network failed — fall back to cache
            return caches.match(e.request);
        })
    );
});
