'use strict';
// tests/notify-federation-e2e.test.js — DUE server reali: una cella su A
// avvisa l'operatore che sta su B.
//
// Clonato dall'harness di audio-federation-e2e.test.js perche' l'invariante da
// proteggere e' la stessa: l'origine di una notifica deve ATTRAVERSARE la
// federazione senza poter essere iniettata dal chiamante. Una notifica arriva
// sulla lock screen di un essere umano e porta un nome di mittente: se quel
// nome fosse dichiarato dal peer, avremmo costruito un canale di phishing
// autenticato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const PEER_TOKEN = 'peer-token-abcdefghijklmnopqrstuvwxyz0123456789';

async function bootNode(t, { session, cell }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnotify-fed-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), port: 0,
    fleetSeam: {
      available: true, isCellSession: () => true, capabilities: () => [],
      status: async () => ({
        available: true,
        cells: [{ cell, tmuxSession: session, active: true, tmux: true }],
      }),
    },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const nodeId = nodesStore.loadStore(paths.nodesPath).nodeId;
  const plain = (method, apiPath, body) => fetch(`${base}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { dir, configDir, paths, port, base, token, nodeId, plain, session, cell };
}

function link(a, b, { visibility = 'network', aVisibility = 'network' } = {}) {
  let stA = nodesStore.loadStoreStrict(a.paths.nodesPath);
  stA = nodesStore.addNode(stA, {
    name: 'peer-b', ssh: 'user@peer-b', remotePort: 41999, localPort: b.port,
    nodeId: b.nodeId, token: PEER_TOKEN, direction: 'outbound', shared: true, visibility: aVisibility,
  });
  nodesStore.atomicWriteStore(a.paths.nodesPath, stA);
  let stB = nodesStore.loadStoreStrict(b.paths.nodesPath);
  stB = nodesStore.addNode(stB, {
    name: 'peer-a', remotePort: 41999, localPort: a.port,
    nodeId: a.nodeId, acceptToken: PEER_TOKEN, direction: 'inbound', shared: true, visibility,
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, stB);
}

async function pair(t, opts = {}) {
  const a = await bootNode(t, { session: 'cloud-Dev', cell: 'Dev' });
  const b = await bootNode(t, { session: 'mac-Dev', cell: 'Dev' });
  link(a, b, opts);
  return { a, b };
}

// Ascolta l'SSE del nodo e risolve al primo frame `notify`. E' l'unico modo
// onesto di dire "e' arrivata": il contatore `delivered` conta tentativi.
function firstNotify(node, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => { ctl.abort(); reject(new Error('nessun frame notify entro il timeout')); }, timeoutMs);
    fetch(`${node.base}/api/events?token=${encodeURIComponent(node.token)}`, { signal: ctl.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (const chunk of buf.split('\n\n')) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            let payload = null;
            try { payload = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (payload && payload.title) {
              clearTimeout(timer); ctl.abort(); resolve(payload); return;
            }
          }
        }
      })
      .catch((e) => { clearTimeout(timer); if (!ctl.signal.aborted) reject(e); });
  });
}

test('una notifica con target raggiunge l\'operatore sull\'altro nodo', async (t) => {
  const { a, b } = await pair(t);
  const arrived = firstNotify(b);
  const res = await a.plain('POST', '/api/notify', {
    title: 'build finita', body: 'tutto verde', session: a.session, target: b.nodeId,
  });
  // Il corpo si legge UNA volta: usarlo come messaggio d'assert lo consuma
  // anche quando l'assert passa.
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, 'delivered', JSON.stringify(out));
  const frame = await arrived;
  assert.equal(frame.title, 'build finita');
});

// R31-A3: la via federata rispondeva SEMPRE `status:'delivered'`, anche con
// zero UI connesse e zero subscription push — un verdetto positivo su un fatto
// mai avvenuto (stessa famiglia di A5). `notifier.emit` e' best-effort: il
// push va in catch → 0, `ui` conta i write SSE riusciti. La cella mittente
// vede SOLO lo status (il dispatcher non propaga i conteggi, vedi R1/rc.14),
// quindi l'etichetta deve essere un riassunto onesto di `delivered`, derivata
// da esso — non un'opinione dichiarata accanto ad esso.
test('zero consegne sul target NON viene etichettato delivered', async (t) => {
  const { a, b } = await pair(t);
  // Nessun firstNotify: nessuna UI aperta su B, nessuna subscription push.
  const res = await a.plain('POST', '/api/notify', {
    title: 'silenzio', session: a.session, target: b.nodeId,
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, 'no-delivery', JSON.stringify(out));
  // Il legame fra etichetta e misura NON si puo' asserire qui: forward()
  // propaga solo lo status (i conteggi muoiono nel dispatcher, R1/rc.14) e
  // `out.delivered` oltre il dispatcher e' undefined. L'invariante e'
  // protetta in tests/notify-federated-status.test.js, dove la risposta del
  // TARGET si vede intera (rilievo audit su 44d4f62).
});

test('il mittente e\' derivato dalla catena, non dal campo dichiarato', async (t) => {
  const { a, b } = await pair(t);
  const arrived = firstNotify(b);
  await a.plain('POST', '/api/notify', {
    title: 'chi parla?', session: a.session, target: b.nodeId,
  });
  const frame = await arrived;
  // Il nodo di origine e' verificato dalla catena visited: deve comparire, e
  // deve essere quello vero di A.
  assert.equal(frame.originNode, a.nodeId, JSON.stringify(frame));
});

test('l\'origine non e\' iniettabile con un POST diretto sulla route', async (t) => {
  const { a, b } = await pair(t);
  // Chi possiede il Bearer di A puo' chiamare la propria route federata, ma non
  // puo' spacciarsi per un terzo nodo: la catena la costruisce il server.
  const res = await a.plain('POST', `/api/route/peer-b/_/notify`, {
    title: 'spoof', target: b.nodeId, originNode: 'f'.repeat(32), originCell: 'Dev',
  });
  const out = await res.json().catch(() => ({}));
  assert.notEqual(res.status, 200, `un originNode dichiarato non deve essere accettato (${res.status})`);
  // Deve essere rifiutato PERCHE' la catena non concorda, non per un 404 di
  // risorsa sconosciuta: se un giorno /notify uscisse dall'allowlist questo
  // test continuerebbe a passare senza piu' provare nulla.
  assert.equal(out.reason, 'origin-mismatch', `${res.status} ${JSON.stringify(out)}`);
});

test('un peer relay-only non puo\' far comparire notifiche sul target', async (t) => {
  const { a, b } = await pair(t, { visibility: 'relay-only' });
  const res = await a.plain('POST', '/api/notify', {
    title: 'zitto', session: a.session, target: b.nodeId,
  });
  const out = await res.json();
  assert.equal(out.status, 'refused', JSON.stringify(out));
});

test('un target sconosciuto non diventa una consegna riuscita', async (t) => {
  const { a } = await pair(t);
  const res = await a.plain('POST', '/api/notify', {
    title: 'nessuno', session: a.session, target: 'a'.repeat(32),
  });
  const out = await res.json();
  assert.notEqual(out.status, 'delivered', JSON.stringify(out));
});

// G1 (rilievo di un audit indipendente su rc.14): l'invariante "un peer rumoroso non affama
// le celle di casa" era dichiarata nel commit e nel codice, ma NON protetta.
// Il budget federato e quello locale sono due limiter distinti; se un domani
// qualcuno li riunisce, il codice resta plausibile e il danno e' invisibile
// finche' non succede in produzione.
test('il budget federato e\' separato: saturarlo non zittisce le celle locali', async (t) => {
  const { a, b } = await pair(t);
  // target-global vale 12/60s. Si satura da qui, poi la 13a deve cadere.
  let refused = 0;
  for (let i = 0; i < 13; i += 1) {
    const res = await a.plain('POST', '/api/notify', {
      title: `raffica ${i}`, session: a.session, target: b.nodeId,
    });
    const out = await res.json();
    // R31-A3: conta i RIFIUTI veri, non i "non delivered" — senza UI aperte le
    // consegne legittime rispondono 'no-delivery', e mescolarle qui farebbe
    // passare l'assert anche se il budget non si chiudesse mai.
    if (out.status === 'refused') refused += 1;
  }
  assert.ok(refused >= 1, 'il budget federato deve chiudersi: nessun rifiuto dopo 13 invii');

  // Ora la prova che conta: una cella DI CASA sul target deve poter ancora
  // parlare. Se i due budget fossero lo stesso, questa sarebbe 429.
  const local = await b.plain('POST', '/api/notify', { title: 'casa mia', session: b.session });
  const body = await local.json();
  assert.equal(local.status, 200, `una notifica locale non deve pagare la raffica federata: ${JSON.stringify(body)}`);
  assert.ok(body.delivered, JSON.stringify(body));
});

// Il confine va DICHIARATO, non dedotto dall'assenza. Senza questo test, un
// domani qualcuno federa /events o /asks e nessuna guardia se ne accorge.
test('solo /notify attraversa: events, asks e push restano locali', () => {
  const fed = require('../lib/proxy/federation.js');
  assert.equal(fed.allowedResource('/notify', 'POST'), true);
  assert.equal(fed.allowedResource('/notify', 'GET'), false);
  for (const resource of ['/events', '/asks', '/push/subscribe', '/push/unsubscribe', '/push/vapid']) {
    assert.equal(fed.parseRoute(`/vps/_${resource}`), null, `${resource} non deve attraversare la federazione`);
  }
});

test('lo schema federato non ammette url: sw.js farebbe openWindow', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.plain('POST', '/api/notify', {
    title: 'apri', session: a.session, target: b.nodeId, url: 'https://esempio.invalido/x',
  });
  assert.equal(res.status, 400, `atteso 400, ricevuto ${res.status}`);
});
