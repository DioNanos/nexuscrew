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
const readline = require('node:readline');
const crypto = require('node:crypto');
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

// Deck layout is stored column-major, while the UI is read row-major. Preserve
// the visual order so an agent sees the same neighbourhood as the operator.
function orderedDeckMembers(deck) {
  const columns = deck && deck.layout && Array.isArray(deck.layout.columns)
    ? deck.layout.columns : [];
  const rows = Math.max(0, ...columns.map((column) => (
    column && Array.isArray(column.tiles) ? column.tiles.length : 0
  )));
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    for (const column of columns) {
      const tile = column && Array.isArray(column.tiles) ? column.tiles[row] : null;
      if (!tile || typeof tile.session !== 'string' || !tile.session) continue;
      const member = { tmuxSession: tile.session };
      if (typeof tile.node === 'string' && tile.node) member.node = tile.node;
      if (typeof tile.ownerId === 'string' && NODE_ID_RE.test(tile.ownerId)) member.ownerId = tile.ownerId;
      out.push(member);
    }
  }
  return out;
}

const NODE_PART_RE = /^[a-z0-9-]{1,32}$/;
const NODE_ID_RE = /^[a-f0-9]{16,64}$/;
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
function fleetStatusPath(node) {
  if (!node) return '/api/fleet/status';
  const parts = String(node).split('/');
  if (!parts.length || parts.some((part) => !NODE_PART_RE.test(part))
    || new Set(parts).size !== parts.length) return null;
  return `/api/route/${parts.map(encodeURIComponent).join('/')}/_/fleet/status`;
}

function fleetCellsBySession(payload) {
  const out = new Map();
  if (!payload || payload.available !== true || !Array.isArray(payload.cells)) return out;
  for (const cell of payload.cells) {
    if (!cell || typeof cell.tmuxSession !== 'string' || !cell.tmuxSession
      || typeof cell.cell !== 'string' || !cell.cell) continue;
    out.set(cell.tmuxSession, cell.cell);
  }
  return out;
}

function routePath(route, resource) {
  if (!Array.isArray(route) || !route.length || route.length > 4
    || route.some((part) => !NODE_PART_RE.test(part)) || new Set(route).size !== route.length) return null;
  return `/api/route/${route.map(encodeURIComponent).join('/')}/_/${resource}`;
}

function topologyOwners(payload) {
  const out = [];
  const seen = new Set();
  for (const node of (payload && Array.isArray(payload.nodes) ? payload.nodes : [])) {
    if (!node || !NODE_ID_RE.test(String(node.instanceId || '')) || seen.has(node.instanceId)
      || !Array.isArray(node.route) || !routePath(node.route, 'decks')) continue;
    seen.add(node.instanceId);
    out.push({
      instanceId: node.instanceId,
      route: [...node.route],
      label: typeof node.label === 'string' && node.label ? node.label : (node.name || node.route.join(' › ')),
      stale: node.stale === true,
    });
  }
  return out;
}

function memberOwnerId(member, deckOwner, ownerTopology) {
  if (member.ownerId && NODE_ID_RE.test(member.ownerId)) return member.ownerId;
  if (!member.node) return deckOwner.instanceId;
  const found = ownerTopology.find((node) => Array.isArray(node.route) && node.route.join('/') === member.node);
  return found ? found.instanceId : null;
}

function parseCellTarget(value) {
  if (typeof value !== 'string') return null;
  const split = value.indexOf(':');
  if (split < 16) return null;
  const instanceId = value.slice(0, split);
  const cell = value.slice(split + 1);
  return NODE_ID_RE.test(instanceId) && CELL_ID_RE.test(cell) ? { instanceId, cell } : null;
}

function normalizeCellPayload(payload, owner, callerSession = null) {
  if (!payload || payload.instanceId !== owner.instanceId || !Array.isArray(payload.cells)) return [];
  const route = owner.route.length ? owner.route.join('/') : 'local';
  const seen = new Set();
  const out = [];
  for (const raw of payload.cells) {
    if (!raw || raw.instanceId !== owner.instanceId || !CELL_ID_RE.test(String(raw.cell || ''))
      || typeof raw.tmuxSession !== 'string' || !isValidSession(raw.tmuxSession)
      || seen.has(raw.cell)) continue;
    seen.add(raw.cell);
    out.push({
      id: `${owner.instanceId}:${raw.cell}`,
      instanceId: owner.instanceId,
      owner: owner.label,
      route,
      cell: raw.cell,
      tmuxSession: raw.tmuxSession,
      engine: typeof raw.engine === 'string' ? raw.engine : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      active: raw.active === true,
      canReceive: raw.canReceive === true,
      lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : null,
      self: owner.route.length === 0 && callerSession === raw.tmuxSession,
    });
  }
  return out;
}

async function readCellDirectory(ctx, callerSession = null) {
  const [config, topology] = await Promise.all([
    ctx.api('GET', '/api/config'), ctx.api('GET', '/api/topology'),
  ]);
  const localId = String(config && config.instanceId || '');
  if (!NODE_ID_RE.test(localId)) throw new Error('instanceId locale non disponibile');
  const owners = [{ instanceId: localId, route: [], label: 'Local', stale: false },
    ...topologyOwners(topology).filter((owner) => !owner.stale && owner.instanceId !== localId)];
  const cells = [];
  const unavailable = [];
  await Promise.all(owners.map(async (owner) => {
    const apiPath = owner.route.length ? routePath(owner.route, 'cells') : '/api/cells';
    if (!apiPath) return;
    try {
      cells.push(...normalizeCellPayload(await ctx.api('GET', apiPath), owner, callerSession));
    } catch (_) {
      unavailable.push({ instanceId: owner.instanceId, owner: owner.label,
        route: owner.route.length ? owner.route.join('/') : 'local' });
    }
  }));
  cells.sort((a, b) => (a.route === 'local' ? -1 : b.route === 'local' ? 1
    : a.route.localeCompare(b.route)) || a.cell.localeCompare(b.cell));
  unavailable.sort((a, b) => a.route.localeCompare(b.route));
  return { nodeId: localId, cells, unavailable };
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
    name: 'nc_deck',
    description: 'Contesto read-only del deck della sessione chiamante: restituisce i deck che la contengono e i relativi membri con nome cella Fleet, sessione tmux e route.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_args, ctx) {
      const tmuxSession = requireSession(await ctx.session(), 'nc_deck');
      const [config, topology, localDecks] = await Promise.all([
        ctx.api('GET', '/api/config'), ctx.api('GET', '/api/topology'), ctx.api('GET', '/api/decks'),
      ]);
      const localNodeId = String(config && config.instanceId || '');
      if (!NODE_ID_RE.test(localNodeId)) throw new Error('instanceId locale non disponibile');
      if (!localDecks || !Array.isArray(localDecks.decks)) throw new Error('risposta deck non valida');

      const remotes = topologyOwners(topology).filter((owner) => !owner.stale && owner.instanceId !== localNodeId);
      const viewerById = new Map([[localNodeId, []], ...remotes.map((owner) => [owner.instanceId, owner.route])]);
      const sources = [{
        owner: { instanceId: localNodeId, route: [], label: 'Local' },
        ownerTopology: topologyOwners(topology), decks: localDecks.decks,
      }];
      await Promise.all(remotes.map(async (owner) => {
        const decksPath = routePath(owner.route, 'decks');
        const topologyPath = routePath(owner.route, 'topology');
        if (!decksPath || !topologyPath) return;
        try {
          const [deckPayload, ownerTopology] = await Promise.all([
            ctx.api('GET', decksPath), ctx.api('GET', topologyPath).catch(() => ({ nodes: [] })),
          ]);
          if (deckPayload && Array.isArray(deckPayload.decks)) {
            sources.push({ owner, ownerTopology: topologyOwners(ownerTopology), decks: deckPayload.decks });
          }
        } catch (_) { /* owner offline/withdrawn: no stale deck disclosure */ }
      }));

      const decks = [];
      for (const source of sources) {
        for (const deck of source.decks) {
          if (!deck || typeof deck.name !== 'string') continue;
          const members = orderedDeckMembers(deck).map((member) => ({
            ...member,
            ownerId: memberOwnerId(member, source.owner, source.ownerTopology),
          }));
          if (!members.some((member) => member.ownerId === localNodeId && member.tmuxSession === tmuxSession)) continue;
          decks.push({
            id: `${source.owner.instanceId}:${deck.name}`,
            name: deck.name,
            owner: { instanceId: source.owner.instanceId, route: source.owner.route.length ? source.owner.route.join('/') : 'local', label: source.owner.label },
            members,
          });
        }
      }
      decks.sort((a, b) => a.owner.route.localeCompare(b.owner.route) || a.name.localeCompare(b.name));

      if (!decks.length) return { tmuxSession, nodeId: localNodeId, decks: [] };

      const routes = new Set(['']);
      for (const deck of decks) for (const member of deck.members) {
        const route = member.ownerId && viewerById.has(member.ownerId)
          ? viewerById.get(member.ownerId).join('/') : null;
        member.viewerRoute = route;
        if (route !== null) routes.add(route);
      }
      const cellsByRoute = new Map();
      await Promise.all([...routes].map(async (route) => {
        const apiPath = fleetStatusPath(route);
        if (!apiPath) return;
        try { cellsByRoute.set(route, fleetCellsBySession(await ctx.api('GET', apiPath))); }
        catch (_) { cellsByRoute.set(route, new Map()); }
      }));

      return {
        tmuxSession, nodeId: localNodeId,
        decks: decks.map((deck) => ({
          id: deck.id, name: deck.name, owner: deck.owner,
          members: deck.members.map((member) => {
            const route = member.viewerRoute;
            return {
              cell: route === null ? null : (cellsByRoute.get(route)?.get(member.tmuxSession) || null),
              tmuxSession: member.tmuxSession,
              ownerId: member.ownerId,
              route: route === null ? 'unavailable' : (route || 'local'),
              self: member.ownerId === localNodeId && member.tmuxSession === tmuxSession,
            };
          }),
        })),
      };
    },
  },
  {
    name: 'nc_cells',
    description: 'Directory read-only di tutte le celle Fleet autorizzate nella rete NexusCrew. Usa l\'id owner-qualified restituito per evitare nomi ambigui.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_args, ctx) {
      const callerSession = await ctx.session();
      return readCellDirectory(ctx, callerSession);
    },
  },
  {
    name: 'nc_send_cell',
    description: 'Invia e sottopone un messaggio a una cella Fleet attiva autorizzata. target deve essere l\'id esatto restituito da nc_cells; submitted non significa lavoro completato.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'id owner-qualified restituito da nc_cells: <instanceId>:<cell>' },
        message: { type: 'string', description: 'messaggio o task da sottoporre (max 8000 caratteri)' },
      },
      required: ['target', 'message'],
    },
    async handler(args, ctx) {
      const targetRef = parseCellTarget(argString(args, 'target', { required: true, max: 128 }));
      if (!targetRef) throw new Error('target non valido: usa l\'id esatto restituito da nc_cells');
      const message = argString(args, 'message', { required: true, max: 8000 });
      for (let i = 0; i < message.length; i += 1) {
        const code = message.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13) continue;
        if (code < 32 || code === 127) throw new Error('message contiene caratteri di controllo non ammessi');
      }
      const callerSession = requireSession(await ctx.session(), 'nc_send_cell');
      const directory = await readCellDirectory(ctx, callerSession);
      const sender = directory.cells.find((cell) => cell.self && cell.active);
      if (!sender) throw new Error('nc_send_cell: la sessione chiamante non e\' una cella Fleet attiva locale');
      const target = directory.cells.find((cell) => cell.instanceId === targetRef.instanceId
        && cell.cell === targetRef.cell);
      if (!target) throw new Error('cella destinataria non trovata nella rete autorizzata');
      if (!target.canReceive) throw new Error('cella destinataria non attiva; nessun messaggio accodato');
      const apiPath = target.route === 'local'
        ? '/api/cells/send' : routePath(target.route.split('/'), 'cells/send');
      if (!apiPath) throw new Error('route destinataria non valida');
      const id = ctx.messageId();
      const receipt = await ctx.api('POST', apiPath, {
        id,
        from: { instanceId: sender.instanceId, cell: sender.cell, tmuxSession: sender.tmuxSession },
        to: { instanceId: target.instanceId, cell: target.cell, tmuxSession: target.tmuxSession },
        message,
      });
      return {
        id: receipt.id,
        status: receipt.status,
        at: receipt.at,
        to: receipt.to,
        note: receipt.note || 'submitted conferma il trasporto, non il completamento del task',
      };
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
  const idFactory = opts.idFactory || (() => crypto.randomUUID());
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
  createMcpServer, startMcp, resolveSession, TOOLS,
  parseCellTarget, normalizeCellPayload, readCellDirectory,
};
