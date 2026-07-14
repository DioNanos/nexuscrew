'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PACKAGE_NAME = require('../../package.json').name;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value) {
  const m = VERSION_RE.exec(String(value || '').trim());
  if (!m) return null;
  return {
    raw: m[0],
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function compareIdentifier(a, b) {
  const an = /^[0-9]+$/.test(a);
  const bn = /^[0-9]+$/.test(b);
  if (an && bn) return Number(a) === Number(b) ? 0 : Number(a) > Number(b) ? 1 : -1;
  if (an !== bn) return an ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) throw new Error('versione semver non valida');
  for (const key of ['major', 'minor', 'patch']) {
    if (av[key] !== bv[key]) return av[key] > bv[key] ? 1 : -1;
  }
  if (!av.prerelease.length && !bv.prerelease.length) return 0;
  if (!av.prerelease.length) return 1;
  if (!bv.prerelease.length) return -1;
  const n = Math.max(av.prerelease.length, bv.prerelease.length);
  for (let i = 0; i < n; i += 1) {
    if (av.prerelease[i] === undefined) return -1;
    if (bv.prerelease[i] === undefined) return 1;
    const c = compareIdentifier(av.prerelease[i], bv.prerelease[i]);
    if (c) return c;
  }
  return 0;
}

function registryVersion(stdout) {
  const raw = String(stdout || '')
    .replace(/^\uFEFF/, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const parsed = parseVersion(value);
    if (parsed) candidates.push(parsed.raw);
  };
  try {
    const decoded = JSON.parse(raw);
    if (typeof decoded === 'string') add(decoded);
    else if (Array.isArray(decoded)) decoded.forEach(add);
    else if (decoded && typeof decoded === 'object') add(decoded.version);
  } catch (_) {
    // npm versions differ in whether --json returns a JSON scalar or a plain
    // line.  Notices may also precede the value, so inspect complete lines but
    // never extract a semver from the middle of arbitrary text.
    for (const line of raw.split(/\r?\n/)) add(line.trim().replace(/^['"]|['"]$/g, ''));
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw new Error('npm ha restituito una versione non valida');
  return unique[0];
}

function stableRuntimeDir(home) {
  const dir = path.join(path.resolve(String(home || '')), '.nexuscrew');
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('directory runtime NexusCrew non sicura');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function scrubError(error) {
  return String((error && error.message) || error || 'errore sconosciuto')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://***@')
    .replace(/\/(?:home|Users|data\/data\/com\.termux\/files\/home)\/[^\s:]+/g, '<local-path>')
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{40,}/gi, '***')
    .slice(0, 300);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && Number.isInteger(value.pid) && typeof value.token === 'string' ? value : null;
  } catch (_) { return null; }
}

function writeLock(file, value, flags = 'wx') {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: flags, mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function acquireUpdateLock(file, pid = process.pid, token = crypto.randomBytes(16).toString('hex')) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { writeLock(file, { pid, token, createdAt: Date.now() }); return { ok: true, token }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const current = readLock(file);
      if (current && pidAlive(current.pid)) return { ok: false, current };
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  return { ok: false, current: readLock(file) };
}

function adoptUpdateLock(file, token, pid = process.pid) {
  const current = readLock(file);
  if (!current || current.token !== token) return false;
  const tmp = `${file}.${pid}.tmp`;
  try {
    writeLock(tmp, { ...current, pid, adoptedAt: Date.now() });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function releaseUpdateLock(file, token) {
  const current = readLock(file);
  if (!current || current.token !== token) return false;
  try { fs.unlinkSync(file); return true; } catch (_) { return false; }
}

function readState(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return {};
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}

function writeState(file, value) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('update state target non sicuro');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

module.exports = {
  PACKAGE_NAME, VERSION_RE, parseVersion, compareVersions, registryVersion,
  scrubError, pidAlive, readLock, acquireUpdateLock, adoptUpdateLock, releaseUpdateLock,
  readState, writeState, stableRuntimeDir,
};
