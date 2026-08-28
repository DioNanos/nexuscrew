'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createDropCounter } = require('../lib/ws/drop-counter.js');

test('conta le cadute nella finestra e scarta quelle fuori finestra', () => {
  let t = 1000;
  const c = createDropCounter({ windowMs: 60000, now: () => t });
  c.recordDrop('A', t);
  c.recordDrop('B', t + 1000);
  assert.equal(c.snapshot(t + 2000).drops, 2);
  t += 61000; // la prima cade fuori finestra, la seconda no
  assert.equal(c.snapshot(t).drops, 1);
  t += 61000;
  assert.equal(c.snapshot(t).drops, 0);
});

test('recordReopen restituisce il gap solo se esiste un close precedente', () => {
  let t = 1000;
  const c = createDropCounter({ now: () => t });
  const first = c.recordReopen('A', t);
  assert.equal(first.gapMs, null, 'primo attach: nessuna caduta da misurare');
  c.recordDrop('A', t);
  t += 4500;
  const reopen = c.recordReopen('A', t);
  assert.equal(reopen.gapMs, 4500, 'durata caduta = gap close->reopen');
  const again = c.recordReopen('A', t);
  assert.equal(again.gapMs, null, 'il close e stato consumato: connessione sana');
});
