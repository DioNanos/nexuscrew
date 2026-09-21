'use strict';
// tests/terminal-config.test.js — i parametri del terminale vivono nella
// config del server, con i default documentati; sovrascriverne UNO non deve
// azzerare gli altri (il merge superficiale della config non basta per una
// sotto-mappa).
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../lib/config.js');

const EXPECTED = {
  retryBaseMs: 250,
  retryMaxMs: 5000,
  pingMs: 5000,
  deadMs: 10000,
  hubGraceMs: 60000,
  outputRingBytes: 256 * 1024,
  queuedInputBytes: 4096,
  captureLines: 2000,
  overlayDelayMs: 1000,
};

test('i default del terminale sono quelli documentati', () => {
  const t = config.resolveTerminal();
  for (const [key, value] of Object.entries(EXPECTED)) {
    assert.equal(t[key], value, `${key} deve valere ${value}`);
  }
});

test('la config del server espone i parametri del terminale', () => {
  const d = config.baseDefaults();
  assert.ok(d.terminal && typeof d.terminal === 'object', 'baseDefaults deve avere la sezione terminal');
  assert.equal(d.terminal.outputRingBytes, EXPECTED.outputRingBytes);
  assert.equal(d.terminal.hubGraceMs, EXPECTED.hubGraceMs);
});

test('sovrascrivere un parametro NON azzera gli altri (merge profondo)', () => {
  const t = config.resolveTerminal({ terminal: { pingMs: 111 } });
  assert.equal(t.pingMs, 111, 'il valore richiesto vince');
  assert.equal(t.deadMs, EXPECTED.deadMs, 'gli altri restano ai default');
  assert.equal(t.outputRingBytes, EXPECTED.outputRingBytes);

  const layered = config.resolveTerminal(
    { terminal: { pingMs: 111, deadMs: 222 } },
    { terminal: { pingMs: 333 } },
  );
  assert.equal(layered.pingMs, 333, 'la sorgente successiva vince');
  assert.equal(layered.deadMs, 222, 'il resto della sorgente precedente resta');
});
