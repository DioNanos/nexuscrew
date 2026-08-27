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
import { CAUSE_PEER_ASENTE, CAUSE_PEER_NEGA, CAUSE_ROTTA_INESISTENTE } from './peer-backoff.js';

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
  if (g.status === 'unreachable') {
    // R21: tre cause, tre azioni. Il rumore indistinto faceva fare la cosa
    // sbagliata: riprovare dove conviene aspettare, aspettare dove conviene
    // concedere un permesso, ignorare un nodo da aggiornare.
    if (g.cause === CAUSE_PEER_NEGA) return t('peer-cause-nega');
    if (g.cause === CAUSE_ROTTA_INESISTENTE) return t('peer-cause-rotta');
    if (g.cause === CAUSE_PEER_ASENTE) return t('peer-cause-assente');
    return t('node-unreachable');
  }
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

// Un hint di salute puo' portare l'AZIONE che ripara il nodo, non solo la
// descrizione del guasto: quando il canale -L viene rifiutato, il supervisore
// costruisce la riga `authorized_keys` da sostituire sul peer. Un nodo gia'
// accoppiato non rifara' mai il pairing, quindi questo e' l'UNICO posto in cui
// quella riga puo' raggiungerlo. Separa la spiegazione dalla riga cosi' la
// riga si puo' copiare: senza, resta annegata in una frase lunga.
const RIGA_AUTHKEYS = 'restrict,port-forwarding,permitopen=';
export function healthHintParts(h) {
  const hint = (h && typeof h.hint === 'string' && h.hint.trim()) || '';
  const strutturato = (h && typeof h.authorizedKeys === 'string' && h.authorizedKeys.trim()) || '';
  // Il CAMPO vince sempre sul testo: la riga arriva intera da chi l'ha
  // costruita, invece di essere ritagliata da una frase che quel codice puo'
  // riscrivere o tradurre senza sapere che qualcuno la sta tagliando.
  if (strutturato) {
    const i = hint.indexOf(strutturato);
    // Se la frase la contiene, la nota e' la frase SENZA la riga: mostrarla due
    // volte sarebbe rumore proprio dove serve leggere.
    const note = i >= 0 ? hint.slice(0, i).replace(/[:\s]+$/, '') : hint;
    return { note, line: strutturato };
  }
  if (!hint) return null;
  // Fallback per una salute prodotta da una versione che il campo non lo manda:
  // degrada al ritaglio, e se non trova la riga mostra la frase intera.
  const i = hint.indexOf(RIGA_AUTHKEYS);
  if (i < 0) return { note: hint, line: '' };
  return { note: hint.slice(0, i).replace(/[:\s]+$/, ''), line: hint.slice(i).trim() };
}

// True se la sessione ha output in outbox piu' recente dell'ultima volta che
// l'utente l'ha vista (badge "nuovi file"). key e' route-qualified (seenKey).
export function hasFreshOutput(session, key, storage = globalThis.localStorage) {
  if (!session?.outbox || session.outbox.count < 1) return false;
  const seen = Number(storage.getItem(seenKey(key)) || 0);
  return session.outbox.latest > seen;
}

// Riga di stato condivisa da mobile e desktop. Da spenta mostra il modello
// configurato (con fallback all'engine); da accesa usa il segnale esplicito
// derivato dal pane_title tmux. Un peer precedente al nuovo contratto non viene
// marcato come working: conserva il preview come fallback compatibile.
export function cellRuntime(cell, session = {}) {
  const c = cell || {};
  if (!c.tmux) {
    const engine = `${c.engine || ''}${c.key ? `·${c.key}` : ''}`;
    const startup = [engine, c.model && c.model !== engine ? c.model : ''].filter(Boolean).join(' · ');
    return {
      working: false,
      subtitle: String(startup || t('cell-off')).trim(),
    };
  }
  if (session.working === true) {
    const label = t('cell-working');
    const detail = String(session.status || '').trim();
    const generic = !detail || /^working(?:\.{3}|…)?$/i.test(detail);
    return {
      working: true,
      subtitle: generic ? label : `${label} · ${detail}`,
    };
  }
  if (session.working === false) {
    return { working: false, subtitle: t('cell-idle') };
  }
  return {
    working: false,
    subtitle: String(session.preview || c.preview || t('cell-on')).trim(),
  };
}

function cellSearchText(cell, session) {
  return [...new Set(
    [cell.engine, cell.model, cell.key, session.preview, cell.preview, session.status]
      .filter(Boolean).map(String),
  )].join(' ');
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
      const runtime = cellRuntime(c, session);
      return {
        type: 'cell', value: c, key, label: c.cell, live: !!c.tmux,
        fresh: hasFreshOutput(session, key, storage), activity: session.activity || 0,
        working: runtime.working, subtitle: runtime.subtitle,
        searchText: cellSearchText(c, session),
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
      const runtime = cellRuntime(c, session);
      return {
        // preserved: cella di un elenco fermo (nodo non raggiungibile) — non
        // e' "live" nemmeno se l'ultima sessione tmux era attiva: drag, click,
        // filtri "attive" devono trattarla come spenta.
        type: 'cell', value: c, key, label: c.cell, live: !!c.tmux && !c.preserved,
        fresh: hasFreshOutput(session, key, storage), activity: session.activity || c.activity || 0,
        working: runtime.working, subtitle: runtime.subtitle,
        searchText: cellSearchText(c, session),
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
