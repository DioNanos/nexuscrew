'use strict';
// Recupero consegna ask federati: il 409 delivery-unknown-block rifiuta il
// nuovo requestId PRIMA della ricevuta — il relay deve esporre un esito
// incerto con l'ID originale ancora 'sent' (se esiste), mai un nuovo ID da
// verificare (sarebbe 404). verifyStatus usa l'askId con cui l'owner conosce
// la domanda (ownerAskId).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAskRelay } = require('../lib/notify/ask-relay.js');

const SELF = 'f'.repeat(32);

function store(ownerId, { direction = 'outbound', shared = true } = {}) {
  const peer = {
    name: 'peer', nodeId: ownerId, direction, shared,
    token: 'tok-' + ownerId.slice(0, 6), localPort: 41820,
  };
  return { nodeId: SELF, nodes: [peer] };
}

function loadStoreFor(ownerId, opts) {
  const st = store(ownerId, opts);
  return () => st;
}

test('409 delivery-unknown-block: uncertain con l ID originale ancora sent', async () => {
  const ownerId = 'a'.repeat(32);
  const calls = [];
  let fase = 0;
  const relay = createAskRelay({
    loadStore: loadStoreFor(ownerId),
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      // Prima risposta: l'invio resta sospeso (nessuna risposta: il test lo
      // crea con un 502 che marca l'attempt come 'sent' sul primo giro — qui
      // usiamo direttamente relayAnswer con esito incerto). Poi il blocco.
      fase += 1;
      if (fase === 1) return { ok: true, status: 502, json: async () => ({}) };
      return { ok: true, status: 409, json: async () => ({ error: 'conflitto', reason: 'delivery-unknown-block' }) };
    },
  });
  const first = await relay.relayAnswer({ ownerId, askId: 'owner-ask-1', text: 'uno' });
  assert.strictEqual(first.uncertain, true);
  const second = await relay.relayAnswer({ ownerId, askId: 'owner-ask-1', text: 'due' });
  assert.strictEqual(second.uncertain, true, 'il blocco precedente e\' un esito incerto');
  assert.strictEqual(second.originalRequestId, first.requestId, 'l ID originale ancora sent e\' quello verificabile');
  assert.notStrictEqual(second.originalRequestId, second.requestId);
});

test('409 delivery-unknown-block senza invio precedente: originalRequestId null (solo riconciliazione)', async () => {
  const ownerId = 'b'.repeat(32);
  const relay = createAskRelay({
    loadStore: loadStoreFor(ownerId),
    fetchImpl: async () => ({ ok: true, status: 409, json: async () => ({ error: 'conflitto', reason: 'delivery-unknown-block' }) }),
  });
  const out = await relay.relayAnswer({ ownerId, askId: 'owner-ask-2', text: 'testo' });
  assert.strictEqual(out.uncertain, true);
  assert.strictEqual(out.originalRequestId, null, 'nessun ID originale: solo riconciliazione');
});

test('409 request-conflict resta definitivo (non uncertain, senza originalRequestId)', async () => {
  const ownerId = 'c'.repeat(32);
  const relay = createAskRelay({
    loadStore: loadStoreFor(ownerId),
    fetchImpl: async () => ({ ok: true, status: 409, json: async () => ({ error: 'conflitto', reason: 'request-conflict' }) }),
  });
  const out = await relay.relayAnswer({ ownerId, askId: 'owner-ask-3', text: 'testo' });
  assert.strictEqual(out.uncertain, undefined);
  assert.strictEqual(out.originalRequestId, undefined);
  assert.strictEqual(out.code, 409);
});

test('verifyStatus usa l askId dell owner (ownerAskId) nella rotta di verifica', async () => {
  const ownerId = 'd'.repeat(32);
  const calls = [];
  const relay = createAskRelay({
    loadStore: loadStoreFor(ownerId),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ state: 'committed' }) };
    },
  });
  const out = await relay.verifyStatus({ ownerId, askId: 'owner-ask-9', requestId: 'rid-1' });
  assert.strictEqual(out.state, 'committed');
  assert.ok(calls[0].includes('/event-feed/asks/owner-ask-9/requests/rid-1'), 'rotta con ownerAskId');
});

// --- risoluzione verso peer inbound condivisi (canale reverse verificato) ---

function inboundStore(ownerId, { shared = true, grants = true, withSlot = true } = {}) {
  const peer = {
    name: 'peer', nodeId: ownerId, direction: 'inbound', shared,
    token: 'tok-' + ownerId.slice(0, 6),
    askReplyAccess: grants === true || grants === 'reply-only',
    eventsAccess: grants === true || grants === 'events-only',
    cellVisibility: 'all',
    ...(withSlot ? { reversePool: { slots: [{ port: 41821 }], activeSlot: 0 } } : {}),
  };
  return { nodeId: SELF, nodes: [peer] };
}

function relayFor(ownerId, opts = {}) {
  const calls = [];
  const probeOwned = opts.probeOwned !== false;
  return { calls, relay: createAskRelay({
    loadStore: () => inboundStore(ownerId, opts),
    probeReverseSlotImpl: async ({ expected }) => (
      probeOwned && expected && expected.instanceId === ownerId
        ? { owned: true }
        : { owned: false, code: 'reverse-slot-proof-mismatch' }
    ),
    fetchImpl: async (url, o = {}) => {
      calls.push({ url: String(url), body: o.body ? JSON.parse(o.body) : null, method: o.method || 'GET' });
      return { ok: true, status: 200, json: async () => ({ status: 'answered' }) };
    },
  }) };
}

test('inbound condiviso con slot verificato: answer forward sulla porta dello slot', async () => {
  const ownerId = 'e'.repeat(32);
  const { calls, relay } = relayFor(ownerId);
  const out = await relay.relayAnswer({ ownerId, askId: 'owner-ask-r', text: 'risposta' });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.ok(calls[0].url.includes(':41821/'), 'forward sulla porta dello slot reverse attivo');
  assert.ok(calls[0].url.includes('/federation/route/_/event-feed/asks/'));
});

test('inbound con slot assente: rifiuto NETTO (mai uncertain, mai forward)', async () => {
  const ownerId = 'f'.repeat(32);
  const { calls, relay } = relayFor(ownerId, { withSlot: false });
  const out = await relay.relayAnswer({ ownerId, askId: 'a', text: 'x' });
  assert.strictEqual(out.uncertain, undefined, 'preflight fallita NON e\' uncertain');
  assert.strictEqual(out.code, 404);
  assert.strictEqual(out.reason, 'reverse-slot-unverified');
  assert.strictEqual(calls.length, 0, 'nessun forward senza slot verificato');
});

test('inbound con slot non verificato (mismatch/scaduto): rifiuto netto, mai forward', async () => {
  const ownerId = 'a1'.padEnd(32, '0');
  const { calls, relay } = relayFor(ownerId, { probeOwned: false });
  const out = await relay.relayAnswer({ ownerId, askId: 'a', text: 'x' });
  assert.strictEqual(out.uncertain, undefined, 'preflight fallita NON e\' uncertain');
  assert.strictEqual(out.code, 404);
  assert.strictEqual(out.reason, 'reverse-slot-unverified');
  assert.strictEqual(calls.length, 0, 'nessun forward senza slot verificato');
});

test('inbound non condiviso: 404 owner-unknown (nessun canale, nessun forward)', async () => {
  const ownerId = '9'.repeat(32);
  const { calls, relay } = relayFor(ownerId, { shared: false });
  const out = await relay.relayAnswer({ ownerId, askId: 'a', text: 'x' });
  assert.strictEqual(out.code, 404);
  assert.strictEqual(out.reason, 'owner-unknown');
  assert.strictEqual(calls.length, 0);
});

test('inbound: dismiss e verify forwardano sulla porta dello slot', async () => {
  const ownerId = 'c'.repeat(32);
  const { calls, relay } = relayFor(ownerId);
  await relay.relayDismiss({ ownerId, askId: 'owner-ask-d' });
  await relay.verifyStatus({ ownerId, askId: 'owner-ask-d', requestId: 'rid-1' });
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes(':41821/')), 'dismiss sul canale reverse');
  assert.ok(calls.some((c) => c.url.includes(':41821/') && c.url.includes('/requests/rid-1')), 'verify sul canale reverse');
});

test('consenso incompleto (askReplyAccess assente): owner-unknown, nessun forward', async () => {
  const ownerId = 'd'.repeat(32);
  const { calls, relay } = relayFor(ownerId, { grants: 'events-only' });
  const out = await relay.relayAnswer({ ownerId, askId: 'a', text: 'x' });
  assert.strictEqual(out.reason, 'owner-unknown');
  assert.strictEqual(calls.length, 0);
});
