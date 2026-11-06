// Decide se una lettura differita va ancora eseguita quando la sua finestra si
// chiude. Non è una formalità: fra la richiesta e la scadenza la vista può
// essere chiusa, la credenziale può cambiare, l'owner della route può essere un
// altro, e la cella può aver già ricevuto una ragione terminale — che è la
// risposta autorevole e rende la lettura inutile.
//
// Funzione pura, così i casi si provano uno per uno senza pilotare la UI.

// atteso:    { token, owner }  letti quando la lettura è stata chiesta
// contesto:  { token, owner }  letti al momento della scadenza
// snapshot:  ultimo stato noto della route (può essere null)
// cell:      id della cella di cui si parla
export function puoRileggere({ atteso, contesto, snapshot, cell }) {
  if (!atteso || !contesto) return false;
  if (atteso.token !== contesto.token) return false;
  if ((atteso.owner || null) !== (contesto.owner || null)) return false;
  const statoCella = snapshot && Array.isArray(snapshot.cells)
    ? snapshot.cells.find((c) => c && c.cell === cell) : null;
  if (statoCella && statoCella.terminal) return false;
  return true;
}
