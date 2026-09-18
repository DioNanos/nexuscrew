self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));

// applyUpdate() (lib/sw-update.js) manda questo messaggio a un worker in
// waiting e aspetta il `controllerchange`. Senza un listener il messaggio
// cadeva nel vuoto: scattava il reload di fallback, il worker restava in
// waiting, e al ricaricamento `reg.waiting` faceva ricomparire il banner —
// "nuova versione disponibile" per sempre, e il bottone non poteva spegnerlo.
// Un worker installato da una versione precedente di questo file resta in
// waiting fino a che non lo si attiva: e' quello il caso che si incastrava.
self.addEventListener('message', (e) => {
  if (e && e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// --- OS alerts for imported events ------------------------------------------
// The payload is untrusted input: the link is only ever a LOCAL path, the alert
// identity is (owner, eventId) when the payload carries a well-formed pair, and
// a local registry keeps one already-seen event from ringing twice — including
// after the worker is restarted. A legacy payload without an id still works: it
// keeps the single fixed tag, so the OS replaces instead of stacking.
const LEGACY_TAG = 'nexuscrew';
const ALERT_DB = 'nc-sw-alerts';
const ALERT_STORE = 'alerts';
const ALERT_TTL_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const TAG_RE = /^nc:[A-Za-z0-9._:-]{1,64}:[A-Za-z0-9._:-]{1,64}$/;

// A local, same-origin path only: no scheme, no protocol-relative host, no
// backslash tricks. Anything else is dropped in favour of the app root.
function safeLocalPath(url) {
  if (typeof url !== 'string' || !url) return null;
  if (url[0] !== '/' || url[1] === '/' || url[1] === '\\') return null;
  if (url.includes('\\') || url.includes('\n') || url.includes('\r')) return null;
  return url;
}

function alertKey(data) {
  const owner = typeof data.ownerId === 'string' && ID_RE.test(data.ownerId) ? data.ownerId : '';
  const eventId = typeof data.eventId === 'string' && ID_RE.test(data.eventId) ? data.eventId : '';
  return eventId ? `${owner}:${eventId}` : null;
}

function openAlertsDb() {
  return new Promise((resolve) => {
    try {
      if (!self.indexedDB) { resolve(null); return; }
      const req = self.indexedDB.open(ALERT_DB, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(ALERT_STORE); } catch (_) { /* exists */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

function withStore(db, mode, run) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(ALERT_STORE, mode);
      const out = run(tx.objectStore(ALERT_STORE));
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : true);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

// true = this exact event was already alerted; the caller then stays silent.
async function alreadyAlerted(key) {
  if (!key) return false;
  const db = await openAlertsDb();
  if (!db) return false;
  const at = await withStore(db, 'readonly', (store) => store.get(key));
  try { db.close(); } catch (_) { /* nothing to do */ }
  if (typeof at !== 'number') return false;
  return (Date.now() - at) < ALERT_TTL_MS;
}

async function rememberAlerted(key) {
  if (!key) return false;
  const db = await openAlertsDb();
  if (!db) return false;
  const ok = await withStore(db, 'readwrite', (store) => store.put(Date.now(), key));
  try { db.close(); } catch (_) { /* nothing to do */ }
  return ok !== null;
}

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { /* payload non JSON: ignora */ }
  const title = typeof data.title === 'string' && data.title ? data.title : 'NexusCrew';
  const body = typeof data.body === 'string' ? data.body : '';
  const url = safeLocalPath(data.url) || '/';
  const key = alertKey(data);
  const tag = typeof data.tag === 'string' && TAG_RE.test(data.tag) ? data.tag : LEGACY_TAG;
  e.waitUntil((async () => {
    if (await alreadyAlerted(key)) return; // this event already rang once
    await rememberAlerted(key); // registered BEFORE showing: no double alert
    await self.registration.showNotification(title, {
      body,
      ...(typeof data.lang === 'string' && data.lang ? { lang: data.lang } : {}),
      tag,
      data: { url },
    });
  })());
});

// Click sulla notifica: focus di una finestra gia' aperta (deep-link via
// navigate) oppure apertura di una nuova su data.url. Solo percorso locale:
// l'URL arriva dal payload e non deve poter portare fuori dall'app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = safeLocalPath(e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if ('focus' in w) {
        if ('navigate' in w) w.navigate(url).catch(() => {});
        return w.focus();
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
  }));
});
