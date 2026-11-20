'use strict';
// 0.9.83 strato S3 (D4) — l'up rivaluta un record «incerto» invece di
// rifiutarlo a priori. Controprove obbligatorie del disegno D4:
// morto provato su v1 completo incerto e su v2 incerto -> up 200 con record
// vecchio in quarantena; supervisore vivo -> 409 STOP_UNKNOWN con prove;
// omonima presente -> 409 con SESSION_PRESENT; lease grace -> 409; record
// cambiato fra valutazione e commit -> blocca; fleet-boot riparte la cella
// solo dopo riconciliazione conclusa.
//
// La guardia in-process (`esitiIncerti`) resta PRIMA di tutto e invariata:
// la sua controprova è `tests/fleet-uncertain-marker-failure.test.js`, che
// esercita il blocco senza un record incerto su disco (è nella lista dei
// mirati di questo strato, non duplicata qui).
//
// Il riaggancio di un canale VIVO non è testabile con il fake tmux del mondo
// (risponde 2 campi al formato a 4 che la riadozione richiede): la proprietà
// è garantita per costruzione dal flusso (il riaggancio viene PRIMA di ogni
// valutazione) e dichiarata come limite nel referto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const launchTarget = require('../lib/fleet/launch-target.js');
const radici = require('../lib/fleet/vl-roots.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
const W = require('./helpers/launch-world.js');

const { OWNER_INSTANCE_ID } = W;
const LID = 'ab'.repeat(8);
const BOOT_ORA = '11111111-1111-4111-8111-111111111111';
const NS = '4026531836';

const nodoOra = () => () => ({ bootId: BOOT_ORA, pidNamespaceInode: NS });

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function scrivi(d, fase, {
  bootId = BOOT_ORA, pidNs = NS, owner = null, socket = sharedTmuxSocketPath(),
  created = {}, attested = null, famiglia = d.famiglia, launchId = LID,
} = {}) {
  const vl = famiglia === 'vl';
  const own = vl ? OWNER_INSTANCE_ID : owner;
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId, family: famiglia, cellId: d.cella, ownerInstanceId: own, tmuxSocket: socket,
    bootId, pidNs, daemonInc: 'inc-0',
    res: vl ? { vlOwner: OWNER_INSTANCE_ID, vlRoot: radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella) } : null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const passi = ['creating', 'created', 'attested'];
  let da = 'prepared';
  for (const a of passi) {
    if (fase === da) break;
    const campi = a === 'created' ? { sessionId: '$5', windowId: '@7', paneId: '%9', ...created }
      : a === 'attested' ? { ...attested } : {};
    const av = launchTarget.avanza(d.filesRoot, d.sessione, { launchId, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
    da = a;
  }
}

const incerto = (d) => assert.equal(launchTarget.marcaIncerto(d.filesRoot, d.sessione), true, 'marca incerto');
const quarantena = (d, launchId = LID) => launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, launchId);

async function esitoUp(runtime, cella) {
  return runtime.up(cella).then(
    (r) => ({ ok: r.ok === true, risposta: r }),
    (e) => ({ ok: false, err: e, perche: e && e.status != null ? `${e.status} ${e.fleetCode || '-'}` : String(e && e.message || e) }),
  );
}

function v2MortoIncerto(t, d) {
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  return (async () => {
    await morto(sup.pid);
    await morto(srv.pid);
    scrivi(d, 'attested', {
      owner: OWNER_INSTANCE_ID,
      created: { serverPid: srv.pid, serverStarttime: nascitaSrv },
      attested: { panePid: sup.pid, paneStarttime: nascitaSup },
    });
    incerto(d);
  })();
}

test('S3-1: v2 attested incerto, morto provato -> up 200, record vecchio in quarantena, nuovo record', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  await v2MortoIncerto(t, d);
  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, true, `up rifiutato: ${esito.perche}`);
  assert.ok(fs.existsSync(quarantena(d)), 'record vecchio non in quarantena');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente');
  assert.notEqual(dopo.record.launchId, LID, 'il record presente è ancora quello vecchio');
  assert.notEqual(dopo.record.incerto, true, 'il record nuovo non nasce incerto');
  assert.equal(calls.issue, 1, 'un solo ticket');
});

test('S3-2: v1 completo incerto, morto provato -> up 200, quarantena', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  await morto(sup.pid);
  await morto(srv.pid);
  assert.equal(launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    serverPid: srv.pid, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  }), true);
  incerto(d);
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, true, `up rifiutato: ${esito.perche}`);
  assert.ok(fs.existsSync(quarantena(d)), 'record v1 incerto non in quarantena');
  assert.equal(calls.issue, 1);
});

test('S3-3: v2 incerto con supervisore VIVO -> 409 STOP_UNKNOWN con prove, nessun lancio', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  await morto(srv.pid);
  scrivi(d, 'attested', {
    owner: OWNER_INSTANCE_ID,
    created: { serverPid: srv.pid, serverStarttime: nascitaSrv },
    attested: { panePid: sup.pid, paneStarttime: nascitaSup },
  });
  incerto(d);
  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');
  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, false);
  assert.equal(esito.err.status, 409);
  assert.equal(esito.err.fleetCode, 'STOP_UNKNOWN', 'record incerto -> STOP_UNKNOWN, mai SESSION_DUPLICATE');
  assert.ok(esito.err.data && esito.err.data.prove, 'le prove viaggiano nel data');
  assert.ok(esito.err.data.prove.blocchi.includes('SUPERVISOR_ALIVE'), JSON.stringify(esito.err.data.prove.blocchi));
  assert.equal(calls.issue, 0, 'nessun ticket');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'record intatto');
});

test('S3-4: omonima presente -> 409 STOP_UNKNOWN con SESSION_PRESENT', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { omonima: true } });
  t.after(() => W.pulisci(d));
  await v2MortoIncerto(t, d);
  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, false);
  assert.equal(esito.err.fleetCode, 'STOP_UNKNOWN');
  assert.ok(esito.err.data && esito.err.data.prove);
  assert.ok(esito.err.data.prove.blocchi.includes('SESSION_PRESENT'), JSON.stringify(esito.err.data.prove.blocchi));
  assert.equal(calls.issue, 0);
});

test('S3-5: lease in grace -> 409 STOP_UNKNOWN con LEASE_BLOCKS', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  await v2MortoIncerto(t, d);
  const leaseManager = {
    track: async () => null, status: () => ({ state: 'grace' }),
    armControl: () => null, revokeControl: () => {}, controlArmato: () => false,
    controlConnesso: () => false, controlLaunchId: () => null,
  };
  const { runtime, calls } = W.apriRuntime(d, { owner: true, leaseManager, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, false);
  assert.equal(esito.err.fleetCode, 'STOP_UNKNOWN');
  assert.ok(esito.err.data && esito.err.data.prove);
  assert.ok(esito.err.data.prove.blocchi.includes('LEASE_BLOCKS'), JSON.stringify(esito.err.data.prove.blocchi));
  assert.equal(calls.issue, 0);
});

test('S3-6: record cambiato fra valutazione e commit -> blocca, nessuna quarantena', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  await v2MortoIncerto(t, d);
  // Il seam dell'identita' viene chiamato DENTRO la valutazione, dopo la
  // fotografia: il riaggancio ne consuma due (server e supervisore) PRIMA
  // della fotografia, quindi si muta a partire dalla terza chiamata — la
  // prima della valutazione — cambiando una nascita e dichiarando il
  // processo assente.
  let chiamate = 0;
  let mutato = false;
  const identitaProc = () => {
    chiamate += 1;
    if (!mutato && chiamate >= 3) {
      mutato = true;
      const p = W.fileRecord(d);
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      raw.paneStarttime = (Number(raw.paneStarttime) || 1) + 1;
      fs.writeFileSync(p, `${JSON.stringify(raw)}\n`);
    }
    return { esito: 'assente', nascita: null };
  };
  const { runtime, calls } = W.apriRuntime(d, {
    owner: true, identitaProc, cfg: { identitaNodoKernel: nodoOra() },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, false, 'un record cambiato non autorizza la chiusura');
  assert.equal(esito.err.fleetCode, 'STOP_UNKNOWN');
  assert.ok(!fs.existsSync(quarantena(d)), 'nessuna quarantena con il record cambiato');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente');
  assert.equal(dopo.record.incerto, true, 'il record incerto resta tale fino al commit verificato');
  assert.equal(calls.issue, 0);
});

test('S3-7: fleet-boot riparte la cella solo dopo la riconciliazione conclusa', async (t) => {
  const { bootCells } = require('../lib/fleet/boot.js');
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  await v2MortoIncerto(t, d);
  const { runtime } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const adapter = {
    available: true,
    status: async () => ({ cells: [{ cell: d.cella, boot: true, active: false }] }),
    up: async (id) => runtime.up(id),
    launchState: async (id) => runtime.launchState(id),
  };
  const esito = await bootCells(adapter, { log: () => {} });
  assert.deepEqual(esito.started, [d.cella], `fleet-boot deve avviarla: ${JSON.stringify(esito.failed)}`);
  assert.deepEqual(esito.failed, []);
});

test('S3-8: la presenza viva si prova solo con un verdetto affermativo (ok === true)', () => {
  const { presenzaProvata } = require('../lib/fleet/runtime.js');
  assert.equal(presenzaProvata({ ok: true }), true, 'verdetto affermativo');
  for (const nonProva of [
    { ok: false }, { ok: false, assente: true }, { morto: true }, {},
    null, undefined, { ok: 'sì' }, { ok: 1 },
  ]) {
    assert.equal(presenzaProvata(nonProva), false,
      `non e' un duplicato vivo: ${JSON.stringify(nonProva)}`);
  }
});
