'use strict';

const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeSpawnError, main } = require('../lib/fleet/cell-exec.js');
const { scriviStato, scriviGenerazione, leggiAttivita, AVVIO } = require('../lib/files/activity.js');

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

// --- la generazione di attivita' la scrive CHI VINCE ------------------------
//
// `cell-exec` gira DENTRO la sessione tmux appena creata: chi perde la corsa
// sulla new-session non arriva mai qui. Prima questa scrittura stava nella
// risoluzione dello spec, che gira per tutti — anche per chi stava per perdere:
// sul disco restava la generazione del perdente e ogni evento del vincitore
// veniva scartato al lettore.

function activityDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exec-gen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function payloadCon(dir, generation) {
  return {
    command: '/home/tester/bin/client', args: [], env: {},
    supervise: { enabled: false },
    activity: { dir, generation },
  };
}

test("cell-exec: invalida lo stato del client precedente e dichiara la garanzia dell'uscita", async (t) => {
  const dir = activityDir(t);
  const gen = 'c'.repeat(16);
  // Lo stato lasciato dal client precedente: un «ferma» dell'ultimo turno.
  scriviGenerazione(dir, 'gen-vecchia');
  scriviStato(dir, { evento: 'Stop', generazione: 'gen-vecchia', ora: Date.now() });
  assert.equal(leggiAttivita(path.dirname(dir), path.basename(dir)).stato, 'ferma', 'prima del lancio si leggeva');

  const child = fakeChild();
  let statoAlloSpawn = null;
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => payloadCon(dir, gen),
    spawn: () => {
      // Lo stato COME E' AL MOMENTO DELLO SPAWN: piu' tardi arriverebbe anche
      // l'uscita del client finto (spawn fallito), che lo sovrascriverebbe e
      // nasconderebbe proprio cio' che questo test deve provare.
      try { statoAlloSpawn = JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8')); } catch (_) {}
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    },
    stderrWrite: () => {},
  });
  assert.equal(code, 1);
  assert.ok(statoAlloSpawn, 'lo stato e stato scritto prima dello spawn');
  assert.equal(statoAlloSpawn.event, AVVIO, 'al momento dello spawn lo stato e quello del LANCIO');
  assert.equal(statoAlloSpawn.generation, gen, 'e porta la generazione nuova');

  // 1. Lo stato precedente e' INVALIDATO: l'evento di lancio porta la
  //    generazione nuova e il lettore lo mappa a null. Senza, il «ferma» di
  //    prima sarebbe sopravvissuto al lancio — per sempre, se nessun hook lo
  //    rinnova.
  assert.equal(leggiAttivita(path.dirname(dir), path.basename(dir)), null,
    'dopo il lancio lo stato del client precedente non e leggibile');
  const stato = JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'));
  // L'evento scritto e' quello del lancio; in questo test arriva subito dopo
  // anche l'uscita (lo spawn finto fallisce, e il supervisore la dichiara).
  // Entrambi invalidano, ed e' quello che conta: la generazione e' la NUOVA.
  assert.ok([AVVIO, 'ClientExit'].includes(stato.event), `evento: ${stato.event}`);
  assert.equal(stato.generation, gen, 'l invalidazione porta la generazione del lancio');

  // 2. Il file di generazione porta il SEGNO: e' quello che autorizza il lettore
  //    a non far scadere «ferma», perche' questo supervisore garantisce
  //    l'evento di uscita.
  assert.equal(fs.readFileSync(path.join(dir, 'activity.gen'), 'utf8'), `${gen}\nexit:1`);
});

test('cell-exec: scrive activity.gen con la generazione del payload, PRIMA dello spawn', async (t) => {
  const dir = activityDir(t);
  const gen = 'a'.repeat(16);
  let lettoAlloSpawn = null;
  const child = fakeChild();
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'e'.repeat(64)], {
    receivePayload: async () => payloadCon(dir, gen),
    spawn: () => {
      // L'ordine e' il punto: quando il client parte, la generazione e' GIA' su
      // disco. Un hook che scrive una generazione non ancora pubblicata
      // produrrebbe eventi scartati al primo istante di vita del client.
      // Il file porta la generazione E il segno dell'uscita (questo
      // supervisore garantisce ClientExit): l'ordine e' il punto, il contenuto
      // lo verifica il test qui sotto.
      lettoAlloSpawn = fs.readFileSync(path.join(dir, 'activity.gen'), 'utf8');
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    },
    stderrWrite: () => {},
  });
  assert.equal(code, 1, 'il client non parte (spawn finto): il giro si chiude');
  assert.equal(lettoAlloSpawn.split('\n')[0], gen, 'la generazione era su disco PRIMA dello spawn');
  assert.equal(fs.readFileSync(path.join(dir, 'activity.gen'), 'utf8'), `${gen}\nexit:1`);
});

test("cell-exec: se la scrittura fallisce, log + il client parte lo stesso (stato «non verificato»)", async (t) => {
  const dir = activityDir(t);
  // La directory esiste ma la scrittura non puo' riuscire: `activity.gen` come
  // DIRECTORY. La scrittura atomica (tmp + rename) fallisce.
  fs.mkdirSync(path.join(dir, 'activity.gen'));
  let stderr = '';
  let partito = false;
  const child = fakeChild();
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'f'.repeat(64)], {
    receivePayload: async () => payloadCon(dir, 'b'.repeat(16)),
    spawn: () => { partito = true; queueMicrotask(() => child.emit('exit', 0)); return child; },
    stderrWrite: (s) => { stderr += s; },
  });
  assert.equal(partito, true, 'il client parte lo stesso: una scrittura fallita non blocca la cella');
  assert.match(stderr, /generazione di attivita' non pubblicata/);
  // e lo stato NON e' «ferma»: la generazione non c'e', quindi gli eventi del
  // client verranno scartati al lettore. E' l'esito sicuro, non un silenzio.
  assert.equal(leggiAttivita(path.dirname(dir), path.basename(dir)), null);
});

// Il caso «nessun canale di attivita' nel payload» e' gia' coperto sopra
// (`main: senza canale di attivita' nel payload non si scrive nulla`): non lo
// duplico qui.
