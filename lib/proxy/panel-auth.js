'use strict';
// lib/proxy/panel-auth.js — l'ingresso al pannello: ticket monouso + cookie di visione.
//
// Perche' esiste (misurato, non ipotizzato — vedi la misura dell'iframe che
// non puo' autenticarsi, 2026-08-15): un `<iframe src>` e' una navigazione del
// browser e non porta header applicativi. Il proxy del pannello sta dietro
// requireToken, che accetta solo `Authorization: Bearer`: l'unico
// consumatore previsto non puo' entrare. E accettare il token in query non
// basterebbe: la pagina del pannello chiede le proprie risorse con URL
// relativi, senza query — cadrebbero tutte, e il frame resterebbe bianco.
//
// Il disegno, in quattro punti che sono vincoli e non preferenze:
//
// 1. IL TICKET NON E' IL TOKEN DEL NODO. Lo chiede la PWA, che e' gia'
//    autenticata col Bearer; e' opaco, monouso, vive pochi secondi e vale per
//    UNA cella. Il token del nodo non deve finire nella cronologia del
//    browser, nei log del proxy o in un Referer.
// 2. IL TICKET SI CONSUMA ALLA PRIMA RICHIESTA e la risposta imposta un cookie
//    HttpOnly SameSite Strict con `Path=/api/panel/<cella>` — ESATTAMENTE quel
//    path, perche' le sotto-risorse relative passino e nient'altro.
// 3. IL COOKIE NON E' UN'AUTENTICAZIONE DELL'ORIGINE. Il progetto non ne ha
//    una, e introdurla aprirebbe CSRF su tutte le altre route: qui si verifica
//    SEMPRE che il cookie sia stato emesso per la cella del path, e lo scope
//    stretto e' presidiato dai test — un cookie con Path piu' largo o un
//    ticket riusabile devono FAR FALLIRE un test, non passare inosservati.
// 4. NIENTE CREDENZIALI VERSO IL PANNELLO: il cookie non viene inoltrato
//    upstream (lo strip fa' panel-proxy, come l'Authorization), e `Referer`
//    va tolto dagli header inoltrati insieme agli altri.

// 5. IL BEARER DEL NODO NON VALE SULLA VIA FEDERATA. L'ultimo hop rientra
//    nell'API locale col Bearer locale e da li' in poi e' indistinguibile
//    dalla PWA: senza questo confine il contenuto del pannello esce verso
//    ogni peer con `panelAccess`, senza che nessuno abbia mai preso un
//    ticket. La prova di hop (lib/proxy/hop-proof.js) e' cio' che distingue
//    le due provenienze. Chiuso il 2026-08-15; i due casi cattivi stanno in
//    tests/panel-auth-live.test.js e devono restare l'unico modo di provarlo.

const crypto = require('node:crypto');
const { CELL_ID_RE } = require('../live-host/store.js');
const { validPanelUrl } = require('../fleet/definitions.js');
const { verifyHop, HOP_HEADER } = require('./hop-proof.js');

const VISITED_HEADER = 'x-nexuscrew-visited';

const TICKET_TTL_MS = 30 * 1000;         // "pochi secondi": la vita di un redirect iframe
const COOKIE_TTL_MS = 60 * 60 * 1000;    // una sessione di visione
const COOKIE_NAME = 'npanel';

// Ticket e cookie non si confrontano: si CERCANO per chiave in una Map, e il
// valore e' un segreto casuale da 256 bit. Non c'e' quindi un compare da
// rendere costante — una funzione che lo promettesse senza avere chiamanti
// sarebbe una garanzia scritta e mai mantenuta.
function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// `<cella>` da `/api/panel/<cella>/<rest>` (o `/panel/...` gia' smontato).
function cellFromPanelPath(url) {
  const raw = String(url || '');
  const pathname = raw.slice(0, raw.indexOf('?') === -1 ? raw.length : raw.indexOf('?'));
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first) return null;
  try { return decodeURIComponent(first); } catch (_) { return null; }
}

function createPanelAuth({
  verifyToken,                       // (value) => bool, sul token del nodo
  resolveCellPanel,                  // (cellId) => Promise<panelUrl|null|undefined|''>
  now = () => Date.now(),
  ticketTtlMs = TICKET_TTL_MS,
  cookieTtlMs = COOKIE_TTL_MS,
  hopSecret = null,                  // () => Buffer|string|null, segreto per-processo
  log = () => {},
} = {}) {
  const tickets = new Map();   // ticket -> { cell, exp }
  const cookies = new Map();   // cookieToken -> { cell, exp }

  // —— Da dove arriva questa richiesta? La risposta decide se il Bearer del
  // NODO vale, e non e' una preferenza: e' il confine descritto al punto 5.
  //
  // Tre esiti, e il terzo e' fail-closed:
  //   'locale'   — nessun header di hop: il Bearer vale come e' sempre valso.
  //   'federata' — hop VERIFICATA: la richiesta e' l'ultimo salto di una route
  //                federata. Il Bearer qui e' quello che il proxy ha iniettato
  //                da se', quindi non prova nulla su CHI guarda: per vedere il
  //                pannello servono il ticket o il cookie emessi da QUESTO nodo.
  //   'sospetta' — header presente ma non verificabile (segreto assente, catena
  //                vuota, firma che non torna). Non si indovina: si rifiuta.
  //
  // La catena `visited` serve solo a ricostruire il messaggio firmato: qui
  // interessa RILEVARE il transito, non attribuirne l'origine — quello e' il
  // mestiere di lib/audio/origin.js, che infatti la valida anche contro il
  // nodo locale.
  function hopKind(req) {
    const headers = (req && req.headers) || {};
    const proof = headers[HOP_HEADER];
    if (!proof) return 'locale';
    const secret = typeof hopSecret === 'function' ? hopSecret() : hopSecret;
    if (!secret) return 'sospetta';
    const visited = String(headers[VISITED_HEADER] || '').split(',').filter(Boolean);
    if (!visited.length) return 'sospetta';
    // Il path firmato e' quello con cui la richiesta e' ENTRATA nell'API
    // (`/api/panel/...`), non il resto che il mount di express lascia in
    // req.url: sotto un `use('/api/panel')` i due differiscono.
    const path = req.originalUrl || req.url;
    const ok = verifyHop(secret, { method: req.method || 'GET', path, visited }, proof);
    return ok ? 'federata' : 'sospetta';
  }

  function sweep() {
    const t = now();
    for (const [k, rec] of tickets) if (rec.exp <= t) tickets.delete(k);
    for (const [k, rec] of cookies) if (rec.exp <= t) cookies.delete(k);
  }

  function issueTicket(cellId) {
    sweep();
    const ticket = newSecret();
    tickets.set(ticket, { cell: cellId, exp: now() + ticketTtlMs });
    return ticket;
  }

  // Monouso VERO: il biglietto si strappa anche se il controllo fallisce —
  // scaduto, cella sbagliata o gia' usato sono indistinguibili dal di fuori,
  // e nessuno dei tre lascia ritentare con lo stesso valore.
  function consumeTicket(ticket, cellId) {
    sweep();
    const rec = tickets.get(ticket);
    if (!rec) return false;
    tickets.delete(ticket);
    return rec.exp > now() && rec.cell === cellId;
  }

  function issueCookie(cellId) {
    const value = newSecret();
    cookies.set(value, { cell: cellId, exp: now() + cookieTtlMs });
    return value;
  }

  function verifyCookie(value, cellId) {
    sweep();
    const rec = cookies.get(value);
    return !!rec && rec.exp > now() && rec.cell === cellId;
  }

  function cookieHeaderValue(cellId, value) {
    const attrs = [
      `${COOKIE_NAME}=${value}`,
      `Path=/api/panel/${encodeURIComponent(cellId)}`,
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(cookieTtlMs / 1000)}`,
    ];
    return attrs.join('; ');
  }

  // —— Emissione: POST /api/panel/<cella>/ticket, SOLO per la PWA autenticata.
  // La cella deve esistere ed avere un pannello valido: nessun ticket per
  // destinazioni che il proxy rifiuterebbe comunque.
  async function handleTicketRequest(req, res, cellId) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(bearer)) {
      log({ event: 'panel-auth', outcome: 'ticket-denied', reason: 'unauthorized', cell: cellId });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let panelUrl;
    try { panelUrl = await resolveCellPanel(cellId); } catch (_) { panelUrl = null; }
    if (panelUrl === null || panelUrl === undefined || panelUrl === '' || !validPanelUrl(panelUrl)) {
      log({ event: 'panel-auth', outcome: 'ticket-denied', reason: 'no-panel', cell: cellId });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'pannello non disponibile' }));
      return;
    }
    const ticket = issueTicket(cellId);
    log({ event: 'panel-auth', outcome: 'ticket-issued', cell: cellId });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ticket, cell: cellId, expiresInSeconds: Math.floor(ticketTtlMs / 1000) }));
  }

  // —— Il middleware: decide CHI entra nel proxy, e imposta il cookie quando
  // e' la prima richiesta dell'iframe (quella col ticket).
  //
  // Tre chiavi, in ordine di chi le usa:
  //   Bearer        — la PWA e le probe esistenti: tutto come prima.
  //   ?ticket=      — l'iframe al primo ingresso: monouso, consumato ADESSO,
  //                   e la risposta porta il cookie di visione.
  //   Cookie        — le sotto-risorse (URL relativi, senza query): il cookie
  //                   vale solo per la cella del path.
  function panelAuthMiddleware(req, res, next) {
    const url = String(req.url || '');
    const cellId = cellFromPanelPath(url);
    if (!cellId || !CELL_ID_RE.test(cellId)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'pannello non trovato' }));
      return;
    }
    const provenienza = hopKind(req);
    if (provenienza === 'sospetta') {
      log({ event: 'panel-auth', outcome: 'denied', reason: 'hop-non-verificabile', cell: cellId });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const pathname = url.slice(0, url.indexOf('?') === -1 ? url.length : url.indexOf('?'));
    const tail = pathname.split('/').filter(Boolean).slice(1);
    // L'emissione del ticket e' l'UNICA operazione con body semantico ed e'
    // gestita qui, perche' sta prima di ogni requireToken: /panel/<cella>/ticket.
    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'ticket') {
      void handleTicketRequest(req, res, cellId);
      return;
    }

    // Il ticket ha PRECEDENZA sul Bearer: la richiesta federata dell'iframe
    // arriva qui con il Bearer dell'hop (il token del nodo, iniettato dalla
    // via federata) ACCANTO al ticket in query — e deve entrare da iframe,
    // consumando il ticket e prendendo il cookie, non da PWA. Chi porta un
    // ticket sta facendo l'ingresso del frame; la PWA non lo mette mai in query.
    let qTicket = null;
    const qi = url.indexOf('?');
    if (qi !== -1) qTicket = new URLSearchParams(url.slice(qi + 1)).get('ticket');
    if (qTicket) {
      if (consumeTicket(qTicket, cellId)) {
        const value = issueCookie(cellId);
        res.setHeader('set-cookie', cookieHeaderValue(cellId, value));
        log({ event: 'panel-auth', outcome: 'ticket-consumed', cell: cellId });
        return next();
      }
      log({ event: 'panel-auth', outcome: 'denied', reason: 'ticket-invalid', cell: cellId });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'ticket non valido' }));
      return;
    }

    // Il Bearer apre il pannello SOLO da locale. Sulla via federata e' il
    // token che il proxy ha iniettato da se' un istante prima: accettarlo
    // significherebbe che chiunque raggiunga la route — e la route del
    // pannello transita prima del requireToken, perche' un iframe non porta
    // header — si porta via il contenuto. Di la' restano il ticket e il
    // cookie, che questo nodo ha emesso e sa riconoscere.
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provenienza === 'locale' && verifyToken(bearer)) return next();

    const cookieValue = parseCookieHeader(req.headers.cookie)[COOKIE_NAME];
    if (cookieValue && verifyCookie(cookieValue, cellId)) return next();

    log({
      event: 'panel-auth', outcome: 'denied', cell: cellId,
      reason: provenienza === 'federata' ? 'federated-needs-ticket' : 'unauthorized',
    });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  // —— Auth per l'upgrade WebSocket del pannello. Le WS del pannello partono
  // dalla pagina dentro il frame e portano il cookie della NOSTRA origine
  // (same-site): il cookie di visione deve aprirle, altrimenti il pannello
  // carica l'HTML e resta nero. Il Bearer e il ?token= della PWA restano
  // validi come prima. Il ticket in query NON si usa qui: il flusso dell'iframe
  // ha gia' il cookie quando la pagina apre la sua prima socket.
  //
  // Lo stesso confine dell'HTTP vale QUI, e va scritto qui: l'upgrade non
  // passa dal middleware — forwardUpgrade e' un percorso separato — e per un
  // pannello e' la porta che conta, perche' i frame arrivano da questa.
  function authorizeUpgrade(req) {
    const url = String(req.url || '');
    const provenienza = hopKind(req);
    if (provenienza === 'sospetta') return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provenienza === 'locale' && verifyToken(bearer)) return true;
    const qi = url.indexOf('?');
    if (provenienza === 'locale' && qi !== -1
      && verifyToken(new URLSearchParams(url.slice(qi + 1)).get('token') || '')) return true;
    const cellId = cellFromPanelPath(url.replace(/^\/api\/panel/, ''));
    if (!cellId) return false;
    const cookieValue = parseCookieHeader(req.headers.cookie)[COOKIE_NAME];
    return !!(cookieValue && verifyCookie(cookieValue, cellId));
  }

  return {
    panelAuthMiddleware,
    authorizeUpgrade,
    // Per test e diagnostica: verifiche dall'esterno senza passare dal wire.
    consumeTicketForTest: consumeTicket,
    verifyCookieForTest: verifyCookie,
    issueCookieForTest: issueCookie,
    cookieHeaderValueForTest: cookieHeaderValue,
  };
}

module.exports = {
  createPanelAuth,
  TICKET_TTL_MS,
  COOKIE_TTL_MS,
  COOKIE_NAME,
};
