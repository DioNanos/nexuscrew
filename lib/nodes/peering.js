'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.js');

const INVITE_TTL_MS = 10 * 60 * 1000;
const REVERSE_PORT_BASE = 44001;

function defaultInvitesPath(home) { return path.join(home, '.nexuscrew', 'invites.json'); }
function defaultPendingPath(home) { return path.join(home, '.nexuscrew', 'pairing-pending.json'); }

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function readInvites(p, now = Date.now()) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return [];
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(rows) ? rows.filter((x) => x && x.expiresAt > now && !x.usedAt) : [];
  } catch (_) { return []; }
}

function writeInvites(p, rows) {
  try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('invites target is symlink'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
}

function encodePairing(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodePairing(value) {
  try {
    const x = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    if (!x || x.v !== 1 || !store.NODE_ID_RE.test(x.instanceId) || !store.isPort(x.port)
      || !store.validToken(x.invite) || typeof x.label !== 'string') return null;
    return x;
  } catch (_) { return null; }
}

function parsePairingUrl(value) {
  try {
    const u = new URL(String(value));
    const payload = new URLSearchParams(u.hash.replace(/^#/, '')).get('pair');
    return decodePairing(payload);
  } catch (_) { return null; }
}

function createInvite({ invitesPath, instanceId, port, label = 'NexusCrew', now = Date.now(), randomBytes = crypto.randomBytes }) {
  const invite = randomBytes(32).toString('base64url');
  const expiresAt = now + INVITE_TTL_MS;
  const rows = readInvites(invitesPath, now);
  rows.push({ hash: crypto.createHash('sha256').update(invite).digest('hex'), expiresAt, usedAt: null });
  writeInvites(invitesPath, rows.slice(-32));
  const pair = encodePairing({ v: 1, instanceId, port, label: String(label).slice(0, 64), invite });
  return { pairingUrl: `http://127.0.0.1:${port}/#pair=${pair}`, expiresAt };
}

function consumeInvite({ invitesPath, invite, now = Date.now() }) {
  const all = readInvites(invitesPath, 0);
  const hash = crypto.createHash('sha256').update(String(invite || '')).digest('hex');
  const idx = all.findIndex((x) => !x.usedAt && x.expiresAt > now && safeEqual(x.hash, hash));
  if (idx < 0) return false;
  all[idx] = { ...all[idx], usedAt: now };
  writeInvites(invitesPath, all.slice(-32));
  return true;
}

function allocateReversePort(nodes) {
  const used = new Set();
  for (const n of nodes || []) {
    if (store.isPort(n.localPort)) used.add(n.localPort);
    if (store.isPort(n.reversePort)) used.add(n.reversePort);
  }
  let p = REVERSE_PORT_BASE;
  while (used.has(p) && p < 65535) p += 1;
  if (p >= 65535) throw new Error('no reverse port available');
  return p;
}

function createPending({ pendingPath, data, now = Date.now() }) {
  const rows = readInvites(pendingPath, now);
  const credential = crypto.randomBytes(32).toString('base64url');
  rows.push({ ...data, hash: crypto.createHash('sha256').update(credential).digest('hex'), expiresAt: now + INVITE_TTL_MS, usedAt: null });
  writeInvites(pendingPath, rows.slice(-32));
  return credential;
}

function consumePending({ pendingPath, credential, now = Date.now() }) {
  const rows = readInvites(pendingPath, 0);
  const hash = crypto.createHash('sha256').update(String(credential || '')).digest('hex');
  const idx = rows.findIndex((x) => !x.usedAt && x.expiresAt > now && safeEqual(x.hash, hash));
  if (idx < 0) return null;
  const found = { ...rows[idx] };
  rows.splice(idx, 1);
  writeInvites(pendingPath, rows.slice(-32));
  delete found.hash; delete found.expiresAt; delete found.usedAt;
  return found;
}

module.exports = {
  INVITE_TTL_MS, REVERSE_PORT_BASE, defaultInvitesPath, defaultPendingPath, safeEqual,
  readInvites, writeInvites, encodePairing, decodePairing, parsePairingUrl,
  createInvite, consumeInvite, allocateReversePort, createPending, consumePending,
};
