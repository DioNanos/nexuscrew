// Il campo dell'attesa di prontezza si scrive in secondi, il contratto del
// server parla in millisecondi interi. Qui c'e' l'unica conversione fra i due:
// nessun arrotondamento, nessuna coercizione, nessuna lettura "alla buona" del
// numero. Virgola e punto valgono entrambi come separatore decimale, e sono
// l'unico separatore ammesso: due separatori sono la forma delle migliaia e si
// rifiutano, non si interpretano.
//
// parseSecondi(testo) -> { ok: true, ms } | { ok: false, motivo }
//   motivi: 'vuoto' | 'testo' | 'separatori' | 'precisione' | 'range'
// secondiDaMs(ms, sep) -> testo rileggibile dal parser senza perdere un ms.

export const MIN_SECONDS = 1;
export const MAX_SECONDS = 120;
const MAX_DECIMALS = 3;

const FORMA_AMMESSA = /^(\d+)(?:([.,])(\d+))?$/;

export function parseSecondi(testo) {
  if (typeof testo !== 'string') return { ok: false, motivo: 'testo' };
  const s = testo.trim();
  if (!s) return { ok: false, motivo: 'vuoto' };

  const quantiSeparatori = (s.match(/[.,]/g) || []).length;
  if (quantiSeparatori > 1) return { ok: false, motivo: 'separatori' };

  const m = FORMA_AMMESSA.exec(s);
  if (!m) return { ok: false, motivo: 'testo' };
  const interi = m[1];
  const decimali = m[3];
  if (decimali !== undefined && decimali.length > MAX_DECIMALS) {
    return { ok: false, motivo: 'precisione' };
  }

  // Aritmetica intera: con al massimo tre decimali il millisecondo e' esatto e
  // non c'e' nessun float da arrotondare.
  const ms = Number(interi) * 1000 + (decimali ? Number(decimali.padEnd(MAX_DECIMALS, '0')) : 0);
  if (!Number.isSafeInteger(ms) || ms < MIN_SECONDS * 1000 || ms > MAX_SECONDS * 1000) {
    return { ok: false, motivo: 'range' };
  }
  return { ok: true, ms };
}

// Gli zeri finali della parte decimale si tolgono solo per leggibilita': il
// valore resta lo stesso, e il parser lo rilegge identico (l'ultima cifra
// significativa e' comunque entro il millisecondo).
export function secondiDaMs(ms, sep = ',') {
  const interi = Math.floor(ms / 1000);
  const resto = ms - interi * 1000;
  if (resto === 0) return String(interi);
  const decimali = String(resto).padStart(MAX_DECIMALS, '0').replace(/0+$/, '');
  return `${interi}${sep}${decimali}`;
}
