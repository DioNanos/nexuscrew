'use strict';
// tests/fleet-launch-queue.test.js — P1-01: la coda di proprieta' del ciclo
// di vita sopravvive al timeout del POST /reconcile.
//
// Il POST che scade risponde busy e smette di aspettare, ma la CATENA resta
// rappresentata in launchLocks finche' il predecessore (e i successori gia'
// accodati) non drenano: mai cancellare un proprietario attivo al timeout.
// Qui si prova quello, nel modo in cui si rompe: up/restart sospeso DENTRO
// issue(), reconcile che scade, GET che deve restare busy, terzo accodato
// prima e dopo il timeout, down/up/restart successivi che NON entrano prima
// del rilascio del broker e poi procedono in FIFO. Stesso runtime e due
// runtime sulla stessa filesRoot/cella (R3: la catena e' per radice+cella).
// Mondo finto via helpers/launch-world: nessun tmux reale, nessun servizio.

const { test } = require('node:test');
const assert = require('node:assert');
const launchTarget = require('../lib/fleet/launch-target.js');
const W = require('./helpers/launch-world.js');

const BUDGET = 250; // groupStopBudgetMs del runtime: attesa limitata del POST
const PAUSA = 500; // osservazione oltre il budget, sempre lontano dai limiti

// Broker con barriera di ARRIVO deterministica: il primo lancio segnala
// `arrivato` quando e' DENTRO issue e resta sospeso finche' il test non
// chiama libera(). Ogni chiamata conta: se un successore oltrepassa la
// catena, `chiamate` cresce mentre il primo e' ancora sospeso.
function brokerSospeso() {
  let chiamate = 0;
  let segnala; let libera;
  const arrivato = new Promise((r) => { segnala = r; });
  const via = new Promise((r) => { libera = r; });
  const issue = async () => {
    chiamate += 1;
    if (chiamate === 1) segnala();
    await via;
    return null;
  };
  return { issue, arrivato, libera: () => { libera(null); }, chiamate: () => chiamate };
}

// Fotografie del record del lancio: stato, fase e launchId.
function fotoRecord(d) {
  const letto = launchTarget.leggi(d.filesRoot, d.sessione);
  return {
    stato: letto.stato,
    phase: letto.record ? letto.record.phase : null,
    launchId: letto.record ? letto.record.launchId : null,
  };
}

// Segna il momento della chiusura di una promise senza propagare il rifiuto
// (la raccolta avviene alla fine, nel finally, anche su rosso).
function insegna(p) {
  const w = { fatto: false, a: 0, ok: null, valore: null };
  p.then(
    (v) => { w.fatto = true; w.a = Date.now(); w.ok = true; w.valore = v; },
    (e) => { w.fatto = true; w.a = Date.now(); w.ok = false; w.valore = e; },
  );
  return w;
}

async function raccogli(promesse) {
  return Promise.all(promesse.map((p) => p.then((v) => v, (e) => e)));
}

async function pausa(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

for (const [nome, stesso] of [['stesso runtime', true], ['due runtime', false]]) {
  // Famiglia 1: up sospeso, timeout RIPETUTI, GET busy, down che non chiude
  // il record di un lancio in corso, FIFO al rilascio.
  test(`P1-01: il timeout del reconcile conserva la catena di un up sospeso (${nome})`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    const b = brokerSospeso();
    const a = W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    const c = stesso ? a : W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    t.after(() => { for (const x of [a, c]) { try { x.runtime.shutdown(); } catch (_) {} } });
    const upP = a.runtime.up(d.cella);
    const upW = insegna(upP);
    await b.arrivato;
    const { launchId } = fotoRecord(d);
    assert.ok(/^[0-9a-f]{16}$/.test(launchId), 'il record prepared dell\'up in corso esiste');
    let downW = null; const downHolder = { p: null };
    try {
      const r1 = await c.runtime.reconcile(d.cella, launchId);
      assert.equal(r1.outcome, 'busy', 'catena occupata oltre il budget = busy');
      const st = await c.runtime.launchState(d.cella);
      assert.equal(st.inFlight, true, 'la GET vede la catena VIVA anche dopo il timeout');
      assert.equal(st.classification, 'busy');
      assert.equal(st.reconcilable, false);
      // Timeout ripetuti: ogni POST nuovo smette di aspettare, la catena no.
      const r2 = await c.runtime.reconcile(d.cella, launchId);
      assert.equal(r2.outcome, 'busy', 'un secondo POST scade come il primo, senza entrare');
      downHolder.p = c.runtime.down(d.cella);
      downW = insegna(downHolder.p);
      await pausa(PAUSA);
      assert.equal(b.chiamate(), 1, 'nessun nuovo lancio oltrepassa l\'up sospeso');
      assert.equal(downW.fatto, false, 'il down NON chiude il record di un lancio in corso');
      assert.deepEqual(fotoRecord(d), { stato: 'presente', phase: 'prepared', launchId },
        'il record prepared resta intatto finche\' l\'up e\' sospeso');
      assert.equal((await c.runtime.launchState(d.cella)).inFlight, true,
        'la catena resta rappresentata fino al rilascio');
      b.libera();
      await raccogli([upP, downHolder.p]);
    } finally {
      b.libera();
      await raccogli([upP, ...(downHolder.p ? [downHolder.p] : [])]);
    }
    assert.ok(upW.fatto && downW.fatto, 'entrambi raccolti dopo il rilascio');
    assert.ok(upW.a <= downW.a, `FIFO: l\'up drena prima del down (${upW.a} vs ${downW.a})`);
    assert.equal((await c.runtime.launchState(d.cella)).inFlight, false,
      'catena drenata: la GET non e\' piu\' busy');
  });

  // Famiglia 2: restart sospeso (la transizione down+up presa UNA volta):
  // stesso contratto del up — il timeout del reconcile non lo scopre.
  test(`P1-01: il timeout del reconcile conserva la catena di un restart sospeso (${nome})`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    const b = brokerSospeso();
    const a = W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    const c = stesso ? a : W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    t.after(() => { for (const x of [a, c]) { try { x.runtime.shutdown(); } catch (_) {} } });
    const resP = a.runtime.restart(d.cella);
    const resW = insegna(resP);
    await b.arrivato;
    const { launchId } = fotoRecord(d);
    let downW = null; const downHolder = { p: null };
    try {
      const r = await c.runtime.reconcile(d.cella, launchId);
      assert.equal(r.outcome, 'busy');
      const st = await c.runtime.launchState(d.cella);
      assert.equal(st.inFlight, true, 'la transizione restart e\' ancora in corso');
      assert.equal(st.classification, 'busy');
      downHolder.p = c.runtime.down(d.cella);
      downW = insegna(downHolder.p);
      await pausa(PAUSA);
      assert.equal(b.chiamate(), 1);
      assert.equal(downW.fatto, false, 'il down aspetta la fine dell\'intera transizione');
      assert.equal(fotoRecord(d).stato, 'presente');
      b.libera();
      await raccogli([resP, downHolder.p]);
    } finally {
      b.libera();
      await raccogli([resP, ...(downHolder.p ? [downHolder.p] : [])]);
    }
    assert.ok(resW.fatto && downW.fatto);
    assert.ok(resW.a <= downW.a, `FIFO: il restart drena prima del down (${resW.a} vs ${downW.a})`);
    assert.equal((await c.runtime.launchState(d.cella)).inFlight, false);
  });

  // Famiglia 3: terzo accodato PRIMA del timeout — il POST che scade non
  // cancella la coda nemmeno con un successore gia' dietro di lui.
  test(`P1-01: terzo accodato prima del timeout resta in fila (${nome})`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    const b = brokerSospeso();
    const a = W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    const c = stesso ? a : W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    t.after(() => { for (const x of [a, c]) { try { x.runtime.shutdown(); } catch (_) {} } });
    const upP = a.runtime.up(d.cella);
    const upW = insegna(upP);
    await b.arrivato;
    const { launchId } = fotoRecord(d);
    const recP = c.runtime.reconcile(d.cella, launchId);
    await pausa(80); // il terzo entra mentre il POST sta ancora aspettando
    const resP = a.runtime.restart(d.cella);
    const resW = insegna(resP);
    try {
      const r = await recP;
      assert.equal(r.outcome, 'busy');
      const st = await c.runtime.launchState(d.cella);
      assert.equal(st.inFlight, true, 'la catena vive anche col terzo gia\' accodato');
      assert.equal(st.classification, 'busy');
      await pausa(PAUSA);
      assert.equal(b.chiamate(), 1, 'il restart non entra prima del rilascio del broker');
      assert.equal(resW.fatto, false);
      b.libera();
      await raccogli([upP, resP]);
    } finally {
      b.libera();
      await raccogli([upP, resP]);
    }
    assert.ok(upW.fatto && resW.fatto);
    assert.ok(upW.a <= resW.a, `FIFO: l\'up drena prima del restart accodato (${upW.a} vs ${resW.a})`);
    assert.equal((await c.runtime.launchState(d.cella)).inFlight, false);
  });

  // Famiglia 4: terzo accodato DOPO il timeout — il caso che oggi entra
  // subito perche' la mappa e' stata svuotata dal POST scaduto.
  test(`P1-01: up successivo al timeout non entra prima del rilascio (${nome})`, async (t) => {
    const d = W.scriviMondo({ famiglia: 'other' });
    t.after(() => W.pulisci(d));
    const b = brokerSospeso();
    const a = W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    const c = stesso ? a : W.apriRuntime(d, { issue: b.issue, cfg: { groupStopBudgetMs: BUDGET } });
    t.after(() => { for (const x of [a, c]) { try { x.runtime.shutdown(); } catch (_) {} } });
    const upP = a.runtime.up(d.cella);
    const upW = insegna(upP);
    await b.arrivato;
    const { launchId } = fotoRecord(d);
    const up2P = { p: null };
    let up2W = null;
    try {
      const r = await c.runtime.reconcile(d.cella, launchId);
      assert.equal(r.outcome, 'busy');
      const st = await c.runtime.launchState(d.cella);
      assert.equal(st.inFlight, true);
      assert.equal(st.classification, 'busy');
      up2P.p = a.runtime.up(d.cella); // terzo DOPO il timeout
      up2W = insegna(up2P.p);
      await pausa(PAUSA);
      assert.equal(b.chiamate(), 1, 'il nuovo up non raggiunge issue mentre il primo e\' sospeso');
      assert.equal(up2W.fatto, false, 'il nuovo up resta in coda, non settles con un 409');
      b.libera();
      await raccogli([upP, up2P.p]);
    } finally {
      b.libera();
      if (up2P.p) await raccogli([upP, up2P.p]);
      else await raccogli([upP]);
    }
    assert.ok(upW.fatto && up2W.fatto);
    assert.ok(upW.a <= up2W.a, `FIFO: il primo up drena prima del secondo (${upW.a} vs ${up2W.a})`);
    assert.equal((await c.runtime.launchState(d.cella)).inFlight, false);
  });
}
