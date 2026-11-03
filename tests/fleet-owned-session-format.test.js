'use strict';

// S6e: -F uses one ASCII space. The parser is unchanged. The existing real
// collaudo in fleet-owned-session-creation.test.js is not modified here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const tmuxControl = require('../lib/fleet/tmux-control.js');
const { verificaUscitaServer } = require(path.join(__dirname, 'tmux-server-exit-guard.js'));

const FORMAT = '#{session_id} #{window_id} #{pane_id}';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeScript(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${content}`, { mode: 0o755 });
  return file;
}

async function creaConFrame(tmp, scriptBody, { prontaMs = 400, sessionName = 'sess-fmt' } = {}) {
  const fake = makeScript(tmp, 'tmux-frame', scriptBody);
  return tmuxControl.creaSessionePosseduta({
    tmuxBin: fake,
    socket: path.join(tmp, 'test.sock'),
    sessionName,
    cwd: tmp,
    env: { PATH: '/usr/bin:/bin', HOME: tmp },
    prontaMs,
  });
}

function scriptFrame(testo, chiusura) {
  const frame = `%begin 1 0 1\n${testo}\n${chiusura} 1 0 1\n`;
  return `process.stdout.write(${JSON.stringify(frame)});`;
}

function assertRifiutato(res) {
  assert.equal(res.ok, false);
  assert.equal(res.createdIds, undefined);
}

test('il fake osserva -F con uno spazio ASCII e la stessa connessione accetta i tre id', async () => {
  const tmp = makeTempDir('nc-s6e-fake-');
  const callsFile = path.join(tmp, 'calls.jsonl');
  try {
    const fake = makeScript(tmp, 'tmux-see-format', `
      const fs = require('fs');
      fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
      let n = 0;
      process.stdout.write('%begin 1 0 1\\n$4 @4 %4\\n%end 1 0 1\\n');
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const riga = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!riga) continue;
          n += 1;
          process.stdout.write('%begin 1 ' + n + ' 1\\n' + process.pid + '\\n%end 1 ' + n + ' 1\\n');
        }
      });
    `);
    const res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: fake,
      socket: path.join(tmp, 'test.sock'),
      sessionName: 'sess-space',
      cwd: tmp,
      env: { PATH: '/usr/bin:/bin', HOME: tmp, TMUX: '/tmp/trap.sock,1,0', LANG: 'C.UTF-8' },
      prontaMs: 2000,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.createdIds, { sessionId: '$4', windowId: '@4', paneId: '%4' });
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    const fmtAt = calls[0].indexOf('-F');
    assert.ok(fmtAt >= 0);
    assert.equal(calls[0][fmtAt + 1], FORMAT);
    assert.equal(calls[0][fmtAt + 1].includes('\t'), false);
    const seguito = await res.canale.chiama('display-message', ['-p', 'same'], 2000);
    assert.equal(seguito.ok, true);
    assert.equal(Number(seguito.testo[0]), res.canale.proc.pid);
    res.canale.ferma();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('negativi del formato: underscore, campi, permutazioni, testo extra, %error, EOF e timeout', async () => {
  const casi = [
    ['underscore', scriptFrame('$0_@0_%0', '%end')],
    ['zero-id', scriptFrame('x', '%end')],
    ['due-campi', scriptFrame('$1 @1', '%end')],
    ['quattro-campi', scriptFrame('$1 @1 %1 extra', '%end')],
    ['prefisso-mancante', scriptFrame('1 @1 %1', '%end')],
    ['id-non-numerico', scriptFrame('$x @1 %1', '%end')],
    ['permutati-window', scriptFrame('@1 $1 %1', '%end')],
    ['permutati-pane', scriptFrame('%1 @1 $1', '%end')],
    ['riga-extra', scriptFrame('$1 @1 %1\nEXTRA', '%end')],
    ['token-legacy', scriptFrame('nc-control-open', '%end')],
    ['error-con-id', scriptFrame('$1 @1 %1', '%error')],
  ];
  for (const [nome, body] of casi) {
    const tmp = makeTempDir(`nc-s6e-${nome}-`);
    try {
      const res = await creaConFrame(tmp, body, { sessionName: `s-${nome}` });
      assert.equal(res.ok, false, nome);
      assert.equal(res.createdIds, undefined, nome);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const eofDir = makeTempDir('nc-s6e-eof-');
  try {
    const eof = await creaConFrame(eofDir, 'process.exit(0);', { sessionName: 's-eof' });
    assertRifiutato(eof);
  } finally {
    fs.rmSync(eofDir, { recursive: true, force: true });
  }

  const hangDir = makeTempDir('nc-s6e-hang-');
  try {
    const hang = await creaConFrame(hangDir, 'setInterval(() => {}, 10000);', {
      sessionName: 's-hang', prontaMs: 150,
    });
    assertRifiutato(hang);
    assert.match(hang.err.message, /timeout/);
  } finally {
    fs.rmSync(hangDir, { recursive: true, force: true });
  }
});

function scriviWrapper(tmp) {
  const envLog = path.join(tmp, 'client-env');
  const wrapper = path.join(tmp, 'tmux-wrap');
  fs.writeFileSync(wrapper, `#!/bin/sh
env > ${JSON.stringify(envLog).slice(1, -1)}
exec /usr/bin/tmux "$@"
`, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return { wrapper, envLog };
}

function chiaviEnv(envLog) {
  const keys = new Set();
  for (const line of fs.readFileSync(envLog, 'utf8').split('\n')) {
    if (!line) continue;
    keys.add(line.split('=')[0]);
  }
  return keys;
}

async function collaudoReale(nome, envExtra) {
  const check = spawnSync('/usr/bin/tmux', ['-V'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(check.status, 0, 'tmux 3.4 richiesto');
  assert.match(check.stdout, /tmux 3\./);
  const tmp = makeTempDir(`nc-s6e-${nome}-`);
  const sock = path.join(tmp, 'private.sock');
  const { wrapper, envLog } = scriviWrapper(tmp);
  let serverPid = null;
  let res = null;
  try {
    const env = { PATH: '/usr/bin:/bin', HOME: tmp, ...envExtra };
    res = await tmuxControl.creaSessionePosseduta({
      tmuxBin: wrapper,
      socket: sock,
      sessionName: `s6e-${nome}`,
      cwd: tmp,
      nodeBin: process.execPath,
      cellHoldPath: '-e',
      cellHoldArgs: ['setTimeout(() => {}, 30000)'],
      env,
      prontaMs: 5000,
    });
    assert.equal(res.ok, true, res.err && res.err.message);
    assert.ok(tmuxControl.RE_ID.session.test(res.createdIds.sessionId));
    assert.ok(tmuxControl.RE_ID.window.test(res.createdIds.windowId));
    assert.ok(tmuxControl.RE_ID.pane.test(res.createdIds.paneId));
    const stesso = await res.canale.chiama('display-message', ['-p', '#{session_id}']);
    assert.equal(stesso.ok, true);
    assert.equal(stesso.testo[0], res.createdIds.sessionId);
    const att = await res.canale.chiama('display-message', ['-p', '#{session_attached}']);
    assert.equal(att.ok, true);
    assert.equal(att.testo[0], '1');
    const keys = chiaviEnv(envLog);
    assert.equal(keys.has('TMUX'), false);
    assert.equal(keys.has('LANG'), false);
    assert.equal(keys.has('LANGUAGE'), false);
    for (const key of keys) {
      if (key === 'LC_ALL' && envExtra && envExtra.LC_ALL) continue;
      assert.equal(key.startsWith('LC_'), false, key);
    }
    if (envExtra && envExtra.LC_ALL) assert.equal(keys.has('LC_ALL'), true);
    const pidMsg = await res.canale.chiama('display-message', ['-p', '#{pid}']);
    if (pidMsg.ok && pidMsg.testo && /^\d+$/.test(pidMsg.testo[0])) {
      serverPid = Number(pidMsg.testo[0]);
    }
    await res.canale.killSession(res.createdIds.sessionId);
    res.canale.chiudi();
  } finally {
    if (res && res.canale) { try { res.canale.ferma(); } catch (_) {} }
    try { spawnSync('/usr/bin/tmux', ['-S', sock, 'kill-server'], { timeout: 5000 }); } catch (_) {}
    if (serverPid && serverPid !== 6083) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(serverPid, 0); } catch (e) {
          if (e && e.code === 'ESRCH') break;
        }
        spawnSync('sleep', ['0.05']);
      }
      try { process.kill(serverPid, 'SIGKILL'); } catch (_) {}
      verificaUscitaServer(spawnSync, serverPid);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('tmux 3.4 senza TMUX e senza LANG/LANGUAGE/LC_* restituisce tre id sulla stessa connessione', async () => {
  await collaudoReale('bare', {});
});

test('tmux 3.4 con solo LC_ALL=C, senza mutare env globale, restituisce tre id', async () => {
  const prima = {
    LANG: process.env.LANG,
    LANGUAGE: process.env.LANGUAGE,
    LC_ALL: process.env.LC_ALL,
  };
  await collaudoReale('posix', { LC_ALL: 'C' });
  assert.equal(process.env.LANG, prima.LANG);
  assert.equal(process.env.LANGUAGE, prima.LANGUAGE);
  assert.equal(process.env.LC_ALL, prima.LC_ALL);
});
