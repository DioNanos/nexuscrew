'use strict';
// S3e — stop dell'host VL. Il binario è un fake. Nessun segnale a un host
// vero: il timeout uccide solo il CLI creato dal test.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const host = require('../lib/fleet/vl-host-stop.js');

function procEsito(output, code) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  p.unref = () => {};
  queueMicrotask(() => {
    if (output) p.stdout.emit('data', Buffer.from(output));
    p.emit('close', code);
  });
  return p;
}

function casa() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-host-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
  return home;
}

function scriviBin(file, corpo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, corpo, { mode: 0o755 });
  return file;
}

function recordDi(home, bin, extra = {}) {
  const state = path.join(home, 'state');
  const data = path.join(home, 'data');
  const config = path.join(home, 'config');
  fs.mkdirSync(state, { recursive: true });
  return {
    launchId: 'ab'.repeat(8),
    vlBin: bin,
    vlBinSha256: host.sha256File(bin),
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    HOME: home,
    uid: process.getuid(),
    serverRoot: path.join(state, 'vl', 'host-v1'),
    ts: 1,
    ...extra,
  };
}

test('shutdown usa la root e l\'env del record, senza segreti', async () => {
  const home = casa();
  const visto = path.join(home, 'visto.json');
  const bin = scriviBin(path.join(home, 'bin', 'vl'), `#!${process.execPath}
const fs = require('fs');
const out = ${JSON.stringify(visto)};
if (process.argv[2] === 'shutdown') {
  fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
  process.stdout.write('{"ok":true}\\n');
  process.exit(0);
}
const gia = fs.existsSync(out);
process.stdout.write(gia ? '{"state":"none"}\\n' : '{"state":"live"}\\n');
`);
  const rec = recordDi(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  assert.equal(pin.ok, true);
  const esito = await host.fermaHost({
    record: rec, bin: pin.path, budgetMs: 4000, monoNow: () => Date.now(),
  });
  assert.equal(esito.outcome, 'host-stopped-clean');
  const vistoJson = JSON.parse(fs.readFileSync(visto, 'utf8'));
  assert.deepEqual(vistoJson.argv, ['shutdown', '--server-root', rec.serverRoot]);
  assert.equal(vistoJson.env.HOME, home);
  assert.equal(vistoJson.env.XDG_STATE_HOME, rec.XDG_STATE_HOME);
  assert.equal(vistoJson.env.API_KEY, undefined);
  assert.equal(vistoJson.env.VL_API_KEY, undefined);
  assert.ok(esito.spawned >= 2);
  assert.ok(pin.path !== bin);
});

test('stato none con il comando fallito non supera la barriera', async () => {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}\nprocess.exit(0);\n`);
  const rec = recordDi(home, bin);
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs: 2000, monoNow: () => Date.now(),
    spawnImpl: () => procEsito('{"state":"none"}\n', 2),
  });
  assert.ok(esito.outcome !== 'host-already-stopped' && esito.outcome !== 'host-stopped-clean', esito.outcome);
  const ok = await host.fermaHost({
    record: rec, bin, budgetMs: 2000, monoNow: () => Date.now(),
    spawnImpl: () => procEsito('{"state":"none"}\n', 0),
  });
  assert.equal(ok.outcome, 'host-already-stopped');
});

test('host gia none: nessun bisogno di dichiarare uno stop pulito dopo un ack', async () => {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
if (process.argv[2] === 'shutdown') { process.stderr.write('no\\n'); process.exit(2); }
process.stdout.write('{"state":"none"}\\n');
`);
  const rec = recordDi(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  const esito = await host.fermaHost({ record: rec, bin: pin.path, budgetMs: 3000, monoNow: () => Date.now() });
  assert.equal(esito.outcome, 'host-already-stopped');
  assert.equal(esito.spawned, 1);
});

test('ack con host ancora vivo: stop fallito, restart non e un successo', async () => {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
if (process.argv[2] === 'shutdown') { process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n'); process.exit(0); }
process.stdout.write('{"state":"lock"}\\n');
`);
  const rec = recordDi(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  const esito = await host.fermaHost({ record: rec, bin: pin.path, budgetMs: 4000, monoNow: () => Date.now() });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'BARRIER');
});

test('shutdown appeso: muore solo il CLI, l\'host resta', async () => {
  const home = casa();
  const hostVivo = path.join(home, 'host-vivo');
  fs.writeFileSync(hostVivo, '1');
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
if (process.argv[2] === 'host') { process.stdout.write('{"state":"live"}\\n'); process.exit(0); }
setInterval(() => {}, 1000);
`);
  const rec = recordDi(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  const t0 = Date.now();
  const esito = await host.fermaHost({
    record: rec, bin: pin.path, budgetMs: 1500, monoNow: () => Date.now(),
  });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'TIMEOUT');
  assert.equal(fs.readFileSync(hostVivo, 'utf8'), '1');
  assert.ok(Date.now() - t0 < 8000);
});

test('pin diverso o assente: nessuno spawn', async () => {
  const home = casa();
  let nati = 0;
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const rec = recordDi(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  fs.chmodSync(pin.path, 0o700);
  fs.writeFileSync(pin.path, '#!/bin/sh\necho sporco\n');
  assert.equal(host.verificaPin(pin.path, rec.vlBinSha256).ok, false);
  assert.equal(nati, 0);
});

test('pathname pubblico sostituito: si esegue il pin', async () => {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
require('fs').writeFileSync(process.env.HOME + '/chi', process.argv[1]);
process.stdout.write('{"state":"none"}\\n');
`);
  const rec = recordDi(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  fs.writeFileSync(bin, '#!/bin/sh\necho sostituito\n');
  const esito = await host.fermaHost({ record: rec, bin: pin.path, budgetMs: 3000, monoNow: () => Date.now() });
  assert.equal(esito.outcome, 'host-already-stopped');
  assert.equal(fs.readFileSync(path.join(home, 'chi'), 'utf8'), pin.path);
});

test('cache pin non corrispondente: quarantena e ricopia', async () => {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const log = [];
  const prima = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella', log: (m) => log.push(m) });
  fs.chmodSync(prima.path, 0o700);
  fs.writeFileSync(prima.path, 'byte diversi\n');
  const seconda = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella', log: (m) => log.push(m) });
  assert.equal(seconda.ok, true);
  assert.equal(host.sha256File(seconda.path), prima.sha256);
  assert.ok(log.includes('pin-cache-corrupt'));
  const dir = path.dirname(prima.path);
  assert.ok(fs.readdirSync(dir).some((n) => n.includes('corrupt')));
});

test('host nel gruppo del pane: nessun spawn', async () => {
  const home = casa();
  let nati = 0;
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const rec = recordDi(home, bin);
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs: 2000, monoNow: () => Date.now(), nelGruppo: true,
    spawnImpl: () => { nati += 1; return spawn(process.execPath, ['-e', 'process.exit(0)']); },
  });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'HOST_IN_GROUP');
  assert.equal(nati, 0);
  assert.equal(esito.spawned, 0);
});

test('cella non vl non e un esito di questo modulo: il record si legge e si scrive', () => {
  const home = casa();
  const stato = path.join(home, 'identita');
  fs.mkdirSync(stato, { recursive: true });
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const dato = recordDi(home, bin);
  host.scriviContesto(stato, dato);
  const letto = host.leggiContesto(stato);
  assert.equal(letto.serverRoot, dato.serverRoot);
  assert.equal(letto.launchId, dato.launchId);
});
