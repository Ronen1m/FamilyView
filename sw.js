/* Makes the dashboard installable and lets it open without internet.
   - On install, saves the whole app (pages, code, libraries, icons, data) on the device.
   - Always tries the network first (so updates show immediately), but gives up after a few
     seconds and uses the saved copy – so a weak / missing connection never leaves a blank screen. */
const CACHE = 'familyview-v4';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'app.js', 'import.js', 'solar.js', 'retire.js',
  'vendor/chart.umd.js', 'vendor/xlsx.full.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  'data/data.enc.json', 'data/demo.json',
];
const scopePath = new URL(self.registration.scope).pathname; // e.g. /FamilyView/

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u =>
    fetch(new Request(u, {cache:'reload'})).then(r => r.ok && c.put(keyOf(new URL(u, self.registration.scope)), r)).catch(() => {})
  ))));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('familyview-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

// one key per file: ignore ?v= / ?source= and treat /FamilyView/index.html as /FamilyView/
function keyOf(url){ const p = url.pathname; return p === scopePath + 'index.html' ? scopePath : p; }
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com$/;

function withTimeout(p, ms){ return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); }); }

// once the network failed or was too slow, use the saved copy straight away for a while
// (so a weak connection costs one short wait, not a wait per file)
let badUntil = 0;
const netBad = () => navigator.onLine === false || Date.now() < badUntil;
const markBad = () => { badUntil = Date.now() + 30000; };

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google fonts: saved copy first; without one, give up quickly (the app falls back to system fonts)
  if (FONTS.test(url.origin)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(req.url).then(hit => {
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req.url, r.clone()); return r; });
      net.catch(() => {});
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      if (netBad()) return Response.error();
      return withTimeout(net, 2500).catch(() => { markBad(); return Response.error(); });
    })));
    return;
  }
  if (url.origin !== location.origin) return; // GitHub API goes straight to the network

  const nav = req.mode === 'navigate';
  const key = nav ? scopePath : keyOf(url);
  const fromCache = () => caches.open(CACHE).then(c => c.match(key)).then(r => r || caches.match(key, {ignoreSearch:true}));
  const net = fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); return caches.open(CACHE).then(c => c.put(key, copy)).then(() => r, () => r); }
    return r;
  });
  net.catch(() => {});
  if (netBad()) { // known bad connection: saved copy now, refresh in the background if the network comes back
    e.respondWith(fromCache().then(r => { if (r) { e.waitUntil(net.catch(() => {})); return r; } return net; }));
    return;
  }
  e.respondWith(
    withTimeout(net, 3000)
      .catch(() => { markBad(); return fromCache().then(r => r || net); }) // nothing saved yet → keep waiting for the network
  );
});
