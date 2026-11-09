// Le righe della conversazione di un nodo VL, costruite dagli eventi del ring.
//
// Il ring consegna FRAMMENTI: ogni delta di testo è un evento. Disegnarne uno
// per riga spezza le parole a metà («ACT» / «IVE_WORK.md») e fa sembrare rotto
// il testo che il device ha mandato intero. Qui i frammenti contigui diventano
// UNA riga; un evento strutturale (tool, gap, turn_end, errore) chiude il
// blocco e resta una riga sua.
//
// Funzione pura: gli eventi entrano, le righe escono. Nessun testo inventato,
// nessuna deduplicazione del messaggio finale — il ring non ha un messageId
// con cui riconoscere i frammenti di uno stesso messaggio, e fingersi di
// averlo sarebbe una promessa che non possiamo mantenere.

const FRAMMENTI = new Set(['text', 'thinking']);

function frammento(evento) {
  return evento && FRAMMENTI.has(evento.kind) && typeof evento.text === 'string';
}

// raggruppaEventi(eventi) -> [{ type:'text'|'thinking', seq, seqFine, testo } | { type:'event', event }]
export function raggruppaEventi(eventi) {
  const righe = [];
  let aperto = null;
  for (const evento of Array.isArray(eventi) ? eventi : []) {
    if (!evento || typeof evento !== 'object') continue;
    if (frammento(evento)) {
      if (aperto && aperto.type === evento.kind) {
        aperto.testo += evento.text;
        aperto.seqFine = evento.seq;
      } else {
        aperto = { type: evento.kind, seq: evento.seq, seqFine: evento.seq, testo: evento.text, kind: evento.kind };
        righe.push(aperto);
      }
      continue;
    }
    aperto = null;
    righe.push({ type: 'event', event: evento });
  }
  return righe;
}
