'use strict';
// tests/pairing-panel-port-e2e.test.js — la porta pannello si annuncia DAVVERO
// al pairing, contro un hub vero con il suo panelServer in ascolto.
//
// P0 sicurezza, meta' remota: il client puo' mettere il pannello di un peer su
// un'origin diversa solo se il peer gli dice QUALE porta pannello ascolta, e
// gliela dice nell'atto che consuma l'invito (l'unico momento in cui i due
// operatori hanno deciso il legame). Come per la pubblica del passo 1: un peer
// piu' vecchio non la riceve e si accoppia come sempre — il campo assente non
// e' un errore, e' una versione.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../lib/server.js');
const peering = require('../lib/nodes/peering.js');
const store = require('../lib/nodes/store.js');

function chiudi(srv) {
  srv.closeAllConnections?.();
  return new Promise((r) => srv.close(r));
}

// Hub con panelServer VIVO: il control plane e la porta pannello sono due
// listener distinti, come su un'installazione 0.9.1 vera.
async function hub(t, { conPanello = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-panel-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  store.atomicWriteStore(nodesPath, store.emptyStore('a'.repeat(32)));
  fs.writeFileSync(path.join(configDir, 'config.json'),
    JSON.stringify({ roles: { client: true, node: false } }));
  const made = createServer({
    home, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(home, 'files'), fleetEnabled: false, port: 41840,
    panelPort: 0,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, instanceId: 'b'.repeat(32) }) }),
  });
  const registrati = [made.server];
  await new Promise((resolve, reject) => { made.server.once('error', reject); made.server.listen(0, '127.0.0.1', resolve); });
  made.cfg.port = made.server.address().port;
  let panelPort = null;
  if (conPanello) {
    assert.ok(made.panelServer, 'createServer espone il listener pannello');
    await new Promise((resolve, reject) => { made.panelServer.once('error', reject); made.panelServer.listen(0, '127.0.0.1', resolve); });
    registrati.push(made.panelServer);
    panelPort = made.panelServer.address().port;
  }
  t.after(async () => { for (const srv of registrati) await chiudi(srv); fs.rmSync(home, { recursive: true, force: true }); });
  return {
    made, home, nodesPath, panelPort,
    base: `http://127.0.0.1:${made.server.address().port}`,
  };
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

const joinBody = (invite, extra = {}) => ({
  invite, instanceId: 'b'.repeat(32), name: 'pixel', port: 41841,
  acceptToken: 'accept-di-prova', ...extra,
});

test('il join con panelServer vivo risponde con la porta pannello REALE', async (t) => {
  const h = await hub(t);
  const joined = await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(joinBody(await invito(h))),
  });
  assert.equal(joined.status, 200);
  const j = await joined.json();
  assert.equal(j.panelPort, h.panelPort,
    'la porta annunciata e quella su cui il panelServer sta ascoltando adesso');
  assert.notEqual(j.panelPort, h.made.cfg.port, 'e non e\' la porta del control plane');
});

test('il join senza panelServer attivo NON annuncia nessuna porta pannello', async (t) => {
  // Un'installazione con il pannello spento per questo run (porta occupata e
  // fallback esaurito): annunciare cfg.panelPort vorrebbe dire far inoltrare
  // al client una porta che nessuno ascolta — un iframe rotto con la faccia
  // di una feature. Meglio il silenzio: il client resta sulla via storica.
  const h = await hub(t, { conPanello: false });
  const joined = await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(joinBody(await invito(h))),
  });
  assert.equal(joined.status, 200);
  const j = await joined.json();
  assert.equal(j.panelPort, undefined, 'nessuna porta pannello annunciata senza listener');
});

test('il record inbound confermato non ha campi panel: il -L e roba del client', async (t) => {
  const h = await hub(t);
  const j = await (await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(joinBody(await invito(h))),
  })).json();
  await fetch(`${h.base}/pair/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: j.credential }),
  });
  const nodo = store.loadStore(h.nodesPath).nodes.find((n) => n.name === 'pixel');
  assert.ok(nodo, 'peer confermato su disco');
  assert.equal(nodo.direction, 'inbound', 'dal punto di vista dell\'hub il peer e inbound');
  assert.equal(nodo.panelLocalPort, undefined, 'nessun forward pannello sul record inbound: il pannello di QUESTO nodo lo inoltra il client, non l\'hub');
  assert.equal(nodo.panelRemotePort, undefined);
});

// La porta pannello annunciata non deve attraversare join falliti: il 410
// (invito scaduto) non deve restituirla per sbaglio nel corpo d'errore.
test('join rifiutato (410) non porta nessuna panelPort nel corpo', async (t) => {
  const h = await hub(t);
  const joined = await fetch(`${h.base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(joinBody('invito-che-non-esiste'.padEnd(43, 'x'))),
  });
  assert.equal(joined.status, 410);
  const j = await joined.json();
  assert.equal(j.panelPort, undefined);
});
