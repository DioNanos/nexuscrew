'use strict';
const crypto = require('node:crypto');
// Bridges ONE WebSocket to ONE PTY attach. Dependencies are injectable for tests.
// Hardening: close on protocol violation, no 2nd attach, clamp cols/rows,
// validated session, backpressure cutoff, errors as JSON with a code.
const MAX_BUFFERED = 12 * 1024 * 1024; // 12 MiB

function clamp(n, lo, hi, def) {
  n = Number(n);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

const ATTACH_TIMEOUT_MS = 15000;
// Mobile handovers and tunnel renegotiation can last longer than a LAN retry.
// Thirty seconds is finite but configurable, so a small host can tune the
// trade-off without making the suspended PTY lifetime unbounded.
const PTY_GRACE_MS = 30000;
const PTY_GRACE_MAX_SESSIONS = 8;
// No PTY output is buffered while detached; this bounds the retained record,
// rather than pretending a stale output buffer is a current terminal screen.
const PTY_GRACE_RECORD_BYTES = 1024;
const PTY_GRACE_MAX_MEMORY_BYTES = PTY_GRACE_MAX_SESSIONS * PTY_GRACE_RECORD_BYTES;

function createPtyGraceStore({
  graceMs = PTY_GRACE_MS,
  maxSessions = PTY_GRACE_MAX_SESSIONS,
  maxMemoryBytes = PTY_GRACE_MAX_MEMORY_BYTES,
  recordBytes = PTY_GRACE_RECORD_BYTES,
  randomBytes = crypto.randomBytes,
} = {}) {
  const suspended = new Map();
  const sessionLimit = Math.max(1, Math.floor(Number(maxSessions) || PTY_GRACE_MAX_SESSIONS));
  const memoryLimit = Math.max(1, Math.floor(Number(maxMemoryBytes) || PTY_GRACE_MAX_MEMORY_BYTES));
  const retainedRecordBytes = Math.max(1, Math.floor(Number(recordBytes) || PTY_GRACE_RECORD_BYTES));
  let memoryBytes = 0;

  const clearRecordTimer = (record) => {
    if (record.graceTimer) clearTimeout(record.graceTimer);
    record.graceTimer = null;
  };

  const issueToken = (record) => {
    if (!record.resumeToken) record.resumeToken = randomBytes(32).toString('base64url');
    return record.resumeToken;
  };

  const releaseRecord = (token, record) => {
    if (suspended.get(token) !== record) return false;
    suspended.delete(token);
    memoryBytes = Math.max(0, memoryBytes - record.graceBytes);
    return true;
  };

  const suspend = (record) => {
    if (!record || record.ended) return null;
    const token = issueToken(record);
    if (!suspended.has(token)
      && (suspended.size >= sessionLimit || memoryBytes + retainedRecordBytes > memoryLimit)) return null;
    clearRecordTimer(record);
    if (!suspended.has(token)) {
      record.graceBytes = retainedRecordBytes;
      memoryBytes += retainedRecordBytes;
    }
    suspended.set(token, record);
    record.graceTimer = setTimeout(() => {
      if (suspended.get(token) !== record) return;
      releaseRecord(token, record);
      record.graceTimer = null;
      record.graceExpired = true;
      try { record.pty.kill(); } catch (_) {}
    }, graceMs);
    if (typeof record.graceTimer.unref === 'function') record.graceTimer.unref();
    return token;
  };

  const resume = (token, session) => {
    if (!token || typeof session !== 'string') return null;
    const record = suspended.get(token);
    if (!record || record.ended || record.session !== session || record.ws) return null;
    releaseRecord(token, record);
    clearRecordTimer(record);
    return record;
  };

  const resumeEnded = (token, session) => {
    if (!token || typeof session !== 'string') return null;
    const record = suspended.get(token);
    if (!record || !record.ended || record.session !== session || record.ws) return null;
    releaseRecord(token, record);
    clearRecordTimer(record);
    return record;
  };

  const close = () => {
    for (const record of suspended.values()) {
      clearRecordTimer(record);
      try { record.pty.kill(); } catch (_) {}
    }
    suspended.clear();
    memoryBytes = 0;
  };

  return {
    issueToken,
    suspend,
    resume,
    resumeEnded,
    close,
    size: () => suspended.size,
    memoryBytes: () => memoryBytes,
    limits: () => ({ maxSessions: sessionLimit, maxMemoryBytes: memoryLimit }),
  };
}

function sendJson(ws, value) {
  try { ws.send(JSON.stringify(value)); } catch (_) {}
}

function bindWs(ws, deps) {
  const { openAttach, verifyToken, isValidSession = () => true, runAction = () => false, countClients = () => 0, defaults = {}, onAttach = () => {}, ptyGrace = null, diagnostics = null, dropCounter = null } = deps;
  let record = null;
  let attached = false;
  let session = null;
  let closeLogged = false;
  // UNA sola riga diagnostica per socket: la prima chiusura vince. Le
  // successive (close + error sullo stesso socket) non generano rumore.
  const logClose = (level, event, message, meta = {}) => {
    if (closeLogged) return;
    closeLogged = true;
    if (!diagnostics) return;
    try { diagnostics.record(level, 'ws', event, message, { cell: session || undefined, ...meta }); } catch (_) {}
  };
  const countDrop = () => {
    if (!dropCounter) return {};
    const snap = dropCounter.recordDrop(session);
    return { drops: snap.drops };
  };

  const detach = () => {
    if (!record || record.ws !== ws) return;
    record.ws = null;
    if (record.ended) return;
    if (!ptyGrace) {
      try { record.pty.kill(); } catch (_) {}
      return;
    }
    if (!ptyGrace.suspend(record)) {
      // A bounded host refuses another suspended PTY instead of exceeding its
      // explicit process/memory budget.
      try { record.pty.kill(); } catch (_) {}
    }
  };

  function fail(code, reason) {
    // Si spegne anche la scadenza pre-attach: un frame rifiutato (token o
    // handshake non validi) chiude gia' il socket, e lasciare il timer vivo
    // fino al close event tiene in piedi un handle senza scopo.
    clearAttachTimer();
    sendJson(ws, { type: 'error', reason });
    // Chiusura INITIATA DAL SERVER: il motivo e' qui, non nel close event.
    // Level warn = sempre visibile (non richiede verbose).
    logClose('warn', 'WS_SERVER_CLOSE', `Server closed socket: ${reason}`, {
      reason: String(reason).slice(0, 48), closeCode: Number(code) || undefined, ...countDrop(),
    });
    try { ws.close(code, reason); } catch (_) {}
  }

  // L'upgrade viene accettato prima dell'autenticazione: il token arriva nel
  // primo frame. Senza una scadenza un socket che non manda MAI l'attach resta
  // aperto e non autenticato a tempo indefinito, e il costo si moltiplica su
  // ogni listener che serve l'app. La finestra e' generosa (un client reale
  // manda l'attach all'apertura) ma non infinita.
  const attachTimeoutMs = Number.isFinite(defaults.attachTimeoutMs)
    ? Math.max(1000, defaults.attachTimeoutMs) : ATTACH_TIMEOUT_MS;
  let attachTimer = setTimeout(() => {
    attachTimer = null;
    if (!attached) fail(4408, 'attach timeout');
  }, attachTimeoutMs);
  if (typeof attachTimer.unref === 'function') attachTimer.unref();
  // Dichiarazione (hoisted): `fail` la chiama ed e' definita piu' sopra.
  function clearAttachTimer() {
    if (attachTimer) { clearTimeout(attachTimer); attachTimer = null; }
  }

  function onMessage(data, isBinary) {
    if (!attached) {
      if (isBinary) return fail(1002, 'binary before attach');
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return fail(1002, 'bad handshake'); }
      if (msg.type !== 'attach') return fail(1002, 'expected attach');
      if (!verifyToken(msg.token)) return fail(4401, 'bad token');

      // Authorization precedes every live-PTY resume. A terminated record is
      // different: its only remaining purpose is to deliver the late exit
      // outcome, so it has an explicit, non-attach path below.
      if (!isValidSession(msg.session)) {
        const ended = ptyGrace && ptyGrace.resumeEnded(msg.reconnectToken, msg.session);
        if (ended) {
          clearAttachTimer();
          sendJson(ws, { type: 'exit', code: ended.exitCode });
          try { ws.close(1000, 'exit'); } catch (_) {}
          return;
        }
        return fail(4404, 'no such session');
      }

      // The capability is bound to the authenticated session and can resume
      // only a still-live PTY. It is never an alternative to isValidSession.
      const resumed = ptyGrace && ptyGrace.resume(msg.reconnectToken, msg.session);
      if (resumed) {
        clearAttachTimer();
        record = resumed;
        record.ws = ws;
        record.readonly = record.readonly || !!msg.readonly;
        attached = true;
        session = record.session;
        onAttach(session, ws);
        logReattach();
        sendJson(ws, { type: 'attached', reconnectToken: record.resumeToken });
        return;
      }
      attached = true;
      clearAttachTimer();
      session = msg.session;
      logReattach();
      // Resize default: when nobody else is attached, drive the session size so a
      // small phone gets a usable (non-clipped) view and clean line editing. When a
      // real terminal is already attached, default to ignore-size so we don't shrink
      // its window. An explicit takeSize from the client always wins.
      // "Segue il focus": garantisce window-size latest sulla sessione (il
      // client usato piu' di recente ne guida la geometria). Fire-and-forget.
      try {
        require('node:child_process').execFile(defaults.tmuxBin || 'tmux',
          ['set-option', '-t', `=${msg.session}:`, 'window-size', 'latest'], () => {});
      } catch (_) {}
      const takeSize = msg.takeSize !== undefined
        ? !!msg.takeSize
        : countClients(msg.session) === 0;
      record = {
        pty: openAttach(msg.session, {
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
        }),
        ws,
        session: msg.session,
        readonly: defaults.readonlyDefault === true || !!msg.readonly,
        takeSize,
        ended: false,
        exitCode: undefined,
        resumeToken: null,
        graceTimer: null,
        graceExpired: false,
      };
      // The token is issued for this record, not for an arbitrary caller.
      if (ptyGrace) record.resumeToken = ptyGrace.issueToken(record);
      onAttach(session, ws);
      record.pty.onData((d) => {
        if (!record.ws) return;
        try { record.ws.send(Buffer.from(d), { binary: true }); } catch (_) { return; }
        if ((record.ws.bufferedAmount || 0) > MAX_BUFFERED) fail(1011, 'backpressure');
      });
      record.pty.onExit((info) => {
        record.ended = true;
        record.exitCode = info && info.exitCode;
        logClose('notice', 'PTY_EXIT', 'Sessione terminata dal PTY', {
          exitCode: typeof record.exitCode === 'number' ? record.exitCode : undefined,
        });
        if (!record.ws) return;
        sendJson(record.ws, { type: 'exit', code: record.exitCode });
        try { record.ws.close(1000, 'exit'); } catch (_) {}
      });
      sendJson(ws, { type: 'attached', reconnectToken: record.resumeToken });
      return;
    }
    // dopo l'attach
    if (isBinary) { if (!record.readonly) record.pty.write(data); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.type === 'attach') return fail(1002, 'already attached'); // no 2nd attach
    if (msg.type === 'resize') record.pty.resize(clamp(msg.cols, 20, 300, 80), clamp(msg.rows, 5, 120, 24));
    // focus: il tile che prende il focus diventa size-owner (promote); perdendolo
    // torna ignore-size (demote). Cosi' N deck/tile sulla stessa sessione NON si
    // contendono la geometria: comanda solo chi ha il focus (§5b size policy).
    else if (msg.type === 'focus') { if (msg.on) record.pty.promote(); else record.pty.demote(); }
    else if (msg.type === 'input' && !record.readonly) record.pty.write(typeof msg.data === 'string' ? msg.data : '');
    else if (msg.type === 'key' && !record.readonly) record.pty.write(typeof msg.seq === 'string' ? msg.seq.slice(0, 64) : '');
    else if (msg.type === 'action') runAction(session, msg.name); // nav window/pane server-side
  }

  // Alla riconnessione la DURATA della caduta e' il gap close->reopen della
  // stessa sessione. Ritorni con gap = notice (sempre visibili); un primo
  // attach senza storia e' debug (solo verbose).
  function logReattach() {
    if (!diagnostics) return;
    if (!dropCounter) return;
    try {
      const reopen = dropCounter.recordReopen(session);
      if (reopen.gapMs != null) {
        diagnostics.record('notice', 'ws', 'WS_REATTACHED', 'Riconnesso dopo una caduta', {
          cell: session, gapMs: reopen.gapMs, drops: reopen.drops,
        });
      } else {
        diagnostics.record('debug', 'ws', 'WS_ATTACHED', 'Attach completato', { cell: session });
      }
    } catch (_) {}
  }

  ws.on('message', onMessage);
  ws.on('close', (code) => {
    clearAttachTimer(); detach();
    if (closeLogged) return;
    const closeCode = Number(code) || undefined;
    if (ws.__ncCloseReason === 'heartbeat-timeout') {
      logClose('warn', 'WS_HEARTBEAT_DROPPED', 'Heartbeat scaduto: connessione mezzo-aperta terminata', { closeCode, ...countDrop() });
    } else if (closeCode === 1006) {
      logClose('warn', 'WS_ABNORMAL_CLOSE', 'Chiusura senza handshake (drop TCP o terminate)', { closeCode, ...countDrop() });
    } else {
      logClose('notice', 'WS_CLIENT_CLOSE', 'Il client ha chiuso la connessione', { closeCode, ...countDrop() });
    }
  });
  ws.on('error', () => { clearAttachTimer(); detach(); });
}
module.exports = { bindWs, clamp, createPtyGraceStore, PTY_GRACE_MS };
