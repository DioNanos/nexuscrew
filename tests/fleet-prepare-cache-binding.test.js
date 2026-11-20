'use strict';

// Regressions of the prepare-ack cache binding: generation, pending, stop.
// Wire and public manager API only: no state getters, no field added to the
// protocol.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const leaseServerPath = require.resolve('../lib/fleet/cell-lease-server.js');
const { createLeaseManager } = require(leaseServerPath);

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function attendi(check, ms = 4000, stepMs = 10) {
  const deadline = Date.now() + ms;
  while (true) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('attesa scaduta');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function pausa(ms = 40) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apriMondo(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bind-'));
  const runDir = path.join(home, '.nexuscrew', 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const cellId = 'CellaBind';
  const token = options.token || hexId(32);
  const launchId = options.launchId || hexId(8);
  const ricevuti = [];
  const dalServer = [];
  let clock = 5000;
  let letture = 0;

  // The manager clock is a seam, not a cfg field: pass it as the second
  // argument so the diagnostic timestamp is really observable.
  const mgr = createLeaseManager(
    { home, onControlFrame: (id, frame) => { ricevuti.push({ id, frame }); } },
    { monotonicNow: () => { letture += 1; return clock; } },
  );

  const pairPath = path.join(runDir, 'pair.sock');
  let serverSide = null;
  const accepted = [];
  const srv = net.createServer((sock) => { serverSide = sock; accepted.push(sock); });
  await new Promise((resolve) => srv.listen(pairPath, resolve));

  const clientSide = await new Promise((resolve, reject) => {
    const s = net.connect(pairPath, () => resolve(s));
    s.on('error', reject);
  });
  clientSide.setEncoding('utf8');
  clientSide.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      try { dalServer.push(JSON.parse(line)); } catch (_) { /* lease noise */ }
    }
  });
  await attendi(() => serverSide != null);

  await mgr.track(cellId);
  mgr.armControl(cellId, { launchId, token });
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  await attendi(() => mgr.controlConnesso(cellId));

  t.after(async () => {
    try { clientSide.destroy(); } catch (_) {}
    for (const s of accepted) { try { s.destroy(); } catch (_) {} }
    await new Promise((resolve) => srv.close(() => resolve()));
    try { await mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  const dalBordo = (frame) => clientSide.write(`${JSON.stringify(frame)}\n`);

  return {
    mgr,
    cellId,
    token,
    tokenHash: sha256Hex(token),
    launchId,
    ricevuti,
    dalServer,
    adesso: () => clock,
    lettureClock: () => letture,
    avanza: (ms) => { clock += ms; },
    dalBordo,
    inviaPrepare(requestId, lancio = launchId) {
      return this.mgr.sendControl(this.cellId, {
        op: 'prepare', requestId, launchId: lancio, payload: { deadlineMs: 1000 },
      });
    },
    inviaPrepareRotto(requestId, lancio = launchId) {
      return this.mgr.sendControl(this.cellId, {
        op: 'prepare', requestId, launchId: lancio, payload: { deadlineMs: 1000, nonCodificabile: 10n },
      });
    },
    inviaAck(stopRequestId, { lancio = launchId, epoca, tokenHash = sha256Hex(token) } = {}) {
      const frame = {
        op: 'prepare-ack',
        requestId: hexId(),
        launchId: lancio,
        epoch: epoca === undefined ? this.mgr.controlEpoch(this.cellId) : epoca,
        payload: { stopRequestId, tokenHash },
      };
      dalBordo(frame);
      return frame.requestId;
    },
    hit(extra = {}) {
      const opzioni = {
        launchId: extra.launchId === undefined ? this.launchId : extra.launchId,
        deadlineAt: extra.deadlineAt === undefined ? clock + 5000 : extra.deadlineAt,
      };
      // An explicit undefined means "no callback at all", not "use the default".
      if (!Object.prototype.hasOwnProperty.call(extra, 'monoNow')) opzioni.monoNow = () => clock;
      else if (extra.monoNow !== undefined) opzioni.monoNow = extra.monoNow;
      return this.mgr.consultaPrepareCache(this.cellId, opzioni);
    },
    async attendiFrame(op, quanti = 1) {
      await attendi(() => ricevuti.filter((x) => x.frame.op === op).length >= quanti);
    },
    // The fixture owns the socket object the manager writes to: failing its
    // write exercises the rollback branch without exposing product state.
    rompiWrite() {
      const sock = serverSide;
      const originale = sock.write;
      sock.write = () => { throw new Error('write boom'); };
      return () => { sock.write = originale; };
    },
    async transizioneGenerazione(generazione) {
      // Barrier per send: the ack of a previous send for the same generation is
      // already in the buffer, so waiting for "some" would read the cache
      // before this repetition is processed. Count the acks for that generation
      // first and wait for a NEW one produced by this very send.
      const giaPresenti = dalServer.filter(
        (x) => x.type === 'generationAck' && x.generation === generazione,
      ).length;
      dalBordo({ type: 'generation', generation: generazione });
      await attendi(
        () => dalServer.filter((x) => x.type === 'generationAck' && x.generation === generazione).length > giaPresenti,
      );
    },
  };
}

test('generazione: la cache calda non sopravvive alla transizione effettiva', async (t) => {
  const w = await apriMondo(t);
  const req = hexId();
  assert.equal(w.inviaPrepare(req), true);
  w.inviaAck(req);
  await w.attendiFrame('prepare-ack');
  assert.equal(w.hit(), true, 'generazione: preparazione conclusa alla generazione corrente');

  await w.transizioneGenerazione(1);
  assert.equal(w.hit(), false, 'generazione: cache calda alla generazione precedente deve dare miss');
});

test('generazione: un ack della generazione vecchia non riscalda la nuova', async (t) => {
  const w = await apriMondo(t);
  const vecchio = hexId();
  assert.equal(w.inviaPrepare(vecchio), true);
  await pausa();

  await w.transizioneGenerazione(1);
  w.inviaAck(vecchio);
  await w.attendiFrame('prepare-ack');
  assert.equal(
    w.hit(),
    false,
    'generazione: un ack emesso per la generazione precedente non e\' prova della nuova',
  );
});

test('generazione: solo il prepare nuovo e il suo ack alla generazione nuova ridanno hit', async (t) => {
  const w = await apriMondo(t);
  const prima = hexId();
  assert.equal(w.inviaPrepare(prima), true);
  w.inviaAck(prima);
  await w.attendiFrame('prepare-ack');
  await w.transizioneGenerazione(1);
  assert.equal(w.hit(), false);

  const nuova = hexId();
  assert.equal(w.inviaPrepare(nuova), true);
  w.inviaAck(nuova);
  await w.attendiFrame('prepare-ack', 2);
  assert.equal(w.hit(), true, 'generazione: il prepare nuovo e il suo ack ridanno hit');
});

test('generazione: la ripetizione idempotente con la stessa generazione non invalida', async (t) => {
  const w = await apriMondo(t);
  const req = hexId();
  assert.equal(w.inviaPrepare(req), true);
  w.inviaAck(req);
  await w.attendiFrame('prepare-ack');
  await w.transizioneGenerazione(1);
  assert.equal(w.hit(), false);

  const nuova = hexId();
  assert.equal(w.inviaPrepare(nuova), true);
  w.inviaAck(nuova);
  await w.attendiFrame('prepare-ack', 2);
  assert.equal(w.hit(), true);

  await w.transizioneGenerazione(1);
  assert.equal(w.hit(), true, 'generazione: ripetere la stessa generazione non e\' una transizione');
});

test('generazione: i pending della generazione vecchia non sottraggono posti al tetto', async (t) => {
  const w = await apriMondo(t);
  const ammessiPrima = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    assert.equal(w.inviaPrepare(requestId), true, `generazione: prepare ${i + 1} ammesso prima della transizione`);
    ammessiPrima.push(requestId);
  }
  assert.equal(w.inviaPrepare(hexId()), false, 'generazione: il 65o prepare e\' rifiutato prima della transizione');

  await w.transizioneGenerazione(1);

  const ammessiDopo = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    assert.equal(
      w.inviaPrepare(requestId),
      true,
      `generazione: i pending vecchi non devono occupare posti (prepare ${i + 1} alla generazione nuova)`,
    );
    ammessiDopo.push(requestId);
  }
  assert.equal(w.inviaPrepare(hexId()), false, 'generazione: il 65o prepare della generazione nuova e\' rifiutato');
});

test('pending: un ack autentico non correlato a un prepare spedito non riscalda', async (t) => {
  const w = await apriMondo(t);
  w.inviaAck(hexId());
  await w.attendiFrame('prepare-ack');
  assert.equal(w.hit(), false, 'pending: nessun prepare spedito, nessun hit');
});

test('pending: il prepare di un altro launch non diventa autorevole per il launch armato', async (t) => {
  const w = await apriMondo(t);
  const altroLaunch = hexId(8);
  const req = hexId();
  assert.equal(w.inviaPrepare(req, altroLaunch), true, 'pending: il frame estraneo viene comunque scritto');

  w.inviaAck(req, { lancio: w.launchId });
  await w.attendiFrame('prepare-ack');
  assert.equal(
    w.hit(),
    false,
    'pending: un ack del launch armato non si correla al prepare spedito per un launch diverso',
  );

  const proprio = hexId();
  assert.equal(w.inviaPrepare(proprio), true);
  w.inviaAck(proprio);
  await w.attendiFrame('prepare-ack', 2);
  assert.equal(w.hit(), true, 'pending: il prepare del launch armato e il suo ack riscaldano');
});

test('pending: un secondo invio non codificabile dello stesso requestId non perde la correlazione', async (t) => {
  const w = await apriMondo(t);
  const req = hexId();
  assert.equal(w.inviaPrepare(req), true);
  assert.equal(w.inviaPrepareRotto(req), false, 'pending: il secondo invio fallisce in codifica');

  w.inviaAck(req);
  await w.attendiFrame('prepare-ack');
  assert.equal(w.hit(), true, 'pending: la correlazione del primo invio resta valida');
});

test('pending: una richiesta fallita non lascia un posto occupato', async (t) => {
  const w = await apriMondo(t);
  for (let i = 0; i < 63; i += 1) {
    assert.equal(w.inviaPrepare(hexId()), true, `pending: prepare ${i + 1} entro il tetto`);
  }
  assert.equal(w.inviaPrepareRotto(hexId()), false, 'pending: la richiesta non codificabile non e\' ammessa');
  assert.equal(w.inviaPrepare(hexId()), true, 'pending: il posto liberato dalla richiesta fallita torna disponibile');
  assert.equal(w.inviaPrepare(hexId()), false, 'pending: il tetto e\' di nuovo saturo');
});

test('pending: una write che lancia non lascia un posto occupato', async (t) => {
  const w = await apriMondo(t);
  for (let i = 0; i < 63; i += 1) {
    assert.equal(w.inviaPrepare(hexId()), true, `pending: prepare ${i + 1} entro il tetto`);
  }
  const ripristina = w.rompiWrite();
  try {
    assert.equal(w.inviaPrepare(hexId()), false, 'pending: la write che lancia non ammette la richiesta');
  } finally {
    ripristina();
  }
  assert.equal(w.mgr.controlConnesso(w.cellId), true, 'pending: canale ancora vivo dopo la write fallita');
  assert.equal(w.inviaPrepare(hexId()), true, 'pending: il posto liberato dalla write fallita torna disponibile');
  assert.equal(w.inviaPrepare(hexId()), false, 'pending: il tetto e\' di nuovo saturo');
});

test('stop: invalida cache e pending prima della codifica, e il tardivo resta freddo', async (t) => {
  const w = await apriMondo(t);
  const concluso = hexId();
  assert.equal(w.inviaPrepare(concluso), true);
  w.inviaAck(concluso);
  await w.attendiFrame('prepare-ack');
  assert.equal(w.hit(), true, 'stop: precondizione di cache calda');

  const inAttesa = hexId();
  assert.equal(w.inviaPrepare(inAttesa), true);
  assert.equal(
    w.mgr.sendControl(w.cellId, {
      op: 'stop', requestId: hexId(), launchId: w.launchId, payload: { deadlineMs: 200, nonCodificabile: 10n },
    }),
    false,
    'stop: la codifica dello stop fallisce e nessuna write parte',
  );
  assert.equal(w.mgr.controlConnesso(w.cellId), true, 'stop: canale ancora vivo');
  assert.equal(w.hit(), false, 'stop: la cache e\' invalidata anche senza write');

  w.inviaAck(inAttesa);
  await w.attendiFrame('prepare-ack', 2);
  assert.equal(w.hit(), false, 'stop: il tardivo non riscalda la cache');
});

test('stop: svuota i pending, che non occupano piu\' posti', async (t) => {
  const w = await apriMondo(t);
  for (let i = 0; i < 64; i += 1) {
    assert.equal(w.inviaPrepare(hexId()), true, `stop: pending ${i + 1} prima dello stop`);
  }
  assert.equal(w.inviaPrepare(hexId()), false, 'stop: il tetto e\' saturo prima dello stop');
  assert.equal(
    w.mgr.sendControl(w.cellId, {
      op: 'stop', requestId: hexId(), launchId: w.launchId, payload: { deadlineMs: 200, nonCodificabile: 10n },
    }),
    false,
  );
  for (let i = 0; i < 64; i += 1) {
    assert.equal(w.inviaPrepare(hexId()), true, `stop: il posto ${i + 1} e\' libero dopo lo stop`);
  }
  assert.equal(w.inviaPrepare(hexId()), false, 'stop: il tetto torna a valere sui pending nuovi');
});

test('stop: il riarmo dello stesso launch nella stessa epoca resta freddo', async (t) => {
  const w = await apriMondo(t);
  assert.equal(
    w.mgr.sendControl(w.cellId, {
      op: 'stop', requestId: hexId(), launchId: w.launchId, payload: { deadlineMs: 200 },
    }),
    true,
  );
  const nuovoToken = hexId(32);
  w.mgr.armControl(w.cellId, { launchId: w.launchId, token: nuovoToken });

  const req = hexId();
  assert.equal(w.inviaPrepare(req), true);
  w.inviaAck(req, { tokenHash: sha256Hex(nuovoToken) });
  await w.attendiFrame('prepare-ack');
  assert.equal(w.hit(), false, 'stop: dopo lo stop lo stesso launch non torna caldo con un nuovo prepare-ack');
});

test('stop: un launch diverso non eredita il latch e torna caldo col proprio ack', async (t) => {
  const w = await apriMondo(t);
  assert.equal(
    w.mgr.sendControl(w.cellId, {
      op: 'stop', requestId: hexId(), launchId: w.launchId, payload: { deadlineMs: 200 },
    }),
    true,
  );
  const altroLaunch = hexId(8);
  w.mgr.armControl(w.cellId, { launchId: altroLaunch, token: w.token });

  const req = hexId();
  assert.equal(w.inviaPrepare(req, altroLaunch), true);
  w.inviaAck(req, { lancio: altroLaunch });
  await w.attendiFrame('prepare-ack');
  assert.equal(w.hit({ launchId: altroLaunch }), true, 'stop: il launch nuovo si scalda con la propria prova');
  assert.equal(w.hit(), false, 'stop: il launch che aveva subito lo stop resta freddo');
});

test('clock: per l\'hit serve il clock del chiamante, mai quello del manager', async (t) => {
  const w = await apriMondo(t);
  const req = hexId();
  assert.equal(w.inviaPrepare(req), true);
  w.inviaAck(req);
  await w.attendiFrame('prepare-ack');

  // Manager clock 5000, caller clock 100: a deadline already expired for the
  // caller does not become valid because the manager would see it in the future.
  assert.equal(w.hit({ deadlineAt: 50, monoNow: () => 100 }), false, 'clock: scaduta per il chiamante');
  assert.equal(w.hit({ deadlineAt: 150, monoNow: () => 100 }), true, 'clock: valida per il chiamante');
  assert.equal(w.hit({ deadlineAt: 5500 }), true, 'clock: con il clock del test la deadline resta futura');

  assert.equal(w.hit({ monoNow: undefined }), false, 'clock: callback assente');
  assert.equal(w.hit({ monoNow: null }), false, 'clock: callback null');
  assert.equal(w.hit({ monoNow: 42 }), false, 'clock: callback non funzione');
  assert.equal(w.hit({ monoNow: () => { throw new Error('boom'); } }), false, 'clock: callback che lancia');
  assert.equal(w.hit({ monoNow: () => Number.NaN }), false, 'clock: valore non finito');
  assert.equal(w.hit({ monoNow: () => Infinity }), false, 'clock: valore infinito');
  assert.equal(w.hit({ monoNow: () => 100 }), true, 'clock: il positivo resta valido');
});

test('recordedAt: il popolamento legge il clock del manager, che non decide l\'hit', async (t) => {
  const w = await apriMondo(t);
  const req = hexId();
  assert.equal(w.inviaPrepare(req), true);
  const prima = w.lettureClock();
  w.inviaAck(req);
  await w.attendiFrame('prepare-ack');
  assert.ok(w.lettureClock() > prima, 'recordedAt: il clock del manager viene letto durante il popolamento');
  assert.equal(w.hit(), true, 'recordedAt: il positivo resta valido');

  // The manager time moves far ahead: the diagnostic timestamp never enters the
  // judgement, which stays with the caller.
  w.avanza(1000000);
  assert.equal(w.hit({ monoNow: () => 5000, deadlineAt: 5500 }), true, 'recordedAt: non e\' una TTL');
  assert.equal(w.hit({ monoNow: () => 9000, deadlineAt: 5500 }), false, 'recordedAt: decide il chiamante');
});
