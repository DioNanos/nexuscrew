'use strict';

const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeSpawnError, main } = require('../lib/fleet/cell-exec.js');
const { scriviStato, scriviGenerazione, leggiAttivita } = require('../lib/files/activity.js');

// Fake child_process spawn result: an EventEmitter that understands the
// `.once(event, fn)` / `.kill(signal)` surface main() uses, plus an async
// `emitLater` to schedule the spawn 'error' from the next tick (mirrors how
// node delivers ENOENT/EACCES asynchronously after spawn() returns).
function fakeChild() {
  const ee = new EventEmitter();
  ee.kill = () => {};
  return ee;
}

test('sanitizeSpawnError: ENOENT yields stable code + basename, never the path', () => {
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, '/home/secret/.local/bin/node');
  assert.equal(msg, 'nexuscrew cell spawn failed: ENOENT node');
  assert.ok(!msg.includes('/home/secret'));
  assert.ok(!msg.includes('.local'));
  assert.ok(!msg.includes('/'));
});

test('sanitizeSpawnError: EACCES keeps basename without leaking the install dir', () => {
  const msg = sanitizeSpawnError({ code: 'EACCES' }, '/home/tester/.local/codex.js');
  assert.equal(msg, 'nexuscrew cell spawn failed: EACCES codex.js');
  assert.ok(!msg.includes('/home/tester'));
  assert.ok(!msg.includes('.codex'));
});

test('sanitizeSpawnError: argv, env and tokens are never part of the message', () => {
  // Only the command is passed; argv/env are not. Even a command path that
  // contains a token-like substring only exposes its basename.
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, '/home/u/bin/sk-1234567890abcdef');
  assert.equal(msg, 'nexuscrew cell spawn failed: ENOENT sk-1234567890abcdef');
  assert.ok(!msg.includes('/home/u'));
});

test('sanitizeSpawnError: missing code / empty / non-string degrade to SPAWN_ERROR client', () => {
  assert.equal(sanitizeSpawnError({}, ''), 'nexuscrew cell spawn failed: SPAWN_ERROR client');
  assert.equal(sanitizeSpawnError(null, null), 'nexuscrew cell spawn failed: SPAWN_ERROR client');
  assert.equal(sanitizeSpawnError({ code: 2 }, '/bin/node'), 'nexuscrew cell spawn failed: SPAWN_ERROR node');
  // basename('/') is empty -> neutral 'client' label, code still preserved.
  assert.equal(sanitizeSpawnError({ code: 'ENOENT' }, '/'), 'nexuscrew cell spawn failed: ENOENT client');
  assert.equal(
    sanitizeSpawnError({ code: 'ENOENT\nforged' }, '/bin/node'),
    'nexuscrew cell spawn failed: SPAWN_ERROR node',
  );
});

test('sanitizeSpawnError: basename is bounded before it reaches pane diagnostics', () => {
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, `/bin/${'x'.repeat(400)}`);
  assert.equal(msg, `nexuscrew cell spawn failed: ENOENT ${'x'.repeat(128)}`);
});

test('sanitizeSpawnError: control characters in basename are stripped', () => {
  const msg = sanitizeSpawnError({ code: 'ENOENT' }, '/bin/x\x07y\nz');
  assert.ok(!msg.includes('\x07'));
  assert.ok(!msg.includes('\n'));
  assert.match(msg, /nexuscrew cell spawn failed: ENOENT xyz$/);
});

test('main: spawn ENOENT writes sanitized stderr and resolves 1 (never rejects)', async () => {
  let stderr = '';
  const child = fakeChild();
  const spawnStub = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => ({
      command: '/home/secret/.local/bin/codex',
      args: ['--dangerously-skip-permissions', '--model', 'gpt-5'],
      env: { OPENAI_API_KEY: 'sk-leak' },
    }),
    spawn: spawnStub,
    stderrWrite: (s) => { stderr += s; },
  });
  assert.equal(code, 1);
  assert.match(stderr, /nexuscrew cell spawn failed: ENOENT codex$/m);
  // No secret/path/argv may reach the pane-captured stderr.
  assert.ok(!stderr.includes('/home/secret'));
  assert.ok(!stderr.includes('.local'));
  assert.ok(!stderr.includes('sk-leak'));
  assert.ok(!stderr.includes('OPENAI_API_KEY'));
  assert.ok(!stderr.includes('--dangerously-skip-permissions'));
});

test('main: spawn EACCES surfaces the stable code and basename only', async () => {
  let stderr = '';
  const child = fakeChild();
  const spawnStub = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'b'.repeat(64)], {
    receivePayload: async () => ({ command: '/data/data/com.termux/files/usr/bin/node', args: [], env: {} }),
    spawn: spawnStub,
    stderrWrite: (s) => { stderr += s; },
  });
  assert.equal(code, 1);
  assert.match(stderr, /nexuscrew cell spawn failed: EACCES node$/m);
  assert.ok(!stderr.includes('/data/data/com.termux'));
});

test('main: a child that exits normally still resolves its exit code', async () => {
  const child = fakeChild();
  const spawnStub = () => {
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => ({ command: '/bin/true', args: [], env: {}, supervise: { enabled: false } }),
    spawn: spawnStub,
    stderrWrite: () => {},
  });
  assert.equal(code, 0);
});

test('main: broker payload env reaches the child, including MCP_DEVICE', async () => {
  const child = fakeChild();
  let capturedEnv = null;
  const spawnStub = (command, args, options) => {
    capturedEnv = options.env;
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'd'.repeat(64)], {
    receivePayload: async () => ({
      command: '/bin/true', args: [],
      env: { MCP_DEVICE: 'dev-agent' },
      supervise: { enabled: false },
    }),
    spawn: spawnStub,
    stderrWrite: () => {},
  });
  assert.equal(code, 0);
  assert.equal(capturedEnv.MCP_DEVICE, 'dev-agent');
});

// --- uscita del client: il riavvio INTERNO non eredita lo stato ------------
//
// Il supervisore riavvia il client dentro lo STESSO lancio, quindi `activity.gen`
// non cambia: la generazione non puo' accorgersi che il client precedente e'
// morto. Senza questa dichiarazione uno `Stop` dell'ultimo turno resterebbe
// «ferma» per tutto il backoff — e per sempre, ora che «ferma» non scade —
// mentre il client e' morto e il prossimo non e' pronto.

const T0 = 1_700_000_000_000;

function conAttivita(t, { activity = true, supervise = { enabled: false } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cell-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessione = 'cloud-Dev';
  const dir = path.join(root, sessione);
  scriviGenerazione(dir, 'gen-1');
  scriviStato(dir, { evento: 'Stop', generazione: 'gen-1', ora: T0 });
  const child = fakeChild();
  const spawnStub = () => { queueMicrotask(() => child.emit('exit', 0, null)); return child; };
  const payload = {
    command: '/bin/true', args: [], env: {},
    supervise,
    ...(activity ? { activity: { dir, generation: 'gen-1' } } : {}),
  };
  return { root, sessione, dir, main: () => main(['--socket', '/tmp/nc-x', '--nonce', 'e'.repeat(64)], {
    receivePayload: async () => payload, spawn: spawnStub, stderrWrite: () => {}, now: () => T0 + 2000,
  }) };
}

test('main: il client esce -> lo stato del turno precedente non e\' piu\' verificabile', async (t) => {
  const c = conAttivita(t);
  assert.equal(leggiAttivita(c.root, c.sessione, T0 + 1000).stato, 'ferma', 'prima dell\'uscita: ferma');
  assert.equal(await c.main(), 0);
  assert.equal(leggiAttivita(c.root, c.sessione, T0 + 3000), null,
    'il client e\' uscito: non verificato, non «ferma»');
  assert.equal(leggiAttivita(c.root, c.sessione, T0 + 60 * 60 * 1000), null,
    'e non torna «ferma» col tempo');
});

test('main: senza canale di attivita\' nel payload non si scrive nulla', async (t) => {
  const c = conAttivita(t, { activity: false });
  assert.equal(await c.main(), 0);
  assert.equal(leggiAttivita(c.root, c.sessione, T0 + 3000).stato, 'ferma',
    'nessun hook iniettato = nessuno stato da invalidare');
});

test('main: l\'uscita si dichiara anche quando il child non e\' mai partito', async (t) => {
  // Un errore di spawn e' un'uscita come le altre: il client non c'e', quindi
  // il «ferma» dell'ultimo turno non e' piu' verificabile.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cell-exit-err-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessione = 'cloud-Dev';
  const dir = path.join(root, sessione);
  scriviGenerazione(dir, 'gen-1');
  scriviStato(dir, { evento: 'Stop', generazione: 'gen-1', ora: T0 });
  const child = fakeChild();
  const code = await main(['--socket', '/tmp/nc-x', '--nonce', 'f'.repeat(64)], {
    receivePayload: async () => ({
      command: '/bin/true', args: [], env: {},
      activity: { dir, generation: 'gen-1' },
    }),
    spawn: () => { queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return child; },
    stderrWrite: () => {}, now: () => T0 + 2000,
  });
  assert.equal(code, 1);
  assert.equal(leggiAttivita(root, sessione, T0 + 3000), null);
});
