'use strict';
// E2E del ciclo operator-stop -> up sul server tmux CONDIVISO, con tmux VERO
// e la rotta HTTP di prodotto (POST /api/fleet/down), su un server condiviso
// DI TEST: TMUX_TMPDIR privato di questo file, mai il server della flotta.
//
// Che cosa dimostra, nell'ordine (design del server condiviso, §5):
//   1. up() nasce sul socket condiviso e la cella resta raggiungibile da
//      OGNI superficie senza -S: has-session, il paste di produzione e il
//      listing di flotta vedono cloud-X;
//   2. lo stop operatore via POST /down chiude il lancio e la sessione; il
//      ciclo up -> down ripetuto N volte riesce sempre sullo STESSO server;
//   3. dopo N cicli nella root dell'harness esiste UN solo socket server
//      (tmux-<uid>/default) ed e' vivo: nessun server per lancio, nessun
//      socket orfano, e la run dir non ospita socket tmux;
//   4. a fine corsa il server DI TEST viene chiuso per PID esatto con uscita
//      verificata: nessun orfano.
// Il census in questa E2E e' quello vero del nodo (carico: piu' di CAP_SCAN
// processi): la chiusura pulita non ne dipende, e' l'attestazione a portarla.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
// Percorso assoluto via __dirname: il modulo resta caricabile anche quando
// questo file viene eseguito in un contesto con require reindirizzato.
const { verificaUscitaServer } = require(path.join(__dirname, 'tmux-server-exit-guard.js'));
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { requireSharedTmuxProtection } = require('../lib/tmux/shared-server.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');
const { pasteToSession } = require('../lib/tmux/actions.js');
const { listFleetPanes, sessionsFromPanes } = require('../lib/tmux/list.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');

const TMUX = '/bin/tmux';

function sh(cmd, args, env, timeoutMs = 5000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env });
}

// POST di prodotto verso il router MONTATO: stessa guard, stessi status code,
// stessa forma di /api/fleet di server.js (fleetP qui e' l'adapter minimo che
// il server costruisce intorno al runtime).
function creaServerDiProdotto(runtime) {
  const app = express();
  const fleet = {
    available: true,
    capabilities: () => ['status', 'up', 'down'],
    up: (cell, opts) => runtime.up(cell, opts),
    down: (cell, opts) => runtime.down(cell, opts),
  };
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), {}));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = async (rotta, body) => {
        const res = await fetch(base + rotta, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch (_) { /* corpo non json */ }
        return { status: res.status, json };
      };
      resolve({ server, post });
    });
  });
}

test('ciclo operator-stop -> up sul condiviso: POST /down chiude, N cicli, un solo socket vivo, nessun orfano', async (t) => {
  const probe = sh(TMUX, ['-V']);
  if (probe.status !== 0) { t.skip('tmux di sistema non disponibile'); return; }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cyc-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  fs.mkdirSync(path.join(home, 'files'));
  // 0700: il broker di lancio vero rifiuta una run dir leggibile ad altri.
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

  // Il server condiviso DI TEST: TMUX_TMPDIR privato, socket di default
  // dentro una mkdtemp propria, HOME propria cosi' il server non legge
  // nessun .tmux.conf del nodo. La locale UTF-8 va assicurata QUI nel
  // processo (come minimalRuntimeEnv fa per ogni invocazione): senza una
  // LC_CTYPE UTF-8 tmux rende i tab dei propri -F con «_» e il listing di
  // flotta non parserebbe piu' niente.
  const tmuxd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cyc-m-'));
  const sharedSocketDir = path.join(tmuxd, `tmux-${process.getuid()}`);
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  const prevLcCtype = process.env.LC_CTYPE;
  process.env.TMUX_TMPDIR = tmuxd;
  process.env.LC_CTYPE = 'C.UTF-8';
  const tmuxHome = path.join(tmuxd, 'conf');
  fs.mkdirSync(tmuxHome, { mode: 0o700 });
  const tmuxEnv = () => ({
    ...process.env, TMUX_TMPDIR: tmuxd, PATH: '/usr/bin:/bin',
    HOME: tmuxHome, LC_CTYPE: 'C.UTF-8',
  });

  const defs = {
    engines: [{ id: 'e', command: '/bin/cat', args: [] }],
    cells: [{ id: 'X', engine: 'e', tmuxSession: 'cloud-X', cwd: path.join(home, 'cwd') }],
  };
  const broker = createLaunchBroker({ home });
  // Cablatura identica a server.js: la protezione del server condiviso e'
  // una dipendenza del runtime, fornita dal server.
  const ensureProtection = () => requireSharedTmuxProtection(TMUX, { home: tmuxHome });
  const runtime = createBuiltinRuntime({
    cfg: { activityHooks: false, launchReadyMs: 0, filesRoot: path.join(home, 'files'), log: () => {}, vlLaunchCooldownMs: 0 },
    home,
    defsPath: path.join(home, 'defs.json'),
    tmuxBin: TMUX,
    readonly: () => false,
    launchBroker: {
      issue: async (payload) => broker.issue(payload),
      revoke: async (nonce) => broker.revoke(nonce),
    },
    boot: defs,
    ensureProtection,
  });
  const api = await creaServerDiProdotto(runtime);

  const hasSession = () => sh(TMUX, ['has-session', '-t', '=cloud-X'], tmuxEnv()).status === 0;
  const socketVivo = () => sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);

  try {
    // (0) il resolver di produzione punta al socket condiviso del test
    assert.equal(sharedTmuxSocketPath(), path.join(sharedSocketDir, 'default'),
      'il socket del lancio deve coincidere con il default di tmux sotto TMUX_TMPDIR');

    // (1) il primo up nasce sul condiviso ed e' raggiungibile da tutte le
    // superfici SENZA -S: has-session, paste di produzione, listing
    const up1 = await api.post('/api/fleet/up', { cell: 'X' });
    assert.equal(up1.status, 200, `up via HTTP: ${JSON.stringify(up1.json)}`);
    assert.equal(up1.json.cell, 'X');
    assert.equal(hasSession(), true, 'has-session -t =cloud-X senza -S deve riuscire');
    const panes = sessionsFromPanes(await listFleetPanes(TMUX));
    assert.ok(panes.some((s) => s && s.name === 'cloud-X'),
      `il listing di flotta deve vedere cloud-X (visti: ${JSON.stringify((panes || []).map((s) => s && s.name))})`);
    const marker = 'nc-cycle-e2e-31415';
    assert.equal(await pasteToSession(TMUX, 'cloud-X', marker), true,
      'pasteToSession senza -S deve riuscire sulla sessione condivisa');

    // (2) lo stop operatore e' la rotta di prodotto: POST /down, 200, la
    // sessione sparisce e il lancio resta chiuso in modo pulito
    const down1 = await api.post('/api/fleet/down', { cell: 'X' });
    assert.equal(down1.status, 200, `down via HTTP: ${JSON.stringify(down1.json)}`);
    assert.equal(down1.json.ok, true);
    assert.equal(hasSession(), false, 'has-session deve fallire dopo il down');

    // (3) N cicli completi up -> down sullo STESSO server condiviso
    const CICLI = 3;
    for (let i = 0; i < CICLI; i += 1) {
      const up = await api.post('/api/fleet/up', { cell: 'X' });
      assert.equal(up.status, 200, `ciclo ${i + 1}: up ${JSON.stringify(up.json)}`);
      assert.equal(hasSession(), true, `ciclo ${i + 1}: sessione presente`);
      const down = await api.post('/api/fleet/down', { cell: 'X' });
      assert.equal(down.status, 200, `ciclo ${i + 1}: down ${JSON.stringify(down.json)}`);
      assert.equal(down.json.ok, true, `ciclo ${i + 1}: down pulito (${JSON.stringify(down.json)})`);
      assert.equal(hasSession(), false, `ciclo ${i + 1}: sessione chiusa`);
    }

    // (3b) un solo socket server nella root dell'harness, ed e' vivo: il
    // server per lancio non esiste piu', exit-empty off e' la condizione
    // voluta del condiviso protetto all'avvio
    assert.ok(fs.existsSync(path.join(sharedSocketDir, 'default')), 'socket condiviso presente');
    assert.deepEqual(fs.readdirSync(sharedSocketDir), ['default'],
      'un solo socket server, nessun socket per lancio');
    const runSockets = fs.readdirSync(path.join(home, '.nexuscrew', 'run')).filter((f) => f.startsWith('tmux-'));
    assert.deepEqual(runSockets, [], 'nessun socket tmux per lancio nella run dir');
    const vivo = socketVivo();
    assert.equal(vivo.status, 0, 'il server condiviso deve essere vivo dopo i cicli');
    assert.ok(/^[0-9]+$/.test(String(vivo.stdout || '').trim()), 'il server risponde con il proprio pid');
  } finally {
    try { runtime.shutdown(); } catch (_) { /* best-effort */ }
    try { api.server.close(); } catch (_) { /* best-effort */ }
    try { await broker.close(); } catch (_) { /* best-effort */ }

    // (4) Nessun orfano: il server DI TEST si chiude per PID letto dal socket
    // esatto, con uscita verificata fuori da ogni catch.
    let serverPid = null;
    try {
      const pidOut = socketVivo();
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) {}

    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;
    if (prevLcCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = prevLcCtype;

    if (serverPid) {
      try { process.kill(serverPid, 'SIGTERM'); } catch (_) {}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(serverPid, 0); } catch (e) { if (e && e.code === 'ESRCH') break; }
        spawnSync('sleep', ['0.05']);
      }
      try { process.kill(serverPid, 'SIGKILL'); } catch (_) {}
      verificaUscitaServer(spawnSync, serverPid);
    }

    // tmux non rimuove sempre il file del socket dopo la morte del server:
    // il file superstite non e' un server. La prova e' il client, che deve
    // ricevere «no server running» dal socket esatto.
    const inerzia = sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
    if (inerzia.status === 0 || /^[0-9]+$/.test(String(inerzia.stdout || '').trim())) {
      throw new Error(`server superstite sul socket condiviso di test: ${sharedSocketDir}/default`);
    }

    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(tmuxd, { recursive: true, force: true }); } catch (_) {}
  }
});
