// Lettura tollerante delle preferenze: un valore assente da' il default in silenzio; un valore PRESENTE ma non
// leggibile (JSON troncato, struttura sbagliata) da' il default in memoria ma il grezzo viene CONSERVATO in
// <chiave>__corrupt e annotato nel diario. Prima il default veniva riscritto sopra alla prima azione e il valore
// dell'utente andava perso senza traccia.
import { preserveCorrupt } from './order-journal.js';
export { CORRUPT_SUFFIX } from './order-journal.js';

// parse(json) ritorna il valore valido oppure undefined se la struttura non va bene.
export function readPref(key, { parse, fallback, storage } = {}) {
  let s = storage; try { s = s || globalThis.localStorage; } catch (_) { return fallback(); }
  let raw = null;
  try { raw = s.getItem(key); } catch (_) { return fallback(); }
  if (raw === null || raw === undefined) return fallback();
  try {
    const value = parse(JSON.parse(raw));
    if (value !== undefined) return value;
  } catch (_) { /* non leggibile: sotto */ }
  preserveCorrupt(key, raw, s);
  return fallback();
}

// Scrittura che non distrugge un grezzo illeggibile: se sotto la chiave c'e' un valore che non si parsa,
// lo copia in <chiave>__corrupt PRIMA di scrivere. Ritorna null se ok, l'errore altrimenti (mai ingoiato).
export function writePref(key, value, { storage } = {}) {
  let s = storage; try { s = s || globalThis.localStorage; } catch (e) { return e; }
  try {
    const existing = s.getItem(key);
    if (existing !== null && existing !== undefined) {
      try { JSON.parse(existing); } catch (_) { preserveCorrupt(key, existing, s); }
    }
    s.setItem(key, JSON.stringify(value));
    return null;
  } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
}
