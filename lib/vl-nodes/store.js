'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NODE_ID_RE = /^[a-f0-9]{32}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const STORE_VERSION = 1;
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const MAX_INVITE_TTL_MS = 60 * 60 * 1000;
const MAX_STORE_BYTES = 256 * 1024;

function emptyStore() {
  return { version: STORE_VERSION, invites: [], nodes: [] };
}

function defaultPath(home) {
  return path.join(home, '.nexuscrew', 'vl-nodes.json');
}

function cleanLabel(value, fallback = 'VL') {
  if (typeof value !== 'string') return fallback;
  const clean = value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return clean ? clean.slice(0, 48) : fallback;
}

function validRecord(record) {
  return record && NODE_ID_RE.test(String(record.nodeId || ''))
    && TOKEN_RE.test(String(record.tokenHash || ''))
    && Number.isSafeInteger(record.pairedAt) && record.pairedAt > 0
    && typeof record.label === 'string' && record.label.length > 0 && record.label.length <= 48;
}

function normalizeStore(raw, now = Date.now()) {
  if (!raw || raw.version !== STORE_VERSION) return emptyStore();
  const invites = Array.isArray(raw.invites) ? raw.invites.filter((invite) => (
    invite && TOKEN_RE.test(String(invite.tokenHash || ''))
      && Number.isSafeInteger(invite.expiresAt) && invite.expiresAt > now
      && typeof invite.label === 'string' && invite.label.length > 0 && invite.label.length <= 48
  )).slice(-64) : [];
  const seen = new Set();
  const nodes = [];
  for (const record of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!validRecord(record) || seen.has(record.nodeId)) continue;
    seen.add(record.nodeId);
    nodes.push({
      nodeId: record.nodeId,
      label: cleanLabel(record.label),
      tokenHash: record.tokenHash,
      pairedAt: record.pairedAt,
    });
  }
  return { version: STORE_VERSION, invites, nodes };
}

function ownedByCurrentUser(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function assertSafeFile(stat) {
  if (stat.isSymbolicLink() || !stat.isFile() || !ownedByCurrentUser(stat)
    || (stat.mode & 0o077) !== 0 || stat.size > MAX_STORE_BYTES) {
    throw new Error('unsafe VL node store');
  }
}

function loadStore(file, now = Date.now()) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    assertSafeFile(fs.fstatSync(fd));
    return normalizeStore(JSON.parse(fs.readFileSync(fd, 'utf8')), now);
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyStore();
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWriteStore(file, store, now = Date.now()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !ownedByCurrentUser(dirStat)) {
    throw new Error('unsafe VL node store directory');
  }
  fs.chmodSync(dir, 0o700);
  try {
    assertSafeFile(fs.lstatSync(file));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    const payload = `${JSON.stringify(normalizeStore(store, now), null, 2)}\n`;
    fs.writeFileSync(fd, payload, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (_) {}
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function digest(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function timingSafeHex(left, right) {
  if (!TOKEN_RE.test(String(left || '')) || !TOKEN_RE.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function randomToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString('hex');
}

function createInvite(file, { label = 'VL', ttlMs = DEFAULT_INVITE_TTL_MS } = {}, seams = {}) {
  const now = typeof seams.now === 'function' ? seams.now() : Date.now();
  const boundedTtl = Math.max(30_000, Math.min(MAX_INVITE_TTL_MS, Number(ttlMs) || DEFAULT_INVITE_TTL_MS));
  const token = randomToken(seams.randomBytes);
  const store = loadStore(file, now);
  store.invites.push({ tokenHash: digest(token), expiresAt: now + boundedTtl, label: cleanLabel(label) });
  store.invites = store.invites.filter((invite) => invite.expiresAt > now).slice(-64);
  atomicWriteStore(file, store, now);
  return { invite: token, expiresAt: now + boundedTtl, label: cleanLabel(label) };
}

function pairNode(file, { invite, nodeId, label }, seams = {}) {
  if (!TOKEN_RE.test(String(invite || ''))) return { ok: false, code: 'invalid-invite' };
  if (!NODE_ID_RE.test(String(nodeId || ''))) return { ok: false, code: 'invalid-node-id' };
  const now = typeof seams.now === 'function' ? seams.now() : Date.now();
  const store = loadStore(file, now);
  if (store.nodes.some((node) => node.nodeId === nodeId)) return { ok: false, code: 'node-exists' };
  const inviteHash = digest(invite);
  const index = store.invites.findIndex((row) => timingSafeHex(row.tokenHash, inviteHash));
  if (index < 0) return { ok: false, code: 'invite-expired-or-used' };
  const [accepted] = store.invites.splice(index, 1);
  const token = randomToken(seams.randomBytes);
  const record = {
    nodeId,
    label: cleanLabel(label, accepted.label),
    tokenHash: digest(token),
    pairedAt: now,
  };
  store.nodes.push(record);
  atomicWriteStore(file, store, now);
  return { ok: true, token, node: { nodeId, label: record.label, pairedAt: now } };
}

function authenticate(file, token, now = Date.now()) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const tokenHash = digest(token);
  const record = loadStore(file, now).nodes.find((node) => timingSafeHex(node.tokenHash, tokenHash));
  return record ? { nodeId: record.nodeId, label: record.label, pairedAt: record.pairedAt } : null;
}

function removeNode(file, nodeId, now = Date.now()) {
  if (!NODE_ID_RE.test(String(nodeId || ''))) return false;
  const store = loadStore(file, now);
  const kept = store.nodes.filter((node) => node.nodeId !== nodeId);
  if (kept.length === store.nodes.length) return false;
  store.nodes = kept;
  atomicWriteStore(file, store, now);
  return true;
}

function listNodes(file, now = Date.now()) {
  return loadStore(file, now).nodes.map(({ nodeId, label, pairedAt }) => ({ nodeId, label, pairedAt }));
}

module.exports = {
  NODE_ID_RE,
  TOKEN_RE,
  STORE_VERSION,
  DEFAULT_INVITE_TTL_MS,
  MAX_INVITE_TTL_MS,
  emptyStore,
  defaultPath,
  cleanLabel,
  normalizeStore,
  loadStore,
  atomicWriteStore,
  digest,
  timingSafeHex,
  createInvite,
  pairNode,
  authenticate,
  removeNode,
  listNodes,
};
