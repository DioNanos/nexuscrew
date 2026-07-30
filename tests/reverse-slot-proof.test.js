'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const proof = require('../lib/nodes/reverse-slot-proof.js');

const secret = 'peer-directional-credential';
const expected = { remotePort: 44103, generation: 2, instanceId: 'a'.repeat(32) };
const request = { probeId: 'p'.repeat(16), nonce: 'n'.repeat(16), dialedPort: 44103, generation: 2, instanceId: 'a'.repeat(32) };

test('reverse slot proof: MAC valido senza Authorization bearer', () => {
  const response = proof.respondSlotProof({ secret, expected, request });
  assert.equal(response.ok, true);
  assert.deepEqual(proof.verifySlotProof({ secret, expected, challenge: request, response }).owned, true);
});

test('reverse slot proof: relay old-to-new non firma la challenge della vecchia slot', () => {
  const listenerNew = { ...expected, remotePort: 44203 };
  const relayed = proof.respondSlotProof({ secret, expected: listenerNew, request });
  assert.deepEqual(relayed, { ok: false, code: 'reverse-slot-proof-mismatch' });
  assert.equal(proof.verifySlotProof({ secret, expected, challenge: request, response: relayed }).owned, false);
});

test('reverse slot proof: risposta autenticata con generation o MAC sbagliati non possiede la porta', () => {
  const response = proof.respondSlotProof({ secret, expected, request });
  assert.equal(proof.verifySlotProof({
    secret, expected: { ...expected, generation: 3 }, challenge: request, response,
  }).owned, false);
  assert.equal(proof.verifySlotProof({
    secret, expected, challenge: request, response: { ...response, mac: 'x'.repeat(43) },
  }).owned, false);
});

test('reverse slot proof: una risposta valida non può essere riusata per una challenge fresca', () => {
  const captured = proof.respondSlotProof({ secret, expected, request });
  const fresh = { ...request, probeId: 'q'.repeat(16), nonce: 'r'.repeat(16) };
  const result = proof.verifySlotProof({ secret, expected, challenge: fresh, response: captured });
  assert.deepEqual(result, { owned: false, code: 'reverse-slot-proof-mismatch' });
});

test('reverse slot probe: nessun bearer verso listener sospetto', async () => {
  let captured;
  const out = await proof.probeReverseSlot({
    port: 44103, secret, expected, randomBytes: () => Buffer.alloc(24, 7),
    fetchImpl: async (_url, opts) => {
      captured = opts;
      const req = JSON.parse(opts.body);
      return { status: 200, json: async () => proof.respondSlotProof({ secret, expected, request: req }) };
    },
  });
  assert.equal(out.owned, true);
  assert.equal(captured.headers.authorization, undefined);
});
