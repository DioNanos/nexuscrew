'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validEnvKey } = require('./env-key.js');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_VALUE_BYTES = 16 * 1024;

function credentialsPath(cfg = {}, home = cfg.home || os.homedir()) {
  return cfg.credentialsPath || process.env.NEXUSCREW_CREDENTIALS_FILE
    || path.join(home, '.nexuscrew', 'credentials.json');
}

function ownedByCurrentUser(st) {
  return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

function safePrivateDir(dir, { create = false } = {}) {
  let st;
  try { st = fs.lstatSync(dir); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    st = fs.lstatSync(dir);
  }
  if (!st.isSymbolicLink() && st.isDirectory() && ownedByCurrentUser(st) && (st.mode & 0o077) && create) {
    fs.chmodSync(dir, 0o700); st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory() || !ownedByCurrentUser(st) || (st.mode & 0o077)) {
    throw new Error('unsafe credential directory (must be user-owned mode 0700, not a symlink)');
  }
  return st;
}

function normalizeCredentials(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid credential store');
  if (raw.schemaVersion !== SCHEMA_VERSION || !raw.credentials
    || typeof raw.credentials !== 'object' || Array.isArray(raw.credentials)) {
    throw new Error('invalid credential store schema');
  }
  const credentials = {};
  for (const [key, value] of Object.entries(raw.credentials)) {
    if (!validEnvKey(key) || typeof value !== 'string' || !value
      || Buffer.byteLength(value) > MAX_VALUE_BYTES || /[\x00\r\n]/.test(value)) {
      throw new Error('invalid credential store entry');
    }
    credentials[key] = value;
  }
  return credentials;
}

function readCredentialStore(cfg = {}, home = cfg.home || os.homedir()) {
  const file = credentialsPath(cfg, home);
  try {
    const parent = path.dirname(file);
    safePrivateDir(parent);
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || !ownedByCurrentUser(st)
      || (st.mode & 0o077) || st.size > MAX_FILE_BYTES) {
      throw new Error('unsafe credential store (must be user-owned mode 0600, not a symlink)');
    }
    return normalizeCredentials(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function validateCredential(key, value) {
  if (!validEnvKey(key)) throw new Error('invalid credential environment key');
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_VALUE_BYTES
    || /[\x00\r\n]/.test(value)) {
    throw new Error('credential must be 1-16384 bytes without control line breaks');
  }
}

function atomicWriteStore(file, credentials) {
  const dir = path.dirname(file);
  safePrivateDir(dir, { create: true });
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile() || !ownedByCurrentUser(existing)
      || (existing.mode & 0o077)) throw new Error('unsafe existing credential store');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const body = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, credentials }, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error('credential store is too large');
  const tmp = path.join(dir, `.credentials.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    // Best effort directory fsync: supported on Linux/macOS, harmlessly
    // skipped on filesystems that do not permit opening directories.
    try {
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (_) {}
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function setCredential(cfg, key, value, home = cfg.home || os.homedir()) {
  validateCredential(key, value);
  safePrivateDir(path.dirname(credentialsPath(cfg, home)), { create: true });
  const current = readCredentialStore(cfg, home);
  atomicWriteStore(credentialsPath(cfg, home), { ...current, [key]: value });
}

function removeCredential(cfg, key, home = cfg.home || os.homedir()) {
  if (!validEnvKey(key)) throw new Error('invalid credential environment key');
  safePrivateDir(path.dirname(credentialsPath(cfg, home)), { create: true });
  const current = readCredentialStore(cfg, home);
  if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
  delete current[key];
  atomicWriteStore(credentialsPath(cfg, home), current);
  return true;
}

module.exports = {
  SCHEMA_VERSION, MAX_FILE_BYTES, MAX_VALUE_BYTES,
  credentialsPath, readCredentialStore, setCredential, removeCredential,
  safePrivateDir, validateCredential,
};
