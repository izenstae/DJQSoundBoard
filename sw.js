// Keeps the soundboard working offline (bad venue wifi). Network first so
// updates show up right away; falls back to the cached copy when offline.
const CACHE = 'djq-__BUILD__';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icon.svg', 'manifest.webmanifest', 'sounds/sounds.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    try {
      const list = await (await fetch('sounds/sounds.json')).json();
      await cache.addAll(list.map((s) => `sounds/${encodeURIComponent(s.file)}`));
    } catch { /* sounds get cached on first play instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
