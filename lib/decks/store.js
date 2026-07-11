'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_DECKS = 24;
const MAX_TILES = 9;
const NAME_RE = /^[a-z0-9-]{1,32}$/;
const NODE_RE = /^[a-z0-9-]{1,32}(?:\/[a-z0-9-]{1,32}){0,3}$/;

function validNodeRoute(node) {
  if (!NODE_RE.test(node)) return false;
  const parts = node.split('/');
  return new Set(parts).size === parts.length;
}

function defaultDecksPath(home) {
  return path.join(home || os.homedir(), '.nexuscrew', 'decks.json');
}

function emptyLayout() { return { columns: [] }; }
function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, decks: [{ name: 'main', revision: 0, layout: emptyLayout() }] };
}

function validText(s, max) {
  if (typeof s !== 'string' || !s || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

function parseLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.columns)) return null;
  if (raw.columns.length > MAX_TILES) return null;
  const seen = new Set();
  const columns = [];
  let count = 0;
  for (const c of raw.columns) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || !Array.isArray(c.tiles) || !c.tiles.length) return null;
    const width = Number(c.width);
    if (!Number.isFinite(width) || width < 0.2 || width > 100) return null;
    const tiles = [];
    for (const t of c.tiles) {
      if (!t || typeof t !== 'object' || Array.isArray(t) || !validText(t.session, 128)) return null;
      if (t.node !== undefined && (typeof t.node !== 'string' || !validNodeRoute(t.node))) return null;
      const height = Number(t.height);
      const fontSize = Number(t.fontSize);
      if (!Number.isFinite(height) || height < 0.2 || height > 100) return null;
      if (!Number.isFinite(fontSize) || fontSize < 9 || fontSize > 24) return null;
      const key = t.node ? `${t.node}:${t.session}` : t.session;
      if (seen.has(key) || ++count > MAX_TILES) return null;
      seen.add(key);
      const tile = { session: t.session, height, fontSize };
      if (t.node) tile.node = t.node;
      tiles.push(tile);
    }
    columns.push({ width, tiles });
  }
  return { columns };
}

function parseStore(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)
      || obj.schemaVersion !== SCHEMA_VERSION || !Array.isArray(obj.decks)
      || obj.decks.length < 1 || obj.decks.length > MAX_DECKS) return null;
    const names = new Set();
    const decks = [];
    for (const d of obj.decks) {
      if (!d || typeof d !== 'object' || !NAME_RE.test(d.name) || names.has(d.name)) return null;
      if (!Number.isSafeInteger(d.revision) || d.revision < 0) return null;
      const layout = parseLayout(d.layout);
      if (!layout) return null;
      names.add(d.name);
      decks.push({ name: d.name, revision: d.revision, layout });
    }
    if (!names.has('main')) return null;
    decks.sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name)));
    return { schemaVersion: SCHEMA_VERSION, decks };
  } catch (_) { return null; }
}

function loadStore(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return parseStore(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function atomicWrite(p, data) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error('refuse symlink decks.json');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const parsed = parseStore(data);
  if (!parsed) throw new Error('decks.json non valido');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  return parsed;
}

function loadOrCreate(p) {
  const found = loadStore(p);
  if (found) return found;
  try { if (fs.existsSync(p)) throw new Error('decks.json presente ma invalido'); } catch (e) { throw e; }
  return atomicWrite(p, emptyStore());
}

module.exports = {
  SCHEMA_VERSION, MAX_DECKS, MAX_TILES, NAME_RE,
  defaultDecksPath, emptyStore, parseLayout, parseStore, loadStore, loadOrCreate, atomicWrite,
};
