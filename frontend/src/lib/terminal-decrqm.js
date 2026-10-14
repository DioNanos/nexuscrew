// Scudo DECRQM per @xterm/xterm 6.0.0 — il terminale nero delle celle
// ospitate dai telefoni (14/10/2026).
//
// COSA È ROTTO, con le misure. Il sorgente pubblicato di requestMode (il
// gestore di DECRQM, `CSI ? Ps $ p` / `CSI Ps $ p`) contiene l'emulazione di
// un const enum TypeScript: `let r;(P=>…)(r||={})` — legale. La pipeline di
// build di questo repo la riscrive in `(void 0||(n={}))`: un assegnamento a
// un identificatore che nessuno dichiara. Il bundle è un modulo ES (strict
// mode), quindi la PRIMA DECRQM scritta nel terminale lancia
// `ReferenceError: n is not defined` dentro requestMode, e l'eccezione
// attraversa WriteBuffer._innerWrite: il buffer non si svuota più, ogni
// write successivo resta in coda e il terminale non disegna più. Per questo
// le celle dei telefoni sono nere nel browser mentre i probe CLI passano: il
// canale WS è sano, muore il parser del client.
//
// Nessuna versione pubblicata corregge il pattern (latest 6.0.0; la beta
// 6.1.0-beta.315 ha lo stesso `(r||={})` nel pacchetto, verificato leggendo
// il codice): lo scudo intercetta la sequenza PRIMA del gestore difettoso e
// risponde lui. Il parser esegue i gestori registrati DAL LAST all'first
// (EscapeSequenceParser, dispatch CSI: iterazione da length-1 a 0, e `true`
// ferma il loop): un gestore registrato dopo la costruzione del terminale
// precede sempre il builtin.
//
// COSA RISPONDE. DECRPM con Pm=0 («modo non riconosciuto»): è la risposta
// onesta di un terminale che non vuole dichiarare uno stato che non può
// ricavare in modo affidabile, e le applicazioni devono gestirla. Rispondere
// via `sendInput` — lo stesso canale dei tasti — è la via che il requestMode
// di xterm stesso userebbe (triggerDataEvent): la risposta deve raggiungere
// l'applicazione DENTRO il PTY, non il buffer video.

// Registra i due gestori DECRQM (privato con `?` e ANSI). `sendInput`
// riceve la risposta DECRPM; può mancare (terminale in sola lettura: la
// sequenza si ingoia comunque, la risposta no, come ogni input) ed può
// lanciare (canale chiuso): in quel caso la risposta si perde ma il
// terminale vive. Restituisce true SEMPRE: la sequenza è gestita e il
// gestore difettoso non deve mai correre — è la correzione, non un'opzione.
export function shieldDecrqm(term, sendInput) {
  if (!term || typeof term.parser?.registerCsiHandler !== 'function') return;
  const reply = (privateMark) => (params) => {
    const first = params && params[0];
    const code = Array.isArray(first) ? first[0] : first;
    const mode = Number.isFinite(code) && code > 0 ? code : 0;
    if (typeof sendInput === 'function') {
      try { sendInput(`\x1b[${privateMark}${mode};0$y`); } catch (_) { /* canale chiuso: risposta persa, terminale vivo */ }
    }
    return true;
  };
  term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, reply('?'));
  term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, reply(''));
}

// Il write del canale non deve MAI far risalire un'eccezione del parser fino
// a onmessage: lì un throw non uccide solo il frame corrente, lascerebbe il
// canale vivo con un terminale morto — l'utente vede nero senza nemmeno un
// errore in console. L'errore si logga, non si nasconde: chi legge la console
// sa CHE cosa è stato scartato e perché il buffer ha un buco.
export function safeTermWrite(term, text) {
  try {
    term.write(text);
    return true;
  } catch (e) {
    console.error('[terminal] output scartato: eccezione del parser', e);
    return false;
  }
}
