'use strict';
// Attestazione del TRASPORTO del pane per il submit opt-in.
//
// Perche' esiste questo modulo. `tmux paste-buffer -p` inserisce i codici di
// bracketed paste SOLO se il processo nel pane li ha richiesti (tmux(1)); se
// non li ha richiesti il testo arriva GREZZO e ogni LF del prompt diventa un
// Invio. Misurato: con la modalita' 2004 spenta i byte ricevuti sono
// `alpha CR beta CR` (nessun delimitatore, due possibili submit), con la
// modalita' accesa `ESC[200~ alpha CR beta ESC[201~ CR`. E' la violazione
// concreta di F4, e non e' evitabile guardando l'argv: il degrado avviene
// dentro tmux.
//
// Cosa NON e' un'attestazione: il valore `submit: 'enter'` della definizione
// (e' l'intenzione dell'operatore, non la capacita' attuale del client), una
// casella nella UI, un nome di binario, un'attesa fissa, un pane vivo, la sola
// versione di tmux. tmux 3.4 non espone la modalita' del pane in nessun
// formato (`display-message -a`: 120 variabili, nessuna pertinente), e un
// adapter sul socket di VL e' un canale separato, da progettare e verificare:
// non e' autorizzato come scorciatoia di questo lotto.
//
// Percio' oggi NESSUNA fonte fornisce un'attestazione: la funzione risponde
// `attested: false` e il percorso paste+Enter resta irraggiungibile dal
// prodotto (che dichiara `transport-unsupported` prima di qualunque effetto).
// Il codice del percorso resta coperto dai test con un'attestazione finta.
//
// Punto di innesto del futuro attestatore: una funzione che, dato il contesto
// bounded del pane (sessione, %N, generazione, pid), risponda `{attested:true}`
// SOLO con una prova vera e legata a quel processo/pane/generazione. Finche'
// non esiste, questa resta l'unica implementazione.

// Provider registrabile. In produzione nessuno lo registra: la sola via per
// accenderlo e' un test (o il futuro adapter, che andra' verificato).
let provider = null;

// Solo per test e per il futuro adapter. Non e' un'opzione di configurazione:
// non c'e' modo di raggiungerla da una definizione, da una route o da un env.
function setBracketedPasteAttestor(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

// attestBracketedPaste(ctx) -> { attested, reason } con reason costante.
// Non lancia mai: un provider rotto vale "non attestato" (fail-closed).
function attestBracketedPaste(ctx = {}) {
  if (!provider) return { attested: false, reason: 'no-runtime-attestation' };
  try {
    const result = provider(ctx);
    if (result === true) return { attested: true, reason: 'attested' };
    if (result && result.attested === true) return { attested: true, reason: 'attested' };
    return { attested: false, reason: 'not-attested' };
  } catch (_) {
    return { attested: false, reason: 'attestation-failed' };
  }
}

module.exports = { attestBracketedPaste, setBracketedPasteAttestor };
