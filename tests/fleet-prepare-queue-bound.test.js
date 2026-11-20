'use strict';

// Regressions of the coordinator queue: cap coherent with the manager cap,
// discarded epochs, drained at stop. Public coordinator API only (incoming and
// emitted frames), no state getter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const groupStopPath = require.resolve('../lib/fleet/group-stop.js');
const gruppo = require(groupStopPath);

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function creaDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function tickMicrotasks(turns = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i += 1) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

function nuovoMondo() {
  const gate = creaDeferred();
  let cancellaCalls = 0;
  let clock = 1000;
  const inviati = [];
  const launchId = hexId(8);
  const coord = gruppo.creaCoordinatore({
    token: hexId(32),
    launchId,
    monoNow: () => clock,
    sleep: async (ms) => { clock += ms; },
    killGruppo: () => {},
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
    invia: (frame) => { inviati.push(frame); },
    svuota: async () => {},
    cancellaDelivery: async () => { cancellaCalls += 1; return gate.promise; },
    scriviLog: () => {},
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
  });
  return {
    coord,
    inviati,
    gate,
    launchId,
    cancellaCalls: () => cancellaCalls,
    prepara(requestId, { lancio = launchId, epoch = 1 } = {}) {
      coord.onFrame({ op: 'prepare', requestId, launchId: lancio, epoch });
    },
    ack() {
      return inviati.filter((f) => f.op === 'prepare-ack');
    },
  };
}

test('coda: la raffica al tetto accoda 64 richieste e una sola cancellazione le serve', async () => {
  const w = nuovoMondo();
  const ammessi = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    ammessi.push(requestId);
    w.prepara(requestId);
  }
  await tickMicrotasks();
  assert.equal(w.cancellaCalls(), 1, 'coda: una sola cancellazione condivisa');
  assert.equal(w.ack().length, 0, 'coda: nessun ack mentre la cancellazione e\' sospesa');

  w.gate.resolve(1);
  await tickMicrotasks();

  assert.equal(w.cancellaCalls(), 1, 'coda: la cancellazione resta una sola anche al resolve');
  assert.deepEqual(
    w.ack().map((f) => f.payload.stopRequestId).sort(),
    ammessi.sort(),
    'coda: tutte le richieste accodate ricevono il proprio ack',
  );
});

test('coda: oltre il tetto la richiesta e\' scartata e non riceve ack', async () => {
  const w = nuovoMondo();
  const ammessi = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    ammessi.push(requestId);
    w.prepara(requestId);
  }
  const oltre = hexId();
  w.prepara(oltre);
  await tickMicrotasks();

  w.gate.resolve(1);
  await tickMicrotasks();

  const ackIds = w.ack().map((f) => f.payload.stopRequestId);
  assert.equal(ackIds.length, 64, 'coda: esattamente 64 ack');
  assert.equal(ackIds.includes(oltre), false, 'coda: la richiesta oltre il tetto non e\' mai ackata');
  for (const requestId of ammessi) {
    assert.equal(ackIds.includes(requestId), true, `coda: ${requestId} riceve il proprio ack`);
  }
});

test('coda: 64 richieste vecchie non occupano i posti delle 64 nuove', async () => {
  const w = nuovoMondo();
  const vecchie = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    vecchie.push(requestId);
    w.prepara(requestId, { epoch: 1 });
  }
  await tickMicrotasks();
  assert.equal(w.cancellaCalls(), 1, 'coda: una sola cancellazione condivisa');
  assert.equal(w.ack().length, 0, 'coda: nessun ack mentre la cancellazione e\' sospesa');

  // The queue is full at epoch 1: the epoch change must free the slots at once,
  // otherwise the new requests would stay out of the cap.
  const nuove = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    nuove.push(requestId);
    w.prepara(requestId, { epoch: 2 });
  }
  await tickMicrotasks();
  assert.equal(w.ack().length, 0, 'coda: nessun ack mentre la cancellazione e\' sospesa');

  w.gate.resolve(1);
  await tickMicrotasks();

  const ackIds = w.ack().map((f) => f.payload.stopRequestId);
  assert.equal(ackIds.length, 64, 'coda: esattamente 64 ack, tutti dell\'epoca corrente');
  assert.deepEqual([...ackIds].sort(), [...nuove].sort(), 'coda: gli ack sono esattamente le 64 richieste nuove');
  assert.equal(
    vecchie.some((requestId) => ackIds.includes(requestId)),
    false,
    'coda: nessun ack di un\'epoca superata',
  );
  assert.equal(w.cancellaCalls(), 1, 'coda: la cancellazione resta una sola');
});

test('coda: lo stop prima del resolve svuota la coda e non emette prepare-ack', async () => {
  const w = nuovoMondo();
  for (let i = 0; i < 5; i += 1) {
    w.prepara(hexId(), { epoch: 1 });
  }
  await tickMicrotasks();
  assert.equal(w.cancellaCalls(), 1);

  w.coord.onFrame({ op: 'stop', requestId: hexId(), launchId: w.launchId, epoch: 1, payload: { deadlineMs: 300 } });
  await tickMicrotasks();

  w.gate.resolve(1);
  await tickMicrotasks();

  assert.equal(w.ack().length, 0, 'coda: nessun prepare-ack dopo lo stop');
  // The stop phase cancels delivery on its own account; what must not happen is
  // an ack of a queued prepare, and the phase must still run to its stop-ack.
  await w.coord.attiva();
  assert.equal(
    w.inviati.some((f) => f.op === 'stop-ack'),
    true,
    'coda: la fase stop si conclude nonostante la coda svuotata',
  );
});
