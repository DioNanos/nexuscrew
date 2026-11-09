'use strict';
// Fleet boot companion: avvia le celle boot:true come CLIENT del daemon
// persistente della stessa installazione:
// per ogni cella il NORMALE POST /api/fleet/up con il SOLO target — mai
// engine/boot/model, che nell'API sono atti di configurazione persistenti.
// Il daemon resta l'unico proprietario di broker, controllo, lease e record.
//
// La decisione sugli esiti è SOLO su campi strutturati: il code (enum chiuso
// di lib/fleet/causes.js) nel body dell'errore HTTP, la classification di
// launch-state e la lease per cella dello status. MAI una regex sul messaggio
// libero: un 409 qualunque non prova nulla.
//
// Contratto fleet (adattatore del daemon o mock di test):
//   { available, status(), up(id), launchState?(id) }
// launchState è opzionale: senza di essa nessuno skip è provabile e un
// SESSION_DUPLICATE resta un fallimento dichiarato.

// Esiti chiusi del companion (non i code del daemon): ogni voce di
// skipped/failed/unconfirmed porta {cell, code}.
const ESITI = Object.freeze({
  GIA_AVVIATA: 'ALREADY_RUNNING',     // skip QUALIFICATO: dup con prova corrente
  DUP_SENZA_PROVA: 'SESSION_DUPLICATE', // omonima/rifiuto dup senza prova: fallimento
  PERSA: 'LOST',                      // risposta persa non attestabile: incerto
  SCONOSCIUTO: 'UNKNOWN',             // errore senza code strutturato
  STATUS_FALLITO: 'STATUS_FAILED',
});

// Consultazione dello stato dopo una risposta persa: il POST consegnato può
// avere un lancio ANCORA in corso (launch-state inFlight) e il verdetto non è
// maturato. La consultazione è BOUNDED — budget e tick fissi, iniettabili per
// i test — ed è sempre una lettura: mai un secondo POST. Un verdetto arrivato
// ma non attestabile, con lancio NON in corso, è DEFINITIVO: si decide subito.
const LOST_STATE_BUDGET_MS = 30_000;
const LOST_STATE_TICK_MS = 1_000;

// La prova corrente che «è già in esecuzione il lancio qualificato atteso»:
// per QUELLA cella servono TUTTI e quattro i fatti strutturati:
//   - launch-state classification 'live': il canale tmux di controllo
//     posseduto dal daemon per la sessione della cella è vivo
//     (lib/fleet/launch-reconcile.js, valutaLancio: canaleVivo());
//   - launchId + phase 'attested': il record del lancio è presente e in fase
//     attested — phase esiste solo nello schema a fasi v2 (lib/fleet/launch-target.js);
//   - control armato, connesso e legato allo STESSO launchId: il protocollo
//     di stop del supervisore è realmente armato nel manager per questo
//     lancio (runtime.launchState: blocco control da leaseManager) — un
//     canale tmux vivo da solo non è un'autorità sostituibile;
//   - lease 'live' per quella cella nello status RILETTO ora: il supervisore
//     di quel lancio sta rinnovando ORA la lease (runtime.js, leaseManager.status).
// Nessuno dei quattro da solo basta, e lo status non è mai una fotografia.
async function attestaGiaInCorso(fleet, id, {
  budgetMs = LOST_STATE_BUDGET_MS, tickMs = LOST_STATE_TICK_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
} = {}) {
  if (typeof fleet.launchState !== 'function') return false;
  const fine = now() + budgetMs;
  for (;;) {
    let ls = null;
    try { ls = await fleet.launchState(id); } catch (_) { return false; }
    if (ls && ls.classification === 'live'
      && typeof ls.launchId === 'string' && ls.launchId
      && ls.phase === 'attested'
      && ls.control && ls.control.armed === true
      && ls.control.connected === true
      && ls.control.launchId === ls.launchId) {
      try {
        const st = await fleet.status();
        const cella = st && Array.isArray(st.cells) ? st.cells.find((c) => c && c.cell === id) : null;
        return !!(cella && cella.lease === 'live');
      } catch (_) { return false; }
    }
    // Nessun verdetto maturato: si riprova SOLO se il lancio è dichiarato
    // ancora in corso, entro il budget. Ogni altro esito è definitivo.
    if (!ls || ls.inFlight !== true) return false;
    if (now() >= fine) return false;
    await sleep(tickMs);
  }
}

async function bootCells(fleet, opts = {}) {
  const log = opts.log || (() => {});
  const started = [];
  const skipped = [];
  const failed = [];
  const unconfirmed = [];

  if (!fleet || fleet.available === false) {
    // provider non disponibile: niente da avviare (il caller filtra già
    // l'esito disabled; qui è solo defense-in-depth).
    return { started, skipped, failed, unconfirmed };
  }

  let cells = [];
  try {
    const st = await fleet.status();
    cells = (st && Array.isArray(st.cells)) ? st.cells : [];
  } catch (e) {
    // status è una lettura: senza di essa non sappiamo cosa avviare.
    failed.push({ cell: '*', code: ESITI.STATUS_FALLITO });
    return { started, skipped, failed, unconfirmed };
  }

  for (const c of cells) {
    if (!c || !c.boot) continue;            // solo boot:true
    const id = c.cell;
    try {
      await fleet.up(id);
      started.push(id);
      log(`fleet-boot: started ${id}`);
    } catch (e) {
      // Risposta PERSA (rete/abort dopo la consegna): non si ripete il POST
      // alla cieca. Si consulta lo stato/prova dello stesso tentativo; se non
      // è attestabile, launch-unconfirmed dichiarato.
      if (e && e.lost === true) {
        if (await attestaGiaInCorso(fleet, id, opts.lostState)) {
          skipped.push({ cell: id, code: ESITI.GIA_AVVIATA });
          log(`fleet-boot: skipped ${id} (already running, confirmed after a lost response)`);
        } else {
          unconfirmed.push({ cell: id, code: ESITI.PERSA });
          log(`fleet-boot: unconfirmed ${id} — launch state not attestable after a lost response`);
        }
        continue;
      }
      const status = e && typeof e.status === 'number' ? e.status : null;
      if (status === null) {
        // Non è un verdetto HTTP del daemon: guasto locale della richiesta.
        failed.push({ cell: id, code: ESITI.SCONOSCIUTO });
        log(`fleet-boot: failed ${id} — ${e && e.message ? e.message : e}`);
        continue;
      }
      const code = e && typeof e.fleetCode === 'string' && e.fleetCode ? e.fleetCode : null;
      if (code === 'SESSION_DUPLICATE') {
        // Già in esecuzione è uno skip SOLO con la prova corrente; senza
        // prova (omonima senza record, lease persa, launch-state muto) è un
        // fallimento dichiarato, mai «avviata con successo». Il rifiuto è
        // già un verdetto: consultazione UNICA, nessuna attesa.
        if (await attestaGiaInCorso(fleet, id, { budgetMs: 0 })) {
          skipped.push({ cell: id, code: ESITI.GIA_AVVIATA });
          log(`fleet-boot: skipped ${id} (already running, attested)`);
        } else {
          failed.push({ cell: id, code: ESITI.DUP_SENZA_PROVA });
          log(`fleet-boot: failed ${id} — duplicate session without a current proof`);
        }
        continue;
      }
      failed.push({ cell: id, code: code || ESITI.SCONOSCIUTO });
      log(`fleet-boot: failed ${id} — ${code || 'unstructured error'}`);
    }
  }

  return { started, skipped, failed, unconfirmed };
}

module.exports = { bootCells, ESITI, LOST_STATE_BUDGET_MS, LOST_STATE_TICK_MS };
