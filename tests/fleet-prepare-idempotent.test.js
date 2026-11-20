'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const groupStopPath = require.resolve('../lib/fleet/group-stop.js');
const leaseServerPath = require.resolve('../lib/fleet/cell-lease-server.js');
const leaseClientPath = require.resolve('../lib/fleet/lease-client.js');

const gruppo = require(groupStopPath);
const { createLeaseManager } = require(leaseServerPath);
const { startLeaseClient } = require(leaseClientPath);

function hexId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tickMicrotasks(turns = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i += 1) {
    p = p.then(() => new Promise((r) => setImmediate(r)));
  }
  return p;
}

async function attendi(check, ms = 4000, stepMs = 15) {
  const deadline = Date.now() + ms;
  while (true) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error('attesa scaduta');
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function creaCoordHarness(overrides = {}) {
  let clock = 1000;
  let cancellaCalls = 0;
  let stoppingCalls = 0;
  let disarmCalls = 0;
  let ignoraCalls = 0;
  let svuotaCalls = 0;
  const killSignals = [];
  const inviati = [];
  const log = [];

  const token = overrides.token || hexId(32);
  const launchId = overrides.launchId || hexId(8);
  const cancellaDelivery = overrides.cancellaDelivery || (async () => 1);

  const coord = gruppo.creaCoordinatore({
    token,
    launchId,
    monoNow: overrides.monoNow || (() => clock),
    sleep: overrides.sleep || (async (ms) => { clock += ms; }),
    killGruppo: overrides.killGruppo || ((sig) => { killSignals.push(sig); }),
    osserva: overrides.osserva || (() => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' })),
    invia: overrides.invia || ((frame) => { inviati.push(frame); }),
    svuota: overrides.svuota || (async () => { svuotaCalls += 1; }),
    cancellaDelivery: async (...args) => {
      cancellaCalls += 1;
      if (overrides.onCancella) return overrides.onCancella(cancellaCalls, ...args);
      return cancellaDelivery(...args);
    },
    scriviLog: (r) => { log.push(r); },
    dichiaraStopping: () => { stoppingCalls += 1; },
    disarmaLegacy: () => { disarmCalls += 1; },
    installaIgnoraTerm: () => { ignoraCalls += 1; },
  });

  return {
    coord,
    token,
    tokenHash: sha256Hex(token),
    launchId,
    inviati,
    killSignals,
    log,
    counts: () => ({
      cancellaCalls,
      stoppingCalls,
      disarmCalls,
      ignoraCalls,
      svuotaCalls,
    }),
    advanceClock: (ms) => { clock += ms; },
  };
}

async function apriCanaleControllo(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pre-'));
  const runDir = path.join(home, '.nexuscrew', 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const cellId = options.cellId || 'CellaPre';
  const token = options.token || hexId(32);
  const launchId = options.launchId || hexId(8);
  const onServerControlFrames = [];
  const onClientControlFrames = [];

  let clock = 5000;
  const mgr = createLeaseManager({
    home,
    monoNow: options.monoNow || (() => clock),
    onControlFrame: (id, frame) => {
      onServerControlFrames.push({ cellId: id, frame });
      if (options.onServerControlFrame) options.onServerControlFrame(id, frame);
    },
  });

  const pairPath = path.join(runDir, 'pair.sock');
  let serverSide = null;
  const acceptedSockets = [];
  const srv = net.createServer((sock) => {
    serverSide = sock;
    acceptedSockets.push(sock);
  });
  await new Promise((resolve) => srv.listen(pairPath, resolve));

  const clientSide = await new Promise((resolve, reject) => {
    const s = net.connect(pairPath, () => resolve(s));
    s.on('error', reject);
  });
  await attendi(() => serverSide != null);

  const tracked = await mgr.track(cellId);
  mgr.armControl(cellId, { launchId, token });

  const coord = options.coordFactory
    ? options.coordFactory({ launchId, token })
    : creaCoordHarness({ launchId, token }).coord;

  let leaseCtl = null;
  const forwardToCoord = (frame) => {
    onClientControlFrames.push(frame);
    if (options.interceptClientFrame) {
      const keep = options.interceptClientFrame(frame);
      if (keep === false) return;
    }
    if (coord) coord.onFrame(frame);
  };

  leaseCtl = startLeaseClient(clientSide, {
    stablePath: path.join(runDir, 'no-reconnect.sock'),
    launchEpoch: tracked.launchEpoch,
    onControlFrame: forwardToCoord,
  });

  // Wire coord.invia if default harness was not supplied custom invia.
  const clients = [leaseCtl];
  const rawSockets = [clientSide];

  t.after(async () => {
    for (const c of clients) {
      try { c.stop(); } catch (_) {}
    }
    for (const s of rawSockets) {
      try { s.destroy(); } catch (_) {}
    }
    for (const s of acceptedSockets) {
      try { s.destroy(); } catch (_) {}
    }
    await new Promise((resolve) => srv.close(() => resolve()));
    try { await mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  await attendi(() => leaseCtl._heldProof() != null && mgr.controlConnesso(cellId));

  async function collegaNuovoSocket({ generation = 1, onClientFrame } = {}) {
    serverSide = null;
    const nextClient = await new Promise((resolve, reject) => {
      const s = net.connect(pairPath, () => resolve(s));
      s.on('error', reject);
    });
    rawSockets.push(nextClient);
    await attendi(() => serverSide != null);
    const nextLease = startLeaseClient(nextClient, {
      stablePath: path.join(runDir, 'no-reconnect.sock'),
      launchEpoch: tracked.launchEpoch,
      onControlFrame: onClientFrame || (() => {}),
    });
    clients.push(nextLease);
    assert.equal(mgr.attachInitial(cellId, serverSide, { generation }), true);
    await attendi(() => nextLease._heldProof() != null && mgr.controlConnesso(cellId));
    return { clientSocket: nextClient, serverSocket: serverSide, leaseClient: nextLease };
  }

  return {
    home,
    runDir,
    pairPath,
    cellId,
    token,
    tokenHash: sha256Hex(token),
    launchId,
    tracked,
    mgr,
    coord,
    leaseCtl,
    clientSide,
    serverSide,
    onServerControlFrames,
    onClientControlFrames,
    collegaNuovoSocket,
    monoNow: () => clock,
    advanceClock: (ms) => { clock += ms; },
  };
}

test('3.1 retry prepare dopo prepare-ack perso ri-emette ack correlato senza rieseguire cancellaDelivery', async () => {
  const h = creaCoordHarness();
  const req1 = hexId();
  const req2 = hexId();

  h.coord.onFrame({ op: 'prepare', requestId: req1, launchId: h.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(h.counts().cancellaCalls, 1);
  assert.equal(h.coord.preparazione(), true);
  assert.equal(h.inviati.length, 1);
  assert.equal(h.inviati[0].op, 'prepare-ack');
  assert.equal(h.inviati[0].payload.stopRequestId, req1);

  // Simula prepare-ack perso sul filo: il chiamante reinvia prepare con un nuovo requestId.
  h.coord.onFrame({ op: 'prepare', requestId: req2, launchId: h.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(h.counts().cancellaCalls, 1, '3.1: cancellaDelivery non va rieseguita sul retry');
  const acks = h.inviati.filter((f) => f.op === 'prepare-ack');
  assert.equal(acks.length, 2, '3.1: secondo prepare deve ricevere prepare-ack correlato');
  assert.equal(acks[1].launchId, h.launchId);
  assert.equal(acks[1].epoch, 1);
  assert.equal(acks[1].payload.stopRequestId, req2);
  assert.equal(acks[1].payload.tokenHash, h.tokenHash);
});

test('3.2 due prepare concorrenti su cancellaDelivery sospesa eseguono una volta sola ed entrambi ricevono ack dopo il resolve', async () => {
  const gate = createDeferred();
  const h = creaCoordHarness({
    onCancella: async () => gate.promise,
  });
  const req1 = hexId();
  const req2 = hexId();

  h.coord.onFrame({ op: 'prepare', requestId: req1, launchId: h.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(h.counts().cancellaCalls, 1);
  assert.equal(h.inviati.length, 0, '3.2: nessun prepare-ack prima che cancellaDelivery risolva');

  h.coord.onFrame({ op: 'prepare', requestId: req2, launchId: h.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(h.counts().cancellaCalls, 1, '3.2: il secondo prepare concorrente non deve avviare una seconda cancellaDelivery');
  assert.equal(h.inviati.length, 0, '3.2: nessun ack mentre cancellaDelivery resta sospesa');

  gate.resolve(1);
  await tickMicrotasks();

  const acks = h.inviati.filter((f) => f.op === 'prepare-ack');
  assert.equal(acks.length, 2, '3.2: entrambi i prepare pendenti devono ricevere prepare-ack dopo il resolve');
  assert.deepEqual(
    acks.map((f) => f.payload.stopRequestId).sort(),
    [req1, req2].sort(),
  );
});

test('3.3 retry prepare post-completamento con requestId nuovo ri-emette ack correlato senza doppio effetto e stop successivo resta pulito', async () => {
  const h = creaCoordHarness();
  const req1 = hexId();
  const req2 = hexId();
  const reqStop = hexId();

  h.coord.onFrame({ op: 'prepare', requestId: req1, launchId: h.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(h.counts().cancellaCalls, 1);
  assert.equal(h.counts().stoppingCalls, 0);
  assert.equal(h.killSignals.length, 0);
  assert.equal(h.inviati.filter((f) => f.op === 'prepare-ack').length, 1);

  h.coord.onFrame({ op: 'prepare', requestId: req2, launchId: h.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(h.counts().cancellaCalls, 1, '3.3: nessun doppio effetto su retry post-completamento');
  assert.equal(h.counts().stoppingCalls, 0);
  assert.equal(h.killSignals.length, 0);
  const ack2 = h.inviati.find((f) => f.op === 'prepare-ack' && f.payload?.stopRequestId === req2);
  assert.ok(ack2, '3.3: atteso prepare-ack correlato al requestId del retry');
  assert.equal(ack2.payload.tokenHash, h.tokenHash);

  h.coord.onFrame({ op: 'stop', requestId: reqStop, launchId: h.launchId, epoch: 1, payload: { deadlineMs: 300 } });
  await h.coord.attiva();

  assert.equal(h.inviati.filter((f) => f.op === 'stop-ack').length, 1);
  assert.equal(h.inviati.filter((f) => f.op === 'ready-to-exit').length, 1);
  assert.equal(h.counts().svuotaCalls, 1);
  assert.equal(JSON.stringify(h.inviati).includes(h.token), false);
});

test('3.4 frame prepare con launchId/epoch/dedup o token errati vengono ignorati; frame autentico ammesso', async (t) => {
  // Parte A: launchId / epoch < ultimaEpoca / dedup requestId su creaCoordinatore + positivo autentico.
  const h = creaCoordHarness();
  const badLaunchReq = hexId();
  const validReq = hexId();
  const staleEpochReq = hexId();

  h.coord.onFrame({ op: 'prepare', requestId: badLaunchReq, launchId: hexId(8), epoch: 2 });
  await tickMicrotasks();
  assert.equal(h.counts().cancellaCalls, 0, '3.4: launchId errato va ignorato');
  assert.equal(h.inviati.length, 0);

  // Positivo non vacuo all epoch 2.
  h.coord.onFrame({ op: 'prepare', requestId: validReq, launchId: h.launchId, epoch: 2 });
  await tickMicrotasks();
  assert.equal(h.counts().cancellaCalls, 1, '3.4: frame autentico deve passare');
  assert.equal(h.inviati.length, 1);
  assert.equal(h.inviati[0].op, 'prepare-ack');
  assert.equal(h.inviati[0].payload.stopRequestId, validReq);

  // Limit of this base: the coordinator raises its epoch together with the
  // prepared flag, and its public surface exposes no way to reset prepared,
  // phase or the request-id set. Every state in which a stale epoch could be
  // discriminated already has the general guard true, so this block proves
  // the observable refusal as a whole, not the two separate mutants of that
  // branch. The authenticated wire path and its filters are proved apart.
  // epoch < ultimaEpoca (1 < 2) e requestId duplicato vengono ignorati.
  h.coord.onFrame({ op: 'prepare', requestId: staleEpochReq, launchId: h.launchId, epoch: 1 });
  h.coord.onFrame({ op: 'prepare', requestId: validReq, launchId: h.launchId, epoch: 2 });
  await tickMicrotasks();
  assert.equal(h.counts().cancellaCalls, 1);
  assert.equal(h.inviati.length, 1);

  // Parte B: token/launchId/epoch/dedup sul percorso autenticato handleControlFrame.
  const conn = await apriCanaleControllo(t);
  const epoch = conn.mgr.controlEpoch(conn.cellId);
  assert.ok(Number.isSafeInteger(epoch) && epoch > 0);

  const okReq1 = hexId();
  const badTokenReq = hexId();
  const badEpochReq = hexId();
  const badLaunchWireReq = hexId();
  const okReq2 = hexId();

  // Positivo autenticato ammesso verso listener.
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: okReq1,
    launchId: conn.launchId,
    epoch,
    payload: { stopRequestId: hexId(), tokenHash: conn.tokenHash },
  });
  await attendi(() => conn.onServerControlFrames.length === 1);
  assert.equal(conn.onServerControlFrames[0].frame.requestId, okReq1);

  // Token errato, launchId errato, epoch errata, requestId duplicato: nessuna consegna al listener.
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: badTokenReq,
    launchId: conn.launchId,
    epoch,
    payload: { stopRequestId: hexId(), tokenHash: sha256Hex('token-sbagliato') },
  });
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: badLaunchWireReq,
    launchId: hexId(8),
    epoch,
    payload: { stopRequestId: hexId(), tokenHash: conn.tokenHash },
  });
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: badEpochReq,
    launchId: conn.launchId,
    epoch: epoch + 5,
    payload: { stopRequestId: hexId(), tokenHash: conn.tokenHash },
  });
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: okReq1,
    launchId: conn.launchId,
    epoch,
    payload: { stopRequestId: hexId(), tokenHash: conn.tokenHash },
  });
  // Secondo frame autentico successivo prova che i rifiuti non hanno corrotto il canale valido.
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: okReq2,
    launchId: conn.launchId,
    epoch,
    payload: { stopRequestId: hexId(), tokenHash: conn.tokenHash },
  });
  await attendi(() => conn.onServerControlFrames.length >= 2);
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(
    conn.onServerControlFrames.map((x) => x.frame.requestId),
    [okReq1, okReq2],
  );
});

test('3.5 prepare con stopRichiesto o fase stop attiva viene scartato senza riapertura ne ack', async () => {
  // Sottocaso A: stop gia in corso prima di prepare.
  const gateStop = createDeferred();
  const hStopFirst = creaCoordHarness({
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
    svuota: async () => gateStop.promise,
  });

  const stopReqA = hexId();
  const latePrepA = hexId();
  hStopFirst.coord.onFrame({ op: 'stop', requestId: stopReqA, launchId: hStopFirst.launchId, epoch: 1, payload: { deadlineMs: 500 } });
  await tickMicrotasks();
  assert.equal(hStopFirst.coord.stopAttivo() != null, true);
  const cancellaAfterStopA = hStopFirst.counts().cancellaCalls;

  hStopFirst.coord.onFrame({ op: 'prepare', requestId: latePrepA, launchId: hStopFirst.launchId, epoch: 1 });
  await tickMicrotasks();
  assert.equal(hStopFirst.counts().cancellaCalls, cancellaAfterStopA, '3.5: prepare durante stop non deve chiamare cancellaDelivery');
  assert.equal(hStopFirst.coord.preparazione(), false);
  assert.equal(hStopFirst.inviati.some((f) => f.op === 'prepare-ack'), false);

  gateStop.resolve();
  await hStopFirst.coord.attiva();
  assert.equal(hStopFirst.inviati.some((f) => f.op === 'ready-to-exit'), true);

  // Sottocaso B: prepare completata prima di stop, poi arriva stop, poi nuovo prepare -> scartato.
  const gateStopB = createDeferred();
  const hPrepThenStop = creaCoordHarness({
    svuota: async () => gateStopB.promise,
  });
  const prepReq1 = hexId();
  const stopReqB = hexId();
  const prepReqAfterStop = hexId();

  hPrepThenStop.coord.onFrame({ op: 'prepare', requestId: prepReq1, launchId: hPrepThenStop.launchId, epoch: 1 });
  await tickMicrotasks();
  assert.equal(hPrepThenStop.counts().cancellaCalls, 1);
  assert.equal(hPrepThenStop.inviati.filter((f) => f.op === 'prepare-ack').length, 1);

  hPrepThenStop.coord.onFrame({ op: 'stop', requestId: stopReqB, launchId: hPrepThenStop.launchId, epoch: 1, payload: { deadlineMs: 500 } });
  await tickMicrotasks();
  const cancellaAfterStopB = hPrepThenStop.counts().cancellaCalls;

  hPrepThenStop.coord.onFrame({ op: 'prepare', requestId: prepReqAfterStop, launchId: hPrepThenStop.launchId, epoch: 1 });
  await tickMicrotasks();

  assert.equal(hPrepThenStop.counts().cancellaCalls, cancellaAfterStopB, '3.5: retry prepare dopo stopRichiesto va scartato');
  assert.equal(hPrepThenStop.inviati.filter((f) => f.op === 'prepare-ack').length, 1);
  assert.equal(
    hPrepThenStop.inviati.some((f) => f.payload?.stopRequestId === prepReqAfterStop),
    false,
  );

  gateStopB.resolve();
  await hPrepThenStop.coord.attiva();
});

test('3.6 consultaPrepareCache popola da prepare-ack validato e invalida su EOF/revoke/riarmo/rebind/stop', async (t) => {
  const conn = await apriCanaleControllo(t, {
    coordFactory: ({ launchId, token }) => {
      const h = creaCoordHarness({
        launchId,
        token,
        invia: (frame) => conn.leaseCtl.sendControl(frame),
      });
      return h.coord;
    },
  });

  // Verifica la presenza dell'API consultaPrepareCache sul leaseManager.
  assert.equal(
    typeof conn.mgr.consultaPrepareCache,
    'function',
    '3.6: capability consultaPrepareCache mancante nel leaseManager',
  );

  const checkCache = (extra = {}) => conn.mgr.consultaPrepareCache(conn.cellId, {
    launchId: extra.launchId ?? conn.launchId,
    deadlineAt: extra.deadlineAt ?? (conn.monoNow() + 5000),
    monoNow: extra.monoNow || conn.monoNow,
  });

  // Prima di qualsiasi prepare: cache assente.
  assert.equal(checkCache(), false);

  const epoch1 = conn.mgr.controlEpoch(conn.cellId);
  const prepReq1 = hexId();
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: prepReq1, launchId: conn.launchId, epoch: epoch1, payload: { deadlineMs: 1000 },
  }), true);
  await attendi(() => conn.onServerControlFrames.some((x) => x.frame.op === 'prepare-ack'));

  // Hit sincrono per la stessa tupla e controlli fail-closed su launchId/deadlineAt.
  assert.equal(checkCache(), true);
  assert.equal(checkCache({ launchId: hexId(8) }), false);
  assert.equal(checkCache({ deadlineAt: conn.monoNow() }), false);
  assert.equal(checkCache({ deadlineAt: Number.NaN }), false);

  // Invalidazione 1: revokeControl.
  conn.mgr.revokeControl(conn.cellId);
  assert.equal(checkCache(), false);

  // Riarma stesso launchId con token diverso -> deve restare invalidata fino a nuovo prepare-ack.
  const token2 = hexId(32);
  conn.mgr.armControl(conn.cellId, { launchId: conn.launchId, token: token2 });
  assert.equal(checkCache(), false);

  // Riconnessione (rebind / bindLiveSocket) e nuovo prepare con token2.
  const h2 = creaCoordHarness({
    launchId: conn.launchId,
    token: token2,
    invia: (frame) => conn2.leaseClient.sendControl(frame),
  });
  const conn2 = await conn.collegaNuovoSocket({
    generation: 1,
    onClientFrame: (frame) => h2.coord.onFrame(frame),
  });
  const epoch2 = conn.mgr.controlEpoch(conn.cellId);
  const beforeAckCount = conn.onServerControlFrames.length;
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: hexId(), launchId: conn.launchId, epoch: epoch2, payload: { deadlineMs: 1000 },
  }), true);
  await attendi(() => conn.onServerControlFrames.length > beforeAckCount);
  assert.equal(checkCache(), true);

  // Invalidazione 2: rebind del socket (bindLiveSocket/cambio socket) a parita di launchId/token invalida cache calda.
  await conn.collegaNuovoSocket({ generation: 2, onClientFrame: () => {} });
  assert.equal(checkCache(), false);

  // Ripopola con un secondo giro per poi testare riarmo token diverso.
  const h2b = creaCoordHarness({
    launchId: conn.launchId,
    token: token2,
    invia: (frame) => conn2b.leaseClient.sendControl(frame),
  });
  const conn2b = await conn.collegaNuovoSocket({
    generation: 3,
    onClientFrame: (frame) => h2b.coord.onFrame(frame),
  });
  const epoch2b = conn.mgr.controlEpoch(conn.cellId);
  const beforeAck2b = conn.onServerControlFrames.length;
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: hexId(), launchId: conn.launchId, epoch: epoch2b, payload: { deadlineMs: 1000 },
  }), true);
  await attendi(() => conn.onServerControlFrames.length > beforeAck2b);
  assert.equal(checkCache(), true);

  // Invalidazione 3: riarmo stesso launchId con token diverso invalida cache calda.
  const token3 = hexId(32);
  conn.mgr.armControl(conn.cellId, { launchId: conn.launchId, token: token3 });
  assert.equal(checkCache(), false);

  // Ripopola sul socket attuale per verificare invalidazione da stop (anche su write fallita).
  const h3 = creaCoordHarness({
    launchId: conn.launchId,
    token: token3,
    invia: (frame) => conn3.leaseClient.sendControl(frame),
  });
  const conn3 = await conn.collegaNuovoSocket({
    generation: 4,
    onClientFrame: (frame) => h3.coord.onFrame(frame),
  });
  const epoch3 = conn.mgr.controlEpoch(conn.cellId);
  const beforeAck3 = conn.onServerControlFrames.length;
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: hexId(), launchId: conn.launchId, epoch: epoch3, payload: { deadlineMs: 1000 },
  }), true);
  await attendi(() => conn.onServerControlFrames.length > beforeAck3);
  assert.equal(checkCache(), true);

  // Invalidazione 3: lo stop invalida la cache anche quando la write fallisce.
  // La precondizione calda si osserva SUBITO PRIMA, e il fallimento NON passa
  // dal socket distrutto: un frame non codificabile fa fallire sendControl
  // lasciando viva la connessione, cosi' l'unica causa dell'invalidazione e'
  // lo stop e non la perdita del canale.
  assert.equal(checkCache(), true, '3.6(stop-write-fallita): precondizione cache calda');
  const stopWriteEsito = conn.mgr.sendControl(conn.cellId, {
    op: 'stop',
    requestId: hexId(),
    launchId: conn.launchId,
    epoch: epoch3,
    payload: { deadlineMs: 200, nonCodificabile: 10n },
  });
  assert.equal(stopWriteEsito, false, '3.6(stop-write-fallita): la write deve fallire');
  assert.equal(conn.mgr.controlConnesso(conn.cellId), true, '3.6(stop-write-fallita): canale ancora vivo');
  assert.equal(checkCache(), false, '3.6(stop-write-fallita): lo stop invalida anche con write fallita');

  // Controllo distinto: la perdita del canale invalida da sola. Non e' l'oracolo
  // usato sopra, ma la sua esistenza va dimostrata separatamente.
  conn3.clientSocket.destroy();
  conn3.serverSocket.destroy();
  await attendi(() => !conn.mgr.controlConnesso(conn.cellId));
  assert.equal(checkCache(), false, '3.6(canale-perso): EOF distrugge la cache');

  // Invalidazione 4: EOF su un nuovo canale caldo invalida la cache.
  const token4 = hexId(32);
  conn.mgr.armControl(conn.cellId, { launchId: conn.launchId, token: token4 });
  const h4 = creaCoordHarness({
    launchId: conn.launchId,
    token: token4,
    invia: (frame) => conn4.leaseClient.sendControl(frame),
  });
  const conn4 = await conn.collegaNuovoSocket({
    generation: 5,
    onClientFrame: (frame) => h4.coord.onFrame(frame),
  });
  const epoch4 = conn.mgr.controlEpoch(conn.cellId);
  const beforeAck4 = conn.onServerControlFrames.length;
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: hexId(), launchId: conn.launchId, epoch: epoch4, payload: { deadlineMs: 1000 },
  }), true);
  await attendi(() => conn.onServerControlFrames.length > beforeAck4);
  assert.equal(checkCache(), true);

  conn4.clientSocket.end();
  await attendi(() => !conn.mgr.controlConnesso(conn.cellId));
  assert.equal(checkCache(), false, '3.6(eof): EOF invalida la cache');

  // Invalidazione close su cache CALDA: si ripopola su un canale nuovo, si
  // osserva il caldo e solo allora si chiude il manager.
  const token5 = hexId(32);
  conn.mgr.armControl(conn.cellId, { launchId: conn.launchId, token: token5 });
  const h5 = creaCoordHarness({
    launchId: conn.launchId,
    token: token5,
    invia: (frame) => conn5.leaseClient.sendControl(frame),
  });
  const conn5 = await conn.collegaNuovoSocket({
    generation: 6,
    onClientFrame: (frame) => h5.coord.onFrame(frame),
  });
  const epoch5 = conn.mgr.controlEpoch(conn.cellId);
  const beforeAck5 = conn.onServerControlFrames.length;
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: hexId(), launchId: conn.launchId, epoch: epoch5, payload: { deadlineMs: 1000 },
  }), true);
  await attendi(() => conn.onServerControlFrames.length > beforeAck5);
  assert.equal(checkCache(), true, '3.6(close): precondizione cache calda');

  await conn.mgr.close();
  assert.equal(checkCache(), false, '3.6(close): close invalida la cache calda');
});

test('3.6 pending requestId max 64 per entry ed epoca, il superamento e rifiutato prima della write', async (t) => {
  // Nessun coordinatore consegnato: i prepare restano senza ack, quindi i
  // pending si accumulano davvero e il tetto e' esercitato.
  const conn = await apriCanaleControllo(t, {
    interceptClientFrame: () => false,
  });
  const epoch = conn.mgr.controlEpoch(conn.cellId);
  const ammessi = [];
  for (let i = 0; i < 64; i += 1) {
    const requestId = hexId();
    assert.equal(conn.mgr.sendControl(conn.cellId, {
      op: 'prepare', requestId, launchId: conn.launchId, epoch, payload: { deadlineMs: 60000 },
    }), true, `3.6(pending-64): il prepare ${i + 1} entro il tetto deve partire`);
    ammessi.push(requestId);
  }
  const oltreTetto = hexId();
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'prepare', requestId: oltreTetto, launchId: conn.launchId, epoch, payload: { deadlineMs: 60000 },
  }), false, '3.6(pending-64): il 65o prepare va rifiutato prima della write');
  await attendi(() => conn.onClientControlFrames.length === 64);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(
    conn.onClientControlFrames.map((f) => f.requestId),
    ammessi,
    '3.6(pending-64): il rifiutato non deve raggiungere il filo',
  );
});

test('3.7 vecchio coordinatore risponde 1 volta -> cache valida al 2o attendiPreparazione; rebind o cache assente non promuovono prepared', async (t) => {
  const clientSawPrepare = [];
  let answerPrepare = true;

  const conn = await apriCanaleControllo(t, {
    coordFactory: ({ launchId, token }) => gruppo.creaCoordinatore({
      token,
      launchId,
      monoNow: () => 1000,
      sleep: async () => {},
      killGruppo: () => {},
      osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
      invia: (frame) => conn.leaseCtl.sendControl(frame),
      svuota: async () => {},
      cancellaDelivery: async () => 1,
      scriviLog: () => {},
      dichiaraStopping: () => {},
      disarmaLegacy: () => {},
      installaIgnoraTerm: () => {},
    }),
    interceptClientFrame: (frame) => {
      if (frame.op === 'prepare') {
        clientSawPrepare.push(frame);
        return answerPrepare;
      }
      return true;
    },
  });

  // 1a attendiPreparazione: il coordinatore risponde una sola volta via canale reale.
  const first = await gruppo.attendiPreparazione({
    leaseManager: conn.mgr,
    cellId: conn.cellId,
    launchId: conn.launchId,
    monoNow: () => Date.now(),
    deadlineAt: Date.now() + 1500,
  });
  assert.equal(first.outcome, 'prepared');
  assert.equal(clientSawPrepare.length, 1);

  // Simula vecchio coordinatore muto al 2o prepare sullo stesso canale: deve passare via cache.
  answerPrepare = false;
  const second = await gruppo.attendiPreparazione({
    leaseManager: conn.mgr,
    cellId: conn.cellId,
    launchId: conn.launchId,
    monoNow: () => Date.now(),
    deadlineAt: Date.now() + 200,
  });
  assert.equal(second.outcome, 'prepared', '3.7: secondo attendiPreparazione sullo stesso socket vivo deve usare cache prepare-ack');
  assert.equal(clientSawPrepare.length, 1, '3.7: nessuna nuova write prepare attesa in hit cache');

  // Rebind su nuovo socket (simula restart/reconnect senza risposta dal nuovo coordinatore):
  // cache assente NON deve promuovere prepared.
  await conn.collegaNuovoSocket({
    generation: 1,
    onClientFrame: () => {}, // nuovo peer silente, nessuna risposta prepare-ack
  });
  const afterRebind = await gruppo.attendiPreparazione({
    leaseManager: conn.mgr,
    cellId: conn.cellId,
    launchId: conn.launchId,
    monoNow: () => Date.now(),
    deadlineAt: Date.now() + 120,
  });
  assert.notEqual(afterRebind.outcome, 'prepared', '3.7: rebind con cache assente non deve promuovere prepared');
  assert.equal(afterRebind.outcome, 'stop-unknown');
});

test('3.8 cache invalidata a sendControl(stop) e prepare-ack tardivo non ripopola', async (t) => {
  const clientSawPrepare = [];
  let muteClientPrepare = false;
  let lastPrepareReqId = null;

  const conn = await apriCanaleControllo(t, {
    coordFactory: ({ launchId, token }) => gruppo.creaCoordinatore({
      token,
      launchId,
      monoNow: () => 1000,
      sleep: async () => {},
      killGruppo: () => {},
      osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
      invia: (frame) => conn.leaseCtl.sendControl(frame),
      svuota: async () => {},
      cancellaDelivery: async () => 1,
      scriviLog: () => {},
      dichiaraStopping: () => {},
      disarmaLegacy: () => {},
      installaIgnoraTerm: () => {},
    }),
    interceptClientFrame: (frame) => {
      if (frame.op === 'prepare') {
        clientSawPrepare.push(frame);
        lastPrepareReqId = frame.requestId;
        return !muteClientPrepare;
      }
      return true;
    },
  });

  // Popola la cache al primo attendiPreparazione.
  const res1 = await gruppo.attendiPreparazione({
    leaseManager: conn.mgr,
    cellId: conn.cellId,
    launchId: conn.launchId,
    monoNow: () => Date.now(),
    deadlineAt: Date.now() + 1500,
  });
  assert.equal(res1.outcome, 'prepared');
  assert.equal(clientSawPrepare.length, 1);

  // Pre-condizione non vacua: cache calda prima dello stop.
  muteClientPrepare = true;
  const hotHit = await gruppo.attendiPreparazione({
    leaseManager: conn.mgr,
    cellId: conn.cellId,
    launchId: conn.launchId,
    monoNow: () => Date.now(),
    deadlineAt: Date.now() + 200,
  });
  assert.equal(hotHit.outcome, 'prepared', '3.8: pre-condizione cache calda prima di sendControl(stop)');
  assert.equal(clientSawPrepare.length, 1);

  // Spedisce stop e poi un prepare-ack tardivo sulla stessa epoca/socket.
  const epoch = conn.mgr.controlEpoch(conn.cellId);
  const stopReq = hexId();
  assert.equal(conn.mgr.sendControl(conn.cellId, {
    op: 'stop',
    requestId: stopReq,
    launchId: conn.launchId,
    epoch,
    payload: { deadlineMs: 400 },
  }), true);

  // Barriera di PROCESSAMENTO indipendente dalla consegna del tardivo al
  // listener. La sentinella non e' il frame rifiutabile: e' uno stop-ack
  // VALIDO e correlato allo stop appena spedito (il suo requestId, tokenHash
  // corrente) sullo stesso flusso ordinato. Entrambe le politiche conformi la
  // consegnano — chi consegna il tardivo senza memorizzarlo e chi lo scarta
  // prima del listener — mentre un prepare-ack post-stop puo' essere scartato
  // per contratto. Se la barriera non passa, l'esito e' un'asserzione
  // contrattuale, non l'Error di timeout dell'helper.
  conn.leaseCtl.sendControl({
    op: 'prepare-ack',
    requestId: hexId(),
    launchId: conn.launchId,
    epoch,
    payload: { stopRequestId: lastPrepareReqId, tokenHash: conn.tokenHash },
  });
  conn.leaseCtl.sendControl({
    op: 'stop-ack',
    requestId: stopReq,
    launchId: conn.launchId,
    epoch,
    payload: { stopRequestId: stopReq, tokenHash: conn.tokenHash },
  });
  let sentinellaOsservata = false;
  try {
    await attendi(
      () => conn.onServerControlFrames.some((x) => x.frame.op === 'stop-ack' && x.frame.requestId === stopReq),
      1500,
    );
    sentinellaOsservata = true;
  } catch (_) {
    sentinellaOsservata = false;
  }
  assert.equal(
    sentinellaOsservata,
    true,
    '3.8: barriera di processamento non osservata (lo stop-ack valido dopo il tardivo non ha raggiunto il listener)',
  );

  // Nuovo attendiPreparazione: cache invalidata e NON ripopolata -> ritenta su filo e resta stop-unknown.
  const afterStop = await gruppo.attendiPreparazione({
    leaseManager: conn.mgr,
    cellId: conn.cellId,
    launchId: conn.launchId,
    monoNow: () => Date.now(),
    deadlineAt: Date.now() + 120,
  });
  assert.equal(clientSawPrepare.length, 2, '3.8: dopo sendControl(stop) e ack tardivo la cache deve risultare invalidata');
  assert.equal(afterStop.outcome, 'stop-unknown');
});

test('3.9 cancellaDelivery in attesa con stop o cambio epoch durante await non emette prepare-ack al resume', async () => {
  // Sottocaso A: stop ricevuto mentre cancellaDelivery e sospesa.
  const gateStop = createDeferred();
  const hStop = creaCoordHarness({
    onCancella: async () => gateStop.promise,
  });
  const prepReqStop = hexId();
  const stopReq = hexId();

  hStop.coord.onFrame({ op: 'prepare', requestId: prepReqStop, launchId: hStop.launchId, epoch: 1 });
  await tickMicrotasks();
  assert.equal(hStop.inviati.length, 0);

  hStop.coord.onFrame({
    op: 'stop', requestId: stopReq, launchId: hStop.launchId, epoch: 1, payload: { deadlineMs: 400 },
  });
  await tickMicrotasks();

  gateStop.resolve(1);
  await hStop.coord.attiva();
  await tickMicrotasks();

  assert.equal(
    hStop.inviati.some((f) => f.op === 'prepare-ack'),
    false,
    '3.9: dopo stop durante cancellaDelivery, al resume non deve essere emesso prepare-ack',
  );
  assert.equal(hStop.inviati.some((f) => f.op === 'stop-ack'), true);
  assert.equal(hStop.inviati.some((f) => f.op === 'ready-to-exit'), true);

  // Sottocaso B: cambio epoch mentre cancellaDelivery e sospesa all epoch 1.
  const gateEpoch = createDeferred();
  let callIndex = 0;
  const hEpoch = creaCoordHarness({
    onCancella: async () => {
      callIndex += 1;
      if (callIndex === 1) return gateEpoch.promise;
      return 1;
    },
  });
  const prepEpoch1 = hexId();
  const prepEpoch2 = hexId();

  hEpoch.coord.onFrame({ op: 'prepare', requestId: prepEpoch1, launchId: hEpoch.launchId, epoch: 1 });
  await tickMicrotasks();

  // Arriva un frame valido ad epoch 2 mentre l epoch 1 sta attendendo cancellaDelivery.
  hEpoch.coord.onFrame({ op: 'prepare', requestId: prepEpoch2, launchId: hEpoch.launchId, epoch: 2 });
  await tickMicrotasks();

  gateEpoch.resolve(1);
  await tickMicrotasks();

  const ackEpoch1 = hEpoch.inviati.filter(
    (f) => f.op === 'prepare-ack' && f.payload?.stopRequestId === prepEpoch1,
  );
  assert.equal(
    ackEpoch1.length,
    0,
    '3.9: al resume dopo cambio epoch non deve uscire il prepare-ack della vecchia epoca',
  );
});
