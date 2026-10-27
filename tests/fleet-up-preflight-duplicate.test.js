'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
// Percorso assoluto via __dirname: il modulo resta caricabile anche quando
// questo file viene eseguito in un contesto con require reindirizzato.
const { verificaUscitaServer } = require(path.join(__dirname, 'tmux-server-exit-guard.js'));

function createHarness(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-dup-'));
  fs.mkdirSync(path.join(home, 'cwd'));
  fs.mkdirSync(path.join(home, 'files'));
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { recursive: true });

  const defs = {
    engines: [{ id: 'e', command: '/bin/true', args: [] }],
    cells: [{ id: 'Cell', engine: 'e', tmuxSession: 'test-Cell', cwd: path.join(home, 'cwd') }],
  };

  const events = [];
  let alive = false;
  let server = 'A';

  const channel = {
    chiama: async (tipo, args) => {
      events.push(`owned:${tipo}:${server}`);
      return { ok: true, testo: tipo === 'display-message' ? ['4242'] : [] };
    },
    morto: () => false,
    chiudi: () => { events.push('channelClose'); },
    hasSession: async () => ({ ok: alive }),
    killSession: async () => { events.push(`killViaChannel:${server}`); alive = false; return { ok: true }; },
  };

  const tmuxExec = async (bin, args) => {
    let socket = null;
    let effectiveArgs = args;
    if (args[0] === '-S') {
      socket = args[1];
      effectiveArgs = args.slice(2);
    }
    events.push(`tmux:${effectiveArgs[0]}:${server}`);
    if (effectiveArgs[0] === 'list-sessions') {
      return { err: null, stdout: '', stderr: '' };
    }
    if (effectiveArgs[0] === 'has-session') {
      return { err: alive ? null : Object.assign(new Error('absent'), { code: 1 }), stdout: '', stderr: '' };
    }
    if (effectiveArgs[0] === 'new-session') {
      alive = true;
      return { err: null, stdout: '$5\t@5\t%5\n', stderr: '' };
    }
    if (effectiveArgs[0] === 'display-message') {
      return { err: null, stdout: `${socket || '/synthetic/socket'}\t4242\n`, stderr: '' };
    }
    if (effectiveArgs[0] === 'set-option') {
      return { err: null, stdout: '', stderr: '' };
    }
    if (effectiveArgs[0] === 'respawn-pane') {
      return { err: null, stdout: '', stderr: '' };
    }
    if (effectiveArgs[0] === 'kill-session') {
      alive = false;
      return { err: null, stdout: '', stderr: '' };
    }
    return { err: null, stdout: '', stderr: '' };
  };

  let savedTarget = null;
  const targets = {
    registra: (r, s, o) => { savedTarget = o; return true; },
    leggi: () => (savedTarget ? { stato: 'presente', record: savedTarget } : { stato: 'assente' }),
    marcaIncerto: () => { if (savedTarget) savedTarget.incerto = true; return true; },
    rimuovi: () => { savedTarget = null; return true; },
  };

  const runtime = createBuiltinRuntime({
    cfg: { activityHooks: false, launchReadyMs: 0, filesRoot: path.join(home, 'files'), log: () => {}, vlLaunchCooldownMs: 0 },
    home,
    defsPath: path.join(home, 'defs.json'),
    tmuxBin: '/bin/tmux',
    readonly: () => false,
    launchBroker: { issue: async () => ({ nonce: 'n'.repeat(64), socketPath: path.join(home, 'broker') }), revoke: async () => {} },
    boot: defs,
  });

  const cleanup = async () => {
    try {
      if (runtime && typeof runtime.shutdown === 'function') {
        runtime.shutdown();
      }
    } catch (_) {}

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

  return { home, defs, runtime, events, targets, alive: () => alive, cleanup };
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
    const newSessionsBefore = h.events.filter((e) => e.startsWith('tmux:new-session')).length;

    await assert.rejects(
      async () => h.runtime.up('Cell'),
      (err) => err.status === 409 && err.fleetCode === 'SESSION_DUPLICATE',
    );

    const newSessionsAfter = h.events.filter((e) => e.startsWith('tmux:new-session')).length;
    assert.equal(newSessionsBefore, newSessionsAfter, 'no new tmux session created on duplicate up');
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
