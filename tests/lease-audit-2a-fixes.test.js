'use strict';

// Test delle tre riparazioni dell'audit 2a (verbale NEEDS_CHANGES @ 142e272).
// NON replicano il rimedio dentro il test: ATTRAVERSANO broker, lease manager e
// chiamante REALI, con gli stessi seam dell'indagine indipendente (fake fs per
// l'EIO iniettato, spawn che conta). Era il difetto dei due test P1-3 originali:
// ricostruivano a mano cio' che volevano verificare e restavano verdi anche
// cancellando il chiamante di produzione — un test cosi' non copre la proprieta'.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { main: cellExecMain } = require('../lib/fleet/cell-exec.js');

function tempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStore(home, obj) {
  const file = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
  return file;
}

// --- F-A: il SECONDO ingresso (track) valida come il primo (loadPersisted) ----

test('F-A: track() NON resuscita l\'identity malformata che il boot ha rifiutato', async () => {
  const home = tempHome('fix-fa-');
  const stateFile = writeStore(home, {
    Dev: { launchEpoch: 'x', capability: 'a'.repeat(64), graceDeadline: 70_000 },
  });
  const logs = [];
  const manager = createLeaseManager({ home, log: (line) => logs.push(line) }, { now: () => 10_000 });
  try {
    await manager.boot();
    assert.equal(manager._cells.has('Dev'), false, 'boot rifiuta l\'entry malformata (P1-4, primo ingresso)');
    // Il secondo ingresso: prima resuscitava 'x' dal disco senza validazione.
    const returned = await manager.track('Dev');
    assert.match(returned.launchEpoch, /^[a-f0-9]{16}$/, 'track genera una NUOVA epoch valida (formato runtime), non resuscita');
    assert.match(returned.capability, /^[a-f0-9]{64}$/, 'capability valida (formato runtime)');
    assert.notEqual(returned.launchEpoch, 'x', 'l\'epoch malformata NON torna indietro');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')).Dev;
    assert.equal(persisted.launchEpoch, returned.launchEpoch, 'la entry corrotta e\' RIPARATA sul disco: identity nuova persistita');
    // E la identity riparata e' USABILE: l\'endpoint e' aperto e coerente con essa.
    assert.equal(fs.existsSync(returned.stablePath), true, 'endpoint aperto per la nuova identity');
  } finally {
    try { manager.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- F-C: concorrenza — una cella, una identity; umask globale mai toccato -----

test('F-C: due track() simultanei sulla stessa cella -> UNA identity, zero rifiuti, zero umask drift', async () => {
  const originalUmask = process.umask();
  let divergent = 0;
  let rejected = 0;
  // La sonda indipendente usa 40 iterazioni; qui 12 bastano a rendere la corsa
  // praticamente certa (senza lock ogni iterazione divergeva: 40/40).
  const iterations = 12;
  for (let i = 0; i < iterations; i += 1) {
    const home = tempHome('fix-fc-');
    const manager = createLeaseManager({ home, log: () => {} });
    try {
      const outcomes = await Promise.allSettled([manager.track('Dev'), manager.track('Dev')]);
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      if (ok.length < 2) rejected += 1;
      if (ok.length === 2
        && (ok[0].value.launchEpoch !== ok[1].value.launchEpoch
          || ok[0].value.capability !== ok[1].value.capability)) divergent += 1;
      assert.equal(process.umask(), originalUmask, `iter ${i}: process.umask mai toccato`);
    } finally {
      process.umask(originalUmask);
      try { manager.close(); } catch (_) {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  assert.equal(divergent, 0, '«una cella, una identity»: mai divergenti sotto concorrenza');
  assert.equal(rejected, 0, 'il secondo track e\' idempotente sul primo, non rifiutato');
});

// --- F-B: la lease PRIMA del payload, attraverso broker + manager + cell-exec --

// Il caller vero (builtin.js fa esattamente questo): attachInitial reale dentro
// onLease, destroy + return false quando non committa. Il fallimento dell'attach
// e' ottenuto come nella sonda: EIO iniettato sul file di stato DAL MANAGER
// REALE durante il persist del bind (bindLiveSocket -> persistEntry -> read).
function brokerScenario({ failAttach }) {
  const home = tempHome('fix-fb-');
  const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
  let readFail = false;
  const fakeFs = {
    ...fs,
    readFileSync(file, ...args) {
      if (readFail && file === stateFile) {
        const error = new Error('synthetic EIO'); error.code = 'EIO'; throw error;
      }
      return fs.readFileSync(file, ...args);
    },
  };
  const manager = createLeaseManager({ home, log: () => {} }, { fs: fakeFs });
  let attachOutcome = null;
  const broker = createLaunchBroker({
    home,
    onLease(socket, lease) {
      const ok = lease && lease.cellId
        ? manager.attachInitial(lease.cellId, socket, { generation: 0 })
        : false;
      attachOutcome = ok;
      if (!ok) { try { socket.destroy(); } catch (_) {} }
      return ok;
    },
  });
  return { home, manager, broker, get readFail() { return readFail; }, set readFail(v) { readFail = v; }, get attachOutcome() { return attachOutcome; } };
}

test('F-B: attach fallito -> il payload NON raggiunge il main, il child non nasce MAI', async () => {
  const iterations = 5; // la sonda usa 20; qui bastano per la suite
  for (let i = 0; i < iterations; i += 1) {
    const scenario = brokerScenario({ failAttach: true });
    const { manager, broker } = scenario;
    try {
      const identity = await manager.track('Dev');
      const ticket = await broker.issue({
        command: '/bin/true', args: [], env: {}, supervise: { enabled: false },
        lease: { cellId: 'Dev', launchEpoch: identity.launchEpoch, capability: identity.capability, stablePath: identity.stablePath },
      });
      scenario.readFail = true; // EIO: il persist del bind fallisce -> attachInitial false
      let spawns = 0;
      const fakeProcess = new EventEmitter();
      const spawn = () => {
        spawns += 1;
        const child = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => child.emit('exit', 0, null));
        return child;
      };
      let mainThrew = false;
      try {
        await cellExecMain(['--socket', ticket.socketPath, '--nonce', ticket.nonce],
          { spawn, process: fakeProcess, writeError: () => {} });
      } catch (_) { mainThrew = true; }
      assert.equal(scenario.attachOutcome, false, `iter ${i}: il setup ha DAVVERO fallito l'attach (altrimenti il test non misura niente)`);
      assert.equal(spawns, 0, `iter ${i}: il child NON nasce con una lease mai committata`);
      assert.equal(mainThrew, true, `iter ${i}: il main rigetta (receivePayload vede la chiusura prima del frame)`);
    } finally {
      scenario.readFail = false;
      try { await broker.close(); } catch (_) {}
      try { manager.close(); } catch (_) {}
      fs.rmSync(scenario.home, { recursive: true, force: true });
    }
  }
});

test('F-B (positivo): attach riuscito -> il payload e\' consegnato DOPO, il child nasce', async () => {
  const scenario = brokerScenario({ failAttach: false });
  const { manager, broker } = scenario;
  try {
    const identity = await manager.track('Dev');
    const ticket = await broker.issue({
      command: '/bin/true', args: [], env: {}, supervise: { enabled: false },
      lease: { cellId: 'Dev', launchEpoch: identity.launchEpoch, capability: identity.capability, stablePath: identity.stablePath },
    });
    // niente readFail: attachInitial committa e onLease ritorna true.
    let spawns = 0;
    const fakeProcess = new EventEmitter();
    const spawn = () => {
      spawns += 1;
      const child = new EventEmitter();
      child.kill = () => {};
      // Il lease-client manda un refresh iniziale non appena la connessione e'
      // viva (send({type:'refresh'}) in startLeaseClient); il server risponde
      // con un ack sulla STESSA socket. Un setImmediate qui fa uscire il child
      // troppo in fretta: cellExecMain chiude leaseCtl (quindi la socket lato
      // client) prima che il giro refresh/ack sia completato, e il server
      // ottiene un EPIPE scrivendo su un socket gia' chiuso dall'altro capo —
      // un artefatto del timing del test, non uno dei tre difetti. Un breve
      // ritardo lascia al giro I/O reale il tempo di completarsi.
      setTimeout(() => child.emit('exit', 0, null), 30);
      return child;
    };
    let mainThrew = false;
    try {
      await cellExecMain(['--socket', ticket.socketPath, '--nonce', ticket.nonce],
        { spawn, process: fakeProcess, writeError: () => {} });
    } catch (_) { mainThrew = true; }
    assert.equal(scenario.attachOutcome, true, 'attach riuscito (controllo del setup)');
    assert.equal(spawns, 1, 'il child nasce quando la lease e\' committata');
    assert.equal(mainThrew, false, 'il main completa senza rigettare');
  } finally {
    try { await broker.close(); } catch (_) {}
    try { manager.close(); } catch (_) {}
    fs.rmSync(scenario.home, { recursive: true, force: true });
  }
});

// --- F-B complemento: lease persa persistente -> il supervisore AVVISA e ferma -

test('F-B: lease persa per tutta la grace -> onLost avvisa il supervisore (niente orfano silenzioso)', async () => {
  // Questo test attraversa lease-client + cell-exec: il main loop con un child
  // fake che NON esce, un lease-client che perde la connessione (EOF) e un clock
  // iniettato che fa scadere la grace. Prima della riparazione il lease-client
  // desisteva in silenzio e il child restava vivo per sempre senza lease.
  const { startLeaseClient } = require('../lib/fleet/lease-client.js');
  const L = require('../lib/fleet/cell-lease.js');
  const clock = { t: 100_000 };
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  const fakeClearTimeout = () => {};
  const { EventEmitter: EE } = require('node:events');
  const initialSocket = new EE();
  initialSocket.destroyed = false;
  initialSocket.destroy = () => { initialSocket.destroyed = true; initialSocket.emit('close'); };
  initialSocket.write = () => true;
  let lost = false;
  const ctl = startLeaseClient(initialSocket, {
    stablePath: '/tmp/nonexistent-cell.sock',
    launchEpoch: 'a'.repeat(16),
    capability: 'b'.repeat(64),
    generation: 0,
    onLost: () => { lost = true; },
  }, {
    now: () => clock.t,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    net: { createConnection: () => { const s = new EE(); s.destroyed = false; s.destroy = () => { s.destroyed = true; s.emit('close'); }; s.setEncoding = () => {}; s.write = () => true; return s; } },
  });
  try {
    // EOF: la connessione iniziale cade -> il client arma la grace (now+GRACE_MS).
    initialSocket.emit('close');
    // La grace scade senza un reconnect riuscito: avanza il clock oltre la
    // deadline e gira i timer armati A ONDATE (ogni callback ne arma altri:
    // refresh re-arma il refresh, attempt re-arma il reconnect) finche' onLost
    // scatta o il guard ferma.
    clock.t += L.GRACE_MS + 1;
    for (let guard = 0; guard < 20 && !lost; guard += 1) {
      const pending = timers.splice(0, timers.length);
      for (const h of pending) { try { h.fn(); } catch (_) {} }
    }
    assert.equal(lost, true, 'onLost chiamato quando la grace scade senza reconnect');
  } finally {
    try { ctl.stop(); } catch (_) {}
  }
});

// --- Correzione (audit 2a, precisata da Dev): handler 'error' sui socket -----
//
// La segnalazione originale ("grep vuoto su .on('error')") era imprecisa: gli
// handler sul SERVER ci sono in tutti e tre i moduli. Il buco vero e' piu'
// stretto: manca l'handler sul SOCKET ACCETTATO — bindLiveSocket e
// onStableConnection in cell-lease-server.js, e il socket del broker in
// launch-broker.js — cioe' esattamente dove il server SCRIVE (l'ack di
// refresh, il 'deny', il payload). Un EventEmitter che emette 'error' senza
// listener fa un throw che termina l'INTERO processo: non muore la cella,
// muore NexusCrew con dentro tutte le celle.
//
// CONTROLLO NEGATIVO: uno script child-process isolato dimostra il crash SENZA
// l'handler e la sopravvivenza CON l'handler (il codice reale, invariato). La
// disattivazione avviene runtime su UN socket fittizio dentro lo script
// isolato (mai sul file sorgente): "disattiva e ripristina nello stesso
// comando" — qui il ripristino e' automatico, il modulo non viene mai toccato.
// L'errore e' emesso dentro un setImmediate, FUORI dal try/catch della IIFE
// del child: cosi' un throw non gestito diventa un vero uncaughtException
// (exit non-zero), non una rejection catturata localmente — il modo in cui un
// vero errore di rete asincrono arriverebbe in produzione.

const { execFileSync } = require('node:child_process');

function errorHandlerCrashScript() {
  return `
'use strict';
const { EventEmitter } = require('node:events');
const { createLeaseManager } = require(process.env.NC_LEASE_SERVER_PATH);

function fakeSocket() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.setEncoding = () => {};
  s.write = () => true;
  s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit('close'); } };
  return s;
}

(async () => {
  const manager = createLeaseManager({ home: process.env.NC_HOME, log: () => {} });
  const identity = await manager.track('Dev');
  const sock = fakeSocket();
  const ok = manager.attachInitial('Dev', sock, { generation: 0 });
  if (!ok) { process.exit(2); return; }
  if (process.env.NC_MODE === 'without-handler') {
    // Rimuove SOLO il listener sull'istanza fake di QUESTO script isolato.
    sock.removeAllListeners('error');
  }
  setImmediate(() => {
    // Simula un peer che muore (ECONNRESET/EPIPE async) mentre il server sta
    // per scrivere sul socket "live" — esattamente il punto reale.
    sock.emit('error', new Error('ECONNRESET simulato'));
    setTimeout(() => process.exit(0), 15);
  });
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(3); });
`;
}

function runErrorHandlerScenario(mode) {
  const home = tempHome('fix-errhandler-');
  const scriptPath = path.join(home, 'scenario.js');
  fs.writeFileSync(scriptPath, errorHandlerCrashScript());
  try {
    const env = {
      ...process.env,
      NC_LEASE_SERVER_PATH: path.join(__dirname, '..', 'lib', 'fleet', 'cell-lease-server.js'),
      NC_HOME: home,
      NC_MODE: mode,
    };
    try {
      execFileSync(process.execPath, [scriptPath], { env, timeout: 5000, stdio: 'pipe' });
      return { crashed: false, code: 0 };
    } catch (error) {
      return { crashed: true, code: error.status, stderr: String(error.stderr || '') };
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('Correzione: SENZA l\'handler \'error\', un peer che muore FA CADERE il processo (dimostrato, non presupposto)', () => {
  const result = runErrorHandlerScenario('without-handler');
  assert.equal(result.crashed, true, 'senza il listener \'error\' il child DEVE crashare: se non crolla, questo test non prova nulla');
  assert.match(result.stderr, /ECONNRESET simulato/, 'il crash e\' proprio il nostro errore non gestito, non un altro guasto dello script');
});

test('Correzione: CON l\'handler \'error\' (codice reale), lo STESSO scenario NON fa cadere il processo', () => {
  const result = runErrorHandlerScenario('with-handler');
  assert.equal(result.crashed, false, `il processo doveva sopravvivere (stderr: ${result.stderr || ''})`);
  assert.equal(result.code, 0);
});

test('Correzione: il socket accettato dal launch-broker sopravvive a un errore async senza far cadere il broker', async () => {
  // Stesso principio, attraverso il broker REALE (non un fake): un client si
  // connette, il broker accetta (registra il suo handler 'error'), il client
  // muore bruscamente (destroy con errore) mentre la connessione e' aperta.
  // Prima del fix questo path non aveva handler 'error' sul socket accettato.
  const net = require('node:net');
  const home = tempHome('fix-broker-err-');
  const broker = createLaunchBroker({ home });
  let crashed = false;
  const onUncaught = (e) => { crashed = true; };
  process.once('uncaughtException', onUncaught);
  try {
    const ticket = await broker.issue({ command: '/bin/true', args: [], env: {}, supervise: { enabled: false } });
    const client = net.createConnection(ticket.socketPath);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    // Distrugge bruscamente con un codice di errore (simula RST): il socket
    // ACCETTATO dal broker (lato server) ricevera' un 'error' asincrono.
    client.destroy(Object.assign(new Error('synthetic ECONNRESET'), { code: 'ECONNRESET' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(crashed, false, 'un client che muore bruscamente non deve far cadere il broker');
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    try { await broker.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});
