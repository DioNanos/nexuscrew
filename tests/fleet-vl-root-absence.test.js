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
  assert.notEqual(path.dirname(sonda.dir), '/tmp');
  assert.equal(fs.lstatSync(path.dirname(sonda.dir)).mode & 0o777, 0o700);
  const { spawnImpl, visti } = spawnFinto(STATO_OK, 0);
  const cap = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: { PATH: '/usr/bin:/bin' }, root: sonda.dir, spawnImpl,
  });
  assert.equal(cap.ok, true);
  assert.deepEqual(visti[0].args, ['host', 'status', '--json', '--server-root', sonda.dir]);
  assert.equal(pulisciSondaRadice(sonda), true);
  assert.equal(fs.existsSync(sonda.dir), false);
});

test('assenza: prefisso file, link intermedio, dangling, modo e uid', () => {
  const w = mondo();
  try {
    const stato = path.join(w.cella, 'state');
    fs.rmSync(stato, { recursive: true, force: true });
    fs.writeFileSync(stato, 'x');
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).code, 'ENOTDIR');
    assert.equal(fs.existsSync(path.join(w.cella, 'state', 'vl')), false);
    fs.unlinkSync(stato);
    fs.mkdirSync(stato, { mode: 0o700 });
    const alt = path.join(w.base, 'alt');
    fs.mkdirSync(alt, { mode: 0o700 });
    const vl = path.join(stato, 'vl');
    fs.symlinkSync(alt, vl);
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).code, 'link');
    assert.equal(fs.lstatSync(vl).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(alt, 'host-v1')), false);
    fs.unlinkSync(vl);
    fs.mkdirSync(vl, { mode: 0o700 });
    fs.symlinkSync('/tmp/inesistente-nc-s6h', w.root);
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).code, 'link');
    fs.unlinkSync(w.root);
    fs.chmodSync(vl, 0o755);
    assert.equal(qualificaAssenzaRadice(w.root, w.cella).code, 'permessi');
    fs.chmodSync(vl, 0o700);
    const reale = fs.lstatSync;
    const estraneo = qualificaAssenzaRadice(w.root, w.cella, {
      lstat: (p) => {
        const st = reale(p);
        if (p !== vl) return st;
        return {
          isSymbolicLink: () => st.isSymbolicLink(),
          isDirectory: () => st.isDirectory(),
          uid: st.uid + 1,
          gid: st.gid,
          mode: st.mode,
          dev: st.dev,
          ino: st.ino,
        };
      },
    });
    assert.equal(estraneo.code, 'permessi');
    assert.equal((reale(vl).mode & 0o777), 0o700);
    const prima = qualificaAssenzaRadice(w.root, w.cella);
    fs.renameSync(vl, path.join(w.base, 'vl-vecchia'));
    fs.mkdirSync(vl, { mode: 0o700 });
    const dopo = qualificaAssenzaRadice(w.root, w.cella);
    assert.equal(prima.esito, 'assente');
    assert.equal(stessaImprontaRadice(prima, dopo), false);
    for (const code of ['EIO', 'ENOTDIR', 'ELOOP']) {
      const e = new Error(code);
      e.code = code;
      const q = qualificaAssenzaRadice(w.root, w.cella, { lstat: () => { throw e; } });
      assert.equal(q.esito, 'rifiutata', code);
      assert.equal(q.code, code);
    }
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('assenza: due celle distinte non si toccano', () => {
  const a = mondo();
  const b = mondo();
  try {
    const qa = qualificaAssenzaRadice(a.root, a.cella);
    const qb = qualificaAssenzaRadice(b.root, b.cella);
    assert.equal(qa.esito, 'assente');
    assert.equal(qb.esito, 'assente');
    assert.equal(fs.existsSync(a.root), false);
    assert.equal(fs.existsSync(b.root), false);
    assert.notEqual(a.root, b.root);
  } finally {
    fs.rmSync(a.base, { recursive: true, force: true });
    fs.rmSync(b.base, { recursive: true, force: true });
  }
});

test('sonda: rc 1 con JSON plausibile non e una capacita', async () => {
  const { spawnImpl } = spawnFinto(STATO_OK, 1);
  const cap = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/nc-s6h-non-usata', spawnImpl,
  });
  assert.equal(cap.ok, false);
  assert.equal(cap.motivo, 'probe');
});

test('sonda: temp non creabile, pulizia fallita, spawn, timeout, JSON e capacita', async () => {
  const manca = preparaSondaRadice({ mkdtemp: () => { const e = new Error('no'); e.code = 'ENOSPC'; throw e; } });
  assert.equal(manca.ok, false);
  const insicura = preparaSondaRadice({
    mkdtemp: () => '/tmp/nc-s6h-finta',
    lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 0, mode: 0o40755, dev: 1, ino: 1 }),
  });
  assert.equal(insicura.ok, false);
  assert.equal(insicura.code, 'insicura');
  const vera = preparaSondaRadice();
  assert.equal(vera.ok, true);
  fs.rmSync(vera.dir, { recursive: true });
  fs.symlinkSync('/tmp', vera.dir);
  assert.equal(pulisciSondaRadice(vera), false);
  assert.equal(fs.existsSync(vera.base), true);
  fs.unlinkSync(vera.dir);
  fs.rmdirSync(vera.base);
  const rotto = spawnFinto('non-json\n', 0);
  const capRotto = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/x', spawnImpl: rotto.spawnImpl,
  });
  assert.equal(capRotto.motivo, 'probe');
  const senza = spawnFinto(`${JSON.stringify({ state: 'none', peer_identity_support: 'no', capabilities: [] })}\n`, 0);
  const capSenza = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/x', spawnImpl: senza.spawnImpl,
  });
  assert.equal(capSenza.motivo, 'support');
  const boom = () => { throw new Error('spawn'); };
  const capBoom = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/x', spawnImpl: boom,
  });
  assert.equal(capBoom.motivo, 'probe');
  const appeso = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', null);
    return child;
  };
  const capTempo = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/x', budgetMs: 50, spawnImpl: appeso,
  });
  assert.equal(capTempo.motivo, 'probe');
  assert.equal(capTempo.probe.ucciso, true);
  const grosso = spawnFinto(`${'x'.repeat(65537)}\n`, 0);
  const capTaglio = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/x', spawnImpl: grosso.spawnImpl,
  });
  assert.equal(capTaglio.motivo, 'probe');
  assert.equal(capTaglio.probe.troncato, true);
  const parziale = spawnFinto(`${JSON.stringify({
    state: 'none', peer_identity_support: 'supported', capabilities: ['host_peer_identity_v1'],
  })}\n`, 0);
  const capParziale = await verificaCapacitaPeerStop({
    bin: '/usr/bin/vl', env: {}, root: '/tmp/x', spawnImpl: parziale.spawnImpl,
  });
  assert.equal(capParziale.motivo, 'capacita');
  const viva = preparaSondaRadice();
  assert.equal(pulisciSondaRadice(viva, { rm: () => { throw new Error('no'); } }), false);
  assert.equal(fs.existsSync(viva.dir), true);
  assert.equal(pulisciSondaRadice(viva), true);
  assert.equal(fs.existsSync(viva.dir), false);
});
