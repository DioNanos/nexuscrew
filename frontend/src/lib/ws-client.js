// Apre un WS verso /ws (locale) o /node/<name>/ws (proxy B1) e implementa il
// protocollo a tipi-di-frame.
// server->client: binary = byte PTY, text = JSON ({type:'exit'|'error'}).
// client->server: text JSON (attach/resize) o binary (input grezzo).

// Path+query del WS terminale (puro, testabile in node). Locale: '/ws', token
// nel frame attach come sempre (MAI in URL). Remoto: '/node/<name>/ws' col
// token LOCALE in query — e' il canale di auth dell'upgrade verso il proxy
// (il browser non puo' settare Authorization su un WS); il proxy lo strippa
// prima di inoltrare e inietta lui il token remoto (contratto §4b(2)).
export function wsTarget(node, token) {
  if (!node) return '/ws';
  const route = String(node).split('/').map(encodeURIComponent).join('/');
  return `/api/route/${route}/_/ws?token=${encodeURIComponent(token || '')}`;
}

export function openTerminalSocket({ session, node, token, cols, rows, readonly = false, takeSize, focused, onData, onExit, onFiles, retryBaseMs = 250, retryStableMs = 5000, onRetryScheduled }) {
  // Fail-closed on the "localhost-only" invariant. The token travels in clear only
  // when the origin is loopback (inside the SSH/VPN tunnel); otherwise serve over HTTPS.
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !isLocal) {
    throw new Error('nexuscrew: ws:// rifiutato su origine non-locale e non-TLS (apri via tunnel su localhost o servi in HTTPS)');
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}${wsTarget(node, token)}`;
  let ws = null;
  let stopped = false;
  let terminalEnded = false;
  let retryTimer = null;
  let stableTimer = null;
  let retryAttempt = 0;
  let reconnectToken = null;
  // Focus/size-owner: lo stato desiderato viene ricordato e (ri)mandato all'apertura
  // — cosi' un tile gia' focato al connect promuove appena il WS e' pronto.
  let wantFocus = focused;
  const scheduleReconnect = () => {
    if (stopped || terminalEnded || retryTimer) return;
    const delay = Math.min(5000, Math.max(0, retryBaseMs) * (2 ** Math.min(retryAttempt++, 5)));
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
    };
    current.onmessage = (ev) => {
      if (ws !== current || stopped) return;
      if (typeof ev.data === 'string') {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'attached' && typeof msg.reconnectToken === 'string' && msg.reconnectToken) {
          reconnectToken = msg.reconnectToken;
        }
        if (msg.type === 'exit') { terminalEnded = true; if (onExit) onExit(msg.code); }
        if (msg.type === 'files' && onFiles) onFiles(msg);
      } else if (onData) {
        onData(new Uint8Array(ev.data));
      }
    };
    current.onerror = () => { if (ws === current) try { current.close(); } catch (_) {} };
    current.onclose = (ev) => {
      if (ws !== current || stopped || terminalEnded) return;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      // Protocol/auth/session failures need user action; transient network,
      // service restart and backpressure closes are reconnectable.
      if ([1000, 1002, 4401, 4404].includes(ev?.code)) return;
      scheduleReconnect();
    };
  };
  connect();
  return {
    sendInput: (data) => {
      if (!ws || ws.readyState !== 1) return false;
      try {
        ws.send(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        return true;
      } catch (_) {
        try { ws.close(); } catch (_) {}
        return false;
      }
    },
    isReady: () => !!ws && ws.readyState === 1,
    resize: (c, r) => { cols = c; rows = r; if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r })); },
    action: (name) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'action', name })); },
    // Promuove/demota questo client a size-owner quando prende/perde il focus.
    focus: (on) => { wantFocus = on; if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'focus', on: !!on })); },
    close: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (stableTimer) clearTimeout(stableTimer);
      retryTimer = null;
      stableTimer = null;
      if (ws) try { ws.close(); } catch (_) {}
    },
    get raw() { return ws; },
  };
}
