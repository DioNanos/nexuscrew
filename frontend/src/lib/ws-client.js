// Apre un WS verso /ws e implementa il protocollo a tipi-di-frame.
// server->client: binary = byte PTY, text = JSON ({type:'exit'|'error'}).
// client->server: text JSON (attach/resize) o binary (input grezzo).
export function openTerminalSocket({ session, token, cols, rows, readonly = false, takeSize, onData, onExit, onFiles }) {
  // Fail-closed on the "localhost-only" invariant. The token travels in clear only
  // when the origin is loopback (inside the SSH/VPN tunnel); otherwise serve over HTTPS.
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !isLocal) {
    throw new Error('nexuscrew: ws:// rifiutato su origine non-locale e non-TLS (apri via tunnel su localhost o servi in HTTPS)');
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    const frame = { type: 'attach', session, token, cols, rows, readonly };
    if (takeSize !== undefined) frame.takeSize = takeSize;
    ws.send(JSON.stringify(frame));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'exit' && onExit) onExit(msg.code);
      if (msg.type === 'files' && onFiles) onFiles(msg);
    } else if (onData) {
      onData(new Uint8Array(ev.data));
    }
  };
  return {
    sendInput: (data) => {
      if (ws.readyState !== 1) return;
      ws.send(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    },
    resize: (c, r) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r })); },
    action: (name) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'action', name })); },
    close: () => ws.close(),
    raw: ws,
  };
}
