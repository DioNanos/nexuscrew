'use strict';
// S3c mattone 3/3 — fase di stop nel coordinatore e attesa nel down.
// Nessun segnale a processi della flotta: kill(0) vero solo nel processo
// distaccato di un caso, sul suo gruppo. I fake tmux -C si chiudono a fine test.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const { main } = require('../lib/fleet/cell-exec.js');
const gruppo = require('../lib/fleet/group-stop.js');

function hexId() { return crypto.randomBytes(8).toString('hex'); }

test('una cancellazione oltre la deadline non rinnova il segnale', async () => {
  let clock = 0;
  const signals = [];
  const esito = await gruppo.eseguiFaseStop({
    frame: { payload: { deadlineMs: 100 }, requestId: hexId(), epoch: 1 },
    tokenHash: 'a'.repeat(64),
    launchId: hexId(),
    monoNow: () => clock,
    sleep: async (n) => { clock += n; },
    killGruppo: (s) => signals.push(s),
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
    invia: () => {},
    svuota: async () => true,
    cancellaDelivery: async () => { clock = 1000; },
  });
  assert.equal(signals.length, 0);
  assert.equal(esito.outcome, 'stop-unknown');
});

test('un candidato illeggibile non conta come zero completo', () => {
  const rd = fs.readFileSync;
  const ls = fs.readdirSync;
  try {
    fs.readdirSync = (p, ...a) => (p === '/proc' ? ['543210'] : ls(p, ...a));
    fs.readFileSync = (p, ...a) => {
      if (p === `/proc/${process.pid}/stat`) return `${process.pid} (probe) S 1 4242 4242 0`;
      if (p === '/proc/543210/stat') {
        const err = new Error('synthetic denial');
        err.code = 'EACCES';
        throw err;
      }
      return rd(p, ...a);
    };
    const foto = gruppo.osservaProduzione([]);
    assert.notEqual(foto.qualita, 'noti');
  } finally {
    fs.readFileSync = rd;
    fs.readdirSync = ls;
  }
});

test('classifica: l\'ammissione non e\' l\'esito, la deadline scaduta nemmeno', () => {
  assert.equal(gruppo.classificaEsito({ ack: true, ready: null, commit: null, report: null, eof: false }).outcome, 'stop-unknown');
  assert.equal(gruppo.classificaEsito({ ack: true, ready: { conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } }, eof: false }).outcome, 'stop-unknown');
  assert.equal(gruppo.classificaEsito({
    ready: { conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } }, eof: true,
  }).outcome, 'stop-unknown');
  assert.equal(gruppo.classificaEsito({
    ready: { conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } },
    uscito: true, dopo: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' },
  }).outcome, 'killed-clean');
  assert.equal(gruppo.classificaEsito({
    commit: { conti: { inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' } }, eof: true,
  }).outcome, 'stop-unknown');
  assert.equal(gruppo.classificaEsito({
    commit: { conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } }, eof: true,
  }).outcome, 'stop-unknown');
  assert.equal(gruppo.classificaEsito({
    commit: { conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } },
    uscito: true, dopo: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' },
  }).outcome, 'killed-after-escalation');
  assert.equal(gruppo.classificaEsito({
    commit: { conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } },
    uscito: true, dopo: { inGruppo: 2, fuoriGruppo: 0, qualita: 'noti' },
  }).outcome, 'stop-incomplete');
  assert.equal(gruppo.classificaEsito({
    ready: { conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' } }, eof: true,
  }).outcome, 'stop-unknown');
  assert.equal(gruppo.classificaEsito({ report: { code: 'eperm' }, eof: true }).outcome, 'eperm');
  assert.equal(gruppo.classificaEsito({ eof: true }).outcome, 'stop-unknown');
});

test('fase TERM: cancel prima del segnale, ready-to-exit, un solo stop', async () => {
  const ordine = [];
  const uccisioni = [];
  let foto = { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' };
  const spediti = [];
  const launchId = hexId();
  const token = 'tok-non-segreto-di-test';
  let clock = 0;
  const coord = gruppo.creaCoordinatore({
    token, launchId,
    monoNow: () => clock,
    sleep: async (ms) => { clock += ms; },
    killGruppo: (sig) => {
      ordine.push(`kill:${sig}`);
      uccisioni.push(sig);
      if (sig === 'SIGTERM') foto = { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };
    },
    osserva: () => foto,
    invia: (frame) => { spediti.push(frame); ordine.push(frame.op); return true; },
    svuota: async () => true,
    cancellaDelivery: async () => { ordine.push('cancel'); return { state: 'settled' }; },
    scriviLog: () => {},
    dichiaraStopping: () => { ordine.push('stopping'); },
    disarmaLegacy: () => { ordine.push('disarma'); },
    installaIgnoraTerm: () => { ordine.push('ignora'); },
  });
  const req = hexId();
  coord.onFrame({ op: 'stop', requestId: req, launchId, epoch: 2, payload: { deadlineMs: 500 } });
  coord.onFrame({ op: 'stop', requestId: req, launchId, epoch: 2, payload: { deadlineMs: 500 } });
  coord.onFrame({ op: 'stop', requestId: hexId(), launchId, epoch: 2, payload: { deadlineMs: 500 } });
  coord.onFrame({ op: 'stop', requestId: hexId(), launchId, epoch: 1, payload: { deadlineMs: 500 } });
  const esito = await coord.attiva();
  assert.equal(esito.outcome, 'ready-to-exit');
  assert.deepEqual(uccisioni, ['SIGTERM']);
  assert.ok(ordine.indexOf('stopping') < ordine.indexOf('cancel'));
  assert.ok(ordine.indexOf('cancel') < ordine.indexOf('kill:SIGTERM'));
  assert.ok(spediti.some((f) => f.op === 'stop-ack'));
  assert.ok(spediti.some((f) => f.op === 'ready-to-exit' && f.payload.stopRequestId === req));
  assert.equal(spediti.some((f) => JSON.stringify(f).includes(token)), false);
});

test('fase escalation: impegno prima del KILL, nessun frame dopo', async () => {
  const ordine = [];
  let clock = 0;
  const foto = { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' };
  const id = hexId();
  const idLancio = hexId();
  const coord2 = gruppo.creaCoordinatore({
    token: 't', launchId: idLancio,
    monoNow: () => clock,
    sleep: async (ms) => { clock += ms; },
    killGruppo: (sig) => { ordine.push(`kill:${sig}`); },
    osserva: () => foto,
    invia: (frame) => { ordine.push(frame.op); return true; },
    svuota: async () => true,
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
  });
  coord2.onFrame({ op: 'stop', requestId: id, launchId: idLancio, epoch: 1, payload: { deadlineMs: 100 } });
  const esito = await coord2.attiva();
  assert.equal(esito.outcome, 'escalate-commit');
  const iCommit = ordine.indexOf('escalate-commit');
  const iKill = ordine.lastIndexOf('kill:SIGKILL');
  assert.ok(iCommit >= 0 && iKill > iCommit);
  assert.equal(ordine.filter((x) => x.startsWith('kill:')).join(','), 'kill:SIGTERM,kill:SIGKILL');
  assert.equal(ordine.slice(iKill + 1).some((x) => x !== 'kill:SIGKILL' && !x.startsWith('kill:')), false);
});

test('setsid contato fuori gruppo: niente KILL e niente pid', async () => {
  const uccisioni = [];
  const host = { vivo: true };
  const idLancio = hexId();
  const coord = gruppo.creaCoordinatore({
    token: 't', launchId: idLancio,
    monoNow: () => 0,
    sleep: async () => {},
    killGruppo: (sig) => { uccisioni.push(sig); },
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 1, qualita: 'noti' }),
    invia: () => true,
    svuota: async () => true,
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
  });
  coord.onFrame({ op: 'stop', requestId: hexId(), launchId: idLancio, epoch: 1, payload: { deadlineMs: 200 } });
  const esito = await coord.attiva();
  assert.equal(esito.outcome, 'ready-to-exit');
  assert.equal(esito.conti.fuoriGruppo, 1);
  assert.deepEqual(uccisioni, ['SIGTERM']);
  assert.equal(host.vivo, true);
});

test('EPERM: report e nessun KILL', async () => {
  const ordine = [];
  const idLancio = hexId();
  const coord = gruppo.creaCoordinatore({
    token: 't', launchId: idLancio,
    monoNow: () => 0,
    sleep: async () => {},
    killGruppo: () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; },
    osserva: () => ({ inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
    invia: (frame) => { ordine.push(frame.op); return true; },
    svuota: async () => true,
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
  });
  coord.onFrame({ op: 'stop', requestId: hexId(), launchId: idLancio, epoch: 1, payload: { deadlineMs: 200 } });
  const esito = await coord.attiva();
  assert.equal(esito.outcome, 'eperm');
  assert.ok(ordine.includes('stop-report'));
  assert.equal(ordine.includes('escalate-commit'), false);
});

test('deadline gia\' spesa e canale assente non diventano successo', async () => {
  const assente = await gruppo.attendiFermataGruppo({
    leaseManager: { controlConnesso: () => false, sendControl: () => true, ascoltaControl: () => () => {} },
    cellId: 'c', launchId: hexId(), monoNow: () => 0, deadlineAt: 1000, graziaMs: 200,
  });
  assert.equal(assente.outcome, 'identity-lost');
  let spedito = false;
  const scaduta = await gruppo.attendiFermataGruppo({
    leaseManager: {
      controlConnesso: () => true,
      sendControl: () => { spedito = true; return true; },
      ascoltaControl: () => () => {},
      suChiusuraControl: () => () => {},
    },
    cellId: 'c', launchId: hexId(), monoNow: () => 5000, deadlineAt: 5000, graziaMs: 200,
  });
  assert.equal(scaduta.outcome, 'stop-unknown');
  assert.equal(spedito, false);
});

test('un figlio nato durante la grazia riceve ancora TERM', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-grazia-'));
  const figlio = path.join(home, 'figlio.js');
  const padre = path.join(home, 'padre.js');
  fs.writeFileSync(figlio, "'use strict';\nprocess.on('SIGTERM', () => { process.stdout.write('TERM\\n'); process.exit(0); });\nsetInterval(() => {}, 1000);\n");
  fs.writeFileSync(padre, `'use strict';
const { killGruppoCorrente } = require(${JSON.stringify(path.join(__dirname, '../lib/fleet/group-stop.js'))});
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const figlio = spawn(process.execPath, [${JSON.stringify(figlio)}], { stdio: ['ignore', 'pipe', 'inherit'] });
figlio.stdout.on('data', (b) => {
  process.stdout.write(b);
  if (String(b).includes('TERM')) process.exit(0);
});
setTimeout(() => {
  try { killGruppoCorrente('SIGTERM'); } catch (e) { process.exit(2); }
}, 200);
setTimeout(() => process.exit(3), 2500);
`);
  const child = spawn(process.execPath, [padre], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let spento = false;
  const spegni = () => {
    if (spento) return;
    spento = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  };
  t.after(() => { spegni(); fs.rmSync(home, { recursive: true, force: true }); });
  const uscita = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { spegni(); reject(new Error('grazia oltre 4s')); }, 4000);
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  assert.equal(uscita.code, 0);
  assert.match(uscita.out, /TERM/);
});

function socketFinto() {
  const e = new EventEmitter();
  e.writable = true;
  e.destroyed = false;
  e.write = () => true;
  e.destroy = () => { e.destroyed = true; e.emit('close'); };
  return e;
}

test('main: stop sul canale, handler legacy disarmato, token fuori dall\'env', async () => {
  const launchId = hexId();
  const token = `token-${hexId()}`;
  const sock = socketFinto();
  const scritti = [];
  sock.write = (line) => { scritti.push(String(line)); return true; };
  const proc = new EventEmitter();
  const uccisioni = [];
  const childKills = [];
  const stderr = [];
  let child;
  let clock = 0;
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: '/usr/bin' },
    supervise: { enabled: false, initialReadyMs: 0 },
    lease: { cellId: 'CellaStop', launchEpoch: hexId(), stablePath: '/tmp/inesistente-stop.sock' },
    control: { launchId, token },
    restartPrompt: {
      client: 'claude', prompt: 'x', tmuxBin: '/bin/true', tmuxSession: 's', readyMs: 60000,
    },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'ab'.repeat(32)], {
    receivePayload: async () => ({ payload, socket: sock }),
    spawn: () => {
      child = new EventEmitter();
      child.pid = 4242;
      child.kill = (sig) => { childKills.push(sig); return true; };
      child.stdio = [];
      setImmediate(() => {
        sock.emit('data', Buffer.from(`${JSON.stringify({
          op: 'stop', requestId: hexId(), launchId, epoch: 1, payload: { deadlineMs: 300 },
        })}\n`, 'utf8'));
      });
      return child;
    },
    killGruppo: (sig) => {
      uccisioni.push(sig);
      proc.emit('SIGTERM');
      if (sig === 'SIGTERM') setImmediate(() => child.emit('exit', 0, null));
    },
    osserva: () => (childKills.length || uccisioni.includes('SIGTERM')
      ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
      : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
    process: proc,
    sleep: async (ms) => { clock += ms; },
    monoNow: () => clock,
    now: () => 1000,
    setTimeout: () => 1,
    clearTimeout: () => {},
    writeError: (m) => { stderr.push(m); },
    tmuxExec: async () => ({ err: null, stdout: '' }),
  });
  assert.equal(code, 0);
  assert.deepEqual(childKills, []);
  assert.deepEqual(uccisioni, ['SIGTERM']);
  const frame = scritti.map((r) => r.trim()).filter(Boolean).map((r) => JSON.parse(r)).filter((f) => f.op);
  assert.ok(frame.some((f) => f.op === 'stop-ack'));
  assert.ok(frame.some((f) => f.op === 'ready-to-exit'));
  assert.equal(scritti.some((r) => r.includes(token)), false);
  assert.ok(stderr.some((r) => r.includes('pidfd-hardening-absent')));
});

function attendi(check, ms = 4000, passo = 20) {
  const fine = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = check(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() > fine) { reject(new Error('attesa scaduta')); return; }
      setTimeout(tick, passo);
    };
    tick();
  });
}

test('canale vero: ready-to-exit e EOF diventano killed-clean, il solo ack no', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-stop-wire-'));
  const dir = path.join(home, '.nexuscrew', 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cellId = 'cella-stop';
  const token = crypto.randomBytes(32).toString('hex');
  const launchId = hexId();
  const visti = [];
  const mgr = createLeaseManager({
    home,
    onControlFrame: (_id, frame) => { visti.push(frame); },
  });
  const pairPath = path.join(dir, 'pair.sock');
  let serverSide = null;
  const srv = net.createServer((sock) => { serverSide = sock; });
  await new Promise((resolve) => srv.listen(pairPath, resolve));
  const clientSide = await new Promise((resolve, reject) => {
    const s = net.connect(pairPath, () => resolve(s));
    s.on('error', reject);
  });
  await attendi(() => serverSide);
  await mgr.track(cellId);
  mgr.armControl(cellId, { launchId, token });
  let leaseCtl;
  const coord = gruppo.creaCoordinatore({
    token, launchId,
    monoNow: () => Number(process.hrtime.bigint() / 1000000n),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    killGruppo: () => {},
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
    invia: (frame) => leaseCtl.sendControl(frame),
    svuota: async () => {
      await leaseCtl.svuota();
      try { clientSide.end(); } catch (_) {}
    },
    cancellaDelivery: async () => null,
    scriviLog: () => {},
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
  });
  leaseCtl = startLeaseClient(clientSide, {
    stablePath: path.join(dir, 'no.sock'),
    launchEpoch: hexId(),
    onControlFrame: (frame) => coord.onFrame(frame),
  });
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  t.after(async () => {
    try { leaseCtl.stop(); } catch (_) {}
    try { clientSide.destroy(); } catch (_) {}
    try { serverSide.destroy(); } catch (_) {}
    await new Promise((resolve) => srv.close(resolve));
    try { await mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });
  await attendi(() => leaseCtl._heldProof() != null);
  const esito = await gruppo.attendiFermataGruppo({
    leaseManager: mgr, cellId, launchId,
    monoNow: () => Number(process.hrtime.bigint() / 1000000n),
    deadlineAt: Number(process.hrtime.bigint() / 1000000n) + 2000,
    graziaMs: 400,
    attendiUscita: async () => {
      // Prova reale: l'attesa del coordinatore (supervisore simulato) risolta
      // e' il riscontro d'uscita, distinto dalla chiusura del canale.
      if (coord.attiva()) await coord.attiva();
      return { provato: true };
    },
    osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
  });
  // Il coordinatore esce chiudendo il socket: senza EOF l'esito non e' pulito.
  if (coord.attiva()) await coord.attiva();
  try { leaseCtl.stop(); } catch (_) {}
  const finale = esito.outcome === 'killed-clean' ? esito : await new Promise((resolve) => {
    // se l'EOF e' arrivato un attimo dopo il return, la classifica gia' fatta
    // resta. Qui l'attesa include la chiusura: rivalutiamo solo se manca.
    resolve(esito);
  });
  assert.equal(finale.outcome, 'killed-clean', JSON.stringify(esito));
  assert.ok(visti.some((f) => f.op === 'stop-ack'));
  assert.ok(visti.some((f) => f.op === 'ready-to-exit'));
  assert.equal(visti.some((f) => JSON.stringify(f).includes(token)), false);
});

function mondo(t, lease) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gs-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'CellaGS'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json'); fs.writeFileSync(statoPath, '[]');
  const logPath = path.join(root, 'chiamate.log');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue; // apertura: gia' risolta dal frame iniziale
      n += 1;
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, [__filename, '-S', 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const STATO = ${JSON.stringify(statoPath)};
const LOG = ${JSON.stringify(logPath)};
const nota = (cosa) => fs.appendFileSync(LOG, cosa + '\\n');
const leggi = () => { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (_) { return []; } };
const cmd = (a) => a[0] || '';
if (cmd(args) === 'new-session') {
  const nome = args[args.indexOf('-s') + 1];
  const s = { nome, id: '$7', w: '@7', p: '%7' };
  fs.writeFileSync(STATO, JSON.stringify(leggi().concat([s])));
  nota('new-session:' + nome);
  process.stdout.write(s.id + '\\t' + s.w + '\\t' + s.p + '\\n'); process.exit(0);
}
if (cmd(args) === 'kill-session') {
  const bersaglio = args[args.length - 1];
  const lista = leggi();
  const s = lista.find((x) => x.id === bersaglio) || null;
  nota('kill-session:' + bersaglio);
  if (s) fs.writeFileSync(STATO, JSON.stringify(lista.filter((x) => x.id !== s.id)));
  process.exit(0);
}
if (cmd(args) === 'has-session') {
  const bersaglio = args[args.length - 1];
  nota('has-session:' + bersaglio);
  process.exit(leggi().some((x) => x.id === bersaglio) ? 0 : 1);
}
if (cmd(args) === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('pane_dead')) { process.stdout.write('0\\t0\\t%7\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%7\\n'); process.exit(0);
}
if (cmd(args) === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'eg', label: 'G', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: 'CellaGS', tmuxSession: 'nc-gs-prova', cwd, engine: 'eg', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true, groupStopBudgetMs: 400 },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {}, close: async () => {},
    },
    leaseManager: lease,
    boot: loadDefinitions(defsPath),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  return {
    runtime,
    log: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
    sessioni: () => JSON.parse(fs.readFileSync(statoPath, 'utf8')),
  };
}

function leaseFinto(modo) {
  const ascoltatori = [];
  let chiusura = null;
  let idArmato = null;
  const inviati = [];
  return {
    inviati,
    track: async () => ({ launchEpoch: 'ab'.repeat(8), stablePath: '/tmp/no-lease.sock' }),
    armControl(_cell, info) { idArmato = info.launchId; return { hash: 'cd'.repeat(32) }; },
    revokeControl() { idArmato = null; },
    controlArmato() { return !!idArmato; },
    controlConnesso() { return modo !== 'spento'; },
    controlLaunchId() { return idArmato; },
    status() { return { state: 'none' }; },
    setLaunchSubject() { return true; },
    attendiUscita() {
      if (modo === 'pulito' || modo === 'residui') return Promise.resolve({ provato: true });
      return Promise.reject(new Error('exit unproven'));
    },
    osservaGruppo() {
      if (modo === 'residui') return { inGruppo: 2, fuoriGruppo: 0, qualita: 'noti' };
      if (modo === 'pulito') return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };
      return null;
    },
    ascoltaControl(fn) { ascoltatori.push(fn); return () => {}; },
    suChiusuraControl(_id, cb) { chiusura = cb; return () => { chiusura = null; }; },
    sendControl(cellId, frame) {
      inviati.push(frame);
      setImmediate(() => {
        const base = {
          requestId: hexId(), launchId: frame.launchId, epoch: 1,
          payload: { tokenHash: 'cd'.repeat(32), stopRequestId: frame.requestId },
        };
        if (modo === 'pulito') {
          for (const fn of ascoltatori) fn(cellId, {
            ...base, op: 'ready-to-exit',
            payload: { ...base.payload, conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } },
          });
          if (chiusura) chiusura();
        } else if (modo === 'residui') {
          for (const fn of ascoltatori) fn(cellId, {
            ...base, op: 'escalate-commit',
            payload: { ...base.payload, conti: { inGruppo: 2, fuoriGruppo: 0, qualita: 'noti' } },
          });
          if (chiusura) chiusura();
        } else if (modo === 'senza-eof') {
          for (const fn of ascoltatori) fn(cellId, {
            ...base, op: 'ready-to-exit',
            payload: { ...base.payload, conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } },
          });
        } else if (modo === 'solo-ack') {
          for (const fn of ascoltatori) fn(cellId, { ...base, op: 'stop-ack' });
        } else if (modo === 'eof-senza-impegno') {
          if (chiusura) chiusura();
        }
      });
      return true;
    },
  };
}

test('down: gruppo pulito con uscita e osservazione residui zero, esito killed-clean', async (t) => {
  const lease = leaseFinto('pulito');
  const w = mondo(t, lease);
  await w.runtime.up('CellaGS');
  const esito = await w.runtime.down('CellaGS');
  assert.equal(esito.killed, true);
  assert.equal(esito.outcome, 'killed-clean');
  assert.equal(w.sessioni().length, 0);
  assert.equal(lease.inviati.filter((f) => f.op === 'stop').length, 1);
  assert.ok(w.log().some((r) => r.startsWith('kill-session:')));
});

test('down: proc incompleto con processi residui rifiuta teardown', async (t) => {
  const lease = leaseFinto('residui');
  const w = mondo(t, lease);
  await w.runtime.up('CellaGS');
  await assert.rejects(
    () => w.runtime.down('CellaGS'),
    (e) => e.fleetCode === 'STOP_INCOMPLETE' && e.data.outcome === 'stop-incomplete',
  );
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
});

test('down: pronto senza EOF rifiuta teardown alla deadline', async (t) => {
  const lease = leaseFinto('senza-eof');
  const w = mondo(t, lease);
  await w.runtime.up('CellaGS');
  await assert.rejects(
    () => w.runtime.down('CellaGS'),
    (e) => e.fleetCode === 'STOP_UNKNOWN' && e.data.outcome === 'stop-unknown',
  );
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
});

test('down: solo ack non e\' successo, la sessione resta, restart non rilancia', async (t) => {
  const lease = leaseFinto('solo-ack');
  const w = mondo(t, lease);
  await w.runtime.up('CellaGS');
  const prima = w.log().filter((r) => r.startsWith('new-session:')).length;
  await assert.rejects(
    () => w.runtime.restart('CellaGS'),
    (e) => e.fleetCode === 'STOP_UNKNOWN' && e.data.outcome === 'stop-unknown',
  );
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(w.log().filter((r) => r.startsWith('new-session:')).length, prima);
});

test('down: canale spento e\' identity-lost, nessuno kill-session, nessuno stop sul filo', async (t) => {
  const lease = leaseFinto('spento');
  const w = mondo(t, lease);
  await w.runtime.up('CellaGS');
  await assert.rejects(() => w.runtime.down('CellaGS'), (e) => e.status === 409 && e.fleetCode === 'IDENTITY_LOST' && e.data.outcome === 'identity-lost');
  assert.equal(lease.inviati.length, 0);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
});

test('down: EOF senza impegno e\' stop-unknown', async (t) => {
  const lease = leaseFinto('eof-senza-impegno');
  const w = mondo(t, lease);
  await w.runtime.up('CellaGS');
  await assert.rejects(() => w.runtime.down('CellaGS'), (e) => e.fleetCode === 'STOP_UNKNOWN' && e.data.outcome === 'stop-unknown');
});
