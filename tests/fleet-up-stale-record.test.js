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
