'use strict';
// tests/snapshot-schema-e2e.test.js — E2E DALLA SPECIFICA (ciechi
// all'implementazione): un alias importato aperto si chiude SOLO se l'owner
// risponde uno snapshot COMPLETO, VALIDO e FRESCO che non contiene l'ask.
// Qualunque corpo malformato NON deve chiudere niente, su ENTRAMBE le vie:
//   - owner SOTTOSCRITTO   (view del feed client, eventsReceive=true);
//   - owner NON sottoscritto (porta ownerSnapshotAsks, fetch diretta).
// Come tests/ask-resync-e2e.test.js: client REALE via createServer, owner
// finto via HTTP (createServer node), alias aperto seminato in asks.json,
// riconciliazione azionata da GET /api/asks reali.
// Ogni caso negativo impone anche: l'owner viene contattato DAVVERO (non è
// un verde a vuoto) e la GET non fallisce mai (best-effort). Il caso
// POSITIVO per ciascuna via è il controllo che il test sa anche fallire:
// con uno snapshot valido e pulito l'alias SI chiude.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (fn, { tries = 60, what = 'condition' } = {}) => {
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (out) return out;
    await sleep(100);
  }
  return null;
};

// Identità deterministiche e uniche per (caso, via): 32 caratteri hex.
function hexId(label, via) {
  let h = 0;
  for (const ch of `${label}#${via}`) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  const block = h.toString(16).padStart(8, '0');
  return (block + block + block + block).slice(0, 32);
}

// Finestra e cadenze: le GET della riconciliazione stanno a 170 ms di
// distanza, OGNI oltre la finestra minima di 150 ms → ogni GET passa dalla
// porta con la finestra libera (non è uno skip a vuoto).
const WINDOW_MS = 150;
const POLL_MS = 100;

// ---------------------------------------------------------------------------
// Scenario condiviso: owner finto + client reale con alias importato aperto.
// respond(res) scrive la risposta di GET /event-feed/snapshot.
// ---------------------------------------------------------------------------
async function scenario(t, { ownerId, subscribed, respond, tag }) {
  // Owner finto: health sempre buono, snapshot risponde quel che dice il caso,
  // stream SSE aperto e muto (nessun frame: nessuna chiusura via stream, così
  // l'unica cosa che può chiudere l'alias è lo snapshot).
  const hits = { snap: 0, stream: 0, health: 0 };
  const sockets = new Set();
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') { hits.health += 1; return json(200, { ok: true, instanceId: ownerId, eventFeedV1: true }); }
    if (url.includes('/event-feed/snapshot')) { hits.snap += 1; return respond(res); }
    if (url.includes('/event-feed')) {
      hits.stream += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': mute\n\n');
      return; // socket tenuta aperta: chiusa solo dal teardown
    }
    return json(404, { error: 'no stub' });
  });
  fake.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) { try { s.destroy(); } catch (_) {} } try { fake.close(); } catch (_) {} });

  // Client reale con l'alias importato APERTO seminato a mano (stessa forma
  // degli alias che l'import lascia in asks.json).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ncschema-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const aliasId = `alias-${tag}`;
  const ownerAskId = `own-${tag}`;
  const alias = {
    id: aliasId, question: 'alias che non deve chiudersi da solo', options: [],
    session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
    originNode: ownerId, ownerId, ownerAskId,
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });

  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: POLL_MS,
    eventFeedClientMinSnapshotIntervalMs: WINDOW_MS,
    sessionExistsSeam: () => true,
    pasteSeam: () => true,
    askSubmit: () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
  });
  t.after(async () => {
    // Igiene come ask-resync-e2e: prima si spegne la ricezione eventi, poi le socket.
    try {
      const st = nodesStore.loadStore(paths.nodesPath);
      if (st) {
        for (const n of (st.nodes || []).filter((n) => n && n.eventsReceive)) {
          nodesStore.atomicWriteStore(paths.nodesPath, nodesStore.updateNode(st, n.name, { eventsReceive: false }));
        }
      }
    } catch (_) { /* il teardown non puo' dipendere dallo store */ }
    await sleep(60);
    server.close();
    if (watcher) watcher.close();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Peer owner: la via decide se il feed client lo sottoscrive (eventsReceive)
  // o se la riconciliazione passa dalla porta diretta.
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(paths.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: ownerId,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  if (subscribed) st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(paths.nodesPath, st);

  const askState = async () => {
    const r = await fetch(`${base}/api/asks`, { headers: H(token) });
    const list = r.ok ? await r.json() : { asks: [] };
    return {
      status: r.status,
      rec: (list.asks || []).find((a) => a.id === aliasId) || null,
    };
  };
  return { base, token, hits, aliasId, ownerAskId, askState };
}

// ---------------------------------------------------------------------------
// La matrice di corpi: ogni caso produce la risposta GREZZA di
// /event-feed/snapshot. Snapshot valido di riferimento: ownerId del nodo
// interrogato, cursor, viewEpoch, notifications e asks array.
// ---------------------------------------------------------------------------
const validSnapshot = (ownerId, asks) => JSON.stringify({
  ownerId, cursor: '1:1', viewEpoch: 1, notifications: [], asks,
});

const OTHER_NODE = 'f'.repeat(32);

const CASES = [
  ['asks mancante', (o) => {
    const body = JSON.stringify({ ownerId: o, cursor: '1:1', viewEpoch: 1, notifications: [] });
    return { status: 200, ct: 'application/json', body };
  }],
  ['asks null', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, null) })],
  ['asks oggetto al posto di array', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, { id: 'x', question: 'q' }) })],
  ['asks stringa', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, 'not-an-array') })],
  ['elemento di asks senza id', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, [{ question: 'senza id', session: 's' }]) })],
  ['id numerico', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, [{ id: 999, question: 'numerico', session: 's' }]) })],
  ['id stringa vuota', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, [{ id: '', question: 'vuoto', session: 's' }]) })],
  ['elemento null', (o) => ({ status: 200, ct: 'application/json', body: validSnapshot(o, [null]) })],
  ['ownerId mancante', () => {
    const body = JSON.stringify({ cursor: '1:1', viewEpoch: 1, notifications: [], asks: [] });
    return { status: 200, ct: 'application/json', body };
  }],
  ['ownerId di un altro nodo', () => ({ status: 200, ct: 'application/json', body: validSnapshot(OTHER_NODE, []) })],
  ['resyncRequired true', (o) => {
    const body = JSON.stringify({ ownerId: o, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [], resyncRequired: true });
    return { status: 200, ct: 'application/json', body };
  }],
  ['corpo non JSON', () => ({ status: 200, ct: 'application/json', body: '<html>questo non è JSON</html>' })],
  ['JSON troncato', (o) => {
    const whole = validSnapshot(o, []);
    return { status: 200, ct: 'application/json', body: whole.slice(0, whole.length - 10) };
  }],
  ['body vuoto', () => ({ status: 200, ct: 'application/json', body: '' })],
  ['HTTP 200 con content-type sbagliato', (o) => ({ status: 200, ct: 'text/plain', body: validSnapshot(o, []) })],
];

const VIAS = [
  ['non sottoscritto', false],
  ['sottoscritto', true],
];

// ---------------------------------------------------------------------------
// Casi negativi: alias aperto + GET /api/asks reali → l'alias resta APERTO.
// ---------------------------------------------------------------------------
function staysOpenCase([label, makeSpec], [viaName, subscribed]) {
  test(`E2E schema (${viaName}): ${label} — l'alias resta APERTO`, async (t) => {
    const ownerId = hexId(label, viaName);
    assert.notEqual(ownerId, OTHER_NODE, 'id owner colliso con il nodo "altro": cambio seme');
    const spec = makeSpec(ownerId);
    const S = await scenario(t, {
      ownerId, subscribed, tag: `${viaName === 'sottoscritto' ? 's' : 'u'}${CASES.findIndex(([l]) => l === label)}`,
      respond: (res) => { res.writeHead(spec.status, { 'content-type': spec.ct }); res.end(spec.body); },
    });
    // Via sottoscritta: prima si aspetta che la view consumi il primo snapshot
    // (poi la porta della riconciliazione lavora su finestre libere).
    if (subscribed) {
      assert.ok(await waitUntil(() => S.hits.snap >= 1, { tries: 50, what: 'primo snapshot della view' }),
        "la view dell'owner sottoscritto ha consumato il primo snapshot");
    }
    // 4 GET reali, tutte oltre la finestra minima l'una dall'altra: ognuna dà
    // alla riconciliazione una porta libera (più i retry programmati degli
    // skip). La lettura non deve MAI fallire per colpa dell'owner rotto.
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${S.base}/api/asks`, { headers: H(S.token) });
      assert.equal(r.status, 200, "la GET /api/asks non fallisce mai (best-effort)");
      await r.json();
      await sleep(WINDOW_MS + 20);
    }
    // Piccola coda per i retry programmati armati dagli skip/pending.
    await sleep(WINDOW_MS + 100);
    const { status, rec } = await S.askState();
    assert.equal(status, 200, 'la lettura finale risponde');
    assert.ok(rec, "l'alias importato è ancora nell'elenco");
    assert.notEqual(rec.dismissed, true, `uno snapshot [${label}] non chiude MAI un alias aperto (${viaName})`);
    // Non è un verde a vuoto: l'owner è stato interrogato davvero, più volte,
    // e ha sempre risposto il corpo malformato del caso.
    assert.ok(S.hits.snap >= 2, `l'owner è stato contattato davvero: ${S.hits.snap} snapshot`);
  });
}
for (const c of CASES) for (const v of VIAS) staysOpenCase(c, v);

// ---------------------------------------------------------------------------
// Controlli positivi (il test sa anche fallire): snapshot COMPLETO, VALIDO e
// FRESCO senza l'ask → l'alias SI chiude, su entrambe le vie.
// ---------------------------------------------------------------------------
function closesCase([viaName, subscribed]) {
  test(`E2E schema (${viaName}): snapshot valido e pulito — l'alias SI chiude (controllo positivo)`, async (t) => {
    const ownerId = hexId('positivo', viaName);
    const body = validSnapshot(ownerId, []);
    const S = await scenario(t, {
      ownerId, subscribed, tag: `p${subscribed ? 's' : 'u'}`,
      respond: (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); },
    });
    const closed = await waitUntil(async () => {
      const { rec } = await S.askState();
      return !rec || rec.dismissed === true;
    }, { tries: 45, what: 'alias chiuso dallo snapshot pulito' });
    assert.ok(closed, `con uno snapshot valido senza l'ask l'alias SI chiude (${viaName}): altrimenti l'harness non sta provando niente`);
    assert.ok(S.hits.snap >= 1, 'l\'owner è stato contattato: ' + S.hits.snap);
  });
}
for (const v of VIAS) closesCase(v);
