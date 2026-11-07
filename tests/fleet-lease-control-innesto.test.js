'use strict';

// S3c mattone 2/3 — innesto del protocollo di controllo sulla connessione
// lease: UN solo parser per stream che smista frame lease ({type}) e frame
// di controllo ({op}) sulla STESSA connessione, epoche per (ri)connessione,
// verificatore hash del token armato al lancio e revocabile.
// Nessun processo reale: socket di test su path temporanei isolati.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');

function hexId() { return crypto.randomBytes(8).toString('hex'); }
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// Ambiente isolato: runtime dir e lease state in tmp, un "broker" fittizio
// che consegna il lato server al manager (attachInitial) e il lato client al
// lease-client reale. Come in produzione: UNA connessione, poi tutto NDJSON.
function creaAmbiente({ onControlFrame } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nc-lease-ctl-${process.pid}-`));
  const dir = path.join(home, '.nexuscrew', 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const mgr = createLeaseManager({ home, ...(onControlFrame ? { onControlFrame } : {}) });
  const stato = { home, dir, mgr, pairPath: path.join(dir, 'pair.sock'), serverSide: null, clientSide: null, srv: null };
  return stato;
}

function apriPair(stato) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(() => {});
    srv.on('error', reject);
    srv.listen(stato.pairPath, () => { stato.srv = srv; resolve(); });
    srv.on('connection', (sock) => { stato.serverSide = sock; });
  });
}

function connettiClient(stato, info) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(stato.pairPath, () => { stato.clientSide = sock; resolve(); });
    sock.on('error', reject);
  }).then(() => startLeaseClient(stato.clientSide, info));
}

function attendi(check, ms = 4000, passo = 25) {
  const fine = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = check(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() > fine) { reject(new Error('attesa scaduta')); return; }
      setTimeout(tick, passo);
    };
    tick();
  });
}

async function chiusura(stato) {
  try { stato.clientSide && stato.clientSide.destroy(); } catch (_) {}
  try { stato.serverSide && stato.serverSide.destroy(); } catch (_) {}
  try { stato.srv && stato.srv.close(); } catch (_) {}
  try { stato.srv && fs.unlinkSync(stato.pairPath); } catch (_) {}
  try { await stato.mgr.close(); } catch (_) {}
  try { fs.rmSync(stato.home, { recursive: true, force: true }); } catch (_) {}
}

test('lease e controllo sulla stessa connessione: un solo parser, framing ostile', async (t) => {
  const cellId = 'cella-a';
  const token = crypto.randomBytes(32).toString('hex');
  const launchId = hexId();
  const controlAlClient = [];
  const controlAlServer = [];
  const stato = creaAmbiente({ onControlFrame: (cId, frame) => controlAlServer.push({ cId, frame }) });
  t.after(() => chiusura(stato));
  const mgr = stato.mgr;

  const info = {
    stablePath: path.join(stato.dir, 'stable-inesistente.sock'),
    launchEpoch: hexId(),
    onControlFrame: (frame) => controlAlClient.push(frame),
  };

  await apriPair(stato);
  await mgr.track(cellId);
  const armed = mgr.armControl(cellId, { launchId, token });
  assert.ok(armed && typeof armed.hash === 'string' && armed.hash.length === 64, 'armControl torna l\'hash');
  // il token NON vive nel manager: l'hash si', il token no
  assert.strictEqual(JSON.stringify(mgr._cells.get(cellId)).includes(token), false);

  const leaseCtl = await connettiClient(stato, info);
  t.after(() => { try { leaseCtl.stop(); } catch (_) {} });
  assert.strictEqual(mgr.attachInitial(cellId, stato.serverSide, { generation: 0 }), true);

  // (1) via lease viva: il refresh iniziale del client produce ack+proof
  await attendi(() => leaseCtl._heldProof() != null);

  // (2) frame di controllo NC -> coordinatore SULLA STESSA connessione
  const reqStop = hexId();
  assert.strictEqual(mgr.sendControl(cellId, { op: 'stop', requestId: reqStop, launchId, payload: { deadlineMs: 3000 } }), true);
  const fStop = await attendi(() => controlAlClient[0]);
  assert.strictEqual(fStop.requestId, reqStop);
  assert.ok(Number.isSafeInteger(fStop.epoch) && fStop.epoch >= 1, 'il frame stop porta l\'epoca della connessione');

  // (3) frame coordinatore -> NC sulla stessa connessione, col proprio hash
  const reqAck = hexId();
  assert.strictEqual(leaseCtl.sendControl({ op: 'stop-ack', requestId: reqAck, launchId, epoch: fStop.epoch, payload: { tokenHash: sha256hex(token) } }), true);
  const ricevuto = await attendi(() => controlAlServer[0]);
  assert.strictEqual(ricevuto.cId, cellId);
  assert.strictEqual(ricevuto.frame.requestId, reqAck);

  // (4) framing ostile: righe lease E di controllo spezzate su piu' write,
  // con un taglio DENTRO una sequenza UTF-8 multibyte del payload e un chunk
  // che chiude la riga 1 e apre la riga 2 (due righe a cavallo). TUTTE
  // consegnate, una volta, intatte: un solo accumulatore per stream.
  const nota = 'fermò-日本-àèü';
  const proofs0 = leaseCtl._heldProof();
  const rLease = Buffer.from('{"type":"refresh"}\n', 'utf8');
  const rCtrl = Buffer.from(`${JSON.stringify({ op: 'stop-ack', requestId: hexId(), launchId, epoch: fStop.epoch, payload: { tokenHash: sha256hex(token), nota } })}\n`, 'utf8');
  const taglio = rCtrl.indexOf(Buffer.from('日', 'utf8')) + 2; // dentro il multibyte
  stato.clientSide.write(rLease.subarray(0, 7));
  stato.clientSide.write(Buffer.concat([rLease.subarray(7), rCtrl.subarray(0, taglio)]));
  stato.clientSide.write(rCtrl.subarray(taglio));
  await attendi(() => (leaseCtl._heldProof() && leaseCtl._heldProof() !== proofs0 ? leaseCtl._heldProof() : null), 2000);
  const conNota = await attendi(() => controlAlServer.find((x) => x.frame.payload && x.frame.payload.nota === nota));
  assert.ok(conNota, 'frame di controllo frammentato (multibyte spezzato) consegnato intatto');
});

test('epoca di connessione: canale sostituito ed epoca vecchia non autoritativi', async (t) => {
  const cellId = 'cella-b';
  const token = crypto.randomBytes(32).toString('hex');
  const launchId = hexId();
  const controlAlClient = [];
  const controlAlServer = [];
  const stato = creaAmbiente({ onControlFrame: (cId, frame) => controlAlServer.push({ cId, frame }) });
  t.after(() => chiusura(stato));
  const mgr = stato.mgr;
  const info = {
    stablePath: path.join(stato.dir, 'no.sock'),
    launchEpoch: hexId(),
    onControlFrame: (frame) => controlAlClient.push(frame),
  };
  await apriPair(stato);
  await mgr.track(cellId);
  mgr.armControl(cellId, { launchId, token });
  const leaseCtl = await connettiClient(stato, info);
  t.after(() => { try { leaseCtl.stop(); } catch (_) {} });
  assert.strictEqual(mgr.attachInitial(cellId, stato.serverSide, { generation: 0 }), true);
  await attendi(() => leaseCtl._heldProof() != null);

  assert.strictEqual(mgr.sendControl(cellId, { op: 'stop', requestId: hexId(), launchId }), true);
  const f1 = await attendi(() => controlAlClient[0]);
  const epoca1 = f1.epoch;

  // risposta con epoca MAI corrente (999): no-op, nessuna consegna
  leaseCtl.sendControl({ op: 'stop-ack', requestId: hexId(), launchId, epoch: 999, payload: { tokenHash: sha256hex(token) } });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(controlAlServer.length, 0, 'epoca non corrente: nessuna consegna');

  // risposta con epoca CORRENTE (quella del frame stop): consegnata
  leaseCtl.sendControl({ op: 'stop-ack', requestId: hexId(), launchId, epoch: epoca1, payload: { tokenHash: sha256hex(token) } });
  await attendi(() => controlAlServer.length === 1);

  // reattach su una SECONDA connessione (come il reconnect reale): l'epoca
  // avanza e il vecchio canale server-side e' detachato: cio' che ancora
  // scrive sul vecchio filo non produce consegne (epoca 1 ora VECCHIA)
  const p2 = path.join(stato.dir, 'p2.sock');
  const srv2 = net.createServer(() => {});
  const duo = await new Promise((resolve) => {
    srv2.listen(p2, () => {
      const c2 = net.connect(p2, () => {});
      srv2.on('connection', (sock) => resolve({ sock, c2 }));
    });
  });
  t.after(() => { try { duo.c2.destroy(); } catch (_) {} try { duo.sock.destroy(); } catch (_) {} try { srv2.close(); } catch (_) {} try { fs.unlinkSync(p2); } catch (_) {} });
  assert.strictEqual(mgr.attachInitial(cellId, duo.sock, { generation: 1 }), true);

  // stop sul canale NUOVO: epoca diversa dalla prima
  assert.strictEqual(mgr.sendControl(cellId, { op: 'stop', requestId: hexId(), launchId }), true);
  // il client sta ancora sul vecchio filo: la sua risposta finisce su un
  // socket server-side detachato -> nessuna consegna al server
  leaseCtl.sendControl({ op: 'stop-ack', requestId: hexId(), launchId, epoch: epoca1, payload: { tokenHash: sha256hex(token) } });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(controlAlServer.length, 1, 'canale sostituito: nessuna consegna dal vecchio filo');
  // la nuova epoca e' diversa dalla prima
  const epoca2 = mgr.controlEpoch ? mgr.controlEpoch(cellId) : undefined;
  assert.ok(Number.isSafeInteger(epoca2) && epoca2 > epoca1, 'reattach = epoca nuova');
});

test('verificatore del token: hash giusto ammesso, sbagliato/assente/revocato rifiutato', async (t) => {
  const cellId = 'cella-c';
  const token = crypto.randomBytes(32).toString('hex');
  const launchId = hexId();
  const controlAlServer = [];
  const stato = creaAmbiente({ onControlFrame: (cId, frame) => controlAlServer.push({ cId, frame }) });
  t.after(() => chiusura(stato));
  const mgr = stato.mgr;
  const info = { stablePath: path.join(stato.dir, 'no.sock'), launchEpoch: hexId() };
  await apriPair(stato);
  await mgr.track(cellId);
  mgr.armControl(cellId, { launchId, token });
  const leaseCtl = await connettiClient(stato, info);
  t.after(() => { try { leaseCtl.stop(); } catch (_) {} });
  assert.strictEqual(mgr.attachInitial(cellId, stato.serverSide, { generation: 0 }), true);
  await attendi(() => leaseCtl._heldProof() != null);
  assert.strictEqual(mgr.sendControl(cellId, { op: 'stop', requestId: hexId(), launchId }), true);

  const spediti = [];
  const spedisci = (frame) => { spediti.push(frame); leaseCtl.sendControl(frame); };
  // epoch e launchId sono obbligatori nel protocollo chiuso e il
  // verificatore li controlla contro il lancio e la connessione correnti:
  // senza epoca il frame non arriva nemmeno al gate dell'hash e il test
  // resterebbe appeso ad attendere una consegna che il protocollo rifiuta.
  const epoca = mgr.controlEpoch(cellId);

  // hash SBAGLIATO -> no-op
  spedisci({ op: 'stop-ack', requestId: hexId(), launchId, epoch: epoca, payload: { tokenHash: sha256hex('token-sbagliato') } });
  // tokenHash ASSENTE -> no-op
  spedisci({ op: 'stop-ack', requestId: hexId(), launchId, epoch: epoca, payload: {} });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(controlAlServer.length, 0, 'hash sbagliato o assente: nessuna consegna');

  // hash GIUSTO -> consegnato; il token stesso non viaggia MAI
  spedisci({ op: 'stop-ack', requestId: hexId(), launchId, epoch: epoca, payload: { tokenHash: sha256hex(token) } });
  await attendi(() => controlAlServer.length === 1);
  assert.ok(spediti.every((x) => !JSON.stringify(x).includes(token)), 'il token non appare in nessun frame spedito');

  // revoca a fine lancio: nessun frame piu' ammesso
  assert.strictEqual(mgr.revokeControl(cellId), true);
  spedisci({ op: 'stop-ack', requestId: hexId(), launchId, epoch: epoca, payload: { tokenHash: sha256hex(token) } });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(controlAlServer.length, 1, 'revocato: nessuna nuova consegna');
});

test('riga malformata o EOF con residuo: connessione rotta, distrutta senza effetti', async (t) => {
  const token = crypto.randomBytes(32).toString('hex');
  const launchId = hexId();
  const stato = creaAmbiente({ onControlFrame: () => {} });
  t.after(() => chiusura(stato));
  const mgr = stato.mgr;
  const info = { stablePath: path.join(stato.dir, 'no.sock'), launchEpoch: hexId() };
  await apriPair(stato);
  await mgr.track('cella-d');
  mgr.armControl('cella-d', { launchId, token });
  const leaseCtl = await connettiClient(stato, info);
  t.after(() => { try { leaseCtl.stop(); } catch (_) {} });
  assert.strictEqual(mgr.attachInitial('cella-d', stato.serverSide, { generation: 0 }), true);
  await attendi(() => leaseCtl._heldProof() != null);

  // riga malformata (JSON rotto, riga completa): protocollo chiuso ->
  // connessione distrutta subito, senza aspettare altri byte
  const chiuso = new Promise((resolve) => stato.serverSide.once('close', resolve));
  stato.clientSide.write('{"op":"stop-ack","requestId":"zz\n');
  await chiuso;
  assert.ok(stato.serverSide.destroyed, 'serverSide distrutto dopo riga malformata');

  // EOF con accumulatore non vuoto = frame troncato = rotto
  const p3 = path.join(stato.dir, 'p3.sock');
  const srv3 = net.createServer(() => {});
  const duo = await new Promise((resolve) => {
    srv3.listen(p3, () => {
      const c3 = net.connect(p3, () => {});
      srv3.on('connection', (sock) => resolve({ sock, c3 }));
    });
  });
  t.after(() => { try { duo.c3.destroy(); } catch (_) {} try { duo.sock.destroy(); } catch (_) {} try { srv3.close(); } catch (_) {} try { fs.unlinkSync(p3); } catch (_) {} });
  await mgr.track('cella-e');
  mgr.armControl('cella-e', { launchId, token });
  assert.strictEqual(mgr.attachInitial('cella-e', duo.sock, { generation: 0 }), true);
  const chiuso2 = new Promise((resolve) => duo.sock.once('close', resolve));
  duo.c3.write('{"type":"refr'); // senza newline, poi EOF
  duo.c3.end();
  await chiuso2;
  assert.ok(duo.sock.destroyed, 'EOF con residuo: connessione distrutta');
});
