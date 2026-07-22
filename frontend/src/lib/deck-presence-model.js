// Modello puro della "presence" client-side dei deck (per il dot di attivita').
// Nessun React: testabile in node. Ogni finestra/tab del browser che mostra un
// deck owner-qualified registra un heartbeat in localStorage (per-browser) e
// tutte le finestre leggono la stessa mappa per disegnare il dot.
//
// Nessun backend globale: la presence vive solo nel client locale (le altre
// finestre dello stesso browser). Non e' la presence del nodo remoto: l'owner
// offline si riconosce dal modello deck (available === false) -> dot 'warn'.
//
// Map: { [windowId]: { deckId, ts, focus, visible } }. Guard localStorage per
// importabilita' in node (test).

import { parseDeckId } from './deck-federation.js';

export const PRESENCE_KEY = 'nc_deck_presence_v1';
export const PRESENCE_TTL_MS = 30000;        // finestra visibile: oltre questo heartbeat e' stale
export const PRESENCE_HIDDEN_TTL_MS = 180000; // finestra hidden: tollera il timer throttling del browser
export const PRESENCE_HEARTBEAT_MS = 10000;  // cadenza di scrittura del proprio stato
const MAX_WINDOWS = 32;
const WINDOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_OBJECT_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

// Stati del dot. focused + visible => working (bright); aperta in background =>
// on (steady); non aperta => neutral; owner offline => warn.
export const DOT_WORKING = 'working';
export const DOT_ON = 'on';
export const DOT_NEUTRAL = 'neutral';
export const DOT_WARN = 'warn';

function validWindowId(id) {
  return typeof id === 'string' && WINDOW_ID_RE.test(id) && !UNSAFE_OBJECT_KEYS.has(id);
}

function validDeckId(id) {
  return typeof id === 'string' && parseDeckId(id) !== null;
}

function validTs(ts) {
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= 0;
}

// Normalizza la presence map. Bounded: cap MAX_WINDOWS, windowId validi,
// entry ben formate (deckId/ts/focus/visible). Input corrotto -> scartato.
export function normalizePresence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  let count = 0;
  for (const [wid, entry] of Object.entries(input)) {
    if (count >= MAX_WINDOWS) break;
    if (!validWindowId(wid)) continue;
    if (!entry || typeof entry !== 'object') continue;
    if (!validDeckId(entry.deckId)) continue;
    if (!validTs(entry.ts)) continue;
    out[wid] = {
      deckId: entry.deckId,
      ts: entry.ts,
      focus: entry.focus === true,
      visible: entry.visible === true,
    };
    count += 1;
  }
  return out;
}

// Rimuove gli heartbeat scaduti (best-effort cleanup).
export function pruneStale(map, now) {
  const m = normalizePresence(map);
  if (!validTs(now)) return m;
  const out = {};
  for (const [wid, entry] of Object.entries(m)) {
    // Nei tab hidden Chromium puo' raggruppare i timer fino a circa un minuto:
    // una TTL separata evita che una finestra realmente aperta perda il dot
    // "on" tra due heartbeat. La TTL resta bounded: una pagina completamente
    // sospesa/frozen viene infine considerata stale.
    const ttl = entry.visible ? PRESENCE_TTL_MS : PRESENCE_HIDDEN_TTL_MS;
    const cutoff = now - ttl;
    // Scarta anche timestamp troppo nel futuro: un valore corrotto non deve
    // rendere una finestra attiva indefinitamente.
    if (entry.ts >= cutoff && entry.ts <= now + PRESENCE_TTL_MS) out[wid] = entry;
  }
  return out;
}

// Scrive/aggiorna l'heartbeat di una finestra e pota i stale in un colpo solo.
export function upsertPresence(map, windowId, entry, now) {
  if (!validWindowId(windowId) || !validTs(now)) return normalizePresence(map);
  const pruned = pruneStale(map, now);
  if (!validDeckId(entry?.deckId)) return pruned;
  if (!Object.prototype.hasOwnProperty.call(pruned, windowId)
    && Object.keys(pruned).length >= MAX_WINDOWS) {
    let oldestId = '';
    let oldestTs = Infinity;
    for (const [wid, current] of Object.entries(pruned)) {
      if (current.ts < oldestTs) { oldestId = wid; oldestTs = current.ts; }
    }
    if (oldestId) delete pruned[oldestId];
  }
  pruned[windowId] = {
    deckId: entry.deckId,
    ts: now,
    focus: entry?.focus === true,
    visible: entry?.visible === true,
  };
  // ri-normalizza per rispettare MAX_WINDOWS se l'upsert ha saturato
  return normalizePresence(pruned);
}

// Rimuove una finestra dalla presence (alla chiusura/unmount).
export function removePresence(map, windowId) {
  const m = normalizePresence(map);
  if (!validWindowId(windowId)) return m;
  const out = { ...m };
  delete out[windowId];
  return out;
}

// Aggrega in un'unica passata gli stati di tutti i deck. Questo evita di
// normalizzare/potare la stessa localStorage map una volta per ogni chip.
export function dotStatesForPresence(map, now) {
  const pruned = pruneStale(map, now);
  const states = {};
  for (const entry of Object.values(pruned)) {
    const next = entry.focus && entry.visible ? DOT_WORKING : DOT_ON;
    if (states[entry.deckId] !== DOT_WORKING) states[entry.deckId] = next;
  }
  return states;
}

// Stato di un singolo deck. ownerOffline ha precedenza assoluta (warn); poi
// working se almeno una finestra e' focused+visible, on se e' aperta solo in
// background, neutral altrimenti.
export function dotForDeck(map, deckId, now, ownerOffline = false) {
  if (ownerOffline) return DOT_WARN;
  if (!validDeckId(deckId)) return DOT_NEUTRAL;
  return dotStatesForPresence(map, now)[deckId] || DOT_NEUTRAL;
}

// --- accesso a localStorage (thin; il modello puro sopra resta testabile) ---
function ls() { return (typeof localStorage !== 'undefined') ? localStorage : null; }

export function loadPresence(storage = ls()) {
  if (!storage) return {};
  try { return normalizePresence(JSON.parse(storage.getItem(PRESENCE_KEY) || 'null')); }
  catch (_) { return {}; }
}

export function savePresence(map, storage = ls()) {
  const clean = normalizePresence(map);
  if (storage) {
    try { storage.setItem(PRESENCE_KEY, JSON.stringify(clean)); } catch (_) {}
  }
  return clean;
}
