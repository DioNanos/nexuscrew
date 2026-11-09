'use strict';
// Strato R0c: stato onesto della supervisione NC per CELLA nel /status.
// Contratto: active/tmux restano l'osservazione della sessione;
// ncControl dice la verita' di supervisione/controllabilita' NC CORRENTE.
// Nessuna promozione a «sana» o «stopped», nessuna scrittura su GET,
// nessun «none» ricostruito dall'assenza del campo (vecchi server).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../lib/files/activity.js');
const W = require('./helpers/launch-world.js');

// Manager per-cell iniettabile: lease state + qualifica del control +
// readiness (per il caso «dato non corrente») + conteggio delle letture.
// Il launchId del control si CATTURA dal vero up (armControl riceve quello
// assegnato dal runtime): il positivo attested prova il binding con il
// lancio corrente, non un id arbitrario scelto dal test.
function managerDiProva({
  stato = 'live', armato = true, connesso = true,
  booted = true, statusLancia = false,
} = {}) {
  const letture = { status: 0, track: 0 };
  let catturato = null;
  return {
    manager: {
      readiness: () => ({ booted: booted === true }),
      track: async () => { letture.track += 1; return { cellId: 'x', stablePath: '/x', launchEpoch: 'aa'.repeat(8) }; },
      armControl: (_id, opts = {}) => {
        catturato = (opts && opts.launchId) || catturato;
        return { hash: 'a'.repeat(64) };
      },
      status: () => {
        letture.status += 1;
        if (statusLancia) throw new Error('fonte lease non leggibile');
        return { state: stato };
      },
      controlArmato: () => armato === true,
      controlConnesso: () => connesso === true,
      controlLaunchId: () => (armato === true ? catturato : null),
      revokeControl: () => true,
    },
    letture,
  };
}

function mondo(t, { manager = null } = {}) {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  const { runtime, calls } = W.apriRuntime(d, manager ? { leaseManager: manager } : {});
  t.after(() => runtime.shutdown());
  return { d, runtime, ticket: calls };
}

async function cellaDi(runtime, id) {
  const st = await runtime.status();
  return st.cells.find((c) => c.cell === id);
}

test('attiva con lease none: ncControl none, attiva, nessuna promozione a spenta', async (t) => {
  const { manager, letture } = managerDiProva({ stato: 'none' });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, true, 'la sessione resta l\'osservazione: attiva');
  assert.equal(c.ncControl, 'none', 'attiva SENZA supervisione NC attestata');
  assert.equal(c.terminal, undefined, 'nessun esito terminale inventato');
  assert.ok(letture.status >= 1, 'la lease viene letta, non indovinata');
});

test('attiva con lease grace: ncControl reconnecting', async (t) => {
  const { manager } = managerDiProva({ stato: 'grace' });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, true);
  assert.equal(c.ncControl, 'reconnecting', 'controllo in riconnessione, secondo il fatto');
});

test('attiva con lease expired: ncControl expired', async (t) => {
  const { manager } = managerDiProva({ stato: 'expired' });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, true);
  assert.equal(c.ncControl, 'expired', 'scaduto: mai «ferma dall\'operatore» inventata');
});

test('senza manager: ncControl unverifiable, non un none ricostruito', async (t) => {
  const w = mondo(t, {});
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, true);
  assert.equal(c.lease, 'unavailable');
  assert.equal(c.ncControl, 'unverifiable', 'fonte assente: supervisione non verificabile');
});

test('readiness non booted (dato non corrente): ncControl unverifiable', async (t) => {
  const { manager } = managerDiProva({ stato: 'live', booted: false });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, true);
  assert.equal(c.ncControl, 'unverifiable', 'un dato non corrente non e\' un none');
});

test('lettura lease che lancia: ncControl unverifiable', async (t) => {
  const { manager } = managerDiProva({ stato: 'live', statusLancia: true });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.ncControl, 'unverifiable', 'fonte rotta: non verificabile, non none');
});

test('lease live con control armato, connesso e legato: ncControl attested', async (t) => {
  const { manager } = managerDiProva({ stato: 'live' });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.ncControl, 'attested', 'controllo NC attestato');
});

test('lease live con control NON connesso: ncControl unqualified, mai attested', async (t) => {
  const { manager } = managerDiProva({ stato: 'live', connesso: false });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, true);
  assert.equal(c.ncControl, 'unqualified', 'controllo non qualificato: non attestato');
});

test('sessione assente: ncControl inactive', async (t) => {
  const { manager } = managerDiProva({ stato: 'live' });
  const w = mondo(t, { manager });
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.active, false);
  assert.equal(c.ncControl, 'inactive');
});

test('GET status non scrive: nessun nuovo ticket, nessun nuovo track, sola lettura', async (t) => {
  const { manager, letture } = managerDiProva({ stato: 'none' });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const ticketPrima = w.ticket.issue;
  const trackPrima = letture.track;
  await w.runtime.status();
  await w.runtime.status();
  assert.equal(w.ticket.issue, ticketPrima, 'nessun payload di lancio dal GET');
  assert.equal(letture.track, trackPrima, 'nessuna nuova lease dal GET');
});

test('le etichette esistono in tre lingue e dicono NC: modulo condiviso', () => {
  let cv = null;
  try { cv = require('../lib/fleet/control-view.js'); } catch (_) { cv = null; }
  assert.ok(cv, 'il modulo condiviso control-view esiste');
  const viste = ['it', 'en', 'es'].map((lang) => cv.ncControlLabel('none', lang));
  viste.forEach((v) => assert.ok(/NC/i.test(v), `l'etichetta dice NC: ${v}`));
  assert.equal(new Set(viste).size, 3, 'tre lingue, tre testi distinti');
  assert.match(cv.ncControlLabel('attested', 'it'), /attestato/i);
  assert.match(cv.ncControlLabel('reconnecting', 'en'), /reconnecting/i);
  assert.match(cv.ncControlLabel('unverifiable', 'es'), /no verificable/i);
});

test('campo assente (vecchio server): il client NON ricostruisce none', () => {
  let cv = null;
  try { cv = require('../lib/fleet/control-view.js'); } catch (_) { cv = null; }
  assert.ok(cv, 'il modulo condiviso control-view esiste');
  assert.equal(cv.ncControlFromCell({ active: true, tmux: true }), 'unverifiable',
    'assenza del campo = supervisione non verificabile, mai «senza supervisione»');
  assert.equal(cv.ncControlFromCell({ active: true, ncControl: 'none' }), 'none');
  assert.equal(cv.ncControlFromCell(null), 'unverifiable');
});

test('il booleano statico supervised resta configurazione, non attestazione', async (t) => {
  const { manager } = managerDiProva({ stato: 'none' });
  const w = mondo(t, { manager });
  await w.runtime.up(w.d.cella);
  const c = await cellaDi(w.runtime, w.d.cella);
  assert.equal(c.supervised, true, 'la capacita\' configurata resta esposta');
  assert.equal(c.ncControl, 'none', 'ma lo stato autorevole dice la verita\' corrente');
});

// Ramo FILE del binding: seconda vista read-only, senza la mappa volatile del
// primo runtime — l'autorita' del lancio corrente sta nel registro persistito
// scritto dal VERO up. Il confronto e' sul solo launchId del record.
test('binding dal registro persistito: positivo, negativi e GET passivo', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' }); t.after(() => W.pulisci(d));
  let id = null; let arm = 0; let track = 0;
  const managerDiVista = (over = {}) => ({
    readiness: () => ({ booted: true }),
    status: () => ({ state: 'live' }),
    track: async () => { track += 1; return { stablePath: '/fixture', launchEpoch: 'ab'.repeat(8) }; },
    armControl: (_cella, opts = {}) => { arm += 1; id = opts.launchId || id; return { hash: 'a'.repeat(64) }; },
    controlArmato: () => true,
    controlConnesso: () => true,
    controlLaunchId: () => id,
    revokeControl: () => true,
    ...over,
  });
  const recordDi = (dir) => path.join(d.filesRoot, dir, `${d.sessione}.json`);
  const first = W.apriRuntime(d, { leaseManager: managerDiVista() }).runtime;
  t.after(() => first.shutdown());
  await first.up(d.cella);
  const recordPrima = A.leggiLancioCorrente(d.filesRoot, d.sessione);
  assert.equal(recordPrima && recordPrima.launchId, id, 'record persistito dal vero up');

  // Positivo: seconda vista read-only, stessa fonte, stesso id sul registro.
  const reader = W.apriRuntime(d, { leaseManager: managerDiVista() }).runtime;
  t.after(() => reader.shutdown());
  assert.equal((await reader.status()).cells[0].ncControl, 'attested',
    'registro persistito con lo stesso id: attestation valida senza memoria volatile');
  // GET passivo: due letture non armano, non tracciano, non riscrivono il record.
  const trackPrima = track; const armPrima = arm;
  await reader.status(); await reader.status();
  assert.equal(track, trackPrima, 'nessun nuovo track dal GET');
  assert.equal(arm, armPrima, 'nessun nuovo armControl dal GET');
  assert.deepEqual(A.leggiLancioCorrente(d.filesRoot, d.sessione), recordPrima,
    'il registro persistito non e\' stato toccato');

  // Negativo: id di un ALTRO lancio sulla stessa fonte valida.
  const altro = W.apriRuntime(d, { leaseManager: managerDiVista({ controlLaunchId: () => 'cd'.repeat(8) }) }).runtime;
  t.after(() => altro.shutdown());
  assert.equal((await altro.status()).cells[0].ncControl, 'unqualified', 'id diverso: mai attested');

  // Negativo: record illeggibile (garbage in entrambe le copie) => assenza onesta.
  for (const dir of ['launch-registry', 'launch-registry-spare']) fs.writeFileSync(recordDi(dir), '{{{');
  const guasto = W.apriRuntime(d, { leaseManager: managerDiVista() }).runtime;
  t.after(() => guasto.shutdown());
  assert.equal((await guasto.status()).cells[0].ncControl, 'unqualified', 'record illeggibile: nessun binding');

  // Negativo: record assente => nessun binding, mai attested.
  for (const dir of ['launch-registry', 'launch-registry-spare']) fs.rmSync(recordDi(dir), { force: true });
  const senza = W.apriRuntime(d, { leaseManager: managerDiVista() }).runtime;
  t.after(() => senza.shutdown());
  assert.equal((await senza.status()).cells[0].ncControl, 'unqualified', 'record assente: mai attested');
});
