'use strict';
// B4.3 — Service companion boot. bootCells(fleet, {log}) avvia tutte le celle
// boot:true di un fleet provider (builtin) chiamandone up(). Una cella gia' in
// esecuzione (up -> httpError 409 / "duplicate session") = SKIP non fatale;
// ogni altro errore viene raccolto in failed[] e NON ferma le altre celle.
// Nessun side-effect all'import. Design §4c / §9b.
//
// Agnostico: usa solo il contratto fleet {available, status(), up()} — non legge
// internals delle definizioni. La lista delle celle boot:true arriva da status()
// (campo `boot` derivato dalle definitions), cosi' un fleet esterno compatibile
// potra' riusare la stessa funzione.

const SKIP_STATUS = 409; // up() del builtin lancia httpError(409) su sessione duplicata

async function bootCells(fleet, { log = () => {} } = {}) {
  const started = [];
  const skipped = [];
  const failed = [];

  if (!fleet || fleet.available === false) {
    // provider non disponibile: niente da avviare. Il caller (runFleetBoot)
    // filtra gia' mode==='builtin' (= fleet.available); qui e' solo defense-in-depth.
    return { started, skipped, failed };
  }

  let cells = [];
  try {
    const st = await fleet.status();
    cells = (st && Array.isArray(st.cells)) ? st.cells : [];
  } catch (e) {
    // status e' una lettura: se fallisce non possiamo sapere cosa avviare.
    // Riportiamo come fallimento globale senza processare alcuna cella.
    failed.push({ cell: '*', reason: `status() failed: ${e && e.message ? e.message : e}` });
    return { started, skipped, failed };
  }

  for (const c of cells) {
    if (!c || !c.boot) continue;            // solo boot:true
    const id = c.cell;
    try {
      await fleet.up(id);
      started.push(id);
      log(`fleet-boot: started ${id}`);
    } catch (e) {
      const status = e && typeof e.status === 'number' ? e.status : null;
      const reason = (e && e.message) ? e.message : String(e);
      // gia' in esecuzione: skip non fatale (contratto builtin: 409/duplicate).
      // Il regex copre anche fleet esterni che lanciano un Error generico.
      if (status === SKIP_STATUS || /duplicate session|già in esecuzione/i.test(reason)) {
        skipped.push(id);
        log(`fleet-boot: skipped ${id} (already running)`);
      } else {
        failed.push({ cell: id, reason });
        log(`fleet-boot: failed ${id} — ${reason}`);
      }
    }
  }

  return { started, skipped, failed };
}

module.exports = { bootCells };
