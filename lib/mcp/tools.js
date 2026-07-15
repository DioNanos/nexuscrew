'use strict';
// Registro TOOLS del server MCP (`lib/mcp/server.js`) + helper di validazione
// input/sessione fail-closed.
//
// Ogni tool e' prefissato `nc_` (anti-collisione) ed espone name/description/
// inputSchema/annotations (readOnlyHint sui tool read-only) + handler async.
// Gli handler ricevono `ctx` (session/api/home/fileExists/messageId) costruito
// dal server: qui NESSUN transport diretto, solo validazione bounded degli
// argomenti e orchestrazione delle chiamate via ctx.api. Ordine, nomi, schemi,
// handler, identity gate e semantica read/write sono preservati EXACT.
const path = require('node:path');
const {
  NODE_ID_RE, orderedDeckMembers, fleetStatusPath, fleetCellsBySession,
  routePath, topologyOwners, memberOwnerId, parseCellTarget, readCellDirectory,
} = require('./cells.js');

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

module.exports = { TOOLS, argString, requireSession };
