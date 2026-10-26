'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { apri } = require('../lib/fleet/tmux-control.js');

function scrivi(dir, nome, corpo) {
  const file = path.join(dir, nome);
  fs.writeFileSync(file, corpo, { mode: 0o755 });
  return file;
}

test('un errore di handshake non apre il canale e l argv non crea una sessione', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tmux-hs-'));
  const log = path.join(dir, 'argv.txt');
  const errore = scrivi(dir, 'err.js', `#!${process.execPath}
fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\0'));
process.stdout.write('%begin 1 1 1\\nunknown command\\n%error 1 1 1\\n');
setInterval(() => {}, 1000);
`);
  const chiuso = await apri({
    tmuxBin: errore, socket: '/tmp/nc-synthetic-socket', sessionId: '$5', prontaMs: 800,
  });
  assert.equal(chiuso, null);
  const argv = fs.readFileSync(log, 'utf8').split('\0');
  assert.ok(argv.includes('attach-session'), argv.join(' '));
  assert.ok(argv.includes('$5'), argv.join(' '));
  assert.ok(!argv.includes('new-session'), argv.join(' '));

  const okBin = scrivi(dir, 'ok.js', `#!${process.execPath}
process.stdout.write('%begin 1 0 1\\n%end 1 0 1\\n%begin 1 1 1\\nnc-control-open\\n%end 1 1 1\\n');
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
`);
  const aperto = await apri({
    tmuxBin: okBin, socket: '/tmp/nc-synthetic-socket', sessionId: '$5', prontaMs: 800,
  });
  assert.ok(aperto);
  aperto.chiudi();
});
