self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));

// Web Push del MCP bridge: payload JSON {title, body?, url?} dal server.
// tag fisso 'nexuscrew': le notifiche si sostituiscono invece di accumularsi.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { /* payload non JSON: ignora */ }
  const title = typeof data.title === 'string' && data.title ? data.title : 'NexusCrew';
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
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
