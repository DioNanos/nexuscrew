'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
// Percorso assoluto via __dirname: il modulo resta caricabile anche quando
// questo file viene eseguito in un contesto con require reindirizzato.
const { verificaUscitaServer } = require(path.join(__dirname, 'tmux-server-exit-guard.js'));

// La precondizione di questi test e' una cella REALMENTE viva: tmux vero,
// broker di lancio vero (con listener) e un comando engine longevo. Con il
// broker ascoltante il supervisore cell-exec ritira il payload e tiene il pane
// in vita, quindi la sessione, il canale di controllo posseduto e il server
// condiviso che la ospita sopravvivono fino alla seconda up(). La fixture con
// un broker senza listener faceva uscire cell-exec subito: spento il
// remain-on-exit diagnostico, tmux chiudeva la sessione prima del secondo up()
// e il 409 dipendeva dall'istante in cui il canale registrava la morte del
// proprio server (osservato in una corsa precedente: 3-4 fallimenti su 15,
// «Missing expected rejection»).
function createHarness(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-dup-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  fs.mkdirSync(path.join(home, 'files'));
  // 0700: il broker di lancio vero rifiuta una run dir leggibile ad altri
  // (ensureRuntimeDir e' fail-closed sulla modalita' della directory).
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

  // Il lancio vive sul server tmux CONDIVISO: il runtime ne risolve il
  // socket di default tramite TMUX_TMPDIR, quindi la harness gliene dà uno
  // privato (tmux-<uid>/default dentro una mkdtemp propria). La sessione
  // nasce su un server condiviso VERO ma di test — mai su quello della
  // flotta, nemmeno quando questo file gira fuori dal runner isolato — e
  // ogni test del file ha il suo: il 409 del secondo up non puo' arrivare
  // per contaminazione fra harness.
  const tmuxd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-dup-m-'));
  const sharedSocket = path.join(tmuxd, `tmux-${process.getuid()}`, 'default');
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmuxd;
  // Nessun selettore ereditato: senza -S un client con TMUX ambientale
  // seguirebbe quel socket invece del default sotto TMUX_TMPDIR.
  const tmuxEnv = () => ({ ...process.env, TMUX_TMPDIR: tmuxd, TMUX: '', TMUX_PANE: '', PATH: '/usr/bin:/bin', HOME: home });

  const defs = {
    engines: [{ id: 'e', command: '/bin/sleep', args: ['600'] }],
    cells: [{ id: 'Cell', engine: 'e', tmuxSession: 'test-Cell', cwd: path.join(home, 'cwd') }],
  };

  const events = [];
  const broker = createLaunchBroker({ home });

  const runtime = createBuiltinRuntime({
    cfg: { activityHooks: false, launchReadyMs: 0, filesRoot: path.join(home, 'files'), log: () => {}, vlLaunchCooldownMs: 0 },
    home,
    defsPath: path.join(home, 'defs.json'),
    tmuxBin: '/bin/tmux',
    readonly: () => false,
    // Broker reale: ogni ticket emesso e' ritirabile dal supervisore. Un issue
    // precede sempre la new-session nello stesso up(), quindi il conteggio
    // degli issue e' il conteggio dei lanci effettivi (il vecchio filtro
    // 'tmux:new-session' contava eventi di un mock mai cablato nel runtime).
    launchBroker: {
      issue: async (payload) => { events.push('launch:issue'); return broker.issue(payload); },
      revoke: async (nonce) => { events.push('launch:revoke'); return broker.revoke(nonce); },
    },
    boot: defs,
  });

  const cleanup = async () => {
    try {
      if (runtime && typeof runtime.shutdown === 'function') {
        runtime.shutdown();
      }
    } catch (_) {}
    try { await broker.close(); } catch (_) { /* best-effort: socket gia' chiusa */ }

    // Il server condiviso della harness si chiude per socket ESATTO: e' il
    // solo server che questo test ha il diritto di fermare (la run dir
    // ospita solo i socket del broker di lancio, che broker.close() chiude).
    // Il pid si legge PRIMA del kill-server; l'uscita si verifica DOPO.
    let serverPid = null;
    try {
      const pidOut = spawnSync('/bin/tmux', ['-S', sharedSocket, 'display-message', '-p', '#{pid}'],
        { encoding: 'utf8', timeout: 2000, env: tmuxEnv() });
      const n = Number(String(pidOut.stdout || '').trim());
      if (Number.isInteger(n) && n > 0) serverPid = n;
    } catch (_) {}

    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;

    try {
      spawnSync('/bin/tmux', ['-S', sharedSocket, 'kill-server'], { timeout: 5000, env: tmuxEnv() });
    } catch (_) {}

    if (serverPid) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(serverPid, 0);
        } catch (e) {
          if (e && e.code === 'ESRCH') break;
        }
        spawnSync('sleep', ['0.05']);
      }
      try {
        process.kill(serverPid, 'SIGKILL');
      } catch (_) {}
      // Verifica obbligatoria di terminazione, FUORI da ogni catch: un
      // server superstite — o una ps senza verdetto — fa fallire il test.
      verificaUscitaServer(spawnSync, serverPid);
    }

    // tmux 3.4 non rimuove il file del socket dopo kill-server: un file
    // superstite non e' un server superstite. La prova che non resta NESSUN
    // server e' il client: sul socket esatto deve rispondere «no server
    // running» (fallire), non collegarsi. Fuori da ogni catch.
    const inerzia = spawnSync('/bin/tmux', ['-S', sharedSocket, 'display-message', '-p', '#{pid}'],
      { encoding: 'utf8', timeout: 3000, env: tmuxEnv() });
    if (inerzia.status === 0 || /^[0-9]+$/.test(String(inerzia.stdout || '').trim())) {
      throw new Error(`server superstite sul socket condiviso di test: ${sharedSocket}`);
    }

    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (_) {}
    try {
      fs.rmSync(tmuxd, { recursive: true, force: true });
    } catch (_) {}
  };

  return { home, defs, runtime, events, cleanup };
}

test('second up of a live owned cell is rejected with 409 SESSION_DUPLICATE', async () => {
  const h = createHarness();
  try {
    const res1 = await h.runtime.up('Cell');
    assert.ok(res1);
    assert.equal(res1.cell, 'Cell');

    await assert.rejects(
      async () => h.runtime.up('Cell'),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.fleetCode, 'SESSION_DUPLICATE');
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});

test('repeated boot preserves live cell and refuses duplicate launch', async () => {
  const h = createHarness();
  try {
    await h.runtime.up('Cell');
    const launchesBefore = h.events.filter((e) => e.startsWith('launch:issue')).length;

    await assert.rejects(
      async () => h.runtime.up('Cell'),
      (err) => err.status === 409 && err.fleetCode === 'SESSION_DUPLICATE',
    );

    // Un issue precede sempre la new-session nello stesso up(): nessun issue
    // in piu' = nessuna sessione nuova creata dal duplicato.
    const launchesAfter = h.events.filter((e) => e.startsWith('launch:issue')).length;
    assert.equal(launchesBefore, launchesAfter, 'no new tmux session created on duplicate up');
  } finally {
    await h.cleanup();
  }
});

test('engine definition changed after launch still sees live cell and rejects duplicate up', async () => {
  const h = createHarness();
  try {
    await h.runtime.up('Cell');

    // Change the engine definition
    h.defs.engines[0] = { id: 'e', command: '/bin/echo', args: ['changed'] };

    await assert.rejects(
      async () => h.runtime.up('Cell'),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.fleetCode, 'SESSION_DUPLICATE');
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});
