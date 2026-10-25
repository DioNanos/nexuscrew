'use strict';
// tests/fleet-lifecycle-lock.test.js — il lock per cella copre l'INTERO ciclo
// di vita (up, down, restart), non solo up.
//
// PERCHE' QUESTO TEST ESISTE. `launchLocks` serializzava soltanto `up`: due
// richieste concorrenti della stessa cella si mettevano in fila per la
// CREAZIONE, ma `down` girava fuori dalla fila. Il difetto non e' teorico: un
// down che parte mentre un up e' in attesa (broker, tmux) vede «nessuna
// sessione», risponde ok, e la sessione nasce UN ISTANTE DOPO — la cella resta
// viva dopo un down che ha detto di averla fermata. Il contratto del ciclo di
// vita e': up/down/restart sulla stessa cella si serializzano; restart usa le
// varianti interne senza ri-acquisire il lock; dopo un down che NON si e'
// concluso, restart non rilancia il client.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'cloud-CellaLock';

// --- il mondo -------------------------------------------------------------
// Fake tmux con stato su file e LOG ORDINATO delle chiamate: la serializzazione
// si prova dall'ORDINE degli eventi (new-session prima di kill-session), non
// dagli orologi. Il broker dorme: e' il punto in cui l'up resta in volo mentre
// il down concorrente parte.
function mondo(t, { brokerDelayMs = 200, killSessionFallisce = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lifecycle-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'CellaLock'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const client = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(client, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const logPath = path.join(root, 'chiamate.log');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const STATO = ${JSON.stringify(statoPath)};
const LOG = ${JSON.stringify(logPath)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
const nota = (cosa) => fs.appendFileSync(LOG, cosa + '\\n');
if (cmd === 'list-sessions') {
  for (const n of vive()) process.stdout.write(n + '\\t1\\n');
  process.exit(0);
}
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  nota('new-session');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '').replace(/^\\$/, '$');
  if (${JSON.stringify(killSessionFallisce)} && bersaglio !== '') {
    process.stderr.write('operational error\\n'); process.exit(1);
  }
  fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(SESSIONE)}).map((n) => n + '\\n').join(''));
  nota('kill-session:' + bersaglio);
  process.exit(0);
}
if (cmd === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
if (cmd === 'has-session') process.exit(0);
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
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
    cells: [{ id: 'CellaLock', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
  });

  const ticket = [];
  const launchBroker = {
    issue: async (payload) => {
      ticket.push(payload);
      await new Promise((resolve) => setTimeout(resolve, brokerDelayMs));
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) };
    },
    revoke: async () => {},
    close: async () => {},
  };
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true },
    home, defsPath, tmuxBin, readonly: () => false, launchBroker,
    boot: loadDefinitions(defsPath),
  });
  const vive = () => fs.readFileSync(statoPath, 'utf8').split('\n').filter(Boolean);
  const logChiamate = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { runtime, home, ticket, vive, logChiamate };
}

const dormi = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. down durante un up in volo: la fila decide, la cella NON resta viva

test('down concorrente a up: aspetta la fine del lancio, poi ferma davvero', async (t) => {
  const w = mondo(t, { brokerDelayMs: 250 });

  // up parte ora e resta in volo ~250ms nel broker; il down parte quando
  // l'up e' ancora in attesa del ticket.
  const upP = w.runtime.up('CellaLock');
  await dormi(40);
  const downP = w.runtime.down('CellaLock');
  const [upRes, downRes] = await Promise.all([upP, downP]);

  assert.equal(upRes.ok, true, 'up concluso');
  assert.equal(downRes.ok, true, 'down concluso');

  // L'ORDINE vero: la sessione nasce (new-session) e POI viene fermata
  // (kill-session). Senza lock il kill passa prima della nascita e la cella
  // resta viva dopo un down che ha detto ok.
  const log = w.logChiamate();
  const idxNew = log.findIndex((l) => l.startsWith('new-session'));
  const idxKill = log.findIndex((l) => l.startsWith('kill-session'));
  assert.notEqual(idxNew, -1, 'new-session avvenuta');
  assert.notEqual(idxKill, -1, 'kill-session avvenuta');
  assert.ok(idxNew < idxKill, 'kill-session DOPO new-session: il down ha aspettato il lancio');

  // E lo stato finale e' onesto: la sessione NON esiste piu'.
  assert.equal(w.vive().includes(SESSIONE), false,
    'la sessione non sopravvive al down che ha risposto ok');
});

// --- 2. restart: kill PRIMA del nuovo lancio, nella stessa transizione -----

test('restart: kill-session prima di new-session, senza rompere la fila', async (t) => {
  const w = mondo(t, { brokerDelayMs: 30 });

  // Prima accensione (fuori dal restart, per avere uno stato iniziale noto).
  await w.runtime.up('CellaLock');
  assert.equal(w.vive().includes(SESSIONE), true, 'preparazione: cella viva');

  const logPrima = w.logChiamate().length;
  const res = await w.runtime.restart('CellaLock');
  assert.equal(res.ok, true, 'restart concluso');

  const log = w.logChiamate().slice(logPrima);
  const idxNew = log.findIndex((l) => l.startsWith('new-session'));
  const idxKill = log.findIndex((l) => l.startsWith('kill-session'));
  assert.notEqual(idxKill, -1, 'restart ferma la sessione vecchia');
  assert.notEqual(idxNew, -1, 'restart rilancia la cella');
  assert.ok(idxKill < idxNew, 'la vecchia sessione viene fermata PRIMA del nuovo lancio');

  // La coda del lock si svuota: un down dopo il restart entra subito e ferma.
  const downRes = await w.runtime.down('CellaLock');
  assert.equal(downRes.ok, true, 'down dopo restart: nessun lock rimasto appeso');
  assert.equal(w.vive().includes(SESSIONE), false, 'sessione ferma');
});

// --- 3. down che fallisce: restart NON rilancia il client ------------------

test('restart con down fallito: nessun nuovo lancio del client', async (t) => {
  const w = mondo(t, { brokerDelayMs: 5, killSessionFallisce: true });

  await w.runtime.up('CellaLock');
  assert.equal(w.vive().includes(SESSIONE), true, 'preparazione: cella viva');
  const ticketPrima = w.ticket.length;

  // kill-session risponde con un errore operativo (non «sessione assente»):
  // il down NON si e' concluso. Il restart deve propagare il fallimento e NON
  // chiamare l'up: rilanciare sopra un down incompleto e' il difetto che la
  // serializzazione del ciclo di vita vieta.
  await assert.rejects(() => w.runtime.restart('CellaLock'), (e) => {
    assert.equal(e.status, 500);
    return true;
  });
  assert.equal(w.ticket.length, ticketPrima,
    'nessun ticket nuovo: il client non e\' stato rilanciato dopo un down fallito');
});

// --- 4. la sessione gia' assente resta idempotente -------------------------

test('down su cella gia' + String.fromCharCode(39) + 'assente: ok, nessun errore', async (t) => {
  const w = mondo(t, {});
  const res = await w.runtime.down('CellaLock');
  assert.equal(res.ok, true, 'down su cella spenta: ok idempotente');
});
