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

// Web Push del MCP bridge: payload JSON {title, body?, lang?, url?} dal server.
// tag fisso 'nexuscrew': le notifiche si sostituiscono invece di accumularsi.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { /* payload non JSON: ignora */ }
  const title = typeof data.title === 'string' && data.title ? data.title : 'NexusCrew';
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    ...(typeof data.lang === 'string' && data.lang ? { lang: data.lang } : {}),
    tag: 'nexuscrew',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  }));
});

// Click sulla notifica: focus di una finestra gia' aperta (deep-link via
// navigate) oppure apertura di una nuova su data.url (es. /#ask=<id>).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
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
