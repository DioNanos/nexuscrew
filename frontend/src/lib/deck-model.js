// Modello puro dei "deck" (workspace nominati multi-finestra, §5b). Nessun React.
// Un deck = un layout griglia nominato, indirizzabile via /deck/<name>, persistito
// client-side (localStorage per-browser). 'main' e' il deck di default e resta sulla
// chiave storica del layout (nc_grid_v1) per non perdere i layout esistenti.
// Guard localStorage/window per importabilita' in node (test).

import { deckId, parseDeckId, NODE_ID_RE } from './deck-federation.js';

export const DECK_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const MAIN_DECK = 'main';
export const DECKS_KEY = 'nc_decks';
const MAX_DECKS = 24;

// Accetta un nome umano nel form e lo converte nell'id URL-safe usato dal
// backend. La trasformazione e' visibile nel form: niente pulsanti disabilitati
// senza spiegazione per input comuni come "Work Deck".
export function normalizeDeckName(n) {
  if (typeof n !== 'string') return '';
  return n.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

export function isValidDeckName(n) {
  return typeof n === 'string' && DECK_NAME_RE.test(n);
}

// Nome deck dal pathname: /deck/<name> → nome valido, altrimenti 'main'.
export function deckFromPath(pathname) {
  const m = String(pathname || '').match(/^\/deck\/([^/]+)\/?$/);
  if (m) {
    let n;
    try { n = decodeURIComponent(m[1]); } catch (_) { n = m[1]; }
    return isValidDeckName(n) ? n : MAIN_DECK;
  }
  return MAIN_DECK;
}

// Nuovo indirizzamento owner-aware. Il path remoto usa il nodeId stabile, non
// una route mutabile: /deck/<ownerNodeId>/<name>. I path locali storici restano
// invariati e retrocompatibili.
export function deckLocationFromPath(pathname) {
  const remote = String(pathname || '').match(/^\/deck\/([^/]+)\/([^/]+)\/?$/);
  if (remote) {
    let ownerId; let name;
    try { ownerId = decodeURIComponent(remote[1]); name = decodeURIComponent(remote[2]); }
    catch (_) { return { id: deckId(null, MAIN_DECK), ownerId: null, name: MAIN_DECK }; }
    if (NODE_ID_RE.test(ownerId) && isValidDeckName(name)) return { id: deckId(ownerId, name), ownerId, name };
  }
  const name = deckFromPath(pathname);
  return { id: deckId(null, name), ownerId: null, name };
}

// URL (path+fragment) per aprire un deck in una nuova finestra, col token nel
// fragment (mai nei log del server). Il token e' opzionale (gia' ricordato dal
// device via localStorage), ma passarlo rende la finestra apribile a freddo.
export function deckUrl(target, token) {
  const parsed = typeof target === 'object' && target
    ? { ownerId: target.ownerId || null, name: target.name }
    : parseDeckId(target) || { ownerId: null, name: target };
  const name = isValidDeckName(parsed.name) ? parsed.name : MAIN_DECK;
  const base = parsed.ownerId
    ? `/deck/${encodeURIComponent(parsed.ownerId)}/${encodeURIComponent(name)}`
    : name === MAIN_DECK ? '/' : `/deck/${encodeURIComponent(name)}`;
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}

// Chiave localStorage del layout per-deck.
export function layoutKey(name) {
  return name === MAIN_DECK ? 'nc_grid_v1' : `nc_grid_v1__${name}`;
}

// Registro nomi deck: 'main' sempre primo, solo nomi validi, dedup, cap.
export function normalizeDecks(list) {
  const out = [MAIN_DECK];
  if (Array.isArray(list)) {
    for (const n of list) {
      if (isValidDeckName(n) && n !== MAIN_DECK && !out.includes(n)) out.push(n);
      if (out.length >= MAX_DECKS) break;
    }
  }
  return out;
}

export function addDeck(list, name) {
  const out = normalizeDecks(list);
  if (isValidDeckName(name) && !out.includes(name) && out.length < MAX_DECKS) out.push(name);
  return out;
}

export function removeDeck(list, name) {
  if (name === MAIN_DECK) return normalizeDecks(list); // 'main' e' indistruttibile
  return normalizeDecks((Array.isArray(list) ? list : []).filter((n) => n !== name));
}

export function renameDeck(list, from, to) {
  const src = normalizeDecks(list);
  if (from === MAIN_DECK || !isValidDeckName(to)) return src;   // 'main' non rinominabile
  if (!src.includes(from) || src.includes(to)) return src;      // sorgente assente o collisione
  return normalizeDecks(src.map((n) => (n === from ? to : n)));
}

// --- accesso a localStorage (thin; il modello puro sopra resta testabile) ---
function ls() { return (typeof localStorage !== 'undefined') ? localStorage : null; }

export function loadDecks() {
  const s = ls();
  if (!s) return [MAIN_DECK];
  try { return normalizeDecks(JSON.parse(s.getItem(DECKS_KEY) || 'null')); }
  catch (_) { return [MAIN_DECK]; }
}

export function saveDecks(list) {
  const s = ls();
  if (!s) return;
  try { s.setItem(DECKS_KEY, JSON.stringify(normalizeDecks(list))); } catch (_) {}
}

// Layout grezzo (JSON) di un deck qualunque: usato dal "manda al deck X" per
// scrivere nel layout di un altro deck (l'altra finestra lo ricarica via evento
// 'storage'). Il chiamante normalizza col grid-model.
export function readLayoutRaw(name) {
  const s = ls();
  if (!s) return null;
  try { return JSON.parse(s.getItem(layoutKey(name)) || 'null'); } catch (_) { return null; }
}

export function writeLayoutRaw(name, layout) {
  const s = ls();
  if (!s) return;
  try { s.setItem(layoutKey(name), JSON.stringify(layout)); } catch (_) {}
}

// Rimuove del tutto lo stato persistito di un deck (all'eliminazione).
export function dropLayout(name) {
  const s = ls();
  if (!s || name === MAIN_DECK) return;
  try { s.removeItem(layoutKey(name)); } catch (_) {}
}
