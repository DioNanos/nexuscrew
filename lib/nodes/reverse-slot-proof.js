'use strict';
// No-bearer ownership proof for one reverse slot.  The local listener knows
// which remote -R slot targets it; a request relayed from another slot therefore
// reaches a listener with different expectedPort and is rejected before a MAC
// is emitted.  The hub sends only public challenge material to an untrusted
// loopback listener, never the peer credential itself.
const crypto = require('node:crypto');

const PROBE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const INSTANCE_RE = /^[a-f0-9]{16,64}$/;

function isPort(port) { return Number.isInteger(port) && port >= 1 && port <= 65535; }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function parseTuple(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['probeId', 'nonce', 'dialedPort', 'generation', 'instanceId'].includes(key))
    || !PROBE_ID_RE.test(String(value.probeId || '')) || !NONCE_RE.test(String(value.nonce || ''))
    || !isPort(value.dialedPort) || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !INSTANCE_RE.test(String(value.instanceId || ''))) return null;
  return {
    probeId: value.probeId, nonce: value.nonce, dialedPort: value.dialedPort,
    generation: value.generation, instanceId: value.instanceId,
  };
}

function canonicalTuple(tuple) {
  const parsed = parseTuple(tuple);
  return parsed ? `nexuscrew-reverse-slot-proof/v1\0${JSON.stringify(parsed)}` : null;
}

function signSlotProof(secret, tuple) {
  const canonical = canonicalTuple(tuple);
  if (typeof secret !== 'string' || !secret || !canonical) return null;
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64url');
}

function expectedTuple(expected, request) {
  const tuple = parseTuple(request && {
    probeId: request.probeId,
    nonce: request.nonce,
    dialedPort: request.dialedPort,
    generation: request.generation,
    instanceId: request.instanceId,
  });
  if (!tuple || !expected || tuple.dialedPort !== expected.remotePort
    || tuple.generation !== expected.generation || tuple.instanceId !== expected.instanceId) return null;
  return tuple;
}

function respondSlotProof({ secret, expected, request }) {
  const tuple = expectedTuple(expected, request);
  const mac = tuple && signSlotProof(secret, tuple);
  return mac ? { ok: true, ...tuple, mac } : { ok: false, code: 'reverse-slot-proof-mismatch' };
}

function verifySlotProof({ secret, expected, challenge, response }) {
  const issued = expectedTuple(expected, challenge);
  const tuple = expectedTuple(expected, response);
  const issuedCanonical = canonicalTuple(issued);
  const responseCanonical = canonicalTuple(tuple);
  if (!issued || !tuple || !issuedCanonical || !responseCanonical
    || !safeEqual(issuedCanonical, responseCanonical)
    || !response || typeof response.mac !== 'string') {
    return { owned: false, code: 'reverse-slot-proof-mismatch' };
  }
  const expectedMac = signSlotProof(secret, tuple);
  if (!expectedMac || !safeEqual(expectedMac, response.mac)) return { owned: false, code: 'reverse-slot-proof-invalid' };
  return { owned: true, code: 'reverse-slot-owned', tuple };
}

function newProbe(expected, randomBytes = crypto.randomBytes) {
  if (!expected || !isPort(expected.remotePort) || !Number.isSafeInteger(expected.generation)
    || expected.generation < 1 || !INSTANCE_RE.test(String(expected.instanceId || ''))) return null;
  return {
    probeId: randomBytes(18).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    dialedPort: expected.remotePort,
    generation: expected.generation,
    instanceId: expected.instanceId,
  };
}

async function probeReverseSlot({ port, secret, expected, fetchImpl = fetch, timeoutMs = 1500, randomBytes } = {}) {
  if (!isPort(port) || typeof secret !== 'string' || !secret) return { owned: false, code: 'reverse-slot-proof-invalid-input' };
  const probe = newProbe(expected, randomBytes);
  if (!probe) return { owned: false, code: 'reverse-slot-proof-invalid-input' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, Math.min(timeoutMs, 5000)));
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/reverse-slot-proof`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probe), signal: ctrl.signal,
    });
    // Un 409 e' la RISPOSTA di un listener corretto che ha valutato la tupla e
    // l'ha rifiutata: e' un esito, non un'assenza. Collassarlo in
    // "non ottenuta" lo renderebbe indistinguibile da un timeout, e chi
    // classifica gli errori tratterebbe come transitorio un mismatch reale.
    if (response && response.status === 409) {
      const failure = await response.json().catch(() => null);
      const code = failure && typeof failure.code === 'string' && /^[a-z0-9-]{1,64}$/.test(failure.code)
        ? failure.code : 'reverse-slot-proof-mismatch';
      return { owned: false, code };
    }
    if (!response || response.status !== 200) return { owned: false, code: 'reverse-slot-proof-unavailable' };
    const body = await response.json().catch(() => null);
    return verifySlotProof({ secret, expected, challenge: probe, response: body });
  } catch (_) { return { owned: false, code: 'reverse-slot-proof-unavailable' }; }
  finally { clearTimeout(timer); }
}

module.exports = {
  parseTuple, canonicalTuple, signSlotProof, respondSlotProof, verifySlotProof, newProbe, probeReverseSlot,
};
