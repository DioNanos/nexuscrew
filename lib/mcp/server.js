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
const {
  normalizeIdentityContext, IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
  IDENTITY_CONTEXT_VERIFIED_ENV_INVALID,
} = require('./identity-schema.js');
const { persistIdentityChannel } = require('./identity-provider.js');

// Versione protocollo di fallback se il client non ne dichiara una valida.
const PROTOCOL_FALLBACK = '2025-03-26';
const HTTP_TIMEOUT_MS = 10000;
const HTTP_TIMEOUT_CODE = 'NEXUSCREW_HTTP_TIMEOUT';
const HTTP_UNREACHABLE_CODE = 'NEXUSCREW_HTTP_UNREACHABLE';
const IDENTITY_CONTEXT_MISSING = 'NEXUSCREW_MCP_IDENTITY_CONTEXT_MISSING';
const IDENTITY_CONTEXT_UNVERIFIED = 'NEXUSCREW_MCP_IDENTITY_CONTEXT_UNVERIFIED';
const IDENTITY_CONTEXT_FROM_MISMATCH = 'NEXUSCREW_MCP_IDENTITY_CONTEXT_FROM_MISMATCH';

function identityContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
// Source order (UNCHANGED): $TMUX present -> tmux display-message (real
// session name); if it fails/is invalid -> env fallback NEXUSCREW_MCP_SESSION;
// otherwise null. The tools that REQUIRE the session stay fail-closed.
// execFile direct argv: never a shell.
//
// Il nome da tmux si chiede con `-t $TMUX_PANE` — target esplicito al
// PANE del chiamante, deterministico e indipendente dall'environ ereditato.
// Senza `-t` il CLI tmux risolve il pane dall'ENVIRON DEL PROCESSO FIGLIO:
// se quel pane è vivo risponde correttamente, ma se è morto (environ stale,
// l'incidente di partenza) ricade sul CLIENT ATTACHED attivo e risponde rc=0
// col nome di quel client — attribuzione errata con sembianze di successo.
// Comportamento misurato su tmux 3.4 con `-t`: pane morto -> rc=0 e stdout
// VUOTO (non un errore): il vuoto è il segnale dello stantio.
//
// `resolveIdentity` rende OSSERVABILE la sorgente della risoluzione:
// ritorna { session, source, code, envPresence, requiredEnvVars, remediation }
// senza cambiare la precedenza e senza esporre valori/segreti. `resolveSession`
// resta il wrapper pubblico Promise<string|null> invariato (compatibilita').
const IDENTITY_REQUIRED_ENV_VARS = Object.freeze(['TMUX', 'TMUX_PANE', 'NEXUSCREW_MCP_SESSION']);
// i nomi dei metadati verified consegnati dal launcher VL (solo su
// sessione bound). Presence only: mai i valori.
const IDENTITY_VERIFIED_ENV_VARS = Object.freeze([
  'NEXUSCREW_VERIFIED_ENV_VERSION',
  'NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID',
  'NEXUSCREW_VERIFIED_CELL_ID',
  'NEXUSCREW_VERIFIED_INCARNATION_ID',
  'NEXUSCREW_VERIFIED_BINDING_ID',
  'NEXUSCREW_VERIFIED_ORIGIN',
  'NEXUSCREW_VERIFIED_THREAD_ID',
]);
const IDENTITY_ALL_REQUIRED_ENV_VARS = Object.freeze([
  ...IDENTITY_REQUIRED_ENV_VARS, ...IDENTITY_VERIFIED_ENV_VARS,
]);

function envPresenceOf(env) {
  const presence = {
    TMUX: !!env.TMUX,
    TMUX_PANE: !!env.TMUX_PANE,
    NEXUSCREW_MCP_SESSION: !!(typeof env.NEXUSCREW_MCP_SESSION === 'string' && env.NEXUSCREW_MCP_SESSION.trim()),
  };
  for (const name of IDENTITY_VERIFIED_ENV_VARS) {
    presence[name] = !!(typeof env[name] === 'string' && env[name].trim());
  }
  return presence;
}

// la fonte verified esiste se ANY dei nomi verified e' presente.
// Presence parziale = fonte presente ma invalida (fail-closed), non assenza.
function verifiedEnvPresent(envPresence) {
  return IDENTITY_VERIFIED_ENV_VARS.some((name) => envPresence[name] === true);
}

function resolveIdentity({ env, tmuxBin, execFileImpl }) {
  const e = env || {};
  const envPresence = envPresenceOf(e);
  // se una qualunque variabile verified e' presente, il percorso
  // legacy e' VETATO (non e' un fallback, e' un percorso alternativo usato
  // solo in assenza totale della verified). La verifica completa (introspezione
  // live/coerente) vive nel provider online; qui il chiamante senza provider
  // riceve comunque un fail-closed nominato invece di un'identita' legacy
  // fabbricata accanto a metadati verified di cui non si puo' garantire la
  // coerenza.
  if (verifiedEnvPresent(envPresence)) {
    return {
      session: null, source: 'verified-env', code: IDENTITY_CODE.VERIFIED_ENV_INVALID,
      envPresence, requiredEnvVars: IDENTITY_ALL_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
    };
  }
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
    envPresence, requiredEnvVars: IDENTITY_ALL_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });
  const missing = () => ({
    session: null, source: 'missing', code: codeWhenMissing(),
    envPresence, requiredEnvVars: IDENTITY_ALL_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });
  // Pane stantio o non verificabile -> NON attribuire. source 'stale-pane'
  // nomina il problema; code STALE_PANE (tools.js).
  const stalePane = () => ({
    session: null, source: 'stale-pane', code: IDENTITY_CODE.STALE_PANE,
    envPresence, requiredEnvVars: IDENTITY_ALL_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });
  // : tmux e fallback env dicono sessioni DIVERSE entrambe valide:
  // identità ambigua -> NON attribuire (nemmeno il fallback: è parte del
  // conflitto). Il code nomina il mismatch, che INVALID non direbbe.
  const sessionMismatch = () => ({
    session: null, source: 'session-mismatch', code: IDENTITY_CODE.SESSION_MISMATCH,
    envPresence, requiredEnvVars: IDENTITY_ALL_REQUIRED_ENV_VARS, remediation: IDENTITY_REMEDIATION,
  });

  return new Promise((resolve) => {
    // Precedenza preservata: prima il fallback env valido, poi l'esito negativo
    // Dato (`missing` storico o `stalePane`).
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
        // tmux 3.4, misura della revisione (probe doppia): pane morto con -t ->
        // rc=0 e stdout VUOTO. Il vuoto è il segnale dello stantio.
        if (!name) return settle(stalePane);
        if (isValidSession(name)) {
          // Se il fallback env è valido ma dice un'altra sessione, le due
          // fonti si contraddicono -> ambiguo, non si attribuisce.
          const fb = tryFallback();
          if (typeof fb === 'string' && fb !== name) return resolve(sessionMismatch());
          return resolve(ok(name, 'tmux'));
        }
        // non-empty but invalid name: precedence preserved, by design.
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

// Contratto del resolver online iniettato dal processo NexusCrew autenticato.
// La normalizzazione condivisa rifiuta contesto incompleto, incoerente o scaduto.

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

  // Identita' locale storica: risolta una volta e cacheata — ma solo se riesce.
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
  // `localIdentity()` serve alla diagnostica completa (source/code/presence),
  // mentre `identity()` puo' essere il resolver online per gli handler nc_*;
  // `session()` estrae solo il nome per gli handler storici (compatibilita').
  // Nessuna API/token coinvolta qui.
  // Iniettabile nei test per non attendere 30 s reali (opts.identityRetryMs).
  const IDENTITY_RETRY_MS = opts.identityRetryMs ?? 30_000;
  let identityP = null;          // promise condivisa in corso/cacheata
  let identityOk = false;        // solo un esito OK resta cacheato a vita
  let identityAttemptAt = 0;     // istante dell'ultimo tentativo (anti-spam)
  const localIdentity = () => {
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
  const identityContextProvider = typeof opts.identityContextProvider === 'function'
    ? opts.identityContextProvider : null;

  // Il percorso online non cachea mai un successo: ogni tools/call ripete il
  // resolver e quindi vede revoche/rotazioni del binding. L'assenza del
  // provider mantiene il comportamento embedded/legacy di D.
  async function identityContext({ tool = 'unknown', sharedRequired = !!identityContextProvider } = {}) {
    if (!identityContextProvider) {
      if (sharedRequired) {
        throw identityContextError(IDENTITY_CONTEXT_MISSING,
          'contesto identita online assente: binding condiviso richiesto');
      }
      const id = await localIdentity();
      if (!id.session) return Object.freeze({ verified: false, mode: 'legacy', ...id, from: null });
      return Object.freeze({
        verified: false, mode: 'legacy', bindingId: null, ownerInstanceId: null,
        cellId: null, tmuxSession: id.session, from: null, ...id,
      });
    }
    let raw;
    try {
      raw = await identityContextProvider({ tool });
    } catch (e) {
      if (e && (e.code === IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE
        || e.code === IDENTITY_CONTEXT_VERIFIED_ENV_INVALID)) throw e;
      throw identityContextError(IDENTITY_CONTEXT_MISSING,
        'contesto identita online non disponibile: binding condiviso rifiutato');
    }
    return normalizeIdentityContext(raw);
  }

  const identity = ({ tool = 'unknown' } = {}) => {
    if (!identityContextProvider) return localIdentity();
    return identityContext({ tool, sharedRequired: true }).then((context) => ({
      session: context.tmuxSession,
      source: identityContextProvider.identitySource === 'verified-env' ? 'verified-env' : 'online',
      code: IDENTITY_CODE.OK,
      envPresence: envPresenceOf(env),
      requiredEnvVars: IDENTITY_REQUIRED_ENV_VARS,
      remediation: IDENTITY_REMEDIATION,
      context,
    }));
  };
  const session = (options = {}) => identity(options).then((i) => i.session);

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
    const identityBinding = opts.identityBinding
      ? { 'x-nexuscrew-identity-binding': JSON.stringify(opts.identityBinding) } : {};
    let r;
    try {
      r = await fetchImpl(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...signed,
          ...identityBinding,
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

  // NC-R. Aggiornare NexusCrew NON cambia il codice gia' caricato dai bridge
  // MCP delle celle attive: ogni processo resta sulla versione con cui e' stato
  // avviato fino al riavvio della cella. Dopo una correzione installata, un
  // bridge ancora attivo puo' quindi restituire l'errore precedente; prima di
  // valutare la correzione vanno confrontate le versioni di hub e bridge.
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

  // Persistenza del canale identity: solo una response authority con proof
  // child puo aggiornarlo. Il canale resta assente nel percorso legacy.
  const persistIdentity = (session, out) => {
    if (!session || !out || out.identityMode !== 'authority' || !out.proof) return false;
    try {
      return persistIdentityChannel({
        tokenPath: cfg.tokenPath,
        session,
        cellId: out.proof.cellId,
        proof: out.proof,
        expiresAt: out.proof.expiresAt,
      });
    } catch (_) {
      return false;
    }
  };

  const ctx = {
    session,
    identity,
    localIdentity,
    identityContext,
    api,
    persistIdentityChannel: persistIdentity,
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
      // Resolve once, before the handler, and reuse the immutable result for
      // every helper it calls. This makes the provider mandatory for every
      // shared tools/call, including read-only diagnostics.
      const sharedContext = identityContextProvider
        ? await identityContext({ tool: name, sharedRequired: true }) : null;
      const sharedProof = sharedContext && typeof identityContextProvider.currentProof === 'function'
        ? identityContextProvider.currentProof() : null;
      const sharedIdentity = sharedContext ? Object.freeze({
        session: sharedContext.tmuxSession,
        source: identityContextProvider.identitySource === 'verified-env'
          ? 'verified-env' : 'online',
        code: IDENTITY_CODE.OK,
        envPresence: envPresenceOf(env),
        requiredEnvVars: IDENTITY_ALL_REQUIRED_ENV_VARS,
        remediation: IDENTITY_REMEDIATION,
        context: sharedContext,
        ...(sharedProof ? { proof: sharedProof } : {}),
      }) : null;
      const requestCtx = {
        ...ctx,
        identity: sharedIdentity ? () => Promise.resolve(sharedIdentity)
          : (options = {}) => ctx.identity({ ...options, tool: name }),
        session: sharedIdentity ? () => Promise.resolve(sharedIdentity.session)
          : (options = {}) => ctx.session({ ...options, tool: name }),
        identityContext: sharedContext ? () => Promise.resolve(sharedContext)
          : (options = {}) => ctx.identityContext({ ...options, tool: name }),
        ...(sharedContext ? {
          // Il binding verificato viaggia con ogni chiamata API della richiesta:
          // il confine server lo ricontrolla prima degli effetti.
          api: (method, apiPath, body, options = {}) => ctx.api(method, apiPath, body, {
            ...options,
            identityBinding: { context: sharedContext, ...(sharedProof ? { proof: sharedProof } : {}) },
          }),
        } : {}),
      };
      const out = await tool.handler(args, requestCtx);
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
    // da revisione: SOLO JSON-RPC 2.0 — versione assente/errata -> -32600 anche
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
  createMcpServer, startMcp, resolveSession, resolveIdentity, normalizeIdentityContext, TOOLS,
  // The vl branch of resolveManagedEngine composes the companion instructions
  // into the per-cell prompt file — vl has no MCP client, this is the only
  // surface through which the text reaches it.
  companionInstructions,
  PROTOCOL_FALLBACK, HTTP_TIMEOUT_MS, HTTP_TIMEOUT_CODE, HTTP_UNREACHABLE_CODE, transportError,
  IDENTITY_CONTEXT_MISSING, IDENTITY_CONTEXT_UNVERIFIED, IDENTITY_CONTEXT_FROM_MISMATCH,
  IDENTITY_CONTEXT_AUTHORITY_UNAVAILABLE,
  parseCellTarget: cells.parseCellTarget,
  normalizeCellPayload: cells.normalizeCellPayload,
  readCellDirectory: cells.readCellDirectory,
};
