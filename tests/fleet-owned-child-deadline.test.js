'use strict';
// R4 — la fermata del figlio posseduto non apre finestre nuove: la stessa
// deadline si rilegge prima di OGNI segnale e di OGNI attesa, e a budget
// esaurito l'esito e' «scaduta» subito, senza KILL e senza un'attesa nuova.
const { test } = require('node:test');
const assert = require('node:assert');
const { fermaFiglioPosseduto } = require('../lib/fleet/cell-exec.js');

function figlio({ esceA = null } = {}) {
  const segnali = [];
  let risolvi = () => {};
  const attesa = new Promise((r) => { risolvi = r; });
  const child = {
    _uscito: false,
    get exitCode() { return this._uscito ? 0 : null; },
    get signalCode() { return null; },
    kill(sig) {
      segnali.push(sig);
      if (sig === esceA) { child._uscito = true; risolvi(true); }
      return true;
    },
  };
  return { child, attesaUscita: attesa, segnali };
}

test('R4: limite gia\' esaurito all\'ingresso: nessun segnale, esito scaduta', async () => {
  const { child, attesaUscita, segnali } = figlio();
  let mono = 5000;
  const r = await fermaFiglioPosseduto({
    child, attesaUscita, termMs: 10, limiteMono: 5000,
    monoNow: () => mono, setTimeoutImpl: setTimeout, clearTimeoutImpl: clearTimeout,
  });
  assert.equal(r.uscito, false);
  assert.equal(r.motivo, 'scaduta');
  assert.deepEqual(segnali, [], 'segnale a budget esaurito');
});

test('R4: la deadline scade durante il TERM: nessun KILL', async () => {
  const { child, attesaUscita, segnali } = figlio();
  let mono = 0;
  // Tempo DETERMINISTICO: avanza solo quando l'attesa scade, dell'esatto
  // intervallo chiesto. Con Date.now() un millisecondo reale sprecato prima del
  // primo controllo faceva scadere il budget all'INGRESSO (segnali []), cioe'
  // provava un caso diverso da quello del nome del test.
  const r = await fermaFiglioPosseduto({
    child, attesaUscita, termMs: 200, limiteMono: 100,
    monoNow: () => mono,
    setTimeoutImpl: (fn, ms) => { mono += ms; return setTimeout(fn, 0); },
    clearTimeoutImpl: clearTimeout,
  });
  assert.equal(r.uscito, false);
  assert.equal(r.motivo, 'scaduta');
  assert.deepEqual(segnali, ['SIGTERM'], `segnali dopo la scadenza: ${segnali.join(',')}`);
  assert.equal(mono, 100, `l'attesa del TERM doveva consumare il residuo, non ${mono}`);
});

test('R4: KILL dentro il budget, attesa limitata al residuo e nessuna finestra nuova', async () => {
  const { child, attesaUscita, segnali } = figlio();
  let mono = 0;
  const durate = [];
  const r = await fermaFiglioPosseduto({
    child, attesaUscita, termMs: 20, limiteMono: 2000,
    monoNow: () => mono,
    setTimeoutImpl: (fn, ms) => { durate.push(ms); return setTimeout(() => { mono += ms; fn(); }, 0); },
    clearTimeoutImpl: clearTimeout,
  });
  assert.equal(r.uscito, false);
  assert.equal(r.motivo, 'scaduta');
  assert.deepEqual(segnali, ['SIGTERM', 'SIGKILL']);
  assert.equal(durate[0], 20, `attesa TERM ${durate[0]}`);
  assert.ok(durate[1] <= 2000, `attesa dopo KILL ${durate[1]} oltre il residuo`);
  assert.ok(durate[1] > 0, 'attesa dopo KILL nulla o negativa');
});

test('R4: uscita durante il TERM: nessuna escalation', async () => {
  const { child, attesaUscita, segnali } = figlio({ esceA: 'SIGTERM' });
  const r = await fermaFiglioPosseduto({
    child, attesaUscita, termMs: 200, limiteMono: 2000,
    monoNow: () => 0, setTimeoutImpl: setTimeout, clearTimeoutImpl: clearTimeout,
  });
  assert.equal(r.uscito, true);
  assert.deepEqual(segnali, ['SIGTERM']);
});
