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
 * Le sessioni il cui SUPERVISORE non c'e' piu' — o non e' identificabile.
 *
 * Due casi, e sono diversi:
 *  - il pane marcato c'e' ed e' morto: il supervisore e' stato ucciso (SIGKILL,
 *    OOM) e la sessione e' sopravvissuta per `remain-on-exit`;
 *  - nessun pane marcato: la cella e' stata lanciata PRIMA che il marcatore
 *    esistesse (o la marcatura non e' riuscita). Non si puo' dire quale dei suoi
 *    pani sia il supervisore, quindi non si afferma niente sul suo stato: la
 *    sessione entra qui, e lo stato che mostra e' «non verificato».
 */
function sessioniSenzaSupervisore(raw) {
  const perSessione = new Map();
  for (const pane of parsePanes(raw)) {
    if (!pane.session) continue;
    const stato = perSessione.get(pane.session) || { marcato: null };
    // Un solo pane marcato per lancio: se ne comparissero due, l'ultimo vince.
    if (pane.marked) stato.marcato = pane;
    perSessione.set(pane.session, stato);
  }
  const morte = new Set();
  for (const [nome, stato] of perSessione) {
    if (!stato.marcato || stato.marcato.dead) morte.add(nome);
  }
  return morte;
}

module.exports = { NC_SUPERVISOR_OPT, PANES_FMT, parsePanes, sessioniSenzaSupervisore };
