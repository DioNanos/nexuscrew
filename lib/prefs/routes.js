'use strict';
const express = require('express');
const store = require('./store.js');

function httpError(status, message, extra) { const e = new Error(message); e.status = status; e.extra = extra; return e; }

// Montato sotto /api (gia' dietro il bearer). Ogni richiesta porta anche X-NC-Device: l'id emesso dal server.
function prefsRoutes({ cfg = {}, prefsPath }) {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  const readonly = () => cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1';
  const wrap = (fn, { write = false } = {}) => (req, res) => {
    if (write && readonly()) return res.status(403).json({ error: 'READONLY: mutazione preferenze bloccata' });
    try { return fn(req, res); } catch (e) { return res.status(e.status || 500).json({ error: String(e.message || e), ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) }); }
  };
  const deviceOf = (req, st) => {
    const id = String(req.get('x-nc-device') || '');
    if (!store.DEVICE_RE.test(id)) throw httpError(400, 'dispositivo mancante o non valido', { code: 'bad-device' });
    if (!st.devices[id]) throw httpError(404, 'dispositivo sconosciuto', { code: 'unknown-device' });
    return id;
  };

  r.post('/devices', wrap((_req, res) => {
    res.status(201).json({ deviceId: store.issueDevice(prefsPath) });
  }, { write: true }));

  r.get('/', wrap((req, res) => {
    const st = store.loadStore(prefsPath); const id = deviceOf(req, st); const d = st.devices[id];
    res.set('ETag', `"${d.revision}"`);
    res.json({ deviceId: id, revision: d.revision, updatedAt: d.updatedAt, data: d.data });
  }));

  r.put('/', wrap((req, res) => {
    const st = store.loadStore(prefsPath); const id = deviceOf(req, st); const d = st.devices[id];
    const match = String(req.get('if-match') || '').match(/^"(\d+)"$/);
    if (!match) throw httpError(428, 'If-Match richiesto', { code: 'if-match-required' });
    if (Number(match[1]) !== d.revision) throw httpError(409, 'preferenze modificate altrove', { code: 'revision-conflict', current: { revision: d.revision, data: d.data } });
    const data = store.parseData(req.body && req.body.data);
    if (!data) throw httpError(422, 'preferenze non valide', { code: 'bad-schema' });
    // Mai default vuoti sopra valori esistenti: una copia vuota non sostituisce una piena.
    if (store.isEmpty(data) && !store.isEmpty(d.data)) throw httpError(422, 'copia vuota sopra preferenze esistenti', { code: 'refuse-empty-overwrite' });
    const now = Date.now();
    d.revision += 1; d.updatedAt = now; d.lastSeenAt = now; d.data = data;
    store.atomicWrite(prefsPath, st);
    res.set('ETag', `"${d.revision}"`);
    res.json({ deviceId: id, revision: d.revision, updatedAt: d.updatedAt });
  }, { write: true }));

  return r;
}

module.exports = { prefsRoutes };
