'use strict';
// tests/live-host-bridge.test.js — ponte Live (fetta 3, contratto rev5).
//
// Il test costruisce il sistema REALE e le sue due dipendenze esterne finte:
//   - hub: server express VERO con le route live-host vere (designazione via
//     HTTP, come la legge il ponte) — nessuna fixture che costruisce la
//     designazione a mano;
//   - daemon: server WebSocket VERO su unix socket che parla il protocollo del
//     socket di controllo (initialize → initialized → thread/start) e registra
//     tutto ciò che riceve.
// Il ponte è quello di produzione (lib/live-host/bridge.js), montato come nel
// server reale: la GET va in loopback all'hub vero, il prompt è letto dal path
// vero (filesRoot/cloud-<Cella>/LIVE_PROMPT.md scritto su disco dal test).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const { WebSocketServer } = require('ws');
const { requireToken } = require('../lib/auth/middleware.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');
const { createLiveBridge } = require('../lib/live-host/bridge.js');
const { baseDefaults, defaults } = require('../lib/config.js');

const TOKEN = 'bridge-token-123';
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
const DIR = () => path.join(os.tmpdir(), `lh-bridge-${process.pid}-${Math.random().toString(36).slice(2)}`);

const mockFleet = (cells) => Promise.resolve({
  available: true,
  status: async () => ({ available: true, cells }),
});

// Aspetta una condizione osservabile SENZA budget di macchina: la condizione o
// arriva (verde), o non arriva mai e il test resta appeso — e un gate appeso e'
// un fallimento, fermato dallo stall-watchdog di tests/run-isolated.js. Un
// budget di ms qui misurerebbe la velocita' della macchina, non la proprieta'.
async function aspettaEvento(condizione, passoMs = 25) {
  for (;;) {
    if (condizione()) return;
    await new Promise((r) => setTimeout(r, passoMs));
  }
}

// —— Daemon finto: WebSocket server su unix socket, protocollo V3 ——
// Registra ogni metodo ricevuto. Simula una cella VIVA E OCCUPATA: esiste una
// thread di TUI (existingThread) con un turno in corso — il requisito più
// vincolante del contratto è che il ponte crei conversazioni proprie ANCHE in
// questo stato, senza mai pilotare quella thread.
function makeFakeDaemon({ socketPath, threadId = 'bridge-thread-0001', failThreadStart = false, delayMs = 0 } = {}) {
  const seen = { connections: 0, methods: [], threadStarts: [], threadStops: [] };
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      seen.connections += 1;
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch (_) { return; }
        seen.methods.push(msg.method || `reply#${msg.id}`);
        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { userAgent: 'fake-app-server/test', codexHome: '/tmp/fake-codex-home' },
          }));
        } else if (msg.method === 'initialized') {
          // notifica: il server non risponde
        } else if (msg.method === 'thread/start') {
          seen.threadStarts.push(msg.params || {});
          const respond = () => {
            const payload = failThreadStart
              ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'thread/start rifiutato' } }
              : {
                jsonrpc: '2.0', id: msg.id,
                result: { thread: { id: threadId }, cwd: (msg.params || {}).cwd, model: 'fake', modelProvider: 'fake' },
              };
            ws.send(JSON.stringify(payload));
          };
          // delayMs < 0: veleno che NON finisce mai — la risposta non arriva,
          // senza lasciare timer appesi nel processo di test (un setTimeout
          // enorme terrebbe vivo l'event loop dopo la fine del file).
          if (delayMs > 0) setTimeout(respond, delayMs); else if (delayMs === 0) respond();
        } else if (msg.method === 'thread/stop') {
          seen.threadStops.push((msg.params || {}).threadId || null);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        } else if (msg.method === 'turn/start' || msg.method === 'thread/resume') {
          // Il VERO app-server li accetta — turn/start su qualunque thread
          // esistente, ed e' proprio la ragione per cui il ponte non deve
          // usarli. Un finto che li rifiutasse sarebbe piu' restrittivo del
          // vero e nasconderebbe il pericolo: a provare che il ponte non li usa
          // e' la spia sui metodi, non un errore di comodo. Rilievo di audit.
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { accepted: true } }));
        } else if (msg.method) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'metodo sconosciuto' } }));
        }
      });
    });
  });
  const listen = () => new Promise((resolve, reject) => {
    try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* assente */ }
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const close = () => new Promise((resolve) => {
    wss.clients.forEach((c) => { try { c.terminate(); } catch (_) { /* già chiuso */ } });
    server.close(() => { try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* già rimosso */ } resolve(); });
  });
  return { seen, listen, close, existingThread: 'tui-thread-busy-9999' };
}

// —— Hub + ponte: UN server reale che monta le route live-host vere (col ponte
// dentro, come nel server di produzione) su porta effimera. Il ponte legge la
// designazione da questo stesso server via loopback: cfg.port è la porta reale.
// `slowHubMs > 0` inserisce PRIMA del router una GET / lenta (Express: la prima
// route che matcha vince) per provare il limite dichiarato senza toccare il ponte.
async function boot({
  cells = [],
  enabled = true,
  timeoutMs = 1500,
  hubSnapshot = null,
  daemonOpts = {},
  slowHubMs = 0,
} = {}) {
  const dir = DIR();
  const root = path.join(dir, 'NexusFiles');
  fs.mkdirSync(root, { recursive: true });
  const socketPath = path.join(dir, 'app-server-control.sock');
  const daemon = makeFakeDaemon({ socketPath, ...daemonOpts });
  await daemon.listen();

  const store = createLiveHostStore({ filePath: path.join(dir, 'live-host.json'), now: () => 42000 });
  const hubRequests = { gets: 0, lastAuth: null };
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const cfg = {
    port,
    liveBridgeEnabled: enabled,
    liveBridgeSocketPath: socketPath,
    liveBridgeTimeoutMs: timeoutMs,
    filesRoot: root,
  };
  const fleet = mockFleet(cells);
  const bridge = createLiveBridge({ cfg, fleetP: fleet, tokenGet: () => TOKEN, filesRoot: root });

  // readonly mutabile: il test designa a readonly OFF e poi accende il gate
  // solo per la chiamata al ponte (il readonly blocca anche la designate).
  let ro = false;
  const app = express();
  app.use('/api/live-host', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/') { hubRequests.gets += 1; hubRequests.lastAuth = req.headers.authorization || null; }
    next();
  });
  // Hub che dichiara eleggibile una cella che il roster non conferma: e' il solo
  // modo di raggiungere i rami che distinguono «non c'e' piu'» da «c'e' ma e'
  // spenta». Nel flusso normale l'hub li anticipa entrambi con eligible:false.
  if (hubSnapshot) {
    app.use('/api/live-host', (req, res, next) => {
      if (req.method === 'GET' && req.path === '/') { res.json(hubSnapshot); return; }
      next();
    });
  }
  if (slowHubMs > 0) {
    app.use('/api/live-host', (req, res, next) => {
      if (req.method === 'GET' && req.path === '/') {
        setTimeout(() => res.json({ hostCell: 'never', revision: 9, eligible: true, at: 0 }), slowHubMs);
        return;
      }
      next();
    });
  } else if (slowHubMs < 0) {
    // Veleno che non finisce mai: l'hub resta muto sulla GET DEL PONTE. La
    // prima GET (quella della designate del test) passa: è il contatore
    // hubRequests.gets qui sopra a distinguerle — il middleware del contatore
    // è registrato prima, quindi quando questo gira la GET corrente è già
    // contata. Nessun timer lasciato appeso: l'handle della richiesta muta
    // muore con il server alla chiusura del contesto.
    app.use('/api/live-host', (req, res, next) => {
      if (req.method === 'GET' && req.path === '/' && hubRequests.gets > 1) return;
      next();
    });
  }
  app.use('/api/live-host', requireToken({ get: () => TOKEN }), liveHostRoutes({
    fleetP: fleet, store, readonly: () => ro, bridge,
  }));
  server.on('request', app);

  const base = `http://127.0.0.1:${port}`;
  const ctx = {
    base, dir, root, socketPath, daemon, store, hubRequests,
    setReadonly: (v) => { ro = v; },
    designate: async (cellId) => {
      const rev = (await (await fetch(`${base}/api/live-host`, { headers: H() })).json()).revision;
      return fetch(`${base}/api/live-host/designate`, {
        method: 'POST', headers: H(), body: JSON.stringify({ cellId, expectedRevision: rev }),
      });
    },
    bridgeCall: () => fetch(`${base}/api/live-host/bridge`, { method: 'POST', headers: H(), body: '{}' }),
    close: async () => {
      await new Promise((r) => server.close(r));
      await daemon.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return ctx;
}

const CELLS_NATIVE = (cwd) => ([
  { cell: 'cloud-Alfa', active: true, tmux: true, tmuxSession: 'cloud-Alfa', engine: 'codex-vl.native', cwd },
  { cell: 'cloud-Beta', active: true, tmux: true, tmuxSession: 'cloud-Beta', engine: 'claude.native', cwd },
  { cell: 'cloud-Off', active: false, tmux: false, tmuxSession: 'cloud-Off', engine: 'codex-vl.native', cwd },
]);

const j = (r) => r.json().catch(() => ({}));

test('ponte spento (MC0): nessuna GET, nessuna connessione, none/bridge-disabled', async () => {
  const ctx = await boot({ enabled: false, cells: CELLS_NATIVE('/tmp') });
  try {
    const r = await ctx.bridgeCall();
    assert.equal(r.status, 200);
    const b = await j(r);
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-disabled');
    assert.equal(ctx.hubRequests.gets, 0, 'ponte spento non legge la designazione');
    assert.equal(ctx.daemon.seen.connections, 0, 'ponte spento non si connette mai');
  } finally { await ctx.close(); }
});

test('nessuna designazione: none/no-designation, daemon intatto', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'no-designation');
    assert.equal(ctx.hubRequests.gets, 1, 'una sola lettura per avvio (MC1.4)');
    assert.equal(ctx.hubRequests.lastAuth, `Bearer ${TOKEN}`, 'GET autenticata col token del nodo (MC1.2)');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('designazione su cella non idonea: none/host-ineligible, distinto da no-designation', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    await ctx.designate('cloud-Off'); // nel roster, attiva NO -> eligible false
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'host-ineligible');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('cella senza cwd nello status: none/cell-cwd-unknown (dichiarato, non indovinato)', async () => {
  const cells = [{ cell: 'cloud-Bare', active: true, tmux: true, tmuxSession: 'cloud-Bare', engine: 'codex-vl.native' }];
  const ctx = await boot({ cells });
  try {
    await ctx.designate('cloud-Bare');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'cell-cwd-unknown');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('engine non codex-vl: modalita\' tmux, nessuna thread ponte (JC2)', async () => {
  const cwd = path.join(os.tmpdir(), 'research-home');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    await ctx.designate('cloud-Beta');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'tmux');
    assert.equal(b.cell, 'cloud-Beta');
    assert.equal(b.engine, 'claude.native');
    assert.equal(b.cwd, cwd);
    assert.deepEqual(b.prompt, { applied: false, reason: 'tmux-mode' });
    assert.equal(ctx.daemon.seen.connections, 0, 'modalita\' tmux non tocca il socket di controllo');
  } finally { await ctx.close(); }
});

test('NATIVA con cella OCCUPATA: thread NUOVA del ponte, cwd e prompt per-cella arrivano davvero', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-devauditor');
  fs.mkdirSync(cwd, { recursive: true });
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    // Prompt per-cella scritto nel path VERO da cui il ponte lo legge.
    const promptDir = path.join(ctx.root, 'cloud-Alfa');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'LIVE_PROMPT.md'), 'Regole Live della cella Alfa: opera nel perimetro della cella.\n');

    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());

    assert.equal(b.mode, 'native');
    assert.equal(b.cell, 'cloud-Alfa');
    // Thread PONTE, non quella della TUI occupata (MC3.1 + requisito a meta' lavoro).
    assert.equal(b.threadId, 'bridge-thread-0001');
    assert.notEqual(b.threadId, ctx.daemon.existingThread);
    assert.equal(b.cwd, cwd);

    // Il daemon ha ricevuto ESATTAMENTE il protocollo del ponte: mai turn/start,
    // mai thread/resume, mai fork (MC3 — la spia lo prova, non lo assume).
    assert.deepEqual(ctx.daemon.seen.methods, ['initialize', 'initialized', 'thread/start']);
    assert.equal(ctx.daemon.seen.connections, 1, 'connessione on-demand: una sola per risoluzione');

    // Il contesto è arrivato DAVVERO (non è un 200 che non dice nulla):
    // cwd = directory della cella, developerInstructions = testo del file letto.
    assert.equal(ctx.daemon.seen.threadStarts.length, 1);
    const params = ctx.daemon.seen.threadStarts[0];
    assert.equal(params.cwd, cwd);
    // R2: l'intestazione identità viaggia SEMPRE, PRIMA del prompt per-cella —
    // il fatto (chi sei) precede le istruzioni (come si lavora lì).
    assert.equal(
      params.developerInstructions,
      'Live NexusCrew agganciata alla cella cloud-Alfa (sessione tmux cloud-Alfa).'
        + '\n\nRegole Live della cella Alfa: opera nel perimetro della cella.',
    );

    // Prompt dichiarato applicato, e il testo NON viaggia in risposta (KC3-audit:
    // il contenuto del prompt resta lato nodo).
    assert.deepEqual(b.prompt, { applied: true, source: 'LIVE_PROMPT.md' });
  } finally { await ctx.close(); }
});

test('prompt ASSENTE (ENOENT): l\'identità arriva comunque — developerInstructions è la SOLA intestazione (R2)', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-no-prompt');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'native');
    assert.deepEqual(b.prompt, { applied: false, reason: 'missing' });
    assert.equal(ctx.daemon.seen.threadStarts.length, 1);
    // R2 (2026-08-16): prima, senza LIVE_PROMPT.md il campo non viaggiava e la
    // voce partiva senza sapere chi è — andava a leggere tmux per indovinare.
    // Ora l'intestazione viaggia da sola.
    //
    // Il prezzo, dichiarato: il consumer SOSTITUISCE le proprie developer
    // instructions con quelle ricevute invece di sommarle, quindi una cella
    // senza prompt per-cella non riceve più quelle globali. Scelta accettata,
    // non subita: cambiarla sarebbe un contratto nuovo per ogni client, e la
    // via designata resta LIVE_PROMPT.md della cella. Vedi il blocco MC2 in
    // lib/live-host/bridge.js — questo commento diceva l'opposto fino al terzo
    // giro di revisione, che l'ha trovato qui dopo che era stato corretto
    // altrove: la stessa affermazione viveva in cinque posti.
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella cloud-Alfa (sessione tmux cloud-Alfa).',
      'senza LIVE_PROMPT.md il campo deve portare comunque l\'identità designata',
    );
  } finally { await ctx.close(); }
});

test('R2 identità: cella Fleet e sessione tmux viaggiano DISTINTI nell\'intestazione', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-identity-distinti');
  // cell e tmuxSession DIVERSI (come nel reale: cell 'Dev', sessione
  // 'cloud-Dev'): il test discrimina le due cose — un'intestazione che
  // riportasse una sola delle due passerebbe anche nominando l'altra.
  const cells = [{ cell: 'Dev', active: true, tmux: true, tmuxSession: 'cloud-Dev', engine: 'codex-vl.native', cwd }];
  const ctx = await boot({ cells });
  try {
    // Designazione SENZA prefisso: la stessa forma di live-host.json reale
    // (hostCell: Dev) — copre la via che la voce incontra sul campo.
    await ctx.designate('Dev');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'native');
    assert.equal(b.cell, 'Dev');
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella Dev (sessione tmux cloud-Dev).',
    );
  } finally { await ctx.close(); }
});

test('R2 identità: senza tmuxSession nel roster l\'intestazione dice la cella e basta', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-identity-senza-sessione');
  const cells = [{ cell: 'cloud-Nova', active: true, tmux: true, engine: 'codex-vl.native', cwd }];
  const ctx = await boot({ cells });
  try {
    await ctx.designate('cloud-Nova');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'native');
    // Il roster è la verità: se non dichiara la sessione, il ponte non la
    // indovina dalla convenzione cloud-<Cella>. Il fatto degradato, mai un
    // campo inventato.
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella cloud-Nova.',
    );
    // Stesso motivo vale per il prompt: senza una sessione dichiarata non si
    // costruisce NESSUN path (nemmeno indovinando cloud-<Cella>), quindi non
    // si tenta nemmeno la lettura — 'session-unknown' è un esito DISTINTO da
    // 'missing' ("ho cercato nel posto giusto e non c'è"): qui non si è
    // potuto nemmeno cercare. È il caso dove la prossima assenza silenziosa
    // si nasconderebbe se questo restasse indistinguibile da 'missing'.
    assert.deepEqual(b.prompt, { applied: false, reason: 'session-unknown' });
  } finally { await ctx.close(); }
});

test('prompt ILEGGIBILE (c\'è ma non si può leggere): reason unreadable, DISTINTO da missing', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-bad-prompt');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    // LIVE_PROMPT.md come DIRECTORY: readFileSync fallisce con EISDIR — errore
    // NON-ENOENT affidabile indipendente dall'uid (chmod 000 non lo è su root).
    const promptDir = path.join(ctx.root, 'cloud-Alfa');
    fs.mkdirSync(path.join(promptDir, 'LIVE_PROMPT.md'), { recursive: true });
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'native');
    assert.equal(b.prompt.applied, false);
    assert.equal(b.prompt.reason, 'unreadable');
    // R2: il prompt illeggibile non inietta il suo testo, ma l'identità viaggia.
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella cloud-Alfa (sessione tmux cloud-Alfa).',
    );
  } finally { await ctx.close(); }
});

test('prompt VUOTO: reason empty (presente ma non dice nulla), nessuna iniezione di prompt — identità comunque', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-empty-prompt');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    const promptDir = path.join(ctx.root, 'cloud-Alfa');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'LIVE_PROMPT.md'), '   \n');
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());
    assert.deepEqual(b.prompt, { applied: false, reason: 'empty' });
    // R2: nessuna iniezione DI PROMPT (il file non dice nulla), identità comunque.
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella cloud-Alfa (sessione tmux cloud-Alfa).',
    );
  } finally { await ctx.close(); }
});

// —— docs/LIVE_PROMPT.md: la prova che conta ——
// Non basta che il codice sembri leggere dal path che la documentazione
// descrive: qui si copia il template VERO del repo (non un contenuto
// fittizio) esattamente dove docs/LIVE_PROMPT.md dice che va, e si verifica
// che il daemon riceva davvero quel testo su thread/start. Se la doc mentisse
// sul path, o il ponte lo cercasse altrove, questo test lo troverebbe — un
// test sul solo contenuto del file non lo avrebbe mai potuto vedere.
const TEMPLATES_DIR = path.join(__dirname, '..', 'docs', 'live-prompt-templates');
const TEMPLATE_LANGS = ['it', 'en', 'es'];

for (const lang of TEMPLATE_LANGS) {
  test(`template ${lang}: copiato dove docs/LIVE_PROMPT.md dice che va, il ponte lo legge e lo applica`, async () => {
    const templatePath = path.join(TEMPLATES_DIR, `LIVE_PROMPT.${lang}.md`);
    const templateText = fs.readFileSync(templatePath, 'utf8');
    assert.ok(templateText.trim().length > 0, `il template ${lang} non deve essere vuoto`);

    const cwd = path.join(os.tmpdir(), `cell-template-${lang}`);
    fs.mkdirSync(cwd, { recursive: true });
    const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
    try {
      // Esattamente il path che docs/LIVE_PROMPT.md descrive:
      // <NexusFiles>/cloud-<Cell>/LIVE_PROMPT.md — nessuna rinomina fatta qui
      // per il ponte, solo copia del contenuto del template nel nome fisso.
      const promptDir = path.join(ctx.root, 'cloud-Alfa');
      fs.mkdirSync(promptDir, { recursive: true });
      fs.copyFileSync(templatePath, path.join(promptDir, 'LIVE_PROMPT.md'));

      await ctx.designate('cloud-Alfa');
      const b = await j(await ctx.bridgeCall());

      assert.equal(b.mode, 'native');
      assert.deepEqual(b.prompt, { applied: true, source: 'LIVE_PROMPT.md' },
        `il template ${lang} deve risultare applicato, non ignorato`);
      assert.equal(ctx.daemon.seen.threadStarts.length, 1);
      // Il testo arrivato sul socket e' l'intestazione R2 (sempre anteposta)
      // seguita dal contenuto integrale del template del repo — non un
      // riassunto, non un frammento, e non il solo template senza identita'.
      assert.equal(
        ctx.daemon.seen.threadStarts[0].developerInstructions,
        `Live NexusCrew agganciata alla cella cloud-Alfa (sessione tmux cloud-Alfa).\n\n${templateText.trim()}`,
        `developerInstructions deve essere intestazione + contenuto integrale del template ${lang}`,
      );
    } finally { await ctx.close(); }
  });
}

// —— Il bug trovato scrivendo docs/LIVE_PROMPT.md: il prefisso 'cloud-' era
// FISSO nel codice di readCellPrompt, non dichiarato dal roster. Su un device
// che chiama le proprie sessioni con un prefisso diverso, il prompt non viene
// MAI trovato (o, se il cellId arriva gia' con un prefisso non-cloud-,
// costruisce un path inventato) — e l'esito e' 'missing', cioe' "assenza
// legittima": il difetto si maschera esattamente nel ramo che dovrebbe
// segnalarlo. Questo test scrive il file dove la sessione del roster dice
// DAVVERO che sta (macair-Nova, non cloud-Nova) — e' rosso finche' il ponte
// non usa cell.tmuxSession invece di ricostruire il prefisso a mano.
test('BUG prefisso: un device con prefisso diverso da cloud- deve trovare comunque il prompt', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-prefisso-macair');
  const cells = [{ cell: 'Nova', active: true, tmux: true, tmuxSession: 'macair-Nova', engine: 'codex-vl.native', cwd }];
  const ctx = await boot({ cells });
  try {
    const promptDir = path.join(ctx.root, 'macair-Nova');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'LIVE_PROMPT.md'), 'Regole Live della cella Nova su questo device.\n');

    await ctx.designate('Nova');
    const b = await j(await ctx.bridgeCall());

    assert.equal(b.mode, 'native');
    // Il file C'E' ed E' LEGGIBILE, nella cartella che il roster dichiara
    // davvero: applied deve essere true. Se il ponte cercasse ancora
    // cloud-Nova (che su questo device non esiste), l'esito sarebbe
    // 'missing' — l'assenza legittima che maschera il bug.
    assert.deepEqual(b.prompt, { applied: true, source: 'LIVE_PROMPT.md' });
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella Nova (sessione tmux macair-Nova).'
        + '\n\nRegole Live della cella Nova su questo device.',
    );
  } finally { await ctx.close(); }
});

// Il caso esistente non deve regredire: su un device 'cloud-', comportamento
// identico a prima, byte per byte.
test('BUG prefisso — nessuna regressione: device cloud- invariato', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-prefisso-cloud-invariato');
  const cells = [{ cell: 'Rho', active: true, tmux: true, tmuxSession: 'cloud-Rho', engine: 'codex-vl.native', cwd }];
  const ctx = await boot({ cells });
  try {
    const promptDir = path.join(ctx.root, 'cloud-Rho');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'LIVE_PROMPT.md'), 'Regole Live della cella Rho.\n');

    await ctx.designate('Rho');
    const b = await j(await ctx.bridgeCall());

    assert.deepEqual(b.prompt, { applied: true, source: 'LIVE_PROMPT.md' });
    assert.equal(
      ctx.daemon.seen.threadStarts[0].developerInstructions,
      'Live NexusCrew agganciata alla cella Rho (sessione tmux cloud-Rho).'
        + '\n\nRegole Live della cella Rho.',
    );
  } finally { await ctx.close(); }
});

test('socket di controllo irraggiungibile: none/bridge-socket-failed con cella e detail (MC1.5)', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-no-daemon');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    await ctx.designate('cloud-Alfa');
    await ctx.daemon.close(); // il daemon sparisce: la superficie upstream è rotta (MC0)
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-socket-failed');
    assert.equal(b.cell, 'cloud-Alfa');
    assert.ok(typeof b.detail === 'string' && b.detail.length > 0, 'il fallimento è diagnosticabile');
  } finally { await ctx.close(); }
});

test('thread/start rifiutato dal daemon (error JSON-RPC): none/bridge-socket-failed', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp'), daemonOpts: { failThreadStart: true } });
  try {
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-socket-failed');
    assert.ok(/rifiutato/.test(String(b.detail)));
  } finally { await ctx.close(); }
});

// I due test di bounded-ness usano il VELENO INFINITO (delayMs/slowHubMs < 0:
// la dipendenza non risponde MAI). Allora «il ponte non aspetta» e' la
// RISOLUZIONE stessa col proprio budget (timeoutMs 150), non una misura di
// elapsed. Storia: con veleno finito e soglia elapsed ogni ricalibratura
// (900/800, poi 3000/2000) inseguiva il carico della notte — falso rosso, flake
// documentato in tests/README-flake.md. Un ponte che aspettasse la dipendenza
// resterebbe appeso: il gate lo fermerebbe con lo stall-watchdog.
test('socket LENTO oltre il limite: none/bridge-timeout senza allungare l\'attesa (MC1.5)', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-slow-daemon');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd), timeoutMs: 150, daemonOpts: { delayMs: -1 } });
  try {
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-timeout');
  } finally { await ctx.close(); }
});

test('hub LENTO oltre il limite: none/live-host-timeout (la GET non aspetta)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp'), timeoutMs: 150, slowHubMs: -1 });
  try {
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'live-host-timeout');
  } finally { await ctx.close(); }
});

test('hub IRAGGIUNGIBILE (porta senza nessuno in ascolto): none/live-host-unreachable', async () => {
  // Il ponte con cfg.port verso una porta libera: la GET fallisce a monte.
  // Si chiama resolveForLive() direttamente perché in self-hosting hub e route
  // condividono il server — questo è l'unico modo di avere l'hub GIÙ.
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, 'ctrl.sock');
  const daemon = makeFakeDaemon({ socketPath });
  await daemon.listen();
  try {
    // porta libera: bind+close immediato
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const freePort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const bridge = createLiveBridge({
      cfg: { port: freePort, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 300 },
      fleetP: mockFleet(CELLS_NATIVE('/tmp')),
      tokenGet: () => TOKEN,
      filesRoot: dir,
    });
    const b = await bridge.resolveForLive();
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'live-host-unreachable');
    assert.equal(daemon.seen.connections, 0);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readonly: none/readonly, nessuna connessione (il ponte crea thread: è una mutazione)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    await ctx.designate('cloud-Alfa'); // readonly ancora OFF
    ctx.setReadonly(true);
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'readonly');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('body con parametri: 400 — la risoluzione non è parametrizzabile (MC3.4)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    const r = await fetch(`${ctx.base}/api/live-host/bridge`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cell: 'cloud-Beta' }),
    });
    assert.equal(r.status, 400);
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('senza token: 401 (il ponte sta dietro la stessa auth delle altre /api)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    const r = await fetch(`${ctx.base}/api/live-host/bridge`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('config: chiavi ponte nei default e negli env override (MC0 isolabile)', () => {
  const d = baseDefaults();
  assert.equal(d.liveBridgeEnabled, true);
  assert.ok(d.liveBridgeSocketPath.includes(path.join('.codex', 'app-server-control', 'app-server-control.sock')));
  assert.equal(d.liveBridgeTimeoutMs, 1500);
  const saved = {
    a: process.env.NEXUSCREW_LIVE_BRIDGE,
    b: process.env.NEXUSCREW_LIVE_BRIDGE_SOCKET,
    c: process.env.NEXUSCREW_LIVE_BRIDGE_TIMEOUT_MS,
  };
  try {
    process.env.NEXUSCREW_LIVE_BRIDGE = '0';
    process.env.NEXUSCREW_LIVE_BRIDGE_SOCKET = '/tmp/other.sock';
    process.env.NEXUSCREW_LIVE_BRIDGE_TIMEOUT_MS = '250';
    const e = defaults();
    assert.equal(e.liveBridgeEnabled, false);
    assert.equal(e.liveBridgeSocketPath, '/tmp/other.sock');
    assert.equal(e.liveBridgeTimeoutMs, 250);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// La corsa che lascia una thread ORFANA: thread/start viene processato, ma la
// risposta arriva DOPO che il ponte ha gia' dichiarato il timeout. Il ponte
// fallisce e la thread esiste: se nessuno la chiude, resta viva senza che
// nessuno la usi — un successo parziale dichiarato fallimento. Rilievo di un
// audit indipendente.
test('thread ORFANA: se la risposta arriva dopo il timeout, il ponte chiude comunque la thread', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-orfana');
  fs.mkdirSync(cwd, { recursive: true });
  const ctx = await boot({ cells: CELLS_NATIVE(cwd), timeoutMs: 150, daemonOpts: { delayMs: 400 } });
  try {
    await ctx.designate('cloud-Alfa');
    const b = await j(await ctx.bridgeCall());

    // L'esito per chi ha chiesto il ponte non cambia: e' un fallimento, e resta
    // dichiarato con la sua causa.
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-timeout');

    // Ma la thread era nata davvero, e va chiusa: la chiusura e' un EVENTO del
    // daemon, non un tempo da attendere. Il vecchio sleep(900) era una finestra
    // che sotto carico chiudeva prima dell'evento → finto rosso «thread
    // ORFANA». Se la chiusura non arriva mai, il test resta appeso e il gate lo
    // ferma con lo stall-watchdog: rosso per la ragione giusta.
    await aspettaEvento(() => ctx.daemon.seen.threadStops.length > 0);
    assert.deepEqual(ctx.daemon.seen.threadStops, ['bridge-thread-0001'],
      'la thread nata dopo il timeout viene chiusa, non lasciata orfana');
  } finally { await ctx.close(); }
});

// Tre condizioni diverse meritano tre nomi: un nome solo mandava a guardare
// l'hub anche quando il problema era una sessione chiusa. Rilievo di audit.
test('hub e roster in disaccordo: tre condizioni, tre nomi distinti', async () => {
  // (a) l'hub dichiara eleggibile una cella che il roster NON ha piu'.
  const via = await boot({
    cells: CELLS_NATIVE(os.tmpdir()),
    hubSnapshot: { hostCell: 'cloud-Sparita', revision: 3, eligible: true, at: 0 },
  });
  try {
    const b = await j(await via.bridgeCall());
    assert.equal(b.reason, 'host-cell-unknown',
      'la cella non e piu nel roster: chi legge deve cercare la cella, non l\'idoneita');
  } finally { await via.close(); }

  // (b) l'hub la dichiara eleggibile, ma nel roster e' spenta.
  const spenta = await boot({
    cells: CELLS_NATIVE(os.tmpdir()),
    hubSnapshot: { hostCell: 'cloud-Off', revision: 3, eligible: true, at: 0 },
  });
  try {
    const b = await j(await spenta.bridgeCall());
    assert.equal(b.reason, 'host-cell-inactive',
      'la cella c\'e ma e spenta: si guarda la sessione, non l\'idoneita');
  } finally { await spenta.close(); }
});
