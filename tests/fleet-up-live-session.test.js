'use strict';
// tests/fleet-up-live-session.test.js — un `up` su una cella GIA' VIVA non
// tocca niente, e in particolare non riscrive la generazione di attivita'.
//
// PERCHE' QUESTO TEST ESISTE. La generazione si pubblica dentro la risoluzione
// dello spec (managed.js:1696), che sta in testa a `up()`. Prima di questa
// guardia l'ordine era: si risolve, si pubblica una generazione NUOVA, si
// chiede il ticket, e solo alla new-session si scopre che la sessione esiste
// gia' -> 409. La cella non veniva rilanciata, ma `activity.gen` era gia'
// riscritto: gli hook del lancio vero portano la generazione vecchia, quindi
// ogni loro evento veniva scartato (files/activity.js:336-338) e una cella che
// lavorava risultava «non verificata». Lo pagava qualunque `up` su una cella
// viva — l'operatore dalla UI, e `fleet-boot` all'avvio del servizio, che
// cicla tutte le celle boot:true (boot.js:37-41).
//
// La prova che conta non e' «arriva 409» (arrivava anche prima): e' che il file
// della generazione resti INTATTO — stesso contenuto, stessa mtime.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { bootCells } = require('../lib/fleet/boot.js');
const { main } = require('../lib/fleet/cell-exec.js');
const { EventEmitter } = require('node:events');
const { NOME_GENERAZIONE } = require('../lib/files/activity.js');

const SESSIONE = 'cloud-CellaProva';

// --- il mondo -------------------------------------------------------------
// Fake tmux con lo stato VERO del server: `vive` e' l'elenco delle sessioni che
// list-sessions riporta, e new-session lo aggiorna. Senza questo, un fake che
// risponde «vivo» per sempre renderebbe impossibile provare il lancio riuscito
// (il controllo in testa lo fermerebbe) — e un fake che risponde «nessuno» per
// sempre renderebbe impossibile provare il caso della cella viva.
function mondo(t, { vive = [], pronto = true, broker = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-live-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'CellaProva'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const client = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(client, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, vive.map((n) => `${n}\n`).join(''));
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const STATO = ${JSON.stringify(statoPath)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write('\\t'.repeat(0) + n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  // tmux NON crea una sessione che esiste gia': risponde «duplicate session».
  // Senza questo il fake lascerebbe vincere DUE lanci, e il riproduttore del
  // difetto non sarebbe fedele: il perdente deve arrivare al 409.
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  // la sessione nasce ADESSO: da qui in poi list-sessions la vede.
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') { process.stdout.write(${JSON.stringify(pronto ? '0\t\t%9\n' : '1\t\t%9\n')}); process.exit(0); }
if (cmd === 'has-session') process.exit(0);
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  // La sessione muore DAVVERO: senza questo, list-sessions continuerebbe a
  // riportarla e un restart (down + up) troverebbe una sessione viva che non
  // c'e' piu' - un fake che mente sul proprio stato.
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  fs.writeFileSync(STATO, vive().filter((n) => n !== bersaglio).map((n) => n + '\\n').join(''));
  process.exit(0);
}
if (cmd === 'set-option' || cmd === 'respawn-pane') process.exit(0);
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 }); fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'ec', label: 'Claude', managed: {
        client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe',
      },
    }],
    cells: [{ id: 'CellaProva', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: true }],
  });

  const ticket = [];
  const launchBroker = broker
    ? broker(ticket, { statoPath, root, sessione: SESSIONE })
    : {
      issue: async (payload) => {
        ticket.push(payload);
        return { socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) };
      },
      revoke: async () => {},
      close: async () => {},
    };
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true },
    home, defsPath, tmuxBin, readonly: () => false, launchBroker,
    boot: require('../lib/fleet/definitions.js').loadDefinitions(defsPath),
  });
  const genPath = path.join(filesRoot, SESSIONE, NOME_GENERAZIONE);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { runtime, home, filesRoot, genPath, ticket, tmuxBin };
}

function genera(w, valore) {
  fs.mkdirSync(path.dirname(w.genPath), { recursive: true });
  fs.writeFileSync(w.genPath, valore, { mode: 0o600 });
  return fs.statSync(w.genPath).mtimeMs;
}

// --- 1. cella VIVA: 409, e il file non si tocca ---------------------------

test('up su una cella viva: 409 «già in esecuzione» e activity.gen INTATTO', async (t) => {
  const w = mondo(t, { vive: [SESSIONE] });
  const mtimePrima = genera(w, 'gen-del-lancio-vero');
  const statPrima = fs.statSync(w.genPath);
  const prima = fs.readFileSync(w.genPath, 'utf8');

  await assert.rejects(() => w.runtime.up('CellaProva'), (e) => {
    assert.equal(e.status, 409, 'stesso 409 che dava la new-session');
    assert.equal(e.fleetCode, 'SESSION_DUPLICATE');
    assert.match(String(e.message), /già in esecuzione/);
    return true;
  });

  const dopo = fs.readFileSync(w.genPath, 'utf8');
  const statDopo = fs.statSync(w.genPath);
  assert.equal(dopo, prima, 'la generazione NON deve cambiare');
  assert.equal(dopo, 'gen-del-lancio-vero', 'e nemmeno il valore di prima');
  assert.equal(statDopo.mtimeMs, mtimePrima, 'né la mtime: il file non e\' stato riscritto');
  assert.equal(statDopo.ino, statPrima.ino, 'stesso inode: nessun replace via rename');
  // e non si e' nemmeno chiesto un ticket al broker: la cella non si lancia.
  assert.deepEqual(w.ticket, [], 'nessun ticket di lancio per una cella gia\' viva');
});

// --- 2. il boot di flotta con celle gia' vive: nessuna scrittura ----------

test('boot di flotta con la cella gia\' viva: salta e non scrive', async (t) => {
  const w = mondo(t, { vive: [SESSIONE] });
  const mtimePrima = genera(w, 'gen-del-lancio-vero');
  const prima = fs.readFileSync(w.genPath, 'utf8');

  const fleet = {
    available: true,
    status: async () => ({ cells: [{ cell: 'CellaProva', tmuxSession: SESSIONE, boot: true }] }),
    up: (id) => w.runtime.up(id),
  };
  const res = await bootCells(fleet, { log: () => {} });

  assert.deepEqual(res.skipped, ['CellaProva'], 'una cella gia\' viva e\' uno SKIP, non un errore');
  assert.deepEqual(res.started, []);
  assert.deepEqual(res.failed, []);
  assert.equal(fs.readFileSync(w.genPath, 'utf8'), prima, 'la generazione resta quella del lancio vero');
  assert.equal(fs.statSync(w.genPath).mtimeMs, mtimePrima, 'e il file non e\' stato riscritto');
  assert.deepEqual(w.ticket, [], 'e non si e\' lanciato niente');
});

// --- 3. cella SPENTA: la generazione nasce nel payload, non su disco ------

test('up su una cella spenta: generazione NUOVA nel payload, e su disco non scrive', async (t) => {
  const w = mondo(t, { vive: [] });
  genera(w, 'gen-vecchia-di-un-lancio-precedente');

  const esito = await w.runtime.up('CellaProva');
  assert.ok(esito, 'la cella spenta si lancia');

  assert.equal(w.ticket.length, 1, 'un ticket, una cella');
  const nuova = w.ticket[0].activity.generation;
  assert.equal(nuova.length, 16, 'una generazione da 8 byte in esadecimale');
  assert.notEqual(nuova, 'gen-vecchia-di-un-lancio-precedente');
  assert.equal(w.ticket[0].activity.dir, path.dirname(w.genPath));
  // IL PUNTO DEL DISEGNO: `up` NON scrive la generazione. La scrive `cell-exec`,
  // dentro la sessione che tmux ha creato — quindi solo per chi vince. Qui, a
  // valle di un `up` riuscito, il file e' ancora quello di prima.
  assert.equal(fs.readFileSync(w.genPath, 'utf8'), 'gen-vecchia-di-un-lancio-precedente',
    'la risoluzione non tocca activity.gen');
});

// --- 4. restart: rilancio vero, generazione nuova e coerente --------------

test('restart: la cella muore e rinasce, con una generazione nuova e coerente', async (t) => {
  const w = mondo(t, { vive: [SESSIONE] });
  genera(w, 'gen-del-lancio-vero');

  await w.runtime.restart('CellaProva');

  assert.equal(w.ticket.length, 1, 'un ticket, un lancio');
  const dopo = w.ticket[0].activity.generation;
  assert.notEqual(dopo, 'gen-del-lancio-vero', 'un restart e\' un lancio nuovo');
  assert.equal(fs.readFileSync(w.genPath, 'utf8'), 'gen-del-lancio-vero',
    'e la scrittura su disco resta di cell-exec, non di up');
});

// --- 5. IL RIPRODUTTORE: due up concorrenti, e sul disco chi ha vinto -------
//
// E' il caso che la verifica ha riprodotto (pre-lock): entrambi vedevano «non
// viva», il vincitore creava la sessione con la generazione A, il perdente
// scriveva B e solo dopo prendeva il 409 — e sul disco restava B, che non era
// la generazione di nessun lancio vivo.
//
// Il disegno ha DUE difese, e questo test prova ENTRAMBE. La prima e' il lock
// per cella: due up concorrenti si serializzano, quindi la corsa non esiste
// piu' — il secondo parte DOPO il primo, vede la sessione viva e prende il 409
// in PREFLIGHT, senza nemmeno risolvere lo spec (un solo ticket). La seconda e'
// che la scrittura della generazione non sta nella risoluzione: la fa
// `cell-exec`, DENTRO la sessione tmux creata, quindi solo per il vincitore —
// ed e' la meta' che resta decisiva se un giorno il lock venisse rimosso.
//
// Nota sul fake tmux: il broker «attesa» che determinizzava la corsa non serve
// piu' (il lock la determinizza da solo) e il fake NON rifiuta una seconda
// new-session: senza lock il secondo up CREEREBBE una seconda sessione — e'
// cosi' che questo test cadrebbe se la serializzazione regredisse.

function figlioCheErrore() {
  const ee = new EventEmitter();
  ee.kill = () => {};
  queueMicrotask(() => ee.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  return ee;
}

test('due up concorrenti: UN vincitore, e sul disco la generazione del VINCITORE', async (t) => {
  const w = mondo(t, { vive: [] });
  genera(w, 'gen-di-un-lancio-vecchio');

  const esiti = await Promise.allSettled([w.runtime.up('CellaProva'), w.runtime.up('CellaProva')]);
  const vinti = esiti.filter((e) => e.status === 'fulfilled');
  const persi = esiti.filter((e) => e.status === 'rejected');
  assert.equal(vinti.length, 1, 'UN solo up riesce');
  assert.equal(persi.length, 1, 'e uno solo perde');
  // Il perdente e' fermato dal PREFLIGHT (sessione gia' viva), non dalla
  // new-session: il lock ha chiuso la corsa prima che iniziasse.
  assert.equal(persi[0].reason.status, 409);
  assert.equal(persi[0].reason.fleetCode, 'SESSION_DUPLICATE');
  assert.equal(persi[0].reason.fleetPhase, 'preflight', 'serializzato: il 409 arriva dal preflight, non dalla new-session');
  // La conseguenza diretta della serializzazione: il perdente non risolve
  // nemmeno lo spec. UN solo ticket, una sola generazione in gioco.
  assert.equal(w.ticket.length, 1, 'il perdente non risolve lo spec: la corsa non esiste piu\'');

  // Nessuno dei due ha scritto: la risoluzione non tocca activity.gen.
  assert.equal(fs.readFileSync(w.genPath, 'utf8'), 'gen-di-un-lancio-vecchio',
    'ne\' il vincitore ne\' il perdente scrivono durante up');

  const genVincitore = w.ticket[0].activity.generation;

  // Il passo che nella cella vera fa cell-exec, eseguito con il payload del
  // vincitore: e' lui che mette la generazione su disco, prima del client.
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => w.ticket[0],
    spawn: () => figlioCheErrore(),
    stderrWrite: () => {},
  });
  assert.equal(code, 1, 'il client non parte (spawn finto), ma la scrittura e\' avvenuta');

  // La prima riga: la seconda e' il segno dell'uscita, che questo supervisore dichiara.
  const suDisco = fs.readFileSync(w.genPath, 'utf8').split('\n')[0];
  assert.equal(suDisco, genVincitore, 'sul disco la generazione del VINCITORE');
});
