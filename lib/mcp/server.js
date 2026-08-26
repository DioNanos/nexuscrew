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
const path = require('node:path');
const { execFile } = require('node:child_process');
const { loadConfig } = require('../config.js');
const { readTokenSafe } = require('../auth/token.js');
const { isValidSession } = require('../files/store.js');
const { loadOrCreateBridgeSecret, signedHeaders } = require('../audio/bridge-auth.js');
const VERSION = require('../../package.json').version;
const MCP_COMPANIONS = require('../../mcp-companions.json');
const { TOOLS, IDENTITY_CODE, IDENTITY_REMEDIATION } = require('./tools.js');
const cells = require('./cells.js');

// Versione protocollo di fallback se il client non ne dichiara una valida.
const PROTOCOL_FALLBACK = '2025-03-26';
const HTTP_TIMEOUT_MS = 10000;
const HTTP_TIMEOUT_CODE = 'NEXUSCREW_HTTP_TIMEOUT';
const HTTP_UNREACHABLE_CODE = 'NEXUSCREW_HTTP_UNREACHABLE';

// Trasporta la causa in forma strutturata tra bridge e directory celle. Il
// messaggio resta per l'operatore, ma la classificazione non dipende dalla
// lingua o da una regex sul testo prodotto da un altro modulo.
function transportError(baseUrl, cause) {
  const timeout = !!(cause && (cause.name === 'TimeoutError' || cause.code === 'ABORT_ERR' || cause.code === 'ETIMEDOUT'));
  const error = new Error(`NexusCrew non raggiungibile su ${baseUrl} (${timeout ? 'timeout' : 'server spento?'})`);
  error.name = 'NexusCrewTransportError';
  error.code = timeout ? HTTP_TIMEOUT_CODE : HTTP_UNREACHABLE_CODE;
  error.cause = cause;
  return error;
}

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
// Ordine delle sorgenti (design §1, INVARIATO): $TMUX presente -> tmux
// display-message (nome sessione reale); se fallisce/invalida -> fallback env
// NEXUSCREW_MCP_SESSION; altrimenti null. I tool che RICHIEDONO la sessione
// restano fail-closed. execFile argv diretto: mai shell.
//
// P0: il nome da tmux si chiede con `-t $TMUX_PANE` — target esplicito al
// PANE del chiamante, deterministico e indipendente dall'environ ereditato.
// Senza `-t` il CLI tmux risolve il pane dall'ENVIRON DEL PROCESSO FIGLIO:
// se quel pane è vivo risponde correttamente, ma se è morto (environ stale,
// l'incidente di partenza) ricade sul CLIENT ATTACHED attivo e risponde rc=0
// col nome di quel client — attribuzione errata con sembianze di successo.
// Comportamento misurato su tmux 3.4 con `-t`: pane morto -> rc=0 e stdout
// VUOTO (non un errore): il vuoto è il segnale dello stantio.
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
  // P0: pane stantio o non verificabile -> NON attribuire. source 'stale-pane'
  // nomina il problema; code STALE_PANE (tools.js).
  const stalePane = () => ({
    session: null, source: 'stale-pane', code: IDENTITY_CODE.STALE_PANE,
    envPresence, requiredEnvVars: IDENTITY_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });
  // P0/R2: tmux e fallback env dicono sessioni DIVERSE entrambe valide:
  // identità ambigua -> NON attribuire (nemmeno il fallback: è parte del
  // conflitto). Il code nomina il mismatch, che INVALID non direbbe.
  const sessionMismatch = () => ({
    session: null, source: 'session-mismatch', code: IDENTITY_CODE.SESSION_MISMATCH,
    envPresence, requiredEnvVars: IDENTITY_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });

  return new Promise((resolve) => {
    // Precedenza preservata: prima il fallback env valido, poi l'esito negativo
    // dato (`missing` storico o `stalePane` P0).
    const settle = (otherwise) => {
      const fb = tryFallback();
      resolve(typeof fb === 'string' ? ok(fb, 'NEXUSCREW_MCP_SESSION') : otherwise());
    };

    if (!tmuxPresent) return settle(missing);

    // Formato del pane id tmux: `%` + cifre. Un TMUX_PANE malformato non viene
    // MAI spedito a tmux (argv diretto, ma niente pattern inattesi) e il pane
    // resta non verificabile -> fail-closed.
    const rawPane = typeof e.TMUX_PANE === 'string' ? e.TMUX_PANE.trim() : '';
    const paneId = /^%\d+$/.test(rawPane) ? rawPane : null;
    if (!paneId) return settle(stalePane);

    try {
      execFileImpl(tmuxBin, ['display-message', '-t', paneId, '-p', '#S'], { timeout: 3000 }, (err, stdout) => {
        if (err) {
          // tmux irraggiungibile/rotto (rc!=0): NON è il percorso dello stantio
          // (un pane morto risponde rc=0, vedi header). Comportamento storico.
          return settle(missing);
        }
        const name = String(stdout || '').trim();
        // tmux 3.4, misura dell'audit (probe A1/A2): pane morto con -t ->
        // rc=0 e stdout VUOTO. Il vuoto è il segnale dello stantio.
        if (!name) return settle(stalePane);
        if (isValidSession(name)) {
          // R2: se il fallback env è valido ma dice un'altra sessione, le due
          // fonti si contraddicono -> ambiguo, non si attribuisce.
          const fb = tryFallback();
          if (typeof fb === 'string' && fb !== name) return resolve(sessionMismatch());
          return resolve(ok(name, 'tmux'));
        }
        // nome non vuoto ma invalido: precedenza preservata, come da design §1.
        settle(missing);
      });
    } catch (_) {
      settle(missing);
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

  // Identita' risolta una volta e cacheata — ma solo se riesce.
  //
  // Perche' il successo e il fallimento hanno vita diversa: una sessione
  // risolta non cambia per la vita del processo (cache storica, invariata);
  // un FALLIMENTO invece non deve restare bloccato per sempre. Il caso reale:
  // questo server MCP parte in un daemon avviato da systemd PRIMA che il
  // server tmux sia raggiungibile, `display-message` fallisce, e con la cache
  // a vita l'identita' restava assente anche dopo che tmux era su. Un
  // fallimento viene quindi ri-tentato, con anti-hammering: al piu' una
  // risoluzione ogni IDENTITY_RETRY_MS finche' non riesce (un tmux rotto non
  // puo' trasformare ogni tool call in una execFile da 3 s).
  // `identity()` per la diagnostica completa (source/code/presence),
  // `session()` estrae solo il nome per gli handler storici (compatibilita').
  // Nessuna API/token coinvolta qui.
  // Iniettabile nei test per non attendere 30 s reali (opts.identityRetryMs).
  const IDENTITY_RETRY_MS = opts.identityRetryMs ?? 30_000;
  let identityP = null;          // promise condivisa in corso/cacheata
  let identityOk = false;        // solo un esito OK resta cacheato a vita
  let identityAttemptAt = 0;     // istante dell'ultimo tentativo (anti-spam)
  const identity = () => {
    if (identityOk) return identityP;
    const now = Date.now();
    if (identityP && now - identityAttemptAt < IDENTITY_RETRY_MS) return identityP;
    identityAttemptAt = now;
    identityP = resolveIdentity({ env, tmuxBin: cfg.tmuxBin || 'tmux', execFileImpl })
      .then((i) => {
        identityOk = i.code === IDENTITY_CODE.OK;
        return i;
      });
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

  // Segreto del bridge: file 0600 accanto al token, distinto dal token stesso.
  // Serve dove il Bearer non basta — Audio Share — perche' il Bearer prova solo
  // "qualcuno in loopback ce l'ha", non "questa e' la cella X".
  const bridgeKeyPath = () => cfg.audioBridgeSecretPath || path.join(path.dirname(cfg.tokenPath), 'audio-bridge.key');

  // `opts.signedSession` attiva la firma HMAC del bridge: copre metodo, path,
  // sessione, timestamp, nonce e i BYTE del body effettivamente inviati. Per
  // questo il payload viene serializzato UNA volta sola e riusato: firmare un
  // JSON e spedirne un altro, anche solo con un ordine di chiavi diverso,
  // produrrebbe una firma valida per un corpo che il server non vede mai.
  async function api(method, apiPath, body, opts = {}) {
    const token = readToken();
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let signed = {};
    if (opts.signedSession) {
      try {
        signed = signedHeaders(loadOrCreateBridgeSecret(bridgeKeyPath()), {
          method, path: apiPath, session: opts.signedSession, rawBody: payload === undefined ? '' : payload,
        });
      } catch (_) {
        throw new Error('segreto bridge audio non leggibile: il server e\' inizializzato? (nexuscrew init)');
      }
    }
    let r;
    try {
      r = await fetchImpl(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...signed,
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) { throw transportError(baseUrl, e); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const base = j.error ? `API ${r.status}: ${j.error}` : `API ${r.status}`;
      throw new Error(base + await disallineamentoDiVersione());
    }
    return j;
  }

  // NC-R. Aggiornare NexusCrew NON aggiorna il bridge MCP delle celle gia' in
  // piedi: quel processo e' partito col codice di prima e ci resta fino al
  // riavvio della cella. Il sintomo e' crudele — si installa una correzione, si
  // riprova, e si riceve l'errore VECCHIO — e chi lo subisce conclude che la
  // correzione non funziona. E' successo il 2026-08-07 su rc.26, a me, e ci ho
  // messo un giro intero a capirlo.
  //
  // Il momento in cui serve saperlo e' esattamente quello in cui qualcosa
  // fallisce, quindi la verifica sta SOLO sul ramo d'errore: a regime non costa
  // niente, e non si puo' nemmeno mettere in cache all'avvio — la versione che
  // cambia e' quella dell'hub, e cambia proprio mentre questo processo vive.
  //
  // Non trasforma mai un errore in un altro: se la verifica fallisce, l'errore
  // originale esce come sarebbe uscito comunque.
  async function disallineamentoDiVersione() {
    try {
      const r = await fetchImpl(`${baseUrl}/api/config`, {
        headers: { authorization: `Bearer ${readToken()}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!r.ok) return '';
      const cfg = await r.json();
      if (typeof cfg.version !== 'string' || cfg.version === VERSION) return '';
      return `\n\nNOTA: questo bridge MCP e' la versione ${VERSION}, l'hub e' la ${cfg.version}.`
        + ' Aggiornare NexusCrew non aggiorna il bridge di una cella gia\' avviata:'
        + ' riavvia questa cella se ti aspettavi un comportamento diverso.';
    } catch (_) {
      return '';
    }
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
  // V-69: il ramo vl di resolveManagedEngine compone le istruzioni companion
  // nel file di prompt per-cella — vl non ha client MCP, questo e' l'unica
  // superficie attraverso cui il testo lo raggiunge.
  companionInstructions,
  PROTOCOL_FALLBACK, HTTP_TIMEOUT_MS, HTTP_TIMEOUT_CODE, HTTP_UNREACHABLE_CODE, transportError,
  parseCellTarget: cells.parseCellTarget,
  normalizeCellPayload: cells.normalizeCellPayload,
  readCellDirectory: cells.readCellDirectory,
};
