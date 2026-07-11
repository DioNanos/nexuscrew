'use strict';
// Server MCP stdio del bridge cella→operatore (`nexuscrew mcp`).
//
// Porta NexusCrew DENTRO le sessioni AI (Claude Code / codex-vl) come server
// MCP: notifiche umane, richieste di attenzione (ask), consegna file, stato
// read-only. Il bus cella↔cella resta a crewd/crew: questo bridge parla SOLO
// con l'HTTP API locale di NexusCrew (loopback + Bearer).
//
// Protocollo: JSON-RPC 2.0, UN messaggio JSON per riga (stdio framing MCP).
// Hand-rolled minimale, zero dipendenze SDK (stile del repo). Fail-closed:
// garbage in input non crasha MAI il processo — risponde un errore JSON-RPC.
// Niente log su stdout (corromperebbe il canale): diagnostica su stderr.
const readline = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { loadConfig } = require('../config.js');
const { readTokenSafe } = require('../auth/token.js');
const { isValidSession } = require('../files/store.js');
const VERSION = require('../../package.json').version;

// Versione protocollo di fallback se il client non ne dichiara una valida.
const PROTOCOL_FALLBACK = '2025-03-26';
const HTTP_TIMEOUT_MS = 10000;

// JSON-RPC error codes standard.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// --- identita' cella mittente ------------------------------------------------
// Ordine (design §1): $TMUX presente -> `tmux display-message -p '#S'` (nome
// sessione reale); fallback env NEXUSCREW_MCP_SESSION; altrimenti null (i tool
// che RICHIEDONO la sessione falliscono con errore chiaro, nc_notify degrada
// a sender sconosciuto). execFile argv diretto: mai shell.
function resolveSession({ env, tmuxBin, execFileImpl }) {
  const fallback = () => {
    const s = env.NEXUSCREW_MCP_SESSION;
    return (typeof s === 'string' && isValidSession(s.trim())) ? s.trim() : null;
  };
  if (!env.TMUX) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    try {
      execFileImpl(tmuxBin, ['display-message', '-p', '#S'], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(fallback());
        const name = String(stdout || '').trim();
        resolve(isValidSession(name) ? name : fallback());
      });
    } catch (_) { resolve(fallback()); }
  });
}

// --- helper input tool (fail-closed) ------------------------------------------
function argString(args, key, { required = false, max = 4096 } = {}) {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`parametro "${key}" obbligatorio`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`parametro "${key}" deve essere una stringa`);
  if (required && !v.trim()) throw new Error(`parametro "${key}" non puo' essere vuoto`);
  if (v.length > max) throw new Error(`parametro "${key}" troppo lungo (max ${max})`);
  return v;
}

function requireSession(session, tool) {
  if (session) return session;
  throw new Error(
    `${tool}: sessione tmux non identificata — serve $TMUX (dentro tmux) o NEXUSCREW_MCP_SESSION`,
  );
}

// --- definizione tool (prefisso nc_ anti-collisione) ---------------------------
// annotations.readOnlyHint:true sui tool che non mutano nulla (§1).
const TOOLS = [
  {
    name: 'nc_notify',
    description: 'Invia una notifica all\'operatore via NexusCrew (UI aperte + web push). Usala per esiti, avvisi e richieste di attenzione non bloccanti.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'titolo breve della notifica' },
        body: { type: 'string', description: 'dettaglio opzionale' },
        urgency: { type: 'string', enum: ['normal', 'high'], description: 'default normal' },
      },
      required: ['title'],
    },
    async handler(args, ctx) {
      const title = argString(args, 'title', { required: true, max: 200 });
      const body = argString(args, 'body', { max: 2000 });
      const urgency = argString(args, 'urgency', { max: 16 });
      if (urgency !== undefined && urgency !== 'normal' && urgency !== 'high') {
        throw new Error('urgency deve essere "normal" o "high"');
      }
      const session = await ctx.session();
      const payload = { title, ...(body ? { body } : {}), ...(urgency ? { urgency } : {}) };
      if (session) payload.session = session;
      const j = await ctx.api('POST', '/api/notify', payload);
      return { delivered: j.delivered };
    },
  },
  {
    name: 'nc_ask',
    description: 'Pone una domanda all\'operatore e ritorna SUBITO (non bloccare in attesa): la risposta arrivera\' come messaggio incollato in questa sessione tmux, prefissato [human reply · ask#<id>] per default.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'la domanda per l\'operatore' },
        options: { type: 'array', items: { type: 'string' }, description: 'opzioni di risposta rapida (max 8)' },
      },
      required: ['question'],
    },
    async handler(args, ctx) {
      const question = argString(args, 'question', { required: true, max: 2000 });
      if (args.options !== undefined && !Array.isArray(args.options)) {
        throw new Error('options deve essere un array di stringhe');
      }
      const session = requireSession(await ctx.session(), 'nc_ask');
      const j = await ctx.api('POST', '/api/asks', {
        question, ...(args.options ? { options: args.options } : {}), session,
      });
      return {
        askId: j.id,
        note: 'la risposta dell\'operatore arrivera\' come messaggio incollato in questa sessione tmux',
      };
    },
  },
  {
    name: 'nc_send_file',
    description: 'Consegna un file all\'operatore: lo copia nell\'outbox NexusCrew di questa sessione (badge + notifica automatici). Path assoluto sotto HOME.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'path assoluto del file (sotto HOME)' },
        caption: { type: 'string', description: 'didascalia opzionale' },
      },
      required: ['path'],
    },
    async handler(args, ctx) {
      const p = argString(args, 'path', { required: true, max: 4096 });
      const caption = argString(args, 'caption', { max: 500 });
      if (!path.isAbsolute(p)) throw new Error('path deve essere assoluto');
      // Pre-check locale (errore immediato e chiaro); la validazione autoritativa
      // (realpath sotto HOME, file regolare) la rifa' comunque il server.
      if (!ctx.fileExists(p)) throw new Error(`file inesistente: ${p}`);
      const home = ctx.home();
      if (p !== home && !p.startsWith(home + path.sep)) throw new Error('path fuori da HOME');
      const session = requireSession(await ctx.session(), 'nc_send_file');
      const j = await ctx.api('POST', '/api/files/outbox', {
        session, path: p, ...(caption ? { caption } : {}),
      });
      return { name: j.name, box: 'outbox' };
    },
  },
  {
    name: 'nc_status',
    description: 'Stato read-only di NexusCrew: sessioni tmux vive e celle della flotta (se abilitata).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_args, ctx) {
      const s = await ctx.api('GET', '/api/sessions');
      const sessions = (Array.isArray(s.sessions) ? s.sessions : [])
        .map((x) => ({ name: x.name, active: !!x.attached }));
      let fleet = null;
      try {
        const f = await ctx.api('GET', '/api/fleet/status');
        if (f && f.available) {
          fleet = {
            cells: (Array.isArray(f.cells) ? f.cells : []).map((c) => ({
              cell: c.cell, session: c.tmuxSession, engine: c.engine, active: !!c.active,
            })),
          };
        }
      } catch (_) { /* fleet opzionale: assente/disabilitata -> null */ }
      return { sessions, fleet };
    },
  },
  {
    name: 'nc_inbox',
    description: 'Elenca i file ricevuti nell\'inbox NexusCrew di questa sessione (read-only).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_args, ctx) {
      const session = requireSession(await ctx.session(), 'nc_inbox');
      const j = await ctx.api('GET', `/api/files?session=${encodeURIComponent(session)}`);
      return { inbox: Array.isArray(j.inbox) ? j.inbox : [] };
    },
  },
];

// --- server --------------------------------------------------------------------
function createMcpServer(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const env = opts.env || process.env;
  const execFileImpl = opts.execFileImpl || execFile;
  const fetchImpl = opts.fetchImpl || fetch;
  const errlog = opts.errlog || ((s) => { try { process.stderr.write(`${s}\n`); } catch (_) {} });
  // Config UNICA fonte per porta/token path: stessa risoluzione del server
  // (config.json + env NEXUSCREW_CONFIG_FILE/PORT/TOKEN_FILE). opts.config per test.
  const cfg = opts.config || loadConfig();
  const baseUrl = `http://127.0.0.1:${cfg.port}`;

  // Identita' risolta una volta e cacheata (la sessione tmux non cambia a runtime).
  let sessionP = null;
  const session = () => {
    if (!sessionP) sessionP = resolveSession({ env, tmuxBin: cfg.tmuxBin || 'tmux', execFileImpl });
    return sessionP;
  };

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
    api,
    home: () => env.HOME || os.homedir(),
    fileExists: (p) => { try { return require('node:fs').statSync(p).isFile(); } catch (_) { return false; } },
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

module.exports = { createMcpServer, startMcp, resolveSession, TOOLS };
