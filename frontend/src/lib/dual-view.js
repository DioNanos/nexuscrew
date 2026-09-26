// lib/dual-view.js — modello della doppia vista nella singola mobile.
// La seconda cella è uno stato del DISPOSITIVO (localStorage), non del deck:
// il deck è una superficie desktop e il desktop non si tocca.
// Qui sta solo la parte calcolabile — niente React — così il vincolo di
// isolamento dell'input («una cella non scrive mai nell'altra») si testa a unità.

const STORAGE_KEY = 'nc_dual_side';

export function isSameRef(a, b) {
  if (!a || !b) return false;
  return a.session === b.session && (a.node || '') === (b.node || '');
}

// Tocco sulla riga `row` mentre si guarda `main` con `side` già affiancata:
// la cella aperta NON si affianca a se stessa (no-op), un secondo tocco sulla
// riga già affiancata la toglie. Restituisce il nuovo ref side (o null).
export function toggleSideRef(main, side, row) {
  if (!row || !row.session) return side;
  if (main && isSameRef(main, row)) return side;
  if (side && isSameRef(side, row)) return null;
  return {
    session: row.session,
    ...(row.node ? { node: row.node } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
  };
}

// Ricordo per-coppia {main, side}: alla riapertura della stessa cella la
// seconda torna, se esiste ancora (la validità la verifica la vista col suo
// ciclo di letture; qui si salvano solo ref puliti, mai campi display).
export function readSavedDual() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || !parsed.main || !parsed.side) return null;
    if (!parsed.main.session || !parsed.side.session) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function writeSavedDual(main, side) {
  try {
    if (!main || !side || !main.session || !side.session) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const pulisci = (ref) => ({
      session: ref.session,
      ...(ref.node ? { node: ref.node } : {}),
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ main: pulisci(main), side: pulisci(side) }));
  } catch (_) {
    // storage pieno o bloccato: la doppia resta effimera, nessun errore a UI.
  }
}

export function clearSavedDual() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* già assente */ }
}

// Pesi dei due pannelli per la maniglia: stesso minimo delle colonne della
// griglia desktop (0.2): nessun pannello collassa per drag.
export const DUAL_MIN_W = 0.2;

export function clampWeight(w) {
  return Math.max(DUAL_MIN_W, w);
}
