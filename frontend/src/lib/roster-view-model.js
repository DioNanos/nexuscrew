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

// Ragioni terminali del supervisore che la riga della cella sa NOMINARE (le
// stesse dell'enum chiuso del canale terminale). Fuori da qui: nessuna
// etichetta inventata.
const RAGIONI_TERMINALI_CELLA = [
  'restart-budget-exhausted',
  'uncertain-delivery',
  'lease-lost',
  'spawn-error',
  'operator-stop',
];

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

// Etichetta di stato di un gruppo nodo degradato (mai spinner).
// Usa rel() per i "down since" / "visto ... fa".
// La lista sessioni di questa posizione e' una LETTURA o una supposizione?
// Un gruppo «up» con la lettura delle sessioni caduta non lo e': l'inventario
// delle celle puo' essere completo mentre l'elenco tmux e' degradato, ed e'
// esattamente il caso in cui il gruppo si dichiara parziale. Tutto cio' che
// deriva dalla sessione — attivita', anteprima, stato acceso — in quel caso
// non e' un dato verificato, e non va presentato come tale.
export function sessionsAuthoritative(g) {
  const gruppo = g || {};
  // Il degrado si dichiara, non si deduce da un campo mancante: un gruppo
  // costruito senza `status` (forma parziale, test, chiamante che passa solo
  // cio' che gli serve) non sta affermando che la lettura e' caduta.
  if (gruppo.sessionsAvailable === false) return false;
  if (typeof gruppo.status === 'string' && gruppo.status !== 'up') return false;
  return true;
}

export function nodeStateLabel(g) {
  if (g.status === 'up' && !sessionsAuthoritative(g)) return t('node-sessions-unverified');
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
  // «Mai collegato» non è «offline»: il primo non ha mai avuto un heartbeat e
  // chiede di guardare il device, il secondo l'ha perso e chiede di aspettare.
  if (g.status === 'never-connected') return t('node-never-connected');
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
  if (h.status === 'healthy') return 'on';
  // `status` assente o nullo e' «nessuna affermazione», non un guasto: un
  // oggetto vuoto non deve accendere un avviso. Gli stati dichiarati e
  // diversi da healthy restano warn, come prima.
  if (h.status === null || h.status === undefined) return null;
  return 'warn';
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

// La consegna del prompt e' una riga SUA, accanto allo stato della cella e mai
// al posto suo: un prompt in attesa non rende la cella «attiva», un prompt
// inviato non la rende «incarico accettato», e una ragione terminale resta la
// riga principale. Il badge parla solo degli stati dell'enum chiuso del
// proprietario e delle chiavi di traduzione: nessun testo libero.
const PRIORITA_CONSEGNA = Object.freeze({
  action: 3, problem: 2, pending: 1, submitted: 0, stale: -1, unavailable: -1, unverified: -1, none: -2,
});

// I kind di non-pronta che chiedono una risposta dell'operatore: permesso,
// consenso, onboarding. Sono gli unici che meritano il gradino piu' alto.
const NOT_READY_CHE_CHIEDONO_AZIONE = Object.freeze([
  'not-ready-auth', 'not-ready-consent', 'not-ready-onboarding',
]);

// Lo skip di generation del bootstrap VL e' l'esito NORMALE di un lancio che ha
// gia' la sua generazione: non e' un guasto e non merita un allarme.
const SKIP_NORMALE = 'vl-bootstrap-generation';

// promptDeliveryBadge(cell, { currentLaunchId, autorevole, preserved })
//   -> { badge, priorita, key, reason, launchId, ts, notReady, freschezza }
// badge: 'action' | 'problem' | 'pending' | 'submitted' | 'stale' | 'unavailable' | 'none'
// freschezza: 'current' | 'last-known'
//
// L'autorita' della lettura e' un dato del chiamante: un inventario conservato
// (peer che non risponde, cella preserved, lettura non autorevole) mostra
// un'istantanea, e un'istantanea non e' un'attestazione corrente. Il backend
// non viene interrogato per degradarla — quando il peer tace, quello che la PWA
// presenta e' l'ultimo dato noto e va detto.
//
// `ts` e `notReady` viaggiano col badge (P3-3): il FOGLIO della cella nomina
// la consegna con l'ora del record e il motivo leggibile — senza questi campi
// il foglio non potrebbe dire né quando né perché.
export function promptDeliveryBadge(cell, { currentLaunchId = null, autorevole = true, preserved = false } = {}) {
  const c = cell || {};
  const d = c.promptDelivery;
  const letturaCorrente = autorevole && !preserved;
  const ts = d && typeof d.ts === 'number' && Number.isFinite(d.ts) ? d.ts : null;
  const notReady = d && typeof d.notReady === 'string' && d.notReady ? d.notReady : null;
  const vuoto = (badge, key) => ({
    badge, priorita: PRIORITA_CONSEGNA[badge], key, reason: null, launchId: null,
    ts: null, notReady: null,
    freschezza: letturaCorrente ? 'current' : 'last-known',
  });
  if (!d || typeof d !== 'object' || Array.isArray(d)) return vuoto('unavailable', 'prompt-badge-unavailable');

  const reason = typeof d.reason === 'string' ? d.reason : null;
  const launchId = typeof d.launchId === 'string' ? d.launchId : null;
  // Il record di un lancio sostituito non si mostra come se fosse quello in
  // corso: senza il lancio corrente non c'e' confronto possibile, e in quel
  // caso vale cio' che il backend ha gia' degradato a unknown. La SUA ora non
  // si presta al lancio corrente: niente ts su un record stantio.
  const corrente = currentLaunchId || c.launchId || null;
  if (launchId && corrente && launchId !== corrente) return vuoto('stale', 'prompt-badge-stale');

  const esito = (badge) => ({
    badge, priorita: PRIORITA_CONSEGNA[badge], key: `prompt-badge-${badge}`, reason, launchId,
    ts, notReady,
    freschezza: letturaCorrente ? 'current' : 'last-known',
  });
  // Una consegna in corso o gia' consegnata, letta da un inventario non
  // corrente, e' «ultimo dato noto» e non un'attestazione: si mostra come
  // tale. Una richiesta d'azione invece resta visibile anche da storica —
  // l'operatore deve poterla vedere — ma dichiarata storica.
  const nonCorrente = () => ({
    badge: 'stale', priorita: PRIORITA_CONSEGNA.stale, key: 'prompt-badge-last-known',
    reason: null, launchId, ts, notReady: null, freschezza: 'last-known',
  });
  switch (d.state) {
    case 'pending': return letturaCorrente ? esito('pending') : nonCorrente();
    case 'submitted': return letturaCorrente ? esito('submitted') : nonCorrente();
    case 'skipped':
      if (reason === SKIP_NORMALE) {
        return {
          badge: 'none', priorita: PRIORITA_CONSEGNA.none, key: null, reason, launchId,
          ts, notReady,
          freschezza: letturaCorrente ? 'current' : 'last-known',
        };
      }
      if (reason === 'prompt-rejected' || NOT_READY_CHE_CHIEDONO_AZIONE.includes(d.notReady)) {
        return esito('action');
      }
      return esito('problem');
    // `unknown` is the backend saying "this cannot be attested" — the launch
    // has no owner snapshot, or the record belongs to another generation. It is
    // not a refusal and not a failure: the failure word stays for a `skipped`
    // with a reason that proves one.
    case 'unknown': return esito('unverified');
    default: return vuoto('unavailable', 'prompt-badge-unavailable');
  }
}

// P3-3 — La parola del foglio per lo STATO della consegna, dal badge: le
// cinque forme chiuse «inviato / non inviato / in invio / non applicabile /
// non verificabile». Un record stantio non e' attestabile per il lancio
// corrente: la sua parola e' quella della non verificabilita'.
export function promptInitialStateKey(badge) {
  switch (badge) {
    case 'submitted': return 'prompt-initial-submitted';
    case 'pending': return 'prompt-initial-pending';
    case 'action': case 'problem': case 'none': return 'prompt-initial-skipped';
    case 'unverified': case 'stale': return 'prompt-initial-unverified';
    default: return 'prompt-initial-unavailable';
  }
}

// P3-3 — La parola del foglio per il MOTIVO dello skip, chiusa sull'enum del
// proprietario: la mappa studiata (not-ready, deadline, rifiuto, VL) piu' la
// parola onesta per tutto il resto del catalogo.
export function promptInitialReasonKey(reason) {
  if (!reason) return null;
  if (reason === 'not-ready') return 'prompt-reason-not-ready';
  if (NOT_READY_CHE_CHIEDONO_AZIONE.includes(reason)) return 'prompt-reason-response';
  if (reason === 'deadline-exceeded') return 'prompt-reason-deadline';
  if (reason === 'prompt-rejected') return 'prompt-reason-rejected';
  if (reason.startsWith('vl-bootstrap-')) return 'prompt-reason-vl';
  return 'prompt-reason-other';
}

// Codici chiusi della supervisione NC per cella (campo ncControl dello
// /status). Il campo ASSENTE (server precedente allo strato) NON si
// ricostruisce: resta «non verificabile». Mai un none dall'assenza.
const NC_CONTROL_CODES = [
  'attested', 'none', 'reconnecting', 'expired', 'unqualified', 'unverifiable', 'inactive',
];

// Il codice onesto della supervisione NC per una cella, dalla lettura del
// chiamante. Puro: lo usa la riga (cellRuntime) e il FOGLIO della cella
// (PowerSheet), che nomina l'etichetta per esteso.
export function ncControlCode(cell, { fleetStale = false } = {}) {
  const c = cell || {};
  const presente = NC_CONTROL_CODES.includes(c.ncControl);
  let code = presente ? c.ncControl : 'unverifiable';
  // Freschezza della lettura Fleet fino alla presentazione: un dato
  // CONSERVATO (elenco fermo del nodo, cella preserved, fleet conservata
  // dal drawer) non attesta nulla di CORRENTE — nemmeno l'attestazione
  // dell'ultimo elenco buono. Degrada a non verificabile, mai a none, e
  // non ricostruisce lease o control dal client.
  if (fleetStale === true || c.preserved === true) code = 'unverifiable';
  return code;
}

// Riga di stato condivisa da mobile e desktop. La riga principale dice
// PRESENZA + TURNO; la supervisione NC viaggia nel campo suo.
//
// UN contratto, un campo: `stato`. Cio' che la riga SA non e' un secondo
// campo accanto al primo — due rappresentazioni dello stesso fatto sono due
// fonti che possono divergere, ed e' il difetto che questo file ha gia'
// pagato una volta.
export function cellRuntime(cell, session = {}, opts = {}) {
  const r = cellRuntimeCore(cell, session, opts);
  const c = cell || {};
  const code = ncControlCode(c, { fleetStale: opts.fleetStale === true });
  r.ncControl = code;
  // Dell'etichetta NC in CARD resta solo cio' che chiede un'azione ADESSO:
  // il controllo SCADUTO (P3-2). Tutti gli altri esiti — attestato, nessuno,
  // in riconnessione, non qualificato, non verificabile — vivono nel foglio
  // della cella: senza il binding persistito, dopo ogni riavvio del servizio
  // l'etichetta perenne sarebbe rumore su ogni riga viva. Il campo ausiliare
  // ncControl resta al codice, e il foglio lo nomina per esteso.
  if (c.tmux === true && c.preserved !== true && code === 'expired') {
    r.ncControlLabel = t('nc-control-expired');
  }
  return r;
}

function cellRuntimeCore(cell, session = {}, { autorevole = true } = {}) {
  const c = cell || {};
  const engine = `${c.engine || ''}${c.key ? `·${c.key}` : ''}`;
  const startup = [engine, c.model && c.model !== engine ? c.model : ''].filter(Boolean).join(' · ');
  const presenza = t('cell-present');
  // Ragione terminale del LANCIO CORRENTE (canale su file del supervisore,
  // sopravvive alla scomparsa del pane): e' la verita' di supervisione e vince
  // su ogni indizio — pane residuo, anteprima, stato pubblicato. La cella e'
  // SPENTA per quella ragione, mai «attiva sana» sulla sola sessione tmux
  // rimasta. Solo le ragioni dell'enum chiuso: una ragione sconosciuta non si
  // inventa un'etichetta.
  // The terminal record is the outcome of a LAUNCH, not the state of the cell:
  // it explains a row only when the cell is not alive. A tmux session that
  // survived its supervisor (remain-on-exit) is alive, and a stop recorded days
  // ago must not overwrite what the cell is doing now.
  const terminale = c.terminal && typeof c.terminal === 'object' ? c.terminal : null;
  if (c.active === false && terminale && RAGIONI_TERMINALI_CELLA.includes(terminale.reason)) {
    return {
      working: false,
      stato: 'ferma',
      terminale: terminale.reason,
      subtitle: `${t('cell-off')} · ${t(`cell-terminal-${terminale.reason}`)}`,
    };
  }
  if (!c.tmux) {
    // La riga dice la PRESENZA, non la configurazione: il motore si legge nel
    // foglio della cella. «spenta» senza ragione è già tutto ciò che è vero.
    return {
      working: false,
      subtitle: t('cell-off'),
    };
  }
  // Il turno viene SOLO dallo stato pubblicato dagli hook: e' l'unico
  // segnale che DICE cosa sta facendo la cella invece di indovinarlo. Tre
  // stati, e «attesa permesso» reso come lavoro con la sua etichetta — la
  // cella non e' ferma, e' bloccata su una richiesta. Il turno finito e'
  // «in attesa», MAI «ferma»/«stopped»: quello e' il vocabolario dello stop
  // NC, e un turno che finisce non è uno stop.
  const stato = session.attivita && typeof session.attivita === 'object'
    ? session.attivita.stato : null;
  if (stato === 'lavora' || stato === 'attesa') {
    const label = t(stato === 'attesa' ? 'cell-permission' : 'cell-working');
    const detail = String(session.status || '').trim();
    const generic = !detail || /^working(?:\.{3}|…)?$/i.test(detail);
    return {
      working: true,
      stato,
      subtitle: [
        presenza,
        stato === 'lavora' && !generic ? `${label} · ${detail}` : label,
      ].join(' · '),
    };
  }
  if (stato === 'ferma') {
    return { working: false, stato: 'ferma', subtitle: `${presenza} · ${t('cell-turn-idle')}` };
  }
  // Nessun canale affidabile — cella non-Claude, oppure dato assente o scaduto.
  // E qui c'e' un caso che non e' un dettaglio: la cella risulta accesa
  // nell'inventario ma la sua SESSIONE non e' stata letta (elenco tmux
  // degradato, peer in backoff, nodo giu'). In quel caso non si mostra
  // l'anteprima come se fosse un dato: si dice che il dato non e' verificato,
  // e si mostra quel che si sa davvero — il motore configurato, che e' un dato
  // Fleet e c'e'.
  if (!autorevole) {
    return {
      working: false,
      stato: 'ignoto',
      subtitle: [t('cell-unknown'), startup].filter(Boolean).join(' · '),
    };
  }
  // Nessuna attivita' qualificata: la riga mostra SOLO la presenza (P3-1). Il
  // titolo del pane resta un INDIZIO, non una prova — non si dice «non
  // verificato» per un dato che semplicemente non c'e', e l'anteprima non e'
  // uno stato. Il `working` del titolo alimenta solo il pallino, mai la
  // parola della riga.
  return {
    working: session.working === true,
    stato: 'ignoto',
    subtitle: presenza,
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
// Una lista e' PARZIALE quando non e' una lettura completa: sessioni non lette, oppure fleet illeggibile e nessun
// elenco di celle da mostrare. Su una lista parziale il riordino e' bloccato (motivo dichiarato), perche' l'ordine
// va deciso sull'elenco intero.
export function partialReason({ sessionsOk = true, fleetStale = false, cellCount = 0 } = {}) {
  if (!sessionsOk) return 'sessions';
  if (fleetStale && !cellCount) return 'fleet';
  return null;
}

export function buildLocalRoster(cells, unmanaged, byName, storage = globalThis.localStorage, { autorevole = true, fleetStale = false } = {}) {
  const partial = partialReason({ sessionsOk: autorevole, fleetStale, cellCount: Array.isArray(cells) ? cells.length : 0 });
  return withPartial([
    ...(Array.isArray(cells) ? cells : []).map((c) => {
      const session = byName.get(c.tmuxSession) || {};
      const key = positionKey([], c.tmuxSession);
      const runtime = cellRuntime(c, session, { autorevole, fleetStale });
      return {
        type: 'cell', value: c, key, label: c.cell, live: !!c.tmux,
        fresh: hasFreshOutput(session, key, storage), activity: session.activity || 0,
        working: runtime.working, stato: runtime.stato, subtitle: runtime.subtitle,
        // L'etichetta NC viaggia nel campo SUO: il rendering la mostra accanto
        // allo stato, mai dentro il suo testo.
        ncControl: runtime.ncControl, ncControlLabel: runtime.ncControlLabel,
        // La consegna del prompt viaggia ACCANTO allo stato: la riga della cella
        // resta quella che era, e nessuna delle due riscrive l'altra.
        prompt: promptDeliveryBadge(c, { currentLaunchId: c.launchId || null, autorevole: autorevole && !fleetStale, preserved: c.preserved === true }),
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
  ], partial);
}

const withPartial = (items, partial) => (partial ? items.map((item) => ({ ...item, partial })) : items);

// Costruisce le righe normalizzate di una posizione remota (gruppo nodo):
// celle Fleet (attive e inattive) + tmux unmanaged. Ritorna { route, rawItems }
// cosicche' la shell possa derivarne nodeRoute/groupView/items con la propria
// vista e il proprio ordine (e, sul mobile, il filtro ricerca).
export function buildRemoteRoster(group, storage = globalThis.localStorage) {
  const g = group || {};
  const route = Array.isArray(g.route) ? g.route : [];
  const autorevole = sessionsAuthoritative(g);
  // Un elenco dichiarato fermo non e' una lettura corrente, anche se le
  // sessioni arrivano: e' l'ultimo dato noto che l'owner conserva.
  const fleetStale = g.fleetState === 'stale';
  const remoteByName = new Map((g.sessions || []).map((s) => [s.name, s]));
  const rawItems = [
    ...(g.cells || []).map((c) => {
      const session = remoteByName.get(c.tmuxSession) || {};
      const key = positionKey(route, c.tmuxSession || c.cell);
      const runtime = cellRuntime(c, session, { autorevole, fleetStale });
      return {
        // preserved: cella di un elenco fermo (nodo non raggiungibile) — non
        // e' "live" nemmeno se l'ultima sessione tmux era attiva: drag, click,
        // filtri "attive" devono trattarla come spenta.
        type: 'cell', value: c, key, label: c.cell, live: !!c.tmux && !c.preserved,
        fresh: hasFreshOutput(session, key, storage), activity: session.activity || c.activity || 0,
        working: runtime.working, stato: runtime.stato, subtitle: runtime.subtitle,
        // L'etichetta NC viaggia nel campo SUO: il rendering la mostra accanto
        // allo stato, mai dentro il suo testo.
        ncControl: runtime.ncControl, ncControlLabel: runtime.ncControlLabel,
        // La consegna del prompt viaggia ACCANTO allo stato: la riga della cella
        // resta quella che era, e nessuna delle due riscrive l'altra.
        prompt: promptDeliveryBadge(c, { currentLaunchId: c.launchId || null, autorevole: autorevole && !fleetStale, preserved: c.preserved === true }),
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
  const partial = partialReason({ sessionsOk: g.sessionsAvailable !== false, fleetStale, cellCount: (g.cells || []).length });
  return { route, rawItems: withPartial(rawItems, partial) };
}

// Foglio di alimentazione (PowerSheet): le evidenze di esecuzione del
// lancio CORRENTE, per owner/route/cella. La copia presa all'apertura può
// restare indietro rispetto all'inventario (cella che parte, lancio che
// cambia mentre il foglio è aperto): si aggiornano i fatti che la lettura
// corrente sa del lancio — presenza, sessione, consegna del prompt,
// supervisione NC — e NON le scelte editabili (engine/modello/policy restano
// quelle dell'apertura: sono dell'operatore, non della lettura). Se la
// cella non è più nell'inventario, la copia d'apertura resta per la UI ma
// non attesta più nulla: lo dichiara powerCellFreshness, e il foglio degrada
// le evidenze di esecuzione invece di presentarne il ricordo come corrente.
export function powerCellEvidence(powerCell, cells, nodeGroups) {
  if (!powerCell) return null;
  const rk = (Array.isArray(powerCell.route) ? powerCell.route : []).join('/');
  const pool = [
    ...(Array.isArray(cells) ? cells : []),
    ...(Array.isArray(nodeGroups) ? nodeGroups : []).flatMap((g) => (g.cells || []).map((c) => ({ ...c, route: g.route || [g.name] }))),
  ];
  const live = pool.find((c) => c.cell === powerCell.cell
    && (Array.isArray(c.route) ? c.route.join('/') : '') === rk);
  if (!live) return powerCell;
  return {
    ...powerCell,
    active: !!live.active,
    tmux: live.tmux,
    tmuxSession: live.tmuxSession,
    degraded: !!live.degraded,
    launchId: live.launchId,
    promptDelivery: live.promptDelivery,
    ncControl: live.ncControl,
    preserved: live.preserved === true,
  };
}

// Autorità della lettura che alimenta il foglio, per route — la stessa
// misura della card (buildLocalRoster/buildRemoteRoster), portata fino al
// foglio: locale legge come il roster locale, remota come il suo gruppo
// nodo. Un elenco dichiarato fermo non attesta nulla di CORRENTE, e un
// gruppo sparito dall'inventario è, a tutti gli effetti, l'ultimo dato noto.
// Vale anche per la CELLA: una lettura riuscita e corrente che non la
// contiene più dice, della cella, più di quanto ne sapesse lo snapshot
// d'apertura — lo snapshot resta per la UI ma la lettura non lo attesta,
// e il foglio degrada prompt e supervisione NC invece di mostrarli correnti.
export function powerCellFreshness(powerCell, { localAutorevole = true, localFleetStale = false, cells = null, nodeGroups = [] } = {}) {
  if (!powerCell) return { autorevole: true, fleetStale: false };
  const route = Array.isArray(powerCell.route) ? powerCell.route : [];
  if (!route.length) {
    // Solo una lettura locale RIUSCITA e corrente può dire «non c'è più»:
    // un elenco conservato (lettura caduta o fermata) non lo sa, e resta
    // dichiarato per quello che è.
    const assente = Array.isArray(cells)
      && !!localAutorevole && !localFleetStale
      && !cells.some((c) => c.cell === powerCell.cell);
    if (assente) return { autorevole: false, fleetStale: true };
    return { autorevole: !!localAutorevole, fleetStale: !!localFleetStale };
  }
  const rk = route.join('/');
  const g = (Array.isArray(nodeGroups) ? nodeGroups : [])
    .find((n) => (Array.isArray(n.route) ? n.route.join('/') : '') === rk);
  if (!g) return { autorevole: false, fleetStale: true };
  // Gruppo vivo ma cella sparita dal SUO inventario corrente: la posizione
  // c'è ancora, la cella no — lo snapshot d'apertura non si attesta su di
  // un elenco che la cella non abita più.
  const presente = (Array.isArray(g.cells) ? g.cells : []).some((c) => c.cell === powerCell.cell);
  if (!presente) return { autorevole: false, fleetStale: true };
  return { autorevole: sessionsAuthoritative(g), fleetStale: g.fleetState === 'stale' };
}
