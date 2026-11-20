'use strict';
// Preflight dell'up con un record di lancio rimasto e nessun canale di
// controllo (demone riavviato, canale morto): la riconciliazione automatica
// prima del rifiuto.
//
// Il difetto che questi test fissano: con il record presente e il canale
// perso, l'up rispondeva 409 SESSION_DUPLICATE senza nemmeno valutare le
// prove, anche quando il valutatore condiviso — lo stesso del down senza
// canale e dell'endpoint esplicito di riconciliazione — le avrebbe chiuse
// tutte (server e supervisore morti per identita', sessione assente, lease
// none). La cella restava ingessata finche' un operatore non chiudeva la
// pratica a mano.
//
// Contratti:
//  - record v2 attested con server e supervisore morti per identita',
//    sessione assente e lease none: l'up riconcilia il record e LANCIA;
//  - stesso record con supervisore VIVO: il rifiuto resta (nessun lancio,
//    record intatto) e la causa e' dichiarata: il supervisore vivo e' fra
//    i blocchi;
//  - record v1 completo (server vecchio morto, supervisore morto): l'up
//    riconcilia e lancia, percorso ternario di sempre.

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

// Ferma per PID esatto e ATTENDE la scomparsa senza bloccare l'event loop.
async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Scrive un record v2 fino alla fase richiesta, con le API del modulo (come
// i test del down senza canale).
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

function quarantena(d, launchId = LID) {
  return launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, launchId);
}

// L'esito dell'up come VALORE: un rifiuto (409) deve arrivare qui come
// asserzione fallita col proprio testo, non come eccezione non gestita.
async function esitoUp(runtime, cella) {
  return runtime.up(cella).then(
    (r) => ({ ok: r.ok === true, risposta: r }),
    (e) => ({
      ok: false,
      perche: e && e.status != null
        ? `${e.status} ${e.fleetCode || '-'} ${e.message}`
        : String(e && e.message || e),
    }),
  );
}

// ---------------------------------------------------------------------------
// T1 — record v2 attested, server e supervisore morti per identita': l'up
// riconcilia il record e lancia.
// ---------------------------------------------------------------------------
test('record v2 attested con server e supervisore morti: l’up riconcilia e lancia', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  await morto(sup.pid);
  await morto(srv.pid);
  scrivi(d, 'attested', {
    owner: OWNER_INSTANCE_ID,
    created: { serverPid: srv.pid, serverStarttime: nascitaSrv },
    attested: { panePid: sup.pid, paneStarttime: nascitaSup },
  });
  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });

  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, true, `l'up con il record vecchio e' stato rifiutato: ${esito.perche || JSON.stringify(esito.risposta)}`);

  // La pratica vecchia e' chiusa in quarantena; il record presente e' del
  // lancio appena emesso, e un solo ticket e' stato chiesto al broker.
  assert.ok(fs.existsSync(quarantena(d)), 'il record del lancio vecchio non e’ in quarantena');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente', 'dopo il lancio deve esserci il record del lancio nuovo');
  assert.notEqual(dopo.record.launchId, LID, 'il record presente e’ ancora quello del lancio vecchio');
  assert.equal(calls.issue, 1, 'un solo ticket di lancio emesso');
});

// ---------------------------------------------------------------------------
// T2 — stesso record ma supervisore VIVO: il rifiuto resta, nessun lancio, e
// la causa (il supervisore vivo) e' dichiarata fra i blocchi.
// ---------------------------------------------------------------------------
test('record v2 attested con supervisore vivo: resta 409, nessun lancio, causa dichiarata', async (t) => {
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
  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409, 'il rifiuto resta un 409');
    assert.equal(e.fleetCode, 'SESSION_DUPLICATE');
    return true;
  });

  // Nessun lancio: nessun ticket, nessuna creazione di sessione, record
  // intatto byte per byte.
  assert.equal(calls.issue, 0, 'nessun ticket di lancio per una pratica non chiudibile');
  assert.ok(!W.chiamateTmux(d).some((c) => String(c).includes('new-session')), 'nessuna creazione di sessione');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'il record non va toccato');

  // E la causa e' dichiarata: la diagnosi read-only vede il supervisore vivo
  // fra i blocchi della pratica.
  const st = await runtime.launchState(d.cella);
  assert.ok(st.blockers.includes('SUPERVISOR_ALIVE'),
    `la causa dichiarata deve essere il supervisore vivo: ${JSON.stringify(st.blockers)}`);
});

// ---------------------------------------------------------------------------
// T3 — record v1 completo con server vecchio morto: l'up riconcilia e lancia.
// ---------------------------------------------------------------------------
test('record v1 completo con server vecchio: l’up riconcilia e lancia', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  await morto(sup.pid);
  await morto(srv.pid);
  const scritto = launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    serverPid: srv.pid, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  });
  assert.equal(scritto, true, 'record v1 non scritto');
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });

  const esito = await esitoUp(runtime, d.cella);
  assert.equal(esito.ok, true, `l'up con il record v1 vecchio e' stato rifiutato: ${esito.perche || JSON.stringify(esito.risposta)}`);

  assert.ok(fs.existsSync(quarantena(d)), 'il record v1 riconciliato non e’ in quarantena');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente', 'dopo il lancio deve esserci il record del lancio nuovo');
  assert.notEqual(dopo.record.launchId, LID, 'il record presente e’ ancora quello del lancio vecchio');
  assert.equal(calls.issue, 1, 'un solo ticket di lancio emesso');
});

// ---------------------------------------------------------------------------
// T4 — record v1 completo SENZA serverStarttime (campo assente per schema) e
// serverPid VIVO, sessione assente. Senza nascita il pid non dimostra l'identità
// del listener: la pratica NON si chiude, l'up resta 409 STOP_UNKNOWN e nessun
// lancio parte. La chiusura automatica ambigua sparisce, con un errore preciso.
// ---------------------------------------------------------------------------
test('record v1 senza serverStarttime con serverPid VIVO: nessuna chiusura, 409 STOP_UNKNOWN', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t); // server VIVO, nessuna nascita: identità non dimostrabile
  await morto(sup.pid);
  const scritto = launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    serverPid: srv.pid, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  });
  assert.equal(scritto, true, 'record v1 non scritto');
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN', 'una lettura non conclusa non è un duplicato provato');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    return true;
  });
  assert.equal(calls.issue, 0, 'nessun ticket: la pratica non è chiusa');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'il record non va toccato');
});

// ---------------------------------------------------------------------------
// T5 — stesso record v1 con la sessione omonima VIVA: la presenza è letta su un
// listener NON correlato al server del record, quindi non è un duplicato
// qualificato. Il 409 è STOP_UNKNOWN, mai SESSION_DUPLICATE.
// ---------------------------------------------------------------------------
test('record v1 senza serverStarttime con sessione omonima viva: 409 STOP_UNKNOWN, presenza non qualificata', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { omonima: true } });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  await morto(sup.pid);
  launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    serverPid: srv.pid, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  });
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN', 'senza identità del server non c\'è duplicato qualificato');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    return true;
  });
  assert.equal(calls.issue, 0, 'nessun ticket per una pratica non chiudibile');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'il record non va toccato');
});

// ---------------------------------------------------------------------------
// T6 — record bloccato SENZA prova di duplicato (v1, socket diverso →
// SERVER_UNKNOWN/replaced-unknown): il 409 dice STOP_UNKNOWN, non
// SESSION_DUPLICATE, e porta le prove con se'.
// ---------------------------------------------------------------------------
test('record bloccato senza prova di duplicato: 409 STOP_UNKNOWN con le prove', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  await morto(sup.pid);
  launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: '/tmp/altro-socket',
    serverPid: srv.pid, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  });
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN', 'nessun duplicato provato: non e\' SESSION_DUPLICATE');
    assert.equal(e.data.prove.proofs.server, 'replaced-unknown');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    return true;
  });
  assert.equal(calls.issue, 0, 'nessun ticket per una pratica non chiudibile');
});

// ---------------------------------------------------------------------------
// T7 — R1, il controesempio: record SENZA serverPid (nessuna
// identità di server), supervisore registrato MORTO (pane respawnato) e
// sessione RINOMINATA ma VIVA. La query per nome dice «assente»: senza la
// ricerca degli id ORIGINALI il record verrebbe archiviato e un secondo up
// ammesso con la vecchia sessione ancora operativa. S2b: l'oggetto trovato per
// id su un listener NON correlato non è un duplicato PROVATO (gli id si
// rinumerano da zero), quindi il 409 è STOP_UNKNOWN con il blocco conservativo
// SERVER_UNKNOWN e l'id originale in evidenza: mai archivio, mai rilancio.
// ---------------------------------------------------------------------------
test('record senza serverPid con sessione rinominata viva e pane respawnato: 409 conservativo per id originale', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { rinominata: true, idVivi: true } });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    serverPid: null, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  });
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN', 'senza identità del server l\'id non è un duplicato qualificato');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    assert.equal(e.data.prove.proofs.sessionIdOriginale, 'session', 'la prova dice comunque quale oggetto originale vive');
    return true;
  });
  assert.equal(calls.issue, 0, 'nessun ticket: la vecchia sessione è ancora viva');
  assert.ok(!W.chiamateTmux(d).some((c) => c.join(' ').includes('new-session')), 'nessun secondo lancio');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'il record non va toccato');
});

// ---------------------------------------------------------------------------
// T8 — R1, la seconda gamba: sessione $5 morta ma pane %9 vivo in un'ALTRA
// sessione (spostato prima della chiusura). Il nome non c'è, l'id di sessione
// nemmeno: è l'id di PANE a mostrare che un oggetto con quell'id esiste. Record
// senza serverPid: l'oggetto è su un listener non correlato, quindi blocco
// conservativo (SERVER_UNKNOWN) e mai archivio.
// ---------------------------------------------------------------------------
test('record senza serverPid con sessione morta ma pane originale vivo altrove: 409 conservativo per id di pane', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { paneAltrove: true } });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  launchTarget.registra(d.filesRoot, d.sessione, {
    launchId: LID, sessionId: '$5', paneId: '%9', tmuxSocket: sharedTmuxSocketPath(),
    serverPid: null, panePid: sup.pid, paneStarttime: nascitaSup, family: 'other',
  });
  const { runtime, calls } = W.apriRuntime(d, {});
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    assert.equal(e.data.prove.proofs.sessionIdOriginale, 'pane', 'la prova è l\'id di PANE originale');
    return true;
  });
  assert.equal(calls.issue, 0, 'nessun ticket');
});

// ---------------------------------------------------------------------------
// T9 — R1, la classe nuova: record MATERIALIZZATO senza
// identita' del server (serverPid assente), sostituto senza nome ne' id,
// supervisore registrato morto e lease none. Le assenze lette sul listener
// corrente non provano niente sul server ORIGINARIO: l'up non riconcilia
// (409 STOP_UNKNOWN), il record resta byte-identico, nessun ticket.
// ---------------------------------------------------------------------------
test('record v2 attested senza serverPid: le assenze sul sostituto non chiudono l\'up', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  scrivi(d, 'attested', {
    owner: OWNER_INSTANCE_ID,
    created: { serverPid: null, serverStarttime: null },
    attested: { panePid: sup.pid, paneStarttime: nascitaSup },
  });
  const { runtime, calls } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN', 'il server originario non e\' verificabile: nessuna chiusura automatica');
    assert.equal(e.data.prove.prova, 'ternary', 'la morte del supervisore resta provata');
    assert.equal(e.data.prove.proofs.session, 'absent', 'l\'assenza resta la lettura osservata');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    return true;
  });
  assert.equal(calls.issue, 0, 'nessun ticket');
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima, 'il record non va toccato');
  assert.equal(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), false, 'niente quarantena');
});

// ---------------------------------------------------------------------------
// T10 — stessa classe con un oggetto che porta l'ID ORIGINALE sul listener
// corrente: non e' un duplicato provato (gli id si rinumerano da zero), ma
// resta un veto conservativo. L'evidenza dice QUALE id e' stato visto.
// ---------------------------------------------------------------------------
test('record v2 attested senza serverPid con un ID originale sul corrente: veto conservativo', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other', scenario: { idVivi: true } });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  await morto(sup.pid);
  scrivi(d, 'attested', {
    owner: OWNER_INSTANCE_ID,
    created: { serverPid: null, serverStarttime: null },
    attested: { panePid: sup.pid, paneStarttime: nascitaSup },
  });
  const { runtime } = W.apriRuntime(d, { owner: true, cfg: { identitaNodoKernel: nodoOra() } });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const prima = fs.readFileSync(W.fileRecord(d), 'utf8');

  await assert.rejects(() => runtime.up(d.cella), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'STOP_UNKNOWN');
    assert.ok(e.data.prove.blocchi.includes('SERVER_UNKNOWN'));
    assert.ok(!e.data.prove.blocchi.includes('SESSION_PRESENT'), 'un id non correlato non e\' un duplicato provato');
    assert.equal(e.data.prove.proofs.sessionIdOriginale, 'session', 'l\'oggetto visto resta in evidenza');
    return true;
  });
  assert.equal(fs.readFileSync(W.fileRecord(d), 'utf8'), prima);
});
