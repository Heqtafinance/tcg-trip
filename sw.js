/* Cache hors ligne de l'app (le code seulement, jamais les données). */
const CACHE = 'blueline-v1.1.0';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'icons.js', 'manifest.webmanifest',
  'vendor/exceljs.min.js', 'vendor/jszip.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API taux de change : réseau direct
  // Cache d'abord (rapide même avec un réseau faible), mise à jour en arrière-plan
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || c.match('index.html');
  }));
});
