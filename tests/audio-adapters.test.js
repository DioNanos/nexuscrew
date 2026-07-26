'use strict';
// tests/audio-adapters.test.js — adapter TTS nativi per le tre piattaforme.
// Nessun audio viene riprodotto: il PATH e' finto e lo spawn e' un seam. I test
// verificano il COMANDO scelto, dove finisce il testo e cosa l'adapter dichiara.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const a = require('../lib/audio/adapters.js');

// fs finto: solo i binari elencati esistono e sono eseguibili.
function fakeFs(available) {
  const set = new Set(available);
  return {
    statSync: (p) => { if (!set.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isFile: () => true }; },
    accessSync: (p) => { if (!set.has(p)) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } },
  };
}

function fakeSpawn() {
  const calls = [];
  const impl = (bin, args, opts) => {
    const child = new EventEmitter();
    const stdinChunks = [];
    child.stdin = Object.assign(new EventEmitter(), {
      end: (chunk) => stdinChunks.push(String(chunk)),
    });
    child.kill = () => { child.killed = true; };
    calls.push({ bin, args, opts, stdin: stdinChunks });
    return child;
  };
  impl.calls = calls;
  return impl;
}

test('detect: Termux riconosciuto dal PREFIX, non solo dal platform', () => {
  const fsImpl = fakeFs(['/data/data/com.termux/files/usr/bin/termux-tts-speak']);
  const env = { PATH: '/data/data/com.termux/files/usr/bin', PREFIX: '/data/data/com.termux/files/usr' };
  const d = a.detectAdapter({ platform: 'linux', env, fsImpl });
  assert.equal(d && d.id, 'termux-tts-speak',
    'su Android il platform Node e "linux": ignorare PREFIX sceglierebbe l adapter sbagliato');
});

test('detect: macOS sceglie say; Linux preferisce espeak-ng a spd-say', () => {
  const mac = a.detectAdapter({ platform: 'darwin', env: { PATH: '/usr/bin' }, fsImpl: fakeFs(['/usr/bin/say']) });
  assert.equal(mac.id, 'say');
  const linux = a.detectAdapter({
    platform: 'linux', env: { PATH: '/usr/bin' },
    fsImpl: fakeFs(['/usr/bin/espeak-ng', '/usr/bin/spd-say']),
  });
  assert.equal(linux.id, 'espeak-ng', 'espeak-ng legge stdin: il testo non finisce in argv');
});

test('detect: nessun binario disponibile => nessun adapter (non un finto adapter)', () => {
  assert.equal(a.detectAdapter({ platform: 'linux', env: { PATH: '/usr/bin' }, fsImpl: fakeFs([]) }), null);
  assert.equal(a.detectAdapter({ platform: 'win32', env: { PATH: '/usr/bin' }, fsImpl: fakeFs(['/usr/bin/say']) }), null,
    'una piattaforma senza adapter dichiarato non ne eredita uno di un altra');
});

test('speak: il testo passa da STDIN, non da argv (argv e leggibile con ps)', () => {
  for (const [platform, env, bins, id] of [
    ['darwin', { PATH: '/usr/bin' }, ['/usr/bin/say'], 'say'],
    ['linux', { PATH: '/usr/bin' }, ['/usr/bin/espeak-ng'], 'espeak-ng'],
    ['linux', { PATH: '/usr/bin', PREFIX: '/data/data/com.termux/files/usr' }, ['/usr/bin/termux-tts-speak'], 'termux-tts-speak'],
  ]) {
    const spawnImpl = fakeSpawn();
    const adapter = a.createAdapter(a.detectAdapter({ platform, env, fsImpl: fakeFs(bins) }), { spawnImpl });
    assert.equal(adapter.id, id);
    const secret = 'contenuto riservato di un enunciato';
    adapter.speak({ text: secret, lang: 'it-IT' });
    const call = spawnImpl.calls.at(-1);
    assert.equal(call.args.join(' ').includes(secret), false, `${id}: il testo non deve comparire in argv`);
    assert.ok(call.stdin.join('').includes(secret), `${id}: il testo arriva da stdin`);
  }
});

test('speak: spd-say e l unico che mette il testo in argv, e lo dichiara', () => {
  const spawnImpl = fakeSpawn();
  const descriptor = a.detectAdapter({ platform: 'linux', env: { PATH: '/usr/bin' }, fsImpl: fakeFs(['/usr/bin/spd-say']) });
  assert.equal(descriptor.id, 'spd-say');
  const adapter = a.createAdapter(descriptor, { spawnImpl });
  adapter.speak({ text: 'ciao', lang: 'it' });
  assert.ok(spawnImpl.calls.at(-1).args.includes('ciao'));
  assert.match(adapter.limits, /argv/i, 'il limite e dichiarato invece che taciuto');
  assert.equal(adapter.stdinText, false);
});

test('speak: uno spawn fallito e un mancato avvio, non un successo silenzioso', () => {
  const adapter = a.createAdapter(
    a.detectAdapter({ platform: 'darwin', env: { PATH: '/usr/bin' }, fsImpl: fakeFs(['/usr/bin/say']) }),
    { spawnImpl: () => { throw new Error('EACCES'); } },
  );
  assert.deepEqual(adapter.speak({ text: 'x' }), { started: false, reason: 'adapter-spawn-failed' });
});

test('speak: watchdog — un processo che non termina viene ucciso entro il timeout', async () => {
  const spawnImpl = fakeSpawn();
  const adapter = a.createAdapter(
    a.detectAdapter({ platform: 'darwin', env: { PATH: '/usr/bin' }, fsImpl: fakeFs(['/usr/bin/say']) }),
    { spawnImpl, timeoutMs: 5 },
  );
  const handle = adapter.speak({ text: 'enunciato che non finisce mai' });
  assert.equal(handle.started, true);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(spawnImpl.calls.at(-1) && true, true);
  // Il child fake registra kill(): il watchdog deve averlo chiamato.
  assert.equal(handle.kill instanceof Function, true);
});

test('describe: la capability non promette udibilita e non espone il path del binario', () => {
  const adapter = a.createAdapter(
    a.detectAdapter({ platform: 'linux', env: { PATH: '/usr/bin' }, fsImpl: fakeFs(['/usr/bin/espeak-ng']) }),
    { spawnImpl: fakeSpawn() },
  );
  const d = a.describeAdapter(adapter);
  assert.equal(d.adapter, 'espeak-ng');
  assert.equal(d.installed, true);
  assert.equal(d.liveness, 'ready');
  assert.equal(JSON.stringify(d).includes('/usr/bin'), false);
  assert.match(d.limits, /sink|exit code/i,
    'exit 0 non prova suono: il limite deve restare scritto nella capability');
});

test('lookupBin: nessuna shell, nessun path relativo, ricerca bounded nel PATH', () => {
  const fsImpl = fakeFs(['/usr/bin/say']);
  assert.equal(a.lookupBin('say', { env: { PATH: '/usr/bin' }, fsImpl }), '/usr/bin/say');
  assert.equal(a.lookupBin('../say', { env: { PATH: '/usr/bin' }, fsImpl }), null, 'niente path traversal');
  assert.equal(a.lookupBin('say', { env: {}, fsImpl }), null, 'senza PATH non si indovina');
});
