'use strict';
// Supervisore REALE (cell-exec main) in un processo distinto, per le prove
// end-to-end dello strato 2c: stesso lease-client, stesso fence di generazione,
// stessa scrittura del record canonico. Si pilota da stdin (una riga per
// comando) e riferisce su stdout (JSON per riga). Tutto in un mondo isolato:
// il child finto non digita in nessun terminale e il tmux e' uno stub.
//   argv[2] = JSON { port, cellId, stablePath, launchEpoch, dir, launchId, logPath }
//   stdin: exit-child | lock-dir | unlock-dir | quit
const net = require('node:net');
const fs = require('node:fs');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const cellExec = require('../../lib/fleet/cell-exec.js');

const cfg = JSON.parse(process.argv[2]);
let holdReconnect = false;
const OrigCreateConnection = net.createConnection;
net.createConnection = function (...a) {
  // Quando il test trattiene il reconnect verso lo stablePath (stringa),
  // restituisce un socket finto che rifiuta sul tick successivo: il supervisore
  // resta nel ciclo di retry senza raggiungere il nuovo demone finche' il test
  // non sblocca l'ordine con release-reconnect.
  if (holdReconnect && typeof a[0] === 'string') {
    const s = new EventEmitter();
    s.destroyed = false;
    s.writable = false;
    s.setEncoding = () => s;
    s.write = () => false;
    s.destroy = () => {
      if (s.destroyed) return;
      s.destroyed = true;
      process.nextTick(() => s.emit('close'));
    };
    process.nextTick(() => {
      if (!s.destroyed) s.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    });
    return s;
  }
  const s = OrigCreateConnection.apply(this, a);
  if (process.env.NC_CHILD_TRACE) {
    const t = Date.now() % 100000;
    process.stderr.write(`${t} conn ${JSON.stringify(a[0])}\n`);
    s.on('connect', () => process.stderr.write(`${Date.now() % 100000} connected\n`));
    s.on('end', () => process.stderr.write(`${Date.now() % 100000} end\n`));
    s.on('close', () => process.stderr.write(`${Date.now() % 100000} close\n`));
    s.on('error', (e) => process.stderr.write(`${Date.now() % 100000} error ${e.code}\n`));
  }
  return s;
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let corrente = null;
let spawns = 0;
let uscita = null;

const payload = {
  command: '/bin/fake', args: [], env: {},
  lease: { cellId: cfg.cellId, launchEpoch: cfg.launchEpoch, stablePath: cfg.stablePath },
  promptOutcome: { dir: cfg.dir, launchId: cfg.launchId },
  supervise: {
    enabled: true, initialReadyMs: 1, restartDelayMs: 5, maxRestartDelayMs: 20,
    resetAfterMs: 100000, rapidWindowMs: 100000, maxRapidRestarts: 100,
  },
  restartPrompt: {
    tmuxBin: 'tmux', tmuxSession: 'cloud-Cella', prompt: 'resume', readyMs: 0,
    client: 'kimi', readyWaitMs: 1000,
  },
};

const sock = net.createConnection({ port: cfg.port, host: '127.0.0.1' });
sock.setEncoding('utf8');
sock.once('error', () => {});

sock.once('connect', () => {
  cellExec.main(['--socket', '/tmp/x', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => ({ payload, socket: sock }),
    spawn: () => {
      spawns += 1;
      const child = new EventEmitter();
      child.kill = () => {};
      child.pid = 40000 + spawns;
      corrente = child;
      out({ ev: 'spawned', n: spawns });
      return child;
    },
    now: () => Date.now(),
    monoNow: () => Date.now(),
    sleep: async () => {},
    process: new EventEmitter(),
    // Nessun wrapper sui timer: le durate del lease (nominali E tagliate al
    // residuo: retry, budget del tentativo, deadline) restano quelle vere del
    // runtime, cosi' il banco non accorcia la finestra che il client usa per
    // attendere una risposta utile.
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    // Il trasporto e' l'unico punto finto: ogni consegna lascia una riga nel
    // log, cosi' «zero paste» e' osservabile dal processo padre.
    deliverBootstrapPrompt: async (opts) => {
      fs.appendFileSync(cfg.logPath, `delivered\n`);
      out({ ev: 'delivered' });
      return { delivered: true, state: 'submitted', notReady: '', attempts: 1, reason: 'submitted' };
    },
    injectPrompt: async () => { throw new Error('legacy path non atteso'); },
    writeError: () => {},
  }).then((code) => { out({ ev: 'main-exit', code }); process.exit(0); }, () => process.exit(1));
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (riga) => {
  const cmd = riga.trim();
  if (cmd === 'exit-child' && corrente) { const c = corrente; corrente = null; c.emit('exit', 1, null); }
  else if (cmd === 'lock-dir') { try { fs.chmodSync(cfg.dir, 0o500); out({ ev: 'locked' }); } catch (_) { out({ ev: 'lock-failed' }); } }
  else if (cmd === 'unlock-dir') { try { fs.chmodSync(cfg.dir, 0o700); out({ ev: 'unlocked' }); } catch (_) { /* best-effort */ } }
  else if (cmd === 'hold-reconnect') { holdReconnect = true; out({ ev: 'reconnect-held' }); }
  else if (cmd === 'release-reconnect') { holdReconnect = false; out({ ev: 'reconnect-released' }); }
  else if (cmd === 'quit') process.exit(0);
});
void uscita;
