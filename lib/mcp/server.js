'use strict';
// Server MCP stdio del bridge cella→operatore (`nexuscrew mcp`).
//
// Porta NexusCrew DENTRO le sessioni AI (Claude Code / codex-vl) come server
// MCP: notifiche umane, richieste di attenzione (ask), consegna file, stato
// read-only e directory/invio autenticato tra celle Fleet attive. Il bridge
// parla SOLO con l'HTTP API locale di NexusCrew (loopback + Bearer); le route
// federate applicano ACL e identita' owner-qualified lato server.
//
// Protocollo: JSON-RPC 2.0, UN messaggio JSON per riga (stdio framing MCP).
// Hand-rolled minimale, zero dipendenze SDK (stile del repo). Fail-closed:
// garbage in input non crasha MAI il processo — risponde un errore JSON-RPC.
// Niente log su stdout (corromperebbe il canale): diagnostica su stderr.
//
// Questo modulo e' responsabile SOLO di: config/token/API transport, framing
// JSON-RPC, initialize/ping/tools/list/tools/call, parsing righe, draining e
// startMcp. Il registro TOOLS (nomi/schemi/handler/identity gate) vive in
// `./tools.js`; gli helper cella/deck/topologia (directory, route, payload)
// vivono in `./cells.js`. Entrambi sono re-esportati per compatibilita'.
const readline = require('node:readline');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { loadConfig } = require('../config.js');
const { readTokenSafe } = require('../auth/token.js');
const { isValidSession } = require('../files/store.js');
const VERSION = require('../../package.json').version;
const MCP_COMPANIONS = require('../../mcp-companions.json');
const { TOOLS, IDENTITY_CODE, IDENTITY_REMEDIATION } = require('./tools.js');
const cells = require('./cells.js');

// Versione protocollo di fallback se il client non ne dichiara una valida.
const PROTOCOL_FALLBACK = '2025-03-26';
const HTTP_TIMEOUT_MS = 10000;

// JSON-RPC error codes standard.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function companionInstructions() {
  const catalog = MCP_COMPANIONS.companions
    .map((item) => `${item.id}: ${item.name} (${item.repository})`)
    .join('; ');
  return 'Discover the current client tools before recommending another MCP server. '
    + 'If a requested capability is missing, these optional NexusCrew companions may cover it: '
    + `${catalog}. Recommend only the capability actually needed and ask before installing `
    + 'software, changing MCP configuration, starting services or requesting credentials. '
    + 'NexusCrew does not install or configure companions automatically.';
}

// --- identita' cella mittente ------------------------------------------------
// Ordine (design §1, INVARIATO): $TMUX presente -> `tmux display-message -p '#S'`
// (nome sessione reale); se fallisce/invalida -> fallback env NEXUSCREW_MCP_SESSION;
// altrimenti null. I tool che RICHIEDONO la sessione restano fail-closed.
// execFile argv diretto: mai shell.
//
// `resolveIdentity` rende OSSERVABILE la sorgente della risoluzione (P0):
// ritorna { session, source, code, envPresence, requiredEnvVars, remediation }
// senza cambiare la precedenza e senza esporre valori/segreti. `resolveSession`
// resta il wrapper pubblico Promise<string|null> invariato (compatibilita').
const IDENTITY_REQUIRED_ENV_VARS = Object.freeze(['TMUX', 'TMUX_PANE', 'NEXUSCREW_MCP_SESSION']);

function envPresenceOf(env) {
  return {
    TMUX: !!env.TMUX,
    TMUX_PANE: !!env.TMUX_PANE,
    NEXUSCREW_MCP_SESSION: !!(typeof env.NEXUSCREW_MCP_SESSION === 'string' && env.NEXUSCREW_MCP_SESSION.trim()),
  };
}

function resolveIdentity({ env, tmuxBin, execFileImpl }) {
  const e = env || {};
  const envPresence = envPresenceOf(e);
  const fallbackRaw = e.NEXUSCREW_MCP_SESSION;
  const fallbackPresent = typeof fallbackRaw === 'string' && fallbackRaw.trim().length > 0;
  const tmuxPresent = !!e.TMUX;

  // Prova il fallback NEXUSCREW_MCP_SESSION: ritorna la sessione normalizzata se
  // valida, `false` se presente ma invalida, `null` se assente.
  const tryFallback = () => {
    if (!fallbackPresent) return null;
    const s = fallbackRaw.trim();
    return isValidSession(s) ? s : false;
  };

  // code quando NON identificati: INVALID se c'e' un segnale di identita'
  // (TMUX o NEXUSCREW_MCP_SESSION presente), MISSING altrimenti.
  const codeWhenMissing = () => ((tmuxPresent || fallbackPresent)
    ? IDENTITY_CODE.INVALID : IDENTITY_CODE.MISSING);

  const ok = (session, source) => ({
    session, source, code: IDENTITY_CODE.OK,
    envPresence, requiredEnvVars: IDENTITY_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });
  const missing = () => ({
    session: null, source: 'missing', code: codeWhenMissing(),
    envPresence, requiredEnvVars: IDENTITY_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });

  return new Promise((resolve) => {
    if (!tmuxPresent) {
      const fb = tryFallback();
      return resolve(typeof fb === 'string' ? ok(fb, 'NEXUSCREW_MCP_SESSION') : missing());
    }
    try {
      execFileImpl(tmuxBin, ['display-message', '-p', '#S'], { timeout: 3000 }, (err, stdout) => {
        if (!err) {
          const name = String(stdout || '').trim();
          if (isValidSession(name)) return resolve(ok(name, 'tmux'));
        }
        // tmux fallito/invalido -> precedenza preservata: fallback env.
        const fb = tryFallback();
        resolve(typeof fb === 'string' ? ok(fb, 'NEXUSCREW_MCP_SESSION') : missing());
      });
    } catch (_) {
      const fb = tryFallback();
      resolve(typeof fb === 'string' ? ok(fb, 'NEXUSCREW_MCP_SESSION') : missing());
    }
  });
}

// Wrapper pubblico STORICO: stessi parametri, stesso return Promise<string|null>.
// Mantiene i test esistenti e ogni chiamante esterno che dipende solo dal nome
// della sessione (o null). La diagnostica source/code vive in resolveIdentity.
function resolveSession(opts) {
  return resolveIdentity(opts).then((i) => i.session);
}

// --- server --------------------------------------------------------------------
function createMcpServer(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const env = opts.env || process.env;
  const execFileImpl = opts.execFileImpl || execFile;
  const fetchImpl = opts.fetchImpl || fetch;
  const idFactory = opts.idFactory || (() => crypto.randomUUID());
  const errlog = opts.errlog || ((s) => { try { process.stderr.write(`${s}\n`); } catch (_) {} });
  // Config UNICA fonte per porta/token path: stessa risoluzione del server
  // (config.json + env NEXUSCREW_CONFIG_FILE/PORT/TOKEN_FILE). opts.config per test.
  const cfg = opts.config || loadConfig();
  const baseUrl = `http://127.0.0.1:${cfg.port}`;

  // Identita' risolta una volta e cacheata (la sessione tmux non cambia a runtime).
  // Una sola risoluzione condivisa: `identity()` per la diagnostica completa
  // (source/code/presence), `session()` estrae solo il nome per gli handler
  // storici (compatibilita'). Nessuna API/token coinvolta qui.
  let identityP = null;
  const identity = () => {
    if (!identityP) identityP = resolveIdentity({ env, tmuxBin: cfg.tmuxBin || 'tmux', execFileImpl });
    return identityP;
  };
  const session = () => identity().then((i) => i.session);

  // Token letto ad OGNI chiamata (rotazione-friendly), MAI incluso negli errori.
  function readToken() {
    try {
      const t = readTokenSafe(cfg.tokenPath);
      if (t) return t;
    } catch (_) { /* fall-through all'errore uniforme sotto */ }
    throw new Error('token NexusCrew non leggibile: il server e\' inizializzato? (nexuscrew init)');
  }

  async function api(method, apiPath, body) {
    const token = readToken();
    let r;
    try {
      r = await fetchImpl(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`NexusCrew non raggiungibile su ${baseUrl} (${e && e.name === 'TimeoutError' ? 'timeout' : 'server spento?'})`);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? `API ${r.status}: ${j.error}` : `API ${r.status}`);
    return j;
  }

  const ctx = {
    session,
    identity,
    api,
    home: () => env.HOME || os.homedir(),
    fileExists: (p) => { try { return require('node:fs').statSync(p).isFile(); } catch (_) { return false; } },
    messageId: () => String(idFactory()).toLowerCase(),
  };

  function write(msg) {
    try { output.write(`${JSON.stringify(msg)}\n`); } catch (_) { /* pipe chiusa */ }
  }
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  function toolsList() {
    return {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    };
  }

  async function toolsCall(id, params) {
    const name = params && typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return replyError(id, INVALID_PARAMS, `tool sconosciuto: "${name}"`);
    const args = (params && params.arguments && typeof params.arguments === 'object'
      && !Array.isArray(params.arguments)) ? params.arguments : {};
    try {
      const out = await tool.handler(args, ctx);
      reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      // Errore di ESECUZIONE tool: per contratto MCP e' un result con isError,
      // non un errore di protocollo — il modello lo legge e puo' correggersi.
      reply(id, { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true });
    }
  }

  async function handleMessage(msg) {
    // Fail-closed sulla forma: solo oggetti JSON-RPC 2.0 singoli (niente batch).
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return replyError(null, INVALID_REQUEST, 'richiesta non valida (atteso oggetto JSON-RPC)');
    }
    const id = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : undefined;
    // F6 (audit): SOLO JSON-RPC 2.0 — versione assente/errata -> -32600 anche
    // per i messaggi senza id (il no-op vale solo per notification 2.0 valide).
    if (msg.jsonrpc !== '2.0') {
      return replyError(id !== undefined ? id : null, INVALID_REQUEST, 'jsonrpc "2.0" richiesto');
    }
    const method = msg.method;
    if (typeof method !== 'string') {
      // Risposte del client (result/error) o garbage strutturato: ignora le
      // prime, errore sulle seconde solo se hanno un id da agganciare.
      if (id !== undefined && !('result' in msg) && !('error' in msg)) {
        return replyError(id, INVALID_REQUEST, 'method mancante');
      }
      return undefined;
    }
    const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)) ? msg.params : {};

    if (id === undefined) {
      // Notification: nessuna risposta per contratto. Le sconosciute si ignorano.
      return undefined; // 'notifications/initialized' inclusa: no-op
    }
    if (method === 'initialize') {
      const pv = typeof params.protocolVersion === 'string' && params.protocolVersion
        ? params.protocolVersion : PROTOCOL_FALLBACK;
      return reply(id, {
        protocolVersion: pv,
        capabilities: { tools: {} },
        serverInfo: { name: 'nexuscrew', version: VERSION },
        instructions: companionInstructions(),
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, toolsList());
    if (method === 'tools/call') return toolsCall(id, params);
    return replyError(id, METHOD_NOT_FOUND, `metodo non supportato: ${method}`);
  }

  function handleLine(line) {
    const s = String(line).trim();
    if (!s) return Promise.resolve();
    let msg;
    try { msg = JSON.parse(s); } catch (_) {
      replyError(null, PARSE_ERROR, 'JSON non valido');
      return Promise.resolve();
    }
    // Qualunque throw residuo diventa errore JSON-RPC: il processo non muore mai
    // per colpa di un messaggio.
    return Promise.resolve()
      .then(() => handleMessage(msg))
      .catch((e) => {
        errlog(`[nexuscrew mcp] errore interno: ${(e && e.message) || e}`);
        const id = (msg && (typeof msg.id === 'string' || typeof msg.id === 'number')) ? msg.id : null;
        replyError(id, INVALID_REQUEST, 'errore interno');
      });
  }

  let rl = null;
  const inFlight = new Set();
  let inputClosed = false;
  let drainResolve;
  const drained = new Promise((resolve) => { drainResolve = resolve; });
  const maybeDrained = () => {
    if (inputClosed && inFlight.size === 0) drainResolve();
  };
  function start() {
    rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const pending = handleLine(line);
      inFlight.add(pending);
      pending.finally(() => {
        inFlight.delete(pending);
        maybeDrained();
      });
    });
    rl.on('close', () => {
      inputClosed = true;
      maybeDrained();
    });
    return { close: () => { try { rl.close(); } catch (_) {} }, drained };
  }

  return { start, handleLine, toolsList, ctx, cfg: { port: cfg.port, tmuxBin: cfg.tmuxBin } };
}

// Entry del subcomando `nexuscrew mcp`: stdio reale, resta vivo finche' stdin
// e' aperto (il client MCP chiude la pipe per terminare il server).
function startMcp(opts = {}) {
  const srv = createMcpServer(opts);
  const lifecycle = srv.start();
  // Non forzare process.exit su EOF: una tools/call asincrona puo' essere
  // ancora in volo. Una volta drenate le richieste, Node termina naturalmente.
  srv.drained = lifecycle.drained;
  return srv;
}

module.exports = {
  createMcpServer, startMcp, resolveSession, resolveIdentity, TOOLS,
  parseCellTarget: cells.parseCellTarget,
  normalizeCellPayload: cells.normalizeCellPayload,
  readCellDirectory: cells.readCellDirectory,
};
