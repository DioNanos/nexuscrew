// Una rilettura differita sola per tupla, quando la risposta di un'azione è
// andata persa. Serve a non lasciare la riga com'era mentre il nodo lavorava
// ancora, e a non trasformare quell'attesa in un polling: si legge UNA volta,
// dopo una finestra breve, e solo per la tupla che l'ha chiesta.
//
// La coalescenza è il punto: due richieste nella stessa finestra riguardano lo
// stesso stato e darebbero la stessa risposta. La seconda non arma un secondo
// timer e non raddoppia la lettura; quando la finestra si chiude, la voce
// sparisce e non si riarma da sé. Un errore della lettura non sfugge: lo riceve
// `onError`, e la chiave resta utilizzabile per una richiesta nuova.

export const RILETTURA_DIFFERITA_MS = 1500;

export function createDeferredReread({ delayMs = RILETTURA_DIFFERITA_MS, onError = null, setTimer, clearTimer } = {}) {
  const arma = typeof setTimer === 'function' ? setTimer : ((fn, ms) => setTimeout(fn, ms));
  const disarma = typeof clearTimer === 'function' ? clearTimer : ((id) => clearTimeout(id));
  const pendenti = new Map();

  const programma = (chiave, esegui) => {
    if (typeof chiave !== 'string' || !chiave || typeof esegui !== 'function') return false;
    if (pendenti.has(chiave)) return false;
    const timer = arma(() => {
      pendenti.delete(chiave);
      // La lettura parte una volta sola: se rigetta, la si riporta e si chiude.
      Promise.resolve().then(esegui).catch((e) => {
        if (typeof onError === 'function') onError(e);
      });
    }, delayMs);
    pendenti.set(chiave, timer);
    return true;
  };

  const annulla = (chiave) => {
    const timer = pendenti.get(chiave);
    if (timer === undefined) return;
    pendenti.delete(chiave);
    disarma(timer);
  };

  const annullaTutto = () => {
    for (const timer of pendenti.values()) disarma(timer);
    pendenti.clear();
  };

  return { programma, annulla, annullaTutto, pendenti: () => [...pendenti.keys()] };
}
