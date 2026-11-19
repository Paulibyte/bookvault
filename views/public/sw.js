// BookVault service worker: app shell + offline books
const STATIC = 'bv-static-v5';
const RUNTIME = 'bv-runtime-v5';
const BOOKS = 'bv-books';   // personalised PDFs the reader saved for offline use
const PAGES = 'bv-pages';   // reader pages saved for offline use

const PRECACHE = [
  '/offline',
  '/css/style.css?v=5', '/css/reader.css?v=5', '/js/app.js?v=5', '/js/reader.mjs?v=5',
  '/vendor/pdfjs/legacy/build/pdf.min.mjs', '/vendor/pdfjs/legacy/build/pdf.worker.min.mjs',
  '/icons/icon-192.png', '/icons/brand-mark.png', '/favicon.ico',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(STATIC).then(c => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  const keep = [STATIC, RUNTIME, BOOKS, PAGES];
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Saved books: always from the device when available
  if (/^\/read\/\d+\/file$/.test(url.pathname)) {
    e.respondWith(caches.open(BOOKS).then(c => c.match(url.pathname)).then(hit => hit || fetch(req)));
    return;
  }

  // Static assets: cache first
  if (/^\/(css|js|icons|vendor|cover)\//.test(url.pathname) || url.pathname === '/favicon.ico') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Pages: network first, fall back to saved reader pages or the offline shelf
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && /^\/read\/\d+$/.test(url.pathname)) {
        caches.open(PAGES).then(async c => { if (await c.match(url.pathname)) c.put(url.pathname, res.clone()); });
      }
      if (res.ok && url.pathname === '/offline') { const copy = res.clone(); caches.open(STATIC).then(c => c.put('/offline', copy)); }
      return res;
    }).catch(async () => {
      const page = await caches.open(PAGES).then(c => c.match(url.pathname));
      return page || caches.match('/offline');
    }));
  }
});
