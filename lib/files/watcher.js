'use strict';
// Osserva <root>/<sessione>/outbox per tutte le sessioni presenti su disco.
// fs.watch dove disponibile (con debounce); il polling periodico e' la rete
// di sicurezza che copre anche i filesystem dove fs.watch non funziona.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { listBox } = require('./store.js');

function createOutboxWatcher({ root, pollMs = 5000, debounceMs = 300 }) {
  const em = new EventEmitter();
  const watchers = new Map();
  const timers = new Map();
  const summary = {};
  let closed = false;

  function rescan(session) {
    if (closed) return;
    const files = listBox(root, session, 'outbox') || [];
    const snap = { count: files.length, latest: files.length ? files[0].mtime : 0 };
    const prev = summary[session];
    summary[session] = snap;
    if (!prev || prev.count !== snap.count || prev.latest !== snap.latest) {
      em.emit('change', session, files);
    }
  }

  function bump(session) {
    clearTimeout(timers.get(session));
    timers.set(session, setTimeout(() => rescan(session), debounceMs));
  }

  function ensureWatch(session) {
    if (watchers.has(session)) return;
    try {
      const w = fs.watch(path.join(root, session, 'outbox'), () => bump(session));
      w.on('error', () => { try { w.close(); } catch (_) {} watchers.delete(session); });
      watchers.set(session, w);
    } catch (_) { /* il polling copre */ }
  }

  function scanAll() {
    if (closed) return;
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (_) { return; }
    for (const session of names) { ensureWatch(session); rescan(session); }
  }

  scanAll();
  const timer = setInterval(scanAll, pollMs);
  if (timer.unref) timer.unref();

  return {
    on: (ev, fn) => em.on(ev, fn),
    getSummary: () => ({ ...summary }),
    close: () => {
      closed = true;
      clearInterval(timer);
      for (const t of timers.values()) clearTimeout(t);
      for (const w of watchers.values()) { try { w.close(); } catch (_) {} }
      watchers.clear();
    },
  };
}

module.exports = { createOutboxWatcher };
