// Pure roster view-model shared by the desktop Sidebar and the mobile
// SessionList. No React here: normalization, health labels/dots, relative
// activity, fresh-output detection and per-position roster construction.
//
// Both shells render their own markup; this module owns the single contract
// that turns fleet/node/session data into renderable, route-qualified items.
// Every item carries a route-qualified `key` (so pins/orders never collide
// across positions), a human `label`, a `live` flag, a `fresh` flag, an
// `activity` epoch and a `searchText` haystack (used by the mobile search;
// harmless on the desktop sidebar, which does not search).

import { seenKey } from './api.js';
import { t } from './i18n.js';
import { positionKey } from './nodes-model.js';

// Tempo relativo compatto da epoch sec: 'ora' | 'Nm' | 'Nh' | 'Ng'.
// nowSec e' iniettabile solo per i test; il default e' l'ora corrente, come
// facevano le copie inline che questo modulo sostituisce.
export function rel(epochSec, nowSec = Math.floor(Date.now() / 1000)) {
  if (!epochSec) return '';
  const s = nowSec - epochSec;
  if (s < 0 || s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

// Etichetta di stato di un gruppo nodo degradato (design §7: mai spinner).
// Usa rel() per i "down since" / "visto ... fa".
export function nodeStateLabel(g) {
  if (g.status === 'passive') return t('node-passive');
  if (g.status === 'down') {
    return g.downSince ? t('tunnel-down-since').replace('{t}', rel(g.downSince)) : t('tunnel-down');
  }
  if (g.status === 'unreachable') return t('node-unreachable');
  if (g.status === 'offline') return g.lastSeen ? t('node-offline-seen').replace('{t}', rel(g.lastSeen)) : t('node-offline');
  if (g.status === 'needs-repair') return t('node-needs-repair');
  return '';
}

// Dot di salute dal model health (NO verde hardcoded): 'on' solo se probe 200;
// degraded (401) / down / unknown -> 'warn' + titolo diagnostico. Un nodo
// passivo (client offline atteso, status:'passive') NON e' un allarme: la
// sidebar desktop vuole il dot neutro (null) e lascia allo stato del gruppo la
// classe finale. La home mobile ha storicamente usato 'warn' anche per i nodi
// passivi: lo preserve passando { passive: 'warn' }.
export function healthDot(h, { passive = null } = {}) {
  if (!h) return null;
  if (h.status === 'passive') return passive;
  return h.status === 'healthy' ? 'on' : 'warn';
}

export function healthTitle(h) {
  if (!h) return '';
  return h.detail || h.status || '';
}

// True se la sessione ha output in outbox piu' recente dell'ultima volta che
// l'utente l'ha vista (badge "nuovi file"). key e' route-qualified (seenKey).
export function hasFreshOutput(session, key, storage = globalThis.localStorage) {
  if (!session?.outbox || session.outbox.count < 1) return false;
  const seen = Number(storage.getItem(seenKey(key)) || 0);
  return session.outbox.latest > seen;
}

// Costruisce le righe normalizzate della posizione Locale: celle Fleet (con
// activity/preview dalla sessione tmux omonima) + tmux unmanaged. L'ordine e'
// quello dell'input: sidebarItems riordina comunque in modo totale (pin, ordine
// manuale, live, fresh, attivita', label, key), quindi l'ordinamento qui non
// cambia il risultato finale — la sidebar pre-ordina per pinRank prima di
// chiamare, la home passa l'ordine naturale.
export function buildLocalRoster(cells, unmanaged, byName, storage = globalThis.localStorage) {
  return [
    ...(Array.isArray(cells) ? cells : []).map((c) => {
      const session = byName.get(c.tmuxSession) || {};
      const key = positionKey([], c.tmuxSession);
      return {
        type: 'cell', value: c, key, label: c.cell, live: !!c.tmux,
        fresh: hasFreshOutput(session, key, storage), activity: session.activity || 0,
        searchText: `${c.engine || ''} ${c.key || ''} ${session.preview || ''}`,
      };
    }),
    ...(Array.isArray(unmanaged) ? unmanaged : []).map((s) => {
      const key = positionKey([], s.name);
      return {
        type: 'session', value: s, key, label: s.name, live: true, technical: s.technical === true,
        fresh: hasFreshOutput(s, key, storage), activity: s.activity || 0,
        searchText: `${s.preview || ''} ${s.cmd || ''}`,
      };
    }),
  ];
}

// Costruisce le righe normalizzate di una posizione remota (gruppo nodo):
// celle Fleet (attive e inattive) + tmux unmanaged. Ritorna { route, rawItems }
// cosicche' la shell possa derivarne nodeRoute/groupView/items con la propria
// vista e il proprio ordine (e, sul mobile, il filtro ricerca).
export function buildRemoteRoster(group, storage = globalThis.localStorage) {
  const g = group || {};
  const route = Array.isArray(g.route) ? g.route : [];
  const remoteByName = new Map((g.sessions || []).map((s) => [s.name, s]));
  const rawItems = [
    ...(g.cells || []).map((c) => {
      const session = remoteByName.get(c.tmuxSession) || {};
      const key = positionKey(route, c.tmuxSession || c.cell);
      return {
        type: 'cell', value: c, key, label: c.cell, live: !!c.tmux,
        fresh: hasFreshOutput(session, key, storage), activity: session.activity || c.activity || 0,
        searchText: `${c.engine || ''} ${c.key || ''} ${session.preview || c.preview || ''}`,
      };
    }),
    ...(g.unmanaged || []).map((s) => {
      const key = positionKey(route, s.name);
      return {
        type: 'session', value: s, key, label: s.name, live: true, technical: s.technical === true,
        fresh: hasFreshOutput(s, key, storage), activity: s.activity || 0,
        searchText: `${s.preview || ''} ${s.cmd || ''}`,
      };
    }),
  ];
  return { route, rawItems };
}
