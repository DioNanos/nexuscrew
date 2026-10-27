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
// in vita, quindi la sessione, il server tmux per-lancio e il canale di
// controllo posseduto sopravvivono fino alla seconda up(). La fixture con un
// broker senza listener faceva uscire cell-exec subito: spento il
// remain-on-exit diagnostico, tmux chiudeva la sessione prima del secondo up()
// e il 409 dipendeva dall'istante in cui il canale registrava la morte del
// proprio server (referto DevAuditor 2026-10-27: 3-4 fail su 15,
// «Missing expected rejection»).
function createHarness(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-dup-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  fs.mkdirSync(path.join(home, 'files'));
  // 0700: il broker di lancio vero rifiuta una run dir leggibile ad altri
  // (ensureRuntimeDir e' fail-closed sulla modalita' della directory).
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

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

    const runDir = path.join(home, '.nexuscrew', 'run');
    if (fs.existsSync(runDir)) {
      let socks = [];
      try {
        socks = fs.readdirSync(runDir)
          .filter((f) => f.endsWith('.sock'))
          .map((f) => path.join(runDir, f));
      } catch (_) {}

      for (const sock of socks) {
        let serverPid = null;
        try {
          const pidOut = spawnSync('/bin/tmux', ['-S', sock, 'display-message', '-p', '#{pid}'], { encoding: 'utf8', timeout: 2000 });
          const n = Number(String(pidOut.stdout || '').trim());
          if (Number.isInteger(n) && n > 0) serverPid = n;
        } catch (_) {}

        try {
          spawnSync('/bin/tmux', ['-S', sock, 'kill-server'], { timeout: 5000 });
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
      }
    }

    try {
      fs.rmSync(home, { recursive: true, force: true });
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
