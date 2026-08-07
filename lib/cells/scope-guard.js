'use strict';
// lib/cells/scope-guard.js — il punto in cui lo scope celle diventa effettivo.
//
// Sta in testa al router /api perche' i canali da cui una cella puo' trapelare
// sono tredici, e un permesso che vale su dodici di essi non e' un permesso:
// e' un'etichetta. Gli elenchi (cosa esce) e le azioni (cosa si puo' toccare)
// passano dallo stesso predicato di lib/cells/scope.js.
//
// Due scelte deliberate:
//
//  * il bersaglio di ogni route e' DICHIARATO in una tabella, non indovinato.
//    Una regola magica sbaglia in silenzio quando qualcuno aggiunge una route;
//    un elenco esplicito, quando qualcuno lo dimentica, fa scattare la rete di
//    sicurezza qui sotto.
//  * fail-closed sulle route sconosciute che nominano una cella: se un corpo
//    porta `cell`, `to.cell` o `session` e la route non e' dichiarata, si nega.
//    E' l'unico modo perche' una route aggiunta domani non nasca scoperta.
const { createCellScope } = require('./scope.js');


// Chiavi da cui, in una RISPOSTA, esce un elenco di celle o di sessioni.
// Coprono /cells, /fleet/status, /fleet/definitions, /sessions.
const CELL_LIST_KEYS = ['cells'];
const SESSION_LIST_KEYS = ['sessions', 'unmanaged'];

// I deck sono il quarto elenco, e non lo sembrava: non contengono celle ne'
// sessioni sotto quei nomi, ma TILE, e ogni tile porta il nome della sessione
// tmux. Filtrare tre chiavi su quattro lasciava passare a un peer ristretto
// l'esistenza e il nome di ogni cella dell'hub — non il contenuto, ma la mappa.
// Trovato dall'audit indipendente di NC-E, non da questo codice.
function filterDecks(decks, scope) {
  if (!Array.isArray(decks)) return decks;
  const out = [];
  for (const deck of decks) {
    const layout = deck && deck.layout;
    const columns = Array.isArray(layout && layout.columns) ? layout.columns : null;
    // Forma inattesa: non si inventa un filtro su una struttura che non si
    // riconosce. Meglio lasciarla passare qui e vederla rompere un test, che
    // svuotarla in silenzio.
    if (!columns) { out.push(deck); continue; }
    const kept = [];
    for (const column of columns) {
      const tiles = Array.isArray(column && column.tiles)
        ? column.tiles.filter((tile) => scope.allowsTile(tile))
        : [];
      if (tiles.length) kept.push({ ...column, tiles });
    }
    // Un deck rimasto senza tile era fatto solo di celle non concesse: sparisce
    // invece di comparire vuoto, che sarebbe la stessa rivelazione in negativo.
    if (kept.length) out.push({ ...deck, layout: { ...layout, columns: kept } });
  }
  return out;
}

// Route che AGISCONO su una cella o su una sessione, con il punto esatto in cui
// leggere il bersaglio. `null` = la route e' nota e non ha un bersaglio cella.
function declaredTarget(req) {
  const p = req.path || '';
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const q = req.query || {};

  // Azioni sul ciclo di vita di una cella: il bersaglio e' `body.cell`.
  if (/^\/fleet\/(up|down|restart|engine|boot)$/.test(p)) return { cell: b.cell };
  // Definire/modificare/rimuovere celle e' una capacita' a se': chi ha uno
  // scope ristretto non deve poter creare la cella che gli manca.
  if (/^\/fleet\/(define-cell|edit-cell|remove-cell|restore-cells|import-cell)$/.test(p)) return { deny: 'scope-cannot-define-cells' };
  // Messaggio a una cella: il bersaglio e' dichiarato due volte, e devono
  // valere entrambe (il codice a valle le confronta gia' fra loro).
  if (p === '/cells/send') return { cell: b.to && b.to.cell, session: b.to && b.to.tmuxSession };
  // Sessioni: creazione, eliminazione, visibilita', file.
  if (p === '/sessions' && req.method === 'POST') return { session: b.name };
  if (/^\/sessions\/[^/]+/.test(p)) return { session: decodeURIComponent(p.split('/')[2] || '') };
  if (p === '/files' || p.startsWith('/files/')) return { session: q.session || b.session };
  // Route note che NON agiscono su una cella: la notifica arriva all'operatore
  // e la voce passa dal suo ACL per-nodo (lib/audio/acl.js). Vanno dichiarate
  // esplicitamente, altrimenti la rete di sicurezza qui sotto le scambia per
  // route dimenticate — cosa che e' successa davvero: entrambe portano
  // `originCell`, che e' la PROVENIENZA attestata dal server, non un bersaglio.
  if (p === '/notify' || p.startsWith('/notify/')) return null;
  if (p === '/audio' || p.startsWith('/audio/')) return null;
  return undefined; // route non dichiarata
}

// Rete di sicurezza: un corpo che nomina una cella o una sessione su una route
// non dichiarata. Meglio un 403 su qualcosa di legittimo — che si nota subito e
// si aggiunge alla tabella — di un canale aperto che nessuno vede.
//
// La prima versione elencava sei chiavi esatte (`cell`, `session`,
// `tmuxSession`, `to.cell`, `to.tmuxSession`, `?session`) e l'audit ha mostrato
// il limite: una route dimenticata che chiama il suo bersaglio `cellId` passava
// liscia. Si riconosce quindi la FORMA del nome — qualunque chiave che parli di
// celle o di sessioni — invece di un elenco che invecchia a ogni sinonimo.
//
// Limite residuo, dichiarato invece che nascosto: un bersaglio chiamato `name`
// o `target` non e' riconoscibile senza sapere quali celle esistono, e negare
// ogni `name` renderebbe la rete di sicurezza un muro. Le route reali che
// agiscono su una cella sono tutte nella tabella qui sopra; questa e' la
// seconda linea, non la prima.
const TARGET_KEY_RE = /cell|session/i;
// Una chiave che dichiara da DOVE viene la richiesta non e' un bersaglio, ed e'
// il caso che ha fatto scattare la rete di sicurezza su /notify e /audio/speak:
// il loro corpo federato porta `originCell`, scritto dal server come
// provenienza attestata. Negarlo bloccava due funzioni sane per ogni peer
// ristretto. La provenienza si controlla altrove — dalla catena `visited`, che
// il peer non puo' scrivere — e qui non va nemmeno guardata.
const ORIGIN_KEY_RE = /^(origin|from|sender|source)/i;

function scanTargets(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || !value) continue;
    if (ORIGIN_KEY_RE.test(key)) continue;
    if (TARGET_KEY_RE.test(key)) return value;
  }
  return null;
}

function undeclaredTarget(req) {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const q = req.query || {};
  // `to` e' il solo annidamento noto (il destinatario di /cells/send); piu' a
  // fondo non si scende: un corpo arbitrariamente profondo diventerebbe una
  // scansione senza fine su ogni richiesta federata.
  const named = scanTargets(b) || scanTargets(b.to) || scanTargets(q);
  return named ? { target: named } : null;
}

function filterPayload(payload, scope) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = { ...payload };
  for (const key of CELL_LIST_KEYS) {
    if (Array.isArray(out[key])) out[key] = scope.filterCells(out[key]);
  }
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(out[key])) out[key] = scope.filterSessions(out[key]);
  }
  if (Array.isArray(out.decks)) out.decks = filterDecks(out.decks, scope);
  if (Array.isArray(out.records)) out.records = filterRecords(out.records, scope);
  return out;
}

// I record diagnostici (/diagnostics/logs, federata in lettura) portano
// `meta.cell`: il quinto canale, e di nuovo non somigliava a un elenco di
// celle. Un record che NON nomina una cella passa: lo scope celle governa le
// celle, e i diagnostici di sistema non appartengono a nessuna. Il resto del
// record e' gia' bounded per contratto — i diagnostici rifiutano contenuto
// grezzo di terminale — quindi qui basta il bersaglio dichiarato.
function filterRecords(records, scope) {
  return records.filter((entry) => {
    const cell = entry && entry.meta && entry.meta.cell;
    if (typeof cell !== 'string' || !cell) return true;
    return scope.allowsCell(cell);
  });
}

// Parser JSON usato SOLO sulle richieste federate. Non si puo' montare un
// parser globale: le route locali catturano `rawBody` con `verify` per la firma
// del bridge, e `verify` non viene chiamato se il corpo e' gia' stato
// consumato; inoltre i limiti di dimensione per-route (16kb per notify, 8kb per
// i comandi VL) verrebbero saltati, perche' express.json esce subito quando
// `req.body` esiste gia'. Le richieste locali devono arrivare INTATTE ai loro
// parser.
function federatedBodyParser(limit) {
  const parse = require('express').json({ limit });
  return (req, res, next) => {
    if (req.body !== undefined) return next();
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return next();
    return parse(req, res, () => next());
  };
}

function createCellScopeGuard({
  nodesPath, loadStoreImpl, cellForSession,
  // resolveOrigin(req) -> {ok, trust, visited}. In produzione e' l'origin
  // resolver basato sulla prova di hop; nei test e' un seam, cosi' questo
  // modulo prova il GUARD e non di nuovo la firma (che ha i suoi test).
  resolveOrigin,
  bodyLimit = '1mb',
} = {}) {
  const scoper = createCellScope({ nodesPath, loadStoreImpl, cellForSession });
  const parseFederatedBody = federatedBodyParser(bodyLimit);

  return async function cellScopeGuard(req, res, next) {
    let origin;
    try {
      origin = await resolveOrigin(req);
    } catch (_) {
      origin = null;
    }
    // Un hop che non verifica NON e' una richiesta federata, e questo guard non
    // e' il posto dove deciderne l'esito: le route che sanno rifiutarlo lo
    // fanno gia' con il loro codice (401 su audio, non 403), e sostituirlo qui
    // cambierebbe una risposta di sicurezza esistente senza migliorarla.
    // Non e' nemmeno una scappatoia: `cleanHeaders` cancella gli header di hop
    // in ingresso e il proxy li riscrive lui, quindi un peer non puo' ne'
    // toglierli ne' falsificarli. Chi puo' inventarne uno possiede gia' il
    // Bearer locale — e' il proprietario della macchina, che non si limita da
    // solo.
    if (!origin || origin.ok !== true) return next();
    if (origin.trust !== 'federated') return next();

    const scope = scoper.resolve({ trust: 'federated', visited: origin.visited });
    req.cellScope = scope;
    if (scope.mode === 'all') return next();

    // Il bersaglio di molte azioni sta nel corpo: qui, e solo per le federate,
    // va parsato prima di poterlo guardare.
    return parseFederatedBody(req, res, () => applyScope(req, res, next, scope));
  };

  function applyScope(req, res, next, scope) {
    // --- azioni ---------------------------------------------------------
    const declared = declaredTarget(req);
    if (declared === undefined) {
      const sneaky = undeclaredTarget(req);
      if (sneaky) {
        return res.status(403).json({ error: 'route non dichiarata per lo scope celle', reason: 'undeclared-cell-route' });
      }
    } else if (declared) {
      if (declared.deny) return res.status(403).json({ error: 'fuori dallo scope celle', reason: declared.deny });
      if (declared.cell !== undefined && !scope.allowsCell(declared.cell)) {
        return res.status(403).json({ error: 'fuori dallo scope celle', reason: 'cell-not-granted' });
      }
      if (declared.session !== undefined && !scope.allowsSession(declared.session)) {
        return res.status(403).json({ error: 'fuori dallo scope celle', reason: 'session-not-granted' });
      }
    }

    // --- letture --------------------------------------------------------
    // Si avvolge res.json invece di riscrivere ogni handler: gli elenchi sono
    // quattro e crescono, e un handler nuovo nascerebbe scoperto.
    const json = res.json.bind(res);
    res.json = (payload) => json(filterPayload(payload, scope));
    return next();
  }
}

module.exports = { createCellScopeGuard, declaredTarget, filterPayload, filterDecks, filterRecords };
