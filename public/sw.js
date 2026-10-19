/* AgriDrone service worker - offline mode.
 *  - app page:      network first (4 s), falls back to the saved copy
 *  - /model/*:      saved on first use; model.json/labels.json are re-checked, shards reused until model.json changes
 *  - TF.js + fonts: saved on first use (cache first)
 *  - /api/*:        never touched (the app keeps its own offline queue and syncs later)
 * Change VERSION to force every phone to refresh the saved app files. */
const VERSION = 'v1';
const SHELL = 'agri-shell-' + VERSION, RT = 'agri-rt-' + VERSION, MODEL = 'agri-model';
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon-192.png'];
const CDN = /^(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => (k.startsWith('agri-shell-') && k !== SHELL) || (k.startsWith('agri-rt-') && k !== RT)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchTimeout(req, ms) {
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); ok(r); }, (e) => { clearTimeout(t); no(e); });
  });
}
async function page(req) {
  const c = await caches.open(SHELL);
  try {
    const r = await fetchTimeout(req, 4000);
    if (r.ok) c.put('/', r.clone());
    return r;
  } catch (_) {
    return (await c.match('/')) || new Response('Offline - open the app once with internet first.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
async function model(req, url) {
  const c = await caches.open(MODEL);
  if (/\/(model|labels)\.json$/.test(url.pathname)) {
    try {
      const r = await fetchTimeout(req, 5000);
      if (r.ok) {
        if (url.pathname.endsWith('model.json')) {        // a retrained model has new shards: drop the old ones
          const old = await c.match(req);
          if (old && (await old.clone().text()) !== (await r.clone().text())) for (const k of await c.keys()) if (k.url.endsWith('.bin')) await c.delete(k);
        }
        await c.put(req, r.clone());
        return r;
      }
      if (r.status === 404) { await c.delete(req); return r; }   // model was removed on the server
    } catch (_) { /* offline or slow: use the saved copy */ }
    return (await c.match(req)) || Response.error();
  }
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
}
async function cdn(req) {
  const c = await caches.open(RT);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') return e.respondWith(page(req));
    if (url.pathname.startsWith('/model/')) return e.respondWith(model(req, url));
    if (SHELL_URLS.includes(url.pathname) || url.pathname === '/icon-512.png') return e.respondWith(caches.match(req).then((h) => h || fetch(req)));
    return;
  }
  if (CDN.test(url.hostname)) e.respondWith(cdn(req));
});
