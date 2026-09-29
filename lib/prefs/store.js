'use strict';
// Preferenze di interfaccia (pin, ordine, viste, ordine nodi) per DISPOSITIVO, ospitate dal nodo.
// Servono a ritrovarle quando lo storage del browser viene svuotato. Non contengono mai token ne' diario:
// lo schema e' una whitelist. Un dispositivo e' un id opaco emesso DAL SERVER (non scelto dal client) e si
// presenta insieme al bearer: due telefoni con lo stesso token restano isolati.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_DEVICES = 64;
const DEVICE_RE = /^[a-f0-9]{32}$/;
const MAX_KEY = 192; const MAX_LIST = 256; const MAX_POSITIONS = 128;

function defaultPrefsPath(home) { return path.join(home || os.homedir(), '.nexuscrew', 'prefs.json'); }

const text = (s, max) => {
  if (typeof s !== 'string' || !s || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) { const c = s.charCodeAt(i); if (c <= 0x1f || c === 0x7f) return false; }
  return true;
};
const keyList = (v, max = MAX_LIST) => Array.isArray(v) && v.length <= max && v.every((k) => text(k, MAX_KEY));
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Ritorna i dati normalizzati oppure null. Chiavi sconosciute => rifiuto (niente campi liberi).
function parseData(raw) {
  if (!plain(raw)) return null;
  const allowed = new Set(['pins', 'orders', 'views', 'nodeOrder']);
  if (Object.keys(raw).some((k) => !allowed.has(k))) return null;
  const out = { pins: [], orders: {}, views: {}, nodeOrder: [] };
  if (raw.pins !== undefined) { if (!keyList(raw.pins)) return null; out.pins = [...new Set(raw.pins)]; }
  if (raw.nodeOrder !== undefined) { if (!keyList(raw.nodeOrder, 128)) return null; out.nodeOrder = [...new Set(raw.nodeOrder)]; }
  if (raw.orders !== undefined) {
    if (!plain(raw.orders) || Object.keys(raw.orders).length > MAX_POSITIONS) return null;
    for (const [pos, list] of Object.entries(raw.orders)) {
      if (!text(pos, 96) || !keyList(list)) return null;
      out.orders[pos] = [...new Set(list)];
    }
  }
  if (raw.views !== undefined) {
    if (!plain(raw.views) || Object.keys(raw.views).length > MAX_POSITIONS) return null;
    for (const [pos, v] of Object.entries(raw.views)) {
      if (!text(pos, 96) || !plain(v)) return null;
      const view = {};
      if (v.open !== undefined) { if (typeof v.open !== 'boolean') return null; view.open = v.open; }
      if (v.filter !== undefined) { if (!text(v.filter, 16)) return null; view.filter = v.filter; }
      out.views[pos] = view;
    }
  }
  return out;
}

const isEmpty = (d) => !d || (!d.pins.length && !d.nodeOrder.length && !Object.keys(d.orders).length && !Object.keys(d.views).length);

function emptyStore() { return { schemaVersion: SCHEMA_VERSION, devices: {} }; }

function parseStore(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!plain(obj) || obj.schemaVersion !== SCHEMA_VERSION || !plain(obj.devices)) return null;
    const devices = {};
    for (const [id, d] of Object.entries(obj.devices)) {
      if (!DEVICE_RE.test(id) || !plain(d) || !Number.isSafeInteger(d.revision) || d.revision < 0) return null;
      const data = d.data === null || d.data === undefined ? null : parseData(d.data);
      if (d.data && !data) return null;
      devices[id] = { createdAt: Number(d.createdAt) || 0, lastSeenAt: Number(d.lastSeenAt) || 0,
        revision: d.revision, updatedAt: Number(d.updatedAt) || 0, data };
    }
    return { schemaVersion: SCHEMA_VERSION, devices };
  } catch (_) { return null; }
}

function loadStore(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyStore(); throw e; }
  const parsed = parseStore(raw);
  if (!parsed) { const e = new Error('prefs.json non valido'); e.status = 503; throw e; }
  return parsed;
}

function atomicWrite(p, st) {
  try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('refuse symlink prefs.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const parsed = parseStore(st);
  if (!parsed) throw new Error('prefs.json non valido');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ } throw e; }
  return parsed;
}

// Emette un nuovo id dispositivo. Al limite fa posto scartando il piu' vecchio MAI USATO (nessun dato);
// se tutti hanno dati, rifiuta: mai cancellare preferenze di qualcuno per fare spazio.
function issueDevice(p, now = Date.now()) {
  const st = loadStore(p);
  const ids = Object.keys(st.devices);
  if (ids.length >= MAX_DEVICES) {
    const unused = ids.filter((id) => st.devices[id].revision === 0).sort((a, b) => st.devices[a].createdAt - st.devices[b].createdAt);
    if (!unused.length) { const e = new Error('limite dispositivi raggiunto'); e.status = 409; e.code = 'device-limit'; throw e; }
    delete st.devices[unused[0]];
  }
  const id = crypto.randomBytes(16).toString('hex');
  st.devices[id] = { createdAt: now, lastSeenAt: now, revision: 0, updatedAt: 0, data: null };
  atomicWrite(p, st);
  return id;
}

module.exports = { SCHEMA_VERSION, MAX_DEVICES, DEVICE_RE, defaultPrefsPath, parseData, isEmpty, emptyStore, loadStore, atomicWrite, issueDevice };
