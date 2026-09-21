// Apre un WS verso /ws (locale) o /node/<name>/ws (proxy B1) e implementa il
// protocollo a tipi-di-frame.
// server->client: binary = byte PTY, text = JSON ({type:'exit'|'error'}).
// client->server: text JSON (attach/resize) o binary (input grezzo).

// Path+query del WS terminale (puro, testabile in node). Locale: '/ws', token
// nel frame attach come sempre (MAI in URL). Remoto: '/node/<name>/ws' col
// token LOCALE in query — e' il canale di auth dell'upgrade verso il proxy
// (il browser non puo' settare Authorization su un WS); il proxy lo strippa
// prima di inoltrare e inietta lui il token remoto (contratto §4b(2)).
import { terminalRuntimeConfig } from './terminal-runtime-config.js';

export function wsTarget(node, token, attachId = null, session = null) {
  if (!node) return '/ws';
  const route = String(node).split('/').map(encodeURIComponent).join('/');
  let url = `/api/route/${route}/_/ws?token=${encodeURIComponent(token || '')}`;
  // l'attachId (e la sessione che identifica) viaggia SOLO nella query —
  // il proxy non de-maschera i frame, quindi non puo' leggerlo dall'attach.
  if (attachId) {
    url += `&attachId=${encodeURIComponent(attachId)}`;
    if (session) url += `&attachSession=${encodeURIComponent(session)}`;
  }
  return url;
}

// 128 bit CASUALI, stabili per (session,node) dentro la SCHEDA. In
// sessionStorage e mai su disco; se lo storage e' negato non si inventa un id
// (senza id il proxy fa una attach nuova, come prima di ).
export function attachIdFor(session, node, storage = null) {
  const store = storage === null ? (typeof sessionStorage !== 'undefined' ? sessionStorage : null) : storage;
  if (!store) return null;
  const key = `nc-attach:${node || 'local'}:${String(session || '')}`;
  try {
    const existing = store.getItem(key);
    if (typeof existing === 'string' && /^[0-9a-f]{32}$/.test(existing)) return existing;
    const bytes = new Uint8Array(16);
    // NIENTE fallback su Math.random: senza una sorgente casuale vera non si
    // emette un id (senza id il proxy fa una attach nuova, come prima).
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== 'function') return null;
    c.getRandomValues(bytes);
    const id = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    store.setItem(key, id);
    return id;
  } catch (_) { return null; }
}

export function openTerminalSocket({
  session, node, token, cols, rows, readonly = false, takeSize, focused, onData, onExit, onFiles, onSnapshot, onLink,
  // I default vengono dalla config del server (terminale); i test possono
  // sempre forzarli passandoli esplicitamente.
  retryBaseMs, retryMaxMs, retryStableMs = 5000, onRetryScheduled, pingMs, deadMs, queuedInputBytes, onQueued,
}) {
  const runtime = terminalRuntimeConfig();
  const baseMs = retryBaseMs === undefined ? runtime.retryBaseMs : retryBaseMs;
  const maxMs = retryMaxMs === undefined ? runtime.retryMaxMs : retryMaxMs;
  const pingMsCfg = pingMs === undefined ? runtime.pingMs : pingMs;
  const deadMsCfg = deadMs === undefined ? runtime.deadMs : deadMs;
  const queueBytes = queuedInputBytes === undefined ? runtime.queuedInputBytes : queuedInputBytes;
  // Fail-closed on the "localhost-only" invariant. The token travels in clear only
  // when the origin is loopback (inside the SSH/VPN tunnel); otherwise serve over HTTPS.
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !isLocal) {
    throw new Error('nexuscrew: ws:// rifiutato su origine non-locale e non-TLS (apri via tunnel su localhost o servi in HTTPS)');
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const attachId = attachIdFor(session, node);
  const url = `${proto}://${location.host}${wsTarget(node, token, attachId, session)}`;
  let ws = null;
  let stopped = false;
  let terminalEnded = false;
  let retryTimer = null;
  let stableTimer = null;
  let retryAttempt = 0;
  let reconnectToken = null;
  // Una caduta GIA' subita: la prossima apertura e' una riconnessione e
  // chiede il resync del buffer (repaint dal capture-pane del server).
  let dropped = false;
  // Liveness : il tunnel che muore senza FIN non produce nessun close TCP
  // — il browser resta convinto di essere connesso e lo schermo si gela. Un
  // ping applicativo a cadenza e un budget di silenzio rendono la caduta
  // OSSERVABILE: nessun dato e nessun pong entro il budget = chiusura nostra,
  // che avvia il backoff.
  let livenessTimer = null;
  let lastSeenAt = 0;
  // ultimo seq di OUTPUT ricevuto. Al ritorno si chiede solo il mancante.
  let lastSeq = null;
  // i tasti digitati mentre il canale è giù non si perdono — si accodano
  // entro un cap e partono IN ORDINE al ritorno.
  const queuedLimit = Math.max(1, Number(queueBytes) || 4096);
  let pendingInput = [];
  let pendingBytes = 0;
  const notifyQueued = () => { if (typeof onQueued === 'function') { try { onQueued(pendingBytes); } catch (_) { /* best effort */ } } };
  const flushPendingInput = () => {
    if (!ws || ws.readyState !== 1 || !pendingInput.length) return;
    const queue = pendingInput;
    pendingInput = []; pendingBytes = 0;
    for (const chunk of queue) { try { ws.send(chunk); } catch (_) { /* il canale è caduto di nuovo: il resto è perso come prima */ } }
    notifyQueued();
  };
  const stopLiveness = () => {
    if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null; }
  };
  const startLiveness = (current) => {
    stopLiveness();
    lastSeenAt = Date.now();
    const pingEvery = Math.max(1, Number(pingMsCfg) || 5000);
    const silentBudget = Math.max(1, Number(deadMsCfg) || 10000);
    livenessTimer = setInterval(() => {
      if (ws !== current || stopped || terminalEnded) { stopLiveness(); return; }
      if (Date.now() - lastSeenAt > silentBudget) {
        stopLiveness();
        try { current.close(4000, 'liveness timeout'); } catch (_) { /* già morto */ }
        return;
      }
      if (current.readyState === 1) {
        try { current.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (_) { /* idem */ }
      }
    }, pingEvery);
    if (typeof livenessTimer.unref === 'function') livenessTimer.unref();
  };
  // Focus/size-owner: lo stato desiderato viene ricordato e (ri)mandato all'apertura
  // — cosi' un tile gia' focato al connect promuove appena il WS e' pronto.
  let wantFocus = focused;
  const scheduleReconnect = () => {
    if (stopped || terminalEnded || retryTimer) return;
    const delay = Math.min(maxMs, Math.max(0, baseMs) * (2 ** Math.min(retryAttempt++, 5)));
    if (typeof onRetryScheduled === 'function') onRetryScheduled(delay);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
  const connect = () => {
    if (stopped || terminalEnded) return;
    const current = new WebSocket(url);
    ws = current;
    current.binaryType = 'arraybuffer';
    current.onopen = () => {
      if (ws !== current || stopped) return;
      // Opening the socket is not proof that it can carry a redraw over a
      // mobile/jittery link. Reset backoff only after this finite stability
      // window; the caller can tune it for the target connection.
      if (stableTimer) clearTimeout(stableTimer);
      const configuredStableMs = Number(retryStableMs);
      const stableMs = Number.isFinite(configuredStableMs) ? Math.max(0, configuredStableMs) : 5000;
      stableTimer = setTimeout(() => {
        stableTimer = null;
        if (ws === current && current.readyState === 1) retryAttempt = 0;
      }, stableMs);
      if (typeof stableTimer.unref === 'function') stableTimer.unref();
      const frame = { type: 'attach', session, token, cols, rows, readonly };
      if (reconnectToken) frame.reconnectToken = reconnectToken;
      if (takeSize !== undefined) frame.takeSize = takeSize;
      current.send(JSON.stringify(frame));
      if (wantFocus !== undefined) current.send(JSON.stringify({ type: 'focus', on: !!wantFocus }));
      // Riconnessione dopo una caduta: se sappiamo DOVE eravamo fermi si chiede
      // il solo tratto mancante; altrimenti il repaint dal pane.
      if (dropped) {
        current.send(JSON.stringify(lastSeq === null ? { type: 'resync' } : { type: 'resume', seq: lastSeq }));
      }
      // La coda parte DOPO l'attach: il server deve sapere chi sta parlando.
      flushPendingInput();
      startLiveness(current);
    };
    current.onmessage = (ev) => {
      if (ws !== current || stopped) return;
      lastSeenAt = Date.now(); // qualunque byte (dati o pong) prova che il canale vive
      if (typeof ev.data === 'string') {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'attached' && typeof msg.reconnectToken === 'string' && msg.reconnectToken) {
          reconnectToken = msg.reconnectToken;
        }
        if (msg.type === 'exit') { terminalEnded = true; if (onExit) onExit(msg.code); }
        if (msg.type === 'files' && onFiles) onFiles(msg);
        if (msg.type === 'snapshot' && onSnapshot) onSnapshot(typeof msg.data === 'string' ? msg.data : '');
        if (msg.type === 'link' && onLink) onLink(msg.state === 'live' ? 'live' : 'reconnecting');
        // Il ring non copre il buco: l'unica via onesta e' ridipingere dal pane.
        if (msg.type === 'resync-needed') { try { current.send(JSON.stringify({ type: 'resync' })); } catch (_) { /* morto */ } }
      } else {
        // Frame di output: [seq 4 byte BE][payload]. Il seq serve alla ripresa;
        // al terminale va SOLO il payload, o i 4 byte comparirebbero a schermo.
        // Il seq è informazione di PROTOCOLLO: si registra anche quando il
        // chiamante non ha passato onData.
        let payload = new Uint8Array(ev.data);
        try {
          if (ev.data && ev.data.byteLength >= 4) {
            lastSeq = new DataView(ev.data).getUint32(0);
            payload = new Uint8Array(ev.data, 4);
          }
        } catch (_) { /* frame non incapsulato: passa com'e' */ }
        if (onData) onData(payload);
      }
    };
    current.onerror = () => { if (ws === current) try { current.close(); } catch (_) {} };
    current.onclose = (ev) => {
      stopLiveness();
      if (ws !== current || stopped || terminalEnded) return;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      // Terminali SOLO per ciò che richiede un'azione dell'utente (auth/acl/
      // sessione inesistente). Tutto il resto — drop di rete (1006), riavvio
      // del servizio (1000/1002), backpressure — riconnette in backoff senza
      // svuotare il buffer del client.
      if ([4401, 4403, 4404].includes(ev?.code)) return;
      dropped = true;
      if (onLink) onLink('reconnecting');
      scheduleReconnect();
    };
  };
  connect();
  return {
    sendInput: (data) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (ws && ws.readyState === 1) {
        try { ws.send(bytes); return true; } catch (_) { try { ws.close(); } catch (_) {} }
      }
      // Canale giù: si accoda entro il cap. Oltre il cap si RIFIUTA — meglio un
      // no esplicito che perdere in silenzio ciò che l'utente ha digitato.
      if (pendingBytes + bytes.length > queuedLimit) return false;
      pendingInput.push(bytes); pendingBytes += bytes.length;
      notifyQueued();
      return true;
    },
    isReady: () => !!ws && ws.readyState === 1,
    resize: (c, r) => { cols = c; rows = r; if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r })); },
    action: (name) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'action', name })); },
    // Promuove/demota questo client a size-owner quando prende/perde il focus.
    focus: (on) => { wantFocus = on; if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'focus', on: !!on })); },
    close: () => {
      stopped = true;
      stopLiveness();
      if (retryTimer) clearTimeout(retryTimer);
      if (stableTimer) clearTimeout(stableTimer);
      retryTimer = null;
      stableTimer = null;
      if (ws) try { ws.close(); } catch (_) {}
    },
    get raw() { return ws; },
  };
}
