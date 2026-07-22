// Modello puro della preferenza "gruppo owner compresso" nella DeckBar.
// Nessun React: testabile in node. Una mappa owner-qualified {ownerKey: bool}
// in localStorage (per-browser/per-client). Un owner ASSENTE dalla mappa vale
// "compresso" (true): i nuovi nodi partono chiusi. L'utente che espande salva
// false; ricomprimendo salva true. La preferenza e' persistente e owner-qualified
// (mai per-deck, mai globale), cosi' non fa leak della topologia: dalla chiave
// salvata non si ricostruisce l'albero dei deck, solo quali label l'utente ha
// gia' gestito. Guard localStorage per importabilita' in node (test).

import { LOCAL_OWNER, NODE_ID_RE } from './deck-federation.js';

export const COLLAPSE_KEY = 'nc_deckbar_collapsed_v1';
const MAX_OWNERS = 64;

// ownerKey valido: 'local' oppure un nodeId stabile (NODE_ID_RE).
export function validOwnerKey(value) {
  return value === LOCAL_OWNER || NODE_ID_RE.test(String(value || ''));
}

// Normalizza la mappa di preferenza. Bounded: cap MAX_OWNERS, solo chiavi
// owner valide, valori rigorosamente booleani (true=compresso, false=espanso).
// Valori non-boolean o chiavi non-owner sono input corrotto e vengono scartati.
export function normalizeCollapsed(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_OWNERS) break;
    if (!validOwnerKey(key)) continue;
    if (value === true) out[key] = true;
    else if (value === false) out[key] = false;
    // qualunque altro tipo (stringa, numero, null, oggetto) -> scartato
    else continue;
    count += 1;
  }
  return out;
}

// Un owner compresso? Assente => true (nuovi nodi partono compressi).
// Una chiave owner non valida => true (safe default: non espande mai robo.sconosciuto).
export function isCollapsedOf(map, ownerKey) {
  if (!validOwnerKey(ownerKey)) return true;
  return Object.prototype.hasOwnProperty.call(map || {}, ownerKey)
    ? map[ownerKey] === true
    : true;
}

// Inverti la preferenza di un owner. Se era assente (default compresso) diventa
// espanso (false); se era espanso diventa compresso (true) e viceversa.
export function toggleCollapsedIn(map, ownerKey) {
  const next = normalizeCollapsed(map);
  if (!validOwnerKey(ownerKey)) return next;
  // Bounded ma sempre azionabile: a saturazione un owner nuovo sostituisce la
  // preferenza meno recente (prima chiave inserita). Altrimenti un nodo assente
  // resterebbe compresso per sempre, perche' il click non potrebbe salvarlo.
  if (!Object.prototype.hasOwnProperty.call(next, ownerKey)
    && Object.keys(next).length >= MAX_OWNERS) {
    delete next[Object.keys(next)[0]];
  }
  next[ownerKey] = !isCollapsedOf(next, ownerKey);
  return next;
}

// Imposta esplicitamente la preferenza (usato dai test e dal ripristino).
export function setCollapsedIn(map, ownerKey, value) {
  const next = normalizeCollapsed(map);
  if (!validOwnerKey(ownerKey)) return next;
  if (!Object.prototype.hasOwnProperty.call(next, ownerKey)
    && Object.keys(next).length >= MAX_OWNERS) {
    delete next[Object.keys(next)[0]];
  }
  next[ownerKey] = value === true;
  return next;
}

// --- accesso a localStorage (thin; il modello puro sopra resta testabile) ---
function ls() { return (typeof localStorage !== 'undefined') ? localStorage : null; }

export function loadCollapsed(storage = ls()) {
  if (!storage) return {};
  try { return normalizeCollapsed(JSON.parse(storage.getItem(COLLAPSE_KEY) || 'null')); }
  catch (_) { return {}; }
}

export function saveCollapsed(map, storage = ls()) {
  const clean = normalizeCollapsed(map);
  if (storage) {
    try { storage.setItem(COLLAPSE_KEY, JSON.stringify(clean)); } catch (_) {}
  }
  return clean;
}
