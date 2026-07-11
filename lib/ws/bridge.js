'use strict';
// Bridges ONE WebSocket to ONE PTY attach. Dependencies are injectable for tests.
// Hardening: close on protocol violation, no 2nd attach, clamp cols/rows,
// validated session, backpressure cutoff, errors as JSON with a code.
const MAX_BUFFERED = 12 * 1024 * 1024; // 12 MiB

function clamp(n, lo, hi, def) {
  n = Number(n);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function bindWs(ws, deps) {
  const { openAttach, verifyToken, isValidSession = () => true, runAction = () => false, countClients = () => 0, defaults = {}, onAttach = () => {} } = deps;
  let pty = null;
  let attached = false;
  let session = null;

  function fail(code, reason) {
    try { ws.send(JSON.stringify({ type: 'error', reason })); } catch (_) {}
    try { ws.close(code, reason); } catch (_) {}
  }

  function onMessage(data, isBinary) {
    if (!attached) {
      if (isBinary) return fail(1002, 'binary before attach');
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return fail(1002, 'bad handshake'); }
      if (msg.type !== 'attach') return fail(1002, 'expected attach');
      if (!verifyToken(msg.token)) return fail(4401, 'bad token');
      if (!isValidSession(msg.session)) return fail(4404, 'no such session');
      attached = true;
      session = msg.session;
      onAttach(session, ws);
      // Resize default: when nobody else is attached, drive the session size so a
      // small phone gets a usable (non-clipped) view and clean line editing. When a
      // real terminal is already attached, default to ignore-size so we don't shrink
      // its window. An explicit takeSize from the client always wins.
      const takeSize = msg.takeSize !== undefined
        ? !!msg.takeSize
        : countClients(msg.session) === 0;
      // "Segue il focus": garantisce window-size latest sulla sessione (il
      // client usato piu' di recente ne guida la geometria). Fire-and-forget.
      try {
        require('node:child_process').execFile(defaults.tmuxBin || 'tmux',
          ['set-option', '-t', `=${msg.session}:`, 'window-size', 'latest'], () => {});
      } catch (_) {}
      pty = openAttach(msg.session, {
        // readonlyDefault del server e' un PAVIMENTO, non un default: se il server
        // e' READONLY nessun client puo' declassarlo (msg.readonly:false non deve
        // vincere). Il client puo' solo AGGIUNGERE restrizione (attach read-only
        // su un server read-write). Contratto design §4b(6): READONLY blocca anche
        // le scritture PTY. (fix audit finale: prima il ?? faceva vincere il client.)
        readonly: defaults.readonlyDefault === true || !!msg.readonly,
        takeSize,
        cols: clamp(msg.cols, 20, 300, 80),
        rows: clamp(msg.rows, 5, 120, 24),
        tmuxBin: defaults.tmuxBin || 'tmux',
      });
      pty.onData((d) => {
        try { ws.send(Buffer.from(d), { binary: true }); } catch (_) { return; }
        if ((ws.bufferedAmount || 0) > MAX_BUFFERED) fail(1011, 'backpressure');
      });
      pty.onExit((info) => {
        try { ws.send(JSON.stringify({ type: 'exit', code: info && info.exitCode })); } catch (_) {}
        try { ws.close(1000, 'exit'); } catch (_) {}
      });
      return;
    }
    // dopo l'attach
    if (isBinary) { pty.write(data); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.type === 'attach') return fail(1002, 'already attached'); // no 2nd attach
    if (msg.type === 'resize') pty.resize(clamp(msg.cols, 20, 300, 80), clamp(msg.rows, 5, 120, 24));
    // focus: il tile che prende il focus diventa size-owner (promote); perdendolo
    // torna ignore-size (demote). Cosi' N deck/tile sulla stessa sessione NON si
    // contendono la geometria: comanda solo chi ha il focus (§5b size policy).
    else if (msg.type === 'focus') { if (msg.on) pty.promote(); else pty.demote(); }
    else if (msg.type === 'input') pty.write(typeof msg.data === 'string' ? msg.data : '');
    else if (msg.type === 'key') pty.write(typeof msg.seq === 'string' ? msg.seq.slice(0, 64) : '');
    else if (msg.type === 'action') runAction(session, msg.name); // nav window/pane server-side
  }

  ws.on('message', onMessage);
  ws.on('close', () => { if (pty) pty.kill(); pty = null; });
  ws.on('error', () => { if (pty) pty.kill(); pty = null; });
}
module.exports = { bindWs, clamp };
