'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { commandOf, MAX_CANDIDATE_BYTES } = require('../lib/vl-nodes/routes.js');

test('VL command schema is an exact fail-closed allowlist', () => {
  assert.deepEqual(commandOf({ kind: 'restart' }), { kind: 'restart', args: {} });
  assert.equal(commandOf({ kind: 'restart', args: { shell: 'id' } }), null);
  assert.equal(commandOf({ kind: 'shell', args: { command: 'id' } }), null);
  assert.deepEqual(commandOf({ kind: 'logs', args: { limit: 25 } }), { kind: 'logs', args: { limit: 25 } });
  assert.equal(commandOf({ kind: 'logs', args: { limit: 1000 } }), null);
});

test('prompt is bounded and fail-closed, exactly like every other verb', () => {
  // Il prompt e' l'unico comando che porta testo dell'utente fino alla sessione
  // del device: il tetto e' lo stesso dichiarato dal nodo (4 KiB), cosi' l'hub
  // non consegna mai qualcosa che il device rifiutera'.
  assert.deepEqual(
    commandOf({ kind: 'prompt', args: { text: 'ciao N900' } }),
    { kind: 'prompt', args: { text: 'ciao N900' } },
  );
  assert.equal(commandOf({ kind: 'prompt', args: { text: '' } }), null, 'vuoto rifiutato');
  assert.equal(commandOf({ kind: 'prompt', args: {} }), null, 'senza testo rifiutato');
  assert.equal(commandOf({ kind: 'prompt' }), null, 'senza args rifiutato');
  assert.equal(
    commandOf({ kind: 'prompt', args: { text: 'x'.repeat(4097) } }), null,
    'oltre il bound rifiutato QUI, non dal device',
  );
  assert.equal(
    commandOf({ kind: 'prompt', args: { text: 'ok', extra: 1 } }), null,
    'chiavi in piu rifiutate: fail-closed come gli altri verbi',
  );
  assert.equal(commandOf({ kind: 'prompt', args: { text: 42 } }), null, 'testo non stringa');
});

test('update candidate accepts only bounded credential-free HTTP metadata', () => {
  const valid = {
    kind: 'update_candidate',
    args: { url: 'https://example.test/vl', sha256: 'a'.repeat(64), size: MAX_CANDIDATE_BYTES, version: '0.2.0-rc.1' },
  };
  assert.equal(commandOf(valid).kind, 'update_candidate');
  assert.equal(commandOf({ ...valid, args: { ...valid.args, size: MAX_CANDIDATE_BYTES + 1 } }), null);
  assert.equal(commandOf({ ...valid, args: { ...valid.args, url: 'https://user:secret@example.test/vl' } }), null);
  assert.equal(commandOf({ ...valid, args: { ...valid.args, activate: true } }), null);
});

