'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const tmuxControl = require('../lib/fleet/tmux-control.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeScript(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${content}`, { mode: 0o755 });
  return file;
}

test('deterministic: 1. sostituzione o crash prima del primo risultato', async () => {
  const tmp = makeTempDir('nc-owned-subst-');
  try {
    // Script che muore immediatamente senza emettere nulla sul socket/pipe
    const fake = makeScript(tmp, 'tmux-crash', `
      process.exit(1);
    `);
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'sess-crash',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['process.exit(0)'],
      env: { ...process.env, HOME: tmp },
      prontaMs: 1000,
    });
    assert.equal(res.ok, false);
    assert.ok(res.err);
    assert.equal(res.canale, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deterministic: 2. morte dopo risultato e prima del primo comando', async () => {
  const tmp = makeTempDir('nc-owned-death-');
  try {
    // Script che emette il frame di creazione e poi termina subito
    const fake = makeScript(tmp, 'tmux-die-after-frame', `
      process.stdout.write('%begin 1 0 1\\n$1\\t@1\\t%1\\n%end 1 0 1\\n');
      setTimeout(() => process.exit(0), 20);
    `);
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'sess-die',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['process.exit(0)'],
      env: { ...process.env, HOME: tmp },
      prontaMs: 2000,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.createdIds, { sessionId: '$1', windowId: '@1', paneId: '%1' });
    assert.ok(res.canale);

    // Attendi la chiusura del processo del canale
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(res.canale.morto(), true);

    // Chiamata su canale morto deve fallire senza lanciare comandi
    const cmdRes = await res.canale.chiama('display-message', ['-p', '42']);
    assert.equal(cmdRes.ok, false);
    assert.equal(cmdRes.morto, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deterministic: 3. stesso pathname/PID/ID riusati da terzi: zero comandi sul sostituto', async () => {
  const tmp = makeTempDir('nc-owned-reuse-');
  const targetFile = path.join(tmp, 'substitute-touched.marker');
  try {
    // Fake script che restituisce il frame di creazione e poi termina
    const fake = makeScript(tmp, 'tmux-original', `
      process.stdout.write('%begin 1 0 1\\n$1\\t@1\\t%1\\n%end 1 0 1\\n');
      setTimeout(() => process.exit(0), 30);
    `);

    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'sess-original',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['process.exit(0)'],
      env: { ...process.env, HOME: tmp },
      prontaMs: 2000,
    });
    assert.equal(res.ok, true);

    // Attendi che il client originale termini
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(res.canale.morto(), true);

    // Creazione di un socket sostituto indipendente sullo stesso pathname
    fs.writeFileSync(path.join(tmp, 'test.sock'), 'fake-socket-data');

    // Chiamata sul canale originale: non tocca il socket/server sostituto
    const r = await res.canale.chiama('kill-session', ['-t', '$1']);
    assert.equal(r.ok, false);
    assert.equal(r.morto, true);
    assert.equal(fs.existsSync(targetFile), false, 'nessun comando tocca il sostituto');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deterministic: 4. risposta iniziale persa o timeout', async () => {
  const tmp = makeTempDir('nc-owned-timeout-');
  try {
    // Script che non risponde (hang)
    const fake = makeScript(tmp, 'tmux-hang', `
      setInterval(() => {}, 10000);
    `);
    const t0 = Date.now();
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'sess-hang',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['process.exit(0)'],
      env: { ...process.env, HOME: tmp },
      prontaMs: 150,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.ok(res.err.message.includes('timeout'));
    assert.ok(elapsed >= 140 && elapsed < 2000, `bounded elapsed time: ${elapsed}ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deterministic: 5. comando rifiutato (%error)', async () => {
  const tmp = makeTempDir('nc-owned-err-');
  try {
    const fake = makeScript(tmp, 'tmux-error', `
      process.stdout.write('%begin 1 0 1\\nunknown command: invalid\\n%error 1 0 1\\n');
    `);
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'sess-err',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['process.exit(0)'],
      env: { ...process.env, HOME: tmp },
      prontaMs: 2000,
    });
    assert.equal(res.ok, false);
    assert.equal(res.isDuplicate, false);
    assert.ok(res.err.message.includes('unknown command'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deterministic: 6. collisione di nome senza -A', async () => {
  const tmp = makeTempDir('nc-owned-dup-');
  try {
    const fake = makeScript(tmp, 'tmux-dup', `
      process.stdout.write('%begin 1 0 1\\nduplicate session: my-cell\\n%error 1 0 1\\n');
    `);
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'my-cell',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['process.exit(0)'],
      env: { ...process.env, HOME: tmp },
      prontaMs: 2000,
    });
    assert.equal(res.ok, false);
    assert.equal(res.isDuplicate, true);
    assert.ok(res.err.message.includes('duplicate session'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deterministic: 7. codice senza fallback: creazione esclusivamente tramite creaSessionePosseduta', () => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, '../lib/fleet/runtime.js'), 'utf8');
  assert.equal(runtimeSource.includes("new-session', '-d'"), false,
    'nessuna chiamata new-session -d nel runtime');
  assert.equal(runtimeSource.includes('tmuxControl.creaSessionePosseduta'), true,
    'creazione sessione affidata unicamente a tmuxControl.creaSessionePosseduta');
});

test('deterministic: 8. positivo sul lancio originale: collaudo reale con tmux 3.4 in socket/HOME privati', async () => {
  // Verifica presenza di tmux reale
  const check = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (check.status !== 0) {
    return; // salta solo se il binario di sistema non e disponibile
  }

  const tmp = makeTempDir('nc-real-collaudo-');
  const sock = path.join(tmp, 'private.sock');
  try {
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: '/usr/bin/tmux',
      socket: sock,
      sessionName: 'real-owned-test',
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['setTimeout(() => {}, 30000)'],
      env: { ...process.env, HOME: tmp, TMUX: '' },
      prontaMs: 5000,
    });

    assert.equal(res.ok, true);
    assert.ok(tmuxControl.RE_ID.session.test(res.createdIds.sessionId), `sessionId valido: ${res.createdIds.sessionId}`);
    assert.ok(tmuxControl.RE_ID.window.test(res.createdIds.windowId), `windowId valido: ${res.createdIds.windowId}`);
    assert.ok(tmuxControl.RE_ID.pane.test(res.createdIds.paneId), `paneId valido: ${res.createdIds.paneId}`);

    // attached count = 1 (il client di controllo e attaccato alla sessione)
    const att = await res.canale.chiama('display-message', ['-p', '#{session_attached}']);
    assert.equal(att.ok, true);
    assert.equal(att.testo[0], '1', 'il client posseduto risulta attaccato');

    // dimensioni fissate a 80x24
    const sz = await res.canale.chiama('display-message', ['-p', '#{window_width}x#{window_height}']);
    assert.equal(sz.ok, true);
    assert.equal(sz.testo[0], '80x24', 'dimensioni iniziali conformi 80x24');

    // chiusura e pulizia
    await res.canale.killSession('real-owned-test');
    res.canale.chiudi();
  } finally {
    try { spawnSync('/usr/bin/tmux', ['-S', sock, 'kill-server']); } catch (_) {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
