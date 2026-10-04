/* Makes the dashboard installable and lets it open without internet.
   Always tries the network first (so updates show immediately) and falls back to the last saved copy. */
const CACHE = 'familyview-v2';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GitHub API and fonts go straight to the network
  const key = url.pathname; // ignore ?v= cache-busting so the offline copy is found
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.open(CACHE).then(c => c.match(key)).then(r => r || caches.match(key)))
  );
});
