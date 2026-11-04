'use strict';
// Rifiuto PROVATO della creazione: solo un frame %error completo che e'
// esattamente «duplicate session: <nome richiesto>» vale come prova che il
// nostro new-session non ha creato niente. Tutto il resto (testo fuori dal
// frame, frame troncato o piu' lungo, altra sessione, rifiuto generico, EOF,
// timeout, id malformati) resta una materializzazione ignota: nessuna prova.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tmuxControl = require('../lib/fleet/tmux-control.js');

const NOME = 'cloud-Cella';

function crea(corpo, { esci = false, prontaMs = 1500 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rifiuto-'));
  const fake = path.join(tmp, 'tmux');
  fs.writeFileSync(fake, `#!/usr/bin/env node\n${corpo}\n${esci ? '' : 'process.stdin.resume(); setInterval(() => {}, 10000);'}`, { mode: 0o755 });
  return tmuxControl.creaSessionePosseduta({
    tmuxBin: fake, socket: path.join(tmp, 's.sock'), sessionName: NOME, cwd: tmp,
    nodeBin: process.execPath, cellHoldPath: '-e', cellHoldArgs: ['0'],
    env: { ...process.env, HOME: tmp }, prontaMs,
  }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

const w = (s) => `process.stdout.write(${JSON.stringify(s)});`;

test('frame %error completo «duplicate session: <nome>»: rifiuto provato', async () => {
  const r = await crea(w(`%begin 1 0 1\nduplicate session: ${NOME}\n%error 1 0 1\n`));
  assert.equal(r.ok, false);
  assert.equal(r.isDuplicate, true);
  assert.equal(r.rifiutoProvato, 'duplicate-session');
});

test('lo stesso frame con il client che esce subito resta provato (nessuna corsa exit/dati)', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await crea(w(`%begin 1 0 1\nduplicate session: ${NOME}\n%error 1 0 1\n`), { esci: true });
    assert.equal(r.rifiutoProvato, 'duplicate-session', `giro ${i}`);
  }
});

const NON_PROVATI = [
  ['«duplicate» solo fuori dal frame', w(`%message duplicate session: ${NOME}\n`)],
  ['frame troncato (EOF prima del %error)', w(`%begin 1 0 1\nduplicate session: ${NOME}\n`)],
  ['nome di un\'altra sessione', w('%begin 1 0 1\nduplicate session: altra\n%error 1 0 1\n')],
  ['testo in piu\' nel frame', w(`%begin 1 0 1\nduplicate session: ${NOME}\nsecond\n%error 1 0 1\n`)],
  ['prefisso nel nome', w(`%begin 1 0 1\nduplicate session: ${NOME}-2\n%error 1 0 1\n`)],
  ['maiuscole diverse', w(`%begin 1 0 1\nDuplicate Session: ${NOME}\n%error 1 0 1\n`)],
  ['rifiuto generico', w('%begin 1 0 1\ncan\'t create session\n%error 1 0 1\n')],
  ['%end con lo stesso testo (non e\' un rifiuto)', w(`%begin 1 0 1\nduplicate session: ${NOME}\n%end 1 0 1\n`)],
  ['%error con t,n diversi (frame non chiuso)', w(`%begin 1 0 1\nduplicate session: ${NOME}\n%error 9 9 1\n`)],
  ['EOF senza niente', 'process.exit(0);'],
  ['id malformati', w('%begin 1 0 1\n$x @y %z\n%end 1 0 1\n')],
];

for (const [nome, corpo] of NON_PROVATI) {
  test(`non provato: ${nome}`, async () => {
    const r = await crea(corpo, { prontaMs: 800 });
    assert.equal(r.ok, false);
    assert.ok(!r.rifiutoProvato, 'nessuna prova di rifiuto');
    assert.ok(!r.isDuplicate, 'non e\' un duplicato dimostrato');
  });
}

test('timeout senza frame: non provato', async () => {
  const r = await crea('', { prontaMs: 300 });
  assert.equal(r.ok, false);
  assert.ok(!r.rifiutoProvato);
});
