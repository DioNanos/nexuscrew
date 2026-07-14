// Modello puro dei "deck" (workspace nominati multi-finestra, §5b). Nessun React.
// Un deck = un layout griglia nominato, indirizzabile via /deck/<name>, persistito
// client-side (localStorage per-browser). 'main' e' il deck di default e resta sulla
// chiave storica del layout (nc_grid_v1) per non perdere i layout esistenti.
// Guard localStorage/window per importabilita' in node (test).

import { deckId, parseDeckId, NODE_ID_RE } from './deck-federation.js';

export const DECK_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const MAIN_DECK = 'main';
export const DECKS_KEY = 'nc_decks';
export const DECK_ORDER_KEY = 'nc_deck_order_v1';
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

// Ordine visuale owner-qualified.  I deck restano sul nodo che li possiede:
// il drag riordina soltanto i tab dello stesso gruppo Local/remoto e salva una
// preferenza per-browser, come il roster delle celle.
function validOwnerKey(value) {
  return value === 'local' || NODE_ID_RE.test(String(value || ''));
}

function idBelongsToOwner(id, ownerKey) {
  const parsed = parseDeckId(id);
  return !!parsed && (parsed.ownerId || 'local') === ownerKey;
}

export function normalizeDeckOrders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [ownerKey, ids] of Object.entries(input).slice(0, 64)) {
    if (!validOwnerKey(ownerKey) || !Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter((id) => typeof id === 'string'
      && id.length <= 100 && idBelongsToOwner(id, ownerKey)))].slice(0, MAX_DECKS);
    if (clean.length) out[ownerKey] = clean;
  }
  return out;
}

export function loadDeckOrders(storage = ls()) {
  if (!storage) return {};
  try { return normalizeDeckOrders(JSON.parse(storage.getItem(DECK_ORDER_KEY) || 'null')); }
  catch (_) { return {}; }
}

export function saveDeckOrders(orders, storage = ls()) {
  const clean = normalizeDeckOrders(orders);
  if (storage) {
    try { storage.setItem(DECK_ORDER_KEY, JSON.stringify(clean)); } catch (_) {}
  }
  return clean;
}

export function deckOrder(orders, ownerKey) {
  return Array.isArray(orders?.[ownerKey]) ? orders[ownerKey] : [];
}

// Sposta source nella posizione occupata da target. Come per le celle,
// adiacenti su/giu (qui sinistra/destra) funzionano in entrambe le direzioni.
export function moveDeckInOrder(orders, ownerKey, source, target, availableIds = []) {
  if (!validOwnerKey(ownerKey) || source === target) return normalizeDeckOrders(orders);
  const available = [...new Set(availableIds.filter((id) => idBelongsToOwner(id, ownerKey)))];
  if (!available.includes(source) || !available.includes(target)) return normalizeDeckOrders(orders);
  const stored = deckOrder(orders, ownerKey).filter((id) => available.includes(id));
  const base = [...stored, ...available.filter((id) => !stored.includes(id))];
  const sourceIndex = base.indexOf(source); const targetIndex = base.indexOf(target);
  base.splice(sourceIndex, 1);
  const targetAfterRemoval = base.indexOf(target);
  base.splice(sourceIndex < targetIndex ? targetAfterRemoval + 1 : targetAfterRemoval, 0, source);
  return normalizeDeckOrders({ ...orders, [ownerKey]: base });
}

export function replaceDeckOrderId(orders, ownerKey, from, to) {
  if (!validOwnerKey(ownerKey) || !idBelongsToOwner(to, ownerKey)) return normalizeDeckOrders(orders);
  const current = deckOrder(orders, ownerKey);
  if (!current.includes(from)) return normalizeDeckOrders(orders);
  return normalizeDeckOrders({ ...orders, [ownerKey]: current.map((id) => id === from ? to : id) });
}

export function removeDeckOrderId(orders, ownerKey, id) {
  if (!validOwnerKey(ownerKey)) return normalizeDeckOrders(orders);
  return normalizeDeckOrders({ ...orders, [ownerKey]: deckOrder(orders, ownerKey).filter((item) => item !== id) });
}

export function orderDeckRecords(records, orders = {}) {
  const groups = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const ownerKey = record?.local ? 'local' : String(record?.ownerId || '');
    if (!validOwnerKey(ownerKey) || !idBelongsToOwner(record?.id, ownerKey)) continue;
    if (!groups.has(ownerKey)) groups.set(ownerKey, []);
    groups.get(ownerKey).push(record);
  }
  const out = [];
  for (const [, group] of groups) {
    const ownerKey = group[0].local ? 'local' : group[0].ownerId;
    const saved = deckOrder(orders, ownerKey);
    const rank = new Map(saved.map((id, index) => [id, index]));
    group.sort((a, b) => {
      const ai = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
    out.push(...group);
  }
  return out;
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
