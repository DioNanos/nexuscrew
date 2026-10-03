// Prefissi da CTRL/ALT armati sul primo carattere dell'input
// dalla tastiera del telefono. La conversione di controllo è quella che stava
// inline in `Terminal.jsx` (a-z → ^A..^Z, @A-Z[\]^_ → ^@..^_, spazio → ^@).
// Con ALT il carattere (di controllo o no) viene preceduto da ESC (Meta).
// L'eventuale resto della stringa (IME, parole intere) esce senza prefisso:
// il modificatore vale solo per il primo carattere (comportamento scelto e
// (richiesta dell'operatore).

export function inputConPrefissi(d, { ctrl = false, alt = false } = {}) {
  if (!d || (!ctrl && !alt)) return d;
  const prima = d.charCodeAt(0);
  let code = prima;
  if (ctrl) {
    if (prima >= 97 && prima <= 122) code = prima - 96;   // a-z -> ^A..^Z
    else if (prima >= 64 && prima <= 95) code = prima - 64; // @A-Z[\]^_ -> ^@..^_
    else if (prima === 32) code = 0;                      // space -> ^@
  }
  return (alt ? '\x1b' : '') + String.fromCharCode(code) + d.slice(1);
}
