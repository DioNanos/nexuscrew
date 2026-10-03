'use strict';
// tests/closure-federated-store-unreadable.e2e.test.js — chiusura federata di
// un ask importato quando il RICEVENTE ha asks.json illeggibile.
//
// Difetto nc-0953 (routes.js isClosure): closeImported rifiuta con
// {ok:false, reason:'store-unreadable'} ma la route rispondeva comunque
// 200 {status:'delivered', closed:false}. Il mittente (closure-retry.js) mette
// 'delivered' in DONE_STATUSES (closure-retry.js:37): nessun ritentativo, e
// l'alias restava aperto per sempre anche dopo che l'operatore riparava il file.
//
// Contratto del fix:
//   - store illeggibile => 503 {status:'unavailable', reason:'store-unreadable'}.
//     Il dispatcher (lib/audio/dispatch.js:91) traduce un 5xx in
//     {status:'unreachable'} — FUORI da DONE/FINAL (closure-retry.js:37-38) —
//     cosi' la coda lato owner ritenta.
//   - 'refused' (403/404/409 -> dispatch.js:88) e' FINALE e NON va usato: il
//     tempo non ripara un ACL deny, ma ripara uno store illeggibile.
//   - no-op idempotente (store leggibile, alias gia' chiuso/assente) resta 200
//     delivered come oggi (closed.ok && !closed.changed).
//
// Due prove con DUE server reali (nessuno stub HTTP), stesso harness del test
// snapshot-producer-fail-closed:
//   1. ROUTE: POST federato della chiusura al ricevente con store malformato =>
//      503 ritentabile (non 200 delivered).
//   2. E2E: owner scarta l'ask => il ricevente con store malformato NON chiude
//      l'alias; si ripara il file; un read-nudge lato owner fa ripartire la
//      coda => il ritentativo CHIUDE l'alias. Rosso sul codice senza fix (la
//      prima risposta 'delivered' esaurisce la coda: nessun ritentativo, alias
//      aperto anche dopo il riparo).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET = 'pairing-secret-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, { tries = 60, what = 'condition' } = {}) => {
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (out) return out;
    await sleep(100);
  }
  return null;
};

const OWNER_ASK_ID = 'owncl01';
const ALIAS_ID = 'aliascl1';
const SESSION = tmuxSessionForCell('dev');

function boot(t, dir) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
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
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(async () => {
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
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, server, ...paths });
  }));
}

function seedAsksRaw(dir, raw) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'asks.json'), raw, { mode: 0o600 });
}

// L'ask aperto dell'owner (store leggibile su B).
function openOwnerAskRaw() {
  return `${JSON.stringify({
    asks: [{ id: OWNER_ASK_ID, question: 'aperta sull\'owner', options: ['si', 'no'], session: SESSION, ts: Date.now(), revision: 0, answered: false, dismissed: false }],
  }, null, 2)}\n`;
}

// L'alias importato del ricevente, con store MALFORMATO (virgola finale): il
// file ESISTE ma e' illeggibile, cosi' closeImported rifiuta per store-unreadable.
function malformedAliasRaw(ownerId) {
  const alias = { id: ALIAS_ID, question: 'alias importato', options: [], session: SESSION, ts: Date.now(), revision: 0, originNode: ownerId, ownerId, ownerAskId: OWNER_ASK_ID };
  return `{"asks":[${JSON.stringify(alias)},]}\n`;
}

// Riparo: stesso alias, forma VALIDA, ancora APERTO. load() rilegge e lo trova.
function validAliasRaw(ownerId) {
  const alias = { id: ALIAS_ID, question: 'alias importato', options: [], session: SESSION, ts: Date.now(), revision: 0, originNode: ownerId, ownerId, ownerAskId: OWNER_ASK_ID, answered: false, dismissed: false };
  return `${JSON.stringify({ asks: [alias] }, null, 2)}\n`;
}

async function pair(t, root) {
  const ownerDir = path.join(root, 'owner');
  const clientDir = path.join(root, 'client');
  seedAsksRaw(ownerDir, openOwnerAskRaw());
  const B = await boot(t, ownerDir);
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  seedAsksRaw(clientDir, malformedAliasRaw(selfB));
  const A = await boot(t, clientDir);
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  // A (ricevente): peer INBOUND 'owner' (B) accetta SECRET. La chiusura
  // federata B->A arriva qui: la route /asks (classe 'operator',
  // resource-acl.js:115) richiede peerOperatorAccess, perche' la chiusura e'
  // una mutazione dello stato del ricevente.
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    acceptToken: SECRET, direction: 'inbound', shared: true, visibility: 'network',
  });
  stA = nodesStore.setPeerAccessGrants(stA, 'owner', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: true, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  // B (owner): peer OUTBOUND 'client' (A) per il fan-out di chiusura B->A. Il
  // dispatcher risolve la route=['client'] e il router federato di B inoltra a
  // A (next.localPort = A.port, next.token = SECRET). Outbound (non private
  // inbound) perche' il transito non sia rifiutato (federation.js:608).
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: A.port, nodeId: selfA,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@client',
  });
  stB = nodesStore.setPeerAccessGrants(stB, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: true, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  stB = nodesStore.setPeerAccessPreset(stB, 'client', 'admin');
  stB = nodesStore.updateNode(stB, 'client', { eventsReceive: false });
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  return { A, B, selfA, selfB, ownerDir, clientDir };
}

const aliasRecord = (A) => async () => {
  const r = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
  assert.equal(r.status, 200, 'la GET /api/asks risponde sempre (best-effort)');
  const list = await r.json();
  return (list.asks || []).find((a) => a.id === ALIAS_ID) || null;
};

test('E2E nc-0953 closure (route): POST federato della chiusura con store malformato => 503 ritentabile (non 200 delivered)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nccl-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, selfA, selfB } = await pair(t, root);
  // La STESSA POST federata che fa il dispatcher (resource /asks, hop chain,
  // grants reali). Il body porta la cella attestata (originCell) e il target
  // esatto, come li aggiunge il dispatcher (lib/audio/dispatch.js:145-154):
  // senza originCell il resolver rifiuta 'bad-attested-cell', senza target la
  // route rifiuta 'wrong-target'.
  const r = await fetch(`${A.base}/federation/route/_/asks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', 'x-nexuscrew-visited': selfB },
    body: JSON.stringify({ askId: OWNER_ASK_ID, closeOutcome: 'dismissed', ownerNode: selfB, originCell: SESSION, target: selfA }),
  });
  assert.equal(r.status, 503, 'store illeggibile => 503 ritentabile, non 200 delivered');
  const body = await r.json();
  assert.equal(body.status, 'unavailable', 'corpo: esito non autorevole (non "delivered")');
  assert.equal(body.reason, 'store-unreadable', 'reason: la causa resta leggibile al mittente');
  // L'alias NON e' stato chiuso (closeImported ha rifiutato): non emergendo dal
  // store malformato, resta APERTO. Lo si verifica dopo il riparo (store leggibile
  // ma alias non dismissed): la chiusura NON e' avvenuta.
  fs.writeFileSync(path.join(root, 'client', '.nexuscrew', 'asks.json'), validAliasRaw(selfB), { mode: 0o600 });
  const rec = await waitUntil(aliasRecord(A), { tries: 30, what: 'alias visibile dopo riparo' });
  assert.ok(rec, 'l\'alias e\' nell\'elenco dopo il riparo');
  assert.notEqual(rec.dismissed, true, 'la chiusura con store malformato NON ha chiuso l\'alias');
});

test('E2E nc-0953 closure (recapito): store malformato => alias APERTO; riparo + ritentativo => alias CHIUSO', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nccl-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, B, selfB, clientDir } = await pair(t, root);
  // Owner scarta l'ask: la transizione AUTOREVOLE fa partire il fan-out di
  // chiusura verso il peer A. La route risponde 503 (store malformato) => il
  // dispatcher lo traduce in {status:'unreachable'} => FUORI da DONE/FINAL =>
  // la coda di recapito (closure-retry.js) accoda A come pendente.
  const dismiss = await fetch(`${B.base}/api/asks/${OWNER_ASK_ID}`, { method: 'DELETE', headers: H(B.token) });
  assert.equal(dismiss.status, 200, 'lo scarto locale dell\'owner riesce');
  await dismiss.json();
  // L'alias resta APERTO: closeImported ha rifiutato per store illeggibile.
  // (Non e' visibile finche' il file e' malformato: lo si verifica dopo il riparo.)
  fs.writeFileSync(path.join(clientDir, '.nexuscrew', 'asks.json'), validAliasRaw(selfB), { mode: 0o600 });
  const recOpen = await waitUntil(aliasRecord(A), { tries: 30, what: 'alias visibile dopo riparo' });
  assert.ok(recOpen, 'l\'alias e\' nell\'elenco dopo il riparo');
  assert.notEqual(recOpen.dismissed, true, 'prima del ritentativo l\'alias è ancora APERTO');
  // Ritentativo: la LETTURA degli ask lato owner (GET /api/asks su B) nudge-a la
  // coda (routes.js:600 drain('read')), che ri-dispatcha la chiusura verso A.
  // Ora A ha lo store leggibile => closeImported riesce => l'alias si chiude.
  // Sul codice senza fix, la prima risposta era 'delivered' (DONE) e la coda non
  // accodava mai A: nessun ritentativo, alias APERTO anche dopo il riparo.
  const closed = await waitUntil(async () => {
    await fetch(`${B.base}/api/asks`, { headers: H(B.token) }); // nudge drain
    const rec = await aliasRecord(A)();
    return rec && rec.dismissed === true ? rec : null;
  }, { tries: 50, what: 'alias chiuso dal ritentativo dopo riparo' });
  assert.ok(closed, 'il ritentativo della chiusura CHIUDE l\'alias dopo il riparo dello store');
});