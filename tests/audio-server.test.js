'use strict';
// tests/audio-server.test.js — Audio Share sul SERVER REALE (createServer).
//
// Questo file esiste per una ragione precisa: un test che inietta le dipendenze
// dentro il router puo' essere verde mentre la feature e' completamente morta in
// produzione, perche' non tocca mai il cablaggio. Qui si avvia il server vero,
// si legge il nodeId dal node store vero, si attende lo stato Fleet vero, e si
// parla via HTTP come farebbe il bridge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const ba = require('../lib/audio/bridge-auth.js');

const SESSION = 'cloud-Dev';
const CELL = 'Dev';

// Adapter fake: conferma l'avvio senza emettere alcun suono.
const fakeAdapter = () => {
  const spoken = [];
  return {
    id: 'fake', installed: true, limits: 'adapter di test: non produce suono',
    spoken,
    speak({ text }) {
      spoken.push(text);
      return { started: true, done: Promise.resolve({ code: 0 }), kill: () => {} };
    },
  };
};

async function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-srv-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const nodeId = nodesStore.loadStore(paths.nodesPath).nodeId;
  const adapter = fakeAdapter();
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 0,
    audioAdapterSeam: adapter,
    fleetSeam: {
      available: true,
      provider: 'seam',
      isCellSession: (s) => s === SESSION,
      capabilities: () => [],
      status: async () => ({
        available: true,
        cells: [
          { cell: CELL, tmuxSession: SESSION, active: true, tmux: true, engine: 'claude', model: '' },
          { cell: 'Dormiente', tmuxSession: 'cloud-Dormiente', active: false, tmux: false, engine: '', model: '' },
        ],
      }),
    },
    ...over,
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const secret = ba.loadOrCreateBridgeSecret(path.join(configDir, 'audio-bridge.key'));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Chiamata firmata come la farebbe il bridge MCP: il payload viene
  // serializzato una volta e la firma copre quei byte.
  const signed = (method, apiPath, body, opts = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = ba.signedHeaders(opts.secret || secret, {
      method, path: apiPath, session: opts.session || SESSION,
      rawBody: payload === undefined ? '' : payload, ...(opts.nonce ? { nonce: opts.nonce } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    return fetch(`${base}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, ...headers,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { body: payload } : {}),
    });
  };
  const plain = (method, apiPath, body, extraHeaders = {}) => fetch(`${base}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setConsent = (consent) => plain('PATCH', '/api/settings/audio/consent', { consent });
  return { base, token, nodeId, secret, adapter, signed, plain, setConsent, configDir };
}

test('boot: il nodeId viene dal node store, non da un campo di config inesistente', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  const res = await s.signed('GET', `/api/audio/capability?target=${s.nodeId}`);
  assert.equal(res.status, 200, 'con un nodeId non risolto la capability sarebbe sempre 403');
  const body = await res.json();
  assert.equal(body.nodeId, s.nodeId);
  assert.equal(body.consent, true);
});

test('forgery: il solo Bearer della UI non basta — nessuna origine, 401', async (t) => {
  const s = await boot(t);
  const res = await s.plain('POST', '/api/audio/speak', { target: s.nodeId, text: 'ciao' });
  assert.equal(res.status, 401, 'il Bearer prova "qualcuno in loopback ce l ha", non "sono la cella X"');
});

test('forgery: session nel body, negli header o in query NON crea un origine', async (t) => {
  const s = await boot(t);
  const vettori = [
    ['body', () => s.plain('POST', '/api/audio/speak', { target: s.nodeId, text: 'x', session: SESSION })],
    ['header', () => s.plain('POST', '/api/audio/speak', { target: s.nodeId, text: 'x' }, { 'x-nexuscrew-cell': CELL })],
    ['query', () => s.plain('POST', `/api/audio/speak?session=${SESSION}`, { target: s.nodeId, text: 'x' })],
  ];
  for (const [nome, call] of vettori) {
    const res = await call();
    assert.equal(res.status, 401, `${nome}: una dichiarazione non e una verifica`);
  }
});

test('forgery: header di hop federato inventato dal client viene rifiutato', async (t) => {
  const s = await boot(t);
  const altro = 'f'.repeat(32);
  const res = await s.plain('POST', '/api/audio/speak', { target: s.nodeId, text: 'x', originCell: 'Evil' }, {
    'x-nexuscrew-visited': `${altro},${s.nodeId}`,
    'x-nexuscrew-hop': 'a'.repeat(64),
  });
  assert.equal(res.status, 401,
    'senza il segreto per-processo la prova di hop non e riproducibile da un client locale');
});

test('bridge firmato: una cella Fleet ATTIVA parla; una sessione non attiva no', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  const ok = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'ciao' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.origin.cell, CELL, 'la cella e quella risolta dallo stato Fleet, non quella dichiarata');
  assert.equal(body.origin.node, s.nodeId);
  assert.equal(body.origin.attested, false, 'origine locale: verificata, non attestata');
  assert.ok(['accepted', 'spoken'].includes(body.status));
  assert.equal(s.adapter.spoken.at(-1), 'ciao');

  const dormiente = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'ciao' }, { session: 'cloud-Dormiente' });
  assert.equal(dormiente.status, 401, 'una cella inattiva non e un origine valida');
  const inventata = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'ciao' }, { session: 'cloud-Inesistente' });
  assert.equal(inventata.status, 401);
});

test('bridge firmato: firma scaduta e replay rifiutati sul server reale', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  const vecchia = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'x' }, { now: () => Date.now() - 120_000 });
  assert.equal(vecchia.status, 401, 'fuori finestra');

  const nonce = 'b'.repeat(32);
  const primo = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'x', utteranceId: 'replay-1234' }, { nonce });
  assert.equal(primo.status, 200);
  const secondo = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'x', utteranceId: 'replay-1234' }, { nonce });
  assert.equal(secondo.status, 401, 'lo stesso nonce non vale due volte, per quanto la firma sia valida');
});

test('bridge firmato: un segreto diverso non passa (il file 0600 e il confine)', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  const res = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'x' }, { secret: 'x'.repeat(43) });
  assert.equal(res.status, 401);
});

test('consenso: default OFF — un nodo capace di parlare rifiuta comunque', async (t) => {
  const s = await boot(t);
  const res = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'ciao' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.status, 'refused');
  assert.equal(body.reason, 'consent');
  assert.equal(s.adapter.spoken.length, 0, 'nessun suono senza consenso');
});

test('consenso: mutabile solo localmente, mai raggiungibile via federation', async (t) => {
  const s = await boot(t);
  const federation = require('../lib/proxy/federation.js');
  assert.equal(federation.knownResource('/settings/audio/consent'), false);
  assert.equal(federation.allowedResource('/audio/consent', 'PATCH'), false);
  const before = await (await s.plain('GET', '/api/settings/audio')).json();
  assert.equal(before.consent, false);
  await s.setConsent(true);
  const after = await (await s.plain('GET', '/api/settings/audio')).json();
  assert.equal(after.consent, true);
});

test('READONLY: speak e una mutazione e viene rifiutato; lo stop resta permesso', async (t) => {
  const s = await boot(t, { readonlyDefault: true });
  const res = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'x' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'readonly');
  const stop = await s.signed('POST', '/api/audio/stop', { target: s.nodeId });
  assert.equal(stop.status, 200, 'un nodo in sola lettura deve comunque poter tacere');
});

test('target: solo instanceId esatto; un target diverso dal nodo locale non viene ritrasmesso', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  for (const bad of ['', '*', 'all', 'zz', `${s.nodeId}x`]) {
    const res = await s.signed('POST', '/api/audio/speak', { target: bad, text: 'x' });
    assert.equal(res.status, 400, `target "${bad}" rifiutato`);
  }
  // Un instanceId valido ma sconosciuto non e' locale: viene instradato e
  // risulta irraggiungibile, mai un successo.
  const res = await s.signed('POST', '/api/audio/speak', { target: 'd'.repeat(32), text: 'x' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'unreachable');
});

test('capability: descrive solo il nodo locale', async (t) => {
  const s = await boot(t);
  const altrui = await s.signed('GET', `/api/audio/capability?target=${'e'.repeat(32)}`);
  assert.equal(altrui.status, 403, 'non e una directory dei nodi altrui');
});

test('status: leggibile solo dalla stessa origine (nodo+cella)', async (t) => {
  const s = await boot(t, {
    fleetSeam: {
      available: true, isCellSession: () => true, capabilities: () => [],
      status: async () => ({
        available: true,
        cells: [
          { cell: CELL, tmuxSession: SESSION, active: true, tmux: true },
          { cell: 'Altra', tmuxSession: 'cloud-Altra', active: true, tmux: true },
        ],
      }),
    },
  });
  await s.setConsent(true);
  const r = await (await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'x' })).json();
  const mine = await s.signed('GET', `/api/audio/speak/status/${r.utteranceId}`);
  assert.equal(mine.status, 200);
  const theirs = await s.signed('GET', `/api/audio/speak/status/${r.utteranceId}`, undefined, { session: 'cloud-Altra' });
  assert.equal(theirs.status, 404, 'per un altra cella l enunciato semplicemente non esiste');
});

test('rate limit: il budget degli enunciati e indipendente e non si scavalca con urgency', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  const esiti = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: `n${i}`, urgency: 'high' });
    esiti.push(res.status);
  }
  assert.ok(esiti.filter((x) => x === 200).length <= 6, `al massimo 6 in finestra (${esiti.join(',')})`);
  assert.ok(esiti.includes(422), 'oltre il tetto si rifiuta esplicitamente');
});

test('nessun broadcast: un enunciato non genera eventi SSE verso altri client', async (t) => {
  const s = await boot(t);
  await s.setConsent(true);
  const controller = new AbortController();
  const sse = await fetch(`${s.base}/api/notify/events?token=${s.token}`, {
    headers: { accept: 'text/event-stream' }, signal: controller.signal,
  }).catch(() => null);
  await s.signed('POST', '/api/audio/speak', { target: s.nodeId, text: 'segreto' });
  if (sse && sse.body) {
    const reader = sse.body.getReader();
    const timeout = new Promise((r) => setTimeout(() => r({ value: null, done: true }), 200));
    const chunk = await Promise.race([reader.read(), timeout]);
    const text = chunk && chunk.value ? Buffer.from(chunk.value).toString('utf8') : '';
    assert.equal(text.includes('segreto'), false, 'il testo di un enunciato non finisce in un canale broadcast');
    try { await reader.cancel(); } catch (_) {}
  }
  controller.abort();
});
