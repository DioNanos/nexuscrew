'use strict';
// tests/server-ws-defaults.test.js — il cablaggio dei defaults del bridge ws.
// Il valore di `captureLines` deve essere quello della config del terminale:
// senza, il bridge ricade su 2000 e la voce di changelog mentirebbe.
const { test } = require('node:test');
const assert = require('node:assert');
const { wsBridgeDefaults } = require('../lib/server.js');

test('captureLines e outputRingBytes arrivano dalla config del terminale', () => {
  const d = wsBridgeDefaults({ readonlyDefault: false, tmuxBin: 'tmux', terminal: { outputRingBytes: 123, captureLines: 77 } });
  assert.equal(d.captureLines, 77, 'captureLines deve venire dalla config');
  assert.equal(d.outputRingBytes, 123, 'outputRingBytes deve venire dalla config');
  assert.equal(d.tmuxBin, 'tmux');
});

test('senza sezione terminal i due parametri restano indefiniti (default del bridge)', () => {
  const d = wsBridgeDefaults({ readonlyDefault: true, tmuxBin: 'tmux' });
  assert.equal(d.captureLines, undefined);
  assert.equal(d.outputRingBytes, undefined);
  assert.equal(d.readonlyDefault, true);
});

test('una sezione terminal malformata non rompe i defaults', () => {
  for (const bad of [null, 'x', 4, []]) {
    const d = wsBridgeDefaults({ tmuxBin: 'tmux', terminal: bad });
    assert.equal(d.captureLines, undefined);
  }
});
