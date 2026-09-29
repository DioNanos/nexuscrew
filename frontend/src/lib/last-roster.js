import { readPref, writePref } from './pref-store.js';

// Ultimo elenco celle Fleet letto con esito AUTOREVOLE, per posizione ('local' o `id:<instanceId>`).
// Serve a una PWA riaperta mentre il fleet non risponde: senza, la lista mostra solo le sessioni tmux e le celle
// spente spariscono. Le celle ripristinate sono marcate `preserved` e mai vive.
export const LAST_ROSTER_KEY = 'nc_last_roster_v1';
const MAX_CELLS = 64;
const FIELDS = ['cell', 'tmuxSession', 'engine', 'model', 'label', 'boot'];

const loadAll = (storage) => readPref(LAST_ROSTER_KEY, {
  storage, fallback: () => ({}), parse: (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined),
});

export function saveLastRoster(owner, cells, storage = globalThis.localStorage) {
  if (!owner) return;
  const all = { ...loadAll(storage) };
  if (!Array.isArray(cells) || !cells.length) delete all[owner]; // vuoto autorevole: la verita' e' «nessuna cella»
  else {
    all[owner] = {
      at: Date.now(),
      cells: cells.slice(0, MAX_CELLS).filter((c) => c && typeof c.cell === 'string').map((c) => Object.fromEntries(
        FIELDS.filter((f) => c[f] !== undefined && c[f] !== null).map((f) => [f, c[f]]))),
    };
  }
  writePref(LAST_ROSTER_KEY, all, { storage });
}

export function loadLastRoster(owner, storage = globalThis.localStorage) {
  const entry = owner ? loadAll(storage)[owner] : null;
  if (!entry || !Array.isArray(entry.cells)) return [];
  return entry.cells.map((c) => ({ ...c, tmux: false, active: false, preserved: true, degraded: false }));
}
