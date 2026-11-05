/* My Manga Emporium offline support.
   App pages: network first, cached copy when offline (so updates still arrive).
   Store data snapshot + scanner library + fonts: cached after the first load.
   Book covers: cached as they're seen. Logins and account saves are never cached. */
const V = 'mme-v4';
const SHELL = ['./', 'index.html', 'help.html', 'privacy.html', 'config.json', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && !k.startsWith('mme-img') && k !== 'mme-badge').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req){
  const c = await caches.open(V);
  try { const r = await fetch(req, { cache: 'no-store' }); if (r && r.ok) c.put(req, r.clone()); return r; }
  catch (e){ const hit = await c.match(req, { ignoreSearch: true }); if (hit) return hit; if (req.mode === 'navigate') return c.match('index.html'); throw e; }
}
async function cacheFirst(req, name){
  const c = await caches.open(name || V); const hit = await c.match(req); if (hit) return hit;
  const r = await fetch(req); if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r;
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (/shopify\.com$/.test(u.hostname) && /\/(authentication|account)\//.test(u.pathname)) return;      // logins + account
  if (u.hostname === 'themagesemporium.com' && u.pathname.startsWith('/api/')) return;                   // live store checks
  if (u.origin === location.origin){ e.respondWith(networkFirst(req)); return; }
  if (u.hostname === 'cdn.shopify.com' && /\/files\/mme-snap-.*\.json$/.test(u.pathname)){ e.respondWith(caches.open(V).then(async c => { const hit = await c.match(req); if (hit) return hit; const r = await fetch(req); if (r && r.ok){ (await c.keys()).filter(k => /mme-snap-/.test(k.url) && k.url !== req.url).forEach(k => c.delete(k)); c.put(req, r.clone()); } return r; })); return; }
  if (u.hostname === 'cdn.jsdelivr.net' || /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)){ e.respondWith(cacheFirst(req)); return; }
  if (req.destination === 'image' && /cdn\.shopify\.com|covers\.openlibrary\.org|books\.google|googleusercontent/.test(u.hostname)){ e.respondWith(cacheFirst(req, 'mme-img').catch(() => fetch(req))); return; }
});

/* Push notifications (sent by the friends worker; payload {t, b, u, tag}) */
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (err) { m = { b: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(m.t || 'My Manga Emporium', { body: m.b || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: m.tag || 'mme', data: { u: m.u || './' } }),
    // app icon badge: count unseen notifications (the app resets it when opened)
    caches.open('mme-badge').then(async c => { const r = await c.match('/n'); const n = (r ? +(await r.text()) || 0 : 0) + 1; await c.put('/n', new Response(String(n))); if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n).catch(() => {}); }).catch(() => {})
  ]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const u = new URL((e.notification.data && e.notification.data.u) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => { const w = ws.find(x => x.url.startsWith(self.registration.scope)); if (w){ w.focus(); return w.navigate ? w.navigate(u).catch(() => {}) : null; } return clients.openWindow(u); }));
});
