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
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { bootCells } = require('../lib/fleet/boot.js');
const { NOME_GENERAZIONE } = require('../lib/files/activity.js');

const SESSIONE = 'cloud-Dev';

// --- il mondo -------------------------------------------------------------
// Fake tmux con lo stato VERO del server: `vive` e' l'elenco delle sessioni che
// list-sessions riporta, e new-session lo aggiorna. Senza questo, un fake che
// risponde «vivo» per sempre renderebbe impossibile provare il lancio riuscito
// (il controllo in testa lo fermerebbe) — e un fake che risponde «nessuno» per
// sempre renderebbe impossibile provare il caso della cella viva.
function mondo(t, { vive = [], pronto = true, newSessionError = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-live-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev'); fs.mkdirSync(cwd);
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
  if (${JSON.stringify(newSessionError)} === true) { process.stderr.write('synthetic new-session failure\\n'); process.exit(1); }
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
    cells: [{ id: 'Dev', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: true }],
  });

  const ticket = [];
  const launchBroker = {
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

  await assert.rejects(() => w.runtime.up('Dev'), (e) => {
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
    status: async () => ({ cells: [{ cell: 'Dev', tmuxSession: SESSIONE, boot: true }] }),
    up: (id) => w.runtime.up(id),
  };
  const res = await bootCells(fleet, { log: () => {} });

  assert.deepEqual(res.skipped, ['Dev'], 'una cella gia\' viva e\' uno SKIP, non un errore');
  assert.deepEqual(res.started, []);
  assert.deepEqual(res.failed, []);
  assert.equal(fs.readFileSync(w.genPath, 'utf8'), prima, 'la generazione resta quella del lancio vero');
  assert.equal(fs.statSync(w.genPath).mtimeMs, mtimePrima, 'e il file non e\' stato riscritto');
  assert.deepEqual(w.ticket, [], 'e non si e\' lanciato niente');
});

// --- 3. cella SPENTA: generazione nuova, e coerente con il lancio ---------

test('up su una cella spenta: generazione nuova su disco, e la stessa nel ticket', async (t) => {
  const w = mondo(t, { vive: [] });
  genera(w, 'gen-vecchia-di-un-lancio-precedente');

  const esito = await w.runtime.up('Dev');
  assert.ok(esito, 'la cella spenta si lancia');

  const nuova = fs.readFileSync(w.genPath, 'utf8');
  assert.notEqual(nuova, 'gen-vecchia-di-un-lancio-precedente', 'generazione nuova');
  assert.equal(nuova.length, 16, 'una generazione da 8 byte in esadecimale');
  // LA COERENZA: quella pubblicata su disco e' la stessa che viaggia nel payload
  // verso il supervisore, cioe' quella che finisce negli hook del lancio. Se le
  // due divergessero, ogni evento del client verrebbe scartato al lettore.
  assert.equal(w.ticket.length, 1, 'un ticket, una cella');
  assert.equal(w.ticket[0].activity.generation, nuova,
    'la generazione su disco e quella del lancio devono essere la STESSA');
  assert.equal(w.ticket[0].activity.dir, path.dirname(w.genPath));
});

// --- 4. restart: rilancio vero, generazione nuova e coerente --------------

test('restart: la cella muore e rinasce, con una generazione nuova e coerente', async (t) => {
  const w = mondo(t, { vive: [SESSIONE] });
  genera(w, 'gen-del-lancio-vero');

  await w.runtime.restart('Dev');

  const dopo = fs.readFileSync(w.genPath, 'utf8');
  assert.notEqual(dopo, 'gen-del-lancio-vero', 'un restart e\' un lancio nuovo');
  assert.equal(w.ticket.length, 1);
  assert.equal(w.ticket[0].activity.generation, dopo,
    'restart: hooks e file devono portare la stessa generazione');
});

// --- 5. il riproduttore: due up CONCORRENTI sulla stessa cella spenta ------
//
// E' il caso che l'audit ha riprodotto: entrambi vedevano «non viva», il
// vincitore creava la sessione con la generazione A, il perdente scriveva B e
// solo dopo prendeva il 409 — e sul disco restava B, che non e' la generazione
// di nessun lancio vivo. La prova che conta e' l'ultima riga: sul disco c'e' la
// generazione del VINCITORE.

test('due up concorrenti sulla stessa cella spenta: sul disco la generazione del VINCITORE', async (t) => {
  const w = mondo(t, { vive: [] });
  genera(w, 'gen-di-un-lancio-vecchio');

  const esiti = await Promise.allSettled([w.runtime.up('Dev'), w.runtime.up('Dev')]);
  const prima = esiti[0];
  const secondo = esiti[1];
  assert.equal(prima.status, 'fulfilled', 'il primo turno lancia');
  assert.equal(secondo.status, 'rejected', 'il secondo non lancia');
  assert.equal(secondo.reason.status, 409);
  assert.equal(secondo.reason.fleetCode, 'SESSION_DUPLICATE');

  // L'asserzione che nomina il difetto trovato dall'audit, per prima: sul disco
  // c'e' la generazione di un lancio VIVO, non quella del perdente.
  const suDisco = fs.readFileSync(w.genPath, 'utf8');
  assert.equal(w.ticket.length, 1, 'UN solo lancio: il perdente non chiede nemmeno il ticket');
  assert.equal(suDisco, w.ticket[0].activity.generation,
    'sul disco la generazione del VINCITORE, non quella del perdente');
  assert.notEqual(suDisco, 'gen-di-un-lancio-vecchio');
  assert.equal(fs.existsSync(path.join(path.dirname(w.genPath), '.up.lock')), false,
    'la serializzazione non lascia il lock appeso');
});

// --- 6. lock ORFANO: il proprietario non esiste piu' ---------------------

test('lock orfano (PID morto): si rompe e la cella parte', async (t) => {
  const w = mondo(t, { vive: [] });
  genera(w, 'gen-vecchia');
  // Un processo che c'e' stato e non c'e' piu': il suo PID non esiste.
  const morto = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = path.join(path.dirname(w.genPath), '.up.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(morto), { mode: 0o600 });
  assert.equal(processoVivo(morto), false, 'il PID del figlio terminato non e\' vivo');

  const esito = await w.runtime.up('Dev');
  assert.ok(esito, 'un lock orfano non deve bloccare la cella');
  assert.equal(w.ticket.length, 1, 'la cella e\' partita davvero');
  assert.equal(fs.readFileSync(w.genPath, 'utf8'), w.ticket[0].activity.generation);
  assert.equal(fs.existsSync(lock), false, 'il lock orfano e\' stato rimosso');
});

// --- 7. lock VIVO: un'altra partenza e' in corso -------------------------

test('lock vivo (PID esistente): 409 «cella già in avvio» e nessuna scrittura', async (t) => {
  const w = mondo(t, { vive: [] });
  const mtimePrima = genera(w, 'gen-vecchia');
  const prima = fs.readFileSync(w.genPath, 'utf8');
  // Un processo VERO, vivo, che tiene il lock.
  const vivo = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
  t.after(() => { try { vivo.kill('SIGKILL'); } catch (_) {} });
  const lock = path.join(path.dirname(w.genPath), '.up.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(vivo.pid), { mode: 0o600 });

  await assert.rejects(() => w.runtime.up('Dev'), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.fleetCode, 'SESSION_DUPLICATE');
    assert.match(String(e.message), /già in avvio/);
    return true;
  });

  assert.equal(fs.readFileSync(w.genPath, 'utf8'), prima, 'il file non si tocca');
  assert.equal(fs.statSync(w.genPath).mtimeMs, mtimePrima, 'nemmeno la mtime');
  assert.deepEqual(w.ticket, [], 'nessun ticket: la cella non e\' stata lanciata');
  assert.equal(fs.existsSync(lock), true, 'il lock di un altro processo non si rimuove');
});

// --- 8. il lock si rilascia anche sul percorso d'errore ------------------

test('lancio fallito: il lock viene rilasciato comunque', async (t) => {
  const w = mondo(t, { vive: [], newSessionError: true });
  genera(w, 'gen-vecchia');
  const lock = path.join(path.dirname(w.genPath), '.up.lock');

  await assert.rejects(() => w.runtime.up('Dev'), (e) => e.status === 500 && e.fleetCode === 'NEW_SESSION_FAILED');
  assert.equal(fs.existsSync(lock), false,
    'un lancio fallito non deve lasciare la cella bloccata fino alla morte del processo');
  // e la cella si puo' rilanciare subito dopo: nessun lock appeso.
  await assert.rejects(() => w.runtime.up('Dev'), (e) => e.fleetCode === 'NEW_SESSION_FAILED');
});

// Il controllo di liveness usato dal runtime, riscritto qui: se cambia la
// regola (ESRCH = morto), questo test deve cadere — non e' una copia di
// comodo, e' il verso dell'asserzione.
function processoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
