'use strict';
const express = require('express');
const fs = require('node:fs');
const store = require('./store.js');

function httpError(status, message, extra) {
  const e = new Error(message); e.status = status; e.extra = extra; return e;
}

function decksRoutes({ cfg = {}, decksPath }) {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  const readonly = () => cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1';
  const mutate = (fn) => (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: mutazione deck bloccata' });
    try { return fn(req, res); }
    catch (e) { return res.status(e.status || 500).json({ error: String(e.message || e), ...(e.extra || {}) }); }
  };
  const read = () => {
    const found = store.loadStore(decksPath);
    if (found) return found;
    if (readonly() && !fs.existsSync(decksPath)) return store.emptyStore();
    return store.loadStoreStrict(decksPath);
  };
  const expected = (body) => {
    const n = body && body.expectedRevision;
    if (!Number.isSafeInteger(n) || n < 0) throw httpError(400, 'expectedRevision non valida');
    return n;
  };
  const find = (st, name) => st.decks.find((d) => d.name === name) || null;
  const checkRevision = (deck, rev) => {
    if (deck.revision !== rev) throw httpError(409, 'deck modificato da un’altra finestra', { current: deck });
  };

  r.get('/', (_req, res) => {
    try { res.json(read()); } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  r.post('/', mutate((req, res) => {
    const name = String(req.body && req.body.name || '');
    if (!store.NAME_RE.test(name)) throw httpError(400, 'nome deck non valido');
    const st = read();
    if (find(st, name)) throw httpError(409, `deck già esistente: ${name}`);
    if (st.decks.length >= store.MAX_DECKS) throw httpError(400, 'limite deck raggiunto');
    const deck = { name, revision: 0, layout: { columns: [] } };
    st.decks.push(deck); store.atomicWrite(decksPath, st);
    res.status(201).json(deck);
  }));
  r.put('/:name', mutate((req, res) => {
    const st = read(); const deck = find(st, String(req.params.name || ''));
    if (!deck) throw httpError(404, 'deck inesistente');
    checkRevision(deck, expected(req.body));
    const layout = store.parseLayout(req.body && req.body.layout);
    if (!layout) throw httpError(400, 'layout deck non valido');
    deck.layout = layout; deck.revision += 1;
    store.atomicWrite(decksPath, st); res.json(deck);
  }));
  r.patch('/:name', mutate((req, res) => {
    const oldName = String(req.params.name || '');
    if (oldName === 'main') throw httpError(400, 'main non rinominabile');
    const newName = String(req.body && req.body.name || '');
    if (!store.NAME_RE.test(newName)) throw httpError(400, 'nome deck non valido');
    const st = read(); const deck = find(st, oldName);
    if (!deck) throw httpError(404, 'deck inesistente');
    checkRevision(deck, expected(req.body));
    if (find(st, newName)) throw httpError(409, `deck già esistente: ${newName}`);
    deck.name = newName; deck.revision += 1;
    store.atomicWrite(decksPath, st); res.json(deck);
  }));
  r.delete('/:name', mutate((req, res) => {
    const name = String(req.params.name || '');
    if (name === 'main') throw httpError(400, 'main non eliminabile');
    const st = read(); const deck = find(st, name);
    if (!deck) throw httpError(404, 'deck inesistente');
    checkRevision(deck, expected(req.body));
    st.decks = st.decks.filter((d) => d.name !== name);
    store.atomicWrite(decksPath, st); res.json({ removed: true, name });
  }));
  return r;
}

module.exports = { decksRoutes };
