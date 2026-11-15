'use strict';

// ============================================================================
//  Service worker Shelter.
//  Стратегия network-first: в сети игрок всегда получает свежие файлы,
//  офлайн — последнюю успешно загруженную версию оболочки.
//  При изменении файлов игры поднимайте VERSION.
// ============================================================================

const VERSION = 'shelter-v1';
const CACHE_NAME = `shelter-shell-${VERSION}`;

const PRECACHE = [
    './',
    './index.html',
    './styles.css',
    './manifest.webmanifest',
    './firebase-config.js',
    './js/main.js',
    './js/config.js',
    './js/utils.js',
    './js/pwa.js',
    './js/game/engine.js',
    './js/net/backend.js',
    './js/net/firebase-backend.js',
    './js/net/host-controller.js',
    './js/net/room-service.js',
    './js/ui/dom.js',
    './js/ui/home.js',
    './js/ui/lobby.js',
    './js/ui/game.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png'
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // Каждый файл кладём отдельно: один отсутствующий URL не должен
        // ломать установку всего приложения.
        await Promise.all(PRECACHE.map(async url => {
            try {
                const response = await fetch(url, { cache: 'reload' });
                if (response.ok) await cache.put(url, response);
            } catch { /* офлайн-установка обойдётся без этого файла */ }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(key => key.startsWith('shelter-shell-') && key !== CACHE_NAME)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Навигация: сеть → кэш index.html (для любого ?room=...).
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request, './index.html'));
        return;
    }

    event.respondWith(networkFirst(request, null));
});

async function networkFirst(request, fallbackUrl) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        if (response && response.ok) {
            try { await cache.put(request, response.clone()); } catch { /* ignore */ }
        }
        return response;
    } catch (error) {
        const cached = await cache.match(request, { ignoreSearch: false });
        if (cached) return cached;
        if (fallbackUrl) {
            const fallback = await cache.match(fallbackUrl);
            if (fallback) return fallback;
        }
        throw error;
    }
}
