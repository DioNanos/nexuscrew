'use strict';
// lib/audio/groups.js — gruppi audio LOCALI dell'origine.
//
// Un gruppo e' solo una preferenza di consegna: non pubblica un nodo, non
// modifica Share/visibility e non concede consenso audio. Ogni endpoint della
// lista viene comunque rivalutato dal proprio nodo quando riceve speak.
// Tenerlo in un file distinto da audio.json preserva lo schema chiuso del
// consenso ({audio:{consent}}) e impedisce che una nuova preferenza allenti un
// confine fisico gia' esistente.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const GROUP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NODE_ID_RE = /^[a-f0-9]{32}$/i;
const MODES = Object.freeze(['primary-failover', 'fanout']);
const MAX_TARGETS = 8;

function groupsPath(cfg = {}, home = (cfg && cfg.home) || os.homedir()) {
  if (cfg.audioGroupsPath) return cfg.audioGroupsPath;
  if (cfg.tokenPath) return path.join(path.dirname(cfg.tokenPath), 'audio-groups.json');
  return path.join(home, '.nexuscrew', 'audio-groups.json');
}

function emptyGroups() { return { schemaVersion: SCHEMA_VERSION, groups: {} }; }

function validName(name) { return typeof name === 'string' && GROUP_NAME_RE.test(name); }

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  if (Object.keys(spec).some((key) => !['targets', 'mode'].includes(key))) return null;
  if (!Array.isArray(spec.targets) || spec.targets.length < 1 || spec.targets.length > MAX_TARGETS) return null;
  if (!MODES.includes(spec.mode)) return null;
  const targets = spec.targets.map((value) => String(value || '').toLowerCase());
  if (targets.some((value) => !NODE_ID_RE.test(value))) return null;
  if (new Set(targets).size !== targets.length) return null;
  return { targets, mode: spec.mode };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== SCHEMA_VERSION) return emptyGroups();
  if (!raw.groups || typeof raw.groups !== 'object' || Array.isArray(raw.groups)) return emptyGroups();
  const groups = {};
  for (const [name, spec] of Object.entries(raw.groups)) {
    const normalized = validName(name) ? normalizeSpec(spec) : null;
    if (!normalized) return emptyGroups(); // configurazione corrotta = nessun gruppo, mai guess
    groups[name] = normalized;
  }
  return { schemaVersion: SCHEMA_VERSION, groups };
}

function readGroups(cfg = {}, home = (cfg && cfg.home) || os.homedir()) {
  try {
    const file = groupsPath(cfg, home);
    // Una preferenza audio non deve diventare un lettore di file arbitrari: un
    // symlink viene trattato come configurazione assente sia in lettura sia in
    // scrittura. In particolare non restituiamo mai il contenuto del target.
    if (fs.lstatSync(file).isSymbolicLink()) return emptyGroups();
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  catch (_) { return emptyGroups(); }
}

function atomicWrite(file, data) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing symlink audio groups path');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function listGroups(cfg = {}, home) {
  const store = readGroups(cfg, home);
  return Object.entries(store.groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => ({ name, targets: [...spec.targets], mode: spec.mode }));
}

function getGroup(cfg = {}, name, home) {
  if (!validName(name)) return null;
  const spec = readGroups(cfg, home).groups[name];
  return spec ? { name, targets: [...spec.targets], mode: spec.mode } : null;
}

function saveGroup(cfg = {}, name, spec, home) {
  if (!validName(name)) throw new Error('nome gruppo audio non valido');
  const normalized = normalizeSpec(spec);
  if (!normalized) throw new Error('gruppo audio non valido');
  const store = readGroups(cfg, home);
  store.groups[name] = normalized;
  atomicWrite(groupsPath(cfg, home), store);
  return { name, targets: [...normalized.targets], mode: normalized.mode };
}

function removeGroup(cfg = {}, name, home) {
  if (!validName(name)) throw new Error('nome gruppo audio non valido');
  const store = readGroups(cfg, home);
  if (!Object.prototype.hasOwnProperty.call(store.groups, name)) return false;
  delete store.groups[name];
  atomicWrite(groupsPath(cfg, home), store);
  return true;
}

module.exports = {
  SCHEMA_VERSION, GROUP_NAME_RE, NODE_ID_RE, MODES, MAX_TARGETS,
  groupsPath, emptyGroups, validName, normalizeSpec, readGroups, listGroups,
  getGroup, saveGroup, removeGroup,
};
