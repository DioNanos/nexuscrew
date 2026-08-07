'use strict';
// tests/pairing-identity-e2e.test.js — le chiavi si scambiano DAVVERO al
// pairing, contro un hub vero.
//
// PERCHE' UN E2E E NON UNO UNITARIO. `tests/nodes-identity.test.js` prova le
// regole (lega, non sovrascrive, rilega al pairing) su oggetti in memoria: sono
// verdi anche se nessuno le chiama mai. Il valore del passo 1 e' che la
// directory si POPOLI su un'installazione viva, e quella e' una proprieta' del
// giro completo — invito, join, confirm, record scritto su disco. Un modulo
// perfetto che nessuno invoca lascia la directory vuota e nessun test rosso.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const peering = require('../lib/nodes/peering.js');
const store = require('../lib/nodes/store.js');
const identity = require('../lib/nodes/identity.js');

async function hub(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-identity-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  store.atomicWriteStore(nodesPath, store.emptyStore('a'.repeat(32)));
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ roles: { client: true, node: false } }));
  const made = createServer({
    home, configDir, configPath, nodesPath, tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(home, 'files'), fleetEnabled: false, port: 41830,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, instanceId: 'b'.repeat(32) }) }),
  });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  made.cfg.port = made.server.address().port;
  return { made, home, nodesPath, base: `http://127.0.0.1:${made.server.address().port}` };
}

async function invito(h) {
  const res = await fetch(`${h.base}/api/settings/peering/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Banco', ssh: 'alias-di-prova' }),
  });
  assert.equal(res.status, 200);
  return peering.parsePairingUrl((await res.json()).pairingUrl).invite;
}

function chiaveFinta(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peerkey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return identity.ensureNodeKey({ keyPath: path.join(dir, 'k.json') }).publicKey;
}

test('lo scambio e\' simmetrico: l\'hub riceve la pubblica del peer e restituisce la sua', async (t) => {
  const h = await hub(t);
  const suaDelPeer = chiaveFinta(t);

  const joined = await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite: await invito(h), instanceId: 'b'.repeat(32), name: 'pixel',
      port: 41831, acceptToken: 'accept-di-prova', publicKey: suaDelPeer,
    }),
  });
  assert.equal(joined.status, 200);
  const j = await joined.json();

  // L'hub deve rispondere con la PROPRIA pubblica, non con quella ricevuta:
  // rimandare indietro l'ingresso sembrerebbe funzionare e legherebbe il peer
  // a se' stesso.
  assert.ok(identity.isPublicKey(j.publicKey), `l'hub non ha mandato la sua pubblica: ${j.publicKey}`);
  assert.notEqual(j.publicKey, suaDelPeer, 'non deve rimbalzare la chiave del peer');
  assert.equal(j.publicKey,
    identity.ensureNodeKey({ keyPath: identity.keyPathNextTo(h.nodesPath) }).publicKey,
    'e deve essere quella del file di chiave di QUESTA installazione');

  // E la privata non esce, mai, in nessun campo della risposta.
  assert.doesNotMatch(JSON.stringify(j), /PRIVATE KEY/);

  const confermato = await fetch(`${h.base}/pair/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: j.credential }),
  });
  assert.equal(confermato.status, 200);

  // Il record su disco: la chiave del peer c'e', ed e' marcata come legata AL
  // PAIRING. E' `keySource` che al passo 3 distinguera' un grant concedibile
  // da uno no.
  const nodo = store.loadStore(h.nodesPath).nodes.find((n) => n.name === 'pixel');
  assert.equal(nodo.publicKey, suaDelPeer, 'senza questo la directory resta vuota su un\'installazione viva');
  assert.equal(nodo.keySource, 'pairing');
  assert.ok(nodo.keyBoundAt, 'quando e\' stata legata fa parte del legame');

  // La directory la mostra.
  const elenco = identity.publicKeyDirectory(store.loadStore(h.nodesPath));
  assert.deepEqual(elenco.map((x) => [x.name, x.publicKey, x.source]),
    [['pixel', suaDelPeer, 'pairing']]);
});

test('un peer di una versione precedente si accoppia come sempre, senza chiave', async (t) => {
  const h = await hub(t);

  // Nessun `publicKey` nel corpo: e' esattamente cio' che manda un nodo che
  // non conosce il passo 1. Se il pairing fallisse qui, il passo 1 avrebbe
  // introdotto un effetto — e la sua sola promessa e' di non averne.
  const joined = await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite: await invito(h), instanceId: 'b'.repeat(32), name: 'vecchio',
      port: 41832, acceptToken: 'accept-di-prova',
    }),
  });
  assert.equal(joined.status, 200, 'un nodo senza chiave deve poter accoppiarsi');
  const j = await joined.json();
  assert.equal((await (await fetch(`${h.base}/pair/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: j.credential }),
  })).json()).confirmed, true);

  const nodo = store.loadStore(h.nodesPath).nodes.find((n) => n.name === 'vecchio');
  assert.equal(nodo.publicKey, undefined, 'nessuna chiave inventata per un peer che non ne ha mandata');
  assert.equal(nodo.keySource, undefined, 'e nessuna provenienza senza una chiave a cui riferirsi');
});

test('una chiave malformata non lega e non fa fallire il pairing', async (t) => {
  const h = await hub(t);

  const joined = await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite: await invito(h), instanceId: 'b'.repeat(32), name: 'storto',
      port: 41833, acceptToken: 'accept-di-prova',
      publicKey: 'questa-non-e-una-chiave-ed25519-valida',
    }),
  });
  assert.equal(joined.status, 200, 'il passo 1 osserva: non e\' un gate di ammissione');
  const j = await joined.json();
  await fetch(`${h.base}/pair/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: j.credential }),
  });

  const nodo = store.loadStore(h.nodesPath).nodes.find((n) => n.name === 'storto');
  assert.equal(nodo.publicKey, undefined,
    'una chiave che non e\' una chiave non deve finire nello store come se lo fosse');
});

test('la chiave dell\'hub non cambia fra due pairing diversi', async (t) => {
  const h = await hub(t);

  const uno = await (await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite: await invito(h), instanceId: 'b'.repeat(32), name: 'primo', port: 41834, acceptToken: 't1' }),
  })).json();
  await fetch(`${h.base}/pair/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: uno.credential }),
  });
  const due = await (await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite: await invito(h), instanceId: 'c'.repeat(32), name: 'secondo', port: 41835, acceptToken: 't2' }),
  })).json();

  // Se cambiasse, ogni peer legherebbe un'identita' diversa per lo stesso nodo
  // e ognuno vedrebbe un conflitto dal secondo giro in poi.
  assert.equal(due.publicKey, uno.publicKey);
});
