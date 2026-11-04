'use strict';
// Assenza della root host reale: host-v1 non si crea. Uno spazio della
// catena che non e' una directory dell'utente, un link o un errore di
// lettura rifiutano. L'impronta cambia se la root compare dopo.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { qualificaAssenzaRadice, stessaImprontaRadice } = require('../lib/fleet/vl-roots.js');
const { verificaCapacitaPeerStop, preparaSondaRadice, pulisciSondaRadice } = require('../lib/fleet/vl-host-stop.js');

function spawnFinto(stdout, code) {
  const visti = [];
  const spawnImpl = (bin, args) => {
    visti.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, visti };
}

const STATO_OK = `${JSON.stringify({
  state: 'none',
  peer_identity_support: 'supported',
  capabilities: ['host_peer_identity_v1', 'host_stop_expected_v1'],
})}\n`;

function mondo() {
  const base = fs.mkdtempSync(path.join('/tmp', 'nc-s6h-abs-'));
  const cella = path.join(base, 'cella');
  fs.mkdirSync(path.join(cella, 'state'), { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  fs.chmodSync(cella, 0o700);
  fs.chmodSync(path.join(cella, 'state'), 0o700);
  return { base, cella, root: path.join(cella, 'state', 'vl', 'host-v1') };
}

test('assenza: host-v1 non si crea e vl nasce 0700', () => {
  const w = mondo();
  try {
    const q = qualificaAssenzaRadice(w.root, w.cella);
    assert.equal(q.esito, 'assente');
    assert.equal(fs.existsSync(w.root), false);
    const st = fs.lstatSync(path.join(w.cella, 'state', 'vl'));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isDirectory(), true);
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal(stessaImprontaRadice(q, qualificaAssenzaRadice(w.root, w.cella)), true);
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('assenza: una root gia presente resta presente', () => {
  const w = mondo();
  try {
    fs.mkdirSync(path.join(w.cella, 'state', 'vl'), { mode: 0o700 });
    fs.mkdirSync(w.root, { mode: 0o700 });
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).esito, 'presente');
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('assenza: link, file e EACCES rifiutano e non riparano', () => {
  const w = mondo();
  try {
    fs.mkdirSync(path.join(w.cella, 'state', 'vl'), { mode: 0o700 });
    fs.symlinkSync('altrove', w.root);
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).code, 'link');
    assert.equal(fs.lstatSync(w.root).isSymbolicLink(), true);
    fs.unlinkSync(w.root);
    fs.writeFileSync(w.root, 'x');
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).code, 'ENOTDIR');
    const e = new Error('no');
    e.code = 'EACCES';
    const via = qualificaAssenzaRadice(w.root, w.cella, { lstat: () => { throw e; } });
    assert.equal(via.esito, 'rifiutata');
    assert.equal(via.code, 'EACCES');
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('assenza: la comparsa della root rompe l impronta', () => {
  const w = mondo();
  try {
    const prima = qualificaAssenzaRadice(w.root, w.cella);
    fs.mkdirSync(w.root, { mode: 0o700 });
    const dopo = qualificaAssenzaRadice(w.root, w.cella);
    assert.equal(prima.esito, 'assente');
    assert.equal(dopo.esito, 'presente');
    assert.equal(stessaImprontaRadice(prima, dopo), false);
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('sonda: root assente usa una directory usa e getta e la ripulisce', async () => {
  const sonda = preparaSondaRadice();
  assert.equal(sonda.ok, true);
  assert.equal(sonda.dir.includes('host-v1'), false);
  const { spawnImpl, visti } = spawnFinto(STATO_OK, 0);
  const cap = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: { PATH: '/usr/bin:/bin' }, root: sonda.dir, spawnImpl,
  });
  assert.equal(cap.ok, true);
  assert.deepEqual(visti[0].args, ['host', 'status', '--json', '--server-root', sonda.dir]);
  assert.equal(pulisciSondaRadice(sonda), true);
  assert.equal(fs.existsSync(sonda.dir), false);
});
