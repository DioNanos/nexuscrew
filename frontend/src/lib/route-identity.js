import { readPref, writePref } from './pref-store.js';
import { appendOrderJournal } from './order-journal.js';
import { SIDEBAR_ORDER_KEY, SIDEBAR_VIEW_KEY } from './sidebar-model.js';

// Identita' stabile delle posizioni della lista. Le chiavi salvate finora contengono il NOME della route del nodo
// (`<route>:<tmux>` per pin e ordini, `<route>` come posizione di ordini e viste): rinominare il nodo le rendeva
// orfane. Qui la posizione viene salvata sotto `id:<instanceId>` e le chiavi di cella vengono riscritte sul nome
// corrente. La migrazione COPIA: le chiavi vecchie non vengono mai cancellate (reversibile) ed e' idempotente.
export const ROUTE_ALIAS_KEY = 'nc_route_alias_v1';
export const ROUTE_IDENTITY_EVENT = 'nexuscrew-roster-preferences';
const PINS_KEY = 'nc_pins';
const OWNER_ID_RE = /^[a-f0-9]{16,64}$/;

// routeName -> instanceId, sulla base dei gruppi noti ORA. Modulo-globale: lo alimenta useNodes, lo leggono le preferenze.
let registry = new Map();
export const routeRegistry = () => registry;
export const resetRouteRegistry = () => { registry = new Map(); };

const routeName = (group) => (Array.isArray(group?.route) && group.route.length ? group.route.join('/') : String(group?.name || ''));

export function canonicalPosition(position, reg = registry) {
  if (position === 'local' || typeof position !== 'string') return position;
  const id = reg.get(position);
  return id ? `id:${id}` : position;
}

const rewritePrefix = (key, from, to) => (typeof key === 'string' && key.startsWith(`${from}:`) ? `${to}:${key.slice(from.length + 1)}` : key);
const dedupe = (list) => [...new Set(list)];

function loadObject(key, storage) {
  return readPref(key, { storage, fallback: () => ({}), parse: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined) });
}

// Vista per i componenti: ogni posizione nota risponde con la voce canonica (se c'e'), altrimenti con quella per nome.
export function positionView(stored, reg = registry) {
  const out = { ...(stored || {}) };
  for (const [name, id] of reg) if (stored && stored[`id:${id}`] !== undefined) out[name] = stored[`id:${id}`];
  return out;
}

// groups: gruppi nodo correnti. Ritorna true se ha scritto qualcosa nello storage.
export function registerRouteIdentities(groups, { storage = globalThis.localStorage } = {}) {
  const next = new Map(); // nome -> id (tutti i nomi noti, anche un fantasma sticky del vecchio nome)
  const live = new Map();  // id -> nome preferito: il gruppo raggiungibile, altrimenti il primo visto
  for (const group of Array.isArray(groups) ? groups : []) {
    const id = String(group?.instanceId || ''); const name = routeName(group);
    if (!(OWNER_ID_RE.test(id) && name) || next.has(name)) continue;
    next.set(name, id);
    const up = group.status === 'up' && group.stale !== true;
    if (!live.has(id) || (up && !live.get(id).up)) live.set(id, { name, up });
  }
  registry = next;
  if (!next.size) return false;

  const aliases = loadObject(ROUTE_ALIAS_KEY, storage);
  let orders = loadObject(SIDEBAR_ORDER_KEY, storage); let views = loadObject(SIDEBAR_VIEW_KEY, storage);
  let pins = readPref(PINS_KEY, { storage, fallback: () => [], parse: (v) => (Array.isArray(v) ? v : undefined) });
  const nextAliases = { ...aliases }; const nextOrders = { ...orders }; const nextViews = { ...views }; let nextPins = [...pins];
  const changed = { aliases: false, orders: false, views: false, pins: false };

  for (const [id, { name }] of live) {
    const canonical = `id:${id}`; const last = typeof aliases[id] === 'string' ? aliases[id] : '';
    // Un nome che oggi appartiene a un ALTRO nodo non e' un vecchio nome di questo: niente riscritture su quello.
    const previous = last && last !== name && (!next.has(last) || next.get(last) === id) ? last : '';
    if (previous) {
      nextPins = dedupe([...nextPins, ...pins.filter((k) => k.startsWith(`${previous}:`)).map((k) => rewritePrefix(k, previous, name))]);
      changed.pins = changed.pins || nextPins.length !== pins.length;
    }
    for (const [store, out, flag] of [[orders, nextOrders, 'orders'], [views, nextViews, 'views']]) {
      const source = store[canonical] !== undefined ? store[canonical] : (previous && store[previous] !== undefined ? store[previous] : store[name]);
      if (source === undefined) continue;
      let value = source;
      if (flag === 'orders' && Array.isArray(value)) {
        value = dedupe(value.map((k) => (previous ? rewritePrefix(k, previous, name) : k)));
      }
      if (JSON.stringify(out[canonical]) !== JSON.stringify(value)) { out[canonical] = value; changed[flag] = true; }
    }
    if (aliases[id] !== name) { nextAliases[id] = name; changed.aliases = true; }
    if (previous) appendOrderJournal({ reason: 'route-renamed', key: id, note: `${previous} -> ${name}` });
  }

  const errors = [];
  if (changed.pins) errors.push(writePref(PINS_KEY, nextPins, { storage }));
  if (changed.orders) errors.push(writePref(SIDEBAR_ORDER_KEY, nextOrders, { storage }));
  if (changed.views) errors.push(writePref(SIDEBAR_VIEW_KEY, nextViews, { storage }));
  if (changed.aliases) errors.push(writePref(ROUTE_ALIAS_KEY, nextAliases, { storage }));
  const wrote = Object.values(changed).some(Boolean);
  if (wrote) { try { window.dispatchEvent(new Event(ROUTE_IDENTITY_EVENT)); } catch (_) { /* fuori dal browser */ } }
  return wrote && errors.every((e) => !e);
}
