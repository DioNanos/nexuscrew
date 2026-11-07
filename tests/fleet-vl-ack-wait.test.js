'use strict';
// Attesa osservativa dopo un solo shutdown_ack interno attestato.
// Clock e pausa sono seam: niente sonno reale, niente host vero, niente
// secondo stop. Una sonda guasta e' barriera subito.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const host = require('../lib/fleet/vl-host-stop.js');

const CAP = 'host_stop_v1';
const PARTENZA = 1000;

function casa() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ackwait-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
  return home;
}

function scriviBin(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

function identitaBase() {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: 'ab'.repeat(16),
    pid: 4242,
    uid: 1000,
    bootId: '11111111-2222-3333-4444-555555555555',
    pidNamespaceInode: '99',
    startTicks: '12345',
    pgid: 4242,
    sid: 4242,
  };
}

function recordDi(home, bin, conIdentita) {
  const state = path.join(home, 'state');
  fs.mkdirSync(state, { recursive: true });
  const rec = {
    launchId: 'ab'.repeat(8),
    vlBin: bin,
    vlBinSha256: host.sha256File(bin),
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    HOME: home,
    uid: 1000,
    serverRoot: path.join(state, 'vl', 'host-v1'),
    ts: 1,
  };
  if (conIdentita) {
    rec.version = 2;
    rec.hostIdentity = identitaBase();
  }
  return rec;
}

function statoJson(stato, extra = {}) {
  return `${JSON.stringify({ schema_version: 1, state: stato, ...extra })}\n`;
}

const VIVO = statoJson('live', { capabilities: [CAP] });
const NONE = statoJson('none', { capabilities: [CAP] });
const ACK = `${JSON.stringify({ ok: true, reason: 'shutdown_ack' })}\n`;

function proc(output, code, primaDiChiudere) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  let chiuso = false;
  p.kill = () => {
    if (chiuso) return;
    chiuso = true;
    p.emit('close', null);
  };
  p.unref = () => {};
  if (output === 'APPESO') return p;
  queueMicrotask(() => {
    if (chiuso) return;
    if (primaDiChiudere) primaDiChiudere();
    if (chiuso) return;
    chiuso = true;
    if (output) p.stdout.emit('data', Buffer.from(output));
    p.emit('close', code === undefined ? 0 : code);
  });
  return p;
}

function limiteDi(budgetMs, deadlineAt) {
  let limite = PARTENZA + Math.min(budgetMs, host.BUDGET_MS);
  if (Number.isFinite(deadlineAt)) limite = Math.min(limite, deadlineAt);
  return limite;
}

function tetto(residuo) {
  const positivo = residuo > 0 ? residuo : 0;
  return Math.min(1 + Math.ceil(positivo / 50), 1 + Math.ceil(host.BUDGET_MS / 50));
}

// `stati` e' l'elenco degli status, primo compreso; l'ultimo si ripete.
// `sulloStatus(n, sposta)` gira prima della chiusura della sonda n (1 = prima).
// `sullaPausa(ms, sposta)` puo' muovere il clock durante la pausa.
async function corsa({
  stati, budgetMs = 8000, deadlineAt, conIdentita = false, stopOut = ACK, stopCode = 0,
  sulloStatus, sullaPausa, alInternal,
} = {}) {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'));
  const rec = recordDi(home, bin, conIdentita);
  const prima = JSON.parse(JSON.stringify(rec.hostIdentity || null));
  let ora = PARTENZA;
  const pause = [];
  const figli = [];
  const chiamate = [];
  let nStatus = 0;
  const spawnImpl = (b, args) => {
    chiamate.push(args.slice());
    if (args[0] === 'internal') {
      if (alInternal) alInternal((v) => { ora = v; });
      const p = proc(stopOut, stopCode);
      figli.push(p);
      return p;
    }
    if (args[0] !== 'host') {
      const p = proc('', 1);
      figli.push(p);
      return p;
    }
    nStatus += 1;
    const i = nStatus;
    const voce = stati[Math.min(i - 1, stati.length - 1)];
    const p = proc(voce.out, voce.code, () => {
      if (sulloStatus) sulloStatus(i, (v) => { ora = v; });
    });
    figli.push(p);
    return p;
  };
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs, deadlineAt, monoNow: () => ora, isolamento: 'isolato',
    spawnImpl, attesaImpl: async (ms) => {
      pause.push({ ms, ora });
      if (sullaPausa) sullaPausa(ms, (v) => { ora = v; });
    },
  });
  const comandi = chiamate.map((a) => (a[0] === 'host' ? 'status' : a[0] === 'internal' ? 'internal' : a[0]));
  const stop = chiamate.filter((a) => a[0] === 'internal' || a[0] === 'shutdown');
  return { esito, rec, prima, chiamate, comandi, pause, figli, stop, ora: () => ora };
}

function peer(extra = {}) {
  return {
    state: 'verified',
    pid: 4242,
    uid: 1000,
    starttime: '12345',
    boot_id: '11111111-2222-3333-4444-555555555555',
    pidns: '99',
    pgid: 4242,
    sid: 4242,
    ...extra,
  };
}

test('ack, due live e un none entro la deadline: un solo stop e host fermo', async () => {
  const atteso = `${4242}:${1000}:12345:11111111-2222-3333-4444-555555555555:99:4242:4242`;
  const vivo = { out: statoJson('live', { capabilities: [CAP], peer_identity: peer() }) };
  const r = await corsa({
    conIdentita: true,
    stati: [vivo, vivo, vivo, { out: NONE }],
  });
  assert.equal(r.esito.outcome, 'host-stopped-clean');
  assert.equal(r.esito.via, 'internal');
  assert.deepEqual(r.comandi, ['status', 'internal', 'status', 'status', 'status']);
  assert.equal(r.stop.length, 1);
  assert.deepEqual(r.stop[0].slice(0, 2), ['internal', 'host-stop']);
  assert.deepEqual(r.stop[0].slice(-2), ['--expected', atteso]);
  assert.deepEqual(r.pause.map((p) => p.ms), [50, 50]);
  const sonde = r.figli.filter((f, i) => r.chiamate[i][0] === 'host').slice(1);
  for (const f of sonde) {
    assert.ok(f.timeoutMs > 0 && f.timeoutMs <= host.PROBE_MS);
    assert.ok(f.timeoutMs <= 8000);
  }
  assert.deepEqual(r.rec.hostIdentity, r.prima);
});

test('live fino al tetto fissato all ack: barriera, un solo stop, il live non rialza il tetto', async () => {
  const budgetMs = 2300;
  const nMax = tetto(budgetMs);
  assert.equal(nMax, 1 + Math.ceil(2300 / 50));
  const r = await corsa({
    budgetMs,
    stati: [
      { out: VIVO },
      { out: statoJson('live', { capabilities: [CAP], giro: 1 }) },
      { out: statoJson('lock', { capabilities: [CAP], giro: 2 }) },
    ],
  });
  assert.equal(r.esito.outcome, 'host-stop-failed');
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.esito.reason, 'shutdown_ack');
  assert.equal(r.comandi.filter((c) => c === 'status').length, 1 + nMax);
  assert.equal(r.stop.length, 1);
  assert.equal(r.pause.length, nMax - 1);
  assert.ok(r.pause.every((p) => p.ms === 50 && p.ms <= budgetMs));
});

test('il tetto non supera 1+ceil(BUDGET_MS/50) anche con un budget enorme e il clock fermo', async () => {
  const nMax = tetto(host.BUDGET_MS);
  assert.equal(nMax, 601);
  const r = await corsa({ budgetMs: 1000000, stati: [{ out: VIVO }] });
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.comandi.filter((c) => c === 'status').length, 1 + nMax);
  assert.equal(r.stop.length, 1);
});

test('la deadline del down, piu stretta del budget, e il tetto: un live non la sposta', async () => {
  const deadlineAt = PARTENZA + 2500;
  const nMax = tetto(2500);
  const r = await corsa({ budgetMs: 8000, deadlineAt, stati: [{ out: VIVO }] });
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.esito.reason, 'shutdown_ack');
  assert.equal(r.comandi.filter((c) => c === 'status').length, 1 + nMax);
  assert.ok(nMax < tetto(8000));
  assert.equal(r.stop.length, 1);
});

test('none esattamente alla deadline e un none tardivo non chiudono, e non parte un altra sonda', async () => {
  for (const oltre of [0, 25]) {
    const limite = limiteDi(8000);
    let sonde = 0;
    const r = await corsa({
      stati: [{ out: VIVO }, { out: NONE }],
      sulloStatus: (n, sposta) => {
        if (n === 1) return;
        sonde += 1;
        sposta(limite + oltre);
      },
    });
    assert.equal(sonde, 1, `oltre ${oltre}`);
    assert.equal(r.esito.outcome, 'host-stop-failed');
    assert.equal(r.esito.code, 'BARRIER');
    assert.equal(r.esito.reason, 'shutdown_ack');
    assert.notEqual(r.esito.outcome, 'host-stopped-clean');
    assert.deepEqual(r.comandi, ['status', 'internal', 'status']);
    assert.equal(r.pause.length, 0);
    assert.equal(r.stop.length, 1);
  }
});

test('la deadline che scade durante la pausa non fa partire la sonda successiva', async () => {
  const limite = limiteDi(8000);
  const r = await corsa({
    stati: [{ out: VIVO }],
    sullaPausa: (ms, sposta) => {
      assert.equal(ms, 50);
      assert.ok(ms <= 8000);
      sposta(limite);
    },
  });
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.esito.reason, 'shutdown_ack');
  assert.equal(r.pause.length, 1);
  assert.deepEqual(r.comandi, ['status', 'internal', 'status']);
  assert.equal(r.stop.length, 1);
});

test('la sonda dopo l ack dura al piu il residuo, senza un pavimento che lo superi', async () => {
  const limite = limiteDi(8000);
  const r = await corsa({
    stati: [{ out: VIVO }, { out: NONE }],
    alInternal: (sposta) => sposta(limite - 40),
  });
  assert.equal(r.esito.outcome, 'host-stopped-clean');
  const attesa = r.figli.filter((f, i) => r.chiamate[i][0] === 'host').slice(1);
  assert.equal(attesa.length, 1);
  assert.equal(attesa[0].timeoutMs, 40);
  assert.ok(attesa[0].timeoutMs <= 40);
  assert.equal(r.stop.length, 1);
});

test('una sonda appesa sul residuo va in timeout ed e barriera, senza un altra sonda', async () => {
  const limite = limiteDi(8000);
  const r = await corsa({
    stati: [{ out: VIVO }, { out: 'APPESO' }, { out: NONE }],
    alInternal: (sposta) => sposta(limite - 30),
  });
  assert.equal(r.esito.code, 'BARRIER');
  assert.equal(r.esito.reason, 'shutdown_ack');
  assert.deepEqual(r.comandi, ['status', 'internal', 'status']);
  const attesa = r.figli.filter((f, i) => r.chiamate[i][0] === 'host').slice(1);
  assert.equal(attesa.length, 1);
  assert.equal(attesa[0].timeoutMs, 30);
  assert.ok(attesa[0].timeoutMs <= 30);
});

test('prefisso none troncato, rc 1, json errato o spawn error: barriera subito, senza riprovare', async () => {
  const enorme = statoJson('none', { capabilities: [CAP], pad: 'p'.repeat(host.MAX_OUT) });
  assert.ok(Buffer.byteLength(enorme) > host.MAX_OUT);
  const casi = [
    { out: enorme, code: 0 },
    { out: NONE, code: 1 },
    { out: '{no\n', code: 0 },
    { out: '', code: 0 },
  ];
  for (const voce of casi) {
    const r = await corsa({ stati: [{ out: VIVO }, voce, { out: NONE }] });
    assert.equal(r.esito.code, 'BARRIER', JSON.stringify(voce).slice(0, 80));
    assert.equal(r.esito.reason, 'shutdown_ack');
    assert.deepEqual(r.comandi, ['status', 'internal', 'status']);
    assert.equal(r.stop.length, 1);
    assert.equal(r.pause.length, 0);
  }
  let lanci = 0;
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'));
  const rec = recordDi(home, bin, false);
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs: 8000, monoNow: () => PARTENZA, isolamento: 'isolato',
    attesaImpl: async () => { throw new Error('pausa non prevista'); },
    spawnImpl: (b, args) => {
      lanci += 1;
      if (lanci === 1) return proc(VIVO, 0);
      if (args[0] === 'internal') return proc(ACK, 0);
      throw new Error('spawn');
    },
  });
  assert.equal(esito.code, 'BARRIER');
  assert.equal(esito.reason, 'shutdown_ack');
  assert.equal(lanci, 3);
});

test('un peer diverso dopo l ack rifiuta senza un secondo stop e senza toccare il record', async () => {
  const diverso = { out: statoJson('live', { capabilities: [CAP], peer_identity: peer({ pid: 9999 }) }) };
  const r = await corsa({
    conIdentita: true,
    stati: [{ out: VIVO }, diverso, { out: NONE }],
  });
  assert.equal(r.esito.outcome, 'host-stop-failed');
  assert.equal(r.esito.code, 'HOST_PEER_MISMATCH');
  assert.equal(r.esito.reason, 'peer_mismatch');
  assert.equal(r.stop.length, 1);
  assert.ok(!r.comandi.includes('shutdown'));
  assert.deepEqual(r.comandi, ['status', 'internal', 'status']);
  assert.deepEqual(r.rec.hostIdentity, r.prima);
  assert.equal(r.rec.serverRoot, path.join(r.rec.XDG_STATE_HOME, 'vl', 'host-v1'));
});

test('un rifiuto protetto dello stop non entra nell attesa', async () => {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'));
  const rec = recordDi(home, bin, true);
  const chiamate = [];
  let pause = 0;
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs: 8000, monoNow: () => PARTENZA, isolamento: 'isolato',
    attesaImpl: async () => { pause += 1; },
    spawnImpl: (b, args) => {
      chiamate.push(args[0]);
      if (args[0] === 'host') return proc(VIVO, 0);
      return proc(`${JSON.stringify({ ok: false, reason: 'peer_mismatch' })}\n`, 1);
    },
  });
  assert.equal(esito.code, 'HOST_PEER_MISMATCH');
  assert.equal(esito.reason, 'peer_mismatch');
  assert.deepEqual(chiamate, ['host', 'internal']);
  assert.equal(pause, 0);
  assert.deepEqual(rec.hostIdentity, identitaBase());
});
