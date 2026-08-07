'use strict';
// tests/nodes-test-all.test.js — `nodes test` senza riferimento, e l'incoerenza
// che nessuno vedeva.
//
// Caso reale: tre peer su quattro risultavano "Share enabled" e uno solo aveva
// davvero il canale inverso attivo. La diagnosi esisteva gia' — `nodes test
// <nodo>` distingue OK, KO e passivo — ma andava lanciata un nodo alla volta,
// sapendo gia' di doverlo fare. Il valore di questo comando non e' l'elenco:
// e' l'ultima riga, quella che dice quali nodi dichiarano una condivisione che
// non e' verificata.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const nodesCmds = require('../lib/nodes/commands.js');

function fixture(t, peers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-all-'));
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  const nodesPath = path.join(dir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  peers.forEach((peer, i) => {
    st = store.addNode(st, {
      name: peer.name, remotePort: 41820, localPort: 44001 + i,
      nodeId: String.fromCharCode(98 + i).repeat(32),
      acceptToken: 'ACC', token: 'TOK', direction: 'inbound',
      shared: peer.shared, visibility: 'network',
    });
  });
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, nodesPath };
}

// Seam: il probe federato risponde secondo una mappa nome -> sano/no, cosi' il
// test prova il RIEPILOGO e non di nuovo probeHealth (che ha i suoi test).
const probeFrom = (healthy) => async ({ port }) => (
  healthy.has(port) ? { status: 'healthy' } : { status: 'down', detail: 'peer non raggiungibile' }
);

const run = (fx, healthyPorts) => {
  const lines = [];
  return nodesCmds.nodesTestAll({
    home: fx.home, nodesPath: fx.nodesPath, log: (l) => lines.push(String(l)),
    federationProbe: probeFrom(new Set(healthyPorts)),
  }).then((res) => ({ ...res, out: lines.join('\n') }));
};

test('un nodo condiviso il cui canale non risponde finisce nel riepilogo', async (t) => {
  const fx = fixture(t, [
    { name: 'pixel', shared: true },   // 44001, sano
    { name: 'nova', shared: true },    // 44002, muto
  ]);
  const { code, out, declaredNotProven } = await run(fx, [44001]);
  assert.equal(code, 0, 'riferisce, non giudica: un dispositivo spento non e\' un errore');
  assert.deepEqual(declaredNotProven, ['nova']);
  assert.match(out, /nova/);
  assert.match(out, /stato desiderato, non una verifica/);
  // Il consiglio deve mandare l'operatore DA QUESTA PARTE: il dispositivo
  // CHIEDE il bind inverso, ma e' lo sshd dell'hub a concederlo o negarlo, in
  // base alla riga `permitlisten=` che porta la chiave di quel dispositivo
  // nell'`authorized_keys` DELL'HUB. Indicare il dispositivo manderebbe a
  // cercare dove non c'e' nulla — ed e' il modo in cui il difetto e' rimasto
  // aperto per giorni.
  //
  // Si asserisce l'ASSOCIAZIONE, non la presenza delle tre parole: una riga
  // che dicesse "l'hub riceve; sul dispositivo, in ~/.ssh/authorized_keys..."
  // le conterrebbe tutte e sarebbe invertita. Cosi' cade chi sposta il file,
  // non solo chi cambia il vocabolario.
  // La distanza si misura in caratteri e non "fino al punto": il percorso
  // stesso ne contiene uno (`~/.ssh/…`), e una classe `[^.]*` si fermerebbe li'
  // facendo cadere il test sulla riga GIUSTA.
  assert.match(out, /su\s+questo\s+hub[\s\S]{0,120}authorized_keys/i,
    'authorized_keys deve risultare SULL\'hub, non altrove');
  assert.ok(!/(sul|nel)\s+dispositivo[\s\S]{0,80}authorized_keys/i.test(out),
    'il file non va mai localizzato sul dispositivo');
  assert.match(out, /permitlisten/, 'e la parola da cercare deve esserci');
});

test('quando tutti i condivisi rispondono, nessun riepilogo di incoerenza', async (t) => {
  const fx = fixture(t, [{ name: 'pixel', shared: true }]);
  const { out, declaredNotProven } = await run(fx, [44001]);
  assert.deepEqual(declaredNotProven, []);
  assert.ok(!/stato desiderato/.test(out), `riepilogo inatteso:\n${out}`);
});

test('un nodo NON condiviso e muto non e\' un\'incoerenza: e\' una scelta', async (t) => {
  // Distinzione che conta: `passive` non significa sano, ma nemmeno rotto.
  // Segnalarlo qui trasformerebbe il riepilogo in rumore su ogni installazione
  // con un nodo privato.
  const fx = fixture(t, [{ name: 'asus', shared: false }]);
  const { out, declaredNotProven } = await run(fx, []);
  assert.deepEqual(declaredNotProven, []);
  assert.ok(!/stato desiderato/.test(out));
});

test('ogni nodo compare con il suo esito, non solo quelli incoerenti', async (t) => {
  const fx = fixture(t, [
    { name: 'pixel', shared: true },
    { name: 'nova', shared: true },
    { name: 'asus', shared: false },
  ]);
  const { out, results } = await run(fx, [44001]);
  assert.equal(results.length, 3);
  for (const name of ['pixel', 'nova', 'asus']) assert.match(out, new RegExp(name));
});

test('nessun nodo configurato: lo dice, e non finge un esito', async (t) => {
  const fx = fixture(t, []);
  const { code, out, results } = await run(fx, []);
  assert.equal(code, 0);
  assert.deepEqual(results, []);
  assert.match(out, /nessun nodo configurato/);
});

test('un probe che LANCIA non interrompe gli altri nodi', async (t) => {
  // Il comando esiste per dare un quadro: se un peer rotto lo fa abortire,
  // torna a essere un test per volta.
  const fx = fixture(t, [{ name: 'pixel', shared: true }, { name: 'nova', shared: true }]);
  const lines = [];
  const res = await nodesCmds.nodesTestAll({
    home: fx.home, nodesPath: fx.nodesPath, log: (l) => lines.push(String(l)),
    federationProbe: async ({ port }) => {
      if (port === 44002) throw new Error('boom');
      return { status: 'healthy' };
    },
  });
  assert.equal(res.code, 0);
  assert.equal(res.results.length, 2);
  assert.deepEqual(res.declaredNotProven, ['nova']);
});
