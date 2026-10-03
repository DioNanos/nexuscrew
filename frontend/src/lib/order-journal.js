// Diario delle scritture di pin, ordine e viste: ring buffer in localStorage, per capire DOPO una perdita
// sul campo che cosa e' successo (chi ha scritto, quando, con quali chiavi visibili). Contiene solo nomi di
// celle/nodi e orari: mai token. Ogni voce e' limitata in dimensione; il diario stesso e' best-effort.
export const ORDER_JOURNAL_KEY = 'nc_order_journal_v1';
export const ORDER_JOURNAL_MAX = 50;
// Copia grezza di un valore che non si riesce a leggere: si conserva, non si sovrascrive.
export const CORRUPT_SUFFIX = '__corrupt';

const MAX_LIST = 200; const MAX_STR = 200;
const FIELDS = ['reason', 'key', 'position', 'source', 'target', 'note'];
const LISTS = ['before', 'after', 'visible'];
const cut = (s) => String(s).slice(0, MAX_STR);
const list = (a) => (Array.isArray(a) ? a.slice(0, MAX_LIST).map(cut) : undefined);
const store = (s) => { try { return s || globalThis.localStorage; } catch (_) { return null; } };

function clean(entry) {
  const out = { t: Date.now() };
  for (const f of FIELDS) if (entry[f] !== undefined && entry[f] !== null) out[f] = cut(entry[f]);
  for (const f of LISTS) { const v = list(entry[f]); if (v) out[f] = v; }
  return out;
}

// Copia il grezzo in <chiave>__corrupt (una volta per valore) e lo dice nel diario. Ritorna true se ha copiato.
export function preserveCorrupt(key, raw, storage) {
  const s = store(storage); if (!s || raw === null || raw === undefined) return false;
  try {
    if (s.getItem(key + CORRUPT_SUFFIX) === raw) return false;
    s.setItem(key + CORRUPT_SUFFIX, raw);
  } catch (_) { return false; }
  if (key !== ORDER_JOURNAL_KEY) appendOrderJournal({ reason: 'corrupt-preserved', key, note: `${String(raw).length} caratteri conservati in ${key}${CORRUPT_SUFFIX}` }, s);
  return true;
}

export function readOrderJournal(storage) {
  const s = store(storage); if (!s) return [];
  let raw = null;
  try { raw = s.getItem(ORDER_JOURNAL_KEY); } catch (_) { return []; }
  if (raw === null) return [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch (_) { /* corrotto: sotto */ }
  preserveCorrupt(ORDER_JOURNAL_KEY, raw, s);
  return [];
}

export function appendOrderJournal(entry, storage) {
  const s = store(storage); if (!s || !entry) return;
  try {
    const next = [...readOrderJournal(s), clean(entry)].slice(-ORDER_JOURNAL_MAX);
    s.setItem(ORDER_JOURNAL_KEY, JSON.stringify(next));
  } catch (_) { /* diagnostica best-effort: non deve mai rompere una scrittura utente */ }
}

export function clearOrderJournal(storage) {
  const s = store(storage); if (!s) return;
  try { s.removeItem(ORDER_JOURNAL_KEY); } catch (_) { /* nulla */ }
}
