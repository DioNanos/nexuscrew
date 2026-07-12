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

// Allowlist rigorosa per versione (caps). v1: solo {v,instanceId,port,label,invite}.
// v2 aggiunge name (slug suggerito), ssh (target/alias), sshPort?: routing non
// segreto. NESSUN campo segreto è ammesso oltre l'invite one-time: niente
// identityFile, chiave privata, API key, bearer UI. Unknown field -> null.
const PAIRING_V1_KEYS = new Set(['v', 'instanceId', 'port', 'label', 'invite']);
const PAIRING_V2_KEYS = new Set(['v', 'instanceId', 'port', 'label', 'invite', 'name', 'ssh', 'sshPort']);

function decodePairing(value) {
  let x;
  try {
    x = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
  } catch (_) { return null; }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const allowed = x.v === 1 ? PAIRING_V1_KEYS : x.v === 2 ? PAIRING_V2_KEYS : null;
  if (!allowed) return null;
  for (const k of Object.keys(x)) if (!allowed.has(k)) return null; // strict: unknown -> null
  // core obbligatorio (entrambe le versioni)
  if (!store.NODE_ID_RE.test(x.instanceId) || !store.isPort(x.port)
    || !store.validToken(x.invite) || typeof x.label !== 'string') return null;
  const out = { v: x.v, instanceId: x.instanceId, port: x.port, label: x.label, invite: x.invite };
  if (x.v === 2) {
    if (x.name !== undefined) {
      if (typeof x.name !== 'string' || !store.NODE_NAME_RE.test(x.name)) return null;
      out.name = x.name;
    }
    if (x.ssh !== undefined) {
      // target/alias SSH (user@host o Host alias); MAI secret. parseSshTarget
      // rifiuta whitespace/control/leading '-' (argv-safe, non diventa flag ssh).
      const ssh = typeof x.ssh === 'string' ? store.parseSshTarget(x.ssh) : null;
      if (!ssh) return null;
      out.ssh = ssh.value;
    }
    if (x.sshPort !== undefined) {
      if (!store.isPort(x.sshPort)) return null;
      out.sshPort = x.sshPort;
    }
  }
  return out;
}

function parsePairingUrl(value) {
  try {
    const u = new URL(String(value));
    const payload = new URLSearchParams(u.hash.replace(/^#/, '')).get('pair');
    return decodePairing(payload);
  } catch (_) { return null; }
}

function createInvite({
  invitesPath, instanceId, port, linkPort = port, label = 'NexusCrew', now = Date.now(), randomBytes = crypto.randomBytes,
  ssh, sshPort, name,
} = {}) {
  const invite = randomBytes(32).toString('base64url');
  const expiresAt = now + INVITE_TTL_MS;
  const rows = readInvites(invitesPath, now);
  rows.push({ hash: crypto.createHash('sha256').update(invite).digest('hex'), expiresAt, usedAt: null });
  writeInvites(invitesPath, rows.slice(-32));
  const payload = { v: 1, instanceId, port, label: String(label).slice(0, 64), invite };
  // v2: include Host/alias SSH + slug quando forniti (routing non segreto). Così
  // il ricevente incolla/scansiona UN solo link e ha tutto per precompilare il
  // form. Senza ssh/name resta v1 (backward-compat con link 0.8.x esistenti).
  const sshVal = typeof ssh === 'string' && ssh.trim() ? store.parseSshTarget(ssh.trim()) : null;
  const requestedName = typeof name === 'string' && name.trim() && store.NODE_NAME_RE.test(name.trim())
    ? name.trim()
    : '';
  // Un link con routing SSH deve sempre portare anche lo slug. Se il chiamante
  // non lo specifica, lo ricaviamo dalla label del dispositivo: il ricevente non
  // deve compilare altri campi per arrivare a "testa e collega".
  const linkName = requestedName || (sshVal ? store.toSlug(payload.label) : '');
  if (sshVal || linkName) {
    payload.v = 2;
    if (linkName) payload.name = linkName;
    if (sshVal) payload.ssh = sshVal.value;
    if (sshVal && store.isPort(sshPort)) payload.sshPort = sshPort;
  }
  const pair = encodePairing(payload);
  if (!store.isPort(linkPort)) throw new Error('porta locale del link non valida');
  return { pairingUrl: `http://127.0.0.1:${linkPort}/#pair=${pair}`, expiresAt, version: payload.v };
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

// Probe di trasporto del tunnel -L provvisorio PRIMA di consumare l'invite
// one-time: qualunque risposta HTTP dal peer attraverso la forward (anche un
// 401 su /federation/health senza credenziali) dimostra che ssh+forward sono
// vivi; un errore di rete no. Sostituisce lo sleep fisso 900ms: bounded, con
// sleep iniettabile (deterministico nei test) e timeout per tentativo.
async function probeTransportReady({ port, fetchImpl = fetch, attempts = 6, timeoutMs = 1500, sleep } = {}) {
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  let lastError = '';
  for (let i = 0; i < attempts; i += 1) {
    let timer;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      await fetchImpl(`http://127.0.0.1:${port}/federation/health`, { signal: ctrl.signal });
      return { ready: true, attempts: i + 1 };
    } catch (e) {
      lastError = String((e && e.message) || e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (i < attempts - 1) await wait(250 * (i + 1));
  }
  return { ready: false, attempts, lastError };
}

module.exports = {
  INVITE_TTL_MS, REVERSE_PORT_BASE, defaultInvitesPath, defaultPendingPath, safeEqual,
  readInvites, writeInvites, encodePairing, decodePairing, parsePairingUrl,
  createInvite, consumeInvite, allocateReversePort, createPending, consumePending,
  probeTransportReady,
};
