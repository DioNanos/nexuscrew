'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { NODE_ID_RE, NODE_NAME_RE } = require('./store.js');

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_HOPS = 4;

function defaultPath(home = os.homedir()) {
  return path.join(home, '.nexuscrew', 'topology-cache.json');
}

function parseEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.some((k) => !['instanceId', 'lastSeen', 'name', 'route'].includes(k))) return null;
  if (!NODE_ID_RE.test(raw.instanceId) || !NODE_NAME_RE.test(raw.name)) return null;
  if (!Array.isArray(raw.route) || raw.route.length < 2 || raw.route.length > MAX_HOPS) return null;
  if (raw.route.some((x) => !NODE_NAME_RE.test(x)) || new Set(raw.route).size !== raw.route.length) return null;
  if (raw.name !== raw.route[raw.route.length - 1]) return null;
  if (!Number.isInteger(raw.lastSeen) || raw.lastSeen < 0) return null;
  return { instanceId: raw.instanceId, name: raw.name, route: [...raw.route], lastSeen: raw.lastSeen };
}

function parseCache(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.nodes) || value.nodes.length > MAX_ENTRIES) return null;
  if (Object.keys(value).some((k) => !['schemaVersion', 'nodes'].includes(k))) return null;
  const nodes = value.nodes.map(parseEntry);
  if (nodes.some((x) => !x)) return null;
  if (new Set(nodes.map((x) => x.instanceId)).size !== nodes.length) return null;
  if (new Set(nodes.map((x) => x.route.join('/'))).size !== nodes.length) return null;
  return { schemaVersion: SCHEMA_VERSION, nodes };
}

function emptyCache() { return { schemaVersion: SCHEMA_VERSION, nodes: [] }; }

function loadCache(file = defaultPath()) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return parseCache(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? emptyCache() : null;
  }
}

function atomicWriteCache(file, value) {
  const parsed = parseCache(value);
  if (!parsed) throw new Error('topology cache non valida');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing symlink topology cache target');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  return parsed;
}

module.exports = { SCHEMA_VERSION, MAX_ENTRIES, MAX_HOPS, defaultPath, parseEntry, parseCache, emptyCache, loadCache, atomicWriteCache };
