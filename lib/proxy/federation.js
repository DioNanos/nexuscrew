'use strict';

const http = require('node:http');
const net = require('node:net');
const express = require('express');
const store = require('../nodes/store.js');
const topologyCache = require('../nodes/topology-cache.js');
const reverseRotation = require('../nodes/reverse-rotation.js');
const { bearerFrom } = require('../auth/middleware.js');
const { safeEqual } = require('../nodes/peering.js');
const { probeReverseSlot } = require('../nodes/reverse-slot-proof.js');
const {
  sanitizeRequestHeaders, sanitizeResponseHeaders, stripLocalTokenQuery,
} = require('./node-proxy.js');
const { signHop, HOP_HEADER } = require('./hop-proof.js');

const MAX_HOPS = 4;
const ROUTE_DELIMITER = '_';
const TOPOLOGY_PEER_TIMEOUT_MS = 1500;
// Finestra di attesa del reverse channel su Share ON: limitata per non
// diventare un retry storm, ma sufficiente al bind subito dopo un pairing.
const SHARE_HEALTH_ATTEMPTS = 10;
const SHARE_HEALTH_DELAY_MS = 300;
const SHARE_NOT_READY_CODE = 'share-channel-not-ready';
// 500/502/503/504 sono indisponibilita' che passano; 501 e 505 no.
const TRANSIENT_HTTP_STATUS = new Set([500, 502, 503, 504]);
// Esiti della prova di slot che significano "non ottenuta" e non "sbagliata".
const SLOT_PROOF_UNAVAILABLE = 'reverse-slot-proof-unavailable';

// Classificazione dell'esito di Share ON. La regola e' fail-closed sul
// RITENTATIVO: e' ritentabile solo cio' che e' dimostrabilmente transitorio —
// il canale non ancora salito. Tutto il resto (credenziale non valida, nodo
// sbagliato in fondo al tunnel, prova di slot non corrispondente) e' un guasto
// che il tempo non ripara, e ritentarlo nasconde all'operatore la vera causa.
function classifyShareFailure(health) {
  const detail = (health && health.detail) || 'reverse SSH non pronto';
  if (!health) return { code: 'share-peer-unreachable', detail };
  // Credenziale non valida: serve un re-pair, il tempo non la ripara.
  if (health.auth === 'failed') return { code: 'share-peer-unauthorized', detail };
  if (health.slotProof === true) {
    // Attenzione: `probeReverseSlot` marca "non posseduta" anche quando la
    // prova non e' stata OTTENUTA — timeout, connessione rifiutata, risposta
    // non 200 — che e' un canale non ancora su, non una prova sbagliata.
    // Confonderli renderebbe finale proprio il caso che vogliamo attendere.
    return health.code === SLOT_PROOF_UNAVAILABLE
      ? { code: SHARE_NOT_READY_CODE, detail }
      : { code: 'share-slot-proof-failed', detail };
  }
  if (health.transport === 'down') return { code: SHARE_NOT_READY_CODE, detail };
  // Il peer risponde ma con un errore server: indisponibilita' temporanea, non
  // il nodo sbagliato in fondo al tunnel. Allowlist esplicita invece di "ogni
  // 5xx": 501 e 505 dicono che quella richiesta non sara' MAI servita, e
  // ritentarle sarebbe rumore.
  if (TRANSIENT_HTTP_STATUS.has(health.httpStatus)) {
    return { code: SHARE_NOT_READY_CODE, detail };
  }
  // Qui il peer ha risposto 200 ma non e' quello atteso (instanceId o payload):
  // ritentare non lo trasforma nel nodo giusto.
  if (health.reachability === 'failed') return { code: 'share-peer-mismatch', detail };
  return { code: 'share-peer-unreachable', detail };
}

// Porta del canale reverse realmente in gioco, vista DALL'HUB: lo slot attivo
// del pool quando c'e', altrimenti la `localPort` del peer — che e' il punto
// su cui l'hub sonda davvero (cfr. nodes test, ramo inbound). NON
// `reversePort`: quello e' il campo negoziato che vive sul CLIENT, e sull'hub
// e' assente. Il test del comportamento ha trovato questo scambio; il valore
// e' il dato che manca per capire un rifiuto, quindi sbagliarlo lo renderebbe
// peggio che inutile, mandando a cercare sulla porta sbagliata.
function activeReversePort(peer) {
  const pool = peer && peer.reversePool;
  if (pool && Array.isArray(pool.slots)) {
    const slot = pool.slots[pool.activeSlot];
    if (slot && Number.isInteger(slot.port)) return slot.port;
  }
  return peer && Number.isInteger(peer.localPort) ? peer.localPort : null;
}

function peerFromToken(nodesPath, token) {
  const st = store.loadStore(nodesPath);
  if (!st || !token) return null;
  return st.nodes.find((n) => n.acceptToken && safeEqual(n.acceptToken, token)) || null;
}

function peerAllows(peer, otherId) {
  if (!peer) return true;
  if (peer.visibility === 'network') return true;
  if (peer.visibility === 'relay-only') return false;
  return Array.isArray(peer.selected) && peer.selected.includes(otherId);
}

function canTransit(ingress, egress) {
  if (!ingress || !egress || ingress.name === egress.name) return !ingress;
  // `shared` is the explicit publication gate. Visibility remains the hub ACL,
  // but it cannot make a private peer routable on its own.
  return egress.shared === true
    && peerAllows(ingress, egress.nodeId) && peerAllows(egress, ingress.nodeId);
}

function parseRoute(raw) {
  const parts = String(raw || '').split('?')[0].split('/').filter(Boolean);
  const idx = parts.indexOf(ROUTE_DELIMITER);
  // The delimiter cannot occur in a strict peer name, so the first occurrence
  // is authoritative. Resource segments may legitimately be "_" (a valid
  // tmux session name) and must not be mistaken for another boundary.
  if (idx < 0) return null;
  const route = parts.slice(0, idx);
  const resource = `/${parts.slice(idx + 1).join('/')}`;
  if (route.length > MAX_HOPS || route.some((n) => !store.NODE_NAME_RE.test(n))) return null;
  if (new Set(route).size !== route.length || !knownResource(resource)) return null;
  return { route, resource };
}

function knownResource(resource) {
  return resource === '/sessions'
    || /^\/sessions\/[\w.@%:+-]{1,128}(?:\/visibility)?$/.test(resource)
    || resource === '/config'
    || resource === '/fs/dirs'
    || resource === '/files'
    || resource === '/files/download'
    || resource === '/files/upload'
    || resource === '/cells'
    || resource === '/cells/send'
    // VL nodes are federated like every other resource: where you connect, you
    // see everything. That is how NexusCrew works today, and VL nodes are its
    // arms — an unfederated island would break the alignment on purpose.
    //
    // These four were briefly removed on 2026-08-05 over `update_candidate`,
    // which names the URL a device fetches its own update from and accepts
    // `http:`. The removal was wrong on two counts, one absolute and one
    // conditional.
    //
    // Incoherent, always: a paired peer is trusted as its owner
    // (docs/SECURITY.md), and singling out VL nodes made them the only
    // unfederated resource in their own control plane.
    //
    // Ineffective, but ONLY where fleet is available: `/fleet/define-engine` +
    // `/fleet/define-cell` + `/fleet/up` are federated, and a managed shell
    // engine with a raw `commands[shell]` resolves to `bash -lic "<raw>"` — so
    // a peer can already run anything on the host, including a call to these
    // endpoints locally. VL is orthogonal to fleet: on an owner with VL enabled
    // and `/fleet/*` unavailable that path does not exist, and federating these
    // four DOES add capability. It stays within the trust model, so it is not a
    // violation — but do not repeat "it grants nothing" without that condition.
    //
    // `update_candidate` is still a real defect. It belongs to the command, not
    // to this allowlist: bind the update channel to something the receiving
    // owner controls. Fixing it here only hid it.
    || resource === '/vl-nodes'
    || resource === '/vl-nodes/invite'
    || /^\/vl-nodes\/[a-f0-9]{32}(?:\/commands|\/events)?$/.test(resource)
    || resource === '/decks'
    || /^\/decks\/[a-z0-9-]{1,32}$/.test(resource)
    || resource === '/topology'
    || resource === '/diagnostics/status'
    || resource === '/diagnostics/logs'
    || resource === '/diagnostics/verbose'
    // NOTE: `/settings/peering/invite` used to live here, so a connected client
    // could ask its hub to mint a hub-owned invite. It was removed on
    // 2026-08-04. The invite is bound to the HUB's instanceId: whoever consumes
    // it joins the hub, not the peer that asked for it. So any paired node could
    // obtain a live invite and hand it to a third party, and the hub's operator
    // would neither act nor know — trust became transitive without a decision.
    //
    // A paired node is otherwise trusted as its owner (see docs/SECURITY.md),
    // and that is deliberate. This one is different: it is the capability that
    // ADMITS a further node, so leaving it federated would let a peer break the
    // very boundary the owner chose. Minting an invite is done on the hub.
    || resource === '/ws'
    // Un avviso all'operatore attraversa la federazione con la stessa spina
    // dorsale dell'audio: origine provata dalla catena `visited`, ACL del
    // target, budget dedicato. NON e' la coda di NC-NEXT-07 (§5 del modello di
    // autorita'): quella differisce un'esecuzione, questo mostra del testo e
    // non esegue nulla. `/audio/speak` esce da un altoparlante in una stanza
    // fisica ed e' gia' federato: una notifica e' meno invasiva di cosi'.
    || resource === '/notify'
    || resource === '/audio/capability'
    || resource === '/audio/speak'
    || resource === '/audio/speak/status'
    || resource === '/audio/stop'
    // I modelli dichiarati seguono gli engine, perche' sono la stessa cosa
    // vista da un'altra angolazione: un engine gestito NON parte se il suo id
    // di modello non e' nel catalogo, e un modello dichiarato e' cio' che
    // estende quel catalogo. `define-engine` federato + `define-model` locale
    // significava poter creare a distanza un engine che non si puo' rendere
    // avviabile a distanza — un'asimmetria che rompeva la modifica remota a
    // meta' strada, senza proteggere nulla.
    || isPanelResource(resource)
    || /^\/fleet\/(status|schema|definitions|credentials\/status|credentials\/(?:set|remove)|up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-model|remove-model|model-test|define-cell|edit-cell|remove-cell|restore-cells|restore-engines)$/.test(resource);
}

// Il pannello di una cella e' l'unica risorsa federata con un gate PER-PEER a
// default negato, e la ragione e' cosa c'e' dietro: un browser con sessioni gia'
// autenticate. Il resto del modello tratta un peer pairato come l'operatore
// stesso (docs/SECURITY.md), qui no.
//
// Forma: /panel/<cellId>/<path arbitrario>. E' la prima risorsa federata che
// apre un sottoalbero invece di un endpoint chiuso — un pannello serve HTML, JS
// e asset suoi — e proprio per questo il gate va valutato PRIMA dell'allowlist:
// `canTransit` decide chi puo' ATTRAVERSARE questo nodo, non chi puo' aprire un
// pannello.
const PANEL_RESOURCE_RE = /^\/panel\/[A-Za-z0-9._-]{1,32}(?:\/.*)?$/;
function isPanelResource(resource) { return PANEL_RESOURCE_RE.test(resource); }

// `ingress` nullo = richiesta del proprietario di questo nodo (localRouter non
// lo passa mai): nessun gate. Da un peer, serve il permesso esplicito.
function panelAllowedFor(ingress) {
  if (!ingress) return true;
  return ingress.panelAccess === true;
}

function allowedResource(resource, method = 'GET') {
  if (isPanelResource(resource)) return method === 'GET' || method === 'POST';
  if (resource === '/sessions') return method === 'GET' || method === 'POST';
  if (/^\/sessions\/[\w.@%:+-]{1,128}$/.test(resource)) return method === 'DELETE';
  if (/^\/sessions\/[\w.@%:+-]{1,128}\/visibility$/.test(resource)) return method === 'PATCH';
  if (resource === '/config') return method === 'GET';
  if (resource === '/fs/dirs') return method === 'GET';
  if (resource === '/files') return method === 'GET' || method === 'DELETE';
  if (resource === '/files/download') return method === 'GET';
  if (resource === '/files/upload') return method === 'POST';
  if (resource === '/cells') return method === 'GET';
  if (resource === '/cells/send') return method === 'POST';
  if (resource === '/vl-nodes') return method === 'GET';
  if (resource === '/vl-nodes/invite') return method === 'POST';
  if (/^\/vl-nodes\/[a-f0-9]{32}\/commands$/.test(resource)) return method === 'POST';
  // Sola lettura del ring: la conversazione si vede da qualunque peer
  // autorizzato, come ogni altra risorsa. GET e basta — questo canale non
  // deve mai diventare un canale comandi implicito.
  if (/^\/vl-nodes\/[a-f0-9]{32}\/events$/.test(resource)) return method === 'GET';
  if (/^\/vl-nodes\/[a-f0-9]{32}$/.test(resource)) return method === 'DELETE';
  if (resource === '/decks') return method === 'GET' || method === 'POST';
  if (/^\/decks\/[a-z0-9-]{1,32}$/.test(resource)) {
    return method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  }
  if (resource === '/topology') return method === 'GET';
  if (resource === '/diagnostics/status') return method === 'GET';
  if (resource === '/diagnostics/logs') return method === 'GET' || method === 'DELETE';
  if (resource === '/diagnostics/verbose') return method === 'PATCH';
  if (resource === '/ws') return method === 'GET';
  if (/^\/fleet\/(status|schema|definitions|credentials\/status)$/.test(resource)) return method === 'GET';
  // `model-test` e' un POST che non muta niente: interroga il CATALOGO del
  // fornitore (`GET .../models`) con la credenziale di quel nodo e ne ricava un
  // enum. Non genera testo, quindi non consuma token. Resta comunque una
  // mutazione ai fini di READONLY (sotto): un nodo dichiarato di sola lettura
  // non emette richieste autenticate su comando di un peer.
  if (/^\/fleet\/(credentials\/(?:set|remove)|up|down|restart|engine|boot|define-engine|edit-engine|remove-engine|define-model|remove-model|model-test|define-cell|edit-cell|remove-cell|restore-cells|restore-engines)$/.test(resource)) return method === 'POST';
  // Notify: solo POST. `/events`, `/asks` e `/push/*` restano NON federati —
  // SSE non puo' autenticarsi col Bearer e un ask ha un canale di ritorno che
  // e' un paste nel tmux locale, quindi non attraverserebbe comunque.
  if (resource === '/notify') return method === 'POST';
  // Audio: only capability read, speak and stop are exposed through Hydra.
  // audio.consent is a LOCAL mutation and MUST stay unreachable federated.
  if (resource === '/audio/capability') return method === 'GET';
  if (resource === '/audio/speak') return method === 'POST';
  if (resource === '/audio/speak/status') return method === 'POST';
  if (resource === '/audio/stop') return method === 'POST';
  return false;
}

// READONLY blocca ogni mutazione che crea o modifica stato, con due eccezioni
// audio deliberate: interrogare lo status federato usa POST soltanto per
// trasportare l'attestazione della cella, e Stop e' un'azione di sicurezza che
// deve poter zittire un endpoint anche quando quel nodo e' READONLY. Speak
// resta naturalmente bloccato.
function readonlyBlocksFederated(resource, method) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return resource !== '/audio/speak/status' && resource !== '/audio/stop';
}

function allowedQuery(resource, method, rawUrl) {
  if (!resource.startsWith('/diagnostics/')) return true;
  const index = String(rawUrl || '').indexOf('?');
  if (index < 0) return true;
  const raw = String(rawUrl).slice(index + 1);
  if (!raw) return true;
  if (resource !== '/diagnostics/logs' || method !== 'GET') return false;
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (keys.some((key) => !['after', 'limit'].includes(key))) return false;
  if (params.getAll('after').length > 1 || params.getAll('limit').length > 1) return false;
  const after = params.get('after'); const limit = params.get('limit');
  if (after !== null && (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after)))) return false;
  if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) return false;
  return true;
}

function cleanHeaders(headers, credential, visited = null, hopProof = null) {
  const out = sanitizeRequestHeaders(headers, credential);
  for (const key of Object.keys(out)) {
    if (['x-nexuscrew-route', 'x-nexuscrew-visited', 'x-nexuscrew-hop'].includes(key.toLowerCase())) delete out[key];
  }
  if (Array.isArray(visited) && visited.length) out['x-nexuscrew-visited'] = visited.join(',');
  // La prova di hop viene aggiunta DOPO la cancellazione: il canale e' riservato
  // al server, un valore arrivato dal client non sopravvive mai fin qui.
  if (hopProof) out[HOP_HEADER] = hopProof;
  return out;
}

// Riscrittura dei Set-Cookie verso il chiamante locale (il browser della PWA).
// Il pannello remoto emette il cookie di visione con `Path=/api/panel/<cella>`:
// quel path e' GIUSTO sul nodo che lo emette, ma il browser ha richiesto
// `/api/route/<nodi>/_/panel/...` — senza riscrittura il cookie non coprirebbe
// le sotto-risorse dell'iframe remoto e il frame resterebbe bianco con l'aria
// di funzionare. Si riscrive SOLO il prefisso `/api` in `/api/route/<nodi>/_`,
// il resto dell'ambito (per-cella) resta quello deciso dal nodo che lo emette.
function rewriteSetCookiePath(headers, prefix) {
  const raw = headers['set-cookie'];
  if (!raw) return headers;
  const out = { ...headers };
  out['set-cookie'] = (Array.isArray(raw) ? raw : [raw])
    .map((line) => String(line).replace(/([Pp]ath=)\/api\//, `$1${prefix}/`));
  return out;
}

function proxyHttp(req, res, { port, path, credential, visited = null, hopProof = null, setCookiePrefix = null }) {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path, headers: cleanHeaders(req.headers, credential, visited, hopProof) }, (r) => {
    const headers = setCookiePrefix ? rewriteSetCookiePath(r.headers, setCookiePrefix) : r.headers;
    res.writeHead(r.statusCode, sanitizeResponseHeaders(headers)); r.pipe(res);
  });
  up.setTimeout(30000, () => up.destroy());
  up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'peer non raggiungibile' }); else res.destroy(); });
  req.pipe(up);
}

function routeHandler({ nodesPath, localPort, localCredential, ingress = null, readonly = () => false, hopSecret = null }) {
  return (req, res) => {
    const parsed = parseRoute(req.url);
    // Prima dell'allowlist: un peer senza permesso non deve nemmeno sapere se la
    // risorsa esiste per una cella o per un'altra.
    if (parsed && isPanelResource(parsed.resource) && !panelAllowedFor(ingress)) {
      return res.status(403).json({ error: 'pannello non concesso a questo nodo', reason: 'panel-not-granted' });
    }
    if (!parsed || !allowedResource(parsed.resource, req.method)
      || !allowedQuery(parsed.resource, req.method, req.url)) return res.status(404).json({ error: 'not found' });
    if (readonly() && readonlyBlocksFederated(parsed.resource, req.method)) return res.status(403).json({ error: 'READONLY: federated mutation blocked' });
    const st = store.loadStore(nodesPath);
    if (!st) return res.status(503).json({ error: 'node store unavailable' });
    const visited = controlledVisited(req, ingress, st.nodeId);
    if (!visited) return res.status(409).json({ error: 'federation cycle rejected' });
    if (parsed.route.length === 0) {
      // Ultimo hop: la richiesta rientra nell'API locale con il Bearer locale e
      // da li' in poi sarebbe indistinguibile da un POST diretto. La prova di
      // hop e' cio' che la distingue, ed e' legata a metodo, path e catena.
      const path = `/api${parsed.resource}${queryOf(req.url)}`;
      const secret = typeof hopSecret === 'function' ? hopSecret() : hopSecret;
      return proxyHttp(req, res, {
        port: typeof localPort === 'function' ? localPort() : localPort,
        path,
        credential: localCredential(),
        visited,
        hopProof: signHop(secret, { method: req.method, path, visited }),
      });
    }
    const next = st && store.getNode(st, parsed.route[0]);
    const privateInbound = next && next.direction === 'inbound' && next.shared !== true;
    if (!next || !next.token || privateInbound || (ingress && !canTransit(ingress, next))) return res.status(403).json({ error: 'route non consentita' });
    const rest = parsed.route.slice(1);
    const path = `/federation/route/${rest.length ? `${rest.join('/')}/` : ''}${ROUTE_DELIMITER}${parsed.resource}${queryOf(req.url)}`;
    // Verso il browser di questo nodo (ingress nullo) il cookie di visione del
    // pannello va riscritto col prefisso federato che il browser sta usando:
    // vedi rewriteSetCookiePath. Da un peer in transito non si tocca — la
    // riscrittura spetta all'hub dove il browser è collegato.
    const setCookiePrefix = !ingress && isPanelResource(parsed.resource)
      ? `/api/route/${parsed.route.join('/')}/${ROUTE_DELIMITER}`
      : null;
    proxyHttp(req, res, { port: next.localPort, path, credential: next.token, visited, setCookiePrefix });
  };
}

function queryOf(url) {
  const i = String(url).indexOf('?');
  return i < 0 ? '' : stripLocalTokenQuery(String(url).slice(i));
}

// probeHealth: probe federato di un peer verso la sua porta forward locale
// (127.0.0.1:port) autenticato con il token del nodo (Bearer accettato dal
// peerRouter via acceptToken). Modella 3 dimensioni invece di un boolean "up":
//   transport    — la porta TCP risponde (qualcuno e' in ascolto)
//   auth         — la federation accetta la credenziale (200 vs 401)
//   reachability — l'API risponde con payload comprensibile (200 vs 5xx)
// Mai lancia: ogni guasto (refused/timeout/abort) -> {transport:'down',...}.
// Questo e' il cuore del fix "peer localhost risponde in porta ma federation 401":
// il 401 emerge come auth:'failed' con diagnostica esplicita invece di essere
// mascherato da uno stato verde hardcoded.
async function probeHealth({ port, token, expectedInstanceId = null, fetchImpl = fetch, timeoutMs = 1500, now = Date.now() }) {
  const out = { transport: 'unknown', auth: 'unknown', reachability: 'unknown', status: 'unknown', detail: '', httpStatus: null, at: now };
  let r;
  let timer;
  try {
    const ctrl = new AbortController();
    const request = fetchImpl(`http://127.0.0.1:${port}/federation/health`, {
      headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal,
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        const e = new Error(`health timeout (${timeoutMs}ms)`); e.name = 'AbortError'; reject(e);
      }, timeoutMs);
    });
    r = await Promise.race([request, timeout]);
  } catch (e) {
    out.transport = 'down';
    out.status = 'down';
    // DUE GUASTI DIVERSI, e prima avevano lo stesso messaggio. Con un canale
    // inverso SSH il listener sull'hub e' sshd: se il dispositivo non e'
    // connesso non c'e' nessun listener e la connessione viene RIFIUTATA; se
    // invece il tunnel regge ma NexusCrew sul dispositivo e' morto, sshd
    // accetta, inoltra, e la connessione viene AZZERATA dall'altro capo.
    //
    // MISURATO il 2026-08-07 sui tre casi reali contemporaneamente presenti:
    //   tunnel su + servizio giu'  -> ECONNRESET
    //   nessun listener            -> ECONNREFUSED
    //   tutto su                   -> HTTP (401)
    //
    // Perche' vale la pena distinguerli: «peer non raggiungibile» ha mandato
    // l'indagine nella federazione e nel pairing per quattro ore, mentre il
    // difetto era un servizio che non era ripartito sul dispositivo. Sono due
    // guasti con due rimedi diversi — uno si risolve sulla rete, l'altro
    // andando sul dispositivo — e un messaggio unico li fa cercare nel posto
    // sbagliato la meta' delle volte.
    const codice = (e && (e.code || (e.cause && e.cause.code))) || '';
    if (e && (e.name === 'AbortError' || codice === 'ETIMEDOUT')) {
      out.detail = `peer non raggiungibile (timeout ${timeoutMs}ms)`;
    } else if (codice === 'ECONNREFUSED') {
      out.detail = `canale inverso non attivo sulla porta ${port}: il dispositivo non e' connesso`;
      out.layer = 'tunnel';
    } else if (codice === 'ECONNRESET' || codice === 'ECONNABORTED' || codice === 'EPIPE') {
      out.detail = `canale inverso attivo sulla porta ${port}, ma NexusCrew non risponde sul dispositivo`;
      out.layer = 'service';
    } else {
      out.detail = 'peer non raggiungibile (tcp refused/down)';
    }
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
  out.transport = 'up';
  out.httpStatus = r.status;
  if (r.status === 200) {
    out.auth = 'ok';
    let body;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!body || body.ok !== true || typeof body.instanceId !== 'string') {
      out.reachability = 'failed'; out.status = 'degraded'; out.detail = 'health payload non valido';
    } else if (expectedInstanceId && body.instanceId !== expectedInstanceId) {
      out.reachability = 'failed'; out.status = 'degraded'; out.detail = 'peer instanceId inatteso — tunnel/porta punta al nodo sbagliato';
    } else {
      if (body.roles !== undefined) {
        const roles = store.parseRoles(body.roles);
        if (!roles) {
          out.reachability = 'failed'; out.status = 'degraded'; out.detail = 'health roles non validi';
          return out;
        }
        out.roles = roles; out.rolesKnown = true;
      }
      out.reachability = 'ok'; out.status = 'healthy'; out.detail = 'ok';
    }
  } else if (r.status === 401) {
    out.auth = 'failed'; out.reachability = 'ok'; out.status = 'degraded';
    out.detail = 'federation 401 — acceptToken non valido, re-pair richiesto';
  } else if (r.status === 403) {
    out.auth = 'ok'; out.reachability = 'ok'; out.status = 'degraded';
    out.detail = 'peer in READONLY o transito negato (403)';
  } else if (r.status >= 500) {
    out.reachability = 'failed'; out.status = 'degraded'; out.detail = `peer HTTP ${r.status}`;
  } else {
    out.reachability = 'failed'; out.status = 'degraded'; out.detail = `peer HTTP ${r.status}`;
  }
  return out;
}

// A freshly restarted SSH supervisor returns before both forwards are
// necessarily accepting traffic.  Share must therefore wait for the actual
// authenticated federation channel instead of racing a single immediate
// fetch.  Auth/identity failures are terminal; transport startup is retried
// for a short bounded window.
async function waitForHealthyPeer(opts = {}) {
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? Math.min(opts.attempts, 12) : 6;
  const delayMs = Number.isInteger(opts.delayMs) && opts.delayMs >= 0 ? Math.min(opts.delayMs, 2000) : 200;
  const delay = typeof opts.delay === 'function'
    ? opts.delay : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const probeOpts = { ...opts };
  delete probeOpts.attempts; delete probeOpts.delayMs; delete probeOpts.delay;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probeHealth(probeOpts);
    if (last.status === 'healthy') return last;
    if (last.auth === 'failed' || /instanceId inatteso/.test(last.detail || '')) break;
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  return last || { status: 'down', detail: 'peer non raggiungibile' };
}

// Verifica locale e limitata alla porta reverse gia' assegnata al peer
// autenticato. Non accetta una porta dal chiamante: il peer non puo' usarla
// come scanner e la risposta non rivela quale processo la stia occupando.
function canListenLoopback(port, createServerImpl = net.createServer) {
  if (!store.isPort(port)) return Promise.resolve({ available: false, code: 'reverse-port-invalid' });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let server;
    try {
      server = createServerImpl();
      server.once('error', (error) => {
        settle({ available: false, code: error && error.code === 'EADDRINUSE' ? 'reverse-port-in-use' : 'reverse-port-unavailable' });
      });
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close((error) => settle(error
          ? { available: false, code: 'reverse-port-unavailable' }
          : { available: true }));
      });
    } catch (_) { settle({ available: false, code: 'reverse-port-unavailable' }); }
  });
}

// Preflight best-effort da client verso il proprio hub attraverso il -L gia'
// autenticato. Un hub precedente che non conosce la route (404), o una rete
// transitoriamente guasta, conserva il percorso legacy: l'SSH con
// ExitOnForwardFailure resta l'autorita' finale. Un 409 del nuovo hub invece
// evita di spegnere il -L privato per tentare un -R gia' noto come conflittuale.
// Una porta gia' risposta dal peer autenticato stesso e' invece transitabile:
// e' il caso normale di Share che registra un reverse gia' pronto.
async function preflightHubReverse({ node, fetchImpl = fetch, timeoutMs = 1500 }) {
  if (!node || !store.isPort(node.localPort) || !store.validToken(node.token)) {
    throw new Error('parametri preflight Share non validi');
  }
  const ctrl = new AbortController();
  const budget = Number.isInteger(timeoutMs) ? Math.max(100, Math.min(timeoutMs, 10000)) : 1500;
  let timer;
  try {
    const request = fetchImpl(`http://127.0.0.1:${node.localPort}/federation/reverse-status`, {
      headers: { authorization: `Bearer ${node.token}` }, signal: ctrl.signal,
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        const error = new Error(`hub reverse preflight timeout (${budget}ms)`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, budget);
    });
    const response = await Promise.race([request, timeout]);
    if (!response || response.status === 404) return { supported: false };
    if (response.status === 409) return { supported: true, available: false, code: 'reverse-port-in-use' };
    if (!response.ok) return { supported: false };
    let body = null;
    try { body = await response.json(); } catch (_) { return { supported: false }; }
    return body && (body.available === true || body.ownedByAuthenticatedPeer === true)
      ? { supported: true, available: true, ...(body.ownedByAuthenticatedPeer === true ? { ownedByAuthenticatedPeer: true } : {}) }
      : { supported: false };
  } catch (_) {
    return { supported: false };
  } finally { clearTimeout(timer); }
}

// Aggiorna lo stato Share sul hub attraverso il canale -L autenticato. Non
// legge mai il body remoto (potrebbe contenere diagnostica non sicura) e non
// include credenziali negli errori. Usato sia dal toggle interattivo sia dalla
// riconciliazione al boot.
async function notifyHubShare({ node, shared, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!node || !store.isPort(node.localPort) || !store.validToken(node.token)
    || typeof shared !== 'boolean') throw new Error('parametri riconciliazione Share non validi');
  const ctrl = new AbortController();
  const budget = Number.isInteger(timeoutMs) ? Math.max(100, Math.min(timeoutMs, 30000)) : 5000;
  let timer;
  try {
    const request = fetchImpl(`http://127.0.0.1:${node.localPort}/federation/share`, {
      method: 'POST', signal: ctrl.signal,
      headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ shared }),
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        const e = new Error(`hub Share timeout (${budget}ms)`); e.code = 'ETIMEDOUT'; reject(e);
      }, budget);
    });
    const response = await Promise.race([request, timeout]);
    if (!response || !response.ok) {
      const failure = new Error(`hub Share HTTP ${response && response.status || 'unknown'}`);
      failure.status = response && response.status;
      // Si estrae SOLO il codice tipizzato: il corpo remoto non entra mai nel
      // messaggio d'errore ne' nei log. Un corpo non-JSON lascia il codice
      // assente e l'errore resta definitivo, che e' il default sicuro.
      try {
        const body = typeof response.json === 'function' ? await response.json() : null;
        if (body && typeof body.code === 'string' && body.code.length <= 64) failure.code = body.code;
      } catch (_) { /* corpo assente o non-JSON: nessun codice */ }
      throw failure;
    }
    return { shared };
  } finally { clearTimeout(timer); }
}

// Internal pool-control calls travel only through the established private -L.
// Bodies are deliberately index/lease based: neither a caller nor a remote
// UI can turn them into an arbitrary loopback port probe.
async function hubPoolRequest({ node, endpoint, body, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!node || !store.isPort(node.localPort) || !store.validToken(node.token)
    || !['verify', 'reserve', 'commit', 'settle', 'abort', 'status'].includes(endpoint)) {
    throw new Error('parametri reverse pool non validi');
  }
  const ctrl = new AbortController();
  const budget = Number.isInteger(timeoutMs) ? Math.max(100, Math.min(timeoutMs, 30000)) : 5000;
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const method = endpoint === 'status' ? 'GET' : 'POST';
    const response = await fetchImpl(`http://127.0.0.1:${node.localPort}/federation/reverse-pool/${endpoint}`, {
      method, signal: ctrl.signal,
      headers: { authorization: `Bearer ${node.token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
    });
    const payload = response && typeof response.json === 'function'
      ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) {
      const error = new Error(`hub reverse pool HTTP ${response?.status || 'unknown'}`);
      error.status = response?.status; error.code = payload && payload.code;
      throw error;
    }
    return payload || {};
  } finally { clearTimeout(timer); }
}

async function verifyHubPoolSlot({ node, slot, generation, fetchImpl = fetch, attempts = 3, delayMs = 200 }) {
  const total = Number.isInteger(attempts) ? Math.max(1, Math.min(attempts, 6)) : 3;
  let last = null;
  for (let attempt = 0; attempt < total; attempt += 1) {
    try { return await hubPoolRequest({ node, endpoint: 'verify', body: { slot, generation }, fetchImpl }); }
    catch (error) { last = error; if (attempt < total - 1) await new Promise((resolve) => setTimeout(resolve, delayMs)); }
  }
  throw last || new Error('verifica reverse pool fallita');
}

function reserveHubPoolSlot({ node, slot, fetchImpl = fetch }) {
  return hubPoolRequest({ node, endpoint: 'reserve', body: { slot }, fetchImpl });
}
function commitHubPoolSlot({ node, leaseId, fetchImpl = fetch }) {
  return hubPoolRequest({ node, endpoint: 'commit', body: { leaseId }, fetchImpl });
}
function settleHubPoolSlot({ node, generation, fetchImpl = fetch }) {
  return hubPoolRequest({ node, endpoint: 'settle', body: { generation }, fetchImpl });
}
function abortHubPoolSlot({ node, leaseId, fetchImpl = fetch }) {
  return hubPoolRequest({ node, endpoint: 'abort', body: { leaseId }, fetchImpl });
}
function getHubPoolStatus({ node, fetchImpl = fetch }) {
  return hubPoolRequest({ node, endpoint: 'status', fetchImpl });
}

// Il file locale contiene lo stato desiderato. Dopo un crash in qualunque
// punto del toggle, il boot ristabilisce il tunnel coerente e ripete l'update
// del hub: ON torna pubblicato, OFF revoca record stale. Tutto e' bounded.
async function reconcilePeerShare(opts = {}) {
  const node = opts.node;
  const shared = opts.shared === true;
  if (!node || !store.validToken(node.token) || !store.NODE_ID_RE.test(String(node.nodeId || ''))) {
    throw new Error('peer non associato: riconciliazione Share impossibile');
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const delay = typeof opts.delay === 'function'
    ? opts.delay : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const health = await waitForHealthyPeer({
    port: node.localPort, token: node.token, expectedInstanceId: node.nodeId,
    fetchImpl,
    attempts: Number.isInteger(opts.healthAttempts) ? opts.healthAttempts : 6,
    delayMs: Number.isInteger(opts.delayMs) ? opts.delayMs : 200,
    delay,
  });
  if (!health || health.status !== 'healthy') {
    throw new Error((health && health.detail) || 'hub non raggiungibile per riconciliare Share');
  }
  const attempts = Number.isInteger(opts.notifyAttempts)
    ? Math.max(1, Math.min(opts.notifyAttempts, 6)) : 3;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await notifyHubShare({ node, shared, fetchImpl, timeoutMs: opts.timeoutMs });
      return { shared, health };
    } catch (e) {
      lastError = e;
      if (attempt + 1 < attempts) await delay(Number.isInteger(opts.delayMs) ? opts.delayMs : 200);
    }
  }
  throw lastError || new Error('riconciliazione Share fallita');
}

// Runner di riconciliazione Share OFF al boot (design piano §3.2.8). Per-peer,
// no-overlap (un solo runner attivo per nome), al massimo tre round per processo,
// backoff nominato 0/1000/5000 ms (iniettabile). Re-read dello stato desiderato
// (nodes.json) prima di ogni round: abort se non e' piu' shared:false (es. il peer
// e' stato ri-condiviso o rimosso). Emette SHARE_REVOKE_PENDING/RECOVERED/EXHAUSTED
// tramite il callback diagnostico (una transizione ciascuno, no spam). Nessun
// timer infinito, nessuna retry storm process-wide, nessun retry di ON sotto la
// policy OFF. Il backoff e' un delay nominato usato solo fra round di fallimento.
const SHARE_REVOKE_BACKOFF_MS = Object.freeze([0, 1000, 5000]);
const shareRevokeRunning = new Set(); // per-peer no-overlap (scope modulo)
function runShareRevokeBoot({
  node, nodesPath, fetchImpl = fetch, diagnostics,
  backoff = SHARE_REVOKE_BACKOFF_MS, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runningSet = shareRevokeRunning, reconcileImpl = reconcilePeerShare,
  healthAttempts = 3, notifyAttempts = 3, delayMs = 200, timeoutMs = 5000,
}) {
  const name = node && typeof node.name === 'string' ? node.name : '';
  if (!store.NODE_NAME_RE.test(name) || !store.NODE_ID_RE.test(String(node && node.nodeId || ''))
    || !store.validToken(node && node.token) || typeof nodesPath !== 'string' || !nodesPath
    || typeof reconcileImpl !== 'function') {
    return Promise.resolve({ status: 'skipped', reason: 'invalid-input' });
  }
  if (runningSet.has(name)) return Promise.resolve({ status: 'already-running' });
  runningSet.add(name);
  const emit = (level, code, message, state) => {
    if (diagnostics && typeof diagnostics.record === 'function') {
      try { diagnostics.record(level, 'share', code, message, { node: name, state }); } catch (_) { /* best-effort */ }
    }
  };
  return (async () => {
    emit('warn', 'SHARE_REVOKE_PENDING', 'Share OFF reconciliation pending', 'pending');
    const slots = Array.from({ length: 3 }, (_, index) => {
      const candidate = Array.isArray(backoff) ? backoff[index] : SHARE_REVOKE_BACKOFF_MS[index];
      return Number.isFinite(candidate) ? Math.max(0, Math.min(candidate, 30000)) : SHARE_REVOKE_BACKOFF_MS[index];
    });
    for (let round = 0; round < slots.length; round += 1) {
      try {
        if (slots[round] > 0) await delay(slots[round]);
        // Re-read dello stato desiderato immediatamente prima di ogni round.
        // Un peer rimosso o nuovamente condiviso annulla la policy OFF in coda.
        const st = store.loadStoreStrict(nodesPath);
        const fresh = store.getNode(st, name);
        if (!fresh || fresh.shared !== false) return { status: 'aborted', reason: 'desired-state-changed' };
        await reconcileImpl({
          node: fresh, shared: false, fetchImpl,
          healthAttempts: Math.max(3, Math.min(Number(healthAttempts) || 3, 12)),
          notifyAttempts: Math.max(3, Math.min(Number(notifyAttempts) || 3, 6)),
          delayMs: Math.max(0, Math.min(Number(delayMs) || 0, 2000)), timeoutMs,
        });
        emit('warn', 'SHARE_REVOKE_RECOVERED', 'Share OFF reconciliation recovered', 'recovered');
        return { status: 'recovered', rounds: round + 1 };
      } catch (_) {
        // Error text is intentionally not recorded: it can contain transport
        // details. The stable transition code is sufficient for Diagnostics.
      }
    }
    emit('error', 'SHARE_REVOKE_EXHAUSTED', 'Share OFF reconciliation exhausted', 'exhausted');
    return { status: 'exhausted', rounds: 3 };
  })().finally(() => { runningSet.delete(name); });
}

function controlledVisited(req, ingress, instanceId) {
  const raw = ingress ? String(req.headers['x-nexuscrew-visited'] || '') : '';
  const seen = raw ? raw.split(',').filter(Boolean) : [];
  // On a peer-facing route the last server-controlled hop must be the peer
  // authenticated by its scoped federation token.  Without this binding a
  // token holder could forge the first visited ID and impersonate another
  // cell-network sender at the destination.
  if (ingress && (!store.NODE_ID_RE.test(String(ingress.nodeId || ''))
    || !seen.length || seen.at(-1) !== ingress.nodeId)) return null;
  if (seen.some((id) => !store.NODE_ID_RE.test(id)) || seen.includes(instanceId) || seen.length > MAX_HOPS) return null;
  return [...seen, instanceId];
}

async function fetchPeerTopology({ node, ttl, seen, fetchImpl, timeoutMs }) {
  const ctrl = new AbortController();
  const budget = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(30000, Math.floor(timeoutMs))) : TOPOLOGY_PEER_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      const error = new Error(`topology peer timeout (${budget}ms)`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, budget);
  });
  const request = (async () => {
    const u = `http://127.0.0.1:${node.localPort}/federation/topology?ttl=${ttl - 1}&visited=${encodeURIComponent([...seen].join(','))}`;
    const response = await fetchImpl(u, {
      headers: { authorization: `Bearer ${node.token}` }, signal: ctrl.signal,
    });
    return { response, body: await response.json() };
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}

async function collectTopologyDetailed({
  nodesPath, ingress = null, ttl = MAX_HOPS, visited = [], fetchImpl = fetch,
  timeoutMs = TOPOLOGY_PEER_TIMEOUT_MS,
}) {
  const st = store.loadStore(nodesPath);
  if (!st) return { instanceId: null, nodes: [], authoritative: [] };
  const seen = new Set(visited.filter((x) => store.NODE_ID_RE.test(x)));
  seen.add(st.nodeId);
  const out = [];
  const authoritative = [];
  const probes = [];
  for (const n of st.nodes) {
    // The local installation always keeps its outbound hub visible. Inbound
    // clients become part of Hydra only after their explicit Share toggle.
    if (!n.nodeId || seen.has(n.nodeId)
      || (!ingress && n.direction === 'inbound' && n.shared !== true)
      || (ingress && !canTransit(ingress, n))) continue;
    // `name` e' lo slug locale con cui si indirizza; `label` e' il nome
    // leggibile. Senza quest'ultimo un nodo raggiunto in transito arriva agli
    // altri come uno slug scelto da qualcun altro, e cinque installazioni
    // diverse si presentano con lo stesso nome.
    out.push({
      instanceId: n.nodeId, name: n.name, route: [n.name], direct: true,
      label: store.validLabel(n.label) ? n.label.trim() : '',
    });
    if (ttl <= 1 || !n.token) continue;
    probes.push({ n, pending: fetchPeerTopology({ node: n, ttl, seen, fetchImpl, timeoutMs }) });
  }
  const results = await Promise.all(probes.map(async ({ n, pending }) => {
    try { return { n, ...(await pending) }; } catch (_) { return { n, response: null, body: null }; }
  }));
  for (const { n, response, body } of results) {
    if (!response || !response.ok || body.instanceId !== n.nodeId || !Array.isArray(body.nodes)) continue;
    authoritative.push(n.name);
    for (const child of body.nodes) {
        if (!child || !store.NODE_ID_RE.test(child.instanceId) || child.instanceId === n.nodeId || seen.has(child.instanceId)
          || !store.NODE_NAME_RE.test(child.name)
          || !Array.isArray(child.route) || child.route.length < 1 || child.route.length >= ttl
          || child.route.some((x) => !store.NODE_NAME_RE.test(x))
          || new Set(child.route).size !== child.route.length
          || child.name !== child.route[child.route.length - 1]
          || child.route.includes(n.name)) continue;
        // La label di un nodo in transito e' testo AUTO-DICHIARATO da un altro
        // nodo: si accetta solo se rispetta la stessa forma di una label locale,
        // altrimenti si resta senza nome invece di propagare qualcosa di
        // arbitrario. Non e' mai una prova di identita': quella e' l'instanceId.
        out.push({
          instanceId: child.instanceId, name: child.name,
          route: [n.name, ...child.route], direct: false,
          label: store.validLabel(child.label) ? child.label.trim() : '',
        });
    }
  }
  const ids = new Set(); const routes = new Set(); const unique = [];
  for (const n of out.sort((a, b) => a.route.length - b.route.length)) {
    const routeKey = n.route.join('/');
    if (ids.has(n.instanceId) || routes.has(routeKey)) continue;
    ids.add(n.instanceId); routes.add(routeKey); unique.push(n);
  }
  return { instanceId: st.nodeId, nodes: unique, authoritative };
}

async function collectTopology(opts) {
  const out = await collectTopologyDetailed(opts);
  return { instanceId: out.instanceId, nodes: out.nodes };
}

// Local roster: live topology plus a credential-free cache of previously seen
// transitive nodes. Stale entries are never returned by the peer endpoint.
async function collectLocalTopology({
  nodesPath, cachePath, fetchImpl = fetch, now = Math.floor(Date.now() / 1000),
  timeoutMs = TOPOLOGY_PEER_TIMEOUT_MS,
}) {
  const live = await collectTopologyDetailed({ nodesPath, fetchImpl, timeoutMs });
  const st = store.loadStore(nodesPath);
  const directNames = new Set(((st && st.nodes) || [])
    .filter((n) => n.direction !== 'inbound' || n.shared === true)
    .map((n) => n.name));
  const authoritative = new Set(live.authoritative);
  const liveIds = new Set(live.nodes.map((n) => n.instanceId));
  const liveRoutes = new Set(live.nodes.map((n) => n.route.join('/')));
  const cacheFile = cachePath || topologyCache.defaultPath();
  const old = topologyCache.loadCache(cacheFile) || topologyCache.emptyCache();
  const next = new Map();

  for (const entry of old.nodes) {
    const first = entry.route[0];
    if (!directNames.has(first)) continue;
    if (authoritative.has(first) && !liveIds.has(entry.instanceId) && !liveRoutes.has(entry.route.join('/'))) continue;
    next.set(entry.instanceId, entry);
  }
  for (const n of live.nodes) {
    // La cache conserva anche la label: senza, un nodo che torna stale perde il
    // nome e ricompare come slug, cioe' esattamente il difetto che si voleva
    // togliere. Resta un dato riferito, non una prova.
    if (n.route.length > 1) {
      next.set(n.instanceId, {
        instanceId: n.instanceId, name: n.name, route: [...n.route],
        ...(n.label ? { label: n.label } : {}), lastSeen: now,
      });
    }
  }
  const cached = [...next.values()].sort((a, b) => a.route.join('/').localeCompare(b.route.join('/'))).slice(0, topologyCache.MAX_ENTRIES);
  const serialized = { schemaVersion: topologyCache.SCHEMA_VERSION, nodes: cached };
  if (JSON.stringify(serialized) !== JSON.stringify(old)) {
    try { topologyCache.atomicWriteCache(cacheFile, serialized); } catch (_) {}
  }

  const nodes = live.nodes.map((n) => ({ ...n, stale: false, lastSeen: now }));
  for (const n of cached) {
    if (!liveIds.has(n.instanceId) && !liveRoutes.has(n.route.join('/'))) nodes.push({ ...n, direct: false, stale: true });
  }
  return { instanceId: live.instanceId, nodes };
}

async function probeReverseOwner(peer, fetchImpl = fetch) {
  const pool = peer && peer.reversePool;
  const active = pool && pool.slots && pool.slots[pool.activeSlot];
  if (active && peer.token && peer.nodeId) {
    const proof = await probeReverseSlot({
      port: active.port, secret: peer.token,
      expected: { remotePort: active.port, generation: pool.activeGeneration, instanceId: peer.nodeId },
      fetchImpl,
    });
    return proof.owned
      ? { status: 'healthy', detail: 'reverse slot autenticata', slotProof: true }
      : { status: 'degraded', detail: 'reverse slot non autenticata', slotProof: true, code: proof.code };
  }
  return probeHealth({
    port: peer.localPort, token: peer.token,
    expectedInstanceId: peer.nodeId || null,
    fetchImpl,
  });
}

function peerRouter({ nodesPath, localPort, localCredential, fetchImpl, readonly = () => false, version = null, roles = null, hopSecret = null, diagnostics = null }) {
  const r = express.Router();
  r.use((req, res, next) => {
    const peer = peerFromToken(nodesPath, bearerFrom(req));
    if (!peer) return res.status(401).json({ error: 'unauthorized peer' });
    req.peer = peer; next();
  });
  // Health federato: il peer autenticato (acceptToken matchato sopra) ottiene un
  // 200 esplicito con instanceId/version. Serve da target di probeHealth() lato
  // Initiator: distingue transport (porta aperta) da auth (200 vs 401) da
  // reachability (payload). Nessun segreto in risposta.
  r.get('/health', (_req, res) => {
    const st = store.loadStore(nodesPath);
    const advertisedRoles = typeof roles === 'function' ? roles() : null;
    res.json({ ok: true, instanceId: (st && st.nodeId) || null, version, readonly: !!readonly(),
      ...(advertisedRoles ? { roles: advertisedRoles } : {}) });
  });
  // Il client puo' verificare SOLO la reverse port che il pairing gli ha
  // assegnato. Non e' un endpoint di discovery: nessun parametro, nessuna
  // identita' del listener e nessun dettaglio SSH vengono esposti.
  r.get('/reverse-status', async (req, res) => {
    const result = await canListenLoopback(req.peer.localPort);
    if (result.available) return res.json({ available: true });
    // Una porta gia' ascoltata dal peer che ha autenticato QUESTA richiesta
    // non e' un conflitto: e' il reverse preesistente dello stesso dispositivo.
    // La health vincola sia token sia instanceId e non restituisce alcun
    // dettaglio sul processo. Un listener estraneo, legacy o non verificabile
    // resta invece un 409 senza restart/persist/publish lato client.
    const health = await probeReverseOwner(req.peer, fetchImpl || fetch);
    if (health.status === 'healthy') {
      return res.json({ available: false, ownedByAuthenticatedPeer: true });
    }
    return res.status(409).json({
      available: false,
      code: result.code === 'reverse-port-in-use' ? 'reverse-port-in-use' : 'reverse-port-unavailable',
    });
  });
  // Pool verification is intentionally slot-indexed, never port-indexed: the
  // peer can ask the hub to prove only a slot it was assigned.  The hub keeps
  // the proof result itself; a client cannot simply claim that its SSH key has
  // three permitlisten grants.
  r.post('/reverse-pool/verify', express.json({ limit: '1kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: verifica pool bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((key) => !['slot', 'generation'].includes(key))
      || !Number.isInteger(body.slot) || !Number.isSafeInteger(body.generation) || body.generation < 1) {
      return res.status(400).json({ error: 'body non valido: attesi slot e generation' });
    }
    const peer = req.peer;
    const current = store.loadStoreStrict(nodesPath);
    const node = store.getNode(current, peer.name);
    const pool = node && node.reversePool;
    const candidate = pool && pool.slots[body.slot];
    if (!candidate || candidate.generation !== body.generation) {
      return res.status(409).json({ error: 'slot reverse non assegnata a questa generation', code: 'reverse-slot-stale' });
    }
    const proof = await probeReverseSlot({
      port: candidate.port, secret: node.token,
      expected: { remotePort: candidate.port, generation: candidate.generation, instanceId: node.nodeId },
      fetchImpl: fetchImpl || fetch,
    });
    const verifiedSlots = proof.owned
      ? [...new Set([...pool.verifiedSlots, body.slot])].sort((a, b) => a - b)
      : [...pool.verifiedSlots];
    const updatedPool = {
      ...pool,
      verifiedSlots,
      verification: verifiedSlots.length === pool.slots.length ? 'verified' : 'unverifiable',
    };
    store.atomicWriteStore(nodesPath, store.setNodeReversePool(current, node.name, updatedPool));
    if (!proof.owned) return res.status(409).json({ error: 'slot reverse non autenticata', code: proof.code });
    return res.json({ verified: true, slot: body.slot, verification: updatedPool.verification });
  });
  // The peer proposes a slot through its still-live -L; the hub alone grants
  // the lease and generation.  There is no port parameter, scanner or tunnel
  // termination path here.
  r.post('/reverse-pool/reserve', express.json({ limit: '1kb' }), (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: rotazione pool bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'slot') || !Number.isInteger(body.slot)) {
      return res.status(400).json({ error: 'body non valido: atteso slot' });
    }
    try {
      const current = store.loadStoreStrict(nodesPath);
      const node = store.getNode(current, req.peer.name);
      let pool = node && node.reversePool;
      // A crashed peer may leave a reservation behind. Its lease has no
      // privilege after expiry, so clear it before considering the requested
      // slot; this is state cleanup only, never SSH/process cleanup.
      if (pool?.rotation?.phase === 'prepared' && Date.now() > pool.rotation.expiresAt) {
        pool = reverseRotation.abortPrepared(pool);
      }
      const prepared = pool && reverseRotation.prepareRotation(pool, { slot: body.slot });
      if (!prepared) return res.status(409).json({ error: 'pool non verificato o slot non disponibile', code: 'reverse-rotation-not-ready' });
      store.atomicWriteStore(nodesPath, store.setNodeReversePool(current, node.name, prepared));
      return res.json({ leaseId: prepared.rotation.leaseId, slot: prepared.rotation.slot,
        generation: prepared.rotation.generation, expiresAt: prepared.rotation.expiresAt });
    } catch (error) { return res.status(500).json({ error: String(error.message || error) }); }
  });
  r.post('/reverse-pool/abort', express.json({ limit: '1kb' }), (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: rotazione pool bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'leaseId') || typeof body.leaseId !== 'string') {
      return res.status(400).json({ error: 'body non valido: atteso leaseId' });
    }
    try {
      const current = store.loadStoreStrict(nodesPath);
      const node = store.getNode(current, req.peer.name);
      const pool = node && node.reversePool;
      if (!pool || pool.rotation?.phase !== 'prepared' || pool.rotation.leaseId !== body.leaseId) {
        return res.status(409).json({ error: 'lease reverse non valida o gia conclusa', code: 'reverse-lease-stale' });
      }
      const aborted = reverseRotation.abortPrepared(pool);
      if (!aborted) return res.status(409).json({ error: 'lease reverse non annullabile', code: 'reverse-lease-stale' });
      store.atomicWriteStore(nodesPath, store.setNodeReversePool(current, node.name, aborted));
      return res.json({ aborted: true });
    } catch (error) { return res.status(500).json({ error: String(error.message || error) }); }
  });
  r.post('/reverse-pool/commit', express.json({ limit: '1kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: rotazione pool bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'leaseId') || typeof body.leaseId !== 'string') {
      return res.status(400).json({ error: 'body non valido: atteso leaseId' });
    }
    try {
      const current = store.loadStoreStrict(nodesPath);
      const node = store.getNode(current, req.peer.name);
      const prepared = node && node.reversePool;
      const rotation = prepared && prepared.rotation;
      if (!rotation || rotation.phase !== 'prepared' || rotation.leaseId !== body.leaseId) {
        return res.status(409).json({ error: 'lease reverse non valida o scaduta', code: 'reverse-lease-stale' });
      }
      const slot = prepared.slots[rotation.slot];
      let proof = { owned: false, code: 'reverse-slot-proof-unavailable' };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        proof = await probeReverseSlot({
          port: slot.port, secret: node.token,
          expected: { remotePort: slot.port, generation: rotation.generation, instanceId: node.nodeId },
          fetchImpl: fetchImpl || fetch,
        });
        if (proof.owned || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!proof.owned) {
        const abandoned = reverseRotation.quarantineSlot(prepared, { slot: rotation.slot }) || prepared;
        const invalidated = { ...abandoned, verification: 'invalidated', verifiedSlots: [] };
        store.atomicWriteStore(nodesPath, store.setNodeReversePool(current, node.name, invalidated));
        return res.status(409).json({ error: 'candidate reverse non autenticata', code: proof.code });
      }
      const committed = reverseRotation.commitRotation(prepared, { leaseId: body.leaseId });
      if (!committed) return res.status(409).json({ error: 'lease reverse scaduta', code: 'reverse-lease-expired' });
      // The hub routes the peer through the newly proven slot immediately. The
      // old slot is only draining and is never reassigned to another peer.
      const updated = store.updateNode(current, node.name, {
        localPort: committed.slots[committed.activeSlot].port,
        reversePool: committed,
      });
      store.atomicWriteStore(nodesPath, updated);
      return res.json({ committed: true, slot: committed.activeSlot, generation: committed.activeGeneration,
        graceUntil: committed.rotation.graceUntil });
    } catch (error) { return res.status(500).json({ error: String(error.message || error) }); }
  });
  r.post('/reverse-pool/settle', express.json({ limit: '1kb' }), (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: rotazione pool bloccata' });
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'generation') || !Number.isSafeInteger(body.generation) || body.generation < 1) {
      return res.status(400).json({ error: 'body non valido: atteso generation' });
    }
    try {
      const current = store.loadStoreStrict(nodesPath);
      const node = store.getNode(current, req.peer.name);
      if (!node?.reversePool || node.reversePool.activeGeneration !== body.generation) {
        return res.status(409).json({ error: 'generation reverse non corrente', code: 'reverse-generation-stale' });
      }
      const settled = reverseRotation.settleGrace(node.reversePool);
      if (!settled) return res.status(409).json({ error: 'grace reverse non conclusa', code: 'reverse-grace-pending' });
      store.atomicWriteStore(nodesPath, store.setNodeReversePool(current, node.name, settled));
      return res.json({ settled: true, generation: settled.activeGeneration });
    } catch (error) { return res.status(500).json({ error: String(error.message || error) }); }
  });
  r.get('/reverse-pool/status', (req, res) => {
    try {
      const current = store.loadStoreStrict(nodesPath);
      const node = store.getNode(current, req.peer.name);
      if (!node?.reversePool) return res.status(409).json({ error: 'pool reverse non configurato', code: 'reverse-pool-missing' });
      // This travels only on the peer's authenticated private -L. It includes
      // no bearer material and lets a restarted peer converge on the hub's
      // committed generation instead of reopening an obsolete slot.
      return res.json({ pool: node.reversePool });
    } catch (error) { return res.status(500).json({ error: String(error.message || error) }); }
  });
  r.get('/topology', async (req, res) => {
    const ttl = Math.max(0, Math.min(MAX_HOPS, Number(req.query.ttl) || MAX_HOPS));
    const visited = String(req.query.visited || '').split(',');
    res.json(await collectTopology({ nodesPath, ingress: req.peer, ttl, visited, fetchImpl }));
  });
  // A connected client publishes itself through the SAME SSH connection by
  // toggling its optional -R channel. The hub records that intent only after a
  // real authenticated health probe succeeds; Share off is immediate/fail-safe.
  r.post('/share', express.json({ limit: '1kb' }), async (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: share bloccato' });
    const body = req.body || {};
    if (Object.keys(body).some((k) => k !== 'shared') || typeof body.shared !== 'boolean') {
      return res.status(400).json({ error: 'body non valido: atteso {shared:boolean}' });
    }
    try {
      if (body.shared) {
        // Il reverse channel viene stabilito dal peer subito prima di questa
        // chiamata: appena dopo un pairing il bind non e' ancora pronto e la
        // finestra breve trasformava un'attesa in un fallimento definitivo,
        // con rollback dell'intera transazione lato peer. La finestra resta
        // limitata (nessun retry storm) ma copre il caso reale.
        let health;
        if (req.peer.reversePool) {
          for (let attempt = 0; attempt < SHARE_HEALTH_ATTEMPTS; attempt += 1) {
            health = await probeReverseOwner(req.peer, fetchImpl || fetch);
            if (health.status === 'healthy') break;
            if (attempt < SHARE_HEALTH_ATTEMPTS - 1) {
              await new Promise((resolve) => setTimeout(resolve, SHARE_HEALTH_DELAY_MS));
            }
          }
        } else {
          health = await waitForHealthyPeer({
            port: req.peer.localPort,
            token: req.peer.token,
            expectedInstanceId: req.peer.nodeId || null,
            fetchImpl: fetchImpl || fetch,
            attempts: SHARE_HEALTH_ATTEMPTS,
            delayMs: SHARE_HEALTH_DELAY_MS,
          });
        }
        if (health.status !== 'healthy') {
          // Codice tipizzato: chi chiama deve poter distinguere un'attesa da un
          // guasto definitivo senza interpretare una stringa. Solo il canale
          // non ancora salito e' ritentabile.
          const failure = classifyShareFailure(health);
          // L'hub sa di aver rifiutato e sa perche', e finora non lo scriveva
          // da nessuna parte: l'errore viveva solo nel toast del dispositivo,
          // che e' l'unico posto dove chi amministra l'hub non puo' guardarlo.
          // Un rifiuto ripetuto diventava cosi' un mistero — e' costato ore su
          // un caso reale, risolto solo leggendo i log di sshd con i privilegi
          // di root. Meta bounded: nome nodo, codice tipizzato, porta tentata.
          // Nessun testo remoto, nessuna credenziale.
          if (diagnostics && typeof diagnostics.record === 'function') {
            diagnostics.record('warn', 'share', 'SHARE_CHANNEL_REFUSED',
              'Share refused: the reverse channel did not come up', {
                node: req.peer.name,
                code: failure.code,
                port: activeReversePort(req.peer),
              });
          }
          return res.status(409).json({
            error: 'canale share non raggiungibile',
            code: failure.code,
            detail: failure.detail,
          });
        }
      }
      let st = store.loadStoreStrict(nodesPath);
      const current = store.getNode(st, req.peer.name);
      if (!current) return res.status(404).json({ error: 'peer non trovato' });
      st = store.updateNode(st, current.name, {
        shared: body.shared,
        roles: { ...current.roles, node: body.shared },
        rolesKnown: true,
      });
      store.atomicWriteStore(nodesPath, st);
      return res.json({ shared: body.shared });
    } catch (e) {
      return res.status(e.status || 500).json({ error: String(e && e.message || e), ...(e.code ? { code: e.code } : {}) });
    }
  });
  r.use('/route', (req, res) => routeHandler({ nodesPath, localPort, localCredential, ingress: req.peer, readonly, hopSecret })(req, res));
  return r;
}

function localRouter({ nodesPath, localPort, localCredential, readonly, hopSecret = null }) {
  const r = express.Router();
  r.use((req, res) => routeHandler({ nodesPath, localPort, localCredential, readonly, hopSecret })(req, res));
  return r;
}

function forwardUpgrade({ req, socket, head, nodesPath, localPort, localCredential, ingress, readonly = () => false, activeSockets = null, hopSecret = null }) {
  if (readonly()) return reject(socket, 403);
  const parsed = parseRoute(req.url.replace(/^\/(?:api\/route|federation\/route)/, ''));
  // Due percorsi separati: questo NON passa da routeHandler e non ne condivide i
  // controlli. Un gate scritto solo di la' sarebbe una porta chiusa accanto a una
  // aperta — e per un pannello la porta aperta e' l'unica che conta, perche' i
  // frame arrivano da qui.
  if (!parsed || (parsed.resource !== '/ws' && !isPanelResource(parsed.resource))) return reject(socket, 404);
  if (isPanelResource(parsed.resource) && !panelAllowedFor(ingress)) return reject(socket, 403);
  const st = store.loadStore(nodesPath);
  if (!st) return reject(socket, 503);
  const visited = controlledVisited(req, ingress, st.nodeId);
  if (!visited) return reject(socket, 409);
  let port = typeof localPort === 'function' ? localPort() : localPort; let credential = localCredential();
  // Ultimo hop: `/ws` entra com'e', il pannello rientra nell'API locale.
  let path = parsed.resource === '/ws' ? '/ws' : `/api${parsed.resource}`;
  if (parsed.route.length) {
    const next = store.getNode(st, parsed.route[0]);
    const privateInbound = next && next.direction === 'inbound' && next.shared !== true;
    if (!next || !next.token || privateInbound || (ingress && !canTransit(ingress, next))) return reject(socket, 403);
    port = next.localPort; credential = next.token;
    const rest = parsed.route.slice(1);
    path = `/federation/route/${rest.length ? `${rest.join('/')}/` : ''}${ROUTE_DELIMITER}${parsed.resource}`;
  }
  const up = net.connect({ host: '127.0.0.1', port });
  up.once('connect', () => {
    // Ultimo hop: l'upgrade rientra nell'API locale col Bearer locale e da li'
    // in poi sarebbe indistinguibile da un attach diretto di chi possiede quel
    // token. La catena PIU' la prova di hop sono cio' che lo distingue —
    // esattamente come fa routeHandler per il percorso HTTP. Senza, il nodo che
    // possiede la sessione non sa quale peer stia aprendo il suo PTY, e ogni
    // permesso per-cella diventa decorativo: `/ws` attacca per NOME di
    // sessione, quindi basta indovinarlo.
    const secret = typeof hopSecret === 'function' ? hopSecret() : hopSecret;
    const hopProof = !parsed.route.length && secret
      ? signHop(secret, { method: req.method || 'GET', path, visited })
      : null;
    const headers = cleanHeaders(req.headers, credential, visited, hopProof);
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
    up.write(lines.join('\r\n')); if (head && head.length) up.write(head);
    if (activeSockets && typeof activeSockets.add === 'function') {
      activeSockets.add(socket); activeSockets.add(up);
      const remove = () => { activeSockets.delete(socket); activeSockets.delete(up); };
      socket.once('close', remove); up.once('close', remove);
    }
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => reject(socket, 502)); socket.on('error', () => up.destroy());
}

function reject(socket, code) { try { socket.end(`HTTP/1.1 ${code} Error\r\nConnection: close\r\n\r\n`); } catch (_) {} }

module.exports = {
  isPanelResource, panelAllowedFor, routeHandler,
  MAX_HOPS, ROUTE_DELIMITER, TOPOLOGY_PEER_TIMEOUT_MS, SHARE_NOT_READY_CODE, classifyShareFailure, activeReversePort,
  peerFromToken, peerAllows, canTransit, parseRoute, knownResource, allowedResource, allowedQuery, readonlyBlocksFederated,
  collectTopology, collectTopologyDetailed, collectLocalTopology, peerRouter, localRouter, forwardUpgrade,
  probeHealth, waitForHealthyPeer, canListenLoopback, preflightHubReverse, notifyHubShare, reconcilePeerShare, runShareRevokeBoot, probeReverseOwner,
  hubPoolRequest, verifyHubPoolSlot, reserveHubPoolSlot, commitHubPoolSlot, settleHubPoolSlot, abortHubPoolSlot, getHubPoolStatus,
};
