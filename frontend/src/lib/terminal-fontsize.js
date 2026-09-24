// Lo zoom del terminale è UNO, ed è una chiave di storage: nc_fontsize. Chi
// lo muove — la barra della vista singola o l'anteprima del selettore — passa
// di qui, così il valore resta uno solo e con lo stesso confine. La vista
// principale rilegge la chiave quando il selettore si chiude: due superfici,
// un numero.

const FONT_KEY = 'nc_fontsize';

export const FONT_MIN = 9;
export const FONT_MAX = 24;

export function readFontSize(storage = globalThis.localStorage) {
  const v = Number(storage.getItem(FONT_KEY));
  return v >= FONT_MIN && v <= FONT_MAX ? v : 13;
}

// Clampa e persiste in un passo: ritorna il valore che adesso c'e' scritto.
export function writeFontSize(next, storage = globalThis.localStorage) {
  const v = Math.max(FONT_MIN, Math.min(FONT_MAX, next));
  storage.setItem(FONT_KEY, String(v));
  return v;
}
