// Decide se una lettura differita va ancora eseguita quando la sua finestra si
// chiude. Non è una formalità: fra la richiesta e la scadenza la vista può
// essere chiusa, la credenziale può cambiare, l'owner della route può essere un
// altro, e la cella può aver già ricevuto una ragione terminale — che è la
// risposta autorevole e rende la lettura inutile.
//
// Funzione pura, così i casi si provano uno per uno senza pilotare la UI.

// atteso:    { token, owner }  congelati quando la lettura è stata chiesta
// contesto:  { token, owner }  letti al momento della scadenza
// snapshot:  lo snapshot del treno, nella forma che il produttore emette:
//            { at, sessionsJson, sessionsError, fs, fleetError } — le celle
//            stanno in `fs.cells`, perché `fs` è il risultato di fleetStatus.
// cell:      id della cella di cui si parla
export function puoRileggere({ atteso, contesto, snapshot, cell }) {
  if (!atteso || !contesto) return false;
  if (atteso.token !== contesto.token) return false;
  if ((atteso.owner || null) !== (contesto.owner || null)) return false;
  const celle = snapshot && snapshot.fs && Array.isArray(snapshot.fs.cells) ? snapshot.fs.cells : null;
  // Snapshot assente o senza elenco: non si sa nulla, quindi la lettura serve
  // ancora. È lo stato della cella a toglierle senso, non la sua assenza.
  const statoCella = celle ? celle.find((c) => c && c.cell === cell) : null;
  if (statoCella && statoCella.terminal) return false;
  return true;
}
