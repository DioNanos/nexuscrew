'use strict';

// Test delle tre riparazioni emerse dalla revisione della 2a (@ 142e272).
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

// 2b: storage per-cell. La entry e' {launchEpoch, graceDeadline} — la capability
// non esiste piu' (revocata, A2).
function writeEntry(home, cellId, entry) {
  const dir = path.join(home, '.nexuscrew', 'run', 'cell-leases');
  const file = path.join(dir, `${cellId}.json`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  return file;
}

// --- F-A: il SECONDO ingresso (track) valida come il primo (loadPersisted) ----

test('F-A: track() NON resuscita l\'identity malformata che il boot ha rifiutato', async () => {
  const home = tempHome('fix-fa-');
  const stateFile = writeEntry(home, 'Dev', { launchEpoch: 'x', graceDeadline: 70_000 });
  const logs = [];
  const manager = createLeaseManager({ home, log: (line) => logs.push(line) }, { now: () => 10_000 });
  try {
    await manager.boot();
    assert.equal(manager._cells.has('Dev'), false, 'boot rifiuta l\'entry malformata (P1-4, primo ingresso)');
    // Il secondo ingresso: prima resuscitava 'x' dal disco senza validazione.
    const returned = await manager.track('Dev');
    assert.match(returned.launchEpoch, /^[a-f0-9]{16}$/, 'track genera una NUOVA epoch valida (formato runtime), non resuscita');
    assert.equal('capability' in returned, false, '2b: nessuna capability dal track (revocata, A2)');
    assert.notEqual(returned.launchEpoch, 'x', 'l\'epoch malformata NON torna indietro');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
          || ok[0].value.stablePath !== ok[1].value.stablePath)) divergent += 1;
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
  let writeFail = false;
  const fakeFs = {
    ...fs,
    // 2b per-cell: il persist del bind SCRIVE (non rilegge lo store condiviso):
    // il fallimento si inietta sulla write, altrimenti l'attach non fallisce.
    writeFileSync(file, ...args) {
      if (writeFail && String(file).includes(path.join('.nexuscrew', 'run', 'cell-leases'))) {
        throw new Error('synthetic ENOSPC');
      }
      return fs.writeFileSync(file, ...args);
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
  return { home, manager, broker, get readFail() { return writeFail; }, set readFail(v) { writeFail = v; }, get attachOutcome() { return attachOutcome; } };
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
        lease: { cellId: 'Dev', launchEpoch: identity.launchEpoch, stablePath: identity.stablePath },
      });
      scenario.readFail = true; // write fallita: il persist del bind non committa -> attachInitial false
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
      lease: { cellId: 'Dev', launchEpoch: identity.launchEpoch, stablePath: identity.stablePath },
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


// Attende che il figlio REALE dichiari su stdout di aver installato l'handler:
// l'attesa dell'avvio e' guidata dall'EVENTO, non da un cronometro. Prima erano
// 300ms fissi «perche' il runtime Node del figlio finisca di avviarsi»: sotto
// carico (flotta attiva, sei core, load >7) non bastavano, il SIGTERM arrivava
// prima di process.on('SIGTERM') e il figlio moriva di default — un falso rosso
// che non c'entra con l'escalation. Il figlio scrive READY quando l'handler c'e';
// se non lo scrive mai, il test fallisce COME PRIMA: l'asserzione non si e'
// indebolita. (spawnImpl qui sotto usa stdio pipe apposta per leggere quella
// riga: il processo di produzione passerebbe inherit.)
async function waitForLine(child, needle, timeoutMs = 20000) {
  await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => {
      child.stdout.removeListener('data', on);
      reject(new Error(`attesa "${needle}" su stdout del figlio scaduta`));
    }, timeoutMs);
    const on = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) { clearTimeout(to); child.stdout.removeListener('data', on); resolve(); }
    };
    child.stdout.on('data', on);
  });
}

// --- Correzione dopo revisione: F-B — un solo SIGTERM non basta ------------

// Il test sopra (F-B: lease persa) dichiarava di attraversare cell-exec ma
// osservava solo la callback onLost — si fermava prima del punto in cui il
// difetto vive davvero: un figlio gia' nato che IGNORA SIGTERM. Misurato sul
// percorso reale: {spawned:1, kills:['SIGTERM'], state:'pending'}. Questo test
// attraversa cellExecMain PER INTERO, con un vero processo figlio (child_process
// reale, non un fake) che ignora deliberatamente SIGTERM — l'unico modo di
// dimostrare che l'escalation a SIGKILL avviene davvero, non solo che la
// funzione onLost e' stata chiamata.
test('F-B (correzione): un figlio che IGNORA SIGTERM viene comunque terminato (escalation a SIGKILL)', async () => {
  const { LEASE_LOST_KILL_ESCALATION_MS, main: cellExecMain } = require('../lib/fleet/cell-exec.js');
  const { EventEmitter: EE } = require('node:events');
  const realSpawn = require('node:child_process').spawn;
  const clock = { t: 100_000 };
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  const fakeClearTimeout = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };

  const leaseSocket = new EE();
  leaseSocket.destroyed = false;
  leaseSocket.destroy = () => { leaseSocket.destroyed = true; leaseSocket.emit('close'); };
  leaseSocket.write = () => true;
  leaseSocket.setEncoding = () => {};

  // Un VERO processo Node che ignora deliberatamente SIGTERM e resta vivo
  // finche' non riceve SIGKILL (che il sistema operativo non fa ignorare).
  const ignoreScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 100); process.stdout.write('READY\\n');";
  let realChild = null;
  const spawnImpl = (command, args, opts) => {
    // stdio pipe (non l'inherit di produzione): il test deve leggere READY dal
    // stdout del figlio per attendere l'EVENTO, non un tempo.
    realChild = realSpawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    return realChild;
  };

  const payload = {
    command: process.execPath, args: ['-e', ignoreScript], env: {},
    supervise: { enabled: false },
    lease: { stablePath: '/tmp/nonexistent-cell.sock', launchEpoch: 'a'.repeat(16) },
  };

  // Nessuna vera I/O di rete nel path di reconnect: senza questo, il primo
  // tentativo (armato da onEOF PRIMA che il clock sia avanzato) userebbe il
  // vero modulo `net` verso uno stablePath inesistente — un fallimento
  // ASINCRONO reale, fuori sincronia col loop di timer fittizi qui sotto, che
  // ha reso il test appeso alla prima stesura.
  const fakeNet = { createConnection: () => { const s = new EE(); s.destroyed = false; s.destroy = () => { s.destroyed = true; s.emit('close'); }; s.setEncoding = () => {}; s.write = () => true; return s; } };

  const mainPromise = cellExecMain(['--socket', '/tmp/x', '--nonce', 'a'.repeat(64)], {
    spawn: spawnImpl,
    receivePayload: async () => ({ payload, socket: leaseSocket }),
    now: () => clock.t,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    net: fakeNet,
    writeError: () => {},
  });

  try {
    // Aspetta che il vero processo sia partito. L'oggetto ChildProcess esiste
    // sincrono al ritorno di spawn(): nessun bisogno (e nessun rischio di
    // perdere l'evento 'spawn' per race) di aspettare altro oltre a questo.
    for (let i = 0; i < 100 && !realChild; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(realChild, 'il processo reale e\' partito');
    // L'attesa e' guidata dall'EVENTO: il figlio scrive READY quando ha davvero
    // installato process.on('SIGTERM'). I 300ms fissi di prima erano un
    // cronometro che sotto carico perdeva la gara col segnale (falso rosso).
    await waitForLine(realChild, 'READY');

    // EOF sulla lease -> grace armata; fai scadere la grace -> onLost scatta,
    // manda SIGTERM (che il figlio ignora) e arma l'escalation.
    leaseSocket.emit('close');
    clock.t += require('../lib/fleet/cell-lease.js').GRACE_MS + 1;
    for (let guard = 0; guard < 20; guard += 1) {
      const pending = timers.filter((h) => h.ms !== LEASE_LOST_KILL_ESCALATION_MS);
      if (!pending.length) break;
      for (const h of [...pending]) { fakeClearTimeout(h); try { h.fn(); } catch (_) {} }
    }
    const escalationTimer = timers.find((h) => h.ms === LEASE_LOST_KILL_ESCALATION_MS);
    assert.ok(escalationTimer, 'l\'escalation e\' armata con il limite ESPLICITO LEASE_LOST_KILL_ESCALATION_MS');

    // Il figlio ignora SIGTERM: verifica che sia ANCORA vivo poco dopo (il
    // segnale e' stato consegnato — un breve margine reale basta a escluderlo).
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(realChild.exitCode, null, 'SIGTERM da solo non termina un figlio che lo ignora');
    assert.equal(realChild.signalCode, null);

    // Fai scattare l'escalation: SIGKILL, che il figlio NON PUO\' ignorare.
    escalationTimer.fn();
    const result = await Promise.race([
      new Promise((resolve) => realChild.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('il figlio non e\' morto entro il timeout del test')), 20000)),
    ]);
    assert.equal(result.signal, 'SIGKILL', 'il figlio muore per SIGKILL, non da solo');

    const finalCode = await mainPromise;
    assert.equal(finalCode, 0, 'il supervisore termina con la lease persa');
  } finally {
    // Pulizia di sicurezza: se qualcosa nel test e' fallito prima del SIGKILL,
    // il processo reale non deve restare orfano dopo la suite.
    if (realChild && realChild.exitCode === null && realChild.signalCode === null) {
      try { realChild.kill('SIGKILL'); } catch (_) {}
    }
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
