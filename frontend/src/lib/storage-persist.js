import { readPref, writePref } from './pref-store.js';
import { appendOrderJournal } from './order-journal.js';

// Chiede al browser di NON sfrattare lo storage dell'origine (navigator.storage.persist). L'esito si registra:
// il browser puo' rifiutare, e in quel caso l'utente deve poterlo vedere (Impostazioni) invece di scoprirlo
// dopo aver perso pin e ordine. Dopo un rifiuto si riprova al massimo una volta ogni 24 h.
export const PERSIST_KEY = 'nc_storage_persist_v1';
const RETRY_MS = 24 * 60 * 60 * 1000;

export function readPersistState(ls = globalThis.localStorage) {
  return readPref(PERSIST_KEY, { storage: ls, fallback: () => null, parse: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined) });
}

export async function ensureStoragePersistence({ manager = globalThis.navigator?.storage, ls = globalThis.localStorage, now = Date.now } = {}) {
  const previous = readPersistState(ls);
  const at = now();
  let next;
  try {
    if (!manager || typeof manager.persist !== 'function') next = { at, status: 'unsupported' };
    else if (typeof manager.persisted === 'function' && await manager.persisted()) next = { at, status: 'persistent' };
    else if (previous && previous.status === 'denied' && at - previous.at < RETRY_MS) return previous;
    else next = { at, status: (await manager.persist()) ? 'persistent' : 'denied' };
  } catch (error) {
    next = { at, status: 'error', note: String(error?.message || error).slice(0, 120) };
  }
  if (!previous || previous.status !== next.status) appendOrderJournal({ reason: 'storage-persist', note: next.status });
  writePref(PERSIST_KEY, next, { storage: ls });
  return next;
}
