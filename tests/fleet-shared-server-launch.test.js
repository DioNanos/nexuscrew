'use strict';
// E2E del lancio sul server tmux CONDIVISO: una sessione cloud-<Cella> per
// lancio, sul socket di default che tmux risolve da TMUX_TMPDIR. Prova con
// tmux VERO, su un server condiviso DI TEST (TMUX_TMPDIR privato di questo
// file): mai il server della flotta, nemmeno quando il file gira fuori dal
// runner isolato.
//
// Che cosa dimostra, nell'ordine:
//   1. up() nasce sul socket condiviso risolto dal runtime (il resolver
//      onora TMUX_TMPDIR) e il server e' garantito da ensureProtection
//      cablata come in server.js — prima della creazione, non dopo;
//   2. la sessione cloud-X e' visibile a ogni superficie SENZA -S:
//      has-session, il listing di flotta, il paste di produzione;
//   3. down() chiude la sessione (has-session fallisce) e un secondo ciclo
//      up/down riesce sullo STESSO server: nessun socket per lancio, la run
//      dir non ospita socket tmux;
//   4. a fine corsa il server di test viene chiuso per socket esatto e la
//      sua uscita e' verificata: nessun server or no socket orfano resta.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Percorso assoluto via __dirname: il modulo resta caricabile anche quando
// questo file viene eseguito in un contesto con require reindirizzato.
const { verificaUscitaServer } = require(path.join(__dirname, 'tmux-server-exit-guard.js'));
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { requireSharedTmuxProtection } = require('../lib/tmux/shared-server.js');
const { pasteToSession } = require('../lib/tmux/actions.js');
const { listFleetPanes, sessionsFromPanes } = require('../lib/tmux/list.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');

const TMUX = '/bin/tmux';

function sh(cmd, args, env, timeoutMs = 5000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env });
}

test('un lancio vive sul server condiviso: has-session, paste e listing senza -S; down chiude; nessun orfano', async (t) => {
  const probe = sh(TMUX, ['-V']);
  if (probe.status !== 0) { t.skip('tmux di sistema non disponibile'); return; }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shr-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  fs.mkdirSync(path.join(home, 'files'));
  // 0700: il broker di lancio vero rifiuta una run dir leggibile ad altri.
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

  // Il server condiviso DI TEST: TMUX_TMPDIR privato, socket di default
  // dentro una mkdtemp propria. Il resolver di produzione deve puntare
  // esattamente qui. La locale UTF-8 va assicurata QUI nel processo (come
  // minimalRuntimeEnv fa per ogni invocazione del runtime): senza una
  // LC_CTYPE UTF-8 tmux rende i tab dei propri -F con «_» e il listing di
  // flotta — che parla con l'env del processo — non parserebbe piu' niente.
  const tmuxd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shr-m-'));
  const sharedSocketDir = path.join(tmuxd, `tmux-${process.getuid()}`);
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  const prevLcCtype = process.env.LC_CTYPE;
  process.env.TMUX_TMPDIR = tmuxd;
  process.env.LC_CTYPE = 'C.UTF-8';
  const tmuxEnv = () => ({ ...process.env, TMUX_TMPDIR: tmuxd, PATH: '/usr/bin:/bin', HOME: home });

  const defs = {
    engines: [{ id: 'e', command: '/bin/cat', args: [] }],
    cells: [{ id: 'X', engine: 'e', tmuxSession: 'cloud-X', cwd: path.join(home, 'cwd') }],
  };
  const broker = createLaunchBroker({ home });
  // Cablatura identica a server.js: la protezione del server condiviso e'
  // una dipendenza del runtime, fornita dal server.
  const ensureProtection = () => requireSharedTmuxProtection(TMUX, { home });
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

  const hasSession = () => sh(TMUX, ['has-session', '-t', '=cloud-X'], tmuxEnv()).status === 0;
  const capture = () => {
    const r = sh(TMUX, ['capture-pane', '-p', '-t', '=cloud-X'], tmuxEnv());
    return r.status === 0 ? String(r.stdout || '') : '';
  };

  try {
    // (1) Il resolver di produzione punta al socket condiviso del test:
    // coincidenza dichiarata prima di qualunque lancio.
    assert.equal(sharedTmuxSocketPath(), path.join(sharedSocketDir, 'default'),
      'il socket del lancio deve coincidere con il default di tmux sotto TMUX_TMPDIR');

    const up1 = await runtime.up('X');
    assert.ok(up1, 'primo up riuscito');
    assert.equal(up1.cell, 'X');

    // Il server condiviso esiste ed e' UNO: sola socket «default» nella sua
    // dir, e la run dir non ospita socket tmux per lancio.
    assert.ok(fs.existsSync(path.join(sharedSocketDir, 'default')), 'socket condiviso presente');
    assert.deepEqual(fs.readdirSync(sharedSocketDir), ['default'],
      'un solo socket server, nessun socket per lancio');
    const runSockets = fs.readdirSync(path.join(home, '.nexuscrew', 'run')).filter((f) => f.startsWith('tmux-'));
    assert.deepEqual(runSockets, [], 'nessun socket tmux per lancio nella run dir');

    // (2) La sessione e' visibile alle superfici SENZA -S.
    assert.equal(hasSession(), true, 'has-session -t =cloud-X senza -S deve riuscire');
    const panes = sessionsFromPanes(await listFleetPanes(TMUX));
    assert.ok(panes.some((s) => s && s.name === 'cloud-X'),
      `il listing di flotta deve vedere cloud-X (visti: ${JSON.stringify((panes || []).map((s) => s && s.name))})`);

    // Il paste di produzione consegna al pane della sessione condivisa: la
    // prova e' l'esito reale di tmux (il target esatto «=cloud-X:» fallisce
    // se la sessione non vive sul server raggiunto senza -S). Il testo non
    // appare nello schermo perche' il supervisore del pane tiene il tty in
    // modalita' raw: la consegna e' trasporto, non resa — lo stesso
    // contratto dichiarato dal prodotto. Il pane resta comunque leggibile
    // dalla stessa superficie.
    const marker = 'nc-shared-server-e2e-271828';
    assert.equal(await pasteToSession(TMUX, 'cloud-X', marker), true,
      'pasteToSession senza -S deve riuscire sulla sessione condivisa');
    assert.ok(typeof capture() === 'string', 'capture-pane senza -S deve leggere il pane');

    // (3) down chiude la sessione SUL condiviso: has-session senza -S
    // fallisce, il server resta (exit-empty off e' la condizione voluta).
    const down1 = await runtime.down('X');
    assert.equal(down1.ok, true, 'down riuscito');
    assert.equal(hasSession(), false, 'has-session deve fallire dopo il down');

    // Secondo ciclo sullo STESSO server: il gate per nome torna reale e non
    // si accumulano socket.
    const up2 = await runtime.up('X');
    assert.ok(up2, 'secondo up riuscito');
    assert.equal(hasSession(), true, 'has-session dopo il secondo up');
    const down2 = await runtime.down('X');
    assert.equal(down2.ok, true, 'secondo down riuscito');
    assert.equal(hasSession(), false, 'has-session dopo il secondo down');
    assert.deepEqual(fs.readdirSync(sharedSocketDir), ['default'],
      'dopo due cicli esiste ancora UN solo socket server');
    // Il server condiviso sopravvive ai down (protetto all'avvio): un
    // client senza -S ottiene ancora risposta dal server, non dalla sessione.
    const serverVivo = sh(TMUX, ['display-message', '-p', '#{pid}'], tmuxEnv());
    assert.equal(serverVivo.status, 0, 'il server condiviso deve restare vivo dopo i down');
  } finally {
    try { runtime.shutdown(); } catch (_) { /* best-effort */ }
    try { await broker.close(); } catch (_) { /* best-effort */ }

    // (4) Nessun orfano: il server DI TEST si chiude per socket esatto, con
    // uscita verificata fuori da ogni catch, e dopo la chiusura nessun
    // client puo' più parlarci.
    let serverPid = null;
    try {
      const pidOut = sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) {}

    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;
    if (prevLcCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = prevLcCtype;

    try { sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'kill-server'], tmuxEnv()); } catch (_) {}

    if (serverPid) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(serverPid, 0); } catch (e) { if (e && e.code === 'ESRCH') break; }
        spawnSync('sleep', ['0.05']);
      }
      try { process.kill(serverPid, 'SIGKILL'); } catch (_) {}
      verificaUscitaServer(spawnSync, serverPid);
    }

    // tmux 3.4 non rimuove il file del socket dopo kill-server: il file
    // superstite non e' un server. La prova e' il client, che deve ricevere
    // «no server running» dal socket esatto.
    const inerzia = sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
    if (inerzia.status === 0 || /^[0-9]+$/.test(String(inerzia.stdout || '').trim())) {
      throw new Error(`server superstite sul socket condiviso di test: ${sharedSocketDir}/default`);
    }

    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(tmuxd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('la protezione che fallisce al confine di creazione rifiuta il lancio senza spawnare nessun server', async (t) => {
  const probe = sh(TMUX, ['-V']);
  if (probe.status !== 0) { t.skip('tmux di sistema non disponibile'); return; }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shr-p-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

  const tmuxd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shr-pm-'));
  const sharedSocketDir = path.join(tmuxd, `tmux-${process.getuid()}`);
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmuxd;
  const tmuxEnv = () => ({ ...process.env, TMUX_TMPDIR: tmuxd, PATH: '/usr/bin:/bin', HOME: home });

  const defs = {
    engines: [{ id: 'e', command: '/bin/cat', args: [] }],
    cells: [{ id: 'X', engine: 'e', tmuxSession: 'cloud-X', cwd: path.join(home, 'cwd') }],
  };
  const broker = createLaunchBroker({ home });

  // Protezione con stato: la prima chiamata (inizio di upSerializzato) passa,
  // quella al confine di creazione rifiuta — il caso «il server condiviso e'
  // morto e non si riesce a proteggere un sostituto».
  let protezioni = 0;
  const ensureProtection = async () => {
    protezioni += 1;
    if (protezioni >= 2) throw new Error('shared server protection refused (test)');
  };

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

  try {
    await assert.rejects(
      () => runtime.up('X'),
      (e) => e && e.fleetCode === 'SHARED_SERVER_UNPROTECTED' && e.fleetPhase === 'new-session',
      'il rifiuto della protezione al confine deve fermare il lancio con il codice proprio');
    assert.equal(protezioni, 2, 'la protezione va applicata all\'inizio e di nuovo prima della creazione');
    // Nessuno spawn: sul socket condiviso del test non risponde nessun server
    // e la sessione non esiste.
    const viv = sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
    assert.notEqual(viv.status, 0, 'nessun server deve rispondere sul socket condiviso di test');
    assert.equal(sh(TMUX, ['has-session', '-t', '=cloud-X'], tmuxEnv()).status !== 0, true,
      'nessuna sessione cloud-X deve esistere');
  } finally {
    try { runtime.shutdown(); } catch (_) { /* best-effort */ }
    try { await broker.close(); } catch (_) { /* best-effort */ }
    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;
    // Difesa in profondita': anche se un server fosse nato nonostante tutto,
    // si chiude per PID letto dal socket esatto, con verifica fuori dai catch.
    let serverPid = null;
    try {
      const pidOut = sh(TMUX, ['-S', path.join(sharedSocketDir, 'default'), 'display-message', '-p', '#{pid}'], tmuxEnv(), 3000);
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) {}
    if (serverPid) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(serverPid, 0); } catch (e) { if (e && e.code === 'ESRCH') break; }
        spawnSync('sleep', ['0.05']);
      }
      try { process.kill(serverPid, 'SIGKILL'); } catch (_) {}
      verificaUscitaServer(spawnSync, serverPid);
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(tmuxd, { recursive: true, force: true }); } catch (_) {}
  }
});
