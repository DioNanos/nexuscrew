'use strict';
// lib/proxy/panel-proxy.js — inoltro del pannello di UNA cella locale.
//
// Perche' esiste: `panelUrl` e' un endpoint su loopback (es. il desktop in
// container). L'iframe della PWA risolve `127.0.0.1` sul browser di CHI GUARDA,
// quindi il pannello di una cella si vede solo stando sulla stessa macchina.
// Questa route mette il traffico dalla parte giusta del loopback.
//
// TRE VINCOLI, che sono il disegno e non dettagli:
//
// 1. LA DESTINAZIONE NON ARRIVA MAI DAL CHIAMANTE. Si risolve dal `panelUrl`
//    della cella indicata, e quella cella deve essere LOCALE. Non e' un
//    port-forward: un cellId sconosciuto o senza pannello e' un rifiuto, non un
//    default. Chi chiama sceglie QUALE cella, mai VERSO DOVE.
//
// 2. IL TOKEN DI NEXUSCREW NON ESCE DA QUI. Il pannello non e' un nodo della
//    federazione: e' un servizio terzo che gira accanto. Inoltrargli la nostra
//    Authorization sarebbe consegnare la credenziale del control plane a un
//    container. L'header viene rimosso, e l'eventuale 401 del pannello resta
//    suo — l'autenticazione al contenuto avviene dentro il frame.
//
// 3. IL VALIDATORE E' QUELLO, NON UN SECONDO. `validPanelUrl` e' importato da
//    fleet/definitions.js, la stessa funzione che accetta il campo quando viene
//    scritto. Riscriverne una copia qui creerebbe due decisioni sullo stesso
//    fatto, e la seconda divergerebbe: e' il difetto che passiamo le giornate a
//    chiudere.
//
// Certificato self-signed: il container tipico serve HTTPS con un certificato
// che nessuno ha firmato, e non possiamo installarlo nel trust store della
// macchina di chi ci ospita. Verso di lui la verifica e' disattivata di
// proposito, ma SOLO se la destinazione e' loopback — e la condizione viene
// ricontrollata qui contro la stessa lista che autorizza il campo, non data per
// scontata dal validatore. Fra noi e una porta della stessa macchina non c'e'
// un uomo in mezzo da temere; verso qualunque altro host la verifica resta
// attiva e il collegamento fallisce invece di degradare in silenzio. In cambio, il browser del visualizzatore parla solo con la NOSTRA
// origine: il frame smette di restare bianco in attesa che qualcuno accetti
// quel certificato in una scheda separata.

const http = require('node:http');
const https = require('node:https');
const { validPanelUrl, PANELURL_LOOPBACK_HOSTS } = require('../fleet/definitions.js');
const { CELL_ID_RE } = require('../live-host/store.js');

const PANEL_TIMEOUT_MS = 30000;

// Hop-by-hop (RFC 7230 §6.1) + Proxy-*: mai inoltrati end-to-end.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// `/api/panel/<cellId>` oppure `/api/panel/<cellId>/<rest...>`.
function splitPanelPath(url) {
  const raw = String(url || '');
  const qIndex = raw.indexOf('?');
  const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const search = qIndex === -1 ? '' : raw.slice(qIndex);
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  const cellId = decodeURIComponent(parts[0]);
  const tail = parts.slice(1);
  // Un `..` verrebbe inoltrato cosi' com'e' e normalizzato dal pannello: non
  // cambia host ne' porta, ma e' comunque un percorso che il chiamante disegna
  // dentro il pannello. Si ferma qui, in entrambe le forme in cui puo' arrivare.
  for (const seg of tail) {
    const decoded = (() => { try { return decodeURIComponent(seg); } catch (_) { return seg; } })();
    if (seg === '..' || decoded === '..') return null;
  }
  const rest = tail.length ? `/${tail.join('/')}` : '/';
  return { cellId, rest, search };
}

// Il token locale puo' viaggiare in query (il browser non puo' mettere header
// sull'upgrade WebSocket): non deve proseguire verso il pannello.
function stripLocalTokenQuery(search) {
  if (!search) return '';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete('token');
  const out = params.toString();
  return out ? `?${out}` : '';
}

// Gli stessi header che il proxy verso i nodi non inoltra. Avevo lasciato
// passare i cookie con la motivazione «sono del pannello»: era **falsa**.
// Dietro questo proxy l'origine e' la NOSTRA, quindi il browser manda i cookie
// del nostro dominio — inoltrarli significherebbe consegnare al container la
// sessione del control plane, esattamente cio' che l'Authorization rimossa
// doveva impedire. E `x-forwarded-*` da un client sono valori che un pannello
// potrebbe credere veri. Rilievo di un audit indipendente.
function isStrippedRequestHeader(key) {
  if (HOP_BY_HOP.has(key)) return true;
  if (key === 'authorization' || key === 'cookie' || key === 'host') return true;
  if (key.startsWith('proxy-')) return true;
  if (key === 'forwarded' || key.startsWith('x-forwarded-')) return true;
  return false;
}

function forwardHeaders(headers, targetHost) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (isStrippedRequestHeader(k.toLowerCase())) continue;
    out[k] = v;
  }
  // L'host deve essere quello della destinazione: un pannello che genera
  // redirect assoluti li costruisce da qui.
  out.host = targetHost;
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// Risolve la destinazione, o dice PERCHE' non si puo'. I motivi restano
// distinti: «cella sconosciuta», «cella senza pannello» e «pannello non valido»
// mandano chi indaga in tre posti diversi, e un rifiuto unico li confonderebbe.
async function resolveTarget(resolveCellPanel, cellId) {
  if (!CELL_ID_RE.test(cellId)) return { ok: false, reason: 'cell-id-invalid' };
  let panelUrl;
  try { panelUrl = await resolveCellPanel(cellId); } catch (_) { return { ok: false, reason: 'fleet-unavailable' }; }
  if (panelUrl === null) return { ok: false, reason: 'fleet-unavailable' };
  if (panelUrl === undefined) return { ok: false, reason: 'cell-unknown' };
  if (panelUrl === '') return { ok: false, reason: 'no-panel' };
  // Stesso validatore della scrittura: se un valore e' finito nello stato per
  // un'altra strada, qui viene fermato comunque.
  if (!validPanelUrl(panelUrl)) return { ok: false, reason: 'panel-url-invalid' };
  const parsed = new URL(panelUrl);
  // Guardia in profondita': la verifica TLS viene disattivata SOLO se la
  // destinazione e' loopback, e questa riga lo ricontrolla contro la stessa
  // lista che autorizza il campo. Se un giorno il validatore ammettesse un host
  // remoto, la disattivazione NON lo seguirebbe: si parlerebbe in TLS
  // verificato, o si fallirebbe — mai in chiaro con un ignoto.
  const loopback = PANELURL_LOOPBACK_HOSTS.has(parsed.hostname);
  return {
    ok: true,
    loopback,
    secure: parsed.protocol === 'https:',
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    hostHeader: parsed.host,
    basePath: parsed.pathname.replace(/\/$/, ''),
  };
}

function joinPath(basePath, rest) {
  if (!basePath) return rest;
  return rest === '/' ? `${basePath}/` : `${basePath}${rest}`;
}

function createPanelProxy({ resolveCellPanel, log = () => {}, requestImpl }) {
  return async function panelProxy(req, res) {
    const parsed = splitPanelPath(req.url);
    if (!parsed) {
      log({ event: 'panel-proxy', outcome: 'rejected', reason: 'no-cell', cell: '' });
      return res.status(404).json({ error: 'pannello non trovato' });
    }
    const target = await resolveTarget(resolveCellPanel, parsed.cellId);
    if (!target.ok) {
      log({ event: 'panel-proxy', outcome: 'rejected', reason: target.reason, cell: parsed.cellId });
      return res.status(404).json({ error: `pannello non disponibile: ${target.reason}` });
    }
    const request = requestImpl || (target.secure ? https.request : http.request);
    const options = {
      host: target.host,
      port: target.port,
      method: req.method,
      path: `${joinPath(target.basePath, parsed.rest)}${stripLocalTokenQuery(parsed.search)}`,
      headers: forwardHeaders(req.headers, target.hostHeader),
      ...(target.secure ? { rejectUnauthorized: !(target.loopback) } : {}),
    };
    let upstream;
    try {
      upstream = request(options, (up) => {
        res.writeHead(up.statusCode, responseHeaders(up.headers));
        up.pipe(res);
      });
    } catch (_) {
      log({ event: 'panel-proxy', outcome: 'error', reason: 'request-failed', cell: parsed.cellId });
      if (!res.headersSent) res.status(502).json({ error: 'pannello non raggiungibile' });
      return;
    }
    upstream.setTimeout(PANEL_TIMEOUT_MS, () => upstream.destroy(new Error('panel timeout')));
    upstream.on('error', () => {
      log({ event: 'panel-proxy', outcome: 'error', reason: 'upstream-error', cell: parsed.cellId });
      if (!res.headersSent) res.status(502).json({ error: 'pannello non raggiungibile' });
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    log({ event: 'panel-proxy', outcome: 'forwarded', cell: parsed.cellId });
    req.pipe(upstream);
  };
}

// Upgrade WebSocket. Un pannello che si apre senza i suoi frame e' nero: un
// inoltro solo-HTTP darebbe esattamente quello, con l'aria di funzionare.
function handlePanelUpgrade({ req, socket, head, resolveCellPanel, verifyToken, log = () => {}, requestImpl }) {
  const kill = () => { try { socket.destroy(); } catch (_) {} };
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return kill(); }
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const given = bearer || url.searchParams.get('token') || '';
  if (!verifyToken(given)) {
    log({ event: 'panel-proxy', outcome: 'rejected', reason: 'unauthorized', cell: '' });
    return kill();
  }
  const parsed = splitPanelPath(req.url.replace(/^\/api\/panel/, ''));
  if (!parsed) return kill();
  Promise.resolve(resolveTarget(resolveCellPanel, parsed.cellId)).then((target) => {
    if (!target.ok) {
      log({ event: 'panel-proxy', outcome: 'rejected', reason: target.reason, cell: parsed.cellId });
      return kill();
    }
    const request = requestImpl || (target.secure ? https.request : http.request);
    const headers = forwardHeaders(req.headers, target.hostHeader);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    let upstream;
    try {
      upstream = request({
        host: target.host,
        port: target.port,
        method: 'GET',
        path: `${joinPath(target.basePath, parsed.rest)}${stripLocalTokenQuery(parsed.search)}`,
        headers,
        ...(target.secure ? { rejectUnauthorized: !(target.loopback) } : {}),
      });
    } catch (_) { return kill(); }
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
      try {
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead && upHead.length) socket.write(upHead);
        if (head && head.length) upSocket.write(head);
      } catch (_) { return kill(); }
      log({ event: 'panel-proxy', outcome: 'upgraded', cell: parsed.cellId });
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const close = () => { try { upSocket.destroy(); } catch (_) {} kill(); };
      upSocket.on('error', close); socket.on('error', close);
      upSocket.on('close', close); socket.on('close', close);
    });
    // Il pannello ha risposto senza accettare l'upgrade: non e' un WebSocket,
    // e fingere il contrario lascerebbe il frame in attesa per sempre.
    upstream.on('response', () => {
      log({ event: 'panel-proxy', outcome: 'rejected', reason: 'upgrade-refused', cell: parsed.cellId });
      kill();
    });
    upstream.on('error', () => {
      log({ event: 'panel-proxy', outcome: 'error', reason: 'upstream-error', cell: parsed.cellId });
      kill();
    });
    upstream.end();
  }).catch(kill);
}

module.exports = { createPanelProxy, handlePanelUpgrade, splitPanelPath, resolveTarget };
