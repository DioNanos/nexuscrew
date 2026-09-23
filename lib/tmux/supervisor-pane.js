'use strict';
// Chi e' il pane del SUPERVISORE di una cella, e se e' ancora vivo.
//
// PERCHE' NON BASTA `#{pane_dead}` DI list-sessions (misurato con tmux vero):
// quel campo riguarda il pane ATTIVO della sessione. Con una seconda finestra
// viva selezionata dice «vivo» anche quando il pane del supervisore e' morto, e
// allora lo `Stop` con `exit:1` scritto prima resta «ferma» per sempre — mentre
// la garanzia di quel segno e' che il supervisore DICHIARA l'uscita, e un
// supervisore ucciso non l'ha dichiarata.
//
// La verita' e' il pane che esegue `cell-exec`: la runtime lo marca al lancio
// con un'opzione di pane (`@nc_supervisor`), e il server lo cerca qui.
//
// UNA SOLA CHIAMATA PER GIRO: `list-panes -a -F <PANES_FMT>`, poi tutto si
// calcola in memoria. Nessuna chiamata tmux per singola sessione.
const NC_SUPERVISOR_OPT = '@nc_supervisor';
const PANES_FMT = `#{session_name}\t#{pane_id}\t#{pane_dead}\t#{${NC_SUPERVISOR_OPT}}`;

function parsePanes(raw) {
  return String(raw)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const campi = line.split('\t');
      return {
        session: campi[0] || '',
        paneId: campi[1] || '',
        dead: campi[2] === '1',
        marked: campi[3] === '1',
      };
    });
}

/**
 * Lo stato del supervisore di ogni sessione, dalle sole righe di list-panes:
 *   'vivo'    — il pane marcato c'e' ed e' vivo;
 *   'morto'   — il pane marcato c'e' ed e' morto (SIGKILL/OOM del supervisore,
 *               e la sessione e' sopravvissuta per `remain-on-exit`);
 *   'assente' — nessun pane marcato: la cella e' stata lanciata PRIMA che il
 *               marcatore esistesse, oppure la marcatura non e' riuscita.
 */
function statiSupervisore(raw) {
  const perSessione = new Map();
  for (const pane of parsePanes(raw)) {
    if (!pane.session) continue;
    const stato = perSessione.get(pane.session) || { marcato: null };
    // Un solo pane marcato per lancio: se ne comparissero due, l'ultimo vince.
    if (pane.marked) stato.marcato = pane;
    perSessione.set(pane.session, stato);
  }
  const out = new Map();
  for (const [nome, stato] of perSessione) {
    if (!stato.marcato) out.set(nome, 'assente');
    else out.set(nome, stato.marcato.dead ? 'morto' : 'vivo');
  }
  return out;
}

/**
 * La decisione: di questa cella non si puo' leggere lo stato?
 *
 * 'morto' → si': il supervisore non c'e' piu' e nessuno dichiarera' l'uscita.
 *
 * 'assente' → dipende dal FILE DI GENERAZIONE, e la differenza e' la ragione
 * della regola: un lancio NUOVO in cui la marcatura del pane e' fallita ha il
 * segno `exit:1`, quindi il suo `Stop` non scadrebbe mai e nessuno garantisce
 * il supervisore → non si legge. Un lancio VECCHIO (file di una riga, senza
 * segno) non ha nessuna non-scadenza da proteggere: vale il lettore, che fa
 * scadere `Stop` e gli eventi di lavoro a cinque minuti. Il caso peggiore e'
 * limitato a quei cinque minuti, invece di diventare «non verificato» per ogni
 * cella viva su ogni nodo appena aggiornato.
 *
 * 'vivo' → no.
 */
function senzaSupervisore(stato, uscitaGarantita) {
  if (stato === 'morto') return true;
  if (stato === 'assente') return uscitaGarantita === true;
  return false;
}

module.exports = { NC_SUPERVISOR_OPT, PANES_FMT, parsePanes, statiSupervisore, senzaSupervisore };
