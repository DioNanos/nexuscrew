'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const store = require('./store.js');

const INVITE_TTL_MS = 10 * 60 * 1000;
const REVERSE_PORT_BASE = 44001;
const CAPABILITY_ID_RE = /^[a-f0-9]{64}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{16,128}$/;

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

function hasInvite({ invitesPath, invite, now = Date.now() }) {
  const hash = crypto.createHash('sha256').update(String(invite || '')).digest('hex');
  return readInvites(invitesPath, now).some((row) => safeEqual(row.hash, hash));
}

function allocateReversePort(nodes, reservations = []) {
  const used = new Set();
  for (const n of [...(nodes || []), ...(reservations || [])]) {
    if (store.isPort(n.localPort)) used.add(n.localPort);
    if (store.isPort(n.reversePort)) used.add(n.reversePort);
  }
  let p = REVERSE_PORT_BASE;
  while (used.has(p) && p < 65535) p += 1;
  if (p >= 65535) throw new Error('no reverse port available');
  return p;
}

function canBindReversePort(port, createServerImpl = net.createServer) {
  return new Promise((resolve, reject) => {
    const server = createServerImpl();
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners?.();
      if (error) reject(error); else resolve(value);
    };
    server.once('error', (error) => {
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) finish(false);
      else finish(false, error);
    });
    server.once('listening', () => {
      if (typeof server.unref === 'function') server.unref();
      try { server.close(() => finish(true)); } catch (error) { finish(false, error); }
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

// The reverse listener will be owned by sshd, but allocation happens on the
// hub. Probe the real loopback bind before issuing a candidate so a stale or
// unrelated listener absent from nodes.json cannot be reallocated blindly.
async function allocateAvailableReversePort(nodes, reservations = [], opts = {}) {
  const rejected = [];
  while (rejected.length < (65535 - REVERSE_PORT_BASE)) {
    const candidate = allocateReversePort(nodes, [...reservations, ...rejected]);
    if (await canBindReversePort(candidate, opts.createServerImpl || net.createServer)) return candidate;
    rejected.push({ localPort: candidate });
  }
  throw new Error('no reverse port available');
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

// Prova pubblica ma capability-bound usata durante il pairing. Il client NON
// invia mai l'invito/credential: invia SHA256(SHA256(capability)) + challenge;
// il peer cerca il record attivo e firma il challenge con SHA256(capability).
// Un processo HTTP estraneo sulla stessa porta non puo' quindi diventare un
// falso positivo e non riceve materiale sufficiente per consumare l'invito.
function capabilityIdentity({ invitesPath, pendingPath, capabilityId, challenge, now = Date.now() } = {}) {
  if (!CAPABILITY_ID_RE.test(String(capabilityId || '')) || !CHALLENGE_RE.test(String(challenge || ''))) return null;
  const rows = [
    ...readInvites(invitesPath, now),
    ...readInvites(pendingPath, now),
  ];
  const row = rows.find((x) => {
    if (!x || !CAPABILITY_ID_RE.test(String(x.hash || ''))) return false;
    const id = crypto.createHash('sha256').update(Buffer.from(x.hash, 'hex')).digest('hex');
    return safeEqual(id, capabilityId);
  });
  if (!row) return null;
  return crypto.createHmac('sha256', Buffer.from(row.hash, 'hex')).update(challenge).digest('base64url');
}

function capabilityProbeMaterial(capability, randomBytes = crypto.randomBytes) {
  if (!store.validToken(capability)) return null;
  const key = crypto.createHash('sha256').update(capability).digest();
  return {
    key,
    capabilityId: crypto.createHash('sha256').update(key).digest('hex'),
    challenge: randomBytes(24).toString('base64url'),
  };
}

// Probe di trasporto del tunnel -L PRIMA di consumare l'invito e dopo il
// restart negoziato. Oltre alla reachability verifica prova capability e
// instanceId atteso. Bounded, con sleep/random iniettabili per test.
async function probeTransportReady({
  port, capability, expectedInstanceId, fetchImpl = fetch, attempts = 16,
  timeoutMs = 1500, deadlineMs = 20000, sleep, randomBytes, now = Date.now,
} = {}) {
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const material = capabilityProbeMaterial(capability, randomBytes);
  if (!store.isPort(port) || !material || !store.NODE_ID_RE.test(String(expectedInstanceId || ''))) {
    return { ready: false, attempts: 0, code: 'identity-probe-invalid', lastError: 'parametri identity probe non validi' };
  }
  const maxAttempts = Number.isInteger(attempts) && attempts > 0 ? Math.min(attempts, 32) : 16;
  const boundedDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? Math.min(Math.floor(deadlineMs), 60000) : 20000;
  const startedAt = now();
  const deadlineAt = startedAt + boundedDeadlineMs;
  let lastError = '';
  let code = 'transport-not-ready';
  let attempted = 0;
  for (let i = 0; i < maxAttempts && now() < deadlineAt; i += 1) {
    attempted += 1;
    let timer;
    try {
      const ctrl = new AbortController();
      const remainingMs = Math.max(1, deadlineAt - now());
      timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, remainingMs));
      const response = await fetchImpl(`http://127.0.0.1:${port}/pair/identity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilityId: material.capabilityId, challenge: material.challenge }),
        signal: ctrl.signal,
      });
      if (!response || response.status !== 200) {
        code = 'identity-proof-rejected';
        throw new Error(`identity probe HTTP ${(response && response.status) || '?'}`);
      }
      const body = await response.json().catch(() => null);
      if (!body || body.ok !== true || !store.NODE_ID_RE.test(String(body.instanceId || ''))
        || typeof body.proof !== 'string') {
        code = 'identity-proof-invalid';
        throw new Error('identity probe payload non valido');
      }
      if (body.instanceId !== expectedInstanceId) {
        code = 'peer-identity-mismatch';
        throw new Error('instanceId del peer non coincide con il link');
      }
      const expected = crypto.createHmac('sha256', material.key).update(material.challenge).digest('base64url');
      if (!safeEqual(expected, body.proof)) {
        code = 'identity-proof-invalid';
        throw new Error('prova crittografica del peer non valida');
      }
      return { ready: true, attempts: attempted, instanceId: body.instanceId, elapsedMs: Math.max(0, now() - startedAt) };
    } catch (e) {
      lastError = String((e && e.message) || e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (i < maxAttempts - 1) {
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) break;
      // A refused loopback socket fails immediately.  The old six-probe loop
      // therefore exhausted in only 3.75 s and could tear down a perfectly
      // valid SSH session just as mobile/macOS/Linux key negotiation finished.
      // Keep retrying against a real deadline, with a bounded progressive wait.
      const retryDelayMs = Math.min(1500, 250 * (i + 1), remainingMs);
      if (retryDelayMs > 0) await wait(retryDelayMs);
    }
  }
  return { ready: false, attempts: attempted, code, lastError, elapsedMs: Math.max(0, now() - startedAt) };
}

module.exports = {
  INVITE_TTL_MS, REVERSE_PORT_BASE, defaultInvitesPath, defaultPendingPath, safeEqual,
  readInvites, writeInvites, encodePairing, decodePairing, parsePairingUrl,
  createInvite, consumeInvite, hasInvite, allocateReversePort, canBindReversePort,
  allocateAvailableReversePort, createPending, consumePending,
  capabilityIdentity, capabilityProbeMaterial, probeTransportReady,
};
