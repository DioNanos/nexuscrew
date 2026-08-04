'use strict';
// tests/reverse-pool-verification.test.js — il GIRO di verifica del pool, non
// solo la decisione finale.
//
// La decisione (quali slot risultano provati, se la rotazione e' attiva) vive
// in reverse-rotation.summarizePoolVerification ed e' coperta li'. Ma una
// funzione pura non vincola il ciclo che la alimenta: finche' il ciclo si
// fermava al primo slot che non si prova, gli slot sani successivi non
// venivano nemmeno tentati e la diagnosi diceva "uno solo provato" invece di
// "solo quello di mezzo e' rotto". Questo file lega il comportamento vero,
// contando le verifiche che partono davvero dal server reale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

// Avvia un server reale con lo stesso cablaggio della produzione: nessun ssh,
// nessun fetch verso l'esterno, ma il percorso Share ON -> ensure -> verify e'
// quello vero.
async function bootWithPool(t, { verifyOutcome }) {
  const verified = [];
  const remoteInstanceId = 'a'.repeat(32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pool-verify-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  store.initStore(nodesPath);

  // Il seam che conta: ogni richiesta di verifica di uno slot passa di qui.
  const fetchImpl = async (url, opts = {}) => {
    const target = String(url);
    if (target.includes('/federation/reverse-pool/verify')) {
      const body = JSON.parse(String(opts.body || '{}'));
      verified.push(body.slot);
      const ok = verifyOutcome(body.slot);
      return ok
        ? { ok: true, status: 200, json: async () => ({ verified: true, slot: body.slot }) }
        : { ok: false, status: 409, json: async () => ({ error: 'slot reverse non autenticata', code: 'reverse-slot-proof-unavailable' }) };
    }
    if (target.endsWith('/federation/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: remoteInstanceId }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const { server, token, watcher } = createServer({
    home: dir, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), fleetEnabled: false,
    fetchImpl,
    tunnelSpawnImpl: () => ({ pid: 4193777, unref() {} }),
    tunnelSpawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    reverseSlotCreateServerImpl: (app) => http.createServer(app),
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
      stopTunnelImpl: () => ({ stopped: true }),
      startForwardImpl: () => ({ started: false, reason: 'already running', pid: 4242 }),
      pairDelay: async () => {},
      fetchImpl,
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/api/settings/nodes`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ name: 'hub', ssh: 'user@hub' }),
  });
  let st = store.loadStoreStrict(nodesPath);
  st = store.updateNode(st, 'hub', {
    direction: 'outbound', shared: true, localPort: 43001, remotePort: 41820,
    reversePort: 44001, token: 't'.repeat(48), acceptToken: 'k'.repeat(48), nodeId: remoteInstanceId,
    reversePool: store.reversePoolDefault(44001),
  });
  store.atomicWriteStore(nodesPath, st);
  await fetch(`${base}/api/settings/nodes/hub/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });
  // `verifyHubPoolSlot` ritenta tre volte ogni slot: cio' che conta e' QUALI
  // slot sono stati tentati, non quante richieste ha prodotto ognuno.
  const attempted = [...new Set(verified)].sort((a, b) => a - b);
  return { verified, attempted, nodesPath, slots: store.getNode(store.loadStoreStrict(nodesPath), 'hub').reversePool.slots.length };
}

test('verifica pool: uno slot guasto non interrompe il giro', async (t) => {
  // Slot 1 rifiutato, 0 e 2 sani. Col vecchio `break` sarebbero partite due
  // sole verifiche e lo slot 2 non sarebbe mai stato tentato.
  const { attempted, nodesPath, slots } = await bootWithPool(t, { verifyOutcome: (slot) => slot !== 1 });
  assert.equal(slots, 3, 'il pool di default ha tre slot');
  assert.deepEqual(attempted, [0, 1, 2], 'ogni slot dev\'essere tentato, anche dopo un rifiuto');

  const pool = store.getNode(store.loadStoreStrict(nodesPath), 'hub').reversePool;
  assert.deepEqual(pool.verifiedSlots, [0, 2], 'lo slot sano dopo il guasto resta contato');
  assert.equal(pool.verification, 'unverifiable', 'servono comunque tutti gli slot');
});

test('verifica pool: tutti sani -> verificato', async (t) => {
  const { attempted, nodesPath } = await bootWithPool(t, { verifyOutcome: () => true });
  assert.deepEqual(attempted, [0, 1, 2]);
  const pool = store.getNode(store.loadStoreStrict(nodesPath), 'hub').reversePool;
  assert.deepEqual(pool.verifiedSlots, [0, 1, 2]);
  assert.equal(pool.verification, 'verified');
});

test('verifica pool: il caso di campo — solo l\'attivo si prova', async (t) => {
  // E' lo stato osservato su un link reale: lo slot attivo risponde, i due di
  // riserva no perche' nessuno li ascolta. La rotazione automatica resta
  // spenta, ed e' il fatto che va reso visibile.
  const { attempted, nodesPath } = await bootWithPool(t, { verifyOutcome: (slot) => slot === 0 });
  assert.deepEqual(attempted, [0, 1, 2], 'anche qui si tenta tutto: la diagnosi deve essere completa');
  const pool = store.getNode(store.loadStoreStrict(nodesPath), 'hub').reversePool;
  assert.deepEqual(pool.verifiedSlots, [0]);
  assert.equal(pool.verification, 'unverifiable');
});
