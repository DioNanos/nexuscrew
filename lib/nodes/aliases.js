'use strict';
// Alias locali del viewer per nodi routed. Questo store non partecipa mai a
// topology, routing, ACL o federation: associa soltanto uno stable instanceId a
// un'etichetta di display scelta sul dispositivo che ospita la PWA.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const INSTANCE_ID_RE = /^[a-f0-9]{16,64}$/;
const ALIAS_MAX = 64;
const MAX_ALIASES = 128;
const MAX_FILE_BYTES = 16 * 1024;

function defaultAliasesPath(home = os.homedir()) {
  return path.join(home, '.nexuscrew', 'node-aliases.json');
}

function normalizeAlias(value) {
  if (typeof value !== 'string') return null;
  const alias = value.normalize('NFC').trim();
  if (!alias || alias.length > ALIAS_MAX) return null;
  // Cc/Cf includes newlines, NUL, bidi controls and invisible format chars.
  if (/[\p{Cc}\p{Cf}]/u.test(alias)) return null;
  return alias;
}

function emptyStore() {
  return { version: SCHEMA_VERSION, aliasesByInstanceId: {} };
}

function parseStore(raw) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !['version', 'aliasesByInstanceId'].includes(key))) return null;
  if (value.version !== SCHEMA_VERSION) return null;
  const aliases = value.aliasesByInstanceId;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return null;
  const entries = Object.entries(aliases);
  if (entries.length > MAX_ALIASES) return null;
  const out = {};
  for (const [instanceId, rawAlias] of entries) {
    const alias = normalizeAlias(rawAlias);
    if (!INSTANCE_ID_RE.test(instanceId) || alias === null || alias !== rawAlias) return null;
    out[instanceId] = alias;
  }
  return { version: SCHEMA_VERSION, aliasesByInstanceId: out };
}

function assertSafeTarget(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('node alias store must be a regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('node alias store permissions must be 0600');
    if (stat.size > MAX_FILE_BYTES) throw new Error('node alias store exceeds size limit');
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

function loadStore(filePath = defaultAliasesPath()) {
  if (!assertSafeTarget(filePath)) return emptyStore();
  const raw = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('node alias store exceeds size limit');
  const parsed = parseStore(raw);
  if (!parsed) throw new Error('invalid node alias store');
  return parsed;
}

function atomicWriteStore(filePath, store) {
  const parsed = parseStore(store);
  if (!parsed) throw new Error('invalid node alias store');
  const payload = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error('node alias store exceeds size limit');
  assertSafeTarget(filePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('node alias directory must be a regular directory');
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw error;
  }
  return parsed;
}

function setAlias(store, instanceId, value) {
  if (!INSTANCE_ID_RE.test(String(instanceId || ''))) throw new Error('instanceId non valido');
  const alias = normalizeAlias(value);
  if (alias === null) throw new Error('alias non valido (max 64 char, niente controlli)');
  const current = parseStore(store);
  if (!current) throw new Error('invalid node alias store');
  const aliasesByInstanceId = { ...current.aliasesByInstanceId, [instanceId]: alias };
  if (Object.keys(aliasesByInstanceId).length > MAX_ALIASES) throw new Error('troppi alias nodo');
  return { version: SCHEMA_VERSION, aliasesByInstanceId };
}

function deleteAlias(store, instanceId) {
  if (!INSTANCE_ID_RE.test(String(instanceId || ''))) throw new Error('instanceId non valido');
  const current = parseStore(store);
  if (!current) throw new Error('invalid node alias store');
  const aliasesByInstanceId = { ...current.aliasesByInstanceId };
  delete aliasesByInstanceId[instanceId];
  return { version: SCHEMA_VERSION, aliasesByInstanceId };
}

module.exports = {
  SCHEMA_VERSION, INSTANCE_ID_RE, ALIAS_MAX, MAX_ALIASES, MAX_FILE_BYTES,
  defaultAliasesPath, normalizeAlias, emptyStore, parseStore, loadStore,
  atomicWriteStore, setAlias, deleteAlias,
};
